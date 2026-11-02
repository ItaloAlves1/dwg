// Site do conversor: login, conversão no navegador, histórico e download dos DXF.
// O Supabase guarda contas, trabalhos e arquivos gerados; o PDF nunca é enviado.
import { Conversor, abrirPdf, PARALELO } from './conversor/conversor.js';

const $ = s => document.querySelector(s);
const cfg = window.APP_CONFIG || {};
if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
  $('#fatal').hidden = false;
  $('#fatal').textContent = 'Configuração ausente: defina SUPABASE_URL e SUPABASE_ANON_KEY (veja o README).';
  throw new Error('config.js sem dados do Supabase');
}
const sb = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

let user = null;
let timer = null;
const open = new Set();              // trabalhos com a lista de folhas aberta
const signed = new Map();            // caminho → { url assinada da prévia, válida até }
const ativos = new Map();            // jobId → { feitas, falhas, total, cancelar }
const filaPdfs = [];                 // { file, job } aguardando conversão
let conversor = null;
let resumeJob = null;                // trabalho que o usuário pediu para continuar
let lastHtml = '';

const pad = n => String(n).padStart(3, '0');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const stem = name => name.replace(/\.pdf$/i, '');
function msg(text, err = false) { const m = $('#msg'); m.textContent = text; m.className = 'msg' + (err ? ' err' : ''); }

// O Supabase devolve no máximo 1.000 linhas por consulta: busca em páginas até acabar.
async function todasAsLinhas(consulta) {
  const linhas = [];
  for (let de = 0; ; de += 1000) {
    const { data, error } = await consulta().range(de, de + 999);
    if (error) throw error;
    linhas.push(...data);
    if (data.length < 1000) return linhas;
  }
}

// ---------- Login ----------
function authAviso(texto, tipo = '') {
  const out = $('#authMsg');
  out.className = 'msg' + (tipo === 'erro' ? ' err' : tipo === 'ok' ? ' ok' : '');
  out.textContent = texto;
}

// Executa uma ação de login com os botões travados (evita clique duplo, que estoura o limite de e-mails).
async function acaoAuth(fn) {
  const botoes = [...document.querySelectorAll('#auth button')];
  botoes.forEach(b => { b.disabled = true; });
  try { await fn(); } catch (e) { authAviso(traduzErro(e), 'erro'); }
  finally { botoes.forEach(b => { b.disabled = false; }); }
}

$('#authForm').onsubmit = e => {
  e.preventDefault();
  // O botão clicado define a ação; Enter no formulário sempre é "Entrar".
  const modo = e.submitter?.dataset.mode || 'login';
  const email = $('#email').value.trim(), password = $('#password').value;
  $('#reenviar').hidden = true;
  acaoAuth(async () => {
    if (modo === 'login') {
      authAviso('Entrando…');
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) {
        if (error.code === 'email_not_confirmed') $('#reenviar').hidden = false;
        return authAviso(traduzErro(error), 'erro');
      }
      authAviso('');
    } else {
      authAviso('Criando conta…');
      const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin } });
      if (error) return authAviso(traduzErro(error), 'erro');
      if (data.session) return authAviso('');  // confirmação de e-mail desligada: já entrou
      // E-mail já cadastrado: o Supabase responde "sucesso" sem identidades, por segurança.
      if (data.user && !data.user.identities?.length) {
        $('#reenviar').hidden = false;
        return authAviso('Este e-mail já tem conta. Use "Entrar"; se ainda não confirmou o e-mail, reenvie a confirmação.', 'erro');
      }
      $('#reenviar').hidden = false;
      authAviso(`Conta criada e salva. Enviamos um link de confirmação para ${email}: abra o e-mail (veja também o spam), clique no link e depois entre.`, 'ok');
    }
  });
};

$('#reenviar').onclick = () => acaoAuth(async () => {
  const email = $('#email').value.trim();
  if (!email) return authAviso('Digite seu e-mail para reenviar a confirmação.', 'erro');
  const { error } = await sb.auth.resend({ type: 'signup', email, options: { emailRedirectTo: location.origin } });
  if (error) return authAviso(traduzErro(error), 'erro');
  authAviso(`Link de confirmação reenviado para ${email}. Veja também a caixa de spam.`, 'ok');
});

$('#esqueci').onclick = () => acaoAuth(async () => {
  const email = $('#email').value.trim();
  if (!email) return authAviso('Digite seu e-mail e clique de novo em "Esqueci a senha".', 'erro');
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
  if (error) return authAviso(traduzErro(error), 'erro');
  authAviso(`Se ${email} tiver conta, enviamos um link para criar uma nova senha.`, 'ok');
});

$('#logout').onclick = () => {
  if (ativos.size && !confirm('Há uma conversão em andamento. Sair interrompe a conversão. Continuar?')) return;
  for (const a of ativos.values()) a.cancelar = true;
  sb.auth.signOut();
};

function traduzErro(erro) {
  const code = erro?.code || '', m = String(erro?.message || erro || '');
  const espera = m.match(/after (\d+) seconds?/)?.[1];
  if (/rate_limit/.test(code) || /rate limit|after \d+ second/i.test(m))
    return `Muitas tentativas seguidas. Aguarde ${espera ? `${espera} segundos` : 'alguns minutos'} e tente de novo.`;
  if (code === 'invalid_credentials' || /invalid login/i.test(m)) return 'E-mail ou senha incorretos.';
  if (code === 'email_not_confirmed' || /email not confirmed/i.test(m))
    return 'Seu e-mail ainda não foi confirmado. Abra o link que enviamos (veja o spam) ou clique em "Reenviar e-mail de confirmação".';
  if (code === 'user_already_exists' || code === 'email_exists' || /already registered/i.test(m)) return 'Este e-mail já tem conta. Use "Entrar".';
  if (code === 'weak_password' || /password should be/i.test(m)) return 'Senha fraca: use pelo menos 6 caracteres.';
  if (code === 'email_address_invalid' || /invalid.*email|email.*invalid/i.test(m)) return 'E-mail inválido. Confira o endereço digitado.';
  if (code === 'signup_disabled' || /signups not allowed/i.test(m)) return 'O cadastro de novas contas está desativado. Peça acesso ao administrador.';
  if (/failed to fetch|network/i.test(m)) return 'Sem conexão com o servidor. Confira a internet e tente de novo.';
  return m;
}

sb.auth.onAuthStateChange(async (event, session) => {
  // Link de "Esqueci a senha": o Supabase abre o site já autenticado para trocar a senha.
  if (event === 'PASSWORD_RECOVERY') {
    const nova = prompt('Digite a nova senha (mínimo de 6 caracteres):');
    if (nova) {
      const { error } = await sb.auth.updateUser({ password: nova });
      alert(error ? `Não foi possível trocar a senha: ${traduzErro(error)}` : 'Senha alterada.');
    }
  }
  user = session?.user || null;
  document.body.classList.toggle('deslogado', !user);
  $('#auth').hidden = !!user;
  $('#app').hidden = !user;
  $('#user').hidden = !user;
  $('#userEmail').textContent = user?.email || '';
  clearInterval(timer);
  if (user) { lastHtml = ''; refresh(); timer = setInterval(refresh, 3000); }
});

// ---------- Escolha dos PDFs ----------
const drop = $('#drop'), input = $('#file');
drop.onclick = () => input.click();
drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') input.click(); };
input.onchange = () => { adicionar([...input.files]); input.value = ''; };
drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); adicionar([...e.dataTransfer.files]); };

async function adicionar(files) {
  const pdfs = files.filter(f => /\.pdf$/i.test(f.name));
  if (!pdfs.length) return msg('Escolha arquivos .pdf', true);
  for (const file of pdfs) {
    let total;
    try {
      const pdf = await abrirPdf(file);
      total = pdf.numPages;
      await pdf.destroy();
    } catch (e) {
      msg(`${file.name} não pôde ser aberto: ${e.message}`, true);
      continue;
    }
    const id = crypto.randomUUID();
    const { error } = await sb.from('jobs').insert({ id, name: file.name, size_bytes: file.size, page_count: total });
    if (error) { msg(`Falha ao registrar ${file.name}: ${error.message}`, true); continue; }
    open.add(id);
    filaPdfs.push({ file, job: { id, name: file.name, page_count: total } });
  }
  msg('');
  processarFila();
  refresh();
}

// "Continuar": o usuário escolhe de novo o PDF de um trabalho interrompido ou com falhas.
$('#resumeFile').onchange = async () => {
  const file = $('#resumeFile').files[0];
  $('#resumeFile').value = '';
  const job = resumeJob;
  resumeJob = null;
  if (!file || !job) return;
  if (file.size !== job.size_bytes && !confirm(`O arquivo escolhido (${file.name}) é diferente do original (${job.name}). Usar mesmo assim?`)) return;
  const pdf = await abrirPdf(file).catch(() => null);
  const total = pdf?.numPages;
  await pdf?.destroy();
  if (total !== job.page_count) return msg(`Esse PDF tem ${total ?? '?'} folhas, mas o trabalho tem ${job.page_count}. Escolha o mesmo arquivo.`, true);
  msg('');
  filaPdfs.push({ file, job });
  open.add(job.id);
  processarFila();
  refresh();
};

// ---------- Conversão ----------
let processando = false;
let wakeLock = null;

async function processarFila() {
  if (processando) return;
  processando = true;
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* sem suporte: segue normal */ }
  try {
    while (filaPdfs.length) {
      const { file, job } = filaPdfs.shift();
      await converterTrabalho(file, job);
    }
  } finally {
    processando = false;
    wakeLock?.release().catch(() => {});
    wakeLock = null;
    if (conversor) { await conversor.encerrar(); conversor = null; }  // libera memória quando ocioso
    atualizarAviso();
    refresh();
  }
}

async function converterTrabalho(file, job) {
  let feitas;
  try {
    feitas = await todasAsLinhas(() => sb.from('pages').select('n').eq('job_id', job.id).eq('status', 'pronta').order('n'));
  } catch (e) {
    return msg(`Não foi possível ler o andamento de ${job.name}: ${e.message}`, true);
  }
  const prontas = new Set(feitas.map(p => p.n));
  const pendentes = [];
  for (let n = 1; n <= job.page_count; n++) if (!prontas.has(n)) pendentes.push(n);
  const estado = { feitas: prontas.size, falhas: 0, total: job.page_count, cancelar: false, nome: job.name };
  ativos.set(job.id, estado);
  atualizarAviso();
  if (!pendentes.length) return finalizar(job, estado);

  if (!conversor) {
    $('#busy').textContent = 'Preparando o leitor de textos (na primeira vez baixa uns 15 MB)…';
    conversor = new Conversor();
  }
  const pdf = await abrirPdf(file);
  const pasta = `${user.id}/${job.id}`;
  try {
    // Várias folhas ao mesmo tempo, cada "corredor" pegando a próxima da lista.
    await Promise.all(Array.from({ length: PARALELO }, async () => {
      while (pendentes.length && !estado.cancelar) {
        const n = pendentes.shift();
        const base = `folha_${pad(n)}`;
        try {
          const { dxf, preview, stats } = await conversor.converterFolha(pdf, n);
          const dxfPath = `${pasta}/${base}.dxf`, prevPath = `${pasta}/${base}.webp`;
          const up1 = await sb.storage.from('resultados').upload(dxfPath, new Blob([dxf], { type: 'application/dxf' }), { upsert: true });
          if (up1.error) throw up1.error;
          const up2 = await sb.storage.from('resultados').upload(prevPath, preview, { upsert: true, contentType: 'image/webp' });
          if (up2.error) throw up2.error;
          // DXF novo: zera o DWG e o erro antigos para o agente gerar o DWG de novo.
          const { error } = await sb.from('pages').upsert({ job_id: job.id, n, status: 'pronta', dxf_path: dxfPath, preview_path: prevPath, stats, dwg_path: null, dwg_erro: null, updated_at: new Date().toISOString() });
          if (error) throw error;
          estado.feitas++;
        } catch (e) {
          console.error(`folha ${n}`, e);
          estado.falhas++;
          await sb.from('pages').upsert({ job_id: job.id, n, status: 'falhou', updated_at: new Date().toISOString() });
        }
        atualizarAviso();
      }
    }));
  } finally {
    await pdf.destroy();
  }
  await finalizar(job, estado);
}

async function finalizar(job, estado) {
  ativos.delete(job.id);
  if (!estado.cancelar && estado.feitas === estado.total)
    await sb.from('jobs').update({ status: 'concluído', finished_at: new Date().toISOString() }).eq('id', job.id);
  if (estado.falhas) msg(`${job.name}: ${estado.falhas} folha(s) falharam. Use "Continuar" para tentar de novo.`, true);
  else if (estado.cancelar) msg(`${job.name}: conversão parada. Use "Continuar" para retomar das folhas que faltam.`);
  refresh();
}

function atualizarAviso() {
  const b = $('#busy');
  if (!ativos.size && !filaPdfs.length) { b.hidden = true; return; }
  const [a] = ativos.values();
  const fila = filaPdfs.length ? ` · mais ${filaPdfs.length} PDF(s) na fila` : '';
  b.hidden = false;
  b.textContent = a
    ? `Convertendo "${a.nome}": ${a.feitas}/${a.total} folhas${fila}. Mantenha esta aba aberta até terminar.`
    : `Preparando…${fila}`;
}

window.addEventListener('beforeunload', e => {
  if (ativos.size || filaPdfs.length) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- Lista ----------
let atualizando = false;
async function refresh() {
  if (!user || atualizando) return;  // com rede lenta, não empilha consultas a cada 3 s
  atualizando = true;
  try { await carregar(); } catch (e) { console.error(e); } finally { atualizando = false; }
}

async function carregar() {
  const [jobsRes, progRes, agRes] = await Promise.all([
    sb.from('jobs').select('id,name,status,page_count,size_bytes,created_at').order('created_at', { ascending: false }).limit(100),
    sb.from('job_progress').select('*'),
    sb.from('agentes').select('last_seen').order('last_seen', { ascending: false }).limit(1),
  ]);
  if (jobsRes.error) return msg(`Erro ao carregar: ${jobsRes.error.message}`, true);
  const jobs = jobsRes.data;
  const prog = new Map((progRes.data || []).map(p => [p.job_id, p]));

  // Agente DWG (PC com o ODA): ligado se deu sinal de vida nos últimos 2 minutos.
  const visto = agRes.data?.[0]?.last_seen;
  const ligado = visto && Date.now() - new Date(visto).getTime() < 2 * 60 * 1000;
  $('#agente').className = 'agente' + (ligado ? ' on' : '');
  $('#agente').textContent = ligado
    ? 'Conversor DWG ligado: os DWG saem logo depois dos DXF.'
    : 'Conversor DWG desligado: os DXF ficam prontos agora e os DWG são gerados quando o PC do conversor for ligado.';

  // Folhas só dos trabalhos abertos.
  const openIds = jobs.filter(j => open.has(j.id)).map(j => j.id);
  const pagesBy = new Map();
  if (openIds.length) {
    const data = await todasAsLinhas(() => sb.from('pages').select('job_id,n,status,dxf_path,dwg_path,preview_path')
      .in('job_id', openIds).order('job_id').order('n'));
    for (const p of data) (pagesBy.get(p.job_id) || pagesBy.set(p.job_id, []).get(p.job_id)).push(p);
    // Renova a URL assinada 10 min antes de ela expirar.
    const need = data.filter(p => p.preview_path && !(signed.get(p.preview_path)?.until > Date.now()))
      .map(p => p.preview_path);
    if (need.length) {
      const { data: urls } = await sb.storage.from('resultados').createSignedUrls(need, 3600);
      for (const u of urls || []) if (u.signedUrl) signed.set(u.path, { url: u.signedUrl, until: Date.now() + 50 * 60 * 1000 });
    }
  }
  window.__jobs = jobs;
  render(jobs, prog, pagesBy);
}

function situacao(job, ok, bad) {
  if (ativos.has(job.id)) return ['convertendo', 'convertendo neste navegador'];
  if (filaPdfs.some(f => f.job.id === job.id)) return ['convertendo', 'na fila'];
  if (job.status === 'concluído') return ['concluido', 'concluído'];
  if (ok + bad >= job.page_count) return ['erro', 'concluído com falhas'];
  return ['erro', 'interrompido'];
}

function render(jobs, prog, pagesBy) {
  let html;
  if (!jobs.length) html = '<p class="empty">Nenhum PDF convertido ainda.</p>';
  else html = jobs.map(job => {
    const total = job.page_count;
    const p = prog.get(job.id) || { prontas: 0, falhas: 0, dwgs: 0 };
    const ok = +p.prontas, bad = +p.falhas, dwgs = +(p.dwgs || 0);
    const when = new Date(job.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    const [chip, rotulo] = situacao(job, ok, bad);
    const ativo = ativos.has(job.id) || filaPdfs.some(f => f.job.id === job.id);
    const podeContinuar = !ativo && (job.status !== 'concluído' || bad > 0);
    const pages = open.has(job.id) ? `<div class="pages">${(pagesBy.get(job.id) || []).map(pg => {
      const pic = pg.status === 'pronta' && signed.has(pg.preview_path)
        ? `<img loading="lazy" src="${signed.get(pg.preview_path).url}" alt="Folha ${pg.n}" data-zoom>`
        : `<div class="ph ${pg.status === 'falhou' ? 'fail' : ''}">${pg.status}</div>`;
      const nome = `${esc(stem(job.name))}_folha_${pad(pg.n)}`;
      const link = pg.status !== 'pronta' ? '' : `<span class="links">`
        + (pg.dwg_path ? `<button data-arq="${esc(pg.dwg_path)}" data-name="${nome}.dwg">DWG</button>` : '<span class="meta" title="Aguardando o conversor DWG">DWG…</span>')
        + `<button data-arq="${esc(pg.dxf_path)}" data-name="${nome}.dxf">DXF</button></span>`;
      return `<div class="page">${pic}<footer><span>Folha ${pg.n}</span>${link}</footer></div>`;
    }).join('') || '<span class="meta">As folhas aparecem aqui conforme ficam prontas.</span>'}</div>` : '';
    return `<article class="job">
      <div class="head">
        <div><div class="name">${esc(job.name)}</div>
          <div class="meta">${total} folhas · ${ok} prontas · ${dwgs} em DWG${bad ? ` · <span style="color:var(--err)">${bad} com falha</span>` : ''} · ${when}</div></div>
        <span class="chip ${chip}">${rotulo}</span>
      </div>
      <div class="bar"><i class="ok" style="width:${ok / total * 100}%"></i><i class="bad" style="width:${bad / total * 100}%"></i></div>
      <div class="actions">
        <button class="primary" data-zip="${job.id}" data-tipo="dwg" ${dwgs ? '' : 'disabled'}>Baixar DWG (.zip)${dwgs && dwgs < total ? ` — ${dwgs}/${total}` : ''}</button>
        <button data-zip="${job.id}" data-tipo="dxf" ${ok ? '' : 'disabled'}>Baixar DXF (.zip)${job.status !== 'concluído' && ok ? ' — parcial' : ''}</button>
        <button data-toggle="${job.id}">${open.has(job.id) ? 'Ocultar folhas' : 'Ver folhas'}</button>
        ${podeContinuar ? `<button data-resume="${job.id}" title="Escolha de novo o mesmo PDF">Continuar${bad ? ' / refazer falhas' : ''}</button>` : ''}
        ${ativos.has(job.id) ? `<button data-stop="${job.id}">Parar</button>` : ''}
        <button class="danger" data-del="${job.id}">Excluir</button>
      </div>${pages}
    </article>`;
  }).join('');
  if (html !== lastHtml) { lastHtml = html; $('#jobs').innerHTML = html; }
}

// ---------- Ações ----------
function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function downloadZip(jobId, btn, tipo) {
  const col = `${tipo}_path`, ext = tipo;  // tipo: 'dwg' ou 'dxf'
  const label = btn.textContent;
  btn.disabled = true;
  try {
    const { data: job, error: e1 } = await sb.from('jobs').select('name').eq('id', jobId).single();
    if (e1) throw e1;
    const pages = await todasAsLinhas(() => sb.from('pages').select(`n,${col}`).eq('job_id', jobId).eq('status', 'pronta')
      .not(col, 'is', null).order('n'));
    if (!pages.length) throw new Error(`nenhuma folha em ${ext.toUpperCase()} ainda`);
    const urls = [];  // URLs assinadas em blocos de 500 (limite por chamada)
    for (let i = 0; i < pages.length; i += 500) {
      const { data, error: e2 } = await sb.storage.from('resultados').createSignedUrls(pages.slice(i, i + 500).map(p => p[col]), 600);
      if (e2) throw e2;
      urls.push(...data);
    }
    const files = {};
    let done = 0;
    // Baixa em grupos de 6 para não abrir conexões demais.
    for (let i = 0; i < pages.length; i += 6) {
      await Promise.all(pages.slice(i, i + 6).map(async (p, k) => {
        if (!urls[i + k]?.signedUrl) throw new Error(`folha ${p.n}: arquivo não encontrado`);
        const res = await fetch(urls[i + k].signedUrl);
        if (!res.ok) throw new Error(`folha ${p.n}: HTTP ${res.status}`);
        files[`folha_${pad(p.n)}.${ext}`] = new Uint8Array(await res.arrayBuffer());
        btn.textContent = `Baixando ${++done}/${pages.length}…`;
      }));
    }
    btn.textContent = 'Compactando…';
    const ordered = {};  // no ZIP, folhas em ordem (os downloads terminam fora de ordem)
    for (const p of pages) ordered[`folha_${pad(p.n)}.${ext}`] = files[`folha_${pad(p.n)}.${ext}`];
    saveBlob(new Blob([fflate.zipSync(ordered, { level: 6 })], { type: 'application/zip' }), `${stem(job.name)}_${ext.toUpperCase()}.zip`);
  } catch (e) {
    msg(`Falha no download: ${e.message}`, true);
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

async function removeJob(jobId) {
  const a = ativos.get(jobId);
  if (a) a.cancelar = true;
  const i = filaPdfs.findIndex(f => f.job.id === jobId);
  if (i >= 0) filaPdfs.splice(i, 1);
  // Apaga os arquivos em blocos (a listagem devolve no máximo 1.000 por vez) até a pasta esvaziar.
  const folder = `${user.id}/${jobId}`;
  for (let tentativas = 0; tentativas < 50; tentativas++) {
    const { data: files, error } = await sb.storage.from('resultados').list(folder, { limit: 1000 });
    if (error) return msg(`Falha ao excluir os arquivos: ${error.message}`, true);
    if (!files.length) break;
    const { error: e2 } = await sb.storage.from('resultados').remove(files.map(f => `${folder}/${f.name}`));
    if (e2) return msg(`Falha ao excluir os arquivos: ${e2.message}`, true);
  }
  const { error } = await sb.from('jobs').delete().eq('id', jobId);
  if (error) msg(`Falha ao excluir: ${error.message}`, true);
}

$('#jobs').onclick = async e => {
  const t = e.target.closest('button, img');
  if (!t) return;
  const d = t.dataset;
  if (d.toggle) { open.has(d.toggle) ? open.delete(d.toggle) : open.add(d.toggle); refresh(); }
  if (d.zip) downloadZip(d.zip, t, d.tipo);
  if (d.arq) {
    const { data, error } = await sb.storage.from('resultados').createSignedUrl(d.arq, 60, { download: d.name });
    if (error) return msg(`Falha no download: ${error.message}`, true);
    location.href = data.signedUrl;
  }
  if (d.resume) {
    resumeJob = (window.__jobs || []).find(j => j.id === d.resume);
    msg(`Escolha o arquivo "${resumeJob.name}" para continuar a conversão.`);
    $('#resumeFile').click();
  }
  if (d.stop) { const a = ativos.get(d.stop); if (a) { a.cancelar = true; msg('Parando após as folhas em andamento…'); } }
  if (d.del && confirm('Excluir este trabalho e todos os arquivos convertidos?')) { await removeJob(d.del); refresh(); }
  if (d.zoom !== undefined) { $('#zoom img').src = t.src; $('#zoom').classList.add('on'); }
};
$('#zoom').onclick = () => $('#zoom').classList.remove('on');
