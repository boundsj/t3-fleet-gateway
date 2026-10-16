import { GatewayError } from '../errors.ts';
import type { CatalogModel, CatalogProvider } from '../hosts/catalog.ts';

/** Bounds on an agent's model selection. */
export const MAX_SELECTION_OPTIONS = 32;
export const MAX_SELECTION_CHARS = 16 * 1024;
export const MAX_SELECTION_ID_CHARS = 200;

/** An agent's explicit choice of provider instance, model and advertised options, as T3's `modelSelection` takes them. */
export interface ModelSelection {
  instanceId: string;
  model: string;
  options?: Record<string, string | boolean>;
}

/** Where a job's model comes from: the agent's selection, the gateway config, or T3's own project default (nothing sent). */
export type ModelSource = 'explicit' | 'project' | 'host' | 't3_default';

/**
 * What a job launched through a direct target or an explicit model selection resolved to when it was
 * created (`jobs.launch_spec`, migration 8): the dispatcher launches from this record, so a later config
 * change, catalog change or alias ambiguity cannot move the job. Ordinary alias-only jobs have none and
 * dispatch as before. Never holds task text.
 */
export interface LaunchSpec {
  v: 1;
  projectId: string;
  projectName: string;
  /** `alias`: policy from a configured project; `discovered`: the host's discovery policy. */
  source: 'alias' | 'discovered';
  alias: string | null;
  baseRef: string;
  runtimeMode: string;
  model: {
    source: ModelSource;
    /** The exact `modelSelection` sent to T3; null leaves the choice to the T3 project's default. */
    selection: Record<string, unknown> | null;
  };
}

export function parseLaunchSpec(text: string | null): LaunchSpec | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as LaunchSpec;
    return value && value.v === 1 && typeof value.projectId === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** Options with their keys sorted, so two selections that differ only in key order hash alike. */
export function canonicalSelection(selection: ModelSelection): ModelSelection {
  const options = selection.options;
  return {
    instanceId: selection.instanceId,
    model: selection.model,
    ...(options === undefined ? {} : { options: Object.fromEntries(Object.keys(options).sort().map((key) => [key, options[key] as string | boolean])) }),
  };
}

function describeModels(providers: readonly CatalogProvider[]): string {
  const listed = providers.flatMap((provider) => provider.models.map((model) => `${provider.providerInstanceId}/${model.id}`));
  return listed.length === 0 ? '(no models advertised)' : listed.slice(0, 50).join(', ') + (listed.length > 50 ? ', …' : '');
}

function describeOptions(model: CatalogModel): string {
  const selectable = model.options.filter((option) => option.type === 'select' || option.type === 'boolean');
  if (selectable.length === 0) return 'it advertises no selectable options';
  return `its options: ${selectable
    .map((option) => (option.type === 'boolean' ? `${option.id} (boolean)` : `${option.id} (one of ${(option.choices ?? []).map((choice) => choice.id).join(', ')})`))
    .join('; ')}`;
}

/**
 * Check an explicit selection against a host's advertised catalog: the provider instance and model must
 * exist, every option id must be one the model advertises, a `select` value must be one of its choice
 * ids and a `boolean` value a boolean (false included). Anything else is `invalid_argument` naming what
 * is available; nothing is substituted. Returns the selection in the exact shape sent to T3.
 */
export function validateSelection(hostId: string, providers: readonly CatalogProvider[], selection: ModelSelection): ModelSelection {
  const provider = providers.find((candidate) => candidate.providerInstanceId === selection.instanceId);
  const model = provider?.models.find((candidate) => candidate.id === selection.model);
  if (!provider || !model) {
    throw new GatewayError(
      'invalid_argument',
      `Host ${hostId} does not advertise model ${JSON.stringify(selection.model)} on provider instance ${JSON.stringify(selection.instanceId)}. ` +
        `Available (instanceId/model): ${describeModels(providers)}. fleet_models lists them with their options.`,
    );
  }
  const options = selection.options ?? {};
  for (const [id, value] of Object.entries(options)) {
    const descriptor = model.options.find((candidate) => candidate.id === id);
    const where = `model ${model.id} on ${provider.providerInstanceId} (host ${hostId})`;
    if (!descriptor || (descriptor.type !== 'select' && descriptor.type !== 'boolean')) {
      throw new GatewayError('invalid_argument', `Option ${JSON.stringify(id)} is not a selectable option of ${where}; ${describeOptions(model)}.`);
    }
    if (descriptor.type === 'boolean' && typeof value !== 'boolean') {
      throw new GatewayError('invalid_argument', `Option ${JSON.stringify(id)} of ${where} is a boolean; pass true or false, not ${JSON.stringify(value)}.`);
    }
    if (descriptor.type === 'select' && (typeof value !== 'string' || !(descriptor.choices ?? []).some((choice) => choice.id === value))) {
      throw new GatewayError(
        'invalid_argument',
        `Option ${JSON.stringify(id)} of ${where} takes one of ${(descriptor.choices ?? []).map((choice) => JSON.stringify(choice.id)).join(', ')}, not ${JSON.stringify(value)}.`,
      );
    }
  }
  return canonicalSelection(selection);
}
