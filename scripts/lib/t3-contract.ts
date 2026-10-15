import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { RUNTIME_MODE_VALUES } from '../../src/t3/schemas.ts';

export type AdvertisedTool = {
  name: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
};

/** The downstream calls in src/t3/client.ts, including mutations inspected but never executed by the check. */
export const REQUIRED_TOOLS = [
  't3_environment_read', 't3_project_list', 't3_thread_launch', 't3_thread_read', 't3_thread_list',
  't3_thread_search', 't3_thread_send', 't3_thread_interrupt', 't3_pending_request_list',
  't3_pending_request_read', 't3_pending_request_respond',
] as const;

export type Contract = Record<string, { inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown> }>;
export type ContractChange = { tool: string; kind: 'added' | 'removed' | 'changed'; paths: string[] };
export type InputCheck = { tool: string; status: 'pass' | 'warn' | 'fail'; code: string };

const ANNOTATIONS = new Set(['title', 'description', 'examples', '$comment']);
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const SCHEMA_VALUES = new Set([
  'additionalProperties', 'additionalItems', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames',
  'contains', 'not', 'if', 'then', 'else', 'contentSchema',
]);
const SCHEMA_ARRAYS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Sort data object keys, preserving all data keys and array order (notably inside const/enum). */
function canonicalData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalData);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalData(value[key])]));
}

function sortedValues(values: unknown[]): unknown[] {
  return values.map(canonicalData).sort((a, b) => {
    const left = JSON.stringify(a);
    const right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/** Normalize only known schema locations: a property named "description" is still a real property. */
function canonicalSchema(value: unknown): unknown {
  if (!isObject(value)) return canonicalData(value);
  return Object.fromEntries(Object.keys(value).sort().filter((key) => !ANNOTATIONS.has(key)).map((key) => {
    const child = value[key];
    let normalized: unknown;
    if (SCHEMA_MAPS.has(key) && isObject(child)) {
      normalized = Object.fromEntries(Object.keys(child).sort().map((name) => [name, canonicalSchema(child[name])]));
    } else if (SCHEMA_VALUES.has(key)) {
      normalized = canonicalSchema(child);
    } else if (SCHEMA_ARRAYS.has(key) && Array.isArray(child)) {
      // Keep order: JSON Pointer references can address an indexed subschema, even in allOf/anyOf.
      normalized = child.map(canonicalSchema);
    } else if (key === 'items') {
      normalized = Array.isArray(child) ? child.map(canonicalSchema) : canonicalSchema(child);
    } else if ((key === 'required' || key === 'type' || key === 'enum') && Array.isArray(child)) {
      normalized = sortedValues(child);
    } else if ((key === 'dependencies' || key === 'dependentRequired') && isObject(child)) {
      normalized = Object.fromEntries(Object.keys(child).sort().map((name) => {
        const dependency = child[name];
        return [name, Array.isArray(dependency) ? sortedValues(dependency) : canonicalSchema(dependency)];
      }));
    } else {
      normalized = canonicalData(child);
    }
    return [key, normalized];
  }));
}

function indexTools(tools: readonly AdvertisedTool[]): Map<string, AdvertisedTool> {
  const indexed = new Map<string, AdvertisedTool>();
  for (const tool of tools) {
    if (indexed.has(tool.name)) throw new Error('duplicate_tool');
    indexed.set(tool.name, tool);
  }
  return indexed;
}

/** Only the gateway's dependencies belong in the baseline; unrelated new T3 tools are harmless. */
export function snapshotContract(tools: readonly AdvertisedTool[]): Contract {
  const indexed = indexTools(tools);
  return Object.fromEntries([...REQUIRED_TOOLS].sort().flatMap((name) => {
    const tool = indexed.get(name);
    if (!tool) return [];
    return [[name, {
      inputSchema: canonicalSchema(tool.inputSchema) as Record<string, unknown>,
      ...(tool.outputSchema === undefined ? {} : { outputSchema: canonicalSchema(tool.outputSchema) as Record<string, unknown> }),
    }]];
  }));
}

function changedPaths(before: unknown, after: unknown, path: string, paths: string[]): void {
  if (paths.length >= 20 || JSON.stringify(before) === JSON.stringify(after)) return;
  // Arrays and literal values are one change; never turn const/enum data into displayed paths.
  if (!isObject(before) || !isObject(after) || path.endsWith('/const') || path.endsWith('/default') || path.length > 200) {
    paths.push(path.length > 240 ? `${path.slice(0, 237)}...` : path);
    return;
  }
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    changedPaths(before[key], after[key], `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, paths);
    if (paths.length >= 20) break;
  }
}

/** These are contract changes requiring inspection, not a claim that every change breaks the gateway. */
export function compareContracts(before: Contract, after: Contract): ContractChange[] {
  const changes: ContractChange[] = [];
  for (const tool of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (!Object.hasOwn(before, tool)) changes.push({ tool, kind: 'added', paths: [] });
    else if (!Object.hasOwn(after, tool)) changes.push({ tool, kind: 'removed', paths: [] });
    else {
      const paths: string[] = [];
      changedPaths(before[tool], after[tool], '', paths);
      if (paths.length) changes.push({ tool, kind: 'changed', paths });
    }
  }
  return changes;
}

const THREAD_ID = 'mcp:00000000-0000-4000-8000-000000000001';
const PROJECT_ID = 'mcp:00000000-0000-4000-8000-000000000002';
const REQUEST_ID = `runtime-request:provider:codex:provider-turn:${'x'.repeat(200)}`;
const CLIENT_REQUEST_ID = 't3fg-synthetic-compatibility';
const LAUNCH = {
  projectId: PROJECT_ID,
  title: 'Synthetic compatibility sample',
  workspaceStrategy: { type: 'worktree', baseRef: 'main', branch: 'fleet/synthetic', startFromOrigin: false },
  message: 'Synthetic compatibility sample; never sent.',
};

/** Sample requests, not exhaustive schema compatibility proof. None of these are sent to a host. */
const INPUT_SAMPLES: Record<(typeof REQUIRED_TOOLS)[number], Record<string, unknown>[]> = {
  t3_environment_read: [{}],
  t3_project_list: [{ limit: 100 }, { limit: 100, cursor: 100 }],
  t3_thread_launch: RUNTIME_MODE_VALUES.flatMap((runtimeMode) => [
    { ...LAUNCH, runtimeMode },
    { ...LAUNCH, runtimeMode, modelSelection: { instanceId: 'codex', model: 'synthetic-model' } },
  ]),
  t3_thread_read: ['messages', 'activity'].flatMap((view) => [
    { threadId: THREAD_ID, view },
    { threadId: THREAD_ID, view, afterPosition: 1, limit: 100, runLimit: 50, maxCharsPerItem: 50000 },
    { threadId: THREAD_ID, view, itemId: 'synthetic-item', textOffset: 1, limit: 1, maxCharsPerItem: 50000 },
  ]),
  t3_thread_list: [
    { projectId: PROJECT_ID, limit: 100 },
    { projectId: PROJECT_ID, titleContains: '[job:synthetic]', settled: false, limit: 100, cursor: 100 },
    { projectId: PROJECT_ID, settled: true, limit: 100 },
  ],
  t3_thread_search: [{ projectId: PROJECT_ID, query: 'synthetic', limit: 20 }],
  t3_thread_send: [{ threadId: THREAD_ID, message: 'Synthetic sample; never sent.', mode: 'auto', clientRequestId: CLIENT_REQUEST_ID }],
  t3_thread_interrupt: [
    { threadId: THREAD_ID, clientRequestId: CLIENT_REQUEST_ID },
    { threadId: THREAD_ID, clientRequestId: CLIENT_REQUEST_ID, reason: 'Synthetic sample; never sent.' },
  ],
  t3_pending_request_list: [{ threadId: THREAD_ID }],
  t3_pending_request_read: [{ threadId: THREAD_ID, requestId: REQUEST_ID }],
  t3_pending_request_respond: [{ threadId: THREAD_ID, requestId: REQUEST_ID, answers: { synthetic_question: { answers: ['blue'] } } }],
};

/** Ajv's bundled formats; reject unsupported formats before compilation, which otherwise logs raw names. */
const FORMATS = new Set([
  'date', 'time', 'date-time', 'iso-time', 'iso-date-time', 'duration', 'uri', 'uri-reference', 'uri-template',
  'url', 'email', 'hostname', 'ipv4', 'ipv6', 'regex', 'uuid', 'json-pointer', 'json-pointer-uri-fragment',
  'relative-json-pointer', 'byte', 'int32', 'int64', 'float', 'double', 'password', 'binary',
]);

// The SDK uses strict:false. Unknown keywords would otherwise be silently ignored and could falsely
// pass a request constrained by a future vocabulary. Preserve them in snapshots and report unverified.
const KEYWORDS = new Set([
  ...ANNOTATIONS, ...SCHEMA_MAPS, ...SCHEMA_VALUES, ...SCHEMA_ARRAYS,
  '$schema', '$id', '$ref', '$anchor', '$dynamicRef', '$dynamicAnchor', '$recursiveRef', '$recursiveAnchor',
  'type', 'const', 'enum', 'required', 'properties', 'dependencies', 'dependentRequired', 'items',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'pattern', 'format', 'minProperties', 'maxProperties',
  'minItems', 'maxItems', 'uniqueItems', 'minContains', 'maxContains',
  'default', 'deprecated', 'readOnly', 'writeOnly', 'contentEncoding', 'contentMediaType', 'nullable',
]);

function hasUnsupportedSchema(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (Object.keys(value).some((key) => !KEYWORDS.has(key))) return true;
  if (value.format !== undefined && (typeof value.format !== 'string' || !FORMATS.has(value.format))) return true;
  return Object.entries(value).some(([key, child]) => {
    if (SCHEMA_MAPS.has(key) || key === 'dependencies') return isObject(child) && Object.values(child).some(hasUnsupportedSchema);
    if (SCHEMA_VALUES.has(key)) return hasUnsupportedSchema(child);
    if (SCHEMA_ARRAYS.has(key) || key === 'items') {
      return Array.isArray(child) ? child.some(hasUnsupportedSchema) : hasUnsupportedSchema(child);
    }
    return false;
  });
}

export function checkInputs(tools: readonly AdvertisedTool[]): InputCheck[] {
  const indexed = indexTools(tools);
  return REQUIRED_TOOLS.map((name): InputCheck => {
    const tool = indexed.get(name);
    if (!tool) return { tool: name, status: 'fail', code: 'required_tool_missing' };
    try {
      if (hasUnsupportedSchema(tool.inputSchema)) return { tool: name, status: 'warn', code: 'input_schema_unsupported' };
      // A fresh validator prevents one tool's $id from silently selecting another tool's cached schema.
      const validate = new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
      const accepted = INPUT_SAMPLES[name].every((input) => validate(input).valid);
      return { tool: name, status: accepted ? 'pass' : 'fail', code: accepted ? 'sample_inputs_accepted' : 'sample_input_rejected' };
    } catch {
      // Compiler errors can embed schema values. Expose a fixed code, never that error text.
      return { tool: name, status: 'warn', code: 'input_schema_unsupported' };
    }
  });
}
