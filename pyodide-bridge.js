// Pyodide bridge — loads CPython + NumPy + SciPy + CoilCalc wheel in the
// browser. Exposes a single async compute(method, params) function that the
// renderer uses exactly like the Electron preload's window.api.compute.

const PYODIDE_BASE = 'https://cdn.jsdelivr.net/pyodide/v0.27.0/full/';

let pyodideReady = null;     // Promise<pyodide>
let pyodide = null;

export function status() {
  return {
    loaded: pyodide !== null,
  };
}

export async function init(onProgress = () => {}) {
  if (pyodideReady) return pyodideReady;
  pyodideReady = (async () => {
    onProgress({ step: 'loading-runtime',
                 msg: 'Loading Python runtime…' });
    // CDN-shipped Pyodide bootstrapper.
    const { loadPyodide } = await import(PYODIDE_BASE + 'pyodide.mjs');
    const py = await loadPyodide({ indexURL: PYODIDE_BASE });

    onProgress({ step: 'numpy-scipy',
                 msg: 'Installing NumPy + SciPy…' });
    await py.loadPackage(['numpy', 'scipy', 'micropip']);

    onProgress({ step: 'wheel',
                 msg: 'Installing CoilCalc wheel…' });
    const micropip = py.pyimport('micropip');
    // The wheel sits next to this file (same dir on the static server).
    const wheelUrl = new URL('./coilcalc-0.7.1-py3-none-any.whl',
                             import.meta.url).href;
    await micropip.install(wheelUrl);

    onProgress({ step: 'init-api',
                 msg: 'Initialising physics API…' });
    await py.runPythonAsync(`
import json
from coilcalc.web_api import dispatch
from coilcalc import __version__ as _coilcalc_version
`);
    pyodide = py;
    onProgress({ step: 'ready', msg: 'Ready', version: py.runPython('_coilcalc_version') });
    return py;
  })();
  return pyodideReady;
}

/**
 * compute(method, params) — call a CoilCalc web_api method (Python: coilcalc.web_api).
 * Mirrors the Electron `window.api.compute` signature exactly so app.js can
 * be reused with only the import line differing.
 */
export async function compute(method, params) {
  if (!pyodide) await init();
  // Inline params + method directly into the Python source so concurrent
  // compute() calls don't trample shared globals. JSON.stringify is escape-
  // safe for both layers (the outer turns a JS string into a Python literal
  // string; the inner gives the actual JSON payload).
  const paramsLit = JSON.stringify(JSON.stringify(params || {}));
  const methodLit = JSON.stringify(method);
  const code = `
import json
try:
    _result = dispatch(${methodLit}, json.loads(${paramsLit}))
    _out = json.dumps({"ok": True, "result": _result})
except Exception as exc:
    import traceback
    _out = json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}",
                       "trace": traceback.format_exc(limit=4)})
_out
`;
  const resultJson = await pyodide.runPythonAsync(code);
  const obj = JSON.parse(resultJson);
  if (!obj.ok) throw new Error(obj.error);
  return obj.result;
}
