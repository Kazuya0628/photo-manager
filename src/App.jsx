import { useState, useRef, useEffect, useCallback, useMemo } from "react";

/* ─────────────────────────────────────────────────
   Photo Studio — Phase 3
   Crop/Rotate, Vignette, Grain, Split Toning,
   Advanced Export
   ───────────────────────────────────────────────── */

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const uid = () => crypto.randomUUID?.() || Math.random().toString(36).slice(2);
const lerp = (a, b, t) => a + (b - a) * t;

// ── Default adjustments ──
const DEFAULT_CURVE = [
  { x: 0, y: 0 },
  { x: 0.25, y: 0.25 },
  { x: 0.75, y: 0.75 },
  { x: 1, y: 1 },
];

const HSL_COLORS = ["レッド", "オレンジ", "イエロー", "グリーン", "アクア", "ブルー", "パープル", "マゼンタ"];
const HSL_HUE_CENTERS = [0, 30, 60, 120, 180, 210, 270, 330];
const HSL_DOT_COLORS = ["#e74c3c", "#e67e22", "#f1c40f", "#2ecc71", "#1abc9c", "#3498db", "#9b59b6", "#e84393"];

const DEFAULT_HSL = () => {
  const h = {};
  HSL_COLORS.forEach((c) => { h[c] = { hue: 0, saturation: 0, luminance: 0 }; });
  return h;
};

const DEFAULT_ADJ = {
  exposure: 0, contrast: 0, highlights: 0, shadows: 0,
  whites: 0, blacks: 0, temperature: 0, tint: 0,
  saturation: 0, vibrance: 0, clarity: 0, dehaze: 0,
  sharpness: 0,
  toneCurve: JSON.parse(JSON.stringify(DEFAULT_CURVE)),
  toneCurveR: JSON.parse(JSON.stringify(DEFAULT_CURVE)),
  toneCurveG: JSON.parse(JSON.stringify(DEFAULT_CURVE)),
  toneCurveB: JSON.parse(JSON.stringify(DEFAULT_CURVE)),
  hsl: DEFAULT_HSL(),
  // Phase 3
  vignette: 0,           // -100 to 100
  vignetteFeather: 50,   // 0 to 100
  grain: 0,              // 0 to 100
  grainSize: 25,         // 0 to 100
  splitHighHue: 40,      // 0 to 360
  splitHighSat: 0,       // 0 to 100
  splitShadHue: 220,     // 0 to 360
  splitShadSat: 0,       // 0 to 100
  splitBalance: 0,       // -100 to 100
  rotation: 0,           // degrees
  crop: null,            // { x, y, w, h } normalized 0-1, null = no crop
};

const deepClone = (o) => JSON.parse(JSON.stringify(o));

// ── Tone Curve LUT builder ──
function buildCurveLUT(points) {
  const lut = new Float32Array(256);
  const sorted = [...points].sort((a, b) => a.x - b.x);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let y = t;
    for (let j = 0; j < sorted.length - 1; j++) {
      if (t >= sorted[j].x && t <= sorted[j + 1].x) {
        const seg = (t - sorted[j].x) / (sorted[j + 1].x - sorted[j].x);
        y = lerp(sorted[j].y, sorted[j + 1].y, seg);
        break;
      }
    }
    if (t <= sorted[0].x) y = sorted[0].y;
    if (t >= sorted[sorted.length - 1].x) y = sorted[sorted.length - 1].y;
    lut[i] = clamp(y, 0, 1);
  }
  return lut;
}

// ── Smoothstep ──
function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

// ── RGB ↔ HSL ──
function rgb2hsl(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (mx === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h * 360, s, l];
}

function hsl2rgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [r + m, g + m, b + m];
}

// ── Image processing ──
function applyAdjustments(ctx, img, adj, w, h) {
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const imageData = ctx.getImageData(0, 0, w, h);
  const d = imageData.data;

  const exp = Math.pow(2, adj.exposure / 2);
  const con = adj.contrast / 100;
  const sat = 1 + adj.saturation / 100;
  const vib = adj.vibrance / 200;
  const temp = adj.temperature / 100;
  const tintV = adj.tint / 100;
  const hl = adj.highlights / 200;
  const sh = adj.shadows / 200;
  const wh = adj.whites / 200;
  const bl = adj.blacks / 200;
  const clar = adj.clarity / 100;
  const dehaze = adj.dehaze / 200;

  const lutMaster = buildCurveLUT(adj.toneCurve || DEFAULT_CURVE);
  const lutR = buildCurveLUT(adj.toneCurveR || DEFAULT_CURVE);
  const lutG = buildCurveLUT(adj.toneCurveG || DEFAULT_CURVE);
  const lutB = buildCurveLUT(adj.toneCurveB || DEFAULT_CURVE);

  const hslAdj = adj.hsl || DEFAULT_HSL();

  for (let i = 0; i < d.length; i += 4) {
    let r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;

    r *= exp; g *= exp; b *= exp;
    r += temp * 0.08; b -= temp * 0.08; g += tintV * 0.05;

    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const hlMask = smoothstep(0.5, 1.0, lum);
    const shMask = 1 - smoothstep(0.0, 0.5, lum);
    r += hl * hlMask + sh * shMask;
    g += hl * hlMask + sh * shMask;
    b += hl * hlMask + sh * shMask;

    const whMask = smoothstep(0.75, 1.0, lum);
    const blMask = 1 - smoothstep(0.0, 0.25, lum);
    r += wh * whMask - bl * blMask;
    g += wh * whMask - bl * blMask;
    b += wh * whMask - bl * blMask;

    r = (r - 0.5) * (1 + con) + 0.5;
    g = (g - 0.5) * (1 + con) + 0.5;
    b = (b - 0.5) * (1 + con) + 0.5;

    if (clar !== 0) {
      const mid = smoothstep(0.15, 0.85, lum) * (1 - smoothstep(0.15, 0.85, lum)) * 4;
      r += clar * mid * (r - lum) * 0.5;
      g += clar * mid * (g - lum) * 0.5;
      b += clar * mid * (b - lum) * 0.5;
    }

    if (dehaze !== 0) {
      r += dehaze * (r - 0.1);
      g += dehaze * (g - 0.1);
      b += dehaze * (b - 0.1);
    }

    const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = gray + (r - gray) * sat;
    g = gray + (g - gray) * sat;
    b = gray + (b - gray) * sat;

    if (vib !== 0) {
      const maxC = Math.max(r, g, b), minC = Math.min(r, g, b);
      const cSat = maxC === 0 ? 0 : (maxC - minC) / maxC;
      const vibBoost = 1 + vib * (1 - cSat);
      const g2 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = g2 + (r - g2) * vibBoost;
      g = g2 + (g - g2) * vibBoost;
      b = g2 + (b - g2) * vibBoost;
    }

    r = clamp(r, 0, 1); g = clamp(g, 0, 1); b = clamp(b, 0, 1);
    r = lutMaster[Math.round(r * 255)];
    g = lutMaster[Math.round(g * 255)];
    b = lutMaster[Math.round(b * 255)];
    r = lutR[Math.round(r * 255)];
    g = lutG[Math.round(g * 255)];
    b = lutB[Math.round(b * 255)];

    let [hue, hSat, hLum] = rgb2hsl(clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1));
    let hueShift = 0, satShift = 0, lumShift = 0;
    for (let ci = 0; ci < HSL_COLORS.length; ci++) {
      const center = HSL_HUE_CENTERS[ci];
      let diff = Math.abs(hue - center);
      if (diff > 180) diff = 360 - diff;
      if (diff < 45) {
        const weight = 1 - diff / 45;
        const cAdj = hslAdj[HSL_COLORS[ci]];
        if (cAdj) {
          hueShift += cAdj.hue * weight;
          satShift += (cAdj.saturation / 100) * weight;
          lumShift += (cAdj.luminance / 100) * weight;
        }
      }
    }
    hue = (hue + hueShift + 360) % 360;
    hSat = clamp(hSat + satShift, 0, 1);
    hLum = clamp(hLum + lumShift, 0, 1);
    [r, g, b] = hsl2rgb(hue, hSat, hLum);

    d[i] = clamp(r * 255, 0, 255);
    d[i + 1] = clamp(g * 255, 0, 255);
    d[i + 2] = clamp(b * 255, 0, 255);
  }

  // Post-processing passes (need x,y coordinates)
  const vigAmt = adj.vignette / 100;
  const vigFeather = 0.2 + (adj.vignetteFeather / 100) * 0.8;
  const splitHiSat = adj.splitHighSat / 100;
  const splitShSat = adj.splitShadSat / 100;
  const splitBal = (adj.splitBalance + 100) / 200; // 0-1
  const grainAmt = adj.grain / 100;
  const grainSz = Math.max(1, Math.round(1 + (adj.grainSize / 100) * 3));
  const needPostPass = vigAmt !== 0 || splitHiSat > 0 || splitShSat > 0 || grainAmt > 0;

  if (needPostPass) {
    // Pre-compute split toning colors
    const [shR, shG, shB] = hsl2rgb(adj.splitShadHue, 1, 0.5);
    const [hiR, hiG, hiB] = hsl2rgb(adj.splitHighHue, 1, 0.5);

    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const i = (py * w + px) * 4;
        let r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;

        // Vignette
        if (vigAmt !== 0) {
          const dx = (px / w - 0.5) * 2;
          const dy = (py / h - 0.5) * 2;
          const dist = Math.sqrt(dx * dx + dy * dy) / 1.414;
          const vig = 1 - smoothstep(vigFeather * 0.5, vigFeather, dist) * Math.abs(vigAmt);
          if (vigAmt > 0) { r *= vig; g *= vig; b *= vig; }
          else { const inv = 2 - vig; r *= inv; g *= inv; b *= inv; }
        }

        // Split Toning
        if (splitHiSat > 0 || splitShSat > 0) {
          const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          if (splitShSat > 0 && lum < splitBal) {
            const w2 = (1 - lum / Math.max(splitBal, 0.01)) * splitShSat * 0.3;
            r = lerp(r, shR * lum * 2, w2);
            g = lerp(g, shG * lum * 2, w2);
            b = lerp(b, shB * lum * 2, w2);
          }
          if (splitHiSat > 0 && lum >= splitBal) {
            const w2 = ((lum - splitBal) / Math.max(1 - splitBal, 0.01)) * splitHiSat * 0.3;
            r = lerp(r, hiR * lum * 2, w2);
            g = lerp(g, hiG * lum * 2, w2);
            b = lerp(b, hiB * lum * 2, w2);
          }
        }

        // Grain
        if (grainAmt > 0) {
          const gx = Math.floor(px / grainSz), gy = Math.floor(py / grainSz);
          const seed = (gx * 12289 + gy * 7919 + gx * gy * 3571) & 0xFFFF;
          const noise = ((seed / 65535) - 0.5) * grainAmt * 0.35;
          r += noise; g += noise; b += noise;
        }

        d[i] = clamp(r * 255, 0, 255);
        d[i + 1] = clamp(g * 255, 0, 255);
        d[i + 2] = clamp(b * 255, 0, 255);
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

function computeHistogram(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h).data;
  const rH = new Uint32Array(256), gH = new Uint32Array(256), bH = new Uint32Array(256), lumH = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    rH[d[i]]++; gH[d[i + 1]]++; bH[d[i + 2]]++;
    lumH[clamp(Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]), 0, 255)]++;
  }
  return { r: rH, g: gH, b: bH, lum: lumH };
}

// ── Undo/Redo ──
function useHistory(maxLen = 80) {
  const stack = useRef([]);
  const pointer = useRef(-1);
  const push = useCallback((state) => {
    stack.current = stack.current.slice(0, pointer.current + 1);
    stack.current.push(deepClone(state));
    if (stack.current.length > maxLen) stack.current.shift();
    pointer.current = stack.current.length - 1;
  }, [maxLen]);
  const undo = useCallback(() => {
    if (pointer.current > 0) { pointer.current--; return deepClone(stack.current[pointer.current]); }
    return null;
  }, []);
  const redo = useCallback(() => {
    if (pointer.current < stack.current.length - 1) { pointer.current++; return deepClone(stack.current[pointer.current]); }
    return null;
  }, []);
  const canUndo = useCallback(() => pointer.current > 0, []);
  const canRedo = useCallback(() => pointer.current < stack.current.length - 1, []);
  return { push, undo, redo, canUndo, canRedo };
}

// ═══ Sub-Components ═══

function Histogram({ data, width = 220, height = 60 }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!data || !ref.current) return;
    const ctx = ref.current.getContext("2d");
    ctx.clearRect(0, 0, width, height);
    const maxVal = Math.max(...Array.from(data.lum).slice(1, 254), ...Array.from(data.r).slice(1, 254), ...Array.from(data.g).slice(1, 254), ...Array.from(data.b).slice(1, 254)) || 1;
    const draw = (ch, col) => {
      ctx.beginPath(); ctx.moveTo(0, height);
      for (let i = 0; i < 256; i++) ctx.lineTo((i / 255) * width, height - (ch[i] / maxVal) * height);
      ctx.lineTo(width, height); ctx.closePath(); ctx.fillStyle = col; ctx.fill();
    };
    ctx.globalCompositeOperation = "source-over";
    draw(data.lum, "rgba(180,180,180,0.3)");
    ctx.globalCompositeOperation = "screen";
    draw(data.r, "rgba(220,60,60,0.45)");
    draw(data.g, "rgba(60,180,60,0.45)");
    draw(data.b, "rgba(60,80,220,0.45)");
  }, [data, width, height]);
  return <canvas ref={ref} width={width} height={height} style={{ width: "100%", height, borderRadius: 4, background: "#111" }} />;
}

function CurveEditor({ points, onChange, color = "#ccc" }) {
  const SIZE = 180;
  const canvasRef = useRef(null);
  const [dragging, setDragging] = useState(null);

  const draw = useCallback(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext("2d");
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.strokeStyle = "rgba(255,255,255,0.08)"; ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const p = (i / 4) * SIZE;
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, SIZE); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(SIZE, p); ctx.stroke();
    }
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.beginPath(); ctx.moveTo(0, SIZE); ctx.lineTo(SIZE, 0); ctx.stroke();

    const sorted = [...points].sort((a, b) => a.x - b.x);
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
    for (let px = 0; px < SIZE; px++) {
      const t = px / SIZE;
      let y = t;
      for (let j = 0; j < sorted.length - 1; j++) {
        if (t >= sorted[j].x && t <= sorted[j + 1].x) {
          y = lerp(sorted[j].y, sorted[j + 1].y, (t - sorted[j].x) / (sorted[j + 1].x - sorted[j].x));
          break;
        }
      }
      if (t <= sorted[0].x) y = sorted[0].y;
      if (t >= sorted[sorted.length - 1].x) y = sorted[sorted.length - 1].y;
      if (px === 0) ctx.moveTo(px, SIZE - y * SIZE); else ctx.lineTo(px, SIZE - y * SIZE);
    }
    ctx.stroke();

    points.forEach((pt, i) => {
      ctx.beginPath();
      ctx.arc(pt.x * SIZE, SIZE - pt.y * SIZE, i === dragging ? 6 : 4, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 || i === points.length - 1 ? "#888" : color;
      ctx.fill(); ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.stroke();
    });
  }, [points, color, dragging]);

  useEffect(() => { draw(); }, [draw]);

  const getPos = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: clamp((cx - rect.left) / SIZE, 0, 1), y: clamp(1 - (cy - rect.top) / SIZE, 0, 1) };
  };

  const onDown = (e) => {
    const pos = getPos(e);
    let closest = -1, minDist = 0.05;
    points.forEach((pt, i) => { const d = Math.hypot(pt.x - pos.x, pt.y - pos.y); if (d < minDist) { minDist = d; closest = i; } });
    if (closest >= 0) { setDragging(closest); }
    else {
      const newPts = [...points, { x: pos.x, y: pos.y }].sort((a, b) => a.x - b.x);
      onChange(newPts);
      setDragging(newPts.findIndex((p) => p.x === pos.x && p.y === pos.y));
    }
  };

  const onMove = (e) => {
    if (dragging === null) return;
    e.preventDefault();
    const pos = getPos(e);
    const newPts = [...points];
    if (dragging === 0) newPts[0] = { x: 0, y: clamp(pos.y, 0, 1) };
    else if (dragging === points.length - 1) newPts[dragging] = { x: 1, y: clamp(pos.y, 0, 1) };
    else newPts[dragging] = { x: clamp(pos.x, 0.01, 0.99), y: clamp(pos.y, 0, 1) };
    onChange(newPts);
  };

  const onUp = () => setDragging(null);

  const onDblClick = (e) => {
    const pos = getPos(e);
    let closest = -1, minDist = 0.05;
    points.forEach((pt, i) => { if (i === 0 || i === points.length - 1) return; const d = Math.hypot(pt.x - pos.x, pt.y - pos.y); if (d < minDist) { minDist = d; closest = i; } });
    if (closest >= 0) onChange(points.filter((_, i) => i !== closest));
  };

  return (
    <canvas ref={canvasRef} width={SIZE} height={SIZE}
      style={{ width: "100%", height: SIZE, borderRadius: 4, background: "rgba(255,255,255,0.03)", cursor: "crosshair", touchAction: "none" }}
      onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}
      onDoubleClick={onDblClick} onTouchStart={onDown} onTouchMove={onMove} onTouchEnd={onUp} />
  );
}

function HSLPanel({ hsl, onChange }) {
  const [tab, setTab] = useState("saturation");
  return (
    <div>
      <div style={{ display: "flex", gap: 2, marginBottom: 8 }}>
        {[{ key: "hue", label: "色相" }, { key: "saturation", label: "彩度" }, { key: "luminance", label: "輝度" }].map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{ flex: 1, border: "none", borderRadius: 3, padding: "3px 0", fontSize: 10, cursor: "pointer",
              background: tab === t.key ? "#68b5ff" : "#333", color: tab === t.key ? "#111" : "#888", fontWeight: tab === t.key ? 600 : 400 }}>
            {t.label}
          </button>
        ))}
      </div>
      {HSL_COLORS.map((color, i) => {
        const val = hsl[color]?.[tab] || 0;
        const range = tab === "hue" ? [-30, 30] : [-100, 100];
        return (
          <div key={color} style={{ marginBottom: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 1 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: HSL_DOT_COLORS[i], flexShrink: 0 }} />
              <span style={{ fontSize: 10, color: "#aaa", flex: 1 }}>{color}</span>
              <span style={{ fontSize: 10, color: val !== 0 ? "#68b5ff" : "#555", fontVariantNumeric: "tabular-nums", width: 32, textAlign: "right" }}>
                {val > 0 ? "+" : ""}{val}
              </span>
            </div>
            <input type="range" min={range[0]} max={range[1]} value={val}
              onChange={(e) => { const n = deepClone(hsl); n[color][tab] = parseInt(e.target.value); onChange(n); }}
              onDoubleClick={() => { const n = deepClone(hsl); n[color][tab] = 0; onChange(n); }}
              style={{ width: "100%", height: 10, accentColor: HSL_DOT_COLORS[i], cursor: "pointer" }} />
          </div>
        );
      })}
    </div>
  );
}

function Slider({ label, value, min, max, step = 1, onChange }) {
  const pct = ((value - min) / (max - min)) * 100;
  const isZero = min < 0;
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#aaa", marginBottom: 2 }}>
        <span>{label}</span>
        <span style={{ color: value !== 0 ? "#68b5ff" : "#666", fontVariantNumeric: "tabular-nums" }}>
          {value > 0 ? "+" : ""}{typeof value === "number" ? (Number.isInteger(value) ? value : value.toFixed(2)) : value}
        </span>
      </div>
      <div style={{ position: "relative", height: 14, display: "flex", alignItems: "center" }}>
        <div style={{ position: "absolute", left: 0, right: 0, height: 3, background: "#333", borderRadius: 2 }} />
        {isZero && <div style={{ position: "absolute", left: "50%", width: 1, height: 7, background: "#555", top: 3.5 }} />}
        <div style={{ position: "absolute", left: isZero ? `${Math.min(50, pct)}%` : 0, width: isZero ? `${Math.abs(pct - 50)}%` : `${pct}%`, height: 3, background: "#68b5ff", borderRadius: 2 }} />
        <input type="range" min={min} max={max} step={step} value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          onDoubleClick={() => onChange(0)}
          style={{ position: "absolute", width: "100%", height: 14, opacity: 0, cursor: "pointer", margin: 0 }} />
        <div style={{ position: "absolute", left: `calc(${pct}% - 6px)`, width: 12, height: 12, borderRadius: "50%", background: "#ddd", border: "2px solid #68b5ff", pointerEvents: "none" }} />
      </div>
    </div>
  );
}

function StarRating({ value, onChange, size = 14 }) {
  return (
    <div style={{ display: "flex", gap: 1, cursor: "pointer" }}>
      {[1, 2, 3, 4, 5].map((s) => (
        <span key={s} onClick={(e) => { e.stopPropagation(); onChange(value === s ? 0 : s); }}
          style={{ fontSize: size, color: s <= value ? "#f5c842" : "#444", userSelect: "none" }}>★</span>
      ))}
    </div>
  );
}

function Section({ title, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginBottom: 8 }}>
      <div onClick={() => setOpen(!open)}
        style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", padding: "6px 0", borderBottom: "1px solid #2a2a2a", userSelect: "none", fontSize: 11, fontWeight: 600, letterSpacing: 0.8, textTransform: "uppercase", color: "#888" }}>
        <span style={{ transform: open ? "rotate(90deg)" : "none", transition: "0.15s", fontSize: 9 }}>▶</span>
        <span style={{ flex: 1 }}>{title}</span>
      </div>
      {open && <div style={{ paddingTop: 8 }}>{children}</div>}
    </div>
  );
}

function PresetBar({ presets, onApply, onSave, onDelete }) {
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
        {presets.map((p) => (
          <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 2 }}>
            <button onClick={() => onApply(p)}
              style={{ border: "1px solid #444", background: "#2a2a2a", color: "#bbb", fontSize: 10, padding: "3px 8px", borderRadius: 3, cursor: "pointer" }}>{p.name}</button>
            <button onClick={() => onDelete(p.id)}
              style={{ border: "none", background: "transparent", color: "#666", fontSize: 10, cursor: "pointer", padding: "0 2px" }}>×</button>
          </div>
        ))}
      </div>
      <button onClick={onSave}
        style={{ border: "1px dashed #555", background: "transparent", color: "#888", fontSize: 10, padding: "3px 10px", borderRadius: 3, cursor: "pointer", width: "100%" }}>+ プリセット保存</button>
    </div>
  );
}

// ── Crop Overlay Tool ──
const CROP_RATIOS = [
  { label: "フリー", value: null },
  { label: "1:1", value: 1 },
  { label: "4:3", value: 4 / 3 },
  { label: "3:2", value: 3 / 2 },
  { label: "16:9", value: 16 / 9 },
  { label: "5:4", value: 5 / 4 },
];

function CropOverlay({ imgW, imgH, crop, rotation, onChange, onRotate, canvasRect }) {
  const [dragging, setDragging] = useState(null);
  const [ratio, setRatio] = useState(null);
  const startRef = useRef(null);

  const cx = crop ? crop.x : 0, cy = crop ? crop.y : 0;
  const cw = crop ? crop.w : 1, ch = crop ? crop.h : 1;

  // Canvas pixel coords
  const toPixel = (nx, ny) => ({
    px: canvasRect.left + nx * canvasRect.width,
    py: canvasRect.top + ny * canvasRect.height,
  });

  const fromPixel = (px, py) => ({
    nx: clamp((px - canvasRect.left) / canvasRect.width, 0, 1),
    ny: clamp((py - canvasRect.top) / canvasRect.height, 0, 1),
  });

  const tl = toPixel(cx, cy);
  const br = toPixel(cx + cw, cy + ch);
  const cropW = br.px - tl.px, cropH = br.py - tl.py;

  const handleSize = 10;

  const onMouseDown = (e, type) => {
    e.stopPropagation();
    startRef.current = { mx: e.clientX, my: e.clientY, cx, cy, cw, ch };
    setDragging(type);
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e) => {
      const s = startRef.current;
      const dx = (e.clientX - s.mx) / canvasRect.width;
      const dy = (e.clientY - s.my) / canvasRect.height;

      let nx = s.cx, ny = s.cy, nw = s.cw, nh = s.ch;
      if (dragging === "move") {
        nx = clamp(s.cx + dx, 0, 1 - s.cw);
        ny = clamp(s.cy + dy, 0, 1 - s.ch);
      } else if (dragging === "br") {
        nw = clamp(s.cw + dx, 0.05, 1 - s.cx);
        nh = ratio ? nw / ratio * (imgW / imgH) : clamp(s.ch + dy, 0.05, 1 - s.cy);
      } else if (dragging === "tl") {
        const dw = clamp(s.cw - dx, 0.05, s.cx + s.cw);
        const dh = ratio ? dw / ratio * (imgW / imgH) : clamp(s.ch - dy, 0.05, s.cy + s.ch);
        nx = s.cx + s.cw - dw; ny = s.cy + s.ch - dh; nw = dw; nh = dh;
      } else if (dragging === "tr") {
        nw = clamp(s.cw + dx, 0.05, 1 - s.cx);
        const dh = ratio ? nw / ratio * (imgW / imgH) : clamp(s.ch - dy, 0.05, s.cy + s.ch);
        ny = s.cy + s.ch - dh; nh = dh;
      } else if (dragging === "bl") {
        const dw = clamp(s.cw - dx, 0.05, s.cx + s.cw);
        nh = ratio ? dw / ratio * (imgW / imgH) : clamp(s.ch + dy, 0.05, 1 - s.cy);
        nx = s.cx + s.cw - dw; nw = dw;
      }
      onChange({ x: nx, y: ny, w: clamp(nw, 0.05, 1), h: clamp(nh, 0.05, 1) });
    };
    const onUp = () => setDragging(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [dragging, canvasRect, ratio, imgW, imgH, onChange]);

  const handleStyle = (pos) => ({
    position: "absolute", width: handleSize, height: handleSize, background: "#fff", border: "1px solid #68b5ff",
    cursor: pos === "tl" ? "nw-resize" : pos === "tr" ? "ne-resize" : pos === "bl" ? "sw-resize" : "se-resize",
    ...(pos === "tl" ? { left: -handleSize / 2, top: -handleSize / 2 } :
       pos === "tr" ? { right: -handleSize / 2, top: -handleSize / 2 } :
       pos === "bl" ? { left: -handleSize / 2, bottom: -handleSize / 2 } :
       { right: -handleSize / 2, bottom: -handleSize / 2 }),
  });

  // Rule of thirds
  const thirds = [1/3, 2/3];

  return (
    <>
      {/* Dark overlay outside crop */}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: `${cy * 100}%`, background: "rgba(0,0,0,0.55)" }} />
        <div style={{ position: "absolute", top: `${(cy + ch) * 100}%`, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.55)" }} />
        <div style={{ position: "absolute", top: `${cy * 100}%`, left: 0, width: `${cx * 100}%`, height: `${ch * 100}%`, background: "rgba(0,0,0,0.55)" }} />
        <div style={{ position: "absolute", top: `${cy * 100}%`, left: `${(cx + cw) * 100}%`, right: 0, height: `${ch * 100}%`, background: "rgba(0,0,0,0.55)" }} />
      </div>

      {/* Crop box */}
      <div
        onMouseDown={(e) => onMouseDown(e, "move")}
        style={{
          position: "absolute", left: `${cx * 100}%`, top: `${cy * 100}%`,
          width: `${cw * 100}%`, height: `${ch * 100}%`,
          border: "1px solid rgba(255,255,255,0.7)", cursor: "move", boxSizing: "border-box",
        }}>
        {/* Rule of thirds */}
        {thirds.map((t) => (
          <div key={`h${t}`} style={{ position: "absolute", left: 0, right: 0, top: `${t * 100}%`, height: 1, background: "rgba(255,255,255,0.2)", pointerEvents: "none" }} />
        ))}
        {thirds.map((t) => (
          <div key={`v${t}`} style={{ position: "absolute", top: 0, bottom: 0, left: `${t * 100}%`, width: 1, background: "rgba(255,255,255,0.2)", pointerEvents: "none" }} />
        ))}
        {/* Corner handles */}
        <div onMouseDown={(e) => onMouseDown(e, "tl")} style={handleStyle("tl")} />
        <div onMouseDown={(e) => onMouseDown(e, "tr")} style={handleStyle("tr")} />
        <div onMouseDown={(e) => onMouseDown(e, "bl")} style={handleStyle("bl")} />
        <div onMouseDown={(e) => onMouseDown(e, "br")} style={handleStyle("br")} />
      </div>

      {/* Controls bar */}
      <div style={{
        position: "absolute", bottom: 8, left: "50%", transform: "translateX(-50%)",
        display: "flex", gap: 4, background: "rgba(0,0,0,0.8)", borderRadius: 6, padding: "4px 8px", alignItems: "center",
      }}>
        {CROP_RATIOS.map((r) => (
          <button key={r.label} onClick={() => {
            setRatio(r.value);
            if (r.value) {
              const newH = cw / r.value * (imgW / imgH);
              onChange({ x: cx, y: cy, w: cw, h: clamp(newH, 0.05, 1) });
            }
          }}
          style={{
            border: "none", background: ratio === r.value ? "#68b5ff" : "#444", color: ratio === r.value ? "#111" : "#bbb",
            fontSize: 9, padding: "2px 6px", borderRadius: 3, cursor: "pointer", fontWeight: ratio === r.value ? 600 : 400,
          }}>{r.label}</button>
        ))}
        <div style={{ width: 1, height: 14, background: "#555" }} />
        <button onClick={() => onRotate(-90)} style={{ border: "none", background: "#444", color: "#bbb", fontSize: 12, padding: "2px 6px", borderRadius: 3, cursor: "pointer" }}>↺</button>
        <button onClick={() => onRotate(90)} style={{ border: "none", background: "#444", color: "#bbb", fontSize: 12, padding: "2px 6px", borderRadius: 3, cursor: "pointer" }}>↻</button>
      </div>
    </>
  );
}

// ── Export Dialog ──
function ExportDialog({ photo, onExport, onClose }) {
  const [format, setFormat] = useState("jpeg");
  const [quality, setQuality] = useState(92);
  const [resize, setResize] = useState("original");
  const [customW, setCustomW] = useState(photo?.width || 1920);
  const [customH, setCustomH] = useState(photo?.height || 1080);
  const [keepAspect, setKeepAspect] = useState(true);

  const aspectRatio = photo ? photo.width / photo.height : 1;

  const sizeOptions = [
    { key: "original", label: "オリジナル", w: photo?.width, h: photo?.height },
    { key: "4k", label: "4K (3840px)", w: 3840, h: Math.round(3840 / aspectRatio) },
    { key: "2k", label: "2K (2560px)", w: 2560, h: Math.round(2560 / aspectRatio) },
    { key: "fhd", label: "Full HD (1920px)", w: 1920, h: Math.round(1920 / aspectRatio) },
    { key: "hd", label: "HD (1280px)", w: 1280, h: Math.round(1280 / aspectRatio) },
    { key: "web", label: "Web (800px)", w: 800, h: Math.round(800 / aspectRatio) },
    { key: "custom", label: "カスタム" },
  ];

  const getSize = () => {
    if (resize === "custom") return { w: customW, h: customH };
    const opt = sizeOptions.find((o) => o.key === resize);
    return { w: opt?.w || photo?.width, h: opt?.h || photo?.height };
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}
      onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: "#2a2a2a", borderRadius: 12, padding: 24, width: 360, maxHeight: "80vh", overflowY: "auto", border: "1px solid #444" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "#fff" }}>エクスポート設定</span>
          <button onClick={onClose} style={{ border: "none", background: "transparent", color: "#888", fontSize: 18, cursor: "pointer" }}>×</button>
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: "#aaa", marginBottom: 6 }}>フォーマット</div>
          <div style={{ display: "flex", gap: 4 }}>
            {[{ key: "jpeg", label: "JPEG" }, { key: "png", label: "PNG" }, { key: "webp", label: "WebP" }].map((f) => (
              <button key={f.key} onClick={() => setFormat(f.key)}
                style={{
                  flex: 1, border: "1px solid #444", borderRadius: 4, padding: "6px 0", fontSize: 11, cursor: "pointer",
                  background: format === f.key ? "#68b5ff" : "#333", color: format === f.key ? "#111" : "#bbb",
                  fontWeight: format === f.key ? 600 : 400,
                }}>{f.label}</button>
            ))}
          </div>
        </div>

        {format !== "png" && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#aaa", marginBottom: 4 }}>
              <span>品質</span><span style={{ color: "#68b5ff" }}>{quality}%</span>
            </div>
            <input type="range" min={10} max={100} value={quality} onChange={(e) => setQuality(parseInt(e.target.value))}
              style={{ width: "100%", accentColor: "#68b5ff" }} />
          </div>
        )}

        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: "#aaa", marginBottom: 6 }}>サイズ</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {sizeOptions.map((s) => (
              <button key={s.key} onClick={() => setResize(s.key)}
                style={{
                  border: "1px solid #444", borderRadius: 4, padding: "5px 10px", fontSize: 11, cursor: "pointer",
                  background: resize === s.key ? "#68b5ff" : "#333", color: resize === s.key ? "#111" : "#bbb",
                  textAlign: "left", fontWeight: resize === s.key ? 600 : 400,
                }}>
                {s.label}{s.w && s.key !== "custom" ? ` (${s.w}×${s.h})` : ""}
              </button>
            ))}
          </div>
          {resize === "custom" && (
            <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
              <input type="number" value={customW} onChange={(e) => {
                const w = parseInt(e.target.value) || 1;
                setCustomW(w);
                if (keepAspect) setCustomH(Math.round(w / aspectRatio));
              }} style={{ width: 80, background: "#333", border: "1px solid #555", borderRadius: 4, padding: "4px 6px", color: "#ccc", fontSize: 11 }} />
              <span style={{ color: "#666" }}>×</span>
              <input type="number" value={customH} onChange={(e) => {
                const h = parseInt(e.target.value) || 1;
                setCustomH(h);
                if (keepAspect) setCustomW(Math.round(h * aspectRatio));
              }} style={{ width: 80, background: "#333", border: "1px solid #555", borderRadius: 4, padding: "4px 6px", color: "#ccc", fontSize: 11 }} />
              <label style={{ fontSize: 10, color: "#888", display: "flex", alignItems: "center", gap: 3, cursor: "pointer" }}>
                <input type="checkbox" checked={keepAspect} onChange={() => setKeepAspect(!keepAspect)} /> 比率固定
              </label>
            </div>
          )}
        </div>

        <button onClick={() => {
          const size = getSize();
          onExport({ format, quality: quality / 100, width: size.w, height: size.h });
        }} style={{
          width: "100%", border: "none", borderRadius: 6, padding: "10px 0", fontSize: 13,
          background: "#68b5ff", color: "#111", fontWeight: 600, cursor: "pointer",
        }}>エクスポート</button>
      </div>
    </div>
  );
}

// ── Split Tone Hue Picker ──
function HuePicker({ value, onChange, saturation = 50 }) {
  const ref = useRef(null);
  const W = 200, H = 16;

  useEffect(() => {
    if (!ref.current) return;
    const ctx = ref.current.getContext("2d");
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    for (let i = 0; i <= 12; i++) grad.addColorStop(i / 12, `hsl(${i * 30}, ${saturation}%, 50%)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    // Indicator
    const x = (value / 360) * W;
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, H / 2, 6, 0, Math.PI * 2); ctx.stroke();
  }, [value, saturation, W, H]);

  const onInteract = (e) => {
    const rect = ref.current.getBoundingClientRect();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const hue = clamp(Math.round(((cx - rect.left) / rect.width) * 360), 0, 360);
    onChange(hue);
  };

  return (
    <canvas ref={ref} width={W} height={H}
      style={{ width: "100%", height: H, borderRadius: 4, cursor: "pointer", touchAction: "none" }}
      onMouseDown={(e) => { onInteract(e); const move = (ev) => onInteract(ev); const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); }; window.addEventListener("mousemove", move); window.addEventListener("mouseup", up); }}
    />
  );
}

// ═══ Main App ═══
export default function PhotoStudio() {
  const [photos, setPhotos] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState("library");
  const [showBefore, setShowBefore] = useState(false);
  const [histData, setHistData] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [filterRating, setFilterRating] = useState(0);
  const [filterFlag, setFilterFlag] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState("imported");
  const [curveChannel, setCurveChannel] = useState("master");
  const [presets, setPresets] = useState([]);
  const [clipboardAdj, setClipboardAdj] = useState(null);
  const [multiSelect, setMultiSelect] = useState(new Set());
  const [toast, setToast] = useState(null);
  const [cropMode, setCropMode] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);

  const canvasRef = useRef(null);
  const imgCache = useRef({});
  const fileInputRef = useRef(null);
  const history = useHistory();

  const selected = useMemo(() => photos.find((p) => p.id === selectedId), [photos, selectedId]);

  const showToast = useCallback((msg) => { setToast(msg); setTimeout(() => setToast(null), 2000); }, []);

  const loadImage = useCallback((photo) => {
    return new Promise((resolve) => {
      if (imgCache.current[photo.id]) return resolve(imgCache.current[photo.id]);
      const img = new Image();
      img.onload = () => { imgCache.current[photo.id] = img; resolve(img); };
      img.src = photo.dataUrl;
    });
  }, []);

  const renderPreview = useCallback(async (photo, useOriginal = false) => {
    if (!photo || !canvasRef.current) return;
    const img = await loadImage(photo);
    const canvas = canvasRef.current;
    const maxW = canvas.parentElement?.clientWidth || 800;
    const maxH = canvas.parentElement?.clientHeight || 600;

    const rot = photo.adjustments.rotation || 0;
    const isRotated90 = rot === 90 || rot === -90 || rot === 270;
    const srcW = isRotated90 ? img.height : img.width;
    const srcH = isRotated90 ? img.width : img.height;

    const scale = Math.min(maxW / srcW, maxH / srcH, 1);
    const w = Math.round(srcW * scale), h = Math.round(srcH * scale);
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    if (rot !== 0) {
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.rotate((rot * Math.PI) / 180);
      const drawW = isRotated90 ? h : w;
      const drawH = isRotated90 ? w : h;
      ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
      ctx.restore();
      if (!useOriginal) {
        const imageData = ctx.getImageData(0, 0, w, h);
        ctx.putImageData(imageData, 0, 0);
        // Re-draw rotated then apply adjustments
        const tempCanvas = document.createElement("canvas");
        tempCanvas.width = w; tempCanvas.height = h;
        const tempCtx = tempCanvas.getContext("2d");
        tempCtx.drawImage(canvas, 0, 0);
        const tempImg = new Image();
        await new Promise((res) => { tempImg.onload = res; tempImg.src = tempCanvas.toDataURL(); });
        applyAdjustments(ctx, tempImg, photo.adjustments, w, h);
      }
    } else {
      if (useOriginal) { ctx.clearRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h); }
      else applyAdjustments(ctx, img, photo.adjustments, w, h);
    }
    setHistData(computeHistogram(ctx, w, h));
  }, [loadImage]);

  useEffect(() => {
    if (mode === "develop" && selected) renderPreview(selected, showBefore);
  }, [mode, selected, showBefore, renderPreview]);

  const importFiles = useCallback((files) => {
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!imageFiles.length) return;
    const newPhotos = []; let loaded = 0;
    imageFiles.forEach((file) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const tc = document.createElement("canvas");
          const s = Math.min(300 / img.width, 300 / img.height);
          tc.width = Math.round(img.width * s); tc.height = Math.round(img.height * s);
          tc.getContext("2d").drawImage(img, 0, 0, tc.width, tc.height);
          newPhotos.push({
            id: uid(), name: file.name, size: file.size, width: img.width, height: img.height,
            dataUrl: e.target.result, thumbUrl: tc.toDataURL("image/jpeg", 0.7),
            rating: 0, flag: "none", tags: [], adjustments: deepClone(DEFAULT_ADJ), importedAt: Date.now(),
          });
          loaded++;
          if (loaded === imageFiles.length) {
            setPhotos((prev) => {
              const updated = [...prev, ...newPhotos];
              if (!selectedId && updated.length > 0) setSelectedId(updated[0].id);
              return updated;
            });
            showToast(`${imageFiles.length} 枚インポート`);
          }
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }, [selectedId, showToast]);

  const updatePhoto = useCallback((id, updates) => {
    setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, ...updates } : p)));
  }, []);

  const adjDebounce = useRef(null);
  const updateAdj = useCallback((key, value) => {
    if (!selected) return;
    const newAdj = deepClone(selected.adjustments);
    if (typeof key === "string") newAdj[key] = value; else Object.assign(newAdj, key);
    updatePhoto(selected.id, { adjustments: newAdj });
    if (canvasRef.current) {
      loadImage(selected).then((img) => {
        const canvas = canvasRef.current; if (!canvas) return;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        applyAdjustments(ctx, img, newAdj, canvas.width, canvas.height);
        setHistData(computeHistogram(ctx, canvas.width, canvas.height));
      });
    }
    clearTimeout(adjDebounce.current);
    adjDebounce.current = setTimeout(() => { history.push({ photoId: selected.id, adjustments: newAdj }); }, 400);
  }, [selected, updatePhoto, loadImage, history]);

  const resetAdj = useCallback(() => {
    if (!selected) return;
    const fresh = deepClone(DEFAULT_ADJ);
    updatePhoto(selected.id, { adjustments: fresh });
    history.push({ photoId: selected.id, adjustments: fresh });
    renderPreview({ ...selected, adjustments: fresh });
  }, [selected, updatePhoto, renderPreview, history]);

  const doUndo = useCallback(() => {
    const s = history.undo();
    if (s && s.photoId === selectedId) { updatePhoto(s.photoId, { adjustments: s.adjustments }); renderPreview({ ...selected, adjustments: s.adjustments }); showToast("元に戻す"); }
  }, [history, selectedId, selected, updatePhoto, renderPreview, showToast]);

  const doRedo = useCallback(() => {
    const s = history.redo();
    if (s && s.photoId === selectedId) { updatePhoto(s.photoId, { adjustments: s.adjustments }); renderPreview({ ...selected, adjustments: s.adjustments }); showToast("やり直し"); }
  }, [history, selectedId, selected, updatePhoto, renderPreview, showToast]);

  const copyAdj = useCallback(() => { if (!selected) return; setClipboardAdj(deepClone(selected.adjustments)); showToast("設定コピー"); }, [selected, showToast]);
  const pasteAdj = useCallback(() => {
    if (!clipboardAdj) return;
    if (multiSelect.size > 0) {
      setPhotos((prev) => prev.map((p) => multiSelect.has(p.id) ? { ...p, adjustments: deepClone(clipboardAdj) } : p));
      showToast(`${multiSelect.size} 枚にペースト`);
    } else if (selected) {
      updatePhoto(selected.id, { adjustments: deepClone(clipboardAdj) });
      renderPreview({ ...selected, adjustments: deepClone(clipboardAdj) });
      showToast("設定ペースト");
    }
  }, [clipboardAdj, selected, multiSelect, updatePhoto, renderPreview, showToast]);

  const savePreset = useCallback(() => {
    if (!selected) return;
    const name = prompt("プリセット名:");
    if (!name) return;
    setPresets((prev) => [...prev, { id: uid(), name, adjustments: deepClone(selected.adjustments) }]);
    showToast(`プリセット「${name}」保存`);
  }, [selected, showToast]);

  const applyPreset = useCallback((preset) => {
    if (!selected) return;
    const adj = deepClone(preset.adjustments);
    updatePhoto(selected.id, { adjustments: adj });
    history.push({ photoId: selected.id, adjustments: adj });
    renderPreview({ ...selected, adjustments: adj });
    showToast(`「${preset.name}」適用`);
  }, [selected, updatePhoto, renderPreview, history, showToast]);

  const exportPhoto = useCallback(async (opts = {}) => {
    if (!selected) return;
    const img = await loadImage(selected);
    const adj = selected.adjustments;
    const rot = adj.rotation || 0;
    const isRotated90 = rot === 90 || rot === -90 || rot === 270;

    // Determine source dimensions after rotation
    let srcW = isRotated90 ? img.height : img.width;
    let srcH = isRotated90 ? img.width : img.height;

    // Apply crop
    const crop = adj.crop;
    let cropX = 0, cropY = 0, cropW = srcW, cropH = srcH;
    if (crop) {
      cropX = Math.round(crop.x * srcW);
      cropY = Math.round(crop.y * srcH);
      cropW = Math.round(crop.w * srcW);
      cropH = Math.round(crop.h * srcH);
    }

    // Target size
    const targetW = opts.width || cropW;
    const targetH = opts.height || cropH;
    const format = opts.format || "jpeg";
    const quality = opts.quality || 0.92;

    // Step 1: Render full size with rotation
    const fullCanvas = document.createElement("canvas");
    fullCanvas.width = srcW; fullCanvas.height = srcH;
    const fctx = fullCanvas.getContext("2d", { willReadFrequently: true });
    if (rot !== 0) {
      fctx.save();
      fctx.translate(srcW / 2, srcH / 2);
      fctx.rotate((rot * Math.PI) / 180);
      const dw = isRotated90 ? srcH : srcW;
      const dh = isRotated90 ? srcW : srcH;
      fctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
      fctx.restore();
      // Apply adjustments to rotated image
      const tempImg = new Image();
      await new Promise((res) => { tempImg.onload = res; tempImg.src = fullCanvas.toDataURL(); });
      applyAdjustments(fctx, tempImg, adj, srcW, srcH);
    } else {
      applyAdjustments(fctx, img, adj, srcW, srcH);
    }

    // Step 2: Crop
    const cropCanvas = document.createElement("canvas");
    cropCanvas.width = targetW; cropCanvas.height = targetH;
    const cctx = cropCanvas.getContext("2d");
    cctx.drawImage(fullCanvas, cropX, cropY, cropW, cropH, 0, 0, targetW, targetH);

    // Step 3: Export
    const mimeType = format === "png" ? "image/png" : format === "webp" ? "image/webp" : "image/jpeg";
    const ext = format === "png" ? ".png" : format === "webp" ? ".webp" : ".jpg";
    cropCanvas.toBlob((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      const baseName = selected.name.replace(/\.[^.]+$/, "");
      a.download = `${baseName}_edited${ext}`;
      a.click();
      URL.revokeObjectURL(a.href);
      showToast(`${targetW}×${targetH} ${format.toUpperCase()} でエクスポート`);
    }, mimeType, format === "png" ? undefined : quality);
    setShowExportDialog(false);
  }, [selected, loadImage, showToast]);

  const filteredPhotos = useMemo(() => {
    let list = photos.filter((p) => {
      if (filterRating > 0 && p.rating < filterRating) return false;
      if (filterFlag !== "all" && p.flag !== filterFlag) return false;
      if (searchQuery && !p.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      return true;
    });
    if (sortBy === "name") list.sort((a, b) => a.name.localeCompare(b.name));
    else if (sortBy === "rating") list.sort((a, b) => b.rating - a.rating);
    else list.sort((a, b) => a.importedAt - b.importedAt);
    return list;
  }, [photos, filterRating, filterFlag, searchQuery, sortBy]);

  const toggleMultiSelect = useCallback((id, e) => {
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      setMultiSelect((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
    } else { setMultiSelect(new Set()); setSelectedId(id); }
  }, []);

  useEffect(() => {
    if (selected && mode === "develop") history.push({ photoId: selected.id, adjustments: deepClone(selected.adjustments) });
  }, [selectedId, mode]);

  useEffect(() => {
    const handler = (e) => {
      if (e.key === "\\") { setShowBefore((v) => !v); e.preventDefault(); }
      if (e.key === "Escape" && mode === "develop") setMode("library");
      if (e.key === "r" && !e.metaKey && !e.ctrlKey && mode === "develop") resetAdj();
      if (e.key >= "0" && e.key <= "5" && selected && !e.metaKey) updatePhoto(selected.id, { rating: parseInt(e.key) });
      if (e.key === "p" && !e.metaKey && !e.ctrlKey && selected) updatePhoto(selected.id, { flag: selected.flag === "pick" ? "none" : "pick" });
      if (e.key === "x" && !e.metaKey && !e.ctrlKey && selected) updatePhoto(selected.id, { flag: selected.flag === "reject" ? "none" : "reject" });
      if (e.key === "ArrowRight" && selected) { const idx = filteredPhotos.findIndex((p) => p.id === selected.id); if (idx < filteredPhotos.length - 1) setSelectedId(filteredPhotos[idx + 1].id); }
      if (e.key === "ArrowLeft" && selected) { const idx = filteredPhotos.findIndex((p) => p.id === selected.id); if (idx > 0) setSelectedId(filteredPhotos[idx - 1].id); }
      if (e.key === "Enter" && mode === "library" && selected) setMode("develop");
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) { doUndo(); e.preventDefault(); }
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && e.shiftKey) { doRedo(); e.preventDefault(); }
      if ((e.metaKey || e.ctrlKey) && e.key === "y") { doRedo(); e.preventDefault(); }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "c") { copyAdj(); e.preventDefault(); }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "v") { pasteAdj(); e.preventDefault(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [mode, selected, filteredPhotos, resetAdj, updatePhoto, doUndo, doRedo, copyAdj, pasteAdj]);

  const onDrop = useCallback((e) => { e.preventDefault(); setDragOver(false); importFiles(e.dataTransfer.files); }, [importFiles]);
  const adj = selected?.adjustments || deepClone(DEFAULT_ADJ);
  const C = { bg: "#1a1a1a", panel: "#222", panelBorder: "#2d2d2d", toolbar: "#181818", accent: "#68b5ff", text: "#ccc", textDim: "#777", pick: "#4ade80", reject: "#f87171" };
  const curveKey = { master: "toneCurve", red: "toneCurveR", green: "toneCurveG", blue: "toneCurveB" }[curveChannel];
  const curveColor = { master: "#ccc", red: "#ff6b6b", green: "#69db7c", blue: "#74c0fc" }[curveChannel];

  return (
    <div style={{ width: "100%", height: "100vh", background: C.bg, color: C.text, fontFamily: "'SF Pro Display', -apple-system, 'Segoe UI', sans-serif", fontSize: 13, display: "flex", flexDirection: "column", overflow: "hidden", userSelect: "none" }}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>

      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", height: 42, padding: "0 16px", background: C.toolbar, borderBottom: `1px solid ${C.panelBorder}`, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: -0.5, color: "#fff" }}>
            <span style={{ color: C.accent }}>◉</span> Photo Studio
          </span>
          <div style={{ width: 1, height: 20, background: "#333" }} />
          <input type="file" ref={fileInputRef} multiple accept="image/*" style={{ display: "none" }} onChange={(e) => importFiles(e.target.files)} />
          <button onClick={() => fileInputRef.current?.click()} style={btn(C)}>+ インポート</button>
        </div>
        <div style={{ display: "flex", gap: 2 }}>
          {["library", "develop"].map((m) => (
            <button key={m} onClick={() => setMode(m)}
              style={{ ...btn(C), background: mode === m ? C.accent : "transparent", color: mode === m ? "#111" : C.textDim, fontWeight: mode === m ? 600 : 400 }}>
              {m === "library" ? "ライブラリ" : "現像"}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {mode === "develop" && selected && (
            <>
              <button onClick={doUndo} style={{ ...btn(C), fontSize: 14, opacity: history.canUndo() ? 1 : 0.3 }} title="Ctrl+Z">↩</button>
              <button onClick={doRedo} style={{ ...btn(C), fontSize: 14, opacity: history.canRedo() ? 1 : 0.3 }} title="Ctrl+Shift+Z">↪</button>
              <div style={{ width: 1, height: 16, background: "#333" }} />
              <button onClick={() => setShowBefore((v) => !v)} style={{ ...btn(C), background: showBefore ? "#555" : "transparent", fontSize: 11 }}>{showBefore ? "BEFORE" : "B/A"}</button>
              <button onClick={copyAdj} style={{ ...btn(C), fontSize: 11 }}>コピー</button>
              <button onClick={pasteAdj} style={{ ...btn(C), fontSize: 11, opacity: clipboardAdj ? 1 : 0.3 }}>ペースト</button>
              <button onClick={() => setCropMode(!cropMode)}
                style={{ ...btn(C), fontSize: 11, background: cropMode ? "#f59e0b" : "transparent", color: cropMode ? "#111" : C.text }}>
                {cropMode ? "✓ 切抜" : "切抜"}
              </button>
              <button onClick={() => setShowExportDialog(true)} style={{ ...btn(C), background: C.accent, color: "#111", fontWeight: 600 }}>エクスポート</button>
            </>
          )}
          {mode === "library" && multiSelect.size > 0 && (
            <>
              <span style={{ fontSize: 10, color: C.accent }}>{multiSelect.size} 枚選択</span>
              <button onClick={pasteAdj} style={{ ...btn(C), fontSize: 11, opacity: clipboardAdj ? 1 : 0.3 }}>一括ペースト</button>
              <button onClick={() => setMultiSelect(new Set())} style={{ ...btn(C), fontSize: 11 }}>解除</button>
            </>
          )}
          <span style={{ fontSize: 10, color: C.textDim }}>{photos.length} 枚</span>
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Left sidebar */}
        {mode === "library" && (
          <div style={{ width: 200, background: C.panel, borderRight: `1px solid ${C.panelBorder}`, padding: 12, flexShrink: 0, overflowY: "auto" }}>
            <Section title="検索">
              <input type="text" placeholder="ファイル名..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                style={{ width: "100%", background: "#2a2a2a", border: "1px solid #3a3a3a", borderRadius: 4, padding: "5px 8px", color: "#ccc", fontSize: 11, outline: "none" }} />
            </Section>
            <Section title="ソート">
              <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                {[{ key: "imported", label: "取込順" }, { key: "name", label: "名前" }, { key: "rating", label: "★順" }].map((s) => (
                  <button key={s.key} onClick={() => setSortBy(s.key)}
                    style={{ ...btn(C), padding: "2px 7px", fontSize: 10, background: sortBy === s.key ? C.accent : "#333", color: sortBy === s.key ? "#111" : C.textDim }}>{s.label}</button>
                ))}
              </div>
            </Section>
            <Section title="フィルター">
              <div style={{ fontSize: 11, color: C.textDim, marginBottom: 4 }}>レーティング</div>
              <div style={{ display: "flex", gap: 3, marginBottom: 8, flexWrap: "wrap" }}>
                {[0, 1, 2, 3, 4, 5].map((r) => (
                  <button key={r} onClick={() => setFilterRating(r)}
                    style={{ ...btn(C), padding: "2px 6px", fontSize: 10, background: filterRating === r ? C.accent : "#333", color: filterRating === r ? "#111" : C.textDim }}>{r === 0 ? "全て" : `${r}★+`}</button>
                ))}
              </div>
              <div style={{ fontSize: 11, color: C.textDim, marginBottom: 4 }}>フラグ</div>
              <div style={{ display: "flex", gap: 3 }}>
                {[{ key: "all", label: "全て" }, { key: "pick", label: "採用" }, { key: "reject", label: "不採用" }].map((f) => (
                  <button key={f.key} onClick={() => setFilterFlag(f.key)}
                    style={{ ...btn(C), padding: "2px 7px", fontSize: 10, background: filterFlag === f.key ? C.accent : "#333", color: filterFlag === f.key ? "#111" : C.textDim }}>{f.label}</button>
                ))}
              </div>
            </Section>
            <Section title="ショートカット" defaultOpen={false}>
              <div style={{ fontSize: 10, color: C.textDim, lineHeight: 1.8 }}>
                {[["0-5", "レーティング"], ["P", "採用"], ["X", "不採用"], ["←→", "写真送り"], ["Enter", "現像へ"], ["Esc", "ライブラリ"],
                  ["\\", "Before/After"], ["R", "リセット"], ["⌘Z", "元に戻す"], ["⌘⇧Z", "やり直し"], ["⌘⇧C", "設定コピー"], ["⌘⇧V", "設定ペースト"], ["Shift+Click", "複数選択"]
                ].map(([k, v]) => <div key={k}><kbd style={kbdS}>{k}</kbd> {v}</div>)}
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
                  <div style={{ fontSize: 15, fontWeight: 500 }}>{photos.length === 0 ? "写真をドラッグ＆ドロップ" : "条件に一致する写真がありません"}</div>
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 8 }}>
                  {filteredPhotos.map((photo) => {
                    const isSel = photo.id === selectedId, isMulti = multiSelect.has(photo.id);
                    const edited = Object.keys(DEFAULT_ADJ).some((k) => JSON.stringify(photo.adjustments[k]) !== JSON.stringify(DEFAULT_ADJ[k]));
                    return (
                      <div key={photo.id} onClick={(e) => toggleMultiSelect(photo.id, e)}
                        onDoubleClick={() => { setSelectedId(photo.id); setMode("develop"); }}
                        style={{ position: "relative", borderRadius: 6, overflow: "hidden", cursor: "pointer", border: `2px solid ${isMulti ? "#f59e0b" : isSel ? C.accent : "transparent"}`, background: "#111" }}>
                        <img src={photo.thumbUrl} alt={photo.name} style={{ width: "100%", aspectRatio: "3/2", objectFit: "cover", display: "block" }} loading="lazy" />
                        {photo.flag !== "none" && <div style={{ position: "absolute", top: 6, left: 6, width: 10, height: 10, borderRadius: "50%", background: photo.flag === "pick" ? C.pick : C.reject }} />}
                        {isMulti && <div style={{ position: "absolute", top: 6, right: 6, width: 16, height: 16, borderRadius: "50%", background: "#f59e0b", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#111", fontWeight: 700 }}>✓</div>}
                        {edited && !isMulti && <div style={{ position: "absolute", top: 6, right: 6, fontSize: 9, background: "rgba(0,0,0,0.6)", color: C.accent, padding: "1px 5px", borderRadius: 3 }}>編集済</div>}
                        <div style={{ padding: "5px 6px", background: "rgba(0,0,0,0.7)" }}>
                          <div style={{ fontSize: 10, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginBottom: 2, color: "#bbb" }}>{photo.name}</div>
                          <StarRating value={photo.rating} onChange={(r) => updatePhoto(photo.id, { rating: r })} size={11} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: "#111", position: "relative" }}>
              {selected ? (
                <div style={{ position: "relative", display: "inline-block" }}>
                  <canvas ref={canvasRef} style={{ maxWidth: "100%", maxHeight: "100%", display: "block" }} />
                  {cropMode && (
                    <CropOverlay
                      imgW={selected.width} imgH={selected.height}
                      crop={adj.crop || { x: 0, y: 0, w: 1, h: 1 }}
                      rotation={adj.rotation || 0}
                      onChange={(c) => updateAdj("crop", c)}
                      onRotate={(deg) => {
                        const r = ((adj.rotation || 0) + deg + 360) % 360;
                        updateAdj("rotation", r);
                      }}
                      canvasRect={canvasRef.current?.getBoundingClientRect() || { left: 0, top: 0, width: 1, height: 1 }}
                    />
                  )}
                  {showBefore && <div style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", background: "rgba(0,0,0,0.7)", color: "#fff", fontSize: 11, padding: "3px 10px", borderRadius: 4, pointerEvents: "none" }}>BEFORE</div>}
                </div>
              ) : <div style={{ color: C.textDim }}>写真を選択してください</div>}
            </div>
          )}

          {mode === "develop" && photos.length > 1 && (
            <div style={{ height: 72, background: C.toolbar, borderTop: `1px solid ${C.panelBorder}`, display: "flex", alignItems: "center", padding: "0 8px", gap: 4, overflowX: "auto", flexShrink: 0 }}>
              {filteredPhotos.map((photo) => (
                <img key={photo.id} src={photo.thumbUrl} alt={photo.name} onClick={() => setSelectedId(photo.id)}
                  style={{ height: 56, width: 80, objectFit: "cover", borderRadius: 3, cursor: "pointer", border: `2px solid ${photo.id === selectedId ? C.accent : "transparent"}`, opacity: photo.id === selectedId ? 1 : 0.6, flexShrink: 0 }} />
              ))}
            </div>
          )}
        </div>

        {/* Right Panel - Develop */}
        {mode === "develop" && selected && (
          <div style={{ width: 270, background: C.panel, borderLeft: `1px solid ${C.panelBorder}`, overflowY: "auto", padding: "10px 14px", flexShrink: 0 }}>
            <Section title="ヒストグラム"><Histogram data={histData} /></Section>

            <Section title="情報" defaultOpen={false}>
              <div style={{ fontSize: 10, color: C.textDim, lineHeight: 1.8 }}>
                <div>{selected.name}</div><div>{selected.width} × {selected.height}</div><div>{(selected.size / 1024 / 1024).toFixed(1)} MB</div>
              </div>
            </Section>

            <Section title="評価">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <StarRating value={selected.rating} onChange={(r) => updatePhoto(selected.id, { rating: r })} />
                <div style={{ display: "flex", gap: 4 }}>
                  <button onClick={() => updatePhoto(selected.id, { flag: selected.flag === "pick" ? "none" : "pick" })}
                    style={{ ...btn(C), padding: "2px 8px", fontSize: 10, background: selected.flag === "pick" ? C.pick : "#333", color: selected.flag === "pick" ? "#111" : C.textDim }}>採用</button>
                  <button onClick={() => updatePhoto(selected.id, { flag: selected.flag === "reject" ? "none" : "reject" })}
                    style={{ ...btn(C), padding: "2px 8px", fontSize: 10, background: selected.flag === "reject" ? C.reject : "#333", color: selected.flag === "reject" ? "#111" : C.textDim }}>不採用</button>
                </div>
              </div>
            </Section>

            <Section title="プリセット" defaultOpen={presets.length > 0}>
              <PresetBar presets={presets} onApply={applyPreset} onSave={savePreset} onDelete={(id) => setPresets((p) => p.filter((x) => x.id !== id))} />
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
                {[{ key: "master", label: "RGB", color: "#ccc" }, { key: "red", label: "R", color: "#ff6b6b" }, { key: "green", label: "G", color: "#69db7c" }, { key: "blue", label: "B", color: "#74c0fc" }].map((ch) => (
                  <button key={ch.key} onClick={() => setCurveChannel(ch.key)}
                    style={{ flex: 1, border: "none", borderRadius: 3, padding: "3px 0", fontSize: 10, cursor: "pointer",
                      background: curveChannel === ch.key ? ch.color : "#333", color: curveChannel === ch.key ? "#111" : "#888", fontWeight: curveChannel === ch.key ? 700 : 400 }}>{ch.label}</button>
                ))}
              </div>
              <CurveEditor points={adj[curveKey] || DEFAULT_CURVE} color={curveColor} onChange={(pts) => updateAdj(curveKey, pts)} />
              <button onClick={() => updateAdj(curveKey, deepClone(DEFAULT_CURVE))}
                style={{ ...btn(C), fontSize: 10, color: "#666", marginTop: 4, padding: "2px 6px" }}>カーブリセット</button>
            </Section>

            <Section title="HSL / カラー">
              <HSLPanel hsl={adj.hsl || DEFAULT_HSL()} onChange={(v) => updateAdj("hsl", v)} />
            </Section>

            <Section title="効果">
              <Slider label="明瞭度" value={adj.clarity} min={-100} max={100} onChange={(v) => updateAdj("clarity", v)} />
              <Slider label="かすみの除去" value={adj.dehaze} min={-100} max={100} onChange={(v) => updateAdj("dehaze", v)} />
            </Section>

            <Section title="ビネット" defaultOpen={false}>
              <Slider label="適用量" value={adj.vignette} min={-100} max={100} onChange={(v) => updateAdj("vignette", v)} />
              <Slider label="ぼかし" value={adj.vignetteFeather} min={0} max={100} onChange={(v) => updateAdj("vignetteFeather", v)} />
            </Section>

            <Section title="粒子" defaultOpen={false}>
              <Slider label="適用量" value={adj.grain} min={0} max={100} onChange={(v) => updateAdj("grain", v)} />
              <Slider label="サイズ" value={adj.grainSize} min={0} max={100} onChange={(v) => updateAdj("grainSize", v)} />
            </Section>

            <Section title="スプリットトーニング" defaultOpen={false}>
              <div style={{ fontSize: 10, color: "#aaa", marginBottom: 4 }}>ハイライト</div>
              <HuePicker value={adj.splitHighHue} saturation={adj.splitHighSat} onChange={(v) => updateAdj("splitHighHue", v)} />
              <Slider label="彩度" value={adj.splitHighSat} min={0} max={100} onChange={(v) => updateAdj("splitHighSat", v)} />
              <div style={{ fontSize: 10, color: "#aaa", marginBottom: 4, marginTop: 6 }}>シャドウ</div>
              <HuePicker value={adj.splitShadHue} saturation={adj.splitShadSat} onChange={(v) => updateAdj("splitShadHue", v)} />
              <Slider label="彩度" value={adj.splitShadSat} min={0} max={100} onChange={(v) => updateAdj("splitShadSat", v)} />
              <Slider label="バランス" value={adj.splitBalance} min={-100} max={100} onChange={(v) => updateAdj("splitBalance", v)} />
            </Section>

            <Section title="変形" defaultOpen={false}>
              <Slider label="回転" value={adj.rotation || 0} min={-180} max={180} step={1} onChange={(v) => updateAdj("rotation", v)} />
              <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                {[0, 90, 180, 270].map((r) => (
                  <button key={r} onClick={() => updateAdj("rotation", r)}
                    style={{ flex: 1, border: "1px solid #444", borderRadius: 3, padding: "3px 0", fontSize: 10, cursor: "pointer",
                      background: (adj.rotation || 0) === r ? "#68b5ff" : "#333", color: (adj.rotation || 0) === r ? "#111" : "#888" }}>
                    {r}°
                  </button>
                ))}
              </div>
            </Section>

            <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
              <button onClick={() => {
                if (!histData) return;
                let total = 0, sum = 0;
                for (let i = 0; i < 256; i++) { total += histData.lum[i]; sum += histData.lum[i] * i; }
                const avg = sum / total / 255;
                const newAdj = { ...deepClone(selected.adjustments), exposure: Math.round(clamp((0.45 - avg) * 3, -3, 3) * 100) / 100, contrast: 10, vibrance: 15, shadows: 20, highlights: -10 };
                updatePhoto(selected.id, { adjustments: newAdj });
                history.push({ photoId: selected.id, adjustments: newAdj });
                renderPreview({ ...selected, adjustments: newAdj });
              }} style={{ ...btn(C), flex: 1, background: "#333", textAlign: "center", padding: "6px 0", fontSize: 11 }}>自動補正</button>
              <button onClick={resetAdj} style={{ ...btn(C), flex: 1, background: "#333", textAlign: "center", padding: "6px 0", fontSize: 11 }}>リセット</button>
            </div>
          </div>
        )}

        {/* Right sidebar - Library */}
        {mode === "library" && selected && (
          <div style={{ width: 220, background: C.panel, borderLeft: `1px solid ${C.panelBorder}`, padding: "10px 14px", flexShrink: 0, overflowY: "auto" }}>
            <img src={selected.thumbUrl} alt={selected.name} style={{ width: "100%", borderRadius: 4, objectFit: "cover", aspectRatio: "3/2", marginBottom: 10 }} />
            <Section title="情報">
              <div style={{ fontSize: 10, color: C.textDim, lineHeight: 2 }}>
                <div style={{ color: "#ccc", fontWeight: 500 }}>{selected.name}</div>
                <div>{selected.width} × {selected.height} px</div>
                <div>{(selected.size / 1024 / 1024).toFixed(1)} MB</div>
              </div>
            </Section>
            <Section title="評価">
              <StarRating value={selected.rating} onChange={(r) => updatePhoto(selected.id, { rating: r })} />
              <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
                <button onClick={() => updatePhoto(selected.id, { flag: selected.flag === "pick" ? "none" : "pick" })}
                  style={{ ...btn(C), padding: "2px 8px", fontSize: 10, background: selected.flag === "pick" ? C.pick : "#333", color: selected.flag === "pick" ? "#111" : C.textDim }}>採用</button>
                <button onClick={() => updatePhoto(selected.id, { flag: selected.flag === "reject" ? "none" : "reject" })}
                  style={{ ...btn(C), padding: "2px 8px", fontSize: 10, background: selected.flag === "reject" ? C.reject : "#333", color: selected.flag === "reject" ? "#111" : C.textDim }}>不採用</button>
              </div>
            </Section>
          </div>
        )}
      </div>

      {/* Export Dialog */}
      {showExportDialog && selected && (
        <ExportDialog photo={selected} onExport={exportPhoto} onClose={() => setShowExportDialog(false)} />
      )}

      {/* Toast */}
      {toast && <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "rgba(0,0,0,0.85)", color: "#fff", fontSize: 12, padding: "8px 20px", borderRadius: 8, zIndex: 1000, pointerEvents: "none" }}>{toast}</div>}

      {/* Drag overlay */}
      {dragOver && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(104,181,255,0.08)", border: "3px dashed rgba(104,181,255,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999, pointerEvents: "none" }}>
          <div style={{ background: "rgba(0,0,0,0.8)", padding: "24px 40px", borderRadius: 12, fontSize: 16, color: C.accent, fontWeight: 600 }}>写真をドロップしてインポート</div>
        </div>
      )}
    </div>
  );
}

function btn(C) {
  return { background: "transparent", border: "none", color: C.text, fontSize: 12, padding: "4px 10px", borderRadius: 4, cursor: "pointer", whiteSpace: "nowrap" };
}
const kbdS = { display: "inline-block", background: "#333", padding: "1px 5px", borderRadius: 3, fontSize: 9, marginRight: 4, border: "1px solid #444", fontFamily: "monospace" };
