import { loadProject } from './project-store.js';
import { getNodeSourceContext, syncDocumentStructure } from './document-structure.js';
import { findStructureNode, isAbbreviationAt, sentenceEndIndex } from './latex-structure.js';

// ---------------------------------------------------------------------------
// Descriptive statistics over sentence/paragraph lengths (word counts)
// ---------------------------------------------------------------------------

export const ANALYSIS_FORMULAS = [
  { id: 'mean', name: 'Mean length', formula: 'μ = (1/n) · Σᵢ₌₁ⁿ xᵢ', description: 'Average sentence (or paragraph) length in words.' },
  { id: 'stddev', name: 'Sample standard deviation', formula: 's = √( Σᵢ₌₁ⁿ (xᵢ − μ)² / (n − 1) )', description: 'Spread of lengths around the mean. n − 1 (Bessel) is used so s is an unbiased estimate of the population standard deviation.' },
  { id: 'variance', name: 'Variance', formula: 's² = Σᵢ₌₁ⁿ (xᵢ − μ)² / (n − 1)', description: 'Squared standard deviation; mean squared deviation from the mean.' },
  { id: 'median', name: 'Median', formula: 'median = middle value of sorted lengths (average of the two middle values when n is even)', description: 'Robust centre; half the units are shorter, half longer.' },
  { id: 'range', name: 'Range', formula: 'R = max(x) − min(x)', description: 'Full spread between the longest and shortest unit.' },
  { id: 'iqr', name: 'Interquartile range', formula: 'IQR = Q₃ − Q₁', description: 'Spread of the middle 50% of the data; robust to outliers.' },
  { id: 'cv', name: 'Coefficient of variation', formula: 'CV = s / μ', description: 'Relative variation. Low CV means lengths cluster tightly around the mean — the signature of mechanically uniform text.' },
  { id: 'delta', name: 'Adjacent change', formula: 'Δ = (1/(n−1)) · Σᵢ₌₁ⁿ⁻¹ |xᵢ₊₁ − xᵢ|', description: 'Average absolute jump between consecutive units; captures rhythm and variation from one sentence to the next.' },
  { id: 'relativeDelta', name: 'Relative adjacent change', formula: 'Δ / μ', description: 'Adjacent change normalised by the mean, comparable across texts of different scales.' },
  { id: 'variationIndex', name: 'Variation index', formula: 'VI = 100 · ( 0.6 · min(1, CV/0.5) + 0.4 · min(1, (Δ/μ)/0.8) )', description: '0–100 composite of CV and relative adjacent change. Higher values mean more rhythmic variation (organic prose); low values mean uniform, template-like writing.' },
];

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

// Strip LaTeX markup before counting words and splitting sentences so that
// commands and math do not inflate sentence lengths or break sentence pauses.
function cleanLatexForText(value) {
  return cleanText(value)
    .replace(/(?<!\\)%.*$/gm, ' ')
    .replace(/\\(?:cite|ref|label|footnote|emph|textbf|textit|texttt)\*?(?:\[[^\]]*\])?\{([^{}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?/g, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/\$+[^$]*\$+/g, ' equation ');
}

export function wordCount(text) {
  const cleaned = cleanLatexForText(text);
  return cleaned ? cleaned.split(/\s+/).filter(Boolean).length : 0;
}

export function splitSentences(text) {
  const source = cleanLatexForText(text);
  if (!source) return [];
  const sentences = [];
  let sentenceStart = 0;
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (!'.?!'.includes(character)) continue;
    const previous = source[cursor - 1];
    const boundary = sentenceEndIndex(source, cursor);
    if (boundary === -1) continue; // glued to following word/command
    let look = boundary;
    while (look < source.length && /\s/.test(source[look])) look += 1;
    const nextNonSpace = source[look];
    if (/\d/.test(previous || '') && /\d/.test(nextNonSpace || '')) continue; // decimal
    if (character === '.' && isAbbreviationAt(source, cursor)) continue; // e.g. i.e. cf.
    if (look < source.length && /[a-z]/.test(nextNonSpace || '')) continue; // embedded quote continues
    const sentence = cleanText(source.slice(sentenceStart, boundary));
    if (sentence) sentences.push(sentence);
    sentenceStart = boundary;
    cursor = boundary - 1;
  }
  const tail = cleanText(source.slice(sentenceStart));
  if (tail) sentences.push(tail);
  return sentences;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleStddev(values) {
  if (values.length < 2) return 0;
  const mu = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mu) ** 2, 0) / (values.length - 1));
}

function median(sorted) {
  const n = sorted.length;
  if (!n) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function adjacentDelta(values) {
  if (values.length < 2) return 0;
  let sum = 0;
  for (let index = 1; index < values.length; index += 1) sum += Math.abs(values[index] - values[index - 1]);
  return sum / (values.length - 1);
}

export function analyzeLengths(values) {
  const n = values.length;
  if (!n) return { count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mu = mean(values);
  const s = sampleStddev(values);
  const delta = adjacentDelta(values);
  const lowerHalf = sorted.slice(0, Math.floor(sorted.length / 2));
  const upperHalf = sorted.slice(Math.ceil(sorted.length / 2));
  return {
    count: n,
    mean: round(mu),
    stddev: round(s),
    variance: round(s * s),
    min: sorted[0],
    max: sorted[n - 1],
    range: round(sorted[n - 1] - sorted[0]),
    median: round(median(sorted)),
    iqr: round(median(upperHalf) - median(lowerHalf)),
    cv: round(mu ? s / mu : 0),
    delta: round(delta),
    relativeDelta: round(mu ? delta / mu : 0),
  };
}

// ---------------------------------------------------------------------------
// Variation index (0-100) and the mechanical-writing verdict
// ---------------------------------------------------------------------------

export function variationIndex(sentenceStats) {
  const cvPart = Math.min(1, (sentenceStats.cv || 0) / 0.5);
  const deltaPart = Math.min(1, (sentenceStats.relativeDelta || 0) / 0.8);
  return {
    score: Math.round((0.6 * cvPart + 0.4 * deltaPart) * 100),
    cvPart: round(cvPart, 3),
    deltaPart: round(deltaPart, 3),
  };
}

export function mechanicalVerdict(score) {
  // score is the variation index (0-100): LOW = uniform/template-like, HIGH = organic.
  if (score >= 70) {
    return {
      label: 'highly-varied', title: 'Highly varied rhythm',
      note: 'Sentence lengths change sharply and irregularly throughout. Strong rhythmic variation is typical of organic, edited prose.',
    };
  }
  if (score >= 45) {
    return {
      label: 'varied', title: 'Varied rhythm',
      note: 'Sentence lengths fluctuate noticeably, with meaningful jumps between adjacent sentences. This resembles natural human drafting.',
    };
  }
  if (score >= 25) {
    return {
      label: 'uniform', title: 'Uniform rhythm',
      note: 'Sentence lengths cluster tightly around the mean. The text reads steadily; consider whether that evenness matches an intentional style or a mechanical template.',
    };
  }
  return {
    label: 'highly-uniform', title: 'Highly uniform rhythm',
    note: 'Sentence lengths barely vary and rarely jump between adjacent sentences. This is the pattern typical of template-generated text — but uniformity alone is not proof of AI writing; short, technical passages are naturally even.',
  };
}

// ---------------------------------------------------------------------------
// Analysis units
// ---------------------------------------------------------------------------

function analyzeTextUnit(text, { id = '', label = '' } = {}) {
  const sentences = splitSentences(text);
  const sentenceLengths = sentences.map((sentence, index) => ({
    index, text: sentence, wordCount: wordCount(sentence), charCount: sentence.length,
  }));
  const stats = analyzeLengths(sentenceLengths.map((sentence) => sentence.wordCount));
  const variation = variationIndex(stats);
  return {
    unit: { id, label, text: cleanText(text), sentenceCount: sentences.length, wordCount: wordCount(text) },
    sentences: sentenceLengths,
    stats,
    variation,
    verdict: mechanicalVerdict(variation.score),
    formulas: ANALYSIS_FORMULAS,
  };
}

function flattenParagraphs(sections) {
  const result = [];
  const visit = (nodes, section) => {
    for (const node of nodes || []) {
      if (node.type === 'paragraph') result.push({ node, section });
      visit(node.children, section);
    }
  };
  for (const section of sections || []) visit([section], section);
  return result;
}

function summarizeUnit(analysis) {
  return {
    id: analysis.unit.id,
    label: analysis.unit.label,
    text: analysis.unit.text,
    sentenceCount: analysis.unit.sentenceCount,
    wordCount: analysis.unit.wordCount,
    stats: analysis.stats,
    variation: analysis.variation,
    verdict: analysis.verdict,
  };
}

function analyzeDocumentStructure(document) {
  const paragraphs = flattenParagraphs(document.sections);
  const paragraphAnalyses = paragraphs.map(({ node, section }) => ({
    ...summarizeUnit(analyzeTextUnit(node.text, { id: node.id, label: node.summary || `Paragraph in ${section?.title || 'document'}` })),
    section: section?.title || '',
  }));
  const allSentenceLengths = paragraphAnalyses.flatMap((paragraph) => {
    const sentences = splitSentences(paragraph.text);
    return sentences.map((sentence) => wordCount(sentence));
  });
  const paragraphLengths = paragraphAnalyses.map((paragraph) => paragraph.wordCount);
  const paragraphSentenceCounts = paragraphAnalyses.map((paragraph) => paragraph.sentenceCount);
  const sentenceStats = analyzeLengths(allSentenceLengths);
  const paragraphStats = analyzeLengths(paragraphLengths);
  const variation = variationIndex(sentenceStats);
  return {
    unit: {
      id: document.id,
      label: document.title || document.file,
      text: '',
      paragraphCount: paragraphAnalyses.length,
      sentenceCount: allSentenceLengths.length,
      wordCount: paragraphLengths.reduce((sum, value) => sum + value, 0),
    },
    paragraphs: paragraphAnalyses,
    sentenceStats,
    paragraphStats,
    paragraphSentenceStats: analyzeLengths(paragraphSentenceCounts),
    variation,
    verdict: mechanicalVerdict(variation.score),
    formulas: ANALYSIS_FORMULAS,
  };
}

// ---------------------------------------------------------------------------
// Public API entry
// ---------------------------------------------------------------------------

function error(message, status = 400) {
  const value = new Error(message);
  value.status = status;
  return value;
}

export async function analyzeStructure(workspaceRoot, { documentId, nodeId, content } = {}) {
  if (typeof content === 'string' && content.trim()) {
    return { kind: 'selection', ...analyzeTextUnit(content, { label: 'Selection' }) };
  }
  let project = await loadProject(workspaceRoot);
  let document = project.documents.find((item) => item.id === documentId);
  if (!document) {
    document = project.documents[0];
    if (!document) throw error('No document found in this workspace', 404);
  }
  await syncDocumentStructure(workspaceRoot, document.file);
  project = await loadProject(workspaceRoot);
  document = project.documents.find((item) => item.id === document.id);

  if (typeof nodeId === 'string' && nodeId) {
    const context = await getNodeSourceContext(workspaceRoot, nodeId);
    if (context.node.type === 'sentence') {
      const paragraph = context.node.parentId ? findStructureNode(context.document, context.node.parentId) : null;
      if (paragraph?.type === 'paragraph') {
        return { kind: 'paragraph', section: context.section?.title || '', ...analyzeTextUnit(paragraph.text, { id: paragraph.id, label: paragraph.summary || 'Paragraph' }) };
      }
      return { kind: 'sentence', section: context.section?.title || '', ...analyzeTextUnit(context.node.text, { id: context.node.id, label: 'Sentence' }) };
    }
    if (context.node.type === 'paragraph') {
      return { kind: 'paragraph', section: context.section?.title || '', ...analyzeTextUnit(context.node.text, { id: context.node.id, label: context.node.summary || 'Paragraph' }) };
    }
    if (context.node.type === 'section') {
      const paragraphs = flattenParagraphs([context.node]);
      const paragraphAnalyses = paragraphs.map(({ node }) => summarizeUnit(analyzeTextUnit(node.text, { id: node.id, label: node.summary || `Paragraph in ${context.node.title}` })));
      const sentenceStats = analyzeLengths(paragraphAnalyses.flatMap((paragraph) => splitSentences(paragraph.text).map((sentence) => wordCount(sentence))));
      const paragraphStats = analyzeLengths(paragraphAnalyses.map((paragraph) => paragraph.wordCount));
      const variation = variationIndex(sentenceStats);
      return {
        kind: 'section',
        section: context.node.title,
        unit: { id: context.node.id, label: context.node.title, paragraphCount: paragraphAnalyses.length, sentenceCount: sentenceStats.count, wordCount: paragraphStats.count ? paragraphStats.mean * paragraphStats.count : 0 },
        paragraphs: paragraphAnalyses,
        sentenceStats,
        paragraphStats,
        variation,
        verdict: mechanicalVerdict(variation.score),
        formulas: ANALYSIS_FORMULAS,
      };
    }
  }
  return { kind: 'document', ...analyzeDocumentStructure(document) };
}
