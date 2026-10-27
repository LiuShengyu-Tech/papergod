import { Router } from 'express';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { mkdir, readFile, writeFile, rename } from 'fs/promises';
import { randomUUID } from 'crypto';

export function translationRouter({ file = join(homedir(), '.papergod', 'deepl.json'), fetchImpl = fetch } = {}) {
  const router = Router();
  const cache = new Map();
  const fail = (message, status = 400) => Object.assign(new Error(message), { status });
  async function load() {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw fail('Could not read translation settings.', 500); }
  }
  const summary = config => ({ configured: Boolean(config.apiKey), endpoint: config.endpoint || 'auto' });
  const route = operation => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { res.json(await operation(req)); }
    catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not save translation settings.' }); }
  };
  // Credentials and paid requests must only be accessible from this app's origin.
  router.use((req, res, next) => {
    const origin = req.get('origin');
    if (req.get('sec-fetch-site') === 'cross-site' || (origin && origin !== `${req.protocol}://${req.get('host')}`)) {
      return res.status(403).json({ error: 'Cross-origin translation requests are not allowed.' });
    }
    if (req.method === 'POST' && !req.is('application/json')) return res.status(415).json({ error: 'JSON required.' });
    next();
  });
  async function request(config, path, body) {
    if (!config.apiKey) throw fail('Configure your DeepL API key in Translation settings first.');
    const free = config.endpoint === 'free' || (config.endpoint !== 'pro' && config.apiKey.endsWith(':fx'));
    let response;
    try {
      response = await fetchImpl(`https://${free ? 'api-free' : 'api'}.deepl.com/v2/${path}`, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { Authorization: `DeepL-Auth-Key ${config.apiKey}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw fail('DeepL could not be reached or timed out. Please retry.', 502); }
    if (!response.ok) {
      const messages = { 403: 'DeepL rejected the API key. Check the key and API endpoint.', 429: 'DeepL is rate limiting requests. Please try again later.', 456: 'Your DeepL translation quota has been reached.' };
      throw fail(messages[response.status] || `DeepL request failed (HTTP ${response.status}).`, 502);
    }
    try { return await response.json(); } catch { throw fail('DeepL returned an invalid response.', 502); }
  }
  router.get('/settings', route(async () => summary(await load())));
  router.post('/settings', route(async req => {
    const config = await load();
    const { apiKey, endpoint, removeKey } = req.body;
    if (!['auto', 'free', 'pro'].includes(endpoint)) throw fail('Choose a valid API endpoint.');
    if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length > 512 || /[\r\n\0]/.test(apiKey))) throw fail('Invalid API key.');
    config.endpoint = endpoint;
    if (removeKey) delete config.apiKey;
    else if (apiKey?.trim()) config.apiKey = apiKey.trim();
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(config), { mode: 0o600 });
    await rename(temporary, file);
    cache.clear();
    return summary(config);
  }));
  router.post('/test', route(async () => {
    const usage = await request(await load(), 'usage');
    return { connected: true, characterCount: usage.character_count, characterLimit: usage.character_limit };
  }));
  router.post('/translate', route(async req => {
    const { text } = req.body;
    if (typeof text !== 'string' || !text.trim() || text.length > 12000) throw fail('Provide a sentence of up to 12,000 characters.');
    const config = await load();
    if (!config.apiKey) throw fail('Configure your DeepL API key in Translation settings first.');
    const cacheKey = text.trim();
    if (cache.has(cacheKey)) return { text: cache.get(cacheKey), cached: true };
    const result = await request(config, 'translate', { text: [cacheKey], target_lang: 'ZH-HANS' });
    const translated = result.translations?.[0]?.text;
    if (typeof translated !== 'string' || !translated.trim()) throw fail('DeepL returned no translation.', 502);
    if (cache.size >= 500) cache.delete(cache.keys().next().value);
    cache.set(cacheKey, translated);
    return { text: translated, cached: false };
  }));
  return router;
}
