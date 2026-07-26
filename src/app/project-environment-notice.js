import { PROJECT_ENVIRONMENT_NOTICE_VERSION } from '../security/environment.js';
import { updateSettings } from '../settings/store.js';

export async function ensureProjectEnvironmentNotice(controller, settings = controller.state.settings) {
  if (settings?.checkCommandEnvironment !== 'sanitized' && settings?.deployCommandEnvironment !== 'sanitized') return false;
  if (Number(settings?.projectEnvironmentNoticeVersion ?? 0) >= PROJECT_ENVIRONMENT_NOTICE_VERSION) return false;

  controller.message('Sanitized command environment', [
    'Project checks use a sanitized environment by default. Deployments inherit the full environment by default because they commonly need credentials and agent sockets.',
    'Each policy can be changed separately in Settings → Project command environment.',
  ], 'info');

  const updated = await updateSettings({
    projectEnvironmentNoticeVersion: PROJECT_ENVIRONMENT_NOTICE_VERSION,
  }, { baseSettings: controller.state.settings });
  controller.state.settings = updated;
  return true;
}
