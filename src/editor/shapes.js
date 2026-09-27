'use strict';

// Modèle, rendu et géométrie des annotations. Toutes les coordonnées sont en pixels de l'image.
const Shapes = (() => {
  const FONT_FAMILY = '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
  const BOX_TYPES = new Set(['rect', 'ellipse', 'blur']);
  const SEGMENT_TYPES = new Set(['line', 'arrow']);
  const PATH_TYPES = new Set(['pen', 'marker']);

  // Échelles de taille, indexées par le sélecteur de taille (petit → très grand)
  const SIZES = {
    stroke: [2, 4, 7, 12],
    marker: [12, 18, 28, 40],
    font: [18, 26, 36, 52],
    step: [11, 15, 20, 27],
    block: [6, 10, 16, 24],
  };

  let seq = 0;
  let scratch = null; // canvas réutilisé pour la pixelisation

  function luminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  const isLight = (hex) => luminance(hex) > 0.45;

  function normRect(s) {
    return {
      x: Math.min(s.x, s.x + s.w),
      y: Math.min(s.y, s.y + s.h),
      w: Math.abs(s.w),
      h: Math.abs(s.h),
    };
  }

  function create(tool, p, { color, sizeIndex, unit }) {
    const id = ++seq;
    const size = (key) => SIZES[key][sizeIndex] * unit;
    switch (tool) {
      case 'rect':
      case 'ellipse':
        return { id, type: tool, x: p.x, y: p.y, w: 0, h: 0, color, width: size('stroke') };
      case 'blur':
        return { id, type: 'blur', x: p.x, y: p.y, w: 0, h: 0, block: size('block') };
      case 'line':
      case 'arrow':
        return { id, type: tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color, width: size('stroke') };
      case 'pen':
        return { id, type: 'pen', points: [[p.x, p.y]], color, width: size('stroke') };
      case 'marker':
        return { id, type: 'marker', points: [[p.x, p.y]], color, width: size('marker') };
      case 'text': {
        const fontSize = size('font');
        return { id, type: 'text', x: p.x, y: p.y - fontSize * 0.65, text: '', color, size: fontSize };
      }
      case 'step':
        return { id, type: 'step', x: p.x, y: p.y, n: 1, color, r: size('step') };
      default:
        return null;
    }
  }

  // Applique la taille courante à une annotation existante.
  function applySize(s, sizeIndex, unit) {
    const size = (key) => SIZES[key][sizeIndex] * unit;
    switch (s.type) {
      case 'marker': s.width = size('marker'); break;
      case 'text': s.size = size('font'); break;
      case 'step': s.r = size('step'); break;
      case 'blur': s.block = size('block'); break;
      default: s.width = size('stroke');
    }
  }

  // Retrouve l'indice de taille le plus proche d'une annotation (pour synchroniser la barre d'outils).
  function sizeIndexOf(s, unit) {
    const [key, value] = {
      marker: ['marker', s.width],
      text: ['font', s.size],
      step: ['step', s.r],
      blur: ['block', s.block],
    }[s.type] ?? ['stroke', s.width];
    const scale = SIZES[key].map((v) => Math.abs(v * unit - value));
    return scale.indexOf(Math.min(...scale));
  }

  function textFont(s) {
    return `600 ${s.size}px ${FONT_FAMILY}`;
  }

  function textLines(s) {
    return (s.text || ' ').split('\n');
  }

  let measureCtx = null;
  function textBox(s) {
    measureCtx ??= document.createElement('canvas').getContext('2d');
    measureCtx.font = textFont(s);
    const lines = textLines(s);
    const w = Math.max(s.size * 0.5, ...lines.map((l) => measureCtx.measureText(l).width));
    const pad = s.size * 0.2;
    return { x: s.x - pad, y: s.y - pad, w: w + pad * 2, h: lines.length * s.size * 1.25 + pad * 2 };
  }

  function bounds(s) {
    if (BOX_TYPES.has(s.type)) return normRect(s);
    if (SEGMENT_TYPES.has(s.type)) {
      const x = Math.min(s.x1, s.x2), y = Math.min(s.y1, s.y2);
      return { x, y, w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) };
    }
    if (PATH_TYPES.has(s.type)) {
      const xs = s.points.map((p) => p[0]), ys = s.points.map((p) => p[1]);
      const half = s.width / 2;
      const x = Math.min(...xs) - half, y = Math.min(...ys) - half;
      return { x, y, w: Math.max(...xs) + half - x, h: Math.max(...ys) + half - y };
    }
    if (s.type === 'text') return textBox(s);
    if (s.type === 'step') return { x: s.x - s.r, y: s.y - s.r, w: s.r * 2, h: s.r * 2 };
    return { x: 0, y: 0, w: 0, h: 0 };
  }

  // ------------------------------------------------------------------ rendu

  function setShadow(c, unit) {
    c.shadowColor = 'rgba(0, 0, 0, 0.35)';
    c.shadowBlur = 5 * unit;
    c.shadowOffsetY = 1.5 * unit;
  }

  function strokePath(c, points) {
    c.beginPath();
    if (points.length === 1) {
      const [x, y] = points[0];
      c.moveTo(x, y);
      c.lineTo(x + 0.01, y);
    } else {
      c.moveTo(points[0][0], points[0][1]);
      // lissage par courbes quadratiques passant par les milieux
      for (let i = 1; i < points.length - 1; i++) {
        const [x, y] = points[i];
        const [nx, ny] = points[i + 1];
        c.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
      }
      const last = points[points.length - 1];
      c.lineTo(last[0], last[1]);
    }
    c.stroke();
  }

  function drawArrow(c, s) {
    const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
    const len = Math.hypot(dx, dy);
    if (len < 1) return;
    const ux = dx / len, uy = dy / len;
    const head = Math.min(len, s.width * 3 + 10);
    const half = head * 0.58;
    const bx = s.x2 - ux * head, by = s.y2 - uy * head;

    // corps effilé : fin à la base, pleine épaisseur au niveau de la pointe
    const tail = Math.max(1, s.width * 0.35) / 2;
    const neck = s.width / 2;
    c.beginPath();
    c.moveTo(s.x1 - uy * tail, s.y1 + ux * tail);
    c.lineTo(bx - uy * neck, by + ux * neck);
    c.lineTo(bx - uy * half, by + ux * half);
    c.lineTo(s.x2, s.y2);
    c.lineTo(bx + uy * half, by - ux * half);
    c.lineTo(bx + uy * neck, by - ux * neck);
    c.lineTo(s.x1 + uy * tail, s.y1 - ux * tail);
    c.closePath();
    c.lineJoin = 'round';
    c.lineWidth = Math.max(1, s.width * 0.25);
    c.fill();
    c.stroke();
  }

  function drawText(c, s) {
    c.font = textFont(s);
    c.textBaseline = 'top';
    const lh = s.size * 1.25;
    const halo = isLight(s.color) ? 'rgba(0, 0, 0, 0.85)' : '#fff';
    c.lineJoin = 'round';
    c.lineWidth = Math.max(2, s.size * 0.16);
    c.strokeStyle = halo;
    textLines(s).forEach((line, i) => {
      const y = s.y + i * lh + s.size * 0.1;
      c.strokeText(line, s.x, y);
      c.fillText(line, s.x, y);
    });
  }

  function drawStep(c, s, unit) {
    c.save();
    setShadow(c, unit);
    c.beginPath();
    c.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    c.fill();
    c.restore();
    c.lineWidth = Math.max(1.5, s.r * 0.13);
    c.strokeStyle = isLight(s.color) ? 'rgba(0, 0, 0, 0.75)' : '#fff';
    c.stroke();
    c.fillStyle = isLight(s.color) ? '#111' : '#fff';
    c.font = `700 ${s.r * 1.15}px ${FONT_FAMILY}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(String(s.n), s.x, s.y + s.r * 0.06);
  }

  function drawBlur(c, s, base) {
    const r = normRect(s);
    const x = Math.max(0, Math.floor(r.x)), y = Math.max(0, Math.floor(r.y));
    const w = Math.min(base.width, Math.ceil(r.x + r.w)) - x;
    const h = Math.min(base.height, Math.ceil(r.y + r.h)) - y;
    if (w < 1 || h < 1) return;
    const sw = Math.max(1, Math.round(w / s.block));
    const sh = Math.max(1, Math.round(h / s.block));
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

  function draw(c, s, { base, unit }) {
    c.save();
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.strokeStyle = s.color;
    c.fillStyle = s.color;
    c.lineWidth = s.width;
    switch (s.type) {
      case 'rect': {
        const r = normRect(s);
        setShadow(c, unit);
        c.lineJoin = 'miter';
        c.strokeRect(r.x, r.y, r.w, r.h);
        break;
      }
      case 'ellipse': {
        const r = normRect(s);
        setShadow(c, unit);
        c.beginPath();
        c.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
        c.stroke();
        break;
      }
      case 'line':
        setShadow(c, unit);
        c.beginPath();
        c.moveTo(s.x1, s.y1);
        c.lineTo(s.x2, s.y2);
        c.stroke();
        break;
      case 'arrow':
        setShadow(c, unit);
        drawArrow(c, s);
        break;
      case 'pen':
        setShadow(c, unit);
        strokePath(c, s.points);
        break;
      case 'marker':
        c.globalAlpha = 0.45;
        c.globalCompositeOperation = 'multiply';
        c.lineCap = 'square';
        strokePath(c, s.points);
        break;
      case 'text':
        drawText(c, s);
        break;
      case 'step':
        drawStep(c, s, unit);
        break;
      case 'blur':
        drawBlur(c, s, base);
        break;
    }
    c.restore();
  }

  // -------------------------------------------------------------- géométrie

  function distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  function hit(s, p, tol) {
    switch (s.type) {
      case 'rect':
      case 'blur':
      case 'text': {
        const r = s.type === 'text' ? textBox(s) : normRect(s);
        const pad = tol + (s.width ?? 0) / 2;
        return p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;
      }
      case 'ellipse': {
        const r = normRect(s);
        const rx = r.w / 2 + tol + s.width / 2, ry = r.h / 2 + tol + s.width / 2;
        return ((p.x - r.x - r.w / 2) / rx) ** 2 + ((p.y - r.y - r.h / 2) / ry) ** 2 <= 1;
      }
      case 'line':
      case 'arrow':
        return distToSegment(p.x, p.y, s.x1, s.y1, s.x2, s.y2) <= s.width / 2 + tol + (s.type === 'arrow' ? s.width : 0);
      case 'pen':
      case 'marker': {
        const pts = s.points;
        if (pts.length === 1) return Math.hypot(p.x - pts[0][0], p.y - pts[0][1]) <= s.width / 2 + tol;
        for (let i = 1; i < pts.length; i++) {
          if (distToSegment(p.x, p.y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= s.width / 2 + tol) return true;
        }
        return false;
      }
      case 'step':
        return Math.hypot(p.x - s.x, p.y - s.y) <= s.r + tol;
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
    SIZES,
    create,
    applySize,
    sizeIndexOf,
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
    textBox,
    isLight,
    hasColor: (s) => s.type !== 'blur',
  };
})();
