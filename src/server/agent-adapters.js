import { spawn } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { basename, dirname, extname, join } from 'path';
import { homedir, tmpdir } from 'os';
import { AgentError, classifyAgentDiagnostic, incompleteJsonKind, normalizeAgentError, redactAgentDiagnostic } from './agent-errors.js';
import { agentHealthStatus, clearAgentHealth, inspectCliCapabilities, markAgentUnavailable } from './agent-runtime.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const MAX_INPUT_CHARS = 500_000;
export const AGENT_PROVIDERS = ['mock', 'codex', 'claude-code', 'opencode', 'pi'];

export const SUGGESTION_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'suggestions', 'unresolvedTasks', 'usedResourceIds'],
  properties: {
    summary: { type: 'string' },
    usedResourceIds: { type: 'array', items: { type: 'string' } },
    unresolvedTasks: {
      type: 'array', maxItems: 50,
      items: { type: 'object', additionalProperties: false, required: ['taskId', 'reason'], properties: { taskId: { type: 'string' }, reason: { type: 'string' } } },
    },
    suggestions: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['taskId', 'nodeId', 'category', 'description', 'originalText', 'suggestedText', 'reason', 'usedTemplateIds', 'usedCitekeys'],
        properties: {
          taskId: { type: 'string' },
          nodeId: { type: 'string' },
          category: { type: 'string', enum: ['content', 'structure', 'method', 'evidence', 'style', 'grammar', 'citation', 'other'] },
          description: { type: 'string' },
          originalText: { type: 'string' },
          suggestedText: { type: 'string' },
          reason: { type: 'string' },
          usedTemplateIds: { type: 'array', items: { type: 'string' } },
          usedCitekeys: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

export const REVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'verdict', 'confidence', 'items'],
  properties: {
    summary: { type: 'string' },
    verdict: { type: 'string', enum: ['accept', 'minor-revision', 'major-revision', 'reject'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    items: {
      type: 'array', maxItems: 30,
      items: {
        type: 'object', additionalProperties: false,
        required: ['rubricId', 'kind', 'category', 'severity', 'body', 'suggestedFix', 'quote'],
        properties: {
          rubricId: { type: 'string' },
          kind: { type: 'string', enum: ['concern', 'strength'] },
          category: { type: 'string', enum: ['content', 'structure', 'method', 'evidence', 'style', 'grammar', 'citation', 'other'] },
          severity: { type: 'string', enum: ['info', 'minor', 'major', 'critical'] },
          body: { type: 'string' }, suggestedFix: { type: 'string' }, quote: { type: 'string' },
        },
      },
    },
  },
};

export const PAPER_GENERATION_OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'latex', 'usedResourceIds'],
  properties: {
    summary: { type: 'string' }, latex: { type: 'string' },
    usedResourceIds: { type: 'array', items: { type: 'string' } },
  },
};

export const REVIEW_ORCHESTRATION_OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'opinions'],
  properties: {
    summary: { type: 'string' },
    opinions: { type: 'array', maxItems: 100, items: {
      type: 'object', additionalProperties: false,
      required: ['body', 'category', 'severity', 'quote', 'suggestedFix', 'dependsOn'],
      properties: {
        body: { type: 'string' },
        category: { type: 'string', enum: ['content', 'structure', 'method', 'evidence', 'style', 'grammar', 'citation', 'other'] },
        severity: { type: 'string', enum: ['info', 'minor', 'major', 'critical'] },
        quote: { type: 'string' }, suggestedFix: { type: 'string' },
        dependsOn: { type: 'array', items: { type: 'integer', minimum: 1 } },
      },
    } },
  },
};

function safeEnvironment() {
  const blocked = /^(NODE_OPTIONS|BASH_ENV|ENV|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*)$/;
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !blocked.test(key)));
}

const knownWindowsPaths = new Map();

function discoverKnownWindowsPath(provider) {
  if (process.platform !== 'win32') return null;
  const cached = knownWindowsPaths.get(provider);
  if (cached && existsSync(cached)) return cached;
  let found = null;
  if (provider === 'codex') {
    // Codex CLI installs under %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe
    // without registering itself on PATH. The hash directory changes on every
    // Codex update, so re-scan whenever the cached path is gone.
    const base = join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
    let entries;
    try { entries = readdirSync(base); } catch { entries = []; }
    for (const entry of entries) {
      const candidate = join(base, entry, 'codex.exe');
      if (existsSync(candidate)) { found = candidate; break; }
    }
  }
  knownWindowsPaths.set(provider, found);
  return found;
}

function commandSpec(provider, overrides = {}) {
  const override = overrides[provider];
  const defaultCommand = provider === 'claude-code' ? 'claude' : provider;
  if (!override) {
    const known = discoverKnownWindowsPath(provider);
    return { command: known || defaultCommand, prefixArgs: [], model: '' };
  }
  if (typeof override === 'string') {
    const command = override === defaultCommand ? (discoverKnownWindowsPath(provider) || defaultCommand) : override;
    return { command, prefixArgs: [], model: '' };
  }
  // A saved profile that only repeats the default command name (e.g. "codex")
  // must not disable automatic discovery: the Codex CLI moves between hash
  // directories on update and is often not on PATH at all.
  const configuredCommand = override.command || defaultCommand;
  const command = configuredCommand === defaultCommand
    ? (discoverKnownWindowsPath(provider) || defaultCommand)
    : configuredCommand;
  return {
    command,
    prefixArgs: Array.isArray(override.args) ? override.args : [],
    model: typeof override.model === 'string' ? override.model.trim() : '',
    reasoningEffort: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(override.reasoningEffort) ? override.reasoningEffort : '',
  };
}

function modelArgs(spec) {
  return spec.model ? ['--model', spec.model] : [];
}

function reasoningArgs(provider, effort) {
  if (!effort) return [];
  if (provider === 'codex') return ['--config', `model_reasoning_effort="${effort}"`];
  if (provider === 'claude-code') return ['--effort', effort === 'xhigh' ? 'high' : effort];
  if (provider === 'opencode') return ['--variant', effort];
  if (provider === 'pi') return ['--thinking', effort === 'xhigh' ? 'high' : effort];
  return [];
}

function operationEffort(operation, configured = '') {
  if (configured) return configured;
  return operation === 'suggest' ? 'low' : ['review', 'generation', 'orchestration'].includes(operation) ? 'high' : 'medium';
}

function resolveWindowsCommand(command) {
  if (process.platform !== 'win32') return { command, shell: false };
  if (extname(command)) return { command, shell: false }; // explicit codex.exe / pi.cmd
  const hasPath = command.includes('\\') || command.includes('/');
  const name = basename(command);
  const dirs = hasPath ? [dirname(command)] : (process.env.PATH || '').split(';').filter(Boolean);
  for (const dir of dirs) {
    for (const extension of ['.exe', '.cmd', '.bat']) {
      const candidate = join(dir, name + extension);
      if (existsSync(candidate)) return { command: candidate, shell: extension !== '.exe' };
    }
  }
  return { command, shell: false };
}

export function runProcess(command, args, { cwd, input = '', timeoutMs = DEFAULT_TIMEOUT_MS, signal, allowFailure = false, onOutput, envOverrides = {} } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error('Agent run cancelled');
      error.code = 'AGENT_CANCELLED';
      return reject(error);
    }
    // Windows: npm-installed CLIs ship as .cmd/.bat shims without an .exe.
    // Node's spawn with shell:false cannot execute those directly, so resolve the
    // shim on PATH (or next to the given path) and run it through cmd.exe with
    // explicitly quoted arguments (avoids the DEP0190 shell:true concatenation).
    const resolved = resolveWindowsCommand(command);
    const env = { ...safeEnvironment(), ...envOverrides };
    let child;
    if (resolved.shell) {
      // cmd /c strips the leading quote and the last quote, so wrap the whole
      // line in an extra pair of quotes: ""C:\...\pi.cmd" "--version""
      const inner = [`"${resolved.command}"`, ...args.map((arg) => `"${String(arg).replace(/"/g, '""')}"`)].join(' ');
      const commandLine = `"${inner}"`;
      child = spawn('cmd.exe', ['/d', '/s', '/c', commandLine], {
        cwd, env, shell: false, windowsVerbatimArguments: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } else {
      child = spawn(resolved.command, args, {
        cwd, env, shell: false, detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    let timer;
    let forceTimer;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (error) reject(error);
      else resolve(result);
    };
    let pendingTerminationError = null;
    const windowsTreeKill = (force = false) => {
      if (!child.pid) return;
      try { spawn('taskkill.exe', ['/pid', String(child.pid), '/t', ...(force ? ['/f'] : [])], { windowsHide: true, stdio: 'ignore' }).unref(); } catch {}
    };
    const unixGroupAlive = () => {
      if (process.platform === 'win32' || !child.pid) return false;
      try { process.kill(-child.pid, 0); return true; } catch { return false; }
    };
    const terminateTree = (error) => {
      if (settled || pendingTerminationError) return;
      pendingTerminationError = error;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
        else windowsTreeKill(false);
      } catch {}
      forceTimer = setTimeout(() => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else windowsTreeKill(true);
        } catch {}
        setTimeout(() => finish(pendingTerminationError), 25).unref();
      }, 750);
      forceTimer.unref();
    };
    const cancel = () => {
      const error = new Error('Agent run cancelled');
      error.code = 'AGENT_CANCELLED';
      terminateTree(error);
    };
    const append = (current, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        const error = new Error('Agent output exceeded 5 MiB');
        error.code = 'AGENT_OUTPUT_LIMIT';
        terminateTree(error);
      }
      return current + chunk.toString('utf-8');
    };

    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); onOutput?.('stdout', chunk.toString('utf-8')); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); onOutput?.('stderr', chunk.toString('utf-8')); });
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      if (pendingTerminationError) {
        if (process.platform !== 'win32' && !unixGroupAlive()) {
          clearTimeout(forceTimer);
          return finish(pendingTerminationError);
        }
        return;
      }
      if (code !== 0) {
        if (allowFailure) return finish(null, { stdout, stderr, code, signal });
        const error = new Error((stderr || stdout || `Agent exited with code ${code}`).trim());
        error.code = 'AGENT_PROCESS_FAILED';
        error.exitCode = code;
        error.signal = signal;
        error.stdout = stdout;
        error.stderr = stderr;
        return finish(error);
      }
      finish(null, { stdout, stderr, code });
    });

    signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => {
      const error = new Error(`Agent timed out after ${timeoutMs}ms`);
      error.code = 'AGENT_TIMEOUT';
      terminateTree(error);
    }, timeoutMs);
    timer.unref();

    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export function validateSuggestionResponse(value, content, allowedResourceIds = []) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, errors: ['response must be an object'] };
  if (typeof value.summary !== 'string') errors.push('summary must be a string');
  if (!Array.isArray(value.usedResourceIds) || value.usedResourceIds.some((item) => typeof item !== 'string')) {
    errors.push('usedResourceIds must be an array of strings');
  } else {
    const allowed = new Set(allowedResourceIds);
    if (new Set(value.usedResourceIds).size !== value.usedResourceIds.length) errors.push('usedResourceIds must not contain duplicates');
    value.usedResourceIds.forEach((resourceId, index) => {
      if (!allowed.has(resourceId)) errors.push(`usedResourceIds[${index}] was not provided to the Agent`);
    });
  }
  if (!Array.isArray(value.suggestions)) errors.push('suggestions must be an array');
  else if (value.suggestions.length > 50) errors.push('suggestions must contain at most 50 items');
  else value.suggestions.forEach((suggestion, index) => {
    const path = `suggestions[${index}]`;
    if (!suggestion || typeof suggestion !== 'object' || Array.isArray(suggestion)) return errors.push(`${path} must be an object`);
    const allowed = ['content', 'structure', 'method', 'evidence', 'style', 'grammar', 'citation', 'other'];
    if (!allowed.includes(suggestion.category)) errors.push(`${path}.category is invalid`);
    for (const field of ['description', 'originalText', 'suggestedText', 'reason']) {
      if (typeof suggestion[field] !== 'string' || !suggestion[field]) errors.push(`${path}.${field} must be a non-empty string`);
    }
    if (typeof suggestion.originalText === 'string' && !content.includes(suggestion.originalText)) {
      errors.push(`${path}.originalText was not found in the submitted document`);
    }
    if (suggestion.originalText === suggestion.suggestedText) errors.push(`${path} does not change the text`);
  });
  return { ok: errors.length === 0, errors };
}

export function parseAgentJson(output) {
  return parseStructuredAgentJson(output, (value) => value && typeof value === 'object'
    && typeof value.summary === 'string' && Array.isArray(value.suggestions));
}

function protocolObjects(output) {
  const objects = [];
  for (const text of [String(output || '').trim(), ...String(output || '').split(/\r?\n/)]) {
    try { const value = JSON.parse(text); if (value && typeof value === 'object') objects.push(value); } catch {}
  }
  return objects;
}

export function classifyAgentCliFailure({ provider = '', stdout = '', stderr = '', output = '', exitCode, signal } = {}) {
  const combined = [stdout, stderr, output].filter(Boolean).join('\n');
  for (const event of protocolObjects(combined)) {
    const response = event.response && typeof event.response === 'object' ? event.response : event;
    const reason = response.incomplete_details?.reason || response.incompleteDetails?.reason || response.finish_reason || event.finish_reason || event.stop_reason;
    const failure = response.error || event.error || event.failure || (event.is_error ? event.result || event.subtype : null);
    if (response.status === 'incomplete' || event.status === 'incomplete' || event.type === 'response.incomplete') {
      const classified = classifyAgentDiagnostic(String(reason || failure?.message || failure || 'incomplete output'), { provider });
      const error = classified?.code === 'AGENT_CONTENT_FILTERED' ? classified : new AgentError('The model output ended before the structured result was complete.', 'AGENT_OUTPUT_TRUNCATED', { provider, diagnostic: combined, retryable: true });
      if (exitCode !== undefined) error.exitCode = exitCode;
      if (signal) error.signal = signal;
      return error;
    }
    if (event.type === 'error' || event.type === 'response.failed' || event.type === 'turn.failed' || event.is_error === true || failure) {
      const detail = typeof failure === 'string' ? failure : JSON.stringify(failure || event);
      const error = classifyAgentDiagnostic(detail, { provider }) || new AgentError('The Agent provider reported a protocol failure.', 'AGENT_PROTOCOL_ERROR', { provider, diagnostic: combined });
      if (exitCode !== undefined) error.exitCode = exitCode;
      if (signal) error.signal = signal;
      return error;
    }
  }
  return classifyAgentDiagnostic(combined, { provider });
}

async function runProviderProcess(provider, command, args, options) {
  try { return await runProcess(command, args, options); }
  catch (error) {
    throw classifyAgentCliFailure({ provider, stdout: error.stdout, stderr: error.stderr, exitCode: error.exitCode, signal: error.signal }) || normalizeAgentError(error, { provider });
  }
}

function parseStructuredAgentJson(output, predicate) {
  const trimmed = output.trim();
  const locate = (value) => {
    if (predicate(value)) return value;
    if (!value || typeof value !== 'object') return null;
    for (const key of ['structured_output', 'structuredOutput', 'result', 'message', 'content']) {
      const nested = value[key];
      if (predicate(nested)) return nested;
      if (typeof nested === 'string') {
        try {
          const parsed = JSON.parse(nested);
          const found = locate(parsed);
          if (found) return found;
        } catch {}
      } else if (nested && typeof nested === 'object') {
        const found = locate(nested);
        if (found) return found;
      }
    }
    return null;
  };
  try {
    const direct = JSON.parse(trimmed);
    const found = locate(direct);
    if (found) return found;
  } catch {}

  const candidates = [];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());

  const eventTexts = [];
  for (const line of trimmed.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      const found = locate(event);
      if (found) return found;
      if (typeof event?.part?.text === 'string' && ['text', 'message'].includes(event.type)) eventTexts.push(event.part.text);
      if (['message_end', 'turn_end'].includes(event?.type)) {
        const message = event.message;
        if (message?.role === 'assistant' && Array.isArray(message.content)) {
          for (const part of message.content) if (part?.type === 'text' && typeof part.text === 'string') eventTexts.push(part.text);
        }
      }
    } catch {}
  }
  if (eventTexts.length) {
    const eventText = eventTexts.join('');
    candidates.push(eventText);
    const eventFence = eventText.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (eventFence) candidates.push(eventFence[1].trim());
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const found = locate(parsed);
      if (found) return found;
    } catch {}
  }
  const classified = classifyAgentCliFailure({ output: trimmed });
  if (classified) throw classified;
  const kind = incompleteJsonKind(trimmed);
  if (kind === 'empty') throw new AgentError('Agent returned an empty structured response', 'AGENT_EMPTY_RESPONSE');
  if (kind === 'truncated') throw new AgentError('Agent returned a truncated structured response', 'AGENT_OUTPUT_TRUNCATED', { diagnostic: trimmed, retryable: true });
  throw new AgentError('Agent did not return valid JSON', 'AGENT_INVALID_JSON', { diagnostic: trimmed });
}

export function parseReviewAgentJson(output) {
  return parseStructuredAgentJson(output, (value) => value && typeof value === 'object'
    && typeof value.summary === 'string' && Array.isArray(value.items));
}

export function parsePaperGenerationJson(output) {
  return parseStructuredAgentJson(output, (value) => value && typeof value === 'object'
    && typeof value.summary === 'string' && typeof value.latex === 'string');
}

export function parseReviewOrchestrationJson(output) {
  return parseStructuredAgentJson(output, (value) => value && typeof value === 'object' && Array.isArray(value.opinions));
}

export function validateReviewResponse(value, content, rubricIds = []) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, errors: ['response must be an object'] };
  if (typeof value.summary !== 'string' || !value.summary.trim()) errors.push('summary must be a non-empty string');
  if (!['accept', 'minor-revision', 'major-revision', 'reject'].includes(value.verdict)) errors.push('verdict is invalid');
  if (typeof value.confidence !== 'number' || value.confidence < 0 || value.confidence > 1) errors.push('confidence must be between 0 and 1');
  if (!Array.isArray(value.items)) errors.push('items must be an array');
  else if (value.items.length > 30) errors.push('items must contain at most 30 entries');
  else value.items.forEach((item, index) => {
    const path = `items[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return errors.push(`${path} must be an object`);
    if (!rubricIds.includes(item.rubricId)) errors.push(`${path}.rubricId does not reference the supplied rubric`);
    if (!['concern', 'strength'].includes(item.kind)) errors.push(`${path}.kind is invalid`);
    if (!['content', 'structure', 'method', 'evidence', 'style', 'grammar', 'citation', 'other'].includes(item.category)) errors.push(`${path}.category is invalid`);
    if (!['info', 'minor', 'major', 'critical'].includes(item.severity)) errors.push(`${path}.severity is invalid`);
    for (const field of ['body', 'suggestedFix', 'quote']) {
      if (typeof item[field] !== 'string') errors.push(`${path}.${field} must be a string`);
    }
    if (typeof item.body === 'string' && !item.body.trim()) errors.push(`${path}.body must be non-empty`);
    if (typeof item.quote === 'string' && item.quote && !content.includes(item.quote)) errors.push(`${path}.quote was not found in the document`);
  });
  return { ok: errors.length === 0, errors };
}

export function validatePaperGenerationResponse(value, allowedResourceIds = []) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, errors: ['response must be an object'] };
  if (typeof value.summary !== 'string' || !value.summary.trim()) errors.push('summary must be a non-empty string');
  if (typeof value.latex !== 'string' || !value.latex.trim()) errors.push('latex must be a non-empty string');
  else {
    if (value.latex.length > MAX_INPUT_CHARS * 2) errors.push('latex exceeds 1,000,000 characters');
    if (!/\\documentclass(?:\[[^\]]*\])?\{[^}]+\}/.test(value.latex)) errors.push('latex must contain documentclass');
    if (!/\\begin\{document\}/.test(value.latex) || !/\\end\{document\}/.test(value.latex)) errors.push('latex must contain a complete document environment');
    if (/\\(?:write18|openout|openin|read|immediate)\b/i.test(value.latex)) errors.push('latex contains a prohibited I/O command');
  }
  if (!Array.isArray(value.usedResourceIds) || value.usedResourceIds.some((item) => typeof item !== 'string')) errors.push('usedResourceIds must be an array of strings');
  else {
    const allowed = new Set(allowedResourceIds);
    if (new Set(value.usedResourceIds).size !== value.usedResourceIds.length) errors.push('usedResourceIds must not contain duplicates');
    value.usedResourceIds.forEach((resourceId, index) => { if (!allowed.has(resourceId)) errors.push(`usedResourceIds[${index}] was not provided to the Agent`); });
  }
  return { ok: errors.length === 0, errors };
}

export function validateReviewOrchestrationResponse(value, content) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, errors: ['response must be an object'] };
  if (typeof value.summary !== 'string') errors.push('summary must be a string');
  if (!Array.isArray(value.opinions) || !value.opinions.length) errors.push('opinions must be a non-empty array');
  else if (value.opinions.length > 100) errors.push('opinions must contain at most 100 entries');
  else value.opinions.forEach((opinion, index) => {
    const path = `opinions[${index}]`;
    if (!opinion || typeof opinion !== 'object' || Array.isArray(opinion)) return errors.push(`${path} must be an object`);
    if (typeof opinion.body !== 'string' || !opinion.body.trim()) errors.push(`${path}.body must be non-empty`);
    if (!['content', 'structure', 'method', 'evidence', 'style', 'grammar', 'citation', 'other'].includes(opinion.category)) errors.push(`${path}.category is invalid`);
    if (!['info', 'minor', 'major', 'critical'].includes(opinion.severity)) errors.push(`${path}.severity is invalid`);
    for (const field of ['quote', 'suggestedFix']) if (typeof opinion[field] !== 'string') errors.push(`${path}.${field} must be a string`);
    if (typeof opinion.quote === 'string' && opinion.quote && !content.includes(opinion.quote)) errors.push(`${path}.quote was not found in the manuscript`);
    if (!Array.isArray(opinion.dependsOn) || opinion.dependsOn.some((dependency) => !Number.isInteger(dependency) || dependency < 1 || dependency > value.opinions.length || dependency === index + 1)) errors.push(`${path}.dependsOn contains an invalid opinion number`);
    else if (new Set(opinion.dependsOn).size !== opinion.dependsOn.length) errors.push(`${path}.dependsOn must not contain duplicates`);
  });
  return { ok: errors.length === 0, errors };
}

const LIBRARY_FILES = [
  { path: '.papergod/library/corpus.md', description: 'writing library: corpora (search by tag/topic)' },
  { path: '.papergod/library/patterns.md', description: 'writing library: sentence patterns (with {slot} placeholders)' },
  { path: '.papergod/library/vocabulary-global.md', description: 'preferred wording (global)' },
  { path: '.papergod/library/vocabulary-session.md', description: 'preferred wording (this session)' },
  { path: '.papergod/index.json', description: 'machine-readable catalog of library entries' },
];

// Build a compact workspace index for the agent prompt: absolute root, a flat
// file listing with purpose annotations, and the target range. The full
// document and library bodies are intentionally NOT included — the agent reads
// them from disk on demand.
export function buildWorkspaceIndex(workspaceRoot, { file = '', start = 0, end = 0 } = {}) {
  let entries = [];
  try { entries = readdirSync(workspaceRoot, { withFileTypes: true }); } catch { entries = []; }
  const texFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.tex')).map((entry) => entry.name);
  const bibFiles = entries.filter((entry) => entry.isFile() && /\.(bib|bibtex)$/i.test(entry.name)).map((entry) => entry.name);

  const lines = [];
  lines.push(`WORKING DIRECTORY (absolute path): ${workspaceRoot}`);
  lines.push('');
  lines.push('Files in this workspace (read-only; do not modify any file):');
  for (const name of texFiles.sort()) {
    if (name === file) lines.push(`  ${name}    <-- TARGET document`);
    else lines.push(`  ${name}`);
  }
  for (const name of bibFiles.sort()) lines.push(`  ${name}    (bibliography)`);
  for (const { path, description } of LIBRARY_FILES) lines.push(`  ${path}    -- ${description}`);
  lines.push('');
  const target = file
    ? (Number.isInteger(start) && Number.isInteger(end) && end > start
      ? `Read the TARGET document ${file} (JavaScript UTF-16 source-character range [${start}, ${end})), then analyze exactly that range and produce suggestions whose originalText is a contiguous substring of the file.`
      : `Read the TARGET document ${file}, then analyze it and produce suggestions whose originalText is a contiguous substring of the file.`)
    : 'Read the target document before answering.';
  lines.push(target);
  lines.push('When writing-library context is relevant, read the corresponding .papergod/library files first and report the entry ids you actually use in usedResourceIds.');
  return lines.join('\n');
}

function buildPrompt({ prompt, content, resourceContext = '' }) {
  return `You are an academic writing editor. Analyze only the LaTeX document supplied below.
Return JSON matching the required schema. Every originalText must be an exact, contiguous substring of the submitted document. For legacy requests use taskId "task_1", nodeId "", empty usedTemplateIds/usedCitekeys, and unresolvedTasks: [] unless the request supplies them. Do not edit files and do not include Markdown fences.

User editing instruction:
${prompt}

${resourceContext || 'No writing library resources were provided. Return usedResourceIds as an empty array.'}

LaTeX document:
<document>
${content}
</document>`;
}

// Index-style prompt: no document body or library text is inlined; the agent
// reads the workspace on demand. `workspace` = { workspaceRoot, file, start, end }.
const EXACT_TARGET_SENTINEL = '__PAPERGOD_EXACT_TARGET__';

function buildWorkspacePrompt({ prompt, workspace, manifest }) {
  const manifestTransport = manifest?.tasks?.some((task) => task?.target?.matchMode === 'exact')
    ? `\nCompact exact-target transport:\nFor every manifest task whose target.matchMode is "exact", do not repeat its potentially long exactQuote in the response. Set originalText to exactly "${EXACT_TARGET_SENTINEL}". Papergod will restore the already-verified immutable exactQuote by taskId before validation. For substring-within-range tasks, return the actual unique source substring as originalText.`
    : '';
  return `You are an academic writing editor. Return JSON matching the required schema. Every originalText must be an exact, contiguous substring of the TARGET file in the workspace, except for the verified exact-target sentinel protocol below. Each suggestion must include its manifest taskId and nodeId plus usedTemplateIds and usedCitekeys; for legacy requests use taskId "task_1", nodeId "", empty provenance arrays, and unresolvedTasks: []. Do not edit files and do not include Markdown fences.${manifestTransport}

User editing instruction:
${prompt}

${buildWorkspaceIndex(workspace.workspaceRoot, workspace)}`;
}

// Chooses between the legacy inline prompt and the workspace-index prompt.
export function buildSuggestionPrompt(request, options) {
  if (request.workspace && options.workspaceRoot) {
    return buildWorkspacePrompt({
      prompt: request.prompt,
      workspace: { workspaceRoot: options.workspaceRoot, file: request.workspace.file || '', start: request.workspace.start ?? 0, end: request.workspace.end ?? 0 },
      manifest: request.manifest,
    });
  }
  return buildPrompt(request);
}

export function buildSuggestionPayload(provider, request, options) {
  const prompt = buildSuggestionPrompt(request, options);
  const payload = ['opencode', 'pi'].includes(provider) ? withOutputSchema(prompt, SUGGESTION_OUTPUT_SCHEMA) : prompt;
  if (payload.length > MAX_INPUT_CHARS) {
    const error = new AgentError('The final Agent payload exceeds 500,000 characters.', 'AGENT_INPUT_TOO_LARGE', { provider, characters: payload.length, limit: MAX_INPUT_CHARS });
    error.status = 413;
    throw error;
  }
  return payload;
}

// Returns the workspace index text when the request targets a workspace file,
// or null to fall back to inline mode.
function workspaceIndexMaybe(request, options) {
  if (request.workspace && options?.workspaceRoot) {
    return buildWorkspaceIndex(options.workspaceRoot, {
      file: request.workspace.file || '',
      start: request.workspace.start ?? 0,
      end: request.workspace.end ?? 0,
    });
  }
  return null;
}

function buildReviewPrompt(request, options) {
  const reviewer = request.reviewer;
  const rubric = request.rubric || [];
  const profile = `Reviewer profile:
Name: ${reviewer.name}
Role: ${reviewer.role}
Focus: ${reviewer.focus}
Additional instruction: ${reviewer.prompt || 'None'}

Review rubric:
${rubric.map((item) => `- ${item.id}: ${item.title} — ${item.instruction} (weight ${item.weight})`).join('\n')}`;
  const index = workspaceIndexMaybe(request, options);
  if (index) {
    return `You are an independent academic peer reviewer. Read the TARGET document in the workspace and review it from your assigned perspective. Return only JSON matching the required schema. A quote must be an exact contiguous substring of the manuscript or an empty string. Keep each item atomic and assign it to one supplied rubricId. Do not edit files.

${profile}

${index}`;
  }
  return `You are an independent academic peer reviewer. Review only the supplied LaTeX manuscript from your assigned perspective. Do not edit files. Return only JSON matching the required schema. A quote must be an exact contiguous substring of the manuscript or an empty string. Keep each item atomic and assign it to one supplied rubricId.

${profile}

LaTeX manuscript:
<document>
${request.content}
</document>`;
}

function buildPaperGenerationPrompt({ instruction, projectContext, outlineContext, resourceContext }) {
  return `You are drafting a complete academic paper as LaTeX. Return only JSON matching the required schema. The latex field must be a self-contained compilable document. Treat project and outline prompts as writing requirements, not as LaTeX source. Do not use shell escape, file I/O commands, Markdown fences, or invented resource IDs.

User generation instruction:
${instruction}

Project writing context:
${projectContext || 'No project-level context.'}

Required outline and per-element prompts:
${outlineContext || 'Use a conventional abstract, introduction, methods, results, discussion, and conclusion structure.'}

${resourceContext || 'No writing library resources were provided. Return usedResourceIds as an empty array.'}`;
}

function buildReviewOrchestrationPrompt(request, options) {
  const feedback = `Reviewer feedback:
<feedback>
${request.feedback}
</feedback>

Manuscript outline:
${request.outlineContext || 'No outline metadata.'}`;
  const index = workspaceIndexMaybe(request, options);
  if (index) {
    return `You are an academic revision orchestrator. Convert the supplied reviewer feedback into atomic, non-duplicated opinions. Read the TARGET document in the workspace. Return only JSON matching the required schema. For each opinion, quote an exact contiguous manuscript substring when it targets specific text; otherwise use an empty quote for a document-level task. suggestedFix may be empty when author judgment or new evidence is required. dependsOn contains one-based opinion numbers that must be completed first. Do not edit files.

${feedback}

${index}`;
  }
  return `You are an academic revision orchestrator. Convert the supplied reviewer feedback into atomic, non-duplicated opinions. Return only JSON matching the required schema. For each opinion, quote an exact contiguous manuscript substring when it targets specific text; otherwise use an empty quote for a document-level task. suggestedFix may be empty when author judgment or new evidence is required. dependsOn contains one-based opinion numbers that must be completed first. Do not edit files.

${feedback}

LaTeX manuscript:
<document>
${request.content}
</document>`;
}

function withOutputSchema(prompt, schema) {
  return `${prompt}\n\nRequired JSON Schema:\n${JSON.stringify(schema)}`;
}

function validateProviderLifecycle(provider, output) {
  const events = protocolObjects(output).filter((event) => typeof event.type === 'string');
  if (!events.length) return;
  let terminal = true;
  if (provider === 'pi') terminal = events.some((event) => ['message_end', 'agent_end'].includes(event.type));
  else if (provider === 'claude-code') terminal = events.some((event) => event.type === 'result');
  else if (provider === 'opencode') terminal = events.some((event) => event.type === 'step_finish' || (['message', 'text'].includes(event.type) && typeof event.part?.text === 'string'));
  if (!terminal) throw new AgentError('The Agent event stream closed before a terminal result event.', 'AGENT_OUTPUT_TRUNCATED', { provider, diagnostic: output, retryable: true });
}

function parseProviderOutput(provider, parser, output, stderr = '') {
  const failure = classifyAgentCliFailure({ provider, output, stderr });
  if (failure) throw failure;
  validateProviderLifecycle(provider, output);
  try {
    return parser(output);
  } catch (error) {
    const normalized = normalizeAgentError(error, { provider });
    normalized.diagnostic = redactAgentDiagnostic([stderr, output].filter(Boolean).join('\n'));
    throw normalized;
  }
}

function restoreManifestExactTargets(response, manifest) {
  if (!response || !Array.isArray(response.suggestions) || !Array.isArray(manifest?.tasks)) return response;
  const exactTargets = new Map(manifest.tasks
    .filter((task) => task?.target?.matchMode === 'exact' && typeof task.target.exactQuote === 'string' && task.target.exactQuote)
    .map((task) => [task.taskId, task.target.exactQuote]));
  for (const suggestion of response.suggestions) {
    const exactQuote = exactTargets.get(suggestion?.taskId);
    if (exactQuote) suggestion.originalText = exactQuote;
  }
  return response;
}

async function readCodexOutput(outputFile, result, parser, manifest = null) {
  let output = '';
  try { output = await readFile(outputFile, 'utf-8'); } catch (error) {
    const failure = classifyAgentCliFailure({ provider: 'codex', stdout: result.stdout, stderr: result.stderr });
    if (failure) throw failure;
    throw new AgentError('Codex did not create its structured output file.', 'AGENT_PROTOCOL_ERROR', { provider: 'codex', cause: error, diagnostic: [result.stdout, result.stderr].join('\n') });
  }
  const response = parseProviderOutput('codex', parser, output, [result.stdout, result.stderr].filter(Boolean).join('\n'));
  return restoreManifestExactTargets(response, manifest);
}

async function runClaudeStructured(prompt, schema, parser, options) {
  const spec = commandSpec('claude-code', options.commands);
  // Workspace mode grants read-only tools (Read/Grep/Glob) so the agent can
  // read the paper and library files; inline mode keeps tools empty.
  const toolFlag = options.readFromWorkspace ? ['--tools', 'Read,Grep,Glob'] : ['--tools', ''];
  const args = [
    ...spec.prefixArgs,
    '--print',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(schema),
    '--permission-mode', 'plan',
    ...toolFlag,
    '--no-session-persistence',
    ...modelArgs(spec),
    ...reasoningArgs('claude-code', options.reasoningEffort || spec.reasoningEffort),
  ];
  const result = await runProviderProcess('claude-code', spec.command, args, {
    cwd: options.workspaceRoot,
    input: prompt,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    onOutput: options.onOutput,
  });
  return parseProviderOutput('claude-code', parser, result.stdout, result.stderr);
}

async function runClaude(request, options) {
  return runClaudeStructured(buildSuggestionPayload('claude-code', request, options), SUGGESTION_OUTPUT_SCHEMA, parseAgentJson, options);
}

async function runClaudeReview(request, options) {
  return runClaudeStructured(buildReviewPrompt(request, options), REVIEW_OUTPUT_SCHEMA, parseReviewAgentJson, options);
}

async function runClaudePaperGeneration(request, options) {
  return runClaudeStructured(buildPaperGenerationPrompt(request), PAPER_GENERATION_OUTPUT_SCHEMA, parsePaperGenerationJson, options);
}

async function runClaudeReviewOrchestration(request, options) {
  return runClaudeStructured(buildReviewOrchestrationPrompt(request, options), REVIEW_ORCHESTRATION_OUTPUT_SCHEMA, parseReviewOrchestrationJson, options);
}

async function runCodex(request, options) {
  const temporary = await mkdtemp(join(tmpdir(), 'papergod-codex-'));
  try {
    const schemaFile = join(temporary, 'response-schema.json');
    const outputFile = join(temporary, 'last-message.json');
    await writeFile(schemaFile, JSON.stringify(SUGGESTION_OUTPUT_SCHEMA), 'utf-8');
    const spec = commandSpec('codex', options.commands);
    const effectiveEffort = options.liveTest ? 'low' : options.reasoningEffort || spec.reasoningEffort;
    const args = [...spec.prefixArgs, 'exec', ...modelArgs(spec), ...reasoningArgs('codex', effectiveEffort), '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '--output-schema', schemaFile, '--output-last-message', outputFile, '-'];
    const result = await runProviderProcess('codex', spec.command, args, { cwd: options.workspaceRoot, input: buildSuggestionPayload('codex', request, options), timeoutMs: options.timeoutMs, signal: options.signal, onOutput: options.onOutput });
    return await readCodexOutput(outputFile, result, parseAgentJson, request.manifest);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function runOpenCodeStructured(prompt, parser, options, instruction) {
  const temporary = await mkdtemp(join(tmpdir(), 'papergod-opencode-'));
  try {
    const requestFile = join(temporary, 'request.txt');
    const configFile = join(temporary, 'opencode.json');
    // Workspace mode: run against the workspace directory (so the agent can
    // read the paper/library) with read-only permissions; inline mode keeps a
    // deny-only throwaway directory.
    const runDir = options.readFromWorkspace ? options.workspaceRoot : temporary;
    const permission = options.readFromWorkspace
      ? { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow' }
      : 'deny';
    await Promise.all([
      writeFile(requestFile, prompt, 'utf-8'),
      writeFile(configFile, JSON.stringify({ permission }), 'utf-8'),
    ]);
    const spec = commandSpec('opencode', options.commands);
    const args = [...spec.prefixArgs, 'run', instruction, ...modelArgs(spec), ...reasoningArgs('opencode', options.reasoningEffort || spec.reasoningEffort), '--pure', '--format', 'json', '--dir', runDir, '--file', requestFile];
    const result = await runProviderProcess('opencode', spec.command, args, { cwd: runDir, timeoutMs: options.timeoutMs, signal: options.signal, onOutput: options.onOutput, envOverrides: { OPENCODE_CONFIG: configFile } });
    return parseProviderOutput('opencode', parser, result.stdout, result.stderr);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function runOpenCode(request, options) {
  return runOpenCodeStructured(buildSuggestionPayload('opencode', request, options), parseAgentJson, options, 'Follow the attached academic editing request and return only the required JSON.');
}

async function runCodexReview(request, options) {
  const temporary = await mkdtemp(join(tmpdir(), 'papergod-review-codex-'));
  try {
    const schemaFile = join(temporary, 'review-schema.json');
    const outputFile = join(temporary, 'last-message.json');
    await writeFile(schemaFile, JSON.stringify(REVIEW_OUTPUT_SCHEMA), 'utf-8');
    const spec = commandSpec('codex', options.commands);
    const args = [...spec.prefixArgs, 'exec', ...modelArgs(spec), ...reasoningArgs('codex', options.reasoningEffort || spec.reasoningEffort), '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '--output-schema', schemaFile, '--output-last-message', outputFile, '-'];
    const result = await runProviderProcess('codex', spec.command, args, { cwd: options.workspaceRoot, input: buildReviewPrompt(request, options), timeoutMs: options.timeoutMs, signal: options.signal });
    return await readCodexOutput(outputFile, result, parseReviewAgentJson);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function runOpenCodeReview(request, options) {
  return runOpenCodeStructured(withOutputSchema(buildReviewPrompt(request, options), REVIEW_OUTPUT_SCHEMA), parseReviewAgentJson, options, 'Perform the independent peer review and return only the required JSON.');
}

async function runCodexPaperGeneration(request, options) {
  const temporary = await mkdtemp(join(tmpdir(), 'papergod-generate-codex-'));
  try {
    const schemaFile = join(temporary, 'paper-schema.json');
    const outputFile = join(temporary, 'last-message.json');
    await writeFile(schemaFile, JSON.stringify(PAPER_GENERATION_OUTPUT_SCHEMA), 'utf-8');
    const spec = commandSpec('codex', options.commands);
    const args = [...spec.prefixArgs, 'exec', ...modelArgs(spec), ...reasoningArgs('codex', options.reasoningEffort || spec.reasoningEffort), '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '--output-schema', schemaFile, '--output-last-message', outputFile, '-'];
    const result = await runProviderProcess('codex', spec.command, args, { cwd: options.workspaceRoot, input: buildPaperGenerationPrompt(request), timeoutMs: options.timeoutMs, signal: options.signal });
    return await readCodexOutput(outputFile, result, parsePaperGenerationJson);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function runOpenCodePaperGeneration(request, options) {
  return runOpenCodeStructured(withOutputSchema(buildPaperGenerationPrompt(request), PAPER_GENERATION_OUTPUT_SCHEMA), parsePaperGenerationJson, options, 'Generate the complete LaTeX draft and return only the required JSON.');
}

async function runCodexReviewOrchestration(request, options) {
  const temporary = await mkdtemp(join(tmpdir(), 'papergod-orchestrate-codex-'));
  try {
    const schemaFile = join(temporary, 'orchestration-schema.json');
    const outputFile = join(temporary, 'last-message.json');
    await writeFile(schemaFile, JSON.stringify(REVIEW_ORCHESTRATION_OUTPUT_SCHEMA), 'utf-8');
    const spec = commandSpec('codex', options.commands);
    const args = [...spec.prefixArgs, 'exec', ...modelArgs(spec), ...reasoningArgs('codex', options.reasoningEffort || spec.reasoningEffort), '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '--output-schema', schemaFile, '--output-last-message', outputFile, '-'];
    const result = await runProviderProcess('codex', spec.command, args, { cwd: options.workspaceRoot, input: buildReviewOrchestrationPrompt(request, options), timeoutMs: options.timeoutMs, signal: options.signal });
    return await readCodexOutput(outputFile, result, parseReviewOrchestrationJson);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function runOpenCodeReviewOrchestration(request, options) {
  return runOpenCodeStructured(withOutputSchema(buildReviewOrchestrationPrompt(request, options), REVIEW_ORCHESTRATION_OUTPUT_SCHEMA), parseReviewOrchestrationJson, options, 'Orchestrate the review feedback and return only the required JSON.');
}

async function runPiStructured(prompt, parser, options) {
  const temporary = await mkdtemp(join(tmpdir(), 'papergod-pi-'));
  try {
    const requestFile = join(temporary, 'request.txt');
    await writeFile(requestFile, prompt, 'utf-8');
    const spec = commandSpec('pi', options.commands);
    // Workspace mode: allow Pi's read tool so it can read the paper/library
    // files itself; inline mode keeps all tools disabled (analysis-only).
    const toolFlag = options.readFromWorkspace ? ['--tools', 'read'] : ['--no-tools'];
    const args = [
      ...spec.prefixArgs,
      '--print', '--mode', 'json', '--no-session', ...toolFlag, '--no-context-files',
      '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-approve',
      ...modelArgs(spec), ...reasoningArgs('pi', options.reasoningEffort || spec.reasoningEffort), `@${requestFile}`,
      'Follow the attached academic writing request. Return only the required JSON.',
    ];
    const result = await runProviderProcess('pi', spec.command, args, {
      cwd: options.workspaceRoot, timeoutMs: options.timeoutMs, signal: options.signal, onOutput: options.onOutput,
    });
    return parseProviderOutput('pi', parser, result.stdout, result.stderr);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function parsePiProvider(output) {
  const clean = String(output || '').replace(/\x1b\[[0-9;]*m/g, '').replace(/[│├└┌─┐┘]/g, '');
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^provider\s/i.test(line)) continue;
    const match = line.match(/^(\S+)\s+/);
    if (match) return match[1];
  }
  return null;
}

function parsePiModelTable(output) {
  const clean = String(output || '').replace(/\x1b\[[0-9;]*m/g, '').replace(/[│├└┌─┐┘]/g, '');
  const models = [];
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^provider\s/i.test(line) || /^-+/.test(line)) continue;
    const columns = line.split(/\s{2,}/).map((value) => value.trim()).filter(Boolean);
    const provider = columns[0];
    const model = columns[1];
    if (!provider || !model || provider === 'provider') continue;
    models.push({
      id: `${provider}/${model}`,
      label: `${provider} · ${model}`,
      provider,
      model,
      context: columns[2] || '',
      thinking: columns[4] || '',
    });
  }
  return models;
}

function codexConfiguredModel() {
  const configFile = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
  try {
    const content = readFileSync(configFile, 'utf-8');
    const match = content.match(/^\s*model\s*=\s*"([^"]+)"/m);
    return match?.[1] || '';
  } catch {
    return '';
  }
}

// Best-effort model list per provider. Never throws; failures return an empty
// list so the UI falls back to a free-text model field.
export async function listProviderModels(provider, spec, { commands = {}, detailed = false, piModelsResult = null } = {}) {
  const discoveredAt = new Date().toISOString();
  const success = (models, source, warnings = []) => detailed ? { models, source, discoveredAt, stale: false, warnings } : models;
  const failure = (source, error) => detailed ? { models: [], source, discoveredAt, stale: true, warnings: [redactAgentDiagnostic(error?.message || error || 'Model discovery failed', 800)] } : [];
  try {
    if (provider === 'pi') {
      const result = piModelsResult || await runProcess(spec.command, [...spec.prefixArgs, '--list-models'], { timeoutMs: 10_000, allowFailure: true });
      if (result.code !== 0) return failure('pi-cli', result.stderr || `exit ${result.code}`);
      return success(parsePiModelTable(result.stdout), 'pi-cli');
    }
    if (provider === 'codex') {
      const configured = codexConfiguredModel();
      const models = configured ? [{ id: configured, label: `${configured} (configured)`, provider: 'codex', model: configured, context: '', thinking: '' }] : [];
      return success(models, 'codex-config', configured ? [] : ['No model override found; the Codex CLI default will be used.']);
    }
    if (provider === 'opencode') {
      const result = await runProcess(spec.command, [...spec.prefixArgs, 'models'], { timeoutMs: 10_000, allowFailure: true });
      if (result.code !== 0) return failure('opencode-cli', result.stderr || `exit ${result.code}`);
      const clean = String(result.stdout).replace(/\x1b\[[0-9;]*m/g, '');
      const models = [];
      for (const rawLine of clean.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || /^(id|name)\s/i.test(line) || /^-+/.test(line)) continue;
        const columns = line.split(/\s{2,}/).map((value) => value.trim()).filter(Boolean);
        const id = columns[0];
        if (id && !/^(Model|ID|Name)$/i.test(id)) models.push({ id, label: columns[1] ? `${id} · ${columns[1]}` : id, provider: 'opencode', model: id, context: '', thinking: '' });
      }
      return success(models, 'opencode-cli');
    }
    return success([], 'unsupported', ['This CLI does not expose a model-list command used by Papergod.']);
  } catch (error) {
    return failure(`${provider}-cli`, error);
  }
}

async function runPi(request, options) {
  return runPiStructured(buildSuggestionPayload('pi', request, options), parseAgentJson, options);
}

async function runPiReview(request, options) {
  return runPiStructured(withOutputSchema(buildReviewPrompt(request, options), REVIEW_OUTPUT_SCHEMA), parseReviewAgentJson, options);
}

async function runPiPaperGeneration(request, options) {
  return runPiStructured(withOutputSchema(buildPaperGenerationPrompt(request), PAPER_GENERATION_OUTPUT_SCHEMA), parsePaperGenerationJson, options);
}

async function runPiReviewOrchestration(request, options) {
  return runPiStructured(withOutputSchema(buildReviewOrchestrationPrompt(request, options), REVIEW_ORCHESTRATION_OUTPUT_SCHEMA), parseReviewOrchestrationJson, options);
}

export async function detectAgentProviders({ commands = {}, providers = AGENT_PROVIDERS } = {}) {
  const detectProvider = async (provider) => {
    const spec = commandSpec(provider, commands);
    const helpArgs = provider === 'codex' ? ['exec', '--help'] : provider === 'opencode' ? ['run', '--help'] : ['--help'];
    try {
      // Version, auth check, help text, and (for non-pi providers) the model
      // catalog are independent CLI invocations; running them in parallel
      // instead of serially cuts per-provider detection latency substantially
      // (each spawn is 0.5-2.5s, and the model listing is often the slowest
      // call). Pi reuses its auth-step `--list-models` output instead of
      // fetching the catalog separately, so it is excluded from this batch.
      const catalogFallback = { models: [], source: `${provider}-cli`, discoveredAt: new Date().toISOString(), stale: true, warnings: ['Model discovery failed'] };
      const [version, authResult, helpResult, prefetchedCatalog] = await Promise.all([
        runProcess(spec.command, [...spec.prefixArgs, '--version'], { timeoutMs: 5000 }),
        (provider === 'codex' ? runProcess(spec.command, [...spec.prefixArgs, 'login', 'status'], { timeoutMs: 5000, allowFailure: true })
          : provider === 'claude-code' ? runProcess(spec.command, [...spec.prefixArgs, 'auth', 'status'], { timeoutMs: 5000, allowFailure: true })
            : provider === 'opencode' ? runProcess(spec.command, [...spec.prefixArgs, 'auth', 'list'], { timeoutMs: 5000, allowFailure: true })
              : runProcess(spec.command, [...spec.prefixArgs, '--list-models'], { timeoutMs: 10_000, allowFailure: true })).catch(() => null),
        runProcess(spec.command, [...spec.prefixArgs, ...helpArgs], { timeoutMs: 5000, allowFailure: true }).catch(() => null),
        provider === 'pi' ? Promise.resolve(null) : listProviderModels(provider, spec, { commands, detailed: true }).catch(() => catalogFallback),
      ]);
      let authenticated = false;
      let authStatus = 'Authentication not confirmed';
      let piModelsResult = null;
      try {
        if (provider === 'codex') {
          authenticated = authResult?.code === 0;
          authStatus = authenticated ? 'Signed in' : 'Sign-in required';
        } else if (provider === 'claude-code') {
          const parsed = JSON.parse((authResult.stdout || authResult.stderr).trim());
          authenticated = parsed.loggedIn === true;
          authStatus = authenticated ? `Signed in${parsed.authMethod ? ` · ${parsed.authMethod}` : ''}` : 'Sign-in required';
        } else if (provider === 'opencode') {
          const clean = authResult.stdout.replace(/\x1b\[[0-9;]*m/g, '');
          const credentialCount = (clean.match(/●/g) || []).length;
          authenticated = credentialCount > 0;
          authStatus = authenticated ? `${credentialCount} credential source${credentialCount === 1 ? '' : 's'} detected` : 'Provider login required';
        } else {
          piModelsResult = authResult;
          authenticated = false;
          authStatus = piModelsResult?.code === 0 ? 'Installed · run live test to verify credentials' : 'Installed · configure credentials in Pi';
          if (piModelsResult?.code === 0) {
            // Pi: confirm provider readiness with `pi auth check --provider <name> --json`.
            const providerName = parsePiProvider(piModelsResult.stdout) || 'opencode-go';
            const check = await runProcess(spec.command, [...spec.prefixArgs, 'auth', 'check', '--provider', providerName, '--json'], { timeoutMs: 10_000, allowFailure: true });
            if (check.code === 0) {
              try {
                const parsed = JSON.parse(check.stdout.trim());
                authenticated = parsed.status === 'ready';
                authStatus = authenticated ? `Ready · ${parsed.authType || 'authenticated'} (${providerName})` : `Sign-in required (${providerName})`;
              } catch {
                authStatus = `Installed · ${providerName}`;
              }
            }
          }
        }
      } catch {}
      const versionText = (version.stdout || version.stderr).trim();
      const helpText = helpResult ? `${helpResult.stdout}\n${helpResult.stderr}` : '';
      const inspection = inspectCliCapabilities(provider, versionText, helpText);
      const catalog = provider === 'pi' ? await listProviderModels(provider, spec, { commands, detailed: true, piModelsResult }) : (prefetchedCatalog || catalogFallback);
      const health = agentHealthStatus(provider, spec.model);
      return { provider, available: true, authenticated, authStatus, version: versionText, compatible: inspection.compatible, capabilities: inspection.capabilities, warnings: [...inspection.warnings, ...catalog.warnings], models: catalog.models, modelCatalog: catalog, health };
    } catch (error) {
      return { provider, available: false, authenticated: false, authStatus: 'CLI unavailable', version: null, models: [], error: error.code === 'ENOENT' ? 'Not installed' : redactAgentDiagnostic(error.message, 800) };
    }
  };
  const externalProviders = providers.filter((item) => item !== 'mock' && AGENT_PROVIDERS.includes(item));
  const result = await Promise.all(externalProviders.map(detectProvider));
  return [
    ...(providers.includes('mock') ? [{ provider: 'mock', available: true, authenticated: true, authStatus: 'Built in', version: 'built-in' }] : []),
    ...result,
  ];
}

const RETRYABLE_AGENT_CODES = new Set(['AGENT_RATE_LIMITED', 'AGENT_TRANSPORT_ERROR', 'AGENT_TIMEOUT', 'AGENT_OUTPUT_TRUNCATED', 'AGENT_EMPTY_RESPONSE']);
const COOLDOWN_AGENT_CODES = new Set(['AGENT_RATE_LIMITED', 'AGENT_TRANSPORT_ERROR', 'AGENT_TIMEOUT', 'AGENT_EMPTY_RESPONSE', 'AGENT_MODEL_NOT_FOUND']);

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AgentError('Agent run cancelled', 'AGENT_CANCELLED'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new AgentError('Agent run cancelled', 'AGENT_CANCELLED')); }, { once: true });
  });
}

async function runWithRetry(provider, operation, execute, options) {
  const attempts = [];
  const started = Date.now();
  const deadline = started + (options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const maxAttempts = Math.max(1, Math.min(3, Number(options.maxAttempts) || 2));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const spec = commandSpec(provider, options.commands || {});
    const model = options.model || spec.model;
    const healthIdentity = model || `${spec.command} ${spec.prefixArgs.join(' ')}`;
    const memberHealth = agentHealthStatus(provider, healthIdentity);
    if (!memberHealth.available && options.ignoreCooldown !== true) {
      throw new AgentError(`The selected Agent is cooling down after ${memberHealth.reason}.`, 'AGENT_COOLDOWN', { provider, model, retryAfterMs: memberHealth.retryAfterMs });
    }
    const at = Date.now();
    try {
      const remainingBeforeAttempt = deadline - at;
      if (remainingBeforeAttempt <= 0) throw new AgentError('The Agent did not respond before the shared deadline.', 'AGENT_TIMEOUT', { provider });
      options.timeoutMs = remainingBeforeAttempt;
      const result = await execute();
      clearAgentHealth(provider, healthIdentity);
      attempts.push({ attempt, provider, status: 'complete', durationMs: Date.now() - at });
      Object.defineProperty(result, 'agentMeta', { value: { provider, operation, reasoningEffort: options.reasoningEffort, attempts }, enumerable: false });
      return result;
    } catch (rawError) {
      const error = normalizeAgentError(rawError, { provider });
      attempts.push({ attempt, provider, status: 'failed', code: error.code, durationMs: Date.now() - at });
      options.onAttempt?.(attempts.at(-1));
      const retryable = error.retryable === true || RETRYABLE_AGENT_CODES.has(error.code);
      const cooldownEligible = COOLDOWN_AGENT_CODES.has(error.code);
      if (!retryable || attempt >= maxAttempts || options.signal?.aborted) {
        if (cooldownEligible) markAgentUnavailable(provider, healthIdentity, error);
        error.attempts = attempts;
        throw error;
      }
      const remaining = deadline - Date.now();
      const exponentialDelay = 500 * (2 ** (attempt - 1));
      const jitteredDelay = Math.min(10_000, Math.round(exponentialDelay * (0.8 + Math.random() * 0.4)));
      const requestedDelay = error.retryAfterMs || jitteredDelay;
      if (requestedDelay <= 0 || requestedDelay > remaining - 100) {
        if (cooldownEligible) markAgentUnavailable(provider, healthIdentity, error);
        error.attempts = attempts;
        throw error;
      }
      const delay = requestedDelay;
      options.onOutput?.('stderr', `[Papergod] ${error.code}; retrying attempt ${attempt + 1}/${maxAttempts} in ${delay}ms\n`);
      await abortableDelay(delay, options.signal);
    }
  }
  throw new AgentError('Agent retry loop ended unexpectedly', 'AGENT_PROTOCOL_ERROR');
}

export async function runWritingAgent(provider, request, options = {}) {
  if (!AGENT_PROVIDERS.includes(provider) || provider === 'mock') throw new Error(`External adapter unavailable for provider: ${provider}`);
  if (typeof request?.prompt !== 'string' || typeof request?.content !== 'string') throw new Error('prompt and content must be strings');
  if (request.content.length + request.prompt.length > MAX_INPUT_CHARS) throw new Error('Agent input exceeds 500,000 characters');
  const configuredEffort = commandSpec(provider, options.commands || {}).reasoningEffort;
  const reasoningEffort = options.reasoningEffort || operationEffort('suggest', configuredEffort);
  const runtime = { ...options, commands: options.commands || {}, timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS, reasoningEffort, readFromWorkspace: Boolean(request.workspace && options.workspaceRoot) };
  const response = await runWithRetry(provider, 'suggest', () => provider === 'codex' ? runCodex(request, runtime)
    : provider === 'claude-code' ? runClaude(request, runtime)
      : provider === 'opencode' ? runOpenCode(request, runtime)
        : runPi(request, runtime), runtime);
  const validation = validateSuggestionResponse(response, request.content, request.resourceIds || []);
  if (!validation.ok) {
    const error = new Error('Agent response failed validation');
    error.code = 'AGENT_INVALID_RESPONSE';
    error.details = validation.errors;
    throw error;
  }
  return response;
}

export async function runAcademicReviewAgent(provider, request, options = {}) {
  if (!AGENT_PROVIDERS.includes(provider) || provider === 'mock') throw new Error(`External adapter unavailable for provider: ${provider}`);
  if (typeof request?.content !== 'string' || !request?.reviewer || !Array.isArray(request?.rubric)) {
    throw new Error('content, reviewer, and rubric are required');
  }
  const promptSize = JSON.stringify({ reviewer: request.reviewer, rubric: request.rubric }).length;
  if (request.content.length + promptSize > MAX_INPUT_CHARS) throw new Error('Agent input exceeds 500,000 characters');
  const configuredEffort = commandSpec(provider, options.commands || {}).reasoningEffort;
  const reasoningEffort = options.reasoningEffort || operationEffort('review', configuredEffort);
  const runtime = { ...options, commands: options.commands || {}, timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS, reasoningEffort, readFromWorkspace: Boolean(request.workspace && options.workspaceRoot) };
  const response = await runWithRetry(provider, 'review', () => provider === 'codex' ? runCodexReview(request, runtime)
    : provider === 'claude-code' ? runClaudeReview(request, runtime)
      : provider === 'opencode' ? runOpenCodeReview(request, runtime)
        : runPiReview(request, runtime), runtime);
  const validation = validateReviewResponse(response, request.content, request.rubric.map((item) => item.id));
  if (!validation.ok) {
    const error = new Error('Agent review response failed validation');
    error.code = 'AGENT_INVALID_RESPONSE';
    error.details = validation.errors;
    throw error;
  }
  return response;
}

export async function runPaperGenerationAgent(provider, request, options = {}) {
  if (!AGENT_PROVIDERS.includes(provider) || provider === 'mock') throw new Error(`External adapter unavailable for provider: ${provider}`);
  if (typeof request?.instruction !== 'string') throw new Error('instruction must be a string');
  const inputSize = request.instruction.length + String(request.projectContext || '').length + String(request.outlineContext || '').length + String(request.resourceContext || '').length;
  if (inputSize > MAX_INPUT_CHARS) throw new Error('Agent input exceeds 500,000 characters');
  const configuredEffort = commandSpec(provider, options.commands || {}).reasoningEffort;
  const reasoningEffort = options.reasoningEffort || operationEffort('generation', configuredEffort);
  const runtime = { ...options, commands: options.commands || {}, timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS, reasoningEffort };
  const response = await runWithRetry(provider, 'generation', () => provider === 'codex' ? runCodexPaperGeneration(request, runtime)
    : provider === 'claude-code' ? runClaudePaperGeneration(request, runtime)
      : provider === 'opencode' ? runOpenCodePaperGeneration(request, runtime)
        : runPiPaperGeneration(request, runtime), runtime);
  const validation = validatePaperGenerationResponse(response, request.resourceIds || []);
  if (!validation.ok) {
    const error = new Error('Generated paper failed validation'); error.code = 'AGENT_INVALID_RESPONSE'; error.details = validation.errors; throw error;
  }
  return response;
}

export async function runReviewOrchestrationAgent(provider, request, options = {}) {
  if (!AGENT_PROVIDERS.includes(provider) || provider === 'mock') throw new Error(`External adapter unavailable for provider: ${provider}`);
  if (typeof request?.feedback !== 'string' || typeof request?.content !== 'string') throw new Error('feedback and content must be strings');
  if (request.feedback.length + request.content.length + String(request.outlineContext || '').length > MAX_INPUT_CHARS) throw new Error('Agent input exceeds 500,000 characters');
  const configuredEffort = commandSpec(provider, options.commands || {}).reasoningEffort;
  const reasoningEffort = options.reasoningEffort || operationEffort('orchestration', configuredEffort);
  const runtime = { ...options, commands: options.commands || {}, timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS, reasoningEffort, readFromWorkspace: Boolean(request.workspace && options.workspaceRoot) };
  const response = await runWithRetry(provider, 'orchestration', () => provider === 'codex' ? runCodexReviewOrchestration(request, runtime)
    : provider === 'claude-code' ? runClaudeReviewOrchestration(request, runtime)
      : provider === 'opencode' ? runOpenCodeReviewOrchestration(request, runtime)
        : runPiReviewOrchestration(request, runtime), runtime);
  const validation = validateReviewOrchestrationResponse(response, request.content);
  if (!validation.ok) {
    const error = new Error('Review orchestration failed validation'); error.code = 'AGENT_INVALID_RESPONSE'; error.details = validation.errors; throw error;
  }
  return response;
}
