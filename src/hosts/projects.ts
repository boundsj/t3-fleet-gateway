import type { ProjectConfig } from '../config.ts';
import { GatewayError } from '../errors.ts';
import type { HostRegistry } from './registry.ts';

/** Find the T3 project a configured project points at, by id or by exact title. */
export async function resolveProjectId(registry: HostRegistry, project: ProjectConfig): Promise<string> {
  const projects = await registry.client(project.host).listProjects();
  if (project.t3ProjectId !== undefined) {
    if (projects.some((candidate) => candidate.id === project.t3ProjectId)) return project.t3ProjectId;
    throw new GatewayError('not_found', `Project "${project.alias}": no T3 project with id ${project.t3ProjectId} on host ${project.host}`);
  }
  const matches = projects.filter((candidate) => candidate.title === project.t3ProjectTitle);
  if (matches.length === 1 && matches[0]) return matches[0].id;
  const problem = matches.length === 0 ? 'no T3 project titled' : 'several T3 projects titled';
  throw new GatewayError('not_found', `Project "${project.alias}": ${problem} "${project.t3ProjectTitle}" on host ${project.host}; set t3ProjectId instead`);
}
