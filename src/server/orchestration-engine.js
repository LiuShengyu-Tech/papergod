import { randomUUID } from 'crypto';
import { loadProject, updateProject } from './project-store.js';
import { createAgentRun, updateAgentRun } from './project-resources.js';
import { composeMockSuggestions } from './agent.js';
import { buildLibraryContext, composeMockParagraph } from './library-engine.js';
import { DEFAULT_REVIEW_RUBRIC, generateMockPeerReview } from './review-panel.js';
import { composeMockPaper } from './revise-workflow.js';
import { runAcademicReviewAgent, runPaperGenerationAgent, runWritingAgent } from './agent-adapters.js';

export const ORCHESTRATION_CAPABILITIES = ['suggest', 'review', 'paragraph', 'generate'];
export const ORCHESTRATION_PROVIDERS = ['mock', 'codex', 'claude-code', 'opencode', 'pi'];
export const ORCHESTRATION_NODE_KINDS = ['agent', 'gate'];
export const ORCHESTRATION_NODE_STATUSES = ['idle', 'queued', 'running', 'complete', 'failed', 'waiting', 'skipped'];
const REVIEW_ROLES = ['methodology', 'statistics', 'writing', 'domain', 'reproducibility'];
const MAX_CONCURRENCY = 4;
const MAX_NODES = 50;
const MAX_EDGES = 200;
const MAX_UPSTREAM_CHARS = 20_000;

function now() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${randomUUID()}`; }
function clean(value) { return typeof value === 'string' ? value.trim() : ''; }
function problem(message, status = 400, code = '') {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}
function summarize(value, limit = 240) {
  const text = clean(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

// ---------------------------------------------------------------------------
// Node / edge normalization for create and update
// ---------------------------------------------------------------------------

function normalizeReviewer(input, previous = null) {
  if (input == null && previous == null) return null;
  if (input == null) return previous;
  if (input.role !== undefined && !REVIEW_ROLES.includes(input.role)) throw problem('reviewer.role is invalid');
  return {
    name: clean(input?.name) || previous?.name || 'Domain reviewer',
    role: REVIEW_ROLES.includes(input?.role) ? input.role : (REVIEW_ROLES.includes(previous?.role) ? previous.role : 'domain'),
    focus: clean(input?.focus) || previous?.focus || 'General academic quality and correctness.',
    prompt: typeof input?.prompt === 'string' ? input.prompt : (previous?.prompt || ''),
  };
}

function normalizeRubric(input, previous = null) {
  const source = Array.isArray(input) ? input : (Array.isArray(previous) ? previous : []);
  return source.map((criterion, index) => ({
    id: clean(criterion?.id) || `rubric_${index + 1}`,
    title: clean(criterion?.title) || `Criterion ${index + 1}`,
    instruction: typeof criterion?.instruction === 'string' ? criterion.instruction : '',
    weight: Number.isFinite(criterion?.weight) && criterion.weight > 0 ? criterion.weight : 1,
  }));
}

export function buildDefaultNode({ kind = 'agent', x = 0, y = 0 } = {}) {
  const node = {
    id: id('node'),
    kind: kind === 'gate' ? 'gate' : 'agent',
    label: kind === 'gate' ? 'Approval gate' : 'Agent node',
    x, y,
    prompt: '',
    source: { type: 'manual', nodeId: '', text: '' },
    reviewer: null,
    rubric: [],
    status: 'idle',
    note: '',
    output: null,
    runId: '',
    error: '',
    startedAt: '',
    finishedAt: '',
  };
  if (node.kind === 'agent') {
    node.provider = 'mock';
    node.capability = 'suggest';
  } else {
    node.decision = 'pending';
  }
  return node;
}

function normalizeOrchestrationInput(input, existing = null) {
  const existingById = new Map((existing?.nodes || []).map((node) => [node.id, node]));
  const name = clean(input?.name) || existing?.name || 'Multi-agent workflow';
  if (name.length > 120) throw problem('name must be at most 120 characters');

  const nodeInputs = Array.isArray(input?.nodes) ? input.nodes : (existing?.nodes || []);
  if (nodeInputs.length > MAX_NODES) throw problem(`nodes must contain at most ${MAX_NODES} nodes`);
  const seen = new Set();
  const nodes = nodeInputs.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw problem(`nodes[${index}] must be an object`);
    const previous = existingById.get(raw.id);
    const kind = raw.kind === 'gate' ? 'gate' : 'agent';
    const node = {
      id: clean(raw.id) || id('node'),
      kind,
      label: clean(raw.label) || (kind === 'gate' ? 'Approval gate' : `Agent ${index + 1}`),
      x: Number.isFinite(raw.x) ? raw.x : (previous?.x ?? 0),
      y: Number.isFinite(raw.y) ? raw.y : (previous?.y ?? 0),
      prompt: typeof raw.prompt === 'string' ? raw.prompt : (previous?.prompt || ''),
      source: {
        type: raw.source?.type === 'upstream' ? 'upstream' : 'manual',
        nodeId: clean(raw.source?.nodeId) || (previous?.source?.nodeId || ''),
        text: typeof raw.source?.text === 'string' ? raw.source.text : (previous?.source?.text || ''),
      },
      reviewer: normalizeReviewer(raw.reviewer, previous?.reviewer),
      rubric: normalizeRubric(raw.rubric, previous?.rubric),
      status: previous?.status || 'idle',
      note: kind === 'gate' ? (typeof raw.note === 'string' ? raw.note : (previous?.note || '')) : '',
      output: previous?.output ?? null,
      runId: previous?.runId || '',
      error: previous?.error || '',
      startedAt: previous?.startedAt || '',
      finishedAt: previous?.finishedAt || '',
    };
    if (kind === 'agent') {
      if (raw.provider !== undefined && !ORCHESTRATION_PROVIDERS.includes(raw.provider)) throw problem(`nodes[${index}].provider is invalid`);
      if (raw.capability !== undefined && !ORCHESTRATION_CAPABILITIES.includes(raw.capability)) throw problem(`nodes[${index}].capability is invalid`);
      node.provider = ORCHESTRATION_PROVIDERS.includes(raw.provider) ? raw.provider
        : (ORCHESTRATION_PROVIDERS.includes(previous?.provider) ? previous.provider : 'mock');
      node.capability = ORCHESTRATION_CAPABILITIES.includes(raw.capability) ? raw.capability
        : (ORCHESTRATION_CAPABILITIES.includes(previous?.capability) ? previous.capability : 'suggest');
    } else {
      if (raw.decision !== undefined && !['pending', 'approved', 'rejected'].includes(raw.decision)) throw problem(`nodes[${index}].decision is invalid`);
      node.decision = ['pending', 'approved', 'rejected'].includes(raw.decision) ? raw.decision : (previous?.decision || 'pending');
    }
    if (seen.has(node.id)) throw problem(`nodes[${index}].id is duplicated`);
    seen.add(node.id);
    return node;
  });
  for (const node of nodes) {
    if (node.source.type === 'upstream' && node.source.nodeId && !seen.has(node.source.nodeId)) {
      throw problem(`nodes source.nodeId does not reference another node: ${node.source.nodeId}`);
    }
  }

  const edgeInputs = Array.isArray(input?.edges) ? input.edges : (existing?.edges || []);
  if (edgeInputs.length > MAX_EDGES) throw problem(`edges must contain at most ${MAX_EDGES} edges`);
  const pairs = new Set();
  const edges = edgeInputs.map((raw, index) => {
    const source = clean(raw?.source);
    const target = clean(raw?.target);
    if (!source || !target) throw problem(`edges[${index}] needs source and target`);
    if (source !== 'start' && !seen.has(source)) throw problem(`edges[${index}].source does not reference a node`);
    if (target !== 'end' && !seen.has(target)) throw problem(`edges[${index}].target does not reference a node`);
    if (target === 'start' || source === 'end') throw problem(`edges[${index}] has an invalid endpoint`);
    if (source === target && source !== 'start' && source !== 'end') throw problem(`edges[${index}] cannot be a self loop`);
    const pair = `${source}->${target}`;
    if (pairs.has(pair)) throw problem(`edges[${index}] duplicates an existing edge`);
    pairs.add(pair);
    return {
      id: clean(raw?.id) || id('edge'),
      source,
      target,
      summary: typeof raw?.summary === 'string' ? raw.summary : '',
    };
  });
  return { name, nodes, edges };
}

function structuralKey(node) {
  return JSON.stringify({
    id: node.id, kind: node.kind, provider: node.provider, capability: node.capability,
    label: node.label, prompt: node.prompt, source: node.source, reviewer: node.reviewer, rubric: node.rubric,
  });
}

function graphStructureKey(orchestration) {
  return [
    orchestration.nodes.map(structuralKey).join('|'),
    orchestration.edges.map((edge) => `${edge.source}->${edge.target}`).join('|'),
  ].join('||');
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listOrchestrations(workspaceRoot) {
  return (await loadProject(workspaceRoot)).orchestrations;
}

export async function getOrchestration(workspaceRoot, orchestrationId) {
  const orchestration = (await loadProject(workspaceRoot)).orchestrations.find((item) => item.id === orchestrationId);
  if (!orchestration) throw problem('Orchestration not found', 404);
  return orchestration;
}

export async function createOrchestration(workspaceRoot, input = {}) {
  const timestamp = now();
  const normalized = normalizeOrchestrationInput(input, null);
  const orchestration = {
    id: id('orchestration'),
    name: normalized.name,
    status: 'draft',
    nodes: normalized.nodes.length ? normalized.nodes : [buildDefaultNode()],
    edges: normalized.edges,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await updateProject(workspaceRoot, (draft) => draft.orchestrations.push(orchestration));
  return structuredClone(orchestration);
}

export async function updateOrchestration(workspaceRoot, orchestrationId, input = {}) {
  const { result } = await updateProject(workspaceRoot, (draft) => {
    const index = draft.orchestrations.findIndex((item) => item.id === orchestrationId);
    if (index === -1) throw problem('Orchestration not found', 404);
    const current = draft.orchestrations[index];
    if (current.status === 'running') throw problem('Cannot edit an orchestration while it is running', 409);
    const previousStructure = graphStructureKey(current);
    const normalized = normalizeOrchestrationInput(input, current);
    const structuralChange = previousStructure !== graphStructureKey({ ...current, ...normalized });
    const updated = { ...current, ...normalized, updatedAt: now() };
    if (structuralChange) {
      updated.status = 'draft';
      for (const node of updated.nodes) {
        node.status = 'idle';
        node.output = null;
        node.runId = '';
        node.error = '';
        node.startedAt = '';
        node.finishedAt = '';
        if (node.kind === 'gate') { node.decision = 'pending'; node.note = ''; }
      }
      for (const edge of updated.edges) edge.summary = '';
    }
    draft.orchestrations[index] = updated;
    return structuredClone(updated);
  });
  return result;
}

export async function deleteOrchestration(workspaceRoot, orchestrationId) {
  await updateProject(workspaceRoot, (draft) => {
    const index = draft.orchestrations.findIndex((item) => item.id === orchestrationId);
    if (index === -1) throw problem('Orchestration not found', 404);
    if (draft.orchestrations[index].status === 'running') throw problem('Cannot delete an orchestration while it is running', 409);
    draft.orchestrations.splice(index, 1);
  });
}

export async function resetOrchestration(workspaceRoot, orchestrationId) {
  const { result } = await updateProject(workspaceRoot, (draft) => {
    const current = draft.orchestrations.find((item) => item.id === orchestrationId);
    if (!current) throw problem('Orchestration not found', 404);
    if (current.status === 'running') throw problem('Cannot reset an orchestration while it is running', 409);
    current.status = 'draft';
    for (const node of current.nodes) {
      node.status = 'idle';
      node.output = null;
      node.runId = '';
      node.error = '';
      node.startedAt = '';
      node.finishedAt = '';
      if (node.kind === 'gate') { node.decision = 'pending'; node.note = ''; }
    }
    for (const edge of current.edges) edge.summary = '';
    current.updatedAt = now();
    return structuredClone(current);
  });
  return result;
}

// ---------------------------------------------------------------------------
// Graph analysis
// ---------------------------------------------------------------------------

export function findGraphCycle(nodes, edges) {
  const adjacency = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (edge.source !== 'start' && edge.target !== 'end'
      && adjacency.has(edge.source) && adjacency.has(edge.target)) {
      adjacency.get(edge.source).push(edge.target);
    }
  }
  const color = new Map(nodes.map((node) => [node.id, 0])); // 0 white, 1 gray, 2 black
  const stack = [];
  const visit = (nodeId) => {
    color.set(nodeId, 1);
    stack.push(nodeId);
    for (const next of adjacency.get(nodeId) || []) {
      if (color.get(next) === 1) return stack.slice(stack.indexOf(next)).concat(next);
      if (color.get(next) === 0) {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    color.set(nodeId, 2);
    return null;
  };
  for (const node of nodes) {
    if (color.get(node.id) === 0) {
      const cycle = visit(node.id);
      if (cycle) return cycle;
    }
  }
  return null;
}

function incomingSatisfied(node, edges, nodeById) {
  const incoming = edges.filter((edge) => edge.target === node.id);
  if (!incoming.length) return true;
  return incoming.every((edge) => edge.source === 'start' || nodeById.get(edge.source)?.status === 'complete');
}

function resolveNodeInput(node, nodes) {
  if (node.source?.type === 'upstream' && node.source.nodeId) {
    const upstream = nodes.find((item) => item.id === node.source.nodeId);
    const output = upstream?.output;
    if (output?.data) {
      const data = typeof output.data === 'string' ? output.data : JSON.stringify(output.data);
      return `[Upstream "${upstream.label}" output]\n${output.summary || ''}\n${data.slice(0, MAX_UPSTREAM_CHARS)}`;
    }
    if (output?.summary) return output.summary;
  }
  return node.source?.text || '';
}

// ---------------------------------------------------------------------------
// Node executors (mock is deterministic; external goes through the adapters)
// ---------------------------------------------------------------------------

function defaultReviewer(node) {
  return {
    name: clean(node?.reviewer?.name) || 'Domain reviewer',
    role: REVIEW_ROLES.includes(node?.reviewer?.role) ? node.reviewer.role : 'domain',
    focus: clean(node?.reviewer?.focus) || 'General academic quality and correctness.',
    prompt: clean(node?.reviewer?.prompt),
  };
}

function nodeRubric(node) {
  return Array.isArray(node?.rubric) && node.rubric.length ? node.rubric : DEFAULT_REVIEW_RUBRIC;
}

async function runMockNode(node, project, inputText) {
  const capability = node.capability;
  if (capability === 'suggest') {
    const suggestions = composeMockSuggestions(inputText || ' ', node.prompt || '');
    return { summary: `${suggestions.length} suggestion(s) generated from the supplied input.`, data: JSON.stringify(suggestions), contentType: 'suggestions' };
  }
  if (capability === 'review') {
    const reviewer = defaultReviewer(node);
    const rubric = nodeRubric(node);
    const result = generateMockPeerReview(inputText || ' ', reviewer, rubric);
    return { summary: result.summary, data: JSON.stringify(result), contentType: 'review' };
  }
  if (capability === 'paragraph') {
    const libraries = project.libraries;
    const context = buildLibraryContext(libraries, { query: [node.prompt, inputText].filter(Boolean).join(' ') });
    const composed = composeMockParagraph(libraries, context, node.prompt || 'Draft a paragraph that fulfills the writing context.');
    return { summary: summarize(composed.draft, 300), data: JSON.stringify(composed), contentType: 'paragraph' };
  }
  if (capability === 'generate') {
    const document = project.documents[0];
    const libraries = project.libraries;
    const context = buildLibraryContext(libraries, {
      query: [node.prompt, project.project.corePrompt, document?.corePrompt].filter(Boolean).join(' '),
    });
    const generated = composeMockPaper(project.project, document, libraries, context, node.prompt || '');
    return { summary: generated.summary, data: JSON.stringify(generated), contentType: 'generated-paper' };
  }
  throw problem(`Unknown capability: ${capability}`, 400);
}

async function runExternalNode(node, inputText, options) {
  const capability = node.capability;
  if (capability === 'suggest') {
    const result = await runWritingAgent(node.provider, {
      content: inputText || ' ',
      prompt: node.prompt || 'Improve the supplied academic text.',
      resourceContext: '', resourceIds: [],
    }, options);
    return { summary: summarize(result.summary, 300), data: JSON.stringify(result), contentType: 'suggestions' };
  }
  if (capability === 'review') {
    const reviewer = defaultReviewer(node);
    const rubric = nodeRubric(node);
    const result = await runAcademicReviewAgent(node.provider, { content: inputText || ' ', reviewer, rubric }, options);
    return { summary: summarize(result.summary, 300), data: JSON.stringify(result), contentType: 'review' };
  }
  if (capability === 'paragraph') {
    const sentinel = '[[PAPERGOD_PARAGRAPH_DRAFT]]';
    const result = await runWritingAgent(node.provider, {
      content: sentinel,
      prompt: `${inputText ? `Upstream context:\n${inputText.slice(0, MAX_UPSTREAM_CHARS)}\n\n` : ''}${node.prompt || 'Draft a paragraph.'}\nReturn exactly one suggestion that replaces the entire text ${sentinel} with a single cohesive academic paragraph.`,
      resourceContext: '', resourceIds: [],
    }, options);
    const draft = result.suggestions?.find((item) => item.originalText === sentinel)?.suggestedText || result.suggestions?.[0]?.suggestedText || '';
    if (!draft.trim()) throw problem('Agent did not return a paragraph draft', 502);
    return { summary: summarize(draft, 300), data: JSON.stringify({ draft, summary: result.summary }), contentType: 'paragraph' };
  }
  if (capability === 'generate') {
    const result = await runPaperGenerationAgent(node.provider, {
      instruction: [node.prompt, inputText ? `Upstream context:\n${inputText.slice(0, MAX_UPSTREAM_CHARS)}` : ''].filter(Boolean).join('\n') || 'Generate a complete academic paper.',
      projectContext: '', outlineContext: '', resourceContext: '', resourceIds: [],
    }, options);
    return { summary: summarize(result.summary, 300), data: JSON.stringify(result), contentType: 'generated-paper' };
  }
  throw problem(`Unknown capability: ${capability}`, 400);
}

// ---------------------------------------------------------------------------
// Persistence helpers used by the scheduler
// ---------------------------------------------------------------------------

async function patchOrchestration(workspaceRoot, orchestrationId, mutate) {
  const { result } = await updateProject(workspaceRoot, (draft) => {
    const orchestration = draft.orchestrations.find((item) => item.id === orchestrationId);
    if (!orchestration) return null;
    mutate(orchestration);
    orchestration.updatedAt = now();
    return structuredClone(orchestration);
  });
  return result;
}

async function setNodeFields(workspaceRoot, orchestrationId, nodeId, fields) {
  return patchOrchestration(workspaceRoot, orchestrationId, (orchestration) => {
    const node = orchestration.nodes.find((item) => item.id === nodeId);
    if (node) Object.assign(node, fields);
  });
}

async function propagateEdgeSummaries(workspaceRoot, orchestrationId, nodeId, output) {
  const summary = summarize(output?.summary || output?.data, 240);
  await patchOrchestration(workspaceRoot, orchestrationId, (orchestration) => {
    for (const edge of orchestration.edges) {
      if (edge.source === nodeId) edge.summary = summary;
    }
  });
}

async function executeAgentNode(workspaceRoot, orchestrationId, nodeId, options) {
  let project = await loadProject(workspaceRoot);
  let orchestration = project.orchestrations.find((item) => item.id === orchestrationId);
  let node = orchestration?.nodes.find((item) => item.id === nodeId);
  if (!node) return { ok: false, error: 'Node not found' };
  const inputText = resolveNodeInput(node, orchestration.nodes);
  const startedAt = now();
  const run = await createAgentRun(workspaceRoot, {
    provider: node.provider,
    operation: `orchestrate:${node.capability}`,
    status: node.provider === 'mock' ? 'queued' : 'running',
    prompt: node.prompt || '',
    input: JSON.stringify({ characters: inputText.length, source: node.source }),
    output: '', error: '', startedAt, finishedAt: '',
  });
  await setNodeFields(workspaceRoot, orchestrationId, nodeId, { status: 'running', runId: run.id, startedAt, error: '' });
  try {
    // Re-read so the executor works against the freshest project metadata.
    project = await loadProject(workspaceRoot);
    orchestration = project.orchestrations.find((item) => item.id === orchestrationId);
    node = orchestration?.nodes.find((item) => item.id === nodeId);
    const output = node.provider === 'mock'
      ? await runMockNode(node, project, inputText)
      : await runExternalNode(node, inputText, {
        workspaceRoot, commands: options.commands || {}, signal: options.signal,
      });
    const finishedAt = now();
    await setNodeFields(workspaceRoot, orchestrationId, nodeId, { status: 'complete', output, finishedAt });
    await updateAgentRun(workspaceRoot, run.id, { status: 'complete', output: JSON.stringify({ summary: output.summary, characters: output.data.length }), finishedAt });
    await propagateEdgeSummaries(workspaceRoot, orchestrationId, nodeId, output);
    return { ok: true, nodeId };
  } catch (error) {
    const finishedAt = now();
    const message = String(error?.message || 'Agent node failed').slice(0, 4000);
    await setNodeFields(workspaceRoot, orchestrationId, nodeId, { status: 'failed', error: message, finishedAt });
    await updateAgentRun(workspaceRoot, run.id, { status: 'failed', error: message, finishedAt });
    return { ok: false, nodeId, error: message };
  }
}

// ---------------------------------------------------------------------------
// Run manager: in-memory execution state per app instance
// ---------------------------------------------------------------------------

function sleepOrWake(state, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { state.wake = null; resolve(); }, ms);
    state.wake = () => { clearTimeout(timer); resolve(); };
  });
}

function wakeState(state) {
  if (state.wake) {
    const wake = state.wake;
    state.wake = null;
    wake();
  }
}

export function createOrchestrationManager() {
  const activeRuns = new Map();

  const isRunning = (orchestrationId) => activeRuns.has(orchestrationId);
  const anyRunning = () => activeRuns.size > 0;

  async function settleRun(workspaceRoot, orchestrationId, status) {
    await patchOrchestration(workspaceRoot, orchestrationId, (orchestration) => {
      if (orchestration.status !== 'running') return;
      orchestration.status = status;
      if (status === 'failed' || status === 'cancelled') {
        for (const node of orchestration.nodes) {
          if (node.status === 'idle' || node.status === 'waiting') node.status = 'skipped';
        }
      }
    });
  }

  async function scheduler(workspaceRoot, orchestrationId, state, options) {
    try {
      while (true) {
        if (state.controller.signal.aborted || state.cancelled) {
          await settleRun(workspaceRoot, orchestrationId, 'cancelled');
          return;
        }
        const project = await loadProject(workspaceRoot);
        const orchestration = project.orchestrations.find((item) => item.id === orchestrationId);
        if (!orchestration || orchestration.status !== 'running') return;
        const nodeById = new Map(orchestration.nodes.map((node) => [node.id, node]));
        const runnable = orchestration.nodes.filter((node) => node.status === 'idle' && incomingSatisfied(node, orchestration.edges, nodeById));
        const running = orchestration.nodes.filter((node) => node.status === 'running');
        const waiting = orchestration.nodes.filter((node) => node.status === 'waiting');
        if (!runnable.length) {
          if (!running.length && !waiting.length) {
            await settleRun(workspaceRoot, orchestrationId, 'complete');
            return;
          }
          await sleepOrWake(state, 300);
          continue;
        }
        for (const gate of runnable.filter((node) => node.kind === 'gate')) {
          await setNodeFields(workspaceRoot, orchestrationId, gate.id, { status: 'waiting', startedAt: now() });
        }
        const agents = runnable.filter((node) => node.kind === 'agent').slice(0, MAX_CONCURRENCY);
        if (agents.length) {
          const results = await Promise.all(agents.map((node) => executeAgentNode(workspaceRoot, orchestrationId, node.id, options)));
          if (results.some((result) => !result?.ok)) {
            await settleRun(workspaceRoot, orchestrationId, 'failed');
            return;
          }
        }
      }
    } catch (error) {
      await settleRun(workspaceRoot, orchestrationId, 'failed');
    }
  }

  async function runOrchestration(workspaceRoot, orchestrationId, options = {}) {
    if (activeRuns.has(orchestrationId)) throw problem('Orchestration is already running', 409, 'ORCHESTRATION_BUSY');
    const project = await loadProject(workspaceRoot);
    const orchestration = project.orchestrations.find((item) => item.id === orchestrationId);
    if (!orchestration) throw problem('Orchestration not found', 404);
    if (orchestration.status === 'running') throw problem('Orchestration is already running', 409, 'ORCHESTRATION_BUSY');
    if (!orchestration.nodes.length) throw problem('The orchestration has no nodes', 400);
    const cycle = findGraphCycle(orchestration.nodes, orchestration.edges);
    if (cycle) throw problem(`The orchestration graph contains a cycle: ${cycle.join(' → ')}`, 400, 'CYCLIC_GRAPH');
    await patchOrchestration(workspaceRoot, orchestrationId, (current) => {
      current.status = 'running';
      for (const node of current.nodes) {
        node.status = 'idle';
        node.output = null;
        node.runId = '';
        node.error = '';
        node.startedAt = '';
        node.finishedAt = '';
        if (node.kind === 'gate') { node.decision = 'pending'; node.note = ''; }
      }
      for (const edge of current.edges) edge.summary = '';
    });
    const controller = new AbortController();
    options.signal?.addEventListener('abort', () => controller.abort(), { once: true });
    const state = { controller, wake: null, cancelled: false };
    activeRuns.set(orchestrationId, state);
    setImmediate(() => scheduler(workspaceRoot, orchestrationId, state, options).finally(() => activeRuns.delete(orchestrationId)));
    return { started: true, orchestrationId, status: 'running' };
  }

  async function cancelOrchestration(orchestrationId) {
    const state = activeRuns.get(orchestrationId);
    if (!state) throw problem('Orchestration is not running', 409, 'ORCHESTRATION_NOT_RUNNING');
    state.controller.abort();
    wakeState(state);
    return { ok: true };
  }

  async function decideGate(workspaceRoot, orchestrationId, nodeId, decision, note = '') {
    const state = activeRuns.get(orchestrationId);
    if (!state) throw problem('Orchestration is not running', 409, 'ORCHESTRATION_NOT_RUNNING');
    if (!['approved', 'rejected'].includes(decision)) throw problem('decision must be approved or rejected', 400);
    const result = await patchOrchestration(workspaceRoot, orchestrationId, (orchestration) => {
      const node = orchestration.nodes.find((item) => item.id === nodeId);
      if (!node) throw problem('Gate node not found', 404);
      if (node.kind !== 'gate') throw problem('Node is not a gate', 400);
      if (node.status !== 'waiting') throw problem('Gate is not waiting for a decision', 409);
      node.decision = decision;
      node.note = typeof note === 'string' ? note.slice(0, 2000) : '';
      node.status = 'complete';
      node.finishedAt = now();
      if (decision === 'rejected') {
        const nodeIds = new Set(orchestration.nodes.map((item) => item.id));
        const adjacency = new Map([...nodeIds].map((nodeId) => [nodeId, []]));
        for (const edge of orchestration.edges) {
          if (edge.source !== 'start' && edge.target !== 'end' && adjacency.has(edge.source) && adjacency.has(edge.target)) {
            adjacency.get(edge.source).push(edge.target);
          }
        }
        const downstream = new Set();
        const queue = [nodeId];
        while (queue.length) {
          const current = queue.shift();
          for (const next of adjacency.get(current) || []) {
            if (next !== nodeId && !downstream.has(next)) { downstream.add(next); queue.push(next); }
          }
        }
        for (const item of orchestration.nodes) {
          if (downstream.has(item.id) && (item.status === 'idle' || item.status === 'waiting')) item.status = 'skipped';
        }
        orchestration.status = 'cancelled';
        state.cancelled = true;
      }
    });
    wakeState(state);
    return result;
  }

  async function normalizeStaleRuns(workspaceRoot) {
    const project = await loadProject(workspaceRoot);
    const stale = project.orchestrations.filter((item) => item.status === 'running' && !activeRuns.has(item.id));
    if (!stale.length) return 0;
    let count = 0;
    await updateProject(workspaceRoot, (draft) => {
      for (const orchestration of draft.orchestrations) {
        if (orchestration.status === 'running' && !activeRuns.has(orchestration.id)) {
          orchestration.status = 'failed';
          orchestration.updatedAt = now();
          for (const node of orchestration.nodes) {
            if (['running', 'queued', 'waiting'].includes(node.status)) {
              node.status = node.status === 'waiting' ? 'skipped' : 'failed';
              if (!node.error) node.error = 'Interrupted by server restart';
            }
          }
          count += 1;
        }
      }
    });
    return count;
  }

  return { runOrchestration, cancelOrchestration, decideGate, isRunning, anyRunning, normalizeStaleRuns };
}
