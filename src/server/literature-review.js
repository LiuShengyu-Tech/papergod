import { randomUUID } from 'crypto';
import { loadReferenceState } from './references.js';
import { createAgentRun, updateAgentRun } from './project-resources.js';
import { runWritingAgent } from './agent-adapters.js';

const MAX_CITEKEYS = 30;
const SENTINEL = '[[PAPERGOD_LITERATURE_REVIEW]]';

function now() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${randomUUID()}`; }
function clean(value) { return typeof value === 'string' ? value.trim() : ''; }
function problem(message, status = 400, code = '') {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function authorLabel(item) {
  const authors = Array.isArray(item.authors) ? item.authors.filter(Boolean) : [];
  if (!authors.length) return 'Unknown authors';
  if (authors.length === 1) return authors[0];
  if (authors.length === 2) return `${authors[0]} and ${authors[1]}`;
  return `${authors[0]} et al.`;
}

function titleKeywords(title) {
  return String(title || '')
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3 && !/^(the|and|for|with|from|into|over|under|about|between|their|this|that)$/i.test(word))
    .slice(0, 4)
    .join(' ');
}

export function composeMockLiteratureReview(items, prompt = '') {
  const goal = clean(prompt) || 'the related work';
  const sentences = [];
  sentences.push(`A body of prior work has examined ${goal}, with each study contributing a distinct perspective (${items.map((item) => `\\citep{${item.citekey}}`).join(', ')}).`);
  items.forEach((item, index) => {
    const topic = titleKeywords(item.title) || 'the central problem';
    const connector = index === items.length - 1 ? 'Finally' : index === 0 ? 'In particular' : 'Additionally';
    sentences.push(`${connector}, ${authorLabel(item)} (${item.year || 'n.d.'}) investigated ${topic} and reported findings that bear directly on the questions addressed here (\\citep{${item.citekey}}).`);
  });
  sentences.push(`Taken together, these studies motivate the present work, which builds on their evidence while addressing the gaps they leave open.`);
  return {
    draft: sentences.join(' '),
    note: 'Mock review is generated deterministically from bibliographic metadata (authors, year, title keywords). For substantive synthesis, run the same request with a configured external Agent.',
  };
}

function buildBibliography(items) {
  return items.map((item, index) => {
    const parts = [
      `${index + 1}. ${authorLabel(item)} (${item.year || 'n.d.'}).`,
      item.title ? ` ${item.title}.` : '',
      item.venue ? ` ${item.venue}.` : '',
      ` [citekey: ${item.citekey}]`,
    ];
    if (item.abstract) parts.push(` Abstract: ${String(item.abstract).slice(0, 400)}`);
    return parts.join('');
  }).join('\n');
}

function buildExternalPrompt(bibliography, prompt) {
  return `You are writing a literature review paragraph for an academic paper. Use only the references supplied below. Cite each relevant reference at least once with \\citep{citekey}. Write 3–6 sentences that synthesize the literature into coherent themes rather than listing entries one by one. Return exactly one suggestion that replaces the entire text ${SENTINEL} with the review paragraph, keeping every citekey that you actually use inside \\citep{...}.

Author instruction:
${clean(prompt) || 'Synthesize the supplied references into one review paragraph.'}

References:
${bibliography}`;
}

export async function generateLiteratureReview(workspaceRoot, input = {}, options = {}) {
  const citekeys = Array.isArray(input.citekeys) ? input.citekeys.filter((key) => typeof key === 'string' && key.trim()) : [];
  if (!citekeys.length) throw problem('Select at least one reference');
  if (citekeys.length > MAX_CITEKEYS) throw problem(`Select at most ${MAX_CITEKEYS} references`);
  if (new Set(citekeys).size !== citekeys.length) throw problem('citekeys must not contain duplicates');
  const state = await loadReferenceState(workspaceRoot);
  const items = citekeys.map((key) => state.items.find((item) => item.citekey === key)).filter(Boolean);
  const missing = citekeys.filter((key) => !items.some((item) => item.citekey === key));
  if (missing.length) throw problem(`References not found in the library: ${missing.join(', ')}`, 404);
  const prompt = clean(input.prompt);
  const provider = options.provider || 'mock';
  const bibliography = buildBibliography(items);
  const startedAt = now();
  const run = await createAgentRun(workspaceRoot, {
    provider, operation: 'literature-review', status: provider === 'mock' ? 'queued' : 'running',
    prompt: prompt || 'Synthesize the selected references into a review paragraph.',
    input: JSON.stringify({ citekeys, characters: bibliography.length }), output: '', error: '', startedAt, finishedAt: '',
  });
  try {
    let draft;
    let note = '';
    if (provider === 'mock') {
      const composed = composeMockLiteratureReview(items, prompt);
      draft = composed.draft;
      note = composed.note;
    } else {
      const result = await runWritingAgent(provider, {
        content: SENTINEL,
        prompt: buildExternalPrompt(bibliography, prompt),
        resourceContext: '', resourceIds: [],
      }, { workspaceRoot, commands: options.commands || {}, signal: options.signal });
      const proposal = result.suggestions?.find((item) => item.originalText === SENTINEL) || result.suggestions?.[0];
      if (!proposal?.suggestedText?.trim()) throw problem('Agent did not return a review paragraph', 502);
      draft = proposal.suggestedText;
    }
    const finishedAt = now();
    await updateAgentRun(workspaceRoot, run.id, {
      status: 'complete', output: JSON.stringify({ summary: draft.slice(0, 200), characters: draft.length }), finishedAt,
    });
    return {
      runId: run.id, provider, draft, note, citekeys: items.map((item) => item.citekey),
      bibliography: items.map((item) => ({ citekey: item.citekey, title: item.title, authors: item.authors, year: item.year })),
    };
  } catch (error) {
    await updateAgentRun(workspaceRoot, run.id, { status: 'failed', error: String(error?.message || 'Literature review failed').slice(0, 4000), finishedAt: now() });
    throw error;
  }
}
