// Ayuda compartida por /api/geocode y /api/route (los archivos que empiezan por "_" no son rutas en Vercel).
// Solo deja pasar a usuarios con sesión de Supabase y acceso pagado (profiles.has_access = true),
// para que nadie pueda gastar la cuota del servicio de rutas desde fuera de la app.
const { createClient } = require('@supabase/supabase-js');

const CACHE_MS = 5 * 60 * 1000; // evita consultar Supabase en cada tecla del buscador
const cache = new Map();

async function requireAccess(req, res) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) { res.status(401).json({ error: 'no_token' }); return null; }

  const hit = cache.get(token);
  if (hit && hit.exp > Date.now()) return hit.uid;

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) { res.status(401).json({ error: 'invalid_token' }); return null; }

  const { data: profile } = await sb.from('profiles').select('has_access').eq('id', user.id).maybeSingle();
  if (!profile || !profile.has_access) { res.status(403).json({ error: 'no_access' }); return null; }

  if (cache.size > 500) cache.clear();
  cache.set(token, { uid: user.id, exp: Date.now() + CACHE_MS });
  return user.id;
}

// Clave del servicio de rutas: solo en variables de entorno de Vercel, nunca en el navegador
function geoapifyKey(res) {
  const key = process.env.GEOAPIFY_API_KEY;
  if (!key) { res.status(503).json({ error: 'not_configured' }); return null; }
  return key;
}

function parseLatLng(s) {
  const m = String(s || '').split(',').map(Number);
  if (m.length !== 2 || !m.every(Number.isFinite)) return null;
  const [lat, lng] = m;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

module.exports = { requireAccess, geoapifyKey, parseLatLng };
