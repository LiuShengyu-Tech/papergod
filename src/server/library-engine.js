const DEFAULT_LIMITS = { corpora: 3, patterns: 3, vocabulary: 12 };
const STOP_WORDS = new Set([
  'about', 'after', 'again', 'against', 'among', 'because', 'before', 'being', 'between', 'could',
  'during', 'first', 'from', 'have', 'into', 'more', 'other', 'paper', 'results', 'should', 'their',
  'there', 'these', 'they', 'this', 'through', 'using', 'were', 'which', 'with', 'would',
]);

function words(value) {
  return [...new Set(String(value || '').toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || [])];
}

function textFor(type, item) {
  if (type === 'corpus') return [item.name, item.description, item.content, item.source, ...(item.tags || [])].join(' ');
  if (type === 'pattern') return [item.name, item.description, item.template, item.source, ...(item.tags || []), ...(item.sectionTypes || [])].join(' ');
  return [item.term, item.preferred, item.definition, item.source, ...(item.tags || []), ...(item.alternatives || []), ...(item.examples || [])].join(' ');
}

function scoreItem(type, item, queryTokens, tags) {
  const haystack = textFor(type, item).toLowerCase();
  let score = 0;
  queryTokens.forEach((token) => {
    if (haystack.includes(token)) score += haystack.includes(` ${token} `) ? 4 : 2;
  });
  tags.forEach((tag) => {
    if ((item.tags || []).some((candidate) => candidate.toLowerCase() === tag)) score += 6;
  });
  return score;
}

function ranked(type, items, { query = '', tags = [], limit = 10, sectionType = '' } = {}) {
  const queryTokens = words(query);
  const normalizedTags = tags.map((tag) => String(tag).toLowerCase());
  return items
    .filter((item) => type !== 'pattern' || !sectionType || item.sectionTypes.length === 0
      || item.sectionTypes.some((candidate) => candidate.toLowerCase() === sectionType.toLowerCase()))
    .map((item, index) => ({ item, index, score: scoreItem(type, item, queryTokens, normalizedTags) }))
    .filter((entry) => queryTokens.length === 0 && normalizedTags.length === 0 || entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, Math.min(Number(limit) || 10, 100)))
    .map(({ item, score }) => ({ ...item, relevance: score }));
}

export function mergedVocabulary(libraries) {
  const merged = new Map();
  for (const item of libraries.vocabulary.global) merged.set(item.term.trim().toLowerCase(), { ...item, scope: 'global' });
  for (const item of libraries.vocabulary.session) merged.set(item.term.trim().toLowerCase(), { ...item, scope: 'session' });
  return [...merged.values()];
}

export function searchLibraries(libraries, options = {}) {
  return {
    corpora: ranked('corpus', libraries.corpora, { ...options, limit: options.limits?.corpora ?? options.limit ?? 10 }),
    sentencePatterns: ranked('pattern', libraries.sentencePatterns, { ...options, limit: options.limits?.patterns ?? options.limit ?? 10 }),
    vocabulary: ranked('vocabulary', mergedVocabulary(libraries), { ...options, limit: options.limits?.vocabulary ?? options.limit ?? 20 }),
  };
}

function allResources(libraries) {
  return [
    ...libraries.corpora.map((item) => ({ type: 'corpus', item })),
    ...libraries.sentencePatterns.map((item) => ({ type: 'pattern', item })),
    ...libraries.vocabulary.global.map((item) => ({ type: 'vocabulary', scope: 'global', item })),
    ...libraries.vocabulary.session.map((item) => ({ type: 'vocabulary', scope: 'session', item })),
  ];
}

function descriptor(type, item, scope) {
  return { id: item.id, type, scope: scope || null, name: item.name || item.term };
}

export function buildLibraryContext(libraries, { query = '', tags = [], sectionType = '', resourceIds = [] } = {}) {
  const explicit = new Set(Array.isArray(resourceIds) ? resourceIds : []);
  let selected;
  if (explicit.size > 0) {
    selected = allResources(libraries).filter(({ item }) => explicit.has(item.id));
  } else {
    const found = searchLibraries(libraries, { query, tags, sectionType, limits: DEFAULT_LIMITS });
    selected = [
      ...found.corpora.map((item) => ({ type: 'corpus', item })),
      ...found.sentencePatterns.map((item) => ({ type: 'pattern', item })),
      ...found.vocabulary.map((item) => ({ type: 'vocabulary', scope: item.scope, item })),
    ];
  }

  const blocks = selected.map(({ type, scope, item }) => {
    if (type === 'corpus') {
      return `[CORPUS ${item.id}] ${item.name}\nSource: ${item.source || 'user library'}\n${item.content}`;
    }
    if (type === 'pattern') {
      const slots = item.slots.map((slot) => `${slot.name}${slot.required ? '*' : ''}: ${slot.description}`).join('; ');
      return `[SENTENCE_PATTERN ${item.id}] ${item.name}\nTemplate: ${item.template}\nSlots: ${slots || 'none'}`;
    }
    return `[VOCABULARY ${item.id} scope=${scope}] ${item.term}${item.preferred ? ` -> prefer: ${item.preferred}` : ''}`
      + `${item.definition ? `\nMeaning: ${item.definition}` : ''}`;
  });
  const resources = selected.map(({ type, scope, item }) => descriptor(type, item, scope));
  return {
    prompt: blocks.length ? `Writing library resources:\n${blocks.join('\n\n')}\n\nUse only resources that improve the text. Report the IDs you actually use in usedResourceIds.` : '',
    resources,
    resourceIds: resources.map((item) => item.id),
    mode: explicit.size > 0 ? 'selected' : 'automatic',
  };
}

export function renderSentencePattern(pattern, values = {}) {
  if (!pattern || typeof pattern.template !== 'string') throw new Error('Pattern is required');
  const missing = (pattern.slots || [])
    .filter((slot) => slot.required && (typeof values[slot.name] !== 'string' || !values[slot.name].trim()))
    .map((slot) => slot.name);
  if (missing.length) {
    const error = new Error(`Missing required pattern slots: ${missing.join(', ')}`);
    error.code = 'MISSING_PATTERN_SLOTS';
    error.status = 400;
    error.details = missing;
    throw error;
  }
  const rendered = pattern.template.replace(/\{([a-zA-Z][\w-]*)\}/g, (match, name) => {
    const value = values[name];
    return typeof value === 'string' && value.trim() ? value.trim() : match;
  });
  return { rendered, patternId: pattern.id, values };
}

function cleanLatex(content) {
  return content
    .replace(/(?<!\\)%.*$/gm, ' ')
    .replace(/\\(?:begin|end)\{[^}]+\}/g, ' ')
    .replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?(?:\{([^{}]*)\})?/g, '$1')
    .replace(/[{}$]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractLibraryCandidates(content, source = 'current document') {
  const clean = cleanLatex(content);
  const sentences = clean.match(/[^.!?]+[.!?]+/g) || [];
  const patterns = sentences
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 35 && sentence.length <= 300)
    .slice(0, 12)
    .map((template, index) => ({
      kind: 'sentence-patterns',
      value: {
        name: `Extracted expression ${index + 1}`, template, description: 'Candidate extracted from the current paper.',
        tags: ['extracted'], sectionTypes: [], slots: [], source,
      },
    }));

  const frequencies = new Map();
  for (const word of clean.toLowerCase().match(/[a-z][a-z-]{6,}/g) || []) {
    if (!STOP_WORDS.has(word)) frequencies.set(word, (frequencies.get(word) || 0) + 1);
  }
  const vocabulary = [...frequencies.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([term, count]) => ({
      kind: 'vocabulary', scope: 'session',
      value: {
        term, preferred: term, definition: `Appears ${count} times in the current paper.`, source,
        alternatives: [], examples: [], tags: ['extracted'],
      },
    }));
  return { patterns, vocabulary };
}

export function composeMockParagraph(libraries, context, instruction = '') {
  const selected = new Set(context.resourceIds || []);
  const corpora = libraries.corpora.filter((item) => selected.has(item.id));
  const patterns = libraries.sentencePatterns.filter((item) => selected.has(item.id));
  const vocabulary = mergedVocabulary(libraries).filter((item) => selected.has(item.id));
  const pieces = [];
  const usedResourceIds = [];
  if (corpora[0]) {
    pieces.push(corpora[0].content.trim());
    usedResourceIds.push(corpora[0].id);
  }
  if (patterns[0]) {
    const rendered = patterns[0].template.replace(/\{([a-zA-Z][\w-]*)\}/g, (_match, name) => `[${name}]`);
    pieces.push(rendered);
    usedResourceIds.push(patterns[0].id);
  }
  if (vocabulary.length) {
    const terms = vocabulary.slice(0, 4).map((item) => item.preferred || item.term);
    pieces.push(`Use the preferred terminology ${terms.join(', ')} while developing this argument.`);
    usedResourceIds.push(...vocabulary.slice(0, 4).map((item) => item.id));
  }
  if (!pieces.length) {
    const topic = instruction.trim().replace(/[.!?]+$/, '');
    pieces.push(topic ? `This paragraph develops the following point: ${topic}.` : 'Develop the central claim with evidence and appropriate qualifications.');
  }
  return { draft: pieces.join(' '), usedResourceIds: [...new Set(usedResourceIds)] };
}
