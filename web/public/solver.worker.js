//
// solver.worker.js — runs the WebAssembly solver off the main thread.
//
// IDA* is a blocking search with no yield points, so running it on the main
// thread would freeze the page (and trip the browser's "unresponsive page"
// warning) for the length of the search. The worker owns the cube state; the
// page owns the 3D view and replays whatever moves come back.
//
// Two builds exist. The multithreaded one needs SharedArrayBuffer, which only
// exists on a cross-origin-isolated page; when isolation is unavailable we load
// the single-threaded build instead so the demo still works.
//

// Single-threaded by default. The page asks for the threaded build with ?mt=1
// only when the visitor opted in and the document is genuinely isolated, so a
// browser that cannot start a pthread pool never loads the build that breaks.
const MT = /[?&]mt=1/.test(self.location.search)
  && typeof crossOriginIsolated !== 'undefined'
  && crossOriginIsolated;

// Anything thrown at this level (a failed importScripts, a module that cannot
// instantiate) would otherwise kill the worker silently and leave the page
// waiting forever. Report it as a message the page can act on.
self.addEventListener('error', (e) => {
  self.postMessage({ fatal: true, error: `${e.message || 'worker error'} (${e.filename || '?'}:${e.lineno || 0})` });
});
self.addEventListener('unhandledrejection', (e) => {
  self.postMessage({ fatal: true, error: `unhandled rejection: ${(e.reason && e.reason.message) || e.reason}` });
});

const log = (stage) => self.postMessage({ progress: stage, threaded: MT });

try {
  log('loading ' + (MT ? 'multithreaded' : 'single-threaded') + ' module');
  importScripts(MT ? './solver-mt.js' : './solver.js');
} catch (err) {
  self.postMessage({ fatal: true, error: 'importScripts failed: ' + err.message });
}

let mod = null;
let threads = 1;

async function init(dbBytes) {
  log('instantiating WebAssembly' + (MT ? ' and starting thread pool' : ''));
  mod = await (MT ? createSolverMT() : createSolver());

  log('copying database into WebAssembly heap');

  // Copy straight into the module's heap and let PatternDatabase::fromMemory
  // take it from there. The previous route wrote the 48 MB through MEMFS and
  // read it back with a C++ ifstream, which meant holding the table twice and
  // pushing every byte through the emulated filesystem.
  const ptr = mod._malloc(dbBytes.byteLength);
  if (!ptr) throw new Error(`Could not allocate ${dbBytes.byteLength} bytes in the WASM heap`);

  let ok;
  try {
    mod.HEAPU8.set(dbBytes, ptr);
    log('loading pattern database');
    ok = mod.loadDatabaseFromMemory(ptr, dbBytes.byteLength);
  } finally {
    mod._free(ptr);
  }

  if (!ok) throw new Error('Database rejected by fromMemory() — wrong size?');

  threads = MT ? mod.maxThreads() : 1;
  log('ready');
  return { threaded: MT, threads };
}

self.onmessage = async (e) => {
  const { id, type, payload } = e.data;

  const reply = (data) => self.postMessage({ id, ok: true, ...data });
  const fail = (err) => self.postMessage({ id, ok: false, error: String((err && err.message) || err) });

  try {
    switch (type) {
      case 'init':
        reply(await init(payload));
        break;

      case 'scramble':
        reply({ moves: mod.scramble(payload) });
        break;

      case 'solve': {
        // `payload.threads` of 1 forces the single-threaded path even on the
        // MT build, so the speedup can be compared like for like.
        const useThreads = Math.max(1, Math.min(payload?.threads || 1, threads));
        const lowerBound = mod.heuristic();

        const t0 = performance.now();
        const moves = useThreads > 1 ? mod.solveMT(useThreads) : mod.solve();
        const ms = performance.now() - t0;

        if (moves === '!') throw new Error('Search failed');
        reply({ moves, ms, lowerBound, threadsUsed: useThreads });
        break;
      }

      case 'reset':
        mod.resetCube();
        reply({});
        break;

      case 'applyMoves':
        if (!mod.applyMoves(payload)) throw new Error('Invalid move notation');
        reply({ solved: mod.isSolved() });
        break;

      case 'facelets':
        reply({ facelets: mod.getFacelets() });
        break;

      default:
        throw new Error('Unknown command: ' + type);
    }
  } catch (err) {
    fail(err);
  }
};
