#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const url = new URL(process.env.PAPERGOD_URL || 'http://127.0.0.1:3000');
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
  throw new Error('PAPERGOD_URL must be an http://127.0.0.1:PORT origin');
}
const server = new McpServer({ name: 'papergod', version: '0.1.0' });
async function call(path, body) {
  try {
    const response = await fetch(new URL(path, url), {
      method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {},
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000), redirect: 'error',
    });
    const result = await response.json();
    return { content: [{ type: 'text', text: JSON.stringify(result) }], ...(response.ok ? {} : { isError: true }) };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: `Cannot reach PaperGod at ${url.origin}. Start PaperGod first. ${error.message}` }] };
  }
}
server.registerTool('papergod_requests', {
  description: 'Read PaperGod pending requests/review opinions. Omit file to list files; supply a .tex file to read source, prompts, libraries, requests and a version snapshot. Save browser edits first.',
  inputSchema: { file: z.string().min(1).optional() },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, ({ file }) => call(`/api/mcp/requests${file ? `?file=${encodeURIComponent(file)}` : ''}`));
server.registerTool('papergod_revise', {
  description: 'Submit exact edits for PaperGod requests. By default creates a reviewable plan. Set apply=true when user authorized editing, to apply atomically and resolve only linked request IDs. Return unresolved requests honestly; never mark them addressed with unrelated edits. Applied changes can be undone in PaperGod change history. Updated open pages automatically sync and compile; conflicting unsaved drafts are preserved. Tool success confirms the revision, not successful PDF compilation.',
  inputSchema: {
    workspace: z.string(), file: z.string().min(1), snapshot: z.string().min(1), title: z.string().optional(), apply: z.boolean().default(false),
    changes: z.array(z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), before: z.string(), after: z.string(), reason: z.string().min(1), requestId: z.string().optional() })).min(1),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
}, input => call('/api/mcp/revise', input));
await server.connect(new StdioServerTransport());
