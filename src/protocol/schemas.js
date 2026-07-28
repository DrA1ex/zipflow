import { SCHEMA_DOCUMENTS } from './schema-definitions.js';

export const SCHEMA_NAMES = Object.freeze(Object.keys(SCHEMA_DOCUMENTS));

export function listProtocolSchemas() {
  return SCHEMA_NAMES.map((name) => ({
    name,
    id: SCHEMA_DOCUMENTS[name].$id,
    path: `/v1/schemas/${encodeURIComponent(name)}`,
  }));
}

export function getProtocolSchema(name) {
  const schema = SCHEMA_DOCUMENTS[String(name ?? '')];
  if (!schema) throw new RangeError(`Unknown Zipflow protocol schema: ${name}`);
  return structuredClone(schema);
}

export function getProtocolSchemasDocument() {
  return {
    schemas: Object.fromEntries(SCHEMA_NAMES.map((name) => [name, getProtocolSchema(name)])),
    links: Object.fromEntries(SCHEMA_NAMES.map((name) => [name, `/v1/schemas/${encodeURIComponent(name)}`])),
  };
}

export const listSchemas = listProtocolSchemas;
export const getSchema = getProtocolSchema;
export const getSchemasDocument = getProtocolSchemasDocument;
