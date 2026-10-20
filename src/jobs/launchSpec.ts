import * as z from 'zod';
import { GatewayError } from '../errors.ts';
import type { CatalogModel, CatalogProvider } from '../hosts/catalog.ts';
import { workspaceIntentSchema } from './workspace.ts';

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
 * Version 2 records scratch launches only (T3's own scratch project, no worktree or branch). Version 1 is a worktree launch
 * from the project's configured base ref, from the local branch; version 3 is a launch whose workspace the host's probe
 * decides at dispatch (see workspace.ts), so it records the intent only.
 */
const scratchWorkspaceSchema = z.strictObject({ kind: z.literal('scratch') });

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
    v: z.literal(3), ...sharedSpec,
    // An alias-only request is recorded without reading T3: no project id or name until the dispatcher resolves them.
    projectId: z.string().min(1).nullable(),
    projectName: z.string().nullable(),
    hostId: z.string().min(1),
    workspace: workspaceIntentSchema,
  }).refine((spec) => (spec.projectId === null) === (spec.projectName === null), {
    message: 'a project id and its name are recorded together',
  }).refine((spec) => spec.projectId !== null || (spec.source === 'alias' && spec.alias !== null), {
    message: 'a launch without a project id needs a configured alias',
  }),
  z.strictObject({
    v: z.literal(2), ...sharedSpec,
    // A scratch launch never reads the project's name from T3: nothing of T3's metadata is recorded.
    projectName: z.null(),
    hostId: z.string().min(1),
    workspace: scratchWorkspaceSchema,
    defaultProject: z.string().min(1).nullable(),
  }).refine((spec) => spec.source === 'alias' && spec.alias !== null, {
    message: 'scratch launches require a configured alias',
  }).refine((spec) => spec.defaultProject === null || spec.defaultProject === spec.alias, {
    message: 'host defaults must bind the recorded scratch alias',
  }),
]);

/**
 * What a job started through a direct target, an explicit model selection or a scratch alias resolved to when it was created
 * (`jobs.launch_spec`): the dispatcher launches from this record, so a later config change, catalog change or alias ambiguity
 * cannot move the job. Alias-only worktree jobs have none and dispatch from the configuration. `source` is `alias` when a
 * configured project's policy governs and `discovered` when the host's discovery policy does; `model.selection` is the exact
 * `modelSelection` sent to T3 (null leaves the choice to the T3 project's default). Version 2 is a scratch launch; version 3
 * a project launch whose workspace is decided at dispatch. Never holds task text.
 */
export type LaunchSpec = z.infer<typeof launchSpecSchema>;

/**
 * What `jobs.launch_spec` holds, as this build reads it: nothing (an alias job, launched from the configuration), a spec it
 * understands, or a record it cannot read (damaged, or written by a build that knows more).
 */
export type StoredLaunchSpec = { kind: 'none' } | { kind: 'spec'; spec: LaunchSpec } | { kind: 'unreadable' };

/**
 * Read the stored text of one job's launch spec. Never throws, and never reports an unreadable record as nothing:
 * "nothing" dispatches the job from the configuration as a worktree job, which for a scratch job (or one started with a
 * model selection) is the wrong launch. Nor does an unreadable record fail the read: one bad row must not stop the
 * reads of every other job. The text, and what is wrong with it, are not kept: they may hold anything.
 */
export function readLaunchSpec(text: string | null): StoredLaunchSpec {
  if (text === null) return { kind: 'none' };
  try {
    const parsed = launchSpecSchema.safeParse(JSON.parse(text));
    return parsed.success ? { kind: 'spec', spec: parsed.data } : { kind: 'unreadable' };
  } catch {
    return { kind: 'unreadable' };
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
