import { randomUUID } from 'crypto';
import { loadProject, updateProject } from './project-store.js';

function timestamp() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${randomUUID()}`;
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function strings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()) : [];
}

function resourceError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const libraryKinds = {
  corpora: {
    prefix: 'corpus',
    collection: (project) => project.libraries.corpora,
    build(input, existing) {
      const time = timestamp();
      return {
        id: existing?.id || id('corpus'),
        name: text(input.name),
        description: text(input.description),
        content: text(input.content),
        source: text(input.source),
        tags: strings(input.tags),
        createdAt: existing?.createdAt || time,
        updatedAt: time,
      };
    },
  },
  'sentence-patterns': {
    prefix: 'pattern',
    collection: (project) => project.libraries.sentencePatterns,
    build(input, existing) {
      const time = timestamp();
      return {
        id: existing?.id || id('pattern'),
        name: text(input.name),
        template: text(input.template),
        description: text(input.description),
        source: text(input.source),
        tags: strings(input.tags),
        sectionTypes: strings(input.sectionTypes),
        slots: Array.isArray(input.slots) ? input.slots.map((slot) => ({
          name: text(slot?.name),
          description: text(slot?.description),
          required: slot?.required !== false,
        })) : [],
        createdAt: existing?.createdAt || time,
        updatedAt: time,
      };
    },
  },
};

function vocabularyConfig(scope) {
  if (!['global', 'session'].includes(scope)) throw resourceError('Vocabulary scope must be global or session');
  return {
    collection: (project) => project.libraries.vocabulary[scope],
    build(input, existing) {
      const time = timestamp();
      return {
        id: existing?.id || id('vocabulary'),
        term: text(input.term),
        preferred: text(input.preferred),
        definition: text(input.definition),
        source: text(input.source),
        alternatives: strings(input.alternatives),
        examples: strings(input.examples),
        tags: strings(input.tags),
        createdAt: existing?.createdAt || time,
        updatedAt: time,
      };
    },
  };
}

function libraryConfig(kind, scope) {
  if (kind === 'vocabulary') return vocabularyConfig(scope);
  const config = libraryKinds[kind];
  if (!config) throw resourceError('Unknown library kind', 404);
  return config;
}

export async function getLibraries(workspaceRoot) {
  return (await loadProject(workspaceRoot)).libraries;
}

export async function createLibraryResource(workspaceRoot, kind, scope, input = {}) {
  const config = libraryConfig(kind, scope);
  const item = config.build(input);
  await updateProject(workspaceRoot, (project) => config.collection(project).push(item));
  return item;
}

export async function updateLibraryResource(workspaceRoot, kind, scope, resourceId, input = {}) {
  const config = libraryConfig(kind, scope);
  const { result } = await updateProject(workspaceRoot, (project) => {
    const collection = config.collection(project);
    const index = collection.findIndex((item) => item.id === resourceId);
    if (index === -1) throw resourceError('Library resource not found', 404);
    const updated = config.build({ ...collection[index], ...input }, collection[index]);
    collection[index] = updated;
    return updated;
  });
  return result;
}

export async function deleteLibraryResource(workspaceRoot, kind, scope, resourceId) {
  const config = libraryConfig(kind, scope);
  await updateProject(workspaceRoot, (project) => {
    const collection = config.collection(project);
    const index = collection.findIndex((item) => item.id === resourceId);
    if (index === -1) throw resourceError('Library resource not found', 404);
    collection.splice(index, 1);
  });
}

function buildTarget(input = {}) {
  return {
    type: text(input.type, 'document'),
    id: text(input.id),
    start: Number.isInteger(input.start) ? input.start : 0,
    end: Number.isInteger(input.end) ? input.end : 0,
    quote: text(input.quote),
  };
}

function buildAnnotation(input, existing) {
  const time = timestamp();
  return {
    id: existing?.id || id('annotation'),
    documentId: text(input.documentId),
    target: buildTarget(input.target),
    category: text(input.category, 'other'),
    severity: text(input.severity, 'info'),
    body: text(input.body),
    suggestedFix: text(input.suggestedFix),
    status: text(input.status, 'open'),
    order: Number.isInteger(input.order) ? input.order : existing?.order,
    dependsOn: strings(input.dependsOn),
    source: {
      type: text(input.source?.type, 'user'),
      actor: text(input.source?.actor),
    },
    createdAt: existing?.createdAt || time,
    updatedAt: time,
  };
}

export async function listAnnotations(workspaceRoot, documentId) {
  const annotations = (await loadProject(workspaceRoot)).annotations;
  return documentId ? annotations.filter((item) => item.documentId === documentId) : annotations;
}

export async function createAnnotation(workspaceRoot, input = {}) {
  const item = buildAnnotation(input);
  await updateProject(workspaceRoot, (project) => project.annotations.push(item));
  return item;
}

export async function updateAnnotation(workspaceRoot, annotationId, input = {}) {
  const { result } = await updateProject(workspaceRoot, (project) => {
    const index = project.annotations.findIndex((item) => item.id === annotationId);
    if (index === -1) throw resourceError('Annotation not found', 404);
    const existing = project.annotations[index];
    const updated = buildAnnotation({
      ...existing,
      ...input,
      target: { ...existing.target, ...input.target },
      source: { ...existing.source, ...input.source },
    }, existing);
    project.annotations[index] = updated;
    return updated;
  });
  return result;
}

export async function deleteAnnotation(workspaceRoot, annotationId) {
  await updateProject(workspaceRoot, (project) => {
    const index = project.annotations.findIndex((item) => item.id === annotationId);
    if (index === -1) throw resourceError('Annotation not found', 404);
    project.annotations.splice(index, 1);
  });
}

function buildRevision(input, existing) {
  const time = timestamp();
  return {
    id: existing?.id || id('revision'),
    documentId: text(input.documentId),
    title: text(input.title),
    summary: text(input.summary),
    status: text(input.status, 'draft'),
    annotationIds: strings(input.annotationIds),
    changes: Array.isArray(input.changes) ? input.changes.map((change) => ({
      id: text(change?.id) || id('change'),
      target: buildTarget(change?.target),
      before: text(change?.before),
      after: text(change?.after),
      reason: text(change?.reason),
      status: text(change?.status, 'proposed'),
    })) : [],
    createdAt: existing?.createdAt || time,
    updatedAt: time,
  };
}

export async function listRevisions(workspaceRoot, documentId) {
  const revisions = (await loadProject(workspaceRoot)).revisions;
  return documentId ? revisions.filter((item) => item.documentId === documentId) : revisions;
}

export async function createRevision(workspaceRoot, input = {}) {
  const item = buildRevision(input);
  await updateProject(workspaceRoot, (project) => project.revisions.push(item));
  return item;
}

export async function updateRevision(workspaceRoot, revisionId, input = {}) {
  const { result } = await updateProject(workspaceRoot, (project) => {
    const index = project.revisions.findIndex((item) => item.id === revisionId);
    if (index === -1) throw resourceError('Revision not found', 404);
    const updated = buildRevision({ ...project.revisions[index], ...input }, project.revisions[index]);
    project.revisions[index] = updated;
    return updated;
  });
  return result;
}

export async function deleteRevision(workspaceRoot, revisionId) {
  await updateProject(workspaceRoot, (project) => {
    const index = project.revisions.findIndex((item) => item.id === revisionId);
    if (index === -1) throw resourceError('Revision not found', 404);
    project.revisions.splice(index, 1);
  });
}

function buildAgentRun(input, existing) {
  const time = timestamp();
  return {
    id: existing?.id || id('agent_run'),
    provider: text(input.provider, 'mock'),
    operation: text(input.operation),
    status: text(input.status, 'queued'),
    prompt: text(input.prompt),
    input: text(input.input),
    output: text(input.output),
    error: text(input.error),
    startedAt: text(input.startedAt),
    finishedAt: text(input.finishedAt),
    createdAt: existing?.createdAt || time,
    updatedAt: time,
  };
}

export async function createAgentRun(workspaceRoot, input = {}) {
  const item = buildAgentRun(input);
  await updateProject(workspaceRoot, (project) => project.agentRuns.push(item));
  return item;
}

export async function updateAgentRun(workspaceRoot, runId, input = {}) {
  const { result } = await updateProject(workspaceRoot, (project) => {
    const index = project.agentRuns.findIndex((item) => item.id === runId);
    if (index === -1) throw resourceError('Agent run not found', 404);
    const existing = project.agentRuns[index];
    const updated = buildAgentRun({ ...existing, ...input }, existing);
    project.agentRuns[index] = updated;
    return updated;
  });
  return result;
}

export async function listAgentRuns(workspaceRoot) {
  return (await loadProject(workspaceRoot)).agentRuns;
}
