import path from 'node:path';
import { discoverRecentArchives, RECENT_ARCHIVE_MAX_AGE_MS } from '../archive/discovery.js';
import { displayPath } from '../utils/paths.js';
import { formatByteSize } from '../utils/size.js';

const DOUBLE_ENTER_MS = 1_500;

export async function handleEmptyArchiveEnter(controller, { now = Date.now(), returnToInput = null } = {}) {
  const { state } = controller;
  if (state.screen !== 'archive-input' || String(state.editor.value ?? '').trim()) return false;
  const recentPath = state.settings.recentArchivePaths?.[0];
  const directory = state.settings.lastArchiveDirectory || (recentPath ? path.dirname(recentPath) : '');
  if (!directory) {
    state.archiveDiscoveryTap = null;
    controller.toast('No previous archive folder', 'info', 4, 'Choose a ZIP once or enter its path; Zipflow will remember that folder for future scans.');
    return true;
  }
  const previous = state.archiveDiscoveryTap;
  if (!previous || previous.directory !== directory || now - previous.at > DOUBLE_ENTER_MS) {
    state.archiveDiscoveryTap = { at: now, directory };
    controller.setStatus(`Press Enter again to scan recent ZIP files in ${displayPath(directory)}`);
    return true;
  }
  state.archiveDiscoveryTap = null;
  await scanRecentArchives(controller, directory, { returnToInput, now });
  return true;
}

export async function scanRecentArchives(controller, directory, { returnToInput = null, now = Date.now() } = {}) {
  const { state } = controller;
  const operation = controller.beginOperation({ kind: 'archive-discovery', label: 'Scanning recent archives' });
  state.busy = true;
  state.busyLabel = 'Scanning recent archives';
  state.progress = { value: 0, total: 1, detail: displayPath(directory) };
  controller.invalidate();
  try {
    const candidates = await discoverRecentArchives({
      directory, project: state.project, now, maxAgeMs: RECENT_ARCHIVE_MAX_AGE_MS, signal: operation.signal,
    });
    state.busy = false;
    state.archiveDiscoveryCandidates = candidates;
    if (!candidates.length) {
      controller.toast('No matching recent ZIP files found', 'info', 4, `Scanned ${displayPath(directory)} for archives modified in the last 24 hours.`);
      return returnToInput?.();
    }
    controller.showMenu('archive-discovery', candidates.map((candidate, index) => ({
      id: `archive-candidate:${index}`,
      label: candidate.name,
      description: candidateDescription(candidate),
      help: candidate.path,
      searchText: `${candidate.path} ${candidate.exactPaths.join(' ')}`,
    })), 'Choose a matching archive', 0, [
      `Recent ZIP files from ${displayPath(directory)} whose internal paths match the current project.`,
      'Selecting an archive starts the normal security inspection; no archive was extracted during this scan.',
    ]);
  } catch (error) {
    state.busy = false;
    if (error.code === 'cancelled') {
      controller.toast('Archive scan cancelled', 'warning');
      return returnToInput?.();
    }
    controller.toast('Archive scan failed', 'error', 4, error.message);
    return returnToInput?.();
  } finally {
    operation.finish();
  }
}

export function selectedDiscoveredArchive(state, itemId) {
  const match = String(itemId ?? '').match(/^archive-candidate:(\d+)$/);
  return match ? state.archiveDiscoveryCandidates?.[Number(match[1])] ?? null : null;
}

function candidateDescription(candidate) {
  const coverage = Math.round(candidate.archiveCoverage * 100);
  const age = formatAge(candidate.ageMs);
  const wrapper = candidate.wrapper ? ` · wrapper ${candidate.wrapper}/` : '';
  return `${candidate.exactCount} matching path${candidate.exactCount === 1 ? '' : 's'} · ${coverage}% of ZIP · ${age} · ${formatByteSize(candidate.size)}${wrapper}`;
}

function formatAge(ageMs) {
  const minutes = Math.max(0, Math.round(ageMs / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}
