import { useState, useRef, useEffect, useCallback, useMemo } from "react";

/* ─────────────────────────────────────────────────
   Photo Studio — Phase 4.1
   + Folder Import, HEIC Support, Progress UI
   ───────────────────────────────────────────────── */

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const uid = () => crypto.randomUUID?.() || Math.random().toString(36).slice(2);
const lerp = (a, b, t) => a + (b - a) * t;
const deepClone = (o) => JSON.parse(JSON.stringify(o));

// ── Defaults ──
const DEFAULT_CURVE = [{ x: 0, y: 0 }, { x: 0.25, y: 0.25 }, { x: 0.75, y: 0.75 }, { x: 1, y: 1 }];
const HSL_COLORS = ["レッド", "オレンジ", "イエロー", "グリーン", "アクア", "ブルー", "パープル", "マゼンタ"];
const HSL_HUE_CENTERS = [0, 30, 60, 120, 180, 210, 270, 330];
const HSL_DOT_COLORS = ["#e74c3c", "#e67e22", "#f1c40f", "#2ecc71", "#1abc9c", "#3498db", "#9b59b6", "#e84393"];
const COLOR_LABELS = [
  { key: "none", label: "なし", color: "transparent" },
  { key: "red", label: "レッド", color: "#ef4444" },
  { key: "yellow", label: "イエロー", color: "#eab308" },
  { key: "green", label: "グリーン", color: "#22c55e" },
  { key: "blue", label: "ブルー", color: "#3b82f6" },
  { key: "purple", label: "パープル", color: "#a855f7" },
];

const DEFAULT_HSL = () => { const h = {}; HSL_COLORS.forEach((c) => { h[c] = { hue: 0, saturation: 0, luminance: 0 }; }); return h; };

const DEFAULT_ADJ = {
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  temperature: 0, tint: 0, saturation: 0, vibrance: 0, clarity: 0, dehaze: 0, sharpness: 0,
  toneCurve: deepClone(DEFAULT_CURVE), toneCurveR: deepClone(DEFAULT_CURVE),
  toneCurveG: deepClone(DEFAULT_CURVE), toneCurveB: deepClone(DEFAULT_CURVE),
  hsl: DEFAULT_HSL(),
  vignette: 0, vignetteFeather: 50, grain: 0, grainSize: 25,
  splitHighHue: 40, splitHighSat: 0, splitShadHue: 220, splitShadSat: 0, splitBalance: 0,
  rotation: 0, crop: null,
};

// ═══ IndexedDB Helper ═══
const DB_NAME = "PhotoStudioDB";
const DB_VER = 2;
function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("photos")) db.createObjectStore("photos", { keyPath: "id" });
      if (!db.objectStoreNames.contains("presets")) db.createObjectStore("presets", { keyPath: "id" });
      if (!db.objectStoreNames.contains("collections")) db.createObjectStore("collections", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function dbGetAll(store) {
  const db = await openDB();
  return new Promise((res) => {
    const tx = db.transaction(store, "readonly");
    tx.objectStore(store).getAll().onsuccess = (e) => res(e.target.result);
  });
}
async function dbPut(store, data) {
  const db = await openDB();
  return new Promise((res) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(data).onsuccess = () => res();
  });
}
async function dbDelete(store, id) {
  const db = await openDB();
  return new Promise((res) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(id).onsuccess = () => res();
  });
}
async function dbPutAll(store, items) {
  const db = await openDB();
  return new Promise((res) => {
    const tx = db.transaction(store, "readwrite");
    const s = tx.objectStore(store);
    items.forEach((item) => s.put(item));
    tx.oncomplete = () => res();
  });
}
async function dbClear(store) {
  const db = await openDB();
  return new Promise((res) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).clear().onsuccess = () => res();
  });
}

// ═══ Image Processing ═══

// ── HEIC / File helpers ──
const IMAGE_EXTS = /\.(jpe?g|png|gif|webp|bmp|tiff?|heic|heif|avif)$/i;
const HEIC_EXTS = /\.(heic|heif)$/i;

async function convertHEICtoJPEG(file) {
  // Try native browser decode first (Safari supports HEIC natively)
  try {
    const bmp = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width; canvas.height = bmp.height;
    canvas.getContext("2d").drawImage(bmp, 0, 0);
    bmp.close();
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.95));
    return new File([blob], file.name.replace(/\.(heic|heif)$/i, ".jpg"), { type: "image/jpeg" });
  } catch (e) {
    // If native fails, try heic2any library (loaded dynamically)
    try {
      if (!window._heic2any) {
        const script = document.createElement("script");
        script.src = "https://cdnjs.cloudflare.com/ajax/libs/heic2any/0.0.4/heic2any.min.js";
        await new Promise((res, rej) => { script.onload = res; script.onerror = rej; document.head.appendChild(script); });
        window._heic2any = window.heic2any;
      }
      const blob = await window._heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 });
      const result = Array.isArray(blob) ? blob[0] : blob;
      return new File([result], file.name.replace(/\.(heic|heif)$/i, ".jpg"), { type: "image/jpeg" });
    } catch (e2) {
      console.warn("HEIC conversion failed:", file.name, e2);
      return null;
    }
  }
}

async function* scanDirectory(dirHandle, path = "") {
  for await (const entry of dirHandle.values()) {
    if (entry.kind === "file") {
      if (IMAGE_EXTS.test(entry.name)) {
        try {
          const file = await entry.getFile();
          yield { file, path: path ? `${path}/${entry.name}` : entry.name };
        } catch (e) { /* skip inaccessible files */ }
      }
    } else if (entry.kind === "directory" && !entry.name.startsWith(".")) {
      yield* scanDirectory(entry, path ? `${path}/${entry.name}` : entry.name);
    }
  }
}

// ── Progress Dialog ──
function ImportProgress({ current, total, currentFile, onCancel }) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1100 }}>
      <div style={{ background: "#2a2a2a", borderRadius: 12, padding: 24, width: 380, border: "1px solid #444" }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "#fff", marginBottom: 16 }}>インポート中...</div>
        <div style={{ position: "relative", height: 8, background: "#333", borderRadius: 4, overflow: "hidden", marginBottom: 10 }}>
          <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${pct}%`, background: "#68b5ff", borderRadius: 4, transition: "width 0.2s" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#aaa", marginBottom: 6 }}>
          <span>{current} / {total} 枚</span>
          <span>{pct}%</span>
        </div>
        <div style={{ fontSize: 10, color: "#666", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginBottom: 14 }}>
          {currentFile || "スキャン中..."}
        </div>
        <button onClick={onCancel} style={{ width: "100%", border: "1px solid #555", borderRadius: 6, padding: "8px 0", fontSize: 12, cursor: "pointer", background: "#333", color: "#ccc" }}>
          キャンセル
        </button>
      </div>
    </div>
  );
}
function buildCurveLUT(points) {
  const lut = new Float32Array(256);
  const sorted = [...points].sort((a, b) => a.x - b.x);
  for (let i = 0; i < 256; i++) {
    const t = i / 255; let y = t;
    for (let j = 0; j < sorted.length - 1; j++) {
      if (t >= sorted[j].x && t <= sorted[j + 1].x) { y = lerp(sorted[j].y, sorted[j + 1].y, (t - sorted[j].x) / (sorted[j + 1].x - sorted[j].x)); break; }
    }
    if (t <= sorted[0].x) y = sorted[0].y;
    if (t >= sorted[sorted.length - 1].x) y = sorted[sorted.length - 1].y;
    lut[i] = clamp(y, 0, 1);
  }
  return lut;
}

function smoothstep(e0, e1, x) { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }

function rgb2hsl(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h = 0, s = 0; const l = (mx + mn) / 2;
  if (mx !== mn) { const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6; else if (mx === g) h = ((b - r) / d + 2) / 6; else h = ((r - g) / d + 4) / 6;
  } return [h * 360, s, l];
}
function hsl2rgb(h, s, l) {
  h = ((h % 360) + 360) % 360; const c = (1 - Math.abs(2 * l - 1)) * s; const x = c * (1 - Math.abs(((h / 60) % 2) - 1)); const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  return [r + m, g + m, b + m];
}

function applyAdjustments(ctx, img, adj, w, h) {
  ctx.clearRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
  const imageData = ctx.getImageData(0, 0, w, h); const d = imageData.data;
  const exp = Math.pow(2, adj.exposure / 2), con = adj.contrast / 100, sat = 1 + adj.saturation / 100;
  const vib = adj.vibrance / 200, temp = adj.temperature / 100, tintV = adj.tint / 100;
  const hl = adj.highlights / 200, sh = adj.shadows / 200, wh = adj.whites / 200, bl = adj.blacks / 200;
  const clar = adj.clarity / 100, dehaze = adj.dehaze / 200;
  const lutM = buildCurveLUT(adj.toneCurve || DEFAULT_CURVE), lutR = buildCurveLUT(adj.toneCurveR || DEFAULT_CURVE);
  const lutG = buildCurveLUT(adj.toneCurveG || DEFAULT_CURVE), lutB = buildCurveLUT(adj.toneCurveB || DEFAULT_CURVE);
  const hslAdj = adj.hsl || DEFAULT_HSL();

  for (let i = 0; i < d.length; i += 4) {
    let r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    r *= exp; g *= exp; b *= exp;
    r += temp * 0.08; b -= temp * 0.08; g += tintV * 0.05;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const hlM = smoothstep(0.5, 1, lum), shM = 1 - smoothstep(0, 0.5, lum);
    r += hl * hlM + sh * shM; g += hl * hlM + sh * shM; b += hl * hlM + sh * shM;
    const whM = smoothstep(0.75, 1, lum), blM = 1 - smoothstep(0, 0.25, lum);
    r += wh * whM - bl * blM; g += wh * whM - bl * blM; b += wh * whM - bl * blM;
    r = (r - 0.5) * (1 + con) + 0.5; g = (g - 0.5) * (1 + con) + 0.5; b = (b - 0.5) * (1 + con) + 0.5;
    if (clar !== 0) { const mid = smoothstep(0.15, 0.85, lum) * (1 - smoothstep(0.15, 0.85, lum)) * 4; r += clar * mid * (r - lum) * 0.5; g += clar * mid * (g - lum) * 0.5; b += clar * mid * (b - lum) * 0.5; }
    if (dehaze !== 0) { r += dehaze * (r - 0.1); g += dehaze * (g - 0.1); b += dehaze * (b - 0.1); }
    const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = gray + (r - gray) * sat; g = gray + (g - gray) * sat; b = gray + (b - gray) * sat;
    if (vib !== 0) { const mxC = Math.max(r, g, b), mnC = Math.min(r, g, b); const cS = mxC === 0 ? 0 : (mxC - mnC) / mxC; const vB = 1 + vib * (1 - cS); const g2 = 0.2126 * r + 0.7152 * g + 0.0722 * b; r = g2 + (r - g2) * vB; g = g2 + (g - g2) * vB; b = g2 + (b - g2) * vB; }
    r = clamp(r, 0, 1); g = clamp(g, 0, 1); b = clamp(b, 0, 1);
    r = lutM[Math.round(r * 255)]; g = lutM[Math.round(g * 255)]; b = lutM[Math.round(b * 255)];
    r = lutR[Math.round(r * 255)]; g = lutG[Math.round(g * 255)]; b = lutB[Math.round(b * 255)];
    let [hue, hSat, hLum] = rgb2hsl(clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1));
    let hS = 0, sS = 0, lS = 0;
    for (let ci = 0; ci < 8; ci++) { let df = Math.abs(hue - HSL_HUE_CENTERS[ci]); if (df > 180) df = 360 - df; if (df < 45) { const wt = 1 - df / 45; const ca = hslAdj[HSL_COLORS[ci]]; if (ca) { hS += ca.hue * wt; sS += (ca.saturation / 100) * wt; lS += (ca.luminance / 100) * wt; } } }
    hue = (hue + hS + 360) % 360; hSat = clamp(hSat + sS, 0, 1); hLum = clamp(hLum + lS, 0, 1);
    [r, g, b] = hsl2rgb(hue, hSat, hLum);
    d[i] = clamp(r * 255, 0, 255); d[i + 1] = clamp(g * 255, 0, 255); d[i + 2] = clamp(b * 255, 0, 255);
  }

  // Post: vignette, split toning, grain
  const vigA = adj.vignette / 100, vigF = 0.2 + (adj.vignetteFeather / 100) * 0.8;
  const sHiS = adj.splitHighSat / 100, sShS = adj.splitShadSat / 100, sBal = (adj.splitBalance + 100) / 200;
  const grA = adj.grain / 100, grSz = Math.max(1, Math.round(1 + (adj.grainSize / 100) * 3));
  if (vigA !== 0 || sHiS > 0 || sShS > 0 || grA > 0) {
    const [shR, shG, shB] = hsl2rgb(adj.splitShadHue, 1, 0.5);
    const [hiR, hiG, hiB] = hsl2rgb(adj.splitHighHue, 1, 0.5);
    for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
      const i = (py * w + px) * 4;
      let r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      if (vigA !== 0) { const dx = (px / w - 0.5) * 2, dy = (py / h - 0.5) * 2; const dist = Math.sqrt(dx * dx + dy * dy) / 1.414; const v = 1 - smoothstep(vigF * 0.5, vigF, dist) * Math.abs(vigA); if (vigA > 0) { r *= v; g *= v; b *= v; } else { const iv = 2 - v; r *= iv; g *= iv; b *= iv; } }
      if (sHiS > 0 || sShS > 0) { const lu = 0.2126 * r + 0.7152 * g + 0.0722 * b; if (sShS > 0 && lu < sBal) { const w2 = (1 - lu / Math.max(sBal, 0.01)) * sShS * 0.3; r = lerp(r, shR * lu * 2, w2); g = lerp(g, shG * lu * 2, w2); b = lerp(b, shB * lu * 2, w2); } if (sHiS > 0 && lu >= sBal) { const w2 = ((lu - sBal) / Math.max(1 - sBal, 0.01)) * sHiS * 0.3; r = lerp(r, hiR * lu * 2, w2); g = lerp(g, hiG * lu * 2, w2); b = lerp(b, hiB * lu * 2, w2); } }
      if (grA > 0) { const gx = Math.floor(px / grSz), gy = Math.floor(py / grSz); const seed = (gx * 12289 + gy * 7919 + gx * gy * 3571) & 0xFFFF; const noise = ((seed / 65535) - 0.5) * grA * 0.35; r += noise; g += noise; b += noise; }
      d[i] = clamp(r * 255, 0, 255); d[i + 1] = clamp(g * 255, 0, 255); d[i + 2] = clamp(b * 255, 0, 255);
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

function computeHistogram(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h).data;
  const rH = new Uint32Array(256), gH = new Uint32Array(256), bH = new Uint32Array(256), lumH = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) { rH[d[i]]++; gH[d[i + 1]]++; bH[d[i + 2]]++; lumH[clamp(Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]), 0, 255)]++; }
  return { r: rH, g: gH, b: bH, lum: lumH };
}

// ── Undo/Redo ──
function useHistory(maxLen = 80) {
  const stack = useRef([]); const ptr = useRef(-1);
  const push = useCallback((s) => { stack.current = stack.current.slice(0, ptr.current + 1); stack.current.push(deepClone(s)); if (stack.current.length > maxLen) stack.current.shift(); ptr.current = stack.current.length - 1; }, [maxLen]);
  const undo = useCallback(() => { if (ptr.current > 0) { ptr.current--; return deepClone(stack.current[ptr.current]); } return null; }, []);
  const redo = useCallback(() => { if (ptr.current < stack.current.length - 1) { ptr.current++; return deepClone(stack.current[ptr.current]); } return null; }, []);
  const canUndo = useCallback(() => ptr.current > 0, []);
  const canRedo = useCallback(() => ptr.current < stack.current.length - 1, []);
  return { push, undo, redo, canUndo, canRedo };
}

// ═══ Sub-Components ═══
function Histogram({ data, width = 220, height = 60 }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!data || !ref.current) return;
    const ctx = ref.current.getContext("2d"); ctx.clearRect(0, 0, width, height);
    const mx = Math.max(...Array.from(data.lum).slice(1, 254), ...Array.from(data.r).slice(1, 254), ...Array.from(data.g).slice(1, 254), ...Array.from(data.b).slice(1, 254)) || 1;
    const draw = (ch, col) => { ctx.beginPath(); ctx.moveTo(0, height); for (let i = 0; i < 256; i++) ctx.lineTo((i / 255) * width, height - (ch[i] / mx) * height); ctx.lineTo(width, height); ctx.closePath(); ctx.fillStyle = col; ctx.fill(); };
    ctx.globalCompositeOperation = "source-over"; draw(data.lum, "rgba(180,180,180,0.3)");
    ctx.globalCompositeOperation = "screen"; draw(data.r, "rgba(220,60,60,0.45)"); draw(data.g, "rgba(60,180,60,0.45)"); draw(data.b, "rgba(60,80,220,0.45)");
  }, [data, width, height]);
  return <canvas ref={ref} width={width} height={height} style={{ width: "100%", height, borderRadius: 4, background: "#111" }} />;
}

function CurveEditor({ points, onChange, color = "#ccc" }) {
  const SZ = 180; const ref = useRef(null); const [drag, setDrag] = useState(null);
  const draw = useCallback(() => {
    const c = ref.current; if (!c) return; const ctx = c.getContext("2d"); ctx.clearRect(0, 0, SZ, SZ);
    ctx.strokeStyle = "rgba(255,255,255,0.08)"; ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) { const p = (i / 4) * SZ; ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, SZ); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(SZ, p); ctx.stroke(); }
    ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.beginPath(); ctx.moveTo(0, SZ); ctx.lineTo(SZ, 0); ctx.stroke();
    const sorted = [...points].sort((a, b) => a.x - b.x);
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
    for (let px = 0; px < SZ; px++) { const t = px / SZ; let y = t; for (let j = 0; j < sorted.length - 1; j++) { if (t >= sorted[j].x && t <= sorted[j + 1].x) { y = lerp(sorted[j].y, sorted[j + 1].y, (t - sorted[j].x) / (sorted[j + 1].x - sorted[j].x)); break; } } if (t <= sorted[0].x) y = sorted[0].y; if (t >= sorted[sorted.length - 1].x) y = sorted[sorted.length - 1].y; if (px === 0) ctx.moveTo(px, SZ - y * SZ); else ctx.lineTo(px, SZ - y * SZ); }
    ctx.stroke();
    points.forEach((pt, i) => { ctx.beginPath(); ctx.arc(pt.x * SZ, SZ - pt.y * SZ, i === drag ? 6 : 4, 0, Math.PI * 2); ctx.fillStyle = i === 0 || i === points.length - 1 ? "#888" : color; ctx.fill(); ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.stroke(); });
  }, [points, color, drag]);
  useEffect(() => { draw(); }, [draw]);
  const gP = (e) => { const r = ref.current.getBoundingClientRect(); const cx = e.touches ? e.touches[0].clientX : e.clientX; const cy = e.touches ? e.touches[0].clientY : e.clientY; return { x: clamp((cx - r.left) / SZ, 0, 1), y: clamp(1 - (cy - r.top) / SZ, 0, 1) }; };
  const onD = (e) => { const p = gP(e); let cl = -1, md = 0.05; points.forEach((pt, i) => { const d = Math.hypot(pt.x - p.x, pt.y - p.y); if (d < md) { md = d; cl = i; } }); if (cl >= 0) setDrag(cl); else { const np = [...points, { x: p.x, y: p.y }].sort((a, b) => a.x - b.x); onChange(np); setDrag(np.findIndex((pt) => pt.x === p.x && pt.y === p.y)); } };
  const onM = (e) => { if (drag === null) return; e.preventDefault(); const p = gP(e); const np = [...points]; if (drag === 0) np[0] = { x: 0, y: clamp(p.y, 0, 1) }; else if (drag === points.length - 1) np[drag] = { x: 1, y: clamp(p.y, 0, 1) }; else np[drag] = { x: clamp(p.x, 0.01, 0.99), y: clamp(p.y, 0, 1) }; onChange(np); };
  const onU = () => setDrag(null);
  const onDb = (e) => { const p = gP(e); let cl = -1, md = 0.05; points.forEach((pt, i) => { if (i === 0 || i === points.length - 1) return; const d = Math.hypot(pt.x - p.x, pt.y - p.y); if (d < md) { md = d; cl = i; } }); if (cl >= 0) onChange(points.filter((_, i) => i !== cl)); };
  return <canvas ref={ref} width={SZ} height={SZ} style={{ width: "100%", height: SZ, borderRadius: 4, background: "rgba(255,255,255,0.03)", cursor: "crosshair", touchAction: "none" }} onMouseDown={onD} onMouseMove={onM} onMouseUp={onU} onMouseLeave={onU} onDoubleClick={onDb} onTouchStart={onD} onTouchMove={onM} onTouchEnd={onU} />;
}

function HSLPanel({ hsl, onChange }) {
  const [tab, setTab] = useState("saturation");
  return (<div>
    <div style={{ display: "flex", gap: 2, marginBottom: 8 }}>
      {[{ key: "hue", label: "色相" }, { key: "saturation", label: "彩度" }, { key: "luminance", label: "輝度" }].map((t) => (
        <button key={t.key} onClick={() => setTab(t.key)} style={{ flex: 1, border: "none", borderRadius: 3, padding: "3px 0", fontSize: 10, cursor: "pointer", background: tab === t.key ? "#68b5ff" : "#333", color: tab === t.key ? "#111" : "#888", fontWeight: tab === t.key ? 600 : 400 }}>{t.label}</button>
      ))}
    </div>
    {HSL_COLORS.map((color, i) => { const val = hsl[color]?.[tab] || 0; const range = tab === "hue" ? [-30, 30] : [-100, 100]; return (
      <div key={color} style={{ marginBottom: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 1 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: HSL_DOT_COLORS[i], flexShrink: 0 }} />
          <span style={{ fontSize: 10, color: "#aaa", flex: 1 }}>{color}</span>
          <span style={{ fontSize: 10, color: val !== 0 ? "#68b5ff" : "#555", fontVariantNumeric: "tabular-nums", width: 32, textAlign: "right" }}>{val > 0 ? "+" : ""}{val}</span>
        </div>
        <input type="range" min={range[0]} max={range[1]} value={val} onChange={(e) => { const n = deepClone(hsl); n[color][tab] = parseInt(e.target.value); onChange(n); }} onDoubleClick={() => { const n = deepClone(hsl); n[color][tab] = 0; onChange(n); }} style={{ width: "100%", height: 10, accentColor: HSL_DOT_COLORS[i], cursor: "pointer" }} />
      </div>); })}
  </div>);
}

function Slider({ label, value, min, max, step = 1, onChange }) {
  const pct = ((value - min) / (max - min)) * 100; const isZ = min < 0;
  return (<div style={{ marginBottom: 6 }}>
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#aaa", marginBottom: 2 }}>
      <span>{label}</span>
      <span style={{ color: value !== 0 ? "#68b5ff" : "#666", fontVariantNumeric: "tabular-nums" }}>{value > 0 ? "+" : ""}{Number.isInteger(value) ? value : value.toFixed(2)}</span>
    </div>
    <div style={{ position: "relative", height: 14, display: "flex", alignItems: "center" }}>
      <div style={{ position: "absolute", left: 0, right: 0, height: 3, background: "#333", borderRadius: 2 }} />
      {isZ && <div style={{ position: "absolute", left: "50%", width: 1, height: 7, background: "#555", top: 3.5 }} />}
      <div style={{ position: "absolute", left: isZ ? `${Math.min(50, pct)}%` : 0, width: isZ ? `${Math.abs(pct - 50)}%` : `${pct}%`, height: 3, background: "#68b5ff", borderRadius: 2 }} />
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} onDoubleClick={() => onChange(0)} style={{ position: "absolute", width: "100%", height: 14, opacity: 0, cursor: "pointer", margin: 0 }} />
      <div style={{ position: "absolute", left: `calc(${pct}% - 6px)`, width: 12, height: 12, borderRadius: "50%", background: "#ddd", border: "2px solid #68b5ff", pointerEvents: "none" }} />
    </div>
  </div>);
}

function StarRating({ value, onChange, size = 14 }) {
  return <div style={{ display: "flex", gap: 1, cursor: "pointer" }}>{[1, 2, 3, 4, 5].map((s) => <span key={s} onClick={(e) => { e.stopPropagation(); onChange(value === s ? 0 : s); }} style={{ fontSize: size, color: s <= value ? "#f5c842" : "#444", userSelect: "none" }}>★</span>)}</div>;
}

function Section({ title, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (<div style={{ marginBottom: 8 }}>
    <div onClick={() => setOpen(!open)} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", padding: "6px 0", borderBottom: "1px solid #2a2a2a", userSelect: "none", fontSize: 11, fontWeight: 600, letterSpacing: 0.8, textTransform: "uppercase", color: "#888" }}>
      <span style={{ transform: open ? "rotate(90deg)" : "none", transition: "0.15s", fontSize: 9 }}>▶</span><span style={{ flex: 1 }}>{title}</span>
    </div>
    {open && <div style={{ paddingTop: 8 }}>{children}</div>}
  </div>);
}

function PresetBar({ presets, onApply, onSave, onDelete }) {
  return (<div>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
      {presets.map((p) => (<div key={p.id} style={{ display: "flex", alignItems: "center", gap: 2 }}>
        <button onClick={() => onApply(p)} style={{ border: "1px solid #444", background: "#2a2a2a", color: "#bbb", fontSize: 10, padding: "3px 8px", borderRadius: 3, cursor: "pointer" }}>{p.name}</button>
        <button onClick={() => onDelete(p.id)} style={{ border: "none", background: "transparent", color: "#666", fontSize: 10, cursor: "pointer", padding: "0 2px" }}>×</button>
      </div>))}
    </div>
    <button onClick={onSave} style={{ border: "1px dashed #555", background: "transparent", color: "#888", fontSize: 10, padding: "3px 10px", borderRadius: 3, cursor: "pointer", width: "100%" }}>+ プリセット保存</button>
  </div>);
}

function HuePicker({ value, onChange, saturation = 50 }) {
  const ref = useRef(null); const W = 200, H = 16;
  useEffect(() => { if (!ref.current) return; const ctx = ref.current.getContext("2d"); const grad = ctx.createLinearGradient(0, 0, W, 0); for (let i = 0; i <= 12; i++) grad.addColorStop(i / 12, `hsl(${i * 30}, ${saturation}%, 50%)`); ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H); const x = (value / 360) * W; ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, H / 2, 6, 0, Math.PI * 2); ctx.stroke(); }, [value, saturation]);
  const act = (e) => { const r = ref.current.getBoundingClientRect(); const cx = e.touches ? e.touches[0].clientX : e.clientX; onChange(clamp(Math.round(((cx - r.left) / r.width) * 360), 0, 360)); };
  return <canvas ref={ref} width={W} height={H} style={{ width: "100%", height: H, borderRadius: 4, cursor: "pointer", touchAction: "none" }} onMouseDown={(e) => { act(e); const mv = (ev) => act(ev); const up = () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); }; window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up); }} />;
}

// ── Crop Overlay ──
const CROP_RATIOS = [{ label: "フリー", value: null }, { label: "1:1", value: 1 }, { label: "4:3", value: 4 / 3 }, { label: "3:2", value: 3 / 2 }, { label: "16:9", value: 16 / 9 }];
function CropOverlay({ imgW, imgH, crop, onChange, onRotate, canvasRect }) {
  const [drag, setDrag] = useState(null); const [ratio, setRatio] = useState(null); const startRef = useRef(null);
  const cx = crop?.x || 0, cy = crop?.y || 0, cw = crop?.w || 1, ch = crop?.h || 1;
  const hSz = 10; const thirds = [1 / 3, 2 / 3];
  const onMD = (e, type) => { e.stopPropagation(); startRef.current = { mx: e.clientX, my: e.clientY, cx, cy, cw, ch }; setDrag(type); };
  useEffect(() => { if (!drag) return; const onMv = (e) => { const s = startRef.current; const dx = (e.clientX - s.mx) / canvasRect.width; const dy = (e.clientY - s.my) / canvasRect.height; let nx = s.cx, ny = s.cy, nw = s.cw, nh = s.ch; if (drag === "move") { nx = clamp(s.cx + dx, 0, 1 - s.cw); ny = clamp(s.cy + dy, 0, 1 - s.ch); } else if (drag === "br") { nw = clamp(s.cw + dx, 0.05, 1 - s.cx); nh = ratio ? nw / ratio * (imgW / imgH) : clamp(s.ch + dy, 0.05, 1 - s.cy); } else if (drag === "tl") { const dw = clamp(s.cw - dx, 0.05, s.cx + s.cw); const dh = ratio ? dw / ratio * (imgW / imgH) : clamp(s.ch - dy, 0.05, s.cy + s.ch); nx = s.cx + s.cw - dw; ny = s.cy + s.ch - dh; nw = dw; nh = dh; } onChange({ x: nx, y: ny, w: clamp(nw, 0.05, 1), h: clamp(nh, 0.05, 1) }); }; const onUp = () => setDrag(null); window.addEventListener("mousemove", onMv); window.addEventListener("mouseup", onUp); return () => { window.removeEventListener("mousemove", onMv); window.removeEventListener("mouseup", onUp); }; }, [drag, canvasRect, ratio, imgW, imgH, onChange]);
  const hS = (pos) => ({ position: "absolute", width: hSz, height: hSz, background: "#fff", border: "1px solid #68b5ff", cursor: pos === "tl" ? "nw-resize" : "se-resize", ...(pos === "tl" ? { left: -hSz / 2, top: -hSz / 2 } : { right: -hSz / 2, bottom: -hSz / 2 }) });
  return (<>
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: `${cy * 100}%`, background: "rgba(0,0,0,0.55)" }} />
      <div style={{ position: "absolute", top: `${(cy + ch) * 100}%`, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.55)" }} />
      <div style={{ position: "absolute", top: `${cy * 100}%`, left: 0, width: `${cx * 100}%`, height: `${ch * 100}%`, background: "rgba(0,0,0,0.55)" }} />
      <div style={{ position: "absolute", top: `${cy * 100}%`, left: `${(cx + cw) * 100}%`, right: 0, height: `${ch * 100}%`, background: "rgba(0,0,0,0.55)" }} />
    </div>
    <div onMouseDown={(e) => onMD(e, "move")} style={{ position: "absolute", left: `${cx * 100}%`, top: `${cy * 100}%`, width: `${cw * 100}%`, height: `${ch * 100}%`, border: "1px solid rgba(255,255,255,0.7)", cursor: "move", boxSizing: "border-box" }}>
      {thirds.map((t) => <div key={`h${t}`} style={{ position: "absolute", left: 0, right: 0, top: `${t * 100}%`, height: 1, background: "rgba(255,255,255,0.2)", pointerEvents: "none" }} />)}
      {thirds.map((t) => <div key={`v${t}`} style={{ position: "absolute", top: 0, bottom: 0, left: `${t * 100}%`, width: 1, background: "rgba(255,255,255,0.2)", pointerEvents: "none" }} />)}
      <div onMouseDown={(e) => onMD(e, "tl")} style={hS("tl")} /><div onMouseDown={(e) => onMD(e, "br")} style={hS("br")} />
    </div>
    <div style={{ position: "absolute", bottom: 8, left: "50%", transform: "translateX(-50%)", display: "flex", gap: 4, background: "rgba(0,0,0,0.8)", borderRadius: 6, padding: "4px 8px", alignItems: "center" }}>
      {CROP_RATIOS.map((r) => <button key={r.label} onClick={() => { setRatio(r.value); if (r.value) { const nH = cw / r.value * (imgW / imgH); onChange({ x: cx, y: cy, w: cw, h: clamp(nH, 0.05, 1) }); } }} style={{ border: "none", background: ratio === r.value ? "#68b5ff" : "#444", color: ratio === r.value ? "#111" : "#bbb", fontSize: 9, padding: "2px 6px", borderRadius: 3, cursor: "pointer" }}>{r.label}</button>)}
      <div style={{ width: 1, height: 14, background: "#555" }} />
      <button onClick={() => onRotate(-90)} style={{ border: "none", background: "#444", color: "#bbb", fontSize: 12, padding: "2px 6px", borderRadius: 3, cursor: "pointer" }}>↺</button>
      <button onClick={() => onRotate(90)} style={{ border: "none", background: "#444", color: "#bbb", fontSize: 12, padding: "2px 6px", borderRadius: 3, cursor: "pointer" }}>↻</button>
    </div>
  </>);
}

// ── Export Dialog ──
function ExportDialog({ photo, onExport, onClose, batchCount = 0 }) {
  const [fmt, setFmt] = useState("jpeg"); const [qual, setQual] = useState(92); const [rsz, setRsz] = useState("original");
  const [cW, setCW] = useState(photo?.width || 1920); const [cH, setCH] = useState(photo?.height || 1080); const [ka, setKa] = useState(true);
  const ar = photo ? photo.width / photo.height : 1;
  const sizes = [{ key: "original", label: "オリジナル", w: photo?.width, h: photo?.height }, { key: "4k", label: "4K", w: 3840, h: Math.round(3840 / ar) }, { key: "fhd", label: "Full HD", w: 1920, h: Math.round(1920 / ar) }, { key: "hd", label: "HD", w: 1280, h: Math.round(1280 / ar) }, { key: "web", label: "Web", w: 800, h: Math.round(800 / ar) }, { key: "custom", label: "カスタム" }];
  const getS = () => { if (rsz === "custom") return { w: cW, h: cH }; const o = sizes.find((s) => s.key === rsz); return { w: o?.w || photo?.width, h: o?.h || photo?.height }; };
  return (<div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={onClose}>
    <div onClick={(e) => e.stopPropagation()} style={{ background: "#2a2a2a", borderRadius: 12, padding: 24, width: 340, border: "1px solid #444" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: "#fff" }}>エクスポート{batchCount > 1 ? ` (${batchCount}枚)` : ""}</span>
        <button onClick={onClose} style={{ border: "none", background: "transparent", color: "#888", fontSize: 18, cursor: "pointer" }}>×</button>
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: "#aaa", marginBottom: 6 }}>フォーマット</div>
        <div style={{ display: "flex", gap: 4 }}>{["jpeg", "png", "webp"].map((f) => <button key={f} onClick={() => setFmt(f)} style={{ flex: 1, border: "1px solid #444", borderRadius: 4, padding: "6px 0", fontSize: 11, cursor: "pointer", background: fmt === f ? "#68b5ff" : "#333", color: fmt === f ? "#111" : "#bbb", fontWeight: fmt === f ? 600 : 400 }}>{f.toUpperCase()}</button>)}</div>
      </div>
      {fmt !== "png" && <div style={{ marginBottom: 12 }}><div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#aaa", marginBottom: 4 }}><span>品質</span><span style={{ color: "#68b5ff" }}>{qual}%</span></div><input type="range" min={10} max={100} value={qual} onChange={(e) => setQual(parseInt(e.target.value))} style={{ width: "100%", accentColor: "#68b5ff" }} /></div>}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: "#aaa", marginBottom: 6 }}>サイズ</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>{sizes.map((s) => <button key={s.key} onClick={() => setRsz(s.key)} style={{ border: "1px solid #444", borderRadius: 4, padding: "4px 8px", fontSize: 10, cursor: "pointer", background: rsz === s.key ? "#68b5ff" : "#333", color: rsz === s.key ? "#111" : "#bbb" }}>{s.label}{s.w && s.key !== "custom" ? ` ${s.w}` : ""}</button>)}</div>
        {rsz === "custom" && <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center" }}><input type="number" value={cW} onChange={(e) => { const w = parseInt(e.target.value) || 1; setCW(w); if (ka) setCH(Math.round(w / ar)); }} style={{ width: 70, background: "#333", border: "1px solid #555", borderRadius: 4, padding: "3px 5px", color: "#ccc", fontSize: 11 }} /><span style={{ color: "#666" }}>×</span><input type="number" value={cH} onChange={(e) => { const h = parseInt(e.target.value) || 1; setCH(h); if (ka) setCW(Math.round(h * ar)); }} style={{ width: 70, background: "#333", border: "1px solid #555", borderRadius: 4, padding: "3px 5px", color: "#ccc", fontSize: 11 }} /></div>}
      </div>
      <button onClick={() => { const s = getS(); onExport({ format: fmt, quality: qual / 100, width: s.w, height: s.h }); }} style={{ width: "100%", border: "none", borderRadius: 6, padding: "10px 0", fontSize: 13, background: "#68b5ff", color: "#111", fontWeight: 600, cursor: "pointer" }}>エクスポート</button>
    </div>
  </div>);
}

// ── Collection Dialog ──
function CollectionDialog({ collections, onAdd, onClose }) {
  const [name, setName] = useState("");
  return (<div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={onClose}>
    <div onClick={(e) => e.stopPropagation()} style={{ background: "#2a2a2a", borderRadius: 12, padding: 20, width: 280, border: "1px solid #444" }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "#fff", marginBottom: 12 }}>新しいコレクション</div>
      <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="コレクション名" autoFocus onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) { onAdd(name.trim()); setName(""); } }}
        style={{ width: "100%", background: "#333", border: "1px solid #555", borderRadius: 4, padding: "6px 8px", color: "#ccc", fontSize: 12, outline: "none", marginBottom: 10, boxSizing: "border-box" }} />
      <div style={{ display: "flex", gap: 6 }}>
        <button onClick={onClose} style={{ flex: 1, border: "1px solid #555", borderRadius: 4, padding: "6px 0", fontSize: 11, cursor: "pointer", background: "#333", color: "#aaa" }}>キャンセル</button>
        <button onClick={() => { if (name.trim()) { onAdd(name.trim()); setName(""); } }} style={{ flex: 1, border: "none", borderRadius: 4, padding: "6px 0", fontSize: 11, cursor: "pointer", background: "#68b5ff", color: "#111", fontWeight: 600 }}>作成</button>
      </div>
    </div>
  </div>);
}

// ═══ Main App ═══
export default function PhotoStudio() {
  const [photos, setPhotos] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState("library"); // library | develop
  const [showBefore, setShowBefore] = useState(false);
  const [compareMode, setCompareMode] = useState("toggle"); // toggle | side
  const [histData, setHistData] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [filterRating, setFilterRating] = useState(0);
  const [filterFlag, setFilterFlag] = useState("all");
  const [filterColor, setFilterColor] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState("imported");
  const [curveChannel, setCurveChannel] = useState("master");
  const [presets, setPresets] = useState([]);
  const [clipboardAdj, setClipboardAdj] = useState(null);
  const [multiSelect, setMultiSelect] = useState(new Set());
  const [toast, setToast] = useState(null);
  const [cropMode, setCropMode] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [batchExport, setBatchExport] = useState(false);
  const [collections, setCollections] = useState([]);
  const [activeCollection, setActiveCollection] = useState(null); // null = all
  const [showCollectionDialog, setShowCollectionDialog] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dbLoaded, setDbLoaded] = useState(false);
  const [importProgress, setImportProgress] = useState(null); // { current, total, file }
  const importCancelRef = useRef(false);

  const canvasRef = useRef(null);
  const beforeCanvasRef = useRef(null);
  const imgCache = useRef({});
  const fileInputRef = useRef(null);
  const history = useHistory();
  const saveTimer = useRef(null);

  const selected = useMemo(() => photos.find((p) => p.id === selectedId), [photos, selectedId]);
  const showToast = useCallback((msg) => { setToast(msg); setTimeout(() => setToast(null), 2000); }, []);

  // ── IndexedDB Load ──
  useEffect(() => {
    (async () => {
      try {
        const [savedPhotos, savedPresets, savedCollections] = await Promise.all([
          dbGetAll("photos"), dbGetAll("presets"), dbGetAll("collections"),
        ]);
        if (savedPhotos.length > 0) {
          setPhotos(savedPhotos);
          showToast(`${savedPhotos.length} 枚のカタログを復元`);
        }
        if (savedPresets.length > 0) setPresets(savedPresets);
        if (savedCollections.length > 0) setCollections(savedCollections);
      } catch (e) { console.warn("DB load failed", e); }
      setDbLoaded(true);
    })();
  }, []);

  // ── Auto-save to IndexedDB ──
  const savePhotos = useCallback((updatedPhotos) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try { await dbPutAll("photos", updatedPhotos); } catch (e) { console.warn("Save failed", e); }
    }, 1000);
  }, []);

  const savePresets = useCallback(async (p) => {
    try { await dbClear("presets"); await dbPutAll("presets", p); } catch (e) { console.warn(e); }
  }, []);

  const saveCollections = useCallback(async (c) => {
    try { await dbClear("collections"); await dbPutAll("collections", c); } catch (e) { console.warn(e); }
  }, []);

  const loadImage = useCallback((photo) => new Promise((resolve) => {
    if (imgCache.current[photo.id]) return resolve(imgCache.current[photo.id]);
    const img = new Image(); img.onload = () => { imgCache.current[photo.id] = img; resolve(img); }; img.src = photo.dataUrl;
  }), []);

  const renderToCanvas = useCallback(async (canvas, photo, useOriginal = false) => {
    if (!photo || !canvas) return;
    const img = await loadImage(photo);
    const maxW = canvas.parentElement?.clientWidth || 800;
    const maxH = canvas.parentElement?.clientHeight || 600;
    const rot = photo.adjustments.rotation || 0;
    const is90 = rot === 90 || rot === -90 || rot === 270;
    const srcW = is90 ? img.height : img.width, srcH = is90 ? img.width : img.height;
    const scale = Math.min(maxW / srcW, maxH / srcH, 1);
    const w = Math.round(srcW * scale), h = Math.round(srcH * scale);
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (rot !== 0) {
      ctx.save(); ctx.translate(w / 2, h / 2); ctx.rotate((rot * Math.PI) / 180);
      const dw = is90 ? h : w, dh = is90 ? w : h;
      ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh); ctx.restore();
      if (!useOriginal) { const tc = document.createElement("canvas"); tc.width = w; tc.height = h; tc.getContext("2d").drawImage(canvas, 0, 0); const ti = new Image(); await new Promise((r) => { ti.onload = r; ti.src = tc.toDataURL(); }); applyAdjustments(ctx, ti, photo.adjustments, w, h); }
    } else {
      if (useOriginal) { ctx.clearRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h); }
      else applyAdjustments(ctx, img, photo.adjustments, w, h);
    }
    return { w, h, ctx };
  }, [loadImage]);

  const renderPreview = useCallback(async (photo, useOriginal = false) => {
    const result = await renderToCanvas(canvasRef.current, photo, useOriginal);
    if (result) setHistData(computeHistogram(result.ctx, result.w, result.h));
    // Side-by-side before
    if (compareMode === "side" && !useOriginal && beforeCanvasRef.current) {
      await renderToCanvas(beforeCanvasRef.current, photo, true);
    }
  }, [renderToCanvas, compareMode]);

  useEffect(() => {
    if (mode === "develop" && selected) {
      setZoom(1); setPan({ x: 0, y: 0 });
      renderPreview(selected, showBefore && compareMode === "toggle");
    }
  }, [mode, selected, showBefore, compareMode, renderPreview]);

  // Import single file helper (HEIC aware)
  const processImageFile = useCallback(async (file) => {
    let processedFile = file;
    // HEIC conversion
    if (HEIC_EXTS.test(file.name)) {
      const converted = await convertHEICtoJPEG(file);
      if (!converted) return null; // conversion failed
      processedFile = converted;
    }
    // Check if browser can decode
    if (!processedFile.type.startsWith("image/") && !IMAGE_EXTS.test(processedFile.name)) return null;

    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const tc = document.createElement("canvas");
          const s = Math.min(300 / img.width, 300 / img.height);
          tc.width = Math.round(img.width * s); tc.height = Math.round(img.height * s);
          tc.getContext("2d").drawImage(img, 0, 0, tc.width, tc.height);
          resolve({
            id: uid(), name: file.name, size: file.size, width: img.width, height: img.height,
            dataUrl: e.target.result, thumbUrl: tc.toDataURL("image/jpeg", 0.7),
            rating: 0, flag: "none", colorLabel: "none", tags: [],
            collectionIds: activeCollection ? [activeCollection] : [],
            adjustments: deepClone(DEFAULT_ADJ), importedAt: Date.now(),
          });
        };
        img.onerror = () => resolve(null);
        img.src = e.target.result;
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(processedFile);
    });
  }, [activeCollection]);

  // Import from file list (drag & drop or file picker)
  const importFiles = useCallback(async (files) => {
    const allFiles = Array.from(files).filter((f) => f.type.startsWith("image/") || HEIC_EXTS.test(f.name) || IMAGE_EXTS.test(f.name));
    if (!allFiles.length) return;

    importCancelRef.current = false;
    setImportProgress({ current: 0, total: allFiles.length, file: "" });

    const newPhotos = [];
    for (let i = 0; i < allFiles.length; i++) {
      if (importCancelRef.current) break;
      setImportProgress({ current: i, total: allFiles.length, file: allFiles[i].name });
      const photo = await processImageFile(allFiles[i]);
      if (photo) newPhotos.push(photo);
      // Add in batches of 20 to show progress in UI
      if (newPhotos.length > 0 && (newPhotos.length % 20 === 0 || i === allFiles.length - 1)) {
        const batch = newPhotos.splice(0, newPhotos.length);
        setPhotos((prev) => {
          const u = [...prev, ...batch];
          if (!selectedId && u.length > 0) setSelectedId(u[0].id);
          savePhotos(u);
          return u;
        });
      }
    }
    setImportProgress(null);
    showToast(`${allFiles.length} 枚インポート完了`);
  }, [selectedId, showToast, savePhotos, processImageFile]);

  // Folder import via File System Access API
  const importFolder = useCallback(async () => {
    if (!window.showDirectoryPicker) {
      showToast("このブラウザではフォルダ選択がサポートされていません。Chrome/Edgeをお使いください。");
      return;
    }
    try {
      const dirHandle = await window.showDirectoryPicker({ mode: "read" });

      // Phase 1: Scan for all image files
      importCancelRef.current = false;
      setImportProgress({ current: 0, total: 0, file: "フォルダをスキャン中..." });

      const fileEntries = [];
      for await (const entry of scanDirectory(dirHandle)) {
        if (importCancelRef.current) break;
        fileEntries.push(entry);
        setImportProgress({ current: 0, total: fileEntries.length, file: `スキャン中... ${entry.path}` });
      }

      if (importCancelRef.current || fileEntries.length === 0) {
        setImportProgress(null);
        if (fileEntries.length === 0) showToast("画像ファイルが見つかりませんでした");
        return;
      }

      // Phase 2: Process files with progress
      const total = fileEntries.length;
      setImportProgress({ current: 0, total, file: "" });

      const batch = [];
      for (let i = 0; i < total; i++) {
        if (importCancelRef.current) break;
        const { file, path } = fileEntries[i];
        setImportProgress({ current: i + 1, total, file: path });

        const photo = await processImageFile(file);
        if (photo) {
          photo.folderPath = path;
          batch.push(photo);
        }

        // Commit in batches of 30
        if (batch.length >= 30 || i === total - 1) {
          const toAdd = batch.splice(0, batch.length);
          setPhotos((prev) => {
            const u = [...prev, ...toAdd];
            if (!selectedId && u.length > 0) setSelectedId(u[0].id);
            savePhotos(u);
            return u;
          });
          // Yield to UI
          await new Promise((r) => setTimeout(r, 10));
        }
      }

      setImportProgress(null);
      showToast(`${dirHandle.name} から ${total} 枚スキャン完了`);
    } catch (e) {
      setImportProgress(null);
      if (e.name !== "AbortError") {
        console.error("Folder import error:", e);
        showToast("フォルダの読み込みに失敗しました");
      }
    }
  }, [selectedId, showToast, savePhotos, processImageFile]);

  const updatePhoto = useCallback((id, updates) => {
    setPhotos((prev) => { const u = prev.map((p) => (p.id === id ? { ...p, ...updates } : p)); savePhotos(u); return u; });
  }, [savePhotos]);

  // Delete photos
  const deletePhotos = useCallback((ids) => {
    const idSet = new Set(ids);
    setPhotos((prev) => {
      const u = prev.filter((p) => !idSet.has(p.id));
      ids.forEach((id) => { delete imgCache.current[id]; dbDelete("photos", id).catch(() => {}); });
      savePhotos(u);
      return u;
    });
    if (ids.includes(selectedId)) setSelectedId(null);
    setMultiSelect(new Set());
    showToast(`${ids.length} 枚削除`);
  }, [selectedId, savePhotos, showToast]);

  const adjDebounce = useRef(null);
  const updateAdj = useCallback((key, value) => {
    if (!selected) return;
    const newAdj = deepClone(selected.adjustments);
    if (typeof key === "string") newAdj[key] = value; else Object.assign(newAdj, key);
    updatePhoto(selected.id, { adjustments: newAdj });
    if (canvasRef.current) {
      loadImage(selected).then((img) => {
        const c = canvasRef.current; if (!c) return;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        applyAdjustments(ctx, img, newAdj, c.width, c.height);
        setHistData(computeHistogram(ctx, c.width, c.height));
      });
    }
    clearTimeout(adjDebounce.current);
    adjDebounce.current = setTimeout(() => { history.push({ photoId: selected.id, adjustments: newAdj }); }, 400);
  }, [selected, updatePhoto, loadImage, history]);

  const resetAdj = useCallback(() => { if (!selected) return; const f = deepClone(DEFAULT_ADJ); updatePhoto(selected.id, { adjustments: f }); history.push({ photoId: selected.id, adjustments: f }); renderPreview({ ...selected, adjustments: f }); }, [selected, updatePhoto, renderPreview, history]);
  const doUndo = useCallback(() => { const s = history.undo(); if (s?.photoId === selectedId) { updatePhoto(s.photoId, { adjustments: s.adjustments }); renderPreview({ ...selected, adjustments: s.adjustments }); showToast("元に戻す"); } }, [history, selectedId, selected, updatePhoto, renderPreview, showToast]);
  const doRedo = useCallback(() => { const s = history.redo(); if (s?.photoId === selectedId) { updatePhoto(s.photoId, { adjustments: s.adjustments }); renderPreview({ ...selected, adjustments: s.adjustments }); showToast("やり直し"); } }, [history, selectedId, selected, updatePhoto, renderPreview, showToast]);
  const copyAdj = useCallback(() => { if (!selected) return; setClipboardAdj(deepClone(selected.adjustments)); showToast("設定コピー"); }, [selected, showToast]);
  const pasteAdj = useCallback(() => { if (!clipboardAdj) return; if (multiSelect.size > 0) { setPhotos((prev) => { const u = prev.map((p) => multiSelect.has(p.id) ? { ...p, adjustments: deepClone(clipboardAdj) } : p); savePhotos(u); return u; }); showToast(`${multiSelect.size} 枚にペースト`); } else if (selected) { updatePhoto(selected.id, { adjustments: deepClone(clipboardAdj) }); renderPreview({ ...selected, adjustments: deepClone(clipboardAdj) }); showToast("設定ペースト"); } }, [clipboardAdj, selected, multiSelect, updatePhoto, renderPreview, showToast, savePhotos]);

  // Presets
  const savePreset = useCallback(() => { if (!selected) return; const name = prompt("プリセット名:"); if (!name) return; const np = [...presets, { id: uid(), name, adjustments: deepClone(selected.adjustments) }]; setPresets(np); savePresets(np); showToast(`「${name}」保存`); }, [selected, presets, savePresets, showToast]);
  const applyPreset = useCallback((p) => { if (!selected) return; const a = deepClone(p.adjustments); updatePhoto(selected.id, { adjustments: a }); history.push({ photoId: selected.id, adjustments: a }); renderPreview({ ...selected, adjustments: a }); showToast(`「${p.name}」適用`); }, [selected, updatePhoto, renderPreview, history, showToast]);

  // Export
  const exportPhoto = useCallback(async (opts = {}) => {
    const targets = batchExport && multiSelect.size > 0 ? photos.filter((p) => multiSelect.has(p.id)) : selected ? [selected] : [];
    for (const photo of targets) {
      const img = await loadImage(photo); const adj = photo.adjustments;
      const rot = adj.rotation || 0; const is90 = rot === 90 || rot === -90 || rot === 270;
      let srcW = is90 ? img.height : img.width, srcH = is90 ? img.width : img.height;
      const crop = adj.crop; let cX = 0, cY = 0, cW = srcW, cH = srcH;
      if (crop) { cX = Math.round(crop.x * srcW); cY = Math.round(crop.y * srcH); cW = Math.round(crop.w * srcW); cH = Math.round(crop.h * srcH); }
      const tW = opts.width || cW, tH = opts.height || cH;
      const fc = document.createElement("canvas"); fc.width = srcW; fc.height = srcH;
      const fctx = fc.getContext("2d", { willReadFrequently: true });
      if (rot !== 0) { fctx.save(); fctx.translate(srcW / 2, srcH / 2); fctx.rotate((rot * Math.PI) / 180); const dw = is90 ? srcH : srcW, dh = is90 ? srcW : srcH; fctx.drawImage(img, -dw / 2, -dh / 2, dw, dh); fctx.restore(); const ti = new Image(); await new Promise((r) => { ti.onload = r; ti.src = fc.toDataURL(); }); applyAdjustments(fctx, ti, adj, srcW, srcH); } else applyAdjustments(fctx, img, adj, srcW, srcH);
      const cc = document.createElement("canvas"); cc.width = tW; cc.height = tH;
      cc.getContext("2d").drawImage(fc, cX, cY, cW, cH, 0, 0, tW, tH);
      const fmt = opts.format || "jpeg"; const ext = fmt === "png" ? ".png" : fmt === "webp" ? ".webp" : ".jpg";
      const mime = fmt === "png" ? "image/png" : fmt === "webp" ? "image/webp" : "image/jpeg";
      await new Promise((res) => { cc.toBlob((blob) => { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${photo.name.replace(/\.[^.]+$/, "")}_edited${ext}`; a.click(); URL.revokeObjectURL(a.href); res(); }, mime, fmt === "png" ? undefined : opts.quality || 0.92); });
    }
    showToast(`${targets.length} 枚エクスポート`);
    setShowExportDialog(false); setBatchExport(false);
  }, [selected, photos, multiSelect, batchExport, loadImage, showToast]);

  // Collections
  const addCollection = useCallback((name) => {
    const nc = [...collections, { id: uid(), name, createdAt: Date.now() }];
    setCollections(nc); saveCollections(nc); setShowCollectionDialog(false); showToast(`「${name}」作成`);
  }, [collections, saveCollections, showToast]);

  const deleteCollection = useCallback((id) => {
    const nc = collections.filter((c) => c.id !== id);
    setCollections(nc); saveCollections(nc);
    if (activeCollection === id) setActiveCollection(null);
  }, [collections, activeCollection, saveCollections]);

  const addToCollection = useCallback((collId) => {
    const ids = multiSelect.size > 0 ? [...multiSelect] : selected ? [selected.id] : [];
    setPhotos((prev) => {
      const u = prev.map((p) => ids.includes(p.id) ? { ...p, collectionIds: [...new Set([...(p.collectionIds || []), collId])] } : p);
      savePhotos(u); return u;
    });
    showToast(`${ids.length} 枚をコレクションに追加`);
  }, [multiSelect, selected, savePhotos, showToast]);

  // Filtered + sorted
  const filteredPhotos = useMemo(() => {
    let list = photos.filter((p) => {
      if (filterRating > 0 && p.rating < filterRating) return false;
      if (filterFlag !== "all" && p.flag !== filterFlag) return false;
      if (filterColor !== "all" && (p.colorLabel || "none") !== filterColor) return false;
      if (searchQuery && !p.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      if (activeCollection && !(p.collectionIds || []).includes(activeCollection)) return false;
      return true;
    });
    if (sortBy === "name") list.sort((a, b) => a.name.localeCompare(b.name));
    else if (sortBy === "rating") list.sort((a, b) => b.rating - a.rating);
    else list.sort((a, b) => a.importedAt - b.importedAt);
    return list;
  }, [photos, filterRating, filterFlag, filterColor, searchQuery, sortBy, activeCollection]);

  const toggleMultiSelect = useCallback((id, e) => {
    if (e.shiftKey || e.ctrlKey || e.metaKey) { setMultiSelect((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; }); }
    else { setMultiSelect(new Set()); setSelectedId(id); }
  }, []);

  useEffect(() => { if (selected && mode === "develop") history.push({ photoId: selected.id, adjustments: deepClone(selected.adjustments) }); }, [selectedId, mode]);

  // Zoom with wheel
  const onWheel = useCallback((e) => {
    if (mode !== "develop" || !e.ctrlKey) return;
    e.preventDefault();
    setZoom((z) => clamp(z + (e.deltaY > 0 ? -0.15 : 0.15), 0.25, 5));
  }, [mode]);

  // Pan with drag
  const panRef = useRef(null);
  const onPanStart = useCallback((e) => {
    if (zoom <= 1 || cropMode) return;
    panRef.current = { startX: e.clientX - pan.x, startY: e.clientY - pan.y };
    const onMove = (ev) => { if (panRef.current) setPan({ x: ev.clientX - panRef.current.startX, y: ev.clientY - panRef.current.startY }); };
    const onUp = () => { panRef.current = null; window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
  }, [zoom, pan, cropMode]);

  // Keyboard
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === "INPUT") return;
      if (e.key === "\\") { setShowBefore((v) => !v); e.preventDefault(); }
      if (e.key === "Escape") { if (mode === "develop") setMode("library"); if (cropMode) setCropMode(false); }
      if (e.key === "r" && !e.metaKey && !e.ctrlKey && mode === "develop") resetAdj();
      if (e.key >= "0" && e.key <= "5" && selected && !e.metaKey) updatePhoto(selected.id, { rating: parseInt(e.key) });
      if (e.key === "p" && !e.metaKey && !e.ctrlKey && selected) updatePhoto(selected.id, { flag: selected.flag === "pick" ? "none" : "pick" });
      if (e.key === "x" && !e.metaKey && !e.ctrlKey && selected) updatePhoto(selected.id, { flag: selected.flag === "reject" ? "none" : "reject" });
      if (e.key === "ArrowRight" && selected) { const idx = filteredPhotos.findIndex((p) => p.id === selected.id); if (idx < filteredPhotos.length - 1) setSelectedId(filteredPhotos[idx + 1].id); }
      if (e.key === "ArrowLeft" && selected) { const idx = filteredPhotos.findIndex((p) => p.id === selected.id); if (idx > 0) setSelectedId(filteredPhotos[idx - 1].id); }
      if (e.key === "Enter" && mode === "library" && selected) setMode("develop");
      if (e.key === "Delete" || e.key === "Backspace") { if (multiSelect.size > 0) deletePhotos([...multiSelect]); else if (selected && mode === "library") deletePhotos([selected.id]); }
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) { doUndo(); e.preventDefault(); }
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && e.shiftKey) { doRedo(); e.preventDefault(); }
      if ((e.metaKey || e.ctrlKey) && e.key === "y") { doRedo(); e.preventDefault(); }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "c" || e.key === "C")) { copyAdj(); e.preventDefault(); }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "v" || e.key === "V")) { pasteAdj(); e.preventDefault(); }
      if (e.key === "+" || e.key === "=") setZoom((z) => clamp(z + 0.25, 0.25, 5));
      if (e.key === "-") setZoom((z) => clamp(z - 0.25, 0.25, 5));
      if (e.key === "f" && mode === "develop") { setZoom(1); setPan({ x: 0, y: 0 }); }
    };
    window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler);
  }, [mode, selected, filteredPhotos, resetAdj, updatePhoto, doUndo, doRedo, copyAdj, pasteAdj, deletePhotos, cropMode]);

  const onDrop = useCallback((e) => { e.preventDefault(); setDragOver(false); importFiles(e.dataTransfer.files); }, [importFiles]);
  const adj = selected?.adjustments || deepClone(DEFAULT_ADJ);
  const C = { bg: "#1a1a1a", panel: "#222", panelBorder: "#2d2d2d", toolbar: "#181818", accent: "#68b5ff", text: "#ccc", textDim: "#777", pick: "#4ade80", reject: "#f87171" };
  const curveKey = { master: "toneCurve", red: "toneCurveR", green: "toneCurveG", blue: "toneCurveB" }[curveChannel];
  const curveColor = { master: "#ccc", red: "#ff6b6b", green: "#69db7c", blue: "#74c0fc" }[curveChannel];

  return (
    <div style={{ width: "100%", height: "100vh", background: C.bg, color: C.text, fontFamily: "'SF Pro Display', -apple-system, 'Segoe UI', sans-serif", fontSize: 13, display: "flex", flexDirection: "column", overflow: "hidden", userSelect: "none" }}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>

      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", height: 42, padding: "0 12px", background: C.toolbar, borderBottom: `1px solid ${C.panelBorder}`, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: -0.5, color: "#fff" }}><span style={{ color: C.accent }}>◉</span> Photo Studio</span>
          <div style={{ width: 1, height: 20, background: "#333" }} />
          <input type="file" ref={fileInputRef} multiple accept="image/*,.heic,.heif" style={{ display: "none" }} onChange={(e) => importFiles(e.target.files)} />
          <button onClick={() => fileInputRef.current?.click()} style={btn(C)}>+ インポート</button>
          <button onClick={importFolder} style={{ ...btn(C), fontSize: 11 }}>📁 フォルダ</button>
        </div>
        <div style={{ display: "flex", gap: 2 }}>
          {["library", "develop"].map((m) => <button key={m} onClick={() => setMode(m)} style={{ ...btn(C), background: mode === m ? C.accent : "transparent", color: mode === m ? "#111" : C.textDim, fontWeight: mode === m ? 600 : 400 }}>{m === "library" ? "ライブラリ" : "現像"}</button>)}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {mode === "develop" && selected && (<>
            <button onClick={doUndo} style={{ ...btn(C), fontSize: 14, opacity: history.canUndo() ? 1 : 0.3 }}>↩</button>
            <button onClick={doRedo} style={{ ...btn(C), fontSize: 14, opacity: history.canRedo() ? 1 : 0.3 }}>↪</button>
            <div style={{ width: 1, height: 16, background: "#333" }} />
            <button onClick={() => setShowBefore((v) => !v)} style={{ ...btn(C), background: showBefore ? "#555" : "transparent", fontSize: 11 }}>{showBefore ? "BEFORE" : "B/A"}</button>
            <button onClick={() => setCompareMode((m) => m === "toggle" ? "side" : "toggle")} style={{ ...btn(C), fontSize: 11, background: compareMode === "side" ? "#555" : "transparent" }}>左右比較</button>
            <button onClick={copyAdj} style={{ ...btn(C), fontSize: 11 }}>コピー</button>
            <button onClick={pasteAdj} style={{ ...btn(C), fontSize: 11, opacity: clipboardAdj ? 1 : 0.3 }}>ペースト</button>
            <button onClick={() => setCropMode(!cropMode)} style={{ ...btn(C), fontSize: 11, background: cropMode ? "#f59e0b" : "transparent", color: cropMode ? "#111" : C.text }}>{cropMode ? "✓ 切抜" : "切抜"}</button>
            <button onClick={() => setShowExportDialog(true)} style={{ ...btn(C), background: C.accent, color: "#111", fontWeight: 600 }}>エクスポート</button>
          </>)}
          {mode === "library" && multiSelect.size > 0 && (<>
            <span style={{ fontSize: 10, color: C.accent }}>{multiSelect.size} 枚選択</span>
            <button onClick={pasteAdj} style={{ ...btn(C), fontSize: 11, opacity: clipboardAdj ? 1 : 0.3 }}>一括ペースト</button>
            <button onClick={() => { setBatchExport(true); setShowExportDialog(true); }} style={{ ...btn(C), fontSize: 11 }}>一括エクスポート</button>
            <button onClick={() => { if (confirm(`${multiSelect.size} 枚を削除しますか？`)) deletePhotos([...multiSelect]); }} style={{ ...btn(C), fontSize: 11, color: C.reject }}>削除</button>
            <button onClick={() => setMultiSelect(new Set())} style={{ ...btn(C), fontSize: 11 }}>解除</button>
          </>)}
          {mode === "develop" && zoom !== 1 && <span style={{ fontSize: 10, color: C.accent }}>{Math.round(zoom * 100)}%</span>}
          <span style={{ fontSize: 10, color: C.textDim }}>{filteredPhotos.length}/{photos.length} 枚</span>
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Left sidebar */}
        {mode === "library" && (
          <div style={{ width: 200, background: C.panel, borderRight: `1px solid ${C.panelBorder}`, padding: 12, flexShrink: 0, overflowY: "auto" }}>
            <Section title="コレクション">
              <button onClick={() => setActiveCollection(null)} style={{ ...btn(C), fontSize: 10, padding: "2px 6px", width: "100%", textAlign: "left", background: !activeCollection ? "rgba(104,181,255,0.15)" : "transparent", marginBottom: 2 }}>
                📷 すべての写真 ({photos.length})
              </button>
              {collections.map((c) => {
                const count = photos.filter((p) => (p.collectionIds || []).includes(c.id)).length;
                return (<div key={c.id} style={{ display: "flex", alignItems: "center", gap: 2 }}>
                  <button onClick={() => setActiveCollection(activeCollection === c.id ? null : c.id)} style={{ ...btn(C), fontSize: 10, padding: "2px 6px", flex: 1, textAlign: "left", background: activeCollection === c.id ? "rgba(104,181,255,0.15)" : "transparent" }}>
                    📁 {c.name} ({count})
                  </button>
                  <button onClick={() => deleteCollection(c.id)} style={{ border: "none", background: "transparent", color: "#555", fontSize: 10, cursor: "pointer" }}>×</button>
                </div>);
              })}
              <button onClick={() => setShowCollectionDialog(true)} style={{ border: "1px dashed #444", background: "transparent", color: "#666", fontSize: 10, padding: "3px 6px", borderRadius: 3, cursor: "pointer", width: "100%", marginTop: 4 }}>+ 新規</button>
              {(multiSelect.size > 0 || selected) && collections.length > 0 && (
                <div style={{ marginTop: 6, fontSize: 10, color: C.textDim }}>
                  <div style={{ marginBottom: 3 }}>追加先:</div>
                  {collections.map((c) => <button key={c.id} onClick={() => addToCollection(c.id)} style={{ ...btn(C), fontSize: 9, padding: "1px 5px", background: "#2a2a2a", border: "1px solid #3a3a3a", marginBottom: 2, display: "block", width: "100%", textAlign: "left" }}>{c.name}</button>)}
                </div>
              )}
            </Section>
            <Section title="検索">
              <input type="text" placeholder="ファイル名..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} style={{ width: "100%", background: "#2a2a2a", border: "1px solid #3a3a3a", borderRadius: 4, padding: "5px 8px", color: "#ccc", fontSize: 11, outline: "none", boxSizing: "border-box" }} />
            </Section>
            <Section title="ソート">
              <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                {[{ key: "imported", label: "取込順" }, { key: "name", label: "名前" }, { key: "rating", label: "★順" }].map((s) => <button key={s.key} onClick={() => setSortBy(s.key)} style={{ ...btn(C), padding: "2px 7px", fontSize: 10, background: sortBy === s.key ? C.accent : "#333", color: sortBy === s.key ? "#111" : C.textDim }}>{s.label}</button>)}
              </div>
            </Section>
            <Section title="フィルター">
              <div style={{ fontSize: 11, color: C.textDim, marginBottom: 4 }}>レーティング</div>
              <div style={{ display: "flex", gap: 3, marginBottom: 8, flexWrap: "wrap" }}>
                {[0, 1, 2, 3, 4, 5].map((r) => <button key={r} onClick={() => setFilterRating(r)} style={{ ...btn(C), padding: "2px 6px", fontSize: 10, background: filterRating === r ? C.accent : "#333", color: filterRating === r ? "#111" : C.textDim }}>{r === 0 ? "全て" : `${r}★+`}</button>)}
              </div>
              <div style={{ fontSize: 11, color: C.textDim, marginBottom: 4 }}>フラグ</div>
              <div style={{ display: "flex", gap: 3, marginBottom: 8 }}>
                {[{ key: "all", label: "全て" }, { key: "pick", label: "採用" }, { key: "reject", label: "不採用" }].map((f) => <button key={f.key} onClick={() => setFilterFlag(f.key)} style={{ ...btn(C), padding: "2px 7px", fontSize: 10, background: filterFlag === f.key ? C.accent : "#333", color: filterFlag === f.key ? "#111" : C.textDim }}>{f.label}</button>)}
              </div>
              <div style={{ fontSize: 11, color: C.textDim, marginBottom: 4 }}>カラーラベル</div>
              <div style={{ display: "flex", gap: 3 }}>
                <button onClick={() => setFilterColor("all")} style={{ ...btn(C), padding: "2px 6px", fontSize: 10, background: filterColor === "all" ? C.accent : "#333", color: filterColor === "all" ? "#111" : C.textDim }}>全て</button>
                {COLOR_LABELS.slice(1).map((cl) => <button key={cl.key} onClick={() => setFilterColor(cl.key)} style={{ width: 18, height: 18, borderRadius: "50%", border: filterColor === cl.key ? "2px solid #fff" : "2px solid transparent", background: cl.color, cursor: "pointer", padding: 0 }} />)}
              </div>
            </Section>
          </div>
        )}

        {/* Center */}
        <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          {mode === "library" ? (
            <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
              {filteredPhotos.length === 0 ? (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", color: C.textDim, gap: 12 }}>
                  <div style={{ fontSize: 48, opacity: 0.3 }}>📷</div>
                  <div style={{ fontSize: 15 }}>{photos.length === 0 ? "写真をドラッグ＆ドロップ" : "条件に一致する写真がありません"}</div>
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 8 }}>
                  {filteredPhotos.map((photo) => {
                    const isSel = photo.id === selectedId, isM = multiSelect.has(photo.id);
                    const edited = Object.keys(DEFAULT_ADJ).some((k) => JSON.stringify(photo.adjustments[k]) !== JSON.stringify(DEFAULT_ADJ[k]));
                    const cl = COLOR_LABELS.find((c) => c.key === (photo.colorLabel || "none"));
                    return (<div key={photo.id} onClick={(e) => toggleMultiSelect(photo.id, e)} onDoubleClick={() => { setSelectedId(photo.id); setMode("develop"); }}
                      style={{ position: "relative", borderRadius: 6, overflow: "hidden", cursor: "pointer", border: `2px solid ${isM ? "#f59e0b" : isSel ? C.accent : "transparent"}`, background: "#111" }}>
                      <img src={photo.thumbUrl} alt={photo.name} style={{ width: "100%", aspectRatio: "3/2", objectFit: "cover", display: "block" }} loading="lazy" />
                      {photo.flag !== "none" && <div style={{ position: "absolute", top: 6, left: 6, width: 10, height: 10, borderRadius: "50%", background: photo.flag === "pick" ? C.pick : C.reject }} />}
                      {cl && cl.key !== "none" && <div style={{ position: "absolute", top: 6, left: photo.flag !== "none" ? 22 : 6, width: 10, height: 10, borderRadius: "50%", background: cl.color }} />}
                      {isM && <div style={{ position: "absolute", top: 6, right: 6, width: 16, height: 16, borderRadius: "50%", background: "#f59e0b", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#111", fontWeight: 700 }}>✓</div>}
                      {edited && !isM && <div style={{ position: "absolute", top: 6, right: 6, fontSize: 9, background: "rgba(0,0,0,0.6)", color: C.accent, padding: "1px 5px", borderRadius: 3 }}>編集済</div>}
                      <div style={{ padding: "5px 6px", background: "rgba(0,0,0,0.7)" }}>
                        <div style={{ fontSize: 10, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginBottom: 2, color: "#bbb" }}>{photo.name}</div>
                        <StarRating value={photo.rating} onChange={(r) => updatePhoto(photo.id, { rating: r })} size={11} />
                      </div>
                    </div>);
                  })}
                </div>
              )}
            </div>
          ) : (
            <div style={{ flex: 1, display: "flex", background: "#111", position: "relative", overflow: "hidden" }} onWheel={onWheel}>
              {selected ? (
                compareMode === "side" && showBefore ? (
                  // Side-by-side
                  <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center", gap: 4 }}>
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center" }}>
                      <div style={{ fontSize: 10, color: "#666", marginBottom: 4 }}>BEFORE</div>
                      <canvas ref={beforeCanvasRef} style={{ maxWidth: "100%", maxHeight: "calc(100% - 24px)" }} />
                    </div>
                    <div style={{ width: 1, background: "#333", alignSelf: "stretch" }} />
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center" }}>
                      <div style={{ fontSize: 10, color: "#666", marginBottom: 4 }}>AFTER</div>
                      <canvas ref={canvasRef} style={{ maxWidth: "100%", maxHeight: "calc(100% - 24px)" }} />
                    </div>
                  </div>
                ) : (
                  <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <div style={{ position: "relative", display: "inline-block", transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`, transformOrigin: "center", cursor: zoom > 1 ? "grab" : "default" }} onMouseDown={onPanStart}>
                      <canvas ref={canvasRef} style={{ maxWidth: zoom <= 1 ? "100%" : "none", maxHeight: zoom <= 1 ? "100%" : "none", display: "block" }} />
                      {cropMode && <CropOverlay imgW={selected.width} imgH={selected.height} crop={adj.crop || { x: 0, y: 0, w: 1, h: 1 }} onChange={(c) => updateAdj("crop", c)} onRotate={(d) => updateAdj("rotation", ((adj.rotation || 0) + d + 360) % 360)} canvasRect={canvasRef.current?.getBoundingClientRect() || { left: 0, top: 0, width: 1, height: 1 }} />}
                      {showBefore && compareMode === "toggle" && <div style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", background: "rgba(0,0,0,0.7)", color: "#fff", fontSize: 11, padding: "3px 10px", borderRadius: 4, pointerEvents: "none" }}>BEFORE</div>}
                    </div>
                  </div>
                )
              ) : <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: C.textDim }}>写真を選択してください</div>}
            </div>
          )}

          {/* Filmstrip */}
          {mode === "develop" && photos.length > 1 && (
            <div style={{ height: 68, background: C.toolbar, borderTop: `1px solid ${C.panelBorder}`, display: "flex", alignItems: "center", padding: "0 8px", gap: 4, overflowX: "auto", flexShrink: 0 }}>
              {filteredPhotos.map((p) => <img key={p.id} src={p.thumbUrl} alt={p.name} onClick={() => setSelectedId(p.id)} style={{ height: 52, width: 76, objectFit: "cover", borderRadius: 3, cursor: "pointer", border: `2px solid ${p.id === selectedId ? C.accent : "transparent"}`, opacity: p.id === selectedId ? 1 : 0.6, flexShrink: 0 }} />)}
            </div>
          )}
        </div>

        {/* Right Panel - Develop */}
        {mode === "develop" && selected && (
          <div style={{ width: 270, background: C.panel, borderLeft: `1px solid ${C.panelBorder}`, overflowY: "auto", padding: "10px 14px", flexShrink: 0 }}>
            <Section title="ヒストグラム"><Histogram data={histData} /></Section>
            <Section title="情報" defaultOpen={false}><div style={{ fontSize: 10, color: C.textDim, lineHeight: 1.8 }}><div>{selected.name}</div><div>{selected.width} × {selected.height}</div><div>{(selected.size / 1024 / 1024).toFixed(1)} MB</div></div></Section>
            <Section title="評価">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <StarRating value={selected.rating} onChange={(r) => updatePhoto(selected.id, { rating: r })} />
                <div style={{ display: "flex", gap: 3 }}>
                  <button onClick={() => updatePhoto(selected.id, { flag: selected.flag === "pick" ? "none" : "pick" })} style={{ ...btn(C), padding: "2px 8px", fontSize: 10, background: selected.flag === "pick" ? C.pick : "#333", color: selected.flag === "pick" ? "#111" : C.textDim }}>採用</button>
                  <button onClick={() => updatePhoto(selected.id, { flag: selected.flag === "reject" ? "none" : "reject" })} style={{ ...btn(C), padding: "2px 8px", fontSize: 10, background: selected.flag === "reject" ? C.reject : "#333", color: selected.flag === "reject" ? "#111" : C.textDim }}>不採用</button>
                </div>
              </div>
              <div style={{ display: "flex", gap: 3, marginTop: 6 }}>
                {COLOR_LABELS.map((cl) => <button key={cl.key} onClick={() => updatePhoto(selected.id, { colorLabel: cl.key })} style={{ width: 18, height: 18, borderRadius: "50%", border: (selected.colorLabel || "none") === cl.key ? "2px solid #fff" : "1px solid #555", background: cl.key === "none" ? "#333" : cl.color, cursor: "pointer", padding: 0, fontSize: 8 }}>{cl.key === "none" ? "✕" : ""}</button>)}
              </div>
            </Section>
            <Section title="プリセット" defaultOpen={presets.length > 0}>
              <PresetBar presets={presets} onApply={applyPreset} onSave={savePreset} onDelete={(id) => { const np = presets.filter((p) => p.id !== id); setPresets(np); savePresets(np); }} />
            </Section>
            <Section title="ライト">
              <Slider label="露出" value={adj.exposure} min={-5} max={5} step={0.05} onChange={(v) => updateAdj("exposure", v)} />
              <Slider label="コントラスト" value={adj.contrast} min={-100} max={100} onChange={(v) => updateAdj("contrast", v)} />
              <Slider label="ハイライト" value={adj.highlights} min={-100} max={100} onChange={(v) => updateAdj("highlights", v)} />
              <Slider label="シャドウ" value={adj.shadows} min={-100} max={100} onChange={(v) => updateAdj("shadows", v)} />
              <Slider label="白レベル" value={adj.whites} min={-100} max={100} onChange={(v) => updateAdj("whites", v)} />
              <Slider label="黒レベル" value={adj.blacks} min={-100} max={100} onChange={(v) => updateAdj("blacks", v)} />
            </Section>
            <Section title="カラー">
              <Slider label="色温度" value={adj.temperature} min={-100} max={100} onChange={(v) => updateAdj("temperature", v)} />
              <Slider label="色被り" value={adj.tint} min={-100} max={100} onChange={(v) => updateAdj("tint", v)} />
              <Slider label="自然な彩度" value={adj.vibrance} min={-100} max={100} onChange={(v) => updateAdj("vibrance", v)} />
              <Slider label="彩度" value={adj.saturation} min={-100} max={100} onChange={(v) => updateAdj("saturation", v)} />
            </Section>
            <Section title="トーンカーブ">
              <div style={{ display: "flex", gap: 2, marginBottom: 6 }}>
                {[{ key: "master", label: "RGB", c: "#ccc" }, { key: "red", label: "R", c: "#ff6b6b" }, { key: "green", label: "G", c: "#69db7c" }, { key: "blue", label: "B", c: "#74c0fc" }].map((ch) => <button key={ch.key} onClick={() => setCurveChannel(ch.key)} style={{ flex: 1, border: "none", borderRadius: 3, padding: "3px 0", fontSize: 10, cursor: "pointer", background: curveChannel === ch.key ? ch.c : "#333", color: curveChannel === ch.key ? "#111" : "#888", fontWeight: curveChannel === ch.key ? 700 : 400 }}>{ch.label}</button>)}
              </div>
              <CurveEditor points={adj[curveKey] || DEFAULT_CURVE} color={curveColor} onChange={(pts) => updateAdj(curveKey, pts)} />
              <button onClick={() => updateAdj(curveKey, deepClone(DEFAULT_CURVE))} style={{ ...btn(C), fontSize: 10, color: "#666", marginTop: 4, padding: "2px 6px" }}>カーブリセット</button>
            </Section>
            <Section title="HSL / カラー"><HSLPanel hsl={adj.hsl || DEFAULT_HSL()} onChange={(v) => updateAdj("hsl", v)} /></Section>
            <Section title="効果">
              <Slider label="明瞭度" value={adj.clarity} min={-100} max={100} onChange={(v) => updateAdj("clarity", v)} />
              <Slider label="かすみの除去" value={adj.dehaze} min={-100} max={100} onChange={(v) => updateAdj("dehaze", v)} />
            </Section>
            <Section title="ビネット" defaultOpen={false}><Slider label="適用量" value={adj.vignette} min={-100} max={100} onChange={(v) => updateAdj("vignette", v)} /><Slider label="ぼかし" value={adj.vignetteFeather} min={0} max={100} onChange={(v) => updateAdj("vignetteFeather", v)} /></Section>
            <Section title="粒子" defaultOpen={false}><Slider label="適用量" value={adj.grain} min={0} max={100} onChange={(v) => updateAdj("grain", v)} /><Slider label="サイズ" value={adj.grainSize} min={0} max={100} onChange={(v) => updateAdj("grainSize", v)} /></Section>
            <Section title="スプリットトーニング" defaultOpen={false}>
              <div style={{ fontSize: 10, color: "#aaa", marginBottom: 4 }}>ハイライト</div><HuePicker value={adj.splitHighHue} saturation={adj.splitHighSat} onChange={(v) => updateAdj("splitHighHue", v)} /><Slider label="彩度" value={adj.splitHighSat} min={0} max={100} onChange={(v) => updateAdj("splitHighSat", v)} />
              <div style={{ fontSize: 10, color: "#aaa", marginBottom: 4, marginTop: 6 }}>シャドウ</div><HuePicker value={adj.splitShadHue} saturation={adj.splitShadSat} onChange={(v) => updateAdj("splitShadHue", v)} /><Slider label="彩度" value={adj.splitShadSat} min={0} max={100} onChange={(v) => updateAdj("splitShadSat", v)} />
              <Slider label="バランス" value={adj.splitBalance} min={-100} max={100} onChange={(v) => updateAdj("splitBalance", v)} />
            </Section>
            <Section title="変形" defaultOpen={false}>
              <Slider label="回転" value={adj.rotation || 0} min={-180} max={180} step={1} onChange={(v) => updateAdj("rotation", v)} />
              <div style={{ display: "flex", gap: 4, marginTop: 4 }}>{[0, 90, 180, 270].map((r) => <button key={r} onClick={() => updateAdj("rotation", r)} style={{ flex: 1, border: "1px solid #444", borderRadius: 3, padding: "3px 0", fontSize: 10, cursor: "pointer", background: (adj.rotation || 0) === r ? "#68b5ff" : "#333", color: (adj.rotation || 0) === r ? "#111" : "#888" }}>{r}°</button>)}</div>
            </Section>
            <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
              <button onClick={() => { if (!histData) return; let t = 0, s = 0; for (let i = 0; i < 256; i++) { t += histData.lum[i]; s += histData.lum[i] * i; } const avg = s / t / 255; const na = { ...deepClone(selected.adjustments), exposure: Math.round(clamp((0.45 - avg) * 3, -3, 3) * 100) / 100, contrast: 10, vibrance: 15, shadows: 20, highlights: -10 }; updatePhoto(selected.id, { adjustments: na }); history.push({ photoId: selected.id, adjustments: na }); renderPreview({ ...selected, adjustments: na }); }} style={{ ...btn(C), flex: 1, background: "#333", textAlign: "center", padding: "6px 0", fontSize: 11 }}>自動補正</button>
              <button onClick={resetAdj} style={{ ...btn(C), flex: 1, background: "#333", textAlign: "center", padding: "6px 0", fontSize: 11 }}>リセット</button>
            </div>
          </div>
        )}

        {/* Right sidebar - Library */}
        {mode === "library" && selected && (
          <div style={{ width: 220, background: C.panel, borderLeft: `1px solid ${C.panelBorder}`, padding: "10px 14px", flexShrink: 0, overflowY: "auto" }}>
            <img src={selected.thumbUrl} alt={selected.name} style={{ width: "100%", borderRadius: 4, objectFit: "cover", aspectRatio: "3/2", marginBottom: 10 }} />
            <Section title="情報"><div style={{ fontSize: 10, color: C.textDim, lineHeight: 2 }}><div style={{ color: "#ccc", fontWeight: 500 }}>{selected.name}</div><div>{selected.width} × {selected.height} px</div><div>{(selected.size / 1024 / 1024).toFixed(1)} MB</div></div></Section>
            <Section title="評価">
              <StarRating value={selected.rating} onChange={(r) => updatePhoto(selected.id, { rating: r })} />
              <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
                <button onClick={() => updatePhoto(selected.id, { flag: selected.flag === "pick" ? "none" : "pick" })} style={{ ...btn(C), padding: "2px 8px", fontSize: 10, background: selected.flag === "pick" ? C.pick : "#333", color: selected.flag === "pick" ? "#111" : C.textDim }}>採用</button>
                <button onClick={() => updatePhoto(selected.id, { flag: selected.flag === "reject" ? "none" : "reject" })} style={{ ...btn(C), padding: "2px 8px", fontSize: 10, background: selected.flag === "reject" ? C.reject : "#333", color: selected.flag === "reject" ? "#111" : C.textDim }}>不採用</button>
              </div>
              <div style={{ display: "flex", gap: 3, marginTop: 6 }}>
                {COLOR_LABELS.map((cl) => <button key={cl.key} onClick={() => updatePhoto(selected.id, { colorLabel: cl.key })} style={{ width: 16, height: 16, borderRadius: "50%", border: (selected.colorLabel || "none") === cl.key ? "2px solid #fff" : "1px solid #555", background: cl.key === "none" ? "#333" : cl.color, cursor: "pointer", padding: 0, fontSize: 7 }}>{cl.key === "none" ? "✕" : ""}</button>)}
              </div>
            </Section>
            <button onClick={() => { if (confirm("この写真を削除しますか？")) deletePhotos([selected.id]); }}
              style={{ width: "100%", border: "1px solid #3a2020", borderRadius: 4, padding: "6px 0", fontSize: 11, cursor: "pointer", background: "#2a1a1a", color: C.reject, marginTop: 8 }}>写真を削除</button>
          </div>
        )}
      </div>

      {/* Status bar */}
      <div style={{ height: 24, background: C.toolbar, borderTop: `1px solid ${C.panelBorder}`, display: "flex", alignItems: "center", padding: "0 16px", justifyContent: "space-between", flexShrink: 0 }}>
        <div style={{ fontSize: 10, color: C.textDim }}>
          {selected ? `${selected.name} | ${selected.width}×${selected.height} | ${(selected.size / 1024 / 1024).toFixed(1)}MB` : "写真を選択してください"}
          {activeCollection && ` | 📁 ${collections.find((c) => c.id === activeCollection)?.name || ""}`}
        </div>
        <div style={{ fontSize: 10, color: C.textDim }}>
          {mode === "develop" && zoom !== 1 && `${Math.round(zoom * 100)}% | `}
          {dbLoaded ? "💾 自動保存" : "読込中..."} | HEIC対応 | {filteredPhotos.length}/{photos.length} 枚
        </div>
      </div>

      {/* Dialogs */}
      {importProgress && <ImportProgress current={importProgress.current} total={importProgress.total} currentFile={importProgress.file} onCancel={() => { importCancelRef.current = true; setImportProgress(null); showToast("インポートをキャンセル"); }} />}
      {showExportDialog && selected && <ExportDialog photo={selected} batchCount={batchExport ? multiSelect.size : 0} onExport={exportPhoto} onClose={() => { setShowExportDialog(false); setBatchExport(false); }} />}
      {showCollectionDialog && <CollectionDialog collections={collections} onAdd={addCollection} onClose={() => setShowCollectionDialog(false)} />}

      {/* Toast */}
      {toast && <div style={{ position: "fixed", bottom: 40, left: "50%", transform: "translateX(-50%)", background: "rgba(0,0,0,0.85)", color: "#fff", fontSize: 12, padding: "8px 20px", borderRadius: 8, zIndex: 1000, pointerEvents: "none" }}>{toast}</div>}

      {/* Drag overlay */}
      {dragOver && <div style={{ position: "fixed", inset: 0, background: "rgba(104,181,255,0.08)", border: "3px dashed rgba(104,181,255,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999, pointerEvents: "none" }}><div style={{ background: "rgba(0,0,0,0.8)", padding: "24px 40px", borderRadius: 12, fontSize: 16, color: C.accent, fontWeight: 600 }}>写真をドロップしてインポート</div></div>}
    </div>
  );
}

function btn(C) { return { background: "transparent", border: "none", color: C.text, fontSize: 12, padding: "4px 10px", borderRadius: 4, cursor: "pointer", whiteSpace: "nowrap" }; }
