// Маршрут курьера — серверная часть. Без внешних зависимостей: нужен только Node.js 18+.
//
// Задачи сервера: раздавать интерфейс и проксировать запросы к картографическим
// сервисам, чтобы API-ключи никогда не попадали в браузер.
//
//   GET  /api/health            — какие сервисы подключены
//   GET  /api/geocode?q=&house= — адрес → координаты (Яндекс Геокодер или Nominatim/OSM)
//   POST /api/matrix {points}   — матрица времени и расстояний по дорогам (OSRM)
//   POST /api/route  {points}   — линия маршрута по дорогам для карты (OSRM)

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ключи можно хранить в файле .env рядом с server.js (для запуска на своём компьютере/VPS).
// Файл лежит вне папки public и браузеру не отдаётся.
try {
  const envText = (await fs.readFile(path.join(__dirname, '.env'), 'utf8'));
  for (const line of envText.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* .env нет — берём переменные окружения */ }
const PUBLIC = path.join(__dirname, 'public');

const PORT = Number(process.env.PORT) || 3000;
const YANDEX_KEY = (process.env.YANDEX_GEOCODER_KEY || '').trim();
const DGIS_KEY = (process.env.DGIS_KEY || '').trim();
const DGIS_URL = (process.env.DGIS_URL || 'https://catalog.api.2gis.com/3.0/items/geocode');
const OSRM_URL = (process.env.OSRM_URL || 'https://router.project-osrm.org').replace(/\/+$/, '');
const NOMINATIM_URL = (process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org').replace(/\/+$/, '');
const YANDEX_URL = (process.env.YANDEX_GEOCODER_URL || 'https://geocode-maps.yandex.ru/1.x/');
const CONTACT = (process.env.CONTACT_EMAIL || '').trim();
const APP_PASSWORD = (process.env.APP_PASSWORD || '').trim();
const MAX_POINTS = 100;

// Москва и область: поиск адресов ограничен этим прямоугольником.
const BBOX = { minLon: 35.1, minLat: 54.25, maxLon: 40.25, maxLat: 56.97 };
const UA = `courier-route/1.0 (${CONTACT || 'personal courier routing'})`;

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
class UpstreamError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(body);
}

async function readBody(req, limit = 300_000) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'too_large', 'Слишком большой запрос.');
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new HttpError(400, 'bad_json', 'Неверный формат запроса.'); }
}

async function getJSON(url, { timeout = 12_000 } = {}) {
  let r;
  try {
    r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    throw new UpstreamError(e.name === 'TimeoutError' ? 'timeout' : `network: ${e.cause?.code || e.message}`, 0);
  }
  if (!r.ok) throw new UpstreamError(`HTTP ${r.status}`, r.status);
  return r.json();
}

const cache = new Map();
function cacheGet(k) {
  const v = cache.get(k);
  if (!v) return null;
  if (Date.now() - v.t > 7 * 24 * 3600_000) { cache.delete(k); return null; }
  return v.data;
}
function cachePut(k, data) {
  if (cache.size > 3000) cache.delete(cache.keys().next().value);
  cache.set(k, { t: Date.now(), data });
}

const normHouse = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е')
  .replace(/корпус|корп\.?/g, 'к').replace(/строение|стр\.?/g, 'с')
  .replace(/[\s.,]/g, '');

function validatePoints(points) {
  if (!Array.isArray(points) || points.length < 2) return 'Нужно минимум две точки.';
  if (points.length > MAX_POINTS) return `Слишком много точек (${points.length}). Максимум — ${MAX_POINTS} за один расчёт.`;
  for (const p of points) {
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) {
      return 'Неверные координаты точки.';
    }
  }
  return null;
}

// Простое ограничение частоты: не больше 240 запросов в минуту с одного IP.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip) || { t: now, n: 0 };
  if (now - rec.t > 60_000) { rec.t = now; rec.n = 0; }
  rec.n += 1;
  hits.set(ip, rec);
  if (hits.size > 5000) hits.clear();
  return rec.n > 240;
}

// ---------- geocoding ----------

async function geocodeYandex(q, house, near) {
  const u = new URL(YANDEX_URL);
  u.search = new URLSearchParams({
    apikey: YANDEX_KEY, geocode: q, format: 'json', lang: 'ru_RU', results: '6',
    ll: near ? `${near.lon},${near.lat}` : '37.6176,55.7558', spn: '3.5,2.5', rspn: '0',
  });
  const j = await getJSON(u);
  const fm = j?.response?.GeoObjectCollection?.featureMember || [];
  const precisionMap = { exact: 'exact', number: 'near', near: 'near', range: 'near', street: 'street' };
  return fm.map(({ GeoObject: g }) => {
    const [lon, lat] = g.Point.pos.split(' ').map(Number);
    const m = g.metaDataProperty.GeocoderMetaData;
    return { lat, lon, label: m.text, kind: m.kind, precision: precisionMap[m.precision] || 'other' };
  });
}

// 2ГИС Геокодер: meta.code 404 / itemNotFound — «ничего не найдено».
async function geocode2gis(q, house, near) {
  const u = new URL(DGIS_URL);
  const params = { q, key: DGIS_KEY, fields: 'items.point,items.full_name,items.address', page_size: '6' };
  if (near) { params.location = `${near.lon},${near.lat}`; }
  u.search = new URLSearchParams(params);
  const j = await getJSON(u);
  const code = j?.meta?.code;
  if (code === 404) return [];
  if (code === 403 || code === 401) throw new UpstreamError('2gis key', 403);
  if (code && code !== 200) throw new UpstreamError(`2gis ${code}`, code);
  const want = normHouse(house);
  return (j.result?.items || []).filter((it) => it.point).map((it) => {
    const addr = it.address_name || it.full_name || it.name || '';
    const hn = normHouse(addr.split(',').pop());
    let precision = 'other';
    if (it.type === 'building' || (it.type === 'branch' && addr)) precision = !want || hn === want ? 'exact' : 'near';
    else if (it.type === 'street') precision = 'street';
    return { lat: Number(it.point.lat), lon: Number(it.point.lon), label: it.full_name || addr, kind: it.type, precision };
  });
}

// Nominatim: не чаще 1 запроса в секунду (правила OSMF).
let nomChain = Promise.resolve();
let lastNom = 0;
function nominatimSlot() {
  const slot = nomChain.then(async () => {
    const wait = Math.max(0, lastNom + 1100 - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastNom = Date.now();
  });
  nomChain = slot.catch(() => {});
  return slot;
}

function shortOsmLabel(r) {
  const a = r.address || {};
  const street = a.road || a.pedestrian || a.footway || a.residential || a.neighbourhood || '';
  const parts = [street, a.house_number, a.suburb || a.city_district, a.city || a.town || a.village].filter(Boolean);
  return parts.length ? parts.join(', ') : r.display_name;
}

async function geocodeNominatim(q, house) {
  await nominatimSlot();
  const u = new URL(NOMINATIM_URL + '/search');
  u.search = new URLSearchParams({
    q, format: 'jsonv2', limit: '6', addressdetails: '1', countrycodes: 'ru', 'accept-language': 'ru',
    viewbox: `${BBOX.minLon},${BBOX.maxLat},${BBOX.maxLon},${BBOX.minLat}`, bounded: '1',
  });
  const j = await getJSON(u);
  const want = normHouse(house);
  return j.map((r) => {
    const hn = r.address?.house_number;
    let precision = 'other';
    if (hn) precision = !want || normHouse(hn) === want ? 'exact' : 'near';
    else if (['road', 'street'].includes(r.addresstype)) precision = 'street';
    return { lat: Number(r.lat), lon: Number(r.lon), label: shortOsmLabel(r), kind: r.addresstype || r.type, precision };
  });
}

// Варианты записи корпуса/строения: OSM пишет «8 к3», люди — «8 корпус 3».
function nominatimVariants(q) {
  const v = new Set([q]);
  // В OpenStreetMap улицы записаны «Ферганская улица», а не «улица Ферганская».
  v.add(q.replace(/(^|, )(улица|проспект|шоссе|переулок|бульвар|проезд|набережная|площадь|микрорайон) ([^,]+)/, '$1$3 $2'));
  v.add(q.replace(/ к(\d+[а-я]?)/g, ' корпус $1').replace(/ с(\d+[а-я]?)/g, ' строение $1'));
  v.add(q.replace(/ (\d+[а-я]?(?:\/\d+)?) к(\d+)/g, ' $1к$2').replace(/к(\d+) с(\d+)/g, 'к$1с$2'));
  v.add(q.replace(/ с\d+[а-я]?$/, ''));
  return [...v].slice(0, 4);
}

const PROVIDERS = [
  YANDEX_KEY && { id: 'yandex', name: 'Яндекс', run: geocodeYandex },
  DGIS_KEY && { id: '2gis', name: '2ГИС', run: geocode2gis },
  { id: 'nominatim', name: 'OpenStreetMap', run: async (q, house) => {
    let all = [];
    for (const variant of nominatimVariants(q)) {
      const c = await geocodeNominatim(variant, house);
      all = all.concat(c);
      if (c.some((x) => x.precision === 'exact')) return c;
    }
    return all;
  } },
].filter(Boolean);

const RANK = { exact: 0, near: 1, street: 2, other: 3 };

// Проверка каждого сервиса на известном адресе — для кнопки в «Настройках».
async function diag() {
  const q = 'Москва, Каширское шоссе, 8 к3';
  const out = [];
  for (const p of PROVIDERS) {
    const t0 = Date.now();
    try {
      const c = await p.run(q, '8 к3', null);
      const exact = c.find((x) => x.precision === 'exact');
      out.push({ id: p.id, name: p.name, ok: Boolean(exact), found: c.length, label: (exact || c[0])?.label || '', ms: Date.now() - t0 });
    } catch (e) {
      const keyIssue = e.status === 401 || e.status === 403;
      out.push({ id: p.id, name: p.name, ok: false, error: keyIssue ? 'ключ отклонён' : (e.status === 429 ? 'превышен лимит' : 'сервис не отвечает'), ms: Date.now() - t0 });
    }
  }
  return { query: q, providers: out };
}

// Поиск по очереди: Яндекс → 2ГИС → OpenStreetMap. Первый точный ответ — результат;
// иначе объединяем варианты всех сервисов, чтобы пользователь выбрал.
async function geocode(url) {
  const q = String(url.searchParams.get('q') || '').trim().slice(0, 300);
  const house = String(url.searchParams.get('house') || '').trim().slice(0, 40);
  const nearRaw = String(url.searchParams.get('near') || '').split(',').map(Number);
  const near = nearRaw.length === 2 && nearRaw.every(Number.isFinite) ? { lat: nearRaw[0], lon: nearRaw[1] } : null;
  if (q.length < 3) throw new HttpError(400, 'bad_query', 'Адрес слишком короткий — допишите улицу и дом.');
  const key = `${PROVIDERS.map((p) => p.id).join('+')}|${q.toLowerCase()}|${house.toLowerCase()}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  let merged = [];
  const failures = [];
  for (const p of PROVIDERS) {
    try {
      const c = (await p.run(q, house, near)).map((x) => ({ ...x, provider: p.id }));
      const exact = c.filter((x) => x.precision === 'exact');
      if (exact.length) {
        const out = { provider: p.id, candidates: exact.concat(c.filter((x) => x.precision !== 'exact')).slice(0, 6) };
        cachePut(key, out);
        return out;
      }
      merged = merged.concat(c);
    } catch (e) {
      console.error('geocode', p.id, e.message);
      failures.push({ p, e });
    }
  }
  if (failures.length === PROVIDERS.length) {
    const { p, e } = failures[0];
    if (e.status === 403 || e.status === 401) {
      throw new HttpError(502, 'geocoder_key', `${p.name} отклонил ключ. Проверьте ключ в настройках сервера (${p.id === 'yandex' ? 'YANDEX_GEOCODER_KEY' : 'DGIS_KEY'}).`);
    }
    if (e.status === 429) throw new HttpError(503, 'geocoder_rate', 'Сервис поиска адресов просит подождать (превышен лимит). Повторите через минуту.');
    throw new HttpError(502, 'geocoder_unavailable', 'Сервис поиска адресов сейчас не отвечает. Повторите через минуту или отметьте точку на карте вручную.');
  }
  merged.sort((a, b) => RANK[a.precision] - RANK[b.precision]);
  const out = { provider: 'mixed', candidates: merged.slice(0, 6) };
  if (merged.length) cachePut(key, out);
  return out;
}

// ---------- routing ----------

const coordStr = (points) => points.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');

async function matrix(body) {
  const bad = validatePoints(body?.points);
  if (bad) throw new HttpError(400, 'bad_points', bad);
  try {
    const j = await getJSON(`${OSRM_URL}/table/v1/driving/${coordStr(body.points)}?annotations=duration,distance`, { timeout: 25_000 });
    if (j.code !== 'Ok') throw new UpstreamError(j.code || 'osrm', 0);
    return { durations: j.durations, distances: j.distances, provider: 'osrm', traffic: false };
  } catch (e) {
    console.error('matrix', e.message);
    throw new HttpError(502, 'router_unavailable', 'Сервис расчёта дорог сейчас не отвечает. Повторите через минуту — или постройте приблизительный порядок без учёта дорог.');
  }
}

async function route(body) {
  const bad = validatePoints(body?.points);
  if (bad) throw new HttpError(400, 'bad_points', bad);
  try {
    const j = await getJSON(`${OSRM_URL}/route/v1/driving/${coordStr(body.points)}?overview=full&geometries=geojson&steps=false`, { timeout: 25_000 });
    if (j.code !== 'Ok' || !j.routes?.length) throw new UpstreamError(j.code || 'osrm', 0);
    const r = j.routes[0];
    return {
      geometry: r.geometry, distance: r.distance, duration: r.duration,
      legs: r.legs.map((l) => ({ distance: l.distance, duration: l.duration })),
    };
  } catch (e) {
    console.error('route', e.message);
    throw new HttpError(502, 'router_unavailable', 'Не удалось получить линию маршрута. Порядок точек сохранён, на карте показаны прямые отрезки.');
  }
}

// ---------- static ----------

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
};

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  let data;
  try { data = await fs.readFile(file); }
  catch {
    // неизвестный путь — отдаём приложение
    try { data = await fs.readFile(path.join(PUBLIC, 'index.html')); } catch { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache' });
    return res.end(data);
  }
  const ext = path.extname(file);
  const noCache = ext === '.html' || file.endsWith('sw.js');
  res.writeHead(200, {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Cache-Control': noCache ? 'no-cache' : 'public, max-age=600',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (!p.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      return await serveStatic(req, res, p);
    }
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'x').split(',')[0].trim();
    if (rateLimited(ip)) throw new HttpError(429, 'rate', 'Слишком много запросов подряд. Подождите минуту.');

    if (p === '/api/health') {
      return sendJSON(res, 200, {
        ok: true,
        geocoder: PROVIDERS[0].id,
        geocoders: PROVIDERS.map((p) => p.id),
        router: 'osrm',
        routerHost: OSRM_URL.includes('project-osrm.org') ? 'public-demo' : 'custom',
        traffic: false,
        authRequired: Boolean(APP_PASSWORD),
        maxPoints: MAX_POINTS,
      });
    }
    // Необязательная защита: если задан APP_PASSWORD, чужие люди не смогут
    // расходовать лимиты геокодера, даже зная адрес сайта.
    if (APP_PASSWORD && req.headers['x-app-key'] !== APP_PASSWORD) {
      throw new HttpError(401, 'auth', 'Нужен код доступа. Откройте «Настройки» и введите код, который задан на сервере (APP_PASSWORD).');
    }
    if (p === '/api/diag' && req.method === 'GET') return sendJSON(res, 200, await diag());
    if (p === '/api/geocode' && req.method === 'GET') return sendJSON(res, 200, await geocode(url));
    if (p === '/api/matrix' && req.method === 'POST') return sendJSON(res, 200, await matrix(await readBody(req)));
    if (p === '/api/route' && req.method === 'POST') return sendJSON(res, 200, await route(await readBody(req)));
    throw new HttpError(404, 'not_found', 'Нет такого метода.');
  } catch (e) {
    if (e instanceof HttpError) return sendJSON(res, e.status, { error: e.code, message: e.message });
    console.error(e);
    sendJSON(res, 500, { error: 'internal', message: 'Внутренняя ошибка сервера. Повторите позже.' });
  }
});

server.listen(PORT, () => {
  console.log(`Маршрут курьера: http://localhost:${PORT}`);
  console.log(`  поиск адресов: ${PROVIDERS.map((p) => p.name).join(' → ')}; маршрутизация: ${OSRM_URL}`);
  if (!YANDEX_KEY && !DGIS_KEY) console.log('  Совет: задайте YANDEX_GEOCODER_KEY или DGIS_KEY — адреса будут находиться почти все.');
});
