/* =====================================================================
   A small bash-like shell for the browser terminal.
   Supports: quotes, ~ and $VAR, globs (* ?), pipes |, && || ;
   redirection > >> < 2> 2>&1, and a set of Unix commands written in
   JavaScript. Bioinformatics tools register themselves in MG.shellTools
   (see tools-sim.js and tools-wasm.js).
   ===================================================================== */
(function () {
  'use strict';
  const MG = (window.MG = window.MG || {});
  const P = () => MG.path;

  /* ------------------------------------------------------------------
     Streams: either a plain string or a "lazy" stream for huge
     simulated files (FASTQ/SAM) that only knows its first/last lines.
     ------------------------------------------------------------------ */
  class Lazy {
    constructor(meta) {
      this.meta = meta;
    }
    get lines() {
      return this.meta.lines;
    }
    head(n) {
      return this.meta.head(n);
    }
    tail(n) {
      return this.meta.tail ? this.meta.tail(n) : [];
    }
  }
  const isLazy = (s) => s instanceof Lazy;
  function linesOf(text) {
    if (!text) return [];
    const L = text.split('\n');
    if (L[L.length - 1] === '') L.pop();
    return L;
  }
  MG.Lazy = Lazy;

  /* ------------------------------------------------------------------
     Tokenizer / parser
     ------------------------------------------------------------------ */
  function tokenize(line, env) {
    const toks = [];
    let i = 0, cur = null, quoted = false;
    const push = () => {
      if (cur !== null) toks.push({ t: 'w', v: cur, q: quoted });
      cur = null;
      quoted = false;
    };
    const expandVar = (s) => s.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, k) => (env && k in env ? env[k] : ''));
    while (i < line.length) {
      const c = line[i];
      if (c === ' ' || c === '\t') {
        push();
        i++;
        continue;
      }
      if (c === '#' && cur === null) break; // comment
      if (c === "'") {
        const j = line.indexOf("'", i + 1);
        if (j < 0) throw new Error('unexpected EOF while looking for matching `\'\'');
        cur = (cur || '') + line.slice(i + 1, j);
        quoted = true;
        i = j + 1;
        continue;
      }
      if (c === '"') {
        let j = i + 1, s = '';
        while (j < line.length && line[j] !== '"') {
          if (line[j] === '\\' && j + 1 < line.length && '"\\$`'.includes(line[j + 1])) {
            s += line[j + 1];
            j += 2;
          } else s += line[j++];
        }
        if (j >= line.length) throw new Error('unexpected EOF while looking for matching `"\'');
        cur = (cur || '') + expandVar(s);
        quoted = true;
        i = j + 1;
        continue;
      }
      if (c === '\\' && i + 1 < line.length) {
        cur = (cur || '') + line[i + 1];
        i += 2;
        continue;
      }
      // operators
      const two = line.slice(i, i + 2), three = line.slice(i, i + 4);
      if (three === '2>&1') {
        push();
        toks.push({ t: 'op', v: '2>&1' });
        i += 4;
        continue;
      }
      if (two === '&&' || two === '||' || two === '>>' || two === '2>' || two === '&>') {
        push();
        if (two === '2>' && line[i + 2] === '>') {
          toks.push({ t: 'op', v: '2>>' });
          i += 3;
        } else {
          toks.push({ t: 'op', v: two });
          i += 2;
        }
        continue;
      }
      if (c === '|' || c === ';' || c === '>' || c === '<') {
        push();
        toks.push({ t: 'op', v: c });
        i++;
        continue;
      }
      if (c === '&') {
        push();
        toks.push({ t: 'op', v: '&' });
        i++;
        continue;
      }
      if (c === '$' && cur === null && line[i + 1] === '(') throw new Error('command substitution $( ) is not supported in this terminal');
      cur = (cur || '') + c;
      i++;
    }
    push();
    // expand $VAR and ~ in unquoted words
    toks.forEach((t) => {
      if (t.t !== 'w' || t.q) return;
      t.v = expandVar(t.v);
      if (t.v === '~' || t.v.startsWith('~/')) t.v = (env.HOME || '/home/student') + t.v.slice(1);
    });
    return toks;
  }

  /** -> [{ pipeline:[{argv, redirs}], op }] */
  function parse(line, env) {
    const toks = tokenize(line, env);
    const list = [];
    let pipeline = [];
    let cmd = { argv: [], redirs: [], globs: [] };
    const endCmd = () => {
      if (cmd.argv.length || cmd.redirs.length) pipeline.push(cmd);
      else if (pipeline.length) throw new Error("syntax error near unexpected token `|'");
      cmd = { argv: [], redirs: [], globs: [] };
    };
    const endPipe = (op) => {
      endCmd();
      if (pipeline.length) list.push({ pipeline, op });
      else if (op && op !== ';') throw new Error(`syntax error near unexpected token \`${op}'`);
      pipeline = [];
    };
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k];
      if (t.t === 'w') {
        cmd.argv.push(t.v);
        cmd.globs.push(!t.q && /[*?]/.test(t.v));
        continue;
      }
      switch (t.v) {
        case '|':
          if (!cmd.argv.length) throw new Error("syntax error near unexpected token `|'");
          endCmd();
          break;
        case '&&':
        case '||':
        case ';':
          endPipe(t.v);
          break;
        case '&':
          endPipe(';');
          break;
        case '>':
        case '>>':
        case '2>':
        case '2>>':
        case '&>':
        case '<': {
          const nx = toks[k + 1];
          if (!nx || nx.t !== 'w') throw new Error(`syntax error near unexpected token \`newline'`);
          cmd.redirs.push({ op: t.v, target: nx.v });
          k++;
          break;
        }
        case '2>&1':
          cmd.redirs.push({ op: '2>&1' });
          break;
        default:
          break;
      }
    }
    endPipe(null);
    return list;
  }

  /* ------------------------------------------------------------------
     Shell
     ------------------------------------------------------------------ */
  class Shell {
    constructor(opts) {
      this.fs = opts.fs;
      this.term = opts.term || null;
      this.env = Object.assign({ HOME: this.fs.home, USER: 'student', SHELL: '/bin/bash', PATH: '/usr/local/bin:/usr/bin:/bin' }, opts.env || {});
      this.history = [];
      this.lastCode = 0;
      this.running = false;
      this.hooks = opts.hooks || {};
    }
    get cwd() {
      return this.fs.cwd;
    }
    /** run one line typed by the user. out(text, cls) writes to the terminal */
    async run(line, io) {
      const trimmed = line.trim();
      if (!trimmed) return 0;
      this.history.push(trimmed);
      let list;
      try {
        list = parse(trimmed, Object.assign({}, this.env, { PWD: this.fs.cwd }));
      } catch (e) {
        io.err('bash: ' + e.message + '\n');
        return (this.lastCode = 2);
      }
      let code = 0;
      this.running = true;
      try {
        for (let k = 0; k < list.length; k++) {
          const prevOp = k > 0 ? list[k - 1].op : null;
          if (prevOp === '&&' && code !== 0) continue;
          if (prevOp === '||' && code === 0) continue;
          code = await this.runPipeline(list[k].pipeline, io, trimmed);
        }
      } finally {
        this.running = false;
      }
      this.lastCode = code;
      if (this.hooks.afterCommand) this.hooks.afterCommand(trimmed, code);
      return code;
    }

    async runPipeline(pipeline, io, rawLine) {
      let stdin = null;
      let code = 0;
      for (let s = 0; s < pipeline.length; s++) {
        const cmd = pipeline[s];
        const last = s === pipeline.length - 1;
        // glob expansion
        let argv = [];
        cmd.argv.forEach((a, i) => {
          if (cmd.globs[i]) argv = argv.concat(this.fs.glob(a));
          else argv.push(a);
        });
        // stdin redirect
        const inR = cmd.redirs.find((r) => r.op === '<');
        if (inR) {
          const e = this.fs.get(inR.target);
          if (!e) {
            io.err(`bash: ${inR.target}: No such file or directory\n`);
            return 1;
          }
          stdin = e.kind === 'virtual' ? new Lazy(e.meta) : await this.fs.readText(inR.target);
        }
        const outR = cmd.redirs.filter((r) => r.op === '>' || r.op === '>>' || r.op === '&>').pop();
        const errR = cmd.redirs.filter((r) => r.op === '2>' || r.op === '2>>').pop();
        const errToOut = cmd.redirs.some((r) => r.op === '2>&1' || r.op === '&>');
        const toTerminal = last && !outR;
        let outBuf = '';
        let outLazy = null;
        let outRef = null;
        let errBuf = '';
        const ctx = {
          shell: this,
          fs: this.fs,
          env: this.env,
          argv,
          name: argv[0],
          args: argv.slice(1),
          stdin,
          isPipedIn: s > 0 || !!inR,
          isPipedOut: !last,
          pipeNext: last ? null : pipeline[s + 1].argv[0] || null,
          redirectTarget: outR ? outR.target : null,
          redirectAppend: outR ? outR.op === '>>' : false,
          rawLine,
          term: this.term,
          io,
          out: (t) => {
            if (t == null) return;
            if (isLazy(t)) {
              outLazy = t;
              return;
            }
            if (MG.FileRef && t instanceof MG.FileRef) {
              outRef = t;
              return;
            }
            if (toTerminal) io.out(t);
            else outBuf += t;
          },
          outHTML: (html) => {
            if (toTerminal && io.html) io.html(html);
          },
          err: (t) => {
            if (errR) errBuf += t;
            else if (errToOut && !toTerminal) outBuf += t;
            else io.err(t);
          },
          progress: (t) => io.progress && io.progress(t),
          lazy: (meta) => new Lazy(meta)
        };
        const name = argv[0];
        if (!name) {
          stdin = '';
          continue;
        }
        try {
          code = await this.dispatch(name, ctx);
        } catch (e) {
          if (e && e.userMessage) ctx.err(e.userMessage.endsWith('\n') ? e.userMessage : e.userMessage + '\n');
          else {
            console.error(e);
            ctx.err(`${name}: ${e && e.message ? e.message : e}\n`);
          }
          code = e && e.code ? e.code : 1;
        }
        if (errR) {
          if (errR.target !== '/dev/null') {
            if (errR.op === '2>>') this.fs.appendText(errR.target, errBuf);
            else this.fs.writeText(errR.target, errBuf);
          }
        }
        const produced = outRef || outLazy || outBuf;
        if (outR) {
          if (outR.target === '/dev/null') {
            /* discard */
          } else if (ctx.wroteRedirect) {
            /* the tool wrote the file itself (e.g. binary output) */
          } else if (outLazy) {
            // simulated large output being saved: the tool must provide a virtual file
            if (ctx.virtualOutput) this.fs.put(outR.target, ctx.virtualOutput);
            else if (outLazy.meta.kind === 'bigfile') this.fs.put(outR.target, { kind: 'aioli', apath: outLazy.meta.apath, size: outLazy.meta.size, fresh: true });
            else this.fs.writeText(outR.target, outLazy.head(outLazy.lines).join('\n') + '\n');
          } else if (outR.op === '>>') this.fs.appendText(outR.target, outBuf);
          else this.fs.writeText(outR.target, outBuf);
          stdin = '';
        } else if (!last) {
          stdin = produced;
        } else if (outRef) {
          io.out(binaryNoise({ size: 999 }));
        } else if (outLazy) {
          printLazy(outLazy, io);
        }
      }
      return code;
    }

    async dispatch(name, ctx) {
      const b = MG.shellBuiltins[name];
      if (b) return (await b(ctx)) || 0;
      const t = MG.shellTools[name];
      if (t) return (await t.run(ctx)) || 0;
      if (this.fs.exists(name) && /\.(sh|py|pl)$/.test(name)) {
        ctx.err(`bash: ${name}: Permission denied\n`);
        return 126;
      }
      if (/^\.\//.test(name)) {
        ctx.err(`bash: ${name}: No such file or directory\n`);
        return 127;
      }
      const hint = suggest(name);
      ctx.err(`${name}: command not found${hint ? ` – did you mean '${hint}'?` : ''}\n`);
      return 127;
    }
  }

  function printLazy(lz, io) {
    const max = 400;
    const n = lz.lines;
    const head = lz.head(Math.min(n, max));
    io.out(head.join('\n') + '\n');
    if (n > max) io.note(`… ${fmtN(n - max)} more lines not shown. A file this size would scroll past for minutes – use head, tail, wc or grep instead.\n`);
  }

  function fmtN(n) {
    return Number(n).toLocaleString('en-GB');
  }

  function allCommandNames() {
    return Object.keys(MG.shellBuiltins).concat(Object.keys(MG.shellTools));
  }
  function suggest(name) {
    let best = null, bd = 3;
    allCommandNames().forEach((c) => {
      const d = lev(name, c);
      if (d < bd) {
        bd = d;
        best = c;
      }
    });
    return best;
  }
  function lev(a, b) {
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > 3) return 9;
    const d = Array.from({ length: m + 1 }, (_, i) => [i].concat(new Array(n).fill(0)));
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[m][n];
  }

  /* ------------------------------------------------------------------
     Option parsing helper:  getopts(args, 'n:c:vh', {long})
     ------------------------------------------------------------------ */
  function getopts(args, spec, longMap) {
    const takes = {};
    spec.replace(/([A-Za-z0-9@])(:?)/g, (m, c, colon) => (takes[c] = !!colon));
    const opts = {};
    const rest = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') {
        rest.push(...args.slice(i + 1));
        break;
      }
      if (a.startsWith('--') && longMap) {
        const [k, v] = a.slice(2).split('=');
        const m = longMap[k];
        if (!m) throw userErr(`unrecognized option '${a}'`);
        if (takes[m]) opts[m] = v != null ? v : args[++i];
        else opts[m] = true;
        continue;
      }
      if (/^-[0-9]+$/.test(a) && takes.n) {
        opts.n = a.slice(1);
        continue;
      }
      if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
        for (let j = 1; j < a.length; j++) {
          const c = a[j];
          if (!(c in takes)) throw userErr(`invalid option -- '${c}'`);
          if (takes[c]) {
            opts[c] = j + 1 < a.length ? a.slice(j + 1) : args[++i];
            break;
          } else opts[c] = true;
        }
        continue;
      }
      rest.push(a);
    }
    return { opts, rest };
  }
  function userErr(msg, code) {
    const e = new Error(msg);
    e.userMessage = msg;
    e.code = code || 1;
    return e;
  }

  /** get the input of a text command: files or stdin → string | Lazy */
  async function inputOf(ctx, files, cmdName) {
    if (!files.length || (files.length === 1 && files[0] === '-')) {
      if (ctx.stdin == null) return '';
      if (MG.FileRef && ctx.stdin instanceof MG.FileRef) {
        if (ctx.stdin.binary) return binaryNoise({ size: 4242 });
        return await MG.wasm.readTextSmart(ctx.stdin.apath);
      }
      return ctx.stdin;
    }
    if (files.length === 1) return readOne(ctx, files[0], cmdName);
    let all = '';
    for (const f of files) {
      const r = await readOne(ctx, f, cmdName);
      if (isLazy(r)) return r;
      all += r;
    }
    return all;
  }
  async function readOne(ctx, f, cmdName, opts = {}) {
    const e = ctx.fs.get(f);
    if (!e) throw userErr(`${cmdName}: ${f}: No such file or directory`);
    if (e.kind === 'dir') throw userErr(`${cmdName}: ${f}: Is a directory`);
    if (e.kind === 'virtual') {
      if (e.meta.gz && !opts.gunzip) return binaryNoise(e);
      if (e.meta.binary) return binaryNoise(e);
      return new Lazy(e.meta);
    }
    if (isBinaryName(f) && !opts.gunzip && !(e.kind === 'text')) return binaryNoise(e);
    if (opts.gunzip && /\.(gz|bgz)$/.test(f) && e.kind !== 'text') {
      if (MG.wasm && MG.wasm.gunzipText) return await MG.wasm.gunzipText(ctx, f);
    }
    // large files made by the real tools are read in pieces
    if (e.kind === 'aioli' && MG.wasm && MG.wasm.readTextSmart) return await MG.wasm.readTextSmart(e.apath, e.size);
    return await ctx.fs.readText(f);
  }
  function isBinaryName(f) {
    return /\.(bam|bai|bcf|csi|tbi|gz|bgz|zip|gzi|sa|bwt|pac|amb|ann)$/.test(f);
  }
  function binaryNoise(e) {
    // what printing a compressed/binary file looks like
    const seed = (e.meta && e.meta.size) || e.size || 1234;
    let x = seed % 2147483647 || 7;
    const rnd = () => (x = (x * 48271) % 2147483647) / 2147483647;
    const chars = '\u001f\u008b\b\u0004\u0000\u0000\u0000\u0000\u0000ÿ\u0006\u0000BC\u0002\u0000ÂýX]oÛÖ¶}ïWðâ\u0003ØÃ¤×\u0092\u0015ç\u001b¹\u0006·i\u0096\u009c¤';
    let s = '';
    for (let i = 0; i < 180; i++) s += rnd() < 0.08 ? '\n' : chars[Math.floor(rnd() * chars.length)];
    return s.replace(/[\u0000-\u0008\u000b-\u001f]/g, '�') + '\n';
  }

  function fileArgsLinesOr(ctx, input) {
    return isLazy(input) ? input : linesOf(input);
  }

  /* ------------------------------------------------------------------
     Builtins (JavaScript versions of common Unix commands)
     ------------------------------------------------------------------ */
  const B = {};

  B.pwd = (ctx) => ctx.out(ctx.fs.cwd + '\n');
  B.cd = (ctx) => {
    const target = ctx.args[0] || ctx.fs.home;
    const abs = ctx.fs.resolve(target === '-' ? ctx.shell.oldpwd || ctx.fs.home : target);
    const e = ctx.fs.entries.get(abs);
    if (!e) throw userErr(`bash: cd: ${target}: No such file or directory`);
    if (e.kind !== 'dir') throw userErr(`bash: cd: ${target}: Not a directory`);
    ctx.shell.oldpwd = ctx.fs.cwd;
    ctx.fs.cwd = abs;
    return 0;
  };
  B.echo = (ctx) => {
    let args = ctx.args.slice();
    let nl = true;
    if (args[0] === '-n') {
      nl = false;
      args.shift();
    }
    let s = args.join(' ');
    if (args[0] === '-e') s = args.slice(1).join(' ').replace(/\\t/g, '\t').replace(/\\n/g, '\n');
    ctx.out(s + (nl ? '\n' : ''));
  };
  B.clear = (ctx) => ctx.io.clear && ctx.io.clear();
  B.whoami = (ctx) => ctx.out('student\n');
  B.hostname = (ctx) => ctx.out((ctx.env.HOSTNAME || 'genomics') + '\n');
  B.date = (ctx) => ctx.out(new Date().toString().replace(/ GMT.*$/, '') + '\n');
  B.history = (ctx) => ctx.out(ctx.shell.history.map((h, i) => String(i + 1).padStart(5) + '  ' + h).join('\n') + '\n');
  B.true = () => 0;
  B.false = () => 1;
  B.exit = (ctx) => {
    ctx.io.note('This terminal lives in the web page – there is nothing to log out of. Keep going!\n');
    return 0;
  };
  B.sudo = (ctx) => {
    ctx.err('student is not in the sudoers file. This incident will be reported. (Only joking – you do not need sudo here.)\n');
    return 1;
  };

  B.ls = (ctx) => {
    const { opts, rest } = getopts(ctx.args, 'lhaA1tSrR', { all: 'a', 'human-readable': 'h' });
    const targets = rest.length ? rest : ['.'];
    const out = [];
    const fmtEntry = (name, e) => {
      if (!opts.l) return name + (e.kind === 'dir' ? '/' : '');
      const size = ctx.fs.size(e);
      const perm = e.kind === 'dir' ? 'drwxr-xr-x' : e.mode === 'x' ? '-rwxr-xr-x' : '-rw-r--r--';
      const d = new Date(e.mtime || Date.now());
      const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
      const time = `${mon} ${String(d.getDate()).padStart(2)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const sz = opts.h ? MG.humanSize(size) : String(size);
      return `${perm} 1 student student ${sz.padStart(opts.h ? 5 : 11)} ${time} ${name}${e.kind === 'dir' ? '/' : ''}`;
    };
    let code = 0;
    targets.forEach((t, ti) => {
      const e = ctx.fs.get(t);
      if (!e) {
        ctx.err(`ls: cannot access '${t}': No such file or directory\n`);
        code = 2;
        return;
      }
      if (e.kind !== 'dir') {
        out.push(fmtEntry(t, e));
        return;
      }
      if (targets.length > 1) out.push((ti ? '\n' : '') + t + ':');
      let kids = ctx.fs.list(t).filter((c) => opts.a || opts.A || (!c.name.startsWith('.') && !c.entry.hidden));
      if (opts.t) kids.sort((a, b) => (b.entry.mtime || 0) - (a.entry.mtime || 0));
      if (opts.S) kids.sort((a, b) => ctx.fs.size(b.entry) - ctx.fs.size(a.entry));
      if (opts.r) kids.reverse();
      if (opts.l) {
        const total = kids.reduce((s, c) => s + Math.ceil(ctx.fs.size(c.entry) / 1024), 0);
        out.push('total ' + (opts.h ? MG.humanSize(total * 1024) : total));
      }
      kids.forEach((c) => out.push(fmtEntry(c.name, c.entry)));
    });
    if (out.length) ctx.out(out.join(opts.l || opts[1] ? '\n' : '\n') + '\n');
    return code;
  };
  B.dir = B.ls;
  B.ll = (ctx) => B.ls(Object.assign({}, ctx, { args: ['-l'].concat(ctx.args) }));

  B.mkdir = (ctx) => {
    const { opts, rest } = getopts(ctx.args, 'pv');
    if (!rest.length) throw userErr('mkdir: missing operand');
    rest.forEach((d) => {
      if (ctx.fs.exists(d) && !opts.p) throw userErr(`mkdir: cannot create directory '${d}': File exists`);
      const parent = MG.path.dirname(ctx.fs.resolve(d));
      if (!opts.p && !ctx.fs.isDir(parent)) throw userErr(`mkdir: cannot create directory '${d}': No such file or directory`);
      ctx.fs.mkdirp(d);
    });
  };
  B.touch = (ctx) => {
    ctx.args.forEach((f) => {
      const e = ctx.fs.get(f);
      if (e) e.mtime = Date.now();
      else ctx.fs.writeText(f, '');
    });
  };
  B.rm = (ctx) => {
    const { opts, rest } = getopts(ctx.args, 'rfRiv');
    if (!rest.length) throw userErr('rm: missing operand');
    let code = 0;
    rest.forEach((f) => {
      const e = ctx.fs.get(f);
      if (!e) {
        if (!opts.f) {
          ctx.err(`rm: cannot remove '${f}': No such file or directory\n`);
          code = 1;
        }
        return;
      }
      if (e.protected) {
        ctx.err(`rm: cannot remove '${f}': Permission denied (the course data is read-only)\n`);
        code = 1;
        return;
      }
      if (e.kind === 'dir' && !opts.r && !opts.R) {
        ctx.err(`rm: cannot remove '${f}': Is a directory\n`);
        code = 1;
        return;
      }
      ctx.fs.remove(f);
    });
    return code;
  };
  B.rmdir = (ctx) => {
    ctx.args.forEach((d) => {
      if (!ctx.fs.isDir(d)) throw userErr(`rmdir: failed to remove '${d}': No such file or directory`);
      if (ctx.fs.list(d).length) throw userErr(`rmdir: failed to remove '${d}': Directory not empty`);
      ctx.fs.remove(d);
    });
  };
  B.cp = (ctx) => {
    const { rest } = getopts(ctx.args, 'rRfv');
    if (rest.length < 2) throw userErr('cp: missing destination file operand');
    const dest = rest.pop();
    rest.forEach((src) => {
      if (!ctx.fs.exists(src)) throw userErr(`cp: cannot stat '${src}': No such file or directory`);
      const target = ctx.fs.isDir(dest) ? dest.replace(/\/$/, '') + '/' + MG.path.basename(src) : dest;
      ctx.fs.copy(src, target);
    });
  };
  B.mv = (ctx) => {
    const { rest } = getopts(ctx.args, 'fv');
    if (rest.length < 2) throw userErr('mv: missing destination file operand');
    const dest = rest.pop();
    rest.forEach((src) => {
      const e = ctx.fs.get(src);
      if (!e) throw userErr(`mv: cannot stat '${src}': No such file or directory`);
      if (e.protected) throw userErr(`mv: cannot move '${src}': Permission denied (the course data is read-only)`);
      const target = ctx.fs.isDir(dest) ? dest.replace(/\/$/, '') + '/' + MG.path.basename(src) : dest;
      ctx.fs.rename(src, target);
    });
  };

  B.cat = async (ctx) => {
    const { opts, rest } = getopts(ctx.args, 'nAe');
    const input = await inputOf(ctx, rest, 'cat');
    if (isLazy(input)) return ctx.out(input);
    if (opts.n) ctx.out(linesOf(input).map((l, i) => String(i + 1).padStart(6) + '\t' + l).join('\n') + '\n');
    else ctx.out(input);
  };
  B.less = async (ctx) => {
    const input = await inputOf(ctx, ctx.args.filter((a) => !a.startsWith('-')), 'less');
    if (!ctx.isPipedOut) ctx.io.note('(less shows a file one screen at a time; here the whole file is printed – scroll the terminal)\n');
    ctx.out(input);
  };
  B.more = B.less;
  B.zcat = async (ctx) => {
    const files = ctx.args.filter((a) => !a.startsWith('-'));
    if (!files.length) {
      if (ctx.stdin == null) throw userErr('zcat: compressed data not read from a terminal.');
      return ctx.out(ctx.stdin);
    }
    for (const f of files) {
      const e = ctx.fs.get(f);
      if (!e) throw userErr(`gzip: ${f}: No such file or directory`);
      if (e.kind === 'virtual') {
        if (!e.meta.gz) throw userErr(`gzip: ${f}: not in gzip format`);
        ctx.out(new Lazy(e.meta));
        continue;
      }
      if (!/\.(gz|bgz)$/.test(f)) throw userErr(`gzip: ${f}: not in gzip format`);
      ctx.out(await readOne(ctx, f, 'zcat', { gunzip: true }));
    }
  };
  B.gzcat = B.zcat;
  B.gunzip = async (ctx) => {
    if (ctx.args.includes('-c')) return B.zcat(Object.assign({}, ctx, { args: ctx.args.filter((a) => a !== '-c') }));
    throw userErr('gunzip: in this practical keep the files compressed – use zcat FILE | head to look inside');
  };

  function parseN(v, def) {
    if (v == null) return def;
    const n = parseInt(String(v).replace(/^\+/, ''), 10);
    if (isNaN(n)) throw userErr(`invalid number of lines: '${v}'`);
    return n;
  }
  B.head = async (ctx) => {
    const { opts, rest } = getopts(ctx.args, 'n:c:qv', { lines: 'n', bytes: 'c' });
    const n = parseN(opts.n, 10);
    const input = await inputOf(ctx, rest, 'head');
    if (isLazy(input)) return ctx.out(input.head(n).join('\n') + (n > 0 ? '\n' : ''));
    if (opts.c) return ctx.out(input.slice(0, parseN(opts.c, 0)));
    const L = linesOf(input);
    const take = n < 0 ? L.slice(0, L.length + n) : L.slice(0, n);
    if (take.length) ctx.out(take.join('\n') + '\n');
  };
  B.tail = async (ctx) => {
    const { opts, rest } = getopts(ctx.args, 'n:c:fq', { lines: 'n' });
    const raw = opts.n;
    const n = parseN(raw, 10);
    const input = await inputOf(ctx, rest, 'tail');
    if (isLazy(input)) {
      if (raw && String(raw).startsWith('+')) {
        ctx.io.note('(showing the start of this large simulated file)\n');
        return ctx.out(input.head(Math.min(400, input.lines)).slice(n - 1).join('\n') + '\n');
      }
      return ctx.out(input.tail(n).join('\n') + '\n');
    }
    const L = linesOf(input);
    const take = raw && String(raw).startsWith('+') ? L.slice(n - 1) : L.slice(Math.max(0, L.length - n));
    if (take.length) ctx.out(take.join('\n') + '\n');
  };
  B.wc = async (ctx) => {
    const { opts, rest } = getopts(ctx.args, 'lwcm', { lines: 'l', words: 'w', bytes: 'c', chars: 'm' });
    const any = opts.l || opts.w || opts.c || opts.m;
    const files = rest.length ? rest : [null];
    const rows = [];
    for (const f of files) {
      let lines, words, bytes;
      if (f) {
        const e = ctx.fs.get(f);
        if (!e) throw userErr(`wc: ${f}: No such file or directory`);
        if (e.kind === 'virtual') {
          lines = e.meta.gz ? e.meta.gzLines || Math.round(e.meta.size / 40) : e.meta.lines;
          bytes = e.meta.size;
          words = e.meta.words || lines;
          rows.push({ lines, words, bytes, name: f });
          continue;
        }
      }
      const input = f ? await readOne(ctx, f, 'wc') : ctx.stdin == null ? '' : ctx.stdin;
      if (isLazy(input)) {
        lines = input.lines;
        bytes = input.meta.textBytes || input.meta.size || 0;
        words = input.meta.words || lines;
      } else {
        const L = linesOf(input);
        lines = (input.match(/\n/g) || []).length;
        words = L.reduce((s, l) => s + (l.trim() ? l.trim().split(/\s+/).length : 0), 0);
        bytes = new Blob([input]).size;
      }
      rows.push({ lines, words, bytes, name: f });
    }
    const fmt = (r) => {
      const parts = [];
      if (!any || opts.l) parts.push(r.lines);
      if (!any || opts.w) parts.push(r.words);
      if (!any || opts.c || opts.m) parts.push(r.bytes);
      const w = parts.length === 1 && !r.name ? 0 : 7;
      return parts.map((p) => String(p).padStart(w)).join(' ') + (r.name ? ' ' + r.name : '');
    };
    rows.forEach((r) => ctx.out(fmt(r) + '\n'));
    if (rows.length > 1) ctx.out(fmt({ lines: rows.reduce((s, r) => s + r.lines, 0), words: rows.reduce((s, r) => s + r.words, 0), bytes: rows.reduce((s, r) => s + r.bytes, 0), name: 'total' }) + '\n');
  };

  /** translate a (basic) grep regex into a JavaScript RegExp */
  function grepRegex(pat, opts) {
    let src = pat;
    if (opts.F) src = pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (!opts.E) {
      // basic regex: \| \( \) \{ \} are operators; bare ( ) | { } + ? are literals
      src = src
        .replace(/\\([|(){}+?])/g, '\u0000$1')
        .replace(/([|(){}+?])/g, '\\$1')
        .replace(/\u0000([|(){}+?])/g, '$1');
    }
    src = src.replace(/\\t/g, '\t').replace(/\[\[:space:\]\]/g, '\\s').replace(/\[\[:digit:\]\]/g, '\\d').replace(/\[\[:alpha:\]\]/g, '[A-Za-z]');
    if (opts.w) src = '\\b(?:' + src + ')\\b';
    if (opts.x) src = '^(?:' + src + ')$';
    try {
      return new RegExp(src, opts.i ? 'i' : '');
    } catch (e) {
      throw userErr(`grep: invalid regular expression '${pat}'`);
    }
  }
  B.grep = async (ctx) => {
    const { opts, rest } = getopts(ctx.args, 'vcinwxEFolhHm:e:A:B:C:', { count: 'c', invert: 'v', 'ignore-case': 'i', 'line-number': 'n', 'max-count': 'm', 'after-context': 'A', 'before-context': 'B', context: 'C' });
    const after = parseInt(opts.A != null ? opts.A : opts.C || 0, 10) || 0;
    const before = parseInt(opts.B != null ? opts.B : opts.C || 0, 10) || 0;
    let pat = opts.e;
    const files = rest.slice();
    if (pat == null) {
      if (!files.length) throw userErr('Usage: grep [OPTION]... PATTERNS [FILE]...');
      pat = files.shift();
    }
    const re = grepRegex(pat, opts);
    const multi = files.length > 1;
    let matched = 0;
    const doLines = (L, name) => {
      let c = 0;
      const outL = [];
      const max = opts.m ? parseInt(opts.m, 10) : Infinity;
      let lastOut = -1;
      for (let i = 0; i < L.length && c < max; i++) {
        const hit = re.test(L[i]) !== !!opts.v;
        if (!hit) continue;
        c++;
        if (opts.c || opts.l) continue;
        if (after || before) {
          // context lines (GNU grep style, groups separated by --)
          const from = Math.max(lastOut + 1, i - before);
          if (lastOut >= 0 && from > lastOut + 1) outL.push('--');
          for (let j = from; j < i; j++) outL.push(L[j]);
          outL.push(L[i]);
          let j = i + 1;
          for (; j < L.length && j <= i + after; j++) {
            if (re.test(L[j]) !== !!opts.v) break;
            outL.push(L[j]);
          }
          lastOut = j - 1;
          i = j - 1;
          continue;
        }
        const pre = (multi && !opts.h ? name + ':' : '') + (opts.n ? i + 1 + ':' : '');
        if (opts.o && !opts.v) {
          const g = new RegExp(re.source, re.flags + 'g');
          let m;
          while ((m = g.exec(L[i]))) {
            outL.push(pre + m[0]);
            if (!m[0]) g.lastIndex++;
          }
        } else outL.push(pre + L[i]);
      }
      matched += c;
      if (opts.l) {
        if (c) ctx.out(name + '\n');
      } else if (opts.c) ctx.out((multi ? name + ':' : '') + c + '\n');
      else if (outL.length) ctx.out(outL.join('\n') + '\n');
    };
    const targets = files.length ? files : [null];
    for (const f of targets) {
      let input;
      if (f) {
        const e = ctx.fs.get(f);
        if (!e) {
          ctx.err(`grep: ${f}: No such file or directory\n`);
          continue;
        }
        if (e.kind === 'dir') {
          ctx.err(`grep: ${f}: Is a directory\n`);
          continue;
        }
        if (e.kind === 'virtual' && (e.meta.gz || e.meta.binary)) {
          ctx.out(`grep: ${f}: binary file matches\n`);
          continue;
        }
        input = await readOne(ctx, f, 'grep');
      } else input = ctx.stdin == null ? '' : ctx.stdin;
      if (isLazy(input)) {
        const m = input.meta;
        if (m.grep) {
          const r = await m.grep(re, opts);
          if (r) {
            if (opts.c) ctx.out((multi ? f + ':' : '') + r.count + '\n');
            else if (opts.l) {
              if (r.count) ctx.out((f || '(standard input)') + '\n');
            } else if (r.tail && r.count > r.lines.length) {
              // too many matches to hold: pass on a stream that knows how many lines it has
              const first = r.lines, last = r.tail;
              ctx.out(new Lazy({ lines: r.count, head: (n) => first.slice(0, n), tail: (n) => last.slice(-n) }));
            } else ctx.out(r.lines.join('\n') + (r.lines.length ? '\n' : ''));
            if (r.note) ctx.io.note(r.note + '\n');
            matched += r.count;
            continue;
          }
        }
        doLines(input.head(Math.min(4000, input.lines)), f);
        ctx.io.note(`(this simulated file has ${fmtN(input.lines)} lines; grep searched a sample of the first 4,000 here)\n`);
        continue;
      }
      doLines(linesOf(input), f);
    }
    return matched ? 0 : 1;
  };
  B.egrep = (ctx) => B.grep(Object.assign({}, ctx, { args: ['-E'].concat(ctx.args) }));
  B.zgrep = async (ctx) => {
    ctx.io.note('(zgrep: searching inside the compressed file)\n');
    return B.grep(ctx);
  };

  function parseList(spec) {
    const out = [];
    String(spec).split(',').forEach((part) => {
      const m = /^(\d*)-(\d*)$/.exec(part);
      if (m) out.push([m[1] ? +m[1] : 1, m[2] ? +m[2] : Infinity]);
      else if (/^\d+$/.test(part)) out.push([+part, +part]);
      else throw userErr(`cut: invalid field value '${part}'`);
    });
    return (i) => out.some(([a, b]) => i >= a && i <= b);
  }
  B.cut = async (ctx) => {
    const { opts, rest } = getopts(ctx.args, 'f:d:c:s', { fields: 'f', delimiter: 'd', characters: 'c' });
    if (!opts.f && !opts.c) throw userErr('cut: you must specify a list of bytes, characters, or fields');
    const input = await inputOf(ctx, rest, 'cut');
    const L = isLazy(input) ? input.head(Math.min(input.lines, 2000)) : linesOf(input);
    const d = opts.d == null ? '\t' : opts.d === '\\t' ? '\t' : opts.d;
    let out;
    if (opts.c) {
      const sel = parseList(opts.c);
      out = L.map((l) => l.split('').filter((_, i) => sel(i + 1)).join(''));
    } else {
      const sel = parseList(opts.f);
      out = L.filter((l) => !opts.s || l.includes(d)).map((l) => (l.includes(d) ? l.split(d).filter((_, i) => sel(i + 1)).join(d) : l));
    }
    ctx.out(out.join('\n') + (out.length ? '\n' : ''));
  };
  B.sort = async (ctx) => {
    const { opts, rest } = getopts(ctx.args, 'nrugk:t:V', { numeric: 'n', reverse: 'r', unique: 'u' });
    const input = await inputOf(ctx, rest, 'sort');
    let L = isLazy(input) ? input.head(Math.min(input.lines, 5000)) : linesOf(input);
    const t = opts.t === '\\t' ? '\t' : opts.t;
    let key = (l) => l;
    if (opts.k) {
      const m = /^(\d+)(?:,(\d+))?([nrg]*)$/.exec(opts.k);
      if (!m) throw userErr(`sort: invalid key '${opts.k}'`);
      const a = +m[1] - 1, b = m[2] ? +m[2] : null;
      if (m[3].includes('n') || m[3].includes('g')) opts.n = true;
      if (m[3].includes('r')) opts.r = true;
      key = (l) => {
        const f = t ? l.split(t) : l.trim().split(/\s+/);
        return (b ? f.slice(a, b) : f.slice(a)).join(t || ' ');
      };
    }
    const num = (s) => {
      const v = parseFloat(s);
      return isNaN(v) ? 0 : v;
    };
    L = L.slice().sort((x, y) => {
      const kx = key(x), ky = key(y);
      const c = opts.n || opts.g ? num(kx) - num(ky) : kx < ky ? -1 : kx > ky ? 1 : 0;
      return c || (x < y ? -1 : x > y ? 1 : 0);
    });
    if (opts.r) L.reverse();
    if (opts.u) L = L.filter((l, i) => i === 0 || key(l) !== key(L[i - 1]));
    ctx.out(L.join('\n') + (L.length ? '\n' : ''));
  };
  B.uniq = async (ctx) => {
    const { opts, rest } = getopts(ctx.args, 'cdu');
    const input = await inputOf(ctx, rest, 'uniq');
    const L = isLazy(input) ? input.head(Math.min(input.lines, 5000)) : linesOf(input);
    const groups = [];
    L.forEach((l) => {
      const g = groups[groups.length - 1];
      if (g && g.l === l) g.n++;
      else groups.push({ l, n: 1 });
    });
    const out = groups.filter((g) => (opts.d ? g.n > 1 : opts.u ? g.n === 1 : true)).map((g) => (opts.c ? String(g.n).padStart(7) + ' ' + g.l : g.l));
    ctx.out(out.join('\n') + (out.length ? '\n' : ''));
  };
  B.tr = async (ctx) => {
    const [a, b] = ctx.args.filter((x) => !x.startsWith('-'));
    const input = typeof ctx.stdin === 'string' ? ctx.stdin : '';
    if (ctx.args.includes('-d')) return ctx.out(input.split('').filter((c) => !unesc(a).includes(c)).join(''));
    const A = unesc(a || ''), Bx = unesc(b || '');
    ctx.out(input.split('').map((c) => (A.includes(c) ? Bx[Math.min(A.indexOf(c), Bx.length - 1)] : c)).join(''));
  };
  const unesc = (s) => String(s).replace(/\\t/g, '\t').replace(/\\n/g, '\n');
  B.column = async (ctx) => {
    const { opts, rest } = getopts(ctx.args, 'ts:');
    const input = await inputOf(ctx, rest, 'column');
    const L = linesOf(isLazy(input) ? input.head(400).join('\n') : input);
    if (!opts.t) return ctx.out(input);
    const sep = opts.s === '\\t' || opts.s == null ? /\t/ : opts.s;
    const rows = L.map((l) => l.split(sep));
    const w = [];
    rows.forEach((r) => r.forEach((c, i) => (w[i] = Math.max(w[i] || 0, c.length))));
    ctx.out(rows.map((r) => r.map((c, i) => (i < r.length - 1 ? c.padEnd(w[i]) : c)).join('  ')).join('\n') + '\n');
  };

  /* mini awk: supports  -F sep,  'COND {print $1,$2}',  NR, NF, $0, comparisons, && ||, /regex/ */
  B.awk = async (ctx) => {
    let args = ctx.args.slice();
    let fs = null;
    const vars = {};
    while (args.length && args[0].startsWith('-')) {
      const a = args.shift();
      if (a === '-F') fs = args.shift();
      else if (a.startsWith('-F')) fs = a.slice(2);
      else if (a === '-v') {
        const [k, v] = args.shift().split('=');
        vars[k] = v;
      } else throw userErr(`awk: unsupported option ${a} in this terminal`);
    }
    const prog = args.shift();
    if (!prog) throw userErr('usage: awk [-F fs] \'program\' [file ...]');
    const input = await inputOf(ctx, args, 'awk');
    const L = isLazy(input) ? input.head(Math.min(input.lines, 5000)) : linesOf(input);
    const sep = fs == null ? null : fs === '\\t' || fs === 't' ? '\t' : fs;
    const run = MG.miniAwk(prog, vars);
    const out = [];
    L.forEach((line, i) => {
      const f = sep ? line.split(sep) : line.trim().split(/\s+/);
      const r = run(line, f, i + 1);
      if (r != null) out.push(...r);
    });
    const end = run.end && run.end();
    if (end) out.push(...end);
    ctx.out(out.join('\n') + (out.length ? '\n' : ''));
  };
  MG.miniAwk = function (prog, vars) {
    // split into  pattern { action }  or  pattern  or  { action }
    const m = /^\s*(?:BEGIN\s*\{([^}]*)\})?\s*([^{]*?)\s*(?:\{([^}]*)\})?\s*(?:END\s*\{([^}]*)\})?\s*$/.exec(prog);
    if (!m) throw userErr('awk: this terminal understands simple programs like  \'$6 >= 30 {print $1, $2}\'');
    const pattern = (m[2] || '').trim();
    const action = (m[3] == null ? 'print $0' : m[3]).trim();
    const endAction = (m[4] || '').trim();
    const state = Object.assign({}, vars);
    const toJS = (expr) =>
      expr
        .replace(/\$NF/g, 'F[F.length-1]')
        .replace(/\$(\d+)/g, (x, n) => (n === '0' ? 'L0' : `F[${+n - 1}]`))
        .replace(/\bNR\b/g, 'NR')
        .replace(/\bNF\b/g, 'F.length')
        .replace(/!~\s*\/((?:\\\/|[^/])*)\//g, (x, r) => `.match(/${r}/)==null`)
        .replace(/~\s*\/((?:\\\/|[^/])*)\//g, (x, r) => `.match(/${r}/)!=null`)
        .replace(/(^|[^=!<>~.])\/((?:\\\/|[^/])+)\//g, (x, pre, r) => `${pre}/${r}/.test(L0)`)
        .replace(/([^=!<>])=([^=])/g, '$1==$2');
    const numOrStr = 'const V=(x)=>{const n=Number(x);return x!==""&&!isNaN(n)?n:x;};';
    let cond = () => true;
    if (pattern) {
      try {
        // compare numerically when both sides look numeric
        const js = toJS(pattern).replace(/F\[(\d+)\]/g, 'V(F[$1])');
        cond = new Function('L0', 'F', 'NR', 'S', numOrStr + 'return (' + js + ');');
      } catch (e) {
        throw userErr('awk: could not understand the pattern ' + pattern);
      }
    }
    const stmts = action.split(';').map((s) => s.trim()).filter(Boolean);
    const compiled = stmts.map((s) => {
      const pm = /^print\s*(.*)$/.exec(s);
      if (pm) {
        const items = pm[1].trim() ? splitTop(pm[1]) : ['$0'];
        const fns = items.map((it) => new Function('L0', 'F', 'NR', 'S', numOrStr + 'return (' + toJS(it).replace(/\bS\.(\w+)/g, 'S.$1') + ');'));
        return (L0, F, NR) => ({ print: fns.map((fn) => fn(L0, F, NR, state)).join(pm[1].includes(',') ? '\t' : '') });
      }
      const inc = /^(\w+)\s*(\+\+|\+=\s*(.+))$/.exec(s);
      if (inc) {
        const fn = inc[3] ? new Function('L0', 'F', 'NR', 'S', numOrStr + 'return Number(' + toJS(inc[3]) + ');') : () => 1;
        return (L0, F, NR) => {
          state[inc[1]] = (Number(state[inc[1]]) || 0) + fn(L0, F, NR, state);
          return null;
        };
      }
      throw userErr('awk: this terminal only understands print and simple counters (x++ / x+=$5)');
    });
    const run = (L0, F, NR) => {
      let ok;
      try {
        ok = cond(L0, F, NR, state);
      } catch (e) {
        ok = false;
      }
      if (!ok) return null;
      const out = [];
      compiled.forEach((c) => {
        const r = c(L0, F, NR);
        if (r && r.print != null) out.push(r.print);
      });
      return out;
    };
    if (endAction) {
      run.end = () => {
        const pm = /^print\s*(.*)$/.exec(endAction);
        if (!pm) return null;
        const items = splitTop(pm[1]);
        return [items.map((it) => (/^\w+$/.test(it.trim()) ? state[it.trim()] || 0 : it.replace(/"/g, ''))).join(pm[1].includes(',') ? '\t' : '')];
      };
    }
    return run;
    function splitTop(s) {
      const out = [];
      let depth = 0, cur = '', q = false;
      for (const ch of s) {
        if (ch === '"') q = !q;
        if (!q && ch === '(') depth++;
        if (!q && ch === ')') depth--;
        if (!q && depth === 0 && ch === ',') {
          out.push(cur.trim());
          cur = '';
        } else cur += ch;
      }
      if (cur.trim()) out.push(cur.trim());
      return out;
    }
  };

  B.file = (ctx) => {
    ctx.args.forEach((f) => {
      const e = ctx.fs.get(f);
      if (!e) return ctx.out(`${f}: cannot open (No such file or directory)\n`);
      let d = e.describe || (e.meta && e.meta.describe);
      if (!d) {
        if (e.kind === 'dir') d = 'directory';
        else if (/\.bam$/.test(f)) d = 'Blocked GNU Zip Format (BGZF; gzip compatible), block length 6420 (BAM binary alignment file)';
        else if (/\.bai$/.test(f)) d = 'data (BAM index)';
        else if (/\.gz$/.test(f)) d = 'gzip compressed data';
        else if (/\.vcf$/.test(f)) d = 'Variant Call Format (VCF) version 4.2, ASCII text';
        else if (/\.sam$/.test(f)) d = 'Sequence Alignment/Map (SAM), ASCII text';
        else if (/\.fa(sta)?$/.test(f)) d = 'ASCII text (FASTA)';
        else d = 'ASCII text';
      }
      ctx.out(`${f}: ${d}\n`);
    });
  };
  B.du = (ctx) => {
    const { opts, rest } = getopts(ctx.args, 'shac');
    (rest.length ? rest : ['.']).forEach((p) => {
      const abs = ctx.fs.resolve(p);
      let tot = 0;
      for (const [k, v] of ctx.fs.entries) if (k === abs || k.startsWith(abs + '/')) tot += v.kind === 'dir' ? 0 : ctx.fs.size(v);
      ctx.out((opts.h ? MG.humanSize(tot) : Math.ceil(tot / 1024)) + '\t' + p + '\n');
    });
  };
  B.tree = (ctx) => {
    const root = ctx.args[0] || '.';
    const lines = [root];
    const walk = (p, pre) => {
      const kids = ctx.fs.list(p).filter((c) => !c.name.startsWith('.'));
      kids.forEach((c, i) => {
        const lastK = i === kids.length - 1;
        lines.push(pre + (lastK ? '└── ' : '├── ') + c.name);
        if (c.entry.kind === 'dir') walk(c.path, pre + (lastK ? '    ' : '│   '));
      });
    };
    walk(ctx.fs.resolve(root), '');
    ctx.out(lines.join('\n') + '\n');
  };
  B.download = async (ctx) => {
    const files = ctx.args.filter((a) => !a.startsWith('-'));
    if (!files.length) throw userErr('usage: download FILE …   (saves a copy of FILE to your computer)');
    for (const f of files) {
      const e = ctx.fs.get(f);
      if (!e) throw userErr(`download: ${f}: No such file or directory`);
      if (e.kind === 'dir') throw userErr(`download: ${f}: is a directory`);
      if (e.kind === 'virtual') throw userErr(`download: ${f} is part of the simulation (a real one would be ${MG.humanSize(ctx.fs.size(e))}B) and cannot be saved – download the files you made with samtools or bcftools`);
      const blob = await ctx.fs.toBlob(f);
      MG.downloadBlob(blob, MG.path.basename(ctx.fs.resolve(f)));
      ctx.out(`Saving ${MG.path.basename(ctx.fs.resolve(f))} (${MG.humanSize(blob.size)}B) to your Downloads folder\n`);
    }
  };
  B.which = (ctx) => {
    let code = 0;
    ctx.args.forEach((c) => {
      if (MG.shellTools[c]) ctx.out(`/usr/local/bin/${c}\n`);
      else if (MG.shellBuiltins[c]) ctx.out(`/usr/bin/${c}\n`);
      else code = 1;
    });
    return code;
  };
  B.type = B.which;
  B.help = (ctx) => {
    const tools = Object.entries(MG.shellTools)
      .filter(([, t]) => !t.hidden)
      .map(([k, t]) => `  ${k.padEnd(12)} ${t.summary || ''}`);
    ctx.out(
      [
        'Commands available in this terminal',
        '',
        'Bioinformatics tools:',
        ...tools,
        '',
        'Unix commands:',
        '  ls, cd, pwd, mkdir, cp, mv, rm, cat, less, head, tail, wc, grep, cut, sort, uniq, awk, zcat, file, tree, history, clear',
        '  download FILE   save a copy of a file you made to your computer',
        '',
        'Tips:  ↑/↓ recall commands · Tab completes names · Ctrl+C cancels · type  man <tool>  for help on a tool',
        ''
      ].join('\n')
    );
  };
  B.man = (ctx) => {
    const name = ctx.args[0];
    if (!name) throw userErr('What manual page do you want?');
    const t = MG.shellTools[name];
    if (t && t.man) return ctx.out(t.man + '\n');
    const bman = BUILTIN_MAN[name];
    if (bman) return ctx.out(bman + '\n');
    throw userErr(`No manual entry for ${name}`);
  };
  const BUILTIN_MAN = {
    ls: 'ls [-l] [-h] [-a] [DIR]   list files (-l long format, -h human-readable sizes)',
    head: 'head [-n N] FILE           print the first N lines (default 10)',
    tail: 'tail [-n N] FILE           print the last N lines (default 10)',
    wc: 'wc [-l] FILE               count lines (-l), words (-w) and bytes (-c)',
    grep: "grep [-v] [-c] [-i] PATTERN FILE   print lines that match PATTERN (-v: that don't match; -c: count them)",
    zcat: 'zcat FILE.gz               print the uncompressed contents of a gzip file',
    cut: 'cut -f 1,2,4 FILE          print selected tab-separated columns',
    sort: 'sort [-n] [-r] [-k N]      sort lines (-n numerically, -r reversed, -k by column N)',
    uniq: 'uniq [-c]                  collapse repeated adjacent lines (-c: count them)',
    awk: "awk '$6 >= 30 {print $1, $2}' FILE   filter rows and print columns"
  };

  MG.shellBuiltins = B;
  MG.shellTools = MG.shellTools || {};
  MG.Shell = Shell;
  MG.shellUtil = { getopts, userErr, inputOf, readOne, linesOf, isLazy, fmtN, parse, tokenize, binaryNoise };
})();
