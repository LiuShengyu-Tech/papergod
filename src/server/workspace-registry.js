import { createHash } from 'crypto';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, join, resolve } from 'path';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'fs/promises';

export const DEFAULT_WORKSPACE_REGISTRY_FILE = join(homedir(), '.papergod', 'workspaces.json');

function workspaceId(path) {
  return `workspace_${createHash('sha256').update(path).digest('hex').slice(0, 16)}`;
}

async function canonicalDirectory(path) {
  if (typeof path !== 'string' || !path.trim() || path.includes('\0')) {
    throw Object.assign(new Error('Workspace path is required.'), { status: 400, code: 'INVALID_WORKSPACE_PATH' });
  }
  if (!isAbsolute(path.trim())) {
    throw Object.assign(new Error('Use an absolute folder path.'), { status: 400, code: 'INVALID_WORKSPACE_PATH' });
  }
  const target = resolve(path.trim());
  let info;
  try {
    info = await stat(target);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw Object.assign(new Error('The selected folder does not exist.'), { status: 404, code: 'WORKSPACE_NOT_FOUND' });
    }
    throw error;
  }
  if (!info.isDirectory()) {
    throw Object.assign(new Error('The selected path is not a folder.'), { status: 400, code: 'INVALID_WORKSPACE_PATH' });
  }
  return await realpath(target);
}

function emptyRegistry() {
  return { version: 1, activePath: '', workspaces: [] };
}

async function readRegistry(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return {
      version: 1,
      activePath: typeof parsed.activePath === 'string' ? parsed.activePath : '',
      workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces.filter((item) => item && typeof item.path === 'string') : [],
    };
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return emptyRegistry();
    throw error;
  }
}

async function writeRegistry(file, registry) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

export function createWorkspaceRegistry({ file = DEFAULT_WORKSPACE_REGISTRY_FILE } = {}) {
  let operationQueue = Promise.resolve();
  const serialize = (operation) => {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.catch(() => {});
    return result;
  };

  async function add(path, { activate = false } = {}) {
    const canonical = await canonicalDirectory(path);
    const registry = await readRegistry(file);
    const timestamp = new Date().toISOString();
    let entry = registry.workspaces.find((item) => item.path === canonical);
    if (!entry) {
      entry = { id: workspaceId(canonical), name: basename(canonical) || canonical, path: canonical, addedAt: timestamp, lastOpenedAt: timestamp };
      registry.workspaces.push(entry);
    }
    if (activate) {
      entry.lastOpenedAt = timestamp;
      registry.activePath = canonical;
    }
    await writeRegistry(file, registry);
    return { ...entry };
  }

  async function activate(idOrPath) {
    const registry = await readRegistry(file);
    let entry = registry.workspaces.find((item) => item.id === idOrPath);
    if (!entry && typeof idOrPath === 'string' && isAbsolute(idOrPath)) {
      const canonical = await canonicalDirectory(idOrPath);
      entry = registry.workspaces.find((item) => item.path === canonical);
    }
    if (!entry) throw Object.assign(new Error('Workspace is not registered.'), { status: 404, code: 'WORKSPACE_NOT_FOUND' });
    entry.path = await canonicalDirectory(entry.path);
    entry.name = basename(entry.path) || entry.path;
    entry.lastOpenedAt = new Date().toISOString();
    registry.activePath = entry.path;
    await writeRegistry(file, registry);
    return { ...entry };
  }

  async function getActive() {
    const registry = await readRegistry(file);
    if (!registry.activePath) return null;
    try {
      const canonical = await canonicalDirectory(registry.activePath);
      const entry = registry.workspaces.find((item) => item.path === registry.activePath || item.path === canonical);
      return entry
        ? { ...entry, path: canonical, name: basename(canonical) || canonical }
        : { id: workspaceId(canonical), name: basename(canonical) || canonical, path: canonical };
    } catch {
      return null;
    }
  }

  async function list(activePath = '') {
    const registry = await readRegistry(file);
    const effectiveActive = activePath || registry.activePath;
    const workspaces = [];
    let changed = false;
    for (const entry of registry.workspaces) {
      try {
        const canonical = await canonicalDirectory(entry.path);
        if (canonical !== entry.path) changed = true;
        workspaces.push({ ...entry, path: canonical, name: basename(canonical) || canonical, available: true, active: canonical === effectiveActive });
      } catch {
        workspaces.push({ ...entry, available: false, active: entry.path === effectiveActive });
      }
    }
    if (changed) {
      registry.workspaces = workspaces.map(({ available: _available, active: _active, ...entry }) => entry);
      await writeRegistry(file, registry);
    }
    return workspaces.sort((a, b) => Number(b.active) - Number(a.active) || String(b.lastOpenedAt).localeCompare(String(a.lastOpenedAt)));
  }

  return {
    add: (...args) => serialize(() => add(...args)),
    activate: (...args) => serialize(() => activate(...args)),
    getActive: (...args) => serialize(() => getActive(...args)),
    list: (...args) => serialize(() => list(...args)),
    file,
  };
}
