import picomatch from 'picomatch';

export function createPathMatcher(patterns = []) {
  const matchers = patterns.map((pattern) => picomatch(pattern, { dot: true, noext: false }));
  return (value) => matchers.some((match) => match(normalize(value)) || match(`${normalize(value)}/`));
}

export function normalizeRelativePath(value) {
  return String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
}

function normalize(value) {
  return normalizeRelativePath(value);
}
