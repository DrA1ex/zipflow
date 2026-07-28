import { createLocalCompletion } from '../llm/client.js';
import { isLocalLlmEnabled } from '../llm/generate.js';
import { resolveLocalLlmSession } from '../llm/session.js';
import { requestAutonomyDecision } from '../autonomy/decision-engine.js';
import { updateSettings } from '../settings/store.js';
import { canonicalModelId, modelIdentityKey } from '../llm/model-identity.js';
import { loadLlmTokenStats } from '../llm/token-stats.js';

export async function testSelectedModel(controller, { fetchImpl = fetch, completionOptions = {} } = {}) {
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
  panel.modelTest = { status: 'running', running: true, startedAt, prompts: [] };
  const prompts = [];
  const capturePrompt = (label) => (prompt) => {
    prompts.push({
      id: `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${prompts.length + 1}`,
      label,
      provider: prompt.provider,
      model: prompt.model,
      structured: prompt.structured,
      maxTokens: prompt.maxTokens,
      reasoningEffort: prompt.reasoningEffort,
      messages: prompt.messages,
    });
    panel.modelTest.prompts = prompts;
    controller.invalidate();
  };
  state.settingsTestAbortController = { abort: () => operation.abort() };
  state.status = `Testing ${settings.llmModel}`;
  controller.invalidate();
  try {
    const session = await resolveLocalLlmSession(settings, { ...completionOptions, signal: operation.signal, fetchImpl });
    let streamSupported = false;
    const compatibilityMarker = 'ZIPFLOW_COMPATIBILITY_OK';
    const completion = await createLocalCompletion({
      provider: settings.llmProvider,
      model: session.profile.requestModel || settings.llmModel,
      loadedModel: Boolean(session.profile.loadedModel),
      messages: [
        {
          role: 'system',
          content: [
            'This is a small transport compatibility test for Zipflow.',
            `Reply with exactly this text and nothing else: ${compatibilityMarker}`,
          ].join('\n'),
        },
        { role: 'user', content: compatibilityMarker },
      ],
      maxTokens: 32,
      apiToken: session.apiToken,
      baseUrl: settings.llmBaseUrl,
      apiMode: settings.llmOpenAiApiMode,
      reasoningEffort: settings.llmReasoningEffort,
      contextLength: Math.min(session.profile.contextLength || 16_384, 16_384),
      reasoningOffSupported: session.profile.reasoningOffSupported,
    }, {
      ...completionOptions,
      signal: operation.signal,
      settings,
      fetchImpl,
      onEvent: (event) => { if (event.type === 'stream-open' || event.type === 'chunk') streamSupported = true; },
      onPrompt: capturePrompt('Transport compatibility prompt'),
    });
    const compatibilityText = String(completion.content || completion.reasoning || '').trim();
    if (!compatibilityText.includes(compatibilityMarker)) {
      const error = new Error('The model connection worked, but the compatibility marker was missing from its response.');
      error.code = 'compatibility_marker_missing';
      throw error;
    }
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
      fetchImpl,
      completionOptions: {
        ...completionOptions,
        onPrompt: capturePrompt('Autonomy protocol prompt'),
      },
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
      transportProtocol: true, autonomousDecisionProtocol: true, prompts,
    };
    state.status = `Model test passed · ${formatDuration(durationMs)}`;
    controller.toast('Model test passed', 'success', 3, `${streamSupported ? 'Streaming supported' : 'Response received'} · ${formatContext(session.profile.contextLength)}`);
    return true;
  } catch (error) {
    const cancelled = operation.signal.aborted || error?.name === 'AbortError' || ['ABORT_ERR', 'cancelled'].includes(error?.code);
    panel.modelTest = {
      status: cancelled ? 'cancelled' : 'failed', running: false, durationMs: Date.now() - startedAt,
      error: cancelled ? 'Compatibility test cancelled.' : error.message, code: error.code ?? null, prompts,
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
    if (state.settings.llmTrackTokenUsage === true) {
      try {
        panel.tokenStats = await loadLlmTokenStats();
        panel.tokenStatsError = null;
      } catch (error) {
        panel.tokenStatsError = error?.message ?? String(error);
      }
    }
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
