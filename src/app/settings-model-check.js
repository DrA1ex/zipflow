import { createLocalCompletion } from '../llm/client.js';
import { isLocalLlmEnabled, parseResponse } from '../llm/generate.js';
import { resolveLocalLlmSession } from '../llm/session.js';
import { requestAutonomyDecision } from '../autonomy/decision-engine.js';
import { updateSettings } from '../settings/store.js';
import { canonicalModelId, modelIdentityKey } from '../llm/model-identity.js';
import { llmTasks } from '../llm/tasks.js';

export async function testSelectedModel(controller) {
  const { state } = controller;
  const settings = state.settings;
  const panel = state.settingsPanel;
  if (!panel || panel.modelTest?.running) return false;
  if (!isLocalLlmEnabled(settings)) {
    panel.modelTest = { status: 'failed', error: 'Choose a provider and model first.' };
    controller.toast('Model test could not start', 'error', 3, panel.modelTest.error);
    return false;
  }
  const operation = controller.beginOperation({ kind: 'model-compatibility-test', label: 'Testing selected model' });
  const startedAt = Date.now();
  panel.modelTest = { status: 'running', running: true, startedAt };
  state.settingsTestAbortController = { abort: () => operation.abort() };
  state.status = `Testing ${settings.llmModel}`;
  controller.invalidate();
  try {
    const session = await resolveLocalLlmSession(settings, { signal: operation.signal });
    let streamSupported = false;
    const selectedTasks = llmTasks(settings);
    const protocolTasks = {
      archiveReview: selectedTasks.archiveReview,
      summary: selectedTasks.summary || (!selectedTasks.archiveReview && !selectedTasks.commitMessage),
      commitMessage: selectedTasks.commitMessage,
    };
    const completion = await createLocalCompletion({
      provider: settings.llmProvider,
      model: session.profile.requestModel || settings.llmModel,
      loadedModel: Boolean(session.profile.loadedModel),
      messages: [
        {
          role: 'system',
          content: [
            'This is a compatibility test for Zipflow. Return only the requested plain-text fields.',
            ...(protocolTasks.summary ? ['SUMMARY:', '- Model connection works.'] : []),
            ...(protocolTasks.commitMessage ? ['COMMIT MESSAGE:', 'Test local model compatibility'] : []),
            ...(protocolTasks.archiveReview ? ['ASSESSMENT:', 'suitable', 'CONFIDENCE:', 'high', 'REASONS:', '- Test response follows the Zipflow protocol.'] : []),
          ].join('\n'),
        },
        { role: 'user', content: 'Return the exact field structure now. Do not add Markdown fences.' },
      ],
      maxTokens: protocolTasks.archiveReview ? 160 : 96,
      apiToken: session.apiToken,
      contextLength: Math.min(session.profile.contextLength || 16_384, 16_384),
      reasoningOffSupported: session.profile.reasoningOffSupported,
    }, {
      signal: operation.signal,
      onEvent: (event) => { if (event.type === 'stream-open' || event.type === 'chunk') streamSupported = true; },
    });
    parseResponse(completion.content || completion.reasoning, {
      requireAssessment: protocolTasks.archiveReview,
      requireSummary: protocolTasks.summary,
      requireCommitMessage: protocolTasks.commitMessage,
    });
    const autonomousDecision = await requestAutonomyDecision({
      settings,
      mode: 'guarded',
      gate: 'compatibility-decision',
      context: {
        state: { compatibilityTest: true, projectFilesChanged: false },
        riskLevel: 'low',
        complete: true,
      },
      allowedActions: ['continue'],
      signal: operation.signal,
      onEvent: (event) => { if (event.type === 'stream-open' || event.type === 'chunk') streamSupported = true; },
    });
    if (autonomousDecision.action !== 'continue') throw new Error('Autonomous decision protocol returned an unexpected action.');
    const canonicalModel = canonicalModelId(settings.llmProvider, settings.llmModel);
    const compatibility = {
      provider: settings.llmProvider,
      model: canonicalModel,
      supported: true,
      testedAt: new Date().toISOString(),
      error: null,
    };
    state.settings = await updateSettings({
      llmProvider: settings.llmProvider,
      llmModel: canonicalModel,
      llmDecisionCompatibility: compatibility,
      llmDecisionCompatibilityByModel: {
        ...(state.settings.llmDecisionCompatibilityByModel ?? {}),
        [modelIdentityKey(settings.llmProvider, canonicalModel)]: compatibility,
      },
    }, { baseSettings: state.settings });
    const durationMs = Date.now() - startedAt;
    panel.modelTest = {
      status: 'passed', running: false, durationMs, streamSupported,
      provider: settings.llmProvider, model: settings.llmModel,
      contextLength: session.profile.contextLength,
      maxContextLength: session.profile.maxContextLength,
      contextSource: session.profile.source,
      reviewProtocol: protocolTasks.archiveReview, autonomousDecisionProtocol: true,
    };
    state.status = `Model test passed · ${formatDuration(durationMs)}`;
    controller.toast('Model test passed', 'success', 3, `${streamSupported ? 'Streaming supported' : 'Response received'} · ${formatContext(session.profile.contextLength)}`);
    return true;
  } catch (error) {
    const cancelled = operation.signal.aborted || error?.name === 'AbortError' || ['ABORT_ERR', 'cancelled'].includes(error?.code);
    panel.modelTest = {
      status: cancelled ? 'cancelled' : 'failed', running: false, durationMs: Date.now() - startedAt,
      error: cancelled ? 'Compatibility test cancelled.' : error.message, code: error.code ?? null,
    };
    if (!cancelled) {
      const canonicalModel = canonicalModelId(settings.llmProvider, settings.llmModel);
      const compatibility = {
        provider: settings.llmProvider,
        model: canonicalModel,
        supported: false,
        testedAt: new Date().toISOString(),
        error: error.message,
      };
      state.settings = await updateSettings({
        llmProvider: settings.llmProvider,
        llmModel: canonicalModel,
        llmDecisionCompatibility: compatibility,
        llmDecisionCompatibilityByModel: {
          ...(state.settings.llmDecisionCompatibilityByModel ?? {}),
          [modelIdentityKey(settings.llmProvider, canonicalModel)]: compatibility,
        },
      }, { baseSettings: state.settings });
    }
    state.status = cancelled ? 'Model test cancelled' : 'Model test failed';
    controller.toast(cancelled ? 'Model test cancelled' : 'Model test failed', cancelled ? 'info' : 'error', 3, panel.modelTest.error);
    return false;
  } finally {
    state.settingsTestAbortController = null;
    operation.finish();
    controller.invalidate();
  }
}

export function modelTestValue(panel) {
  const test = panel?.modelTest;
  if (!test) return 'Not tested';
  if (test.running) return 'Testing…';
  if (test.status === 'passed') return `Passed · ${formatDuration(test.durationMs)}`;
  if (test.status === 'cancelled') return 'Cancelled';
  return 'Failed';
}

export function modelTestDescription(panel) {
  const test = panel?.modelTest;
  if (!test) return 'Check server access, authentication, exact model key, streaming, response parsing, and reported context.';
  if (test.running) return 'Sending a small safe compatibility request. Esc cancels the test.';
  if (test.status === 'failed' || test.status === 'cancelled') return test.error;
  return `${test.streamSupported ? 'Streaming supported' : 'Text response received'} · Zipflow and autonomous decision protocols passed · reported context ${formatContext(test.contextLength)}${test.contextSource ? ` · ${test.contextSource}` : ''}.`;
}

function formatDuration(milliseconds) {
  return `${(Math.max(0, milliseconds) / 1000).toFixed(1)}s`;
}

function formatContext(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number.toLocaleString('en-US') : 'unknown context';
}
