import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { openScanner } from './scanner.js';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL        = './cornerDepth8V1.bin.gz';
const DB_RAW_BYTES  = 50089921;   // 100,179,840 nibbles + 1
const DB_GZ_BYTES   = 19451052;   // fallback when Content-Length is absent
const IDB_NAME      = 'rubiks-solver';
const IDB_KEY       = 'cornerDB.gz';
const MOVE_MS       = 190;        // per-quarter-turn animation

// Colour scheme matches the C++ model: U=White L=Green F=Red R=Blue B=Orange D=Yellow
const FACE_COLORS = {
  px: 0x2176d9, // RIGHT  — blue
  nx: 0x19a74a, // LEFT   — green
  py: 0xf0f0f0, // UP     — white
  ny: 0xf2d12e, // DOWN   — yellow
  pz: 0xd93025, // FRONT  — red
  nz: 0xe8761a, // BACK   — orange
};
const PLASTIC = 0x12151a;

// Axis, layer and turn direction for each face. `dir` is the sign of a
// clockwise quarter turn viewed from outside that face: by the right-hand rule
// that is a negative rotation about a positive axis.
const FACE_SPEC = {
  U: { axis: 'y', layer:  1, dir: -1 },
  D: { axis: 'y', layer: -1, dir:  1 },
  R: { axis: 'x', layer:  1, dir: -1 },
  L: { axis: 'x', layer: -1, dir:  1 },
  F: { axis: 'z', layer:  1, dir: -1 },
  B: { axis: 'z', layer: -1, dir:  1 },
};

// ─────────────────────────────────────────────────────────────────────────────
// DOM
// ─────────────────────────────────────────────────────────────────────────────

// Threads are opt-in. The single-threaded build works in every browser with
// no service worker, no cross-origin isolation and no reload, so that is what
// a first-time visitor gets. Turning threads on needs COOP/COEP, which only
// take effect on a fresh document load, hence the stored preference + reload.
const THREAD_PREF_KEY = 'rubiks:threads';

function wantsThreads() {
  try { return localStorage.getItem(THREAD_PREF_KEY) === '1'; } catch { return false; }
}
function setWantsThreads(on) {
  try { on ? localStorage.setItem(THREAD_PREF_KEY, '1') : localStorage.removeItem(THREAD_PREF_KEY); } catch { /* ignore */ }
}

const $ = (id) => document.getElementById(id);
const stage     = $('stage');
const loader    = $('loader');
const loadTitle = $('load-title');
const loadBar   = $('load-bar');
const loadDetail= $('load-detail');
const movesBox  = $('moves');
const btnScramble = $('btn-scramble');
const btnSolve    = $('btn-solve');
const btnReset    = $('btn-reset');
const depthInput  = $('depth');
const depthVal    = $('depth-val');
const btnCancel   = $('btn-cancel');
const btnScan     = $('btn-scan');
const useMT       = $('use-mt');
const mtWrap      = $('mt-wrap');
const mtLabel     = $('mt-label');

// ─────────────────────────────────────────────────────────────────────────────
// Scene
// ─────────────────────────────────────────────────────────────────────────────

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e1116);

const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
camera.position.set(4.6, 4.2, 5.6);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
stage.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.09;
controls.enablePan = false;
controls.minDistance = 5;
controls.maxDistance = 14;

scene.add(new THREE.AmbientLight(0xffffff, 0.72));
const key = new THREE.DirectionalLight(0xffffff, 0.85);
key.position.set(5, 8, 6);
scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.35);
fill.position.set(-6, -3, -5);
scene.add(fill);

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}
addEventListener('resize', resize);

// ── Build 27 cubies ──────────────────────────────────────────────────────────

const cubies = [];

function buildCube() {
  for (const c of cubies) {
    scene.remove(c);
    c.geometry.dispose();
    c.material.forEach((m) => m.dispose());
  }
  cubies.length = 0;

  // Rounded-ish cubie: a slightly inset box reads better than a hard cube.
  const geom = new THREE.BoxGeometry(0.94, 0.94, 0.94);

  for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
      for (let z = -1; z <= 1; z++) {
        if (!x && !y && !z) continue; // the invisible core

        // BoxGeometry material order: +X, -X, +Y, -Y, +Z, -Z
        const faces = [
          x ===  1 ? FACE_COLORS.px : PLASTIC,
          x === -1 ? FACE_COLORS.nx : PLASTIC,
          y ===  1 ? FACE_COLORS.py : PLASTIC,
          y === -1 ? FACE_COLORS.ny : PLASTIC,
          z ===  1 ? FACE_COLORS.pz : PLASTIC,
          z === -1 ? FACE_COLORS.nz : PLASTIC,
        ];
        const mats = faces.map((col) => new THREE.MeshLambertMaterial({ color: col }));

        const cubie = new THREE.Mesh(geom, mats);
        cubie.position.set(x, y, z);
        scene.add(cubie);
        cubies.push(cubie);
      }
    }
  }
}

// ── Layer rotation ───────────────────────────────────────────────────────────

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

function rotateLayer(face, quarterTurns) {
  const spec = FACE_SPEC[face];
  const pivot = new THREE.Group();
  scene.add(pivot);

  // Snap first: float drift would make the layer test miss a cubie.
  const layer = cubies.filter(
    (c) => Math.round(c.position[spec.axis]) === spec.layer
  );
  for (const c of layer) pivot.attach(c);

  const target = spec.dir * quarterTurns * (Math.PI / 2);
  const duration = MOVE_MS * Math.abs(quarterTurns);
  const start = performance.now();

  return new Promise((resolve) => {
    (function step(now) {
      const t = Math.min((now - start) / duration, 1);
      pivot.rotation[spec.axis] = target * easeInOut(t);

      if (t < 1) {
        requestAnimationFrame(step);
        return;
      }

      // Re-parent to the scene keeping the world transform, then snap the grid
      // position so repeated turns don't accumulate floating-point error.
      pivot.updateMatrixWorld(true);
      for (const c of layer) {
        scene.attach(c);
        c.position.set(
          Math.round(c.position.x),
          Math.round(c.position.y),
          Math.round(c.position.z)
        );
      }
      scene.remove(pivot);
      resolve();
    })(start);
  });
}

// "R'" -> {face:'R', turns:-1}, "U2" -> {face:'U', turns:2}
function parseMove(tok) {
  const face = tok[0];
  if (!FACE_SPEC[face]) return null;
  const suffix = tok.slice(1);
  const turns = suffix === "'" ? -1 : suffix === '2' ? 2 : 1;
  return { face, turns };
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker RPC
// ─────────────────────────────────────────────────────────────────────────────

// IDA* blocks inside WebAssembly with no yield point, so there is no flag we
// could set to interrupt it from outside. Terminating the worker is the only
// reliable cancel — hence the spawn/respawn dance here. Re-initialising reads
// the database back from IndexedDB, so a cancel costs a second, not a download.
let worker = null;
let nextId = 1;
let pending = new Map();
let caps = { threaded: false, threads: 1 };

function failAllPending(err) {
  const waiting = pending;
  pending = new Map();
  waiting.forEach(({ reject }) => reject(err));
}

function spawnWorker({ threaded = false } = {}) {
  if (worker) worker.terminate();
  failAllPending(new Error('cancelled'));

  // Single-threaded unless explicitly asked for, so a browser that cannot
  // start a pthread pool never sees the build that would break it.
  worker = new Worker('./solver.worker.js' + (threaded ? '?mt=1' : ''));

  worker.onmessage = (e) => {
    const { id, ok, error, fatal, progress, ...rest } = e.data;

    // Out-of-band messages: progress notes and worker-level crashes.
    if (progress) {
      console.info('[solver]', progress);
      // A late message must not paint over an error already on screen — that
      // is how the real reason got replaced by "Ready..." last time.
      if (!errorShown) {
        loadDetail.textContent = progress[0].toUpperCase() + progress.slice(1) + '…';
      }
      return;
    }
    if (fatal) {
      console.error('[solver] fatal:', error);
      failAllPending(new Error(error));
      return;
    }

    const slot = pending.get(id);
    if (!slot) return;
    pending.delete(id);
    ok ? slot.resolve(rest) : slot.reject(new Error(error));
  };

  // A worker that dies outright fires here; without this the page would wait
  // on a promise that can never settle, which is exactly how the first
  // threaded build appeared to hang at "Starting solver...".
  worker.onerror = (e) => {
    const where = e.filename ? ` (${e.filename}:${e.lineno})` : '';
    console.error('[solver] worker error:', e.message, where);
    failAllPending(new Error((e.message || 'worker crashed') + where));
  };
  worker.onmessageerror = () => failAllPending(new Error('worker message could not be deserialised'));
}

function call(type, payload, transfer) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload }, transfer || []);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Database loading (IndexedDB cache + streamed download)
// ─────────────────────────────────────────────────────────────────────────────

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  try {
    const db = await openIDB();
    return await new Promise((resolve, reject) => {
      const req = db.transaction('files').objectStore('files').get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null; // private browsing, blocked storage, quota — just re-download
  }
}

async function idbPut(key, value) {
  try {
    const db = await openIDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* caching is best-effort */ }
}

async function downloadCompressedDB(onProgress) {
  const resp = await fetch(DB_URL);
  if (!resp.ok) throw new Error(`Database fetch failed (HTTP ${resp.status})`);

  const total = Number(resp.headers.get('Content-Length')) || DB_GZ_BYTES;
  const reader = resp.body.getReader();
  const chunks = [];
  let loaded = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(Math.min(loaded / total, 1));
  }

  const out = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

async function gunzip(bytes) {
  // Some hosts serve .gz with Content-Encoding: gzip, in which case the browser
  // has already decompressed it for us. Check the magic number rather than
  // assuming either way.
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!isGzip) return bytes;

  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser lacks DecompressionStream; try a recent Chrome, Safari or Firefox.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Fetches (or reads from cache) and hands the database to the current worker.
// Safe to call again after a respawn.
async function loadDatabase() {
  let gz = await idbGet(IDB_KEY);

  if (gz) {
    loadTitle.textContent = 'Loading solver…';
    loadDetail.textContent = 'Reading the pattern database from your browser cache.';
    loadBar.style.width = '55%';
    gz = new Uint8Array(gz);
  } else {
    loadTitle.textContent = 'Downloading pattern database…';
    gz = await downloadCompressedDB((frac) => {
      loadBar.style.width = (frac * 90).toFixed(1) + '%';
      loadTitle.textContent = `Downloading pattern database… ${Math.round(frac * 100)}%`;
    });
    idbPut(IDB_KEY, gz.buffer.slice(0)); // fire-and-forget
  }

  loadTitle.textContent = 'Unpacking database…';
  loadBar.style.width = '94%';
  await new Promise((r) => setTimeout(r, 16)); // let the DOM paint

  const raw = await gunzip(gz);
  if (raw.byteLength !== DB_RAW_BYTES) {
    throw new Error(`Database is ${raw.byteLength} bytes, expected ${DB_RAW_BYTES}`);
  }

  loadTitle.textContent = 'Starting solver…';
  caps = await initWithFallback(raw, bootThreaded);
  loadBar.style.width = '100%';
  return caps;
}

// Starting the WebAssembly thread pool is the one step with no timeout of its
// own: if a pthread worker fails to come up, module instantiation simply never
// resolves. Rather than hang, give it a deadline and fall back to the
// single-threaded build, which has no pool to wait on.
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    }),
  ]);
}

let threadFailure = null;

async function initWithFallback(raw, triedThreaded) {
  // Only pay for the backup copy when there is a retry that could need it.
  const backup = triedThreaded ? raw.slice() : null;

  try {
    return await withTimeout(call('init', raw, [raw.buffer]), 90000,
                             triedThreaded ? 'Threaded startup' : 'Startup');
  } catch (err) {
    if (!triedThreaded) throw err;

    // Threads were requested but could not start — Chrome, for instance,
    // throws an opaque Event out of the pthread pool. Forget the preference
    // so the next load does not repeat it, and carry on single-threaded.
    console.warn('[solver] threaded start failed, falling back:', err.message);
    threadFailure = err.message;
    setWantsThreads(false);

    loadTitle.textContent = 'Retrying single-threaded…';
    loadDetail.textContent = 'Could not start the thread pool; using the portable build.';

    spawnWorker({ threaded: false });
    return withTimeout(call('init', backup, [backup.buffer]), 90000, 'Startup');
  }
}

// Rebuilds the worker from scratch and reloads the database from cache.
async function restartWorker() {
  spawnWorker({ threaded: caps.threaded });
  const gz = await idbGet(IDB_KEY);
  if (!gz) { // cache miss — fall back to the full path
    caps = await loadDatabase();
    return;
  }
  const raw = await gunzip(new Uint8Array(gz));
  caps = await withTimeout(call('init', raw, [raw.buffer]), 90000, 'Restart');
}

function describeThreads() {
  useMT.disabled = false;
  mtWrap.classList.remove('off');
  useMT.checked = caps.threaded;

  if (caps.threaded) {
    mtLabel.textContent = `Using all ${caps.threads} CPU cores`;
    mtWrap.title = '';
  } else if (threadFailure) {
    mtLabel.textContent = 'Multi-core unavailable in this browser';
    mtWrap.title = threadFailure;
    useMT.disabled = true;
    mtWrap.classList.add('off');

    // Show the actual reason rather than hiding it in a tooltip.
    let why = document.getElementById('mt-why');
    if (!why) {
      why = document.createElement('p');
      why.id = 'mt-why';
      why.className = 'note';
      why.style.cssText = 'margin:6px 0 0; color:#d29922';
      mtWrap.insertAdjacentElement('afterend', why);
    }
    why.textContent = threadFailure;
  } else {
    mtLabel.textContent = 'Use all CPU cores (reloads once)';
    mtWrap.title = 'WebAssembly threads need cross-origin isolation, which only applies on a fresh page load.';
  }
}

useMT.addEventListener('change', () => {
  setWantsThreads(useMT.checked);
  // Isolation headers are applied by a service worker at document load, so the
  // switch can only take effect on the next one.
  location.reload();
});

// A scanned cube has no move history to replay, so the 3D view is painted
// directly from the 54 stickers instead. Face order U L F R B D, row-major,
// matching getFacelets().
const LETTER_COLOR = {
  W: 0xf0f0f0, G: 0x19a74a, R: 0xd93025, B: 0x2176d9, O: 0xe8761a, Y: 0xf2d12e,
};

// (face, row, col) -> which cubie, and which of its six materials to paint.
// Material order on a BoxGeometry is +X, -X, +Y, -Y, +Z, -Z.
const FACE_GEOMETRY = {
  U: { mat: 2, pos: (r, c) => [c - 1, 1, r - 1] },
  D: { mat: 3, pos: (r, c) => [c - 1, -1, 1 - r] },
  F: { mat: 4, pos: (r, c) => [c - 1, 1 - r, 1] },
  B: { mat: 5, pos: (r, c) => [1 - c, 1 - r, -1] },
  L: { mat: 1, pos: (r, c) => [-1, 1 - r, c - 1] },
  R: { mat: 0, pos: (r, c) => [1, 1 - r, 1 - c] },
};

function paintFromFacelets(facelets) {
  buildCube(); // back to a known grid position before addressing cubies

  const byPos = new Map();
  for (const c of cubies) byPos.set(`${c.position.x},${c.position.y},${c.position.z}`, c);

  const order = ['U', 'L', 'F', 'R', 'B', 'D'];
  order.forEach((face, fi) => {
    const { mat, pos } = FACE_GEOMETRY[face];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const letter = facelets[fi * 9 + r * 3 + c];
        const cubie = byPos.get(pos(r, c).join(','));
        if (cubie) cubie.material[mat].color.setHex(LETTER_COLOR[letter] ?? 0x12151a);
      }
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// UI
// ─────────────────────────────────────────────────────────────────────────────

let busy = false;

function setBusy(state) {
  busy = state;
  btnScramble.disabled = state;
  btnSolve.disabled = state;
  btnReset.disabled = state;
  btnScan.disabled = state;
}

function setStat(id, text, ok) {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle('ok', !!ok);
}

function renderMoves(tokens, activeIndex) {
  if (!tokens.length) {
    movesBox.innerHTML = '<span class="empty">Already solved.</span>';
    return;
  }
  movesBox.innerHTML = tokens
    .map((m, i) => {
      const cls = i === activeIndex ? 'now' : i < activeIndex ? 'done' : '';
      return `<span class="${cls}">${m}</span>`;
    })
    .join(' ');
}

async function playSequence(tokens, { highlight }) {
  for (let i = 0; i < tokens.length; i++) {
    if (highlight) renderMoves(tokens, i);
    const mv = parseMove(tokens[i]);
    if (!mv) continue;
    await rotateLayer(mv.face, mv.turns);
  }
  if (highlight) renderMoves(tokens, tokens.length);
}

let errorShown = false;

function showError(message) {
  errorShown = true;
  console.error('[solver] giving up:', message);
  loader.classList.remove('hidden');
  loadTitle.textContent = 'Something went wrong';
  loadDetail.textContent = message;
  loadBar.parentElement.style.display = 'none';
}

depthInput.addEventListener('input', () => {
  depthVal.textContent = depthInput.value;
  const deep = Number(depthInput.value) >= 10;
  depthVal.style.color = deep ? '#d29922' : '';
  depthVal.title = deep ? 'Deep scrambles can take a while single-threaded' : '';
});

btnScramble.addEventListener('click', async () => {
  setBusy(true);
  try {
    // Restart from solved every time. Scrambling on top of a scramble
    // compounds the depth, and search cost grows ~15x per move — two 8-move
    // scrambles is a 16-move cube, which this heuristic cannot finish.
    await call('reset');
    buildCube();

    const { moves } = await call('scramble', Number(depthInput.value));
    const tokens = moves.split(' ').filter(Boolean);
    movesBox.innerHTML = '<span class="empty">Scrambled — ready to solve.</span>';
    setStat('st-time', '—');
    setStat('st-len', '—');
    setStat('st-lb', '—');
    setStat('st-state', 'scrambled');
    await playSequence(tokens, { highlight: false });
  } catch (err) {
    showError(err.message);
  }
  setBusy(false);
});

btnSolve.addEventListener('click', async () => {
  setBusy(true);
  btnCancel.style.display = 'block';
  movesBox.innerHTML = '<span class="empty">Searching…</span>';
  setStat('st-state', 'searching');

  const threads = useMT.checked && caps.threaded ? caps.threads : 1;

  try {
    const { moves, ms, lowerBound, threadsUsed } = await call('solve', { threads });
    const tokens = moves.split(' ').filter(Boolean);

    setStat('st-time', ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(2)} s`);
    setStat('st-len', `${tokens.length} moves`);
    setStat('st-lb', `${lowerBound} moves`);
    setStat('st-threads', String(threadsUsed));

    btnCancel.style.display = 'none';
    await playSequence(tokens, { highlight: true });
    setStat('st-state', 'solved', true);
  } catch (err) {
    btnCancel.style.display = 'none';
    if (err.message === 'cancelled') {
      movesBox.innerHTML = '<span class="empty">Search cancelled.</span>';
      setStat('st-state', 'cancelled');
    } else {
      movesBox.innerHTML = '<span class="empty">Search failed.</span>';
      setStat('st-state', 'error');
      console.error(err);
    }
  }
  setBusy(false);
});

btnScan.addEventListener('click', async () => {
  const facelets = await openScanner();
  if (!facelets) return; // cancelled

  setBusy(true);
  try {
    const { error } = await call('setFacelets', facelets);
    if (error) {
      // The C++ side validates colour counts, centres and letters, and says
      // exactly what was wrong — surface that rather than a generic failure.
      movesBox.innerHTML = `<span class="empty">Scan rejected: ${error}</span>`;
      setStat('st-state', 'invalid scan');
    } else {
      paintFromFacelets(facelets);
      movesBox.innerHTML = '<span class="empty">Cube scanned — ready to solve.</span>';
      setStat('st-time', '—');
      setStat('st-len', '—');
      setStat('st-lb', '—');
      setStat('st-threads', '—');
      setStat('st-state', 'scanned');
    }
  } catch (err) {
    movesBox.innerHTML = `<span class="empty">Scan failed: ${err.message}</span>`;
    setStat('st-state', 'error');
  }
  setBusy(false);
});

btnCancel.addEventListener('click', async () => {
  btnCancel.disabled = true;
  btnCancel.textContent = 'Stopping…';

  // Killing the worker rejects the in-flight solve, which the handler above
  // reports as 'cancelled'. The cube in the worker is gone with it, so the
  // scramble on screen no longer matches — reset both to stay honest.
  await restartWorker();
  buildCube();

  movesBox.innerHTML = '<span class="empty">Search cancelled — cube reset.</span>';
  setStat('st-state', 'solved');
  setStat('st-threads', '—');

  btnCancel.disabled = false;
  btnCancel.textContent = 'Cancel search';
  btnCancel.style.display = 'none';
  setBusy(false);
});

btnReset.addEventListener('click', async () => {
  setBusy(true);
  await call('reset');
  buildCube();
  movesBox.innerHTML = '<span class="empty">Scramble the cube to begin.</span>';
  setStat('st-time', '—');
  setStat('st-len', '—');
  setStat('st-lb', '—');
  setStat('st-threads', '—');
  setStat('st-state', 'solved');
  setBusy(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────

buildCube();
resize();

// Decide the mode before anything starts. Cross-origin isolation is only
// requested when the visitor has opted in, so the default path stays plain:
// no service worker, no extra reload, no COEP restrictions on the page.
const bootThreaded = wantsThreads() && self.crossOriginIsolated === true;

if (wantsThreads() && !self.crossOriginIsolated) {
  // Opted in but not yet isolated — install the shim, which reloads once and
  // brings the page back cross-origin isolated.
  const tag = document.createElement('script');
  tag.src = './coi-serviceworker.js';
  document.head.appendChild(tag);
}

spawnWorker({ threaded: bootThreaded });

(function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
})();

loadDatabase()
  .then(() => {
    describeThreads();
    loader.classList.add('hidden');
    setBusy(false);
  })
  .catch((err) => {
    console.error(err);
    showError(err.message);
  });
