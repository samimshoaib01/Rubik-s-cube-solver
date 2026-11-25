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

// OpenCV's scaling: H in 0..179, S and V in 0..255, so the thresholds below are
// the ones from Scanner/CubeScanner.cpp verbatim.
function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;

  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  h = Math.round(h * 30);            // 60 degrees -> OpenCV's half-degree scale
  if (h < 0) h += 180;

  return [h, max ? Math.round((d / max) * 255) : 0, max];
}

// classifyByHue from the desktop scanner. Used only for the live preview, so
// the grid can show what it is reading before anything is captured — the final
// answer still comes from the Lab calibration, which needs all six centres and
// so cannot run until the scan is complete.
function classifyByHue(rgb) {
  const [H, S, V] = rgbToHsv(rgb[0], rgb[1], rgb[2]);
  if (V > 180 && S < 100) return 'W';
  if (S < 60) return 'W';
  if (H < 8 || H > 170) return 'R';
  if (H < 16) return 'O';
  if (H < 42) return 'Y';
  if (H < 90) return 'G';
  return 'B';
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
    let preview = null;      // live sampling timer
    let mirrored = false;    // display only — never affects what is sampled
    let devices = [];
    let deviceId = null;

    const root = document.createElement('div');
    root.className = 'scan-overlay';
    root.innerHTML = `
      <div class="scan-panel">
        <div class="scan-head">
          <strong id="scan-title">Scan your cube</strong>
          <select id="scan-cam" class="scan-sel" hidden></select>
          <button class="scan-ghost" id="scan-mirror" title="Flip the preview horizontally">Mirror</button>
          <button class="scan-x" id="scan-close" title="Close">&times;</button>
        </div>
        <div class="scan-body">
          <div class="scan-view" id="scan-view">
            <video id="scan-video" playsinline muted></video>
            <div class="scan-grid" id="scan-grid"></div>
            <div class="scan-badge" id="scan-badge" hidden></div>
          </div>
          <div class="scan-side">
            <div class="scan-target" id="scan-target"></div>
            <p class="scan-hint" id="scan-hint"></p>
            <div class="scan-progress" id="scan-progress"></div>
            <div id="scan-review" class="scan-review" hidden></div>
            <p class="scan-error" id="scan-error" hidden></p>
          </div>
        </div>
        <div class="scan-foot">
          <span class="scan-tip" id="scan-tip">Fill the square with one face</span>
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
    const view = $('scan-view');
    const target = $('scan-target');
    const badge = $('scan-badge');
    const camSel = $('scan-cam');
    const mirrorBtn = $('scan-mirror');
    const tip = $('scan-tip');

    // Nine cells, each holding a dot that shows what that sticker is reading.
    const cells = [];
    for (let i = 0; i < 9; i++) {
      const cell = document.createElement('i');
      const dot = document.createElement('u');
      cell.appendChild(dot);
      grid.appendChild(cell);
      cells.push(dot);
    }

    function showError(msg) {
      errorBox.hidden = !msg;
      errorBox.textContent = msg || '';
    }

    function onKey(e) { if (e.key === 'Escape') finish(null); }

    function finish(value) {
      document.removeEventListener('keydown', onKey);
      stopPreview();
      if (stream) stream.getTracks().forEach((t) => t.stop());
      root.remove();
      resolve(value);
    }
    document.addEventListener('keydown', onKey);

    // Each captured face shows as a 3x3 thumbnail of what was read, so the
    // scan's progress is visible rather than just counted.
    function renderProgress() {
      progress.innerHTML = FACES.map((f, i) => {
        const done = captured[f.id];
        const state = done ? 'done' : i === step ? 'now' : '';
        const mini = done
          ? `<div class="scan-chipgrid">${done
              .map((rgb) => `<b style="background:${SWATCH[classifyByHue(rgb)]}"></b>`)
              .join('')}</div>`
          : `<div class="scan-chipgrid empty" style="--c:${SWATCH[f.letter]}"></div>`;
        return `<span class="${state}" title="${f.name}">${mini}<em>${f.id}</em></span>`;
      }).join('');
    }

    // Samples continuously so the grid shows what each cell is reading before
    // anything is committed. Without it the first feedback you get is after all
    // six faces are in, which is far too late to fix a lighting problem.
    function startPreview() {
      stopPreview();
      preview = setInterval(() => {
        if (labels || video.readyState < 2) return;
        let rgbs;
        try { rgbs = sampleFace(video); } catch { return; }

        rgbs.forEach((rgb, rawIdx) => {
          const row = Math.floor(rawIdx / 3), col = rawIdx % 3;
          // The overlay is flipped when the view is, so each dot stays on top
          // of the sticker it actually sampled.
          const shown = row * 3 + (mirrored ? 2 - col : col);
          const dot = cells[shown];
          dot.style.background = SWATCH[classifyByHue(rgb)];
          dot.style.opacity = '1';
        });
      }, 120);
    }

    function stopPreview() {
      if (preview) clearInterval(preview);
      preview = null;
    }

    function applyMirror() {
      video.style.transform = mirrored ? 'scaleX(-1)' : '';
      mirrorBtn.classList.toggle('on', mirrored);
    }

    mirrorBtn.addEventListener('click', () => { mirrored = !mirrored; applyMirror(); });

    function renderStep() {
      showError('');
      review.hidden = true;
      grid.hidden = false;
      const face = FACES[step];
      title.textContent = `Scan your cube — face ${step + 1} of 6`;
      target.innerHTML =
        `<span class="dot" style="background:${SWATCH[face.letter]}"></span>` +
        `<span><b>${face.name}</b> centre<br><small>${face.id} face</small></span>`;
      hint.textContent = face.hint;
      actionBtn.textContent = captured[face.id] ? 'Recapture' : 'Capture face';
      backBtn.disabled = step === 0;
      tip.textContent = 'Dots show what each sticker is reading right now';
      badge.hidden = true;
      renderProgress();
      startPreview();
    }

    // Brief confirmation so a capture does not feel like nothing happened.
    function flashCaptured(name) {
      badge.textContent = `${name} captured`;
      badge.hidden = false;
      setTimeout(() => { badge.hidden = true; }, 900);
    }

    // Final pass: show what was read and let a misread sticker be corrected by
    // clicking it. Lighting fools any classifier eventually, and retaking the
    // whole scan over one sticker would be miserable.
    function renderReview(labelled) {
      stopPreview();
      labels = labelled;
      grid.hidden = true;
      badge.hidden = true;
      tip.textContent = 'Centres are fixed — they define the colour calibration';
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
        flashCaptured(FACES[step].name);
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
      if (labels) { labels = null; startPreview(); renderStep(); return; }
      if (step > 0) { step--; renderStep(); }
    });

    $('scan-close').addEventListener('click', () => finish(null));

    async function listCameras() {
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        devices = all.filter((d) => d.kind === 'videoinput');
        if (devices.length < 2) return;

        camSel.hidden = false;
        camSel.innerHTML = devices
          .map((d, i) => `<option value="${d.deviceId}">${d.label || 'Camera ' + (i + 1)}</option>`)
          .join('');
        if (deviceId) camSel.value = deviceId;
        camSel.onchange = () => start(camSel.value);
      } catch { /* labels need permission; not worth failing over */ }
    }

    async function start(wantedId) {
      stopPreview();
      if (stream) stream.getTracks().forEach((t) => t.stop());

      const constraints = wantedId
        ? { video: { deviceId: { exact: wantedId } }, audio: false }
        : { video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false };

      stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = stream;
      await video.play();

      const track = stream.getVideoTracks()[0];
      deviceId = track.getSettings().deviceId || wantedId || null;

      // A front-facing camera is mirrored by default, because an unmirrored
      // selfie view makes aligning the cube feel backwards. A rear camera is
      // left alone. Either way this only changes the display.
      if (wantedId === undefined) {
        mirrored = (track.getSettings().facingMode || 'user') === 'user';
        applyMirror();
      }

      // Match the container to the frame so the guide square on screen covers
      // exactly the region being sampled.
      const w = video.videoWidth, h = video.videoHeight;
      if (w && h) view.style.aspectRatio = `${w} / ${h}`;

      await listCameras();
    }

    start()
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
