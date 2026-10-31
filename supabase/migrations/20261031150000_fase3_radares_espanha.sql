-- Fase 3: radares de toda a Espanha + avisos aceitos em toda a Espanha
--   Radares: DGT (oficial, CC-BY; todo o país menos Navarra, País Basco e Catalunha)
--            + OpenStreetMap (ODbL; Navarra, País Basco e Catalunha)
--   A importação roda dentro do banco (extensão http) e pode ser repetida para atualizar.

-- 1) Colunas novas em radars
alter table public.radars add column source text not null default 'manual' check (source in ('manual','dgt','osm'));
alter table public.radars add column kind text not null default 'fixed' check (kind in ('fixed','section'));
alter table public.radars add column road text;
alter table public.radars add column km numeric(7,1);
alter table public.radars add column direction text;      -- DGT: destino ("hacia MADRID")
alter table public.radars add column heading smallint;    -- OSM: rumo em graus (0-359)
alter table public.radars add column lat2 double precision;  -- radar de trecho: fim do trecho
alter table public.radars add column lng2 double precision;
alter table public.radars add column active boolean not null default true;
alter table public.radars add column updated_at timestamptz not null default now();
-- A DGT não informa o limite: passa a ser opcional (os 14 radares atuais mantêm o valor)
alter table public.radars alter column speed_limit drop not null;
alter table public.radars alter column speed_limit drop default;
create index if not exists radars_active_idx on public.radars (active);

-- Só radares ativos são lidos pelo app
drop policy radars_select_paid on public.radars;
create policy radars_select_active on public.radars for select to authenticated
  using (public.user_has_access() and active);

-- 2) Importação (parte "pura": recebe o XML da DGT e o JSON do OpenStreetMap)
create or replace function public.import_radars_from(dgt_xml text, osm jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  doc xml;
  n_dgt int := 0; n_osm int := 0; n_off int := 0;
begin
  -- DGT
  if dgt_xml is not null and length(dgt_xml) > 1000 then
    doc := regexp_replace(dgt_xml, '^\s*<\?xml[^>]*\?>', '')::xml;
    with rows as (
      select
        regexp_replace(x.raw_id, '^GUID_', '') as id,
        case when x.set_id ilike '%VelocidadMedia%' then 'section' else 'fixed' end as kind,
        coalesce(x.lat_from, x.lat_pt)::float8 as lat,
        coalesce(x.lng_from, x.lng_pt)::float8 as lng,
        x.lat_to::float8 as lat2, x.lng_to::float8 as lng2,
        nullif(trim(x.road), '') as road,
        round(nullif(x.dist, '')::numeric / 1000, 1) as km,
        nullif(trim(x.dir), '') as direction
      from xmltable(
        xmlnamespaces('http://datex2.eu/schema/1_0/1_0' as d),
        '//d:predefinedLocationSet/d:predefinedLocation' passing doc
        columns
          raw_id   text path '@id',
          set_id   text path '../@id',
          lat_from text path '(.//d:from//d:latitude)[1]',
          lng_from text path '(.//d:from//d:longitude)[1]',
          lat_to   text path '(.//d:to//d:latitude)[1]',
          lng_to   text path '(.//d:to//d:longitude)[1]',
          lat_pt   text path '(.//d:pointCoordinates/d:latitude)[1]',
          lng_pt   text path '(.//d:pointCoordinates/d:longitude)[1]',
          road     text path '(.//d:roadNumber)[1]',
          dist     text path '(.//d:referencePointDistance)[1]',
          dir      text path '(.//d:directionNamed)[1]'
      ) as x
    ), ok as (
      select * from rows where lat between 27 and 44.5 and lng between -19 and 5
    ), up as (
      insert into public.radars as r (id, name, lat, lng, lat2, lng2, kind, road, km, direction, source, active, updated_at, verified, speed_limit)
      select id,
             case when kind = 'section' then 'Tramo ' else '' end || coalesce(road, 'Carretera') || coalesce(' km ' || replace(km::text, '.', ','), ''),
             lat, lng, case when kind = 'section' then lat2 end, case when kind = 'section' then lng2 end,
             kind, road, km, direction, 'dgt', true, now(), true, null
      from ok
      on conflict (id) do update set name = excluded.name, lat = excluded.lat, lng = excluded.lng, lat2 = excluded.lat2, lng2 = excluded.lng2,
        kind = excluded.kind, road = excluded.road, km = excluded.km, direction = excluded.direction, active = true, updated_at = now()
      returning 1
    )
    select count(*) into n_dgt from up;
    -- Radares da DGT que sumiram da lista oficial: desativados (não apagados)
    if n_dgt > 100 then
      update public.radars set active = false, updated_at = now()
        where source = 'dgt' and active and updated_at < now() - interval '1 minute';
      get diagnostics n_off = row_count;
    end if;
  end if;

  -- OpenStreetMap (Navarra, País Basco, Catalunha)
  if osm is not null and jsonb_typeof(osm->'elements') = 'array' then
    with rows as (
      select 'osm-' || (e->>'id') as id, (e->>'lat')::float8 as lat, (e->>'lon')::float8 as lng, e->'tags' as t
      from jsonb_array_elements(osm->'elements') e
      where e->>'type' = 'node' and e ? 'lat'
    ), up as (
      insert into public.radars as r (id, name, lat, lng, kind, road, heading, speed_limit, source, active, updated_at, verified)
      select id,
             coalesce(nullif(t->>'name',''), nullif(t->>'ref',''), 'Radar fijo'),
             lat, lng, 'fixed', nullif(t->>'ref',''),
             case when t->>'direction' ~ '^\d{1,3}(\.\d+)?$' then (round((t->>'direction')::numeric)::int % 360) end,
             case when t->>'maxspeed' ~ '^\d{2,3}$' then (t->>'maxspeed')::int end,
             'osm', true, now(), true
      from rows where lat between 27 and 44.5 and lng between -19 and 5
      on conflict (id) do update set name = excluded.name, lat = excluded.lat, lng = excluded.lng, road = excluded.road,
        heading = excluded.heading, speed_limit = excluded.speed_limit, active = true, updated_at = now()
      returning 1
    )
    select count(*) into n_osm from up;
    if n_osm > 100 then
      update public.radars set active = false, updated_at = now()
        where source = 'osm' and active and updated_at < now() - interval '1 minute';
    end if;
  end if;

  return jsonb_build_object('dgt', n_dgt, 'osm', n_osm, 'dgt_desativados', n_off,
    'ativos', (select count(*) from public.radars where active));
end $$;

-- 3) Importação completa: baixa a DGT e o OpenStreetMap e chama a função acima
create extension if not exists http with schema extensions;

create or replace function public.import_radars()
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  dgt text; osm jsonb; r extensions.http_response;
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '90');
  begin
    r := extensions.http_get('https://nap.dgt.es/datex2/dgt/PredefinedLocationsPublication/radares/content.xml');
    if r.status = 200 then dgt := r.content; else raise notice 'DGT respondeu %', r.status; end if;
  exception when others then raise notice 'DGT falhou: %', sqlerrm; end;
  begin
    r := extensions.http_post('https://overpass-api.de/api/interpreter',
      'data=' || extensions.urlencode('[out:json][timeout:90];(area["ISO3166-2"="ES-NA"];area["ISO3166-2"="ES-PV"];area["ISO3166-2"="ES-CT"];)->.a;node["highway"="speed_camera"](area.a);out body;'),
      'application/x-www-form-urlencoded');
    if r.status = 200 then osm := r.content::jsonb; else raise notice 'Overpass respondeu %', r.status; end if;
  exception when others then raise notice 'Overpass falhou: %', sqlerrm; end;
  return public.import_radars_from(dgt, osm);
end $$;

-- Nenhuma das duas pode ser chamada pelo app (só pelo painel do Supabase ou por tarefa agendada)
revoke all on function public.import_radars_from(text, jsonb) from public, anon, authenticated;
revoke all on function public.import_radars() from public, anon, authenticated;

-- 4) Os 14 radares atuais de Pamplona eram aproximados: ficam guardados, mas desativados
--    (o OpenStreetMap tem 21 radares mapeados em Pamplona). Para voltar: update public.radars set active = true where source = 'manual';
update public.radars set active = false where source = 'manual';

-- 5) Avisos da comunidade aceitos em toda a Espanha (península, Baleares, Canárias, Ceuta e Melilla)
create or replace function public.reports_region_check()
returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if (new.lat between 35.0 and 44.0 and new.lng between -9.6 and 4.6)       -- península, Baleares, Ceuta, Melilla
     or (new.lat between 27.4 and 29.6 and new.lng between -18.4 and -13.2) -- Canárias
  then return new; end if;
  if exists (select 1 from public.profiles where id = new.user_id and is_tester) then return new; end if;
  raise exception 'Fuera de la zona de servicio' using errcode = 'P0002';
end $$;
