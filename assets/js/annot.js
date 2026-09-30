/* =====================================================================
   Proteins in 3D – labels, arrows, shapes and the colour key.
   Drawn as HTML/SVG over the 3D canvas; composited into exported PNGs.
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const { h, esc, bus, toast } = MG;
  const SVGNS = 'http://www.w3.org/2000/svg';
  let idc = 0;

  class Annotations {
    constructor(ui) {
      this.ui = ui;
      this.viewer = ui.viewer;
      this.layer = ui.overlayEl;
      this.items = [];
      this.key = { visible: false, auto: true, fx: null, fy: null, title: 'Key', entries: [] };
      this.selected = null;
      this.drawing = null;
      this.svg = document.createElementNS(SVGNS, 'svg');
      this.svg.setAttribute('class', 'ann-svg');
      this.layer.appendChild(this.svg);
      const defs = document.createElementNS(SVGNS, 'defs');
      defs.innerHTML = '<marker id="annArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker>';
      this.svg.appendChild(defs);
      this.drawLayer = h('div.ann-draw', { hidden: true });
      this.layer.appendChild(this.drawLayer);
      this._wireDraw();
      bus.on('viewer:rendered', () => this.position());
      bus.on('viewer:removed', (d) => {
        this.items = this.items.filter((it) => !(it.anchor && it.anchor.uid === d.st.uid));
        this.render();
      });
      bus.on('viewer:visibility', () => this.position());
      bus.on('viewer:changed', (d) => {
        if (this.key.visible && this.key.auto && ['color', 'display', 'structures', 'state', 'contacts', 'distances', 'superpose'].includes(d.what)) this.rebuildKey(false);
      });
      this.layer.addEventListener('pointerdown', (e) => {
        if (e.target === this.layer || e.target === this.svg) this.select(null);
      });
    }

    /* ------------------------ creation ------------------------ */
    _style() {
      return this.ui.labelStyle();
    }
    _stById(uid) {
      return this.viewer.structures.find((s) => s.uid === uid);
    }

    labelSelection() {
      const V = this.viewer;
      if (!V.hasSelection()) throw new Error('Select residues first (click them, or use the sequence bar), then press “Label residues”.');
      const m = V.selectionMap();
      const style = this._style();
      const created = [];
      m.forEach((idx, st) => {
        const resSet = new Set();
        idx.forEach((i) => resSet.add(st.atomRes[i]));
        // whole chains / groups get one label each
        const whole = [];
        st.chains.forEach((c) => c.residues.every((ri) => resSet.has(ri)) && whole.push({ atoms: c.atoms, text: (c.nice || c.label) + ' (chain ' + c.name + ')', res: c.residues }));
        st.groups.forEach((g) => g.res.every((ri) => resSet.has(ri)) && whole.push({ atoms: g.atoms, text: g.short, res: g.res }));
        const covered = new Set();
        whole.forEach((w) => w.res.forEach((ri) => covered.add(ri)));
        whole.forEach((w) => created.push({ st, atom: this._nearestToCentroid(st, w.atoms), text: w.text }));
        const rest = Array.from(resSet).filter((ri) => !covered.has(ri));
        const chainsInvolved = new Set(rest.map((ri) => st.residues[ri].chain));
        if (rest.length > 40) {
          toast('That is ' + rest.length + ' residues – only the first 40 were labelled. Select fewer residues for a clearer picture.', 'warn');
        }
        rest.slice(0, 40).forEach((ri) => {
          const r = st.residues[ri];
          let text = V.residueName(st, ri, false);
          if (chainsInvolved.size > 1 && r.poly) text += ' (' + r.chain + ')';
          created.push({ st, atom: V.residueAnchor(st, ri), text });
        });
      });
      // spread labels away from their common centre
      const pts = created.map((c) => V.project(V.atomPosition(c.st, c.atom)));
      const cx = pts.reduce((s, p) => s + (p ? p.x : 0), 0) / (pts.length || 1);
      const cy = pts.reduce((s, p) => s + (p ? p.y : 0), 0) / (pts.length || 1);
      created.forEach((c, k) => {
        const p = pts[k];
        let off;
        if (p && created.length > 1) {
          const vx = p.x - cx, vy = p.y - cy, L = Math.hypot(vx, vy) || 1;
          off = { dx: (vx / L) * 36, dy: (vy / L) * 36 - 6 };
        } else off = this._outward(c.st, c.atom, 40);
        const it = { id: ++idc, type: 'label3d', text: c.text, anchor: { uid: c.st.uid, atom: c.atom }, off, style: Object.assign({}, style) };
        this.items.push(it);
        c.item = it;
      });
      this.render();
      created.forEach((c) => {
        this._place(c.item);
        this.position();
      });
      bus.emit('viewer:label', { count: created.length, kind: '3d' });
      return created.length;
    }

    /** Move a newly added 3D label so it does not overlap other labels or leave the canvas */
    _place(it) {
      if (!it.el || it.type !== 'label3d') return;
      const st = this._stById(it.anchor.uid);
      if (!st) return;
      const V = this.viewer;
      const p = V.project(V.atomPosition(st, it.anchor.atom));
      if (!p) return;
      const W = this.layer.clientWidth, H = this.layer.clientHeight;
      const w = it.el.offsetWidth, hgt = it.el.offsetHeight;
      const others = this.items.filter((x) => x !== it && x.el && (x.type === 'label3d' || x.type === 'label2d') && x.el.style.visibility !== 'hidden').map((x) => {
        const r = x.el.getBoundingClientRect(), L = this.layer.getBoundingClientRect();
        return { x: r.left - L.left - 4, y: r.top - L.top - 3, w: r.width + 8, h: r.height + 6 };
      });
      if (this.keyEl) {
        const r = this.keyEl.getBoundingClientRect(), L = this.layer.getBoundingClientRect();
        others.push({ x: r.left - L.left - 4, y: r.top - L.top - 4, w: r.width + 8, h: r.height + 8 });
      }
      const base = Math.atan2(it.off.dy, it.off.dx);
      const r0 = Math.max(30, Math.hypot(it.off.dx, it.off.dy));
      const hit = (cx, cy) => {
        const bx = cx - w / 2, by = cy - hgt / 2;
        if (bx < 4 || by < 4 || bx + w > W - 4 || by + hgt > H - 4) return true;
        return others.some((o) => bx < o.x + o.w && bx + w > o.x && by < o.y + o.h && by + hgt > o.y);
      };
      for (const rad of [r0, r0 * 1.5, r0 * 2.1, r0 * 2.8]) {
        for (const da of [0, 0.45, -0.45, 0.9, -0.9, 1.4, -1.4, 2.0, -2.0, Math.PI]) {
          const a = base + da;
          const dx = Math.cos(a) * rad, dy = Math.sin(a) * rad;
          if (!hit(p.x + dx, p.y + dy)) {
            it.off = { dx, dy };
            return;
          }
        }
      }
    }

    /** offset that pushes a label away from the centre of what is on screen */
    _outward(st, atom, len) {
      const V = this.viewer;
      const p = V.project(V.atomPosition(st, atom));
      const W = this.layer.clientWidth, H = this.layer.clientHeight;
      let cx = W / 2, cy = H / 2;
      // centre of the visible structures (sampled)
      let sx = 0, sy = 0, k = 0;
      V.structures.forEach((s) => {
        if (!s.visible) return;
        const step = Math.max(1, Math.floor(s.n / 400));
        for (let i = 0; i < s.n; i += step) {
          if (s.hidden[i]) continue;
          const q = V.project(V.atomPosition(s, i));
          if (q) { sx += q.x; sy += q.y; k++; }
        }
      });
      if (k) { cx = sx / k; cy = sy / k; }
      if (!p) return { dx: 16, dy: -34 };
      let vx = p.x - cx, vy = p.y - cy;
      const L = Math.hypot(vx, vy);
      if (L < 8) { vx = 0.4; vy = -1; }
      const n = Math.hypot(vx, vy);
      return { dx: (vx / n) * len, dy: (vy / n) * len };
    }

    _nearestToCentroid(st, atoms) {
      const X = st.s.atomStore.x, Y = st.s.atomStore.y, Z = st.s.atomStore.z;
      let cx = 0, cy = 0, cz = 0;
      atoms.forEach((a) => { cx += X[a]; cy += Y[a]; cz += Z[a]; });
      cx /= atoms.length; cy /= atoms.length; cz /= atoms.length;
      let best = atoms[0], bd = Infinity;
      atoms.forEach((a) => {
        const d = (X[a] - cx) ** 2 + (Y[a] - cy) ** 2 + (Z[a] - cz) ** 2;
        if (d < bd) { bd = d; best = a; }
      });
      return best;
    }

    async promptText3D() {
      const V = this.viewer;
      if (!V.structures.length) return toast('Load a structure first.', 'warn');
      if (!V.hasSelection()) return toast('Select the part you want to label first (e.g. click a residue or a chain name).', 'warn');
      const def = V.selectionInfo().text || '';
      const text = await MG.promptText('Label text', 'This label will stay attached to the selection when you rotate.', def.length < 40 ? def : '');
      if (!text) return;
      this.add3D(text);
      this.ui.log(`label3d "${text}" sele`);
    }
    add3D(text, target) {
      const V = this.viewer;
      const m = target ? V.target(target) : V.selectionMap();
      const first = Array.from(m.entries()).find(([st]) => typeof st !== 'string');
      if (!first) throw new Error('Nothing to attach the label to');
      const [st, idx] = first;
      const atom = this._nearestToCentroid(st, idx);
      const it = { id: ++idc, type: 'label3d', text, anchor: { uid: st.uid, atom }, off: this._outward(st, atom, 42), style: Object.assign({}, this._style()) };
      this.items.push(it);
      this.render();
      this._place(it);
      this.position();
      bus.emit('viewer:label', { count: 1, kind: '3d' });
    }
    async promptText2D() {
      const text = await MG.promptText('Fixed text', 'This text stays in place on the picture (good for titles). Drag it where you want it.', '');
      if (!text) return;
      this.add2D(text);
      this.ui.log(`label2d "${text}"`);
    }
    add2D(text, fx, fy, style) {
      const it = { id: ++idc, type: 'label2d', text, pos: { fx: fx != null ? fx : 0.04, fy: fy != null ? fy : 0.05 }, style: Object.assign({}, this._style(), style || {}) };
      if (!style && fx == null) it.style.size = Math.max(it.style.size, 18);
      this.items.push(it);
      this.render();
      this.select(it);
      bus.emit('viewer:label', { count: 1, kind: '2d' });
    }

    startDraw(type) {
      if (!this.viewer.structures.length) return toast('Load a structure first.', 'warn');
      this.drawing = type;
      this.drawLayer.hidden = false;
      this.ui.modeEl.hidden = false;
      this.ui.modeEl.textContent = 'Drag on the picture to draw ' + (type === 'arrow' ? 'an arrow' : type === 'rect' ? 'a box' : 'an ellipse') + ' · Esc to cancel';
    }
    cancelDraw() {
      this.drawing = null;
      this.drawLayer.hidden = true;
      this.ui.modeEl.hidden = true;
      if (this._tmp) this._tmp.remove();
      this._tmp = null;
    }
    _wireDraw() {
      const el = this.drawLayer;
      let start = null;
      const pos = (e) => {
        const r = this.layer.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top, W: r.width, H: r.height };
      };
      el.addEventListener('pointerdown', (e) => {
        if (!this.drawing) return;
        start = pos(e);
        el.setPointerCapture(e.pointerId);
        this._tmp = document.createElementNS(SVGNS, this.drawing === 'arrow' ? 'line' : this.drawing === 'rect' ? 'rect' : 'ellipse');
        this._tmp.setAttribute('class', 'ann-shape tmp');
        this._tmp.setAttribute('stroke', this._style().color);
        this.svg.appendChild(this._tmp);
      });
      el.addEventListener('pointermove', (e) => {
        if (!start || !this._tmp) return;
        const p = pos(e);
        this._shapeAttrs(this._tmp, this.drawing, start.x, start.y, p.x, p.y);
      });
      el.addEventListener('pointerup', (e) => {
        if (!start) return;
        const p = pos(e);
        const type = this.drawing;
        const s = start;
        start = null;
        this.cancelDraw();
        if (Math.hypot(p.x - s.x, p.y - s.y) < 6) return;
        const it = {
          id: ++idc, type, shape: { fx1: s.x / s.W, fy1: s.y / s.H, fx2: p.x / p.W, fy2: p.y / p.H },
          style: Object.assign({}, this._style(), { width: 3 })
        };
        this.items.push(it);
        this.render();
        this.select(it);
        this.ui.log('# drew ' + type);
        bus.emit('viewer:shape', { type });
      });
    }
    _shapeAttrs(el, type, x1, y1, x2, y2) {
      if (type === 'arrow') {
        el.setAttribute('x1', x1); el.setAttribute('y1', y1);
        el.setAttribute('x2', x2); el.setAttribute('y2', y2);
        el.setAttribute('marker-end', 'url(#annArrow)');
      } else if (type === 'rect') {
        el.setAttribute('x', Math.min(x1, x2)); el.setAttribute('y', Math.min(y1, y2));
        el.setAttribute('width', Math.abs(x2 - x1)); el.setAttribute('height', Math.abs(y2 - y1));
        el.setAttribute('rx', 3);
      } else {
        el.setAttribute('cx', (x1 + x2) / 2); el.setAttribute('cy', (y1 + y2) / 2);
        el.setAttribute('rx', Math.abs(x2 - x1) / 2); el.setAttribute('ry', Math.abs(y2 - y1) / 2);
      }
    }

    /* ------------------------ rendering ------------------------ */
    render() {
      // remove old DOM
      this.layer.querySelectorAll('.ann-label, .ann-key').forEach((n) => n.remove());
      Array.from(this.svg.querySelectorAll('.ann-shape, .ann-leader, .ann-handle')).forEach((n) => n.remove());
      this.items.forEach((it) => {
        if (it.type === 'label3d' || it.type === 'label2d') {
          const el = h('div.ann-label.bg-' + (it.style.bg || 'light'), { dataset: { id: it.id } });
          el.textContent = it.text;
          Object.assign(el.style, { fontSize: it.style.size + 'px', color: it.style.color, fontWeight: it.style.bold ? 650 : 400 });
          this._wireItem(el, it);
          this.layer.appendChild(el);
          it.el = el;
          if (it.type === 'label3d') {
            const ln = document.createElementNS(SVGNS, 'line');
            ln.setAttribute('class', 'ann-leader');
            ln.setAttribute('stroke', it.style.color);
            this.svg.appendChild(ln);
            it.leader = ln;
            const dot = document.createElementNS(SVGNS, 'circle');
            dot.setAttribute('class', 'ann-leader');
            dot.setAttribute('r', 2.2);
            dot.setAttribute('fill', it.style.color);
            this.svg.appendChild(dot);
            it.dot = dot;
          }
        } else {
          const el = document.createElementNS(SVGNS, it.type === 'arrow' ? 'line' : it.type === 'rect' ? 'rect' : 'ellipse');
          el.setAttribute('class', 'ann-shape');
          el.setAttribute('stroke', it.style.color);
          el.setAttribute('stroke-width', it.style.width || 3);
          if (it.type !== 'arrow') el.setAttribute('fill', it.style.fill || 'none');
          el.dataset.id = it.id;
          this.svg.appendChild(el);
          it.el = el;
          this._wireItem(el, it);
        }
      });
      if (this.key.visible) this._renderKey();
      this.ui.keyToggle && this.ui.keyToggle.classList.toggle('on', this.key.visible);
      this.position();
      if (this.selected) {
        const still = this.items.find((x) => x.id === this.selected.id);
        this.selected = null;
        if (still) this.select(still);
      }
    }

    position() {
      const W = this.layer.clientWidth, H = this.layer.clientHeight;
      if (!W || !H) return;
      this.svg.setAttribute('width', W);
      this.svg.setAttribute('height', H);
      this.items.forEach((it) => {
        if (!it.el) return;
        if (it.type === 'label3d') {
          const st = this._stById(it.anchor.uid);
          if (!st) return;
          const p = this.viewer.project(this.viewer.atomPosition(st, it.anchor.atom));
          if (!p) return;
          const x = p.x + it.off.dx, y = p.y + it.off.dy;
          it.el.style.left = x + 'px';
          it.el.style.top = y + 'px';
          it.el.style.transform = 'translate(-50%, -50%)';
          const shown = st.visible && !st.hidden[it.anchor.atom];
          it.el.style.visibility = shown ? '' : 'hidden';
          const far = Math.hypot(it.off.dx, it.off.dy) > 16;
          const bw = it.el.offsetWidth / 2, bh = it.el.offsetHeight / 2;
          // leader ends at the label edge
          let ex = x, ey = y;
          const tx = Math.abs(it.off.dx) > 1e-6 ? bw / Math.abs(it.off.dx) : Infinity;
          const ty = Math.abs(it.off.dy) > 1e-6 ? bh / Math.abs(it.off.dy) : Infinity;
          const t = Math.min(tx, ty, 1);
          ex = x - it.off.dx * t;
          ey = y - it.off.dy * t;
          it.leader.setAttribute('x1', p.x); it.leader.setAttribute('y1', p.y);
          it.leader.setAttribute('x2', ex); it.leader.setAttribute('y2', ey);
          it.leader.style.display = far && shown ? '' : 'none';
          it.dot.setAttribute('cx', p.x); it.dot.setAttribute('cy', p.y);
          it.dot.style.display = far && shown ? '' : 'none';
          it._leader = far ? { x1: p.x, y1: p.y, x2: ex, y2: ey } : null;
        } else if (it.type === 'label2d') {
          it.el.style.left = it.pos.fx * W + 'px';
          it.el.style.top = it.pos.fy * H + 'px';
          it.el.style.transform = '';
        } else {
          const s = it.shape;
          this._shapeAttrs(it.el, it.type, s.fx1 * W, s.fy1 * H, s.fx2 * W, s.fy2 * H);
        }
      });
      if (this.keyEl) {
        const kw = this.keyEl.offsetWidth, kh = this.keyEl.offsetHeight;
        const fx = this.key.fx != null ? this.key.fx : (W - kw - 12) / W;
        const fy = this.key.fy != null ? this.key.fy : (H - kh - 12) / H;
        this.keyEl.style.left = MG.clamp(fx * W, 0, Math.max(0, W - kw)) + 'px';
        this.keyEl.style.top = MG.clamp(fy * H, 0, Math.max(0, H - kh)) + 'px';
      }
      if (this.selected) this._positionHandles();
    }

    _wireItem(el, it) {
      let drag = null;
      el.addEventListener('pointerdown', (e) => {
        if (el.isContentEditable) return;
        e.stopPropagation();
        e.preventDefault();
        this.select(it);
        const r = this.layer.getBoundingClientRect();
        drag = { x: e.clientX, y: e.clientY, W: r.width, H: r.height, it: JSON.parse(JSON.stringify({ off: it.off, pos: it.pos, shape: it.shape })) };
        el.setPointerCapture && el.setPointerCapture(e.pointerId);
      });
      el.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (it.type === 'label3d') it.off = { dx: drag.it.off.dx + dx, dy: drag.it.off.dy + dy };
        else if (it.type === 'label2d') it.pos = { fx: drag.it.pos.fx + dx / drag.W, fy: drag.it.pos.fy + dy / drag.H };
        else {
          const s = drag.it.shape;
          it.shape = { fx1: s.fx1 + dx / drag.W, fy1: s.fy1 + dy / drag.H, fx2: s.fx2 + dx / drag.W, fy2: s.fy2 + dy / drag.H };
        }
        this.position();
      });
      const end = () => (drag = null);
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
      if (it.type === 'label3d' || it.type === 'label2d') {
        el.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          this.editText(it);
        });
      }
    }

    editText(it) {
      const el = it.el;
      el.contentEditable = 'true';
      el.classList.add('editing');
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const done = () => {
        el.contentEditable = 'false';
        el.classList.remove('editing');
        const t = el.innerText.trim();
        if (!t) {
          this.items = this.items.filter((x) => x !== it);
          this.render();
        } else it.text = t;
        el.removeEventListener('blur', done);
      };
      el.addEventListener('blur', done);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          el.blur();
        }
        if (e.key === 'Escape') el.blur();
      });
    }

    select(it) {
      this.layer.querySelectorAll('.ann-selected').forEach((n) => n.classList.remove('ann-selected'));
      this.svg.querySelectorAll('.ann-handle').forEach((n) => n.remove());
      this.selected = it;
      if (!it || !it.el) return;
      it.el.classList.add('ann-selected');
      if (it.shape) {
        const mk = (which) => {
          const c = document.createElementNS(SVGNS, 'circle');
          c.setAttribute('class', 'ann-handle');
          c.setAttribute('r', 6);
          c.dataset.which = which;
          this.svg.appendChild(c);
          let drag = null;
          c.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            const r = this.layer.getBoundingClientRect();
            drag = { r };
            c.setPointerCapture(e.pointerId);
          });
          c.addEventListener('pointermove', (e) => {
            if (!drag) return;
            const fx = (e.clientX - drag.r.left) / drag.r.width, fy = (e.clientY - drag.r.top) / drag.r.height;
            if (which === '1') { it.shape.fx1 = fx; it.shape.fy1 = fy; }
            else { it.shape.fx2 = fx; it.shape.fy2 = fy; }
            this.position();
          });
          c.addEventListener('pointerup', () => (drag = null));
        };
        mk('1');
        mk('2');
        this._positionHandles();
      }
      // reflect style in toolbar
      const ui = this.ui;
      if (it.style) {
        if (it.style.size) ui.labelSize.value = String(it.style.size);
        ui.labelColor.value = it.style.color || '#111111';
        if (it.style.bg) ui.labelBg.value = it.style.bg;
        ui.labelBold.checked = !!it.style.bold;
      }
    }
    _positionHandles() {
      const it = this.selected;
      if (!it || !it.shape) return;
      const W = this.layer.clientWidth, H = this.layer.clientHeight;
      this.svg.querySelectorAll('.ann-handle').forEach((c) => {
        const w = c.dataset.which;
        c.setAttribute('cx', (w === '1' ? it.shape.fx1 : it.shape.fx2) * W);
        c.setAttribute('cy', (w === '1' ? it.shape.fy1 : it.shape.fy2) * H);
      });
    }

    applyStyleToSelected(style) {
      const it = this.selected;
      if (!it) return;
      if (it.shape) it.style = Object.assign({}, it.style, { color: style.color });
      else it.style = Object.assign({}, it.style, style);
      this.render();
    }
    deleteSelected() {
      if (!this.selected) return toast('Click a label or shape first to select it.', 'warn');
      const id = this.selected.id;
      this.items = this.items.filter((x) => x.id !== id);
      this.selected = null;
      this.render();
    }
    clearAll() {
      this.items = [];
      this.selected = null;
      this.render();
    }

    /* ------------------------ colour key ------------------------ */
    toggleKey(force) {
      this.key.visible = force != null ? !!force : !this.key.visible;
      if (this.key.visible && (this.key.auto || !this.key.entries.length)) this.rebuildKey(false);
      else this.render();
      bus.emit('viewer:key', { visible: this.key.visible });
    }

    rebuildKey(manual) {
      if (manual) {
        this.key.auto = true;
        this.key.visible = true;
      }
      this.key.entries = this.computeKeyEntries();
      this.render();
      if (manual) bus.emit('viewer:key', { visible: true, rebuilt: true });
    }

    computeKeyEntries() {
      const V = this.viewer;
      const entries = [];
      const add = (e) => {
        const k = (e.gradient ? e.gradient.join() : e.color) + '|' + e.text;
        if (!entries.some((x) => (x.gradient ? x.gradient.join() : x.color) + '|' + x.text === k)) entries.push(e);
      };
      const hx = MG.toHex;
      const elemSeen = new Set();
      const multi = V.structures.filter((s) => s.visible).length > 1;
      V.structures.forEach((st) => {
        if (!st.visible) return;
        const shown = new Uint8Array(st.n), atomShown = new Uint8Array(st.n);
        MG.REP_TYPES.forEach((t) => {
          const mk = st.masks[t];
          const isAtom = MG.ATOM_REPS.includes(t);
          for (let i = 0; i < st.n; i++) if (mk[i] && !st.hidden[i]) { shown[i] = 1; if (isAtom) atomShown[i] = 1; }
        });
        const bySrc = new Map();
        for (let i = 0; i < st.n; i++) {
          if (!shown[i]) continue;
          const s = st.csrc[i];
          if (!bySrc.has(s)) bySrc.set(s, []);
          bySrc.get(s).push(i);
          if (st.tint[i] && atomShown[i]) {
            const e = st.elements[i];
            if (e !== 'C' && e !== 'H' && MG.ELEMENT[e] !== undefined) elemSeen.add(e);
          }
        }
        const pre = multi ? st.name + ' ' : '';
        bySrc.forEach((atoms, sid) => {
          const src = V.csrc[sid];
          if (!src) return;
          if (src.type === 'uniform') add({ color: hx(src.color), text: src.label });
          else if (src.type === 'het') {
            const seenG = new Set();
            atoms.forEach((a) => {
              const g = st.groups.find((g) => g.resSet.has(st.atomRes[a]));
              if (g && !seenG.has(g)) {
                seenG.add(g);
                const col = g.kind === 'ion' ? MG.ELEMENT[st.elements[g.atoms[0]]] || 0x9a9a9a : g.kind === 'water' ? MG.ELEMENT.O : g.carbonColor;
                add({ color: hx(col), text: pre + g.name + (g.kind === 'ligand' || g.kind === 'sugar' ? ' (carbon)' : '') });
              }
            });
          } else if (src.type === 'scheme') {
            const sc = src.scheme;
            const resOf = (a) => st.residues[st.atomRes[a]];
            if (sc === 'chain' || sc === 'molecule') {
              const seen = new Set();
              atoms.forEach((a) => {
                const r = resOf(a);
                if (!r.poly) return;
                const c = st.chains.find((c) => c.name === r.chain);
                const key = sc === 'chain' ? c.name : c.entity;
                if (seen.has(key)) return;
                seen.add(key);
                if (sc === 'chain') add({ color: hx(c.color), text: pre + (c.nice || c.label) + ' – chain ' + c.name });
                else {
                  const ents = [];
                  st.chains.forEach((x) => !ents.includes(x.entity) && ents.push(x.entity));
                  const chainsOf = st.chains.filter((x) => x.entity === c.entity).map((x) => x.name).join(', ');
                  add({ color: hx(MG.PALETTE[ents.indexOf(c.entity) % MG.PALETTE.length]), text: pre + (c.nice || c.label) + ' (chains ' + chainsOf + ')' });
                }
              });
            } else if (sc === 'rainbow') add({ gradient: [0, 0.25, 0.5, 0.75, 1].map((t) => hx(MG.rainbowColor(t))), text: 'N-terminus → C-terminus' });
            else if (sc === 'ss') {
              const have = new Set(atoms.map((a) => resOf(a).ss));
              ['helix', 'strand', 'coil'].forEach((k) => have.has(k) && add({ color: hx(MG.SS[k].color), text: MG.SS[k].label }));
            } else if (sc === 'hydrophobicity') add({ gradient: [hx(MG.HYD.low), hx(MG.HYD.mid), hx(MG.HYD.high)], text: 'Hydrophilic → hydrophobic' });
            else if (sc === 'restype') {
              const have = new Set(atoms.map((a) => resOf(a).one));
              MG.RESTYPE.forEach((c) => c.res.split('').some((x) => have.has(x)) && add({ color: hx(c.color), text: c.label }));
            } else if (sc === 'plddt') MG.PLDDT.forEach((b) => add({ color: hx(b.color), text: b.label }));
            else if (sc === 'bfactor') add({ gradient: ['#2c7bb6', '#f7f7f7', '#d7191c'], text: 'B-factor: low → high' + (st.bfRange ? ` (${st.bfRange[0].toFixed(0)}–${st.bfRange[1].toFixed(0)} Å²)` : '') });
            else if (sc === 'cpk') {
              const els = new Set(atoms.map((a) => st.elements[a]));
              ['C', 'N', 'O', 'S', 'P'].forEach((e) => els.has(e) && add({ color: hx(MG.ELEMENT[e]), text: MG.ELEMENT_NAMES[e] }));
            }
          }
        });
      });
      ['N', 'O', 'S', 'P'].forEach((e) => elemSeen.has(e) && add({ color: MG.toHex(MG.ELEMENT[e]), text: MG.ELEMENT_NAMES[e] + ' atoms' }));
      if (V.structures.some((s) => s.contacts && s.visible)) {
        add({ line: '#2B83BA', text: 'Hydrogen bond' });
        add({ line: '#F0C814', text: 'Salt bridge' });
      }
      if (V.structures.some((s) => s.distances.length && s.visible)) add({ line: '#222222', text: 'Distance (Å)' });
      return entries;
    }

    addKeyEntry() {
      this.key.visible = true;
      this.key.auto = false;
      this.key.entries.push({ color: '#e41a1c', text: 'New entry – double-click to edit' });
      this.render();
    }

    _renderKey() {
      const k = this.key;
      const box = h('div.ann-key', { title: 'Drag to move · double-click text to edit' });
      const title = h('div.ann-key-title', k.title);
      title.addEventListener('dblclick', () => this._editInline(title, (t) => { k.title = t; k.auto = false; }));
      box.appendChild(title);
      k.entries.forEach((e, idx) => {
        let sw;
        if (e.gradient) sw = h('span.ann-sw.grad', { style: { background: `linear-gradient(90deg, ${e.gradient.join(',')})` } });
        else if (e.line) sw = h('span.ann-sw.line', { style: { borderTopColor: e.line } });
        else sw = h('span.ann-sw', { style: { background: e.color } });
        if (!e.gradient && !e.line) {
          const pick = h('input', { type: 'color', value: e.color, tabindex: -1 });
          pick.addEventListener('input', () => { e.color = pick.value; sw.style.background = pick.value; k.auto = false; });
          pick.addEventListener('pointerdown', (ev) => ev.stopPropagation());
          sw.appendChild(pick);
        }
        const txt = h('span.ann-kt', e.text);
        txt.addEventListener('dblclick', (ev) => {
          ev.stopPropagation();
          this._editInline(txt, (t) => { e.text = t; k.auto = false; });
        });
        const del = h('button.ann-kdel', { type: 'button', title: 'Remove this entry', html: MG.icon('x') });
        del.addEventListener('pointerdown', (ev) => ev.stopPropagation());
        del.addEventListener('click', () => {
          k.entries.splice(idx, 1);
          k.auto = false;
          this.render();
        });
        box.appendChild(h('div.ann-krow', sw, txt, del));
      });
      if (!k.entries.length) box.appendChild(h('div.ann-krow.muted', 'No colours yet'));
      let drag = null;
      box.addEventListener('pointerdown', (e) => {
        if (e.target.isContentEditable || e.target.tagName === 'INPUT' || e.target.closest('button')) return;
        const r = this.layer.getBoundingClientRect();
        const b = box.getBoundingClientRect();
        drag = { x: e.clientX, y: e.clientY, bx: b.left - r.left, by: b.top - r.top, W: r.width, H: r.height };
        box.setPointerCapture(e.pointerId);
        e.stopPropagation();
      });
      box.addEventListener('pointermove', (e) => {
        if (!drag) return;
        k.fx = (drag.bx + e.clientX - drag.x) / drag.W;
        k.fy = (drag.by + e.clientY - drag.y) / drag.H;
        this.position();
      });
      box.addEventListener('pointerup', () => (drag = null));
      this.layer.appendChild(box);
      this.keyEl = box;
    }
    _editInline(el, save) {
      el.contentEditable = 'true';
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(range);
      const done = () => {
        el.contentEditable = 'false';
        save(el.innerText.trim());
        el.removeEventListener('blur', done);
      };
      el.addEventListener('blur', done);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
      });
    }

    /* ------------------------ state ------------------------ */
    getState() {
      return {
        items: this.items.map((it) => ({ id: it.id, type: it.type, text: it.text, anchor: it.anchor, off: it.off, pos: it.pos, shape: it.shape, style: it.style })),
        key: JSON.parse(JSON.stringify(this.key))
      };
    }
    setState(s, uidMap) {
      if (!s) return;
      this.items = (s.items || []).map((it) => {
        const c = JSON.parse(JSON.stringify(it));
        if (c.anchor && uidMap && uidMap.has(c.anchor.uid)) c.anchor.uid = uidMap.get(c.anchor.uid);
        idc = Math.max(idc, c.id || 0);
        return c;
      });
      this.key = Object.assign({ visible: false, auto: true, entries: [] }, s.key || {});
      this.selected = null;
      this.render();
    }

    /* ------------------------ export ------------------------ */
    async composite(blob, factor) {
      const img = await new Promise((resolve, reject) => {
        const u = URL.createObjectURL(blob);
        const im = new Image();
        im.onload = () => { URL.revokeObjectURL(u); resolve(im); };
        im.onerror = reject;
        im.src = u;
      });
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const L = this.layer.getBoundingClientRect();
      const sx = img.width / L.width, sy = img.height / L.height;
      const s = (sx + sy) / 2;
      const was = this.selected;
      this.select(null);
      // shapes
      this.items.forEach((it) => {
        if (!it.shape) return;
        const x1 = it.shape.fx1 * img.width, y1 = it.shape.fy1 * img.height, x2 = it.shape.fx2 * img.width, y2 = it.shape.fy2 * img.height;
        ctx.save();
        ctx.strokeStyle = it.style.color;
        ctx.lineWidth = (it.style.width || 3) * s;
        ctx.lineCap = 'round';
        ctx.beginPath();
        if (it.type === 'arrow') {
          const ang = Math.atan2(y2 - y1, x2 - x1), hl = 12 * s;
          const bx = x2 - Math.cos(ang) * hl * 0.8, by = y2 - Math.sin(ang) * hl * 0.8;
          ctx.moveTo(x1, y1); ctx.lineTo(bx, by); ctx.stroke();
          ctx.fillStyle = it.style.color;
          ctx.beginPath();
          ctx.moveTo(x2, y2);
          ctx.lineTo(x2 - hl * Math.cos(ang - 0.45), y2 - hl * Math.sin(ang - 0.45));
          ctx.lineTo(x2 - hl * Math.cos(ang + 0.45), y2 - hl * Math.sin(ang + 0.45));
          ctx.closePath();
          ctx.fill();
        } else if (it.type === 'rect') {
          ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
        } else {
          ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
      });
      // labels (+ leaders)
      this.items.forEach((it) => {
        if (!it.el || !(it.type === 'label3d' || it.type === 'label2d')) return;
        if (it.el.style.visibility === 'hidden') return;
        if (it._leader && it.type === 'label3d' && it.leader.style.display !== 'none') {
          ctx.save();
          ctx.strokeStyle = it.style.color;
          ctx.lineWidth = 1.3 * s;
          ctx.beginPath();
          ctx.moveTo(it._leader.x1 * sx, it._leader.y1 * sy);
          ctx.lineTo(it._leader.x2 * sx, it._leader.y2 * sy);
          ctx.stroke();
          ctx.fillStyle = it.style.color;
          ctx.beginPath();
          ctx.arc(it._leader.x1 * sx, it._leader.y1 * sy, 2.2 * s, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
        const r = it.el.getBoundingClientRect();
        this._drawBoxText(ctx, it.el, r, L, sx, sy, s, it.style);
      });
      // key
      if (this.key.visible && this.keyEl) {
        const kb = this.keyEl.getBoundingClientRect();
        const cs = getComputedStyle(this.keyEl);
        ctx.save();
        ctx.fillStyle = cs.backgroundColor;
        ctx.strokeStyle = 'rgba(0,0,0,0.18)';
        ctx.lineWidth = 1 * s;
        this._roundRect(ctx, (kb.left - L.left) * sx, (kb.top - L.top) * sy, kb.width * sx, kb.height * sy, 6 * s);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
        const t = this.keyEl.querySelector('.ann-key-title');
        if (t) this._drawText(ctx, t, L, sx, sy, s);
        this.keyEl.querySelectorAll('.ann-krow').forEach((row) => {
          const sw = row.querySelector('.ann-sw');
          const tx = row.querySelector('.ann-kt');
          if (sw) {
            const b = sw.getBoundingClientRect();
            const x = (b.left - L.left) * sx, y = (b.top - L.top) * sy, w = b.width * sx, hh = b.height * sy;
            ctx.save();
            if (sw.classList.contains('grad')) {
              const g = ctx.createLinearGradient(x, 0, x + w, 0);
              const stops = (sw.style.background.match(/rgb\([^)]*\)|#[0-9a-f]{6}/gi) || []);
              stops.forEach((c, k) => g.addColorStop(stops.length > 1 ? k / (stops.length - 1) : 0, c));
              ctx.fillStyle = g;
              ctx.fillRect(x, y, w, hh);
            } else if (sw.classList.contains('line')) {
              ctx.strokeStyle = sw.style.borderTopColor;
              ctx.lineWidth = 2.5 * s;
              ctx.setLineDash([5 * s, 3.5 * s]);
              ctx.beginPath();
              ctx.moveTo(x, y + hh / 2);
              ctx.lineTo(x + w, y + hh / 2);
              ctx.stroke();
            } else {
              ctx.fillStyle = sw.style.background || sw.style.backgroundColor;
              ctx.fillRect(x, y, w, hh);
              ctx.strokeStyle = 'rgba(0,0,0,0.35)';
              ctx.lineWidth = 1 * s;
              ctx.strokeRect(x, y, w, hh);
            }
            ctx.restore();
          }
          if (tx) this._drawText(ctx, tx, L, sx, sy, s);
        });
      }
      if (was) this.select(was);
      return new Promise((resolve) => c.toBlob((b) => resolve(b), 'image/png'));
    }
    _roundRect(ctx, x, y, w, hh, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + hh, r);
      ctx.arcTo(x + w, y + hh, x, y + hh, r);
      ctx.arcTo(x, y + hh, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }
    _drawBoxText(ctx, el, r, L, sx, sy, s) {
      const cs = getComputedStyle(el);
      const bg = cs.backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
        ctx.save();
        ctx.fillStyle = bg;
        this._roundRect(ctx, (r.left - L.left) * sx, (r.top - L.top) * sy, r.width * sx, r.height * sy, 4 * s);
        ctx.fill();
        ctx.restore();
      }
      this._drawText(ctx, el, L, sx, sy, s);
    }
    _drawText(ctx, el, L, sx, sy, s) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const fs = parseFloat(cs.fontSize) * s;
      ctx.save();
      ctx.fillStyle = cs.color;
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${fs}px ${cs.fontFamily}`;
      ctx.textBaseline = 'middle';
      const padL = parseFloat(cs.paddingLeft) || 0;
      const lines = (el.innerText || el.textContent || '').split('\n');
      const lh = r.height / Math.max(1, lines.length);
      lines.forEach((line, k) => {
        ctx.fillText(line, (r.left - L.left + padL) * sx, (r.top - L.top + lh * (k + 0.5)) * sy);
      });
      ctx.restore();
    }
  }

  /* simple text prompt (non-blocking modal) */
  MG.promptText = function (title, hint, def) {
    return new Promise((resolve) => {
      const input = h('input.prompt-input', { type: 'text', value: def || '', 'aria-label': title });
      const ok = h('button.btn.primary', { type: 'submit', text: 'Add' });
      const cancel = h('button.btn', { type: 'button', text: 'Cancel' });
      const form = h('form.prompt-form', h('p', hint || ''), input, h('div.prompt-actions', cancel, ok));
      let done = false;
      const m = MG.modal(title, '', {
        onClose: () => {
          if (!done) {
            done = true;
            resolve('');
          }
        }
      });
      m.box.querySelector('.modal-b').appendChild(form);
      const finish = (v) => {
        if (done) return;
        done = true;
        m.close();
        resolve(v);
      };
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        finish(input.value.trim());
      });
      cancel.addEventListener('click', () => finish(''));
      setTimeout(() => {
        input.focus();
        input.select();
      }, 30);
    });
  };

  MG.Annotations = Annotations;
})();
