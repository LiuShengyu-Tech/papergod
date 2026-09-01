const TOKEN_PATTERN = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

export function textTokens(text) {
  return [...String(text || '').matchAll(TOKEN_PATTERN)].map((match, index) => ({
    value: match[0].toLocaleLowerCase(),
    start: match.index,
    end: match.index + match[0].length,
    index,
  }));
}

function alignTokenSequence(sourceTokens, pdfTokens, fromToken) {
  const sourceLength = sourceTokens.length;
  if (!sourceLength || fromToken >= pdfTokens.length) return null;
  const searchLength = Math.min(
    pdfTokens.length - fromToken,
    Math.max(180, Math.min(1200, sourceLength * 5 + 120)),
  );
  const window = pdfTokens.slice(fromToken, fromToken + searchLength);
  const windowLength = window.length;
  let previous = new Float64Array(windowLength + 1);
  const trace = Array.from({ length: sourceLength + 1 }, () => new Uint8Array(windowLength + 1));

  for (let sourceIndex = 1; sourceIndex <= sourceLength; sourceIndex += 1) {
    const current = new Float64Array(windowLength + 1);
    current[0] = sourceIndex * -2;
    trace[sourceIndex][0] = 2;
    for (let pdfIndex = 1; pdfIndex <= windowLength; pdfIndex += 1) {
      const equal = sourceTokens[sourceIndex - 1].value === window[pdfIndex - 1].value;
      const diagonal = previous[pdfIndex - 1] + (equal ? 4 : -3);
      const skipSource = previous[pdfIndex] - 2;
      const skipPdf = current[pdfIndex - 1] - 1;
      if (diagonal >= skipSource && diagonal >= skipPdf) {
        current[pdfIndex] = diagonal;
        trace[sourceIndex][pdfIndex] = 1;
      } else if (skipSource >= skipPdf) {
        current[pdfIndex] = skipSource;
        trace[sourceIndex][pdfIndex] = 2;
      } else {
        current[pdfIndex] = skipPdf;
        trace[sourceIndex][pdfIndex] = 3;
      }
    }
    previous = current;
  }

  let bestEnd = 1;
  for (let pdfIndex = 2; pdfIndex <= windowLength; pdfIndex += 1) {
    if (previous[pdfIndex] > previous[bestEnd]) bestEnd = pdfIndex;
  }

  const matches = [];
  let sourceIndex = sourceLength;
  let pdfIndex = bestEnd;
  while (sourceIndex > 0 && pdfIndex >= 0) {
    const direction = trace[sourceIndex][pdfIndex];
    if (direction === 1) {
      if (pdfIndex > 0 && sourceTokens[sourceIndex - 1].value === window[pdfIndex - 1].value) {
        matches.push({ sourceIndex: sourceIndex - 1, pdfIndex: fromToken + pdfIndex - 1 });
      }
      sourceIndex -= 1;
      pdfIndex -= 1;
    } else if (direction === 2) {
      sourceIndex -= 1;
    } else if (direction === 3) {
      pdfIndex -= 1;
    } else {
      break;
    }
  }
  matches.reverse();
  if (!matches.length) return null;

  const firstToken = matches[0].pdfIndex;
  const lastToken = matches.at(-1).pdfIndex;
  const coverage = matches.length / sourceLength;
  const density = matches.length / Math.max(1, lastToken - firstToken + 1);
  const minimumMatches = sourceLength === 1 ? 1 : sourceLength <= 3 ? sourceLength : Math.max(3, Math.ceil(sourceLength * 0.62));
  if (matches.length < minimumMatches || coverage < (sourceLength <= 3 ? 1 : 0.62) || density < 0.38) return null;

  return {
    firstToken,
    lastToken,
    matches: matches.length,
    sourceTokens: sourceLength,
    coverage,
    density,
    confidence: (coverage * 0.75) + (density * 0.25),
  };
}

function extendMappedRange(pdfText, sourceText, start, end) {
  while (start > 0 && /["'“‘（([]/u.test(pdfText[start - 1])) start -= 1;
  const sourceTail = String(sourceText || '').trim().match(/[.!?。！？:;]["'”’）)\]]*$/u)?.[0]?.[0] || '';
  if (!sourceTail) return { start, end };
  const terminalPattern = '.!?。！？'.includes(sourceTail) ? /[.!?。！？]/u : new RegExp(`[${sourceTail}]`, 'u');
  const limit = Math.min(pdfText.length, end + 120);
  let tokenCount = 0;
  for (let cursor = end; cursor < limit; cursor += 1) {
    if (terminalPattern.test(pdfText[cursor])) {
      end = cursor + 1;
      while (end < pdfText.length && /["'”’）)\]]/u.test(pdfText[end])) end += 1;
      break;
    }
    if (/\s/u.test(pdfText[cursor]) && /[\p{L}\p{N}]/u.test(pdfText[cursor + 1] || '')) {
      tokenCount += 1;
      if (tokenCount > 12) break;
    }
  }
  return { start, end };
}

export function buildOrderedSentenceMappings(pdfText, sentenceItems) {
  const pdfTokens = textTokens(pdfText);
  const mappings = [];
  let cursor = 0;
  for (const item of sentenceItems || []) {
    const matchText = String(item.matchText || item.text || '');
    const sourceTokens = textTokens(matchText);
    const alignment = alignTokenSequence(sourceTokens, pdfTokens, cursor);
    if (!alignment) continue;
    const first = pdfTokens[alignment.firstToken];
    const last = pdfTokens[alignment.lastToken];
    const range = extendMappedRange(pdfText, matchText, first.start, last.end);
    mappings.push({
      ...item,
      ...range,
      confidence: alignment.confidence,
      matchedTokens: alignment.matches,
      sourceTokenCount: alignment.sourceTokens,
      pdfStartToken: alignment.firstToken,
      pdfEndToken: alignment.lastToken,
    });
    cursor = alignment.lastToken + 1;
  }
  return { mappings, pdfTokens };
}

export function sentenceMappingAt(mappings, pdfIndex) {
  if (!Number.isInteger(pdfIndex)) return null;
  return (mappings || []).find((mapping) => mapping.start <= pdfIndex && pdfIndex < mapping.end) || null;
}
