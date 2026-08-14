import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { loadProject } from './project-store.js';

const LIBRARY_DIR = '.papergod';
const LIBRARY_SUBDIR = 'library';
const INDEX_FILE = 'index.json';

function now() { return new Date().toISOString(); }

function escapeMdInline(value) {
  return String(value ?? '').replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&');
}

function escapeMdBlock(value) {
  // Keep newlines; only guard against fenced code blocks and markdown headings.
  const safe = String(value ?? '').replace(/```/g, '` ` `');
  return safe.split('\n').map((line) => (line.startsWith('#') ? `\\${line}` : line)).join('\n');
}

function tagsLine(tags) {
  const list = Array.isArray(tags) ? tags.filter(Boolean) : [];
  return list.length ? list.join(', ') : '';
}

function renderCorpusMarkdown(libraries) {
  const corpora = libraries.corpora || [];
  const head = '# Papergod Writing Library — Corpora\n\n';
  const body = corpora.map((item) => {
    const blocks = [`## [${escapeMdInline(item.id)}] ${escapeMdInline(item.name)}`];
    if (item.source) blocks.push(`- source: ${escapeMdInline(item.source)}`);
    if (tagsLine(item.tags)) blocks.push(`- tags: ${escapeMdInline(tagsLine(item.tags))}`);
    if (item.description) blocks.push(`- description: ${escapeMdInline(item.description)}`);
    blocks.push('', escapeMdBlock(item.content || ''));
    return blocks.join('\n');
  }).join('\n\n---\n\n');
  return head + (body || '（空库）');
}

function renderPatternsMarkdown(libraries) {
  const patterns = libraries.sentencePatterns || [];
  const head = '# Papergod Writing Library — Sentence Patterns\n\n';
  const body = patterns.map((item) => {
    const slots = (item.slots || []).map((slot) => `${slot.name}${slot.required ? '' : '?'}: ${slot.description || ''}`.trim()).join('; ');
    const blocks = [`## [${escapeMdInline(item.id)}] ${escapeMdInline(item.name)}`];
    if (item.source) blocks.push(`- source: ${escapeMdInline(item.source)}`);
    if (tagsLine(item.tags)) blocks.push(`- tags: ${escapeMdInline(tagsLine(item.tags))}`);
    if (item.sectionTypes?.length) blocks.push(`- sections: ${escapeMdInline(item.sectionTypes.join(', '))}`);
    blocks.push(`- slots: ${escapeMdInline(slots || 'none')}`);
    blocks.push('', `template: ${escapeMdBlock(item.template || '')}`);
    if (item.description) blocks.push('', escapeMdBlock(item.description));
    return blocks.join('\n');
  }).join('\n\n---\n\n');
  return head + (body || '（空库）');
}

function renderVocabularyMarkdown(scope) {
  return (libraries) => {
    const entries = (libraries.vocabulary?.[scope]) || [];
    const head = `# Papergod Writing Library — Vocabulary (${scope})\n\n`;
    const body = entries.map((item) => {
      const blocks = [`## [${escapeMdInline(item.id)}] ${escapeMdInline(item.term)}${item.preferred ? ` → prefer: ${escapeMdInline(item.preferred)}` : ''}`];
      if (item.definition) blocks.push(`- meaning: ${escapeMdInline(item.definition)}`);
      if (item.source) blocks.push(`- source: ${escapeMdInline(item.source)}`);
      if (tagsLine(item.tags)) blocks.push(`- tags: ${escapeMdInline(tagsLine(item.tags))}`);
      if (item.examples?.length) blocks.push(`- examples: ${escapeMdInline(item.examples.join('; '))}`);
      if (item.alternatives?.length) blocks.push(`- alternatives: ${escapeMdInline(item.alternatives.join(', '))}`);
      return blocks.join('\n');
    }).join('\n\n---\n\n');
    return head + (body || '（空库）');
  };
}

function summaryEntries(items, kind, file) {
  return items.map((item) => ({
    id: item.id,
    kind,
    name: item.name || item.term || item.title || '',
    tags: Array.isArray(item.tags) ? item.tags.filter(Boolean) : [],
    file,
  }));
}

export const LIBRARY_FILE_LAYOUT = [
  { kind: 'corpora', file: 'corpus.md', render: renderCorpusMarkdown, pick: (libraries) => libraries.corpora },
  { kind: 'sentence-patterns', file: 'patterns.md', render: renderPatternsMarkdown, pick: (libraries) => libraries.sentencePatterns },
  { kind: 'vocabulary-global', file: 'vocabulary-global.md', render: renderVocabularyMarkdown('global'), pick: (libraries) => libraries.vocabulary.global },
  { kind: 'vocabulary-session', file: 'vocabulary-session.md', render: renderVocabularyMarkdown('session'), pick: (libraries) => libraries.vocabulary.session },
];

export function libraryDirectory(workspaceRoot) {
  return join(workspaceRoot, LIBRARY_DIR, LIBRARY_SUBDIR);
}

export function libraryIndexPath(workspaceRoot) {
  return join(workspaceRoot, LIBRARY_DIR, INDEX_FILE);
}

// Materialize the writing library into readable files under .papergod/library/.
// Returns { paths, index } where `paths` is a list of relative file paths and
// `index` is the machine-readable catalog (all entries across the four files).
export async function materializeLibraries(workspaceRoot) {
  const project = await loadProject(workspaceRoot);
  const libraries = project.libraries || { corpora: [], sentencePatterns: [], vocabulary: { global: [], session: [] } };
  const directory = libraryDirectory(workspaceRoot);
  await mkdir(directory, { recursive: true });

  const files = [];
  const paths = [];
  const entries = [];
  for (const layout of LIBRARY_FILE_LAYOUT) {
    const items = layout.pick(libraries) || [];
    const content = layout.render(libraries);
    const relative = `${LIBRARY_SUBDIR}/${layout.file}`;
    await writeFile(join(directory, layout.file), content, 'utf-8');
    files.push({ kind: layout.kind, file: relative, count: items.length });
    paths.push(relative);
    entries.push(...summaryEntries(items, layout.kind, relative));
  }

  const index = {
    generatedAt: now(),
    files,
    entries,
  };
  await writeFile(libraryIndexPath(workspaceRoot), `${JSON.stringify(index, null, 2)}\n`, 'utf-8');

  return {
    paths,
    index,
    directory: `.papergod/${LIBRARY_SUBDIR}`,
    indexFile: `.papergod/${INDEX_FILE}`,
  };
}
