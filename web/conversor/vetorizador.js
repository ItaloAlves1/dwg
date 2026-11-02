// Web Worker: vetoriza uma folha escaneada (pixels → linhas, símbolos, textos) e gera o DXF.
// O OCR fica na página principal (Tesseract.js já usa seus próprios workers), então o
// trabalho é dividido em duas etapas:
//   'preparar'  pixels da folha → imagens para o OCR (original endireitada, sem linhas, girada 90°)
//   'finalizar' resultado do OCR → DXF (texto) + prévia (WebP) + estatísticas
'use strict';

const DPI = 300;
const MM = 25.4 / DPI;            // mm por pixel
const MIN_LINE = 30;              // comprimento mínimo de linha reta (px ≈ 2.5 mm)
const MAX_THICK = 14;             // espessura máxima de uma linha (px)
const NB = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]; // vizinhos P2..P9

const pages = new Map();          // id → estado entre 'preparar' e 'finalizar'

self.onmessage = async ({ data: msg }) => {
  try {
    if (msg.type === 'preparar') {
      const page = new Folha(msg.width, msg.height, new Uint8ClampedArray(msg.buffer));
      pages.set(msg.id, page);
      const imagens = await page.preparar();
      self.postMessage({ id: msg.id, ok: true, imagens });
    } else if (msg.type === 'finalizar') {
      const page = pages.get(msg.id);
      pages.delete(msg.id);
      const result = await page.finalizar(msg.ocr);
      self.postMessage({ id: msg.id, ok: true, ...result }, [result.dxf.buffer]);
    } else if (msg.type === 'descartar') {
      pages.delete(msg.id);
    }
  } catch (e) {
    pages.delete(msg.id);
    self.postMessage({ id: msg.id, ok: false, erro: String(e && e.stack || e) });
  }
};

class Folha {
  constructor(W, H, rgba) {
    this.W = W; this.H = H; this.rgba = rgba;
  }

  // ---------- Etapa 1: máscaras, endireitamento, linhas, pontos ----------
  async preparar() {
    const { W, H } = this;
    this.black = new Uint8Array(W * H);
    this.colorCat = new Uint8Array(W * H); // 0 nada, 1 vermelho, 2 laranja/amarelo, 3 verde, 4 azul
    this.buildMasks(this.rgba);

    // Endireitar a folha se estiver torta no escaneamento.
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(this.rgba, W, H), 0, 0);
    this.skew = this.estimateSkew(this.black);
    if (Math.abs(this.skew) >= 0.02) {
      const src = new OffscreenCanvas(W, H);
      src.getContext('2d').drawImage(canvas, 0, 0);
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
      ctx.save(); ctx.translate(W / 2, H / 2); ctx.rotate(-this.skew * Math.PI / 180); ctx.drawImage(src, -W / 2, -H / 2); ctx.restore();
      this.buildMasks(ctx.getImageData(0, 0, W, H).data);
    }
    this.rgba = null;  // libera memória

    // Linhas retas horizontais e verticais.
    const blackT = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) blackT[x * H + y] = this.black[y * W + x];
    this.hSegs = mergeCollinear(runSegments(this.black, W, H));   // a,b = x;  c = y
    this.vSegs = mergeCollinear(runSegments(blackT, H, W));       // a,b = y;  c = x
    snap(this.hSegs, this.vSegs);
    snap(this.vSegs, this.hSegs);

    // Máscara residual = tinta preta menos as linhas detectadas.
    const resid = this.resid = this.black.slice();
    const PAD = 2;
    for (const s of this.hSegs) for (let y = s.y0 - PAD; y <= s.y1 + PAD; y++) if (y >= 0 && y < H)
      for (let x = Math.max(0, Math.floor(s.a) - 1); x <= Math.min(W - 1, Math.ceil(s.b) + 1); x++) resid[y * W + x] = 0;
    for (const s of this.vSegs) for (let x = s.y0 - PAD; x <= s.y1 + PAD; x++) if (x >= 0 && x < W)
      for (let y = Math.max(0, Math.floor(s.a) - 1); y <= Math.min(H - 1, Math.ceil(s.b) + 1); y++) resid[y * W + x] = 0;

    // Pontos de ligação (●): o que sobra após erodir a tinta com um quadrado 9x9.
    this.dots = [];
    const R = 4, er = new Uint8Array(W * H), er2 = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) { let run = 0; for (let x = 0; x < W; x++) { run = this.black[y * W + x] ? run + 1 : 0; if (run > 2 * R) er[y * W + x - R] = 1; } }
    for (let x = 0; x < W; x++) { let run = 0; for (let y = 0; y < H; y++) { run = er[y * W + x] ? run + 1 : 0; if (run > 2 * R) er2[(y - R) * W + x] = 1; } }
    for (const c of this.components(er2)) {
      const w = c.maxx - c.minx + 1, h = c.maxy - c.miny + 1;
      if (w > 12 || h > 12 || Math.abs(w - h) > 4) continue;
      const cx = (c.minx + c.maxx) / 2, cy = (c.miny + c.maxy) / 2, r = (w + h) / 4 + R + 0.5;
      this.dots.push({ x: cx, y: cy, r });
      for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++)
        if (x >= 0 && y >= 0 && x < W && y < H && Math.hypot(x - cx, y - cy) <= r + 1.5) resid[y * W + x] = 0;
    }

    // Imagens para o OCR: original endireitada, sem linhas, e sem linhas girada 90° (textos verticais).
    const clean = new OffscreenCanvas(W, H);
    const img = new ImageData(W, H);
    for (let i = 0, p = 0; i < W * H; i++, p += 4) { const v = resid[i] ? 0 : 255; img.data[p] = img.data[p + 1] = img.data[p + 2] = v; img.data[p + 3] = 255; }
    clean.getContext('2d').putImageData(img, 0, 0);
    const rot = new OffscreenCanvas(H, W), rc = rot.getContext('2d');
    rc.translate(H, 0); rc.rotate(Math.PI / 2); rc.drawImage(clean, 0, 0);
    return {
      original: await canvas.convertToBlob({ type: 'image/png' }),
      limpa: await clean.convertToBlob({ type: 'image/png' }),
      girada: await rot.convertToBlob({ type: 'image/png' }),
    };
  }

  buildMasks(rgba) {
    const { W, H, black, colorCat } = this;
    black.fill(0); colorCat.fill(0);
    for (let i = 0, p = 0; i < W * H; i++, p += 4) {
      const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx - mn;
      if (sat > 60 && mx > 100) {
        let h;
        if (mx === r) h = 60 * (((g - b) / sat) % 6);
        else if (mx === g) h = 60 * ((b - r) / sat + 2);
        else h = 60 * ((r - g) / sat + 4);
        if (h < 0) h += 360;
        colorCat[i] = h < 18 || h >= 330 ? 1 : h < 70 ? 2 : h < 170 ? 3 : 4;
      } else if (0.3 * r + 0.59 * g + 0.11 * b < 150) black[i] = 1;
    }
  }

  // Ângulo que deixa as linhas horizontais mais "concentradas" em poucas linhas de pixel.
  estimateSkew(mask) {
    const { W, H } = this;
    const xs = [], ys = [];
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) if (mask[y * W + x]) { xs.push(x); ys.push(y); }
    const score = deg => {
      const a = deg * Math.PI / 180, s = Math.sin(a), c = Math.cos(a);
      const hist = new Float64Array(H + W + 2);
      for (let i = 0; i < xs.length; i++) hist[Math.round(ys[i] * c - xs[i] * s) + W]++;
      let sum = 0; for (const v of hist) sum += v * v; return sum;
    };
    let best = 0, bs = score(0);
    for (let d = -1.5; d <= 1.5; d += 0.05) { const s = score(d); if (s > bs) { bs = s; best = d; } }
    const c0 = best;
    for (let d = c0 - 0.05; d <= c0 + 0.05; d += 0.01) { const s = score(d); if (s > bs) { bs = s; best = d; } }
    return best;
  }

  components(mask) {
    const { W, H } = this;
    const lab = new Int32Array(W * H), comps = [], stack = [];
    for (let i = 0; i < W * H; i++) {
      if (!mask[i] || lab[i]) continue;
      const c = { id: comps.length + 1, px: [], minx: W, miny: H, maxx: 0, maxy: 0 };
      lab[i] = c.id; stack.push(i);
      while (stack.length) {
        const k = stack.pop(), x = k % W, y = (k / W) | 0;
        c.px.push(k);
        if (x < c.minx) c.minx = x; if (x > c.maxx) c.maxx = x;
        if (y < c.miny) c.miny = y; if (y > c.maxy) c.maxy = y;
        for (const [dx, dy] of NB) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const n = ny * W + nx;
          if (mask[n] && !lab[n]) { lab[n] = c.id; stack.push(n); }
        }
      }
      comps.push(c);
    }
    return comps;
  }

  // ---------- Etapa 2: textos, símbolos, as-built, DXF e prévia ----------
  async finalizar(ocr) {
    const { W, H, resid } = this;

    // Textos lidos: original, sem linhas e girada. Nas sobreposições fica a leitura mais confiável.
    const JUNK = /^[\s|I1l!\-—–_.,'`~:;"()\[\]{}\\/=+*<>]*$/;
    let texts = [];
    for (const { lines, vertical, original } of ocr) for (const line of lines) {
      const str = line.text.trim();
      if (!str || JUNK.test(str) || line.confidence < (vertical ? 60 : 45)) continue;
      const { x0, y0, x1, y1 } = line.bbox;
      if (y1 - y0 < 8 || y1 - y0 > 90) continue;
      if (vertical && str.replace(/\W/g, '').length < 3) continue;
      // Desenhos técnicos usam só maiúsculas: minúsculas com confiança baixa quase sempre são símbolos mal lidos.
      if (/[a-zà-ú]/.test(str) && line.confidence < 75) continue;
      // A imagem sem linhas pode cortar letras encostadas nelas; em empate, prefere a leitura da original.
      texts.push({ str, x0, y0, x1, y1, conf: line.confidence + (original ? 10 : 0), vertical });
    }
    const area = t => t.vertical ? { x0: t.y0, x1: t.y1, y0: H - 1 - t.x1, y1: H - 1 - t.x0 } : t;
    const ov = (p, q) => Math.max(0, Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0)) * Math.max(0, Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0));
    texts.sort((p, q) => q.conf - p.conf);
    const kept = [];
    for (const t of texts) {
      const a = area(t), size = (a.x1 - a.x0) * (a.y1 - a.y0);
      if (!kept.some(u => { const b = area(u); return ov(a, b) > 0.3 * Math.min(size, (b.x1 - b.x0) * (b.y1 - b.y0)); })) kept.push(t);
    }
    texts = kept;
    // Apagar da máscara residual os pixels cobertos por texto confiável.
    for (const t of texts) if (t.conf >= 60) {
      const a = area(t);
      for (let y = Math.max(0, a.y0); y <= Math.min(H - 1, a.y1); y++)
        for (let x = Math.max(0, a.x0); x <= Math.min(W - 1, a.x1); x++) resid[y * W + x] = 0;
    }

    // Símbolos restantes e marcações coloridas.
    const sym = this.vectorize(resid, 4);
    const dots = this.dots.concat(sym.dots);
    const asbuilt = {};
    for (const [cat, name] of [[1, 'VERMELHO'], [2, 'LARANJA'], [3, 'VERDE'], [4, 'AZUL']]) {
      const m = new Uint8Array(W * H);
      let n = 0;
      for (let i = 0; i < W * H; i++) if (this.colorCat[i] === cat) { m[i] = 1; n++; }
      if (n >= 200) asbuilt[name] = this.vectorize(m, 10).polys;
    }

    const dxf = this.writeDxf(texts, sym.polys, dots, asbuilt);
    const preview = await this.drawPreview(texts, sym.polys, dots, asbuilt);
    const stats = {
      linhas: this.hSegs.length + this.vSegs.length, simbolos: sym.polys.length, pontos: dots.length,
      textos: texts.length, revisar: texts.filter(t => t.conf < 60).length,
      asbuilt: Object.fromEntries(Object.entries(asbuilt).map(([k, v]) => [k, v.length])),
      inclinacao: +this.skew.toFixed(2),
    };
    return { dxf, preview, stats };
  }

  vectorize(mask, minLen) {
    const out = { polys: [], dots: [] };
    for (const c of this.components(mask)) {
      const w = c.maxx - c.minx + 1, h = c.maxy - c.miny + 1;
      if (c.px.length < 6) continue;                               // poeira
      if (w >= 7 && h >= 7 && w <= 26 && h <= 26 && Math.abs(w - h) <= 4 && c.px.length / (w * h) > 0.6) {
        out.dots.push({ x: (c.minx + c.maxx) / 2, y: (c.miny + c.maxy) / 2, r: (w + h) / 4 });  // ponto de ligação
        continue;
      }
      const sk = this.thin(mask, c.px);
      for (const p of this.trace(mask, sk)) {
        const s = simplify(p, 1.3);
        if (polyLen(s) >= minLen) out.polys.push(s);
      }
    }
    return out;
  }

  thin(mask, pixels) {
    // Zhang-Suen restrito à lista de pixels.
    const { W, H } = this;
    let pts = pixels.slice();
    const at = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? mask[y * W + x] : 0);
    for (let changed = true; changed;) {
      changed = false;
      for (const step of [0, 1]) {
        const del = [];
        for (const k of pts) {
          if (!mask[k]) continue;
          const x = k % W, y = (k / W) | 0;
          const p = NB.map(([dx, dy]) => at(x + dx, y + dy));
          const B = p.reduce((s, v) => s + v, 0);
          if (B < 2 || B > 6) continue;
          let A = 0;
          for (let i = 0; i < 8; i++) if (!p[i] && p[(i + 1) % 8]) A++;
          if (A !== 1) continue;
          if (step === 0 ? (p[0] && p[2] && p[4]) || (p[2] && p[4] && p[6])
                         : (p[0] && p[2] && p[6]) || (p[0] && p[4] && p[6])) continue;
          del.push(k);
        }
        for (const k of del) mask[k] = 0;
        if (del.length) changed = true;
      }
      pts = pts.filter(k => mask[k]);
    }
    // Remover pixels redundantes de "degrau" (mantém conectividade, evita bifurcações falsas).
    for (const k of pts) {
      const x = k % W, y = (k / W) | 0;
      const nb = NB.filter(([dx, dy]) => at(x + dx, y + dy));
      if (nb.length < 2) continue;
      const parent = nb.map((_, i) => i);
      const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
      for (let i = 0; i < nb.length; i++) for (let j = i + 1; j < nb.length; j++)
        if (Math.max(Math.abs(nb[i][0] - nb[j][0]), Math.abs(nb[i][1] - nb[j][1])) === 1) parent[find(i)] = find(j);
      if (new Set(nb.map((_, i) => find(i))).size === 1) mask[k] = 0;
    }
    return pts.filter(k => mask[k]);
  }

  trace(mask, pts) {
    // Percorre o esqueleto e devolve polilinhas (listas de [x,y]).
    const { W, H } = this;
    const nbrs = k => { const x = k % W, y = (k / W) | 0, r = [];
      for (const [dx, dy] of NB) { const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && mask[ny * W + nx]) r.push(ny * W + nx); } return r; };
    const deg = k => nbrs(k).length;
    const visitedEdge = new Set();
    const ek = (a, b) => (a < b ? a * 1e8 + b : b * 1e8 + a);
    const polys = [];
    const walk = (start, first) => {
      const poly = [start, first];
      visitedEdge.add(ek(start, first));
      let prev = start, cur = first;
      while (deg(cur) === 2) {
        const nxt = nbrs(cur).find(n => n !== prev && !visitedEdge.has(ek(cur, n)));
        if (nxt === undefined) break;
        visitedEdge.add(ek(cur, nxt));
        poly.push(nxt); prev = cur; cur = nxt;
        if (cur === start) break;
      }
      return poly;
    };
    for (const k of pts) if (deg(k) !== 2)
      for (const n of nbrs(k)) if (!visitedEdge.has(ek(k, n))) polys.push(walk(k, n));
    for (const k of pts) if (deg(k) === 2)  // ciclos fechados (círculos)
      for (const n of nbrs(k)) if (!visitedEdge.has(ek(k, n))) polys.push(walk(k, n));
    return polys.map(p => p.map(k => [k % W, (k / W) | 0]));
  }

  // ---------- DXF (R12, unidades em mm) ----------
  writeDxf(texts, polys, dots, asbuilt) {
    const { W, H } = this;
    const X = px => +(px * MM).toFixed(3);
    const Y = py => +((H - py) * MM).toFixed(3);
    const layers = [
      ['LINHAS', 7], ['SIMBOLOS', 7], ['TEXTO', 7], ['TEXTO_REVISAR', 2],
      ['ASBUILT_VERMELHO', 1], ['ASBUILT_LARANJA', 30], ['ASBUILT_VERDE', 3], ['ASBUILT_AZUL', 5],
    ];
    const d = [];
    const g = (code, val) => d.push(String(code), String(val));
    g(0, 'SECTION'); g(2, 'HEADER');
    g(9, '$ACADVER'); g(1, 'AC1009');
    g(9, '$DWGCODEPAGE'); g(3, 'ANSI_1252');
    g(9, '$EXTMIN'); g(10, 0); g(20, 0); g(30, 0);
    g(9, '$EXTMAX'); g(10, X(W)); g(20, Y(0)); g(30, 0);
    g(0, 'ENDSEC');
    g(0, 'SECTION'); g(2, 'TABLES');
    g(0, 'TABLE'); g(2, 'LAYER'); g(70, layers.length);
    for (const [name, col] of layers) { g(0, 'LAYER'); g(2, name); g(70, 0); g(62, col); g(6, 'CONTINUOUS'); }
    g(0, 'ENDTAB');
    g(0, 'ENDSEC');
    g(0, 'SECTION'); g(2, 'ENTITIES');
    const line = (layer, x1, y1, x2, y2) => { g(0, 'LINE'); g(8, layer); g(10, x1); g(20, y1); g(30, 0); g(11, x2); g(21, y2); g(31, 0); };
    const pline = (layer, pts, closed = false, width = 0, bulge = 0) => {
      g(0, 'POLYLINE'); g(8, layer); g(66, 1); g(10, 0); g(20, 0); g(30, 0); g(70, closed ? 1 : 0);
      if (width) { g(40, width); g(41, width); }
      for (const [x, y] of pts) { g(0, 'VERTEX'); g(8, layer); g(10, x); g(20, y); g(30, 0); if (bulge) g(42, bulge); }
      g(0, 'SEQEND'); g(8, layer);
    };

    for (const s of this.hSegs) line('LINHAS', X(s.a), Y(s.c), X(s.b), Y(s.c));
    for (const s of this.vSegs) line('LINHAS', X(s.c), Y(s.a), X(s.c), Y(s.b));
    for (const p of polys) {
      const closed = p.length > 3 && p[0][0] === p.at(-1)[0] && p[0][1] === p.at(-1)[1];
      pline('SIMBOLOS', (closed ? p.slice(0, -1) : p).map(([x, y]) => [X(x), Y(y)]), closed);
    }
    for (const o of dots) {  // ponto cheio = polilinha circular com largura (como o comando DONUT)
      const r = o.r * MM;
      pline('LINHAS', [[X(o.x) - r / 2, Y(o.y)], [X(o.x) + r / 2, Y(o.y)]], true, r, 1);
    }
    for (const t of texts) {
      const h = +((t.y1 - t.y0) * MM * 0.9).toFixed(3);
      // Início e fim da linha de base; vertical = texto lido de baixo para cima (rotação 90°).
      const [p1, p2] = t.vertical
        ? [[X(t.y1), Y(H - 1 - t.x0)], [X(t.y1), Y(H - 1 - t.x1)]]
        : [[X(t.x0), Y(t.y1)], [X(t.x1), Y(t.y1)]];
      g(0, 'TEXT'); g(8, t.conf >= 60 ? 'TEXTO' : 'TEXTO_REVISAR');
      g(10, p1[0]); g(20, p1[1]); g(30, 0); g(40, h); g(1, t.str);
      if (t.vertical) g(50, 90);
      g(72, 5); g(11, p2[0]); g(21, p2[1]); g(31, 0);  // alinhamento "Fit": ocupa a largura original
    }
    for (const [name, list] of Object.entries(asbuilt))
      for (const p of list) pline(`ASBUILT_${name}`, p.map(([x, y]) => [X(x), Y(y)]));
    g(0, 'ENDSEC'); g(0, 'EOF');

    // DXF R12 usa a página de código Windows-1252; acentos do português cabem em Latin-1.
    const text = d.join('\r\n') + '\r\n';
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); bytes[i] = c < 256 ? c : 63; }
    return bytes;
  }

  // ---------- Prévia do desenho reconstruído (WebP, 1400 px de largura) ----------
  async drawPreview(texts, polys, dots, asbuilt) {
    const { W, H } = this;
    const PW = 1400, k = PW / W, PH = Math.round(H * k);
    const pv = new OffscreenCanvas(PW, PH), pc = pv.getContext('2d');
    pc.fillStyle = '#fff'; pc.fillRect(0, 0, PW, PH);
    pc.scale(k, k);
    pc.lineWidth = 3; pc.strokeStyle = '#000';
    pc.beginPath();
    for (const s of this.hSegs) { pc.moveTo(s.a, s.c); pc.lineTo(s.b, s.c); }
    for (const s of this.vSegs) { pc.moveTo(s.c, s.a); pc.lineTo(s.c, s.b); }
    pc.stroke();
    pc.strokeStyle = '#1452c8'; pc.beginPath();
    for (const p of polys) { pc.moveTo(...p[0]); for (const q of p.slice(1)) pc.lineTo(...q); }
    pc.stroke();
    pc.fillStyle = '#000';
    for (const o of dots) { pc.beginPath(); pc.arc(o.x, o.y, o.r, 0, 7); pc.fill(); }
    for (const t of texts) {
      const h = (t.y1 - t.y0) * 0.9;
      pc.font = `${h}px sans-serif`;
      pc.fillStyle = t.conf >= 60 ? '#0a7a2a' : '#c08000';
      const w = pc.measureText(t.str).width || 1;
      pc.save();
      if (t.vertical) { pc.translate(t.y1, H - 1 - t.x0); pc.rotate(-Math.PI / 2); } else pc.translate(t.x0, t.y1);
      pc.scale((t.x1 - t.x0) / w, 1); pc.fillText(t.str, 0, 0); pc.restore();
    }
    const colors = { VERMELHO: '#e00', LARANJA: '#f80', VERDE: '#0a0', AZUL: '#00f' };
    for (const [name, list] of Object.entries(asbuilt)) {
      pc.strokeStyle = colors[name]; pc.beginPath();
      for (const p of list) { pc.moveTo(...p[0]); for (const q of p.slice(1)) pc.lineTo(...q); }
      pc.stroke();
    }
    return pv.convertToBlob({ type: 'image/webp', quality: 0.8 });
  }
}

// ---------- Funções de linha reta (independentes do tamanho da folha) ----------
function runSegments(m, w, h) {
  // Agrupa sequências longas de pixels por linha em segmentos (com espessura).
  let active = [];
  const out = [];
  for (let y = 0; y < h; y++) {
    const row = y * w, next = [];
    for (let x = 0; x < w;) {
      if (!m[row + x]) { x++; continue; }
      const s = x;
      while (x < w && m[row + x]) x++;
      if (x - s < MIN_LINE) continue;
      const e = x - 1;
      const seg = active.find(a => !a.used && Math.min(a.x1, e) - Math.max(a.x0, s) > 0.6 * Math.min(a.x1 - a.x0, e - s));
      if (seg) {
        seg.used = true; seg.x0 = Math.min(seg.x0, s); seg.x1 = Math.max(seg.x1, e);
        seg.y1 = y; seg.ys += y * (e - s + 1); seg.n += e - s + 1;
        next.push(seg);
      } else next.push({ x0: s, x1: e, y0: y, y1: y, ys: y * (e - s + 1), n: e - s + 1, used: true });
    }
    for (const a of active) if (!a.used) out.push(a);
    for (const a of next) a.used = false;
    active = next;
  }
  out.push(...active);
  return out
    .filter(s => s.y1 - s.y0 + 1 <= MAX_THICK)
    .map(s => ({ a: s.x0, b: s.x1, c: s.ys / s.n, y0: s.y0, y1: s.y1 }));
}

function mergeCollinear(segs) {
  // Une pedaços quase colineares separados por falhas pequenas (efeito da digitalização).
  segs.sort((p, q) => p.c - q.c || p.a - q.a);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (!s) continue;
      for (let j = i + 1; j < segs.length; j++) {
        const t = segs[j];
        if (!t) continue;
        if (t.c - s.c > 4) break;
        if (Math.max(s.a, t.a) - Math.min(s.b, t.b) <= 4) {
          const ls = s.b - s.a, lt = t.b - t.a;
          s.c = (s.c * ls + t.c * lt) / (ls + lt);
          s.a = Math.min(s.a, t.a); s.b = Math.max(s.b, t.b);
          s.y0 = Math.min(s.y0, t.y0); s.y1 = Math.max(s.y1, t.y1);
          segs[j] = null; changed = true;
        }
      }
    }
    segs = segs.filter(Boolean);
    segs.sort((p, q) => p.c - q.c || p.a - q.a);
  }
  // Pedaços paralelos colados a uma linha maior (bordas irregulares do traço) são absorvidos por ela.
  segs.sort((p, q) => (q.b - q.a) - (p.b - p.a));
  const kept = [];
  for (const s of segs) {
    const host = kept.find(k => Math.abs(k.c - s.c) <= 12 && Math.min(k.b, s.b) - Math.max(k.a, s.a) > 0);
    if (!host) { kept.push(s); continue; }
    host.a = Math.min(host.a, s.a); host.b = Math.max(host.b, s.b);
    host.y0 = Math.min(host.y0, s.y0); host.y1 = Math.max(host.y1, s.y1);
  }
  return kept;
}

// Encaixar pontas em linhas perpendiculares próximas (T e cantos).
function snap(segs, perp) {
  const SNAP = 8;
  for (const s of segs) for (const end of ['a', 'b']) {
    let best = null, bd = SNAP + 1;
    for (const p of perp) {
      if (s.c < p.a - SNAP || s.c > p.b + SNAP) continue;
      const d = Math.abs(p.c - s[end]);
      if (d < bd) { bd = d; best = p; }
    }
    if (best) s[end] = best.c;
  }
}

function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
  const L = Math.hypot(bx - ax, by - ay) || 1;
  let dmax = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = L === 1 && ax === bx && ay === by
      ? Math.hypot(pts[i][0] - ax, pts[i][1] - ay)
      : Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / L;
    if (d > dmax) { dmax = d; idx = i; }
  }
  if (dmax <= eps) return [pts[0], pts[pts.length - 1]];
  return simplify(pts.slice(0, idx + 1), eps).slice(0, -1).concat(simplify(pts.slice(idx), eps));
}

function polyLen(p) {
  return p.slice(1).reduce((s, q, i) => s + Math.hypot(q[0] - p[i][0], q[1] - p[i][1]), 0);
}
