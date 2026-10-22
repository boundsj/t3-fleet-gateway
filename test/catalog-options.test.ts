import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizeCapabilities, MAX_CHOICES_PER_OPTION, MAX_OPTIONS_PER_MODEL } from '../src/hosts/catalog.ts';
import { createLogger } from '../src/log.ts';
import { capabilitiesSchema, optionDescriptorSchema } from '../src/t3/schemas.ts';

const catalog = (models: unknown[]) => capabilitiesSchema.parse({
  providers: [{ providerInstanceId: 'provider-a', driverKind: 'synthetic', models }],
});

test('the former descriptor rejects the compact shape that normalization accepts', () => {
  const compact = { id: 'effort', values: ['low', 'high'], default: 'low' };
  const result = optionDescriptorSchema.safeParse(compact);
  assert.equal(result.success, false);
  if (!result.success) assert.deepEqual(result.error.issues.map((issue) => issue.path), [['label'], ['type']]);
  const [model] = sanitizeCapabilities('host-a', catalog([{ id: 'model-a', options: [compact] }]))[0]!.models;
  assert.deepEqual(model!.options[0], {
    id: 'effort', label: 'effort', type: 'select', description: null, currentValue: 'low',
    choices: [
      { id: 'low', label: 'low', description: null, isDefault: true },
      { id: 'high', label: 'high', description: null, isDefault: false },
    ],
  });
});

test('malformed models and options are isolated; missing and unknown types are inferred', () => {
  const logs: string[] = [];
  const providers = sanitizeCapabilities('host-a', catalog([
    null, { label: 'bad model' },
    { id: 'model-a', options: [
      null, { id: 'bad-option', values: [1] }, { id: 'untyped' },
      { id: 'effort', name: 'Effort', type: 'new-select', choices: [{ id: 'high' }] },
      { id: 'fast', default: false },
      { id: 'restricted', values: [true] },
    ] },
    { id: 'model-b' },
  ]), createLogger({ sink: (line) => logs.push(line) }));
  assert.deepEqual(providers[0]!.models.map((model) => model.id), ['model-a', 'model-b']);
  assert.deepEqual(providers[0]!.models[0]!.options.map((option) => [option.id, option.label, option.type]), [
    ['effort', 'Effort', 'select'], ['fast', 'fast', 'boolean'],
  ]);
  assert.deepEqual(logs.map((line) => JSON.parse(line).event), ['catalog.model_skipped', 'catalog.model_skipped', 'catalog.options_skipped']);
  assert.ok(!logs.join('').includes('bad-option'));
});

test('raw compact and malformed collections still enforce catalog limits', () => {
  for (const options of [
    Array.from({ length: MAX_OPTIONS_PER_MODEL + 1 }, () => null),
    [{ id: 'effort', values: Array(MAX_CHOICES_PER_OPTION + 1).fill('high') }],
    [{ id: 'effort', choices: Array(MAX_CHOICES_PER_OPTION + 1).fill(null) }],
  ]) {
    assert.throws(() => sanitizeCapabilities('host-a', catalog([{ id: 'model-a', options }])), { code: 'catalog_limit' });
  }
});
