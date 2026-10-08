import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionSteps } from '../public/agent-connection.js';

test('signed-in and active does not imply a successful live connection', () => {
  assert.deepEqual(connectionSteps({ id: 'codex', available: true, authenticated: true }, 'codex'), ['done', 'done', 'pending', 'done']);
});

test('live connection transitions from pending through running to success or failure', () => {
  const profile = { id: 'codex', available: true, authenticated: true };
  assert.equal(connectionSteps(profile, 'mock', true)[2], 'running');
  assert.equal(connectionSteps({ ...profile, liveCheck: { ok: true } }, 'mock')[2], 'done');
  assert.equal(connectionSteps({ ...profile, liveCheck: { ok: false } }, 'mock')[2], 'failed');
  assert.deepEqual(connectionSteps({ id: 'codex' }, 'mock'), ['pending', 'pending', 'pending', 'pending']);
});

test('mock requires no external installation, sign-in or request', () => {
  assert.deepEqual(connectionSteps({ id: 'mock' }, 'mock'), ['done', 'done', 'done', 'done']);
});
