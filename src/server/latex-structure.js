import { createHash, randomUUID } from 'crypto';

const SECTION_LEVELS = { section: 1, subsection: 2, subsubsection: 3 };

function id(prefix) {
  return `${prefix}_${randomUUID()}`;
}

function normalize(value) {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function fingerprint(value) {
  return createHash('sha1').update(normalize(value)).digest('hex').slice(0, 12);
}

function isEscaped(source, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function isCommented(source, index) {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1;
  for (let cursor = lineStart; cursor < index; cursor += 1) {
    if (source[cursor] === '%' && !isEscaped(source, cursor)) return true;
  }
  return false;
}

function closingBrace(source, openIndex) {
  let depth = 0;
  for (let cursor = openIndex; cursor < source.length; cursor += 1) {
    if (source[cursor] === '%' && !isEscaped(source, cursor)) {
      const newline = source.indexOf('\n', cursor);
      if (newline === -1) return -1;
      cursor = newline;
      continue;
    }
    if (source[cursor] === '{' && !isEscaped(source, cursor)) depth += 1;
    if (source[cursor] === '}' && !isEscaped(source, cursor)) {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return -1;
}

function findCommandValue(source, command, from = 0, to = source.length) {
  const regex = new RegExp(`\\\\${command}\\*?\\s*\\{`, 'g');
  regex.lastIndex = from;
  let match;
  while ((match = regex.exec(source)) && match.index < to) {
    if (isCommented(source, match.index)) continue;
    const open = match.index + match[0].lastIndexOf('{');
    const close = closingBrace(source, open);
    if (close !== -1 && close < to) {
      return { value: source.slice(open + 1, close), start: match.index, end: close + 1 };
    }
  }
  return null;
}

function findHeadings(source, from, to) {
  const regex = /\\(section|subsection|subsubsection)\*?\s*\{/g;
  regex.lastIndex = from;
  const headings = [];
  let match;
  while ((match = regex.exec(source)) && match.index < to) {
    if (isCommented(source, match.index)) continue;
    const open = match.index + match[0].lastIndexOf('{');
    const close = closingBrace(source, open);
    if (close === -1 || close >= to) continue;
    headings.push({
      command: match[1], level: SECTION_LEVELS[match[1]], title: source.slice(open + 1, close).trim(),
      start: match.index, headingEnd: close + 1,
    });
    regex.lastIndex = close + 1;
  }
  return headings;
}

function trimRange(source, start, end) {
  while (start < end && /\s/.test(source[start])) start += 1;
  while (end > start && /\s/.test(source[end - 1])) end -= 1;
  return { start, end };
}

function plainText(raw) {
  return raw
    .replace(/(?<!\\)%.*$/gm, ' ')
    .replace(/\\(?:cite|ref|label|footnote|emph|textbf|textit)\*?(?:\[[^\]]*\])?\{([^{}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?/g, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/\$+[^$]*\$+/g, ' equation ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Common Latin/English abbreviations whose trailing period is not a sentence
// boundary. Keys include multi-character sequences such as "e.g" where the
// intermediate period is part of the token.
export const SENTENCE_ABBREVIATIONS = new Set([
  'e.g', 'i.e', 'etc', 'cf', 'vs', 'viz', 'ca', 'approx', 'resp', 'ibid', 'loc', 'cit', 'op',
  'fig', 'figs', 'sec', 'secs', 'eq', 'eqn', 'eqns', 'ref', 'refs', 'no', 'nos', 'vol', 'vols',
  'pp', 'p', 'ch', 'chap', 'app', 'appx', 'dr', 'mr', 'mrs', 'ms', 'prof', 'st', 'rev', 'gen',
  'gov', 'dept', 'univ', 'inc', 'ltd', 'ed', 'eds', 'al', 'jr', 'sr', 'ph', 'th',
]);

export function isAbbreviationAt(source, dotIndex) {
  if (typeof source !== 'string' || !Number.isInteger(dotIndex)) return false;
  let start = dotIndex - 1;
  while (start >= 0 && /[A-Za-z.]/.test(source[start])) start -= 1;
  const token = source.slice(start + 1, dotIndex);
  if (!token) return false;
  if (/^[A-Z]$/.test(token)) return true; // initial in a name: A. M. Turing
  return SENTENCE_ABBREVIATIONS.has(token.toLowerCase());
}

function sentenceRanges(source, start, end) {
  const ranges = [];
  let sentenceStart = start;
  let braceDepth = 0;
  for (let cursor = start; cursor < end; cursor += 1) {
    const character = source[cursor];
    if (character === '{' && !isEscaped(source, cursor)) braceDepth += 1;
    else if (character === '}' && !isEscaped(source, cursor)) braceDepth = Math.max(0, braceDepth - 1);
    if (!'.?!'.includes(character) || isEscaped(source, cursor) || braceDepth > 0) continue;
    const next = source[cursor + 1];
    const previous = source[cursor - 1];
    if (/\d/.test(previous || '') && /\d/.test(next || '')) continue; // decimal number
    if (next && !/\s/.test(next)) continue; // period glued to a command, citation, etc.
    if (character === '.' && isAbbreviationAt(source, cursor)) continue; // e.g. i.e. cf. A. M.
    const range = trimRange(source, sentenceStart, cursor + 1);
    if (range.end > range.start) ranges.push(range);
    sentenceStart = cursor + 1;
  }
  const tail = trimRange(source, sentenceStart, end);
  if (tail.end > tail.start) ranges.push(tail);
  return ranges;
}

function inferIntent(value, index, count) {
  const text = plainText(value).toLowerCase();
  if (/\?$/.test(text)) return 'Pose a research question.';
  if (/\b(we propose|we present|this paper contributes|our contribution)\b/.test(text)) return 'State the paper contribution.';
  if (/\b(results?|findings?)\b.*\b(show|demonstrate|indicate|suggest)\b/.test(text)) return 'Report an empirical finding.';
  if (/\b(however|nevertheless|in contrast|although)\b/.test(text)) return 'Introduce a contrast or limitation.';
  if (/\b(therefore|thus|consequently|because)\b/.test(text)) return 'Explain reasoning or a consequence.';
  if (index === 0) return 'Establish the paragraph topic.';
  if (index === count - 1 && count > 1) return 'Conclude the point or transition onward.';
  return 'Develop or support the paragraph argument.';
}

function isProseChunk(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (/^\\(?:begin|end)\{(?:equation|align|figure|table|tikzpicture|thebibliography)\}/.test(trimmed)) return false;
  if (/^(?:\\(?:maketitle|bibliography|bibliographystyle|label)\b[^\n]*\s*)+$/.test(trimmed)) return false;
  return plainText(trimmed).length > 0;
}

function paragraphRanges(source, start, end) {
  const ranges = [];
  const separator = /\n[ \t]*\n+/g;
  separator.lastIndex = start;
  let cursor = start;
  let match;
  while ((match = separator.exec(source)) && match.index < end) {
    const range = trimRange(source, cursor, match.index);
    if (range.end > range.start && isProseChunk(source.slice(range.start, range.end))) ranges.push(range);
    cursor = match.index + match[0].length;
  }
  const range = trimRange(source, cursor, end);
  if (range.end > range.start && isProseChunk(source.slice(range.start, range.end))) ranges.push(range);
  return ranges;
}

function previousMatcher(items, keyOf) {
  const map = new Map();
  for (const item of items || []) {
    const key = keyOf(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return { map, items: items || [], used: new Set() };
}

function takePrevious(matcher, key, index) {
  const matches = matcher.map.get(key) || [];
  let exact = matches.shift();
  while (exact && matcher.used.has(exact.id)) exact = matches.shift();
  if (exact) {
    matcher.used.add(exact.id);
    return exact;
  }
  const positional = matcher.items[index];
  if (positional && !matcher.used.has(positional.id)) {
    matcher.used.add(positional.id);
    return positional;
  }
  const unused = matcher.items.find((item) => !matcher.used.has(item.id));
  if (unused) matcher.used.add(unused.id);
  return unused || null;
}

function buildParagraphs(source, section, previousSection) {
  const previousParagraphs = previousSection?.children || [];
  const paragraphMatcher = previousMatcher(previousParagraphs, (item) => fingerprint(item.text || ''));
  return paragraphRanges(source, section.contentStart, section.contentEnd).map((range, paragraphIndex) => {
    const raw = source.slice(range.start, range.end);
    const previous = takePrevious(paragraphMatcher, fingerprint(raw), paragraphIndex);
    const paragraphId = previous?.id || id('paragraph');
    const sentenceSourceRanges = sentenceRanges(source, range.start, range.end);
    const previousSentences = previous?.children || [];
    const sentenceMatcher = previousMatcher(previousSentences, (item) => fingerprint(item.text || ''));
    const children = sentenceSourceRanges.map((sentenceRange, sentenceIndex) => {
      const sentenceRaw = source.slice(sentenceRange.start, sentenceRange.end);
      const old = takePrevious(sentenceMatcher, fingerprint(sentenceRaw), sentenceIndex);
      return {
        id: old?.id || id('sentence'), type: 'sentence', parentId: paragraphId, order: sentenceIndex,
        text: sentenceRaw, prompt: old?.prompt || '', summary: old?.summary || '',
        intent: old?.intent || inferIntent(sentenceRaw, sentenceIndex, sentenceSourceRanges.length),
        sourceRange: { ...sentenceRange, contentStart: sentenceRange.start, contentEnd: sentenceRange.end },
      };
    });
    const readable = plainText(raw);
    return {
      id: paragraphId, type: 'paragraph', parentId: section.id, order: paragraphIndex,
      text: raw, prompt: previous?.prompt || '',
      summary: previous?.summary || plainText(children[0]?.text || readable).slice(0, 180),
      sourceRange: { ...range, contentStart: range.start, contentEnd: range.end }, children,
    };
  });
}

export function parseLatexDocument(source, previousDocument = {}) {
  if (typeof source !== 'string') throw new TypeError('LaTeX source must be a string');
  const beginDocument = source.search(/\\begin\s*\{document\}/);
  const endDocument = source.search(/\\end\s*\{document\}/);
  const bodyStart = beginDocument === -1 ? 0 : beginDocument + source.slice(beginDocument).match(/^\\begin\s*\{document\}/)[0].length;
  const bodyEnd = endDocument === -1 ? source.length : endDocument;
  const title = findCommandValue(source, 'title', 0, bodyStart)?.value.trim() || previousDocument.title || '';
  const headings = findHeadings(source, bodyStart, bodyEnd);
  const descriptors = [];

  const abstractStartMatch = /\\begin\s*\{abstract\}/g;
  abstractStartMatch.lastIndex = bodyStart;
  const abstractMatch = abstractStartMatch.exec(source);
  if (abstractMatch && abstractMatch.index < bodyEnd) {
    const closeRegex = /\\end\s*\{abstract\}/g;
    closeRegex.lastIndex = abstractMatch.index + abstractMatch[0].length;
    const close = closeRegex.exec(source);
    if (close && close.index < bodyEnd) {
      descriptors.push({
        command: 'abstract', level: 1, title: 'Abstract', start: abstractMatch.index,
        headingEnd: abstractMatch.index + abstractMatch[0].length,
        contentStart: abstractMatch.index + abstractMatch[0].length, contentEnd: close.index,
        end: close.index + close[0].length,
      });
    }
  }

  headings.forEach((heading, index) => {
    const next = headings[index + 1];
    descriptors.push({
      ...heading, contentStart: heading.headingEnd, contentEnd: next?.start || bodyEnd,
      end: next?.start || bodyEnd,
    });
  });
  descriptors.sort((a, b) => a.start - b.start);

  const previousSections = previousDocument.sections || [];
  const sectionMatcher = previousMatcher(previousSections, (item) => `${item.level || 1}:${normalize(item.title || item.text || '')}`);
  const sections = descriptors.map((descriptor, sectionIndex) => {
    const key = `${descriptor.level}:${normalize(descriptor.title)}`;
    const previous = takePrevious(sectionMatcher, key, sectionIndex);
    const section = {
      id: previous?.id || id('section'), type: 'section', parentId: previousDocument.id || '', order: sectionIndex,
      level: descriptor.level, command: descriptor.command, title: descriptor.title, text: descriptor.title,
      prompt: previous?.prompt || '', summary: previous?.summary || '',
      sourceRange: {
        start: descriptor.start, end: descriptor.end,
        contentStart: descriptor.contentStart, contentEnd: descriptor.contentEnd,
      },
      children: [],
    };
    section.children = buildParagraphs(source, { ...descriptor, id: section.id }, previous);
    if (!section.summary) section.summary = section.children[0]?.summary || '';
    return section;
  });

  return { title, sections, sourceLength: source.length };
}

export function findStructureNode(document, nodeId) {
  if (document.id === nodeId) return document;
  const visit = (nodes) => {
    for (const node of nodes || []) {
      if (node.id === nodeId) return node;
      const found = visit(node.children);
      if (found) return found;
    }
    return null;
  };
  return visit(document.sections);
}
