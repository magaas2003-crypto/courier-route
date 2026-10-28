// Разбор российских адресов из текста, распознанного на скриншотах.
// Работает и в браузере (window.AddressParser), и в тестах Node.
(function (root) {
  'use strict';

  const LAT2CYR = {
    a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у', k: 'к', m: 'м', t: 'т', b: 'в', h: 'н', r: 'г', n: 'п', u: 'и',
    A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У',
  };

  // OCR часто путает кириллицу с похожей латиницей: «yл.» → «ул.», «5k2» → «5к2».
  function fixHomoglyphs(s) {
    return s.replace(/[A-Za-zА-Яа-яЁё0-9-]+/g, (w) => {
      const hasLat = /[A-Za-z]/.test(w);
      if (!hasLat) return w;
      const hasCyr = /[А-Яа-яЁё]/.test(w);
      const hasDigit = /\d/.test(w);
      const onlyMapped = [...w.replace(/[^A-Za-z]/g, '')].every((ch) => LAT2CYR[ch]);
      if ((hasCyr || hasDigit) && onlyMapped) return w.replace(/[A-Za-z]/g, (ch) => LAT2CYR[ch]);
      return w;
    });
  }

  // В номерах OCR путает цифры с буквами: «8кЗ» → «8к3», «1О» → «10», «Зб» → «3б».
  function fixDigits(s) {
    return s.replace(/(^|[\s,.])((?:корпус|корп|дом|стр|д|к|с)(?:\.\s*|\s+)?)?([0-9ЗзОо][0-9ЗзОоа-яё/]*)/gi, (m, pre, label, w) => {
      if (!/\d/.test(w) && !label) return m;
      if (!/^[0-9ЗзОо]/.test(w)) return m;
      const fixed = w
        .replace(/[Зз](?=[\dкс/]|$)/g, '3').replace(/(?<=[\dкс/])[Зз]/g, '3')
        .replace(/[Оо](?=\d)/g, '0').replace(/(?<=\d)[Оо](?=\d|[кс]|\/|$)/g, '0').replace(/(?<=[кс])[Оо]$/g, '0');
      return pre + (label || '') + fixed;
    });
  }

  function normalize(s) {
    return fixDigits(fixHomoglyphs(String(s || '')))
      .replace(/[«»"“”]/g, '')
      .replace(/[‚]/g, ',')
      .replace(/\s*,\s*/g, ', ')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s,.;:•·*\-—–|>›»°©®]+|[\s;:•·*|>›»]+$/g, '')
      .trim();
  }

  const STREET_TYPES = [
    [/^(улица|ул)\.?$/i, 'улица'],
    [/^(проспект|пр-т|просп|пр-кт)\.?$/i, 'проспект'],
    [/^(шоссе|ш)\.?$/i, 'шоссе'],
    [/^(переулок|пер)\.?$/i, 'переулок'],
    [/^(бульвар|б-р|бул)\.?$/i, 'бульвар'],
    [/^(набережная|наб)\.?$/i, 'набережная'],
    [/^(проезд|пр-д)\.?$/i, 'проезд'],
    [/^(площадь|пл)\.?$/i, 'площадь'],
    [/^(аллея)\.?$/i, 'аллея'],
    [/^(тупик|туп)\.?$/i, 'тупик'],
    [/^(линия)\.?$/i, 'линия'],
    [/^(микрорайон|мкр|мкрн|мкр-н)\.?$/i, 'микрорайон'],
    [/^(квартал|кв-л)\.?$/i, 'квартал'],
    [/^(тракт|просека|спуск|территория|тер)\.?$/i, null],
  ];
  const STREET_WORDS = 'улица|ул|проспект|пр-т|пр-кт|просп|шоссе|ш|переулок|пер|бульвар|б-р|бул|набережная|наб|проезд|пр-д|площадь|пл|аллея|тупик|туп|линия|микрорайон|мкр|мкрн|мкр-н|квартал|кв-л|тракт|просека|спуск|территория';
  const STREET_RE = new RegExp(`(^|[\\s,.(])(${STREET_WORDS})(?=[\\s.,)]|$)`, 'i');
  const LOCALITY_RE = /^(пос\.?|посёлок|поселок|п\.|дер\.?|деревня|д\.\s*[А-ЯЁ][а-яё]|с\.\s*[А-ЯЁ]|село|снт|днп|кп|рп|пгт|город|г\.)/;
  const REGION_RE = /(обл\.?|область|р-н|район|округ|г\.\s*о\.|городской округ|ао\b)/i;
  const HOUSE_RE = /^(?:(?:д|дом|вл|влад|владение)\.?\s*№?\s*)?(\d{1,4}[а-я]?(?:\/\d{1,4}[а-я]?)?)(?:\s*,?\s*(?:к|корп|корпус)\.?\s*(\d{1,3}[а-я]?))?(?:\s*,?\s*(?:с|стр|строение)\.?\s*(\d{1,3}[а-я]?))?$/i;

  function emptyParsed() {
    return { region: '', city: '', locality: '', street: '', house: '', korpus: '', stroenie: '', flat: '', entrance: '', floor: '', intercom: '', extra: [] };
  }

  function setHouse(out, m) {
    out.house = m[1].toLowerCase();
    if (m[2]) out.korpus = m[2].toLowerCase();
    if (m[3]) out.stroenie = m[3].toLowerCase();
  }

  function parse(raw) {
    const out = emptyParsed();
    let s = normalize(raw);
    const take = (re, field) => {
      s = s.replace(re, (m, v) => { if (!out[field]) out[field] = v; return ', '; });
    };
    take(/(?:^|[\s,])(?:кв\.?|квартира|оф\.?|офис)\s*№?\s*(\d{1,5}[а-я]?)(?=[\s,.]|$)/i, 'flat');
    take(/(?:^|[\s,])(?:под\.?|подъезд|п-д)\s*№?\s*(\d{1,2})(?=[\s,.]|$)/i, 'entrance');
    take(/(?:^|[\s,])(?:эт\.?|этаж)\s*(-?\d{1,3})(?=[\s,.]|$)/i, 'floor');
    take(/(?:^|[\s,])(?:дмф|домофон|код)\.?\s*:?\s*([^\s,]+)/i, 'intercom');
    s = s.replace(/(?:^|[\s,])\d{6}(?=[\s,]|$)/, ', ');
    s = s.replace(/(?:^|[\s,])(россия|рф)(?=[\s,]|$)/i, ', ');

    const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
    // Всё, что стоит до улицы и не похоже на дом/район, — город или посёлок:
    // «Бронницы, микрорайон Марьинский, д. 2».
    const streetAt = parts.findIndex((x) => STREET_RE.test(x));
    for (let pi = 0; pi < parts.length; pi++) {
      const p = parts[pi];
      let m;
      if (/^(г\.?|город)\s*москва$/i.test(p) || /^москва$/i.test(p)) { out.city = 'Москва'; continue; }
      if (/^(г\.?|город)\s+\S/i.test(p) && !STREET_RE.test(p)) { out.city = p.replace(/^(г\.?|город)\s*/i, ''); continue; }
      if ((m = p.match(HOUSE_RE))) { if (!out.house) setHouse(out, m); else out.extra.push(p); continue; }
      if ((m = p.match(/^(?:корп\.?|корпус|к\.?)\s*(\d{1,4}[а-я]?)$/i))) { out.korpus = m[1]; continue; }
      if (/^(г\.\s*)?зеленоград$/i.test(p)) { out.city = 'Зеленоград'; continue; }
      if ((m = p.match(/^(?:стр\.?|строение|с\.?)\s*(\d{1,3}[а-я]?)$/i))) { out.stroenie = m[1]; continue; }
      if (REGION_RE.test(p) && !STREET_RE.test(p)) { out.region = out.region ? `${out.region}, ${p}` : p; continue; }
      if (LOCALITY_RE.test(p) && !STREET_RE.test(p)) { out.locality = p; continue; }
      if (pi < streetAt && !/\d/.test(p) && /[а-яё]{3,}/i.test(p)) {
        if (!out.city) out.city = p; else out.locality = out.locality || p;
        continue;
      }
      if (STREET_RE.test(p) || (!out.street && /[а-яё]{3,}/i.test(p))) {
        const tail = p.match(/^(.*?[а-яёa-z.)])\s+((?:д\.?|дом|вл\.?)?\s*\d{1,4}[а-я]?(?:\/\d{1,4}[а-я]?)?(?:\s*(?:к|корп\.?|корпус)\.?\s*\d{1,3}[а-я]?)?(?:\s*(?:с|стр\.?|строение)\.?\s*\d{1,3}[а-я]?)?)$/i);
        if (tail && !out.house && (m = tail[2].trim().match(HOUSE_RE)) && (STREET_RE.test(tail[1]) || /[а-яё]{3,}/i.test(tail[1]))) {
          if (!out.street) out.street = tail[1].trim(); else out.extra.push(tail[1].trim());
          setHouse(out, m);
        } else if (!out.street) out.street = p;
        else out.extra.push(p);
        continue;
      }
      out.extra.push(p);
    }
    out.street = canonStreet(out.street);
    return out;
  }

  // «ул. Профсоюзная» / «Профсоюзная ул» → «улица Профсоюзная»
  function canonStreet(street) {
    if (!street) return '';
    const words = street.replace(/\.(?=\S)/g, '. ').split(/\s+/).filter(Boolean);
    let type = null;
    const rest = [];
    for (const w of words) {
      let matched = false;
      if (!type) {
        for (const [re, canon] of STREET_TYPES) {
          if (re.test(w)) { type = canon || w.replace(/\.$/, ''); matched = true; break; }
        }
      }
      if (!matched) rest.push(w);
    }
    const name = rest.join(' ').replace(/\s+\./g, '.').trim();
    if (!type) return name;
    return name ? `${type} ${name}` : type;
  }

  function houseString(p) {
    if (p && !p.house && p.korpus) return `корпус ${p.korpus}`; // Зеленоград: «корпус 1105»
    if (!p || !p.house) return '';
    return p.house + (p.korpus ? ` к${p.korpus}` : '') + (p.stroenie ? ` с${p.stroenie}` : '');
  }

  function format(p) {
    if (!p) return '';
    const parts = [];
    // «Новомосковский административный округ» в списке не нужен — оставляем район.
    const region = p.street ? p.region.split(', ').filter((x) => !/административн/i.test(x)).join(', ') : p.region;
    if (region) parts.push(region);
    if (p.city && p.city !== 'Москва') parts.push(`г. ${p.city}`);
    if (p.locality) parts.push(p.locality);
    if (p.street) parts.push(p.street);
    const h = houseString(p);
    if (h) parts.push(h);
    if (p.flat) parts.push(`кв. ${p.flat}`);
    return parts.join(', ');
  }

  // Подъезд, этаж, домофон — отдельной строкой под адресом.
  function details(p) {
    if (!p) return '';
    return [p.entrance && `подъезд ${p.entrance}`, p.floor && `этаж ${p.floor}`, p.intercom && `домофон ${p.intercom}`]
      .filter(Boolean).join(' · ');
  }

  // Строка для геокодера: без квартиры, подъезда и этажа.
  function toQuery(p, defaultCity) {
    if (!p || (!p.street && !p.locality && !(p.city && p.korpus))) return '';
    let city = p.city || (p.region || p.locality ? '' : (defaultCity || ''));
    // Новая Москва: «Новомосковский административный округ, поселение …» — это Москва.
    if (!p.city && /административн|поселение|\bАО\b|ТиНАО/i.test(p.region)) city = 'Москва';
    const head = city === 'Москва' ? [city, p.region] : [p.region, city];
    return [...head, p.locality, p.street, houseString(p)].filter(Boolean).join(', ');
  }

  // Упрощённый запрос, если полный ничего не нашёл: без округов и районов.
  function toQuerySimple(p, defaultCity) {
    if (!p || (!p.street && !p.locality && !(p.city && p.korpus))) return '';
    const moscowArea = /административн|поселение|ТиНАО/i.test(p.region);
    const city = p.city || (moscowArea || (!p.region && !p.locality) ? (defaultCity || 'Москва') : '');
    return [city, p.locality, p.street, houseString(p)].filter(Boolean).join(', ');
  }

  function streetKey(street) {
    return String(street || '').toLowerCase().replace(/ё/g, 'е')
      .replace(new RegExp(`(^|\\s)(${STREET_WORDS}|улица|проспект|шоссе|переулок|бульвар|набережная|проезд|площадь|микрорайон|квартал)\\.?(?=\\s|$)`, 'g'), ' ')
      .replace(/[^a-zа-я0-9]/g, '');
  }

  // Ключ здания: одинаковый для «ул. Ленина 5к2» и «Ленина улица, д. 5, корп. 2».
  function buildingKey(p) {
    if (!p || (!p.street && !(p.city && p.korpus))) return '';
    let city = (p.city || '').toLowerCase().replace(/ё/g, 'е');
    if (city === 'москва') city = ''; // «Москва, ул. …» и «ул. …» — один и тот же адрес
    return [p.region.toLowerCase(), city, p.locality.toLowerCase(), streetKey(p.street), p.house, p.korpus, p.stroenie].join('|');
  }

  const LOCALITY_WORD = /(^|[\s,])(село|деревня|дер\.|посёлок|поселок|пос\.|рп|пгт|снт|днп|кп)(?=[\s.,]|$)/i;
  function looksLikeAddress(line) {
    if (STREET_RE.test(line)) return true;
    if (LOCALITY_WORD.test(line) && /\d/.test(line)) return true;
    if (/зеленоград/i.test(line) && /\d/.test(line)) return true;
    if (/(^|[\s,])(г\.\s*)?москва(?=[\s,]|$)/i.test(line) && /\d/.test(line) && line.length > 12) return true;
    if (/(^|[\s,])(д|дом)\.?\s*\d/i.test(line) && /[а-яё]{4,}/i.test(line)) return true;
    return false;
  }
  const CONT_RE = /^(?:д\.?\s*\d|дом\s*\d|вл\.?\s*\d|корп|к\.?\s*\d|стр|с\.?\s*\d|кв\.?\s*\d|квартира|под\.?\s*\d|подъезд|эт\.?\s*\d|этаж|дмф|домофон|код|\d{1,4}(?:[а-я]|\/|\s|,|$))/i;
  // строка оборвалась на запятой или сокращении: «…, д.» / «…, кв.» / «… округ,»
  const DANGLING_RE = /(,|(?:^|[\s,])(?:д|дом|кв|под|корп|к|стр|с|эт|ул|пр|ш|дмф)\.?)$/i;
  // Плашки статуса в списке Wildberries относятся к адресу под ними.
  const STATUS_RE = /^(ожидает\s+доставки|забрать\s+возврат\S*|доставлено|отменено|не\s+доставлено|возврат\S*)$/i;
  // Служебные строки экрана: время, вкладки, номер маршрута.
  const NOISE_RE = /^(\d{1,2}:\d{2}.*|lte|5g|доставка|карта|список|карта\s+список|[0-9a-f]{8,})$/i;

  // Из текста скриншота — список адресов. Адрес может занимать 2–3 строки:
  // строки склеиваются, пока предыдущая оборвана (запятая, «д.», «кв.»)
  // или следующая выглядит как продолжение (номер дома, «под.», «дмф.», «этаж»).
  function extract(text) {
    const lines = String(text || '').split(/\r?\n/)
      .map((l) => normalize(l.replace(/^[eо°©]\s+(?=[А-ЯЁ0-9])/, '')))
      .filter((l) => l.length > 1);
    const out = [];
    let tag = null;
    for (let i = 0; i < lines.length; i++) {
      let l = lines[i];
      if (STATUS_RE.test(l)) { tag = /возврат/i.test(l) ? 'return' : null; continue; }
      if (NOISE_RE.test(l)) continue;
      let n = 0;
      while (i + 1 < lines.length && n < 3) {
        const next = lines[i + 1];
        if (STATUS_RE.test(next) || NOISE_RE.test(next)) break;
        const dangling = DANGLING_RE.test(l);
        const cont = CONT_RE.test(next) && !looksLikeAddress(next);
        const startsNew = /^(г\.\s*)?москва,/i.test(next);
        if (!(dangling || cont) || (startsNew && !dangling)) break;
        l = /[,.]$/.test(l) ? `${l} ${next}` : `${l}, ${next}`;
        i++; n++;
      }
      if (!looksLikeAddress(l)) continue;
      const parsed = parse(l);
      if (!parsed.street && !parsed.locality && !(parsed.city && parsed.korpus)) { tag = null; continue; }
      out.push({ text: l.replace(/,\s*$/, ''), parsed, incomplete: !parsed.house, kind: tag });
      tag = null;
    }
    return out;
  }

  const api = { parse, format, details, toQuery, toQuerySimple, houseString, buildingKey, extract, normalize, fixHomoglyphs, canonStreet };
  root.AddressParser = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
