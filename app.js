// CoilCalc web renderer — Pyodide backend.

// ----------------------------------------------------------- settings (units)
const SETTINGS_DEFAULTS = {
  freq_unit:   'kHz',
  length_unit: 'mm',
  L_unit:      'µH',
  R_unit:      'mΩ',
  P_unit:      'mW',
};
const TO_SI = {
  freq:   { 'Hz': 1, 'kHz': 1e3, 'MHz': 1e6, 'GHz': 1e9 },
  length: { 'mm': 1, 'cm': 10, 'm': 1000, 'in': 25.4 }, // → mm (web_api uses mm)
  L:      { 'nH': 1e-9, 'µH': 1e-6, 'mH': 1e-3, 'H': 1 },
  R:      { 'µΩ': 1e-6, 'mΩ': 1e-3, 'Ω': 1, 'kΩ': 1e3 },
  P:      { 'µW': 1e-6, 'mW': 1e-3, 'W': 1, 'kW': 1e3 },
};
let SETTINGS = { ...SETTINGS_DEFAULTS };
try {
  const stored = JSON.parse(localStorage.getItem('coilcalc.settings') || '{}');
  SETTINGS = { ...SETTINGS_DEFAULTS, ...stored };
} catch (_e) {}
const SETTINGS_LISTENERS = [];
function onSettingsChange(cb) { SETTINGS_LISTENERS.push(cb); }
function setSetting(key, value) {
  SETTINGS[key] = value;
  try { localStorage.setItem('coilcalc.settings', JSON.stringify(SETTINGS)); } catch (_) {}
  SETTINGS_LISTENERS.forEach((cb) => { try { cb(); } catch (_) {} });
}
function unitOf(category) { return SETTINGS[`${category}_unit`]; }
function fromUnit(category, value, unit = null) {
  return Number(value) * TO_SI[category][unit || unitOf(category)];
}
function toUnit(category, si_value, unit = null) {
  return si_value / TO_SI[category][unit || unitOf(category)];
}
/** Format an SI value as "1.234 unit" auto-decimal-scaled per the user's
 *  preferred unit. category ∈ freq / length / L / R / P. */
function fmt(category, si_value, decimals = 3) {
  if (si_value == null || !Number.isFinite(si_value)) return '—';
  const v = toUnit(category, si_value);
  // Pick decimals so we don't show 0.000 for tiny values:
  let d = decimals;
  if (Math.abs(v) >= 100) d = Math.max(0, decimals - 1);
  if (Math.abs(v) >= 1000) d = Math.max(0, decimals - 2);
  return `${v.toFixed(d)} ${unitOf(category)}`;
}


// ----------------------------------------------------------- ferrite schemas
// Same field-tuple format as GEOM_FIELDS: [key, label, step, kind].
// Most ferrite linear-dimension fields use 'L' so they scale with length_unit.
// Area / Volume / dimensionless fields use 'misc' with the unit baked into the
// label (we don't try to unit-convert mm²/m³).
const FERRITE_FIELDS = {
  none:    [],
  sheet:   [['thickness_mm','Thickness',0.1,'L'], ['area_mm2','Area (mm², 0=match coil)',1,'misc'], ['gap_mm','Gap coil→plate',0.1,'L']],
  rod:     [['length_mm','Length',1,'L'], ['diameter_mm','Diameter',0.5,'L']],
  bars:    [['n_bars','Number of bars',1,'cnt'], ['length_mm','Bar length',1,'L'], ['width_mm','Bar width',1,'L'], ['thickness_mm','Bar thickness',0.5,'L'], ['spacing_mm','Spacing',1,'L']],
  potcore: [['OD_mm','Outer Ø',1,'L'], ['ID_mm','Inner Ø',1,'L'], ['height_mm','Height',0.5,'L'], ['air_gap_mm','Air gap',0.1,'L']],
  ring:    [['OD_mm','Outer Ø',1,'L'], ['ID_mm','Inner Ø',1,'L'], ['height_mm','Height',0.5,'L'], ['air_gap_mm','Air gap',0.05,'L']],
  custom:  [['l_mult_at_dc','L gain × at DC',0.1,'cnt'], ['rolloff_f','μ_r rolloff f (Hz)',1000,'misc'], ['core_volume','Core volume (m³)',1e-9,'misc'], ['eff_path','Effective path (m)',0.005,'misc']],
};
const FERRITE_CUSTOM_MAT_FIELDS = [
  ['mu_r0','μ_r at DC',1,'cnt'],
  ['f_cutoff','μ_r cutoff f (Hz)',1000,'misc'],
  ['Bsat_T','B_sat (T)',0.01,'misc'],
  ['rho','ρ (Ω·m)',0.1,'misc'],
  ['k_sm','Steinmetz k',1e-5,'misc'],
  ['alpha_sm','Steinmetz α',0.05,'cnt'],
  ['beta_sm','Steinmetz β',0.05,'cnt'],
];
let FERRITE_PRESETS_CACHE = null;

// Mirrors electron/renderer/app.js but routes compute() through the Pyodide
// bridge instead of Electron IPC.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { init as initPyodide, compute as pyCompute } from './pyodide-bridge.js?v=6';

// ----------------------------------------------------------- theme
const COL = {
  bg: 0x0f172a, divider: 0x334155,
  primary: 0x06b6d4, accent: 0xa78bfa, green: 0x34d399,
  orange: 0xf97316, pink: 0xec4899,
};
const PALETTE = [COL.primary, COL.accent, COL.green, COL.orange, COL.pink];

// ----------------------------------------------------------- tabs
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const id = btn.dataset.tab;
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    document.getElementById('tab-' + id).classList.add('active');
    window.dispatchEvent(new Event('resize'));
  });
});

// ----------------------------------------------------------- loading / status
const overlay     = document.getElementById('loading-overlay');
const loadingStep = document.getElementById('loading-step');
const statusDot   = document.getElementById('sidecar-status');
const statusText  = document.getElementById('sidecar-text');

function setStatusReady(version) {
  statusDot.className = 'status-dot ready';
  statusText.textContent = `Pyodide · CoilCalc ${version || ''}`.trim();
  overlay.classList.add('hidden');
  setTimeout(() => { overlay.style.display = 'none'; }, 600);
}

// ----------------------------------------------------------- API
async function callApi(method, params) {
  try {
    return await pyCompute(method, params);
  } catch (e) {
    console.error(method, e);
    return null;
  }
}
// Make the bridge reachable from helpers that don't see this module's scope.
window.coilcalcCompute = pyCompute;

// ----------------------------------------------------------- schema
// Field tuple: [key, label, step, kind]
// kind ∈ 'L'   → length input, scales with SETTINGS.length_unit (stored in mm)
//        'um'  → fixed µm input
//        'mm'  → fixed mm input (precision-sensitive items like pitch)
//        'cnt' → unitless count / turns
const GEOM_FIELDS = {
  circular:    [['N','Turns',1,'cnt'], ['Do','Outer Ø',1,'L'], ['Di','Inner Ø',1,'L'], ['w','Conductor w',0.1,'L'], ['s','Turn gap s',0.1,'L']],
  square:      [['N','Turns',1,'cnt'], ['Do','Outer Ø',1,'L'], ['Di','Inner Ø',1,'L'], ['w','Conductor w',0.1,'L'], ['s','Turn gap s',0.1,'L']],
  hexagonal:   [['N','Turns',1,'cnt'], ['Do','Outer Ø',1,'L'], ['Di','Inner Ø',1,'L'], ['w','Conductor w',0.1,'L'], ['s','Turn gap s',0.1,'L']],
  octagonal:   [['N','Turns',1,'cnt'], ['Do','Outer Ø',1,'L'], ['Di','Inner Ø',1,'L'], ['w','Conductor w',0.1,'L'], ['s','Turn gap s',0.1,'L']],
  rectangular: [['N','Turns',1,'cnt'], ['a','Outer a',1,'L'], ['b','Outer b',1,'L'], ['Di_a','Inner a',1,'L'], ['Di_b','Inner b',1,'L'], ['w','Conductor w',0.1,'L'], ['s','Turn gap s',0.1,'L']],
  solenoid:    [['N','Turns',1,'cnt'], ['D','Diameter D',1,'L'], ['length','Length',1,'L'], ['w','Wire Ø',0.1,'L']],
  conical:     [['N','Turns',1,'cnt'], ['r_top','Top r',1,'L'], ['r_bot','Bottom r',1,'L'], ['length','Length',1,'L'], ['w','Wire Ø',0.1,'L']],
  multilayer:  [['N','Turns/layer',1,'cnt'], ['Do','Outer Ø',1,'L'], ['Di','Inner Ø',1,'L'], ['n_layers','Layers',1,'cnt'], ['layer_spacing','Layer spacing',0.1,'L'], ['w','Conductor w',0.1,'L'], ['s','Turn gap s',0.1,'L']],
  DD:          [['N','Turns/D',1,'cnt'], ['a','Outer a',1,'L'], ['b','Outer b',1,'L'], ['Di_a','Inner a',1,'L'], ['Di_b','Inner b',1,'L'], ['gap_between','D-gap',1,'L'], ['w','Conductor w',0.1,'L'], ['s','Turn gap s',0.1,'L']],
};
const COND_FIELDS = {
  litz:  [['strand_d','Strand Ø',1,'um'], ['n_strands','# strands',1,'cnt']],
  round: [['d','Wire Ø',0.05,'L']],
  foil:  [['thickness','Thickness',1,'um'], ['width','Width',0.5,'L']],
  pcb:   [['width','Trace W',0.05,'L'], ['thickness','Cu thickness',1,'um'], ['pitch','Pitch',0.05,'L']],
};
const GEOM_OPTS = [
  ['circular','Circular spiral'], ['square','Square spiral'],
  ['hexagonal','Hexagonal spiral'], ['octagonal','Octagonal spiral'],
  ['rectangular','Rectangular spiral'], ['solenoid','Solenoid'],
  ['conical','Conical helix'], ['multilayer','Multi-layer planar'],
  ['DD','Double-D pad'],
];
const COND_OPTS = [
  ['litz','Litz wire'], ['round','Solid round wire'],
  ['foil','Copper foil/strip'], ['pcb','PCB trace'],
];

/** buildForm — generic schema-driven form.
 *
 *  Field tuple in schema: [key, label, step, kind]
 *  Storage: numbers are stored in *web_api* native units:
 *      'L'   → mm   (geometry / length)
 *      'um'  → µm
 *      'mm'  → mm
 *      'cnt' → as typed
 *  All fields start empty; values[key] is set only after the user enters a
 *  parseable number, and is deleted when the user clears the input. The form
 *  exposes ``isComplete()`` so callers can gate compute until every field is
 *  filled.
 */
function buildForm(container, schema, kind, onChange) {
  const values = {};
  const inputs = {};
  let currentKind = kind;

  function unitLabel(fieldKind) {
    if (fieldKind === 'L')   return unitOf('length');
    if (fieldKind === 'um')  return 'µm';
    if (fieldKind === 'mm')  return 'mm';
    return '';
  }

  function render(k, options = {}) {
    const keepValues = options.keepValues === true;
    currentKind = k;
    container.innerHTML = '';
    Object.keys(inputs).forEach((kk) => delete inputs[kk]);
    if (!keepValues) {
      Object.keys(values).forEach((kk) => delete values[kk]);
    } else {
      // Only keep values for fields that exist in the new schema; drop others.
      const allowed = new Set(schema[k].map(([key]) => key));
      Object.keys(values).forEach((kk) => { if (!allowed.has(kk)) delete values[kk]; });
    }
    schema[k].forEach(([key, label, step, fieldKind]) => {
      const row = document.createElement('div');
      row.className = 'field';
      const lbl = document.createElement('label');
      const u = unitLabel(fieldKind);
      lbl.textContent = u ? `${label} (${u})` : label;
      const inp = document.createElement('input');
      inp.type = 'number'; inp.step = step;
      // Pre-fill from stored SI value (converted to the current display unit).
      if (values[key] != null) {
        const display = (fieldKind === 'L')
          ? values[key] / TO_SI.length[unitOf('length')]
          : values[key];
        inp.value = String(display);
      } else {
        inp.value = '';
      }
      inp.placeholder = '—';
      inp.addEventListener('input', () => {
        const v = parseFloat(inp.value);
        if (!Number.isFinite(v)) {
          delete values[key];
        } else if (fieldKind === 'L') {
          values[key] = v * TO_SI.length[unitOf('length')]; // → mm
        } else {
          values[key] = v;
        }
        onChange();
      });
      row.appendChild(lbl); row.appendChild(inp);
      container.appendChild(row);
      inputs[key] = inp;
    });
  }
  render(kind);

  // Re-render labels when settings change; keep user-entered values.
  onSettingsChange(() => render(currentKind, { keepValues: true }));

  return {
    get: () => ({ ...values }),
    isComplete: () => schema[currentKind].every(([key]) => values[key] != null),
    setKind: (k) => { render(k); onChange(); },
  };
}
function populateSelect(sel, options) {
  sel.innerHTML = options.map((o) => `<option value="${o[0]}">${o[1]}</option>`).join('');
}

/**
 * buildFerriteForm — manages ferrite shape + material selectors.
 * shapeSel: <select> for kind
 * matSel:   <select> for material name (populated from presets + 'custom')
 * container:<div>   for the dynamic per-shape and per-material number fields
 *
 * Returns { get(): {kind, material, ...params}, refresh() } —
 * get() returns null if kind === 'none'.
 */
function buildFerriteForm(shapeSel, matSel, container, onChange) {
  const values = { params: {}, customMat: {} };

  async function fetchPresets() {
    if (FERRITE_PRESETS_CACHE) return FERRITE_PRESETS_CACHE;
    try {
      FERRITE_PRESETS_CACHE = await window.coilcalcCompute('ferrite_presets', {});
      return FERRITE_PRESETS_CACHE;
    } catch (_e) { return { materials: [] }; }
  }

  function unitLabel(fieldKind) {
    if (fieldKind === 'L') return unitOf('length');
    if (fieldKind === 'um') return 'µm';
    return '';
  }
  function storeValue(target, key, fieldKind, raw) {
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) { delete target[key]; return; }
    target[key] = (fieldKind === 'L')
      ? v * TO_SI.length[unitOf('length')] : v;
  }

  function appendNumberRow(label, fieldKind, step, target, key) {
    const u = unitLabel(fieldKind);
    const row = document.createElement('div');
    row.className = 'field';
    row.innerHTML = `<label>${u ? label + ' (' + u + ')' : label}</label>`
      + `<input type="number" step="${step}" placeholder="—">`;
    const inp = row.querySelector('input');
    // Pre-fill if a value already exists (SI → display unit).
    if (target[key] != null) {
      const display = (fieldKind === 'L')
        ? target[key] / TO_SI.length[unitOf('length')]
        : target[key];
      inp.value = String(display);
    }
    inp.addEventListener('input', (e) => {
      storeValue(target, key, fieldKind, e.target.value);
      onChange();
    });
    container.appendChild(row);
  }

  function render(options = {}) {
    const keepValues = options.keepValues === true;
    container.innerHTML = '';
    if (!keepValues) {
      Object.keys(values.params).forEach((k) => delete values.params[k]);
    } else {
      // Drop any keys not in the new shape's schema.
      const allowed = new Set((FERRITE_FIELDS[shapeSel.value] || []).map(([k]) => k));
      Object.keys(values.params).forEach((k) => { if (!allowed.has(k)) delete values.params[k]; });
    }
    const kind = shapeSel.value;
    if (kind === 'none') {
      matSel.parentElement.style.display = 'none';
      return;
    }
    matSel.parentElement.style.display = '';
    (FERRITE_FIELDS[kind] || []).forEach(([key, label, step, fieldKind]) =>
      appendNumberRow(label, fieldKind, step, values.params, key));
    if (matSel.value === 'custom') {
      const hdr = document.createElement('div');
      hdr.className = 'fineprint';
      hdr.style.marginTop = '8px';
      hdr.textContent = 'Custom material parameters:';
      container.appendChild(hdr);
      if (!keepValues) {
        Object.keys(values.customMat).forEach((k) => delete values.customMat[k]);
      }
      FERRITE_CUSTOM_MAT_FIELDS.forEach(([key, label, step, fieldKind]) =>
        appendNumberRow(label, fieldKind, step, values.customMat, key));
    }
  }

  fetchPresets().then((p) => {
    const cur = matSel.value;
    matSel.innerHTML = '<option value="custom">Custom (set params below)</option>'
      + (p.materials || []).map((m) => `<option value="${m.name}">${m.name}</option>`).join('');
    if (cur) matSel.value = cur;
    render();
  });

  shapeSel.addEventListener('change', () => { render(); onChange(); });
  matSel.addEventListener('change',   () => { render({ keepValues: true }); onChange(); });
  onSettingsChange(() => render({ keepValues: true }));
  render();

  return {
    get() {
      const kind = shapeSel.value;
      if (kind === 'none') return null;
      const out = { kind, ...values.params };
      const matName = matSel.value;
      if (matName === 'custom') {
        out.material = { name: 'Custom', family: 'MnZn', ...values.customMat };
      } else {
        out.material = matName;
      }
      return out;
    },
    /** Ferrite is "complete" if shape == none, or if every shape param +
     *  every custom-material param (if Custom) has been entered. */
    isComplete() {
      const kind = shapeSel.value;
      if (kind === 'none') return true;
      const shapeOk = (FERRITE_FIELDS[kind] || []).every(([k]) => values.params[k] != null);
      const matOk = matSel.value !== 'custom'
        || FERRITE_CUSTOM_MAT_FIELDS.every(([k]) => values.customMat[k] != null);
      return shapeOk && matOk;
    },
  };
}
function debounce(fn, ms = 200) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ----------------------------------------------------------- Three.js
function makeThreeScene(domEl) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COL.bg);
  const camera = new THREE.PerspectiveCamera(
    45, Math.max(domEl.clientWidth, 1) / Math.max(domEl.clientHeight, 1),
    0.1, 5000);
  camera.position.set(180, -180, 180);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(Math.max(domEl.clientWidth, 1), Math.max(domEl.clientHeight, 1));
  domEl.appendChild(renderer.domElement);

  const grid = new THREE.GridHelper(400, 20, COL.divider, COL.divider);
  grid.rotation.x = Math.PI / 2;
  scene.add(grid);
  scene.add(new THREE.AxesHelper(40));

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  const coilGroup = new THREE.Group();
  const ferriteGroup = new THREE.Group();
  scene.add(coilGroup);
  scene.add(ferriteGroup);

  function clearGroup(g) {
    while (g.children.length) {
      const o = g.children[0]; g.remove(o);
      o.geometry?.dispose(); o.material?.dispose();
    }
  }

  function setPaths(paths) {
    clearGroup(coilGroup);
    let maxR = 0;
    paths.forEach((pts, idx) => {
      const positions = new Float32Array(pts.length * 3);
      pts.forEach((p, i) => {
        positions[3*i] = p[0]; positions[3*i+1] = p[1]; positions[3*i+2] = p[2];
        const r = Math.hypot(p[0], p[1], p[2]); if (r > maxR) maxR = r;
      });
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.LineBasicMaterial({
        color: PALETTE[idx % PALETTE.length], linewidth: 2 });
      coilGroup.add(new THREE.Line(geom, mat));
    });
    if (maxR > 0) {
      const d = Math.max(maxR * 3, 80);
      camera.position.set(d, -d, d * 0.8);
      camera.lookAt(0, 0, 0); controls.update();
    }
  }

  /** setFerrite(spec) — draw a translucent mesh of the ferrite shape.
   * `spec` is the ferrite parameter object sent to the Python API (kind +
   * fields). Lengths in mm. Pass null to clear. */
  function setFerrite(spec) {
    clearGroup(ferriteGroup);
    if (!spec) return;
    const FERRITE_COLOR = 0xfb923c;     // amber-400
    const matFill = new THREE.MeshBasicMaterial({
      color: FERRITE_COLOR, transparent: true, opacity: 0.25, side: THREE.DoubleSide });
    const matEdge = new THREE.LineBasicMaterial({ color: FERRITE_COLOR });

    function addMeshAndEdges(geom, mesh_xform) {
      const mesh = new THREE.Mesh(geom, matFill.clone());
      mesh_xform?.(mesh);
      ferriteGroup.add(mesh);
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geom), matEdge.clone());
      mesh_xform?.(edges);
      ferriteGroup.add(edges);
    }

    const k = spec.kind;
    if (k === 'sheet') {
      // Plate: flat slab. Coil sits at z=0; plate at z=-gap..-(gap+thickness).
      // If area_mm2 is 0/unset, use the coil's outer extent (paths) as area.
      let side_mm = Math.sqrt(spec.area_mm2 || 0);
      if (!side_mm || side_mm < 5) {
        // fall back to twice the coil outer-radius extent
        let maxR = 0;
        coilGroup.children.forEach((line) => {
          const pos = line.geometry.attributes.position;
          for (let i = 0; i < pos.count; i++) {
            const r = Math.hypot(pos.getX(i), pos.getY(i));
            if (r > maxR) maxR = r;
          }
        });
        side_mm = Math.max(2 * maxR, 50);
      }
      const g = new THREE.BoxGeometry(side_mm, side_mm, Math.max(spec.thickness_mm, 0.1));
      addMeshAndEdges(g, (m) => {
        m.position.set(0, 0, -(spec.gap_mm || 0) - (spec.thickness_mm || 1) / 2);
      });
    } else if (k === 'rod') {
      const g = new THREE.CylinderGeometry(
        spec.diameter_mm / 2, spec.diameter_mm / 2, spec.length_mm, 32);
      addMeshAndEdges(g, (m) => {
        m.rotation.x = Math.PI / 2;       // align cylinder axis with Z
      });
    } else if (k === 'bars') {
      const n = Math.max(1, Math.round(spec.n_bars || 1));
      const total_w = n * spec.width_mm + (n - 1) * (spec.spacing_mm || 0);
      for (let i = 0; i < n; i++) {
        const x = -total_w / 2 + (i + 0.5) * spec.width_mm
                  + i * (spec.spacing_mm || 0);
        const g = new THREE.BoxGeometry(spec.width_mm, spec.length_mm,
                                        spec.thickness_mm);
        addMeshAndEdges(g, (m) => {
          m.position.set(x, 0, -(spec.gap_mm || 0) - spec.thickness_mm / 2);
        });
      }
    } else if (k === 'potcore') {
      // Outer cylindrical wall (ring shape) — approximate with two thin walls.
      const OD = spec.OD_mm / 2, ID = spec.ID_mm / 2, H = spec.height_mm;
      // Ring on top and bottom + outer wall: simplified to a cylindrical
      // "shell" using a torus-like RingGeometry extruded as two flat caps and
      // an outer cylinder.
      const outer = new THREE.CylinderGeometry(OD, OD, H, 48, 1, true);
      addMeshAndEdges(outer, (m) => { m.rotation.x = Math.PI / 2; });
      const cap = new THREE.RingGeometry(ID, OD, 48);
      addMeshAndEdges(cap, (m) => { m.position.z = H / 2; });
      addMeshAndEdges(cap, (m) => { m.position.z = -H / 2; });
    } else if (k === 'ring') {
      const OD = spec.OD_mm / 2, ID = spec.ID_mm / 2, H = spec.height_mm;
      // Approximate annular ring using TorusGeometry: tube radius = (OD-ID)/4
      const R_mean = (OD + ID) / 2;
      const t = (OD - ID) / 2;
      const g = new THREE.TorusGeometry(R_mean, t * 0.85, 16, 48);
      addMeshAndEdges(g);
    }
    // 'custom' has no geometric realisation we can plot.
  }

  function resize() {
    const w = Math.max(domEl.clientWidth, 1), h = Math.max(domEl.clientHeight, 1);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
  new ResizeObserver(resize).observe(domEl);
  (function animate() {
    requestAnimationFrame(animate); controls.update();
    renderer.render(scene, camera);
  })();
  return { setPaths, setFerrite, resize };
}

// ----------------------------------------------------------- Chart.js
const CHART_OPTS = (xLabel, yLabel) => ({
  responsive: true, maintainAspectRatio: false, animation: false,
  plugins: { legend: { display: false } },
  scales: {
    x: { title: { display: true, text: xLabel, color: '#94a3b8' },
         ticks: { color: '#94a3b8' }, grid: { color: '#1f2937' } },
    y: { title: { display: true, text: yLabel, color: '#94a3b8' },
         ticks: { color: '#94a3b8' }, grid: { color: '#1f2937' } },
  },
});
function makeChart(ctx, xLabel, yLabel) {
  return new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets: [{
      data: [], borderColor: '#06b6d4', backgroundColor: '#22d3ee',
      pointRadius: 3, tension: 0.2, borderWidth: 2,
    }] },
    options: CHART_OPTS(xLabel, yLabel),
  });
}
function updateChart(chart, xs, ys) {
  chart.data.labels = xs.map((v) => v.toFixed(1));
  chart.data.datasets[0].data = ys;
  chart.update();
}

// ----------------------------------------------------------- boot Pyodide
let pyReady = false;
const PANEL_INIT_HOOKS = [];

(async () => {
  try {
    await initPyodide(({ step, msg, version }) => {
      loadingStep.textContent = msg;
      if (step === 'ready') {
        pyReady = true;
        setStatusReady(version);
      }
    });
    // Defer one tick so all IIFE setups have finished registering their hooks.
    await new Promise((r) => setTimeout(r, 0));
    console.log('[CoilCalc] firing', PANEL_INIT_HOOKS.length, 'panel hooks');
    for (const h of PANEL_INIT_HOOKS) {
      try { await h(); }
      catch (e) { console.error('panel hook failed:', e); }
    }
  } catch (e) {
    loadingStep.textContent = 'Pyodide failed: ' + e.message;
    console.error(e);
  }
})();

// ----------------------------------------------------------- SINGLE COIL
(function setupSingle() {
  const geomSel = document.getElementById('s-geom-kind');
  const condSel = document.getElementById('s-cond-kind');
  populateSelect(geomSel, GEOM_OPTS);
  populateSelect(condSel, COND_OPTS);
  const refresh = debounce(run, 200);
  const geomForm = buildForm(document.getElementById('s-geom-fields'),
                             GEOM_FIELDS, 'circular', refresh);
  const condForm = buildForm(document.getElementById('s-cond-fields'),
                             COND_FIELDS, 'litz', refresh);
  geomSel.addEventListener('change', () => geomForm.setKind(geomSel.value));
  condSel.addEventListener('change', () => condForm.setKind(condSel.value));

  const freqInput = document.getElementById('s-freq');
  const freqLabel = document.getElementById('s-freq-label');
  let freqHz = null;     // SI-Hz, null when input is empty
  function refreshFreqLabel() {
    freqLabel.textContent = `f (${unitOf('freq')})`;
    // Re-display the stored SI value in the new unit.
    if (freqHz != null) {
      freqInput.value = String(freqHz / TO_SI.freq[unitOf('freq')]);
    }
  }
  refreshFreqLabel();
  onSettingsChange(refreshFreqLabel);
  freqInput.addEventListener('input', () => {
    const v = parseFloat(freqInput.value);
    freqHz = Number.isFinite(v) ? v * TO_SI.freq[unitOf('freq')] : null;
    refresh();
  });

  // Ferrite form
  const ferrShape  = document.getElementById('s-ferr-kind');
  const ferrMat    = document.getElementById('s-ferr-mat');
  const ferrFields = document.getElementById('s-ferr-fields');
  const ferrForm   = buildFerriteForm(ferrShape, ferrMat, ferrFields, refresh);

  const scene = makeThreeScene(document.getElementById('s-canvas'));
  // Repaint when display units change so existing numbers re-format.
  onSettingsChange(refresh);

  function clearMetrics() {
    for (const id of ['s-L','s-Rdc','s-Rac','s-Q','s-SRF','s-len']) {
      document.getElementById(id).textContent = '—';
    }
    document.getElementById('s-ferr-results').style.display = 'none';
    scene.setPaths([]);
    scene.setFerrite(null);
  }

  async function run() {
    if (!pyReady) return;
    const formsReady = geomForm.isComplete() && condForm.isComplete()
                     && ferrForm.isComplete() && freqHz != null;
    if (!formsReady) { clearMetrics(); return; }

    const geom    = { kind: geomSel.value, ...geomForm.get() };
    const cond    = { kind: condSel.value, ...condForm.get() };
    const ferrite = ferrForm.get();          // may be null
    const params  = { geom, conductor: cond, f: freqHz };
    if (ferrite) params.ferrite = ferrite;

    const r = await callApi('single_coil', params);
    if (!r) return;
    document.getElementById('s-L').textContent   = fmt('L',   r.L_uH * 1e-6);
    document.getElementById('s-Rdc').textContent = fmt('R',   r.Rdc_mOhm * 1e-3);
    document.getElementById('s-Rac').textContent = fmt('R',   r.Rac_mOhm * 1e-3);
    document.getElementById('s-Q').textContent   = r.Q.toFixed(0);
    document.getElementById('s-SRF').textContent = r.SRF_MHz != null
      ? fmt('freq', r.SRF_MHz * 1e6) : '—';
    document.getElementById('s-len').textContent = `${r.wire_length_m.toFixed(3)} m`;

    scene.setPaths([r.path]);
    scene.setFerrite(ferrite);

    const ferrPanel = document.getElementById('s-ferr-results');
    if (r.ferrite) {
      ferrPanel.style.display = '';
      document.getElementById('s-ferr-name').textContent  = r.ferrite.material;
      document.getElementById('s-ferr-mur').textContent   = r.ferrite.mu_r_at_f.toFixed(1);
      document.getElementById('s-ferr-lmult').textContent = '× ' + r.ferrite.L_mult_total.toFixed(2);
      document.getElementById('s-ferr-coreR').textContent = fmt('R', r.ferrite.core_loss_R_mOhm * 1e-3);
    } else {
      ferrPanel.style.display = 'none';
    }
  }
  PANEL_INIT_HOOKS.push(run);
})();

// ----------------------------------------------------------- PAIR
(function setupPair() {
  const txSel  = document.getElementById('p-tx-kind');
  const rxSel  = document.getElementById('p-rx-kind');
  const cndSel = document.getElementById('p-cond-kind');
  populateSelect(txSel,  GEOM_OPTS);
  populateSelect(rxSel,  GEOM_OPTS);
  populateSelect(cndSel, COND_OPTS);
  const refresh = debounce(run, 250);

  const txForm = buildForm(document.getElementById('p-tx-fields'),
                           GEOM_FIELDS, 'circular', refresh);
  const rxForm = buildForm(document.getElementById('p-rx-fields'),
                           GEOM_FIELDS, 'circular', refresh);
  const cndForm = buildForm(document.getElementById('p-cond-fields'),
                            COND_FIELDS, 'litz', refresh);
  txSel.addEventListener('change',  () => txForm.setKind(txSel.value));
  rxSel.addEventListener('change',  () => rxForm.setKind(rxSel.value));
  cndSel.addEventListener('change', () => cndForm.setKind(cndSel.value));
  ['p-gap','p-lat','p-tilt','p-rload','p-vsource','p-freq'].forEach(
    (id) => document.getElementById(id).addEventListener('input', refresh));
  function refreshPairLabels() {
    document.getElementById('p-gap-label').textContent = `Gap (${unitOf('length')})`;
    document.getElementById('p-lat-label').textContent = `Lateral (${unitOf('length')})`;
    document.getElementById('p-freq-label').textContent = `f (${unitOf('freq')})`;
  }
  refreshPairLabels();
  onSettingsChange(() => { refreshPairLabels(); refresh(); });

  const chKgap   = makeChart(document.getElementById('chart-k-gap').getContext('2d'),  'gap (mm)',     'k');
  const chKlat   = makeChart(document.getElementById('chart-k-lat').getContext('2d'),  'lateral (mm)', 'k');
  const chEtaGap = makeChart(document.getElementById('chart-eta-gap').getContext('2d'),'gap (mm)',     'η');

  function clearMetrics() {
    for (const id of ['p-M','p-k','p-eta','p-vout','p-pin','p-pload']) {
      document.getElementById(id).textContent = '—';
    }
  }
  function parseNum(id) {
    const v = parseFloat(document.getElementById(id).value);
    return Number.isFinite(v) ? v : null;
  }

  async function run() {
    if (!pyReady) return;
    const gap = parseNum('p-gap'), lat = parseNum('p-lat'), tilt = parseNum('p-tilt');
    const rload = parseNum('p-rload'), vsrc = parseNum('p-vsource'), fInUnit = parseNum('p-freq');
    const ready = txForm.isComplete() && rxForm.isComplete() && cndForm.isComplete()
                && gap != null && lat != null && tilt != null
                && rload != null && vsrc != null && fInUnit != null;
    if (!ready) { clearMetrics(); return; }
    const params = {
      tx: { kind: txSel.value, ...txForm.get() },
      rx: { kind: rxSel.value, ...rxForm.get() },
      conductor: { kind: cndSel.value, ...cndForm.get() },
      alignment: {
        gap:     gap * TO_SI.length[unitOf('length')],
        lateral: lat * TO_SI.length[unitOf('length')],
        tilt,
      },
      system: {
        R_load:   rload,
        V_source: vsrc,
        f:        fInUnit * TO_SI.freq[unitOf('freq')],
      },
    };
    const r = await callApi('pair', params);
    if (!r) return;
    document.getElementById('p-M').textContent     = fmt('L', r.M_uH * 1e-6);
    document.getElementById('p-k').textContent     = r.k.toFixed(4);
    document.getElementById('p-eta').textContent   = (r.eta * 100).toFixed(2) + ' %';
    document.getElementById('p-vout').textContent  = `${r.V_out.toFixed(2)} V`;
    document.getElementById('p-pin').textContent   = fmt('P', r.P_in_mW * 1e-3);
    document.getElementById('p-pload').textContent = fmt('P', r.P_load_mW * 1e-3);
    updateChart(chKgap,   r.sweeps.k_vs_gap.x,     r.sweeps.k_vs_gap.y);
    updateChart(chKlat,   r.sweeps.k_vs_lateral.x, r.sweeps.k_vs_lateral.y);
    updateChart(chEtaGap, r.sweeps.eta_vs_gap.x,   r.sweeps.eta_vs_gap.y);
  }
  PANEL_INIT_HOOKS.push(run);
})();

// ----------------------------------------------------------- SYSTEM
(function setupSystem() {
  // Rows start with just two blank-named coils so the table isn't empty (you
  // need at least 2 coils for a system). All numeric fields start empty —
  // compute is gated until they're all filled.
  let rows = [{ name: 'Coil 1' }, { name: 'Coil 2' }];
  let selected = new Set();
  const tbody = document.getElementById('sys-rows');

  function rebuild() {
    tbody.innerHTML = '';
    rows.forEach((r, idx) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="row-check"><input type="checkbox" data-i="${idx}"></td>
        <td><input data-k="name"></td>
        <td><input data-k="x" type="number" step="1" placeholder="—"></td>
        <td><input data-k="y" type="number" step="1" placeholder="—"></td>
        <td><input data-k="z" type="number" step="1" placeholder="—"></td>
        <td><input data-k="Do" type="number" step="1" placeholder="—"></td>
        <td><input data-k="Di" type="number" step="1" placeholder="—"></td>
        <td><input data-k="N"  type="number" step="1" placeholder="—"></td>`;
      tr.querySelectorAll('input').forEach((inp) => {
        if (inp.type === 'checkbox') {
          inp.addEventListener('change', () => {
            if (inp.checked) selected.add(idx); else selected.delete(idx);
          });
        } else {
          const key = inp.dataset.k;
          if (r[key] != null) inp.value = r[key];   // pre-fill if already typed
          inp.addEventListener('input', () => {
            const raw = inp.value;
            if (inp.type === 'number') {
              const v = parseFloat(raw);
              if (Number.isFinite(v)) r[key] = v;
              else delete r[key];
            } else {
              r[key] = raw;
            }
            refresh();
          });
        }
      });
      tbody.appendChild(tr);
    });
  }
  rebuild();

  document.getElementById('sys-add').addEventListener('click', () => {
    rows.push({ name: `Coil ${rows.length+1}` });
    selected.clear(); rebuild(); refresh();
  });
  document.getElementById('sys-rm').addEventListener('click', () => {
    if (rows.length - selected.size < 2) return;
    rows = rows.filter((_, i) => !selected.has(i));
    selected.clear(); rebuild(); refresh();
  });
  const scene    = makeThreeScene(document.getElementById('sys-canvas'));
  const heatWrap = document.getElementById('sys-heatmap');

  function drawHeatmap(K) {
    const N = K.length;
    heatWrap.style.setProperty('--N', N);
    heatWrap.innerHTML = '';
    let maxAbs = 0;
    K.forEach((row) => row.forEach((v) => { if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v); }));
    maxAbs = maxAbs || 1e-12;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const v = Math.abs(K[i][j]) / maxAbs;
        const cell = document.createElement('div');
        cell.className = 'heat-cell';
        const r = Math.round(255 * Math.pow(v, 0.5) * 0.95);
        const g = Math.round(180 + 70 * v);
        const b = Math.round(40 + 50 * (1 - v));
        cell.style.background = `rgb(${r},${g},${b})`;
        cell.textContent = K[i][j].toFixed(3);
        heatWrap.appendChild(cell);
      }
    }
  }

  function clearSysMetrics() {
    for (const id of ['sys-eta','sys-vout','sys-gain','sys-pin','sys-pload']) {
      document.getElementById(id).textContent = '—';
    }
    scene.setPaths([]);
    heatWrap.innerHTML = '';
  }
  const REQUIRED_ROW_KEYS = ['x', 'y', 'z', 'Do', 'Di', 'N'];

  const refresh = debounce(async () => {
    if (!pyReady) return;
    const rload = parseFloat(document.getElementById('sys-rload').value);
    const vsrc  = parseFloat(document.getElementById('sys-vsource').value);
    const fIn   = parseFloat(document.getElementById('sys-freq').value);
    const rowsOk = rows.every((r) => REQUIRED_ROW_KEYS.every((k) => r[k] != null));
    if (!Number.isFinite(rload) || !Number.isFinite(vsrc) || !Number.isFinite(fIn) || !rowsOk) {
      clearSysMetrics(); return;
    }
    // Convert geometry/positions from current length_unit → mm for API.
    const lf = TO_SI.length[unitOf('length')];
    const coils = rows.map((r) => ({
      name: r.name,
      x: r.x * lf, y: r.y * lf, z: r.z * lf,
      Do: r.Do * lf, Di: r.Di * lf, N: r.N,
    }));
    const params = {
      coils,
      conductor: { kind: 'litz', strand_d: 71, n_strands: 420 },
      R_load:   rload,
      V_source: vsrc,
      f:        fIn * TO_SI.freq[unitOf('freq')],
    };
    const r = await callApi('system', params);
    if (!r) return;
    document.getElementById('sys-eta').textContent   = (r.eta * 100).toFixed(2) + ' %';
    document.getElementById('sys-vout').textContent  = `${r.V_out.toFixed(3)} V`;
    document.getElementById('sys-gain').textContent  = r.gain.toFixed(3);
    document.getElementById('sys-pin').textContent   = fmt('P', r.P_in_mW * 1e-3);
    document.getElementById('sys-pload').textContent = fmt('P', r.P_load_mW * 1e-3);
    scene.setPaths(r.paths);
    drawHeatmap(r.K);
  }, 300);

  ['sys-freq','sys-rload','sys-vsource'].forEach((id) =>
    document.getElementById(id).addEventListener('input', refresh));

  function refreshSysLabels() {
    document.getElementById('sys-freq-label').textContent = `f (${unitOf('freq')})`;
  }
  refreshSysLabels();
  onSettingsChange(() => { refreshSysLabels(); refresh(); });

  PANEL_INIT_HOOKS.push(refresh);
})();

// ----------------------------------------------------------- SETTINGS
(function setupSettings() {
  const ids = {
    freq_unit:   'set-freq-unit',
    length_unit: 'set-length-unit',
    L_unit:      'set-L-unit',
    R_unit:      'set-R-unit',
    P_unit:      'set-P-unit',
  };
  for (const [key, id] of Object.entries(ids)) {
    const sel = document.getElementById(id);
    sel.value = SETTINGS[key];
    sel.addEventListener('change', () => setSetting(key, sel.value));
  }
  document.getElementById('set-reset').addEventListener('click', () => {
    for (const [key, id] of Object.entries(ids)) {
      const sel = document.getElementById(id);
      sel.value = SETTINGS_DEFAULTS[key];
      setSetting(key, SETTINGS_DEFAULTS[key]);
    }
  });
})();
