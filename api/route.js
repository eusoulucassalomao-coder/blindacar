// GET /api/route?from=lat,lng&to=lat,lng  (header Authorization: Bearer <access_token de Supabase>)
// Ruta en coche con Geoapify. Pide la ruta "equilibrada" (más rápida) y la "más corta" para ofrecer alternativas;
// si las dos salen iguales, devuelve solo una.
const { requireAccess, geoapifyKey, parseLatLng } = require('./_lib/access');

const MAX_KM = 800; // evita rutas enormes que gastan cuota

function km(a, b) {
  const R = 6371, r = Math.PI / 180, x = (b.lat - a.lat) * r, y = (b.lng - a.lng) * r;
  const h = Math.sin(x / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(y / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// GeoJSON [lng,lat] (LineString o MultiLineString) -> [[lat,lng], ...] con 5 decimales y sin puntos repetidos
function toCoords(geom) {
  const lines = geom.type === 'MultiLineString' ? geom.coordinates : geom.type === 'LineString' ? [geom.coordinates] : [];
  const out = [];
  for (const line of lines) {
    for (const [lng, lat] of line) {
      const p = [Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5];
      const last = out[out.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
    }
  }
  return out;
}

async function fetchRoute(key, from, to, type) {
  const u = new URL('https://api.geoapify.com/v1/routing');
  u.searchParams.set('waypoints', `${from.lat},${from.lng}|${to.lat},${to.lng}`);
  u.searchParams.set('mode', 'drive');
  u.searchParams.set('lang', 'es');
  u.searchParams.set('details', 'instruction_details,route_details'); // nombres de calle y límite de velocidad por tramo
  u.searchParams.set('type', type);
  u.searchParams.set('apiKey', key);
  const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('upstream ' + r.status);
  const j = await r.json();
  return (j.features || [])
    .filter((f) => f && f.geometry && f.properties)
    .map((f) => ({
      distance: Math.round(f.properties.distance), time: Math.round(f.properties.time), coords: toCoords(f.geometry),
      steps: ((f.properties.legs || []).flatMap((l) => l.steps || []))
        .map((st) => {
          let t = String((st.instruction && st.instruction.text) || '');
          const n = typeof st.name === 'string' ? st.name : '';
          if (n && !t.toLowerCase().includes(n.toLowerCase())) t += ` (${n})`;
          const lim = Number(st.speed_limit);
          return { t: t.slice(0, 160), d: Math.round(st.distance || 0), lim: Number.isFinite(lim) && lim > 0 ? Math.round(lim) : 0 };
        })
        .filter((st) => st.t).slice(0, 80),
    }))
    .filter((x) => x.coords.length > 1 && Number.isFinite(x.distance) && Number.isFinite(x.time));
}

const same = (a, b) => Math.abs(a.distance - b.distance) / Math.max(a.distance, 1) < 0.02 && Math.abs(a.time - b.time) / Math.max(a.time, 1) < 0.02;

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  try {
    if (!(await requireAccess(req, res))) return;
    const key = geoapifyKey(res);
    if (!key) return;

    const from = parseLatLng(req.query.from), to = parseLatLng(req.query.to);
    if (!from || !to) return res.status(400).json({ error: 'bad_points' });
    if (km(from, to) > MAX_KM) return res.status(400).json({ error: 'too_far' });

    const settled = await Promise.allSettled([
      fetchRoute(key, from, to, 'balanced'),
      fetchRoute(key, from, to, 'short'),
    ]);
    const routes = [];
    settled.forEach((s, i) => {
      if (s.status !== 'fulfilled') { console.error('route upstream', s.reason && s.reason.message); return; }
      s.value.forEach((r, k) => {
        if (routes.some((x) => same(x, r))) return;
        routes.push({ label: i === 0 ? (k === 0 ? 'Más rápida' : 'Alternativa') : 'Más corta', ...r });
      });
    });
    if (!routes.length) {
      const failed = settled.every((s) => s.status === 'rejected');
      return res.status(failed ? 502 : 404).json({ error: failed ? 'upstream' : 'no_route' });
    }
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json({ routes: routes.slice(0, 3) });
  } catch (e) {
    console.error('route error', e);
    return res.status(500).json({ error: 'server_error' });
  }
};
