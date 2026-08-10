import {
  BookOpen, Bot, Braces, FileText, GitPullRequest, PanelTop,
  Play, RefreshCw, Save, ScanText, Sparkles, Users,
} from 'lucide-react';
import { Badge } from './ui/badge.jsx';
import { Button } from './ui/button.jsx';

function ProductHeader() {
  return (
    <header id="header">
      <div className="brand-mark"><FileText size={17} strokeWidth={1.8} /><span className="logo">Papergod</span></div>
      <nav className="header-actions" aria-label="Workspace tools">
        <Button id="library-open" variant="ghost" size="sm"><BookOpen size={14} />Writing libraries</Button>
        <Button id="focus-annotation-open" variant="ghost" size="sm"><ScanText size={14} />Focus annotation</Button>
        <Button id="review-open" variant="ghost" size="sm"><GitPullRequest size={14} />Review &amp; revise</Button>
        <Button id="peer-review-open" variant="ghost" size="sm"><Users size={14} />Peer review</Button>
      </nav>
      <span id="status" role="status" aria-live="polite" />
      <Badge id="engine-status">Checking engine…</Badge>
    </header>
  );
}

function Navigator() {
  return (
    <aside id="sidebar">
      <div className="sidebar-heading"><h3>Files</h3></div>
      <ul id="file-tree" />
      <div className="sidebar-heading outline-heading">
        <h3>Document outline</h3>
        <Button id="sync-outline" variant="ghost" size="icon" title="Synchronize outline" aria-label="Synchronize outline"><RefreshCw size={14} /></Button>
      </div>
      <div id="outline-tree"><div className="outline-empty">Open a TeX document</div></div>
    </aside>
  );
}

function EditorWorkspace() {
  return (
    <main id="editor-panel">
      <div id="editor-toolbar">
        <div className="file-context"><Braces size={14} /><span id="current-file">main.tex</span></div>
        <div id="workspace-view-switch" role="tablist" aria-label="Document view">
          <button id="source-view-btn" className="view-tab active" type="button" role="tab" aria-selected="true" aria-controls="source-view">Source</button>
          <button id="preview-view-btn" className="view-tab" type="button" role="tab" aria-selected="false" aria-controls="preview-panel" disabled>PDF Preview</button>
        </div>
        <Button id="save-btn" variant="outline" size="sm" title="Save (Ctrl+S)"><Save size={14} />Save</Button>
        <Button id="compile-btn" variant="primary" size="sm" title="Compile LaTeX"><Play size={14} />Compile</Button>
      </div>
      <div id="workspace-view">
        <section id="source-view" className="workspace-pane" role="tabpanel" aria-labelledby="source-view-btn"><textarea id="editor" /></section>
        <section id="preview-panel" className="workspace-pane hidden" role="tabpanel" aria-labelledby="preview-view-btn">
          <div id="pdf-preview" aria-label="Rendered PDF pages" />
          <div id="preview-placeholder">Compile to render the paper</div>
        </section>
      </div>
    </main>
  );
}

function AssistantPanel() {
  return (
    <aside id="right-panel">
      <div id="ai-panel">
        <div id="ai-header"><span><Bot size={15} />AI Assistant</span><Badge id="agent-provider">mock</Badge></div>
        <div id="ai-module-list">
          <section className="ai-module" id="agent-config-module">
            <div className="ai-module-head"><div><span className="module-index">1</span><strong>Agent Configuration</strong></div><Button id="agent-config-open" variant="ghost" size="sm">Configure</Button></div>
            <div id="agent-config-summary">Detecting local Agents…</div>
          </section>
          <section className="ai-module" id="prompt-context-module">
            <div className="ai-module-head"><div><span className="module-index">2</span><strong>Prompt Context</strong></div><Button id="prompt-preview-open" variant="ghost" size="sm">Preview full</Button></div>
            <div id="context-title">Whole document</div>
            <div id="prompt-context-meta">Waiting for document structure…</div>
            <pre id="prompt-context-excerpt">The prompt will be assembled from project, document, element, and writing-library context.</pre>
            <details id="context-definition-editor">
              <summary>Edit current element definitions</summary>
              <label htmlFor="context-summary">Summary</label>
              <textarea id="context-summary" rows="2" placeholder="What this element contributes..." />
              <label htmlFor="context-prompt">Writing prompt</label>
              <textarea id="context-prompt" rows="2" placeholder="Goals and constraints for this element..." />
              <div id="intent-field" className="hidden"><label htmlFor="context-intent">Sentence intent</label><textarea id="context-intent" rows="2" placeholder="What this sentence is doing..." /></div>
              <div className="context-actions"><Button id="save-context" variant="outline" size="sm">Save context</Button><Button id="clear-context" variant="ghost" size="sm">Whole document</Button><span id="library-selection-status">Resources: auto</span></div>
            </details>
          </section>
          <section className="ai-module" id="temporary-prompt-module">
            <div className="ai-module-head"><div><span className="module-index">3</span><strong>Temporary Prompt</strong></div><span>This run only</span></div>
            <textarea id="ai-prompt" rows="4" placeholder="Add a one-time goal, constraint, or instruction…" />
          </section>
          <section className="ai-module invoke-module"><Button id="ai-invoke" variant="primary"><Sparkles size={16} />请神</Button></section>
        </div>
        <div id="library-usage" className="hidden" />
        <div id="paragraph-draft" className="hidden" />
        <div id="ai-suggestions" />
      </div>
    </aside>
  );
}

export function Workbench() {
  return <div id="app"><ProductHeader /><Navigator /><EditorWorkspace /><AssistantPanel /></div>;
}
