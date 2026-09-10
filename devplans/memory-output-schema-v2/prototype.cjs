// Offline design experiment only. No runtime imports this module; no API/DB calls.
// Run: node devplans/memory-output-schema-v2/prototype.cjs --write
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildOutputSchema } = require('../../modules/memory/infrastructure/providers/outputSchema');
const { bindOutputSchema } = require('../../modules/memory/infrastructure/providers/bindOutputSchema');
const { compileDeepSeekSchema, compileDeepSeekToolParameters } = require('../../modules/memory/infrastructure/providers/deepSeekSchemaCompiler');
const { validateLocalJsonSchema } = require('../../modules/memory/infrastructure/providers/localJsonSchemaValidator');
const { flatWireToSemanticOutput } = require('../../modules/memory/infrastructure/providers/flatWireProtocol');
const { validateSemanticResult } = require('../../modules/memory/contracts/semantic');
const { testWriteLimits } = require('../../test/memory/support/memory-builders');

const task = { tickId: 0, proposer: 'todoProposer', targetKey: 'todos', targetSections: ['todos'], writeLimits: testWriteLimits() };
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const strEnum = (...values) => ({ type: 'string', enum: values });
const union = (...anyOf) => ({ anyOf });
const mode = (name, properties = {}) => obj({ mode: strEnum(name), ...properties });
const patch = (value) => union(mode('keep'), mode('set', { value }));
const bytes = value => Buffer.byteLength(JSON.stringify(value));

function bound(targetCount, messageCount, memoryCount = 0) {
  return bindOutputSchema(buildOutputSchema('todoProposer'), {
    publicInput: { task },
    messageMeta: Object.fromEntries(Array.from({ length: messageCount }, (_, i) => [101 + i, {}])),
    refMap: {
      writable: Object.fromEntries(Array.from({ length: targetCount }, (_, i) => [`T${i + 1}`, { section: 'todos' }])),
      readOnly: Object.fromEntries(Array.from({ length: memoryCount }, (_, i) => [`T1-E${i + 1}`, {}])),
    },
  });
}

function candidate(source, { explicitEdits = true, groupedResults = true } = {}) {
  const p = source.schema.properties.changes.items.properties;
  function due(adding) {
    const cases = adding ? [mode('none')] : [mode('keep'), mode('clear')];
    cases.push(mode('absolute', { date: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' } }));
    if (p.anchorSource) {
      for (const name of ['relativeDays', 'relativeMonths', 'relativeYears']) {
        cases.push(mode(name, { offset: { type: 'integer', minimum: name === 'relativeDays' ? 0 : 1, maximum: Number.MAX_SAFE_INTEGER }, anchorSource: p.anchorSource }));
      }
      cases.push(mode('dayOfMonth', { day: { type: 'integer', minimum: 1, maximum: 31 }, anchorSource: p.anchorSource }));
    }
    return union(...cases);
  }
  const section = groupedResults ? {} : { section: p.section };
  const common = { ...section, sources: p.sources };
  const variants = [obj({ action: strEnum('add'), ...common, text: p.text, actor: p.actor, requester: p.requester, due: due(true) })];
  if (p.target) {
    const editProperties = { action: strEnum('revise', 'correct'), ...common, target: p.target,
      text: explicitEdits ? patch(p.text) : p.text,
      actor: explicitEdits ? patch(p.actor) : p.actor,
      requester: explicitEdits ? patch(p.requester) : p.requester,
      due: due(false),
    };
    variants.push(obj(editProperties, explicitEdits ? Object.keys(editProperties) : Object.keys(editProperties).filter(key => !['text', 'actor', 'requester'].includes(key))));
    variants.push(obj({ action: strEnum('forget', 'complete', 'cancel', 'expire'), ...common, target: p.target }));
  }
  const changes = { type: 'array', items: union(...variants) };
  if (!groupedResults) return obj({ sectionStatuses: source.schema.properties.sectionStatuses, changes });
  const results = [obj({ status: strEnum('noop') }), obj({ status: strEnum('unable_to_decide') })];
  // With no source there can be no supported change. Avoid relying on maxItems: 0.
  if (p.sources.items.enum?.length) results.push(obj({ status: strEnum('changes'), changes: { ...changes, minItems: 1 } }));
  return obj({ results: obj({ todos: union(...results) }) });
}

// Standard $defs for the draft, followed by a separate experimental DeepSeek
// dialect mapping. The official guide spells its definition container "$def".
function shareDefinitions(schema) {
  const counts = new Map();
  function children(node, visit) {
    return { ...node,
      ...(node.properties ? { properties: Object.fromEntries(Object.entries(node.properties).map(([key, value]) => [key, visit(value)])) } : {}),
      ...(node.items ? { items: visit(node.items) } : {}),
      ...(node.anyOf ? { anyOf: node.anyOf.map(visit) } : {}),
    };
  }
  function count(node) {
    const key = JSON.stringify(node);
    counts.set(key, (counts.get(key) || 0) + 1);
    children(node, count);
    return node;
  }
  count(schema);
  const names = new Map();
  const definitions = {};
  function visit(node) {
    const key = JSON.stringify(node);
    if (counts.get(key) > 1 && bytes(node) >= 160) {
      if (!names.has(key)) {
        const name = `s${names.size + 1}`;
        names.set(key, name);
        definitions[name] = children(node, visit);
      }
      return { $ref: `#/$defs/${names.get(key)}` };
    }
    return children(node, visit);
  }
  const root = children(schema, visit);
  return Object.keys(definitions).length ? { ...root, $defs: definitions } : root;
}

function expandReferences(schema) {
  function visit(node, stack = []) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(child => visit(child, stack));
    if (node.$ref) {
      assert.ok(!stack.includes(node.$ref), 'prototype definitions must not recurse');
      const name = node.$ref.replace('#/$defs/', '');
      assert.ok(schema.$defs?.[name], `unresolved ${node.$ref}`);
      return visit(schema.$defs[name], [...stack, node.$ref]);
    }
    return Object.fromEntries(Object.entries(node).filter(([key]) => key !== '$defs').map(([key, child]) => [key, visit(child, stack)]));
  }
  return visit(schema);
}

function toDeepSeekDefinitions(schema) {
  if (Array.isArray(schema)) return schema.map(toDeepSeekDefinitions);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key === '$defs' ? '$def' : key,
    key === '$ref' ? value.replace('#/$defs/', '#/$def/') : toDeepSeekDefinitions(value)]));
}

function toV2(flat) {
  const status = flat.sectionStatuses.todos;
  if (status !== 'changes') return { results: { todos: { status } } };
  const changes = flat.changes.map(change => {
    const base = { action: change.action, sources: change.sources };
    if (change.target !== undefined) base.target = change.target;
    if (!['add', 'revise', 'correct'].includes(change.action)) return base;
    for (const field of ['text', 'actor', 'requester']) {
      base[field] = change.action === 'add' ? change[field] : change[field] === undefined ? { mode: 'keep' } : { mode: 'set', value: change[field] };
    }
    const name = change.dueMode || 'none';
    base.due = { mode: name };
    if (name === 'absolute') base.due.date = change.dueValue;
    else if (name === 'dayOfMonth') base.due.day = Number(change.dueValue);
    else if (name.startsWith('relative')) base.due.offset = Number(change.dueValue);
    if (change.anchorSource !== undefined) base.due.anchorSource = change.anchorSource;
    return base;
  });
  return { results: { todos: { status, changes } } };
}

function fromV2(value) {
  const { status, changes = [] } = value.results.todos;
  return { sectionStatuses: { todos: status }, changes: changes.map(change => {
    const out = { section: 'todos', action: change.action, sources: change.sources };
    if (change.target !== undefined) out.target = change.target;
    if (!['add', 'revise', 'correct'].includes(change.action)) return out;
    for (const field of ['text', 'actor', 'requester']) {
      if (change.action === 'add') out[field] = change[field];
      else if (change[field].mode === 'set') out[field] = change[field].value;
    }
    const due = change.due;
    if (due.mode !== 'none') out.dueMode = due.mode;
    if (due.mode === 'absolute') out.dueValue = due.date;
    else if (due.mode === 'dayOfMonth') out.dueValue = String(due.day);
    else if (due.mode.startsWith('relative')) out.dueValue = String(due.offset);
    if (due.anchorSource !== undefined) out.anchorSource = due.anchorSource;
    return out;
  }) };
}

function fixtures() {
  const base = { section: 'todos', sources: ['message:101'] };
  const dates = [
    { dueMode: 'absolute', dueValue: '2026-09-11' },
    ...['relativeDays', 'relativeMonths', 'relativeYears', 'dayOfMonth'].map(dueMode => ({ dueMode, dueValue: '1', anchorSource: 'message:101' })),
  ];
  const changes = [{}, ...dates].map(date => ({ ...base, action: 'add', text: '归还图书', actor: 'user', requester: 'user', ...date }));
  for (const action of ['revise', 'correct']) {
    for (const date of [{ dueMode: 'keep' }, { dueMode: 'clear' }, ...dates]) {
      for (let mask = 0; mask < 8; mask++) changes.push({ ...base, action, target: 'T1', ...date,
        ...(mask & 1 ? { text: '归还图书' } : {}), ...(mask & 2 ? { actor: 'both' } : {}), ...(mask & 4 ? { requester: 'assistant' } : {}),
      });
    }
  }
  for (const action of ['forget', 'complete', 'cancel', 'expire']) changes.push({ ...base, action, target: 'T1' });
  return [
    ...['noop', 'unable_to_decide'].map(status => ({ sectionStatuses: { todos: status }, changes: [] })),
    ...changes.map(change => ({ sectionStatuses: { todos: 'changes' }, changes: [change] })),
  ];
}

function run() {
  const rows = [];
  const scenarios = [['one_target', 1, 1, 0], ['representative', 10, 20, 10], ['large_selectors', 100, 200, 100], ['no_target', 0, 1, 0], ['memory_only', 1, 0, 1]];
  for (const [scenario, targetCount, messageCount, memoryCount] of scenarios) {
    const source = bound(targetCount, messageCount, memoryCount);
    const current = compileDeepSeekToolParameters(source);
    const draft = compileDeepSeekSchema(candidate(source));
    const sharedCurrent = shareDefinitions(current);
    const sharedDraft = shareDefinitions(draft);
    assert.deepEqual(expandReferences(sharedCurrent), current);
    assert.deepEqual(expandReferences(sharedDraft), draft);
    rows.push({ scenario,
      oldGeneric: bytes(compileDeepSeekSchema(source.schema)),
      currentFlat: bytes(current),
      currentWithRefs: bytes(toDeepSeekDefinitions(sharedCurrent)),
      nestedDateOptionalEdits: bytes(compileDeepSeekSchema(candidate(source, { explicitEdits: false, groupedResults: false }))),
      nestedDateExplicitEdits: bytes(compileDeepSeekSchema(candidate(source, { groupedResults: false }))),
      groupedV2: bytes(draft), groupedV2WithRefs: bytes(toDeepSeekDefinitions(sharedDraft)),
    });
  }
  const source = bound(1, 1);
  const full = candidate(source);
  const wire = compileDeepSeekSchema(full);
  const samples = fixtures();
  for (const flat of samples) {
    const v2 = toV2(flat);
    assert.deepEqual(validateLocalJsonSchema(full, v2), { ok: true, errors: [] });
    const restored = fromV2(v2);
    assert.deepEqual(restored, flat);
    assert.deepEqual(validateSemanticResult(flatWireToSemanticOutput(restored, task), task), { ok: true, errors: [] });
    assert.equal(validateLocalJsonSchema(wire, v2).ok, true);
  }
  const edit = toV2(samples.find(sample => sample.changes[0]?.action === 'revise' && sample.changes[0]?.dueMode === 'relativeDays'));
  const invalid = [];
  function mutation(label, fn) {
    const copy = structuredClone(edit);
    fn(copy.results.todos.changes[0], copy.results.todos);
    invalid.push({ label, value: copy });
  }
  mutation('missing_target', change => { delete change.target; });
  mutation('unknown_target', change => { change.target = 'T999'; });
  mutation('missing_anchor', change => { delete change.due.anchorSource; });
  mutation('offset_string', change => { change.due.offset = '1'; });
  mutation('offset_negative', change => { change.due.offset = -1; });
  mutation('day_out_of_range', change => { change.due = { mode: 'dayOfMonth', day: 32, anchorSource: 'message:101' }; });
  mutation('set_missing_value', change => { change.text = { mode: 'set' }; });
  mutation('keep_with_value', change => { change.text = { mode: 'keep', value: '覆盖旧文本' }; });
  mutation('invalid_actor', change => { change.actor = { mode: 'set', value: 'anyone' }; });
  mutation('invalid_source', change => { change.sources = ['message:999']; });
  mutation('terminal_with_edits', change => { change.action = 'complete'; });
  mutation('noop_with_changes', (_, result) => { result.status = 'noop'; });
  for (const { label, value } of invalid) assert.equal(validateLocalJsonSchema(wire, value).ok, false, label);
  const empty = { results: { todos: { status: 'changes', changes: [] } } };
  assert.equal(validateLocalJsonSchema(full, empty).ok, false);
  assert.equal(validateLocalJsonSchema(wire, empty).ok, true, 'minItems remains a local constraint');
  const noEvidence = compileDeepSeekSchema(candidate(bound(1, 0, 0)));
  assert.equal(validateLocalJsonSchema(noEvidence, edit).ok, false);
  assert.equal(validateLocalJsonSchema(noEvidence, { results: { todos: { status: 'unable_to_decide' } } }).ok, true);
  const noMessages = compileDeepSeekSchema(candidate(bound(1, 0, 1)));
  const anchoredMemoryOnly = structuredClone(edit);
  anchoredMemoryOnly.results.todos.changes[0].sources = ['memory:T1-E1'];
  assert.equal(validateLocalJsonSchema(noMessages, anchoredMemoryOnly).ok, false);
  const report = { note: 'Offline UTF-8 compact JSON bytes, not measured API tokens. Refs and new shapes are not API-tested.',
    rows, validation: { roundTrips: samples.length, rejectedStructuralCases: invalid.length, localConstraintBoundaryVerified: true, unavailableBranchesVerified: true },
    representativeOutput: { currentFlatBytes: bytes(fromV2(edit)), groupedV2Bytes: bytes(edit) },
  };
  if (process.argv.includes('--write')) {
    const files = { 'measurements.json': report, 'todo-v2.schema.json': full, 'todo-v2.deepseek.schema.json': wire,
      'todo-v2.deepseek-shared.schema.json': toDeepSeekDefinitions(shareDefinitions(wire)), 'example-v2.json': edit };
    for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(__dirname, name), JSON.stringify(value, null, 2) + '\n');
  }
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) run();
module.exports = { candidate, shareDefinitions, expandReferences, toV2, fromV2 };
