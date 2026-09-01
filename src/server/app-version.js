import { readFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGE_FILE = resolve(PROJECT_ROOT, 'package.json');
const RELEASES_URL = 'https://api.github.com/repos/LiuShengyu-Tech/papergod/releases/latest';
const CACHE_TTL = 30 * 60 * 1000;

let cachedRelease = null;
let cachedAt = 0;
let cacheResolved = false;

export function compareVersions(left, right) {
  const parse = (value) => String(value || '').replace(/^v/i, '').split('-')[0].split('.').map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0) ? 1 : -1;
  }
  return 0;
}

export function parseReleaseNotes(body = '') {
  const sections = { highlights: [], fixes: [] };
  let target = sections.highlights;
  for (const rawLine of String(body).split('\n')) {
    const line = rawLine.trim();
    if (/^#{1,6}\s*(bug fixes?|fixes?|修复|问题修复)/i.test(line)) { target = sections.fixes; continue; }
    if (/^#{1,6}\s*(what'?s new|features?|improvements?|新增|更新|改进)/i.test(line)) { target = sections.highlights; continue; }
    const match = line.match(/^[-*]\s+(.+)/);
    if (match) target.push(match[1].replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1').replace(/`([^`]+)`/g, '$1'));
  }
  return sections;
}

async function fetchLatestRelease(fetchImpl = globalThis.fetch) {
  if (cacheResolved && Date.now() - cachedAt < CACHE_TTL) return cachedRelease;
  if (typeof fetchImpl !== 'function') return null;
  const response = await fetchImpl(RELEASES_URL, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'papergod-update-check' },
    signal: AbortSignal.timeout(3000),
  });
  if (response.status === 404) {
    cachedRelease = null;
    cachedAt = Date.now();
    cacheResolved = true;
    return null;
  }
  if (!response.ok) throw new Error(`Release check failed (${response.status})`);
  const release = await response.json();
  cachedRelease = release;
  cachedAt = Date.now();
  cacheResolved = true;
  return release;
}

export async function getAppVersionInfo({ fetchImpl = globalThis.fetch } = {}) {
  const packageData = JSON.parse(await readFile(PACKAGE_FILE, 'utf-8'));
  const currentVersion = packageData.version;
  try {
    const release = await fetchLatestRelease(fetchImpl);
    if (!release) return { currentVersion, latestVersion: currentVersion, updateAvailable: false, checked: true };
    const latestVersion = String(release.tag_name || release.name || currentVersion).replace(/^v/i, '');
    const notes = parseReleaseNotes(release.body);
    return {
      currentVersion,
      latestVersion,
      updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
      checked: true,
      publishedAt: release.published_at || null,
      releaseUrl: release.html_url || packageData.homepage || null,
      title: release.name || `Papergod ${latestVersion}`,
      highlights: notes.highlights,
      fixes: notes.fixes,
    };
  } catch {
    return { currentVersion, latestVersion: currentVersion, updateAvailable: false, checked: false };
  }
}

export function resetVersionCacheForTests() {
  cachedRelease = null;
  cachedAt = 0;
  cacheResolved = false;
}
