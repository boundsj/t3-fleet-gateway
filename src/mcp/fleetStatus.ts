import * as z from 'zod';
import type { GatewayConfig } from '../config.ts';
import type { Database } from '../db/database.ts';
import type { HostRegistry } from '../hosts/registry.ts';
import { jobCountsByHost } from '../jobs/counts.ts';
import { READ_SCOPE } from '../oauth/scopes.ts';
import { isoTime } from '../time.ts';
import { GATEWAY_NAME, GATEWAY_VERSION } from '../version.ts';
import { defineTool } from './tools.ts';

const errorSchema = z.object({ code: z.string(), message: z.string() });

const hostSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  reachable: z.boolean().nullable().describe('null when the gateway has no credential to ask with'),
  t3Version: z.string().nullable(),
  checkedAt: z.string(),
  error: errorSchema.nullable(),
  credential: z.object({
    state: z.enum(['missing', 'active', 'renewal_due', 'expired']),
    expiresAt: z.string().nullable(),
    daysLeft: z.number().int().nullable(),
    renewalError: errorSchema.extend({ at: z.string() }).nullable(),
  }),
  maxConcurrentJobs: z.number().int(),
  runningJobs: z.number().int(),
  queuedJobs: z.number().int(),
});

const outputSchema = z.object({
  gateway: z.object({ name: z.string(), version: z.string() }),
  hosts: z.array(hostSchema),
  projects: z.array(z.object({ alias: z.string(), description: z.string(), host: z.string() })),
});

type HostStatus = z.infer<typeof hostSchema>;

function describeHost(host: HostStatus): string {
  const reach = host.reachable === true ? `reachable, T3 ${host.t3Version}` : host.reachable === false ? 'unreachable' : 'not enrolled';
  const credential =
    host.credential.state === 'missing'
      ? 'no credential'
      : host.credential.state === 'expired'
        ? 'credential expired'
        : `credential expires in ${host.credential.daysLeft} ${host.credential.daysLeft === 1 ? 'day' : 'days'}`;
  const renewal = host.credential.renewalError ? `, last renewal failed (${host.credential.renewalError.code})` : '';
  return `${host.id}: ${reach}; ${credential}${renewal}; ${host.runningJobs} running, ${host.queuedJobs} queued (max ${host.maxConcurrentJobs})`;
}

export function fleetStatusTool(deps: { config: GatewayConfig; registry: HostRegistry; db: Database }) {
  return defineTool({
    name: 'fleet_status',
    title: 'Fleet status',
    description:
      'Show the machines (hosts) this gateway can run coding work on and the projects you can target. ' +
      'For each host: whether its T3 Code server is reachable, its T3 version, when the gateway credential for it expires, ' +
      'and how many jobs are running or queued against its concurrency limit. For each project: the alias to use when ' +
      'starting work, a description, and the host it runs on. Use this first to learn the project aliases, or to check ' +
      'why work is not progressing. Read-only; safe to call any time.',
    scope: READ_SCOPE,
    readOnly: true,
    inputSchema: z.object({}),
    outputSchema,
    async run() {
      const counts = jobCountsByHost(deps.db);
      const hosts = await Promise.all(
        deps.config.hosts.map(async (host): Promise<HostStatus> => {
          const [health, credential] = [await deps.registry.health(host.id), deps.registry.credentialStatus(host.id)];
          const jobs = counts.get(host.id) ?? { running: 0, queued: 0 };
          return {
            id: host.id,
            label: host.label ?? null,
            reachable: health.reachable,
            t3Version: health.t3Version,
            checkedAt: isoTime(health.checkedAt),
            error: health.error,
            credential: {
              state: credential.state,
              expiresAt: credential.expiresAt === null ? null : isoTime(credential.expiresAt),
              daysLeft: credential.daysLeft,
              renewalError: credential.renewalError && { ...credential.renewalError, at: isoTime(credential.renewalError.at) },
            },
            maxConcurrentJobs: host.maxConcurrentJobs,
            runningJobs: jobs.running,
            queuedJobs: jobs.queued,
          };
        }),
      );
      const projects = deps.config.projects.map((project) => ({ alias: project.alias, description: project.description, host: project.host }));
      const summary = [
        `${GATEWAY_NAME} ${GATEWAY_VERSION}: ${hosts.length} host(s), ${projects.length} project(s).`,
        ...hosts.map(describeHost),
        ...projects.map((project) => `project ${project.alias} on ${project.host}${project.description ? `: ${project.description}` : ''}`),
      ].join('\n');
      return { structured: { gateway: { name: GATEWAY_NAME, version: GATEWAY_VERSION }, hosts, projects }, summary };
    },
  });
}
