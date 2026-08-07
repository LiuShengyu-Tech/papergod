import * as pdfjsLib from '/vendor/pdfjs-dist/build/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs-dist/build/pdf.worker.mjs';

let editor;
let currentFile = 'main.tex';
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
let agentProviders = [];
let currentPromptPreview = null;
let promptPreviewTimer = null;
let focusParagraphId = null;
let focusSentenceId = null;
let focusParagraphDirty = false;
let focusSentenceDirty = false;

function setWorkspaceView(view) {
  if (view === 'preview' && document.getElementById('preview-view-btn').disabled) return;
  workspaceView = view;
  const showingSource = view === 'source';
  document.getElementById('source-view').classList.toggle('hidden', !showingSource);
  document.getElementById('preview-panel').classList.toggle('hidden', showingSource);
  const sourceButton = document.getElementById('source-view-btn');
  const previewButton = document.getElementById('preview-view-btn');
  sourceButton.classList.toggle('active', showingSource);
  previewButton.classList.toggle('active', !showingSource);
  sourceButton.setAttribute('aria-selected', String(showingSource));
  previewButton.setAttribute('aria-selected', String(!showingSource));
  if (showingSource && editor) requestAnimationFrame(() => editor.refresh());
}

async function showCompiledPdf(url, { switchView = true } = {}) {
  const renderGeneration = ++pdfRenderGeneration;
  const container = document.getElementById('pdf-preview');
  const placeholder = document.getElementById('preview-placeholder');
  if (pdfLoadingTask) await pdfLoadingTask.destroy().catch(() => {});
  container.replaceChildren();
  placeholder.textContent = 'Rendering paper…';
  placeholder.classList.remove('hidden');
  document.getElementById('preview-view-btn').disabled = false;
  if (switchView) setWorkspaceView('preview');
  try {
    const pdfUrl = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
    pdfLoadingTask = pdfjsLib.getDocument({ url: pdfUrl, isEvalSupported: false });
    const pdf = await pdfLoadingTask.promise;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      if (renderGeneration !== pdfRenderGeneration) return;
      const page = await pdf.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const availableWidth = Math.max(320, container.clientWidth - 32);
      const viewport = page.getViewport({ scale: availableWidth / baseViewport.width });
      const outputScale = Math.min(window.devicePixelRatio || 1, 2);
      const pageElement = document.createElement('div');
      pageElement.className = 'pdf-page';
      pageElement.setAttribute('role', 'img');
      pageElement.setAttribute('aria-label', 'PDF page ' + pageNumber + ' of ' + pdf.numPages);
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = Math.floor(viewport.width) + 'px';
      canvas.style.height = Math.floor(viewport.height) + 'px';
      pageElement.appendChild(canvas);
      container.appendChild(pageElement);
      await page.render({
        canvasContext: canvas.getContext('2d', { alpha: false }),
        viewport,
        transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
      }).promise;
    }
    if (renderGeneration === pdfRenderGeneration) placeholder.classList.add('hidden');
  } catch (error) {
    if (renderGeneration !== pdfRenderGeneration) return;
    placeholder.textContent = 'PDF rendering failed';
    placeholder.classList.remove('hidden');
    showStatus(error?.message || 'PDF rendering failed', 'error');
  }
}

function resetCompiledPreview() {
  pdfRenderGeneration += 1;
  if (pdfLoadingTask) pdfLoadingTask.destroy().catch(() => {});
  pdfLoadingTask = null;
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

async function loadEngineStatus() {
  try {
    const res = await fetch('/api/engines');
    const data = await res.json();
    const el = document.getElementById('engine-status');
    const compileBtn = document.getElementById('compile-btn');
    if (data.engines && data.engines.length > 0) {
      el.textContent = 'Engine: ' + data.engines[0];
      compileBtn.disabled = false;
    } else {
      el.textContent = 'No LaTeX engine';
      compileBtn.disabled = true;
    }
  } catch {
    document.getElementById('engine-status').textContent = 'Engine check failed';
    document.getElementById('compile-btn').disabled = true;
  }
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    currentProvider = data.provider || 'mock';
    document.getElementById('agent-provider').textContent = currentProvider;
  } catch {}
}

function selectedAgentProfile() {
  const id = document.getElementById('agent-config-provider')?.value;
  return agentProviders.find((item) => item.id === id) || null;
}

function fillAgentConfigForm() {
  const profile = selectedAgentProfile();
  if (!profile) return;
  document.getElementById('agent-config-command').value = profile.command || '';
  document.getElementById('agent-config-model').value = profile.model || '';
  document.getElementById('agent-config-args').value = (profile.args || []).join('\n');
  document.getElementById('agent-config-note').textContent = profile.integration === 'planned'
    ? 'The Claude Code configuration shape is reserved, but its execution adapter is not connected yet. Saving will not activate it.'
    : profile.id === 'mock' ? 'The built-in Mock provider runs the workflow without an external CLI.' : 'Changes apply to this server immediately. The CLI must be installed and authenticated.';
  const submit = document.querySelector('#agent-config-form button[type="submit"]');
  submit.textContent = profile.integration === 'planned' ? 'Save reserved configuration' : 'Save and use for this server';
}

function renderAgentConfiguration() {
  const current = agentProviders.find((item) => item.id === currentProvider);
  document.getElementById('agent-config-summary').textContent = current
    ? `${current.label} · ${current.available ? current.version || 'available' : current.integration === 'planned' ? 'adapter reserved' : 'CLI not detected'}`
    : currentProvider;
  const list = document.getElementById('agent-provider-list');
  list.innerHTML = agentProviders.map((item) => {
    const state = item.integration === 'planned' ? 'planned' : item.available ? 'available' : '';
    const stateText = item.integration === 'planned' ? 'reserved' : item.available ? 'available' : 'not installed';
    return '<article class="agent-provider-card ' + (item.id === currentProvider ? 'active' : '') + '"><div><strong>'
      + escapeHtml(item.label) + '</strong><span class="' + state + '">' + stateText + '</span></div><p>'
      + escapeHtml(item.adapter) + ' · ' + escapeHtml((item.capabilities || []).join(', ') || 'future adapter')
      + (item.version ? '<br>' + escapeHtml(item.version) : '') + '</p></article>';
  }).join('');
  const select = document.getElementById('agent-config-provider');
  const selected = select.value || currentProvider;
  select.innerHTML = agentProviders.map((item) => '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.label) + '</option>').join('');
  select.value = agentProviders.some((item) => item.id === selected) ? selected : agentProviders[0]?.id || '';
  fillAgentConfigForm();
}

async function loadAgentConfiguration() {
  try {
    const res = await fetch('/api/agents');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Agent configuration failed to load');
    currentProvider = data.selected;
    agentProviders = data.providers || [];
    document.getElementById('agent-provider').textContent = currentProvider;
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
    args: document.getElementById('agent-config-args').value.split('\n').map((item) => item.trim()).filter(Boolean),
    activate: profile.integration === 'ready',
  };
  try {
    const res = await fetch('/api/agents/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Agent configuration save failed');
    currentProvider = data.selected;
    await loadAgentConfiguration();
    document.getElementById('panel-provider').value = ['mock', 'codex', 'opencode'].includes(currentProvider) ? currentProvider : 'mock';
    showStatus('Agent configuration saved', 'success');
  } catch (error) { showStatus(error.message, 'error'); }
}

function schedulePromptContextPreview() {
  clearTimeout(promptPreviewTimer);
  promptPreviewTimer = setTimeout(refreshPromptContextPreview, 180);
}

async function refreshPromptContextPreview() {
  if (!currentDocument || !editor) return;
  currentPromptPreview = null;
  const selectedId = selectedNode?.type !== 'document' ? selectedNode?.id : null;
  try {
    const res = await fetch('/api/agent/context-preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: selectedId, documentId: currentDocument.id,
        content: selectedId ? '' : editor.getValue(),
        temporaryPrompt: document.getElementById('ai-prompt').value.trim(),
        resourceIds: [...selectedResourceIds],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Prompt preview failed');
    currentPromptPreview = data;
    document.getElementById('prompt-context-meta').textContent = `${data.scope} · ${data.layers.length} layers · ${data.characterCount.toLocaleString()} chars`;
    document.getElementById('prompt-context-excerpt').textContent = data.contextPrompt;
    document.getElementById('prompt-preview-meta').textContent = `${data.provider} · ${data.scope} · ${data.characterCount.toLocaleString()} characters`;
    document.getElementById('prompt-preview-content').textContent = data.assembledPrompt;
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
  } catch (e) {
    showStatus('Failed to load ' + name, 'error');
  }
}

async function saveFile({ sync = true } = {}) {
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

function renderOutline() {
  const container = document.getElementById('outline-tree');
  if (!currentDocument) {
    container.innerHTML = '<div class="outline-empty">No structure available</div>';
    return;
  }
  const sentenceHtml = (sentence, index) =>
    '<button class="outline-node sentence" data-node-id="' + escapeHtml(sentence.id) + '" title="' + escapeHtml(sentence.intent || '') + '">'
    + (index + 1) + '. ' + escapeHtml(shorten(sentence.text, 45)) + '</button>';
  const paragraphHtml = (paragraph, index) =>
    '<details class="outline-paragraph"><summary class="outline-node" data-node-id="' + escapeHtml(paragraph.id) + '">¶ '
    + (index + 1) + ' · ' + escapeHtml(shorten(paragraph.summary || paragraph.text, 38)) + '</summary>'
    + '<div class="outline-sentences">' + paragraph.children.map(sentenceHtml).join('') + '</div></details>';
  const sectionHtml = (section) =>
    '<details open class="outline-section level-' + section.level + '"><summary class="outline-node" data-node-id="' + escapeHtml(section.id) + '">'
    + escapeHtml(section.title) + '</summary>' + section.children.map(paragraphHtml).join('') + '</details>';
  container.innerHTML = '<button class="outline-document" data-node-id="' + escapeHtml(currentDocument.id) + '">'
    + escapeHtml(currentDocument.title || currentDocument.file) + '</button>'
    + currentDocument.sections.map(sectionHtml).join('');
  container.querySelectorAll('[data-node-id]').forEach(element => {
    element.addEventListener('click', (event) => {
      event.stopPropagation();
      selectStructureNode(element.dataset.nodeId);
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

function selectStructureNode(nodeId, { focus = true } = {}) {
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
  if (focus && node.sourceRange) {
    const start = editor.posFromIndex(node.sourceRange.start);
    const end = editor.posFromIndex(node.sourceRange.end);
    editor.setSelection(start, end);
    editor.scrollIntoView({ from: start, to: end }, 80);
    editor.focus();
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
    renderOutline();
    const nextId = selectedId && (selectedId === currentDocument.id || findNode(currentDocument.sections, selectedId))
      ? selectedId : currentDocument.id;
    selectStructureNode(nextId, { focus: false });
    if (!silent) showStatus('Outline synchronized', 'success');
    return true;
  } catch (error) {
    currentDocument = null;
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

async function compileFile() {
  if (!await saveFile()) return;
  showStatus('Compiling...', '');
  try {
    const res = await fetch('/api/compile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: currentFile }),
    });
    const data = await res.json();
    if (data.ok) {
      showCompiledPdf(data.pdf);
      showStatus('Compiled (' + data.engine + ')', 'success');
    } else {
      showStatus('Compile error', 'error');
      alert('Compilation failed:\n' + data.error);
    }
  } catch {
    showStatus('Compile request failed', 'error');
  }
}

async function invokeAgent() {
  await refreshPromptContextPreview();
  if (!currentPromptPreview) return showStatus('Prompt context is not ready', 'error');
  const temporaryCharacters = document.getElementById('ai-prompt').value.trim().length;
  document.getElementById('invoke-confirm-summary').textContent = `${currentProvider} · ${currentPromptPreview.scope} · ${currentPromptPreview.contextPrompt.length.toLocaleString()} context characters + ${temporaryCharacters.toLocaleString()} temporary characters`;
  document.getElementById('invoke-confirm-overlay').classList.remove('hidden');
}

async function askAgent(composedPrompt = null) {
  const prompt = composedPrompt || document.getElementById('ai-prompt').value.trim();
  const selectedId = selectedNode?.type !== 'document' ? selectedNode?.id : null;
  if (!await saveFile()) return;
  const content = editor.getValue();
  const button = document.getElementById('ai-invoke');
  button.disabled = true;
  showStatus('Agent is analyzing...', '');
  try {
    const res = await fetch(selectedId ? '/api/agent/suggest-node' : '/api/agent/suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(selectedId
        ? { nodeId: selectedId, prompt, promptIsComposed: Boolean(composedPrompt), resourceIds: [...selectedResourceIds] }
        : { documentId: currentDocument?.id, content, prompt, promptIsComposed: Boolean(composedPrompt), resourceIds: [...selectedResourceIds] }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Agent request failed');
    suggestions = data.suggestions || [];
    lastLibraryUsage = data.library || null;
    renderSuggestions();
    renderLibraryUsage();
    document.getElementById('ai-prompt').value = '';
    schedulePromptContextPreview();
    if (suggestions.length === 0) showStatus('No suggestions generated', '');
    else showStatus(suggestions.length + ' suggestion(s)', 'success');
  } catch (error) {
    showStatus(error.message || 'Agent request failed', 'error');
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
  container.innerHTML = suggestions.map(s => {
    return '<div class="suggestion" data-id="' + s.id + '">'
      + '<span class="badge ' + s.category + '">' + escapeHtml(s.category) + '</span>'
      + '<div class="desc">' + escapeHtml(s.description) + '</div>'
      + '<div class="diff"><del>' + escapeHtml(s.originalText) + '</del>\n<ins>' + escapeHtml(s.suggestedText) + '</ins></div>'
      + '<div class="actions">'
      + '<button class="accept" data-id="' + s.id + '">Accept</button>'
      + '<button class="reject" data-id="' + s.id + '">Reject</button>'
      + '</div></div>';
  }).join('');

  container.querySelectorAll('.accept').forEach(btn => {
    btn.addEventListener('click', () => acceptSuggestion(btn.dataset.id));
  });
  container.querySelectorAll('.reject').forEach(btn => {
    btn.addEventListener('click', () => rejectSuggestion(btn.dataset.id));
  });
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

function init() {
  editor = CodeMirror.fromTextArea(document.getElementById('editor'), {
    mode: 'stex',
    lineNumbers: true,
    lineWrapping: true,
    indentUnit: 2,
    tabSize: 2,
  });

  editor.setOption('extraKeys', {
    'Ctrl-S': (cm) => { saveFile(); return false; },
    'Cmd-S': (cm) => { saveFile(); return false; },
  });
  editor.on('change', (_instance, change) => {
    if (change.origin !== 'setValue') schedulePromptContextPreview();
  });

  document.getElementById('save-btn').addEventListener('click', saveFile);
  document.getElementById('compile-btn').addEventListener('click', compileFile);
  document.getElementById('source-view-btn').addEventListener('click', () => setWorkspaceView('source'));
  document.getElementById('preview-view-btn').addEventListener('click', () => setWorkspaceView('preview'));
  document.getElementById('ai-invoke').addEventListener('click', invokeAgent);
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
  document.getElementById('agent-config-close').addEventListener('click', () => document.getElementById('agent-config-overlay').classList.add('hidden'));
  document.getElementById('agent-config-overlay').addEventListener('click', event => {
    if (event.target.id === 'agent-config-overlay') event.currentTarget.classList.add('hidden');
  });
  document.getElementById('agent-config-provider').addEventListener('change', fillAgentConfigForm);
  document.getElementById('agent-config-form').addEventListener('submit', saveAgentConfiguration);
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
    if (event.key === 'Escape') {
      document.getElementById('library-overlay').classList.add('hidden');
      document.getElementById('review-overlay').classList.add('hidden');
      document.getElementById('peer-review-overlay').classList.add('hidden');
      document.getElementById('agent-config-overlay').classList.add('hidden');
      document.getElementById('prompt-preview-overlay').classList.add('hidden');
      document.getElementById('invoke-confirm-overlay').classList.add('hidden');
      if (!document.getElementById('focus-annotation-overlay').classList.contains('hidden')) await closeFocusAnnotation();
    }
  });
  document.getElementById('ai-prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) invokeAgent();
  });
  document.getElementById('ai-prompt').addEventListener('input', schedulePromptContextPreview);

  loadEngineStatus();
  loadConfig();
  loadAgentConfiguration();
  updateLibrarySelectionStatus();
  loadFileTree();
  loadFile(currentFile);
}

document.addEventListener('DOMContentLoaded', init);
