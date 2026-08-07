import { execFile } from 'child_process';
import { resolve as pathResolve, dirname, basename } from 'path';

const ENGINE_ORDER = ['tectonic', 'pdflatex', 'xelatex', 'lualatex'];
const COMPILE_TIMEOUT_MS = 30000;

export async function detectEngines() {
  const available = [];
  for (const engine of ENGINE_ORDER) {
    try {
      await new Promise((res, rej) => {
        execFile('which', [engine], { timeout: 5000, shell: false }, (err) => {
          if (err) rej(err);
          else res();
        });
      });
      available.push(engine);
    } catch {}
  }
  return available;
}

export async function compile(texPath, workspaceRoot) {
  const engines = await detectEngines();
  if (engines.length === 0) {
    return { ok: false, error: 'No LaTeX engine found. Install pdflatex, xelatex, lualatex, or tectonic.', engine: null };
  }

  const engine = engines[0];
  const fileDir = dirname(texPath);
  const fileBase = basename(texPath, '.tex');

  let args;
  if (engine === 'tectonic') {
    args = [texPath, '--outdir', fileDir];
  } else {
    args = ['-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', '-output-directory', fileDir, fileBase];
  }

  return new Promise((done) => {
    execFile(engine, args, {
      cwd: fileDir,
      timeout: COMPILE_TIMEOUT_MS,
      shell: false,
      env: {
        ...process.env,
        openin_any: 'p',
        openout_any: 'p',
        shell_escape: 'f',
      },
      maxBuffer: 10 * 1024 * 1024,
      killSignal: 'SIGKILL',
    }, (err, stdout, stderr) => {
      if (err) {
        if (err.killed) {
          return done({ ok: false, error: 'Compilation timed out (30s)', engine });
        }
        const combined = (stderr || '') + (stdout || '');
        const errorMatch = combined.match(/^!.*$/m);
        return done({ ok: false, error: errorMatch?.[0] || stderr || err.message, engine, log: combined });
      }
      const pdfPath = pathResolve(fileDir, fileBase + '.pdf');
      done({ ok: true, pdf: pdfPath, engine, output: stdout });
    });
  });
}
