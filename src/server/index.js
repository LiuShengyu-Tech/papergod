import express from 'express';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile, stat } from 'fs/promises';
import { createHash, randomUUID } from 'crypto';
import { spawn } from 'child_process';
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
import { AGENT_PROVIDERS, buildSuggestionPayload, detectAgentProviders, runWritingAgent } from './agent-adapters.js';
import { alignSuggestionsToManifest, loadPromptManifest, materializePromptManifest } from './prompt-manifest.js';
import { agentFailureAudit, redactAgentDiagnostic } from './agent-errors.js';
import {
  syncDocumentStructure, getDocumentStructure, updateDocumentMetadata,
  updateNodeMetadata, getNodeSourceContext,
} from './document-structure.js';
import { buildLibraryContext, composeMockParagraph, extractLibraryCandidates, renderSentencePattern, searchLibraries } from './library-engine.js';
import { findStructureNode } from './latex-structure.js';
import { getChangeHistoryEntry, getHistoricalRevisionSource, getRecentChangeHistory } from './change-history.js';
import {
  applyRevision, applySuggestionAsRevision, applySuggestionsAsRevision, createRevisionPlan, decideRevisionChanges, importReviewOpinions, insertGeneratedParagraph, orchestrateReviewOpinions, recordRejectedSuggestion, restoreRevisionVersion, rollbackRevision,
} from './revision-engine.js';
import {
  createReviewRound, getReviewerProfileCatalog, listReviewRounds, runReviewRound, sendReviewItemsToRevision,
} from './review-panel.js';
import {
  buildWorkflowExport, generatePaperRevision, generateRevisionPackage, getWorkflowHistory,
  updateRevisionResponseLetter, verifyAppliedRevision,
} from './revise-workflow.js';
import { initializeWorkspace, listTexFiles, resolveEntryFile, saveEntryFile } from './workspace.js';
import { toHostPath } from './host-paths.js';

// Registry entries hold server paths; show host paths (e.g. C:\Users\...) in
// the UI when running in a container. A no-op outside containers.
function displayWorkspace(entry) {
  return entry ? { ...entry, path: toHostPath(entry.path) } : entry;
}
import { createWorkspaceRegistry } from './workspace-registry.js';
import { browseWorkspaceDirectories } from './workspace-browser.js';
import { createWorkspaceTerminalManager } from './workspace-terminal.js';
import {
  addReferenceFolder, buildCitationContext, checkWorkspaceCitations, configureReferences, findUnknownAgentCitations, importReferences, parseBibTeX,
  loadReferenceState, removeReferenceFolder, resolveStoredReference, scanAllReferenceFolders,
  updateReference, writeBibliography,
} from './references.js';
import {
  enrichZoteroAttachment, exportBetterBibTeX, getZoteroFullText, getZoteroStatus, listZoteroCollections, searchZoteroItems,
} from './zotero.js';
import { generateLiteratureReview } from './literature-review.js';
import { extractTextCandidates } from './text-extraction.js';
import { materializeLibraries } from './library-files.js';
import {
  createOrchestration, createOrchestrationManager, deleteOrchestration, getOrchestration,
  listOrchestrations, resetOrchestration, updateOrchestration,
} from './orchestration-engine.js';
import { analyzeStructure, ANALYSIS_FORMULAS } from './paragraph-analysis.js';
import { getAppVersionInfo } from './app-version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');
const DEFAULT_WORKSPACE = join(PROJECT_ROOT, 'example');
const EXTERNAL_AGENT_PROVIDERS = AGENT_PROVIDERS.filter((item) => item !== 'mock');

function publicErrorMessage(error) {
  const message = String(error?.message || 'Unexpected error');
  if (error?.code === 'ENOENT') return 'The configured Agent CLI command was not found.';
  if (error?.code === 'AGENT_TIMEOUT') return 'The Agent did not respond before the timeout.';
  if (error?.code === 'AGENT_CONTENT_FILTERED') return 'The model output was interrupted by the provider content filter. No partial result was applied. Try a shorter or differently worded editing instruction.';
  if (error?.code === 'AGENT_REFUSED') return 'The model refused this request. No partial result was applied.';
  if (error?.code === 'AGENT_OUTPUT_TRUNCATED') return 'The model output ended before the structured result was complete. No partial result was applied.';
  if (error?.code === 'AGENT_EMPTY_RESPONSE') return 'The Agent returned no usable structured result.';
  if (error?.code === 'AGENT_CLI_INCOMPATIBLE') return 'The installed Agent CLI does not support Papergod’s required structured-output protocol. Update the CLI and retry.';
  if (error?.code === 'AGENT_COOLDOWN') return `${message} Retry in ${Math.max(1, Math.ceil((error.retryAfterMs || 0) / 1000))} seconds or choose another configured provider.`;
  if (/invalid_json_schema/i.test(message)) return 'The Agent rejected Papergod’s structured output schema. Update Papergod or choose another provider.';
  if (/auth|sign.?in|log.?in|unauthorized|forbidden|\b401\b|\b403\b/i.test(message)) return 'The Agent CLI is installed but its model provider is not authenticated.';
  if (/rate.?limit|quota|too many requests|\b429\b/i.test(message)) return 'The Agent provider rate limit or quota was reached. Try again later or choose another provider.';
  if (message.length > 800 || message.split('\n').length > 8) return `${message.split('\n').find((line) => /error/i.test(line)) || message.split('\n')[0]}`.slice(0, 800);
  return message;
}

async function resourceResponse(res, operation, successStatus = 200) {
  try {
    const result = await operation();
    res.status(successStatus).json(result);
  } catch (error) {
    if (error.code === 'INVALID_PROJECT') {
      return res.status(400).json({ error: error.message, details: error.details });
    }
    res.status(error.status || 500).json({ error: publicErrorMessage(error), code: error.code });
  }
}

export function createApp(initialWorkspaceRoot = DEFAULT_WORKSPACE, options = {}) {
  let workspaceRoot = resolve(initialWorkspaceRoot);
  let provider = options.provider || 'mock';
  const baseAgentCommands = { ...(options.agentCommands || {}) };
  const agentCommands = { ...baseAgentCommands };
  const agentProbeJobs = new Map();
  const agentActivityJobs = new Map();
  const agentConnectionState = new Map();
  const recordAgentConnection = (id, update = {}) => {
    const previous = agentConnectionState.get(id) || {};
    const next = { ...previous, ...update, checkedAt: new Date().toISOString() };
    agentConnectionState.set(id, next);
    return next;
  };
  let activeWorkspaceRequests = 0;
  const workspaceRegistry = createWorkspaceRegistry({ file: options.workspaceRegistryFile });
  const terminalManager = options.terminalManager || createWorkspaceTerminalManager();
  const orchestrationManager = createOrchestrationManager();
  const app = express();
  app.locals.cleanup = () => terminalManager.closeAll();
  app.locals.config = { workspaceRoot, provider };
  app.locals.orchestrations = orchestrationManager;
  app.use(express.json({ limit: '10mb' }));
  app.use(securityHeaders);
  app.use('/vendor/codemirror', express.static(join(PROJECT_ROOT, 'node_modules', 'codemirror'), { dotfiles: 'deny' }));
  app.use('/vendor/pdfjs-dist', express.static(join(PROJECT_ROOT, 'node_modules', 'pdfjs-dist'), { dotfiles: 'deny' }));
  app.use(express.static(join(PROJECT_ROOT, 'public')));
  app.use('/api', (req, res, next) => {
    if (req.path === '/version' || req.path === '/workspaces' || req.path.startsWith('/workspaces/') || req.path === '/terminal' || req.path.startsWith('/terminal/')) return next();
    activeWorkspaceRequests += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeWorkspaceRequests = Math.max(0, activeWorkspaceRequests - 1);
    };
    res.once('finish', release);
    res.once('close', release);
    next();
  });

  function beginAgentActivity(id, activeProvider) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(id)) return null;
    const activity = { id, provider: activeProvider, status: 'running', output: '', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    agentActivityJobs.set(id, activity);
    return activity;
  }

  function appendAgentActivity(activity, stream, chunk) {
    if (!activity || typeof chunk !== 'string') return;
    const clean = chunk.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '').replace(/[^\x09\x0a\x0d\x20-\x7e\u0080-\uffff]/g, '');
    if (!clean) return;
    activity.rawOutput = `${activity.rawOutput || ''}${stream === 'stderr' ? '[stderr] ' : ''}${clean}`.slice(-50_000);
    activity.output = redactAgentDiagnostic(activity.rawOutput, 40_000);
    activity.updatedAt = new Date().toISOString();
  }

  function finishAgentActivity(activity, status, message = '') {
    if (!activity) return;
    if (message) appendAgentActivity(activity, status === 'failed' ? 'stderr' : 'stdout', `${message}\n`);
    activity.status = status;
    activity.updatedAt = new Date().toISOString();
  }

  async function hydrateAgentCommands(projectData = null, { loadProvider = false } = {}) {
    const project = projectData || await loadProject(workspaceRoot);
    const profiles = project.project.agentProfiles || {};
    for (const id of EXTERNAL_AGENT_PROVIDERS) delete agentCommands[id];
    Object.assign(agentCommands, baseAgentCommands);
    for (const id of EXTERNAL_AGENT_PROVIDERS) {
      const profile = profiles[id];
      if (profile?.command?.trim()) {
        agentCommands[id] = {
          command: profile.command.trim(),
          args: Array.isArray(profile.args) ? profile.args : [],
          model: typeof profile.model === 'string' ? profile.model.trim() : '',
          reasoningEffort: typeof profile.reasoningEffort === 'string' ? profile.reasoningEffort : '',
        };
      }
    }
    if (loadProvider) {
      provider = AGENT_PROVIDERS.includes(project.project.activeAgentProvider) ? project.project.activeAgentProvider : (options.provider || 'mock');
      app.locals.config.provider = provider;
    }
    return project;
  }

  async function switchWorkspace(target) {
    const runningProbe = [...agentProbeJobs.values()].some((job) => ['queued', 'running'].includes(job.status));
    const runningActivity = [...agentActivityJobs.values()].some((job) => job.status === 'running');
    if (runningProbe || runningActivity || activeWorkspaceRequests > 0 || orchestrationManager.anyRunning()) {
      throw Object.assign(new Error('Wait for the active paper task to finish before switching workspaces.'), { status: 409, code: 'WORKSPACE_BUSY' });
    }
    const entry = await workspaceRegistry.activate(target);
    const initialization = await initializeWorkspace(entry.path);
    workspaceRoot = entry.path;
    app.locals.config.workspaceRoot = workspaceRoot;
    agentProbeJobs.clear();
    agentActivityJobs.clear();
    await hydrateAgentCommands(initialization.project, { loadProvider: true });
    return { entry, initialization };
  }

  async function requestSuggestions(content, prompt, req, context = {}) {
    const libraryContext = context.libraryContext || { prompt: '', resources: [], resourceIds: [], mode: 'automatic' };
    const workspace = context.file
      ? { file: context.file, start: context.nodeStart ?? 0, end: (context.nodeStart ?? 0) + content.length }
      : null;
    if (context.payloadHash) {
      const payload = buildSuggestionPayload(provider, { content, prompt, resourceContext: libraryContext.prompt, resourceIds: libraryContext.resourceIds, workspace, manifest: context.manifest || null }, { workspaceRoot });
      const actualHash = createHash('sha256').update(payload).update('\0').update(context.manifestSerialized || '').digest('hex');
      if (actualHash !== context.payloadHash) throw Object.assign(new Error('The final Agent payload changed after preview; refresh the prompt preview and try again.'), { status: 409, code: 'PROMPT_PREVIEW_STALE' });
    }
    const runInput = {
      characters: content.length,
      providedResources: libraryContext.resources,
      libraryMode: context.manifest ? 'workspace-manifest' : libraryContext.mode,
      ...(context.manifest ? { manifest: context.manifest, manifestPath: context.manifestPath, payloadHash: context.payloadHash } : {}),
      ...(context.intentIds?.length ? { intentIds: context.intentIds } : {}),
    };
    const activity = beginAgentActivity(req.body?.activityId, provider);
    appendAgentActivity(activity, 'stdout', `Starting ${provider} Agent in ${workspaceRoot}\n`);
    if (provider === 'mock') {
      let unresolvedTasks = [];
      let suggestions;
      if (context.manifest?.tasks?.length) {
        const proposed = [];
        for (const task of context.manifest.tasks) {
          const quote = task.target.exactQuote;
          const range = task.target.sourceRange;
          const scope = quote || content.slice(range?.start || 0, range?.end ?? content.length);
          const candidate = generateSuggestions(scope, task.instruction)[0];
          if (!candidate || candidate.originalText === candidate.suggestedText) {
            unresolvedTasks.push({ taskId: task.taskId, reason: 'The deterministic Mock Agent had no applicable transformation for this target.' });
            continue;
          }
          proposed.push({
            ...candidate, taskId: task.taskId, nodeId: task.target.nodeId,
            originalText: quote || candidate.originalText,
            suggestedText: quote ? quote.replace(candidate.originalText, candidate.suggestedText) : candidate.suggestedText,
            usedTemplateIds: [], usedCitekeys: [],
          });
        }
        suggestions = registerSuggestions(alignSuggestionsToManifest(proposed, context.manifest, unresolvedTasks, content));
      } else suggestions = generateSuggestions(content, prompt);
      attachSuggestionContext(suggestions, { ...context, selectedContent: content });
      const completedAt = new Date().toISOString();
      const run = await createAgentRun(workspaceRoot, {
        provider, operation: 'suggest', status: 'complete', prompt,
        input: JSON.stringify(runInput),
        output: JSON.stringify({ usedResourceIds: [], unresolvedTasks }), error: '', startedAt: completedAt, finishedAt: completedAt,
      });
      finishAgentActivity(activity, 'complete', `Mock Agent produced ${suggestions.length} suggestion${suggestions.length === 1 ? '' : 's'}.`);
      return {
        provider, runId: run.id, suggestions, unresolvedTasks, summary: unresolvedTasks.length ? `${unresolvedTasks.length} manifest task(s) were left unresolved by the Mock Agent.` : 'Mock Agent completed.',
        library: { mode: libraryContext.mode, providedResources: libraryContext.resources, usedResourceIds: [] },
      };
    }
    await hydrateAgentCommands();
    if (!context.manifest) await materializeLibraries(workspaceRoot);
    const startedAt = new Date().toISOString();
    const run = await createAgentRun(workspaceRoot, {
      provider, operation: 'suggest', status: 'running', prompt,
      input: JSON.stringify(runInput),
      output: '', error: '', startedAt, finishedAt: '',
    });
    try {
      const controller = new AbortController();
      req.once('aborted', () => controller.abort());
      const result = await runWritingAgent(provider, {
        content, prompt, resourceContext: libraryContext.prompt, resourceIds: libraryContext.resourceIds,
        workspace, manifest: context.manifest || null,
      }, {
        workspaceRoot, commands: agentCommands, signal: controller.signal,
        onOutput: (stream, chunk) => appendAgentActivity(activity, stream, chunk),
      });
      const referenceState = await loadReferenceState(workspaceRoot);
      const unknownCitekeys = findUnknownAgentCitations(result.suggestions, content, referenceState.items);
      if (unknownCitekeys.length) throw Object.assign(new Error(`Agent proposed unknown citation keys: ${unknownCitekeys.join(', ')}`), { status: 422, code: 'UNKNOWN_CITATION_KEY' });
      recordAgentConnection(provider, { ok: true, status: 'complete', authenticated: true, authStatus: 'Last real Agent request passed', error: '', code: '' });
      const suggestions = registerSuggestions(alignSuggestionsToManifest(result.suggestions, context.manifest, result.unresolvedTasks, content));
      attachSuggestionContext(suggestions, { ...context, selectedContent: content });
      await updateAgentRun(workspaceRoot, run.id, {
        status: 'complete', output: JSON.stringify({ ...result, agentMeta: result.agentMeta }), finishedAt: new Date().toISOString(),
      });
      finishAgentActivity(activity, 'complete', 'Agent process completed successfully.');
      return {
        provider, agentMeta: result.agentMeta, runId: run.id, summary: result.summary, suggestions, unresolvedTasks: result.unresolvedTasks || [],
        library: {
          mode: libraryContext.mode, providedResources: libraryContext.resources,
          usedResourceIds: result.usedResourceIds,
        },
      };
    } catch (error) {
      if (error.code === 'AGENT_AUTH_REQUIRED') recordAgentConnection(provider, { ok: false, status: 'failed', authenticated: false, authStatus: 'Authentication failed · sign in again', error: publicErrorMessage(error), code: error.code });
      else recordAgentConnection(provider, { ok: false, status: 'failed', error: publicErrorMessage(error), code: error.code || '' });
      finishAgentActivity(activity, 'failed', publicErrorMessage(error));
      await updateAgentRun(workspaceRoot, run.id, {
        status: 'failed', error: agentFailureAudit(error), finishedAt: new Date().toISOString(),
      });
      error.status ||= 502;
      throw error;
    }
  }

  app.use('/workspace', (req, res, next) => {
    const relPath = req.path.replace(/^\//, '');
    if (relPath.split('/').some((part) => part.startsWith('.'))) return res.status(403).json({ error: 'Access denied' });
    const safe = sanitizePath(relPath, workspaceRoot);
    if (!safe) return res.status(403).json({ error: 'Access denied' });
    req._safePath = safe;
    next();
  });
  app.use('/workspace', async (req, res, next) => {
    try {
      const info = await stat(req._safePath);
      if (!info.isFile()) return next();
      res.sendFile(req._safePath);
    } catch (error) {
      if (error.code === 'ENOENT') return next();
      next(error);
    }
  });

  app.get('/api/version', async (_req, res) => {
    res.json(await getAppVersionInfo());
  });

  app.get('/api/engines', async (_req, res) => {
    try {
      const engines = await detectEngines();
      res.json({ engines });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message, code: e.code });
    }
  });

  app.get('/api/config', async (_req, res) => {
    try {
      await workspaceRegistry.add(workspaceRoot, { activate: true });
      await hydrateAgentCommands(null, { loadProvider: true });
      res.json({ provider, workspace: toHostPath(workspaceRoot) });
    } catch (error) {
      res.status(error.status || 500).json({ error: publicErrorMessage(error), code: error.code });
    }
  });

  app.get('/api/workspaces', async (_req, res) => {
    await resourceResponse(res, async () => {
      await workspaceRegistry.add(workspaceRoot, { activate: true });
      const workspaces = await workspaceRegistry.list(workspaceRoot);
      return {
        activePath: toHostPath(workspaceRoot),
        workspaces: workspaces.filter((item) => item.available || item.active).map(displayWorkspace),
      };
    });
  });

  app.get('/api/workspaces/browse', async (req, res) => {
    await resourceResponse(res, async () => {
      const listing = await browseWorkspaceDirectories(req.query.path || '');
      return {
        ...listing,
        rootPath: toHostPath(listing.rootPath),
        currentPath: toHostPath(listing.currentPath),
        parentPath: listing.parentPath && toHostPath(listing.parentPath),
        entries: listing.entries.map((entry) => ({ ...entry, path: toHostPath(entry.path) })),
      };
    });
  });

  app.post('/api/workspaces', async (req, res) => {
    await resourceResponse(res, async () => {
      await workspaceRegistry.add(workspaceRoot, { activate: true });
      const registered = await workspaceRegistry.add(req.body?.path);
      const { entry, initialization } = await switchWorkspace(registered.id);
      return { workspace: displayWorkspace(entry), createdSample: initialization.createdSample };
    }, 201);
  });

  app.post('/api/workspaces/:id/activate', async (req, res) => {
    await resourceResponse(res, async () => {
      const { entry, initialization } = await switchWorkspace(req.params.id);
      return { workspace: displayWorkspace(entry), createdSample: initialization.createdSample };
    });
  });

  app.post('/api/workspaces/pick-folder', async (_req, res) => {
    if (typeof options.folderPicker === 'function') {
      return resourceResponse(res, async () => ({ path: await options.folderPicker(workspaceRoot) }));
    }
    const candidates = process.platform === 'darwin'
      ? [['osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose a Papergod workspace")']]]
      : [
        ['zenity', ['--file-selection', '--directory', '--title=Choose a Papergod workspace']],
        ['kdialog', ['--getexistingdirectory', workspaceRoot]],
        ['python3', ['-c', 'import sys, tkinter as tk; from tkinter import filedialog; root=tk.Tk(); root.withdraw(); root.attributes("-topmost", True); root.update(); path=filedialog.askdirectory(parent=root, initialdir=sys.argv[1], title="Choose a Papergod workspace", mustexist=True); print(path); root.destroy()', workspaceRoot], false],
      ];
    const tryPicker = (index = 0) => new Promise((resolvePicker, rejectPicker) => {
      if (!candidates[index]) return rejectPicker(Object.assign(new Error('No graphical folder picker is available. Paste an absolute folder path instead.'), { status: 501, code: 'PICKER_UNAVAILABLE' }));
      const [command, args, cancelOnExitOne = true] = candidates[index];
      const child = spawn(command, args, { shell: false, windowsHide: true });
      let output = '';
      let unavailable = false;
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 5 * 60_000);
      child.stdout?.on('data', (chunk) => { output += chunk; });
      child.once('error', (error) => {
        clearTimeout(timeout);
        unavailable = true;
        if (error.code === 'ENOENT') tryPicker(index + 1).then(resolvePicker, rejectPicker);
        else rejectPicker(error);
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        if (unavailable) return;
        if (timedOut) return rejectPicker(Object.assign(new Error('Folder picker timed out.'), { status: 504, code: 'PICKER_TIMEOUT' }));
        if (code === 0 && output.trim()) resolvePicker(output.trim());
        else if (code === 0) rejectPicker(Object.assign(new Error('Folder selection was cancelled.'), { status: 409, code: 'PICKER_CANCELLED' }));
        else if (code === 1 && cancelOnExitOne) rejectPicker(Object.assign(new Error('Folder selection was cancelled.'), { status: 409, code: 'PICKER_CANCELLED' }));
        else if (code !== null) tryPicker(index + 1).then(resolvePicker, rejectPicker);
      });
    });
    await resourceResponse(res, async () => ({ path: await tryPicker() }));
  });

  const requireCurrentTerminal = (id) => {
    const session = terminalManager.get(id);
    if (session.workspace !== workspaceRoot) throw Object.assign(new Error('Terminal belongs to another workspace.'), { status: 409, code: 'TERMINAL_WORKSPACE_MISMATCH' });
    return session;
  };

  app.post('/api/terminal', async (_req, res) => {
    await resourceResponse(res, async () => ({ session: terminalManager.start(workspaceRoot) }), 201);
  });

  app.get('/api/terminal/:id/events', (req, res) => {
    try {
      requireCurrentTerminal(req.params.id);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
      const detach = terminalManager.attach(req.params.id, res);
      const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15_000);
      req.once('close', () => { clearInterval(heartbeat); detach(); });
    } catch (error) {
      res.status(error.status || 500).json({ error: publicErrorMessage(error), code: error.code });
    }
  });

  app.post('/api/terminal/:id/input', async (req, res) => {
    await resourceResponse(res, async () => {
      requireCurrentTerminal(req.params.id);
      terminalManager.input(req.params.id, req.body?.data);
      return { ok: true };
    });
  });

  app.post('/api/terminal/:id/resize', async (req, res) => {
    await resourceResponse(res, async () => {
      requireCurrentTerminal(req.params.id);
      terminalManager.resize(req.params.id, req.body?.cols, req.body?.rows);
      return { ok: true };
    });
  });

  app.delete('/api/terminal/:id', async (req, res) => {
    await resourceResponse(res, async () => {
      requireCurrentTerminal(req.params.id);
      terminalManager.close(req.params.id);
      return { ok: true };
    });
  });

  const zoteroConnectionOptions = async (overrides = {}) => {
    const state = await loadReferenceState(workspaceRoot);
    return {
      ...state.zotero, baseUrl: options.zoteroBaseUrl,
      ...(options.zoteroFetch ? { fetchImpl: options.zoteroFetch } : {}), ...overrides,
    };
  };

  app.get('/api/references', async (req, res) => {
    await resourceResponse(res, async () => {
      const state = await loadReferenceState(workspaceRoot);
      const query = String(req.query.q || '').trim().toLowerCase();
      const items = query ? state.items.filter((item) => [item.citekey, item.title, item.year, item.doi, ...(item.authors || [])].join(' ').toLowerCase().includes(query)) : state.items;
      return { ...state, items };
    });
  });

  app.put('/api/references/config', async (req, res) => {
    await resourceResponse(res, async () => ({ state: await configureReferences(workspaceRoot, req.body || {}) }));
  });

  app.post('/api/references/folders', async (req, res) => {
    await resourceResponse(res, async () => await addReferenceFolder(workspaceRoot, req.body?.path), 201);
  });

  app.delete('/api/references/folders', async (req, res) => {
    await resourceResponse(res, async () => ({ state: await removeReferenceFolder(workspaceRoot, req.body?.path) }));
  });

  app.post('/api/references/scan', async (_req, res) => {
    await resourceResponse(res, async () => await scanAllReferenceFolders(workspaceRoot));
  });

  app.post('/api/references/import', async (req, res) => {
    await resourceResponse(res, async () => ({ state: await importReferences(workspaceRoot, req.body?.references) }), 201);
  });

  app.patch('/api/references/:id', async (req, res) => {
    await resourceResponse(res, async () => await updateReference(workspaceRoot, req.params.id, req.body || {}));
  });

  app.post('/api/references/:id/resolve', async (req, res) => {
    await resourceResponse(res, async () => await resolveStoredReference(workspaceRoot, req.params.id, options.referenceFetch ? { fetchImpl: options.referenceFetch } : {}));
  });

  app.post('/api/references/bibliography', async (_req, res) => {
    await resourceResponse(res, async () => await writeBibliography(workspaceRoot));
  });

  app.post('/api/references/review', async (req, res) => {
    await resourceResponse(res, async () => {
      await hydrateAgentCommands();
      return await generateLiteratureReview(workspaceRoot, req.body || {}, { provider, commands: agentCommands });
    }, 201);
  });

  app.post('/api/references/check', async (req, res) => {
    await resourceResponse(res, async () => await checkWorkspaceCitations(workspaceRoot, req.body?.file));
  });

  app.get('/api/references/zotero/status', async (_req, res) => {
    await resourceResponse(res, async () => ({ status: await getZoteroStatus(await zoteroConnectionOptions()) }));
  });

  app.get('/api/references/zotero/collections', async (_req, res) => {
    await resourceResponse(res, async () => ({ collections: await listZoteroCollections(await zoteroConnectionOptions()) }));
  });

  app.get('/api/references/zotero/items', async (req, res) => {
    await resourceResponse(res, async () => ({
      items: await searchZoteroItems(await zoteroConnectionOptions({ query: String(req.query.q || ''), collectionKey: String(req.query.collectionKey || '') })),
    }));
  });

  app.post('/api/references/zotero/import', async (req, res) => {
    await resourceResponse(res, async () => {
      if (!Array.isArray(req.body?.references)) throw Object.assign(new Error('references must be an array.'), { status: 400 });
      const connection = await zoteroConnectionOptions();
      const enriched = [];
      for (const reference of req.body.references.slice(0, 100)) enriched.push(await enrichZoteroAttachment(reference, connection));
      let imported = enriched;
      try {
        const status = await getZoteroStatus(connection);
        if (status.betterBibtex) {
          const bibtex = await exportBetterBibTeX(enriched.map((item) => item.citekey), connection);
          const exported = parseBibTeX(bibtex, 'zotero://better-bibtex');
          imported = enriched.map((item) => {
            const match = exported.find((entry) => entry.citekey === item.citekey);
            return match ? { ...item, ...match, id: item.id, source: 'zotero', sourceId: item.sourceId, hasPdf: item.hasPdf, attachmentKey: item.attachmentKey } : item;
          });
        }
      } catch { imported = enriched; }
      const state = await importReferences(workspaceRoot, imported);
      return { state, imported: enriched.length };
    }, 201);
  });

  app.get('/api/references/zotero/fulltext/:attachmentKey', async (req, res) => {
    await resourceResponse(res, async () => {
      const fulltext = await getZoteroFullText(req.params.attachmentKey, await zoteroConnectionOptions());
      const content = String(fulltext.content || '');
      return { ...fulltext, content: content.slice(0, 1_000_000), truncated: content.length > 1_000_000 };
    });
  });

  app.get('/api/agent/activity/:id', (req, res) => {
    const activity = agentActivityJobs.get(req.params.id);
    if (!activity) return res.status(404).json({ error: 'Agent activity not found' });
    const { rawOutput: _rawOutput, ...safeActivity } = activity;
    res.json(safeActivity);
  });

  app.post('/api/workspace/open-folder', (_req, res) => {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
    const child = spawn(command, [workspaceRoot], { detached: true, stdio: 'ignore', shell: false });
    child.once('spawn', () => { child.unref(); res.json({ ok: true, workspace: workspaceRoot }); });
    child.once('error', (error) => res.status(500).json({ error: `Could not open the paper folder: ${error.message}` }));
  });

  app.get('/api/agents', async (_req, res) => {
    await resourceResponse(res, async () => {
      const project = await hydrateAgentCommands(null, { loadProvider: true });
      const detected = await detectAgentProviders({ commands: agentCommands });
      const detectedById = new Map(detected.map((item) => [item.provider, item]));
      const saved = project.project.agentProfiles || {};
      const definitions = [
        { id: 'mock', label: 'Mock', adapter: 'built-in', command: '', capabilities: ['revise', 'paragraph', 'review', 'generation'], integration: 'ready' },
        { id: 'codex', label: 'Codex CLI', adapter: 'structured-cli', command: 'codex', capabilities: ['revise', 'paragraph', 'review', 'generation'], integration: 'ready' },
        { id: 'claude-code', label: 'Claude Code', adapter: 'structured-cli', command: 'claude', capabilities: ['revise', 'paragraph', 'review', 'generation'], integration: 'ready' },
        { id: 'opencode', label: 'OpenCode CLI', adapter: 'structured-cli', command: 'opencode', capabilities: ['revise', 'paragraph', 'review', 'generation'], integration: 'ready' },
        { id: 'pi', label: 'Pi Agent', adapter: 'json-event-cli', command: 'pi', capabilities: ['revise', 'paragraph', 'review', 'generation'], integration: 'ready' },
      ];
      return {
        selected: provider,
        providers: definitions.map((definition) => {
          const detectedAgent = detectedById.get(definition.id) || { available: false, authenticated: false, authStatus: 'CLI unavailable', version: null };
          const connection = agentConnectionState.get(definition.id);
          return {
            ...definition,
            command: saved[definition.id]?.command || definition.command,
            args: saved[definition.id]?.args || [],
            model: saved[definition.id]?.model || '',
            reasoningEffort: saved[definition.id]?.reasoningEffort || '',
            ...detectedAgent,
            ...(connection ? {
              authenticated: connection.authenticated ?? detectedAgent.authenticated,
              authStatus: connection.authStatus || detectedAgent.authStatus,
              liveCheck: connection,
            } : {}),
          };
        }),
      };
    });
  });

  app.put('/api/agents/config', async (req, res) => {
    const { id, command = '', args = [], model = '', reasoningEffort = '', activate = false } = req.body || {};
    if (!AGENT_PROVIDERS.includes(id)) return res.status(400).json({ error: 'Unknown Agent provider' });
    if (typeof command !== 'string' || command.length > 500) return res.status(400).json({ error: 'command must be a string up to 500 characters' });
    if (!Array.isArray(args) || args.some((item) => typeof item !== 'string') || args.length > 30) return res.status(400).json({ error: 'args must be an array of strings' });
    if (typeof model !== 'string' || model.length > 200) return res.status(400).json({ error: 'model must be a string up to 200 characters' });
    if (!['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(reasoningEffort)) return res.status(400).json({ error: 'reasoningEffort is invalid' });
    await resourceResponse(res, async () => {
      await updateProject(workspaceRoot, (project) => {
        project.project.agentProfiles ||= {};
        project.project.agentProfiles[id] = { command, args, model, reasoningEffort };
        if (activate) project.project.activeAgentProvider = id;
      });
      if (id !== 'mock' && command.trim()) agentCommands[id] = { command: command.trim(), args, model: model.trim(), reasoningEffort };
      if (activate) {
        provider = id;
        app.locals.config.provider = provider;
      }
      return { ok: true, selected: provider };
    });
  });

  app.post('/api/agents/probe', async (req, res) => {
    const { id, command = '', args = [], model = '', live = false } = req.body || {};
    if (!AGENT_PROVIDERS.includes(id)) return res.status(400).json({ error: 'Unknown Agent provider' });
    if (typeof command !== 'string' || !Array.isArray(args) || args.some((item) => typeof item !== 'string') || typeof model !== 'string') {
      return res.status(400).json({ error: 'Invalid Agent probe configuration' });
    }
    const commands = { ...agentCommands };
    if (id !== 'mock' && command.trim()) commands[id] = { command: command.trim(), args, model: model.trim() };
    if (!live) {
      return resourceResponse(res, async () => {
        const detected = await detectAgentProviders({ commands, providers: [id] });
        return { agent: detected.find((item) => item.provider === id) };
      });
    }

    const testId = `agent_probe_${randomUUID()}`;
    const controller = new AbortController();
    const job = { id: testId, provider: id, status: 'queued', createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, agent: null, liveTest: null, controller };
    agentProbeJobs.set(testId, job);
    while (agentProbeJobs.size > 50) agentProbeJobs.delete(agentProbeJobs.keys().next().value);
    res.status(202).json({ test: { id: testId, provider: id, status: job.status, createdAt: job.createdAt } });

    setImmediate(async () => {
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      const startedAt = Date.now();
      try {
        const detected = await detectAgentProviders({ commands, providers: [id] });
        const agent = detected.find((item) => item.provider === id);
        job.agent = agent;
        if (controller.signal.aborted) throw Object.assign(new Error('Agent live test cancelled'), { code: 'AGENT_CANCELLED' });
        if (id === 'mock') {
          job.liveTest = { ok: true, latencyMs: Date.now() - startedAt, summary: 'Built-in Mock workflow is ready.' };
        } else if (!agent?.available) {
          job.liveTest = { ok: false, latencyMs: Date.now() - startedAt, error: agent?.error || 'CLI unavailable' };
        } else {
          const result = await runWritingAgent(id, {
            content: 'This result is very important.',
            prompt: 'Return one precise academic edit for the supplied sentence.',
            resourceContext: '', resourceIds: [],
          }, { workspaceRoot, commands, timeoutMs: 60_000, signal: controller.signal, liveTest: true });
          job.agent = { ...agent, authenticated: true, authStatus: 'Live subscription test passed' };
          job.liveTest = { ok: true, latencyMs: Date.now() - startedAt, summary: result.summary || 'Structured response validated.' };
        }
        job.status = job.liveTest.ok ? 'complete' : 'failed';
        recordAgentConnection(id, {
          ok: job.liveTest.ok, status: job.status, latencyMs: job.liveTest.latencyMs,
          authenticated: job.liveTest.ok ? true : (agent?.authenticated ?? false),
          authStatus: job.liveTest.ok ? 'Live subscription test passed' : (job.liveTest.error || agent?.authStatus || 'Live test failed'),
          error: job.liveTest.error || '', code: job.liveTest.code || '',
        });
      } catch (error) {
        const cancelled = controller.signal.aborted || error.code === 'AGENT_CANCELLED';
        job.status = cancelled ? 'cancelled' : 'failed';
        job.liveTest = { ok: false, latencyMs: Date.now() - startedAt, error: cancelled ? 'Live test cancelled.' : publicErrorMessage(error), code: error.code };
        const authenticationFailed = error.code === 'AGENT_AUTH_REQUIRED';
        recordAgentConnection(id, {
          ok: false, status: job.status, latencyMs: job.liveTest.latencyMs,
          ...(authenticationFailed ? { authenticated: false, authStatus: 'Live subscription test failed · sign in again' } : {}),
          error: job.liveTest.error, code: error.code || '',
        });
      } finally {
        job.finishedAt = new Date().toISOString();
      }
    });
  });

  app.get('/api/agents/probe/:testId', (req, res) => {
    const job = agentProbeJobs.get(req.params.testId);
    if (!job) return res.status(404).json({ error: 'Agent live test not found' });
    const { controller: _controller, ...test } = job;
    res.json({ test });
  });

  app.delete('/api/agents/probe/:testId', (req, res) => {
    const job = agentProbeJobs.get(req.params.testId);
    if (!job) return res.status(404).json({ error: 'Agent live test not found' });
    if (['queued', 'running'].includes(job.status)) job.controller.abort();
    res.json({ ok: true, status: job.status });
  });

  app.post('/api/agent/context-preview', async (req, res) => {
    const { nodeId, documentId, content = '', temporaryPrompt = '', additionalRequirements = '', intentIds = [], resourceIds = [], citekeys = [] } = req.body || {};
    await resourceResponse(res, async () => {
      const project = await loadProject(workspaceRoot);
      let document = project.documents.find((item) => item.id === documentId) || null;
      let node = document;
      let targetContent = typeof content === 'string' ? content : '';
      let target = document ? { type: 'document', id: document.id, start: 0, end: targetContent.length, quote: '' } : null;
      if (typeof nodeId === 'string' && nodeId) {
        const context = await getNodeSourceContext(workspaceRoot, nodeId);
        document = context.document;
        node = context.node;
        targetContent = context.selectedContent;
        target = { type: context.node.type, id: context.node.id, start: context.sourceRange.start, end: context.sourceRange.end, quote: context.selectedContent };
      }
      if (!document) throw Object.assign(new Error('Document not found'), { status: 404 });
      const manifestResult = await materializePromptManifest(workspaceRoot, {
        documentId: document.id, nodeId, target, intentIds,
        instruction: additionalRequirements || temporaryPrompt,
        additionalRequirements: additionalRequirements || temporaryPrompt,
        sourceContent: nodeId ? undefined : targetContent,
        resourceIds, citekeys,
      });
      const manifestTarget = manifestResult.manifest.tasks.length === 1 ? manifestResult.manifest.tasks[0].target : { file: document.file, sourceRange: { start: 0, end: targetContent.length } };
      const request = {
        prompt: manifestResult.prompt,
        content: targetContent,
        resourceIds,
        workspace: { file: manifestTarget.file || document.file, start: manifestTarget.sourceRange?.start || 0, end: manifestTarget.sourceRange?.end || targetContent.length },
        manifest: manifestResult.manifest,
      };
      const payloadText = buildSuggestionPayload(provider, request, { workspaceRoot });
      const schemaTransport = ['codex', 'claude-code'].includes(provider) ? 'out-of-band' : 'inline';
      const payloadHash = createHash('sha256').update(payloadText).update('\0').update(manifestResult.serialized).digest('hex');
      const primaryPayload = { provider, model: project.project.agentProfiles?.[provider]?.model || '', text: payloadText, characters: payloadText.length, tokenEstimate: Math.ceil(payloadText.length / 4), schemaTransport, hash: payloadHash };
      const scopeLabel = intentIds.length ? `${manifestResult.manifest.tasks.length} atomic modification tasks`
        : node?.type === 'section' ? `Section · ${node.title}`
          : node?.type === 'paragraph' ? 'Selected paragraph'
            : node?.type === 'sentence' ? 'Selected sentence' : `Document · ${document.title || document.file}`;
      const resourceLayers = Object.entries(manifestResult.manifest.resources).map(([name, value]) => ({ name: `Resource · ${name}`, characters: JSON.stringify(value).length, path: value }));
      return {
        provider, scope: scopeLabel,
        contextPrompt: manifestResult.prompt,
        mergedPrompt: manifestResult.prompt,
        assembledPrompt: payloadText,
        characterCount: payloadText.length,
        tokenEstimate: Math.ceil(payloadText.length / 4),
        budget: { limitCharacters: 500000, totalCharacters: payloadText.length, remainingCharacters: 500000 - payloadText.length },
        payload: primaryPayload,
        manifest: manifestResult.manifest,
        manifestPath: manifestResult.manifestPath,
        manifestHash: manifestResult.manifestHash,
        layers: [
          { name: `CLI payload · ${provider}${primaryPayload.model ? `/${primaryPayload.model}` : ''} · ${schemaTransport}`, characters: primaryPayload.characters },
          { name: 'Prompt manifest', characters: manifestResult.manifestCharacterCount, path: manifestResult.manifestPath },
          ...resourceLayers,
        ],
        library: { mode: 'workspace-manifest', resources: resourceIds },
      };
    });
  });

  app.get('/api/agent/runs', async (_req, res) => {
    await resourceResponse(res, async () => ({ runs: await listAgentRuns(workspaceRoot) }));
  });

  app.get('/api/analysis/formulas', (_req, res) => {
    res.json({ formulas: ANALYSIS_FORMULAS });
  });

  app.post('/api/analysis/structure', async (req, res) => {
    await resourceResponse(res, async () => ({
      analysis: await analyzeStructure(workspaceRoot, req.body || {}),
    }));
  });

  app.get('/api/orchestrations', async (_req, res) => {
    await resourceResponse(res, async () => {
      await orchestrationManager.normalizeStaleRuns(workspaceRoot);
      return { orchestrations: await listOrchestrations(workspaceRoot) };
    });
  });

  app.post('/api/orchestrations', async (req, res) => {
    await resourceResponse(res, async () => ({ orchestration: await createOrchestration(workspaceRoot, req.body || {}) }), 201);
  });

  app.get('/api/orchestrations/:id', async (req, res) => {
    await resourceResponse(res, async () => {
      if (!orchestrationManager.isRunning(req.params.id)) await orchestrationManager.normalizeStaleRuns(workspaceRoot);
      return { orchestration: await getOrchestration(workspaceRoot, req.params.id) };
    });
  });

  app.put('/api/orchestrations/:id', async (req, res) => {
    await resourceResponse(res, async () => ({
      orchestration: await updateOrchestration(workspaceRoot, req.params.id, req.body || {}),
    }));
  });

  app.delete('/api/orchestrations/:id', async (req, res) => {
    await resourceResponse(res, async () => {
      await deleteOrchestration(workspaceRoot, req.params.id);
      return { ok: true };
    });
  });

  app.post('/api/orchestrations/:id/reset', async (req, res) => {
    await resourceResponse(res, async () => ({ orchestration: await resetOrchestration(workspaceRoot, req.params.id) }));
  });

  app.post('/api/orchestrations/:id/run', async (req, res) => {
    await resourceResponse(res, async () => {
      await hydrateAgentCommands();
      return await orchestrationManager.runOrchestration(workspaceRoot, req.params.id, { commands: agentCommands });
    }, 202);
  });

  app.post('/api/orchestrations/:id/cancel', async (req, res) => {
    await resourceResponse(res, async () => await orchestrationManager.cancelOrchestration(req.params.id));
  });

  app.post('/api/orchestrations/:id/gates/:nodeId/decide', async (req, res) => {
    await resourceResponse(res, async () => ({
      orchestration: await orchestrationManager.decideGate(
        workspaceRoot, req.params.id, req.params.nodeId, req.body?.decision, req.body?.note,
      ),
    }));
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

  app.post('/api/libraries/extract-text', async (req, res) => {
    await resourceResponse(res, async () => {
      await hydrateAgentCommands();
      return await extractTextCandidates(workspaceRoot, req.body || {}, { provider, commands: agentCommands });
    }, 201);
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
    await resourceResponse(res, async () => {
      await hydrateAgentCommands();
      return { review: await runReviewRound(workspaceRoot, req.params.id, { commands: agentCommands, signal: controller.signal }) };
    });
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
    await resourceResponse(res, async () => {
      await hydrateAgentCommands();
      return await orchestrateReviewOpinions(workspaceRoot, req.body || {}, {
        provider, commands: agentCommands, signal: controller.signal,
      });
    }, 201);
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

  app.get('/api/change-history', async (req, res) => {
    await resourceResponse(res, async () => ({
      entries: await getRecentChangeHistory(workspaceRoot, req.query.documentId, req.query.limit),
    }));
  });

  app.get('/api/change-history/:id', async (req, res) => {
    await resourceResponse(res, async () => ({ entry: await getChangeHistoryEntry(workspaceRoot, req.params.id) }));
  });

  app.post('/api/change-history/:id/restore', async (req, res) => {
    await resourceResponse(res, async () => await restoreRevisionVersion(workspaceRoot, req.params.id));
  });

  app.get('/api/change-history/:id/preview.pdf', async (req, res) => {
    let previewRoot = '';
    try {
      const { document, source } = await getHistoricalRevisionSource(workspaceRoot, req.params.id);
      const previewBase = join(workspaceRoot, '.papergod', 'previews');
      await mkdir(previewBase, { recursive: true });
      previewRoot = await mkdtemp(join(previewBase, 'render-'));
      const entries = await readdir(workspaceRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === '.papergod') continue;
        await cp(join(workspaceRoot, entry.name), join(previewRoot, entry.name), { recursive: true });
      }
      const previewTex = sanitizePath(document.file, previewRoot);
      if (!previewTex) throw Object.assign(new Error('Invalid historical document path'), { status: 403 });
      await mkdir(dirname(previewTex), { recursive: true });
      await writeFile(previewTex, source, 'utf-8');
      const result = await compile(previewTex, previewRoot);
      if (!result.ok) {
        await rm(previewRoot, { recursive: true, force: true });
        return res.status(422).json({ error: result.error, log: result.log || null });
      }
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(result.pdf, (error) => {
        rm(previewRoot, { recursive: true, force: true }).catch(() => {});
        if (error && !res.headersSent) res.status(error.statusCode || 500).json({ error: error.message });
      });
    } catch (error) {
      if (previewRoot) await rm(previewRoot, { recursive: true, force: true }).catch(() => {});
      res.status(error.status || 500).json({ error: publicErrorMessage(error), code: error.code });
    }
  });

  app.post('/api/generate/paper', async (req, res) => {
    const controller = new AbortController();
    req.once('aborted', () => controller.abort());
    await resourceResponse(res, async () => {
      await hydrateAgentCommands();
      return await generatePaperRevision(workspaceRoot, req.body || {}, {
        provider, commands: agentCommands, signal: controller.signal,
      });
    }, 201);
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
      const files = await listTexFiles(workspaceRoot);
      const pdfs = entries.filter((f) => f.endsWith('.pdf'));
      res.json({ files, pdfs });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // The paper's entry (main) file: opened on load and used for compilation.
  app.get('/api/entry', async (_req, res) => {
    await resourceResponse(res, () => resolveEntryFile(workspaceRoot));
  });

  app.put('/api/entry', async (req, res) => {
    const file = req.body?.file;
    if (typeof file !== 'string' || !file) return res.status(400).json({ error: 'file is required' });
    await resourceResponse(res, () => saveEntryFile(workspaceRoot, file));
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
    const { file, clean = false } = req.body || {};
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
      const result = await compile(safe, workspaceRoot, { clean: clean === true });
      if (result.ok) {
        const pdfName = file.replace(/\.tex$/, '.pdf');
        res.json({ ok: true, pdf: `/workspace/${pdfName}`, engine: result.engine, clean: clean === true, steps: result.steps || null, removed: result.removed || null });
      } else {
        res.json({ ok: false, error: result.error, engine: result.engine, log: result.log || null, clean: clean === true });
      }
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/agent/suggest', async (req, res) => {
    const { documentId, content, prompt, promptIsComposed = false, resourceIds, citekeys = [], intentIds = [], additionalRequirements = '', manifest = null, manifestPath = '', payloadHash = '' } = req.body || {};
    if (typeof content !== 'string') return res.status(400).json({ error: 'content is required' });
    if (manifest !== null) return res.status(400).json({ error: 'Send manifestPath, not a client-supplied manifest object', code: 'INVALID_PROMPT_MANIFEST' });
    if (manifestPath && !payloadHash) return res.status(400).json({ error: 'Manifest execution requires a confirmed payload hash', code: 'PROMPT_CONFIRMATION_REQUIRED' });
    try {
      const project = await loadProject(workspaceRoot);
      const document = project.documents.find((item) => item.id === documentId);
      let resolvedManifest = null;
      let resolvedManifestPath = manifestPath;
      let resolvedManifestSerialized = '';
      if (manifestPath) {
        const loadedManifest = await loadPromptManifest(workspaceRoot, manifestPath);
        resolvedManifest = loadedManifest.manifest;
        resolvedManifestSerialized = loadedManifest.serialized;
      }
      let effectivePrompt = promptIsComposed ? prompt : [
        project.project.corePrompt && `Paper core prompt:\n${project.project.corePrompt}`,
        document?.corePrompt && `Document prompt:\n${document.corePrompt}`,
        `Current editing request:\n${typeof prompt === 'string' && prompt.trim() ? prompt : 'Improve this scope according to the supplied writing context.'}`,
      ].filter(Boolean).join('\n\n');
      if (!resolvedManifest && intentIds.length && document) {
        const generatedManifest = await materializePromptManifest(workspaceRoot, {
          documentId: document.id, intentIds, additionalRequirements: additionalRequirements || prompt,
          sourceContent: content,
          resourceIds: Array.isArray(resourceIds) ? resourceIds : [], citekeys,
        });
        resolvedManifest = generatedManifest.manifest;
        resolvedManifestPath = generatedManifest.manifestPath;
        resolvedManifestSerialized = generatedManifest.serialized;
        effectivePrompt = generatedManifest.prompt;
      }
      if (resolvedManifest?.tasks?.length) {
        const actualSourceHash = createHash('sha256').update(content).digest('hex');
        if (resolvedManifest.tasks.some((task) => task.target?.sourceHash && task.target.sourceHash !== actualSourceHash)) {
          throw Object.assign(new Error('The manuscript changed after the Prompt Manifest was prepared; refresh the preview before invoking the Agent.'), { status: 409, code: 'PROMPT_TARGET_STALE' });
        }
      }
      const libraries = project.libraries;
      const libraryContext = buildLibraryContext(libraries, {
        query: `${effectivePrompt}\n${content}`, resourceIds,
      });
      res.json(await requestSuggestions(content, effectivePrompt, req, {
        libraryContext, file: document?.file || '', nodeStart: 0,
        manifest: resolvedManifest, manifestPath: resolvedManifestPath, manifestSerialized: resolvedManifestSerialized, payloadHash, intentIds, additionalRequirements, citekeys,
      }));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message, code: e.code, details: e.details });
    }
  });

  app.post('/api/agent/suggest-node', async (req, res) => {
    const { nodeId, prompt, promptIsComposed = false, resourceIds, citekeys = [], intentIds = [], additionalRequirements = '', manifest = null, manifestPath = '', payloadHash = '' } = req.body || {};
    if (typeof nodeId !== 'string' || !nodeId) return res.status(400).json({ error: 'nodeId is required' });
    if (manifest !== null) return res.status(400).json({ error: 'Send manifestPath, not a client-supplied manifest object', code: 'INVALID_PROMPT_MANIFEST' });
    if (manifestPath && !payloadHash) return res.status(400).json({ error: 'Manifest execution requires a confirmed payload hash', code: 'PROMPT_CONFIRMATION_REQUIRED' });
    try {
      const context = await getNodeSourceContext(workspaceRoot, nodeId);
      let resolvedManifest = null;
      let resolvedManifestSerialized = '';
      if (manifestPath) {
        const loadedManifest = await loadPromptManifest(workspaceRoot, manifestPath);
        resolvedManifest = loadedManifest.manifest;
        resolvedManifestSerialized = loadedManifest.serialized;
      }
      if (resolvedManifest?.tasks?.some((task) => task.target?.sourceHash && task.target.sourceHash !== context.document.sourceHash)) {
        throw Object.assign(new Error('The target changed after the Prompt Manifest was prepared; refresh the preview before invoking the Agent.'), { status: 409, code: 'PROMPT_TARGET_STALE' });
      }
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
        manifest: resolvedManifest, manifestPath, manifestSerialized: resolvedManifestSerialized, payloadHash, intentIds, additionalRequirements, citekeys,
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

  app.post('/api/agent/apply-all', async (req, res) => {
    const { file, suggestionIds } = req.body || {};
    if (!file || !Array.isArray(suggestionIds) || !suggestionIds.length) return res.status(400).json({ error: 'file and suggestionIds are required' });
    const safe = sanitizePath(file, workspaceRoot);
    if (!safe) return res.status(403).json({ error: 'Access denied' });
    if (!safe.endsWith('.tex')) return res.status(400).json({ error: 'Only .tex files can be edited' });
    try {
      const selected = suggestionIds.map((suggestionId) => getSuggestion(suggestionId));
      const result = await applySuggestionsAsRevision(workspaceRoot, file, selected);
      suggestionIds.forEach(removeSuggestion);
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message, code: error.code });
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

export async function startServer({ workspaceRoot = DEFAULT_WORKSPACE, port = 3000, host = '127.0.0.1', provider = 'mock', workspaceRegistryFile } = {}) {
  const app = createApp(workspaceRoot, { provider, workspaceRegistryFile });
  return await new Promise((resolveServer, reject) => {
    // Loopback by default: there is no login, so anything that can reach the
    // port can edit files and run the terminal.
    const server = app.listen(port, host, () => resolveServer(server));
    server.once('close', () => app.locals.cleanup?.());
    server.once('error', reject);
  });
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  const port = parseInt(process.env.PORT || '3000', 10);
  const host = process.env.PAPERGOD_HOST || '127.0.0.1';
  const workspace = process.env.WORKSPACE || DEFAULT_WORKSPACE;
  const server = await startServer({ workspaceRoot: workspace, port, host });
  console.log(`Papergod running at http://${host}:${server.address().port}`);

  function shutdown() {
    console.log('\nShutting down...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
