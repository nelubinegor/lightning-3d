/* ------------------------------------------------------------------
   Lightning clips in space
   A WebGL2 particle field where every particle is a video billboard
   drawn at its clip's native pixel dimensions and aspect ratio.
------------------------------------------------------------------ */

const CFG = {
  count:   91,
  scale:   0.20,   // 1.0 == native pixel size at the focal plane
  spread:  900,   // world radius of the cloud
  speed:   0.04,   // base orbital angular velocity (rad/s)
  flatten: 0,    // 0 = spherical orbits, 1 = flat disc
  fog:     1,   // how much distant clips wash into the background
  budget:  40,     // max simultaneously decoding videos
  rate:    0.5,      // video playback rate
  ortho:   false,  // orthographic == every clip at exact native pixel size
  cross:   false,  // ambient marks on every clip; hover/focus marks are always on
  drift:   true,   // slow camera auto-rotation
};

const FOCAL = 1800;              // focal length in CSS px -> defines the fov

// bg must match --bg in the stylesheet exactly, or the canvas and the page
// show a seam. mark alpha drops in the dark theme: white crosshairs on a
// near-black field are far louder than the same marks on light grey.
// `mark` is the ambient all-clips pass, `markHi` the hover/focus one — the
// latter always sits over a clip, so plain white reads in either theme
const THEMES = {
  light: { bg: [232/255, 232/255, 232/255], mark: [1, 1, 1, 0.85], markHi: [1, 1, 1, 0.95] },
  dark:  { bg: [ 8/255,  9/255,  12/255], mark: [1, 1, 1, 0.5 ], markHi: [1, 1, 1, 0.95] },
};
let BG = THEMES.light.bg, MARK = THEMES.light.mark, MARK_HI = THEMES.light.markHi;

/* ---------------------------------------------------------------- math */
const V = {
  norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0]/l, a[1]/l, a[2]/l]; },
  cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; },
  mix(a, b, t) { return [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t]; },
};

function perspective(out, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  out.set([f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0]);
  return out;
}

// 1 world unit == 1 CSS pixel at every depth, so a clip is drawn at exactly
// its native size no matter where it sits in the field
function ortho(out, w, h, near, far) {
  const nf = 1 / (near - far);
  out.set([2/w,0,0,0, 0,2/h,0,0, 0,0,2*nf,0, 0,0,(far+near)*nf,1]);
  return out;
}

function lookAt(out, eye, center, up) {
  let z = V.norm([eye[0]-center[0], eye[1]-center[1], eye[2]-center[2]]);
  let x = V.cross(up, z);
  if (!Math.hypot(x[0], x[1], x[2])) { z[2] += 1e-4; x = V.cross(up, z); }
  x = V.norm(x);
  const y = V.cross(z, x);
  out.set([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -(x[0]*eye[0]+x[1]*eye[1]+x[2]*eye[2]),
    -(y[0]*eye[0]+y[1]*eye[1]+y[2]*eye[2]),
    -(z[0]*eye[0]+z[1]*eye[1]+z[2]*eye[2]), 1,
  ]);
  return out;
}

// deterministic PRNG so "reseed" is reproducible per seed
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/* ------------------------------------------------------------- shaders */
const QUAD_VS = `#version 300 es
in vec2 aCorner;
uniform mat4 uView, uProj;
uniform vec3 uCenter;
uniform vec2 uSize;
uniform float uRoll;
out vec2 vUv;
out float vDepth;
void main() {
  vec4 c = uView * vec4(uCenter, 1.0);
  float s = sin(uRoll), co = cos(uRoll);
  vec2 p = aCorner * uSize;
  c.xy += vec2(p.x*co - p.y*s, p.x*s + p.y*co);
  vDepth = -c.z;
  gl_Position = uProj * c;
  vUv = aCorner + 0.5;
}`;

const QUAD_FS = `#version 300 es
precision mediump float;
in vec2 vUv;
in float vDepth;
uniform sampler2D uTex;
uniform vec3 uFogColor;
uniform float uFogAmt, uFogNear, uFogFar, uDissolve0, uDissolve1;
out vec4 frag;
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  float f = clamp((vDepth - uFogNear) / max(uFogFar - uFogNear, 1.0), 0.0, 1.0) * uFogAmt;
  // clips sweeping past the lens dissolve instead of slapping the whole screen
  float near = 1.0 - smoothstep(uDissolve0, uDissolve1, vDepth);
  if (near > 0.985) discard;                   // discard, so it stops occluding too
  frag = vec4(mix(c, uFogColor, max(f, near)), 1.0);
}`;

const MARK_VS = `#version 300 es
in vec3 aCenter;
in vec2 aOffset;
uniform mat4 uView, uProj;
uniform vec2 uViewport;
uniform float uArm;
void main() {
  vec4 v = uView * vec4(aCenter, 1.0);
  v.z += 4.0;                       // nudge toward camera so marks sit on their quad
  gl_Position = uProj * v;
  gl_Position.xy += aOffset * uArm / uViewport * 2.0 * gl_Position.w;
}`;

const MARK_FS = `#version 300 es
precision mediump float;
uniform vec4 uColor;
out vec4 frag;
void main() { frag = uColor; }`;

/* ----------------------------------------------------------------- gl */
const canvas = document.getElementById('gl');
const gl = canvas.getContext('webgl2', {
  alpha: false, antialias: true, depth: true, powerPreference: 'high-performance',
});

if (!gl) {
  document.getElementById('gate').innerHTML =
    '<h1>WebGL2 is not available in this browser</h1>';
  throw new Error('no webgl2');
}

function compile(vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

const quadProg = compile(QUAD_VS, QUAD_FS);
const markProg = compile(MARK_VS, MARK_FS);

const qU = {};
for (const n of ['uView','uProj','uCenter','uSize','uRoll','uTex','uFogColor','uFogAmt',
                 'uFogNear','uFogFar','uDissolve0','uDissolve1'])
  qU[n] = gl.getUniformLocation(quadProg, n);
const mU = {};
for (const n of ['uView','uProj','uViewport','uColor','uArm'])
  mU[n] = gl.getUniformLocation(markProg, n);

// unit quad
const quadVAO = gl.createVertexArray();
gl.bindVertexArray(quadVAO);
const quadBuf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
  -0.5,-0.5,  0.5,-0.5,  0.5,0.5,
  -0.5,-0.5,  0.5,0.5,  -0.5,0.5,
]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.bindVertexArray(null);

// centre marks: 4 vertices (2 lines) per particle, positions refreshed each frame
const MARK_ARM = 5.5;
let markVAO, markCenterBuf, markCenters;

function buildMarks(n) {
  if (markVAO) { gl.deleteVertexArray(markVAO); gl.deleteBuffer(markCenterBuf); }
  markVAO = gl.createVertexArray();
  gl.bindVertexArray(markVAO);

  markCenters = new Float32Array(n * 4 * 3);
  markCenterBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, markCenterBuf);
  gl.bufferData(gl.ARRAY_BUFFER, markCenters.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

  const off = new Float32Array(n * 4 * 2);
  for (let i = 0; i < n; i++) {
    off.set([-MARK_ARM, 0, MARK_ARM, 0, 0, -MARK_ARM, 0, MARK_ARM], i * 8);
  }
  const ob = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, ob);
  gl.bufferData(gl.ARRAY_BUFFER, off, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);

  gl.bindVertexArray(null);
}

/* ---------------------------------------------------------- particles */
const particles = [];
let seed = 20260726;

function layout() {
  const rand = rng(seed);
  for (const p of particles) {
    // orbit plane normal, biased toward the world up axis by `flatten`
    let n;
    do {
      n = [rand()*2-1, rand()*2-1, rand()*2-1];
    } while (Math.hypot(n[0], n[1], n[2]) > 1 || Math.hypot(n[0], n[1], n[2]) < 0.05);
    n = V.norm(V.mix(V.norm(n), [0, 1, 0], CFG.flatten * (0.55 + 0.45 * rand())));

    let u = V.cross(n, Math.abs(n[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]);
    u = V.norm(u);
    const v = V.cross(n, u);

    p.u = u; p.v = v;
    p.rNorm = 0.28 + 0.72 * Math.cbrt(rand());   // fraction of spread
    p.ecc = 0.82 + rand() * 0.3;                 // slight ellipticity on v
    p.phase = rand() * Math.PI * 2;
    p.dir = rand() < 0.85 ? 1 : -1;
    p.rate = 0.55 + rand() * 0.9;
    p.roll = (rand() - 0.5) * 0.22;              // ±6°
    p.wob = 0.12 + rand() * 0.3;
    p.wobPhase = rand() * Math.PI * 2;
    p.wobAmt = 0.03 + rand() * 0.07;
  }
}

function place(p, t) {
  const r = CFG.spread * p.rNorm * (1 + p.wobAmt * Math.sin(t * p.wob + p.wobPhase));
  // keplerian-ish: inner orbits sweep faster
  const w = CFG.speed * p.rate * p.dir * Math.pow(0.35 / Math.max(p.rNorm, 0.05), 0.5);
  const a = p.phase + t * w;
  const c = Math.cos(a) * r, s = Math.sin(a) * r * p.ecc;
  p.pos[0] = p.u[0]*c + p.v[0]*s;
  p.pos[1] = p.u[1]*c + p.v[1]*s;
  p.pos[2] = p.u[2]*c + p.v[2]*s;
}

/* -------------------------------------------------------------- video */
function makeTexture() {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return t;
}

function allocate(p) {
  const w = p.video.videoWidth, h = p.video.videoHeight;
  if (!w || !h) return;
  p.w = w; p.h = h;
  const levels = Math.floor(Math.log2(Math.max(w, h))) + 1;
  gl.bindTexture(gl.TEXTURE_2D, p.tex);
  gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, w, h);
  p.allocated = true;
}

function pump(p) {
  // upload only when the decoder actually hands us a new frame
  if (p.video.requestVideoFrameCallback) {
    p.video.requestVideoFrameCallback(() => { p.dirty = true; pump(p); });
  } else {
    p.pollFrames = true;   // no rVFC (older Safari/Firefox): fall back to polling
  }
}

async function boot() {
  let clips;
  try {
    const res = await fetch('clips.json');
    if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
    clips = await res.json();
  } catch (err) {
    // opening index.html straight off disk lands here: file:// blocks the
    // manifest fetch, and would taint the video textures even if it didn't
    document.getElementById('gate').innerHTML =
      '<h1>Serve this folder over http</h1>' +
      '<div id="note">Video textures cannot be read from file:// —' +
      ' run <code>python3 -m http.server 8000</code> here and open' +
      ' <code>localhost:8000</code></div>';
    throw err;
  }
  const bar = document.querySelector('#bar i');
  const enter = document.getElementById('enter');
  document.getElementById('note').textContent = `${clips.length} clips · sound off`;
  document.getElementById('c-count').max = clips.length;
  document.getElementById('c-count').value = clips.length;
  document.getElementById('v-count').textContent = clips.length;
  CFG.count = clips.length;

  let ready = 0;
  const settle = () => {
    ready++;
    bar.style.width = (ready / clips.length * 100) + '%';
    if (ready >= clips.length) enter.classList.add('on');
  };

  clips.forEach((clip, i) => {
    const video = document.createElement('video');
    video.src = clip.src;
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.playbackRate = CFG.rate;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');

    const p = {
      video, tex: makeTexture(), w: clip.w, h: clip.h,
      allocated: false, dirty: false, hasFrame: false,
      wantLive: i < CFG.budget, isLive: false, area: 0, sscale: 1,
      pos: new Float32Array(3), index: i,
    };
    particles.push(p);

    // a seek on a paused clip still presents a frame — that is how the
    // clips outside the decode budget get something to show
    video.addEventListener('seeked', () => { p.dirty = true; });

    let settled = false;
    const once = () => { if (!settled) { settled = true; settle(); } };
    video.addEventListener('loadedmetadata', () => { allocate(p); once(); }, { once: true });
    video.addEventListener('error', once, { once: true });
    setTimeout(once, 12000);   // never let one bad clip stall the gate
  });

  layout();
  buildMarks(particles.length);

  // let the gate open early if most clips are ready
  setTimeout(() => enter.classList.add('on'), 2500);
  enter.addEventListener('click', start, { once: true });
}

function start() {
  document.getElementById('gate').classList.add('hidden');
 //document.getElementById('ui').classList.remove('hidden');
  particles.forEach((p, i) => {
    pump(p);
    // de-sync the loops so the field never pulses in unison
    if (p.video.duration) p.video.currentTime = Math.random() * p.video.duration * 0.9;
    if (i < CFG.budget) { p.isLive = p.wantLive = true; p.video.play().catch(() => {}); }
  });
  schedulerOn = true;
}

/* --------------------------------------------- decoder budget scheduler
   Keeping 91 hardware decoders alive at once is more than most machines
   will give us, so only the biggest clips on screen keep playing. Paused
   ones hold their last frame, which reads as a still in the field.      */
let schedulerOn = false, lastSched = 0;

function schedule(now) {
  if (!schedulerOn || now - lastSched < 400) return;
  lastSched = now;

  const n = Math.min(CFG.count, particles.length);
  const live = [];
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    p.wantLive = false;
    if (i < n) live.push(p);
  }
  // a little stickiness so clips near the cut-off don't stutter in and out
  live.sort((a, b) => (b.area * (b.isLive ? 1.35 : 1)) - (a.area * (a.isLive ? 1.35 : 1)));

  const budget = Math.min(CFG.budget, live.length);
  for (let i = 0; i < budget; i++) live[i].wantLive = true;

  for (const p of particles) {
    p.isLive = p.wantLive;
    // read the element rather than trusting our own bookkeeping: the browser
    // pauses media on hidden tabs behind our back
    if (p.wantLive && p.video.paused) p.video.play().catch(() => {});
    else if (!p.wantLive && !p.video.paused) p.video.pause();
    // a clip that has never shown anything gets nudged into decoding one frame.
    // keep retrying while it comes up blank — a poke can be lost if the tab was
    // hidden — but only on paused clips, so it never fights playback
    if (!p.hasFrame && p.video.paused && !p.video.seeking &&
        p.video.readyState >= 1 && p.video.duration) {
      p.video.currentTime = Math.random() * p.video.duration * 0.9;
    }
  }
}

addEventListener('visibilitychange', () => { if (!document.hidden) lastSched = 0; });

/* ------------------------------------------------------------- camera */
const cam = { az: 0.5, el: 0.18, dist: FOCAL, tAz: 0.5, tEl: 0.18, tDist: FOCAL };
let dragging = false, lastX = 0, lastY = 0;
let hovered = -1, focused = -1;   // indices into particles, -1 for none

// a press only becomes a drag once it travels; below that it stays a click,
// so picking a clip and swinging the camera share the same button
const DRAG_SLOP = 4;
let downX = 0, downY = 0, moved = false;
let mouseX = 0, mouseY = 0, mouseIn = false;

canvas.addEventListener('pointerdown', e => {
  dragging = true; moved = false;
  lastX = downX = e.clientX; lastY = downY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', e => {
  mouseX = e.clientX; mouseY = e.clientY; mouseIn = true;
  if (!dragging) return;
  if (!moved) {
    if (Math.hypot(e.clientX - downX, e.clientY - downY) <= DRAG_SLOP) return;
    moved = true;
    canvas.classList.add('dragging');
    focused = -1;                       // taking the wheel releases the focus
    lastX = e.clientX; lastY = e.clientY;
    return;
  }
  cam.tAz -= (e.clientX - lastX) * 0.005;
  cam.tEl = Math.max(-1.45, Math.min(1.45, cam.tEl + (e.clientY - lastY) * 0.005));
  lastX = e.clientX; lastY = e.clientY;
});
for (const ev of ['pointerup', 'pointercancel']) {
  canvas.addEventListener(ev, e => {
    if (dragging && !moved && e.type === 'pointerup') {
      // click: focus the clip under the cursor, or clear on empty space
      focused = hovered >= 0 && hovered !== focused ? hovered : -1;
    }
    dragging = false; moved = false;
    canvas.classList.remove('dragging');
  });
}
canvas.addEventListener('pointerleave', () => { mouseIn = false; });
// the panel sits over the canvas and swallows its pointermove, which would
// otherwise leave a stale hover on whatever clip is behind it
document.getElementById('ui').addEventListener('pointerenter', () => { mouseIn = false; });
/* ------------------------------------------------------------- picking
   Billboards face the camera, so a clip's on-screen footprint is just its
   world size times FOCAL/depth (times 1 under orthographic) — no need to
   project the corners. Undo the roll around the centre and the hit test is
   a plain rectangle check. Nearest depth wins.                          */
let dissolve0 = 0, dissolve1 = 1;

function pick() {
  if (!mouseIn || moved) return -1;
  let best = -1, bestDepth = Infinity;
  const cut = dissolve0 + (dissolve1 - dissolve0) * 0.2;   // ~90% dissolved
  const n = Math.min(CFG.count, particles.length);
  for (let i = 0; i < n; i++) {
    const p = particles[i];
    if (!p.onScreen || !p.hasFrame || p.depth >= bestDepth || p.depth <= cut) continue;
    const k = CFG.ortho ? 1 : FOCAL / p.depth;
    const dx = (mouseX - p.sx) / k, dy = -(mouseY - p.sy) / k;
    const c = Math.cos(p.roll), s = Math.sin(p.roll);
    if (Math.abs(dx * c + dy * s) <= p.w * CFG.scale * 0.5 &&
        Math.abs(-dx * s + dy * c) <= p.h * CFG.scale * 0.5) {
      best = i; bestDepth = p.depth;
    }
  }
  return best;
}

// Swing the camera onto the ray through the focused clip. The camera always
// looks at the origin, so aiming the eye along that ray puts the clip dead
// centre — and since it keeps orbiting, this re-aims every frame and the rest
// of the field wheels around it.
function trackFocus() {
  const p = particles[focused];
  const [x, y, z] = p.pos;
  const r = Math.hypot(x, y, z);
  if (r < 1e-3) return;

  let az = Math.atan2(x, z);
  az += Math.round((cam.az - az) / (2 * Math.PI)) * (2 * Math.PI);   // nearest turn
  cam.tAz = az;
  cam.tEl = Math.max(-1.5, Math.min(1.5, Math.asin(y / r)));

  // a clip centred at radius r sits at depth (dist - r); keep it well clear of
  // the near dissolve, which would otherwise fade out whatever we just picked
  if (cam.tDist < r * 1.5) cam.tDist = Math.min(6000, r * 1.5);
}

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  if (CFG.ortho) {
    // apparent size is fixed by definition here, so the wheel opens the field
    // out instead of dollying — that is the only density lever ortho has
    setSlider('c-spread', Math.max(600, Math.min(5000, CFG.spread * Math.exp(e.deltaY * 0.0012))));
  } else {
    cam.tDist = Math.max(120, Math.min(6000, cam.tDist * Math.exp(e.deltaY * 0.0012)));
  }
}, { passive: false });

/* ---------------------------------------------------------------- ui */
const bind = (id, valId, key, fmt, after) => {
  const el = document.getElementById(id), out = document.getElementById(valId);
  const sync = () => {
    CFG[key] = parseFloat(el.value);
    out.textContent = fmt(CFG[key]);
    if (after) after();
  };
  el.addEventListener('input', sync);
  return sync;
};

function setSlider(id, v) {
  const el = document.getElementById(id);
  el.value = v;
  el.dispatchEvent(new Event('input'));
}

const f2 = v => v.toFixed(2), f0 = v => String(Math.round(v));
bind('c-scale',  'v-scale',  'scale',   f2);
bind('c-spread', 'v-spread', 'spread',  f0);
bind('c-speed',  'v-speed',  'speed',   f2);
bind('c-fog',    'v-fog',    'fog',     f2);
bind('c-flat',   'v-flat',   'flatten', f2, () => layout());
bind('c-count',  'v-count',  'count',   f0, () => { lastSched = 0; });
bind('c-budget', 'v-budget', 'budget',  f0, () => { lastSched = 0; });

const toggle = (id, key) => {
  const b = document.getElementById(id);
  b.addEventListener('click', () => { CFG[key] = !CFG[key]; b.classList.toggle('on', CFG[key]); });
};
toggle('b-cross', 'cross');
toggle('b-spin', 'drift');

// True px: orthographic, so every clip measures exactly its own pixel
// dimensions wherever it sits. Depth then reads as overlap and parallax
// rather than as scale. Perspective is the default because the size
// falloff is what makes the field feel deep.
const b11 = document.getElementById('b-11');
b11.addEventListener('click', () => {
  CFG.ortho = !CFG.ortho;
  b11.classList.toggle('on', CFG.ortho);
  const preset = CFG.ortho
    ? { 'c-scale': 1,   'c-spread': 4000 }
    : { 'c-scale': 0.2, 'c-spread': 1100 };
  for (const [id, v] of Object.entries(preset)) setSlider(id, v);
  cam.tDist = CFG.ortho ? 9000 : FOCAL;
});
document.getElementById('b-shuffle').addEventListener('click', () => {
  seed = (Math.random() * 1e9) | 0; layout();
});

// playbackRate lives on the element and survives the scheduler pausing and
// resuming a clip, so setting it once per change is enough
const rateSwitch = document.getElementById('c-rate');
function setRate(r) {
  CFG.rate = r;
  for (const b of rateSwitch.children) b.classList.toggle('on', +b.dataset.rate === r);
  for (const p of particles) p.video.playbackRate = r;
}
rateSwitch.addEventListener('click', e => {
  const b = e.target.closest('button[data-rate]');
  if (b) setRate(+b.dataset.rate);
});

/* --------------------------------------------------------------- theme */
const bTheme = document.getElementById('b-theme');
let theme = 'light';

function setTheme(mode) {
  theme = THEMES[mode] ? mode : 'light';
  document.documentElement.dataset.theme = theme;
  BG = THEMES[theme].bg;
  MARK = THEMES[theme].mark;
  MARK_HI = THEMES[theme].markHi;
  bTheme.classList.toggle('on', theme === 'dark');
}

const store = {
  get() { try { return localStorage.getItem('lcis-theme'); } catch (e) { return null; } },
  set(v) { try { localStorage.setItem('lcis-theme', v); } catch (e) {} },
};

// the inline script in <head> already resolved this before first paint —
// read it back rather than deciding twice and risking a mismatch
setTheme(document.documentElement.dataset.theme);

function flipTheme() {
  const next = theme === 'dark' ? 'light' : 'dark';
  store.set(next);
  setTheme(next);
}
bTheme.addEventListener('click', flipTheme);

// keep following the OS until the visitor states a preference of their own
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
  if (!store.get()) setTheme(e.matches ? 'dark' : 'light');
});

let frozen = false;
addEventListener('keydown', e => {
  if (e.key === 'h' || e.key === 'H') document.getElementById('ui').classList.toggle('hidden');
  if (e.key === 'd' || e.key === 'D') flipTheme();
  if (e.key === 'Escape') focused = -1;
  if (e.code === 'Space') { e.preventDefault(); frozen = !frozen; }
});

/* -------------------------------------------------------------- frame */
const view = new Float32Array(16), proj = new Float32Array(16);
let cssW = 0, cssH = 0, dpr = 1;

function resize() {
  const d = Math.min(devicePixelRatio || 1, 2);
  const w = innerWidth, h = innerHeight;
  if (w === cssW && h === cssH && d === dpr) return;
  cssW = w; cssH = h; dpr = d;
  canvas.width = Math.round(w * d);
  canvas.height = Math.round(h * d);
}
addEventListener('resize', resize);
resize();

let simTime = 0, prev = performance.now(), fpsAcc = 0, fpsN = 0;
const fpsEl = document.getElementById('fps');

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - prev) / 1000, 0.1);
  prev = now;
  if (!frozen) simTime += dt;

  resize();

  const n = Math.min(CFG.count, particles.length);
  if (focused >= n) focused = -1;          // the clip count slider dropped it

  if (focused >= 0) trackFocus();
  else if (CFG.drift && !dragging) cam.tAz += dt * 0.028;

  const k = 1 - Math.pow(0.0015, dt);
  cam.az += (cam.tAz - cam.az) * k;
  cam.el += (cam.tEl - cam.el) * k;
  cam.dist += (cam.tDist - cam.dist) * k;

  const ce = Math.cos(cam.el);
  const eye = [
    Math.sin(cam.az) * ce * cam.dist,
    Math.sin(cam.el) * cam.dist,
    Math.cos(cam.az) * ce * cam.dist,
  ];
  lookAt(view, eye, [0, 0, 0], [0, 1, 0]);

  if (CFG.ortho) {
    ortho(proj, cssW, cssH, 1, cam.dist + CFG.spread * 3 + 2000);
  } else {
    // fov chosen so that `scale = 1` at the focal plane == native pixel size
    const fovy = 2 * Math.atan(cssH / (2 * FOCAL));
    perspective(proj, fovy, cssW / cssH, 4, CFG.spread * 8 + 6000);
  }

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(BG[0], BG[1], BG[2], 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.disable(gl.BLEND);
  gl.disable(gl.CULL_FACE);

  const fogNear = Math.max(cam.dist - CFG.spread, 1);
  const fogFar = cam.dist + CFG.spread * 1.35;
  // nothing blows up in the lens under orthographic, so switch the fade off
  dissolve0 = CFG.ortho ? -2 : cam.dist * 0.05;
  dissolve1 = CFG.ortho ? -1 : cam.dist * 0.22;

  // project everything first, so the pick below sees this frame's layout
  // rather than the last one's
  for (let i = 0; i < n; i++) {
    const p = particles[i];
    if (!frozen) place(p, simTime);
    const [x, y, z] = p.pos;

    const depth = -(view[2]*x + view[6]*y + view[10]*z + view[14]);
    p.depth = depth;
    p.onScreen = false;
    if (depth > 1) {
      // perspective divides by depth, orthographic does not
      const pw = CFG.ortho ? 1 : depth;
      const xv = view[0]*x + view[4]*y + view[8]*z + view[12];
      const yv = view[1]*x + view[5]*y + view[9]*z + view[13];
      const ndcX = proj[0] * xv / pw, ndcY = proj[5] * yv / pw;
      const hx = p.w * CFG.scale * 0.5 * proj[0] / pw;
      const hy = p.h * CFG.scale * 0.5 * proj[5] / pw;
      const rad = Math.hypot(hx, hy);   // roll-proof bound
      p.onScreen = Math.abs(ndcX) <= 1 + rad && Math.abs(ndcY) <= 1 + rad;
      p.sx = (ndcX * 0.5 + 0.5) * cssW;
      p.sy = (0.5 - ndcY * 0.5) * cssH;
      p.sscale = CFG.ortho ? CFG.scale : FOCAL / depth * CFG.scale;
      p.area = p.onScreen ? p.w * p.h * p.sscale * p.sscale : 0;
    } else {
      p.sscale = 1; p.area = 0;
    }
  }

  hovered = pick();
  canvas.classList.toggle('pointing', hovered >= 0);

  gl.useProgram(quadProg);
  gl.bindVertexArray(quadVAO);
  gl.uniformMatrix4fv(qU.uView, false, view);
  gl.uniformMatrix4fv(qU.uProj, false, proj);
  gl.uniform3fv(qU.uFogColor, BG);
  gl.uniform1f(qU.uFogAmt, CFG.fog);
  gl.uniform1f(qU.uFogNear, fogNear);
  gl.uniform1f(qU.uFogFar, fogFar);
  gl.uniform1f(qU.uDissolve0, dissolve0);
  gl.uniform1f(qU.uDissolve1, dissolve1);
  gl.uniform1i(qU.uTex, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

  let drawn = 0;
  for (let i = 0; i < n; i++) {
    const p = particles[i];
    const onScreen = p.onScreen;

    if (!p.allocated) { if (p.video.videoWidth) allocate(p); else continue; }
    if (p.pollFrames && !p.video.paused && p.video.readyState >= 2) p.dirty = true;

    // upload when visible, and always for the very first frame so an
    // off-screen clip still has something to show when it swings into view
    if (p.dirty && (onScreen || !p.hasFrame)) {
      p.dirty = false;
      gl.bindTexture(gl.TEXTURE_2D, p.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, p.video);
      // mips only matter when the clip is minified, which is the common case —
      // but the chain has to be defined at least once or sampling is undefined
      if (p.sscale < 0.8 || !p.mipped) { gl.generateMipmap(gl.TEXTURE_2D); p.mipped = true; }
      p.hasFrame = true;
    }
    if (!onScreen || !p.hasFrame) continue;

    gl.bindTexture(gl.TEXTURE_2D, p.tex);
    gl.uniform3fv(qU.uCenter, p.pos);
    gl.uniform2f(qU.uSize, p.w * CFG.scale, p.h * CFG.scale);
    gl.uniform1f(qU.uRoll, p.roll);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    drawn++;
  }

  schedule(now);

  // marks: an optional ambient block for every clip, then the hovered and
  // focused ones brighter and larger. Both live in one buffer, drawn as two
  // ranges so each gets its own colour and arm length.
  let ambient = 0, highlight = 0;
  const putMark = (p, slot) => {
    const b = slot * 12;
    for (let c = 0; c < 4; c++) {
      markCenters[b + c*3]     = p.pos[0];
      markCenters[b + c*3 + 1] = p.pos[1];
      markCenters[b + c*3 + 2] = p.pos[2];
    }
  };
  if (CFG.cross) {
    for (let i = 0; i < n; i++) {
      if (i !== hovered && i !== focused) putMark(particles[i], ambient++);
    }
  }
  if (focused >= 0) putMark(particles[focused], ambient + highlight++);
  if (hovered >= 0 && hovered !== focused) putMark(particles[hovered], ambient + highlight++);

  if (ambient + highlight) {
    gl.useProgram(markProg);
    gl.bindVertexArray(markVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, markCenterBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, markCenters, 0, (ambient + highlight) * 12);
    gl.uniformMatrix4fv(mU.uView, false, view);
    gl.uniformMatrix4fv(mU.uProj, false, proj);
    gl.uniform2f(mU.uViewport, cssW, cssH);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    if (ambient) {
      gl.uniform4fv(mU.uColor, MARK);
      gl.uniform1f(mU.uArm, 1);
      gl.drawArrays(gl.LINES, 0, ambient * 4);
    }
    if (highlight) {
      gl.uniform4fv(mU.uColor, MARK_HI);
      gl.uniform1f(mU.uArm, 1.8);
      gl.drawArrays(gl.LINES, ambient * 4, highlight * 4);
    }
    gl.disable(gl.BLEND);
  }

  gl.bindVertexArray(null);

  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) {
    let playing = 0;
    for (const p of particles) if (!p.video.paused) playing++;
    fpsEl.textContent = `${drawn} on screen · ${playing} live · ${Math.round(fpsN / fpsAcc)} fps`;
    fpsAcc = 0; fpsN = 0;
  }
}

boot().then(() => requestAnimationFrame(frame), () => {});
