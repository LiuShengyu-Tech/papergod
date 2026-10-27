import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createApp } from '../src/server/index.js';
import { initializeWorkspace } from '../src/server/workspace.js';
import { syncDocumentStructure } from '../src/server/document-structure.js';
import { createAnnotation } from '../src/server/project-resources.js';
import { loadProject } from '../src/server/project-store.js';
import { rollbackRevision } from '../src/server/revision-engine.js';

test('real MCP stdio: requests, preview, atomic apply, stale/overlap protection and rollback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'papergod-mcp-'));
  const app = createApp(root);
  let server, client;
  try {
    await initializeWorkspace(root);
    const file = 'main.tex';
    const source = '\\documentclass{article}\n\\begin{document}\nThis is very good.\nAnother sentence.\n\\end{document}\n';
    await writeFile(join(root, file), source);
    const document = await syncDocumentStructure(root, file);
    const start = source.indexOf('very good');
    const request = await createAnnotation(root, { documentId: document.id, body: 'Use precise wording.', target: { type: 'range', id: document.id, start, end: start + 9, quote: 'very good' } });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    client = new Client({ name: 'papergod-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('src/mcp.js')], env: { ...process.env, PAPERGOD_URL: url } }));
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['papergod_requests', 'papergod_revise']);
    async function tool(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      return { error: !!result.isError, data: JSON.parse(result.content[0].text) };
    }
    assert.equal((await tool('papergod_requests')).data.workspace, root);
    const snapshot = (await tool('papergod_requests', { file })).data;
    assert.equal(snapshot.requests[0].id, request.id);
    const change = { start, end: start + 9, before: 'very good', after: 'effective', reason: 'Replace vague intensifier', requestId: request.id };
    const input = { workspace: root, file, snapshot: snapshot.snapshot, changes: [change] };
    const preview = await tool('papergod_revise', input);
    assert.equal(preview.error, false);
    assert.equal(preview.data.applied, false);
    assert.equal(await readFile(join(root, file), 'utf-8'), source);
    assert.equal((await tool('papergod_revise', { ...input, workspace: 'wrong', apply: true })).error, true);
    assert.equal((await tool('papergod_revise', { ...input, changes: [change, change], apply: true })).error, true);
    assert.equal((await tool('papergod_revise', { ...input, changes: [{ ...change, after: 'effective \\cite{fabricated}' }] })).error, true);
    assert.equal((await tool('papergod_revise', { ...input, changes: [{ ...change, requestId: 'unknown' }] })).error, true);
    const applied = await tool('papergod_revise', { ...input, apply: true });
    assert.equal(applied.error, false, JSON.stringify(applied.data));
    assert.equal(applied.data.revision.status, 'applied');
    assert.equal((await loadProject(root)).annotations[0].status, 'resolved');
    assert.equal((await tool('papergod_revise', { ...input, apply: true })).error, true);
    await rollbackRevision(root, applied.data.revision.id);
    assert.equal(await readFile(join(root, file), 'utf-8'), source);
    assert.equal((await loadProject(root)).annotations[0].status, 'open');
    const stale = (await tool('papergod_requests', { file })).data;
    await writeFile(join(root, file), source + '% concurrent edit\n');
    assert.equal((await tool('papergod_revise', { ...input, snapshot: stale.snapshot, apply: true })).error, true);
    assert.equal((await fetch(`${url}/api/mcp/requests`, { headers: { Origin: 'https://example.com' } })).status, 403);
    assert.equal((await tool('papergod_requests', { file: '../outside.tex' })).error, true);
  } finally {
    await client?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    app.locals.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
