/* =====================================================================
   "Variants to meaning" – page set-up: the annotated variant table
   (Ensembl VEP), the genome browser with the same reads, and the 3D
   viewer with CYP2C19, CYP2C9 and CYP2C8 structures.
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const { h, esc, bus, toast } = MG;
  MG.app = MG.app || {};
  MG.checks = MG.checks || {};
  MG.actions = MG.actions || {};
  const VCF_URL = 'data/meaning/calls.filtered.vcf';
  const VEP_URL = 'data/meaning/calls.filtered.vep.json';
  const READS = 'data/reads/';
  const GENOME = {
    fasta: READS + 'hg19.masked.fa.gz',
    fai: READS + 'hg19.masked.fa.gz.fai',
    gzi: READS + 'hg19.masked.fa.gz.gzi',
    cytoband: 'data/annot/cytoBand.hg19.txt',
    genes: 'data/annot/refGene.chr10.txt',
    order: ['chr1', 'chr2', 'chr3', 'chr4', 'chr5', 'chr6', 'chr7', 'chr8', 'chr9', 'chr10', 'chr11', 'chr12', 'chr13', 'chr14', 'chr15', 'chr16', 'chr17', 'chr18', 'chr19', 'chr20', 'chr21', 'chr22', 'chrX', 'chrY', 'chrM']
  };
  /* structures for the genes in this practical: PDB entry and chain */
  const STRUCTURES = {
    CYP2C19: { pdb: '4GQS', chain: 'A' },
    CYP2C9: { pdb: '1R9O', chain: 'A' },
    CYP2C8: { pdb: '2NNI', chain: 'A' }
  };

  const page = (MG.page = MG.page || {});
  page.firstBench = 'variants';

  /* ------------------------------------------------------------------
     filtering funnels
     ------------------------------------------------------------------ */
  const protein = (r) => r.ann && (r.ann.impact === 'HIGH' || r.ann.impact === 'MODERATE');
  const splice = (r) => r.ann && r.ann.spliceai != null && r.ann.spliceai >= 0.5;
  const rare = (r) => r.ann && (r.ann.af == null || r.ann.af < 0.01);
  const FUNNELS = {
    classic: {
      title: 'Rare-disease filtering (the classic way)',
      note: 'Quality filters were applied when the calls were made (QUAL ≥ 30, depth ≥ 10). “Changes the protein” = VEP impact HIGH or MODERATE on the canonical transcript. “Rare” = allele frequency below 1% in gnomAD, or not in gnomAD at all.',
      stages: [
        { label: 'Changes the protein (HIGH or MODERATE impact)', test: protein },
        { label: 'Rare (gnomAD AF < 1%)', test: rare }
      ]
    },
    splice: {
      title: 'Rare-disease filtering, keeping predicted splice changes',
      note: 'As before, but a variant also passes the first step if SpliceAI predicts it changes splicing (score ≥ 0.5).',
      stages: [
        { label: 'Changes the protein or splicing', test: (r) => protein(r) || splice(r) },
        { label: 'Rare (gnomAD AF < 1%)', test: rare }
      ]
    },
    pgx: {
      title: 'Pharmacogenomic look-up',
      note: 'Pharmacogenomics asks a different question: which known, often common, variants does this person carry in genes that handle drugs?',
      stages: [
        { label: 'In a pharmacogene (CYP2C8, CYP2C9, CYP2C19)', test: (r) => /^CYP2C(8|9|19)$/.test(r.ann.gene || '') },
        { label: 'Known variant (has an rs number)', test: (r) => !!r.ann.rs },
        { label: 'Changes the protein or splicing', test: (r) => protein(r) || splice(r) }
      ]
    }
  };

  /* ------------------------------------------------------------------
     workbench set-up
     ------------------------------------------------------------------ */
  let tracksLoaded = null;
  page.init = function () {
    const vx = (MG.app.vx = new MG.VariantExplorer(document.getElementById('vxRoot'), {
      savedUrl: VEP_URL,
      allowLoad: true,
      funnel: FUNNELS.classic.stages,
      funnelTitle: FUNNELS.classic.title,
      funnelNote: FUNNELS.classic.note,
      emptyHelp: 'Loading the variants from <i>Reads to variants</i>…',
      onIGV: (r) => showInIGV(r.chrom + ':' + r.pos),
      on3D: (r) => showIn3D(r)
    }));
    MG.fetchText(VCF_URL)
      .then((t) => {
        vx.setVCF(t, 'calls.filtered.vcf');
        bus.emit('page:ready', {});
      })
      .catch((e) => {
        console.error(e);
        vx.renderEmpty('The variant file could not be loaded – check your connection and reload the page.');
      });
    MG.app.igv = new MG.IGVPanel(document.getElementById('igvRoot'), {
      genome: GENOME,
      locus: 'chr10:96,541,560-96,541,680',
      quick: [
        ['CYP2C19*2', 'chr10:96,541,596-96,541,636'],
        ['CYP2C9*2', 'chr10:96,702,027-96,702,067'],
        ['CYP2C8 R139K', 'chr10:96,827,010-96,827,050'],
        ['CYP2C8 K399R', 'chr10:96,798,729-96,798,769']
      ]
    });
  };
  page.lazy = {
    igv: () => loadTracks(),
    viewer: (pane) => MG.app.createViewer(pane.querySelector('#viewerRoot'))
  };
  function loadTracks() {
    if (tracksLoaded) return tracksLoaded;
    const P = MG.app.igv;
    tracksLoaded = P.ensure()
      .then(() => P.addTrack({ type: 'variant', format: 'vcf', name: 'calls.filtered.vcf', url: new URL(VCF_URL, location.href).href, indexed: false, displayMode: 'EXPANDED', height: 60 }))
      .then(() => P.addTrack({ type: 'alignment', format: 'bam', name: 'NA12878 reads (aligned.sorted.bam)', url: new URL(READS + 'aligned.sorted.bam', location.href).href, indexURL: new URL(READS + 'aligned.sorted.bam.bai', location.href).href, height: 340, displayMode: 'EXPANDED', colorBy: 'strand' }))
      .catch((e) => {
        console.error(e);
        tracksLoaded = null;
      });
    return tracksLoaded;
  }
  async function showInIGV(locus) {
    MG.app.showWorkbench('igv');
    await loadTracks();
    await MG.app.igv.goto(locus);
  }
  async function showIn3D(r) {
    const g = r.ann && r.ann.gene;
    const s = STRUCTURES[g];
    const pos = r.ann && r.ann.t && r.ann.t.protein_start;
    if (!s) {
      toast(`No structure of ${esc(g || 'this gene')} is stored with this practical – search the PDB or AlphaFold for it.`, 'warn', 6000);
      return;
    }
    MG.app.showWorkbench('viewer');
    const S = `${s.pdb} ${s.chain}`;
    await MG.commands.run(`load ${s.pdb}; isolate ${S} or haem; show cartoon ${S}; color ss ${S}; show sticks ${s.pdb} haem; select ${s.pdb} ${s.chain}:${pos}; show spheres sele; color orange sele; label sele; center sele`, { prefix: '▶ ' });
    bus.emit('vx:3d', { gene: g, pos });
  }

  /* ------------------------------------------------------------------
     page actions for ▶ buttons: data-vx="saved|live|funnel:NAME|gene:NAME|reset"
     ------------------------------------------------------------------ */
  MG.actions.vx = async (arg) => {
    const vx = MG.app.vx;
    MG.app.showWorkbench('variants');
    const [k, v] = arg.split(':');
    if (k === 'saved') await vx.annotateSaved(VEP_URL);
    else if (k === 'live') await vx.annotateLive();
    else if (k === 'funnel') {
      const f = FUNNELS[v];
      if (!vx.annotated) await vx.annotateSaved(VEP_URL);
      vx.setFunnel(f.stages, f.title, f.note);
      bus.emit('vx:funnelset', { name: v });
    } else if (k === 'gene' || k === 'find') {
      if (!vx.annotated) await vx.annotateSaved(VEP_URL);
      vx.filters.impacts = new Set(MG.variantUtil.IMPACTS);
      vx.filters.maxAF = 'any';
      vx.filters.gene = k === 'gene' ? v : '';
      vx.filters.text = k === 'find' ? arg.slice(5) : '';
      vx.filters.zyg = 'any';
      vx.sel = null;
      if (k === 'find') {
        const hit = vx.recs.find((r) => String(r.pos) === arg.slice(5).split(':').pop());
        if (hit) vx.sel = hit;
      }
      vx.changed(k);
    } else if (k === 'reset') {
      vx.filters.impacts = new Set(MG.variantUtil.IMPACTS);
      vx.filters.maxAF = 'any';
      vx.filters.gene = '';
      vx.filters.text = '';
      vx.filters.zyg = 'any';
      vx.changed('reset');
    }
  };
  MG.actions.igvGo = async (arg) => showInIGV(arg);

  /* checks for tasks */
  MG.checks.vxAnnotated = () => !!(MG.app.vx && MG.app.vx.annotated);

  page.help = function () {
    MG.modal(
      'How this page works',
      `<p><b>Left:</b> the instructions. <b>Right:</b> the workbench – the <b>Variants</b> table (annotated by Ensembl VEP), the <b>IGV</b> genome browser with NA12878's reads, and a <b>3D viewer</b>.</p>
       <ul>
        <li>In the Variants table, click a row for details and links to the databases; click a column heading to sort; use the filters above the table.</li>
        <li><button class="do showme" type="button" disabled>show me</button> buttons do a step for you – try it yourself first.</li>
        <li>3D viewer: left-drag rotates, scroll zooms, right-drag moves; the command line at the bottom accepts commands such as <code>select A:227</code> or <code>show spheres haem</code> (type <code>help</code>).</li>
        <li>Your answers are saved in this browser – use <b>My answers</b> to download them.</li>
       </ul>`
    );
  };
})();
