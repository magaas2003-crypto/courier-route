// Оптимизация порядка объезда: открытый маршрут (без возврата) из точки старта
// по асимметричной матрице времени в пути по дорогам.
//   • до 12 точек без временных окон — точное решение (Хелд — Карп);
//   • иначе — жадное построение + локальный поиск (2-opt, перенос отрезков)
//     с перезапусками в пределах лимита времени.
// Временные окна учитываются как ожидание (если приехали раньше «с») и
// большой штраф за опоздание (если позже «до»).
(function (root) {
  'use strict';
  const BIG = 1e7;

  function sanitize(D) {
    return D.map((row, i) => row.map((v, j) => (i === j ? 0 : (Number.isFinite(v) && v >= 0 ? v : BIG))));
  }

  function evaluate(order, D, o) {
    const service = o.service || 0;
    const W = o.windows || [];
    let t = 0, prev = 0, travel = 0, late = 0, wait = 0, lateCount = 0;
    const arrivals = [];
    for (const i of order) {
      const d = D[prev][i];
      travel += d;
      t += d;
      const w = W[i];
      if (w) {
        if (w.from != null && t < w.from) { wait += w.from - t; t = w.from; }
        if (w.to != null && t > w.to) { late += t - w.to; lateCount++; }
      }
      arrivals.push(t);
      t += service;
      prev = i;
    }
    const cost = travel + wait * (o.waitWeight ?? 1) + late * (o.lateWeight ?? 50) + lateCount * 600;
    return { cost, travel, late, wait, lateCount, arrivals, end: t };
  }

  function heldKarp(D, n) {
    const N = 1 << n;
    const dp = new Float64Array(N * n).fill(Infinity);
    const par = new Int8Array(N * n).fill(-1);
    for (let j = 0; j < n; j++) dp[(1 << j) * n + j] = D[0][j + 1];
    for (let m = 1; m < N; m++) {
      for (let j = 0; j < n; j++) {
        const v = dp[m * n + j];
        if (v === Infinity || !(m & (1 << j))) continue;
        for (let k = 0; k < n; k++) {
          if (m & (1 << k)) continue;
          const nm = m | (1 << k);
          const nv = v + D[j + 1][k + 1];
          if (nv < dp[nm * n + k]) { dp[nm * n + k] = nv; par[nm * n + k] = j; }
        }
      }
    }
    const full = N - 1;
    let best = 0;
    for (let j = 1; j < n; j++) if (dp[full * n + j] < dp[full * n + best]) best = j;
    const order = [];
    let m = full, j = best;
    while (j !== -1) {
      order.push(j + 1);
      const pj = par[m * n + j];
      m ^= 1 << j;
      j = pj;
    }
    return order.reverse();
  }

  function nearestNeighbor(D, n, o) {
    const left = new Set(Array.from({ length: n }, (_, i) => i + 1));
    const order = [];
    let prev = 0;
    while (left.size) {
      let best = null, bc = Infinity;
      for (const k of left) {
        const c = evaluate(order.concat(k), D, o).cost;
        if (c < bc) { bc = c; best = k; }
      }
      order.push(best);
      left.delete(best);
      prev = best;
    }
    return order;
  }

  function byDeadline(D, n, o) {
    const W = o.windows || [];
    const ids = Array.from({ length: n }, (_, i) => i + 1);
    return ids.sort((a, b) => ((W[a]?.to ?? Infinity) - (W[b]?.to ?? Infinity)) || (D[0][a] - D[0][b]));
  }

  function localSearch(order, D, o, deadline) {
    let best = order.slice();
    let bc = evaluate(best, D, o).cost;
    const n = best.length;
    let improved = true;
    while (improved && Date.now() < deadline) {
      improved = false;
      // перенос отрезка длиной 1–3 на другую позицию (в т.ч. с разворотом)
      for (let len = 1; len <= 3 && !improved; len++) {
        for (let i = 0; i + len <= n && !improved; i++) {
          const seg = best.slice(i, i + len);
          const rest = best.slice(0, i).concat(best.slice(i + len));
          for (let j = 0; j <= rest.length; j++) {
            if (j === i) continue;
            for (const s of len > 1 ? [seg, seg.slice().reverse()] : [seg]) {
              const cand = rest.slice(0, j).concat(s, rest.slice(j));
              const c = evaluate(cand, D, o).cost;
              if (c < bc - 1e-6) { best = cand; bc = c; improved = true; break; }
            }
            if (improved) break;
          }
        }
      }
      if (improved) continue;
      // 2-opt: разворот участка
      for (let i = 0; i < n - 1 && !improved; i++) {
        for (let j = i + 1; j < n; j++) {
          const cand = best.slice(0, i).concat(best.slice(i, j + 1).reverse(), best.slice(j + 1));
          const c = evaluate(cand, D, o).cost;
          if (c < bc - 1e-6) { best = cand; bc = c; improved = true; break; }
        }
      }
    }
    return { order: best, cost: bc };
  }

  function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  function perturb(order, rand) {
    const n = order.length;
    if (n < 8) {
      const a = order.slice();
      const i = Math.floor(rand() * n), j = Math.floor(rand() * n);
      [a[i], a[j]] = [a[j], a[i]];
      return a;
    }
    const cuts = [0, 0, 0].map(() => 1 + Math.floor(rand() * (n - 1))).sort((x, y) => x - y);
    const [p, q, r] = cuts;
    return order.slice(0, p).concat(order.slice(q, r), order.slice(p, q), order.slice(r));
  }

  function solve(rawD, opts) {
    const o = Object.assign({ service: 0, windows: [], timeLimitMs: 500 }, opts || {});
    const D = sanitize(rawD);
    const n = D.length - 1;
    if (n <= 0) return { order: [], method: 'empty', ...evaluate([], D, o) };
    const hasWindows = (o.windows || []).some((w) => w && (w.from != null || w.to != null));
    if (!hasWindows && n <= 12) {
      const order = n === 1 ? [1] : heldKarp(D, n);
      return { order, method: 'exact', ...evaluate(order, D, o) };
    }
    const deadline = Date.now() + o.timeLimitMs;
    let best = null;
    for (const start of [nearestNeighbor(D, n, o), byDeadline(D, n, o)]) {
      const r = localSearch(start, D, o, deadline);
      if (!best || r.cost < best.cost) best = r;
    }
    const rand = rng(12345);
    let iter = 0;
    while (Date.now() < deadline && n > 3) {
      const r = localSearch(perturb(best.order, rand), D, o, deadline);
      if (r.cost < best.cost - 1e-6) best = r;
      iter++;
    }
    return { order: best.order, method: 'heuristic', iterations: iter, ...evaluate(best.order, D, o) };
  }

  // Запасной вариант, когда сервис дорог недоступен: прямая × 1,4, 22 км/ч.
  function haversine(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function approxMatrix(points) {
    const distances = points.map((a) => points.map((b) => haversine(a, b) * 1.4));
    const durations = distances.map((row) => row.map((d) => d / (22 / 3.6)));
    return { durations, distances };
  }

  const api = { solve, evaluate, heldKarp, haversine, approxMatrix };
  root.RouteOptimizer = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
