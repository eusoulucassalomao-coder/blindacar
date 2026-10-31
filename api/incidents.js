// GET /api/incidents
// Incidencias de tráfico oficiales de la DGT (DATEX II v3.6, licencia CC-BY): obras, cortes, retenciones, accidentes, meteorología.
// Cubre España salvo Cataluña y País Vasco (Navarra sí). Datos públicos: no hace falta sesión.
// La respuesta se guarda 5 min en la CDN de Vercel y la comparten todos los usuarios (1 descarga a la DGT cada 5 min).

const FEED = 'https://nap.dgt.es/datex2/v3/dgt/SituationPublication/datex2_v36.xml';
const CACHE_S = 300;

// ---------- Lectura del XML (sin dependencias: el formato de la DGT es regular) ----------
const esc = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function tag(xml, name) { // primer <prefijo:name>valor</...>
  const m = new RegExp('<(?:\\w+:)?' + esc(name) + '(?:\\s[^>]*)?>([^<]*)</', 'i').exec(xml);
  return m ? decode(m[1].trim()) : '';
}
function tags(xml, name) {
  const re = new RegExp('<(?:\\w+:)?' + esc(name) + '(?:\\s[^>]*)?>([^<]*)</', 'gi'); const out = []; let m;
  while ((m = re.exec(xml))) out.push(decode(m[1].trim()));
  return out;
}
function block(xml, name) { // contenido de <prefijo:name ...> ... </prefijo:name> (primer bloque)
  const m = new RegExp('<(\\w+:)?' + esc(name) + '(?:\\s[^>]*)?>([\\s\\S]*?)</\\1?' + esc(name) + '>', 'i').exec(xml);
  return m ? m[2] : '';
}
function blocks(xml, name) {
  const re = new RegExp('<(\\w+:)?' + esc(name) + '(\\s[^>]*)?>([\\s\\S]*?)</\\1?' + esc(name) + '>', 'gi'); const out = []; let m;
  while ((m = re.exec(xml))) out.push({ attrs: m[2] || '', body: m[3] });
  return out;
}
const attr = (attrs, n) => { const m = new RegExp('\\b' + esc(n) + '="([^"]*)"').exec(attrs); return m ? m[1] : ''; };
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const num = (s) => { const n = parseFloat(s); return Number.isFinite(n) ? n : null; };
function coords(xml) { const lat = num(tag(xml, 'latitude')), lng = num(tag(xml, 'longitude'));
  return lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [lat, lng] : null; }

// ---------- Clasificación y textos (en español) ----------
const LABEL = {
  roadworks: 'Obras', maintenanceWork: 'Obras de mantenimiento', resurfacingWork: 'Asfaltado',
  rockfalls: 'Desprendimientos', landslips: 'Corrimiento de tierras', flooding: 'Inundación', fallenTrees: 'Árboles caídos',
  snowOnTheRoad: 'Nieve en la calzada', snow: 'Nieve', ice: 'Hielo', blackIce: 'Hielo', fog: 'Niebla', visibilityReduced: 'Visibilidad reducida',
  strongWinds: 'Viento fuerte', heavyRain: 'Lluvia intensa', damagedRoadSurface: 'Firme en mal estado', roadSurfaceInPoorCondition: 'Firme en mal estado',
  obstructionOnTheRoad: 'Obstáculo en la vía', vehicleWithOverwideLoad: 'Transporte especial', brokenDownVehicle: 'Vehículo averiado',
  slowTraffic: 'Tráfico lento', stationaryTraffic: 'Tráfico parado', queuingTraffic: 'Retención', heavyTraffic: 'Tráfico denso',
  roadClosed: 'Carretera cortada', carriagewayClosures: 'Calzada cortada', laneClosures: 'Carril cortado', narrowLanes: 'Carriles estrechos',
  singleAlternateLineTraffic: 'Paso alternativo', lanesDeviated: 'Desvío de carril', intermittentShortTermClosures: 'Cortes intermitentes',
  doNotUseSpecifiedLanesOrCarriageways: 'Carril cerrado', newRoadworksLayout: 'Nuevo trazado por obras', weightRestrictionInOperation: 'Restricción de peso',
  accident: 'Accidente', driveCarefully: 'Precaución',
  vehicleStuck: 'Vehículo detenido', vehicleOnFire: 'Vehículo en llamas', vehicleObstruction: 'Vehículo en la vía', abandonedVehicle: 'Vehículo abandonado',
  spillageOnTheRoad: 'Vertido en la calzada', animalsOnTheRoad: 'Animales en la vía', peopleOnRoadway: 'Personas en la calzada',
};
const CAUSE_CAT = { roadMaintenance: 'works', accident: 'accident', abnormalTraffic: 'jam', vehicleObstruction: 'vehicle',
  poorEnvironment: 'weather', environmentalObstruction: 'weather', obstruction: 'hazard', infrastructureDamageObstruction: 'hazard' };
const PRIORITY = ['closed', 'accident', 'jam', 'vehicle', 'weather', 'hazard', 'works', 'lanes', 'info'];
const SEV = { low: 1, medium: 2, high: 3, highest: 4 };
const JAM_LEVEL = { slowTraffic: 1, heavyTraffic: 1, queuingTraffic: 2, stationaryTraffic: 3 };

function parseRecord(attrs, body) {
  const type = attr(attrs, 'xsi:type').replace(/^\w+:/, '');
  const status = tag(block(body, 'validity'), 'validityStatus');
  const cause = block(body, 'cause');
  const causeType = tag(cause, 'causeType');
  const detail = (block(cause, 'detailedCauseType').match(/>([^<]+)</) || [])[1] || '';
  const mgmt = tags(body, 'roadOrCarriagewayOrLaneManagementType');
  const jam = tag(body, 'abnormalTrafficType');
  const speed = num(tag(body, 'temporarySpeedLimit'));

  let cat = CAUSE_CAT[causeType] || 'info';
  if (mgmt.some((m) => m === 'roadClosed' || m === 'carriagewayClosures')) cat = 'closed';
  else if (type === 'AbnormalTraffic' || jam) cat = 'jam';
  else if (cat === 'info' && mgmt.length) cat = 'lanes';

  const parts = [];
  const add = (k) => { const t = LABEL[k]; if (t && !parts.includes(t)) parts.push(t); };
  if (cat === 'closed') add(mgmt.includes('roadClosed') ? 'roadClosed' : 'carriagewayClosures');
  if (jam) add(jam);
  add(detail.trim()); if (!LABEL[detail.trim()]) add(causeType); // o tipo genérico só quando falta o detalhado
  mgmt.forEach(add);
  if (speed && speed >= 10) parts.push('Velocidad limitada a ' + Math.round(speed));

  // Localización: tramo (from/to) o punto
  const loc = block(body, 'locationReference');
  const from = block(loc, 'from'), to = block(loc, 'to'), point = block(loc, 'point');
  let a = null, b = null;
  if (from || to) { a = coords(from) || coords(to); b = coords(to); }
  else a = coords(point || loc);
  if (!a) return null;
  const ext = from || point || loc;
  return {
    id: attr(attrs, 'id'), status, cat, sev: SEV[tag(body, 'severity')] || 0, jam: JAM_LEVEL[jam] || 0,
    lat: a[0], lng: a[1], lat2: b && (b[0] !== a[0] || b[1] !== a[1]) ? b[0] : null, lng2: b && (b[0] !== a[0] || b[1] !== a[1]) ? b[1] : null,
    road: tag(loc, 'roadName'), km: num(tag(from || point || loc, 'kilometerPoint')), km2: to ? num(tag(to, 'kilometerPoint')) : null,
    town: tag(ext, 'municipality'), prov: tag(ext, 'province'),
    txt: parts.join(' · ') || 'Incidencia',
    start: tag(body, 'overallStartTime') || null, end: tag(body, 'overallEndTime') || null,
  };
}

// Una "situación" agrupa varios registros (p. ej. obras + carril cortado): se muestra uno, el más importante, con todos los textos
function parseFeed(xml, now = Date.now()) {
  const out = [];
  for (const s of blocks(xml, 'situation')) {
    const recs = blocks(s.body, 'situationRecord').map((r) => parseRecord(r.attrs, r.body)).filter(Boolean)
      .filter((r) => r.status === 'active' || (r.status !== 'suspended' && r.start && Date.parse(r.start) <= now))
      .filter((r) => !r.end || Date.parse(r.end) > now);
    if (!recs.length) continue;
    recs.sort((x, y) => PRIORITY.indexOf(x.cat) - PRIORITY.indexOf(y.cat) || y.sev - x.sev);
    const main = { ...recs[0] };
    const txt = [];
    recs.forEach((r) => r.txt.split(' · ').forEach((t) => { if (!txt.includes(t)) txt.push(t); }));
    main.txt = txt.slice(0, 4).join(' · ');
    main.sev = Math.max(...recs.map((r) => r.sev));
    main.jam = Math.max(...recs.map((r) => r.jam));
    main.id = attr(s.attrs, 'id') || main.id;
    delete main.status;
    out.push(main);
  }
  return out;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  try {
    const r = await fetch(FEED, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'Blindacar/1.0 (+https://blindacar.vercel.app)' } });
    if (!r.ok) {
      console.error('dgt upstream', r.status);
      res.setHeader('Cache-Control', 'public, s-maxage=60');
      return res.status(502).json({ error: 'upstream' });
    }
    const xml = await r.text();
    const items = parseFeed(xml);
    res.setHeader('Cache-Control', `public, max-age=60, s-maxage=${CACHE_S}, stale-while-revalidate=600`);
    return res.status(200).json({ source: 'DGT', updatedAt: tag(xml, 'publicationTime') || new Date().toISOString(), count: items.length, items });
  } catch (e) {
    console.error('incidents error', e);
    res.setHeader('Cache-Control', 'public, s-maxage=60');
    return res.status(500).json({ error: 'server_error' });
  }
};

module.exports._internals = { parseFeed, parseRecord };
