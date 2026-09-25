import { execFile } from 'child_process';
import { readFile, rm } from 'fs/promises';
import { resolve as pathResolve, dirname, basename } from 'path';

const ENGINE_ORDER = ['tectonic', 'pdflatex', 'xelatex', 'lualatex'];
const COMPILE_TIMEOUT_MS = 30000;
const FIND_COMMAND = process.platform === 'win32' ? 'where' : 'which';

export async function detectEngines() {
  const available = [];
  for (const engine of ENGINE_ORDER) {
    try {
      await new Promise((res, rej) => {
        execFile(FIND_COMMAND, [engine], { timeout: 5000, shell: false }, (err) => {
          if (err) rej(err);
          else res();
        });
      });
      available.push(engine);
    } catch {}
  }
  return available;
}

// Build artifacts that a clean ("from scratch") compile removes, next to the
// entry file and sharing its base name. Sources, figures, and the PDF are kept.
const AUX_EXTENSIONS = [
  'aux', 'bbl', 'blg', 'bcf', 'run.xml', 'toc', 'lof', 'lot', 'lol', 'out', 'fls', 'fdb_latexmk',
  'synctex.gz', 'synctex', 'nav', 'snm', 'vrb', 'idx', 'ind', 'ilg', 'glo', 'gls', 'glg', 'ist',
  'acn', 'acr', 'alg', 'brf', 'xdv', 'loa', 'thm', 'log',
];
const MAX_RERUNS = 3;

function toolEnv() {
  return { ...process.env, openin_any: 'p', openout_any: 'p', shell_escape: 'f' };
}

function runTool(command, args, cwd) {
  return new Promise((done) => {
    execFile(command, args, {
      cwd,
      timeout: COMPILE_TIMEOUT_MS,
      shell: false,
      env: toolEnv(),
      maxBuffer: 10 * 1024 * 1024,
      killSignal: 'SIGKILL',
    }, (err, stdout, stderr) => {
      done({ ok: !err, timedOut: Boolean(err?.killed), message: err?.message || '', output: (stderr || '') + (stdout || '') });
    });
  });
}

function engineArgs(engine, texPath, fileDir, fileBase) {
  if (engine === 'tectonic') return [texPath, '--outdir', fileDir];
  // -file-line-error reports errors as "file:line: message" so the UI can link them to source.
  return ['-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-output-directory', fileDir, fileBase];
}

function engineFailure(engine, result, log) {
  if (result.timedOut) return { ok: false, error: `Compilation timed out (${COMPILE_TIMEOUT_MS / 1000}s)`, engine, log };
  const errorMatch = log.match(/^(?:error: )?\S+?\.(?:tex|sty|cls):\d+: .*$/m) || log.match(/^!.*$/m);
  return { ok: false, error: errorMatch?.[0] || result.message, engine, log };
}

export async function cleanAuxiliaryFiles(fileDir, fileBase) {
  const removed = [];
  for (const extension of AUX_EXTENSIONS) {
    const target = pathResolve(fileDir, `${fileBase}.${extension}`);
    try {
      await rm(target);
      removed.push(basename(target));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return removed;
}

async function readIfExists(path) {
  try { return await readFile(path, 'utf-8'); } catch { return null; }
}

export async function compile(texPath, workspaceRoot, { clean = false } = {}) {
  const engines = await detectEngines();
  if (engines.length === 0) {
    return { ok: false, error: 'No LaTeX engine found. Install pdflatex, xelatex, lualatex, or tectonic.', engine: null };
  }

  const engine = engines[0];
  const fileDir = dirname(texPath);
  const fileBase = basename(texPath, '.tex');
  const args = engineArgs(engine, texPath, fileDir, fileBase);
  const pdfPath = pathResolve(fileDir, fileBase + '.pdf');

  if (!clean) {
    const result = await runTool(engine, args, fileDir);
    if (!result.ok) return engineFailure(engine, result, result.output);
    return { ok: true, pdf: pdfPath, engine, output: result.output };
  }

  // From scratch: remove cached build files, then LaTeX -> BibTeX/Biber -> LaTeX
  // until cross-references settle. Tectonic already runs every pass it needs.
  const removed = await cleanAuxiliaryFiles(fileDir, fileBase);
  const steps = [];
  let log = `=== Removed ${removed.length} auxiliary file(s)${removed.length ? `: ${removed.join(', ')}` : ''} ===\n`;
  const runEngine = async (label) => {
    const result = await runTool(engine, args, fileDir);
    steps.push(engine);
    log += `\n=== ${engine} (${label}) ===\n${result.output}`;
    return result;
  };

  let result = await runEngine('pass 1');
  if (!result.ok) return { ...engineFailure(engine, result, log), steps, removed };
  if (engine === 'tectonic') return { ok: true, pdf: pdfPath, engine, output: log, steps, removed };

  const bcf = await readIfExists(pathResolve(fileDir, `${fileBase}.bcf`));
  const aux = await readIfExists(pathResolve(fileDir, `${fileBase}.aux`)) || '';
  const bibTool = bcf !== null ? 'biber' : /\\bibdata\{/.test(aux) ? 'bibtex' : null;
  if (bibTool) {
    const bib = await runTool(bibTool, [fileBase], fileDir);
    steps.push(bibTool);
    // A bibliography problem (missing .bib, bad entry) should not block the PDF;
    // it shows up in the log and as undefined citations.
    log += `\n=== ${bibTool}${bib.ok ? '' : ' (reported problems)'} ===\n${bib.output || bib.message}`;
  }

  for (let pass = 2; pass <= MAX_RERUNS + 1; pass += 1) {
    result = await runEngine(`pass ${pass}`);
    if (!result.ok) return { ...engineFailure(engine, result, log), steps, removed };
    // Only LaTeX's own "run again" notices; a bare /rerun/ would also match the
    // rerunfilecheck package that hyperref loads in every run.
    const rerun = /Rerun to get|Please rerun LaTeX|Label\(s\) may have changed|Rerun LaTeX/.test(result.output);
    if (pass >= 3 && !rerun) break;
  }
  return { ok: true, pdf: pdfPath, engine, output: log, steps, removed };
}
