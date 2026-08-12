import { randomUUID } from 'crypto';
import { basename } from 'path';
import { spawn as spawnPty } from 'node-pty';

const MAX_HISTORY = 200_000;
const MAX_INPUT = 64_000;

function shellLaunch(env = process.env, platform = process.platform) {
  if (platform === 'win32') return { command: env.ComSpec || 'cmd.exe', args: [] };
  const command = env.SHELL || '/bin/bash';
  return { command, args: ['bash', 'zsh', 'fish', 'ksh'].includes(basename(command)) ? ['-l'] : [] };
}

export function createWorkspaceTerminalManager({ env = process.env, platform = process.platform } = {}) {
  const sessions = new Map();
  const workspaceSessions = new Map();

  function publicSession(session) {
    return { id: session.id, workspace: session.workspace, status: session.status, pid: session.pty.pid, startedAt: session.startedAt, exitCode: session.exitCode };
  }

  function broadcast(session, event, payload) {
    const body = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const response of session.listeners) response.write(body);
  }

  function start(workspace) {
    const existingId = workspaceSessions.get(workspace);
    const existing = existingId && sessions.get(existingId);
    if (existing?.status === 'running') return publicSession(existing);
    if (existing) sessions.delete(existing.id);
    const launch = shellLaunch(env, platform);
    const pty = spawnPty(launch.command, launch.args, {
      name: 'xterm-256color', cols: 100, rows: 30, cwd: workspace,
      env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'papergod' },
    });
    const session = { id: `terminal_${randomUUID()}`, workspace, pty, status: 'running', exitCode: null, startedAt: new Date().toISOString(), history: '', listeners: new Set() };
    sessions.set(session.id, session);
    workspaceSessions.set(workspace, session.id);
    pty.onData((data) => {
      session.history = `${session.history}${data}`.slice(-MAX_HISTORY);
      broadcast(session, 'output', { data });
    });
    pty.onExit(({ exitCode, signal }) => {
      session.status = 'exited';
      session.exitCode = exitCode;
      broadcast(session, 'exit', { exitCode, signal });
      for (const response of session.listeners) response.end();
      session.listeners.clear();
    });
    return publicSession(session);
  }

  function requireSession(id) {
    const session = sessions.get(id);
    if (!session) throw Object.assign(new Error('Terminal session not found.'), { status: 404, code: 'TERMINAL_NOT_FOUND' });
    return session;
  }

  function attach(id, response) {
    const session = requireSession(id);
    session.listeners.add(response);
    response.write(`event: ready\ndata: ${JSON.stringify({ session: publicSession(session), history: session.history })}\n\n`);
    if (session.status !== 'running') response.write(`event: exit\ndata: ${JSON.stringify({ exitCode: session.exitCode })}\n\n`);
    return () => session.listeners.delete(response);
  }

  function input(id, data) {
    const session = requireSession(id);
    if (session.status !== 'running') throw Object.assign(new Error('Terminal has exited.'), { status: 409, code: 'TERMINAL_EXITED' });
    if (typeof data !== 'string' || data.length > MAX_INPUT) throw Object.assign(new Error('Terminal input must be a string up to 64 KB.'), { status: 400, code: 'INVALID_TERMINAL_INPUT' });
    session.pty.write(data);
  }

  function resize(id, cols, rows) {
    const session = requireSession(id);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 10 || cols > 400 || rows < 4 || rows > 200) {
      throw Object.assign(new Error('Invalid terminal dimensions.'), { status: 400, code: 'INVALID_TERMINAL_SIZE' });
    }
    if (session.status === 'running') session.pty.resize(cols, rows);
  }

  function close(id) {
    const session = requireSession(id);
    if (session.status === 'running') session.pty.kill();
    sessions.delete(id);
    if (workspaceSessions.get(session.workspace) === id) workspaceSessions.delete(session.workspace);
    for (const response of session.listeners) response.end();
    session.listeners.clear();
  }

  function closeAll() {
    for (const id of [...sessions.keys()]) {
      try { close(id); } catch {}
    }
  }

  return { start, attach, input, resize, close, closeAll, get: (id) => publicSession(requireSession(id)) };
}
