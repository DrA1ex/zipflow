import { RuntimeSecurityError } from './runtime-security-posix.js';

export function createWindowsRuntimeSecurity() {
  const unavailable = () => {
    throw new RuntimeSecurityError(
      'Windows runtime security is fail-closed until owner, DACL, and reparse-point validation is available.',
      { code: 'WINDOWS_RUNTIME_SECURITY_UNAVAILABLE' },
    );
  };
  return Object.freeze({
    kind: 'windows-fail-closed',
    ensurePrivateDirectory: unavailable,
    assertPrivateDirectory: unavailable,
    assertPrivateFile: unavailable,
    assertPrivateSocket: unavailable,
    createExclusiveFile: unavailable,
    readPrivateFile: unavailable,
    removeExact: unavailable,
    secureSocket: unavailable,
  });
}
