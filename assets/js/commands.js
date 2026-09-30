/* =====================================================================
   Proteins in 3D – command language for the viewer.
   Used by the command line and by the ▶ buttons in the tutorial, so a
   lecturer can script a view without writing JavaScript, e.g.
     load 3fxi; hide all; show cartoon A; show glass C; color hydrophobicity C
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const { bus, toast, esc } = MG;

  const STYLE_ALIASES = {
    cartoon: 'cartoon', ribbon: 'cartoon', ribbons: 'cartoon', tube: 'tube', trace: 'tube',
    sticks: 'sticks', stick: 'sticks', licorice: 'sticks', xstick: 'sticks',
    ballstick: 'ballstick', 'ball+stick': 'ballstick', balls: 'ballstick', ball: 'ballstick',
    spheres: 'spheres', sphere: 'spheres', cpk: 'spheres', spacefill: 'spheres',
    surface: 'surface', skin: 'surface', glass: 'glass', transparent: 'glass', 'see-through': 'glass',
    lines: 'lines', line: 'lines', wire: 'lines'
  };
  const SCHEME_ALIASES = {
    chain: 'chain', chains: 'chain', molecule: 'molecule', entity: 'molecule', rainbow: 'rainbow', spectrum: 'rainbow',
    ss: 'ss', secondary: 'ss', 'secondary-structure': 'ss', sstruc: 'ss', hydrophobicity: 'hydrophobicity', hydrophobic: 'hydrophobicity', kd: 'hydrophobicity',
    restype: 'restype', residue: 'restype', 'residue-type': 'restype', element: 'element', atom: 'element', cpk: 'cpk',
    plddt: 'plddt', confidence: 'plddt', bfactor: 'bfactor', 'b-factor': 'bfactor', default: 'default', reset: 'default'
  };

  const HELP = [
    ['load 3fxi', 'Load an entry from the Protein Data Bank (if already loaded it is reused; “load 3fxi again” loads a second copy)'],
    ['load af O00206', 'Load the AlphaFold model for a UniProt accession'],
    ['show cartoon A', 'Add a style: cartoon, tube, sticks, ballstick, spheres, surface, glass, lines'],
    ['hide all water', 'Remove styles (all or one style) from part of the structure'],
    ['only sticks LPS', 'Show just this one style'],
    ['undisplay B  /  display B', 'Hide / show (like the eye icons)'],
    ['isolate A or C', 'Hide everything except this'],
    ['color rainbow A', 'Schemes: chain, molecule, rainbow, ss, hydrophobicity, restype, element, cpk, plddt, bfactor, default'],
    ['color orange C', 'Named colours or #hex codes'],
    ['select C:126  ·  select A:264-300  ·  select LPS', 'Select by chain:residue, ranges, named groups or NGL syntax'],
    ['select near LPS 4.5', 'Residues within 4.5 Å'],
    ['site LPS 4.5', 'Binding site: nearby residues as sticks + interactions'],
    ['contacts LPS  /  contacts off', 'Show / hide interaction lines'],
    ['center LPS  ·  reset', 'Camera'],
    ['label sele  ·  label2d "My title"  ·  labels clear', 'Labels'],
    ['key on  ·  key auto  ·  key add red "My entry"', 'Colour key'],
    ['distance A:341.NZ A:264.NH2  ·  distance clear', 'Distances between atoms'],
    ['superpose AF-O00206-F1:A onto 3FXI:A', 'Superpose one chain on another (RMSD is reported)'],
    ['view save "Pocket"  ·  view 1', 'Saved views'],
    ['background black  ·  spin on  ·  opacity 0.4', 'Other settings'],
    ['export png 2', 'Download the picture'],
    ['help', 'This list']
  ];

  /** split "a b 'c d' \"e f\"" into tokens (keeps quoted strings) */
  function tokenize(s) {
    const out = [];
    const re = /"([^"]*)"|'([^']*)'|“([^”]*)”|(\S+)/g;
    let m;
    while ((m = re.exec(s))) out.push(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3] != null ? m[3] : m[4]);
    return out;
  }
  function splitScript(text) {
    const cmds = [];
    let cur = '', q = null;
    for (const ch of String(text)) {
      if (q) {
        cur += ch;
        if (ch === q || (q === '“' && ch === '”')) q = null;
      } else if (ch === '"' || ch === "'" || ch === '“') {
        q = ch;
        cur += ch;
      } else if (ch === ';' || ch === '\n') {
        if (cur.trim()) cmds.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    if (cur.trim()) cmds.push(cur.trim());
    return cmds;
  }

  function parseAtom(V, spec) {
    // [structure] chain:resno.atom   e.g.  3fxi A:341.NZ
    const parts = spec.trim().split(/\s+/);
    let st = null;
    if (parts.length > 1) st = V.findStructure(parts.shift());
    const m = /^([A-Za-z0-9]{1,4}):(-?\d+)([A-Za-z]?)\.([A-Za-z0-9'*]+)$/.exec(parts.join(''));
    if (!m) throw new Error('Atom “' + spec + '” should look like A:341.NZ');
    const list = st ? [st] : V.structures;
    for (const s of list) {
      const r = s.residues.find((r) => r.chain === m[1] && r.resno === +m[2] && (r.ins || '') === (m[3] || ''));
      if (!r) continue;
      for (let a = r.a0; a < r.a0 + r.na; a++) if (s.atomnames[a].toUpperCase() === m[4].toUpperCase()) return { st: s, atom: a };
    }
    throw new Error('No atom ' + spec);
  }

  async function runOne(line, ctx) {
    const V = MG.app.viewer;
    const UI = MG.app.vui;
    const A = MG.app.annot;
    const toks = tokenize(line);
    if (!toks.length) return;
    const verb = toks[0].toLowerCase();
    const rest = toks.slice(1);
    const restStr = line.replace(/^\s*\S+\s*/, '');
    const tgt = (arr) => (arr.length ? arr.join(' ') : undefined);
    const needSt = () => {
      if (!V.structures.length) throw new Error('Load a structure first (e.g. load 3fxi)');
    };
    switch (verb) {
      case 'help':
      case '?': {
        UI.consoleEl.classList.remove('collapsed');
        HELP.forEach(([c, d]) => UI.log(c.padEnd(46) + ' ' + d, 'help'));
        return;
      }
      case 'load':
      case 'fetch':
      case 'open': {
        if (!rest.length) throw new Error('Usage: load 3fxi   or   load af O00206');
        let st;
        const flags = rest.map((x) => x.toLowerCase());
        const live = flags.includes('live');
        const again = flags.includes('again');
        const args = rest.filter((x) => !/^(live|again)$/i.test(x));
        /* In a tutorial people press "show me" more than once: if the entry is already
           loaded, reuse it rather than stacking up copies ("load 3fxi again" forces a copy). */
        if (!again && !live && args[0] && !/^https?:\/\//i.test(args[0])) {
          const isAF = /^(af|alphafold)$/i.test(args[0]) || /^AF-/i.test(args[0]);
          const raw = String(isAF && !/^AF-/i.test(args[0]) ? args[1] || '' : args[0]).toLowerCase();
          const want = isAF ? 'af-' + raw.replace(/^af-/, '').replace(/-f\d+$/, '') + '-f1' : raw;
          const existing = V.structures.find((s) => s.key === want);
          if (existing) {
            if (!existing.visible) V.setStructureVisible(existing, true);
            UI.log('# ' + existing.name + ' is already loaded (add “again” to load a second copy)', 'help');
            toast(esc(existing.name) + ' is already loaded.');
            bus.emit('viewer:loaded', { st: existing, id: existing.name, kind: existing.kind, acc: existing.source.acc, again: true });
            if (ctx.showTab !== false) MG.app.showWorkbench && MG.app.showWorkbench('viewer');
            return existing;
          }
        }
        if (/^(af|alphafold)$/i.test(args[0])) st = await V.loadAlphaFold(args[1], { live });
        else if (/^AF-/i.test(args[0])) st = await V.loadAlphaFold(args[0], { live });
        else if (/^https?:\/\//i.test(args[0])) st = await V.loadURL(args[0], args[1]);
        else st = await V.loadPDB(args[0], { live });
        if (ctx.showTab !== false) MG.app.showWorkbench && MG.app.showWorkbench('viewer');
        return st;
      }
      case 'alphafold':
      case 'af':
        return runOne('load af ' + restStr, ctx);
      case 'remove':
      case 'delete': {
        if (!rest.length || rest[0].toLowerCase() === 'all') return V.clear();
        const st = V.findStructure(rest[0]);
        if (!st) throw new Error('No structure called ' + rest[0]);
        return V.remove(st);
      }
      case 'clear':
      case 'new':
        V.clear();
        A.clearAll();
        A.key = { visible: false, auto: true, entries: [], title: 'Key' };
        A.render();
        return;
      case 'show':
      case 'hide':
      case 'only':
      case 'style': {
        needSt();
        let type = (rest[0] || '').toLowerCase();
        if (verb === 'hide' && (type === 'all' || type === 'everything' || !type)) return V.hide('all', tgt(rest.slice(1)));
        const t = STYLE_ALIASES[type];
        if (!t) {
          if (verb === 'hide') return V.hide('all', tgt(rest));
          throw new Error('Unknown style “' + type + '”. Try cartoon, sticks, spheres, surface, glass');
        }
        if (verb === 'show') return V.show(t, tgt(rest.slice(1)));
        if (verb === 'hide') return V.hide(t, tgt(rest.slice(1)));
        return V.only(t, tgt(rest.slice(1)));
      }
      case 'display':
      case 'unhide':
        needSt();
        return V.setVisible(tgt(rest) || 'all', true);
      case 'undisplay':
      case 'invisible':
        needSt();
        if (!rest.length) throw new Error('Undisplay what? e.g. undisplay B');
        return V.setVisible(tgt(rest), false);
      case 'isolate':
        needSt();
        return V.isolate(tgt(rest));
      case 'showall':
        return V.showEverything();
      case 'enable':
      case 'disable': {
        const st = V.findStructure(rest[0]);
        if (!st) throw new Error('No structure called ' + rest[0]);
        return V.setStructureVisible(st, verb === 'enable');
      }
      case 'color':
      case 'colour': {
        needSt();
        const what = (rest[0] || '').toLowerCase();
        const sch = SCHEME_ALIASES[what];
        if (sch) return V.colorScheme(sch, tgt(rest.slice(1)));
        if (MG.isColor(what)) return V.colorUniform(MG.colorToHex(what), tgt(rest.slice(1)));
        throw new Error('Unknown colour or scheme “' + what + '”');
      }
      case 'select':
      case 'sel': {
        needSt();
        const sub = (rest[0] || '').toLowerCase();
        if (!sub) throw new Error('Select what? e.g. select A:126');
        if (sub === 'none' || sub === 'clear') return V.clearSelection();
        if (sub === 'all') return V.select(V.allMap(), 'set');
        if (sub === 'invert') return V.invertSelection();
        if (sub === 'add' || sub === 'remove' || sub === 'toggle') {
          const m = V.resolve(rest.slice(1).join(' '));
          if (!m.size) throw new Error('Nothing matches “' + rest.slice(1).join(' ') + '”');
          return V.select(m, sub);
        }
        if (sub === 'near' || sub === 'within') {
          const dist = parseFloat(rest[rest.length - 1]);
          const hasD = !isNaN(dist);
          const q = rest.slice(1, hasD ? -1 : undefined).join(' ');
          const base = q ? V.target(q) : V.selectionMap();
          if (!base.size) throw new Error('Nothing to measure from');
          const near = V.near(base, hasD ? dist : 4.5);
          if (!near.size) throw new Error('Nothing nearby');
          return V.select(near, 'set');
        }
        const m = V.resolve(rest.join(' '));
        if (!m.size) throw new Error('Nothing matches “' + rest.join(' ') + '”');
        return V.select(m, 'set');
      }
      case 'pick':
        V.pickLevel = ['atom', 'residue', 'chain'].includes(rest[0]) ? rest[0] : 'residue';
        return;
      case 'center':
      case 'centre':
      case 'zoom':
      case 'focus':
        needSt();
        return V.centerOn(tgt(rest));
      case 'reset':
        return V.resetView();
      case 'orient': {
        // orient <name>  – a named view from config.js (e.g. orient dimer)
        if (rest.length === 1 && isNaN(Number(rest[0]))) {
          const v = V.presetView(rest[0].toLowerCase());
          if (!v) throw new Error('No saved orientation called “' + rest[0] + '” for the loaded structures');
          return;
        }
        // orient <16 numbers>  – restore an exact camera orientation (use "camera" to print one)
        const nums = rest.map(Number);
        if (nums.length !== 16 || nums.some(isNaN)) throw new Error('orient needs 16 numbers (type “camera” to get the current ones)');
        const mat = V.stage.viewerControls.getOrientation();
        mat.fromArray(nums);
        V.stage.viewerControls.orient(mat);
        return;
      }
      case 'camera': {
        const arr = V.stage.viewerControls.getOrientation().toArray().map((x) => +x.toFixed(3));
        UI.consoleEl.classList.remove('collapsed');
        UI.log('orient ' + arr.join(' '), 'help');
        return;
      }
      case 'spin':
        V.setSpin((rest[0] || 'on').toLowerCase() !== 'off');
        UI.spinBtn.classList.toggle('on', V.spinning);
        return;
      case 'background':
      case 'bg':
        V.setBackground((rest[0] || 'white').toLowerCase());
        UI.root.classList.toggle('dark-bg', V.bg !== 'white');
        V.structures.forEach((st) => V._syncDistances(st));
        return;
      case 'opacity':
      case 'transparency': {
        let v = parseFloat(rest[0]);
        if (verb === 'transparency') v = 1 - v;
        V.setGlassOpacity(v);
        UI.opacityInput.value = Math.round(V.glassOpacity * 100);
        return;
      }
      case 'site':
      case 'bindingsite': {
        needSt();
        const d = parseFloat(rest[rest.length - 1]);
        const hasD = !isNaN(d) && rest.length > 0;
        const q = rest.slice(0, hasD ? -1 : undefined).join(' ');
        const m = V.target(q || undefined);
        const res = V.bindingSite(m, hasD ? d : 4.5);
        UI.showSiteList(res, hasD ? d : 4.5);
        return res;
      }
      case 'contacts':
      case 'interactions':
      case 'hbonds': {
        needSt();
        if ((rest[0] || '').toLowerCase() === 'off') return V.hideInteractions();
        const hyd = rest.some((x) => /^hydrophobic$/i.test(x));
        const q = rest.filter((x) => !/^hydrophobic$/i.test(x)).join(' ');
        return V.showInteractions(V.target(q || undefined), { hydrophobic: hyd });
      }
      case 'label': {
        needSt();
        if (rest.length) V.select(V.target(rest.join(' ')), 'set');
        return A.labelSelection();
      }
      case 'label3d': {
        needSt();
        const text = rest[0];
        if (!text) throw new Error('label3d "text" [what]');
        return A.add3D(text, tgt(rest.slice(1)));
      }
      case 'label2d': {
        const text = rest[0];
        if (!text) throw new Error('label2d "text" [x y]  (x, y from 0 to 1)');
        const fx = rest[1] != null ? parseFloat(rest[1]) : undefined, fy = rest[2] != null ? parseFloat(rest[2]) : undefined;
        return A.add2D(text, fx, fy);
      }
      case 'labels':
        if ((rest[0] || 'clear').toLowerCase() === 'clear') return A.clearAll();
        return;
      case 'key':
      case 'legend': {
        const sub = (rest[0] || 'on').toLowerCase();
        if (sub === 'on' || sub === 'show') return A.toggleKey(true);
        if (sub === 'off' || sub === 'hide') return A.toggleKey(false);
        if (sub === 'auto' || sub === 'rebuild') return A.rebuildKey(true);
        if (sub === 'clear') {
          A.key.entries = [];
          A.key.auto = false;
          return A.render();
        }
        if (sub === 'title') {
          A.key.title = rest.slice(1).join(' ');
          A.key.auto = false;
          return A.render();
        }
        if (sub === 'add') {
          const col = MG.colorToHex(rest[1]);
          A.key.visible = true;
          A.key.auto = false;
          A.key.entries.push({ color: col, text: rest.slice(2).join(' ') || 'Entry' });
          return A.render();
        }
        throw new Error('key on | off | auto | clear | title <text> | add <colour> <text>');
      }
      case 'distance':
      case 'dist':
      case 'measure': {
        needSt();
        if ((rest[0] || '').toLowerCase() === 'clear') return V.clearDistances();
        // tokens: [structure] chain:res.atom [structure] chain:res.atom
        const specs = [];
        let pendingSt = null;
        rest.forEach((tok) => {
          if (/^[A-Za-z0-9]{1,4}:-?\d+[A-Za-z]?\.[A-Za-z0-9'*]+$/.test(tok)) {
            specs.push((pendingSt ? pendingSt + ' ' : '') + tok);
            pendingSt = null;
          } else pendingSt = tok;
        });
        if (specs.length < 2) throw new Error('Usage: distance A:341.NZ A:264.NH2  (chain:residue.atom)');
        const a = parseAtom(V, specs[0]), b = parseAtom(V, specs[1]);
        if (a.st !== b.st) throw new Error('Both atoms must be in the same structure');
        return V.addDistance(a.st, a.atom, b.atom);
      }
      case 'view':
      case 'views': {
        const sub = (rest[0] || '').toLowerCase();
        if (sub === 'save') return UI.saveView(rest.slice(1).join(' ') || undefined);
        if (sub === 'clear') {
          UI.views = [];
          return UI.renderViews();
        }
        const k = parseInt(sub, 10);
        if (!isNaN(k)) return UI.restoreView(k - 1);
        const idx = UI.views.findIndex((v) => v.name.toLowerCase() === rest.join(' ').toLowerCase());
        if (idx >= 0) return UI.restoreView(idx);
        throw new Error('view save "name"  ·  view 1');
      }
      case 'superpose':
      case 'align': {
        needSt();
        // superpose MOBILE[:CHAIN] onto TARGET[:CHAIN]
        const onto = rest.findIndex((x) => /^(onto|on|to)$/i.test(x));
        if (onto < 1) throw new Error('superpose AF-O00206-F1:A onto 3FXI:A');
        const parse = (s) => {
          const [n, c] = s.split(':');
          const st = V.findStructure(n);
          if (!st) throw new Error('No structure called ' + n);
          return { st, chain: c };
        };
        const mob = parse(rest[0]), tar = parse(rest[onto + 1]);
        const r = V.superpose(mob.st, mob.chain, tar.st, tar.chain);
        const msg = `Superposed ${r.mobile} chain ${r.mobileChain} onto ${r.target} chain ${r.targetChain}: RMSD <b>${r.rmsd.toFixed(2)} Å</b> over ${r.n} Cα atoms (of ${r.nAll} aligned; all-pairs RMSD ${r.rmsdAll.toFixed(1)} Å; sequence identity ${(r.identity * 100).toFixed(0)}%)`;
        toast(msg, 'ok', 9000);
        UI.log('# ' + msg.replace(/<[^>]+>/g, ''));
        return r;
      }
      case 'export':
      case 'png': {
        if (rest[0] && /^\d$/.test(rest[rest.length - 1])) UI.expScale.value = rest[rest.length - 1];
        return UI.exportPNG();
      }
      case 'tab':
        MG.app.showWorkbench && MG.app.showWorkbench('viewer');
        return UI.showTab((rest[0] || 'display').toLowerCase());
      case 'wait':
      case 'sleep':
        return new Promise((r) => setTimeout(r, Math.min(10000, parseInt(rest[0], 10) || 500)));
      case 'echo':
        return toast(esc(restStr));
      default:
        throw new Error('Unknown command “' + verb + '” – type help');
    }
  }

  async function run(text, opts = {}) {
    const UI = MG.app.vui;
    const cmds = splitScript(text);
    let last;
    for (const c of cmds) {
      if (c.startsWith('#')) continue;
      try {
        last = await runOne(c, opts);
        UI.log((opts.prefix || '') + c, opts.echo ? 'typed' : undefined);
        bus.emit('viewer:command', { text: c });
      } catch (e) {
        UI.log((opts.prefix || '') + c, 'err');
        UI.log('  ' + (e.message || e), 'err');
        toast(esc(e.message || String(e)), 'error');
        if (opts.throw) throw e;
        break;
      }
    }
    return last;
  }

  MG.commands = { run, tokenize, splitScript, HELP };
})();
