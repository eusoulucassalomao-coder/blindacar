# Blindacar — pasos para poner en marcha

Arquitectura: **Vercel** (web + `/api`) · **Supabase** (login Google + base de datos) · **Geoapify** (rutas). La app es **gratuita**: todo perfil nuevo nace con `has_access = true`.
Proyecto Supabase ya creado: `blindacar` (ref `nbvuvslfltzjuemrbhau`, región París) con tablas `profiles`, `reports`, `radars` y RLS activo.

## 1. Google (login)
1. Google Cloud Console > APIs y servicios > Credenciales > Crear ID de cliente OAuth (Aplicación web).
2. URI de redirección autorizada: `https://nbvuvslfltzjuemrbhau.supabase.co/auth/v1/callback`
3. Supabase > Authentication > Providers > Google: pega Client ID y Client Secret y activa.
4. Supabase > Authentication > URL Configuration: Site URL = tu dominio de Vercel; añade también ese dominio en Redirect URLs.

## 2. Vercel
1. Sube esta carpeta a un repositorio de GitHub e impórtalo en Vercel (o `vercel deploy`).
2. Settings > Environment Variables: crea las de `.env.example`
   (`SUPABASE_SERVICE_ROLE_KEY` está en Supabase > Project Settings > API; es SECRETA, nunca en el HTML).
   `GEOAPIFY_API_KEY` (rutas y búsqueda de destino): crea una cuenta en geoapify.com > Projects > API key. Es SECRETA:
   solo la usan `/api/route` y `/api/geocode`, nunca el navegador. Sin ella, la app funciona pero sin rutas.
3. Redeploy tras añadir las variables.

## Notas
- Sin sesión de Google (o con `has_access = false`) no se pueden leer radares ni avisos (RLS en la base de datos), aunque se abra el código fuente.
- `has_access` tiene valor por defecto `true` (app gratuita). El cliente no puede modificarlo; las reglas RLS siguen exigiéndolo, así que para bloquear a alguien basta con ponerlo en `false`.
- Límite de 1 aviso por minuto por usuario, reforzado en la base de datos.
- Los avisos se muestran 10 min; los más antiguos de 1 h se pueden borrar con `select public.purge_old_reports();` (programable con pg_cron).
- Rutas (Geoapify, plan gratuito con uso comercial y atribución «Powered by Geoapify»): se marcan los radares y avisos a menos de 100 m del trayecto. `/api/route` y `/api/geocode` solo responden a cuentas con acceso.
- Pendiente: coordenadas reales de las cabinas (hoy aproximadas, `verified=false` en la tabla `radars`).
