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
