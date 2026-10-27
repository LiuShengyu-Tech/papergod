import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceSyncDecision, revisionFingerprint } from '../public/external-sync.js';

test('external source replaces only clean buffers and preserves unsaved edits', () => {
  assert.equal(sourceSyncDecision('old', 'old', 'new'), 'replace');
  assert.equal(sourceSyncDecision('old', 'my draft', 'new'), 'conflict');
  assert.equal(sourceSyncDecision('old', 'my draft', 'old'), 'unchanged');
  assert.equal(sourceSyncDecision('old', 'new', 'new'), 'acknowledge');
  assert.equal(sourceSyncDecision(null, '', 'new'), 'unchanged');
});

test('completed edits and rollback invalidate PDF, proposed plans do not', () => {
  const applied = { id: 'one', status: 'applied', appliedAt: 'a', recoveryPoint: { appliedHash: 'abc' } };
  assert.equal(revisionFingerprint([]), revisionFingerprint([{ id: 'draft', status: 'review' }]));
  assert.notEqual(revisionFingerprint([]), revisionFingerprint([applied]));
  assert.notEqual(revisionFingerprint([applied]), revisionFingerprint([{ ...applied, status: 'rolled-back', rolledBackAt: 'b' }]));
  assert.equal(revisionFingerprint([applied]), revisionFingerprint([applied, { id: 'draft', status: 'review' }]));
});
