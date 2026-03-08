import { useState, useRef, useEffect, useCallback, useMemo } from "react";

/* ────────────────────────────────────────────
   Lightroom-style Photo Studio — MVP
   Browser-based non-destructive photo editor
   ──────────────────────────────────────────── */

// ── Utility helpers ──
const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
const uid = () => crypto.randomUUID?.() || Math.random().toString(36).slice(2);

const DEFAULT_ADJ = {
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  temperature: 0,
  tint: 0,
  saturation: 0,
  vibrance: 0,
  clarity: 0,
  dehaze: 0,
  sharpness: 0,
};

// ── Image processing on Canvas 2D ──
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
  const sharp = adj.sharpness / 100;

  for (let i = 0; i < d.length; i += 4) {
    let r = d[i] / 255;
    let g = d[i + 1] / 255;
    let b = d[i + 2] / 255;

    // Exposure
    r *= exp; g *= exp; b *= exp;

    // Temperature & Tint
    r += temp * 0.08;
    b -= temp * 0.08;
    g += tintV * 0.05;

    // Luminance for masks
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    // Highlights & Shadows
    const hlMask = smoothstep(0.5, 1.0, lum);
    const shMask = 1 - smoothstep(0.0, 0.5, lum);
    r += hl * hlMask + sh * shMask;
    g += hl * hlMask + sh * shMask;
    b += hl * hlMask + sh * shMask;

    // Whites & Blacks
    const whMask = smoothstep(0.75, 1.0, lum);
    const blMask = 1 - smoothstep(0.0, 0.25, lum);
    r += wh * whMask - bl * blMask;
    g += wh * whMask - bl * blMask;
    b += wh * whMask - bl * blMask;

    // Contrast
    r = (r - 0.5) * (1 + con) + 0.5;
    g = (g - 0.5) * (1 + con) + 0.5;
    b = (b - 0.5) * (1 + con) + 0.5;

    // Clarity (local contrast approximation)
    if (clar !== 0) {
      const mid = smoothstep(0.15, 0.85, lum) * (1 - smoothstep(0.15, 0.85, lum)) * 4;
      r += clar * mid * (r - lum) * 0.5;
      g += clar * mid * (g - lum) * 0.5;
      b += clar * mid * (b - lum) * 0.5;
    }

    // Dehaze
    if (dehaze !== 0) {
      r = r + dehaze * (r - 0.1);
      g = g + dehaze * (g - 0.1);
      b = b + dehaze * (b - 0.1);
    }

    // Saturation
    const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = gray + (r - gray) * sat;
    g = gray + (g - gray) * sat;
    b = gray + (b - gray) * sat;

    // Vibrance (boost less-saturated colors more)
    if (vib !== 0) {
      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const cSat = maxC === 0 ? 0 : (maxC - minC) / maxC;
      const vibBoost = 1 + vib * (1 - cSat);
      const g2 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = g2 + (r - g2) * vibBoost;
      g = g2 + (g - g2) * vibBoost;
      b = g2 + (b - g2) * vibBoost;
    }

    d[i] = clamp(r * 255, 0, 255);
    d[i + 1] = clamp(g * 255, 0, 255);
    d[i + 2] = clamp(b * 255, 0, 255);
  }

  ctx.putImageData(imageData, 0, 0);
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// ── Histogram computation ──
function computeHistogram(ctx, w, h) {
  const imageData = ctx.getImageData(0, 0, w, h);
  const d = imageData.data;
  const rH = new Uint32Array(256);
  const gH = new Uint32Array(256);
  const bH = new Uint32Array(256);
  const lumH = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    rH[d[i]]++;
    gH[d[i + 1]]++;
    bH[d[i + 2]]++;
    const l = Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
    lumH[clamp(l, 0, 255)]++;
  }
  return { r: rH, g: gH, b: bH, lum: lumH };
}

// ── Histogram mini-component ──
function Histogram({ data, width = 220, height = 60 }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    if (!data || !canvasRef.current) return;
    const ctx = canvasRef.current.getContext("2d");
    const W = width;
    const H = height;
    ctx.clearRect(0, 0, W, H);

    const maxVal = Math.max(
      ...Array.from(data.lum).slice(1, 254),
      ...Array.from(data.r).slice(1, 254),
      ...Array.from(data.g).slice(1, 254),
      ...Array.from(data.b).slice(1, 254)
    ) || 1;

    const drawChannel = (ch, color) => {
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let i = 0; i < 256; i++) {
        const x = (i / 255) * W;
        const y = H - (ch[i] / maxVal) * H;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    };

    ctx.globalCompositeOperation = "source-over";
    drawChannel(data.lum, "rgba(180,180,180,0.3)");
    ctx.globalCompositeOperation = "screen";
    drawChannel(data.r, "rgba(220,60,60,0.45)");
    drawChannel(data.g, "rgba(60,180,60,0.45)");
    drawChannel(data.b, "rgba(60,80,220,0.45)");
  }, [data, width, height]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{ width: "100%", height, borderRadius: 4, background: "#111" }}
    />
  );
}

// ── Slider component ──
function Slider({ label, value, min, max, step = 1, onChange, unit = "" }) {
  const pct = ((value - min) / (max - min)) * 100;
  const isZeroCenter = min < 0;
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#aaa", marginBottom: 2 }}>
        <span>{label}</span>
        <span style={{ color: value !== 0 ? "#68b5ff" : "#666", fontVariantNumeric: "tabular-nums" }}>
          {value > 0 ? "+" : ""}{value}{unit}
        </span>
      </div>
      <div style={{ position: "relative", height: 14, display: "flex", alignItems: "center" }}>
        <div style={{ position: "absolute", left: 0, right: 0, height: 3, background: "#333", borderRadius: 2 }} />
        {isZeroCenter && (
          <div style={{ position: "absolute", left: "50%", width: 1, height: 7, background: "#555", top: 3.5 }} />
        )}
        <div
          style={{
            position: "absolute",
            left: isZeroCenter ? `${Math.min(50, pct)}%` : 0,
            width: isZeroCenter ? `${Math.abs(pct - 50)}%` : `${pct}%`,
            height: 3,
            background: "#68b5ff",
            borderRadius: 2,
          }}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          onDoubleClick={() => onChange(0)}
          style={{
            position: "absolute",
            width: "100%",
            height: 14,
            opacity: 0,
            cursor: "pointer",
            margin: 0,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: `calc(${pct}% - 6px)`,
            width: 12,
            height: 12,
            borderRadius: "50%",
            background: "#ddd",
            border: "2px solid #68b5ff",
            pointerEvents: "none",
            transition: "left 0.05s",
          }}
        />
      </div>
    </div>
  );
}

// ── Star Rating ──
function StarRating({ value, onChange, size = 14 }) {
  return (
    <div style={{ display: "flex", gap: 1, cursor: "pointer" }}>
      {[1, 2, 3, 4, 5].map((s) => (
        <span
          key={s}
          onClick={(e) => { e.stopPropagation(); onChange(value === s ? 0 : s); }}
          style={{ fontSize: size, color: s <= value ? "#f5c842" : "#444", userSelect: "none" }}
        >
          ★
        </span>
      ))}
    </div>
  );
}

// ── Section collapsible ──
function Section({ title, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginBottom: 8 }}>
      <div
        onClick={() => setOpen(!open)}
        style={{
          display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
          padding: "6px 0", borderBottom: "1px solid #2a2a2a", userSelect: "none",
          fontSize: 11, fontWeight: 600, letterSpacing: 0.8, textTransform: "uppercase", color: "#888",
        }}
      >
        <span style={{ transform: open ? "rotate(90deg)" : "none", transition: "0.15s", fontSize: 9 }}>▶</span>
        {title}
      </div>
      {open && <div style={{ paddingTop: 8 }}>{children}</div>}
    </div>
  );
}

// ── Main App ──
export default function PhotoStudio() {
  const [photos, setPhotos] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState("library"); // library | develop
  const [showBefore, setShowBefore] = useState(false);
  const [histData, setHistData] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [filterRating, setFilterRating] = useState(0);
  const [filterFlag, setFilterFlag] = useState("all");

  const canvasRef = useRef(null);
  const imgCache = useRef({});
  const fileInputRef = useRef(null);

  const selected = useMemo(() => photos.find((p) => p.id === selectedId), [photos, selectedId]);

  // ── Load image into cache ──
  const loadImage = useCallback((photo) => {
    return new Promise((resolve) => {
      if (imgCache.current[photo.id]) return resolve(imgCache.current[photo.id]);
      const img = new Image();
      img.onload = () => {
        imgCache.current[photo.id] = img;
        resolve(img);
      };
      img.src = photo.dataUrl;
    });
  }, []);

  // ── Render preview ──
  const renderPreview = useCallback(
    async (photo, useOriginal = false) => {
      if (!photo || !canvasRef.current) return;
      const img = await loadImage(photo);
      const canvas = canvasRef.current;

      const maxW = canvas.parentElement?.clientWidth || 800;
      const maxH = canvas.parentElement?.clientHeight || 600;
      const scale = Math.min(maxW / img.width, maxH / img.height, 1);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      canvas.width = w;
      canvas.height = h;

      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (useOriginal) {
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
      } else {
        applyAdjustments(ctx, img, photo.adjustments, w, h);
      }
      setHistData(computeHistogram(ctx, w, h));
    },
    [loadImage]
  );

  useEffect(() => {
    if (mode === "develop" && selected) {
      renderPreview(selected, showBefore);
    }
  }, [mode, selected, showBefore, renderPreview]);

  // ── Import files ──
  const importFiles = useCallback((files) => {
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!imageFiles.length) return;

    const newPhotos = [];
    let loaded = 0;

    imageFiles.forEach((file) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          // Create thumbnail
          const thumbCanvas = document.createElement("canvas");
          const thumbSize = 300;
          const scale = Math.min(thumbSize / img.width, thumbSize / img.height);
          thumbCanvas.width = Math.round(img.width * scale);
          thumbCanvas.height = Math.round(img.height * scale);
          const tctx = thumbCanvas.getContext("2d");
          tctx.drawImage(img, 0, 0, thumbCanvas.width, thumbCanvas.height);

          newPhotos.push({
            id: uid(),
            name: file.name,
            size: file.size,
            width: img.width,
            height: img.height,
            dataUrl: e.target.result,
            thumbUrl: thumbCanvas.toDataURL("image/jpeg", 0.7),
            rating: 0,
            flag: "none",
            tags: [],
            adjustments: { ...DEFAULT_ADJ },
            importedAt: Date.now(),
          });

          loaded++;
          if (loaded === imageFiles.length) {
            setPhotos((prev) => {
              const updated = [...prev, ...newPhotos].sort((a, b) => a.importedAt - b.importedAt);
              if (!selectedId && updated.length > 0) {
                setSelectedId(updated[0].id);
              }
              return updated;
            });
          }
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }, [selectedId]);

  // ── Update photo property ──
  const updatePhoto = useCallback((id, updates) => {
    setPhotos((prev) =>
      prev.map((p) => (p.id === id ? { ...p, ...updates } : p))
    );
  }, []);

  // ── Update adjustment and re-render ──
  const updateAdj = useCallback(
    (key, value) => {
      if (!selected) return;
      const newAdj = { ...selected.adjustments, [key]: value };
      updatePhoto(selected.id, { adjustments: newAdj });
      // Immediate render
      if (canvasRef.current) {
        loadImage(selected).then((img) => {
          const canvas = canvasRef.current;
          if (!canvas) return;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          applyAdjustments(ctx, img, newAdj, canvas.width, canvas.height);
          setHistData(computeHistogram(ctx, canvas.width, canvas.height));
        });
      }
    },
    [selected, updatePhoto, loadImage]
  );

  // ── Reset adjustments ──
  const resetAdj = useCallback(() => {
    if (!selected) return;
    updatePhoto(selected.id, { adjustments: { ...DEFAULT_ADJ } });
    renderPreview({ ...selected, adjustments: { ...DEFAULT_ADJ } });
  }, [selected, updatePhoto, renderPreview]);

  // ── Export ──
  const exportPhoto = useCallback(async () => {
    if (!selected) return;
    const img = await loadImage(selected);
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = img.width;
    exportCanvas.height = img.height;
    const ctx = exportCanvas.getContext("2d", { willReadFrequently: true });
    applyAdjustments(ctx, img, selected.adjustments, img.width, img.height);

    exportCanvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `edited_${selected.name}`;
      a.click();
      URL.revokeObjectURL(url);
    }, "image/jpeg", 0.95);
  }, [selected, loadImage]);

  // ── Filtered photos ──
  const filteredPhotos = useMemo(() => {
    return photos.filter((p) => {
      if (filterRating > 0 && p.rating < filterRating) return false;
      if (filterFlag !== "all" && p.flag !== filterFlag) return false;
      return true;
    });
  }, [photos, filterRating, filterFlag]);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const handler = (e) => {
      if (e.key === "\\") { setShowBefore((v) => !v); e.preventDefault(); }
      if (e.key === "Escape" && mode === "develop") setMode("library");
      if (e.key === "r" && !e.metaKey && !e.ctrlKey && mode === "develop") resetAdj();
      if (e.key >= "0" && e.key <= "5" && selected && !e.metaKey) {
        updatePhoto(selected.id, { rating: parseInt(e.key) });
      }
      if (e.key === "p" && selected) updatePhoto(selected.id, { flag: selected.flag === "pick" ? "none" : "pick" });
      if (e.key === "x" && selected) updatePhoto(selected.id, { flag: selected.flag === "reject" ? "none" : "reject" });
      if (e.key === "ArrowRight" && selected) {
        const idx = filteredPhotos.findIndex((p) => p.id === selected.id);
        if (idx < filteredPhotos.length - 1) setSelectedId(filteredPhotos[idx + 1].id);
      }
      if (e.key === "ArrowLeft" && selected) {
        const idx = filteredPhotos.findIndex((p) => p.id === selected.id);
        if (idx > 0) setSelectedId(filteredPhotos[idx - 1].id);
      }
      if (e.key === "Enter" && mode === "library" && selected) setMode("develop");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [mode, selected, filteredPhotos, resetAdj, updatePhoto]);

  // ── Drop zone ──
  const onDrop = useCallback(
    (e) => {
      e.preventDefault();
      setDragOver(false);
      importFiles(e.dataTransfer.files);
    },
    [importFiles]
  );

  const adj = selected?.adjustments || DEFAULT_ADJ;
  const isEdited = selected && Object.keys(DEFAULT_ADJ).some((k) => selected.adjustments[k] !== 0);

  // ── Styles ──
  const COLORS = {
    bg: "#1a1a1a",
    panel: "#222",
    panelBorder: "#2d2d2d",
    toolbar: "#181818",
    accent: "#68b5ff",
    accentDim: "#3a7fcc",
    text: "#ccc",
    textDim: "#777",
    pick: "#4ade80",
    reject: "#f87171",
  };

  return (
    <div
      style={{
        width: "100%",
        height: "100vh",
        background: COLORS.bg,
        color: COLORS.text,
        fontFamily: "'SF Pro Display', -apple-system, 'Segoe UI', sans-serif",
        fontSize: 13,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        userSelect: "none",
      }}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {/* ── Toolbar ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: 42,
          padding: "0 16px",
          background: COLORS.toolbar,
          borderBottom: `1px solid ${COLORS.panelBorder}`,
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: -0.5, color: "#fff" }}>
            <span style={{ color: COLORS.accent }}>◉</span> Photo Studio
          </span>
          <div style={{ width: 1, height: 20, background: "#333" }} />
          <input
            type="file"
            ref={fileInputRef}
            multiple
            accept="image/*"
            style={{ display: "none" }}
            onChange={(e) => importFiles(e.target.files)}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            style={btnStyle(COLORS)}
          >
            + インポート
          </button>
        </div>

        <div style={{ display: "flex", gap: 2 }}>
          {["library", "develop"].map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                ...btnStyle(COLORS),
                background: mode === m ? COLORS.accent : "transparent",
                color: mode === m ? "#111" : COLORS.textDim,
                fontWeight: mode === m ? 600 : 400,
              }}
            >
              {m === "library" ? "ライブラリ" : "現像"}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {mode === "develop" && selected && (
            <>
              <button
                onClick={() => setShowBefore((v) => !v)}
                style={{
                  ...btnStyle(COLORS),
                  background: showBefore ? "#555" : "transparent",
                  fontSize: 11,
                }}
                title="Before/After (\\)"
              >
                {showBefore ? "BEFORE" : "B/A"}
              </button>
              <button onClick={resetAdj} style={{ ...btnStyle(COLORS), fontSize: 11 }} title="Reset (R)">
                リセット
              </button>
              <button
                onClick={exportPhoto}
                style={{
                  ...btnStyle(COLORS),
                  background: COLORS.accent,
                  color: "#111",
                  fontWeight: 600,
                }}
              >
                エクスポート
              </button>
            </>
          )}
          <span style={{ fontSize: 10, color: COLORS.textDim }}>{photos.length} 枚</span>
        </div>
      </div>

      {/* ── Main content ── */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* ── Left sidebar (library mode) ── */}
        {mode === "library" && (
          <div
            style={{
              width: 180,
              background: COLORS.panel,
              borderRight: `1px solid ${COLORS.panelBorder}`,
              padding: 12,
              flexShrink: 0,
              overflowY: "auto",
            }}
          >
            <Section title="フィルター">
              <div style={{ fontSize: 11, color: COLORS.textDim, marginBottom: 6 }}>レーティング</div>
              <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
                {[0, 1, 2, 3, 4, 5].map((r) => (
                  <button
                    key={r}
                    onClick={() => setFilterRating(r)}
                    style={{
                      ...btnStyle(COLORS),
                      padding: "2px 7px",
                      fontSize: 10,
                      background: filterRating === r ? COLORS.accent : "#333",
                      color: filterRating === r ? "#111" : COLORS.textDim,
                    }}
                  >
                    {r === 0 ? "全て" : `${r}★+`}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 11, color: COLORS.textDim, marginBottom: 6 }}>フラグ</div>
              <div style={{ display: "flex", gap: 4 }}>
                {[
                  { key: "all", label: "全て" },
                  { key: "pick", label: "採用" },
                  { key: "reject", label: "不採用" },
                ].map((f) => (
                  <button
                    key={f.key}
                    onClick={() => setFilterFlag(f.key)}
                    style={{
                      ...btnStyle(COLORS),
                      padding: "2px 7px",
                      fontSize: 10,
                      background: filterFlag === f.key ? COLORS.accent : "#333",
                      color: filterFlag === f.key ? "#111" : COLORS.textDim,
                    }}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </Section>
            <Section title="キーボード" defaultOpen={false}>
              <div style={{ fontSize: 10, color: COLORS.textDim, lineHeight: 1.8 }}>
                <div><kbd style={kbdStyle}>0-5</kbd> レーティング</div>
                <div><kbd style={kbdStyle}>P</kbd> 採用フラグ</div>
                <div><kbd style={kbdStyle}>X</kbd> 不採用フラグ</div>
                <div><kbd style={kbdStyle}>←→</kbd> 写真送り</div>
                <div><kbd style={kbdStyle}>Enter</kbd> 現像モード</div>
                <div><kbd style={kbdStyle}>Esc</kbd> ライブラリへ</div>
                <div><kbd style={kbdStyle}>\</kbd> Before/After</div>
                <div><kbd style={kbdStyle}>R</kbd> リセット</div>
                <div><kbd style={kbdStyle}>ダブルクリック</kbd> スライダーリセット</div>
              </div>
            </Section>
          </div>
        )}

        {/* ── Center: Library grid or Develop preview ── */}
        <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          {mode === "library" ? (
            <div
              style={{
                flex: 1,
                overflowY: "auto",
                padding: 12,
              }}
            >
              {filteredPhotos.length === 0 ? (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    height: "100%",
                    color: COLORS.textDim,
                    gap: 12,
                  }}
                >
                  <div style={{ fontSize: 48, opacity: 0.3 }}>📷</div>
                  <div style={{ fontSize: 15, fontWeight: 500 }}>
                    {photos.length === 0
                      ? "写真をドラッグ＆ドロップ、または「インポート」をクリック"
                      : "条件に一致する写真がありません"}
                  </div>
                  <div style={{ fontSize: 11 }}>JPEG, PNG, WebP に対応</div>
                </div>
              ) : (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
                    gap: 8,
                  }}
                >
                  {filteredPhotos.map((photo) => (
                    <div
                      key={photo.id}
                      onClick={() => setSelectedId(photo.id)}
                      onDoubleClick={() => {
                        setSelectedId(photo.id);
                        setMode("develop");
                      }}
                      style={{
                        position: "relative",
                        borderRadius: 6,
                        overflow: "hidden",
                        cursor: "pointer",
                        border: `2px solid ${photo.id === selectedId ? COLORS.accent : "transparent"}`,
                        transition: "border-color 0.15s",
                        background: "#111",
                      }}
                    >
                      <img
                        src={photo.thumbUrl}
                        alt={photo.name}
                        style={{
                          width: "100%",
                          aspectRatio: "3/2",
                          objectFit: "cover",
                          display: "block",
                        }}
                        loading="lazy"
                      />
                      {/* Flag indicator */}
                      {photo.flag !== "none" && (
                        <div
                          style={{
                            position: "absolute",
                            top: 6,
                            left: 6,
                            width: 10,
                            height: 10,
                            borderRadius: "50%",
                            background: photo.flag === "pick" ? COLORS.pick : COLORS.reject,
                          }}
                        />
                      )}
                      {/* Edited badge */}
                      {Object.keys(DEFAULT_ADJ).some((k) => photo.adjustments[k] !== 0) && (
                        <div
                          style={{
                            position: "absolute",
                            top: 6,
                            right: 6,
                            fontSize: 9,
                            background: "rgba(0,0,0,0.6)",
                            color: COLORS.accent,
                            padding: "1px 5px",
                            borderRadius: 3,
                          }}
                        >
                          編集済
                        </div>
                      )}
                      {/* Bottom info */}
                      <div
                        style={{
                          padding: "5px 6px",
                          background: "rgba(0,0,0,0.7)",
                          backdropFilter: "blur(4px)",
                        }}
                      >
                        <div
                          style={{
                            fontSize: 10,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            marginBottom: 2,
                            color: "#bbb",
                          }}
                        >
                          {photo.name}
                        </div>
                        <StarRating
                          value={photo.rating}
                          onChange={(r) => updatePhoto(photo.id, { rating: r })}
                          size={11}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            /* ── Develop mode: Canvas preview ── */
            <div
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "#111",
                position: "relative",
                overflow: "hidden",
              }}
            >
              {selected ? (
                <>
                  <canvas
                    ref={canvasRef}
                    style={{
                      maxWidth: "100%",
                      maxHeight: "100%",
                      objectFit: "contain",
                    }}
                  />
                  {showBefore && (
                    <div
                      style={{
                        position: "absolute",
                        top: 12,
                        left: "50%",
                        transform: "translateX(-50%)",
                        background: "rgba(0,0,0,0.7)",
                        color: "#fff",
                        fontSize: 11,
                        padding: "3px 10px",
                        borderRadius: 4,
                        pointerEvents: "none",
                      }}
                    >
                      BEFORE — "\\" で切替
                    </div>
                  )}
                </>
              ) : (
                <div style={{ color: COLORS.textDim }}>写真を選択してください</div>
              )}
            </div>
          )}

          {/* ── Filmstrip ── */}
          {mode === "develop" && photos.length > 1 && (
            <div
              style={{
                height: 72,
                background: COLORS.toolbar,
                borderTop: `1px solid ${COLORS.panelBorder}`,
                display: "flex",
                alignItems: "center",
                padding: "0 8px",
                gap: 4,
                overflowX: "auto",
                flexShrink: 0,
              }}
            >
              {filteredPhotos.map((photo) => (
                <img
                  key={photo.id}
                  src={photo.thumbUrl}
                  alt={photo.name}
                  onClick={() => setSelectedId(photo.id)}
                  style={{
                    height: 56,
                    width: 80,
                    objectFit: "cover",
                    borderRadius: 3,
                    cursor: "pointer",
                    border: `2px solid ${photo.id === selectedId ? COLORS.accent : "transparent"}`,
                    opacity: photo.id === selectedId ? 1 : 0.6,
                    flexShrink: 0,
                    transition: "opacity 0.15s, border-color 0.15s",
                  }}
                />
              ))}
            </div>
          )}
        </div>

        {/* ── Right sidebar ── */}
        {mode === "develop" && selected && (
          <div
            style={{
              width: 260,
              background: COLORS.panel,
              borderLeft: `1px solid ${COLORS.panelBorder}`,
              overflowY: "auto",
              padding: "10px 14px",
              flexShrink: 0,
            }}
          >
            {/* Histogram */}
            <Section title="ヒストグラム">
              <Histogram data={histData} />
            </Section>

            {/* Photo info */}
            <Section title="情報" defaultOpen={false}>
              <div style={{ fontSize: 10, color: COLORS.textDim, lineHeight: 1.8 }}>
                <div>{selected.name}</div>
                <div>{selected.width} × {selected.height}</div>
                <div>{(selected.size / 1024 / 1024).toFixed(1)} MB</div>
              </div>
            </Section>

            {/* Rating & Flag */}
            <Section title="評価">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <StarRating
                  value={selected.rating}
                  onChange={(r) => updatePhoto(selected.id, { rating: r })}
                />
                <div style={{ display: "flex", gap: 4 }}>
                  <button
                    onClick={() =>
                      updatePhoto(selected.id, {
                        flag: selected.flag === "pick" ? "none" : "pick",
                      })
                    }
                    style={{
                      ...btnStyle(COLORS),
                      padding: "2px 8px",
                      fontSize: 10,
                      background: selected.flag === "pick" ? COLORS.pick : "#333",
                      color: selected.flag === "pick" ? "#111" : COLORS.textDim,
                    }}
                  >
                    採用
                  </button>
                  <button
                    onClick={() =>
                      updatePhoto(selected.id, {
                        flag: selected.flag === "reject" ? "none" : "reject",
                      })
                    }
                    style={{
                      ...btnStyle(COLORS),
                      padding: "2px 8px",
                      fontSize: 10,
                      background: selected.flag === "reject" ? COLORS.reject : "#333",
                      color: selected.flag === "reject" ? "#111" : COLORS.textDim,
                    }}
                  >
                    不採用
                  </button>
                </div>
              </div>
            </Section>

            {/* ── Adjustment Sliders ── */}
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

            <Section title="効果">
              <Slider label="明瞭度" value={adj.clarity} min={-100} max={100} onChange={(v) => updateAdj("clarity", v)} />
              <Slider label="かすみの除去" value={adj.dehaze} min={-100} max={100} onChange={(v) => updateAdj("dehaze", v)} />
            </Section>

            {/* Auto adjustments */}
            <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
              <button
                onClick={() => {
                  // Simple auto-adjust based on histogram
                  if (!histData) return;
                  const lum = histData.lum;
                  let total = 0, sum = 0;
                  for (let i = 0; i < 256; i++) { total += lum[i]; sum += lum[i] * i; }
                  const avgBright = sum / total / 255;
                  const expAdj = (0.45 - avgBright) * 3;
                  const newAdj = {
                    ...selected.adjustments,
                    exposure: Math.round(clamp(expAdj, -3, 3) * 100) / 100,
                    contrast: 10,
                    vibrance: 15,
                    shadows: 20,
                    highlights: -10,
                  };
                  updatePhoto(selected.id, { adjustments: newAdj });
                  renderPreview({ ...selected, adjustments: newAdj });
                }}
                style={{
                  ...btnStyle(COLORS),
                  flex: 1,
                  background: "#333",
                  textAlign: "center",
                  padding: "6px 0",
                  fontSize: 11,
                }}
              >
                自動補正
              </button>
              <button
                onClick={resetAdj}
                style={{
                  ...btnStyle(COLORS),
                  flex: 1,
                  background: "#333",
                  textAlign: "center",
                  padding: "6px 0",
                  fontSize: 11,
                }}
              >
                リセット
              </button>
            </div>
          </div>
        )}

        {/* Right sidebar for library mode - metadata */}
        {mode === "library" && selected && (
          <div
            style={{
              width: 220,
              background: COLORS.panel,
              borderLeft: `1px solid ${COLORS.panelBorder}`,
              padding: "10px 14px",
              flexShrink: 0,
              overflowY: "auto",
            }}
          >
            <div style={{ marginBottom: 10 }}>
              <img
                src={selected.thumbUrl}
                alt={selected.name}
                style={{ width: "100%", borderRadius: 4, objectFit: "cover", aspectRatio: "3/2" }}
              />
            </div>
            <Section title="情報">
              <div style={{ fontSize: 10, color: COLORS.textDim, lineHeight: 2 }}>
                <div style={{ color: "#ccc", fontWeight: 500 }}>{selected.name}</div>
                <div>{selected.width} × {selected.height} px</div>
                <div>{(selected.size / 1024 / 1024).toFixed(1)} MB</div>
              </div>
            </Section>
            <Section title="評価">
              <StarRating
                value={selected.rating}
                onChange={(r) => updatePhoto(selected.id, { rating: r })}
              />
              <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
                <button
                  onClick={() => updatePhoto(selected.id, { flag: selected.flag === "pick" ? "none" : "pick" })}
                  style={{
                    ...btnStyle(COLORS),
                    padding: "2px 8px",
                    fontSize: 10,
                    background: selected.flag === "pick" ? COLORS.pick : "#333",
                    color: selected.flag === "pick" ? "#111" : COLORS.textDim,
                  }}
                >
                  採用
                </button>
                <button
                  onClick={() => updatePhoto(selected.id, { flag: selected.flag === "reject" ? "none" : "reject" })}
                  style={{
                    ...btnStyle(COLORS),
                    padding: "2px 8px",
                    fontSize: 10,
                    background: selected.flag === "reject" ? COLORS.reject : "#333",
                    color: selected.flag === "reject" ? "#111" : COLORS.textDim,
                  }}
                >
                  不採用
                </button>
              </div>
            </Section>
            {isEdited && (
              <div style={{ fontSize: 10, color: COLORS.accent, marginTop: 8 }}>
                ✎ この写真は編集されています
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Drag overlay ── */}
      {dragOver && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(104,181,255,0.08)",
            border: "3px dashed rgba(104,181,255,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 999,
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              background: "rgba(0,0,0,0.8)",
              padding: "24px 40px",
              borderRadius: 12,
              fontSize: 16,
              color: COLORS.accent,
              fontWeight: 600,
            }}
          >
            写真をドロップしてインポート
          </div>
        </div>
      )}
    </div>
  );
}

// ── Style helpers ──
function btnStyle(C) {
  return {
    background: "transparent",
    border: "none",
    color: C.text,
    fontSize: 12,
    padding: "4px 10px",
    borderRadius: 4,
    cursor: "pointer",
    transition: "background 0.15s",
    whiteSpace: "nowrap",
  };
}

const kbdStyle = {
  display: "inline-block",
  background: "#333",
  padding: "1px 5px",
  borderRadius: 3,
  fontSize: 9,
  marginRight: 4,
  border: "1px solid #444",
  fontFamily: "monospace",
};
