import { spawn } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const MAX_INPUT_CHARS = 500_000;
const PROVIDERS = ['mock', 'codex', 'opencode'];

export const SUGGESTION_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'suggestions', 'usedResourceIds'],
  properties: {
    summary: { type: 'string' },
    usedResourceIds: { type: 'array', items: { type: 'string' }, uniqueItems: true },
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
    usedResourceIds: { type: 'array', items: { type: 'string' }, uniqueItems: true },
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
        dependsOn: { type: 'array', items: { type: 'integer', minimum: 1 }, uniqueItems: true },
      },
    } },
  },
};

function safeEnvironment() {
  const blocked = /^(NODE_OPTIONS|BASH_ENV|ENV|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*)$/;
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !blocked.test(key)));
}

function commandSpec(provider, overrides = {}) {
  const override = overrides[provider];
  if (!override) return { command: provider, prefixArgs: [] };
  if (typeof override === 'string') return { command: override, prefixArgs: [] };
  return { command: override.command, prefixArgs: Array.isArray(override.args) ? override.args : [] };
}

export function runProcess(command, args, { cwd, input = '', timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error('Agent run cancelled');
      error.code = 'AGENT_CANCELLED';
      return reject(error);
    }
    const child = spawn(command, args, {
      cwd,
      env: safeEnvironment(),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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

    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      if (code !== 0) {
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
  try {
    const direct = JSON.parse(trimmed);
    if (predicate(direct)) return direct;
  } catch {}

  const candidates = [];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());

  const eventTexts = [];
  for (const line of trimmed.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      const collect = (value) => {
        if (!value || typeof value !== 'object') return;
        if (typeof value.text === 'string') eventTexts.push(value.text);
        Object.values(value).forEach(collect);
      };
      collect(event);
    } catch {}
  }
  if (eventTexts.length) candidates.push(eventTexts.join(''));

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (predicate(parsed)) return parsed;
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

async function runCodex(request, options) {
  const temporary = await mkdtemp(join(tmpdir(), 'papergod-codex-'));
  try {
    const schemaFile = join(temporary, 'response-schema.json');
    const outputFile = join(temporary, 'last-message.json');
    await writeFile(schemaFile, JSON.stringify(SUGGESTION_OUTPUT_SCHEMA), 'utf-8');
    const spec = commandSpec('codex', options.commands);
    const args = [...spec.prefixArgs, 'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '--output-schema', schemaFile, '--output-last-message', outputFile, '-'];
    await runProcess(spec.command, args, { cwd: options.workspaceRoot, input: buildPrompt(request), timeoutMs: options.timeoutMs, signal: options.signal });
    return parseAgentJson(await readFile(outputFile, 'utf-8'));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function runOpenCode(request, options) {
  const temporary = await mkdtemp(join(tmpdir(), 'papergod-opencode-'));
  try {
    const requestFile = join(temporary, 'request.txt');
    await writeFile(requestFile, buildPrompt(request), 'utf-8');
    const spec = commandSpec('opencode', options.commands);
    const args = [...spec.prefixArgs, 'run', '--pure', '--format', 'json', '--dir', options.workspaceRoot, '--file', requestFile, 'Follow the attached academic editing request and return only the required JSON.'];
    const result = await runProcess(spec.command, args, { cwd: options.workspaceRoot, timeoutMs: options.timeoutMs, signal: options.signal });
    return parseAgentJson(result.stdout);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function runCodexReview(request, options) {
  const temporary = await mkdtemp(join(tmpdir(), 'papergod-review-codex-'));
  try {
    const schemaFile = join(temporary, 'review-schema.json');
    const outputFile = join(temporary, 'last-message.json');
    await writeFile(schemaFile, JSON.stringify(REVIEW_OUTPUT_SCHEMA), 'utf-8');
    const spec = commandSpec('codex', options.commands);
    const args = [...spec.prefixArgs, 'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '--output-schema', schemaFile, '--output-last-message', outputFile, '-'];
    await runProcess(spec.command, args, { cwd: options.workspaceRoot, input: buildReviewPrompt(request), timeoutMs: options.timeoutMs, signal: options.signal });
    return parseReviewAgentJson(await readFile(outputFile, 'utf-8'));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function runOpenCodeReview(request, options) {
  const temporary = await mkdtemp(join(tmpdir(), 'papergod-review-opencode-'));
  try {
    const requestFile = join(temporary, 'review-request.txt');
    await writeFile(requestFile, buildReviewPrompt(request), 'utf-8');
    const spec = commandSpec('opencode', options.commands);
    const args = [...spec.prefixArgs, 'run', '--pure', '--format', 'json', '--dir', options.workspaceRoot, '--file', requestFile, 'Perform the independent peer review and return only the required JSON.'];
    const result = await runProcess(spec.command, args, { cwd: options.workspaceRoot, timeoutMs: options.timeoutMs, signal: options.signal });
    return parseReviewAgentJson(result.stdout);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function runCodexPaperGeneration(request, options) {
  const temporary = await mkdtemp(join(tmpdir(), 'papergod-generate-codex-'));
  try {
    const schemaFile = join(temporary, 'paper-schema.json');
    const outputFile = join(temporary, 'last-message.json');
    await writeFile(schemaFile, JSON.stringify(PAPER_GENERATION_OUTPUT_SCHEMA), 'utf-8');
    const spec = commandSpec('codex', options.commands);
    const args = [...spec.prefixArgs, 'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '--output-schema', schemaFile, '--output-last-message', outputFile, '-'];
    await runProcess(spec.command, args, { cwd: options.workspaceRoot, input: buildPaperGenerationPrompt(request), timeoutMs: options.timeoutMs, signal: options.signal });
    return parsePaperGenerationJson(await readFile(outputFile, 'utf-8'));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function runOpenCodePaperGeneration(request, options) {
  const temporary = await mkdtemp(join(tmpdir(), 'papergod-generate-opencode-'));
  try {
    const requestFile = join(temporary, 'paper-request.txt');
    await writeFile(requestFile, buildPaperGenerationPrompt(request), 'utf-8');
    const spec = commandSpec('opencode', options.commands);
    const args = [...spec.prefixArgs, 'run', '--pure', '--format', 'json', '--dir', options.workspaceRoot, '--file', requestFile, 'Generate the complete LaTeX draft and return only the required JSON.'];
    const result = await runProcess(spec.command, args, { cwd: options.workspaceRoot, timeoutMs: options.timeoutMs, signal: options.signal });
    return parsePaperGenerationJson(result.stdout);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function runCodexReviewOrchestration(request, options) {
  const temporary = await mkdtemp(join(tmpdir(), 'papergod-orchestrate-codex-'));
  try {
    const schemaFile = join(temporary, 'orchestration-schema.json');
    const outputFile = join(temporary, 'last-message.json');
    await writeFile(schemaFile, JSON.stringify(REVIEW_ORCHESTRATION_OUTPUT_SCHEMA), 'utf-8');
    const spec = commandSpec('codex', options.commands);
    const args = [...spec.prefixArgs, 'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '--output-schema', schemaFile, '--output-last-message', outputFile, '-'];
    await runProcess(spec.command, args, { cwd: options.workspaceRoot, input: buildReviewOrchestrationPrompt(request), timeoutMs: options.timeoutMs, signal: options.signal });
    return parseReviewOrchestrationJson(await readFile(outputFile, 'utf-8'));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function runOpenCodeReviewOrchestration(request, options) {
  const temporary = await mkdtemp(join(tmpdir(), 'papergod-orchestrate-opencode-'));
  try {
    const requestFile = join(temporary, 'orchestration-request.txt');
    await writeFile(requestFile, buildReviewOrchestrationPrompt(request), 'utf-8');
    const spec = commandSpec('opencode', options.commands);
    const args = [...spec.prefixArgs, 'run', '--pure', '--format', 'json', '--dir', options.workspaceRoot, '--file', requestFile, 'Orchestrate the review feedback and return only the required JSON.'];
    const result = await runProcess(spec.command, args, { cwd: options.workspaceRoot, timeoutMs: options.timeoutMs, signal: options.signal });
    return parseReviewOrchestrationJson(result.stdout);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function detectAgentProviders({ commands = {} } = {}) {
  const result = [];
  for (const provider of ['codex', 'opencode']) {
    const spec = commandSpec(provider, commands);
    try {
      const version = await runProcess(spec.command, [...spec.prefixArgs, '--version'], { timeoutMs: 5000 });
      result.push({ provider, available: true, version: (version.stdout || version.stderr).trim() });
    } catch (error) {
      result.push({ provider, available: false, version: null, error: error.code === 'ENOENT' ? 'Not installed' : error.message });
    }
  }
  return [{ provider: 'mock', available: true, version: 'built-in' }, ...result];
}

export async function runWritingAgent(provider, request, options = {}) {
  if (!PROVIDERS.includes(provider) || provider === 'mock') throw new Error(`External adapter unavailable for provider: ${provider}`);
  if (typeof request?.prompt !== 'string' || typeof request?.content !== 'string') throw new Error('prompt and content must be strings');
  if (request.content.length + request.prompt.length > MAX_INPUT_CHARS) throw new Error('Agent input exceeds 500,000 characters');
  const runtime = { workspaceRoot: options.workspaceRoot, commands: options.commands || {}, timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS, signal: options.signal };
  const response = provider === 'codex' ? await runCodex(request, runtime) : await runOpenCode(request, runtime);
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
  if (!PROVIDERS.includes(provider) || provider === 'mock') throw new Error(`External adapter unavailable for provider: ${provider}`);
  if (typeof request?.content !== 'string' || !request?.reviewer || !Array.isArray(request?.rubric)) {
    throw new Error('content, reviewer, and rubric are required');
  }
  const promptSize = JSON.stringify({ reviewer: request.reviewer, rubric: request.rubric }).length;
  if (request.content.length + promptSize > MAX_INPUT_CHARS) throw new Error('Agent input exceeds 500,000 characters');
  const runtime = { workspaceRoot: options.workspaceRoot, commands: options.commands || {}, timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS, signal: options.signal };
  const response = provider === 'codex' ? await runCodexReview(request, runtime) : await runOpenCodeReview(request, runtime);
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
  if (!PROVIDERS.includes(provider) || provider === 'mock') throw new Error(`External adapter unavailable for provider: ${provider}`);
  if (typeof request?.instruction !== 'string') throw new Error('instruction must be a string');
  const inputSize = request.instruction.length + String(request.projectContext || '').length + String(request.outlineContext || '').length + String(request.resourceContext || '').length;
  if (inputSize > MAX_INPUT_CHARS) throw new Error('Agent input exceeds 500,000 characters');
  const runtime = { workspaceRoot: options.workspaceRoot, commands: options.commands || {}, timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS, signal: options.signal };
  const response = provider === 'codex' ? await runCodexPaperGeneration(request, runtime) : await runOpenCodePaperGeneration(request, runtime);
  const validation = validatePaperGenerationResponse(response, request.resourceIds || []);
  if (!validation.ok) {
    const error = new Error('Generated paper failed validation'); error.code = 'AGENT_INVALID_RESPONSE'; error.details = validation.errors; throw error;
  }
  return response;
}

export async function runReviewOrchestrationAgent(provider, request, options = {}) {
  if (!PROVIDERS.includes(provider) || provider === 'mock') throw new Error(`External adapter unavailable for provider: ${provider}`);
  if (typeof request?.feedback !== 'string' || typeof request?.content !== 'string') throw new Error('feedback and content must be strings');
  if (request.feedback.length + request.content.length + String(request.outlineContext || '').length > MAX_INPUT_CHARS) throw new Error('Agent input exceeds 500,000 characters');
  const runtime = { workspaceRoot: options.workspaceRoot, commands: options.commands || {}, timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS, signal: options.signal };
  const response = provider === 'codex' ? await runCodexReviewOrchestration(request, runtime) : await runOpenCodeReviewOrchestration(request, runtime);
  const validation = validateReviewOrchestrationResponse(response, request.content);
  if (!validation.ok) {
    const error = new Error('Review orchestration failed validation'); error.code = 'AGENT_INVALID_RESPONSE'; error.details = validation.errors; throw error;
  }
  return response;
}
