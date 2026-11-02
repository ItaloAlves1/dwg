-- Conversor PDF → DXF: esquema do banco e do armazenamento.
-- A conversão roda no navegador; o Supabase guarda login, histórico e os arquivos gerados.
-- Rode este arquivo inteiro no Supabase: Dashboard → SQL Editor → New query → colar → Run.

-- ---------------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------------

-- Um trabalho por PDF enviado.
create table if not exists public.jobs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  name        text not null,                       -- nome original do arquivo
  size_bytes  bigint not null,                     -- usado para conferir o PDF ao retomar
  page_count  int not null,
  status      text not null default 'convertendo' check (status in ('convertendo', 'concluído')),
  created_at  timestamptz not null default now(),
  finished_at timestamptz
);

-- Uma linha por folha já processada (pronta ou com falha).
create table if not exists public.pages (
  job_id       uuid not null references public.jobs on delete cascade,
  n            int  not null,
  status       text not null check (status in ('pronta', 'falhou')),
  dxf_path     text,                               -- caminho no bucket "resultados"
  preview_path text,
  stats        jsonb,                              -- contagens de linhas, textos etc.
  updated_at   timestamptz not null default now(),
  primary key (job_id, n)
);

create index if not exists jobs_user_idx on public.jobs (user_id, created_at desc);

-- Resumo do progresso de cada trabalho (respeita o RLS de quem consulta).
create or replace view public.job_progress with (security_invoker = true) as
select job_id,
       count(*) filter (where status = 'pronta') as prontas,
       count(*) filter (where status = 'falhou') as falhas
  from public.pages
 group by job_id;

-- ---------------------------------------------------------------------------
-- Segurança (RLS): cada usuário só vê e altera os próprios trabalhos.
-- ---------------------------------------------------------------------------
alter table public.jobs  enable row level security;
alter table public.pages enable row level security;

drop policy if exists "jobs: dono" on public.jobs;
create policy "jobs: dono" on public.jobs
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "pages: dono" on public.pages;
create policy "pages: dono" on public.pages
  for all using (exists (select 1 from public.jobs j where j.id = job_id and j.user_id = auth.uid()))
  with check (exists (select 1 from public.jobs j where j.id = job_id and j.user_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- Armazenamento: bucket privado "resultados"
--   resultados/<user_id>/<job_id>/folha_001.dxf   (desenho)
--   resultados/<user_id>/<job_id>/folha_001.webp  (prévia)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('resultados', 'resultados', false, 20971520)
on conflict (id) do nothing;

drop policy if exists "resultados: ler os meus" on storage.objects;
create policy "resultados: ler os meus" on storage.objects
  for select to authenticated
  using (bucket_id = 'resultados' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "resultados: enviar na minha pasta" on storage.objects;
create policy "resultados: enviar na minha pasta" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'resultados' and (storage.foldername(name))[1] = auth.uid()::text);

-- Necessária para regravar uma folha ao refazer (upload com upsert).
drop policy if exists "resultados: regravar os meus" on storage.objects;
create policy "resultados: regravar os meus" on storage.objects
  for update to authenticated
  using (bucket_id = 'resultados' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "resultados: excluir os meus" on storage.objects;
create policy "resultados: excluir os meus" on storage.objects
  for delete to authenticated
  using (bucket_id = 'resultados' and (storage.foldername(name))[1] = auth.uid()::text);
