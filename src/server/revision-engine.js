import { createHash, randomUUID } from 'crypto';
import { basename, dirname, join, sep } from 'path';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { sanitizePath } from './security.js';
import { loadProject, updateProject } from './project-store.js';
import { syncDocumentStructure } from './document-structure.js';
import { getHistoricalRevisionSource } from './change-history.js';
import { createAgentRun, updateAgentRun } from './project-resources.js';
import { runReviewOrchestrationAgent } from './agent-adapters.js';
import { materializeLibraries } from './library-files.js';

const revisionQueues = new Map();

function now() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${randomUUID()}`;
}

function problem(message, status = 400, code = 'REVISION_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function hash(content) {
  return createHash('sha256').update(content).digest('hex');
}

function flattenNodes(document) {
  const result = [];
  const visit = (nodes) => {
    for (const node of nodes || []) {
      result.push(node);
      visit(node.children);
    }
  };
  visit(document.sections);
  return result;
}

function tokenize(value) {
  return new Set(String(value || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
}

function overlapScore(a, b) {
  const left = tokenize(a);
  const right = tokenize(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  left.forEach((token) => { if (right.has(token)) shared += 1; });
  return shared / Math.max(1, Math.min(left.size, right.size));
}

function nodeForRange(document, start, end) {
  return flattenNodes(document)
    .filter((node) => node.sourceRange && node.sourceRange.start <= start && node.sourceRange.end >= end)
    .sort((a, b) => (a.sourceRange.end - a.sourceRange.start) - (b.sourceRange.end - b.sourceRange.start))[0] || null;
}

function bestNodeForOpinion(document, body) {
  return flattenNodes(document)
    .filter((node) => node.type === 'sentence' || node.type === 'paragraph')
    .map((node) => ({ node, score: overlapScore(body, node.text) }))
    .sort((a, b) => b.score - a.score)[0]?.score >= 0.18
    ? flattenNodes(document)
      .filter((node) => node.type === 'sentence' || node.type === 'paragraph')
      .map((node) => ({ node, score: overlapScore(body, node.text) }))
      .sort((a, b) => b.score - a.score)[0].node
    : null;
}

export function splitAtomicOpinions(input) {
  if (typeof input !== 'string') throw problem('Review text must be a string');
  const lines = input.replace(/\r/g, '').split('\n');
  const opinions = [];
  let current = '';
  const flush = () => {
    const value = current.trim();
    if (value) opinions.push(value);
    current = '';
  };
  for (const line of lines) {
    const match = line.match(/^\s*(?:[-*•]|\d+[.)]|(?:comment|point)\s+\d+[:.)])\s*(.+)$/i);
    if (match) {
      flush();
      current = match[1];
    } else if (!line.trim()) {
      flush();
    } else {
      current += `${current ? ' ' : ''}${line.trim()}`;
    }
  }
  flush();
  if (opinions.length === 1 && opinions[0].length > 500) {
    return opinions[0].split(/(?<=[.!?])\s+(?=[A-Z])/).map((item) => item.trim()).filter(Boolean);
  }
  return opinions;
}

function classify(body) {
  const value = body.toLowerCase();
  const category = /cit(e|ation)|reference|bibliograph|引用|参考文献/.test(value) ? 'citation'
    : /method|algorithm|experiment|protocol|方法|算法|实验/.test(value) ? 'method'
      : /evidence|result|support|claim|证据|结果|支撑|论据/.test(value) ? 'evidence'
        : /structure|section|organize|flow|结构|章节|组织|逻辑/.test(value) ? 'structure'
          : /grammar|typo|tense|spelling|语法|错别字|时态|拼写/.test(value) ? 'grammar'
            : /style|wording|tone|clarity|concise|风格|措辞|语气|清晰|精简/.test(value) ? 'style' : 'content';
  const severity = /fatal|critical|invalid|must address|致命|严重错误|必须修改/.test(value) ? 'critical'
    : /major|substantial|missing|unsupported|主要问题|重大|缺少|不充分/.test(value) ? 'major'
      : /minor|small|typo|grammar|次要|小问题|语法/.test(value) ? 'minor' : 'info';
  return { category, severity };
}

function replacement(body) {
  const match = body.match(/\b(?:replace|change)\s+["“']([^"”']+)["”']\s+(?:with|to)\s+["“']([^"”']+)["”']/i)
    || body.match(/["“']([^"”']+)["”']\s*(?:->|→)\s*["“']([^"”']+)["”']/)
    || body.match(/(?:把|将)\s*["“‘『「]([^"”’』」]+)["”’』」]\s*(?:改为|改成|替换为|换成)\s*["“‘『「]([^"”’』」]+)["”’』」]/);
  return match ? { before: match[1], after: match[2] } : null;
}

function annotationFromOpinion(document, content, body, order, actor) {
  const edit = replacement(body);
  let targetNode = null;
  let start = 0;
  let end = 0;
  let quote = '';
  if (edit) {
    start = content.indexOf(edit.before);
    if (start !== -1) {
      end = start + edit.before.length;
      quote = edit.before;
      targetNode = nodeForRange(document, start, end);
    } else {
      start = 0;
    }
  }
  if (!targetNode) {
    targetNode = bestNodeForOpinion(document, body);
    if (targetNode?.sourceRange) {
      start = targetNode.sourceRange.start;
      end = targetNode.sourceRange.end;
      quote = content.slice(start, end);
    }
  }
  const classification = classify(body);
  const timestamp = now();
  return {
    id: id('annotation'), documentId: document.id, order,
    target: {
      type: edit && quote ? 'range' : targetNode?.type || 'document',
      id: targetNode?.id || document.id, start, end, quote,
    },
    ...classification, body, suggestedFix: edit?.after || '', status: 'open',
    source: { type: 'import', actor: actor || 'review import' },
    createdAt: timestamp, updatedAt: timestamp,
  };
}

export async function importReviewOpinions(workspaceRoot, { documentId, text, actor = '' }) {
  const project = await loadProject(workspaceRoot);
  const document = project.documents.find((item) => item.id === documentId);
  if (!document) throw problem('Document not found', 404);
  const safe = sanitizePath(document.file, workspaceRoot);
  if (!safe) throw problem('Access denied', 403);
  const content = await readFile(safe, 'utf-8');
  if (!document.sourceHash || document.sourceHash !== hash(content)) {
    throw problem('Document changed; synchronize structure before importing opinions', 409, 'STALE_STRUCTURE');
  }
  const bodies = splitAtomicOpinions(text);
  if (!bodies.length) throw problem('No review opinions found');
  const annotations = bodies.map((body, index) => annotationFromOpinion(document, content, body, index + 1, actor));
  await updateProject(workspaceRoot, (draft) => draft.annotations.push(...annotations));
  return annotations;
}

function outlineForAgent(document) {
  const lines = [];
  const visit = (nodes, depth = 0) => (nodes || []).forEach((node) => {
    lines.push(`${'  '.repeat(depth)}- ${node.type} ${node.id}: ${node.title || node.summary || String(node.text || '').slice(0, 160)}`);
    visit(node.children, depth + 1);
  });
  visit(document.sections);
  return lines.join('\n');
}

export async function orchestrateReviewOpinions(workspaceRoot, { documentId, text, actor = '' }, options = {}) {
  const provider = options.provider || 'mock';
  const startedAt = now();
  if (provider === 'mock') {
    const annotations = await importReviewOpinions(workspaceRoot, { documentId, text, actor });
    const run = await createAgentRun(workspaceRoot, {
      provider, operation: 'orchestrate-review', status: 'complete', prompt: text,
      input: JSON.stringify({ documentId, characters: text.length }), output: JSON.stringify({ annotationIds: annotations.map((item) => item.id) }),
      error: '', startedAt, finishedAt: now(),
    });
    return { annotations, runId: run.id, summary: `${annotations.length} atomic opinion(s) extracted by the deterministic orchestrator.` };
  }
  const project = await loadProject(workspaceRoot);
  const document = project.documents.find((item) => item.id === documentId);
  if (!document) throw problem('Document not found', 404);
  const safe = sanitizePath(document.file, workspaceRoot); if (!safe) throw problem('Access denied', 403);
  const content = await readFile(safe, 'utf-8');
  if (!document.sourceHash || document.sourceHash !== hash(content)) throw problem('Document changed; synchronize structure before orchestrating opinions', 409, 'STALE_STRUCTURE');
  const run = await createAgentRun(workspaceRoot, {
    provider, operation: 'orchestrate-review', status: 'running', prompt: text,
    input: JSON.stringify({ documentId, feedbackCharacters: text.length, manuscriptCharacters: content.length }), output: '', error: '', startedAt, finishedAt: '',
  });
  try {
    await materializeLibraries(workspaceRoot);
    const result = await runReviewOrchestrationAgent(provider, {
      feedback: text, content, outlineContext: outlineForAgent(document),
      workspace: { file: document.file, start: 0, end: content.length },
    }, {
      workspaceRoot, commands: options.commands || {}, signal: options.signal,
    });
    const timestamp = now();
    const annotations = result.opinions.map((opinion, index) => {
      const start = opinion.quote ? content.indexOf(opinion.quote) : -1;
      const end = start < 0 ? 0 : start + opinion.quote.length;
      const targetNode = start >= 0 ? nodeForRange(document, start, end) : bestNodeForOpinion(document, opinion.body);
      return {
        id: id('annotation'), documentId, order: index + 1,
        target: start >= 0
          ? { type: 'range', id: targetNode?.id || document.id, start, end, quote: opinion.quote }
          : { type: targetNode?.type || 'document', id: targetNode?.id || document.id, start: targetNode?.sourceRange?.start || 0, end: targetNode?.sourceRange?.end || 0, quote: targetNode?.sourceRange ? content.slice(targetNode.sourceRange.start, targetNode.sourceRange.end) : '' },
        category: opinion.category, severity: opinion.severity, body: opinion.body, suggestedFix: opinion.suggestedFix,
        status: 'open', source: { type: 'agent', actor: actor || `${provider} orchestrator` }, dependsOn: [],
        createdAt: timestamp, updatedAt: timestamp,
      };
    });
    result.opinions.forEach((opinion, index) => {
      annotations[index].dependsOn = opinion.dependsOn.map((order) => annotations[order - 1].id);
    });
    await updateProject(workspaceRoot, (draft) => draft.annotations.push(...annotations));
    await updateAgentRun(workspaceRoot, run.id, { status: 'complete', output: JSON.stringify(result), finishedAt: now() });
    return { annotations, runId: run.id, summary: result.summary };
  } catch (error) {
    await updateAgentRun(workspaceRoot, run.id, { status: 'failed', error: error.message.slice(0, 4000), finishedAt: now() });
    error.status = error.status || 502; throw error;
  }
}

function overlap(a, b) {
  return a.target.start < b.target.end && b.target.start < a.target.end;
}

export async function createRevisionPlan(workspaceRoot, { documentId, annotationIds, title = 'Revision plan' }) {
  const { result } = await updateProject(workspaceRoot, (project) => {
    const document = project.documents.find((item) => item.id === documentId);
    if (!document) throw problem('Document not found', 404);
    const selected = project.annotations.filter((item) => item.documentId === documentId && annotationIds.includes(item.id));
    if (!selected.length) throw problem('Select at least one annotation');
    const changes = selected.map((annotation) => ({
      id: id('change'), annotationId: annotation.id,
      target: structuredClone(annotation.target), before: annotation.target.quote,
      after: annotation.suggestedFix, reason: annotation.body,
      status: 'proposed', executable: Boolean(annotation.target.quote && annotation.suggestedFix && annotation.target.quote !== annotation.suggestedFix),
      dependsOn: [], conflictsWith: [],
    }));
    const edges = [];
    changes.forEach((change, index) => {
      const dependencyIds = [...(selected[index].dependsOn || [])];
      const dependency = selected[index].body.match(/depends?\s+on\s+#?(\d+)/i);
      if (dependency) {
        const dependencyAnnotation = selected[Number(dependency[1]) - 1];
        if (dependencyAnnotation) dependencyIds.push(dependencyAnnotation.id);
      }
      [...new Set(dependencyIds)].forEach((dependencyAnnotationId) => {
        const dependencyChange = changes.find((item) => item.annotationId === dependencyAnnotationId);
        if (dependencyChange) {
          change.dependsOn.push(dependencyChange.id);
          edges.push({ from: dependencyChange.id, to: change.id, type: 'depends-on' });
        }
      });
      changes.slice(index + 1).forEach((other) => {
        if (change.target.end > change.target.start && overlap(change, other)) {
          change.conflictsWith.push(other.id);
          other.conflictsWith.push(change.id);
          edges.push({ from: change.id, to: other.id, type: 'conflicts' });
        }
      });
    });
    const timestamp = now();
    const revision = {
      id: id('revision'), documentId, file: document.file, title, summary: `${selected.length} imported opinion(s)`,
      status: 'review', annotationIds: selected.map((item) => item.id), changes,
      graph: { nodes: changes.map((item) => item.id), edges }, recoveryPoint: null,
      createdAt: timestamp, updatedAt: timestamp,
    };
    project.revisions.push(revision);
    selected.forEach((annotation) => { annotation.status = 'planned'; annotation.updatedAt = timestamp; });
    return structuredClone(revision);
  });
  return result;
}

export async function decideRevisionChanges(workspaceRoot, revisionId, decisions) {
  if (!Array.isArray(decisions) || !decisions.length) throw problem('decisions must be a non-empty array');
  const allowed = ['accepted', 'rejected', 'deferred', 'proposed'];
  const { result } = await updateProject(workspaceRoot, (project) => {
    const revision = project.revisions.find((item) => item.id === revisionId);
    if (!revision) throw problem('Revision not found', 404);
    if (['applied', 'rolled-back'].includes(revision.status)) throw problem('Applied revisions cannot be edited', 409);
    for (const decision of decisions) {
      const change = revision.changes.find((item) => item.id === decision.changeId);
      if (!change) throw problem(`Change not found: ${decision.changeId}`, 404);
      if (!allowed.includes(decision.status)) throw problem(`Invalid change decision: ${decision.status}`);
      if (decision.after !== undefined) {
        if (typeof decision.after !== 'string') throw problem('after must be a string');
        change.after = decision.after;
        change.executable = typeof change.before === 'string' && typeof change.after === 'string' && change.before !== change.after;
      }
      if (decision.status === 'accepted' && !change.executable) throw problem('A change needs distinct before/after text before it can be accepted');
      change.status = decision.status;
      const annotation = project.annotations.find((item) => item.id === change.annotationId);
      if (annotation) {
        annotation.status = decision.status === 'rejected' ? 'rejected' : decision.status === 'deferred' ? 'deferred' : 'planned';
        annotation.updatedAt = now();
      }
    }
    revision.updatedAt = now();
    return structuredClone(revision);
  });
  return result;
}

async function atomicWrite(file, content) {
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporary, content, 'utf-8');
  await rename(temporary, file);
}

async function withRevisionLock(workspaceRoot, operation) {
  const previous = revisionQueues.get(workspaceRoot) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  revisionQueues.set(workspaceRoot, current);
  try {
    return await current;
  } finally {
    if (revisionQueues.get(workspaceRoot) === current) revisionQueues.delete(workspaceRoot);
  }
}

function validateAcceptedChanges(content, changes) {
  const sorted = [...changes].sort((a, b) => b.target.start - a.target.start);
  for (let index = 0; index < sorted.length; index += 1) {
    const change = sorted[index];
    if (!change.executable || typeof change.before !== 'string' || typeof change.after !== 'string' || change.before === change.after) throw problem(`Change ${change.id} is not executable`);
    if (content.slice(change.target.start, change.target.end) !== change.before) {
      throw problem(`Source text changed for ${change.id}; create a new revision plan`, 409, 'STALE_CHANGE');
    }
    const next = sorted[index + 1];
    if (next && next.target.end > change.target.start) throw problem('Accepted changes overlap; reject one conflicting change', 409, 'OVERLAPPING_CHANGES');
    for (const dependency of change.dependsOn || []) {
      if (!changes.some((item) => item.id === dependency)) throw problem(`Accepted change ${change.id} depends on an unaccepted change`, 409, 'UNMET_DEPENDENCY');
    }
  }
  return sorted;
}

export async function applyRevision(workspaceRoot, revisionId) {
  return withRevisionLock(workspaceRoot, async () => {
    const project = await loadProject(workspaceRoot);
    const revision = project.revisions.find((item) => item.id === revisionId);
    if (!revision) throw problem('Revision not found', 404);
    if (revision.status === 'applied') throw problem('Revision is already applied', 409);
    const document = project.documents.find((item) => item.id === revision.documentId);
    if (!document) throw problem('Document not found', 404);
    const safe = sanitizePath(document.file, workspaceRoot);
    if (!safe) throw problem('Access denied', 403);
    const original = await readFile(safe, 'utf-8');
    const accepted = revision.changes.filter((item) => item.status === 'accepted');
    if (!accepted.length) throw problem('No accepted changes to apply');
    const sorted = validateAcceptedChanges(original, accepted);
    let revised = original;
    for (const change of sorted) {
      revised = revised.slice(0, change.target.start) + change.after + revised.slice(change.target.end);
    }

    const recoveryId = id('recovery');
    const recoveryDirectory = join(workspaceRoot, '.papergod', 'recovery');
    const recoveryRelative = join('.papergod', 'recovery', `${recoveryId}.tex`).split(sep).join('/');
    const recoveryFile = join(workspaceRoot, recoveryRelative);
    await mkdir(recoveryDirectory, { recursive: true });
    await writeFile(recoveryFile, original, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
    await atomicWrite(safe, revised);
    try {
      const { result } = await updateProject(workspaceRoot, (draft) => {
        const currentRevision = draft.revisions.find((item) => item.id === revisionId);
        if (!currentRevision) throw problem('Revision disappeared during apply', 409);
        const timestamp = now();
        currentRevision.status = 'applied';
        currentRevision.appliedAt = timestamp;
        currentRevision.recoveryPoint = {
          id: recoveryId, file: document.file, path: recoveryRelative, sourceHash: hash(original),
          appliedHash: hash(revised), createdAt: timestamp,
        };
        currentRevision.changes.forEach((change) => {
          if (accepted.some((item) => item.id === change.id)) change.status = 'applied';
        });
        currentRevision.annotationIds.forEach((annotationId) => {
          const annotation = draft.annotations.find((item) => item.id === annotationId);
          if (annotation && accepted.some((change) => change.annotationId === annotationId)) {
            annotation.status = 'resolved';
            annotation.updatedAt = timestamp;
          }
        });
        return structuredClone(currentRevision);
      });
      await syncDocumentStructure(workspaceRoot, document.file);
      return { revision: result, content: revised, recoveryPoint: result.recoveryPoint };
    } catch (error) {
      await atomicWrite(safe, original);
      throw error;
    }
  });
}

export async function rollbackRevision(workspaceRoot, revisionId) {
  return withRevisionLock(workspaceRoot, async () => {
    const project = await loadProject(workspaceRoot);
    const revision = project.revisions.find((item) => item.id === revisionId);
    if (!revision) throw problem('Revision not found', 404);
    if (revision.status !== 'applied' || !revision.recoveryPoint) throw problem('Only an applied revision can be rolled back', 409);
    const document = project.documents.find((item) => item.id === revision.documentId);
    const target = sanitizePath(document.file, workspaceRoot);
    const recovery = sanitizePath(revision.recoveryPoint.path, workspaceRoot);
    if (!target || !recovery || !revision.recoveryPoint.path.startsWith('.papergod/recovery/')) throw problem('Invalid recovery point', 403);
    const current = await readFile(target, 'utf-8');
    if (hash(current) !== revision.recoveryPoint.appliedHash) {
      throw problem('Document changed after revision; automatic rollback would discard later work', 409, 'ROLLBACK_CONFLICT');
    }
    const original = await readFile(recovery, 'utf-8');
    if (hash(original) !== revision.recoveryPoint.sourceHash) throw problem('Recovery point checksum failed', 409);
    await atomicWrite(target, original);
    const { result } = await updateProject(workspaceRoot, (draft) => {
      const currentRevision = draft.revisions.find((item) => item.id === revisionId);
      currentRevision.status = 'rolled-back';
      currentRevision.rolledBackAt = now();
      currentRevision.changes.forEach((change) => { if (change.status === 'applied') change.status = 'reverted'; });
      currentRevision.annotationIds.forEach((annotationId) => {
        const annotation = draft.annotations.find((item) => item.id === annotationId);
        if (annotation?.status === 'resolved') { annotation.status = 'open'; annotation.updatedAt = now(); }
      });
      return structuredClone(currentRevision);
    });
    await syncDocumentStructure(workspaceRoot, document.file);
    return { revision: result, content: original };
  });
}

export async function restoreRevisionVersion(workspaceRoot, revisionId) {
  const historical = await getHistoricalRevisionSource(workspaceRoot, revisionId);
  const safe = sanitizePath(historical.document.file, workspaceRoot);
  if (!safe) throw problem('Access denied', 403);
  const current = await readFile(safe, 'utf-8');
  if (current === historical.source) throw problem('This version is already current', 409);
  const timestamp = now();
  const changeId = id('change');
  const revision = {
    id: id('revision'), documentId: historical.document.id, file: historical.document.file,
    title: `Restore version · ${historical.revision.title || historical.revision.id}`,
    summary: `Restore the paper to version ${historical.revision.id} while preserving the current paper as a recovery point.`,
    status: 'review', annotationIds: [],
    changes: [{
      id: changeId, target: { type: 'range', id: historical.document.id, start: 0, end: current.length, quote: current },
      before: current, after: historical.source, reason: `Restore historical version ${historical.revision.id}.`,
      status: 'accepted', executable: true, dependsOn: [], conflictsWith: [],
    }],
    graph: { nodes: [changeId], edges: [] }, recoveryPoint: null, origin: 'history-restore',
    restoredRevisionId: historical.revision.id, createdAt: timestamp, updatedAt: timestamp,
  };
  await updateProject(workspaceRoot, (draft) => draft.revisions.push(revision));
  return applyRevision(workspaceRoot, revision.id);
}

export async function applySuggestionAsRevision(workspaceRoot, file, suggestion) {
  if (!suggestion || typeof suggestion.originalText !== 'string' || typeof suggestion.suggestedText !== 'string') {
    throw problem('Suggestion not found', 404);
  }
  const document = await syncDocumentStructure(workspaceRoot, file);
  const safe = sanitizePath(file, workspaceRoot); if (!safe) throw problem('Access denied', 403);
  const content = await readFile(safe, 'utf-8');
  let start = suggestion.sourceRange?.start;
  let end = suggestion.sourceRange?.end;
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    start = content.indexOf(suggestion.originalText); end = start + suggestion.originalText.length;
  }
  if (start < 0 || content.slice(start, end) !== suggestion.originalText) throw problem('Source text changed; generate a new suggestion', 409, 'STALE_CHANGE');
  if (suggestion.file && suggestion.file !== file) throw problem('Suggestion belongs to a different file', 409);
  const timestamp = now(); const changeId = id('change');
  const revision = {
    id: id('revision'), documentId: document.id, file, title: `Agent suggestion · ${suggestion.category || 'edit'}`,
    summary: suggestion.description || suggestion.reason || 'Accepted Agent writing suggestion.', status: 'review', annotationIds: [],
    changes: [{
      id: changeId, target: { type: 'range', id: suggestion.nodeId || document.id, start, end, quote: suggestion.originalText },
      before: suggestion.originalText, after: suggestion.suggestedText, reason: suggestion.reason || suggestion.description || 'Agent suggestion',
      status: 'accepted', executable: suggestion.originalText !== suggestion.suggestedText, dependsOn: [], conflictsWith: [],
    }],
    graph: { nodes: [changeId], edges: [] }, recoveryPoint: null, origin: 'agent-suggestion',
    createdAt: timestamp, updatedAt: timestamp,
  };
  if (!revision.changes[0].executable) throw problem('Suggestion does not change the source');
  await updateProject(workspaceRoot, (draft) => draft.revisions.push(revision));
  return applyRevision(workspaceRoot, revision.id);
}

export async function applySuggestionsAsRevision(workspaceRoot, file, suggestions) {
  if (!Array.isArray(suggestions) || !suggestions.length) throw problem('No suggestions to apply');
  const document = await syncDocumentStructure(workspaceRoot, file);
  const safe = sanitizePath(file, workspaceRoot); if (!safe) throw problem('Access denied', 403);
  const content = await readFile(safe, 'utf-8');
  const candidateChanges = suggestions.map((suggestion) => {
    if (!suggestion || typeof suggestion.originalText !== 'string' || typeof suggestion.suggestedText !== 'string') throw problem('Suggestion not found', 404);
    if (suggestion.file && suggestion.file !== file) throw problem('Suggestion belongs to a different file', 409);
    let start = suggestion.sourceRange?.start;
    let end = suggestion.sourceRange?.end;
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      start = content.indexOf(suggestion.originalText); end = start + suggestion.originalText.length;
    }
    if (start < 0 || content.slice(start, end) !== suggestion.originalText) throw problem('Source text changed; generate new suggestions', 409, 'STALE_CHANGE');
    return {
      id: id('change'), target: { type: 'range', id: suggestion.nodeId || document.id, start, end, quote: suggestion.originalText },
      before: suggestion.originalText, after: suggestion.suggestedText,
      reason: suggestion.reason || suggestion.description || 'Agent suggestion', status: 'accepted', executable: suggestion.originalText !== suggestion.suggestedText,
      dependsOn: [], conflictsWith: [],
    };
  });
  const changes = [];
  for (const candidate of candidateChanges) {
    if (candidate.executable && !changes.some((accepted) => overlap(candidate, accepted))) changes.push(candidate);
  }
  if (!changes.length) throw problem('No non-overlapping source changes to apply');
  const timestamp = now();
  const revision = {
    id: id('revision'), documentId: document.id, file, title: `AI revision · ${changes.length} change${changes.length === 1 ? '' : 's'}`,
    summary: `Applied ${changes.length} Agent suggestion${changes.length === 1 ? '' : 's'} as one atomic revision.`, status: 'review', annotationIds: [], changes,
    graph: { nodes: changes.map((item) => item.id), edges: [] }, recoveryPoint: null, origin: 'agent-batch', createdAt: timestamp, updatedAt: timestamp,
  };
  await updateProject(workspaceRoot, (draft) => draft.revisions.push(revision));
  return applyRevision(workspaceRoot, revision.id);
}

export async function recordRejectedSuggestion(workspaceRoot, file, suggestion) {
  if (!suggestion) throw problem('Suggestion not found', 404);
  const document = await syncDocumentStructure(workspaceRoot, file);
  const safe = sanitizePath(file, workspaceRoot); if (!safe) throw problem('Access denied', 403);
  const content = await readFile(safe, 'utf-8');
  const start = Number.isInteger(suggestion.sourceRange?.start) ? suggestion.sourceRange.start : Math.max(0, content.indexOf(suggestion.originalText));
  const end = start + suggestion.originalText.length;
  const timestamp = now(); const changeId = id('change');
  const revision = {
    id: id('revision'), documentId: document.id, file, title: `Rejected Agent suggestion · ${suggestion.category || 'edit'}`,
    summary: suggestion.description || 'User rejected the Agent suggestion.', status: 'cancelled', annotationIds: [],
    changes: [{
      id: changeId, target: { type: 'range', id: suggestion.nodeId || document.id, start, end, quote: content.slice(start, end) === suggestion.originalText ? suggestion.originalText : '' },
      before: suggestion.originalText, after: suggestion.suggestedText, reason: suggestion.reason || suggestion.description || 'Agent suggestion',
      status: 'rejected', executable: suggestion.originalText !== suggestion.suggestedText, dependsOn: [], conflictsWith: [],
    }],
    graph: { nodes: [changeId], edges: [] }, recoveryPoint: null, origin: 'agent-suggestion',
    createdAt: timestamp, updatedAt: timestamp,
  };
  await updateProject(workspaceRoot, (draft) => draft.revisions.push(revision));
  return revision;
}

export async function insertGeneratedParagraph(workspaceRoot, { documentId, index, text, prompt = '', runId = '' }) {
  if (!Number.isInteger(index) || index < 0) throw problem('index must be a non-negative integer');
  if (typeof text !== 'string' || !text.trim()) throw problem('paragraph text is required');
  const project = await loadProject(workspaceRoot);
  const document = project.documents.find((item) => item.id === documentId);
  if (!document) throw problem('Document not found', 404);
  const generationRun = runId ? project.agentRuns.find((run) => run.id === runId && ['generate-paragraph', 'literature-review'].includes(run.operation) && run.status === 'complete') : null;
  if (runId && !generationRun) {
    throw problem('Paragraph generation run not found', 404);
  }
  await syncDocumentStructure(workspaceRoot, document.file);
  const safe = sanitizePath(document.file, workspaceRoot); if (!safe) throw problem('Access denied', 403);
  const content = await readFile(safe, 'utf-8');
  if (index > content.length) throw problem('Insertion index is outside the document');
  const prefix = index > 0 && !/\n\s*\n$/.test(content.slice(0, index)) ? '\n\n' : '';
  const insertion = prefix + text;
  const timestamp = now(); const changeId = id('change');
  const revision = {
    id: id('revision'), documentId, file: document.file, title: 'Generated paragraph insertion',
    summary: prompt || 'Insert the user-approved Agent paragraph draft.', status: 'review', annotationIds: [],
    changes: [{
      id: changeId, target: { type: 'range', id: document.id, start: index, end: index, quote: '' },
      before: '', after: insertion, reason: prompt || 'User approved the generated paragraph draft.',
      status: 'accepted', executable: true, dependsOn: [], conflictsWith: [],
    }],
    graph: { nodes: [changeId], edges: [] }, recoveryPoint: null, origin: 'paragraph-generation',
    generation: runId ? {
      runId, instruction: prompt,
      providedResourceIds: (() => { try { return (JSON.parse(generationRun.input).providedResources || []).map((item) => item.id); } catch { return []; } })(),
      usedResourceIds: (() => { try { return JSON.parse(generationRun.output).usedResourceIds || []; } catch { return []; } })(),
    } : undefined,
    createdAt: timestamp, updatedAt: timestamp,
  };
  await updateProject(workspaceRoot, (draft) => draft.revisions.push(revision));
  return applyRevision(workspaceRoot, revision.id);
}
