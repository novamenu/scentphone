/* =====================================================================
 * ScentPhone Sensorkit 1.0  ·  onderdeel van ScentPhone 0.5.0
 *
 * Hardware-onafhankelijke basis voor echte geurmetingen met een EXTERNE sensor
 * (elektronische neus). Een telefoon kan zelf niet ruiken: zonder externe sensor
 * meet deze code niets.
 *
 * Onderdelen
 *   Profielen         – instelbaar sensorprotocol (scentphone.sensorprofile 1.0)
 *   FrameDecoder      – zet binnenkomende bytes/tekst om in kanaalwaarden
 *   SensorSession     – verbinding, status, batterij, signaalkwaliteit, wegvaldetectie
 *   Transports        – Web Bluetooth (browser), native brug (toekomstige iPhone-app),
 *                       virtuele testsensor (simulatie)
 *   runMeasurement    – basislijn → monster → verwerking
 *   SignalProcessor   – filteren, basislijn, normaliseren, afwijkingen, kwaliteit
 *   Recognizer        – uitlegbare vergelijking met eigen referentiemetingen,
 *                       met "Onbekende geur" en een haak voor kalibratie en machine learning
 *   Opslaghulpen      – opschonen van metingen/ruwe data, CSV- en trainingsexport
 *
 * Eerlijkheid, hard in de code vastgelegd
 *   - Er staan GEEN bestaande apparaatnamen, service-UUID's of fabrikantprotocollen in dit bestand.
 *     Elke Bluetooth-sensor wordt ingesteld met een protocolprofiel (UUID's uit de documentatie
 *     van je sensor of je eigen firmware). Alleen de standaard Bluetooth SIG Battery Service
 *     (0x180F / 0x2A19) wordt gebruikt als het apparaat die aanbiedt.
 *   - Metingen van de virtuele testsensor krijgen altijd source "simulated". Alleen een
 *     niet-gesimuleerde transportlaag kan source "sensor" opleveren.
 *   - 'Verbonden' betekent: er komen nu geldige meetgegevens binnen.
 *   - Een vergelijkingsscore is geen bewezen herkenningsnauwkeurigheid.
 *
 * Draait in de browser (window.ScentSensorKit) en in Node (require) voor automatische tests.
 * ===================================================================== */
(function (root, factory) {
  const kit = factory();
  if (typeof module === "object" && module.exports) module.exports = kit;
  if (root) root.ScentSensorKit = kit;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const VERSION = "1.0.0";

  /* ------------------------------------------------------------------ */
  /* Hulpfuncties                                                         */
  /* ------------------------------------------------------------------ */
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const clamp01 = (v) => clamp(v, 0, 1);
  const rnd = (v, d = 5) => (isNum(v) ? +v.toFixed(d) : null);
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
  const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const mad = (a) => { const m = median(a); return median(a.map((x) => Math.abs(x - m))); };
  const l2 = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0));
  const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
  const int = (v, lo, hi, d) => (isNum(v) ? clamp(Math.round(v), lo, hi) : d);
  const num = (v, lo, hi, d) => (isNum(v) ? clamp(v, lo, hi) : d);
  function cosine(a, b) {
    const n = Math.min(a.length, b.length); let d = 0, na = 0, nb = 0;
    for (let i = 0; i < n; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return na && nb ? d / Math.sqrt(na * nb) : 0;
  }
  /** Helling (eenheden per ms) via lineaire regressie. */
  function slope(ts, ys) {
    const n = Math.min(ts.length, ys.length); if (n < 3) return 0;
    const mt = mean(ts.slice(0, n)), my = mean(ys.slice(0, n)); let c = 0, v = 0;
    for (let i = 0; i < n; i++) { c += (ts[i] - mt) * (ys[i] - my); v += (ts[i] - mt) ** 2; }
    return v ? c / v : 0;
  }
  /** Robuuste ruisschatting: MAD van opeenvolgende verschillen (ongevoelig voor langzame trends). */
  function robustNoise(ys) {
    if (ys.length < 4) return NaN;
    const d = []; for (let i = 1; i < ys.length; i++) d.push(ys[i] - ys[i - 1]);
    return (1.4826 * mad(d)) / Math.SQRT2;
  }
  let _seq = 0;
  const uid = (p) => p + "-" + Date.now().toString(36) + (++_seq).toString(36) + Math.random().toString(36).slice(2, 6);
  function seeded(seed) { let s = (seed >>> 0) || 1; return () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) ^ Math.imul(s ^ (s >>> 13), 3266489917)) >>> 0) / 4294967296; }
  function strHash(t) { let h = 2166136261; for (const c of String(t)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

  class SensorError extends Error { constructor(code, message) { super(message); this.name = "SensorError"; this.code = code; } }

  /* ------------------------------------------------------------------ */
  /* Klok (vervangbaar in tests)                                          */
  /* ------------------------------------------------------------------ */
  const RealClock = {
    now: () => Date.now(),
    setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h),
    setInterval: (f, ms) => setInterval(f, ms), clearInterval: (h) => clearInterval(h),
  };
  /** Handmatige klok voor tests: tijd loopt alleen door met advance(ms). */
  class ManualClock {
    constructor(t0 = 1767225600000) { this.t = t0; this.timers = []; this.n = 0; }
    now() { return this.t; }
    setTimeout(f, ms) { const id = ++this.n; this.timers.push({ id, at: this.t + Math.max(0, ms), f, every: 0 }); return id; }
    setInterval(f, ms) { const id = ++this.n; this.timers.push({ id, at: this.t + Math.max(1, ms), f, every: Math.max(1, ms) }); return id; }
    clearTimeout(id) { this.timers = this.timers.filter((x) => x.id !== id); }
    clearInterval(id) { this.clearTimeout(id); }
    advance(ms) {
      const end = this.t + ms;
      for (let guard = 0; guard < 1e6; guard++) {
        this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const x = this.timers[0]; if (!x || x.at > end) break;
        this.t = x.at;
        if (x.every) x.at += x.every; else this.timers.shift();
        try { x.f(); } catch (e) { /* testtimer mag de klok niet breken */ }
      }
      this.t = end;
    }
  }
  function sleepOn(clock, ms, signal) {
    return new Promise((res, rej) => {
      if (signal && signal.aborted) return rej(abortError());
      const h = clock.setTimeout(() => { if (signal) signal.removeEventListener("abort", onAbort); res(); }, ms);
      const onAbort = () => { clock.clearTimeout(h); rej(abortError()); };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  function abortError() { const e = new Error("Meting gestopt."); e.name = "AbortError"; return e; }

  /* ------------------------------------------------------------------ */
  /* Protocolprofielen                                                    */
  /* ------------------------------------------------------------------ */
  const UUID128 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  /** Zet een UUID om naar de volledige 128-bitsvorm. Leeg → "". Ongeldig → null. 16/32-bits → Bluetooth-basis-UUID. */
  function canonicalUuid(input) {
    const s = String(input == null ? "" : input).trim().toLowerCase().replace(/^0x/, "");
    if (!s) return "";
    if (UUID128.test(s)) return s;
    if (/^[0-9a-f]{4}$/.test(s) || /^[0-9a-f]{8}$/.test(s)) return s.padStart(8, "0") + "-0000-1000-8000-00805f9b34fb";
    return null;
  }
  const FORMATS = {
    "scentphone-v1": { label: "ScentPhone-referentieframe (binair)", binary: true, note: "Door ScentPhone gedefinieerd formaat voor eigen firmware (zie SENSOR-PROTOCOL.md). Geen bestaand apparaat gebruikt dit vanzelf." },
    "binary-fixed": { label: "Binair, vaste opbouw (instelbaar)", binary: true, note: "Voor sensoren met een gedocumenteerd binair formaat: kies kopbytes, aantal kanalen en getaltype." },
    json: { label: "JSON-tekst", binary: false, note: 'Elk frame is een JSON-object, bijv. {"ch":[512,498,…],"bat":80}.' },
    csv: { label: "Tekst met scheidingsteken (CSV)", binary: false, note: "Elk frame is één regel met getallen, bijv. 512,498,530." },
  };
  const VALUE_TYPES = {
    uint8: [1, "getUint8"], int8: [1, "getInt8"],
    uint16le: [2, "getUint16", true], uint16be: [2, "getUint16", false], int16le: [2, "getInt16", true], int16be: [2, "getInt16", false],
    uint32le: [4, "getUint32", true], uint32be: [4, "getUint32", false], int32le: [4, "getInt32", true], int32be: [4, "getInt32", false],
    float32le: [4, "getFloat32", true], float32be: [4, "getFloat32", false],
  };
  const RESPONSE_MODES = {
    relative: "Relatieve verandering: (x − basislijn) / basislijn",
    difference: "Verschil: x − basislijn (in sensoreenheden)",
    "inverse-ratio": "Basislijn / x − 1 (voor sensoren waarvan de waarde daalt bij geur, zoals MOS-weerstand)",
  };
  const SEPARATORS = [",", ";", "\t", " "];
  const MAX_CHANNELS = 128;

  /** Sjablonen. Bewust zonder UUID's: die komen uit de documentatie van je eigen sensor of firmware. */
  const TEMPLATES = {
    "own-reference": { name: "Eigen Bluetooth-sensor — ScentPhone-referentieframe", transport: "ble", frame: { format: "scentphone-v1" } },
    "own-json": { name: "Eigen Bluetooth-sensor — JSON-tekst", transport: "ble", frame: { format: "json", textFraming: "notification" } },
    "own-csv": { name: "Eigen Bluetooth-sensor — CSV-tekst", transport: "ble", frame: { format: "csv", textFraming: "newline", separator: "," } },
    "own-binary": { name: "Bluetooth-sensor met gedocumenteerd binair formaat", transport: "ble", frame: { format: "binary-fixed", valueType: "uint16le", channelCount: 8 } },
    virtual: {
      name: "Virtuele testsensor (simulatie)", transport: "virtual",
      frame: { format: "scentphone-v1", channelCount: 8 }, channels: { unit: "raw", min: 0, max: 65535 },
      timing: { expectedHz: 5, staleMs: 4000, firstFrameMs: 6000, minValidFrames: 3 },
      processing: { responseMode: "relative", baselineS: 4, sampleS: 8 },
      notes: "Genereert gesimuleerde ruwe sensorstromen om de software te testen. Geen echte meting.",
    },
  };
  function profileFromTemplate(key, extra = {}) {
    const t = TEMPLATES[key]; if (!t) throw new SensorError("template", "Onbekend sjabloon.");
    const merge = (a, b) => ({ ...(a || {}), ...(b || {}) });
    return validateProfile({
      ...t, ...extra, id: extra.id || (key === "virtual" ? "virtual-test" : uid("sp")), origin: key === "virtual" ? "builtin" : "template", template: key,
      frame: merge(t.frame, extra.frame), channels: merge(t.channels, extra.channels), timing: merge(t.timing, extra.timing), processing: merge(t.processing, extra.processing), ble: merge(t.ble, extra.ble),
    }).profile;
  }

  /** Controleert en normaliseert een protocolprofiel. Geeft { ok, errors[], profile }. */
  function validateProfile(input) {
    const errors = [], p = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const transport = ["ble", "virtual"].includes(p.transport) ? p.transport : null;
    if (!transport) errors.push("Kies een verbindingstype: Bluetooth LE of virtuele testsensor.");
    const ble = p.ble && typeof p.ble === "object" ? p.ble : {};
    const fr = p.frame && typeof p.frame === "object" ? p.frame : {};
    const ch = p.channels && typeof p.channels === "object" ? p.channels : {};
    const tm = p.timing && typeof p.timing === "object" ? p.timing : {};
    const pr = p.processing && typeof p.processing === "object" ? p.processing : {};
    const now = new Date().toISOString();
    const out = {
      schema: "scentphone.sensorprofile", version: "1.0",
      id: str(p.id, 64).replace(/[^\w.-]/g, "") || uid("sp"), name: str(p.name, 80).trim() || "Naamloos sensorprofiel", transport,
      origin: ["builtin", "template", "user", "import"].includes(p.origin) ? p.origin : "user", template: str(p.template, 24),
      ble: { serviceUuid: "", dataCharUuid: "", infoCharUuid: "", namePrefix: str(ble.namePrefix, 30).trim(), battery: ble.battery !== false },
      frame: {
        format: FORMATS[fr.format] ? fr.format : "scentphone-v1",
        channelCount: int(fr.channelCount, 0, MAX_CHANNELS, 0),
        valueType: VALUE_TYPES[fr.valueType] ? fr.valueType : "uint16le",
        headerBytes: int(fr.headerBytes, 0, 64, 0), trailerBytes: int(fr.trailerBytes, 0, 64, 0),
        scale: isNum(fr.scale) && fr.scale !== 0 ? fr.scale : 1, offset: num(fr.offset, -1e12, 1e12, 0),
        separator: SEPARATORS.includes(fr.separator) ? fr.separator : ",",
        textFraming: fr.textFraming === "newline" ? "newline" : "notification",
      },
      channels: {
        unit: str(ch.unit, 16).trim() || "raw",
        min: isNum(ch.min) ? ch.min : null, max: isNum(ch.max) ? ch.max : null,
        labels: Array.isArray(ch.labels) ? ch.labels.slice(0, MAX_CHANNELS).map((x) => str(x, 24)) : [],
      },
      timing: {
        expectedHz: num(tm.expectedHz, 0, 200, 0), staleMs: int(tm.staleMs, 1000, 60000, 5000),
        firstFrameMs: int(tm.firstFrameMs, 2000, 120000, 10000), minValidFrames: int(tm.minValidFrames, 1, 20, 3),
      },
      processing: {
        responseMode: RESPONSE_MODES[pr.responseMode] ? pr.responseMode : "relative",
        baselineS: num(pr.baselineS, 2, 300, 10), sampleS: num(pr.sampleS, 3, 600, 20),
        minSNR: num(pr.minSNR, 2, 100, 5), minResponse: num(pr.minResponse, 0, 1, 0.02),
      },
      notes: str(p.notes, 400),
      createdAt: typeof p.createdAt === "string" && !isNaN(new Date(p.createdAt)) ? p.createdAt : now,
      updatedAt: now,
    };
    if (transport === "ble") {
      [["serviceUuid", "service-UUID", true], ["dataCharUuid", "UUID van het meetkenmerk (notify)", true], ["infoCharUuid", "UUID van het infokenmerk", false]].forEach(([k, label, req]) => {
        const c = canonicalUuid(ble[k]);
        if (c === null) errors.push("De " + label + " is geen geldige UUID. Gebruik de vorm 0000xxxx-0000-1000-8000-00805f9b34fb of 4 hexadecimale tekens.");
        else if (!c && req) errors.push("Vul de " + label + " in. Die staat in de documentatie van je sensor of firmware; ScentPhone verzint er geen.");
        out.ble[k] = c || "";
      });
    }
    if (out.frame.format === "binary-fixed" && !out.frame.channelCount) errors.push("Vul bij een binair formaat met vaste opbouw het aantal kanalen in.");
    if (out.channels.min !== null && out.channels.max !== null && out.channels.min >= out.channels.max) errors.push("Het minimum van het meetbereik moet kleiner zijn dan het maximum.");
    if (out.processing.responseMode === "difference") out.processing.minResponse = 0;
    return { ok: !errors.length, errors, profile: out };
  }

  /* ------------------------------------------------------------------ */
  /* Frames decoderen                                                     */
  /* ------------------------------------------------------------------ */
  function toBytes(x) {
    if (x == null) throw new SensorError("frame", "leeg bericht");
    if (x instanceof Uint8Array) return x;
    if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    if (typeof x === "string") { /* native brug levert base64 */
      let bin; try { bin = atob(x); } catch (e) { throw new SensorError("frame", "ongeldige base64-gegevens van de native app"); }
      const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u;
    }
    if (Array.isArray(x) && x.every((b) => Number.isInteger(b) && b >= 0 && b < 256)) return Uint8Array.from(x);
    throw new SensorError("frame", "onbekend gegevenstype");
  }
  const dvOf = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  /** ScentPhone-referentieframe v1 en v2 (zie SENSOR-PROTOCOL.md). */
  function decodeReferenceFrame(u8) {
    if (u8.length < 6) throw new SensorError("frame", "frame te kort");
    const dv = dvOf(u8);
    if (dv.getUint8(0) !== 0x53) throw new SensorError("frame", "onbekend frame (startbyte is geen 0x53)");
    const ver = dv.getUint8(1), n = dv.getUint8(2), flags = dv.getUint8(3);
    if (n < 1 || n > MAX_CHANNELS) throw new SensorError("frame", "ongeldig aantal kanalen (" + n + ")");
    let off, size = 2, f32 = false, env = !!(flags & 1), bat = false, seq = null;
    if (ver === 1) off = 4;
    else if (ver === 2) { bat = !!(flags & 2); f32 = !!(flags & 4); size = f32 ? 4 : 2; seq = dv.getUint16(4, true); off = 6; }
    else throw new SensorError("frame", "niet-ondersteunde protocolversie " + ver);
    const expected = off + n * size + (env ? 4 : 0) + (bat ? 1 : 0);
    if (u8.length !== expected) throw new SensorError("frame", "framelengte klopt niet (" + u8.length + " in plaats van " + expected + " bytes)");
    const values = [];
    for (let i = 0; i < n; i++) values.push(f32 ? dv.getFloat32(off + i * 4, true) : dv.getUint16(off + i * 2, true));
    let o = off + n * size, envOut = null, battery = null;
    if (env) { const tempC = dv.getInt16(o, true) / 100, humidity = dv.getUint16(o + 2, true) / 100; o += 4; if (tempC > -40 && tempC < 85 && humidity >= 0 && humidity <= 100) envOut = { tempC, humidity }; }
    if (bat) { const b = dv.getUint8(o); if (b <= 100) battery = b; }
    return { values, env: envOut, battery, seq };
  }
  /** Maakt een referentieframe v2 (gebruikt door de virtuele testsensor en tests). */
  function encodeReferenceFrame({ values, env = null, battery = null, seq = 0, float32 = false, version = 2 }) {
    const n = values.length, size = float32 ? 4 : 2;
    if (version === 1) {
      const u = new Uint8Array(4 + n * 2 + (env ? 4 : 0)), dv = dvOf(u);
      u[0] = 0x53; u[1] = 1; u[2] = n; u[3] = env ? 1 : 0;
      values.forEach((v, i) => dv.setUint16(4 + i * 2, clamp(Math.round(v), 0, 65535), true));
      if (env) { dv.setInt16(4 + n * 2, Math.round(env.tempC * 100), true); dv.setUint16(6 + n * 2, Math.round(env.humidity * 100), true); }
      return u;
    }
    const u = new Uint8Array(6 + n * size + (env ? 4 : 0) + (battery !== null ? 1 : 0)), dv = dvOf(u);
    u[0] = 0x53; u[1] = 2; u[2] = n; u[3] = (env ? 1 : 0) | (battery !== null ? 2 : 0) | (float32 ? 4 : 0);
    dv.setUint16(4, seq & 0xffff, true);
    values.forEach((v, i) => (float32 ? dv.setFloat32(6 + i * 4, v, true) : dv.setUint16(6 + i * 2, clamp(Math.round(v), 0, 65535), true)));
    let o = 6 + n * size;
    if (env) { dv.setInt16(o, Math.round(env.tempC * 100), true); dv.setUint16(o + 2, Math.round(env.humidity * 100), true); o += 4; }
    if (battery !== null) u[o] = clamp(Math.round(battery), 0, 100);
    return u;
  }
  function decodeFixedFrame(u8, fr) {
    const [size, getter, le] = VALUE_TYPES[fr.valueType], n = fr.channelCount;
    const expected = fr.headerBytes + n * size + fr.trailerBytes;
    if (u8.length !== expected) throw new SensorError("frame", "framelengte klopt niet (" + u8.length + " in plaats van " + expected + " bytes)");
    const dv = dvOf(u8), values = [];
    for (let i = 0; i < n; i++) values.push(dv[getter](fr.headerBytes + i * size, le));
    return { values, env: null, battery: null, seq: null };
  }

  /** Zet berichten van een transportlaag om in frames volgens het profiel. Tekstformaten kunnen over meerdere berichten verdeeld zijn. */
  class FrameDecoder {
    constructor(profile) {
      this.p = profile; this.fr = profile.frame; this.binary = FORMATS[this.fr.format].binary; this.buf = "";
      this.td = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8") : null;
    }
    push(input) {
      const frames = [], errors = [];
      let u8; try { u8 = toBytes(input); } catch (e) { errors.push(e.message); return { frames, errors }; }
      if (this.binary) {
        try { frames.push(this._finish(this.fr.format === "scentphone-v1" ? decodeReferenceFrame(u8) : decodeFixedFrame(u8, this.fr))); }
        catch (e) { errors.push(e.message); }
        return { frames, errors };
      }
      const text = this.td ? this.td.decode(u8, { stream: this.fr.textFraming === "newline" }) : String.fromCharCode(...u8);
      let lines;
      if (this.fr.textFraming === "newline") {
        this.buf += text;
        if (this.buf.length > 8192) { this.buf = ""; errors.push("tekstbuffer overgelopen zonder regeleinde"); return { frames, errors }; }
        const parts = this.buf.split(/\r?\n/); this.buf = parts.pop(); lines = parts;
      } else lines = [text];
      for (const raw of lines) {
        const line = raw.trim(); if (!line) continue;
        try { frames.push(this._finish(this.fr.format === "json" ? this._json(line) : this._csv(line))); } catch (e) { errors.push(e.message); }
      }
      return { frames, errors };
    }
    _json(line) {
      let o; try { o = JSON.parse(line); } catch (e) { throw new SensorError("frame", "geen geldige JSON"); }
      if (!o || typeof o !== "object") throw new SensorError("frame", "JSON-frame is geen object");
      const arr = Array.isArray(o.ch) ? o.ch : Array.isArray(o.channels) ? o.channels : null;
      if (!arr) throw new SensorError("frame", 'JSON-frame mist de lijst "ch"');
      const values = arr.map(Number);
      const env = isNum(o.temp) && isNum(o.rh) && o.temp > -40 && o.temp < 85 && o.rh >= 0 && o.rh <= 100 ? { tempC: o.temp, humidity: o.rh } : null;
      return { values, env, battery: isNum(o.bat) && o.bat >= 0 && o.bat <= 100 ? o.bat : null, seq: Number.isInteger(o.seq) ? o.seq & 0xffff : null };
    }
    _csv(line) {
      const parts = line.split(this.fr.separator).map((s) => s.trim());
      if (parts.some((s) => s === "")) throw new SensorError("frame", "lege waarde in tekstregel");
      return { values: parts.map(Number), env: null, battery: null, seq: null };
    }
    _finish(f) {
      if (!f.values.length || f.values.length > MAX_CHANNELS) throw new SensorError("frame", "ongeldig aantal kanalen (" + f.values.length + ")");
      if (f.values.some((v) => !isNum(v))) throw new SensorError("frame", "niet-numerieke of oneindige meetwaarde");
      if (this.fr.scale !== 1 || this.fr.offset !== 0) f.values = f.values.map((v) => v * this.fr.scale + this.fr.offset);
      if (this.fr.channelCount && f.values.length !== this.fr.channelCount) throw new SensorError("frame", f.values.length + " kanalen ontvangen, profiel verwacht er " + this.fr.channelCount);
      return f;
    }
  }
  /** Controle per frame bovenop het decoderen. Geeft een reden (tekst) of null. */
  function validateFrame(f, profile, lockedCount) {
    if (lockedCount && f.values.length !== lockedCount) return "aantal kanalen veranderde van " + lockedCount + " naar " + f.values.length;
    const { min, max } = profile.channels;
    if (min !== null && f.values.some((v) => v < min)) return "waarde onder het meetbereik (" + min + ")";
    if (max !== null && f.values.some((v) => v > max)) return "waarde boven het meetbereik (" + max + ")";
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Transportlagen                                                       */
  /* ------------------------------------------------------------------ */
  const isIOS = (env) => { const n = (env && env.navigator) || {}; return /iPad|iPhone|iPod/.test(n.userAgent || "") || (n.platform === "MacIntel" && n.maxTouchPoints > 1); };
  function bleErrorText(e) {
    const name = e && e.name, msg = String((e && e.message) || "");
    if (name === "SecurityError") return "De browser staat Bluetooth hier niet toe. Open de app via https en tik zelf op de knop.";
    if (name === "NetworkError") return "Het apparaat is niet bereikbaar of verbrak de verbinding tijdens het koppelen. Zet de sensor dichterbij en probeer opnieuw.";
    if (name === "NotSupportedError") return "Dit Bluetooth-apparaat of kenmerk wordt niet ondersteund (bijvoorbeeld geen meldingen/notify op het meetkenmerk).";
    if (/service/i.test(msg) && /(not found|no services|geen)/i.test(msg)) return "Het apparaat biedt de ingestelde service-UUID niet aan. Controleer het protocolprofiel.";
    if (/characteristic/i.test(msg)) return "Het apparaat heeft het ingestelde meetkenmerk niet. Controleer de UUID in het protocolprofiel.";
    return msg ? msg.slice(0, 200) : "Onbekende Bluetooth-fout.";
  }
  /** Web Bluetooth: Chrome/Edge op Android, Windows, macOS, ChromeOS. Niet in Safari of andere browsers op iPhone/iPad. */
  function makeWebBluetoothTransport(env) {
    const E = env || (typeof window !== "undefined" ? window : {});
    return {
      id: "web-bluetooth", label: "Bluetooth via de browser (Web Bluetooth)", simulated: false,
      supported() {
        const nav = E.navigator || {};
        if (nav.bluetooth && typeof nav.bluetooth.requestDevice === "function") return E.isSecureContext === false ? { ok: false, reason: "insecure" } : { ok: true };
        return { ok: false, reason: isIOS(E) ? "ios" : E.isSecureContext === false ? "insecure" : "browser" };
      },
      /** Opent de apparaatkiezer van de browser. Moet direct vanuit een tik worden aangeroepen. */
      async search(profile) {
        const svc = profile.ble.serviceUuid;
        if (!svc) throw new SensorError("config", "Het protocolprofiel heeft geen service-UUID. Stel eerst het protocol in.");
        const filter = profile.ble.namePrefix ? { services: [svc], namePrefix: profile.ble.namePrefix } : { services: [svc] };
        const optionalServices = [svc]; if (profile.ble.battery) optionalServices.push("battery_service");
        let device;
        try { device = await E.navigator.bluetooth.requestDevice({ filters: [filter], optionalServices }); }
        catch (e) { if (e && e.name === "NotFoundError") throw Object.assign(new SensorError("cancelled", "Geen sensor gekozen."), { name: "NotFoundError" }); throw new SensorError("search", bleErrorText(e)); }
        return [{ id: String(device.id || ""), name: String(device.name || "Bluetooth-apparaat zonder naam").slice(0, 80), handle: device }];
      },
      async connect(profile, dev, h) {
        const device = dev && dev.handle; if (!device) throw new SensorError("config", "Zoek eerst een sensor.");
        const onDisc = () => h.onClose("Bluetooth-verbinding verbroken");
        device.addEventListener("gattserverdisconnected", onDisc);
        let ch = null, bl = null;
        const close = async () => {
          try { if (ch) await ch.stopNotifications(); } catch (e) {}
          try { if (bl) await bl.stopNotifications(); } catch (e) {}
          try { device.removeEventListener("gattserverdisconnected", onDisc); if (device.gatt && device.gatt.connected) device.gatt.disconnect(); } catch (e) {}
        };
        try {
          const server = await device.gatt.connect();
          const svc = await server.getPrimaryService(profile.ble.serviceUuid);
          ch = await svc.getCharacteristic(profile.ble.dataCharUuid);
          let info = null;
          if (profile.ble.infoCharUuid) { try { const ic = await svc.getCharacteristic(profile.ble.infoCharUuid); const txt = new TextDecoder().decode(await ic.readValue()); try { info = JSON.parse(txt); } catch (e) { info = { text: txt.slice(0, 120) }; } } catch (e) { info = null; } }
          ch.addEventListener("characteristicvaluechanged", (ev) => h.onData(ev.target.value));
          await ch.startNotifications();
          if (profile.ble.battery) {
            try {
              const bs = await server.getPrimaryService("battery_service"); bl = await bs.getCharacteristic("battery_level");
              const v = await bl.readValue(); h.onBattery(v.getUint8(0));
              try { bl.addEventListener("characteristicvaluechanged", (ev) => h.onBattery(ev.target.value.getUint8(0))); await bl.startNotifications(); } catch (e) { bl = null; }
            } catch (e) { bl = null; /* apparaat biedt geen standaard batterijservice */ }
          }
          return { id: String(device.id || ""), name: String(device.name || "Bluetooth-sensor").slice(0, 80), info, close };
        } catch (e) { await close(); throw new SensorError("connect", bleErrorText(e)); }
      },
    };
  }
  /**
   * Native brug voor een toekomstige ScentPhone-app (iPhone: WKWebView + CoreBluetooth).
   * Contract (bridgeVersion 1, zie NATIVE-BRIDGE.md):
   *   window.ScentPhoneNative.sensor = {
   *     isAvailable?() -> Promise<{ok, reason?}>        // Bluetooth aan/uit/geen toestemming
   *     scan?({serviceUuids, namePrefix, timeoutMs}) -> Promise<[{id, name, rssi}]>
   *     connect({bridgeVersion, deviceId, protocol}) -> Promise<{id, name, info?}>
   *     disconnect() -> Promise
   *     onData(cb(base64))  onDisconnect(cb(reason))  onBattery?(cb(0..100))  onRssi?(cb(dBm))
   *   }
   * Elke on…-functie vervangt de vorige callback. Ook de 0.4-vorm (onFrame) wordt geaccepteerd.
   */
  function makeNativeTransport(env) {
    const E = env || (typeof window !== "undefined" ? window : {});
    const bridge = () => E.ScentPhoneNative && E.ScentPhoneNative.sensor;
    return {
      id: "native", label: "ScentPhone-app (native Bluetooth)", simulated: false,
      supported() { const b = bridge(); return b && typeof b.connect === "function" && (typeof b.onData === "function" || typeof b.onFrame === "function") ? { ok: true } : { ok: false, reason: "no-bridge" }; },
      async search(profile) {
        const b = bridge();
        if (typeof b.isAvailable === "function") { const a = (await b.isAvailable()) || {}; if (a.ok === false) throw new SensorError("search", a.reason === "unauthorized" ? "De app heeft geen toestemming voor Bluetooth. Sta Bluetooth toe in Instellingen." : a.reason === "poweredOff" ? "Bluetooth staat uit op dit toestel." : "Bluetooth is niet beschikbaar (" + str(String(a.reason || "onbekend"), 40) + ")."); }
        if (typeof b.scan !== "function") return [{ id: "", name: "Sensor kiezen in de app", pickInApp: true }];
        const list = await b.scan({ serviceUuids: profile.ble.serviceUuid ? [profile.ble.serviceUuid] : [], namePrefix: profile.ble.namePrefix, timeoutMs: 8000 });
        return (Array.isArray(list) ? list : []).slice(0, 30).map((d) => ({ id: str(String(d && d.id || ""), 64), name: str(String(d && d.name || "Apparaat zonder naam"), 80), rssi: isNum(d && d.rssi) ? d.rssi : null }));
      },
      async connect(profile, dev, h) {
        const b = bridge();
        (typeof b.onData === "function" ? b.onData : b.onFrame).call(b, (x) => h.onData(x));
        if (typeof b.onDisconnect === "function") b.onDisconnect((why) => h.onClose(why ? String(why).slice(0, 120) : ""));
        if (typeof b.onBattery === "function") b.onBattery((v) => h.onBattery(v));
        if (typeof b.onRssi === "function") b.onRssi((v) => h.onRssi(v));
        let r;
        try {
          r = (await b.connect({ bridgeVersion: 1, deviceId: (dev && dev.id) || "", protocol: { serviceUuid: profile.ble.serviceUuid, dataCharUuid: profile.ble.dataCharUuid, infoCharUuid: profile.ble.infoCharUuid, format: profile.frame.format, readBattery: profile.ble.battery } })) || {};
        } catch (e) { throw new SensorError("connect", "De app kon niet verbinden: " + str(String((e && e.message) || e || "onbekende fout"), 160)); }
        return { id: str(String(r.id || (dev && dev.id) || "native"), 64), name: str(String(r.name || (dev && dev.name) || "Bluetooth-sensor"), 80), info: r.info && typeof r.info === "object" ? r.info : null, close: async () => { try { await b.disconnect(); } catch (e) {} } };
      },
    };
  }
  /** Virtuele testsensor: genereert GESIMULEERDE ruwe meetframes in het referentieformaat, inclusief foutscenario's. */
  const VIRTUAL_SUBSTANCES = {
    none: { label: "Schone lucht (geen geur)" },
    A: { label: "Testgeur A" }, B: { label: "Testgeur B" }, C: { label: "Testgeur C" }, D: { label: "Testgeur D" },
  };
  const VIRTUAL_FAULTS = {
    none: "Geen storing", noise: "Veel ruis", drift: "Wegdrijvende basislijn", invalid: "Deels ongeldige frames",
    dropout: "Gegevens vallen tijdelijk weg", disconnect: "Verbinding valt weg", saturate: "Sensor raakt verzadigd",
    silent: "Verbindt, maar stuurt niets", "wrong-format": "Verkeerd gegevensformaat",
  };
  function substancePattern(key, n) {
    if (!key || key === "none") return Array(n).fill(0);
    const r = seeded(strHash("scentphone-virtual|" + key));
    return Array.from({ length: n }, () => (r() < 0.2 ? -1 : 1) * (0.03 + r() * 0.3));
  }
  function makeVirtualTransport(opts = {}) {
    const clock = opts.clock || RealClock;
    const T = {
      id: "virtual", label: "Virtuele testsensor (simulatie)", simulated: true,
      options: { substance: "A", fault: "none", seed: 0 },
      supported() { return { ok: true }; },
      async search() { await sleepOn(clock, 250); return [{ id: "virtual-1", name: "Virtuele testsensor (simulatie)", rssi: null, simulated: true }]; },
      async connect(profile, dev, h) {
        await sleepOn(clock, 300);
        const o = { ...T.options }, n = profile.frame.channelCount || 8, hz = profile.timing.expectedHz || 5, dt = 1000 / hz;
        T._n = (T._n || 0) + 1; const rand = seeded((o.seed || strHash(String(clock.now()))) + T._n * 7919); /* per verbinding een andere, reproduceerbare reeks */
        const gauss = () => { let u = 0, v = 0; while (!u) u = rand(); while (!v) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
        const levels = Array.from({ length: n }, (_, i) => 18000 + 2100 * (i % 12));
        const noise = o.fault === "noise" ? 0.03 : 0.002;
        let exposure = 0, target = 0, conc = 1, jitter = Array(n).fill(0), seq = 0, elapsed = 0, battery = 87, open = true;
        const pattern = substancePattern(o.substance, n);
        const timer = clock.setInterval(() => {
          if (!open) return;
          elapsed += dt;
          if (o.fault === "disconnect" && elapsed >= 9000) { open = false; clock.clearInterval(timer); h.onClose("virtuele verbinding verbroken (testscenario)"); return; }
          if (o.fault === "silent") return;
          if (o.fault === "dropout" && elapsed >= 6000 && elapsed < 18000) return;
          const tau = target > exposure ? 1500 : 2500; exposure += (target - exposure) * (1 - Math.exp(-dt / tau));
          const drift = o.fault === "drift" ? 0.012 * (elapsed / 1000) : 0;
          const gain = o.fault === "saturate" ? 12 : 1;
          const values = levels.map((L, i) => clamp(Math.round(L * (1 + drift) * (1 + exposure * conc * gain * pattern[i] * (1 + jitter[i])) * (1 + noise * gauss())), 0, 65535));
          if (battery > 5 && seq % 600 === 599) battery -= 1;
          seq = (seq + 1) & 0xffff;
          if (o.fault === "wrong-format") { h.onData(new TextEncoder().encode(JSON.stringify({ values }))); return; }
          if (o.fault === "invalid" && rand() < 0.3) { const bad = encodeReferenceFrame({ values, seq, battery }); h.onData(bad.slice(0, bad.length - 3)); return; }
          h.onData(encodeReferenceFrame({ values, seq, battery, env: { tempC: 21.5, humidity: 45 } }));
        }, dt);
        return {
          id: "virtual-1", name: "Virtuele testsensor (simulatie)", info: { model: "ScentPhone virtueel " + n + "-kanaals", firmware: "sim-" + VERSION, simulated: true },
          /** Alleen de virtuele sensor luistert naar hints: zo 'brengt' de simulatie het monster bij de sensor. */
          hint(name) {
            if (name === "sample-on") { target = 1; conc = 0.85 + rand() * 0.3; jitter = jitter.map(() => (rand() * 2 - 1) * 0.08); /* ±8% variatie per kanaal tussen metingen; schone lucht blijft zonder respons */ }
            if (name === "sample-off") target = 0;
          },
          close: async () => { open = false; clock.clearInterval(timer); },
        };
      },
    };
    return T;
  }

  /* ------------------------------------------------------------------ */
  /* Sensorsessie: verbinding, status en signaalkwaliteit                 */
  /* ------------------------------------------------------------------ */
  const STATES = ["idle", "unsupported", "searching", "connecting", "waiting", "connected", "stale", "disconnected", "error"];
  class SensorSession {
    constructor(opts = {}) {
      this.clock = opts.clock || RealClock;
      this.transports = opts.transports || {};
      this.transportId = opts.transportId || Object.keys(this.transports)[0] || null;
      this.profile = opts.profile || null;
      this.state = "idle"; this.error = ""; this.link = null; this.device = null; this.candidates = [];
      this.battery = null; this.rssi = null; this.last = null;
      this._ls = new Map(); this._watch = null; this._userClose = false; this._waiters = []; this.recorders = new Set();
      this._resetStats();
    }
    _resetStats() { this.stats = { frames: 0, valid: 0, invalid: 0, lastValidAt: 0, firstValidAt: 0, lastInvalid: "", reasons: {}, seqGaps: 0, recent: [], recentFrames: [] }; this._count = 0; this._consec = 0; this._lastSeq = null; }
    on(evt, fn) { if (!this._ls.has(evt)) this._ls.set(evt, new Set()); this._ls.get(evt).add(fn); return () => this._ls.get(evt).delete(fn); }
    _emit(evt, data) { (this._ls.get(evt) || []).forEach((f) => { try { f(data, this); } catch (e) {} }); }
    _set(state, error = "") {
      if (this.state === state && this.error === error) return;
      this.state = state; this.error = error; this._emit("state", state);
      if (["connected", "error", "disconnected", "idle", "unsupported"].includes(state)) { const w = this._waiters; this._waiters = []; w.forEach((f) => f(state === "connected")); }
    }
    get simulated() { const t = this.transports[this.transportId]; return !!(t && t.simulated); }
    get busy() { return ["searching", "connecting", "waiting", "connected", "stale"].includes(this.state); }
    transport() { return this.transports[this.transportId] || null; }
    support(id) { const t = this.transports[id || this.transportId]; return t ? t.supported() : { ok: false, reason: "missing" }; }
    configure(transportId, profile) {
      if (this.busy) throw new SensorError("busy", "Verbreek eerst de huidige verbinding.");
      if (!this.transports[transportId]) throw new SensorError("config", "Onbekende verbindingsmethode.");
      const v = validateProfile(profile);
      if (transportId === "virtual" && v.profile.transport !== "virtual") throw new SensorError("config", "De virtuele testsensor gebruikt het profiel ‘Virtuele testsensor’.");
      if (transportId !== "virtual" && v.profile.transport === "virtual") throw new SensorError("config", "Kies voor Bluetooth een Bluetooth-protocolprofiel.");
      this.transportId = transportId; this.profile = v.profile; this.candidates = []; this.profileErrors = v.errors;
      if (["error", "disconnected", "unsupported"].includes(this.state)) this._set("idle");
      return v;
    }
    _ready() {
      const t = this.transport(); if (!t) throw new SensorError("config", "Kies een verbindingsmethode.");
      if (!this.profile) throw new SensorError("config", "Kies of maak eerst een protocolprofiel.");
      const v = validateProfile(this.profile); if (!v.ok) throw new SensorError("config", v.errors[0]);
      const s = t.supported(); if (!s.ok) { this._set("unsupported", s.reason); throw new SensorError("unsupported", supportText(s.reason)); }
      return t;
    }
    /** Sensor zoeken. Bluetooth in de browser: opent de apparaatkiezer (direct vanuit een tik aanroepen). */
    async search() {
      const t = this._ready();
      if (this.busy) throw new SensorError("busy", "Er loopt al een verbinding.");
      this._set("searching");
      try { this.candidates = (await t.search(this.profile)) || []; this._set("idle"); return this.candidates; }
      catch (e) {
        this.candidates = [];
        if (e && (e.name === "NotFoundError" || e.code === "cancelled")) { this._set("idle"); return []; }
        this._set("error", e.message || "Zoeken lukte niet."); throw e;
      }
    }
    /** Verbinden. Lost op met true zodra er geldige meetgegevens binnenkomen, anders false. */
    async connect(candidate) {
      if (["connecting", "waiting", "connected", "stale"].includes(this.state)) return this.state === "connected";
      const t = this._ready();
      const dev = candidate || this.candidates[0] || null;
      this._resetStats(); this.decoder = new FrameDecoder(this.profile); this.battery = null; this.rssi = (dev && isNum(dev.rssi)) ? dev.rssi : null; this.last = null; this._userClose = false;
      this._set("connecting");
      let link;
      try {
        link = await t.connect(this.profile, dev, {
          onData: (x) => this._onData(x), onClose: (why) => this._onClose(why),
          onBattery: (v) => this._onBattery(v, "service"), onRssi: (v) => { if (isNum(v)) { this.rssi = v; this._emit("rssi", v); } },
        });
      } catch (e) {
        if (e && (e.name === "NotFoundError" || e.code === "cancelled")) { this._set("idle"); return false; }
        this._set("error", (e && e.message) || "Verbinden lukte niet."); throw e instanceof SensorError ? e : new SensorError("connect", this.error);
      }
      if (this.state !== "connecting" && this.state !== "waiting" && this.state !== "connected") { try { await link.close(); } catch (e) {} return false; }
      this.link = link;
      const info = link.info || {};
      this.device = { id: str(String(link.id || ""), 64), name: str(String(link.name || "Sensor"), 80), model: str(String(info.model || ""), 64), firmware: str(String(info.firmware || ""), 32), via: t.id };
      this._connectedAt = this.clock.now();
      if (this.state === "connecting") this._set("waiting");
      this._startWatch();
      if (this.state === "connected") return true;
      return new Promise((res) => this._waiters.push(res));
    }
    async disconnect() {
      this._userClose = true; this._stopWatch();
      const l = this.link; this.link = null;
      this.recorders.forEach((r) => { r.lost = true; r.lostReason = "Je hebt de verbinding verbroken."; });
      if (l) { try { await l.close(); } catch (e) {} }
      this._set("idle");
    }
    hint(name) { if (this.link && typeof this.link.hint === "function") { try { this.link.hint(name); } catch (e) {} } }
    /** Live = verbonden én recent een geldig frame ontvangen. */
    isLive() { return this.state === "connected" && !!this.link && this.clock.now() - this.stats.lastValidAt < this.profile.timing.staleMs; }
    lastFrameAgeMs() { return this.stats.lastValidAt ? this.clock.now() - this.stats.lastValidAt : null; }
    _startWatch() { this._stopWatch(); this._watch = this.clock.setInterval(() => this._tick(), 250); }
    _stopWatch() { if (this._watch) { this.clock.clearInterval(this._watch); this._watch = null; } }
    _tick() {
      const now = this.clock.now(), tm = this.profile.timing;
      if (this.state === "waiting" && now - this._connectedAt >= tm.firstFrameMs) {
        const why = this.stats.invalid
          ? "Het apparaat stuurt gegevens, maar die passen niet bij het protocolprofiel ‘" + this.profile.name + "’ (" + this.stats.lastInvalid + "). Controleer formaat en kanalen."
          : "Verbonden met het apparaat, maar er kwamen geen meetgegevens binnen. De sensor is daarom niet als verbonden gemarkeerd.";
        this._closeLink(); this._set("error", why); return;
      }
      if (this.state === "connected" && now - this.stats.lastValidAt >= tm.staleMs) {
        this._set("stale", "De sensor stuurt al " + Math.round((now - this.stats.lastValidAt) / 1000) + " s geen geldige meetgegevens.");
        this.recorders.forEach((r) => { r.lost = true; r.lostReason = "De sensor stuurde tijdens de meting geen geldige gegevens meer."; });
      }
      this._emit("tick");
    }
    _closeLink() { this._stopWatch(); const l = this.link; this.link = null; if (l) { this._userClose = true; Promise.resolve().then(() => l.close()).catch(() => {}); } }
    _onBattery(v, source) { if (isNum(v) && v >= 0 && v <= 100) { this.battery = { level: Math.round(v), source, at: this.clock.now() }; this._emit("battery", this.battery); } }
    _invalid(reason) {
      const s = this.stats; s.frames++; s.invalid++; s.lastInvalid = reason; s.reasons[reason] = (s.reasons[reason] || 0) + 1; this._consec = 0;
      s.recent.push({ t: this.clock.now(), ok: false }); if (s.recent.length > 200) s.recent.shift();
      this.recorders.forEach((r) => { r.invalid++; r.reasons[reason] = (r.reasons[reason] || 0) + 1; });
      this._emit("invalid", reason);
      if (this.state === "waiting" && s.invalid >= 12 && !s.valid) { const why = "Het apparaat stuurt gegevens, maar die passen niet bij het protocolprofiel ‘" + this.profile.name + "’ (" + reason + "). Controleer formaat en kanalen."; this._closeLink(); this._set("error", why); }
    }
    _onData(x) {
      if (!["connecting", "waiting", "connected", "stale"].includes(this.state)) return;
      const { frames, errors } = this.decoder.push(x);
      errors.forEach((r) => this._invalid(r));
      for (const f of frames) {
        const why = validateFrame(f, this.profile, this._count); if (why) { this._invalid(why); continue; }
        const now = this.clock.now(), s = this.stats;
        if (!this._count) this._count = f.values.length;
        if (f.seq !== null && this._lastSeq !== null) { const gap = (f.seq - this._lastSeq - 1 + 65536) % 65536; if (gap > 0 && gap < 30000) { s.seqGaps += gap; this.recorders.forEach((r) => (r.seqGaps += gap)); } }
        if (f.seq !== null) this._lastSeq = f.seq;
        s.frames++; s.valid++; s.lastValidAt = now; if (!s.firstValidAt) s.firstValidAt = now; this._consec++;
        s.recent.push({ t: now, ok: true }); if (s.recent.length > 200) s.recent.shift();
        s.recentFrames.push({ t: now, v: f.values }); if (s.recentFrames.length > 40) s.recentFrames.shift();
        if (f.battery !== null) this._onBattery(f.battery, "frame");
        this.last = { ...f, at: now };
        this.recorders.forEach((r) => { if (r.frames.length < 20000) r.frames.push({ t: now - r.t0, v: f.values.slice(), env: f.env || null }); });
        this._emit("frame", this.last);
        if (this.state === "waiting" && s.valid >= this.profile.timing.minValidFrames) this._set("connected");
        else if (this.state === "connecting" && s.valid >= this.profile.timing.minValidFrames) this._set("connected");
        else if (this.state === "stale" && this._consec >= 2) this._set("connected");
      }
    }
    _onClose(why) {
      this._stopWatch(); const was = this.link; this.link = null;
      this.recorders.forEach((r) => { r.lost = true; r.lostReason = "De verbinding met de sensor viel weg."; });
      if (this._userClose) { this._userClose = false; if (!["error", "idle"].includes(this.state)) this._set("idle"); return; }
      if (!was && this.state === "connecting") { this._set("error", "De sensor verbrak de verbinding tijdens het koppelen."); return; }
      this._set("disconnected", "De verbinding met de sensor is verbroken" + (why ? " (" + why + ")" : "") + ".");
    }
    /** Signaalkwaliteit 0–100 over de laatste 10 seconden, met uitleg per onderdeel. */
    signalQuality() {
      if (!["connected", "stale"].includes(this.state)) return { score: null, label: "—", parts: [], hz: null };
      const now = this.clock.now(), win = this.stats.recent.filter((x) => now - x.t <= 10000);
      const ok = win.filter((x) => x.ok), validRatio = win.length ? ok.length / win.length : 0;
      const hz = ok.length >= 2 ? ((ok.length - 1) * 1000) / Math.max(1, ok[ok.length - 1].t - ok[0].t) : null;
      const exp = this.profile.timing.expectedHz;
      const rate = hz === null ? 0 : exp > 0 ? clamp01(hz / exp) : hz >= 0.5 ? 1 : clamp01(hz / 0.5);
      const fr = this.stats.recentFrames.filter((x) => now - x.t <= 10000);
      let relNoise = null;
      if (fr.length >= 6) {
        const per = [];
        for (let i = 0; i < fr[0].v.length; i++) { const ys = fr.map((x) => x.v[i]); const lvl = Math.abs(median(ys)); if (lvl > 1e-9) { const nz = robustNoise(ys); if (isNum(nz)) per.push(nz / lvl); } }
        if (per.length) relNoise = median(per);
      }
      const noise = relNoise === null ? 0.5 : clamp01(1 - (relNoise - 0.002) / 0.048);
      const age = this.lastFrameAgeMs(), stale = this.profile.timing.staleMs;
      const fresh = age === null ? 0 : age < stale * 0.4 ? 1 : clamp01(1 - (age - stale * 0.4) / (stale * 0.6));
      const parts = [
        { key: "valid", label: "Geldige frames", value: validRatio, weight: 0.35 },
        { key: "rate", label: exp > 0 ? "Meetfrequentie t.o.v. " + exp + " Hz" : "Meetfrequentie", value: rate, weight: 0.25 },
        { key: "noise", label: "Ruis" + (relNoise === null ? " (nog onbekend)" : ""), value: noise, weight: 0.25 },
        { key: "fresh", label: "Actualiteit", value: fresh, weight: 0.15 },
      ];
      const score = Math.round(100 * parts.reduce((s, p) => s + p.value * p.weight, 0));
      return { score, label: score >= 75 ? "Goed" : score >= 50 ? "Redelijk" : "Zwak", parts, hz: hz === null ? null : +hz.toFixed(2), relNoise: relNoise === null ? null : +relNoise.toFixed(5), rssi: this.rssi };
    }
    /** Start een opname van geldige frames (met tijd t in ms sinds de start). */
    record() {
      const self = this, t0 = this.clock.now();
      const r = {
        t0, frames: [], invalid: 0, reasons: {}, seqGaps: 0, lost: false, lostReason: "", phases: {},
        mark(name) { this.phases[name] = self.clock.now() - t0; },
        stop() { self.recorders.delete(r); },
        snapshot() { return { t0, frames: this.frames.slice(), invalid: this.invalid, reasons: { ...this.reasons }, seqGaps: this.seqGaps, phases: { ...this.phases } }; },
      };
      this.recorders.add(r); return r;
    }
  }
  function supportText(reason) {
    if (reason === "ios") return "Safari en andere browsers op iPhone en iPad ondersteunen geen Web Bluetooth. Een echte sensor werkt op de iPhone pas via een toekomstige native ScentPhone-app.";
    if (reason === "insecure") return "Bluetooth werkt alleen als de app via een beveiligde verbinding (https) is geopend.";
    if (reason === "no-bridge") return "De native ScentPhone-app is niet aanwezig. Deze optie werkt alleen binnen die (toekomstige) app.";
    if (reason === "browser") return "Deze browser ondersteunt geen Web Bluetooth. Gebruik Chrome of Edge op Android, Windows, macOS of ChromeOS.";
    return "Deze verbindingsmethode is hier niet beschikbaar.";
  }

  /* ------------------------------------------------------------------ */
  /* Meting uitvoeren                                                     */
  /* ------------------------------------------------------------------ */
  /** Basislijn (schone lucht) → monster → verwerking. Geeft { measurement, raw } of gooit een fout (er is dan niets bewaard). */
  async function runMeasurement(session, opts = {}) {
    const clock = session.clock, P = session.profile.processing, signal = opts.signal;
    if (!session.isLive()) throw new SensorError("not-live", "De sensor is niet verbonden of stuurt geen geldige meetgegevens. Er is niets gemeten.");
    const rec = session.record();
    const progress = (x) => { if (typeof opts.onProgress === "function") { try { opts.onProgress(x); } catch (e) {} } };
    const hold = async (ms, from, to, phase, label) => {
      const start = clock.now();
      for (;;) {
        const el = clock.now() - start;
        if (signal && signal.aborted) throw abortError();
        if (rec.lost || !session.isLive()) throw new SensorError("lost", (rec.lostReason || "De sensor stuurt geen geldige gegevens meer.") + " De meting is gestopt; er is niets bewaard.");
        progress({ phase, label, pct: from + (to - from) * Math.min(1, el / ms), remainingS: Math.max(0, Math.ceil((ms - el) / 1000)) });
        if (el >= ms) break;
        await sleepOn(clock, Math.min(200, ms - el), signal);
      }
    };
    try {
      session.hint("sample-off"); rec.mark("baselineStart");
      await hold(P.baselineS * 1000, 2, 40, "baseline", "Basislijn meten — houd het monster nog weg van de sensor");
      rec.mark("baselineEnd"); rec.mark("sampleStart"); session.hint("sample-on");
      await hold(P.sampleS * 1000, 40, 88, "sample", "Monster meten — houd de geurstrip of fles nu bij de sensor");
      rec.mark("sampleEnd"); session.hint("sample-off");
      progress({ phase: "process", label: "Signaal verwerken en kwaliteit beoordelen", pct: 92 });
      const snap = rec.snapshot();
      const processed = SignalProcessor.process(snap, session.profile, opts.calibration || null);
      return buildMeasurement(session, snap, processed);
    } finally { rec.stop(); session.hint("sample-off"); }
  }
  function signatureOf(profile, channelCount, model, simulated) {
    return [profile.id, channelCount, profile.processing.responseMode, (model || "").toLowerCase(), simulated ? "virtual" : "hw"].join("|");
  }
  const responseUnit = (mode, unit) => (mode === "difference" ? unit || "raw" : "rel");
  function buildMeasurement(session, snap, processed) {
    const profile = session.profile, simulated = session.simulated, n = processed.channelCount;
    const id = uid("ms"), ids = Array.from({ length: n }, (_, i) => "CH-" + String(i + 1).padStart(2, "0"));
    const dev = session.device || {};
    const lastEnv = [...snap.frames].reverse().find((f) => f.env);
    const sig = signatureOf(profile, n, dev.model, simulated);
    const startedAt = new Date(snap.t0).toISOString();
    const sensor = {
      kit: VERSION, profileId: profile.id, profileName: profile.name, transport: session.transportId, format: profile.frame.format,
      channelCount: n, responseMode: profile.processing.responseMode, unit: profile.channels.unit, signature: sig, virtual: simulated,
      labels: profile.channels.labels.slice(0, n),
    };
    const measurement = {
      schema: "scentphone.measurement", version: "1.1", id, perfumeId: "",
      source: simulated ? "simulated" : "sensor", simulated,                      /* virtuele testsensor = altijd simulatie */
      capturedAt: startedAt,
      device: { id: dev.id || "", name: dev.name || (simulated ? "Virtuele testsensor (simulatie)" : "Sensor"), kind: "sensor", firmware: dev.firmware || "", model: dev.model || "" },
      uncalibrated: true,
      channels: ids.map((cid, i) => ({ id: cid, unit: responseUnit(profile.processing.responseMode, profile.channels.unit), value: processed.response.steady[i] === null ? 0 : processed.response.steady[i] })),
      conditions: lastEnv ? lastEnv.env : null,
      sensor,
      timing: { startedAt, baselineMs: [snap.phases.baselineStart || 0, snap.phases.baselineEnd || 0], sampleMs: [snap.phases.sampleStart || 0, snap.phases.sampleEnd || 0], frames: snap.frames.length, rateHz: processed.data.rateHz },
      processed: { ...processed, quality: undefined },
      quality: processed.quality,
      rawRef: "sr-" + id,
      rawSummary: { frames: snap.frames.length, channels: n, invalid: snap.invalid },
    };
    delete measurement.processed.quality;
    const raw = {
      schema: "scentphone.sensorraw", version: "1.0", id: "sr-" + id, measurementId: id, capturedAt: startedAt, simulated,
      sensor: { ...sensor, device: { ...measurement.device }, profile: { id: profile.id, name: profile.name, transport: profile.transport, frame: { ...profile.frame }, channels: { ...profile.channels, labels: profile.channels.labels.slice() }, timing: { ...profile.timing }, processing: { ...profile.processing } } },
      phases: { ...snap.phases }, channelIds: ids,
      t: snap.frames.map((f) => f.t), v: snap.frames.map((f) => f.v.slice()),
      env: snap.frames.map((f) => (f.env ? [f.env.tempC, f.env.humidity] : null)),
      invalid: { count: snap.invalid, reasons: snap.reasons }, seqGaps: snap.seqGaps,
    };
    return { measurement, raw };
  }
  /** Zet een opgeslagen ruw record terug in de vorm die SignalProcessor verwacht (voor herverwerking/kalibratie later). */
  function rawToSnapshot(raw) {
    return { t0: new Date(raw.capturedAt).getTime(), frames: raw.t.map((t, i) => ({ t, v: raw.v[i], env: raw.env && raw.env[i] ? { tempC: raw.env[i][0], humidity: raw.env[i][1] } : null })), invalid: (raw.invalid && raw.invalid.count) || 0, reasons: (raw.invalid && raw.invalid.reasons) || {}, seqGaps: raw.seqGaps || 0, phases: { ...raw.phases } };
  }

  /* ------------------------------------------------------------------ */
  /* Signaalverwerking                                                    */
  /* ------------------------------------------------------------------ */
  const SignalProcessor = {
    version: "1.0",
    method: "Mediaanfilter (5) + voortschrijdend gemiddelde (3); basislijn = gemiddelde laatste 70% van de basislijnfase met driftcorrectie; respons = plateau (laatste 40% van de monsterfase); patroon = respons genormaliseerd op lengte 1 (L2).",
    median5(ys) { return ys.map((_, i) => median(ys.slice(Math.max(0, i - 2), i + 3))); },
    smooth3(ys) { return ys.map((_, i) => mean(ys.slice(Math.max(0, i - 1), i + 2))); },
    filter(ys) { return this.smooth3(this.median5(ys)); },
    /** @param snap {frames:[{t,v}], phases, invalid, seqGaps} @param profile protocolprofiel @param calibration optioneel {gains[], offsets[]} */
    process(snap, profile, calibration) {
      const P = profile.processing, mode = P.responseMode, issues = [];
      const add = (code, severity, text) => issues.push({ code, severity, text });
      const frames = snap.frames || [], ph = snap.phases || {};
      const n = frames.length ? frames[0].v.length : 0;
      const bS = ph.baselineStart || 0, bE = isNum(ph.baselineEnd) ? ph.baselineEnd : 0, sS = isNum(ph.sampleStart) ? ph.sampleStart : bE, sE = isNum(ph.sampleEnd) ? ph.sampleEnd : Infinity;
      const base = frames.filter((f) => f.t >= bS && f.t < bE), smp = frames.filter((f) => f.t >= sS && f.t <= sE);
      const durS = Math.max(0.001, ((isFinite(sE) ? sE : (frames.length ? frames[frames.length - 1].t : 0)) - bS) / 1000);
      const rateHz = frames.length >= 2 ? +(((frames.length - 1) * 1000) / Math.max(1, frames[frames.length - 1].t - frames[0].t)).toFixed(2) : 0;
      const empty = (why, code) => {
        add(code, "reject", why);
        return { version: this.version, method: this.method, params: { ...P }, channelCount: n, data: { baselineFrames: base.length, sampleFrames: smp.length, rateHz, invalidFrames: snap.invalid || 0 },
          baseline: { mean: [], noise: [], drift: [] }, response: { steady: Array(n).fill(null), peak: [], riseS: [] }, snr: [], pattern: null, magnitude: 0, anomalies: {},
          quality: { score: 0, grade: "Onvoldoende", accepted: false, components: [], issues, signal: false } };
      };
      if (!n) return empty("Er zijn geen geldige meetgegevens ontvangen.", "no-frames");
      if (frames.some((f) => f.v.length !== n)) return empty("Het aantal sensorkanalen veranderde tijdens de meting.", "channel-change");
      if (base.length < 5 || smp.length < 8) return empty("Te weinig meetgegevens (" + base.length + " basislijnframes en " + smp.length + " monsterframes; minimaal 5 en 8).", "too-few");
      const eps = 1e-9, chan = (arr, i) => arr.map((f) => f.v[i]), times = (arr) => arr.map((f) => f.t);
      const bT = times(base), sT = times(smp), k0 = Math.floor(base.length * 0.3), k1 = Math.floor(smp.length * 0.6);
      const bMid = mean(bT.slice(k0)), out = { mean: [], noise: [], drift: [] }, resp = { steady: [], peak: [], riseS: [] }, snr = [], noiseResp = [];
      let spikes = 0, satCh = 0, deadCh = 0, driftComp = false;
      const { min, max } = profile.channels;
      for (let i = 0; i < n; i++) {
        const bRaw = chan(base, i), sRaw = chan(smp, i), bF = this.filter(bRaw), sF = this.filter(sRaw);
        const ref = bF.slice(k0), b = mean(ref), sigma = robustNoise(bRaw.slice(k0));
        const sl = slope(bT, bF), drift = (sl * Math.max(1, bT[bT.length - 1] - bT[0])) / Math.max(Math.abs(b), eps);
        out.mean.push(rnd(b, 4)); out.noise.push(rnd(sigma, 5)); out.drift.push(rnd(mode === "difference" ? sl * Math.max(1, bT[bT.length - 1] - bT[0]) : drift, 5));
        const comp = mode !== "difference" ? Math.abs(drift) >= 0.01 : false; if (comp) driftComp = true;
        const bAt = (t) => (comp ? b + sl * (t - bMid) : b);
        const r = (x, t) => { const bb = bAt(t); return mode === "difference" ? x - bb : mode === "inverse-ratio" ? (Math.abs(x) > eps ? bb / x - 1 : 0) : (x - bb) / Math.max(Math.abs(bb), eps); };
        const sR = sF.map((x, j) => r(x, sT[j]));
        let steady = mean(sR.slice(k1));
        if (calibration && Array.isArray(calibration.gains) && calibration.gains.length === n) steady = steady * (isNum(calibration.gains[i]) ? calibration.gains[i] : 1) + (Array.isArray(calibration.offsets) && isNum(calibration.offsets[i]) ? calibration.offsets[i] : 0);
        const peak = sR.reduce((m, x) => (Math.abs(x) > Math.abs(m) ? x : m), 0);
        const t90i = sR.findIndex((x) => Math.abs(steady) > eps && Math.sign(x) === Math.sign(steady) && Math.abs(x) >= 0.9 * Math.abs(steady));
        resp.steady.push(rnd(steady, 6)); resp.peak.push(rnd(peak, 6)); resp.riseS.push(t90i >= 0 ? rnd((sT[t90i] - sS) / 1000, 2) : null);
        const nr = mode === "difference" ? sigma : sigma / Math.max(Math.abs(b), eps); noiseResp.push(nr);
        snr.push(rnd(Math.abs(steady) / Math.max(isNum(nr) ? nr : 0, mode === "difference" ? 1e-9 : 1e-5), 2));
        /* afwijkingen */
        const m5 = this.median5(bRaw.concat(sRaw)), all = bRaw.concat(sRaw), dev = all.map((x, j) => Math.abs(x - m5[j]));
        const thr = Math.max(6 * 1.4826 * mad(dev), 0.01 * Math.max(Math.abs(b), eps));
        spikes += dev.filter((d) => d > thr).length;
        if (min !== null || max !== null) { const sat = sRaw.filter((x) => (max !== null && x >= max) || (min !== null && x <= min)).length / sRaw.length; if (sat > 0.1) satCh++; }
        if (Math.max(...bRaw) === Math.min(...bRaw) && Math.max(...sRaw) === Math.min(...sRaw)) deadCh++;
      }
      /* onderbrekingen */
      const allT = times(frames), diffs = allT.slice(1).map((t, i) => t - allT[i]);
      const expInt = profile.timing.expectedHz > 0 ? 1000 / profile.timing.expectedHz : median(diffs) || 1000;
      const gaps = diffs.filter((d) => d > Math.max(3 * expInt, 1000)), gapMs = gaps.reduce((s, d) => s + d, 0);
      const invalidRatio = (snap.invalid || 0) / Math.max(1, (snap.invalid || 0) + frames.length);
      const expectedFrames = profile.timing.expectedHz > 0 ? durS * profile.timing.expectedHz : frames.length;
      const steady = resp.steady.map((x) => x || 0), magnitude = l2(steady);
      const pattern = magnitude > 0 ? steady.map((x) => rnd(x / magnitude, 6)) : null;
      const maxSNR = Math.max(...snr.map((x) => x || 0)), maxResp = Math.max(...steady.map(Math.abs));
      const medDrift = median(out.drift.map((x) => Math.abs(x || 0)));
      const signal = maxSNR >= P.minSNR && (mode === "difference" || maxResp >= P.minResponse);
      /* kwaliteit */
      const completeness = clamp01(Math.min(frames.length / Math.max(1, expectedFrames), 1) - (gapMs / (durS * 1000)) * 2);
      const validity = clamp01(1 - invalidRatio * 3 - (snap.seqGaps || 0) / Math.max(1, frames.length));
      const stability = mode === "difference" ? 1 : clamp01(1 - (medDrift - 0.01) / 0.14);
      const strength = maxSNR < 3 ? 0 : maxSNR >= 20 ? 1 : 0.3 + 0.7 * ((maxSNR - 3) / 17);
      const integrity = clamp01(1 - (satCh / n) * 2 - Math.min(0.5, spikes / Math.max(1, frames.length * n)) * 2 - (deadCh / n));
      const components = [
        { key: "completeness", label: "Volledigheid van de gegevens", value: rnd(completeness, 3), weight: 0.2 },
        { key: "validity", label: "Geldige frames", value: rnd(validity, 3), weight: 0.15 },
        { key: "stability", label: "Stabiele basislijn", value: rnd(stability, 3), weight: 0.2 },
        { key: "strength", label: "Sterkte van het geursignaal", value: rnd(strength, 3), weight: 0.3 },
        { key: "integrity", label: "Geen verzadiging of storingen", value: rnd(integrity, 3), weight: 0.15 },
      ];
      const score = Math.round(100 * components.reduce((s, c) => s + c.value * c.weight, 0));
      if (!signal) add("no-signal", "reject", "Geen duidelijk geursignaal: de meting verschilt nauwelijks van de schone lucht (beste signaal-ruisverhouding " + maxSNR.toFixed(1) + ", minimaal " + P.minSNR + ").");
      if (satCh / n > 0.25) add("saturation", "reject", satCh + " van de " + n + " kanalen raakten verzadigd. Houd het monster verder van de sensor.");
      else if (satCh) add("saturation", "warn", satCh + " kanaal/kanalen raakten deels verzadigd.");
      if (mode !== "difference" && medDrift > 0.15) add("drift", "reject", "De basislijn is niet stabiel (drift " + (medDrift * 100).toFixed(1) + "%). Laat de sensor langer opwarmen in schone lucht.");
      else if (mode !== "difference" && medDrift > 0.03) add("drift", "warn", "De basislijn drijft weg (" + (medDrift * 100).toFixed(1) + "%); er is gecorrigeerd, maar laat de sensor bij voorkeur langer opwarmen.");
      if (invalidRatio > 0.2) add("invalid", "reject", Math.round(invalidRatio * 100) + "% van de ontvangen frames was ongeldig.");
      else if (invalidRatio > 0.02) add("invalid", "warn", Math.round(invalidRatio * 100) + "% van de ontvangen frames was ongeldig en is genegeerd.");
      if (gapMs / (durS * 1000) > 0.3) add("gaps", "reject", "Er vielen te lang geen gegevens binnen (" + (gapMs / 1000).toFixed(1) + " s).");
      else if (gaps.length) add("gaps", "warn", gaps.length + " onderbreking(en) in de gegevens (" + (gapMs / 1000).toFixed(1) + " s).");
      if (snap.seqGaps) add("seq", "info", snap.seqGaps + " frames ontbraken volgens het volgnummer.");
      if (deadCh) add("dead", "warn", deadCh + " kanaal/kanalen gaven geen enkele verandering.");
      if (spikes > frames.length * n * 0.05) add("spikes", "warn", "Veel pieken in de meetwaarden (" + spikes + "); die zijn weggefilterd.");
      if (signal && maxSNR < 10) add("weak", "info", "Het geursignaal is zwak (signaal-ruisverhouding " + maxSNR.toFixed(1) + ").");
      const rejected = issues.some((x) => x.severity === "reject");
      if (!rejected && score < 50) add("low-score", "reject", "De meetkwaliteit is te laag (" + score + " van 100).");
      const accepted = !issues.some((x) => x.severity === "reject");
      return {
        version: this.version, method: this.method, params: { ...P }, channelCount: n,
        data: { baselineFrames: base.length, sampleFrames: smp.length, rateHz, invalidFrames: snap.invalid || 0, seqGaps: snap.seqGaps || 0, gaps: gaps.length, gapMs: Math.round(gapMs) },
        baseline: out, driftCompensated: driftComp, response: resp, snr, pattern, magnitude: rnd(magnitude, 6),
        anomalies: { spikes, saturatedChannels: satCh, deadChannels: deadCh },
        calibrationApplied: !!(calibration && Array.isArray(calibration.gains) && calibration.gains.length === n),
        quality: { score: accepted ? score : Math.min(score, 49), grade: !accepted ? "Onvoldoende" : score >= 75 ? "Goed" : "Voldoende", accepted, components, issues, signal, maxSNR: rnd(maxSNR, 2) },
      };
    },
  };

  /* ------------------------------------------------------------------ */
  /* Herkenning                                                           */
  /* ------------------------------------------------------------------ */
  const Recognizer = {
    version: "1.0",
    defaults: { unknownBelow: 0.92, margin: 0.02 },
    methods: new Map(),
    /** Toekomstige methoden (bijv. machine learning) registreren zich hier. predict(m, candidates, opts) -> [{perfumeId, similarity 0..1, note?}] */
    register(method) { if (!method || !method.id || typeof method.predict !== "function") throw new SensorError("config", "Ongeldige herkenningsmethode."); this.methods.set(method.id, method); },
    /** Twee metingen zijn alleen vergelijkbaar bij dezelfde herkomst (echt/simulatie) en hetzelfde sensortype. */
    compatible(a, b) {
      if (!a || !b || !a.sensor || !b.sensor) return { ok: false, reason: "Een van de metingen heeft geen sensorgegevens." };
      if (a.source !== b.source || !!a.sensor.virtual !== !!b.sensor.virtual) return { ok: false, reason: "Een echte sensormeting wordt nooit met een simulatie vergeleken." };
      if (a.sensor.signature !== b.sensor.signature) return { ok: false, reason: "De metingen komen van een ander sensortype of protocolprofiel." };
      if (!a.processed || !b.processed || !Array.isArray(a.processed.pattern) || !Array.isArray(b.processed.pattern) || a.processed.pattern.length !== b.processed.pattern.length) return { ok: false, reason: "Een van de metingen heeft geen bruikbaar geurpatroon." };
      return { ok: true };
    },
    usable(m) { return !!(m && m.sensor && m.processed && Array.isArray(m.processed.pattern) && m.quality && m.quality.accepted); },
    /** Vergelijkt twee metingen en legt per kanaal uit waar ze op elkaar lijken of verschillen. */
    compare(a, b) {
      const c = this.compatible(a, b); if (!c.ok) return { ok: false, reason: c.reason };
      const pa = a.processed.pattern, pb = b.processed.pattern, cos = cosine(pa, pb);
      const labels = (a.sensor.labels || []);
      const channels = pa.map((x, i) => ({ id: "CH-" + String(i + 1).padStart(2, "0"), label: labels[i] || "", a: x, b: pb[i], diff: rnd(x - pb[i], 4), contrib: rnd(x * pb[i], 4) }));
      const byDiff = [...channels].sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
      const ma = a.processed.magnitude || 0, mb = b.processed.magnitude || 0;
      return { ok: true, similarity: rnd(cos, 4), score: Math.round(Math.max(0, cos) * 100), channels, differ: byDiff.slice(0, 3), agree: [...channels].sort((x, y) => y.contrib - x.contrib).slice(0, 3), intensityRatio: ma && mb ? rnd(Math.max(ma, mb) / Math.min(ma, mb), 3) : null };
    },
    /** Gemiddelde onderlinge gelijkenis van meerdere metingen (herhaalbaarheid). */
    repeatability(ms) {
      const u = ms.filter((m) => this.usable(m)); if (u.length < 2) return null;
      const sims = []; for (let i = 0; i < u.length; i++) for (let j = i + 1; j < u.length; j++) { const c = this.compare(u[i], u[j]); if (c.ok) sims.push(c.similarity); }
      return sims.length ? { mean: rnd(mean(sims), 4), min: rnd(Math.min(...sims), 4), pairs: sims.length } : null;
    },
    /**
     * Herkent een meting door te vergelijken met eerder opgeslagen referentiemetingen.
     * @param m meting (met processed.pattern)
     * @param library [{ perfume:{id,brand,name}, measurements:[...] }]
     * @param opts { thresholds?, method?, excludeId? }
     * Resultaat.status: "rejected" | "no-references" | "unknown" | "ambiguous" | "match"
     */
    recognize(m, library, opts = {}) {
      const th = { ...this.defaults, ...(opts.thresholds || {}) };
      const base = { engine: "sensor-" + this.version, method: "", thresholds: th, matches: [], references: 0, perfumes: 0, explanation: [] };
      if (!m || !m.quality || !m.quality.accepted || !Array.isArray(m.processed && m.processed.pattern)) return { ...base, status: "rejected", explanation: ["De meting heeft onvoldoende kwaliteit en is niet vergeleken."] };
      const cands = [];
      (library || []).forEach(({ perfume, measurements }) => {
        const refs = (measurements || []).filter((x) => x.id !== m.id && x.id !== opts.excludeId && this.usable(x) && this.compatible(m, x).ok);
        if (refs.length) cands.push({ perfume, refs });
      });
      const nRefs = cands.reduce((s, c) => s + c.refs.length, 0);
      if (!nRefs) return { ...base, status: "no-references", explanation: ["Er zijn nog geen bruikbare referentiemetingen van dit sensortype" + (m.sensor.virtual ? " (virtuele testsensor)" : "") + ". Zonder referenties noemt ScentPhone geen parfum."] };
      const method = (opts.method && this.methods.get(opts.method)) || null;
      let scored;
      if (method) {
        const pred = method.predict(m, cands, opts) || [];
        scored = cands.map((c) => { const p = pred.find((x) => x.perfumeId === c.perfume.id); return { perfume: c.perfume, similarity: p && isNum(p.similarity) ? clamp(p.similarity, -1, 1) : -1, refs: c.refs.length, note: p && p.note ? String(p.note).slice(0, 160) : "" }; });
        base.method = method.label || method.id;
      } else {
        scored = cands.map((c) => {
          const sims = c.refs.map((r) => cosine(m.processed.pattern, r.processed.pattern));
          const best = Math.max(...sims), bi = sims.indexOf(best);
          return { perfume: c.perfume, similarity: best, mean: mean(sims), refs: c.refs.length, bestRef: c.refs[bi].id, detail: this.compare(m, c.refs[bi]) };
        });
        base.method = "Dichtstbijzijnde referentie (cosinusgelijkenis van genormaliseerde sensorpatronen)";
      }
      scored.sort((a, b) => b.similarity - a.similarity);
      const topRaw = scored[0].similarity, secondRaw = scored[1] ? scored[1].similarity : null; /* beslissing op onafgeronde waarden */
      const matches = scored.slice(0, 5).map((x) => ({ ...x, similarity: rnd(x.similarity, 4), mean: x.mean === undefined ? undefined : rnd(x.mean, 4), score: Math.round(Math.max(0, x.similarity) * 100) }));
      const top = matches[0], second = matches[1];
      const expl = [
        "Vergeleken met " + nRefs + " referentiemeting" + (nRefs === 1 ? "" : "en") + " van " + cands.length + " parfum" + (cands.length === 1 ? "" : "s") + " met hetzelfde sensortype.",
        "Beste gelijkenis " + top.similarity.toFixed(3) + " (drempel voor herkenning " + th.unknownBelow.toFixed(2) + (second ? ", verschil met de tweede " + (top.similarity - second.similarity).toFixed(3) + ", minimaal " + th.margin.toFixed(2) : "") + ").",
      ];
      let status;
      if (topRaw < th.unknownBelow) { status = "unknown"; expl.push("Geen referentie lijkt genoeg op deze meting: onbekende geur."); }
      else if (secondRaw !== null && topRaw - secondRaw < th.margin) { status = "ambiguous"; expl.push("Meerdere parfums lijken ongeveer even sterk op deze meting; ScentPhone kiest er daarom geen."); }
      else { status = "match"; expl.push("Lijkt het meest op je eigen referentiemeting(en) van dit parfum."); }
      if (cands.length === 1 && status === "match") expl.push("Let op: er zijn alleen referenties van één parfum, dus elke geur die erop lijkt scoort hoog. Leg referenties van meer parfums vast.");
      return { ...base, status, matches, references: nRefs, perfumes: cands.length, explanation: expl };
    },
  };

  /* ------------------------------------------------------------------ */
  /* Opslaghulpen (opschonen van onvertrouwde gegevens bij import/back-up) */
  /* ------------------------------------------------------------------ */
  const numArr = (a, n, d = 6) => (Array.isArray(a) ? a.slice(0, n).map((x) => (isNum(x) ? rnd(x, d) : null)) : []);
  /** Houdt de sensorvelden van een meting over, opgeschoond. Leeg object als er geen sensorgegevens zijn. */
  function sanitizeMeasurementExtras(m) {
    if (!m || typeof m !== "object" || !m.sensor || typeof m.sensor !== "object") return {};
    const s = m.sensor, n = int(s.channelCount, 1, MAX_CHANNELS, 0); if (!n) return {};
    const out = {
      sensor: { kit: str(s.kit, 16), profileId: str(s.profileId, 64), profileName: str(s.profileName, 80), transport: str(s.transport, 24), format: FORMATS[s.format] ? s.format : "", channelCount: n,
        responseMode: RESPONSE_MODES[s.responseMode] ? s.responseMode : "relative", unit: str(s.unit, 16), signature: str(s.signature, 200), virtual: !!s.virtual, labels: Array.isArray(s.labels) ? s.labels.slice(0, n).map((x) => str(x, 24)) : [] },
    };
    const t = m.timing;
    if (t && typeof t === "object") out.timing = { startedAt: typeof t.startedAt === "string" && !isNaN(new Date(t.startedAt)) ? new Date(t.startedAt).toISOString() : null, baselineMs: numArr(t.baselineMs, 2, 0), sampleMs: numArr(t.sampleMs, 2, 0), frames: int(t.frames, 0, 1e6, 0), rateHz: num(t.rateHz, 0, 1000, 0) };
    const p = m.processed;
    if (p && typeof p === "object") {
      const pr = p.params && typeof p.params === "object" ? p.params : {};
      out.processed = {
        version: str(p.version, 8), method: str(p.method, 400), channelCount: n,
        params: { responseMode: RESPONSE_MODES[pr.responseMode] ? pr.responseMode : out.sensor.responseMode, baselineS: num(pr.baselineS, 0, 1e4, 0), sampleS: num(pr.sampleS, 0, 1e4, 0), minSNR: num(pr.minSNR, 0, 1e3, 0), minResponse: num(pr.minResponse, 0, 10, 0) },
        data: p.data && typeof p.data === "object" ? Object.fromEntries(["baselineFrames", "sampleFrames", "rateHz", "invalidFrames", "seqGaps", "gaps", "gapMs"].map((k) => [k, num(p.data[k], 0, 1e9, 0)])) : {},
        baseline: { mean: numArr(p.baseline && p.baseline.mean, n, 4), noise: numArr(p.baseline && p.baseline.noise, n), drift: numArr(p.baseline && p.baseline.drift, n) },
        driftCompensated: !!p.driftCompensated,
        response: { steady: numArr(p.response && p.response.steady, n), peak: numArr(p.response && p.response.peak, n), riseS: numArr(p.response && p.response.riseS, n, 2) },
        snr: numArr(p.snr, n, 2),
        pattern: Array.isArray(p.pattern) && p.pattern.length === n && p.pattern.every(isNum) ? p.pattern.map((x) => rnd(x, 6)) : null,
        magnitude: num(p.magnitude, 0, 1e12, 0),
        anomalies: p.anomalies && typeof p.anomalies === "object" ? { spikes: int(p.anomalies.spikes, 0, 1e9, 0), saturatedChannels: int(p.anomalies.saturatedChannels, 0, n, 0), deadChannels: int(p.anomalies.deadChannels, 0, n, 0) } : {},
        calibrationApplied: !!p.calibrationApplied,
      };
    }
    const q = m.quality;
    if (q && typeof q === "object") out.quality = {
      score: int(q.score, 0, 100, 0), grade: ["Goed", "Voldoende", "Onvoldoende"].includes(q.grade) ? q.grade : "Onvoldoende", accepted: !!q.accepted && !!(out.processed && out.processed.pattern), signal: !!q.signal, maxSNR: num(q.maxSNR, 0, 1e6, 0),
      components: Array.isArray(q.components) ? q.components.slice(0, 8).map((c) => ({ key: str(c && c.key, 24), label: str(c && c.label, 60), value: num(c && c.value, 0, 1, 0), weight: num(c && c.weight, 0, 1, 0) })) : [],
      issues: Array.isArray(q.issues) ? q.issues.slice(0, 20).map((x) => ({ code: str(x && x.code, 24), severity: ["info", "warn", "reject"].includes(x && x.severity) ? x.severity : "info", text: str(x && x.text, 240) })) : [],
    };
    if (typeof m.rawRef === "string" && /^sr-[\w-]{1,70}$/.test(m.rawRef)) out.rawRef = m.rawRef;
    if (m.rawSummary && typeof m.rawSummary === "object") out.rawSummary = { frames: int(m.rawSummary.frames, 0, 1e6, 0), channels: int(m.rawSummary.channels, 0, MAX_CHANNELS, 0), invalid: int(m.rawSummary.invalid, 0, 1e9, 0) };
    return out;
  }
  /** Controleert een ruw meetrecord (back-up/import). Gooit een fout met leesbare reden. */
  function sanitizeRaw(r) {
    if (!r || typeof r !== "object" || r.schema !== "scentphone.sensorraw") throw new SensorError("raw", "geen ruw meetrecord");
    if (String(r.version || "").split(".")[0] !== "1") throw new SensorError("raw", "niet-ondersteunde versie");
    if (typeof r.id !== "string" || !/^sr-[\w-]{1,70}$/.test(r.id) || typeof r.measurementId !== "string") throw new SensorError("raw", "ongeldige id");
    const ids = Array.isArray(r.channelIds) ? r.channelIds.slice(0, MAX_CHANNELS).map((x) => str(String(x), 32)) : [];
    if (!ids.length) throw new SensorError("raw", "geen kanalen");
    if (!Array.isArray(r.t) || !Array.isArray(r.v) || r.t.length !== r.v.length || r.t.length > 20000) throw new SensorError("raw", "ongeldige tijdreeks");
    const t = r.t.map((x) => (isNum(x) ? Math.round(x) : NaN)); if (t.some((x) => !isNum(x))) throw new SensorError("raw", "ongeldig tijdstip");
    const v = r.v.map((row) => { if (!Array.isArray(row) || row.length !== ids.length || !row.every(isNum)) throw new SensorError("raw", "ongeldige meetwaarden"); return row.slice(); });
    const s = r.sensor && typeof r.sensor === "object" ? r.sensor : {};
    let profile = null; if (s.profile && typeof s.profile === "object") { try { profile = validateProfile(s.profile).profile; } catch (e) { profile = null; } }
    const extras = sanitizeMeasurementExtras({ sensor: s });
    return {
      schema: "scentphone.sensorraw", version: "1.0", id: r.id, measurementId: str(r.measurementId, 64),
      capturedAt: typeof r.capturedAt === "string" && !isNaN(new Date(r.capturedAt)) ? new Date(r.capturedAt).toISOString() : new Date(0).toISOString(),
      simulated: !!r.simulated || !!(extras.sensor && extras.sensor.virtual),
      sensor: { ...(extras.sensor || {}), device: s.device && typeof s.device === "object" ? { id: str(s.device.id, 64), name: str(s.device.name, 80), model: str(s.device.model, 64), firmware: str(s.device.firmware, 32) } : {}, profile: profile ? { id: profile.id, name: profile.name, transport: profile.transport, frame: profile.frame, channels: profile.channels, timing: profile.timing, processing: profile.processing } : null },
      phases: Object.fromEntries(["baselineStart", "baselineEnd", "sampleStart", "sampleEnd"].map((k) => [k, isNum(r.phases && r.phases[k]) ? Math.round(r.phases[k]) : 0])),
      channelIds: ids, t, v,
      env: Array.isArray(r.env) && r.env.length === t.length ? r.env.map((e) => (Array.isArray(e) && e.length === 2 && e.every(isNum) ? e.slice() : null)) : t.map(() => null),
      invalid: { count: int(r.invalid && r.invalid.count, 0, 1e9, 0), reasons: {} }, seqGaps: int(r.seqGaps, 0, 1e9, 0),
    };
  }
  /** Ruwe meetgegevens als CSV (puntkomma, met fase per regel). */
  function rawToCSV(raw) {
    const ph = raw.phases || {};
    const phase = (t) => (t >= (ph.sampleStart || Infinity) && t <= (ph.sampleEnd || Infinity) ? "monster" : t >= (ph.baselineStart || 0) && t < (ph.baselineEnd || 0) ? "basislijn" : "overig");
    const head = ["t_ms", "fase", ...raw.channelIds, "temp_c", "rv_pct"].join(";");
    const rows = raw.t.map((t, i) => [t, phase(t), ...raw.v[i], raw.env && raw.env[i] ? raw.env[i][0] : "", raw.env && raw.env[i] ? raw.env[i][1] : ""].join(";"));
    return "# ScentPhone ruwe sensormeting " + raw.measurementId + " · " + raw.capturedAt + (raw.simulated ? " · SIMULATIE (virtuele testsensor)" : " · echte sensor") + "\n" + head + "\n" + rows.join("\n") + "\n";
  }
  /** Gelabelde dataset voor toekomstige kalibratie of machine learning (alleen geaccepteerde metingen). */
  function buildTrainingSet(library, opts = {}) {
    const samples = [];
    (library || []).forEach(({ perfume, measurements }) => (measurements || []).forEach((m) => {
      if (!Recognizer.usable(m)) return;
      if (opts.source && m.source !== opts.source) return;
      samples.push({ label: perfume.id, brand: perfume.brand, name: perfume.name, measurementId: m.id, capturedAt: m.capturedAt, source: m.source, signature: m.sensor.signature, pattern: m.processed.pattern, steady: m.processed.response.steady, magnitude: m.processed.magnitude, quality: m.quality.score, conditions: m.conditions || null, rawRef: m.rawRef || null });
    }));
    return { schema: "scentphone.trainingset", version: "1.0", createdAt: new Date().toISOString(), kit: VERSION, notice: "Gelabelde sensormetingen uit je eigen bibliotheek. Metingen met source 'simulated' zijn gesimuleerd.", signatures: [...new Set(samples.map((s) => s.signature))], samples };
  }

  return {
    VERSION, SensorError, RealClock, ManualClock, sleepOn,
    canonicalUuid, FORMATS, VALUE_TYPES, RESPONSE_MODES, TEMPLATES, profileFromTemplate, validateProfile,
    toBytes, decodeReferenceFrame, encodeReferenceFrame, FrameDecoder, validateFrame,
    makeWebBluetoothTransport, makeNativeTransport, makeVirtualTransport, VIRTUAL_SUBSTANCES, VIRTUAL_FAULTS, substancePattern, isIOS, supportText,
    STATES, SensorSession, runMeasurement, buildMeasurement, rawToSnapshot, signatureOf,
    SignalProcessor, Recognizer, cosine,
    sanitizeMeasurementExtras, sanitizeRaw, rawToCSV, buildTrainingSet,
  };
});
