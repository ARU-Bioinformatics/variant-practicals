/* =====================================================================
   Real bioinformatics tools in the browser.
   samtools 1.17, bcftools 1.10, bgzip and tabix (htslib 1.17) compiled to
   WebAssembly by the biowasm project and run with Aioli
   (https://biowasm.com – MIT licence). Nothing is uploaded: the programs
   run inside this web page, on files in the page's own file system.

   The terminal's file system (vfs.js) is mirrored into the WebAssembly
   file system under /shared/vfs so that tools see the same paths.
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const { userErr } = MG.shellUtil;

  class FileRef {
    constructor(apath, binary) {
      this.apath = apath;
      this.binary = !!binary;
    }
  }
  MG.FileRef = FileRef;

  const ROOT = '/shared/vfs';
  const TMP = '/shared/vfs/tmp/.pipes';
  const TEXT_EXT = /\.(vcf|sam|txt|tsv|csv|bed|fai|fa|fasta|fastq|fq|log|stats|out|json|html)$/i;
  const MAX_TEXT_IMPORT = 25 * 1024 * 1024;

  const W = {
    ready: false,
    loading: null,
    cli: null,
    placed: new Map(), // aioli path -> source key of the file mounted there
    mountN: 0,
    synced: new Map(), // vfs abs path -> {mtime}
    pipeN: 0,
    versions: { samtools: '1.17', bcftools: '1.10', htslib: '1.17' },

    apath(abs) {
      return ROOT + abs;
    },

    /** load Aioli + tools (once). status(text) is shown while loading */
    ensure(status) {
      if (this.ready) return Promise.resolve(this.cli);
      if (this.loading) return this.loading;
      const base = new URL((MG.config.biowasmBase || 'assets/vendor/biowasm'), location.href).href.replace(/\/$/, '');
      this.loading = (async () => {
        if (typeof window.Aioli === 'undefined') {
          if (status) status('Loading the WebAssembly tool runner…');
          await loadScript(base + '/aioli.js');
        }
        if (status) status('Loading samtools, bcftools and htslib (about 5 MB, once per session)…');
        const tools = [
          { tool: 'samtools', version: '1.17', urlPrefix: base + '/samtools/1.17' },
          { tool: 'bcftools', version: '1.10', urlPrefix: base + '/bcftools/1.10' },
          { tool: 'htslib', program: 'bgzip', version: '1.17', urlPrefix: base + '/htslib/1.17' },
          { tool: 'htslib', program: 'tabix', version: '1.17', urlPrefix: base + '/htslib/1.17' }
        ];
        const cli = await new window.Aioli(tools, { printInterleaved: false, urlCDN: base, debug: false });
        this.cli = cli;
        await mkdirp(cli, TMP);
        this.ready = true;
        MG.bus.emit('wasm:ready', {});
        return cli;
      })().catch((e) => {
        this.loading = null;
        throw e;
      });
      return this.loading;
    },

    async readText(apath) {
      const cli = await this.ensure();
      return await cli.fs.readFile(apath, { encoding: 'utf8' });
    },
    async readBytes(apath) {
      const cli = await this.ensure();
      return await cli.fs.readFile(apath);
    },

    /** make sure a VFS file (and its index files) exist in the WebAssembly FS.
        Hosted files are mounted lazily (only the parts a tool reads are downloaded) and
        files from the student's computer are mounted in place (never copied or uploaded);
        the mounted file is then moved to the same path the terminal uses.
        (Emscripten calls that return file-system nodes cannot cross the worker boundary,
        so only calls that return plain values – rename, unlink, lstat – are used.) */
    async syncIn(fs, abs) {
      const cli = this.cli;
      const e = fs.entries.get(abs);
      if (!e || e.kind === 'dir') return;
      const ap = this.apath(abs);
      await mkdirp(cli, MG.path.dirname(ap));
      if (e.kind === 'text') {
        const prev = this.synced.get(abs);
        if (!prev || prev.mtime !== e.mtime || e.dirty || !(await lstat(cli, ap))) {
          await cli.fs.writeFile(ap, e.text);
          e.dirty = false;
          this.synced.set(abs, { mtime: e.mtime });
        }
        return;
      }
      let key, src;
      if (e.kind === 'url') {
        key = 'url:' + e.url;
        src = { url: new URL(e.url, location.href).href };
      } else if (e.kind === 'blob') {
        key = 'blob:' + (e.blob.name || '') + ':' + e.blob.size + ':' + (e.blob.lastModified || 0);
        src = { data: e.blob };
      } else if (e.kind === 'virtual' && e.meta && e.meta.backing) {
        key = 'url:' + e.meta.backing;
        src = { url: new URL(e.meta.backing, location.href).href };
      } else return; // 'aioli' entries are already there
      if (this.placed.get(ap) === key && (await lstat(cli, ap))) return;
      const name = 'm' + ++this.mountN + '_' + MG.path.basename(abs).replace(/[^A-Za-z0-9._-]/g, '_');
      const paths = await cli.mount([Object.assign({ name }, src)]);
      if (await lstat(cli, ap)) {
        try {
          await cli.fs.unlink(ap);
        } catch (err) {
          /* ignore */
        }
      }
      await cli.fs.rename(paths[0], ap);
      this.placed.set(ap, key);
    },

    async snapshot(dirs) {
      const snap = new Map();
      for (const d of dirs) {
        const list = await readdirSafe(this.cli, d);
        for (const name of list) {
          if (name === '.' || name === '..' || name === '.pipes') continue;
          const p = d + '/' + name;
          const st = await lstat(this.cli, p);
          if (st && !st.isDir) snap.set(p, st.size + ':' + st.mtime);
        }
      }
      return snap;
    },

    /** after a run, copy new or changed files back into the VFS */
    async importChanges(fs, before, dirs) {
      const after = await this.snapshot(dirs);
      const created = [];
      for (const [ap, sig] of after) {
        if (before.get(ap) === sig) continue;
        const abs = ap.slice(ROOT.length) || '/';
        const st = await lstat(this.cli, ap);
        if (!st || st.isLink) continue;
        let entry;
        if (TEXT_EXT.test(ap) && st.size <= MAX_TEXT_IMPORT) {
          const text = await this.cli.fs.readFile(ap, { encoding: 'utf8' });
          entry = { kind: 'text', text: tidyHeaderText(text), fresh: true };
        } else entry = { kind: 'aioli', apath: ap, size: st.size, fresh: true };
        const put = fs.put(abs, entry);
        const e = fs.entries.get(put);
        if (e.kind === 'text') {
          e.dirty = false;
          this.synced.set(abs, { mtime: e.mtime });
        }
        created.push(abs);
      }
      for (const [ap] of before) {
        if (!after.has(ap)) {
          const abs = ap.slice(ROOT.length);
          const e = fs.entries.get(abs);
          if (e && (e.kind === 'aioli' || e.kind === 'text')) fs.remove(abs);
        }
      }
      return created;
    },

    /**
     * run a real program from a shell context.
     * opts.binaryOut: true when the command writes binary to stdout
     */
    async run(ctx, program, args, opts = {}) {
      const fs = ctx.fs;
      const t0 = performance.now();
      const status = (s) => ctx.term && (ctx.term.statusEl.innerHTML = '<span class="spinner small"></span> ' + MG.esc(s));
      if (!this.ready) {
        const first = !this.loading;
        if (first) ctx.io.note('Starting the tools for the first time (they run inside this page, nothing is uploaded)…');
        await this.ensure(status);
      }
      const cli = this.cli;
      // 1. files the command mentions -> into the WebAssembly FS
      const mentioned = new Set();
      const consider = (tok) => {
        if (!tok || tok.startsWith('-') && !tok.includes('=')) return;
        const v = tok.includes('=') && tok.startsWith('-') ? tok.split('=').slice(1).join('=') : tok;
        const abs = fs.resolve(v);
        if (fs.entries.has(abs)) mentioned.add(abs);
        // index / sibling files that tools look for automatically
        ['.bai', '.csi', '.tbi', '.fai', '.gzi', '.crai'].forEach((x) => {
          if (fs.entries.has(abs + x)) mentioned.add(abs + x);
        });
        const noExt = abs.replace(/\.bam$/, '.bai');
        if (noExt !== abs && fs.entries.has(noExt)) mentioned.add(noExt);
      };
      args.forEach(consider);
      for (const abs of mentioned) await this.syncIn(fs, abs);
      const stdinPath = ctx.stdin instanceof FileRef ? ctx.stdin.apath : ctx.stdin && ctx.stdin.meta && ctx.stdin.meta.apath ? ctx.stdin.meta.apath : null;
      await this.cleanupPipes(fs, stdinPath);
      // 2. stdin
      let a = args.slice();
      if (ctx.stdin != null && ctx.stdin !== '' && opts.readsStdin !== false) {
        let pipePath;
        if (stdinPath) pipePath = stdinPath;
        else if (typeof ctx.stdin === 'string') {
          pipePath = `${TMP}/in${++this.pipeN}.txt`;
          await cli.fs.writeFile(pipePath, ctx.stdin);
        } else if (ctx.stdin && ctx.stdin.meta) {
          throw userErr(`${program}: this simulated file can't be piped into a real program – run the commands in the order shown in the practical`);
        }
        if (pipePath) {
          const dash = a.lastIndexOf('-');
          if (dash >= 0) a[dash] = pipePath;
          else if (opts.stdinFlag) a.push(opts.stdinFlag, pipePath);
          else a.push(pipePath);
        }
      }
      // 3. rewrite absolute VFS paths
      const inVfs = (p) => !p.startsWith(ROOT) && (fs.entries.has(MG.path.norm(p)) || fs.isDir(MG.path.dirname(MG.path.norm(p))));
      a = a.map((tok) => {
        // a file made by an earlier run that has since been copied or renamed in the
        // terminal's file system still lives at its original place in WebAssembly
        if (!tok.startsWith('-')) {
          const e = fs.entries.get(fs.resolve(tok));
          if (e && e.kind === 'aioli' && e.apath && e.apath !== this.apath(fs.resolve(tok))) return e.apath;
        }
        if (tok.startsWith('/') && inVfs(tok)) return this.apath(MG.path.norm(tok));
        const m = /^(--?[A-Za-z-]+=)(\/.*)$/.exec(tok);
        if (m && inVfs(m[2])) return m[1] + this.apath(MG.path.norm(m[2]));
        return tok;
      });
      // 4. output directories that may receive files
      const cwdA = this.apath(fs.cwd);
      await mkdirp(cli, cwdA);
      const dirs = new Set([cwdA]);
      args.forEach((tok) => {
        const v = tok.includes('=') && tok.startsWith('-') ? tok.split('=').slice(1).join('=') : tok;
        if (!v || v.startsWith('-')) return;
        const abs = fs.resolve(v);
        const d = MG.path.dirname(abs);
        if (fs.isDir(d)) dirs.add(this.apath(d));
      });
      for (const d of dirs) await mkdirp(cli, d);
      const before = await this.snapshot(Array.from(dirs));
      await cli.cd(cwdA);
      // 5. run
      status(`${program} ${a[0] || ''} is running…`);
      const timer = setInterval(() => status(`${program} ${a[0] || ''} is running… ${Math.round((performance.now() - t0) / 1000)} s`), 1000);
      let res;
      try {
        res = await cli.exec(program, a);
      } finally {
        clearInterval(timer);
      }
      const stdout = typeof res === 'string' ? res : res.stdout || '';
      const stderr = typeof res === 'string' ? '' : res.stderr || '';
      // 6. bring outputs back
      const created = await this.importChanges(fs, before, Array.from(dirs));
      created.forEach((p) => MG.bus.emit('vfs:created', { path: p, program, sub: args[0] }));
      const secs = (performance.now() - t0) / 1000;
      const failed = looksFailed(stderr, stdout);
      return { stdout, stderr: tidyStderr(stderr), created, secs, code: failed ? 1 : 0 };
    },

    /** decompress a .gz/.bgz file to text (used by zcat) – string, or a lazy view if it is large */
    async gunzipText(ctx, f) {
      await this.ensure();
      const tmp = `${TMP}/z${++this.pipeN}.txt`;
      const r = await this.run(Object.assign({}, ctx, { stdin: null }), 'bgzip', ['-d', '-f', '-o', tmp, f], { readsStdin: false });
      const st = await lstat(this.cli, tmp);
      if (!st) throw userErr((r.stderr || '').trim() || `gzip: ${f}: not in gzip format`);
      return this.readTextSmart(tmp, st.size);
    },

    async stat(apath) {
      return lstat(this.cli, apath);
    },

    /** delete temporary pipe files that nothing refers to any more */
    async cleanupPipes(fs, keep) {
      const cli = this.cli;
      const names = await readdirSafe(cli, TMP);
      if (!names.length) return;
      const refs = new Set(keep ? [keep] : []);
      if (fs && fs.entries) for (const e of fs.entries.values()) if (e.kind === 'aioli' && e.apath) refs.add(e.apath);
      for (const n of names) {
        if (n === '.' || n === '..') continue;
        const p = TMP + '/' + n;
        if (refs.has(p)) continue;
        try {
          await cli.fs.unlink(p);
        } catch (e) {
          /* ignore */
        }
        lazyCache.delete(p);
      }
    },

    /** text of a file in the WebAssembly FS: a string, or (over 16 MB) a lazy view read in pieces */
    async readTextSmart(apath, size) {
      const cli = await this.ensure();
      if (size == null) {
        const st = await lstat(cli, apath);
        size = st ? st.size : 0;
      }
      if (size <= BIG_TEXT) return await cli.fs.readFile(apath, { encoding: 'utf8' });
      return this.bigLazy(apath, size);
    },

    async bigLazy(apath, size) {
      const cli = this.cli;
      const st = await lstat(cli, apath);
      const sig = st ? st.size + ':' + st.mtime : String(size);
      const hit = lazyCache.get(apath);
      if (hit && hit.sig === sig) return new MG.Lazy(hit.meta);
      const dec = new TextDecoder();
      let nl = 0, carry = '', headDone = false, last = 10;
      const head = [];
      for (let pos = 0; pos < size; pos += CHUNK) {
        const buf = await cli.read({ path: apath, length: Math.min(CHUNK, size - pos), position: pos });
        for (let i = 0; i < buf.length; i++) if (buf[i] === 10) nl++;
        if (buf.length) last = buf[buf.length - 1];
        if (!headDone) {
          const parts = (carry + dec.decode(buf, { stream: true })).split('\n');
          carry = parts.pop();
          for (const p of parts) {
            head.push(p);
            if (head.length >= HEAD_KEEP) {
              headDone = true;
              break;
            }
          }
        }
      }
      const tlen = Math.min(size, 256 * 1024);
      const tb = await cli.read({ path: apath, length: tlen, position: size - tlen });
      const tl = new TextDecoder().decode(tb).split('\n');
      if (tl[tl.length - 1] === '') tl.pop();
      if (tlen < size) tl.shift();
      const meta = {
        kind: 'bigfile',
        apath,
        size,
        textBytes: size,
        lines: nl + (last === 10 ? 0 : 1),
        head: (n) => head.slice(0, Math.max(0, Math.min(n, head.length))),
        tail: (n) => tl.slice(-n),
        grep: (re, opts) => W.grepBig(apath, size, re, opts)
      };
      lazyCache.set(apath, { sig, meta });
      return new MG.Lazy(meta);
    },

    /** grep through a large file in pieces */
    async grepBig(apath, size, re, opts) {
      const cli = this.cli;
      const dec = new TextDecoder();
      const max = opts.m ? parseInt(opts.m, 10) : Infinity;
      let carry = '', count = 0, lineNo = 0;
      const first = [], tail = [];
      const test = (l) => {
        lineNo++;
        if (count >= max) return;
        if ((re.test(l)) === !!opts.v) return;
        count++;
        if (opts.c) return;
        const s = (opts.n ? lineNo + ':' : '') + l;
        if (first.length < HEAD_KEEP) first.push(s);
        tail.push(s);
        if (tail.length > 400) tail.shift();
      };
      for (let pos = 0; pos < size && count < max; pos += CHUNK) {
        const buf = await cli.read({ path: apath, length: Math.min(CHUNK, size - pos), position: pos });
        const parts = (carry + dec.decode(buf, { stream: true })).split('\n');
        carry = parts.pop();
        for (const p of parts) test(p);
      }
      if (carry) test(carry);
      return { count, lines: first, tail };
    }
  };
  const BIG_TEXT = 16 * 1024 * 1024;
  const CHUNK = 8 * 1024 * 1024;
  const HEAD_KEEP = 5000;
  const lazyCache = new Map();

  function looksFailed(stderr, stdout) {
    if (!stderr) return false;
    return /(^|\n)\s*(\[E::|\[W::.*(fail|could not)|Error|ERROR|Failed|failed to|Could not|could not|No such file|Usage:|usage:|\[main\] unrecognized|unrecognized command|invalid option|not in gzip|fai_load|abort)/.test(stderr) && !stdout.trim();
  }
  function tidyStderr(s) {
    return String(s || '')
      .replace(/\/shared\/vfs\/tmp\/\.pipes\/[oz]\d+\.(txt|bin)/g, '(output)')
      .replace(/\/shared\/vfs\/tmp\/\.pipes\/[^\s:'"]+/g, '(stdin)')
      .replace(/\/shared\/(data|mnt)\/m\d+_/g, '')
      .replace(/\/shared\/vfs/g, '');
  }
  /* samtools and bcftools record their command line in the header of the files they
     write (##bcftoolsCommand=…, @PG CL:…). Show the command as the student typed it,
     without the page's internal hand-over files: an output hand-over is dropped (it was
     standard output) and an input hand-over becomes "-" (standard input). */
  function tidyHeaderText(text) {
    if (typeof text !== 'string' || text.indexOf('/shared/') < 0) return text;
    let end = 0;
    while (end < text.length && (text[end] === '#' || text[end] === '@')) {
      const nl = text.indexOf('\n', end);
      if (nl < 0) {
        end = text.length;
        break;
      }
      end = nl + 1;
    }
    if (!end) return text;
    const head = text.slice(0, end);
    if (head.indexOf('/shared/') < 0) return text;
    const tidy = head
      .replace(/(^|[ \t])(-o|--output(-file)?)[ =]\/shared\/vfs\/tmp\/\.pipes\/[oz]\d+\.(txt|bin)(?=[ \t;\n]|$)/gm, '')
      .replace(/\/shared\/vfs\/tmp\/\.pipes\/[^\s'";]+/g, '-')
      .replace(/\/shared\/(data|mnt)\/m\d+_/g, '')
      .replace(/\/shared\/vfs/g, '');
    return tidy + text.slice(end);
  }

  async function lstat(cli, p) {
    try {
      const st = await cli.fs.lstat(p);
      const mode = st.mode;
      return { size: st.size, mtime: +new Date(st.mtime), isDir: (mode & 0o170000) === 0o040000, isLink: (mode & 0o170000) === 0o120000 };
    } catch (e) {
      return null;
    }
  }
  async function readdirSafe(cli, d) {
    try {
      return await cli.fs.readdir(d);
    } catch (e) {
      return [];
    }
  }
  async function mkdirp(cli, p) {
    const parts = p.split('/').filter(Boolean);
    let cur = '';
    for (const seg of parts) {
      cur += '/' + seg;
      const st = await lstat(cli, cur);
      if (!st) {
        try {
          await cli.mkdir(cur); // Aioli's own mkdir returns true (FS.mkdir returns a node)
        } catch (e) {
          /* exists */
        }
      }
    }
  }
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = () => rej(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }

  MG.wasm = W;

  /* ------------------------------------------------------------------
     Shell commands backed by the real tools
     ------------------------------------------------------------------ */
  const T = (MG.shellTools = MG.shellTools || {});

  /** does this command write binary data (BAM/BCF/compressed) to its output? */
  function binaryOut(program, args) {
    if (program === 'samtools') {
      const sub = args[0];
      if (sub === 'sort') return !args.some((x, i) => (x === '-O' && /^sam$/i.test(args[i + 1] || '')) || /^-Osam$/i.test(x) || /^--output-fmt=sam$/i.test(x));
      if (sub === 'view') return args.some((x) => /^-[a-zA-Z]*[bu]/.test(x) && !x.startsWith('--'));
      return false;
    }
    if (program === 'bcftools') return /^[buz]/.test(outType(args));
    if (program === 'bgzip') return !args.some((x) => x === '-d' || x === '--decompress' || /^-[a-z]*d/.test(x));
    return false;
  }
  /** bcftools output type (-O / --output-type), default v */
  function outType(args) {
    for (let i = 0; i < args.length; i++) {
      const x = args[i];
      if (x === '-O' || x === '--output-type') return args[i + 1] || 'v';
      if (/^-O[a-z]/.test(x)) return x.slice(2);
      if (/^--output-type=/.test(x)) return x.split('=')[1];
    }
    return 'v';
  }
  function setOutType(args, t) {
    const a = [];
    for (let i = 0; i < args.length; i++) {
      const x = args[i];
      if (x === '-O' || x === '--output-type') {
        i++;
        continue;
      }
      if (/^-O[a-z]/.test(x) || /^--output-type=/.test(x)) continue;
      a.push(x);
    }
    a.splice(1, 0, '-O' + t);
    return a;
  }
  /** subcommands that accept -o FILE (so big outputs never pass through JavaScript strings) */
  function supportsO(program, args) {
    const sub = args[0];
    if (program === 'samtools') return ['view', 'sort', 'depth', 'mpileup', 'faidx', 'coverage', 'fastq', 'fasta'].includes(sub);
    if (program === 'bcftools') return ['mpileup', 'call', 'view', 'query', 'filter', 'norm', 'annotate', 'concat', 'merge', 'sort', 'convert'].includes(sub);
    if (program === 'bgzip') return args.includes('-c') || args.includes('--stdout');
    return false;
  }
  function userOutput(program, args) {
    if (program === 'bgzip') return args.includes('-o') || args.some((x) => x.startsWith('--output'));
    return args.some((x, i) => i > 0 && (x === '-o' || x === '--output' || x.startsWith('--output=') || x.startsWith('--output-file') || /^-o./.test(x)));
  }
  const PIPE_TOOLS = new Set(['samtools', 'bcftools', 'bgzip', 'tabix']);

  /* bcftools mpileup writes a line for every position that has reads (millions for an
     exome). It is meant to be piped straight into bcftools call. */
  function regionSpan(args) {
    let span = 0, unknown = false, any = false;
    for (let i = 0; i < args.length; i++) {
      const x = args[i];
      let v = null;
      if (x === '-r' || x === '-t' || x === '--regions' || x === '--targets') v = args[i + 1];
      else if (/^-[rt].+/.test(x)) v = x.slice(2);
      else if (/^--(regions|targets)=/.test(x)) v = x.split('=')[1];
      else if (x === '-R' || x === '-T' || /^--(regions|targets)-file/.test(x) || /^-[RT].+/.test(x)) {
        any = true;
        unknown = true;
        continue;
      }
      if (v == null) continue;
      any = true;
      v.split(',').forEach((reg) => {
        const m = /:(\d[\d,]*)(?:-(\d[\d,]*))?$/.exec(reg);
        if (!m) unknown = true;
        else {
          const a = +m[1].replace(/,/g, '');
          const b = m[2] ? +m[2].replace(/,/g, '') : a;
          span += Math.max(1, b - a + 1);
        }
      });
    }
    return { any, span: unknown ? Infinity : span };
  }
  function mpileupGuard(ctx, args, mode, userO) {
    const reg = regionSpan(args);
    if (reg.any && reg.span <= 2e6) return { args };
    const why = 'bcftools mpileup writes one line for every position covered by reads – millions of lines (hundreds of MB) for an exome. It is meant to be piped straight into bcftools call, which keeps only the variant sites.';
    const eg = '  bcftools mpileup -Ou -a AD,DP -f ref/hg19.fa results/aligned.sorted.bam | bcftools call -mv -Ov -o results/calls.vcf';
    const peek = 'To look at the pile-up at a few positions instead, add a small region, e.g.  -r chr10:96541610-96541620';
    if (mode === 'term' && !userO) {
      ctx.io.note(`${why}\nFor example:\n${eg}\n${peek}`);
      return { stop: true, code: 1 };
    }
    if (mode === 'pipe-js') {
      ctx.io.note(`${why} Piping all of it into ${ctx.pipeNext} would take a very long time in the browser.\n${peek}`);
      return { stop: true, code: 1 };
    }
    if (mode === 'pipe-tool') {
      if (ctx.pipeNext === 'bcftools' && ctx.io && ctx.term) ctx.io.note('bcftools mpileup reads every alignment in the BAM file (or region). In the browser this takes one to a few minutes – a server does it in seconds. The timer at the top of the terminal shows it is still working.');
      // compressed BCF keeps the hand-over file small; bcftools call reads it the same way
      return { args: setOutType(args, 'b') };
    }
    if (!/^[bz]/.test(outType(args))) {
      ctx.io.note(`${why}\nTo keep the pile-up, save it compressed:  -Ob -o results/pileup.bcf  (or pipe it straight into bcftools call).`);
      return { stop: true, code: 1 };
    }
    return { args };
  }

  async function runReal(ctx, program, opts = {}) {
    let args = ctx.args.slice();
    const isBin = binaryOut(program, args);
    const userO = userOutput(program, args);
    let mode;
    if (ctx.redirectTarget === '/dev/null') mode = 'null';
    else if (ctx.redirectTarget && !ctx.redirectAppend) mode = 'file';
    else if (ctx.redirectTarget) mode = 'append';
    else if (ctx.isPipedOut) mode = PIPE_TOOLS.has(ctx.pipeNext) ? 'pipe-tool' : 'pipe-js';
    else mode = 'term';
    if (program === 'bcftools' && args[0] === 'mpileup') {
      const g = mpileupGuard(ctx, args, mode, userO);
      if (g.stop) {
        MG.bus.emit('tool:run', { program, sub: 'mpileup', args: ctx.args, code: g.code, real: true, refused: true });
        return g.code;
      }
      args = g.args;
    }
    let tmp = null;
    if (!userO && supportsO(program, args)) {
      if (program === 'bgzip') args = args.filter((x) => x !== '-c' && x !== '--stdout');
      if (mode === 'file') {
        args = program === 'bgzip' ? args.concat(['-o', ctx.redirectTarget]) : injectOutput(program, args, ctx.redirectTarget);
        ctx.wroteRedirect = true;
      } else {
        tmp = `${TMP}/o${++W.pipeN}.${isBin ? 'bin' : 'txt'}`;
        args = program === 'bgzip' ? args.concat(['-o', tmp]) : injectOutput(program, args, tmp);
      }
    }
    const r = await W.run(ctx, program, args, opts);
    // copies of a BAM and its index often end up with the index dated earlier than the
    // BAM (e.g. after unzipping); htslib then warns on every command
    const OLD_IDX = /^.*\[W::hts_idx_load\d*\] The index file is older than the data file.*(\n|$)/gm;
    if (r.stderr && OLD_IDX.test(r.stderr)) {
      r.stderr = r.stderr.replace(OLD_IDX, '');
      if (!W.warnedOldIndex && ctx.io) {
        W.warnedOldIndex = true;
        ctx.io.note('htslib warned that the index file (.bai) is dated earlier than the BAM file. That only reflects the dates on your copies of the files; the index was made from this BAM, so the warning is harmless and is not shown again.');
      }
    }
    if (r.stderr) ctx.err(r.stderr.endsWith('\n') ? r.stderr : r.stderr + '\n');
    if (tmp) {
      const st = await W.stat(tmp);
      if (st && mode !== 'null') {
        if (mode === 'pipe-tool') ctx.out(new FileRef(tmp, isBin));
        else if (isBin) {
          if (mode === 'term') {
            ctx.out(MG.shellUtil.binaryNoise({ size: st.size }));
            ctx.io.note('That was binary data (BAM/BCF/compressed) printed as text. Save it with -o FILE or > FILE, or look inside with samtools view / bcftools view.');
          } else ctx.out(new FileRef(tmp, true));
        } else if (st.size) ctx.out(tidyHeaderText(await W.readTextSmart(tmp, st.size)));
      }
    } else if (r.stdout && mode !== 'null') {
      if (isBin && mode === 'term') {
        ctx.out(MG.shellUtil.binaryNoise({ size: r.stdout.length }));
        ctx.io.note('That was binary data (BAM/BCF/compressed) printed as text. Save it with -o FILE or > FILE, or look inside with samtools view / bcftools view.');
      } else ctx.out(isBin ? r.stdout : tidyHeaderText(r.stdout));
    }
    MG.bus.emit('tool:run', { program, sub: ctx.args[0] || '', args: ctx.args, code: r.code, secs: r.secs, created: r.created, real: true, line: ctx.rawLine });
    return r.code;
  }
  function injectOutput(program, args, target) {
    const a = args.slice();
    for (let i = 1; i < a.length; i++) {
      if (a[i] === '-o' || a[i] === '--output') {
        a.splice(i, 2);
        break;
      }
    }
    a.splice(1, 0, '-o', target);
    return a;
  }

  T.samtools = {
    summary: 'view, sort, index and summarise alignments (SAM/BAM)',
    subcommands: ['view', 'sort', 'index', 'flagstat', 'idxstats', 'depth', 'coverage', 'faidx', 'stats', 'tview', 'mpileup', 'quickcheck'],
    man: [
      'samtools – tools for alignments in the SAM/BAM format (version 1.17, running in your browser)',
      '',
      '  samtools view [-h] [-H] [-c] [-b] FILE.bam [REGION]   show alignments (-H header only, -c count, -b write BAM)',
      '  samtools sort -o OUT.bam IN.sam|IN.bam                sort alignments by chromosome and position',
      '  samtools index FILE.bam                               make the index FILE.bam.bai (the BAM must be sorted)',
      '  samtools flagstat FILE.bam                            summary: mapped, paired, duplicates …',
      '  samtools idxstats FILE.bam                            reads mapped to each chromosome (needs the index)',
      '  samtools depth [-a] -r chr:start-end FILE.bam         read depth at each position',
      '  samtools coverage [-r REGION] FILE.bam                coverage summary per chromosome/region',
      '  samtools faidx REF.fa chr:start-end                   print a piece of the reference genome',
      '',
      'REGION looks like  chr10:96541600-96541630'
    ].join('\n'),
    run: async (ctx) => {
      const sub = ctx.args[0];
      if (!sub) {
        ctx.out(T.samtools.man + '\n');
        return 1;
      }
      if (MG.simHooks && MG.simHooks.samtools) {
        const r = await MG.simHooks.samtools(ctx);
        if (r !== undefined) return r;
      }
      if (sub === 'tview') {
        ctx.err('samtools tview is interactive (it needs a full-screen terminal). Use the IGV tab to see the reads instead.\n');
        return 1;
      }
      if (sub === 'sort' && ctx.redirectTarget == null && !ctx.args.includes('-o') && !ctx.isPipedOut) {
        ctx.err('[bam_sort] refusing to write BAM data to the terminal – add  -o sorted.bam  (the output file name)\n');
        return 1;
      }
      return runReal(ctx, 'samtools');
    }
  };

  T.bcftools = {
    summary: 'call, filter, query and index variants (VCF/BCF)',
    subcommands: ['mpileup', 'call', 'view', 'query', 'filter', 'norm', 'stats', 'index', 'annotate', 'concat', 'isec'],
    man: [
      'bcftools – tools for variant calls in VCF/BCF format (version 1.10, running in your browser)',
      '',
      '  bcftools mpileup -f REF.fa FILE.bam               pile up the reads at each position (genotype likelihoods)',
      '  bcftools call -mv                                 call variants from mpileup output (-m multiallelic caller, -v variants only)',
      "  bcftools view -i 'QUAL>=30 && INFO/DP>=10' IN.vcf  keep records that pass an expression (-e excludes)",
      '  bcftools view -H IN.vcf                           records only (no header);  -r chr:pos  a region (needs an index)',
      "  bcftools query -f '%CHROM\\t%POS\\t%REF\\t%ALT[\\t%GT]\\n' IN.vcf   print chosen fields",
      '  bcftools index IN.vcf.gz                          index a compressed VCF (for -r region queries)',
      '  bcftools stats IN.vcf                             summary numbers (SNPs, indels, Ts/Tv …)',
      '',
      'Output types:  -Ov plain VCF (default)   -Oz compressed VCF   -Ou/-Ob BCF.   Write to a file with  -o FILE'
    ].join('\n'),
    run: async (ctx) => {
      const sub = ctx.args[0];
      if (!sub) {
        ctx.out(T.bcftools.man + '\n');
        return 1;
      }
      if (MG.simHooks && MG.simHooks.bcftools) {
        const r = await MG.simHooks.bcftools(ctx);
        if (r !== undefined) return r;
      }
      return runReal(ctx, 'bcftools');
    }
  };

  T.bgzip = {
    summary: 'compress a file in the block-gzip format used for genomics indexes',
    man: 'bgzip [-c] [-d] [-k] FILE   compress FILE to FILE.gz (-d decompress, -c write to stdout, -k keep the original)',
    run: async (ctx) => runReal(ctx, 'bgzip')
  };
  T.tabix = {
    summary: 'index a compressed tab-separated file (e.g. FILE.vcf.gz)',
    man: 'tabix -p vcf FILE.vcf.gz   make FILE.vcf.gz.tbi so tools can jump to a region',
    run: async (ctx) => runReal(ctx, 'tabix')
  };

  MG.runReal = runReal;
})();
