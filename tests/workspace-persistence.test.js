import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/index.js';
import { createWorkspaceRegistry } from '../src/server/workspace-registry.js';
import { initializeWorkspace } from '../src/server/workspace.js';
import { parseCliArgs, resolveStartupWorkspace } from '../src/cli.js';

test('Opening another instance never replaces the last explicitly selected workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'papergod-persistence-'));
  const paper = join(root, 'paper');
  const preview = join(root, 'preview');
  const file = join(root, 'registry.json');
  const registry = createWorkspaceRegistry({ file });
  let server;
  try {
    await mkdir(paper); await mkdir(preview);
    await initializeWorkspace(preview);
    await registry.add(paper, { activate: true });
    const app = createApp(preview, { workspaceRegistryFile: file });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const path of ['/api/config', '/api/workspaces', '/api/config']) {
      assert.equal((await fetch(base + path)).status, 200);
      assert.equal((await registry.getActive()).path, paper);
    }
    const startup = await resolveStartupWorkspace(parseCliArgs([], preview), { registry });
    assert.equal(startup.workspaceRoot, paper);
    const entry = (await registry.list()).find(item => item.path === preview);
    assert.equal((await fetch(`${base}/api/workspaces/${entry.id}/activate`, { method: 'POST' })).status, 200);
    assert.equal((await registry.getActive()).path, preview);
    await registry.activate(paper);
    await rm(paper, { recursive: true });
    await assert.rejects(resolveStartupWorkspace(parseCliArgs([]), { registry }), /last selected workspace is unavailable/);
    assert.equal(parseCliArgs(['--workspace', preview]).resume, false);
    assert.equal(parseCliArgs(['--demo']).resume, false);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
