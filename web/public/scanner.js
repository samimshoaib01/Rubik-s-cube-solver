//
// scanner.js — read a physical cube through the webcam.
//
// Ports the calibrated strategy from Scanner/CubeScanner.cpp rather than the
// fixed-threshold one. Fixed HSV bands assume the lighting the thresholds were
// tuned under; classifyByFace instead takes the six centre stickers as ground
// truth, since their colours are known in advance, and labels every other
// sticker by nearest match in Lab space. Warm bulbs, daylight and a dim room
// shift all 54 samples together, so matching against samples from the same
// scan survives what fixed bands do not.
//

// Capture order: spin the cube left three times, then tilt to the two
// remaining faces. Each entry records which sticker colour the centre must be,
// which is what makes the calibration possible.
const FACES = [
  { id: 'F', letter: 'R', name: 'red',    hint: 'White face up, red towards the camera' },
  { id: 'R', letter: 'B', name: 'blue',   hint: 'Turn the cube left — blue towards you, white still up' },
  { id: 'B', letter: 'O', name: 'orange', hint: 'Turn left again — orange towards you, white still up' },
  { id: 'L', letter: 'G', name: 'green',  hint: 'Turn left again — green towards you, white still up' },
  { id: 'U', letter: 'W', name: 'white',  hint: 'Back to red in front, then tilt forward — white towards you, orange edge at the top' },
  { id: 'D', letter: 'Y', name: 'yellow', hint: 'Tilt the other way — yellow towards you, red edge at the top' },
];

// The solver wants faces in this order, each read row-major.
const OUTPUT_ORDER = ['U', 'L', 'F', 'R', 'B', 'D'];

const SWATCH = { W: '#f0f0f0', G: '#19a74a', R: '#d93025', B: '#2176d9', O: '#e8761a', Y: '#f2d12e' };
const CYCLE = ['W', 'G', 'R', 'B', 'O', 'Y'];

// ── Colour space ─────────────────────────────────────────────────────────────

// sRGB -> CIE Lab (D65). Lab is roughly perceptually uniform, so Euclidean
// distance in it tracks "looks like the same colour" far better than RGB does.
function rgbToLab(r, g, b) {
  let [rr, gg, bb] = [r / 255, g / 255, b / 255].map((v) =>
    v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92
  );

  const x = (rr * 0.4124 + gg * 0.3576 + bb * 0.1805) / 0.95047;
  const y = (rr * 0.2126 + gg * 0.7152 + bb * 0.0722) / 1.0;
  const z = (rr * 0.0193 + gg * 0.1192 + bb * 0.9505) / 1.08883;

  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function labDist(a, b) {
  const dL = a[0] - b[0], da = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(dL * dL + da * da + db * db);
}

// ── Sampling ─────────────────────────────────────────────────────────────────

// Averages a patch at the centre of each of the 9 cells, which rejects the
// noise and specular highlights a single pixel would pick up.
function sampleFace(video) {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) throw new Error('Camera is not ready yet');

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, w, h);

  // Same guide square the overlay draws.
  const side = Math.min(w, h) * 0.6;
  const x0 = (w - side) / 2;
  const y0 = (h - side) / 2;
  const cell = side / 3;
  const patch = Math.max(4, Math.floor(cell * 0.4));

  const out = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const cx = x0 + cell * (col + 0.5);
      const cy = y0 + cell * (row + 0.5);
      const px = Math.floor(cx - patch / 2);
      const py = Math.floor(cy - patch / 2);

      const { data } = ctx.getImageData(px, py, patch, patch);
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
      const n = data.length / 4;
      out.push([Math.round(r / n), Math.round(g / n), Math.round(b / n)]);
    }
  }
  return out;
}

// Each sticker takes the letter of whichever centre it is closest to. The
// centres are known colours, so this calibrates to the current lighting.
function classifyAll(captured) {
  const centres = FACES.map((f) => ({
    letter: f.letter,
    lab: rgbToLab(...captured[f.id][4]),
  }));

  const result = {};
  for (const face of FACES) {
    result[face.id] = captured[face.id].map((rgb) => {
      const lab = rgbToLab(...rgb);
      let best = centres[0], bestD = Infinity;
      for (const c of centres) {
        const d = labDist(lab, c.lab);
        if (d < bestD) { bestD = d; best = c; }
      }
      return best.letter;
    });
  }
  return result;
}

// ── UI ───────────────────────────────────────────────────────────────────────

export function openScanner() {
  return new Promise((resolve) => {
    const captured = {};
    let step = 0;
    let stream = null;
    let labels = null;

    const root = document.createElement('div');
    root.className = 'scan-overlay';
    root.innerHTML = `
      <div class="scan-panel">
        <div class="scan-head">
          <strong id="scan-title">Scan your cube</strong>
          <button class="scan-x" id="scan-close" title="Close">&times;</button>
        </div>
        <div class="scan-body">
          <div class="scan-view">
            <video id="scan-video" playsinline muted></video>
            <div class="scan-grid" id="scan-grid"></div>
          </div>
          <div class="scan-side">
            <p class="scan-hint" id="scan-hint"></p>
            <div class="scan-progress" id="scan-progress"></div>
            <div id="scan-review" class="scan-review" hidden></div>
            <p class="scan-error" id="scan-error" hidden></p>
          </div>
        </div>
        <div class="scan-foot">
          <button id="scan-back">Back</button>
          <button class="primary" id="scan-action">Capture face</button>
        </div>
      </div>`;
    document.body.appendChild(root);

    const $ = (id) => root.querySelector('#' + id);
    const video = $('scan-video');
    const grid = $('scan-grid');
    const hint = $('scan-hint');
    const title = $('scan-title');
    const progress = $('scan-progress');
    const review = $('scan-review');
    const errorBox = $('scan-error');
    const actionBtn = $('scan-action');
    const backBtn = $('scan-back');

    for (let i = 0; i < 9; i++) grid.appendChild(document.createElement('i'));

    function showError(msg) {
      errorBox.hidden = !msg;
      errorBox.textContent = msg || '';
    }

    function onKey(e) { if (e.key === 'Escape') finish(null); }

    function finish(value) {
      document.removeEventListener('keydown', onKey);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      root.remove();
      resolve(value);
    }
    document.addEventListener('keydown', onKey);

    function renderProgress() {
      progress.innerHTML = FACES.map((f, i) => {
        const state = captured[f.id] ? 'done' : i === step ? 'now' : '';
        return `<span class="${state}" style="--c:${SWATCH[f.letter]}">${f.id}</span>`;
      }).join('');
    }

    function renderStep() {
      showError('');
      review.hidden = true;
      grid.hidden = false;
      const face = FACES[step];
      title.textContent = `Scan your cube — face ${step + 1} of 6`;
      hint.innerHTML = `Show the <b style="color:${SWATCH[face.letter]}">${face.name}</b> face.<br>${face.hint}`;
      actionBtn.textContent = captured[face.id] ? 'Recapture face' : 'Capture face';
      backBtn.disabled = step === 0;
      renderProgress();
    }

    // Final pass: show what was read and let a misread sticker be corrected by
    // clicking it. Lighting fools any classifier eventually, and retaking the
    // whole scan over one sticker would be miserable.
    function renderReview(labelled) {
      labels = labelled;
      grid.hidden = true;
      review.hidden = false;
      title.textContent = 'Check the colours';
      hint.textContent = 'Click any sticker that was read wrong to cycle its colour.';
      actionBtn.textContent = 'Solve this cube';
      backBtn.disabled = false;
      renderProgress();

      review.innerHTML = FACES.map((f) => `
        <div class="scan-face">
          <span>${f.id}</span>
          <div class="scan-mini" data-face="${f.id}">
            ${labels[f.id].map((l, i) =>
              `<i data-face="${f.id}" data-i="${i}" style="background:${SWATCH[l]}"></i>`).join('')}
          </div>
        </div>`).join('');

      review.querySelectorAll('i[data-face]').forEach((el) => {
        el.addEventListener('click', () => {
          const f = el.dataset.face, i = Number(el.dataset.i);
          if (i === 4) return; // centres define the calibration; leave them be
          const next = CYCLE[(CYCLE.indexOf(labels[f][i]) + 1) % CYCLE.length];
          labels[f][i] = next;
          el.style.background = SWATCH[next];
          showError('');
        });
      });
    }

    actionBtn.addEventListener('click', () => {
      if (labels) {
        // Assemble in the order the solver expects.
        finish(OUTPUT_ORDER.map((id) => labels[id].join('')).join(''));
        return;
      }
      try {
        captured[FACES[step].id] = sampleFace(video);
      } catch (err) {
        showError(err.message);
        return;
      }
      if (step < FACES.length - 1) {
        step++;
        renderStep();
      } else {
        renderReview(classifyAll(captured));
      }
    });

    backBtn.addEventListener('click', () => {
      if (labels) { labels = null; renderStep(); return; }
      if (step > 0) { step--; renderStep(); }
    });

    $('scan-close').addEventListener('click', () => finish(null));

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false })
      .then((s) => {
        stream = s;
        video.srcObject = s;
        return video.play();
      })
      .then(renderStep)
      .catch((err) => {
        grid.hidden = true;
        title.textContent = 'Camera unavailable';
        hint.textContent = '';
        actionBtn.disabled = true;
        backBtn.disabled = true;
        showError(
          err && err.name === 'NotAllowedError'
            ? 'Camera access was denied. Allow it in the address bar, then try again.'
            : `Could not open the camera: ${(err && err.message) || err}`
        );
      });
  });
}

// Exposed for the solver's own error reporting.
export { OUTPUT_ORDER };
