/* =====================================================================
   Small SVG chart helpers (line, box, bar) used by the FastQC report,
   the variant funnel and coverage plots. Thin marks, recessive axes,
   crosshair tooltips and a table view for every chart.
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const { h } = MG;
  const NS = 'http://www.w3.org/2000/svg';

  /* validated categorical order (see dataviz reference palette) */
  const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
  const STATUS = { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' };
  const INK = { primary: '#0b0b0b', secondary: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7', surface: '#fcfcfb' };

  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(NS, tag);
    if (attrs) Object.entries(attrs).forEach(([k, v]) => v != null && el.setAttribute(k, v));
    kids.forEach((k) => k != null && el.appendChild(typeof k === 'string' ? document.createTextNode(k) : k));
    return el;
  }
  function niceTicks(min, max, n) {
    const span = max - min || 1;
    const step0 = span / Math.max(1, n);
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const norm = step0 / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  }
  const fmt = (v) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-GB') : Number.isInteger(v) ? String(v) : (+v.toFixed(2)).toString());

  /**
   * Line chart.
   * opts: { series:[{name, color?, points:[[x,y],...], dash?}], xLabel, yLabel, yMin, yMax,
   *         bands:[{from,to,color,label}], xFormat, height, labels:true }
   */
  function lineChart(container, opts) {
    container.innerHTML = '';
    const W = 640, H = opts.height || 300, M = { l: 52, r: opts.labels === false ? 16 : 70, t: 14, b: 44 };
    const all = opts.series.flatMap((se) => se.points);
    const xs = all.map((p) => p[0]);
    const ys = all.map((p) => p[1]);
    const x0 = opts.xMin != null ? opts.xMin : Math.min(...xs), x1 = opts.xMax != null ? opts.xMax : Math.max(...xs);
    const y0 = opts.yMin != null ? opts.yMin : Math.min(0, ...ys), y1 = opts.yMax != null ? opts.yMax : Math.max(...ys) * 1.05 || 1;
    const X = (v) => M.l + ((v - x0) / (x1 - x0 || 1)) * (W - M.l - M.r);
    const Y = (v) => H - M.b - ((v - y0) / (y1 - y0 || 1)) * (H - M.t - M.b);
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': opts.title || 'chart' });
    // bands (status backgrounds)
    (opts.bands || []).forEach((b) => {
      const ya = Y(Math.min(b.to, y1)), yb = Y(Math.max(b.from, y0));
      svg.appendChild(s('rect', { x: M.l, y: ya, width: W - M.l - M.r, height: Math.max(0, yb - ya), fill: b.color, 'fill-opacity': 0.12 }));
      if (b.label) svg.appendChild(s('text', { x: W - M.r + 6, y: (ya + yb) / 2 + 4, class: 'ch-band', fill: INK.secondary }, b.label));
    });
    // grid + y axis
    niceTicks(y0, y1, 5).forEach((t) => {
      svg.appendChild(s('line', { x1: M.l, x2: W - M.r, y1: Y(t), y2: Y(t), stroke: INK.grid, 'stroke-width': 1 }));
      svg.appendChild(s('text', { x: M.l - 8, y: Y(t) + 4, 'text-anchor': 'end', class: 'ch-tick' }, fmt(t)));
    });
    const xt = opts.xTicks || niceTicks(x0, x1, 8);
    xt.forEach((t) => svg.appendChild(s('text', { x: X(t), y: H - M.b + 16, 'text-anchor': 'middle', class: 'ch-tick' }, opts.xFormat ? opts.xFormat(t) : fmt(t))));
    svg.appendChild(s('line', { x1: M.l, x2: W - M.r, y1: Y(y0), y2: Y(y0), stroke: INK.axis, 'stroke-width': 1 }));
    if (opts.xLabel) svg.appendChild(s('text', { x: (M.l + W - M.r) / 2, y: H - 8, 'text-anchor': 'middle', class: 'ch-axis' }, opts.xLabel));
    if (opts.yLabel) svg.appendChild(s('text', { x: 14, y: (M.t + H - M.b) / 2, transform: `rotate(-90 14 ${(M.t + H - M.b) / 2})`, 'text-anchor': 'middle', class: 'ch-axis' }, opts.yLabel));
    // series
    opts.series.forEach((se, i) => {
      const col = se.color || SERIES[i % SERIES.length];
      const d = se.points.map((p, k) => (k ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1)).join(' ');
      svg.appendChild(s('path', { d, fill: 'none', stroke: col, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'stroke-dasharray': se.dash || null }));
      if (opts.labels !== false && se.points.length) {
        const last = se.points[se.points.length - 1];
        svg.appendChild(s('circle', { cx: X(last[0]), cy: Y(last[1]), r: 4, fill: col, stroke: INK.surface, 'stroke-width': 2 }));
        svg.appendChild(s('text', { x: X(last[0]) + 8, y: Y(last[1]) + 4, class: 'ch-label' }, se.short || se.name));
      }
    });
    const wrap = h('div.chart-wrap');
    wrap.appendChild(svg);
    if (opts.series.length > 1) wrap.appendChild(legend(opts.series.map((se, i) => ({ name: se.name, color: se.color || SERIES[i % SERIES.length], dash: se.dash }))));
    crosshair(wrap, svg, { X, Y, M, W, H, x0, x1, series: opts.series, xFormat: opts.xFormat, xName: opts.xLabel, yFmt: opts.yFormat });
    wrap.appendChild(tableView(opts));
    container.appendChild(wrap);
    return wrap;
  }

  /** FastQC-style per-position box plot */
  function boxChart(container, opts) {
    container.innerHTML = '';
    const W = 640, H = opts.height || 300, M = { l: 52, r: 96, t: 14, b: 44 };
    const rows = opts.rows; // [{label, lo10, q1, med, q3, hi90, mean}]
    const y0 = opts.yMin != null ? opts.yMin : 0, y1 = opts.yMax != null ? opts.yMax : 41;
    const n = rows.length;
    const band = (W - M.l - M.r) / n;
    const X = (i) => M.l + band * (i + 0.5);
    const Y = (v) => H - M.b - ((v - y0) / (y1 - y0)) * (H - M.t - M.b);
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': opts.title || 'box plot' });
    (opts.bands || []).forEach((b) => {
      const ya = Y(Math.min(b.to, y1)), yb = Y(Math.max(b.from, y0));
      svg.appendChild(s('rect', { x: M.l, y: ya, width: W - M.l - M.r, height: Math.max(0, yb - ya), fill: b.color, 'fill-opacity': 0.13 }));
      if (b.label) svg.appendChild(s('text', { x: W - M.r + 6, y: (ya + yb) / 2 + 4, class: 'ch-band' }, b.label));
    });
    niceTicks(y0, y1, 6).forEach((t) => {
      svg.appendChild(s('line', { x1: M.l, x2: W - M.r, y1: Y(t), y2: Y(t), stroke: INK.grid, 'stroke-width': 1 }));
      svg.appendChild(s('text', { x: M.l - 8, y: Y(t) + 4, 'text-anchor': 'end', class: 'ch-tick' }, fmt(t)));
    });
    const bw = Math.min(10, band * 0.62);
    const box = SERIES[0];
    rows.forEach((r, i) => {
      const cx = X(i);
      svg.appendChild(s('line', { x1: cx, x2: cx, y1: Y(r.lo10), y2: Y(r.hi90), stroke: INK.secondary, 'stroke-width': 1 }));
      svg.appendChild(s('rect', { x: cx - bw / 2, y: Y(r.q3), width: bw, height: Math.max(1, Y(r.q1) - Y(r.q3)), fill: box, 'fill-opacity': 0.28, stroke: box, 'stroke-width': 1, rx: 1.5 }));
      svg.appendChild(s('line', { x1: cx - bw / 2, x2: cx + bw / 2, y1: Y(r.med), y2: Y(r.med), stroke: INK.primary, 'stroke-width': 1.5 }));
      if (i % Math.ceil(n / 12) === 0 || i === n - 1) svg.appendChild(s('text', { x: cx, y: H - M.b + 16, 'text-anchor': 'middle', class: 'ch-tick' }, r.label));
    });
    // mean line
    const mean = rows.map((r, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(r.mean).toFixed(1)).join(' ');
    svg.appendChild(s('path', { d: mean, fill: 'none', stroke: SERIES[1], 'stroke-width': 2, 'stroke-linejoin': 'round' }));
    svg.appendChild(s('line', { x1: M.l, x2: W - M.r, y1: Y(y0), y2: Y(y0), stroke: INK.axis }));
    if (opts.xLabel) svg.appendChild(s('text', { x: (M.l + W - M.r) / 2, y: H - 8, 'text-anchor': 'middle', class: 'ch-axis' }, opts.xLabel));
    if (opts.yLabel) svg.appendChild(s('text', { x: 14, y: (M.t + H - M.b) / 2, transform: `rotate(-90 14 ${(M.t + H - M.b) / 2})`, 'text-anchor': 'middle', class: 'ch-axis' }, opts.yLabel));
    const wrap = h('div.chart-wrap');
    wrap.appendChild(svg);
    wrap.appendChild(legend([{ name: 'Middle 50% of reads (box)', color: box, box: true }, { name: 'Median', color: INK.primary }, { name: 'Mean', color: SERIES[1] }, { name: '10th–90th percentile (whisker)', color: INK.secondary, thin: true }]));
    // hover: one tooltip per position
    const tip = h('div.ch-tip', { hidden: true });
    wrap.appendChild(tip);
    const hit = s('rect', { x: M.l, y: M.t, width: W - M.l - M.r, height: H - M.t - M.b, fill: 'transparent' });
    svg.appendChild(hit);
    const guide = s('line', { y1: M.t, y2: H - M.b, stroke: INK.muted, 'stroke-width': 1, visibility: 'hidden' });
    svg.appendChild(guide);
    hit.addEventListener('pointermove', (e) => {
      const pt = svgPoint(svg, e);
      const i = Math.max(0, Math.min(n - 1, Math.floor((pt.x - M.l) / band)));
      const r = rows[i];
      guide.setAttribute('x1', X(i));
      guide.setAttribute('x2', X(i));
      guide.setAttribute('visibility', 'visible');
      tip.hidden = false;
      tip.innerHTML = '';
      tip.appendChild(h('div.ch-tip-h', (opts.xName || 'Position') + ' ' + r.label));
      [['Median', r.med], ['Mean', r.mean.toFixed(1)], ['Middle 50%', `${r.q1}–${r.q3}`], ['10th–90th', `${r.lo10}–${r.hi90}`]].forEach(([k, v]) => tip.appendChild(h('div.ch-tip-r', h('b', String(v)), h('span', ' ' + k))));
      placeTip(tip, wrap, e);
    });
    hit.addEventListener('pointerleave', () => {
      tip.hidden = true;
      guide.setAttribute('visibility', 'hidden');
    });
    wrap.appendChild(tableView({ columns: ['Position', 'Mean', 'Median', 'Lower quartile', 'Upper quartile', '10th percentile', '90th percentile'], rows: rows.map((r) => [r.label, r.mean.toFixed(1), r.med, r.q1, r.q3, r.lo10, r.hi90]) }));
    container.appendChild(wrap);
    return wrap;
  }

  /** horizontal bar chart: [{label, value, note, color}] */
  function barChart(container, opts) {
    container.innerHTML = '';
    const rows = opts.rows;
    const W = 640, rowH = 30, M = { l: opts.labelWidth || 190, r: 70, t: 8, b: 26 };
    const H = M.t + M.b + rows.length * rowH;
    const max = opts.max || Math.max(...rows.map((r) => r.value)) || 1;
    const X = (v) => M.l + (opts.log ? Math.log10(v + 1) / Math.log10(max + 1) : v / max) * (W - M.l - M.r);
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': opts.title || 'bar chart' });
    rows.forEach((r, i) => {
      const y = M.t + i * rowH + (rowH - Math.min(22, rowH - 8)) / 2;
      const bh = Math.min(22, rowH - 8);
      const w = Math.max(2, X(r.value) - M.l);
      const col = r.color || opts.color || SERIES[0];
      const g = s('g', { class: 'ch-bar', tabindex: 0 });
      g.appendChild(s('text', { x: M.l - 10, y: y + bh / 2 + 4, 'text-anchor': 'end', class: 'ch-cat' }, r.label));
      g.appendChild(s('path', { d: roundedBar(M.l, y, w, bh, 4), fill: col }));
      g.appendChild(s('text', { x: M.l + w + 8, y: y + bh / 2 + 4, class: 'ch-val' }, r.valueLabel || fmt(r.value)));
      if (r.note) g.appendChild(s('title', null, r.note));
      svg.appendChild(g);
    });
    svg.appendChild(s('line', { x1: M.l, x2: M.l, y1: M.t - 2, y2: H - M.b + 4, stroke: INK.axis }));
    const wrap = h('div.chart-wrap', svg);
    wrap.appendChild(tableView({ columns: [opts.catName || 'Category', opts.valName || 'Value'], rows: rows.map((r) => [r.label, r.valueLabel || fmt(r.value)]) }));
    container.appendChild(wrap);
    return wrap;
  }
  function roundedBar(x, y, w, hgt, r) {
    r = Math.min(r, w / 2, hgt / 2);
    return `M${x} ${y} H${x + w - r} Q${x + w} ${y} ${x + w} ${y + r} V${y + hgt - r} Q${x + w} ${y + hgt} ${x + w - r} ${y + hgt} H${x} Z`;
  }

  function legend(items) {
    const L = h('div.ch-legend');
    items.forEach((it) => {
      const key = h('span.ch-key' + (it.box ? '.box' : '') + (it.thin ? '.thin' : ''));
      key.style.setProperty('--c', it.color);
      if (it.dash) key.classList.add('dash');
      L.appendChild(h('span.ch-li', key, document.createTextNode(it.name)));
    });
    return L;
  }
  function svgPoint(svg, e) {
    const r = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    return { x: ((e.clientX - r.left) / r.width) * vb.width, y: ((e.clientY - r.top) / r.height) * vb.height };
  }
  function placeTip(tip, wrap, e) {
    const r = wrap.getBoundingClientRect();
    let x = e.clientX - r.left + 14, y = e.clientY - r.top + 10;
    const tw = tip.offsetWidth || 160;
    if (x + tw > r.width) x = e.clientX - r.left - tw - 14;
    tip.style.left = Math.max(4, x) + 'px';
    tip.style.top = Math.max(4, y) + 'px';
  }
  function crosshair(wrap, svg, g) {
    const tip = h('div.ch-tip', { hidden: true });
    wrap.appendChild(tip);
    const guide = s('line', { y1: g.M.t, y2: g.H - g.M.b, stroke: INK.muted, 'stroke-width': 1, visibility: 'hidden' });
    svg.appendChild(guide);
    const hit = s('rect', { x: g.M.l, y: g.M.t, width: g.W - g.M.l - g.M.r, height: g.H - g.M.t - g.M.b, fill: 'transparent' });
    svg.appendChild(hit);
    const xsAll = Array.from(new Set(g.series.flatMap((se) => se.points.map((p) => p[0])))).sort((a, b) => a - b);
    hit.addEventListener('pointermove', (e) => {
      const pt = svgPoint(svg, e);
      const xv = g.x0 + ((pt.x - g.M.l) / (g.W - g.M.l - g.M.r)) * (g.x1 - g.x0);
      let best = xsAll[0];
      xsAll.forEach((x) => {
        if (Math.abs(x - xv) < Math.abs(best - xv)) best = x;
      });
      guide.setAttribute('x1', g.X(best));
      guide.setAttribute('x2', g.X(best));
      guide.setAttribute('visibility', 'visible');
      tip.hidden = false;
      tip.innerHTML = '';
      tip.appendChild(h('div.ch-tip-h', (g.xName ? g.xName + ': ' : '') + (g.xFormat ? g.xFormat(best) : fmt(best))));
      g.series.forEach((se, i) => {
        const p = se.points.find((q) => q[0] === best);
        if (!p) return;
        const key = h('span.ch-key.line');
        key.style.setProperty('--c', se.color || SERIES[i % SERIES.length]);
        tip.appendChild(h('div.ch-tip-r', key, h('b', g.yFmt ? g.yFmt(p[1]) : fmt(p[1])), h('span', ' ' + se.name)));
      });
      placeTip(tip, wrap, e);
    });
    hit.addEventListener('pointerleave', () => {
      tip.hidden = true;
      guide.setAttribute('visibility', 'hidden');
    });
  }
  function tableView(opts) {
    const d = h('details.ch-table');
    d.appendChild(h('summary', 'Show the numbers as a table'));
    const t = h('table.table.small');
    let cols = opts.columns, rows = opts.rows;
    if (!cols && opts.series) {
      const xs = Array.from(new Set(opts.series.flatMap((se) => se.points.map((p) => p[0])))).sort((a, b) => a - b);
      cols = [opts.xLabel || 'x'].concat(opts.series.map((se) => se.name));
      rows = xs.map((x) => [opts.xFormat ? opts.xFormat(x) : fmt(x)].concat(opts.series.map((se) => {
        const p = se.points.find((q) => q[0] === x);
        return p ? fmt(p[1]) : '';
      })));
    }
    t.appendChild(h('tr', ...cols.map((c) => h('th', String(c)))));
    rows.slice(0, 400).forEach((r) => t.appendChild(h('tr', ...r.map((c) => h('td', String(c))))));
    d.appendChild(h('div.ch-table-scroll', t));
    return d;
  }

  MG.charts = { lineChart, boxChart, barChart, legend, SERIES, STATUS, INK, niceTicks };
})();
