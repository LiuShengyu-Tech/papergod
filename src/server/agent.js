let nextId = 1;
const suggestionStore = new Map();

function resetStore() {
  suggestionStore.clear();
  nextId = 1;
}

export function composeMockSuggestions(content, prompt) {
  const results = [];
  let nextId = 1;

  const patterns = [
    {
      regex: /very\s+(\w+)/gi,
      category: 'style',
      makeDesc: (m) => `Replace "${m}" with a more precise word`,
      makeSuggestion: (m, adj) => {
        const upgrades = { important: 'crucial', good: 'excellent', useful: 'invaluable', rapidly: 'rapidly', big: 'substantial', hard: 'difficult' };
        const better = upgrades[adj.toLowerCase()];
        return better && better !== adj.toLowerCase() ? better : `remarkably ${adj}`;
      },
    },
    {
      regex: /It was (found|shown|demonstrated|observed) that\s+(the\s+)?/gi,
      category: 'grammar',
      makeDesc: () => 'Consider using active voice instead of passive',
      makeSuggestion: (m, _verb, _the) => '',
      transform: (content, match) => {
        const passive = match[0];
        const rest = content.slice(match.index + match[0].length);
        const sentenceEnd = rest.search(/[.!]/);
        const fragment = sentenceEnd > 0 ? rest.slice(0, sentenceEnd) : rest.split('\n')[0];
        return { original: passive + fragment, suggested: fragment.charAt(0).toUpperCase() + fragment.slice(1) };
      },
    },
    {
      regex: /In conclusion,?\s*.+?\./gi,
      category: 'structure',
      makeDesc: () => 'The conclusion is too brief; consider expanding it',
      makeSuggestion: (m) => m,
      transform: (_content, match) => {
        const original = match[0];
        const suggested = original.includes('very useful')
          ? 'In conclusion, artificial intelligence has demonstrated significant utility across diverse domains, from healthcare to scientific research. As the field continues to advance, we anticipate even broader applications and deeper integration into everyday problem-solving.'
          : original.replace(/In conclusion,?\s*/i, 'In summary, the findings demonstrate that ');
        return { original, suggested };
      },
    },
  ];

  for (const pat of patterns) {
    const regex = new RegExp(pat.regex.source, pat.regex.flags);
    let match;
    while ((match = regex.exec(content)) !== null) {
      const id = `sug_${nextId++}`;
      let original, suggested;

      if (pat.transform) {
        const result = pat.transform(content, match);
        original = result.original;
        suggested = result.suggested;
      } else {
        original = match[0];
        suggested = pat.makeSuggestion(match[0], match[1]);
      }

      if (!original || !suggested || original === suggested) continue;

      results.push({ id, category: pat.category, description: pat.makeDesc(match[0]), originalText: original, suggestedText: suggested });
    }
  }

  if (results.length === 0 && content.trim().length > 0) {
    const id = `sug_${nextId++}`;
    const original = content.split('\n').find((l) => l.trim().length > 20) || content.split('\n')[0];
    const suggested = original
      .replace(/\bcan be\b/gi, 'is')
      .replace(/\bhave been\b/gi, 'were')
      .replace(/\bis being\b/gi, 'is');
    if (original !== suggested) results.push({
      id, category: 'style', description: 'Consider refining the academic tone of this document',
      originalText: original, suggestedText: suggested,
    });
  }

  return results;
}

export function generateSuggestions(content, prompt) {
  resetStore();
  const results = composeMockSuggestions(content, prompt);
  for (const item of results) suggestionStore.set(item.id, item);
  return results;
}

export function registerSuggestions(items) {
  resetStore();
  return items.map((item) => {
    const suggestion = {
      id: `sug_${nextId++}`,
      category: item.category,
      description: item.description,
      originalText: item.originalText,
      suggestedText: item.suggestedText,
      reason: item.reason || '',
    };
    suggestionStore.set(suggestion.id, suggestion);
    return suggestion;
  });
}

export function attachSuggestionContext(items, { file = '', nodeId = '', nodeStart = 0, selectedContent = '' } = {}) {
  for (const item of items) {
    const suggestion = suggestionStore.get(item.id);
    if (!suggestion) continue;
    const relativeStart = selectedContent.indexOf(suggestion.originalText);
    if (relativeStart === -1) continue;
    suggestion.file = file;
    suggestion.nodeId = nodeId;
    suggestion.sourceRange = {
      start: nodeStart + relativeStart,
      end: nodeStart + relativeStart + suggestion.originalText.length,
    };
    Object.assign(item, {
      nodeId: suggestion.nodeId,
      sourceRange: suggestion.sourceRange,
    });
  }
  return items;
}

export function getSuggestion(id) {
  return suggestionStore.get(id) || null;
}

export function removeSuggestion(id) {
  return suggestionStore.delete(id);
}

export function applySuggestionToContent(content, suggestionId, file = '') {
  const sug = suggestionStore.get(suggestionId);
  if (!sug) return { content, error: 'Suggestion not found' };
  if (sug.file && file && sug.file !== file) return { content, error: 'Suggestion belongs to a different file' };
  let idx = -1;
  if (sug.sourceRange) {
    const actual = content.slice(sug.sourceRange.start, sug.sourceRange.end);
    if (actual !== sug.originalText) return { content, error: 'Source text changed; generate a new suggestion' };
    idx = sug.sourceRange.start;
  } else {
    idx = content.indexOf(sug.originalText);
  }
  if (idx === -1) return { content, error: 'Original text not found in document' };
  const newContent = content.slice(0, idx) + sug.suggestedText + content.slice(idx + sug.originalText.length);
  suggestionStore.delete(suggestionId);
  return { content: newContent, error: null };
}
