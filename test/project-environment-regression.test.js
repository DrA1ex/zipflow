import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectCommandEnvironment } from '../src/security/environment.js';

test('inherited project environments clear Zipflow sanitized markers', () => {
  const env = createProjectCommandEnvironment('inherit', {
    baseEnv: {
      PATH: '/usr/bin',
      ZIPFLOW_COMMAND_ENVIRONMENT: 'sanitized',
      ZIPFLOW_PROJECT_ROOT: '/stale/project',
      ZIPFLOW_PHASE2_SECRET: 'available',
    },
    projectPath: '/current/project',
  });

  assert.equal(env.ZIPFLOW_COMMAND_ENVIRONMENT, undefined);
  assert.equal(env.ZIPFLOW_PROJECT_ROOT, '/current/project');
  assert.equal(env.ZIPFLOW_PHASE2_SECRET, 'available');
});
