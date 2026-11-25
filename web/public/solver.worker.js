//
// solver.worker.js — runs the WebAssembly solver off the main thread.
//
// IDA* is a blocking search with no yield points, so running it on the main
// thread would freeze the page (and trip the browser's "unresponsive page"
// warning) for the length of the search. The worker owns the cube state; the
// page owns the 3D view and replays whatever moves come back.
//

importScripts('./solver.js');

let mod = null;

const DB_PATH = '/corner.db';

async function init(dbBytes) {
  mod = await createSolver();

  // Hand the database to the C++ side through Emscripten's in-memory FS, so
  // PatternDatabase::fromFile works unmodified from the desktop build.
  mod.FS.writeFile(DB_PATH, dbBytes);
  const ok = mod.loadDatabase(DB_PATH);

  // The database now lives inside the NibbleArray; drop the MEMFS copy so we
  // aren't holding 48 MB twice.
  try { mod.FS.unlink(DB_PATH); } catch (e) { /* non-fatal */ }

  if (!ok) throw new Error('Database rejected by loadDatabase()');
}

self.onmessage = async (e) => {
  const { id, type, payload } = e.data;

  const reply = (data) => self.postMessage({ id, ok: true, ...data });
  const fail = (err) => self.postMessage({ id, ok: false, error: String(err && err.message || err) });

  try {
    switch (type) {
      case 'init':
        await init(payload);
        reply({});
        break;

      case 'scramble':
        reply({ moves: mod.scramble(payload) });
        break;

      case 'solve': {
        const lowerBound = mod.heuristic();
        const t0 = performance.now();
        const moves = mod.solve();
        const ms = performance.now() - t0;
        if (moves === '!') throw new Error('Search failed');
        reply({ moves, ms, lowerBound });
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
