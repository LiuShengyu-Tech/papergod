import {
  BarChart3, BookMarked, BookOpen, Bot, Braces, FileText, FolderKanban, GitPullRequest, History,
  Network, Play, RefreshCw, Save, ScanText, Sparkles, SquareTerminal, Users,
} from 'lucide-react';
import { Button } from './ui/button.jsx';

function ProductHeader() {
  return (
    <header id="header">
      <div className="brand-mark"><FileText size={17} strokeWidth={1.8} /><span className="logo">Papergod</span><span id="active-workspace-name" title="Current workspace">Workspace</span></div>
      <nav className="header-actions" aria-label="Workspace tools">
        <Button id="library-open" variant="ghost" size="sm"><BookOpen size={14} /><span data-i18n="header.libraries">Writing libraries</span></Button>
        <Button id="focus-annotation-open" variant="ghost" size="sm"><ScanText size={14} /><span data-i18n="header.focus">Focus annotation</span></Button>
        <Button id="review-open" variant="ghost" size="sm"><GitPullRequest size={14} /><span data-i18n="header.review">Review &amp; revise</span></Button>
        <Button id="peer-review-open" variant="ghost" size="sm"><Users size={14} /><span data-i18n="header.peerReview">Peer review</span></Button>
      </nav>
      <span id="status" role="status" aria-live="polite" />
      <label className="language-control"><span data-i18n="language.label">Language</span><select id="language-select" aria-label="Language"><option value="en">English</option><option value="zh-CN">简体中文</option></select></label>
    </header>
  );
}

function Navigator() {
  return (
    <aside id="sidebar">
      <div id="navigator-tabs" role="tablist" aria-label="Paper navigation"><button id="navigator-outline-tab" className="active" type="button" role="tab" aria-selected="true" data-i18n="nav.outline">Outline</button><button id="navigator-tools-tab" type="button" role="tab" aria-selected="false" data-i18n="nav.tools">Tools</button></div>
      <section id="navigator-outline-panel" className="navigator-panel" role="tabpanel">
        <div className="sidebar-heading"><h3 data-i18n="nav.paperOutline">Paper outline</h3><Button id="sync-outline" variant="ghost" size="icon" title="Synchronize outline" aria-label="Synchronize outline"><RefreshCw size={14} /></Button></div>
        <div id="outline-tree"><div className="outline-empty" data-i18n="nav.openPaper">Open a paper</div></div>
      </section>
      <section id="navigator-tools-panel" className="navigator-panel hidden" role="tabpanel">
        <div className="sidebar-heading"><h3 data-i18n="nav.workspaceTools">Workspace tools</h3></div>
        <div className="tool-list"><button id="tool-workspaces" type="button"><FolderKanban size={13} /><span data-i18n="tools.workspaces">Workspaces</span></button><button id="tool-references" type="button"><BookMarked size={13} /><span data-i18n="tools.references">References</span></button><button id="tool-orchestration" type="button"><Network size={13} /><span data-i18n="tools.orchestration">Agent orchestration</span></button><button id="tool-analysis" type="button"><BarChart3 size={13} /><span data-i18n="tools.analysis">Paragraph analysis</span></button><button id="tool-terminal" type="button"><SquareTerminal size={13} /><span data-i18n="tools.terminal">Terminal</span></button><button id="tool-open-folder" type="button" data-i18n="tools.openFolder">Open paper folder</button><button id="tool-show-source" type="button" data-i18n="tools.source">LaTeX source</button><button id="tool-compile" type="button" data-i18n="tools.compile">Compile PDF</button><button id="tool-change-history" type="button" data-i18n="tools.changeHistory">Change history</button><button id="tool-libraries" type="button" data-i18n="tools.libraries">Writing libraries</button><button id="tool-agent-config" type="button" data-i18n="tools.agentConfig">Agent configuration</button></div>
        <div className="sidebar-heading tool-files-heading"><h3 data-i18n="tools.backendFiles">Backend files</h3></div><ul id="file-tree" />
      </section>
    </aside>
  );
}

function EditorWorkspace() {
  return (
    <main id="editor-panel">
      <div id="editor-toolbar">
        <div className="file-context"><Braces size={14} /><span id="current-file">main.tex</span></div>
        <div id="workspace-view-switch" role="tablist" aria-label="Document view">
          <button id="source-view-btn" className="view-tab active" type="button" role="tab" aria-selected="true" aria-controls="source-view" data-i18n="editor.source">Source</button>
          <button id="preview-view-btn" className="view-tab" type="button" role="tab" aria-selected="false" aria-controls="preview-panel" disabled data-i18n="editor.preview">PDF Preview</button>
        </div>
        <Button id="history-open" variant="outline" size="sm" title="Change history"><History size={14} /><span data-i18n="history.title">Change history</span></Button>
        <Button id="save-btn" variant="outline" size="sm" title="Save (Ctrl+S)"><Save size={14} /><span data-i18n="editor.save">Save</span></Button>
        <Button id="compile-btn" variant="primary" size="sm" title="Compile LaTeX"><Play size={14} /><span data-i18n="editor.compile">Compile</span></Button>
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
        <div id="ai-header"><span><Bot size={15} /><span data-i18n="ai.title">AI Assistant</span></span><select id="agent-provider-quick" aria-label="Active AI Agent"><option value="mock">Mock</option></select></div>
        <div id="ai-module-list">
          <section className="ai-module" id="agent-config-module">
            <div className="ai-module-head"><div><span className="module-index">1</span><strong data-i18n="ai.agentConfig">Agent Configuration</strong></div><Button id="agent-config-open" variant="ghost" size="sm"><span data-i18n="ai.configure">Configure</span></Button></div>
            <div id="agent-config-summary" data-i18n="ai.detecting">Detecting local Agents…</div>
          </section>
          <section className="ai-module" id="prompt-management-module">
            <div className="ai-module-head"><div><span className="module-index">2</span><strong data-i18n="ai.promptManagement">Prompt Management</strong></div></div>
            <details id="modification-intent-module">
              <summary><span data-i18n="ai.intents">Modification intents</span><span id="modification-intent-count">0 queued</span></summary>
              <div id="modification-intent-list"><div className="outline-empty" data-i18n="ai.intentsEmpty">Click PDF text to add revision comments.</div></div>
            </details>
            <div id="temporary-prompt-module">
              <div className="prompt-management-label"><strong data-i18n="ai.tempPrompt">Temporary prompt</strong><span data-i18n="ai.thisRun">This run only</span></div>
              <textarea id="ai-prompt" rows="4" placeholder="Add a one-time goal, constraint, or instruction…" data-i18n-placeholder="ai.tempPlaceholder" />
            </div>
            <Button id="prompt-preview-open" variant="outline" size="sm"><span data-i18n="ai.previewPrompt">Preview final prompt</span></Button>
          </section>
          <div id="prompt-context-compat" className="hidden" aria-hidden="true">
            <div id="prompt-context-module"><div id="context-title">Whole document</div><div id="prompt-context-meta" /><pre id="prompt-context-excerpt" /></div>
            <div id="context-definition-editor"><textarea id="context-summary" /><textarea id="context-prompt" /><div id="intent-field" className="hidden"><textarea id="context-intent" /></div><Button id="save-context">Save</Button><Button id="clear-context">Whole document</Button><span id="library-selection-status">Resources: auto</span></div>
          </div>
          <section className="ai-module invoke-module">
            <Button id="ai-invoke" variant="primary"><Sparkles size={16} /><span data-i18n="ai.invoke">Invoke Agent</span><span id="ai-invoke-intent-count" className="hidden" /></Button>
            <div id="agent-activity" className="agent-activity idle">
              <button id="agent-activity-toggle" type="button" aria-expanded="false" aria-controls="agent-activity-panel">
                <span className="agent-activity-dot" aria-hidden="true" />
                <span id="agent-activity-label" data-i18n="activity.idle">Agent idle</span>
                <span id="agent-activity-elapsed">—</span>
                <span className="agent-activity-chevron" aria-hidden="true">⌄</span>
              </button>
              <div id="agent-activity-panel" className="hidden">
                <div id="agent-activity-subtitle" data-i18n="activity.none">No Agent task has run in this session.</div>
                <ol id="agent-activity-stages">
                  <li data-stage="prepare" data-i18n="activity.context">Context</li><li data-stage="run" data-i18n="activity.agent">Agent</li><li data-stage="apply" data-i18n="activity.apply">Apply</li><li data-stage="compile" data-i18n="activity.compile">Compile</li>
                </ol>
                <pre id="agent-activity-log" data-i18n="activity.liveOutput">Live CLI output will appear here.</pre>
                <div className="agent-activity-result hidden" id="agent-activity-result" />
                <div className="agent-activity-actions"><button id="agent-activity-cancel" className="hidden" type="button" data-i18n="activity.cancel">Cancel</button><button id="agent-activity-undo" className="hidden" type="button" data-i18n="activity.undo">Undo this revision</button></div>
              </div>
            </div>
          </section>
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
