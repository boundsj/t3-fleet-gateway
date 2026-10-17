import { configuredModel, type GatewayConfig, type HostConfig, type ProjectConfig } from '../config.ts';
import type { CatalogProject } from '../hosts/catalog.ts';
import type { ModelSource } from './launchSpec.ts';

/**
 * How one T3 project relates to the configured aliases of its host, from a catalog snapshot:
 * `aliases` resolve to exactly this project (by id, or by a title only this project has);
 * `ambiguousAliases` name a title that several projects, this one included, share.
 */
export interface ProjectMapping {
  project: CatalogProject;
  aliases: ProjectConfig[];
  ambiguousAliases: ProjectConfig[];
}

export function mapProjects(config: GatewayConfig, hostId: string, projects: readonly CatalogProject[]): Map<string, ProjectMapping> {
  const mappings = new Map<string, ProjectMapping>(projects.map((project) => [project.id, { project, aliases: [], ambiguousAliases: [] }]));
  for (const alias of config.projects.filter((candidate) => candidate.host === hostId)) {
    if (alias.t3ProjectId !== undefined) {
      mappings.get(alias.t3ProjectId)?.aliases.push(alias);
      continue;
    }
    const matches = projects.filter((project) => project.name === alias.t3ProjectTitle);
    if (matches.length === 1) mappings.get(matches[0]!.id)?.aliases.push(alias);
    else for (const match of matches) mappings.get(match.id)?.ambiguousAliases.push(alias);
  }
  return mappings;
}

/**
 * The policy that governs launches into a T3 project targeted by id. A project exactly one configured
 * alias resolves to is launched as that alias, with every setting of that alias (`allowWorkStart`
 * included): targeting by id never gets around a configured project's rules. Several matching aliases,
 * or an ambiguous title mapping, require the agent to name the alias. A project no alias maps to
 * follows the host's discovery policy.
 */
export type LaunchPolicy =
  | { kind: 'alias'; project: ProjectConfig }
  | { kind: 'ambiguous'; aliases: string[] }
  | { kind: 'discovered'; host: HostConfig };

export function launchPolicy(host: HostConfig, mapping: ProjectMapping): LaunchPolicy {
  if (mapping.aliases.length === 1 && mapping.ambiguousAliases.length === 0) return { kind: 'alias', project: mapping.aliases[0]! };
  if (mapping.aliases.length > 0 || mapping.ambiguousAliases.length > 0) {
    return { kind: 'ambiguous', aliases: [...mapping.aliases, ...mapping.ambiguousAliases].map((alias) => alias.alias).sort() };
  }
  return { kind: 'discovered', host };
}

/** The settings a launch into the project takes, as agents see them in fleet_projects. */
export interface EffectivePolicy {
  source: 'alias' | 'discovered' | 'ambiguous';
  alias: string | null;
  /** Every alias involved when the mapping is ambiguous. */
  aliases: string[];
  allowWorkStart: boolean;
  runtimeMode: string | null;
  workspaceMode: 'scratch' | 'auto' | null;
  baseRef: string | null;
  branchPrefix: string | null;
  /** Where a launch without an explicit selection gets its model. */
  defaultModelSource: ModelSource | null;
}

export function effectivePolicy(config: GatewayConfig, policy: LaunchPolicy, project: CatalogProject): EffectivePolicy {
  switch (policy.kind) {
    case 'alias': {
      const configured = configuredModel(config, policy.project);
      return {
        source: 'alias',
        alias: policy.project.alias,
        aliases: [policy.project.alias],
        allowWorkStart: policy.project.allowWorkStart,
        runtimeMode: policy.project.runtimeMode,
        workspaceMode: policy.project.workspaceMode === 'scratch' ? 'scratch' : 'auto',
        baseRef: policy.project.workspaceMode === 'scratch' ? null : 'main',
        branchPrefix: policy.project.workspaceMode === 'scratch' ? null : policy.project.branchPrefix,
        defaultModelSource: configured?.source ?? 't3_default',
      };
    }
    case 'ambiguous':
      return { source: 'ambiguous', alias: null, aliases: policy.aliases, allowWorkStart: false, runtimeMode: null, workspaceMode: null, baseRef: null, branchPrefix: null, defaultModelSource: null };
    case 'discovered': {
      const { discovery } = policy.host;
      return {
        source: 'discovered',
        alias: null,
        aliases: [],
        allowWorkStart: discovery.allowWorkStart,
        runtimeMode: discovery.runtimeMode,
        workspaceMode: 'auto',
        baseRef: 'main',
        branchPrefix: discovery.branchPrefix,
        defaultModelSource: policy.host.defaultModelSelection ? 'host' : project.hasDefaultModel ? 't3_default' : null,
      };
    }
  }
}

/** The internal project ref of a job launched into a T3 project no alias names: outside the alias syntax. */
export function projectRef(hostId: string, projectId: string): string {
  return `@${hostId}/${projectId}`;
}

export function parseProjectRef(value: string): { hostId: string; projectId: string } | undefined {
  const match = /^@([a-z0-9][a-z0-9-]{0,31})\/(.+)$/s.exec(value);
  return match ? { hostId: match[1] as string, projectId: match[2] as string } : undefined;
}
