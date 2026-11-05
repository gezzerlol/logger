/* app.js - UI, IndexedDB storage, Web Bluetooth link, charts */
'use strict';
const { SVC, CHR_CTRL, CHR_DATA, CHR_STAT, OP, CFG, PK } = Core;

const $ = (id) => document.getElementById(id);
const state = {
  devices: [],          // stored device records
  sel: null,            // selected device id
  series: null,         // loaded series of the selected device
  span: 86400,          // seconds, 0 = all
  end: null,            // null = follow latest sample
  busy: false,
  link: null,           // open Link (kept while the settings dialog is open)
  cursorT: null,
  view: null,
};
const bleDevices = new Map();   // logger id -> BluetoothDevice (permitted in this browser)

/* ------------------------------------------------------------------------------------------
   Small helpers
   ------------------------------------------------------------------------------------------ */
function log(msg) {
  const el = $('log');
  const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  el.textContent += t + '  ' + msg + '\n';
  el.scrollTop = el.scrollHeight;
}
let toastTimer = null;
function toast(msg, ms = 3500) {
  const el = $('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fmtAgo(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 90) return 'just now';
  if (s < 5400) return Math.round(s / 60) + ' min ago';
  if (s < 86400 * 1.5) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' d ago';
}
function setBusy(b, label) {
  state.busy = b;
  document.body.classList.toggle('busy', b);
  $('sync').disabled = b; $('pick').disabled = b; $('toolSettings').disabled = b;
  $('sync').textContent = b ? (label || 'Working…') : 'Sync';
  if (!b) setProgress(0);
}
function setProgress(f) { $('bar').style.width = Math.round(Math.max(0, Math.min(1, f)) * 100) + '%'; $('progress').hidden = f <= 0; }

/* ------------------------------------------------------------------------------------------
   IndexedDB
   ------------------------------------------------------------------------------------------ */
let dbp = null;
function openDb() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open('esp32-logger', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('devices', { keyPath: 'id' });
      d.createObjectStore('anchors', { autoIncrement: true }).createIndex('dev', 'dev');
      d.createObjectStore('blocks', { keyPath: ['dev', 'gen', 'first'] }).createIndex('dev', 'dev');
      d.createObjectStore('meta', { keyPath: 'key' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
const rq = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function txn(names, mode, fn) {
  const d = await openDb();
  const t = d.transaction(names, mode);
  const done = new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('aborted')); });
  const out = await fn(t);
  await done;
  return out;
}
const dbGetAll = (store, index, key) => txn([store], 'readonly', (t) => {
  const s = t.objectStore(store);
  return rq(index ? s.index(index).getAll(key) : s.getAll());
});
async function metaGet(key) { const r = await txn(['meta'], 'readonly', (t) => rq(t.objectStore('meta').get(key))); return r ? r.value : undefined; }
async function metaSet(key, value) { await txn(['meta'], 'readwrite', (t) => rq(t.objectStore('meta').put({ key, value }))); }

async function loadDevices() {
  state.devices = (await dbGetAll('devices')).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  for (const d of state.devices) {
    const blocks = await dbGetAll('blocks', 'dev', d.id);
    d.count = blocks.reduce((n, b) => { let c = 0; for (let i = 0; i < b.n; i++) if (b.kind[i] === 0) c++; return n + c; }, 0);
  }
}
async function loadSelectedSeries() {
  state.series = null;
  if (!state.sel) return;
  const [blocks, anchors] = await Promise.all([dbGetAll('blocks', 'dev', state.sel), dbGetAll('anchors', 'dev', state.sel)]);
  const dev = state.devices.find((d) => d.id === state.sel);
  state.series = Core.loadSeries(blocks, anchors, (dev && dev.interval) || 60);
}

/* ------------------------------------------------------------------------------------------
   BLE link
   ------------------------------------------------------------------------------------------ */
class Link {
  constructor(dev, ctrl, data, stat) {
    this.dev = dev; this.ctrl = ctrl; this.data = data; this.stat = stat;
    this.queue = []; this.waiter = null; this.closed = false;
  }
  async start() {
    this.dev.addEventListener('gattserverdisconnected', () => { this.closed = true; this._push(null); });
    this.data.addEventListener('characteristicvaluechanged', (e) => {
      const v = e.target.value;
      this._push(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)));
    });
    await this.data.startNotifications();
  }
  _push(p) {
    if (this.waiter) { const w = this.waiter; this.waiter = null; w(p); } else this.queue.push(p);
  }
  next(ms) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.waiter = null; rej(new Error('timeout')); }, ms);
      this.waiter = (p) => { clearTimeout(t); res(p); };
    });
  }
  async status() { return Core.parseStatus(await this.stat.readValue()); }
  async write(bytes) {
    const buf = Uint8Array.from(bytes);
    if (this.ctrl.writeValueWithResponse) await this.ctrl.writeValueWithResponse(buf); else await this.ctrl.writeValue(buf);
  }
  async command(bytes, timeout = 6000) {
    await this.write(bytes);
    const end = Date.now() + timeout;
    for (;;) {
      const left = end - Date.now();
      if (left <= 0) throw new Error('no reply to command ' + bytes[0]);
      const p = await this.next(left);
      if (p === null) throw new Error('disconnected');
      if (p[0] === PK.ACK && p[1] === bytes[0]) return p[2];
    }
  }
  async credit(idx) {            // flow control: records below idx are processed (write without response, cheap)
    const b = new DataView(new ArrayBuffer(5));
    b.setUint8(0, OP.CREDIT); b.setUint32(1, idx, true);
    try {
      const buf = new Uint8Array(b.buffer);
      if (this.ctrl.writeValueWithoutResponse) await this.ctrl.writeValueWithoutResponse(buf); else await this.ctrl.writeValue(buf);
    } catch (e) { /* the next credit repairs it */ }
  }
  async requestFrom(idx) {
    const b = new DataView(new ArrayBuffer(9));
    b.setUint8(0, OP.READ); b.setUint32(1, idx, true); b.setUint32(5, 0xFFFFFFFF, true);
    await this.write(new Uint8Array(b.buffer));
  }
  async readRecords(from, dev, gen, progress, total) {
    this.queue.length = 0;
    const rs = new Core.RecordStream(from, dev, gen);
    await this.requestFrom(from);
    let lastUi = 0, tries = 0;
    while (!rs.done) {
      let p = null, why = null;
      if (!rs.error) {
        try { p = await this.next(4000); } catch (e) { why = 'stalled'; }
        if (!why && p === null) { rs.error = 'disconnected'; break; }
      } else why = rs.error;
      if (!why) {
        const before = rs.expected;
        rs.feed(p);
        if (rs.error) why = rs.error;
        else if (rs.expected !== before) { tries = 0; await this.credit(rs.expected); }
      }
      if (why) {                                  // resume from the last good record
        if (++tries > 6) { rs.error = why; break; }
        log('Transfer ' + why + ' at record ' + rs.expected + ' - resuming (' + tries + '/6)');
        this.queue.length = 0;
        rs.resume();
        await this.requestFrom(rs.expected);
      }
      const now = performance.now();
      if (progress && now - lastUi > 150) { lastUi = now; progress(rs.expected - from, total); }
    }
    rs.finish();
    return rs;
  }
  disconnect() { try { this.dev.gatt.disconnect(); } catch (e) { /* ignore */ } }
}

async function connectBle(bleDev, timeoutMs = 15000) {
  const gatt = bleDev.gatt;
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => { try { gatt.disconnect(); } catch (e) { /* */ } rej(new Error('connection timed out')); }, timeoutMs); });
  try {
    const server = await Promise.race([gatt.connect(), t]);
    const svc = await server.getPrimaryService(SVC);
    const [ctrl, data, stat] = await Promise.all([svc.getCharacteristic(CHR_CTRL), svc.getCharacteristic(CHR_DATA), svc.getCharacteristic(CHR_STAT)]);
    const link = new Link(bleDev, ctrl, data, stat);
    await link.start();
    return link;
  } finally { clearTimeout(timer); }
}

function bleAvailable() { return !!(navigator.bluetooth && navigator.bluetooth.requestDevice); }

async function pickBle() {
  return navigator.bluetooth.requestDevice({ filters: [{ services: [SVC] }], optionalServices: [SVC] });
}

// Connect to the selected logger.  Uses the remembered browser permission when possible,
// otherwise (or when `forcePick`) shows the Bluetooth picker.
async function acquireLink(forcePick) {
  if (!bleAvailable()) throw new Error('Web Bluetooth is not available in this browser. On iPhone use the Bluefy browser.');
  const known = !forcePick && state.sel ? bleDevices.get(state.sel) : null;
  if (known) {
    try { return await connectBle(known, 9000); }
    catch (e) {
      log('Remembered logger not reachable: ' + e.message);
      throw new Error('Logger not in range or asleep. Press its wake button, then tap Sync again.');
    }
  }
  const dev = await pickBle();
  return connectBle(dev, 20000);
}

/* ------------------------------------------------------------------------------------------
   Sync
   ------------------------------------------------------------------------------------------ */
async function doSync(forcePick) {
  if (state.busy) return;
  setBusy(true, 'Connecting…');
  let link = null;
  try {
    link = await acquireLink(forcePick);
    const st = await link.status();
    const wall = Date.now() / 1000;
    if (st.proto !== 1) throw new Error('Unsupported logger protocol ' + st.proto);
    bleDevices.set(st.id, link.dev);

    let dev = state.devices.find((d) => d.id === st.id);
    let gen = dev ? dev.gen : 0, nextIdx = dev ? dev.next_idx : 0;
    if (dev && st.next < nextIdx) { gen++; nextIdx = 0; log(st.name + ': log was reset on the logger, new generation ' + gen); }
    if (dev && st.oldest > nextIdx) log(st.name + ': ' + (st.oldest - nextIdx) + ' records were overwritten before this sync');
    const from = Math.max(nextIdx, st.oldest);
    const total = Math.max(0, st.next - from);
    const rec = {
      id: st.id, name: st.name, bleId: link.dev.id || null, gen, next_idx: nextIdx,
      last_sync: dev ? dev.last_sync : null, battery_mv: st.batt_mv || null, interval: st.interval,
    };
    await txn(['devices', 'anchors'], 'readwrite', (t) => {
      t.objectStore('devices').put(rec);
      t.objectStore('anchors').put({ dev: st.id, gen, session: st.session, wall, up: st.uptime });
    });
    state.sel = st.id;
    log(st.name + ': ' + total + ' new records (session ' + st.session + ', up ' + st.uptime + ' s)');
    if (st.err || !st.store_ok) log('WARNING ' + st.name + ': ' + (st.store_ok ? '' : 'no flash log partition, nothing can be stored! ') + (st.err ? 'last error: ' + st.err_text : ''));
    setBusy(true, total ? 'Downloading…' : 'Finishing…');

    let rs = null;
    if (total > 0) rs = await link.readRecords(from, st.id, gen, (d, t) => setProgress(t ? d / t : 0), total);
    const next = rs && rs.done ? rs.done.next : (rs ? rs.expected : from);
    rec.next_idx = Math.max(from, next);
    rec.last_sync = Date.now() / 1000;
    await txn(['devices', 'blocks'], 'readwrite', (t) => {
      t.objectStore('devices').put(rec);
      if (rs) for (const seg of rs.segments) t.objectStore('blocks').put(seg);
    });
    const code = rs ? (rs.done ? rs.done.code : rs.error) : 0;
    const added = rs ? rs.rows : 0;
    log(st.name + ': stored ' + added + ' rows, status: ' + (code === 0 ? 'ok' : code));
    if (code === 0 && $('sleepAfter').checked) { try { await link.command(Uint8Array.of(OP.SLEEP), 3000); } catch (e) { /* ignore */ } }
    link.disconnect(); link = null;

    await loadDevices();
    await loadSelectedSeries();
    state.end = null;
    renderAll();
    if (code === 0) toast('Synced ' + added.toLocaleString() + ' new records');
    else toast('Sync incomplete (' + code + '). Tap Sync to continue.');
    refreshBackupHint();
  } catch (e) {
    if (e && e.name === 'NotFoundError') { log('No logger chosen.'); }
    else { log('Sync failed: ' + (e && e.message ? e.message : e)); toast(e && e.message ? e.message : 'Sync failed', 6000); }
  } finally {
    if (link) link.disconnect();
    setBusy(false);
  }
}

/* ------------------------------------------------------------------------------------------
   Settings dialog
   ------------------------------------------------------------------------------------------ */
const GUERRILLA = [['Off', null], ['1 hour', 3600], ['24 hours', 86400], ['7 days', 604800], ['Indefinitely', 0]];
let settingsSt = null, keepTimer = null;

async function openSettings() {
  if (state.busy) return;
  setBusy(true, 'Connecting…');
  try {
    const link = await acquireLink(false);
    state.link = link;
    settingsSt = await link.status();
    bleDevices.set(settingsSt.id, link.dev);
    fillSettings(settingsSt);
    $('settingsDlg').showModal();
    clearInterval(keepTimer);
    keepTimer = setInterval(() => { if (state.link && !state.link.closed) state.link.write(Uint8Array.of(OP.KEEPALIVE)).catch(() => {}); }, 30000);
  } catch (e) {
    if (!(e && e.name === 'NotFoundError')) { log('Settings: ' + e.message); toast(e.message, 6000); }
    if (state.link) { state.link.disconnect(); state.link = null; }
  } finally { setBusy(false); }
}
function closeSettings() {
  clearInterval(keepTimer);
  if (state.link) { state.link.disconnect(); state.link = null; }
  if ($('settingsDlg').open) $('settingsDlg').close();
}
function fillSettings(st) {
  $('sName').value = st.name; $('sInterval').value = st.interval; $('sWindow').value = st.window;
  $('sToff').value = (st.temp_off / 100).toFixed(2); $('sCutoff').value = st.cutoff; $('sBcal').value = st.batt_cal;
  $('sGper').value = st.g_period; $('sGburst').value = st.g_burst; $('sErase').checked = false;
  let cur = 'Off';
  if (st.guerrilla) cur = st.g_duration === 0 ? 'Indefinitely' : ((GUERRILLA.find((g) => g[1] === st.g_duration) || ['Keep current'])[0]);
  const sel = $('sGuer'); sel.innerHTML = '';
  const opts = GUERRILLA.map((g) => g[0]); if (!opts.includes(cur)) opts.push(cur);
  for (const o of opts) { const op = document.createElement('option'); op.textContent = o; sel.appendChild(op); }
  sel.value = cur;
  $('sInfo').textContent = 'Firmware ' + st.fw + ' · session ' + st.session + ' · up ' + Math.round(st.uptime / 60) + ' min · battery ' + (st.batt_mv ? (st.batt_mv / 1000).toFixed(2) + ' V' : 'n/a') + (st.usb ? ' · USB' : '');
}
async function applySettings() {
  const st = settingsSt, cmds = [];
  const num = (id, lo, hi, label) => {
    const v = Number($(id).value);
    if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(label + ' must be ' + lo + '–' + hi);
    return v;
  };
  const cfg = (key, val) => { const b = new DataView(new ArrayBuffer(6)); b.setUint8(0, OP.SET_CFG); b.setUint8(1, key); b.setUint32(2, val >>> 0, true); cmds.push(new Uint8Array(b.buffer)); };
  try {
    const name = $('sName').value.trim();
    if (name !== st.name) {
      if (!/^[\x20-\x7e]{1,12}$/.test(name)) throw new Error('Name must be 1–12 plain ASCII characters');
      cmds.push(Uint8Array.from([OP.SET_NAME, ...Array.from(name).map((c) => c.charCodeAt(0))]));
    }
    const iv = num('sInterval', 0.1, 7200, 'Interval'); if (Math.abs(iv - st.interval) > 1e-6) cfg(CFG.INTERVAL_MS, Math.round(iv * 1000));
    const wi = num('sWindow', 20, 900, 'Window'); if (wi !== st.window) cfg(CFG.WINDOW, wi);
    const to = Math.round(num('sToff', -50, 50, 'Temperature offset') * 100); if (to !== st.temp_off) cfg(CFG.TEMPOFF, to & 0xFFFF);
    const co = Number($('sCutoff').value); if (co !== 0 && !(co >= 2800 && co <= 3800)) throw new Error('Cut-off must be 0 or 2800–3800');
    if (co !== st.cutoff) cfg(CFG.CUTOFF, co);
    const bc = num('sBcal', 800, 1200, 'Battery calibration'); if (bc !== st.batt_cal) cfg(CFG.BATTCAL, bc);
    const gp = num('sGper', 3, 60, 'Guerrilla period'); if (gp !== st.g_period) cfg(CFG.GPERIOD, gp);
    const gb = num('sGburst', 50, 3000, 'Guerrilla burst'); if (gb !== st.g_burst) cfg(CFG.GBURST, gb);
    const g = GUERRILLA.find((x) => x[0] === $('sGuer').value);
    if (g) { const b = new DataView(new ArrayBuffer(6)); b.setUint8(0, OP.GUERRILLA); b.setUint8(1, g[1] === null ? 0 : 1); b.setUint32(2, g[1] || 0, true); cmds.push(new Uint8Array(b.buffer)); }
  } catch (e) { toast(e.message, 4000); return; }
  const erase = $('sErase').checked;
  if (erase && !confirm('Erase all records stored on the logger? Data already synced to this phone is kept.')) return;
  const link = state.link;
  if (!link || link.closed) { toast('Connection lost. Close this dialog and open Settings again.', 5000); return; }
  $('sApply').disabled = true;
  try {
    const bad = [];
    for (const c of cmds) { const r = await link.command(c); if (r !== 0) bad.push('0x' + c[0].toString(16) + '=' + r); }
    if (erase) { const r = await link.command(Uint8Array.of(OP.ERASE, 0xE5, 0xA5)); if (r !== 0) bad.push('erase=' + r); }
    const ns = await link.status();
    const dev = state.devices.find((d) => d.id === ns.id);
    if (dev) { dev.name = ns.name; dev.interval = ns.interval; await txn(['devices'], 'readwrite', (t) => rq(t.objectStore('devices').put(dev))); }
    log(bad.length ? 'Rejected by logger: ' + bad.join(', ') : 'Settings applied');
    toast(bad.length ? 'Some settings were rejected' : 'Settings saved');
    closeSettings();
    renderAll();
  } catch (e) { log('Settings failed: ' + e.message); toast('Settings failed: ' + e.message, 5000); }
  finally { $('sApply').disabled = false; }
}

/* ------------------------------------------------------------------------------------------
   Charts
   ------------------------------------------------------------------------------------------ */
const RANGES = [['1h', 3600], ['6h', 21600], ['24h', 86400], ['7d', 604800], ['30d', 2592000], ['All', 0]];
const CHARTS = [
  { id: 'cTemp', key: 'temp', cssVar: '--c-temp', dec: 1, unit: '°C' },
  { id: 'cHum', key: 'hum', cssVar: '--c-hum', dec: 0, unit: '%' },
  { id: 'cPress', key: 'press', cssVar: '--c-press', dec: 1, unit: 'hPa' },
  { id: 'cBatt', key: 'batt', cssVar: '--c-batt', dec: 2, unit: 'V' },
];

function computeView() {
  const s = state.series;
  if (!s || !s.t.length) return null;
  let lo, hi;
  if (state.span === 0) { lo = s.t[0]; hi = s.t[s.t.length - 1] + 1; }
  else { hi = state.end !== null ? state.end : s.t[s.t.length - 1]; lo = hi - state.span; }
  const i0 = Core.lowerBound(s.t, lo), i1 = Core.upperBound(s.t, hi);
  const tt = s.t.subarray(i0, i1);
  const interval = (state.devices.find((d) => d.id === state.sel) || {}).interval || 60;
  const view = { lo, hi, n: tt.length, charts: {}, hit: null, bucket: 0, est: false };
  const j0 = Core.lowerBound(s.bt, lo), j1 = Core.upperBound(s.bt, hi);
  const bt = s.bt.subarray(j0, j1), bmv = s.bmv.subarray(j0, j1);
  for (let i = i0; i < i1; i++) if (s.est[i]) { view.est = true; break; }
  if (tt.length) {
    const vals = [s.temp.subarray(i0, i1), s.hum.subarray(i0, i1), s.press.subarray(i0, i1)];
    const span = Math.max(60, tt[tt.length - 1] - tt[0]);
    let gap = Math.max(interval * 4, 300);
    let x = tt, ser;
    if (tt.length > 1500) {
      view.bucket = Math.max(interval, Math.ceil(span / 700 / 60) * 60);
      const ag = Core.bucketize(tt, vals, view.bucket);
      x = ag.t; ser = ag.series; gap = Math.max(gap, view.bucket * 3);
    } else ser = vals.map((v) => ({ mean: Array.from(v) }));
    const keys = ['temp', 'hum', 'press'];
    for (let k = 0; k < 3; k++) {
      const arrs = [ser[k].mean]; if (ser[k].min) arrs.push(ser[k].min, ser[k].max);
      const bg = Core.breakGaps(x, arrs, gap);
      view.charts[keys[k]] = { x: bg.t, y: bg.arrs[0], lo: bg.arrs[1], hi: bg.arrs[2] };
    }
    view.hit = { x: Array.from(x), temp: ser[0].mean, hum: ser[1].mean, press: ser[2].mean };
    view.usb = [];
    if (!view.bucket) for (let i = i0; i < i1; i++) if (s.usb[i]) view.usb.push(s.t[i]);
  }
  if (bt.length) {
    const bg = Core.breakGaps(Array.from(bt), [Array.from(bmv, (m) => m / 1000)], Math.max(1800 * 3, interval * 4));
    view.charts.batt = { x: bg.t, y: bg.arrs[0] };
  }
  return view;
}

function niceStep(span) {
  const steps = [60, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800, 1209600, 2592000];
  for (const s of steps) if (span / s <= 6) return s;
  return steps[steps.length - 1];
}
function fmtTick(t, step) {
  const d = new Date(t * 1000);
  if (step >= 86400) return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return (d.getHours() === 0 && d.getMinutes() === 0) ? d.toLocaleDateString([], { day: 'numeric', month: 'short' }) : hm;
}

function drawChart(cfg, view, last) {
  const cv = $(cfg.id), data = view && view.charts[cfg.key];
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const col = css.getPropertyValue(cfg.cssVar).trim(), grid = css.getPropertyValue('--grid').trim(), mute = css.getPropertyValue('--muted').trim();
  const L = 46, R = 8, T = 6, B = last ? 20 : 4, pw = w - L - R, ph = h - T - B;
  ctx.font = '11px system-ui, -apple-system, sans-serif';
  if (!view || !data) { ctx.fillStyle = mute; ctx.textAlign = 'center'; ctx.fillText('No data', w / 2, h / 2); return; }
  let mn = Infinity, mx = -Infinity;
  const scan = (a) => { if (!a) return; for (const v of a) if (v === v) { if (v < mn) mn = v; if (v > mx) mx = v; } };
  scan(data.lo); scan(data.hi); scan(data.y);
  if (!isFinite(mn)) { ctx.fillStyle = mute; ctx.textAlign = 'center'; ctx.fillText('No data', w / 2, h / 2); return; }
  const minSpan = { temp: 1, hum: 4, press: 2, batt: 0.2 }[cfg.key];
  if (mx - mn < minSpan) { const c = (mx + mn) / 2; mn = c - minSpan / 2; mx = c + minSpan / 2; }
  const pad = (mx - mn) * 0.08; mn -= pad; mx += pad;
  const X = (t) => L + (t - view.lo) / (view.hi - view.lo) * pw;
  const Y = (v) => T + (1 - (v - mn) / (mx - mn)) * ph;
  // grid + y labels
  ctx.lineWidth = 1; ctx.strokeStyle = grid; ctx.fillStyle = mute; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let i = 0; i <= 3; i++) {
    const v = mn + (mx - mn) * (i / 3), y = Y(v);
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - R, y); ctx.stroke();
    ctx.fillText(v.toFixed(cfg.dec), L - 6, y);
  }
  // x ticks
  const step = niceStep(view.hi - view.lo);
  const off = new Date(view.lo * 1000).getTimezoneOffset() * 60;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let t = Math.ceil((view.lo - off) / step) * step + off; t <= view.hi; t += step) {
    const x = X(t);
    ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + ph); ctx.stroke();
    if (last) ctx.fillText(fmtTick(t, step), Math.min(w - 20, Math.max(L + 14, x)), T + ph + 5);
  }
  ctx.save(); ctx.beginPath(); ctx.rect(L, T, pw, ph); ctx.clip();
  // min/max band
  if (data.lo) {
    ctx.fillStyle = col; ctx.globalAlpha = 0.16;
    let seg = [];
    const flush = () => {
      if (seg.length > 1) {
        ctx.beginPath();
        seg.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.hi)) : ctx.moveTo(X(p.x), Y(p.hi))));
        for (let i = seg.length - 1; i >= 0; i--) ctx.lineTo(X(seg[i].x), Y(seg[i].lo));
        ctx.closePath(); ctx.fill();
      }
      seg = [];
    };
    for (let i = 0; i < data.x.length; i++) { if (data.y[i] !== data.y[i]) flush(); else seg.push({ x: data.x[i], lo: data.lo[i], hi: data.hi[i] }); }
    flush(); ctx.globalAlpha = 1;
  }
  // line
  ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
  ctx.beginPath();
  let pen = false, pts = 0;
  for (let i = 0; i < data.x.length; i++) {
    const v = data.y[i];
    if (v !== v) { pen = false; continue; }
    const x = X(data.x[i]), y = Y(v);
    if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
    pts++;
  }
  ctx.stroke();
  if (pts < 150) {
    ctx.fillStyle = col;
    for (let i = 0; i < data.x.length; i++) { const v = data.y[i]; if (v === v) { ctx.beginPath(); ctx.arc(X(data.x[i]), Y(v), 2, 0, 6.3); ctx.fill(); } }
  }
  // USB ticks (temperature chart only)
  if (cfg.key === 'temp' && view.usb && view.usb.length) {
    ctx.strokeStyle = css.getPropertyValue('--usb').trim(); ctx.lineWidth = 1.5;
    for (const t of view.usb) { const x = X(t); ctx.beginPath(); ctx.moveTo(x, T + ph - 7); ctx.lineTo(x, T + ph); ctx.stroke(); }
  }
  ctx.restore();
  // cursor
  if (state.cursorT !== null && state.cursorT >= view.lo && state.cursorT <= view.hi) {
    const x = X(state.cursorT);
    ctx.strokeStyle = mute; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + ph); ctx.stroke(); ctx.setLineDash([]);
  }
  cv._geom = { L, pw, lo: view.lo, hi: view.hi };
}

function renderCharts() {
  const view = computeView();
  state.view = view;
  const none = !view;
  $('chartsEmpty').hidden = !none;
  $('charts').classList.toggle('none', none);       // no data: show only the message, not the empty chart frames
  if (!none) CHARTS.forEach((c, i) => drawChart(c, view, i === CHARTS.length - 1));
  if (view) {
    const f = (t) => new Date(t * 1000).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
    $('rangeInfo').textContent = f(view.lo) + ' → ' + f(view.hi) + (view.bucket ? ' · ' + Math.round(view.bucket / 60) + ' min buckets' : '');
    $('estNote').hidden = !view.est;
  } else { $('rangeInfo').textContent = ''; $('estNote').hidden = true; }
  if (state.cursorT === null) $('readout').textContent = view && view.hit ? 'Touch a chart to read values' : '';
}

function scrub(ev) {
  const cv = ev.currentTarget, g = cv._geom, v = state.view;
  if (!g || !v || !v.hit) return;
  const r = cv.getBoundingClientRect();
  const frac = (ev.clientX - r.left - g.L) / g.pw;
  if (frac < 0 || frac > 1) return;
  const t = g.lo + frac * (g.hi - g.lo), xs = v.hit.x;
  let i = Core.lowerBound(xs, t);
  if (i >= xs.length) i = xs.length - 1;
  if (i > 0 && Math.abs(xs[i - 1] - t) < Math.abs(xs[i] - t)) i--;
  state.cursorT = xs[i];
  const d = new Date(xs[i] * 1000);
  $('readout').textContent = d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) +
    '  ·  ' + v.hit.temp[i].toFixed(1) + ' °C  ·  ' + v.hit.hum[i].toFixed(0) + ' %  ·  ' + v.hit.press[i].toFixed(1) + ' hPa';
  CHARTS.forEach((c, k) => drawChart(c, v, k === CHARTS.length - 1));
}
function clearScrub() { state.cursorT = null; renderCharts(); }

/* ------------------------------------------------------------------------------------------
   Rendering the rest of the UI
   ------------------------------------------------------------------------------------------ */
function renderChips() {
  const box = $('chips');
  box.innerHTML = '';
  for (const d of state.devices) {
    const b = document.createElement('button');
    b.className = 'chip' + (d.id === state.sel ? ' on' : '');
    b.textContent = d.name || d.id.slice(-4);
    b.onclick = async () => { state.sel = d.id; state.end = null; state.cursorT = null; await loadSelectedSeries(); renderAll(); };
    box.appendChild(b);
  }
}
function renderHero() {
  const d = state.devices.find((x) => x.id === state.sel), s = state.series;
  $('devName').textContent = d ? d.name : 'No logger yet';
  if (!d) {
    $('devMeta').textContent = 'Tap “Add logger”, pick it in the Bluetooth list, and it will sync.';
    for (const id of ['hT', 'hH', 'hP', 'hB']) $(id).textContent = '–';
    return;
  }
  $('devMeta').textContent = 'Synced ' + fmtAgo(d.last_sync) + ' · ' + (d.count || 0).toLocaleString() + ' samples';
  if (s && s.t.length) {
    const i = s.t.length - 1;
    $('hT').textContent = s.temp[i].toFixed(1); $('hH').textContent = s.hum[i].toFixed(0); $('hP').textContent = s.press[i].toFixed(0);
    $('hTime').textContent = 'at ' + new Date(s.t[i] * 1000).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  } else { for (const id of ['hT', 'hH', 'hP']) $(id).textContent = '–'; $('hTime').textContent = ''; }
  const bi = s && s.bt.length ? s.bt.length - 1 : -1;
  $('hB').textContent = bi >= 0 ? (s.bmv[bi] / 1000).toFixed(2) : (d.battery_mv ? (d.battery_mv / 1000).toFixed(2) : '–');
}
function renderAll() { renderChips(); renderHero(); renderRangeButtons(); renderCharts(); }
function renderRangeButtons() {
  for (const b of document.querySelectorAll('#ranges button')) b.classList.toggle('on', Number(b.dataset.span) === state.span);
}

/* ------------------------------------------------------------------------------------------
   Backup / restore / export
   ------------------------------------------------------------------------------------------ */
async function shareOrDownload(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
async function exportCsv() {
  if (!state.series) { toast('Nothing to export yet'); return; }
  const d = state.devices.find((x) => x.id === state.sel);
  const csv = Core.toCsv(state.series), day = new Date().toISOString().slice(0, 10);
  await shareOrDownload(new Blob([csv.samples], { type: 'text/csv' }), (d.name || 'logger') + '_' + day + '.csv');
  await shareOrDownload(new Blob([csv.battery], { type: 'text/csv' }), (d.name || 'logger') + '_' + day + '_battery.csv');
}
const arr = (x) => Array.prototype.slice.call(x);
async function backup() {
  const [devices, anchors, blocks] = await Promise.all([dbGetAll('devices'), dbGetAll('anchors'), dbGetAll('blocks')]);
  const json = JSON.stringify({
    format: 'esp32-logger-backup', version: 1, created: Date.now(), devices, anchors,
    blocks: blocks.map((b) => ({ dev: b.dev, gen: b.gen, first: b.first, session: b.session, n: b.n, sec: arr(b.sec), kind: arr(b.kind), t: arr(b.t), h: arr(b.h), p: arr(b.p), usb: arr(b.usb), mv: arr(b.mv) })),
  });
  let blob, name = 'logger-backup-' + new Date().toISOString().slice(0, 10);
  if (typeof CompressionStream !== 'undefined') {
    blob = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
    blob = new Blob([blob], { type: 'application/gzip' }); name += '.json.gz';
  } else { blob = new Blob([json], { type: 'application/json' }); name += '.json'; }
  await shareOrDownload(blob, name);
  await metaSet('lastBackup', Date.now());
  refreshBackupHint();
  toast('Backup created');
}
async function restore(file) {
  try {
    let text;
    const buf = new Uint8Array(await file.arrayBuffer());
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot read .gz files');
      text = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    } else text = new TextDecoder().decode(buf);
    const o = JSON.parse(text);
    if (o.format !== 'esp32-logger-backup') throw new Error('Not a logger backup file');
    const have = await dbGetAll('devices');
    const anchors = await dbGetAll('anchors');
    const seen = new Set(anchors.map((a) => [a.dev, a.gen, a.session, a.wall].join('|')));
    await txn(['devices', 'anchors', 'blocks'], 'readwrite', (t) => {
      const ds = t.objectStore('devices');
      for (const d of o.devices) {
        const cur = have.find((x) => x.id === d.id);
        if (cur && (cur.gen > d.gen || (cur.gen === d.gen && cur.next_idx >= d.next_idx))) continue;   // keep the newer one
        ds.put(d);
      }
      const as = t.objectStore('anchors');
      for (const a of o.anchors) { if (!seen.has([a.dev, a.gen, a.session, a.wall].join('|'))) as.put(a); }
      const bs = t.objectStore('blocks');
      for (const b of o.blocks) {
        bs.put({ dev: b.dev, gen: b.gen, first: b.first, session: b.session, n: b.n, sec: Int32Array.from(b.sec), kind: Uint8Array.from(b.kind),
          t: Int16Array.from(b.t), h: Uint16Array.from(b.h), p: Uint32Array.from(b.p), usb: Uint8Array.from(b.usb), mv: Uint16Array.from(b.mv) });
      }
    });
    await loadDevices();
    if (!state.sel && state.devices.length) state.sel = state.devices[0].id;
    await loadSelectedSeries();
    renderAll();
    toast('Backup restored');
  } catch (e) { log('Restore failed: ' + e.message); toast('Restore failed: ' + e.message, 6000); }
}
async function removeData() {
  const d = state.devices.find((x) => x.id === state.sel);
  if (!d || !confirm('Delete all data stored on this phone for "' + d.name + '"? The logger itself is not touched.')) return;
  const blocks = await dbGetAll('blocks', 'dev', d.id);
  await txn(['devices', 'blocks', 'anchors'], 'readwrite', async (t) => {
    t.objectStore('devices').delete(d.id);
    for (const b of blocks) t.objectStore('blocks').delete([b.dev, b.gen, b.first]);
    const keys = await rq(t.objectStore('anchors').index('dev').getAllKeys(d.id));
    for (const k of keys) t.objectStore('anchors').delete(k);
  });
  bleDevices.delete(d.id);
  await loadDevices();
  state.sel = state.devices.length ? state.devices[0].id : null;
  await loadSelectedSeries();
  renderAll();
}
async function refreshBackupHint() {
  const last = await metaGet('lastBackup');
  const total = state.devices.reduce((n, d) => n + (d.count || 0), 0);
  const stale = total > 0 && (!last || Date.now() - last > 14 * 86400e3);
  $('backupBtn').classList.toggle('attn', stale);
  $('backupInfo').textContent = last ? 'Last backup: ' + fmtAgo(last / 1000) : 'No backup yet';
}

/* ------------------------------------------------------------------------------------------
   Startup
   ------------------------------------------------------------------------------------------ */
async function init() {
  const ranges = $('ranges');
  for (const [label, span] of RANGES) {
    const b = document.createElement('button');
    b.textContent = label; b.dataset.span = span;
    b.onclick = () => { state.span = span; state.end = null; state.cursorT = null; renderRangeButtons(); renderCharts(); };
    ranges.appendChild(b);
  }
  $('prev').onclick = () => shift(-1); $('next').onclick = () => shift(1); $('latest').onclick = () => { state.end = null; renderCharts(); };
  $('sync').onclick = () => doSync(false);
  $('pick').onclick = () => doSync(true);
  $('toolSettings').onclick = openSettings;
  $('sCancel').onclick = closeSettings; $('sApply').onclick = applySettings;
  $('settingsDlg').addEventListener('close', () => { clearInterval(keepTimer); if (state.link) { state.link.disconnect(); state.link = null; } });
  $('toolCsv').onclick = exportCsv;
  $('backupBtn').onclick = backup;
  $('restoreFile').onchange = (e) => { if (e.target.files[0]) restore(e.target.files[0]); e.target.value = ''; };
  $('toolRemove').onclick = removeData;
  for (const c of CHARTS) {
    const cv = $(c.id);
    cv.addEventListener('pointerdown', scrub); cv.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'mouse') scrub(e); });
    cv.addEventListener('dblclick', clearScrub);
  }
  new ResizeObserver(() => renderCharts()).observe($('charts'));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderCharts);

  if (!bleAvailable()) {
    $('noBle').hidden = false;
    $('sync').disabled = true; $('pick').disabled = true;
  }
  try { if (navigator.storage && navigator.storage.persist) { const ok = await navigator.storage.persist(); $('persist').textContent = ok ? 'Phone storage: protected from automatic cleanup' : 'Phone storage may be cleaned up by the browser – keep backups'; } } catch (e) { /* ignore */ }

  await loadDevices();
  if (state.devices.length) state.sel = state.devices[0].id;
  // reconnect permission for loggers that were picked before (not supported by every browser)
  try {
    if (navigator.bluetooth && navigator.bluetooth.getDevices) {
      for (const bd of await navigator.bluetooth.getDevices()) {
        const d = state.devices.find((x) => x.bleId && x.bleId === bd.id);
        if (d) bleDevices.set(d.id, bd);
      }
    }
  } catch (e) { /* ignore */ }
  await loadSelectedSeries();
  renderAll();
  refreshBackupHint();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
  setInterval(() => { renderHero(); }, 60000);
}
function shift(dir) {
  const s = state.series;
  if (!s || !s.t.length || state.span === 0) return;
  const cur = state.end !== null ? state.end : s.t[s.t.length - 1];
  state.end = Math.min(cur + dir * state.span * 0.5, s.t[s.t.length - 1] + state.span * 0.05);
  renderCharts();
}
init().catch((e) => { log('Startup error: ' + e.message); });
