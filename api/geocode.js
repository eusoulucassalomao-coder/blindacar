// GET /api/geocode?q=texto&lat=..&lng=..  (header Authorization: Bearer <access_token de Supabase>)
// Sugerencias de destino (autocompletado de Geoapify), priorizando la posición del usuario.
const { requireAccess, geoapifyKey } = require('./_lib/access');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  try {
    if (!(await requireAccess(req, res))) return;
    const key = geoapifyKey(res);
    if (!key) return;

    const q = String(req.query.q || '').trim().slice(0, 120);
    if (q.length < 3) return res.status(400).json({ error: 'bad_query' });

    const u = new URL('https://api.geoapify.com/v1/geocode/autocomplete');
    u.searchParams.set('text', q);
    u.searchParams.set('lang', 'es');
    u.searchParams.set('limit', '6');
    u.searchParams.set('format', 'json');
    const lat = Number(req.query.lat), lng = Number(req.query.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      u.searchParams.set('bias', `proximity:${lng},${lat}`);
    }
    u.searchParams.set('apiKey', key);

    const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) {
      console.error('geocode upstream', r.status);
      return res.status(502).json({ error: 'upstream' });
    }
    const j = await r.json();
    const results = (j.results || [])
      .filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lon))
      .map((x) => ({
        name: x.name || x.address_line1 || x.formatted || '',
        sub: x.name && x.address_line1 && x.address_line1 !== x.name ? x.address_line1 + (x.address_line2 ? ', ' + x.address_line2 : '') : (x.address_line2 || ''),
        lat: x.lat,
        lng: x.lon,
      }));
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.status(200).json({ results });
  } catch (e) {
    console.error('geocode error', e);
    return res.status(500).json({ error: 'server_error' });
  }
};
