import { spawn } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { basename, dirname, extname, join } from 'path';
import { tmpdir } from 'os';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const MAX_INPUT_CHARS = 500_000;
export const AGENT_PROVIDERS = ['mock', 'codex', 'claude-code', 'opencode', 'pi'];

export const SUGGESTION_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'suggestions', 'usedResourceIds'],
  properties: {
    summary: { type: 'string' },
    usedResourceIds: { type: 'array', items: { type: 'string' } },
    suggestions: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['category', 'description', 'originalText', 'suggestedText', 'reason'],
        properties: {
          category: { type: 'string', enum: ['content', 'structure', 'method', 'evidence', 'style', 'grammar', 'citation', 'other'] },
          description: { type: 'string' },
          originalText: { type: 'string' },
          suggestedText: { type: 'string' },
          reason: { type: 'string' },
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
  };
}

function modelArgs(spec) {
  return spec.model ? ['--model', spec.model] : [];
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

export function runProcess(command, args, { cwd, input = '', timeoutMs = DEFAULT_TIMEOUT_MS, signal, allowFailure = false, onOutput } = {}) {
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
    const env = safeEnvironment();
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
        cwd, env, shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    let timer;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (error) reject(error);
      else resolve(result);
    };
    const cancel = () => {
      child.kill('SIGKILL');
      const error = new Error('Agent run cancelled');
      error.code = 'AGENT_CANCELLED';
      finish(error);
    };
    const append = (current, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        const error = new Error('Agent output exceeded 5 MiB');
        error.code = 'AGENT_OUTPUT_LIMIT';
        finish(error);
      }
      return current + chunk.toString('utf-8');
    };

    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); onOutput?.('stdout', chunk.toString('utf-8')); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); onOutput?.('stderr', chunk.toString('utf-8')); });
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      if (code !== 0) {
        if (allowFailure) return finish(null, { stdout, stderr, code, signal });
        const error = new Error((stderr || stdout || `Agent exited with code ${code}`).trim());
        error.code = 'AGENT_PROCESS_FAILED';
        error.exitCode = code;
        error.signal = signal;
        return finish(error);
      }
      finish(null, { stdout, stderr, code });
    });

    signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      const error = new Error(`Agent timed out after ${timeoutMs}ms`);
      error.code = 'AGENT_TIMEOUT';
      finish(error);
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
  const error = new Error('Agent did not return valid JSON');
  error.code = 'AGENT_INVALID_JSON';
  throw error;
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

function buildPrompt({ prompt, content, resourceContext = '' }) {
  return `You are an academic writing editor. Analyze only the LaTeX document supplied below.
Return JSON matching the required schema. Every originalText must be an exact, contiguous substring of the submitted document. Do not edit files and do not include Markdown fences.

User editing instruction:
${prompt}

${resourceContext || 'No writing library resources were provided. Return usedResourceIds as an empty array.'}

LaTeX document:
<document>
${content}
</document>`;
}

function buildReviewPrompt({ content, reviewer, rubric }) {
  return `You are an independent academic peer reviewer. Review only the supplied LaTeX manuscript from your assigned perspective. Do not edit files. Return only JSON matching the required schema. A quote must be an exact contiguous substring of the manuscript or an empty string. Keep each item atomic and assign it to one supplied rubricId.

Reviewer profile:
Name: ${reviewer.name}
Role: ${reviewer.role}
Focus: ${reviewer.focus}
Additional instruction: ${reviewer.prompt || 'None'}

Review rubric:
${rubric.map((item) => `- ${item.id}: ${item.title} — ${item.instruction} (weight ${item.weight})`).join('\n')}

LaTeX manuscript:
<document>
${content}
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

function buildReviewOrchestrationPrompt({ feedback, content, outlineContext = '' }) {
  return `You are an academic revision orchestrator. Convert the supplied reviewer feedback into atomic, non-duplicated opinions. Return only JSON matching the required schema. For each opinion, quote an exact contiguous manuscript substring when it targets specific text; otherwise use an empty quote for a document-level task. suggestedFix may be empty when author judgment or new evidence is required. dependsOn contains one-based opinion numbers that must be completed first. Do not edit files.

Reviewer feedback:
<feedback>
${feedback}
</feedback>

Manuscript outline:
${outlineContext || 'No outline metadata.'}

LaTeX manuscript:
<document>
${content}
</document>`;
}

function withOutputSchema(prompt, schema) {
  return `${prompt}\n\nRequired JSON Schema:\n${JSON.stringify(schema)}`;
}

function parseProviderOutput(parser, output) {
  try {
    return parser(output);
  } catch (error) {
    error.diagnostic = String(output || '').slice(-4000);
    throw error;
  }
}

async function runClaudeStructured(prompt, schema, parser, options) {
  const spec = commandSpec('claude-code', options.commands);
  const args = [
    ...spec.prefixArgs,
    '--print',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(schema),
    '--permission-mode', 'plan',
    '--tools', '',
    '--no-session-persistence',
    ...modelArgs(spec),
  ];
  const result = await runProcess(spec.command, args, {
    cwd: options.workspaceRoot,
    input: prompt,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    onOutput: options.onOutput,
  });
  return parser(result.stdout);
}

async function runClaude(request, options) {
  return runClaudeStructured(buildPrompt(request), SUGGESTION_OUTPUT_SCHEMA, parseAgentJson, options);
}

async function runClaudeReview(request, options) {
  return runClaudeStructured(buildReviewPrompt(request), REVIEW_OUTPUT_SCHEMA, parseReviewAgentJson, options);
}

async function runClaudePaperGeneration(request, options) {
  return runClaudeStructured(buildPaperGenerationPrompt(request), PAPER_GENERATION_OUTPUT_SCHEMA, parsePaperGenerationJson, options);
}

async function runClaudeReviewOrchestration(request, options) {
  return runClaudeStructured(buildReviewOrchestrationPrompt(request), REVIEW_ORCHESTRATION_OUTPUT_SCHEMA, parseReviewOrchestrationJson, options);
}

async function runCodex(request, options) {
  const temporary = await mkdtemp(join(tmpdir(), 'papergod-codex-'));
  try {
    const schemaFile = join(temporary, 'response-schema.json');
    const outputFile = join(temporary, 'last-message.json');
    await writeFile(schemaFile, JSON.stringify(SUGGESTION_OUTPUT_SCHEMA), 'utf-8');
    const spec = commandSpec('codex', options.commands);
    const liveTestArgs = options.liveTest ? ['--config', 'model_reasoning_effort="low"'] : [];
    const args = [...spec.prefixArgs, 'exec', ...modelArgs(spec), ...liveTestArgs, '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '--output-schema', schemaFile, '--output-last-message', outputFile, '-'];
    await runProcess(spec.command, args, { cwd: options.workspaceRoot, input: buildPrompt(request), timeoutMs: options.timeoutMs, signal: options.signal, onOutput: options.onOutput });
    return parseAgentJson(await readFile(outputFile, 'utf-8'));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function runOpenCodeStructured(prompt, parser, options, instruction) {
  const temporary = await mkdtemp(join(tmpdir(), 'papergod-opencode-'));
  try {
    const requestFile = join(temporary, 'request.txt');
    const configFile = join(temporary, 'opencode.json');
    await Promise.all([
      writeFile(requestFile, prompt, 'utf-8'),
      writeFile(configFile, JSON.stringify({ permission: 'deny' }), 'utf-8'),
    ]);
    const spec = commandSpec('opencode', options.commands);
    const args = [...spec.prefixArgs, 'run', instruction, ...modelArgs(spec), '--pure', '--format', 'json', '--dir', temporary, '--file', requestFile];
    const result = await runProcess(spec.command, args, { cwd: temporary, timeoutMs: options.timeoutMs, signal: options.signal, onOutput: options.onOutput });
    return parseProviderOutput(parser, result.stdout);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function runOpenCode(request, options) {
  return runOpenCodeStructured(withOutputSchema(buildPrompt(request), SUGGESTION_OUTPUT_SCHEMA), parseAgentJson, options, 'Follow the attached academic editing request and return only the required JSON.');
}

async function runCodexReview(request, options) {
  const temporary = await mkdtemp(join(tmpdir(), 'papergod-review-codex-'));
  try {
    const schemaFile = join(temporary, 'review-schema.json');
    const outputFile = join(temporary, 'last-message.json');
    await writeFile(schemaFile, JSON.stringify(REVIEW_OUTPUT_SCHEMA), 'utf-8');
    const spec = commandSpec('codex', options.commands);
    const args = [...spec.prefixArgs, 'exec', ...modelArgs(spec), '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '--output-schema', schemaFile, '--output-last-message', outputFile, '-'];
    await runProcess(spec.command, args, { cwd: options.workspaceRoot, input: buildReviewPrompt(request), timeoutMs: options.timeoutMs, signal: options.signal });
    return parseReviewAgentJson(await readFile(outputFile, 'utf-8'));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function runOpenCodeReview(request, options) {
  return runOpenCodeStructured(withOutputSchema(buildReviewPrompt(request), REVIEW_OUTPUT_SCHEMA), parseReviewAgentJson, options, 'Perform the independent peer review and return only the required JSON.');
}

async function runCodexPaperGeneration(request, options) {
  const temporary = await mkdtemp(join(tmpdir(), 'papergod-generate-codex-'));
  try {
    const schemaFile = join(temporary, 'paper-schema.json');
    const outputFile = join(temporary, 'last-message.json');
    await writeFile(schemaFile, JSON.stringify(PAPER_GENERATION_OUTPUT_SCHEMA), 'utf-8');
    const spec = commandSpec('codex', options.commands);
    const args = [...spec.prefixArgs, 'exec', ...modelArgs(spec), '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '--output-schema', schemaFile, '--output-last-message', outputFile, '-'];
    await runProcess(spec.command, args, { cwd: options.workspaceRoot, input: buildPaperGenerationPrompt(request), timeoutMs: options.timeoutMs, signal: options.signal });
    return parsePaperGenerationJson(await readFile(outputFile, 'utf-8'));
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
    const args = [...spec.prefixArgs, 'exec', ...modelArgs(spec), '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '--output-schema', schemaFile, '--output-last-message', outputFile, '-'];
    await runProcess(spec.command, args, { cwd: options.workspaceRoot, input: buildReviewOrchestrationPrompt(request), timeoutMs: options.timeoutMs, signal: options.signal });
    return parseReviewOrchestrationJson(await readFile(outputFile, 'utf-8'));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function runOpenCodeReviewOrchestration(request, options) {
  return runOpenCodeStructured(withOutputSchema(buildReviewOrchestrationPrompt(request), REVIEW_ORCHESTRATION_OUTPUT_SCHEMA), parseReviewOrchestrationJson, options, 'Orchestrate the review feedback and return only the required JSON.');
}

async function runPiStructured(prompt, parser, options) {
  const temporary = await mkdtemp(join(tmpdir(), 'papergod-pi-'));
  try {
    const requestFile = join(temporary, 'request.txt');
    await writeFile(requestFile, prompt, 'utf-8');
    const spec = commandSpec('pi', options.commands);
    const args = [
      ...spec.prefixArgs,
      '--print', '--mode', 'json', '--no-session', '--no-tools', '--no-context-files',
      '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-approve',
      ...modelArgs(spec), `@${requestFile}`,
      'Follow the attached academic writing request. Return only the required JSON.',
    ];
    const result = await runProcess(spec.command, args, {
      cwd: options.workspaceRoot, timeoutMs: options.timeoutMs, signal: options.signal, onOutput: options.onOutput,
    });
    return parseProviderOutput(parser, result.stdout);
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
  const configFile = join(process.env.USERPROFILE || '', '.codex', 'config.toml');
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
export async function listProviderModels(provider, spec, { commands = {} } = {}) {
  try {
    if (provider === 'pi') {
      const result = await runProcess(spec.command, [...spec.prefixArgs, '--list-models'], { timeoutMs: 10_000, allowFailure: true });
      if (result.code !== 0) return [];
      return parsePiModelTable(result.stdout);
    }
    if (provider === 'codex') {
      const configured = codexConfiguredModel();
      return configured ? [{ id: configured, label: `${configured} (configured)`, provider: 'codex', model: configured, context: '', thinking: '' }] : [];
    }
    if (provider === 'opencode') {
      const result = await runProcess(spec.command, [...spec.prefixArgs, 'models'], { timeoutMs: 10_000, allowFailure: true });
      if (result.code !== 0) return [];
      const clean = String(result.stdout).replace(/\x1b\[[0-9;]*m/g, '');
      const models = [];
      for (const rawLine of clean.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || /^(id|name)\s/i.test(line) || /^-+/.test(line)) continue;
        const columns = line.split(/\s{2,}/).map((value) => value.trim()).filter(Boolean);
        const id = columns[0];
        if (id && !/^(Model|ID|Name)$/i.test(id)) models.push({ id, label: columns[1] ? `${id} · ${columns[1]}` : id, provider: 'opencode', model: id, context: '', thinking: '' });
      }
      return models;
    }
    return [];
  } catch {
    return [];
  }
}

async function runPi(request, options) {
  return runPiStructured(withOutputSchema(buildPrompt(request), SUGGESTION_OUTPUT_SCHEMA), parseAgentJson, options);
}

async function runPiReview(request, options) {
  return runPiStructured(withOutputSchema(buildReviewPrompt(request), REVIEW_OUTPUT_SCHEMA), parseReviewAgentJson, options);
}

async function runPiPaperGeneration(request, options) {
  return runPiStructured(withOutputSchema(buildPaperGenerationPrompt(request), PAPER_GENERATION_OUTPUT_SCHEMA), parsePaperGenerationJson, options);
}

async function runPiReviewOrchestration(request, options) {
  return runPiStructured(withOutputSchema(buildReviewOrchestrationPrompt(request), REVIEW_ORCHESTRATION_OUTPUT_SCHEMA), parseReviewOrchestrationJson, options);
}

export async function detectAgentProviders({ commands = {}, providers = AGENT_PROVIDERS } = {}) {
  const detectProvider = async (provider) => {
    const spec = commandSpec(provider, commands);
    try {
      const version = await runProcess(spec.command, [...spec.prefixArgs, '--version'], { timeoutMs: 5000 });
      let authenticated = false;
      let authStatus = 'Authentication not confirmed';
      try {
        if (provider === 'codex') {
          const auth = await runProcess(spec.command, [...spec.prefixArgs, 'login', 'status'], { timeoutMs: 5000, allowFailure: true });
          authenticated = auth.code === 0;
          authStatus = authenticated ? 'Signed in' : 'Sign-in required';
        } else if (provider === 'claude-code') {
          const auth = await runProcess(spec.command, [...spec.prefixArgs, 'auth', 'status'], { timeoutMs: 5000, allowFailure: true });
          const parsed = JSON.parse((auth.stdout || auth.stderr).trim());
          authenticated = parsed.loggedIn === true;
          authStatus = authenticated ? `Signed in${parsed.authMethod ? ` · ${parsed.authMethod}` : ''}` : 'Sign-in required';
        } else if (provider === 'opencode') {
          const auth = await runProcess(spec.command, [...spec.prefixArgs, 'auth', 'list'], { timeoutMs: 5000 });
          const clean = auth.stdout.replace(/\x1b\[[0-9;]*m/g, '');
          const credentialCount = (clean.match(/●/g) || []).length;
          authenticated = credentialCount > 0;
          authStatus = authenticated ? `${credentialCount} credential source${credentialCount === 1 ? '' : 's'} detected` : 'Provider login required';
        } else {
          const models = await runProcess(spec.command, [...spec.prefixArgs, '--list-models'], { timeoutMs: 10_000, allowFailure: true });
          authenticated = false;
          authStatus = models.code === 0 ? 'Installed · run live test to verify credentials' : 'Installed · configure credentials in Pi';
          if (models.code === 0) {
            // Pi: confirm provider readiness with `pi auth check --provider <name> --json`.
            const providerName = parsePiProvider(models.stdout) || 'opencode-go';
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
      const models = await listProviderModels(provider, spec, { commands });
      return { provider, available: true, authenticated, authStatus, version: (version.stdout || version.stderr).trim(), models };
    } catch (error) {
      return { provider, available: false, authenticated: false, authStatus: 'CLI unavailable', version: null, models: [], error: error.code === 'ENOENT' ? 'Not installed' : error.message };
    }
  };
  const externalProviders = providers.filter((item) => item !== 'mock' && AGENT_PROVIDERS.includes(item));
  const result = await Promise.all(externalProviders.map(detectProvider));
  return [
    ...(providers.includes('mock') ? [{ provider: 'mock', available: true, authenticated: true, authStatus: 'Built in', version: 'built-in' }] : []),
    ...result,
  ];
}

export async function runWritingAgent(provider, request, options = {}) {
  if (!AGENT_PROVIDERS.includes(provider) || provider === 'mock') throw new Error(`External adapter unavailable for provider: ${provider}`);
  if (typeof request?.prompt !== 'string' || typeof request?.content !== 'string') throw new Error('prompt and content must be strings');
  if (request.content.length + request.prompt.length > MAX_INPUT_CHARS) throw new Error('Agent input exceeds 500,000 characters');
  const runtime = { workspaceRoot: options.workspaceRoot, commands: options.commands || {}, timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS, signal: options.signal, liveTest: options.liveTest === true, onOutput: options.onOutput };
  const response = provider === 'codex' ? await runCodex(request, runtime)
    : provider === 'claude-code' ? await runClaude(request, runtime)
      : provider === 'opencode' ? await runOpenCode(request, runtime)
        : await runPi(request, runtime);
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
  const runtime = { workspaceRoot: options.workspaceRoot, commands: options.commands || {}, timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS, signal: options.signal };
  const response = provider === 'codex' ? await runCodexReview(request, runtime)
    : provider === 'claude-code' ? await runClaudeReview(request, runtime)
      : provider === 'opencode' ? await runOpenCodeReview(request, runtime)
        : await runPiReview(request, runtime);
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
  const runtime = { workspaceRoot: options.workspaceRoot, commands: options.commands || {}, timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS, signal: options.signal };
  const response = provider === 'codex' ? await runCodexPaperGeneration(request, runtime)
    : provider === 'claude-code' ? await runClaudePaperGeneration(request, runtime)
      : provider === 'opencode' ? await runOpenCodePaperGeneration(request, runtime)
        : await runPiPaperGeneration(request, runtime);
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
  const runtime = { workspaceRoot: options.workspaceRoot, commands: options.commands || {}, timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS, signal: options.signal };
  const response = provider === 'codex' ? await runCodexReviewOrchestration(request, runtime)
    : provider === 'claude-code' ? await runClaudeReviewOrchestration(request, runtime)
      : provider === 'opencode' ? await runOpenCodeReviewOrchestration(request, runtime)
        : await runPiReviewOrchestration(request, runtime);
  const validation = validateReviewOrchestrationResponse(response, request.content);
  if (!validation.ok) {
    const error = new Error('Review orchestration failed validation'); error.code = 'AGENT_INVALID_RESPONSE'; error.details = validation.errors; throw error;
  }
  return response;
}
