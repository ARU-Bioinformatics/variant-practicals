/* =====================================================================
   Proteins in 3D – AlphaFold helpers: API lookup, confidence panel
   (pLDDT profile + interactive PAE plot) and superposition dialog.
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const { h, esc, bus, toast } = MG;

  /** AlphaFold DB API record for a UniProt accession (canonical model) */
  MG.alphafoldInfo = async function (acc) {
    acc = String(acc).toUpperCase();
    const bundled = (MG.config.bundled.alphafold || {})[acc];
    const tasks = [];
    if (bundled && bundled.api && MG.config.preferBundledData) tasks.push(() => MG.fetchJSON(bundled.api));
    tasks.push(() => MG.fetchJSON('https://alphafold.ebi.ac.uk/api/prediction/' + encodeURIComponent(acc)));
    if (bundled && bundled.api && !MG.config.preferBundledData) tasks.push(() => MG.fetchJSON(bundled.api));
    let list;
    try {
      list = await MG.firstOk(tasks);
    } catch (e) {
      if (e && e.status === 404) throw new Error('AlphaFold DB has no model for ' + acc);
      throw new Error('Could not reach AlphaFold DB (' + (e.message || e) + ')');
    }
    if (!Array.isArray(list) || !list.length) throw new Error('AlphaFold DB has no model for ' + acc);
    const pick =
      list.find((x) => x.entryId === 'AF-' + acc + '-F1') ||
      list.find((x) => (x.uniprotAccession || '').toUpperCase() === acc) ||
      list[0];
    if (bundled) pick._bundled = bundled;
    return pick;
  };

  async function loadPAE(st) {
    const af = st.af || {};
    const acc = (af.uniprotAccession || st.source.acc || '').toUpperCase();
    const bundled = (MG.config.bundled.alphafold || {})[acc];
    const tasks = [];
    if (bundled && bundled.pae && MG.config.preferBundledData) tasks.push(() => MG.fetchJSON(bundled.pae, {}, 40000));
    if (af.paeDocUrl) tasks.push(() => MG.fetchJSON(af.paeDocUrl, {}, 40000));
    if (bundled && bundled.pae && !MG.config.preferBundledData) tasks.push(() => MG.fetchJSON(bundled.pae, {}, 40000));
    const raw = await MG.firstOk(tasks);
    const d = Array.isArray(raw) ? raw[0] : raw;
    if (d.predicted_aligned_error) return { matrix: d.predicted_aligned_error, max: d.max_predicted_aligned_error || 31.75 };
    if (d.distance && d.residue1) {
      // old format (v1/v2)
      const n = Math.max(...d.residue1);
      const m = Array.from({ length: n }, () => new Array(n).fill(0));
      for (let k = 0; k < d.distance.length; k++) m[d.residue1[k] - 1][d.residue2[k] - 1] = d.distance[k];
      return { matrix: m, max: d.max_predicted_aligned_error || 31.75 };
    }
    throw new Error('Unrecognised PAE format');
  }

  class AFPanel {
    constructor(ui) {
      this.ui = ui;
      this.V = ui.viewer;
      this.slot = ui.afSlot;
      this.st = null;
      this.collapsed = false;
      bus.on('viewer:loaded', (d) => {
        if (d.st.kind === 'alphafold') this.show(d.st);
      });
      bus.on('viewer:removed', (d) => {
        if (d.st === this.st) {
          const other = this.V.structures.filter((s) => s.kind === 'alphafold').pop();
          if (other) this.show(other);
          else this.hide();
        }
      });
      bus.on('viewer:selection', () => this.drawProfile());
    }
    hide() {
      this.slot.innerHTML = '';
      this.st = null;
    }
    show(st) {
      this.st = st;
      const af = st.af || {};
      const res = st.residues.filter((r) => r.prot);
      this.res = res;
      const vals = res.map((r) => r.bf);
      const mean = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
      const frac = [0, 0, 0, 0];
      vals.forEach((v) => (frac[v > 90 ? 0 : v > 70 ? 1 : v > 50 ? 2 : 3] += 1 / vals.length));
      const bar = h('div.af-frac');
      MG.PLDDT.forEach((b, k) => {
        if (frac[k] > 0) bar.appendChild(h('span', { style: { width: (frac[k] * 100).toFixed(1) + '%', background: MG.toHex(b.color) }, title: `${b.label}: ${(frac[k] * 100).toFixed(1)}% of residues` }));
      });
      const legend = h('div.af-legend', ...MG.PLDDT.map((b, k) => h('span', h('i', { style: { background: MG.toHex(b.color) } }), b.label.replace(' (pLDDT > 90)', ' >90').replace(' (pLDDT < 50)', ' <50'), h('small', ' ' + (frac[k] * 100).toFixed(0) + '%'))));
      this.profile = h('canvas.af-profile', { width: 560, height: 110, 'aria-label': 'pLDDT along the sequence' });
      this.profileTip = h('div.af-ptip');
      this.paeBox = h('div.af-pae', h('p.hint', 'Loading PAE…'));
      const toggle = h('button.icon-btn', { type: 'button', title: 'Collapse / expand', html: MG.icon(this.collapsed ? 'chevR' : 'chevD') });
      toggle.addEventListener('click', () => {
        this.collapsed = !this.collapsed;
        this.show(st);
      });
      const btns = h('div.af-btns',
        this._b('Colour by pLDDT', () => MG.app.vui.run(`color plddt ${st.name}`)),
        this._b('Hide pLDDT < 50', () => {
          const idx = [];
          st.residues.forEach((r) => {
            if (r.poly && r.bf < 50) for (let a = r.a0; a < r.a0 + r.na; a++) idx.push(a);
          });
          if (!idx.length) return toast('No residues with pLDDT below 50.');
          this.V.setVisible(new Map([[st, idx]]), false);
          MG.app.vui.log(`# hid ${st.name} residues with pLDDT < 50`);
          bus.emit('af:hide-low', {});
        }),
        this._b('Superpose onto…', () => MG.superposeDialog(st))
      );
      const head = h('div.af-head', toggle, h('div', h('b', 'AlphaFold confidence'), h('div.muted', `${st.name}${af.latestVersion ? ' · v' + af.latestVersion : ''} · ${af.uniprotDescription || ''}`)));
      this.profDetails = h('details.af-det', { open: !!this._openProfile }, h('summary', 'pLDDT along the sequence'), h('div.af-profwrap', this.profile, this.profileTip), h('p.hint', 'Click the plot to select and centre on a residue.'));
      this.paeDetails = h('details.af-det', { open: !!this._openPAE }, h('summary', 'Predicted aligned error (PAE) plot'), this.paeBox);
      this.profDetails.addEventListener('toggle', () => (this._openProfile = this.profDetails.open));
      this.paeDetails.addEventListener('toggle', () => {
        this._openPAE = this.paeDetails.open;
        if (this.paeDetails.open) {
          this.loadPAE(st);
          bus.emit('af:pae-open', {});
        }
      });
      const body = h('div.af-body' + (this.collapsed ? '.hidden' : ''),
        h('div.af-mean', h('span', 'Mean pLDDT '), h('b', mean.toFixed(1)), h('span.muted', ' / 100')),
        bar, legend,
        this.profDetails,
        this.paeDetails,
        btns);
      this.slot.innerHTML = '';
      this.slot.appendChild(h('div.af-panel' + (this.collapsed ? '.collapsed' : ''), head, body));
      this.drawProfile();
      this._wireProfile();
      if (!this.collapsed && this._openPAE) this.loadPAE(st);
    }
    _b(label, fn) {
      const b = h('button.btn.small', { type: 'button', text: label });
      b.addEventListener('click', fn);
      return b;
    }
    drawProfile() {
      if (!this.st || !this.profile) return;
      const c = this.profile, ctx = c.getContext('2d');
      const W = c.width, H = c.height, padL = 26, padB = 16, padT = 6;
      ctx.clearRect(0, 0, W, H);
      const res = this.res;
      const n = res.length;
      const x = (k) => padL + (k / Math.max(1, n - 1)) * (W - padL - 4);
      const y = (v) => padT + (1 - v / 100) * (H - padT - padB);
      // bands
      [[90, 100, '#0053d6'], [70, 90, '#65cbf3'], [50, 70, '#ffdb13'], [0, 50, '#ff7d45']].forEach(([a, b, col]) => {
        ctx.fillStyle = col + '22';
        ctx.fillRect(padL, y(b), W - padL - 4, y(a) - y(b));
      });
      // selection shading
      const st = this.st;
      ctx.fillStyle = 'rgba(57,255,20,0.35)';
      res.forEach((r, k) => {
        if (st.sel[r.ca]) ctx.fillRect(x(k) - 1, padT, Math.max(2, (W - padL) / n), H - padT - padB);
      });
      ctx.lineWidth = 1.4;
      for (let k = 1; k < n; k++) {
        ctx.strokeStyle = MG.toHex(MG.plddtColor((res[k].bf + res[k - 1].bf) / 2));
        ctx.beginPath();
        ctx.moveTo(x(k - 1), y(res[k - 1].bf));
        ctx.lineTo(x(k), y(res[k].bf));
        ctx.stroke();
      }
      ctx.fillStyle = '#555';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'right';
      [0, 50, 70, 90, 100].forEach((v) => ctx.fillText(String(v), padL - 4, y(v) + 3));
      ctx.textAlign = 'center';
      const step = n > 600 ? 100 : n > 250 ? 50 : 20;
      res.forEach((r, k) => {
        if (r.resno % step === 0) {
          ctx.fillText(String(r.resno), x(k), H - 3);
          ctx.fillRect(x(k), H - padB, 1, 3);
        }
      });
      this._geom = { x, padL, W, n };
    }
    _wireProfile() {
      const c = this.profile;
      const kOf = (e) => {
        const r = c.getBoundingClientRect();
        const px = ((e.clientX - r.left) / r.width) * c.width;
        const g = this._geom;
        return Math.round(((px - g.padL) / (g.W - g.padL - 4)) * (g.n - 1));
      };
      c.addEventListener('mousemove', (e) => {
        const k = kOf(e);
        const r = this.res[k];
        if (!r) return (this.profileTip.hidden = true);
        this.profileTip.hidden = false;
        this.profileTip.textContent = `${MG.niceRes(r.resname)}${r.resno}: pLDDT ${r.bf.toFixed(1)}`;
        const br = c.getBoundingClientRect();
        this.profileTip.style.left = Math.min(br.width - 120, e.clientX - br.left + 8) + 'px';
      });
      c.addEventListener('mouseleave', () => (this.profileTip.hidden = true));
      c.addEventListener('click', (e) => {
        const r = this.res[kOf(e)];
        if (!r) return;
        const idx = [];
        for (let a = r.a0; a < r.a0 + r.na; a++) idx.push(a);
        this.V.select(new Map([[this.st, idx]]), e.shiftKey ? 'add' : 'set');
        this.V.centerOn(idx, this.st);
        MG.app.vui.log(`select ${this.st.name} ${r.chain}:${r.resno}`);
      });
    }
    async loadPAE(st) {
      const box = this.paeBox;
      if (box.dataset.loaded === st.name) return;
      box.dataset.loaded = st.name;
      try {
        const pae = st._pae || (st._pae = await loadPAE(st));
        if (this.st !== st) return;
        this.drawPAE(st, pae);
        bus.emit('af:pae', { st: st.name });
      } catch (e) {
        box.innerHTML = '';
        const img = st.af && st.af.paeImageUrl ? `<img src="${esc(st.af.paeImageUrl)}" alt="PAE plot from AlphaFold DB" style="max-width:220px">` : '';
        box.innerHTML = `<p class="hint">Interactive PAE not available (${esc(e.message)}).</p>${img}`;
      }
    }
    drawPAE(st, pae) {
      const box = this.paeBox;
      box.innerHTML = '';
      const n = pae.matrix.length;
      const S = 200;
      const c = h('canvas.pae-canvas', { width: n, height: n, style: { width: S + 'px', height: S + 'px' }, 'aria-label': 'Predicted aligned error matrix' });
      const ctx = c.getContext('2d');
      const img = ctx.createImageData(n, n);
      const max = pae.max || 31.75;
      // AlphaFold DB palette: dark green (low error) -> white (high error)
      const lo = [0x0f, 0x5a, 0x1e], hi = [0xff, 0xff, 0xff];
      for (let i = 0; i < n; i++) {
        const row = pae.matrix[i];
        for (let j = 0; j < n; j++) {
          const t = Math.min(1, row[j] / max);
          const k = (i * n + j) * 4;
          img.data[k] = lo[0] + (hi[0] - lo[0]) * t;
          img.data[k + 1] = lo[1] + (hi[1] - lo[1]) * t;
          img.data[k + 2] = lo[2] + (hi[2] - lo[2]) * t;
          img.data[k + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      const rect = h('div.pae-rect', { hidden: true });
      const tip = h('div.pae-tip', { hidden: true });
      const wrap = h('div.pae-wrap', { style: { width: S + 'px', height: S + 'px' } }, c, rect, tip);
      const scale = h('div.pae-scale', h('span', '0 Å'), h('i'), h('span', Math.round(max) + ' Å'));
      const axes = h('div.pae-axes', h('span', 'x: scored residue →   y: aligned residue ↓'));
      const expl = h('p.hint', 'Dark green = the relative position of those two residues is predicted confidently. White = the model cannot tell how those parts sit relative to each other.');
      box.append(wrap, h('div.pae-under', scale, axes), expl);
      const toIJ = (e) => {
        const r = c.getBoundingClientRect();
        const j = Math.floor(((e.clientX - r.left) / r.width) * n);
        const i = Math.floor(((e.clientY - r.top) / r.height) * n);
        return { i: MG.clamp(i, 0, n - 1), j: MG.clamp(j, 0, n - 1), x: e.clientX - r.left, y: e.clientY - r.top };
      };
      let start = null;
      wrap.addEventListener('pointermove', (e) => {
        const p = toIJ(e);
        tip.hidden = false;
        tip.textContent = `x = residue ${p.j + 1}, y = residue ${p.i + 1}: expected error ${pae.matrix[p.i][p.j].toFixed(1)} Å`;
        tip.style.left = Math.min(S - 150, p.x + 10) + 'px';
        tip.style.top = Math.min(S - 30, p.y + 12) + 'px';
        if (start) {
          Object.assign(rect.style, { left: Math.min(p.x, start.x) + 'px', top: Math.min(p.y, start.y) + 'px', width: Math.abs(p.x - start.x) + 'px', height: Math.abs(p.y - start.y) + 'px' });
        }
      });
      wrap.addEventListener('pointerleave', () => (tip.hidden = true));
      wrap.addEventListener('pointerdown', (e) => {
        start = toIJ(e);
        rect.hidden = false;
        Object.assign(rect.style, { left: start.x + 'px', top: start.y + 'px', width: '0px', height: '0px' });
        wrap.setPointerCapture(e.pointerId);
      });
      wrap.addEventListener('pointerup', (e) => {
        if (!start) return;
        const p = toIJ(e);
        const a = start;
        start = null;
        const r1 = [Math.min(a.i, p.i) + 1, Math.max(a.i, p.i) + 1];
        const r2 = [Math.min(a.j, p.j) + 1, Math.max(a.j, p.j) + 1];
        if (r1[1] - r1[0] < 1 && r2[1] - r2[0] < 1) {
          rect.hidden = true;
          return;
        }
        const idx = [];
        st.residues.forEach((r) => {
          if (!r.poly) return;
          if ((r.resno >= r1[0] && r.resno <= r1[1]) || (r.resno >= r2[0] && r.resno <= r2[1])) for (let x = r.a0; x < r.a0 + r.na; x++) idx.push(x);
        });
        let sum = 0, cnt = 0;
        for (let i = r1[0] - 1; i < r1[1]; i++) for (let j = r2[0] - 1; j < r2[1]; j++) { sum += pae.matrix[i][j]; cnt++; }
        this.V.select(new Map([[st, idx]]), 'set');
        MG.app.vui.log(`# PAE box: residues ${r2[0]}–${r2[1]} vs ${r1[0]}–${r1[1]}, mean expected error ${(sum / cnt).toFixed(1)} Å`);
        toast(`Selected residues ${r2[0]}–${r2[1]} and ${r1[0]}–${r1[1]} · mean PAE between them <b>${(sum / cnt).toFixed(1)} Å</b>`, 'ok', 7000);
        bus.emit('af:pae-select', { r1, r2, mean: sum / cnt });
      });
    }
  }

  /** dialog to choose what to superpose onto */
  MG.superposeDialog = function (mobileSt) {
    const V = MG.app.viewer;
    const others = V.structures.filter((s) => s !== mobileSt && s.chains.some((c) => c.type === 'protein'));
    if (!others.length) {
      toast('Load an experimental structure too (e.g. 3FXI), then superpose the model onto it.', 'warn', 6000);
      return;
    }
    const chainOpts = (st) => st.chains.filter((c) => c.type === 'protein').map((c) => `<option value="${st.uid}|${c.name}">${esc(st.name)} chain ${c.name} – ${esc(c.nice || c.label)}</option>`).join('');
    const m = MG.modal('Superpose structures', `
      <p>Moves <b>${esc(mobileSt.name)}</b> so that the chosen chain lies on top of the target chain (residues are paired by a sequence alignment, then the Cα atoms are fitted).</p>
      <label class="stack">Move this chain<select id="supMob">${chainOpts(mobileSt)}</select></label>
      <label class="stack">…onto this chain<select id="supTar">${others.map(chainOpts).join('')}</select></label>
      <div class="prompt-actions"><button class="btn primary" id="supGo" type="button">Superpose</button></div>`);
    m.box.querySelector('#supGo').addEventListener('click', () => {
      const [u1, c1] = m.box.querySelector('#supMob').value.split('|');
      const [u2, c2] = m.box.querySelector('#supTar').value.split('|');
      const s1 = V.structures.find((s) => String(s.uid) === u1), s2 = V.structures.find((s) => String(s.uid) === u2);
      m.close();
      MG.app.vui.run(`superpose ${s1.name}:${c1} onto ${s2.name}:${c2}`);
    });
  };

  MG.AFPanel = AFPanel;
})();
