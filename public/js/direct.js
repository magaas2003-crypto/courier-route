// Прямой режим: если сайт опубликован без серверной части (GitHub Pages,
// «Static Site», открыт файл index.html), браузер обращается к сервисам сам.
//   • 2ГИС — ключ вводится в «Настройках» и хранится только на этом устройстве;
//   • OpenStreetMap (Nominatim) — без ключа, не чаще 1 запроса в секунду;
//   • OSRM — время и расстояния по дорогам, без ключа.
// Логика та же, что в server.js.
(function (root) {
  'use strict';
  const OSRM = 'https://router.project-osrm.org';
  const NOMINATIM = 'https://nominatim.openstreetmap.org';
  const DGIS = 'https://catalog.api.2gis.com/3.0/items/geocode';
  const BBOX = '35.1,56.97,40.25,54.25';
  const RANK = { exact: 0, near: 1, street: 2, other: 3 };

  class DirectError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
  }

  async function getJSON(url, timeout = 15000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    let r;
    try { r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } }); }
    catch (e) { throw new DirectError(0, 'network', 'network'); }
    finally { clearTimeout(t); }
    if (!r.ok) throw new DirectError(r.status, 'http', `HTTP ${r.status}`);
    return r.json();
  }

  const normHouse = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/корпус|корп\.?/g, 'к').replace(/строение|стр\.?/g, 'с').replace(/[\s.,]/g, '');

  async function geocode2gis(key, q, house, near) {
    const u = new URL(DGIS);
    const p = { q, key, fields: 'items.point,items.full_name,items.address', page_size: '6' };
    if (near) p.location = `${near.lon},${near.lat}`;
    u.search = new URLSearchParams(p);
    let j;
    try { j = await getJSON(u); }
    catch (e) { if (e.status === 403 || e.status === 401) throw new DirectError(403, 'key', 'key'); throw e; }
    const code = j?.meta?.code;
    if (code === 404) return [];
    if (code === 401 || code === 403) throw new DirectError(403, 'key', 'key');
    if (code && code !== 200) throw new DirectError(code, '2gis', `2gis ${code}`);
    const want = normHouse(house);
    return (j.result?.items || []).filter((it) => it.point).map((it) => {
      const addr = it.address_name || it.full_name || it.name || '';
      const hn = normHouse(addr.split(',').pop());
      let precision = 'other';
      if (it.type === 'building' || (it.type === 'branch' && addr)) precision = !want || hn === want ? 'exact' : 'near';
      else if (it.type === 'street') precision = 'street';
      return { lat: Number(it.point.lat), lon: Number(it.point.lon), label: it.full_name || addr, kind: it.type, precision, provider: '2gis' };
    });
  }

  let nomChain = Promise.resolve();
  let lastNom = 0;
  function nomSlot() {
    const slot = nomChain.then(async () => {
      const wait = Math.max(0, lastNom + 1100 - Date.now());
      if (wait) await new Promise((r) => setTimeout(r, wait));
      lastNom = Date.now();
    });
    nomChain = slot.catch(() => {});
    return slot;
  }

  function osmLabel(r) {
    const a = r.address || {};
    const street = a.road || a.pedestrian || a.residential || a.neighbourhood || '';
    const parts = [street, a.house_number, a.suburb || a.city_district, a.city || a.town || a.village].filter(Boolean);
    return parts.length ? parts.join(', ') : r.display_name;
  }

  async function geocodeNominatimOnce(q, house) {
    await nomSlot();
    const u = new URL(NOMINATIM + '/search');
    u.search = new URLSearchParams({
      q, format: 'jsonv2', limit: '6', addressdetails: '1', countrycodes: 'ru', 'accept-language': 'ru', viewbox: BBOX, bounded: '1',
    });
    const j = await getJSON(u);
    const want = normHouse(house);
    return j.map((r) => {
      const hn = r.address?.house_number;
      let precision = 'other';
      if (hn) precision = !want || normHouse(hn) === want ? 'exact' : 'near';
      else if (['road', 'street'].includes(r.addresstype)) precision = 'street';
      return { lat: Number(r.lat), lon: Number(r.lon), label: osmLabel(r), kind: r.addresstype || r.type, precision, provider: 'nominatim' };
    });
  }

  function variants(q) {
    const v = new Set([q]);
    v.add(q.replace(/(^|, )(улица|проспект|шоссе|переулок|бульвар|проезд|набережная|площадь|микрорайон) ([^,]+)/, '$1$3 $2'));
    v.add(q.replace(/ к(\d+[а-я]?)/g, ' корпус $1').replace(/ с(\d+[а-я]?)/g, ' строение $1'));
    v.add(q.replace(/ (\d+[а-я]?(?:\/\d+)?) к(\d+)/g, ' $1к$2'));
    return [...v].slice(0, 4);
  }

  async function geocodeNominatim(q, house) {
    let all = [];
    for (const v of variants(q)) {
      const c = await geocodeNominatimOnce(v, house);
      all = all.concat(c);
      if (c.some((x) => x.precision === 'exact')) return c;
    }
    return all;
  }

  function providers(settings) {
    const list = [];
    if (settings.dgisKey) list.push({ id: '2gis', name: '2ГИС', run: (q, h, n) => geocode2gis(settings.dgisKey, q, h, n) });
    list.push({ id: 'nominatim', name: 'OpenStreetMap', run: (q, h) => geocodeNominatim(q, h) });
    return list;
  }

  async function geocode(settings, q, house, near) {
    if (String(q).trim().length < 3) throw new DirectError(400, 'bad_query', 'Адрес слишком короткий — допишите улицу и дом.');
    const list = providers(settings);
    let merged = [];
    const fails = [];
    for (const p of list) {
      try {
        const c = await p.run(q, house, near);
        const exact = c.filter((x) => x.precision === 'exact');
        if (exact.length) return { provider: p.id, candidates: exact.concat(c.filter((x) => x.precision !== 'exact')).slice(0, 6) };
        merged = merged.concat(c);
      } catch (e) { fails.push({ p, e }); }
    }
    if (fails.length === list.length) {
      const { p, e } = fails[0];
      if (e.code === 'key') throw new DirectError(502, 'geocoder_key', `${p.name} отклонил ключ. Проверьте ключ 2ГИС в «Настройках».`);
      throw new DirectError(502, 'geocoder_unavailable', 'Сервис поиска адресов не отвечает. Проверьте интернет и повторите.');
    }
    merged.sort((a, b) => RANK[a.precision] - RANK[b.precision]);
    return { provider: 'mixed', candidates: merged.slice(0, 6) };
  }

  const coordStr = (pts) => pts.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');

  async function matrix(points) {
    try {
      const j = await getJSON(`${OSRM}/table/v1/driving/${coordStr(points)}?annotations=duration,distance`, 25000);
      if (j.code !== 'Ok') throw new Error(j.code);
      return { durations: j.durations, distances: j.distances, provider: 'osrm', traffic: false };
    } catch (e) {
      throw new DirectError(502, 'router_unavailable', 'Сервис расчёта дорог сейчас не отвечает. Повторите через минуту — или постройте приблизительный порядок без учёта дорог.');
    }
  }

  async function route(points) {
    try {
      const j = await getJSON(`${OSRM}/route/v1/driving/${coordStr(points)}?overview=full&geometries=geojson&steps=false`, 25000);
      if (j.code !== 'Ok' || !j.routes?.length) throw new Error(j.code);
      const r = j.routes[0];
      return { geometry: r.geometry, distance: r.distance, duration: r.duration, legs: r.legs.map((l) => ({ distance: l.distance, duration: l.duration })) };
    } catch (e) {
      throw new DirectError(502, 'router_unavailable', 'Не удалось получить линию маршрута. Порядок точек сохранён, на карте показаны прямые отрезки.');
    }
  }

  async function diag(settings) {
    const q = 'Москва, Каширское шоссе, 8 к3';
    const out = [];
    for (const p of providers(settings)) {
      const t0 = Date.now();
      try {
        const c = await p.run(q, '8 к3', null);
        const exact = c.find((x) => x.precision === 'exact');
        out.push({ id: p.id, name: p.name, ok: Boolean(exact), found: c.length, label: (exact || c[0])?.label || '', ms: Date.now() - t0 });
      } catch (e) {
        out.push({ id: p.id, name: p.name, ok: false, error: e.code === 'key' ? 'ключ отклонён' : 'сервис не отвечает (или браузер не пустил запрос)', ms: Date.now() - t0 });
      }
    }
    return { query: q, providers: out };
  }

  // Тот же интерфейс, что у сервера: path + body → ответ.
  async function handle(settings, path, body) {
    const u = new URL(path, 'http://x');
    switch (u.pathname) {
      case '/api/health':
        return { ok: true, direct: true, geocoder: settings.dgisKey ? '2gis' : 'nominatim', geocoders: providers(settings).map((p) => p.id), router: 'osrm', routerHost: 'public-demo', traffic: false, maxPoints: 100 };
      case '/api/geocode': {
        const n = String(u.searchParams.get('near') || '').split(',').map(Number);
        const near = n.length === 2 && n.every(Number.isFinite) ? { lat: n[0], lon: n[1] } : null;
        return geocode(settings, u.searchParams.get('q') || '', u.searchParams.get('house') || '', near);
      }
      case '/api/matrix': return matrix(body.points);
      case '/api/route': return route(body.points);
      case '/api/diag': return diag(settings);
      default: throw new DirectError(404, 'not_found', 'Нет такого метода.');
    }
  }

  root.DirectApi = { handle, DirectError };
})(typeof self !== 'undefined' ? self : globalThis);
