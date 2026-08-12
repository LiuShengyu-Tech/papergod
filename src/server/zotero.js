const DEFAULT_BASE_URL = 'http://127.0.0.1:23119';

async function request(url, { fetchImpl = fetch, timeoutMs = 8000, method = 'GET', body, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method, body: body ? JSON.stringify(body) : undefined, signal: controller.signal,
      headers: { Accept: 'application/json', 'Zotero-API-Version': '3', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    });
    if (!response.ok) throw Object.assign(new Error(response.status === 403 ? 'Enable the Zotero local API in Settings → Advanced.' : `Zotero returned ${response.status}.`), { status: response.status === 403 ? 409 : 502, code: 'ZOTERO_UNAVAILABLE' });
    return response;
  } catch (error) {
    if (error.name === 'AbortError' || error.cause?.code === 'ECONNREFUSED') throw Object.assign(new Error('Zotero Desktop is not running or its local API is unavailable.'), { status: 503, code: 'ZOTERO_UNAVAILABLE' });
    throw error;
  } finally { clearTimeout(timer); }
}

export async function getZoteroStatus(options = {}) {
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const response = await request(`${baseUrl}/api/`, options);
  let betterBibtex = null;
  try {
    const bbt = await request(`${baseUrl}/better-bibtex/json-rpc`, {
      ...options, method: 'POST', body: { jsonrpc: '2.0', method: 'api.ready', params: [], id: 1 }, timeoutMs: 2500,
    });
    betterBibtex = (await bbt.json()).result || null;
  } catch { betterBibtex = null; }
  return {
    connected: true, apiVersion: response.headers.get('zotero-api-version') || '3',
    serverId: response.headers.get('zotero-server-id') || '', betterBibtex,
  };
}

export async function listZoteroCollections({ libraryType = 'users', libraryId = '0', baseUrl = DEFAULT_BASE_URL, ...options } = {}) {
  const response = await request(`${baseUrl}/api/${libraryType}/${encodeURIComponent(libraryId)}/collections?limit=500`, options);
  return (await response.json()).map((entry) => ({ key: entry.key, name: entry.data?.name || '', parentCollection: entry.data?.parentCollection || false, version: entry.version }));
}

function zoteroType(type) {
  if (['conferencePaper', 'presentation'].includes(type)) return 'inproceedings';
  if (['book', 'encyclopediaArticle'].includes(type)) return 'book';
  if (['bookSection'].includes(type)) return 'incollection';
  if (['thesis'].includes(type)) return 'phdthesis';
  if (['report'].includes(type)) return 'techreport';
  return 'article';
}

function citationKey(data, itemKey) {
  if (data.citationKey) return data.citationKey;
  const extra = String(data.extra || '').match(/^Citation Key:\s*(.+)$/im)?.[1]?.trim();
  return extra || `zotero${itemKey.toLowerCase()}`;
}

export function normalizeZoteroItem(entry) {
  const data = entry.data || entry;
  return {
    source: 'zotero', sourceId: entry.key || data.key, citekey: citationKey(data, entry.key || data.key || 'item'),
    type: zoteroType(data.itemType), title: data.title || '',
    authors: (data.creators || []).map((creator) => creator.name || [creator.lastName, creator.firstName].filter(Boolean).join(', ')).filter(Boolean),
    year: String(data.date || '').match(/\d{4}/)?.[0] || '', doi: data.DOI || '', abstract: data.abstractNote || '',
    url: data.url || '', containerTitle: data.publicationTitle || data.conferenceName || '',
    fields: { volume: data.volume || '', number: data.issue || '', pages: data.pages || '', publisher: data.publisher || '', journal: data.publicationTitle || '', booktitle: data.conferenceName || '' },
    confidence: data.DOI ? 1 : 0.85, status: 'verified', zoteroVersion: entry.version || data.version || 0,
  };
}

export async function searchZoteroItems({ libraryType = 'users', libraryId = '0', collectionKey = '', query = '', limit = 100, baseUrl = DEFAULT_BASE_URL, ...options } = {}) {
  const prefix = `${baseUrl}/api/${libraryType}/${encodeURIComponent(libraryId)}`;
  const resource = collectionKey ? `/collections/${encodeURIComponent(collectionKey)}/items/top` : '/items/top';
  const params = new URLSearchParams({ format: 'json', limit: String(Math.min(Math.max(Number(limit) || 100, 1), 200)), itemType: '-attachment' });
  if (query) params.set('q', query);
  const response = await request(`${prefix}${resource}?${params}`, options);
  return (await response.json()).map(normalizeZoteroItem);
}

export async function enrichZoteroAttachment(reference, { libraryType = 'users', libraryId = '0', baseUrl = DEFAULT_BASE_URL, ...options } = {}) {
  const response = await request(`${baseUrl}/api/${libraryType}/${encodeURIComponent(libraryId)}/items/${encodeURIComponent(reference.sourceId)}/children`, options);
  const children = await response.json();
  const attachment = children.find((entry) => entry.data?.itemType === 'attachment' && entry.data?.contentType === 'application/pdf');
  return { ...reference, hasPdf: Boolean(attachment), attachmentKey: attachment?.key || '', attachmentTitle: attachment?.data?.title || '' };
}

export async function getZoteroFullText(attachmentKey, { libraryType = 'users', libraryId = '0', baseUrl = DEFAULT_BASE_URL, ...options } = {}) {
  if (!/^[A-Z0-9]{8}$/i.test(attachmentKey || '')) throw Object.assign(new Error('Invalid Zotero attachment key.'), { status: 400 });
  const response = await request(`${baseUrl}/api/${libraryType}/${encodeURIComponent(libraryId)}/items/${attachmentKey}/fulltext`, options);
  return await response.json();
}

export async function exportBetterBibTeX(citekeys, { baseUrl = DEFAULT_BASE_URL, ...options } = {}) {
  if (!Array.isArray(citekeys) || !citekeys.length) return '';
  const response = await request(`${baseUrl}/better-bibtex/json-rpc`, {
    ...options, method: 'POST', body: { jsonrpc: '2.0', method: 'item.export', params: [citekeys, 'Better BibTeX'], id: 1 },
  });
  const payload = await response.json();
  if (payload.error) throw Object.assign(new Error(payload.error.message || 'Better BibTeX export failed.'), { status: 502 });
  return typeof payload.result === 'string' ? payload.result : '';
}
