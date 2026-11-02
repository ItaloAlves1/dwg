-- Migração 002: DWG gerado pelo agente do PC (ODA File Converter).
-- Para quem já rodou o schema.sql antes desta versão. Pode ser rodada mais de uma vez.

-- Caminho do DWG de cada folha (bucket "resultados") e erro da última tentativa.
alter table public.pages add column if not exists dwg_path text;
alter table public.pages add column if not exists dwg_erro text;

-- Fila do agente: folhas prontas que ainda não têm DWG.
create index if not exists pages_sem_dwg_idx on public.pages (updated_at)
  where status = 'pronta' and dwg_path is null and dwg_erro is null;

-- Progresso agora também conta os DWG.
create or replace view public.job_progress with (security_invoker = true) as
select job_id,
       count(*) filter (where status = 'pronta') as prontas,
       count(*) filter (where status = 'falhou') as falhas,
       count(*) filter (where dwg_path is not null) as dwgs
  from public.pages
 group by job_id;

-- Sinal de vida do agente, para o site mostrar "Conversor DWG ligado".
create table if not exists public.agentes (
  nome      text primary key,
  last_seen timestamptz not null default now()
);
alter table public.agentes enable row level security;
drop policy if exists "agentes: usuários logados veem" on public.agentes;
create policy "agentes: usuários logados veem" on public.agentes
  for select to authenticated using (true);
