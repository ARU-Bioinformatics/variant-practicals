/* =====================================================================
   Proteins in 3D – UniProt explorer (uses the UniProt REST API live;
   falls back to stored copies of the tutorial entries if offline)
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const { h, esc, bus, toast } = MG;
  const API = 'https://rest.uniprot.org/uniprotkb/';
  const FIELDS = 'accession,id,reviewed,protein_name,gene_names,organism_name,organism_id,length,annotation_score';
  const cache = (MG.uniprotCache = MG.uniprotCache || {});

  const SECTIONS = [
    ['function', 'Function'],
    ['names', 'Names & Taxonomy'],
    ['location', 'Subcellular Location'],
    ['disease', 'Disease & Variants'],
    ['ptm', 'PTM / Processing'],
    ['expression', 'Expression'],
    ['interaction', 'Interaction'],
    ['structure', 'Structure'],
    ['family', 'Family & Domains'],
    ['sequence', 'Sequence & Isoforms']
  ];

  const linkify = (text) =>
    esc(text)
      .replace(/PubMed:(\d+)/g, '<a class="pmid" href="https://pubmed.ncbi.nlm.nih.gov/$1/" target="_blank" rel="noopener">PubMed:$1</a>')
      .replace(/\b(ECO:\d+)\b/g, '<span class="muted">$1</span>');
  const ext = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)} ↗</a>`;
  const txt = (c) => (c.texts || []).map((t) => t.value).join(' ');

  function evidenceTag(evs) {
    if (!evs || !evs.length) return '';
    const pm = evs.filter((e) => e.source === 'PubMed').map((e) => e.id);
    const sim = evs.some((e) => e.evidenceCode === 'ECO:0000250');
    const bits = [];
    if (pm.length) bits.push(`<a class="pmid" href="https://pubmed.ncbi.nlm.nih.gov/${pm[0]}/" target="_blank" rel="noopener">${pm.length} publication${pm.length > 1 ? 's' : ''}</a>`);
    if (sim) bits.push('<span class="muted">by similarity</span>');
    return bits.length ? ' <small>(' + bits.join(', ') + ')</small>' : '';
  }

  async function getEntry(acc) {
    acc = acc.toUpperCase();
    if (cache[acc]) return cache[acc];
    const bundled = (MG.config.bundled.uniprot || {})[acc];
    const tasks = [() => MG.fetchJSON(API + encodeURIComponent(acc) + '.json', {}, 25000)];
    if (bundled) tasks.push(() => MG.fetchJSON(bundled));
    const d = await MG.firstOk(tasks);
    if (!d || !d.primaryAccession) throw new Error('No UniProt entry ' + acc);
    cache[acc] = d;
    if (d.primaryAccession !== acc) cache[d.primaryAccession] = d;
    return d;
  }
  MG.uniprotEntry = getEntry;

  const protName = (d) => {
    const pd = d.proteinDescription || {};
    return (pd.recommendedName && pd.recommendedName.fullName.value) || (pd.submissionNames && pd.submissionNames[0].fullName.value) || '';
  };
  const geneName = (d) => ((d.genes || [])[0] && d.genes[0].geneName ? d.genes[0].geneName.value : '');

  /* =============== mapping UniProt positions onto loaded structures =============== */
  function pdbChainsFor(d, pdbId) {
    const x = (d.uniProtKBCrossReferences || []).find((r) => r.database === 'PDB' && r.id.toUpperCase() === pdbId.toUpperCase());
    if (!x) return null;
    const ch = (x.properties || []).find((p) => p.key === 'Chains');
    if (!ch) return null;
    const out = new Set();
    ch.value.split(/,\s*/).forEach((part) => part.split('=')[0].split('/').forEach((c) => out.add(c.trim())));
    return Array.from(out);
  }
  function candidates(d) {
    const V = MG.app.viewer;
    const acc = d.primaryAccession;
    const out = [];
    V.structures.forEach((st) => {
      if (st.kind === 'alphafold') {
        const a = ((st.af && st.af.uniprotAccession) || st.source.acc || '').toUpperCase();
        if (a === acc) st.chains.filter((c) => c.type === 'protein').forEach((c) => out.push({ st, chain: c.name }));
      } else if (st.kind === 'pdb') {
        const chains = pdbChainsFor(d, st.source.id);
        if (chains) chains.forEach((c) => st.chains.find((x) => x.name === c) && out.push({ st, chain: c }));
      } else {
        st.chains.filter((c) => c.type === 'protein').forEach((c) => out.push({ st, chain: c.name, test: true }));
      }
    });
    return out;
  }
  const mapCache = new Map();
  function mapChain(d, st, chainName) {
    const key = st.uid + '|' + chainName + '|' + d.primaryAccession + '|' + (st.transformed ? 't' : '');
    if (mapCache.has(key)) return mapCache.get(key);
    const ch = st.chains.find((c) => c.name === chainName);
    const res = ch.residues.map((ri) => st.residues[ri]).filter((r) => r.prot);
    const seq = res.map((r) => r.one).join('');
    const ali = MG.align(d.sequence.value, seq);
    const pos2res = new Map();
    ali.pairs.forEach(([i, j]) => pos2res.set(i + 1, res[j].i));
    const out = { pos2res, identity: ali.identity, n: ali.pairs.length, first: res.length ? res[0].resno : 0, last: res.length ? res[res.length - 1].resno : 0 };
    mapCache.set(key, out);
    return out;
  }

  /** Highlight UniProt positions (ranges) on whichever loaded structure(s) contain this protein */
  async function show3D(d, ranges, label, opts = {}) {
    const V = MG.app.viewer;
    let cands = candidates(d);
    let found = [];
    const tryMap = () => {
      found = [];
      cands.forEach((c) => {
        const m = mapChain(d, c.st, c.chain);
        if (c.test && (m.identity < 0.9 || m.n < 20)) return;
        const idx = [];
        let hits = 0;
        ranges.forEach(([a, b]) => {
          for (let p = a; p <= b; p++) {
            const ri = m.pos2res.get(p);
            if (ri === undefined) continue;
            hits++;
            const r = c.st.residues[ri];
            for (let x = r.a0; x < r.a0 + r.na; x++) idx.push(x);
          }
        });
        if (idx.length) found.push({ st: c.st, chain: c.chain, idx, hits });
      });
    };
    tryMap();
    if (!found.length) {
      const total = ranges.reduce((s, [a, b]) => s + b - a + 1, 0);
      const covering = cands.length ? cands.map((c) => `${c.st.name} chain ${c.chain}`).join(', ') : '';
      const html = covering
        ? `<p>Residue${total > 1 ? 's' : ''} ${ranges.map(([a, b]) => (a === b ? a : a + '–' + b)).join(', ')} (${esc(label)}) ${total > 1 ? 'are' : 'is'} not in the structure currently loaded (${esc(covering)}). Experimental structures often contain only part of a protein.</p><p>The AlphaFold model covers the whole sequence.</p>`
        : `<p>No structure of ${esc(protName(d))} is loaded in the 3D viewer yet.</p>`;
      const choice = await new Promise((resolve) => {
        const m = MG.modal('Show in 3D', html + '<div class="prompt-actions"><button class="btn" data-a="no" type="button">Cancel</button><button class="btn primary" data-a="af" type="button">Load AlphaFold model</button></div>', { onClose: () => resolve('no') });
        m.box.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => {
          resolve(b.dataset.a);
          m.close();
        }));
      });
      if (choice !== 'af') return;
      try {
        await MG.app.vui.run('load af ' + d.primaryAccession);
      } catch (e) {
        return;
      }
      cands = candidates(d);
      tryMap();
      if (!found.length) return toast('Could not find those residues in the model.', 'warn');
    }
    MG.app.showWorkbench('viewer');
    const m = new Map();
    found.forEach((f) => m.set(f.st, (m.get(f.st) || []).concat(f.idx)));
    // make sure they are visible
    m.forEach((idx, st) => {
      let hidden = 0;
      idx.forEach((i) => (hidden += st.hidden[i]));
      if (hidden) V.setVisible(new Map([[st, idx]]), true);
    });
    const nres = found.reduce((s, f) => s + f.hits, 0) / found.length;
    if (nres <= 16 || opts.sticks) V.show('sticks', m);
    V.select(m, 'set');
    V.centerOn(m.size === 1 ? Array.from(m.values())[0] : m, m.size === 1 ? Array.from(m.keys())[0] : undefined);
    const where = found.map((f) => `${f.st.name} ${f.chain}`).join(', ');
    MG.app.vui.log(`# ${label}: UniProt ${ranges.map(([a, b]) => (a === b ? a : a + '-' + b)).join(',')} → ${where}`);
    toast(`<b>${esc(label)}</b> selected on ${esc(where)}`, 'ok');
    bus.emit('uniprot:show3d', { acc: d.primaryAccession, label, ranges });
  }
  MG.uniprotShow3D = async (acc, ranges, label, opts) => show3D(await getEntry(acc), ranges, label, opts);

  /* =============== feature tracks =============== */
  const FCOL = {
    Signal: '#9b59b6', 'Topological domain': '#8fb9d9', Transmembrane: '#e67e22', Intramembrane: '#d35400', Chain: '#bdc3c7',
    Domain: '#2e86c1', Repeat: '#48c9b0', Region: '#aab7b8', Motif: '#f1c40f', 'Coiled coil': '#16a085', 'Zinc finger': '#7d3c98',
    'Compositional bias': '#f5b041', Glycosylation: '#1e8449', 'Disulfide bond': '#d4ac0d', 'Modified residue': '#c0392b',
    Lipidation: '#a04000', 'Cross-link': '#6c3483', 'Natural variant': '#e74c3c', Mutagenesis: '#8e44ad', 'Binding site': '#e84393',
    'Active site': '#c0392b', Site: '#566573', Propeptide: '#b2babb', 'Transit peptide': '#7f8c8d'
  };
  function trackSet(d, groups, opts = {}) {
    const L = d.sequence.length;
    const wrap = h('div.track-wrap');
    const grid = h('div.track');
    const pct = (p) => ((p - 1) / L) * 100;
    const axis = h('div.axis');
    const step = L > 1500 ? 250 : L > 600 ? 100 : L > 250 ? 50 : 25;
    for (let p = step; p < L; p += step) axis.appendChild(h('span', { style: { left: pct(p) + '%' } }, p));
    axis.appendChild(h('span', { style: { left: '100%' } }, L));
    grid.append(h('div.tl', ''), axis);
    groups.forEach((g) => {
      if (!g.items.length && !g.always) return;
      const tb = h('div.tb', h('div.line'));
      g.items.forEach((f) => {
        const a = f.start, b = f.end;
        const tip = `${f.label} · ${a === b ? a : a + '–' + b}${f.note ? ' · ' + f.note : ''}`;
        let el;
        if (f.pin || b - a < 2) el = h('span.pin', { style: { left: pct(a) + '%', background: f.color }, title: tip + ' (click to show in 3D)' });
        else el = h('span.seg', { style: { left: pct(a) + '%', width: Math.max(0.6, ((b - a + 1) / L) * 100) + '%', background: f.color }, title: tip + ' (click to show in 3D)' }, f.short || '');
        el.addEventListener('click', () => (f.onClick ? f.onClick() : show3D(d, f.ranges || [[a, b]], f.label)));
        tb.appendChild(el);
      });
      grid.append(h('div.tl', { title: g.name }, g.name), tb);
    });
    wrap.appendChild(grid);
    if (opts.caption) wrap.appendChild(h('p.hint', opts.caption));
    return wrap;
  }
  const feats = (d, types) => (d.features || []).filter((f) => types.includes(f.type));
  const loc = (f) => [f.location.start.value, f.location.end.value];

  function featureTable(d, list, cols) {
    if (!list.length) return h('p.muted', 'None annotated.');
    const t = h('table.ftable');
    t.appendChild(h('tr', ...cols.map((c) => h('th', c[0])), h('th', '')));
    list.forEach((f) => {
      const [a, b] = loc(f);
      const row = h('tr.clickable', { title: 'Click to show in the 3D viewer' });
      cols.forEach((c) => {
        const td = h('td' + (c[2] ? '.' + c[2] : ''));
        td.innerHTML = c[1](f, a, b);
        row.appendChild(td);
      });
      const b3 = h('button.show3d', { type: 'button' }, 'Show in 3D');
      row.appendChild(h('td', b3));
      row.addEventListener('click', (e) => {
        if (e.target.closest('a')) return;
        let ranges = [[a, b]];
        if (f.type === 'Disulfide bond') ranges = [[a, a], [b, b]];
        const alt = f.alternativeSequence && f.alternativeSequence.originalSequence ? ' ' + f.alternativeSequence.originalSequence + a + (f.alternativeSequence.alternativeSequences || []).join('/') : '';
        show3D(d, ranges, f.type + alt + (f.description ? ' – ' + f.description.split(';')[0].slice(0, 60) : '') + ' (' + (a === b ? a : a + '–' + b) + ')', { sticks: b - a < 16 });
      });
      t.appendChild(row);
    });
    return t;
  }
  const posCell = (f, a, b) => (a === b ? String(a) : a + '–' + b);
  const descCell = (f) => linkify(f.description || '') + evidenceTag(f.evidences);
  const changeCell = (f) => {
    const alt = f.alternativeSequence || {};
    return alt.originalSequence ? `<b>${esc(alt.originalSequence)} → ${esc((alt.alternativeSequences || []).join(', ') || 'missing')}</b>` : '';
  };

  /* =============== explorer UI =============== */
  class UniProtExplorer {
    constructor(root) {
      this.root = root;
      this.state = {};
      this._build();
      this.renderIntro();
    }
    _build() {
      const r = this.root;
      r.classList.add('ex');
      this.input = h('input', { type: 'search', placeholder: 'Search UniProtKB: protein name, gene, accession…', 'aria-label': 'Search UniProtKB', spellcheck: 'false' });
      this.form = h('form.ex-search', this.input, h('button.btn.primary', { type: 'submit', html: MG.icon('search') + '<span>Search</span>' }));
      this.fRev = h('input', { type: 'checkbox' });
      this.fHuman = h('input', { type: 'checkbox' });
      const filters = h('div.ex-filters',
        h('label', { title: 'Swiss-Prot: manually reviewed entries' }, this.fRev, h('span', 'Reviewed (Swiss-Prot) only')),
        h('label', this.fHuman, h('span', 'Human (Homo sapiens) only')));
      this.body = h('div.ex-body');
      r.append(h('div.ex-top', h('div.logo', { html: MG.icon('database') + 'UniProt<small>KB</small>' }), this.form, filters), this.body);
      this.form.addEventListener('submit', (e) => {
        e.preventDefault();
        const q = this.input.value.trim();
        if (q) this.search(q);
      });
      [this.fRev, this.fHuman].forEach((cb) => cb.addEventListener('change', () => this.state.query && this.search(this.state.query)));
    }

    renderIntro() {
      this.body.innerHTML = '';
      const ex = (q) => {
        const b = h('button.chip', { type: 'button' }, q);
        b.addEventListener('click', () => {
          this.input.value = q;
          this.search(q);
        });
        return b;
      };
      this.body.append(h('div.ex-empty',
        h('div', { html: MG.icon('database') }),
        h('h3', 'Search the UniProt Knowledgebase'),
        h('p', 'UniProtKB has two parts: ', h('b', 'Swiss-Prot'), ' (reviewed – checked by expert curators) and ', h('b', 'TrEMBL'), ' (unreviewed – annotated automatically).'),
        h('p', 'Try: ', ex('toll-like receptor 4'), ' ', ex('TBP'), ' ', ex('O00206')),
        h('p.hint', 'This panel shows live data from rest.uniprot.org, laid out like a UniProt entry page.')));
    }

    /* ---------- search ---------- */
    async search(q, opts = {}) {
      this.state.query = q;
      if (opts.reviewed != null) this.fRev.checked = !!opts.reviewed;
      if (opts.human != null) this.fHuman.checked = !!opts.human;
      this.input.value = q;
      MG.app.showWorkbench && MG.app.showWorkbench('uniprot');
      // accession typed on its own -> open directly
      if (/^([OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9]([A-Z][A-Z0-9]{2}[0-9]){1,2})(-\d+)?$/i.test(q.trim()) && !opts.list) return this.open(q.trim().toUpperCase());
      let query = '(' + q + ')';
      if (this.fRev.checked) query += ' AND (reviewed:true)';
      if (this.fHuman.checked) query += ' AND (organism_id:9606)';
      this.body.innerHTML = '';
      this.body.appendChild(h('div.ex-status', h('span.spinner', { style: { width: '16px', height: '16px', display: 'inline-block', verticalAlign: 'middle', marginRight: '6px' } }), 'Searching UniProtKB…'));
      try {
        const url = `${API}search?query=${encodeURIComponent(query)}&fields=${FIELDS}&size=25&format=json`;
        const r = await MG.fetchWithTimeout(url, {}, 25000);
        const total = parseInt(r.headers.get('x-total-results') || '0', 10);
        const next = this._next(r.headers.get('link'));
        const data = await r.json();
        this.state.results = data.results || [];
        this.state.total = total;
        this.state.next = next;
        this.renderResults();
        bus.emit('uniprot:search', { query: q, total, reviewed: this.fRev.checked, human: this.fHuman.checked });
      } catch (e) {
        this.body.innerHTML = '';
        this.body.appendChild(h('div.ex-empty', h('h3', 'UniProt could not be reached'), h('p', e.message), h('p.hint', 'Check your internet connection. You can still open the tutorial entries: '),
          ...['O00206', 'P20226'].map((a) => {
            const b = h('button.chip', { type: 'button' }, a);
            b.addEventListener('click', () => this.open(a));
            return b;
          })));
      }
    }
    _next(link) {
      if (!link) return null;
      const m = /<([^>]+)>;\s*rel="next"/.exec(link);
      return m ? m[1] : null;
    }
    async more() {
      if (!this.state.next) return;
      const r = await MG.fetchWithTimeout(this.state.next, {}, 25000);
      this.state.next = this._next(r.headers.get('link'));
      const data = await r.json();
      this.state.results = this.state.results.concat(data.results || []);
      this.renderResults(true);
    }
    renderResults(keepScroll) {
      const st = this.state;
      const top = this.body.scrollTop;
      this.body.innerHTML = '';
      const filt = [this.fRev.checked ? 'reviewed only' : '', this.fHuman.checked ? 'human only' : ''].filter(Boolean).join(', ');
      this.body.appendChild(h('div.ex-status', { html: `<b>${MG.fmt(st.total)}</b> result${st.total === 1 ? '' : 's'} for “${esc(st.query)}”${filt ? ' · ' + filt : ''} · showing ${st.results.length}` }));
      if (!st.results.length) {
        this.body.appendChild(h('p.muted', 'No entries found. Check the spelling, or remove a filter.'));
        return;
      }
      const t = h('table.results');
      t.appendChild(h('tr', h('th', 'Entry'), h('th', 'Entry name'), h('th', 'Status'), h('th', 'Protein names'), h('th', 'Gene'), h('th', 'Organism'), h('th', 'Length')));
      st.results.forEach((d) => {
        const rev = /reviewed \(Swiss-Prot\)/i.test(d.entryType) || d.entryType === 'UniProtKB reviewed (Swiss-Prot)';
        const accBtn = h('button', { type: 'button', title: 'Open this entry' }, d.primaryAccession);
        accBtn.addEventListener('click', () => this.open(d.primaryAccession));
        const org = d.organism || {};
        const human = org.taxonId === 9606;
        t.appendChild(h('tr',
          h('td.acc', accBtn),
          h('td.mono', d.uniProtkbId),
          h('td', h('span.rev.' + (rev ? 'yes' : 'no'), { title: rev ? 'Reviewed (Swiss-Prot)' : 'Unreviewed (TrEMBL)' }, rev ? '★ Reviewed' : 'Unreviewed')),
          h('td', protName(d)),
          h('td', geneName(d)),
          h('td', h('span.org' + (human ? '.human' : ''), org.scientificName + (org.commonName ? ' (' + org.commonName + ')' : ''))),
          h('td', d.sequence ? d.sequence.length : '')));
      });
      this.body.appendChild(t);
      if (st.next) {
        const b = h('button.btn', { type: 'button', text: 'Show 25 more' });
        b.addEventListener('click', () => this.more());
        this.body.appendChild(h('div.pager', b, h('span.muted', 'Most people narrow the search instead – try the filters above.')));
      }
      if (keepScroll) this.body.scrollTop = top;
    }

    /* ---------- entry ---------- */
    async open(acc, section) {
      MG.app.showWorkbench && MG.app.showWorkbench('uniprot');
      this.body.innerHTML = '';
      this.body.appendChild(h('div.ex-status', 'Loading ' + acc + '…'));
      let d;
      try {
        d = await getEntry(acc);
      } catch (e) {
        this.body.innerHTML = '';
        this.body.appendChild(h('div.ex-empty', h('h3', 'Could not open ' + acc), h('p', e.message)));
        return;
      }
      if (d.entryType === 'Inactive') {
        this.body.innerHTML = '';
        this.body.appendChild(h('div.ex-empty', h('h3', acc + ' is no longer in UniProtKB'), h('p', 'This entry has been merged or deleted.')));
        return;
      }
      this.entry = d;
      this.renderEntry(d);
      bus.emit('uniprot:entry', { acc: d.primaryAccession, id: d.uniProtkbId });
      if (section) this.section(section);
    }

    section(id) {
      const el = this.body.querySelector('#up-sec-' + id);
      if (el) {
        this._lastSec = id;
        el.scrollIntoView({ block: 'start', behavior: 'smooth' });
        this.body.querySelectorAll('.sec-nav button').forEach((b) => b.classList.toggle('on', b.dataset.sec === id));
        bus.emit('uniprot:section', { acc: this.entry.primaryAccession, name: id });
      }
    }

    renderEntry(d) {
      const B = this.body;
      B.innerHTML = '';
      const acc = d.primaryAccession;
      const rev = /reviewed \(Swiss-Prot\)/i.test(d.entryType);
      const org = d.organism || {};
      const crumbs = h('div.ex-crumbs');
      if (this.state.results && this.state.results.length) {
        const back = h('button', { type: 'button' }, '← Back to results');
        back.addEventListener('click', () => this.renderResults());
        crumbs.append(back, h('span', '·'));
      }
      crumbs.append(h('span', 'UniProtKB'), h('span', '›'), h('span', acc), h('span', '·'), h('span', { html: ext('https://www.uniprot.org/uniprotkb/' + acc + '/entry', 'Open on uniprot.org') }));
      const af = h('button.btn.small', { type: 'button', html: MG.icon('sparkle') + '<span>AlphaFold model in 3D</span>' });
      af.addEventListener('click', () => MG.app.vui.run('load af ' + acc));
      B.append(crumbs,
        h('div.entry-h',
          h('span.acc', acc),
          h('span.mono.muted', '· ' + d.uniProtkbId),
          h('h2', protName(d)),
          af),
        h('div.entry-sub',
          h('span', 'Gene: ', h('b', geneName(d) || '–')),
          h('span', 'Organism: ', h('b', (org.scientificName || '') + (org.commonName ? ' (' + org.commonName + ')' : ''))),
          h('span', 'Status: ', h('span.rev.' + (rev ? 'yes' : 'no'), rev ? '★ Reviewed (Swiss-Prot)' : 'Unreviewed (TrEMBL)')),
          d.annotationScore ? h('span', 'Annotation score: ', h('b', d.annotationScore + '/5')) : null,
          h('span', 'Length: ', h('b', d.sequence.length + ' aa'))));
      const nav = h('nav.sec-nav', { 'aria-label': 'Entry sections' });
      const content = h('div.sec-content');
      SECTIONS.forEach(([id, label]) => {
        const b = h('button', { type: 'button', dataset: { sec: id } }, label);
        b.addEventListener('click', () => this.section(id));
        nav.appendChild(b);
        const sec = h('section.sec', { id: 'up-sec-' + id });
        try {
          this['sec_' + id](d, sec, label);
        } catch (e) {
          console.error(e);
          sec.appendChild(h('h3', label));
          sec.appendChild(h('p.muted', 'Could not display this section.'));
        }
        content.appendChild(sec);
      });
      B.appendChild(h('div.entry-layout', nav, content));
      B.scrollTop = 0;
      // highlight nav while scrolling
      if (this._io) this._io.disconnect();
      if ('IntersectionObserver' in window) {
        this._io = new IntersectionObserver((ents) => {
          ents.forEach((en) => {
            if (en.isIntersecting) {
              const id = en.target.id.replace('up-sec-', '');
              nav.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.sec === id));
              // count a section as "visited" only if the reader stays on it for a moment
              clearTimeout(this._secTimer);
              this._secTimer = setTimeout(() => {
                if (this._lastSec !== id && this.entry && this.entry.primaryAccession === acc) {
                  this._lastSec = id;
                  bus.emit('uniprot:section', { acc, name: id, scrolled: true });
                }
              }, 1500);
            }
          });
        }, { root: B, rootMargin: '0px 0px -75% 0px' });
        content.querySelectorAll('.sec').forEach((s) => this._io.observe(s));
      }
    }

    _h3(sec, label, link) {
      sec.appendChild(h('h3', { html: esc(label) + (link ? ' ' + link : '') }));
    }
    _comments(d, type) {
      return (d.comments || []).filter((c) => c.commentType === type);
    }
    _xrefs(d, db) {
      return (d.uniProtKBCrossReferences || []).filter((x) => x.database === db);
    }
    _prop(x, key) {
      const p = (x.properties || []).find((p) => p.key === key);
      return p ? p.value : '';
    }

    sec_function(d, sec, label) {
      this._h3(sec, label);
      const fn = this._comments(d, 'FUNCTION');
      if (!fn.length) sec.appendChild(h('p.muted', 'No function annotated.'));
      fn.forEach((c) => sec.appendChild(h('p', { html: linkify(txt(c)) })));
      const cat = this._comments(d, 'CATALYTIC ACTIVITY');
      cat.forEach((c) => c.reaction && sec.appendChild(h('p', { html: '<b>Catalytic activity:</b> ' + esc(c.reaction.name) })));
      const kw = (d.keywords || []).filter((k) => ['Molecular function', 'Biological process', 'Ligand'].includes(k.category));
      if (kw.length) {
        sec.appendChild(h('h4', 'Keywords'));
        sec.appendChild(h('div.go-list', ...kw.map((k) => h('span', k.name, h('i', k.category)))));
      }
      const go = this._xrefs(d, 'GO');
      const aspects = { F: 'Molecular function', P: 'Biological process' };
      Object.entries(aspects).forEach(([a, name]) => {
        const list = go.filter((x) => this._prop(x, 'GoTerm').startsWith(a + ':'));
        if (!list.length) return;
        sec.appendChild(h('h4', `Gene Ontology – ${name} (${list.length})`));
        const box = h('div.go-list');
        list.slice(0, 40).forEach((x) => {
          const term = this._prop(x, 'GoTerm').slice(2);
          const ev = this._prop(x, 'GoEvidenceType');
          const s = h('span', { title: x.id + ' · evidence ' + ev }, term, h('i', ev.split(':')[0]));
          box.appendChild(s);
        });
        if (list.length > 40) box.appendChild(h('span.muted', '+' + (list.length - 40) + ' more'));
        sec.appendChild(box);
      });
      if (go.length) sec.appendChild(h('p.hint', 'GO describes what a protein does in words computers can use. The code after each term is the evidence: IDA = direct assay, IMP = mutant phenotype, IEA = electronic annotation, TAS = traceable author statement…'));
      const rx = this._xrefs(d, 'Reactome');
      if (rx.length) {
        sec.appendChild(h('h4', `Pathways – Reactome (${rx.length})`));
        const ul = h('ul');
        rx.forEach((x) => ul.appendChild(h('li', { html: `<a href="https://reactome.org/PathwayBrowser/#/${esc(x.id)}" target="_blank" rel="noopener">${esc(x.id)}</a> ${esc(this._prop(x, 'PathwayName'))}` })));
        sec.appendChild(ul);
      }
    }

    sec_names(d, sec, label) {
      this._h3(sec, label);
      const pd = d.proteinDescription || {};
      const dl = h('dl.kv');
      const add = (k, v) => v && dl.append(h('dt', k), h('dd', { html: v }));
      const rec = pd.recommendedName;
      if (rec) add('Recommended name', `<b>${esc(rec.fullName.value)}</b>` + ((rec.shortNames || []).length ? ' (short: ' + rec.shortNames.map((s) => esc(s.value)).join(', ') + ')' : ''));
      (pd.alternativeNames || []).forEach((a, k) => add(k ? '' : 'Alternative names', esc(a.fullName.value) + ((a.shortNames || []).length ? ' (' + a.shortNames.map((s) => esc(s.value)).join(', ') + ')' : '')));
      (pd.cdAntigenNames || []).forEach((a) => add('CD antigen name', `<b>${esc(a.value)}</b>`));
      (pd.innNames || []).forEach((a) => add('INN', esc(a.value)));
      (d.genes || []).forEach((g) => {
        add('Gene name', `<b>${esc(g.geneName ? g.geneName.value : '')}</b>`);
        if (g.synonyms) add('Synonyms', g.synonyms.map((s) => esc(s.value)).join(', '));
        if (g.orfNames) add('ORF names', g.orfNames.map((s) => esc(s.value)).join(', '));
      });
      const org = d.organism || {};
      add('Organism', `<i>${esc(org.scientificName || '')}</i>${org.commonName ? ' (' + esc(org.commonName) + ')' : ''} · Taxonomy ID ${esc(org.taxonId)}`);
      if (org.lineage) add('Taxonomic lineage', esc(org.lineage.join(' › ')));
      const hg = this._xrefs(d, 'HGNC')[0];
      if (hg) add('HGNC (official gene name)', ext('https://www.genenames.org/data/gene-symbol-report/#!/hgnc_id/' + hg.id, hg.id + ' – ' + this._prop(hg, 'GeneName')));
      const mim = this._xrefs(d, 'MIM').filter((x) => this._prop(x, 'Type') === 'gene')[0];
      if (mim) add('OMIM (genetics)', ext('https://www.omim.org/entry/' + mim.id, mim.id));
      sec.appendChild(dl);
    }

    sec_location(d, sec, label) {
      this._h3(sec, label);
      const sl = this._comments(d, 'SUBCELLULAR LOCATION');
      if (!sl.length) sec.appendChild(h('p.muted', 'No location annotated.'));
      sl.forEach((c) => {
        const ul = h('ul');
        (c.subcellularLocations || []).forEach((l) => ul.appendChild(h('li', { html: `<b>${esc(l.location.value)}</b>${l.topology ? ' – ' + esc(l.topology.value) : ''}${evidenceTag(l.location.evidences)}` })));
        if (c.molecule) sec.appendChild(h('p', h('b', c.molecule)));
        sec.appendChild(ul);
        if (c.note) sec.appendChild(h('p', { html: linkify(txt(c.note)) }));
      });
      const go = this._xrefs(d, 'GO').filter((x) => this._prop(x, 'GoTerm').startsWith('C:'));
      if (go.length) {
        sec.appendChild(h('h4', `Gene Ontology – Cellular component (${go.length})`));
        sec.appendChild(h('div.go-list', ...go.map((x) => h('span', { title: x.id }, this._prop(x, 'GoTerm').slice(2), h('i', this._prop(x, 'GoEvidenceType').split(':')[0])))));
      }
      const topo = feats(d, ['Signal', 'Topological domain', 'Transmembrane', 'Intramembrane', 'Transit peptide']);
      if (topo.length) {
        sec.appendChild(h('h4', 'Topology (Features)'));
        sec.appendChild(trackSet(d, [{
          name: 'Topology',
          items: topo.map((f) => {
            const [a, b] = loc(f);
            const lab = f.type === 'Topological domain' ? f.description : f.type;
            const col = f.type === 'Topological domain' ? (/extracellular|lumenal/i.test(f.description) ? '#8fb9d9' : /cytoplasmic/i.test(f.description) ? '#f6c28b' : '#cccccc') : FCOL[f.type];
            return { start: a, end: b, color: col, label: lab, short: b - a > 40 ? lab : '' };
          })
        }], { caption: 'Click a segment to see it on the 3D structure.' }));
        sec.appendChild(featureTable(d, topo, [['Feature', (f) => esc(f.type)], ['Position', posCell, 'pos'], ['Description', descCell]]));
      }
    }

    sec_disease(d, sec, label) {
      this._h3(sec, label);
      const dis = this._comments(d, 'DISEASE');
      dis.forEach((c) => {
        const x = c.disease || {};
        const mim = x.diseaseCrossReference && x.diseaseCrossReference.database === 'MIM' ? ' ' + ext('https://www.omim.org/entry/' + x.diseaseCrossReference.id, 'OMIM ' + x.diseaseCrossReference.id) : '';
        sec.appendChild(h('p', { html: `<b>${esc(x.diseaseId || '')}${x.acronym ? ' (' + esc(x.acronym) + ')' : ''}</b>${mim}<br>${esc(x.description || '')}${c.note ? '<br><i>' + linkify(txt(c.note)) + '</i>' : ''}` }));
      });
      const poly = this._comments(d, 'POLYMORPHISM');
      poly.forEach((c) => sec.appendChild(h('p', { html: '<b>Polymorphism:</b> ' + linkify(txt(c)) })));
      if (!dis.length && !poly.length) sec.appendChild(h('p.muted', 'No disease association annotated in this entry.'));
      const vars = feats(d, ['Natural variant']);
      const muts = feats(d, ['Mutagenesis']);
      if (vars.length || muts.length) {
        sec.appendChild(trackSet(d, [
          { name: 'Natural variants', items: vars.map((f) => ({ start: loc(f)[0], end: loc(f)[1], color: /reduced|disease|associated/i.test(f.description || '') ? '#c0392b' : '#e59866', label: 'Variant ' + ((f.alternativeSequence || {}).originalSequence || '') + loc(f)[0] + ((f.alternativeSequence || {}).alternativeSequences || []).join(''), note: (f.description || '').slice(0, 80), pin: true })) },
          { name: 'Mutagenesis', items: muts.map((f) => ({ start: loc(f)[0], end: loc(f)[1], color: FCOL.Mutagenesis, label: 'Mutagenesis ' + loc(f)[0], note: (f.description || '').slice(0, 80), pin: true })) }
        ], { caption: 'Each pin is one position. Click it to find that residue in 3D.' }));
      }
      if (muts.length) {
        sec.appendChild(h('h4', `Mutagenesis (${muts.length}) – experiments where a residue was deliberately changed`));
        sec.appendChild(featureTable(d, muts, [['Position', posCell, 'pos'], ['Change', changeCell], ['Effect', descCell]]));
      }
      if (vars.length) {
        sec.appendChild(h('h4', `Natural variants (${vars.length}) – differences found between people`));
        sec.appendChild(featureTable(d, vars, [['Position', posCell, 'pos'], ['Change', changeCell], ['Description', (f) => linkify(f.description || '') + ((f.featureCrossReferences || []).length ? ' ' + f.featureCrossReferences.map((x) => ext('https://www.ncbi.nlm.nih.gov/snp/' + x.id, x.id)).join(' ') : '')]]));
      }
      // Chemistry / pharmacology
      const dbk = this._xrefs(d, 'DrugBank');
      const chembl = this._xrefs(d, 'ChEMBL');
      const gtp = this._xrefs(d, 'GuidetoPHARMACOLOGY');
      const dc = this._xrefs(d, 'DrugCentral');
      sec.appendChild(h('h4', 'Chemistry – drugs and other compounds'));
      if (dbk.length) {
        const ul = h('ul');
        dbk.forEach((x) => ul.appendChild(h('li', { html: `${ext('https://go.drugbank.com/drugs/' + x.id, x.id)} ${esc(this._prop(x, 'GenericName'))}` })));
        sec.appendChild(h('p', 'DrugBank lists compounds reported to act on this protein:'));
        sec.appendChild(ul);
      }
      const links = [];
      if (chembl.length) links.push(ext('https://www.ebi.ac.uk/chembl/explore/target/' + chembl[0].id, 'ChEMBL ' + chembl[0].id));
      if (gtp.length) links.push(ext('https://www.guidetopharmacology.org/GRAC/ObjectDisplayForward?objectId=' + gtp[0].id, 'IUPHAR/BPS Guide to Pharmacology'));
      if (dc.length) links.push(ext('https://drugcentral.org/?q=' + d.primaryAccession, 'DrugCentral'));
      if (links.length) sec.appendChild(h('p', { html: 'More pharmacology: ' + links.join(' · ') }));
      if (!dbk.length && !links.length) sec.appendChild(h('p.muted', 'No drug database links for this entry.'));
      const orgdb = ['DisGeNET', 'MalaCards', 'OpenTargets', 'Orphanet', 'ClinPGx'].map((db) => this._xrefs(d, db)[0] && db).filter(Boolean);
      if (orgdb.length) sec.appendChild(h('p.hint', 'Organism-specific databases linked from this entry: ' + orgdb.join(', ')));
    }

    sec_ptm(d, sec, label) {
      this._h3(sec, label);
      const types = ['Signal', 'Propeptide', 'Transit peptide', 'Chain', 'Peptide', 'Initiator methionine', 'Modified residue', 'Lipidation', 'Glycosylation', 'Disulfide bond', 'Cross-link'];
      const list = feats(d, types);
      const ptm = feats(d, ['Glycosylation', 'Disulfide bond', 'Modified residue', 'Lipidation', 'Cross-link']);
      if (ptm.length) {
        const items = [];
        ptm.forEach((f) => {
          const [a, b] = loc(f);
          if (f.type === 'Disulfide bond') {
            items.push({ start: a, end: a, color: FCOL[f.type], label: 'Disulfide ' + a + '–' + b, pin: true, ranges: [[a, a], [b, b]] });
            items.push({ start: b, end: b, color: FCOL[f.type], label: 'Disulfide ' + a + '–' + b, pin: true, ranges: [[a, a], [b, b]] });
          } else items.push({ start: a, end: b, color: FCOL[f.type] || '#555', label: f.type + ' ' + a, note: f.description, pin: true });
        });
        const byType = (t) => items.filter((i) => i.label.startsWith(t === 'Disulfide bond' ? 'Disulfide' : t));
        sec.appendChild(trackSet(d, [
          { name: 'Processing', items: feats(d, ['Signal', 'Propeptide', 'Chain', 'Peptide']).map((f) => ({ start: loc(f)[0], end: loc(f)[1], color: FCOL[f.type] || '#bdc3c7', label: f.type + (f.description ? ': ' + f.description : ''), short: loc(f)[1] - loc(f)[0] > 60 ? f.type : '' })) },
          { name: 'Glycosylation', items: byType('Glycosylation') },
          { name: 'Disulfide bonds', items: byType('Disulfide bond') },
          { name: 'Modified residues', items: byType('Modified residue').concat(byType('Lipidation'), byType('Cross-link')) }
        ], { caption: 'Pins mark single residues. Click one to see where it is in 3D.' }));
      }
      this._comments(d, 'PTM').forEach((c) => sec.appendChild(h('p', { html: linkify(txt(c)) })));
      if (list.length) sec.appendChild(featureTable(d, list, [['Feature', (f) => esc(f.type)], ['Position', posCell, 'pos'], ['Description', descCell]]));
      else sec.appendChild(h('p.muted', 'No processing or modification features annotated.'));
      const psp = this._xrefs(d, 'PhosphoSitePlus')[0];
      const gg = this._xrefs(d, 'GlyGen')[0];
      const links = [];
      if (psp) links.push(ext('https://www.phosphosite.org/uniprotAccAction?id=' + d.primaryAccession, 'PhosphoSitePlus'));
      if (gg) links.push(ext('https://glygen.org/protein/' + d.primaryAccession, 'GlyGen'));
      if (links.length) sec.appendChild(h('p', { html: 'PTM databases: ' + links.join(' · ') }));
    }

    sec_expression(d, sec, label) {
      this._h3(sec, label);
      let any = false;
      [['TISSUE SPECIFICITY', 'Tissue specificity'], ['INDUCTION', 'Induction'], ['DEVELOPMENTAL STAGE', 'Developmental stage']].forEach(([t, name]) => {
        this._comments(d, t).forEach((c) => {
          any = true;
          sec.appendChild(h('p', { html: `<b>${name}:</b> ` + linkify(txt(c)) }));
        });
      });
      if (!any) sec.appendChild(h('p.muted', 'No expression information annotated.'));
      const hpa = this._xrefs(d, 'HPA')[0];
      const links = [];
      if (hpa) links.push(ext('https://www.proteinatlas.org/' + hpa.id, 'Human Protein Atlas (' + this._prop(hpa, 'ExpressionPatterns') + ')'));
      const bgee = this._xrefs(d, 'Bgee')[0];
      if (bgee) links.push(ext('https://www.bgee.org/gene/' + bgee.id, 'Bgee'));
      const ea = this._xrefs(d, 'ExpressionAtlas')[0];
      if (ea) links.push(ext('https://www.ebi.ac.uk/gxa/genes/' + ea.id, 'Expression Atlas'));
      if (links.length) sec.appendChild(h('p', { html: 'Expression databases: ' + links.join(' · ') }));
    }

    sec_interaction(d, sec, label) {
      this._h3(sec, label);
      this._comments(d, 'SUBUNIT').forEach((c) => sec.appendChild(h('p', { html: linkify(txt(c)) })));
      const inter = this._comments(d, 'INTERACTION')[0];
      if (inter && inter.interactions && inter.interactions.length) {
        sec.appendChild(h('h4', `Binary interactions (${inter.interactions.length}) – from IntAct`));
        const t = h('table.ftable');
        t.appendChild(h('tr', h('th', 'Partner'), h('th', 'Entry'), h('th', 'Experiments'), h('th', 'IntAct')));
        inter.interactions.forEach((x) => {
          const two = x.interactantTwo || {};
          const one = x.interactantOne || {};
          const accB = h('button.linkbtn', { type: 'button', title: 'Open this entry here' }, two.uniProtKBAccession || '');
          accB.addEventListener('click', () => this.open((two.uniProtKBAccession || '').split('-')[0]));
          t.appendChild(h('tr',
            h('td', h('b', two.geneName || two.uniProtKBAccession || '?'), two.chainId ? ' ' + two.chainId : ''),
            h('td', accB),
            h('td', String(x.numberOfExperiments || '')),
            h('td', { html: one.intActId && two.intActId ? ext(`https://www.ebi.ac.uk/intact/search?query=${one.intActId}%20${two.intActId}`, 'view') : '' })));
        });
        sec.appendChild(t);
      } else sec.appendChild(h('p.muted', 'No binary interactions listed.'));
      const links = [];
      const str = this._xrefs(d, 'STRING')[0];
      if (str) links.push(ext('https://string-db.org/network/' + str.id, 'STRING network'));
      const bg = this._xrefs(d, 'BioGRID')[0];
      if (bg) links.push(ext('https://thebiogrid.org/' + bg.id, 'BioGRID'));
      const cp = this._xrefs(d, 'ComplexPortal');
      if (cp.length) links.push(ext('https://www.ebi.ac.uk/complexportal/complex/' + cp[0].id, 'Complex Portal'));
      if (links.length) sec.appendChild(h('p', { html: 'Interaction databases: ' + links.join(' · ') }));
    }

    sec_structure(d, sec, label) {
      this._h3(sec, label);
      const pdb = this._xrefs(d, 'PDB');
      const afx = this._xrefs(d, 'AlphaFoldDB')[0];
      sec.appendChild(h('p', pdb.length ? `${pdb.length} experimental structure${pdb.length > 1 ? 's' : ''} in the Protein Data Bank contain this protein (or part of it)${afx ? ', plus a predicted model in AlphaFold DB' : ''}.` : 'No experimental structures in the PDB.' + (afx ? ' A predicted model is available from AlphaFold DB.' : '')));
      if (pdb.length) {
        // coverage map
        const L = d.sequence.length;
        const items = pdb.map((x) => {
          const method = this._prop(x, 'Method');
          const res = this._prop(x, 'Resolution');
          const chains = this._prop(x, 'Chains');
          const ranges = [];
          chains.split(/,\s*/).forEach((p) => {
            const m = /=(\d+)-(\d+)/.exec(p);
            if (m) ranges.push([+m[1], +m[2]]);
          });
          return { id: x.id, method, res, chains, ranges };
        });
        items.sort((a, b) => ((a.ranges[0] || [0])[0] - (b.ranges[0] || [0])[0]) || (parseFloat(a.res) || 99) - (parseFloat(b.res) || 99));
        const mcol = (m) => (/x-ray/i.test(m) ? '#2e86c1' : /em/i.test(m) ? '#8e44ad' : /nmr/i.test(m) ? '#d35400' : '#7f8c8d');
        const doms = feats(d, ['Domain', 'Topological domain', 'Transmembrane', 'Signal']).map((f) => ({ start: loc(f)[0], end: loc(f)[1], color: f.type === 'Topological domain' ? (/extra/i.test(f.description) ? '#8fb9d9' : '#f6c28b') : FCOL[f.type] || '#999', label: f.type === 'Topological domain' ? f.description : f.type + (f.description ? ' ' + f.description : ''), short: loc(f)[1] - loc(f)[0] > L / 12 ? (f.description || f.type) : '' }));
        const groups = [{ name: 'Domains/topology', items: doms }];
        items.forEach((it) => groups.push({
          name: it.id,
          items: it.ranges.map(([a, b]) => ({ start: a, end: b, color: mcol(it.method), label: `${it.id} (${it.method}${it.res && it.res !== '-' ? ', ' + it.res : ''}) chains ${it.chains}`, onClick: () => MG.app.vui.run('load ' + it.id) }))
        }));
        if (afx) groups.push({ name: 'AlphaFold', items: [{ start: 1, end: L, color: '#0053d6', label: 'AlphaFold model (whole sequence)', onClick: () => MG.app.vui.run('load af ' + d.primaryAccession) }] });
        const tw = trackSet(d, groups, { caption: 'Coverage map: each bar shows which residues are in that entry (blue X-ray, purple cryo-EM, orange NMR). Click a bar to load it.' });
        tw.classList.add('cov');
        sec.appendChild(h('h4', 'Which parts of the protein have structures?'));
        sec.appendChild(tw);
        const t = h('table.ftable.struct-table');
        t.appendChild(h('tr', h('th', 'PDB entry'), h('th', 'Method'), h('th', 'Resolution'), h('th', 'Chains = positions'), h('th', '')));
        items.forEach((it) => {
          const load = h('button.btn.small', { type: 'button', html: MG.icon('cube') + '<span>3D</span>', title: 'Load in the 3D viewer' });
          load.addEventListener('click', () => MG.app.vui.run('load ' + it.id));
          const det = h('button.btn.small', { type: 'button', text: 'Details', title: 'Open in the PDB tab' });
          det.addEventListener('click', () => MG.app.pdb.entry(it.id));
          t.appendChild(h('tr',
            h('td.mono', h('b', it.id)),
            h('td', it.method),
            h('td', it.res && it.res !== '-' ? it.res : '–'),
            h('td.mono', it.chains),
            h('td', load, det, h('span', { html: ext('https://www.rcsb.org/structure/' + it.id, 'RCSB') }))));
        });
        sec.appendChild(t);
      }
      if (afx) {
        const b = h('button.btn.small', { type: 'button', html: MG.icon('sparkle') + '<span>Load AlphaFold model</span>' });
        b.addEventListener('click', () => MG.app.vui.run('load af ' + d.primaryAccession));
        sec.appendChild(h('p', h('b', 'AlphaFold DB: '), b, ' ', h('span', { html: ext('https://alphafold.ebi.ac.uk/entry/' + d.primaryAccession, 'AlphaFold DB page') })));
      }
    }

    sec_family(d, sec, label) {
      this._h3(sec, label);
      const list = feats(d, ['Domain', 'Repeat', 'Region', 'Coiled coil', 'Compositional bias', 'Motif', 'Zinc finger']);
      if (list.length) {
        const g = (types, name) => ({
          name,
          items: list.filter((f) => types.includes(f.type)).map((f) => {
            const [a, b] = loc(f);
            return { start: a, end: b, color: f.type === 'Region' && /disorder/i.test(f.description || '') ? '#bfc5cc' : FCOL[f.type] || '#999', label: f.type + (f.description ? ': ' + f.description : ''), short: b - a > d.sequence.length / 14 ? f.description || f.type : '' };
          })
        });
        sec.appendChild(trackSet(d, [g(['Domain'], 'Domains'), g(['Repeat'], 'Repeats'), g(['Region', 'Coiled coil', 'Motif', 'Zinc finger'], 'Regions & motifs'), g(['Compositional bias'], 'Compositional bias')], { caption: 'Domain architecture. Click a block to see it in 3D.' }));
        sec.appendChild(featureTable(d, list, [['Feature', (f) => esc(f.type)], ['Position', posCell, 'pos'], ['Description', descCell], ['Length', (f, a, b) => String(b - a + 1)]]));
      } else sec.appendChild(h('p.muted', 'No domains or regions annotated.'));
      this._comments(d, 'DOMAIN').forEach((c) => sec.appendChild(h('p', { html: '<b>Domain:</b> ' + linkify(txt(c)) })));
      this._comments(d, 'SIMILARITY').forEach((c) => sec.appendChild(h('p', { html: '<b>Sequence similarity:</b> ' + linkify(txt(c)) })));
      const links = [];
      const ip = this._xrefs(d, 'InterPro');
      if (ip.length) links.push(ext('https://www.ebi.ac.uk/interpro/protein/UniProt/' + d.primaryAccession + '/', `InterPro (${ip.length} entries)`));
      const pf = this._xrefs(d, 'Pfam');
      if (pf.length) links.push('Pfam: ' + pf.map((x) => ext('https://www.ebi.ac.uk/interpro/entry/pfam/' + x.id + '/', x.id + ' ' + this._prop(x, 'EntryName'))).join(', '));
      const sm = this._xrefs(d, 'SMART');
      if (sm.length) links.push('SMART: ' + sm.map((x) => esc(this._prop(x, 'EntryName'))).join(', '));
      if (links.length) sec.appendChild(h('p', { html: 'Family & domain databases (these predict domains from sequence similarity): ' + links.join(' · ') }));
    }

    sec_sequence(d, sec, label) {
      this._h3(sec, label);
      const s = d.sequence;
      const alt = this._comments(d, 'ALTERNATIVE PRODUCTS')[0];
      const iso = alt && alt.isoforms ? alt.isoforms : [];
      sec.appendChild(h('p', { html: `This entry describes <b>${iso.length || 1}</b> isoform${iso.length > 1 ? 's' : ''}${alt && alt.events ? ' produced by ' + esc(alt.events.join(', ').toLowerCase()) : ''}. The <b>canonical</b> sequence (isoform ${iso.length ? esc(iso.find((i) => i.isoformSequenceStatus === 'Displayed') ? iso.find((i) => i.isoformSequenceStatus === 'Displayed').name.value : '1') : '1'}) is shown and is used for all position numbers on this page.` }));
      const dl = h('dl.kv');
      dl.append(h('dt', 'Length'), h('dd', h('b', s.length + ' amino acids')), h('dt', 'Mass'), h('dd', MG.fmt(s.molWeight) + ' Da'));
      if (d.entryAudit) dl.append(h('dt', 'Sequence version'), h('dd', String(d.entryAudit.sequenceVersion) + (d.entryAudit.lastSequenceUpdateDate ? ' (' + d.entryAudit.lastSequenceUpdateDate + ')' : '')));
      sec.appendChild(dl);
      if (iso.length > 1) {
        const ul = h('ul');
        iso.forEach((i) => ul.appendChild(h('li', { html: `Isoform <b>${esc(i.name.value)}</b> (${esc(i.isoformIds.join(', '))})${i.isoformSequenceStatus === 'Displayed' ? ' – canonical, shown below' : ''}${i.note ? ' – ' + linkify(txt(i.note)) : ''}` })));
        sec.appendChild(ul);
      }
      // sequence block
      const find = h('input', { type: 'text', placeholder: 'Find a motif, e.g. QQQQ', size: 18, style: { fontFamily: 'var(--mono)' }, 'aria-label': 'Find in sequence' });
      const posInput = h('input', { type: 'number', min: 1, max: s.length, placeholder: 'Go to residue', style: { width: '8.5em' }, 'aria-label': 'Residue number' });
      const out = h('span.muted');
      const block = h('div.seqblock');
      const render = (hl) => {
        block.innerHTML = '';
        for (let k = 0; k < s.length; k += 10) {
          const chunk = s.value.slice(k, k + 10);
          const b = h('span.blk');
          if (hl) {
            let html = '';
            for (let j = 0; j < chunk.length; j++) html += hl[k + j] ? `<span class="hl">${chunk[j]}</span>` : chunk[j];
            b.innerHTML = html;
          } else b.textContent = chunk;
          b.appendChild(h('i', String(Math.min(k + 10, s.length))));
          block.appendChild(b);
        }
      };
      render();
      find.addEventListener('input', () => {
        const q = find.value.trim().toUpperCase();
        if (!q) {
          render();
          out.textContent = '';
          return;
        }
        const hl = new Uint8Array(s.length);
        let n = 0, first = -1;
        let i = s.value.indexOf(q);
        while (i >= 0) {
          n++;
          if (first < 0) first = i + 1;
          for (let j = 0; j < q.length; j++) hl[i + j] = 1;
          i = s.value.indexOf(q, i + 1);
        }
        render(hl);
        out.textContent = n ? `${n} match${n > 1 ? 'es' : ''}; first at residue ${first}` : 'not found';
        bus.emit('uniprot:find', { acc: d.primaryAccession, q, n, first });
      });
      posInput.addEventListener('change', () => {
        const p = parseInt(posInput.value, 10);
        if (!p || p < 1 || p > s.length) return;
        const hl = new Uint8Array(s.length);
        hl[p - 1] = 1;
        render(hl);
        out.textContent = `Residue ${p} is ${s.value[p - 1]} (${MG.AA1_NAME[s.value[p - 1]] || '?'})`;
      });
      const copy = h('button.btn.small', { type: 'button', html: MG.icon('copy') + '<span>Copy FASTA</span>' });
      const fasta = () => `>${d.entryType && /Swiss/.test(d.entryType) ? 'sp' : 'tr'}|${d.primaryAccession}|${d.uniProtkbId} ${protName(d)} OS=${(d.organism || {}).scientificName} GN=${geneName(d)}\n` + s.value.replace(/(.{60})/g, '$1\n');
      copy.addEventListener('click', async () => {
        (await MG.copyText(fasta())) ? toast('FASTA copied') : toast('Could not copy', 'error');
        bus.emit('uniprot:fasta', { acc: d.primaryAccession });
      });
      const dlb = h('button.btn.small', { type: 'button', html: MG.icon('download') + '<span>Download FASTA</span>' });
      dlb.addEventListener('click', () => {
        MG.downloadText(fasta(), d.primaryAccession + '.fasta');
        bus.emit('uniprot:fasta', { acc: d.primaryAccession });
      });
      sec.appendChild(h('div.q-actions', find, posInput, copy, dlb, out));
      sec.appendChild(h('div.seqwrap', block));
      const altSeq = feats(d, ['Alternative sequence']);
      if (altSeq.length) {
        sec.appendChild(h('h4', 'How the other isoforms differ'));
        sec.appendChild(featureTable(d, altSeq, [['Position', posCell, 'pos'], ['Change', changeCell], ['Description', descCell]]));
      }
    }
  }

  MG.UniProtExplorer = UniProtExplorer;
})();
