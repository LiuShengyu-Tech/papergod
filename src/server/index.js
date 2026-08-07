import express from 'express';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readdir, readFile, writeFile, stat } from 'fs/promises';
import { sanitizePath, securityHeaders } from './security.js';
import { detectEngines, compile } from './latex.js';
import { generateSuggestions, registerSuggestions, attachSuggestionContext, getSuggestion, removeSuggestion } from './agent.js';
import { loadProject, saveProject, updateProject } from './project-store.js';
import {
  getLibraries, createLibraryResource, updateLibraryResource, deleteLibraryResource,
  listAnnotations, createAnnotation, updateAnnotation, deleteAnnotation,
  listRevisions, createRevision, updateRevision, deleteRevision,
  createAgentRun, updateAgentRun, listAgentRuns,
} from './project-resources.js';
import { detectAgentProviders, runWritingAgent } from './agent-adapters.js';
import {
  syncDocumentStructure, getDocumentStructure, updateDocumentMetadata,
  updateNodeMetadata, getNodeSourceContext,
} from './document-structure.js';
import { buildLibraryContext, composeMockParagraph, extractLibraryCandidates, renderSentencePattern, searchLibraries } from './library-engine.js';
import { findStructureNode } from './latex-structure.js';
import {
  applyRevision, applySuggestionAsRevision, createRevisionPlan, decideRevisionChanges, importReviewOpinions, insertGeneratedParagraph, orchestrateReviewOpinions, recordRejectedSuggestion, rollbackRevision,
} from './revision-engine.js';
import {
  createReviewRound, getReviewerProfileCatalog, listReviewRounds, runReviewRound, sendReviewItemsToRevision,
} from './review-panel.js';
import {
  buildWorkflowExport, generatePaperRevision, generateRevisionPackage, getWorkflowHistory,
  updateRevisionResponseLetter, verifyAppliedRevision,
} from './revise-workflow.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');
const DEFAULT_WORKSPACE = join(PROJECT_ROOT, 'workspace');

async function resourceResponse(res, operation, successStatus = 200) {
  try {
    const result = await operation();
    res.status(successStatus).json(result);
  } catch (error) {
    if (error.code === 'INVALID_PROJECT') {
      return res.status(400).json({ error: error.message, details: error.details });
    }
    res.status(error.status || 500).json({ error: error.message });
  }
}

export function createApp(workspaceRoot = DEFAULT_WORKSPACE, options = {}) {
  let provider = options.provider || 'mock';
  const agentCommands = { ...(options.agentCommands || {}) };
  const app = express();
  app.locals.config = { workspaceRoot, provider };
  app.use(express.json({ limit: '10mb' }));
  app.use(securityHeaders);
  app.use('/vendor/codemirror', express.static(join(PROJECT_ROOT, 'node_modules', 'codemirror'), { dotfiles: 'deny' }));
  app.use('/vendor/pdfjs-dist', express.static(join(PROJECT_ROOT, 'node_modules', 'pdfjs-dist'), { dotfiles: 'deny' }));
  app.use(express.static(join(PROJECT_ROOT, 'public')));

  async function requestSuggestions(content, prompt, req, context = {}) {
    const libraryContext = context.libraryContext || { prompt: '', resources: [], resourceIds: [], mode: 'automatic' };
    if (provider === 'mock') {
      const suggestions = generateSuggestions(content, prompt);
      attachSuggestionContext(suggestions, { ...context, selectedContent: content });
      const completedAt = new Date().toISOString();
      const run = await createAgentRun(workspaceRoot, {
        provider, operation: 'suggest', status: 'complete', prompt,
        input: JSON.stringify({ characters: content.length, providedResources: libraryContext.resources, libraryMode: libraryContext.mode }),
        output: JSON.stringify({ usedResourceIds: [] }), error: '', startedAt: completedAt, finishedAt: completedAt,
      });
      return {
        provider, runId: run.id, suggestions,
        library: { mode: libraryContext.mode, providedResources: libraryContext.resources, usedResourceIds: [] },
      };
    }
    const startedAt = new Date().toISOString();
    const run = await createAgentRun(workspaceRoot, {
      provider, operation: 'suggest', status: 'running', prompt,
      input: JSON.stringify({ characters: content.length, providedResources: libraryContext.resources, libraryMode: libraryContext.mode }),
      output: '', error: '', startedAt, finishedAt: '',
    });
    try {
      const controller = new AbortController();
      req.once('aborted', () => controller.abort());
      const result = await runWritingAgent(provider, {
        content, prompt, resourceContext: libraryContext.prompt, resourceIds: libraryContext.resourceIds,
      }, {
        workspaceRoot, commands: agentCommands, signal: controller.signal,
      });
      const suggestions = registerSuggestions(result.suggestions);
      attachSuggestionContext(suggestions, { ...context, selectedContent: content });
      await updateAgentRun(workspaceRoot, run.id, {
        status: 'complete', output: JSON.stringify(result), finishedAt: new Date().toISOString(),
      });
      return {
        provider, runId: run.id, summary: result.summary, suggestions,
        library: {
          mode: libraryContext.mode, providedResources: libraryContext.resources,
          usedResourceIds: result.usedResourceIds,
        },
      };
    } catch (error) {
      await updateAgentRun(workspaceRoot, run.id, {
        status: 'failed', error: error.message.slice(0, 4000), finishedAt: new Date().toISOString(),
      });
      error.status = 502;
      throw error;
    }
  }

  app.use('/workspace', (req, res, next) => {
    const relPath = req.path.replace(/^\//, '');
    const safe = sanitizePath(relPath, workspaceRoot);
    if (!safe) return res.status(403).json({ error: 'Access denied' });
    req._safePath = safe;
    next();
  });
  app.use('/workspace', express.static(workspaceRoot, { dotfiles: 'deny' }));

  app.get('/api/engines', async (_req, res) => {
    try {
      const engines = await detectEngines();
      res.json({ engines });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message, code: e.code });
    }
  });

  app.get('/api/config', (_req, res) => {
    res.json({ provider, workspace: workspaceRoot });
  });

  app.get('/api/agents', async (_req, res) => {
    await resourceResponse(res, async () => {
      const detected = await detectAgentProviders({ commands: agentCommands });
      const detectedById = new Map(detected.map((item) => [item.provider, item]));
      const project = await loadProject(workspaceRoot);
      const saved = project.project.agentProfiles || {};
      const definitions = [
        { id: 'mock', label: 'Mock', adapter: 'built-in', command: '', capabilities: ['revise', 'paragraph', 'review', 'generation'], integration: 'ready' },
        { id: 'codex', label: 'Codex CLI', adapter: 'structured-cli', command: 'codex', capabilities: ['revise', 'paragraph', 'review', 'generation'], integration: 'ready' },
        { id: 'claude-code', label: 'Claude Code', adapter: 'reserved', command: 'claude', capabilities: [], integration: 'planned' },
        { id: 'opencode', label: 'OpenCode CLI', adapter: 'structured-cli', command: 'opencode', capabilities: ['revise', 'paragraph', 'review', 'generation'], integration: 'ready' },
      ];
      return {
        selected: provider,
        providers: definitions.map((definition) => ({
          ...definition,
          command: saved[definition.id]?.command || definition.command,
          args: saved[definition.id]?.args || [],
          model: saved[definition.id]?.model || '',
          ...(detectedById.get(definition.id) || { available: false, version: null }),
        })),
      };
    });
  });

  app.put('/api/agents/config', async (req, res) => {
    const { id, command = '', args = [], model = '', activate = false } = req.body || {};
    if (!['mock', 'codex', 'claude-code', 'opencode'].includes(id)) return res.status(400).json({ error: 'Unknown Agent provider' });
    if (typeof command !== 'string' || command.length > 500) return res.status(400).json({ error: 'command must be a string up to 500 characters' });
    if (!Array.isArray(args) || args.some((item) => typeof item !== 'string') || args.length > 30) return res.status(400).json({ error: 'args must be an array of strings' });
    if (typeof model !== 'string' || model.length > 200) return res.status(400).json({ error: 'model must be a string up to 200 characters' });
    await resourceResponse(res, async () => {
      await updateProject(workspaceRoot, (project) => {
        project.project.agentProfiles ||= {};
        project.project.agentProfiles[id] = { command, args, model };
      });
      if (id !== 'mock' && command.trim()) agentCommands[id] = { command: command.trim(), args };
      if (activate) {
        if (id === 'claude-code') {
          const error = new Error('Claude Code adapter is reserved for a future integration');
          error.status = 409;
          throw error;
        }
        provider = id;
        app.locals.config.provider = provider;
      }
      return { ok: true, selected: provider };
    });
  });

  app.post('/api/agent/context-preview', async (req, res) => {
    const { nodeId, documentId, content = '', temporaryPrompt = '', resourceIds } = req.body || {};
    await resourceResponse(res, async () => {
      const project = await loadProject(workspaceRoot);
      let document = project.documents.find((item) => item.id === documentId) || null;
      let node = document;
      let section = null;
      let parentParagraph = null;
      let targetContent = typeof content === 'string' ? content : '';
      if (typeof nodeId === 'string' && nodeId) {
        const context = await getNodeSourceContext(workspaceRoot, nodeId);
        document = context.document;
        node = context.node;
        section = context.section;
        const parent = context.node.parentId ? findStructureNode(context.document, context.node.parentId) : null;
        parentParagraph = parent?.type === 'paragraph' ? parent : null;
        targetContent = context.selectedContent;
      }
      if (!document) {
        const error = new Error('Document not found');
        error.status = 404;
        throw error;
      }
      const libraryContext = buildLibraryContext(project.libraries, {
        query: [node?.summary, node?.prompt, temporaryPrompt, targetContent].filter(Boolean).join(' '),
        sectionType: section?.title || (node?.type === 'section' ? node.title : ''), resourceIds,
      });
      const scopeLabel = node?.type === 'section' ? `Section · ${node.title}`
        : node?.type === 'paragraph' ? 'Selected paragraph'
          : node?.type === 'sentence' ? 'Selected sentence' : `Document · ${document.title || document.file}`;
      const contextLayers = [
        { name: 'System instruction', value: 'Analyze the selected LaTeX scope and propose reviewable academic-writing edits.' },
        { name: 'Project core prompt', value: project.project.corePrompt },
        { name: 'Document core prompt', value: document.corePrompt },
        { name: 'Section prompt', value: section && section.id !== node?.id ? section.prompt : '' },
        { name: 'Paragraph prompt', value: parentParagraph?.prompt },
        { name: 'Element prompt', value: node?.type !== 'document' ? node?.prompt : '' },
        { name: 'Summary / intent', value: [node?.summary, node?.intent].filter(Boolean).join('\n') },
        { name: 'Writing-library context', value: libraryContext.prompt },
      ].filter((item) => item.value);
      const temporaryLayer = temporaryPrompt ? { name: 'Temporary instruction', value: temporaryPrompt } : null;
      const sourceLayer = { name: 'Target source', value: targetContent };
      const contextPrompt = contextLayers.map((item) => `## ${item.name}\n${item.value}`).join('\n\n');
      const mergedPrompt = [contextPrompt, temporaryLayer && `## ${temporaryLayer.name}\n${temporaryLayer.value}`].filter(Boolean).join('\n\n');
      const layers = [...contextLayers, ...(temporaryLayer ? [temporaryLayer] : []), sourceLayer];
      const assembledPrompt = [mergedPrompt, `## ${sourceLayer.name}\n${sourceLayer.value}`].filter(Boolean).join('\n\n');
      return {
        provider, scope: scopeLabel, contextPrompt, mergedPrompt, assembledPrompt, characterCount: assembledPrompt.length,
        layers: layers.map((item) => ({ name: item.name, characters: item.value.length })),
        library: { mode: libraryContext.mode, resources: libraryContext.resources },
      };
    });
  });

  app.get('/api/agent/runs', async (_req, res) => {
    await resourceResponse(res, async () => ({ runs: await listAgentRuns(workspaceRoot) }));
  });

  app.get('/api/project', async (_req, res) => {
    try {
      res.json({ project: await loadProject(workspaceRoot) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/project', async (req, res) => {
    try {
      const project = await saveProject(workspaceRoot, req.body?.project);
      res.json({ ok: true, project });
    } catch (e) {
      if (e.code === 'INVALID_PROJECT') {
        return res.status(400).json({ error: e.message, details: e.details });
      }
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/documents/sync', async (req, res) => {
    const { file } = req.body || {};
    if (typeof file !== 'string' || !file) return res.status(400).json({ error: 'file is required' });
    await resourceResponse(res, async () => ({ document: await syncDocumentStructure(workspaceRoot, file) }));
  });

  app.get('/api/documents/:id/structure', async (req, res) => {
    await resourceResponse(res, async () => ({ document: await getDocumentStructure(workspaceRoot, req.params.id) }));
  });

  app.put('/api/documents/:id/metadata', async (req, res) => {
    await resourceResponse(res, async () => ({
      document: await updateDocumentMetadata(workspaceRoot, req.params.id, req.body),
    }));
  });

  app.put('/api/structure/nodes/:id', async (req, res) => {
    await resourceResponse(res, async () => ({
      node: await updateNodeMetadata(workspaceRoot, req.params.id, req.body),
    }));
  });

  app.get('/api/libraries', async (_req, res) => {
    await resourceResponse(res, async () => ({ libraries: await getLibraries(workspaceRoot) }));
  });

  app.post('/api/libraries/search', async (req, res) => {
    await resourceResponse(res, async () => {
      const libraries = await getLibraries(workspaceRoot);
      return { results: searchLibraries(libraries, req.body || {}) };
    });
  });

  app.post('/api/libraries/context', async (req, res) => {
    await resourceResponse(res, async () => {
      const libraries = await getLibraries(workspaceRoot);
      return { context: buildLibraryContext(libraries, req.body || {}) };
    });
  });

  app.post('/api/libraries/render-pattern', async (req, res) => {
    await resourceResponse(res, async () => {
      const { patternId, values } = req.body || {};
      const libraries = await getLibraries(workspaceRoot);
      const pattern = libraries.sentencePatterns.find((item) => item.id === patternId);
      if (!pattern) {
        const error = new Error('Sentence pattern not found');
        error.status = 404;
        throw error;
      }
      return renderSentencePattern(pattern, values);
    });
  });

  app.post('/api/libraries/extract', async (req, res) => {
    const { file } = req.body || {};
    if (typeof file !== 'string' || !file) return res.status(400).json({ error: 'file is required' });
    const safe = sanitizePath(file, workspaceRoot);
    if (!safe) return res.status(403).json({ error: 'Access denied' });
    if (!safe.endsWith('.tex')) return res.status(400).json({ error: 'Only .tex files can be analyzed' });
    await resourceResponse(res, async () => ({
      candidates: extractLibraryCandidates(await readFile(safe, 'utf-8'), file),
    }));
  });

  app.post('/api/libraries/vocabulary/:scope', async (req, res) => {
    await resourceResponse(res, async () => ({
      item: await createLibraryResource(workspaceRoot, 'vocabulary', req.params.scope, req.body),
    }), 201);
  });

  app.put('/api/libraries/vocabulary/:scope/:id', async (req, res) => {
    await resourceResponse(res, async () => ({
      item: await updateLibraryResource(workspaceRoot, 'vocabulary', req.params.scope, req.params.id, req.body),
    }));
  });

  app.delete('/api/libraries/vocabulary/:scope/:id', async (req, res) => {
    await resourceResponse(res, async () => {
      await deleteLibraryResource(workspaceRoot, 'vocabulary', req.params.scope, req.params.id);
      return { ok: true };
    });
  });

  app.post('/api/libraries/:kind', async (req, res) => {
    await resourceResponse(res, async () => ({
      item: await createLibraryResource(workspaceRoot, req.params.kind, null, req.body),
    }), 201);
  });

  app.put('/api/libraries/:kind/:id', async (req, res) => {
    await resourceResponse(res, async () => ({
      item: await updateLibraryResource(workspaceRoot, req.params.kind, null, req.params.id, req.body),
    }));
  });

  app.delete('/api/libraries/:kind/:id', async (req, res) => {
    await resourceResponse(res, async () => {
      await deleteLibraryResource(workspaceRoot, req.params.kind, null, req.params.id);
      return { ok: true };
    });
  });

  app.get('/api/annotations', async (req, res) => {
    await resourceResponse(res, async () => ({ annotations: await listAnnotations(workspaceRoot, req.query.documentId) }));
  });

  app.get('/api/reviewer-profiles', (_req, res) => {
    res.json(getReviewerProfileCatalog());
  });

  app.get('/api/reviews', async (req, res) => {
    await resourceResponse(res, async () => ({ reviews: await listReviewRounds(workspaceRoot, req.query.documentId) }));
  });

  app.post('/api/reviews', async (req, res) => {
    await resourceResponse(res, async () => ({ review: await createReviewRound(workspaceRoot, req.body || {}) }), 201);
  });

  app.post('/api/reviews/:id/run', async (req, res) => {
    const controller = new AbortController();
    req.once('aborted', () => controller.abort());
    await resourceResponse(res, async () => ({
      review: await runReviewRound(workspaceRoot, req.params.id, { commands: agentCommands, signal: controller.signal }),
    }));
  });

  app.post('/api/reviews/:id/to-revision', async (req, res) => {
    await resourceResponse(res, async () => await sendReviewItemsToRevision(
      workspaceRoot, req.params.id, req.body?.itemIds, req.body?.title,
    ), 201);
  });

  app.post('/api/review/import', async (req, res) => {
    await resourceResponse(res, async () => ({
      annotations: await importReviewOpinions(workspaceRoot, req.body || {}),
    }), 201);
  });

  app.post('/api/review/orchestrate', async (req, res) => {
    const controller = new AbortController();
    req.once('aborted', () => controller.abort());
    await resourceResponse(res, async () => await orchestrateReviewOpinions(workspaceRoot, req.body || {}, {
      provider, commands: agentCommands, signal: controller.signal,
    }), 201);
  });

  app.post('/api/annotations', async (req, res) => {
    await resourceResponse(res, async () => ({ annotation: await createAnnotation(workspaceRoot, req.body) }), 201);
  });

  app.put('/api/annotations/:id', async (req, res) => {
    await resourceResponse(res, async () => ({ annotation: await updateAnnotation(workspaceRoot, req.params.id, req.body) }));
  });

  app.delete('/api/annotations/:id', async (req, res) => {
    await resourceResponse(res, async () => {
      await deleteAnnotation(workspaceRoot, req.params.id);
      return { ok: true };
    });
  });

  app.get('/api/revisions', async (req, res) => {
    await resourceResponse(res, async () => ({ revisions: await listRevisions(workspaceRoot, req.query.documentId) }));
  });

  app.post('/api/generate/paper', async (req, res) => {
    const controller = new AbortController();
    req.once('aborted', () => controller.abort());
    await resourceResponse(res, async () => await generatePaperRevision(workspaceRoot, req.body || {}, {
      provider, commands: agentCommands, signal: controller.signal,
    }), 201);
  });

  app.get('/api/workflow/history', async (req, res) => {
    await resourceResponse(res, async () => ({ events: await getWorkflowHistory(workspaceRoot, req.query.documentId) }));
  });

  app.get('/api/workflow/export', async (req, res) => {
    await resourceResponse(res, async () => ({ bundle: await buildWorkflowExport(workspaceRoot, req.query.documentId) }));
  });

  app.post('/api/revisions/:id/package', async (req, res) => {
    await resourceResponse(res, async () => await generateRevisionPackage(workspaceRoot, req.params.id));
  });

  app.put('/api/revisions/:id/response-letter', async (req, res) => {
    await resourceResponse(res, async () => ({
      responseLetter: await updateRevisionResponseLetter(workspaceRoot, req.params.id, req.body || {}),
    }));
  });

  app.post('/api/revisions/:id/verify', async (req, res) => {
    await resourceResponse(res, async () => await verifyAppliedRevision(workspaceRoot, req.params.id));
  });

  app.post('/api/revisions/plan', async (req, res) => {
    await resourceResponse(res, async () => ({
      revision: await createRevisionPlan(workspaceRoot, req.body || {}),
    }), 201);
  });

  app.put('/api/revisions/:id/decisions', async (req, res) => {
    await resourceResponse(res, async () => ({
      revision: await decideRevisionChanges(workspaceRoot, req.params.id, req.body?.decisions),
    }));
  });

  app.post('/api/revisions/:id/apply', async (req, res) => {
    await resourceResponse(res, async () => await applyRevision(workspaceRoot, req.params.id));
  });

  app.post('/api/revisions/:id/rollback', async (req, res) => {
    await resourceResponse(res, async () => await rollbackRevision(workspaceRoot, req.params.id));
  });

  app.post('/api/revisions', async (req, res) => {
    await resourceResponse(res, async () => ({ revision: await createRevision(workspaceRoot, req.body) }), 201);
  });

  app.put('/api/revisions/:id', async (req, res) => {
    await resourceResponse(res, async () => ({ revision: await updateRevision(workspaceRoot, req.params.id, req.body) }));
  });

  app.delete('/api/revisions/:id', async (req, res) => {
    await resourceResponse(res, async () => {
      await deleteRevision(workspaceRoot, req.params.id);
      return { ok: true };
    });
  });

  app.get('/api/files', async (_req, res) => {
    try {
      const entries = await readdir(workspaceRoot);
      const files = entries.filter((f) => f.endsWith('.tex'));
      res.json({ files });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/files/*', async (req, res) => {
    const filePath = req.params[0];
    const safe = sanitizePath(filePath, workspaceRoot);
    if (!safe) return res.status(403).json({ error: 'Access denied' });
    try {
      const content = await readFile(safe, 'utf-8');
      res.json({ name: filePath, content });
    } catch (e) {
      if (e.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/files/*', async (req, res) => {
    const filePath = req.params[0];
    const safe = sanitizePath(filePath, workspaceRoot);
    if (!safe) return res.status(403).json({ error: 'Access denied' });
    if (!safe.endsWith('.tex')) return res.status(400).json({ error: 'Only .tex files can be edited' });
    const { content } = req.body;
    if (typeof content !== 'string') return res.status(400).json({ error: 'Content must be a string' });
    try {
      await writeFile(safe, content, 'utf-8');
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/compile', async (req, res) => {
    const { file } = req.body || {};
    if (!file || typeof file !== 'string') return res.status(400).json({ error: 'file is required' });
    const safe = sanitizePath(file, workspaceRoot);
    if (!safe) return res.status(403).json({ error: 'Access denied' });
    if (!safe.endsWith('.tex')) return res.status(400).json({ error: 'Only .tex files can be compiled' });
    try {
      const s = await stat(safe);
      if (!s.isFile()) return res.status(400).json({ error: 'Not a file' });
    } catch {
      return res.status(404).json({ error: 'File not found' });
    }
    try {
      const result = await compile(safe, workspaceRoot);
      if (result.ok) {
        const pdfName = file.replace(/\.tex$/, '.pdf');
        res.json({ ok: true, pdf: `/workspace/${pdfName}`, engine: result.engine });
      } else {
        res.json({ ok: false, error: result.error, engine: result.engine, log: result.log || null });
      }
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/agent/suggest', async (req, res) => {
    const { documentId, content, prompt, promptIsComposed = false, resourceIds } = req.body || {};
    if (typeof content !== 'string') return res.status(400).json({ error: 'content is required' });
    try {
      const project = await loadProject(workspaceRoot);
      const document = project.documents.find((item) => item.id === documentId);
      const effectivePrompt = promptIsComposed ? prompt : [
        project.project.corePrompt && `Paper core prompt:\n${project.project.corePrompt}`,
        document?.corePrompt && `Document prompt:\n${document.corePrompt}`,
        `Current editing request:\n${typeof prompt === 'string' && prompt.trim() ? prompt : 'Improve this scope according to the supplied writing context.'}`,
      ].filter(Boolean).join('\n\n');
      const libraries = project.libraries;
      const libraryContext = buildLibraryContext(libraries, {
        query: `${effectivePrompt}\n${content}`, resourceIds,
      });
      res.json(await requestSuggestions(content, effectivePrompt, req, { libraryContext }));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message, code: e.code, details: e.details });
    }
  });

  app.post('/api/agent/suggest-node', async (req, res) => {
    const { nodeId, prompt, promptIsComposed = false, resourceIds } = req.body || {};
    if (typeof nodeId !== 'string' || !nodeId) return res.status(400).json({ error: 'nodeId is required' });
    try {
      const context = await getNodeSourceContext(workspaceRoot, nodeId);
      const parent = context.node.parentId ? findStructureNode(context.document, context.node.parentId) : null;
      const layers = promptIsComposed ? prompt : [
        context.project.project.corePrompt && `Paper core prompt:\n${context.project.project.corePrompt}`,
        context.document.corePrompt && `Document prompt:\n${context.document.corePrompt}`,
        parent?.type === 'paragraph' && parent.prompt && `Paragraph prompt:\n${parent.prompt}`,
        context.node.prompt && `Element prompt:\n${context.node.prompt}`,
        `Current editing request:\n${typeof prompt === 'string' ? prompt : ''}`,
      ].filter(Boolean).join('\n\n');
      const libraryContext = buildLibraryContext(context.project.libraries, {
        query: `${context.node.summary || ''} ${context.node.prompt || ''} ${prompt || ''} ${context.selectedContent}`,
        sectionType: context.section?.title || '', resourceIds,
      });
      const result = await requestSuggestions(context.selectedContent, layers, req, {
        file: context.document.file, nodeId, nodeStart: context.sourceRange.start,
        libraryContext,
      });
      res.json({ ...result, nodeId, sourceRange: context.sourceRange });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message, code: e.code, details: e.details });
    }
  });

  app.post('/api/agent/generate-paragraph', async (req, res) => {
    const { prompt = '', nodeId, documentId, resourceIds, sectionType } = req.body || {};
    if (typeof prompt !== 'string') return res.status(400).json({ error: 'prompt must be a string' });
    try {
      const project = await loadProject(workspaceRoot);
      let document = project.documents.find((item) => item.id === documentId);
      let node = null;
      let section = null;
      if (typeof nodeId === 'string' && nodeId) {
        const context = await getNodeSourceContext(workspaceRoot, nodeId);
        document = context.document; node = context.node; section = context.section;
      }
      const effectivePrompt = [
        project.project.corePrompt && `Paper core prompt:\n${project.project.corePrompt}`,
        document?.corePrompt && `Document prompt:\n${document.corePrompt}`,
        section?.prompt && section.id !== node?.id && `Section prompt:\n${section.prompt}`,
        node?.prompt && `Element prompt:\n${node.prompt}`,
        `Current paragraph request:\n${prompt.trim() || 'Draft a paragraph that fulfills the supplied writing context.'}`,
      ].filter(Boolean).join('\n\n');
      const libraries = project.libraries;
      const libraryContext = buildLibraryContext(libraries, { query: effectivePrompt, sectionType: section?.title || sectionType || '', resourceIds });
      if (provider === 'mock') {
        const generated = composeMockParagraph(libraries, libraryContext, effectivePrompt);
        const completedAt = new Date().toISOString();
        const run = await createAgentRun(workspaceRoot, {
          provider, operation: 'generate-paragraph', status: 'complete', prompt: effectivePrompt,
          input: JSON.stringify({ providedResources: libraryContext.resources, libraryMode: libraryContext.mode }),
          output: JSON.stringify(generated), error: '', startedAt: completedAt, finishedAt: completedAt,
        });
        return res.json({
          provider, runId: run.id, draft: generated.draft,
          library: {
            mode: libraryContext.mode, providedResources: libraryContext.resources,
            usedResourceIds: generated.usedResourceIds,
          },
        });
      }
      const sentinel = '[[PAPERGOD_PARAGRAPH_DRAFT]]';
      const instruction = `Generate one cohesive academic paragraph for this writing context:\n${effectivePrompt}\nReturn exactly one suggestion that replaces the exact originalText ${sentinel} with the paragraph.`;
      const result = await requestSuggestions(sentinel, instruction, req, { libraryContext });
      const proposal = result.suggestions.find((item) => item.originalText === sentinel);
      if (!proposal) {
        const error = new Error('Agent did not return a paragraph draft');
        error.status = 502;
        throw error;
      }
      res.json({ ...result, draft: proposal.suggestedText, suggestions: undefined });
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message, code: error.code, details: error.details });
    }
  });

  app.post('/api/agent/insert-paragraph', async (req, res) => {
    await resourceResponse(res, async () => await insertGeneratedParagraph(workspaceRoot, req.body || {}));
  });

  app.post('/api/agent/apply', async (req, res) => {
    const { file, suggestionId } = req.body || {};
    if (!file || !suggestionId) return res.status(400).json({ error: 'file and suggestionId are required' });
    const safe = sanitizePath(file, workspaceRoot);
    if (!safe) return res.status(403).json({ error: 'Access denied' });
    if (!safe.endsWith('.tex')) return res.status(400).json({ error: 'Only .tex files can be edited' });
    try {
      const result = await applySuggestionAsRevision(workspaceRoot, file, getSuggestion(suggestionId));
      removeSuggestion(suggestionId);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message, code: e.code });
    }
  });

  app.post('/api/agent/reject', async (req, res) => {
    const { suggestionId, file } = req.body || {};
    if (!suggestionId || !file) return res.status(400).json({ error: 'file and suggestionId are required' });
    try {
      const revision = await recordRejectedSuggestion(workspaceRoot, file, getSuggestion(suggestionId));
      removeSuggestion(suggestionId);
      res.json({ ok: true, revision });
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message, code: error.code });
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  return app;
}

export async function startServer({ workspaceRoot = DEFAULT_WORKSPACE, port = 3000, provider = 'mock' } = {}) {
  const app = createApp(workspaceRoot, { provider });
  return await new Promise((resolveServer, reject) => {
    const server = app.listen(port, '127.0.0.1', () => resolveServer(server));
    server.once('error', reject);
  });
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  const port = parseInt(process.env.PORT || '3000', 10);
  const host = '127.0.0.1';
  const workspace = process.env.WORKSPACE || DEFAULT_WORKSPACE;
  const server = await startServer({ workspaceRoot: workspace, port });
  console.log(`Papergod running at http://${host}:${server.address().port}`);

  function shutdown() {
    console.log('\nShutting down...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
