import { GatewayError } from '../errors.ts';
import type { OptionDescriptor, T3Capabilities, T3Project } from '../t3/schemas.ts';
import { SECOND, type Clock } from '../time.ts';
import type { HostRegistry } from './registry.ts';

/** How long a host's catalog answers agents from memory before it is read from T3 again. */
export const CATALOG_TTL_MS = 30 * SECOND;
/** Bounds on a host's model catalog. Beyond any of them the catalog is `catalog_limit`: never a partial one. */
export const MAX_PROVIDERS = 100;
export const MAX_MODELS = 2000;
export const MAX_OPTIONS_PER_MODEL = 64;
export const MAX_CHOICES_PER_OPTION = 256;
/** The sanitized catalog's JSON size, in characters (UTF-16 code units). */
export const MAX_CATALOG_CHARS = 1_000_000;

/** A T3 project as agents see it: id and name only, never workspace paths, scripts or other project settings. */
export interface CatalogProject {
  id: string;
  name: string;
  /** Whether T3 launches in this project with a model of the project's own when none is passed. */
  hasDefaultModel: boolean;
}

export interface CatalogChoice {
  id: string;
  label: string;
  description: string | null;
  isDefault: boolean;
}

/**
 * A model option T3 advertises. `type` is T3's descriptor type: `select` (with `choices`) or `boolean`
 * are selectable with work_start; any other type a newer T3 may add is listed but cannot be selected.
 */
export interface CatalogOption {
  id: string;
  label: string;
  description: string | null;
  type: string;
  choices: CatalogChoice[] | null;
  currentValue: string | boolean | null;
}

export interface CatalogModel {
  id: string;
  label: string | null;
  options: CatalogOption[];
}

export interface CatalogProvider {
  providerInstanceId: string;
  driverKind: string;
  displayName: string | null;
  models: CatalogModel[];
  runtimeModes: string[] | null;
  /** T3's own flags about delegated child tasks: metadata, not proof that a top-level launch works. */
  canRunChildTask: boolean | null;
  canRunCrossProviderChildTask: boolean | null;
  constraints: string[];
}

/** A completed, sanitized read of one host's catalog. `generation` increases with every new read. */
export interface Snapshot<T> {
  generation: number;
  fetchedAt: number;
  value: T;
}

export type CatalogKind = 'projects' | 'models';

interface Entry<T> {
  snapshot?: Snapshot<T>;
  inflight?: Promise<Snapshot<T>>;
}

function limit(hostId: string, what: string): GatewayError {
  return new GatewayError('catalog_limit', `Host ${hostId} advertises more ${what} than the gateway handles; its catalog is unavailable.`);
}

function sanitizeOption(descriptor: OptionDescriptor, hostId: string): CatalogOption {
  const choices = descriptor.type === 'select' ? (descriptor.options ?? []) : null;
  if (choices && choices.length > MAX_CHOICES_PER_OPTION) throw limit(hostId, 'choices for one model option');
  return {
    id: descriptor.id,
    label: descriptor.label,
    description: descriptor.description ?? null,
    type: descriptor.type,
    choices: choices && choices.map((choice) => ({ id: choice.id, label: choice.label, description: choice.description ?? null, isDefault: choice.isDefault === true })),
    currentValue: descriptor.currentValue ?? null,
  };
}

/** The whitelisted catalog of providers and models from a T3 capabilities answer, or `catalog_limit`. */
export function sanitizeCapabilities(hostId: string, capabilities: T3Capabilities): CatalogProvider[] {
  if (capabilities.providers.length > MAX_PROVIDERS) throw limit(hostId, 'providers');
  let models = 0;
  const providers = capabilities.providers.map((provider): CatalogProvider => {
    models += provider.models.length;
    if (models > MAX_MODELS) throw limit(hostId, 'models');
    return {
      providerInstanceId: provider.providerInstanceId,
      driverKind: provider.driverKind,
      displayName: provider.displayName ?? null,
      models: provider.models.map((model) => {
        const options = model.options ?? [];
        if (options.length > MAX_OPTIONS_PER_MODEL) throw limit(hostId, 'options for one model');
        return { id: model.id, label: model.label ?? null, options: options.map((option) => sanitizeOption(option, hostId)) };
      }),
      runtimeModes: provider.runtimeModes ?? null,
      canRunChildTask: provider.canRunChildTask ?? null,
      canRunCrossProviderChildTask: provider.canRunCrossProviderChildTask ?? null,
      constraints: provider.constraints ?? [],
    };
  });
  if (JSON.stringify(providers).length > MAX_CATALOG_CHARS) throw limit(hostId, 'catalog text');
  return providers;
}

export function sanitizeProjects(hostId: string, projects: readonly T3Project[]): CatalogProject[] {
  const sanitized = projects.map((project) => ({
    id: project.id,
    name: project.title,
    hasDefaultModel: project.defaultModelSelection !== undefined && project.defaultModelSelection !== null,
  }));
  if (JSON.stringify(sanitized).length > MAX_CATALOG_CHARS) throw limit(hostId, 'project catalog text');
  return sanitized;
}

/**
 * Per-host catalogs of T3 projects and model capabilities for agents, read from T3 on demand only
 * (never on a timer): a completed sanitized snapshot answers for CATALOG_TTL_MS, concurrent readers
 * share one in-flight read, and a failed read is thrown to its callers and replaces nothing. The
 * caller authorizes the host before asking. Snapshots are whitelisted copies; no T3 answer is kept.
 */
export class CatalogService {
  readonly #registry: HostRegistry;
  readonly #clock: Clock;
  readonly #projects = new Map<string, Entry<CatalogProject[]>>();
  readonly #models = new Map<string, Entry<CatalogProvider[]>>();
  #generation = 0;

  constructor(registry: HostRegistry, clock: Clock) {
    this.#registry = registry;
    this.#clock = clock;
  }

  projects(hostId: string, options: { refresh?: boolean } = {}): Promise<Snapshot<CatalogProject[]>> {
    return this.#read(this.#projects, hostId, options.refresh === true, async () =>
      sanitizeProjects(hostId, await this.#registry.client(hostId).listProjects()),
    );
  }

  models(hostId: string, options: { refresh?: boolean } = {}): Promise<Snapshot<CatalogProvider[]>> {
    return this.#read(this.#models, hostId, options.refresh === true, async () =>
      sanitizeCapabilities(hostId, await this.#registry.client(hostId).readCapabilities()),
    );
  }

  /** The snapshot held for a host, however old: a page cursor continues from the generation it names. */
  held(hostId: string, kind: CatalogKind): Snapshot<CatalogProject[]> | Snapshot<CatalogProvider[]> | undefined {
    return kind === 'projects' ? this.#projects.get(hostId)?.snapshot : this.#models.get(hostId)?.snapshot;
  }

  #read<T>(entries: Map<string, Entry<T>>, hostId: string, refresh: boolean, fetch: () => Promise<T>): Promise<Snapshot<T>> {
    this.#registry.host(hostId);
    let entry = entries.get(hostId);
    if (!entry) {
      entry = {};
      entries.set(hostId, entry);
    }
    const now = this.#clock();
    if (!refresh && entry.snapshot && now - entry.snapshot.fetchedAt < CATALOG_TTL_MS) return Promise.resolve(entry.snapshot);
    if (entry.inflight) return entry.inflight;
    const current = entry;
    const inflight = fetch()
      .then((value) => {
        const snapshot: Snapshot<T> = { generation: ++this.#generation, fetchedAt: this.#clock(), value };
        current.snapshot = snapshot;
        return snapshot;
      })
      .finally(() => {
        if (current.inflight === inflight) current.inflight = undefined;
      });
    entry.inflight = inflight;
    return inflight;
  }
}

/** An opaque page cursor bound to one host and one catalog snapshot. A snapshot replaced since is a fresh start. */
export interface PageCursor {
  hostId: string;
  kind: CatalogKind;
  generation: number;
  offset: number;
}

export function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(`v1\n${cursor.kind}\n${cursor.hostId}\n${cursor.generation}\n${cursor.offset}`).toString('base64url');
}

export function decodeCursor(text: string): PageCursor | undefined {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(text)) return undefined;
  const parts = Buffer.from(text, 'base64url').toString('utf8').split('\n');
  if (parts.length !== 5 || parts[0] !== 'v1') return undefined;
  const [, kind, hostId, generation, offset] = parts;
  if ((kind !== 'projects' && kind !== 'models') || !hostId || !/^\d{1,15}$/.test(generation ?? '') || !/^\d{1,15}$/.test(offset ?? '')) return undefined;
  return { kind, hostId, generation: Number(generation), offset: Number(offset) };
}
