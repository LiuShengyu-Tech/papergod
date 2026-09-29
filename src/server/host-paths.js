import { posix } from 'path';

// Host-path translation for container deployments.
//
// docker-compose.yml mounts one host folder (HOST_DIR, e.g. C:\Users\me) at
// /host and passes its host path as PAPERGOD_HOST_DIR. Paths typed in the UI
// are host paths ("C:\Users\me\papers\a"), which the Linux server cannot use
// directly, so they are translated to container paths ("/host/papers/a") on
// the way in and back to host paths on the way out. Outside a container
// PAPERGOD_HOST_DIR is unset and both functions return their input.

function normalize(path) {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

function hostConfig(env = process.env) {
  const hostDir = env.PAPERGOD_HOST_DIR ? normalize(env.PAPERGOD_HOST_DIR.trim()) : '';
  const mount = normalize(env.PAPERGOD_HOST_MOUNT || '/host') || '/host';
  const windows = /^[A-Za-z]:(\/|$)/.test(hostDir);
  return { hostDir, mount, windows };
}

function hasPrefix(path, prefix, caseInsensitive) {
  const a = caseInsensitive ? path.toLowerCase() : path;
  const b = caseInsensitive ? prefix.toLowerCase() : prefix;
  return a === b || a.startsWith(`${b}/`);
}

export function hostMountInfo(env = process.env) {
  const { hostDir, mount } = hostConfig(env);
  return hostDir ? { hostDir, mount } : null;
}

// Host path (as typed by the user) -> path usable by this server.
export function toServerPath(input, env = process.env) {
  if (typeof input !== 'string') return input;
  const { hostDir, mount, windows } = hostConfig(env);
  if (!hostDir) return input;
  const candidate = normalize(input.trim());
  if (!hasPrefix(candidate, hostDir, windows)) return input;
  return posix.join(mount, candidate.slice(hostDir.length));
}

// Server path -> host path for display, so users see the paths they know.
export function toHostPath(path, env = process.env) {
  if (typeof path !== 'string') return path;
  const { hostDir, mount, windows } = hostConfig(env);
  if (!hostDir || !hasPrefix(path, mount, false)) return path;
  const host = hostDir + path.slice(mount.length);
  return windows ? host.replace(/\//g, '\\') : host;
}

// Explains why a Windows path is unusable on a Linux server, or null.
export function hostPathProblem(input, env = process.env) {
  if (process.platform === 'win32' || typeof input !== 'string' || !/^[A-Za-z]:[\\/]/.test(input.trim())) return null;
  const { hostDir, windows } = hostConfig(env);
  if (hostDir) {
    const shown = windows ? hostDir.replace(/\//g, '\\') : hostDir;
    return `Only folders inside ${shown} are visible to this Papergod container. Set HOST_DIR in .env to a folder that contains it and restart.`;
  }
  return 'This Papergod server runs on Linux (e.g. in Docker), so Windows paths are not visible to it. Set HOST_DIR in .env to mount a host folder, then restart.';
}
