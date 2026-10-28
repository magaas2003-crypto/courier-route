// Ссылки для открытия точки в навигационных приложениях на iPhone.
// Используются только официальные схемы URL / универсальные ссылки приложений.
(function (root) {
  'use strict';
  const f = (x) => Number(x).toFixed(6);

  const APPS = {
    yandexnavi: {
      name: 'Яндекс Навигатор',
      type: 'scheme',
      url: (p) => `yandexnavi://build_route_on_map?lat_to=${f(p.lat)}&lon_to=${f(p.lon)}`,
      hint: 'Safari спросит «Открыть в приложении „Навигатор“?» — нажмите «Открыть». Маршрут строится от вашего текущего места.',
      fallback: (p) => APPS.yandexweb.url(p),
    },
    yandexmaps: {
      name: 'Яндекс Карты',
      type: 'scheme',
      url: (p) => `yandexmaps://maps.yandex.ru/?rtext=~${f(p.lat)},${f(p.lon)}&rtt=auto`,
      multi: (pts) => `yandexmaps://maps.yandex.ru/?rtext=~${pts.map((p) => `${f(p.lat)},${f(p.lon)}`).join('~')}&rtt=auto`,
      hint: 'Safari спросит «Открыть в „Яндекс Картах“?» — нажмите «Открыть». Умеет вести через несколько точек подряд.',
      fallback: (p) => APPS.yandexweb.url(p),
    },
    apple: {
      name: 'Apple Карты',
      type: 'universal',
      url: (p) => `https://maps.apple.com/?daddr=${f(p.lat)},${f(p.lon)}&dirflg=d`,
      hint: 'Открывается сразу, приложение есть на каждом iPhone.',
    },
    dgis: {
      name: '2ГИС',
      type: 'scheme',
      url: (p) => `dgis://2gis.ru/routeSearch/rsType/car/to/${f(p.lon)},${f(p.lat)}`,
      hint: 'Safari спросит разрешение открыть 2ГИС — нажмите «Открыть».',
      fallback: (p) => APPS.yandexweb.url(p),
    },
    google: {
      name: 'Google Карты',
      type: 'universal',
      url: (p) => `https://www.google.com/maps/dir/?api=1&destination=${f(p.lat)},${f(p.lon)}&travelmode=driving`,
      hint: 'Если приложение Google Карты не установлено, откроется сайт.',
    },
    waze: {
      name: 'Waze',
      type: 'universal',
      url: (p) => `https://waze.com/ul?ll=${f(p.lat)},${f(p.lon)}&navigate=yes`,
      hint: 'Если Waze не установлен, откроется страница Waze.',
    },
    yandexweb: {
      name: 'Яндекс Карты (сайт)',
      type: 'universal',
      hidden: true,
      url: (p) => `https://yandex.ru/maps/?rtext=~${f(p.lat)},${f(p.lon)}&rtt=auto`,
    },
  };

  const api = { APPS, list: () => Object.entries(APPS).filter(([, a]) => !a.hidden).map(([id, a]) => ({ id, ...a })) };
  root.NavLinks = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
