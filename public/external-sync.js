export function sourceSyncDecision(saved, local, remote) {
  if (saved === null || remote === saved) return 'unchanged';
  if (local === remote) return 'acknowledge';
  return local === saved ? 'replace' : 'conflict';
}

// Proposed plans do not invalidate the PDF.
export function revisionFingerprint(revisions) {
  return JSON.stringify(revisions.filter(r => ['applied', 'rolled-back'].includes(r.status))
    .map(r => [r.id, r.status, r.appliedAt, r.rolledBackAt, r.recoveryPoint?.appliedHash]));
}
