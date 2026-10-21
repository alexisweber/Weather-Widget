/* =========================================================================
   Weather Widget — behavior
   Data source: Open-Meteo (no API key required)
     - Geocoding / place search: geocoding-api.open-meteo.com
     - Forecast:                 api.open-meteo.com
   ========================================================================= */

(() => {
  'use strict';

  /* ---------------------------------------------------------------- */
  /* Config                                                            */
  /* ---------------------------------------------------------------- */

  const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
  const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

  const REFRESH_MS = 6 * 60 * 60 * 1000; // 6 hours
  const SEARCH_DEBOUNCE_MS = 300;
  const WIND_OVERRIDE_KMH = 38; // above this, show "windy" instead of clear/cloudy

  // Hot/cold flag next to the current temperature. Compared in °C (the unit
  // the API returns) so the flag never depends on the °C/°F toggle:
  // hot = above 80°F (26.7°C), cold = below 20°F (-6.7°C).
  const HOT_ABOVE_C = ((80 - 32) * 5) / 9;
  const COLD_BELOW_C = ((20 - 32) * 5) / 9;

  const STORAGE = {
    location: 'weatherWidget.location',
    data: 'weatherWidget.data',
    lastFetch: 'weatherWidget.lastFetch',
    unit: 'weatherWidget.unit',
    scheme: 'weatherWidget.scheme',
    font: 'weatherWidget.font',
    iconStyle: 'weatherWidget.iconStyle',
    inverted: 'weatherWidget.inverted',
  };

  // bg/fg/accent here mirror the .scheme-* rules in style.css — used only
  // to draw the little swatch previews in the settings panel.
  const SCHEMES = [
    { id: 'default', label: 'Default', bg: '#16263F', accent: '#F0B62E' },
    { id: 'autumn', label: 'Autumn', bg: '#A0522D', accent: '#F4A460' },
    { id: 'spring', label: 'Spring', bg: '#6E7B3A', accent: '#AEC16C'}, // #90A2CB '#AFD3EA' '#BECC8F'
    { id: 'winter', label: 'Winter', bg: '#052542', accent: '#6493C9' }, //'#A5C0DF'
    { id: 'summer', label: 'Summer', bg: '#D3A5B8', accent: '#F1DAE4' }, //'#E7CFE5' #efdce3 #ecd5de #DCB8C7 #E5C2D1 #F1DAE4
  ];

  const FONTS = [
    { id: 'default', label: 'Default', family: 'Arial, Helvetica, sans-serif' },
    { id: 'serif', label: 'Serif', family: 'Baskerville, "Hoefler Text", Georgia, "Times New Roman", serif' },
    { id: 'modern', label: 'Modern', family: 'Futura, "Century Gothic", "Trebuchet MS", sans-serif' },
    { id: 'bubble', label: 'Bubble', family: 'DynaPuff, "Arial Rounded MT Bold", Arial, sans-serif' },
  ];

  const ICON_STYLES = [
    { id: 'fill', label: 'Fill' },        // the *_default.svg icons
    { id: 'outline', label: 'Outline' },  // the *_outline.svg icons
  ];

  const WEATHER_DESCRIPTIONS = {
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Rime fog',
    51: 'Light drizzle', 53: 'Drizzle', 55: 'Dense drizzle',
    56: 'Light freezing drizzle', 57: 'Freezing drizzle',
    61: 'Slight rain', 63: 'Rain', 65: 'Heavy rain',
    66: 'Light freezing rain', 67: 'Freezing rain',
    71: 'Slight snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
    80: 'Rain showers', 81: 'Rain showers', 82: 'Violent rain showers',
    85: 'Snow showers', 86: 'Heavy snow showers',
    95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Severe storm, hail',
  };

  /* ---------------------------------------------------------------- */
  /* Icons — your SVG files                                            */
  /*                                                                   */
  /* Every weather icon comes from your own SVG files: the "icon"      */
  /* folder next to index.html (loaded live), or icons-data.js (the    */
  /* same files pre-packed by build-icons.py, which also works when    */
  /* index.html is opened straight from disk). Nothing is drawn here.  */
  /*                                                                   */
  /* For each icon the loader looks for, in order:                     */
  /*     <name>_default.svg / <name>_outline.svg   (matching the style)*/
  /*     <name>.svg                                (shared by both)    */
  /*     the other style's file                    (last resort)       */
  /* Each file is recolored to the active scheme and cached.           */
  /* ---------------------------------------------------------------- */

  const ICON_FOLDERS = ['icon/', 'icons/'];                // first one that exists is used
  const ICON_PROBE_FILES = ['wind.svg', 'clear-day_default.svg', 'clear-day_outline.svg'];
  const ICON_LOAD_TIMEOUT_MS = 4000;
  const STYLE_SUFFIX = { fill: '_default', outline: '_outline' };

  // logical icon -> file base names to try, in order (no suffix, no .svg)
  const ICON_FILES = {
    'clear-day': ['clear-day'],
    'clear-night': ['clear-night'],
    'partly-cloudy-day': ['partly-cloudy-day'],
    'partly-cloudy-night': ['partly-cloudy-night'],
    'cloudy': ['cloudy'],
    'fog': ['foggy-day', 'cloudy'],   // no fog icon supplied -> the cloudy icon is used
    'drizzle': ['drizzle'],
    'rain': ['rain', 'heavy-rain'],
    'thunderstorm': ['thunder-storm', 'thunderstorm'],
    'snow': ['snow'],
    'hail': ['hail'],
    'wind': ['wind'],
    'sunrise': ['sunrise'],
    'sunset': ['sunset'],
    'hot': ['hot'],
    'cold': ['cold'],
  };
  const CONDITION_KEYS = [
    'clear-day', 'clear-night', 'partly-cloudy-day', 'partly-cloudy-night', 'cloudy',
    'fog', 'drizzle', 'rain', 'thunderstorm', 'snow', 'hail', 'wind',
  ];
  const EXTRA_KEYS = ['sunrise', 'sunset', 'hot', 'cold'];
  const ALL_ICON_KEYS = [...CONDITION_KEYS, ...EXTRA_KEYS];

  // Fixed (scheme-independent) colors for the temperature flags.
  const HOT_COLOR = '#FF8A00';   // bright orange
  const COLD_COLOR = '#8EDCFF';  // icy blue

  /* ---- Coloring ----
     Your icons are single-color, built from separate pieces. Each piece is
     given one of three theme colors (all CSS variables, so a scheme change
     or the Invert switch recolors icons instantly):
         accent -> --accent     (sun, rain drops, bolt, flakes, wind ...)
         soft   -> --fg-soft    (clouds, the moon)
         faint  -> --fg-faint   (the little sparkles beside the moon)
     Which piece gets which color is decided per icon by piece size, since in
     these icons the cloud is always by far the biggest piece:
         accent          every piece is accent
         soft            every piece is soft
         cloud+accent    big piece (the cloud) soft, the small pieces accent
         body+sparkles   big piece (the moon) soft, small pieces faint      */
  const ICON_ROLES = {
    'clear-day': 'accent',
    'clear-night': 'body+sparkles',
    'partly-cloudy-day': 'cloud+accent',
    'partly-cloudy-night': 'soft',
    'cloudy': 'soft',
    'fog': 'soft',
    'drizzle': 'cloud+accent',
    'rain': 'cloud+accent',
    'thunderstorm': 'cloud+accent',
    'snow': 'cloud+accent',
    'hail': 'cloud+accent',
    'wind': 'accent',
    'sunrise': 'accent',
    'sunset': 'accent',
  };
  const BIG_PIECE_FRACTION = 0.5; // a piece this big (vs the biggest) counts as "the cloud"

  const CUTOUT = 'var(--icon-cutout, var(--bg))';
  const THEME_COLORS = {
    accent: 'var(--icon-primary, var(--accent))',
    soft: 'var(--icon-secondary, var(--fg-soft))',
    faint: 'var(--icon-faint, var(--fg-faint))',
  };
  const fixedColors = (c) => ({ accent: c, soft: c, faint: c });

  function colorsFor(key) {
    if (key === 'hot') return fixedColors(HOT_COLOR);
    if (key === 'cold') return fixedColors(COLD_COLOR);
    return THEME_COLORS;
  }

  function pieceColorName(rule, area, maxArea) {
    if (rule === 'soft') return 'soft';
    if (!(maxArea > 0)) return 'accent'; // couldn't measure -> don't guess
    const big = area >= BIG_PIECE_FRACTION * maxArea;
    if (rule === 'cloud+accent') return big ? 'soft' : 'accent';
    if (rule === 'body+sparkles') return big ? 'soft' : 'faint';
    return 'accent';
  }

  /* ---- Turning a file into themed, self-contained inline SVG ----
     The file is inlined into a hidden sandbox so the browser can tell us
     each piece's size and final paint; every piece's color is then baked
     into an inline style (fill/stroke/etc.), and classes, <style> blocks,
     fixed sizes and ids are dropped. That keeps each icon self-contained,
     so inlined files can't restyle each other. */

  const SVG_START_RE = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i;
  const LITERAL_PAINT_PARENTS = 'clipPath, mask, pattern, marker, symbol, defs';
  const DRAWABLE_TAGS = new Set(['path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'text', 'tspan']);
  const BAKED_PROPS = [
    ['stroke-width', '1px'], ['stroke-linecap', 'butt'], ['stroke-linejoin', 'miter'],
    ['stroke-miterlimit', '4'], ['stroke-dasharray', 'none'], ['stroke-dashoffset', '0px'],
    ['fill-rule', 'nonzero'], ['clip-rule', 'nonzero'],
    ['opacity', '1'], ['fill-opacity', '1'], ['stroke-opacity', '1'],
  ];

  // 'none' (no paint), 'white' (near-white: shown as a cutout), or 'color'.
  function classifyPaint(value) {
    const v = (value || '').trim().toLowerCase();
    if (!v || v === 'none') return 'none';
    if (v.startsWith('url(')) return 'color';
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+)(%?))?\s*\)/.exec(v);
    if (!m) return 'color';
    const r = Number(m[1]), g = Number(m[2]), b = Number(m[3]);
    if (m[4] !== undefined) {
      const a = m[5] ? Number(m[4]) / 100 : Number(m[4]);
      if (a === 0) return 'none';
    }
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    const light = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return light > 0.93 && chroma < 30 ? 'white' : 'color';
  }

  let sandbox = null;
  function getSandbox() {
    if (!sandbox) {
      sandbox = document.createElement('div');
      sandbox.setAttribute('aria-hidden', 'true');
      sandbox.style.cssText = 'position:absolute;left:-9999px;top:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none;';
      document.body.appendChild(sandbox);
    }
    return sandbox;
  }

  function prepareSvg(text, key, idPrefix) {
    const box = getSandbox();
    box.innerHTML = text;
    try {
      const root = box.querySelector('svg');
      if (!root) return null;

      root.querySelectorAll('script, foreignObject, metadata, title, desc').forEach((n) => n.remove());

      const everything = [root, ...root.querySelectorAll('*')];
      const isLiteral = (el) => !!el.closest(LITERAL_PAINT_PARENTS);
      const tagOf = (el) => el.localName;
      const rule = ICON_ROLES[key] || 'accent';
      const colors = colorsFor(key);

      // Size of every visible piece (bounding-box area, in the icon's own units).
      const areas = new Map();
      let maxArea = 0;
      everything.forEach((el) => {
        if (!DRAWABLE_TAGS.has(tagOf(el)) || isLiteral(el)) return;
        if (getComputedStyle(el).display === 'none') return;
        let area = 0;
        try { const b = el.getBBox(); area = b.width * b.height; } catch (e) { /* unmeasurable */ }
        areas.set(el, area);
        if (area > maxArea) maxArea = area;
      });

      // Work out every element's final inline style before changing anything.
      const plans = everything.map((el) => {
        const cs = getComputedStyle(el);
        const parts = [];
        if (cs.display === 'none') parts.push('display:none');
        const tag = tagOf(el);
        if (DRAWABLE_TAGS.has(tag)) {
          const literal = isLiteral(el);
          const fillKind = tag === 'line' ? 'none' : classifyPaint(cs.fill);
          const strokeKind = classifyPaint(cs.stroke);
          const color = colors[pieceColorName(rule, areas.get(el) || 0, maxArea)];
          const paint = (kind, original) => (kind === 'none' ? 'none' : kind === 'white' ? CUTOUT : color) || original;
          parts.push('fill:' + (literal ? (tag === 'line' ? 'none' : cs.fill) : paint(fillKind, cs.fill)));
          parts.push('stroke:' + (literal ? cs.stroke : paint(strokeKind, cs.stroke)));
          BAKED_PROPS.forEach(([prop, initial]) => {
            const val = cs.getPropertyValue(prop);
            if (val && val !== initial) parts.push(`${prop}:${val}`);
          });
        } else if (tag === 'g' || el === root) {
          const op = cs.getPropertyValue('opacity');
          if (op && op !== '1') parts.push(`opacity:${op}`);
        }
        return { el, tag, parts };
      });

      plans.forEach(({ el, tag, parts }) => {
        el.removeAttribute('class');
        if (DRAWABLE_TAGS.has(tag) || tag === 'g') {
          el.removeAttribute('fill');
          el.removeAttribute('stroke');
        }
        if (parts.length) el.setAttribute('style', parts.join(';'));
        else el.removeAttribute('style');
        Array.from(el.attributes).forEach((a) => {
          if (/^on/i.test(a.name)) el.removeAttribute(a.name);
        });
      });
      root.querySelectorAll('style').forEach((n) => n.remove());

      // Scale with CSS rather than the file's own pixel size.
      if (!root.getAttribute('viewBox')) {
        const w = parseFloat(root.getAttribute('width'));
        const h = parseFloat(root.getAttribute('height'));
        if (w > 0 && h > 0) root.setAttribute('viewBox', `0 0 ${w} ${h}`);
      }
      ['width', 'height', 'x', 'y'].forEach((a) => root.removeAttribute(a));
      root.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      root.setAttribute('focusable', 'false');
      root.setAttribute('aria-hidden', 'true');

      // Namespace ids (and references) so two icons can't collide.
      const idMap = new Map();
      [root, ...root.querySelectorAll('[id]')].forEach((el) => {
        const id = el.getAttribute('id');
        if (id) { idMap.set(id, idPrefix + id); el.setAttribute('id', idPrefix + id); }
      });
      if (idMap.size) {
        [root, ...root.querySelectorAll('*')].forEach((el) => {
          Array.from(el.attributes).forEach((a) => {
            let v = a.value;
            v = v.replace(/url\(\s*(['"]?)#([^)'"\s]+)\1\s*\)/g, (m, q, id) => (idMap.has(id) ? `url(#${idMap.get(id)})` : m));
            if ((a.name === 'href' || a.name === 'xlink:href') && v.startsWith('#') && idMap.has(v.slice(1))) {
              v = '#' + idMap.get(v.slice(1));
            }
            if (v !== a.value) el.setAttribute(a.name, v);
          });
        });
      }

      return root.outerHTML;
    } finally {
      box.innerHTML = '';
    }
  }

  /* ---- Finding and reading the files ---- */

  async function fetchSvgText(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const text = await res.text();
      // Some dev servers answer a missing file with an HTML page and a 200.
      return SVG_START_RE.test(text) ? text : null;
    } catch (e) {
      return null;
    }
  }

  // Which folder holds the icons? (null = none reachable; also null on
  // file:// pages, where browsers block fetch() — icons-data.js is used then.)
  let iconFolderPromise = null;
  function findIconFolder() {
    if (!iconFolderPromise) {
      iconFolderPromise = (async () => {
        if (window.location.protocol === 'file:') return null;
        for (const folder of ICON_FOLDERS) {
          for (const probe of ICON_PROBE_FILES) {
            if (await fetchSvgText(folder + probe)) return folder;
          }
        }
        return null;
      })();
    }
    return iconFolderPromise;
  }

  async function readIconFile(fileName) {
    const folder = await findIconFolder();
    if (folder) {
      const live = await fetchSvgText(folder + fileName);
      if (live) return live;
    }
    const packed = window.WEATHER_ICON_DATA; // from icons-data.js
    return packed && typeof packed[fileName] === 'string' ? packed[fileName] : null;
  }

  function iconFileNames(key, style) {
    const bases = ICON_FILES[key];
    const own = STYLE_SUFFIX[style];
    const other = STYLE_SUFFIX[style === 'fill' ? 'outline' : 'fill'];
    return [
      ...bases.flatMap((b) => [`${b}${own}.svg`, `${b}.svg`]),
      ...bases.map((b) => `${b}${other}.svg`),
    ];
  }

  /* ---- Loading + caching ---- */

  const fileIcons = new Map();   // "<style>:<key>" -> themed markup, or null if no file was found
  const iconLoads = new Map();   // "<style>:<key>" -> in-flight promise
  const iconWarnings = new Set();

  function fileStyle() { return state.iconStyle === 'outline' ? 'outline' : 'fill'; }

  function loadFileIcon(key, style) {
    const cacheKey = `${style}:${key}`;
    if (iconLoads.has(cacheKey)) return iconLoads.get(cacheKey);
    const p = (async () => {
      const own = STYLE_SUFFIX[style];
      for (const name of iconFileNames(key, style)) {
        const text = await readIconFile(name);
        if (!text) continue;
        let markup = null;
        try { markup = prepareSvg(text, key, `wx-${style}-${key}-`); } catch (e) {
          console.error(`Weather widget: could not process ${name}`, e);
        }
        if (markup) {
          fileIcons.set(cacheKey, markup);
          const sharedOrOwn = name.endsWith(own + '.svg') || !/_(default|outline)\.svg$/.test(name);
          if (!sharedOrOwn) iconWarnings.add(`No ${style} version of "${key}" found; using ${name} instead.`);
          return;
        }
      }
      fileIcons.set(cacheKey, null);
    })();
    iconLoads.set(cacheKey, p);
    return p;
  }

  // Resolves once the icons for the current style have loaded (or after a
  // timeout, in which case a late re-render swaps them in when ready).
  async function ensureIcons() {
    const style = fileStyle();
    const all = Promise.all(ALL_ICON_KEYS.map((k) => loadFileIcon(k, style))).then(() => {
      const missing = ALL_ICON_KEYS.filter((k) => !fileIcons.get(`${style}:${k}`));
      const notes = [];
      if (missing.length) {
        notes.push(`No file found for: ${missing.map((k) => ICON_FILES[k][0]).join(', ')}.`);
      }
      iconWarnings.forEach((w) => { if (w.includes(`No ${style} version`)) notes.push(w); });
      const text = notes.join(' ');
      if (text && !iconWarnings.has('logged:' + text)) {
        iconWarnings.add('logged:' + text);
        const where = window.location.protocol === 'file:'
          ? 'This page was opened from disk, so only icons-data.js can be used (run build-icons.py to refresh it).'
          : `Looked in ${ICON_FOLDERS.join(' and ')} next to index.html, then icons-data.js.`;
        console.warn(`Weather widget icons — ${text} ${where}`);
      }
      return 'loaded';
    });
    const timeout = new Promise((resolve) => window.setTimeout(() => resolve('timeout'), ICON_LOAD_TIMEOUT_MS));
    const outcome = await Promise.race([all, timeout]);
    if (outcome === 'timeout') all.then(() => { if (state.weatherData) renderAll(); });
  }

  function anyConditionIconLoaded() {
    const style = fileStyle();
    return CONDITION_KEYS.some((k) => fileIcons.get(`${style}:${k}`));
  }

  function getIcon(condition) {
    return fileIcons.get(`${fileStyle()}:${condition}`) || '';
  }

  function getExtraIcon(key) {
    return fileIcons.get(`${fileStyle()}:${key}`) || null;
  }

  // Little preview in the Icon style menu buttons.
  function stylePreviewIcon(id) {
    return fileIcons.get(`${id}:clear-day`) || '';
  }

  const SKY_CLASS = {
    'clear-day': 'sky-clear-day',
    'clear-night': 'sky-clear-night',
    'partly-cloudy-day': 'sky-cloudy-day',
    'partly-cloudy-night': 'sky-cloudy-night',
    'cloudy': 'sky-cloudy-day',
    'fog': 'sky-fog',
    'drizzle': 'sky-rain',
    'rain': 'sky-rain',
    'thunderstorm': 'sky-thunderstorm',
    'snow': 'sky-snow',
    'hail': 'sky-hail',
    'wind': 'sky-wind',
  };

  function classifyCondition(code, isDay, windKmh) {
    if (typeof windKmh === 'number' && windKmh >= WIND_OVERRIDE_KMH && [0, 1, 2, 3].includes(code)) {
      return 'wind';
    }
    if (code === 0) return isDay ? 'clear-day' : 'clear-night';
    if (code === 1 || code === 2) return isDay ? 'partly-cloudy-day' : 'partly-cloudy-night';
    if (code === 3) return 'cloudy';
    if (code === 45 || code === 48) return 'fog';
    // Light rain / drizzle / light showers -> drizzle icon; the rest -> heavy rain icon.
    if ([51, 53, 55, 56, 57, 61, 80].includes(code)) return 'drizzle';
    if ([63, 65, 66, 67, 81, 82].includes(code)) return 'rain';
    if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snow';
    if (code === 95) return 'thunderstorm';
    if (code === 96 || code === 99) return 'hail';
    return 'cloudy';
  }

  /* ---------------------------------------------------------------- */
  /* DOM refs                                                          */
  /* ---------------------------------------------------------------- */

  const widget = document.getElementById('weatherWidget');
  const skyStrip = document.getElementById('skyStrip');

  const searchScreen = document.getElementById('searchScreen');
  const locationInput = document.getElementById('locationInput');
  const suggestionsList = document.getElementById('suggestionsList');
  const searchStatus = document.getElementById('searchStatus');

  const weatherScreen = document.getElementById('weatherScreen');
  const changeLocationBtn = document.getElementById('changeLocationBtn');
  const locationName = document.getElementById('locationName');
  const locationSub = document.getElementById('locationSub');
  const unitCBtn = document.getElementById('unitC');
  const unitFBtn = document.getElementById('unitF');
  const menuUnitCBtn = document.getElementById('menuUnitC');
  const menuUnitFBtn = document.getElementById('menuUnitF');
  const currentIcon = document.getElementById('currentIcon');
  const currentTemp = document.getElementById('currentTemp');
  const tempFlag = document.getElementById('tempFlag');
  const currentDesc = document.getElementById('currentDesc');
  const hourlyBand = document.getElementById('hourlyBand');
  const dailyTableBody = document.getElementById('dailyTableBody');
  const lastUpdated = document.getElementById('lastUpdated');
  const errorBanner = document.getElementById('errorBanner');

  const settingsBtn = document.getElementById('settingsBtn');
  const settingsPanel = document.getElementById('settingsPanel');
  const schemeRow = document.getElementById('schemeRow');
  const fontRow = document.getElementById('fontRow');
  const styleRow = document.getElementById('styleRow');
  const invertToggle = document.getElementById('invertToggle');

  /* ---------------------------------------------------------------- */
  /* State                                                             */
  /* ---------------------------------------------------------------- */

  const state = {
    location: null,      // { name, admin1, country, latitude, longitude, timezone }
    weatherData: null,   // raw Open-Meteo forecast response
    unit: 'C',
    highlightedSuggestion: -1,
    suggestions: [],
    searchRequestId: 0,
    scheme: 'default',
    font: 'default',
    iconStyle: 'fill',
    inverted: false,
  };

  /* ---------------------------------------------------------------- */
  /* Storage helpers                                                   */
  /* ---------------------------------------------------------------- */

  function saveLocation(loc) {
    try { localStorage.setItem(STORAGE.location, JSON.stringify(loc)); } catch (e) { /* ignore */ }
  }
  function loadLocation() {
    try {
      const raw = localStorage.getItem(STORAGE.location);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function saveWeatherData(data) {
    try { localStorage.setItem(STORAGE.data, JSON.stringify(data)); } catch (e) { /* ignore */ }
  }
  function loadWeatherData() {
    try {
      const raw = localStorage.getItem(STORAGE.data);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function saveLastFetch(ts) {
    try { localStorage.setItem(STORAGE.lastFetch, String(ts)); } catch (e) { /* ignore */ }
  }
  function loadLastFetch() {
    const raw = localStorage.getItem(STORAGE.lastFetch);
    return raw ? Number(raw) : 0;
  }
  function saveUnit(unit) {
    try { localStorage.setItem(STORAGE.unit, unit); } catch (e) { /* ignore */ }
  }
  function loadUnit() {
    const raw = localStorage.getItem(STORAGE.unit);
    return raw === 'F' ? 'F' : 'C';
  }

  function saveScheme(id) {
    try { localStorage.setItem(STORAGE.scheme, id); } catch (e) { /* ignore */ }
  }
  function loadScheme() {
    const raw = localStorage.getItem(STORAGE.scheme);
    return SCHEMES.some((s) => s.id === raw) ? raw : 'default';
  }
  function saveFont(id) {
    try { localStorage.setItem(STORAGE.font, id); } catch (e) { /* ignore */ }
  }
  function loadFont() {
    const raw = localStorage.getItem(STORAGE.font);
    return FONTS.some((f) => f.id === raw) ? raw : 'default';
  }
  function saveIconStyle(id) {
    try { localStorage.setItem(STORAGE.iconStyle, id); } catch (e) { /* ignore */ }
  }
  function loadIconStyle() {
    const raw = localStorage.getItem(STORAGE.iconStyle);
    // Older versions saved 'default' (now "Fill") and had a 'round' style (removed).
    if (raw === 'default' || raw === 'round') return 'fill';
    return ICON_STYLES.some((s) => s.id === raw) ? raw : 'fill';
  }
  function saveInverted(val) {
    try { localStorage.setItem(STORAGE.inverted, val ? '1' : '0'); } catch (e) { /* ignore */ }
  }
  function loadInverted() {
    return localStorage.getItem(STORAGE.inverted) === '1';
  }

  /* ---------------------------------------------------------------- */
  /* Formatting helpers                                                */
  /* ---------------------------------------------------------------- */

  function cToF(c) { return (c * 9) / 5 + 32; }

  function formatTemp(celsiusValue) {
    if (celsiusValue === null || celsiusValue === undefined || Number.isNaN(celsiusValue)) return '—';
    const val = state.unit === 'F' ? cToF(celsiusValue) : celsiusValue;
    return `${Math.round(val)}°`;
  }

  // Parse an Open-Meteo local time string ("2026-08-02T14:00") without
  // letting the browser's own timezone reinterpret it.
  function parseLocalHour(timeStr) {
    return Number(timeStr.slice(11, 13));
  }

  function formatHourLabel(hour24, isNow) {
    if (isNow) return 'Now';
    const h = ((hour24 + 11) % 12) + 1;
    const suffix = hour24 < 12 || hour24 === 24 ? 'a' : 'p';
    return `${h}${suffix}`;
  }

  // "2026-10-20T07:12" -> "7:12a" (used for sunrise/sunset markers)
  function formatClockLabel(timeStr) {
    const h24 = Number(timeStr.slice(11, 13));
    const h = ((h24 + 11) % 12) + 1;
    return `${h}:${timeStr.slice(14, 16)}${h24 < 12 ? 'a' : 'p'}`;
  }

  function formatWeekday(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const idx = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][idx];
  }

  function formatUpdatedLabel(ts) {
    if (!ts) return '';
    const diffMin = Math.round((Date.now() - ts) / 60000);
    if (diffMin < 1) return 'Updated just now';
    if (diffMin < 60) return `Updated ${diffMin} min ago`;
    const diffHr = Math.round(diffMin / 60);
    return `Updated ${diffHr} hr${diffHr === 1 ? '' : 's'} ago`;
  }

  function locationLabel(loc) {
    return loc.name;
  }
  function locationSubLabel(loc) {
    return [loc.admin1, loc.country].filter(Boolean).join(', ');
  }

  /* ---------------------------------------------------------------- */
  /* Screen switching                                                  */
  /* ---------------------------------------------------------------- */

  function showSearchScreen() {
    weatherScreen.hidden = true;
    searchScreen.hidden = false;
    locationInput.value = '';
    clearSuggestions();
    window.setTimeout(() => locationInput.focus(), 0);
  }

  function showWeatherScreen() {
    searchScreen.hidden = true;
    weatherScreen.hidden = false;
  }

  /* ---------------------------------------------------------------- */
  /* Search / autocomplete                                             */
  /* ---------------------------------------------------------------- */

  let debounceTimer = null;

  locationInput.addEventListener('input', () => {
    const query = locationInput.value.trim();
    window.clearTimeout(debounceTimer);
    if (query.length < 2) {
      clearSuggestions();
      searchStatus.textContent = '';
      return;
    }
    searchStatus.textContent = 'Searching…';
    debounceTimer = window.setTimeout(() => fetchSuggestions(query), SEARCH_DEBOUNCE_MS);
  });

  locationInput.addEventListener('keydown', (e) => {
    const items = state.suggestions;
    if (e.key === 'ArrowDown') {
      if (!items.length) return;
      e.preventDefault();
      state.highlightedSuggestion = Math.min(state.highlightedSuggestion + 1, items.length - 1);
      renderHighlight();
    } else if (e.key === 'ArrowUp') {
      if (!items.length) return;
      e.preventDefault();
      state.highlightedSuggestion = Math.max(state.highlightedSuggestion - 1, 0);
      renderHighlight();
    } else if (e.key === 'Enter') {
      if (state.highlightedSuggestion >= 0 && items[state.highlightedSuggestion]) {
        e.preventDefault();
        selectLocation(items[state.highlightedSuggestion]);
      }
    } else if (e.key === 'Escape') {
      if (state.location) {
        showWeatherScreen();
      } else {
        clearSuggestions();
        locationInput.value = '';
      }
    }
  });

  document.addEventListener('click', (e) => {
    if (!searchScreen.contains(e.target)) return;
    if (!e.target.closest('.search-box') && !e.target.closest('.suggestions-list')) {
      clearSuggestions();
    }
  });

  async function fetchSuggestions(query) {
    const requestId = ++state.searchRequestId;
    try {
      const url = `${GEOCODE_URL}?name=${encodeURIComponent(query)}&count=8&language=en&format=json`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Geocoding request failed (${res.status})`);
      const data = await res.json();
      if (requestId !== state.searchRequestId) return; // a newer keystroke superseded this
      const results = (data.results || []).map((r) => ({
        name: r.name,
        admin1: r.admin1 || '',
        country: r.country || '',
        latitude: r.latitude,
        longitude: r.longitude,
        timezone: r.timezone,
      }));
      state.suggestions = results;
      state.highlightedSuggestion = -1;
      renderSuggestions(results);
      searchStatus.textContent = results.length ? '' : 'No matching locations';
    } catch (err) {
      if (requestId !== state.searchRequestId) return;
      console.error('Weather widget: geocoding error', err);
      searchStatus.textContent = 'Search is unavailable right now';
    }
  }

  function renderSuggestions(results) {
    suggestionsList.innerHTML = '';
    if (!results.length) {
      suggestionsList.hidden = true;
      locationInput.setAttribute('aria-expanded', 'false');
      return;
    }
    results.forEach((loc, i) => {
      const li = document.createElement('li');
      li.className = 'suggestion-item';
      li.id = `suggestion-${i}`;
      li.setAttribute('role', 'option');
      li.innerHTML = `
        <span class="suggestion-name"></span>
        <span class="suggestion-region"></span>
      `;
      li.querySelector('.suggestion-name').textContent = locationLabel(loc);
      li.querySelector('.suggestion-region').textContent = locationSubLabel(loc);
      li.addEventListener('click', () => selectLocation(loc));
      suggestionsList.appendChild(li);
    });
    suggestionsList.hidden = false;
    locationInput.setAttribute('aria-expanded', 'true');
  }

  function renderHighlight() {
    const items = suggestionsList.querySelectorAll('.suggestion-item');
    items.forEach((el, i) => {
      el.classList.toggle('is-highlighted', i === state.highlightedSuggestion);
    });
    const active = items[state.highlightedSuggestion];
    if (active) {
      locationInput.setAttribute('aria-activedescendant', active.id);
      active.scrollIntoView({ block: 'nearest' });
    }
  }

  function clearSuggestions() {
    state.suggestions = [];
    state.highlightedSuggestion = -1;
    suggestionsList.innerHTML = '';
    suggestionsList.hidden = true;
    locationInput.setAttribute('aria-expanded', 'false');
    locationInput.removeAttribute('aria-activedescendant');
  }

  function selectLocation(loc) {
    state.location = loc;
    saveLocation(loc);
    clearSuggestions();
    showWeatherScreen();
    locationName.textContent = locationLabel(loc);
    locationSub.textContent = locationSubLabel(loc);
    fetchWeather(loc);
  }

  /* ---------------------------------------------------------------- */
  /* Weather fetch + render                                            */
  /* ---------------------------------------------------------------- */

  async function fetchWeather(loc) {
    hideError();
    try {
      const params = new URLSearchParams({
        latitude: loc.latitude,
        longitude: loc.longitude,
        current_weather: 'true',
        hourly: 'temperature_2m,weathercode,is_day,wind_speed_10m',
        daily: 'weathercode,temperature_2m_max,temperature_2m_min,wind_speed_10m_max,sunrise,sunset',
        timezone: 'auto',
        forecast_days: '10',
      });
      const res = await fetch(`${FORECAST_URL}?${params.toString()}`);
      if (!res.ok) throw new Error(`Forecast request failed (${res.status})`);
      const data = await res.json();
      state.weatherData = data;
      saveWeatherData(data);
      saveLastFetch(Date.now());
      await ensureIcons();
      renderAll();
    } catch (err) {
      console.error('Weather widget: forecast fetch error', err);
      if (state.weatherData) {
        // Keep showing the last good data; refresh will retry next cycle.
        lastUpdated.textContent = `${formatUpdatedLabel(loadLastFetch())} · retry pending`;
      } else {
        showError('Could not load weather for this location. Check your connection and try again.');
      }
    }
  }

  const ICON_HELP_MESSAGE = 'Weather icons not found. Put your SVGs in an "icon" folder next to index.html and open the page via a web server (or run build-icons.py) — see README.';

  function showError(message) {
    errorBanner.textContent = message;
    errorBanner.hidden = false;
  }
  function hideError() {
    errorBanner.hidden = true;
    errorBanner.textContent = '';
  }

  function renderAll() {
    const data = state.weatherData;
    const loc = state.location;
    if (!data || !loc) return;

    locationName.textContent = locationLabel(loc);
    locationSub.textContent = locationSubLabel(loc);

    renderCurrent(data);
    renderHourly(data);
    renderDaily(data);

    lastUpdated.textContent = formatUpdatedLabel(loadLastFetch());

    // If not a single icon file could be found, say so on the widget itself
    // instead of silently showing blanks.
    if (!anyConditionIconLoaded()) showError(ICON_HELP_MESSAGE);
    else if (errorBanner.textContent === ICON_HELP_MESSAGE) hideError();
  }

  function renderCurrent(data) {
    const cw = data.current_weather;
    if (!cw) return;
    const condition = classifyCondition(cw.weathercode, !!cw.is_day, cw.windspeed);
    currentIcon.innerHTML = getIcon(condition);
    currentTemp.textContent = formatTemp(cw.temperature);
    currentDesc.textContent = condition === 'wind' ? 'Windy' : (WEATHER_DESCRIPTIONS[cw.weathercode] || '');
    renderTempFlag(cw.temperature);

    skyStrip.className = 'sky-strip ' + (SKY_CLASS[condition] || '');
  }

  function renderTempFlag(celsius) {
    let kind = null;
    if (celsius > HOT_ABOVE_C) kind = 'hot';
    else if (celsius < COLD_BELOW_C) kind = 'cold';

    const markup = kind ? getExtraIcon(kind) : null;
    if (!markup) {
      tempFlag.hidden = true;
      tempFlag.innerHTML = '';
      return;
    }
    tempFlag.innerHTML = markup;
    tempFlag.setAttribute('aria-label', kind === 'hot' ? 'Hot' : 'Cold');
    tempFlag.title = kind === 'hot' ? 'Hot' : 'Cold';
    tempFlag.hidden = false;
  }

  function renderHourly(data) {
    const hourly = data.hourly;
    if (!hourly || !hourly.time) return;

    // Find the index closest to "now" in the location's own local time.
    let startIdx = 0;
    if (data.current_weather && data.current_weather.time) {
      const nowIdx = hourly.time.indexOf(data.current_weather.time.slice(0, 13) + ':00');
      startIdx = nowIdx >= 0 ? nowIdx : 0;
    }

    const count = Math.min(24, hourly.time.length - startIdx);
    const frag = document.createDocumentFragment();

    // One entry per hour, plus a sunrise/sunset marker wherever one falls
    // inside the window (times are the location's local "YYYY-MM-DDTHH:mm"
    // strings, so plain string comparison orders them correctly).
    const entries = [];
    for (let i = 0; i < count; i++) {
      entries.push({ kind: 'hour', i, time: hourly.time[startIdx + i] });
    }
    const nowStr = data.current_weather && data.current_weather.time;
    if (data.daily && nowStr && count > 0) {
      const windowEnd = hourly.time[startIdx + count - 1].slice(0, 13) + ':59';
      [['sunrise', data.daily.sunrise], ['sunset', data.daily.sunset]].forEach(([type, list]) => {
        if (!list || !getExtraIcon(type)) return;
        list.forEach((t) => {
          if (t && t >= nowStr && t <= windowEnd) entries.push({ kind: 'event', type, time: t });
        });
      });
    }
    entries.sort((a, b) => {
      if (a.time !== b.time) return a.time < b.time ? -1 : 1;
      if (a.kind === b.kind) return 0;
      return a.kind === 'hour' ? -1 : 1;
    });

    entries.forEach((entry) => {
      const item = document.createElement('div');
      item.innerHTML = `
        <span class="hour-time"></span>
        <span class="hour-icon"></span>
        <span class="hour-temp"></span>
      `;

      if (entry.kind === 'event') {
        item.className = 'hour-item is-event';
        item.querySelector('.hour-time').textContent = formatClockLabel(entry.time);
        item.querySelector('.hour-icon').innerHTML = getExtraIcon(entry.type);
        item.querySelector('.hour-temp').textContent = entry.type === 'sunrise' ? 'Sunrise' : 'Sunset';
      } else {
        const idx = startIdx + entry.i;
        const hour24 = parseLocalHour(hourly.time[idx]);
        const isDay = !!hourly.is_day[idx];
        const wind = hourly.wind_speed_10m ? hourly.wind_speed_10m[idx] : undefined;
        const condition = classifyCondition(hourly.weathercode[idx], isDay, wind);

        item.className = 'hour-item' + (entry.i === 0 ? ' is-now' : '');
        item.querySelector('.hour-time').textContent = formatHourLabel(hour24, entry.i === 0);
        item.querySelector('.hour-icon').innerHTML = getIcon(condition);
        item.querySelector('.hour-temp').textContent = formatTemp(hourly.temperature_2m[idx]);
      }
      frag.appendChild(item);
    });

    hourlyBand.innerHTML = '';
    hourlyBand.appendChild(frag);
    hourlyBand.scrollLeft = 0;
  }

  function renderDaily(data) {
    const daily = data.daily;
    if (!daily || !daily.time) return;

    const mins = daily.temperature_2m_min;
    const maxs = daily.temperature_2m_max;
    const weekMin = Math.min(...mins);
    const weekMax = Math.max(...maxs);
    const range = Math.max(weekMax - weekMin, 1);

    const frag = document.createDocumentFragment();

    daily.time.forEach((dateStr, i) => {
      const wind = daily.wind_speed_10m_max ? daily.wind_speed_10m_max[i] : undefined;
      // Daily rows use the day's own daytime code, so classify as day-time.
      const condition = classifyCondition(daily.weathercode[i], true, wind);

      const leftPct = ((mins[i] - weekMin) / range) * 100;
      const widthPct = Math.max(((maxs[i] - mins[i]) / range) * 100, 4);

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="day-name"></td>
        <td class="day-icon-cell"><span class="day-icon"></span></td>
        <td class="day-bar-cell">
          <div class="day-bar-track">
            <div class="day-bar-fill" style="left:${leftPct}%; width:${widthPct}%"></div>
          </div>
        </td>
        <td class="day-range"><span class="day-min"></span><span class="day-max"></span></td>
      `;
      tr.querySelector('.day-name').textContent = i === 0 ? 'Today' : formatWeekday(dateStr);
      tr.querySelector('.day-icon').innerHTML = getIcon(condition);
      tr.querySelector('.day-min').textContent = formatTemp(mins[i]);
      tr.querySelector('.day-max').textContent = formatTemp(maxs[i]);
      frag.appendChild(tr);
    });

    dailyTableBody.innerHTML = '';
    dailyTableBody.appendChild(frag);
  }

  /* ---------------------------------------------------------------- */
  /* Unit toggle                                                       */
  /* ---------------------------------------------------------------- */

  function setUnit(unit) {
    state.unit = unit;
    saveUnit(unit);
    unitCBtn.classList.toggle('is-active', unit === 'C');
    unitCBtn.setAttribute('aria-pressed', String(unit === 'C'));
    unitFBtn.classList.toggle('is-active', unit === 'F');
    unitFBtn.setAttribute('aria-pressed', String(unit === 'F'));
    menuUnitCBtn.classList.toggle('is-active', unit === 'C');
    menuUnitCBtn.setAttribute('aria-pressed', String(unit === 'C'));
    menuUnitFBtn.classList.toggle('is-active', unit === 'F');
    menuUnitFBtn.setAttribute('aria-pressed', String(unit === 'F'));
    if (state.weatherData) renderAll();
  }

  unitCBtn.addEventListener('click', () => setUnit('C'));
  unitFBtn.addEventListener('click', () => setUnit('F'));
  menuUnitCBtn.addEventListener('click', () => setUnit('C'));
  menuUnitFBtn.addEventListener('click', () => setUnit('F'));

  /* ---------------------------------------------------------------- */
  /* Change location                                                   */
  /* ---------------------------------------------------------------- */

  changeLocationBtn.addEventListener('click', showSearchScreen);

  /* ---------------------------------------------------------------- */
  /* Customization menu                                                */
  /* ---------------------------------------------------------------- */

  function applySchemeClass() {
    SCHEMES.forEach((s) => widget.classList.remove('scheme-' + s.id));
    widget.classList.add('scheme-' + state.scheme);
  }

  function applyFontClass() {
    FONTS.forEach((f) => widget.classList.remove('font-' + f.id));
    widget.classList.add('font-' + state.font);
  }

  function buildSchemeSwatches() {
    schemeRow.innerHTML = '';
    SCHEMES.forEach((s) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'swatch-btn' + (state.scheme === s.id ? ' is-active' : '');
      btn.style.background = s.bg;
      btn.style.borderColor = s.accent;
      btn.title = s.label;
      btn.setAttribute('aria-label', s.label);
      btn.setAttribute('aria-pressed', String(state.scheme === s.id));
      btn.addEventListener('click', () => setScheme(s.id));
      schemeRow.appendChild(btn);
    });
  }

  function buildFontOptions() {
    fontRow.innerHTML = '';
    FONTS.forEach((f) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'option-btn' + (state.font === f.id ? ' is-active' : '');
      btn.style.fontFamily = f.family;
      btn.textContent = f.label;
      btn.setAttribute('aria-pressed', String(state.font === f.id));
      btn.addEventListener('click', () => setFont(f.id));
      fontRow.appendChild(btn);
    });
  }

  function buildStyleOptions() {
    styleRow.innerHTML = '';
    ICON_STYLES.forEach((st) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'option-btn' + (state.iconStyle === st.id ? ' is-active' : '');
      btn.setAttribute('aria-pressed', String(state.iconStyle === st.id));
      const iconSpan = document.createElement('span');
      iconSpan.className = 'opt-icon';
      iconSpan.innerHTML = stylePreviewIcon(st.id) || '';
      const labelSpan = document.createElement('span');
      labelSpan.textContent = st.label;
      btn.appendChild(iconSpan);
      btn.appendChild(labelSpan);
      btn.addEventListener('click', () => setIconStyle(st.id));
      styleRow.appendChild(btn);
    });
  }

  function setScheme(id) {
    state.scheme = id;
    saveScheme(id);
    applySchemeClass();
    buildSchemeSwatches();
  }

  function setFont(id) {
    state.font = id;
    saveFont(id);
    applyFontClass();
    buildFontOptions();
  }

  function setIconStyle(id) {
    state.iconStyle = id;
    saveIconStyle(id);
    buildStyleOptions();
    // Load the new style's files (instant if already cached), then re-render.
    ensureIcons().then(() => {
      if (state.iconStyle !== id) return; // user switched again while loading
      buildStyleOptions();
      if (state.weatherData) renderAll();
    });
  }

  function setInverted(val) {
    state.inverted = val;
    saveInverted(val);
    widget.classList.toggle('inverted', val);
    invertToggle.classList.toggle('is-on', val);
    invertToggle.setAttribute('aria-checked', String(val));
  }

  function openSettingsPanel() {
    settingsPanel.hidden = false;
    settingsBtn.setAttribute('aria-expanded', 'true');
  }
  function closeSettingsPanel() {
    settingsPanel.hidden = true;
    settingsBtn.setAttribute('aria-expanded', 'false');
  }

  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // keep this click from also triggering the outside-click closer below
    if (settingsPanel.hidden) openSettingsPanel();
    else closeSettingsPanel();
  });

  invertToggle.addEventListener('click', () => setInverted(!state.inverted));

  document.addEventListener('click', (e) => {
    if (settingsPanel.hidden) return;
    // Use the path recorded when the click was dispatched, not e.target:
    // clicking a swatch/font/style button rebuilds that button, so by the
    // time this runs e.target is detached and no longer "inside" the panel.
    const path = e.composedPath();
    if (path.includes(settingsPanel) || path.includes(settingsBtn)) return;
    closeSettingsPanel();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !settingsPanel.hidden) {
      closeSettingsPanel();
      settingsBtn.focus();
    }
  });

  /* ---------------------------------------------------------------- */
  /* Size-adjustable: observe the widget's own box, not the viewport   */
  /* ---------------------------------------------------------------- */

  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        widget.classList.toggle('compact', width < 380 && width >= 260);
        widget.classList.toggle('tiny', width < 260);
      }
    });
    ro.observe(widget);
  }

  /* ---------------------------------------------------------------- */
  /* Init + 6-hour refresh cycle                                       */
  /* ---------------------------------------------------------------- */

  function init() {
    state.unit = loadUnit();
    unitCBtn.classList.toggle('is-active', state.unit === 'C');
    unitCBtn.setAttribute('aria-pressed', String(state.unit === 'C'));
    unitFBtn.classList.toggle('is-active', state.unit === 'F');
    unitFBtn.setAttribute('aria-pressed', String(state.unit === 'F'));
    menuUnitCBtn.classList.toggle('is-active', state.unit === 'C');
    menuUnitCBtn.setAttribute('aria-pressed', String(state.unit === 'C'));
    menuUnitFBtn.classList.toggle('is-active', state.unit === 'F');
    menuUnitFBtn.setAttribute('aria-pressed', String(state.unit === 'F'));

    state.scheme = loadScheme();
    state.font = loadFont();
    state.iconStyle = loadIconStyle();
    state.inverted = loadInverted();

    applySchemeClass();
    applyFontClass();
    widget.classList.toggle('inverted', state.inverted);

    buildSchemeSwatches();
    buildFontOptions();
    buildStyleOptions();
    invertToggle.classList.toggle('is-on', state.inverted);
    invertToggle.setAttribute('aria-checked', String(state.inverted));

    // Start loading icon files right away (also the previews in the menu).
    const iconsReady = ensureIcons();
    Promise.all([
      loadFileIcon('clear-day', 'fill'),
      loadFileIcon('clear-day', 'outline'),
    ]).then(buildStyleOptions);

    const savedLocation = loadLocation();

    if (savedLocation) {
      state.location = savedLocation;
      showWeatherScreen();
      locationName.textContent = locationLabel(savedLocation);
      locationSub.textContent = locationSubLabel(savedLocation);

      const cached = loadWeatherData();
      if (cached) {
        state.weatherData = cached;
        iconsReady.then(() => renderAll());
      }

      // Data cached by an older version has no sunrise/sunset: refetch it now.
      const cachedLacksSun = !!cached && !(cached.daily && cached.daily.sunrise);
      const lastFetch = loadLastFetch();
      if (!lastFetch || cachedLacksSun || Date.now() - lastFetch >= REFRESH_MS) {
        fetchWeather(savedLocation);
      }
    } else {
      showSearchScreen();
    }

    window.setInterval(() => {
      if (state.location) fetchWeather(state.location);
    }, REFRESH_MS);
  }

  init();
})();
