import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
test('removing intent highlights clears persistent change cache and reading selection', () => {
  const fn = source.slice(source.indexOf('function clearRemovedIntentHighlights('), source.indexOf('function openPdfEditMenu('));
  const ids = new Set(['sentence-one']);
  let dismissed = false, removed = false, selectionCleared = false;
  const preview = { dataset: { recentChangedSentences: '1' } };
  runInNewContext(`${fn}\nclearRemovedIntentHighlights();`, {
    dismissPdfSelection() { dismissed = true; }, recentChangedSentenceIds: ids,
    document: { querySelectorAll: () => [{ remove() { removed = true; } }], getElementById: () => preview },
    window: { getSelection: () => ({ removeAllRanges() { selectionCleared = true; } }) },
  });
  assert.equal(ids.size, 0);
  assert.equal(preview.dataset.recentChangedSentences, '0');
  assert.ok(dismissed && removed && selectionCleared);
});

test('successful Remove clears marks before reloading queue; rejected deletion preserves marks', async () => {
  const fn = source.slice(source.indexOf('async function deleteModificationIntent('), source.indexOf('async function resolveModificationIntents('));
  for (const ok of [true, false]) {
    const actions = [];
    await runInNewContext(`${fn}\ndeleteModificationIntent('request-one');`, {
      fetch: async () => ({ ok, json: async () => ({ error: 'Failed' }) }),
      clearRemovedIntentHighlights: () => actions.push('clear'),
      loadModificationIntents: async () => actions.push('reload'), showStatus() {},
    });
    assert.deepEqual(actions, ok ? ['clear', 'reload'] : []);
  }
});
