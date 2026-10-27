# DeepL sentence translation

Open **Tools → Translation settings**, paste a DeepL API key, and choose **Save & test connection**. Automatic endpoint selection uses the Free API for keys ending in `:fx`; the endpoint can also be selected manually. The connection test calls `/v2/usage` without translating text.

In the PDF sentence reader, **Translate to Chinese** sends the current readable sentence to DeepL and displays simplified Chinese below it. LaTeX formatting is removed using the reader's existing text conversion. Translation is click-triggered. Up to 500 sentence results are cached in server memory; restarting clears the cache. Navigation clears displayed translations and ignores late results from earlier sentences.

The key is stored as JSON in `~/.papergod/deepl.json`, outside paper workspaces. It is not encrypted at rest; protect the local user account. Settings responses never return the key. Requests go through the local backend to the fixed official DeepL endpoints. No key is stored in browser local storage. The settings dialog supports key replacement and removal.

Restart an already-running Papergod server after installing this change, then reload its page.

## Verification — 2026-10-26

- `node --test tests/translation.test.js tests/latex-readable.test.js tests/agent-connection.test.js`: 6 passed. Covers credential persistence/redaction, endpoint selection, usage query, Chinese translation request, cache, missing credentials, length validation, quota error and cross-origin rejection with an injected DeepL response.
- `npm run build:web`: passed; JavaScript syntax checks passed.
- Visible local preview on port 3089: Tools entry and settings dialog checked; centering corrected and visually rechecked. No real credentials entered.
- Full suite before adding translation test to default command: 152 passed, 3 failed, 4 skipped. Failures concern the existing workflow capability-string assertion, CLI bin path assertion, and Agent reasoning-effort assertion; no DeepL assertion failed. These areas were not changed for translation.
- Live DeepL authentication/translation and reader end-to-end UI translation remain unverified pending a user API key. Sentence-navigation stale-result handling was code-reviewed, not exercised against live DeepL.
