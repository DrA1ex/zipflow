import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ActionRegistry,
  SEMANTIC_ACTION_DEFINITIONS,
  SEMANTIC_ACTION_IDS,
  SEMANTIC_ACTION_KINDS,
  inferSurfaceKind,
  projectSurface,
} from '../src/application/index.js';
import {
  ACTION_CONFIRMATIONS,
  ACTION_PRESENTATION_ROLES,
  ACTION_RISKS,
  SECTION_KINDS,
  SURFACE_KINDS,
  assertProtocolValue,
  getConformanceFixtureBundle,
} from '../src/protocol/index.js';

function errorCode(code) {
  return (error) => {
    assert.equal(error.name, 'ZipflowApiError');
    assert.equal(error.code, code);
    return true;
  };
}

function projected(kind, extra = {}) {
  return projectSurface({
    surfaceKind: kind,
    revision: 7,
    project: { id: 'project-1', name: 'Fixture project' },
    run: { id: 'run-1', status: 'waiting_action', backupAvailable: true },
    operation: { settlement: 'active', cancellable: true },
    workflow: { deployment: { configured: true, label: 'Production' } },
    rollback: { backupAvailable: true },
    ...extra,
  });
}

test('semantic actions have stable unique ids and kinds and cover protocol policy enums', () => {
  assert.equal(new Set(SEMANTIC_ACTION_IDS).size, SEMANTIC_ACTION_IDS.length);
  assert.equal(new Set(SEMANTIC_ACTION_KINDS).size, SEMANTIC_ACTION_KINDS.length);
  assert.deepEqual(
    new Set(SEMANTIC_ACTION_DEFINITIONS.map(({ risk }) => risk)),
    new Set(ACTION_RISKS),
  );
  assert.deepEqual(
    new Set(SEMANTIC_ACTION_DEFINITIONS.map(({ confirmation }) => confirmation)),
    new Set(ACTION_CONFIRMATIONS),
  );
  assert.deepEqual(
    new Set(SEMANTIC_ACTION_DEFINITIONS.map(({ presentation }) => presentation.role)),
    new Set(ACTION_PRESENTATION_ROLES),
  );
  for (const definition of SEMANTIC_ACTION_DEFINITIONS) {
    assert.match(definition.id, /^[a-z][a-z0-9-]*$/);
    assert.match(definition.kind, /^[a-z][a-z0-9_]*$/);
    assert.equal(Object.isFrozen(definition), true);
  }
});

test('action registry validates advertised JSON Schema input before dispatch', async () => {
  const calls = [];
  const registry = new ActionRegistry({
    handlers: {
      'resolve-conflict': async (request) => {
        calls.push(request);
        return { accepted: request.input.decision };
      },
    },
  });
  const surface = projectSurface({
    surfaceKind: 'conflict_file',
    revision: 11,
    plan: { conflicts: [{ path: 'src/a.js' }], currentConflict: { path: 'src/a.js' } },
  }, { actionRegistry: registry });

  const result = await registry.dispatch({
    surface,
    actionId: 'resolve-conflict',
    expectedRevision: 11,
    input: { path: 'src/a.js', decision: 'keep' },
    context: { requestId: 'request-1' },
  });

  assert.deepEqual(result, { accepted: 'keep' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, { path: 'src/a.js', decision: 'keep' });
  assert.deepEqual(calls[0].context, { requestId: 'request-1' });
});

test('project-specific workflow fields use the JSON Schema advertised by the surface', async () => {
  let calls = 0;
  const registry = new ActionRegistry({
    handlers: {
      'save-workflow': ({ input }) => {
        calls += 1;
        return input;
      },
    },
  });
  const inputSchema = {
    type: 'object',
    required: ['releaseChannel'],
    additionalProperties: false,
    properties: {
      releaseChannel: { type: 'string', enum: ['preview', 'stable'] },
    },
  };
  const surface = projectSurface({
    surfaceKind: 'workflow_setup',
    revision: 12,
    workflow: { configured: false, inputSchema },
  }, { actionRegistry: registry });

  assert.deepEqual(surface.actions[0].inputSchema, inputSchema);
  await assert.rejects(registry.dispatch({
    surface,
    actionId: 'save-workflow',
    expectedRevision: 12,
    input: { releaseChannel: 'nightly' },
  }), errorCode('ACTION_INPUT_INVALID'));
  assert.equal(calls, 0);

  assert.deepEqual(await registry.dispatch({
    surface,
    actionId: 'save-workflow',
    expectedRevision: 12,
    input: { releaseChannel: 'stable' },
  }), { releaseChannel: 'stable' });
  assert.equal(calls, 1);
});

test('stale, unavailable, disabled, unhandled, and invalid actions fail closed', async () => {
  let calls = 0;
  const registry = new ActionRegistry({
    handlers: {
      'resolve-conflict': () => { calls += 1; },
      'approve-plan': () => { calls += 1; },
      finish: () => { calls += 1; },
    },
  });
  const surface = projectSurface({
    surfaceKind: 'conflict_summary',
    revision: 4,
    plan: { conflicts: [{ path: 'src/a.js' }], unresolvedConflicts: 1 },
  }, { actionRegistry: registry });

  await assert.rejects(registry.dispatch({
    surface,
    actionId: 'resolve-conflict',
    expectedRevision: 3,
    input: { path: 'src/a.js', decision: 'keep' },
  }), errorCode('STALE_REVISION'));

  await assert.rejects(registry.dispatch({
    surface,
    actionId: 'finish',
    expectedRevision: 4,
  }), errorCode('ACTION_NOT_AVAILABLE'));

  await assert.rejects(registry.dispatch({
    surface,
    actionId: 'approve-plan',
    expectedRevision: 4,
  }), errorCode('ACTION_NOT_AVAILABLE'));

  await assert.rejects(registry.dispatch({
    surface,
    actionId: 'resolve-conflict',
    expectedRevision: 4,
    input: { path: 'src/a.js', decision: 'merge' },
  }), errorCode('ACTION_INPUT_INVALID'));

  const unhandledSurface = projected('commit_message');
  await assert.rejects(new ActionRegistry().dispatch({
    surface: unhandledSurface,
    actionId: 'commit',
    expectedRevision: 7,
    input: { message: 'Update files' },
  }), errorCode('ACTION_NOT_AVAILABLE'));

  const finishSurface = projected('completed');
  await assert.rejects(registry.dispatch({
    surface: finishSurface,
    actionId: 'finish',
    expectedRevision: 7,
    input: { clientOnlySearch: 'not allowed' },
  }), errorCode('ACTION_INPUT_INVALID'));

  const forged = structuredClone(surface);
  forged.actions[0].kind = 'forged_action_kind';
  await assert.rejects(registry.dispatch({
    surface: forged,
    actionId: 'resolve-conflict',
    expectedRevision: 4,
    input: { path: 'src/a.js', decision: 'keep' },
  }), errorCode('ACTION_NOT_AVAILABLE'));

  const duplicated = structuredClone(surface);
  duplicated.actions.push(structuredClone(duplicated.actions[0]));
  await assert.rejects(registry.dispatch({
    surface: duplicated,
    actionId: 'resolve-conflict',
    expectedRevision: 4,
    input: { path: 'src/a.js', decision: 'keep' },
  }), errorCode('ACTION_NOT_AVAILABLE'));

  const contradictory = projected('completed');
  contradictory.actions.find(({ id }) => id === 'finish').disabledReason = 'Disabled by current state.';
  await assert.rejects(registry.dispatch({
    surface: contradictory,
    actionId: 'finish',
    expectedRevision: 7,
  }), errorCode('ACTION_NOT_AVAILABLE'));

  assert.throws(
    () => registry.advertise(['finish', 'finish']),
    /cannot advertise a semantic action more than once/,
  );

  assert.equal(calls, 0);
});

test('surface projector emits every protocol surface and section kind conformantly', () => {
  const surfaces = SURFACE_KINDS.map((kind) => projected(kind));
  for (const surface of surfaces) assertProtocolValue('surface', surface);

  assert.deepEqual(new Set(surfaces.map(({ kind }) => kind)), new Set(SURFACE_KINDS));
  assert.deepEqual(
    new Set(surfaces.flatMap(({ sections }) => sections.map(({ kind }) => kind))),
    new Set(SECTION_KINDS),
  );
  assert.deepEqual(
    new Set(surfaces.flatMap(({ actions }) => actions.map(({ risk }) => risk))),
    new Set(ACTION_RISKS),
  );
  assert.deepEqual(
    new Set(surfaces.flatMap(({ actions }) => actions.map(({ confirmation }) => confirmation))),
    new Set(ACTION_CONFIRMATIONS),
  );

  const conformance = getConformanceFixtureBundle();
  conformance.surfaces = surfaces;
  assert.equal(assertProtocolValue('conformance', conformance), conformance);
});

test('surface kind inference projects project, workflow, run, operation, plan, check, and history states', () => {
  const cases = [
    [{ project: { id: 'p1' } }, 'project_home'],
    [{ workflow: { configured: false } }, 'workflow_setup'],
    [{ run: { status: 'inspecting' }, operation: { settlement: 'active' } }, 'archive_inspecting'],
    [{ archiveRootChoices: [{ id: 'root' }] }, 'archive_root_choice'],
    [{ archiveSafety: { warnings: ['Unsafe link'] } }, 'archive_safety'],
    [{ plan: { files: [] } }, 'plan_review'],
    [{ plan: { view: 'files', files: [] } }, 'plan_files'],
    [{ plan: { conflicts: [{ path: 'a.js' }] } }, 'conflict_summary'],
    [{ plan: { currentConflict: { path: 'a.js' } } }, 'conflict_file'],
    [{ operation: { settlement: 'active', kind: 'apply' } }, 'operation_progress'],
    [{ run: { status: 'failed' }, checks: { status: 'failed' } }, 'checks_failed'],
    [{ operation: { settlement: 'active', kind: 'apply' }, plan: { files: [] } }, 'operation_progress'],
    [{ run: { status: 'waiting_action', attention: 'commit' } }, 'commit_choice'],
    [{ run: { status: 'waiting_action', attention: 'commit_message' } }, 'commit_message'],
    [{ run: { status: 'waiting_action', attention: 'deploy' } }, 'deploy_choice'],
    [{ run: { status: 'completed' } }, 'completed'],
    [{ history: { open: true, runs: [] } }, 'history'],
    [{ history: { selectedRun: { id: 'run-1' } } }, 'run_details'],
    [{ rollback: { pending: true } }, 'rollback_confirm'],
    [{ error: { code: 'FAIL', message: 'failed' } }, 'error'],
  ];

  for (const [snapshot, expected] of cases) {
    assert.equal(inferSurfaceKind(snapshot), expected);
    assert.equal(projectSurface(snapshot).kind, expected);
  }
  assert.throws(() => inferSurfaceKind({ surfaceKind: 'terminal_menu' }), /Unknown surface kind/);
});

test('projection strips terminal escapes, bounds large data, and ignores client navigation state', () => {
  const files = Array.from({ length: 105 }, (_, index) => ({
    id: `file-${index}`,
    path: `\u001b[31msrc/file-${index}.js\u001b[0m`,
  }));
  const surface = projectSurface({
    surfaceKind: 'plan_files',
    revision: 2,
    surfaceTitle: '\u001b[32mReview files\u001b[0m',
    plan: { view: 'files', files },
    selectedIndex: 99,
    focus: 'secret-focus',
    searchQuery: 'secret-query',
    scroll: 'secret-scroll',
    pointer: 'secret-pointer',
    viewport: 'secret-viewport',
  });
  const serialized = JSON.stringify(surface);
  const details = surface.sections.find(({ kind }) => kind === 'file_details');

  assert.equal(surface.title, 'Review files');
  assert.equal(details.files.length, 100);
  assert.equal(details.truncated, true);
  assert.doesNotMatch(serialized, /\u001b|secret-focus|secret-query|secret-scroll|secret-pointer|secret-viewport/);
  assert.equal(Object.hasOwn(surface, 'selectedIndex'), false);
  assert.equal(surface.links.plan, undefined);
});

test('client-only navigation remains links and is never advertised as an action', () => {
  const surface = projectSurface({
    surfaceKind: 'project_home',
    project: { id: 'project/one' },
    run: { id: 'run/one' },
  });
  assert.deepEqual(surface.actions, []);
  assert.equal(surface.links.workflow, '/v1/projects/project%2Fone/workflow');
  assert.equal(surface.links.history, '/v1/projects/project%2Fone/history');
  assert.equal(surface.links.plan, '/v1/runs/run%2Fone/plan');
  assert.equal(surface.links.report, '/v1/runs/run%2Fone/report');
  assert.equal(SEMANTIC_ACTION_IDS.some((id) => /^view-|^configure-/.test(id)), false);
});

test('application projection modules do not depend on TUI or controller owners', async () => {
  const sources = await Promise.all([
    '../src/application/action-definitions.js',
    '../src/application/action-registry.js',
    '../src/application/surface-templates.js',
    '../src/application/surface-projector.js',
  ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
  const source = sources.join('\n');
  assert.doesNotMatch(source, /terlio|\.\.\/app\/|controller\.js|selectedIndex|searchQuery|viewport|pointerMode/i);
  assert.doesNotMatch(source, /arbitrary.{0,20}command/i);
});
