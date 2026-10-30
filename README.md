# Blindacar — pasos para poner en marcha

Arquitectura: **Vercel** (web + `/api`) · **Supabase** (login Google + base de datos) · **Stripe** (pago único).
Proyecto Supabase ya creado: `blindacar` (ref `nbvuvslfltzjuemrbhau`, región París) con tablas `profiles`, `reports`, `radars` y RLS activo.

## 1. Google (login)
1. Google Cloud Console > APIs y servicios > Credenciales > Crear ID de cliente OAuth (Aplicación web).
2. URI de redirección autorizada: `https://nbvuvslfltzjuemrbhau.supabase.co/auth/v1/callback`
3. Supabase > Authentication > Providers > Google: pega Client ID y Client Secret y activa.
4. Supabase > Authentication > URL Configuration: Site URL = tu dominio de Vercel; añade también ese dominio en Redirect URLs.

## 2. Stripe (pago único)
1. Product catalog > crea un producto con precio **único** en EUR. Copia el `price_...`.
2. Developers > Webhooks > añade endpoint `https://TU-DOMINIO/api/stripe-webhook` con los eventos
   `checkout.session.completed` y `checkout.session.async_payment_succeeded`. Copia el `whsec_...`.
3. Empieza con claves de **prueba** (`sk_test_...`) y tarjeta 4242 4242 4242 4242.

## 3. Vercel
1. Sube esta carpeta a un repositorio de GitHub e impórtalo en Vercel (o `vercel deploy`).
2. Settings > Environment Variables: crea las de `.env.example`
   (`SUPABASE_SERVICE_ROLE_KEY` está en Supabase > Project Settings > API; es SECRETA, nunca en el HTML).
3. Redeploy tras añadir las variables.

## Notas
- Sin pagar, un usuario no puede leer radares ni avisos (RLS en la base de datos), aunque abra el código fuente.
- El acceso se activa solo desde el webhook de Stripe; el cliente no puede modificar `has_access`.
- Límite de 1 aviso por minuto por usuario, reforzado en la base de datos.
- Los avisos se muestran 10 min; los más antiguos de 1 h se pueden borrar con `select public.purge_old_reports();` (programable con pg_cron).
- Pendiente: coordenadas reales de las cabinas (hoy aproximadas, `verified=false` en la tabla `radars`).
