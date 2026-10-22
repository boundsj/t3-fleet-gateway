import type { HostConfig } from '../config.ts';
import { describeError, GatewayError, type ErrorCode } from '../errors.ts';
import type { Logger } from '../log.ts';
import { T3Client } from '../t3/client.ts';
import { obtainCredential, type PairingFlowOptions } from '../t3/pairing.ts';
import { DAY, SECOND, type Clock } from '../time.ts';
import { checkMintExecutable, preflightCommand, type CommandCheck } from './commandPreflight.ts';
import type { CredentialStore, StoredCredential } from './credentials.ts';
import { HostSignals, SIGNAL_LABELS, type SignalKind } from './signals.ts';

const HEALTH_TTL_MS = 30 * SECOND;
const HEALTH_TIMEOUT_MS = 5 * SECOND;

export type CredentialState = 'missing' | 'active' | 'renewal_due' | 'expired';

export interface CredentialStatus {
  state: CredentialState;
  expiresAt: number | null;
  daysLeft: number | null;
  /** Present when the most recent renewal attempt failed. */
  renewalError: { code: string; message: string; at: number } | null;
}

export interface HostHealth {
  /** null when the gateway cannot ask (no credential yet). True when T3 answered, even with a refusal. */
  reachable: boolean | null;
  /** T3 answered 401 or 403: the host is up but the stored credential no longer works. */
  credentialRejected: boolean;
  t3Version: string | null;
  checkedAt: number;
  error: { code: ErrorCode; message: string } | null;
}

export interface EnrollResult {
  hostId: string;
  t3Version: string;
  expiresAt: number;
}

export interface HostRegistryOptions {
  hosts: readonly HostConfig[];
  store: CredentialStore;
  clock: Clock;
  logger: Logger;
  renewWhenDaysLeft: number;
  /** Override the pairing command runner (tests). */
  runCommand?: PairingFlowOptions['runCommand'];
  commandEnv?: NodeJS.ProcessEnv;
}

/**
 * The configured T3 hosts: one MCP client each, cached health, and credential enrollment and
 * renewal. A new credential replaces the stored one only after it has been verified against T3.
 */
export class HostRegistry {
  readonly #hosts: Map<string, HostConfig>;
  readonly #signals = new Map<string, HostSignals>();
  readonly #clients = new Map<string, T3Client>();
  readonly #health = new Map<string, { value: Promise<HostHealth>; at: number; settled?: HostHealth }>();
  /** The newest completed check per host, kept while a later one is in flight. */
  readonly #lastHealth = new Map<string, HostHealth>();
  readonly #enrolling = new Map<string, Promise<EnrollResult>>();
  readonly #options: HostRegistryOptions;

  constructor(options: HostRegistryOptions) {
    this.#options = options;
    this.#hosts = new Map(options.hosts.map((host) => [host.id, host]));
  }

  get hosts(): HostConfig[] {
    return [...this.#hosts.values()];
  }

  host(id: string): HostConfig {
    const host = this.#hosts.get(id);
    if (!host) throw new GatewayError('host_not_found', `No host "${id}" in the config. Known hosts: ${[...this.#hosts.keys()].join(', ')}`);
    return host;
  }

  signals(id: string): HostSignals {
    this.host(id);
    let signals = this.#signals.get(id);
    if (!signals) { signals = new HostSignals(this.#options.clock); this.#signals.set(id, signals); }
    return signals;
  }

  client(id: string): T3Client {
    const host = this.host(id);
    let client = this.#clients.get(id);
    if (!client) {
      client = new T3Client({
        hostId: id, t3Url: host.t3Url, token: () => this.#options.store.get(id)?.accessToken,
        contact: (error, version) => this.#recordContact(id, error, version),
        observe: (name, error) => {
          if (Object.hasOwn(SIGNAL_LABELS, name)) this.signals(id).record(name as SignalKind, error);
        },
      });
      this.#clients.set(id, client);
    }
    return client;
  }

  credentialStatus(id: string): CredentialStatus {
    this.host(id);
    const { store, clock, renewWhenDaysLeft } = this.#options;
    const credential = store.get(id);
    const renewal = store.renewal(id);
    const renewalError =
      renewal?.failedAt != null && renewal.errorCode
        ? { code: renewal.errorCode, message: renewal.errorMessage ?? '', at: renewal.failedAt }
        : null;
    if (!credential) return { state: 'missing', expiresAt: null, daysLeft: null, renewalError };
    const remaining = credential.expiresAt - clock();
    const state: CredentialState = remaining <= 0 ? 'expired' : remaining < renewWhenDaysLeft * DAY ? 'renewal_due' : 'active';
    return { state, expiresAt: credential.expiresAt, daysLeft: Math.max(0, Math.floor(remaining / DAY)), renewalError };
  }

  /** Cached reachability and version, refreshed at most every 30 seconds unless `fresh` is set. */
  health(id: string, options: { fresh?: boolean } = {}): Promise<HostHealth> {
    this.host(id);
    const now = this.#options.clock();
    const cached = this.#health.get(id);
    if (cached && !options.fresh && now - cached.at < HEALTH_TTL_MS) return cached.value;
    const entry: { value: Promise<HostHealth>; at: number; settled?: HostHealth } = {
      value: this.#checkHealth(id), at: now,
    };
    entry.value = entry.value.then((health) => {
      entry.settled = health;
      return health;
    });
    this.#health.set(id, entry);
    return entry.value;
  }

  /**
   * The last completed health check, however old, without starting one (the dashboard shows its age); null when none
   * has completed since the process started.
   */
  lastHealth(id: string): HostHealth | null {
    this.host(id);
    return this.#lastHealth.get(id) ?? null;
  }

  #recordContact(id: string, error?: unknown, serverVersion?: string): void {
    const described = error === undefined ? null : describeError(error);
    // Application refusals and invalid payloads do not establish transport failure or recovery.
    if (described && !['host_unreachable', 't3_timeout', 't3_response_lost', 't3_unauthorized', 'host_not_enrolled'].includes(described.code)) return;
    const credentialRejected = described?.code === 't3_unauthorized';
    this.#lastHealth.set(id, {
      reachable: described === null ? true : described.code === 'host_not_enrolled' ? null : credentialRejected,
      credentialRejected,
      t3Version: described === null ? serverVersion ?? this.#lastHealth.get(id)?.t3Version ?? null : null,
      checkedAt: this.#options.clock(),
      error: described,
    });
  }

  /** One cancellable, non-retrying environment read, isolated from the shared work connection. */
  async probeReachability(id: string, signal: AbortSignal): Promise<void> {
    const host = this.host(id);
    if (signal.aborted || this.credentialStatus(id).state === 'missing') return;
    const client = new T3Client({
      hostId: id, t3Url: host.t3Url, token: () => this.#options.store.get(id)?.accessToken, signal,
      contact: (error, version) => this.#recordContact(id, error, version),
      observe: (name, error) => this.signals(id).record(name as SignalKind, error),
    });
    try {
      await client.environmentRead({ timeoutMs: HEALTH_TIMEOUT_MS, retry: false });
    } catch {
      // The client recorded the fixed-code outcome; no immediate retry and no error-content logging.
    } finally {
      await client.close();
    }
  }

  async #checkHealth(id: string): Promise<HostHealth> {
    try {
      const environment = await this.client(id).environmentRead({ timeoutMs: HEALTH_TIMEOUT_MS });
      return { reachable: true, credentialRejected: false, t3Version: environment.serverVersion, checkedAt: this.#options.clock(), error: null };
    } catch (error) {
      const described = describeError(error);
      const credentialRejected = described.code === 't3_unauthorized';
      const reachable = described.code === 'host_not_enrolled' ? null : credentialRejected;
      return { reachable, credentialRejected, t3Version: null, checkedAt: this.#options.clock(), error: described };
    }
  }

  /** Diagnostics only: no pairing flow, registration or credential mutation. */
  async preflight(id: string, options: { signal?: AbortSignal; serverVersion?: string | null } = {}): Promise<CommandCheck[]> {
    const host = this.host(id);
    let serverVersion = options.serverVersion;
    if (serverVersion === undefined) {
      // Startup diagnostics must neither initiate MCP initialization nor wait for a pending
      // health read. Doctor supplies its fresh health version explicitly.
      const cached = this.#health.get(id);
      serverVersion = cached && this.#options.clock() - cached.at < HEALTH_TTL_MS ? cached.settled?.t3Version ?? null : null;
    }
    return preflightCommand(host, {
      ...options,
      serverVersion,
      env: this.#options.commandEnv ?? process.env,
      ...(this.#options.runCommand ? { runCommand: this.#options.runCommand } : {}),
    });
  }

  /** Enroll (or re-enroll) a host through T3's pairing-code approval. Concurrent calls share one attempt. */
  enroll(id: string): Promise<EnrollResult> {
    const running = this.#enrolling.get(id);
    if (running) return running;
    const attempt = this.#enroll(id).finally(() => this.#enrolling.delete(id));
    this.#enrolling.set(id, attempt);
    return attempt;
  }

  async #enroll(id: string): Promise<EnrollResult> {
    const host = this.host(id);
    const { store, clock, logger } = this.#options;
    logger.info('host.enrollment_started', { hostId: id });
    try {
      const obtained = await obtainCredential({
        hostId: id,
        t3Url: host.t3Url,
        access: host.access,
        mintPairingCode: host.mintPairingCode,
        clock,
        ...(this.#options.commandEnv ? { commandEnv: this.#options.commandEnv } : {}),
        ...(this.#options.runCommand ? { runCommand: this.#options.runCommand } : {}),
      });
      const probe = new T3Client({ hostId: id, t3Url: host.t3Url, token: () => obtained.accessToken });
      let t3Version: string;
      try {
        t3Version = (await probe.environmentRead()).serverVersion;
      } catch (error) {
        throw new GatewayError('enrollment_failed', `New credential failed verification: ${describeError(error).message}`, { cause: error });
      } finally {
        await probe.close();
      }
      const credential: StoredCredential = { ...obtained, hostId: id, verifiedAt: clock() };
      store.save(credential);
      store.recordRenewal(id, clock(), { ok: true });
      this.#health.delete(id);
      this.#recordContact(id, undefined, t3Version);
      logger.info('host.enrollment_succeeded', { hostId: id, expiresAt: new Date(credential.expiresAt).toISOString() });
      return { hostId: id, t3Version, expiresAt: credential.expiresAt };
    } catch (error) {
      const described = describeError(error);
      store.recordRenewal(id, clock(), { ok: false, ...described });
      logger.error('host.enrollment_failed', { hostId: id, errorCode: described.code, detail: described.message });
      throw error;
    }
  }

  /** Re-enroll every host whose credential is inside the renewal window or expired. Never throws. */
  async renewDue(): Promise<void> {
    for (const host of this.#hosts.values()) {
      const status = this.credentialStatus(host.id);
      if (status.state !== 'renewal_due' && status.state !== 'expired') continue;
      const failure = checkMintExecutable(host, this.#options.commandEnv ?? process.env).find((result) => result.level === 'fail');
      if (failure) {
        this.#options.store.recordRenewal(host.id, this.#options.clock(), {
          ok: false, code: 'pairing_command_failed', message: failure.detail,
        });
        this.#options.logger.error('host.pairing_preflight', { hostId: host.id, checkCode: failure.code });
        continue;
      }
      this.#options.logger.info('host.renewal_due', { hostId: host.id, daysLeft: status.daysLeft });
      try {
        await this.enroll(host.id);
      } catch {
        // Logged and recorded by enroll; the old credential stays in place.
      }
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.#clients.values()].map((client) => client.close()));
    this.#clients.clear();
  }
}
