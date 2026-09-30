/* =====================================================================
   Proteins in 3D – molecular viewer engine (wraps NGL Viewer)
   Holds the display state (what is shown, how it is coloured, what is
   selected) for every loaded structure and keeps NGL in sync with it.
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const { bus, toast, niceRes, AA3 } = MG;

  /* ---------------- colours ---------------- */
  const hex = (s) => parseInt(String(s).replace('#', ''), 16);
  const toHex = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0').slice(-6);
  const SEL_COLOR = 0x39ff14;
  const PALETTE = [
    '#4E79A7', '#F28E2B', '#59A14F', '#E15759', '#76B7B2', '#EDC948', '#B07AA1', '#FF9DA7', '#9C755F',
    '#86BCB6', '#D37295', '#A0CBE8', '#FFBE7D', '#8CD17D', '#B6992D', '#499894', '#E49444', '#D4A6C8',
    '#79706E', '#F1CE63'
  ].map(hex);
  const LIGAND_C = 0x6e6e6e;
  const SUGAR_C = 0xc8a882;
  const ELEMENT = {
    H: 0xffffff, C: 0x909090, N: 0x3050f8, O: 0xff0d0d, S: 0xe6c619, P: 0xff8000, F: 0x90e050, CL: 0x1ff01f,
    BR: 0xa62929, I: 0x940094, MG: 0x2fbf2f, CA: 0x3d9a3d, NA: 0xab5cf2, K: 0x8f40d4, ZN: 0x7d80b0, FE: 0xe06633,
    MN: 0x9c7ac7, CU: 0xc88033, CO: 0xf090a0, NI: 0x50d050, SE: 0xffa100, CD: 0xffd98f, HG: 0xb8b8d0
  };
  const ELEMENT_NAMES = {
    C: 'Carbon', N: 'Nitrogen', O: 'Oxygen', S: 'Sulfur', P: 'Phosphorus', MG: 'Magnesium', CA: 'Calcium',
    ZN: 'Zinc', FE: 'Iron', NA: 'Sodium', K: 'Potassium', CL: 'Chlorine', MN: 'Manganese', CU: 'Copper', SE: 'Selenium',
    F: 'Fluorine', BR: 'Bromine', I: 'Iodine'
  };
  const SS = {
    helix: { color: 0xe4572e, label: 'α-helix' },
    strand: { color: 0xf4c430, label: 'β-strand' },
    coil: { color: 0xc3c9d0, label: 'Loop / coil' }
  };
  const PLDDT = [
    { min: 90, color: 0x0053d6, label: 'Very high (pLDDT > 90)' },
    { min: 70, color: 0x65cbf3, label: 'Confident (70–90)' },
    { min: 50, color: 0xffdb13, label: 'Low (50–70)' },
    { min: -1e9, color: 0xff7d45, label: 'Very low (pLDDT < 50)' }
  ];
  const KD = {
    I: 4.5, V: 4.2, L: 3.8, F: 2.8, C: 2.5, M: 1.9, A: 1.8, G: -0.4, T: -0.7, S: -0.8, W: -0.9, Y: -1.3,
    P: -1.6, H: -3.2, E: -3.5, Q: -3.5, D: -3.5, N: -3.5, K: -3.9, R: -4.5
  };
  const RESTYPE = [
    { key: 'acidic', res: 'DE', color: 0xe5484d, label: 'Acidic (Asp, Glu)' },
    { key: 'basic', res: 'KRH', color: 0x3e7bd6, label: 'Basic (Lys, Arg, His)' },
    { key: 'polar', res: 'STNQCY', color: 0x43b06a, label: 'Polar (Ser, Thr, Asn, Gln, Cys, Tyr)' },
    { key: 'hydrophobic', res: 'AVLIMFWP', color: 0xf0b85a, label: 'Hydrophobic (Ala, Val, Leu, Ile, Met, Phe, Trp, Pro)' },
    { key: 'glycine', res: 'G', color: 0xe6e6e6, label: 'Glycine' }
  ];
  const HYD_LOW = 0x2f7fc1, HYD_MID = 0xf7f7f7, HYD_HIGH = 0xd9601a;

  function lerp(a, b, t) {
    const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
    const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
    return (Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t);
  }
  function hsl(hh, s, l) {
    const k = (n) => (n + hh / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
  }
  const rainbow = (t) => hsl(240 * (1 - t), 0.85, 0.5);
  const plddtColor = (v) => PLDDT.find((b) => v > b.min).color;
  const hydColor = (v) => (v >= 0 ? lerp(HYD_MID, HYD_HIGH, v / 4.5) : lerp(HYD_MID, HYD_LOW, -v / 4.5));

  /* ---------------- representations ---------------- */
  const REPS = {
    cartoon: { label: 'Cartoon', ngl: 'cartoon', polymer: true, params: { aspectRatio: 5, quality: 'auto', smoothSheet: true } },
    tube: { label: 'Tube', ngl: 'tube', polymer: true, params: { radiusScale: 1.2 } },
    sticks: { label: 'Sticks', ngl: 'licorice', params: { multipleBond: 'symmetric', radiusScale: 0.9 } },
    ballstick: { label: 'Ball & stick', ngl: 'ball+stick', params: { multipleBond: 'symmetric', aspectRatio: 1.9 } },
    spheres: { label: 'Spheres (CPK)', ngl: 'spacefill', params: {} },
    lines: { label: 'Lines', ngl: 'line', params: { linewidth: 2 } },
    surface: { label: 'Surface', ngl: 'surface', surface: true, params: {} },
    glass: { label: 'Transparent surface', ngl: 'surface', surface: true, params: {} }
  };
  const REP_TYPES = Object.keys(REPS);
  const ATOM_REPS = ['sticks', 'ballstick', 'spheres', 'lines'];
  const BACKBONE = new Set(['N', 'C', 'O', 'OXT']);

  let uidCounter = 0;

  /* ================================================================== */
  class Viewer {
    constructor(container, opts = {}) {
      this.container = container;
      this.opts = opts;
      this.structures = [];
      this.bg = 'white';
      this.glassOpacity = 0.45;
      this.showSelection = true;
      this.pickLevel = 'residue';
      this.mode = 'pick';
      this.csrc = [null];
      this.csrcIndex = new Map();
      this.presets = (MG.config.presets || {});
      this._colorTimer = null;
      this.stage = new NGL.Stage(container, {
        backgroundColor: 'white',
        tooltip: false,
        quality: 'medium',
        cameraFov: 30,
        clipDist: 0,
        fogNear: 60,
        fogFar: 100,
        lightIntensity: 1.15,
        ambientIntensity: 0.35,
        hoverTimeout: 0
      });
      this._setupMouse();
      const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.stage.handleResize()) : null;
      if (ro) ro.observe(container);
      else window.addEventListener('resize', () => this.stage.handleResize());
      this.stage.viewer.signals.rendered.add(() => bus.emit('viewer:rendered'));
    }

    /* ---------------- mouse ---------------- */
    _setupMouse() {
      const mc = this.stage.mouseControls;
      const A = NGL.MouseActions;
      mc.clear();
      mc.add('scroll', A.zoomScroll);
      mc.add('drag-left', A.rotateDrag);
      mc.add('drag-right', A.panDrag);
      mc.add('drag-ctrl-left', A.panDrag);
      mc.add('drag-meta-left', A.panDrag);
      mc.add('drag-shift-left', A.zoomDrag);
      mc.add('drag-middle', A.zoomDrag);
      mc.add('drag-ctrl-right', A.zRotateDrag);
      const click = (mod) => (stage, pp) => this._onClick(pp, mod);
      mc.add('clickPick-left', click(''));
      mc.add('clickPick-shift-left', click('shift'));
      mc.add('clickPick-ctrl-left', click('ctrl'));
      mc.add('clickPick-meta-left', click('ctrl'));
      mc.add('hoverPick', (stage, pp) => this._onHover(pp));
    }

    _pickAtom(pp) {
      if (!pp) return null;
      let atom = pp.atom || pp.closestBondAtom;
      if (!atom && pp.surface && pp.component) {
        try {
          atom = pp.component.structure.getAtomProxy(pp.surface.surface.atomindex[pp.surface.index]);
        } catch (e) {
          atom = null;
        }
      }
      if (!atom) return null;
      const st = this.structures.find((s) => s.comp === pp.component);
      if (!st) return null;
      return { st, atom: atom.index };
    }

    _onHover(pp) {
      const hit = this._pickAtom(pp);
      let info = null;
      if (hit) info = this.describeAtom(hit.st, hit.atom);
      else if (pp && pp.contact) {
        const c = pp.contact;
        const st = this.structures.find((s) => s.comp === pp.component);
        const d = c.atom1.distanceTo(c.atom2);
        info = {
          text: `${c.type}: ${this._atomLabel(st, c.atom1.index)} ↔ ${this._atomLabel(st, c.atom2.index)} (${d.toFixed(1)} Å)`
        };
      } else if (pp && pp.distance) {
        info = { text: 'Distance measurement' };
      }
      bus.emit('viewer:hover', { hit, info, pos: pp ? pp.canvasPosition : null });
    }

    _onClick(pp, mod) {
      const hit = this._pickAtom(pp);
      bus.emit('viewer:click', { hit, mod, pp });
      if (this.mode === 'measure') {
        if (hit) this._measureClick(hit);
        return;
      }
      if (this.mode !== 'pick') return;
      const now = Date.now();
      if (hit && this._lastClick && now - this._lastClick.t < 350 && this._lastClick.key === hit.st.uid + ':' + hit.atom) {
        this.centerOn(this._atomsForLevel(hit.st, hit.atom, 'residue'), hit.st);
        this._lastClick = null;
        return;
      }
      this._lastClick = hit ? { t: now, key: hit.st.uid + ':' + hit.atom } : null;
      if (!hit) return;
      const idx = this._atomsForLevel(hit.st, hit.atom, this.pickLevel);
      const m = new Map([[hit.st, idx]]);
      if (mod === 'ctrl') this.select(m, 'toggle');
      else if (mod === 'shift') this.select(m, 'add');
      else this.select(m, 'set');
    }

    _atomsForLevel(st, atom, level) {
      if (level === 'atom') return [atom];
      const r = st.residues[st.atomRes[atom]];
      if (level === 'chain') {
        if (r.poly) {
          const ch = st.chains.find((c) => c.name === r.chain);
          if (ch) return Array.from(ch.atoms);
        }
        const g = st.groups.find((g) => g.resSet.has(r.i));
        if (g) return Array.from(g.atoms);
      }
      if (level === 'molecule' && !r.poly) {
        const g = st.groups.find((g) => g.resSet.has(r.i));
        if (g) return Array.from(g.atoms);
      }
      const out = [];
      for (let a = r.a0; a < r.a0 + r.na; a++) out.push(a);
      return out;
    }

    /* ---------------- loading ---------------- */
    async loadPDB(id, opts = {}) {
      id = String(id || '').trim().toUpperCase();
      if (!/^[0-9][A-Z0-9]{3}$/.test(id)) throw new Error('“' + id + '” is not a valid 4-character PDB ID');
      const lower = id.toLowerCase();
      const bundled = (MG.config.bundled.pdb || {})[id];
      const sources = [];
      if (bundled && MG.config.preferBundledData && !opts.live) sources.push({ url: bundled, ext: 'bcif', bundled: true });
      sources.push({ url: `https://models.rcsb.org/v1/${lower}/full?encoding=bcif`, ext: 'bcif' });
      sources.push({ url: `https://files.rcsb.org/download/${id}.cif`, ext: 'cif' });
      if (bundled && !sources[0].bundled) sources.push({ url: bundled, ext: 'bcif', bundled: true });
      const st = await this._loadFromSources(sources, { name: id, kind: 'pdb', source: { type: 'pdb', id } });
      return st;
    }

    async loadAlphaFold(acc, opts = {}) {
      acc = String(acc || '').trim().toUpperCase().replace(/^AF-/, '').replace(/-F\d+$/, '');
      if (!/^[A-Z0-9]{6,10}(-\d+)?$/.test(acc)) throw new Error('“' + acc + '” does not look like a UniProt accession');
      const info = await MG.alphafoldInfo(acc);
      const bundled = (MG.config.bundled.alphafold || {})[acc];
      const sources = [];
      if (bundled && bundled.model && MG.config.preferBundledData && !opts.live) sources.push({ url: bundled.model, ext: 'bcif', bundled: true });
      if (info.bcifUrl) sources.push({ url: info.bcifUrl, ext: 'bcif' });
      if (info.cifUrl) sources.push({ url: info.cifUrl, ext: 'cif' });
      if (bundled && bundled.model && !(sources[0] || {}).bundled) sources.push({ url: bundled.model, ext: 'bcif', bundled: true });
      const st = await this._loadFromSources(sources, {
        name: info.entryId || 'AF-' + acc + '-F1',
        kind: 'alphafold',
        source: { type: 'alphafold', acc },
        af: info
      });
      return st;
    }

    async loadFile(file) {
      const name = file.name || 'structure';
      const m = /\.([a-z0-9]+)(\.gz)?$/i.exec(name);
      let ext = m ? m[1].toLowerCase() : 'pdb';
      if (ext === 'ent') ext = 'pdb';
      if (ext === 'mmcif') ext = 'cif';
      if (!['pdb', 'cif', 'bcif', 'mol2', 'sdf', 'gro', 'pqr', 'mmtf'].includes(ext)) {
        throw new Error('Unsupported file type “.' + ext + '”. Use .pdb, .cif or .bcif');
      }
      const short = name.replace(/\.(pdb|ent|cif|mmcif|bcif|gz|mol2|sdf|txt)+$/gi, '') || 'file';
      const st = await this._loadBlob(file, ext, { name: short, kind: 'file', source: { type: 'file', fileName: name } });
      st.fileBlob = file;
      return st;
    }

    async loadURL(url, ext, name) {
      return this._loadFromSources([{ url, ext: ext || (/\.cif/i.test(url) ? 'cif' : /\.bcif/i.test(url) ? 'bcif' : 'pdb') }], {
        name: name || url.split('/').pop(),
        kind: 'file',
        source: { type: 'url', url }
      });
    }

    async _loadFromSources(sources, meta) {
      bus.emit('viewer:busy', { on: true, text: 'Loading ' + meta.name + '…' });
      let lastErr;
      try {
        for (const src of sources) {
          try {
            const r = await MG.fetchWithTimeout(src.url, {}, src.bundled ? 30000 : 45000);
            const blob = await r.blob();
            const st = await this._loadBlob(blob, src.ext, Object.assign({}, meta, { url: src.url, bundled: !!src.bundled }));
            return st;
          } catch (e) {
            lastErr = e;
            console.warn('source failed', src.url, e);
          }
        }
        throw lastErr || new Error('Could not load ' + meta.name);
      } finally {
        bus.emit('viewer:busy', { on: false });
      }
    }

    async _loadBlob(blob, ext, meta) {
      bus.emit('viewer:busy', { on: true, text: 'Building ' + meta.name + '…' });
      try {
        const comp = await this.stage.loadFile(blob, { ext, name: meta.name, defaultRepresentation: false });
        if (!comp || !comp.structure) throw new Error('No structure found in file');
        const st = this._initStructure(comp, meta);
        this.structures.push(st);
        this._applyDefaults(st);
        this._syncAll(st);
        if (this.structures.length === 1 || meta.autoView !== false) this.stage.autoView(0);
        bus.emit('viewer:loaded', { st, id: st.name, kind: st.kind, acc: st.source.acc });
        bus.emit('viewer:changed', { what: 'structures' });
        return st;
      } finally {
        bus.emit('viewer:busy', { on: false });
      }
    }

    _uniqueName(name) {
      let n = name, k = 2;
      const has = (x) => this.structures.some((s) => s.name.toLowerCase() === x.toLowerCase());
      while (has(n)) n = `${name}(${k++})`;
      return n;
    }

    _initStructure(comp, meta) {
      const s = comp.structure;
      const n = s.atomCount;
      const st = {
        uid: ++uidCounter,
        comp,
        s,
        n,
        name: this._uniqueName(meta.name),
        kind: meta.kind,
        source: meta.source || {},
        url: meta.url,
        bundled: meta.bundled,
        af: meta.af || null,
        title: s.title || (meta.af ? 'AlphaFold model of ' + (meta.af.uniprotDescription || meta.af.uniprotAccession) : ''),
        header: s.header || {},
        masks: {},
        hidden: new Uint8Array(n),
        sel: new Uint8Array(n),
        color: new Uint32Array(n),
        tint: new Uint8Array(n),
        csrc: new Uint16Array(n),
        reprs: {},
        surfaces: new Map(),
        distances: [],
        contacts: null,
        visible: true
      };
      REP_TYPES.forEach((t) => (st.masks[t] = new Uint8Array(n)));
      st.key = st.name.toLowerCase();

      /* residues */
      const residues = [];
      const atomRes = new Int32Array(n);
      s.eachResidue((r) => {
        const i = residues.length;
        const prot = r.isProtein();
        const nuc = !prot && r.isNucleic();
        const poly = prot || nuc;
        let type = poly ? (prot ? 'protein' : 'nucleic') : r.isWater() ? 'water' : r.isIon() ? 'ion' : r.isSaccharide() ? 'sugar' : 'ligand';
        let ss = 'coil';
        const code = r.sstruc;
        if (code === 'h' || code === 'g' || code === 'i') ss = 'helix';
        else if (code === 'e' || code === 'b') ss = 'strand';
        residues.push({
          i, chain: r.chainname, chainid: r.chainid, resno: r.resno, ins: r.inscode || '', resname: r.resname,
          one: AA3[r.resname] || (poly ? 'X' : '?'), ss, type, poly, prot, nuc,
          a0: r.atomOffset, na: r.atomCount, trace: r.traceAtomIndex, entity: r.entityIndex, bf: 0
        });
        for (let a = r.atomOffset; a < r.atomOffset + r.atomCount; a++) atomRes[a] = i;
      });
      st.residues = residues;
      st.atomRes = atomRes;
      /* per-residue B-factor / pLDDT from CA (or first atom) */
      const ap = s.getAtomProxy();
      residues.forEach((r) => {
        ap.index = r.trace >= 0 && r.trace < n ? r.trace : r.a0;
        r.bf = ap.bfactor;
        r.ca = r.trace >= 0 && r.trace < n ? r.trace : r.a0;
      });
      st.elements = new Array(n);
      s.eachAtom((a) => (st.elements[a.index] = (a.element || '').toUpperCase()));
      st.atomnames = new Array(n);
      s.eachAtom((a) => (st.atomnames[a.index] = a.atomname));

      /* polymer chains */
      const entityDesc = (ei) => {
        const e = s.entityList && s.entityList[ei];
        return e ? e.description || '' : '';
      };
      const chainMap = new Map();
      residues.forEach((r) => {
        if (!r.poly) return;
        let c = chainMap.get(r.chain);
        if (!c) {
          c = { name: r.chain, residues: [], type: r.prot ? 'protein' : 'nucleic', entity: r.entity, desc: entityDesc(r.entity) };
          chainMap.set(r.chain, c);
        }
        c.residues.push(r.i);
      });
      const preset = this.presets[(st.source.id || '').toUpperCase()] || (st.kind === 'alphafold' ? null : null);
      st.preset = preset;
      st.chains = Array.from(chainMap.values());
      st.chains.forEach((c, k) => {
        const atoms = [];
        c.residues.forEach((ri) => {
          const r = residues[ri];
          for (let a = r.a0; a < r.a0 + r.na; a++) atoms.push(a);
        });
        c.atoms = Int32Array.from(atoms);
        c.first = residues[c.residues[0]].resno;
        c.last = residues[c.residues[c.residues.length - 1]].resno;
        c.color = PALETTE[k % PALETTE.length];
        c.nice = (preset && preset.chainNames && preset.chainNames[c.name]) || '';
        if (st.kind === 'alphafold' && st.af) c.nice = st.af.gene || '';
        c.label = c.desc ? MG.niceDesc(c.desc) : c.type === 'nucleic' ? 'Nucleic acid' : 'Protein';
        c.resSet = new Set(c.residues);
      });

      /* non-polymer groups */
      const groups = [];
      const claimed = new Set();
      const addGroup = (g) => {
        const atoms = [];
        g.res.forEach((ri) => {
          const r = residues[ri];
          for (let a = r.a0; a < r.a0 + r.na; a++) atoms.push(a);
        });
        g.atoms = Int32Array.from(atoms);
        g.resSet = new Set(g.res);
        g.id = 'g' + groups.length;
        groups.push(g);
      };
      if (preset && preset.groups) {
        preset.groups.forEach((pg) => {
          const set = s.getAtomSet(new NGL.Selection(pg.sele));
          const res = [];
          residues.forEach((r) => {
            if (!r.poly && !claimed.has(r.i) && set.isSet(r.a0)) {
              res.push(r.i);
              claimed.add(r.i);
            }
          });
          if (res.length) addGroup({ name: pg.name, short: pg.short || pg.name, desc: pg.desc || '', kind: pg.kind || 'ligand', res, preset: true, carbon: pg.carbon ? hex(pg.carbon) : null });
        });
      }
      const buckets = new Map();
      residues.forEach((r) => {
        if (r.poly || claimed.has(r.i)) return;
        let key, name, kind;
        if (r.type === 'water') { key = 'water'; name = 'Water'; kind = 'water'; }
        else if (r.type === 'ion') { key = 'ion:' + r.resname; name = r.resname + ' ion'; kind = 'ion'; }
        else if (r.type === 'sugar') { key = 'sugar'; name = 'Sugars / glycans'; kind = 'sugar'; }
        else { key = 'lig:' + r.resname; name = r.resname; kind = 'ligand'; }
        let b = buckets.get(key);
        if (!b) {
          b = { name, short: name, kind, res: [], resnames: new Set() };
          buckets.set(key, b);
        }
        b.res.push(r.i);
        b.resnames.add(r.resname);
      });
      const order = { ligand: 0, sugar: 1, ion: 2, water: 3 };
      Array.from(buckets.values())
        .sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name))
        .forEach((b) => {
          if (b.kind === 'ligand') {
            const d = entityDesc(residues[b.res[0]].entity);
            b.desc = d ? MG.niceDesc(d) : '';
          } else if (b.kind === 'sugar') {
            b.desc = Array.from(b.resnames).join(', ');
          } else if (b.kind === 'ion') {
            const nm = ELEMENT_NAMES[residues[b.res[0]].resname] || residues[b.res[0]].resname;
            b.name = nm + ' ion' + (b.res.length > 1 ? 's' : '');
            b.short = b.name;
            b.desc = residues[b.res[0]].resname;
          }
          addGroup(b);
        });
      st.groups = groups;
      this._assignOwners(st);
      return st;
    }

    /** N-glycans covalently attached to a chain, and ions it coordinates, are "owned" by that chain:
     *  hiding/showing the chain with the eye icon hides/shows them too. */
    _assignOwners(st) {
      const X = st.s.atomStore.x, Y = st.s.atomStore.y, Z = st.s.atomStore.z;
      const cell = 4, grid = new Map();
      const key = (a, b, c) => a + ',' + b + ',' + c;
      st.chains.forEach((c) => c.atoms.forEach((a) => {
        const k = key(Math.floor(X[a] / cell), Math.floor(Y[a] / cell), Math.floor(Z[a] / cell));
        let b = grid.get(k);
        if (!b) grid.set(k, (b = []));
        b.push(a);
      }));
      const chainOf = (a) => st.residues[st.atomRes[a]].chain;
      const nearestChain = (atomIdx, cutoff) => {
        let best = null, bd = cutoff * cutoff;
        atomIdx.forEach((i) => {
          const gx = Math.floor(X[i] / cell), gy = Math.floor(Y[i] / cell), gz = Math.floor(Z[i] / cell);
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
            const b = grid.get(key(gx + dx, gy + dy, gz + dz));
            if (!b) continue;
            for (const j of b) {
              const d = (X[i] - X[j]) ** 2 + (Y[i] - Y[j]) ** 2 + (Z[i] - Z[j]) ** 2;
              if (d < bd) { bd = d; best = chainOf(j); }
            }
          }
        });
        return best;
      };
      const ownerOfRes = new Map();
      st.residues.forEach((r) => {
        if (r.poly || r.type === 'water') return;
        const idx = [];
        for (let a = r.a0; a < r.a0 + r.na; a++) idx.push(a);
        const cut = r.type === 'ion' ? 3.2 : r.type === 'sugar' ? 2.0 : 0;
        if (!cut) return;
        const o = nearestChain(idx, cut);
        if (o) ownerOfRes.set(r.i, o);
      });
      // sugars in the same branched chain share the owner of the residue attached to protein
      const byChainId = new Map();
      st.residues.forEach((r) => {
        if (r.type !== 'sugar') return;
        if (!byChainId.has(r.chainid)) byChainId.set(r.chainid, []);
        byChainId.get(r.chainid).push(r.i);
      });
      byChainId.forEach((list) => {
        const o = list.map((ri) => ownerOfRes.get(ri)).find(Boolean);
        if (o) list.forEach((ri) => ownerOfRes.set(ri, o));
      });
      st.chains.forEach((c) => {
        const owned = [];
        ownerOfRes.forEach((o, ri) => {
          if (o !== c.name) return;
          // do not let a chain own residues that belong to a named (preset) group such as LPS
          const g = st.groups.find((g) => g.resSet.has(ri));
          if (g && g.preset && g.kind !== 'sugar') return;
          const r = st.residues[ri];
          for (let a = r.a0; a < r.a0 + r.na; a++) owned.push(a);
        });
        c.owned = Int32Array.from(owned);
      });
    }

    /** add het atoms owned by any chain that is completely inside the target */
    _withOwned(st, idx) {
      const set = new Uint8Array(st.n);
      idx.forEach((i) => (set[i] = 1));
      const out = idx.slice();
      st.chains.forEach((c) => {
        if (!c.owned || !c.owned.length) return;
        for (let k = 0; k < c.atoms.length; k++) if (!set[c.atoms[k]]) return;
        c.owned.forEach((a) => !set[a] && out.push(a));
      });
      return out;
    }

    _applyDefaults(st) {
      const { residues, masks, color, tint, hidden } = st;
      const srcChain = this._src({ type: 'scheme', scheme: 'chain' });
      const srcLig = this._src({ type: 'het' });
      st.chains.forEach((c) => {
        c.atoms.forEach((a) => {
          masks.cartoon[a] = 1;
          color[a] = c.color;
          tint[a] = 1;
          st.csrc[a] = srcChain;
        });
      });
      st.groups.forEach((g) => {
        g.carbonColor = g.carbon != null ? g.carbon : g.kind === 'sugar' ? SUGAR_C : LIGAND_C;
        g.atoms.forEach((a) => {
          const el = st.elements[a];
          st.csrc[a] = srcLig;
          if (g.kind === 'ion') {
            masks.spheres[a] = 1;
            color[a] = ELEMENT[el] || 0x9a9a9a;
          } else if (g.kind === 'water') {
            masks.ballstick[a] = 1;
            color[a] = ELEMENT.O;
            hidden[a] = 1;
          } else {
            masks.sticks[a] = 1;
            color[a] = g.carbonColor;
            tint[a] = 1;
          }
        });
        g.hiddenByDefault = g.kind === 'water';
      });
      if (st.kind === 'alphafold') this.colorScheme('plddt', new Map([[st, this._allPolymerAtoms(st)]]), { silent: true });
      this._makeSchemes(st);
    }

    _allPolymerAtoms(st) {
      const out = [];
      st.chains.forEach((c) => c.atoms.forEach((a) => out.push(a)));
      return out;
    }

    _makeSchemes(st) {
      st.schemeAtoms = NGL.ColormakerRegistry.addScheme(function () {
        this.atomColor = function (atom) {
          const i = atom.index;
          if (st.tint[i]) {
            const e = st.elements[i];
            if (e !== 'C' && e !== 'H' && ELEMENT[e] !== undefined) return ELEMENT[e];
          }
          return st.color[i];
        };
      }, 'mg-atoms-' + st.uid);
      st.schemeSurf = NGL.ColormakerRegistry.addScheme(function () {
        this.atomColor = function (atom) {
          return st.color[atom.index];
        };
      }, 'mg-surf-' + st.uid);
    }

    _src(obj) {
      const key = JSON.stringify(obj);
      if (this.csrcIndex.has(key)) return this.csrcIndex.get(key);
      const id = this.csrc.length;
      this.csrc.push(obj);
      this.csrcIndex.set(key, id);
      return id;
    }

    /* ---------------- syncing NGL with state ---------------- */
    _visibleIdx(st, type) {
      const m = st.masks[type], hid = st.hidden, out = [];
      if (type === 'sticks' || type === 'ballstick' || type === 'lines') {
        const cart = st.masks.cartoon, res = st.residues, ar = st.atomRes, an = st.atomnames;
        for (let i = 0; i < st.n; i++) {
          if (!m[i] || hid[i]) continue;
          const r = res[ar[i]];
          if (r.prot && BACKBONE.has(an[i]) && cart[r.ca] && !hid[r.ca]) continue; // side-chain helper
          out.push(i);
        }
      } else {
        for (let i = 0; i < st.n; i++) if (m[i] && !hid[i]) out.push(i);
      }
      return out;
    }

    _syncAll(st) {
      REP_TYPES.forEach((t) => this._syncRep(st, t));
      this._syncContacts(st);
      this._syncSelection(st);
    }

    /** selection is drawn as small green markers (like ICM), so colours stay visible */
    _syncSelection(st) {
      const idx = [];
      if (this.showSelection) for (let i = 0; i < st.n; i++) if (st.sel[i] && !st.hidden[i]) idx.push(i);
      let el = st.reprs._sel;
      if (!idx.length) {
        if (el) el.setVisibility(false);
        return;
      }
      const sele = '@' + idx.join(',');
      if (!el) {
        el = st.reprs._sel = st.comp.addRepresentation('point', {
          sele, color: MG.toHex ? '#39ff14' : '#39ff14', pointSize: 5, sizeAttenuation: false,
          useTexture: true, alphaTest: 0.3, opacity: 1, pickable: false
        });
      } else {
        el.setSelection(sele);
        el.setVisibility(true);
      }
    }
    _syncSelectionAll() {
      this.structures.forEach((st) => this._syncSelection(st));
    }

    _syncReps(st, types) {
      const set = new Set(types);
      if (set.has('cartoon')) ['sticks', 'ballstick', 'lines'].forEach((t) => set.add(t));
      set.forEach((t) => this._syncRep(st, t));
    }

    _syncRep(st, type) {
      const def = REPS[type];
      if (def.surface) return this._syncSurfaces(st, type);
      const idx = this._visibleIdx(st, type);
      let el = st.reprs[type];
      if (!idx.length) {
        if (el) el.setVisibility(false);
      } else {
        const sele = '@' + idx.join(',');
        if (!el) {
          const p = Object.assign({ sele, color: type === 'cartoon' || type === 'tube' ? st.schemeSurf : st.schemeAtoms }, def.params);
          if (type === 'spheres') p.radiusScale = 1.0;
          el = st.reprs[type] = st.comp.addRepresentation(def.ngl, p);
        } else {
          el.setSelection(sele);
          el.setVisibility(true);
        }
      }
      if (type === 'cartoon') this._syncBases(st, idx);
    }

    _syncBases(st, cartoonIdx) {
      const nuc = [];
      const res = st.residues, ar = st.atomRes;
      for (const i of cartoonIdx) if (res[ar[i]].nuc) nuc.push(i);
      let el = st.reprs._base;
      if (!nuc.length) {
        if (el) el.setVisibility(false);
        return;
      }
      const sele = '@' + nuc.join(',');
      if (!el) el = st.reprs._base = st.comp.addRepresentation('base', { sele, color: st.schemeAtoms });
      else {
        el.setSelection(sele);
        el.setVisibility(true);
      }
    }

    _syncSurfaces(st, type) {
      const mask = st.masks[type], hid = st.hidden;
      const opacity = type === 'glass' ? this.glassOpacity : 1;
      const wanted = new Map();
      // polymer chains: surface computed for the whole visible chain, filtered to the masked atoms
      st.chains.forEach((c) => {
        const all = [], on = [];
        c.atoms.forEach((a) => {
          if (hid[a]) return;
          all.push(a);
          if (mask[a]) on.push(a);
        });
        if (on.length) wanted.set(type + '|' + c.name, { sele: '@' + all.join(','), filter: on.length === all.length ? '' : '@' + on.join(',') });
      });
      const het = [];
      st.groups.forEach((g) => g.atoms.forEach((a) => {
        if (mask[a] && !hid[a]) het.push(a);
      }));
      if (het.length) wanted.set(type + '|het', { sele: '@' + het.join(','), filter: '' });
      for (const [key, el] of Array.from(st.surfaces.entries())) {
        if (!key.startsWith(type + '|')) continue;
        const w = wanted.get(key);
        if (!w || el._mgSele !== w.sele || el._mgFilter !== w.filter) {
          st.comp.removeRepresentation(el);
          st.surfaces.delete(key);
        } else {
          wanted.delete(key);
          el.setParameters({ opacity });
        }
      }
      wanted.forEach((w, key) => {
        const el = st.comp.addRepresentation('surface', {
          sele: w.sele,
          filterSele: w.filter,
          color: st.schemeSurf,
          surfaceType: 'ms',
          probeRadius: 1.4,
          smooth: 2,
          opacity,
          depthWrite: opacity >= 1,
          side: 'front',
          useWorker: true
        });
        el._mgSele = w.sele;
        el._mgFilter = w.filter;
        st.surfaces.set(key, el);
      });
    }

    setGlassOpacity(v) {
      this.glassOpacity = MG.clamp(Number(v) || 0.45, 0.05, 1);
      this.structures.forEach((st) => {
        st.surfaces.forEach((el, key) => {
          if (key.startsWith('glass|')) el.setParameters({ opacity: this.glassOpacity, depthWrite: this.glassOpacity >= 1 });
        });
      });
    }

    refreshColors(st) {
      const list = st ? [st] : this.structures;
      list.forEach((s) => {
        Object.values(s.reprs).forEach((el) => el && el.getVisibility() && el.update({ color: true }));
        s.surfaces.forEach((el) => el.update({ color: true }));
      });
    }
    _queueColorRefresh(st) {
      this._pendingColor = this._pendingColor || new Set();
      this._pendingColor.add(st || null);
      if (this._colorTimer) return;
      this._colorTimer = requestAnimationFrame(() => {
        this._colorTimer = null;
        const all = this._pendingColor.has(null);
        const list = all ? null : Array.from(this._pendingColor);
        this._pendingColor = null;
        if (all) this.refreshColors();
        else list.forEach((s) => this.refreshColors(s));
      });
    }

    /* ---------------- targets ---------------- */
    /** Returns Map(st -> array of atom indices). Empty selection => all atoms. */
    target(t) {
      if (t instanceof Map) return t;
      if (t == null || t === '' || t === 'sele' || t === 'selection') {
        if (this.hasSelection()) return this.selectionMap();
        return this.allMap();
      }
      return this.resolve(t);
    }
    allMap() {
      const m = new Map();
      this.structures.forEach((st) => {
        const a = new Array(st.n);
        for (let i = 0; i < st.n; i++) a[i] = i;
        m.set(st, a);
      });
      return m;
    }
    selectionMap() {
      const m = new Map();
      this.structures.forEach((st) => {
        const a = [];
        for (let i = 0; i < st.n; i++) if (st.sel[i]) a.push(i);
        if (a.length) m.set(st, a);
      });
      return m;
    }
    hasSelection() {
      return this.structures.some((st) => st.sel.some((v) => v));
    }
    findStructure(name) {
      if (name == null) return null;
      const k = String(name).toLowerCase();
      return (
        this.structures.find((s) => s.key === k) ||
        this.structures.find((s) => s.key.replace(/^af-/, '') === k || s.key.replace(/-f1$/, '') === k || s.key.replace(/^af-|-f1$/g, '') === k) ||
        (/^#\d+$/.test(k) ? this.structures[parseInt(k.slice(1), 10) - 1] : null)
      );
    }

    /** Parse a user query into Map(st -> atom indices). */
    resolve(query) {
      let q = String(query).trim();
      const out = new Map();
      if (!this.structures.length) return out;
      let targets = this.structures;
      const first = q.split(/\s+/)[0];
      const stHit = this.findStructure(first);
      if (stHit) {
        targets = [stHit];
        q = q.slice(first.length).trim();
      }
      if (!q || q === 'all' || q === '*') {
        targets.forEach((st) => out.set(st, Array.from({ length: st.n }, (_, i) => i)));
        return out;
      }
      if (q === 'sele' || q === 'selection') {
        const sm = this.selectionMap();
        targets.forEach((st) => sm.has(st) && out.set(st, sm.get(st)));
        return out;
      }
      targets.forEach((st) => {
        const idx = this._resolveIn(st, q);
        if (idx && idx.length) out.set(st, idx);
      });
      return out;
    }

    _resolveIn(st, q) {
      // "B or D or LPS*"  /  "A, C" : union of simple parts (NGL handles anything with parentheses)
      if (!/[()]/.test(q) && /\s+or\s+/i.test(q)) {
        const parts = q.split(/\s+or\s+/i).map((x) => x.trim()).filter(Boolean);
        if (parts.length > 1) {
          const set = new Set();
          let ok = true;
          for (const part of parts) {
            try {
              this._resolveIn(st, part).forEach((i) => set.add(i));
            } catch (e) {
              ok = false;
              break;
            }
          }
          if (ok) return Array.from(set).sort((a, b) => a - b);
        }
      }
      const low = q.toLowerCase();
      // named groups (presets / auto groups)
      const g = st.groups.find((g) => g.short.toLowerCase() === low || g.name.toLowerCase() === low);
      if (g) return Array.from(g.atoms);
      if (low === 'ligands' || low === 'ligand') {
        const out = [];
        st.groups.forEach((g) => (g.kind === 'ligand' || g.kind === 'sugar') && g.atoms.forEach((a) => out.push(a)));
        return out;
      }
      if (low === 'waters' || low === 'water') return this._groupKind(st, 'water');
      if (low === 'ions' || low === 'ion') return this._groupKind(st, 'ion');
      if (low === 'sugars' || low === 'glycans') return this._groupKind(st, 'sugar');
      if (low === 'polymer') return this._allPolymerAtoms(st);
      const ch = st.chains.find((c) => c.name.toLowerCase() === low || ('chain ' + c.name).toLowerCase() === low);
      if (ch && (q.length <= 4 || low.startsWith('chain '))) return Array.from(ch.atoms);
      // shorthand: A:100-120, A:126, A:Phe126, 126 (all chains), A:100-120,C:90
      if (/^[a-z0-9]{1,4}:[a-z]{0,3}-?\d+(-\d+)?(,\s*[a-z0-9]{1,4}:[a-z]{0,3}-?\d+(-\d+)?)*$/i.test(q)) {
        const out = [];
        q.split(/,\s*/).forEach((part) => {
          const m = /^([a-z0-9]{1,4}):([a-z]{0,3})(-?\d+)(?:-(\d+))?$/i.exec(part);
          if (!m) return;
          const chain = m[1], rn = m[2].toUpperCase(), a = +m[3], b = m[4] ? +m[4] : +m[3];
          st.residues.forEach((r) => {
            if (r.chain === chain && r.resno >= a && r.resno <= b && (!rn || r.resname.startsWith(rn) || (MG.AA3_NICE[r.resname] || '').toUpperCase() === rn)) {
              for (let x = r.a0; x < r.a0 + r.na; x++) out.push(x);
            }
          });
        });
        return out;
      }
      // NGL selection language
      try {
        const sel = new NGL.Selection(q);
        if (sel.selection && sel.selection.error) throw new Error(sel.selection.error);
        const set = st.s.getAtomSet(sel);
        const out = [];
        set.forEach((i) => out.push(i));
        return out;
      } catch (e) {
        throw new Error('Could not understand “' + q + '”');
      }
    }
    _groupKind(st, kind) {
      const out = [];
      st.groups.forEach((g) => g.kind === kind && g.atoms.forEach((a) => out.push(a)));
      return out;
    }

    /** atoms within `dist` Å of target (whole residues), excluding the target itself */
    near(targetMap, dist = 4.5, opts = {}) {
      const out = new Map();
      out.lists = new Map();
      targetMap.forEach((idx, st) => {
        const tset = new Uint8Array(st.n);
        idx.forEach((i) => (tset[i] = 1));
        const s = st.s;
        const ax = s.atomStore.x, ay = s.atomStore.y, az = s.atomStore.z;
        const cell = Math.max(dist, 3);
        const grid = new Map();
        const key = (x, y, z) => x + ',' + y + ',' + z;
        for (let i = 0; i < st.n; i++) {
          if (tset[i] || st.hidden[i] && opts.visibleOnly) continue;
          const r = st.residues[st.atomRes[i]];
          if (opts.polymerOnly && !r.poly) continue;
          if (r.type === 'water' && !opts.water) continue;
          const k = key(Math.floor(ax[i] / cell), Math.floor(ay[i] / cell), Math.floor(az[i] / cell));
          let b = grid.get(k);
          if (!b) grid.set(k, (b = []));
          b.push(i);
        }
        const d2 = dist * dist;
        const resMin = new Map();
        idx.forEach((i) => {
          if (opts.visibleOnly && st.hidden[i]) return;
          const gx = Math.floor(ax[i] / cell), gy = Math.floor(ay[i] / cell), gz = Math.floor(az[i] / cell);
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
            const b = grid.get(key(gx + dx, gy + dy, gz + dz));
            if (!b) continue;
            for (const j of b) {
              const ddx = ax[i] - ax[j], ddy = ay[i] - ay[j], ddz = az[i] - az[j];
              const dd = ddx * ddx + ddy * ddy + ddz * ddz;
              if (dd <= d2) {
                const ri = st.atomRes[j];
                const prev = resMin.get(ri);
                if (prev === undefined || dd < prev.d) resMin.set(ri, { d: dd, a: j, t: i });
              }
            }
          }
        });
        const atoms = [];
        const list = [];
        resMin.forEach((v, ri) => {
          const r = st.residues[ri];
          for (let a = r.a0; a < r.a0 + r.na; a++) atoms.push(a);
          list.push({ r, d: Math.sqrt(v.d), atom: v.a, targetAtom: v.t });
        });
        if (atoms.length) {
          out.set(st, atoms);
          out.lists.set(st, list);
        }
      });
      return out;
    }

    /* ---------------- selection ---------------- */
    select(target, mode = 'set') {
      const m = this.target(target);
      if (mode === 'set') this.structures.forEach((st) => st.sel.fill(0));
      m.forEach((idx, st) => {
        if (typeof st === 'string') return;
        const sel = st.sel;
        if (mode === 'toggle') {
          const allOn = idx.every((i) => sel[i]);
          idx.forEach((i) => (sel[i] = allOn ? 0 : 1));
        } else if (mode === 'remove') idx.forEach((i) => (sel[i] = 0));
        else idx.forEach((i) => (sel[i] = 1));
      });
      this._syncSelectionAll();
      bus.emit('viewer:selection', { info: this.selectionInfo() });
    }
    clearSelection() {
      this.structures.forEach((st) => st.sel.fill(0));
      this._syncSelectionAll();
      bus.emit('viewer:selection', { info: this.selectionInfo() });
    }
    invertSelection() {
      this.structures.forEach((st) => {
        for (let i = 0; i < st.n; i++) st.sel[i] = st.sel[i] ? 0 : st.hidden[i] ? 0 : 1;
      });
      this._syncSelectionAll();
      bus.emit('viewer:selection', { info: this.selectionInfo() });
    }

    /** Human-readable description of a set of atoms */
    describeTarget(m) {
      const parts = [];
      let totalRes = 0;
      m.forEach((idx, st) => {
        if (typeof st === 'string') return;
        const resSet = new Set();
        idx.forEach((i) => resSet.add(st.atomRes[i]));
        totalRes += resSet.size;
        // whole chain?
        const chainsFull = st.chains.filter((c) => c.residues.every((ri) => resSet.has(ri)));
        const groupsFull = st.groups.filter((g) => g.res.every((ri) => resSet.has(ri)));
        let covered = new Set();
        chainsFull.forEach((c) => c.residues.forEach((ri) => covered.add(ri)));
        groupsFull.forEach((g) => g.res.forEach((ri) => covered.add(ri)));
        const rest = Array.from(resSet).filter((ri) => !covered.has(ri));
        const bits = [];
        if (chainsFull.length === st.chains.length && st.chains.length > 1 && groupsFull.length === st.groups.length && !rest.length) {
          bits.push('everything');
        } else {
          chainsFull.forEach((c) => bits.push(`chain ${c.name}${c.nice ? ' (' + c.nice + ')' : c.label ? ' (' + c.label + ')' : ''}`));
          groupsFull.forEach((g) => bits.push(g.short));
          if (rest.length) {
            if (rest.length <= 4) bits.push(rest.map((ri) => this.residueName(st, ri, true)).join(', '));
            else bits.push(rest.length + ' residues');
          }
        }
        if (this.structures.length > 1) parts.push(st.name + ': ' + bits.join(' + '));
        else parts.push(bits.join(' + '));
      });
      return { text: parts.join('; '), residues: totalRes };
    }

    selectionInfo() {
      const m = this.selectionMap();
      if (!m.size) return { count: 0, text: '' };
      let atoms = 0;
      m.forEach((idx) => (atoms += idx.length));
      const d = this.describeTarget(m);
      return { count: atoms, residues: d.residues, text: d.text };
    }

    residueName(st, ri, withChain) {
      const r = st.residues[ri];
      const base = r.poly && r.prot ? niceRes(r.resname) + r.resno + (r.ins || '') : r.resname + ' ' + r.resno + (r.ins || '');
      return withChain ? base + ' (' + r.chain + ')' : base;
    }
    _atomLabel(st, i) {
      const r = st.residues[st.atomRes[i]];
      return this.residueName(st, r.i, true) + ' ' + st.atomnames[i];
    }
    describeAtom(st, i) {
      const r = st.residues[st.atomRes[i]];
      const ch = st.chains.find((c) => c.name === r.chain && r.poly);
      const g = !r.poly ? st.groups.find((g) => g.resSet.has(r.i)) : null;
      let what;
      if (ch) what = `Chain ${r.chain}${ch.nice ? ' · ' + ch.nice : ch.label ? ' · ' + ch.label : ''}`;
      else if (g) what = g.name + (g.desc && g.kind === 'ligand' && g.desc !== g.name ? ' · ' + g.desc : '');
      else what = 'Chain ' + r.chain;
      const resTxt = r.prot ? `${niceRes(r.resname)} ${r.resno}${r.ins}` : `${r.resname} ${r.resno}${r.ins}`;
      let extra = '';
      if (st.kind === 'alphafold') extra = 'pLDDT ' + r.bf.toFixed(1);
      return {
        st, atom: i, residue: r,
        text: `${resTxt} · ${st.atomnames[i]}`,
        sub: `${st.name} · ${what}`,
        extra
      };
    }

    /* ---------------- display ---------------- */
    _mask(m, fn, types) {
      const touched = new Set();
      m.forEach((idx, st) => {
        if (typeof st === 'string') return;
        fn(st, idx);
        touched.add(st);
      });
      touched.forEach((st) => this._syncReps(st, types));
      bus.emit('viewer:changed', { what: 'display' });
      return touched.size;
    }

    show(type, target) {
      if (!REPS[type]) throw new Error('Unknown style “' + type + '”');
      const m = this.target(target);
      this._mask(m, (st, idx) => {
        const mask = st.masks[type];
        idx.forEach((i) => {
          if (REPS[type].polymer && !st.residues[st.atomRes[i]].poly) return;
          mask[i] = 1;
        });
        if (type === 'glass') idx.forEach((i) => (st.masks.surface[i] = 0));
        if (type === 'surface') idx.forEach((i) => (st.masks.glass[i] = 0));
      }, type === 'glass' || type === 'surface' ? ['surface', 'glass'] : [type]);
      bus.emit('viewer:style', { type, target: this.describeTarget(m).text });
    }

    hide(type, target) {
      const m = this.target(target);
      const types = type === 'all' || !type ? REP_TYPES : [type];
      this._mask(m, (st, idx) => {
        types.forEach((t) => {
          const mask = st.masks[t];
          idx.forEach((i) => (mask[i] = 0));
        });
      }, types);
      bus.emit('viewer:style', { type: 'hide-' + (type || 'all'), target: this.describeTarget(m).text });
    }

    /** exclusive style: remove other styles from target, then show */
    only(type, target) {
      const m = this.target(target);
      this._mask(m, (st, idx) => {
        REP_TYPES.forEach((t) => {
          const mask = st.masks[t];
          idx.forEach((i) => (mask[i] = 0));
        });
      }, REP_TYPES);
      this.show(type, m);
    }

    /** fraction of target atoms (eligible) that show `type` */
    styleCoverage(type, target) {
      const m = this.target(target);
      let on = 0, tot = 0;
      m.forEach((idx, st) => {
        if (typeof st === 'string') return;
        const mask = st.masks[type];
        idx.forEach((i) => {
          if (REPS[type].polymer && !st.residues[st.atomRes[i]].poly) return;
          if (st.hidden[i]) return;
          tot++;
          if (mask[i]) on++;
        });
      });
      return tot ? on / tot : 0;
    }

    toggleStyle(type, target) {
      const m = this.target(target);
      if (this.styleCoverage(type, m) > 0.999) this.hide(type, m);
      else this.show(type, m);
    }

    /** eye toggles: hidden atoms are excluded from every style */
    setVisible(target, visible) {
      const m0 = this.target(target);
      const m = new Map();
      m0.forEach((idx, st) => m.set(st, this._withOwned(st, idx)));
      this._mask(m, (st, idx) => idx.forEach((i) => (st.hidden[i] = visible ? 0 : 1)), REP_TYPES);
      m.forEach((idx, st) => {
        this._syncContacts(st);
        this._syncSelection(st);
      });
      bus.emit('viewer:visibility', { visible, target: this.describeTarget(m).text });
    }
    isolate(target) {
      const m0 = this.target(target);
      const m = new Map();
      m0.forEach((idx, st) => m.set(st, this._withOwned(st, idx)));
      this.structures.forEach((st) => {
        st.hidden.fill(1);
        const idx = m.get(st);
        if (idx) idx.forEach((i) => (st.hidden[i] = 0));
        this._syncReps(st, REP_TYPES);
        this._syncContacts(st);
        this._syncSelection(st);
      });
      bus.emit('viewer:changed', { what: 'display' });
      bus.emit('viewer:visibility', { visible: true, isolate: true, target: this.describeTarget(m).text });
    }
    showEverything(st) {
      (st ? [st] : this.structures).forEach((s) => {
        s.groups.forEach((g) => {
          if (g.kind === 'water') return;
          g.atoms.forEach((a) => (s.hidden[a] = 0));
        });
        s.chains.forEach((c) => c.atoms.forEach((a) => (s.hidden[a] = 0)));
        this._syncReps(s, REP_TYPES);
        this._syncContacts(s);
      });
      bus.emit('viewer:changed', { what: 'display' });
      bus.emit('viewer:visibility', { visible: true });
    }
    visibleFraction(st, atoms) {
      let v = 0;
      atoms.forEach((a) => (v += st.hidden[a] ? 0 : 1));
      return atoms.length ? v / atoms.length : 0;
    }
    setStructureVisible(st, visible) {
      st.visible = visible;
      st.comp.setVisibility(visible);
      bus.emit('viewer:changed', { what: 'structures' });
      bus.emit('viewer:visibility', { visible, structure: st.name });
    }

    /* ---------------- colours ---------------- */
    colorUniform(color, target, label) {
      const c = typeof color === 'number' ? color : hex(MG.colorToHex(color));
      const m = this.target(target);
      const desc = label || this.describeTarget(m).text;
      const src = this._src({ type: 'uniform', color: c, label: desc });
      m.forEach((idx, st) => {
        if (typeof st === 'string') return;
        idx.forEach((i) => {
          st.color[i] = c;
          st.tint[i] = 0;
          st.csrc[i] = src;
        });
        this._queueColorRefresh(st);
      });
      bus.emit('viewer:color', { scheme: 'uniform', color: toHex(c), target: desc });
      bus.emit('viewer:changed', { what: 'color' });
    }

    colorScheme(scheme, target, opts = {}) {
      const m = this.target(target);
      const src = this._src({ type: 'scheme', scheme });
      let warned = false;
      m.forEach((idx, st) => {
        if (typeof st === 'string') return;
        const R = st.residues, AR = st.atomRes, E = st.elements;
        const setC = (i, c) => {
          st.color[i] = c;
          st.csrc[i] = src;
        };
        if (scheme === 'element') {
          idx.forEach((i) => {
            st.tint[i] = 1;
          });
        } else if (scheme === 'cpk') {
          idx.forEach((i) => {
            st.tint[i] = 1;
            setC(i, ELEMENT[E[i]] !== undefined ? ELEMENT[E[i]] : 0xff69b4);
          });
        } else if (scheme === 'chain') {
          idx.forEach((i) => {
            const r = R[AR[i]];
            if (!r.poly) return;
            const c = st.chains.find((c) => c.name === r.chain);
            if (c) setC(i, c.color);
          });
        } else if (scheme === 'molecule') {
          const ents = [];
          st.chains.forEach((c) => !ents.includes(c.entity) && ents.push(c.entity));
          idx.forEach((i) => {
            const r = R[AR[i]];
            if (!r.poly) return;
            setC(i, PALETTE[ents.indexOf(r.entity) % PALETTE.length]);
          });
        } else if (scheme === 'rainbow') {
          const pos = new Map();
          st.chains.forEach((c) => c.residues.forEach((ri, k) => pos.set(ri, c.residues.length > 1 ? k / (c.residues.length - 1) : 0)));
          idx.forEach((i) => {
            const t = pos.get(AR[i]);
            if (t !== undefined) setC(i, rainbow(t));
          });
        } else if (scheme === 'ss') {
          idx.forEach((i) => {
            const r = R[AR[i]];
            if (!r.poly) return;
            setC(i, r.nuc ? 0x9aa3ad : SS[r.ss].color);
          });
        } else if (scheme === 'hydrophobicity') {
          idx.forEach((i) => {
            const r = R[AR[i]];
            if (!r.prot) return;
            const v = KD[r.one];
            if (v !== undefined) setC(i, hydColor(v));
          });
        } else if (scheme === 'restype') {
          idx.forEach((i) => {
            const r = R[AR[i]];
            if (!r.prot) return;
            const cls = RESTYPE.find((c) => c.res.includes(r.one));
            if (cls) setC(i, cls.color);
          });
        } else if (scheme === 'plddt') {
          if (st.kind !== 'alphafold' && !warned && !opts.silent) {
            warned = true;
            toast(`${st.name} is an experimental structure: its B-factor column is <b>not</b> pLDDT. Use “B-factor” instead.`, 'warn', 6000);
          }
          idx.forEach((i) => {
            const r = R[AR[i]];
            if (!r.poly) return;
            setC(i, plddtColor(r.bf));
          });
        } else if (scheme === 'bfactor') {
          let lo = Infinity, hi = -Infinity;
          const ap = st.s.getAtomProxy();
          const bf = new Float32Array(st.n);
          idx.forEach((i) => {
            ap.index = i;
            bf[i] = ap.bfactor;
            if (bf[i] < lo) lo = bf[i];
            if (bf[i] > hi) hi = bf[i];
          });
          const span = hi - lo || 1;
          idx.forEach((i) => setC(i, (bf[i] - lo) / span < 0.5 ? lerp(0x2c7bb6, 0xf7f7f7, ((bf[i] - lo) / span) * 2) : lerp(0xf7f7f7, 0xd7191c, ((bf[i] - lo) / span - 0.5) * 2)));
          st.bfRange = [lo, hi];
        } else if (scheme === 'default') {
          idx.forEach((i) => {
            const r = R[AR[i]];
            if (r.poly) {
              const c = st.chains.find((c) => c.name === r.chain);
              if (c) setC(i, c.color);
              st.tint[i] = 1;
            } else {
              const g = st.groups.find((g) => g.resSet.has(r.i));
              st.csrc[i] = this._src({ type: 'het' });
              if (g && g.kind === 'ion') st.color[i] = ELEMENT[E[i]] || 0x9a9a9a;
              else if (g && g.kind === 'water') st.color[i] = ELEMENT.O;
              else {
                st.color[i] = g ? g.carbonColor : LIGAND_C;
                st.tint[i] = 1;
              }
            }
          });
        } else {
          throw new Error('Unknown colour scheme “' + scheme + '”');
        }
        this._queueColorRefresh(st);
      });
      if (!opts.silent) {
        bus.emit('viewer:color', { scheme, target: this.describeTarget(m).text });
        bus.emit('viewer:changed', { what: 'color' });
      }
    }

    /* ---------------- camera ---------------- */
    centerOn(targetOrIdx, stHint) {
      let m;
      if (Array.isArray(targetOrIdx) && stHint) m = new Map([[stHint, targetOrIdx]]);
      else m = this.target(targetOrIdx);
      const entries = Array.from(m.entries()).filter(([st]) => typeof st !== 'string');
      if (!entries.length) return;
      if (entries.length === 1) {
        const [st, idx] = entries[0];
        st.comp.autoView('@' + idx.join(','), 600);
      } else this.stage.autoView(600);
    }
    resetView() {
      this.stage.autoView(500);
    }

    /** Point the camera so that xAxis is screen-right and yAxis is screen-up (model coordinates). */
    orientTo(xAxis, yAxis, center, size) {
      const norm = (v) => {
        const L = Math.hypot(v[0], v[1], v[2]) || 1;
        return [v[0] / L, v[1] / L, v[2] / L];
      };
      const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      const x = norm(xAxis);
      let y = norm(yAxis);
      const z = norm(cross(x, y));
      y = norm(cross(z, x));
      const vc = this.stage.viewerControls;
      const cur = vc.getOrientation();
      const e = cur.elements;
      let d = Math.hypot(e[0], e[1], e[2]);
      if (size) {
        const v = this.stage.viewer;
        const fov = ((this.stage.parameters.cameraFov || 30) * Math.PI) / 180;
        const aspect = v.width / Math.max(1, v.height);
        const need = Math.max(size, size / aspect);
        d = (need / (2 * Math.tan(fov / 2))) * 1.08;
      }
      const m = cur.clone();
      // NGL's camera looks along +z, so screen-right is -x and "towards the viewer" is -z in view space
      const X = [-x[0], -x[1], -x[2]], Z = [-z[0], -z[1], -z[2]];
      m.fromArray([X[0] * d, y[0] * d, Z[0] * d, 0, X[1] * d, y[1] * d, Z[1] * d, 0, X[2] * d, y[2] * d, Z[2] * d, 0, -center[0], -center[1], -center[2], 1]);
      vc.orient(m);
    }

    /** named camera views stored in config presets, e.g. “orient dimer” for 3FXI */
    presetView(name) {
      for (const st of this.structures) {
        const p = this.presets[(st.source.id || '').toUpperCase()];
        const v = p && p.views && p.views[name];
        if (v) {
          this.orientTo(v.x, v.y, v.center, v.size);
          return v;
        }
      }
      return null;
    }
    setSpin(on) {
      this.stage.setSpin(!!on);
      this.spinning = !!on;
    }
    setBackground(c) {
      const map = { white: '#ffffff', black: '#000000', grey: '#2b2f36', gray: '#2b2f36', dark: '#1d2026' };
      this.bg = map[c] ? c : c;
      this.stage.setParameters({ backgroundColor: map[c] || c });
      bus.emit('viewer:changed', { what: 'background' });
    }

    /* ---------------- structures ---------------- */
    remove(st) {
      if (!st) return;
      this.stage.removeComponent(st.comp);
      this.structures = this.structures.filter((s) => s !== st);
      NGL.ColormakerRegistry.removeScheme(st.schemeAtoms);
      NGL.ColormakerRegistry.removeScheme(st.schemeSurf);
      bus.emit('viewer:removed', { st });
      bus.emit('viewer:changed', { what: 'structures' });
      bus.emit('viewer:selection', { info: this.selectionInfo() });
    }
    clear() {
      this.structures.slice().forEach((st) => this.remove(st));
    }

    /* ---------------- interactions & binding sites ---------------- */
    showInteractions(target, opts = {}) {
      const m = this.target(target);
      let any = false;
      m.forEach((idx, st) => {
        if (typeof st === 'string') return;
        const near = this.near(new Map([[st, idx]]), opts.dist || 5, { water: false, visibleOnly: true });
        const nb = near.get(st) || [];
        if (!nb.length) return;
        any = true;
        st.contacts = { target: idx.slice(), nbr: nb.slice(), hydrophobic: !!opts.hydrophobic };
        this._syncContacts(st);
      });
      if (!any) toast('No neighbouring residues found for this selection.', 'warn');
      bus.emit('viewer:contacts', { on: any, target: this.describeTarget(m).text });
      bus.emit('viewer:changed', { what: 'contacts' });
      return any;
    }
    hideInteractions() {
      this.structures.forEach((st) => {
        st.contacts = null;
        this._syncContacts(st);
      });
      bus.emit('viewer:contacts', { on: false });
      bus.emit('viewer:changed', { what: 'contacts' });
    }
    _syncContacts(st) {
      const c = st.contacts;
      if (st.reprs._contacts) {
        st.comp.removeRepresentation(st.reprs._contacts);
        st.reprs._contacts = null;
      }
      if (!c) return;
      const vis = (a) => !st.hidden[a];
      const t = c.target.filter(vis), nb = c.nbr.filter(vis);
      if (!t.length || !nb.length) return;
      const tS = '@' + t.join(','), nS = '@' + nb.join(',');
      st.reprs._contacts = st.comp.addRepresentation('contact', {
        sele: '@' + t.concat(nb).sort((a, b) => a - b).join(','),
        filterSele: [tS, nS],
        hydrogenBond: true,
        backboneHydrogenBond: true,
        waterHydrogenBond: false,
        weakHydrogenBond: false,
        ionicInteraction: true,
        hydrophobic: !!c.hydrophobic,
        halogenBond: true,
        metalCoordination: true,
        cationPi: true,
        piStacking: true,
        radiusSize: 0.07,
        maxHbondDist: 3.5
      });
    }

    /** select residues near a target, show them as sticks, show interactions and zoom in */
    bindingSite(target, dist = 4.5, opts = {}) {
      const m = this.target(target);
      const visTarget = new Map();
      m.forEach((idx, st) => {
        const v = idx.filter((i) => !st.hidden[i]);
        if (v.length) visTarget.set(st, v);
      });
      if (!visTarget.size) {
        toast('The selection is hidden – show it first.', 'warn');
        return [];
      }
      const near = this.near(visTarget, dist, { water: false, visibleOnly: true });
      const result = [];
      const site = new Map();
      m.forEach((idx, st) => {
        if (typeof st === 'string') return;
        const nb = near.get(st);
        const list = near.lists.get(st) || [];
        list.sort((a, b) => (a.r.chain + a.r.resno).localeCompare(b.r.chain + b.r.resno, undefined, { numeric: true }));
        list.forEach((x) => result.push({ st, residue: x.r, dist: x.d, name: this.residueName(st, x.r.i, true), atom: x.atom, targetAtom: x.targetAtom }));
        if (nb) site.set(st, nb);
      });
      if (!site.size) {
        toast('Nothing found within ' + dist + ' Å.', 'warn');
        return [];
      }
      this.show('sticks', site);
      this.colorScheme('element', site, { silent: true });
      this.showInteractions(visTarget, { hydrophobic: !!opts.hydrophobic });
      this.select(site, 'set');
      this.centerOn(visTarget);
      bus.emit('viewer:site', { count: result.length, dist });
      return result;
    }

    /* ---------------- distances ---------------- */
    _measureClick(hit) {
      if (!this._measurePending) {
        this._measurePending = hit;
        bus.emit('viewer:measure-pending', { atom: this._atomLabel(hit.st, hit.atom) });
        return;
      }
      const a = this._measurePending;
      this._measurePending = null;
      if (a.st !== hit.st) {
        toast('Pick two atoms in the same structure.', 'warn');
        bus.emit('viewer:measure-pending', { atom: null });
        return;
      }
      if (a.atom === hit.atom) {
        bus.emit('viewer:measure-pending', { atom: null });
        return;
      }
      this.addDistance(a.st, a.atom, hit.atom);
    }
    addDistance(st, i, j) {
      const d = this.atomDistance(st, i, j);
      st.distances.push({ a: i, b: j, d });
      this._syncDistances(st);
      const text = `${this._atomLabel(st, i)} ↔ ${this._atomLabel(st, j)}: ${d.toFixed(2)} Å`;
      bus.emit('viewer:measure', { text, d, st: st.name });
      bus.emit('viewer:changed', { what: 'distances' });
      return d;
    }
    atomDistance(st, i, j) {
      const x = st.s.atomStore.x, y = st.s.atomStore.y, z = st.s.atomStore.z;
      return Math.hypot(x[i] - x[j], y[i] - y[j], z[i] - z[j]);
    }
    clearDistances() {
      this.structures.forEach((st) => {
        st.distances = [];
        this._syncDistances(st);
      });
      this._measurePending = null;
      bus.emit('viewer:changed', { what: 'distances' });
    }
    removeDistance(st, k) {
      st.distances.splice(k, 1);
      this._syncDistances(st);
      bus.emit('viewer:changed', { what: 'distances' });
    }
    _syncDistances(st) {
      if (st.reprs._dist) {
        st.comp.removeRepresentation(st.reprs._dist);
        st.reprs._dist = null;
      }
      if (!st.distances.length) return;
      const dark = this.bg === 'black' || this.bg === 'grey' || this.bg === 'dark';
      st.reprs._dist = st.comp.addRepresentation('distance', {
        atomPair: st.distances.map((d) => [d.a, d.b]),
        color: dark ? '#ffd23f' : '#222222',
        labelColor: dark ? '#ffffff' : '#111111',
        labelSize: 1.6,
        labelUnit: 'angstrom',
        labelBackground: true,
        labelBackgroundColor: dark ? '#000000' : '#ffffff',
        labelBackgroundOpacity: 0.7,
        linewidth: 3,
        useCylinder: true,
        radiusSize: 0.06
      });
    }

    /* ---------------- geometry helpers for overlays ---------------- */
    atomPosition(st, i) {
      const x = st.s.atomStore.x[i], y = st.s.atomStore.y[i], z = st.s.atomStore.z[i];
      return [x, y, z];
    }
    project(xyz) {
      if (!this._v3) {
        const st = this.structures[0];
        if (!st) return null;
        this._v3 = st.s.getAtomProxy(0).positionToVector3();
      }
      this._v3.set(xyz[0], xyz[1], xyz[2]);
      const p = this.stage.viewerControls.getPositionOnCanvas(this._v3);
      const h = this.stage.viewer.height;
      return { x: p.x, y: h - p.y };
    }
    residueAnchor(st, ri) {
      const r = st.residues[ri];
      if (r.prot) {
        // prefer a side-chain tip for residues, fall back to CA
        return r.ca;
      }
      // ligand: atom closest to the residue centroid
      let cx = 0, cy = 0, cz = 0;
      const X = st.s.atomStore.x, Y = st.s.atomStore.y, Z = st.s.atomStore.z;
      for (let a = r.a0; a < r.a0 + r.na; a++) { cx += X[a]; cy += Y[a]; cz += Z[a]; }
      cx /= r.na; cy /= r.na; cz /= r.na;
      let best = r.a0, bd = Infinity;
      for (let a = r.a0; a < r.a0 + r.na; a++) {
        const d = (X[a] - cx) ** 2 + (Y[a] - cy) ** 2 + (Z[a] - cz) ** 2;
        if (d < bd) { bd = d; best = a; }
      }
      return best;
    }
    centroid(m) {
      let cx = 0, cy = 0, cz = 0, k = 0;
      m.forEach((idx, st) => {
        if (typeof st === 'string') return;
        const X = st.s.atomStore.x, Y = st.s.atomStore.y, Z = st.s.atomStore.z;
        idx.forEach((i) => { cx += X[i]; cy += Y[i]; cz += Z[i]; k++; });
      });
      return k ? [cx / k, cy / k, cz / k] : null;
    }

    /* ---------------- image ---------------- */
    async renderImage(opts = {}) {
      const factor = opts.factor || 2;
      const hidden = [];
      this.structures.forEach((st) => {
        const el = st.reprs._sel;
        if (el && el.getVisibility()) {
          el.setVisibility(false);
          hidden.push(el);
        }
      });
      try {
        const blob = await this.stage.makeImage({ factor, antialias: true, trim: false, transparent: !!opts.transparent });
        return blob;
      } finally {
        hidden.forEach((el) => el.setVisibility(true));
      }
    }

    /* ---------------- state (views & sessions) ---------------- */
    getState(opts = {}) {
      const rle = (arr) => {
        const out = [];
        let prev = arr[0], run = 0;
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] === prev) run++;
          else { out.push(prev, run); prev = arr[i]; run = 1; }
        }
        if (arr.length) out.push(prev, run);
        return out;
      };
      return {
        v: 1,
        bg: this.bg,
        glassOpacity: this.glassOpacity,
        camera: this.stage.viewerControls.getOrientation().toArray(),
        csrc: this.csrc.slice(),
        structures: this.structures.map((st) => ({
          uid: st.uid,
          name: st.name,
          source: st.source,
          visible: st.visible,
          masks: Object.fromEntries(REP_TYPES.map((t) => [t, rle(st.masks[t])])),
          hidden: rle(st.hidden),
          color: rle(st.color),
          tint: rle(st.tint),
          csrc: rle(st.csrc),
          sel: opts.noSelection ? null : rle(st.sel),
          distances: st.distances.map((d) => [d.a, d.b]),
          contacts: st.contacts ? { target: st.contacts.target, nbr: st.contacts.nbr, hydrophobic: st.contacts.hydrophobic } : null,
          coords: st.transformed ? Array.from(st.s.atomStore.x.subarray(0, st.n)).concat(Array.from(st.s.atomStore.y.subarray(0, st.n)), Array.from(st.s.atomStore.z.subarray(0, st.n))) : null
        }))
      };
    }

    setState(state, opts = {}) {
      const unrle = (arr, target) => {
        let k = 0;
        for (let i = 0; i < arr.length; i += 2) {
          const v = arr[i], n = arr[i + 1];
          target.fill(v, k, Math.min(k + n, target.length));
          k += n;
        }
      };
      if (state.csrc) {
        this.csrc = state.csrc.slice();
        this.csrcIndex = new Map(this.csrc.map((o, i) => [JSON.stringify(o), i]).filter((x) => x[1] > 0));
      }
      if (state.bg) this.setBackground(state.bg);
      if (state.glassOpacity) this.glassOpacity = state.glassOpacity;
      (state.structures || []).forEach((ss, k) => {
        const st = opts.map ? opts.map(ss, k) : this.structures.find((s) => s.uid === ss.uid) || this.structures.find((s) => s.name === ss.name);
        if (!st) return;
        REP_TYPES.forEach((t) => ss.masks[t] && unrle(ss.masks[t], st.masks[t]));
        unrle(ss.hidden, st.hidden);
        unrle(ss.color, st.color);
        unrle(ss.tint, st.tint);
        unrle(ss.csrc, st.csrc);
        if (ss.sel) unrle(ss.sel, st.sel);
        else st.sel.fill(0);
        if (ss.coords && ss.coords.length === st.n * 3) {
          st.s.atomStore.x.set(ss.coords.slice(0, st.n));
          st.s.atomStore.y.set(ss.coords.slice(st.n, 2 * st.n));
          st.s.atomStore.z.set(ss.coords.slice(2 * st.n));
          st.s.refreshPosition();
          st.transformed = true;
          this._rebuild(st);
        }
        st.distances = (ss.distances || []).map(([a, b]) => ({ a, b, d: this.atomDistance(st, a, b) }));
        st.contacts = ss.contacts ? Object.assign({}, ss.contacts) : null;
        this.setStructureVisible(st, ss.visible !== false);
        this._syncAll(st);
        this._syncDistances(st);
      });
      this.refreshColors();
      if (state.camera && !opts.keepCamera) {
        const mat = this.stage.viewerControls.getOrientation();
        mat.fromArray(state.camera);
        this.stage.viewerControls.orient(mat);
      }
      bus.emit('viewer:changed', { what: 'state' });
      bus.emit('viewer:selection', { info: this.selectionInfo() });
    }

    _rebuild(st) {
      Object.keys(st.reprs).forEach((k) => {
        if (st.reprs[k]) st.comp.removeRepresentation(st.reprs[k]);
        st.reprs[k] = null;
      });
      st.reprs = {};
      st.surfaces.forEach((el) => st.comp.removeRepresentation(el));
      st.surfaces.clear();
      this._syncAll(st);
      this._syncDistances(st);
    }

    /* ---------------- superposition ---------------- */
    superpose(mobile, mobileChain, target, targetChain, opts = {}) {
      const pick = (st, chainName) => {
        const ch = chainName ? st.chains.find((c) => c.name === chainName) : st.chains.find((c) => c.type === 'protein');
        if (!ch) throw new Error(`${st.name} has no protein chain ${chainName || ''}`);
        const res = ch.residues.map((ri) => st.residues[ri]).filter((r) => r.prot && st.atomnames[r.ca] === 'CA');
        return { ch, res, seq: res.map((r) => r.one).join('') };
      };
      const A = pick(mobile, mobileChain), B = pick(target, targetChain);
      const ali = MG.align(A.seq, B.seq);
      let pairs = ali.pairs.map(([i, j]) => [A.res[i].ca, B.res[j].ca]);
      if (pairs.length < 3) throw new Error('Too few matching residues to superpose');
      const XA = mobile.s.atomStore, XB = target.s.atomStore;
      const P = (list) => list.map(([a]) => [XA.x[a], XA.y[a], XA.z[a]]);
      const Q = (list) => list.map(([, b]) => [XB.x[b], XB.y[b], XB.z[b]]);
      let used = pairs, T = null, rmsd = 0;
      const cutoff = opts.cutoff || 2.0;
      for (let cycle = 0; cycle < 6; cycle++) {
        T = MG.kabsch(P(used), Q(used));
        const devs = pairs.map(([a, b]) => {
          const p = MG.applyT(T, [XA.x[a], XA.y[a], XA.z[a]]);
          return Math.hypot(p[0] - XB.x[b], p[1] - XB.y[b], p[2] - XB.z[b]);
        });
        const keep = pairs.filter((_, k) => devs[k] <= cutoff);
        if (keep.length === used.length || keep.length < Math.max(3, pairs.length * 0.3)) break;
        used = keep;
      }
      T = MG.kabsch(P(used), Q(used));
      const devAll = [];
      pairs.forEach(([a, b]) => {
        const p = MG.applyT(T, [XA.x[a], XA.y[a], XA.z[a]]);
        devAll.push(Math.hypot(p[0] - XB.x[b], p[1] - XB.y[b], p[2] - XB.z[b]));
      });
      const usedSet = new Set(used.map(([a]) => a));
      let s2 = 0;
      pairs.forEach(([a], k) => usedSet.has(a) && (s2 += devAll[k] ** 2));
      rmsd = Math.sqrt(s2 / used.length);
      const rmsdAll = Math.sqrt(devAll.reduce((s, d) => s + d * d, 0) / devAll.length);
      // apply to every atom of the mobile structure
      for (let i = 0; i < mobile.n; i++) {
        const p = MG.applyT(T, [XA.x[i], XA.y[i], XA.z[i]]);
        XA.x[i] = p[0]; XA.y[i] = p[1]; XA.z[i] = p[2];
      }
      mobile.s.refreshPosition();
      mobile.transformed = true;
      this._rebuild(mobile);
      const identity = ali.identity;
      const res = { rmsd, rmsdAll, n: used.length, nAll: pairs.length, identity, mobile: mobile.name, target: target.name, mobileChain: A.ch.name, targetChain: B.ch.name };
      bus.emit('viewer:superposed', res);
      bus.emit('viewer:changed', { what: 'superpose' });
      return res;
    }

    /** write current coordinates (e.g. after superposition) as PDB text */
    toPDB(st) {
      const w = new NGL.PdbWriter(st.s, { renumberSerial: false });
      return w.getData();
    }
  }

  /* ---------------- sequence alignment + Kabsch ---------------- */
  const B62 = (() => {
    const aa = 'ARNDCQEGHILKMFPSTWYV';
    const rows = [
      '4 -1 -2 -2 0 -1 -1 0 -2 -1 -1 -1 -1 -2 -1 1 0 -3 -2 0',
      '-1 5 0 -2 -3 1 0 -2 0 -3 -2 2 -1 -3 -2 -1 -1 -3 -2 -3',
      '-2 0 6 1 -3 0 0 0 1 -3 -3 0 -2 -3 -2 1 0 -4 -2 -3',
      '-2 -2 1 6 -3 0 2 -1 -1 -3 -4 -1 -3 -3 -1 0 -1 -4 -3 -3',
      '0 -3 -3 -3 9 -3 -4 -3 -3 -1 -1 -3 -1 -2 -3 -1 -1 -2 -2 -1',
      '-1 1 0 0 -3 5 2 -2 0 -3 -2 1 0 -3 -1 0 -1 -2 -1 -2',
      '-1 0 0 2 -4 2 5 -2 0 -3 -3 1 -2 -3 -1 0 -1 -3 -2 -2',
      '0 -2 0 -1 -3 -2 -2 6 -2 -4 -4 -2 -3 -3 -2 0 -2 -2 -3 -3',
      '-2 0 1 -1 -3 0 0 -2 8 -3 -3 -1 -2 -1 -2 -1 -2 -2 2 -3',
      '-1 -3 -3 -3 -1 -3 -3 -4 -3 4 2 -3 1 0 -3 -2 -1 -3 -1 3',
      '-1 -2 -3 -4 -1 -2 -3 -4 -3 2 4 -2 2 0 -3 -2 -1 -2 -1 1',
      '-1 2 0 -1 -3 1 1 -2 -1 -3 -2 5 -1 -3 -1 0 -1 -3 -2 -2',
      '-1 -1 -2 -3 -1 0 -2 -3 -2 1 2 -1 5 0 -2 -1 -1 -1 -1 1',
      '-2 -3 -3 -3 -2 -3 -3 -3 -1 0 0 -3 0 6 -4 -2 -2 1 3 -1',
      '-1 -2 -2 -1 -3 -1 -1 -2 -2 -3 -3 -1 -2 -4 7 -1 -1 -4 -3 -2',
      '1 -1 1 0 -1 0 0 0 -1 -2 -2 0 -1 -2 -1 4 1 -3 -2 -2',
      '0 -1 0 -1 -1 -1 -1 -2 -2 -1 -1 -1 -1 -2 -1 1 5 -2 -2 0',
      '-3 -3 -4 -4 -2 -2 -3 -2 -2 -3 -2 -3 -1 1 -4 -3 -2 11 2 -3',
      '-2 -2 -2 -3 -2 -1 -2 -3 2 -1 -1 -2 -1 3 -3 -2 -2 2 7 -1',
      '0 -3 -3 -3 -1 -2 -2 -3 -3 3 1 -2 1 -1 -2 -2 0 -3 -1 4'
    ].map((r) => r.split(' ').map(Number));
    const idx = {};
    aa.split('').forEach((c, i) => (idx[c] = i));
    return (a, b) => (idx[a] === undefined || idx[b] === undefined ? (a === b ? 1 : -1) : rows[idx[a]][idx[b]]);
  })();

  /** Semi-global alignment (Gotoh affine gaps, free end gaps, BLOSUM62).
   *  Returns aligned index pairs [[i in s1, j in s2], ...] and % identity. */
  MG.align = function (s1, s2, gapOpen = 11, gapExt = 1) {
    const n = s1.length, m = s2.length, W = m + 1;
    const NEG = -1e8;
    const M = new Float32Array((n + 1) * W).fill(NEG);
    const X = new Float32Array((n + 1) * W).fill(NEG); // s1 char against gap (move down)
    const Y = new Float32Array((n + 1) * W).fill(NEG); // s2 char against gap (move right)
    const pM = new Int8Array((n + 1) * W), pX = new Int8Array((n + 1) * W), pY = new Int8Array((n + 1) * W);
    M[0] = 0;
    for (let i = 1; i <= n; i++) X[i * W] = 0; // free leading gaps
    for (let j = 1; j <= m; j++) Y[j] = 0;
    const best3 = (a, b, c) => (a >= b && a >= c ? 0 : b >= c ? 1 : 2);
    for (let i = 1; i <= n; i++) {
      const ci = s1.charCodeAt(i - 1);
      for (let j = 1; j <= m; j++) {
        const k = i * W + j, d = k - W - 1, up = k - W, le = k - 1;
        const s = B62(s1[i - 1], s2[j - 1]);
        let b = best3(M[d], X[d], Y[d]);
        M[k] = [M[d], X[d], Y[d]][b] + s;
        pM[k] = b;
        const xo = [M[up] - gapOpen, X[up] - gapExt, Y[up] - gapOpen];
        b = best3(xo[0], xo[1], xo[2]);
        X[k] = xo[b];
        pX[k] = b;
        const yo = [M[le] - gapOpen, X[le] - gapOpen, Y[le] - gapExt];
        b = best3(yo[0], yo[1], yo[2]);
        Y[k] = yo[b];
        pY[k] = b;
        void ci;
      }
    }
    // free trailing gaps: best cell in last row or last column
    let bi = n, bj = m, bs = -Infinity, bstate = 0;
    const consider = (i, j) => {
      const k = i * W + j;
      const v = [M[k], X[k], Y[k]];
      const b = best3(v[0], v[1], v[2]);
      if (v[b] > bs) { bs = v[b]; bi = i; bj = j; bstate = b; }
    };
    for (let j = 1; j <= m; j++) consider(n, j);
    for (let i = 1; i <= n; i++) consider(i, m);
    const pairs = [];
    let ident = 0, i = bi, j = bj, state = bstate;
    while (i > 0 && j > 0) {
      const k = i * W + j;
      if (state === 0) {
        pairs.push([i - 1, j - 1]);
        if (s1[i - 1] === s2[j - 1]) ident++;
        state = pM[k];
        i--; j--;
      } else if (state === 1) {
        state = pX[k];
        i--;
      } else {
        state = pY[k];
        j--;
      }
    }
    pairs.reverse();
    return { pairs, identity: pairs.length ? ident / pairs.length : 0, score: bs };
  };

  /** Optimal rotation+translation taking P onto Q (Horn's quaternion method). */
  MG.kabsch = function (P, Q) {
    const n = P.length;
    const cp = [0, 0, 0], cq = [0, 0, 0];
    for (let k = 0; k < n; k++) for (let d = 0; d < 3; d++) { cp[d] += P[k][d] / n; cq[d] += Q[k][d] / n; }
    let Sxx = 0, Sxy = 0, Sxz = 0, Syx = 0, Syy = 0, Syz = 0, Szx = 0, Szy = 0, Szz = 0;
    for (let k = 0; k < n; k++) {
      const px = P[k][0] - cp[0], py = P[k][1] - cp[1], pz = P[k][2] - cp[2];
      const qx = Q[k][0] - cq[0], qy = Q[k][1] - cq[1], qz = Q[k][2] - cq[2];
      Sxx += px * qx; Sxy += px * qy; Sxz += px * qz;
      Syx += py * qx; Syy += py * qy; Syz += py * qz;
      Szx += pz * qx; Szy += pz * qy; Szz += pz * qz;
    }
    const N = [
      [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
      [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
      [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
      [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz]
    ];
    const { values, vectors } = jacobiEigen(N);
    let best = 0;
    for (let k = 1; k < 4; k++) if (values[k] > values[best]) best = k;
    const [w, x, y, z] = [vectors[0][best], vectors[1][best], vectors[2][best], vectors[3][best]];
    const R = [
      [w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y)],
      [2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x)],
      [2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z]
    ];
    const t = [0, 1, 2].map((r) => cq[r] - (R[r][0] * cp[0] + R[r][1] * cp[1] + R[r][2] * cp[2]));
    return { R, t };
  };
  MG.applyT = function (T, p) {
    const R = T.R;
    return [
      R[0][0] * p[0] + R[0][1] * p[1] + R[0][2] * p[2] + T.t[0],
      R[1][0] * p[0] + R[1][1] * p[1] + R[1][2] * p[2] + T.t[1],
      R[2][0] * p[0] + R[2][1] * p[1] + R[2][2] * p[2] + T.t[2]
    ];
  };
  function jacobiEigen(A) {
    const n = A.length;
    const a = A.map((r) => r.slice());
    const v = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
    for (let sweep = 0; sweep < 100; sweep++) {
      let off = 0;
      for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
      if (off < 1e-18) break;
      for (let p = 0; p < n; p++) {
        for (let q = p + 1; q < n; q++) {
          if (Math.abs(a[p][q]) < 1e-15) continue;
          const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
          const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
          const c = 1 / Math.sqrt(t * t + 1), s = t * c;
          for (let k = 0; k < n; k++) {
            const akp = a[k][p], akq = a[k][q];
            a[k][p] = c * akp - s * akq;
            a[k][q] = s * akp + c * akq;
          }
          for (let k = 0; k < n; k++) {
            const apk = a[p][k], aqk = a[q][k];
            a[p][k] = c * apk - s * aqk;
            a[q][k] = s * apk + c * aqk;
          }
          for (let k = 0; k < n; k++) {
            const vkp = v[k][p], vkq = v[k][q];
            v[k][p] = c * vkp - s * vkq;
            v[k][q] = s * vkp + c * vkq;
          }
        }
      }
    }
    return { values: a.map((r, i) => r[i]), vectors: v };
  }

  /* ---------------- helpers exported for UI ---------------- */
  const ACRONYMS = ['DNA', 'RNA', 'TATA', 'TBP', 'ATP', 'ADP', 'GTP', 'GDP', 'NAD', 'FAD', 'TLR4', 'MD-2', 'LPS', 'II', 'III', 'IV', 'IIB', 'IIA', 'TFIIB', 'TFIIA', 'ADMLP', 'NLR', 'CARD', 'HIV', 'IGG', 'MHC'];
  /** Tidy PDB descriptions: 'MYRISTIC ACID' -> 'Myristic acid' (keeps acronyms). */
  MG.niceDesc = function (s) {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    if (!s || s !== s.toUpperCase() || !/[A-Z]{3}/.test(s) || /\(\*|'-D\(|\*P/.test(s)) return s;
    const low = s.toLowerCase().replace(/(^|[\s(\[-])([a-z0-9]+)/g, (m, p, w) => {
      const up = w.toUpperCase();
      return p + (ACRONYMS.includes(up) ? up : w);
    });
    return low.charAt(0).toUpperCase() + low.slice(1);
  };
  MG.titleCase = MG.niceDesc;
  const NAMED = {
    red: '#e41a1c', orange: '#ff7f00', yellow: '#ffd92f', lime: '#a6d854', green: '#2ca02c', teal: '#1b9e77',
    cyan: '#17becf', sky: '#6baed6', blue: '#1f5fbf', navy: '#08306b', purple: '#7b3294', magenta: '#d01c8b',
    pink: '#f4a6c6', brown: '#8c564b', tan: '#d2b48c', white: '#ffffff', lightgrey: '#d9d9d9', lightgray: '#d9d9d9',
    grey: '#9e9e9e', gray: '#9e9e9e', darkgrey: '#555555', darkgray: '#555555', black: '#111111', gold: '#e6ab02', salmon: '#fb8072', violet: '#bc80bd'
  };
  MG.NAMED_COLORS = NAMED;
  MG.colorToHex = function (c) {
    c = String(c).trim().toLowerCase();
    if (NAMED[c]) return NAMED[c];
    if (/^#?[0-9a-f]{6}$/.test(c)) return c[0] === '#' ? c : '#' + c;
    if (/^#?[0-9a-f]{3}$/.test(c)) {
      const x = c.replace('#', '');
      return '#' + x[0] + x[0] + x[1] + x[1] + x[2] + x[2];
    }
    throw new Error('Unknown colour “' + c + '”');
  };
  MG.isColor = function (c) {
    try {
      MG.colorToHex(c);
      return true;
    } catch (e) {
      return false;
    }
  };

  Object.assign(MG, {
    Viewer, REPS, REP_TYPES, ATOM_REPS, PALETTE, ELEMENT, ELEMENT_NAMES, SS, PLDDT, RESTYPE, KD,
    HYD: { low: HYD_LOW, mid: HYD_MID, high: HYD_HIGH }, LIGAND_C, SUGAR_C, SEL_COLOR,
    toHex, hexToInt: hex, rainbowColor: rainbow, plddtColor, lerpColor: lerp
  });
})();
