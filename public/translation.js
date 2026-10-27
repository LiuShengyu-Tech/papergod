import { getLocale } from './i18n.js';

export function initTranslation() {
  const zh = () => getLocale().startsWith('zh');
  const say = (en, cn) => zh() ? cn : en;
  const dialog = document.createElement('dialog');
  dialog.id = 'translation-settings';
  dialog.setAttribute('aria-labelledby', 'translation-settings-title');
  dialog.innerHTML = `<form method="dialog">
    <header><h2 id="translation-settings-title">DeepL</h2><button value="close" aria-label="Close">×</button></header>
    <p id="translation-privacy"></p>
    <label for="deepl-key">DeepL API Key</label><input id="deepl-key" type="password" autocomplete="new-password" spellcheck="false" />
    <label for="deepl-endpoint" id="deepl-endpoint-label"></label>
    <select id="deepl-endpoint"><option value="auto">Auto</option><option value="free">api-free.deepl.com</option><option value="pro">api.deepl.com</option></select>
    <div class="translation-actions"><button type="button" id="deepl-save"></button><button type="button" id="deepl-test"></button><button type="button" id="deepl-remove"></button></div>
    <p id="deepl-status" role="status"></p>
  </form>`;
  document.body.append(dialog);
  const el = id => document.getElementById(id);
  const status = el('deepl-status');
  const key = el('deepl-key');
  const endpoint = el('deepl-endpoint');
  async function api(path, body) {
    const response = await fetch(`/api/translation/${path}`, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Translation request failed.');
    return data;
  }
  function configured(data) {
    endpoint.value = data.endpoint;
    key.value = '';
    key.placeholder = data.configured ? say('Key saved · leave blank to keep', '密钥已保存，留空保留') : say('Paste your DeepL API key', '粘贴 DeepL API 密钥');
    status.textContent = data.configured ? say('API key saved. Test the connection to verify.', '密钥已保存，可测试连接。') : say('No API key configured.', '尚未配置 API 密钥。');
  }
  let busy = false;
  function lock(value) {
    busy = value;
    for (const id of ['deepl-save', 'deepl-test', 'deepl-remove', 'deepl-key', 'deepl-endpoint']) el(id).disabled = value;
  }
  async function open() {
    if (dialog.open) return;
    el('translation-settings-title').textContent = say('DeepL translation settings', 'DeepL 翻译设置');
    el('translation-privacy').textContent = say('The key is stored on this computer, outside paper projects. Clicking Translate sends the current sentence to DeepL. Testing checks usage without translating text.', '密钥保存在本机用户目录，不写入论文项目。点击翻译时将当前句子发送给 DeepL；测试连接只查询用量，不翻译文本。');
    el('deepl-endpoint-label').textContent = say('API endpoint (automatic by default)', 'API 接口（默认自动识别）');
    el('deepl-save').textContent = say('Save', '保存');
    el('deepl-test').textContent = say('Save & test connection', '保存并测试连接');
    el('deepl-remove').textContent = say('Remove key', '移除密钥');
    status.textContent = say('Loading…', '正在读取…');
    dialog.showModal();
    lock(true);
    try { configured(await api('settings')); }
    catch (error) { status.textContent = error.message; }
    finally { lock(false); }
  }
  async function save(test = false, removeKey = false) {
    if (busy) return;
    lock(true);
    status.textContent = say('Connecting…', '正在处理…');
    try {
      configured(await api('settings', { apiKey: key.value, endpoint: endpoint.value, removeKey }));
      if (test) {
        const result = await api('test', {});
        status.textContent = say('DeepL connected.', 'DeepL 连接成功。') + (Number.isFinite(result.characterCount) && Number.isFinite(result.characterLimit) ? ` ${say('Characters used', '已用字符')}：${result.characterCount.toLocaleString()} / ${result.characterLimit.toLocaleString()}` : '');
      }
    } catch (error) { status.textContent = error.message; }
    finally { lock(false); }
  }
  el('deepl-save').onclick = () => save();
  el('deepl-test').onclick = () => save(true);
  el('deepl-remove').onclick = () => save(false, true);
  dialog.addEventListener('close', () => { key.value = ''; });
  el('tool-translation-settings').onclick = open;

  const controls = document.createElement('div');
  controls.className = 'reader-translation';
  controls.innerHTML = '<div class="translation-actions"><button type="button" id="reader-translate"></button><button type="button" id="reader-translation-settings"></button></div><p id="reader-translation-result" aria-live="polite" hidden></p>';
  el('sentence-reader-text').after(controls);
  const translate = el('reader-translate');
  const output = el('reader-translation-result');
  el('reader-translation-settings').onclick = open;
  let generation = 0;
  let sentence = '';
  translate.onclick = async () => {
    if (!sentence) return;
    const current = generation;
    translate.disabled = true;
    output.hidden = false;
    output.textContent = say('Translating with DeepL…', '正在使用 DeepL 翻译…');
    try {
      const result = await api('translate', { text: sentence });
      if (current === generation) output.textContent = result.text;
    } catch (error) {
      if (current === generation) output.textContent = error.message;
    } finally { if (current === generation) translate.disabled = false; }
  };
  return text => {
    generation += 1;
    sentence = text;
    output.hidden = true;
    output.textContent = '';
    translate.disabled = false;
    translate.textContent = say('Translate to Chinese', '翻译成中文');
    el('reader-translation-settings').textContent = say('Translation settings', '翻译设置');
  };
}
