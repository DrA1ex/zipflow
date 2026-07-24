import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/settings/store.js';
import { settingsDefinitions, settingsPageHelp, settingsParameters } from '../src/app/settings-options.js';
import { ZIPFLOW_VERSION } from '../src/version.js';

test('Updates settings default to background checks and expose a manual action', () => {
  const state = fixtureState();
  const definition = settingsDefinitions(state).find((item) => item.id === 'updates');
  const parameters = settingsParameters(state, definition);

  assert.equal(DEFAULT_SETTINGS.checkForUpdatesOnStartup, true);
  assert.equal(normalizeSettings({ checkForUpdatesOnStartup: false }).checkForUpdatesOnStartup, false);
  assert.deepEqual(parameters.map((item) => item.id), ['checkForUpdatesOnStartup', 'checkUpdatesNow']);
  assert.equal(parameters[0].selected, true);
  assert.equal(parameters[1].action, 'update-check-now');
  assert.deepEqual(settingsPageHelp(state, definition), [
    'Update status',
    `Installed version: ${ZIPFLOW_VERSION}`,
    'Latest version: Not checked',
  ]);
});

test('Updates settings show active check state and the latest result', () => {
  const state = fixtureState();
  state.settingsPanel.updateChecking = true;
  state.updateCheck = { status: 'available', currentVersion: ZIPFLOW_VERSION, latestVersion: '9.9.9' };
  const definition = settingsDefinitions(state).find((item) => item.id === 'updates');
  const parameters = settingsParameters(state, definition);

  assert.equal(parameters[1].label, 'Checking for updates…');
  assert.equal(parameters[1].disabled, true);
  assert.equal(parameters[1].loading, true);
  assert.equal(parameters[1].value, '9.9.9 available');
  assert.deepEqual(settingsPageHelp(state, definition), [
    'Update status',
    `Installed version: ${ZIPFLOW_VERSION}`,
    'Latest version: 9.9.9',
  ]);
});

function fixtureState() {
  return {
    settings: { ...DEFAULT_SETTINGS },
    settingsPanel: { updateChecking: false },
    updateCheck: null,
    i18n: { languageId: 'en' },
  };
}
