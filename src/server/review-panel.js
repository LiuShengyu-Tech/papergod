import { createHash, randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { sanitizePath } from './security.js';
import { loadProject, updateProject } from './project-store.js';
import { createAgentRun, updateAgentRun } from './project-resources.js';
import { syncDocumentStructure } from './document-structure.js';
import { runAcademicReviewAgent } from './agent-adapters.js';
import { createRevisionPlan } from './revision-engine.js';
import { materializeLibraries } from './library-files.js';

const REVIEW_ROLES = ['methodology', 'statistics', 'writing', 'domain', 'reproducibility'];
const VERDICTS = ['accept', 'minor-revision', 'major-revision', 'reject'];
const SEVERITY_RANK = { info: 0, minor: 1, major: 2, critical: 3 };

export const REVIEWER_PROFILES = [
  { id: 'methodology', name: 'Methodology reviewer', role: 'methodology', focus: 'Research design, assumptions, validity, baselines, controls, and whether conclusions follow from the method.', prompt: '' },
  { id: 'statistics', name: 'Statistical reviewer', role: 'statistics', focus: 'Statistical design, uncertainty, effect sizes, power, multiple comparisons, and validity of quantitative claims.', prompt: '' },
  { id: 'writing', name: 'Academic writing reviewer', role: 'writing', focus: 'Clarity, structure, terminology, claim precision, academic style, and reader comprehension.', prompt: '' },
  { id: 'domain', name: 'Domain reviewer', role: 'domain', focus: 'Novelty, domain assumptions, related work, significance, and correctness from the target field perspective.', prompt: '' },
  { id: 'reproducibility', name: 'Reproducibility reviewer', role: 'reproducibility', focus: 'Data, code, parameters, environment, protocols, ablations, and information needed to reproduce results.', prompt: '' },
];

export const DEFAULT_REVIEW_RUBRIC = [
  { id: 'rigor', title: 'Technical rigor', instruction: 'Check correctness, assumptions, design, and threats to validity.', weight: 1 },
  { id: 'evidence', title: 'Evidence and claims', instruction: 'Check whether every important claim is supported and calibrated.', weight: 1 },
  { id: 'clarity', title: 'Clarity and organization', instruction: 'Check structure, definitions, precision, and readability.', weight: 0.8 },
  { id: 'reproducibility', title: 'Reproducibility', instruction: 'Check whether a competent reader could reproduce the work.', weight: 1 },
];

function now() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${randomUUID()}`; }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function problem(message, status = 400) { const error = new Error(message); error.status = status; return error; }
function clean(value) { return typeof value === 'string' ? value.trim() : ''; }

function validateReviewer(input, index) {
  const reviewer = {
    id: clean(input?.id) || id('reviewer'), name: clean(input?.name), role: clean(input?.role),
    focus: clean(input?.focus), prompt: clean(input?.prompt),
  };
  if (!reviewer.name || !reviewer.focus) throw problem(`reviewers[${index}] needs name and focus`);
  if (!REVIEW_ROLES.includes(reviewer.role)) throw problem(`reviewers[${index}].role must be one of: ${REVIEW_ROLES.join(', ')}`);
  return reviewer;
}

function validateRubric(input, index) {
  const rubric = {
    id: clean(input?.id) || id('rubric'), title: clean(input?.title), instruction: clean(input?.instruction),
    weight: typeof input?.weight === 'number' ? input.weight : 1,
  };
  if (!rubric.title || !rubric.instruction) throw problem(`rubric[${index}] needs title and instruction`);
  if (!Number.isFinite(rubric.weight) || rubric.weight <= 0 || rubric.weight > 10) throw problem(`rubric[${index}].weight must be greater than 0 and at most 10`);
  return rubric;
}

export function getReviewerProfileCatalog() {
  return { profiles: structuredClone(REVIEWER_PROFILES), defaultRubric: structuredClone(DEFAULT_REVIEW_RUBRIC), roles: [...REVIEW_ROLES] };
}

export async function listReviewRounds(workspaceRoot, documentId) {
  const reviews = (await loadProject(workspaceRoot)).reviews;
  return documentId ? reviews.filter((item) => item.documentId === documentId) : reviews;
}

export async function createReviewRound(workspaceRoot, input = {}) {
  const project = await loadProject(workspaceRoot);
  if (!project.documents.some((item) => item.id === input.documentId)) throw problem('Document not found', 404);
  const reviewers = Array.isArray(input.reviewers) ? input.reviewers.map(validateReviewer) : [];
  const rubric = Array.isArray(input.rubric) ? input.rubric.map(validateRubric) : [];
  if (!reviewers.length || reviewers.length > 8) throw problem('A review panel needs between 1 and 8 reviewers');
  if (!rubric.length || rubric.length > 20) throw problem('A review rubric needs between 1 and 20 criteria');
  if (new Set(reviewers.map((item) => item.id)).size !== reviewers.length) throw problem('Reviewer IDs must be unique');
  if (new Set(rubric.map((item) => item.id)).size !== rubric.length) throw problem('Rubric IDs must be unique');
  const timestamp = now();
  const review = {
    id: id('review'), documentId: input.documentId, name: clean(input.name) || 'Peer review round',
    status: 'draft', provider: clean(input.provider) || 'mock', reviewers, rubric,
    reports: [], items: [], synthesis: { summary: '', verdict: '', consensus: [], conflicts: [], priorities: [] },
    createdAt: timestamp, updatedAt: timestamp,
  };
  if (!['mock', 'codex', 'claude-code', 'opencode', 'pi'].includes(review.provider)) throw problem('provider must be mock, codex, claude-code, opencode, or pi');
  await updateProject(workspaceRoot, (draft) => draft.reviews.push(review));
  return review;
}

function manuscriptSentences(content) {
  return content.split(/(?<=[.!?。！？])\s+/).map((text) => text.trim()).filter((text) => text.length >= 20 && !/^\\(?:documentclass|usepackage)/.test(text));
}

function firstMatchingSentence(content, pattern) {
  return manuscriptSentences(content).find((sentence) => pattern.test(sentence)) || manuscriptSentences(content)[0] || '';
}

export function generateMockPeerReview(content, reviewer, rubric) {
  const rubricFor = (keyword, fallback = 0) => rubric.find((item) => item.id.toLowerCase().includes(keyword))?.id || rubric[fallback]?.id || rubric[0].id;
  const lower = content.toLowerCase();
  const items = [];
  const add = (value) => items.push({ id: id('review_item'), ...value });
  if (reviewer.role === 'methodology') {
    const quote = firstMatchingSentence(content, /method|approach|algorithm|模型|方法|算法/i);
    add({ rubricId: rubricFor('rigor'), kind: 'concern', category: 'method', severity: 'major', body: 'Clarify the design assumptions, comparison protocol, and threats to validity for the central method.', suggestedFix: '', quote });
    add({ rubricId: rubricFor('evidence', 1), kind: 'strength', category: 'method', severity: 'info', body: 'The manuscript exposes a recognizable methodological contribution that can be evaluated explicitly.', suggestedFix: '', quote });
  } else if (reviewer.role === 'statistics') {
    const quote = firstMatchingSentence(content, /result|accuracy|significant|%|结果|准确|显著/i);
    const hasStatistics = /confidence interval|standard deviation|p\s*[<=>]|effect size|置信区间|标准差|显著性/i.test(lower);
    add({ rubricId: rubricFor('evidence', 1), kind: 'concern', category: 'evidence', severity: hasStatistics ? 'minor' : 'major', body: hasStatistics ? 'Report the statistical procedure and sample definition consistently for every quantitative comparison.' : 'Quantitative claims need uncertainty, sample sizes, and a justified statistical comparison.', suggestedFix: '', quote });
  } else if (reviewer.role === 'writing') {
    const imprecise = content.match(/\bvery\s+(?:important|useful|good|large)\b/i);
    const quote = imprecise?.[0] || firstMatchingSentence(content, /conclusion|introduction|因此|本文|结论/i);
    add({ rubricId: rubricFor('clarity', 2), kind: 'concern', category: 'style', severity: 'minor', body: 'Replace broad evaluative wording with a precise claim tied to the reported evidence.', suggestedFix: imprecise ? 'substantial' : '', quote });
  } else if (reviewer.role === 'domain') {
    const quote = firstMatchingSentence(content, /we (?:propose|present|show)|本文|我们提出|贡献/i);
    add({ rubricId: rubricFor('evidence', 1), kind: 'concern', category: 'citation', severity: 'major', body: 'Position the central novelty against the closest domain-specific alternatives and state the practical boundary of the contribution.', suggestedFix: '', quote });
  } else {
    const quote = firstMatchingSentence(content, /experiment|implementation|dataset|实验|实现|数据/i);
    const reproducible = /github|repository|code|seed|dataset|parameter|代码|仓库|随机种子|数据集|参数/i.test(lower);
    add({ rubricId: rubricFor('reproducibility', 3), kind: 'concern', category: 'method', severity: reproducible ? 'minor' : 'major', body: reproducible ? 'Consolidate implementation details, versions, seeds, and data access instructions into a reproducibility checklist.' : 'Add code/data availability, parameter settings, environment versions, random seeds, and an executable reproduction protocol.', suggestedFix: '', quote });
  }
  const major = items.some((item) => SEVERITY_RANK[item.severity] >= SEVERITY_RANK.major && item.kind === 'concern');
  return { summary: `${reviewer.name} identified ${items.filter((item) => item.kind === 'concern').length} actionable concern(s) from the ${reviewer.role} perspective.`, verdict: major ? 'major-revision' : 'minor-revision', confidence: 0.78, items };
}

function normalizeItem(item, reviewerId) {
  return { ...item, id: item.id || id('review_item'), reviewerId };
}

function tokens(value) { return new Set(String(value || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []); }
function similarity(left, right) {
  const a = tokens(left); const b = tokens(right); if (!a.size || !b.size) return 0;
  let shared = 0; a.forEach((token) => { if (b.has(token)) shared += 1; });
  return shared / Math.min(a.size, b.size);
}

export function synthesizePeerReviews(reports) {
  const items = reports.flatMap((report) => report.items || []);
  const groups = [];
  for (const item of items) {
    const group = groups.find((candidate) => candidate.category === item.category
      && ((item.quote && candidate.quote === item.quote) || similarity(candidate.body, item.body) >= 0.34));
    if (group) { group.items.push(item); group.reviewerIds.add(item.reviewerId); }
    else groups.push({ category: item.category, quote: item.quote, body: item.body, items: [item], reviewerIds: new Set([item.reviewerId]) });
  }
  const consensus = groups.filter((group) => group.reviewerIds.size >= 2 && group.items.every((item) => item.kind === group.items[0].kind)).map((group) => ({
    id: id('consensus'), kind: group.items[0].kind, category: group.category, body: group.body,
    itemIds: group.items.map((item) => item.id), reviewerIds: [...group.reviewerIds],
  }));
  const conflicts = groups.filter((group) => new Set(group.items.map((item) => item.kind)).size > 1
    || new Set(group.items.map((item) => item.suggestedFix).filter(Boolean)).size > 1).map((group) => ({
    id: id('conflict'), category: group.category, quote: group.quote,
    description: 'Reviewers disagree on the assessment or proposed resolution for the same manuscript area.',
    itemIds: group.items.map((item) => item.id), reviewerIds: [...group.reviewerIds],
  }));
  const priorities = items.filter((item) => item.kind === 'concern').sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]).slice(0, 12).map((item) => item.id);
  const verdictCounts = Object.fromEntries(VERDICTS.map((verdict) => [verdict, reports.filter((report) => report.verdict === verdict).length]));
  const verdict = [...VERDICTS].reverse().find((candidate) => verdictCounts[candidate]) || 'accept';
  return {
    summary: `${reports.length} independent report(s), ${items.length} finding(s), ${consensus.length} consensus cluster(s), and ${conflicts.length} conflict(s).`,
    verdict, consensus, conflicts, priorities,
  };
}

async function runOneReviewer(workspaceRoot, provider, content, reviewer, rubric, options, file = '') {
  const startedAt = now();
  const run = await createAgentRun(workspaceRoot, {
    provider, operation: 'peer-review', status: provider === 'mock' ? 'queued' : 'running',
    prompt: JSON.stringify({ reviewer, rubric }), input: JSON.stringify({ characters: content.length, reviewerId: reviewer.id }),
    output: '', error: '', startedAt, finishedAt: '',
  });
  try {
    const result = provider === 'mock' ? generateMockPeerReview(content, reviewer, rubric)
      : await runAcademicReviewAgent(provider, {
        content, reviewer, rubric,
        workspace: file ? { file, start: 0, end: content.length } : null,
      }, options);
    const report = {
      id: id('review_report'), reviewerId: reviewer.id, runId: run.id, status: 'complete',
      summary: result.summary, verdict: result.verdict, confidence: result.confidence,
      items: result.items.map((item) => normalizeItem(item, reviewer.id)), error: '', createdAt: now(),
    };
    await updateAgentRun(workspaceRoot, run.id, { status: 'complete', output: JSON.stringify(result), finishedAt: now() });
    return report;
  } catch (error) {
    await updateAgentRun(workspaceRoot, run.id, { status: 'failed', error: error.message.slice(0, 4000), finishedAt: now() });
    return { id: id('review_report'), reviewerId: reviewer.id, runId: run.id, status: 'failed', summary: '', verdict: 'reject', confidence: 0, items: [], error: error.message.slice(0, 4000), createdAt: now() };
  }
}

export async function runReviewRound(workspaceRoot, reviewId, options = {}) {
  let project = await loadProject(workspaceRoot);
  let review = project.reviews.find((item) => item.id === reviewId);
  if (!review) throw problem('Review round not found', 404);
  if (review.status === 'running') throw problem('Review round is already running', 409);
  const document = project.documents.find((item) => item.id === review.documentId);
  if (!document) throw problem('Document not found', 404);
  await syncDocumentStructure(workspaceRoot, document.file);
  project = await loadProject(workspaceRoot);
  review = project.reviews.find((item) => item.id === reviewId);
  const currentDocument = project.documents.find((item) => item.id === review.documentId);
  const file = sanitizePath(currentDocument.file, workspaceRoot);
  if (!file) throw problem('Access denied', 403);
  const content = await readFile(file, 'utf-8');
  if (currentDocument.sourceHash !== hash(content)) throw problem('Document structure is stale', 409);
  await updateProject(workspaceRoot, (draft) => {
    const current = draft.reviews.find((item) => item.id === reviewId);
    current.status = 'running'; current.reports = []; current.items = [];
    current.synthesis = { summary: '', verdict: '', consensus: [], conflicts: [], priorities: [] }; current.updatedAt = now();
  });
  const controller = new AbortController();
  options.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  if (review.provider !== 'mock') await materializeLibraries(workspaceRoot);
  const reports = await Promise.all(review.reviewers.map((reviewer) => runOneReviewer(workspaceRoot, review.provider, content, reviewer, review.rubric, {
    workspaceRoot, commands: options.commands || {}, signal: controller.signal,
  }, currentDocument.file)));
  const successful = reports.filter((report) => report.status === 'complete');
  const synthesis = synthesizePeerReviews(successful);
  const { result } = await updateProject(workspaceRoot, (draft) => {
    const current = draft.reviews.find((item) => item.id === reviewId);
    current.status = successful.length ? 'complete' : 'failed'; current.reports = reports;
    current.items = successful.flatMap((report) => report.items); current.synthesis = synthesis; current.updatedAt = now();
    return structuredClone(current);
  });
  return result;
}

function flattenNodes(document) {
  const nodes = [];
  const visit = (items) => (items || []).forEach((node) => { nodes.push(node); visit(node.children); });
  visit(document.sections); return nodes;
}

function targetForItem(document, content, item) {
  if (!item.quote) return { type: 'document', id: document.id, start: 0, end: 0, quote: '' };
  const start = content.indexOf(item.quote); const end = start < 0 ? 0 : start + item.quote.length;
  const node = start < 0 ? null : flattenNodes(document).filter((candidate) => candidate.sourceRange?.start <= start && candidate.sourceRange?.end >= end)
    .sort((a, b) => (a.sourceRange.end - a.sourceRange.start) - (b.sourceRange.end - b.sourceRange.start))[0];
  return { type: start < 0 ? 'document' : 'range', id: node?.id || document.id, start: Math.max(0, start), end, quote: start < 0 ? '' : item.quote };
}

export async function sendReviewItemsToRevision(workspaceRoot, reviewId, itemIds, title = '') {
  const project = await loadProject(workspaceRoot);
  const review = project.reviews.find((item) => item.id === reviewId);
  if (!review) throw problem('Review round not found', 404);
  if (review.status !== 'complete') throw problem('Only a completed review can enter revision planning', 409);
  const selectedIds = Array.isArray(itemIds) && itemIds.length ? itemIds : review.synthesis.priorities;
  const selected = review.items.filter((item) => selectedIds.includes(item.id) && item.kind === 'concern');
  if (!selected.length) throw problem('Select at least one concern');
  const document = project.documents.find((item) => item.id === review.documentId);
  const file = sanitizePath(document.file, workspaceRoot); if (!file) throw problem('Access denied', 403);
  const content = await readFile(file, 'utf-8');
  const timestamp = now();
  const annotations = selected.map((item, index) => ({
    id: id('annotation'), documentId: document.id, order: index + 1, target: targetForItem(document, content, item),
    category: item.category, severity: item.severity, body: item.body, suggestedFix: item.suggestedFix,
    status: 'open', source: { type: 'reviewer', actor: review.reviewers.find((reviewer) => reviewer.id === item.reviewerId)?.name || item.reviewerId },
    createdAt: timestamp, updatedAt: timestamp,
  }));
  await updateProject(workspaceRoot, (draft) => draft.annotations.push(...annotations));
  const revision = await createRevisionPlan(workspaceRoot, {
    documentId: document.id, annotationIds: annotations.map((item) => item.id), title: clean(title) || `${review.name} revision`,
  });
  return { annotations, revision };
}
