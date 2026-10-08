import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readableSentenceTokens } from '../public/latex-readable.js';

test('citation keys are marked without changing source selection offsets', () => {
  for (const command of ['cite', 'citep', 'citet', 'Citep', 'parencite', 'textcite']) {
    const source = '\\textcolor{cyan}{Compare objectives \\' + command + '*[see][p. 12]{susse2021generative,cohen2024generative}.}';
    const { tokens } = readableSentenceTokens(source);
    assert.deepEqual(tokens.filter(token => token.citation).map(token => token.text), ['susse2021generative', 'cohen2024generative']);
    for (const token of tokens) assert.equal(source.slice(token.rawStart, token.rawEnd), token.text);
    assert.equal(tokens.find(token => token.text === 'objectives').citation, false);
  }
});

test('ordinary text, escaped commands and malformed citations are not marked', () => {
  for (const source of ['susse2021generative appears in plain text.', String.raw`\\cite{key}`, String.raw`\cite{unfinished`, String.raw`\citestyle{numeric}`]) {
    assert.ok(readableSentenceTokens(source).tokens.every(token => !token.citation));
  }
});
