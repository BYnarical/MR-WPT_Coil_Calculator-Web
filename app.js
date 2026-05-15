// CoilCalc web renderer — Pyodide backend.

// ----------------------------------------------------------- ferrite schemas
const FERRITE_FIELDS = {
  none:    [],
  sheet:   [['thickness_mm','Thickness (mm)',1.5,0.1], ['area_mm2','Area (mm², 0 = match coil)',0,1], ['gap_mm','Gap coil→plate (mm)',0.5,0.1]],
  rod:     [['length_mm','Length (mm)',50,1], ['diameter_mm','Diameter (mm)',10,0.5]],
  bars:    [['n_bars','Number of bars',4,1], ['length_mm','Bar length (mm)',100,1], ['width_mm','Bar width (mm)',25,1], ['thickness_mm','Bar thickness (mm)',5,0.5], ['spacing_mm','Spacing (mm)',5,1]],
  potcore: [['OD_mm','Outer Ø (mm)',40,1], ['ID_mm','Inner Ø (mm)',15,1], ['height_mm','Height (mm)',12,0.5], ['air_gap_mm','Air gap (mm)',0.5,0.1]],
  ring:    [['OD_mm','Outer Ø (mm)',30,1], ['ID_mm','Inner Ø (mm)',20,1], ['height_mm','Height (mm)',10,0.5], ['air_gap_mm','Air gap (mm)',0.0,0.05]],
  custom:  [['l_mult_at_dc','L gain × at DC',2.0,0.1], ['rolloff_f','μ_r rolloff f (Hz)',1e6,1000], ['core_volume','Core volume (m³)',1e-6,1e-9], ['eff_path','Effective path (m)',0.05,0.005]],
};
const FERRITE_CUSTOM_MAT_FIELDS = [
  ['mu_r0','μ_r at DC',2000,1],
  ['f_cutoff','μ_r cutoff f (Hz)',1e6,1000],
  ['Bsat_T','B_sat (T)',0.4,0.01],
  ['rho','ρ (Ω·m)',5.0,0.1],
  ['k_sm','Steinmetz k',1.8e-3,1e-5],
  ['alpha_sm','Steinmetz α',1.5,0.05],
  ['beta_sm','Steinmetz β',2.6,0.05],
];
let FERRITE_PRESETS_CACHE = null;

// Mirrors electron/renderer/app.js but routes compute() through the Pyodide
// bridge instead of Electron IPC.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { init as initPyodide, compute as pyCompute } from './pyodide-bridge.js?v=5';

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
const GEOM_FIELDS = {
  circular:    [['N','Turns',10,1], ['Do','Outer Ø (mm)',100,1], ['Di','Inner Ø (mm)',60,1], ['w','Conductor w (mm)',1,0.1], ['s','Turn gap s (mm)',0.5,0.1]],
  square:      [['N','Turns',10,1], ['Do','Outer Ø (mm)',100,1], ['Di','Inner Ø (mm)',60,1], ['w','Conductor w (mm)',1,0.1], ['s','Turn gap s (mm)',0.5,0.1]],
  hexagonal:   [['N','Turns',10,1], ['Do','Outer Ø (mm)',100,1], ['Di','Inner Ø (mm)',60,1], ['w','Conductor w (mm)',1,0.1], ['s','Turn gap s (mm)',0.5,0.1]],
  octagonal:   [['N','Turns',10,1], ['Do','Outer Ø (mm)',100,1], ['Di','Inner Ø (mm)',60,1], ['w','Conductor w (mm)',1,0.1], ['s','Turn gap s (mm)',0.5,0.1]],
  rectangular: [['N','Turns',5,1], ['a','Outer a (mm)',200,1], ['b','Outer b (mm)',150,1], ['Di_a','Inner a (mm)',80,1], ['Di_b','Inner b (mm)',40,1], ['w','Conductor w (mm)',1,0.1], ['s','Turn gap s (mm)',0.5,0.1]],
  solenoid:    [['N','Turns',25,1], ['D','Diameter D (mm)',30,1], ['length','Length (mm)',50,1], ['w','Wire Ø (mm)',1,0.1]],
  conical:     [['N','Turns',10,1], ['r_top','Top r (mm)',20,1], ['r_bot','Bottom r (mm)',40,1], ['length','Length (mm)',30,1], ['w','Wire Ø (mm)',1,0.1]],
  multilayer:  [['N','Turns/layer',8,1], ['Do','Outer Ø (mm)',60,1], ['Di','Inner Ø (mm)',20,1], ['n_layers','Layers',2,1], ['layer_spacing','Layer spacing (mm)',1.6,0.1], ['w','Conductor w (mm)',1,0.1], ['s','Turn gap s (mm)',0.5,0.1]],
  DD:          [['N','Turns/D',5,1], ['a','Outer a (mm)',200,1], ['b','Outer b (mm)',150,1], ['Di_a','Inner a (mm)',80,1], ['Di_b','Inner b (mm)',40,1], ['gap_between','D-gap (mm)',5,1], ['w','Conductor w (mm)',1,0.1], ['s','Turn gap s (mm)',0.5,0.1]],
};
const COND_FIELDS = {
  litz:  [['strand_d','Strand Ø (µm)',71,1], ['n_strands','# strands',420,1]],
  round: [['d','Wire Ø (mm)',1.0,0.05]],
  foil:  [['thickness','Thickness (µm)',50,1], ['width','Width (mm)',10,0.5]],
  pcb:   [['width','Trace W (mm)',2,0.05], ['thickness','Cu thickness (µm)',35,1], ['pitch','Pitch (mm)',2.5,0.05]],
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

function buildForm(container, schema, kind, onChange) {
  const values = {};
  function render(k) {
    container.innerHTML = '';
    schema[k].forEach(([key, label, def, step]) => {
      values[key] = def;
      const row = document.createElement('div');
      row.className = 'field';
      const lbl = document.createElement('label'); lbl.textContent = label;
      const inp = document.createElement('input');
      inp.type = 'number'; inp.step = step; inp.value = def;
      inp.addEventListener('input', () => {
        const v = parseFloat(inp.value);
        if (!Number.isFinite(v)) return;
        values[key] = v;
        onChange();
      });
      row.appendChild(lbl); row.appendChild(inp);
      container.appendChild(row);
    });
  }
  render(kind);
  return { get: () => ({ ...values }), setKind: (k) => { render(k); onChange(); } };
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

  function render() {
    container.innerHTML = '';
    const kind = shapeSel.value;
    if (kind === 'none') {
      matSel.parentElement.style.display = 'none';
      return;
    }
    matSel.parentElement.style.display = '';
    // per-shape fields
    (FERRITE_FIELDS[kind] || []).forEach(([key, label, def, step]) => {
      values.params[key] = def;
      const row = document.createElement('div');
      row.className = 'field';
      row.innerHTML = `<label>${label}</label><input type="number" step="${step}" value="${def}">`;
      row.querySelector('input').addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        if (Number.isFinite(v)) { values.params[key] = v; onChange(); }
      });
      container.appendChild(row);
    });
    // custom material params (when material === 'custom')
    if (matSel.value === 'custom') {
      const hdr = document.createElement('div');
      hdr.className = 'fineprint';
      hdr.style.marginTop = '8px';
      hdr.textContent = 'Custom material parameters:';
      container.appendChild(hdr);
      FERRITE_CUSTOM_MAT_FIELDS.forEach(([key, label, def, step]) => {
        values.customMat[key] = values.customMat[key] ?? def;
        const row = document.createElement('div');
        row.className = 'field';
        row.innerHTML = `<label>${label}</label><input type="number" step="${step}" value="${values.customMat[key]}">`;
        row.querySelector('input').addEventListener('input', (e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) { values.customMat[key] = v; onChange(); }
        });
        container.appendChild(row);
      });
    }
  }

  // Populate material dropdown when presets arrive
  fetchPresets().then((p) => {
    const cur = matSel.value;
    matSel.innerHTML = '<option value="custom">Custom (set params below)</option>'
      + (p.materials || []).map((m) => `<option value="${m.name}">${m.name}</option>`).join('');
    if (cur) matSel.value = cur;
    render();
  });

  shapeSel.addEventListener('change', () => { render(); onChange(); });
  matSel.addEventListener('change',   () => { render(); onChange(); });
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
  const objects = new THREE.Group();
  scene.add(objects);

  function setPaths(paths) {
    while (objects.children.length) {
      const o = objects.children[0]; objects.remove(o);
      o.geometry?.dispose(); o.material?.dispose();
    }
    paths.forEach((pts, idx) => {
      const positions = new Float32Array(pts.length * 3);
      let maxR = 0;
      pts.forEach((p, i) => {
        positions[3*i] = p[0]; positions[3*i+1] = p[1]; positions[3*i+2] = p[2];
        const r = Math.hypot(p[0], p[1], p[2]); if (r > maxR) maxR = r;
      });
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.LineBasicMaterial({
        color: PALETTE[idx % PALETTE.length], linewidth: 2 });
      objects.add(new THREE.Line(geom, mat));
      if (maxR > 0) {
        const d = Math.max(maxR * 3, 80);
        camera.position.set(d, -d, d * 0.8);
        camera.lookAt(0, 0, 0); controls.update();
      }
    });
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
  return { setPaths, resize };
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
  document.getElementById('s-freq').addEventListener('input', refresh);

  // Ferrite form
  const ferrShape = document.getElementById('s-ferr-kind');
  const ferrMat   = document.getElementById('s-ferr-mat');
  const ferrFields = document.getElementById('s-ferr-fields');
  const ferrForm = buildFerriteForm(ferrShape, ferrMat, ferrFields, refresh);

  const scene = makeThreeScene(document.getElementById('s-canvas'));

  async function run() {
    if (!pyReady) return;
    const geom = { kind: geomSel.value, ...geomForm.get() };
    const cond = { kind: condSel.value, ...condForm.get() };
    const ferrite = ferrForm.get();   // may be null
    const f = parseFloat(document.getElementById('s-freq').value) * 1e6;
    const params = { geom, conductor: cond, f };
    if (ferrite) params.ferrite = ferrite;
    const r = await callApi('single_coil', params);
    if (!r) return;
    document.getElementById('s-L').textContent   = r.L_uH.toFixed(3) + '  µH';
    document.getElementById('s-Rdc').textContent = r.Rdc_mOhm.toFixed(3) + '  mΩ';
    document.getElementById('s-Rac').textContent = r.Rac_mOhm.toFixed(3) + '  mΩ';
    document.getElementById('s-Q').textContent   = r.Q.toFixed(0);
    document.getElementById('s-SRF').textContent = r.SRF_MHz != null
      ? r.SRF_MHz.toFixed(2) + '  MHz' : '—';
    document.getElementById('s-len').textContent = r.wire_length_m.toFixed(3) + '  m';
    scene.setPaths([r.path]);

    const ferrPanel = document.getElementById('s-ferr-results');
    if (r.ferrite) {
      ferrPanel.style.display = '';
      document.getElementById('s-ferr-name').textContent  = r.ferrite.material;
      document.getElementById('s-ferr-mur').textContent   = r.ferrite.mu_r_at_f.toFixed(1);
      document.getElementById('s-ferr-lmult').textContent = '× ' + r.ferrite.L_mult_total.toFixed(2);
      document.getElementById('s-ferr-coreR').textContent = r.ferrite.core_loss_R_mOhm.toFixed(3) + '  mΩ';
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
  const rxOverride = () => {
    const fields = document.getElementById('p-rx-fields');
    const inputs = fields.querySelectorAll('input');
    const defs = { N: 8, Do: 60, Di: 30 };
    GEOM_FIELDS[rxSel.value].forEach(([key], i) => {
      if (key in defs) {
        inputs[i].value = defs[key];
        inputs[i].dispatchEvent(new Event('input'));
      }
    });
  };
  rxOverride();

  const cndForm = buildForm(document.getElementById('p-cond-fields'),
                            COND_FIELDS, 'litz', refresh);
  txSel.addEventListener('change',  () => txForm.setKind(txSel.value));
  rxSel.addEventListener('change',  () => { rxForm.setKind(rxSel.value); rxOverride(); });
  cndSel.addEventListener('change', () => cndForm.setKind(cndSel.value));
  ['p-gap','p-lat','p-tilt','p-rload','p-vsource','p-freq'].forEach(
    (id) => document.getElementById(id).addEventListener('input', refresh));

  const chKgap   = makeChart(document.getElementById('chart-k-gap').getContext('2d'),  'gap (mm)',     'k');
  const chKlat   = makeChart(document.getElementById('chart-k-lat').getContext('2d'),  'lateral (mm)', 'k');
  const chEtaGap = makeChart(document.getElementById('chart-eta-gap').getContext('2d'),'gap (mm)',     'η');

  async function run() {
    if (!pyReady) return;
    const params = {
      tx: { kind: txSel.value, ...txForm.get() },
      rx: { kind: rxSel.value, ...rxForm.get() },
      conductor: { kind: cndSel.value, ...cndForm.get() },
      alignment: {
        gap:     parseFloat(document.getElementById('p-gap').value),
        lateral: parseFloat(document.getElementById('p-lat').value),
        tilt:    parseFloat(document.getElementById('p-tilt').value),
      },
      system: {
        R_load:   parseFloat(document.getElementById('p-rload').value),
        V_source: parseFloat(document.getElementById('p-vsource').value),
        f:        parseFloat(document.getElementById('p-freq').value) * 1e6,
      },
    };
    const r = await callApi('pair', params);
    if (!r) return;
    document.getElementById('p-M').textContent     = r.M_uH.toFixed(3) + '  µH';
    document.getElementById('p-k').textContent     = r.k.toFixed(4);
    document.getElementById('p-eta').textContent   = (r.eta * 100).toFixed(2) + ' %';
    document.getElementById('p-vout').textContent  = r.V_out.toFixed(2) + ' V';
    document.getElementById('p-pin').textContent   = r.P_in_mW.toFixed(2)   + ' mW';
    document.getElementById('p-pload').textContent = r.P_load_mW.toFixed(2) + ' mW';
    updateChart(chKgap,   r.sweeps.k_vs_gap.x,     r.sweeps.k_vs_gap.y);
    updateChart(chKlat,   r.sweeps.k_vs_lateral.x, r.sweeps.k_vs_lateral.y);
    updateChart(chEtaGap, r.sweeps.eta_vs_gap.x,   r.sweeps.eta_vs_gap.y);
  }
  PANEL_INIT_HOOKS.push(run);
})();

// ----------------------------------------------------------- SYSTEM
(function setupSystem() {
  let rows = [
    { name: 'Tx (driver)', x: 0,  y: 0, z: 0,  Do: 100, Di: 60, N: 10 },
    { name: 'Relay',       x: 0,  y: 0, z: 30, Do: 100, Di: 60, N: 10 },
    { name: 'Rx (load)',   x: 0,  y: 0, z: 60, Do: 60,  Di: 30, N: 8  },
  ];
  let selected = new Set();
  const tbody = document.getElementById('sys-rows');

  function rebuild() {
    tbody.innerHTML = '';
    rows.forEach((r, idx) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="row-check"><input type="checkbox" data-i="${idx}"></td>
        <td><input data-k="name"></td>
        <td><input data-k="x" type="number" step="1"></td>
        <td><input data-k="y" type="number" step="1"></td>
        <td><input data-k="z" type="number" step="1"></td>
        <td><input data-k="Do" type="number" step="1"></td>
        <td><input data-k="Di" type="number" step="1"></td>
        <td><input data-k="N"  type="number" step="1"></td>`;
      tr.querySelectorAll('input').forEach((inp) => {
        if (inp.type === 'checkbox') {
          inp.addEventListener('change', () => {
            if (inp.checked) selected.add(idx); else selected.delete(idx);
          });
        } else {
          const key = inp.dataset.k;
          inp.value = r[key];
          inp.addEventListener('input', () => {
            r[key] = (inp.type === 'number') ? parseFloat(inp.value) : inp.value;
            refresh();
          });
        }
      });
      tbody.appendChild(tr);
    });
  }
  rebuild();

  document.getElementById('sys-add').addEventListener('click', () => {
    const zMax = rows.reduce((m, r) => Math.max(m, r.z || 0), 0);
    rows.push({ name: `Coil ${rows.length+1}`, x: 0, y: 0, z: zMax + 30,
                Do: 80, Di: 40, N: 10 });
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

  const refresh = debounce(async () => {
    if (!pyReady) return;
    const params = {
      coils: rows,
      conductor: { kind: 'litz', strand_d: 71, n_strands: 420 },
      R_load:   parseFloat(document.getElementById('sys-rload').value),
      V_source: parseFloat(document.getElementById('sys-vsource').value),
      f:        parseFloat(document.getElementById('sys-freq').value) * 1e6,
    };
    const r = await callApi('system', params);
    if (!r) return;
    document.getElementById('sys-eta').textContent   = (r.eta * 100).toFixed(2) + ' %';
    document.getElementById('sys-vout').textContent  = r.V_out.toFixed(3) + ' V';
    document.getElementById('sys-gain').textContent  = r.gain.toFixed(3);
    document.getElementById('sys-pin').textContent   = r.P_in_mW.toFixed(3) + ' mW';
    document.getElementById('sys-pload').textContent = r.P_load_mW.toFixed(3) + ' mW';
    scene.setPaths(r.paths);
    drawHeatmap(r.K);
  }, 300);

  ['sys-freq','sys-rload','sys-vsource'].forEach((id) =>
    document.getElementById(id).addEventListener('input', refresh));

  PANEL_INIT_HOOKS.push(refresh);
})();
