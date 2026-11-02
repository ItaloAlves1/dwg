// Converte folhas de um PDF escaneado em DXF, tudo no navegador.
// Etapas por folha: renderizar (pdf.js) → preparar (Web Worker) → OCR (Tesseract.js) → finalizar (Web Worker).
import * as pdfjsLib from '../vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

const DPI = 300;
const VETORIZADOR = new URL('./vetorizador.js', import.meta.url);
const TESSERACT_WORKER = new URL('../vendor/tesseract-worker.min.js', import.meta.url).href;
const TESSERACT_CORE = 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1';

// Quantas folhas ao mesmo tempo: metade dos núcleos, entre 1 e 4 (cada folha usa ~150 MB de memória).
export const PARALELO = Math.min(4, Math.max(1, Math.floor((navigator.hardwareConcurrency || 2) / 2)));

// Falha com mensagem clara se a promessa não terminar no tempo dado (evita folha travada para sempre).
function comLimite(promessa, ms, motivo) {
  let timer;
  return Promise.race([promessa, new Promise((_, falha) => { timer = setTimeout(() => falha(new Error(motivo)), ms); })])
    .finally(() => clearTimeout(timer));
}

export async function abrirPdf(file) {
  return pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
}

// Um Web Worker de vetorização por folha em paralelo; o OCR é compartilhado.
class PoolVetorizador {
  constructor(n) {
    this.livres = Array.from({ length: n }, () => new Worker(VETORIZADOR));
    this.espera = [];
    this.seq = 0;
  }
  async usar(fn) {
    const w = this.livres.pop() || await new Promise(r => this.espera.push(r));
    try { return await fn(w); } finally {
      // Worker que travou ou quebrou (ex.: falta de memória) é trocado por um novo.
      const devolver = w.quebrado ? new Worker(VETORIZADOR) : w;
      const prox = this.espera.shift();
      prox ? prox(devolver) : this.livres.push(devolver);
    }
  }
  static chamar(w, msg, transfer = [], limiteMs = 5 * 60 * 1000) {
    return new Promise((ok, falha) => {
      const fim = () => { clearTimeout(timer); w.removeEventListener('message', handler); w.removeEventListener('error', erro); };
      const quebrar = motivo => { fim(); w.quebrado = true; w.terminate(); falha(new Error(motivo)); };
      const handler = ({ data }) => {
        if (data.id !== msg.id) return;
        fim();
        data.ok ? ok(data) : falha(new Error(data.erro));
      };
      const erro = e => { e.preventDefault?.(); quebrar(`o vetorizador parou: ${e.message || 'erro desconhecido (memória insuficiente?)'}`); };
      const timer = setTimeout(() => quebrar('a folha demorou demais para ser processada'), limiteMs);
      w.addEventListener('message', handler);
      w.addEventListener('error', erro);
      w.postMessage(msg, transfer);
    });
  }
  encerrar() { for (const w of this.livres) w.terminate(); }
}

export class Conversor {
  constructor() {
    this.pool = new PoolVetorizador(PARALELO);
    this.ocrPronto = this.iniciarOcr();
  }

  async iniciarOcr() {
    const scheduler = Tesseract.createScheduler();
    const n = Math.max(2, PARALELO);
    await Promise.all(Array.from({ length: n }, async () => {
      const worker = await Tesseract.createWorker('por', 1, {
        workerPath: TESSERACT_WORKER, corePath: TESSERACT_CORE, workerBlobURL: false,
      });
      await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT, preserve_interword_spaces: '1' });
      scheduler.addWorker(worker);
    }));
    return scheduler;
  }

  async ocr(imagem) {
    const scheduler = await this.ocrPronto;
    const { data } = await scheduler.addJob('recognize', imagem);
    // Só o necessário, em objetos simples (para enviar ao Web Worker).
    return data.lines.map(l => ({ text: l.text, confidence: l.confidence, bbox: l.bbox }));
  }

  // Converte uma folha (número a partir de 1). Devolve { dxf: Uint8Array, preview: Blob, stats }.
  async converterFolha(pdf, n) {
    const page = await pdf.getPage(n);
    const vp = page.getViewport({ scale: DPI / 72 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const { width, height, data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    canvas.width = canvas.height = 0;  // libera a memória do canvas
    page.cleanup();

    return this.pool.usar(async w => {
      const id = ++this.pool.seq;
      try {
        const { imagens } = await PoolVetorizador.chamar(w, { type: 'preparar', id, width, height, buffer: data.buffer }, [data.buffer]);
        const [orig, limpa, girada] = await comLimite(
          Promise.all([this.ocr(imagens.original), this.ocr(imagens.limpa), this.ocr(imagens.girada)]),
          5 * 60 * 1000, 'o leitor de textos (OCR) não respondeu');
        const ocr = [
          { lines: orig, vertical: false, original: true },
          { lines: limpa, vertical: false, original: false },
          { lines: girada, vertical: true, original: false },
        ];
        const { dxf, preview, stats } = await PoolVetorizador.chamar(w, { type: 'finalizar', id, ocr });
        return { dxf, preview, stats };
      } catch (e) {
        w.postMessage({ type: 'descartar', id });
        throw e;
      }
    });
  }

  async encerrar() {
    this.pool.encerrar();
    try { await (await this.ocrPronto).terminate(); } catch { /* já encerrado */ }
  }
}
