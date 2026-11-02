// Worker: busca PDFs na fila do Supabase, converte cada folha em DWG e envia o resultado.
// Uso: npm start   (lê a configuração do arquivo .env — veja .env.example)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createClient } from '@supabase/supabase-js';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const run = promisify(execFile);
const HERE = import.meta.dirname;
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no arquivo worker/.env (copie de .env.example).');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const NAME = `${os.hostname()}-${process.pid}`;
const PARALLEL = +process.env.WORKER_PARALELO || Math.max(2, Math.floor(os.availableParallelism() / 4));
const CACHE = path.join(HERE, 'cache');
const IDLE_MS = 3000;
fs.mkdirSync(CACHE, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = n => String(n).padStart(3, '0');
const log = (...a) => console.log(new Date().toLocaleTimeString('pt-BR'), ...a);
let stopping = false;

// ---------- Dados do trabalho e PDF em cache local ----------
const jobInfo = new Map();
async function getJob(id) {
  if (!jobInfo.has(id)) {
    const { data, error } = await sb.from('jobs').select('id,user_id,name,pdf_path').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) return null;  // excluído pelo usuário
    jobInfo.set(id, data);
  }
  return jobInfo.get(id);
}

const downloads = new Map();  // evita baixar o mesmo PDF duas vezes ao mesmo tempo
function localPdf(job) {
  const file = path.join(CACHE, `${job.id}.pdf`);
  if (fs.existsSync(file)) return Promise.resolve(file);
  if (!downloads.has(job.id)) downloads.set(job.id, (async () => {
    const { data, error } = await sb.storage.from('pdfs').download(job.pdf_path);
    if (error) throw new Error(`download do PDF falhou: ${error.message}`);
    fs.writeFileSync(`${file}.tmp`, Buffer.from(await data.arrayBuffer()));
    fs.renameSync(`${file}.tmp`, file);
    return file;
  })().finally(() => downloads.delete(job.id)));
  return downloads.get(job.id);
}

function cleanup(jobId) {
  fs.rmSync(path.join(CACHE, `${jobId}.pdf`), { force: true });
  fs.rmSync(path.join(CACHE, jobId), { recursive: true, force: true });
  jobInfo.delete(jobId);
}

// ---------- 1. PDFs novos: contar as folhas e criar a fila ----------
async function prepareLoop() {
  while (!stopping) {
    const { data, error } = await sb.rpc('claim_new_job', { p_worker: NAME });
    if (error) { log('erro ao buscar PDFs novos:', error.message); await sleep(10000); continue; }
    const job = data?.[0];
    if (!job) { await sleep(IDLE_MS); continue; }
    try {
      jobInfo.set(job.id, job);
      const file = await localPdf(job);
      const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(file)), verbosity: 0 }).promise;
      const total = doc.numPages;
      await doc.destroy();
      const rows = Array.from({ length: total }, (_, i) => ({ job_id: job.id, n: i + 1 }));
      for (let i = 0; i < rows.length; i += 500) {
        const { error: e } = await sb.from('pages').upsert(rows.slice(i, i + 500), { ignoreDuplicates: true });
        if (e) throw e;
      }
      await sb.from('jobs').update({ page_count: total, status: 'na fila' }).eq('id', job.id);
      log(`novo PDF: "${job.name}" — ${total} folhas na fila`);
    } catch (e) {
      log(`PDF "${job.name}" inválido:`, e.message);
      await sb.from('jobs').update({ status: 'erro', error: `Não foi possível ler o PDF: ${e.message}` }).eq('id', job.id);
      cleanup(job.id);
    }
  }
}

// ---------- 2. Folhas: converter e enviar ----------
async function preview(png) {
  // Prévia leve (1400 px, WebP) para as miniaturas do site.
  const img = await loadImage(fs.readFileSync(png));
  const w = 1400, h = Math.round(img.height * w / img.width);
  const c = createCanvas(w, h);
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return c.toBuffer('image/webp', 80);
}

async function convertPage(page) {
  const job = await getJob(page.job_id);
  if (!job) return;  // excluído enquanto estava na fila
  const out = path.join(CACHE, job.id);
  const base = `folha_${pad(page.n)}`;
  try {
    const pdf = await localPdf(job);
    await run(process.execPath, [path.join(HERE, 'convert.mjs'), pdf, String(page.n), out], { timeout: 10 * 60 * 1000, cwd: HERE });
    const dwgFile = path.join(out, 'dwg', `${base}.dwg`);
    if (!fs.existsSync(dwgFile)) throw new Error('DWG não foi gerado (o ODA File Converter está instalado?)');
    const folder = `${job.user_id}/${job.id}`;
    const dwgPath = `${folder}/${base}.dwg`, prevPath = `${folder}/${base}.webp`;
    const up1 = await sb.storage.from('resultados').upload(dwgPath, fs.readFileSync(dwgFile), { contentType: 'application/acad', upsert: true });
    if (up1.error) throw up1.error;
    const up2 = await sb.storage.from('resultados').upload(prevPath, await preview(path.join(out, `${base}_vetorizado.png`)), { contentType: 'image/webp', upsert: true });
    if (up2.error) throw up2.error;
    await sb.rpc('finish_page', { p_job: job.id, p_n: page.n, p_ok: true, p_dwg: dwgPath, p_preview: prevPath });
    log(`"${job.name}" folha ${page.n} pronta`);
  } catch (e) {
    log(`"${job.name}" folha ${page.n} falhou:`, e.message.split('\n')[0]);
    await sb.rpc('finish_page', { p_job: job.id, p_n: page.n, p_ok: false, p_dwg: null, p_preview: null });
  } finally {
    for (const f of [`${base}.dxf`, `${base}_original.png`, `${base}_vetorizado.png`, `dwg/${base}.dwg`])
      fs.rmSync(path.join(out, f), { force: true });
  }
  // Trabalho terminou? Libera o cache local.
  const { data } = await sb.from('jobs').select('status').eq('id', job.id).maybeSingle();
  if (!data || data.status === 'concluído') cleanup(job.id);
}

async function pageLoop() {
  while (!stopping) {
    const { data, error } = await sb.rpc('claim_page', { p_worker: NAME });
    if (error) { log('erro ao buscar folhas:', error.message); await sleep(10000); continue; }
    if (!data?.length) { await sleep(IDLE_MS); continue; }
    await convertPage(data[0]);
  }
}

// ---------- 3. Sinal de vida (o site mostra "Conversor ligado") ----------
async function heartbeat() {
  while (!stopping) {
    const { error } = await sb.from('workers').upsert({ name: NAME, last_seen: new Date().toISOString() });
    if (error) log('erro no sinal de vida:', error.message);
    await sleep(30000);
  }
}

process.on('SIGINT', async () => {
  if (stopping) process.exit(1);
  stopping = true;
  log('encerrando: terminando as folhas em andamento (Ctrl+C de novo para forçar)…');
  await sb.from('workers').delete().eq('name', NAME);
});

log(`worker ${NAME} iniciado — ${PARALLEL} folhas em paralelo`);
const loops = [prepareLoop(), heartbeat(), ...Array.from({ length: PARALLEL }, pageLoop)];
await Promise.all(loops);
log('worker encerrado');
process.exit(0);
