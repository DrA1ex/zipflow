import { SCHEMA_DOCUMENTS, SCHEMA_IDS } from './schema-definitions.js';

export class ProtocolValidationError extends TypeError {
  constructor(schemaName, errors) {
    const first = errors[0];
    super(`Invalid Zipflow ${schemaName}: ${first?.path ?? '$'} ${first?.message ?? 'does not match the schema'}`);
    this.name = 'ProtocolValidationError';
    this.schemaName = schemaName;
    this.errors = structuredClone(errors);
  }
}

export function validateProtocolValue(schemaOrName, value) {
  const { schema, name } = resolveSchemaInput(schemaOrName);
  const errors = [];
  validateNode(schema, value, '$', errors, schema);
  return { valid: errors.length === 0, errors, schemaName: name };
}

export function assertProtocolValue(schemaOrName, value) {
  const result = validateProtocolValue(schemaOrName, value);
  if (!result.valid) throw new ProtocolValidationError(result.schemaName, result.errors);
  return value;
}

export function isProtocolValue(schemaOrName, value) {
  return validateProtocolValue(schemaOrName, value).valid;
}

function validateNode(schema, value, path, errors, rootSchema) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.$ref) {
    const resolved = resolveReference(schema.$ref, rootSchema);
    if (!resolved) {
      add(errors, path, '$ref', `uses an unknown schema reference ${schema.$ref}`);
      return;
    }
    validateNode(resolved.schema, value, path, errors, resolved.root);
  }
  if (schema.const !== undefined && !equalJson(value, schema.const)) {
    add(errors, path, 'const', `must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((candidate) => equalJson(value, candidate))) {
    add(errors, path, 'enum', `must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(', ')}`);
  }
  if (schema.allOf) for (const child of schema.allOf) validateNode(child, value, path, errors, rootSchema);
  if (schema.anyOf) validateAlternatives('anyOf', schema.anyOf, value, path, errors, rootSchema, false);
  if (schema.oneOf) validateAlternatives('oneOf', schema.oneOf, value, path, errors, rootSchema, true);
  if (schema.type && !matchesType(value, schema.type)) {
    add(errors, path, 'type', `must be ${Array.isArray(schema.type) ? schema.type.join(' or ') : schema.type}`);
    return;
  }
  if (typeof value === 'string') validateString(schema, value, path, errors);
  if (typeof value === 'number') validateNumber(schema, value, path, errors);
  if (Array.isArray(value)) validateArray(schema, value, path, errors, rootSchema);
  else if (isObject(value)) validateObject(schema, value, path, errors, rootSchema);
}

function validateAlternatives(keyword, alternatives, value, path, errors, rootSchema, exact) {
  let matches = 0;
  for (const alternative of alternatives) {
    const candidateErrors = [];
    validateNode(alternative, value, path, candidateErrors, rootSchema);
    if (candidateErrors.length === 0) matches += 1;
  }
  if ((exact && matches !== 1) || (!exact && matches === 0)) {
    add(errors, path, keyword, exact ? 'must match exactly one allowed shape' : 'must match an allowed shape');
  }
}

function validateString(schema, value, path, errors) {
  if (schema.minLength !== undefined && value.length < schema.minLength) add(errors, path, 'minLength', `must contain at least ${schema.minLength} characters`);
  if (schema.maxLength !== undefined && value.length > schema.maxLength) add(errors, path, 'maxLength', `must contain at most ${schema.maxLength} characters`);
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) add(errors, path, 'pattern', `must match ${schema.pattern}`);
  if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) add(errors, path, 'format', 'must be an ISO date-time');
}

function validateNumber(schema, value, path, errors) {
  if (schema.minimum !== undefined && value < schema.minimum) add(errors, path, 'minimum', `must be at least ${schema.minimum}`);
  if (schema.maximum !== undefined && value > schema.maximum) add(errors, path, 'maximum', `must be at most ${schema.maximum}`);
}

function validateArray(schema, value, path, errors, rootSchema) {
  if (schema.minItems !== undefined && value.length < schema.minItems) add(errors, path, 'minItems', `must contain at least ${schema.minItems} items`);
  if (schema.maxItems !== undefined && value.length > schema.maxItems) add(errors, path, 'maxItems', `must contain at most ${schema.maxItems} items`);
  if (schema.uniqueItems) {
    const keys = value.map((item) => JSON.stringify(item));
    if (new Set(keys).size !== keys.length) add(errors, path, 'uniqueItems', 'must not contain duplicate items');
  }
  if (schema.items) value.forEach((item, index) => validateNode(schema.items, item, `${path}[${index}]`, errors, rootSchema));
}

function validateObject(schema, value, path, errors, rootSchema) {
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(value, key)) add(errors, path, 'required', `must include ${key}`);
  }
  const properties = schema.properties ?? {};
  for (const [key, child] of Object.entries(properties)) {
    if (Object.hasOwn(value, key)) validateNode(child, value[key], propertyPath(path, key), errors, rootSchema);
  }
  for (const [key, childValue] of Object.entries(value)) {
    if (Object.hasOwn(properties, key)) continue;
    if (schema.additionalProperties === false) add(errors, propertyPath(path, key), 'additionalProperties', 'is not allowed');
    else if (isObject(schema.additionalProperties)) validateNode(schema.additionalProperties, childValue, propertyPath(path, key), errors, rootSchema);
  }
}

function resolveReference(reference, rootSchema) {
  const hashIndex = reference.indexOf('#');
  const base = hashIndex < 0 ? reference : reference.slice(0, hashIndex);
  const fragment = hashIndex < 0 ? '' : reference.slice(hashIndex + 1);
  let root = base ? SCHEMA_DOCUMENTS[SCHEMA_IDS[base]] : rootSchema;
  if (!root) return null;
  let schema = root;
  if (fragment) {
    if (!fragment.startsWith('/')) return null;
    for (const token of fragment.slice(1).split('/')) {
      schema = schema?.[token.replaceAll('~1', '/').replaceAll('~0', '~')];
    }
  }
  return schema ? { schema, root } : null;
}

function resolveSchemaInput(schemaOrName) {
  if (typeof schemaOrName === 'string') {
    const schema = SCHEMA_DOCUMENTS[schemaOrName];
    if (!schema) throw new RangeError(`Unknown Zipflow protocol schema: ${schemaOrName}`);
    return { schema, name: schemaOrName };
  }
  if (!isObject(schemaOrName)) throw new TypeError('A schema name or JSON Schema object is required.');
  return { schema: schemaOrName, name: schemaOrName.title ?? 'protocol value' };
}

function matchesType(value, expected) {
  const types = Array.isArray(expected) ? expected : [expected];
  return types.some((type) => {
    if (type === 'null') return value === null;
    if (type === 'array') return Array.isArray(value);
    if (type === 'object') return isObject(value);
    if (type === 'integer') return Number.isInteger(value);
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    return typeof value === type;
  });
}

function add(errors, path, keyword, message) {
  errors.push({ path, keyword, message });
}

function propertyPath(parent, key) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
