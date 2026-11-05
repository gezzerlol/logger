/* core.js - protocol parsing, time mapping and data helpers (no DOM, no BLE; runs in browser and Node) */
(function (root) {
  'use strict';

  const SVC = '7a1c0001-5b6e-4d23-9a0f-3d8b2e6c1f00';
  const CHR_CTRL = '7a1c0002-5b6e-4d23-9a0f-3d8b2e6c1f00';
  const CHR_DATA = '7a1c0003-5b6e-4d23-9a0f-3d8b2e6c1f00';
  const CHR_STAT = '7a1c0004-5b6e-4d23-9a0f-3d8b2e6c1f00';
  const OP = { READ: 2, SET_CFG: 3, SET_NAME: 4, GUERRILLA: 5, ERASE: 6, KEEPALIVE: 7, SLEEP: 8, ABORT: 9, CREDIT: 10 };
  const CFG = { INTERVAL: 1, WINDOW: 2, TEMPOFF: 3, CUTOFF: 4, BATTCAL: 5, GPERIOD: 6, GBURST: 7 };
  const PK = { DATA: 1, HDR: 2, DONE: 3, ACK: 4 };
  const STAT_LEN = 70;

  const ERR_TEXT = ['ok', 'I2C start failed', 'sensor does not answer (check wiring/solder)', 'wrong chip (BMP280 has no humidity)',
    'calibration read failed', 'could not start measurement', 'could not read measurement', 'implausible measurement',
    'no flash log partition', 'flash write failed'];
  function parseStatus(dv) {
    if (dv.byteLength < STAT_LEN) throw new Error('status too short (' + dv.byteLength + ' bytes)');
    const u8 = (o) => dv.getUint8(o), u16 = (o) => dv.getUint16(o, true), u32 = (o) => dv.getUint32(o, true);
    const flags = u8(28);
    let name = '';
    for (let i = 48; i < 64; i++) { const c = u8(i); if (!c) break; name += String.fromCharCode(c); }
    let id = '';
    for (let i = 64; i < 70; i++) id += u8(i).toString(16).padStart(2, '0').toUpperCase();
    return {
      proto: u8(0), fw: u8(1), session: u16(2), uptime: u32(4), oldest: u32(8), next: u32(12),
      interval: u16(16), batt_mv: u16(18), window: u16(20), cutoff: u16(22), batt_cal: u16(24),
      temp_off: dv.getInt16(26, true),
      usb: !!(flags & 1), full: !!(flags & 2), guerrilla: !!(flags & 4), cutoff_active: !!(flags & 8), fault: !!(flags & 16),
      g_period: u8(29), g_burst: u16(30), g_duration: u32(32), g_remaining: u32(36),
      last_t: dv.getInt16(40, true) / 100, last_h: u16(42) / 100, last_p: u32(44) / 100,
      name, id,
      err: dv.byteLength > 70 ? u8(70) : 0, store_ok: dv.byteLength > 71 ? !!u8(71) : true,
      err_text: ERR_TEXT[dv.byteLength > 70 ? u8(70) : 0] || 'error',
    };
  }

  /* ---- record stream parser --------------------------------------------------------
     feed() every notification in order.  Produces `segments` (columns of decoded rows, one per
     firmware sector-run) and, when the logger finishes, `done = {next, code}`. */
  class RecordStream {
    constructor(fromIdx, dev, gen) {
      this.dev = dev; this.gen = gen;
      this.expected = fromIdx; this.session = null; this.sec = 0;
      this.seg = null; this.segments = []; this.rows = 0; this.error = null; this.done = null;
    }
    _flush() {
      if (this.seg && this.seg.n > 0) this.segments.push(this._pack(this.seg));
      this.seg = null;
    }
    _pack(s) {
      return {
        dev: this.dev, gen: this.gen, first: s.first, session: s.session, n: s.n,
        sec: Int32Array.from(s.sec), kind: Uint8Array.from(s.kind), t: Int16Array.from(s.t),
        h: Uint16Array.from(s.h), p: Uint32Array.from(s.p), usb: Uint8Array.from(s.usb), mv: Uint16Array.from(s.mv),
      };
    }
    finish() { this._flush(); }
    // restart after a stall / desync: keep what was decoded, the logger resends from `expected` with a new header
    resume() { this._flush(); this.session = null; this.error = null; }
    feed(u8) {
      if (this.error || this.done) return;
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      switch (u8[0]) {
        case PK.HDR: {
          this._flush();
          const session = dv.getUint16(1, true), idx = dv.getUint32(3, true), sec = dv.getUint32(7, true);
          if (idx !== this.expected) { this.error = 'desync'; return; }
          this.session = session; this.sec = sec;
          break;
        }
        case PK.DATA: {
          const idx = dv.getUint32(1, true);
          if (idx !== this.expected || this.session === null) { this.error = 'desync'; return; }
          const n = Math.floor((u8.byteLength - 5) / 8);
          for (let i = 0; i < n; i++) {
            const o = 5 + i * 8;
            const w0 = dv.getUint16(o, true), w1 = dv.getUint16(o + 2, true), w2 = dv.getUint32(o + 4, true);
            if (!(w0 === 0xFFFF && w1 === 0xFFFF && w2 === 0xFFFFFFFF)) {
              this.sec += (w2 >>> 17) & 0x1FFF;
              const hum = w1 & 0x3FFF, usb = (w1 >> 14) & 1, meta = (w1 >> 15) & 1;
              let kind = -1, t = 0, h = 0, p = 0, mv = 0;
              if (meta) { kind = 1; mv = w0; }
              else {
                p = w2 & 0x1FFFF;
                if (hum <= 10000 && p >= 30000 && p <= 125000) { kind = 0; t = w0 >= 0x8000 ? w0 - 0x10000 : w0; h = hum; }
              }
              if (kind >= 0) {
                if (!this.seg) this.seg = { first: this.expected + i, session: this.session, n: 0, sec: [], kind: [], t: [], h: [], p: [], usb: [], mv: [] };
                const s = this.seg;
                s.n++; s.sec.push(this.sec); s.kind.push(kind); s.t.push(t); s.h.push(h); s.p.push(p); s.usb.push(usb); s.mv.push(mv);
                this.rows++;
              }
            }
          }
          this.expected += n;
          break;
        }
        case PK.DONE:
          this._flush();
          this.done = { next: dv.getUint32(1, true), code: u8[5] };
          break;
        default: break;   // ACK and unknown packets are handled by the caller
      }
    }
  }

  /* ---- time mapping ------------------------------------------------------------------ */
  function median(a) {
    const s = Array.from(a).sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // anchors: [{dev,gen,session,wall,up}], order: keys (gen*65536+session) in chronological order
  function buildTimeMap(anchors, order, lastSec, intervalGuess) {
    const groups = new Map();
    for (const a of anchors) {
      const k = a.gen * 65536 + a.session;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(a);
    }
    const tm = new Map();
    for (const [key, A] of groups) {
      let k = 1;
      const ups = A.map((a) => a.up), walls = A.map((a) => a.wall);
      const span = Math.max(...ups) - Math.min(...ups);
      if (A.length >= 2 && span >= 600) {
        const mu = ups.reduce((x, y) => x + y, 0) / ups.length, mw = walls.reduce((x, y) => x + y, 0) / walls.length;
        let num = 0, den = 0;
        for (let i = 0; i < ups.length; i++) { num += (ups[i] - mu) * (walls[i] - mw); den += (ups[i] - mu) * (ups[i] - mu); }
        if (den > 0) k = Math.min(1.05, Math.max(0.95, num / den));
      }
      tm.set(key, { start: median(walls.map((w, i) => w - k * ups[i])), k, est: false });
    }
    // sessions that ended before any sync: place just before the next known session, flagged estimated
    let nextStart = null;
    for (let i = order.length - 1; i >= 0; i--) {
      const key = order[i];
      if (tm.has(key)) { nextStart = tm.get(key).start; continue; }
      if (nextStart === null) continue;
      const start = nextStart - (lastSec.get(key) || 0) - (intervalGuess || 60);
      tm.set(key, { start, k: 1, est: true });
      nextStart = start;
    }
    return tm;
  }

  // blocks: stored segments; returns typed-array series with wall-clock times
  function loadSeries(blocks, anchors, intervalGuess) {
    if (!blocks.length) return null;
    blocks = blocks.slice().sort((a, b) => a.gen - b.gen || a.first - b.first);
    const order = [], seen = new Set(), lastSec = new Map();
    let N = 0;
    for (const b of blocks) {
      const key = b.gen * 65536 + b.session;
      if (!seen.has(key)) { seen.add(key); order.push(key); }
      const ls = b.sec[b.n - 1];
      if (!(lastSec.get(key) >= ls)) lastSec.set(key, ls);
      N += b.n;
    }
    const tm = buildTimeMap(anchors, order, lastSec, intervalGuess);
    let ts = 0, tb = 0;
    for (const b of blocks) for (let i = 0; i < b.n; i++) { if (b.kind[i] === 0) ts++; else tb++; }
    const out = {
      t: new Float64Array(ts), temp: new Float32Array(ts), hum: new Float32Array(ts), press: new Float32Array(ts),
      usb: new Uint8Array(ts), est: new Uint8Array(ts),
      bt: new Float64Array(tb), bmv: new Float32Array(tb), bus: new Uint8Array(tb),
    };
    let si = 0, bi = 0;
    for (const b of blocks) {
      const m = tm.get(b.gen * 65536 + b.session);
      if (!m) continue;
      for (let i = 0; i < b.n; i++) {
        const wall = m.start + m.k * b.sec[i];
        if (b.kind[i] === 0) {
          out.t[si] = wall; out.temp[si] = b.t[i] / 100; out.hum[si] = b.h[i] / 100; out.press[si] = b.p[i] / 100;
          out.usb[si] = b.usb[i]; out.est[si] = m.est ? 1 : 0; si++;
        } else {
          out.bt[bi] = wall; out.bmv[bi] = b.mv[i]; out.bus[bi] = b.usb[i]; bi++;
        }
      }
    }
    return sortSeries(trim(out, si, bi));
  }
  function trim(o, si, bi) {
    const r = {};
    for (const k of ['t', 'temp', 'hum', 'press', 'usb', 'est']) r[k] = o[k].subarray(0, si);
    for (const k of ['bt', 'bmv', 'bus']) r[k] = o[k].subarray(0, bi);
    return r;
  }
  function sortSeries(o) {
    const reorder = (keys, tk) => {
      const n = o[tk].length;
      let sorted = true;
      for (let i = 1; i < n; i++) if (o[tk][i] < o[tk][i - 1]) { sorted = false; break; }
      if (sorted) return;
      const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => o[tk][a] - o[tk][b]);
      for (const k of keys) { const src = o[k], dst = new src.constructor(n); for (let i = 0; i < n; i++) dst[i] = src[idx[i]]; o[k] = dst; }
    };
    reorder(['t', 'temp', 'hum', 'press', 'usb', 'est'], 't');
    reorder(['bt', 'bmv', 'bus'], 'bt');
    return o;
  }

  /* ---- aggregation --------------------------------------------------------------------- */
  // t sorted; vals: array of arrays.  returns {t, series:[{mean,min,max}]}
  function bucketize(t, vals, bucket) {
    const n = t.length, bt = [], out = vals.map(() => ({ mean: [], min: [], max: [] }));
    let i = 0;
    while (i < n) {
      const b = Math.floor(t[i] / bucket);
      let j = i, st = 0;
      const sum = vals.map(() => 0), cnt = vals.map(() => 0), mn = vals.map(() => Infinity), mx = vals.map(() => -Infinity);
      while (j < n && Math.floor(t[j] / bucket) === b) {
        st += t[j];
        for (let k = 0; k < vals.length; k++) {
          const v = vals[k][j];
          if (v === v) { sum[k] += v; cnt[k]++; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
        }
        j++;
      }
      bt.push(st / (j - i));
      for (let k = 0; k < vals.length; k++) {
        out[k].mean.push(cnt[k] ? sum[k] / cnt[k] : NaN);
        out[k].min.push(cnt[k] ? mn[k] : NaN);
        out[k].max.push(cnt[k] ? mx[k] : NaN);
      }
      i = j;
    }
    return { t: bt, series: out };
  }

  // insert NaN where consecutive times are further apart than gap, so lines do not bridge outages
  function breakGaps(t, arrs, gap) {
    const T = [], A = arrs.map(() => []);
    for (let i = 0; i < t.length; i++) {
      if (i > 0 && t[i] - t[i - 1] > gap) { T.push(t[i - 1] + 1); A.forEach((a) => a.push(NaN)); }
      T.push(t[i]);
      for (let k = 0; k < arrs.length; k++) A[k].push(arrs[k][i]);
    }
    return { t: T, arrs: A };
  }

  function lowerBound(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }
  function upperBound(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m; } return lo; }

  function toCsv(s) {
    const pad = (n) => String(n).padStart(2, '0');
    const f = (t) => { const d = new Date(t * 1000); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };
    const L = ['time_local,epoch,temperature_c,humidity_pct,pressure_hpa,usb,time_estimated'];
    for (let i = 0; i < s.t.length; i++)
      L.push([f(s.t[i]), Math.round(s.t[i]), s.temp[i].toFixed(2), s.hum[i].toFixed(2), s.press[i].toFixed(2), s.usb[i], s.est[i]].join(','));
    const B = ['time_local,epoch,battery_mv,usb'];
    for (let i = 0; i < s.bt.length; i++) B.push([f(s.bt[i]), Math.round(s.bt[i]), s.bmv[i], s.bus[i]].join(','));
    return { samples: L.join('\n') + '\n', battery: B.join('\n') + '\n' };
  }

  const Core = { SVC, CHR_CTRL, CHR_DATA, CHR_STAT, OP, CFG, PK, STAT_LEN, parseStatus, RecordStream, buildTimeMap, loadSeries,
    bucketize, breakGaps, lowerBound, upperBound, toCsv, median };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core; else root.Core = Core;
})(typeof self !== 'undefined' ? self : this);
