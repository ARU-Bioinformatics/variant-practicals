/* =====================================================================
   Variant annotation explorer: a VCF annotated by Ensembl VEP (GRCh37),
   shown as a filterable table with a filtering funnel and details.
   VEP runs on Ensembl's public REST server (only positions and alleles
   are sent) or from saved results bundled with the page.
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const { h, esc, bus, toast } = MG;

  /* Ensembl's consequence terms, most severe first */
  const SO = [
    'transcript_ablation', 'splice_acceptor_variant', 'splice_donor_variant', 'stop_gained', 'frameshift_variant', 'stop_lost', 'start_lost',
    'transcript_amplification', 'feature_elongation', 'feature_truncation', 'inframe_insertion', 'inframe_deletion', 'missense_variant',
    'protein_altering_variant', 'splice_donor_5th_base_variant', 'splice_region_variant', 'splice_donor_region_variant',
    'splice_polypyrimidine_tract_variant', 'incomplete_terminal_codon_variant', 'start_retained_variant', 'stop_retained_variant',
    'synonymous_variant', 'coding_sequence_variant', 'mature_miRNA_variant', '5_prime_UTR_variant', '3_prime_UTR_variant',
    'non_coding_transcript_exon_variant', 'intron_variant', 'NMD_transcript_variant', 'non_coding_transcript_variant',
    'coding_transcript_variant', 'upstream_gene_variant', 'downstream_gene_variant', 'TFBS_ablation', 'TFBS_amplification',
    'TF_binding_site_variant', 'regulatory_region_ablation', 'regulatory_region_amplification', 'regulatory_region_variant',
    'intergenic_variant', 'sequence_variant'
  ];
  const RANK = new Map(SO.map((t, i) => [t, i]));
  const rankOf = (terms) => Math.min(...(terms || ['sequence_variant']).map((t) => (RANK.has(t) ? RANK.get(t) : 99)));
  const IMPACTS = ['HIGH', 'MODERATE', 'LOW', 'MODIFIER'];
  const nice = (t) => String(t || '').replace(/_variant$/, '').replace(/_/g, ' ').replace(/^5 prime/, "5′").replace(/^3 prime/, "3′");

  /* ------------------------------------------------------------------
     VCF parsing
     ------------------------------------------------------------------ */
  function parseVCF(text) {
    const recs = [];
    let samples = [];
    String(text || '').split('\n').forEach((line) => {
      if (!line) return;
      if (line.startsWith('##')) return;
      if (line.startsWith('#CHROM')) {
        samples = line.split('\t').slice(9);
        return;
      }
      const f = line.split('\t');
      if (f.length < 8) return;
      const info = {};
      f[7].split(';').forEach((kv) => {
        const i = kv.indexOf('=');
        if (i < 0) info[kv] = true;
        else info[kv.slice(0, i)] = kv.slice(i + 1);
      });
      const fmt = (f[8] || '').split(':');
      const sm = {};
      if (f[9]) f[9].split(':').forEach((v, i) => (sm[fmt[i]] = v));
      f[4].split(',').forEach((alt, ai) => {
        recs.push({
          chrom: f[0],
          pos: +f[1],
          id: f[2],
          ref: f[3],
          alt,
          altIndex: ai + 1,
          qual: f[5] === '.' ? null : +f[5],
          filter: f[6],
          info,
          gt: sm.GT || '',
          ad: sm.AD || '',
          dp: sm.DP != null ? +sm.DP : info.DP != null ? +info.DP : null,
          key: `${f[0].replace(/^chr/, '')}:${f[1]}:${f[3]}:${alt}`
        });
      });
    });
    return { recs, samples };
  }
  const zygosity = (gt) => {
    const a = String(gt || '').split(/[/|]/);
    if (a.length < 2 || a.includes('.')) return '';
    return a[0] === a[1] ? (a[0] === '0' ? 'hom-ref' : 'hom') : 'het';
  };

  /* ------------------------------------------------------------------
     VEP: live (REST) or saved JSON; results are matched to records
     ------------------------------------------------------------------ */
  const VEP_OPTS = { canonical: 1, hgvs: 1, af_gnomade: 1, af_gnomadg: 1, CADD: 1, numbers: 1, variant_class: 1, SpliceAI: 1, af: 1, protein: 1 };
  function vepInput(r) {
    return `${r.chrom.replace(/^chr/, '')} ${r.pos} ${r.id && r.id !== '.' ? r.id : '.'} ${r.ref} ${r.alt} . . .`;
  }
  async function runVEP(recs, progress) {
    const server = (MG.config.vepServer || 'https://grch37.rest.ensembl.org').replace(/\/$/, '');
    const out = [];
    const B = 150;
    for (let i = 0; i < recs.length; i += B) {
      if (progress) progress(i, recs.length);
      const body = Object.assign({}, VEP_OPTS, { variants: recs.slice(i, i + B).map(vepInput) });
      let tries = 0;
      for (;;) {
        try {
          const r = await MG.fetchWithTimeout(server + '/vep/homo_sapiens/region', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) }, 120000);
          out.push(...(await r.json()));
          break;
        } catch (e) {
          if (++tries >= 3) throw e;
          await new Promise((res) => setTimeout(res, 2500 * tries));
        }
      }
    }
    if (progress) progress(recs.length, recs.length);
    return out;
  }
  /** the Ensembl release behind the VEP server (for students' Methods sections) */
  async function vepRelease() {
    const server = (MG.config.vepServer || 'https://grch37.rest.ensembl.org').replace(/\/$/, '');
    try {
      const r = await MG.fetchWithTimeout(server + '/info/software', { headers: { Accept: 'application/json' } }, 15000);
      const j = await r.json();
      return j && j.release ? j.release : null;
    } catch (e) {
      return null;
    }
  }
  function attach(recs, vep) {
    const byKey = new Map();
    vep.forEach((v) => {
      const p = String(v.input || '').trim().split(/\s+/);
      if (p.length >= 5) byKey.set(`${p[0]}:${p[1]}:${p[3]}:${p[4]}`, v);
    });
    recs.forEach((r) => {
      r.vep = byKey.get(r.key) || null;
      summarise(r);
    });
  }
  /** pick the transcript to show and pull out the key numbers */
  function summarise(r) {
    const v = r.vep;
    r.ann = null;
    if (!v) return;
    const tcs = (v.transcript_consequences || []).filter((t) => !t.variant_allele || t.variant_allele === alleleOf(r, v));
    const coding = (t) => t.biotype === 'protein_coding';
    const sorted = tcs.slice().sort((a, b) => (b.canonical ? 1 : 0) - (a.canonical ? 1 : 0) || (coding(b) ? 1 : 0) - (coding(a) ? 1 : 0) || rankOf(a.consequence_terms) - rankOf(b.consequence_terms));
    const canon = tcs.filter((t) => t.canonical && coding(t)).sort((a, b) => rankOf(a.consequence_terms) - rankOf(b.consequence_terms));
    const t = canon[0] || sorted[0] || null;
    const co = (v.colocated_variants || []).filter((c) => c.id && !/^(COSV|CM|CS|CD|CI|CR|CX|HM)/.test(c.id));
    const rsv = co.find((c) => /^rs/.test(c.id));
    const alt = alleleOf(r, v);
    let af = null, afg = null, afPops = null, afSrc = '', af1kg = null;
    co.forEach((c) => {
      const fr = c.frequencies && c.frequencies[alt];
      if (!fr) return;
      if (fr.gnomade != null && af == null) {
        af = fr.gnomade;
        afSrc = 'gnomAD exomes';
        afPops = fr;
      }
      if (fr.gnomadg != null && afg == null) afg = fr.gnomadg;
      if (fr.af != null && af1kg == null) af1kg = fr.af;
    });
    if (af == null && afg != null) {
      af = afg;
      afSrc = 'gnomAD genomes';
    }
    const sp = t && t.spliceai;
    const spMax = sp ? Math.max(sp.DS_AG || 0, sp.DS_AL || 0, sp.DS_DG || 0, sp.DS_DL || 0) : null;
    const clin = [];
    co.forEach((c) => (c.clin_sig || []).forEach((s) => !clin.includes(s) && clin.push(s)));
    r.ann = {
      t,
      gene: t ? t.gene_symbol || t.gene_id : '',
      conseq: t ? t.consequence_terms.slice().sort((a, b) => rankOf([a]) - rankOf([b]))[0] : v.most_severe_consequence,
      worst: v.most_severe_consequence,
      impact: t ? t.impact : 'MODIFIER',
      protein: '',
      hgvsp: t && t.hgvsp ? t.hgvsp.split(':')[1] : '',
      hgvsc: t && t.hgvsc ? t.hgvsc.split(':')[1] : '',
      exon: t && t.exon ? t.exon : t && t.intron ? 'intron ' + t.intron : '',
      rs: rsv ? rsv.id : '',
      ids: co.map((c) => c.id),
      af,
      afSrc,
      afPops,
      af1kg,
      sift: t && t.sift_prediction ? { p: t.sift_prediction, s: t.sift_score } : null,
      polyphen: t && t.polyphen_prediction ? { p: t.polyphen_prediction, s: t.polyphen_score } : null,
      cadd: t && t.cadd_phred != null ? t.cadd_phred : null,
      spliceai: spMax,
      spliceDetail: sp || null,
      clin,
      pubmed: co.reduce((n, c) => n + ((c.pubmed || []).length), 0)
    };
    // protein label like Arg144Cys (from HGVSp) or P227=
    if (r.ann.hgvsp) r.ann.protein = r.ann.hgvsp.replace(/^p\./, '').replace(/%3D/g, '=');
    else if (t && t.protein_start && t.amino_acids) {
      const [a, b] = t.amino_acids.split('/');
      r.ann.protein = a + t.protein_start + (b || '=');
    }
  }
  /** the allele as VEP names it. VEP trims bases shared by REF and ALT at both ends
      (CTAT>CT becomes AT/-), so use its own allele string when it has one */
  function alleleOf(r, v) {
    const parts = String((v && v.allele_string) || '').split('/');
    if (parts.length === 2 && parts[1]) return parts[1];
    const ref = r.ref.toUpperCase(), alt = r.alt.toUpperCase();
    if (ref.length === alt.length) return alt;
    if (ref[0] === alt[0]) return alt.slice(1) || '-';
    return alt;
  }

  /* ------------------------------------------------------------------
     the explorer
     ------------------------------------------------------------------ */
  class VariantExplorer {
    constructor(root, opts = {}) {
      this.root = root;
      this.opts = opts;
      this.recs = [];
      this.sel = null;
      this.sortKey = 'pos';
      this.sortDir = 1;
      this.filters = Object.assign({ impacts: new Set(IMPACTS), spliceKeep: false, maxAF: 'any', gene: '', zyg: 'any', text: '' }, opts.filters || {});
      this._build();
    }
    _build() {
      this.root.classList.add('vx');
      this.bar = h('div.vx-bar');
      this.body = h('div.vx-body');
      this.root.append(this.bar, this.body);
      this.renderEmpty();
    }
    renderEmpty(msg) {
      this.bar.innerHTML = '';
      this.body.innerHTML = '';
      this.body.appendChild(h('div.ex-empty', h('h3', 'No variants loaded yet'), h('p', { html: msg || this.opts.emptyHelp || 'Load a VCF file to begin.' })));
    }
    /** load VCF text (records keep their genotype, depth and quality) */
    setVCF(text, name) {
      const { recs, samples } = parseVCF(text);
      this.recs = recs;
      this.name = name || 'variants.vcf';
      this.samples = samples;
      this.annotated = false;
      this.sel = null;
      bus.emit('vx:loaded', { n: recs.length, name: this.name });
      this.render();
      return recs.length;
    }
    async annotateSaved(url) {
      const vep = await MG.fetchJSON(url);
      attach(this.recs, vep);
      this.annotated = 'saved';
      this.render();
      bus.emit('vx:annotated', { source: 'saved', n: this.recs.length });
    }
    async annotateLive() {
      if (!this.recs.length) return toast('Load a VCF first.', 'warn');
      const btn = this.bar.querySelector('[data-x="vep"]');
      const status = this.bar.querySelector('.vx-status');
      if (btn) btn.disabled = true;
      try {
        const relP = vepRelease();
        const vep = await runVEP(this.recs, (i, n) => status && (status.innerHTML = `<span class="spinner small"></span> Ensembl VEP: ${Math.min(i + 150, n)} of ${n} variants…`));
        attach(this.recs, vep);
        this.annotated = 'live';
        this.vepInfo = { release: await relP, date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) };
        this.render();
        toast(`Annotated ${this.recs.length} variants with Ensembl VEP (GRCh37${this.vepInfo.release ? ', Ensembl release ' + this.vepInfo.release : ''}).`, 'ok');
        bus.emit('vx:annotated', { source: 'live', n: this.recs.length });
      } catch (e) {
        console.error(e);
        if (status) status.textContent = '';
        toast('Ensembl VEP did not answer (' + esc(e.message || e) + '). Try again in a minute' + (this.opts.savedUrl ? ', or use the saved results.' : '.'), 'error', 9000);
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    /* ---------- filters ---------- */
    /** the filters that are switched on, in a fixed order, as funnel stages {label, test} */
    filterStages(f = this.filters) {
      const st = [];
      if (f.impacts.size !== IMPACTS.length) {
        const imps = IMPACTS.filter((i) => f.impacts.has(i));
        st.push({
          key: 'impact',
          label: `Impact ${imps.join(' or ') || '(none ticked)'}${f.spliceKeep ? ', or SpliceAI ≥ 0.5' : ''}`,
          test: (r) => !!r.ann && (f.impacts.has(r.ann.impact) || (!!f.spliceKeep && r.ann.spliceai != null && r.ann.spliceai >= 0.5))
        });
      }
      if (f.maxAF !== 'any') {
        st.push({
          key: 'af',
          label: f.maxAF === 'novel' ? 'Not in dbSNP or gnomAD' : `Rarer than ${+f.maxAF * 100}% in gnomAD (or not in gnomAD)`,
          test: (r) => !!r.ann && (f.maxAF === 'novel' ? r.ann.af == null && !r.ann.rs : r.ann.af == null || r.ann.af < +f.maxAF)
        });
      }
      if (f.zyg !== 'any') st.push({ key: 'zyg', label: f.zyg === 'het' ? 'Heterozygous' : 'Homozygous', test: (r) => zygosity(r.gt) === f.zyg });
      if (f.gene) st.push({ key: 'gene', label: `Gene name contains “${f.gene}”`, test: (r) => !!r.ann && String(r.ann.gene || '').toLowerCase().includes(f.gene.toLowerCase()) });
      if (f.text) {
        const q = f.text.toLowerCase();
        st.push({
          key: 'text',
          label: `Matches “${f.text}”`,
          test: (r) => {
            const a = r.ann;
            return `${r.chrom}:${r.pos} ${r.ref}>${r.alt} ${a ? a.gene + ' ' + a.rs + ' ' + a.conseq + ' ' + a.protein : ''}`.toLowerCase().includes(q);
          }
        });
      }
      return st;
    }
    passes(r, f = this.filters) {
      return this.filterStages(f).every((s) => s.test(r));
    }
    visible() {
      const st = this.filterStages();
      const v = this.recs.filter((r) => st.every((s) => s.test(r)));
      const k = this.sortKey, d = this.sortDir;
      const val = (r) => {
        const a = r.ann || {};
        switch (k) {
          case 'pos': return r.chrom.replace('chr', '').padStart(3, '0') + String(r.pos).padStart(10, '0');
          case 'qual': return r.qual || 0;
          case 'gene': return a.gene || '~';
          case 'conseq': return rankOf([a.conseq]);
          case 'impact': return IMPACTS.indexOf(a.impact);
          case 'af': return a.af == null ? -1 : a.af;
          case 'cadd': return a.cadd == null ? -1 : a.cadd;
          case 'splice': return a.spliceai == null ? -1 : a.spliceai;
          default: return 0;
        }
      };
      return v.sort((x, y) => {
        const a = val(x), b = val(y);
        return (a < b ? -1 : a > b ? 1 : 0) * d;
      });
    }

    /* ---------- rendering ---------- */
    render() {
      if (!this.recs.length && !this.name) return this.renderEmpty();
      this.renderBar();
      const B = this.body;
      const keepScroll = B.scrollTop;
      B.innerHTML = '';
      if (!this.annotated) {
        B.appendChild(h('div.callout.info', h('div.co-t', `${MG.fmt(this.recs.length)} variants loaded from ${this.name}`), h('p', { html: 'So far these are just positions and alleles. Press <b>Annotate with VEP</b> to find out which genes and transcripts they fall in, what they do to the protein, how common they are and what prediction tools say.' })));
        B.appendChild(this.table(this.recs.slice(0, 200), false));
        return;
      }
      B.appendChild(this.filterBox());
      if (this.opts.funnel) B.appendChild(this.funnel());
      const vis = this.visible();
      B.appendChild(h('p.vx-countline', { html: `Showing <b class="vx-count">${MG.fmt(vis.length)}</b> of ${MG.fmt(this.recs.length)} variants. Click a row for details; click a column heading to sort.` }));
      if (this.sel && vis.includes(this.sel)) B.appendChild(this.detail(this.sel));
      B.appendChild(this.table(vis, true));
      B.scrollTop = keepScroll;
      bus.emit('vx:render', { shown: vis.length, total: this.recs.length, filters: this.filterSummary() });
    }
    renderBar() {
      const bar = this.bar;
      bar.innerHTML = '';
      bar.appendChild(h('span.fq-title', { html: MG.icon('table') + ' ' + esc(this.name || 'Variants') }));
      bar.appendChild(h('span.pill', `${MG.fmt(this.recs.length)} variants`));
      if (this.annotated === 'live') {
        const vi = this.vepInfo || {};
        bar.appendChild(h('span.pill.ok', { title: 'For your Methods: Ensembl VEP REST service, GRCh37, with the Ensembl release and date shown' }, `VEP · GRCh37${vi.release ? ' · Ensembl ' + vi.release : ''}${vi.date ? ' · ' + vi.date : ''}`));
      } else if (this.annotated) bar.appendChild(h('span.pill.ok', 'annotated by VEP (saved results)'));
      bar.appendChild(h('span.grow'));
      bar.appendChild(h('span.vx-status'));
      const run = h('button.btn.small' + (this.annotated ? '' : '.primary'), { type: 'button', dataset: { x: 'vep' }, html: MG.icon('sparkle') + '<span>' + (this.annotated === 'live' ? 'Re-run VEP' : 'Annotate with VEP') + '</span>', title: 'Sends the positions and alleles (no reads, no names) to Ensembl’s VEP server for GRCh37' });
      run.addEventListener('click', () => this.annotateLive());
      bar.appendChild(run);
      if (this.opts.savedUrl && this.annotated !== 'saved') {
        const sv = h('button.btn.small', { type: 'button', html: MG.icon('database') + '<span>Use saved results</span>', title: 'The same VEP results, saved when the practical was made (use if Ensembl is slow)' });
        sv.addEventListener('click', () => this.annotateSaved(this.opts.savedUrl).catch((e) => toast(esc(e.message), 'error')));
        bar.appendChild(sv);
      }
      if (this.opts.allowLoad) {
        const inp = h('input', { type: 'file', accept: '.vcf,.txt', hidden: true });
        const ob = h('button.btn.small', { type: 'button', html: MG.icon('folder') + '<span>Open a VCF…</span>', title: 'Use a VCF file from your computer instead' });
        ob.addEventListener('click', () => inp.click());
        inp.addEventListener('change', async () => {
          const f = inp.files[0];
          inp.value = '';
          if (!f) return;
          if (/\.gz$/i.test(f.name)) return toast('Please choose an uncompressed .vcf file (bcftools view -Ov).', 'warn', 6000);
          const n = this.setVCF(await f.text(), f.name);
          toast(`Loaded ${n} variants from <b>${esc(f.name)}</b>. Now annotate them with VEP.`);
        });
        bar.append(ob, inp);
      }
      if (this.annotated) {
        const dl = h('button.btn.small', { type: 'button', html: MG.icon('download') + '<span>Table</span>', title: 'Download the variants shown as a tab-separated table (opens in Excel)' });
        dl.addEventListener('click', () => this.downloadTSV());
        bar.appendChild(dl);
      }
    }
    filterBox() {
      const f = this.filters;
      const box = h('div.vx-filters');
      const imp = h('div.vx-imp', h('span.vx-lab', 'Impact'));
      IMPACTS.forEach((i) => {
        const cb = h('input', { type: 'checkbox' });
        cb.checked = f.impacts.has(i);
        cb.addEventListener('change', () => {
          if (cb.checked) f.impacts.add(i);
          else f.impacts.delete(i);
          this.changed('impact');
        });
        imp.appendChild(h('label.vx-cb', cb, h('span.imp.' + i, i)));
      });
      const spl = h('input', { type: 'checkbox' });
      spl.checked = !!f.spliceKeep;
      spl.addEventListener('change', () => {
        f.spliceKeep = spl.checked;
        this.changed('splice');
      });
      imp.appendChild(h('label.vx-cb', { title: 'Also keep variants that SpliceAI predicts change splicing (score ≥ 0.5), whatever their impact' }, spl, h('span', '+ SpliceAI ≥ 0.5')));
      box.appendChild(imp);
      const af = h('select');
      [['any', 'any'], ['0.05', '< 5%'], ['0.01', '< 1%'], ['0.001', '< 0.1%'], ['novel', 'not in databases']].forEach(([v, l]) => af.appendChild(h('option', { value: v }, l)));
      af.value = f.maxAF;
      af.addEventListener('change', () => {
        f.maxAF = af.value;
        this.changed('af');
      });
      box.appendChild(h('label', 'Population frequency (gnomAD)', af));
      const zy = h('select');
      [['any', 'any'], ['het', 'heterozygous'], ['hom', 'homozygous']].forEach(([v, l]) => zy.appendChild(h('option', { value: v }, l)));
      zy.value = f.zyg;
      zy.addEventListener('change', () => {
        f.zyg = zy.value;
        this.changed('zyg');
      });
      box.appendChild(h('label', 'Genotype', zy));
      const gene = h('input', { type: 'text', value: f.gene, placeholder: 'e.g. CYP2C19', size: 11 });
      gene.addEventListener('input', MG.debounce(() => {
        f.gene = gene.value.trim();
        this.changed('gene');
      }, 250));
      box.appendChild(h('label', 'Gene', gene));
      const txt = h('input', { type: 'search', value: f.text, placeholder: 'position, rs…', size: 12 });
      txt.addEventListener('input', MG.debounce(() => {
        f.text = txt.value.trim();
        this.changed('text');
      }, 250));
      box.appendChild(h('label', 'Search', txt));
      const reset = h('button.btn.small', { type: 'button', text: 'Show all' });
      reset.addEventListener('click', () => {
        f.impacts = new Set(IMPACTS);
        f.spliceKeep = false;
        f.maxAF = 'any';
        f.gene = '';
        f.zyg = 'any';
        f.text = '';
        this.changed('reset');
      });
      box.appendChild(reset);
      return box;
    }
    changed(what) {
      this.render();
      bus.emit('vx:filter', Object.assign({ what }, this.filterSummary()));
    }
    filterSummary() {
      const f = this.filters;
      const st = this.filterStages(f);
      return { impacts: Array.from(f.impacts).join(','), splice: !!f.spliceKeep, maxAF: f.maxAF, gene: f.gene, zyg: f.zyg, shown: this.recs.filter((r) => st.every((s) => s.test(r))).length };
    }
    setFunnel(stages, title, note) {
      this.opts.funnel = stages;
      this.opts.funnelTitle = title;
      this.opts.funnelNote = note;
      this.render();
    }
    /** a funnel: counts after each successive stage (stages come from the page) */
    funnel() {
      // 'filters': the funnel is built from the filters the student has switched on
      const own = this.opts.funnel === 'filters';
      const stages = own ? this.filterStages() : this.opts.funnel;
      const wrap = h('div.vx-funnel');
      wrap.appendChild(h('div.vx-funnel-h', h('b', this.opts.funnelTitle || 'Filtering funnel'), h('span.muted.small', own ? ' – one bar for each filter you set above, applied in this order' : ' – each bar keeps the variants that pass that step and every step above it')));
      let set = this.recs.slice();
      const max = Math.max(1, set.length);
      const rows = [{ label: 'All variant calls', n: set.length }];
      stages.forEach((s) => {
        set = set.filter((r) => r.ann && s.test(r));
        rows.push({ label: s.label, n: set.length });
      });
      const f = h('div.funnel');
      rows.forEach((r, i) => {
        const w = Math.max(0.6, (r.n / max) * 100);
        const bar = h('div.funnel-bar', { style: { width: w + '%', background: i === rows.length - 1 ? '#1baf7a' : '#2a78d6' } });
        f.appendChild(h('div.funnel-item', h('div.funnel-lab', (i ? i + '. ' : '') + r.label), h('div.funnel-row', h('div.funnel-track', bar), h('div.funnel-n', MG.fmt(r.n)))));
      });
      wrap.appendChild(f);
      if (own && !stages.length) wrap.appendChild(h('p.small', { html: 'No filters set yet. Use <b>Impact</b>, <b>Population frequency</b> and <b>Genotype</b> above; each filter you set adds a step to this funnel.' }));
      if (this.opts.funnelNote) wrap.appendChild(h('p.muted.small', { html: this.opts.funnelNote }));
      this.lastFunnel = rows;
      bus.emit('vx:funnel', { final: rows[rows.length - 1].n, rows: rows.map((r) => r.n).join(','), stages: rows.length - 1 });
      return wrap;
    }
    table(list, annotated) {
      const t = h('table.vx-table');
      const cols = annotated
        ? [['pos', 'Position'], [null, 'Change'], [null, 'Genotype (reads)'], ['gene', 'Gene'], ['conseq', 'Consequence'], ['impact', 'Impact'], [null, 'Protein'], [null, 'Known as'], ['af', 'gnomAD AF'], [null, 'SIFT'], [null, 'PolyPhen'], ['cadd', 'CADD'], ['splice', 'SpliceAI']]
        : [['pos', 'Position'], [null, 'REF'], [null, 'ALT'], ['qual', 'QUAL'], [null, 'Genotype'], [null, 'Reads (ref,alt)']];
      const tr = h('tr');
      cols.forEach(([k, lab]) => {
        const th = h('th', lab + (k && this.sortKey === k ? (this.sortDir > 0 ? ' ▲' : ' ▼') : ''));
        if (k) {
          th.addEventListener('click', () => {
            if (this.sortKey === k) this.sortDir = -this.sortDir;
            else {
              this.sortKey = k;
              this.sortDir = k === 'af' || k === 'pos' || k === 'conseq' || k === 'impact' ? 1 : -1;
            }
            this.render();
          });
          th.title = 'Sort';
        } else th.style.cursor = 'default';
        tr.appendChild(th);
      });
      t.appendChild(h('thead', tr));
      const tb = h('tbody');
      list.slice(0, 1500).forEach((r) => {
        const row = h('tr' + (r === this.sel ? '.sel' : ''));
        const a = r.ann || {};
        const pos = h('td.mono', `${r.chrom}:${MG.fmt(r.pos)}`);
        if (!annotated) {
          row.append(pos, h('td.mono', r.ref), h('td.mono', r.alt), h('td', r.qual == null ? '.' : r.qual.toFixed(1)), h('td', gtLabel(r)), h('td.mono', r.ad || ''));
        } else {
          row.append(
            pos,
            h('td.mono', shortAllele(r.ref) + '>' + shortAllele(r.alt)),
            h('td', gtLabel(r), r.ad ? h('span.muted.small', ' ' + r.ad) : null),
            h('td', h('b', a.gene || '')),
            h('td', { title: a.worst && a.worst !== a.conseq ? 'Most severe on any transcript: ' + nice(a.worst) : '' }, nice(a.conseq) + (a.worst && a.worst !== a.conseq && rankOf([a.worst]) < rankOf([a.conseq]) ? ' *' : '')),
            h('td', a.impact ? h('span.imp.' + a.impact, a.impact) : ''),
            h('td.mono', a.protein || ''),
            h('td.mono', a.rs || (r.ann ? h('span.muted', 'novel') : '')),
            h('td.num', afLabel(a.af)),
            h('td', predLabel(a.sift, 'sift')),
            h('td', predLabel(a.polyphen, 'polyphen')),
            h('td.num', a.cadd == null ? '' : a.cadd.toFixed(1)),
            h('td.num', a.spliceai == null ? '' : spliceLabel(a.spliceai))
          );
        }
        row.addEventListener('click', () => {
          this.sel = this.sel === r ? null : r;
          if (annotated) this.render();
          bus.emit('vx:select', { pos: r.pos, chrom: r.chrom, gene: a.gene || '', conseq: a.conseq || '', rs: a.rs || '' });
          if (this.sel && annotated) setTimeout(() => {
            const d = this.body.querySelector('.vx-card');
            if (d) d.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }, 30);
        });
        tb.appendChild(row);
      });
      t.appendChild(tb);
      const wrap = h('div.vx-tablewrap', t);
      if (list.length > 1500) wrap.appendChild(h('p.muted.small', `Showing the first 1,500 of ${MG.fmt(list.length)} – use the filters.`));
      return wrap;
    }
    detail(r) {
      const a = r.ann || {};
      const card = h('div.vx-card');
      const title = h('h4', `${a.gene || 'Intergenic'} · ${r.chrom}:${MG.fmt(r.pos)} ${r.ref}>${r.alt}`);
      const close = h('button.icon-btn', { type: 'button', title: 'Close', html: MG.icon('x') });
      close.addEventListener('click', () => {
        this.sel = null;
        this.render();
      });
      card.appendChild(h('div.vx-card-h', title, close));
      const kv = h('dl.vx-kv');
      const add = (k, v) => v != null && v !== '' && kv.append(h('dt', k), h('dd', v instanceof Node ? v : String(v)));
      add('Your call', `${gtLabel(r)} · QUAL ${r.qual == null ? '.' : r.qual.toFixed(1)}${r.ad ? ` · reads ref,alt = ${r.ad}` : ''}${r.dp != null ? ` · depth ${r.dp}` : ''}`);
      if (a.t) {
        add('Transcript', `${a.t.transcript_id}${a.t.canonical ? ' (canonical)' : ''} · ${a.t.biotype || ''}${a.t.strand ? ' · ' + (a.t.strand > 0 ? '+' : '−') + ' strand' : ''}`);
        add('Consequence', h('span', h('span.imp.' + a.impact, a.impact), ' ' + (a.t.consequence_terms || []).map(nice).join(', ')));
        add('Where', a.exon ? (a.t.exon ? 'exon ' + a.t.exon : a.exon) : '');
        add('HGVS', [a.hgvsc, a.hgvsp].filter(Boolean).join('  ·  ') || '');
        if (a.t.codons) add('Codons', a.t.codons + (a.t.amino_acids ? ` (${a.t.amino_acids})` : ''));
      } else add('Consequence', nice(a.worst));
      add('Known as', a.ids && a.ids.length ? a.ids.join(', ') : 'not in dbSNP (novel)');
      if (a.clin && a.clin.length) add('ClinVar', a.clin.map((s) => s.replace(/_/g, ' ')).join('; '));
      add('gnomAD', a.af == null ? (a.af1kg != null ? `no gnomAD frequency – but 1000 Genomes gives ${afLabel(a.af1kg)}, so absent from gnomAD does not mean rare here` : 'not seen') : `${afLabel(a.af)} (${a.afSrc})`);
      if (a.afPops) {
        const P = { gnomade_afr: 'African', gnomade_amr: 'Latino / admixed American', gnomade_asj: 'Ashkenazi Jewish', gnomade_eas: 'East Asian', gnomade_fin: 'Finnish', gnomade_mid: 'Middle Eastern', gnomade_nfe: 'Non-Finnish European', gnomade_sas: 'South Asian', gnomade_remaining: 'Remaining' };
        const tbl = h('table.table.small.vx-pops');
        Object.entries(P).forEach(([k, lab]) => a.afPops[k] != null && tbl.appendChild(h('tr', h('td', lab), h('td.num', afLabel(a.afPops[k])))));
        if (tbl.children.length) add('by ancestry', tbl);
      }
      if (a.sift) add('SIFT', `${a.sift.p.replace(/_/g, ' ')} (score ${a.sift.s}; below 0.05 = deleterious)`);
      if (a.polyphen) add('PolyPhen-2', `${a.polyphen.p.replace(/_/g, ' ')} (score ${a.polyphen.s}; closer to 1 = more damaging)`);
      if (a.cadd != null) add('CADD', `${a.cadd} (PHRED-scaled: 10 = top 10%, 20 = top 1% most deleterious of all possible changes)`);
      if (a.spliceDetail) {
        const s = a.spliceDetail;
        add('SpliceAI', `acceptor gain ${s.DS_AG} (at ${fmtOff(s.DP_AG)}), acceptor loss ${s.DS_AL} (at ${fmtOff(s.DP_AL)}), donor gain ${s.DS_DG} (at ${fmtOff(s.DP_DG)}), donor loss ${s.DS_DL} (at ${fmtOff(s.DP_DL)}) – scores above 0.5 predict a change in splicing`);
      }
      if (a.pubmed) add('Literature', `${a.pubmed} PubMed articles linked in dbSNP`);
      card.appendChild(kv);
      // other transcripts
      const tcs = r.vep ? r.vep.transcript_consequences || [] : [];
      if (tcs.length > 1) {
        const d = h('details');
        d.appendChild(h('summary', `All ${tcs.length} transcripts / genes affected`));
        const tt = h('table.table.small');
        tt.appendChild(h('tr', h('th', 'Gene'), h('th', 'Transcript'), h('th', 'Biotype'), h('th', 'Consequence'), h('th', 'Protein')));
        tcs.slice().sort((x, y) => rankOf(x.consequence_terms) - rankOf(y.consequence_terms)).forEach((t) =>
          tt.appendChild(h('tr', h('td', t.gene_symbol || ''), h('td.mono', t.transcript_id + (t.canonical ? ' ★' : '')), h('td', (t.biotype || '').replace(/_/g, ' ')), h('td', (t.consequence_terms || []).map(nice).join(', ')), h('td.mono', t.hgvsp ? t.hgvsp.split(':')[1].replace(/%3D/g, '=') : '')))
        );
        d.appendChild(tt);
        d.appendChild(h('p.muted.small', '★ = the canonical transcript, the one shown in the table.'));
        card.appendChild(d);
      }
      // links
      const L = h('div.vx-links');
      const link = (href, text) => L.appendChild(h('a.chip', { href, target: '_blank', rel: 'noopener' }, text, ' ↗'));
      const c = r.chrom.replace(/^chr/, '');
      if (a.rs) {
        link(`https://www.ncbi.nlm.nih.gov/snp/${a.rs}`, 'dbSNP');
        link(`https://grch37.ensembl.org/Homo_sapiens/Variation/Explore?v=${a.rs}`, 'Ensembl');
        link(`https://www.ncbi.nlm.nih.gov/clinvar/?term=${a.rs}`, 'ClinVar');
        link(`https://www.clinpgx.org/variant/${a.rs}`, 'ClinPGx (PharmGKB)');
      }
      link(`https://gnomad.broadinstitute.org/variant/${c}-${r.pos}-${r.ref}-${r.alt}?dataset=gnomad_r2_1`, 'gnomAD v2.1 (GRCh37 browser)');
      if (a.gene) link(`https://www.omim.org/search?search=${encodeURIComponent(a.gene)}`, 'OMIM');
      card.appendChild(L);
      const acts = h('div.vx-acts');
      if (this.opts.onIGV) {
        const b = h('button.btn.small', { type: 'button', html: MG.icon('genome') + '<span>Show the reads in IGV</span>' });
        b.addEventListener('click', () => this.opts.onIGV(r));
        acts.appendChild(b);
      }
      if (this.opts.on3D && a.t && a.t.protein_start) {
        const b = h('button.btn.small', { type: 'button', html: MG.icon('cube') + `<span>Residue ${a.t.protein_start} in 3D</span>` });
        b.addEventListener('click', () => this.opts.on3D(r));
        acts.appendChild(b);
      }
      if (acts.children.length) card.appendChild(acts);
      return card;
    }
    downloadTSV() {
      const vis = this.visible();
      const head = ['chrom', 'pos', 'ref', 'alt', 'qual', 'genotype', 'AD', 'gene', 'consequence', 'impact', 'HGVSc', 'HGVSp', 'known_as', 'gnomAD_AF', 'SIFT', 'PolyPhen', 'CADD', 'SpliceAI_max'];
      const rows = vis.map((r) => {
        const a = r.ann || {};
        return [r.chrom, r.pos, r.ref, r.alt, r.qual, r.gt, r.ad, a.gene, a.conseq, a.impact, a.hgvsc, a.hgvsp, a.ids ? a.ids.join(',') : '', a.af, a.sift ? a.sift.p + '(' + a.sift.s + ')' : '', a.polyphen ? a.polyphen.p + '(' + a.polyphen.s + ')' : '', a.cadd, a.spliceai].map((x) => (x == null ? '' : String(x)));
      });
      MG.downloadText([head].concat(rows).map((r) => r.join('\t')).join('\n') + '\n', (this.name || 'variants').replace(/\.vcf(\.gz)?$/, '') + '.annotated.tsv', 'text/tab-separated-values');
      bus.emit('vx:download', { n: rows.length });
    }
  }

  function fmtOff(n) {
    if (n == null) return '?';
    return (n > 0 ? '+' : '') + n + ' bp';
  }
  function shortAllele(s) {
    return s.length > 8 ? s.slice(0, 6) + '…' : s;
  }
  function gtLabel(r) {
    const z = zygosity(r.gt);
    return z === 'het' ? 'het (' + r.gt + ')' : z === 'hom' ? 'hom (' + r.gt + ')' : r.gt || '';
  }
  function afLabel(af) {
    if (af == null) return '–';
    if (af === 0) return '0';
    if (af >= 0.01) return (af * 100).toFixed(af >= 0.1 ? 0 : 1) + '%';
    const [m, e] = af.toExponential(1).split('e');
    return m + '×10' + e.replace(/[0-9+-]/g, (c) => (c === '-' ? '⁻' : c === '+' ? '' : '⁰¹²³⁴⁵⁶⁷⁸⁹'[+c]));
  }
  function predLabel(p, kind) {
    if (!p) return '';
    const bad = kind === 'sift' ? /deleterious/.test(p.p) : /damaging/.test(p.p);
    const lab = p.p.replace(/_low_confidence/, ' (low conf.)').replace(/_/g, ' ');
    return h('span.pred' + (bad ? '.bad' : '.ok'), { title: `${lab} (score ${p.s})` }, lab.replace('probably damaging', 'prob. damaging').replace('possibly damaging', 'poss. damaging'));
  }
  function spliceLabel(s) {
    return h('span' + (s >= 0.5 ? '.pred.bad' : ''), s.toFixed(2));
  }

  MG.VariantExplorer = VariantExplorer;
  MG.variantUtil = { parseVCF, runVEP, attach, rankOf, nice, zygosity, IMPACTS, afLabel };
})();
