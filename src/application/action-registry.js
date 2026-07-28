import { createProblem, ZipflowApiError } from '../protocol/errors.js';
import { assertProtocolValue, validateProtocolValue } from '../protocol/validation.js';
import {
  getSemanticActionDefinition,
  SEMANTIC_ACTION_DEFINITIONS,
  SEMANTIC_ACTION_IDS,
  SEMANTIC_ACTION_KINDS,
} from './action-definitions.js';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function fail(code, message, details) {
  throw new ZipflowApiError(createProblem(code, { message, details }));
}

function normalizeEntry(entry) {
  return typeof entry === 'string' ? { id: entry } : entry;
}

export function advertiseAction(entry) {
  const options = normalizeEntry(entry);
  if (!options || typeof options.id !== 'string') {
    throw new TypeError('An advertised action must have a semantic action id.');
  }

  const definition = getSemanticActionDefinition(options.id);
  if (!definition) {
    throw new TypeError(`Unknown semantic action: ${options.id}`);
  }

  const enabled = options.enabled ?? true;
  if (typeof enabled !== 'boolean') {
    throw new TypeError(`Action ${options.id} enabled must be a boolean.`);
  }

  const action = {
    id: definition.id,
    kind: definition.kind,
    'label': options.label ?? definition.label,
    'description': options.description ?? definition.description,
    enabled,
    disabledReason: enabled ? null : (options.disabledReason ?? 'Action is not currently available.'),
    risk: definition.risk,
    confirmation: definition.confirmation,
    inputSchema: clone(options.inputSchema === undefined ? definition.inputSchema : options.inputSchema),
    presentation: clone(options.presentation ?? definition.presentation),
  };

  assertProtocolValue('action', action);
  return action;
}

export function advertiseActions(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError('Advertised actions must be an array.');
  }
  const actions = entries.map(advertiseAction);
  if (new Set(actions.map(({ id }) => id)).size !== actions.length) {
    throw new TypeError('A surface cannot advertise a semantic action more than once.');
  }
  return actions;
}

export function validateAdvertisedActionInput(action, input = {}) {
  if (action.inputSchema === null) {
    const valid = input !== null
      && typeof input === 'object'
      && !Array.isArray(input)
      && Object.keys(input).length === 0;
    return valid
      ? { valid: true, errors: [] }
      : { valid: false, errors: [{ path: '$', message: 'must be an empty object' }] };
  }

  return validateProtocolValue(action.inputSchema, input);
}

export class ActionRegistry {
  constructor({ handlers = {} } = {}) {
    this.handlers = new Map();
    if (handlers instanceof Map) {
      for (const [actionId, handler] of handlers) {
        this.register(actionId, handler);
      }
    } else {
      for (const [actionId, handler] of Object.entries(handlers)) {
        this.register(actionId, handler);
      }
    }
  }

  register(actionId, handler) {
    if (!getSemanticActionDefinition(actionId)) {
      throw new TypeError(`Unknown semantic action: ${actionId}`);
    }
    if (typeof handler !== 'function') {
      throw new TypeError(`Handler for ${actionId} must be a function.`);
    }
    this.handlers.set(actionId, handler);
    return this;
  }

  advertise(entries) {
    return advertiseActions(entries);
  }

  async dispatch({ surface, actionId, expectedRevision, input = {}, context = null }) {
    try {
      assertProtocolValue('surface', surface);
    } catch (error) {
      fail('ACTION_NOT_AVAILABLE', 'The action surface is invalid.', {
        actionId,
        reason: error.message,
      });
    }

    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== surface.revision) {
      fail('STALE_REVISION', 'The surface revision is stale.', {
        expectedRevision,
        currentRevision: surface.revision,
      });
    }

    const matches = surface.actions.filter((candidate) => candidate.id === actionId);
    const action = matches.length === 1 ? matches[0] : null;
    const definition = getSemanticActionDefinition(actionId);
    if (!action
      || !definition
      || action.kind !== definition.kind
      || action.risk !== definition.risk
      || action.confirmation !== definition.confirmation
      || !action.enabled
      || action.disabledReason !== null) {
      fail('ACTION_NOT_AVAILABLE', 'The action is not available on this surface.', {
        actionId,
        disabledReason: action?.disabledReason ?? null,
        advertisedCount: matches.length,
      });
    }

    const handler = this.handlers.get(actionId);
    if (!handler) {
      fail('ACTION_NOT_AVAILABLE', 'No handler is registered for the advertised action.', { actionId });
    }

    const validation = validateAdvertisedActionInput(action, input);
    if (!validation.valid) {
      fail('ACTION_INPUT_INVALID', 'The action input does not match its advertised schema.', {
        actionId,
        errors: validation.errors,
      });
    }

    return handler({
      action: clone(action),
      surface: clone(surface),
      input: clone(input),
      context,
    });
  }
}

export function createActionRegistry(options) {
  return new ActionRegistry(options);
}

export {
  SEMANTIC_ACTION_DEFINITIONS,
  SEMANTIC_ACTION_IDS,
  SEMANTIC_ACTION_KINDS,
};
