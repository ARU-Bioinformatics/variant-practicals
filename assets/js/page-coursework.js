/* =====================================================================
   Coursework workbench – real samtools/bcftools (WebAssembly) on the
   student's own BAM file, which is read from their computer and never
   uploaded; Ensembl VEP for annotation; IGV; a 3D viewer.
   No answers are stored in this page.
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const { h, esc, bus, toast } = MG;
  MG.app = MG.app || {};
  MG.checks = MG.checks || {};
  MG.actions = MG.actions || {};
  const HOME = '/home/student';
  const BASE = HOME + '/coursework';
  const CW = 'data/coursework/';
  const REF = {
    fasta: CW + 'hg19_chr14_chr18.masked.fa.gz',
    fai: CW + 'hg19_chr14_chr18.masked.fa.gz.fai',
    gzi: CW + 'hg19_chr14_chr18.masked.fa.gz.gzi'
  };
  const GENOME = {
    fasta: REF.fasta,
    fai: REF.fai,
    gzi: REF.gzi,
    cytoband: 'data/annot/cytoBand.hg19.txt',
    genes: 'data/annot/refGene.chr14_18.txt',
    order: ['chr14', 'chr18']
  };

  const page = (MG.page = MG.page || {});
  page.firstBench = 'data';
  const fs = new MG.VFS(HOME);
  MG.app.fs = fs;
  const loaded = { bam: null, bai: null };

  function setupFiles() {
    fs.mkdirp(BASE + '/data');
    fs.mkdirp(BASE + '/results');
    const refHead = ['>chr14'].concat(Array.from({ length: 30 }, () => 'N'.repeat(50)));
    fs.put(BASE + '/ref/hg19.fa', { kind: 'virtual', protected: true, meta: { kind: 'fasta', size: 107349540 + 78077248 + Math.ceil((107349540 + 78077248) / 50), lines: Math.ceil(107349540 / 50) + Math.ceil(78077248 / 50) + 2, head: (n) => refHead.slice(0, n), tail: (n) => Array.from({ length: n }, () => 'N'.repeat(50)), backing: REF.fasta, describe: 'ASCII text (FASTA: hg19 chromosomes 14 and 18 – sequence kept near exome targets, N elsewhere)' } });
    fs.put(BASE + '/ref/hg19.fa.fai', { kind: 'url', url: REF.fai, size: 110, protected: true });
    fs.put(BASE + '/ref/hg19.fa.gzi', { kind: 'url', url: REF.gzi, size: 46360, protected: true, hidden: true });
    fs.writeText(
      BASE + '/README.txt',
      [
        'Coursework – exome of Bea Rienhoff (chromosomes 14 and 18)',
        '==========================================================',
        '',
        'data/     your BAM file and its index, read from your own computer.',
        '          They are NOT uploaded anywhere. Please do not share the',
        '          patient data outside your studies at ARU.',
        'ref/      hg19.fa – the hg19 reference for chromosomes 14 and 18',
        '          (sequence kept near the exome targets, N elsewhere)',
        'results/  write your output files here',
        '',
        'Suggested steps:',
        '  samtools idxstats data/daughters-reads.bam',
        '  bcftools mpileup -Ou -a AD,DP -f ref/hg19.fa -r chr14,chr18 data/daughters-reads.bam \\',
        '      | bcftools call -mv -Ov -o results/calls.vcf',
        "  bcftools view -i 'QUAL>=30 && INFO/DP>=10' results/calls.vcf > results/calls.filtered.vcf",
        '  download results/calls.filtered.vcf      (keep a copy for your records)',
        ''
      ].join('\n'),
      { protected: true }
    );
    fs.cwd = BASE;
  }
  setupFiles();

  const WELCOME = 'Coursework terminal. samtools 1.17 and bcftools 1.10 run inside this web page on the files you load from your computer – nothing is uploaded. Load your BAM and BAI files first (Data tab), then type  ls data  to check they are here.';

  /* ------------------------------------------------------------------
     loading the student's files
     ------------------------------------------------------------------ */
  async function addFiles(files) {
    const list = Array.from(files || []);
    const bams = list.filter((f) => /\.bam$/i.test(f.name));
    const bais = list.filter((f) => /\.(bai|csi)$/i.test(f.name));
    const vcfs = list.filter((f) => /\.vcf$/i.test(f.name));
    const other = list.filter((f) => !bams.includes(f) && !bais.includes(f) && !vcfs.includes(f));
    if (other.length) toast(`Ignored ${other.map((f) => esc(f.name)).join(', ')} – choose the .bam and .bai files (or a .vcf).`, 'warn', 7000);
    for (const f of bams) {
      fs.put(BASE + '/data/' + f.name, { kind: 'blob', blob: f, size: f.size, fresh: true, protected: true });
      loaded.bam = f;
    }
    for (const f of bais) {
      fs.put(BASE + '/data/' + f.name, { kind: 'blob', blob: f, size: f.size, fresh: true, protected: true });
      loaded.bai = f;
      // htslib looks for NAME.bam.bai: add that name as well
      const stem = f.name.replace(/\.(bai|csi)$/i, '').replace(/\.bam$/i, '');
      const ext = /\.csi$/i.test(f.name) ? '.csi' : '.bai';
      if (!/\.bam\.(bai|csi)$/i.test(f.name)) fs.put(BASE + '/data/' + stem + '.bam' + ext, { kind: 'blob', blob: f, size: f.size, protected: true, hidden: true });
    }
    for (const f of vcfs) {
      fs.writeText(BASE + '/results/' + f.name, await f.text(), { fresh: true });
    }
    renderDataStatus();
    if (bams.length || bais.length) {
      const ok = loaded.bam && loaded.bai;
      bus.emit('cw:files', { bam: !!loaded.bam, bai: !!loaded.bai, ok });
      if (ok) {
        toast(`Loaded <b>${esc(loaded.bam.name)}</b> and its index. They stay on your computer.`, 'ok');
        if (MG.app.igv && MG.app.igv.browser) igvLoadBam();
      } else if (loaded.bam) toast('Now add the index file (.bai) as well – programs need both.', 'warn', 7000);
    }
    if (vcfs.length) toast(`Copied ${vcfs.map((f) => esc(f.name)).join(', ')} into results/.`);
  }
  function renderDataStatus() {
    document.querySelectorAll('[data-cw-status]').forEach((el) => {
      const b = loaded.bam, i = loaded.bai;
      el.innerHTML = '';
      el.appendChild(h('div.cw-file' + (b ? '.ok' : ''), h('b', 'BAM: '), b ? `${b.name} (${MG.humanSize(b.size)}B)` : 'not loaded'));
      el.appendChild(h('div.cw-file' + (i ? '.ok' : ''), h('b', 'Index: '), i ? `${i.name} (${MG.humanSize(i.size)}B)` : 'not loaded'));
    });
  }
  function fileBox(el) {
    const inp = h('input', { type: 'file', multiple: true, accept: '.bam,.bai,.csi,.vcf', hidden: true });
    const btn = h('button.btn.primary', { type: 'button', html: MG.icon('folder') + '<span>Choose the BAM and BAI files…</span>' });
    btn.addEventListener('click', () => inp.click());
    inp.addEventListener('change', () => {
      addFiles(inp.files);
      inp.value = '';
    });
    const box = h('div.filebox', h('p', { html: 'Drag <b>daughters-reads.bam</b> and <b>daughters-reads.bai</b> here together, or' }), btn, inp, h('p.muted.small', 'Hold Ctrl (Windows) or ⌘ (Mac) to pick both files. They are read by this web page on your computer and are never uploaded.'), h('div.cw-status', { dataset: { cwStatus: '' } }));
    ['dragenter', 'dragover'].forEach((ev) => box.addEventListener(ev, (e) => {
      e.preventDefault();
      box.classList.add('over');
    }));
    ['dragleave', 'drop'].forEach((ev) => box.addEventListener(ev, (e) => {
      e.preventDefault();
      box.classList.remove('over');
    }));
    box.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
    el.appendChild(box);
    renderDataStatus();
  }

  /* ------------------------------------------------------------------
     workbench
     ------------------------------------------------------------------ */
  page.init = function () {
    document.querySelectorAll('[data-filebox]').forEach(fileBox);
    MG.app.term = new MG.TerminalUI(document.getElementById('termRoot'), { fs, hostname: 'coursework', welcome: WELCOME });
    MG.app.igv = new MG.IGVPanel(document.getElementById('igvRoot'), { genome: GENOME, locus: 'chr14', allowLocal: true, quick: [] });
    MG.app.vx = new MG.VariantExplorer(document.getElementById('vxRoot'), {
      allowLoad: true,
      funnel: FUNNEL.stages,
      funnelTitle: FUNNEL.title,
      funnelNote: FUNNEL.note,
      emptyHelp: 'Make a filtered VCF in the Terminal, then press <b>Use my filtered calls</b> below – or open a VCF file from your computer.',
      onIGV: (r) => {
        MG.app.showWorkbench('igv');
        MG.app.igv.goto(`${r.chrom}:${r.pos}`);
      }
    });
    const vxRoot = document.getElementById('vxRoot');
    const useBtn = h('button.btn.small.primary', { type: 'button', html: MG.icon('table') + '<span>Use my filtered calls</span>' });
    useBtn.addEventListener('click', () => MG.actions.vxMine('auto'));
    vxRoot.querySelector('.vx-body').appendChild(h('p', { style: { textAlign: 'center' } }, useBtn));
  };
  /* load the student's BAM into IGV once (again only if a different file is chosen) */
  let igvKey = null, igvPromise = Promise.resolve();
  function igvLoadBam() {
    if (!(loaded.bam && loaded.bai)) return MG.app.igv.ensure();
    const key = loaded.bam.name + ':' + loaded.bam.size + ':' + loaded.bai.size;
    if (igvKey === key) return igvPromise;
    igvKey = key;
    igvPromise = MG.app.igv
      .ensure()
      .then(() => MG.app.igv.loadLocalFiles([loaded.bam, loaded.bai]))
      .catch((e) => {
        igvKey = null;
        console.error(e);
      });
    return igvPromise;
  }
  page.lazy = {
    igv: () => igvLoadBam(),
    viewer: (pane) => MG.app.createViewer(pane.querySelector('#viewerRoot'))
  };

  /* the funnel is built from the filters each student chooses – no ready-made answer */
  const FUNNEL = {
    title: 'Your filtering funnel',
    stages: 'filters',
    note: 'Quality filtering was done when you made the VCF. Record each step, the reason for it and the number left in your filtering table – and think about what each filter might remove that you would want to keep.'
  };

  /* ------------------------------------------------------------------
     actions
     ------------------------------------------------------------------ */
  MG.actions.vxMine = async (arg) => {
    const res = fs.list(BASE + '/results').filter((c) => /\.vcf$/.test(c.name) && c.entry.kind === 'text');
    let pick = res.find((c) => /filt/i.test(c.name)) || res[0];
    if (arg && arg !== 'auto') pick = res.find((c) => c.name === arg) || pick;
    if (!pick) {
      toast('No VCF in results/ yet – run the variant-calling steps in the Terminal first.', 'warn', 7000);
      MG.app.showWorkbench('terminal');
      return;
    }
    MG.app.showWorkbench('variants');
    const n = MG.app.vx.setVCF(pick.entry.text, pick.name);
    toast(`Loaded ${n} variants from results/${esc(pick.name)}.`);
  };
  MG.actions.cwIgv = async () => {
    if (!(loaded.bam && loaded.bai)) {
      toast('Load your BAM and BAI files first (Data tab).', 'warn');
      MG.app.showWorkbench('data');
      return;
    }
    MG.app.showWorkbench('igv');
    await igvLoadBam();
  };
  MG.checks.cwLoaded = () => !!(loaded.bam && loaded.bai);
  MG.checks.cwVcf = (type, d, arg) => fs.list(BASE + '/results').some((c) => /\.vcf$/.test(c.name) && c.entry.kind === 'text' && (!arg || new RegExp(arg, 'i').test(c.name)) && /\n[^#]/.test(c.entry.text));
  MG.checks.vxAnnotated = () => !!(MG.app.vx && MG.app.vx.annotated);
  MG.checks.igvTrackAny = (type, d) => type === 'igv:track' && d.type === 'alignment';

  page.help = function () {
    MG.modal(
      'How this page works',
      `<p><b>Your data stay on your computer.</b> The BAM file is read by this web page in your browser; samtools and bcftools run here too (WebAssembly). Only when you press <b>Annotate with VEP</b> are the positions and alleles of your filtered variants – no reads, no names – sent to Ensembl, exactly as when you paste a VCF into the VEP web page.</p>
       <ul>
        <li><b>Data</b> – load the BAM and BAI files. <b>Terminal</b> – run the tools. <b>Variants</b> – annotate and filter. <b>IGV</b> – look at the reads. <b>3D viewer</b> – structures from the PDB.</li>
        <li>Files you make live in this browser tab. Use <code>download FILE</code> in the terminal to keep a copy, and keep a note of every command you run (the <span class="kbd">↑</span> key and <code>history</code> help) – your Methods section needs them.</li>
        <li>The notes boxes in the instructions are saved in this browser; <b>My notes</b> (top right) downloads them.</li>
       </ul>`
    );
  };
})();
