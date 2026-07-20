import path from 'node:path';
import { ensureDir } from '../utils/fs.js';
import { expandHome } from '../utils/paths.js';
import { parseByteSize } from '../utils/size.js';

export async function validateSettingValue(field, entered) {
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
  throw new Error(`Unsupported setting: ${field.id}`);
}
