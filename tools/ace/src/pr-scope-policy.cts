function normalizePathList(value: any) {
  if (value == null) return [];
  const raw = Array.isArray(value) ? value : String(value).split(/[\n,]/);
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const clean = String(item || '')
      .trim()
      .replace(/^['"]|['"]$/g, '')
      .replace(/\\/g, '/')
      .replace(/^\.\//, '');
    if (
      !clean ||
      clean === '.' ||
      clean === '/' ||
      clean === '**' ||
      clean === '**/*' ||
      clean.startsWith('/') ||
      clean.split('/').includes('..')
    ) {
      continue;
    }
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function escapeRegexChar(value: any) {
  return /[.+^${}()|[\]\\]/.test(value) ? `\\${value}` : value;
}

function globToRegex(glob: any) {
  const pattern = String(glob || '');
  let source = '';
  for (let i = 0; i < pattern.length;) {
    if (pattern.slice(i, i + 3) === '**/') {
      source += '(?:.*/)?';
      i += 3;
      continue;
    }
    if (pattern.slice(i, i + 3) === '/**') {
      source += '(?:/.*)?';
      i += 3;
      continue;
    }
    if (pattern.slice(i, i + 2) === '**') {
      source += '.*';
      i += 2;
      continue;
    }
    const ch = pattern[i];
    if (ch === '*') source += '[^/]*';
    else if (ch === '?') source += '[^/]';
    else source += escapeRegexChar(ch);
    i += 1;
  }
  return new RegExp(`^${source}$`);
}

function pathAllowed(file: any, allowed: any) {
  const cleanFile = normalizePathList([file])[0];
  if (!cleanFile) return false;
  for (const pattern of normalizePathList(allowed)) {
    if (pattern.endsWith('/')) {
      if (cleanFile.startsWith(pattern)) return true;
      continue;
    }
    if (!/[*?]/.test(pattern)) {
      if (cleanFile === pattern || cleanFile.startsWith(`${pattern.replace(/\/$/, '')}/`)) return true;
      continue;
    }
    if (globToRegex(pattern).test(cleanFile)) return true;
  }
  return false;
}

function evaluatePrScope({ allowedPaths, changedFiles }: any = {}) {
  const allowed = normalizePathList(allowedPaths);
  const changed = normalizePathList(changedFiles);
  if (!changed.length) {
    return { ok: true, allowedPaths: allowed, changedFiles: changed, unexpectedFiles: [] };
  }
  if (!allowed.length) {
    return {
      ok: false,
      code: 'scope_missing',
      allowedPaths: allowed,
      changedFiles: changed,
      unexpectedFiles: changed,
      message: 'allowed paths are required before PR validation or merge',
    };
  }
  const unexpected = changed.filter((file: any) => !pathAllowed(file, allowed));
  return {
    ok: unexpected.length === 0,
    code: unexpected.length ? 'scope_contamination' : null,
    allowedPaths: allowed,
    changedFiles: changed,
    unexpectedFiles: unexpected,
    message: unexpected.length ? 'PR changes include files outside allowed paths' : null,
  };
}

module.exports = {
  evaluatePrScope,
  normalizePathList,
  pathAllowed,
};
