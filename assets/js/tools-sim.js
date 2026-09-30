/* =====================================================================
   Simulated tools for the practical.
   FastQC (Java) and BWA (needs a 5 GB genome index) cannot run inside a
   web page, so these commands replay the output of real runs on the same
   data (recorded when the practical was built). Everything downstream
   – samtools and bcftools – runs for real (tools-wasm.js).
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const { userErr, getopts, fmtN } = MG.shellUtil;
  const T = (MG.shellTools = MG.shellTools || {});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const D = () => MG.simData;

  /* ---------- building the practical's file system ---------- */
  MG.simSetup = function (fs, base) {
    const d = D();
    const home = fs.home;
    const P = (p) => home + '/' + base + '/' + p;
    fs.mkdirp(P('data'));
    fs.mkdirp(P('ref'));
    fs.mkdirp(P('results'));
    ['R1', 'R2'].forEach((k) => {
      const f = d.fastq[k];
      fs.put(P('data/' + f.name), { kind: 'virtual', protected: true, meta: fastqMeta(k) });
    });
    const r = d.ref;
    fs.put(P('ref/hg19.fa'), { kind: 'virtual', protected: true, meta: { kind: 'fasta', size: r.bytes, lines: r.lines, head: (n) => r.head.slice(0, n), tail: (n) => r.tail.slice(-n), backing: r.fasta, describe: 'ASCII text (FASTA: the human reference genome, hg19)' } });
    fs.put(P('ref/hg19.fa.fai'), { kind: 'url', url: r.fai, size: r.faiBytes, protected: true });
    fs.put(P('ref/hg19.fa.gzi'), { kind: 'url', url: r.gzi, size: r.gziBytes, protected: true, hidden: true });
    Object.entries(r.bwaIndex).forEach(([ext, size]) => fs.put(P('ref/hg19.fa.' + ext), { kind: 'virtual', protected: true, meta: { kind: 'bwa-index', size, binary: true, lines: 0, head: () => [] } }));
    if (d.readme) fs.writeText(P('README.txt'), d.readme, { protected: true });
    fs.cwd = home + '/' + base;
  };

  function fastqMeta(k) {
    const f = D().fastq[k];
    return {
      kind: 'fastq',
      fastq: k,
      gz: true,
      size: f.gzBytes,
      textBytes: f.bytes,
      lines: f.lines,
      gzLines: Math.round(f.gzBytes / 45),
      describe: 'gzip compressed data, was "' + f.name.replace(/\.gz$/, '') + '"',
      head: (n) => f.head.slice(0, Math.min(n, f.head.length)),
      tail: (n) => f.tail.slice(-n),
      grep: (re, opts) => {
        // exact counts for the usual "count the reads" patterns (measured on the real file)
        const src = re.source.replace(/^\\b\(\?:|\)\\b$/g, '');
        let count = null;
        if (/SRR|\\\/[12]|\/[12]\$?$/.test(src) && re.test(f.head[0])) count = f.reads;
        else if (src === '^@') count = f.atStart;
        else if (src === '@') count = f.atAny;
        else if (src === '^\\+$' || src === '^\\+') count = f.plusStart;
        else if (src === '\\+' || src === '+') count = f.plusAny;
        if (count == null) return null;
        if (opts.v) count = f.lines - count;
        const keep = (l) => re.test(l) !== !!opts.v;
        return { count, lines: opts.c ? [] : f.head.filter(keep), tail: f.tail.filter(keep) };
      }
    };
  }
  function samMeta(kind) {
    const s = D().bwa.sam;
    return {
      kind: 'sam',
      samKind: kind,
      size: s.bytes,
      lines: s.lines,
      head: (n) => s.head.slice(0, Math.min(n, s.head.length)),
      tail: (n) => s.tail.slice(-n),
      describe: 'Sequence Alignment/Map (SAM) text, unsorted (reads in the same order as the FASTQ)',
      grep: (re, opts) => {
        if (/\^@/.test(re.source) || re.source === '^@') {
          const hdr = s.head.filter((l) => l.startsWith('@'));
          const n = opts.v ? s.lines - s.headerLines : s.headerLines;
          if (opts.c) return { count: n, lines: [] };
          if (!opts.v) return { count: n, lines: hdr, tail: hdr };
          return { count: n, lines: s.head.filter((l) => !l.startsWith('@')), tail: s.tail.filter((l) => !l.startsWith('@')) };
        }
        return null;
      }
    };
  }

  const fastqOf = (fs, p) => {
    const e = fs.get(p);
    return e && e.kind === 'virtual' && e.meta && e.meta.fastq ? e.meta.fastq : null;
  };
  const isSimSam = (e) => e && e.kind === 'virtual' && e.meta && (e.meta.kind === 'sam' || (e.meta.kind === 'bam' && !e.meta.sorted));

  /* ------------------------------------------------------------------
     fastqc
     ------------------------------------------------------------------ */
  T.fastqc = {
    summary: 'quality-control report for FASTQ reads',
    man: 'fastqc [-o OUTDIR] [-t THREADS] FILE.fastq.gz …   write FILE_fastqc.html (a report) and FILE_fastqc.zip for each file.\nOpen a report with:  open OUTDIR/FILE_fastqc.html',
    run: async (ctx) => {
      const { opts, rest } = getopts(ctx.args, 'o:t:qhvxXgf:k:d:', { outdir: 'o', threads: 't', quiet: 'q', help: 'h', version: 'v', nogroup: 'g', extract: 'x', noextract: 'X', format: 'f', kmers: 'k', dir: 'd' });
      if (opts.v) return ctx.out('FastQC v0.12.1\n');
      if (opts.h || !rest.length) {
        ctx.out(T.fastqc.man + '\n');
        return rest.length ? 0 : 1;
      }
      if (opts.o && !ctx.fs.isDir(opts.o)) throw userErr(`Specified output directory '${opts.o}' does not exist`);
      const made = [];
      for (const f of rest) {
        const e = ctx.fs.get(f);
        if (!e) {
          ctx.err(`Skipping '${f}' which didn't exist, or couldn't be read\n`);
          continue;
        }
        const k = fastqOf(ctx.fs, f);
        if (!k) {
          ctx.err(`Failed to process file ${MG.path.basename(f)}\nuk.ac.babraham.FastQC.Sequence.SequenceFormatException: ID line didn't start with '@'\n`);
          continue;
        }
        const name = MG.path.basename(f);
        if (!opts.q) ctx.out(`application/gzip\nStarted analysis of ${name}\n`);
        for (let p = 5; p <= 95; p += 5) {
          if (ctx.term && ctx.term.cancelled) throw userErr('^C interrupted');
          if (!opts.q) ctx.progress(`Approx ${p}% complete for ${name}`);
          await sleep(55);
        }
        if (ctx.term) ctx.term.endProgress();
        if (!opts.q) ctx.out(`Analysis complete for ${name}\n`);
        const stem = name.replace(/\.(fastq|fq)(\.gz)?$/, '');
        const dir = opts.o ? ctx.fs.resolve(opts.o) : MG.path.dirname(ctx.fs.resolve(f));
        const html = dir + '/' + stem + '_fastqc.html';
        const zip = dir + '/' + stem + '_fastqc.zip';
        const htmlEntry = () => ({ kind: 'virtual', fresh: true, meta: { kind: 'fastqc-html', fastq: k, size: D().fastqc[k].htmlBytes, lines: 1, head: () => ['<html><head><title>' + name + ' FastQC Report</title>…(open this file with:  open ' + ctx.fs.pretty(html) + ')'], describe: 'HTML document, ASCII text (FastQC report)' } });
        ctx.fs.put(html, htmlEntry());
        ctx.fs.put(zip, { kind: 'virtual', fresh: true, meta: { kind: 'zip', size: D().fastqc[k].zipBytes, binary: true, lines: 0, head: () => [] } });
        if (opts.x) {
          // --extract: the unzipped report folder (fastqc_data.txt holds the raw numbers)
          const xd = dir + '/' + stem + '_fastqc';
          ctx.fs.mkdirp(xd);
          ctx.fs.writeText(xd + '/fastqc_data.txt', D().fastqc[k].raw, { fresh: true });
          ctx.fs.writeText(xd + '/summary.txt', D().fastqc[k].summary, { fresh: true });
          ctx.fs.put(xd + '/fastqc_report.html', htmlEntry());
        }
        made.push({ fastq: k, html });
      }
      MG.bus.emit('tool:run', { program: 'fastqc', sub: '', args: ctx.args, code: made.length ? 0 : 1, made: made.map((m) => m.fastq), n: made.length });
      if (made.length && !ctx.isPipedOut && !opts.q) ctx.io.note(`Report${made.length > 1 ? 's' : ''} written. Look at ${made.length > 1 ? 'them' : 'it'} with:  open ${ctx.fs.pretty(made[0].html).replace(ctx.fs.pretty(ctx.fs.cwd) + '/', '')}`);
      return made.length ? 0 : 1;
    }
  };

  /* ------------------------------------------------------------------
     open – show a report or data file in the right tab
     ------------------------------------------------------------------ */
  T.open = {
    summary: 'open a FastQC report (or a BAM/VCF in IGV) in the viewer tabs',
    man: 'open FILE   show FILE_fastqc.html in the Report tab, or a .bam / .vcf file in the IGV tab',
    run: async (ctx) => {
      const f = ctx.args[0];
      if (!f) throw userErr('usage: open FILE');
      const e = ctx.fs.get(f);
      if (!e) throw userErr(`The file ${ctx.fs.resolve(f)} does not exist.`);
      if (e.kind === 'virtual' && e.meta.kind === 'fastqc-html') {
        const k = e.meta.fastq;
        if (!MG.app.fastqc) throw userErr('open: there is no report viewer on this page');
        MG.app.showWorkbench('report');
        await MG.app.fastqc.load(k, D().fastqc[k].json);
        MG.bus.emit('report:open', { fastq: k });
        return 0;
      }
      if (/\.(bam|vcf|vcf\.gz|bed)$/.test(f)) return T.igv.run(ctx);
      throw userErr(`open: this terminal has no viewer for ${MG.path.basename(f)} – try  head ${f}`);
    }
  };
  T.xdg_open = Object.assign({}, T.open, { hidden: true });

  /* ------------------------------------------------------------------
     bwa
     ------------------------------------------------------------------ */
  const BWA_USAGE = [
    '',
    'Program: bwa (alignment via Burrows-Wheeler transformation)',
    'Version: 0.7.19-r1273',
    'Contact: Heng Li <hli@ds.dfci.harvard.edu>',
    '',
    'Usage:   bwa <command> [options]',
    '',
    'Command: index         index sequences in the FASTA format',
    '         mem           BWA-MEM algorithm',
    '         aln           gapped/ungapped alignment',
    '         samse         generate alignment (single ended)',
    '         sampe         generate alignment (paired ended)',
    '',
    "Note: To use BWA, you need to first index the genome with `bwa index'.",
    '      There are three alignment algorithms in BWA: `mem\', `bwasw\', and',
    "      `aln/samse/sampe'. If you are not sure which to use, try `bwa mem'",
    '      first.',
    ''
  ].join('\n');
  T.bwa = {
    summary: 'align reads to the reference genome (BWA-MEM)',
    subcommands: ['mem', 'index', 'aln', 'samse', 'sampe'],
    man: 'bwa mem [-t THREADS] REF.fa READS_1.fastq.gz [READS_2.fastq.gz] > aligned.sam\n  REF.fa must already be indexed (bwa index REF.fa makes REF.fa.amb .ann .bwt .pac .sa)',
    run: async (ctx) => {
      const sub = ctx.args[0];
      if (!sub) {
        ctx.err(BWA_USAGE + '\n');
        return 1;
      }
      if (sub === 'index') {
        const ref = ctx.args[ctx.args.length - 1];
        if (!ref || ref === 'index') throw userErr('Usage:   bwa index [options] <in.fasta>');
        if (!ctx.fs.exists(ref)) throw userErr(`[bwa_index] fail to open file '${ref}' : No such file or directory`);
        const has = ['amb', 'ann', 'bwt', 'pac', 'sa'].every((x) => ctx.fs.exists(ref + '.' + x));
        const dir = ref.includes('/') ? ref.slice(0, ref.lastIndexOf('/')) : '.';
        ctx.io.note(`Indexing the whole human genome needs about 5 GB of memory and over an hour of computer time, so it has been done for you${has ? ` – the index files ${MG.path.basename(ref)}.amb .ann .bwt .pac and .sa are already in ${dir === '.' ? 'this folder' : dir + '/'} (see  ls -lh ${dir})` : ''}. You only index a reference once; every alignment then reuses it.`);
        MG.bus.emit('tool:run', { program: 'bwa', sub: 'index', args: ctx.args, code: 0 });
        return 0;
      }
      if (sub !== 'mem') {
        if (['aln', 'samse', 'sampe', 'bwasw'].includes(sub)) throw userErr(`bwa ${sub}: this practical uses the newer BWA-MEM algorithm – use  bwa mem`);
        throw userErr(`[main] unrecognized command '${sub}'`);
      }
      const { opts, rest } = getopts(ctx.args.slice(1), 't:k:w:R:M:v:T:aMpY', {});
      if (rest.length < 2) {
        ctx.err('\nUsage: bwa mem [options] <idxbase> <in1.fq> [in2.fq]\n\n  -t INT   number of threads [1]\n  -R STR   read group header line such as \'@RG\\tID:foo\\tSM:bar\'\n');
        return 1;
      }
      const [ref, r1, r2, ...extra] = rest;
      if (extra.length) throw userErr(`[E::main_mem] too many input files: ${extra.join(' ')}`);
      const idxOk = ['bwt', 'pac', 'ann', 'amb', 'sa'].every((x) => ctx.fs.exists(ref + '.' + x));
      if (!idxOk) {
        if (!ctx.fs.exists(ref)) throw userErr(`[E::bwa_idx_load_from_disk] fail to locate the index files`);
        throw userErr(`[E::bwa_idx_load_from_disk] fail to locate the index files – ${ref} has not been indexed (did you mean ref/hg19.fa?)`);
      }
      for (const f of [r1, r2].filter(Boolean)) {
        if (!ctx.fs.exists(f)) throw userErr(`[E::main_mem] fail to open file \`${f}'.`);
        if (!fastqOf(ctx.fs, f)) throw userErr(`[E::main_mem] ${f} does not look like a FASTQ file`);
      }
      const k1 = fastqOf(ctx.fs, r1), k2 = r2 ? fastqOf(ctx.fs, r2) : null;
      if (!r2) {
        ctx.io.note('This sample was sequenced paired-end: each DNA fragment was read from both ends, and the two reads are in the _R1 and _R2 files. Give bwa both files so it can use the pairs – e.g.\n  bwa mem ref/hg19.fa data/NA12878_chr10_R1.fastq.gz data/NA12878_chr10_R2.fastq.gz > results/aligned.sam');
        return 1;
      }
      if (k1 === k2) throw userErr('[mem_sam_pe] paired reads have different names – you gave the same file twice. Use _R1 then _R2.');
      if (k1 !== 'R1') ctx.io.note('(Tip: list the _R1 file first, then _R2.)');
      if (!ctx.redirectTarget && !ctx.isPipedOut) {
        ctx.io.note('No output file was given, so bwa writes the alignments to the screen. Stop and re-run with  > results/aligned.sam  on the end to save them to a file.');
      }
      // replay the real log
      const log = D().bwa.log;
      const threads = Math.max(1, Math.min(8, parseInt(opts.t || '1', 10) || 1));
      for (const line of log) {
        if (ctx.term && ctx.term.cancelled) throw userErr('^C');
        if (line.startsWith('[main] CMD:')) ctx.err('[main] CMD: bwa ' + ctx.args.join(' ') + '\n');
        else ctx.err(line + '\n'); // the recorded log of the real run, times included
        const pause = /Processed|read \d+ sequences/.test(line) ? 900 / Math.sqrt(threads) : 60;
        await sleep(pause);
      }
      const meta = samMeta('bwa-pe');
      if (ctx.redirectTarget) ctx.virtualOutput = { kind: 'virtual', fresh: true, meta };
      ctx.out(new MG.Lazy(meta));
      MG.bus.emit('tool:run', { program: 'bwa', sub: 'mem', args: ctx.args, code: 0, out: ctx.redirectTarget });
      return 0;
    }
  };

  /* ------------------------------------------------------------------
     samtools on the simulated SAM / unsorted BAM
     ------------------------------------------------------------------ */
  MG.simHooks = MG.simHooks || {};
  MG.simHooks.samtools = async (ctx) => {
    const sub = ctx.args[0];
    const fileArgs = ctx.args.slice(1).filter((a) => !a.startsWith('-') && ctx.fs.exists(a));
    const simIn = fileArgs.find((a) => isSimSam(ctx.fs.get(a)));
    const stdinSim = ctx.stdin && ctx.stdin.meta && ctx.stdin.meta.kind === 'sam';
    if (!simIn && !stdinSim) {
      if (sub === 'sort') return undefined;
      return undefined; // real samtools
    }
    const e = simIn ? ctx.fs.get(simIn) : { meta: ctx.stdin.meta };
    const m = e.meta;
    const s = D().bwa.sam;
    const name = simIn || '-';
    switch (sub) {
      case 'view': {
        const { opts, rest } = getopts(ctx.args.slice(1), 'hHcbuSo:q:f:F:@:O:', {});
        const region = rest.filter((x) => x !== simIn)[0];
        if (region) throw userErr('[main_samview] random alignment retrieval only works for indexed BAM or CRAM files.\n(Sort and index the alignments first: samtools sort, then samtools index.)');
        if (opts.c) {
          ctx.out(String(opts.F === '4' || opts.F === '0x4' ? s.mapped : s.records) + '\n');
          return 0;
        }
        if (opts.b || opts.u) {
          const target = opts.o || ctx.redirectTarget;
          if (!target) {
            ctx.out(MG.shellUtil.binaryNoise({ size: 77 }));
            return 0;
          }
          ctx.fs.put(target, { kind: 'virtual', fresh: true, meta: { kind: 'bam', sorted: false, binary: true, size: D().bwa.unsortedBamBytes, lines: 0, head: () => [], describe: 'BAM (compressed binary alignments) – unsorted' } });
          if (ctx.redirectTarget) ctx.wroteRedirect = true;
          MG.bus.emit('tool:run', { program: 'samtools', sub: 'view', args: ctx.args, code: 0, bam: true });
          return 0;
        }
        const lines = opts.H ? s.head.filter((l) => l.startsWith('@')) : opts.h ? s.head : s.head.filter((l) => !l.startsWith('@'));
        const total = opts.H ? s.headerLines : opts.h ? s.lines : s.lines - s.headerLines;
        ctx.out(new MG.Lazy({ lines: total, head: (n) => lines.slice(0, n), tail: (n) => s.tail.slice(-n) }));
        return 0;
      }
      case 'sort': {
        const { opts } = getopts(ctx.args.slice(1), 'o:O:@:m:T:nl:', {});
        const target = opts.o || ctx.redirectTarget;
        if (!target) {
          ctx.err('[bam_sort] refusing to write BAM data to the terminal – add  -o sorted.bam\n');
          return 1;
        }
        if (opts.n) throw userErr('samtools sort -n sorts by read name; for variant calling sort by position (leave out -n)');
        await sleep(1200);
        ctx.fs.put(target, { kind: 'virtual', fresh: true, meta: { kind: 'bam', sorted: true, binary: true, size: D().sorted.bytes, lines: 0, head: () => [], backing: D().sorted.url, describe: 'BAM (compressed binary alignments) – sorted by coordinate' } });
        if (ctx.redirectTarget) ctx.wroteRedirect = true;
        MG.bus.emit('tool:run', { program: 'samtools', sub: 'sort', args: ctx.args, code: 0, out: target });
        return 0;
      }
      case 'index': {
        if (m.kind === 'sam') throw userErr(`[E::hts_idx_new] … samtools index: "${name}" is SAM text – only sorted BAM (or CRAM) files can be indexed. Sort it into a BAM first:\n  samtools sort -o results/aligned.sorted.bam ${name}`);
        throw userErr(`[E::hts_idx_push] Unsorted positions on sequence #11: 96559101 followed by 96470123\nsamtools index: failed to create index for "${name}"\n(The reads are still in FASTQ order. Sort them first with samtools sort.)`);
      }
      case 'flagstat': {
        ctx.out(D().bwa.flagstat);
        MG.bus.emit('tool:run', { program: 'samtools', sub: 'flagstat', args: ctx.args, code: 0 });
        return 0;
      }
      case 'idxstats':
        throw userErr(`samtools idxstats: fail to load index for "${name}" – idxstats needs a sorted, indexed BAM`);
      case 'depth':
      case 'coverage':
      case 'mpileup':
        throw userErr(`samtools ${sub}: "${name}" is not sorted – sort and index it first (samtools sort, samtools index)`);
      default:
        return undefined;
    }
  };
  MG.simHooks.bcftools = async (ctx) => {
    const sub = ctx.args[0];
    if (sub !== 'mpileup') return undefined;
    const bam = ctx.args.slice(1).find((a) => /\.(bam|sam)$/.test(a) && ctx.fs.exists(a));
    if (bam && isSimSam(ctx.fs.get(bam))) throw userErr(`[E::bam_plp_push] The input is not sorted (reads out of order)\n(bcftools needs a coordinate-sorted BAM – run samtools sort and samtools index first.)`);
    if (bam) {
      const b = ctx.fs.get(bam);
      const hasIdx = ctx.fs.exists(bam + '.bai') || ctx.fs.exists(bam.replace(/\.bam$/, '.bai'));
      if (b && b.kind === 'virtual' && b.meta.sorted && !hasIdx && ctx.args.some((a) => a === '-r' || a.startsWith('--regions') || a.startsWith('-r'))) throw userErr(`[E::idx_find_and_load] Could not retrieve index file for '${bam}'\nFailed to read from ${bam}: could not load index`);
    }
    if (!ctx.args.some((a) => a === '-f' || a.startsWith('--fasta-ref') || /^-f./.test(a))) {
      ctx.err('[mpileup] no reference given: add  -f ref/hg19.fa  so bcftools can compare the reads with the reference\n');
      return 1;
    }
    return undefined;
  };

  /* ------------------------------------------------------------------
     freebayes (recorded output of FreeBayes v1.3.10)
     ------------------------------------------------------------------ */
  T.freebayes = {
    summary: 'call variants with FreeBayes (haplotype-based caller)',
    man: 'freebayes -f REF.fa [--min-coverage N] [--standard-filters] FILE.sorted.bam > calls.vcf',
    run: async (ctx) => {
      const { opts, rest } = getopts(ctx.args, 'f:C:m:q:0hb:v:', { 'fasta-reference': 'f', 'min-coverage': 'C', 'min-alternate-count': 'C', 'standard-filters': '0', 'min-mapping-quality': 'm', 'min-base-quality': 'q', help: 'h', bam: 'b', vcf: 'v' });
      if (opts.h || (!rest.length && !opts.b)) {
        ctx.err('usage: freebayes -f [REFERENCE] [OPTIONS] [BAM FILES] >[OUTPUT]\n');
        return 1;
      }
      if (!opts.f) throw userErr('Please specify a fasta reference file (-f)');
      if (!ctx.fs.exists(opts.f)) throw userErr(`could not open ${opts.f}`);
      const bam = opts.b || rest[0];
      const b = ctx.fs.get(bam);
      if (!b) throw userErr(`could not open ${bam}`);
      if (!(b.kind === 'virtual' && b.meta.sorted)) {
        if (isSimSam(b)) throw userErr(`ERROR: Could not open input BAM files – ${bam} must be a sorted, indexed BAM (samtools sort + samtools index)`);
      }
      const hasIdx = ctx.fs.exists(bam + '.bai') || ctx.fs.exists(bam.replace(/\.bam$/, '.bai'));
      if (!hasIdx) throw userErr(`[E::idx_find_and_load] Could not retrieve index file for '${bam}'\nERROR: could not load BAM index – run  samtools index ${bam}  first`);
      const variant = opts['0'] || opts.C || opts.m || opts.q ? 'filtered' : 'default';
      const fb = D().freebayes[variant];
      await sleep(2600);
      let text = await (await fetch(fb.url)).text();
      text = text.replace(/^##commandline=.*$/m, '##commandline="freebayes ' + ctx.args.join(' ').replace(/"/g, '') + '"');
      if (variant === 'filtered' && !(opts['0'] && opts.C === '10')) ctx.io.note('(This practical recorded FreeBayes with its default settings and with  --standard-filters --min-coverage 10; other option values give the second of these.)');
      if (opts.v) ctx.fs.writeText(opts.v, text, { fresh: true });
      else ctx.out(text);
      MG.bus.emit('tool:run', { program: 'freebayes', sub: variant, args: ctx.args, code: 0, out: ctx.redirectTarget });
      return 0;
    }
  };

  /* fasterq / wget are common first guesses – give friendly messages */
  T.wget = {
    hidden: true,
    run: async () => {
      throw userErr('wget: this terminal has no internet access – the data are already in data/ (try  ls data)');
    }
  };
  T.curl = T.wget;
  T.conda = {
    hidden: true,
    run: async () => {
      throw userErr('conda: the tools are already installed here (try  help  to see them)');
    }
  };
})();
