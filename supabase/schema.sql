-- Conversor PDF → DWG: esquema do banco e do armazenamento.
-- Rode este arquivo inteiro no Supabase: Dashboard → SQL Editor → New query → colar → Run.

-- ---------------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------------

-- Um trabalho por PDF enviado.
create table if not exists public.jobs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  name        text not null,                       -- nome original do arquivo
  pdf_path    text not null,                       -- caminho no bucket "pdfs"
  status      text not null default 'novo'
              check (status in ('novo', 'preparando', 'na fila', 'convertendo', 'concluído', 'erro')),
  page_count  int,
  error       text,
  created_at  timestamptz not null default now(),
  claimed_at  timestamptz,                         -- quando um worker começou a preparar
  finished_at timestamptz
);

-- Uma linha por folha do PDF (criadas pelo worker quando ele lê o PDF).
create table if not exists public.pages (
  job_id       uuid not null references public.jobs on delete cascade,
  n            int  not null,
  status       text not null default 'na fila'
               check (status in ('na fila', 'convertendo', 'pronta', 'falhou')),
  dwg_path     text,                               -- caminho no bucket "resultados"
  preview_path text,
  worker       text,
  started_at   timestamptz,
  updated_at   timestamptz not null default now(),
  primary key (job_id, n)
);

-- Sinal de vida dos workers, para o site mostrar se há conversor ligado.
create table if not exists public.workers (
  name      text primary key,
  last_seen timestamptz not null default now()
);

create index if not exists pages_fila_idx on public.pages (status, job_id, n);
create index if not exists jobs_user_idx on public.jobs (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Segurança (RLS): cada usuário só vê e mexe nos próprios trabalhos.
-- O worker usa a chave service_role, que ignora RLS.
-- ---------------------------------------------------------------------------
alter table public.jobs    enable row level security;
alter table public.pages   enable row level security;
alter table public.workers enable row level security;

drop policy if exists "workers: usuários logados veem" on public.workers;
create policy "workers: usuários logados veem" on public.workers
  for select to authenticated using (true);

drop policy if exists "jobs: ver os meus" on public.jobs;
create policy "jobs: ver os meus" on public.jobs
  for select using (user_id = auth.uid());

drop policy if exists "jobs: criar os meus" on public.jobs;
create policy "jobs: criar os meus" on public.jobs
  for insert with check (user_id = auth.uid() and status = 'novo');

drop policy if exists "jobs: excluir os meus" on public.jobs;
create policy "jobs: excluir os meus" on public.jobs
  for delete using (user_id = auth.uid());

drop policy if exists "pages: ver as minhas" on public.pages;
create policy "pages: ver as minhas" on public.pages
  for select using (exists (select 1 from public.jobs j where j.id = job_id and j.user_id = auth.uid()));

-- Resumo do progresso de cada trabalho (respeita o RLS de quem consulta).
create or replace view public.job_progress with (security_invoker = true) as
select job_id,
       count(*) filter (where status = 'pronta')      as prontas,
       count(*) filter (where status = 'falhou')      as falhas,
       count(*) filter (where status = 'convertendo') as convertendo
  from public.pages
 group by job_id;

-- ---------------------------------------------------------------------------
-- Funções
-- ---------------------------------------------------------------------------

-- Usuário: devolver para a fila as folhas que falharam.
create or replace function public.retry_failed(p_job uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from jobs where id = p_job and user_id = auth.uid()) then
    raise exception 'trabalho não encontrado';
  end if;
  update pages set status = 'na fila', worker = null, started_at = null, updated_at = now()
   where job_id = p_job and status = 'falhou';
  update jobs set status = 'na fila', finished_at = null where id = p_job and status = 'concluído';
end $$;
revoke all on function public.retry_failed(uuid) from public, anon;
grant execute on function public.retry_failed(uuid) to authenticated;

-- Worker: pegar um PDF novo para contar as folhas.
-- "skip locked" permite vários workers sem dois pegarem o mesmo item.
create or replace function public.claim_new_job(p_worker text)
returns setof public.jobs language plpgsql security definer set search_path = public as $$
begin
  return query
  update jobs set status = 'preparando', claimed_at = now()
   where id = (select id from jobs
                where status = 'novo'
                   -- trabalho preso em "preparando" (worker caiu) volta depois de 10 min
                   or (status = 'preparando' and claimed_at < now() - interval '10 minutes')
                order by created_at limit 1 for update skip locked)
  returning *;
end $$;

-- Worker: pegar a próxima folha da fila (por ordem de envio).
create or replace function public.claim_page(p_worker text)
returns setof public.pages language plpgsql security definer set search_path = public as $$
begin
  return query
  update pages p set status = 'convertendo', worker = p_worker, started_at = now(), updated_at = now()
   from (select pg.job_id, pg.n from pages pg join jobs j on j.id = pg.job_id
          where pg.status = 'na fila'
             -- folha presa em "convertendo" (worker caiu) volta depois de 15 min
             or (pg.status = 'convertendo' and pg.started_at < now() - interval '15 minutes')
          order by j.created_at, pg.n limit 1 for update of pg skip locked) alvo
   where p.job_id = alvo.job_id and p.n = alvo.n
  returning p.*;
  update jobs set status = 'convertendo'
   where id in (select job_id from pages where worker = p_worker and status = 'convertendo') and status = 'na fila';
end $$;

-- Worker: registrar o resultado de uma folha e fechar o trabalho quando todas terminarem.
create or replace function public.finish_page(p_job uuid, p_n int, p_ok boolean, p_dwg text, p_preview text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update pages set status = case when p_ok then 'pronta' else 'falhou' end,
                   dwg_path = p_dwg, preview_path = p_preview, updated_at = now()
   where job_id = p_job and n = p_n;
  update jobs set status = 'concluído', finished_at = now()
   where id = p_job
     and not exists (select 1 from pages where job_id = p_job and status in ('na fila', 'convertendo'));
end $$;

-- As funções do worker só podem ser chamadas com a chave service_role.
revoke all on function public.claim_new_job(text) from public, anon, authenticated;
revoke all on function public.claim_page(text) from public, anon, authenticated;
revoke all on function public.finish_page(uuid, int, boolean, text, text) from public, anon, authenticated;
grant execute on function public.claim_new_job(text) to service_role;
grant execute on function public.claim_page(text) to service_role;
grant execute on function public.finish_page(uuid, int, boolean, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Armazenamento: dois buckets privados.
--   pdfs/<user_id>/<job_id>.pdf
--   resultados/<user_id>/<job_id>/folha_001.dwg  (e folha_001.webp, a prévia)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pdfs', 'pdfs', false, 52428800, array['application/pdf'])
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('resultados', 'resultados', false)
on conflict (id) do nothing;

drop policy if exists "pdfs: enviar na minha pasta" on storage.objects;
create policy "pdfs: enviar na minha pasta" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'pdfs' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "arquivos: ler os meus" on storage.objects;
create policy "arquivos: ler os meus" on storage.objects
  for select to authenticated
  using (bucket_id in ('pdfs', 'resultados') and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "arquivos: excluir os meus" on storage.objects;
create policy "arquivos: excluir os meus" on storage.objects
  for delete to authenticated
  using (bucket_id in ('pdfs', 'resultados') and (storage.foldername(name))[1] = auth.uid()::text);
