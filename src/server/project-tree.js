import { readdir, realpath } from 'fs/promises';
import { relative, isAbsolute } from 'path';
import { sanitizePath } from './security.js';

export async function listProjectDirectory(root, directory = '') {
  const safe = directory === '' ? root : sanitizePath(directory, root);
  if (!safe) throw Object.assign(new Error('Access denied'), { status: 403 });
  const actualRoot = await realpath(root);
  const actual = await realpath(safe);
  const rel = relative(actualRoot, actual);
  if (rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) {
    throw Object.assign(new Error('Access denied'), { status: 403 });
  }
  const entries = (await readdir(actual, { withFileTypes: true }))
    .filter(entry => !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()))
    .map(entry => ({ name: entry.name, path: directory ? `${directory}/${entry.name}` : entry.name, type: entry.isDirectory() ? 'directory' : 'file' }))
    .sort((a, b) => (a.type === b.type ? 0 : a.type === 'directory' ? -1 : 1) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { directory, entries };
}
