import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { translationRouter } from '../src/server/translation.js';

test('DeepL settings, private credentials, endpoint selection, cache, errors and origin guard', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'papergod-translation-'));
  const file = join(directory, 'deepl.json');
  const calls = [];
  let upstreamStatus = 200;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: upstreamStatus === 200, status: upstreamStatus, json: async () => url.endsWith('/usage') ? { character_count: 12, character_limit: 100 } : { translations: [{ text: '你好。' }] } };
  };
  const app = express();
  app.use(express.json());
  app.use('/api/translation', translationRouter({ file, fetchImpl }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/translation/`;
  const request = async (path, body, headers = {}) => {
    const response = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  try {
    assert.equal((await request('settings')).data.configured, false);
    assert.equal((await request('translate', { text: 'Hello.' })).status, 400);
    assert.equal((await request('settings', { apiKey: 'test-secret:fx', endpoint: 'auto' }, { origin: 'https://other.example' })).status, 403);
    const saved = await request('settings', { apiKey: 'test-secret:fx', endpoint: 'auto' });
    assert.deepEqual(saved.data, { configured: true, endpoint: 'auto' });
    assert.equal(JSON.stringify((await request('settings')).data).includes('test-secret'), false);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).apiKey, 'test-secret:fx');
    assert.equal((await request('test', {})).data.connected, true);
    assert.equal(calls[0].url, 'https://api-free.deepl.com/v2/usage');
    assert.equal(calls[0].options.headers.Authorization, 'DeepL-Auth-Key test-secret:fx');
    assert.equal((await request('translate', { text: 'Hello.' })).data.text, '你好。');
    assert.deepEqual(JSON.parse(calls[1].options.body), { text: ['Hello.'], target_lang: 'ZH-HANS' });
    assert.equal((await request('translate', { text: 'Hello.' })).data.cached, true);
    assert.equal(calls.length, 2);
    await request('settings', { apiKey: '', endpoint: 'pro' });
    await request('test', {});
    assert.equal(calls.at(-1).url, 'https://api.deepl.com/v2/usage');
    upstreamStatus = 456;
    const failure = await request('translate', { text: 'Different sentence.' });
    assert.equal(failure.status, 502);
    assert.match(failure.data.error, /quota/);
    assert.equal((await request('translate', { text: 'x'.repeat(12001) })).status, 400);
    await request('settings', { endpoint: 'auto', removeKey: true });
    assert.equal((await request('settings')).data.configured, false);
    assert.equal((await request('translate', { text: 'Hello.' })).status, 400);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
