# Papergod

AI-powered LaTeX writing platform — a local-first Overleaf-style editor with safe compilation, structured writing context, and Mock/Codex/Claude Code/OpenCode assistants.

## Quick Start

```bash
npm install
npm run papergod
```

Open http://127.0.0.1:3000 in your browser.

`npm run papergod` starts the built-in demo workspace and safely fills any missing demo prompts, corpora, sentence patterns, vocabulary, and sample review comments. To seed another disposable workspace explicitly, use `papergod ./demo-paper --demo`. Ordinary `papergod ./my-paper` runs never add demo metadata.

When installed as a package, run Papergod in any paper directory:

```bash
npx papergod .
npx papergod ./my-paper --port 4312 --agent codex
```

The CLI initializes `main.tex` when the workspace contains no TeX files and stores Papergod metadata in `.papergod/project.json`. Agent choices are `mock`, `codex`, `claude-code`, and `opencode`. External providers require an installed and authenticated CLI; Papergod invokes them non-interactively with structured output, timeouts, output limits, and read-only analysis permissions.

![Papergod demo](./papergod-demo.png)

## Architecture

```
Browser (3-panel UI)
  │
  │  CodeMirror editor + structured outline + clean PDF.js page rendering + AI panel
  │
  ▼
Express server (127.0.0.1 only)
  ├── /api/files/*       — read/write .tex files (path-traversal protected)
  ├── /api/compile       — LaTeX compilation (pdflatex/xelatex/lualatex/tectonic)
  ├── /api/engines       — list available LaTeX engines
  ├── /api/agent/*       — scoped AI suggestions + audited CLI runs
  ├── /api/documents/*   — LaTeX structure synchronization + layered prompts
  ├── /api/libraries/*   — corpora, sentence patterns, and scoped vocabulary
  ├── /api/annotations   — range-anchored writing and review comments
  ├── /api/review/*      — atomic review-opinion extraction
  ├── /api/reviews/*     — configurable peer-review panels and synthesis
  ├── /api/revisions/*   — reviewable plans, decisions, apply, and rollback
  ├── /api/generate/*    — prompt/library-controlled full-paper drafts
  ├── /api/workflow/*    — complete history and portable export bundles
  └── /workspace/*       — static serving of compiled PDFs
```

### Security

- Server binds only to `127.0.0.1` — no network exposure
- All file paths validated against workspace root (path traversal blocked)
- LaTeX compilation uses `execFile` with `shell: false`, shell escape disabled, a 30s timeout, and `SIGKILL` on overrun
- Only `.tex` files can be written or compiled
- Dotfiles denied in static serving
- CodeMirror is installed locally from npm; the editor does not depend on a public CDN

### Agent System

- The assistant is organized into Agent Configuration, assembled Prompt Context, a one-run Temporary Prompt, and the single **请神** invocation button
- **请神** first shows a confirmation dialog, then submits one merged `Prompt Context + Temporary Prompt` instruction to the active Agent
- Agent configuration uses one shared provider shape for Mock, Codex CLI, Claude Code, and OpenCode; all three external adapters support revision, paragraph drafting, peer review, review orchestration, and full-paper generation
- Papergod detects CLI versions and non-secret authentication readiness, offers a **Check connection** action, and reports installed, sign-in-needed, or ready states without exposing credentials
- Custom CLI paths, prefix arguments, and model overrides are persisted in `.papergod/project.json`, reloaded on later runs, and passed to the real CLI invocation
- Preview the complete invocation context assembled from project/document/element prompts, summaries, sentence intent, selected libraries, temporary instructions, and target source
- **Mock agent**: deterministic suggestions based on pattern matching (passive voice, "very + adjective", short conclusions)
- **CLI agents**: Codex, Claude Code, and OpenCode run non-interactively with validated structured output, read-only/plan execution, timeouts, cancellation, and audit records
- **Structured workflows**: editing, review orchestration, peer review, and full-paper generation each use a dedicated validated JSON protocol
- **Accept/Reject**: both decisions are persisted; accepted edits use atomic revisions and checksum recovery points
- **Element scope**: select a section, paragraph, or sentence from the outline to constrain prompts and diffs to that exact source range

### Structured Writing

- LaTeX sections, paragraphs, and sentences are mapped to stable IDs and exact source ranges
- The outline exposes editable document/element prompts, summaries, and sentence intents
- **Focus Annotation** opens an immersive three-column reader: paper outline on the left, one paragraph and its revision prompt in the center, and sentence-by-sentence reading with intent and prompt fields on the right
- Paragraph and sentence navigation automatically preserves draft annotations; **Open in editor** returns the selected paragraph to CodeMirror
- Sentence-level Agent requests inherit both the parent paragraph prompt and the sentence prompt, so focused annotations become actionable revision context
- Metadata is persisted atomically in `.papergod/project.json`
- Project schema v2 automatically migrates existing schema-v1 review records
- Stale source ranges are rejected before an Agent suggestion can be applied

### Writing Libraries

- Manage algorithm corpora, tagged sentence patterns, citations, and required template slots
- Keep global vocabulary separate from vocabulary agreed for the current writing session
- Select resources explicitly or let Papergod retrieve them by text, tags, and section type
- Generate a reviewable paragraph draft, then insert it only after user confirmation
- Extract candidate expressions from the current paper; candidates require confirmation before entering a library
- Agent runs distinguish resources provided as context from resources the Agent reports actually using

### Review & Revise

- Work through one unified two-stage workspace: **Opinions & plans** followed by **Responses & delivery**
- Anchor a comment to an exact editor selection, or import numbered/bulleted reviewer feedback
- Use Mock, Codex, or OpenCode to split feedback into atomic categorized opinions, exact quotes, suggested fixes, dependencies, and document-node assignments
- Build revision plans with visible before/after text plus dependency and conflict information
- Accept, reject, or defer changes individually; executable changes can also be accepted in a batch
- Apply accepted edits atomically only after explicit review
- Create checksum-protected recovery points and refuse rollback when it would discard later author edits

### Peer Review Panels

- Start from methodology, statistics, writing, domain, and reproducibility reviewer profiles
- Build a custom panel, add reviewer-specific instructions, and edit weighted rubric criteria
- Run reviewers independently through Mock, Codex, or OpenCode with one audited Agent run per report
- Validate exact manuscript quotes and rubric references in every external Agent response
- Synthesize consensus clusters, conflicting assessments, an overall verdict, and prioritized concerns
- Select concerns and send them directly into the reviewable M6 revision workflow

### Responses, Verification & Full-Paper Generation

- Continue from revision planning in the same Review & Revise drawer instead of switching tools
- Turn a revision plan into an editable point-by-point response letter and precise change list
- Apply revisions atomically, recompile the manuscript, and report every unresolved or deferred opinion
- Generate a complete LaTeX draft from project/document prompts, outline and paragraph prompts, plus selected corpora, patterns, and vocabulary
- Preview generated source and accept it only through the same visible revision diff used by ordinary edits
- Record accepted and rejected Agent decisions; accepted suggestions and paragraph insertions receive checksum recovery points
- Browse a unified history of Agent runs, peer reviews, and revisions
- Download source, annotations, reports, revisions, responses, change lists, history, and recovery metadata as a portable JSON bundle

### LaTeX Compilation

- Auto-detects available engines in order: tectonic → pdflatex → xelatex → lualatex
- Renders compiled PDFs as clean, continuous, width-fitted paper pages without the browser PDF viewer chrome
- Source and rendered pages share one switchable workspace, leaving the assistant column fully available
- Graceful degradation: if no engine found, compile button is disabled but editor works normally
- Compilation errors displayed to the user

## Requirements

- Node.js ≥ 18
- A LaTeX distribution (optional, for compilation): TeX Live, MiKTeX, or Tectonic

## Testing

```bash
npm test
```

## Project Structure

```
src/server/
  index.js      — Express app + API routes
  security.js   — Path sanitization + security headers
  latex.js      — Engine detection + compilation
  agent.js      — Suggestion store and deterministic Mock agent
  agent-adapters.js — Codex/Claude Code/OpenCode non-interactive adapters
  project-store.js — Versioned project metadata and validation
  project-resources.js — Corpus, vocabulary, annotation, and revision resources
  latex-structure.js — LaTeX structure/range parser
  document-structure.js — Structure synchronization and metadata APIs
  library-engine.js — Retrieval, scoped vocabulary, template rendering, extraction, and prompt context
  revision-engine.js — Opinion extraction, revision planning, atomic apply, and safe rollback
  review-panel.js — Reviewer profiles, independent reports, synthesis, and revision handoff
  revise-workflow.js — Response letters, verification, full-paper generation, history, and export
public/
  index.html    — Three-panel UI
  style.css     — Dark theme styles
  app.js        — Frontend logic
workspace/
  main.tex      — Sample LaTeX document
tests/
  api.test.js   — Integration tests
```

## Current Scope

- Single-user, local only
- External Agent quality and availability depend on the user's installed/authenticated CLI
- No concurrent editing / CRDT
- No file upload (only pre-existing .tex files in workspace)
- No bibliography / BibTeX support
