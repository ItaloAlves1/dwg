// Web Worker: vetoriza uma folha escaneada (pixels → linhas, círculos, símbolos, textos) e gera o DXF.
// O OCR fica na página principal (Tesseract.js já usa seus próprios workers), então o
// trabalho é dividido em três etapas:
//   'preparar'  pixels da folha → imagens para o OCR (original endireitada, sem linhas, girada 90°)
//   'textos'    OCR da folha → recortes ampliados dos textos pequenos que sobraram (bornes, números)
//   'finalizar' OCR dos recortes → DXF + prévia (WebP) + estatísticas
'use strict';

const DPI = 300;
const MM = 25.4 / DPI;            // mm por pixel
const MIN_LINE = 30;              // comprimento mínimo de linha reta (px ≈ 2.5 mm)
const MAX_THICK = 14;             // espessura máxima de uma linha (px)
const NB = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]; // vizinhos P2..P9

const pages = new Map();          // id → estado entre as etapas

self.onmessage = async ({ data: msg }) => {
  try {
    if (msg.type === 'preparar') {
      const page = new Folha(msg.width, msg.height, new Uint8ClampedArray(msg.buffer));
      pages.set(msg.id, page);
      const imagens = await page.preparar();
      self.postMessage({ id: msg.id, ok: true, imagens });
    } else if (msg.type === 'textos') {
      const recortes = await pages.get(msg.id).textos(msg.ocr);
      self.postMessage({ id: msg.id, ok: true, recortes });
    } else if (msg.type === 'finalizar') {
      const page = pages.get(msg.id);
      pages.delete(msg.id);
      const result = await page.finalizar(msg.curtos || [], msg.larguraPrevia);
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

  // ---------- Etapa 1: limpeza, endireitamento, linhas, tracejados, pontos ----------
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
    const blackT = transpor(this.black, W, H);
    this.hSegs = mergeCollinear(runSegments(this.black, W, H));   // a,b = x;  c = y
    this.vSegs = mergeCollinear(runSegments(blackT, H, W));       // a,b = y;  c = x
    snap(this.hSegs, this.vSegs);
    snap(this.vSegs, this.hSegs);

    // Máscara residual = tinta preta menos as linhas detectadas.
    const resid = this.resid = this.black.slice();
    this.apagarSegs(this.hSegs, false);
    this.apagarSegs(this.vSegs, true);

    // Pontos de ligação (●): o que sobra após erodir a tinta com um quadrado 9x9.
    this.dots = [];
    const R = 4, er = new Uint8Array(W * H), er2 = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) { let run = 0; for (let x = 0; x < W; x++) { run = this.black[y * W + x] ? run + 1 : 0; if (run > 2 * R) er[y * W + x - R] = 1; } }
    for (let x = 0; x < W; x++) { let run = 0; for (let y = 0; y < H; y++) { run = er[y * W + x] ? run + 1 : 0; if (run > 2 * R) er2[(y - R) * W + x] = 1; } }
    for (const c of this.components(er2)) {
      const w = c.maxx - c.minx + 1, h = c.maxy - c.miny + 1;
      if (w > 12 || h > 12 || Math.abs(w - h) > 4) continue;
      const cx = (c.minx + c.maxx) / 2, cy = (c.miny + c.maxy) / 2, r = (w + h) / 4 + R + 0.5;
      if (!this.anelVazio(cx, cy, r)) continue;
      this.dots.push({ x: cx, y: cy, r });
      for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++)
        if (x >= 0 && y >= 0 && x < W && y < H && Math.hypot(x - cx, y - cy) <= r + 1.5) resid[y * W + x] = 0;
    }

    // Imagens para o OCR: original endireitada, sem linhas, e sem linhas girada 90° (textos verticais).
    const clean = mascaraParaCanvas(resid, W, H);
    const rot = new OffscreenCanvas(H, W), rc = rot.getContext('2d');
    rc.translate(H, 0); rc.rotate(Math.PI / 2); rc.drawImage(clean, 0, 0);
    return {
      original: await canvas.convertToBlob({ type: 'image/png' }),
      limpa: await clean.convertToBlob({ type: 'image/png' }),
      girada: await rot.convertToBlob({ type: 'image/png' }),
    };
  }

  // Linhas tracejadas: traços alinhados, isolados e espaçados com regularidade viram uma linha só.
  // Roda depois do OCR, com as letras reconhecidas já removidas da máscara.
  detectarTracejadas() {
    const { W, H, resid } = this;
    // Traço de tracejado é isolado: nada encostado dos lados. A haste ou a barra de uma letra
    // ("B", "E") tem o resto da letra colado e não pode ser confundida com tracejado.
    const isolado = (s, vertical) => {
      const lim = vertical ? W : H;
      let n = 0, tot = 0;
      for (let t = Math.ceil(s.a) + 2; t <= s.b - 2; t++) for (const k of [s.y0 - 4, s.y0 - 3, s.y1 + 3, s.y1 + 4]) {
        if (k < 0 || k >= lim) continue;
        tot++;
        if (vertical ? this.black[t * W + k] : this.black[k * W + t]) n++;
      }
      return tot > 0 && n / tot < 0.08;
    };
    // Faixas escuras na borda do escaneamento (sombra do papel) não são desenho.
    const naBorda = (s, vertical) => {
      const lim = vertical ? W : H, m = 0.025 * lim;
      return s.c < m || s.c > lim - m;
    };
    this.tracejadas = [];
    for (const vertical of [false, true]) {
      const [w, h] = vertical ? [H, W] : [W, H];
      const base = vertical ? transpor(resid, W, H) : resid;
      const ok = s => isolado(s, vertical) && !naBorda(s, vertical);
      const curtos = runSegments(base, w, h, 8, 220, 9).filter(ok);
      const longos = (vertical ? this.vSegs : this.hSegs).filter(s => s.b - s.a <= 220 && ok(s));
      for (const cadeia of encadear([...curtos.map(s => ({ ...s, longo: false })), ...longos.map(s => ({ ...s, ref: s, longo: true }))])) {
        this.tracejadas.push({ vertical, a: cadeia.a, b: cadeia.b, c: cadeia.c, traco: cadeia.traco, vao: cadeia.vao });
        const usados = new Set(cadeia.itens.filter(i => i.longo).map(i => i.ref));
        if (vertical) this.vSegs = this.vSegs.filter(s => !usados.has(s)); else this.hSegs = this.hSegs.filter(s => !usados.has(s));
        this.apagarSegs(cadeia.itens.filter(i => !i.longo), vertical);
      }
    }
  }

  // Ponto de ligação tem em volta só os fios que chegam nele: num anel logo fora do ponto,
  // a tinta é pouca. Letra em negrito tem o resto da letra colado e enche o anel.
  anelVazio(cx, cy, r) {
    const { W, H } = this;
    let tinta = 0, total = 0;
    for (let a = 0; a < 360; a += 6) for (const rr of [r + 2.5, r + 4]) {
      const x = Math.round(cx + rr * Math.cos(a * Math.PI / 180)), y = Math.round(cy + rr * Math.sin(a * Math.PI / 180));
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      total++; if (this.black[y * W + x]) tinta++;
    }
    if (!total || tinta / total > 0.4) return false;
    // Redondo: os quatro cantos do quadrado em volta ficam vazios (fios chegam na horizontal ou
    // na vertical). Parte grossa de letra é quadrada e preenche os cantos.
    let cantos = 0;
    for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const x = Math.round(cx + sx * 1.1 * r), y = Math.round(cy + sy * 1.1 * r);
      if (x >= 0 && y >= 0 && x < W && y < H && this.black[y * W + x]) cantos++;
    }
    return cantos <= 1;
  }

  // Remove da máscara residual os pixels de segmentos (com folga de 2 px).
  apagarSegs(segs, vertical) {
    const { W, H, resid } = this, PAD = 2;
    for (const s of segs) for (let k = s.y0 - PAD; k <= s.y1 + PAD; k++) {
      if (k < 0 || k >= (vertical ? W : H)) continue;
      const fim = Math.min((vertical ? H : W) - 1, Math.ceil(s.b) + 1);
      for (let t = Math.max(0, Math.floor(s.a) - 1); t <= fim; t++) resid[vertical ? t * W + k : k * W + t] = 0;
    }
  }

  // Tinta preta com limiar adaptativo: cada pixel é comparado com a média da vizinhança (41x41),
  // o que recupera linhas desbotadas sem transformar a textura do papel em sujeira.
  buildMasks(rgba) {
    const { W, H, black, colorCat } = this;
    black.fill(0); colorCat.fill(0);
    const lum = new Uint8Array(W * H);
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
        lum[i] = 255;
      } else lum[i] = 0.3 * r + 0.59 * g + 0.11 * b;
    }
    // Imagem integral para a média local em tempo constante.
    const W1 = W + 1, I = new Uint32Array(W1 * (H + 1));
    for (let y = 0; y < H; y++) {
      let linha = 0;
      for (let x = 0; x < W; x++) { linha += lum[y * W + x]; I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + linha; }
    }
    const R = 20;
    for (let y = 0; y < H; y++) {
      const y0 = Math.max(0, y - R), y1 = Math.min(H, y + R + 1);
      for (let x = 0; x < W; x++) {
        // Limites medidos nas folhas: vãos de tracejado ficam entre 190 e 230 e não podem virar tinta.
        const v = lum[y * W + x];
        if (v >= 185) continue;
        if (v < 110) { black[y * W + x] = 1; continue; }
        const x0 = Math.max(0, x - R), x1 = Math.min(W, x + R + 1);
        const media = (I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0]) / ((x1 - x0) * (y1 - y0));
        if (v < media - 40) black[y * W + x] = 1;
      }
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

  // ---------- Etapa 2: textos do OCR e recortes dos textos pequenos ----------
  async textos(ocr) {
    const { W, H, resid } = this;

    // Textos lidos: original, sem linhas e girada. Nas sobreposições fica a leitura mais confiável.
    const JUNK = /^[\s|I1l!\-—–_.,'`~:;"()\[\]{}\\/=+*<>]*$/;
    // Cada linha é dividida em trechos de palavras confiáveis: uma palavra ruim ("PETS" lido numa
    // caixa de relé) é descartada sem levar junto as boas da mesma linha.
    const trechos = line => {
      const ws = line.words?.length ? line.words : [line];
      const out = [];
      let atual = null;
      for (const w of ws) {
        if (w.confidence < 55 || !w.text.trim()) { atual = null; continue; }
        if (!atual) { atual = { ws: [] }; out.push(atual); }
        atual.ws.push(w);
      }
      return out.map(({ ws: g }) => ({
        text: g.map(w => w.text).join(' '),
        confidence: g.reduce((s, w) => s + w.confidence, 0) / g.length,
        bbox: { x0: Math.min(...g.map(w => w.bbox.x0)), y0: Math.min(...g.map(w => w.bbox.y0)), x1: Math.max(...g.map(w => w.bbox.x1)), y1: Math.max(...g.map(w => w.bbox.y1)) },
      }));
    };
    let texts = [];
    for (const { lines, vertical, original } of ocr) for (const line of lines.flatMap(trechos)) {
      const str = line.text.trim();
      // Abaixo de 55% de confiança a leitura quase sempre é lixo ("16AE: N" em cima de um contato);
      // nesse caso o traço fica como símbolo, que é mais fiel ao original.
      if (!str || JUNK.test(str) || line.confidence < (vertical ? 60 : 55)) continue;
      const { x0, y0, x1, y1 } = line.bbox;
      if (y1 - y0 < 8 || y1 - y0 > 90) continue;
      if (vertical && str.replace(/\W/g, '').length < 3) continue;
      // Desenhos técnicos usam só maiúsculas: minúsculas com confiança baixa quase sempre são símbolos mal lidos.
      if (/[a-zà-ú]/.test(str) && line.confidence < 75) continue;
      // Uma ou duas letras sem número costumam ser pedaços de símbolo (lâmina de contato lida como "W").
      if (str.replace(/[^A-Za-z0-9]/g, '').length <= 2 && !/\d/.test(str) && line.confidence < 90) continue;
      // A imagem sem linhas pode cortar letras encostadas nelas; em empate, prefere a leitura da original.
      texts.push({ str, x0, y0, x1, y1, conf: line.confidence + (original ? 10 : 0), vertical });
    }
    // Texto muito mais alto que o normal da folha costuma ser o OCR "lendo" um símbolo
    // ("589 (O A" em cima de uma seccionadora); só fica se a confiança for altíssima.
    const alturas = texts.map(t => (t.vertical ? t.x1 - t.x0 : t.y1 - t.y0)).sort((a, b) => a - b);
    const mediana = alturas[alturas.length >> 1] || 0;
    if (mediana) texts = texts.filter(t => (t.vertical ? t.x1 - t.x0 : t.y1 - t.y0) <= 1.7 * mediana || t.conf >= 92);
    this.texts = semSobreposicao(texts, H);
    this.apagarTextos(this.texts.filter(t => t.conf >= 60));

    // Grupos pequenos de "caracteres" que o OCR não leu (números de bornes, 13/14, 21/22…):
    // recorta, amplia e devolve para uma segunda leitura, palavra por palavra.
    const comps = this.components(resid).filter(c => {
      const w = c.maxx - c.minx + 1, h = c.maxy - c.miny + 1;
      return h >= 9 && h <= 45 && w >= 2 && w <= 45 && w <= 2.5 * h && c.px.length >= 12 && c.px.length <= 0.75 * w * h;
    }).sort((p, q) => p.minx - q.minx);
    const grupos = [];
    for (const c of comps) {
      const h = c.maxy - c.miny + 1;
      const g = grupos.find(g => {
        const gh = g.maxy - g.miny + 1;
        const sobre = Math.min(g.maxy, c.maxy) - Math.max(g.miny, c.miny);
        return sobre > 0.5 * Math.min(gh, h) && c.minx - g.maxx <= 0.8 * Math.max(gh, h) && c.minx - g.maxx >= -2 && Math.abs(gh - h) < 0.6 * Math.max(gh, h);
      });
      if (g) { g.minx = Math.min(g.minx, c.minx); g.maxx = Math.max(g.maxx, c.maxx); g.miny = Math.min(g.miny, c.miny); g.maxy = Math.max(g.maxy, c.maxy); g.n++; }
      else grupos.push({ minx: c.minx, maxx: c.maxx, miny: c.miny, maxy: c.maxy, n: 1 });
    }
    const recortes = [];
    for (const [i, g] of grupos.entries()) {
      const w = g.maxx - g.minx + 1, h = g.maxy - g.miny + 1;
      if (g.n > 10 || w > 12 * h) continue;
      const esc = Math.max(2, Math.min(4, Math.round(56 / h)));  // altura final ~56 px, boa para o Tesseract
      const P = 3, M = 20;
      const sw = w + 2 * P, sh = h + 2 * P;
      const img = new ImageData(sw, sh);
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
        const X = g.minx - P + x, Y = g.miny - P + y;
        const v = X >= 0 && Y >= 0 && X < W && Y < H && resid[Y * W + X] ? 0 : 255;
        const k = (y * sw + x) * 4; img.data[k] = img.data[k + 1] = img.data[k + 2] = v; img.data[k + 3] = 255;
      }
      const pequeno = new OffscreenCanvas(sw, sh); pequeno.getContext('2d').putImageData(img, 0, 0);
      const grande = new OffscreenCanvas(sw * esc + 2 * M, sh * esc + 2 * M), gc = grande.getContext('2d');
      gc.fillStyle = '#fff'; gc.fillRect(0, 0, grande.width, grande.height);
      gc.imageSmoothingEnabled = true; gc.imageSmoothingQuality = 'high';
      gc.drawImage(pequeno, M, M, sw * esc, sh * esc);
      recortes.push({ id: i, n: g.n, x0: g.minx, y0: g.miny, x1: g.maxx, y1: g.maxy, imagem: await grande.convertToBlob({ type: 'image/png' }) });
      if (recortes.length >= 300) break;
    }
    return recortes;
  }

  apagarTextos(lista) {
    const { W, H, resid } = this;
    for (const t of lista) {
      const a = areaTexto(t, H);
      for (let y = Math.max(0, a.y0); y <= Math.min(H - 1, a.y1); y++)
        for (let x = Math.max(0, a.x0); x <= Math.min(W - 1, a.x1); x++) resid[y * W + x] = 0;
    }
  }

  // ---------- Etapa 3: textos pequenos, círculos, símbolos, as-built, DXF e prévia ----------
  async finalizar(curtos, larguraPrevia = 1400) {
    const { W, H, resid } = this;

    // Segunda leitura: só aceita o que parece rótulo técnico (com algum número, como bornes e
    // referências) e tem o número de caracteres esperado. Letras soltas costumam ser pedaços de
    // símbolos (a lâmina de um contato é lida como "W" ou "V") e não podem apagar o desenho.
    const novos = [];
    for (const r of curtos) {
      const str = (r.text || '').trim().replace(/\s+/g, '');
      if (!str || r.confidence < 70 || str.length > 12) continue;
      if (!/^[A-Z0-9][A-Z0-9\-\/.:()+]*$/.test(str) || !/\d/.test(str)) continue;
      if (Math.abs(str.length - r.n) > Math.max(1, Math.round(r.n * 0.5))) continue;
      novos.push({ str, x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, conf: r.confidence, vertical: false, curto: true });
    }
    this.texts.push(...novos);
    this.apagarTextos(novos);
    const texts = this.texts;
    this.detectarTracejadas();

    // Símbolos restantes: círculos e arcos viram entidades geométricas; o resto, polilinhas retificadas.
    const sym = this.vectorize(resid, 4, true);
    const { circulos, arcos: soltos } = juntarArcos(sym.arcos);
    circulos.push(...sym.circulos);
    // Terminal (○) atravessado por um fio: metade do círculo some junto com o fio. Se um arco
    // pequeno com pelo menos 150° tem um fio passando pelo centro, ele é o círculo completo.
    const arcos = [];
    for (const a of soltos) {
      const noFio = a.r <= 15 && a.span >= 150 && (
        this.vSegs.some(s => Math.abs(s.c - a.cx) <= 0.6 * a.r && a.cy >= s.a - a.r && a.cy <= s.b + a.r) ||
        this.hSegs.some(s => Math.abs(s.c - a.cy) <= 0.6 * a.r && a.cx >= s.a - a.r && a.cx <= s.b + a.r));
      if (noFio) circulos.push({ cx: a.cx, cy: a.cy, r: a.r, span: 360 }); else arcos.push(a);
    }
    const dots = this.dots.concat(sym.dots);
    const asbuilt = {};
    for (const [cat, name] of [[1, 'VERMELHO'], [2, 'LARANJA'], [3, 'VERDE'], [4, 'AZUL']]) {
      const m = new Uint8Array(W * H);
      let n = 0;
      for (let i = 0; i < W * H; i++) if (this.colorCat[i] === cat) { m[i] = 1; n++; }
      if (n >= 200) asbuilt[name] = this.vectorize(m, 10, false).polys;
    }

    const geo = { texts, polys: sym.polys, dots, asbuilt, circulos, arcos };
    const dxf = this.writeDxf(geo);
    const preview = await this.drawPreview(geo, larguraPrevia);
    const stats = {
      linhas: this.hSegs.length + this.vSegs.length, tracejadas: this.tracejadas.length,
      circulos: circulos.length, arcos: arcos.length, simbolos: sym.polys.length, pontos: dots.length,
      textos: texts.length, textosPequenos: novos.length, revisar: texts.filter(t => t.conf < 60).length,
      asbuilt: Object.fromEntries(Object.entries(asbuilt).map(([k, v]) => [k, v.length])),
      inclinacao: +this.skew.toFixed(2),
    };
    return { dxf, preview, stats };
  }

  vectorize(mask, minLen, geometrico) {
    const out = { polys: [], dots: [], circulos: [], arcos: [] };
    const mx = 0.025 * this.W, my = 0.025 * this.H;
    for (const c of this.components(mask)) {
      const w = c.maxx - c.minx + 1, h = c.maxy - c.miny + 1;
      if (c.px.length < 6) continue;                               // poeira
      // Manchas inteiramente na margem do escaneamento (sombra, furo, borda do papel).
      if (c.maxx < mx || c.minx > this.W - mx || c.maxy < my || c.miny > this.H - my) continue;
      if (w >= 7 && h >= 7 && w <= 26 && h <= 26 && Math.abs(w - h) <= 4 && c.px.length / (w * h) > 0.6) {
        const d = { x: (c.minx + c.maxx) / 2, y: (c.miny + c.maxy) / 2, r: (w + h) / 4 };
        if (!geometrico || this.anelVazio(d.x, d.y, d.r)) { out.dots.push(d); continue; }  // ponto de ligação
      }
      const sk = this.thin(mask, c.px);
      for (const p of this.trace(mask, sk)) {
        if (geometrico) {
          const fit = ajustarCirculo(p, this.H);
          if (fit) { (fit.span >= 320 ? out.circulos : out.arcos).push(fit); continue; }
        }
        const s = simplify(p, 1.3);
        if (polyLen(s) >= minLen) out.polys.push(geometrico ? retificar(s) : s);
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
  writeDxf({ texts, polys, dots, asbuilt, circulos, arcos }) {
    const { W, H } = this;
    const X = px => +(px * MM).toFixed(3);
    const Y = py => +((H - py) * MM).toFixed(3);
    const layers = [
      ['LINHAS', 7, 'CONTINUOUS'], ['LINHAS_TRACEJADAS', 7, 'TRACEJADA'], ['CIRCULOS', 7, 'CONTINUOUS'],
      ['SIMBOLOS', 7, 'CONTINUOUS'], ['TEXTO', 7, 'CONTINUOUS'], ['TEXTO_REVISAR', 2, 'CONTINUOUS'],
      ['ASBUILT_VERMELHO', 1, 'CONTINUOUS'], ['ASBUILT_LARANJA', 30, 'CONTINUOUS'], ['ASBUILT_VERDE', 3, 'CONTINUOUS'], ['ASBUILT_AZUL', 5, 'CONTINUOUS'],
    ];
    // Padrão do tracejado igual ao medido na folha (mediana dos traços e vãos).
    const med = v => (v.length ? v.sort((a, b) => a - b)[v.length >> 1] : 0);
    const traco = +(med(this.tracejadas.map(t => t.traco)) * MM || 2.5).toFixed(2);
    const vao = +(med(this.tracejadas.map(t => t.vao)) * MM || 1.25).toFixed(2);

    const d = [];
    const g = (code, val) => d.push(String(code), String(val));
    g(0, 'SECTION'); g(2, 'HEADER');
    g(9, '$ACADVER'); g(1, 'AC1009');
    g(9, '$DWGCODEPAGE'); g(3, 'ANSI_1252');
    g(9, '$LTSCALE'); g(40, 1);
    g(9, '$EXTMIN'); g(10, 0); g(20, 0); g(30, 0);
    g(9, '$EXTMAX'); g(10, X(W)); g(20, Y(0)); g(30, 0);
    g(0, 'ENDSEC');
    g(0, 'SECTION'); g(2, 'TABLES');
    g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 2);
    g(0, 'LTYPE'); g(2, 'CONTINUOUS'); g(70, 0); g(3, 'Solid line'); g(72, 65); g(73, 0); g(40, 0);
    g(0, 'LTYPE'); g(2, 'TRACEJADA'); g(70, 0); g(3, '__ __ __'); g(72, 65); g(73, 2); g(40, +(traco + vao).toFixed(2)); g(49, traco); g(49, -vao);
    g(0, 'ENDTAB');
    g(0, 'TABLE'); g(2, 'LAYER'); g(70, layers.length);
    for (const [name, col, lt] of layers) { g(0, 'LAYER'); g(2, name); g(70, 0); g(62, col); g(6, lt); }
    g(0, 'ENDTAB');
    // Fonte técnica do AutoCAD (romans.shx), parecida com a letra dos desenhos.
    g(0, 'TABLE'); g(2, 'STYLE'); g(70, 1);
    g(0, 'STYLE'); g(2, 'STANDARD'); g(70, 0); g(40, 0); g(41, 1); g(50, 0); g(71, 0); g(42, 2.5); g(3, 'romans.shx'); g(4, '');
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
    for (const t of this.tracejadas) t.vertical
      ? line('LINHAS_TRACEJADAS', X(t.c), Y(t.a), X(t.c), Y(t.b))
      : line('LINHAS_TRACEJADAS', X(t.a), Y(t.c), X(t.b), Y(t.c));
    for (const c of circulos) { g(0, 'CIRCLE'); g(8, 'CIRCULOS'); g(10, X(c.cx)); g(20, Y(c.cy)); g(30, 0); g(40, +(c.r * MM).toFixed(3)); }
    for (const a of arcos) {
      g(0, 'ARC'); g(8, 'CIRCULOS'); g(10, X(a.cx)); g(20, Y(a.cy)); g(30, 0); g(40, +(a.r * MM).toFixed(3));
      g(50, +a.inicio.toFixed(2)); g(51, +a.fim.toFixed(2));
    }
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
      if (t.str.length === 1) continue;  // um caractere só: alinhamento simples (o "Fit" distorceria)
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

  // ---------- Prévia do desenho reconstruído (WebP) ----------
  async drawPreview({ texts, polys, dots, asbuilt, circulos, arcos }, largura) {
    const { W, H } = this;
    const PW = Math.min(largura, W), k = PW / W, PH = Math.round(H * k);
    const pv = new OffscreenCanvas(PW, PH), pc = pv.getContext('2d');
    pc.fillStyle = '#fff'; pc.fillRect(0, 0, PW, PH);
    pc.scale(k, k);
    pc.lineWidth = 3; pc.strokeStyle = '#000'; pc.lineCap = 'round';
    pc.beginPath();
    for (const s of this.hSegs) { pc.moveTo(s.a, s.c); pc.lineTo(s.b, s.c); }
    for (const s of this.vSegs) { pc.moveTo(s.c, s.a); pc.lineTo(s.c, s.b); }
    pc.stroke();
    for (const t of this.tracejadas) {
      pc.setLineDash([t.traco, t.vao]); pc.beginPath();
      if (t.vertical) { pc.moveTo(t.c, t.a); pc.lineTo(t.c, t.b); } else { pc.moveTo(t.a, t.c); pc.lineTo(t.b, t.c); }
      pc.stroke();
    }
    pc.setLineDash([]);
    pc.strokeStyle = '#7a1fa2'; pc.lineWidth = 2.5;
    for (const c of circulos) { pc.beginPath(); pc.arc(c.cx, c.cy, c.r, 0, 2 * Math.PI); pc.stroke(); }
    for (const a of arcos) { pc.beginPath(); pc.arc(a.cx, a.cy, a.r, -a.inicio * Math.PI / 180, -a.fim * Math.PI / 180, true); pc.stroke(); }
    pc.strokeStyle = '#1452c8'; pc.lineWidth = 2.5; pc.beginPath();
    for (const p of polys) { pc.moveTo(...p[0]); for (const q of p.slice(1)) pc.lineTo(...q); }
    pc.stroke();
    pc.fillStyle = '#000';
    for (const o of dots) { pc.beginPath(); pc.arc(o.x, o.y, o.r, 0, 7); pc.fill(); }
    for (const t of texts) {
      const h = (t.y1 - t.y0) * 0.9;
      pc.font = `${h}px sans-serif`;
      pc.fillStyle = t.conf >= 60 ? (t.curto ? '#b5006b' : '#0a7a2a') : '#c08000';
      const w = pc.measureText(t.str).width || 1;
      pc.save();
      if (t.vertical) { pc.translate(t.y1, H - 1 - t.x0); pc.rotate(-Math.PI / 2); } else pc.translate(t.x0, t.y1);
      if (t.str.length > 1) pc.scale((t.x1 - t.x0) / w, 1);
      pc.fillText(t.str, 0, 0); pc.restore();
    }
    const colors = { VERMELHO: '#e00', LARANJA: '#f80', VERDE: '#0a0', AZUL: '#00f' };
    for (const [name, list] of Object.entries(asbuilt)) {
      pc.strokeStyle = colors[name]; pc.beginPath();
      for (const p of list) { pc.moveTo(...p[0]); for (const q of p.slice(1)) pc.lineTo(...q); }
      pc.stroke();
    }
    return pv.convertToBlob({ type: 'image/webp', quality: 0.85 });
  }
}

// ---------- Utilidades ----------
function transpor(m, W, H) {
  const t = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) t[x * H + y] = m[y * W + x];
  return t;
}

function mascaraParaCanvas(m, W, H) {
  const c = new OffscreenCanvas(W, H);
  const img = new ImageData(W, H);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) { const v = m[i] ? 0 : 255; img.data[p] = img.data[p + 1] = img.data[p + 2] = v; img.data[p + 3] = 255; }
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
}

// Retângulo da página ocupado por um texto (os verticais vêm em coordenadas da imagem girada).
function areaTexto(t, H) {
  return t.vertical ? { x0: t.y0, x1: t.y1, y0: H - 1 - t.x1, y1: H - 1 - t.x0 } : t;
}

// Leituras sobrepostas (mesmo texto lido duas vezes, ou vertical lido na horizontal): fica a mais confiável.
function semSobreposicao(texts, H) {
  const ov = (p, q) => Math.max(0, Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0)) * Math.max(0, Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0));
  texts.sort((p, q) => q.conf - p.conf);
  const kept = [];
  for (const t of texts) {
    const a = areaTexto(t, H), size = (a.x1 - a.x0) * (a.y1 - a.y0);
    if (!kept.some(u => { const b = areaTexto(u, H); return ov(a, b) > 0.3 * Math.min(size, (b.x1 - b.x0) * (b.y1 - b.y0)); })) kept.push(t);
  }
  return kept;
}

function runSegments(m, w, h, minLen = MIN_LINE, maxLen = Infinity, maxThick = MAX_THICK) {
  // Agrupa sequências longas de pixels por linha em segmentos (com espessura).
  let active = [];
  const out = [];
  for (let y = 0; y < h; y++) {
    const row = y * w, next = [];
    for (let x = 0; x < w;) {
      if (!m[row + x]) { x++; continue; }
      const s = x;
      while (x < w && m[row + x]) x++;
      if (x - s < minLen) continue;
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
    .filter(s => s.y1 - s.y0 + 1 <= maxThick && s.x1 - s.x0 <= maxLen)
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

// Encadeia traços colineares com tamanho e espaçamento regulares em linhas tracejadas.
// Exige pelo menos 3 traços parecidos para não confundir com barras de letras.
function encadear(cands) {
  cands.sort((p, q) => p.c - q.c || p.a - q.a);
  const usado = new Set(), cadeias = [];
  for (let i = 0; i < cands.length; i++) {
    if (usado.has(i)) continue;
    const itens = [cands[i]], idx = [i];
    for (;;) {
      const ult = itens.at(-1);
      let melhor = -1, menor = Infinity;
      for (let j = 0; j < cands.length; j++) {
        if (usado.has(j) || idx.includes(j)) continue;
        const t = cands[j];
        if (Math.abs(t.c - ult.c) > 3) continue;
        const vao = t.a - ult.b;
        if (vao < 3 || vao > 60) continue;
        if (vao < menor) { menor = vao; melhor = j; }
      }
      if (melhor < 0) break;
      itens.push(cands[melhor]); idx.push(melhor);
    }
    if (itens.length < 3) continue;
    const tracos = itens.map(t => t.b - t.a), vaos = itens.slice(1).map((t, k) => t.a - itens[k].b);
    const reg = v => Math.max(...v) / Math.max(1, Math.min(...v));
    if (Math.min(...tracos) < 8 || reg(tracos) > 3 || reg(vaos) > 3 || itens.at(-1).b - itens[0].a < 80) continue;
    idx.forEach(k => usado.add(k));
    const media = v => v.reduce((s, x) => s + x, 0) / v.length;
    cadeias.push({ itens, a: itens[0].a, b: itens.at(-1).b, c: media(itens.map(t => t.c)), traco: media(tracos), vao: media(vaos) });
  }
  return cadeias;
}

// Ajuste de círculo por mínimos quadrados (método de Kåsa). Devolve círculo/arco se o traço
// for de fato circular: raio entre 3 e 80 px, erro pequeno e pelo menos 100° de volta.
function ajustarCirculo(pts, H) {
  const n = pts.length;
  if (n < 10) return null;
  let mx = 0, my = 0;
  for (const [x, y] of pts) { mx += x; my += y; }
  mx /= n; my /= n;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const [x, y] of pts) {
    const u = x - mx, v = y - my;
    suu += u * u; svv += v * v; suv += u * v; suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-6) return null;
  const b1 = 0.5 * (suuu + suvv), b2 = 0.5 * (svvv + svuu);
  const uc = (b1 * svv - b2 * suv) / det, vc = (suu * b2 - suv * b1) / det;
  const cx = uc + mx, cy = vc + my, r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
  if (!(r >= 3 && r <= 80)) return null;
  let erro = 0;
  for (const [x, y] of pts) erro += (Math.hypot(x - cx, y - cy) - r) ** 2;
  if (Math.sqrt(erro / n) > Math.max(0.7, 0.07 * r)) return null;
  // Ângulos no sistema do DXF (y para cima); a maior lacuna define onde o arco começa e termina.
  const ang = pts.map(([x, y]) => ((Math.atan2(-(y - cy), x - cx) * 180 / Math.PI) + 360) % 360).sort((a, b) => a - b);
  let lacuna = 360 - ang.at(-1) + ang[0], k = ang.length - 1;
  for (let i = 0; i < ang.length - 1; i++) if (ang[i + 1] - ang[i] > lacuna) { lacuna = ang[i + 1] - ang[i]; k = i; }
  const span = 360 - lacuna;
  if (span < 100) return null;
  return { cx, cy, r, span, inicio: ang[(k + 1) % ang.length], fim: ang[k] };
}

// Arcos do mesmo círculo (cortado por uma linha que passa por ele) são remontados num círculo.
function juntarArcos(arcos) {
  const circulos = [], resto = [], usado = new Set();
  for (let i = 0; i < arcos.length; i++) {
    if (usado.has(i)) continue;
    const a = arcos[i], grupo = [a];
    for (let j = i + 1; j < arcos.length; j++) {
      const b = arcos[j];
      if (usado.has(j)) continue;
      if (Math.hypot(a.cx - b.cx, a.cy - b.cy) <= Math.max(2.5, 0.2 * a.r) && Math.abs(a.r - b.r) <= Math.max(1.5, 0.15 * a.r)) { grupo.push(b); usado.add(j); }
    }
    const cobre = new Uint8Array(72);
    for (const g of grupo) {
      const ext = (g.fim - g.inicio + 360) % 360 || 360;
      for (let d = 0; d < ext; d += 2.5) cobre[Math.floor(((g.inicio + d) % 360) / 5)] = 1;
    }
    const total = cobre.reduce((s, v) => s + v, 0);
    const media = k => grupo.reduce((s, g) => s + g[k], 0) / grupo.length;
    if (total >= 60) circulos.push({ cx: media('cx'), cy: media('cy'), r: media('r'), span: 360 });
    else resto.push(...grupo);
  }
  return { circulos, arcos: resto };
}

// Endireita traços quase horizontais/verticais (até 5°) das polilinhas de símbolos.
function retificar(p) {
  const q = p.map(v => v.slice());
  const tg = Math.tan(5 * Math.PI / 180);
  for (let i = 0; i < q.length - 1; i++) {
    const dx = q[i + 1][0] - q[i][0], dy = q[i + 1][1] - q[i][1];
    if (Math.hypot(dx, dy) < 6) continue;
    if (Math.abs(dy) <= tg * Math.abs(dx)) { const y = (q[i][1] + q[i + 1][1]) / 2; q[i][1] = q[i + 1][1] = y; }
    else if (Math.abs(dx) <= tg * Math.abs(dy)) { const x = (q[i][0] + q[i + 1][0]) / 2; q[i][0] = q[i + 1][0] = x; }
  }
  return q;
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
