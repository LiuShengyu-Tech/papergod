import { homedir } from 'os';
import { isAbsolute, relative, resolve, sep } from 'path';
import { readdir, realpath, stat } from 'fs/promises';

function isWithin(root, candidate) {
  if (root === candidate) return true;
  const rel = relative(root, candidate);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function canonical(path) {
  try { return await realpath(path); } catch { return resolve(path); }
}

async function isGitRepository(path) {
  try { return (await stat(resolve(path, '.git'))).isDirectory() || (await stat(resolve(path, '.git'))).isFile(); }
  catch { return false; }
}

export async function browseWorkspaceDirectories(requestedPath = '', { root = homedir() } = {}) {
  const browseRoot = await canonical(resolve(root));
  const requested = typeof requestedPath === 'string' ? requestedPath.trim() : '';
  const lexical = requested ? resolve(browseRoot, requested) : browseRoot;
  const candidate = await canonical(lexical);
  if (!isWithin(browseRoot, candidate)) {
    throw Object.assign(new Error('Folder browsing is restricted to your home directory. Paste an absolute path to use another location.'), { status: 403, code: 'BROWSE_OUTSIDE_ROOT' });
  }
  let info;
  try { info = await stat(candidate); }
  catch (error) {
    throw Object.assign(new Error(error.code === 'EACCES' ? 'Permission denied.' : 'Folder is unavailable.'), { status: 400, code: error.code || 'BROWSE_FAILED' });
  }
  if (!info.isDirectory()) throw Object.assign(new Error('The selected path is not a folder.'), { status: 400, code: 'INVALID_WORKSPACE_PATH' });
  let entries;
  try { entries = await readdir(candidate, { withFileTypes: true }); }
  catch (error) {
    throw Object.assign(new Error(error.code === 'EACCES' ? 'Permission denied.' : error.message), { status: 400, code: error.code || 'BROWSE_FAILED' });
  }
  const directories = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name));
  return {
    rootPath: browseRoot,
    currentPath: candidate,
    parentPath: candidate === browseRoot ? null : resolve(candidate, '..'),
    entries: await Promise.all(directories.map(async (entry) => {
      const path = resolve(candidate, entry.name);
      return { name: entry.name, path, git: await isGitRepository(path) };
    })),
  };
}
