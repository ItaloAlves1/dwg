// Site do conversor: login, envio dos PDFs para o Supabase, acompanhamento e download dos DWG.
// A conversão em si é feita pelo worker (pasta /worker), que lê a fila no banco.
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
let lastHtml = '';

const pad = n => String(n).padStart(3, '0');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const stem = name => name.replace(/\.pdf$/i, '');
function msg(text, err = false) { const m = $('#msg'); m.textContent = text; m.className = 'msg' + (err ? ' err' : ''); }

// ---------- Login ----------
let authMode = 'login';
$('#authForm').addEventListener('click', e => { if (e.target.dataset.mode) authMode = e.target.dataset.mode; });
$('#authForm').onsubmit = async e => {
  e.preventDefault();
  const email = $('#email').value.trim(), password = $('#password').value;
  const out = $('#authMsg');
  out.className = 'msg'; out.textContent = authMode === 'login' ? 'Entrando…' : 'Criando conta…';
  const { data, error } = authMode === 'login'
    ? await sb.auth.signInWithPassword({ email, password })
    : await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin } });
  if (error) { out.className = 'msg err'; out.textContent = traduzErro(error.message); return; }
  if (authMode === 'signup' && !data.session) out.textContent = 'Conta criada. Confirme pelo link enviado ao seu e-mail e depois entre.';
  else out.textContent = '';
};
$('#logout').onclick = () => sb.auth.signOut();

function traduzErro(m) {
  if (/invalid login/i.test(m)) return 'E-mail ou senha incorretos.';
  if (/email not confirmed/i.test(m)) return 'Confirme seu e-mail pelo link que enviamos antes de entrar.';
  if (/already registered/i.test(m)) return 'Este e-mail já tem conta. Use "Entrar".';
  if (/failed to fetch/i.test(m)) return 'Sem conexão com o Supabase. Confira a internet e a configuração do site.';
  return m;
}

sb.auth.onAuthStateChange((_event, session) => {
  user = session?.user || null;
  $('#auth').hidden = !!user;
  $('#app').hidden = !user;
  $('#user').hidden = !user;
  $('#userEmail').textContent = user?.email || '';
  clearInterval(timer);
  if (user) { lastHtml = ''; refresh(); timer = setInterval(refresh, 3000); }
});

// ---------- Envio ----------
const drop = $('#drop'), input = $('#file');
drop.onclick = () => input.click();
drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') input.click(); };
input.onchange = () => { upload([...input.files]); input.value = ''; };
drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); upload([...e.dataTransfer.files]); };

async function upload(files) {
  const pdfs = files.filter(f => /\.pdf$/i.test(f.name));
  if (!pdfs.length) return msg('Escolha arquivos .pdf', true);
  const tooBig = pdfs.find(f => f.size > 50 * 1024 * 1024);
  if (tooBig) return msg(`${tooBig.name} passa de 50 MB, o limite de envio.`, true);
  for (const [i, f] of pdfs.entries()) {
    msg(`Enviando ${f.name} (${i + 1}/${pdfs.length})…`);
    const id = crypto.randomUUID();
    const path = `${user.id}/${id}.pdf`;
    const up = await sb.storage.from('pdfs').upload(path, f, { contentType: 'application/pdf' });
    if (up.error) return msg(`Falha ao enviar ${f.name}: ${up.error.message}`, true);
    const ins = await sb.from('jobs').insert({ id, name: f.name, pdf_path: path });
    if (ins.error) {
      await sb.storage.from('pdfs').remove([path]);
      return msg(`Falha ao registrar ${f.name}: ${ins.error.message}`, true);
    }
    open.add(id);
    await refresh();
  }
  msg(`${pdfs.length} PDF(s) enviados. Eles entram na fila do conversor.`);
}

// ---------- Lista ----------
async function refresh() {
  if (!user) return;
  const [jobsRes, progRes, workersRes] = await Promise.all([
    sb.from('jobs').select('id,name,status,page_count,error,created_at,pdf_path').order('created_at', { ascending: false }).limit(100),
    sb.from('job_progress').select('*'),
    sb.from('workers').select('last_seen').order('last_seen', { ascending: false }).limit(1),
  ]);
  if (jobsRes.error) return msg(`Erro ao carregar: ${jobsRes.error.message}`, true);
  const jobs = jobsRes.data;
  const prog = new Map((progRes.data || []).map(p => [p.job_id, p]));

  const seen = workersRes.data?.[0]?.last_seen;
  const online = seen && Date.now() - new Date(seen).getTime() < 2 * 60 * 1000;
  $('#worker').className = 'worker' + (online ? ' on' : '');
  $('#worker').textContent = online ? 'Conversor ligado' : 'Conversor desligado: os PDFs ficam na fila até o worker ser iniciado';

  // Folhas só dos trabalhos abertos.
  const openIds = jobs.filter(j => open.has(j.id)).map(j => j.id);
  const pagesBy = new Map();
  if (openIds.length) {
    const { data } = await sb.from('pages').select('job_id,n,status,dwg_path,preview_path')
      .in('job_id', openIds).order('n').limit(5000);
    for (const p of data || []) (pagesBy.get(p.job_id) || pagesBy.set(p.job_id, []).get(p.job_id)).push(p);
    // Renova a URL assinada 10 min antes de ela expirar.
    const need = (data || []).filter(p => p.preview_path && !(signed.get(p.preview_path)?.until > Date.now()))
      .map(p => p.preview_path);
    if (need.length) {
      const { data: urls } = await sb.storage.from('resultados').createSignedUrls(need, 3600);
      for (const u of urls || []) if (u.signedUrl) signed.set(u.path, { url: u.signedUrl, until: Date.now() + 50 * 60 * 1000 });
    }
  }
  render(jobs, prog, pagesBy);
}

function render(jobs, prog, pagesBy) {
  let html;
  if (!jobs.length) html = '<p class="empty">Nenhum PDF enviado ainda.</p>';
  else html = jobs.map(job => {
    const total = job.page_count || 0;
    const p = prog.get(job.id) || { prontas: 0, falhas: 0 };
    const ok = +p.prontas, bad = +p.falhas;
    const when = new Date(job.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    const chip = job.status === 'concluído' ? 'concluido' : job.status;
    const pages = open.has(job.id) ? `<div class="pages">${(pagesBy.get(job.id) || []).map(pg => {
      const pic = pg.status === 'pronta' && signed.has(pg.preview_path)
        ? `<img loading="lazy" src="${signed.get(pg.preview_path).url}" alt="Folha ${pg.n}" data-zoom>`
        : `<div class="ph ${pg.status === 'falhou' ? 'fail' : ''}">${pg.status}</div>`;
      const link = pg.status === 'pronta' ? `<button data-dwg="${esc(pg.dwg_path)}" data-name="${esc(stem(job.name))}_folha_${pad(pg.n)}.dwg">DWG</button>` : '';
      return `<div class="page">${pic}<footer><span>Folha ${pg.n}</span>${link}</footer></div>`;
    }).join('') || '<span class="meta">As folhas aparecem quando o conversor ler o PDF.</span>'}</div>` : '';
    return `<article class="job">
      <div class="head">
        <div><div class="name">${esc(job.name)}</div>
          <div class="meta">${total ? `${total} folhas · ${ok} prontas` : 'aguardando leitura do PDF'}${bad ? ` · <span style="color:var(--err)">${bad} com falha</span>` : ''} · enviado ${when}</div>
          ${job.error ? `<div class="meta" style="color:var(--err)">${esc(job.error)}</div>` : ''}</div>
        <span class="chip ${chip}">${job.status}</span>
      </div>
      <div class="bar"><i class="ok" style="width:${total ? ok / total * 100 : 0}%"></i><i class="bad" style="width:${total ? bad / total * 100 : 0}%"></i></div>
      <div class="actions">
        <button class="primary" data-zip="${job.id}" ${ok ? '' : 'disabled'}>Baixar DWG (.zip)${job.status !== 'concluído' && ok ? ' — parcial' : ''}</button>
        <button data-toggle="${job.id}">${open.has(job.id) ? 'Ocultar folhas' : 'Ver folhas'}</button>
        ${bad ? `<button data-retry="${job.id}">Tentar de novo as falhas</button>` : ''}
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

async function downloadZip(jobId, btn) {
  const { data: job } = await sb.from('jobs').select('name').eq('id', jobId).single();
  const { data: pages, error } = await sb.from('pages').select('n,dwg_path').eq('job_id', jobId).eq('status', 'pronta').order('n').limit(5000);
  if (error || !pages.length) return msg('Nenhuma folha pronta para baixar.', true);
  const label = btn.textContent;
  btn.disabled = true;
  try {
    const { data: urls } = await sb.storage.from('resultados').createSignedUrls(pages.map(p => p.dwg_path), 600);
    const files = {};
    let done = 0;
    // Baixa em grupos de 6 para não abrir conexões demais.
    for (let i = 0; i < pages.length; i += 6) {
      await Promise.all(pages.slice(i, i + 6).map(async (p, k) => {
        const res = await fetch(urls[i + k].signedUrl);
        if (!res.ok) throw new Error(`folha ${p.n}: HTTP ${res.status}`);
        files[`folha_${pad(p.n)}.dwg`] = new Uint8Array(await res.arrayBuffer());
        btn.textContent = `Baixando ${++done}/${pages.length}…`;
      }));
    }
    btn.textContent = 'Compactando…';
    saveBlob(new Blob([fflate.zipSync(files, { level: 6 })], { type: 'application/zip' }), `${stem(job.name)}_DWG.zip`);
  } catch (e) {
    msg(`Falha no download: ${e.message}`, true);
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

async function removeJob(jobId) {
  const { data: job } = await sb.from('jobs').select('pdf_path').eq('id', jobId).single();
  const folder = `${user.id}/${jobId}`;
  const { data: files } = await sb.storage.from('resultados').list(folder, { limit: 1000 });
  if (files?.length) await sb.storage.from('resultados').remove(files.map(f => `${folder}/${f.name}`));
  if (job?.pdf_path) await sb.storage.from('pdfs').remove([job.pdf_path]);
  const { error } = await sb.from('jobs').delete().eq('id', jobId);
  if (error) msg(`Falha ao excluir: ${error.message}`, true);
}

$('#jobs').onclick = async e => {
  const t = e.target.closest('button, img');
  if (!t) return;
  const d = t.dataset;
  if (d.toggle) { open.has(d.toggle) ? open.delete(d.toggle) : open.add(d.toggle); refresh(); }
  if (d.zip) downloadZip(d.zip, t);
  if (d.dwg) {
    const { data, error } = await sb.storage.from('resultados').createSignedUrl(d.dwg, 60, { download: d.name });
    if (error) return msg(`Falha no download: ${error.message}`, true);
    location.href = data.signedUrl;
  }
  if (d.retry) {
    const { error } = await sb.rpc('retry_failed', { p_job: d.retry });
    if (error) msg(error.message, true); else refresh();
  }
  if (d.del && confirm('Excluir este PDF e todos os arquivos convertidos?')) { await removeJob(d.del); refresh(); }
  if (d.zoom !== undefined) { $('#zoom img').src = t.src; $('#zoom').classList.add('on'); }
};
$('#zoom').onclick = () => $('#zoom').classList.remove('on');
