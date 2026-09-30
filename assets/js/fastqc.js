/* =====================================================================
   FastQC report viewer. Renders the modules of a real FastQC run
   (converted from fastqc_data.txt to JSON) with explanations.
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const { h, esc } = MG;

  const HELP = {
    'Basic Statistics': 'The basics: how many reads, how long they are, and the quality-score encoding (Sanger / Illumina 1.9 = Phred+33).',
    'Per base sequence quality': 'For every position along the reads, the spread of quality scores across all reads. Quality usually falls towards the end of Illumina reads as the clusters get out of step (phasing). FastQC warns if any lower quartile is below 10 or median below 25, and fails if a lower quartile is below 5 or a median below 20.',
    'Per tile sequence quality': 'Quality per flow-cell tile. Problems here point to a bubble or dirt on part of the flow cell.',
    'Per sequence quality scores': 'The mean quality of each whole read. A small bump of poor reads is normal; most reads should average well above 30.',
    'Per base sequence content': 'The % of A, C, G and T at each position. For random DNA the four lines are roughly flat and parallel. Wobbles in the first few bases are common in Illumina libraries (random-hexamer priming or fragmentation bias).',
    'Per sequence GC content': 'The GC% of each read compared with a normal curve. A second peak can mean contamination from another organism; exome libraries often have a slightly broader curve.',
    'Per base N content': 'How often the sequencer could not call a base (N) at each position.',
    'Sequence Length Distribution': 'Read lengths. Here every read is the same length because nothing has been trimmed yet.',
    'Sequence Duplication Levels': 'How many reads are exact copies of each other. Some duplication is expected in exome data (PCR amplification and very deep coverage of the same targets).',
    'Overrepresented sequences': 'Sequences making up more than 0.1% of all reads – typically adapters or contamination.',
    'Adapter Content': 'The cumulative % of reads containing adapter sequence at each position. Rising adapter content means fragments shorter than the read length, which should be trimmed.'
  };

  const STATUS_LABEL = { pass: 'Pass', warn: 'Warning', fail: 'Fail' };

  function statusBadge(st) {
    const cls = st === 'pass' ? 'ok' : st === 'warn' ? 'warn' : 'fail';
    const icon = st === 'pass' ? '✓' : st === 'warn' ? '!' : '✗';
    return h('span.fq-badge.' + cls, h('b', icon), document.createTextNode(STATUS_LABEL[st] || st));
  }

  class FastQCView {
    constructor(root) {
      this.root = root;
      this.reports = new Map();
      this.root.classList.add('fq-root');
      this.bar = h('div.fq-bar');
      this.body = h('div.fq-body');
      this.root.append(this.bar, this.body);
      this.empty();
    }
    empty() {
      this.bar.innerHTML = '';
      this.body.innerHTML = '';
      this.body.appendChild(h('div.ex-empty', h('h3', 'No report open yet'), h('p', { html: 'Run <code>fastqc</code> in the terminal (or the FastQC tool in the workflow engine), then open the report – e.g. <code>open results/NA12878_chr10_R1_fastqc.html</code>.' })));
    }
    async load(name, url) {
      if (!this.reports.has(name)) {
        const data = await MG.fetchJSON(url);
        this.reports.set(name, data);
      }
      this.show(name);
    }
    show(name) {
      const data = this.reports.get(name);
      if (!data) return;
      this.current = name;
      this.renderBar();
      this.render(data);
      MG.bus.emit('fastqc:open', { name, file: data.file });
    }
    renderBar() {
      this.bar.innerHTML = '';
      this.bar.appendChild(h('span.fq-title', { html: MG.icon('image') + ' FastQC report' }));
      const sel = h('div.seg');
      this.reports.forEach((d, n) => {
        const b = h('button' + (n === this.current ? '.on' : ''), { type: 'button' }, d.file.replace(/\.fastq\.gz$/, ''));
        b.addEventListener('click', () => this.show(n));
        sel.appendChild(b);
      });
      this.bar.appendChild(sel);
    }
    render(d) {
      const B = this.body;
      B.innerHTML = '';
      B.scrollTop = 0;
      const mods = d.modules;
      const basic = mods.find((m) => m.name === 'Basic Statistics');
      const head = h('div.fq-head', h('h3', d.file), h('p.muted', `FastQC ${d.version || ''} · ${basic ? (basic.rows.find((r) => r[0] === 'Total Sequences') || [])[1] : ''} reads`));
      B.appendChild(head);
      // summary
      const sum = h('div.fq-summary');
      mods.forEach((m) => {
        const a = h('a.fq-sum', { href: '#', dataset: { mod: m.name } }, statusBadge(m.status), h('span', m.name));
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const t = B.querySelector(`[data-module="${CSS.escape(m.name)}"]`);
          if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        sum.appendChild(a);
      });
      B.appendChild(sum);
      mods.forEach((m) => {
        const sec = h('section.fq-mod', { dataset: { module: m.name } });
        sec.appendChild(h('div.fq-mod-h', statusBadge(m.status), h('h4', m.name)));
        if (HELP[m.name]) sec.appendChild(h('p.fq-help', HELP[m.name]));
        const plot = h('div.fq-plot');
        sec.appendChild(plot);
        try {
          this.module(m, plot, d);
        } catch (e) {
          console.error(e);
          plot.appendChild(h('p.muted', 'This module could not be drawn.'));
        }
        B.appendChild(sec);
      });
    }
    module(m, el, d) {
      const C = MG.charts;
      const num = (v) => parseFloat(v);
      const labelNum = (lab) => {
        const p = String(lab).split('-').map(Number);
        return p.length === 2 ? (p[0] + p[1]) / 2 : p[0];
      };
      switch (m.name) {
        case 'Basic Statistics': {
          const t = h('table.table.small');
          m.rows.forEach((r) => t.appendChild(h('tr', h('th', r[0]), h('td', r[1]))));
          el.appendChild(t);
          break;
        }
        case 'Per base sequence quality': {
          const rows = m.rows.map((r) => ({ label: r[0], mean: num(r[1]), med: num(r[2]), q1: num(r[3]), q3: num(r[4]), lo10: num(r[5]), hi90: num(r[6]) }));
          C.boxChart(el, {
            rows,
            yMin: 0,
            yMax: Math.max(41, ...rows.map((r) => r.hi90)) + 1,
            xLabel: 'Position in read (bp)',
            yLabel: 'Phred quality score',
            xName: 'Position',
            title: 'Quality scores across all bases',
            bands: [
              { from: 28, to: 99, color: C.STATUS.good, label: 'Very good' },
              { from: 20, to: 28, color: C.STATUS.warning, label: 'Reasonable' },
              { from: 0, to: 20, color: C.STATUS.critical, label: 'Poor' }
            ]
          });
          break;
        }
        case 'Per sequence quality scores': {
          C.lineChart(el, { series: [{ name: 'Reads', points: m.rows.map((r) => [num(r[0]), num(r[1])]) }], xLabel: 'Mean quality of the read (Phred)', yLabel: 'Number of reads', labels: false, title: 'Per sequence quality' });
          break;
        }
        case 'Per base sequence content': {
          // columns: Base G A T C
          const idx = { A: m.cols.indexOf('A'), C: m.cols.indexOf('C'), G: m.cols.indexOf('G'), T: m.cols.indexOf('T') };
          const series = ['A', 'C', 'G', 'T'].map((b) => ({ name: '% ' + b, short: b, points: m.rows.map((r) => [labelNum(r[0]), num(r[idx[b]])]) }));
          C.lineChart(el, { series, xLabel: 'Position in read (bp)', yLabel: '% of reads', yMin: 0, yMax: 60, xName: 'Position', title: 'Sequence content across all bases' });
          break;
        }
        case 'Per sequence GC content': {
          const pts = m.rows.map((r) => [num(r[0]), num(r[1])]);
          const total = pts.reduce((s, p) => s + p[1], 0) || 1;
          const mean = pts.reduce((s, p) => s + p[0] * p[1], 0) / total;
          const sd = Math.sqrt(pts.reduce((s, p) => s + (p[0] - mean) ** 2 * p[1], 0) / total);
          const theo = pts.map((p) => [p[0], (total / (sd * Math.sqrt(2 * Math.PI))) * Math.exp(-((p[0] - mean) ** 2) / (2 * sd * sd))]);
          C.lineChart(el, { series: [{ name: 'GC count per read', short: 'Observed', points: pts }, { name: 'Theoretical distribution', short: 'Theoretical', points: theo, dash: '5 4' }], xLabel: 'Mean GC content (%)', yLabel: 'Number of reads', title: 'GC distribution' });
          break;
        }
        case 'Per base N content': {
          C.lineChart(el, { series: [{ name: '% N', points: m.rows.map((r) => [labelNum(r[0]), num(r[1])]) }], xLabel: 'Position in read (bp)', yLabel: '% N', yMin: 0, yMax: 100, labels: false, title: 'N content across all bases' });
          break;
        }
        case 'Sequence Length Distribution': {
          const t = h('table.table.small', h('tr', h('th', 'Read length (bp)'), h('th', 'Number of reads')));
          m.rows.forEach((r) => t.appendChild(h('tr', h('td', r[0]), h('td', Number(r[1]).toLocaleString('en-GB')))));
          el.appendChild(t);
          break;
        }
        case 'Sequence Duplication Levels': {
          const labels = m.rows.map((r) => r[0]);
          const pts = m.rows.map((r, i) => [i, num(r[1])]);
          el.appendChild(h('p.muted', `Percent of reads that would remain if duplicates were removed: ${(+m.extra.dedup).toFixed(1)}%`));
          const div = h('div');
          el.appendChild(div);
          C.lineChart(div, { series: [{ name: '% of total reads', points: pts }], xLabel: 'Sequence duplication level (copies)', yLabel: '% of reads', yMin: 0, yMax: 100, labels: false, xTicks: pts.map((p) => p[0]), xFormat: (i) => labels[i] || '', xName: 'Duplication level', title: 'Duplication levels' });
          break;
        }
        case 'Overrepresented sequences': {
          if (!m.rows.length) el.appendChild(h('p', 'No overrepresented sequences.'));
          else {
            const t = h('table.table.small', h('tr', ...m.cols.map((c) => h('th', c))));
            m.rows.forEach((r) => t.appendChild(h('tr', ...r.map((c) => h('td', c)))));
            el.appendChild(t);
          }
          break;
        }
        case 'Adapter Content': {
          const names = m.cols.slice(1);
          const series = names.map((n, i) => ({ name: n, short: n.replace(/ Adapter| Sequence|'/g, '').slice(0, 14), points: m.rows.map((r) => [labelNum(r[0]), num(r[i + 1])]) }));
          C.lineChart(el, { series: series.slice(0, 4), xLabel: 'Position in read (bp)', yLabel: '% of reads', yMin: 0, yMax: 100, title: 'Adapter content' });
          break;
        }
        default: {
          el.appendChild(h('p.muted', 'Not shown in this viewer.'));
        }
      }
    }
  }

  MG.FastQCView = FastQCView;
})();
