const DEFAULT_TRANSIENT_COOLDOWN_MS = 60_000;
const DEFAULT_RATE_COOLDOWN_MS = 5 * 60_000;
const health = new Map();

export function agentMemberKey(provider, model = '') {
  return `${provider}/${model || 'default'}`;
}

export function agentHealthStatus(provider, model = '', now = Date.now()) {
  const key = agentMemberKey(provider, model);
  const record = health.get(key);
  if (!record) return { available: true, key };
  if (record.unavailableUntil <= now) {
    health.delete(key);
    return { available: true, key };
  }
  return { available: false, key, ...record, retryAfterMs: record.unavailableUntil - now };
}

export function markAgentUnavailable(provider, model, error, now = Date.now()) {
  const code = error?.code || 'AGENT_PROCESS_FAILED';
  let cooldownMs;
  if (code === 'AGENT_RATE_LIMITED') cooldownMs = error.retryAfterMs || DEFAULT_RATE_COOLDOWN_MS;
  else if (['AGENT_TIMEOUT', 'AGENT_TRANSPORT_ERROR', 'AGENT_EMPTY_RESPONSE', 'AGENT_MODEL_NOT_FOUND'].includes(code)) cooldownMs = error.retryAfterMs || DEFAULT_TRANSIENT_COOLDOWN_MS;
  else return null;
  const key = agentMemberKey(provider, model);
  const unavailableUntil = now + cooldownMs;
  const existing = health.get(key);
  if (!existing || existing.unavailableUntil < unavailableUntil) health.set(key, { unavailableUntil, reason: code });
  return agentHealthStatus(provider, model, now);
}

export function clearAgentHealth(provider, model) {
  if (model !== undefined) return health.delete(agentMemberKey(provider, model));
  for (const key of [...health.keys()]) if (key.startsWith(`${provider}/`)) health.delete(key);
  return true;
}

export function resetAgentHealthForTests() {
  health.clear();
}

export function parseCliVersion(value) {
  const match = String(value || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? { raw: match[0], major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
}

export function versionAtLeast(actual, required) {
  const left = parseCliVersion(actual);
  const right = parseCliVersion(required);
  if (!left || !right) return false;
  const leftParts = [left.major, left.minor, left.patch];
  const rightParts = [right.major, right.minor, right.patch];
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] > rightParts[index]) return true;
    if (leftParts[index] < rightParts[index]) return false;
  }
  return true;
}

export function inspectCliCapabilities(provider, versionText, helpText = '') {
  const help = String(helpText || '');
  const requiredFlags = provider === 'codex' ? ['--output-schema', '--output-last-message', '--ephemeral']
    : provider === 'claude-code' ? ['--json-schema', '--output-format', '--no-session-persistence']
      : provider === 'opencode' ? ['--format', '--pure', '--variant']
        : ['--mode', '--no-session', '--thinking'];
  const missing = requiredFlags.filter((flag) => !help.includes(flag));
  const capabilities = {
    structuredOutput: provider === 'codex' ? help.includes('--output-schema') : provider === 'claude-code' ? help.includes('--json-schema') : help.includes('--format') || help.includes('--mode'),
    eventStream: provider === 'codex' ? help.includes('--json') : provider !== 'claude-code' || /stream-json/.test(help),
    reasoningEffort: provider === 'codex' ? help.includes('--config') : provider === 'claude-code' ? help.includes('--effort') : provider === 'opencode' ? help.includes('--variant') : help.includes('--thinking'),
    ephemeralSession: provider === 'codex' ? help.includes('--ephemeral') : provider === 'claude-code' ? help.includes('--no-session-persistence') : provider === 'opencode' ? help.includes('--pure') : help.includes('--no-session'),
  };
  return {
    installed: true,
    compatible: missing.length === 0,
    version: parseCliVersion(versionText)?.raw || String(versionText || '').trim() || null,
    capabilities,
    warnings: missing.length ? [`Installed CLI is missing required flags: ${missing.join(', ')}`] : [],
  };
}
