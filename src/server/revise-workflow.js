import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { compile } from './latex.js';
import { sanitizePath } from './security.js';
import { loadProject, updateProject } from './project-store.js';
import { createAgentRun, updateAgentRun } from './project-resources.js';
import { syncDocumentStructure } from './document-structure.js';
import { buildLibraryContext, composeMockParagraph } from './library-engine.js';
import { runPaperGenerationAgent, validatePaperGenerationResponse } from './agent-adapters.js';

function now() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${randomUUID()}`; }
function problem(message, status = 400) { const error = new Error(message); error.status = status; return error; }
function clean(value) { return typeof value === 'string' ? value.trim() : ''; }

function targetLocation(target = {}) {
  if (target.type === 'range') return `characters ${target.start}–${target.end}`;
  return target.type || 'document';
}

function decisionForAnnotation(revision, annotationId) {
  return revision.changes.find((change) => change.annotationId === annotationId);
}

export function buildRevisionPackage(revision, annotations) {
  const related = revision.annotationIds.map((annotationId) => annotations.find((item) => item.id === annotationId)).filter(Boolean);
  const items = related.map((annotation, index) => {
    const change = decisionForAnnotation(revision, annotation.id);
    const status = change?.status || annotation.status;
    let response;
    if (['applied', 'accepted'].includes(status)) {
      response = change?.after
        ? `We addressed this comment by revising “${change.before}” to “${change.after}”.`
        : 'We addressed this comment in the revised manuscript.';
    } else if (status === 'rejected') response = 'We respectfully did not make this change; the rationale should be completed by the author.';
    else if (status === 'deferred') response = 'This comment is deferred and remains to be addressed.';
    else response = 'This comment remains open and requires an author response.';
    return {
      annotationId: annotation.id, order: annotation.order || index + 1, opinion: annotation.body,
      response, status, location: targetLocation(annotation.target),
    };
  });
  const changeList = revision.changes.map((change, index) => ({
    changeId: change.id, annotationId: change.annotationId || '', order: index + 1, status: change.status,
    location: targetLocation(change.target), before: change.before, after: change.after, reason: change.reason,
  }));
  return {
    responseLetter: {
      title: `Response to comments — ${revision.title}`,
      introduction: 'We thank the reviewers for their constructive feedback. Responses and manuscript changes are listed point by point below.',
      items,
    },
    changeList,
  };
}

export async function generateRevisionPackage(workspaceRoot, revisionId) {
  const { result } = await updateProject(workspaceRoot, (project) => {
    const revision = project.revisions.find((item) => item.id === revisionId);
    if (!revision) throw problem('Revision not found', 404);
    const generated = buildRevisionPackage(revision, project.annotations);
    if (revision.responseLetter) {
      generated.responseLetter.introduction = revision.responseLetter.introduction;
      const priorResponses = new Map(revision.responseLetter.items.map((item) => [item.annotationId, item.response]));
      generated.responseLetter.items.forEach((item) => {
        if (priorResponses.has(item.annotationId)) item.response = priorResponses.get(item.annotationId);
      });
    }
    revision.responseLetter = generated.responseLetter;
    revision.changeList = generated.changeList;
    revision.updatedAt = now();
    return { revision: structuredClone(revision), ...structuredClone(generated) };
  });
  return result;
}

export async function updateRevisionResponseLetter(workspaceRoot, revisionId, input = {}) {
  const { result } = await updateProject(workspaceRoot, (project) => {
    const revision = project.revisions.find((item) => item.id === revisionId);
    if (!revision) throw problem('Revision not found', 404);
    if (!revision.responseLetter) throw problem('Generate a response letter first', 409);
    if (input.introduction !== undefined) {
      if (typeof input.introduction !== 'string') throw problem('introduction must be a string');
      revision.responseLetter.introduction = input.introduction;
    }
    if (Array.isArray(input.items)) {
      for (const patch of input.items) {
        const item = revision.responseLetter.items.find((candidate) => candidate.annotationId === patch.annotationId);
        if (!item) throw problem(`Response item not found: ${patch.annotationId}`, 404);
        if (typeof patch.response !== 'string' || !patch.response.trim()) throw problem('Each response must be non-empty');
        item.response = patch.response;
      }
    }
    revision.updatedAt = now();
    return structuredClone(revision.responseLetter);
  });
  return result;
}

export async function verifyAppliedRevision(workspaceRoot, revisionId) {
  const project = await loadProject(workspaceRoot);
  const revision = project.revisions.find((item) => item.id === revisionId);
  if (!revision) throw problem('Revision not found', 404);
  if (revision.status !== 'applied') throw problem('Apply the revision before verification', 409);
  const document = project.documents.find((item) => item.id === revision.documentId);
  const file = sanitizePath(document.file, workspaceRoot);
  if (!file) throw problem('Access denied', 403);
  const compileResult = await compile(file, workspaceRoot);
  const refreshed = await loadProject(workspaceRoot);
  const unresolved = refreshed.annotations.filter((item) => item.documentId === document.id && !['resolved', 'rejected'].includes(item.status));
  const verification = {
    checkedAt: now(), compile: {
      ok: compileResult.ok, engine: compileResult.engine || '', error: compileResult.ok ? '' : String(compileResult.error || '').slice(0, 4000),
    },
    unresolvedAnnotationIds: unresolved.map((item) => item.id),
    complete: Boolean(compileResult.ok && unresolved.length === 0),
  };
  await updateProject(workspaceRoot, (draft) => {
    const current = draft.revisions.find((item) => item.id === revisionId);
    current.verification = verification; current.updatedAt = now();
  });
  return { verification, unresolved };
}

function escapeLatex(value) {
  return String(value || '').replace(/\\/g, '\\textbackslash{}').replace(/([#$%&_{}])/g, '\\$1').replace(/~/g, '\\textasciitilde{}').replace(/\^/g, '\\textasciicircum{}');
}

function outlineContext(document) {
  const lines = [];
  for (const section of document.sections || []) {
    lines.push(`SECTION: ${section.title}\nSummary: ${section.summary || ''}\nPrompt: ${section.prompt || ''}`);
    for (const [index, paragraph] of (section.children || []).entries()) {
      lines.push(`  PARAGRAPH ${index + 1}: ${paragraph.summary || ''}\n  Prompt: ${paragraph.prompt || ''}`);
      for (const sentence of paragraph.children || []) if (sentence.intent) lines.push(`    Sentence intent: ${sentence.intent}`);
    }
  }
  return lines.join('\n');
}

export function composeMockPaper(project, document, libraries, libraryContext, instruction) {
  const title = document.title || project.name || 'Generated Paper';
  const sections = document.sections?.length ? document.sections : [
    { title: 'Introduction', prompt: 'Present the problem, gap, and contributions.', children: [] },
    { title: 'Methods', prompt: 'Describe the method and assumptions.', children: [] },
    { title: 'Results', prompt: 'Report evidence and calibrated findings.', children: [] },
    { title: 'Conclusion', prompt: 'Summarize contributions, limitations, and future work.', children: [] },
  ];
  const used = new Set();
  const sectionLatex = sections.map((section) => {
    const paragraphPrompts = section.children?.length
      ? section.children.map((paragraph) => paragraph.prompt || paragraph.summary || paragraph.text)
      : [section.prompt || section.summary || `Develop the ${section.title} section.`];
    const paragraphs = paragraphPrompts.map((prompt) => {
      const composed = composeMockParagraph(libraries, libraryContext, [instruction, prompt].filter(Boolean).join(' '));
      composed.usedResourceIds.forEach((resourceId) => used.add(resourceId));
      return escapeLatex(composed.draft);
    });
    return `\\section{${escapeLatex(section.title)}}\n${paragraphs.join('\n\n')}`;
  }).join('\n\n');
  const abstractGoal = clean(document.corePrompt) || clean(project.corePrompt) || clean(instruction) || 'Summarize the research problem, approach, evidence, and contribution.';
  const latex = `\\documentclass{article}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath}
\\title{${escapeLatex(title)}}
\\author{}
\\date{}

\\begin{document}
\\maketitle

\\begin{abstract}
${escapeLatex(`Draft objective: ${abstractGoal}`)}
\\end{abstract}

${sectionLatex}

\\end{document}
`;
  return { summary: `Generated a complete draft with ${sections.length} section(s) from the structured writing context.`, latex, usedResourceIds: [...used] };
}

export async function generatePaperRevision(workspaceRoot, input = {}, options = {}) {
  let project = await loadProject(workspaceRoot);
  const document = project.documents.find((item) => item.id === input.documentId);
  if (!document) throw problem('Document not found', 404);
  await syncDocumentStructure(workspaceRoot, document.file);
  project = await loadProject(workspaceRoot);
  const currentDocument = project.documents.find((item) => item.id === input.documentId);
  const file = sanitizePath(currentDocument.file, workspaceRoot);
  if (!file) throw problem('Access denied', 403);
  const original = await readFile(file, 'utf-8');
  const instruction = clean(input.instruction);
  if (!instruction && !clean(project.project.corePrompt) && !clean(currentDocument.corePrompt)) throw problem('Add a generation instruction or a core prompt');
  const libraryContext = buildLibraryContext(project.libraries, {
    query: [instruction, project.project.corePrompt, currentDocument.corePrompt].filter(Boolean).join(' '),
    resourceIds: Array.isArray(input.resourceIds) ? input.resourceIds : [],
  });
  const provider = options.provider || 'mock';
  const startedAt = now();
  const run = await createAgentRun(workspaceRoot, {
    provider, operation: 'generate-paper', status: provider === 'mock' ? 'queued' : 'running', prompt: instruction,
    input: JSON.stringify({ documentId: currentDocument.id, providedResources: libraryContext.resources }), output: '', error: '', startedAt, finishedAt: '',
  });
  try {
    const request = {
      instruction,
      projectContext: `Project prompt: ${project.project.corePrompt}\nDocument prompt: ${currentDocument.corePrompt}\nDocument summary: ${currentDocument.summary}`,
      outlineContext: outlineContext(currentDocument), resourceContext: libraryContext.prompt, resourceIds: libraryContext.resourceIds,
    };
    const generated = provider === 'mock'
      ? composeMockPaper(project.project, currentDocument, project.libraries, libraryContext, instruction)
      : await runPaperGenerationAgent(provider, request, { workspaceRoot, commands: options.commands || {}, signal: options.signal });
    const validation = validatePaperGenerationResponse(generated, libraryContext.resourceIds);
    if (!validation.ok) throw problem(`Generated paper failed validation: ${validation.errors.join('; ')}`, 502);
    await updateAgentRun(workspaceRoot, run.id, { status: 'complete', output: JSON.stringify({ summary: generated.summary, usedResourceIds: generated.usedResourceIds, characters: generated.latex.length }), finishedAt: now() });
    const timestamp = now();
    const changeId = id('change');
    const revision = {
      id: id('revision'), documentId: currentDocument.id, file: currentDocument.file,
      title: clean(input.title) || 'Generated full-paper draft', summary: generated.summary, status: 'review', annotationIds: [],
      changes: [{
        id: changeId, target: { type: 'range', id: currentDocument.id, start: 0, end: original.length, quote: original },
        before: original, after: generated.latex, reason: 'Generate a complete paper from the project prompt, structured outline, element prompts, and writing libraries.',
        status: 'proposed', executable: original !== generated.latex, dependsOn: [], conflictsWith: [],
      }],
      graph: { nodes: [changeId], edges: [] }, recoveryPoint: null, origin: 'paper-generation',
      generation: { runId: run.id, instruction, providedResourceIds: libraryContext.resourceIds, usedResourceIds: generated.usedResourceIds },
      createdAt: timestamp, updatedAt: timestamp,
    };
    await updateProject(workspaceRoot, (draft) => draft.revisions.push(revision));
    return { revision, draft: generated.latex, runId: run.id, library: { mode: libraryContext.mode, providedResources: libraryContext.resources, usedResourceIds: generated.usedResourceIds } };
  } catch (error) {
    await updateAgentRun(workspaceRoot, run.id, { status: 'failed', error: error.message.slice(0, 4000), finishedAt: now() });
    throw error;
  }
}

export async function getWorkflowHistory(workspaceRoot, documentId) {
  const project = await loadProject(workspaceRoot);
  const events = [
    ...project.revisions.filter((item) => !documentId || item.documentId === documentId).map((item) => ({ id: item.id, type: 'revision', status: item.status, title: item.title, at: item.updatedAt, detail: item.summary })),
    ...project.reviews.filter((item) => !documentId || item.documentId === documentId).map((item) => ({ id: item.id, type: 'peer-review', status: item.status, title: item.name, at: item.updatedAt, detail: item.synthesis?.summary || '' })),
    ...project.agentRuns.map((item) => ({ id: item.id, type: 'agent-run', status: item.status, title: `${item.provider} · ${item.operation}`, at: item.updatedAt, detail: item.error || '' })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  return events;
}

function responseLetterMarkdown(revision) {
  const letter = revision.responseLetter;
  if (!letter) return '';
  return `# ${letter.title}\n\n${letter.introduction}\n\n${letter.items.map((item) => `## Comment ${item.order}\n\n> ${item.opinion}\n\n**Response (${item.status}, ${item.location}):** ${item.response}`).join('\n\n')}`;
}

function changeListMarkdown(revision) {
  const list = revision.changeList || buildRevisionPackage(revision, []).changeList;
  return `# Change list — ${revision.title}\n\n${list.map((item) => `## Change ${item.order} — ${item.status}\n\n- Location: ${item.location}\n- Reason: ${item.reason}\n- Before: ${item.before || '(none)'}\n- After: ${item.after || '(none)'}`).join('\n\n')}`;
}

export async function buildWorkflowExport(workspaceRoot, documentId) {
  const project = await loadProject(workspaceRoot);
  const document = project.documents.find((item) => item.id === documentId);
  if (!document) throw problem('Document not found', 404);
  const file = sanitizePath(document.file, workspaceRoot); if (!file) throw problem('Access denied', 403);
  const revisions = project.revisions.filter((item) => item.documentId === documentId);
  return {
    exportedAt: now(), project: project.project, document, source: await readFile(file, 'utf-8'),
    annotations: project.annotations.filter((item) => item.documentId === documentId),
    reviews: project.reviews.filter((item) => item.documentId === documentId), revisions,
    agentRuns: project.agentRuns,
    history: await getWorkflowHistory(workspaceRoot, documentId),
    artifacts: revisions.map((revision) => ({
      revisionId: revision.id, responseLetterMarkdown: responseLetterMarkdown(revision), changeListMarkdown: changeListMarkdown(revision),
      recoveryPoint: revision.recoveryPoint,
    })),
  };
}
