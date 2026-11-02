// Agente DWG: roda no PC com o ODA File Converter.
// Sempre que o PC estiver ligado, busca no Supabase as folhas que já têm DXF e ainda
// não têm DWG, converte com o ODA e envia o DWG de volta. Sem dependências (só Node 20.11+).
//
// Uso: node --env-file=.env agente.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);
const HERE = import.meta.dirname;
const URL_SB = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const LOTE = 25;                       // folhas por rodada do ODA
const ESPERA_MS = 15000;               // intervalo entre consultas quando não há trabalho
const NOME = os.hostname();
const TMP = path.join(HERE, 'tmp');
const LOG = path.join(HERE, 'agente.log');

function log(...a) {
  const linha = `${new Date().toLocaleString('pt-BR')} ${a.join(' ')}`;
  console.log(linha);
  try {
    // Mantém o log pequeno: recomeça ao passar de 1 MB.
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 1024 * 1024) fs.renameSync(LOG, `${LOG}.antigo`);
    fs.appendFileSync(LOG, linha + '\n');
  } catch { /* log é só conveniência */ }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Configuração ----------
if (!URL_SB || !KEY) {
  log('Configuração incompleta: preencha SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no arquivo .env desta pasta.');
  process.exit(1);
}

function acharODA() {
  if (process.env.ODA_CONVERTER) return process.env.ODA_CONVERTER;
  const local = path.join(HERE, 'oda', 'ODAFileConverter.exe');
  if (fs.existsSync(local)) return local;
  const base = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ODA');
  if (fs.existsSync(base))
    for (const d of fs.readdirSync(base).sort().reverse()) {
      const f = path.join(base, d, 'ODAFileConverter.exe');
      if (fs.existsSync(f)) return f;
    }
  return null;
}
const ODA = acharODA();
if (!ODA) {
  log('ODA File Converter não encontrado. Instale de https://www.opendesign.com/guestfiles/oda_file_converter');
  process.exit(1);
}

// Uma instância só por PC (o atalho de inicialização e um clique manual não podem rodar juntos).
const TRAVA = path.join(HERE, 'agente.pid');
try {
  const pid = +fs.readFileSync(TRAVA, 'utf8');
  if (pid && pid !== process.pid) { process.kill(pid, 0); log(`já está rodando (processo ${pid}); saindo.`); process.exit(0); }
} catch { /* sem trava ou processo antigo morto: segue */ }
fs.writeFileSync(TRAVA, String(process.pid));
process.on('exit', () => { try { if (+fs.readFileSync(TRAVA, 'utf8') === process.pid) fs.rmSync(TRAVA); } catch {} });
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(0));

// ---------- Supabase via REST (chave service_role: acesso a todas as contas) ----------
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function rest(metodo, caminho, corpo, extra = {}) {
  const res = await fetch(`${URL_SB}/rest/v1/${caminho}`, {
    method: metodo,
    headers: { ...H, 'Content-Type': 'application/json', ...extra },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  if (!res.ok) throw new Error(`${metodo} ${caminho.split('?')[0]}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

const objeto = caminho => `${URL_SB}/storage/v1/object/resultados/${caminho.split('/').map(encodeURIComponent).join('/')}`;

// Erro que não adianta tentar de novo (arquivo inexistente, DXF que o ODA não converte).
class ErroPermanente extends Error {}

async function baixar(caminho) {
  const res = await fetch(objeto(caminho), { headers: H });
  if (res.status === 400 || res.status === 404) throw new ErroPermanente(`DXF não encontrado no armazenamento (${caminho})`);
  if (!res.ok) throw new Error(`download ${caminho}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function excluir(caminho) {
  await fetch(objeto(caminho), { method: 'DELETE', headers: H }).catch(() => {});
}

async function enviar(caminho, dados) {
  const res = await fetch(objeto(caminho), {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/acad', 'x-upsert': 'true' },
    body: dados,
  });
  if (!res.ok) throw new Error(`upload ${caminho}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

const pagina = (job, n) => `pages?job_id=eq.${job}&n=eq.${n}`;

// ---------- Conversão de um lote ----------
async function rodada() {
  const fila = await rest('GET',
    `pages?select=job_id,n,dxf_path&status=eq.pronta&dwg_path=is.null&dwg_erro=is.null&order=updated_at.asc&limit=${LOTE}`);
  if (!fila.length) return 0;

  fs.rmSync(TMP, { recursive: true, force: true });
  const entrada = path.join(TMP, 'dxf'), saida = path.join(TMP, 'dwg');
  fs.mkdirSync(entrada, { recursive: true });
  fs.mkdirSync(saida, { recursive: true });

  // Erro permanente marca a folha (o site para de esperar por ela); erro de rede só registra,
  // e a folha volta na próxima rodada.
  const falhou = async (p, e) => {
    log(`folha ${p.n} do trabalho ${p.job_id}: ${e.message}`);
    if (e instanceof ErroPermanente)
      await rest('PATCH', pagina(p.job_id, p.n), { dwg_erro: e.message.slice(0, 500) }).catch(() => {});
  };

  // Nome local único por folha: <índice>.dxf (os caminhos do Supabase têm pastas e UUIDs).
  const itens = [];
  for (const [i, p] of fila.entries()) {
    try {
      fs.writeFileSync(path.join(entrada, `${i}.dxf`), await baixar(p.dxf_path));
      itens.push({ ...p, i });
    } catch (e) { await falhou(p, e); }
  }
  if (!itens.length) return 0;

  // ODAFileConverter <entrada> <saída> <versão> <tipo> <recursivo> <auditar> <filtro>
  // Se o ODA quebrar no meio, as folhas que ele não gerou são marcadas abaixo, uma a uma.
  try {
    await run(ODA, [entrada, saida, 'ACAD2018', 'DWG', '0', '1', '*.DXF'], { timeout: 10 * 60 * 1000, windowsHide: true });
  } catch (e) { log('o ODA terminou com erro:', e.message.split('\n')[0]); }

  let ok = 0;
  for (const p of itens) {
    const dwg = path.join(saida, `${p.i}.dwg`);
    const destino = p.dxf_path.replace(/\.dxf$/i, '.dwg');
    try {
      if (!fs.existsSync(dwg)) throw new ErroPermanente('o ODA File Converter não conseguiu gerar o DWG desta folha');
      await enviar(destino, fs.readFileSync(dwg));
      const linhas = await rest('PATCH', pagina(p.job_id, p.n), { dwg_path: destino, dwg_erro: null },
        { Prefer: 'return=representation' });
      // Trabalho excluído enquanto convertia: não deixa o DWG órfão no armazenamento.
      if (!linhas?.length) { await excluir(destino); continue; }
      ok++;
    } catch (e) { await falhou(p, e); }
  }
  log(`${ok}/${itens.length} folhas convertidas em DWG`);
  fs.rmSync(TMP, { recursive: true, force: true });
  return ok === itens.length ? fila.length : 0;  // houve falha de rede: espera antes de tentar de novo
}

// ---------- Sinal de vida e laço principal ----------
async function sinalDeVida() {
  for (;;) {
    try {
      await rest('POST', 'agentes', { nome: NOME, last_seen: new Date().toISOString() },
        { Prefer: 'resolution=merge-duplicates,return=minimal' });
    } catch (e) { log('sinal de vida falhou:', e.message); }
    await sleep(30000);
  }
}

log(`agente iniciado em ${NOME} (ODA: ${ODA})`);
sinalDeVida();
for (;;) {
  try {
    const n = await rodada();
    if (n < LOTE) await sleep(ESPERA_MS);   // lote cheio: provavelmente há mais na fila, segue direto
  } catch (e) {
    log('erro:', e.message);
    await sleep(60000);                     // sem internet ou Supabase fora: tenta de novo em 1 min
  }
}
