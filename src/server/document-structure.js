import { createHash, randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { sanitizePath } from './security.js';
import { loadProject, updateProject } from './project-store.js';
import { findStructureNode, parseLatexDocument } from './latex-structure.js';

function error(message, status = 400) {
  const value = new Error(message);
  value.status = status;
  return value;
}

function sourceHash(content) {
  return createHash('sha256').update(content).digest('hex');
}

function resolveTexFile(workspaceRoot, file) {
  const path = sanitizePath(file, workspaceRoot);
  if (!path) throw error('Access denied', 403);
  if (!path.endsWith('.tex')) throw error('Only .tex files can be structured');
  return path;
}

function normalizeAnchor(value) {
  return String(value || '').replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?/g, ' ')
    .replace(/[{}]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function documentNodes(document) {
  const nodes = [];
  const visit = (items) => {
    for (const item of items || []) {
      nodes.push(item);
      visit(item.children);
    }
  };
  visit(document.sections);
  return nodes;
}

function reconcileDocumentAnnotations(project, document, content) {
  const nodes = documentNodes(document);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const sourceFor = (node) => node.sourceRange
    ? content.slice(node.sourceRange.start, node.sourceRange.end)
    : String(node.text || '');
  const matchesQuote = (node, quote) => {
    if (!quote) return true;
    const raw = sourceFor(node);
    return raw.includes(quote) || normalizeAnchor(raw).includes(normalizeAnchor(quote));
  };
  for (const annotation of project.annotations || []) {
    if (annotation.documentId !== document.id || annotation.target?.type === 'document') continue;
    const quote = String(annotation.target?.quote || '');
    const current = nodeById.get(annotation.target.id);
    if (current && matchesQuote(current, quote)) continue;
    const preferredType = annotation.target.type === 'range' ? 'sentence' : annotation.target.type;
    const candidates = nodes.filter((node) => node.type === preferredType && matchesQuote(node, quote));
    const replacement = candidates.sort((left, right) => sourceFor(left).length - sourceFor(right).length)[0]
      || nodes.filter((node) => node.type === 'sentence' && matchesQuote(node, quote))[0]
      || null;
    if (!replacement) {
      annotation.target = { ...annotation.target, type: 'document', id: document.id, start: 0, end: 0 };
      continue;
    }
    const raw = sourceFor(replacement);
    const relativeStart = quote ? raw.indexOf(quote) : -1;
    const base = replacement.sourceRange?.start || 0;
    const start = relativeStart >= 0 ? base + relativeStart : base;
    const end = relativeStart >= 0 ? start + quote.length : (replacement.sourceRange?.end || start);
    annotation.target = {
      ...annotation.target,
      type: annotation.target.type === 'range' ? 'range' : replacement.type,
      id: replacement.id,
      start,
      end,
    };
  }
}

export async function syncDocumentStructure(workspaceRoot, file) {
  const path = resolveTexFile(workspaceRoot, file);
  let content;
  try {
    content = await readFile(path, 'utf-8');
  } catch (cause) {
    if (cause.code === 'ENOENT') throw error('File not found', 404);
    throw cause;
  }
  const hash = sourceHash(content);
  const { result } = await updateProject(workspaceRoot, (project) => {
    let document = project.documents.find((item) => item.file === file);
    if (!document) {
      document = {
        id: `document_${randomUUID()}`, file, title: '', summary: '', corePrompt: '', sections: [],
      };
      project.documents.push(document);
    }
    const parsed = parseLatexDocument(content, document);
    document.title = parsed.title;
    document.sections = parsed.sections;
    document.sourceHash = hash;
    document.sourceLength = parsed.sourceLength;
    reconcileDocumentAnnotations(project, document, content);
    return structuredClone(document);
  });
  return result;
}

export async function getDocumentStructure(workspaceRoot, documentId) {
  const document = (await loadProject(workspaceRoot)).documents.find((item) => item.id === documentId);
  if (!document) throw error('Document not found', 404);
  return document;
}

export async function updateDocumentMetadata(workspaceRoot, documentId, input = {}) {
  const { result } = await updateProject(workspaceRoot, (project) => {
    const document = project.documents.find((item) => item.id === documentId);
    if (!document) throw error('Document not found', 404);
    for (const field of ['title', 'summary', 'corePrompt']) {
      if (input[field] !== undefined) {
        if (typeof input[field] !== 'string') throw error(`${field} must be a string`);
        document[field] = input[field];
      }
    }
    return structuredClone(document);
  });
  return result;
}

export async function updateNodeMetadata(workspaceRoot, nodeId, input = {}) {
  const { result } = await updateProject(workspaceRoot, (project) => {
    let node = null;
    for (const document of project.documents) {
      node = findStructureNode(document, nodeId);
      if (node) break;
    }
    if (!node) throw error('Structure node not found', 404);
    for (const field of ['prompt', 'summary', 'intent']) {
      if (input[field] !== undefined) {
        if (typeof input[field] !== 'string') throw error(`${field} must be a string`);
        if (field === 'intent' && node.type !== 'sentence') throw error('intent is only valid for sentence nodes');
        node[field] = input[field];
      }
    }
    return structuredClone(node);
  });
  return result;
}

export async function getNodeSourceContext(workspaceRoot, nodeId) {
  const project = await loadProject(workspaceRoot);
  for (const document of project.documents) {
    const node = findStructureNode(document, nodeId);
    if (!node) continue;
    if (!node.sourceRange) throw error('Node has no source range; synchronize the document first', 409);
    const path = resolveTexFile(workspaceRoot, document.file);
    const content = await readFile(path, 'utf-8');
    if (document.sourceHash !== sourceHash(content)) throw error('Document changed; synchronize structure before editing this node', 409);
    const { start, end } = node.sourceRange;
    if (end > content.length) throw error('Node source range is stale; synchronize the document', 409);
    const section = document.sections.find((candidate) => {
      if (candidate.id === nodeId) return true;
      const visit = (items) => items.some((item) => item.id === nodeId || visit(item.children || []));
      return visit(candidate.children || []);
    }) || null;
    return {
      project, document, node, section, content,
      selectedContent: content.slice(start, end),
      sourceRange: { start, end },
    };
  }
  throw error('Structure node not found', 404);
}
