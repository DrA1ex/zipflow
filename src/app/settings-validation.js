import path from 'node:path';
import { ensureDir } from '../utils/fs.js';
import { expandHome } from '../utils/paths.js';
import { parseByteSize } from '../utils/size.js';
import { normalizeCodexEndpoint } from '../llm/codex-websocket.js';

export async function validateSettingValue(field, entered) {
  if (field.binaryId) return entered;
  if (field.id === 'archiveDirectory') {
    if (!entered) throw new Error('Enter an archive directory.');
    const absolute = path.resolve(expandHome(entered));
    await ensureDir(absolute);
    return entered;
  }
  if (['archiveRetentionDays', 'backupRetentionDays'].includes(field.id)) {
    if (!/^\d+$/.test(entered)) throw new Error('Enter retention as a whole number of days.');
    const value = Number(entered);
    if (value > 36_500) throw new Error('Retention cannot exceed 36,500 days.');
    return value;
  }
  if (['archiveMaxBytes', 'backupMaxBytes'].includes(field.id)) {
    const value = parseByteSize(entered);
    if (value > Number.MAX_SAFE_INTEGER) throw new Error('Storage size limit is too large.');
    return value;
  }
  if (field.id === 'llmApiToken') return entered;
  if (field.id === 'llmCodexEndpoint') {
    if (!entered) throw new Error('Enter a Codex app-server endpoint.');
    return normalizeCodexEndpoint(entered);
  }
  if (field.id === 'llmBaseUrl') {
    if (!entered) throw new Error('Enter an OpenAI-compatible base URL.');
    let parsed;
    try { parsed = new URL(entered); } catch { throw new Error('Enter a valid absolute URL.'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('The base URL must use HTTP or HTTPS.');
    if (parsed.username || parsed.password) throw new Error('Put credentials in the API token field, not in the base URL.');
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/+$/, '');
  }
  throw new Error(`Unsupported setting: ${field.id}`);
}
