import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, startServer } from '../src/server/index.js';
import { sanitizePath } from '../src/server/security.js';
import { detectEngines } from '../src/server/latex.js';
import { generateSuggestions, applySuggestionToContent } from '../src/server/agent.js';
import { PROJECT_SCHEMA_VERSION, createDefaultProject, migrateProjectData, validateProject } from '../src/server/project-store.js';
import { parseCliArgs } from '../src/cli.js';
import { initializeWorkspace } from '../src/server/workspace.js';
import { detectAgentProviders, parseAgentJson, parsePaperGenerationJson, parseReviewAgentJson, parseReviewOrchestrationJson, runAcademicReviewAgent, runPaperGenerationAgent, runProcess, runReviewOrchestrationAgent, runWritingAgent, validatePaperGenerationResponse, validateReviewOrchestrationResponse, validateReviewResponse, validateSuggestionResponse } from '../src/server/agent-adapters.js';
import { parseLatexDocument } from '../src/server/latex-structure.js';
import { buildLibraryContext, composeMockParagraph, extractLibraryCandidates, mergedVocabulary, renderSentencePattern, searchLibraries } from '../src/server/library-engine.js';
import { splitAtomicOpinions } from '../src/server/revision-engine.js';
import { generateMockPeerReview, synthesizePeerReviews } from '../src/server/review-panel.js';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink } from 'fs/promises';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const SAMPLE_TEX = resolve(PROJECT_ROOT, 'workspace', 'main.tex');

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

  const app = createApp(tmpWorkspace);
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

test('Agent configuration exposes Codex, Claude Code, and OpenCode adapters', async () => {
  const listed = await api('/api/agents');
  assert.equal(listed.status, 200);
  assert.equal(listed.data.selected, 'mock');
  assert.ok(listed.data.providers.some((item) => item.id === 'codex' && item.integration === 'ready'));
  assert.ok(listed.data.providers.some((item) => item.id === 'opencode' && item.integration === 'ready'));
  assert.ok(listed.data.providers.some((item) => item.id === 'claude-code' && item.integration === 'ready'));
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
  const source = await readFile(SAMPLE_TEX, 'utf-8');
  const document = { id: 'document_parser', title: '', sections: [] };
  const parsed = parseLatexDocument(source, document);
  assert.equal(parsed.title, 'A Very Good Introduction to Artificial Intelligence');
  assert.deepEqual(parsed.sections.map((section) => section.title), [
    'Abstract', 'Introduction', 'Methods', 'Results', 'Conclusion',
  ]);
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

test('Document structure APIs synchronize and update layered metadata', async () => {
  const synced = await api('/api/documents/sync', { method: 'POST', body: { file: 'main.tex' } });
  assert.equal(synced.status, 200);
  const document = synced.data.document;
  assert.ok(document.sourceHash);
  assert.ok(document.sections.length >= 5);

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
  assert.ok(frontend.includes('id="context-summary"'));
  assert.ok(frontend.includes('id="context-prompt"'));
  assert.ok(frontend.includes('id="context-intent"'));
  assert.ok(html.includes('id="library-overlay"'));
  assert.ok(html.includes('id="library-form"'));
  assert.ok(frontend.includes('id="library-selection-status"'));
  assert.ok(frontend.includes('id="agent-config-module"'));
  assert.ok(html.includes('id="agent-config-overlay"'));
  assert.ok(html.includes('id="agent-config-probe"'));
  assert.ok(html.includes('<option value="claude-code">Claude Code</option>'));
  assert.ok(frontend.includes('id="prompt-context-module"'));
  assert.ok(html.includes('id="prompt-preview-overlay"'));
  assert.ok(frontend.includes('id="temporary-prompt-module"'));
  assert.ok(!frontend.includes('id="ai-action"'));
  assert.ok(frontend.includes('id="ai-invoke"'));
  assert.ok(frontend.includes('>请神</Button>'));
  assert.ok(html.includes('id="invoke-confirm-overlay"'));
  assert.ok(html.includes('id="invoke-confirm"'));
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
  assert.ok(appSource.includes('/api/documents/sync'));
  assert.ok(appSource.includes('/api/agent/suggest-node'));
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
  const pdfModule = await fetch(baseUrl + '/vendor/pdfjs-dist/build/pdf.mjs');
  assert.equal(pdfModule.status, 200);
});

test('CLI parses workspace, port, and Agent provider', () => {
  const options = parseCliArgs(['papers/demo', '--port', '4312', '--agent=codex', '--demo'], '/tmp');
  assert.equal(options.workspaceRoot, '/tmp/papers/demo');
  assert.equal(options.port, 4312);
  assert.equal(options.provider, 'codex');
  assert.equal(options.demo, true);
  assert.throws(() => parseCliArgs(['--agent', 'unknown']), /Agent must be one of/);
  assert.throws(() => parseCliArgs(['--port', '70000']), /Port must be an integer/);
});

test('initializeWorkspace creates a first-run paper and project', async () => {
  const fresh = join(tmpWorkspace, 'fresh-paper');
  const result = await initializeWorkspace(fresh);
  assert.equal(result.createdSample, true);
  assert.equal(result.project.documents[0].file, 'main.tex');
  const content = await readFile(join(fresh, 'main.tex'), 'utf-8');
  assert.ok(content.includes('\\documentclass'));
  assert.ok(JSON.parse(await readFile(join(fresh, '.papergod', 'project.json'), 'utf-8')));
});

test('initializeWorkspace demo mode seeds a complete built-in testing workspace', async () => {
  const fresh = join(tmpWorkspace, 'fresh-demo');
  const result = await initializeWorkspace(fresh, { demo: true });
  assert.equal(result.createdSample, true);
  assert.match(await readFile(join(fresh, 'main.tex'), 'utf-8'), /Papergod Demo/);
  assert.match(result.project.project.corePrompt, /evidence alignment/i);
  assert.ok(result.project.documents[0].corePrompt);
  assert.ok(result.project.documents[0].sections.every((section) => section.prompt));
  assert.equal(result.project.libraries.corpora.length, 2);
  assert.equal(result.project.libraries.sentencePatterns.length, 3);
  assert.equal(result.project.libraries.vocabulary.global.length, 2);
  assert.equal(result.project.libraries.vocabulary.session.length, 1);
  assert.equal(result.project.annotations.length, 2);
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
  assert.ok(packageData.files.includes('papergod-demo.png'));
  assert.match(packageData.scripts.papergod, /--demo/);
});

test('papergod CLI executes through an npm-style bin symlink', async () => {
  const binLink = join(tmpWorkspace, 'papergod-bin');
  await symlink(join(PROJECT_ROOT, 'src', 'cli.js'), binLink);
  const result = await runProcess(binLink, ['--version'], { cwd: tmpWorkspace, timeoutMs: 5000 });
  const packageData = JSON.parse(await readFile(join(PROJECT_ROOT, 'package.json'), 'utf-8'));
  assert.equal(result.stdout.trim(), packageData.version);
});

test('startServer runs an initialized workspace with selected provider', async () => {
  const workspace = join(tmpWorkspace, 'cli-start-paper');
  await initializeWorkspace(workspace);
  const cliServer = await startServer({ workspaceRoot: workspace, port: 0, provider: 'opencode' });
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
  const claudeResult = JSON.stringify({ type: 'result', structured_output: payload, result: '' });
  assert.deepEqual(parseAgentJson(claudeResult), payload);
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

test('Codex, Claude Code, and OpenCode adapters use structured output through fake CLIs', async () => {
  const fakeCli = join(tmpWorkspace, 'fake-agent.mjs');
  await writeFile(fakeCli, `
import { writeFileSync } from 'fs';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('fake-agent 1.0.0\\n');
  process.exit(0);
}
if (args.includes('--output-format') && (!args.includes('--json-schema') || args[args.indexOf('--model') + 1] !== 'test-model')) {
  process.stderr.write('Claude structured output or model flag missing');
  process.exit(2);
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
  };
  const request = { prompt: 'Improve precision.', content: 'This result is very important.' };
  const codex = await runWritingAgent('codex', request, { workspaceRoot: tmpWorkspace, commands });
  const claude = await runWritingAgent('claude-code', request, { workspaceRoot: tmpWorkspace, commands });
  const opencode = await runWritingAgent('opencode', request, { workspaceRoot: tmpWorkspace, commands });
  assert.equal(codex.suggestions[0].suggestedText, 'crucial');
  assert.deepEqual(claude, codex);
  assert.deepEqual(opencode, codex);
  const providers = await detectAgentProviders({ commands });
  assert.ok(providers.every((provider) => provider.available));
});

test('Codex, Claude Code, and OpenCode peer-review adapters enforce structured reports', async () => {
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
  };
  const request = {
    content: 'Our method is very important.',
    reviewer: { id: 'methods', name: 'Methods', role: 'methodology', focus: 'Validity', prompt: '' },
    rubric: [{ id: 'rigor', title: 'Rigor', instruction: 'Check validity.', weight: 1 }],
  };
  const codex = await runAcademicReviewAgent('codex', request, { workspaceRoot: tmpWorkspace, commands });
  const claude = await runAcademicReviewAgent('claude-code', request, { workspaceRoot: tmpWorkspace, commands });
  const opencode = await runAcademicReviewAgent('opencode', request, { workspaceRoot: tmpWorkspace, commands });
  assert.equal(codex.items[0].rubricId, 'rigor');
  assert.deepEqual(claude, codex);
  assert.deepEqual(opencode, codex);
});

test('Codex, Claude Code, and OpenCode full-paper adapters validate complete safe LaTeX', async () => {
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
  };
  const request = { instruction: 'Draft.', projectContext: '', outlineContext: '', resourceContext: '', resourceIds: [] };
  const codex = await runPaperGenerationAgent('codex', request, { workspaceRoot: tmpWorkspace, commands });
  const claude = await runPaperGenerationAgent('claude-code', request, { workspaceRoot: tmpWorkspace, commands });
  const opencode = await runPaperGenerationAgent('opencode', request, { workspaceRoot: tmpWorkspace, commands });
  assert.match(codex.latex, /documentclass/);
  assert.deepEqual(claude, codex);
  assert.deepEqual(opencode, codex);
  assert.deepEqual(parsePaperGenerationJson(JSON.stringify(codex)), codex);
  assert.equal(validatePaperGenerationResponse({ ...codex, latex: '\\documentclass{article}\\begin{document}\\immediate\\write18{bad}\\end{document}' }, []).ok, false);
});

test('Codex, Claude Code, and OpenCode review orchestrators return atomic anchored dependencies', async () => {
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
  const commands = { codex: { command: process.execPath, args: [fakeCli] }, 'claude-code': { command: process.execPath, args: [fakeCli] }, opencode: { command: process.execPath, args: [fakeCli] } };
  const request = { feedback: 'Improve wording and evidence.', content: 'This very important central claim needs support.', outlineContext: 'One paragraph.' };
  const codex = await runReviewOrchestrationAgent('codex', request, { workspaceRoot: tmpWorkspace, commands });
  const claude = await runReviewOrchestrationAgent('claude-code', request, { workspaceRoot: tmpWorkspace, commands });
  const opencode = await runReviewOrchestrationAgent('opencode', request, { workspaceRoot: tmpWorkspace, commands });
  assert.deepEqual(claude, codex);
  assert.deepEqual(opencode, codex);
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

test('External Agent API persists auditable run records', async () => {
  const fakeCli = join(tmpWorkspace, 'fake-codex-api.mjs');
  await writeFile(fakeCli, `
import { writeFileSync } from 'fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('fake-codex 1.0\\n'); process.exit(0); }
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
      body: JSON.stringify({ prompt: 'Improve.', content: 'This is very important.' }),
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
  } finally {
    await new Promise((resolveClose) => agentServer.close(resolveClose));
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
  const root = '/home/user/workspace';
  assert.equal(sanitizePath('../../etc/passwd', root), null);
  assert.equal(sanitizePath('/etc/passwd', root), null);
  assert.equal(sanitizePath('subdir/../../etc/passwd', root), null);
  assert.equal(sanitizePath('main.tex', root), join(root, 'main.tex'));
  assert.equal(sanitizePath('subdir/chapter.tex', root), join(root, 'subdir', 'chapter.tex'));
});

test('sanitizePath rejects null bytes', () => {
  const root = '/home/user/workspace';
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
