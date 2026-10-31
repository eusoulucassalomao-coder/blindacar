// GET /api/incidents
// Incidencias de tráfico oficiales (obras, cortes, retenciones, accidentes, meteorología) de toda España:
//   - DGT (DATEX II v3.6): España salvo Cataluña y País Vasco
//   - Servei Català de Trànsit (DATEX II v1.0): Cataluña
//   - Tráfico del Gobierno Vasco (DATEX II v1.0): País Vasco
// Las tres se publican en el Punto de Acceso Nacional de la DGT (nap.dgt.es). Datos públicos: no hace falta sesión.
// La respuesta se guarda 5 min en la CDN de Vercel y la comparten todos los usuarios. Si una fuente falla, se sirven las demás.

const FEEDS = [
  { src: 'DGT', key: 'dgt', v: 3, url: 'https://nap.dgt.es/datex2/v3/dgt/SituationPublication/datex2_v36.xml' },
  { src: 'SCT', key: 'sct', v: 1, url: 'https://nap.dgt.es/datex2/sct/SituationPublication/all/content.xml' },
  { src: 'Gobierno Vasco', key: 'gv', v: 1, url: 'https://nap.dgt.es/datex2/dt-gv/SituationPublication/all/content.xml' },
];
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
  // DATEX II v1.0 (Cataluña y País Vasco)
  constructionWork: 'Obras', clearingAction: 'Limpieza de la vía', treeAndVegetationCuttingWork: 'Poda y desbroce',
  rearCollision: 'Alcance', stopAndGo: 'Retención intermitente', congestion: 'Retención', vehicleRecovery: 'Retirada de vehículo',
  lanesBlocked: 'Carril cortado', roadPartiallyObstructed: 'Calzada parcialmente cortada', roadBlocked: 'Carretera cortada',
  motorSportRaceMeeting: 'Prueba deportiva', athleticsMeeting: 'Prueba deportiva', cyclingMeeting: 'Prueba deportiva',
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

// ---------- DATEX II v1.0 (Servei Català de Trànsit y Gobierno Vasco) ----------
const V1_CAT = { MaintenanceWorks: 'works', ConstructionWorks: 'works', Accident: 'accident', VehicleObstruction: 'vehicle',
  RoadsideAssistance: 'vehicle', AbnormalTraffic: 'jam', PoorEnvironmentConditions: 'weather', WeatherRelatedRoadConditions: 'weather',
  EnvironmentalObstruction: 'hazard', NonWeatherRelatedRoadConditions: 'hazard', Activities: 'info' };
const V1_DETAIL = ['abnormalTrafficType', 'accidentType', 'vehicleObstructionType', 'roadsideAssistanceType', 'roadMaintenanceType',
  'constructionWorkType', 'publicEventType', 'causeType'];
const V1_JAM = { stopAndGo: 2, slowTraffic: 1, heavyTraffic: 1, queuingTraffic: 2, stationaryTraffic: 3 };
const SMALL = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'i', 'y', 'a', 'en']);
const titleCase = (t) => t && t === t.toUpperCase() && /[A-ZÀ-Ý]{2}/.test(t)
  ? t.toLowerCase().replace(/[^\s\-'’/]+/g, (w, i) => (i && SMALL.has(w) ? w : w[0].toUpperCase() + w.slice(1))) : t;
function names(pt) { // nombres TPEG del punto: townName, linkName (carretera), other (provincia en el País Vasco)
  const out = {}; for (const n of blocks(pt, 'name')) { const k = tag(n.body, 'tpegDescriptorType'); if (!out[k]) out[k] = tag(n.body, 'value'); }
  return out;
}
function parseRecordV1(attrs, body) {
  const type = attr(attrs, 'xsi:type').replace(/^\w+:/, '');
  const status = tag(block(body, 'validity'), 'validityStatus');
  const effects = tags(body, 'effectOnRoadLayout'), restr = tags(body, 'trafficRestrictionType');
  const details = V1_DETAIL.map((k) => tag(body, k)).filter(Boolean);
  const jam = tag(body, 'abnormalTrafficType');

  let cat = V1_CAT[type] || 'info';
  if (restr.includes('roadBlocked') || effects.includes('carriagewayClosures')) cat = 'closed';

  const parts = [];
  const add = (k) => { const t = LABEL[k]; if (t && !parts.includes(t)) parts.push(t); };
  if (cat === 'closed') add(restr.includes('roadBlocked') ? 'roadBlocked' : 'carriagewayClosures');
  if (type === 'Accident') add('accident');
  details.forEach(add);
  if (!parts.length) add({ MaintenanceWorks: 'maintenanceWork', ConstructionWorks: 'roadworks', Accident: 'accident', VehicleObstruction: 'vehicleObstruction', AbnormalTraffic: 'queuingTraffic' }[type]);
  restr.forEach(add); effects.forEach(add);

  const loc = block(body, 'groupOfLocations');
  const from = block(loc, 'from'), to = block(loc, 'to'), point = block(loc, 'point');
  let a = null, b = null;
  if (from || to) { a = coords(from) || coords(to); b = from ? coords(to) : null; }
  else a = coords(point || loc);
  if (!a) return null;
  const nm = names(from || point || to);
  const km = (x) => { const d = num(tag(x, 'referencePointDistance')); return d && d > 0 ? Math.round(d / 100) / 10 : null; };
  const delays = tag(body, 'delaysType'), impact = tag(body, 'impactOnTraffic');
  return {
    id: attr(attrs, 'id'), status, cat,
    sev: delays === 'veryLongDelays' ? 4 : delays === 'longDelays' ? 3 : impact === 'congested' || impact === 'impossible' ? 2 : 0,
    jam: V1_JAM[jam] || (cat === 'jam' ? 1 : 0),
    lat: a[0], lng: a[1], lat2: b && (b[0] !== a[0] || b[1] !== a[1]) ? b[0] : null, lng2: b && (b[0] !== a[0] || b[1] !== a[1]) ? b[1] : null,
    road: tag(body, 'roadNumber') || nm.linkName || '',
    km: km(block(body, 'referencePointPrimaryLocation') || block(body, 'referencePoint')), km2: km(block(body, 'referencePointSecondaryLocation')),
    town: titleCase(nm.townName || ''), prov: titleCase(tag(block(body, 'administrativeArea'), 'value') || nm.other || ''),
    txt: parts.join(' · ') || 'Incidencia',
    start: tag(body, 'overallStartTime') || null, end: tag(body, 'overallEndTime') || null,
  };
}

// Una "situación" agrupa varios registros (p. ej. obras + carril cortado): se muestra uno, el más importante, con todos los textos
function parseFeed(xml, now = Date.now(), v = 3) {
  const out = [], parse = v === 1 ? parseRecordV1 : parseRecord;
  for (const s of blocks(xml, 'situation')) {
    const recs = blocks(s.body, 'situationRecord').map((r) => parse(r.attrs, r.body)).filter(Boolean)
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

// Descarga con un reintento (la DGT a veces corta la conexión)
async function download(url) {
  let last;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(i ? 12000 : 15000), headers: { 'User-Agent': 'Blindacar/1.0 (+https://blindacar.vercel.app)' } });
      if (r.ok) return await r.text();
      last = new Error('HTTP ' + r.status);
    } catch (e) { last = e; }
  }
  throw last;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  const now = Date.now();
  const results = await Promise.allSettled(FEEDS.map(async (f) => {
    const xml = await download(f.url);
    const items = parseFeed(xml, now, f.v).map((i) => ({ ...i, id: f.key === 'dgt' ? i.id : f.key + '-' + i.id, src: f.src }));
    return { items, updatedAt: tag(xml, 'publicationTime') };
  }));
  const items = [], sources = {};
  results.forEach((r, k) => {
    const f = FEEDS[k];
    if (r.status === 'fulfilled') { items.push(...r.value.items); sources[f.key] = r.value.items.length; }
    else { sources[f.key] = 'error'; console.error('incidents upstream', f.key, r.reason && r.reason.message); }
  });
  if (results[0].status !== 'fulfilled' && !items.length) {
    res.setHeader('Cache-Control', 'no-store'); // un fallo no se guarda en la CDN: el siguiente usuario vuelve a intentarlo
    return res.status(502).json({ error: 'upstream' });
  }
  // Si alguna fuente falló, se guarda menos tiempo para recuperarla antes
  const partial = results.some((r) => r.status !== 'fulfilled');
  res.setHeader('Cache-Control', partial ? 'public, max-age=30, s-maxage=60' : `public, max-age=60, s-maxage=${CACHE_S}, stale-while-revalidate=600`);
  const updatedAt = (results[0].status === 'fulfilled' && results[0].value.updatedAt) || new Date(now).toISOString();
  return res.status(200).json({ source: 'DGT', updatedAt, sources, count: items.length, items });
};

module.exports._internals = { parseFeed, parseRecord, parseRecordV1 };
