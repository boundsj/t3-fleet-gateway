import { configuredModel, type GatewayConfig, type ProjectConfig } from '../config.ts';
import { describeError, GatewayError } from '../errors.ts';
import type { Logger } from '../log.ts';
import type { T3Project } from '../t3/schemas.ts';
import type { HostRegistry } from './registry.ts';

/** Find the T3 project a configured project points at, by id or by exact title. */
export async function resolveProject(registry: HostRegistry, project: ProjectConfig): Promise<T3Project> {
  const projects = await registry.client(project.host).listProjects();
  if (project.t3ProjectId !== undefined) {
    const found = projects.find((candidate) => candidate.id === project.t3ProjectId);
    if (found) return found;
    throw new GatewayError('not_found', `Project "${project.alias}": no T3 project with id ${project.t3ProjectId} on host ${project.host}`);
  }
  const matches = projects.filter((candidate) => candidate.title === project.t3ProjectTitle);
  if (matches.length === 1 && matches[0]) return matches[0];
  const problem = matches.length === 0 ? 'no T3 project titled' : 'several T3 projects titled';
  throw new GatewayError('not_found', `Project "${project.alias}": ${problem} "${project.t3ProjectTitle}" on host ${project.host}; set t3ProjectId instead`);
}

export async function resolveProjectId(registry: HostRegistry, project: ProjectConfig): Promise<string> {
  return (await resolveProject(registry, project)).id;
}

/**
 * Where launches in a project get their model: the gateway config (the project's `modelSelection`,
 * else its host's `defaultModelSelection`), else the T3 project's own default. `ok` is false when
 * there is none, which makes T3 refuse every launch with `invalid_request`.
 */
export function checkProjectModel(config: GatewayConfig, project: ProjectConfig, t3Project: T3Project): { ok: boolean; detail: string } {
  const configured = configuredModel(config, project);
  if (configured?.source === 'project') return { ok: true, detail: 'model from the project modelSelection' };
  if (configured?.source === 'host') return { ok: true, detail: `model from host ${project.host} defaultModelSelection` };
  if (t3Project.defaultModelSelection !== undefined && t3Project.defaultModelSelection !== null) {
    return { ok: true, detail: `model from the default of T3 project ${t3Project.id}` };
  }
  return {
    ok: false,
    detail:
      `no model: T3 project ${t3Project.id} has no default model and the config sets none, so T3 refuses every launch (invalid_request). ` +
      `Set projects[].modelSelection or hosts[].defaultModelSelection for host ${project.host}, ` +
      'for example { "instanceId": "<provider instance>", "model": "<model id>" } (T3 lists both in orchestrator_capabilities), ' +
      'or give the project a default model in T3.',
  };
}

/**
 * At startup, warn about projects whose launches T3 would refuse for want of a model. Never throws.
 * A host whose project list cannot be read is skipped for its remaining projects, and the check
 * stops when `signal` aborts (shutdown does not wait for it).
 */
export async function warnProjectsWithoutModel(
  config: GatewayConfig,
  registry: HostRegistry,
  logger: Logger,
  signal?: AbortSignal,
): Promise<void> {
  const failedHosts = new Set<string>();
  for (const project of config.projects) {
    if (signal?.aborted) return;
    if (failedHosts.has(project.host) || configuredModel(config, project)) continue;
    if (registry.credentialStatus(project.host).state === 'missing') continue;
    try {
      const t3Project = await resolveProject(registry, project);
      if (signal?.aborted) return;
      if (!checkProjectModel(config, project, t3Project).ok) {
        logger.warn('project.model_missing', { project: project.alias, hostId: project.host, fix: 'set modelSelection or the host defaultModelSelection; see doctor' });
      }
    } catch (error) {
      if (signal?.aborted) return;
      // not_found concerns this project only; any other failure is reading the host's project list,
      // which every other project on the host would repeat.
      if (!(error instanceof GatewayError && error.code === 'not_found')) failedHosts.add(project.host);
      logger.debug('project.model_check_failed', { project: project.alias, hostId: project.host, errorCode: describeError(error).code });
    }
  }
}
