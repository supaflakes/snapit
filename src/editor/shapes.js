'use strict';

// Modèle, rendu et géométrie des annotations.
// Les positions sont en pixels de l'image ; les réglages de style (épaisseur, taille de police…)
// sont en pixels « logiques », multipliés par l'échelle de l'écran capturé (unit) au rendu.
const Shapes = (() => {
  const FONTS = [
    { name: 'Segoe UI', css: '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif' },
    { name: 'Arial', css: 'Arial, Helvetica, sans-serif' },
    { name: 'Georgia', css: 'Georgia, "Times New Roman", serif' },
    { name: 'Consolas', css: 'Consolas, "Cascadia Mono", monospace' },
    { name: 'Comic Sans MS', css: '"Comic Sans MS", "Comic Neue", cursive' },
    { name: 'Impact', css: 'Impact, "Arial Black", sans-serif' },
  ];

  const RED = '#e5484d';
  const stroke = { outline: null, outlineWidth: 2, shadow: true, opacity: 100 };

  // Réglages par défaut de chaque outil. Une annotation copie ces réglages à sa création.
  const DEFAULTS = {
    arrow: { color: RED, width: 5, heads: 'end', headStyle: 'filled', taper: true, dash: 'solid', ...stroke },
    line: { color: RED, width: 4, dash: 'solid', ...stroke },
    rect: { color: RED, width: 4, dash: 'solid', radius: 0, fill: null, fillOpacity: 25, ...stroke },
    ellipse: { color: RED, width: 4, dash: 'solid', fill: null, fillOpacity: 25, ...stroke },
    pen: { color: RED, width: 4, ...stroke },
    marker: { color: '#ffc53d', width: 20, opacity: 45 },
    text: { color: RED, fontFamily: 'Segoe UI', fontSize: 26, bold: true, italic: false, outline: '#ffffff', outlineWidth: 3, background: null, shadow: false },
    step: { color: RED, stepSize: 15, stepShape: 'circle', outline: '#ffffff', outlineWidth: 2, shadow: true },
    blur: { blurMode: 'pixelate', intensity: 10 },
  };

  const BOX_TYPES = new Set(['rect', 'ellipse', 'blur']);
  const SEGMENT_TYPES = new Set(['line', 'arrow']);
  const PATH_TYPES = new Set(['pen', 'marker']);

  let U = 1; // échelle de l'écran capturé
  let seq = 0;
  let scratch = null; // canvas de pixelisation
  let layer = null; // canvas intermédiaire pour l'opacité

  function luminance(hex) {
    const n = parseInt(hex.slice(1, 7), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  const isLight = (hex) => luminance(hex) > 0.45;

  function hexToRgba(hex, alpha) {
    const n = parseInt(hex.slice(1, 7), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  function normRect(s) {
    return {
      x: Math.min(s.x, s.x + s.w),
      y: Math.min(s.y, s.y + s.h),
      w: Math.abs(s.w),
      h: Math.abs(s.h),
    };
  }

  function create(tool, p, style) {
    const s = { id: ++seq, type: tool, ...structuredClone(style) };
    if (BOX_TYPES.has(tool)) Object.assign(s, { x: p.x, y: p.y, w: 0, h: 0 });
    else if (SEGMENT_TYPES.has(tool)) Object.assign(s, { x1: p.x, y1: p.y, x2: p.x, y2: p.y });
    else if (PATH_TYPES.has(tool)) s.points = [[p.x, p.y]];
    else if (tool === 'text') Object.assign(s, { x: p.x, y: p.y - s.fontSize * U * 0.625, text: '' });
    else if (tool === 'step') Object.assign(s, { x: p.x, y: p.y, n: 1 });
    else return null;
    return s;
  }

  // --------------------------------------------------------------- texte

  function fontCss(family) {
    return (FONTS.find((f) => f.name === family) ?? FONTS[0]).css;
  }

  function textFont(s) {
    return `${s.italic ? 'italic ' : ''}${s.bold ? 700 : 400} ${s.fontSize * U}px ${fontCss(s.fontFamily)}`;
  }

  function textLines(s) {
    return (s.text || ' ').split('\n');
  }

  let measureCtx = null;
  function textBox(s) {
    measureCtx ??= document.createElement('canvas').getContext('2d');
    measureCtx.font = textFont(s);
    const size = s.fontSize * U;
    const lines = textLines(s);
    const w = Math.max(size * 0.5, ...lines.map((l) => measureCtx.measureText(l).width));
    const ow = s.outline ? s.outlineWidth * U : 0;
    const padX = s.background ? size * 0.4 : Math.max(ow, size * 0.12);
    const padY = s.background ? size * 0.2 : Math.max(ow, size * 0.08);
    return { x: s.x - padX, y: s.y - padY, w: w + padX * 2, h: lines.length * size * 1.25 + padY * 2 };
  }

  // ------------------------------------------------------------- bornes

  function bounds(s) {
    if (BOX_TYPES.has(s.type)) return normRect(s);
    if (SEGMENT_TYPES.has(s.type)) {
      const x = Math.min(s.x1, s.x2), y = Math.min(s.y1, s.y2);
      return { x, y, w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) };
    }
    if (PATH_TYPES.has(s.type)) {
      const xs = s.points.map((p) => p[0]), ys = s.points.map((p) => p[1]);
      const half = (s.width * U) / 2;
      const x = Math.min(...xs) - half, y = Math.min(...ys) - half;
      return { x, y, w: Math.max(...xs) + half - x, h: Math.max(...ys) + half - y };
    }
    if (s.type === 'text') return textBox(s);
    if (s.type === 'step') {
      const r = s.stepSize * U;
      return { x: s.x - r, y: s.y - r, w: r * 2, h: r * 2 };
    }
    return { x: 0, y: 0, w: 0, h: 0 };
  }

  // Zone réellement peinte (traits épais, pointes, contour, ombre compris)
  function paintBounds(s) {
    const b = bounds(s);
    const pad = ((s.width ?? 0) * 2.2 + (s.outline ? s.outlineWidth * 2 : 0) + 16) * U;
    return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
  }

  // -------------------------------------------------------------- rendu

  function setShadow(c) {
    c.shadowColor = 'rgba(0, 0, 0, 0.35)';
    c.shadowBlur = 5 * U;
    c.shadowOffsetY = 1.5 * U;
  }

  function clearShadow(c) {
    c.shadowColor = 'transparent';
  }

  function dashFor(dash, w) {
    if (dash === 'dashed') return { pattern: [w * 2.5, w * 1.8], cap: 'butt' };
    if (dash === 'dotted') return { pattern: [0.001, w * 2], cap: 'round' };
    return { pattern: [], cap: 'round' };
  }

  function smoothPath(points) {
    const path = new Path2D();
    const [x0, y0] = points[0];
    path.moveTo(x0, y0);
    if (points.length === 1) {
      path.lineTo(x0 + 0.01, y0);
      return path;
    }
    for (let i = 1; i < points.length - 1; i++) {
      const [x, y] = points[i];
      const [nx, ny] = points[i + 1];
      path.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
    }
    const [lx, ly] = points[points.length - 1];
    path.lineTo(lx, ly);
    return path;
  }

  // Décompose une flèche (ou une ligne) en traits et surfaces pleines.
  function arrowParts(s) {
    const w = s.width * U;
    let { x1, y1, x2, y2 } = s;
    let heads = s.type === 'line' ? 'none' : s.heads ?? 'end';
    if (heads === 'start') {
      [x1, y1, x2, y2] = [x2, y2, x1, y1];
      heads = 'end';
    }
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 1) return null;
    const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
    const style = s.headStyle ?? 'filled';
    const dash = dashFor(s.dash, w);
    const head = Math.min(len * (heads === 'both' ? 0.5 : 1), w * 3 + 10 * U);
    const half = head * 0.58;
    const parts = { strokes: [], fills: [] };

    // Corps effilé : un seul polygone, fin à la base et pleine épaisseur contre la pointe
    if (s.taper && heads === 'end' && style === 'filled' && !dash.pattern.length) {
      const bx = x2 - ux * head, by = y2 - uy * head;
      const tail = Math.max(1, w * 0.35) / 2, neck = w / 2;
      const p = new Path2D();
      p.moveTo(x1 - uy * tail, y1 + ux * tail);
      p.lineTo(bx - uy * neck, by + ux * neck);
      p.lineTo(bx - uy * half, by + ux * half);
      p.lineTo(x2, y2);
      p.lineTo(bx + uy * half, by - ux * half);
      p.lineTo(bx + uy * neck, by - ux * neck);
      p.lineTo(x1 + uy * tail, y1 - ux * tail);
      p.closePath();
      parts.fills.push(p);
      return parts;
    }

    // Ajoute une pointe en (tx, ty) orientée selon (dx, dy) ; renvoie où le corps doit s'arrêter.
    const addHead = (tx, ty, dx, dy) => {
      const bx = tx - dx * head, by = ty - dy * head;
      if (style === 'open') {
        const p = new Path2D();
        p.moveTo(bx - dy * half, by + dx * half);
        p.lineTo(tx, ty);
        p.lineTo(bx + dy * half, by - dx * half);
        parts.strokes.push({ path: p, width: w, cap: 'round', dash: [] });
        return [tx, ty];
      }
      if (style === 'dot') {
        const p = new Path2D();
        p.arc(tx, ty, Math.max(w * 1.5, 3 * U), 0, Math.PI * 2);
        parts.fills.push(p);
        return [tx, ty];
      }
      const p = new Path2D();
      p.moveTo(tx, ty);
      p.lineTo(bx - dy * half, by + dx * half);
      p.lineTo(bx + dy * half, by - dx * half);
      p.closePath();
      parts.fills.push(p);
      return [tx - dx * head * 0.8, ty - dy * head * 0.8];
    };

    let [sx, sy, ex, ey] = [x1, y1, x2, y2];
    if (heads === 'end' || heads === 'both') [ex, ey] = addHead(x2, y2, ux, uy);
    if (heads === 'both') [sx, sy] = addHead(x1, y1, -ux, -uy);
    const shaft = new Path2D();
    shaft.moveTo(sx, sy);
    shaft.lineTo(ex, ey);
    parts.strokes.unshift({ path: shaft, width: w, cap: dash.cap, dash: dash.pattern });
    return parts;
  }

  function paintParts(c, parts, color, extra) {
    c.strokeStyle = color;
    c.fillStyle = color;
    c.lineJoin = 'round';
    for (const p of parts.strokes) {
      c.lineWidth = p.width + extra;
      c.lineCap = p.cap;
      c.lineJoin = p.join ?? 'round';
      c.setLineDash(p.dash);
      c.stroke(p.path);
    }
    c.setLineDash([]);
    c.lineJoin = 'round';
    for (const f of parts.fills) {
      c.fill(f);
      if (extra) {
        c.lineWidth = extra;
        c.stroke(f);
      }
    }
  }

  // Contour (s'il existe) puis tracé principal ; l'ombre n'est portée que par la première passe.
  function paintWithOutline(c, s, parts) {
    if (s.shadow) setShadow(c);
    if (s.outline) {
      paintParts(c, parts, s.outline, s.outlineWidth * U * 2);
      clearShadow(c);
    }
    paintParts(c, parts, s.color, 0);
  }

  function strokeParts(s, path, join) {
    const w = s.width * U;
    const dash = dashFor(s.dash, w);
    return { strokes: [{ path, width: w, cap: dash.cap, dash: dash.pattern, join }], fills: [] };
  }

  function drawBox(c, s) {
    const r = normRect(s);
    const path = new Path2D();
    if (s.type === 'ellipse') path.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    else path.roundRect(r.x, r.y, r.w, r.h, Math.min(s.radius * U, r.w / 2, r.h / 2));
    if (s.fill) {
      c.fillStyle = hexToRgba(s.fill, s.fillOpacity / 100);
      c.fill(path);
    }
    const sharp = s.type === 'rect' && !s.radius;
    paintWithOutline(c, s, strokeParts(s, path, sharp ? 'miter' : 'round'));
  }

  function drawText(c, s) {
    const size = s.fontSize * U;
    const lh = size * 1.25;
    c.font = textFont(s);
    c.textBaseline = 'top';
    c.lineJoin = 'round';
    if (s.background) {
      const b = textBox(s);
      c.save();
      if (s.shadow) setShadow(c);
      c.fillStyle = s.background;
      c.beginPath();
      c.roundRect(b.x, b.y, b.w, b.h, size * 0.25);
      c.fill();
      c.restore();
    } else if (s.shadow) {
      setShadow(c);
    }
    const lines = textLines(s);
    const y = (i) => s.y + i * lh + size * 0.125;
    if (s.outline) {
      c.strokeStyle = s.outline;
      c.lineWidth = s.outlineWidth * U * 2;
      lines.forEach((line, i) => c.strokeText(line, s.x, y(i)));
      clearShadow(c);
    }
    c.fillStyle = s.color;
    lines.forEach((line, i) => c.fillText(line, s.x, y(i)));
  }

  function drawStep(c, s) {
    const r = s.stepSize * U;
    const path = new Path2D();
    if (s.stepShape === 'square') path.roundRect(s.x - r, s.y - r, r * 2, r * 2, r * 0.3);
    else path.arc(s.x, s.y, r, 0, Math.PI * 2);
    if (s.shadow) setShadow(c);
    c.fillStyle = s.color;
    c.fill(path);
    clearShadow(c);
    if (s.outline) {
      c.strokeStyle = s.outline;
      c.lineWidth = s.outlineWidth * U;
      c.stroke(path);
    }
    const label = String(s.n);
    c.fillStyle = isLight(s.color) ? '#111' : '#fff';
    c.font = `700 ${r * (label.length > 2 ? 0.75 : label.length > 1 ? 0.95 : 1.15)}px ${fontCss('Segoe UI')}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(label, s.x, s.y + r * 0.06);
  }

  function drawBlur(c, s, base) {
    const r = normRect(s);
    const x = Math.max(0, Math.floor(r.x)), y = Math.max(0, Math.floor(r.y));
    const w = Math.min(base.width, Math.ceil(r.x + r.w)) - x;
    const h = Math.min(base.height, Math.ceil(r.y + r.h)) - y;
    if (w < 1 || h < 1) return;
    const amount = s.intensity * U;

    if (s.blurMode === 'blur') {
      const m = Math.ceil(amount * 2);
      const sx = Math.max(0, x - m), sy = Math.max(0, y - m);
      const sw = Math.min(base.width, x + w + m) - sx, sh = Math.min(base.height, y + h + m) - sy;
      c.beginPath();
      c.rect(x, y, w, h);
      c.clip();
      c.filter = `blur(${amount * 0.6}px)`;
      c.drawImage(base, sx, sy, sw, sh, sx, sy, sw, sh);
      c.filter = 'none';
      return;
    }

    const sw = Math.max(1, Math.round(w / amount));
    const sh = Math.max(1, Math.round(h / amount));
    scratch ??= document.createElement('canvas');
    if (scratch.width < sw || scratch.height < sh) {
      scratch.width = Math.max(scratch.width, sw);
      scratch.height = Math.max(scratch.height, sh);
    }
    const sc = scratch.getContext('2d');
    sc.imageSmoothingEnabled = true;
    sc.imageSmoothingQuality = 'high';
    sc.drawImage(base, x, y, w, h, 0, 0, sw, sh);
    c.imageSmoothingEnabled = false;
    c.drawImage(scratch, 0, 0, sw, sh, x, y, w, h);
  }

  function drawRaw(c, s, base) {
    c.save();
    c.lineCap = 'round';
    c.lineJoin = 'round';
    switch (s.type) {
      case 'rect':
      case 'ellipse':
        drawBox(c, s);
        break;
      case 'line':
      case 'arrow': {
        const parts = arrowParts(s);
        if (parts) paintWithOutline(c, s, parts);
        break;
      }
      case 'pen':
        paintWithOutline(c, s, { strokes: [{ path: smoothPath(s.points), width: s.width * U, cap: 'round', dash: [] }], fills: [] });
        break;
      case 'marker':
        c.strokeStyle = s.color;
        c.lineWidth = s.width * U;
        c.lineCap = 'square';
        c.stroke(smoothPath(s.points));
        break;
      case 'text':
        drawText(c, s);
        break;
      case 'step':
        drawStep(c, s);
        break;
      case 'blur':
        drawBlur(c, s, base);
        break;
    }
    c.restore();
  }

  // Les annotations semi-transparentes sont d'abord peintes sur un calque, pour que
  // contour et trait ne se superposent pas en transparence.
  function draw(c, s, { base }) {
    const alpha = (s.opacity ?? 100) / 100;
    if (alpha >= 1 && s.type !== 'marker') {
      drawRaw(c, s, base);
      return;
    }
    const b = paintBounds(s);
    const x = Math.floor(b.x), y = Math.floor(b.y);
    const w = Math.ceil(b.w) + 1, h = Math.ceil(b.h) + 1;
    if (w < 1 || h < 1) return;
    layer ??= document.createElement('canvas');
    if (layer.width < w || layer.height < h) {
      layer.width = Math.max(layer.width, w);
      layer.height = Math.max(layer.height, h);
    }
    const lc = layer.getContext('2d');
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.clearRect(0, 0, w, h);
    lc.setTransform(1, 0, 0, 1, -x, -y);
    drawRaw(lc, s, base);
    c.save();
    c.globalAlpha = alpha;
    // le surligneur fonce le fond comme un vrai feutre
    if (s.type === 'marker') c.globalCompositeOperation = 'multiply';
    c.drawImage(layer, 0, 0, w, h, x, y, w, h);
    c.restore();
  }

  // ----------------------------------------------------------- géométrie

  function distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  function hit(s, p, tol) {
    const w = (s.width ?? 0) * U;
    switch (s.type) {
      case 'rect':
      case 'blur':
      case 'text': {
        const r = s.type === 'text' ? textBox(s) : normRect(s);
        const pad = tol + w / 2;
        return p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;
      }
      case 'ellipse': {
        const r = normRect(s);
        const rx = r.w / 2 + tol + w / 2, ry = r.h / 2 + tol + w / 2;
        return ((p.x - r.x - r.w / 2) / rx) ** 2 + ((p.y - r.y - r.h / 2) / ry) ** 2 <= 1;
      }
      case 'line':
      case 'arrow':
        return distToSegment(p.x, p.y, s.x1, s.y1, s.x2, s.y2) <= w / 2 + tol + (s.type === 'arrow' ? w : 0);
      case 'pen':
      case 'marker': {
        const pts = s.points;
        if (pts.length === 1) return Math.hypot(p.x - pts[0][0], p.y - pts[0][1]) <= w / 2 + tol;
        for (let i = 1; i < pts.length; i++) {
          if (distToSegment(p.x, p.y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= w / 2 + tol) return true;
        }
        return false;
      }
      case 'step':
        return Math.hypot(p.x - s.x, p.y - s.y) <= s.stepSize * U + tol;
      default:
        return false;
    }
  }

  function handles(s) {
    if (BOX_TYPES.has(s.type)) {
      const r = normRect(s);
      return [
        { id: 'nw', x: r.x, y: r.y, cursor: 'nwse-resize' },
        { id: 'ne', x: r.x + r.w, y: r.y, cursor: 'nesw-resize' },
        { id: 'sw', x: r.x, y: r.y + r.h, cursor: 'nesw-resize' },
        { id: 'se', x: r.x + r.w, y: r.y + r.h, cursor: 'nwse-resize' },
      ];
    }
    if (SEGMENT_TYPES.has(s.type)) {
      return [
        { id: 'p1', x: s.x1, y: s.y1, cursor: 'move' },
        { id: 'p2', x: s.x2, y: s.y2, cursor: 'move' },
      ];
    }
    return [];
  }

  // Redimensionne à partir de l'état d'origine (orig normalisé) et de la position du pointeur.
  function resize(s, orig, handleId, p, constrain) {
    if (SEGMENT_TYPES.has(s.type)) {
      const [fx, fy] = handleId === 'p1' ? [orig.x2, orig.y2] : [orig.x1, orig.y1];
      const q = constrain ? snapAngle(fx, fy, p.x, p.y) : p;
      if (handleId === 'p1') { s.x1 = q.x; s.y1 = q.y; } else { s.x2 = q.x; s.y2 = q.y; }
      return;
    }
    // coin opposé fixe
    const ax = handleId.includes('w') ? orig.x + orig.w : orig.x;
    const ay = handleId.includes('n') ? orig.y + orig.h : orig.y;
    let w = p.x - ax, h = p.y - ay;
    if (constrain) {
      const m = Math.max(Math.abs(w), Math.abs(h));
      w = Math.sign(w || 1) * m;
      h = Math.sign(h || 1) * m;
    }
    Object.assign(s, { x: ax, y: ay, w, h });
  }

  function snapAngle(x0, y0, x, y) {
    const step = Math.PI / 4;
    const angle = Math.round(Math.atan2(y - y0, x - x0) / step) * step;
    const len = Math.hypot(x - x0, y - y0);
    return { x: x0 + Math.cos(angle) * len, y: y0 + Math.sin(angle) * len };
  }

  function translate(s, dx, dy) {
    if (SEGMENT_TYPES.has(s.type)) {
      s.x1 += dx; s.y1 += dy; s.x2 += dx; s.y2 += dy;
    } else if (PATH_TYPES.has(s.type)) {
      s.points = s.points.map(([x, y]) => [x + dx, y + dy]);
    } else {
      s.x += dx; s.y += dy;
    }
  }

  function normalize(s) {
    if (BOX_TYPES.has(s.type)) Object.assign(s, normRect(s));
  }

  // Une annotation trop petite pour être intentionnelle (simple clic) est abandonnée.
  function isDegenerate(s, minSize) {
    if (BOX_TYPES.has(s.type)) return Math.abs(s.w) < minSize || Math.abs(s.h) < minSize;
    if (SEGMENT_TYPES.has(s.type)) return Math.hypot(s.x2 - s.x1, s.y2 - s.y1) < minSize * 2;
    return false;
  }

  return {
    FONTS,
    DEFAULTS,
    setUnit: (u) => {
      U = u;
    },
    nextId: () => ++seq, // pour les annotations rechargées depuis la bibliothèque
    create,
    draw,
    bounds,
    hit,
    handles,
    resize,
    snapAngle,
    translate,
    normalize,
    normRect,
    isDegenerate,
    textFont,
    fontCss,
    isLight,
  };
})();
