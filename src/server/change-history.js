import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { loadProject } from './project-store.js';
import { sanitizePath } from './security.js';

function hash(content) {
  return createHash('sha256').update(content).digest('hex');
}

function timestampOf(revision) {
  return revision.rolledBackAt || revision.appliedAt || revision.updatedAt || revision.createdAt || '';
}

function appliedRanges(changes) {
  const executable = changes.filter((change) => Number.isInteger(change.target?.start) && typeof change.before === 'string' && typeof change.after === 'string');
  return executable.map((change) => {
    const shift = executable
      .filter((other) => other.target.start < change.target.start)
      .reduce((total, other) => total + other.after.length - other.before.length, 0);
    const currentStart = change.target.start + shift;
    return { ...change, currentStart, currentEnd: currentStart + change.after.length };
  });
}

async function historicalRevisionSource(workspaceRoot, revision, document) {
  if (!revision?.recoveryPoint) {
    const error = new Error('Historical source is unavailable'); error.status = 404; throw error;
  }
  const recovery = sanitizePath(revision.recoveryPoint.path, workspaceRoot);
  if (!recovery || !revision.recoveryPoint.path.startsWith('.papergod/recovery/')) {
    const error = new Error('Invalid recovery point'); error.status = 403; throw error;
  }
  const original = await readFile(recovery, 'utf-8');
  if (hash(original) !== revision.recoveryPoint.sourceHash) {
    const error = new Error('Recovery point checksum failed'); error.status = 409; throw error;
  }
  const changes = (revision.changes || [])
    .filter((change) => ['applied', 'reverted'].includes(change.status) && Number.isInteger(change.target?.start) && Number.isInteger(change.target?.end))
    .sort((left, right) => right.target.start - left.target.start);
  let source = original;
  for (const change of changes) {
    if (source.slice(change.target.start, change.target.end) !== change.before) {
      const error = new Error(`Historical change ${change.id} does not match its recovery point`); error.status = 409; throw error;
    }
    source = source.slice(0, change.target.start) + change.after + source.slice(change.target.end);
  }
  if (hash(source) !== revision.recoveryPoint.appliedHash) {
    const error = new Error('Historical version checksum failed'); error.status = 409; throw error;
  }
  return { revision, document, source };
}

export async function getRecentChangeHistory(workspaceRoot, documentId, limit = 5) {
  const project = await loadProject(workspaceRoot);
  const document = project.documents.find((item) => item.id === documentId);
  if (!document) {
    const error = new Error('Document not found'); error.status = 404; throw error;
  }
  const safe = sanitizePath(document.file, workspaceRoot);
  if (!safe) {
    const error = new Error('Access denied'); error.status = 403; throw error;
  }
  const currentHash = hash(await readFile(safe, 'utf-8'));
  const revisions = project.revisions
    .filter((item) => item.documentId === documentId && item.recoveryPoint && ['applied', 'rolled-back'].includes(item.status))
    .sort((left, right) => timestampOf(right).localeCompare(timestampOf(left)))
    .slice(0, Math.max(1, Math.min(5, Number(limit) || 5)));
  return Promise.all(revisions.map(async (revision, index) => {
    const matchesCurrent = revision.status === 'applied' && revision.recoveryPoint.appliedHash === currentHash;
    const changes = appliedRanges((revision.changes || []).filter((change) => ['applied', 'reverted'].includes(change.status)));
    const { source } = await historicalRevisionSource(workspaceRoot, revision, document);
    return {
      id: revision.id, documentId: revision.documentId, file: revision.file || document.file,
      title: revision.title, summary: revision.summary, origin: revision.origin || 'revision', status: revision.status,
      createdAt: revision.createdAt, appliedAt: revision.appliedAt || '', rolledBackAt: revision.rolledBackAt || '',
      changeCount: changes.length, isLatest: index === 0, matchesCurrent,
      canRollback: matchesCurrent, canRestore: !matchesCurrent, previewAvailable: true,
      changes: changes.map((change) => ({
        id: change.id, before: change.before, after: change.after, reason: change.reason || '', target: change.target,
        currentStart: matchesCurrent ? change.currentStart : null, currentEnd: matchesCurrent ? change.currentEnd : null,
        type: change.before === '' ? 'added' : change.after === '' ? 'deleted' : 'modified',
        contextBefore: source.slice(Math.max(0, change.currentStart - 240), change.currentStart),
        contextAfter: source.slice(change.currentEnd, Math.min(source.length, change.currentEnd + 240)),
      })),
    };
  }));
}

export async function getHistoricalRevisionSource(workspaceRoot, revisionId) {
  const project = await loadProject(workspaceRoot);
  const revision = project.revisions.find((item) => item.id === revisionId);
  if (!revision) {
    const error = new Error('Change history entry not found'); error.status = 404; throw error;
  }
  const document = project.documents.find((item) => item.id === revision.documentId);
  if (!document) {
    const error = new Error('Document not found'); error.status = 404; throw error;
  }
  return historicalRevisionSource(workspaceRoot, revision, document);
}

export async function getChangeHistoryEntry(workspaceRoot, revisionId) {
  const project = await loadProject(workspaceRoot);
  const revision = project.revisions.find((item) => item.id === revisionId);
  if (!revision) {
    const error = new Error('Change history entry not found'); error.status = 404; throw error;
  }
  const history = await getRecentChangeHistory(workspaceRoot, revision.documentId, 5);
  const entry = history.find((item) => item.id === revisionId);
  if (!entry) {
    const error = new Error('Change history entry is outside the recent history window'); error.status = 404; throw error;
  }
  return entry;
}
