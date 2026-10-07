import type { HostConfig } from '../config.ts';
import { describeError, GatewayError, type ErrorCode } from '../errors.ts';
import type { Logger } from '../log.ts';
import { T3Client } from '../t3/client.ts';
import { obtainCredential, type PairingFlowOptions } from '../t3/pairing.ts';
import { DAY, SECOND, type Clock } from '../time.ts';
import type { CredentialStore, StoredCredential } from './credentials.ts';

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
  /** null when the gateway cannot ask (no credential yet). */
  reachable: boolean | null;
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
}

/**
 * The configured T3 hosts: one MCP client each, cached health, and credential enrollment and
 * renewal. A new credential replaces the stored one only after it has been verified against T3.
 */
export class HostRegistry {
  readonly #hosts: Map<string, HostConfig>;
  readonly #clients = new Map<string, T3Client>();
  readonly #health = new Map<string, { value: Promise<HostHealth>; at: number }>();
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

  client(id: string): T3Client {
    const host = this.host(id);
    let client = this.#clients.get(id);
    if (!client) {
      client = new T3Client({ hostId: id, t3Url: host.t3Url, token: () => this.#options.store.get(id)?.accessToken });
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
    const value = this.#checkHealth(id);
    this.#health.set(id, { value, at: now });
    return value;
  }

  async #checkHealth(id: string): Promise<HostHealth> {
    const checkedAt = this.#options.clock();
    try {
      const environment = await this.client(id).environmentRead({ timeoutMs: HEALTH_TIMEOUT_MS });
      return { reachable: true, t3Version: environment.serverVersion, checkedAt, error: null };
    } catch (error) {
      const described = describeError(error);
      const reachable = described.code === 'host_not_enrolled' ? null : described.code === 't3_unauthorized';
      return { reachable, t3Version: null, checkedAt, error: described };
    }
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
