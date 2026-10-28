// Интеграционный тест сервера: поднимает фейковые Nominatim/Яндекс/OSRM
// с ответами в их реальном формате и проверяет, как сервер их разбирает.
import http from 'node:http';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const MOCK_PORT = 39111;
const calls = [];
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  calls.push(u.pathname + u.search);
  const json = (d) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
  if (u.pathname === '/search') {
    const q = u.searchParams.get('q');
    if (/нетакой/i.test(q)) return json([]);
    return json([
      { lat: '55.6702', lon: '37.5524', addresstype: 'building', display_name: '56 к2, Профсоюзная улица, Москва', address: { road: 'Профсоюзная улица', house_number: '56 к2', suburb: 'Черёмушки', city: 'Москва' } },
      { lat: '55.6705', lon: '37.5530', addresstype: 'building', display_name: '56, Профсоюзная улица, Москва', address: { road: 'Профсоюзная улица', house_number: '56', city: 'Москва' } },
    ]);
  }
  if (u.pathname === '/3.0/items/geocode') {
    if (u.searchParams.get('key') === 'bad') return json({ meta: { code: 403, error: { type: 'keyIsBlocked' } } });
    if (/нетакой/i.test(u.searchParams.get('q'))) return json({ meta: { code: 404, error: { type: 'itemNotFound' } } });
    return json({ meta: { code: 200 }, result: { total: 1, items: [
      { type: 'building', full_name: 'Москва, Самуила Маршака, 21', address_name: 'Самуила Маршака, 21', point: { lat: 55.6031, lon: 37.2605 } },
    ] } });
  }
  if (u.pathname === '/1.x/') {
    if (/Маршака/.test(u.searchParams.get('geocode'))) return json({ response: { GeoObjectCollection: { featureMember: [
      { GeoObject: { Point: { pos: '37.26 55.60' }, metaDataProperty: { GeocoderMetaData: { precision: 'street', text: 'Москва, улица Самуила Маршака', kind: 'street' } } } },
    ] } } });
    if (u.searchParams.get('apikey') === 'bad') { res.writeHead(403); return res.end('{}'); }
    return json({ response: { GeoObjectCollection: { featureMember: [
      { GeoObject: { Point: { pos: '37.552400 55.670200' }, metaDataProperty: { GeocoderMetaData: { precision: 'exact', text: 'Россия, Москва, Профсоюзная улица, 56к2', kind: 'house' } } } },
    ] } } });
  }
  if (u.pathname.startsWith('/table/v1/driving/')) {
    const n = u.pathname.split('/').pop().split(';').length;
    const m = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : 100 * Math.abs(i - j) + i)));
    return json({ code: 'Ok', durations: m, distances: m.map((r) => r.map((v) => v * 10)) });
  }
  if (u.pathname.startsWith('/route/v1/driving/')) {
    const pts = u.pathname.split('/').pop().split(';').map((s) => s.split(',').map(Number));
    return json({ code: 'Ok', routes: [{ distance: 1234, duration: 321, geometry: { type: 'LineString', coordinates: pts }, legs: pts.slice(1).map(() => ({ distance: 100, duration: 10 })) }] });
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => mock.listen(MOCK_PORT, r));

async function startApp(port, env) {
  const p = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(port), OSRM_URL: `http://127.0.0.1:${MOCK_PORT}`, NOMINATIM_URL: `http://127.0.0.1:${MOCK_PORT}`, YANDEX_GEOCODER_URL: `http://127.0.0.1:${MOCK_PORT}/1.x/`, DGIS_URL: `http://127.0.0.1:${MOCK_PORT}/3.0/items/geocode`, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    p.stdout.on('data', (d) => { if (String(d).includes('http://localhost')) resolve(); });
    p.on('exit', (c) => reject(new Error('server exited ' + c)));
  });
  return p;
}

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); } catch (e) { failed++; console.log('  ✗', name, '\n    ', e.message); }
}
const get = (port, p, h = {}) => fetch(`http://127.0.0.1:${port}${p}`, { headers: h }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null), type: r.headers.get('content-type') }));
const post = (port, p, b, h = {}) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));

console.log('Сервер (Nominatim + OSRM)');
const A = 39112;
const app = await startApp(A, {});
await t('главная страница отдаётся', async () => {
  const r = await fetch(`http://127.0.0.1:${A}/`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Маршрут курьера/);
});
await t('выход за пределы public запрещён', async () => {
  const r = await fetch(`http://127.0.0.1:${A}/..%2fserver.js`);
  assert.notEqual((await r.text()).includes('YANDEX_KEY'), true);
});
await t('health', async () => {
  const r = await get(A, '/api/health');
  assert.equal(r.body.geocoder, 'nominatim'); assert.equal(r.body.traffic, false);
});
await t('геокодирование: точный корпус отмечен exact, другой дом — near', async () => {
  const r = await get(A, '/api/geocode?q=' + encodeURIComponent('Москва, улица Профсоюзная, 56 к2') + '&house=' + encodeURIComponent('56 к2'));
  assert.equal(r.status, 200);
  assert.equal(r.body.candidates[0].precision, 'exact');
  assert.equal(r.body.candidates[1].precision, 'near');
  assert.equal(r.body.candidates[0].label, 'Профсоюзная улица, 56 к2, Черёмушки, Москва');
  const call = calls.find((c) => c.startsWith('/search'));
  assert.match(call, /bounded=1/); assert.match(call, /countrycodes=ru/);
});
await t('геокодирование: пустой результат', async () => {
  const r = await get(A, '/api/geocode?q=' + encodeURIComponent('нетакой улицы 1'));
  assert.deepEqual(r.body.candidates, []);
});
await t('геокодирование: слишком короткий запрос — понятная ошибка', async () => {
  const r = await get(A, '/api/geocode?q=a');
  assert.equal(r.status, 400); assert.match(r.body.message, /короткий/);
});
await t('матрица', async () => {
  const r = await post(A, '/api/matrix', { points: [{ lat: 55.7, lon: 37.6 }, { lat: 55.71, lon: 37.61 }, { lat: 55.72, lon: 37.62 }] });
  assert.equal(r.status, 200); assert.equal(r.body.durations.length, 3);
  assert.ok(calls.some((c) => c.includes('annotations=duration,distance')));
});
await t('неверные координаты отклоняются', async () => {
  const r = await post(A, '/api/matrix', { points: [{ lat: 'x', lon: 1 }, { lat: 1, lon: 1 }] });
  assert.equal(r.status, 400);
});
await t('линия маршрута', async () => {
  const r = await post(A, '/api/route', { points: [{ lat: 55.7, lon: 37.6 }, { lat: 55.71, lon: 37.61 }] });
  assert.equal(r.body.geometry.type, 'LineString'); assert.equal(r.body.legs.length, 1);
});
app.kill();

console.log('Сервер (Яндекс + код доступа + сбой сервиса)');
const B = 39113;
const app2 = await startApp(B, { YANDEX_GEOCODER_KEY: 'test', APP_PASSWORD: 'secret', OSRM_URL: 'http://127.0.0.1:1' });
await t('без кода доступа — 401 с подсказкой', async () => {
  const r = await get(B, '/api/geocode?q=test%20address');
  assert.equal(r.status, 401); assert.match(r.body.message, /Настройки/);
});
await t('Яндекс Геокодер разбирается, ключ не уходит клиенту', async () => {
  const r = await get(B, '/api/geocode?q=' + encodeURIComponent('Москва, Профсоюзная, 56к2'), { 'x-app-key': 'secret' });
  assert.equal(r.body.provider, 'yandex');
  assert.equal(r.body.candidates[0].lat, 55.6702);
  assert.equal(r.body.candidates[0].precision, 'exact');
  assert.ok(!JSON.stringify(r.body).includes('test'));
});
await t('сервис дорог недоступен — понятное сообщение', async () => {
  const r = await post(B, '/api/matrix', { points: [{ lat: 55.7, lon: 37.6 }, { lat: 55.71, lon: 37.61 }] }, { 'x-app-key': 'secret' });
  assert.equal(r.status, 502); assert.match(r.body.message, /приблизительный порядок/);
});
app2.kill();

console.log('Каскад Яндекс → 2ГИС → OpenStreetMap');
const D = 39115;
const app4 = await startApp(D, { YANDEX_GEOCODER_KEY: 'test', DGIS_KEY: 'test' });
await t('Яндекс нашёл только улицу — дом находит 2ГИС', async () => {
  const r = await get(D, '/api/geocode?q=' + encodeURIComponent('Москва, улица Самуила Маршака, 21') + '&house=21&near=55.6,37.3');
  assert.equal(r.body.provider, '2gis');
  assert.equal(r.body.candidates[0].precision, 'exact');
  assert.equal(r.body.candidates[0].lat, 55.6031);
  assert.ok(calls.some((c) => c.startsWith('/3.0/items/geocode') && c.includes('location=37.3')));
});
await t('health перечисляет все сервисы', async () => {
  assert.deepEqual((await get(D, '/api/health')).body.geocoders, ['yandex', '2gis', 'nominatim']);
});
await t('2ГИС «не найдено» (404) — переходит к OpenStreetMap', async () => {
  const r = await get(D, '/api/geocode?q=' + encodeURIComponent('нетакой улицы 1'));
  assert.equal(r.status, 200);
});
app4.kill();
const E2 = 39116;
const app5 = await startApp(E2, { DGIS_KEY: 'bad', NOMINATIM_URL: 'http://127.0.0.1:1' });
await t('все сервисы отказали — понятная ошибка про ключ 2ГИС', async () => {
  const r = await get(E2, '/api/geocode?q=' + encodeURIComponent('Москва, Тверская, 1'));
  assert.equal(r.status, 502); assert.match(r.body.message, /DGIS_KEY/);
});
app5.kill();

const C = 39114;
const app3 = await startApp(C, { YANDEX_GEOCODER_KEY: 'bad' });
await t('неверный ключ Яндекса — поиск продолжается через OpenStreetMap', async () => {
  const r = await get(C, '/api/geocode?q=' + encodeURIComponent('Москва, Тверская, 1'));
  assert.equal(r.status, 200); // Яндекс отказал, но OpenStreetMap ответил — поиск не ломается
});
app3.kill();

mock.close();
console.log(`\n${passed} прошло, ${failed} упало`);
process.exit(failed ? 1 : 0);
