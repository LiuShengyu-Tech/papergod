import { randomUUID } from 'crypto';
import { createAgentRun, updateAgentRun } from './project-resources.js';
import { runWritingAgent } from './agent-adapters.js';

const MAX_TEXT_CHARS = 2_000_000;
const MAX_CANDIDATES = 16;
const SENTINEL = '[[PAPERGOD_PATTERN_EXTRACTION]]';

const ACADEMIC_PATTERN = /\b(we (propose|show|demonstrate|present|introduce|develop|provide|examine|investigate|consider|find|report|observe|argue|hypothesize|conclude|explore|evaluate|compare|analyse|analyze|design|implement|establish|highlight|emphasize|suggest)|it (is|has been|was) (shown|found|demonstrated|observed|reported)|can be used to|plays (a|an) (key|important|crucial|central|significant) role|has been (widely|extensively|successfully) (used|studied|applied|adopted)|is one of the most|the results (indicate|suggest|show|demonstrate)|this (suggests|indicates|implies) that|our (results|findings|experiments|analysis|approach|method|framework|model)|in this (paper|work|study|article|section)|a wide range of|of particular interest|we (thus|therefore|consequently)|as a result,|in contrast,|compared with|consistent with|in addition,|furthermore,|moreover,|nevertheless,|on the other hand)\b/i;

function now() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${randomUUID()}`; }
function clean(value) { return typeof value === 'string' ? value.trim() : ''; }
function problem(message, status = 400, code = '') {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function cleanPlainText(text) {
  return String(text || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitSentences(text) {
  return cleanPlainText(text)
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 30 && sentence.length <= 450);
}

function generalizeTemplate(sentence) {
  let template = sentence;
  let slotIndex = 0;
  const slotify = (hint) => { slotIndex += 1; return `{slot${slotIndex}}`; };
  template = template.replace(/\(([^)]*)\)/g, (_match, inner) => slotify(clean(inner).slice(0, 60)));
  template = template.replace(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}\b/g, (word) => slotify(word));
  template = template.replace(/\b\d+(?:[.,]\d+)+\b/g, () => slotify('number'));
  template = template.replace(/\b\d+\b/g, () => slotify('number'));
  template = template.replace(/['"“”‘’]/g, '');
  return clean(template);
}

function detectSlots(template) {
  return [...template.matchAll(/\{([a-zA-Z][\w-]*)\}/g)]
    .map((match) => match[1])
    .filter((name, index, names) => names.indexOf(name) === index)
    .map((name) => ({ name, description: 'Replace with the concrete expression from your own writing', required: true }));
}

export function composeMockTextCandidates(text, source) {
  const sentences = splitSentences(text);
  const patterns = [];
  for (const sentence of sentences) {
    if (!ACADEMIC_PATTERN.test(sentence)) continue;
    const template = generalizeTemplate(sentence);
    if (!template) continue;
    const slots = detectSlots(template);
    patterns.push({
      kind: 'sentence-patterns',
      value: {
        name: `PDF pattern ${patterns.length + 1}`,
        template,
        description: 'Reusable academic pattern extracted from a PDF by deterministic rules (academic framing phrase + slot generalization).',
        tags: ['extracted', 'pdf'],
        sectionTypes: [],
        slots,
        source,
      },
    });
    if (patterns.length >= MAX_CANDIDATES) break;
  }
  return { patterns, vocabulary: [] };
}

function buildExternalPrompt(text, prompt, source) {
  return `You are extracting reusable academic sentence patterns from a research PDF. Use only the supplied text. Return a list of suggestions where each suggestion has: originalText = one exact sentence from the text, suggestedText = a generalized template with concrete entities replaced by {slot1}, {slot2}, ... and description = when a writer should use this pattern. Prefer sentences with academic framing phrases (we propose, it has been shown, plays a key role, the results indicate, etc.). Extract ${MAX_CANDIDATES} patterns or fewer. Return exactly one suggestion that replaces the entire text ${SENTINEL} with the JSON array of {originalText, suggestedText, description} entries.

Additional instruction: ${prompt || 'Focus on framing and transition patterns that are widely reusable.'}

Source: ${source}

Document text:
<document>
${text.slice(0, 400_000)}
</document>`;
}

export async function extractTextCandidates(workspaceRoot, input = {}, options = {}) {
  const text = typeof input.text === 'string' ? input.text : '';
  if (!text.trim()) throw problem('PDF text is required');
  if (text.length > MAX_TEXT_CHARS) throw problem(`PDF text exceeds ${MAX_TEXT_CHARS} characters`);
  const source = clean(input.source) || 'PDF document';
  const provider = options.provider || 'mock';
  if (provider === 'mock') {
    const candidates = composeMockTextCandidates(text, source);
    return { candidates, provider, note: 'Mock extraction uses deterministic rules; for higher-quality patterns run with a configured external Agent.' };
  }
  const startedAt = now();
  const run = await createAgentRun(workspaceRoot, {
    provider, operation: 'extract-patterns', status: 'running', prompt: input.prompt || 'Extract reusable academic sentence patterns.',
    input: JSON.stringify({ source, characters: text.length }), output: '', error: '', startedAt, finishedAt: '',
  });
  try {
    const result = await runWritingAgent(provider, {
      content: SENTINEL,
      prompt: buildExternalPrompt(text, input.prompt, source),
      resourceContext: '', resourceIds: [],
    }, { workspaceRoot, commands: options.commands || {}, signal: options.signal });
    const proposal = result.suggestions?.find((item) => item.originalText === SENTINEL) || result.suggestions?.[0];
    if (!proposal?.suggestedText?.trim()) throw problem('Agent did not return extracted patterns', 502);
    let entries = [];
    try {
      const parsed = JSON.parse(proposal.suggestedText);
      entries = Array.isArray(parsed) ? parsed : [];
    } catch {
      const fence = proposal.suggestedText.match(/```(?:json)?\s*([\s\S]*?)```/i);
      try { entries = JSON.parse(fence?.[1] || proposal.suggestedText); } catch { entries = []; }
    }
    const patterns = entries.slice(0, MAX_CANDIDATES).map((entry, index) => {
      const template = clean(entry.suggestedText || entry.template || '');
      const original = clean(entry.originalText || '');
      if (!template) return null;
      const slots = detectSlots(template);
      return {
        kind: 'sentence-patterns',
        value: {
          name: `PDF pattern ${index + 1}`,
          template,
          description: clean(entry.description) || `Extracted from ${source}${original ? ` — original: ${original.slice(0, 160)}` : ''}`,
          tags: ['extracted', 'pdf'],
          sectionTypes: [],
          slots,
          source,
        },
      };
    }).filter(Boolean);
    if (!patterns.length) throw problem('Agent returned no usable patterns', 502);
    const finishedAt = now();
    await updateAgentRun(workspaceRoot, run.id, { status: 'complete', output: JSON.stringify({ count: patterns.length, summary: patterns[0].value.template }), finishedAt });
    return { candidates: { patterns, vocabulary: [] }, provider, note: '', runId: run.id };
  } catch (error) {
    await updateAgentRun(workspaceRoot, run.id, { status: 'failed', error: String(error?.message || 'Extraction failed').slice(0, 4000), finishedAt: now() });
    throw error;
  }
}
