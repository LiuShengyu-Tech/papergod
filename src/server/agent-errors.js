const SECRET_PATTERNS = [
  /(authorization\s*:\s*(?:bearer\s+)?)[^\s,;]+/gi,
  /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|oauth[_-]?token|password)["']?\s*[=:]\s*["']?)[^"'\s,;]+/gi,
  /\b(sk-[a-zA-Z0-9_-]{12,})\b/g,
];

export class AgentError extends Error {
  constructor(message, code, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'AgentError';
    this.code = code;
    if (options.provider) this.provider = options.provider;
    if (options.model) this.model = options.model;
    if (Number.isFinite(options.retryAfterMs)) this.retryAfterMs = options.retryAfterMs;
    if (options.diagnostic) this.diagnostic = redactAgentDiagnostic(options.diagnostic);
    this.retryable = options.retryable === true;
  }
}

export function redactAgentDiagnostic(value, limit = 4000) {
  let text = String(value || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, (_match, prefix) => `${prefix || ''}[REDACTED]`);
  return text.slice(-limit);
}

function retryAfterFrom(text) {
  const match = String(text || '').match(/retry[- ]?after\s*(?:[:=]\s*)?(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?)?/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  return /^m(?!s)/i.test(match[2] || '') ? amount * 60_000 : /^ms|millisecond/i.test(match[2] || '') ? amount : amount * 1000;
}

export function classifyAgentDiagnostic(value, { provider = '', model = '', cause } = {}) {
  const diagnostic = redactAgentDiagnostic(value);
  const lower = diagnostic.toLowerCase();
  const make = (message, code, retryable = false) => new AgentError(message, code, {
    provider, model, cause, diagnostic, retryable, retryAfterMs: retryAfterFrom(diagnostic),
  });
  if (/content[_ -]?filter|finish[_ -]?reason["'\s:=]+content_filter|reason["'\s:=]+content_filter/.test(lower)) {
    return make('The model output was interrupted by the provider content filter. No partial result was applied.', 'AGENT_CONTENT_FILTERED');
  }
  if (/\brefusal\b|\brefused\b|safety refusal|response was blocked/.test(lower)) {
    return make('The model refused this request. No partial result was applied.', 'AGENT_REFUSED');
  }
  if (/max[_ -]?tokens|finish[_ -]?reason["'\s:=]+length|incomplete.*(?:length|token)|output.*truncat/.test(lower)) {
    return make('The model output ended before the structured result was complete.', 'AGENT_OUTPUT_TRUNCATED', true);
  }
  if (/invalid_json_schema|unsupported.*(?:schema|flag)|unknown (?:argument|option)|unrecognized (?:argument|option)/.test(lower)) {
    return make('The installed Agent CLI is incompatible with Papergod’s required structured-output protocol.', 'AGENT_CLI_INCOMPATIBLE');
  }
  if (/rate.?limit|too many requests|\b429\b|quota exceeded|insufficient quota/.test(lower)) {
    return make('The Agent provider rate limit or quota was reached.', 'AGENT_RATE_LIMITED', true);
  }
  if (/unauthorized|forbidden|sign.?in required|log.?in required|authentication failed|\b401\b|\b403\b/.test(lower)) {
    return make('The Agent CLI is installed but its model provider is not authenticated.', 'AGENT_AUTH_REQUIRED');
  }
  if (/model.*(?:not found|unavailable)|unknown model|\b404\b.*model/.test(lower)) {
    return make('The configured Agent model is unavailable.', 'AGENT_MODEL_NOT_FOUND');
  }
  if (/timed? out|timeout/.test(lower)) return make('The Agent did not respond before the timeout.', 'AGENT_TIMEOUT', true);
  if (/econnreset|econnrefused|enotfound|network|socket|transport|connection (?:closed|failed)/.test(lower)) {
    return make('The Agent provider connection failed.', 'AGENT_TRANSPORT_ERROR', true);
  }
  return null;
}

export function normalizeAgentError(error, context = {}) {
  if (error instanceof AgentError) return error;
  const diagnostic = [error?.message, error?.stderr, error?.stdout, error?.diagnostic].filter(Boolean).join('\n');
  const classified = classifyAgentDiagnostic(diagnostic, { ...context, cause: error });
  if (classified) return classified;
  if (error?.code === 'AGENT_CANCELLED' || error?.code === 'AGENT_TIMEOUT' || error?.code === 'AGENT_OUTPUT_LIMIT') return error;
  return new AgentError(error?.message || 'Agent execution failed', error?.code || 'AGENT_PROCESS_FAILED', {
    ...context, cause: error, diagnostic,
  });
}

export function agentFailureAudit(error, limit = 4000) {
  return redactAgentDiagnostic(JSON.stringify({
    code: error?.code || 'AGENT_PROCESS_FAILED',
    message: error?.message || 'Agent execution failed',
    diagnostic: error?.diagnostic || '',
    attempts: Array.isArray(error?.attempts) ? error.attempts : [],
  }), limit);
}

export function incompleteJsonKind(value) {
  const text = String(value || '').trim();
  if (!text) return 'empty';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{' || character === '[') depth += 1;
    else if (character === '}' || character === ']') depth -= 1;
  }
  return inString || depth > 0 ? 'truncated' : 'malformed';
}
