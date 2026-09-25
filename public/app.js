import * as pdfjsLib from '/vendor/pdfjs-dist/build/pdf.mjs';
import { getLocale, setLocale, t, translateDom } from '/i18n.js';
import { buildOrderedSentenceMappings, sentenceMappingAt } from '/pdf-sentence-mapping.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs-dist/build/pdf.worker.mjs';

let editor;
let currentFile = 'main.tex';
// The file whose content is actually in the editor; null until a load succeeds,
// so a failed load can never be saved back as an empty file.
let loadedFile = null;
// { entryFile, saved, files } from /api/entry.
let entryState = { entryFile: null, saved: false, files: [] };
let suggestions = [];
let currentDocument = null;
let selectedNode = null;
let libraryData = null;
let extractedCandidates = [];
let selectedResourceIds = new Set();
let lastLibraryUsage = null;
let pendingParagraphDraft = null;
let reviewAnnotations = [];
let reviewRevisions = [];
let selectedAnnotationIds = new Set();
let currentProvider = 'mock';
let peerReviewCatalog = null;
let reviewerDrafts = [];
let rubricDrafts = [];
let peerReviews = [];
let selectedPeerItemIds = new Set();
let workflowHistory = [];
let pendingPaperGeneration = null;
let workspaceView = 'source';
let pdfRenderGeneration = 0;
let pdfLoadingTask = null;
let currentPdfUrl = null;
let pdfRenderedWidth = 0;
const WORKSPACE_VIEW_KEY = 'papergod.workspaceView';
const SPLIT_RATIO_KEY = 'papergod.splitRatio';
const ASSISTANT_COLLAPSED_KEY = 'papergod.assistantCollapsed';
const EDITOR_FONT_KEY = 'papergod.editorFont';
const THEME_KEY = 'papergod.theme';
const OUTLINE_DEPTH_KEY = 'papergod.outlineDepth';
const EDITOR_SCHEME_KEY = 'papergod.editorScheme';
let agentProviders = [];
let agentActivationGeneration = 0;
let currentPromptPreview = null;
let promptPreviewTimer = null;
let focusParagraphId = null;
let focusSentenceId = null;
let focusParagraphDirty = false;
let focusSentenceDirty = false;
let agentActivityController = null;
let agentActivityTimer = null;
let agentActivityStartedAt = 0;
let agentActivityId = null;
let agentActivityPoll = null;
let agentActivitySystemLog = [];
let agentActivityTerminalLog = '';
let agentActivityStage = '';
let lastAiRevisionId = null;
let lastAiIntentIds = [];
let pdfAnnotationTarget = null;
let pdfTextIndex = null;
let pdfSentenceMappings = [];
let pdfHeadingMappings = [];
let pdfMetadataMappings = [];
let lastCompiledSource = null;
let lastCompiledSentenceSnapshot = [];
let recentChangedSentenceIds = new Set();
let pdfHoverFrame = null;
let pdfHoverKey = '';
let latexEngineAvailable = false;
let modificationIntents = [];
let sentenceReaderItems = [];
let sentenceReaderIndex = 0;
let sentenceReaderWord = null;
let changeHistoryEntries = [];
let selectedChangeHistoryId = null;
let historyPdfLoadingTask = null;
let historyPdfRenderGeneration = 0;
let historyDiffMarks = [];
let activeHistoryDiffIndex = 0;
let workspaceManagerData = null;
let terminalSessionId = null;
let terminalView = null;
let terminalFitAddon = null;
let terminalEvents = null;
let terminalResizeObserver = null;
let referenceData = null;
let zoteroReferenceResults = [];
let selectedReferenceCitekeys = new Set();
let appVersionInfo = null;

class ModificationIntent {
  constructor(annotation) {
    this.id = annotation.id;
    this.documentId = annotation.documentId;
    this.scope = annotation.source?.actor?.split(':')[1] || annotation.target?.type || 'sentence';
    this.nodeId = annotation.target?.id || '';
    this.start = annotation.target?.start || 0;
    this.end = annotation.target?.end || 0;
    this.quote = annotation.target?.quote || '';
    this.comment = annotation.body || '';
    this.createdAt = annotation.createdAt || '';
    this.positional = annotation.target?.type === 'document' && this.quote.startsWith('PDF page');
  }

  toPrompt(index) {
    return [
      `Modification intent ${index + 1} (${this.scope})`,
      `${this.positional ? 'PDF position/context (locate the corresponding LaTeX semantically)' : 'Exact source target'}: ${this.quote}`,
      `Author instruction: ${this.comment}`,
    ].join('\n');
  }
}

// Programmatic calls (navigation, citation insertion, compile) ask for 'source' or
// 'preview' only to make that pane visible; in split view both already are, so
// only an explicit user choice ({ user: true }) leaves split view.
function setWorkspaceView(view, { user = false } = {}) {
  if (view === 'preview' && document.getElementById('preview-view-btn').disabled) return;
  if (workspaceView === 'split' && !user) {
    if (view === 'source' && editor) requestAnimationFrame(() => editor.refresh());
    return;
  }
  workspaceView = view;
  if (user) storePreference(WORKSPACE_VIEW_KEY, view);
  const split = view === 'split';
  const showSource = split || view === 'source';
  const showPreview = split || view === 'preview';
  document.getElementById('workspace-view').classList.toggle('split', split);
  document.getElementById('split-divider').classList.toggle('hidden', !split);
  document.getElementById('source-view').classList.toggle('hidden', !showSource);
  document.getElementById('preview-panel').classList.toggle('hidden', !showPreview);
  for (const [id, active] of [['source-view-btn', view === 'source'], ['preview-view-btn', view === 'preview'], ['split-view-btn', split]]) {
    const button = document.getElementById(id);
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  }
  if (showSource && editor) requestAnimationFrame(() => editor.refresh());
}

function sourceVisible() { return workspaceView !== 'preview'; }
function previewVisible() { return workspaceView !== 'source'; }

function readPreference(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function storePreference(key, value) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* storage unavailable: preference lasts for this page only */ }
}

// Pages are rendered fit-to-width, so a pane resize (split divider, folding the
// assistant, window resize) re-renders the current PDF at the new width.
function initPdfAutoFit() {
  const container = document.getElementById('pdf-preview');
  let timer = null;
  new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const width = container.clientWidth;
      if (!currentPdfUrl || !width || Math.abs(width - pdfRenderedWidth) < 24) return;
      const scrollRatio = container.scrollHeight ? container.scrollTop / container.scrollHeight : 0;
      showCompiledPdf(currentPdfUrl, { switchView: false }).then(() => {
        container.scrollTop = scrollRatio * container.scrollHeight;
      });
    }, 220);
  }).observe(container);
}

function applySplitRatio(ratio) {
  const clamped = Math.min(0.8, Math.max(0.2, ratio));
  document.getElementById('workspace-view').style.setProperty('--split-source', `${(clamped * 100).toFixed(2)}%`);
  return clamped;
}

function initSplitDivider() {
  const divider = document.getElementById('split-divider');
  const view = document.getElementById('workspace-view');
  let ratio = applySplitRatio(Number(readPreference(SPLIT_RATIO_KEY)) || 0.5);
  const commit = () => { storePreference(SPLIT_RATIO_KEY, ratio.toFixed(4)); editor?.refresh(); };
  divider.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button')) return;
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
    view.classList.add('resizing');
    const bounds = view.getBoundingClientRect();
    const move = (moveEvent) => { ratio = applySplitRatio((moveEvent.clientX - bounds.left) / bounds.width); };
    const up = () => {
      divider.removeEventListener('pointermove', move);
      divider.removeEventListener('pointerup', up);
      divider.removeEventListener('pointercancel', up);
      view.classList.remove('resizing');
      commit();
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', up);
    divider.addEventListener('pointercancel', up);
  });
  divider.addEventListener('dblclick', (event) => {
    if (event.target.closest('button')) return;
    ratio = applySplitRatio(0.5);
    commit();
  });
  divider.addEventListener('keydown', (event) => {
    const step = event.key === 'ArrowLeft' ? -0.05 : event.key === 'ArrowRight' ? 0.05 : 0;
    if (!step) return;
    event.preventDefault();
    ratio = applySplitRatio(ratio + step);
    commit();
  });
}

// Source <-> PDF synchronization for the split-view arrows. Both directions reuse
// the text-layer mappings built after each render (pdfSentenceMappings for body
// sentences, pdfHeadingMappings for the title and section headings).
function pdfSyncTargets() {
  const targets = [];
  for (const mapping of pdfSentenceMappings) {
    const range = mapping.sentence?.sourceRange;
    if (range) targets.push({ pdf: mapping, source: range });
  }
  for (const mapping of pdfHeadingMappings) {
    const range = headingSourceRange(mapping.node) || mapping.node.sourceRange;
    if (range) targets.push({ pdf: mapping, source: range });
  }
  return targets;
}

function pdfReadyForSync() {
  if (document.querySelector('#pdf-preview .pdf-page') && pdfTextIndex) return true;
  showStatus(t('sync.compileFirst'), '');
  return false;
}

function flashPdfRange(range) {
  highlightPdfRanges(pdfTextIndex, [range], 'outline');
  const marks = [...document.querySelectorAll('.pdf-active-highlight')];
  setTimeout(() => marks.forEach((mark) => mark.remove()), 1600);
}

function syncPdfToCursor() {
  if (!pdfReadyForSync()) return;
  const cursor = editor.indexFromPos(editor.getCursor());
  const targets = pdfSyncTargets();
  // Prefer the innermost range containing the cursor; otherwise the nearest one before it.
  const containing = targets
    .filter(({ source }) => source.start <= cursor && cursor <= source.end)
    .sort((a, b) => (a.source.end - a.source.start) - (b.source.end - b.source.start))[0];
  const target = containing || targets
    .filter(({ source }) => source.start <= cursor)
    .sort((a, b) => b.source.start - a.source.start)[0] || targets.sort((a, b) => a.source.start - b.source.start)[0];
  if (!target || !scrollPdfToRange(pdfTextIndex, target.pdf)) {
    showStatus(t('sync.notFound'), '');
    return;
  }
  flashPdfRange(target.pdf);
}

function syncCursorToPdf() {
  if (!pdfReadyForSync()) return;
  const viewTop = document.getElementById('pdf-preview').getBoundingClientRect().top + 8;
  const targets = pdfSyncTargets().sort((a, b) => a.pdf.start - b.pdf.start);
  // First mapped text whose line starts inside the visible area of the PDF pane.
  const target = targets.find(({ pdf }) => {
    for (let position = pdf.start; position < pdf.end; position += 1) {
      const span = pdfTextIndex.positions[position]?.span;
      if (span) return span.getBoundingClientRect().top >= viewTop;
    }
    return false;
  }) || targets.at(-1);
  if (!target) {
    showStatus(t('sync.notFound'), '');
    return;
  }
  const from = editor.posFromIndex(target.source.start);
  const to = editor.posFromIndex(target.source.end);
  editor.setCursor(from);
  editor.scrollTo(null, Math.max(0, editor.charCoords(from, 'local').top - 48));
  const mark = editor.markText(from, to, { className: 'cm-sync-flash' });
  setTimeout(() => mark.clear(), 1600);
  editor.focus();
}

// The source editor's color scheme is independent of the app theme; see
// editor-schemes.css. main.jsx applies the saved scheme before first paint.
function applyEditorScheme(scheme) {
  document.documentElement.dataset.editorScheme = scheme;
  document.querySelectorAll('[data-scheme-option]').forEach((option) => {
    option.setAttribute('aria-checked', String(option.dataset.schemeOption === scheme));
  });
  if (editor) editor.refresh();
}

function initEditorScheme() {
  const popover = document.getElementById('editor-scheme-popover');
  const trigger = document.getElementById('editor-scheme-btn');
  const options = [...popover.querySelectorAll('[data-scheme-option]')];
  const known = new Set(options.map((option) => option.dataset.schemeOption));
  const saved = readPreference(EDITOR_SCHEME_KEY);
  applyEditorScheme(known.has(saved) ? saved : 'white');
  const open = (show) => {
    popover.classList.toggle('hidden', !show);
    trigger.setAttribute('aria-expanded', String(show));
    if (show) (popover.querySelector('[aria-checked="true"]') || options[0]).focus();
  };
  options.forEach((option) => option.addEventListener('click', () => {
    applyEditorScheme(option.dataset.schemeOption);
    storePreference(EDITOR_SCHEME_KEY, option.dataset.schemeOption);
  }));
  trigger.addEventListener('click', () => open(popover.classList.contains('hidden')));
  document.getElementById('editor-scheme-close').addEventListener('click', () => open(false));
  document.addEventListener('pointerdown', (event) => {
    if (popover.classList.contains('hidden') || popover.contains(event.target) || trigger.contains(event.target)) return;
    open(false);
  });
  popover.addEventListener('keydown', (event) => {
    const index = options.indexOf(document.activeElement);
    const step = { ArrowRight: 1, ArrowDown: 2, ArrowLeft: -1, ArrowUp: -2 }[event.key];
    if (event.key === 'Escape') { open(false); trigger.focus(); }
    else if (step && index >= 0) {
      event.preventDefault();
      options[(index + step + options.length) % options.length].focus();
    }
  });
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const toggle = document.getElementById('theme-toggle');
  toggle.setAttribute('aria-pressed', String(theme === 'dark'));
  toggle.title = t(theme === 'dark' ? 'theme.toLight' : 'theme.toDark');
}

function initThemeToggle() {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  document.getElementById('theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    storePreference(THEME_KEY, next);
    applyTheme(next);
  });
  // Follow the OS setting until the user picks a theme explicitly.
  try {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
      if (!readPreference(THEME_KEY)) applyTheme(event.matches ? 'dark' : 'light');
    });
  } catch { /* matchMedia unavailable */ }
}

function setAssistantCollapsed(collapsed, { persist = true } = {}) {
  document.getElementById('app').classList.toggle('assistant-collapsed', collapsed);
  document.getElementById('assistant-collapse').setAttribute('aria-expanded', String(!collapsed));
  if (persist) storePreference(ASSISTANT_COLLAPSED_KEY, collapsed ? '1' : null);
  if (editor) requestAnimationFrame(() => editor.refresh());
}

const EDITOR_FONT_DEFAULTS = { family: '', size: 13, lineHeight: '1.65' };

function loadEditorFontSettings() {
  try {
    const saved = JSON.parse(readPreference(EDITOR_FONT_KEY) || '{}');
    const size = Number(saved.size);
    return {
      family: typeof saved.family === 'string' ? saved.family : EDITOR_FONT_DEFAULTS.family,
      size: Number.isFinite(size) && size >= 8 && size <= 36 ? size : EDITOR_FONT_DEFAULTS.size,
      lineHeight: ['1.3', '1.5', '1.65', '1.8', '2'].includes(saved.lineHeight) ? saved.lineHeight : EDITOR_FONT_DEFAULTS.lineHeight,
    };
  } catch {
    return { ...EDITOR_FONT_DEFAULTS };
  }
}

function applyEditorFontSettings(settings) {
  const root = document.documentElement.style;
  if (settings.family) root.setProperty('--editor-font-family', settings.family);
  else root.removeProperty('--editor-font-family');
  root.setProperty('--editor-font-size', `${settings.size}px`);
  root.setProperty('--editor-line-height', settings.lineHeight);
  if (editor) editor.refresh();
}

function initEditorSettings() {
  const popover = document.getElementById('editor-settings-popover');
  const trigger = document.getElementById('editor-settings-btn');
  const familySelect = document.getElementById('editor-font-family');
  const customInput = document.getElementById('editor-font-custom');
  const sizeInput = document.getElementById('editor-font-size');
  const lineHeightSelect = document.getElementById('editor-line-height');
  let settings = loadEditorFontSettings();

  const render = () => {
    const preset = [...familySelect.options].some((option) => option.value === settings.family && option.value !== 'custom');
    familySelect.value = preset ? settings.family : 'custom';
    customInput.classList.toggle('hidden', preset);
    if (!preset) customInput.value = settings.family;
    sizeInput.value = String(settings.size);
    lineHeightSelect.value = settings.lineHeight;
  };
  const update = (patch) => {
    settings = { ...settings, ...patch };
    applyEditorFontSettings(settings);
    storePreference(EDITOR_FONT_KEY, JSON.stringify(settings));
  };
  const setSize = (value) => {
    const size = Math.round(Number(value));
    if (!Number.isFinite(size)) return;
    update({ size: Math.min(36, Math.max(8, size)) });
    sizeInput.value = String(settings.size);
  };
  const open = (show) => {
    popover.classList.toggle('hidden', !show);
    trigger.setAttribute('aria-expanded', String(show));
    if (show) { render(); familySelect.focus(); }
  };

  applyEditorFontSettings(settings);
  familySelect.addEventListener('change', () => {
    if (familySelect.value === 'custom') {
      customInput.classList.remove('hidden');
      customInput.focus();
      if (customInput.value.trim()) update({ family: customInput.value.trim() });
    } else {
      customInput.classList.add('hidden');
      update({ family: familySelect.value });
    }
  });
  customInput.addEventListener('input', () => update({ family: customInput.value.trim() }));
  sizeInput.addEventListener('change', () => setSize(sizeInput.value));
  document.getElementById('editor-font-size-down').addEventListener('click', () => setSize(settings.size - 1));
  document.getElementById('editor-font-size-up').addEventListener('click', () => setSize(settings.size + 1));
  lineHeightSelect.addEventListener('change', () => update({ lineHeight: lineHeightSelect.value }));
  document.getElementById('editor-settings-reset').addEventListener('click', () => { update({ ...EDITOR_FONT_DEFAULTS }); render(); });
  trigger.addEventListener('click', () => open(popover.classList.contains('hidden')));
  document.getElementById('tool-editor-settings').addEventListener('click', () => open(true));
  document.getElementById('editor-settings-close').addEventListener('click', () => open(false));
  document.addEventListener('pointerdown', (event) => {
    if (popover.classList.contains('hidden') || popover.contains(event.target) || trigger.contains(event.target)) return;
    if (event.target.closest('#tool-editor-settings')) return;
    open(false);
  });
  popover.addEventListener('keydown', (event) => { if (event.key === 'Escape') { open(false); trigger.focus(); } });
}

async function showCompiledPdf(url, { switchView = true } = {}) {
  const renderGeneration = ++pdfRenderGeneration;
  const container = document.getElementById('pdf-preview');
  const placeholder = document.getElementById('preview-placeholder');
  if (pdfLoadingTask) await pdfLoadingTask.destroy().catch(() => {});
  currentPdfUrl = url;
  document.getElementById('pdf-scope-menu').classList.add('hidden');
  document.getElementById('pdf-edit-menu').classList.add('hidden');
  clearPdfScopeHighlight();
  clearPdfHoverHighlight();
  pdfTextIndex = null;
  pdfSentenceMappings = [];
  container.replaceChildren();
  placeholder.textContent = 'Rendering paper…';
  placeholder.classList.remove('hidden');
  document.getElementById('preview-view-btn').disabled = false;
  if (switchView) setWorkspaceView('preview');
  try {
    if (switchView) {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (renderGeneration !== pdfRenderGeneration) return;
    }
    const pdfUrl = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
    pdfLoadingTask = pdfjsLib.getDocument({ url: pdfUrl, isEvalSupported: false });
    const pdf = await pdfLoadingTask.promise;
    pdfRenderedWidth = container.clientWidth;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      if (renderGeneration !== pdfRenderGeneration) return;
      const page = await pdf.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const availableWidth = Math.max(320, container.clientWidth - 32);
      const viewport = page.getViewport({ scale: availableWidth / baseViewport.width });
      const outputScale = Math.min(window.devicePixelRatio || 1, 2);
      const pageElement = document.createElement('div');
      pageElement.className = 'pdf-page';
      pageElement.style.width = `${Math.floor(viewport.width)}px`;
      pageElement.style.height = `${Math.floor(viewport.height)}px`;
      pageElement.style.setProperty('--scale-factor', viewport.scale);
      pageElement.setAttribute('role', 'document');
      pageElement.setAttribute('aria-label', 'PDF page ' + pageNumber + ' of ' + pdf.numPages);
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = Math.floor(viewport.width) + 'px';
      canvas.style.height = Math.floor(viewport.height) + 'px';
      pageElement.appendChild(canvas);
      const textLayer = document.createElement('div');
      textLayer.className = 'textLayer pdf-text-layer';
      textLayer.style.width = `${Math.floor(viewport.width)}px`;
      textLayer.style.height = `${Math.floor(viewport.height)}px`;
      pageElement.appendChild(textLayer);
      container.appendChild(pageElement);
      await page.render({
        canvasContext: canvas.getContext('2d', { alpha: false }),
        viewport,
        transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
      }).promise;
      const textContent = await page.getTextContent();
      await new pdfjsLib.TextLayer({ textContentSource: textContent, container: textLayer, viewport }).render();
      const renderedSpans = [...textLayer.querySelectorAll('span')];
      const textItems = textContent.items.filter((item) => item.str?.trim());
      let itemCursor = 0;
      renderedSpans.forEach((span) => {
        const searchEnd = Math.min(textItems.length, itemCursor + 12);
        let matchedItem = -1;
        for (let candidate = itemCursor; candidate < searchEnd; candidate += 1) {
          if (textItems[candidate].str === span.textContent) { matchedItem = candidate; break; }
        }
        if (matchedItem !== -1) {
          span.dataset.pdfHasEol = String(Boolean(textItems[matchedItem].hasEOL));
          itemCursor = matchedItem + 1;
        }
      });
      textLayer.addEventListener('click', handlePdfTextClick);
      textLayer.addEventListener('pointermove', handlePdfTextHover);
      textLayer.addEventListener('pointerleave', clearPdfHoverHighlight);
      if (renderGeneration === pdfRenderGeneration) {
        // Keep already-rendered pages interactive while later pages continue rendering.
        pdfTextIndex = buildPdfTextIndex();
        rebuildPdfSentenceMappings();
      }
    }
    if (renderGeneration === pdfRenderGeneration) placeholder.classList.add('hidden');
  } catch (error) {
    if (renderGeneration !== pdfRenderGeneration) return;
    placeholder.textContent = 'PDF rendering failed';
    placeholder.classList.remove('hidden');
    showStatus(error?.message || 'PDF rendering failed', 'error');
  }
}

function canonicalPdfUnit(value) {
  return String(value || '')
    .replace(/\u001b/g, 'ff').replace(/\u001c/g, 'fi').replace(/\u001d/g, 'fl')
    .replace(/\u001e/g, 'ffi').replace(/\u001f/g, 'ffl')
    .replace(/[\u0010-\u0013]/g, '"')
    .normalize('NFKC')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[‐‑‒–—]/g, '-')
    .toLocaleLowerCase().replace(/\s+/g, ' ');
}

function canonicalPdfText(value) {
  return canonicalPdfUnit(value).trim();
}

function sourceMatchText(value) {
  let result = String(value || '').replace(/~/g, ' ').replace(/\\([%&_#$])/g, '$1');
  result = result
    .replace(/\\href\*?\{[^{}]*\}\{([^{}]*)\}/g, '$1')
    .replace(/\\(?:cite\w*|ref|eqref|pageref|autoref|label)\*?(?:\[[^\]]*\])*\{[^{}]*\}/g, ' ');
  for (let pass = 0; pass < 3; pass += 1) {
    result = result.replace(/\\(?:emph|textbf|textit|textrm|texttt|underline|mbox)\*?(?:\[[^\]]*\])?\{([^{}]*)\}/g, '$1');
  }
  return canonicalPdfText(result.replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?/g, '').replace(/[{}]/g, ''));
}

function latexCommandMetadata(source, command) {
  const matcher = new RegExp(`\\\\${command}\\s*(?:\\[[^\\]]*\\]\\s*)?\\{`, 'g');
  const match = matcher.exec(source);
  if (!match) return null;
  const contentStart = match.index + match[0].length;
  let depth = 1;
  let cursor = contentStart;
  for (; cursor < source.length && depth > 0; cursor += 1) {
    if (source[cursor] === '{' && source[cursor - 1] !== '\\') depth += 1;
    if (source[cursor] === '}' && source[cursor - 1] !== '\\') depth -= 1;
  }
  if (depth !== 0) return null;
  const contentEnd = cursor - 1;
  const raw = source.slice(contentStart, contentEnd).trim();
  const leading = source.slice(contentStart, contentEnd).indexOf(raw);
  const displayText = sourceMatchText(raw.replace(/\\\\/g, ' ').replace(/\\and\b/g, ' '));
  if (!raw || !displayText) return null;
  return {
    command,
    label: command[0].toUpperCase() + command.slice(1),
    raw,
    displayText,
    sourceRange: { start: contentStart + Math.max(0, leading), end: contentStart + Math.max(0, leading) + raw.length },
  };
}

function buildPdfTextIndex(root = document, selector = '.pdf-text-layer') {
  const characters = [];
  const positions = [];
  const spanRanges = new Map();
  const append = (raw, span = null) => {
    for (let offset = 0; offset < raw.length; offset += 1) {
      const normalized = canonicalPdfUnit(raw[offset]);
      if (!normalized) continue;
      for (const character of normalized) {
        if (character === ' ' && characters.at(-1) === ' ') continue;
        characters.push(character);
        positions.push(span ? { span, node: span.firstChild, offset } : null);
      }
    }
  };
  let previousSpan = null;
  root.querySelectorAll(selector).forEach((layer, layerIndex) => {
    if (layerIndex > 0) append(' ');
    previousSpan = null;
    layer.querySelectorAll('span').forEach((span) => {
      const text = span.textContent || '';
      if (!text) return;
      if (previousSpan) {
        const previousRect = previousSpan.getBoundingClientRect();
        const currentRect = span.getBoundingClientRect();
        const lineBreak = previousSpan.dataset.pdfHasEol === 'true'
          || Math.abs(currentRect.top - previousRect.top) > Math.max(2, previousRect.height * 0.55);
        const visibleGap = currentRect.left - previousRect.right > Math.max(1, previousRect.height * 0.12);
        if (lineBreak && characters.at(-1) === '-') {
          characters.pop(); positions.pop();
        } else if ((lineBreak || visibleGap) && !/\s$/.test(previousSpan.textContent || '') && !/^\s|^[,.;:!?%)\]}]/.test(text)) append(' ');
      }
      const start = characters.length;
      append(text, span);
      spanRanges.set(span, { start, end: characters.length });
      previousSpan = span;
    });
  });
  const rawText = characters.join('');
  const leading = rawText.length - rawText.trimStart().length;
  const text = rawText.trim();
  spanRanges.forEach((range, span) => {
    const start = Math.max(0, Math.min(text.length, range.start - leading));
    const end = Math.max(start, Math.min(text.length, range.end - leading));
    spanRanges.set(span, { start, end });
  });
  return { text, positions: positions.slice(leading, leading + text.length), spanRanges };
}

function occurrences(haystack, needle) {
  const result = [];
  if (!needle) return result;
  for (let start = haystack.indexOf(needle); start !== -1; start = haystack.indexOf(needle, start + 1)) {
    result.push({ start, end: start + needle.length });
  }
  return result;
}

function tokenOccurrences(haystack, quote) {
  const tokens = [...haystack.matchAll(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu)]
    .map((match) => ({ value: match[0], start: match.index, end: match.index + match[0].length }));
  const target = [...sourceMatchText(quote).matchAll(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu)].map((match) => match[0]);
  if (target.length < 2) return [];
  const result = [];
  for (let start = 0; start <= tokens.length - target.length; start += 1) {
    if (target.every((value, offset) => tokens[start + offset].value === value)) {
      result.push({ start: tokens[start].start, end: tokens[start + target.length - 1].end });
    }
  }
  return result;
}

function matchingOccurrences(index, quote) {
  const exact = occurrences(index.text, sourceMatchText(quote));
  return exact.length ? exact : tokenOccurrences(index.text, quote);
}

function headingOccurrences(index, quote) {
  const matches = matchingOccurrences(index, quote);
  if (matches.length) return matches;
  const target = [...sourceMatchText(quote).matchAll(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu)].map((match) => match[0]);
  if (target.length !== 1) return [];
  return [...index.text.matchAll(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu)]
    .filter((match) => match[0] === target[0])
    .map((match) => ({ start: match.index, end: match.index + match[0].length }));
}

function expandPdfHeadingRange(index, match) {
  const matchedSpans = new Set(index.positions.slice(match.start, match.end).map((item) => item?.span).filter(Boolean));
  if (!matchedSpans.size) return match;
  const matchedLines = [...matchedSpans].map((span) => ({
    layer: span.closest('.pdf-text-layer'),
    rect: span.getBoundingClientRect(),
  }));
  let start = match.start;
  let end = match.end;
  index.spanRanges.forEach((range, span) => {
    const layer = span.closest('.pdf-text-layer');
    const rect = span.getBoundingClientRect();
    const sameHeadingLine = matchedLines.some((line) => line.layer === layer
      && rect.bottom >= line.rect.top - 2 && rect.top <= line.rect.bottom + 2);
    if (!sameHeadingLine) return;
    start = Math.min(start, range.start);
    end = Math.max(end, range.end);
  });
  return { start, end };
}

function occurrenceAt(index, quote, clickedIndex) {
  const matches = matchingOccurrences(index, quote);
  return matches.find((item) => item.start <= clickedIndex && clickedIndex < item.end) || null;
}

function textOffsetAtPoint(span, clientX, clientY) {
  const node = span.firstChild;
  if (!node?.length) return 0;
  let nearest = { offset: 0, distance: Number.POSITIVE_INFINITY };
  for (let offset = 0; offset < node.length; offset += 1) {
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + 1);
    for (const rect of range.getClientRects()) {
      if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) return offset;
      const distance = Math.abs(clientX - (rect.left + rect.width / 2)) + Math.abs(clientY - (rect.top + rect.height / 2));
      if (distance < nearest.distance) nearest = { offset, distance };
    }
  }
  return nearest.offset;
}

function pdfIndexAtPoint(index, span, clientX, clientY) {
  if (!span || !index) return null;
  const localOffset = textOffsetAtPoint(span, clientX, clientY);
  const spanRange = index.spanRanges.get(span);
  if (!spanRange) return null;
  let lastPosition = spanRange.start;
  for (let position = spanRange.start; position < spanRange.end; position += 1) {
    const anchor = index.positions[position];
    if (anchor?.span !== span) continue;
    lastPosition = position;
    if (anchor.offset >= localOffset) return position;
  }
  return lastPosition;
}

function clearPdfScopeHighlight() {
  document.querySelectorAll('.pdf-active-highlight, .pdf-position-marker').forEach((item) => item.remove());
}

function clearPdfHoverHighlight() {
  if (pdfHoverFrame) cancelAnimationFrame(pdfHoverFrame);
  pdfHoverFrame = null;
  pdfHoverKey = '';
  document.querySelectorAll('.pdf-hover-highlight').forEach((item) => item.remove());
}

function highlightPdfRanges(index, ranges, scope, mode = 'active') {
  if (mode === 'hover') document.querySelectorAll('.pdf-hover-highlight').forEach((item) => item.remove());
  else if (mode === 'recent') document.querySelectorAll('.pdf-recent-highlight').forEach((item) => item.remove());
  else clearPdfScopeHighlight();
  const spanOffsets = new Map();
  for (const range of ranges || []) {
    for (let position = range.start; position < range.end; position += 1) {
      const anchor = index.positions[position];
      if (!anchor?.node) continue;
      const existing = spanOffsets.get(anchor.span) || { node: anchor.node, start: anchor.offset, end: anchor.offset + 1 };
      existing.start = Math.min(existing.start, anchor.offset);
      existing.end = Math.max(existing.end, anchor.offset + 1);
      spanOffsets.set(anchor.span, existing);
    }
  }
  spanOffsets.forEach(({ node, start, end }, span) => {
    const selection = document.createRange();
    selection.setStart(node, Math.min(start, node.length));
    selection.setEnd(node, Math.min(end, node.length));
    const page = span.closest('.pdf-page');
    const pageRect = page.getBoundingClientRect();
    for (const rect of selection.getClientRects()) {
      if (!rect.width || !rect.height) continue;
      const left = Math.max(0, rect.left - pageRect.left);
      const right = Math.min(pageRect.width, rect.right - pageRect.left);
      if (right <= left) continue;
      const marker = document.createElement('span');
      marker.className = `pdf-scope-highlight scope-${scope} pdf-${mode}-highlight`;
      marker.style.left = `${left}px`;
      marker.style.top = `${rect.top - pageRect.top}px`;
      marker.style.width = `${right - left}px`;
      marker.style.height = `${rect.height}px`;
      page.appendChild(marker);
    }
  });
}

function showPdfPositionMarker(point) {
  if (!point?.page) return;
  const marker = document.createElement('span');
  marker.className = 'pdf-position-marker';
  marker.style.left = `${point.left}px`;
  marker.style.top = `${point.top}px`;
  point.page.appendChild(marker);
}

let pdfMenuPoint = null;

function positionPdfMenu(menu, point) {
  menu.style.left = `${Math.max(12, Math.min(point.x + 10, window.innerWidth - 390))}px`;
  menu.style.top = `${Math.max(12, Math.min(point.y + 10, window.innerHeight - 300))}px`;
}

function openPdfScopeMenu(event) {
  document.getElementById('pdf-edit-menu').classList.add('hidden');
  const menu = document.getElementById('pdf-scope-menu');
  document.getElementById('pdf-sentence-reader-open').classList.toggle('hidden', !pdfAnnotationTarget?.sentence);
  document.getElementById('pdf-locate-source').classList.toggle('hidden', !pdfAnnotationTarget?.node?.sourceRange);
  pdfMenuPoint = { x: event.clientX, y: event.clientY };
  positionPdfMenu(menu, pdfMenuPoint);
  menu.classList.remove('hidden');
}

function closePdfScopeMenu() {
  document.getElementById('pdf-scope-menu').classList.add('hidden');
}

function dismissPdfSelection() {
  document.getElementById('pdf-scope-menu').classList.add('hidden');
  document.getElementById('pdf-edit-menu').classList.add('hidden');
  clearPdfScopeHighlight();
  clearPdfHoverHighlight();
  pdfAnnotationTarget = null;
  pdfMenuPoint = null;
}

function openPdfEditMenu() {
  const menu = document.getElementById('pdf-edit-menu');
  if (pdfMenuPoint) positionPdfMenu(menu, pdfMenuPoint);
  menu.classList.remove('hidden');
  document.getElementById('pdf-edit-quote').textContent = pdfAnnotationTarget.quote;
  document.getElementById('pdf-edit-comment').value = '';
  document.getElementById('pdf-edit-comment').focus();
}

function currentPdfSentenceCandidates() {
  if (!currentDocument) return [];
  const paragraphs = currentDocument.sections.flatMap((section) => section.children || []);
  return paragraphs.flatMap((paragraph) => (paragraph.children || []).map((sentence) => ({ sentence, paragraph })));
}

function compiledSentenceSnapshot() {
  return currentPdfSentenceCandidates().map(({ sentence }) => ({ id: sentence.id, text: sentence.text }));
}

function recordSuccessfulCompile(source) {
  if (!currentDocument) return 0;
  const nextSnapshot = compiledSentenceSnapshot();
  let changedCount = 0;
  if (lastCompiledSource === null) {
    recentChangedSentenceIds = new Set();
  } else if (source !== lastCompiledSource) {
    const previousById = new Map(lastCompiledSentenceSnapshot.map((item) => [item.id, item.text]));
    recentChangedSentenceIds = new Set(nextSnapshot
      .filter((item) => previousById.get(item.id) !== item.text)
      .map((item) => item.id));
    changedCount = recentChangedSentenceIds.size;
  }
  lastCompiledSource = source;
  lastCompiledSentenceSnapshot = nextSnapshot;
  return changedCount;
}

function renderRecentPdfChanges() {
  if (!pdfTextIndex) return;
  const ranges = pdfSentenceMappings
    .filter((mapping) => recentChangedSentenceIds.has(mapping.sentence?.id))
    .map((mapping) => ({ start: mapping.start, end: mapping.end }));
  highlightPdfRanges(pdfTextIndex, ranges, 'recent-change', 'recent');
  document.getElementById('pdf-preview').dataset.recentChangedSentences = String(ranges.length);
}

function rebuildPdfSentenceMappings() {
  if (!pdfTextIndex || !currentDocument) {
    pdfSentenceMappings = [];
    pdfHeadingMappings = [];
    pdfMetadataMappings = [];
    return;
  }
  const candidates = currentPdfSentenceCandidates().map((item) => ({
    ...item,
    matchText: sourceMatchText(item.sentence.text),
  }));
  pdfSentenceMappings = buildOrderedSentenceMappings(pdfTextIndex.text, candidates).mappings;
  const sectionSentenceRanges = new Map(currentDocument.sections.map((section) => [section.id, []]));
  pdfSentenceMappings.forEach((mapping) => {
    const ranges = sectionSentenceRanges.get(mapping.paragraph?.parentId);
    if (ranges) ranges.push(mapping);
  });
  const firstBodyStart = pdfSentenceMappings[0]?.start ?? pdfTextIndex.text.length;
  const mappings = [];
  if (currentDocument.title) {
    const titleMatch = headingOccurrences(pdfTextIndex, currentDocument.title)
      .find((item) => item.start < firstBodyStart);
    if (titleMatch) mappings.push({ ...expandPdfHeadingRange(pdfTextIndex, titleMatch), node: { ...currentDocument, type: 'document', text: currentDocument.title } });
  }
  currentDocument.sections.forEach((section, sectionIndex) => {
    const ownRanges = sectionSentenceRanges.get(section.id) || [];
    const previousRanges = currentDocument.sections.slice(0, sectionIndex)
      .flatMap((item) => sectionSentenceRanges.get(item.id) || []);
    const nextRanges = currentDocument.sections.slice(sectionIndex + 1)
      .flatMap((item) => sectionSentenceRanges.get(item.id) || []);
    const lowerBound = previousRanges.at(-1)?.end ?? 0;
    const upperBound = ownRanges[0]?.start ?? nextRanges[0]?.start ?? pdfTextIndex.text.length;
    const boundedMatches = headingOccurrences(pdfTextIndex, section.title)
      .filter((item) => item.start >= lowerBound && item.end <= upperBound);
    let match = boundedMatches.at(-1);
    if (!match && ownRanges.length) {
      let anchor = upperBound - 1;
      while (anchor >= lowerBound && !pdfTextIndex.positions[anchor]?.span) anchor -= 1;
      if (anchor >= lowerBound) match = { start: anchor, end: anchor + 1 };
    }
    if (match) mappings.push({ ...expandPdfHeadingRange(pdfTextIndex, match), node: { ...section, text: section.title } });
  });
  pdfHeadingMappings = mappings;
  const source = editor?.getValue?.() || '';
  const metadataCommands = ['author', 'date', 'subtitle', 'institute', 'affiliation', 'email', 'keywords'];
  const occupied = [...pdfHeadingMappings];
  pdfMetadataMappings = metadataCommands.flatMap((command) => {
    const metadata = latexCommandMetadata(source, command);
    if (!metadata) return [];
    const match = headingOccurrences(pdfTextIndex, metadata.displayText)
      .find((item) => item.start < firstBodyStart && !occupied.some((range) => item.start < range.end && item.end > range.start));
    if (!match) return [];
    const range = expandPdfHeadingRange(pdfTextIndex, match);
    occupied.push(range);
    return [{ ...range, ...metadata, key: `${command}:${metadata.sourceRange.start}` }];
  });
  document.querySelectorAll('.pdf-text-layer span[data-pdf-heading-node], .pdf-text-layer span[data-pdf-metadata-key]').forEach((span) => {
    delete span.dataset.pdfHeadingNode;
    delete span.dataset.pdfMetadataKey;
  });
  pdfHeadingMappings.forEach((mapping) => {
    const spans = new Set(pdfTextIndex.positions.slice(mapping.start, mapping.end)
      .map((position) => position?.span).filter(Boolean));
    spans.forEach((span) => { span.dataset.pdfHeadingNode = mapping.node.id; });
  });
  pdfMetadataMappings.forEach((mapping) => {
    const spans = new Set(pdfTextIndex.positions.slice(mapping.start, mapping.end)
      .map((position) => position?.span).filter(Boolean));
    spans.forEach((span) => { span.dataset.pdfMetadataKey = mapping.key; });
  });
  const preview = document.getElementById('pdf-preview');
  preview.dataset.mappedSentences = String(pdfSentenceMappings.length);
  preview.dataset.sourceSentences = String(candidates.length);
  preview.dataset.mappedHeadings = String(pdfHeadingMappings.length);
  renderRecentPdfChanges();
}

function headingMappingAt(clickedIndex) {
  return pdfHeadingMappings.find((item) => item.start <= clickedIndex && clickedIndex < item.end) || null;
}

function headingMappingForSpan(span) {
  const nodeId = span?.dataset?.pdfHeadingNode;
  return nodeId ? pdfHeadingMappings.find((item) => item.node.id === nodeId) || null : null;
}

function metadataMappingForSpan(span) {
  const key = span?.dataset?.pdfMetadataKey;
  return key ? pdfMetadataMappings.find((item) => item.key === key) || null : null;
}

function pdfWordRange(index, clickedIndex) {
  let start = clickedIndex;
  let end = clickedIndex + 1;
  while (start > 0 && /[\p{L}\p{N}'-]/u.test(index.text[start - 1])) start -= 1;
  while (end < index.text.length && /[\p{L}\p{N}'-]/u.test(index.text[end])) end += 1;
  return { start, end };
}

function pdfVisualRange(index, span, lineRadius = 0) {
  const layer = span.closest('.pdf-text-layer');
  const anchorRect = span.getBoundingClientRect();
  let start = index.spanRanges.get(span)?.start ?? 0;
  let end = index.spanRanges.get(span)?.end ?? start;
  index.spanRanges.forEach((range, candidate) => {
    if (candidate.closest('.pdf-text-layer') !== layer) return;
    const rect = candidate.getBoundingClientRect();
    const tolerance = Math.max(2, anchorRect.height * (lineRadius + .55));
    if (Math.abs((rect.top + rect.height / 2) - (anchorRect.top + anchorRect.height / 2)) > tolerance) return;
    start = Math.min(start, range.start);
    end = Math.max(end, range.end);
  });
  return { start, end };
}

function positionalPdfTarget(event, span, index, clickedIndex) {
  const page = span.closest('.pdf-page');
  const pageRect = page.getBoundingClientRect();
  const wordRange = pdfWordRange(index, clickedIndex);
  const lineRange = pdfVisualRange(index, span, 0);
  const contextRange = pdfVisualRange(index, span, 2);
  const pageLabel = page.getAttribute('aria-label') || 'PDF page';
  const xPercent = Math.round((event.clientX - pageRect.left) / Math.max(1, pageRect.width) * 100);
  const yPercent = Math.round((event.clientY - pageRect.top) / Math.max(1, pageRect.height) * 100);
  const location = `${pageLabel} · ${xPercent}% from left · ${yPercent}% from top`;
  const quoteFor = (range) => `${location}\nNearby PDF text: ${index.text.slice(range.start, range.end).trim()}`;
  return {
    fallback: true,
    scope: 'sentence',
    node: { ...currentDocument, type: 'document' },
    word: index.text.slice(wordRange.start, wordRange.end),
    quote: quoteFor(lineRange),
    fallbackQuotes: { word: quoteFor(wordRange), sentence: quoteFor(lineRange), paragraph: quoteFor(contextRange) },
    index,
    ranges: { word: [wordRange], sentence: [lineRange], paragraph: [contextRange] },
    point: { page, left: event.clientX - pageRect.left, top: event.clientY - pageRect.top },
  };
}

function anchoredPdfTarget(index, clickedIndex, pdfRange, node, sourceRange, quote) {
  const wordRange = pdfWordRange(index, clickedIndex);
  return {
    generic: true,
    scope: 'sentence',
    node: { ...node, sourceRange },
    word: index.text.slice(wordRange.start, wordRange.end),
    quote,
    scopeQuotes: { word: index.text.slice(wordRange.start, wordRange.end), sentence: quote, paragraph: quote },
    index,
    ranges: { word: [wordRange], sentence: [pdfRange], paragraph: [pdfRange] },
  };
}

function handlePdfTextHover(event) {
  if (pdfHoverFrame) cancelAnimationFrame(pdfHoverFrame);
  pdfHoverFrame = requestAnimationFrame(() => {
    pdfHoverFrame = null;
    const span = event.target.closest('.pdf-text-layer span');
    if (!span) return clearPdfHoverHighlight();
    const index = pdfTextIndex || buildPdfTextIndex();
    const clickedIndex = pdfIndexAtPoint(index, span, event.clientX, event.clientY);
    const heading = headingMappingForSpan(span) || headingMappingAt(clickedIndex);
    const metadata = metadataMappingForSpan(span);
    const mapping = !heading && !metadata && sentenceMappingAt(pdfSentenceMappings, clickedIndex);
    const fallbackRange = !heading && !metadata && !mapping ? index.spanRanges.get(span) : null;
    const targetRange = heading || metadata || mapping || fallbackRange;
    if (!targetRange) return clearPdfHoverHighlight();
    const key = `${heading ? 'heading' : metadata ? 'metadata' : mapping ? 'sentence' : 'text'}:${targetRange.start}:${targetRange.end}`;
    if (key === pdfHoverKey) return;
    pdfHoverKey = key;
    highlightPdfRanges(index, [{ start: targetRange.start, end: targetRange.end }], heading || metadata ? 'outline' : 'sentence', 'hover');
  });
}

function handlePdfTextClick(event) {
  if (!currentDocument) return showStatus('Document structure is still loading', 'error');
  document.getElementById('pdf-edit-menu').classList.add('hidden');
  const span = event.target.closest('.pdf-text-layer span');
  const index = pdfTextIndex || buildPdfTextIndex();
  if (!span) {
    dismissPdfSelection();
    return;
  }
  const clickedIndex = pdfIndexAtPoint(index, span, event.clientX, event.clientY);
  if (!Number.isInteger(clickedIndex)) return;
  const heading = headingMappingForSpan(span) || headingMappingAt(clickedIndex);
  const metadata = metadataMappingForSpan(span);
  if (heading) {
    const sourceRange = headingSourceRange(heading.node);
    pdfAnnotationTarget = sourceRange
      ? anchoredPdfTarget(index, clickedIndex, heading, heading.node, sourceRange, heading.node.title || heading.node.text)
      : positionalPdfTarget(event, span, index, clickedIndex);
    clearPdfHoverHighlight();
    highlightPdfRanges(index, pdfAnnotationTarget.ranges.sentence, 'outline');
    openPdfScopeMenu(event);
    return;
  }
  if (metadata) {
    pdfAnnotationTarget = anchoredPdfTarget(
      index, clickedIndex, metadata,
      { ...currentDocument, type: 'document' }, metadata.sourceRange, metadata.raw,
    );
    clearPdfHoverHighlight();
    highlightPdfRanges(index, pdfAnnotationTarget.ranges.sentence, 'outline');
    openPdfScopeMenu(event);
    return;
  }
  const mapping = sentenceMappingAt(pdfSentenceMappings, clickedIndex);
  if (!mapping) {
    pdfAnnotationTarget = positionalPdfTarget(event, span, index, clickedIndex);
    clearPdfHoverHighlight();
    highlightPdfRanges(index, pdfAnnotationTarget.ranges.sentence, 'sentence');
    openPdfScopeMenu(event);
    return;
  }
  const wordRange = pdfWordRange(index, clickedIndex);
  const word = index.text.slice(wordRange.start, wordRange.end);
  const sentenceRange = { start: mapping.start, end: mapping.end };
  const paragraphRanges = pdfSentenceMappings
    .filter((item) => item.paragraph?.id === mapping.paragraph?.id)
    .map((item) => ({ start: item.start, end: item.end }));
  pdfAnnotationTarget = {
    scope: 'sentence', word, sentence: mapping.sentence, paragraph: mapping.paragraph,
    node: mapping.sentence, quote: mapping.sentence.text, index,
    ranges: { word: [wordRange], sentence: [sentenceRange], paragraph: paragraphRanges },
  };
  clearPdfHoverHighlight();
  highlightPdfRanges(index, pdfAnnotationTarget.ranges.sentence, 'sentence');
  openPdfScopeMenu(event);
}

function choosePdfAnnotationScope(scope) {
  if (!pdfAnnotationTarget) return;
  const target = pdfAnnotationTarget.fallback
    ? { node: pdfAnnotationTarget.node, quote: pdfAnnotationTarget.fallbackQuotes[scope] }
    : pdfAnnotationTarget.generic
      ? { node: pdfAnnotationTarget.node, quote: pdfAnnotationTarget.scopeQuotes[scope] }
      : scope === 'word'
        ? { node: pdfAnnotationTarget.sentence || pdfAnnotationTarget.paragraph, quote: pdfAnnotationTarget.word }
        : scope === 'paragraph'
          ? { node: pdfAnnotationTarget.paragraph, quote: pdfAnnotationTarget.paragraph?.text }
          : { node: pdfAnnotationTarget.sentence || pdfAnnotationTarget.paragraph, quote: pdfAnnotationTarget.sentence?.text || pdfAnnotationTarget.paragraph?.text };
  if (!target.node || !target.quote) return;
  Object.assign(pdfAnnotationTarget, { scope, ...target });
  highlightPdfRanges(pdfAnnotationTarget.index, pdfAnnotationTarget.ranges[scope], scope);
  if (pdfAnnotationTarget.fallback && !pdfAnnotationTarget.ranges[scope].length) showPdfPositionMarker(pdfAnnotationTarget.point);
}

function locatePdfSentenceInSource() {
  const node = pdfAnnotationTarget?.sentence || pdfAnnotationTarget?.node || pdfAnnotationTarget?.paragraph;
  if (!node?.id || !node.sourceRange) {
    showStatus('This PDF sentence has no reliable LaTeX source location.', 'error');
    return;
  }
  const range = node.sourceRange;
  const generic = pdfAnnotationTarget?.generic;
  dismissPdfSelection();
  if (generic) {
    setWorkspaceView('source');
    const start = editor.posFromIndex(range.start);
    const end = editor.posFromIndex(range.end);
    editor.setSelection(start, end);
    editor.scrollIntoView({ from: start, to: end }, 80);
    editor.focus();
    return;
  }
  selectStructureNode(node.id, { forceSource: true });
}

function readableSentenceTokens(raw) {
  const characters = [];
  const offsets = [];
  for (let cursor = 0; cursor < raw.length;) {
    if (raw[cursor] === '\\') {
      const command = raw.slice(cursor).match(/^\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?/);
      if (command) { cursor += command[0].length; continue; }
    }
    if (raw[cursor] === '$') {
      const end = raw.indexOf('$', cursor + 1);
      const label = ' equation ';
      for (const character of label) { characters.push(character); offsets.push(undefined); }
      cursor = end === -1 ? cursor + 1 : end + 1;
      continue;
    }
    if ('{}'.includes(raw[cursor])) { cursor += 1; continue; }
    characters.push(raw[cursor]); offsets.push(cursor); cursor += 1;
  }
  const displayCharacters = [];
  const normalizedOffsets = [];
  let pendingSpace = false;
  for (let index = 0; index < characters.length; index += 1) {
    if (/\s/.test(characters[index])) { pendingSpace = displayCharacters.length > 0; continue; }
    if (pendingSpace) { displayCharacters.push(' '); normalizedOffsets.push(offsets[index]); }
    displayCharacters.push(characters[index]); normalizedOffsets.push(offsets[index]);
    pendingSpace = false;
  }
  const text = displayCharacters.join('');
  const tokens = [];
  const matcher = /[\p{L}\p{N}'’-]+/gu;
  let match;
  while ((match = matcher.exec(text))) {
    const rawStart = normalizedOffsets[match.index];
    const rawEndOffset = normalizedOffsets[match.index + match[0].length - 1];
    if (rawStart === undefined || rawEndOffset === undefined) continue;
    tokens.push({ text: match[0], displayStart: match.index, displayEnd: match.index + match[0].length, rawStart, rawEnd: rawEndOffset + 1 });
  }
  return { text, tokens };
}

function allReadableSentences() {
  if (!currentDocument) return [];
  return currentDocument.sections.flatMap((section) => (section.children || []).flatMap((paragraph) =>
    (paragraph.children || []).map((sentence) => ({ section, paragraph, sentence }))));
}

function renderSentenceReader() {
  const item = sentenceReaderItems[sentenceReaderIndex];
  if (!item) return;
  sentenceReaderWord = null;
  const readable = readableSentenceTokens(item.sentence.text);
  const container = document.getElementById('sentence-reader-text');
  let cursor = 0;
  container.innerHTML = readable.tokens.map((token, index) => {
    const before = escapeHtml(readable.text.slice(cursor, token.displayStart));
    cursor = token.displayEnd;
    return before + '<button type="button" class="sentence-reader-word" data-reader-word="' + index + '">' + escapeHtml(token.text) + '</button>';
  }).join('') + escapeHtml(readable.text.slice(cursor));
  container.querySelectorAll('[data-reader-word]').forEach((button) => button.addEventListener('click', () => {
    const index = Number(button.dataset.readerWord);
    sentenceReaderWord = sentenceReaderWord?.index === index ? null : { index, ...readable.tokens[index] };
    container.querySelectorAll('[data-reader-word]').forEach((word) => word.classList.toggle('selected', Number(word.dataset.readerWord) === sentenceReaderWord?.index));
    document.getElementById('sentence-reader-selection').textContent = sentenceReaderWord ? t('reader.scopeWord', { word: sentenceReaderWord.text }) : t('reader.scopeSentence');
  }));
  document.getElementById('sentence-reader-position').textContent = t('reader.position', { section: item.section.title, current: sentenceReaderIndex + 1, total: sentenceReaderItems.length });
  document.getElementById('sentence-reader-selection').textContent = t('reader.scopeSentence');
  document.getElementById('sentence-reader-comment').value = '';
  document.getElementById('sentence-reader-prev').disabled = sentenceReaderIndex === 0;
  document.getElementById('sentence-reader-next').disabled = sentenceReaderIndex === sentenceReaderItems.length - 1;
  container.focus();
}

function openSentenceReader() {
  sentenceReaderItems = allReadableSentences();
  if (!sentenceReaderItems.length) return showStatus(t('status.readerNoSentences'), 'error');
  const initialId = pdfAnnotationTarget?.sentence?.id;
  const found = sentenceReaderItems.findIndex((item) => item.sentence.id === initialId);
  sentenceReaderIndex = found >= 0 ? found : 0;
  document.getElementById('pdf-scope-menu').classList.add('hidden');
  document.getElementById('pdf-edit-menu').classList.add('hidden');
  clearPdfScopeHighlight();
  renderSentenceReader();
  document.getElementById('sentence-reader-overlay').classList.remove('hidden');
}

function closeSentenceReader() {
  document.getElementById('sentence-reader-overlay').classList.add('hidden');
  sentenceReaderWord = null;
}

async function queueModificationIntent(target, comment, scope) {
  const res = await fetch('/api/annotations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentId: currentDocument.id, target, category: 'content', severity: 'info', body: comment,
      suggestedFix: '', source: { type: 'user', actor: `pdf-intent:${scope}` },
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const details = Array.isArray(data.details) && data.details.length ? `: ${data.details.join('; ')}` : '';
    throw new Error((data.error || 'Modification intent could not be saved') + details);
  }
  await loadModificationIntents();
}

async function submitSentenceReaderIntent() {
  const item = sentenceReaderItems[sentenceReaderIndex];
  const comment = document.getElementById('sentence-reader-comment').value.trim();
  if (!item || !comment) return showStatus(t('status.readerCommentRequired'), 'error');
  const range = item.sentence.sourceRange;
  const target = sentenceReaderWord
    ? { type: 'range', id: item.sentence.id, start: range.start + sentenceReaderWord.rawStart, end: range.start + sentenceReaderWord.rawEnd, quote: item.sentence.text.slice(sentenceReaderWord.rawStart, sentenceReaderWord.rawEnd) }
    : { type: 'sentence', id: item.sentence.id, start: range.start, end: range.end, quote: editor.getValue().slice(range.start, range.end) };
  try {
    await queueModificationIntent(target, comment, sentenceReaderWord ? 'word' : 'sentence');
    document.getElementById('sentence-reader-comment').value = '';
    showStatus(t('status.readerQueued'), 'success');
  } catch (error) { showStatus(error.message, 'error'); }
}

function pdfIntentTarget() {
  const target = pdfAnnotationTarget;
  if (target?.fallback) {
    return { type: 'document', id: currentDocument.id, start: 0, end: 0, quote: target.quote };
  }
  const node = target?.node;
  const sourceRange = node?.sourceRange;
  if (!target || !node || !sourceRange) return null;
  let start = sourceRange.start;
  let end = sourceRange.end;
  let quote = editor.getValue().slice(start, end);
  if (target.scope === 'word') {
    const normalized = [];
    const offsets = [];
    for (let offset = 0; offset < quote.length; offset += 1) {
      for (const character of canonicalPdfUnit(quote[offset])) {
        normalized.push(character); offsets.push(offset);
      }
    }
    const word = canonicalPdfText(target.word);
    const matches = occurrences(normalized.join(''), word);
    const sentenceRange = target.ranges?.sentence?.[0];
    const wordRange = target.ranges?.word?.[0];
    const relative = sentenceRange && wordRange
      ? Math.max(0, Math.min(1, (wordRange.start - sentenceRange.start) / Math.max(1, sentenceRange.end - sentenceRange.start)))
      : 0;
    const expected = relative * normalized.length;
    const selected = matches.sort((a, b) => Math.abs(a.start - expected) - Math.abs(b.start - expected))[0];
    if (selected && offsets[selected.start] !== undefined && offsets[selected.end - 1] !== undefined) {
      start += offsets[selected.start];
      end = sourceRange.start + offsets[selected.end - 1] + 1;
      quote = editor.getValue().slice(start, end);
    }
  }
  const type = target.generic
    ? (node.type === 'document' ? 'document' : 'range')
    : target.scope === 'word' ? 'range' : target.scope;
  return { type, id: node.id, start, end, quote };
}

function modificationIntentPrompt() {
  if (!modificationIntents.length) return '';
  return [
    'Apply all queued modification intents as one coherent manuscript revision.',
    'Address every intent independently, preserve unrelated text and evidence, and return exact non-overlapping source replacements.',
    '',
    modificationIntents.map((intent, index) => intent.toPrompt(index)).join('\n\n'),
  ].join('\n');
}

function combinedTemporaryPrompt() {
  return [modificationIntentPrompt(), document.getElementById('ai-prompt').value.trim()].filter(Boolean).join('\n\nAdditional run instruction:\n');
}

function modificationIntentLocation(intent) {
  const task = currentPromptPreview?.manifest?.tasks?.find((item) => item.taskId === intent.id);
  const location = task?.humanLocation;
  if (!location) return '';
  return [location.sectionTitle || (location.section ? `Section ${location.section}` : ''), location.paragraph ? `Paragraph ${location.paragraph}` : '', location.sentence ? `Sentence ${location.sentence}` : ''].filter(Boolean).join(' · ');
}

function renderModificationIntents() {
  const container = document.getElementById('modification-intent-list');
  if (!container) return;
  document.getElementById('modification-intent-count').textContent = t('ai.queued', { count: modificationIntents.length });
  const badge = document.getElementById('ai-invoke-intent-count');
  badge.textContent = modificationIntents.length;
  badge.classList.toggle('hidden', modificationIntents.length === 0);
  if (!modificationIntents.length) {
    container.innerHTML = '<div class="outline-empty">' + escapeHtml(t('ai.intentsEmpty')) + '</div>';
    return;
  }
  container.innerHTML = modificationIntents.map((intent) => '<article class="modification-intent" data-intent-id="' + escapeHtml(intent.id) + '">'
    + '<div class="modification-intent-head"><span class="modification-intent-scope">' + escapeHtml([intent.scope + (intent.positional ? ' · PDF position' : ''), modificationIntentLocation(intent)].filter(Boolean).join(' · ')) + '</span><button class="modification-intent-remove" type="button">Remove</button></div>'
    + '<blockquote>' + escapeHtml(shorten(intent.quote, 150)) + '</blockquote>'
    + '<textarea aria-label="Modification instruction">' + escapeHtml(intent.comment) + '</textarea></article>').join('');
  container.querySelectorAll('.modification-intent').forEach((element) => {
    const intent = modificationIntents.find((item) => item.id === element.dataset.intentId);
    element.querySelector('textarea').addEventListener('change', (event) => updateModificationIntent(intent.id, event.target.value));
    element.querySelector('.modification-intent-remove').addEventListener('click', () => deleteModificationIntent(intent.id));
  });
}

async function loadModificationIntents() {
  if (!currentDocument) return;
  try {
    const res = await fetch('/api/annotations?documentId=' + encodeURIComponent(currentDocument.id));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Modification intents could not be loaded');
    modificationIntents = data.annotations
      .filter((item) => item.status === 'open' && item.source?.actor?.startsWith('pdf-intent:'))
      .map((item) => new ModificationIntent(item));
    renderModificationIntents();
    schedulePromptContextPreview();
  } catch (error) { showStatus(error.message, 'error'); }
}

async function updateModificationIntent(id, comment) {
  if (!comment.trim()) return deleteModificationIntent(id);
  try {
    const res = await fetch('/api/annotations/' + encodeURIComponent(id), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: comment.trim() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Modification intent could not be updated');
    await loadModificationIntents();
    showStatus('Modification intent updated', 'success');
  } catch (error) { showStatus(error.message, 'error'); }
}

async function deleteModificationIntent(id) {
  try {
    const res = await fetch('/api/annotations/' + encodeURIComponent(id), { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Modification intent could not be removed');
    await loadModificationIntents();
    showStatus('Modification intent removed', 'success');
  } catch (error) { showStatus(error.message, 'error'); }
}

async function resolveModificationIntents(ids) {
  await Promise.all(ids.map(async (id) => {
    const res = await fetch('/api/annotations/' + encodeURIComponent(id), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'resolved' }),
    });
    if (!res.ok) throw new Error('Applied revision saved, but an intent could not be marked resolved');
  }));
  await loadModificationIntents();
}

function historyTime(entry) {
  const value = entry.rolledBackAt || entry.appliedAt || entry.createdAt;
  if (!value) return '';
  return new Intl.DateTimeFormat(getLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function renderChangeHistoryList() {
  const list = document.getElementById('change-history-list');
  if (!changeHistoryEntries.length) {
    list.innerHTML = '<div class="change-history-empty"><strong>' + escapeHtml(t('history.empty')) + '</strong><p>' + escapeHtml(t('history.emptyHelp')) + '</p></div>';
    document.getElementById('change-history-detail').innerHTML = '<div class="change-history-empty"><strong>' + escapeHtml(t('history.select')) + '</strong><p>' + escapeHtml(t('history.selectHelp')) + '</p></div>';
    return;
  }
  list.innerHTML = changeHistoryEntries.map((entry) => '<button type="button" class="change-history-item ' + (entry.id === selectedChangeHistoryId ? 'selected' : '') + '" data-history-id="' + escapeHtml(entry.id) + '">'
    + '<span class="change-history-item-head"><strong>' + escapeHtml(entry.title || entry.origin) + '</strong>' + (entry.isLatest ? '<em>' + escapeHtml(t('history.latest')) + '</em>' : '') + '</span>'
    + '<span>' + escapeHtml(historyTime(entry)) + ' · ' + escapeHtml(t('history.changes', { count: entry.changeCount })) + '</span></button>').join('')
    + '<p class="change-history-notice">' + escapeHtml(t('history.recentNotice')) + '</p>';
  list.querySelectorAll('[data-history-id]').forEach((button) => button.addEventListener('click', () => {
    selectedChangeHistoryId = button.dataset.historyId;
    renderChangeHistoryList();
    renderChangeHistoryDetail();
  }));
}

function historyVisibleText(value) {
  return sourceMatchText(String(value || '')
    .replace(/(^|[^\\])%.*$/gm, '$1')
    .replace(/\\(?:label|cite\w*|ref|eqref|autoref|url|href)\*?(?:\[[^\]]*\])?\{[^{}]*\}(?:\{[^{}]*\})?/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\$[^$]*\$/g, ' '));
}

function historyAnchorCandidates(value, side) {
  const words = historyVisibleText(value).match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) || [];
  const candidates = [];
  for (const size of [10, 8, 6, 4, 3]) {
    if (words.length < size) continue;
    candidates.push((side === 'before' ? words.slice(-size) : words.slice(0, size)).join(' '));
  }
  return candidates;
}

function historyContextOccurrences(index, value, side) {
  for (const candidate of historyAnchorCandidates(value, side)) {
    const matches = matchingOccurrences(index, candidate);
    if (matches.length) return matches;
  }
  return [];
}

function chooseHistoryOccurrence(index, quote, change) {
  const matches = matchingOccurrences(index, quote);
  if (matches.length <= 1) return matches[0] || null;
  const before = historyContextOccurrences(index, change.contextBefore, 'before');
  const after = historyContextOccurrences(index, change.contextAfter, 'after');
  return [...matches].sort((left, right) => {
    const score = (candidate) => {
      const beforeDistance = before.filter((item) => item.end <= candidate.start).map((item) => candidate.start - item.end);
      const afterDistance = after.filter((item) => item.start >= candidate.end).map((item) => item.start - candidate.end);
      return (beforeDistance.length ? Math.min(...beforeDistance) : 100000) + (afterDistance.length ? Math.min(...afterDistance) : 100000);
    };
    return score(left) - score(right);
  })[0];
}

function historyVisibleSegments(value) {
  return String(value || '').split(/\n+/)
    .flatMap((block) => historyVisibleText(block).split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}])/u))
    .map((item) => item.trim()).filter(Boolean);
}

function deriveHistoryDisplayChange(change) {
  const before = historyVisibleText(change.before);
  const after = historyVisibleText(change.after);
  const tokenize = (text) => [...text.matchAll(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu)]
    .map((match) => ({ value: match[0], start: match.index, end: match.index + match[0].length }));
  const beforeTokens = tokenize(before);
  const afterTokens = tokenize(after);
  let prefix = 0;
  while (prefix < beforeTokens.length && prefix < afterTokens.length && beforeTokens[prefix].value === afterTokens[prefix].value) prefix += 1;
  let suffix = 0;
  while (suffix < beforeTokens.length - prefix && suffix < afterTokens.length - prefix
    && beforeTokens[beforeTokens.length - suffix - 1].value === afterTokens[afterTokens.length - suffix - 1].value) suffix += 1;
  const sliceChanged = (text, tokens, start, suffixSize) => {
    const endIndex = tokens.length - suffixSize;
    if (start >= endIndex) return '';
    return text.slice(tokens[start].start, tokens[endIndex - 1].end).trim();
  };
  const changedBefore = sliceChanged(before, beforeTokens, prefix, suffix);
  const changedAfter = sliceChanged(after, afterTokens, prefix, suffix);
  const sharedPrefix = prefix ? after.slice(0, afterTokens[prefix - 1].end) : '';
  const sharedSuffix = suffix ? after.slice(afterTokens[afterTokens.length - suffix].start) : '';
  const type = !changedBefore && changedAfter ? 'added' : changedBefore && !changedAfter ? 'deleted' : 'modified';
  return {
    type,
    before: changedBefore || (type === 'modified' ? before : ''),
    after: changedAfter || (type === 'modified' ? after : ''),
    contextBefore: [change.contextBefore, sharedPrefix].filter(Boolean).join(' '),
    contextAfter: [sharedSuffix, change.contextAfter].filter(Boolean).join(' '),
  };
}

function matchHistorySegment(index, segment, minimumStart, change, depth = 0) {
  const matches = matchingOccurrences(index, segment).filter((item) => item.start >= minimumStart);
  if (matches.length) {
    if (minimumStart > 0) return [matches.sort((left, right) => left.start - right.start)[0]];
    return [chooseHistoryOccurrence(index, segment, change) || matches[0]];
  }
  const words = segment.match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) || [];
  if (depth >= 3 || words.length < 8) return [];
  const middle = Math.floor(words.length / 2);
  const left = matchHistorySegment(index, words.slice(0, middle).join(' '), minimumStart, change, depth + 1);
  const nextStart = left.at(-1)?.end ?? minimumStart;
  const right = matchHistorySegment(index, words.slice(middle).join(' '), nextStart, change, depth + 1);
  return [...left, ...right];
}

function historyChangeOccurrences(index, change) {
  const visible = historyVisibleText(change.after);
  if (!visible) return { ranges: [], coverage: 0 };
  const direct = chooseHistoryOccurrence(index, visible, change);
  if (direct) return { ranges: [direct], coverage: 1 };
  const ranges = [];
  let minimumStart = 0;
  let matchedCharacters = 0;
  for (const segment of historyVisibleSegments(change.after)) {
    const matched = matchHistorySegment(index, segment, minimumStart, change);
    if (!matched.length) continue;
    ranges.push(...matched);
    minimumStart = matched.at(-1).end;
    matchedCharacters += matched.reduce((total, item) => total + item.end - item.start, 0);
  }
  return { ranges, coverage: Math.min(1, matchedCharacters / Math.max(1, visible.length)) };
}

function findHistoryDeletionAnchor(index, change) {
  const after = historyContextOccurrences(index, change.contextAfter, 'after');
  if (after.length) return { position: after[0].start, side: 'before' };
  const before = historyContextOccurrences(index, change.contextBefore, 'before');
  if (before.length) return { position: before.at(-1).end - 1, side: 'after' };
  return null;
}

function historyMarkerElementsForRange(index, range, type, changeIndex) {
  const spanOffsets = new Map();
  for (let position = range.start; position < range.end; position += 1) {
    const anchor = index.positions[position];
    if (!anchor?.node) continue;
    const existing = spanOffsets.get(anchor.span) || { node: anchor.node, start: anchor.offset, end: anchor.offset + 1 };
    existing.start = Math.min(existing.start, anchor.offset);
    existing.end = Math.max(existing.end, anchor.offset + 1);
    spanOffsets.set(anchor.span, existing);
  }
  const elements = [];
  spanOffsets.forEach(({ node, start, end }, span) => {
    const selection = document.createRange();
    selection.setStart(node, Math.min(start, node.length));
    selection.setEnd(node, Math.min(end, node.length));
    const page = span.closest('.history-pdf-page');
    const pageRect = page.getBoundingClientRect();
    for (const rect of selection.getClientRects()) {
      const left = Math.max(0, rect.left - pageRect.left);
      const right = Math.min(pageRect.width, rect.right - pageRect.left);
      if (!rect.width || !rect.height || right <= left) continue;
      const marker = document.createElement('button');
      marker.type = 'button';
      marker.className = `history-pdf-mark history-pdf-${type}`;
      marker.dataset.historyDiffIndex = String(changeIndex);
      marker.setAttribute('aria-label', t(`history.${type}`));
      marker.style.left = `${left}px`;
      marker.style.top = `${rect.top - pageRect.top}px`;
      marker.style.width = `${right - left}px`;
      marker.style.height = `${rect.height}px`;
      page.appendChild(marker);
      elements.push(marker);
    }
  });
  return elements;
}

function historyDeletionMarker(index, anchor, changeIndex) {
  const position = index.positions[Math.max(0, Math.min(anchor.position, index.positions.length - 1))];
  if (!position?.span) return [];
  const page = position.span.closest('.history-pdf-page');
  const pageRect = page.getBoundingClientRect();
  const spanRect = position.span.getBoundingClientRect();
  const marker = document.createElement('button');
  marker.type = 'button';
  marker.className = 'history-pdf-delete-pin';
  marker.dataset.historyDiffIndex = String(changeIndex);
  marker.setAttribute('aria-label', t('history.deleted'));
  marker.textContent = '−' + (changeIndex + 1);
  marker.style.top = `${Math.max(4, spanRect.top - pageRect.top)}px`;
  page.appendChild(marker);
  return [marker];
}

function historyChangePin(elements, type, changeIndex) {
  const first = elements[0];
  const page = first?.closest('.history-pdf-page');
  if (!page) return null;
  const marker = document.createElement('button');
  marker.type = 'button';
  marker.className = `history-pdf-change-pin history-pin-${type}`;
  marker.dataset.historyDiffIndex = String(changeIndex);
  marker.setAttribute('aria-label', t(`history.${type}`));
  marker.textContent = `${type === 'added' ? '+' : '~'}${changeIndex + 1}`;
  marker.style.top = `${Math.max(4, Number.parseFloat(first.style.top) || 4)}px`;
  page.appendChild(marker);
  return marker;
}

function renderHistoryChangeCard(mark) {
  const card = document.getElementById('history-change-card');
  if (!card || !mark) return;
  const change = mark.change;
  card.classList.remove('hidden');
  card.innerHTML = '<div class="history-change-card-head"><strong>' + escapeHtml(t(`history.${mark.type}`)) + ' #' + (mark.index + 1) + '</strong><span>' + escapeHtml(mark.mapped ? t(`history.confidence.${mark.confidence}`) : t('history.unmapped')) + '</span></div>'
    + (mark.before ? '<div><label>' + escapeHtml(t('history.before')) + '</label><del>' + escapeHtml(mark.before) + '</del></div>' : '')
    + (mark.after ? '<div><label>' + escapeHtml(t('history.after')) + '</label><ins>' + escapeHtml(mark.after) + '</ins></div>' : '')
    + (change.reason ? '<p><strong>' + escapeHtml(t('history.reason')) + ':</strong> ' + escapeHtml(change.reason) + '</p>' : '');
}

function focusHistoryDiff(index, { scroll = true } = {}) {
  if (!historyDiffMarks.length) return;
  activeHistoryDiffIndex = (index + historyDiffMarks.length) % historyDiffMarks.length;
  historyDiffMarks.forEach((mark, markIndex) => mark.elements.forEach((element) => element.classList.toggle('active', markIndex === activeHistoryDiffIndex)));
  const active = historyDiffMarks[activeHistoryDiffIndex];
  document.getElementById('history-diff-position').textContent = `${activeHistoryDiffIndex + 1} / ${historyDiffMarks.length}`;
  renderHistoryChangeCard(active);
  if (scroll && active.elements[0]) {
    const viewport = document.getElementById('history-pdf-viewport');
    const page = active.elements[0].closest('.history-pdf-page');
    if (viewport && page) {
      const target = page.offsetTop + active.elements[0].offsetTop - viewport.clientHeight * .28;
      viewport.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    }
  }
}

function applyHistoryDiffOverlay(entry, container) {
  const index = buildPdfTextIndex(container, '.history-pdf-text-layer');
  historyDiffMarks = entry.changes.map((change, changeIndex) => {
    const display = deriveHistoryDisplayChange(change);
    const type = display.type;
    const locator = { ...change, after: display.after, contextBefore: display.contextBefore, contextAfter: display.contextAfter };
    let elements = [];
    let confidence = 'approximate';
    if (type === 'deleted') {
      const anchor = findHistoryDeletionAnchor(index, locator);
      if (anchor) { elements = historyDeletionMarker(index, anchor, changeIndex); confidence = 'anchored'; }
    } else {
      const located = historyChangeOccurrences(index, locator);
      if (located.ranges.length) {
        elements = located.ranges.flatMap((range) => historyMarkerElementsForRange(index, range, type, changeIndex));
        confidence = located.coverage > .9 ? 'exact' : 'anchored';
        const pin = historyChangePin(elements, type, changeIndex);
        if (pin) elements.push(pin);
      }
    }
    const mark = { index: changeIndex, change, type, before: display.before, after: display.after, elements, mapped: elements.length > 0, confidence };
    elements.forEach((element) => element.addEventListener('click', () => focusHistoryDiff(changeIndex, { scroll: false })));
    return mark;
  });
  const mapped = historyDiffMarks.filter((mark) => mark.mapped).length;
  document.getElementById('history-diff-summary').textContent = t('history.mappedSummary', { mapped, total: historyDiffMarks.length });
  document.getElementById('history-diff-position').textContent = historyDiffMarks.length ? `1 / ${historyDiffMarks.length}` : '0 / 0';
  if (historyDiffMarks.length) focusHistoryDiff(0);
}

async function renderChangeHistoryPdf(entry) {
  const generation = ++historyPdfRenderGeneration;
  const container = document.getElementById('history-pdf-pages');
  const placeholder = document.getElementById('history-pdf-placeholder');
  if (!container || !placeholder) return;
  if (historyPdfLoadingTask) await historyPdfLoadingTask.destroy().catch(() => {});
  historyDiffMarks = [];
  container.replaceChildren();
  placeholder.textContent = t('history.rendering');
  placeholder.classList.remove('hidden');
  try {
    const url = '/api/change-history/' + encodeURIComponent(entry.id) + '/preview.pdf?t=' + Date.now();
    historyPdfLoadingTask = pdfjsLib.getDocument({ url, isEvalSupported: false });
    const pdf = await historyPdfLoadingTask.promise;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      if (generation !== historyPdfRenderGeneration) return;
      const page = await pdf.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const availableWidth = Math.max(420, container.clientWidth - 72);
      const viewport = page.getViewport({ scale: availableWidth / baseViewport.width });
      const outputScale = Math.min(window.devicePixelRatio || 1, 2);
      const pageElement = document.createElement('div');
      pageElement.className = 'pdf-page history-pdf-page';
      pageElement.style.width = `${Math.floor(viewport.width)}px`;
      pageElement.style.height = `${Math.floor(viewport.height)}px`;
      pageElement.style.setProperty('--scale-factor', viewport.scale);
      pageElement.setAttribute('aria-label', 'Historical PDF page ' + pageNumber + ' of ' + pdf.numPages);
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = Math.floor(viewport.width) + 'px';
      canvas.style.height = Math.floor(viewport.height) + 'px';
      pageElement.appendChild(canvas);
      const textLayer = document.createElement('div');
      textLayer.className = 'textLayer history-pdf-text-layer';
      textLayer.style.width = `${Math.floor(viewport.width)}px`;
      textLayer.style.height = `${Math.floor(viewport.height)}px`;
      pageElement.appendChild(textLayer);
      container.appendChild(pageElement);
      await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport, transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0] }).promise;
      const textContent = await page.getTextContent();
      await new pdfjsLib.TextLayer({ textContentSource: textContent, container: textLayer, viewport }).render();
      const renderedSpans = [...textLayer.querySelectorAll('span')];
      const textItems = textContent.items.filter((item) => item.str?.trim());
      let cursor = 0;
      renderedSpans.forEach((span) => {
        while (cursor < textItems.length && textItems[cursor].str !== span.textContent) cursor += 1;
        if (cursor < textItems.length) { span.dataset.pdfHasEol = String(Boolean(textItems[cursor].hasEOL)); cursor += 1; }
      });
    }
    if (generation !== historyPdfRenderGeneration) return;
    placeholder.classList.add('hidden');
    applyHistoryDiffOverlay(entry, container);
  } catch (error) {
    if (generation !== historyPdfRenderGeneration) return;
    placeholder.textContent = t('history.renderFailed');
    placeholder.classList.remove('hidden');
    showStatus(error?.message || t('history.renderFailed'), 'error');
  }
}

function renderChangeHistoryDetail() {
  const detail = document.getElementById('change-history-detail');
  const entry = changeHistoryEntries.find((item) => item.id === selectedChangeHistoryId);
  if (!entry) return;
  const status = entry.status === 'rolled-back' ? t('history.rolledBack') : t('history.applied');
  const changes = entry.changes.map((change, index) => '<article class="change-history-diff" data-history-change="' + escapeHtml(change.id) + '">'
    + '<header><strong>#' + (index + 1) + '</strong>' + (Number.isInteger(change.currentStart) ? '<button type="button" class="history-open-source">' + escapeHtml(t('history.openSource')) + '</button>' : '') + '</header>'
    + '<div class="history-diff-columns"><section><span>' + escapeHtml(t('history.before')) + '</span><pre>' + escapeHtml(change.before) + '</pre></section><section><span>' + escapeHtml(t('history.after')) + '</span><pre>' + escapeHtml(change.after) + '</pre></section></div>'
    + (change.reason ? '<p><strong>' + escapeHtml(t('history.reason')) + ':</strong> ' + escapeHtml(change.reason) + '</p>' : '') + '</article>').join('');
  detail.innerHTML = '<div class="change-history-detail-head"><div><span>' + escapeHtml(entry.origin) + '</span><h3>' + escapeHtml(entry.title || entry.origin) + '</h3><p>' + escapeHtml(status) + ' · ' + escapeHtml(historyTime(entry)) + ' · ' + escapeHtml(t('history.changes', { count: entry.changeCount })) + '</p></div>'
    + '<div class="change-history-version-actions">'
    + (entry.canRestore ? '<button id="change-history-restore" type="button">' + escapeHtml(t('history.restoreThis')) + '</button>' : '')
    + (entry.canRollback ? '<button id="change-history-rollback" type="button">' + escapeHtml(t('history.rollback')) + '</button>' : '') + '</div></div>'
    + '<div class="change-history-safety ' + (entry.matchesCurrent ? 'current' : '') + '">' + escapeHtml(entry.matchesCurrent ? t('history.currentMatch') : t('history.restoreSafe')) + (entry.canRollback ? '<br>' + escapeHtml(t('history.rollbackWarning')) : '') + '</div>'
    + '<section class="change-history-preview"><div class="change-history-section-title"><div><strong>' + escapeHtml(t('history.annotatedPreview')) + '</strong><span id="history-diff-summary">' + escapeHtml(t('history.preparingMarks')) + '</span></div>'
    + '<div class="history-diff-controls"><span class="history-legend added">' + escapeHtml(t('history.added')) + '</span><span class="history-legend modified">' + escapeHtml(t('history.modified')) + '</span><span class="history-legend deleted">' + escapeHtml(t('history.deleted')) + '</span>'
    + '<button id="history-diff-toggle" type="button" aria-pressed="true">' + escapeHtml(t('history.hideMarks')) + '</button><button id="history-diff-previous" type="button" aria-label="' + escapeHtml(t('history.previousChange')) + '">‹</button><strong id="history-diff-position">0 / 0</strong><button id="history-diff-next" type="button" aria-label="' + escapeHtml(t('history.nextChange')) + '">›</button></div></div>'
    + '<div id="history-pdf-viewport"><div id="history-pdf-pages"></div><div id="history-pdf-placeholder">' + escapeHtml(t('history.rendering')) + '</div></div><aside id="history-change-card" class="hidden"></aside></section>'
    + '<details class="change-history-source"><summary>' + escapeHtml(t('history.sourceChanges', { count: entry.changeCount })) + '</summary><div class="change-history-diffs">' + changes + '</div></details>';
  detail.querySelectorAll('.history-open-source').forEach((button) => button.addEventListener('click', () => {
    const changeId = button.closest('[data-history-change]').dataset.historyChange;
    const change = entry.changes.find((item) => item.id === changeId);
    document.getElementById('change-history-overlay').classList.add('hidden');
    setWorkspaceView('source');
    editor.setSelection(editor.posFromIndex(change.currentStart), editor.posFromIndex(change.currentEnd));
    editor.scrollIntoView({ from: editor.posFromIndex(change.currentStart), to: editor.posFromIndex(change.currentEnd) }, 80);
    editor.focus();
  }));
  document.getElementById('change-history-rollback')?.addEventListener('click', () => rollbackChangeHistoryEntry(entry));
  document.getElementById('change-history-restore')?.addEventListener('click', () => restoreChangeHistoryEntry(entry));
  document.getElementById('history-diff-previous').addEventListener('click', () => focusHistoryDiff(activeHistoryDiffIndex - 1));
  document.getElementById('history-diff-next').addEventListener('click', () => focusHistoryDiff(activeHistoryDiffIndex + 1));
  document.getElementById('history-diff-toggle').addEventListener('click', (event) => {
    const viewport = document.getElementById('history-pdf-viewport');
    const hidden = viewport.classList.toggle('history-marks-hidden');
    event.currentTarget.setAttribute('aria-pressed', String(!hidden));
    event.currentTarget.textContent = t(hidden ? 'history.showMarks' : 'history.hideMarks');
  });
  renderChangeHistoryPdf(entry);
}

async function loadRecentChangeHistory({ silent = false } = {}) {
  if (!currentDocument) return;
  try {
    const res = await fetch('/api/change-history?documentId=' + encodeURIComponent(currentDocument.id) + '&limit=5');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Change history could not be loaded');
    changeHistoryEntries = data.entries || [];
    if (!changeHistoryEntries.some((item) => item.id === selectedChangeHistoryId)) selectedChangeHistoryId = changeHistoryEntries[0]?.id || null;
    renderChangeHistoryList();
    if (selectedChangeHistoryId) renderChangeHistoryDetail();
  } catch (error) {
    if (!silent) showStatus(error.message, 'error');
  }
}

async function openChangeHistory() {
  if (!currentDocument) return showStatus(t('history.openPaper'), 'error');
  document.getElementById('change-history-overlay').classList.remove('hidden');
  await loadRecentChangeHistory();
}

async function rollbackChangeHistoryEntry(entry) {
  if (!entry.canRollback || !confirm(t('history.rollbackConfirm'))) return;
  try {
    const res = await fetch('/api/revisions/' + encodeURIComponent(entry.id) + '/rollback', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not restore the previous version');
    editor.setValue(data.content);
    lastAiRevisionId = null;
    lastAiIntentIds = [];
    await syncStructure({ silent: true });
    await compileFile({ silent: true });
    await Promise.all([loadModificationIntents(), loadRecentChangeHistory({ silent: true })]);
    showStatus(t('history.restored'), 'success');
  } catch (error) { showStatus(error.message, 'error'); }
}

async function restoreChangeHistoryEntry(entry) {
  if (!entry.canRestore || !confirm(t('history.restoreConfirm'))) return;
  const button = document.getElementById('change-history-restore');
  if (button) button.disabled = true;
  try {
    const res = await fetch('/api/change-history/' + encodeURIComponent(entry.id) + '/restore', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not restore this version');
    editor.setValue(data.content);
    lastAiRevisionId = null;
    lastAiIntentIds = [];
    await syncStructure({ silent: true });
    document.getElementById('change-history-overlay').classList.add('hidden');
    await compileFile({ silent: true });
    await Promise.all([loadModificationIntents(), loadRecentChangeHistory({ silent: true })]);
    showStatus(t('history.versionRestored'), 'success');
  } catch (error) {
    showStatus(error.message, 'error');
    if (button) button.disabled = false;
  }
}

async function submitPdfAnnotation() {
  if (!pdfAnnotationTarget?.node) return;
  const comment = document.getElementById('pdf-edit-comment').value.trim();
  if (!comment) return showStatus(t('status.intentRequired'), 'error');
  const target = pdfIntentTarget();
  if (!target) return showStatus('This PDF selection has no stable source target', 'error');
  const button = document.getElementById('pdf-edit-submit');
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Saving…';
  showStatus('Saving modification intent…', '');
  try {
    await queueModificationIntent(target, comment, pdfAnnotationTarget.scope);
    dismissPdfSelection();
    showStatus(t('status.intentQueued'), 'success');
  } catch (error) {
    showStatus(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

function resetCompiledPreview() {
  hideCompileError({ clear: true });
  pdfRenderGeneration += 1;
  lastCompiledSource = null;
  lastCompiledSentenceSnapshot = [];
  recentChangedSentenceIds = new Set();
  if (pdfLoadingTask) pdfLoadingTask.destroy().catch(() => {});
  pdfLoadingTask = null;
  currentPdfUrl = null;
  document.getElementById('pdf-preview').replaceChildren();
  const placeholder = document.getElementById('preview-placeholder');
  placeholder.textContent = 'Compile to render the paper';
  placeholder.classList.remove('hidden');
  document.getElementById('preview-view-btn').disabled = true;
  setWorkspaceView('source');
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showStatus(msg, type) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = type || '';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.textContent = ''; el.className = ''; }, 3500);
}

function renderVersionInfo() {
  if (!appVersionInfo) return;
  const current = `v${appVersionInfo.currentVersion}`;
  const latest = `v${appVersionInfo.latestVersion || appVersionInfo.currentVersion}`;
  document.getElementById('current-version').textContent = current;
  document.getElementById('version-installed').textContent = current;
  document.getElementById('version-latest').textContent = latest;
  const statusButton = document.getElementById('version-status');
  statusButton.classList.toggle('has-update', appVersionInfo.updateAvailable);
  document.getElementById('version-update-badge').classList.toggle('hidden', !appVersionInfo.updateAvailable);
  document.getElementById('version-title').textContent = appVersionInfo.updateAvailable
    ? t('version.updateReady', { version: latest })
    : t('version.upToDate');
  const note = document.getElementById('version-check-note');
  note.textContent = !appVersionInfo.checked
    ? t('version.offline')
    : appVersionInfo.updateAvailable ? t('version.availableNote', { version: latest }) : t('version.currentNote');
  note.className = `version-check-note ${!appVersionInfo.checked ? 'warning' : 'success'}`;
  const date = document.getElementById('version-date');
  date.textContent = appVersionInfo.publishedAt
    ? new Intl.DateTimeFormat(getLocale(), { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(appVersionInfo.publishedAt))
    : '';
  const notes = document.getElementById('version-notes');
  const renderList = (id, items, fallbackKey) => {
    const list = document.getElementById(id);
    list.replaceChildren();
    const values = items?.length ? items : [t(fallbackKey)];
    values.forEach((value) => {
      const item = document.createElement('li');
      item.textContent = value;
      list.appendChild(item);
    });
  };
  if (appVersionInfo.updateAvailable) {
    renderList('version-highlights', appVersionInfo.highlights, 'version.notesOnRelease');
    renderList('version-fixes', appVersionInfo.fixes, 'version.noFixesListed');
    notes.classList.remove('hidden');
  } else notes.classList.add('hidden');
  const releaseLink = document.getElementById('version-release-link');
  releaseLink.classList.toggle('hidden', !appVersionInfo.updateAvailable || !appVersionInfo.releaseUrl);
  if (appVersionInfo.releaseUrl) releaseLink.href = appVersionInfo.releaseUrl;
}

async function loadVersionInfo() {
  try {
    const response = await fetch('/api/version');
    if (!response.ok) throw new Error('Version check failed');
    appVersionInfo = await response.json();
  } catch {
    const versionElement = document.getElementById('current-version');
    const bundledVersion = versionElement.dataset.currentVersion || versionElement.textContent.replace(/^v/, '');
    appVersionInfo = { currentVersion: bundledVersion, latestVersion: bundledVersion, updateAvailable: false, checked: false };
  }
  renderVersionInfo();
}

function openVersionDialog() {
  renderVersionInfo();
  document.getElementById('version-overlay').classList.remove('hidden');
}

function closeVersionDialog() {
  document.getElementById('version-overlay').classList.add('hidden');
}

const AGENT_ACTIVITY_STAGE_ORDER = ['prepare', 'run', 'apply', 'compile'];
const AGENT_ACTIVITY_STAGE_KEYS = { prepare: 'activity.preparing', run: 'activity.running', apply: 'activity.applying', compile: 'activity.compiling', done: 'activity.complete' };

function renderAgentActivityLog() {
  const system = agentActivitySystemLog.map((item) => `Papergod · ${item}`).join('\n');
  const terminal = agentActivityTerminalLog.trim();
  const text = [system, terminal && `\n${t('activity.cliOutput')}\n${terminal}`].filter(Boolean).join('\n') || t('activity.waiting');
  const log = document.getElementById('agent-activity-log');
  log.textContent = text;
  const detailsLog = document.getElementById('agent-activity-details-log');
  if (detailsLog) {
    detailsLog.textContent = text;
    detailsLog.scrollTop = detailsLog.scrollHeight;
  }
}

function openAgentActivityDetails() {
  renderAgentActivityLog();
  const meta = document.getElementById('agent-activity-details-meta');
  meta.textContent = `${document.getElementById('agent-activity-label').textContent} · ${document.getElementById('agent-activity-subtitle').textContent} · ${document.getElementById('agent-activity-elapsed').textContent}`;
  document.getElementById('agent-activity-details-overlay').classList.remove('hidden');
}

function closeAgentActivityDetails() {
  document.getElementById('agent-activity-details-overlay').classList.add('hidden');
}

async function pollAgentActivity() {
  if (!agentActivityId) return;
  try {
    const res = await fetch(`/api/agent/activity/${encodeURIComponent(agentActivityId)}`);
    if (!res.ok) return;
    const activity = await res.json();
    agentActivityTerminalLog = activity.output || '';
    renderAgentActivityLog();
  } catch {}
}

function setAgentActivityStage(stage, message) {
  agentActivityStage = stage;
  const activeIndex = AGENT_ACTIVITY_STAGE_ORDER.indexOf(stage);
  document.querySelectorAll('#agent-activity-stages li').forEach((item) => {
    const index = AGENT_ACTIVITY_STAGE_ORDER.indexOf(item.dataset.stage);
    item.classList.toggle('active', index === activeIndex);
    item.classList.toggle('complete', activeIndex > index || stage === 'done');
  });
  const label = stage ? t(AGENT_ACTIVITY_STAGE_KEYS[stage] || 'activity.running') : t('activity.failed');
  document.getElementById('agent-activity-label').textContent = label;
  if (message && agentActivitySystemLog.at(-1) !== message) agentActivitySystemLog.push(message);
  renderAgentActivityLog();
}

function refreshSentenceReaderLocale() {
  const item = sentenceReaderItems[sentenceReaderIndex];
  if (!item) return;
  document.getElementById('sentence-reader-position').textContent = t('reader.position', { section: item.section.title, current: sentenceReaderIndex + 1, total: sentenceReaderItems.length });
  document.getElementById('sentence-reader-selection').textContent = sentenceReaderWord ? t('reader.scopeWord', { word: sentenceReaderWord.text }) : t('reader.scopeSentence');
}

function openAgentActivity({ provider, scope, prompt }) {
  const activity = document.getElementById('agent-activity');
  activity.className = 'agent-activity running';
  document.getElementById('agent-activity-subtitle').textContent = `${provider} · ${scope}`;
  document.getElementById('agent-activity-result').classList.add('hidden');
  document.getElementById('agent-activity-result').textContent = '';
  document.getElementById('agent-activity-undo').classList.add('hidden');
  document.getElementById('agent-activity-cancel').classList.remove('hidden');
  agentActivityId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  agentActivitySystemLog = [`Preparing request (${prompt.length.toLocaleString()} prompt characters).`];
  agentActivityTerminalLog = '';
  renderAgentActivityLog();
  agentActivityStartedAt = Date.now();
  clearInterval(agentActivityTimer);
  agentActivityTimer = setInterval(() => { document.getElementById('agent-activity-elapsed').textContent = `${Math.round((Date.now() - agentActivityStartedAt) / 1000)}s`; }, 500);
  clearInterval(agentActivityPoll);
  agentActivityPoll = setInterval(pollAgentActivity, 500);
  document.getElementById('agent-activity-elapsed').textContent = '0s';
  setAgentActivityStage('prepare');
}

function finishAgentActivity(message, { error = false, revisionId = null, intentIds = [] } = {}) {
  clearInterval(agentActivityTimer);
  clearInterval(agentActivityPoll);
  agentActivityTimer = null;
  agentActivityPoll = null;
  pollAgentActivity();
  agentActivityController = null;
  setAgentActivityStage(error ? '' : 'done');
  document.getElementById('agent-activity').className = `agent-activity ${error ? 'error' : 'complete'}`;
  const result = document.getElementById('agent-activity-result');
  result.textContent = message;
  result.className = `agent-activity-result ${error ? 'error' : 'success'}`;
  document.getElementById('agent-activity-cancel').classList.add('hidden');
  lastAiRevisionId = revisionId;
  lastAiIntentIds = revisionId ? [...intentIds] : [];
  document.getElementById('agent-activity-undo').classList.toggle('hidden', !revisionId);
}

async function undoLastAiRevision() {
  if (!lastAiRevisionId) return;
  const button = document.getElementById('agent-activity-undo');
  button.disabled = true;
  try {
    const res = await fetch(`/api/revisions/${encodeURIComponent(lastAiRevisionId)}/rollback`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not undo the AI revision');
    editor.setValue(data.content);
    if (lastAiIntentIds.length) {
      await Promise.all(lastAiIntentIds.map((id) => fetch('/api/annotations/' + encodeURIComponent(id), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'open' }),
      })));
      await loadModificationIntents();
    }
    await syncStructure({ silent: true });
    await compileFile({ silent: true });
    lastAiRevisionId = null;
    lastAiIntentIds = [];
    button.classList.add('hidden');
    document.getElementById('agent-activity-result').textContent = 'AI revision rolled back and the previous PDF was restored.';
    showStatus('AI revision rolled back', 'success');
  } catch (error) { showStatus(error.message, 'error'); }
  finally { button.disabled = false; }
}

async function loadEngineStatus() {
  const compileBtn = document.getElementById('compile-btn');
  // The split button's menu follows the main button's enabled state.
  new MutationObserver(() => { document.getElementById('compile-menu-btn').disabled = compileBtn.disabled; })
    .observe(compileBtn, { attributes: true, attributeFilter: ['disabled'] });
  try {
    const res = await fetch('/api/engines');
    const data = await res.json();
    if (data.engines && data.engines.length > 0) {
      latexEngineAvailable = true;
      compileBtn.disabled = false;
      compileBtn.removeAttribute('aria-disabled');
    } else {
      latexEngineAvailable = false;
      compileBtn.disabled = true;
      compileBtn.setAttribute('aria-disabled', 'true');
      showStatus(t('engine.missing'), 'error');
    }
  } catch {
    latexEngineAvailable = false;
    compileBtn.disabled = true;
    compileBtn.setAttribute('aria-disabled', 'true');
    showStatus(t('engine.checkFailed'), 'error');
  }
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    currentProvider = data.provider || 'mock';
    const workspaceName = String(data.workspace || '').split(/[\\/]/).filter(Boolean).at(-1) || 'Workspace';
    const workspaceLabel = document.getElementById('active-workspace-name');
    if (workspaceLabel) { workspaceLabel.textContent = workspaceName; workspaceLabel.title = data.workspace || workspaceName; }
    const quickSelect = document.getElementById('agent-provider-quick');
    if (quickSelect?.querySelector(`option[value="${currentProvider}"]`)) quickSelect.value = currentProvider;
  } catch {}
}

function setWorkspaceManagerNote(message = '', type = '') {
  const note = document.getElementById('workspace-manager-note');
  note.textContent = message;
  note.className = type;
}

function renderWorkspaces(data) {
  workspaceManagerData = data;
  const active = data.workspaces?.find((item) => item.active) || {};
  document.getElementById('workspace-current-name').textContent = active.name || '—';
  document.getElementById('workspace-current-path').textContent = active.path || data.activePath || '—';
  const list = document.getElementById('workspace-list');
  if (!data.workspaces?.length) {
    list.innerHTML = `<div class="outline-empty">${escapeHtml(t('workspace.empty'))}</div>`;
    return;
  }
  list.innerHTML = data.workspaces.map((item) => `<article class="workspace-list-item${item.active ? ' active' : ''}${item.available ? '' : ' unavailable'}">
    <div class="workspace-list-copy"><strong>${escapeHtml(item.name)}</strong><code title="${escapeHtml(item.path)}">${escapeHtml(item.path)}</code></div>
    <button type="button" data-workspace-id="${escapeHtml(item.id)}"${item.active || !item.available ? ' disabled' : ''}>${escapeHtml(t(item.active ? 'workspace.active' : 'workspace.switch'))}</button>
  </article>`).join('');
}

async function browseWorkspaceFolder(path = '') {
  const browser = document.getElementById('workspace-browser');
  const list = document.getElementById('workspace-browser-list');
  browser.classList.remove('hidden');
  list.innerHTML = `<div class="outline-empty">${escapeHtml(t('workspace.loadingFolders'))}</div>`;
  const res = await fetch(`/api/workspaces/browse?path=${encodeURIComponent(path)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not browse folders');
  browser.dataset.currentPath = data.currentPath;
  browser.dataset.parentPath = data.parentPath || '';
  document.getElementById('workspace-browser-path').textContent = data.currentPath;
  document.getElementById('workspace-browser-path').title = data.currentPath;
  document.getElementById('workspace-browser-up').disabled = !data.parentPath;
  list.innerHTML = data.entries.length ? data.entries.map((entry) => `<button class="workspace-browser-entry" type="button" data-folder-path="${escapeHtml(entry.path)}"><span aria-hidden="true">${entry.git ? '◆' : '▸'}</span><span>${escapeHtml(entry.name)}</span><small>${entry.git ? escapeHtml(t('workspace.gitRepo')) : ''}</small></button>`).join('') : `<div class="outline-empty">${escapeHtml(t('workspace.emptyFolder'))}</div>`;
}

function disposeTerminalView() {
  terminalEvents?.close();
  terminalEvents = null;
  terminalResizeObserver?.disconnect();
  terminalResizeObserver = null;
  terminalView?.dispose();
  terminalView = null;
  terminalFitAddon = null;
  document.getElementById('terminal-screen').replaceChildren();
}

function closeTerminalOverlay() {
  document.getElementById('terminal-overlay').classList.add('hidden');
  disposeTerminalView();
}

async function postTerminal(path, body = {}) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || t('terminal.failed'));
  return data;
}

async function openWorkspaceTerminal(initialCommand = '') {
  const overlay = document.getElementById('terminal-overlay');
  const status = document.getElementById('terminal-status');
  overlay.classList.remove('hidden');
  status.textContent = t('terminal.connecting');
  document.getElementById('terminal-workspace').textContent = document.getElementById('active-workspace-name').title || document.getElementById('active-workspace-name').textContent;
  disposeTerminalView();
  try {
    const { session } = await postTerminal('/api/terminal');
    terminalSessionId = session.id;
    const terminalApi = await globalThis.loadPapergodTerminal?.();
    if (!terminalApi) throw new Error('Terminal renderer is unavailable.');
    terminalView = new terminalApi.Terminal({
      cursorBlink: true, convertEol: false, fontSize: 13, scrollback: 5000,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: { background: '#101114', foreground: '#e4e4e7', cursor: '#93c5fd', selectionBackground: '#334155' },
    });
    terminalFitAddon = new terminalApi.FitAddon();
    terminalView.loadAddon(terminalFitAddon);
    if (terminalApi.WebLinksAddon) terminalView.loadAddon(new terminalApi.WebLinksAddon((_event, uri) => window.open(uri, '_blank', 'noopener')));
    terminalView.open(document.getElementById('terminal-screen'));
    requestAnimationFrame(() => { terminalFitAddon.fit(); postTerminal(`/api/terminal/${encodeURIComponent(session.id)}/resize`, { cols: terminalView.cols, rows: terminalView.rows }).catch(() => {}); terminalView.focus(); });
    terminalView.onData((data) => postTerminal(`/api/terminal/${encodeURIComponent(session.id)}/input`, { data }).catch((error) => { status.textContent = error.message; }));
    terminalEvents = new EventSource(`/api/terminal/${encodeURIComponent(session.id)}/events`);
    terminalEvents.addEventListener('ready', event => {
      const payload = JSON.parse(event.data);
      if (payload.history) terminalView?.write(payload.history);
      status.textContent = t('terminal.connected');
      if (initialCommand) {
        const command = initialCommand;
        initialCommand = '';
        postTerminal(`/api/terminal/${encodeURIComponent(session.id)}/input`, { data: `${command}\n` }).catch((error) => { status.textContent = error.message; });
      }
    });
    terminalEvents.addEventListener('output', event => terminalView?.write(JSON.parse(event.data).data || ''));
    terminalEvents.addEventListener('exit', event => {
      const payload = JSON.parse(event.data);
      status.textContent = t('terminal.exited', { code: payload.exitCode ?? '—' });
      terminalEvents?.close();
      terminalEvents = null;
    });
    terminalEvents.onerror = () => { if (terminalView) status.textContent = t('terminal.connecting'); };
    terminalResizeObserver = new ResizeObserver(() => {
      if (!terminalView || !terminalFitAddon || overlay.classList.contains('hidden')) return;
      terminalFitAddon.fit();
      postTerminal(`/api/terminal/${encodeURIComponent(session.id)}/resize`, { cols: terminalView.cols, rows: terminalView.rows }).catch(() => {});
    });
    terminalResizeObserver.observe(document.getElementById('terminal-screen'));
  } catch (error) {
    status.textContent = error.message || t('terminal.failed');
  }
}

async function openAgentLoginTerminal() {
  const profile = selectedAgentProfile();
  if (profile?.id !== 'codex') return;
  document.getElementById('agent-config-overlay').classList.add('hidden');
  await openWorkspaceTerminal('codex login');
}

async function loadWorkspaces() {
  const list = document.getElementById('workspace-list');
  list.innerHTML = `<div class="outline-empty">${escapeHtml(t('workspace.loading'))}</div>`;
  const res = await fetch('/api/workspaces');
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || t('workspace.failed'));
  renderWorkspaces(data);
  return data;
}

async function openWorkspaceManager() {
  document.getElementById('workspace-manager-overlay').classList.remove('hidden');
  setWorkspaceManagerNote();
  try { await loadWorkspaces(); } catch (error) { setWorkspaceManagerNote(error.message, 'error'); }
}

function setReferencesNote(message = '', type = '') {
  const note = document.getElementById('references-note');
  note.textContent = message;
  note.className = type;
}

async function referenceRequest(path, options = {}) {
  const res = await fetch(path, { ...options, headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Reference operation failed');
  return data;
}

function renderReferenceFolders() {
  const folders = referenceData?.folders || [];
  document.getElementById('references-folders').innerHTML = folders.length
    ? folders.map((folder) => `<div class="reference-folder"><code title="${escapeHtml(folder)}">${escapeHtml(folder)}</code><button type="button" data-remove-reference-folder="${escapeHtml(folder)}" aria-label="Remove">×</button></div>`).join('')
    : `<div class="outline-empty">${escapeHtml(t('references.noFolders'))}</div>`;
}

function renderReferences() {
  const items = referenceData?.items || [];
  document.getElementById('references-count').textContent = `${items.length} reference${items.length === 1 ? '' : 's'}`;
  document.getElementById('references-bib-file').textContent = referenceData?.bibliographyFile || 'references.bib';
  renderReferenceFolders();
  const list = document.getElementById('references-list');
  if (!items.length) return void (list.innerHTML = '<div class="outline-empty">No references yet. Add a literature folder or connect Zotero.</div>');
  list.innerHTML = items.map((item) => {
    const selected = selectedReferenceCitekeys.has(item.citekey);
    const status = item.status || 'needs-review';
    return `<article class="reference-card ${escapeHtml(status)}" data-reference-id="${escapeHtml(item.id)}">
      <label class="reference-select"><input type="checkbox" data-reference-select="${escapeHtml(item.citekey)}"${selected ? ' checked' : ''}><span></span></label>
      <div class="reference-copy"><div class="reference-card-head"><strong>${escapeHtml(item.title || 'Untitled reference')}</strong><span class="reference-status">${escapeHtml(status.replace('-', ' '))}</span></div>
      <p>${escapeHtml((item.authors || []).join('; ') || 'Unknown author')}${item.year ? ` · ${escapeHtml(item.year)}` : ''}</p>
      <div class="reference-meta"><code>${escapeHtml(item.citekey)}</code><span>${escapeHtml(item.source)}</span>${item.doi ? `<span>DOI ${escapeHtml(item.doi)}</span>` : ''}${item.hasPdf ? '<span>PDF</span>' : ''}</div></div>
      <div class="reference-actions"><button type="button" data-insert-cite="${escapeHtml(item.citekey)}">Insert</button><button type="button" data-edit-reference>Edit</button>${item.doi && item.status !== 'verified' ? '<button type="button" data-resolve-reference>Verify DOI</button>' : ''}<label><input type="checkbox" data-include-reference${item.included === false ? '' : ' checked'}> BibTeX</label></div>
    </article>`;
  }).join('');
}

async function loadReferences(query = '') {
  referenceData = await referenceRequest('/api/references' + (query ? `?q=${encodeURIComponent(query)}` : ''));
  renderReferences();
  return referenceData;
}

async function openReferences() {
  document.getElementById('references-overlay').classList.remove('hidden');
  setReferencesNote();
  try { await loadReferences(); } catch (error) { setReferencesNote(error.message, 'error'); }
}

function insertCitations(citekeys) {
  const keys = [...new Set(citekeys)].filter(Boolean);
  if (!keys.length) return setReferencesNote('Select at least one reference.', 'error');
  setWorkspaceView('source');
  editor.replaceSelection(`\\cite{${keys.join(',')}}`);
  editor.focus();
  schedulePromptContextPreview();
  setReferencesNote(`Inserted \\cite{${keys.join(',')}}`, 'success');
}

function renderZoteroResults() {
  const target = document.getElementById('zotero-results');
  target.innerHTML = zoteroReferenceResults.length ? zoteroReferenceResults.map((item, index) => `<article class="zotero-result"><div><strong>${escapeHtml(item.title || 'Untitled')}</strong><p>${escapeHtml((item.authors || []).join('; ') || 'Unknown author')}${item.year ? ` · ${escapeHtml(item.year)}` : ''}</p><code>${escapeHtml(item.citekey)}</code></div><button type="button" data-import-zotero="${index}">Add</button></article>`).join('') : '<div class="outline-empty">No Zotero results.</div>';
}

async function searchZotero() {
  const query = document.getElementById('zotero-search').value.trim();
  const collectionKey = document.getElementById('zotero-collection').value;
  document.getElementById('zotero-results').innerHTML = '<div class="outline-empty">Searching Zotero…</div>';
  const data = await referenceRequest(`/api/references/zotero/items?q=${encodeURIComponent(query)}&collectionKey=${encodeURIComponent(collectionKey)}`);
  zoteroReferenceResults = data.items || [];
  renderZoteroResults();
}

async function connectZotero() {
  const status = document.getElementById('zotero-status');
  status.textContent = 'Connecting…';
  try {
    const data = await referenceRequest('/api/references/zotero/status');
    status.textContent = data.status.betterBibtex ? 'Connected · Better BibTeX' : 'Connected';
    status.className = 'connected';
    const dataCollections = await referenceRequest('/api/references/zotero/collections');
    const select = document.getElementById('zotero-collection');
    select.innerHTML = `<option value="">${escapeHtml(t('references.allZotero'))}</option>` + dataCollections.collections.map((item) => `<option value="${escapeHtml(item.key)}">${escapeHtml(item.name)}</option>`).join('');
    select.value = referenceData?.zotero?.collectionKey || '';
    select.classList.remove('hidden');
    document.getElementById('zotero-search-row').classList.remove('hidden');
    await searchZotero();
  } catch (error) { status.textContent = 'Unavailable'; status.className = 'error'; setReferencesNote(error.message, 'error'); }
}

async function importZoteroReference(index) {
  const reference = zoteroReferenceResults[index];
  if (!reference) return;
  setReferencesNote('Importing Zotero reference…');
  await referenceRequest('/api/references/zotero/import', { method: 'POST', body: JSON.stringify({ references: [reference] }) });
  await referenceRequest('/api/references/bibliography', { method: 'POST' });
  await loadReferences(document.getElementById('references-search').value.trim());
  setReferencesNote(`Added ${reference.citekey} and updated the bibliography.`, 'success');
}

async function checkCurrentCitations() {
  if (!await saveFile()) return;
  const result = await referenceRequest('/api/references/check', { method: 'POST', body: JSON.stringify({ file: currentFile }) });
  const target = document.getElementById('references-check-result');
  target.classList.remove('hidden');
  target.innerHTML = `<strong>${result.missing.length ? `${result.missing.length} missing citekey(s)` : 'All citation keys resolve'}</strong><p>${result.missing.length ? `Missing: ${escapeHtml(result.missing.join(', '))}` : `${result.cited.length} cited · ${result.uncited.length} uncited in bibliography`}</p>`;
  document.getElementById('references-add-setup').classList.toggle('hidden', result.bibliographyConfigured);
}

function addBibliographySetup() {
  const source = editor.getValue();
  if (/\\(?:bibliography|addbibresource)\s*\{/.test(source)) return;
  const bib = (referenceData?.bibliographyFile || 'references.bib').replace(/\.bib(?:tex)?$/i, '');
  const setup = `\n\\bibliographystyle{plain}\n\\bibliography{${bib}}\n`;
  const end = source.lastIndexOf('\\end{document}');
  editor.setValue(end >= 0 ? source.slice(0, end) + setup + source.slice(end) : source + setup);
  document.getElementById('references-add-setup').classList.add('hidden');
  setReferencesNote('Bibliography setup added. Save and compile to verify it.', 'success');
}

async function switchWorkspaceRequest(url, options = {}) {
  setWorkspaceManagerNote(t('workspace.switching'));
  const saved = await saveFile();
  if (!saved) { setWorkspaceManagerNote('Save the current paper before switching.', 'error'); return; }
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || t('workspace.failed'));
  setWorkspaceManagerNote(t('workspace.switching'), 'success');
  window.location.reload();
}

function renderQuickAgentSelector() {
  const select = document.getElementById('agent-provider-quick');
  if (!select) return;
  select.innerHTML = agentProviders.map((item) => `<option value="${escapeHtml(item.id)}"${item.available ? '' : ' disabled'}>${escapeHtml(item.label)}${item.available ? '' : ' · ' + escapeHtml(t('agent.unavailable'))}</option>`).join('');
  select.value = currentProvider;
  select.title = t('agent.activeTitle', { name: agentProviders.find((item) => item.id === currentProvider)?.label || currentProvider });
}

async function activateAgentProvider(id) {
  const profile = agentProviders.find((item) => item.id === id);
  const select = document.getElementById('agent-provider-quick');
  if (!profile || !select) return;
  const previousProvider = currentProvider;
  const generation = ++agentActivationGeneration;
  currentProvider = id;
  renderQuickAgentSelector();
  renderAgentConfiguration();
  showStatus(t('agent.selected', { name: profile.label }), 'success');
  try {
    const res = await fetch('/api/agents/config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, command: profile.command || '', args: profile.args || [], model: profile.model || '', activate: true }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Could not activate ${profile.label}`);
    if (generation !== agentActivationGeneration) return;
    currentProvider = data.selected || id;
    document.getElementById('panel-provider').value = currentProvider;
    renderQuickAgentSelector();
    renderAgentConfiguration();
    showStatus(t('agent.active', { name: profile.label }), 'success');
  } catch (error) {
    if (generation !== agentActivationGeneration) return;
    currentProvider = previousProvider;
    renderQuickAgentSelector();
    renderAgentConfiguration();
    showStatus(error.message, 'error');
  }
}

function selectedAgentProfile() {
  const id = document.getElementById('agent-config-provider')?.value;
  return agentProviders.find((item) => item.id === id) || null;
}

function setAgentConfigNote(message, state = 'neutral') {
  const note = document.getElementById('agent-config-note');
  note.textContent = message;
  note.className = `agent-config-note ${state}`;
}

function fillAgentConfigForm() {
  const profile = selectedAgentProfile();
  if (!profile) return;
  document.getElementById('agent-config-command').value = profile.command || '';
  document.getElementById('agent-config-model').value = profile.model || '';
  document.getElementById('agent-config-reasoning').value = profile.reasoningEffort || '';
  document.getElementById('agent-config-args').value = (profile.args || []).join('\n');
  renderAgentModelDropdown(profile.models || [], profile.model || '');
  const activeModel = profile.model
    ? ` · model: ${profile.model}`
    : (profile.models?.length ? ' · model: CLI default (choose below)' : '');
  const capabilityNote = profile.id === 'mock' ? '' : ` · ${profile.compatible === false ? 'CLI incompatible' : 'structured output ' + (profile.capabilities?.structuredOutput ? 'ready' : 'unverified')}`;
  const freshnessNote = profile.modelCatalog?.source ? ` · models: ${profile.modelCatalog.source}${profile.modelCatalog.stale ? ' (stale)' : ''}` : '';
  const healthNote = profile.health?.available === false ? ` · cooling down (${Math.ceil(profile.health.retryAfterMs / 1000)}s)` : '';
  const warningNote = profile.warnings?.length ? ` · warning: ${profile.warnings[0]}` : '';
  const liveNote = profile.liveCheck ? ` · live test ${profile.liveCheck.ok ? `passed${profile.liveCheck.latencyMs ? ` in ${profile.liveCheck.latencyMs} ms` : ''}` : `failed${profile.liveCheck.code ? ` (${profile.liveCheck.code})` : ''}`}` : ' · live subscription not tested';
  const note = profile.id === 'mock'
    ? t('agent.mockNote')
    : `${profile.available ? t('agent.cliDetected') : t('agent.cliMissing')} ${profile.authStatus || t('agent.authUnchecked')}${liveNote}${activeModel}${capabilityNote}${freshnessNote}${healthNote}${warningNote}${profile.id === currentProvider ? ' ' + t('agent.currentUse') : ' ' + t('agent.saveActivate')}`;
  setAgentConfigNote(note, profile.liveCheck?.ok === false ? 'error' : profile.id === 'mock' || profile.available && profile.authenticated && profile.liveCheck?.ok ? 'success' : profile.available ? 'warning' : 'error');
  const loginButton = document.getElementById('agent-config-login');
  const canLoginHere = profile.id === 'codex' && profile.available && (!profile.authenticated || profile.liveCheck?.code === 'AGENT_AUTH_REQUIRED');
  loginButton.classList.toggle('hidden', !canLoginHere);
  loginButton.textContent = 'Sign in to Codex';
  document.getElementById('agent-config-probe').textContent = profile.id === 'mock' ? t('agent.checkMock') : t('agent.checkSetup', { name: profile.label });
  document.getElementById('agent-config-save').textContent = profile.id === currentProvider ? 'Use this Agent' : t('agent.use', { name: profile.label });
}

function agentModelFilterValue() {
  const input = document.getElementById('agent-config-model');
  const profile = selectedAgentProfile();
  if (!profile) return '';
  const query = input.value.trim().toLowerCase();
  return query && profile.models?.find((model) => model.id === input.value.trim()) ? '' : query;
}

function renderAgentModelDropdown(models, selectedId = '') {
  const dropdown = document.getElementById('agent-model-dropdown');
  dropdown.replaceChildren();
  const query = agentModelFilterValue();
  const items = (models || []).filter((model) => {
    if (!query) return true;
    return `${model.id} ${model.label || ''}`.toLowerCase().includes(query);
  });
  if (!items.length) {
    dropdown.classList.add('hidden');
    return;
  }
  for (const model of items) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'agent-model-option' + (model.id === selectedId ? ' selected' : '');
    option.setAttribute('role', 'option');
    option.innerHTML = `<span class="agent-model-id">${escapeHtml(model.id)}</span>${model.context ? `<span class="agent-model-ctx">${escapeHtml(model.context)}</span>` : ''}`;
    option.addEventListener('mousedown', (event) => {
      event.preventDefault();
      document.getElementById('agent-config-model').value = model.id;
      dropdown.classList.add('hidden');
      document.getElementById('agent-config-model').focus();
    });
    dropdown.appendChild(option);
  }
  dropdown.classList.remove('hidden');
}

function renderAgentConfiguration() {
  const current = agentProviders.find((item) => item.id === currentProvider);
  document.getElementById('agent-config-summary').textContent = current
    ? `${current.label} · ${current.liveCheck?.ok === false ? 'live subscription test failed' : current.available ? current.authenticated ? t('agent.ready') : t('agent.signin') : t('agent.cliMissing')}`
    : currentProvider;
  const list = document.getElementById('agent-provider-list');
  const select = document.getElementById('agent-config-provider');
  const selected = agentProviders.some((item) => item.id === select.value) ? select.value : currentProvider;
  list.innerHTML = agentProviders.map((item) => {
    const liveFailed = item.liveCheck?.ok === false;
    const livePassed = item.liveCheck?.ok === true;
    const state = liveFailed ? 'attention' : item.available && item.authenticated ? 'available' : item.available ? 'attention' : '';
    const stateText = liveFailed ? 'LIVE TEST FAILED' : livePassed ? 'LIVE TEST PASSED' : item.available && item.authenticated ? t('agent.ready') : item.available ? t('agent.signin') : t('agent.notInstalled');
    const providerKind = item.id === 'mock' ? 'Built-in local test Agent' : 'Local subscription CLI';
    return '<button type="button" class="agent-provider-card ' + (item.id === selected ? 'selected ' : '') + (item.id === currentProvider ? 'active' : '')
      + '" data-provider="' + escapeHtml(item.id) + '" aria-pressed="' + String(item.id === selected) + '"><span class="provider-card-head"><strong>'
      + escapeHtml(item.label) + '</strong><span class="' + state + '">' + stateText + '</span></span><span class="provider-card-details">'
      + escapeHtml(providerKind)
      + (item.version ? ' · ' + escapeHtml(item.version) : '')
      + (item.authStatus ? '<br>' + escapeHtml(item.authStatus) : '')
      + (item.liveCheck ? '<br>Live test: ' + escapeHtml(item.liveCheck.ok ? `passed${item.liveCheck.latencyMs ? ` · ${item.liveCheck.latencyMs} ms` : ''}` : `failed${item.liveCheck.code ? ` · ${item.liveCheck.code}` : ''}${item.liveCheck.error ? ` · ${item.liveCheck.error}` : ''}`) + (item.liveCheck.checkedAt ? '<br>' + escapeHtml(new Date(item.liveCheck.checkedAt).toLocaleString()) : '') : '') + '</span>'
      + (item.id === currentProvider ? '<span class="provider-use">' + escapeHtml(t('agent.currently')) + '</span>' : item.available ? '<span class="provider-action">' + escapeHtml(t('agent.clickUse')) + '</span>' : '') + '</button>';
  }).join('');
  select.innerHTML = agentProviders.map((item) => '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.label) + '</option>').join('');
  select.value = agentProviders.some((item) => item.id === selected) ? selected : agentProviders[0]?.id || '';
  fillAgentConfigForm();
}

function selectAgentProvider(id) {
  if (!agentProviders.some((item) => item.id === id)) return;
  document.getElementById('agent-config-provider').value = id;
  renderAgentConfiguration();
  document.getElementById('agent-config-form').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function reflectAgentRunConnection({ provider: providerId, ok, code = '', error = '' }) {
  const profile = agentProviders.find((item) => item.id === providerId);
  if (profile) {
    profile.liveCheck = { ok, status: ok ? 'complete' : 'failed', code, error, checkedAt: new Date().toISOString() };
    if (ok) {
      profile.authenticated = true;
      profile.authStatus = 'Last real Agent request passed';
    } else if (code === 'AGENT_AUTH_REQUIRED') {
      profile.authenticated = false;
      profile.authStatus = 'Authentication failed · sign in again';
    }
    renderQuickAgentSelector();
    renderAgentConfiguration();
  }
  void loadAgentConfiguration();
}

async function loadAgentConfiguration() {
  try {
    const res = await fetch('/api/agents');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Agent configuration failed to load');
    currentProvider = data.selected;
    agentProviders = data.providers || [];
    renderQuickAgentSelector();
    renderAgentConfiguration();
  } catch (error) {
    document.getElementById('agent-config-summary').textContent = error.message;
  }
}

async function saveAgentConfiguration(event) {
  event.preventDefault();
  const profile = selectedAgentProfile();
  if (!profile) return;
  const body = {
    id: profile.id,
    command: document.getElementById('agent-config-command').value.trim(),
    model: document.getElementById('agent-config-model').value.trim(),
    reasoningEffort: document.getElementById('agent-config-reasoning').value,
    args: document.getElementById('agent-config-args').value.split('\n').map((item) => item.trim()).filter(Boolean),
    activate: true,
  };
  const button = document.getElementById('agent-config-save');
  button.disabled = true;
  button.textContent = t('agent.activating', { name: profile.label });
  try {
    const res = await fetch('/api/agents/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Agent configuration save failed');
    currentProvider = data.selected;
    await loadAgentConfiguration();
    document.getElementById('panel-provider').value = ['mock', 'codex', 'claude-code', 'opencode', 'pi'].includes(currentProvider) ? currentProvider : 'mock';
    showStatus(t('agent.configSaved'), 'success');
  } catch (error) { showStatus(error.message, 'error'); }
  finally { button.disabled = false; fillAgentConfigForm(); }
}

async function waitForAgentProbe(testId) {
  const deadline = Date.now() + 65_000;
  while (Date.now() < deadline) {
    const res = await fetch(`/api/agents/probe/${encodeURIComponent(testId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Live subscription test could not be read');
    const test = data.test;
    if (['complete', 'failed', 'cancelled'].includes(test.status)) return test;
    setAgentConfigNote(`Live subscription test ${test.status}…`, 'neutral');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Live subscription test timed out');
}

async function probeAgentConfiguration() {
  const profile = selectedAgentProfile();
  if (!profile) return;
  const button = document.getElementById('agent-config-probe');
  const startedAt = Date.now();
  button.disabled = true;
  button.textContent = t('agent.checking');
  setAgentConfigNote(t('agent.checkingCommand', { name: profile.label }), 'neutral');
  try {
    const body = {
      id: profile.id,
      command: document.getElementById('agent-config-command').value.trim(),
      model: document.getElementById('agent-config-model').value.trim(),
      args: document.getElementById('agent-config-args').value.split('\n').map((item) => item.trim()).filter(Boolean),
      live: true,
    };
    const res = await fetch('/api/agents/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Agent subscription test failed to start');
    const test = await waitForAgentProbe(data.test.id);
    if (test.agent) Object.assign(profile, test.agent);
    profile.liveCheck = { ...(test.liveTest || {}), status: test.status, checkedAt: test.finishedAt };
    if (!test.liveTest?.ok) {
      profile.authenticated = test.liveTest?.code === 'AGENT_AUTH_REQUIRED' ? false : profile.authenticated;
      profile.authStatus = test.liveTest?.code === 'AGENT_AUTH_REQUIRED' ? 'Live subscription test failed · sign in again' : (profile.authStatus || 'Live test failed');
    }
    renderAgentConfiguration();
    await loadAgentConfiguration();
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (!test.liveTest?.ok) throw new Error(`${test.liveTest?.error || 'Live subscription test failed'}${test.liveTest?.code ? ` (${test.liveTest.code})` : ''}`);
    const message = `Live subscription test passed in ${seconds}s · ${test.agent?.version || profile.version || 'CLI detected'} · structured response validated`;
    setAgentConfigNote(message, 'success');
    showStatus(`${profile.label} subscription works`, 'success');
  } catch (error) {
    setAgentConfigNote(error.message, 'error');
    showStatus(error.message, 'error');
  } finally {
    button.disabled = false;
    const selected = selectedAgentProfile();
    button.textContent = selected?.id === 'mock' ? t('agent.checkMock') : t('agent.checkSetup', { name: selected?.label || 'Agent' });
  }
}

function schedulePromptContextPreview() {
  clearTimeout(promptPreviewTimer);
  promptPreviewTimer = setTimeout(refreshPromptContextPreview, 180);
}

async function refreshPromptContextPreview() {
  if (!currentDocument || !editor) return;
  currentPromptPreview = null;
  const selectedId = modificationIntents.length ? null : selectedNode?.type !== 'document' ? selectedNode?.id : null;
  try {
    const res = await fetch('/api/agent/context-preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: selectedId, documentId: currentDocument.id,
        content: selectedId ? '' : editor.getValue(),
        temporaryPrompt: combinedTemporaryPrompt(),
        additionalRequirements: document.getElementById('ai-prompt').value.trim(),
        intentIds: modificationIntents.map((intent) => intent.id),
        resourceIds: [...selectedResourceIds],
        citekeys: [...selectedReferenceCitekeys],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Prompt preview failed');
    currentPromptPreview = data;
    if (modificationIntents.length) renderModificationIntents();
    document.getElementById('prompt-context-meta').textContent = `${data.layers.length} context layers · ${data.characterCount.toLocaleString()} chars · ~${(data.tokenEstimate || 0).toLocaleString()} tokens · ${(data.budget?.remainingCharacters || 0).toLocaleString()} chars remaining`;
    document.getElementById('prompt-context-excerpt').textContent = data.layers.map((layer) => `${layer.name}: ${layer.characters.toLocaleString()} chars${layer.path ? ` · ${typeof layer.path === 'string' ? layer.path : JSON.stringify(layer.path)}` : ''}`).join('\n');
    document.getElementById('prompt-preview-meta').textContent = `${data.provider} · ${data.scope} · ${data.characterCount.toLocaleString()} characters · ~${(data.tokenEstimate || 0).toLocaleString()} tokens · ${data.payload?.schemaTransport || 'unknown'} schema`;
    document.getElementById('prompt-preview-content').textContent = data.payload?.text || data.assembledPrompt;
    document.getElementById('prompt-preview-manifest').textContent = data.manifest ? JSON.stringify(data.manifest, null, 2) : 'Legacy prompt without a manifest.';
  } catch (error) {
    document.getElementById('prompt-context-meta').textContent = error.message;
  }
}

function libraryItems(kind = document.getElementById('library-kind')?.value) {
  if (!libraryData) return [];
  if (kind === 'corpora') return libraryData.corpora;
  if (kind === 'sentence-patterns') return libraryData.sentencePatterns;
  const scope = document.getElementById('library-scope').value;
  return libraryData.vocabulary[scope];
}

function resourceTitle(kind, item) {
  return kind === 'vocabulary' ? item.term : item.name;
}

function resourceBody(kind, item) {
  if (kind === 'corpora') return item.content;
  if (kind === 'sentence-patterns') return item.template;
  return [item.preferred && 'Prefer: ' + item.preferred, item.definition].filter(Boolean).join('\n');
}

function updateLibrarySelectionStatus() {
  const element = document.getElementById('library-selection-status');
  element.textContent = selectedResourceIds.size ? 'Resources: ' + selectedResourceIds.size + ' selected' : 'Resources: auto';
  schedulePromptContextPreview();
}

function renderLibraryList() {
  const container = document.getElementById('library-list');
  if (!libraryData) {
    container.innerHTML = '<div class="outline-empty">Loading...</div>';
    return;
  }
  const kind = document.getElementById('library-kind').value;
  const query = document.getElementById('library-search').value.trim().toLowerCase();
  const items = libraryItems(kind).filter(item => {
    const searchable = JSON.stringify(item).toLowerCase();
    return !query || searchable.includes(query);
  });
  if (!items.length) {
    container.innerHTML = '<div class="outline-empty">No matching resources</div>';
    return;
  }
  container.innerHTML = items.map(item => {
    const tags = (item.tags || []).map(tag => '#' + tag).join(' ');
    return '<article class="library-item" data-resource-id="' + escapeHtml(item.id) + '">'
      + '<div class="library-item-head"><input type="checkbox" class="resource-select" '
      + (selectedResourceIds.has(item.id) ? 'checked ' : '') + 'aria-label="Use resource">'
      + '<strong>' + escapeHtml(resourceTitle(kind, item)) + '</strong>'
      + (kind === 'sentence-patterns' ? '<button class="render-pattern" type="button">Use template</button>' : '')
      + '<button class="delete" type="button">Delete</button></div>'
      + '<p>' + escapeHtml(shorten(resourceBody(kind, item), 260)) + '</p>'
      + (tags ? '<div class="tags">' + escapeHtml(tags) + '</div>' : '') + '</article>';
  }).join('');
  container.querySelectorAll('.library-item').forEach(element => {
    const id = element.dataset.resourceId;
    element.querySelector('.resource-select').addEventListener('change', event => {
      if (event.target.checked) selectedResourceIds.add(id);
      else selectedResourceIds.delete(id);
      updateLibrarySelectionStatus();
    });
    element.querySelector('.delete').addEventListener('click', () => deleteLibraryItem(id));
    element.querySelector('.render-pattern')?.addEventListener('click', () => useSentencePattern(id));
  });
}

async function useSentencePattern(id) {
  const pattern = libraryData.sentencePatterns.find(item => item.id === id);
  if (!pattern) return;
  const values = {};
  for (const slot of pattern.slots) {
    const value = window.prompt(slot.description || ('Value for ' + slot.name), '');
    if (value === null) return;
    values[slot.name] = value;
  }
  try {
    const res = await fetch('/api/libraries/render-pattern', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patternId: id, values }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Pattern rendering failed');
    editor.replaceSelection(data.rendered);
    selectedResourceIds.add(id);
    updateLibrarySelectionStatus();
    document.getElementById('library-overlay').classList.add('hidden');
    showStatus('Sentence pattern inserted', 'success');
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

function updateLibraryForm() {
  const kind = document.getElementById('library-kind').value;
  const scope = document.getElementById('library-scope');
  const nameLabel = document.getElementById('resource-name-label');
  const contentLabel = document.getElementById('resource-content-label');
  const descriptionLabel = document.getElementById('resource-description-label');
  const extraLabel = document.getElementById('resource-extra-label');
  const examples = document.getElementById('resource-examples-field');
  scope.classList.toggle('hidden', kind !== 'vocabulary');
  examples.classList.toggle('hidden', kind !== 'vocabulary');
  nameLabel.textContent = kind === 'vocabulary' ? 'Term' : 'Name';
  contentLabel.textContent = kind === 'corpora' ? 'Corpus content' : kind === 'sentence-patterns' ? 'Template using {slots}' : 'Preferred wording';
  descriptionLabel.textContent = kind === 'vocabulary' ? 'Definition / collaboration note' : 'Description';
  extraLabel.textContent = kind === 'sentence-patterns' ? 'Applicable sections (comma separated)'
    : kind === 'vocabulary' ? 'Alternatives (comma separated)' : 'Optional categories (comma separated)';
  document.getElementById('resource-content').required = kind !== 'vocabulary';
  renderLibraryList();
}

async function loadLibraries() {
  try {
    const res = await fetch('/api/libraries');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Library load failed');
    libraryData = data.libraries;
    const knownIds = new Set([
      ...libraryData.corpora, ...libraryData.sentencePatterns,
      ...libraryData.vocabulary.global, ...libraryData.vocabulary.session,
    ].map(item => item.id));
    selectedResourceIds = new Set([...selectedResourceIds].filter(id => knownIds.has(id)));
    renderLibraryList();
    updateLibrarySelectionStatus();
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

function libraryEndpoint(kind, id = '') {
  const suffix = id ? '/' + encodeURIComponent(id) : '';
  if (kind === 'vocabulary') {
    return '/api/libraries/vocabulary/' + encodeURIComponent(document.getElementById('library-scope').value) + suffix;
  }
  return '/api/libraries/' + encodeURIComponent(kind) + suffix;
}

function splitComma(value) {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

async function createLibraryItem(kind, scope, value) {
  const endpoint = kind === 'vocabulary'
    ? '/api/libraries/vocabulary/' + encodeURIComponent(scope || 'session')
    : '/api/libraries/' + encodeURIComponent(kind);
  const res = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.details?.join('; ') || data.error || 'Library save failed');
  return data.item;
}

async function submitLibraryForm(event) {
  event.preventDefault();
  const kind = document.getElementById('library-kind').value;
  const name = document.getElementById('resource-name').value.trim();
  const content = document.getElementById('resource-content').value.trim();
  const description = document.getElementById('resource-description').value.trim();
  const tags = splitComma(document.getElementById('resource-tags').value);
  const extra = splitComma(document.getElementById('resource-extra').value);
  const source = document.getElementById('resource-source').value.trim();
  let value;
  if (kind === 'corpora') value = { name, content, description, tags, source };
  else if (kind === 'sentence-patterns') {
    const slots = [...new Set([...content.matchAll(/\{([a-zA-Z][\w-]*)\}/g)].map(match => match[1]))]
      .map(slot => ({ name: slot, description: '', required: true }));
    value = { name, template: content, description, tags, source, sectionTypes: extra, slots };
  } else {
    value = {
      term: name, preferred: content, definition: description, tags, source, alternatives: extra,
      examples: document.getElementById('resource-examples').value.split(/\r?\n/).map(item => item.trim()).filter(Boolean),
    };
  }
  try {
    await createLibraryItem(kind, document.getElementById('library-scope').value, value);
    event.target.reset();
    await loadLibraries();
    showStatus('Library resource added', 'success');
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

async function deleteLibraryItem(id) {
  const kind = document.getElementById('library-kind').value;
  try {
    const res = await fetch(libraryEndpoint(kind, id), { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Delete failed');
    selectedResourceIds.delete(id);
    await loadLibraries();
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

function renderCandidates() {
  const container = document.getElementById('library-candidates');
  container.classList.toggle('hidden', extractedCandidates.length === 0);
  if (!extractedCandidates.length) return;
  container.innerHTML = '<h3>Extracted candidates — confirm before adding</h3>' + extractedCandidates.map((candidate, index) => {
    const title = candidate.value.name || candidate.value.term;
    const body = candidate.value.template || candidate.value.preferred || candidate.value.definition;
    return '<article class="candidate-item"><div class="library-item-head"><strong>' + escapeHtml(title)
      + '</strong><button type="button" data-candidate-index="' + index + '">Add</button></div><p>'
      + escapeHtml(shorten(body, 220)) + '</p></article>';
  }).join('');
  container.querySelectorAll('[data-candidate-index]').forEach(button => {
    button.addEventListener('click', async () => {
      const index = Number(button.dataset.candidateIndex);
      const candidate = extractedCandidates[index];
      try {
        await createLibraryItem(candidate.kind, candidate.scope, candidate.value);
        extractedCandidates.splice(index, 1);
        renderCandidates();
        await loadLibraries();
        showStatus('Candidate added to library', 'success');
      } catch (error) {
        showStatus(error.message, 'error');
      }
    });
  });
}

async function extractFromPaper() {
  if (!await saveFile()) return;
  try {
    const res = await fetch('/api/libraries/extract', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: currentFile }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Extraction failed');
    extractedCandidates = [...data.candidates.patterns, ...data.candidates.vocabulary];
    renderCandidates();
    showStatus(extractedCandidates.length + ' candidate(s) extracted', 'success');
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

async function openPdfExtractor() {
  const row = document.getElementById('pdf-extract-row');
  const select = document.getElementById('pdf-file-select');
  select.replaceChildren();
  try {
    const res = await fetch('/api/files');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not list PDF files');
    const pdfs = data.pdfs || [];
    if (!pdfs.length) return showStatus('No PDF files found in the workspace. Add a PDF next to your .tex files.', 'error');
    for (const name of pdfs) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    }
    row.classList.remove('hidden');
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

async function runPdfExtractor() {
  const select = document.getElementById('pdf-file-select');
  const name = select.value;
  if (!name) return;
  const button = document.getElementById('pdf-extract-run');
  button.disabled = true;
  showStatus('Extracting text and patterns from ' + name + '…');
  try {
    let text = '';
    try {
      const task = pdfjsLib.getDocument('/workspace/' + encodeURIComponent(name));
      const pdf = await task.promise;
      for (let page = 1; page <= pdf.numPages; page += 1) {
        const pageData = await pdf.getPage(page);
        const content = await pageData.getTextContent();
        text += content.items.map((item) => item.str).join(' ') + '\n';
        if (text.length > 1_800_000) break;
      }
    } catch (error) {
      throw new Error('Could not read the PDF text layer: ' + error.message + '. Use a text-based PDF (not a scan).');
    }
    const res = await fetch('/api/libraries/extract-text', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, source: name }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Pattern extraction failed');
    extractedCandidates = [...(data.candidates?.patterns || []), ...(data.candidates?.vocabulary || [])];
    renderCandidates();
    document.getElementById('pdf-extract-row').classList.add('hidden');
    showStatus(extractedCandidates.length + ' pattern candidate(s) extracted from ' + name + '. Review and add them to the library.', 'success');
  } catch (error) {
    showStatus(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function renderLibraryUsage() {
  const element = document.getElementById('library-usage');
  if (!lastLibraryUsage) {
    element.classList.add('hidden');
    element.textContent = '';
    return;
  }
  const provided = lastLibraryUsage.providedResources || [];
  const used = new Set(lastLibraryUsage.usedResourceIds || []);
  const usedNames = provided.filter(item => used.has(item.id)).map(item => item.name);
  element.classList.remove('hidden');
  element.innerHTML = '<strong>Library context:</strong> ' + escapeHtml(lastLibraryUsage.mode)
    + ' · provided ' + provided.length + ' · adopted ' + used.size
    + (usedNames.length ? ' (' + escapeHtml(usedNames.join(', ')) + ')' : '');
}

function renderParagraphDraft() {
  const container = document.getElementById('paragraph-draft');
  if (!pendingParagraphDraft) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }
  container.classList.remove('hidden');
  container.innerHTML = '<div class="draft-label">Paragraph draft — review before inserting</div>'
    + '<div class="draft-text">' + escapeHtml(pendingParagraphDraft.text) + '</div>'
    + '<div class="actions"><button class="insert-draft">Insert at selected position</button>'
    + '<button class="discard-draft">Discard</button></div>';
  container.querySelector('.insert-draft').addEventListener('click', async () => {
    const draft = pendingParagraphDraft;
    try {
      const res = await fetch('/api/agent/insert-paragraph', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: currentDocument.id, index: draft.index, text: draft.text, prompt: draft.prompt, runId: draft.runId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Paragraph insertion failed');
      editor.setValue(data.content);
      pendingParagraphDraft = null; renderParagraphDraft();
      await syncStructure({ silent: true });
      showStatus('Paragraph inserted with a recovery point', 'success');
    } catch (error) { showStatus(error.message, 'error'); }
  });
  container.querySelector('.discard-draft').addEventListener('click', () => {
    pendingParagraphDraft = null;
    renderParagraphDraft();
  });
}

function reviewApiError(data, fallback) {
  return data.details?.join('; ') || data.error || fallback;
}

function annotationStatusClass(status) {
  return ['resolved', 'rejected', 'deferred'].includes(status) ? status : 'active';
}

function renderAnnotations() {
  const container = document.getElementById('annotation-list');
  document.getElementById('annotation-count').textContent = selectedAnnotationIds.size + ' selected';
  if (!reviewAnnotations.length) {
    container.innerHTML = '<div class="outline-empty">No comments yet</div>';
    return;
  }
  container.innerHTML = reviewAnnotations.map(annotation => {
    const selectable = !['resolved', 'rejected'].includes(annotation.status);
    return '<article class="annotation-item" data-annotation-id="' + escapeHtml(annotation.id) + '">'
      + '<div class="annotation-head">'
      + '<input class="annotation-select" type="checkbox" ' + (selectedAnnotationIds.has(annotation.id) ? 'checked ' : '')
      + (selectable ? '' : 'disabled ') + 'aria-label="Select opinion">'
      + '<span class="badge ' + escapeHtml(annotation.category) + '">' + escapeHtml(annotation.category) + '</span>'
      + '<span class="severity">' + escapeHtml(annotation.severity) + '</span>'
      + '<span class="review-status ' + annotationStatusClass(annotation.status) + '">' + escapeHtml(annotation.status) + '</span>'
      + '<button class="locate-annotation" type="button">Locate</button></div>'
      + '<p class="annotation-body">' + escapeHtml(annotation.body) + '</p>'
      + (annotation.target?.quote ? '<blockquote>' + escapeHtml(shorten(annotation.target.quote, 240)) + '</blockquote>' : '<div class="unanchored">Document-level opinion</div>')
      + (annotation.suggestedFix ? '<div class="suggested-fix">Proposed: ' + escapeHtml(annotation.suggestedFix) + '</div>' : '')
      + '</article>';
  }).join('');
  container.querySelectorAll('.annotation-item').forEach(element => {
    const annotation = reviewAnnotations.find(item => item.id === element.dataset.annotationId);
    element.querySelector('.annotation-select').addEventListener('change', event => {
      if (event.target.checked) selectedAnnotationIds.add(annotation.id);
      else selectedAnnotationIds.delete(annotation.id);
      document.getElementById('annotation-count').textContent = selectedAnnotationIds.size + ' selected';
    });
    element.querySelector('.locate-annotation').addEventListener('click', () => locateAnnotation(annotation));
  });
}

function locateAnnotation(annotation) {
  const target = annotation.target || {};
  if (target.end > target.start) {
    const start = editor.posFromIndex(target.start);
    const end = editor.posFromIndex(target.end);
    editor.setSelection(start, end);
    editor.scrollIntoView({ from: start, to: end }, 80);
  } else if (target.id) {
    selectStructureNode(target.id);
  }
  document.getElementById('review-overlay').classList.add('hidden');
  editor.focus();
}

function changeRelations(change, revision) {
  const labels = [];
  if (change.dependsOn?.length) labels.push('Depends on ' + change.dependsOn.map(id => revision.changes.findIndex(item => item.id === id) + 1).join(', '));
  if (change.conflictsWith?.length) labels.push('Conflicts with ' + change.conflictsWith.map(id => revision.changes.findIndex(item => item.id === id) + 1).join(', '));
  return labels.join(' · ');
}

function renderRevisions() {
  const container = document.getElementById('revision-list');
  if (!reviewRevisions.length) {
    container.innerHTML = '<div class="outline-empty">No revision plans yet</div>';
    return;
  }
  container.innerHTML = [...reviewRevisions].reverse().map(revision => {
    const editable = !['applied', 'rolled-back'].includes(revision.status);
    const accepted = revision.changes.filter(change => change.status === 'accepted').length;
    const changes = revision.changes.map((change, index) => {
      const relations = changeRelations(change, revision);
      return '<article class="revision-change status-' + escapeHtml(change.status) + '" data-change-id="' + escapeHtml(change.id) + '">'
        + '<div class="change-head"><strong>Change ' + (index + 1) + '</strong><span>' + escapeHtml(change.status) + '</span></div>'
        + '<p class="change-reason">' + escapeHtml(change.reason) + '</p>'
        + '<label>Before</label><pre class="change-before">' + escapeHtml(change.before || 'No exact source range — add replacement text after anchoring') + '</pre>'
        + '<label>After</label><textarea class="change-after" rows="3" ' + (editable ? '' : 'disabled') + '>' + escapeHtml(change.after || '') + '</textarea>'
        + (relations ? '<div class="change-relations">' + escapeHtml(relations) + '</div>' : '')
        + (editable ? '<div class="change-actions"><button data-decision="accepted" class="accept">Accept</button><button data-decision="rejected">Reject</button><button data-decision="deferred">Defer</button></div>' : '')
        + '</article>';
    }).join('');
    const recovery = revision.recoveryPoint
      ? '<div class="recovery-point">Recovery point: ' + escapeHtml(revision.recoveryPoint.id) + '</div>' : '';
    return '<article class="revision-card" data-revision-id="' + escapeHtml(revision.id) + '">'
      + '<div class="revision-head"><div><h4>' + escapeHtml(revision.title) + '</h4><span>' + escapeHtml(revision.status) + ' · ' + revision.changes.length + ' changes · ' + accepted + ' accepted</span></div>'
      + (editable ? '<div><button class="accept-executable">Accept executable</button><button class="apply-revision primary" ' + (accepted ? '' : 'disabled') + '>Apply accepted</button></div>'
        : revision.status === 'applied' ? '<button class="rollback-revision">Rollback</button>' : '') + '</div>'
      + recovery + '<div class="revision-changes">' + changes + '</div></article>';
  }).join('');
  container.querySelectorAll('.revision-card').forEach(card => bindRevisionCard(card));
}

function bindRevisionCard(card) {
  const revision = reviewRevisions.find(item => item.id === card.dataset.revisionId);
  card.querySelectorAll('[data-decision]').forEach(button => {
    button.addEventListener('click', () => decideChange(revision.id, button.closest('.revision-change'), button.dataset.decision));
  });
  card.querySelector('.accept-executable')?.addEventListener('click', async () => {
    const decisions = revision.changes.filter(change => change.executable).map(change => ({ changeId: change.id, status: 'accepted' }));
    if (!decisions.length) return showStatus('No executable changes; add distinct replacement text first', 'error');
    await updateRevisionDecisions(revision.id, decisions);
  });
  card.querySelector('.apply-revision')?.addEventListener('click', () => applyRevisionPlan(revision.id));
  card.querySelector('.rollback-revision')?.addEventListener('click', () => rollbackRevisionPlan(revision.id));
}

async function decideChange(revisionId, element, status) {
  const after = element.querySelector('.change-after').value;
  await updateRevisionDecisions(revisionId, [{ changeId: element.dataset.changeId, status, after }]);
}

async function updateRevisionDecisions(revisionId, decisions) {
  try {
    const res = await fetch('/api/revisions/' + encodeURIComponent(revisionId) + '/decisions', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decisions }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(reviewApiError(data, 'Decision failed'));
    reviewRevisions = reviewRevisions.map(item => item.id === revisionId ? data.revision : item);
    renderRevisions();
    await loadReviewWorkspace();
    showStatus('Revision decision saved', 'success');
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

async function loadReviewWorkspace() {
  if (!currentDocument) return;
  try {
    const query = '?documentId=' + encodeURIComponent(currentDocument.id);
    const [annotationsRes, revisionsRes] = await Promise.all([fetch('/api/annotations' + query), fetch('/api/revisions' + query)]);
    const annotationsData = await annotationsRes.json();
    const revisionsData = await revisionsRes.json();
    if (!annotationsRes.ok) throw new Error(reviewApiError(annotationsData, 'Comments failed to load'));
    if (!revisionsRes.ok) throw new Error(reviewApiError(revisionsData, 'Revisions failed to load'));
    reviewAnnotations = annotationsData.annotations;
    reviewRevisions = revisionsData.revisions;
    const known = new Set(reviewAnnotations.map(item => item.id));
    selectedAnnotationIds = new Set([...selectedAnnotationIds].filter(id => known.has(id)));
    renderAnnotations();
    renderRevisions();
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

async function addSelectionComment(event) {
  event.preventDefault();
  if (!currentDocument) return showStatus('Open and synchronize a TeX document first', 'error');
  const from = editor.getCursor('from');
  const to = editor.getCursor('to');
  const start = editor.indexFromPos(from);
  const end = editor.indexFromPos(to);
  const quote = editor.getRange(from, to);
  if (!quote) return showStatus('Select text in the editor first', 'error');
  if (!await saveFile()) return;
  const targetNode = currentDocument && (nodeForEditorRange(currentDocument.sections, start, end) || currentDocument);
  try {
    const res = await fetch('/api/annotations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        documentId: currentDocument.id,
        target: { type: 'range', id: targetNode.id, start, end, quote },
        category: document.getElementById('selection-category').value,
        severity: document.getElementById('selection-severity').value,
        body: document.getElementById('selection-comment').value.trim(),
        suggestedFix: document.getElementById('selection-fix').value,
        source: { type: 'user', actor: 'author' },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(reviewApiError(data, 'Comment failed to save'));
    event.target.reset();
    await loadReviewWorkspace();
    showStatus('Anchored comment added', 'success');
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

function nodeForEditorRange(nodes, start, end) {
  const candidates = [];
  const visit = items => (items || []).forEach(node => {
    if (node.sourceRange?.start <= start && node.sourceRange?.end >= end) candidates.push(node);
    visit(node.children);
  });
  visit(nodes);
  return candidates.sort((a, b) => (a.sourceRange.end - a.sourceRange.start) - (b.sourceRange.end - b.sourceRange.start))[0] || null;
}

async function importReview(event) {
  event.preventDefault();
  if (!currentDocument) return showStatus('Open and synchronize a TeX document first', 'error');
  if (!await saveFile()) return;
  try {
    const res = await fetch('/api/review/orchestrate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: currentDocument.id, text: document.getElementById('review-import-text').value, actor: document.getElementById('review-actor').value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(reviewApiError(data, 'Review import failed'));
    data.annotations.forEach(item => selectedAnnotationIds.add(item.id));
    document.getElementById('review-import-text').value = '';
    await loadReviewWorkspace();
    showStatus(data.annotations.length + ' atomic opinion(s) imported', 'success');
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

async function planSelectedAnnotations() {
  if (!selectedAnnotationIds.size) return showStatus('Select at least one opinion', 'error');
  try {
    const res = await fetch('/api/revisions/plan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: currentDocument.id, annotationIds: [...selectedAnnotationIds], title: document.getElementById('revision-title-input').value.trim() || 'Guided revision' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(reviewApiError(data, 'Revision plan failed'));
    selectedAnnotationIds.clear();
    await loadReviewWorkspace();
    showStatus('Revision plan created for review', 'success');
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

async function applyRevisionPlan(revisionId) {
  if (!await saveFile()) return;
  try {
    const res = await fetch('/api/revisions/' + encodeURIComponent(revisionId) + '/apply', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(reviewApiError(data, 'Revision apply failed'));
    editor.setValue(data.content);
    await syncStructure({ silent: true });
    await loadReviewWorkspace();
    showStatus('Accepted changes applied; recovery point created', 'success');
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

async function rollbackRevisionPlan(revisionId) {
  try {
    const res = await fetch('/api/revisions/' + encodeURIComponent(revisionId) + '/rollback', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(reviewApiError(data, 'Rollback failed'));
    editor.setValue(data.content);
    await syncStructure({ silent: true });
    await loadReviewWorkspace();
    showStatus('Revision rolled back safely', 'success');
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

async function loadPeerReviewCatalog() {
  try {
    const res = await fetch('/api/reviewer-profiles');
    const data = await res.json();
    if (!res.ok) throw new Error(reviewApiError(data, 'Reviewer profiles failed to load'));
    peerReviewCatalog = data;
    if (!reviewerDrafts.length) reviewerDrafts = data.profiles.map(item => ({ ...item, selected: true }));
    if (!rubricDrafts.length) rubricDrafts = data.defaultRubric.map(item => ({ ...item }));
    document.getElementById('panel-provider').value = currentProvider;
    renderReviewerBuilder();
    renderRubricBuilder();
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

function renderReviewerBuilder() {
  const container = document.getElementById('reviewer-builder');
  container.innerHTML = reviewerDrafts.map((reviewer, index) => '<article class="reviewer-draft" data-reviewer-index="' + index + '">'
    + '<div><input class="reviewer-enabled" type="checkbox" ' + (reviewer.selected ? 'checked ' : '') + 'aria-label="Include reviewer">'
    + '<strong>' + escapeHtml(reviewer.name) + '</strong><span>' + escapeHtml(reviewer.role) + '</span>'
    + (reviewer.custom ? '<button class="remove-reviewer" type="button">×</button>' : '') + '</div>'
    + '<p>' + escapeHtml(reviewer.focus) + '</p><textarea class="reviewer-prompt" rows="2" placeholder="Additional role instruction">' + escapeHtml(reviewer.prompt || '') + '</textarea></article>').join('');
  container.querySelectorAll('.reviewer-draft').forEach(element => {
    const reviewer = reviewerDrafts[Number(element.dataset.reviewerIndex)];
    element.querySelector('.reviewer-enabled').addEventListener('change', event => { reviewer.selected = event.target.checked; });
    element.querySelector('.reviewer-prompt').addEventListener('input', event => { reviewer.prompt = event.target.value; });
    element.querySelector('.remove-reviewer')?.addEventListener('click', () => {
      reviewerDrafts = reviewerDrafts.filter(item => item !== reviewer);
      renderReviewerBuilder();
    });
  });
}

function addCustomReviewer() {
  const name = document.getElementById('custom-reviewer-name').value.trim();
  const focus = document.getElementById('custom-reviewer-focus').value.trim();
  if (!name || !focus) return showStatus('Custom reviewer needs a name and focus', 'error');
  reviewerDrafts.push({
    id: 'custom_' + Date.now(), name, role: document.getElementById('custom-reviewer-role').value,
    focus, prompt: document.getElementById('custom-reviewer-prompt').value.trim(), selected: true, custom: true,
  });
  ['custom-reviewer-name', 'custom-reviewer-focus', 'custom-reviewer-prompt'].forEach(id => { document.getElementById(id).value = ''; });
  renderReviewerBuilder();
}

function renderRubricBuilder() {
  const container = document.getElementById('rubric-builder');
  container.innerHTML = rubricDrafts.map((criterion, index) => '<article class="rubric-draft" data-rubric-index="' + index + '">'
    + '<div><input class="rubric-title" value="' + escapeHtml(criterion.title) + '" aria-label="Criterion title"><input class="rubric-weight" type="number" min="0.1" max="10" step="0.1" value="' + criterion.weight + '" aria-label="Weight"><button class="remove-rubric" type="button">×</button></div>'
    + '<textarea class="rubric-instruction" rows="2" aria-label="Criterion instruction">' + escapeHtml(criterion.instruction) + '</textarea></article>').join('');
  container.querySelectorAll('.rubric-draft').forEach(element => {
    const criterion = rubricDrafts[Number(element.dataset.rubricIndex)];
    element.querySelector('.rubric-title').addEventListener('input', event => { criterion.title = event.target.value; });
    element.querySelector('.rubric-weight').addEventListener('input', event => { criterion.weight = Number(event.target.value); });
    element.querySelector('.rubric-instruction').addEventListener('input', event => { criterion.instruction = event.target.value; });
    element.querySelector('.remove-rubric').addEventListener('click', () => {
      rubricDrafts = rubricDrafts.filter(item => item !== criterion);
      renderRubricBuilder();
    });
  });
}

function addRubricCriterion() {
  rubricDrafts.push({ id: 'rubric_' + Date.now(), title: 'New criterion', instruction: 'Describe what each reviewer must assess.', weight: 1 });
  renderRubricBuilder();
}

async function createPeerReviewRound() {
  if (!currentDocument && !await syncStructure({ silent: true })) return showStatus('Open a TeX document first', 'error');
  const reviewers = reviewerDrafts.filter(item => item.selected).map(({ selected, custom, ...item }) => item);
  if (!reviewers.length) return showStatus('Select at least one reviewer', 'error');
  if (!rubricDrafts.length) return showStatus('Add at least one rubric criterion', 'error');
  try {
    const res = await fetch('/api/reviews', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        documentId: currentDocument.id, name: document.getElementById('panel-name').value.trim(),
        provider: document.getElementById('panel-provider').value, reviewers, rubric: rubricDrafts,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(reviewApiError(data, 'Review round creation failed'));
    await loadPeerReviews();
    showStatus('Review round created; run it when ready', 'success');
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

async function loadPeerReviews() {
  if (!currentDocument) return;
  try {
    const res = await fetch('/api/reviews?documentId=' + encodeURIComponent(currentDocument.id));
    const data = await res.json();
    if (!res.ok) throw new Error(reviewApiError(data, 'Review rounds failed to load'));
    peerReviews = data.reviews;
    const known = new Set(peerReviews.flatMap(review => review.items || []).map(item => item.id));
    selectedPeerItemIds = new Set([...selectedPeerItemIds].filter(id => known.has(id)));
    renderPeerReviews();
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

function renderPeerReviewItem(item, review) {
  const reviewer = review.reviewers.find(candidate => candidate.id === item.reviewerId);
  const selectable = item.kind === 'concern';
  return '<article class="peer-finding ' + escapeHtml(item.kind) + '" data-item-id="' + escapeHtml(item.id) + '">'
    + '<div class="peer-finding-head">' + (selectable ? '<input class="peer-item-select" type="checkbox" ' + (selectedPeerItemIds.has(item.id) ? 'checked ' : '') + '>' : '')
    + '<span class="finding-kind">' + escapeHtml(item.kind) + '</span><span class="badge ' + escapeHtml(item.category) + '">' + escapeHtml(item.category) + '</span>'
    + '<span class="severity">' + escapeHtml(item.severity) + '</span><span class="finding-reviewer">' + escapeHtml(reviewer?.name || item.reviewerId) + '</span>'
    + (item.quote ? '<button class="locate-peer-item" type="button">Locate</button>' : '') + '</div>'
    + '<p>' + escapeHtml(item.body) + '</p>' + (item.quote ? '<blockquote>' + escapeHtml(shorten(item.quote, 220)) + '</blockquote>' : '')
    + (item.suggestedFix ? '<div class="suggested-fix">Proposed: ' + escapeHtml(item.suggestedFix) + '</div>' : '') + '</article>';
}

function renderPeerReviews() {
  const container = document.getElementById('peer-review-list');
  document.getElementById('peer-review-count').textContent = peerReviews.length + ' round(s)';
  if (!peerReviews.length) return container.innerHTML = '<div class="outline-empty">No review rounds yet</div>';
  container.innerHTML = [...peerReviews].reverse().map(review => {
    const synthesis = review.synthesis || {};
    const reportHtml = (review.reports || []).map(report => {
      const reviewer = review.reviewers.find(item => item.id === report.reviewerId);
      return '<details class="peer-report" ' + (report.status === 'failed' ? '' : 'open') + '><summary><strong>' + escapeHtml(reviewer?.name || report.reviewerId) + '</strong><span>' + escapeHtml(report.status) + ' · ' + escapeHtml(report.verdict) + ' · confidence ' + Math.round(report.confidence * 100) + '%</span></summary>'
        + (report.error ? '<div class="report-error">' + escapeHtml(report.error) + '</div>' : '<p class="report-summary">' + escapeHtml(report.summary) + '</p>' + report.items.map(item => renderPeerReviewItem(item, review)).join('')) + '</details>';
    }).join('');
    const synthesisHtml = review.status === 'complete' ? '<section class="peer-synthesis"><h4>Synthesis · ' + escapeHtml(synthesis.verdict) + '</h4><p>' + escapeHtml(synthesis.summary) + '</p>'
      + '<div class="synthesis-counts"><span>Consensus ' + (synthesis.consensus || []).length + '</span><span>Conflicts ' + (synthesis.conflicts || []).length + '</span><span>Priorities ' + (synthesis.priorities || []).length + '</span></div>'
      + (synthesis.consensus || []).map(item => '<div class="consensus-item">Consensus: ' + escapeHtml(item.body) + ' (' + item.reviewerIds.length + ' reviewers)</div>').join('')
      + (synthesis.conflicts || []).map(item => '<div class="conflict-item">Conflict: ' + escapeHtml(item.description) + '</div>').join('') + '</section>' : '';
    const controls = review.status === 'running' ? '<button disabled>Running...</button>'
      : review.status === 'complete' ? '<button class="send-review-revision primary">Send selected concerns to revise</button>'
        : '<button class="run-peer-review primary">Run independent reviews</button>';
    return '<article class="peer-review-card" data-review-id="' + escapeHtml(review.id) + '"><div class="peer-review-head"><div><h4>' + escapeHtml(review.name) + '</h4><span>' + escapeHtml(review.provider) + ' · ' + review.reviewers.length + ' reviewers · ' + escapeHtml(review.status) + '</span></div>' + controls + '</div>'
      + synthesisHtml + reportHtml + '</article>';
  }).join('');
  container.querySelectorAll('.peer-review-card').forEach(card => {
    const review = peerReviews.find(item => item.id === card.dataset.reviewId);
    card.querySelector('.run-peer-review')?.addEventListener('click', () => runPeerReview(review.id));
    card.querySelector('.send-review-revision')?.addEventListener('click', () => transferPeerReview(review));
    card.querySelectorAll('.peer-finding').forEach(element => {
      const item = review.items.find(candidate => candidate.id === element.dataset.itemId);
      element.querySelector('.peer-item-select')?.addEventListener('change', event => {
        if (event.target.checked) selectedPeerItemIds.add(item.id); else selectedPeerItemIds.delete(item.id);
      });
      element.querySelector('.locate-peer-item')?.addEventListener('click', () => locatePeerReviewItem(item));
    });
  });
}

function locatePeerReviewItem(item) {
  const startIndex = item.quote ? editor.getValue().indexOf(item.quote) : -1;
  if (startIndex >= 0) {
    const start = editor.posFromIndex(startIndex); const end = editor.posFromIndex(startIndex + item.quote.length);
    editor.setSelection(start, end); editor.scrollIntoView({ from: start, to: end }, 80);
    document.getElementById('peer-review-overlay').classList.add('hidden'); editor.focus();
  }
}

async function runPeerReview(reviewId) {
  if (!await saveFile()) return;
  showStatus('Independent reviewers are analyzing the manuscript...', '');
  try {
    const res = await fetch('/api/reviews/' + encodeURIComponent(reviewId) + '/run', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(reviewApiError(data, 'Peer review failed'));
    await loadPeerReviews();
    showStatus('Peer review and synthesis complete', 'success');
  } catch (error) {
    await loadPeerReviews(); showStatus(error.message, 'error');
  }
}

async function transferPeerReview(review) {
  const available = review.items.filter(item => item.kind === 'concern');
  const selected = available.filter(item => selectedPeerItemIds.has(item.id));
  const itemIds = (selected.length ? selected : available.filter(item => review.synthesis.priorities.includes(item.id))).map(item => item.id);
  if (!itemIds.length) return showStatus('Select at least one concern', 'error');
  try {
    const res = await fetch('/api/reviews/' + encodeURIComponent(review.id) + '/to-revision', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds, title: review.name + ' revision' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(reviewApiError(data, 'Could not create revision plan'));
    itemIds.forEach(id => selectedPeerItemIds.delete(id));
    document.getElementById('peer-review-overlay').classList.add('hidden');
    document.getElementById('review-overlay').classList.remove('hidden');
    setReviewWorkspaceTab('planning');
    await loadReviewWorkspace();
    showStatus(data.annotations.length + ' review concern(s) sent to revision', 'success');
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

function openOverlay(id) {
  ['library-overlay', 'review-overlay', 'peer-review-overlay'].forEach(overlayId => {
    document.getElementById(overlayId).classList.toggle('hidden', overlayId !== id);
  });
}

function setReviewWorkspaceTab(tab) {
  const planning = tab === 'planning';
  document.getElementById('review-planning-view').classList.toggle('hidden', !planning);
  document.getElementById('review-delivery-view').classList.toggle('hidden', planning);
  const planButton = document.getElementById('review-plan-tab');
  const deliveryButton = document.getElementById('review-delivery-tab');
  planButton.classList.toggle('active', planning);
  deliveryButton.classList.toggle('active', !planning);
  planButton.setAttribute('aria-selected', String(planning));
  deliveryButton.setAttribute('aria-selected', String(!planning));
}

async function loadSelfReviseWorkspace() {
  if (!currentDocument) return;
  try {
    const query = '?documentId=' + encodeURIComponent(currentDocument.id);
    const [annotationsRes, revisionsRes, historyRes] = await Promise.all([
      fetch('/api/annotations' + query), fetch('/api/revisions' + query), fetch('/api/workflow/history' + query),
    ]);
    const [annotationsData, revisionsData, historyData] = await Promise.all([annotationsRes.json(), revisionsRes.json(), historyRes.json()]);
    if (!annotationsRes.ok) throw new Error(reviewApiError(annotationsData, 'Annotations failed to load'));
    if (!revisionsRes.ok) throw new Error(reviewApiError(revisionsData, 'Revisions failed to load'));
    if (!historyRes.ok) throw new Error(reviewApiError(historyData, 'History failed to load'));
    reviewAnnotations = annotationsData.annotations;
    reviewRevisions = revisionsData.revisions;
    workflowHistory = historyData.events;
    renderSelfRevisionPackages();
    renderWorkflowHistory();
    document.getElementById('generation-resource-status').textContent = selectedResourceIds.size
      ? 'Writing resources: ' + selectedResourceIds.size + ' selected' : 'Writing resources: automatic';
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

function renderSelfRevisionPackages() {
  const unresolved = reviewAnnotations.filter(item => !['resolved', 'rejected'].includes(item.status));
  document.getElementById('self-revise-summary').textContent = reviewRevisions.length + ' plans · ' + unresolved.length + ' unresolved opinions';
  const container = document.getElementById('self-revision-list');
  if (!reviewRevisions.length) return container.innerHTML = '<div class="outline-empty">No revision plans yet</div>';
  container.innerHTML = [...reviewRevisions].reverse().map(revision => {
    const letter = revision.responseLetter;
    const responseHtml = letter ? '<form class="response-letter-form"><h5>' + escapeHtml(letter.title) + '</h5>'
      + '<label>Introduction</label><textarea class="response-introduction" rows="3">' + escapeHtml(letter.introduction) + '</textarea>'
      + letter.items.map(item => '<article class="response-item" data-annotation-id="' + escapeHtml(item.annotationId) + '"><div><strong>Comment ' + item.order + '</strong><span>' + escapeHtml(item.status) + ' · ' + escapeHtml(item.location) + '</span></div><blockquote>' + escapeHtml(item.opinion) + '</blockquote><label>Author response</label><textarea class="response-text" rows="3">' + escapeHtml(item.response) + '</textarea></article>').join('')
      + '<button class="save-response-letter primary" type="submit">Save author responses</button></form>' : '';
    const changes = revision.changeList ? '<details class="change-list"><summary>Change list (' + revision.changeList.length + ')</summary>'
      + revision.changeList.map(item => '<article><strong>Change ' + item.order + ' · ' + escapeHtml(item.status) + '</strong><span>' + escapeHtml(item.location) + '</span><p>' + escapeHtml(item.reason) + '</p><div class="mini-diff"><del>' + escapeHtml(shorten(item.before, 260)) + '</del><ins>' + escapeHtml(shorten(item.after, 260)) + '</ins></div></article>').join('') + '</details>' : '';
    const verification = revision.verification ? '<div class="verification ' + (revision.verification.complete ? 'complete' : 'incomplete') + '">Compile: ' + (revision.verification.compile.ok ? 'passed' : 'failed') + ' · unresolved: ' + revision.verification.unresolvedAnnotationIds.length + (revision.verification.compile.error ? '<p>' + escapeHtml(revision.verification.compile.error) + '</p>' : '') + '</div>' : '';
    return '<article class="self-revision-card" data-revision-id="' + escapeHtml(revision.id) + '"><div class="self-revision-head"><div><h4>' + escapeHtml(revision.title) + '</h4><span>' + escapeHtml(revision.status) + (revision.origin ? ' · ' + escapeHtml(revision.origin) : '') + '</span></div><div><button class="open-revision-diff">Open diff</button><button class="prepare-package">' + (letter ? 'Refresh package' : 'Build response package') + '</button>' + (revision.status === 'applied' ? '<button class="verify-revision primary">Compile &amp; verify</button>' : '') + '</div></div>'
      + (revision.recoveryPoint ? '<div class="recovery-point">Recovery point: ' + escapeHtml(revision.recoveryPoint.id) + '</div>' : '')
      + verification + responseHtml + changes + '</article>';
  }).join('');
  container.querySelectorAll('.self-revision-card').forEach(card => bindSelfRevisionCard(card));
}

function bindSelfRevisionCard(card) {
  const revision = reviewRevisions.find(item => item.id === card.dataset.revisionId);
  card.querySelector('.open-revision-diff').addEventListener('click', async () => {
    openOverlay('review-overlay'); await loadReviewWorkspace();
    document.querySelector('#revision-list [data-revision-id="' + CSS.escape(revision.id) + '"]')?.scrollIntoView({ block: 'start' });
  });
  card.querySelector('.prepare-package').addEventListener('click', () => prepareRevisionPackage(revision.id));
  card.querySelector('.verify-revision')?.addEventListener('click', () => verifyRevisionWorkflow(revision.id));
  card.querySelector('.response-letter-form')?.addEventListener('submit', event => saveResponseLetter(event, revision.id));
}

async function prepareRevisionPackage(revisionId) {
  try {
    const res = await fetch('/api/revisions/' + encodeURIComponent(revisionId) + '/package', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(reviewApiError(data, 'Response package failed'));
    reviewRevisions = reviewRevisions.map(item => item.id === revisionId ? data.revision : item);
    renderSelfRevisionPackages();
    showStatus('Response letter and change list prepared', 'success');
  } catch (error) { showStatus(error.message, 'error'); }
}

async function saveResponseLetter(event, revisionId) {
  event.preventDefault();
  const form = event.currentTarget;
  const items = [...form.querySelectorAll('.response-item')].map(element => ({
    annotationId: element.dataset.annotationId, response: element.querySelector('.response-text').value,
  }));
  try {
    const res = await fetch('/api/revisions/' + encodeURIComponent(revisionId) + '/response-letter', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ introduction: form.querySelector('.response-introduction').value, items }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(reviewApiError(data, 'Response letter save failed'));
    const revision = reviewRevisions.find(item => item.id === revisionId); revision.responseLetter = data.responseLetter;
    renderSelfRevisionPackages(); showStatus('Author responses saved', 'success');
  } catch (error) { showStatus(error.message, 'error'); }
}

async function verifyRevisionWorkflow(revisionId) {
  showStatus('Compiling and checking unresolved opinions...', '');
  try {
    const res = await fetch('/api/revisions/' + encodeURIComponent(revisionId) + '/verify', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(reviewApiError(data, 'Revision verification failed'));
    await loadSelfReviseWorkspace();
    if (data.verification.compile.ok) {
      recordSuccessfulCompile(editor.getValue());
      showCompiledPdf('/workspace/' + currentFile.replace(/\.tex$/, '.pdf'));
    }
    showStatus(data.verification.complete ? 'Revision is compiled and all opinions are closed' : 'Verification finished with remaining work', data.verification.complete ? 'success' : 'error');
  } catch (error) { showStatus(error.message, 'error'); }
}

async function generateWholePaper() {
  const instruction = document.getElementById('paper-generation-instruction').value.trim();
  if (!instruction && !currentDocument?.corePrompt) return showStatus('Add a generation instruction or document core prompt', 'error');
  if (!await saveFile()) return;
  const button = document.getElementById('generate-paper'); button.disabled = true;
  showStatus('Generating a complete reviewable LaTeX draft...', '');
  try {
    const res = await fetch('/api/generate/paper', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: currentDocument.id, instruction, resourceIds: [...selectedResourceIds] }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(reviewApiError(data, 'Paper generation failed'));
    pendingPaperGeneration = data;
    renderPaperGenerationPreview();
    await loadSelfReviseWorkspace();
    showStatus('Full-paper draft ready; review the diff before applying', 'success');
  } catch (error) { showStatus(error.message, 'error'); }
  finally { button.disabled = false; }
}

function renderPaperGenerationPreview() {
  const container = document.getElementById('paper-generation-preview');
  if (!pendingPaperGeneration) { container.classList.add('hidden'); container.innerHTML = ''; return; }
  container.classList.remove('hidden');
  container.innerHTML = '<strong>Draft preview — source unchanged</strong><p>' + escapeHtml(pendingPaperGeneration.revision.summary) + '</p><pre>' + escapeHtml(pendingPaperGeneration.draft.slice(0, 3500)) + (pendingPaperGeneration.draft.length > 3500 ? '\n…' : '') + '</pre><button class="open-generated-diff" type="button">Review full before/after diff</button>';
  container.querySelector('.open-generated-diff').addEventListener('click', async () => {
    openOverlay('review-overlay');
    setReviewWorkspaceTab('planning');
    await loadReviewWorkspace();
  });
}

function renderWorkflowHistory() {
  const container = document.getElementById('workflow-history');
  if (!workflowHistory.length) return container.innerHTML = '<div class="outline-empty">No history yet</div>';
  container.innerHTML = workflowHistory.map(event => '<article class="history-event"><span class="history-type">' + escapeHtml(event.type) + '</span><div><strong>' + escapeHtml(event.title) + '</strong><p>' + escapeHtml(event.status) + (event.detail ? ' · ' + escapeHtml(shorten(event.detail, 180)) : '') + '</p></div><time>' + escapeHtml(new Date(event.at).toLocaleString()) + '</time></article>').join('');
}

async function downloadWorkflowExport() {
  if (!currentDocument) return;
  try {
    const res = await fetch('/api/workflow/export?documentId=' + encodeURIComponent(currentDocument.id));
    const data = await res.json();
    if (!res.ok) throw new Error(reviewApiError(data, 'Workflow export failed'));
    const blob = new Blob([JSON.stringify(data.bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
    anchor.href = url; anchor.download = currentFile.replace(/\.tex$/, '') + '-papergod-export.json'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); showStatus('Workflow bundle exported', 'success');
  } catch (error) { showStatus(error.message, 'error'); }
}

async function loadFileTree() {
  try {
    const res = await fetch('/api/files');
    const data = await res.json();
    const tree = document.getElementById('file-tree');
    tree.innerHTML = data.files.map(f =>
      '<li class="' + (f === currentFile ? 'active' : '') + '" data-file="' + escapeHtml(f) + '">' + escapeHtml(f) + '</li>'
    ).join('');
    tree.querySelectorAll('li').forEach(li => {
      li.addEventListener('click', () => loadFile(li.dataset.file));
    });
  } catch (e) {
    showStatus('Failed to load files', 'error');
  }
}

async function loadFile(name) {
  try {
    const res = await fetch('/api/files/' + encodeURIComponent(name));
    if (!res.ok) throw new Error('Load failed');
    const data = await res.json();
    currentFile = name;
    loadedFile = name;
    resetCompiledPreview();
    editor.setValue(data.content);
    suggestions = [];
    lastLibraryUsage = null;
    pendingParagraphDraft = null;
    renderSuggestions();
    renderLibraryUsage();
    renderParagraphDraft();
    document.getElementById('current-file').textContent = name;
    document.querySelectorAll('#file-tree li').forEach(li => {
      li.classList.toggle('active', li.dataset.file === name);
    });
    await syncStructure({ silent: true });
    await loadModificationIntents();
    if (latexEngineAvailable) await compileFile({ silent: true });
  } catch (e) {
    showStatus('Failed to load ' + name, 'error');
    if (!loadedFile) renderOutline();
  }
}

async function saveFile({ sync = true } = {}) {
  if (!loadedFile || loadedFile !== currentFile) {
    showStatus(t('entry.saveBlocked'), 'error');
    return false;
  }
  try {
    const content = editor.getValue();
    const res = await fetch('/api/files/' + encodeURIComponent(currentFile), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) throw new Error('Save failed');
    if (sync) await syncStructure({ silent: true });
    showStatus('Saved', 'success');
    return true;
  } catch {
    showStatus('Save failed', 'error');
    return false;
  }
}

function shorten(value, limit = 52) {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  return clean.length > limit ? clean.slice(0, limit - 1) + '…' : clean;
}

function findNode(nodes, id) {
  for (const node of nodes || []) {
    if (node.id === id) return node;
    const nested = findNode(node.children, id);
    if (nested) return nested;
  }
  return null;
}

function selectedSectionTitle() {
  if (!currentDocument || !selectedNode) return '';
  if (selectedNode.type === 'section') return selectedNode.title || '';
  const contains = (items, nodeId) => items.some(item => item.id === nodeId || contains(item.children || [], nodeId));
  return currentDocument.sections.find(section => contains(section.children || [], selectedNode.id))?.title || '';
}

function focusParagraphs() {
  if (!currentDocument) return [];
  return currentDocument.sections.flatMap((section) => (section.children || []).map((paragraph) => ({ section, paragraph })));
}

function focusSelection() {
  const entries = focusParagraphs();
  const entry = entries.find((item) => item.paragraph.id === focusParagraphId) || entries[0] || null;
  const sentences = entry?.paragraph.children || [];
  const sentence = sentences.find((item) => item.id === focusSentenceId) || sentences[0] || null;
  return { entries, entry, sentences, sentence };
}

function updateFocusProgress() {
  const entries = focusParagraphs();
  const sentences = entries.flatMap((item) => item.paragraph.children || []);
  const paragraphPrompts = entries.filter((item) => item.paragraph.prompt?.trim()).length;
  const sentencePrompts = sentences.filter((item) => item.prompt?.trim()).length;
  document.getElementById('focus-annotation-progress').textContent = `${paragraphPrompts}/${entries.length} paragraph prompts · ${sentencePrompts}/${sentences.length} sentence prompts`;
}

function renderFocusAnnotation() {
  const { entries, entry, sentences, sentence } = focusSelection();
  if (!entry) return;
  focusParagraphId = entry.paragraph.id;
  focusSentenceId = sentence?.id || null;
  const tree = document.getElementById('focus-section-tree');
  tree.innerHTML = currentDocument.sections.map((section) => {
    const paragraphs = section.children || [];
    const activeSection = section.id === entry.section.id;
    return '<section class="focus-section-branch"><button class="focus-section-button ' + (activeSection ? 'active' : '') + '" data-focus-section="' + escapeHtml(section.id) + '">'
      + escapeHtml(section.title) + ' <small>· ' + paragraphs.length + '</small></button><div class="focus-paragraph-branches">'
      + paragraphs.map((paragraph, index) => '<button class="focus-paragraph-button ' + (paragraph.id === entry.paragraph.id ? 'active' : '')
        + '" data-focus-paragraph="' + escapeHtml(paragraph.id) + '">¶ ' + (index + 1) + ' · ' + escapeHtml(shorten(paragraph.summary || paragraph.text, 34)) + '</button>').join('')
      + '</div></section>';
  }).join('');
  tree.querySelectorAll('[data-focus-section]').forEach((button) => button.addEventListener('click', async () => {
    const section = currentDocument.sections.find((item) => item.id === button.dataset.focusSection);
    if (section?.children?.[0]) await changeFocusParagraph(section.children[0].id);
  }));
  tree.querySelectorAll('[data-focus-paragraph]').forEach((button) => button.addEventListener('click', () => changeFocusParagraph(button.dataset.focusParagraph)));

  const paragraphIndex = entries.findIndex((item) => item.paragraph.id === entry.paragraph.id);
  document.getElementById('focus-paragraph-position').textContent = `${entry.section.title} · paragraph ${paragraphIndex + 1} of ${entries.length}`;
  document.getElementById('focus-paragraph-text').textContent = entry.paragraph.text;
  document.getElementById('focus-paragraph-prompt').value = entry.paragraph.prompt || '';
  document.getElementById('focus-prev-paragraph').disabled = paragraphIndex <= 0;
  document.getElementById('focus-next-paragraph').disabled = paragraphIndex >= entries.length - 1;

  const sentenceList = document.getElementById('focus-sentence-list');
  sentenceList.innerHTML = sentences.length ? sentences.map((item, index) => '<button class="focus-sentence-card ' + (item.id === sentence?.id ? 'active' : '')
    + '" data-focus-sentence="' + escapeHtml(item.id) + '"><span>' + (index + 1) + '</span><div>' + escapeHtml(item.text) + '</div></button>').join('')
    : '<div class="outline-empty">No sentences detected in this paragraph</div>';
  sentenceList.querySelectorAll('[data-focus-sentence]').forEach((button) => button.addEventListener('click', () => changeFocusSentence(button.dataset.focusSentence)));
  const sentenceIndex = sentences.findIndex((item) => item.id === sentence?.id);
  document.getElementById('focus-sentence-position').textContent = sentence ? `Sentence ${sentenceIndex + 1} of ${sentences.length}` : 'No sentence selected';
  document.getElementById('focus-sentence-text').textContent = sentence?.text || 'No sentence detected.';
  document.getElementById('focus-sentence-intent').value = sentence?.intent || '';
  document.getElementById('focus-sentence-prompt').value = sentence?.prompt || '';
  document.getElementById('focus-save-sentence').disabled = !sentence;
  focusParagraphDirty = false;
  focusSentenceDirty = false;
  updateFocusProgress();
}

async function saveFocusParagraphPrompt({ silent = false } = {}) {
  const { entry } = focusSelection();
  if (!entry) return false;
  try {
    const prompt = document.getElementById('focus-paragraph-prompt').value;
    const res = await fetch('/api/structure/nodes/' + encodeURIComponent(entry.paragraph.id), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Paragraph prompt save failed');
    Object.assign(entry.paragraph, data.node);
    focusParagraphDirty = false;
    updateFocusProgress();
    schedulePromptContextPreview();
    if (!silent) showStatus('Paragraph prompt saved', 'success');
    return true;
  } catch (error) { showStatus(error.message, 'error'); return false; }
}

async function saveFocusSentenceAnnotation({ silent = false } = {}) {
  const { sentence } = focusSelection();
  if (!sentence) return false;
  try {
    const body = {
      prompt: document.getElementById('focus-sentence-prompt').value,
      intent: document.getElementById('focus-sentence-intent').value,
    };
    const res = await fetch('/api/structure/nodes/' + encodeURIComponent(sentence.id), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Sentence annotation save failed');
    Object.assign(sentence, data.node);
    focusSentenceDirty = false;
    updateFocusProgress();
    schedulePromptContextPreview();
    if (!silent) showStatus('Sentence annotation saved', 'success');
    return true;
  } catch (error) { showStatus(error.message, 'error'); return false; }
}

async function changeFocusParagraph(paragraphId) {
  if (paragraphId === focusParagraphId) return;
  if (focusParagraphDirty && !await saveFocusParagraphPrompt({ silent: true })) return;
  if (focusSentenceDirty && !await saveFocusSentenceAnnotation({ silent: true })) return;
  focusParagraphId = paragraphId;
  focusSentenceId = focusParagraphs().find((item) => item.paragraph.id === paragraphId)?.paragraph.children?.[0]?.id || null;
  renderFocusAnnotation();
}

async function changeFocusSentence(sentenceId) {
  if (sentenceId === focusSentenceId) return;
  if (focusSentenceDirty && !await saveFocusSentenceAnnotation({ silent: true })) return;
  focusSentenceId = sentenceId;
  renderFocusAnnotation();
}

async function openFocusAnnotation() {
  if (!await saveFile()) return;
  if (!await syncStructure({ silent: true }) || !currentDocument) return;
  const entries = focusParagraphs();
  let initial = entries.find((item) => item.paragraph.id === selectedNode?.id || item.paragraph.children?.some((sentence) => sentence.id === selectedNode?.id));
  if (!initial && selectedNode?.type === 'section') initial = entries.find((item) => item.section.id === selectedNode.id);
  initial ||= entries[0];
  if (!initial) return showStatus('No paragraphs detected in this document', 'error');
  focusParagraphId = initial.paragraph.id;
  focusSentenceId = initial.paragraph.children?.[0]?.id || null;
  renderFocusAnnotation();
  document.getElementById('focus-annotation-overlay').classList.remove('hidden');
}

async function closeFocusAnnotation() {
  if (focusParagraphDirty && !await saveFocusParagraphPrompt({ silent: true })) return;
  if (focusSentenceDirty && !await saveFocusSentenceAnnotation({ silent: true })) return;
  document.getElementById('focus-annotation-overlay').classList.add('hidden');
  renderOutline();
  if (selectedNode) selectStructureNode(selectedNode.id, { focus: false });
}

// LaTeX-style heading numbers (1, 1.1, 1.1.1; A, A.1 after \appendix).
// The abstract and starred headings are unnumbered and do not advance counters.
function outlineSectionNumbers(sections) {
  const numbers = new Map();
  const counters = [0, 0, 0, 0, 0, 0];
  let inAppendix = false;
  const letter = (n) => (n >= 1 && n <= 26 ? String.fromCharCode(64 + n) : String(n));
  for (const section of sections || []) {
    if (section.command === 'abstract' || section.starred) continue;
    if (section.appendix && !inAppendix) {
      inAppendix = true;
      counters.fill(0);
    }
    const level = Math.min(Math.max(section.level || 1, 1), counters.length);
    counters[level - 1] += 1;
    counters.fill(0, level);
    numbers.set(section.id, counters.slice(0, level).map((value, index) => (index === 0 && inAppendix ? letter(value) : String(value))).join('.'));
  }
  return numbers;
}

// How many heading levels the outline shows: 0 (title only) to 3, or Infinity for all.
function outlineDepth() {
  const saved = readPreference(OUTLINE_DEPTH_KEY);
  if (saved === 'all') return Infinity;
  const value = Number(saved);
  return saved !== null && [0, 1, 2, 3].includes(value) ? value : 2;
}

function renderOutlineDepthPicker() {
  const depth = outlineDepth();
  const value = depth === Infinity ? 'all' : String(depth);
  document.getElementById('outline-depth-label').textContent = value === 'all' ? t('outlineDepth.allShort') : value;
  document.querySelectorAll('[data-outline-depth]').forEach((item) => item.setAttribute('aria-checked', String(item.dataset.outlineDepth === value)));
}

function initOutlineDepthPicker() {
  const menu = document.getElementById('outline-depth-menu');
  const button = document.getElementById('outline-depth-btn');
  const open = (show) => {
    menu.classList.toggle('hidden', !show);
    button.setAttribute('aria-expanded', String(show));
    if (show) menu.querySelector('[aria-checked="true"]')?.focus();
  };
  renderOutlineDepthPicker();
  button.addEventListener('click', () => open(menu.classList.contains('hidden')));
  menu.querySelectorAll('[data-outline-depth]').forEach((item) => item.addEventListener('click', () => {
    storePreference(OUTLINE_DEPTH_KEY, item.dataset.outlineDepth);
    renderOutlineDepthPicker();
    open(false);
    renderOutline();
  }));
  document.addEventListener('pointerdown', (event) => {
    if (!menu.classList.contains('hidden') && !event.target.closest('#outline-depth-picker')) open(false);
  });
  menu.addEventListener('keydown', (event) => {
    const items = [...menu.querySelectorAll('[data-outline-depth]')];
    const index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') { open(false); button.focus(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); items[(index + 1) % items.length].focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); items[(index - 1 + items.length) % items.length].focus(); }
  });
  document.addEventListener('papergod:locale-changed', renderOutlineDepthPicker);
}

function renderOutline() {
  const container = document.getElementById('outline-tree');
  if (!currentDocument || !loadedFile) {
    if (loadedFile) {
      container.innerHTML = '<div class="outline-empty">No structure available</div>';
      return;
    }
    // Nothing open: let the user pick the paper's entry file right here.
    const hasFiles = entryState.files.length > 0;
    container.innerHTML = '<div class="outline-empty outline-entry-empty"><p>'
      + escapeHtml(t(hasFiles ? 'entry.noFileLoaded' : 'entry.none')) + '</p>'
      + (hasFiles ? '<button type="button" id="outline-choose-entry">' + escapeHtml(t('entry.choose')) + '</button>' : '')
      + '</div>';
    document.getElementById('outline-choose-entry')?.addEventListener('click', (event) => {
      event.stopPropagation();
      openEntryMenu(true);
    });
    return;
  }
  const numbers = outlineSectionNumbers(currentDocument.sections);
  const depth = outlineDepth();
  const sectionHtml = (section) => {
    const number = numbers.get(section.id);
    return '<button type="button" class="outline-node outline-heading-node level-' + Math.min(section.level || 1, 6) + (number ? ' numbered' : '')
      + '" data-node-id="' + escapeHtml(section.id) + '" title="Jump to ' + escapeHtml((number ? number + ' ' : '') + section.title) + ' in PDF">'
      + (number ? '<span class="outline-number">' + escapeHtml(number) + '</span>' : '')
      + '<span class="outline-title">' + escapeHtml(section.title) + '</span></button>';
  };
  container.innerHTML = '<button type="button" class="outline-document" data-node-id="' + escapeHtml(currentDocument.id)
    + '" title="Jump to document title in PDF">' + escapeHtml(currentDocument.title || currentDocument.file) + '</button>'
    + currentDocument.sections.filter((section) => (section.level || 1) <= depth).map(sectionHtml).join('');
  container.querySelectorAll('[data-node-id]').forEach(element => {
    element.addEventListener('click', () => {
      selectStructureNode(element.dataset.nodeId, { forcePreview: true });
    });
  });
  updateOutlineSelection();
}

function updateOutlineSelection() {
  document.querySelectorAll('#outline-tree [data-node-id]').forEach(element => {
    element.classList.toggle('selected', element.dataset.nodeId === selectedNode?.id);
  });
}

function contextName(node) {
  if (!node) return 'Whole document';
  if (node.type === 'document') return 'Document · ' + (node.title || node.file);
  if (node.type === 'section') return 'Section · ' + node.title;
  if (node.type === 'paragraph') return 'Paragraph · ' + shorten(node.summary || node.text, 55);
  return 'Sentence · ' + shorten(node.text, 55);
}

function pdfNodeTargetText(node) {
  if (node.type === 'sentence') return node.text || '';
  if (node.type === 'paragraph') {
    const firstSentence = node.children?.[0]?.text;
    return firstSentence || node.text || '';
  }
  if (node.type === 'section') {
    const firstParagraph = node.children?.[0];
    const firstSentence = firstParagraph?.children?.[0]?.text || firstParagraph?.text;
    return firstSentence || node.title || '';
  }
  return '';
}

function scrollPdfToRange(index, range) {
  for (let position = range.start; position < range.end; position += 1) {
    const anchor = index.positions[position];
    if (anchor?.node) {
      anchor.span.scrollIntoView({ block: 'center', inline: 'nearest' });
      return true;
    }
  }
  return false;
}

function focusPdfNode(node) {
  const preview = document.getElementById('pdf-preview');
  if (!preview || !preview.querySelector('.pdf-page')) return false;
  const index = pdfTextIndex || buildPdfTextIndex();
  if (!index.text) return false;
  const headingRange = (node.type === 'document' || node.type === 'section')
    ? pdfHeadingMappings.find((mapping) => mapping.node.id === node.id)
    : null;
  if (headingRange) {
    clearPdfScopeHighlight();
    highlightPdfRanges(index, [headingRange], 'outline');
    scrollPdfToRange(index, headingRange);
    return true;
  }
  const targetText = pdfNodeTargetText(node);
  if (!targetText) return false;
  const ranges = matchingOccurrences(index, targetText);
  if (!ranges.length) return false;
  clearPdfScopeHighlight();
  highlightPdfRanges(index, [ranges[0]], 'outline');
  scrollPdfToRange(index, ranges[0]);
  return true;
}

function headingSourceRange(node) {
  const source = editor?.getValue?.() || '';
  if (!source || !node) return null;
  if (node.type === 'document') {
    const commandStart = source.search(/\\title\s*\{/);
    if (commandStart < 0 || !node.title) return null;
    const titleStart = source.indexOf(node.title, commandStart);
    return titleStart < 0 ? null : { start: titleStart, end: titleStart + node.title.length };
  }
  if (node.type !== 'section' || !node.sourceRange) return null;
  const headingStart = node.sourceRange.start;
  const headingEnd = node.sourceRange.contentStart || node.sourceRange.end;
  const titleOffset = source.slice(headingStart, headingEnd).indexOf(node.title || '');
  return titleOffset < 0 ? null : {
    start: headingStart + titleOffset,
    end: headingStart + titleOffset + node.title.length,
  };
}

function selectStructureNode(nodeId, { focus = true, editHeading = false, forceSource = false, forcePreview = false } = {}) {
  if (!currentDocument) return;
  const node = nodeId === currentDocument.id ? { ...currentDocument, type: 'document' } : findNode(currentDocument.sections, nodeId);
  if (!node) return;
  selectedNode = node;
  document.getElementById('context-title').textContent = contextName(node);
  document.getElementById('context-summary').value = node.summary || '';
  document.getElementById('context-prompt').value = node.corePrompt || node.prompt || '';
  const intentField = document.getElementById('intent-field');
  intentField.classList.toggle('hidden', node.type !== 'sentence');
  document.getElementById('context-intent').value = node.intent || '';
  document.getElementById('ai-prompt').placeholder = node.type === 'document'
    ? 'Add a one-time document goal or constraint (optional)…'
    : 'Add a one-time ' + node.type + ' goal or constraint (optional)…';
  updateOutlineSelection();
  schedulePromptContextPreview();
  const editRange = editHeading ? headingSourceRange(node) : node.sourceRange;
  if (focus && forceSource && !sourceVisible()) setWorkspaceView('source');
  // Split view shows both panes, so outline navigation moves the editor too.
  const split = workspaceView === 'split';
  let previewReady = true;
  if (focus && forcePreview) {
    previewReady = !document.getElementById('preview-view-btn').disabled
      && Boolean(document.querySelector('#pdf-preview .pdf-page'));
    if (!previewReady && !split) {
      showStatus('Compile the PDF before using outline navigation.', '');
      return;
    }
    if (previewReady && !previewVisible()) setWorkspaceView('preview');
  }
  if (focus && forcePreview && split) {
    const anchor = headingSourceRange(node) || node.sourceRange;
    if (anchor) {
      const start = editor.posFromIndex(anchor.start);
      editor.setSelection(start, editor.posFromIndex(anchor.end));
      editor.scrollTo(null, Math.max(0, editor.charCoords(start, 'local').top - 48));
    }
    if (!previewReady) return;
  }
  if (focus && editRange && !forcePreview) {
    const start = editor.posFromIndex(editRange.start);
    const end = editor.posFromIndex(editRange.end);
    editor.setSelection(start, end);
    if (sourceVisible()) {
      requestAnimationFrame(() => {
        editor.scrollIntoView({ from: start, to: end }, 80);
        editor.focus();
      });
    }
  }
  if (focus && !forceSource && !focusPdfNode(node) && (previewVisible() || forcePreview)) {
    showStatus('Could not locate this content in the PDF. Recompile to refresh the text layer.', '');
  }
}

async function syncStructure({ silent = false } = {}) {
  if (!currentFile) return false;
  const selectedId = selectedNode?.id;
  try {
    const res = await fetch('/api/documents/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: currentFile }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Structure sync failed');
    currentDocument = data.document;
    rebuildPdfSentenceMappings();
    renderOutline();
    const nextId = selectedId && (selectedId === currentDocument.id || findNode(currentDocument.sections, selectedId))
      ? selectedId : currentDocument.id;
    selectStructureNode(nextId, { focus: false });
    if (!silent) showStatus('Outline synchronized', 'success');
    return true;
  } catch (error) {
    currentDocument = null;
    pdfSentenceMappings = [];
    selectedNode = null;
    renderOutline();
    if (!silent) showStatus(error.message, 'error');
    return false;
  }
}

async function saveContext() {
  if (!selectedNode) return;
  const body = {
    summary: document.getElementById('context-summary').value,
  };
  let endpoint;
  if (selectedNode.type === 'document') {
    body.corePrompt = document.getElementById('context-prompt').value;
    endpoint = '/api/documents/' + encodeURIComponent(currentDocument.id) + '/metadata';
  } else {
    body.prompt = document.getElementById('context-prompt').value;
    if (selectedNode.type === 'sentence') body.intent = document.getElementById('context-intent').value;
    endpoint = '/api/structure/nodes/' + encodeURIComponent(selectedNode.id);
  }
  try {
    const res = await fetch(endpoint, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Context save failed');
    if (data.document) {
      currentDocument = data.document;
      rebuildPdfSentenceMappings();
      selectedNode = { ...currentDocument, type: 'document' };
    } else {
      Object.assign(selectedNode, data.node);
    }
    renderOutline();
    selectStructureNode(selectedNode.id, { focus: false });
    schedulePromptContextPreview();
    showStatus('Writing context saved', 'success');
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

// --- Find & replace (Ctrl/Cmd+F), Overleaf-style bar under the editor -------

const searchState = {
  open: false,
  regex: null,        // compiled global RegExp for the current query, or null
  matches: [],        // [{ start, end, text }] as document offsets
  current: -1,
  overlay: null,
  currentMark: null,
  scrollbar: null,
  refreshTimer: null,
};
const SEARCH_MAX_MATCHES = 10000;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function searchOption(id) {
  return document.getElementById(id).getAttribute('aria-pressed') === 'true';
}

// Build the query RegExp from the input and toggles; null for an empty query,
// an Error for an invalid regular expression.
function buildSearchRegex() {
  const text = document.getElementById('search-query').value;
  if (!text) return null;
  let source = searchOption('search-regex') ? text : escapeRegExp(text);
  if (searchOption('search-word')) source = '(?<![\\p{L}\\p{N}_])(?:' + source + ')(?![\\p{L}\\p{N}_])';
  try {
    return new RegExp(source, 'gu' + (searchOption('search-case') ? '' : 'i') + (searchOption('search-regex') ? 'm' : ''));
  } catch (error) {
    return error;
  }
}

function clearSearchDecorations() {
  if (searchState.overlay) editor.removeOverlay(searchState.overlay);
  searchState.overlay = null;
  searchState.currentMark?.clear();
  searchState.currentMark = null;
  searchState.scrollbar?.clear();
  searchState.scrollbar = null;
}

// Highlight every match with a line overlay (cheap even for many matches).
function searchOverlay(regex) {
  const lineRegex = new RegExp(regex.source, regex.flags.replace('m', ''));
  return {
    token(stream) {
      lineRegex.lastIndex = stream.pos;
      const match = lineRegex.exec(stream.string);
      if (match && match.index === stream.pos) {
        stream.pos += match[0].length || 1;
        return 'searching';
      }
      if (match) stream.pos = match.index;
      else stream.skipToEnd();
      return null;
    },
  };
}

function refreshSearch({ keepPosition = false, reveal = true } = {}) {
  const input = document.getElementById('search-query');
  const regex = buildSearchRegex();
  clearSearchDecorations();
  searchState.matches = [];
  searchState.regex = regex instanceof RegExp ? regex : null;
  input.classList.toggle('invalid', regex instanceof Error);
  input.title = regex instanceof Error ? regex.message : '';
  if (searchState.regex) {
    const text = editor.getValue();
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) && searchState.matches.length < SEARCH_MAX_MATCHES) {
      if (!match[0].length) { regex.lastIndex += 1; continue; }
      searchState.matches.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
    }
    searchState.overlay = searchOverlay(regex);
    editor.addOverlay(searchState.overlay);
    if (editor.showMatchesOnScrollbar) {
      searchState.scrollbar = editor.showMatchesOnScrollbar(new RegExp(regex.source, regex.flags.replace('g', '')), false, 'CodeMirror-search-match');
    }
  }
  const anchor = keepPosition && searchState.current >= 0
    ? searchState.matches.findIndex((item) => item.start >= (searchState.anchor ?? 0))
    : searchState.matches.findIndex((item) => item.end > editor.indexFromPos(editor.getCursor('from')));
  selectSearchMatch(searchState.matches.length ? (anchor >= 0 ? anchor : 0) : -1, { reveal });
}

function selectSearchMatch(index, { reveal = true } = {}) {
  searchState.currentMark?.clear();
  searchState.currentMark = null;
  searchState.current = index;
  const count = document.getElementById('search-count');
  const query = document.getElementById('search-query').value;
  count.textContent = !query ? '' : searchState.matches.length
    ? t('search.count', { current: index + 1, total: searchState.matches.length + (searchState.matches.length >= SEARCH_MAX_MATCHES ? '+' : '') })
    : t('search.noResults');
  count.classList.toggle('empty', Boolean(query) && !searchState.matches.length);
  if (index < 0) return;
  const match = searchState.matches[index];
  searchState.anchor = match.start;
  const from = editor.posFromIndex(match.start);
  const to = editor.posFromIndex(match.end);
  searchState.currentMark = editor.markText(from, to, { className: 'cm-search-current' });
  editor.setSelection(from, to, { scroll: false });
  if (reveal) editor.scrollIntoView({ from, to }, 80);
}

function stepSearch(direction) {
  if (!searchState.matches.length) return;
  const total = searchState.matches.length;
  selectSearchMatch((searchState.current + direction + total) % total);
}

function replacementFor(matchText) {
  const replace = document.getElementById('search-replace').value;
  if (!searchOption('search-regex') || !searchState.regex) return replace;
  // Support $1, $&, ... by re-running the match on its own text.
  return matchText.replace(new RegExp(searchState.regex.source, searchState.regex.flags.replace('g', '')), replace);
}

function replaceCurrentMatch() {
  const match = searchState.matches[searchState.current];
  if (!match) return;
  editor.replaceRange(replacementFor(match.text), editor.posFromIndex(match.start), editor.posFromIndex(match.end), '+replace');
  searchState.anchor = match.start + replacementFor(match.text).length;
  searchState.current = 0;
  refreshSearch({ keepPosition: true });
}

function replaceAllMatches() {
  const matches = searchState.matches;
  if (!matches.length) return;
  // One operation, applied back to front, so it is a single undo step.
  editor.operation(() => {
    for (let index = matches.length - 1; index >= 0; index -= 1) {
      const match = matches[index];
      editor.replaceRange(replacementFor(match.text), editor.posFromIndex(match.start), editor.posFromIndex(match.end), '*replace');
    }
  });
  showStatus(t('search.replacedAll', { count: matches.length }), 'success');
  refreshSearch({ reveal: false });
}

function openSearch({ replace = false } = {}) {
  const panel = document.getElementById('search-panel');
  const input = document.getElementById('search-query');
  if (!sourceVisible()) setWorkspaceView('source');
  const selection = editor.getSelection();
  if (selection && !selection.includes('\n')) input.value = selection;
  const wasOpen = searchState.open;
  searchState.open = true;
  panel.classList.remove('hidden');
  if (!wasOpen) editor.refresh();
  const target = replace ? document.getElementById('search-replace') : input;
  target.focus();
  target.select();
  refreshSearch();
}

function closeSearch({ focusEditor = true } = {}) {
  if (!searchState.open) return;
  searchState.open = false;
  clearSearchDecorations();
  searchState.matches = [];
  searchState.current = -1;
  document.getElementById('search-panel').classList.add('hidden');
  editor.refresh();
  if (focusEditor) editor.focus();
}

function initSearchPanel() {
  const query = document.getElementById('search-query');
  const replace = document.getElementById('search-replace');
  query.addEventListener('input', () => refreshSearch());
  for (const id of ['search-case', 'search-regex', 'search-word']) {
    document.getElementById(id).addEventListener('click', (event) => {
      const button = event.currentTarget;
      button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'));
      refreshSearch();
      query.focus();
    });
  }
  document.getElementById('search-prev').addEventListener('click', () => stepSearch(-1));
  document.getElementById('search-next').addEventListener('click', () => stepSearch(1));
  document.getElementById('search-close').addEventListener('click', () => closeSearch());
  document.getElementById('search-replace-one').addEventListener('click', replaceCurrentMatch);
  document.getElementById('search-replace-all').addEventListener('click', replaceAllMatches);
  const onKey = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); closeSearch(); }
    else if (event.key === 'F3') { event.preventDefault(); stepSearch(event.shiftKey ? -1 : 1); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); query.focus(); query.select(); }
  };
  query.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); stepSearch(event.shiftKey ? -1 : 1); }
    else onKey(event);
  });
  replace.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) replaceAllMatches();
      else replaceCurrentMatch();
    } else onKey(event);
  });
  // Keep counts and highlights current while the document is edited.
  editor.on('changes', (_instance, changes) => {
    if (!searchState.open || changes.every((change) => change.origin === '+replace' || change.origin === '*replace')) return;
    clearTimeout(searchState.refreshTimer);
    searchState.refreshTimer = setTimeout(() => refreshSearch({ keepPosition: true, reveal: false }), 150);
  });
  editor.on('swapDoc', () => closeSearch({ focusEditor: false }));
}

// --- Compile errors shown in the PDF area -------------------------------------

let lastCompileError = null;

// Pull structured errors out of a TeX transcript. With -file-line-error, errors
// read "./file.tex:42: message" (tectonic: "error: file.tex:42: message");
// errors without a location start with "! " and may be followed by "l.42 ...".
function parseLatexLog(log, fallbackError, compiledFile) {
  const lines = String(log || '').split(/\r?\n/);
  const errors = [];
  const seen = new Set();
  const add = (entry) => {
    const key = `${entry.file}:${entry.line}:${entry.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    errors.push(entry);
  };
  const contextAfter = (index) => {
    for (let next = index + 1; next < Math.min(lines.length, index + 14); next += 1) {
      const match = lines[next].match(/^l\.(\d+)\s?(.*)$/);
      if (match) return { line: Number(match[1]), context: match[2].trim() };
    }
    return null;
  };
  lines.forEach((text, index) => {
    const located = text.match(/^(?:error: )?(.+?\.(?:tex|sty|cls|bbl)):(\d+): (.+)$/);
    if (located) {
      const after = contextAfter(index);
      add({ file: located[1].replace(/^\.\//, '').replace(/\\/g, '/'), line: Number(located[2]), message: located[3].trim(), context: after?.context || '', logLine: index });
      return;
    }
    if (text.startsWith('! ')) {
      const after = contextAfter(index);
      add({ file: after ? compiledFile : null, line: after?.line || null, message: text.slice(2).trim(), context: after?.context || '', logLine: index });
    }
  });
  if (!errors.length && fallbackError) add({ file: null, line: null, message: String(fallbackError), context: '', logLine: -1 });
  // -halt-on-error appends a generic "Fatal error occurred" / "Emergency stop"
  // line after the real error; list it only when nothing more specific exists.
  const generic = /^==> Fatal error occurred|^Emergency stop/;
  const specific = errors.filter((error) => !generic.test(error.message));
  return specific.length ? specific : errors;
}

function classifyLogLine(text) {
  if (/^(?:error: )?.+?\.(?:tex|sty|cls|bbl):\d+: |^! /.test(text)) return 'error';
  if (/Warning|^Overfull|^Underfull|^Missing character/.test(text)) return 'warning';
  return '';
}

function showCompileError(result, { reveal = false } = {}) {
  const errors = parseLatexLog(result.log, result.error, result.file);
  lastCompileError = { ...result, errors };
  const panel = document.getElementById('compile-error-panel');
  document.getElementById('compile-error-meta').textContent = [result.file, result.engine].filter(Boolean).join(' · ');
  const list = document.getElementById('compile-error-list');
  list.innerHTML = errors.map((error, index) => {
    const where = error.file && error.line ? `${error.file}:${error.line}` : error.line ? `line ${error.line}` : '';
    return '<li><button type="button" data-compile-error="' + index + '"' + (error.line ? '' : ' disabled') + '>'
      + (where ? '<span class="compile-error-where">' + escapeHtml(where) + '</span>' : '')
      + '<span class="compile-error-message">' + escapeHtml(error.message) + '</span>'
      + (error.context ? '<code>' + escapeHtml(error.context) + '</code>' : '')
      + '</button></li>';
  }).join('');
  list.querySelectorAll('[data-compile-error]').forEach((button) => button.addEventListener('click', () => {
    const error = errors[Number(button.dataset.compileError)];
    jumpToSourceLine(error.file || result.file, error.line);
  }));
  const logLines = String(result.log || '').split(/\r?\n/);
  const logElement = document.getElementById('compile-error-log');
  logElement.innerHTML = result.log
    ? logLines.map((text, index) => {
      const kind = classifyLogLine(text);
      return '<span data-log-line="' + index + '"' + (kind ? ' class="log-' + kind + '"' : '') + '>' + escapeHtml(text) + '</span>';
    }).join('\n')
    : escapeHtml(t('compileError.noLog'));
  const warnings = logLines.filter((text) => classifyLogLine(text) === 'warning').length;
  document.getElementById('compile-error-log-stats').textContent = t('compileError.stats', { errors: errors.length, warnings });
  panel.classList.remove('hidden');
  document.getElementById('compile-error-banner').classList.add('hidden');
  document.getElementById('compile-error-hide').classList.toggle('hidden', !document.querySelector('#pdf-preview .pdf-page'));
  // Make the preview reachable even before any PDF has rendered.
  document.getElementById('preview-view-btn').disabled = false;
  if (reveal && !previewVisible()) setWorkspaceView('preview');
  const firstError = errors.find((error) => error.logLine >= 0);
  requestAnimationFrame(() => {
    const target = firstError && logElement.querySelector('[data-log-line="' + firstError.logLine + '"]');
    logElement.scrollTop = target ? Math.max(0, target.offsetTop - logElement.clientHeight / 3) : logElement.scrollHeight;
  });
}

function hideCompileError({ clear = false } = {}) {
  document.getElementById('compile-error-panel').classList.add('hidden');
  if (clear) lastCompileError = null;
  document.getElementById('compile-error-banner').classList.toggle('hidden', !lastCompileError);
}

async function jumpToSourceLine(file, line) {
  if (!line) return;
  const target = String(file || '').replace(/^\.\//, '');
  if (target && target !== loadedFile && entryState.files.includes(target)) {
    if (loadedFile && !await saveFile({ sync: false })) return;
    await loadFile(target);
  }
  if (!sourceVisible()) setWorkspaceView('source');
  const position = { line: Math.max(0, Math.min(editor.lineCount() - 1, line - 1)), ch: 0 };
  editor.setSelection(position, { line: position.line, ch: editor.getLine(position.line).length });
  requestAnimationFrame(() => {
    editor.scrollIntoView(position, 120);
    editor.focus();
  });
}

function initCompileErrorPanel() {
  document.getElementById('compile-error-hide').addEventListener('click', () => hideCompileError());
  document.getElementById('compile-error-banner').addEventListener('click', () => {
    if (lastCompileError) showCompileError(lastCompileError);
  });
  document.getElementById('compile-error-copy').addEventListener('click', async () => {
    const text = lastCompileError?.log || lastCompileError?.error || '';
    try {
      await navigator.clipboard.writeText(text);
      showStatus(t('compileError.copied'), 'success');
    } catch {
      showStatus(t('compileError.copyFailed'), 'error');
    }
  });
}

// Compile the paper's entry file (like Overleaf's main document), so editing an
// \input chapter still rebuilds the whole paper.
function compileTarget() {
  return entryState.entryFile && entryState.files.includes(entryState.entryFile) ? entryState.entryFile : currentFile;
}

async function fetchEntryState() {
  const res = await fetch('/api/entry');
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not read the entry file');
  entryState = { entryFile: data.entryFile, saved: Boolean(data.saved), files: data.files || [] };
  renderEntryPicker();
  return entryState;
}

function renderEntryPicker() {
  document.getElementById('entry-file-name').textContent = entryState.entryFile || t('entry.noneShort');
  const button = document.getElementById('entry-file-button');
  button.title = entryState.entryFile
    ? t(entryState.saved ? 'entry.titleSaved' : 'entry.titleDetected', { file: entryState.entryFile })
    : t('entry.none');
  button.classList.toggle('unconfirmed', Boolean(entryState.entryFile) && !entryState.saved);
  const menu = document.getElementById('entry-file-menu');
  const items = entryState.files.map((file) => {
    const isEntry = file === entryState.entryFile;
    const badge = isEntry ? '<span class="entry-badge">' + escapeHtml(t(entryState.saved ? 'entry.badge' : 'entry.badgeDetected')) + '</span>' : '';
    const open = file === loadedFile ? '<span class="entry-open-dot" title="' + escapeHtml(t('entry.openNow')) + '"></span>' : '';
    return '<button type="button" role="menuitemradio" aria-checked="' + isEntry + '" data-entry-file="' + escapeHtml(file) + '">'
      + '<span class="entry-check" aria-hidden="true">' + (isEntry ? '★' : '') + '</span>'
      + '<span class="entry-path">' + escapeHtml(file) + '</span>' + open + badge + '</button>';
  }).join('');
  menu.innerHTML = '<div class="entry-menu-head"><strong>' + escapeHtml(t('entry.label')) + '</strong><span>' + escapeHtml(t('entry.help')) + '</span></div>'
    + (entryState.entryFile && !entryState.saved ? '<p class="entry-menu-note">' + escapeHtml(t('entry.detectedNote', { file: entryState.entryFile })) + '</p>' : '')
    + (items ? '<div class="entry-menu-list">' + items + '</div>' : '<p class="entry-menu-note">' + escapeHtml(t('entry.none')) + '</p>');
  menu.querySelectorAll('[data-entry-file]').forEach((item) => item.addEventListener('click', () => chooseEntryFile(item.dataset.entryFile)));
}

async function openEntryMenu(show) {
  const menu = document.getElementById('entry-file-menu');
  const button = document.getElementById('entry-file-button');
  if (show) {
    try { await fetchEntryState(); } catch (error) { showStatus(error.message, 'error'); }
  }
  menu.classList.toggle('hidden', !show);
  button.setAttribute('aria-expanded', String(show));
  if (show) (menu.querySelector('[aria-checked="true"]') || menu.querySelector('[data-entry-file]'))?.focus();
}

async function chooseEntryFile(file) {
  openEntryMenu(false);
  try {
    const res = await fetch('/api/entry', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not set the entry file');
    entryState = { entryFile: data.entryFile, saved: true, files: data.files || [] };
    renderEntryPicker();
    showStatus(t('entry.set', { file }), 'success');
  } catch (error) {
    showStatus(error.message, 'error');
    return;
  }
  if (file !== loadedFile) {
    if (loadedFile && !await saveFile({ sync: false })) return;
    await loadFile(file);
  } else if (latexEngineAvailable) {
    await compileFile({ silent: true });
  }
}

async function openEntryFile() {
  try {
    await fetchEntryState();
  } catch (error) {
    showStatus(error.message, 'error');
  }
  if (entryState.entryFile) await loadFile(entryState.entryFile);
  else renderOutline();
}

function initEntryPicker() {
  const menu = document.getElementById('entry-file-menu');
  const button = document.getElementById('entry-file-button');
  button.addEventListener('click', () => openEntryMenu(menu.classList.contains('hidden')));
  document.addEventListener('pointerdown', (event) => {
    if (menu.classList.contains('hidden') || event.target.closest('#entry-file-picker')) return;
    openEntryMenu(false);
  });
  menu.addEventListener('keydown', (event) => {
    const items = [...menu.querySelectorAll('[data-entry-file]')];
    const index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') { openEntryMenu(false); button.focus(); }
    else if (event.key === 'ArrowDown' && items.length) { event.preventDefault(); items[(index + 1) % items.length].focus(); }
    else if (event.key === 'ArrowUp' && items.length) { event.preventDefault(); items[(index - 1 + items.length) % items.length].focus(); }
  });
}

let compileInFlight = false;

function setCompileBusy(busy) {
  compileInFlight = busy;
  document.getElementById('compile-split').classList.toggle('busy', busy);
  document.getElementById('compile-clean').disabled = busy;
}

function openCompileMenu(show) {
  document.getElementById('compile-menu').classList.toggle('hidden', !show);
  document.getElementById('compile-menu-btn').setAttribute('aria-expanded', String(show));
  if (show) document.getElementById('compile-clean').focus();
}

function initCompileMenu() {
  const menu = document.getElementById('compile-menu');
  document.getElementById('compile-menu-btn').addEventListener('click', () => openCompileMenu(menu.classList.contains('hidden')));
  document.getElementById('compile-clean').addEventListener('click', () => {
    openCompileMenu(false);
    compileFile({ clean: true });
  });
  document.addEventListener('pointerdown', (event) => {
    if (!menu.classList.contains('hidden') && !event.target.closest('#compile-split')) openCompileMenu(false);
  });
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { openCompileMenu(false); document.getElementById('compile-menu-btn').focus(); }
  });
}

async function compileFile({ silent = false, clean = false } = {}) {
  if (clean && compileInFlight) return false;
  setCompileBusy(true);
  if (!await saveFile()) {
    setCompileBusy(false);
    return false;
  }
  showStatus(clean ? t('compileMenu.cleaning') : 'Compiling...', '');
  try {
    const res = await fetch('/api/compile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: compileTarget(), clean }),
    });
    const data = await res.json();
    if (data.ok) {
      hideCompileError({ clear: true });
      const changedCount = recordSuccessfulCompile(editor.getValue());
      showCompiledPdf(data.pdf);
      if (clean) showStatus(t('compileMenu.cleanDone', { steps: (data.steps || [data.engine]).join(' → ') }), 'success');
      else if (!silent) showStatus('Compiled (' + data.engine + ')' + (changedCount ? ` · ${changedCount} changed sentence${changedCount === 1 ? '' : 's'} highlighted` : ''), 'success');
      return true;
    } else {
      showStatus('Compile error', 'error');
      showCompileError({ error: data.error, log: data.log, engine: data.engine, file: compileTarget() }, { reveal: !silent });
      return false;
    }
  } catch {
    showStatus('Compile request failed', 'error');
    showCompileError({ error: t('compileError.requestFailed'), log: '', engine: null, file: compileTarget() }, { reveal: !silent });
    return false;
  } finally {
    setCompileBusy(false);
  }
}

async function invokeAgent() {
  if (!await saveFile()) return showStatus('Save the paper before preparing the Agent manifest.', 'error');
  await syncStructure({ silent: true });
  await refreshPromptContextPreview();
  if (!currentPromptPreview) return showStatus('Prompt context is not ready', 'error');
  const batchSummary = modificationIntents.length ? ` · ${modificationIntents.length} atomic modification task${modificationIntents.length === 1 ? '' : 's'}` : '';
  document.getElementById('invoke-confirm-summary').textContent = `${currentProvider} · ${currentPromptPreview.scope}${batchSummary} · ${currentPromptPreview.characterCount.toLocaleString()} actual CLI characters · ~${(currentPromptPreview.tokenEstimate || 0).toLocaleString()} tokens · ${(currentPromptPreview.payloadRoutes?.length || 1)} confirmed route payload${(currentPromptPreview.payloadRoutes?.length || 1) === 1 ? '' : 's'} · manifest ${currentPromptPreview.manifestPath || 'legacy'}`;
  document.getElementById('invoke-confirm-overlay').classList.remove('hidden');
}

async function askAgent(composedPrompt = null, isComposed = Boolean(composedPrompt)) {
  const prompt = composedPrompt || document.getElementById('ai-prompt').value.trim();
  const intentIds = modificationIntents.map((item) => item.id);
  const selectedId = intentIds.length ? null : selectedNode?.type !== 'document' ? selectedNode?.id : null;
  openAgentActivity({ provider: currentProvider, scope: intentIds.length ? `${intentIds.length} modification intents` : selectedNode?.type || 'document', prompt });
  if (!await saveFile()) return finishAgentActivity('Could not save the paper before starting the Agent.', { error: true });
  const content = editor.getValue();
  const button = document.getElementById('ai-invoke');
  button.disabled = true;
  agentActivityController = new AbortController();
  setAgentActivityStage('run', `${currentProvider} is analyzing the selected paper scope. The paper remains available while this task runs.`);
  showStatus('Agent is analyzing...', '');
  try {
    const res = await fetch(selectedId ? '/api/agent/suggest-node' : '/api/agent/suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: agentActivityController.signal,
      body: JSON.stringify(selectedId
        ? { nodeId: selectedId, prompt, promptIsComposed: isComposed, resourceIds: [...selectedResourceIds], citekeys: [...selectedReferenceCitekeys], intentIds, additionalRequirements: document.getElementById('ai-prompt').value.trim(), manifestPath: currentPromptPreview?.manifestPath, payloadHash: currentPromptPreview?.payload?.hash, payloadRouteHashes: currentPromptPreview?.payloadRoutes?.map((route) => ({ provider: route.provider, model: route.model || '', hash: route.hash })), activityId: agentActivityId }
        : { documentId: currentDocument?.id, content, prompt, promptIsComposed: isComposed, resourceIds: [...selectedResourceIds], citekeys: [...selectedReferenceCitekeys], intentIds, additionalRequirements: document.getElementById('ai-prompt').value.trim(), manifestPath: currentPromptPreview?.manifestPath, payloadHash: currentPromptPreview?.payload?.hash, payloadRouteHashes: currentPromptPreview?.payloadRoutes?.map((route) => ({ provider: route.provider, model: route.model || '', hash: route.hash })), activityId: agentActivityId }),
    });
    const data = await res.json();
    if (!res.ok) {
      const requestError = new Error(data.error || 'Agent request failed');
      requestError.code = data.code || '';
      throw requestError;
    }
    reflectAgentRunConnection({ provider: data.effectiveProvider || data.agentMeta?.provider || currentProvider, ok: true });
    suggestions = data.suggestions || [];
    const unresolvedTasks = Array.isArray(data.unresolvedTasks) ? data.unresolvedTasks : [];
    if (unresolvedTasks.length) {
      agentActivitySystemLog.push(`Unresolved manifest tasks:\n${unresolvedTasks.map((item) => `${item.taskId}: ${item.reason}`).join('\n')}`);
      renderAgentActivityLog();
    }
    if (data.agentMeta) {
      const routes = (data.agentMeta.routes || []).map((route) => `${route.provider}${route.model ? `/${route.model}` : ''}: ${route.status}${route.code ? ` (${route.code})` : ''}`).join(' → ');
      const attempts = (data.agentMeta.attempts || []).map((attempt) => `#${attempt.attempt} ${attempt.status}${attempt.code ? ` (${attempt.code})` : ''}`).join(', ');
      agentActivitySystemLog.push(`Effective Agent: ${data.effectiveProvider || data.agentMeta.provider}${data.agentMeta.reasoningEffort ? ` · effort ${data.agentMeta.reasoningEffort}` : ''}${routes ? `\nRoutes: ${routes}` : ''}${attempts ? `\nAttempts: ${attempts}` : ''}`);
      renderAgentActivityLog();
    }
    lastLibraryUsage = data.library || null;
    renderLibraryUsage();
    document.getElementById('ai-prompt').value = '';
    schedulePromptContextPreview();
    if (suggestions.length === 0) {
      renderSuggestions();
      showStatus('No changes proposed', '');
      finishAgentActivity(data.summary || 'The Agent completed without proposing source changes.');
      return;
    }
    setAgentActivityStage('apply', `Applying ${suggestions.length} proposed change${suggestions.length === 1 ? '' : 's'} as one atomic revision…`);
    document.getElementById('agent-activity-cancel').classList.add('hidden');
    agentActivityController = null;
    const applyResponse = await fetch('/api/agent/apply-all', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: currentFile, suggestionIds: suggestions.map((item) => item.id) }),
    });
    const applied = await applyResponse.json();
    if (!applyResponse.ok) throw new Error(applied.error || 'AI revision could not be applied');
    const appliedIntentIds = [...new Set((applied.revision?.changes || []).map((change) => change.taskId).filter((taskId) => intentIds.includes(taskId)))];
    editor.setValue(applied.content);
    suggestions = [];
    renderSuggestions();
    await syncStructure({ silent: true });
    setAgentActivityStage('compile', 'Revision applied. Compiling the updated PDF…');
    const compiled = await compileFile({ silent: true });
    const appliedCount = applied.revision?.changes?.filter((item) => item.status === 'applied').length || 0;
    let intentResolutionNote = '';
    if (appliedIntentIds.length) {
      try { await resolveModificationIntents(appliedIntentIds); }
      catch (error) { intentResolutionNote = ` ${error.message}`; }
    }
    if (unresolvedTasks.length) intentResolutionNote += ` ${unresolvedTasks.length} task${unresolvedTasks.length === 1 ? '' : 's'} remain open.`;
    finishAgentActivity(`${appliedCount} change${appliedCount === 1 ? '' : 's'} applied${compiled ? ' and the PDF was rebuilt' : '; PDF compilation needs attention'}.${intentResolutionNote}`, { revisionId: applied.revision?.id || null, intentIds: appliedIntentIds, unresolvedTaskIds: unresolvedTasks.map((item) => item.taskId) });
    await loadRecentChangeHistory({ silent: true });
    showStatus(t('history.saved', { count: appliedCount }), 'success');
  } catch (error) {
    if (error.code === 'AGENT_AUTH_REQUIRED') reflectAgentRunConnection({ provider: currentProvider, ok: false, code: error.code, error: error.message });
    const message = error.name === 'AbortError' ? 'AI task cancelled.' : error.message || 'Agent request failed';
    finishAgentActivity(message, { error: true });
    showStatus(message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function generateParagraph() {
  const prompt = document.getElementById('ai-prompt').value.trim();
  if (!await saveFile()) return;
  const insertionIndex = selectedNode?.sourceRange?.end ?? editor.indexFromPos(editor.getCursor());
  const button = document.getElementById('ai-invoke');
  button.disabled = true;
  showStatus('Generating paragraph draft...', '');
  try {
    const res = await fetch('/api/agent/generate-paragraph', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt, nodeId: selectedNode?.type !== 'document' ? selectedNode?.id : null,
        documentId: currentDocument?.id, resourceIds: [...selectedResourceIds], sectionType: selectedSectionTitle(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Paragraph generation failed');
    pendingParagraphDraft = { text: data.draft, index: insertionIndex, prompt, runId: data.runId };
    lastLibraryUsage = data.library || null;
    renderParagraphDraft();
    renderLibraryUsage();
    document.getElementById('ai-prompt').value = '';
    schedulePromptContextPreview();
    showStatus('Paragraph draft ready for review', 'success');
  } catch (error) {
    showStatus(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function renderSuggestions() {
  const container = document.getElementById('ai-suggestions');
  container.replaceChildren();
}

async function acceptSuggestion(id) {
  const sug = suggestions.find(s => s.id === id);
  if (!sug) return;

  try {
    const res = await fetch('/api/agent/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: currentFile, suggestionId: id }),
    });
    const data = await res.json();
    if (data.ok) {
      editor.setValue(data.content);
      await syncStructure({ silent: true });
      showStatus('Suggestion applied', 'success');
    } else {
      showStatus(data.error || 'Apply failed', 'error');
    }
  } catch (error) {
    showStatus(error.message || 'Server rejected the change; source was not modified', 'error');
    return;
  }

  suggestions = suggestions.filter(s => s.id !== id);
  renderSuggestions();
}

async function rejectSuggestion(id) {
  try {
    const res = await fetch('/api/agent/reject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: currentFile, suggestionId: id }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Reject decision failed to persist');
  } catch (error) {
    showStatus(error.message, 'error');
    return;
  }
  suggestions = suggestions.filter(s => s.id !== id);
  renderSuggestions();
  showStatus('Suggestion rejected', '');
}

// ================= Literature review generation =================
let pendingLiteratureReview = null;

async function generateLiteratureReviewFlow() {
  const citekeys = [...selectedReferenceCitekeys];
  if (!citekeys.length) return setReferencesNote('Select at least one reference first', 'error');
  const button = document.getElementById('references-review');
  button.disabled = true;
  setReferencesNote('Generating review paragraph…');
  try {
    const res = await fetch('/api/references/review', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ citekeys, prompt: document.getElementById('references-review-prompt').value.trim() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Review generation failed');
    pendingLiteratureReview = data;
    renderLiteratureReviewDraft();
    setReferencesNote('Review paragraph ready for review', 'success');
  } catch (error) {
    setReferencesNote(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function renderLiteratureReviewDraft() {
  const container = document.getElementById('references-review-result');
  container.replaceChildren();
  if (!pendingLiteratureReview) return;
  container.classList.remove('hidden');
  const heading = document.createElement('h4');
  heading.textContent = 'Review paragraph draft';
  container.appendChild(heading);
  const quote = document.createElement('blockquote');
  quote.textContent = pendingLiteratureReview.draft;
  container.appendChild(quote);
  if (pendingLiteratureReview.note) {
    const note = document.createElement('p');
    note.className = 'helper';
    note.textContent = pendingLiteratureReview.note;
    container.appendChild(note);
  }
  const actions = document.createElement('div');
  actions.className = 'review-draft-actions';
  const insert = document.createElement('button');
  insert.className = 'primary';
  insert.textContent = 'Insert at cursor';
  insert.addEventListener('click', insertLiteratureReviewDraft);
  const discard = document.createElement('button');
  discard.textContent = 'Discard';
  discard.addEventListener('click', () => {
    pendingLiteratureReview = null;
    container.classList.add('hidden');
  });
  actions.appendChild(insert);
  actions.appendChild(discard);
  container.appendChild(actions);
}

async function insertLiteratureReviewDraft() {
  if (!pendingLiteratureReview) return;
  if (!currentDocument) return setReferencesNote('Open a paper first', 'error');
  if (!await saveFile()) return;
  const index = selectedNode?.sourceRange?.end ?? editor.indexFromPos(editor.getCursor());
  try {
    const res = await fetch('/api/agent/insert-paragraph', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        documentId: currentDocument.id, index, text: pendingLiteratureReview.draft,
        prompt: 'Insert the user-approved literature review paragraph.', runId: pendingLiteratureReview.runId,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Insert failed');
    editor.setValue(data.content);
    await syncStructure({ silent: true });
    setReferencesNote('Review paragraph inserted into the paper', 'success');
    pendingLiteratureReview = null;
    document.getElementById('references-review-result').classList.add('hidden');
    await loadRecentChangeHistory({ silent: true });
  } catch (error) {
    setReferencesNote(error.message, 'error');
  }
}

// ================= Paragraph analysis =================
let analysisData = null;

function setAnalysisNote(message = '', type = '') {
  const note = document.getElementById('analysis-note');
  note.textContent = message;
  note.className = type || '';
}

async function loadAnalysis(nodeId = null) {
  const body = { documentId: currentDocument?.id };
  if (nodeId) body.nodeId = nodeId;
  const res = await fetch('/api/analysis/structure', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Analysis failed');
  analysisData = data.analysis;
  renderAnalysis();
}

function renderAnalysisChart() {
  const container = document.getElementById('analysis-chart');
  const caption = document.getElementById('analysis-chart-caption');
  container.replaceChildren();
  if (!analysisData) return;
  const values = analysisData.sentences || [];
  const words = analysisData.unit?.wordCount || 0;
  caption.textContent = `${analysisData.unit.sentenceCount} sentence(s) · ${words} words`;
  if (!values.length) {
    container.textContent = 'No sentences to analyze';
    return;
  }
  const ns = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const barWidth = 22;
  const gap = 4;
  const width = Math.max(340, values.length * (barWidth + gap) + 20);
  const height = 170;
  const max = Math.max(1, ...values.map((sentence) => sentence.wordCount));
  ns.setAttribute('width', width);
  ns.setAttribute('height', height);
  ns.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const plotTop = 14;
  const plotHeight = height - plotTop - 28;
  const scale = (value) => plotTop + plotHeight - (value / max) * plotHeight;
  values.forEach((sentence, index) => {
    const x = 10 + index * (barWidth + gap);
    const y = scale(sentence.wordCount);
    const bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bar.setAttribute('x', x);
    bar.setAttribute('y', y);
    bar.setAttribute('width', barWidth);
    bar.setAttribute('height', Math.max(1, plotTop + plotHeight - y));
    bar.setAttribute('rx', 2);
    bar.setAttribute('fill', index % 2 === 0 ? 'var(--accent)' : 'var(--success)');
    bar.setAttribute('opacity', '0.85');
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = `Sentence ${index + 1}: ${sentence.wordCount} word(s) — ${sentence.text}`;
    bar.appendChild(title);
    ns.appendChild(bar);
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', x + barWidth / 2);
    label.setAttribute('y', height - 6);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('fill', '#7f849c');
    label.setAttribute('font-size', '8');
    label.textContent = String(index + 1);
    ns.appendChild(label);
    const value = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    value.setAttribute('x', x + barWidth / 2);
    value.setAttribute('y', y - 4);
    value.setAttribute('text-anchor', 'middle');
    value.setAttribute('fill', '#cdd6f4');
    value.setAttribute('font-size', '8');
    value.textContent = String(sentence.wordCount);
    ns.appendChild(value);
  });
  const mean = analysisData.stats?.mean || 0;
  const meanY = scale(mean);
  const meanLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  meanLine.setAttribute('x1', 10);
  meanLine.setAttribute('y1', meanY);
  meanLine.setAttribute('x2', 10 + values.length * (barWidth + gap));
  meanLine.setAttribute('y2', meanY);
  meanLine.setAttribute('stroke', '#fab387');
  meanLine.setAttribute('stroke-width', '1.5');
  meanLine.setAttribute('stroke-dasharray', '5 4');
  const meanLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  meanLabel.setAttribute('x', 10 + values.length * (barWidth + gap) - 4);
  meanLabel.setAttribute('y', meanY - 4);
  meanLabel.setAttribute('text-anchor', 'end');
  meanLabel.setAttribute('fill', '#fab387');
  meanLabel.setAttribute('font-size', '8');
  meanLabel.textContent = `mean ${mean}`;
  ns.appendChild(meanLine);
  ns.appendChild(meanLabel);
  container.appendChild(ns);
}

function renderAnalysisStats() {
  const container = document.getElementById('analysis-stats');
  container.replaceChildren();
  if (!analysisData) return;
  const sets = [];
  if (analysisData.stats) sets.push({ label: 'Sentences', stats: analysisData.stats });
  if (analysisData.paragraphStats) sets.push({ label: 'Paragraphs (words)', stats: analysisData.paragraphStats });
  if (analysisData.paragraphSentenceStats) sets.push({ label: 'Paragraphs (sentences)', stats: analysisData.paragraphSentenceStats });
  if (!sets.length) return;
  const statDefs = [
    { key: 'count', label: 'Count', hint: 'n' },
    { key: 'mean', label: 'Mean (μ)', hint: 'Average length in words' },
    { key: 'stddev', label: 'Std dev (s)', hint: 'Spread around the mean' },
    { key: 'cv', label: 'CV', hint: 's / μ — relative variation' },
    { key: 'median', label: 'Median', hint: 'Middle value' },
    { key: 'range', label: 'Range', hint: 'max − min' },
    { key: 'iqr', label: 'IQR', hint: 'Middle 50% spread' },
    { key: 'delta', label: 'Δ (adjacent)', hint: 'Avg jump between neighbours' },
    { key: 'relativeDelta', label: 'Δ / μ', hint: 'Normalised adjacent change' },
  ];
  for (const set of sets) {
    const heading = document.createElement('div');
    heading.className = 'analysis-section-head';
    heading.style.marginTop = '4px';
    const title = document.createElement('h3');
    title.textContent = set.label;
    heading.appendChild(title);
    container.appendChild(heading);
    const grid = document.createElement('div');
    grid.className = 'analysis-stat-grid';
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:7px;margin-bottom:10px;';
    for (const def of statDefs) {
      const value = set.stats[def.key];
      if (value === undefined) continue;
      const card = document.createElement('div');
      card.className = 'analysis-stat';
      card.innerHTML = `<div class="stat-value">${value}</div><div class="stat-label">${def.label}</div><div class="stat-hint">${def.hint}</div>`;
      grid.appendChild(card);
    }
    container.appendChild(grid);
  }
}

function renderAnalysisVerdict() {
  const container = document.getElementById('analysis-verdict');
  if (!analysisData || !analysisData.verdict) {
    container.classList.add('hidden');
    container.replaceChildren();
    return;
  }
  container.classList.remove('hidden');
  container.className = `analysis-verdict ${analysisData.verdict.label}`;
  container.innerHTML = `<strong>${analysisData.verdict.title} · VI ${analysisData.variation.score}/100</strong><p>${analysisData.verdict.note}</p>`;
}

function renderAnalysisFormulas() {
  const container = document.getElementById('analysis-formula-list');
  container.replaceChildren();
  if (!analysisData?.formulas) return;
  for (const formula of analysisData.formulas) {
    const card = document.createElement('div');
    card.className = 'analysis-formula';
    card.innerHTML = `<span class="formula-name">${formula.name}</span><code>${formula.formula}</code><div class="formula-desc">${formula.description}</div>`;
    container.appendChild(card);
  }
}

function renderAnalysisSidebar() {
  const container = document.getElementById('analysis-target-list');
  container.replaceChildren();
  if (!analysisData) {
    container.innerHTML = '<div class="outline-empty">Loading…</div>';
    return;
  }
  const button = (label, detail, onClick, active = false) => {
    const element = document.createElement('button');
    element.className = 'analysis-target' + (active ? ' active' : '');
    element.innerHTML = `${label}<small>${detail}</small>`;
    element.addEventListener('click', () => { setAnalysisNote(''); onClick(); });
    container.appendChild(element);
  };
  if (analysisData.kind !== 'selection') {
    button(
      t('analysis.documentLevel'),
      `${analysisData.unit.paragraphCount || ''} ${analysisData.unit.sentenceCount} sentence(s)`,
      () => loadAnalysis(null).catch((error) => setAnalysisNote(error.message, 'error')),
      analysisData.kind === 'document',
    );
  }
  if (analysisData.kind === 'document' || analysisData.kind === 'section') {
    for (const paragraph of analysisData.paragraphs || []) {
      button(
        shorten(paragraph.label || paragraph.text || 'Paragraph', 42),
        `${paragraph.sentenceCount} sentence(s) · μ ${paragraph.stats.mean} · CV ${paragraph.stats.cv}`,
        () => loadAnalysis(paragraph.id).catch((error) => setAnalysisNote(error.message, 'error')),
        analysisData.kind === 'paragraph' && analysisData.unit.id === paragraph.id,
      );
    }
  }
}

function renderAnalysis() {
  const name = document.getElementById('analysis-target-name');
  name.textContent = analysisData?.unit?.label || t('analysis.loading');
  renderAnalysisSidebar();
  renderAnalysisChart();
  renderAnalysisStats();
  renderAnalysisVerdict();
  renderAnalysisFormulas();
}

async function openParagraphAnalysis(nodeId = null) {
  if (!currentDocument) return showStatus('Open a paper first', 'error');
  if (!await saveFile()) return;
  document.getElementById('analysis-overlay').classList.remove('hidden');
  setAnalysisNote('');
  try {
    await loadAnalysis(nodeId);
  } catch (error) {
    setAnalysisNote(error.message, 'error');
  }
}

function closeParagraphAnalysis() {
  document.getElementById('analysis-overlay').classList.add('hidden');
}

// ================= Agent orchestration =================
let orchestrations = [];
let activeOrchestration = null;
let orchSelected = null;
let orchConnecting = false;
let orchConnectSource = null;
let orchPollTimer = null;
const ORCH_NODE_STATUS_LABEL = {
  idle: 'orch.nodeIdle', queued: 'orch.nodeQueued', running: 'orch.nodeRunning',
  complete: 'orch.nodeComplete', failed: 'orch.nodeFailed', waiting: 'orch.waiting', skipped: 'orch.nodeSkipped',
};

function orchNote(message = '', type = '') {
  const note = document.getElementById('orchestration-note');
  note.textContent = message;
  note.className = type || '';
}

async function orchRequest(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function loadOrchestrations({ select = true } = {}) {
  const data = await orchRequest('/api/orchestrations');
  orchestrations = data.orchestrations || [];
  const selector = document.getElementById('orchestration-select');
  selector.replaceChildren();
  if (!orchestrations.length) {
    activeOrchestration = null;
    selector.appendChild(new Option(t('orch.emptyWorkflows'), ''));
    renderOrchestrationCanvas();
    renderOrchestrationInspector();
    updateOrchestrationStatusbar();
    return;
  }
  for (const orch of orchestrations) {
    const option = document.createElement('option');
    option.value = orch.id;
    option.textContent = `${orch.name} (${orch.status})`;
    selector.appendChild(option);
  }
  if (select) {
    const currentId = activeOrchestration && orchestrations.some((item) => item.id === activeOrchestration.id)
      ? activeOrchestration.id : orchestrations[orchestrations.length - 1].id;
    selector.value = currentId;
    await selectOrchestration(currentId);
  }
}

async function selectOrchestration(id) {
  const data = await orchRequest(`/api/orchestrations/${encodeURIComponent(id)}`);
  activeOrchestration = data.orchestration;
  orchSelected = null;
  orchConnecting = false;
  orchConnectSource = null;
  document.getElementById('orch-connect-toggle').classList.remove('active');
  document.getElementById('orchestration-select').value = activeOrchestration.id;
  renderOrchestrationCanvas();
  renderOrchestrationInspector();
  updateOrchestrationStatusbar();
  if (activeOrchestration.status === 'running') startOrchestrationPolling();
  else stopOrchestrationPolling();
}

async function createOrchestrationFlow() {
  try {
    const data = await orchRequest('/api/orchestrations', { method: 'POST', body: { name: `Workflow ${orchestrations.length + 1}` } });
    await loadOrchestrations();
    await selectOrchestration(data.orchestration.id);
    orchNote(t('orch.created'), 'success');
  } catch (error) { orchNote(error.message, 'error'); }
}

async function deleteOrchestrationFlow() {
  if (!activeOrchestration) return;
  if (!confirm(t('orch.deleteConfirm'))) return;
  try {
    stopOrchestrationPolling();
    await orchRequest(`/api/orchestrations/${encodeURIComponent(activeOrchestration.id)}`, { method: 'DELETE' });
    activeOrchestration = null;
    await loadOrchestrations();
    orchNote(t('orch.deleted'), 'success');
  } catch (error) { orchNote(error.message, 'error'); }
}

function orchNodeAnchor(nodeId, side) {
  const element = document.querySelector(`[data-orch-node-id="${CSS.escape(nodeId)}"]`);
  const canvas = document.getElementById('orchestration-canvas');
  if (!element || !canvas) return { x: 0, y: 0 };
  const rect = element.getBoundingClientRect();
  const base = canvas.getBoundingClientRect();
  const x = rect.left - base.left;
  const y = rect.top - base.top;
  return side === 'source' ? { x: x + rect.width, y: y + rect.height / 2 } : { x, y: y + rect.height / 2 };
}

function orchEdgeCoords(edge) {
  const canvas = document.getElementById('orchestration-canvas');
  let sx, sy, tx, ty;
  if (edge.source === 'start') {
    const target = orchNodeAnchor(edge.target, 'target');
    sx = 0; sy = target.y; tx = target.x; ty = target.y;
  } else if (edge.target === 'end') {
    const source = orchNodeAnchor(edge.source, 'source');
    sx = source.x; sy = source.y; tx = canvas ? canvas.clientWidth : 1200; ty = source.y;
  } else {
    const source = orchNodeAnchor(edge.source, 'source');
    const target = orchNodeAnchor(edge.target, 'target');
    sx = source.x; sy = source.y; tx = target.x; ty = target.y;
  }
  return [sx, sy, tx, ty];
}

function orchEdgePath(edge) {
  const [sx, sy, tx, ty] = orchEdgeCoords(edge);
  const bend = Math.max(24, Math.abs(tx - sx) * 0.4);
  const direction = tx >= sx ? 1 : -1;
  return `M ${sx} ${sy} C ${sx + bend * direction} ${sy}, ${tx - bend * direction} ${ty}, ${tx} ${ty}`;
}

function renderOrchestrationEdges() {
  const svg = document.getElementById('orchestration-edges');
  svg.replaceChildren();
  if (!activeOrchestration) return;
  for (const edge of activeOrchestration.edges) {
    const d = orchEdgePath(edge);
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hit.setAttribute('d', d);
    hit.setAttribute('fill', 'none');
    hit.setAttribute('stroke', 'transparent');
    hit.setAttribute('stroke-width', '16');
    hit.style.pointerEvents = 'stroke';
    hit.style.cursor = 'pointer';
    hit.addEventListener('click', (event) => {
      event.stopPropagation();
      orchSelected = `edge:${edge.id}`;
      renderOrchestrationEdges();
      renderOrchestrationInspector();
    });
    svg.appendChild(hit);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', orchSelected === `edge:${edge.id}` ? 'var(--accent)' : '#3c3c54');
    path.setAttribute('stroke-width', '2');
    if (!edge.summary) path.setAttribute('stroke-dasharray', '6 5');
    svg.appendChild(path);
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    const [sx, sy, tx, ty] = orchEdgeCoords(edge);
    label.setAttribute('x', (sx + tx) / 2);
    label.setAttribute('y', (sy + ty) / 2 - 5);
    label.setAttribute('fill', '#7f849c');
    label.setAttribute('font-size', '8');
    label.setAttribute('text-anchor', 'middle');
    label.textContent = (edge.summary || '·').slice(0, 46);
    svg.appendChild(label);
  }
}

function buildOrchNodeElement(node) {
  const element = document.createElement('div');
  element.className = `orch-node ${node.kind === 'gate' ? 'orch-gate' : ''} ${node.status === 'idle' ? 'orch-idle' : `orch-${node.status}`} ${orchSelected === `node:${node.id}` ? 'selected' : ''}`;
  element.dataset.orchNodeId = node.id;
  element.style.left = `${node.x}px`;
  element.style.top = `${node.y}px`;
  const head = document.createElement('div');
  head.className = 'orch-node-head';
  head.innerHTML = '<span class="orch-node-dot"></span><span class="orch-node-title"></span><span class="orch-node-kind"></span>';
  head.querySelector('.orch-node-title').textContent = node.label || node.id;
  head.querySelector('.orch-node-kind').textContent = node.kind === 'gate' ? t('orch.gateKind') : (node.capability || 'agent');
  element.appendChild(head);
  const body = document.createElement('div');
  body.className = 'orch-node-body';
  const meta = document.createElement('div');
  meta.className = 'orch-node-meta';
  meta.textContent = node.kind === 'agent'
    ? `${node.provider} · ${node.source?.type === 'upstream' ? t('orch.upstreamInput') : t('orch.manualInput')}`
    : `${t('orch.decision')}: ${t(node.decision === 'approved' ? 'orch.decisionApproved' : node.decision === 'rejected' ? 'orch.decisionRejected' : 'orch.decisionPending')}`;
  body.appendChild(meta);
  const status = document.createElement('div');
  status.className = 'orch-node-status';
  status.textContent = t(ORCH_NODE_STATUS_LABEL[node.status] || 'orch.nodeIdle');
  body.appendChild(status);
  if (node.kind === 'gate' && node.status === 'waiting') {
    const actions = document.createElement('div');
    actions.className = 'orch-node-actions';
    const approve = document.createElement('button');
    approve.className = 'approve';
    approve.textContent = t('orch.approve');
    approve.addEventListener('click', (event) => { event.stopPropagation(); decideOrchestrationGate(node.id, 'approved'); });
    const reject = document.createElement('button');
    reject.className = 'reject';
    reject.textContent = t('orch.reject');
    reject.addEventListener('click', (event) => { event.stopPropagation(); decideOrchestrationGate(node.id, 'rejected'); });
    actions.appendChild(approve);
    actions.appendChild(reject);
    body.appendChild(actions);
  }
  element.appendChild(body);
  element.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    if (orchConnecting) {
      if (!orchConnectSource) {
        orchConnectSource = node.id;
        orchNote(t('orch.selectFirst'));
        return;
      }
      addOrchestrationEdge(orchConnectSource, node.id);
      orchConnectSource = null;
      return;
    }
    orchSelected = `node:${node.id}`;
    renderOrchestrationEdges();
    renderOrchestrationInspector();
  });
  element.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (event.target.closest('button')) return;
    if (activeOrchestration?.status === 'running' || orchConnecting) return;
    event.preventDefault();
    element.setPointerCapture(event.pointerId);
    element.classList.add('dragging');
    const startX = event.clientX;
    const startY = event.clientY;
    const originX = node.x;
    const originY = node.y;
    const move = (moveEvent) => {
      node.x = Math.max(0, Math.round(originX + moveEvent.clientX - startX));
      node.y = Math.max(0, Math.round(originY + moveEvent.clientY - startY));
      element.style.left = `${node.x}px`;
      element.style.top = `${node.y}px`;
      renderOrchestrationEdges();
    };
    const end = () => {
      element.classList.remove('dragging');
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', end);
      element.removeEventListener('pointercancel', end);
      saveOrchestration({ silent: true }).catch(() => {});
      renderOrchestrationEdges();
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', end);
    element.addEventListener('pointercancel', end);
  });
  return element;
}

function renderOrchestrationCanvas() {
  const canvas = document.getElementById('orchestration-canvas');
  const nodesLayer = document.getElementById('orchestration-nodes');
  nodesLayer.replaceChildren();
  renderOrchestrationEdges();
  if (!activeOrchestration) {
    const empty = document.createElement('div');
    empty.className = 'orch-canvas-empty';
    empty.textContent = orchestrations.length ? t('orch.selectWorkflow') : t('orch.emptyWorkflows');
    nodesLayer.appendChild(empty);
    return;
  }
  for (const node of activeOrchestration.nodes) nodesLayer.appendChild(buildOrchNodeElement(node));
  renderOrchestrationEdges();
}

function updateOrchestrationStatusbar() {
  const status = document.getElementById('orchestration-status');
  const detail = document.getElementById('orchestration-status-detail');
  const runButton = document.getElementById('orchestration-run');
  const cancelButton = document.getElementById('orchestration-cancel');
  const resetButton = document.getElementById('orchestration-reset');
  const state = activeOrchestration?.status || 'draft';
  const running = state === 'running';
  status.textContent = t(`orch.${state}`);
  status.className = `orch-status ${state}`;
  runButton.disabled = running;
  cancelButton.classList.toggle('hidden', !running);
  resetButton.disabled = running;
  const nodes = activeOrchestration?.nodes || [];
  const complete = nodes.filter((node) => node.status === 'complete').length;
  const failed = nodes.filter((node) => node.status === 'failed').length;
  const waiting = nodes.filter((node) => node.status === 'waiting').length;
  detail.textContent = `${nodes.length} node(s) · ${complete} complete · ${failed} failed · ${waiting} waiting`;
}

function renderOrchInspectorSection(body, label) {
  const section = document.createElement('div');
  section.className = 'orch-inspector-section';
  if (label) {
    const heading = document.createElement('label');
    heading.textContent = label;
    section.appendChild(heading);
  }
  body.appendChild(section);
  return section;
}

function renderOrchNodeInspector(body, nodeId) {
  const node = activeOrchestration.nodes.find((item) => item.id === nodeId);
  if (!node) return;
  const editable = activeOrchestration.status !== 'running';
  const labelSection = renderOrchInspectorSection(body, t('orch.nodeLabel'));
  const labelInput = document.createElement('input');
  labelInput.value = node.label || '';
  labelInput.disabled = !editable;
  labelSection.appendChild(labelInput);
  const kindSection = renderOrchInspectorSection(body, t('orch.nodeKind'));
  const kindSpan = document.createElement('div');
  kindSpan.className = 'orch-inspector-output';
  kindSpan.textContent = node.kind === 'gate' ? t('orch.gateKind') : t('orch.agentKind');
  kindSection.appendChild(kindSpan);
  let providerSelect = null;
  let capabilitySelect = null;
  let roleSelect = null;
  let nameInput = null;
  if (node.kind === 'agent') {
    const providerSection = renderOrchInspectorSection(body, t('orch.provider'));
    providerSelect = document.createElement('select');
    for (const provider of ['mock', 'codex', 'claude-code', 'opencode', 'pi']) {
      const option = document.createElement('option');
      option.value = provider;
      option.textContent = provider;
      providerSelect.appendChild(option);
    }
    providerSelect.value = node.provider || 'mock';
    providerSelect.disabled = !editable;
    providerSection.appendChild(providerSelect);
    const capabilitySection = renderOrchInspectorSection(body, t('orch.capability'));
    capabilitySelect = document.createElement('select');
    for (const capability of ['suggest', 'review', 'paragraph', 'generate']) {
      const option = document.createElement('option');
      option.value = capability;
      option.textContent = t(`orch.capability${capability.charAt(0).toUpperCase()}${capability.slice(1)}`);
      capabilitySelect.appendChild(option);
    }
    capabilitySelect.value = node.capability || 'suggest';
    capabilitySelect.disabled = !editable;
    capabilitySection.appendChild(capabilitySelect);
    if (node.capability === 'review') {
      const roleSection = renderOrchInspectorSection(body, t('orch.reviewerRole'));
      roleSelect = document.createElement('select');
      for (const role of ['methodology', 'statistics', 'writing', 'domain', 'reproducibility']) {
        const option = document.createElement('option');
        option.value = role;
        option.textContent = role;
        roleSelect.appendChild(option);
      }
      roleSelect.value = node.reviewer?.role || 'domain';
      roleSelect.disabled = !editable;
      roleSection.appendChild(roleSelect);
      const nameSection = renderOrchInspectorSection(body, t('orch.reviewerName'));
      nameInput = document.createElement('input');
      nameInput.value = node.reviewer?.name || '';
      nameInput.disabled = !editable;
      nameSection.appendChild(nameInput);
    }
  } else {
    const decisionSection = renderOrchInspectorSection(body, t('orch.decision'));
    const decisionSpan = document.createElement('div');
    decisionSpan.className = `orch-gate-decision ${node.decision || 'pending'}`;
    decisionSpan.textContent = t(node.decision === 'approved' ? 'orch.decisionApproved' : node.decision === 'rejected' ? 'orch.decisionRejected' : 'orch.decisionPending');
    decisionSection.appendChild(decisionSpan);
    if (node.status === 'waiting') {
      const actionSection = renderOrchInspectorSection(body, '');
      const actions = document.createElement('div');
      actions.className = 'orch-inspector-actions';
      const approve = document.createElement('button');
      approve.className = 'primary';
      approve.textContent = t('orch.approve');
      approve.addEventListener('click', () => decideOrchestrationGate(node.id, 'approved'));
      const reject = document.createElement('button');
      reject.textContent = t('orch.reject');
      reject.addEventListener('click', () => decideOrchestrationGate(node.id, 'rejected'));
      actions.appendChild(approve);
      actions.appendChild(reject);
      actionSection.appendChild(actions);
    }
  }
  const promptSection = renderOrchInspectorSection(body, t('orch.prompt'));
  const promptInput = document.createElement('textarea');
  promptInput.value = node.prompt || '';
  promptInput.placeholder = t('orch.promptPlaceholder');
  promptInput.disabled = !editable;
  promptSection.appendChild(promptInput);
  const sourceSection = renderOrchInspectorSection(body, t('orch.inputSource'));
  const sourceSelect = document.createElement('select');
  const manualOption = document.createElement('option');
  manualOption.value = 'manual';
  manualOption.textContent = t('orch.inputManual');
  const upstreamOption = document.createElement('option');
  upstreamOption.value = 'upstream';
  upstreamOption.textContent = t('orch.inputUpstream');
  sourceSelect.appendChild(manualOption);
  sourceSelect.appendChild(upstreamOption);
  sourceSelect.value = node.source?.type || 'manual';
  sourceSelect.disabled = !editable;
  sourceSection.appendChild(sourceSelect);
  let upstreamSelect = null;
  let textInput = null;
  if (node.source?.type === 'upstream') {
    const upstreamSection = renderOrchInspectorSection(body, t('orch.inputUpstreamSelect'));
    upstreamSelect = document.createElement('select');
    for (const candidate of activeOrchestration.nodes) {
      if (candidate.id === node.id) continue;
      const option = document.createElement('option');
      option.value = candidate.id;
      option.textContent = candidate.label || candidate.id;
      upstreamSelect.appendChild(option);
    }
    upstreamSelect.value = node.source.nodeId || '';
    upstreamSelect.disabled = !editable;
    upstreamSection.appendChild(upstreamSelect);
  } else {
    const textSection = renderOrchInspectorSection(body, t('orch.inputText'));
    textInput = document.createElement('textarea');
    textInput.value = node.source?.text || '';
    textInput.disabled = !editable;
    textSection.appendChild(textInput);
  }
  const outputSection = renderOrchInspectorSection(body, t('orch.output'));
  const outputDiv = document.createElement('div');
  outputDiv.className = 'orch-inspector-output';
  if (node.output) {
    outputDiv.textContent = `${node.output.summary || ''}\n${typeof node.output.data === 'string' ? node.output.data.slice(0, 600) : ''}`.trim();
  } else if (node.error) {
    outputDiv.textContent = node.error;
    outputDiv.style.color = 'var(--error)';
  } else {
    outputDiv.textContent = t('orch.outputNone');
  }
  outputSection.appendChild(outputDiv);
  if (editable) {
    const actions = document.createElement('div');
    actions.className = 'orch-inspector-actions';
    const apply = document.createElement('button');
    apply.className = 'primary';
    apply.textContent = t('orch.apply');
    apply.addEventListener('click', async () => {
      node.label = labelInput.value.trim() || node.label;
      if (node.kind === 'agent') {
        node.provider = providerSelect.value;
        node.capability = capabilitySelect.value;
        if (node.capability === 'review') {
          node.reviewer = node.reviewer || {};
          node.reviewer.role = roleSelect ? roleSelect.value : (node.reviewer.role || 'domain');
          node.reviewer.name = nameInput ? nameInput.value.trim() : (node.reviewer.name || '');
        }
      }
      node.prompt = promptInput.value;
      if (sourceSelect.value === 'upstream') {
        node.source = { type: 'upstream', nodeId: upstreamSelect.value || '', text: node.source?.text || '' };
      } else {
        node.source = { type: 'manual', nodeId: '', text: textInput.value };
      }
      try {
        await saveOrchestration();
        renderOrchestrationCanvas();
        renderOrchestrationInspector();
      } catch { /* note already set */ }
    });
    actions.appendChild(apply);
    body.appendChild(actions);
  }
}

function renderOrchEdgeInspector(body, edgeId) {
  const edge = activeOrchestration.edges.find((item) => item.id === edgeId);
  if (!edge) return;
  const nodeLabel = (id) => {
    if (id === 'start') return 'Start';
    if (id === 'end') return 'End';
    return activeOrchestration.nodes.find((node) => node.id === id)?.label || id;
  };
  const show = (label, value) => {
    const section = renderOrchInspectorSection(body, label);
    const output = document.createElement('div');
    output.className = 'orch-inspector-output';
    output.textContent = value;
    section.appendChild(output);
  };
  show(t('orch.nodeKind'), 'Edge');
  show('Source', nodeLabel(edge.source));
  show('Target', nodeLabel(edge.target));
  show(t('orch.edgeSummary'), edge.summary || '—');
}

function renderOrchestrationInspector() {
  const body = document.getElementById('orchestration-inspector-body');
  body.replaceChildren();
  if (!activeOrchestration) {
    const empty = document.createElement('div');
    empty.className = 'orch-inspector-empty';
    empty.textContent = orchestrations.length ? t('orch.selectWorkflow') : t('orch.emptyWorkflows');
    body.appendChild(empty);
    return;
  }
  if (!orchSelected) {
    const summary = document.createElement('div');
    summary.className = 'orch-inspector-empty';
    summary.textContent = `${activeOrchestration.nodes.length} node(s) · ${activeOrchestration.edges.length} edge(s). ${t('orch.noSelection')}`;
    body.appendChild(summary);
    return;
  }
  const [kind, id] = orchSelected.split(':');
  if (kind === 'edge') renderOrchEdgeInspector(body, id);
  else renderOrchNodeInspector(body, id);
}

async function saveOrchestration({ silent = false } = {}) {
  if (!activeOrchestration) return;
  try {
    const data = await orchRequest(`/api/orchestrations/${encodeURIComponent(activeOrchestration.id)}`, {
      method: 'PUT',
      body: { name: activeOrchestration.name, nodes: activeOrchestration.nodes, edges: activeOrchestration.edges },
    });
    activeOrchestration = data.orchestration;
    if (!silent) orchNote(t('orch.saved'), 'success');
    updateOrchestrationStatusbar();
    renderOrchestrationInspector();
    const option = document.querySelector(`#orchestration-select option[value="${CSS.escape(activeOrchestration.id)}"]`);
    if (option) option.textContent = `${activeOrchestration.name} (${activeOrchestration.status})`;
  } catch (error) {
    if (!silent) orchNote(error.message, 'error');
    throw error;
  }
}

async function addOrchestrationEdge(source, target) {
  if (source === target) return orchNote(t('orch.edgeToSelf'), 'error');
  if (activeOrchestration.edges.some((edge) => edge.source === source && edge.target === target)) return orchNote(t('orch.edgeExists'), 'error');
  activeOrchestration.edges.push({ id: `edge_${crypto.randomUUID()}`, source, target, summary: '' });
  orchNote('');
  try {
    await saveOrchestration({ silent: true });
    renderOrchestrationCanvas();
  } catch { /* note already set */ }
}

function addOrchestrationNode(kind) {
  if (!activeOrchestration) return;
  if (activeOrchestration.status === 'running') return orchNote(t('orch.runningBusy'), 'error');
  const count = activeOrchestration.nodes.length;
  const offset = (count % 6) * 34;
  const node = {
    id: `node_${crypto.randomUUID()}`,
    kind,
    label: kind === 'gate' ? t('orch.gateKind') : `Agent ${count + 1}`,
    x: 60 + offset,
    y: 60 + offset,
    prompt: '',
    source: { type: 'manual', nodeId: '', text: '' },
    reviewer: null,
    rubric: [],
    status: 'idle',
    note: '',
    output: null,
    runId: '',
    error: '',
    startedAt: '',
    finishedAt: '',
  };
  if (kind === 'agent') {
    node.provider = 'mock';
    node.capability = 'suggest';
  } else {
    node.decision = 'pending';
  }
  activeOrchestration.nodes.push(node);
  orchSelected = `node:${node.id}`;
  orchNote('');
  saveOrchestration({ silent: true }).catch(() => {});
  renderOrchestrationCanvas();
  renderOrchestrationInspector();
}

async function deleteOrchestrationSelection() {
  if (!orchSelected || !activeOrchestration) return;
  const [kind, id] = orchSelected.split(':');
  if (activeOrchestration.status === 'running') return orchNote(t('orch.runningBusy'), 'error');
  if (kind === 'node') {
    activeOrchestration.nodes = activeOrchestration.nodes.filter((node) => node.id !== id);
    activeOrchestration.edges = activeOrchestration.edges.filter((edge) => edge.source !== id && edge.target !== id);
    for (const node of activeOrchestration.nodes) {
      if (node.source?.type === 'upstream' && node.source.nodeId === id) {
        node.source = { type: 'manual', nodeId: '', text: node.source.text || '' };
      }
    }
  } else {
    activeOrchestration.edges = activeOrchestration.edges.filter((edge) => edge.id !== id);
  }
  orchSelected = null;
  orchNote('');
  try {
    await saveOrchestration({ silent: true });
    renderOrchestrationCanvas();
  } catch { /* note already set */ }
}

function toggleOrchConnect() {
  orchConnecting = !orchConnecting;
  orchConnectSource = null;
  document.getElementById('orch-connect-toggle').classList.toggle('active', orchConnecting);
  orchNote(orchConnecting ? t('orch.connect') : '');
}

async function runOrchestrationFlow() {
  if (!activeOrchestration) return;
  if (!activeOrchestration.nodes.length) return orchNote(t('orch.noNodes'), 'error');
  try {
    await orchRequest(`/api/orchestrations/${encodeURIComponent(activeOrchestration.id)}/run`, { method: 'POST' });
    orchNote(t('orch.runningStarted'), 'success');
    await refreshOrchestrationStatus();
    startOrchestrationPolling();
  } catch (error) { orchNote(error.message, 'error'); }
}

async function cancelOrchestrationFlow() {
  try {
    await orchRequest(`/api/orchestrations/${encodeURIComponent(activeOrchestration.id)}/cancel`, { method: 'POST' });
    await refreshOrchestrationStatus();
  } catch (error) { orchNote(error.message, 'error'); }
}

async function resetOrchestrationFlow() {
  if (!activeOrchestration) return;
  try {
    const data = await orchRequest(`/api/orchestrations/${encodeURIComponent(activeOrchestration.id)}/reset`, { method: 'POST' });
    activeOrchestration = data.orchestration;
    orchSelected = null;
    orchNote('');
    renderOrchestrationCanvas();
    renderOrchestrationInspector();
    updateOrchestrationStatusbar();
  } catch (error) { orchNote(error.message, 'error'); }
}

async function decideOrchestrationGate(nodeId, decision) {
  try {
    await orchRequest(`/api/orchestrations/${encodeURIComponent(activeOrchestration.id)}/gates/${encodeURIComponent(nodeId)}/decide`, {
      method: 'POST', body: { decision },
    });
    orchNote(t('orch.gateDecided'), 'success');
    await refreshOrchestrationStatus();
  } catch (error) { orchNote(error.message, 'error'); }
}

function startOrchestrationPolling() {
  stopOrchestrationPolling();
  orchPollTimer = setInterval(() => refreshOrchestrationStatus().catch(() => {}), 900);
}

function stopOrchestrationPolling() {
  if (orchPollTimer) {
    clearInterval(orchPollTimer);
    orchPollTimer = null;
  }
}

async function refreshOrchestrationStatus() {
  if (!activeOrchestration) return;
  const previous = activeOrchestration.status;
  const data = await orchRequest(`/api/orchestrations/${encodeURIComponent(activeOrchestration.id)}`);
  activeOrchestration = data.orchestration;
  renderOrchestrationCanvas();
  renderOrchestrationInspector();
  updateOrchestrationStatusbar();
  if (['complete', 'failed', 'cancelled'].includes(activeOrchestration.status) && previous === 'running') {
    stopOrchestrationPolling();
    const failedNodes = activeOrchestration.nodes.filter((node) => node.status === 'failed');
    if (activeOrchestration.status === 'failed') {
      orchNote(failedNodes.length ? `${t('orch.nodeFailed')}: ${failedNodes[0].error || failedNodes[0].label}` : t('orch.failed'), 'error');
    } else if (activeOrchestration.status === 'cancelled') {
      orchNote(t('orch.gateRejected'), 'error');
    } else {
      orchNote(t('orch.complete'), 'success');
    }
    await loadOrchestrations({ select: false });
  }
}

async function openOrchestration() {
  document.getElementById('orchestration-overlay').classList.remove('hidden');
  orchNote('');
  try {
    await loadOrchestrations();
  } catch (error) { orchNote(error.message, 'error'); }
}

function closeOrchestration() {
  stopOrchestrationPolling();
  orchConnecting = false;
  document.getElementById('orch-connect-toggle').classList.remove('active');
  document.getElementById('orchestration-overlay').classList.add('hidden');
}

function init() {
  translateDom();
  editor = CodeMirror.fromTextArea(document.getElementById('editor'), {
    mode: 'stex',
    lineNumbers: true,
    lineWrapping: true,
    indentUnit: 2,
    tabSize: 2,
    // Selecting a word highlights its other whole-word occurrences, with scrollbar ticks.
    highlightSelectionMatches: { minChars: 2, wordsOnly: true, annotateScrollbar: true, delay: 80 },
  });

  editor.setOption('extraKeys', {
    'Ctrl-S': (cm) => { saveFile(); return false; },
    'Cmd-S': (cm) => { saveFile(); return false; },
    'Ctrl-F': () => openSearch(),
    'Cmd-F': () => openSearch(),
    'Ctrl-H': () => openSearch({ replace: true }),
    'Cmd-Alt-F': () => openSearch({ replace: true }),
    'F3': () => (searchState.open ? stepSearch(1) : openSearch()),
    'Shift-F3': () => (searchState.open ? stepSearch(-1) : openSearch()),
    'Esc': () => (searchState.open ? closeSearch() : CodeMirror.Pass),
  });
  initSearchPanel();
  editor.on('change', (_instance, change) => {
    if (change.origin !== 'setValue') schedulePromptContextPreview();
  });

  document.getElementById('save-btn').addEventListener('click', saveFile);
  document.getElementById('compile-btn').addEventListener('click', () => compileFile());
  initCompileMenu();
  document.getElementById('source-view-btn').addEventListener('click', () => setWorkspaceView('source', { user: true }));
  document.getElementById('preview-view-btn').addEventListener('click', () => setWorkspaceView('preview', { user: true }));
  document.getElementById('split-view-btn').addEventListener('click', () => setWorkspaceView('split', { user: true }));
  if (readPreference(WORKSPACE_VIEW_KEY) === 'split') setWorkspaceView('split', { user: true });
  initSplitDivider();
  initPdfAutoFit();
  initEditorSettings();
  initThemeToggle();
  initEditorScheme();
  document.getElementById('sync-pdf-to-code').addEventListener('click', syncPdfToCursor);
  document.getElementById('sync-code-to-pdf').addEventListener('click', syncCursorToPdf);
  document.getElementById('assistant-collapse').addEventListener('click', () => setAssistantCollapsed(true));
  document.getElementById('assistant-expand').addEventListener('click', () => setAssistantCollapsed(false));
  if (readPreference(ASSISTANT_COLLAPSED_KEY) === '1') setAssistantCollapsed(true, { persist: false });
  document.getElementById('ai-invoke').addEventListener('click', invokeAgent);
  document.getElementById('language-select').value = getLocale();
  document.getElementById('language-select').addEventListener('change', event => setLocale(event.target.value));
  document.addEventListener('papergod:locale-changed', () => {
    if (document.getElementById('theme-toggle').hasAttribute('aria-pressed')) applyTheme(document.documentElement.dataset.theme);
    renderModificationIntents();
    refreshSentenceReaderLocale();
    if (agentProviders.length) { renderQuickAgentSelector(); renderAgentConfiguration(); }
    if (changeHistoryEntries.length) { renderChangeHistoryList(); renderChangeHistoryDetail(); }
    if (agentActivityStage) setAgentActivityStage(agentActivityStage);
    else renderAgentActivityLog();
    renderVersionInfo();
    if (orchestrations.length) {
      renderOrchestrationCanvas();
      renderOrchestrationInspector();
      updateOrchestrationStatusbar();
    }
  });
  const setNavigatorTab = (tab) => {
    const outline = tab === 'outline';
    document.getElementById('navigator-outline-panel').classList.toggle('hidden', !outline);
    document.getElementById('navigator-tools-panel').classList.toggle('hidden', outline);
    document.getElementById('navigator-outline-tab').classList.toggle('active', outline);
    document.getElementById('navigator-tools-tab').classList.toggle('active', !outline);
    document.getElementById('navigator-outline-tab').setAttribute('aria-selected', String(outline));
    document.getElementById('navigator-tools-tab').setAttribute('aria-selected', String(!outline));
  };
  document.getElementById('navigator-outline-tab').addEventListener('click', () => setNavigatorTab('outline'));
  document.getElementById('navigator-tools-tab').addEventListener('click', () => setNavigatorTab('tools'));
  document.getElementById('version-status').addEventListener('click', openVersionDialog);
  document.getElementById('version-close').addEventListener('click', closeVersionDialog);
  document.getElementById('version-overlay').addEventListener('click', event => { if (event.target.id === 'version-overlay') closeVersionDialog(); });
  document.getElementById('tool-show-source').addEventListener('click', () => setWorkspaceView('source'));
  document.getElementById('tool-workspaces').addEventListener('click', openWorkspaceManager);
  document.getElementById('tool-references').addEventListener('click', openReferences);
  document.getElementById('tool-terminal').addEventListener('click', openWorkspaceTerminal);
  document.getElementById('tool-compile').addEventListener('click', compileFile);
  document.getElementById('tool-change-history').addEventListener('click', openChangeHistory);
  document.getElementById('history-open').addEventListener('click', openChangeHistory);
  document.getElementById('tool-libraries').addEventListener('click', () => document.getElementById('library-open').click());
  document.getElementById('tool-agent-config').addEventListener('click', () => document.getElementById('agent-config-open').click());
  document.getElementById('tool-orchestration').addEventListener('click', openOrchestration);
  document.getElementById('tool-analysis').addEventListener('click', () => openParagraphAnalysis());
  document.getElementById('analysis-close').addEventListener('click', closeParagraphAnalysis);
  document.getElementById('analysis-overlay').addEventListener('click', event => {
    if (event.target.id === 'analysis-overlay') closeParagraphAnalysis();
  });
  document.getElementById('orchestration-close').addEventListener('click', closeOrchestration);
  document.getElementById('orchestration-overlay').addEventListener('click', event => {
    if (event.target.id === 'orchestration-overlay') closeOrchestration();
  });
  document.getElementById('orchestration-new').addEventListener('click', createOrchestrationFlow);
  document.getElementById('orchestration-delete').addEventListener('click', deleteOrchestrationFlow);
  document.getElementById('orchestration-select').addEventListener('change', event => {
    if (event.target.value) selectOrchestration(event.target.value).catch(error => orchNote(error.message, 'error'));
  });
  document.getElementById('orch-add-agent').addEventListener('click', () => addOrchestrationNode('agent'));
  document.getElementById('orch-add-gate').addEventListener('click', () => addOrchestrationNode('gate'));
  document.getElementById('orch-connect-toggle').addEventListener('click', toggleOrchConnect);
  document.getElementById('orch-delete-selected').addEventListener('click', deleteOrchestrationSelection);
  document.getElementById('orch-clear').addEventListener('click', resetOrchestrationFlow);
  document.getElementById('orchestration-run').addEventListener('click', runOrchestrationFlow);
  document.getElementById('orchestration-cancel').addEventListener('click', cancelOrchestrationFlow);
  document.getElementById('orchestration-reset').addEventListener('click', resetOrchestrationFlow);
  const closeWorkspaceManager = () => document.getElementById('workspace-manager-overlay').classList.add('hidden');
  document.getElementById('workspace-manager-close').addEventListener('click', closeWorkspaceManager);
  document.getElementById('workspace-manager-overlay').addEventListener('click', event => {
    if (event.target.id === 'workspace-manager-overlay') closeWorkspaceManager();
  });
  document.getElementById('workspace-list').addEventListener('click', async event => {
    const button = event.target.closest('[data-workspace-id]');
    if (!button || button.disabled) return;
    button.disabled = true;
    try {
      await switchWorkspaceRequest(`/api/workspaces/${encodeURIComponent(button.dataset.workspaceId)}/activate`, { method: 'POST' });
    } catch (error) { button.disabled = false; setWorkspaceManagerNote(error.message, 'error'); }
  });
  document.getElementById('workspace-add-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = document.getElementById('workspace-add');
    button.disabled = true;
    try {
      await switchWorkspaceRequest('/api/workspaces', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: document.getElementById('workspace-path').value.trim() }),
      });
    } catch (error) { button.disabled = false; setWorkspaceManagerNote(error.message, 'error'); }
  });
  document.getElementById('workspace-browse').addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    setWorkspaceManagerNote();
    try {
      const res = await fetch('/api/workspaces/pick-folder', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        if (data.code !== 'PICKER_UNAVAILABLE') throw new Error(data.error || 'Folder selection failed');
        setWorkspaceManagerNote(t('workspace.pickerFallback'));
        const initialPath = document.getElementById('workspace-path').value.trim() || workspaceManagerData?.activePath || '';
        try { await browseWorkspaceFolder(initialPath); } catch { await browseWorkspaceFolder(''); }
        return;
      }
      document.getElementById('workspace-path').value = data.path || '';
      document.getElementById('workspace-path').focus();
    } catch (error) { setWorkspaceManagerNote(error.message || t('workspace.pickerFallback'), 'error'); }
    finally { event.currentTarget.disabled = false; }
  });
  document.getElementById('workspace-browser-list').addEventListener('click', event => {
    const entry = event.target.closest('[data-folder-path]');
    if (entry) browseWorkspaceFolder(entry.dataset.folderPath).catch(error => setWorkspaceManagerNote(error.message, 'error'));
  });
  document.getElementById('workspace-browser-up').addEventListener('click', () => {
    const path = document.getElementById('workspace-browser').dataset.parentPath;
    if (path) browseWorkspaceFolder(path).catch(error => setWorkspaceManagerNote(error.message, 'error'));
  });
  document.getElementById('workspace-browser-select').addEventListener('click', () => {
    const browser = document.getElementById('workspace-browser');
    document.getElementById('workspace-path').value = browser.dataset.currentPath || '';
    browser.classList.add('hidden');
    setWorkspaceManagerNote();
  });
  document.getElementById('terminal-close').addEventListener('click', closeTerminalOverlay);
  document.getElementById('terminal-overlay').addEventListener('click', event => { if (event.target.id === 'terminal-overlay') closeTerminalOverlay(); });
  document.getElementById('terminal-stop').addEventListener('click', async () => {
    if (!terminalSessionId) return closeTerminalOverlay();
    try {
      const res = await fetch(`/api/terminal/${encodeURIComponent(terminalSessionId)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('terminal.failed'));
      document.getElementById('terminal-status').textContent = t('terminal.stopped');
      terminalSessionId = null;
      closeTerminalOverlay();
    } catch (error) { document.getElementById('terminal-status').textContent = error.message; }
  });
  const closeReferences = () => document.getElementById('references-overlay').classList.add('hidden');
  document.getElementById('references-close').addEventListener('click', closeReferences);
  document.getElementById('references-overlay').addEventListener('click', event => { if (event.target.id === 'references-overlay') closeReferences(); });
  document.getElementById('references-search').addEventListener('input', event => loadReferences(event.target.value.trim()).catch(error => setReferencesNote(error.message, 'error')));
  document.getElementById('references-folder-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    button.disabled = true; setReferencesNote('Scanning literature folder…');
    try {
      await referenceRequest('/api/references/folders', { method: 'POST', body: JSON.stringify({ path: document.getElementById('references-folder-path').value.trim() }) });
      await loadReferences();
      setReferencesNote('Folder scanned. Review uncertain PDF matches before citing them.', 'success');
    } catch (error) { setReferencesNote(error.message, 'error'); }
    finally { button.disabled = false; }
  });
  document.getElementById('references-folder-browse').addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    try {
      const data = await referenceRequest('/api/workspaces/pick-folder', { method: 'POST' });
      document.getElementById('references-folder-path').value = data.path || '';
    } catch (error) { setReferencesNote(error.message + ' You can paste an absolute path instead.', 'error'); }
    finally { event.currentTarget.disabled = false; }
  });
  document.getElementById('references-rescan').addEventListener('click', async event => {
    event.currentTarget.disabled = true; setReferencesNote('Rescanning folders…');
    try { const data = await referenceRequest('/api/references/scan', { method: 'POST' }); await loadReferences(); setReferencesNote(`${data.scans.filter(item => item.ok).length} folder(s) scanned.`, 'success'); }
    catch (error) { setReferencesNote(error.message, 'error'); }
    finally { event.currentTarget.disabled = false; }
  });
  document.getElementById('references-folders').addEventListener('click', async event => {
    const button = event.target.closest('[data-remove-reference-folder]');
    if (!button) return;
    try { await referenceRequest('/api/references/folders', { method: 'DELETE', body: JSON.stringify({ path: button.dataset.removeReferenceFolder }) }); await loadReferences(); }
    catch (error) { setReferencesNote(error.message, 'error'); }
  });
  document.getElementById('references-list').addEventListener('click', async event => {
    const insert = event.target.closest('[data-insert-cite]');
    if (insert) return insertCitations([insert.dataset.insertCite]);
    const edit = event.target.closest('[data-edit-reference]');
    if (edit) {
      const id = edit.closest('[data-reference-id]').dataset.referenceId;
      const item = referenceData?.items?.find(reference => reference.id === id);
      if (!item) return;
      const title = prompt('Reference title', item.title || '');
      if (title === null) return;
      const authors = prompt('Authors, separated by semicolons', (item.authors || []).join('; '));
      if (authors === null) return;
      const year = prompt('Publication year', item.year || '');
      if (year === null) return;
      const doi = prompt('DOI (optional)', item.doi || '');
      if (doi === null) return;
      const citekey = prompt('Citation key', item.citekey || '');
      if (citekey === null) return;
      try {
        await referenceRequest(`/api/references/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ title: title.trim(), authors: authors.split(';').map(value => value.trim()).filter(Boolean), year: year.trim(), doi: doi.trim(), citekey: citekey.trim(), status: 'verified' }) });
        await loadReferences(document.getElementById('references-search').value.trim());
        setReferencesNote('Reference metadata updated. Regenerate the bibliography when ready.', 'success');
      } catch (error) { setReferencesNote(error.message, 'error'); }
      return;
    }
    const verify = event.target.closest('[data-resolve-reference]');
    if (!verify) return;
    const id = verify.closest('[data-reference-id]').dataset.referenceId;
    verify.disabled = true; setReferencesNote('Verifying DOI metadata…');
    try { await referenceRequest(`/api/references/${encodeURIComponent(id)}/resolve`, { method: 'POST' }); await loadReferences(document.getElementById('references-search').value.trim()); setReferencesNote('Metadata verified with Crossref.', 'success'); }
    catch (error) { setReferencesNote(error.message, 'error'); verify.disabled = false; }
  });
  document.getElementById('references-list').addEventListener('change', async event => {
    if (event.target.matches('[data-reference-select]')) {
      if (event.target.checked) selectedReferenceCitekeys.add(event.target.dataset.referenceSelect);
      else selectedReferenceCitekeys.delete(event.target.dataset.referenceSelect);
      schedulePromptContextPreview();
      return;
    }
    if (!event.target.matches('[data-include-reference]')) return;
    const id = event.target.closest('[data-reference-id]').dataset.referenceId;
    try { await referenceRequest(`/api/references/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ included: event.target.checked }) }); }
    catch (error) { event.target.checked = !event.target.checked; setReferencesNote(error.message, 'error'); }
  });
  document.getElementById('references-insert-selected').addEventListener('click', () => insertCitations([...selectedReferenceCitekeys]));
  document.getElementById('references-review').addEventListener('click', generateLiteratureReviewFlow);
  document.getElementById('references-write-bib').addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    try { const data = await referenceRequest('/api/references/bibliography', { method: 'POST' }); setReferencesNote(`Wrote ${data.count} entries to ${data.file}.`, 'success'); await loadFileTree(); }
    catch (error) { setReferencesNote(error.message, 'error'); }
    finally { event.currentTarget.disabled = false; }
  });
  document.getElementById('references-check').addEventListener('click', () => checkCurrentCitations().catch(error => setReferencesNote(error.message, 'error')));
  document.getElementById('references-add-setup').addEventListener('click', addBibliographySetup);
  document.getElementById('zotero-connect').addEventListener('click', connectZotero);
  document.getElementById('zotero-search-button').addEventListener('click', () => searchZotero().catch(error => setReferencesNote(error.message, 'error')));
  document.getElementById('zotero-search').addEventListener('keydown', event => { if (event.key === 'Enter') searchZotero().catch(error => setReferencesNote(error.message, 'error')); });
  document.getElementById('zotero-collection').addEventListener('change', async event => {
    try {
      const zotero = { ...(referenceData?.zotero || {}), collectionKey: event.target.value };
      await referenceRequest('/api/references/config', { method: 'PUT', body: JSON.stringify({ zotero }) });
      if (referenceData) referenceData.zotero = zotero;
      await searchZotero();
    } catch (error) { setReferencesNote(error.message, 'error'); }
  });
  document.getElementById('zotero-results').addEventListener('click', event => {
    const button = event.target.closest('[data-import-zotero]');
    if (button) importZoteroReference(Number(button.dataset.importZotero)).catch(error => setReferencesNote(error.message, 'error'));
  });
  document.getElementById('change-history-close').addEventListener('click', () => document.getElementById('change-history-overlay').classList.add('hidden'));
  document.getElementById('change-history-refresh').addEventListener('click', () => loadRecentChangeHistory());
  document.getElementById('change-history-overlay').addEventListener('click', event => {
    if (event.target.id === 'change-history-overlay') event.currentTarget.classList.add('hidden');
  });
  document.getElementById('tool-open-folder').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/workspace/open-folder', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not open paper folder');
      showStatus('Paper folder opened', 'success');
    } catch (error) { showStatus(error.message, 'error'); }
  });
  document.getElementById('agent-activity-toggle').addEventListener('click', openAgentActivityDetails);
  document.getElementById('agent-activity-details').addEventListener('click', openAgentActivityDetails);
  document.getElementById('agent-activity-details-close').addEventListener('click', closeAgentActivityDetails);
  document.getElementById('agent-activity-details-overlay').addEventListener('click', event => {
    if (event.target.id === 'agent-activity-details-overlay') closeAgentActivityDetails();
  });
  document.getElementById('agent-activity-cancel').addEventListener('click', () => agentActivityController?.abort());
  document.getElementById('agent-activity-undo').addEventListener('click', undoLastAiRevision);
  document.querySelectorAll('[data-pdf-scope]').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    const scope = button.dataset.pdfScope;
    choosePdfAnnotationScope(scope);
    closePdfScopeMenu();
    openPdfEditMenu();
  }));
  document.getElementById('pdf-locate-source').addEventListener('click', (event) => {
    event.stopPropagation();
    locatePdfSentenceInSource();
  });
  document.getElementById('pdf-sentence-reader-open').addEventListener('click', (event) => {
    event.stopPropagation();
    closePdfScopeMenu();
    openSentenceReader();
  });
  document.addEventListener('click', (event) => {
    const scopeMenu = document.getElementById('pdf-scope-menu');
    const editMenu = document.getElementById('pdf-edit-menu');
    const scopeOpen = !scopeMenu.classList.contains('hidden');
    const editOpen = !editMenu.classList.contains('hidden');
    if (!scopeOpen && !editOpen) return;
    if (event.target.closest('.pdf-text-layer')) return; // PDF text click opens a new scope menu
    if (scopeOpen && event.target.closest('#pdf-scope-menu')) return;
    if (editOpen && event.target.closest('#pdf-edit-menu')) return;
    dismissPdfSelection();
  });
  document.getElementById('pdf-edit-cancel').addEventListener('click', dismissPdfSelection);
  document.getElementById('pdf-edit-submit').addEventListener('click', submitPdfAnnotation);
  document.getElementById('sentence-reader-close').addEventListener('click', closeSentenceReader);
  document.getElementById('sentence-reader-overlay').addEventListener('click', event => {
    if (event.target.id === 'sentence-reader-overlay') closeSentenceReader();
  });
  document.getElementById('sentence-reader-prev').addEventListener('click', () => {
    if (sentenceReaderIndex > 0) { sentenceReaderIndex -= 1; renderSentenceReader(); }
  });
  document.getElementById('sentence-reader-next').addEventListener('click', () => {
    if (sentenceReaderIndex < sentenceReaderItems.length - 1) { sentenceReaderIndex += 1; renderSentenceReader(); }
  });
  document.getElementById('sentence-reader-submit').addEventListener('click', submitSentenceReaderIntent);
  document.getElementById('invoke-confirm').addEventListener('click', async () => {
    document.getElementById('invoke-confirm-overlay').classList.add('hidden');
    if (currentPromptPreview) await askAgent(currentPromptPreview.mergedPrompt);
  });
  const closeInvocationConfirmation = () => document.getElementById('invoke-confirm-overlay').classList.add('hidden');
  document.getElementById('invoke-cancel').addEventListener('click', closeInvocationConfirmation);
  document.getElementById('invoke-confirm-close').addEventListener('click', closeInvocationConfirmation);
  document.getElementById('invoke-confirm-overlay').addEventListener('click', event => {
    if (event.target.id === 'invoke-confirm-overlay') closeInvocationConfirmation();
  });
  document.getElementById('agent-config-open').addEventListener('click', async () => {
    document.getElementById('agent-config-overlay').classList.remove('hidden');
    await loadAgentConfiguration();
  });
  document.getElementById('agent-provider-quick').addEventListener('change', event => activateAgentProvider(event.target.value));
  const closeAgentConfiguration = () => {
    document.getElementById('agent-config-overlay').classList.add('hidden');
  };
  document.getElementById('agent-config-close').addEventListener('click', closeAgentConfiguration);
  document.getElementById('agent-config-overlay').addEventListener('click', event => {
    if (event.target.id === 'agent-config-overlay') closeAgentConfiguration();
  });
  document.getElementById('agent-provider-list').addEventListener('click', event => {
    const card = event.target.closest('[data-provider]');
    if (!card) return;
    const id = card.dataset.provider;
    selectAgentProvider(id);
    const profile = agentProviders.find((item) => item.id === id);
    if (profile?.available && id !== currentProvider) activateAgentProvider(id);
  });
  document.getElementById('agent-config-provider').addEventListener('change', event => selectAgentProvider(event.target.value));
  document.getElementById('agent-config-form').addEventListener('submit', saveAgentConfiguration);
  document.getElementById('agent-config-login').addEventListener('click', openAgentLoginTerminal);
  document.getElementById('agent-config-probe').addEventListener('click', probeAgentConfiguration);
  const modelInput = document.getElementById('agent-config-model');
  const modelDropdown = document.getElementById('agent-model-dropdown');
  const openAgentModelDropdown = () => {
    const profile = selectedAgentProfile();
    if (profile?.models?.length) {
      renderAgentModelDropdown(profile.models, modelInput.value);
    }
  };
  modelInput.addEventListener('focus', openAgentModelDropdown);
  modelInput.addEventListener('input', openAgentModelDropdown);
  modelInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') modelDropdown.classList.add('hidden');
    if (event.key === 'Enter') modelDropdown.classList.add('hidden');
  });
  document.addEventListener('click', (event) => {
    if (!modelDropdown.classList.contains('hidden') && !event.target.closest('.agent-model-picker')) {
      modelDropdown.classList.add('hidden');
    }
  });
  document.getElementById('prompt-preview-open').addEventListener('click', async () => {
    await refreshPromptContextPreview();
    document.getElementById('prompt-preview-overlay').classList.remove('hidden');
  });
  document.getElementById('prompt-preview-close').addEventListener('click', () => document.getElementById('prompt-preview-overlay').classList.add('hidden'));
  document.getElementById('prompt-preview-overlay').addEventListener('click', event => {
    if (event.target.id === 'prompt-preview-overlay') event.currentTarget.classList.add('hidden');
  });
  document.getElementById('focus-annotation-open').addEventListener('click', openFocusAnnotation);
  document.getElementById('focus-annotation-close').addEventListener('click', closeFocusAnnotation);
  document.getElementById('focus-annotation-overlay').addEventListener('click', event => {
    if (event.target.id === 'focus-annotation-overlay') closeFocusAnnotation();
  });
  document.getElementById('focus-paragraph-prompt').addEventListener('input', () => { focusParagraphDirty = true; });
  document.getElementById('focus-sentence-prompt').addEventListener('input', () => { focusSentenceDirty = true; });
  document.getElementById('focus-sentence-intent').addEventListener('input', () => { focusSentenceDirty = true; });
  document.getElementById('focus-save-paragraph').addEventListener('click', () => saveFocusParagraphPrompt());
  document.getElementById('focus-save-sentence').addEventListener('click', () => saveFocusSentenceAnnotation());
  document.getElementById('focus-prev-paragraph').addEventListener('click', async () => {
    const { entries, entry } = focusSelection();
    const index = entries.findIndex((item) => item.paragraph.id === entry?.paragraph.id);
    if (index > 0) await changeFocusParagraph(entries[index - 1].paragraph.id);
  });
  document.getElementById('focus-next-paragraph').addEventListener('click', async () => {
    const { entries, entry } = focusSelection();
    const index = entries.findIndex((item) => item.paragraph.id === entry?.paragraph.id);
    if (index >= 0 && index < entries.length - 1) await changeFocusParagraph(entries[index + 1].paragraph.id);
  });
  document.getElementById('focus-locate-paragraph').addEventListener('click', async () => {
    const paragraphId = focusParagraphId;
    await closeFocusAnnotation();
    if (paragraphId) selectStructureNode(paragraphId);
  });
  document.getElementById('sync-outline').addEventListener('click', async () => {
    if (await saveFile({ sync: false })) await syncStructure();
  });
  document.getElementById('save-context').addEventListener('click', saveContext);
  document.getElementById('clear-context').addEventListener('click', () => {
    if (currentDocument) selectStructureNode(currentDocument.id, { focus: false });
  });
  document.getElementById('library-open').addEventListener('click', async () => {
    document.getElementById('library-overlay').classList.remove('hidden');
    await loadLibraries();
    updateLibraryForm();
  });
  document.getElementById('library-close').addEventListener('click', () => {
    document.getElementById('library-overlay').classList.add('hidden');
  });
  document.getElementById('library-overlay').addEventListener('click', event => {
    if (event.target.id === 'library-overlay') event.currentTarget.classList.add('hidden');
  });
  document.getElementById('library-kind').addEventListener('change', updateLibraryForm);
  document.getElementById('library-scope').addEventListener('change', renderLibraryList);
  document.getElementById('library-search').addEventListener('input', renderLibraryList);
  document.getElementById('library-form').addEventListener('submit', submitLibraryForm);
  document.getElementById('library-extract').addEventListener('click', extractFromPaper);
  document.getElementById('library-extract-pdf').addEventListener('click', openPdfExtractor);
  document.getElementById('pdf-extract-run').addEventListener('click', runPdfExtractor);
  document.getElementById('pdf-extract-cancel').addEventListener('click', () => {
    document.getElementById('pdf-extract-row').classList.add('hidden');
  });
  document.getElementById('review-open').addEventListener('click', async () => {
    if (!await saveFile()) return;
    openOverlay('review-overlay');
    setReviewWorkspaceTab('planning');
    await Promise.all([loadReviewWorkspace(), loadSelfReviseWorkspace()]);
    renderPaperGenerationPreview();
  });
  document.getElementById('review-close').addEventListener('click', () => {
    document.getElementById('review-overlay').classList.add('hidden');
  });
  document.getElementById('review-overlay').addEventListener('click', event => {
    if (event.target.id === 'review-overlay') event.currentTarget.classList.add('hidden');
  });
  document.getElementById('review-plan-tab').addEventListener('click', async () => {
    setReviewWorkspaceTab('planning');
    await loadReviewWorkspace();
  });
  document.getElementById('review-delivery-tab').addEventListener('click', async () => {
    setReviewWorkspaceTab('delivery');
    await loadSelfReviseWorkspace();
    renderPaperGenerationPreview();
  });
  document.getElementById('selection-comment-form').addEventListener('submit', addSelectionComment);
  document.getElementById('review-import-form').addEventListener('submit', importReview);
  document.getElementById('plan-selected').addEventListener('click', planSelectedAnnotations);
  document.getElementById('peer-review-open').addEventListener('click', async () => {
    if (!await saveFile()) return;
    document.getElementById('peer-review-overlay').classList.remove('hidden');
    await loadPeerReviewCatalog();
    await loadPeerReviews();
  });
  document.getElementById('peer-review-close').addEventListener('click', () => {
    document.getElementById('peer-review-overlay').classList.add('hidden');
  });
  document.getElementById('peer-review-overlay').addEventListener('click', event => {
    if (event.target.id === 'peer-review-overlay') event.currentTarget.classList.add('hidden');
  });
  document.getElementById('add-custom-reviewer').addEventListener('click', addCustomReviewer);
  document.getElementById('add-rubric').addEventListener('click', addRubricCriterion);
  document.getElementById('create-panel').addEventListener('click', createPeerReviewRound);
  document.getElementById('refresh-peer-reviews').addEventListener('click', loadPeerReviews);
  document.getElementById('self-open-panel').addEventListener('click', async () => { openOverlay('peer-review-overlay'); await loadPeerReviewCatalog(); await loadPeerReviews(); });
  document.getElementById('generate-paper').addEventListener('click', generateWholePaper);
  document.getElementById('download-workflow-export').addEventListener('click', downloadWorkflowExport);
  document.getElementById('refresh-self-revise').addEventListener('click', loadSelfReviseWorkspace);
  document.addEventListener('keydown', async event => {
    const readerOpen = !document.getElementById('sentence-reader-overlay').classList.contains('hidden');
    if (readerOpen && !['TEXTAREA', 'INPUT'].includes(event.target.tagName) && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      const direction = event.key === 'ArrowLeft' ? -1 : 1;
      const next = sentenceReaderIndex + direction;
      if (next >= 0 && next < sentenceReaderItems.length) { sentenceReaderIndex = next; renderSentenceReader(); }
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape') {
      document.getElementById('library-overlay').classList.add('hidden');
      document.getElementById('review-overlay').classList.add('hidden');
      document.getElementById('peer-review-overlay').classList.add('hidden');
      document.getElementById('agent-config-overlay').classList.add('hidden');
      document.getElementById('prompt-preview-overlay').classList.add('hidden');
      document.getElementById('invoke-confirm-overlay').classList.add('hidden');
      document.getElementById('change-history-overlay').classList.add('hidden');
      document.getElementById('workspace-manager-overlay').classList.add('hidden');
      document.getElementById('references-overlay').classList.add('hidden');
      closeVersionDialog();
      closeOrchestration();
      closeParagraphAnalysis();
      closeTerminalOverlay();
      document.getElementById('pdf-scope-menu').classList.add('hidden');
      document.getElementById('pdf-edit-menu').classList.add('hidden');
      closeSentenceReader();
      clearPdfScopeHighlight();
      if (!document.getElementById('focus-annotation-overlay').classList.contains('hidden')) await closeFocusAnnotation();
    }
  });
  document.getElementById('ai-prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) invokeAgent();
  });
  document.getElementById('ai-prompt').addEventListener('input', schedulePromptContextPreview);

  initEntryPicker();
  initOutlineDepthPicker();
  initCompileErrorPanel();
  loadEngineStatus().then(openEntryFile);
  loadVersionInfo();
  loadConfig();
  loadAgentConfiguration();
  updateLibrarySelectionStatus();
  loadFileTree();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
