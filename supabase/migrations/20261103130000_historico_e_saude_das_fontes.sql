-- PRD «Road Intelligence» · Histórico de ocorrências e saúde das fontes
--   1) incident_history: cada incidência oficial (DGT, SCT, Gobierno Vasco) com primeira e última vez vista
--   2) source_health: última leitura de cada fonte, quantas incidências trouxe e se deu erro
--   3) report_history: avisos da comunidade arquivados de forma anônima antes de apagar
--      (sem user_id e com a posição arredondada a ~100 m), para medir confirmados × contestados
--   4) tarefa a cada 10 min que lê /api/incidents e grava o histórico
-- Nenhuma tabela é lida pelo app: só pelo painel do Supabase (e, no futuro, pelo painel administrativo).

-- 1) Histórico das incidências oficiais
create table public.incident_history (
  id text primary key,                 -- fonte + id da fonte (ex.: «DGT:GUID_123»)
  src text not null,                   -- DGT, SCT, Gobierno Vasco
  cat text not null,                   -- closed, accident, jam, works...
  sev smallint,
  road text, km numeric(7,1), town text,
  txt text,
  lat double precision not null, lng double precision not null,
  started_at timestamptz,              -- início informado pela fonte
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()   -- deixou de aparecer = resolvida (aprox.)
);
create index incident_history_last_seen_idx on public.incident_history (last_seen);
create index incident_history_src_cat_idx on public.incident_history (src, cat);

-- 2) Saúde das fontes
create table public.source_health (
  source text primary key,             -- dgt, sct, gv, api
  name text,
  last_check timestamptz,
  last_ok timestamptz,
  items int,
  published_at timestamptz,            -- hora de publicação informada pela própria fonte
  last_error text
);

-- 3) Arquivo anônimo dos avisos da comunidade
create table public.report_history (
  id uuid primary key,
  type text not null,
  created_at timestamptz not null,
  expires_at timestamptz,
  confirms int not null default 0,
  denies int not null default 0,
  lat numeric(7,3), lng numeric(7,3),  -- ~100 m: suficiente para estatística, sem rastrear ninguém
  archived_at timestamptz not null default now()
);
create index report_history_created_idx on public.report_history (created_at);

-- Sem políticas: com RLS ligado, o app (anon/authenticated) não lê nem escreve
alter table public.incident_history enable row level security;
alter table public.source_health enable row level security;
alter table public.report_history enable row level security;

-- 4a) Parte «pura»: recebe o JSON da API e grava (testável sem rede)
create or replace function public.ingest_incidents(j jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare n int := 0; s record;
begin
  insert into public.incident_history as h (id, src, cat, sev, road, km, town, txt, lat, lng, started_at)
  select coalesce(nullif(e->>'src',''), 'DGT') || ':' || (e->>'id'),
         coalesce(nullif(e->>'src',''), 'DGT'), e->>'cat',
         case when e->>'sev' ~ '^\d+$' then (e->>'sev')::smallint end,
         nullif(e->>'road',''),
         case when e->>'km' ~ '^-?\d+(\.\d+)?$' then round((e->>'km')::numeric, 1) end,
         nullif(e->>'town',''), left(e->>'txt', 300),
         (e->>'lat')::float8, (e->>'lng')::float8,
         case when e->>'start' ~ '^\d{4}-\d{2}-\d{2}T' then (e->>'start')::timestamptz end
  from jsonb_array_elements(coalesce(j->'items', '[]'::jsonb)) e
  where e->>'id' is not null and e->>'cat' is not null
    and jsonb_typeof(e->'lat') = 'number' and jsonb_typeof(e->'lng') = 'number'
  on conflict (id) do update set last_seen = now(), cat = excluded.cat, sev = excluded.sev, txt = excluded.txt;
  get diagnostics n = row_count;

  for s in select key, value from jsonb_each(coalesce(j->'sourcesInfo', '{}'::jsonb)) loop
    insert into public.source_health as sh (source, name, last_check, last_ok, items, published_at, last_error)
    values (s.key, s.value->>'name', now(),
            case when s.value->>'error' is null then now() end,
            case when s.value->>'count' ~ '^\d+$' then (s.value->>'count')::int end,
            case when s.value->>'updatedAt' ~ '^\d{4}-\d{2}-\d{2}T' then (s.value->>'updatedAt')::timestamptz end,
            s.value->>'error')
    on conflict (source) do update set name = coalesce(excluded.name, sh.name), last_check = now(),
      last_ok = coalesce(excluded.last_ok, sh.last_ok), items = coalesce(excluded.items, sh.items),
      published_at = coalesce(excluded.published_at, sh.published_at), last_error = excluded.last_error;
  end loop;
  return jsonb_build_object('incidencias', n);
end $$;

-- 4b) Leitura da API do próprio app (usa a cache da CDN: não gera tráfego extra para a DGT)
create or replace function public.snapshot_incidents()
returns jsonb language plpgsql security definer set search_path to '' as $$
declare r extensions.http_response; err text;
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '30');
  begin
    r := extensions.http_get('https://blindacar.vercel.app/api/incidents');
    if r.status = 200 then
      insert into public.source_health (source, name, last_check, last_ok, last_error)
        values ('api', '/api/incidents', now(), now(), null)
        on conflict (source) do update set last_check = now(), last_ok = now(), last_error = null;
      return public.ingest_incidents(r.content::jsonb);
    end if;
    err := 'HTTP ' || r.status;
  exception when others then err := sqlerrm;
  end;
  insert into public.source_health (source, name, last_check, last_error)
    values ('api', '/api/incidents', now(), left(err, 200))
    on conflict (source) do update set last_check = now(), last_error = excluded.last_error;
  return jsonb_build_object('erro', err);
end $$;

-- 3b) A limpeza diária passa a arquivar (anônimo) antes de apagar, e poda o histórico antigo
create or replace function public.purge_old_reports()
returns void language sql security definer set search_path to '' as $$
  insert into public.report_history (id, type, created_at, expires_at, confirms, denies, lat, lng)
    select id, type, created_at, expires_at, confirms, denies, round(lat::numeric, 3), round(lng::numeric, 3)
    from public.reports where expires_at < now() - interval '1 hour'
    on conflict (id) do nothing;
  delete from public.reports where expires_at < now() - interval '1 hour';
  delete from public.incident_history where last_seen < now() - interval '180 days';
  delete from public.report_history where archived_at < now() - interval '365 days';
$$;

revoke all on function public.ingest_incidents(jsonb) from public, anon, authenticated;
revoke all on function public.snapshot_incidents() from public, anon, authenticated;
revoke all on function public.purge_old_reports() from public, anon, authenticated;

-- 4c) A cada 10 minutos
select cron.schedule('blindacar-historico-incidencias', '*/10 * * * *', $$select public.snapshot_incidents();$$);

-- Para desfazer:
--   select cron.unschedule('blindacar-historico-incidencias');
--   drop function public.snapshot_incidents(); drop function public.ingest_incidents(jsonb);
--   create or replace function public.purge_old_reports() returns void language sql security definer set search_path to '' as
--     $f$ delete from public.reports where expires_at < now() - interval '1 hour' $f$;
--   drop table public.report_history; drop table public.source_health; drop table public.incident_history;
