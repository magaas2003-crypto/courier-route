// Маршрут курьера — интерфейс.
(() => {
  'use strict';
  const P = window.AddressParser;
  const OPT = window.RouteOptimizer;
  const NAV = window.NavLinks;
  const LS_KEY = 'courier-route-v1';

  // ---------- состояние ----------
  const defaults = () => ({
    stops: [],
    start: null,
    route: null,
    history: [],
    ignoredDupes: [],
    settings: { nav: 'yandexnavi', service: 4, appKey: '', city: 'Москва', auto: true },
  });
  let S = load();
  let health = null;
  let pick = null; // { type: 'start' } | { type: 'stop', id }
  const ui = { editing: null, windowEdit: null, busyRoute: false, busyGps: false, routeMsg: null, ocrLog: [] };

  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        const d = defaults();
        return { ...d, ...s, settings: { ...d.settings, ...(s.settings || {}) } };
      }
    } catch (e) { /* хранилище недоступно — начинаем с пустого */ }
    return defaults();
  }
  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) { /* нет места или приватный режим */ }
  }

  const $ = (s) => document.querySelector(s);
  const uid = () => Math.random().toString(36).slice(2, 10);
  const byId = (id) => S.stops.find((s) => s.id === id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtDur(sec) {
    if (!Number.isFinite(sec)) return '—';
    const m = Math.max(1, Math.round(sec / 60));
    if (m < 60) return `${m} мин`;
    return `${Math.floor(m / 60)} ч ${String(m % 60).padStart(2, '0')} мин`;
  }
  function fmtKm(m) {
    if (!Number.isFinite(m)) return '—';
    return m < 1000 ? `${Math.round(m / 10) * 10} м` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} км`;
  }
  const fmtClock = (ms) => new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  // ---------- уведомления ----------
  function toast(msg, { kind = '', actions = [], timeout = kind === 'err' ? 0 : 5000 } = {}) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    el.innerHTML = `<div>${esc(msg)}</div>`;
    const box = document.createElement('div');
    box.className = 'actions';
    for (const a of actions) {
      const b = document.createElement(a.href ? 'a' : 'button');
      b.className = 'btn';
      b.textContent = a.label;
      if (a.href) { b.href = a.href; b.target = '_blank'; b.rel = 'noopener'; } else b.type = 'button';
      b.addEventListener('click', () => { a.onClick?.(); el.remove(); });
      box.append(b);
    }
    const close = document.createElement('button');
    close.className = 'btn'; close.type = 'button'; close.textContent = 'Закрыть';
    close.addEventListener('click', () => el.remove());
    box.append(close);
    el.append(box);
    $('#toasts').append(el);
    while ($('#toasts').children.length > 3) $('#toasts').firstElementChild.remove();
    if (timeout) setTimeout(() => el.remove(), timeout);
    return el;
  }

  // ---------- сервер ----------
  class AppError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

  // Есть ли у сайта серверная часть? Если нет (404, статический хостинг, файл) —
  // работаем напрямую из браузера (js/direct.js).
  let mode = null;
  let modeReady = null;
  function detectMode() {
    if (mode) return Promise.resolve(mode);
    if (!modeReady) {
      modeReady = (async () => {
        try {
          const headers = S.settings.appKey ? { 'x-app-key': S.settings.appKey } : {};
          const r = await fetch('/api/health', { headers });
          const j = await r.json().catch(() => null);
          mode = r.ok && j?.ok ? 'server' : 'direct';
        } catch (e) {
          if (!navigator.onLine) { modeReady = null; return null; } // решим, когда появится сеть
          mode = 'direct';
        }
        return mode;
      })();
    }
    return modeReady;
  }

  async function api(path, { method = 'GET', body, timeout = 30000 } = {}) {
    if (!navigator.onLine) throw new AppError('offline', 'Нет подключения к интернету. Проверьте мобильную сеть и повторите.');
    await detectMode();
    if (mode === 'direct') {
      try { return await window.DirectApi.handle(S.settings, path, body); }
      catch (e) { throw new AppError(e.code || 'direct', e.code === 'network' ? 'Нет связи с сервисом. Проверьте интернет и повторите.' : e.message); }
    }
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (S.settings.appKey) headers['x-app-key'] = S.settings.appKey;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let r;
    try {
      r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
    } catch (e) {
      throw new AppError('network', 'Сервер приложения не отвечает. Если интернет есть — подождите минуту (бесплатный сервер мог «уснуть») и повторите.');
    } finally { clearTimeout(timer); }
    let j = null;
    try { j = await r.json(); } catch (e) { /* не JSON */ }
    if (!r.ok) throw new AppError(j?.error || 'http', j?.message || `Ошибка сервера (${r.status}). Повторите позже.`);
    return j;
  }

  async function loadHealth() {
    try { health = await api('/api/health', { timeout: 60000 }); }
    catch (e) { health = { error: e.message }; }
    renderServices();
  }

  // ---------- адреса ----------
  function stopKey(s) { return s.parsed ? P.buildingKey(s.parsed) : ''; }
  function exactKey(s) { const k = stopKey(s); return k ? `${k}#${s.parsed.flat || ''}` : s.text.toLowerCase(); }

  function makeStop(text, source, parsed, kind) {
    const p = parsed || P.parse(text);
    return {
      id: uid(), raw: text, parsed: p, text: P.format(p) || P.normalize(text), source,
      status: 'pending', candidates: [], lat: null, lon: null, label: '', error: '',
      window: { from: '', to: '' }, delivery: 'pending', extraOrders: [], addedAt: Date.now(),
      kind: kind || null,
    };
  }

  function addStops(items, { source, manual = false } = {}) {
    const added = [];
    const skipped = [];
    const existing = new Map(S.stops.map((s) => [exactKey(s), s]));
    for (const it of items) {
      const st = makeStop(it.text, source, it.parsed, it.kind);
      const k = exactKey(st);
      if (existing.has(k)) { skipped.push({ st, dup: existing.get(k) }); continue; }
      existing.set(k, st);
      S.stops.push(st);
      added.push(st);
    }
    if (S.route && added.length) S.route.stale = 'added';
    save();
    added.forEach(queueGeocode);
    if (skipped.length) {
      if (manual) {
        const { st, dup } = skipped[0];
        toast(`Этот адрес уже есть в списке: «${dup.text}».`, {
          kind: 'warn',
          actions: [{ label: 'Всё равно добавить', onClick: () => { S.stops.push(st); if (S.route) S.route.stale = 'added'; save(); queueGeocode(st); render(); } }],
        });
      } else {
        toast(`Пропущено повторов: ${skipped.length}. Эти адреса уже есть в списке (скриншоты могли перекрываться).`, { kind: 'warn', timeout: 8000 });
      }
    }
    render();
    return added;
  }

  function removeStop(id) {
    const st = byId(id);
    S.stops = S.stops.filter((s) => s.id !== id);
    if (S.route) S.route.order = S.route.order.filter((x) => x !== id);
    save(); render();
    if (st) toast(`Удалён: ${st.text}`, { actions: [{ label: 'Вернуть', onClick: () => { S.stops.push(st); if (S.route) S.route.stale = 'added'; save(); render(); } }] });
  }

  function updateStopText(id, text) {
    const st = byId(id);
    if (!st || !text.trim()) return;
    const p = P.parse(text);
    st.raw = text; st.parsed = p; st.text = P.format(p) || P.normalize(text);
    st.lat = st.lon = null; st.label = ''; st.candidates = [];
    if (S.route?.order.includes(id)) S.route.stale = 'edited';
    save();
    queueGeocode(st);
  }

  function mergeInto(targetId, otherId) {
    const t = byId(targetId), o = byId(otherId);
    if (!t || !o) return;
    t.extraOrders = [...(t.extraOrders || []), o.text, ...(o.extraOrders || [])];
    if (!t.window.to && o.window.to) t.window.to = o.window.to;
    if (!t.window.from && o.window.from) t.window.from = o.window.from;
    S.stops = S.stops.filter((s) => s.id !== otherId);
    if (S.route) S.route.order = S.route.order.filter((x) => x !== otherId);
    save(); render();
  }

  function duplicateGroups() {
    const groups = new Map();
    for (const s of S.stops) {
      if (s.delivery === 'done' || s.delivery === 'skipped') continue;
      const k = stopKey(s);
      if (!k || S.ignoredDupes.includes(k)) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    }
    return [...groups.entries()].filter(([, g]) => g.length > 1);
  }

  // ---------- геокодирование ----------
  let geoChain = Promise.resolve();
  function queueGeocode(st) {
    st.status = 'queued'; st.error = '';
    geoChain = geoChain.then(() => geocodeStop(st)).catch(() => {});
    renderSoon();
  }

  async function geocodeStop(st) {
    if (!S.stops.includes(st)) return;
    const q = P.toQuery(st.parsed, S.settings.city) || st.text;
    st.status = 'geocoding';
    renderSoon();
    try {
      const house = encodeURIComponent(P.houseString(st.parsed));
      const near = S.start ? `&near=${S.start.lat.toFixed(5)},${S.start.lon.toFixed(5)}` : '';
      let c = (await api(`/api/geocode?q=${encodeURIComponent(q)}&house=${house}${near}`)).candidates || [];
      // Ничего точного — пробуем короче: без округа и района («Москва, улица …, 21»).
      const q2 = P.toQuerySimple(st.parsed, S.settings.city);
      if (q2 && q2 !== q && !c.some((x) => x.precision === 'exact')) {
        const c2 = (await api(`/api/geocode?q=${encodeURIComponent(q2)}&house=${house}${near}`)).candidates || [];
        c = c2.some((x) => x.precision === 'exact') ? c2 : c.concat(c2);
      }
      applyGeocode(st, c);
    } catch (e) {
      st.status = 'error';
      st.error = e.message;
    }
    save(); renderSoon();
  }

  function applyGeocode(st, c) {
    // одинаковые точки от разных сервисов — один вариант; ближайшие к вам — выше
    const uniq = [];
    for (const x of c) if (!uniq.some((u) => OPT.haversine(u, x) < 40 && u.precision === x.precision)) uniq.push(x);
    const rank = { exact: 0, near: 1, street: 2, other: 3 };
    c = uniq.sort((a, b) => (rank[a.precision] - rank[b.precision]) || (S.start ? OPT.haversine(S.start, a) - OPT.haversine(S.start, b) : 0));
    st.candidates = c.slice(0, 5);
    if (!c.length) { st.status = 'notfound'; st.lat = st.lon = null; return; }
    const exact = c.filter((x) => x.precision === 'exact');
    if (exact.length && exact.every((x) => OPT.haversine(x, exact[0]) < 150)) {
      setPoint(st, exact[0]);
      return;
    }
    st.status = 'ambiguous';
    st.lat = st.lon = null;
  }

  function setPoint(st, p) {
    const moved = st.lat == null || OPT.haversine(st, p) > 30;
    st.lat = p.lat; st.lon = p.lon; st.label = p.label || st.label; st.status = 'ok'; st.error = '';
    if (moved && S.route?.order.includes(st.id)) S.route.stale = 'edited';
  }

  function retryFailed() {
    S.stops.filter((s) => s.status === 'error').forEach(queueGeocode);
  }

  // ---------- распознавание скриншотов ----------
  let ocrWorker = null;
  let ocrProgress = null;

  async function getWorker() {
    if (ocrWorker) return ocrWorker;
    for (let i = 0; i < 50 && !window.Tesseract; i++) await new Promise((r) => setTimeout(r, 100));
    if (!window.Tesseract) throw new AppError('ocr_lib', 'Модуль распознавания не загрузился. Проверьте интернет и обновите страницу.');
    ocrWorker = await window.Tesseract.createWorker('rus', 1, { logger: (m) => ocrProgress?.(m) });
    return ocrWorker;
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve({ img, url });
      img.onerror = () => { URL.revokeObjectURL(url); reject(new AppError('image', 'Не удалось открыть изображение. Сохраните скриншот как PNG или JPEG и попробуйте снова.')); };
      img.src = url;
    });
  }

  // Ч/б и инверсия тёмной темы: Tesseract лучше читает тёмный текст на светлом.
  async function prepareImage(file) {
    const { img, url } = await loadImage(file);
    const w0 = img.naturalWidth, h0 = img.naturalHeight;
    const scale = w0 < 900 ? 2 : (w0 > 2200 ? 2200 / w0 : 1);
    const w = Math.round(w0 * scale), h = Math.round(h0 * scale);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(url);
    const data = ctx.getImageData(0, 0, w, h);
    const d = data.data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 16) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const dark = sum / (d.length / 16) < 115;
    for (let i = 0; i < d.length; i += 4) {
      let g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (dark) g = 255 - g;
      g = g < 150 ? Math.max(0, g * 0.85) : Math.min(255, g * 1.15);
      d[i] = d[i + 1] = d[i + 2] = g;
    }
    ctx.putImageData(data, 0, 0);
    return c;
  }

  async function handleFiles(files) {
    files = [...files].filter((f) => f.type.startsWith('image/') || /\.(heic|heif|png|jpe?g|webp)$/i.test(f.name));
    if (!files.length) return;
    // GPS запрашиваем сразу, пока идёт распознавание (на iPhone — в ответ на нажатие).
    if (S.settings.auto !== false) ensureStartAuto();
    if (!navigator.onLine && !ocrWorker) {
      toast('Для первого распознавания нужен интернет: загружается словарь русского языка. Подключитесь к сети и повторите.', { kind: 'err' });
      return;
    }
    const box = $('#ocr-status');
    const setStatus = (text, pct) => {
      $('#ocr-text').textContent = text;
      $('#ocr-pct').textContent = pct == null ? '' : `${Math.round(pct * 100)}%`;
      $('#ocr-bar').style.width = `${Math.round((pct || 0) * 100)}%`;
    };
    box.hidden = false;
    $('#upload-label').classList.add('is-busy');
    $('#file-input').disabled = true;
    let total = 0;
    const empty = [];
    try {
      setStatus('Загружаю модуль распознавания…', 0);
      let idx = 0;
      ocrProgress = (m) => {
        if (m.status === 'recognizing text') setStatus(`Скриншот ${idx} из ${files.length}: читаю текст…`, m.progress);
        else if (/load/i.test(m.status) && idx === 0) setStatus('Загружаю словарь русского языка (один раз)…', m.progress);
      };
      const worker = await getWorker();
      for (const file of files) {
        idx++;
        setStatus(`Скриншот ${idx} из ${files.length}: подготовка…`, 0);
        let text = '';
        try {
          const canvas = await prepareImage(file);
          const r = await worker.recognize(canvas);
          text = r.data.text || '';
        } catch (e) {
          ui.ocrLog.push({ name: `Скриншот ${idx}`, text: '', error: e.message });
          empty.push(idx);
          continue;
        }
        const found = P.extract(text);
        ui.ocrLog.push({ name: `Скриншот ${idx}`, text, count: found.length });
        if (!found.length) { empty.push(idx); continue; }
        total += addStops(found, { source: `Скриншот ${idx}` }).length;
      }
      setStatus(`Готово: добавлено адресов — ${total}`, 1);
      if (empty.length) {
        toast(`На скриншотах ${empty.join(', ')} адреса не найдены. Проверьте, что адрес виден целиком, или добавьте его вручную.`, {
          kind: 'warn', timeout: 0,
          actions: [{ label: 'Показать текст', onClick: () => showOcrText(empty[0]) }],
        });
      }
    } catch (e) {
      toast(e.message || 'Не удалось распознать скриншоты.', { kind: 'err' });
      setStatus('Распознавание не удалось', 0);
    } finally {
      ocrProgress = null;
      $('#upload-label').classList.remove('is-busy');
      $('#file-input').disabled = false;
      $('#file-input').value = '';
      setTimeout(() => { box.hidden = true; }, 2500);
      render();
      autoRun();
    }
  }

  // ---------- автоматический режим ----------
  // Скриншоты → GPS → поиск адресов → маршрут, без нажатий.
  let autoGps = null;
  function ensureStartAuto() {
    if (S.start && S.start.source !== 'gps') return Promise.resolve(true); // старт задан вручную
    if (S.start && Date.now() - (S.start.at || 0) < 5 * 60_000) return Promise.resolve(true);
    if (!autoGps) {
      autoGps = gps()
        .then((p) => { ui.gpsError = ''; setStart(p, 'gps', `Моё местоположение (точность ±${Math.round(p.acc)} м)`); return true; })
        .catch((e) => { ui.gpsError = e.message; return Boolean(S.start); })
        .finally(() => { setTimeout(() => { autoGps = null; }, 0); });
    }
    return autoGps;
  }

  function setAuto(text, kind = 'busy', actions = '') {
    const el = $('#auto-status');
    if (!text) { el.hidden = true; return; }
    el.hidden = false;
    el.className = `auto-status ${kind === 'busy' ? '' : kind}`;
    el.innerHTML = `${kind === 'busy' ? '<span class="spin" aria-hidden="true"></span>' : ''}<div class="msg"><div>${esc(text)}</div>${actions}</div>`;
  }

  async function geoIdle() {
    while (S.stops.some((s) => s.status === 'queued' || s.status === 'geocoding')) {
      const n = S.stops.filter((s) => s.status === 'ok').length;
      setAuto(`Ищу адреса… найдено ${n} из ${activeStops().length}`);
      await geoChain;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async function autoRun() {
    if (S.settings.auto === false) return;
    if (ui.autoRunning) { ui.autoAgain = true; return; }
    ui.autoRunning = true;
    try {
      do {
        ui.autoAgain = false;
        const active = activeStops();
        if (!active.length) { setAuto(''); break; }
        setAuto('Определяю, где вы…');
        const haveStart = await ensureStartAuto();
        await geoIdle();
        const act = activeStops();
        const unresolved = act.filter((s) => s.status !== 'ok');
        if (!haveStart) {
          setAuto(`Не получилось определить местоположение. ${ui.gpsError || ''} Укажите старт в шаге 2 — маршрут построится сам.`, 'warn');
          break;
        }
        if (unresolved.length) {
          setAuto(`Найдено ${act.length - unresolved.length} из ${act.length}. Уточните ${unresolved.length} — после этого маршрут построится сам.`, 'warn',
            '<div class="actions" style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-small" type="button" data-act="goto-unresolved">Показать</button><button class="btn btn-small" type="button" data-act="build-skip">Построить без них</button></div>');
          break;
        }
        const r = S.route;
        const need = !r || r.stale || act.some((s) => !r.order.includes(s.id));
        if (!need) { setAuto(''); break; }
        setAuto(`Считаю лучший порядок для ${act.length} адресов…`);
        await buildRoute({});
        if (S.route && !S.route.stale && !ui.routeMsg) {
          setAuto(`Маршрут готов: ${queue().length} адресов. Нажмите «Поехать».`, 'ok');
          setTimeout(() => { if ($('#auto-status').classList.contains('ok')) setAuto(''); }, 6000);
        } else setAuto('');
      } while (ui.autoAgain);
    } finally {
      ui.autoRunning = false;
    }
  }

  function renderAutoHint() {
    $('#auto-hint').textContent = S.settings.auto === false
      ? 'Автоматический режим выключен: укажите старт и нажмите «Построить оптимальный маршрут».'
      : 'Дальше всё само: определю, где вы, найду адреса и построю маршрут.';
  }

  function showOcrText(n) {
    const log = ui.ocrLog.filter((l) => !n || l.name === `Скриншот ${n}`);
    const last = log.length ? log : ui.ocrLog;
    $('#ocr-dialog-text').textContent = last.map((l) => `— ${l.name} —\n${l.error || l.text || '(текст не найден)'}`).join('\n\n') || 'Пока ничего не распознано.';
    $('#ocr-dialog').showModal();
  }

  // ---------- местоположение ----------
  function gps(timeout = 15000) {
    return new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) return reject(new AppError('nogps', 'Этот браузер не умеет определять местоположение. Введите адрес или отметьте точку на карте.'));
      if (!window.isSecureContext) return reject(new AppError('insecure', 'Геолокация работает только на сайте с https. Откройте приложение по адресу https://… или введите адрес вручную.'));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }),
        (e) => {
          const msg = {
            1: 'Нет доступа к геолокации. На iPhone: Настройки → Конфиденциальность → Службы геолокации → Safari (или «Сайты Safari») → «При использовании». Затем обновите страницу. Пока можно ввести адрес или отметить точку на карте.',
            2: 'Телефон не смог определить местоположение. Выйдите на открытое место или введите адрес вручную.',
            3: 'Местоположение определяется слишком долго. Повторите или введите адрес вручную.',
          }[e.code] || 'Не удалось определить местоположение.';
          reject(new AppError('gps', msg));
        },
        { enableHighAccuracy: true, timeout, maximumAge: 20000 },
      );
    });
  }

  function setStart(p, source, label) {
    const changed = !S.start || OPT.haversine(S.start, p) > 100;
    S.start = { lat: p.lat, lon: p.lon, acc: p.acc, source, label, at: Date.now() };
    if (changed && S.route && queue().length) S.route.stale = 'start';
    save(); render();
    map.flyTo?.([p.lat, p.lon], Math.max(map.getZoom?.() || 12, 13));
  }

  async function onGps() {
    if (ui.busyGps) return;
    ui.busyGps = true;
    $('#btn-gps').classList.add('is-busy');
    try {
      const p = await gps();
      setStart(p, 'gps', `Моё местоположение (точность ±${Math.round(p.acc)} м)`);
      autoRun();
    } catch (e) {
      toast(e.message, { kind: 'err', actions: [{ label: 'Отметить на карте', onClick: () => startPick({ type: 'start' }) }] });
    } finally {
      ui.busyGps = false;
      $('#btn-gps').classList.remove('is-busy');
    }
  }

  async function onStartAddress(text) {
    const p = P.parse(text);
    const q = P.toQuery(p, S.settings.city) || text;
    try {
      const r = await api(`/api/geocode?q=${encodeURIComponent(q)}&house=${encodeURIComponent(P.houseString(p))}`);
      const c = r.candidates || [];
      if (!c.length) return toast('Адрес не найден. Проверьте написание или отметьте точку на карте.', { kind: 'warn' });
      const best = c.find((x) => x.precision === 'exact') || c[0];
      setStart(best, 'address', best.label || text);
      autoRun();
      if (best.precision !== 'exact') toast('Найден приблизительно. Если точка неточная — отметьте её на карте.', { kind: 'warn' });
    } catch (e) { toast(e.message, { kind: 'err' }); }
  }

  // ---------- маршрут ----------
  function activeStops() { return S.stops.filter((s) => s.delivery === 'pending' || s.delivery === 'later'); }

  function queue() {
    if (!S.route) return [];
    const rs = S.route.order.map(byId).filter(Boolean);
    const pend = rs.filter((s) => s.delivery === 'pending');
    const later = rs.filter((s) => s.delivery === 'later').sort((a, b) => a.laterAt - b.laterAt);
    return pend.concat(later);
  }

  function windowSecs(w, now) {
    const f = (t) => {
      if (!t) return null;
      const [h, m] = t.split(':').map(Number);
      const d = new Date(now); d.setHours(h, m, 0, 0);
      return (d - now) / 1000;
    };
    const from = f(w?.from), to = f(w?.to);
    return from == null && to == null ? null : { from, to };
  }

  function setRouteMsg(html) { ui.routeMsg = html; renderRouteMsg(); }

  async function buildRoute({ recalc = false, skipUnresolved = false, approx = false } = {}) {
    if (ui.busyRoute) return;
    const active = activeStops();
    if (!active.length) return setRouteMsg('<div class="issue warn">Добавьте хотя бы один адрес доставки.</div>');

    const waiting = active.filter((s) => ['queued', 'geocoding', 'pending'].includes(s.status));
    if (waiting.length) return setRouteMsg(`<div class="issue warn">Ещё ищу на карте адресов: ${waiting.length}. Подождите несколько секунд и нажмите снова.</div>`);

    const unresolved = active.filter((s) => s.status !== 'ok');
    if (unresolved.length && !skipUnresolved) {
      return setRouteMsg(`<div class="issue warn"><div><strong>Нужно уточнить адресов: ${unresolved.length}.</strong> Я не строю маршрут в случайную точку — выберите правильный вариант, исправьте адрес или отметьте его на карте.</div>
        <div class="actions"><button class="btn btn-small" data-act="goto-unresolved" type="button">Показать</button>
        <button class="btn btn-small" data-act="build-skip" type="button">Построить без них</button></div></div>`);
    }

    ui.busyRoute = true;
    $('#btn-route').classList.add('is-busy');
    setRouteMsg('');
    try {
      let start = S.start;
      if (recalc) {
        try {
          const p = await gps(8000);
          S.start = { lat: p.lat, lon: p.lon, acc: p.acc, source: 'gps', label: `Моё местоположение (±${Math.round(p.acc)} м)`, at: Date.now() };
          start = S.start;
        } catch (e) {
          const last = S.stops.filter((s) => s.delivery === 'done' && s.lat != null).sort((a, b) => b.doneAt - a.doneAt)[0];
          if (last) start = { lat: last.lat, lon: last.lon, label: `От последней доставки: ${last.text}` };
        }
      }
      if (!start) {
        setRouteMsg('<div class="issue warn">Укажите, откуда начинаете: «Определить моё местоположение», начальный адрес или точка на карте.</div>');
        $('#step-start').scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      const stops = active.filter((s) => s.status === 'ok');
      const maxStops = (health?.maxPoints || 100) - 1;
      if (stops.length > maxStops) {
        setRouteMsg(`<div class="issue err">Слишком много адресов за один расчёт: ${stops.length}. Максимум — ${maxStops}. Удалите или пропустите часть адресов.</div>`);
        return;
      }
      const points = [start, ...stops].map((p) => ({ lat: p.lat, lon: p.lon }));
      let M;
      if (approx || points.length < 2) {
        M = OPT.approxMatrix(points);
      } else {
        try {
          M = await api('/api/matrix', { method: 'POST', body: { points } });
        } catch (e) {
          setRouteMsg(`<div class="issue err"><div>${esc(e.message)}</div><div class="actions">
            <button class="btn btn-small" data-act="build-retry" type="button">Повторить</button>
            <button class="btn btn-small" data-act="build-approx" type="button">Приблизительный порядок</button></div></div>`);
          return;
        }
      }
      const now = Date.now();
      const service = Math.max(0, Number(S.settings.service) || 0) * 60;
      const windows = [null, ...stops.map((s) => windowSecs(s.window, now))];
      const res = OPT.solve(M.durations, { service, windows, timeLimitMs: 700 });
      const ids = stops.map((s) => s.id);
      stops.forEach((s) => { if (s.delivery === 'later') { s.delivery = 'pending'; delete s.laterAt; } });
      S.route = {
        ids,
        startPoint: { lat: start.lat, lon: start.lon, label: start.label },
        order: res.order.map((i) => ids[i - 1]),
        dur: M.durations,
        dist: M.distances,
        approx: Boolean(approx),
        method: res.method,
        builtAt: now,
        lateCount: res.lateCount,
        geometry: null,
        stale: null,
      };
      if (!skipUnresolved) setRouteMsg('');
      else setRouteMsg(`<div class="issue warn">В маршрут не вошли адресов: ${unresolved.length}. Уточните их и нажмите «Пересчитать».</div>`);
      save(); render(); fitMap();
      if (!approx) fetchGeometry();
      $('#step-route').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } finally {
      ui.busyRoute = false;
      $('#btn-route').classList.remove('is-busy');
    }
  }

  async function fetchGeometry() {
    const r = S.route;
    if (!r) return;
    const pts = [r.startPoint, ...r.order.map(byId).filter(Boolean)].map((p) => ({ lat: p.lat, lon: p.lon }));
    if (pts.length < 2) return;
    try {
      const g = await api('/api/route', { method: 'POST', body: { points: pts } });
      if (S.route === r) { r.geometry = g.geometry; save(); drawMap(); }
    } catch (e) {
      toast(e.message, { kind: 'warn' });
    }
  }

  function idx(id) { return S.route ? S.route.ids.indexOf(id) + 1 : -1; } // индекс в матрице (0 — старт)

  // Плановые прибытия для оставшейся очереди, от последней выполненной точки.
  function etas() {
    const r = S.route;
    const out = new Map();
    if (!r) return out;
    const q = queue();
    const service = Math.max(0, Number(S.settings.service) || 0) * 60;
    const lastDone = S.stops.filter((s) => s.delivery === 'done' && r.ids.includes(s.id)).sort((a, b) => b.doneAt - a.doneAt)[0];
    let prev = lastDone ? idx(lastDone.id) : 0;
    let t = Date.now();
    let km = 0, drive = 0;
    for (const s of q) {
      const i = idx(s.id);
      if (i <= 0) continue;
      const d = r.dur?.[prev]?.[i];
      const m = r.dist?.[prev]?.[i];
      const legDur = Number.isFinite(d) ? d : NaN;
      t += (legDur || 0) * 1000;
      const w = windowSecs(s.window, Date.now());
      if (w?.from != null && t < Date.now() + w.from * 1000) t = Date.now() + w.from * 1000;
      const late = w?.to != null && t > Date.now() + w.to * 1000;
      out.set(s.id, { arrive: t, legDur, legDist: m, late });
      drive += legDur || 0; km += m || 0;
      t += service * 1000;
      prev = i;
    }
    out.total = { km, drive, finish: q.length ? t - service * 1000 : null };
    return out;
  }

  // ---------- доставка ----------
  function setDelivery(id, delivery) {
    const st = byId(id);
    if (!st) return;
    S.history.push({ id, delivery: st.delivery, laterAt: st.laterAt, doneAt: st.doneAt });
    if (S.history.length > 30) S.history.shift();
    st.delivery = delivery;
    if (delivery === 'done') st.doneAt = Date.now();
    if (delivery === 'later') st.laterAt = Date.now();
    save();
  }

  function undo() {
    const h = S.history.pop();
    if (!h) return;
    const st = byId(h.id);
    if (st) { st.delivery = h.delivery; st.laterAt = h.laterAt; st.doneAt = h.doneAt; }
    save(); render();
    if (st) toast(`Отменено: «${st.text}» снова в очереди.`);
  }

  // «Поехать» к неочередной точке делает её текущей.
  function makeCurrent(id) {
    const r = S.route;
    const q = queue();
    if (!r || !q.length || q[0].id === id) return;
    const st = byId(id);
    if (st?.delivery === 'later') { st.delivery = 'pending'; delete st.laterAt; }
    r.order = r.order.filter((x) => x !== id);
    const pos = r.order.indexOf(q[0].id);
    r.order.splice(pos < 0 ? 0 : pos, 0, id);
    save(); render();
  }

  function navApp() { return NAV.APPS[S.settings.nav] || NAV.APPS.yandexnavi; }
  function navAttrs(st) {
    const app = navApp();
    const href = app.url(st);
    const target = app.type === 'universal' ? ' target="_blank"' : '';
    return `href="${esc(href)}"${target} rel="noopener" data-nav="${esc(st.id)}"`;
  }

  // Если приложение не открылось (не установлено), страница остаётся на экране.
  let navTimer = null;
  function watchNavOpen(st) {
    const app = navApp();
    if (app.type !== 'scheme') return;
    clearTimeout(navTimer);
    const cancel = () => clearTimeout(navTimer);
    document.addEventListener('visibilitychange', cancel, { once: true });
    window.addEventListener('pagehide', cancel, { once: true });
    navTimer = setTimeout(() => {
      if (document.visibilityState !== 'visible') return;
      toast(`Если «${app.name}» не открылся — скорее всего, он не установлен или вы нажали «Отменить» в окне Safari.`, {
        kind: 'warn', timeout: 12000,
        actions: [
          { label: 'Открыть на сайте Яндекс Карт', href: NAV.APPS.yandexweb.url(st) },
          { label: 'Выбрать другой навигатор', onClick: () => $('#settings').showModal() },
        ],
      });
    }, 4500);
  }

  // ---------- карта ----------
  let map = {};
  const mapLayers = { markers: null, line: null, start: null };
  let tileErrors = 0, tileOk = 0;

  // Карта не грузится при открытии сайта — только по кнопке «Показать карту».
  let leafletLoading = null;
  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (leafletLoading) return leafletLoading;
    leafletLoading = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.append(css);
      const js = document.createElement('script');
      js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      js.onload = () => resolve();
      js.onerror = () => { leafletLoading = null; reject(new AppError('map', 'Карта не загрузилась. Проверьте интернет. Маршрут и кнопки «Поехать» работают без карты.')); };
      document.head.append(js);
    });
    return leafletLoading;
  }

  async function showMap() {
    $('#map-wrap').hidden = false;
    document.body.classList.add('map-on');
    $('#btn-map').textContent = 'Скрыть карту';
    try {
      await loadLeaflet();
      if (!map.addLayer) initMap();
      map.invalidateSize?.();
      drawMap(); fitMap();
      return true;
    } catch (e) {
      $('#map-error').hidden = false;
      toast(e.message, { kind: 'warn' });
      return false;
    }
  }
  function hideMap() {
    $('#map-wrap').hidden = true;
    document.body.classList.remove('map-on');
    $('#btn-map').textContent = 'Показать карту';
  }

  function initMap() {
    if (!window.L) { $('#map-error').hidden = false; return; }
    map = L.map('map', { zoomControl: true, attributionControl: true, tap: true }).setView([55.7558, 37.6176], 10);
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
    }).addTo(map);
    tiles.on('tileerror', () => { tileErrors++; if (tileErrors > 6 && tileOk === 0) $('#map-error').hidden = false; });
    tiles.on('tileload', () => { tileOk++; $('#map-error').hidden = true; });
    mapLayers.markers = L.layerGroup().addTo(map);
    map.on('click', onMapClick);
  }

  function pinIcon(label, cls) {
    const size = cls.includes('current') ? 38 : 30;
    return L.divIcon({ className: '', html: `<div class="pin ${cls}"><span>${esc(label)}</span></div>`, iconSize: [size, size], iconAnchor: [size / 2, size], popupAnchor: [0, -size] });
  }

  function popupHtml(st, n, eta) {
    const meta = [];
    if (eta) {
      if (Number.isFinite(eta.legDur)) meta.push(`${fmtDur(eta.legDur)}, ${fmtKm(eta.legDist)} от предыдущей`);
      meta.push(`прибытие ≈ ${fmtClock(eta.arrive)}`);
    }
    return `<strong>${n ? `${n}. ` : ''}${esc(st.text)}</strong>
      ${st.extraOrders?.length ? `<div>+ ${esc(st.extraOrders.join('; '))}</div>` : ''}
      ${st.label ? `<div class="muted">${esc(st.label)}</div>` : ''}
      ${meta.length ? `<div>${esc(meta.join(' · '))}</div>` : ''}
      ${st.lat != null ? `<a class="btn btn-accent" ${navAttrs(st)}>Поехать</a>` : ''}`;
  }

  function drawMap() {
    if (!window.L || !map.addLayer) return;
    mapLayers.markers.clearLayers();
    if (mapLayers.line) { map.removeLayer(mapLayers.line); mapLayers.line = null; }
    const r = S.route;
    const q = queue();
    const pos = new Map();
    if (r) r.order.forEach((id, i) => pos.set(id, i + 1));
    const E = etas();
    for (const st of S.stops) {
      if (st.lat == null) continue;
      let cls = 'unrouted', label = '•';
      if (pos.has(st.id)) {
        label = String(pos.get(st.id));
        cls = st.delivery === 'pending' ? '' : st.delivery;
        if (q[0]?.id === st.id) cls = 'current';
      }
      if (st.delivery === 'done' || st.delivery === 'skipped') { cls = st.delivery; label = '✓'; if (st.delivery === 'skipped') label = '–'; }
      const m = L.marker([st.lat, st.lon], { icon: pinIcon(label, cls), zIndexOffset: cls === 'current' ? 1000 : (cls === 'done' ? -500 : 0) });
      m.bindPopup(() => popupHtml(st, pos.get(st.id), E.get(st.id)), { maxWidth: 280 });
      mapLayers.markers.addLayer(m);
    }
    const sp = S.start || r?.startPoint;
    if (sp) {
      L.marker([sp.lat, sp.lon], { icon: L.divIcon({ className: '', html: '<div class="start-pin"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }), zIndexOffset: 2000 })
        .bindPopup(`<strong>Старт</strong><div>${esc(sp.label || '')}</div>`).addTo(mapLayers.markers);
    }
    if (r) {
      const color = getComputedStyle(document.documentElement).getPropertyValue('--route').trim() || '#2f5bd3';
      if (r.geometry?.coordinates?.length) {
        mapLayers.line = L.geoJSON(r.geometry, { style: { color, weight: 5, opacity: 0.75 } }).addTo(map);
      } else {
        const pts = [r.startPoint, ...r.order.map(byId).filter((s) => s && s.lat != null)].map((p) => [p.lat, p.lon]);
        mapLayers.line = L.polyline(pts, { color, weight: 3, opacity: 0.7, dashArray: '6 8' }).addTo(map);
      }
      mapLayers.line.bringToBack?.();
    }
  }

  function fitMap() {
    if (!window.L || !map.fitBounds) return;
    const pts = S.stops.filter((s) => s.lat != null && s.delivery !== 'done' && s.delivery !== 'skipped').map((s) => [s.lat, s.lon]);
    if (S.start) pts.push([S.start.lat, S.start.lon]);
    if (pts.length === 1) map.setView(pts[0], 15);
    else if (pts.length) map.fitBounds(pts, { padding: [36, 36], maxZoom: 16 });
  }

  function focusCurrent() {
    const c = queue()[0];
    if (c && map.setView) map.setView([c.lat, c.lon], 16);
    else fitMap();
  }

  async function startPick(p) {
    if (!(await showMap())) return;
    pick = p;
    $('#pick-banner').hidden = false;
    $('#pick-text').textContent = p.type === 'start' ? 'Нажмите на карту, где вы сейчас' : `Нажмите на карту: ${byId(p.id)?.text || 'адрес'}`;
    document.querySelector('.map-wrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function endPick() { pick = null; $('#pick-banner').hidden = true; }

  function onMapClick(e) {
    if (!pick) return;
    const p = { lat: e.latlng.lat, lon: e.latlng.lng };
    if (pick.type === 'start') setStart(p, 'map', 'Точка на карте');
    else {
      const st = byId(pick.id);
      if (st) { setPoint(st, { ...p, label: 'Отмечено на карте вручную' }); save(); render(); }
    }
    endPick();
    autoRun();
  }

  // ---------- отрисовка ----------
  let renderPending = false;
  function renderSoon() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => { renderPending = false; render(); });
  }

  const STATUS = {
    pending: ['', 'В очереди'], queued: ['', 'В очереди'], geocoding: ['', 'Ищу на карте…'],
    ok: ['ok', 'Найден'], ambiguous: ['warn', 'Уточните'], notfound: ['warn', 'Не найден'], error: ['err', 'Ошибка поиска'],
  };

  function renderStops() {
    const list = $('#stop-list');
    const pos = new Map();
    if (S.route) S.route.order.forEach((id, i) => pos.set(id, i + 1));
    const items = S.stops.filter((s) => s.delivery !== 'done' && s.delivery !== 'skipped');
    $('#stops-empty').hidden = S.stops.length > 0;
    const okCount = items.filter((s) => s.status === 'ok').length;
    $('#addr-count').textContent = items.length ? `${okCount} из ${items.length} найдено` : '';
    list.innerHTML = items.map((s, i) => {
      const [cls, label] = STATUS[s.status] || STATUS.pending;
      const editing = ui.editing === s.id;
      const wEdit = ui.windowEdit === s.id;
      const chips = [`<span class="chip ${cls}">${label}</span>`];
      if (pos.has(s.id)) chips.push(`<span class="chip">№ ${pos.get(s.id)} в маршруте</span>`);
      else if (S.route) chips.push('<span class="chip warn">Не в маршруте</span>');
      if (s.window.from || s.window.to) chips.push(`<span class="chip time">${s.window.from ? `с ${s.window.from} ` : ''}${s.window.to ? `до ${s.window.to}` : ''}</span>`);
      if (s.extraOrders?.length) chips.push(`<span class="chip">+${s.extraOrders.length} заказ</span>`);
      if (s.kind === 'return') chips.push('<span class="chip ret">Забрать возврат</span>');
      if (s.source) chips.push(`<span class="chip">${esc(s.source)}</span>`);
      let body = '';
      if (s.status === 'ambiguous' && s.candidates.length) {
        body = `<div class="stop-sub">Нашлось несколько мест или нет точного дома. Выберите правильное:</div>
          <div class="cands">${s.candidates.map((c, ci) => `<button class="btn" type="button" data-act="cand" data-id="${s.id}" data-i="${ci}">${esc(c.label)}${c.precision === 'exact' ? '' : ' <span class="chip">примерно</span>'}</button>`).join('')}</div>`;
      } else if (s.status === 'notfound') {
        const yq = encodeURIComponent(P.toQuery(s.parsed, S.settings.city) || s.text);
        body = `<div class="stop-sub">Сервисы поиска не нашли этот адрес. Проверьте текст — частая причина в ошибке распознавания (буква или цифра). Если адрес верный — откройте его в Яндекс Картах и отметьте дом на нашей карте.</div>
          <div class="stop-actions"><a class="btn" href="https://yandex.ru/maps/?text=${yq}" target="_blank" rel="noopener">Найти в Яндекс Картах</a></div>`;
      } else if (s.status === 'error') {
        body = `<div class="stop-sub">${esc(s.error)}</div>`;
      } else if (s.status === 'ok' && s.label) {
        body = `<div class="stop-sub">На карте: ${esc(s.label)}</div>`;
      }
      if (s.parsed && !s.parsed.house && s.status !== 'ok') body += '<div class="stop-sub">В адресе нет номера дома — допишите его.</div>';
      const edit = editing ? `<form class="row" data-form="edit" data-id="${s.id}"><textarea id="edit-${s.id}" aria-label="Адрес">${esc(s.raw || s.text)}</textarea></form>
        <div class="stop-actions"><button class="btn btn-ink" type="button" data-act="edit-save" data-id="${s.id}">Сохранить</button><button class="btn" type="button" data-act="edit-cancel">Отмена</button></div>` : '';
      const win = wEdit ? `<div class="window-edit">
          <label>Не раньше<input type="time" id="wf-${s.id}" value="${esc(s.window.from)}"></label>
          <label>Не позже<input type="time" id="wt-${s.id}" value="${esc(s.window.to)}"></label></div>
        <div class="stop-actions"><button class="btn btn-ink" type="button" data-act="win-save" data-id="${s.id}">Сохранить время</button><button class="btn" type="button" data-act="win-clear" data-id="${s.id}">Без ограничений</button></div>` : '';
      return `<li class="stop ${s.status}" id="stop-${s.id}">
        <div class="stop-top"><div class="stop-body"><div class="stop-text">${esc(s.text)}</div>${P.details(s.parsed) ? `<div class="stop-sub">${esc(P.details(s.parsed))}</div>` : ''}</div></div>
        <div class="chips">${chips.join('')}</div>
        ${body}${edit}${win}
        ${editing || wEdit ? '' : `<div class="stop-actions">
          <button class="btn" type="button" data-act="edit" data-id="${s.id}">Исправить</button>
          <button class="btn" type="button" data-act="win" data-id="${s.id}">Время</button>
          <button class="btn" type="button" data-act="pick-stop" data-id="${s.id}">На карте</button>
          ${s.status === 'error' ? `<button class="btn" type="button" data-act="regeo" data-id="${s.id}">Повторить</button>` : ''}
          <button class="btn" type="button" data-act="del" data-id="${s.id}">Удалить</button></div>`}
      </li>`;
    }).join('');
    if (ui.editing) { const ta = $(`#edit-${ui.editing}`); if (ta && document.activeElement !== ta) ta.focus(); }
  }

  function renderIssues() {
    const out = [];
    for (const [key, g] of duplicateGroups()) {
      const same = g.every((s) => (s.parsed?.flat || '') === (g[0].parsed?.flat || ''));
      out.push(`<div class="issue warn"><div>${same ? '<strong>Повтор адреса:</strong>' : '<strong>Несколько заказов в одном доме:</strong>'} ${g.map((s) => esc(s.text)).join(' · ')}</div>
        <div class="actions"><button class="btn btn-small" type="button" data-act="merge" data-key="${esc(key)}">Объединить в одну остановку</button>
        <button class="btn btn-small" type="button" data-act="dup-ignore" data-key="${esc(key)}">Оставить как есть</button></div></div>`);
    }
    const errs = S.stops.filter((s) => s.status === 'error').length;
    if (errs) out.push(`<div class="issue err"><div>Не удалось найти на карте адресов: ${errs}. Обычно это временная проблема сервиса.</div><div class="actions"><button class="btn btn-small" type="button" data-act="retry-geo">Повторить поиск</button></div></div>`);
    if (ui.ocrLog.length) out.push('<div class="actions" style="display:flex"><button class="btn btn-small btn-ghost" type="button" data-act="ocr-text">Распознанный текст скриншотов</button></div>');
    $('#issues').innerHTML = out.join('');
  }

  function renderStart() {
    const s = S.start;
    $('#start-info').innerHTML = s
      ? `<span class="ok">Старт:</span> ${esc(s.label || 'точка на карте')}${s.at ? ` <span class="muted">· ${fmtClock(s.at)}</span>` : ''}`
      : '<span class="muted">Старт не указан.</span>';
  }

  function renderRouteMsg() { $('#route-msg').innerHTML = ui.routeMsg || ''; }

  function renderRoute() {
    const r = S.route;
    $('#btn-route').textContent = r ? 'Пересчитать маршрут' : 'Построить оптимальный маршрут';
    $('#route-body').hidden = !r;
    if (!r) { document.body.classList.remove('has-drive'); $('#drive').hidden = true; return; }
    const q = queue();
    const E = etas();
    const T = E.total;
    const doneN = S.stops.filter((s) => s.delivery === 'done').length;
    $('#st-count').textContent = `${q.length}${doneN ? ` / ${q.length + doneN}` : ''}`;
    $('#st-km').textContent = fmtKm(T.km);
    $('#st-time').textContent = fmtDur(T.drive);
    $('#st-finish').textContent = T.finish ? fmtClock(T.finish) : '—';

    const notes = [];
    if (r.approx) notes.push('Порядок приблизительный: сервис дорог был недоступен, расстояния посчитаны по прямой. Пересчитайте, когда связь появится.');
    else notes.push('Время по дорогам без учёта пробок (свободное движение). Пробки на каждом отрезке учтёт ваш навигатор.');
    if (r.method === 'exact') notes.push('Порядок оптимален для этих точек.');
    const lateN = q.filter((s) => E.get(s.id)?.late).length;
    if (lateN) notes.push(`Не успеваем к окну доставки у адресов: ${lateN} (отмечены красным).`);
    $('#route-note').textContent = notes.join(' ');

    const unrouted = S.stops.filter((s) => (s.delivery === 'pending' || s.delivery === 'later') && s.status === 'ok' && !r.order.includes(s.id));
    const unresolved = S.stops.filter((s) => (s.delivery === 'pending' || s.delivery === 'later') && s.status !== 'ok' && !r.order.includes(s.id));
    let stale = '';
    if (r.stale || unrouted.length) {
      const why = unrouted.length ? `Новых адресов вне маршрута: ${unrouted.length}.` : (r.stale === 'start' ? 'Изменилась точка старта.' : 'Список адресов изменился.');
      stale = `<li class="stale"><div><strong>${why}</strong> Пересчитайте, чтобы учесть изменения. Выполненные доставки сохранятся.</div>
        <div class="actions" style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-accent" type="button" data-act="recalc">Пересчитать от текущего места</button></div></li>`;
    }
    if (!stale && unresolved.length) {
      stale = `<li class="stale"><div><strong>Не в маршруте, нужно уточнить: ${unresolved.length}.</strong> Выберите вариант или отметьте точку на карте в списке адресов, затем пересчитайте.</div>
        <div class="actions" style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" type="button" data-act="goto-unresolved">Показать</button></div></li>`;
    }
    $('#route-list').innerHTML = stale + q.map((s, i) => {
      const e = E.get(s.id) || {};
      const n = r.order.indexOf(s.id) + 1;
      const cls = [i === 0 ? 'current' : '', s.delivery === 'later' ? 'later' : ''].join(' ');
      const leg = Number.isFinite(e.legDur) ? `<div class="leg num">↓ ${fmtDur(e.legDur)} · ${fmtKm(e.legDist)}</div>` : '';
      const win = s.window.from || s.window.to ? `<span class="chip time">${s.window.from ? `с ${s.window.from} ` : ''}${s.window.to ? `до ${s.window.to}` : ''}</span>` : '';
      return `<li>${leg}<div class="rstop ${cls}">
        <div class="rnum">${n}</div>
        <div class="rbody">
          <div class="rtext">${esc(s.text)}</div>
          ${P.details(s.parsed) ? `<div class="stop-sub">${esc(P.details(s.parsed))}</div>` : ''}
          ${s.kind === 'return' ? '<div><span class="chip ret">Забрать возврат</span></div>' : ''}
          ${s.extraOrders?.length ? `<div class="stop-sub">+ ${esc(s.extraOrders.join('; '))}</div>` : ''}
          <div class="rmeta num">${e.arrive ? `<span class="${e.late ? 'late' : ''}">≈ ${fmtClock(e.arrive)}${e.late ? ' — опоздание' : ''}</span>` : ''}${win}${s.delivery === 'later' ? '<span class="chip warn">Позже</span>' : ''}</div>
          <div class="ractions">
            <a class="btn btn-accent" ${navAttrs(s)}>Поехать</a>
            <button class="btn" type="button" data-act="done" data-id="${s.id}">Выполнено</button>
            <button class="btn" type="button" data-act="map-show" data-id="${s.id}" aria-label="Показать на карте">Карта</button>
          </div>
        </div></div></li>`;
    }).join('');
    if (!q.length) {
      $('#route-list').innerHTML += '<li class="issue warn" style="margin-top:8px">Все доставки из маршрута отмечены. Загрузите новые скриншоты, чтобы начать следующий рейс.</li>';
    }

    const done = S.stops.filter((s) => s.delivery === 'done' || s.delivery === 'skipped').sort((a, b) => (a.doneAt || a.addedAt) - (b.doneAt || b.addedAt));
    $('#done-box').hidden = !done.length;
    $('#done-summary').textContent = `Выполнено: ${done.filter((s) => s.delivery === 'done').length}${done.some((s) => s.delivery === 'skipped') ? `, пропущено: ${done.filter((s) => s.delivery === 'skipped').length}` : ''}`;
    $('#done-list').innerHTML = done.map((s) => `<li><div class="rstop ${s.delivery}"><div class="rnum">${s.delivery === 'done' ? '✓' : '–'}</div>
      <div class="rbody"><div class="rtext">${esc(s.text)}</div><div class="rmeta">${s.delivery === 'done' ? `доставлено в ${fmtClock(s.doneAt)}` : 'пропущено'}</div>
      <div class="ractions"><button class="btn btn-small" type="button" data-act="restore" data-id="${s.id}">Вернуть в маршрут</button></div></div></div></li>`).join('');

    renderDrive(q, E);
  }

  function renderDrive(q, E) {
    const cur = q[0];
    const show = Boolean(cur);
    $('#drive').hidden = !show;
    document.body.classList.toggle('has-drive', show);
    if (!show) return;
    const n = S.route.order.indexOf(cur.id) + 1;
    const e = E.get(cur.id) || {};
    $('#drive-num').textContent = n;
    $('#drive-text').textContent = cur.text + (cur.extraOrders?.length ? ` (+${cur.extraOrders.length})` : '');
    const det = [cur.kind === 'return' ? 'Забрать возврат' : '', P.details(cur.parsed)].filter(Boolean).join(' · ');
    $('#drive-details').textContent = det;
    $('#drive-details').hidden = !det;
    const meta = [];
    if (Number.isFinite(e.legDur)) meta.push(`${fmtDur(e.legDur)} · ${fmtKm(e.legDist)}`);
    if (e.arrive) meta.push(`прибытие ≈ ${fmtClock(e.arrive)}`);
    meta.push(`осталось ${q.length}`);
    $('#drive-meta').textContent = meta.join(' · ');
    const app = navApp();
    const go = $('#drive-go');
    go.href = app.url(cur);
    go.dataset.nav = cur.id;
    if (app.type === 'universal') go.target = '_blank'; else go.removeAttribute('target');
    go.textContent = 'Поехать';
    meta.push(app.name);
    $('#drive-meta').textContent = meta.join(' · ');
    const next = q[1];
    const nb = $('#drive-next');
    nb.dataset.cur = cur.id;
    if (next) {
      nb.href = app.url(next);
      nb.dataset.nav = next.id;
      if (app.type === 'universal') nb.target = '_blank'; else nb.removeAttribute('target');
      $('#drive-next-label').textContent = `Следующий адрес → № ${S.route.order.indexOf(next.id) + 1}`;
      $('#drive-next-sub').textContent = 'текущий отметится выполненным';
    } else {
      nb.removeAttribute('href'); nb.removeAttribute('target'); delete nb.dataset.nav;
      $('#drive-next-label').textContent = 'Завершить последний адрес';
      $('#drive-next-sub').textContent = 'отметит его выполненным';
    }
    $('#drive-undo').disabled = !S.history.length;
  }

  function renderServices() {
    const el = $('#services');
    if (!el) return;
    if (!health) { el.textContent = 'Проверяю сервер…'; return; }
    if (health.error) { el.innerHTML = `<strong>Сервер недоступен.</strong> ${esc(health.error)}`; return; }
    const directNote = health.direct ? '<div><strong>Режим без сервера:</strong> телефон обращается к сервисам сам. Ключ 2ГИС введите ниже — он хранится только на этом устройстве.</div>' : '';
    const GN = { yandex: 'Яндекс', '2gis': '2ГИС', nominatim: 'OpenStreetMap' };
    const gl = (health.geocoders || [health.geocoder]).map((g) => GN[g] || g).join(' → ');
    el.innerHTML = `${directNote}<div>Поиск адресов: <strong>${esc(gl)}</strong>${(health.geocoders || []).length < 2 ? (health.direct ? ' — для надёжного поиска введите ключ 2ГИС ниже' : ' — для надёжного поиска подключите ключ Яндекса или 2ГИС на сервере') : ''}</div>
      <div>Расчёт дорог: <strong>OSRM${health.routerHost === 'public-demo' ? ' (общедоступный сервер)' : ''}</strong>, без учёта пробок</div>
      <div>Распознавание: на телефоне (Tesseract)</div>`;
  }

  function renderSettings() {
    $('#nav-options').innerHTML = NAV.list().map((a) => `<label class="nav-opt"><input type="radio" name="nav" value="${a.id}" ${S.settings.nav === a.id ? 'checked' : ''}>
      <span><strong>${esc(a.name)}</strong><small>${esc(a.hint || '')}</small></span></label>`).join('');
    $('#set-city').value = S.settings.city || '';
    $('#set-service').value = S.settings.service;
    $('#set-auto').checked = S.settings.auto !== false;
    $('#set-key').value = S.settings.appKey || '';
    $('#set-dgis').value = S.settings.dgisKey || '';
    renderServices();
  }

  function render() {
    renderStops();
    renderIssues();
    renderStart();
    renderRouteMsg();
    renderRoute();
    drawMap();
  }

  // ---------- события ----------
  function bind() {
    $('#file-input').addEventListener('change', (e) => handleFiles(e.target.files));
    $('#manual-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = $('#manual-input').value.trim();
      if (!v) return;
      const added = addStops([{ text: v }], { source: 'Вручную', manual: true });
      if (added.length) { $('#manual-input').value = ''; autoRun(); }
    });
    $('#btn-gps').addEventListener('click', onGps);
    $('#start-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = $('#start-input').value.trim();
      if (v) onStartAddress(v);
    });
    $('#btn-pick-start').addEventListener('click', () => startPick({ type: 'start' }));
    $('#btn-map').addEventListener('click', () => ($('#map-wrap').hidden ? showMap() : hideMap()));
    $('#pick-cancel').addEventListener('click', endPick);
    $('#btn-route').addEventListener('click', () => buildRoute({ recalc: Boolean(S.route) && S.stops.some((s) => s.delivery === 'done') }));
    $('#map-fit').addEventListener('click', fitMap);
    $('#map-current').addEventListener('click', focusCurrent);

    $('#drive-done').addEventListener('click', () => {
      const cur = queue()[0];
      if (!cur) return;
      setDelivery(cur.id, 'done');
      render();
      const nxt = queue()[0];
      toast(nxt ? `Готово. Следующий: ${nxt.text}` : 'Все доставки выполнены!', { timeout: 3500 });
    });
    $('#drive-skip').addEventListener('click', () => {
      const cur = queue()[0];
      if (!cur) return;
      setDelivery(cur.id, 'skipped'); render();
      toast(`Пропущен: ${cur.text}`, { actions: [{ label: 'Отменить', onClick: undo }] });
    });
    $('#drive-later').addEventListener('click', () => {
      const cur = queue()[0];
      if (!cur) return;
      setDelivery(cur.id, 'later'); render();
      toast('Адрес перенесён в конец очереди.', { actions: [{ label: 'Отменить', onClick: undo }] });
    });
    $('#drive-undo').addEventListener('click', undo);

    // «Следующий адрес»: отмечаем текущий выполненным и открываем навигатор к следующему.
    $('#drive-next').addEventListener('click', (e) => {
      const curId = e.currentTarget.dataset.cur;
      const hasNext = e.currentTarget.hasAttribute('href');
      if (!hasNext) e.preventDefault();
      setTimeout(() => {
        if (curId && byId(curId)?.delivery !== 'done') setDelivery(curId, 'done');
        render();
        if (!hasNext) toast('Все доставки выполнены!');
      }, 0);
    });

    document.addEventListener('click', (e) => {
      const navLink = e.target.closest('[data-nav]');
      if (navLink && navLink.id !== 'drive-next') {
        const st = byId(navLink.dataset.nav);
        if (st) { watchNavOpen(st); setTimeout(() => makeCurrent(st.id), 0); }
      } else if (navLink) {
        const st = byId(navLink.dataset.nav);
        if (st) watchNavOpen(st);
      }
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const id = b.dataset.id;
      const st = id ? byId(id) : null;
      switch (b.dataset.act) {
        case 'edit': ui.editing = id; ui.windowEdit = null; render(); break;
        case 'edit-cancel': ui.editing = null; render(); break;
        case 'edit-save': { const v = $(`#edit-${id}`)?.value || ''; ui.editing = null; updateStopText(id, v); render(); autoRun(); break; }
        case 'win': ui.windowEdit = id; ui.editing = null; render(); break;
        case 'win-save': if (st) { st.window = { from: $(`#wf-${id}`).value, to: $(`#wt-${id}`).value }; if (S.route?.order.includes(id)) S.route.stale = 'edited'; save(); } ui.windowEdit = null; render(); break;
        case 'win-clear': if (st) { st.window = { from: '', to: '' }; if (S.route?.order.includes(id)) S.route.stale = 'edited'; save(); } ui.windowEdit = null; render(); break;
        case 'del': removeStop(id); break;
        case 'cand': if (st) { setPoint(st, st.candidates[Number(b.dataset.i)]); save(); render(); autoRun(); } break;
        case 'pick-stop': startPick({ type: 'stop', id }); break;
        case 'regeo': if (st) queueGeocode(st); break;
        case 'retry-geo': retryFailed(); break;
        case 'merge': {
          const g = duplicateGroups().find(([k]) => k === b.dataset.key);
          if (g) g[1].slice(1).forEach((o) => mergeInto(g[1][0].id, o.id));
          break;
        }
        case 'dup-ignore': S.ignoredDupes.push(b.dataset.key); save(); render(); break;
        case 'ocr-text': showOcrText(); break;
        case 'goto-unresolved': {
          const u = activeStops().find((s) => s.status !== 'ok');
          if (u) $(`#stop-${u.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          break;
        }
        case 'build-skip': buildRoute({ skipUnresolved: true, recalc: Boolean(S.route) }); break;
        case 'build-retry': buildRoute({ recalc: Boolean(S.route) }); break;
        case 'build-approx': buildRoute({ approx: true, skipUnresolved: true }); break;
        case 'recalc': buildRoute({ recalc: true }); break;
        case 'done': if (st) { setDelivery(id, 'done'); render(); } break;
        case 'restore': if (st) { setDelivery(id, 'pending'); if (S.route && !S.route.order.includes(id)) { S.route.order.push(id); S.route.stale = 'added'; } save(); render(); } break;
        case 'map-show': if (st && map.setView) { map.setView([st.lat, st.lon], 16); document.querySelector('.map-wrap').scrollIntoView({ behavior: 'smooth', block: 'center' }); } break;
        default: break;
      }
    });

    $('#btn-settings').addEventListener('click', () => { renderSettings(); $('#settings').showModal(); });
    $('#settings').addEventListener('change', (e) => {
      if (e.target.name === 'nav') S.settings.nav = e.target.value;
      if (e.target.id === 'set-auto') { S.settings.auto = e.target.checked; renderAutoHint(); }
      if (e.target.id === 'set-service') S.settings.service = Math.min(60, Math.max(0, Number(e.target.value) || 0));
      if (e.target.id === 'set-city') S.settings.city = e.target.value.trim() || 'Москва';
      if (e.target.id === 'set-key') { S.settings.appKey = e.target.value.trim(); mode = null; modeReady = null; loadHealth(); }
      if (e.target.id === 'set-dgis') { S.settings.dgisKey = e.target.value.trim(); save(); loadHealth(); retryFailed(); S.stops.filter((s) => s.status === 'notfound' || s.status === 'ambiguous').forEach(queueGeocode); autoRun(); }
      save(); render();
    });
    $('#btn-diag').addEventListener('click', async () => {
      const box = $('#diag');
      box.hidden = false;
      box.textContent = 'Проверяю каждый сервис на адресе «Москва, Каширское шоссе, 8 к3»…';
      $('#btn-diag').classList.add('is-busy');
      try {
        const r = await api('/api/diag', { timeout: 60000 });
        box.innerHTML = r.providers.map((p) => `<div>${p.ok ? '✅' : '⚠️'} <strong>${esc(p.name)}</strong>: ${p.ok
          ? `нашёл дом — ${esc(p.label)} (${(p.ms / 1000).toFixed(1)} с)`
          : esc(p.error || (p.found ? 'нашёл только улицу или район' : 'ничего не нашёл'))}</div>`).join('')
          + (r.providers.some((p) => p.id === '2gis') ? '' : '<div>2ГИС не подключён: на сервере не задан DGIS_KEY.</div>');
      } catch (e) { box.textContent = e.message; }
      finally { $('#btn-diag').classList.remove('is-busy'); }
    });
    $('#settings').addEventListener('close', () => { $('#btn-reset-confirm').hidden = true; });
    $('#btn-reset').addEventListener('click', () => { $('#btn-reset-confirm').hidden = false; });
    $('#btn-reset-confirm').addEventListener('click', () => {
      const keep = S.settings;
      S = defaults(); S.settings = keep; save();
      ui.ocrLog = []; ui.routeMsg = null;
      $('#settings').close(); render(); fitMap();
      toast('Список адресов очищен.');
    });

    const net = () => {
      const off = !navigator.onLine;
      $('#offline-banner').hidden = !off;
      $('#net').hidden = !off;
      if (!off && S.stops.some((s) => s.status === 'error')) retryFailed();
    };
    window.addEventListener('online', net);
    window.addEventListener('offline', net);
    net();

    document.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (files.length) handleFiles(files);
    });
    setInterval(() => { if (S.route && document.visibilityState === 'visible') renderRoute(); }, 60000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') render(); });
  }

  // ---------- старт ----------
  bind();
  // незавершённые поиски после перезагрузки страницы
  // ненайденные адреса из прошлой сессии: разобрать заново (разбор мог улучшиться) и искать снова
  for (const st of S.stops) {
    if (['error', 'notfound'].includes(st.status) && st.raw) {
      st.parsed = P.parse(st.raw);
      st.text = P.format(st.parsed) || st.text;
      st.status = 'pending';
    }
  }
  S.stops.filter((s) => ['queued', 'geocoding', 'pending'].includes(s.status)).forEach(queueGeocode);
  if (S.stops.some((s) => s.status !== 'ok')) autoRun();
  render();
  renderAutoHint();
  loadHealth();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  window.__app = { get state() { return S; }, buildRoute, addStops, render };
})();
