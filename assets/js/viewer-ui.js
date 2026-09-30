/* =====================================================================
   Proteins in 3D – viewer user interface (toolbar, workspace, sequence,
   tooltips, box select, measuring, saved views, export)
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const { h, esc, bus, toast, icon } = MG;
  const I = (n) => MG.icon(n);

  const STYLE_BTNS = [
    ['cartoon', 'Cartoon', 'Ribbon cartoon showing the backbone fold (helices, strands, loops)'],
    ['tube', 'Tube', 'A smooth tube through the backbone – good for flexible regions'],
    ['sticks', 'Sticks', 'All bonds as sticks – best for ligands and side chains'],
    ['ballstick', 'Ball & stick', 'Atoms as small balls joined by sticks'],
    ['spheres', 'Spheres', 'Space-filling (CPK) atoms – shows size and packing'],
    ['surface', 'Surface', 'Molecular surface – shows shape, pockets and grooves'],
    ['glass', 'See-through', 'Transparent surface – see the cartoon or ligand inside'],
    ['lines', 'Lines', 'Thin bonds (wire)']
  ];
  const SCHEMES = [
    ['chain', 'By chain', 'Each chain a different colour'],
    ['molecule', 'By molecule', 'Identical molecules (e.g. both copies of TLR4) share a colour'],
    ['rainbow', 'Rainbow N→C', 'Blue (N-terminus) to red (C-terminus) along each chain'],
    ['ss', 'Secondary structure', 'Helix red, strand yellow, loop grey'],
    ['hydrophobicity', 'Hydrophobicity', 'Kyte–Doolittle: orange = hydrophobic, blue = hydrophilic'],
    ['restype', 'Residue type', 'Acidic red, basic blue, polar green, hydrophobic sandy'],
    ['element', 'By element', 'Colour N, O, S, P atoms by element (carbons keep their colour)'],
    ['cpk', 'Element (grey C)', 'All atoms by element with grey carbons'],
    ['plddt', 'pLDDT (AlphaFold)', 'AlphaFold confidence: dark blue = very high … orange = very low'],
    ['bfactor', 'B-factor', 'Crystallographic B-factor: blue = well ordered, red = mobile'],
    ['default', 'Reset colours', 'Back to the default colours']
  ];
  const SWATCHES = ['red', 'orange', 'gold', 'yellow', 'lime', 'green', 'teal', 'cyan', 'sky', 'blue', 'navy', 'violet', 'purple', 'magenta', 'pink', 'salmon', 'brown', 'tan', 'white', 'lightgrey', 'grey', 'darkgrey', 'black'];

  class ViewerUI {
    constructor(root) {
      this.root = root;
      this.views = [];
      this.expanded = new Set();
      this.seqChain = null;
      this.boxMode = false;
      this._build();
      this.viewer = new MG.Viewer(this.stageEl);
      MG.app = MG.app || {};
      MG.app.viewer = this.viewer;
      MG.app.vui = this;
      this.annot = new MG.Annotations(this);
      MG.app.annot = this.annot;
      if (MG.AFPanel) this.afPanel = new MG.AFPanel(this);
      this._wire();
      this.renderTree();
      this.renderScope();
      this.renderEmpty();
    }

    /* ------------------------------------------------------------ */
    _build() {
      const r = this.root;
      r.classList.add('viewer-app');
      r.innerHTML = '';
      /* top row: loading + quick actions */
      this.loadForm = h('form.v-load', { autocomplete: 'off' },
        h('label.v-field', h('span', 'PDB ID'), (this.pdbInput = h('input', { type: 'text', placeholder: 'e.g. 3FXI', maxlength: 4, spellcheck: 'false', 'aria-label': 'PDB ID to load', size: 6 }))),
        (this.pdbBtn = h('button.btn.primary', { type: 'submit', title: 'Load this entry from the Protein Data Bank', html: I('download') + '<span>Load</span>' })),
        h('span.v-sep'),
        h('label.v-field', h('span', 'AlphaFold'), (this.afInput = h('input', { type: 'text', placeholder: 'UniProt e.g. O00206', spellcheck: 'false', 'aria-label': 'UniProt accession for AlphaFold model', size: 12 }))),
        (this.afBtn = h('button.btn', { type: 'button', title: 'Load the AlphaFold DB model for this UniProt accession', html: I('sparkle') + '<span>Load model</span>' })),
        h('span.v-sep'),
        (this.fileBtn = h('button.btn', { type: 'button', title: 'Open a .pdb or .cif file from your computer', html: I('folder') + '<span>Open file</span>' })),
        (this.fileInput = h('input', { type: 'file', accept: '.pdb,.ent,.cif,.mmcif,.bcif,.gz,.txt', hidden: true }))
      );
      this.quick = h('div.v-quick',
        this._qbtn('reset', 'Reset view (fit everything)', () => { this.viewer.resetView(); this.log('reset'); }),
        this._qbtn('target', 'Centre on the selection', () => { this.viewer.centerOn(); this.log('center sele'); }),
        (this.spinBtn = this._qbtn('spin', 'Spin on/off', () => { this.viewer.setSpin(!this.viewer.spinning); this.spinBtn.classList.toggle('on', this.viewer.spinning); this.log('spin ' + (this.viewer.spinning ? 'on' : 'off')); })),
        this._qbtn('contrast', 'Background: white / black / grey', () => this.cycleBackground()),
        this._qbtn('maximize', 'Full screen', () => this.fullscreen()),
        this._qbtn('help', 'Mouse controls & tips', () => this.showHelp())
      );
      const top = h('div.v-top', this.loadForm);

      /* ribbon with tabs */
      this.tabs = {};
      this.panels = {};
      const tabDefs = [
        ['display', 'Display', 'layers'],
        ['colour', 'Colour', 'palette'],
        ['select', 'Select', 'boxsel'],
        ['labels', 'Labels & key', 'tag'],
        ['measure', 'Measure', 'ruler'],
        ['views', 'Views', 'camera'],
        ['export', 'Save image', 'image']
      ];
      const tabBar = h('div.v-tabs', { role: 'tablist' });
      const panelBox = h('div.v-panels');
      tabDefs.forEach(([id, label, ic]) => {
        const b = h('button.v-tab', { type: 'button', role: 'tab', 'data-tab': id, html: I(ic) + '<span>' + label + '</span>' });
        b.addEventListener('click', () => this.showTab(id));
        tabBar.appendChild(b);
        this.tabs[id] = b;
        const p = h('div.v-panel', { role: 'tabpanel', 'data-panel': id });
        panelBox.appendChild(p);
        this.panels[id] = p;
      });
      this._buildDisplayPanel();
      this._buildColourPanel();
      this._buildSelectPanel();
      this._buildLabelsPanel();
      this._buildMeasurePanel();
      this._buildViewsPanel();
      this._buildExportPanel();
      const ribbon = h('div.v-ribbon', h('div.v-tabrow', tabBar, this.quick), panelBox);

      this.scopeEl = h('div.v-scope', { 'aria-live': 'polite' });

      /* body */
      this.treeEl = h('div.tree', { role: 'tree' });
      this.work = h('aside.v-work',
        h('div.v-work-h', h('span', 'Workspace'), h('span.v-work-hint', { title: 'Click a name to select it · double-click to centre · eye to show/hide' }, '?')),
        this.treeEl
      );
      this.seqEl = h('div.v-seq');
      this.stageEl = h('div.v-stage');
      this.overlayEl = h('div.v-overlay');
      this.boxEl = h('div.v-boxsel', { hidden: true });
      this.boxRect = h('div.v-boxrect');
      this.boxEl.appendChild(this.boxRect);
      this.tipEl = h('div.v-tip', { hidden: true });
      this.busyEl = h('div.v-busy', { hidden: true }, h('div.spinner'), h('span'));
      this.emptyEl = h('div.v-empty');
      this.modeEl = h('div.v-mode', { hidden: true });
      this.afSlot = h('div.v-afslot');
      this.stageWrap = h('div.v-stagewrap', this.stageEl, this.overlayEl, this.boxEl, this.tipEl, this.modeEl, this.afSlot, this.emptyEl, this.busyEl);
      const main = h('div.v-main', this.seqEl, this.stageWrap);
      const body = h('div.v-body', this.work, main);

      /* console */
      this.consoleLog = h('div.v-console-log', { 'aria-live': 'polite' });
      this.consoleInput = h('input.v-console-input', { type: 'text', placeholder: 'Type a command, e.g.  color rainbow A   ·   help', spellcheck: 'false', 'aria-label': 'Viewer command' });
      this.consoleEl = h('div.v-console.collapsed',
        h('button.v-console-toggle', { type: 'button', html: I('terminal') + '<span>Command line</span><small>every button you press is also written here as a command</small>' }),
        h('div.v-console-body', this.consoleLog, h('form.v-console-form', h('span.prompt', '›'), this.consoleInput))
      );
      r.append(top, ribbon, this.scopeEl, body, this.consoleEl);
      this.showTab('display');
    }

    _qbtn(ic, title, fn) {
      const b = h('button.qbtn', { type: 'button', title, 'aria-label': title, html: I(ic) });
      b.addEventListener('click', fn);
      return b;
    }
    _btn(ic, label, title, fn, cls) {
      const b = h('button.rbtn' + (cls ? '.' + cls : ''), { type: 'button', title: title || label, html: (ic ? I(ic) : '') + '<span>' + label + '</span>' });
      if (fn) b.addEventListener('click', fn);
      return b;
    }
    _group(title, ...kids) {
      return h('div.rgroup', h('div.rgroup-items', ...kids), h('div.rgroup-title', title));
    }

    _buildDisplayPanel() {
      const p = this.panels.display;
      this.styleBtns = {};
      const styles = STYLE_BTNS.map(([t, label, tip]) => {
        const b = this._btn(t, label, tip + ' (click again to remove)', () => this.toggleStyle(t), 'style');
        this.styleBtns[t] = b;
        return b;
      });
      this.opacityInput = h('input', { type: 'range', min: 5, max: 95, value: 45, title: 'Opacity of see-through surfaces', 'aria-label': 'See-through opacity' });
      this.opacityInput.addEventListener('input', () => this.viewer.setGlassOpacity(this.opacityInput.value / 100));
      this.opacityInput.addEventListener('change', () => this.log('opacity ' + (this.opacityInput.value / 100).toFixed(2)));
      const noStyle = this._btn('hide', 'No style', 'Remove every style from the selection', () => this.cmd('hide all' + this._scopeArg(), () => this.viewer.hide('all')));
      p.append(
        this._group('Style – click again to remove', ...styles, noStyle, h('label.slider.mini', { title: 'Opacity of see-through surfaces' }, h('span', 'see-through'), this.opacityInput)),
        this._group('Visibility',
          this._btn('isolate', 'Show only', 'Hide everything except the selection', () => this.cmd('isolate sele', () => this.viewer.isolate())),
          this._btn('showall', 'Show all', 'Make every chain and ligand visible again (not water)', () => this.cmd('showall', () => this.viewer.showEverything())))
      );
    }

    _buildColourPanel() {
      const p = this.panels.colour;
      const schemes = SCHEMES.map(([s, label, tip]) => this._btn(null, label, tip, () => this.cmd('color ' + s + this._scopeArg(), () => this.viewer.colorScheme(s)), 'scheme'));
      const sw = h('div.swatches');
      SWATCHES.forEach((name) => {
        const c = MG.NAMED_COLORS[name];
        const b = h('button.swatch', { type: 'button', title: name, 'aria-label': 'Colour ' + name, style: { background: c } });
        b.addEventListener('click', () => this.cmd('color ' + name + this._scopeArg(), () => this.viewer.colorUniform(c)));
        sw.appendChild(b);
      });
      const pick = h('input.colorpick', { type: 'color', value: '#1f77b4', title: 'Choose any colour' });
      pick.addEventListener('change', () => this.cmd('color ' + pick.value + this._scopeArg(), () => this.viewer.colorUniform(pick.value)));
      sw.appendChild(h('label.swatch.custom', { title: 'Custom colour' }, pick, h('span', '+')));
      p.append(this._group('Colour schemes', h('div.scheme-grid', ...schemes)), this._group('Single colour', sw));
    }

    _buildSelectPanel() {
      const p = this.panels.select;
      this.levelBtns = {};
      const lv = h('div.seg');
      [['atom', 'Atom'], ['residue', 'Residue'], ['chain', 'Chain / molecule']].forEach(([k, label]) => {
        const b = h('button', { type: 'button', text: label });
        b.addEventListener('click', () => {
          this.viewer.pickLevel = k;
          Object.values(this.levelBtns).forEach((x) => x.classList.remove('on'));
          b.classList.add('on');
        });
        this.levelBtns[k] = b;
        lv.appendChild(b);
      });
      this.levelBtns.residue.classList.add('on');
      this.boxBtn = this._btn('boxsel', 'Box select', 'Drag a rectangle over the molecule to select everything inside it', () => this.setBoxMode(!this.boxMode));
      this.findInput = h('input', { type: 'text', placeholder: 'e.g. C:126 · A:264-300 · LPS · ligand', spellcheck: 'false', size: 20, 'aria-label': 'Selection query' });
      const findForm = h('form.inline', h('span', 'Find'), this.findInput, h('button.btn.small', { type: 'submit', text: 'Select' }));
      findForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const q = this.findInput.value.trim();
        if (!q) return;
        this.cmd('select ' + q, () => {
          const m = this.viewer.resolve(q);
          if (!m.size) throw new Error('Nothing matches “' + q + '”');
          this.viewer.select(m, 'set');
        });
      });
      this.nearInput = h('input', { type: 'number', min: 2, max: 12, step: 0.5, value: 4.5, 'aria-label': 'Distance in Ångström', style: { width: '4.2em' } });
      p.append(
        this._group('Clicking picks a…', lv),
        this._group('Quick',
          this._btn('selectAll', 'All', 'Select everything that is visible', () => this.cmd('select all', () => this.viewer.select('all'))),
          this._btn('clear', 'Clear', 'Clear the selection (Esc)', () => this.cmd('select none', () => this.viewer.clearSelection())),
          this._btn('invert', 'Invert', 'Select everything that is not selected', () => this.cmd('select invert', () => this.viewer.invertSelection())),
          this.boxBtn),
        this._group('Find', findForm),
        this._group('Neighbours & binding sites',
          h('label.inline', h('span', 'Within'), this.nearInput, h('span', 'Å')),
          this._btn('target', 'Select nearby', 'Replace the selection with residues within this distance of it', () => this.selectNear()),
          this._btn('site', 'Binding site', 'Show residues around the selected ligand as sticks, with interactions', () => this.bindingSite(), 'accent'),
          this._btn('bonds', 'Interactions', 'Show hydrogen bonds, salt bridges and other contacts made by the selection', () => this.interactions()),
          this._btn('x', 'Hide interactions', 'Remove interaction lines', () => this.cmd('contacts off', () => this.viewer.hideInteractions())))
      );
      this.siteList = h('div.site-list', { hidden: true });
      p.appendChild(this.siteList);
    }

    _buildLabelsPanel() {
      const p = this.panels.labels;
      const A = () => this.annot;
      this.labelSize = h('select', { 'aria-label': 'Label size' }, ...[11, 13, 15, 18, 22, 28, 36].map((s) => h('option', { value: s, selected: s === 15 }, s + ' px')));
      this.labelColor = h('input', { type: 'color', value: '#111111', title: 'Label colour' });
      this.labelBg = h('select', { 'aria-label': 'Label background' }, h('option', { value: 'light' }, 'White box'), h('option', { value: 'none' }, 'No box'), h('option', { value: 'dark' }, 'Dark box'));
      this.labelBold = h('input', { type: 'checkbox', checked: true });
      const styleChange = () => A().applyStyleToSelected(this.labelStyle());
      [this.labelSize, this.labelColor, this.labelBg, this.labelBold].forEach((el) => el.addEventListener('change', styleChange));
      this.keyToggle = this._btn('key', 'Colour key', 'Show or hide the colour key (legend) on the image', () => this.cmd('key ' + (A().key.visible ? 'off' : 'on'), () => A().toggleKey()));
      p.append(
        this._group('Add labels',
          this._btn('tag', 'Label residues', 'Add a label to each selected residue (moves with the molecule)', () => this.cmd('label sele', () => A().labelSelection())),
          this._btn('text', '3D text…', 'Add your own text attached to the selection (moves with the molecule)', () => A().promptText3D()),
          this._btn('text', '2D text…', 'Add text fixed on the screen, e.g. a title (does not move)', () => A().promptText2D())),
        this._group('Draw (drag on the picture)',
          this._btn('arrow', 'Arrow', 'Drag on the picture to draw an arrow', () => A().startDraw('arrow')),
          this._btn('rect', 'Box', 'Drag to draw a box', () => A().startDraw('rect')),
          this._btn('ellipse', 'Ellipse', 'Drag to draw an ellipse', () => A().startDraw('ellipse'))),
        this._group('Style of new / selected labels',
          h('label.inline', h('span', 'Size'), this.labelSize),
          h('label.inline', h('span', 'Colour'), this.labelColor),
          h('label.inline', this.labelBg),
          h('label.inline', this.labelBold, h('span', 'Bold'))),
        this._group('Colour key',
          this.keyToggle,
          this._btn('reset', 'Rebuild key', 'Re-create the key from the colours currently on screen', () => this.cmd('key auto', () => A().rebuildKey(true))),
          this._btn('plus', 'Add entry', 'Add your own entry to the key', () => A().addKeyEntry())),
        this._group('Remove',
          this._btn('trash', 'Delete selected', 'Delete the selected label or shape (or press Delete)', () => A().deleteSelected()),
          this._btn('clear', 'Clear all', 'Remove all labels and shapes', () => this.cmd('labels clear', () => A().clearAll())))
      );
      p.appendChild(h('p.hint', 'Tip: drag labels to move them · double-click a label to edit its text · 3D labels stay attached to their residue when you rotate.'));
    }

    labelStyle() {
      return { size: +this.labelSize.value, color: this.labelColor.value, bg: this.labelBg.value, bold: this.labelBold.checked };
    }

    _buildMeasurePanel() {
      const p = this.panels.measure;
      this.measureBtn = this._btn('ruler', 'Measure distance', 'Then click two atoms', () => this.setMeasureMode(this.viewer.mode !== 'measure'), 'accent');
      this.distList = h('div.dist-list');
      p.append(
        this._group('Distances', this.measureBtn, this._btn('trash', 'Clear all', 'Remove every distance', () => this.cmd('distance clear', () => this.viewer.clearDistances()))),
        h('div.rgroup.grow', this.distList),
        h('div.rgroup.legend-mini',
          h('div.rgroup-title', 'Interaction lines'),
          h('div.mini-key', ...[['#2B83BA', 'Hydrogen bond'], ['#F0C814', 'Salt bridge (ionic)'], ['#808080', 'Hydrophobic'], ['#8CB366', 'π-stacking'], ['#FF8000', 'Cation–π'], ['#8C4099', 'Metal coordination']].map(([c, t]) => h('span', h('i', { style: { background: c } }), t))))
      );
    }

    _buildViewsPanel() {
      const p = this.panels.views;
      this.viewList = h('div.view-list');
      this.sessionInput = h('input', { type: 'file', accept: '.json', hidden: true });
      this.sessionInput.addEventListener('change', () => {
        const f = this.sessionInput.files[0];
        if (f) MG.session.open(f);
        this.sessionInput.value = '';
      });
      p.append(
        this._group('Saved views (like slides)',
          this._btn('camera', 'Save view', 'Remember the current picture: orientation, styles, colours and labels', () => this.saveView(), 'accent')),
        h('div.rgroup.grow', this.viewList),
        this._group('Session file',
          this._btn('save', 'Save session', 'Download everything (structures, styles, labels, views) to continue later', () => MG.session.save()),
          this._btn('folder', 'Open session', 'Open a session file saved earlier', () => this.sessionInput.click()),
          this.sessionInput)
      );
      this.renderViews();
    }

    _buildExportPanel() {
      const p = this.panels.export;
      this.expScale = h('select', { 'aria-label': 'Image size' }, h('option', { value: 1 }, 'Screen size'), h('option', { value: 2, selected: true }, '2× (reports)'), h('option', { value: 3 }, '3× (posters)'), h('option', { value: 4 }, '4× (print)'));
      this.expBg = h('select', { 'aria-label': 'Image background' }, h('option', { value: 'current' }, 'Current background'), h('option', { value: 'transparent' }, 'Transparent'));
      this.expAnn = h('input', { type: 'checkbox', checked: true });
      this.coordSel = h('select', { 'aria-label': 'Structure to download' });
      p.append(
        this._group('Picture',
          h('label.inline', h('span', 'Size'), this.expScale),
          h('label.inline', this.expBg),
          h('label.inline', this.expAnn, h('span', 'Include labels & key'))),
        this._group('Save',
          this._btn('download', 'Download PNG', 'Save the picture as a PNG file', () => this.exportPNG(), 'accent'),
          this._btn('copy', 'Copy image', 'Copy the picture so you can paste it into Word or PowerPoint', () => this.copyPNG())),
        this._group('Coordinates (for ICM, PyMOL, ChimeraX…)',
          this.coordSel,
          this._btn('download', '.pdb file', 'Download the coordinates as shown (including any superposition) in PDB format', () => this.downloadCoords()))
      );
    }

    /* ------------------------------------------------------------ */
    _wire() {
      const V = this.viewer;
      this.loadForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const id = this.pdbInput.value.trim();
        if (id) this.run('load ' + id);
      });
      this.afBtn.addEventListener('click', () => {
        const acc = this.afInput.value.trim();
        if (acc) this.run('load af ' + acc);
      });
      this.afInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.afBtn.click();
        }
      });
      this.fileBtn.addEventListener('click', () => this.fileInput.click());
      this.fileInput.addEventListener('change', async () => {
        const f = this.fileInput.files[0];
        this.fileInput.value = '';
        if (!f) return;
        try {
          const st = await V.loadFile(f);
          this.log('# opened file ' + f.name);
          toast(`Opened <b>${esc(f.name)}</b>`);
          return st;
        } catch (e) {
          toast(esc(e.message), 'error');
        }
      });
      // drag & drop files onto the viewer
      this.root.addEventListener('dragover', (e) => {
        if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
          e.preventDefault();
          this.root.classList.add('dropping');
        }
      });
      this.root.addEventListener('dragleave', () => this.root.classList.remove('dropping'));
      this.root.addEventListener('drop', async (e) => {
        this.root.classList.remove('dropping');
        const f = e.dataTransfer && e.dataTransfer.files[0];
        if (!f) return;
        e.preventDefault();
        if (/\.json$/i.test(f.name)) return MG.session.open(f);
        try {
          await V.loadFile(f);
          this.log('# opened file ' + f.name);
        } catch (err) {
          toast(esc(err.message), 'error');
        }
      });

      const tb = this.consoleEl.querySelector('.v-console-toggle');
      tb.addEventListener('click', () => this.consoleEl.classList.toggle('collapsed'));
      this.consoleEl.querySelector('form').addEventListener('submit', (e) => {
        e.preventDefault();
        const t = this.consoleInput.value.trim();
        if (!t) return;
        this.history = this.history || [];
        this.history.push(t);
        this.histIdx = this.history.length;
        this.consoleInput.value = '';
        this.run(t, { echo: true });
      });
      this.consoleInput.addEventListener('keydown', (e) => {
        if (!this.history || !this.history.length) return;
        if (e.key === 'ArrowUp') {
          this.histIdx = Math.max(0, this.histIdx - 1);
          this.consoleInput.value = this.history[this.histIdx] || '';
          e.preventDefault();
        } else if (e.key === 'ArrowDown') {
          this.histIdx = Math.min(this.history.length, this.histIdx + 1);
          this.consoleInput.value = this.history[this.histIdx] || '';
          e.preventDefault();
        }
      });

      bus.on('viewer:busy', (d) => {
        this.busyEl.hidden = !d.on;
        if (d.text) this.busyEl.querySelector('span').textContent = d.text;
      });
      bus.on('viewer:changed', (d) => {
        if (d.what === 'structures' || d.what === 'display' || d.what === 'state') {
          this.renderTree();
          this.renderEmpty();
          this.renderCoordSel();
        }
        if (d.what === 'structures') this.renderSeq();
        if (d.what === 'distances') this.renderDistances();
        this.updateStyleButtons();
      });
      bus.on('viewer:selection', () => {
        this.renderScope();
        this.renderSeqSelection();
        this.renderTreeSelection();
        this.updateStyleButtons();
      });
      bus.on('viewer:hover', (d) => this.showTip(d));
      bus.on('viewer:loaded', (d) => {
        const st = d.st;
        this.expanded.add(st.uid);
        if (!this.seqChain || !V.structures.includes(this.seqChain.st)) this.seqChain = st.chains[0] ? { st, chain: st.chains[0].name } : null;
        this.renderSeq();
        this.renderTree();
        this.renderEmpty();
        this.renderCoordSel();
      });
      bus.on('viewer:removed', () => {
        if (this.seqChain && !V.structures.includes(this.seqChain.st)) {
          const st = V.structures[0];
          this.seqChain = st && st.chains[0] ? { st, chain: st.chains[0].name } : null;
        }
        this.renderSeq();
        this.renderCoordSel();
      });
      bus.on('viewer:measure', (d) => {
        toast('Distance: <b>' + esc(d.text) + '</b>');
        this.log('# distance ' + d.text);
        this.modeEl.textContent = 'Measuring: click the first atom of the next distance · Esc to stop';
        this.renderDistances();
      });
      bus.on('viewer:measure-pending', (d) => {
        this.modeEl.textContent = d.atom ? 'First atom: ' + d.atom + ' · now click the second atom' : 'Measuring: click two atoms · Esc to stop';
      });

      document.addEventListener('keydown', (e) => {
        if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
        if (e.target && e.target.isContentEditable) return;
        if (!this.root.offsetParent) return; // viewer not visible
        if (e.key === 'Escape') {
          if (this.annot.drawing) this.annot.cancelDraw();
          else if (this.boxMode) this.setBoxMode(false);
          else if (V.mode === 'measure') this.setMeasureMode(false);
          else if (this.annot.selected) this.annot.select(null);
          else if (V.hasSelection()) this.run('select none');
        } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.annot.selected) {
          e.preventDefault();
          this.annot.deleteSelected();
        }
      });

      this._wireBoxSelect();
    }

    /* ---------------- tabs & scope ---------------- */
    showTab(id) {
      Object.entries(this.tabs).forEach(([k, b]) => {
        b.classList.toggle('on', k === id);
        b.setAttribute('aria-selected', k === id ? 'true' : 'false');
      });
      Object.entries(this.panels).forEach(([k, p]) => (p.hidden = k !== id));
      this.currentTab = id;
      if (id !== 'measure' && this.viewer && this.viewer.mode === 'measure') this.setMeasureMode(false);
    }

    renderScope() {
      const info = this.viewer ? this.viewer.selectionInfo() : { count: 0 };
      this.scopeEl.innerHTML = '';
      if (info.count) {
        this.scopeEl.classList.add('has-sel');
        const counted = /residues?$/.test(info.text || '');
        const b = h('button.linkbtn', { type: 'button', html: I('x') + 'Clear' });
        b.addEventListener('click', () => this.run('select none'));
        this.scopeEl.append(
          h('span.scope-dot'),
          h('span.scope-text', 'Selected: ', h('b', { title: info.text }, info.text || info.count + ' atoms'),
            h('span.muted', (counted ? '' : ` (${info.residues} residue${info.residues === 1 ? '' : 's'})`) + ' – styles and colours apply to this')),
          b
        );
      } else {
        this.scopeEl.classList.remove('has-sel');
        this.scopeEl.append(h('span.scope-dot.none'), h('span.scope-text', 'Nothing selected – styles and colours apply to ', h('b', 'everything'), h('span.muted', '. Click the molecule, a Workspace name or the sequence to select part of it.')));
      }
    }
    _scopeArg() {
      return this.viewer.hasSelection() ? ' sele' : '';
    }
    updateStyleButtons() {
      if (!this.styleBtns) return;
      const V = this.viewer;
      if (!V.structures.length) {
        Object.values(this.styleBtns).forEach((b) => b.classList.remove('on', 'part'));
        return;
      }
      const m = V.target();
      Object.entries(this.styleBtns).forEach(([t, b]) => {
        const f = V.styleCoverage(t, m);
        b.classList.toggle('on', f > 0.999);
        b.classList.toggle('part', f > 0 && f <= 0.999);
      });
    }

    /* ---------------- commands & log ---------------- */
    log(text, kind) {
      const line = h('div.cl' + (kind ? '.' + kind : ''), text);
      this.consoleLog.appendChild(line);
      while (this.consoleLog.childNodes.length > 300) this.consoleLog.firstChild.remove();
      this.consoleLog.scrollTop = this.consoleLog.scrollHeight;
    }
    /** run a UI action and write its command-line equivalent */
    cmd(text, fn) {
      try {
        const r = fn();
        this.log(text);
        return r;
      } catch (e) {
        toast(esc(e.message), 'error');
        this.log(text, 'err');
        this.log('  ' + e.message, 'err');
      }
    }
    async run(text, opts = {}) {
      return MG.commands.run(text, opts);
    }

    /* ---------------- display actions ---------------- */
    toggleStyle(t) {
      const V = this.viewer;
      if (!V.structures.length) return toast('Load a structure first.', 'warn');
      const f = V.styleCoverage(t, V.target());
      if (f > 0.999) this.cmd('hide ' + t + this._scopeArg(), () => V.hide(t));
      else this.cmd('show ' + t + this._scopeArg(), () => V.show(t));
    }

    cycleBackground() {
      const order = ['white', 'black', 'grey'];
      const next = order[(order.indexOf(this.viewer.bg) + 1) % order.length];
      this.cmd('background ' + next, () => this.viewer.setBackground(next));
      this.root.classList.toggle('dark-bg', next !== 'white');
      this.viewer.structures.forEach((st) => this.viewer._syncDistances(st));
      this.annot.render();
    }

    fullscreen() {
      const el = this.root;
      if (document.fullscreenElement) document.exitFullscreen();
      else if (el.requestFullscreen) el.requestFullscreen().catch(() => toast('Full screen is not available here.', 'warn'));
    }

    showHelp() {
      MG.modal('Viewer controls', `
        <table class="helptable">
          <tr><th>Rotate</th><td>Left-drag (or one-finger drag)</td></tr>
          <tr><th>Move (translate)</th><td>Right-drag, or Ctrl/⌘ + left-drag (two-finger drag on touch screens)</td></tr>
          <tr><th>Zoom</th><td>Scroll wheel / trackpad pinch, or Shift + left-drag</td></tr>
          <tr><th>Rotate in the screen plane</th><td>Ctrl + right-drag</td></tr>
          <tr><th>Select</th><td>Click an atom (Shift-click adds, Ctrl/⌘-click toggles). Or click names in the workspace or letters in the sequence bar</td></tr>
          <tr><th>Centre on a residue</th><td>Double-click it · or use ${I('target')} to centre on the selection</td></tr>
          <tr><th>Clear selection</th><td>Esc</td></tr>
          <tr><th>Box select</th><td>Select tab → Box select, then drag a rectangle</td></tr>
        </table>
        <p>Styles and colours are applied to the <b>current selection</b> – or to everything when nothing is selected. The bar above the picture always tells you which.</p>
        <p>Every button writes an equivalent command in the <b>Command line</b> at the bottom. Type <code>help</code> there to see all commands.</p>`);
    }

    /* ---------------- selection helpers ---------------- */
    selectNear() {
      const V = this.viewer;
      if (!V.hasSelection()) return toast('Select something first (e.g. click a ligand).', 'warn');
      const d = parseFloat(this.nearInput.value) || 4.5;
      this.cmd('select near sele ' + d, () => {
        const near = V.near(V.selectionMap(), d);
        if (!near.size) throw new Error('Nothing within ' + d + ' Å');
        V.select(near, 'set');
      });
    }
    bindingSite() {
      const V = this.viewer;
      if (!V.hasSelection()) return toast('First select a ligand – e.g. click LPS in the workspace.', 'warn');
      const d = parseFloat(this.nearInput.value) || 4.5;
      const target = V.selectionMap();
      const res = this.cmd('site sele ' + d, () => V.bindingSite(target, d));
      if (res) this.showSiteList(res, d);
    }
    interactions() {
      const V = this.viewer;
      if (!V.hasSelection()) return toast('Select a ligand or residues first.', 'warn');
      this.cmd('contacts sele', () => V.showInteractions(V.selectionMap()));
    }
    showSiteList(list, d) {
      const el = this.siteList;
      el.innerHTML = '';
      if (!list || !list.length) {
        el.hidden = true;
        return;
      }
      el.hidden = false;
      const close = h('button.linkbtn', { type: 'button', html: I('x') + 'close' });
      close.addEventListener('click', () => (el.hidden = true));
      el.append(h('div.site-h', h('b', list.length + ' residues within ' + d + ' Å'), h('span.muted', ' – click one to centre on it'), close));
      const wrap = h('div.site-items');
      list.forEach((x) => {
        const b = h('button.chip', { type: 'button', title: 'Closest approach ' + x.dist.toFixed(1) + ' Å' }, x.name, h('small', ' ' + x.dist.toFixed(1) + ' Å'));
        b.addEventListener('click', () => {
          const r = x.residue;
          const idx = [];
          for (let a = r.a0; a < r.a0 + r.na; a++) idx.push(a);
          this.viewer.centerOn(idx, x.st);
          this.viewer.select(new Map([[x.st, idx]]), 'set');
        });
        wrap.appendChild(b);
      });
      el.appendChild(wrap);
    }

    setBoxMode(on) {
      this.boxMode = on;
      this.boxEl.hidden = !on;
      this.boxBtn.classList.toggle('on', on);
      this.modeEl.hidden = !on;
      if (on) {
        if (this.viewer.mode === 'measure') this.setMeasureMode(false);
        this.modeEl.textContent = 'Box select: drag a rectangle (Shift adds to the selection) · Esc to stop';
      }
    }
    _wireBoxSelect() {
      let start = null;
      const el = this.boxEl;
      const pos = (e) => {
        const r = el.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
      };
      el.addEventListener('pointerdown', (e) => {
        start = pos(e);
        start.add = e.shiftKey || e.ctrlKey || e.metaKey;
        el.setPointerCapture(e.pointerId);
        Object.assign(this.boxRect.style, { left: start.x + 'px', top: start.y + 'px', width: '0px', height: '0px', display: 'block' });
      });
      el.addEventListener('pointermove', (e) => {
        if (!start) return;
        const p = pos(e);
        Object.assign(this.boxRect.style, {
          left: Math.min(p.x, start.x) + 'px', top: Math.min(p.y, start.y) + 'px',
          width: Math.abs(p.x - start.x) + 'px', height: Math.abs(p.y - start.y) + 'px'
        });
      });
      el.addEventListener('pointerup', (e) => {
        if (!start) return;
        const p = pos(e);
        const x0 = Math.min(p.x, start.x), x1 = Math.max(p.x, start.x), y0 = Math.min(p.y, start.y), y1 = Math.max(p.y, start.y);
        const add = start.add;
        start = null;
        this.boxRect.style.display = 'none';
        if (x1 - x0 < 4 || y1 - y0 < 4) return;
        this.boxSelect(x0, y0, x1, y1, add);
      });
    }
    boxSelect(x0, y0, x1, y1, add) {
      const V = this.viewer;
      const m = new Map();
      V.structures.forEach((st) => {
        if (!st.visible) return;
        const X = st.s.atomStore.x, Y = st.s.atomStore.y, Z = st.s.atomStore.z;
        const shown = new Uint8Array(st.n);
        MG.REP_TYPES.forEach((t) => {
          const mk = st.masks[t];
          for (let i = 0; i < st.n; i++) if (mk[i]) shown[i] = 1;
        });
        const resHit = new Set();
        for (let i = 0; i < st.n; i++) {
          if (!shown[i] || st.hidden[i]) continue;
          const p = V.project([X[i], Y[i], Z[i]]);
          if (p && p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) resHit.add(st.atomRes[i]);
        }
        if (!resHit.size) return;
        const idx = [];
        resHit.forEach((ri) => {
          const r = st.residues[ri];
          if (V.pickLevel === 'atom') return;
          for (let a = r.a0; a < r.a0 + r.na; a++) idx.push(a);
        });
        if (V.pickLevel === 'atom') {
          for (let i = 0; i < st.n; i++) {
            if (!shown[i] || st.hidden[i]) continue;
            const p = V.project([X[i], Y[i], Z[i]]);
            if (p && p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) idx.push(i);
          }
        }
        if (idx.length) m.set(st, idx);
      });
      if (!m.size) return toast('Nothing visible inside the box.', 'warn');
      V.select(m, add ? 'add' : 'set');
      const info = V.selectionInfo();
      this.log('# box select → ' + info.text);
      bus.emit('viewer:boxselect', { count: info.residues });
    }

    setMeasureMode(on) {
      const V = this.viewer;
      V.mode = on ? 'measure' : 'pick';
      V._measurePending = null;
      this.measureBtn.classList.toggle('on', on);
      this.modeEl.hidden = !on;
      if (on) {
        if (this.boxMode) this.setBoxMode(false);
        this.modeEl.textContent = 'Measuring: click two atoms · Esc to stop';
        if (this.currentTab !== 'measure') this.showTab('measure');
      }
    }
    renderDistances() {
      const el = this.distList;
      if (!el) return;
      el.innerHTML = '';
      const V = this.viewer;
      let k = 0;
      V.structures.forEach((st) => {
        st.distances.forEach((d, i) => {
          k++;
          const del = h('button.icon-btn', { type: 'button', title: 'Delete', html: I('x') });
          del.addEventListener('click', () => V.removeDistance(st, i));
          el.appendChild(h('div.dist-row', h('span', `${V._atomLabel(st, d.a)} ↔ ${V._atomLabel(st, d.b)}`), h('b', d.d.toFixed(2) + ' Å'), del));
        });
      });
      if (!k) el.appendChild(h('p.hint', 'No distances yet. Press “Measure distance”, then click two atoms. Tip: show the residues as sticks first so you can pick individual atoms.'));
    }

    /* ---------------- tooltip ---------------- */
    showTip(d) {
      const tip = this.tipEl;
      if (!d || !d.info || !d.pos) {
        tip.hidden = true;
        return;
      }
      tip.innerHTML = '';
      tip.append(h('b', d.info.text));
      if (d.info.sub) tip.append(h('div', d.info.sub));
      if (d.info.extra) tip.append(h('div.x', d.info.extra));
      tip.hidden = false;
      const W = this.stageWrap.clientWidth, H = this.stageWrap.clientHeight;
      const x = d.pos.x, y = H - d.pos.y;
      tip.style.left = Math.min(W - tip.offsetWidth - 6, x + 14) + 'px';
      tip.style.top = Math.max(4, Math.min(H - tip.offsetHeight - 4, y + 14)) + 'px';
    }

    renderEmpty() {
      const has = this.viewer && this.viewer.structures.length;
      this.emptyEl.hidden = !!has;
      if (!has) {
        this.emptyEl.innerHTML = `<div>${I('cube')}<h3>No structure loaded</h3><p>Type a PDB ID above (try <button type="button" class="linkbtn" data-load="3FXI">3FXI</button>) or press a <span class="kbd">▶</span> button in the tutorial.</p></div>`;
        const b = this.emptyEl.querySelector('[data-load]');
        if (b) b.addEventListener('click', () => this.run('load ' + b.dataset.load));
      }
    }

    /* ---------------- workspace tree ---------------- */
    renderTree() {
      const V = this.viewer;
      const T = this.treeEl;
      T.innerHTML = '';
      if (!V || !V.structures.length) {
        T.appendChild(h('p.hint', 'Loaded structures appear here, with their chains and ligands.'));
        return;
      }
      V.structures.forEach((st) => {
        const open = this.expanded.has(st.uid);
        const eye = this._eye(st.visible, () => {
          V.setStructureVisible(st, !st.visible);
          this.log((st.visible ? 'enable ' : 'disable ') + st.name);
        });
        const tw = h('button.tw', { type: 'button', 'aria-label': open ? 'Collapse' : 'Expand', html: I(open ? 'chevD' : 'chevR') });
        tw.addEventListener('click', () => {
          if (open) this.expanded.delete(st.uid);
          else this.expanded.add(st.uid);
          this.renderTree();
        });
        const menu = h('button.icon-btn', { type: 'button', title: 'More…', html: I('dots') });
        menu.addEventListener('click', (e) => this.structureMenu(st, e.currentTarget));
        const kindBadge = st.kind === 'alphafold' ? h('span.badge.af', { title: 'AlphaFold predicted model' }, 'AF') : st.kind === 'pdb' ? h('span.badge.pdb', { title: 'Experimental structure from the PDB' }, 'PDB') : h('span.badge', 'file');
        const name = h('button.tn-name', { type: 'button', title: 'Click to select all of ' + st.name + ' · double-click to centre' }, h('b', st.name), kindBadge);
        name.addEventListener('click', (e) => this._treeSelect(st, Array.from({ length: st.n }, (_, i) => i), e, st.name));
        name.addEventListener('dblclick', () => V.centerOn(Array.from({ length: st.n }, (_, i) => i), st));
        const row = h('div.tn.tn-st' + (st.visible ? '' : '.off'), tw, name, eye, menu);
        T.appendChild(row);
        if (st.title) T.appendChild(h('div.tn-title', { title: st.title }, st.title));
        if (!open) return;
        st.chains.forEach((c) => T.appendChild(this._chainRow(st, c)));
        st.groups.forEach((g) => T.appendChild(this._groupRow(st, g)));
      });
      this.renderTreeSelection();
    }
    _eye(on, fn, partial) {
      const b = h('button.eye' + (on ? '' : '.off') + (partial ? '.part' : ''), { type: 'button', title: on ? 'Hide' : 'Show', 'aria-label': on ? 'Hide' : 'Show', html: I(on ? 'eye' : 'eyeOff') });
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
      return b;
    }
    _chainRow(st, c) {
      const V = this.viewer;
      const vf = V.visibleFraction(st, c.atoms);
      const eye = this._eye(vf > 0, () => {
        const on = vf === 0;
        V.setVisible(new Map([[st, Array.from(c.atoms)]]), on);
        this.log((on ? 'display ' : 'undisplay ') + (V.structures.length > 1 ? st.name + ' ' : '') + c.name);
      }, vf > 0 && vf < 1);
      const seqBtn = h('button.tw', { type: 'button', title: 'Show this sequence in the sequence bar', html: I('chevR') });
      seqBtn.addEventListener('click', () => {
        this.seqChain = { st, chain: c.name };
        this.renderSeq();
        this.seqEl.classList.add('flash');
        setTimeout(() => this.seqEl.classList.remove('flash'), 700);
      });
      const nm = h('button.tn-name', { type: 'button', title: `Chain ${c.name}: ${c.label} – ${c.residues.length} residues (${c.first}–${c.last}). Click to select, double-click to centre.` },
        h('span.chip-chain', { style: { background: MG.toHex(c.color) } }, c.name),
        h('span.tn-label.two', h('span', c.nice || c.label), c.nice ? h('small.sub', c.label) : null),
        h('small', c.residues.length + (c.type === 'nucleic' ? ' nt' : ' aa')));
      nm.addEventListener('click', (e) => this._treeSelect(st, Array.from(c.atoms), e, (V.structures.length > 1 ? st.name + ' ' : '') + c.name));
      nm.addEventListener('dblclick', () => V.centerOn(Array.from(c.atoms), st));
      const row = h('div.tn.tn-chain' + (vf === 0 ? '.off' : ''), { dataset: { key: st.uid + ':c:' + c.name } }, seqBtn, nm, eye);
      return row;
    }
    _groupRow(st, g) {
      const V = this.viewer;
      const vf = V.visibleFraction(st, g.atoms);
      const eye = this._eye(vf > 0, () => {
        const on = vf === 0;
        V.setVisible(new Map([[st, Array.from(g.atoms)]]), on);
        this.log((on ? 'display ' : 'undisplay ') + g.short);
      }, vf > 0 && vf < 1);
      const key = st.uid + ':g:' + g.id;
      const open = this.expanded.has(key);
      const tw = h('button.tw', { type: 'button', title: 'List the individual pieces', html: I(open ? 'chevD' : 'chevR') });
      tw.addEventListener('click', () => {
        if (open) this.expanded.delete(key);
        else this.expanded.add(key);
        this.renderTree();
      });
      const kindIcon = { ligand: '◆', sugar: '⬡', ion: '●', water: '💧' }[g.kind] || '◆';
      const nm = h('button.tn-name', { type: 'button', title: (g.desc ? g.desc + ' – ' : '') + 'click to select, double-click to centre' },
        h('span.kind.' + g.kind, kindIcon),
        h('span.tn-label', g.name),
        h('small', '×' + g.res.length));
      nm.addEventListener('click', (e) => this._treeSelect(st, Array.from(g.atoms), e, g.short));
      nm.addEventListener('dblclick', () => V.centerOn(Array.from(g.atoms), st));
      const frag = document.createDocumentFragment();
      frag.appendChild(h('div.tn.tn-group' + (vf === 0 ? '.off' : ''), { dataset: { key } }, tw, nm, eye));
      if (g.desc && g.preset) frag.appendChild(h('div.tn-desc', g.desc));
      if (open) {
        const list = h('div.tn-items');
        g.res.slice(0, 200).forEach((ri) => {
          const r = st.residues[ri];
          const b = h('button.chip.small', { type: 'button', title: 'Select and centre' }, `${r.resname} ${r.chain}${r.resno}`);
          b.addEventListener('click', (e) => {
            const idx = [];
            for (let a = r.a0; a < r.a0 + r.na; a++) idx.push(a);
            this._treeSelect(st, idx, e, `${st.name} ${r.chain}:${r.resno}`);
            V.centerOn(idx, st);
          });
          list.appendChild(b);
        });
        if (g.res.length > 200) list.appendChild(h('small', '… and ' + (g.res.length - 200) + ' more'));
        frag.appendChild(list);
      }
      return frag;
    }
    _treeSelect(st, idx, e, label) {
      const V = this.viewer;
      const m = new Map([[st, idx]]);
      const mode = e && (e.ctrlKey || e.metaKey) ? 'toggle' : e && e.shiftKey ? 'add' : 'set';
      V.select(m, mode);
      this.log('select ' + (mode === 'set' ? '' : mode + ' ') + label);
    }
    renderTreeSelection() {
      const V = this.viewer;
      if (!V) return;
      this.treeEl.querySelectorAll('.tn[data-key]').forEach((row) => {
        const [uid, kind, id] = row.dataset.key.split(':');
        const st = V.structures.find((s) => String(s.uid) === uid);
        if (!st) return;
        let atoms;
        if (kind === 'c') atoms = (st.chains.find((c) => c.name === id) || {}).atoms;
        else atoms = (st.groups.find((g) => g.id === id) || {}).atoms;
        if (!atoms) return;
        let k = 0;
        for (let i = 0; i < atoms.length; i++) if (st.sel[atoms[i]]) k++;
        row.classList.toggle('sel', k > 0 && k === atoms.length);
        row.classList.toggle('psel', k > 0 && k < atoms.length);
      });
    }
    structureMenu(st, anchor) {
      const V = this.viewer;
      const items = [
        ['target', 'Centre on it', () => V.centerOn(Array.from({ length: st.n }, (_, i) => i), st)],
        ['isolate', 'Show only this structure', () => V.structures.forEach((s) => V.setStructureVisible(s, s === st))],
        ['showall', 'Show all its chains & ligands', () => V.showEverything(st)],
        ['info', 'About this entry', () => this.structureInfo(st)],
        ['trash', 'Remove from workspace', () => {
          V.remove(st);
          this.log('remove ' + st.name);
        }]
      ];
      MG.popmenu(anchor, items);
    }
    structureInfo(st) {
      const hd = st.header || {};
      const rows = [];
      rows.push(['Name', st.name]);
      if (st.title) rows.push(['Title', st.title]);
      if (st.kind === 'alphafold' && st.af) {
        rows.push(['Type', 'Predicted model (AlphaFold DB) – not an experimental structure']);
        rows.push(['Protein', `${st.af.uniprotDescription || ''} (${st.af.uniprotAccession}, ${st.af.organismScientificName || ''})`]);
        if (st.af.globalMetricValue) rows.push(['Mean pLDDT', st.af.globalMetricValue.toFixed(1)]);
        if (st.af.latestVersion) rows.push(['Model version', 'v' + st.af.latestVersion]);
      } else {
        if (hd.experimentalMethods && hd.experimentalMethods.length) rows.push(['Method', hd.experimentalMethods.join(', ')]);
        if (hd.resolution) rows.push(['Resolution', hd.resolution.toFixed(2) + ' Å']);
        if (hd.releaseDate) rows.push(['Released', hd.releaseDate]);
      }
      rows.push(['Chains', st.chains.map((c) => `${c.name}: ${c.label} (${c.first}–${c.last})`).join('<br>')]);
      if (st.groups.length) rows.push(['Other components', st.groups.map((g) => `${esc(g.name)} ×${g.res.length}`).join(', ')]);
      rows.push(['Atoms', st.n.toLocaleString()]);
      if (st.bundled) rows.push(['Data', 'Copy stored with this tutorial (so the tutorial always matches)']);
      else if (st.url) rows.push(['Data', `<a href="${esc(st.url)}" target="_blank" rel="noopener">${esc(st.url)}</a>`]);
      let links = '';
      if (st.kind === 'pdb') links = `<p><a href="https://www.rcsb.org/structure/${st.source.id}" target="_blank" rel="noopener">Open ${st.source.id} at RCSB PDB ↗</a> · <a href="https://www.ebi.ac.uk/pdbe/entry/pdb/${st.source.id.toLowerCase()}" target="_blank" rel="noopener">PDBe ↗</a></p>`;
      if (st.kind === 'alphafold') links = `<p><a href="https://alphafold.ebi.ac.uk/entry/${st.source.acc}" target="_blank" rel="noopener">Open at AlphaFold DB ↗</a></p>`;
      MG.modal(st.name, '<table class="infotable">' + rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${k === 'Chains' || k === 'Data' || k === 'Other components' ? v : esc(v)}</td></tr>`).join('') + '</table>' + links);
    }

    /* ---------------- sequence bar ---------------- */
    renderSeq() {
      const V = this.viewer;
      const el = this.seqEl;
      el.innerHTML = '';
      const polyChains = [];
      V.structures.forEach((st) => st.chains.forEach((c) => polyChains.push({ st, c })));
      if (!polyChains.length) {
        el.appendChild(h('div.seq-empty', 'Sequence of the selected chain appears here'));
        return;
      }
      if (!this.seqChain || !V.structures.includes(this.seqChain.st) || !this.seqChain.st.chains.find((c) => c.name === this.seqChain.chain)) {
        this.seqChain = { st: polyChains[0].st, chain: polyChains[0].c.name };
      }
      const sel = h('select.seq-chain', { 'aria-label': 'Chain shown in the sequence bar' });
      polyChains.forEach(({ st, c }) => {
        const o = h('option', { value: st.uid + '|' + c.name }, `${V.structures.length > 1 ? st.name + ' ' : ''}${c.name} · ${c.nice || c.label}`.slice(0, 48));
        if (st === this.seqChain.st && c.name === this.seqChain.chain) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', () => {
        const [uid, name] = sel.value.split('|');
        this.seqChain = { st: V.structures.find((s) => String(s.uid) === uid), chain: name };
        this.renderSeq();
      });
      const st = this.seqChain.st;
      const c = st.chains.find((x) => x.name === this.seqChain.chain);
      const track = h('div.seq-track');
      let prevNo = null;
      const cells = [];
      c.residues.forEach((ri) => {
        const r = st.residues[ri];
        if (prevNo !== null && r.resno > prevNo + 1) {
          const gap = r.resno - prevNo - 1;
          track.appendChild(h('span.seq-gap', { title: gap + ' residue' + (gap > 1 ? 's' : '') + ' missing from the model (not seen in the experiment)' }, '⋯'));
        }
        prevNo = r.resno;
        const cell = h('span.seq-res.ss-' + r.ss, { dataset: { ri: ri }, title: `${MG.niceRes(r.resname)} ${r.resno}${r.ins}` + (st.kind === 'alphafold' ? ` · pLDDT ${r.bf.toFixed(0)}` : '') }, r.one);
        if (r.resno % 10 === 0) cell.appendChild(h('i.seq-num', String(r.resno)));
        if (st.kind === 'alphafold') cell.style.setProperty('--pl', MG.toHex(MG.plddtColor(r.bf)));
        cells.push(cell);
        track.appendChild(cell);
      });
      // drag selection
      let anchor = null, mode = 'set';
      const riOf = (t) => (t && t.dataset && t.dataset.ri !== undefined ? +t.dataset.ri : null);
      const apply = (a, b, final) => {
        const lo = Math.min(a, b), hi = Math.max(a, b);
        const idx = [];
        c.residues.forEach((ri) => {
          if (ri >= lo && ri <= hi) {
            const r = st.residues[ri];
            for (let x = r.a0; x < r.a0 + r.na; x++) idx.push(x);
          }
        });
        V.select(new Map([[st, idx]]), mode === 'set' ? 'set' : mode);
        if (final) {
          const r1 = st.residues[lo], r2 = st.residues[hi];
          this.log(`select ${mode === 'set' ? '' : mode + ' '}${V.structures.length > 1 ? st.name + ' ' : ''}${c.name}:${r1.resno}${r1 !== r2 ? '-' + r2.resno : ''}`);
          bus.emit('viewer:seqselect', { chain: c.name, from: r1.resno, to: r2.resno, n: hi - lo + 1 });
        }
      };
      track.addEventListener('pointerdown', (e) => {
        const ri = riOf(e.target.closest('.seq-res'));
        if (ri === null) return;
        e.preventDefault();
        anchor = ri;
        mode = e.shiftKey ? 'add' : e.ctrlKey || e.metaKey ? 'toggle' : 'set';
        if (mode === 'toggle') mode = 'add';
        track.setPointerCapture(e.pointerId);
        apply(anchor, anchor, false);
      });
      track.addEventListener('pointermove', (e) => {
        if (anchor === null) return;
        const t = document.elementFromPoint(e.clientX, e.clientY);
        const ri = riOf(t && t.closest && t.closest('.seq-res'));
        if (ri !== null) apply(anchor, ri, false);
      });
      const end = (e) => {
        if (anchor === null) return;
        const t = document.elementFromPoint(e.clientX, e.clientY);
        const ri = riOf(t && t.closest && t.closest('.seq-res'));
        apply(anchor, ri !== null ? ri : anchor, true);
        anchor = null;
      };
      track.addEventListener('pointerup', end);
      track.addEventListener('pointercancel', () => (anchor = null));
      track.addEventListener('dblclick', (e) => {
        const ri = riOf(e.target.closest('.seq-res'));
        if (ri === null) return;
        const r = st.residues[ri];
        const idx = [];
        for (let x = r.a0; x < r.a0 + r.na; x++) idx.push(x);
        V.centerOn(idx, st);
      });
      const legend = h('div.seq-legend',
        h('span.ss-helix', 'helix'), h('span.ss-strand', 'strand'),
        h('span.muted', `${c.first}–${c.last} · ⋯ = missing residues`));
      el.append(h('div.seq-head', sel, legend), h('div.seq-scroll', track));
      this._seqCells = cells;
      this._seqSt = st;
      this.renderSeqSelection();
    }
    renderSeqSelection() {
      if (!this._seqCells || !this._seqSt) return;
      const st = this._seqSt;
      this._seqCells.forEach((cell) => {
        const r = st.residues[+cell.dataset.ri];
        let on = false;
        for (let a = r.a0; a < r.a0 + r.na; a++) if (st.sel[a]) { on = true; break; }
        cell.classList.toggle('sel', on);
      });
    }

    /* ---------------- views (slides) ---------------- */
    async saveView(name) {
      const V = this.viewer;
      if (!V.structures.length) return toast('Load a structure first.', 'warn');
      const state = V.getState({ noSelection: true });
      const ann = this.annot.getState();
      let thumb = '';
      try {
        const blob = await V.renderImage({ factor: 1 });
        thumb = await MG.thumbnail(blob, 160);
      } catch (e) {
        thumb = '';
      }
      const v = { name: name || 'View ' + (this.views.length + 1), state, ann, thumb, structures: V.structures.map((s) => s.name) };
      this.views.push(v);
      this.renderViews();
      this.log('view save "' + v.name + '"');
      toast('Saved <b>' + esc(v.name) + '</b> – find it in the Views tab.');
      bus.emit('viewer:view-saved', { count: this.views.length });
      return v;
    }
    restoreView(k) {
      const v = this.views[k];
      if (!v) return;
      const V = this.viewer;
      const missing = v.structures.filter((n) => !V.structures.find((s) => s.name === n));
      if (missing.length) {
        toast('This view needs ' + missing.join(', ') + ' – load it first.', 'warn');
        return;
      }
      V.setState(v.state);
      this.annot.setState(v.ann);
      this.log('view ' + (k + 1));
      bus.emit('viewer:view-restored', { k });
    }
    renderViews() {
      const el = this.viewList;
      if (!el) return;
      el.innerHTML = '';
      if (!this.views.length) {
        el.appendChild(h('p.hint', 'Saved views appear here as thumbnails – click one to go back to it. Like ICM “slides”, they let you flip between pictures.'));
        return;
      }
      this.views.forEach((v, k) => {
        const img = v.thumb ? h('img', { src: v.thumb, alt: '' }) : h('div.noimg', I('image'));
        const b = h('button.view-card', { type: 'button', title: 'Go to this view' }, img, h('span', v.name));
        b.addEventListener('click', () => this.restoreView(k));
        const del = h('button.icon-btn.view-del', { type: 'button', title: 'Delete view', html: I('x') });
        del.addEventListener('click', () => {
          this.views.splice(k, 1);
          this.renderViews();
        });
        const ren = h('button.icon-btn.view-ren', { type: 'button', title: 'Rename', html: I('text') });
        ren.addEventListener('click', () => {
          const n = prompt('Name for this view', v.name);
          if (n) {
            v.name = n;
            this.renderViews();
          }
        });
        el.appendChild(h('div.view-wrap', b, ren, del));
      });
    }

    /* ---------------- export ---------------- */
    async composite() {
      const V = this.viewer;
      if (!V.structures.length) throw new Error('Load a structure first.');
      const factor = +this.expScale.value || 2;
      const transparent = this.expBg.value === 'transparent';
      const blob = await V.renderImage({ factor, transparent });
      if (!this.expAnn.checked) return blob;
      return this.annot.composite(blob, factor);
    }
    async exportPNG() {
      try {
        const blob = await this.composite();
        const name = (this.viewer.structures.map((s) => s.name).join('_') || 'structure') + '.png';
        MG.downloadBlob(blob, name);
        this.log('export png ' + this.expScale.value + 'x');
        toast('Image saved as <b>' + esc(name) + '</b>');
        bus.emit('viewer:export', { kind: 'png' });
      } catch (e) {
        toast(esc(e.message), 'error');
      }
    }
    async copyPNG() {
      try {
        if (!window.ClipboardItem || !navigator.clipboard || !navigator.clipboard.write) throw new Error('Copying images is not supported in this browser – use Download PNG instead.');
        const blobPromise = this.composite();
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
        toast('Image copied – paste it into your document (Ctrl/⌘ + V).');
        this.log('export clipboard');
        bus.emit('viewer:export', { kind: 'clipboard' });
      } catch (e) {
        toast(esc(e.message || 'Could not copy the image'), 'error');
      }
    }
    renderCoordSel() {
      if (!this.coordSel) return;
      const V = this.viewer;
      this.coordSel.innerHTML = '';
      V.structures.forEach((st) => this.coordSel.appendChild(h('option', { value: st.uid }, st.name + (st.transformed ? ' (superposed)' : ''))));
      if (!V.structures.length) this.coordSel.appendChild(h('option', { value: '' }, '– nothing loaded –'));
    }
    downloadCoords() {
      const V = this.viewer;
      const st = V.structures.find((s) => String(s.uid) === this.coordSel.value);
      if (!st) return toast('Load a structure first.', 'warn');
      try {
        const text = V.toPDB(st);
        MG.downloadText(text, st.name + (st.transformed ? '_superposed' : '') + '.pdb', 'chemical/x-pdb');
        this.log('# downloaded ' + st.name + '.pdb');
        bus.emit('viewer:download-coords', { name: st.name });
      } catch (e) {
        toast('Could not write a PDB file: ' + esc(e.message), 'error');
      }
    }
  }

  /* ---------------- small shared UI helpers ---------------- */
  MG.thumbnail = function (blob, width) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = width;
        c.height = Math.round((img.height / img.width) * width);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = () => resolve('');
      img.src = url;
    });
  };

  MG.ViewerUI = ViewerUI;
})();
