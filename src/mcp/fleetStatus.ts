import * as z from 'zod';
import { configuredModel, RUNTIME_MODES, type GatewayConfig } from '../config.ts';
import type { Database } from '../db/database.ts';
import type { HostRegistry } from '../hosts/registry.ts';
import { jobCountsByHost } from '../jobs/counts.ts';
import type { JobService } from '../jobs/service.ts';
import { JOB_STATES } from '../jobs/states.ts';
import { permits, READ_SCOPE } from '../oauth/scopes.ts';
import { isoTime } from '../time.ts';
import { GATEWAY_NAME, GATEWAY_VERSION } from '../version.ts';
import { defineTool } from './tools.ts';

const errorSchema = z.object({ code: z.string(), message: z.string() });

const hostSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  defaultProject: z.string().nullable().describe('Configured scratch alias for work_start { target: { host } }; null when no machine default is configured'),
  reachable: z.boolean().nullable().describe('null when the gateway has no credential to ask with; true when T3 answered, even if it refused the credential'),
  t3Version: z.string().nullable(),
  checkedAt: z.string(),
  error: errorSchema.nullable(),
  credential: z.object({
    state: z
      .enum(['missing', 'active', 'renewal_due', 'expired', 'rejected'])
      .describe('rejected: T3 answered but refused the credential; the operator must re-enroll the host'),
    expiresAt: z.string().nullable(),
    daysLeft: z.number().int().nullable(),
    renewalError: errorSchema.extend({ at: z.string() }).nullable(),
  }),
  maxConcurrentJobs: z.number().int(),
  runningJobs: z.number().int(),
  queuedJobs: z.number().int(),
  discovery: z
    .object({
      enabled: z.boolean().describe('true: fleet_projects and fleet_models list this host\'s T3 projects, models and options'),
      allowWorkStart: z.boolean().describe('true: work_start may target a discovered T3 project here by id; false: only configured aliases accept work'),
    })
    .describe('Opt-in discovery of T3 projects and model capabilities on this host'),
});

const outputSchema = z.object({
  gateway: z.object({ name: z.string(), version: z.string() }),
  hosts: z.array(hostSchema),
  projects: z.array(
    z.object({
      alias: z.string(),
      description: z.string(),
      host: z.string(),
      workspaceMode: z.enum(['scratch', 'auto']).describe('scratch uses T3 internal scratch; auto detects a Git project root for a fresh wt from origin/main, otherwise uses root'),
      runtimeMode: z
        .enum(RUNTIME_MODES)
        .describe(
          'How much the worker may do without asking. approval-required (the default): every command or edit that needs approval waits ' +
            'for the operator to approve it in T3, so the job sits in needs_input until then. auto or full-access: jobs run unattended.',
        ),
      modelConfigured: z
        .boolean()
        .describe(
          "true when the gateway config sets the model for this project's jobs. false: T3 uses the project's own default model, " +
            'and refuses to launch (the job fails with invalid_request) if it has none; the operator fixes that in the gateway config.',
        ),
      allowWorkStart: z
        .boolean()
        .describe('false: work_start is refused here (start_disabled); give the work to a standing job below with work_continue'),
      standingJobs: z
        .array(
          z.object({
            jobId: z.string(),
            title: z.string(),
            state: z.enum(JOB_STATES),
            link: z.string().nullable().describe('Opens the thread in the T3 app'),
          }),
        )
        .describe(
          "Long-lived threads the operator registered in this project, such as a coordinator. Send them work with work_continue " +
            '(jobId) and follow them with work_feed and work_status',
        ),
    }),
  ),
});

type HostStatus = z.infer<typeof hostSchema>;

function describeHost(host: HostStatus): string {
  const reach =
    host.reachable === null ? 'not enrolled' : !host.reachable ? 'unreachable' : host.t3Version === null ? 'reachable' : `reachable, T3 ${host.t3Version}`;
  const credential =
    host.credential.state === 'missing'
      ? 'no credential'
      : host.credential.state === 'expired'
        ? 'credential expired'
        : host.credential.state === 'rejected'
          ? `credential rejected by T3 (the operator must run: t3-fleet-gateway hosts enroll ${host.id})`
          : `credential expires in ${host.credential.daysLeft} ${host.credential.daysLeft === 1 ? 'day' : 'days'}`;
  const renewal = host.credential.renewalError ? `, last renewal failed (${host.credential.renewalError.code})` : '';
  const scratch = host.defaultProject === null ? '' : host.discovery.enabled
    ? `; no named project: work_start { target: { host: ${JSON.stringify(host.id)} } } uses scratch alias ${host.defaultProject}`
    : `; scratch alias ${host.defaultProject} (host-only starts need discovery enabled)`;
  const discovery = host.discovery.enabled
    ? `; discovery on (fleet_projects, fleet_models${host.discovery.allowWorkStart ? '; work_start accepts target' : '; launches need a configured alias'})`
    : '';
  return `${host.id}: ${reach}; ${credential}${renewal}; ${host.runningJobs} running, ${host.queuedJobs} queued (max ${host.maxConcurrentJobs})${discovery}${scratch}`;
}

export function fleetStatusTool(deps: { config: GatewayConfig; registry: HostRegistry; db: Database; jobs: JobService }) {
  return defineTool({
    name: 'fleet_status',
    title: 'Fleet status',
    description:
      'Show the machines (hosts) this gateway can run work on and the projects you can target. ' +
      'When the user names no project, use work_start with target { host } for the machine’s default scratch alias. ' +
      'For a named project, resolve its alias or id; never fall back to scratch for an unknown project. ' +
      'For each host: whether its T3 Code server is reachable, its T3 version, when the gateway credential for it expires, ' +
      'and how many jobs are running or queued against its concurrency limit. For each project: the alias to use when ' +
      'starting work, a description, the host it runs on, its runtime mode and whether a model is configured. A project ' +
      'whose runtimeMode is approval-required is not unattended: its jobs wait in needs_input until the operator approves in ' +
      'T3, which you cannot do for them; auto and full-access projects run unattended. A project may also list standingJobs: ' +
      'long-lived T3 threads the operator registered there, such as a coordinator ("chief of staff") that plans and delegates ' +
      'the work itself. For such a project, talk to the coordinator: send it instructions with work_continue on its jobId and ' +
      'follow its replies with work_feed and work_status, rather than starting jobs. When allowWorkStart is false, work_start ' +
      'is refused there and the standing jobs are the way in. If the operator approved you for selected machines only, you ' +
      'see just those hosts and their projects, and every work tool works only with jobs on them. A host with discovery.enabled ' +
      'true also has T3 projects beyond these aliases and a model catalog: fleet_projects and fleet_models list them. Use this first ' +
      'to learn the project aliases and where to send work, or to check why work is not progressing. Read-only; safe to call any time.',
    scope: READ_SCOPE,
    readOnly: true,
    inputSchema: z.object({}),
    outputSchema,
    async run(_input, context) {
      // Only the hosts this agent's grant lets it read are listed, counted and checked; their projects and standing jobs likewise.
      const visible = (hostId: string) => permits(context.scopes, 'read', hostId);
      const counts = jobCountsByHost(deps.db);
      const hosts = await Promise.all(
        deps.config.hosts.filter((host) => visible(host.id)).map(async (host): Promise<HostStatus> => {
          const [health, credential] = [await deps.registry.health(host.id), deps.registry.credentialStatus(host.id)];
          const jobs = counts.get(host.id) ?? { running: 0, queued: 0 };
          return {
            id: host.id,
            label: host.label ?? null,
            defaultProject: host.defaultProject ?? null,
            reachable: health.reachable,
            t3Version: health.t3Version,
            checkedAt: isoTime(health.checkedAt),
            error: health.error,
            credential: {
              state: health.credentialRejected ? 'rejected' : credential.state,
              expiresAt: credential.expiresAt === null ? null : isoTime(credential.expiresAt),
              daysLeft: credential.daysLeft,
              renewalError: credential.renewalError && { ...credential.renewalError, at: isoTime(credential.renewalError.at) },
            },
            maxConcurrentJobs: host.maxConcurrentJobs,
            runningJobs: jobs.running,
            queuedJobs: jobs.queued,
            discovery: { enabled: host.discovery.enabled, allowWorkStart: host.discovery.allowWorkStart },
          };
        }),
      );
      const standing = deps.jobs.store.standingJobs().filter((job) => visible(job.hostId));
      const projects = deps.config.projects.filter((project) => visible(project.host)).map((project) => ({
        alias: project.alias,
        description: project.description,
        host: project.host,
        workspaceMode: project.workspaceMode === 'scratch' ? 'scratch' as const : 'auto' as const,
        runtimeMode: project.runtimeMode,
        modelConfigured: configuredModel(deps.config, project) !== null,
        allowWorkStart: project.allowWorkStart,
        standingJobs: standing
          .filter((job) => job.projectAlias === project.alias)
          .map((job) => ({ jobId: job.id, title: job.title, state: job.state, link: job.threadLink })),
      }));
      const summary = [
        `${GATEWAY_NAME} ${GATEWAY_VERSION}: ${hosts.length} host(s), ${projects.length} project(s).`,
        ...hosts.map(describeHost),
        ...projects.flatMap((project) => [
          `project ${project.alias} on ${project.host} (${project.runtimeMode}${project.workspaceMode === 'scratch' ? ', T3 internal scratch' : ''}${project.modelConfigured ? '' : ", T3's default model"}` +
            `${project.allowWorkStart ? '' : ', work_start disabled'})${project.description ? `: ${project.description}` : ''}`,
          ...project.standingJobs.map(
            (job) => `  standing job ${job.jobId} [${job.state}] ${job.title}: send it work with work_continue${job.link ? `; open: ${job.link}` : ''}`,
          ),
        ]),
      ].join('\n');
      return { structured: { gateway: { name: GATEWAY_NAME, version: GATEWAY_VERSION }, hosts, projects }, summary };
    },
  });
}
