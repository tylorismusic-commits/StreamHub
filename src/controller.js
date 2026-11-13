'use strict';

// Controller support for StreamHub.
//
// Two halves live here:
//
//   GamepadReader  — reads the Linux kernel joystick API (/dev/input/js*) as the binary
//                    `struct js_event` records it actually is, and emits W3C-standard gamepad
//                    button/axis numbers. This is what makes a physical pad work in Electron at
//                    all: Chromium's Gamepad API often reports a Bluetooth pad as connected but
//                    never delivers its button changes, while the kernel device always does.
//
//   PAGE_CONTROLLER_SOURCE — a self-contained script injected into every service view. It adds
//                    spatial navigation with a visible focus ring, click/activate, media control
//                    and popup/ad dismissal. It is injected with executeJavaScript, so it needs no
//                    bridge on the untrusted page.
//
// The main process owns the routing (see startGamepadReader in main.js): global buttons act on the
// app, everything else goes to whichever half — chrome or page — currently has the controller.

const fs = require('fs');
const { EventEmitter } = require('events');

// W3C "standard gamepad" button indices. The rest of the app speaks these, so a pad mapped to them
// behaves exactly like one the browser would have reported.
const BTN = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  BACK: 8,
  START: 9,
  L3: 10,
  R3: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
  GUIDE: 16,
};

// The kernel names buttons by position (BTN_SOUTH, BTN_EAST, ...), not by the label printed on the
// pad, and joydev numbers them in ascending key-code order. A pad that advertises BTN_C and BTN_Z —
// the 8BitDo does over Bluetooth — therefore has its whole button layout shifted relative to an
// Xbox pad. So the mapping is built per device from sysfs rather than assumed.
const KEY_TO_BTN = new Map([
  [304, BTN.A], // BTN_SOUTH
  [305, BTN.B], // BTN_EAST
  [306, null], // BTN_C — an extra paddle on pads that have one
  [307, BTN.Y], // BTN_NORTH
  [308, BTN.X], // BTN_WEST
  [309, null], // BTN_Z — extra
  [310, BTN.LB], // BTN_TL
  [311, BTN.RB], // BTN_TR
  [312, BTN.LT], // BTN_TL2
  [313, BTN.RT], // BTN_TR2
  [314, BTN.BACK], // BTN_SELECT
  [315, BTN.START], // BTN_START
  [316, BTN.GUIDE], // BTN_MODE
  [317, BTN.L3], // BTN_THUMBL
  [318, BTN.R3], // BTN_THUMBR
  [544, BTN.UP], // BTN_DPAD_UP
  [545, BTN.DOWN],
  [546, BTN.LEFT],
  [547, BTN.RIGHT],
]);

// The 8BitDo Ultimate 2C is an Xbox-layout pad, so the kernel's positional names line up with the
// labels: BTN_SOUTH is the A under the right thumb and BTN_EAST is B beside it. (An earlier guess
// swapped these for a Nintendo layout; the pad itself says otherwise, and A select / B back is what
// the user expects.)

// ABS_* codes. The right stick is ABS_RX/RY on an Xbox-style pad but ABS_Z/RZ on a Switch-style one,
// where GAS/BRAKE are the triggers — so an axis's job depends on what else the device advertises.
const ABS = {
  X: 0,
  Y: 1,
  Z: 2,
  RX: 3,
  RY: 4,
  RZ: 5,
  GAS: 9,
  BRAKE: 10,
  HAT0X: 16,
  HAT0Y: 17,
  HAT1X: 18,
  HAT1Y: 19,
};

const STICK_DEADZONE = 0.18; // of full deflection
const JS_EVENT_BUTTON = 0x01;
const JS_EVENT_AXIS = 0x02;
const JS_EVENT_INIT = 0x80;

// sysfs prints a capability bitmap as 64-bit hex words, most significant word first.
function readBitmap(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').trim();
  } catch {
    return [];
  }
  if (!text) return [];
  const words = text.split(/\s+/);
  const out = [];
  for (let w = 0; w < words.length; w += 1) {
    let word;
    try {
      word = BigInt(`0x${words[w]}`);
    } catch {
      continue;
    }
    if (word === 0n) continue;
    const base = (words.length - 1 - w) * 64;
    for (let bit = 0; bit < 64; bit += 1) {
      if (word & (1n << BigInt(bit))) out.push(base + bit);
    }
  }
  return out.sort((a, b) => a - b);
}

// What a js device actually is, in the terms joydev uses: js button N -> standard index, js axis N ->
// role. Returns null for anything that is not a pad, which keeps the mouse some virtual-HID stacks
// also expose as a js device from scrolling the page under the stick.
function deviceInfo(path) {
  const name = path.split('/').pop();
  const dir = `/sys/class/input/${name}/device`;
  const keys = readBitmap(`${dir}/capabilities/key`);
  const abs = readBitmap(`${dir}/capabilities/abs`);
  const isPad =
    keys.some((k) => k >= 304 && k <= 318) ||
    abs.some((a) => a === ABS.HAT0X || a === ABS.HAT0Y);
  if (!isPad) return null;

  const buttons = new Map(); // js button number -> standard index (null for an unused extra)
  let uevent = '';
  try {
    uevent = fs.readFileSync(`${dir}/uevent`, 'utf8');
  } catch {
    // no uevent: treat it as an Xbox-style pad
  }
  keys.forEach((code, i) => buttons.set(i, KEY_TO_BTN.has(code) ? KEY_TO_BTN.get(code) : null));

  // Steam Input and Sunshine both create virtual pads that mirror a real one. Reading both would
  // deliver every press twice — RB toggling the controller target and then toggling it straight
  // back. A real pad has a physical address (a Bluetooth MAC or a USB path); a virtual one has
  // none, or says libvirtualhid. The real one wins whenever it is present.
  const physMatch = /^PHYS="([^"]*)"/m.exec(uevent);
  const phys = physMatch ? physMatch[1] : '';
  const virtual = !phys || /libvirtualhid|uhid\//i.test(phys);

  const hasRX = abs.includes(ABS.RX);
  const axes = new Map(); // js axis number -> role
  abs.forEach((code, i) => {
    let role = null;
    if (code === ABS.X) role = 'leftX';
    else if (code === ABS.Y) role = 'leftY';
    else if (code === ABS.Z) role = hasRX ? 'lt' : 'rightX';
    else if (code === ABS.RX) role = 'rightX';
    else if (code === ABS.RY) role = 'rightY';
    else if (code === ABS.RZ) role = hasRX ? 'rt' : 'rightY';
    else if (code === ABS.GAS) role = 'lt';
    else if (code === ABS.BRAKE) role = 'rt';
    else if (code === ABS.HAT0X || code === ABS.HAT1X) role = 'hatX';
    else if (code === ABS.HAT0Y || code === ABS.HAT1Y) role = 'hatY';
    axes.set(i, role);
  });
  return { buttons, axes, virtual };
}

class GamepadReader extends EventEmitter {
  constructor({ debug = false, allowVirtual = false } = {}) {
    super();
    this.debug = debug;
    // Testing aid: keep reading virtual pads even when a real one is connected, so a virtual pad
    // can drive the app on a machine that also has the physical controller switched on.
    this.allowVirtual = allowVirtual;
    this.devices = new Map(); // path -> { stream, buf, buttons, axes, hat, pressed }
    this.scanTimer = null;
    this.axes = new Map(); // standard axis -> -1..1
  }

  start() {
    if (this.scanTimer) return;
    this.scan();
    // Hot-plug: a pad switched on after the app is already running has to be picked up too. Half a
    // second is quick enough that the first press after switching it on is not lost.
    this.scanTimer = setInterval(() => this.scan(), 500);
    this.scanTimer.unref?.();
  }

  stop() {
    clearInterval(this.scanTimer);
    this.scanTimer = null;
    for (const path of [...this.devices.keys()]) this.close(path);
    this.axes.clear();
    this.removeAllListeners();
  }

  scan() {
    const candidates = [];
    for (let i = 0; i < 32; i += 1) {
      const path = `/dev/input/js${i}`;
      if (this.devices.has(path)) continue;
      let stat;
      try {
        stat = fs.statSync(path);
      } catch {
        continue;
      }
      if (!stat.isCharacterDevice()) continue;
      const info = deviceInfo(path);
      if (info) candidates.push({ path, info });
    }
    // Drop devices that have gone away (Bluetooth drop, unplug).
    for (const path of [...this.devices.keys()]) {
      try {
        fs.statSync(path);
      } catch {
        this.close(path);
      }
    }

    const physical = candidates.filter((c) => !c.info.virtual);
    if (physical.length && !this.allowVirtual) {
      // A real pad just appeared. Let go of any virtual mirror already being read.
      for (const [path, dev] of [...this.devices]) {
        if (dev.virtual) this.close(path);
      }
    }
    const realOpen = [...this.devices.values()].some((d) => !d.virtual);
    let open;
    if (physical.length) open = this.allowVirtual ? candidates : physical;
    else if (realOpen) open = this.allowVirtual ? candidates.filter((c) => c.info.virtual) : [];
    // No real pad anywhere: fall back to a virtual one rather than have no controller at all.
    else open = candidates;
    for (const c of open) this.open(c.path, c.info);
  }

  open(path, info = deviceInfo(path)) {
    if (!info) return;
    let stream;
    try {
      stream = fs.createReadStream(path, { highWaterMark: 64 });
    } catch (err) {
      this.emit('error', path, err);
      return;
    }
    const dev = {
      path,
      stream,
      buf: Buffer.alloc(0),
      virtual: info.virtual,
      buttons: info.buttons,
      axes: info.axes,
      hat: { x: 0, y: 0 },
      pressed: new Map(),
      rest: new Map(), // js axis -> value at rest, from the kernel's initial-state events
    };
    this.devices.set(path, dev);
    stream.on('data', (chunk) => this.onData(dev, chunk));
    stream.on('error', (err) => {
      this.emit('error', path, err);
      this.close(path);
    });
    stream.on('close', () => this.devices.delete(path));
    this.emit('device', path);
  }

  close(path) {
    const dev = this.devices.get(path);
    if (!dev) return;
    this.devices.delete(path);
    try {
      dev.stream.destroy();
    } catch {
      // already gone
    }
    this.emit('device-gone', path);
  }

  onData(dev, chunk) {
    dev.buf = dev.buf.length ? Buffer.concat([dev.buf, chunk]) : chunk;
    // struct js_event { __u32 time; __s16 value; __u8 type; __u8 number; } — 8 bytes.
    while (dev.buf.length >= 8) {
      const ev = dev.buf.subarray(0, 8);
      dev.buf = dev.buf.subarray(8);
      this.handleEvent(dev, ev);
    }
  }

  handleEvent(dev, ev) {
    const value = ev.readInt16LE(4);
    const type = ev.readUInt8(6);
    const number = ev.readUInt8(7);
    const kind = type & ~JS_EVENT_INIT;
    if (type & JS_EVENT_INIT) {
      // The initial-state burst says where each axis sits untouched. A trigger rests at -32767 on
      // some pads and at 0 on others; knowing which is what lets a press start at the right place.
      if (kind === JS_EVENT_AXIS) dev.rest.set(number, value);
      return;
    }
    if (kind === JS_EVENT_BUTTON) this.handleButton(dev, number, value !== 0);
    else if (kind === JS_EVENT_AXIS) this.handleAxis(dev, number, value);
  }

  handleButton(dev, number, pressed) {
    if (!dev.buttons.has(number)) return;
    const btn = dev.buttons.get(number);
    if (btn === null || btn === undefined) return;
    if ((dev.pressed.get(btn) === true) === pressed) return;
    dev.pressed.set(btn, pressed);
    if (this.debug) console.log(`[gamepad] ${dev.path} button`, btn, pressed);
    this.emit('button', btn, pressed);
  }

  handleAxis(dev, number, value) {
    const role = dev.axes.get(number);
    if (!role) return;
    if (role === 'hatX' || role === 'hatY') {
      this.handleHat(dev, role === 'hatX' ? 'x' : 'y', Math.sign(value));
      return;
    }
    const rest = dev.rest.has(number) ? dev.rest.get(number) : 0;
    if (role === 'lt' || role === 'rt') {
      const btn = role === 'lt' ? BTN.LT : BTN.RT;
      const span = 32767 - rest;
      const travel = span > 0 ? (value - rest) / span : 0;
      const pressed = travel > 0.35;
      if ((dev.pressed.get(btn) === true) === pressed) return;
      dev.pressed.set(btn, pressed);
      if (this.debug) console.log(`[gamepad] ${dev.path} trigger`, btn, pressed, value);
      this.emit('button', btn, pressed);
      return;
    }
    // js axes are signed 16-bit. A centred stick rests at 0 and reaches +/-32767; the rest recorded
    // above covers a pad that centres somewhere else.
    const span = Math.max(32767 - rest, rest + 32767);
    let norm = span > 0 ? (value - rest) / span : 0;
    if (Math.abs(norm) < STICK_DEADZONE) norm = 0;
    const axis = role === 'leftX' ? 0 : role === 'leftY' ? 1 : role === 'rightX' ? 2 : 3;
    if (this.axes.get(axis) === norm) return;
    this.axes.set(axis, norm);
    this.emit('axis', axis, norm);
  }

  // The d-pad is a hat on most pads: -1 / 0 / 1 on two axes. Turn each change of direction into
  // the same button edges the rest of the app already understands.
  handleHat(dev, which, dir) {
    if (dev.hat[which] === dir) return;
    dev.hat[which] = dir;
    if (which === 'x') {
      this.setHatButton(dev, BTN.LEFT, dir < 0);
      this.setHatButton(dev, BTN.RIGHT, dir > 0);
    } else {
      this.setHatButton(dev, BTN.UP, dir < 0);
      this.setHatButton(dev, BTN.DOWN, dir > 0);
    }
  }

  setHatButton(dev, btn, pressed) {
    if ((dev.pressed.get(btn) === true) === pressed) return;
    dev.pressed.set(btn, pressed);
    if (this.debug) console.log(`[gamepad] ${dev.path} hat`, btn, pressed);
    this.emit('button', btn, pressed);
  }
}

// Injected into every service view. Self-contained: it may not close over anything in this module.
function pageController() {
  if (window.__streamhubController) {
    try {
      window.__streamhubController.refresh();
    } catch {
      // a half-installed previous copy; replace it below
    }
    if (window.__streamhubController) return 'already';
  }

  const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[contenteditable="true"]',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[tabindex]:not([tabindex="-1"])',
    'video',
  ].join(',');

  const RING_ID = '__streamhub_focus_ring';
  let ring = null;
  let current = null;

  function ensureRing() {
    if (ring && ring.isConnected) return ring;
    ring = document.getElementById(RING_ID);
    if (!ring) {
      ring = document.createElement('div');
      ring.id = RING_ID;
      ring.setAttribute('aria-hidden', 'true');
      document.documentElement.appendChild(ring);
    }
    Object.assign(ring.style, {
      position: 'fixed',
      zIndex: '2147483647',
      pointerEvents: 'none',
      border: '3px solid rgba(125, 200, 255, 0.95)',
      borderRadius: '8px',
      boxShadow: '0 0 0 2px rgba(0,0,0,0.55), 0 0 18px rgba(80,170,255,0.65)',
      transition: 'left 90ms ease, top 90ms ease, width 90ms ease, height 90ms ease',
      display: 'none',
      boxSizing: 'border-box',
    });
    return ring;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') return false;
    if (r.bottom < -4 || r.top > innerHeight + 4 || r.right < -4 || r.left > innerWidth + 4) return false;
    return true;
  }

  function candidates() {
    const out = [];
    const seen = new Set();
    for (const el of document.querySelectorAll(FOCUSABLE)) {
      if (seen.has(el) || !isVisible(el)) continue;
      // Skip the ring itself and anything inside our own overlay.
      if (el.id === RING_ID) continue;
      seen.add(el);
      out.push(el);
    }
    return out;
  }

  function place(el) {
    const r = el.getBoundingClientRect();
    const b = ensureRing();
    b.style.display = 'block';
    b.style.left = `${Math.round(r.left - 4)}px`;
    b.style.top = `${Math.round(r.top - 4)}px`;
    b.style.width = `${Math.round(r.width + 8)}px`;
    b.style.height = `${Math.round(r.height + 8)}px`;
    current = el;
    try {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    } catch {
      // older engines
    }
  }

  function clearRing() {
    const b = ensureRing();
    b.style.display = 'none';
    current = null;
  }

  // Which grid pane the controller is driving. A fixed frame rather than a class on <body>: the
  // page's own CSS is not ours to change, and this has to sit above whatever it draws. It is the
  // same blue as the focus ring, one step quieter, so the active pane reads without competing with
  // the thing actually selected inside it.
  const ACTIVE_ID = '__streamhub_active_frame';
  let activeFrame = null;
  function ensureActiveFrame() {
    if (activeFrame && activeFrame.isConnected) return activeFrame;
    activeFrame = document.getElementById(ACTIVE_ID);
    if (!activeFrame) {
      activeFrame = document.createElement('div');
      activeFrame.id = ACTIVE_ID;
      activeFrame.setAttribute('aria-hidden', 'true');
      document.documentElement.appendChild(activeFrame);
    }
    Object.assign(activeFrame.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483646',
      pointerEvents: 'none',
      border: '3px solid rgba(125, 200, 255, 0.7)',
      boxShadow: 'inset 0 0 24px -8px rgba(80, 170, 255, 0.6)',
      display: 'none',
      boxSizing: 'border-box',
    });
    return activeFrame;
  }
  function setActive(on) {
    const f = ensureActiveFrame();
    f.style.display = on ? 'block' : 'none';
    return { ok: true, active: Boolean(on) };
  }

  function move(dir) {
    const els = candidates();
    if (!els.length) return { ok: false, reason: 'none' };
    if (!current || !current.isConnected || !els.includes(current)) {
      place(els[0]);
      return { ok: true, first: true };
    }
    const cr = current.getBoundingClientRect();
    const cx = cr.left + cr.width / 2;
    const cy = cr.top + cr.height / 2;
    let best = null;
    let bestScore = Infinity;
    for (const el of els) {
      if (el === current) continue;
      const r = el.getBoundingClientRect();
      const ex = r.left + r.width / 2;
      const ey = r.top + r.height / 2;
      const dx = ex - cx;
      const dy = ey - cy;
      let primary;
      let secondary;
      if (dir === 'down') {
        if (dy <= 2) continue;
        primary = dy;
        secondary = Math.abs(dx);
      } else if (dir === 'up') {
        if (dy >= -2) continue;
        primary = -dy;
        secondary = Math.abs(dx);
      } else if (dir === 'right') {
        if (dx <= 2) continue;
        primary = dx;
        secondary = Math.abs(dy);
      } else {
        if (dx >= -2) continue;
        primary = -dx;
        secondary = Math.abs(dy);
      }
      // Prefer straight ahead; a diagonal neighbour is penalised so the ring does not wander.
      const score = primary + secondary * 2.5;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (best) {
      place(best);
      return { ok: true };
    }
    return { ok: false, reason: 'edge' };
  }

  function activate() {
    let el = current;
    if (!el || !el.isConnected) {
      const els = candidates();
      if (!els.length) return { ok: false, reason: 'none' };
      el = els[0];
      place(el);
      return { ok: true, moved: true, tag: el.tagName.toLowerCase() };
    }
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    // Only a field that accepts characters should bring the on-screen keyboard up. A checkbox,
    // radio, button or <select> is operated by clicking, not by typing into it.
    const textField =
      tag === 'textarea' ||
      el.isContentEditable ||
      (tag === 'input' &&
        !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(type));
    if (textField) {
      try {
        el.focus({ preventScroll: true });
        if (tag === 'input') {
          const end = el.value.length;
          el.setSelectionRange?.(end, end);
        }
      } catch {
        // ignore
      }
      return { ok: true, input: true, tag, type, name: el.getAttribute('name') || '', placeholder: el.getAttribute('placeholder') || '' };
    }
    try {
      el.focus({ preventScroll: true });
    } catch {
      // ignore
    }
    try {
      el.click();
    } catch {
      // ignore
    }
    return { ok: true, clicked: true, tag };
  }

  function back() {
    try {
      history.back();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  function dismiss() {
    const direct = [
      '.ytp-ad-skip-button',
      '.ytp-ad-skip-button-modern',
      '.ytp-skip-ad-button',
      '.ytp-ad-overlay-close-button',
      '.ytp-ad-survey-answer-button',
      'button[aria-label*="Skip" i]',
      'button[aria-label*="Close" i]',
      'button[aria-label*="Dismiss" i]',
      '[role="button"][aria-label*="Close" i]',
    ];
    // Return the point to click rather than clicking here: a script's el.click() is untrusted, and
    // YouTube and Disney+ ignore it on their ad-skip buttons. The main process turns these
    // coordinates into a real mouse event, which they do obey.
    const point = (el) => {
      const r = el.getBoundingClientRect();
      return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    };
    for (const sel of direct) {
      for (const el of document.querySelectorAll(sel)) {
        if (isVisible(el)) return { ...point(el), selector: sel };
      }
    }
    // A generic "No thanks / Not now / Continue" dialog button.
    const words = /\b(skip|close|dismiss|no thanks|not now|continue watching|got it|accept)\b/i;
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      if (!isVisible(el)) continue;
      const text = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`;
      if (words.test(text)) return { ...point(el), selector: 'generic' };
    }
    return { ok: false };
  }

  function mediaPlayer() {
    let best = null;
    let bestArea = 0;
    let bestPlaying = false;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      // A stream site leaves hidden previews, billboards and ad placeholders in the page as
      // 0×0 or off-screen <video> elements. Seeking one of those is what made a trigger press
      // on Netflix close the homepage preview instead of moving the film along — only a video
      // the user can actually see is a candidate.
      if (r.width < 160 || r.height < 90) continue;
      if (!isVisible(v)) continue;
      const area = r.width * r.height;
      const playing = !v.paused;
      // A playing video beats a paused one; among equals, the largest wins.
      if (!best || (playing && !bestPlaying) || (playing === bestPlaying && area > bestArea)) {
        best = v;
        bestArea = area;
        bestPlaying = playing;
      }
    }
    return best;
  }

  // Netflix's web player owns its <video> element. Writing currentTime on it makes the player tear
  // the element down and stop playback — the "lt/rt kicks the film off" symptom. Its own player
  // API seeks correctly, in milliseconds. Only the main title is eligible: the homepage billboard
  // and the title-page preview are SUPPLEMENTAL / VIDEO_MERCH sessions, and seeking one of those is
  // the other way a trigger press used to close what was on screen.
  function netflixSessions() {
    try {
      const ctx = window.netflix && window.netflix.appContext;
      const api =
        ctx && ctx.state && ctx.state.playerApp && ctx.state.playerApp.getAPI && ctx.state.playerApp.getAPI();
      const vp = api && api.videoPlayer;
      if (!vp || typeof vp.getAllPlayerSessionIds !== 'function') return null;
      const out = [];
      for (const id of vp.getAllPlayerSessionIds()) {
        let st = null;
        try {
          st = vp.getPlaybackStateBySessionId(id);
        } catch {
          // no state for this session
        }
        if (st && (st.playbackType === 'SUPPLEMENTAL' || st.playbackInitiator === 'VIDEO_MERCH')) continue;
        let p = null;
        try {
          p = vp.getVideoPlayerBySessionId(id);
        } catch {
          // not a player we can drive
        }
        if (p && typeof p.seek === 'function') out.push({ p, st });
      }
      return out;
    } catch {
      return null;
    }
  }

  function netflixSeekBy(deltaMs) {
    if (!window.netflix || !window.netflix.appContext) return null;
    const sessions = netflixSessions();
    if (!sessions) return null; // not a Netflix we recognise; fall back to the element
    if (!sessions.length) return { ok: false, reason: 'no-main-playback' };
    const { p, st } = sessions[0];
    try {
      const cur =
        typeof p.getCurrentTime === 'function' ? p.getCurrentTime() : (st && st.currentTime) || 0;
      const dur = (st && st.duration) || 0;
      const target = Math.max(0, Math.min(dur || Infinity, cur + deltaMs));
      p.seek(target);
      return { ok: true, time: target / 1000 };
    } catch {
      return { ok: false, reason: 'netflix-error' };
    }
  }

  function netflixMedia(action) {
    if (!window.netflix || !window.netflix.appContext) return null;
    if (action === 'forward') return netflixSeekBy(10000);
    if (action === 'back') return netflixSeekBy(-10000);
    const sessions = netflixSessions();
    if (!sessions) return null;
    if (!sessions.length) return { ok: false, reason: 'no-main-playback' };
    const { p, st } = sessions[0];
    try {
      if (action === 'playpause') {
        const paused = typeof p.isPaused === 'function' ? p.isPaused() : Boolean(st && st.paused);
        if (paused) p.play();
        else p.pause();
        return { ok: true, paused: !paused };
      }
    } catch {
      return { ok: false, reason: 'netflix-error' };
    }
    return null;
  }

  // Seek by an arbitrary number of seconds — used by the media keys and MPRIS as well as the
  // triggers. Netflix goes through its player API; everything else moves the visible <video>.
  function seekBy(seconds) {
    const delta = Number(seconds) || 0;
    const nf = netflixSeekBy(delta * 1000);
    if (nf) return nf;
    const v = mediaPlayer();
    if (!v) return { ok: false, reason: 'no-video' };
    try {
      const dur = Number.isFinite(v.duration) ? v.duration : 1e9;
      v.currentTime = Math.max(0, Math.min(dur, v.currentTime + delta));
      return { ok: true, time: v.currentTime };
    } catch {
      return { ok: false, reason: 'seek-error' };
    }
  }

  function media(action) {
    const nf = netflixMedia(action);
    if (nf) return nf;
    const v = mediaPlayer();
    if (!v) return { ok: false, reason: 'no-video' };
    try {
      if (action === 'playpause') {
        if (v.paused) v.play().catch(() => {});
        else v.pause();
        return { ok: true, paused: v.paused };
      }
      if (action === 'forward') {
        v.currentTime = Math.min(Number.isFinite(v.duration) ? v.duration : 1e9, v.currentTime + 10);
        return { ok: true, time: v.currentTime };
      }
      if (action === 'back') {
        v.currentTime = Math.max(0, v.currentTime - 10);
        return { ok: true, time: v.currentTime };
      }
      if (action === 'mute') {
        v.muted = !v.muted;
        return { ok: true, muted: v.muted };
      }
      if (action === 'fullscreen') {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else (v.requestFullscreen ? v.requestFullscreen() : Promise.resolve()).catch(() => {});
        return { ok: true };
      }
    } catch {
      return { ok: false, reason: 'media-error' };
    }
    return { ok: false, reason: 'unknown-action' };
  }

  function scroll(dx, dy) {
    try {
      window.scrollBy({ left: dx, top: dy, behavior: 'auto' });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  function refresh() {
    if (current && current.isConnected && isVisible(current)) place(current);
    else if (current) clearRing();
  }

  window.__streamhubController = { move, activate, back, dismiss, media, seekBy, scroll, refresh, clearRing, setActive };
  ensureRing();

  // Keep the ring glued to its element as the page scrolls or the window changes size.
  let raf = 0;
  const sync = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      refresh();
    });
  };
  window.addEventListener('scroll', sync, { passive: true, capture: true });
  window.addEventListener('resize', sync, { passive: true });
  return 'installed';
}

const PAGE_CONTROLLER_SOURCE = `(${pageController.toString()})()`;

module.exports = { GamepadReader, PAGE_CONTROLLER_SOURCE, BTN, deviceInfo };
