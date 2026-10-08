// Mask non-visible command arguments without shifting any source offsets.
// Visible arguments (e.g. the second argument of textcolor) remain intact.
export function maskLatexNonTextArguments(value) {
  const source = String(value || '');
  const chars = source.split('');
  const hiddenArguments = { color: 1, textcolor: 1, colorbox: 1, fcolorbox: 2, pagecolor: 1, definecolor: 3, colorlet: 2, href: 1 };
  const command = /\\([a-zA-Z@]+)\*?/g;
  const escaped = index => {
    let count = 0;
    while (index > 0 && source[--index] === '\\') count++;
    return count % 2 === 1;
  };
  function groupEnd(start, open, close) {
    let depth = 0;
    for (let index = start; index < source.length; index++) {
      if (escaped(index)) continue;
      if (source[index] === open) depth++;
      if (source[index] === close && --depth === 0) return index + 1;
    }
    return source.length;
  }
  for (const match of source.matchAll(command)) {
    if (escaped(match.index)) continue;
    const count = hiddenArguments[match[1]];
    if (!count) continue;
    let cursor = match.index + match[0].length;
    for (let argument = 0; argument < count; argument++) {
      while (/\s/.test(source[cursor] || '') && cursor < source.length) cursor++;
      if (source[cursor] === '[') {
        cursor = groupEnd(cursor, '[', ']');
        while (/\s/.test(source[cursor] || '') && cursor < source.length) cursor++;
      }
      if (source[cursor] !== '{') break;
      cursor = groupEnd(cursor, '{', '}');
    }
    for (let index = match.index; index < cursor; index++) if (!/[\r\n]/.test(chars[index])) chars[index] = ' ';
  }
  return chars.join('');
}

export function readableSentenceTokens(raw) {
  raw = maskLatexNonTextArguments(raw);
  // Keep source ranges intact so colored citation keys remain selectable.
  const citationRanges = [];
  const citationCommand = /\\(?:cite|citep|citet|citealp|citealt|citeauthor|citeyear|citeyearpar|parencite|textcite|autocite|footcite|smartcite|supercite|nocite)\*?(?![a-zA-Z@])/gi;
  for (const match of raw.matchAll(citationCommand)) {
    let precedingSlashes = 0;
    for (let i = match.index - 1; i >= 0 && raw[i] === '\\'; i--) precedingSlashes++;
    if (precedingSlashes % 2) continue;
    let cursor = match.index + match[0].length;
    while (/\s/.test(raw[cursor] || '') && cursor < raw.length) cursor++;
    while (raw[cursor] === '[') {
      let depth = 1;
      for (cursor++; cursor < raw.length && depth; cursor++) {
        if (raw[cursor] === '\\') { cursor++; continue; }
        if (raw[cursor] === '[') depth++;
        if (raw[cursor] === ']') depth--;
      }
      while (/\s/.test(raw[cursor] || '') && cursor < raw.length) cursor++;
    }
    if (raw[cursor] !== '{') continue;
    const start = ++cursor;
    let depth = 1;
    for (; cursor < raw.length && depth; cursor++) {
      if (raw[cursor] === '\\') { cursor++; continue; }
      if (raw[cursor] === '{') depth++;
      if (raw[cursor] === '}') depth--;
    }
    if (!depth) citationRanges.push({ start, end: cursor - 1 });
  }
  const characters = [];
  const offsets = [];
  for (let cursor = 0; cursor < raw.length;) {
    if (raw[cursor] === '\\') {
      const command = raw.slice(cursor).match(/^\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?/);
      if (command) { cursor += command[0].length; continue; }
    }
    if (raw[cursor] === '$') {
      const end = raw.indexOf('$', cursor + 1);
      const label = ' equation ';
      for (const character of label) { characters.push(character); offsets.push(undefined); }
      cursor = end === -1 ? cursor + 1 : end + 1;
      continue;
    }
    if ('{}'.includes(raw[cursor])) { cursor += 1; continue; }
    characters.push(raw[cursor]); offsets.push(cursor); cursor += 1;
  }
  const displayCharacters = [];
  const normalizedOffsets = [];
  let pendingSpace = false;
  for (let index = 0; index < characters.length; index += 1) {
    if (/\s/.test(characters[index])) { pendingSpace = displayCharacters.length > 0; continue; }
    if (pendingSpace) { displayCharacters.push(' '); normalizedOffsets.push(offsets[index]); }
    displayCharacters.push(characters[index]); normalizedOffsets.push(offsets[index]);
    pendingSpace = false;
  }
  const text = displayCharacters.join('');
  const tokens = [];
  const matcher = /[\p{L}\p{N}'’-]+/gu;
  let match;
  while ((match = matcher.exec(text))) {
    const rawStart = normalizedOffsets[match.index];
    const rawEndOffset = normalizedOffsets[match.index + match[0].length - 1];
    if (rawStart === undefined || rawEndOffset === undefined) continue;
    const citation = citationRanges.some(range => rawStart >= range.start && rawEndOffset < range.end);
    tokens.push({ text: match[0], displayStart: match.index, displayEnd: match.index + match[0].length, rawStart, rawEnd: rawEndOffset + 1, citation });
  }
  return { text, tokens };
}
