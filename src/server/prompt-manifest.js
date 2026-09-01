import { createHash, randomUUID } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { basename, join } from 'path';
import { sanitizePath } from './security.js';
import { loadProject } from './project-store.js';
import { findStructureNode } from './latex-structure.js';
import { materializeLibraries } from './library-files.js';
import { loadReferenceState } from './references.js';

const CONTEXT_DIRECTORY = '.papergod/context';
const MANIFEST_VERSION = 2;

function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function tokenEstimate(value) { return Math.ceil(String(value || '').length / 4); }
function sha256(value) { return createHash('sha256').update(String(value || '')).digest('hex'); }

function compactNode(node, position = {}) {
  return {
    id: node.id,
    type: node.type,
    title: text(node.title),
    parentId: node.parentId || '',
    position,
    sourceRange: node.sourceRange || null,
    summary: text(node.summary),
    hasPrompt: Boolean(text(node.prompt)),
    hasIntent: Boolean(text(node.intent)),
    children: (node.children || []).map((child, index) => compactNode(child, {
      section: position.section,
      paragraph: child.type === 'paragraph' ? index + 1 : position.paragraph,
      sentence: child.type === 'sentence' ? index + 1 : undefined,
    })),
  };
}

function structureFor(document) {
  return {
    documentId: document.id,
    file: document.file,
    title: text(document.title),
    sourceHash: document.sourceHash || '',
    sections: (document.sections || []).map((section, index) => compactNode(section, { section: index + 1 })),
  };
}

function locateNode(document, nodeId) {
  for (const [sectionIndex, section] of (document.sections || []).entries()) {
    if (section.id === nodeId) return { node: section, section, sectionIndex: sectionIndex + 1 };
    for (const [paragraphIndex, paragraph] of (section.children || []).entries()) {
      if (paragraph.id === nodeId) return { node: paragraph, section, paragraph, sectionIndex: sectionIndex + 1, paragraphIndex: paragraphIndex + 1 };
      for (const [sentenceIndex, sentence] of (paragraph.children || []).entries()) {
        if (sentence.id === nodeId) return { node: sentence, section, paragraph, sentence, sectionIndex: sectionIndex + 1, paragraphIndex: paragraphIndex + 1, sentenceIndex: sentenceIndex + 1 };
      }
    }
  }
  const node = findStructureNode(document, nodeId);
  return node ? { node } : null;
}

function taskFromTarget({ id, document, target, instruction, fallbackQuote = '', resourceIds = [], citekeys = [], sourceHash = '' }) {
  const location = locateNode(document, target?.id);
  const range = Number.isInteger(target?.start) && Number.isInteger(target?.end)
    ? { start: target.start, end: target.end }
    : location?.node?.sourceRange || null;
  const exactQuote = String(target?.quote || fallbackQuote || '');
  return {
    taskId: id,
    humanLocation: {
      section: location?.sectionIndex || null,
      sectionTitle: text(location?.section?.title),
      paragraph: location?.paragraphIndex || null,
      sentence: location?.sentenceIndex || null,
    },
    target: {
      file: document.file,
      nodeId: target?.id || location?.node?.id || document.id,
      type: target?.type || location?.node?.type || 'document',
      sourceRange: range,
      offsetEncoding: 'utf16-code-units',
      sourceHash: sourceHash || document.sourceHash || '',
      matchMode: exactQuote ? 'exact' : 'substring-within-range',
      exactQuote,
      exactQuoteHash: sha256(exactQuote),
    },
    instruction: text(instruction) || 'Improve this target according to the supplied academic-writing context.',
    templateResourceIds: [...new Set(resourceIds.filter(Boolean))],
    citekeys: [...new Set(citekeys.filter(Boolean))],
  };
}

function projectMarkdown(project) {
  return `# Project context\n\n- name: ${project.project.name}\n- id: ${project.project.id}\n\n## Core prompt\n\n${text(project.project.corePrompt) || 'No project-level prompt.'}\n`;
}

function documentMarkdown(document) {
  const lines = [`# Document context`, '', `- title: ${text(document.title)}`, `- file: ${document.file}`, '', '## Summary', '', text(document.summary) || 'No document summary.', '', '## Core prompt', '', text(document.corePrompt) || 'No document-level prompt.', '', '## Element guidance'];
  const visit = (nodes) => {
    for (const node of nodes || []) {
      if (text(node.prompt) || text(node.summary) || text(node.intent)) {
        lines.push('', `### ${node.type} ${node.id}`, `- sourceRange: ${node.sourceRange ? `${node.sourceRange.start}-${node.sourceRange.end}` : 'unknown'}`);
        if (text(node.summary)) lines.push(`- summary: ${text(node.summary)}`);
        if (text(node.prompt)) lines.push(`- prompt: ${text(node.prompt)}`);
        if (text(node.intent)) lines.push(`- intent: ${text(node.intent)}`);
      }
      visit(node.children);
    }
  };
  visit(document.sections);
  return `${lines.join('\n')}\n`;
}

export function alignSuggestionsToManifest(suggestions, manifest = null, unresolvedTasks = [], sourceContent = '') {
  const list = Array.isArray(suggestions) ? suggestions : [];
  if (!manifest?.tasks?.length) return list.map((suggestion) => ({
    ...suggestion,
    taskId: suggestion.taskId || 'task_1', nodeId: suggestion.nodeId || '',
    usedTemplateIds: Array.isArray(suggestion.usedTemplateIds) ? suggestion.usedTemplateIds : [],
    usedCitekeys: Array.isArray(suggestion.usedCitekeys) ? suggestion.usedCitekeys : [],
  }));
  const tasks = new Map(manifest.tasks.map((task) => [task.taskId, task]));
  const seen = new Set();
  const aligned = list.map((suggestion, index) => {
    const task = tasks.get(suggestion.taskId);
    if (!task) throw Object.assign(new Error(`suggestions[${index}].taskId does not reference a manifest task`), { status: 422, code: 'AGENT_TASK_MISMATCH' });
    if (seen.has(task.taskId)) throw Object.assign(new Error(`Agent returned more than one result for task ${task.taskId}`), { status: 422, code: 'AGENT_TASK_MISMATCH' });
    seen.add(task.taskId);
    let resolvedTarget = task.target;
    if (task.target.matchMode === 'exact' && suggestion.originalText !== task.target.exactQuote) {
      throw Object.assign(new Error(`Agent originalText did not exactly match manifest task ${task.taskId}`), { status: 422, code: 'AGENT_STALE_TARGET' });
    }
    if (task.target.matchMode === 'substring-within-range') {
      const range = task.target.sourceRange;
      const scope = sourceContent.slice(range?.start || 0, range?.end ?? sourceContent.length);
      const matches = [];
      let offset = suggestion.originalText ? scope.indexOf(suggestion.originalText) : -1;
      while (offset !== -1) { matches.push(offset); offset = scope.indexOf(suggestion.originalText, offset + Math.max(1, suggestion.originalText.length)); }
      if (matches.length !== 1) throw Object.assign(new Error(`Agent originalText for manifest task ${task.taskId} was not a unique substring of its source range`), { status: 422, code: 'AGENT_STALE_TARGET' });
      const start = (range?.start || 0) + matches[0];
      resolvedTarget = { ...task.target, matchMode: 'exact', sourceRange: { start, end: start + suggestion.originalText.length }, exactQuote: suggestion.originalText, exactQuoteHash: sha256(suggestion.originalText) };
    }
    if (suggestion.nodeId && suggestion.nodeId !== task.target.nodeId) {
      throw Object.assign(new Error(`Agent nodeId did not match manifest task ${task.taskId}`), { status: 422, code: 'AGENT_TASK_MISMATCH' });
    }
    const allowedTemplates = new Set(task.templateResourceIds || []);
    const usedTemplateIds = Array.isArray(suggestion.usedTemplateIds) ? suggestion.usedTemplateIds : [];
    if (usedTemplateIds.some((id) => !allowedTemplates.has(id))) throw Object.assign(new Error(`Agent reported an unlisted template for task ${task.taskId}`), { status: 422, code: 'UNKNOWN_AGENT_RESOURCE' });
    const allowedCitekeys = new Set(task.citekeys || []);
    const usedCitekeys = Array.isArray(suggestion.usedCitekeys) ? suggestion.usedCitekeys : [];
    if (usedCitekeys.some((id) => !allowedCitekeys.has(id))) throw Object.assign(new Error(`Agent reported an unlisted citekey for task ${task.taskId}`), { status: 422, code: 'UNKNOWN_CITATION_KEY' });
    return { ...suggestion, taskId: task.taskId, nodeId: task.target.nodeId, usedTemplateIds, usedCitekeys, targetAnchor: resolvedTarget };
  });
  for (const [index, unresolved] of (Array.isArray(unresolvedTasks) ? unresolvedTasks : []).entries()) {
    if (!unresolved || typeof unresolved.taskId !== 'string' || !tasks.has(unresolved.taskId)) throw Object.assign(new Error(`unresolvedTasks[${index}].taskId does not reference a manifest task`), { status: 422, code: 'AGENT_TASK_MISMATCH' });
    if (seen.has(unresolved.taskId)) throw Object.assign(new Error(`Agent returned more than one result for task ${unresolved.taskId}`), { status: 422, code: 'AGENT_TASK_MISMATCH' });
    if (typeof unresolved.reason !== 'string' || !unresolved.reason.trim()) throw Object.assign(new Error(`unresolvedTasks[${index}].reason must be non-empty`), { status: 422, code: 'AGENT_TASK_MISMATCH' });
    seen.add(unresolved.taskId);
  }
  const missing = [...tasks.keys()].filter((taskId) => !seen.has(taskId));
  if (missing.length) throw Object.assign(new Error(`Agent omitted manifest task results: ${missing.join(', ')}`), { status: 422, code: 'AGENT_TASK_INCOMPLETE', details: { missingTaskIds: missing } });
  return aligned;
}

export async function loadPromptManifest(workspaceRoot, manifestPath) {
  if (typeof manifestPath !== 'string' || !/^\.papergod\/context\/manifests\/manifest_[a-zA-Z0-9-]+\/manifest\.json$/.test(manifestPath)) {
    throw Object.assign(new Error('Invalid Prompt Manifest path'), { status: 400, code: 'INVALID_PROMPT_MANIFEST' });
  }
  const path = sanitizePath(manifestPath, workspaceRoot);
  if (!path) throw Object.assign(new Error('Prompt Manifest path is outside the workspace'), { status: 403, code: 'INVALID_PROMPT_MANIFEST' });
  let serialized;
  try { serialized = await readFile(path, 'utf-8'); }
  catch (cause) { throw Object.assign(new Error('Prompt Manifest could not be loaded'), { status: cause.code === 'ENOENT' ? 409 : 500, code: 'PROMPT_MANIFEST_MISSING' }); }
  let manifest;
  try { manifest = JSON.parse(serialized); }
  catch { throw Object.assign(new Error('Prompt Manifest is invalid JSON'), { status: 409, code: 'INVALID_PROMPT_MANIFEST' }); }
  if (manifest?.version !== MANIFEST_VERSION || !Array.isArray(manifest.tasks) || !manifest.tasks.length) throw Object.assign(new Error('Prompt Manifest has an unsupported shape'), { status: 409, code: 'INVALID_PROMPT_MANIFEST' });
  const taskIds = manifest.tasks.map((task) => task?.taskId);
  if (taskIds.some((id) => typeof id !== 'string' || !id) || new Set(taskIds).size !== taskIds.length) throw Object.assign(new Error('Prompt Manifest task ids must be non-empty and unique'), { status: 409, code: 'INVALID_PROMPT_MANIFEST' });
  const snapshotPrefix = manifestPath.slice(0, manifestPath.lastIndexOf('/') + 1);
  for (const [resourcePath, expectedHash] of Object.entries(manifest.resources?.integrity || {})) {
    if (!resourcePath.startsWith(snapshotPrefix)) throw Object.assign(new Error('Prompt Manifest references a resource outside its immutable snapshot'), { status: 409, code: 'INVALID_PROMPT_MANIFEST' });
    const resource = sanitizePath(resourcePath, workspaceRoot);
    if (!resource) throw Object.assign(new Error('Prompt Manifest resource path is invalid'), { status: 409, code: 'INVALID_PROMPT_MANIFEST' });
    let content;
    try { content = await readFile(resource, 'utf-8'); }
    catch { throw Object.assign(new Error(`Prompt Manifest resource is missing: ${resourcePath}`), { status: 409, code: 'PROMPT_MANIFEST_RESOURCE_CHANGED' }); }
    if (sha256(content) !== expectedHash) throw Object.assign(new Error(`Prompt Manifest resource changed after preview: ${resourcePath}`), { status: 409, code: 'PROMPT_MANIFEST_RESOURCE_CHANGED' });
  }
  return { manifest, serialized };
}

export async function materializePromptManifest(workspaceRoot, input = {}) {
  const project = await loadProject(workspaceRoot);
  const document = project.documents.find((item) => item.id === input.documentId)
    || project.documents.find((item) => item.file === input.file)
    || project.documents[0];
  if (!document) throw Object.assign(new Error('Document not found for prompt manifest'), { status: 404 });
  const documentPath = sanitizePath(document.file, workspaceRoot);
  if (!documentPath) throw Object.assign(new Error('Document path is outside the workspace'), { status: 403 });
  const sourceContent = typeof input.sourceContent === 'string' ? input.sourceContent : await readFile(documentPath, 'utf-8');
  const sourceHash = sha256(sourceContent);
  const library = await materializeLibraries(workspaceRoot);
  const references = await loadReferenceState(workspaceRoot);
  const selectedResourceIds = new Set(Array.isArray(input.resourceIds) ? input.resourceIds : []);
  const unknownResourceIds = [...selectedResourceIds].filter((id) => !library.index.entries.some((entry) => entry.id === id));
  if (unknownResourceIds.length) throw Object.assign(new Error(`Unknown writing resource ids: ${unknownResourceIds.join(', ')}`), { status: 400, code: 'UNKNOWN_AGENT_RESOURCE' });
  const selectedWritingResources = library.index.entries.filter((entry) => selectedResourceIds.has(entry.id));
  const templateIds = selectedWritingResources.filter((entry) => entry.kind === 'sentence-patterns').map((entry) => entry.id);
  const intentIds = Array.isArray(input.intentIds) ? input.intentIds : [];
  if (new Set(intentIds).size !== intentIds.length) throw Object.assign(new Error('Modification intent ids must be unique'), { status: 400, code: 'DUPLICATE_MODIFICATION_INTENT' });
  const annotations = intentIds.map((id) => {
    const annotation = project.annotations.find((item) => item.id === id);
    if (!annotation) throw Object.assign(new Error(`Modification intent not found: ${id}`), { status: 404, code: 'MODIFICATION_INTENT_NOT_FOUND' });
    if (annotation.documentId !== document.id) throw Object.assign(new Error(`Modification intent ${id} belongs to another document`), { status: 409, code: 'MODIFICATION_INTENT_DOCUMENT_MISMATCH' });
    if (annotation.status !== 'open' || !annotation.source?.actor?.startsWith('pdf-intent:')) throw Object.assign(new Error(`Modification intent ${id} is not an open PDF intent`), { status: 409, code: 'MODIFICATION_INTENT_NOT_EXECUTABLE' });
    if (annotation.target?.type === 'document' && /^PDF page\b/i.test(String(annotation.target.quote || ''))) throw Object.assign(new Error(`Modification intent ${id} has only a PDF position and must be mapped to an exact source sentence before execution`), { status: 409, code: 'MODIFICATION_INTENT_UNRESOLVED' });
    return annotation;
  });
  const ensureTargetMatches = (task) => {
    const range = task.target.sourceRange;
    if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end < range.start || range.end > sourceContent.length) {
      throw Object.assign(new Error(`Manifest task ${task.taskId} has an invalid source range`), { status: 409, code: 'PROMPT_TARGET_STALE' });
    }
    if (task.target.exactQuote && sourceContent.slice(range.start, range.end) !== task.target.exactQuote) {
      throw Object.assign(new Error(`Manifest task ${task.taskId} no longer matches its exact source quote`), { status: 409, code: 'PROMPT_TARGET_STALE' });
    }
  };
  const tasks = annotations.length
    ? annotations.map((annotation, index) => taskFromTarget({ id: annotation.id || `task_${index + 1}`, document, target: annotation.target, instruction: annotation.body, resourceIds: templateIds, citekeys: input.citekeys || [], sourceHash }))
    : [taskFromTarget({ id: input.taskId || `task_${randomUUID()}`, document, target: input.target || { type: input.nodeId ? 'sentence' : 'document', id: input.nodeId || document.id, start: input.start, end: input.end, quote: input.quote }, instruction: input.instruction, fallbackQuote: input.quote, resourceIds: templateIds, citekeys: input.citekeys || [], sourceHash })];
  tasks.forEach(ensureTargetMatches);

  const manifestId = input.manifestId || `manifest_${randomUUID()}`;
  const relativeSnapshotDirectory = `${CONTEXT_DIRECTORY}/manifests/${manifestId}`;
  const snapshotDirectory = join(workspaceRoot, relativeSnapshotDirectory);
  const librarySnapshotDirectory = join(snapshotDirectory, 'library');
  await mkdir(librarySnapshotDirectory, { recursive: true });
  const structure = structureFor(document);
  structure.sourceHash = sourceHash;
  const snapshotFiles = new Map([
    [`${relativeSnapshotDirectory}/project.md`, projectMarkdown(project)],
    [`${relativeSnapshotDirectory}/document.md`, documentMarkdown(document)],
    [`${relativeSnapshotDirectory}/document-structure.json`, `${JSON.stringify(structure, null, 2)}\n`],
    [`${relativeSnapshotDirectory}/references.json`, `${JSON.stringify(references, null, 2)}\n`],
  ]);
  const libraryPathMap = new Map();
  for (const relativePath of library.paths) {
    const sourcePath = sanitizePath(relativePath, workspaceRoot);
    if (!sourcePath) continue;
    const snapshotPath = `${relativeSnapshotDirectory}/library/${basename(relativePath)}`;
    snapshotFiles.set(snapshotPath, await readFile(sourcePath, 'utf-8'));
    libraryPathMap.set(relativePath, snapshotPath);
  }
  const bibliographySource = sanitizePath(references.bibliographyFile || 'references.bib', workspaceRoot);
  let bibliography = '';
  if (bibliographySource) {
    try { bibliography = await readFile(bibliographySource, 'utf-8'); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  }
  const bibliographyPath = `${relativeSnapshotDirectory}/bibliography.bib`;
  snapshotFiles.set(bibliographyPath, bibliography);
  const snapshotWritingResources = selectedWritingResources.map((entry) => ({ ...entry, file: libraryPathMap.get(entry.file) || entry.file }));
  const snapshotLibraryFiles = library.index.files.map((entry) => {
    const originalPath = entry.file.startsWith('.papergod/') ? entry.file : `.papergod/${entry.file}`;
    return { ...entry, file: libraryPathMap.get(originalPath) || originalPath };
  });
  const libraryIndexPath = `${relativeSnapshotDirectory}/library-index.json`;
  snapshotFiles.set(libraryIndexPath, `${JSON.stringify({ files: snapshotLibraryFiles, entries: snapshotWritingResources }, null, 2)}\n`);
  await Promise.all([...snapshotFiles].map(([relativePath, content]) => writeFile(join(workspaceRoot, relativePath), content, 'utf-8')));
  const integrity = Object.fromEntries([...snapshotFiles].map(([relativePath, content]) => [relativePath, sha256(content)]));
  const manifest = {
    version: MANIFEST_VERSION,
    workspace: { root: '.', mainDocument: document.file },
    resources: {
      projectContext: `${relativeSnapshotDirectory}/project.md`,
      documentContext: `${relativeSnapshotDirectory}/document.md`,
      documentStructure: `${relativeSnapshotDirectory}/document-structure.json`,
      bibliography: bibliographyPath,
      referenceState: `${relativeSnapshotDirectory}/references.json`,
      writingLibraryIndex: libraryIndexPath,
      selectedWritingResources: snapshotWritingResources,
      sentencePatterns: `${relativeSnapshotDirectory}/library/patterns.md`,
      vocabulary: [`${relativeSnapshotDirectory}/library/vocabulary-global.md`, `${relativeSnapshotDirectory}/library/vocabulary-session.md`],
      integrity,
    },
    policy: {
      precedence: ['safety-and-output-contract', 'task-instruction', 'additional-requirements', 'document-context', 'template-reference'],
      readOnly: true, readOnlyOnDemand: true, doNotReadEveryResource: true, doNotModifyFiles: true,
      templateSafety: 'Use templates only for structure and style. Never copy factual claims, numbers, citations, or conclusions.',
      targetSafety: 'Modify only listed exact targets. Ranges use JavaScript UTF-16 source-character offsets. If exactQuote or sourceRange is stale, report the task unresolved instead of guessing.',
    },
    additionalRequirements: text(input.additionalRequirements),
    tasks,
    outputContract: { oneResultPerTask: true, allowExplicitUnresolved: true, requireTaskId: true, requireExactOriginalText: true, noUnlistedTargets: true },
  };
  const relativeManifestPath = `${relativeSnapshotDirectory}/manifest.json`;
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(workspaceRoot, relativeManifestPath), serialized, 'utf-8');
  const prompt = `You are editing a local academic LaTeX project.\n\nPrompt manifest: ${relativeManifestPath}\n\nRead the manifest first. Read only its immutable local resource snapshots needed for each task. Return exactly one result per manifest task: either one suggestion with the matching taskId and nodeId, or one unresolvedTasks entry with a non-empty reason. Obey the precedence policy, do not modify files, and return structured JSON only. For exact-match tasks, originalText must exactly match exactQuote. For substring-within-range tasks, choose one non-empty unique contiguous source substring inside sourceRange. Never guess or edit unrelated text.`;
  return { manifestId, manifestPath: relativeManifestPath, manifest, serialized, manifestHash: sha256(serialized), prompt, characterCount: prompt.length, tokenEstimate: tokenEstimate(prompt), manifestCharacterCount: serialized.length, manifestTokenEstimate: tokenEstimate(serialized) };
}
