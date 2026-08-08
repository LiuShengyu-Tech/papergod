#!/usr/bin/env node

import { resolve } from 'path';
import process from 'process';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { realpathSync } from 'fs';
import { initializeWorkspace } from './server/workspace.js';
import { startServer } from './server/index.js';

const PACKAGE_FILE = fileURLToPath(new URL('../package.json', import.meta.url));
const AGENT_PROVIDERS = ['mock', 'codex', 'claude-code', 'opencode'];

export function parseCliArgs(argv, cwd = process.cwd()) {
  const options = { workspaceRoot: null, port: 3000, provider: 'mock', demo: false, help: false, version: false };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--version' || argument === '-v') options.version = true;
    else if (argument === '--port' || argument === '-p') options.port = Number(argv[++index]);
    else if (argument.startsWith('--port=')) options.port = Number(argument.slice('--port='.length));
    else if (argument === '--agent') options.provider = argv[++index];
    else if (argument.startsWith('--agent=')) options.provider = argument.slice('--agent='.length);
    else if (argument === '--workspace' || argument === '-w') options.workspaceRoot = argv[++index];
    else if (argument.startsWith('--workspace=')) options.workspaceRoot = argument.slice('--workspace='.length);
    else if (argument === '--demo') options.demo = true;
    else if (argument.startsWith('-')) throw new Error(`Unknown option: ${argument}`);
    else positional.push(argument);
  }

  if (positional.length > 1 || (positional.length === 1 && options.workspaceRoot)) {
    throw new Error('Provide one workspace as either a positional argument or --workspace');
  }
  options.workspaceRoot = resolve(cwd, options.workspaceRoot || positional[0] || '.');
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error('Port must be an integer between 0 and 65535');
  }
  if (!AGENT_PROVIDERS.includes(options.provider)) {
    throw new Error(`Agent must be one of: ${AGENT_PROVIDERS.join(', ')}`);
  }
  return options;
}

export function helpText() {
  return `Papergod — local-first AI LaTeX writing platform

Usage:
  papergod [workspace] [options]

Options:
  -w, --workspace <path>  Paper workspace (default: current directory)
  -p, --port <number>     Local HTTP port (default: 3000; 0 selects a free port)
      --agent <provider>  mock, codex, claude-code, or opencode (default: mock)
      --demo              Seed built-in prompts, libraries, vocabulary, and demo paper
  -h, --help              Show help
  -v, --version           Show version
`;
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);
  if (options.help) {
    process.stdout.write(helpText());
    return null;
  }
  if (options.version) {
    const packageData = JSON.parse(await readFile(PACKAGE_FILE, 'utf-8'));
    process.stdout.write(`${packageData.version}\n`);
    return null;
  }

  const initialization = await initializeWorkspace(options.workspaceRoot, { demo: options.demo });
  const server = await startServer(options);
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  process.stdout.write(`Papergod running at ${url}\n`);
  process.stdout.write(`Workspace: ${options.workspaceRoot}\n`);
  process.stdout.write(`Agent: ${options.provider}${initialization.createdSample ? ' (sample main.tex created)' : ''}\n`);

  const shutdown = () => {
    process.stdout.write('\nShutting down...\n');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return server;
}

const isMainModule = process.argv[1] && (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMainModule) {
  run().catch((error) => {
    process.stderr.write(`Papergod failed to start: ${error.message}\n`);
    process.exitCode = 1;
  });
}
