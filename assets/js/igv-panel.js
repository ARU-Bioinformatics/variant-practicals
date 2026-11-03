/* =====================================================================
   Genome browser tab: igv.js (Broad Institute, MIT licence) with a
   self-hosted hg19 reference (only the regions the practical needs are
   stored; everything else reads as N) and RefSeq gene models.
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const { h, esc, bus, toast } = MG;

  /* ------------------------------------------------------------------
     BAM files on the web server

     IGV reads a BAM file in pieces: for each region it asks the server
     for a range of bytes. GitHub Pages compresses .bam files on the fly
     for any browser that says it accepts gzip, and then cuts the range
     out of the compressed copy. Chrome, Edge, Safari and Firefox 148 or
     later ask for ranges uncompressed, so they get the right bytes.
     Older versions of Firefox, including Firefox ESR 140 (the long-term
     version that many organisations install), say they accept gzip even
     when they ask for a range. They are sent a piece of compressed data
     that they cannot decompress, and IGV stops with "Error accessing
     resource … status: 0".

     So before IGV opens a BAM file from the server, one small request
     asks for its last 28 bytes, which in every BAM file are the same
     end-of-file block. If those bytes come back intact, IGV reads the
     file in pieces as usual. If not, the whole file is downloaded once
     (an ordinary download, which the browser decompresses itself) and
     IGV reads it from memory.
     ------------------------------------------------------------------ */
  const BGZF_EOF = [31, 139, 8, 4, 0, 0, 0, 0, 0, 255, 6, 0, 66, 67, 2, 0, 27, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const hosted = new Map(); // absolute URL → Promise of what to give IGV: the URL, or the downloaded File

  /** the URL itself when the server sends ranges of a BAM file intact, otherwise the whole file (a File) */
  function hostedBam(url, onProgress) {
    const abs = new URL(url, location.href).href;
    if (!hosted.has(abs)) {
      const name = decodeURIComponent(new URL(abs).pathname.split('/').pop() || 'reads.bam');
      const p = (async () => {
        let r = null;
        try {
          r = await fetch(abs, { headers: { Range: 'bytes=-28' } });
        } catch (e) {
          r = null; // (the browser could not decompress the piece it was sent)
        }
        if (r && r.status === 206) {
          const end = new Uint8Array(await r.arrayBuffer().catch(() => new ArrayBuffer(0)));
          if (end.length === BGZF_EOF.length && BGZF_EOF.every((x, i) => end[i] === x)) return abs;
        } else if (r && r.ok) {
          // (a server that ignores ranges sends the whole file: IGV can read that)
          return new File([await r.blob()], name);
        }
        return downloadWhole(abs, name, onProgress);
      })();
      hosted.set(abs, p);
      p.catch(() => hosted.delete(abs));
    }
    return hosted.get(abs);
  }
  async function downloadWhole(url, name, onProgress) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${name} could not be downloaded (the server answered ${r.status})`);
    const size = Number(r.headers.get('Content-Length')) || 0;
    if (!r.body || !r.body.getReader || !onProgress) return new File([await r.blob()], name);
    const reader = r.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      onProgress(got, size);
    }
    return new File(parts, name);
  }

  class IGVPanel {
    constructor(root, opts) {
      this.root = root;
      this.opts = opts || {};
      this.browser = null;
      this.pending = [];
      this.trackNames = new Set();
      this._build();
    }
    _build() {
      this.root.classList.add('igv-root');
      this.bar = h('div.igv-bar');
      const quick = this.opts.quick || [];
      if (quick.length) {
        const q = h('div.igv-quick', h('span.muted', 'Jump to:'));
        quick.forEach(([label, locus]) => {
          const b = h('button.chip', { type: 'button', title: locus }, label);
          b.addEventListener('click', () => this.goto(locus));
          q.appendChild(b);
        });
        this.bar.appendChild(q);
      }
      this.statusEl = h('span.igv-status', { hidden: true, role: 'status' });
      this.bar.append(this.statusEl, h('span.grow'));
      if (this.opts.allowLocal) {
        const inp = h('input', { type: 'file', multiple: true, hidden: true, accept: '.bam,.bai,.vcf,.gz,.tbi,.csi,.bed' });
        const lb = h('button.btn.small', { type: 'button', html: MG.icon('folder') + '<span>Load files from my computer…</span>' });
        lb.addEventListener('click', () => inp.click());
        inp.addEventListener('change', () => {
          this.loadLocalFiles(Array.from(inp.files));
          inp.value = '';
        });
        this.bar.append(lb, inp);
      }
      const png = h('button.btn.small', { type: 'button', title: 'Download the current view as a PNG image for your report', html: MG.icon('camera') + '<span>Save image</span>' });
      png.addEventListener('click', () => this.savePNG());
      this.bar.appendChild(png);
      this.host = h('div.igv-host');
      this.help = h('p.igv-help', { html: 'Drag the tracks sideways to move, use + / − (or type a gene or position in the box) to zoom. Click a read or a variant for details. At the highest zoom the reference bases and the amino acids of each exon are shown.' });
      this.root.append(this.bar, this.host, this.help);
    }
    /** create the igv.js browser the first time the tab is shown */
    async ensure() {
      if (this.browser) return this.browser;
      if (this._creating) return this._creating;
      if (typeof window.igv === 'undefined') {
        this.host.innerHTML = '<div class="ex-empty"><h3>The genome browser could not load</h3><p>Check your internet connection and reload the page.</p></div>';
        throw new Error('igv.js missing');
      }
      const g = this.opts.genome;
      const cfg = {
        reference: {
          id: 'hg19',
          name: 'Human (GRCh37/hg19)',
          fastaURL: g.fasta,
          indexURL: g.fai,
          compressedIndexURL: g.gzi,
          cytobandURL: g.cytoband,
          chromosomeOrder: g.order
        },
        locus: this.opts.locus || 'chr10:96,540,000-96,543,000',
        showSVGButton: false,
        showCenterGuide: true,
        showCursorGuide: false,
        showNavigation: true,
        showTrackLabelButton: true,
        tracks: [
          {
            name: 'RefSeq genes',
            type: 'annotation',
            format: 'refgene',
            url: g.genes,
            displayMode: 'EXPANDED',
            height: 110,
            order: 1000000,
            searchable: true,
            color: '#1c5cab'
          }
        ]
      };
      this._creating = window.igv.createBrowser(this.host, cfg).then((b) => {
        this.browser = b;
        b.on('locuschange', (ref) => bus.emit('igv:locus', { locus: Array.isArray(ref) ? ref[0] && ref[0].locusSearchString : '' }));
        b.on('trackclick', (track, data) => {
          bus.emit('igv:click', { track: track && track.name, data });
          return undefined; // keep the default popup
        });
        const p = this.pending.slice();
        this.pending = [];
        return p.reduce((prom, fn) => prom.then(fn), Promise.resolve()).then(() => b);
      });
      return this._creating;
    }
    async goto(locus) {
      MG.app.showWorkbench && MG.app.showWorkbench('igv');
      const b = await this.ensure();
      await b.search(locus);
      bus.emit('igv:goto', { locus });
    }
    async addTrack(cfg) {
      const b = await this.ensure();
      cfg = Object.assign({ removable: true }, cfg);
      // a BAM file on the web server: make sure IGV can read it (see hostedBam above)
      if (cfg.type === 'alignment' && typeof cfg.url === 'string' && !/^(blob|data):/i.test(cfg.url)) cfg.url = await this._hostedBam(cfg.url);
      // replace a track with the same name
      const old = b.trackViews && b.trackViews.find((tv) => tv.track && tv.track.name === cfg.name);
      if (old) b.removeTrack(old.track);
      const t = await b.loadTrack(cfg);
      this.trackNames.add(cfg.name);
      bus.emit('igv:track', { name: cfg.name, type: cfg.type, format: cfg.format });
      return t;
    }
    async _hostedBam(url) {
      const name = decodeURIComponent(new URL(url, location.href).pathname.split('/').pop());
      const mb = (n) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
      let shown = '';
      const progress = (got, size) => {
        const done = size ? `(${Math.min(100, Math.round((got / size) * 100))}% of ${mb(size)})` : `(${mb(got)})`;
        if (done === shown) return;
        shown = done;
        this._status(`Downloading ${name} for IGV`, done);
      };
      try {
        return await hostedBam(url, progress);
      } catch (e) {
        toast(`IGV could not open <b>${esc(name)}</b>: ${esc(e.message || e)}. Check your internet connection and try again.`, 'error', 8000);
        throw e;
      } finally {
        if (shown) this._status('');
      }
    }
    /** a short message in the bar above the browser, and how far it has got (shown, but not read out by screen
        readers, which would otherwise announce every step); '' hides it */
    _status(text, progress) {
      if (!this.statusText) {
        this.statusText = h('span');
        this.statusProgress = h('span', { 'aria-hidden': 'true' });
        this.statusEl.append(h('span.spinner.small'), this.statusText, this.statusProgress);
      }
      this.statusEl.hidden = !text;
      if (this.statusText.textContent !== text) this.statusText.textContent = text;
      this.statusProgress.textContent = progress || '';
    }
    /** load files from the terminal's file system */
    async loadVfs(fs, paths) {
      MG.app.showWorkbench && MG.app.showWorkbench('igv');
      await this.ensure();
      for (const p of paths) {
        const e = fs.get(p);
        if (!e) {
          toast(`${esc(p)}: no such file`, 'error');
          continue;
        }
        const name = MG.path.basename(fs.resolve(p));
        if (/\.bam$/.test(name)) {
          const idx = fs.get(p + '.bai') || fs.get(p.replace(/\.bam$/, '.bai'));
          if (!idx) {
            toast(`IGV needs the index <b>${esc(name)}.bai</b> – run <code>samtools index ${esc(p)}</code> first.`, 'warn', 7000);
            continue;
          }
          const url = await this._urlOf(fs, p, e);
          const indexURL = await this._urlOf(fs, fs.get(p + '.bai') ? p + '.bai' : p.replace(/\.bam$/, '.bai'), idx);
          await this.addTrack({ type: 'alignment', format: 'bam', name, url, indexURL, height: 360, colorBy: 'strand', showSoftClips: false, displayMode: 'EXPANDED' });
        } else if (/\.vcf(\.gz)?$/.test(name)) {
          const url = await this._urlOf(fs, p, e);
          const cfg = { type: 'variant', format: 'vcf', name, url, displayMode: 'EXPANDED', height: 70, squishedHeight: 30, colorBy: 'none' };
          if (/\.gz$/.test(name)) {
            const tbi = fs.get(p + '.tbi') || fs.get(p + '.csi');
            if (tbi) cfg.indexURL = await this._urlOf(fs, fs.get(p + '.tbi') ? p + '.tbi' : p + '.csi', tbi);
            else cfg.indexed = false;
          }
          await this.addTrack(cfg);
        } else if (/\.bed$/.test(name)) {
          await this.addTrack({ type: 'annotation', format: 'bed', name, url: await this._urlOf(fs, p, e) });
        } else toast(`IGV cannot show ${esc(name)} – load BAM (+BAI) or VCF files.`, 'warn');
      }
    }
    async _urlOf(fs, p, e) {
      if (e.kind === 'url') return new URL(e.url, location.href).href;
      if (e.kind === 'virtual' && e.meta && e.meta.backing) return new URL(e.meta.backing, location.href).href;
      if (e.kind === 'blob') return e.blob;
      const blob = await fs.toBlob(p);
      return new File([blob], MG.path.basename(fs.resolve(p)));
    }
    /** files picked from the computer (coursework) */
    async loadLocalFiles(files) {
      MG.app.showWorkbench && MG.app.showWorkbench('igv');
      await this.ensure();
      const bams = files.filter((f) => /\.bam$/i.test(f.name));
      const bais = files.filter((f) => /\.bai$/i.test(f.name));
      const vcfs = files.filter((f) => /\.vcf(\.gz)?$/i.test(f.name));
      for (const bam of bams) {
        const base = bam.name.replace(/\.bam$/i, '');
        const bai = bais.find((f) => f.name === bam.name + '.bai' || f.name === base + '.bai');
        if (!bai) {
          toast(`Select the index <b>${esc(base)}.bai</b> together with ${esc(bam.name)} (hold Ctrl or ⌘ to pick both).`, 'warn', 8000);
          continue;
        }
        await this.addTrack({ type: 'alignment', format: 'bam', name: bam.name, url: bam, indexURL: bai, height: 360, displayMode: 'EXPANDED' });
      }
      for (const v of vcfs) {
        const idx = files.find((f) => f.name === v.name + '.tbi' || f.name === v.name + '.csi');
        const cfg = { type: 'variant', format: 'vcf', name: v.name, url: v, displayMode: 'EXPANDED' };
        if (idx) cfg.indexURL = idx;
        else cfg.indexed = false;
        await this.addTrack(cfg);
      }
      if (!bams.length && !vcfs.length) toast('Choose a .bam file with its .bai index, or a .vcf file.', 'warn');
    }
    async savePNG() {
      try {
        const b = await this.ensure();
        const svg = await b.toSVG();
        const blob = new Blob([svg], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        await new Promise((res, rej) => {
          img.onload = res;
          img.onerror = rej;
          img.src = url;
        });
        const scale = 2;
        const c = document.createElement('canvas');
        c.width = img.width * scale;
        c.height = img.height * scale;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        c.toBlob((png) => {
          MG.downloadBlob(png, 'igv-' + (b.currentLoci ? String(b.currentLoci()).replace(/[^A-Za-z0-9]+/g, '_') : 'view') + '.png');
          bus.emit('igv:image', {});
        });
      } catch (e) {
        console.error(e);
        toast('Could not make the image: ' + esc(e.message || e), 'error');
      }
    }
  }

  MG.IGVPanel = IGVPanel;

  /* terminal commands:  igv FILES…  [chr:pos]   and  open FILE */
  const T = (MG.shellTools = MG.shellTools || {});
  T.igv = {
    summary: 'show BAM/VCF files in the genome browser tab (e.g. igv results/aligned.sorted.bam chr10:96541616)',
    man: 'igv FILE.bam [FILE.vcf …] [LOCUS]   load files into the IGV tab and go to LOCUS (e.g. chr10:96,541,616 or CYP2C19)',
    run: async (ctx) => {
      const P = MG.app.igv;
      if (!P) throw MG.shellUtil.userErr('igv: the genome browser is not part of this page');
      const files = ctx.args.filter((a) => ctx.fs.exists(a));
      const loci = ctx.args.filter((a) => !ctx.fs.exists(a));
      if (!files.length && !loci.length) {
        MG.app.showWorkbench('igv');
        return 0;
      }
      if (files.length) {
        await P.loadVfs(ctx.fs, files);
        ctx.io.note(`Opened ${files.join(', ')} in the IGV tab.`);
      }
      if (loci.length) await P.goto(loci.join(' '));
      return 0;
    }
  };
})();
