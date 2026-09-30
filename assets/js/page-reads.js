/* =====================================================================
   "Reads to variants" – page set-up: the terminal and its files, the
   FastQC report viewer, the genome browser and the Galaxy-style
   workflow engine (tools, the preloaded workflow and the history).
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const { h, esc, bus, toast } = MG;
  MG.app = MG.app || {};
  MG.checks = MG.checks || {};
  MG.actions = MG.actions || {};
  const DATA = 'data/reads/';
  const HOME = '/home/student';
  const BASE = HOME + '/practical';
  const GREF = '/galaxy/tool-data/hg19/seq/hg19.fa';

  const GENOME = {
    fasta: DATA + 'hg19.masked.fa.gz',
    fai: DATA + 'hg19.masked.fa.gz.fai',
    gzi: DATA + 'hg19.masked.fa.gz.gzi',
    cytoband: 'data/annot/cytoBand.hg19.txt',
    genes: 'data/annot/refGene.chr10.txt',
    order: ['chr1', 'chr2', 'chr3', 'chr4', 'chr5', 'chr6', 'chr7', 'chr8', 'chr9', 'chr10', 'chr11', 'chr12', 'chr13', 'chr14', 'chr15', 'chr16', 'chr17', 'chr18', 'chr19', 'chr20', 'chr21', 'chr22', 'chrX', 'chrY', 'chrM']
  };

  const page = (MG.page = MG.page || {});
  page.firstBench = 'terminal';
  const fs = new MG.VFS(HOME);
  MG.app.fs = fs;

  const ready = MG.fetchJSON(DATA + 'sim.json').then((d) => {
    MG.simData = d;
    MG.simSetup(fs, 'practical');
    galaxyReference(d);
    return d;
  });
  page.ready = ready;

  /* the reference genome as the workflow engine sees it (shared "tool data") */
  function galaxyReference(d) {
    const r = d.ref;
    fs.put(GREF, { kind: 'virtual', protected: true, meta: { kind: 'fasta', size: r.bytes, lines: r.lines, head: (n) => r.head.slice(0, n), tail: (n) => r.tail.slice(-n), backing: r.fasta } });
    fs.put(GREF + '.fai', { kind: 'url', url: r.fai, size: r.faiBytes, protected: true });
    fs.put(GREF + '.gzi', { kind: 'url', url: r.gzi, size: r.gziBytes, protected: true });
    Object.entries(r.bwaIndex).forEach(([ext, size]) => fs.put(GREF + '.' + ext, { kind: 'virtual', protected: true, meta: { kind: 'bwa-index', size, binary: true, lines: 0, head: () => [] } }));
  }

  const WELCOME = 'This is a Linux command line running inside the web page. samtools and bcftools are the real programs (compiled to WebAssembly); FastQC and BWA replay real runs on the same data, because they are too big for a browser. Nothing you do here is uploaded.\nType  ls  and press Enter to start, or  help  for the list of commands.';

  /* ------------------------------------------------------------------
     workbench set-up
     ------------------------------------------------------------------ */
  page.init = function () {
    MG.app.fastqc = new MG.FastQCView(document.getElementById('reportRoot'));
    MG.app.igv = new MG.IGVPanel(document.getElementById('igvRoot'), {
      genome: GENOME,
      locus: 'chr10:96,535,000-96,545,000',
      quick: [
        ['CYP2C19', 'CYP2C19'],
        ['CYP2C19 exon 5', 'chr10:96,541,560-96,541,680'],
        ['CYP2C9', 'CYP2C9'],
        ['CYP2C8', 'CYP2C8']
      ]
    });
    const termRoot = document.getElementById('termRoot');
    termRoot.innerHTML = '<div class="ex-empty"><span class="spinner"></span><p>Loading the practical files…</p></div>';
    const gxRoot = document.getElementById('gxRoot');
    ready
      .then(() => {
        termRoot.innerHTML = '';
        MG.app.term = new MG.TerminalUI(termRoot, { fs, hostname: 'genomics', welcome: WELCOME });
        MG.app.gx = new MG.WorkflowEngine(gxRoot, {
          fs,
          tools: TOOLS,
          workflows: [WORKFLOW],
          historyName: 'NA12878 exome – CYP2C region',
          datasets: ['R1', 'R2'].map((k) => {
            const f = MG.simData.fastq[k];
            return { name: f.name, ext: 'fastqsanger.gz', size: f.gzBytes, entry: Object.assign({}, fs.get(BASE + '/data/' + f.name)), protected: true, info: `${MG.fmt(f.reads)} sequences`, peek: f.head.slice(0, 4).join('\n'), source: 'Imported from the course data library (1000 Genomes run SRR098401)' };
          })
        });
        bus.emit('page:ready', {});
      })
      .catch((e) => {
        console.error(e);
        termRoot.innerHTML = '<div class="ex-empty"><h3>The practical files could not be loaded</h3><p>Check your internet connection and reload the page. If you opened the page straight from your computer (file://), use the web address instead.</p></div>';
      });
  };
  /* the Galaxy-style layout needs room: give the workbench more width while it is shown */
  bus.on('app:bench', ({ name }) => document.body.classList.toggle('wide-bench', name === 'galaxy'));

  page.lazy = {
    igv: () => MG.app.igv.ensure().catch((e) => console.error(e))
  };
  page.help = function () {
    MG.modal(
      'How this page works',
      `<p><b>Left:</b> the instructions. <b>Right:</b> the workbench – a <b>Terminal</b>, a <b>Report</b> viewer for FastQC, the <b>IGV</b> genome browser and a Galaxy-style <b>Workflow engine</b>.</p>
       <ul>
        <li><button class="do showme" type="button" disabled>show me</button> buttons type a command for you (press <span class="kbd">Enter</span> to run it) – or do the step for you. Try it yourself first.</li>
        <li>In the terminal: <span class="kbd">↑</span>/<span class="kbd">↓</span> recall earlier commands, <span class="kbd">Tab</span> completes file names, <span class="kbd">Ctrl</span>+<span class="kbd">C</span> cancels, <code>help</code> lists the commands and <code>man samtools</code> explains one.</li>
        <li>Steps tick themselves when the page sees you do them. Your answers are saved in this browser – use <b>My answers</b> to download them.</li>
        <li>The files you make live in this browser tab. If you reload, re-run the commands (the ↑ key remembers them).</li>
       </ul>`
    );
  };

  /* ------------------------------------------------------------------
     checks used by tasks (data-check="name:arg")
     ------------------------------------------------------------------ */
  const at = (p) => (p.startsWith('/') ? p : BASE + '/' + p);
  MG.checks.exists = (type, d, arg) => fs.exists(at(arg));
  MG.checks.sortedBam = () => fs.list(BASE + '/results').some((c) => /\.bam$/.test(c.name) && c.entry.meta && c.entry.meta.sorted);
  MG.checks.baiMade = () => fs.list(BASE + '/results').some((c) => /\.bai$/.test(c.name));
  MG.checks.vcfMade = () => fs.list(BASE + '/results').some((c) => /\.vcf$/.test(c.name) && c.entry.kind === 'text' && /\n[^#]/.test(c.entry.text));
  MG.checks.igvAt = (type, d, arg) => {
    if (type !== 'igv:locus') return false;
    const m = /:([\d,]+)-([\d,]+)/.exec(d.locus || '');
    if (!m) return false;
    const a = +m[1].replace(/,/g, ''), b = +m[2].replace(/,/g, '');
    return a <= +arg && b >= +arg && b - a < 400;
  };
  MG.checks.igvTrack = (type, d, arg) => type === 'igv:track' && new RegExp(arg, 'i').test(d.name || '');

  /* ------------------------------------------------------------------
     page actions for ▶ buttons:  data-gx="tool:ID" | "workflows" | "home"
     ------------------------------------------------------------------ */
  MG.actions.gx = async (arg) => {
    await ready;
    MG.app.showWorkbench('galaxy');
    const gx = MG.app.gx;
    if (arg === 'workflows') gx.showWorkflows();
    else if (arg === 'home') gx.showHome();
    else if (arg.startsWith('tool:')) gx.showTool(arg.slice(5));
    else if (arg === 'editor') gx.showEditor(0);
  };
  MG.actions.igvLoad = async (arg) => {
    await ready;
    const paths = arg.split(',').map((p) => at(p.trim()));
    const missing = paths.filter((p) => !fs.exists(p));
    if (missing.length) {
      toast(`First make <b>${esc(missing.map((p) => p.replace(BASE + '/', '')).join(', '))}</b> in the terminal.`, 'warn', 6000);
      return;
    }
    await MG.app.igv.loadVfs(fs, paths);
  };
  MG.actions.report = async (arg) => {
    await ready;
    MG.app.showWorkbench('report');
    await MG.app.fastqc.load(arg, MG.simData.fastqc[arg].json);
  };

  /* ------------------------------------------------------------------
     Galaxy-style tools. command(inPaths, params) is run in the job's
     working directory by the same shell and programs as the terminal.
     ------------------------------------------------------------------ */
  const q = (s) => `'${s}'`;
  const inFq = (d) => ({ name: 'reads', label: 'Raw read data from your current history', short: 'reads', ext: ['fastqsanger.gz', 'fastqsanger'], pick: d });
  const fastqOfDs = (engine, job) => {
    const ds = engine.ds(job.inputs[0].hid);
    const e = ds && engine.fs.get(ds.path);
    return e && e.meta && e.meta.fastq;
  };

  const TOOLS = [
    {
      id: 'fastqc',
      name: 'FastQC',
      version: '0.12.1',
      section: 'FASTQ Quality Control',
      desc: 'Read Quality reports',
      inputs: [inFq(null)],
      params: [{ name: 'nogroup', label: 'Disable grouping of bases for reads >50bp', type: 'bool', default: false, help: 'Leave this off – grouping keeps the plots readable.' }],
      inputName: (n, ds) => {
        let s = ds.name.replace(/[^\w\-.]/g, '_');
        if (/\.gz$/.test(ds.ext) && !/\.gz$/.test(s)) s += '.gz';
        return s;
      },
      command: (p, params) => {
        const stem = p.reads.replace(/\.(fastq|fq)(\.gz)?$/, '');
        return [`fastqc --outdir . --threads 2 --quiet --extract${params.nogroup ? ' --nogroup' : ''} -f fastq ${q(p.reads)}`, `cp ${q(stem + '_fastqc/fastqc_data.txt')} output_raw.txt`, `cp ${q(stem + '_fastqc.html')} output_html.html`];
      },
      outputs: [
        {
          name: 'html_file',
          short: 'Webpage',
          ext: 'html',
          label: (inDs) => `FastQC on data ${inDs[0].hid}: Webpage`,
          file: () => 'output_html.html',
          describe: (engine, d, job) => ({ report: fastqOfDs(engine, job), info: 'FastQC report', peek: 'HTML file (open it with the eye icon)' })
        },
        {
          name: 'text_file',
          short: 'RawData',
          ext: 'txt',
          label: (inDs) => `FastQC on data ${inDs[0].hid}: RawData`,
          file: () => 'output_raw.txt',
          describe: (engine, d) => {
            const t = engine.fs.get(d.path).text || '';
            return { info: `${t.split('\n').length} lines`, peek: t.split('\n').slice(0, 6).join('\n') };
          }
        }
      ],
      help: '<p>FastQC checks raw reads: quality along the reads, base composition, GC content, duplication and adapters. Open the <b>Webpage</b> output with the eye icon. <b>RawData</b> holds the same numbers as text (fastqc_data.txt).</p>',
      minSeconds: 2
    },
    {
      id: 'bwa_mem',
      name: 'Map with BWA-MEM',
      version: '0.7.19',
      section: 'Mapping',
      desc: '– map medium and long reads (> 100 bp) against reference genome',
      inputs: [
        { name: 'fastq_input1', label: 'Select first set of reads', short: 'forward reads', ext: ['fastqsanger.gz', 'fastqsanger'], pick: (d) => /R1/.test(d.name) },
        { name: 'fastq_input2', label: 'Select second set of reads', short: 'reverse reads', ext: ['fastqsanger.gz', 'fastqsanger'], pick: (d) => /R2/.test(d.name) }
      ],
      params: [
        { name: 'ref', label: 'Using reference genome', type: 'select', options: [['hg19', 'Human Feb. 2009 (GRCh37/hg19) (hg19)']], default: 'hg19', short: 'reference' },
        { name: 'mode', label: 'Single or Paired-end reads', type: 'select', options: [['paired', 'Paired (two files: forward and reverse)']], default: 'paired', short: 'reads' }
      ],
      inputName: (n) => (n === 'fastq_input1' ? 'input_f.fastq.gz' : 'input_r.fastq.gz'),
      command: (p) => `bwa mem -t 2 -v 1 ${q(GREF)} ${q(p.fastq_input1)} ${q(p.fastq_input2)} | samtools sort -@ 2 -T ./tmp -O bam -o output.bam`,
      outputs: [
        {
          name: 'bam_output',
          short: 'bam',
          ext: 'bam',
          label: (inDs) => `Map with BWA-MEM on data ${inDs[1].hid} and data ${inDs[0].hid} (mapped reads in BAM format)`,
          file: () => 'output.bam',
          describe: (engine, d) => {
            const S = MG.simData.sorted;
            // Galaxy indexes every BAM dataset automatically (stored as metadata)
            engine.fs.put(d.path + '.bai', { kind: 'url', url: S.bai, size: S.baiBytes || 0 });
            return { info: `${MG.fmt(MG.simData.bwa.sam.records)} alignments, sorted by position`, peek: 'Binary bam alignments file' };
          }
        }
      ],
      help: '<p>Aligns paired-end reads to the reference genome with BWA-MEM and sorts the alignments by position (Galaxy pipes BWA straight into <code>samtools sort</code>). The BAM index (.bai) is made automatically.</p>',
      minSeconds: 3
    },
    {
      id: 'samtools_flagstat',
      name: 'Samtools flagstat',
      version: '1.17',
      section: 'SAM/BAM',
      desc: 'tabulate descriptive stats for BAM datset',
      inputs: [{ name: 'input1', label: 'BAM File to Convert', short: 'alignments', ext: ['bam', 'sam'] }],
      params: [],
      inputName: () => 'input.bam',
      command: () => 'samtools flagstat input.bam > output.txt',
      outputs: [{ name: 'output1', ext: 'txt', label: (inDs) => `Samtools flagstat on data ${inDs[0].hid}`, file: () => 'output.txt', describe: (engine, d) => ({ info: 'flagstat summary', peek: (engine.fs.get(d.path).text || '').split('\n').slice(0, 5).join('\n') }) }],
      help: '<p>Counts the alignments by their flags: mapped, properly paired, duplicates, secondary and supplementary alignments.</p>'
    },
    {
      id: 'samtools_idxstats',
      name: 'Samtools idxstats',
      version: '1.17',
      section: 'SAM/BAM',
      desc: 'reports stats of the BAM index file',
      inputs: [{ name: 'input', label: 'BAM file', short: 'alignments', ext: ['bam'] }],
      params: [],
      inputName: () => 'input.bam',
      command: () => 'samtools idxstats input.bam > output.tabular',
      outputs: [{ name: 'output', ext: 'tabular', label: (inDs) => `Samtools idxstats on data ${inDs[0].hid}`, file: () => 'output.tabular', describe: (engine, d) => ({ info: `${(engine.fs.get(d.path).text || '').trim().split('\n').length} lines`, peek: (engine.fs.get(d.path).text || '').split('\n').slice(0, 5).join('\n') }) }],
      help: '<p>For every chromosome: its length, the number of mapped reads and the number of unmapped reads placed there (their mate is mapped).</p>'
    },
    {
      id: 'bcftools_mpileup',
      name: 'bcftools mpileup',
      version: '1.10',
      section: 'Variant Calling',
      desc: 'Generate VCF or BCF containing genotype likelihoods for one or multiple alignment (BAM or CRAM) files',
      inputs: [{ name: 'input_file', label: 'Alignment file (BAM)', short: 'alignments', ext: ['bam'] }],
      params: [
        { name: 'ref', label: 'Reference genome', type: 'select', options: [['hg19', 'Human Feb. 2009 (GRCh37/hg19) (hg19)']], default: 'hg19', short: 'reference' },
        { name: 'annotate', label: 'Add allele depths (FORMAT/AD and FORMAT/DP)', type: 'bool', default: true, short: 'AD,DP' },
        { name: 'otype', label: 'Output type', type: 'select', options: [['b', 'compressed BCF'], ['z', 'compressed VCF']], default: 'b', short: 'output' }
      ],
      inputName: () => 'input.bam',
      command: (p, params) => `bcftools mpileup --fasta-ref ${q(GREF)}${params.annotate ? ' --annotate FORMAT/AD,FORMAT/DP' : ''} --output-type ${params.otype} --output ${params.otype === 'z' ? 'output.vcf.gz' : 'output.bcf'} input.bam`,
      outputs: [
        {
          name: 'output_file',
          short: 'pileup',
          ext: (params) => (params.otype === 'z' ? 'vcf_bgzip' : 'bcf'),
          label: (inDs) => `bcftools mpileup on data ${inDs[0].hid}`,
          file: (params) => (params.otype === 'z' ? 'output.vcf.gz' : 'output.bcf'),
          describe: () => ({ info: 'genotype likelihoods at every covered position', peek: 'Binary BCF file' })
        }
      ],
      help: '<p>Piles up the reads at every position of the genome that has coverage and computes genotype likelihoods. The output is large – it is the input for <b>bcftools call</b>. This step reads the whole BAM file, so it takes about a minute here.</p>'
    },
    {
      id: 'bcftools_call',
      name: 'bcftools call',
      version: '1.10',
      section: 'Variant Calling',
      desc: 'SNP/indel variant calling from VCF/BCF',
      inputs: [{ name: 'input_file', label: 'VCF/BCF Data', short: 'pile-up', ext: ['bcf', 'vcf_bgzip', 'vcf'] }],
      params: [
        { name: 'method', label: 'Calling method', type: 'select', options: [['m', 'Multiallelic caller (-m)'], ['c', 'Consensus caller (-c)']], default: 'm', short: 'caller' },
        { name: 'vonly', label: 'Output variant sites only (-v)', type: 'bool', default: true, short: 'variants only' }
      ],
      inputName: (n, ds) => (ds.ext === 'bcf' ? 'input.bcf' : ds.ext === 'vcf_bgzip' ? 'input.vcf.gz' : 'input.vcf'),
      command: (p, params) => `bcftools call ${params.method === 'c' ? '--consensus-caller' : '--multiallelic-caller'}${params.vonly ? ' --variants-only' : ''} --output-type v --output output.vcf ${p.input_file}`,
      outputs: [{ name: 'output_file', short: 'vcf', ext: 'vcf', label: (inDs) => `bcftools call on data ${inDs[0].hid}`, file: () => 'output.vcf', describe: vcfDescribe }],
      help: '<p>Decides the genotype at each position from the likelihoods made by <b>bcftools mpileup</b>, and (with <i>variant sites only</i>) writes the positions where this sample differs from the reference.</p>'
    },
    {
      id: 'bcftools_view',
      name: 'bcftools view',
      version: '1.10',
      section: 'Variant Calling',
      desc: 'VCF/BCF conversion, view, subset and filter VCF/BCF files',
      inputs: [{ name: 'input_file', label: 'VCF/BCF Data', short: 'variants', ext: ['vcf', 'vcf_bgzip', 'bcf'] }],
      params: [{ name: 'include', label: 'Include (keep sites for which the expression is true)', type: 'text', default: 'QUAL>=30 && INFO/DP>=10', short: 'include', help: 'e.g. QUAL>=30 && INFO/DP>=10' }],
      inputName: (n, ds) => (ds.ext === 'bcf' ? 'input.bcf' : ds.ext === 'vcf_bgzip' ? 'input.vcf.gz' : 'input.vcf'),
      command: (p, params) => `bcftools view --include ${q(String(params.include || '').replace(/'/g, ''))} --output-type v --output-file output.vcf ${p.input_file}`,
      outputs: [{ name: 'output_file', short: 'vcf', ext: 'vcf', label: (inDs) => `bcftools view on data ${inDs[0].hid}`, file: () => 'output.vcf', describe: vcfDescribe }],
      help: '<p>Keeps only the variants for which the <b>include</b> expression is true, e.g. <code>QUAL&gt;=30 &amp;&amp; INFO/DP&gt;=10</code> keeps calls with a quality of at least 30 made from at least 10 reads.</p>'
    },
    {
      id: 'freebayes',
      name: 'FreeBayes',
      version: '1.3.10',
      section: 'Variant Calling',
      desc: 'bayesian genetic variant detector',
      inputs: [{ name: 'bam', label: 'BAM dataset', short: 'alignments', ext: ['bam'] }],
      params: [
        { name: 'ref', label: 'Using reference genome', type: 'select', options: [['hg19', 'Human Feb. 2009 (GRCh37/hg19) (hg19)']], default: 'hg19', short: 'reference' },
        { name: 'level', label: 'Choose parameter selection level', type: 'select', options: [['simple', 'Simple diploid calling'], ['filtered', 'Simple diploid calling with filtering and coverage']], default: 'filtered', short: 'level' }
      ],
      inputName: () => 'b_0.bam',
      command: (p, params) => `freebayes --bam b_0.bam --fasta-reference ${q(GREF)}${params.level === 'filtered' ? ' --standard-filters --min-coverage 10' : ''} --vcf output.vcf`,
      outputs: [{ name: 'output_vcf', short: 'vcf', ext: 'vcf', label: (inDs) => `FreeBayes on data ${inDs[0].hid} (variants)`, file: () => 'output.vcf', describe: vcfDescribe }],
      help: '<p>FreeBayes is a haplotype-based variant caller. <i>Simple diploid calling with filtering and coverage</i> adds <code>--standard-filters --min-coverage 10</code>: reads and bases must have mapping and base quality ≥ 30 (and other quality filters) and a site needs at least 10 reads.</p>',
      minSeconds: 3
    }
  ];

  async function vcfDescribe(engine, d) {
    const t = engine.fs.get(d.path).text || '';
    const n = t.split('\n').filter((l) => l && !l.startsWith('#')).length;
    const cols = t.split('\n').find((l) => l.startsWith('#CHROM')) || '';
    return { info: `${MG.fmt(n)} variants`, peek: cols + '\n' + t.split('\n').filter((l) => l && !l.startsWith('#')).slice(0, 3).map((l) => l.split('\t').slice(0, 6).join('\t')).join('\n'), variants: n };
  }

  /* the workflow students import: everything except the final filtering step */
  const WORKFLOW = {
    name: 'Reads to variants (bcftools)',
    annotation: 'FastQC · BWA-MEM · flagstat · idxstats · mpileup · call  (the filtering step is missing – add it)',
    steps: [
      { id: 's1', type: 'input', label: 'Forward reads (R1)', ext: ['fastqsanger.gz'], pick: 'R1', x: 20, y: 30 },
      { id: 's2', type: 'input', label: 'Reverse reads (R2)', ext: ['fastqsanger.gz'], pick: 'R2', x: 20, y: 200 },
      { id: 's3', type: 'tool', tool: 'fastqc', params: { nogroup: false }, connections: { reads: { step: 's1', output: 'output' } }, x: 265, y: 10 },
      { id: 's4', type: 'tool', tool: 'fastqc', params: { nogroup: false }, connections: { reads: { step: 's2', output: 'output' } }, x: 265, y: 250 },
      { id: 's5', type: 'tool', tool: 'bwa_mem', params: { ref: 'hg19', mode: 'paired' }, connections: { fastq_input1: { step: 's1', output: 'output' }, fastq_input2: { step: 's2', output: 'output' } }, x: 265, y: 130 },
      { id: 's6', type: 'tool', tool: 'samtools_flagstat', params: {}, connections: { input1: { step: 's5', output: 'bam_output' } }, x: 510, y: 10 },
      { id: 's7', type: 'tool', tool: 'samtools_idxstats', params: {}, connections: { input: { step: 's5', output: 'bam_output' } }, x: 510, y: 250 },
      { id: 's8', type: 'tool', tool: 'bcftools_mpileup', params: { ref: 'hg19', annotate: true, otype: 'b' }, connections: { input_file: { step: 's5', output: 'bam_output' } }, x: 510, y: 130 },
      { id: 's9', type: 'tool', tool: 'bcftools_call', params: { method: 'm', vonly: true }, connections: { input_file: { step: 's8', output: 'output_file' } }, x: 755, y: 130 }
    ]
  };

  page.tools = TOOLS;
})();
