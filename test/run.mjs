// Тесты разбора адресов и оптимизатора: node test/run.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

function load(file) {
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL(`../public/js/${file}`, import.meta.url), 'utf8'), ctx);
  return ctx;
}
const { AddressParser: P } = load('parser.js');
const { RouteOptimizer: O } = load('optimizer.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { failed++; console.log('  ✗', name, '\n    ', e.message); }
}
const pick = (p) => ({ street: p.street, house: p.house, korpus: p.korpus, stroenie: p.stroenie, flat: p.flat });

console.log('Разбор адресов');
t('улица, дом, корпус, строение, квартира', () => {
  assert.deepEqual(pick(P.parse('г. Москва, ул. Профсоюзная, д. 56, корп. 2, стр. 1, кв. 15')),
    { street: 'улица Профсоюзная', house: '56', korpus: '2', stroenie: '1', flat: '15' });
});
t('слитная запись 56к2с1', () => {
  assert.deepEqual(pick(P.parse('Москва, Профсоюзная улица, 56к2с1')),
    { street: 'улица Профсоюзная', house: '56', korpus: '2', stroenie: '1', flat: '' });
});
t('дом в той же части, что и улица', () => {
  const p = P.parse('Ленинский пр-т 32А кв 7');
  assert.equal(p.street, 'проспект Ленинский'); assert.equal(p.house, '32а'); assert.equal(p.flat, '7');
});
t('латинские буквы от OCR', () => {
  const p = P.parse('yл. Бутлерова, д. 17k2');
  assert.equal(p.street, 'улица Бутлерова'); assert.equal(p.house, '17'); assert.equal(p.korpus, '2');
});
t('дробный номер дома и подъезд/этаж', () => {
  const p = P.parse('Варшавское ш., д. 12/1, подъезд 3, этаж 9, кв. 140');
  assert.equal(p.street, 'шоссе Варшавское'); assert.equal(p.house, '12/1');
  assert.equal(p.entrance, '3'); assert.equal(p.floor, '9'); assert.equal(p.flat, '140');
});
t('улица с цифрами в названии', () => {
  const p = P.parse('1-я Тверская-Ямская ул., 23с1');
  assert.equal(p.street, 'улица 1-я Тверская-Ямская'); assert.equal(p.house, '23'); assert.equal(p.stroenie, '1');
});
t('область и посёлок', () => {
  const p = P.parse('Московская обл., г. Химки, ул. Молодёжная, д. 4');
  assert.equal(p.region, 'Московская обл.'); assert.equal(p.city, 'Химки'); assert.equal(p.house, '4');
  assert.equal(P.toQuery(p, 'Москва'), 'Московская обл., Химки, улица Молодёжная, 4');
});
t('запрос геокодеру без квартиры', () => {
  assert.equal(P.toQuery(P.parse('ул. Профсоюзная, 56к2, кв 15'), 'Москва'), 'Москва, улица Профсоюзная, 56 к2');
});
t('один и тот же дом в разных записях', () => {
  const a = P.buildingKey(P.parse('ул. Ленина, д. 5, корп. 2'));
  const b = P.buildingKey(P.parse('Ленина улица 5к2, кв 3'));
  assert.equal(a, b);
  assert.notEqual(a, P.buildingKey(P.parse('ул. Ленина, д. 5, корп. 3')));
});
t('извлечение адресов из текста скриншота', () => {
  const text = `Доставки на сегодня
Заказ 1234567
ул. Профсоюзная, д. 56
корп. 2, кв. 15
10:00 - 14:00
Иванов И.
+7 900 000-00-00
Москва, Ленинский проспект, 32А
Заказ 7654321
Варшавское ш., 12/1, кв 140
Оплачено`;
  const r = P.extract(text);
  assert.equal(r.length, 3);
  assert.equal(r[0].parsed.korpus, '2'); assert.equal(r[0].parsed.flat, '15');
  assert.equal(r[1].parsed.street, 'проспект Ленинский');
  assert.equal(r[2].parsed.house, '12/1');
});
t('строка без дома помечается неполной', () => {
  const r = P.extract('улица Бутлерова');
  assert.equal(r.length, 1); assert.equal(r[0].incomplete, true);
});

console.log('Формат Wildberries (скриншот курьера)');
const WB = `14:23 LTE 42
Доставка
384cb0a26991
Карта Список
• Москва, Ферганская улица, д. 28/7, кв. 263, >
под. 8, дмф. 263, этаж 3
ОЖИДАЕТ ДОСТАВКИ
• Москва, Каширское шоссе, д. 8к3, кв. 395, >
под. 2, дмф. 395ключ9602, этаж 8
ОЖИДАЕТ ДОСТАВКИ
Новомосковский административный округ,
• район Внуково, улица Самуила Маршака, д. >
21, кв. 130
ОЖИДАЕТ ДОСТАВКИ
• село Петровское, д. 25 >
ЗАБРАТЬ ВОЗВРАТЫ
• Бронницы, микрорайон Марьинский, д. 2, кв. >
34, под. 2, дмф. 34, этаж 5
ЗАБРАТЬ ВОЗВРАТЫ
• Москва, Совхозная улица, д. 10А, кв. 252, >
под. 4, дмф. 252в, этаж 2`;
const wb = P.extract(WB);
t('находит все 6 адресов', () => assert.equal(wb.length, 6));
t('Ферганская: дом с дробью, кв, подъезд, домофон, этаж', () => {
  const p = wb[0].parsed;
  assert.deepEqual([p.street, p.house, p.flat, p.entrance, p.intercom, p.floor], ['улица Ферганская', '28/7', '263', '8', '263', '3']);
});
t('Каширское: корпус и домофон с кодом ключа', () => {
  const p = wb[1].parsed;
  assert.deepEqual([p.house, p.korpus, p.intercom], ['8', '3', '395ключ9602']);
  assert.equal(P.toQuery(p, 'Москва'), 'Москва, шоссе Каширское, 8 к3');
});
t('Новая Москва: адрес из трёх строк, запрос с «Москва»', () => {
  const p = wb[2].parsed;
  assert.equal(p.street, 'улица Самуила Маршака'); assert.equal(p.house, '21'); assert.equal(p.flat, '130');
  assert.match(P.toQuery(p, 'Москва'), /^Москва, /);
  assert.equal(P.toQuerySimple(p, 'Москва'), 'Москва, улица Самуила Маршака, 21');
});
t('село без улицы', () => {
  const p = wb[3].parsed;
  assert.equal(p.locality, 'село Петровское'); assert.equal(p.house, '25');
  assert.equal(P.toQuery(p, 'Москва'), 'село Петровское, 25');
});
t('Бронницы — город, не улица; квартира с переносом строки', () => {
  const p = wb[4].parsed;
  assert.deepEqual([p.city, p.street, p.house, p.flat, p.floor], ['Бронницы', 'микрорайон Марьинский', '2', '34', '5']);
  assert.equal(P.toQuery(p, 'Москва'), 'Бронницы, микрорайон Марьинский, 2');
});
t('плашка «Забрать возвраты» привязана к адресу под ней', () => {
  assert.deepEqual([...wb.map((x) => x.kind)], [null, null, null, null, 'return', 'return']);
});
t('подъезд/этаж/домофон — отдельной строкой', () => {
  assert.equal(P.details(wb[0].parsed), 'подъезд 8 · этаж 3 · домофон 263');
  assert.equal(P.format(wb[0].parsed), 'улица Ферганская, 28/7, кв. 263');
});
t('типичные огрехи OCR: латиница, точка-маркер как «е», без «>»', () => {
  const noisy = WB.replace(/• /g, 'е ').replace(/ >/g, '').replace('Каширское шоссе, д. 8к3', 'Kaширское шоссе, д. 8k3').replace('Совхозная', 'Coвхозная');
  const r = P.extract(noisy);
  assert.equal(r.length, 6);
  assert.equal(r[1].parsed.korpus, '3');
  assert.equal(r[5].parsed.street, 'улица Совхозная');
});
t('перекрывающиеся скриншоты дают одинаковые ключи', () => {
  const a = P.extract('Москва, Совхозная улица, д. 10А, кв. 252,\nпод. 4, дмф. 252в, этаж 2')[0];
  assert.equal(P.buildingKey(a.parsed), P.buildingKey(wb[5].parsed));
});

console.log('Ошибки распознавания цифр');
t('«8кЗ» (буква З) читается как корпус 3', () => {
  const p = P.parse('Москва, Каширское шоссе, д. 8кЗ, кв. 395');
  assert.deepEqual([p.house, p.korpus, p.flat], ['8', '3', '395']);
});
t('«1О» (буква О) → 10, «корп. З» → 3', () => {
  const p = P.parse('ул. Зелёная, д. 1О, корп. З');
  assert.deepEqual([p.street, p.house, p.korpus], ['улица Зелёная', '10', '3']);
});
t('буквы в названиях не трогаются', () => {
  assert.equal(P.parse('деревня Зубово, д. 5').locality, 'деревня Зубово');
  assert.equal(P.parse('Москва, Озёрная улица, д. 3').street, 'улица Озёрная');
});
t('Зеленоград: «корпус 1105» без улицы', () => {
  const r = P.extract('Зеленоград, корпус 1105, кв. 12,\nпод. 3, этаж 4');
  assert.equal(r.length, 1);
  assert.equal(P.toQuery(r[0].parsed, 'Москва'), 'Зеленоград, корпус 1105');
  assert.equal(r[0].parsed.flat, '12');
});

console.log('Оптимизатор');
function randomPoints(n, seed) {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  return Array.from({ length: n }, () => ({ lat: 55.6 + rnd() * 0.3, lon: 37.4 + rnd() * 0.4 }));
}
function asymMatrix(points) {
  const { durations } = O.approxMatrix(points);
  return durations.map((row, i) => row.map((v, j) => (i === j ? 0 : v * (1 + ((i * 7 + j * 3) % 5) / 10))));
}
function bruteForce(D) {
  const n = D.length - 1;
  let best = Infinity;
  const perm = (arr, used, cost, prev) => {
    if (arr.length === n) { best = Math.min(best, cost); return; }
    for (let k = 1; k <= n; k++) if (!used[k]) { used[k] = true; arr.push(k); perm(arr, used, cost + D[prev][k], k); arr.pop(); used[k] = false; }
  };
  perm([], [], 0, 0);
  return best;
}
t('точный алгоритм совпадает с перебором (8 точек, асимметрично)', () => {
  for (const seed of [1, 7, 42]) {
    const D = asymMatrix(randomPoints(9, seed));
    const r = O.solve(D);
    assert.equal(r.method, 'exact');
    assert.ok(Math.abs(r.travel - bruteForce(D)) < 1e-6);
  }
});
t('эвристика близка к точному решению (12 точек)', () => {
  for (const seed of [3, 11, 99]) {
    const D = asymMatrix(randomPoints(13, seed));
    const exact = O.solve(D).travel;
    const w = Array(13).fill(null); w[5] = { from: null, to: 1e9 }; // включает эвристику, окно не мешает
    const heur = O.solve(D, { windows: w, timeLimitMs: 300 }).travel;
    assert.ok(heur <= exact * 1.03, `heur ${heur.toFixed(0)} vs exact ${exact.toFixed(0)}`);
  }
});
t('порядок — перестановка всех точек (40 точек)', () => {
  const D = asymMatrix(randomPoints(41, 5));
  const r = O.solve(D, { windows: [null, { to: 900 }], timeLimitMs: 400 });
  assert.deepEqual([...r.order].sort((a, b) => a - b), Array.from({ length: 40 }, (_, i) => i + 1));
});
t('срочная точка ставится раньше', () => {
  // точки на линии: 1 близко, 2 дальше, 3 далеко; у 3 дедлайн — сразу
  const D = [
    [0, 60, 120, 300],
    [60, 0, 60, 540],
    [120, 60, 0, 480],
    [300, 540, 480, 0],
  ];
  const free = O.solve(D);
  assert.deepEqual([...free.order], [1, 2, 3]);
  const urgent = O.solve(D, { windows: [null, null, null, { to: 400 }] });
  assert.equal(urgent.order[0], 3);
  assert.equal(urgent.lateCount, 0);
});
t('недостижимые пары (null) не ломают расчёт', () => {
  const D = [[0, 100, null], [100, 0, 50], [null, 50, 0]];
  assert.deepEqual([...O.solve(D).order], [1, 2]);
});
t('скорость: 60 точек укладываются в лимит', () => {
  const D = asymMatrix(randomPoints(61, 8));
  const t0 = Date.now();
  O.solve(D, { windows: [null, { to: 3000 }], timeLimitMs: 800 });
  assert.ok(Date.now() - t0 < 2500);
});

console.log(`\n${passed} прошло, ${failed} упало`);
process.exit(failed ? 1 : 0);
