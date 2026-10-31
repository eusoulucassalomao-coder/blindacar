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
- Duración de los avisos (la fija el servidor): policía y control 10 min, accidente 1 h, obra 24 h. «Sigue ahí» renueva el aviso; con 3 «ya no está» más que confirmaciones, desaparece. Los caducados hace más de 1 h se borran con `select public.purge_old_reports();` (programable con pg_cron).
- Rutas (Geoapify, plan gratuito con uso comercial y atribución «Powered by Geoapify»): se marcan los radares y avisos a menos de 100 m del trayecto. `/api/route` y `/api/geocode` solo responden a cuentas con acceso.
- Radares de toda España: **DGT** (oficial, CC-BY; todo el país salvo Navarra, País Vasco y Cataluña) + **OpenStreetMap** (ODbL; Navarra, País Vasco y Cataluña). Para actualizarlos, en el SQL Editor de Supabase: `select public.import_radars();` (el app no puede lanzarlo). Los 14 radares manuales antiguos de Pamplona quedan guardados y desactivados.
- Incidencias de tráfico oficiales: `/api/incidents` junta tres feeds DATEX II del Punto de Acceso Nacional de la DGT: **DGT** (España salvo Cataluña y País Vasco), **Servei Català de Trànsit** y **Tráfico del Gobierno Vasco** (obras, cortes, retenciones, accidentes, vehículos parados por baliza V16, meteorología). 5 min de caché en la CDN; si una fuente falla se sirven las otras, y los errores no se guardan en caché. En Cataluña y País Vasco solo salen las incidencias que traen coordenadas (las que vienen solo con código Alert-C no se pueden situar). Las retenciones y obras que caen en la ruta se pintan sobre el trazado. No usa datos de los usuarios.
- Avisos de la comunidad aceptados en toda España (península, Baleares, Canarias, Ceuta y Melilla).
- Atribución obligatoria en el mapa: «Radares e incidencias: DGT, SCT, Gobierno Vasco», © OpenStreetMap, © MapTiler, Powered by Geoapify.

## Variables de entorno (Vercel)
Se configuran en Vercel > proyecto `blindacar` > Settings > Environment Variables, para **Production** y **Preview**. Nunca en el código ni en el repositorio.

| Variable | Uso | Secreta |
|---|---|---|
| `SUPABASE_URL` | URL del proyecto Supabase | No |
| `SUPABASE_SERVICE_ROLE_KEY` | Acceso de servidor a Supabase (`/api`) | **Sí** |
| `GEOAPIFY_API_KEY` | Rutas y búsqueda de destino (`/api/route`, `/api/geocode`) | **Sí** |

Claves públicas por diseño, presentes en `public/index.html`: la *publishable key* de Supabase (`sb_publishable_...`, protegida por RLS) y la clave de MapTiler (restringida por dominio). Ninguna otra clave debe aparecer en el código.

## Despliegue automático (Git → Vercel)
- Preset: **Other** · sin *build command* · *Output Directory* `public` (ya definido en `vercel.json`).
- Push a `main` → **producción** (`blindacar.vercel.app`).
- Cualquier otra rama → **preview** con su propia URL.
- Las previews usan las variables del entorno *Preview* (pueden ser las mismas que en producción).

## Flujo de trabajo
1. Una rama por tarea desde `main` (`feat/...`, `fix/...`, `chore/...`).
2. Push de la rama → Vercel genera una preview → probar ahí.
3. Abrir un *pull request* hacia `main`; revisar el diff y la preview.
4. Merge solo cuando la preview funciona → se publica en producción.
5. Si algo falla en producción: Vercel > Deployments > el despliegue anterior > **Promote to Production** (vuelta atrás inmediata).
6. Cambios en la base de datos de Supabase: siempre con el SQL revisado antes de ejecutarlo.
