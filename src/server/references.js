import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'path';

const STATE_VERSION = 1;
const STATE_DIRECTORY = '.papergod';
const STATE_FILE = 'references.json';
const MAX_SCAN_FILES = 5000;
const DOI_PATTERN = /10\.\d{4,9}\/[\w.()/:;-]+/i;
const ARXIV_PATTERN = /(?:arxiv\s*:\s*|arxiv\.org\/(?:abs|pdf)\/)(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+\/\d{7}(?:v\d+)?)/i;

function hashId(value) {
  return `reference_${createHash('sha256').update(value).digest('hex').slice(0, 18)}`;
}

function emptyState() {
  return {
    version: STATE_VERSION,
    bibliographyFile: 'references.bib',
    folders: [],
    zotero: { libraryType: 'users', libraryId: '0', collectionKey: '' },
    items: [],
    updatedAt: new Date().toISOString(),
  };
}

function statePath(workspaceRoot) {
  return join(workspaceRoot, STATE_DIRECTORY, STATE_FILE);
}

function cleanDoi(value = '') {
  return String(value).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').replace(/[\s}\]),.;]+$/g, '').trim().toLowerCase();
}

function stripBibValue(value = '') {
  let result = value.trim();
  if ((result.startsWith('{') && result.endsWith('}')) || (result.startsWith('"') && result.endsWith('"'))) result = result.slice(1, -1);
  return result.replace(/[{}]/g, '').replace(/\\([&#_%])/g, '$1').trim();
}

function splitTopLevel(value, separator = ',') {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) { escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (character === '"' && depth === 0) quoted = !quoted;
    if (!quoted) {
      if (character === '{') depth += 1;
      else if (character === '}') depth = Math.max(0, depth - 1);
      else if (character === separator && depth === 0) {
        parts.push(value.slice(start, index));
        start = index + 1;
      }
    }
  }
  parts.push(value.slice(start));
  return parts;
}

export function parseBibTeX(content, sourcePath = '') {
  const entries = [];
  let cursor = 0;
  while (cursor < content.length) {
    const at = content.indexOf('@', cursor);
    if (at < 0) break;
    const header = content.slice(at).match(/^@([a-zA-Z]+)\s*([({])/);
    if (!header) { cursor = at + 1; continue; }
    const type = header[1].toLowerCase();
    const open = header[2];
    const close = open === '{' ? '}' : ')';
    const bodyStart = at + header[0].length;
    let depth = 1;
    let quoted = false;
    let escaped = false;
    let end = bodyStart;
    for (; end < content.length; end += 1) {
      const character = content[end];
      if (escaped) { escaped = false; continue; }
      if (character === '\\') { escaped = true; continue; }
      if (character === '"') quoted = !quoted;
      if (!quoted) {
        if (character === open) depth += 1;
        else if (character === close && --depth === 0) break;
      }
    }
    cursor = end + 1;
    if (depth !== 0 || ['comment', 'preamble', 'string'].includes(type)) continue;
    const body = content.slice(bodyStart, end);
    const parts = splitTopLevel(body);
    const citekey = parts.shift()?.trim();
    if (!citekey) continue;
    const fields = {};
    for (const part of parts) {
      const equals = part.indexOf('=');
      if (equals < 1) continue;
      fields[part.slice(0, equals).trim().toLowerCase()] = stripBibValue(part.slice(equals + 1));
    }
    const rawBibtex = content.slice(at, end + 1).trim();
    entries.push(normalizeReference({
      source: 'bibtex', sourceId: `${sourcePath}:${citekey}`, citekey, type, fields, rawBibtex,
      title: fields.title || '', authors: parseBibAuthors(fields.author), year: fields.year || fields.date?.slice(0, 4) || '',
      doi: fields.doi || '', arxivId: fields.eprint && /arxiv/i.test(fields.archiveprefix || '') ? fields.eprint : '',
      abstract: fields.abstract || '', sourcePath,
    }));
  }
  return entries;
}

function parseBibAuthors(value = '') {
  return value.split(/\s+and\s+/i).map((name) => name.trim()).filter(Boolean);
}

function latexEscape(value = '') {
  return String(value).replace(/([&#_%])/g, '\\$1').trim();
}

export function serializeReference(reference) {
  if (reference.rawBibtex?.trim()) return reference.rawBibtex.trim();
  const fields = reference.fields || {};
  const rows = [
    ['author', reference.authors?.join(' and ') || fields.author],
    ['title', reference.title || fields.title],
    ['journal', reference.containerTitle || fields.journal],
    ['booktitle', fields.booktitle],
    ['year', reference.year || fields.year],
    ['volume', fields.volume], ['number', fields.number], ['pages', fields.pages],
    ['publisher', fields.publisher], ['doi', reference.doi || fields.doi],
    ['url', reference.url || fields.url],
    ['eprint', reference.arxivId || fields.eprint],
    ['archivePrefix', reference.arxivId ? 'arXiv' : fields.archiveprefix],
  ].filter(([, value]) => value);
  return `@${reference.type || 'article'}{${reference.citekey},\n${rows.map(([name, value]) => `  ${name} = {${latexEscape(value)}}`).join(',\n')}\n}`;
}

export function generateCitekey(reference, occupied = new Set()) {
  const firstAuthor = reference.authors?.[0] || 'anonymous';
  const family = firstAuthor.includes(',') ? firstAuthor.split(',')[0] : firstAuthor.trim().split(/\s+/).at(-1);
  const titleWord = String(reference.title || '').toLowerCase().match(/[a-z0-9]{4,}/)?.[0] || 'work';
  const base = `${family || 'anonymous'}${String(reference.year || 'nd').match(/\d{4}/)?.[0] || 'nd'}${titleWord}`
    .normalize('NFKD').replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'reference';
  let candidate = base;
  let suffix = 0;
  while (occupied.has(candidate)) candidate = `${base}${String.fromCharCode(97 + suffix++)}`;
  return candidate;
}

export function normalizeReference(input, occupied = new Set()) {
  const doi = cleanDoi(input.doi || input.fields?.doi || '');
  const identity = doi ? `doi:${doi}` : input.sourceId ? `${input.source}:${input.sourceId}` : `${input.title}|${input.year}|${input.authors?.join('|')}`;
  const reference = {
    id: input.id || hashId(identity), source: input.source || 'manual', sourceId: input.sourceId || '',
    citekey: String(input.citekey || '').replace(/[^A-Za-z0-9:_+./-]/g, ''), type: input.type || 'article', title: input.title || '',
    authors: Array.isArray(input.authors) ? input.authors.filter(Boolean) : [], year: String(input.year || ''),
    doi, arxivId: input.arxivId || '', abstract: input.abstract || '', url: input.url || '',
    containerTitle: input.containerTitle || '', sourcePath: input.sourcePath || '', pdfPath: input.pdfPath || '',
    attachmentKey: input.attachmentKey || '', hasPdf: Boolean(input.hasPdf || input.pdfPath),
    fields: input.fields || {}, rawBibtex: input.rawBibtex || '',
    confidence: Number.isFinite(input.confidence) ? input.confidence : doi || input.citekey ? 1 : 0.35,
    status: input.status || (doi || input.citekey ? 'verified' : 'needs-review'), included: input.included !== false,
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
  reference.citekey ||= generateCitekey(reference, occupied);
  return reference;
}

function mergeReferences(existing, incoming) {
  const result = existing.map((item) => ({ ...item }));
  const occupied = new Set(result.map((item) => item.citekey));
  for (const raw of incoming) {
    const item = normalizeReference(raw, occupied);
    const match = result.findIndex((current) => (item.doi && current.doi === item.doi)
      || (item.source === current.source && item.sourceId && item.sourceId === current.sourceId));
    if (match >= 0) result[match] = { ...result[match], ...item, id: result[match].id, included: result[match].included !== false };
    else {
      if (occupied.has(item.citekey)) {
        item.citekey = generateCitekey(item, occupied);
        item.rawBibtex = '';
        item.status = 'needs-review';
      }
      occupied.add(item.citekey);
      result.push(item);
    }
  }
  return result;
}

export async function loadReferenceState(workspaceRoot) {
  try {
    const parsed = JSON.parse(await readFile(statePath(workspaceRoot), 'utf8'));
    return { ...emptyState(), ...parsed, folders: Array.isArray(parsed.folders) ? parsed.folders : [], items: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return emptyState();
    throw error;
  }
}

export async function saveReferenceState(workspaceRoot, state) {
  const file = statePath(workspaceRoot);
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  const stored = { ...state, version: STATE_VERSION, updatedAt: new Date().toISOString() };
  await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, file);
  return stored;
}

async function canonicalFolder(folder) {
  if (!isAbsolute(folder || '')) throw Object.assign(new Error('Use an absolute literature folder path.'), { status: 400, code: 'INVALID_REFERENCE_FOLDER' });
  const canonical = await realpath(resolve(folder));
  if (!(await stat(canonical)).isDirectory()) throw Object.assign(new Error('The literature path is not a folder.'), { status: 400, code: 'INVALID_REFERENCE_FOLDER' });
  return canonical;
}

async function collectFiles(root) {
  const files = [];
  const visit = async (folder) => {
    if (files.length >= MAX_SCAN_FILES) return;
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && ['.bib', '.bibtex', '.pdf'].includes(extname(entry.name).toLowerCase())) files.push(path);
      if (files.length >= MAX_SCAN_FILES) break;
    }
  };
  await visit(root);
  return files;
}

function pdfText(path, timeoutMs = 12_000) {
  return new Promise((resolveText) => {
    const child = spawn('pdftotext', ['-f', '1', '-l', '2', '-layout', path, '-'], { shell: false, windowsHide: true });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => { if (output.length < 200_000) output += chunk; });
    child.once('error', () => { clearTimeout(timer); resolveText(''); });
    child.once('close', () => { clearTimeout(timer); resolveText(output); });
  });
}

async function referenceFromPdf(path, root) {
  const text = await pdfText(path);
  const doi = cleanDoi(text.match(DOI_PATTERN)?.[0] || '');
  const arxivId = text.match(ARXIV_PATTERN)?.[1] || '';
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 15 && line.length < 240) || '';
  const fallbackTitle = basename(path, extname(path)).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return normalizeReference({
    source: 'folder', sourceId: relative(root, path), title: firstLine || fallbackTitle, doi, arxivId,
    pdfPath: path, hasPdf: true, confidence: doi || arxivId ? 0.9 : 0.3,
    status: doi || arxivId ? 'identified' : 'needs-review',
  });
}

export async function scanReferenceFolder(folder) {
  const root = await canonicalFolder(folder);
  const files = await collectFiles(root);
  let items = [];
  for (const file of files.filter((path) => ['.bib', '.bibtex'].includes(extname(path).toLowerCase()))) {
    items = mergeReferences(items, parseBibTeX(await readFile(file, 'utf8'), file));
  }
  for (const file of files.filter((path) => extname(path).toLowerCase() === '.pdf')) {
    const pdf = await referenceFromPdf(file, root);
    const match = items.find((item) => (pdf.doi && item.doi === pdf.doi)
      || basename(item.sourcePath || '', extname(item.sourcePath || '')).toLowerCase() === basename(file, '.pdf').toLowerCase());
    if (match) { match.pdfPath = file; match.hasPdf = true; }
    else items = mergeReferences(items, [pdf]);
  }
  return { root, files: files.length, items };
}

export async function addReferenceFolder(workspaceRoot, folder) {
  const scan = await scanReferenceFolder(folder);
  const state = await loadReferenceState(workspaceRoot);
  if (!state.folders.includes(scan.root)) state.folders.push(scan.root);
  state.items = mergeReferences(state.items, scan.items);
  return { state: await saveReferenceState(workspaceRoot, state), scan };
}

export async function scanAllReferenceFolders(workspaceRoot) {
  const state = await loadReferenceState(workspaceRoot);
  const scans = [];
  for (const folder of state.folders) {
    try {
      const scan = await scanReferenceFolder(folder);
      scans.push({ folder, ok: true, files: scan.files, items: scan.items.length });
      state.items = mergeReferences(state.items, scan.items);
    } catch (error) {
      scans.push({ folder, ok: false, error: error.message });
    }
  }
  return { state: await saveReferenceState(workspaceRoot, state), scans };
}

export async function importReferences(workspaceRoot, references) {
  if (!Array.isArray(references) || references.length > 500) throw Object.assign(new Error('references must be an array of at most 500 items.'), { status: 400 });
  const state = await loadReferenceState(workspaceRoot);
  state.items = mergeReferences(state.items, references);
  return await saveReferenceState(workspaceRoot, state);
}

export async function configureReferences(workspaceRoot, patch = {}) {
  const state = await loadReferenceState(workspaceRoot);
  if (patch.bibliographyFile !== undefined) {
    if (typeof patch.bibliographyFile !== 'string' || !/^[^\0]+\.bib(?:tex)?$/i.test(patch.bibliographyFile)) {
      throw Object.assign(new Error('bibliographyFile must name a .bib file.'), { status: 400 });
    }
    state.bibliographyFile = patch.bibliographyFile;
  }
  if (patch.zotero !== undefined) {
    const value = patch.zotero || {};
    if (!['users', 'groups'].includes(value.libraryType || 'users')) throw Object.assign(new Error('Invalid Zotero library type.'), { status: 400 });
    state.zotero = {
      libraryType: value.libraryType || 'users', libraryId: String(value.libraryId || '0'),
      collectionKey: typeof value.collectionKey === 'string' ? value.collectionKey : '',
    };
  }
  return await saveReferenceState(workspaceRoot, state);
}

export async function removeReferenceFolder(workspaceRoot, folder) {
  const state = await loadReferenceState(workspaceRoot);
  state.folders = state.folders.filter((item) => item !== folder);
  return await saveReferenceState(workspaceRoot, state);
}

export async function updateReference(workspaceRoot, id, patch) {
  const state = await loadReferenceState(workspaceRoot);
  const index = state.items.findIndex((item) => item.id === id);
  if (index < 0) throw Object.assign(new Error('Reference not found.'), { status: 404 });
  if (patch.citekey !== undefined) {
    if (typeof patch.citekey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_+./-]*$/.test(patch.citekey)) throw Object.assign(new Error('Invalid citation key.'), { status: 400 });
    if (state.items.some((item, itemIndex) => itemIndex !== index && item.citekey === patch.citekey)) throw Object.assign(new Error('Citation key is already in use.'), { status: 409 });
  }
  const allowed = ['citekey', 'title', 'authors', 'year', 'doi', 'arxivId', 'abstract', 'included', 'status'];
  const next = { ...state.items[index] };
  for (const key of allowed) if (patch[key] !== undefined) next[key] = patch[key];
  next.rawBibtex = '';
  state.items[index] = normalizeReference(next);
  return { state: await saveReferenceState(workspaceRoot, state), item: state.items[index] };
}

export async function writeBibliography(workspaceRoot) {
  const state = await loadReferenceState(workspaceRoot);
  const target = resolve(workspaceRoot, state.bibliographyFile || 'references.bib');
  if (!target.startsWith(resolve(workspaceRoot) + sep) || !/\.bib(?:tex)?$/i.test(target)) {
    throw Object.assign(new Error('Bibliography file must be a .bib file inside the workspace.'), { status: 400, code: 'INVALID_BIBLIOGRAPHY_PATH' });
  }
  const included = state.items.filter((item) => item.included !== false);
  await writeFile(target, `${included.map(serializeReference).join('\n\n')}\n`, 'utf8');
  return { file: relative(workspaceRoot, target), count: included.length };
}

export function extractCitationKeys(source = '') {
  const keys = [];
  const pattern = /\\(?:cite\w*|nocite)\*?(?:\s*\[[^\]]*\]){0,2}\s*\{([^{}]*)\}/g;
  for (const match of source.matchAll(pattern)) keys.push(...match[1].split(',').map((key) => key.trim()).filter((key) => key && key !== '*'));
  return [...new Set(keys)];
}

export function checkCitations(source, references) {
  const cited = extractCitationKeys(source);
  const available = new Set(references.filter((item) => item.included !== false).map((item) => item.citekey));
  return {
    cited, missing: cited.filter((key) => !available.has(key)),
    uncited: references.filter((item) => item.included !== false && !cited.includes(item.citekey)).map((item) => item.citekey),
    bibliographyConfigured: /\\(?:bibliography|addbibresource)\s*(?:\[[^\]]*\])?\s*\{[^}]+\}/.test(source),
  };
}

export async function checkWorkspaceCitations(workspaceRoot, file) {
  const target = resolve(workspaceRoot, file || 'main.tex');
  if (!target.startsWith(resolve(workspaceRoot) + sep) || !target.endsWith('.tex')) throw Object.assign(new Error('Invalid TeX file.'), { status: 400 });
  const state = await loadReferenceState(workspaceRoot);
  return checkCitations(await readFile(target, 'utf8'), state.items);
}

export async function resolveReferenceMetadata(reference, { fetchImpl = fetch } = {}) {
  if (!reference?.doi) return normalizeReference(reference || {});
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchImpl(`https://api.crossref.org/works/${encodeURIComponent(cleanDoi(reference.doi))}`, {
      headers: { 'User-Agent': 'Papergod/0.1 (local reference manager)' }, signal: controller.signal,
    });
    if (!response.ok) throw Object.assign(new Error(`Metadata lookup failed (${response.status}).`), { status: 502 });
    const work = (await response.json()).message;
    return normalizeReference({
      ...reference, source: reference.source || 'crossref', title: work.title?.[0] || reference.title,
      authors: work.author?.map((author) => [author.family, author.given].filter(Boolean).join(', ')) || reference.authors,
      year: work.published?.['date-parts']?.[0]?.[0] || work.issued?.['date-parts']?.[0]?.[0] || reference.year,
      doi: work.DOI || reference.doi, url: work.URL || reference.url, containerTitle: work['container-title']?.[0] || reference.containerTitle,
      type: work.type === 'proceedings-article' ? 'inproceedings' : work.type === 'book' ? 'book' : 'article',
      confidence: 1, status: 'verified', rawBibtex: '',
    });
  } finally { clearTimeout(timer); }
}

export async function resolveStoredReference(workspaceRoot, id, options) {
  const state = await loadReferenceState(workspaceRoot);
  const index = state.items.findIndex((item) => item.id === id);
  if (index < 0) throw Object.assign(new Error('Reference not found.'), { status: 404 });
  state.items[index] = { ...(await resolveReferenceMetadata(state.items[index], options)), id: state.items[index].id };
  return { state: await saveReferenceState(workspaceRoot, state), item: state.items[index] };
}

export function buildCitationContext(references, citekeys = []) {
  const selected = references.filter((item) => citekeys.includes(item.citekey));
  if (!selected.length) return '';
  const entries = selected.map((item) => `[${item.citekey}]\nTitle: ${item.title}\nAuthors: ${item.authors.join('; ')}\nYear: ${item.year || 'unknown'}\nDOI: ${item.doi || 'none'}\nAbstract: ${item.abstract || 'not available'}`);
  return `Available verified references:\n\n${entries.join('\n\n')}\n\nOnly use citation keys listed above. Never invent references, authors, findings, identifiers, or citation keys.`;
}

export function findUnknownAgentCitations(suggestions, source, references) {
  const allowed = new Set([
    ...references.filter((item) => item.included !== false).map((item) => item.citekey),
    ...extractCitationKeys(source),
  ]);
  return [...new Set((suggestions || []).flatMap((item) => extractCitationKeys(item.suggestedText || '')))].filter((key) => !allowed.has(key));
}
