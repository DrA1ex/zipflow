import { ByteChunkCollector } from '../utils/byte-buffer.js';
import { LocalLlmError } from './errors.js';
import { outputLimitError } from './stream-limits.js';

export function appendChunk(result, contentDelta, reasoningDelta, onEvent) {
  if (!contentDelta && !reasoningDelta) return;
  const contentBytes = Buffer.byteLength(contentDelta);
  const reasoningBytes = Buffer.byteLength(reasoningDelta);
  if (result.contentBytes + contentBytes > result.limits.maxAnswerBytes) {
    throw outputLimitError('answer', result.limits.maxAnswerBytes, result.contentBytes + contentBytes, result.provider);
  }
  if (result.reasoningBytes + reasoningBytes > result.limits.maxReasoningBytes) {
    throw outputLimitError('reasoning', result.limits.maxReasoningBytes, result.reasoningBytes + reasoningBytes, result.provider);
  }
  if (contentDelta) {
    result.contentCollector.append(contentDelta);
    result.contentBytes += contentBytes;
  }
  if (reasoningDelta) {
    result.reasoningCollector.append(reasoningDelta);
    result.reasoningBytes += reasoningBytes;
  }
  result.chunks += 1;
  onEvent({
    type: 'chunk', contentDelta, reasoningDelta,
    contentBytes: result.contentBytes, reasoningBytes: result.reasoningBytes,
    finishReason: result.finishReason, chunks: result.chunks,
  });
}

export function emptyCompletion(limits, provider) {
  return {
    contentCollector: new ByteChunkCollector(limits.maxAnswerBytes),
    reasoningCollector: new ByteChunkCollector(limits.maxReasoningBytes),
    contentBytes: 0, reasoningBytes: 0,
    finishReason: null, usage: null, chunks: 0, rawResponse: '', rawResponseTruncated: false,
    terminalObserved: false, terminalStatus: null, incompleteReason: null,
    limits, provider,
  };
}

export function completeResult(result, onEvent) {
  assertCompletionFinished(result);
  const value = {
    content: result.contentCollector.toString(),
    reasoning: result.reasoningCollector.toString(),
    finishReason: result.finishReason,
    usage: result.usage,
    chunks: result.chunks,
    contentBytes: result.contentBytes,
    reasoningBytes: result.reasoningBytes,
    rawResponse: result.rawResponse,
    rawResponseTruncated: result.rawResponseTruncated,
  };
  onEvent({ type: 'complete', ...value });
  return value;
}

function assertCompletionFinished(result) {
  const reason = String(result.incompleteReason ?? result.finishReason ?? result.terminalStatus ?? '').trim();
  const normalized = reason.toLowerCase().replace(/[\s-]+/g, '_');
  const incomplete = result.terminalStatus === 'incomplete'
    || ['length', 'max_tokens', 'max_output_tokens', 'content_filter', 'context_window_exceeded', 'context_length_exceeded'].includes(normalized);
  if (incomplete) throw incompleteGenerationError(result, reason || 'provider reported an incomplete response');
  if (!result.terminalObserved) throw incompleteGenerationError(result, 'the response stream ended without a completion event');
}

function incompleteGenerationError(result, reason) {
  const contextLimited = /context|token|length|max_output|max_tokens/i.test(String(reason));
  const explanation = contextLimited
    ? 'The model stopped before completing its response, most likely because it reached a context or output-token limit.'
    : 'The model response stream ended before the provider reported successful completion.';
  return new LocalLlmError(`${explanation} Provider detail: ${reason}. Partial output was preserved in replay diagnostics.`, {
    code: contextLimited ? 'context_exceeded' : 'incomplete_generation',
    provider: result.provider,
    retryableWithSmallerPrompt: true,
    diagnostics: {
      finishReason: result.finishReason,
      terminalStatus: result.terminalStatus,
      contentBytes: result.contentBytes,
      reasoningBytes: result.reasoningBytes,
      chunks: result.chunks,
    },
  });
}
