-- Blindacar gratuito (aplicado em 2026-10-30 via conector Supabase, após aprovação)
-- Mantém login Google e todas as regras RLS; muda só o valor de has_access.

-- 1) Perfis existentes: liberar o acesso
update public.profiles set has_access = true where not has_access;

-- 2) Perfis novos já nascem com acesso (handle_new_user não preenche has_access)
alter table public.profiles alter column has_access set default true;

-- Para desfazer:
--   alter table public.profiles alter column has_access set default false;
--   update public.profiles set has_access = false where paid_at is null;  -- opcional
