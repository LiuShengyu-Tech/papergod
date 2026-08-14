import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, startServer } from '../src/server/index.js';
import { sanitizePath } from '../src/server/security.js';
import { detectEngines } from '../src/server/latex.js';
import { generateSuggestions, applySuggestionToContent } from '../src/server/agent.js';
import { PROJECT_SCHEMA_VERSION, createDefaultProject, migrateProjectData, validateProject } from '../src/server/project-store.js';
import { parseCliArgs, resolveStartupWorkspace } from '../src/cli.js';
import { initializeWorkspace } from '../src/server/workspace.js';
import { buildCitationContext, checkCitations, findUnknownAgentCitations, parseBibTeX, scanReferenceFolder, serializeReference } from '../src/server/references.js';
import { enrichZoteroAttachment, exportBetterBibTeX, getZoteroFullText, getZoteroStatus, listZoteroCollections, searchZoteroItems } from '../src/server/zotero.js';
import { PAPER_GENERATION_OUTPUT_SCHEMA, REVIEW_ORCHESTRATION_OUTPUT_SCHEMA, SUGGESTION_OUTPUT_SCHEMA, detectAgentProviders, parseAgentJson, parsePaperGenerationJson, parseReviewAgentJson, parseReviewOrchestrationJson, runAcademicReviewAgent, runPaperGenerationAgent, runProcess, runReviewOrchestrationAgent, runWritingAgent, validatePaperGenerationResponse, validateReviewOrchestrationResponse, validateReviewResponse, validateSuggestionResponse } from '../src/server/agent-adapters.js';
import { parseLatexDocument } from '../src/server/latex-structure.js';
import { buildLibraryContext, composeMockParagraph, extractLibraryCandidates, mergedVocabulary, renderSentencePattern, searchLibraries } from '../src/server/library-engine.js';
import { applySuggestionsAsRevision, restoreRevisionVersion, splitAtomicOpinions } from '../src/server/revision-engine.js';
import { getHistoricalRevisionSource, getRecentChangeHistory } from '../src/server/change-history.js';
import { generateMockPeerReview, synthesizePeerReviews } from '../src/server/review-panel.js';
import { analyzeLengths, variationIndex, mechanicalVerdict } from '../src/server/paragraph-analysis.js';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink } from 'fs/promises';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const SAMPLE_TEX = resolve(PROJECT_ROOT, 'example', 'main.tex');

let server, baseUrl, tmpWorkspace;

async function api(path, opts = {}) {
  const url = baseUrl + path;
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

before(async () => {
  tmpWorkspace = await mkdtemp(join(tmpdir(), 'papergod-test-'));
  const sampleContent = await readFile(SAMPLE_TEX, 'utf-8');
  await writeFile(join(tmpWorkspace, 'main.tex'), sampleContent, 'utf-8');
  await writeFile(join(tmpWorkspace, 'other.tex'), '\\documentclass{article}\\begin{document}Test\\end{document}', 'utf-8');
  await mkdir(join(tmpWorkspace, 'subdir'));
  await writeFile(join(tmpWorkspace, 'subdir', 'chapter.tex'), '\\documentclass{article}\\begin{document}Chapter\\end{document}', 'utf-8');

  const app = createApp(tmpWorkspace, { workspaceRegistryFile: join(tmpWorkspace, 'test-workspaces.json') });
  await new Promise((r) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      r();
    });
  });
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (tmpWorkspace) await rm(tmpWorkspace, { recursive: true, force: true });
});

test('GET / serves index.html', async () => {
  const res = await fetch(baseUrl + '/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Papergod'));
});

test('GET /api/files lists .tex files', async () => {
  const { status, data } = await api('/api/files');
  assert.equal(status, 200);
  assert.ok(Array.isArray(data.files));
  assert.ok(data.files.includes('main.tex'));
  assert.ok(data.files.includes('other.tex'));
});

test('GET /api/files/main.tex returns content', async () => {
  const { status, data } = await api('/api/files/main.tex');
  assert.equal(status, 200);
  assert.ok(data.content.includes('documentclass'));
  assert.equal(data.name, 'main.tex');
});

test('GET /api/files/nonexistent.tex returns 404', async () => {
  const { status } = await api('/api/files/nonexistent.tex');
  assert.equal(status, 404);
});

test('PUT /api/files/test.tex saves content', async () => {
  const content = '\\documentclass{article}\\begin{document}Hello\\end{document}';
  const { status, data } = await api('/api/files/test.tex', { method: 'PUT', body: { content } });
  assert.equal(status, 200);
  assert.ok(data.ok);
  const { data: read } = await api('/api/files/test.tex');
  assert.equal(read.content, content);
});

test('PUT /api/files/:name rejects non-.tex', async () => {
  const { status } = await api('/api/files/evil.sh', { method: 'PUT', body: { content: '#!/bin/bash' } });
  assert.equal(status, 400);
});

test('POST /api/compile compiles main.tex to PDF', async () => {
  const { status, data } = await api('/api/compile', { method: 'POST', body: { file: 'main.tex' } });
  if (data.ok) {
    assert.equal(status, 200);
    assert.ok(data.pdf);
    assert.ok(data.engine);
    const pdfRes = await fetch(baseUrl + data.pdf);
    assert.equal(pdfRes.status, 200);
    assert.equal(pdfRes.headers.get('content-type'), 'application/pdf');
  } else {
    assert.ok(data.error);
    console.log('Compile skipped (no engine):', data.error);
  }
});

test('POST /api/compile with invalid .tex returns error', async () => {
  await writeFile(join(tmpWorkspace, 'bad.tex'), '\\documentclass{article}\\begin{document}\\badcmd\\end{document}', 'utf-8');
  const { status, data } = await api('/api/compile', { method: 'POST', body: { file: 'bad.tex' } });
  assert.equal(status, 200);
  assert.equal(data.ok, false);
  assert.ok(data.error);
});

test('POST /api/compile rejects non-.tex file', async () => {
  const { status } = await api('/api/compile', { method: 'POST', body: { file: 'main.py' } });
  assert.equal(status, 400);
});

test('POST /api/agent/suggest returns suggestions', async () => {
  const content = 'This is very important. It was found that the method works. In conclusion, AI is very useful and has many applications.';
  const { status, data } = await api('/api/agent/suggest', { method: 'POST', body: { content, prompt: 'improve' } });
  assert.equal(status, 200);
  assert.ok(Array.isArray(data.suggestions));
  assert.ok(data.suggestions.length > 0);
  for (const s of data.suggestions) {
    assert.ok(s.id);
    assert.ok(s.category);
    assert.ok(s.description);
    assert.ok(s.originalText);
    assert.ok(s.suggestedText);
    assert.notEqual(s.originalText, s.suggestedText);
  }
});

test('POST /api/agent/apply modifies file content', async () => {
  const content = 'This is very important and very good.';
  const sugRes = await api('/api/agent/suggest', { method: 'POST', body: { content, prompt: 'fix' } });
  assert.ok(sugRes.data.suggestions.length > 0);
  const sug = sugRes.data.suggestions[0];
  await writeFile(join(tmpWorkspace, 'apply-test.tex'), content, 'utf-8');
  const { status, data } = await api('/api/agent/apply', { method: 'POST', body: { file: 'apply-test.tex', suggestionId: sug.id } });
  assert.equal(status, 200);
  assert.ok(data.ok);
  assert.notEqual(data.content, content);
  assert.equal(data.revision.origin, 'agent-suggestion');
  assert.equal(data.revision.status, 'applied');
  assert.ok(data.recoveryPoint.path.startsWith('.papergod/recovery/'));
});

test('POST /api/agent/apply-all applies one atomic AI revision and rolls it back', async () => {
  const file = 'apply-all-test.tex';
  const content = '\\documentclass{article}\\begin{document}This is very important. It was found that the method works. In conclusion, the result is very useful.\\end{document}';
  await writeFile(join(tmpWorkspace, file), content, 'utf-8');
  const synced = await api('/api/documents/sync', { method: 'POST', body: { file } });
  const proposed = await api('/api/agent/suggest', {
    method: 'POST',
    body: { documentId: synced.data.document.id, content, prompt: 'Improve academic precision.' },
  });
  assert.ok(proposed.data.suggestions.length >= 2);
  const applied = await api('/api/agent/apply-all', {
    method: 'POST',
    body: { file, suggestionIds: proposed.data.suggestions.map((item) => item.id) },
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.data.revision.origin, 'agent-batch');
  assert.equal(applied.data.revision.status, 'applied');
  assert.ok(applied.data.revision.changes.length >= 2);
  assert.notEqual(applied.data.content, content);
  assert.ok(applied.data.recoveryPoint.path.startsWith('.papergod/recovery/'));

  const rolledBack = await api(`/api/revisions/${applied.data.revision.id}/rollback`, { method: 'POST' });
  assert.equal(rolledBack.status, 200);
  assert.equal(rolledBack.data.content, content);
  assert.equal(rolledBack.data.revision.status, 'rolled-back');
});

test('POST /api/agent/reject removes suggestion', async () => {
  const content = 'This is very important.';
  const sugRes = await api('/api/agent/suggest', { method: 'POST', body: { content, prompt: 'fix' } });
  if (sugRes.data.suggestions.length > 0) {
    const sug = sugRes.data.suggestions[0];
    await writeFile(join(tmpWorkspace, 'reject-test.tex'), content, 'utf-8');
    const { status, data } = await api('/api/agent/reject', { method: 'POST', body: { file: 'reject-test.tex', suggestionId: sug.id } });
    assert.equal(status, 200);
    assert.ok(data.ok);
    assert.equal(data.revision.status, 'cancelled');
    assert.equal(data.revision.changes[0].status, 'rejected');
  }
});

test('GET /api/engines returns engine list', async () => {
  const { status, data } = await api('/api/engines');
  assert.equal(status, 200);
  assert.ok(Array.isArray(data.engines));
});

test('GET /api/config exposes selected local provider', async () => {
  const { status, data } = await api('/api/config');
  assert.equal(status, 200);
  assert.equal(data.provider, 'mock');
  assert.equal(data.workspace, tmpWorkspace);
});

test('Agent configuration exposes Codex, Claude Code, OpenCode, and Pi adapters', async () => {
  const listed = await api('/api/agents');
  assert.equal(listed.status, 200);
  assert.equal(listed.data.selected, 'mock');
  assert.ok(listed.data.providers.some((item) => item.id === 'codex' && item.integration === 'ready'));
  assert.ok(listed.data.providers.some((item) => item.id === 'opencode' && item.integration === 'ready'));
  assert.ok(listed.data.providers.some((item) => item.id === 'claude-code' && item.integration === 'ready'));
  assert.ok(listed.data.providers.some((item) => item.id === 'pi' && item.integration === 'ready'));
  const saved = await api('/api/agents/config', {
    method: 'PUT', body: { id: 'mock', command: '', args: [], model: '', activate: true },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.selected, 'mock');
});

test('Prompt context preview composes definitions, temporary instruction, libraries, and source', async () => {
  const synced = await api('/api/documents/sync', { method: 'POST', body: { file: 'main.tex' } });
  const paragraph = synced.data.document.sections[0].children[0];
  const preview = await api('/api/agent/context-preview', {
    method: 'POST', body: {
      nodeId: paragraph.id, documentId: synced.data.document.id,
      temporaryPrompt: 'Keep the quantitative claim precise.', action: 'revise', resourceIds: [],
    },
  });
  assert.equal(preview.status, 200);
  assert.match(preview.data.assembledPrompt, /Temporary instruction/);
  assert.match(preview.data.assembledPrompt, /Keep the quantitative claim precise/);
  assert.match(preview.data.assembledPrompt, /Target source/);
  assert.doesNotMatch(preview.data.contextPrompt, /Temporary instruction/);
  assert.match(preview.data.mergedPrompt, /Temporary instruction/);
  assert.doesNotMatch(preview.data.mergedPrompt, /Target source/);
  assert.ok(preview.data.layers.length >= 3);
  assert.ok(preview.data.characterCount > paragraph.text.length);
  const invoked = await api('/api/agent/suggest-node', {
    method: 'POST', body: {
      nodeId: paragraph.id, prompt: preview.data.mergedPrompt,
      promptIsComposed: true, resourceIds: [],
    },
  });
  assert.equal(invoked.status, 200);
  const runs = await api('/api/agent/runs');
  assert.equal(runs.data.runs.find((item) => item.id === invoked.data.runId).prompt, preview.data.mergedPrompt);
  const sentence = paragraph.children[0];
  await api(`/api/structure/nodes/${paragraph.id}`, { method: 'PUT', body: { prompt: 'Preserve the paragraph evidence chain.' } });
  await api(`/api/structure/nodes/${sentence.id}`, { method: 'PUT', body: { prompt: 'Make this sentence precise.', intent: 'State the main finding.' } });
  const sentencePreview = await api('/api/agent/context-preview', {
    method: 'POST', body: { nodeId: sentence.id, documentId: synced.data.document.id, temporaryPrompt: '', resourceIds: [] },
  });
  assert.match(sentencePreview.data.contextPrompt, /## Paragraph prompt\nPreserve the paragraph evidence chain/);
  assert.match(sentencePreview.data.contextPrompt, /## Element prompt\nMake this sentence precise/);
  assert.match(sentencePreview.data.contextPrompt, /State the main finding/);
});

test('GET /api/project initializes versioned project metadata', async () => {
  const { status, data } = await api('/api/project');
  assert.equal(status, 200);
  assert.equal(data.project.schemaVersion, PROJECT_SCHEMA_VERSION);
  assert.ok(data.project.project.id);
  assert.equal(data.project.documents[0].file, 'main.tex');
  assert.deepEqual(data.project.libraries.vocabulary, { global: [], session: [] });
  const stored = JSON.parse(await readFile(join(tmpWorkspace, '.papergod', 'project.json'), 'utf-8'));
  assert.equal(stored.project.id, data.project.project.id);
});

test('PUT /api/project persists project core prompt', async () => {
  const current = await api('/api/project');
  const project = current.data.project;
  project.project.corePrompt = 'Write a reproducible machine-learning paper.';
  const { status, data } = await api('/api/project', { method: 'PUT', body: { project } });
  assert.equal(status, 200);
  assert.equal(data.project.project.corePrompt, project.project.corePrompt);
  const reloaded = await api('/api/project');
  assert.equal(reloaded.data.project.project.corePrompt, project.project.corePrompt);
});

test('PUT /api/project rejects invalid schema', async () => {
  const project = createDefaultProject(tmpWorkspace);
  project.schemaVersion = 999;
  const { status, data } = await api('/api/project', { method: 'PUT', body: { project } });
  assert.equal(status, 400);
  assert.ok(data.details.some((detail) => detail.includes('schemaVersion')));
});

test('validateProject validates structured document nodes', () => {
  const project = createDefaultProject('/tmp/papergod-validation');
  const document = project.documents[0];
  document.sections.push({
    id: 'section_intro', type: 'section', parentId: document.id, order: 0,
    text: 'Introduction', prompt: 'Establish the research gap.', summary: '',
    children: [{
      id: 'paragraph_intro_1', type: 'paragraph', parentId: 'section_intro', order: 0,
      text: 'Prior work leaves an important gap.', prompt: '', summary: 'Research gap.',
      children: [{
        id: 'sentence_intro_1', type: 'sentence', parentId: 'paragraph_intro_1', order: 0,
        text: 'Prior work leaves an important gap.', prompt: '', summary: '', intent: 'Identify the gap.',
      }],
    }],
  });
  assert.equal(validateProject(project).ok, true);
  document.sections[0].children[0].children[0].intent = 42;
  assert.equal(validateProject(project).ok, false);
});

test('migrateProjectData upgrades legacy unversioned project metadata', () => {
  const legacy = {
    project: { id: 'legacy-project', name: 'Legacy', corePrompt: 'Preserve this prompt.' },
    documents: [{ id: 'legacy-document', file: 'paper.tex', title: 'Paper' }],
  };
  const migration = migrateProjectData(legacy, '/tmp/legacy-paper');
  assert.equal(migration.migratedFrom, 0);
  assert.equal(migration.data.schemaVersion, PROJECT_SCHEMA_VERSION);
  assert.equal(migration.data.project.corePrompt, 'Preserve this prompt.');
  assert.equal(migration.data.documents[0].summary, '');
  assert.deepEqual(migration.data.libraries.vocabulary.session, []);
  assert.equal(validateProject(migration.data).ok, true);
});

test('migrateProjectData upgrades schema v1 review records to the peer-review model', () => {
  const legacy = createDefaultProject('/tmp/legacy-v1');
  legacy.schemaVersion = 1;
  legacy.reviews = [{
    id: 'legacy_review', documentId: legacy.documents[0].id, name: 'Old review', status: 'draft',
    reviewers: ['Reviewer A'], items: ['Clarify the evidence.'], createdAt: 'now', updatedAt: 'now',
  }];
  const migration = migrateProjectData(legacy, '/tmp/legacy-v1');
  assert.equal(migration.migratedFrom, 1);
  assert.equal(migration.data.schemaVersion, PROJECT_SCHEMA_VERSION);
  assert.equal(migration.data.reviews[0].provider, 'mock');
  assert.equal(migration.data.reviews[0].reviewers[0].role, 'domain');
  assert.equal(migration.data.reviews[0].items[0].body, 'Clarify the evidence.');
  assert.equal(validateProject(migration.data).ok, true);
});

test('validateProject rejects broken cross-resource references', () => {
  const project = createDefaultProject('/tmp/broken-references');
  project.annotations.push({
    id: 'annotation_orphan', documentId: 'missing_document',
    target: { type: 'document', id: '', start: 0, end: 0, quote: '' },
    category: 'other', severity: 'info', body: 'Orphan', suggestedFix: '', status: 'open',
    source: { type: 'user', actor: '' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const result = validateProject(project);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('does not reference a document')));
});

test('LaTeX structure parser maps sections, paragraphs, sentences, and exact ranges', async () => {
  const source = '\\title{Inline Parser Test}\\begin{document}\n\\begin{abstract}\nA concise summary sentence. Another claim follows here.\n\\end{abstract}\n\\section{Introduction}\nFirst sentence. Second result shows progress. Third claim closes the paragraph.\n\n\\section{Conclusion}\nFinal claim stands. It summarizes the work.\n\\end{document}';
  const document = { id: 'document_parser', title: '', sections: [] };
  const parsed = parseLatexDocument(source, document);
  assert.equal(parsed.title, 'Inline Parser Test');
  const sectionTitles = parsed.sections.map((section) => section.title);
  for (const expected of ['Abstract', 'Introduction', 'Conclusion']) assert.ok(sectionTitles.includes(expected));
  const introduction = parsed.sections.find((section) => section.title === 'Introduction');
  assert.ok(introduction.children.length > 0);
  assert.ok(introduction.children[0].children.length >= 3);
  for (const section of parsed.sections) {
    for (const paragraph of section.children) {
      assert.equal(source.slice(paragraph.sourceRange.start, paragraph.sourceRange.end), paragraph.text);
      for (const sentence of paragraph.children) {
        assert.equal(source.slice(sentence.sourceRange.start, sentence.sourceRange.end), sentence.text);
        assert.ok(sentence.intent);
      }
    }
  }
});

test('LaTeX structure parser preserves stable IDs and metadata after local edits', () => {
  const firstSource = '\\begin{document}\\section{Intro}\nFirst sentence. Second result shows progress.\n\\end{document}';
  const document = { id: 'document_stable', title: '', sections: [] };
  const first = parseLatexDocument(firstSource, document);
  first.sections[0].prompt = 'Explain the motivation.';
  first.sections[0].children[0].summary = 'Two introductory claims.';
  const sentenceId = first.sections[0].children[0].children[1].id;
  const secondSource = firstSource.replace('progress', 'strong progress');
  const second = parseLatexDocument(secondSource, { ...document, sections: first.sections });
  assert.equal(second.sections[0].id, first.sections[0].id);
  assert.equal(second.sections[0].prompt, 'Explain the motivation.');
  assert.equal(second.sections[0].children[0].summary, 'Two introductory claims.');
  assert.equal(second.sections[0].children[0].children[1].id, sentenceId);
});

test('LaTeX structure parser ignores commented headings and decimal punctuation', () => {
  const source = `\\begin{document}\n% \\section{Ignored}\n\\section{Results}\nAccuracy rose from 85.2\\% to 92.7\\%. This is substantial.\n\\end{document}`;
  const parsed = parseLatexDocument(source, { id: 'document_edge', sections: [] });
  assert.deepEqual(parsed.sections.map((section) => section.title), ['Results']);
  assert.equal(parsed.sections[0].children[0].children.length, 2);
});

test('Sentence splitting keeps abbreviations, initials, and decimals intact', () => {
  const source = '\\begin{document}\\section{Intro}\nWe use, e.g., the imitation game, cf. Turing (1950), and i.e. not a proof. A. M. Turing proposed this test. Accuracy is 3.14 and Fig. 5 is shown. That is the end.\n\\end{document}';
  const parsed = parseLatexDocument(source, { id: 'document_abbr', sections: [] });
  const sentences = parsed.sections[0].children[0].children.map((sentence) => sentence.text);
  assert.equal(sentences.length, 4);
  assert.ok(sentences[0].includes('e.g.'));
  assert.ok(sentences[0].includes('cf. Turing'));
  assert.ok(sentences[0].includes('i.e. not'));
  assert.ok(sentences[1].startsWith('A. M. Turing'));
  assert.ok(sentences[2].includes('3.14'));
  assert.ok(sentences[2].includes('Fig. 5'));
});

test('Paragraph analysis splits sentences abbreviation-aware and strips LaTeX for word count', async () => {
  const { data } = await api('/api/analysis/structure', {
    method: 'POST',
    body: { content: 'We use, e.g., a method that cites \\cite{alpha2023} and math $x^2 + y^2 = z^2$. Next sentence arrives. See Eq. 5 and Fig. 3. End.' },
  });
  const analysis = data.analysis;
  assert.equal(analysis.unit.sentenceCount, 4);
  const texts = analysis.sentences.map((sentence) => sentence.text);
  assert.ok(texts[0].includes('e.g.'));
  assert.ok(texts[1].startsWith('Next sentence'));
  assert.ok(texts[2].includes('Eq. 5'));
  // The math formula is normalized, not dumped as raw LaTeX in the text layer
  assert.doesNotMatch(texts[0], /\\cite|\^2/);
});

test('Document structure APIs synchronize and update layered metadata', async () => {
  const file = 'structure-api.tex';
  await writeFile(join(tmpWorkspace, file), '\\title{Structure API Paper}\\begin{document}\n\\section{Introduction}\nFirst sentence. Second claim follows.\n\n\\section{Methods}\nMethod sentence one. Method sentence two.\n\\end{document}', 'utf-8');
  const synced = await api('/api/documents/sync', { method: 'POST', body: { file } });
  assert.equal(synced.status, 200);
  const document = synced.data.document;
  assert.ok(document.sourceHash);
  assert.ok(document.sections.length >= 2);

  const documentUpdate = await api(`/api/documents/${document.id}/metadata`, {
    method: 'PUT', body: { corePrompt: 'Prioritize reproducibility.', summary: 'An AI overview.' },
  });
  assert.equal(documentUpdate.status, 200);
  assert.equal(documentUpdate.data.document.corePrompt, 'Prioritize reproducibility.');

  const sentence = document.sections.find((section) => section.title === 'Introduction').children[0].children[0];
  const nodeUpdate = await api(`/api/structure/nodes/${sentence.id}`, {
    method: 'PUT', body: { prompt: 'Use cautious claims.', intent: 'Motivate the research topic.' },
  });
  assert.equal(nodeUpdate.status, 200);
  assert.equal(nodeUpdate.data.node.intent, 'Motivate the research topic.');
  const loaded = await api(`/api/documents/${document.id}/structure`);
  assert.equal(loaded.status, 200);
  assert.equal(loaded.data.document.id, document.id);
});

test('Node-scoped Agent suggestions include exact source range', async () => {
  const synced = await api('/api/documents/sync', { method: 'POST', body: { file: 'main.tex' } });
  const sentence = synced.data.document.sections
    .flatMap((section) => section.children)
    .flatMap((paragraph) => paragraph.children)
    .find((item) => item.text.includes('very important'));
  assert.ok(sentence);
  const result = await api('/api/agent/suggest-node', {
    method: 'POST', body: { nodeId: sentence.id, prompt: 'Improve precision.' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.nodeId, sentence.id);
  assert.deepEqual(result.data.sourceRange, {
    start: sentence.sourceRange.start, end: sentence.sourceRange.end,
  });
  assert.ok(result.data.suggestions.length > 0);
});

test('Node-scoped Agent rejects stale source ranges', async () => {
  const staleFile = 'stale.tex';
  await writeFile(join(tmpWorkspace, staleFile), '\\begin{document}\\section{One}\nThis is very important.\\end{document}', 'utf-8');
  const synced = await api('/api/documents/sync', { method: 'POST', body: { file: staleFile } });
  const sentence = synced.data.document.sections[0].children[0].children[0];
  await writeFile(join(tmpWorkspace, staleFile), '\\begin{document}\\section{One}\nChanged.\\end{document}', 'utf-8');
  const result = await api('/api/agent/suggest-node', {
    method: 'POST', body: { nodeId: sentence.id, prompt: 'Improve.' },
  });
  assert.equal(result.status, 409);
  assert.match(result.data.error, /synchronize/i);
});

test('Node-scoped suggestion applies only inside the selected repeated range', async () => {
  const file = 'repeated.tex';
  const source = `\\begin{document}\n\\section{First}\nThis is very important.\n\n\\section{Second}\nThis is very important.\n\\end{document}`;
  await writeFile(join(tmpWorkspace, file), source, 'utf-8');
  const synced = await api('/api/documents/sync', { method: 'POST', body: { file } });
  const secondSentence = synced.data.document.sections[1].children[0].children[0];
  const suggestionResult = await api('/api/agent/suggest-node', {
    method: 'POST', body: { nodeId: secondSentence.id, prompt: 'Improve precision.' },
  });
  const suggestion = suggestionResult.data.suggestions[0];
  assert.equal(suggestion.sourceRange.start, source.lastIndexOf('very important'));
  const applied = await api('/api/agent/apply', {
    method: 'POST', body: { file, suggestionId: suggestion.id },
  });
  assert.equal(applied.status, 200);
  assert.equal((applied.data.content.match(/very important/g) || []).length, 1);
  assert.ok(applied.data.content.indexOf('very important') < applied.data.content.indexOf('crucial'));
});

test('React workbench and legacy overlays expose the complete writing workflow', async () => {
  const html = await (await fetch(baseUrl + '/')).text();
  const workbench = await readFile(resolve(PROJECT_ROOT, 'frontend', 'src', 'components', 'workbench.jsx'), 'utf-8');
  const frontend = html + workbench;
  assert.ok(html.includes('id="root"'));
  assert.ok(frontend.includes('id="outline-tree"'));
  assert.ok(workbench.includes('id="navigator-outline-tab"'));
  assert.ok(workbench.includes('id="navigator-tools-tab"'));
  assert.ok(workbench.includes('id="tool-workspaces"'));
  assert.ok(workbench.includes('id="tool-references"'));
  assert.ok(workbench.includes('id="tool-terminal"'));
  assert.ok(html.includes('id="workspace-manager-overlay"'));
  assert.ok(html.includes('id="workspace-add-form"'));
  assert.ok(html.includes('id="workspace-browser"'));
  assert.ok(html.includes('id="terminal-overlay"'));
  assert.ok(html.includes('id="terminal-screen"'));
  assert.ok(html.includes('id="references-overlay"'));
  assert.ok(html.includes('id="references-list"'));
  assert.ok(workbench.includes('id="tool-open-folder"'));
  assert.ok(workbench.includes('id="tool-show-source"'));
  assert.ok(workbench.includes('id="tool-change-history"'));
  assert.ok(workbench.includes('id="history-open"'));
  assert.ok(!workbench.includes('id="engine-status"'));
  assert.ok(frontend.includes('id="context-summary"'));
  assert.ok(frontend.includes('id="context-prompt"'));
  assert.ok(frontend.includes('id="context-intent"'));
  assert.ok(html.includes('id="library-overlay"'));
  assert.ok(html.includes('id="library-form"'));
  assert.ok(frontend.includes('id="library-selection-status"'));
  assert.ok(frontend.includes('id="agent-config-module"'));
  assert.ok(workbench.includes('id="agent-provider-quick"'));
  assert.ok(html.includes('id="agent-config-overlay"'));
  assert.ok(html.includes('id="agent-config-probe"'));
  assert.ok(html.includes('id="agent-config-save"'));
  assert.ok(html.includes('Check setup'));
  assert.ok(html.includes('<option value="claude-code">Claude Code</option>'));
  assert.ok(html.includes('<option value="pi">Pi Agent</option>'));
  assert.ok(frontend.includes('id="prompt-context-module"'));
  assert.ok(workbench.includes('id="prompt-management-module"'));
  assert.ok(workbench.includes('Preview final prompt'));
  assert.ok(html.includes('id="prompt-preview-overlay"'));
  assert.ok(frontend.includes('id="temporary-prompt-module"'));
  assert.ok(!frontend.includes('id="ai-action"'));
  assert.ok(frontend.includes('id="ai-invoke"'));
  assert.ok(frontend.includes('data-i18n="ai.invoke"'));
  assert.ok(workbench.includes('id="language-select"'));
  assert.ok(frontend.includes('id="modification-intent-list"'));
  assert.ok(frontend.includes('id="modification-intent-count"'));
  assert.ok(html.includes('id="invoke-confirm-overlay"'));
  assert.ok(html.includes('id="invoke-confirm"'));
  assert.ok(html.includes('id="change-history-overlay"'));
  assert.ok(html.includes('id="change-history-list"'));
  assert.ok(html.includes('id="change-history-detail"'));
  assert.ok(!html.includes('id="agent-activity-overlay"'));
  assert.ok(workbench.includes('id="agent-activity-toggle"'));
  assert.ok(workbench.includes('id="agent-activity-stages"'));
  assert.ok(workbench.includes('id="agent-activity-undo"'));
  assert.ok(html.includes('id="pdf-edit-menu"'));
  assert.ok(html.includes('data-pdf-scope="word"'));
  assert.ok(html.includes('id="pdf-sentence-reader-open"'));
  assert.ok(html.includes('id="sentence-reader-overlay"'));
  assert.ok(html.includes('id="sentence-reader-prev"'));
  assert.ok(html.includes('id="sentence-reader-next"'));
  assert.ok(html.includes('id="sentence-reader-submit"'));
  assert.ok(frontend.includes('id="focus-annotation-open"'));
  assert.ok(html.includes('id="focus-annotation-overlay"'));
  assert.ok(html.includes('id="focus-section-tree"'));
  assert.ok(html.includes('id="focus-paragraph-prompt"'));
  assert.ok(html.includes('id="focus-sentence-list"'));
  assert.ok(html.includes('id="focus-sentence-prompt"'));
  assert.ok(frontend.includes('id="paragraph-draft"'));
  assert.ok(html.includes('id="review-overlay"'));
  assert.ok(html.includes('id="selection-comment-form"'));
  assert.ok(html.includes('id="review-import-form"'));
  assert.ok(html.includes('id="annotation-list"'));
  assert.ok(html.includes('id="revision-list"'));
  assert.ok(html.includes('id="peer-review-overlay"'));
  assert.ok(html.includes('id="reviewer-builder"'));
  assert.ok(html.includes('id="rubric-builder"'));
  assert.ok(html.includes('id="peer-review-list"'));
  assert.ok(html.includes('id="review-workflow-tabs"'));
  assert.ok(html.includes('id="review-planning-view"'));
  assert.ok(html.includes('id="review-delivery-view"'));
  assert.ok(!html.includes('id="self-revise-overlay"'));
  assert.ok(!html.includes('id="self-revise-open"'));
  assert.ok(html.includes('id="paper-generation-instruction"'));
  assert.ok(html.includes('id="self-revision-list"'));
  assert.ok(html.includes('id="workflow-history"'));
  assert.ok(frontend.includes('id="workspace-view-switch"'));
  assert.ok(frontend.includes('id="source-view-btn"'));
  assert.ok(frontend.includes('id="preview-view-btn"'));
  assert.ok(frontend.includes('id="pdf-preview" aria-label="Rendered PDF pages"'));
  assert.ok(html.includes('type="module" src="/react/app.js"'));
  assert.ok(html.includes('rel="stylesheet" href="/react/assets/main.css"'));
  assert.ok(workbench.indexOf('id="preview-panel"') < workbench.indexOf('id="right-panel"'));
  assert.ok(workbench.indexOf('id="ai-panel"') > workbench.indexOf('id="right-panel"'));
  const reactBundle = await fetch(baseUrl + '/react/app.js');
  assert.equal(reactBundle.status, 200);
  const reactTheme = await fetch(baseUrl + '/react/assets/main.css');
  assert.equal(reactTheme.status, 200);
  const appSource = await (await fetch(baseUrl + '/app.js')).text();
  const i18nSource = await (await fetch(baseUrl + '/i18n.js')).text();
  assert.ok(appSource.includes("'/api/references/bibliography'"));
  assert.ok(appSource.includes('selectedReferenceCitekeys'));
  assert.ok(i18nSource.includes("const DEFAULT_LOCALE = 'en'"));
  assert.ok(i18nSource.includes("'zh-CN'"));
  assert.ok(i18nSource.includes("papergod.locale"));
  assert.ok(appSource.includes('translateDom'));
  assert.ok(appSource.includes('setLocale'));
  assert.ok(appSource.includes('/api/agent/activity/'));
  assert.ok(appSource.includes('data-provider='));
  assert.ok(appSource.includes('selectAgentProvider'));
  assert.ok(appSource.includes('activateAgentProvider'));
  assert.ok(appSource.includes('live: false'));
  assert.ok(appSource.includes('/api/documents/sync'));
  assert.ok(appSource.includes('/api/agent/suggest-node'));
  assert.ok(appSource.includes('/api/agent/apply-all'));
  assert.ok(appSource.includes('/api/change-history'));
  assert.ok(appSource.includes('rollbackChangeHistoryEntry'));
  assert.ok(appSource.includes('id="history-pdf-pages"'));
  assert.ok(appSource.includes('deriveHistoryDisplayChange'));
  assert.ok(appSource.includes('applyHistoryDiffOverlay'));
  assert.ok(appSource.includes('history-pdf-delete-pin'));
  assert.ok(appSource.includes('history-diff-next'));
  assert.ok(appSource.includes('/api/workspace/open-folder'));
  assert.ok(appSource.includes('/api/libraries/extract'));
  assert.ok(appSource.includes('/api/libraries/render-pattern'));
  assert.ok(appSource.includes('/api/agent/generate-paragraph'));
  assert.ok(appSource.includes('/api/review/orchestrate'));
  assert.ok(appSource.includes('/api/revisions/plan'));
  assert.ok(appSource.includes("'/apply'"));
  assert.ok(appSource.includes("'/rollback'"));
  assert.ok(appSource.includes('/api/reviewer-profiles'));
  assert.ok(appSource.includes("'/to-revision'"));
  assert.ok(appSource.includes('/api/generate/paper'));
  assert.ok(appSource.includes('/api/workflow/history'));
  assert.ok(appSource.includes('/api/workflow/export'));
  assert.ok(appSource.includes("'/response-letter'"));
  assert.ok(appSource.includes("'/verify'"));
  assert.ok(appSource.includes("setWorkspaceView('preview')"));
  assert.ok(appSource.includes('showCompiledPdf(data.pdf)'));
  assert.ok(appSource.includes("pdfjsLib.getDocument({ url: pdfUrl, isEvalSupported: false })"));
  assert.ok(appSource.includes('new pdfjsLib.TextLayer'));
  assert.ok(appSource.includes("setProperty('--scale-factor', viewport.scale)"));
  assert.ok(appSource.includes('textOffsetAtPoint'));
  assert.ok(appSource.includes('tokenOccurrences'));
  assert.ok(appSource.includes('highlightPdfRanges'));
  assert.ok(appSource.includes('createPositionalPdfIntent'));
  assert.ok(appSource.includes('openSentenceReader'));
  assert.ok(appSource.includes('submitSentenceReaderIntent'));
  assert.ok(appSource.includes('queueModificationIntent'));
  assert.ok(!appSource.includes('Could not map this exact PDF position'));
  assert.ok(appSource.includes('class ModificationIntent'));
  assert.ok(appSource.includes('modificationIntentPrompt'));
  assert.ok(appSource.includes('context layers'));
  const legacyTheme = await (await fetch(baseUrl + '/style.css')).text();
  assert.ok(legacyTheme.includes('.pdf-scope-highlight'));
  const pdfModule = await fetch(baseUrl + '/vendor/pdfjs-dist/build/pdf.mjs');
  assert.equal(pdfModule.status, 200);
});

test('CLI parses workspace, port, and Agent provider', () => {
  const options = parseCliArgs(['papers/demo', '--port', '4312', '--agent=codex', '--demo'], '/tmp');
  assert.equal(options.workspaceRoot, resolve('/tmp', 'papers/demo'));
  assert.equal(options.port, 4312);
  assert.equal(options.provider, 'codex');
  assert.equal(options.demo, true);
  assert.equal(parseCliArgs(['--resume'], '/tmp').resume, true);
  assert.equal(parseCliArgs(['--agent', 'pi'], '/tmp').provider, 'pi');
  assert.throws(() => parseCliArgs(['paper', '--resume']), /cannot be combined/);
  assert.throws(() => parseCliArgs(['--resume', '--demo']), /cannot be combined/);
  assert.throws(() => parseCliArgs(['--agent', 'unknown']), /Agent must be one of/);
  assert.throws(() => parseCliArgs(['--port', '70000']), /Port must be an integer/);
});

test('CLI resume uses the last selected paper and only falls back to the built-in demo', async () => {
  const selected = await resolveStartupWorkspace(parseCliArgs(['--resume']), {
    registry: { getActive: async () => ({ path: '/papers/my-paper' }) },
    fallbackWorkspace: '/papergod/demo',
  });
  assert.equal(selected.workspaceRoot, '/papers/my-paper');
  assert.equal(selected.demo, false);
  const firstRun = await resolveStartupWorkspace(parseCliArgs(['--resume']), {
    registry: { getActive: async () => null },
    fallbackWorkspace: '/papergod/demo',
  });
  assert.equal(firstRun.workspaceRoot, '/papergod/demo');
  assert.equal(firstRun.demo, true);
});

test('initializeWorkspace creates a first-run paper and project', async () => {
  const fresh = join(tmpWorkspace, 'fresh-paper');
  const result = await initializeWorkspace(fresh);
  assert.equal(result.createdSample, true);
  assert.equal(result.project.documents[0].file, 'main.tex');
  const content = await readFile(join(fresh, 'main.tex'), 'utf-8');
  assert.ok(content.includes('\\documentclass'));
  assert.ok(JSON.parse(await readFile(join(fresh, '.papergod', 'project.json'), 'utf-8')));
  assert.ok(result.project.libraries.corpora.length >= 3);
  assert.ok(result.project.libraries.sentencePatterns.length >= 8);
  assert.ok(result.project.libraries.vocabulary.global.length >= 10);
  const second = await initializeWorkspace(fresh);
  assert.equal(second.project.libraries.sentencePatterns.length, result.project.libraries.sentencePatterns.length);
});

test('initializeWorkspace demo mode seeds a complete built-in testing workspace', async () => {
  const fresh = join(tmpWorkspace, 'fresh-demo');
  const result = await initializeWorkspace(fresh, { demo: true });
  assert.equal(result.createdSample, true);
  assert.match(await readFile(join(fresh, 'main.tex'), 'utf-8'), /Papergod Demo/);
  assert.match(result.project.project.corePrompt, /evidence alignment/i);
  assert.ok(result.project.documents[0].corePrompt);
  assert.ok(result.project.documents[0].sections.every((section) => section.prompt));
  assert.ok(result.project.libraries.corpora.length >= 5);
  assert.ok(result.project.libraries.sentencePatterns.length >= 11);
  assert.ok(result.project.libraries.vocabulary.global.length >= 12);
  assert.equal(result.project.libraries.vocabulary.session.length, 1);
  assert.equal(result.project.annotations.length, 2);
});

test('Workspace API switches local papers and keeps Agent selections isolated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'papergod-workspaces-'));
  const first = join(root, 'paper-one');
  const second = join(root, 'paper-two');
  const registryFile = join(root, 'registry.json');
  await mkdir(first);
  await mkdir(second);
  await writeFile(join(first, 'main.tex'), '\\documentclass{article}\\begin{document}FIRST PAPER\\end{document}', 'utf8');
  await writeFile(join(second, 'paper.tex'), '\\documentclass{article}\\begin{document}SECOND PAPER\\end{document}', 'utf8');
  await initializeWorkspace(first);
  const workspaceApp = createApp(first, { workspaceRegistryFile: registryFile });
  const workspaceServer = await new Promise((resolveListen) => {
    const instance = workspaceApp.listen(0, '127.0.0.1', () => resolveListen(instance));
  });
  const rootUrl = `http://127.0.0.1:${workspaceServer.address().port}`;
  const request = async (path, options = {}) => {
    const response = await fetch(rootUrl + path, { method: options.method || 'GET', headers: { 'Content-Type': 'application/json' }, body: options.body ? JSON.stringify(options.body) : undefined });
    return { response, data: await response.json() };
  };
  try {
    let result = await request('/api/agents/config', { method: 'PUT', body: { id: 'codex', command: 'codex', args: [], model: '', activate: true } });
    assert.equal(result.response.status, 200);
    result = await request('/api/workspaces', { method: 'POST', body: { path: second } });
    assert.equal(result.response.status, 201);
    assert.equal(result.data.workspace.path, second);
    result = await request('/api/files/paper.tex');
    assert.match(result.data.content, /SECOND PAPER/);
    result = await request('/api/config');
    assert.equal(result.data.provider, 'mock');
    result = await request('/api/workspaces');
    assert.equal(result.data.workspaces.length, 2);
    const firstEntry = result.data.workspaces.find((item) => item.path === first);
    result = await request(`/api/workspaces/${firstEntry.id}/activate`, { method: 'POST' });
    assert.equal(result.response.status, 200);
    result = await request('/api/config');
    assert.equal(result.data.provider, 'codex');
    const staticPaper = await fetch(`${rootUrl}/workspace/main.tex`);
    assert.match(await staticPaper.text(), /FIRST PAPER/);
  } finally {
    await new Promise((resolveClose) => workspaceServer.close(resolveClose));
    await rm(root, { recursive: true, force: true });
  }
});

test('Workspace folder browser lists home directories and blocks paths outside home', async () => {
  let result = await api('/api/workspaces/browse?path=' + encodeURIComponent(PROJECT_ROOT));
  assert.equal(result.status, 200);
  assert.equal(result.data.currentPath, PROJECT_ROOT);
  assert.ok(Array.isArray(result.data.entries));
  assert.ok(result.data.entries.some((entry) => entry.name === 'src'));
  result = await api('/api/workspaces/browse?path=' + encodeURIComponent('/tmp'));
  assert.equal(result.status, 403);
  assert.equal(result.data.code, 'BROWSE_OUTSIDE_ROOT');
});

test('Workspace terminal runs an interactive command in the active workspace', async () => {
  const started = await api('/api/terminal', { method: 'POST' });
  assert.equal(started.status, 201);
  assert.equal(started.data.session.workspace, tmpWorkspace);
  const id = started.data.session.id;
  const controller = new AbortController();
  const events = await fetch(`${baseUrl}/api/terminal/${encodeURIComponent(id)}/events`, { signal: controller.signal });
  assert.equal(events.status, 200);
  const input = await api(`/api/terminal/${encodeURIComponent(id)}/input`, { method: 'POST', body: { data: "printf 'PAPERGOD_TERMINAL_OK\\n'\r" } });
  assert.equal(input.status, 200);
  const reader = events.body.getReader();
  const decoder = new TextDecoder();
  let output = '';
  const deadline = Date.now() + 5000;
  while (!output.includes('PAPERGOD_TERMINAL_OK') && Date.now() < deadline) {
    const result = await Promise.race([reader.read(), new Promise((resolveRead) => setTimeout(() => resolveRead({ timeout: true }), 250))]);
    if (result.timeout) continue;
    if (result.done) break;
    output += decoder.decode(result.value, { stream: true });
  }
  controller.abort();
  assert.match(output, /PAPERGOD_TERMINAL_OK/);
  const stopped = await api(`/api/terminal/${encodeURIComponent(id)}`, { method: 'DELETE' });
  assert.equal(stopped.status, 200);
});

test('Reference core parses nested BibTeX, serializes records, and validates LaTeX citekeys', () => {
  const source = `@article{smith2024reliable,
    title = {A {Reliable} Reference Pipeline},
    author = {Smith, Jane and Doe, John},
    year = {2024},
    doi = {10.1234/example.42}
  }`;
  const items = parseBibTeX(source, '/papers/library.bib');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'A Reliable Reference Pipeline');
  assert.deepEqual(items[0].authors, ['Smith, Jane', 'Doe, John']);
  assert.equal(items[0].doi, '10.1234/example.42');
  assert.match(serializeReference(items[0]), /@article\{smith2024reliable/);
  const check = checkCitations('Evidence \\cite{smith2024reliable,missing2025}.\\bibliography{references}', items);
  assert.deepEqual(check.cited, ['smith2024reliable', 'missing2025']);
  assert.deepEqual(check.missing, ['missing2025']);
  assert.equal(check.bibliographyConfigured, true);
  assert.match(buildCitationContext(items, ['smith2024reliable']), /Only use citation keys listed above/);
  assert.deepEqual(findUnknownAgentCitations([{ suggestedText: '\\cite{smith2024reliable,invented2026}' }], '', items), ['invented2026']);
  assert.deepEqual(findUnknownAgentCitations([{ suggestedText: '\\cite{legacyKey}' }], '\\cite{legacyKey}', []), []);
});

test('Reference folder and API form a BibTeX import, write, and citation-check workflow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'papergod-references-'));
  const paper = join(root, 'paper');
  const literature = join(root, 'literature');
  await mkdir(paper); await mkdir(literature);
  await writeFile(join(paper, 'main.tex'), '\\documentclass{article}\\begin{document}\\cite{alpha2023,missing}\\bibliography{references}\\end{document}', 'utf8');
  await writeFile(join(literature, 'sources.bib'), '@article{alpha2023,title={Alpha Study},author={Ada Alpha},year={2023},doi={10.1000/alpha}}\n@inproceedings{beta2024,title={Beta Study},author={Bob Beta},year={2024}}', 'utf8');
  const scanned = await scanReferenceFolder(literature);
  assert.equal(scanned.items.length, 2);
  const referenceApp = createApp(paper, { workspaceRegistryFile: join(root, 'registry.json') });
  const referenceServer = await new Promise((resolveListen) => {
    const instance = referenceApp.listen(0, '127.0.0.1', () => resolveListen(instance));
  });
  const url = `http://127.0.0.1:${referenceServer.address().port}`;
  const call = async (path, options = {}) => {
    const response = await fetch(url + path, { method: options.method || 'GET', headers: { 'Content-Type': 'application/json' }, body: options.body ? JSON.stringify(options.body) : undefined });
    return { response, data: await response.json() };
  };
  try {
    let result = await call('/api/references/folders', { method: 'POST', body: { path: literature } });
    assert.equal(result.response.status, 201);
    assert.equal(result.data.state.items.length, 2);
    result = await call('/api/references/bibliography', { method: 'POST' });
    assert.equal(result.data.count, 2);
    assert.match(await readFile(join(paper, 'references.bib'), 'utf8'), /alpha2023/);
    result = await call('/api/references/check', { method: 'POST', body: { file: 'main.tex' } });
    assert.deepEqual(result.data.missing, ['missing']);
    result = await call('/api/references?q=beta');
    assert.equal(result.data.items.length, 1);
  } finally {
    await new Promise((resolveClose) => referenceServer.close(resolveClose));
    await rm(root, { recursive: true, force: true });
  }
});

test('Zotero adapter detects Better BibTeX, searches collections, and reads PDF full text', async () => {
  const fakeFetch = async (url, options = {}) => {
    const value = String(url);
    if (value.endsWith('/api/')) return new Response('{}', { headers: { 'Zotero-API-Version': '3', 'Zotero-Server-ID': 'test-server' } });
    if (value.includes('/better-bibtex/')) {
      const requestBody = JSON.parse(options.body);
      return Response.json({ jsonrpc: '2.0', id: 1, result: requestBody.method === 'item.export' ? '@article{smith2025zotero,title={Zotero Paper},year={2025}}' : { zotero: '8.0', betterbibtex: '8.1' } });
    }
    if (value.includes('/collections?')) return Response.json([{ key: 'COLL0001', version: 2, data: { name: 'Paper Sources', parentCollection: false } }]);
    if (value.includes('/items/top?')) return Response.json([{ key: 'ITEM0001', version: 3, data: { itemType: 'journalArticle', title: 'Zotero Paper', creators: [{ firstName: 'Jane', lastName: 'Smith' }], date: '2025', DOI: '10.1000/zotero', citationKey: 'smith2025zotero', publicationTitle: 'Test Journal' } }]);
    if (value.endsWith('/items/ITEM0001/children')) return Response.json([{ key: 'PDF00001', data: { itemType: 'attachment', contentType: 'application/pdf', title: 'Full Text PDF' } }]);
    if (value.endsWith('/items/PDF00001/fulltext')) return Response.json({ content: 'Indexed Zotero PDF content', indexedPages: 4, totalPages: 4 });
    return new Response('not found', { status: 404 });
  };
  const options = { baseUrl: 'http://zotero.test', fetchImpl: fakeFetch };
  const status = await getZoteroStatus(options);
  assert.equal(status.connected, true);
  assert.equal(status.betterBibtex.betterbibtex, '8.1');
  assert.equal((await listZoteroCollections(options))[0].name, 'Paper Sources');
  const items = await searchZoteroItems(options);
  assert.equal(items[0].citekey, 'smith2025zotero');
  const enriched = await enrichZoteroAttachment(items[0], options);
  assert.equal(enriched.attachmentKey, 'PDF00001');
  assert.match((await getZoteroFullText('PDF00001', options)).content, /Indexed Zotero/);
  assert.match(await exportBetterBibTeX(['smith2025zotero'], options), /@article/);
});

test('initializeWorkspace adopts an existing TeX document', async () => {
  const existing = join(tmpWorkspace, 'existing-paper');
  await mkdir(existing);
  await writeFile(join(existing, 'article.tex'), '\\documentclass{article}', 'utf-8');
  const result = await initializeWorkspace(existing);
  assert.equal(result.createdSample, false);
  assert.equal(result.project.documents[0].file, 'article.tex');
});

test('package manifest exposes publishable papergod binary', async () => {
  const packageData = JSON.parse(await readFile(join(PROJECT_ROOT, 'package.json'), 'utf-8'));
  assert.equal(packageData.bin.papergod, './src/cli.js');
  assert.ok(packageData.files.includes('public'));
  assert.ok(packageData.files.includes('src'));
  assert.ok(packageData.files.includes('example/main.tex'));
  assert.ok(packageData.files.includes('papergod-demo.png'));
  assert.match(packageData.scripts.papergod, /--resume/);
  assert.doesNotMatch(packageData.scripts.papergod, /\bworkspace\b/);
});

test('papergod CLI executes through an npm-style bin symlink', async (t) => {
  if (process.platform === 'win32') return t.skip('Windows symlinks require developer mode');
  const binLink = join(tmpWorkspace, 'papergod-bin');
  await symlink(join(PROJECT_ROOT, 'src', 'cli.js'), binLink);
  const result = await runProcess(binLink, ['--version'], { cwd: tmpWorkspace, timeoutMs: 5000 });
  const packageData = JSON.parse(await readFile(join(PROJECT_ROOT, 'package.json'), 'utf-8'));
  assert.equal(result.stdout.trim(), packageData.version);
});

test('startServer runs an initialized workspace with selected provider', async () => {
  const workspace = join(tmpWorkspace, 'cli-start-paper');
  await initializeWorkspace(workspace);
  const cliServer = await startServer({ workspaceRoot: workspace, port: 0, provider: 'opencode', workspaceRegistryFile: join(tmpWorkspace, 'cli-workspaces.json') });
  try {
    const address = cliServer.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/config`);
    assert.equal(response.status, 200);
    const config = await response.json();
    assert.equal(config.provider, 'opencode');
    assert.equal(config.workspace, workspace);
  } finally {
    await new Promise((resolveClose) => cliServer.close(resolveClose));
  }
});

test('Agent response parser accepts JSON and JSONL text events', () => {
  const payload = { summary: 'One edit.', suggestions: [], usedResourceIds: [] };
  assert.deepEqual(parseAgentJson(JSON.stringify(payload)), payload);
  const event = JSON.stringify({ type: 'message', part: { text: JSON.stringify(payload) } });
  assert.deepEqual(parseAgentJson(event), payload);
  const fencedEvent = JSON.stringify({ type: 'text', part: { text: `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`` } });
  assert.deepEqual(parseAgentJson(fencedEvent), payload);
  const claudeResult = JSON.stringify({ type: 'result', structured_output: payload, result: '' });
  assert.deepEqual(parseAgentJson(claudeResult), payload);
  const piResult = JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(payload) }] } });
  assert.deepEqual(parseAgentJson(piResult), payload);
});

test('Codex output schemas use only supported structured-output keywords', () => {
  for (const schema of [SUGGESTION_OUTPUT_SCHEMA, PAPER_GENERATION_OUTPUT_SCHEMA, REVIEW_ORCHESTRATION_OUTPUT_SCHEMA]) {
    assert.equal(JSON.stringify(schema).includes('uniqueItems'), false);
  }
});

test('Agent response validation requires exact source text', () => {
  const response = {
    summary: 'Edit wording.',
    usedResourceIds: [],
    suggestions: [{
      category: 'style', description: 'Improve precision', originalText: 'missing phrase',
      suggestedText: 'precise phrase', reason: 'Academic tone',
    }],
  };
  const validation = validateSuggestionResponse(response, 'The actual document.');
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.includes('not found')));
});

test('Agent response validation rejects unprovided resource provenance', () => {
  const response = { summary: '', suggestions: [], usedResourceIds: ['invented_resource'] };
  const validation = validateSuggestionResponse(response, 'Document', ['provided_resource']);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.includes('was not provided')));
});

test('Codex, Claude Code, OpenCode, and Pi adapters use structured output through fake CLIs', async () => {
  const fakeCli = join(tmpWorkspace, 'fake-agent.mjs');
  await writeFile(fakeCli, `
import { readFileSync, writeFileSync } from 'fs';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('fake-agent 1.0.0\\n');
  process.exit(0);
}
if (args.includes('--output-format') && (!args.includes('--json-schema') || args[args.indexOf('--model') + 1] !== 'test-model')) {
  process.stderr.write('Claude structured output or model flag missing');
  process.exit(2);
}
if (args[0] === 'run') {
  const directory = args[args.indexOf('--dir') + 1];
  if (!args.includes('--pure') || args[args.indexOf('--format') + 1] !== 'json' || JSON.parse(readFileSync(directory + '/opencode.json', 'utf8')).permission !== 'deny') {
    process.stderr.write('OpenCode isolation flags missing'); process.exit(2);
  }
}
if (args.includes('--mode') && (args[args.indexOf('--mode') + 1] !== 'json' || !args.includes('--no-tools') || !args.includes('--no-session') || !args.includes('--no-context-files'))) {
  process.stderr.write('Pi analysis-only flags missing'); process.exit(2);
}
const response = JSON.stringify({
  summary: 'One precise edit.',
  usedResourceIds: [],
  suggestions: [{ category: 'style', description: 'Use precise language', originalText: 'very important', suggestedText: 'crucial', reason: 'Avoid intensifiers' }]
});
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex !== -1) writeFileSync(args[outputIndex + 1], response);
else process.stdout.write(JSON.stringify({ type: 'text', part: { text: response } }) + '\\n');
`, 'utf-8');
  const commands = {
    codex: { command: process.execPath, args: [fakeCli] },
    'claude-code': { command: process.execPath, args: [fakeCli], model: 'test-model' },
    opencode: { command: process.execPath, args: [fakeCli] },
    pi: { command: process.execPath, args: [fakeCli] },
  };
  const request = { prompt: 'Improve precision.', content: 'This result is very important.' };
  const codex = await runWritingAgent('codex', request, { workspaceRoot: tmpWorkspace, commands });
  const claude = await runWritingAgent('claude-code', request, { workspaceRoot: tmpWorkspace, commands });
  const opencode = await runWritingAgent('opencode', request, { workspaceRoot: tmpWorkspace, commands });
  const pi = await runWritingAgent('pi', request, { workspaceRoot: tmpWorkspace, commands });
  assert.equal(codex.suggestions[0].suggestedText, 'crucial');
  assert.deepEqual(claude, codex);
  assert.deepEqual(opencode, codex);
  assert.deepEqual(pi, codex);
  const providers = await detectAgentProviders({ commands });
  assert.ok(providers.every((provider) => provider.available));
});

test('Codex, Claude Code, OpenCode, and Pi peer-review adapters enforce structured reports', async () => {
  const fakeCli = join(tmpWorkspace, 'fake-review-agent.mjs');
  await writeFile(fakeCli, `
import { writeFileSync } from 'fs';
const args = process.argv.slice(2);
const response = JSON.stringify({
  summary: 'Independent review.', verdict: 'major-revision', confidence: 0.9,
  items: [{ rubricId: 'rigor', kind: 'concern', category: 'method', severity: 'major', body: 'Clarify the comparison protocol.', suggestedFix: '', quote: 'Our method is very important.' }]
});
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex !== -1) writeFileSync(args[outputIndex + 1], response);
else process.stdout.write(JSON.stringify({ type: 'text', part: { text: response } }) + '\\n');
`, 'utf-8');
  const commands = {
    codex: { command: process.execPath, args: [fakeCli] },
    'claude-code': { command: process.execPath, args: [fakeCli] },
    opencode: { command: process.execPath, args: [fakeCli] },
    pi: { command: process.execPath, args: [fakeCli] },
  };
  const request = {
    content: 'Our method is very important.',
    reviewer: { id: 'methods', name: 'Methods', role: 'methodology', focus: 'Validity', prompt: '' },
    rubric: [{ id: 'rigor', title: 'Rigor', instruction: 'Check validity.', weight: 1 }],
  };
  const codex = await runAcademicReviewAgent('codex', request, { workspaceRoot: tmpWorkspace, commands });
  const claude = await runAcademicReviewAgent('claude-code', request, { workspaceRoot: tmpWorkspace, commands });
  const opencode = await runAcademicReviewAgent('opencode', request, { workspaceRoot: tmpWorkspace, commands });
  const pi = await runAcademicReviewAgent('pi', request, { workspaceRoot: tmpWorkspace, commands });
  assert.equal(codex.items[0].rubricId, 'rigor');
  assert.deepEqual(claude, codex);
  assert.deepEqual(opencode, codex);
  assert.deepEqual(pi, codex);
});

test('Codex, Claude Code, OpenCode, and Pi full-paper adapters validate complete safe LaTeX', async () => {
  const fakeCli = join(tmpWorkspace, 'fake-paper-agent.mjs');
  await writeFile(fakeCli, `
import { writeFileSync } from 'fs';
const args = process.argv.slice(2);
const response = JSON.stringify({ summary: 'Complete draft.', latex: '\\\\documentclass{article}\\n\\\\begin{document}Draft.\\\\end{document}', usedResourceIds: [] });
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex !== -1) writeFileSync(args[outputIndex + 1], response);
else process.stdout.write(JSON.stringify({ type: 'text', part: { text: response } }) + '\\n');
`, 'utf-8');
  const commands = {
    codex: { command: process.execPath, args: [fakeCli] },
    'claude-code': { command: process.execPath, args: [fakeCli] },
    opencode: { command: process.execPath, args: [fakeCli] },
    pi: { command: process.execPath, args: [fakeCli] },
  };
  const request = { instruction: 'Draft.', projectContext: '', outlineContext: '', resourceContext: '', resourceIds: [] };
  const codex = await runPaperGenerationAgent('codex', request, { workspaceRoot: tmpWorkspace, commands });
  const claude = await runPaperGenerationAgent('claude-code', request, { workspaceRoot: tmpWorkspace, commands });
  const opencode = await runPaperGenerationAgent('opencode', request, { workspaceRoot: tmpWorkspace, commands });
  const pi = await runPaperGenerationAgent('pi', request, { workspaceRoot: tmpWorkspace, commands });
  assert.match(codex.latex, /documentclass/);
  assert.deepEqual(claude, codex);
  assert.deepEqual(opencode, codex);
  assert.deepEqual(pi, codex);
  assert.deepEqual(parsePaperGenerationJson(JSON.stringify(codex)), codex);
  assert.equal(validatePaperGenerationResponse({ ...codex, latex: '\\documentclass{article}\\begin{document}\\immediate\\write18{bad}\\end{document}' }, []).ok, false);
});

test('Codex, Claude Code, OpenCode, and Pi review orchestrators return atomic anchored dependencies', async () => {
  const fakeCli = join(tmpWorkspace, 'fake-orchestrator-agent.mjs');
  await writeFile(fakeCli, `
import { writeFileSync } from 'fs';
const args = process.argv.slice(2);
const response = JSON.stringify({ summary: 'Two atomic opinions.', opinions: [
  { body: 'Use precise wording.', category: 'style', severity: 'minor', quote: 'very important', suggestedFix: 'crucial', dependsOn: [] },
  { body: 'Support the claim with evidence.', category: 'evidence', severity: 'major', quote: 'central claim', suggestedFix: '', dependsOn: [1] }
] });
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex !== -1) writeFileSync(args[outputIndex + 1], response);
else process.stdout.write(JSON.stringify({ type: 'text', part: { text: response } }) + '\\n');
`, 'utf-8');
  const commands = { codex: { command: process.execPath, args: [fakeCli] }, 'claude-code': { command: process.execPath, args: [fakeCli] }, opencode: { command: process.execPath, args: [fakeCli] }, pi: { command: process.execPath, args: [fakeCli] } };
  const request = { feedback: 'Improve wording and evidence.', content: 'This very important central claim needs support.', outlineContext: 'One paragraph.' };
  const codex = await runReviewOrchestrationAgent('codex', request, { workspaceRoot: tmpWorkspace, commands });
  const claude = await runReviewOrchestrationAgent('claude-code', request, { workspaceRoot: tmpWorkspace, commands });
  const opencode = await runReviewOrchestrationAgent('opencode', request, { workspaceRoot: tmpWorkspace, commands });
  const pi = await runReviewOrchestrationAgent('pi', request, { workspaceRoot: tmpWorkspace, commands });
  assert.deepEqual(claude, codex);
  assert.deepEqual(opencode, codex);
  assert.deepEqual(pi, codex);
  assert.deepEqual(parseReviewOrchestrationJson(JSON.stringify(codex)), codex);
  assert.equal(validateReviewOrchestrationResponse(codex, request.content).ok, true);
  assert.equal(validateReviewOrchestrationResponse({ ...codex, opinions: [{ ...codex.opinions[0], quote: 'invented' }] }, request.content).ok, false);
});

test('Agent process enforces timeout', async () => {
  await assert.rejects(
    runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { timeoutMs: 25 }),
    (error) => error.code === 'AGENT_TIMEOUT',
  );
});

test('Agent process supports cancellation', async () => {
  const controller = new AbortController();
  const running = runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], {
    timeoutMs: 5000, signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(running, (error) => error.code === 'AGENT_CANCELLED');
});

test('Agent process streams stdout and stderr to an activity listener', async () => {
  const events = [];
  await runProcess(process.execPath, ['-e', "process.stdout.write('working\\n'); process.stderr.write('checking\\n')"], {
    onOutput: (stream, chunk) => events.push({ stream, chunk }),
  });
  assert.ok(events.some((item) => item.stream === 'stdout' && item.chunk.includes('working')));
  assert.ok(events.some((item) => item.stream === 'stderr' && item.chunk.includes('checking')));
});

test('Change history reconstructs, previews, and restores any of five recent versions safely', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'papergod-change-history-'));
  try {
    let content = '\\documentclass{article}\\begin{document}Version 0.\\end{document}';
    await writeFile(join(workspace, 'main.tex'), content, 'utf-8');
    await initializeWorkspace(workspace);
    let latest;
    for (let version = 1; version <= 6; version += 1) {
      const before = `Version ${version - 1}`;
      const after = `Version ${version}`;
      latest = await applySuggestionsAsRevision(workspace, 'main.tex', [{ originalText: before, suggestedText: after, category: 'content', reason: `Advance to ${version}` }]);
      content = latest.content;
    }
    const history = await getRecentChangeHistory(workspace, latest.revision.documentId, 5);
    assert.equal(history.length, 5);
    assert.equal(history[0].id, latest.revision.id);
    assert.equal(history[0].isLatest, true);
    assert.equal(history[0].canRollback, true);
    assert.equal(content.slice(history[0].changes[0].currentStart, history[0].changes[0].currentEnd), 'Version 6');
    assert.ok(history.slice(1).every((entry) => entry.canRollback === false && entry.canRestore === true));
    const target = history.find((entry) => entry.changes[0].after === 'Version 3');
    const historical = await getHistoricalRevisionSource(workspace, target.id);
    assert.match(historical.source, /Version 3/);
    const restored = await restoreRevisionVersion(workspace, target.id);
    assert.match(restored.content, /Version 3/);
    assert.equal(restored.revision.origin, 'history-restore');
    assert.equal(restored.revision.restoredRevisionId, target.id);
    assert.match(await readFile(join(workspace, restored.recoveryPoint.path), 'utf-8'), /Version 6/);
    content = restored.content;
    await writeFile(join(workspace, 'main.tex'), content.replace('Version 3', 'Version 3 with manual follow-up'), 'utf-8');
    const afterManualEdit = await getRecentChangeHistory(workspace, latest.revision.documentId, 5);
    assert.equal(afterManualEdit[0].canRollback, false);
    await writeFile(join(workspace, 'main.tex'), content, 'utf-8');
    const deleted = await applySuggestionsAsRevision(workspace, 'main.tex', [{ originalText: 'Version 3', suggestedText: '', category: 'content', reason: 'Remove obsolete version label' }]);
    const afterDeletion = await getRecentChangeHistory(workspace, deleted.revision.documentId, 5);
    assert.equal(afterDeletion[0].changes[0].type, 'deleted');
    assert.equal(afterDeletion[0].changes[0].after, '');
    assert.ok(afterDeletion[0].changes[0].contextBefore);
    assert.ok(afterDeletion[0].changes[0].contextAfter);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('External Agent API persists auditable run records', async () => {
  const fakeCli = join(tmpWorkspace, 'fake-codex-api.mjs');
  await writeFile(fakeCli, `
import { writeFileSync } from 'fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('fake-codex 1.0\\n'); process.exit(0); }
process.stdout.write('Analyzing manuscript scope...\\n');
const outputIndex = args.indexOf('--output-last-message');
writeFileSync(args[outputIndex + 1], JSON.stringify({ summary: 'API edit.', usedResourceIds: [], suggestions: [{ category: 'style', description: 'Precise wording', originalText: 'very important', suggestedText: 'crucial', reason: 'Precision' }] }));
`, 'utf-8');
  const agentApp = createApp(tmpWorkspace, {
    provider: 'codex', agentCommands: { codex: { command: process.execPath, args: [fakeCli] } },
  });
  const agentServer = await new Promise((resolveListen) => {
    const instance = agentApp.listen(0, '127.0.0.1', () => resolveListen(instance));
  });
  try {
    const address = agentServer.address();
    const root = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${root}/api/agent/suggest`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Improve.', content: 'This is very important.', activityId: 'activity-test-1234' }),
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.provider, 'codex');
    assert.ok(data.runId);
    assert.equal(data.suggestions[0].suggestedText, 'crucial');
    const runs = await (await fetch(`${root}/api/agent/runs`)).json();
    const run = runs.runs.find((item) => item.id === data.runId);
    assert.equal(run.status, 'complete');
    assert.ok(run.startedAt);
    assert.ok(run.finishedAt);
    const activityResponse = await fetch(`${root}/api/agent/activity/activity-test-1234`);
    assert.equal(activityResponse.status, 200);
    const activity = await activityResponse.json();
    assert.equal(activity.status, 'complete');
    assert.match(activity.output, /Analyzing manuscript scope/);
    assert.doesNotMatch(activity.output, /Current editing request/);
  } finally {
    await new Promise((resolveClose) => agentServer.close(resolveClose));
  }
});

test('Agent probe can perform a real structured-response live test', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'papergod-agent-probe-'));
  const fakeCli = join(workspace, 'fake-live-codex.mjs');
  await initializeWorkspace(workspace);
  await writeFile(fakeCli, `
import { writeFileSync } from 'fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('fake-codex 1.0\\n'); process.exit(0); }
if (args.includes('login') && args.includes('status')) { process.stdout.write('Logged in\\n'); process.exit(0); }
if (!args.includes('model_reasoning_effort="low"')) { process.stderr.write('Live test did not use low reasoning effort'); process.exit(2); }
const outputIndex = args.indexOf('--output-last-message');
writeFileSync(args[outputIndex + 1], JSON.stringify({ summary: 'Live structured response.', usedResourceIds: [], suggestions: [{ category: 'style', description: 'Remove an intensifier', originalText: 'very important', suggestedText: 'important', reason: 'Academic precision' }] }));
`, 'utf-8');
  const probeApp = createApp(workspace, {
    provider: 'codex', agentCommands: { codex: { command: process.execPath, args: [fakeCli] } },
  });
  const probeServer = await new Promise((resolveListen) => {
    const instance = probeApp.listen(0, '127.0.0.1', () => resolveListen(instance));
  });
  try {
    const root = `http://127.0.0.1:${probeServer.address().port}`;
    const response = await fetch(`${root}/api/agents/probe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'codex', live: true }),
    });
    assert.equal(response.status, 202);
    const queued = await response.json();
    assert.match(queued.test.id, /^agent_probe_/);
    let testResult;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await (await fetch(`${root}/api/agents/probe/${queued.test.id}`)).json();
      testResult = status.test;
      if (['complete', 'failed', 'cancelled'].includes(testResult.status)) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    assert.equal(testResult.status, 'complete');
    assert.equal(testResult.agent.authenticated, true);
    assert.equal(testResult.liveTest.ok, true);
    assert.match(testResult.liveTest.summary, /Live structured response/);
  } finally {
    await new Promise((resolveClose) => probeServer.close(resolveClose));
    await rm(workspace, { recursive: true, force: true });
  }
});

test('Saved Claude Code configuration activates and reloads for real API runs', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'papergod-claude-config-'));
  const fakeCli = join(workspace, 'fake-claude.mjs');
  await writeFile(join(workspace, 'main.tex'), '\\documentclass{article}\\begin{document}This is very important.\\end{document}', 'utf-8');
  await writeFile(fakeCli, `
import process from 'process';
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('fake-claude 1.0\\n'); process.exit(0); }
if (args.includes('auth') && args.includes('status')) { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'test' })); process.exit(0); }
if (args[args.indexOf('--model') + 1] !== 'configured-model') { process.stderr.write('model override missing'); process.exit(2); }
const payload = { summary: 'Claude edit.', usedResourceIds: [], suggestions: [{ category: 'style', description: 'Precise wording', originalText: 'very important', suggestedText: 'crucial', reason: 'Precision' }] };
process.stdout.write(JSON.stringify({ type: 'result', structured_output: payload, result: '' }));
`, 'utf-8');
  await initializeWorkspace(workspace);
  const claudeApp = createApp(workspace);
  let claudeServer = await new Promise((resolveListen) => {
    const instance = claudeApp.listen(0, '127.0.0.1', () => resolveListen(instance));
  });
  try {
    let root = `http://127.0.0.1:${claudeServer.address().port}`;
    const configured = await fetch(`${root}/api/agents/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'claude-code', command: process.execPath, args: [fakeCli], model: 'configured-model', activate: true }),
    });
    assert.equal(configured.status, 200);
    await new Promise((resolveClose) => claudeServer.close(resolveClose));
    const restartedApp = createApp(workspace, { provider: 'claude-code' });
    claudeServer = await new Promise((resolveListen) => {
      const instance = restartedApp.listen(0, '127.0.0.1', () => resolveListen(instance));
    });
    root = `http://127.0.0.1:${claudeServer.address().port}`;
    const suggestion = await fetch(`${root}/api/agent/suggest`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Improve.', content: 'This is very important.' }),
    });
    assert.equal(suggestion.status, 200);
    const data = await suggestion.json();
    assert.equal(data.provider, 'claude-code');
    assert.equal(data.suggestions[0].suggestedText, 'crucial');
    const project = JSON.parse(await readFile(join(workspace, '.papergod', 'project.json'), 'utf-8'));
    assert.equal(project.project.agentProfiles['claude-code'].model, 'configured-model');
  } finally {
    await new Promise((resolveClose) => claudeServer.close(resolveClose));
    await rm(workspace, { recursive: true, force: true });
  }
});

test('Library APIs create, update, list, and delete corpus records', async () => {
  const created = await api('/api/libraries/corpora', {
    method: 'POST',
    body: {
      name: 'Algorithm descriptions',
      description: 'Reusable descriptions for optimization methods.',
      content: 'We optimize the objective using {algorithm}.',
      source: 'curated',
      tags: ['methods'],
    },
  });
  assert.equal(created.status, 201);
  assert.ok(created.data.item.id.startsWith('corpus_'));

  const updated = await api(`/api/libraries/corpora/${created.data.item.id}`, {
    method: 'PUT', body: { tags: ['methods', 'optimization'] },
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.data.item.tags, ['methods', 'optimization']);
  assert.equal(updated.data.item.name, 'Algorithm descriptions');

  const listed = await api('/api/libraries');
  assert.ok(listed.data.libraries.corpora.some((item) => item.id === created.data.item.id));

  const removed = await api(`/api/libraries/corpora/${created.data.item.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  const after = await api('/api/libraries');
  assert.ok(!after.data.libraries.corpora.some((item) => item.id === created.data.item.id));
});

test('Vocabulary APIs preserve concurrent global and session updates', async () => {
  const requests = [
    api('/api/libraries/vocabulary/global', { method: 'POST', body: { term: 'accuracy', preferred: 'predictive accuracy' } }),
    api('/api/libraries/vocabulary/global', { method: 'POST', body: { term: 'result', preferred: 'finding' } }),
    api('/api/libraries/vocabulary/session', { method: 'POST', body: { term: 'our model', preferred: 'PapergodNet' } }),
  ];
  const results = await Promise.all(requests);
  assert.ok(results.every((result) => result.status === 201));
  const listed = await api('/api/libraries');
  assert.equal(listed.data.libraries.vocabulary.global.length, 2);
  assert.equal(listed.data.libraries.vocabulary.session.length, 1);
});

test('Library APIs reject invalid resources and scopes', async () => {
  const missingName = await api('/api/libraries/sentence-patterns', {
    method: 'POST', body: { template: 'Our results show that {finding}.' },
  });
  assert.equal(missingName.status, 400);
  assert.ok(missingName.data.details.some((detail) => detail.includes('.name')));
  const badScope = await api('/api/libraries/vocabulary/team', {
    method: 'POST', body: { term: 'method' },
  });
  assert.equal(badScope.status, 400);
});

test('Library engine merges session vocabulary over global terms', () => {
  const stamp = new Date().toISOString();
  const base = (id, term, preferred) => ({
    id, term, preferred, definition: '', source: '', alternatives: [], examples: [], tags: [], createdAt: stamp, updatedAt: stamp,
  });
  const libraries = {
    corpora: [], sentencePatterns: [],
    vocabulary: {
      global: [base('v_global', 'model', 'predictive model')],
      session: [base('v_session', 'model', 'PapergodNet')],
    },
  };
  const merged = mergedVocabulary(libraries);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].preferred, 'PapergodNet');
  assert.equal(merged[0].scope, 'session');
});

test('Library engine searches by tags and applicable section', () => {
  const pattern = (id, name, sectionTypes, tags) => ({
    id, name, template: `${name} {finding}.`, description: '', source: '', tags, sectionTypes,
    slots: [{ name: 'finding', description: '', required: true }], createdAt: 'now', updatedAt: 'now',
  });
  const libraries = {
    corpora: [], vocabulary: { global: [], session: [] },
    sentencePatterns: [
      pattern('p_method', 'Method framing', ['Methods'], ['algorithm']),
      pattern('p_result', 'Result framing', ['Results'], ['finding']),
    ],
  };
  const results = searchLibraries(libraries, { query: 'finding', sectionType: 'Results' });
  assert.deepEqual(results.sentencePatterns.map((item) => item.id), ['p_result']);
});

test('Library context supports explicit selection and pattern slot rendering', () => {
  const item = {
    id: 'pattern_explicit', name: 'Finding claim', template: 'Our results show that {finding}.',
    description: '', source: 'curated', tags: ['results'], sectionTypes: ['Results'],
    slots: [{ name: 'finding', description: 'Main finding', required: true }], createdAt: 'now', updatedAt: 'now',
  };
  const libraries = { corpora: [], sentencePatterns: [item], vocabulary: { global: [], session: [] } };
  const context = buildLibraryContext(libraries, { resourceIds: [item.id] });
  assert.equal(context.mode, 'selected');
  assert.deepEqual(context.resourceIds, [item.id]);
  assert.match(context.prompt, /SENTENCE_PATTERN pattern_explicit/);
  assert.equal(renderSentencePattern(item, { finding: 'accuracy improves' }).rendered, 'Our results show that accuracy improves.');
  assert.throws(() => renderSentencePattern(item, {}), /Missing required pattern slots/);
  assert.equal(composeMockParagraph(libraries, context, 'Discuss results').usedResourceIds[0], item.id);
});

test('Library extraction produces confirmable patterns and session vocabulary', () => {
  const content = `\\section{Methods} We optimize the representation iteratively. The representation improves convergence. The representation supports classification.`;
  const candidates = extractLibraryCandidates(content, 'paper.tex');
  assert.ok(candidates.patterns.length > 0);
  assert.ok(candidates.vocabulary.some((candidate) => candidate.value.term === 'representation'));
  assert.ok(candidates.patterns.every((candidate) => candidate.value.source === 'paper.tex'));
});

test('Library search, rendering, and extraction APIs form a usable workflow', async () => {
  const patternCreated = await api('/api/libraries/sentence-patterns', {
    method: 'POST', body: {
      name: 'Algorithm comparison', template: '{method} outperforms {baseline} on {benchmark}.',
      description: 'Compare an algorithm against a baseline.', tags: ['algorithm', 'results'],
      sectionTypes: ['Results'], source: 'curated',
      slots: [
        { name: 'method', description: 'Proposed method', required: true },
        { name: 'baseline', description: 'Comparison baseline', required: true },
        { name: 'benchmark', description: 'Evaluation benchmark', required: true },
      ],
    },
  });
  assert.equal(patternCreated.status, 201);
  const patternId = patternCreated.data.item.id;
  const searched = await api('/api/libraries/search', {
    method: 'POST', body: { query: 'algorithm results', sectionType: 'Results' },
  });
  assert.ok(searched.data.results.sentencePatterns.some((item) => item.id === patternId));
  const rendered = await api('/api/libraries/render-pattern', {
    method: 'POST', body: { patternId, values: { method: 'Ours', baseline: 'BERT', benchmark: 'GLUE' } },
  });
  assert.equal(rendered.status, 200);
  assert.equal(rendered.data.rendered, 'Ours outperforms BERT on GLUE.');
  const missing = await api('/api/libraries/render-pattern', {
    method: 'POST', body: { patternId, values: { method: 'Ours' } },
  });
  assert.equal(missing.status, 400);
  const extracted = await api('/api/libraries/extract', { method: 'POST', body: { file: 'main.tex' } });
  assert.equal(extracted.status, 200);
  assert.ok(extracted.data.candidates.patterns.length > 0);
  const context = await api('/api/libraries/context', {
    method: 'POST', body: { resourceIds: [patternId] },
  });
  assert.equal(context.status, 200);
  assert.deepEqual(context.data.context.resourceIds, [patternId]);
  assert.match(context.data.context.prompt, new RegExp(patternId));
});

test('Mock Agent records selected library resources as provided but not adopted', async () => {
  const library = await api('/api/libraries/vocabulary/session', {
    method: 'POST', body: { term: 'important', preferred: 'crucial', definition: 'Prefer precise wording.' },
  });
  const result = await api('/api/agent/suggest', {
    method: 'POST',
    body: { content: 'This is very important.', prompt: 'Improve precision.', resourceIds: [library.data.item.id] },
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.library.mode, 'selected');
  assert.deepEqual(result.data.library.providedResources.map((item) => item.id), [library.data.item.id]);
  assert.deepEqual(result.data.library.usedResourceIds, []);
  const runs = await api('/api/agent/runs');
  const run = runs.data.runs.find((item) => item.id === result.data.runId);
  assert.ok(JSON.parse(run.input).providedResources.some((item) => item.id === library.data.item.id));
});

test('Paragraph generation uses selected corpus and records adopted provenance', async () => {
  const corpus = await api('/api/libraries/corpora', {
    method: 'POST', body: {
      name: 'Convergence evidence',
      content: 'The optimization converges reliably across all evaluated initialization settings.',
      description: 'Reusable result statement.', tags: ['results'], source: 'experiment log',
    },
  });
  const result = await api('/api/agent/generate-paragraph', {
    method: 'POST', body: {
      prompt: 'Describe convergence.', resourceIds: [corpus.data.item.id], sectionType: 'Results',
    },
  });
  assert.equal(result.status, 200);
  assert.match(result.data.draft, /optimization converges reliably/);
  assert.deepEqual(result.data.library.usedResourceIds, [corpus.data.item.id]);
  const runs = await api('/api/agent/runs');
  const run = runs.data.runs.find((item) => item.id === result.data.runId);
  assert.equal(run.operation, 'generate-paragraph');
  assert.deepEqual(JSON.parse(run.output).usedResourceIds, [corpus.data.item.id]);
});

test('Confirmed paragraph draft inserts through an applied revision and recovery point', async () => {
  const file = 'paragraph-insert.tex';
  const source = '\\documentclass{article}\n\\begin{document}\n\\section{Results}\nExisting result.\n\\end{document}\n';
  await writeFile(join(tmpWorkspace, file), source, 'utf-8');
  const synced = await api('/api/documents/sync', { method: 'POST', body: { file } });
  const generated = await api('/api/agent/generate-paragraph', {
    method: 'POST', body: { prompt: 'Add a robustness result.', sectionType: 'Results' },
  });
  const index = source.indexOf('\\end{document}');
  const inserted = await api('/api/agent/insert-paragraph', {
    method: 'POST', body: { documentId: synced.data.document.id, index, text: generated.data.draft, prompt: 'Add a robustness result.', runId: generated.data.runId },
  });
  assert.equal(inserted.status, 200);
  assert.equal(inserted.data.revision.origin, 'paragraph-generation');
  assert.equal(inserted.data.revision.status, 'applied');
  assert.ok(inserted.data.recoveryPoint);
  assert.ok(inserted.data.content.includes(generated.data.draft));
});

test('External Agent reports and persists actually adopted resource IDs', async () => {
  const library = await api('/api/libraries/vocabulary/session', {
    method: 'POST', body: { term: 'useful', preferred: 'valuable', definition: 'Academic preference.' },
  });
  const resourceId = library.data.item.id;
  const fakeCli = join(tmpWorkspace, 'fake-codex-library.mjs');
  await writeFile(fakeCli, `
import { writeFileSync } from 'fs';
const args = process.argv.slice(2);
let input = '';
for await (const chunk of process.stdin) input += chunk;
const resource = input.match(/\\[VOCABULARY ([^ ]+)/)?.[1];
const outputIndex = args.indexOf('--output-last-message');
writeFileSync(args[outputIndex + 1], JSON.stringify({ summary: 'Used preferred vocabulary.', usedResourceIds: [resource], suggestions: [{ category: 'style', description: 'Use preferred term', originalText: 'very useful', suggestedText: 'valuable', reason: 'Library preference' }] }));
`, 'utf-8');
  const agentApp = createApp(tmpWorkspace, {
    provider: 'codex', agentCommands: { codex: { command: process.execPath, args: [fakeCli] } },
  });
  const agentServer = await new Promise((resolveListen) => {
    const instance = agentApp.listen(0, '127.0.0.1', () => resolveListen(instance));
  });
  try {
    const address = agentServer.address();
    const root = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${root}/api/agent/suggest`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'This method is very useful.', prompt: 'Improve.', resourceIds: [resourceId] }),
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(data.library.usedResourceIds, [resourceId]);
    const runs = await (await fetch(`${root}/api/agent/runs`)).json();
    assert.deepEqual(JSON.parse(runs.runs.find((item) => item.id === data.runId).output).usedResourceIds, [resourceId]);
  } finally {
    await new Promise((resolveClose) => agentServer.close(resolveClose));
  }
});

test('Annotation APIs persist anchored comments and status changes', async () => {
  const project = (await api('/api/project')).data.project;
  const documentId = project.documents[0].id;
  const created = await api('/api/annotations', {
    method: 'POST',
    body: {
      documentId,
      target: { type: 'range', id: '', start: 12, end: 28, quote: 'very important' },
      category: 'style', severity: 'minor', body: 'Use a precise adjective.',
      suggestedFix: 'crucial', source: { type: 'user', actor: 'author' },
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.annotation.status, 'open');

  const updated = await api(`/api/annotations/${created.data.annotation.id}`, {
    method: 'PUT', body: { status: 'planned' },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.annotation.status, 'planned');
  assert.equal(updated.data.annotation.target.quote, 'very important');

  const filtered = await api(`/api/annotations?documentId=${encodeURIComponent(documentId)}`);
  assert.ok(filtered.data.annotations.some((item) => item.id === created.data.annotation.id));
});

test('Annotation APIs reject invalid target ranges', async () => {
  const documentId = (await api('/api/project')).data.project.documents[0].id;
  const result = await api('/api/annotations', {
    method: 'POST',
    body: { documentId, target: { type: 'range', start: 20, end: 10 }, body: 'Invalid range' },
  });
  assert.equal(result.status, 400);
  assert.ok(result.data.details.some((detail) => detail.includes('.end')));
});

test('Revision APIs store reviewable changes and lifecycle state', async () => {
  const project = (await api('/api/project')).data.project;
  const documentId = project.documents[0].id;
  const annotation = (await api('/api/annotations')).data.annotations[0];
  const created = await api('/api/revisions', {
    method: 'POST',
    body: {
      documentId,
      title: 'First guided revision',
      annotationIds: annotation ? [annotation.id] : [],
      changes: [{
        target: { type: 'range', start: 12, end: 28, quote: 'very important' },
        before: 'very important', after: 'crucial', reason: 'Improve precision',
      }],
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.revision.status, 'draft');
  assert.equal(created.data.revision.changes[0].status, 'proposed');

  const updated = await api(`/api/revisions/${created.data.revision.id}`, {
    method: 'PUT', body: { status: 'review' },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.revision.status, 'review');
  assert.equal(updated.data.revision.changes.length, 1);
});

test('Review importer splits numbered and bulleted feedback into atomic opinions', () => {
  const opinions = splitAtomicOpinions(`1. Replace "weak" with "limited".\n   This should be precise.\n2) Add evidence.\n- Fix the citation.`);
  assert.deepEqual(opinions, [
    'Replace "weak" with "limited". This should be precise.',
    'Add evidence.',
    'Fix the citation.',
  ]);
});

test('Review orchestration endpoint records an auditable atomic-opinion run', async () => {
  const file = 'orchestration-paper.tex';
  await writeFile(join(tmpWorkspace, file), '\\documentclass{article}\n\\begin{document}\nThis is a very important claim.\\end{document}', 'utf-8');
  const synced = await api('/api/documents/sync', { method: 'POST', body: { file } });
  const result = await api('/api/review/orchestrate', {
    method: 'POST', body: { documentId: synced.data.document.id, actor: 'Reviewer 3', text: '1. 把“very important”改为“well-supported”。\n2. Add evidence; depends on #1.' },
  });
  assert.equal(result.status, 201);
  assert.equal(result.data.annotations.length, 2);
  assert.ok(result.data.runId);
  const runs = await api('/api/agent/runs');
  const run = runs.data.runs.find((item) => item.id === result.data.runId);
  assert.equal(run.operation, 'orchestrate-review');
  assert.equal(run.status, 'complete');
});

test('Review import anchors opinions and builds executable revision graph', async () => {
  const file = 'revision-paper.tex';
  const original = `\\begin{document}\n\\section{Introduction}\nThe method is very important.\n\n\\section{Results}\nThe finding is very useful.\n\\end{document}`;
  await writeFile(join(tmpWorkspace, file), original, 'utf-8');
  const synced = await api('/api/documents/sync', { method: 'POST', body: { file } });
  const documentId = synced.data.document.id;
  const imported = await api('/api/review/import', {
    method: 'POST', body: {
      documentId, actor: 'Reviewer 2',
      text: `1. 把“very important”改为“crucial”。\n2. Replace "very useful" with "valuable"; depends on #1.\n3. Major: add stronger experimental evidence.`,
    },
  });
  assert.equal(imported.status, 201);
  assert.equal(imported.data.annotations.length, 3);
  assert.equal(imported.data.annotations[0].target.type, 'range');
  assert.equal(imported.data.annotations[0].suggestedFix, 'crucial');
  assert.equal(imported.data.annotations[2].severity, 'major');

  const planned = await api('/api/revisions/plan', {
    method: 'POST', body: {
      documentId, annotationIds: imported.data.annotations.map((item) => item.id), title: 'Reviewer 2 revision',
    },
  });
  assert.equal(planned.status, 201);
  const revision = planned.data.revision;
  assert.equal(revision.changes.filter((item) => item.executable).length, 2);
  assert.equal(revision.changes[2].executable, false);
  assert.ok(revision.graph.edges.some((edge) => edge.type === 'depends-on'));
  assert.deepEqual(revision.changes[1].dependsOn, [revision.changes[0].id]);
});

test('Accepted revision changes apply atomically and rollback from checksum recovery point', async () => {
  const revisions = await api('/api/revisions');
  const revision = revisions.data.revisions.find((item) => item.title === 'Reviewer 2 revision');
  const executable = revision.changes.filter((item) => item.executable);
  const decided = await api(`/api/revisions/${revision.id}/decisions`, {
    method: 'PUT', body: { decisions: executable.map((item) => ({ changeId: item.id, status: 'accepted' })) },
  });
  assert.equal(decided.status, 200);
  const applied = await api(`/api/revisions/${revision.id}/apply`, { method: 'POST' });
  assert.equal(applied.status, 200);
  assert.equal(applied.data.revision.status, 'applied');
  assert.ok(applied.data.recoveryPoint.path.startsWith('.papergod/recovery/'));
  assert.match(applied.data.content, /crucial/);
  assert.match(applied.data.content, /valuable/);
  const recoveryContent = await readFile(join(tmpWorkspace, applied.data.recoveryPoint.path), 'utf-8');
  assert.match(recoveryContent, /very important/);

  const staticRecovery = await fetch(baseUrl + '/workspace/' + applied.data.recoveryPoint.path);
  assert.notEqual(staticRecovery.status, 200);
  const rolledBack = await api(`/api/revisions/${revision.id}/rollback`, { method: 'POST' });
  assert.equal(rolledBack.status, 200);
  assert.equal(rolledBack.data.revision.status, 'rolled-back');
  assert.match(rolledBack.data.content, /very important/);
  assert.ok(rolledBack.data.revision.changes.filter((item) => item.executable).every((item) => item.status === 'reverted'));
});

test('Overlapping accepted changes are rejected without modifying source', async () => {
  const file = 'revision-conflict.tex';
  const original = '\\begin{document}\\section{One}\nThis phrase needs revision.\\end{document}';
  await writeFile(join(tmpWorkspace, file), original, 'utf-8');
  const document = (await api('/api/documents/sync', { method: 'POST', body: { file } })).data.document;
  const sentence = document.sections[0].children[0].children[0];
  const common = {
    documentId: document.id,
    target: { type: 'range', id: sentence.id, start: sentence.sourceRange.start, end: sentence.sourceRange.end, quote: sentence.text },
    category: 'style', severity: 'minor', body: 'Rewrite sentence.', status: 'open', source: { type: 'user', actor: 'author' },
  };
  const first = await api('/api/annotations', { method: 'POST', body: { ...common, suggestedFix: 'First rewrite.' } });
  const second = await api('/api/annotations', { method: 'POST', body: { ...common, suggestedFix: 'Second rewrite.' } });
  const plan = await api('/api/revisions/plan', {
    method: 'POST', body: { documentId: document.id, annotationIds: [first.data.annotation.id, second.data.annotation.id], title: 'Conflict plan' },
  });
  assert.ok(plan.data.revision.graph.edges.some((edge) => edge.type === 'conflicts'));
  await api(`/api/revisions/${plan.data.revision.id}/decisions`, {
    method: 'PUT', body: { decisions: plan.data.revision.changes.map((item) => ({ changeId: item.id, status: 'accepted' })) },
  });
  const applied = await api(`/api/revisions/${plan.data.revision.id}/apply`, { method: 'POST' });
  assert.equal(applied.status, 409);
  assert.equal(await readFile(join(tmpWorkspace, file), 'utf-8'), original);
});

test('Rollback refuses to discard edits made after an applied revision', async () => {
  const file = 'rollback-conflict.tex';
  const original = '\\begin{document}\\section{One}\nThis is very important.\\end{document}';
  await writeFile(join(tmpWorkspace, file), original, 'utf-8');
  const document = (await api('/api/documents/sync', { method: 'POST', body: { file } })).data.document;
  const imported = await api('/api/review/import', {
    method: 'POST', body: { documentId: document.id, text: 'Replace "very important" with "crucial".' },
  });
  const plan = await api('/api/revisions/plan', {
    method: 'POST', body: { documentId: document.id, annotationIds: [imported.data.annotations[0].id], title: 'Rollback conflict' },
  });
  await api(`/api/revisions/${plan.data.revision.id}/decisions`, {
    method: 'PUT', body: { decisions: [{ changeId: plan.data.revision.changes[0].id, status: 'accepted' }] },
  });
  const applied = await api(`/api/revisions/${plan.data.revision.id}/apply`, { method: 'POST' });
  assert.equal(applied.status, 200);
  await writeFile(join(tmpWorkspace, file), applied.data.content + '\n% later author edit\n', 'utf-8');
  const rollback = await api(`/api/revisions/${plan.data.revision.id}/rollback`, { method: 'POST' });
  assert.equal(rollback.status, 409);
  assert.match(rollback.data.error, /later work/i);
});

test('Reviewer profile catalog exposes five specialist roles and a default rubric', async () => {
  const result = await api('/api/reviewer-profiles');
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.profiles.map((item) => item.role), [
    'methodology', 'statistics', 'writing', 'domain', 'reproducibility',
  ]);
  assert.ok(result.data.defaultRubric.length >= 4);
  assert.ok(result.data.defaultRubric.every((item) => item.id && item.instruction && item.weight > 0));
});

test('Review panel API validates custom reviewers and rubric', async () => {
  const documentId = (await api('/api/project')).data.project.documents[0].id;
  const invalid = await api('/api/reviews', {
    method: 'POST', body: { documentId, reviewers: [], rubric: [] },
  });
  assert.equal(invalid.status, 400);

  const catalog = (await api('/api/reviewer-profiles')).data;
  const created = await api('/api/reviews', {
    method: 'POST', body: {
      documentId, name: 'M7 panel', provider: 'mock',
      reviewers: catalog.profiles.slice(0, 3).map((item, index) => ({
        ...item, id: `custom_${index}`, prompt: index === 0 ? 'Prioritize validity threats.' : '',
      })),
      rubric: catalog.defaultRubric,
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.review.status, 'draft');
  assert.equal(created.data.review.reviewers.length, 3);
  assert.equal(created.data.review.reviewers[0].prompt, 'Prioritize validity threats.');
});

test('Mock review panel produces independent auditable reports and synthesis', async () => {
  const reviews = await api('/api/reviews');
  const review = reviews.data.reviews.find((item) => item.name === 'M7 panel');
  const run = await api(`/api/reviews/${review.id}/run`, { method: 'POST' });
  assert.equal(run.status, 200);
  assert.equal(run.data.review.status, 'complete');
  assert.equal(run.data.review.reports.length, 3);
  assert.equal(new Set(run.data.review.reports.map((item) => item.reviewerId)).size, 3);
  assert.ok(run.data.review.reports.every((item) => item.status === 'complete' && item.runId));
  assert.ok(run.data.review.items.every((item) => item.reviewerId && item.rubricId));
  assert.ok(run.data.review.synthesis.summary.includes('independent report'));
  assert.ok(['accept', 'minor-revision', 'major-revision', 'reject'].includes(run.data.review.synthesis.verdict));
  const agentRuns = await api('/api/agent/runs');
  const runIds = new Set(run.data.review.reports.map((item) => item.runId));
  assert.equal(agentRuns.data.runs.filter((item) => runIds.has(item.id) && item.operation === 'peer-review' && item.status === 'complete').length, 3);
});

test('Peer review synthesis distinguishes consensus and conflicts', () => {
  const item = (id, reviewerId, kind, suggestedFix) => ({
    id, reviewerId, rubricId: 'clarity', kind, category: 'style', severity: 'major',
    body: 'The central claim uses wording that is too broad for the evidence.', suggestedFix, quote: 'very important',
  });
  const report = (reviewerId, items) => ({ reviewerId, verdict: 'major-revision', items });
  const consensus = synthesizePeerReviews([
    report('r1', [item('i1', 'r1', 'concern', '')]),
    report('r2', [item('i2', 'r2', 'concern', '')]),
  ]);
  assert.equal(consensus.consensus.length, 1);
  assert.equal(consensus.conflicts.length, 0);
  const conflict = synthesizePeerReviews([
    report('r1', [item('i3', 'r1', 'concern', 'precise')]),
    report('r2', [item('i4', 'r2', 'strength', 'retain')]),
  ]);
  assert.equal(conflict.conflicts.length, 1);
});

test('Selected peer review concerns enter M6 as annotations and a revision plan', async () => {
  const reviews = await api('/api/reviews');
  const review = reviews.data.reviews.find((item) => item.name === 'M7 panel');
  const selected = review.items.filter((item) => item.kind === 'concern').slice(0, 2);
  const transferred = await api(`/api/reviews/${review.id}/to-revision`, {
    method: 'POST', body: { itemIds: selected.map((item) => item.id), title: 'Panel-guided revision' },
  });
  assert.equal(transferred.status, 201);
  assert.equal(transferred.data.annotations.length, selected.length);
  assert.equal(transferred.data.revision.annotationIds.length, selected.length);
  assert.ok(transferred.data.annotations.every((item) => item.source.type === 'reviewer'));
  assert.equal(transferred.data.revision.title, 'Panel-guided revision');
  const persisted = await api(`/api/revisions?documentId=${encodeURIComponent(review.documentId)}`);
  assert.ok(persisted.data.revisions.some((item) => item.id === transferred.data.revision.id));
});

test('Review Agent parser and validator enforce rubric IDs and exact quotes', () => {
  const valid = {
    summary: 'Review complete.', verdict: 'minor-revision', confidence: 0.8,
    items: [{ rubricId: 'clarity', kind: 'concern', category: 'style', severity: 'minor', body: 'Tighten the claim.', suggestedFix: 'precise', quote: 'very important' }],
  };
  assert.deepEqual(parseReviewAgentJson(JSON.stringify(valid)), valid);
  assert.equal(validateReviewResponse(valid, 'This is very important.', ['clarity']).ok, true);
  assert.equal(validateReviewResponse({ ...valid, items: [{ ...valid.items[0], rubricId: 'invented' }] }, 'This is very important.', ['clarity']).ok, false);
  assert.equal(validateReviewResponse({ ...valid, items: [{ ...valid.items[0], quote: 'not present' }] }, 'This is very important.', ['clarity']).ok, false);
});

test('Self-revise package persists editable point-by-point responses and change list', async () => {
  const file = 'self-revise.tex';
  const source = '\\documentclass{article}\n\\begin{document}\nThe evidence supports a weak claim.\n\\end{document}\n';
  await writeFile(join(tmpWorkspace, file), source, 'utf-8');
  const synced = await api('/api/documents/sync', { method: 'POST', body: { file } });
  const documentId = synced.data.document.id;
  const start = source.indexOf('weak claim');
  const annotation = await api('/api/annotations', {
    method: 'POST', body: {
      documentId, target: { type: 'range', id: synced.data.document.sections[0]?.id || documentId, start, end: start + 10, quote: 'weak claim' },
      category: 'evidence', severity: 'major', body: 'Calibrate the central claim.', suggestedFix: 'qualified claim',
      source: { type: 'reviewer', actor: 'Reviewer 1' },
    },
  });
  const planned = await api('/api/revisions/plan', {
    method: 'POST', body: { documentId, annotationIds: [annotation.data.annotation.id], title: 'Self revise round' },
  });
  const revisionId = planned.data.revision.id;
  const packaged = await api(`/api/revisions/${revisionId}/package`, { method: 'POST' });
  assert.equal(packaged.status, 200);
  assert.equal(packaged.data.responseLetter.items.length, 1);
  assert.equal(packaged.data.changeList[0].after, 'qualified claim');
  const edited = await api(`/api/revisions/${revisionId}/response-letter`, {
    method: 'PUT', body: { items: [{ annotationId: annotation.data.annotation.id, response: 'We calibrated the claim and added an explicit qualification.' }] },
  });
  assert.equal(edited.status, 200);
  assert.match(edited.data.responseLetter.items[0].response, /explicit qualification/);
  await api(`/api/revisions/${revisionId}/decisions`, {
    method: 'PUT', body: { decisions: [{ changeId: planned.data.revision.changes[0].id, status: 'accepted' }] },
  });
  const applied = await api(`/api/revisions/${revisionId}/apply`, { method: 'POST' });
  assert.equal(applied.status, 200);
  const refreshed = await api(`/api/revisions/${revisionId}/package`, { method: 'POST' });
  assert.equal(refreshed.data.responseLetter.items[0].status, 'applied');
  assert.match(refreshed.data.responseLetter.items[0].response, /explicit qualification/);
});

test('Applied self-revision recompiles and reports unresolved opinions', async () => {
  const revisions = await api('/api/revisions');
  const revision = revisions.data.revisions.find((item) => item.title === 'Self revise round');
  const verified = await api(`/api/revisions/${revision.id}/verify`, { method: 'POST' });
  assert.equal(verified.status, 200);
  assert.equal(verified.data.verification.compile.ok, true);
  assert.equal(verified.data.verification.unresolvedAnnotationIds.length, 0);
  assert.equal(verified.data.verification.complete, true);
});

test('Whole-paper generation uses structured prompts and libraries but does not write before acceptance', async () => {
  const file = 'generated-paper.tex';
  const original = '\\documentclass{article}\n\\begin{document}\n\\section{Analysis}\nPlaceholder paragraph.\n\\end{document}\n';
  await writeFile(join(tmpWorkspace, file), original, 'utf-8');
  const synced = await api('/api/documents/sync', { method: 'POST', body: { file } });
  const documentId = synced.data.document.id;
  const paragraph = synced.data.document.sections[0].children[0];
  await api(`/api/structure/nodes/${paragraph.id}`, { method: 'PUT', body: { prompt: 'Explain the ablation evidence and uncertainty.' } });
  const corpus = await api('/api/libraries/corpora', {
    method: 'POST', body: { name: 'Generation evidence', content: 'Ablation results isolate the contribution of each component.', description: '', source: 'experiment', tags: ['generation'] },
  });
  const generated = await api('/api/generate/paper', {
    method: 'POST', body: { documentId, instruction: 'Draft a rigorous analysis paper.', resourceIds: [corpus.data.item.id] },
  });
  assert.equal(generated.status, 201);
  assert.equal(generated.data.revision.origin, 'paper-generation');
  assert.equal(generated.data.revision.status, 'review');
  assert.match(generated.data.draft, /\\section\{Analysis\}/);
  assert.match(generated.data.draft, /Ablation results isolate/);
  assert.deepEqual(generated.data.library.usedResourceIds, [corpus.data.item.id]);
  assert.equal(await readFile(join(tmpWorkspace, file), 'utf-8'), original);
  const change = generated.data.revision.changes[0];
  await api(`/api/revisions/${generated.data.revision.id}/decisions`, {
    method: 'PUT', body: { decisions: [{ changeId: change.id, status: 'accepted' }] },
  });
  const applied = await api(`/api/revisions/${generated.data.revision.id}/apply`, { method: 'POST' });
  assert.equal(applied.status, 200);
  assert.equal(applied.data.content, generated.data.draft);
  assert.ok(applied.data.recoveryPoint);
});

test('Workflow history and export bundle include source, artifacts, runs, and recovery metadata', async () => {
  const project = (await api('/api/project')).data.project;
  const document = project.documents.find((item) => item.file === 'generated-paper.tex');
  const history = await api(`/api/workflow/history?documentId=${encodeURIComponent(document.id)}`);
  assert.equal(history.status, 200);
  assert.ok(history.data.events.some((item) => item.type === 'revision' && item.title === 'Generated full-paper draft'));
  assert.ok(history.data.events.some((item) => item.type === 'agent-run' && item.title.includes('generate-paper')));
  const exported = await api(`/api/workflow/export?documentId=${encodeURIComponent(document.id)}`);
  assert.equal(exported.status, 200);
  assert.match(exported.data.bundle.source, /Ablation results isolate/);
  assert.ok(exported.data.bundle.artifacts.some((item) => item.recoveryPoint?.id));
  assert.ok(Array.isArray(exported.data.bundle.history));
});

// ---------------------------------------------------------------------------
// M9: Multi-agent orchestration
// ---------------------------------------------------------------------------

async function waitForOrchestration(id, predicate, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { data } = await api(`/api/orchestrations/${encodeURIComponent(id)}`);
    if (predicate(data.orchestration)) return data.orchestration;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for orchestration ${id}`);
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

function orchNode(overrides = {}) {
  const node = {
    id: overrides.id || `node_${Math.random().toString(36).slice(2, 10)}`,
    kind: overrides.kind || 'agent',
    label: overrides.label || 'Node',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    provider: overrides.provider || 'mock',
    capability: overrides.capability || 'suggest',
    prompt: overrides.prompt || '',
    source: overrides.source || { type: 'manual', nodeId: '', text: 'This result is very important.' },
    reviewer: overrides.reviewer ?? null,
    rubric: overrides.rubric ?? [],
    status: 'idle',
    note: '',
    output: null,
    runId: '',
    error: '',
    startedAt: '',
    finishedAt: '',
  };
  if (node.kind === 'gate') node.decision = 'pending';
  return node;
}

test('Project metadata exposes the orchestrations collection', async () => {
  const { data } = await api('/api/project');
  assert.ok(Array.isArray(data.project.orchestrations));
});

test('Project schema v3 migrates older metadata and adds the orchestrations collection', () => {
  const legacy = createDefaultProject('/tmp/legacy-v2');
  legacy.schemaVersion = 2;
  legacy.project.corePrompt = 'Keep this prompt.';
  const migration = migrateProjectData(legacy, '/tmp/legacy-v2');
  assert.equal(migration.migratedFrom, 2);
  assert.equal(migration.data.schemaVersion, PROJECT_SCHEMA_VERSION);
  assert.deepEqual(migration.data.orchestrations, []);
  assert.equal(migration.data.project.corePrompt, 'Keep this prompt.');
  assert.equal(migration.data.documents[0].file, 'main.tex');
  assert.equal(validateProject(migration.data).ok, true);

  const broken = createDefaultProject('/tmp/broken-orch');
  broken.orchestrations = [{ id: 'o1', createdAt: 'now', updatedAt: 'now', name: '', status: 'draft', nodes: [], edges: [] }];
  assert.equal(validateProject(broken).ok, false);
  const valid = createDefaultProject('/tmp/valid-orch');
  valid.orchestrations = [{
    id: 'o1', name: 'Flow', status: 'draft', createdAt: 'now', updatedAt: 'now',
    nodes: [{ id: 'n1', kind: 'agent', label: '', x: 0, y: 0, provider: 'mock', capability: 'suggest', prompt: '', source: { type: 'manual', nodeId: '', text: '' }, status: 'idle', note: '', output: null, runId: '', error: '', startedAt: '', finishedAt: '' }],
    edges: [{ id: 'e1', source: 'n1', target: 'end', summary: '' }],
  }];
  assert.equal(validateProject(valid).ok, true);
});

test('Orchestration API creates, lists, updates, and deletes workflows with validation', async () => {
  const created = await api('/api/orchestrations', { method: 'POST', body: { name: 'Draft flow' } });
  assert.equal(created.status, 201);
  assert.equal(created.data.orchestration.status, 'draft');
  assert.equal(created.data.orchestration.nodes.length, 1);
  const id = created.data.orchestration.id;

  const listed = await api('/api/orchestrations');
  assert.equal(listed.status, 200);
  assert.ok(listed.data.orchestrations.some((item) => item.id === id));

  const a = created.data.orchestration.nodes[0];
  const b = orchNode({ id: 'node_validate_b', label: 'Review', capability: 'review', source: { type: 'upstream', nodeId: a.id, text: '' } });
  const updated = await api(`/api/orchestrations/${id}`, {
    method: 'PUT',
    body: {
      name: 'Renamed flow',
      nodes: [{ ...a, label: 'Read', x: 10, y: 20 }, b],
      edges: [{ id: 'edge_ab', source: a.id, target: b.id, summary: '' }],
    },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.orchestration.name, 'Renamed flow');
  assert.equal(updated.data.orchestration.nodes[0].x, 10);
  assert.equal(updated.data.orchestration.nodes[1].source.nodeId, a.id);

  const invalidCapability = await api(`/api/orchestrations/${id}`, {
    method: 'PUT', body: { name: 'x', nodes: [{ ...a, capability: 'unknown' }], edges: [] },
  });
  assert.equal(invalidCapability.status, 400);

  const invalidProvider = await api(`/api/orchestrations/${id}`, {
    method: 'PUT', body: { name: 'x', nodes: [{ ...a, provider: 'skynet' }], edges: [] },
  });
  assert.equal(invalidProvider.status, 400);

  const badEdge = await api(`/api/orchestrations/${id}`, {
    method: 'PUT', body: { name: 'x', nodes: [a], edges: [{ id: 'e', source: a.id, target: 'ghost', summary: '' }] },
  });
  assert.equal(badEdge.status, 400);

  const dupEdge = await api(`/api/orchestrations/${id}`, {
    method: 'PUT',
    body: { name: 'x', nodes: [a, b], edges: [{ id: 'e1', source: a.id, target: b.id, summary: '' }, { id: 'e2', source: a.id, target: b.id, summary: '' }] },
  });
  assert.equal(dupEdge.status, 400);

  const removed = await api(`/api/orchestrations/${id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  const afterDelete = await api('/api/orchestrations');
  assert.ok(!afterDelete.data.orchestrations.some((item) => item.id === id));
});

test('Mock orchestration runs a serial chain and persists outputs, edge summaries, and audited agent runs', async () => {
  const created = await api('/api/orchestrations', { method: 'POST', body: { name: 'Serial chain' } });
  const id = created.data.orchestration.id;
  const a = created.data.orchestration.nodes[0];
  const b = orchNode({ id: 'node_serial_b', label: 'Review', capability: 'review', source: { type: 'upstream', nodeId: a.id, text: '' } });
  const c = orchNode({ id: 'node_serial_c', label: 'Second pass', capability: 'suggest', source: { type: 'upstream', nodeId: b.id, text: '' }, prompt: 'Polish the review result.' });
  await api(`/api/orchestrations/${id}`, {
    method: 'PUT',
    body: {
      name: 'Serial chain',
      nodes: [{ ...a, label: 'Read', source: { type: 'manual', nodeId: '', text: 'This result is very important.' } }, b, c],
      edges: [
        { id: 'edge_s1', source: a.id, target: b.id, summary: '' },
        { id: 'edge_s2', source: b.id, target: c.id, summary: '' },
      ],
    },
  });
  const run = await api(`/api/orchestrations/${id}/run`, { method: 'POST' });
  assert.equal(run.status, 202);
  assert.equal(run.data.started, true);
  const finished = await waitForOrchestration(id, (orch) => orch.status !== 'running');
  assert.equal(finished.status, 'complete');
  assert.ok(finished.nodes.every((node) => node.status === 'complete'));
  const byId = new Map(finished.nodes.map((node) => [node.id, node]));
  assert.ok(byId.get(a.id).output.summary.includes('suggestion'));
  assert.ok(byId.get(b.id).output.summary.includes('reviewer'));
  assert.ok(byId.get(b.id).runId);
  assert.ok(finished.edges.every((edge) => edge.summary.length > 0));
  const runs = (await api('/api/agent/runs')).data.runs;
  const orchestrationRuns = runs.filter((run) => run.operation.startsWith('orchestrate:'));
  assert.ok(orchestrationRuns.length >= 2);
  assert.ok(orchestrationRuns.some((run) => run.operation === 'orchestrate:suggest' && run.status === 'complete'));
  assert.ok(orchestrationRuns.some((run) => run.operation === 'orchestrate:review' && run.status === 'complete'));
  const reset = await api(`/api/orchestrations/${id}/reset`, { method: 'POST' });
  assert.equal(reset.status, 200);
  assert.equal(reset.data.orchestration.status, 'draft');
  assert.ok(reset.data.orchestration.nodes.every((node) => node.status === 'idle' && node.output === null));
  await api(`/api/orchestrations/${id}`, { method: 'DELETE' });
});

test('Mock orchestration runs independent branches in parallel', async () => {
  const created = await api('/api/orchestrations', { method: 'POST', body: { name: 'Parallel' } });
  const id = created.data.orchestration.id;
  const a = created.data.orchestration.nodes[0];
  const b = orchNode({ id: 'node_par_b', label: 'Review A', capability: 'review', source: { type: 'upstream', nodeId: a.id, text: '' } });
  const c = orchNode({ id: 'node_par_c', label: 'Review B', capability: 'review', source: { type: 'upstream', nodeId: a.id, text: '' } });
  await api(`/api/orchestrations/${id}`, {
    method: 'PUT',
    body: {
      name: 'Parallel',
      nodes: [a, b, c],
      edges: [
        { id: 'e_ab', source: a.id, target: b.id, summary: '' },
        { id: 'e_ac', source: a.id, target: c.id, summary: '' },
      ],
    },
  });
  await api(`/api/orchestrations/${id}/run`, { method: 'POST' });
  const finished = await waitForOrchestration(id, (orch) => orch.status !== 'running');
  assert.equal(finished.status, 'complete');
  const byId = new Map(finished.nodes.map((node) => [node.id, node]));
  assert.equal(byId.get(b.id).status, 'complete');
  assert.equal(byId.get(c.id).status, 'complete');
  assert.ok(byId.get(b.id).output && byId.get(c.id).output);
  await api(`/api/orchestrations/${id}`, { method: 'DELETE' });
});

test('Approval gate pauses a run and resumes only after approval', async () => {
  const created = await api('/api/orchestrations', { method: 'POST', body: { name: 'Gated' } });
  const id = created.data.orchestration.id;
  const a = created.data.orchestration.nodes[0];
  const gate = orchNode({ id: 'node_gate', kind: 'gate', label: 'Gate' });
  const b = orchNode({ id: 'node_after_gate', label: 'After gate', capability: 'review', source: { type: 'upstream', nodeId: a.id, text: '' } });
  await api(`/api/orchestrations/${id}`, {
    method: 'PUT',
    body: {
      name: 'Gated',
      nodes: [a, gate, b],
      edges: [
        { id: 'e_ag', source: a.id, target: gate.id, summary: '' },
        { id: 'e_gb', source: gate.id, target: b.id, summary: '' },
      ],
    },
  });
  await api(`/api/orchestrations/${id}/run`, { method: 'POST' });
  const waiting = await waitForOrchestration(id, (orch) => orch.nodes.some((node) => node.kind === 'gate' && node.status === 'waiting'));
  assert.equal(waiting.status, 'running');
  const gateId = waiting.nodes.find((node) => node.kind === 'gate').id;
  assert.equal(waiting.nodes.find((node) => node.id === gateId).decision, 'pending');
  const decided = await api(`/api/orchestrations/${id}/gates/${gateId}/decide`, { method: 'POST', body: { decision: 'approved', note: 'proceed' } });
  assert.equal(decided.status, 200);
  const finished = await waitForOrchestration(id, (orch) => orch.status !== 'running');
  assert.equal(finished.status, 'complete');
  assert.equal(finished.nodes.find((node) => node.id === gateId).decision, 'approved');
  assert.equal(finished.nodes.find((node) => node.id === 'node_after_gate').status, 'complete');
  await api(`/api/orchestrations/${id}`, { method: 'DELETE' });
});

test('Rejecting an approval gate stops the run and skips downstream nodes', async () => {
  const created = await api('/api/orchestrations', { method: 'POST', body: { name: 'Gated reject' } });
  const id = created.data.orchestration.id;
  const a = created.data.orchestration.nodes[0];
  const gate = orchNode({ id: 'node_gate2', kind: 'gate', label: 'Gate' });
  const b = orchNode({ id: 'node_after2', label: 'After', capability: 'review', source: { type: 'upstream', nodeId: a.id, text: '' } });
  await api(`/api/orchestrations/${id}`, {
    method: 'PUT',
    body: {
      name: 'Gated reject',
      nodes: [a, gate, b],
      edges: [
        { id: 'e1', source: a.id, target: gate.id, summary: '' },
        { id: 'e2', source: gate.id, target: b.id, summary: '' },
      ],
    },
  });
  await api(`/api/orchestrations/${id}/run`, { method: 'POST' });
  const waiting = await waitForOrchestration(id, (orch) => orch.nodes.some((node) => node.kind === 'gate' && node.status === 'waiting'));
  const gateId = waiting.nodes.find((node) => node.kind === 'gate').id;
  const decided = await api(`/api/orchestrations/${id}/gates/${gateId}/decide`, { method: 'POST', body: { decision: 'rejected' } });
  assert.equal(decided.status, 200);
  const finished = await waitForOrchestration(id, (orch) => orch.status !== 'running');
  assert.equal(finished.status, 'cancelled');
  assert.equal(finished.nodes.find((node) => node.id === 'node_after2').status, 'skipped');
  await api(`/api/orchestrations/${id}`, { method: 'DELETE' });
});

test('Orchestration run rejects cyclic graphs and guards busy states', async () => {
  const created = await api('/api/orchestrations', { method: 'POST', body: { name: 'Cycle flow' } });
  const id = created.data.orchestration.id;
  const a = created.data.orchestration.nodes[0];
  const b = orchNode({ id: 'node_cyc_b', label: 'B' });
  await api(`/api/orchestrations/${id}`, {
    method: 'PUT',
    body: {
      name: 'Cycle flow',
      nodes: [a, b],
      edges: [
        { id: 'e1', source: a.id, target: b.id, summary: '' },
        { id: 'e2', source: b.id, target: a.id, summary: '' },
      ],
    },
  });
  const run = await api(`/api/orchestrations/${id}/run`, { method: 'POST' });
  assert.equal(run.status, 400);
  assert.equal(run.data.code, 'CYCLIC_GRAPH');
  const gate = orchNode({ id: 'node_gate3', kind: 'gate' });
  await api(`/api/orchestrations/${id}`, {
    method: 'PUT',
    body: { name: 'Cycle flow', nodes: [a, gate], edges: [{ id: 'e1', source: a.id, target: gate.id, summary: '' }] },
  });
  const started = await api(`/api/orchestrations/${id}/run`, { method: 'POST' });
  assert.equal(started.status, 202);
  const waiting = await waitForOrchestration(id, (orch) => orch.nodes.some((node) => node.kind === 'gate' && node.status === 'waiting'));
  const editWhileRunning = await api(`/api/orchestrations/${id}`, { method: 'PUT', body: { name: 'Nope', nodes: waiting.nodes, edges: waiting.edges } });
  assert.equal(editWhileRunning.status, 409);
  const deleteWhileRunning = await api(`/api/orchestrations/${id}`, { method: 'DELETE' });
  assert.equal(deleteWhileRunning.status, 409);
  const secondRun = await api(`/api/orchestrations/${id}/run`, { method: 'POST' });
  assert.equal(secondRun.status, 409);
  const cancelled = await api(`/api/orchestrations/${id}/cancel`, { method: 'POST' });
  assert.equal(cancelled.status, 200);
  const afterCancel = await waitForOrchestration(id, (orch) => orch.status === 'cancelled');
  assert.equal(afterCancel.status, 'cancelled');
  await api(`/api/orchestrations/${id}`, { method: 'DELETE' });
});

test('Gate decisions require a running orchestration and a waiting gate', async () => {
  const created = await api('/api/orchestrations', { method: 'POST', body: { name: 'No gate yet' } });
  const id = created.data.orchestration.id;
  const gate = orchNode({ id: 'node_gate4', kind: 'gate' });
  await api(`/api/orchestrations/${id}`, {
    method: 'PUT', body: { name: 'No gate yet', nodes: [created.data.orchestration.nodes[0], gate], edges: [{ id: 'e1', source: created.data.orchestration.nodes[0].id, target: gate.id, summary: '' }] },
  });
  const notRunning = await api(`/api/orchestrations/${id}/gates/node_gate4/decide`, { method: 'POST', body: { decision: 'approved' } });
  assert.equal(notRunning.status, 409);
  const started = await api(`/api/orchestrations/${id}/run`, { method: 'POST' });
  assert.equal(started.status, 202);
  const waiting = await waitForOrchestration(id, (orch) => orch.nodes.some((node) => node.kind === 'gate' && node.status === 'waiting'));
  const gateId = waiting.nodes.find((node) => node.kind === 'gate').id;
  const invalidDecision = await api(`/api/orchestrations/${id}/gates/${gateId}/decide`, { method: 'POST', body: { decision: 'maybe' } });
  assert.equal(invalidDecision.status, 400);
  const decided = await api(`/api/orchestrations/${id}/gates/${gateId}/decide`, { method: 'POST', body: { decision: 'approved' } });
  assert.equal(decided.status, 200);
  await waitForOrchestration(id, (orch) => orch.status !== 'running');
  await api(`/api/orchestrations/${id}`, { method: 'DELETE' });
});

test('Path traversal is blocked', async () => {
  const { status, data } = await api('/api/files/../../etc/passwd');
  assert.ok(status === 403 || status === 404, `Expected 403 or 404, got ${status}`);
  if (data.content) assert.fail('Should not return file content');
});

test('Absolute path is blocked', async () => {
  const { status, data } = await api('/api/files//etc/passwd');
  assert.ok(status === 403 || status === 404, `Expected 403 or 404, got ${status}`);
  if (data.content) assert.fail('Should not return file content');
});

test('sanitizePath rejects traversal', () => {
  const root = join(process.cwd(), 'sanitize-root');
  assert.equal(sanitizePath('../../etc/passwd', root), null);
  assert.equal(sanitizePath('/etc/passwd', root), null);
  assert.equal(sanitizePath('subdir/../../etc/passwd', root), null);
  assert.equal(sanitizePath('main.tex', root), join(root, 'main.tex'));
  assert.equal(sanitizePath('subdir/chapter.tex', root), join(root, 'subdir', 'chapter.tex'));
});

test('sanitizePath rejects null bytes', () => {
  const root = join(process.cwd(), 'sanitize-root');
  assert.equal(sanitizePath('main.tex\0.exe', root), null);
});

test('detectEngines returns available engines', async () => {
  const engines = await detectEngines();
  assert.ok(Array.isArray(engines));
  if (engines.length > 0) {
    assert.ok(['tectonic', 'pdflatex', 'xelatex', 'lualatex'].includes(engines[0]));
  }
});

test('generateSuggestions is deterministic', () => {
  const content = 'This is very important. It was found that the method works.';
  const a = generateSuggestions(content, 'improve');
  const b = generateSuggestions(content, 'improve');
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].originalText, b[i].originalText);
    assert.equal(a[i].suggestedText, b[i].suggestedText);
  }
});

test('applySuggestionToContent replaces text', () => {
  const content = 'This is very important.';
  const sugs = generateSuggestions(content, 'fix');
  if (sugs.length > 0) {
    const result = applySuggestionToContent(content, sugs[0].id);
    assert.ok(result.content);
    assert.notEqual(result.content, content);
    assert.equal(result.error, null);
  }
});

test('applySuggestionToContent returns error for invalid id', () => {
  const result = applySuggestionToContent('content', 'nonexistent');
  assert.ok(result.error);
});

test('Graceful shutdown: server stops on close', async () => {
  const testApp = createApp(tmpWorkspace);
  const testServer = await new Promise((r) => {
    const s = testApp.listen(0, '127.0.0.1', () => r(s));
  });
  const addr = testServer.address();
  const res = await fetch(`http://127.0.0.1:${addr.port}/api/engines`);
  assert.equal(res.status, 200);
  await new Promise((r) => testServer.close(r));
  try {
    await fetch(`http://127.0.0.1:${addr.port}/api/engines`, { signal: AbortSignal.timeout(1000) });
    assert.fail('Should not reach');
  } catch {
    assert.ok(true, 'Server closed successfully');
  }
});

test('Security headers are set', async () => {
  const res = await fetch(baseUrl + '/');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('PUT /api/files validates content type', async () => {
  const { status } = await api('/api/files/test.tex', { method: 'PUT', body: { content: 123 } });
  assert.equal(status, 400);
});

// ---------------------------------------------------------------------------
// Paragraph analysis (rhythm statistics)
// ---------------------------------------------------------------------------

test('Paragraph analysis computes sentence-length statistics for a selection', async () => {
  const { status, data } = await api('/api/analysis/structure', {
    method: 'POST',
    body: { content: 'One short. A considerably longer sentence that keeps going with more words and clauses to extend its length. Tiny.' },
  });
  assert.equal(status, 200);
  assert.equal(data.analysis.kind, 'selection');
  assert.equal(data.analysis.unit.sentenceCount, 3);
  assert.equal(data.analysis.stats.count, 3);
  assert.ok(data.analysis.stats.mean > 3 && data.analysis.stats.mean < 12);
  assert.ok(data.analysis.stats.stddev > 0);
  assert.ok(data.analysis.stats.cv > 0.4);
  assert.ok(data.analysis.stats.delta > 3);
  assert.ok(data.analysis.variation.score >= 0 && data.analysis.variation.score <= 100);
  assert.ok(data.analysis.verdict.title);
  assert.ok(Array.isArray(data.analysis.formulas));
  assert.ok(data.analysis.sentences.every((sentence) => sentence.wordCount > 0));
});

test('Paragraph analysis covers the whole document and individual paragraphs', async () => {
  await api('/api/documents/sync', { method: 'POST', body: { file: 'main.tex' } });
  const documentLevel = await api('/api/analysis/structure', { method: 'POST', body: {} });
  assert.equal(documentLevel.status, 200);
  assert.equal(documentLevel.data.analysis.kind, 'document');
  assert.ok(documentLevel.data.analysis.unit.sentenceCount > 10);
  assert.ok(documentLevel.data.analysis.paragraphs.length > 1);
  assert.ok(documentLevel.data.analysis.sentenceStats.mean > 0);
  assert.ok(documentLevel.data.analysis.paragraphStats.count >= 1);
  const paragraphId = documentLevel.data.analysis.paragraphs[0].id;
  const paragraphLevel = await api('/api/analysis/structure', { method: 'POST', body: { nodeId: paragraphId } });
  assert.equal(paragraphLevel.status, 200);
  assert.ok(['paragraph', 'sentence'].includes(paragraphLevel.data.analysis.kind));
  assert.ok(paragraphLevel.data.analysis.stats.count >= 1);
  assert.ok(paragraphLevel.data.analysis.unit.id);
});

test('Variation index and verdict classify uniform text as template-like', () => {
  const uniform = analyzeLengths([10, 10, 11, 10, 9, 10, 10, 11, 10, 10]);
  assert.ok(uniform.cv < 0.1);
  assert.ok(uniform.relativeDelta < 0.15);
  const verdict = mechanicalVerdict(variationIndex(uniform).score);
  assert.ok(['highly-uniform', 'uniform'].includes(verdict.label));
  const varied = analyzeLengths([2, 18, 4, 30, 6, 22, 3, 27, 5, 19]);
  assert.ok(varied.cv > 0.6);
  const variedVerdict = mechanicalVerdict(variationIndex(varied).score);
  assert.ok(['highly-varied', 'varied'].includes(variedVerdict.label));
});

// ---------------------------------------------------------------------------
// Literature review generation from the reference library
// ---------------------------------------------------------------------------

test('Literature review generates a citable paragraph from selected references and inserts it', async () => {
  await api('/api/references/import', {
    method: 'POST',
    body: { references: [
      { id: 'lr_turing', citekey: 'turing1950', title: 'Computing Machinery and Intelligence', authors: ['A. M. Turing'], year: '1950', status: 'verified' },
      { id: 'lr_shannon', citekey: 'shannon1948', title: 'A Mathematical Theory of Communication', authors: ['C. E. Shannon'], year: '1948', status: 'verified' },
    ] },
  });
  const review = await api('/api/references/review', {
    method: 'POST', body: { citekeys: ['turing1950', 'shannon1948'], prompt: 'Machine intelligence foundations' },
  });
  assert.equal(review.status, 201);
  assert.equal(review.data.provider, 'mock');
  assert.match(review.data.draft, /\\citep\{turing1950\}/);
  assert.match(review.data.draft, /\\citep\{shannon1948\}/);
  assert.ok(review.data.runId);
  assert.deepEqual(review.data.citekeys.sort(), ['shannon1948', 'turing1950']);

  const missing = await api('/api/references/review', { method: 'POST', body: { citekeys: ['ghost1949'] } });
  assert.equal(missing.status, 404);
  const empty = await api('/api/references/review', { method: 'POST', body: { citekeys: [] } });
  assert.equal(empty.status, 400);

  const synced = await api('/api/documents/sync', { method: 'POST', body: { file: 'main.tex' } });
  const inserted = await api('/api/agent/insert-paragraph', {
    method: 'POST',
    body: { documentId: synced.data.document.id, index: 0, text: review.data.draft, prompt: 'Insert literature review.', runId: review.data.runId },
  });
  assert.equal(inserted.status, 200);
  assert.ok(inserted.data.content.includes('\\citep{turing1950}'));
  assert.ok(inserted.data.recoveryPoint);
});

// ---------------------------------------------------------------------------
// PDF pattern extraction into the writing library
// ---------------------------------------------------------------------------

test('Text extraction pulls reusable academic patterns from PDF text and adds them to the library', async () => {
  const extracted = await api('/api/libraries/extract-text', {
    method: 'POST',
    body: {
      source: 'sample.pdf',
      text: 'We propose a novel framework that can be used to model complex systems. It has been shown that the method plays a key role in practice. Our results indicate a substantial improvement over prior work. This sentence has no academic framing and should be ignored by the extractor.',
    },
  });
  assert.equal(extracted.status, 201);
  assert.ok(extracted.data.candidates.patterns.length >= 2);
  for (const candidate of extracted.data.candidates.patterns) {
    assert.equal(candidate.kind, 'sentence-patterns');
    assert.ok(candidate.value.template.length > 20);
    assert.ok(candidate.value.tags.includes('pdf'));
    assert.equal(candidate.value.source, 'sample.pdf');
  }

  const blank = await api('/api/libraries/extract-text', { method: 'POST', body: { text: '   ' } });
  assert.equal(blank.status, 400);

  const candidate = extracted.data.candidates.patterns[0];
  const added = await api('/api/libraries/sentence-patterns', {
    method: 'POST', body: candidate.value,
  });
  assert.equal(added.status, 201);
  const libraries = await api('/api/libraries');
  assert.ok(libraries.data.libraries.sentencePatterns.some((item) => item.id === added.data.item.id));
  assert.ok(libraries.data.libraries.sentencePatterns.some((item) => item.source === 'sample.pdf'));
});

test('File listing exposes PDF files alongside TeX sources', async () => {
  const { status, data } = await api('/api/files');
  assert.equal(status, 200);
  assert.ok(Array.isArray(data.files));
  assert.ok(Array.isArray(data.pdfs));
});
