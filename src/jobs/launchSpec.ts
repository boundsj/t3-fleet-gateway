import * as z from 'zod';
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

/** A root launch is permitted only for an operator-pinned T3 scratch alias. */
const workspaceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('scratch') }),
  z.strictObject({ kind: z.literal('worktree'), baseRef: z.string().min(1), branch: z.string().min(1) }),
]);
export type Workspace = z.infer<typeof workspaceSchema>;

const modelSchema = z.strictObject({
  source: z.enum(['explicit', 'project', 'host', 't3_default']),
  selection: z.record(z.string(), z.unknown()).nullable(),
});
const sharedSpec = {
  projectId: z.string().min(1),
  projectName: z.string(),
  source: z.enum(['alias', 'discovered']),
  alias: z.string().min(1).nullable(),
  runtimeMode: z.enum(['approval-required', 'auto-accept-edits', 'auto', 'full-access']),
  model: modelSchema,
};
const launchSpecSchema = z.union([
  z.strictObject({ v: z.literal(1), ...sharedSpec, baseRef: z.string().min(1) }),
  z.strictObject({
    v: z.literal(2), ...sharedSpec,
    hostId: z.string().min(1),
    workspace: workspaceSchema,
    /** The host-only intention binds this alias; null for explicit aliases and project ids. */
    defaultProject: z.string().min(1).nullable(),
  }).refine((spec) => spec.workspace.kind !== 'scratch' || (spec.source === 'alias' && spec.alias !== null), {
    message: 'scratch launches require a configured alias',
  }).refine((spec) => spec.defaultProject === null || (spec.workspace.kind === 'scratch' && spec.defaultProject === spec.alias), {
    message: 'host defaults must bind the recorded scratch alias',
  }),
]);

/** Version 1 always means worktree. Version 2 records workspace and host-default identity explicitly. */
export type LaunchSpec = z.infer<typeof launchSpecSchema>;

export function parseLaunchSpec(text: string | null): LaunchSpec | null {
  if (text === null) return null;
  try {
    return launchSpecSchema.parse(JSON.parse(text));
  } catch {
    throw new GatewayError('database_error', 'The job has an unsupported or malformed launch spec. Upgrade or repair the ledger before dispatching.');
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
