-- Fase 2: avisos estilo Waze
--   1) novo tipo 'o' (Obra)
--   2) expiração por tipo: polícia/controle 10 min, acidente 60 min, obra 24 h
--   3) votação "¿Sigue ahí?": confirmar estende o aviso; com 3 "ya no está" a mais que confirmações, some
-- Login Google e as regras de acesso (user_has_access) continuam valendo em tudo.

-- 1) Tipo Obra
alter table public.reports drop constraint reports_type_check;
alter table public.reports add constraint reports_type_check check (type = any (array['p','b','a','o']));

-- 2) Duração de cada tipo de aviso
create or replace function public.report_ttl(t text)
returns interval language sql immutable set search_path to '' as $$
  select case t when 'a' then interval '60 minutes' when 'o' then interval '24 hours' else interval '10 minutes' end
$$;

-- Colunas novas. expires_at entra sem default para os avisos antigos NÃO voltarem a aparecer.
alter table public.reports add column confirms integer not null default 0;
alter table public.reports add column denies integer not null default 0;
alter table public.reports add column expires_at timestamptz;
update public.reports set expires_at = created_at + public.report_ttl(type) where expires_at is null;
alter table public.reports alter column expires_at set not null;
alter table public.reports alter column expires_at set default (now() + interval '10 minutes');
create index if not exists reports_expires_at_idx on public.reports (expires_at);

-- O servidor decide a validade e zera os votos (o app não consegue mandar outros valores)
create or replace function public.reports_set_expiry()
returns trigger language plpgsql security definer set search_path to '' as $$
begin
  new.expires_at := now() + public.report_ttl(new.type);
  new.confirms := 0;
  new.denies := 0;
  return new;
end $$;
create trigger reports_set_expiry_trg before insert on public.reports
  for each row execute function public.reports_set_expiry();

-- Leitura: só avisos ainda válidos e não negados pela comunidade
drop policy reports_select_paid_recent on public.reports;
create policy reports_select_active on public.reports for select to authenticated
  using (public.user_has_access() and expires_at > now() and (confirms - denies) > -3);

-- 3) Votos: um por usuário e aviso (pode mudar de ideia)
create table public.report_votes (
  report_id uuid not null references public.reports(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  vote smallint not null check (vote in (-1, 1)),
  created_at timestamptz not null default now(),
  primary key (report_id, user_id)
);
create index report_votes_user_idx on public.report_votes (user_id);
alter table public.report_votes enable row level security;
-- Cada um vê só os próprios votos; gravar, só pela função vote_report (sem políticas de escrita)
create policy report_votes_select_own on public.report_votes for select to authenticated
  using (user_id = (select auth.uid()));

create or replace function public.vote_report(rid uuid, v smallint)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  uid uuid := auth.uid();
  owner uuid;
  res jsonb;
begin
  if uid is null or not public.user_has_access() then
    raise exception 'Sin acceso' using errcode = '42501';
  end if;
  if v is null or v not in (-1, 1) then
    raise exception 'Voto no válido' using errcode = '22023';
  end if;
  -- Só avisos visíveis: válidos e não escondidos pela comunidade
  select r.user_id into owner from public.reports r
    where r.id = rid and r.expires_at > now() and (r.confirms - r.denies) > -3 for update;
  if not found then
    raise exception 'Aviso no encontrado o caducado' using errcode = 'P0004';
  end if;
  if owner = uid then
    raise exception 'No puedes votar tu propio aviso' using errcode = 'P0003';
  end if;

  insert into public.report_votes (report_id, user_id, vote) values (rid, uid, v)
    on conflict (report_id, user_id) do update set vote = excluded.vote, created_at = now();

  update public.reports r set
    confirms = (select count(*) from public.report_votes x where x.report_id = rid and x.vote = 1),
    denies   = (select count(*) from public.report_votes x where x.report_id = rid and x.vote = -1),
    -- "Sigue ahí" renova a validade a partir de agora (nunca encurta)
    expires_at = case when v = 1 then greatest(r.expires_at, now() + public.report_ttl(r.type)) else r.expires_at end
  where r.id = rid
  returning jsonb_build_object('confirms', r.confirms, 'denies', r.denies, 'expires_at', r.expires_at) into res;
  return res;
end $$;

revoke all on function public.vote_report(uuid, smallint) from public, anon;
grant execute on function public.vote_report(uuid, smallint) to authenticated;
revoke all on function public.reports_set_expiry() from public, anon, authenticated;

-- Limpeza: usa a validade de cada aviso (obras duram 24 h)
create or replace function public.purge_old_reports()
returns void language sql security definer set search_path to '' as $$
  delete from public.reports where expires_at < now() - interval '1 hour'
$$;

-- Para desfazer (em ordem):
--   drop function public.vote_report(uuid, smallint);
--   drop table public.report_votes;
--   drop policy reports_select_active on public.reports;
--   create policy reports_select_paid_recent on public.reports for select to authenticated
--     using (public.user_has_access() and created_at > now() - interval '10 minutes');
--   drop trigger reports_set_expiry_trg on public.reports; drop function public.reports_set_expiry();
--   alter table public.reports drop column expires_at, drop column confirms, drop column denies;
--   delete from public.reports where type = 'o';
--   alter table public.reports drop constraint reports_type_check;
--   alter table public.reports add constraint reports_type_check check (type = any (array['p','b','a']));
--   drop function public.report_ttl(text);
--   (e restaurar purge_old_reports com created_at < now() - interval '1 hour')
