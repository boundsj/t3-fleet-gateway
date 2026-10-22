import { configuredModel, isLoopbackHostname, mcpResource, type GatewayConfig, type HostConfig } from '../config.ts';
import { SCHEMA_VERSION, schemaVersion, type Database } from '../db/database.ts';
import { isCallSignal, SIGNAL_LABELS, type HostSignal } from '../hosts/signals.ts';
import type { HostRegistry } from '../hosts/registry.ts';
import type { EngineStatus } from '../jobs/engine.ts';
import { displayPullRequests } from '../jobs/pullRequests.ts';
import { JOB_STATES, OPEN_STATES, RUNNING_STATES, TERMINAL_STATES, type JobState } from '../jobs/states.ts';
import { OPERATOR_CLIENT_ID, type Job, type JobStore } from '../jobs/store.ts';
import { ClientStore, isTokenClient, type ClientSummary } from '../oauth/clients.ts';
import { diagnoseClient, type ClientDiagnostic } from '../oauth/diagnostics.ts';
import { describeAccess, parseHostScope, parseScope, permittedHosts } from '../oauth/scopes.ts';
import { NEVER_EXPIRES } from '../oauth/tokens.ts';
import { DAY, type Clock } from '../time.ts';
import { GATEWAY_NAME, GATEWAY_VERSION } from '../version.ts';
import type { CheckRun } from './checks.ts';
import { describeEvent, explainHostError, explainJobError, explainRenewalError, explainRevocation, safeCode } from './explain.ts';

/**
 * The operator dashboard's view of the gateway, built from the database and what this process holds in memory only.
 * Building it never contacts T3 or any other service: host reachability is the last completed check with its time.
 * Every list is bounded, every error is a code plus fixed text, and no secret, hash, task text, worker message,
 * question, delegated task title, catalog or command argv is included (test/dashboard.test.ts).
 */

export const LIMITS = {
  clients: 100,
  pendingClients: 10,
  revokedFamilies: 5,
  openJobs: 100,
  recentJobs: 25,
  jobAttention: 50,
  events: 60,
  attention: 40,
} as const;

/** Clients whose last successful MCP request is this recent count as seen. Older is shown as quiet, never as broken. */
export const SEEN_RECENTLY_MS = DAY;
/** Bearer tokens expiring sooner than this are flagged. */
const TOKEN_EXPIRY_WARNING_MS = 14 * DAY;
/** Grant families revoked for replay this recently are flagged. */
const REPLAY_WARNING_MS = 7 * DAY;
const TITLE_CHARS = 120;

export type Tone = 'good' | 'warn' | 'bad' | 'unknown' | 'info';
type Time = string | null;

export interface DashboardSources {
  config: GatewayConfig;
  db: Database;
  clock: Clock;
  registry: HostRegistry;
  store: JobStore;
  engine: { status(): EngineStatus };
  startedAt: number;
  /** The listener the MCP endpoint is on, as `host:port`. */
  mcpListen: string;
  lastChecks: () => CheckRun | null;
  /** Shown as a badge: set by the synthetic demo only. */
  demoLabel?: string | null;
}

const iso = (ms: number | null | undefined): Time => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

function clip(text: string, max = TITLE_CHARS): string {
  const clean = text.replaceAll(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** T3 thread ids are opaque; the link is built only from ids made of safe characters, in T3's documented form. */
export function threadLink(threadId: string | null): string | null {
  return threadId !== null && /^[A-Za-z0-9._:-]{1,200}$/.test(threadId) ? `t3-thread://v1/${threadId}` : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Hosts

export interface HostView {
  id: string;
  label: string;
  transportNote: string | null;
  signals: (HostSignal & { stale: boolean })[];
  t3Url: string;
  loopback: boolean;
  status: { tone: Tone; label: string };
  reachability: {
    state: 'reachable' | 'credential_rejected' | 'unreachable' | 'not_enrolled' | 'unchecked';
    checkedAt: Time;
    t3Version: string | null;
    errorCode: string | null;
    detail: string;
  };
  /** Set while the job engine is backing off this host; only hosts with open jobs are contacted by the engine. */
  engine: { unreachableSince: Time; nextAttemptAt: Time; failures: number; errorCode: string | null } | null;
  /** Earliest `hostUnreachableSince` recorded on the host's open jobs (persisted; what agents see in work_status). */
  jobsUnreachableSince: Time;
  credential: {
    state: 'missing' | 'active' | 'renewal_due' | 'expired';
    expiresAt: Time;
    daysLeft: number | null;
    renewalError: { code: string | null; at: Time; detail: string } | null;
  };
  access: string;
  capacity: { max: number; used: number; queued: number; open: number; standingOpen: number };
  discovery: { enabled: boolean; allowWorkStart: boolean; runtimeMode: string };
  projects: {
    alias: string;
    description: string;
    runtimeMode: string;
    allowWorkStart: boolean;
    modelConfigured: boolean;
    openJobs: number;
    standingJobs: number;
  }[];
  /** Open jobs in T3 projects with no alias (discovery launches). */
  discoveredOpenJobs: number;
}

function hostView(sources: DashboardSources, host: HostConfig, counts: Map<string, number>, engine: EngineStatus): HostView {
  const { registry, db, config } = sources;
  const health = registry.lastHealth(host.id);
  const credential = registry.credentialStatus(host.id);
  let reachability: HostView['reachability'];
  if (credential.state === 'missing') {
    reachability = { state: 'not_enrolled', checkedAt: iso(health?.checkedAt), t3Version: null, errorCode: 'host_not_enrolled', detail: explainHostError('host_not_enrolled') };
  } else if (!health) {
    reachability = { state: 'unchecked', checkedAt: null, t3Version: null, errorCode: null, detail: 'Not checked since the gateway started. Run checks to ask T3 now.' };
  } else if (health.credentialRejected) {
    reachability = { state: 'credential_rejected', checkedAt: iso(health.checkedAt), t3Version: null, errorCode: 't3_unauthorized', detail: explainHostError('t3_unauthorized') };
  } else if (health.reachable === true) {
    reachability = {
      state: 'reachable', checkedAt: iso(health.checkedAt), t3Version: safeVersion(health.t3Version), errorCode: null,
      detail: 'T3 answered an authenticated read (t3_environment_read) with the stored credential.',
    };
  } else {
    const code = safeCode(health.error?.code ?? null);
    reachability = { state: health.reachable === null ? 'not_enrolled' : 'unreachable', checkedAt: iso(health.checkedAt), t3Version: null, errorCode: code, detail: explainHostError(code) };
  }
  const backoff = engine.hosts.find((entry) => entry.hostId === host.id);
  const unreachable = db
    .prepare(`SELECT MIN(host_unreachable_since) AS since FROM jobs WHERE host_id = ? AND state NOT IN (${TERMINAL_STATES.map(() => '?').join(', ')})`)
    .get(host.id, ...TERMINAL_STATES) as { since: number | null };
  const count = (states: readonly JobState[], standing?: boolean) =>
    states.reduce((sum, state) => sum + (standing === undefined
      ? (counts.get(key(host.id, state, false)) ?? 0) + (counts.get(key(host.id, state, true)) ?? 0)
      : counts.get(key(host.id, state, standing)) ?? 0), 0);
  const projects = config.projects.filter((project) => project.host === host.id);
  const perProject = new Map(
    (db.prepare(`SELECT project_alias, standing, COUNT(*) AS n FROM jobs WHERE host_id = ? AND state NOT IN (${TERMINAL_STATES.map(() => '?').join(', ')})
      GROUP BY project_alias, standing`).all(host.id, ...TERMINAL_STATES) as { project_alias: string; standing: number; n: number }[])
      .map((row) => [`${row.project_alias}\u0000${row.standing}`, row.n]),
  );
  const discoveredOpenJobs = [...perProject].filter(([name]) => name.startsWith('@')).reduce((sum, [, n]) => sum + n, 0);
  const renewalCode = credential.renewalError ? safeCode(credential.renewalError.code) : null;
  const view: HostView = {
    id: host.id,
    signals: registry.signals(host.id).snapshot().map((signal) => ({
      ...signal, stale: signal.problem !== null && sources.clock() - signal.problem.lastSeen > DAY,
    })),
    label: clip(host.label ?? host.id, 80),
    transportNote: host.transportNote ? clip(host.transportNote, 80) : null,
    t3Url: host.t3Url,
    loopback: isLoopbackHostname(new URL(host.t3Url).hostname),
    status: { tone: 'unknown', label: '' },
    reachability,
    engine: backoff
      ? { unreachableSince: iso(backoff.unreachableSince), nextAttemptAt: iso(backoff.nextAttemptAt), failures: backoff.failures, errorCode: safeCode(backoff.errorCode) }
      : null,
    jobsUnreachableSince: iso(unreachable.since),
    credential: {
      state: credential.state,
      expiresAt: iso(credential.expiresAt),
      daysLeft: credential.daysLeft,
      renewalError: credential.renewalError
        ? { code: renewalCode, at: iso(credential.renewalError.at), detail: explainRenewalError(renewalCode) }
        : null,
    },
    access: host.access,
    capacity: {
      max: host.maxConcurrentJobs,
      used: count(RUNNING_STATES, false),
      queued: count(['queued']),
      open: count(OPEN_STATES),
      standingOpen: count(OPEN_STATES, true),
    },
    discovery: { enabled: host.discovery.enabled, allowWorkStart: host.discovery.allowWorkStart, runtimeMode: host.discovery.runtimeMode },
    projects: projects.map((project) => ({
      alias: project.alias,
      description: clip(project.description, 500),
      runtimeMode: project.runtimeMode,
      allowWorkStart: project.allowWorkStart,
      modelConfigured: configuredModel(config, project) !== null,
      openJobs: (perProject.get(`${project.alias}\u00000`) ?? 0) + (perProject.get(`${project.alias}\u00001`) ?? 0),
      standingJobs: perProject.get(`${project.alias}\u00001`) ?? 0,
    })),
    discoveredOpenJobs,
  };
  view.status = hostStatus(view);
  return view;
}

function safeVersion(version: string | null): string | null {
  return version !== null && /^[A-Za-z0-9.+_-]{1,40}$/.test(version) ? version : null;
}

const key = (hostId: string, state: string, standing: boolean) => `${hostId}\u0000${state}\u0000${standing ? 1 : 0}`;

function hostStatus(host: HostView): { tone: Tone; label: string } {
  if (host.reachability.state === 'credential_rejected') return { tone: 'bad', label: 'Credential rejected' };
  if (host.reachability.state === 'not_enrolled') return { tone: 'warn', label: 'Not enrolled' };
  if (host.credential.state === 'expired') return { tone: 'bad', label: 'Credential expired' };
  if (host.reachability.state === 'unreachable' || host.engine) return { tone: 'bad', label: 'Unreachable' };
  if (host.signals.some((signal) => signal.problem && !signal.stale)) return { tone: 'bad', label: 'Host problems' };
  if (host.reachability.state === 'unchecked') return { tone: 'unknown', label: 'Not checked' };
  if (host.credential.state === 'renewal_due' || host.credential.renewalError) return { tone: 'warn', label: 'Answering · renewal due' };
  return { tone: 'good', label: 'Answering' };
}

// ---------------------------------------------------------------------------------------------------------------
// Clients

export interface ClientView {
  id: string;
  /** The operator's display name (dashboard.clientLabels), else the registered name. */
  label: string;
  /** The name the client registered with (OAuth) or was minted with (bearer); untrusted text. */
  registeredName: string;
  kind: 'oauth' | 'bearer';
  redirectOrigins: string[];
  /**
   * What its tokens the gateway would accept now carry (usable access tokens, usable or grace-retry refresh tokens): a
   * narrowed refresh or an expired privileged sibling never counts. `approved` is the approval's own ceiling, when wider.
   */
  access: { text: string; operate: 'all' | string[]; read: 'all' | string[]; unconfiguredHosts: string[]; approved: string | null };
  grant: {
    state: ClientDiagnostic['state'];
    usableAccess: boolean;
    usableRefresh: boolean;
    /** Latest expiry among usable access tokens; 'never' for a bearer token minted with --ttl never. */
    accessUsableUntil: Time | 'never';
    refreshUsableUntil: Time;
    families: number;
    revokedFamilies: { at: Time; reason: string | null; detail: string }[];
  };
  observed: { lastMcpSuccessAt: Time; lastRefreshSuccessAt: Time; lastUsedAt: Time };
  createdAt: Time;
  revokedAt: Time;
  status: { tone: Tone; label: string; detail: string };
}

function latest(groups: { state: string; latestExpiresAt: number }[], states: readonly string[]): number | null {
  const values = groups.filter((group) => states.includes(group.state)).map((group) => group.latestExpiresAt);
  return values.length === 0 ? null : Math.max(...values);
}

function clientView(sources: DashboardSources, summary: ClientSummary, now: number): ClientView | null {
  const diagnostic = diagnoseClient(sources.db, sources.clock, mcpResource(sources.config), summary.id);
  if (!diagnostic) return null;
  const families = diagnostic.families;
  const accessUntil = latest(families.flatMap((family) => family.access), ['usable']);
  const refreshUntil = latest(families.flatMap((family) => family.refresh), ['usable', 'grace_retry']);
  const scopes = [...new Set(families.flatMap((family) => family.currentScopes.flatMap((scope) => parseScope(scope) ?? [])))];
  const approved = describeAccess([...new Set(families.filter((family) => family.revokedAt === null).flatMap((family) => parseScope(family.scope) ?? []))]);
  const hostIds = new Set(sources.config.hosts.map((host) => host.id));
  const label = sources.config.dashboard.clientLabels[summary.id];
  const view: ClientView = {
    id: summary.id,
    label: clip(label ?? summary.name, 80),
    registeredName: clip(summary.name, 80),
    kind: diagnostic.kind,
    redirectOrigins: [...new Set(summary.redirectUris.flatMap((uri) => {
      try {
        return [new URL(uri).origin];
      } catch {
        return [];
      }
    }))].slice(0, 5),
    access: {
      text: describeAccess(scopes),
      operate: permittedHosts(scopes, 'operate'),
      read: permittedHosts(scopes, 'read'),
      unconfiguredHosts: [...new Set(scopes.map(parseHostScope).flatMap((scope) => (scope && !hostIds.has(scope.hostId) ? [scope.hostId] : [])))],
      approved: approved === describeAccess(scopes) ? null : approved,
    },
    grant: {
      state: diagnostic.state,
      usableAccess: diagnostic.usableAccess,
      usableRefresh: diagnostic.usableRefresh,
      accessUsableUntil: accessUntil === NEVER_EXPIRES ? 'never' : iso(accessUntil),
      refreshUsableUntil: iso(refreshUntil),
      families: families.length,
      revokedFamilies: families
        .filter((family) => family.revokedAt !== null)
        .sort((a, b) => (b.revokedAt ?? 0) - (a.revokedAt ?? 0))
        .slice(0, LIMITS.revokedFamilies)
        .map((family) => {
          const reason = safeCode(family.revocationReason);
          return { at: iso(family.revokedAt), reason, detail: explainRevocation(reason) };
        }),
    },
    observed: {
      lastMcpSuccessAt: iso(diagnostic.lastMcpSuccessAt),
      lastRefreshSuccessAt: iso(diagnostic.lastRefreshSuccessAt),
      lastUsedAt: iso(summary.lastUsedAt),
    },
    createdAt: iso(summary.createdAt),
    revokedAt: iso(summary.revokedAt),
    status: { tone: 'unknown', label: '', detail: '' },
  };
  view.status = clientStatus(view, diagnostic, now);
  return view;
}

function clientStatus(client: ClientView, diagnostic: ClientDiagnostic, now: number): ClientView['status'] {
  if (diagnostic.state === 'revoked') return { tone: 'unknown', label: 'Revoked', detail: 'Revoked by the operator; none of its tokens work.' };
  if (diagnostic.state === 'unusable') {
    return client.kind === 'bearer'
      ? { tone: 'bad', label: 'Token unusable', detail: 'Its bearer token has expired or was revoked. Mint a new one with clients token and replace it in the connector.' }
      : { tone: 'bad', label: 'Needs new approval', detail: 'No usable access or refresh grant remains. The connector must sign in and be approved again.' };
  }
  const seen = diagnostic.lastMcpSuccessAt;
  if (seen === null) {
    return { tone: 'unknown', label: 'Never observed', detail: 'Its grant is usable, but no successful MCP request has been recorded. That does not prove the connector is disconnected, or that it still has its token.' };
  }
  if (now - seen <= SEEN_RECENTLY_MS) {
    return { tone: 'good', label: 'Seen recently', detail: 'A request with its token completed recently. Its routine and future retries are not confirmed by this.' };
  }
  return { tone: 'info', label: 'Quiet', detail: 'Its grant is usable; its last successful request was more than a day ago. Quiet is normal for agents that call rarely.' };
}

/** One POSIX shell word: single-quoted unless plainly safe, so quotes, `$`, backticks and backslashes stay literal. */
export function shellWord(text: string): string {
  return /^[A-Za-z0-9._:/@-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * The `clients token` command that mints a bearer token with this one's current access, never more (its defaults are
 * operate on every host, including later ones), or null when no single --access and --hosts says exactly that.
 * Host ids no longer configured are left out: they grant nothing, and clients token refuses them.
 */
function replacementCommand(client: ClientView): string | null {
  const { operate, read, unconfiguredHosts } = client.access;
  const level = operate === 'all' || operate.length > 0 ? 'operate' : 'read';
  const selected = level === 'operate' ? operate : read;
  // clients token grants read with operate, on the same hosts.
  const same = (a: 'all' | string[], b: 'all' | string[]) => (a === 'all' || b === 'all' ? a === b : [...a].sort().join(',') === [...b].sort().join(','));
  if (level === 'operate' && !same(operate, read)) return null;
  const hosts = selected === 'all' ? 'all' : selected.filter((id) => !unconfiguredHosts.includes(id)).sort().join(',');
  if (hosts === '') return null;
  return `t3-fleet-gateway clients token --name=${shellWord(client.registeredName)} --access ${level} --hosts ${shellWord(hosts)}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Jobs and events

export interface JobView {
  settlementAcknowledged: boolean;
  /** At most MAX_PULL_REQUESTS of the PRs the job follows (`displayPullRequests`): number and state only. */
  pullRequests: { number: number; state: string | null }[] | null;
  id: string;
  title: string;
  project: string;
  /** The T3 project's name for a discovered-project job (from its launch spec), else null. */
  projectName: string | null;
  hostId: string;
  state: JobState;
  standing: boolean;
  startedBy: { clientId: string | null; label: string };
  runtimeMode: string;
  createdAt: Time;
  stateChangedAt: Time;
  updatedAt: Time;
  finishedAt: Time;
  waitingFor: 'approval' | 'question' | null;
  pendingQuestions: number;
  delegated: { following: number; untracked: number; endedAt: Time };
  hostUnreachableSince: Time;
  error: { code: string; detail: string | null } | null;
  link: string | null;
}

function jobView(job: Job, clientLabels: Map<string, string>, settlementAcknowledged: boolean): JobView {
  const errorCode = safeCode(job.lastErrorCode);
  const isOperator = job.clientId === OPERATOR_CLIENT_ID;
  return {
    settlementAcknowledged,
    id: job.id,
    pullRequests: job.pullRequests === null ? null : displayPullRequests(job.pullRequests).map(({ number, state }) => ({ number, state })),
    // Launched jobs' titles end with their thread marker; the id is shown on its own.
    title: clip(job.title.replace(/\s*\[job:[^\]]*\]\s*$/i, '') || job.title),
    project: job.projectAlias,
    projectName: job.launchSpec?.source === 'discovered' && job.launchSpec.projectName !== null ? clip(job.launchSpec.projectName, 80) : null,
    hostId: job.hostId,
    state: job.state,
    standing: job.standing,
    startedBy: isOperator ? { clientId: null, label: 'Operator (standing job)' } : { clientId: job.clientId, label: clientLabels.get(job.clientId) ?? 'Removed client' },
    runtimeMode: job.runtimeMode,
    createdAt: iso(job.createdAt),
    stateChangedAt: iso(job.stateChangedAt),
    updatedAt: iso(job.updatedAt),
    finishedAt: iso(job.finishedAt),
    waitingFor: job.state === 'needs_input' ? (job.pendingRequestIds.length > 0 ? 'question' : 'approval') : null,
    pendingQuestions: job.pendingRequestIds.length,
    delegated: { following: job.delegatedWork.length, untracked: job.delegatedUntracked, endedAt: iso(job.delegatedEndedAt) },
    hostUnreachableSince: iso(job.hostUnreachableSince),
    error: errorCode ? { code: errorCode, detail: explainJobError(errorCode) } : null,
    link: threadLink(job.threadId),
  };
}

export interface EventView {
  id: number;
  at: Time;
  jobId: string;
  hostId: string;
  project: string;
  type: string;
  fromState: JobState | null;
  toState: JobState | null;
  reason: string | null;
  code: string | null;
  summary: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Attention

export interface AttentionItem {
  tone: Tone;
  kind: 'host' | 'client' | 'job' | 'gateway';
  ref: string;
  title: string;
  detail: string;
  at: Time;
  /** Where the operator acts: a T3 thread link, a CLI command to run on the gateway machine, or a dashboard view. */
  action: { kind: 'link'; label: string; href: string } | { kind: 'command'; label: string; command: string } | { kind: 'view'; label: string; view: string } | null;
}

const TONE_ORDER: Record<Tone, number> = { bad: 0, warn: 1, info: 2, unknown: 3, good: 4 };

function attentionItems(hosts: HostView[], clients: ClientView[], jobs: JobView[], checks: CheckRun | null, now: number): AttentionItem[] {
  const items: AttentionItem[] = [];
  /** Hosts whose T3 answer is already shown, from a health result at least as new as the last check run, or as an item. */
  const answerShown = new Set<string>();
  for (const host of hosts) {
    const name = host.label;
    const checkedAt = host.reachability.checkedAt === null ? null : Date.parse(host.reachability.checkedAt);
    if (checks && checkedAt !== null && checkedAt >= Date.parse(checks.startedAt)) answerShown.add(host.id);
    if (host.reachability.state === 'credential_rejected') {
      items.push({ tone: 'bad', kind: 'host', ref: host.id, title: `T3 on ${name} refuses the gateway's credential`, detail: host.reachability.detail,
        at: host.reachability.checkedAt, action: { kind: 'command', label: 'Enroll again', command: `t3-fleet-gateway hosts enroll ${host.id}` } });
    } else if (host.reachability.state === 'not_enrolled') {
      items.push({ tone: 'warn', kind: 'host', ref: host.id, title: `${name} is not enrolled`, detail: host.reachability.detail,
        at: null, action: { kind: 'command', label: 'Enroll', command: `t3-fleet-gateway hosts enroll ${host.id}` } });
    } else if (host.reachability.state === 'unreachable' || host.engine) {
      const code = host.reachability.errorCode ?? host.engine?.errorCode ?? null;
      const open = host.capacity.open;
      items.push({ tone: 'bad', kind: 'host', ref: host.id, title: `Can't reach ${name}`,
        detail: `${explainHostError(code)}${open > 0 ? ` Its ${open} open job${open === 1 ? '' : 's'} keep their state and resume when it answers.` : ''}`,
        at: host.engine?.unreachableSince ?? host.reachability.checkedAt, action: { kind: 'view', label: 'Host details', view: `hosts/${host.id}` } });
    }
    if (items.some((item) => item.kind === 'host' && item.ref === host.id)) answerShown.add(host.id);
    if (host.credential.state === 'expired') {
      items.push({ tone: 'bad', kind: 'host', ref: host.id, title: `${name}'s T3 credential has expired`, detail: 'Renewal re-enrolls automatically when the mint command works; until then the gateway cannot use this host.',
        at: host.credential.expiresAt, action: { kind: 'command', label: 'Enroll again', command: `t3-fleet-gateway hosts enroll ${host.id}` } });
    } else if (host.credential.renewalError) {
      items.push({ tone: 'warn', kind: 'host', ref: host.id, title: `Credential renewal failed for ${name}`, detail: host.credential.renewalError.detail,
        at: host.credential.renewalError.at, action: { kind: 'command', label: 'Diagnose', command: 't3-fleet-gateway doctor' } });
    }
    const coveredCodes = new Set<string>();
    if (host.reachability.state === 'unreachable' || host.engine) {
      const code = host.reachability.errorCode ?? host.engine?.errorCode;
      if (code) coveredCodes.add(code);
    }
    if (host.reachability.state === 'credential_rejected' || host.credential.state === 'expired') coveredCodes.add('t3_unauthorized');
    if (host.reachability.state === 'not_enrolled') coveredCodes.add('host_not_enrolled');
    for (const signal of host.signals) {
      if (!signal.problem || signal.stale || (isCallSignal(signal.kind) && signal.code && coveredCodes.has(signal.code))) continue;
      const { firstSeen, lastSeen, count } = signal.problem;
      items.push({ tone: 'bad', kind: 'host', ref: host.id,
        title: `${SIGNAL_LABELS[signal.kind]} failing on ${host.label}`,
        detail: `${signal.code}: ${signal.message} First seen: ${iso(firstSeen)}. Last seen: ${iso(lastSeen)}. Count: ${count}.`,
        at: iso(lastSeen), action: { kind: 'view', label: 'Host details', view: `hosts/${host.id}` } });
    }
  }
  // The last manual check run's failures and warnings, except what the snapshot shows live: a host's credential and
  // renewal state, and its T3 answer once a health result as new as the run is shown (a timed-out check has none).
  for (const result of checks?.results ?? []) {
    if (result.level === 'ok') continue;
    const host = result.hostId === null ? null : hosts.find((candidate) => candidate.id === result.hostId);
    if (result.hostId !== null) {
      if (!host || result.id.endsWith(':credential') || result.id.endsWith(':renewal') || (result.id.endsWith(':t3') && answerShown.has(host.id))) continue;
    }
    items.push({ tone: result.level === 'fail' ? 'bad' : 'warn', kind: host ? 'host' : 'gateway', ref: host ? host.id : result.id,
      title: `${host ? `${host.label}: ` : ''}${result.name} check ${result.level === 'fail' ? 'failed' : 'needs a look'}`, detail: result.detail,
      at: checks!.finishedAt, action: { kind: 'view', label: 'Checks', view: 'checks' } });
  }
  for (const client of clients) {
    if (client.grant.state === 'revoked') continue;
    if (client.grant.state === 'unusable') {
      items.push({ tone: 'bad', kind: 'client', ref: client.id, title: `${client.label} has no usable grant`, detail: client.status.detail,
        at: null, action: { kind: 'view', label: 'Client details', view: `clients/${client.id}` } });
    }
    const replay = client.grant.revokedFamilies.find((family) =>
      (family.reason === 'refresh_token_reuse' || family.reason === 'authorization_code_reuse') && family.at !== null && now - Date.parse(family.at) <= REPLAY_WARNING_MS);
    if (replay) {
      items.push({ tone: 'bad', kind: 'client', ref: client.id, title: `A grant of ${client.label} was revoked for token reuse`, detail: `It was ${replay.detail}. If the connector did not retry with an old token, treat its tokens as exposed.`,
        at: replay.at, action: { kind: 'command', label: 'Diagnose', command: `t3-fleet-gateway clients diagnose ${client.id}` } });
    }
    const until = client.kind === 'bearer' && typeof client.grant.accessUsableUntil === 'string' && client.grant.accessUsableUntil !== 'never'
      ? Date.parse(client.grant.accessUsableUntil) : null;
    if (until !== null && until - now <= TOKEN_EXPIRY_WARNING_MS && client.grant.usableAccess) {
      const command = replacementCommand(client);
      items.push({ tone: 'warn', kind: 'client', ref: client.id, title: `${client.label}'s bearer token expires soon`, at: client.grant.accessUsableUntil as string,
        ...(command
          ? { detail: 'Bearer tokens do not refresh. Mint a replacement with the same access and update the connector before it expires.',
            action: { kind: 'command', label: 'Mint replacement', command } }
          : { detail: "Bearer tokens do not refresh. Mint a replacement with clients token, choosing --access and --hosts no wider than this token's (the defaults are operate on all hosts), and update the connector before it expires.",
            action: { kind: 'view', label: 'Client details', view: `clients/${client.id}` } }) });
    }
    if ((client.grant.state === 'active' || client.grant.state === 'refreshable') && client.observed.lastMcpSuccessAt === null) {
      items.push({ tone: 'info', kind: 'client', ref: client.id, title: `${client.label} has not been observed`, detail: 'Its grant is usable but no successful request is recorded. Ask it to call fleet_status; a completed request shows here.',
        at: null, action: { kind: 'view', label: 'Client details', view: `clients/${client.id}` } });
    }
  }
  for (const job of jobs) {
    if (job.settlementAcknowledged) continue;
    const where = `${job.project} on ${job.hostId}`;
    const link = job.link ? { kind: 'link' as const, label: 'Open in T3', href: job.link } : null;
    if (job.state === 'needs_input') {
      items.push(job.waitingFor === 'approval'
        ? { tone: 'warn', kind: 'job', ref: job.id, title: `“${job.title}” is waiting for your approval`, detail: `A permission approval in ${where}. Only you can give it, in T3; agents cannot.`, at: job.stateChangedAt, action: link }
        : { tone: 'warn', kind: 'job', ref: job.id, title: `“${job.title}” asked a question`, detail: `${job.pendingQuestions} pending in ${where}. An Operate agent can answer with work_respond, or answer it in T3.`, at: job.stateChangedAt, action: link });
    } else if (job.state === 'unknown') {
      items.push({ tone: 'warn', kind: 'job', ref: job.id, title: `Launch of “${job.title}” is unconfirmed`, detail: `The gateway is looking for its thread in ${where}. It never launches twice.`, at: job.stateChangedAt, action: null });
    } else if (job.state === 'failed' && job.finishedAt !== null && now - Date.parse(job.finishedAt) <= DAY) {
      items.push({ tone: 'bad', kind: 'job', ref: job.id, title: `“${job.title}” failed`, detail: `${job.error?.detail ?? `Code ${job.error?.code ?? 'unknown'}.`} In ${where}.`, at: job.finishedAt, action: link });
    } else if (job.state === 'idle' && job.delegated.endedAt !== null && job.delegated.following === 0 && job.delegated.untracked === 0) {
      items.push({ tone: 'info', kind: 'job', ref: job.id, title: `“${job.title}” did not resume after its delegated work ended`, detail: `An agent should ask it to check on that work (work_continue). In ${where}.`, at: job.delegated.endedAt, action: link });
    }
  }
  items.sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone] || (Date.parse(b.at ?? '') || 0) - (Date.parse(a.at ?? '') || 0));
  return items.slice(0, LIMITS.attention);
}

// ---------------------------------------------------------------------------------------------------------------
// The snapshot

export interface DashboardSnapshot {
  generatedAt: string;
  demoLabel: string | null;
  gateway: {
    name: string;
    version: string;
    node: string;
    startedAt: string;
    publicUrl: string;
    mcpListen: string;
    engine: { running: boolean; intervalSeconds: number; lastTickAt: Time };
    database: { schemaVersion: number; expectedVersion: number };
  };
  /** The last manual check run since the gateway started, or null. */
  checks: CheckRun | null;
  hosts: HostView[];
  clients: { items: ClientView[]; total: number; pending: { count: number; recent: { id: string; name: string; createdAt: Time }[] } };
  jobs: {
    counts: Record<JobState, number>;
    open: JobView[];
    openTotal: number;
    recent: JobView[];
    attention: JobView[];
  };
  events: EventView[];
  attention: AttentionItem[];
}

export function buildSnapshot(sources: DashboardSources): DashboardSnapshot {
  const { config, db, clock, store } = sources;
  const now = clock();
  const engine = sources.engine.status();
  const stateRows = store.stateCounts();
  const counts = new Map(stateRows.map((row) => [key(row.hostId, row.state, row.standing), row.count]));
  const totals = Object.fromEntries(JOB_STATES.map((state) => [state, 0])) as Record<JobState, number>;
  for (const row of stateRows) totals[row.state] += row.count;

  const hosts = config.hosts.map((host) => hostView(sources, host, counts, engine));

  const summaries = new ClientStore(db, clock).list();
  const clientLabels = new Map(summaries.map((client) => [client.id, clip(config.dashboard.clientLabels[client.id] ?? client.name, 80)]));
  // Approved OAuth clients and operator tokens: a client with no grant family never completed an approval.
  const established = summaries.filter((client) => client.totalFamilies > 0 || isTokenClient(client));
  const pending = summaries.filter((client) => !(client.totalFamilies > 0 || isTokenClient(client)) && client.revokedAt === null);
  const ordered = established.sort((a, b) =>
    Number(a.revokedAt !== null) - Number(b.revokedAt !== null) || (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt));
  const clients = ordered.slice(0, LIMITS.clients).flatMap((summary) => clientView(sources, summary, now) ?? []);

  const view = (job: Job) => jobView(job, clientLabels, store.settlementAcknowledged(job.id));
  const open = store.list({ states: OPEN_STATES, limit: LIMITS.openJobs }).map(view);
  const recent = store.list({ states: TERMINAL_STATES, limit: LIMITS.recentJobs }).map(view);
  const attentionJobs = store.attention(now, DAY, LIMITS.jobAttention, {}, true).map(view);
  const openTotal = OPEN_STATES.reduce((sum, state) => sum + totals[state], 0);

  const events = store.latestEvents(LIMITS.events).map((event): EventView => {
    const reason = safeCode(event.detail.reason);
    return {
      id: event.id,
      at: iso(event.createdAt),
      jobId: event.jobId,
      hostId: event.hostId,
      project: event.projectAlias,
      type: safeCode(event.type) ?? 'event',
      fromState: event.fromState,
      toState: event.toState,
      reason,
      code: safeCode(event.detail.code),
      summary: describeEvent(safeCode(event.type) ?? 'event', event.fromState, event.toState, reason),
    };
  });

  const checks = sources.lastChecks();
  return {
    generatedAt: new Date(now).toISOString(),
    demoLabel: sources.demoLabel ?? null,
    gateway: {
      name: GATEWAY_NAME,
      version: GATEWAY_VERSION,
      node: process.version,
      startedAt: new Date(sources.startedAt).toISOString(),
      publicUrl: config.publicUrl,
      mcpListen: sources.mcpListen,
      engine: { running: engine.running, intervalSeconds: Math.round(engine.intervalMs / 1000), lastTickAt: iso(engine.lastTickAt) },
      database: { schemaVersion: schemaVersion(db), expectedVersion: SCHEMA_VERSION },
    },
    checks,
    hosts,
    clients: {
      items: clients,
      total: established.length,
      pending: {
        count: pending.length,
        recent: pending.slice(-LIMITS.pendingClients).reverse().map((client) => ({ id: client.id, name: clip(client.name, 80), createdAt: iso(client.createdAt) })),
      },
    },
    jobs: { counts: totals, open, openTotal, recent, attention: attentionJobs },
    events,
    attention: attentionItems(hosts, clients, mergeJobs(attentionJobs, open, recent), checks, now),
  };
}

/** Each job once, for attention: the attention query first, then open and recently finished jobs. */
function mergeJobs(...lists: JobView[][]): JobView[] {
  const seen = new Map<string, JobView>();
  for (const list of lists) for (const job of list) if (!seen.has(job.id)) seen.set(job.id, job);
  return [...seen.values()];
}
