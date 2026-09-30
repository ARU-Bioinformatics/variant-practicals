/* =====================================================================
   A Galaxy-style workflow engine (for teaching).
   Tools panel · history of datasets · tool forms · dataset details
   (the real command line = provenance) · workflow editor with typed
   connections · workflow runs.
   Jobs run the same programs as the terminal (tools-sim.js and
   tools-wasm.js), inside a job working directory, like Galaxy does.
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const { h, esc, bus, toast } = MG;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const EXT_LABEL = {
    'fastqsanger.gz': 'fastqsanger.gz',
    bam: 'bam',
    sam: 'sam',
    vcf: 'vcf',
    'vcf_bgzip': 'vcf_bgzip',
    bcf: 'bcf',
    html: 'html',
    txt: 'txt',
    tabular: 'tabular'
  };

  class WorkflowEngine {
    constructor(root, opts) {
      this.root = root;
      this.opts = opts;
      this.fs = opts.fs;
      this.tools = opts.tools;
      this.toolById = new Map(this.tools.map((t) => [t.id, t]));
      this.workflows = (opts.workflows || []).map((w) => JSON.parse(JSON.stringify(w)));
      this.workflows.forEach((w) => autoLayout(w));
      this.datasets = [];
      this.jobs = [];
      this.hidCounter = 0;
      this.jobCounter = 0;
      this.shell = new MG.Shell({ fs: this.fs, term: null });
      this.queue = Promise.resolve();
      this.view = 'home';
      this.historyName = opts.historyName || 'Unnamed history';
      this._build();
      (opts.datasets || []).forEach((d) => this.addDataset(d));
      this.showHome();
    }

    /* ================= layout ================= */
    _build() {
      const r = this.root;
      r.classList.add('gx');
      const nav = h('div.gx-nav');
      this.navAnalyse = h('button.gx-navb.on', { type: 'button', html: MG.icon('home') + '<span>Analyse data</span>' });
      this.navAnalyse.innerHTML = MG.icon('database') + '<span>Analyse data</span>';
      this.navWf = h('button.gx-navb', { type: 'button', html: MG.icon('workflow') + '<span>Workflows</span>' });
      this.navAnalyse.addEventListener('click', () => this.showHome());
      this.navWf.addEventListener('click', () => this.showWorkflows());
      nav.append(h('span.gx-brand', { html: MG.icon('workflow') + '<b>Workflow engine</b><small>Galaxy-style practice server</small>' }), this.navAnalyse, this.navWf);
      // tools
      this.toolSearch = h('input.gx-search', { type: 'search', placeholder: 'search tools', 'aria-label': 'Search tools' });
      this.toolList = h('div.gx-toollist');
      this.toolSearch.addEventListener('input', () => this.renderTools());
      this.toolPanel = h('aside.gx-tools', h('div.gx-ph', 'Tools'), this.toolSearch, this.toolList);
      // centre
      this.center = h('main.gx-center');
      // history
      this.histHead = h('div.gx-hh');
      this.histList = h('div.gx-hlist');
      this.histPanel = h('aside.gx-history', h('div.gx-ph', { html: 'History' }), this.histHead, this.histList);
      // step settings of the workflow editor take the history's place while editing
      this.sideCol = h('aside.gx-sidecol');
      r.append(nav, h('div.gx-body', this.toolPanel, this.center, this.histPanel, this.sideCol));
      this.renderTools();
      this.renderHistory();
    }
    setNav(which) {
      this.navAnalyse.classList.toggle('on', which === 'analyse');
      this.navWf.classList.toggle('on', which === 'wf');
    }

    /* ================= tools panel ================= */
    renderTools() {
      const q = this.toolSearch.value.trim().toLowerCase();
      const L = this.toolList;
      L.innerHTML = '';
      const sections = [];
      this.tools.forEach((t) => {
        if (q && !(t.name + ' ' + t.desc + ' ' + t.section).toLowerCase().includes(q)) return;
        let s = sections.find((x) => x.name === t.section);
        if (!s) sections.push((s = { name: t.section, tools: [] }));
        s.tools.push(t);
      });
      sections.forEach((s) => {
        const det = h('details.gx-sec', { open: true });
        det.appendChild(h('summary', s.name));
        s.tools.forEach((t) => {
          const b = h('button.gx-tool', { type: 'button', title: t.desc }, h('b', t.name), h('span', ' ' + t.desc));
          b.addEventListener('click', () => {
            if (this.view === 'editor' && this.editing) this.editorAddTool(t.id);
            else this.showTool(t.id);
          });
          det.appendChild(b);
        });
        L.appendChild(det);
      });
      if (!sections.length) L.appendChild(h('p.muted.small', 'No tools match.'));
    }

    /* ================= history ================= */
    addDataset(d) {
      const hid = ++this.hidCounter;
      const ds = Object.assign({ hid, state: 'ok', visible: true, created: new Date() }, d);
      ds.path = d.path || `/galaxy/database/files/000/dataset_${hid}.dat`;
      if (d.entry) this.fs.put(ds.path, Object.assign({}, d.entry));
      this.datasets.push(ds);
      this.renderHistory();
      return ds;
    }
    ds(hid) {
      return this.datasets.find((d) => d.hid === hid);
    }
    renderHistory() {
      const vis = this.datasets.filter((d) => !d.deleted);
      const size = vis.reduce((s, d) => s + (d.size || 0), 0);
      this.histHead.innerHTML = '';
      this.histHead.append(h('div.gx-hname', this.historyName), h('div.gx-hmeta', `${vis.length} dataset${vis.length === 1 ? '' : 's'} · ${MG.humanSize(size)}B`));
      const L = this.histList;
      const openSet = new Set(Array.from(L.querySelectorAll('.gx-ds.open')).map((e) => +e.dataset.hid));
      L.innerHTML = '';
      vis.slice().reverse().forEach((d) => {
        const row = h('div.gx-ds.' + d.state, { dataset: { hid: d.hid } });
        const title = h('div.gx-ds-t', h('span.gx-hid', d.hid + ':'), h('span.gx-dname', d.name));
        const icons = h('span.gx-ds-ic');
        const mk = (ic, tip, fn) => {
          const b = h('button.gx-ib', { type: 'button', title: tip, 'aria-label': tip, html: MG.icon(ic) });
          b.addEventListener('click', (e) => {
            e.stopPropagation();
            fn();
          });
          return b;
        };
        if (d.state === 'ok') icons.append(mk('eye', 'View data', () => this.showDataset(d.hid)));
        icons.append(mk('x', 'Delete', () => this.deleteDataset(d.hid)));
        row.append(h('div.gx-ds-top', title, icons));
        const body = h('div.gx-ds-body');
        if (d.state === 'queued') body.appendChild(h('div.gx-stateline', 'This job is waiting to run'));
        else if (d.state === 'running') body.appendChild(h('div.gx-stateline', { html: '<span class="spinner small"></span> This job is currently running' }));
        else if (d.state === 'error') body.appendChild(h('div.gx-stateline.err', 'An error occurred with this dataset – click the ⓘ to see the error message'));
        if (d.state === 'ok' || d.state === 'error') {
          if (d.info) body.appendChild(h('div.gx-blurb', d.info));
          body.appendChild(h('div.gx-fmt', { html: `format <b>${esc(EXT_LABEL[d.ext] || d.ext)}</b>, database <b>${esc(d.dbkey || 'hg19')}</b>` }));
          if (d.peek) body.appendChild(h('pre.gx-peek', d.peek));
          const acts = h('div.gx-acts');
          acts.append(mk('download', 'Download', () => this.download(d.hid)), mk('info', 'Dataset details (how was this made?)', () => this.showDetails(d.hid)));
          if (d.job) acts.append(mk('rerun', 'Run this job again', () => this.showTool(d.job.toolId, d.job)));
          if (['bam', 'vcf'].includes(d.ext)) {
            const igv = h('button.gx-link', { type: 'button' }, 'display with IGV');
            igv.addEventListener('click', (e) => {
              e.stopPropagation();
              this.displayIGV(d.hid);
            });
            acts.appendChild(igv);
          }
          body.appendChild(acts);
        }
        row.appendChild(body);
        if (openSet.has(d.hid) || d.state !== 'ok') row.classList.add('open');
        title.addEventListener('click', () => row.classList.toggle('open'));
        L.appendChild(row);
      });
      if (!vis.length) L.appendChild(h('p.muted.small', 'This history is empty.'));
    }
    deleteDataset(hid) {
      const d = this.ds(hid);
      if (!d) return;
      if (d.protected) return toast('This dataset came from the shared course library – keep it.', 'warn');
      d.deleted = true;
      this.renderHistory();
    }
    async download(hid) {
      const d = this.ds(hid);
      try {
        const blob = await this.fs.toBlob(d.path);
        MG.downloadBlob(blob, `Galaxy${d.hid}-[${d.name.replace(/[^A-Za-z0-9._-]+/g, '_')}].${d.ext}`);
      } catch (e) {
        toast('This practice dataset is simulated and cannot be downloaded (the real file would be large).', 'warn');
      }
    }
    displayIGV(hid) {
      const d = this.ds(hid);
      if (!MG.app.igv) return;
      const tmp = `/galaxy/display/${d.hid}.${d.ext}`;
      this.fs.copy(d.path, tmp);
      if (d.ext === 'bam') {
        const idx = this.fs.get(d.path + '.bai') || (d.index && this.fs.get(d.index));
        if (idx) this.fs.put(tmp + '.bai', Object.assign({}, idx));
      }
      MG.app.igv.loadVfs(this.fs, [tmp]).then(() => bus.emit('gx:igv', { hid, ext: d.ext }));
    }

    /* ================= centre: home ================= */
    showHome() {
      this.view = 'home';
      this.root.classList.remove('gx-editing');
      this.setNav('analyse');
      const C = this.center;
      C.innerHTML = '';
      C.append(
        h('h3', 'Welcome to the workflow engine'),
        h('p', { html: 'This works like the <b>Galaxy</b> platform you may meet in research labs. <b>Tools</b> are on the left, your <b>history</b> of datasets is on the right, and the middle shows tool forms and results. Every job runs the same programs you used on the command line – open the <span class="kbd">ⓘ</span> of any dataset to see the exact command.' }),
        h('div.gx-cards',
          card('database', 'Start with the data', 'The two FASTQ files are already in your history (imported from the course data library). Click a dataset name to expand it; click the eye to view it.'),
          card('wrench', 'Run a tool', 'Pick a tool on the left, choose inputs from your history and press Run. Each output appears as a new dataset: grey = queued, yellow = running, green = finished.'),
          card('workflow', 'Workflows', 'Chain tools into a reusable pipeline, then run it on any data with one click.')
        )
      );
    }

    /* ================= centre: tool form ================= */
    showTool(id, rerunJob) {
      const t = this.toolById.get(id);
      if (!t) return;
      this.view = 'tool';
      this.root.classList.remove('gx-editing');
      this.setNav('analyse');
      const C = this.center;
      C.innerHTML = '';
      C.appendChild(h('div.gx-toolh', h('h3', t.name), h('span.muted', `${t.desc} (Galaxy version ${t.version})`)));
      const form = h('form.gx-form');
      const values = {};
      const prev = rerunJob ? rerunJob : null;
      (t.inputs || []).forEach((inp) => {
        const sel = h('select', { name: inp.name });
        const cand = this.datasets.filter((d) => !d.deleted && d.state === 'ok' && accepts(inp, d.ext));
        cand.slice().reverse().forEach((d) => sel.appendChild(h('option', { value: String(d.hid) }, `${d.hid}: ${d.name}`)));
        if (!cand.length) sel.appendChild(h('option', { value: '' }, `No ${inp.ext.join(' / ')} dataset available`));
        if (prev && prev.inputs) {
          const p = prev.inputs.find((x) => x.name === inp.name);
          if (p) sel.value = String(p.hid);
        } else if (inp.pick) {
          const pick = cand.slice().reverse().find((d) => inp.pick(d));
          if (pick) sel.value = String(pick.hid);
        }
        values[inp.name] = sel;
        form.appendChild(field(inp.label, sel, `${inp.ext.join(', ')}`, inp.help));
      });
      (t.params || []).forEach((p) => {
        let ctl;
        const cur = prev && prev.params && p.name in prev.params ? prev.params[p.name] : p.default;
        if (p.type === 'select') {
          ctl = h('select', { name: p.name });
          p.options.forEach(([v, lab]) => ctl.appendChild(h('option', { value: v }, lab)));
          ctl.value = cur;
        } else if (p.type === 'bool') {
          ctl = h('input', { type: 'checkbox', name: p.name });
          ctl.checked = !!cur;
        } else {
          ctl = h('input', { type: p.type === 'text' ? 'text' : 'number', name: p.name, step: p.type === 'float' ? 'any' : '1' });
          ctl.value = cur;
        }
        values[p.name] = ctl;
        form.appendChild(field(p.label, ctl, null, p.help));
      });
      const run = h('button.btn.primary', { type: 'submit', html: MG.icon('play') + '<span>Run tool</span>' });
      form.appendChild(h('div.gx-runrow', run));
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const inputs = (t.inputs || []).map((inp) => ({ name: inp.name, hid: +values[inp.name].value }));
        if (inputs.some((x) => !x.hid)) return toast('Choose an input dataset first.', 'warn');
        const params = {};
        (t.params || []).forEach((p) => {
          const c = values[p.name];
          params[p.name] = p.type === 'bool' ? c.checked : p.type === 'int' ? parseInt(c.value, 10) : p.type === 'float' ? parseFloat(c.value) : c.value;
        });
        this.submit(t.id, inputs, params);
        C.innerHTML = '';
        C.appendChild(h('div.gx-queued', h('h3', { html: MG.icon('check') + ' Job submitted' }), h('p', `${t.name} has been added to the queue. Its output${t.outputs.length > 1 ? 's appear' : ' appears'} at the top of your history.`)));
      });
      C.appendChild(form);
      if (t.help) C.appendChild(h('div.gx-help', h('h4', 'What it does'), h('div', { html: t.help })));
      bus.emit('gx:toolform', { tool: id });
    }

    /* ================= jobs ================= */
    submit(toolId, inputs, params, opts = {}) {
      const t = this.toolById.get(toolId);
      const inDs = inputs.map((x) => ({ name: x.name, hid: x.hid, ds: this.ds(x.hid) }));
      const job = { id: ++this.jobCounter, toolId, toolName: t.name, version: t.version, inputs: inputs.map((x) => ({ name: x.name, hid: x.hid })), params, state: 'queued', created: new Date(), invocation: opts.invocation || null };
      const outs = t.outputs.map((o) => this.addDataset({ name: o.label(inDs, params), ext: typeof o.ext === 'function' ? o.ext(params) : o.ext, state: 'queued', job, outName: o.name }));
      job.outputs = outs.map((d) => d.hid);
      this.jobs.push(job);
      this.queue = this.queue.then(() => this._runJob(job, t, inDs, outs));
      bus.emit('gx:submitted', { tool: toolId, job: job.id });
      return { job, outs, done: this.queue };
    }
    async _runJob(job, t, inDs, outs) {
      if (inDs.some((x) => !x.ds || x.ds.state === 'error')) {
        outs.forEach((d) => (d.state = 'error'));
        job.state = 'error';
        job.stderr = 'An input dataset is in the error state, so this job was not run.';
        this.renderHistory();
        return;
      }
      await sleep(this.opts.queueDelay || 700);
      outs.forEach((d) => (d.state = 'running'));
      job.state = 'running';
      job.started = new Date();
      this.renderHistory();
      const wd = `/galaxy/jobs/000/${job.id}/working`;
      this.fs.mkdirp(wd);
      // Galaxy links each input into the working directory under a sensible name
      const links = [];
      const inPaths = {};
      inDs.forEach((x) => {
        const nice = t.inputName ? t.inputName(x.name, x.ds) : x.name + '.' + x.ds.ext;
        this.fs.copy(x.ds.path, wd + '/' + nice);
        if (this.fs.exists(x.ds.path + '.bai')) this.fs.copy(x.ds.path + '.bai', wd + '/' + nice + '.bai');
        links.push(`ln -s '${x.ds.path}' '${nice}'`);
        inPaths[x.name] = nice;
      });
      const cmd = t.command(inPaths, job.params);
      job.command = (links.length ? links.join(' && ') + ' && ' : '') + (Array.isArray(cmd) ? cmd.join(' && ') : cmd);
      const lines = Array.isArray(cmd) ? cmd : [cmd];
      let stdout = '', stderr = '';
      const io = { out: (x) => (stdout += x), err: (x) => (stderr += x), note: () => {}, html: () => {}, progress: () => {}, clear: () => {} };
      const oldCwd = this.fs.cwd;
      const t0 = performance.now();
      let code = 0;
      try {
        this.fs.cwd = wd;
        for (const l of lines) {
          code = await this.shell.run(l, io);
          if (code !== 0) break;
        }
      } catch (e) {
        stderr += String(e && e.message ? e.message : e);
        code = 1;
      } finally {
        this.fs.cwd = oldCwd;
      }
      const minMs = (t.minSeconds || 1.2) * 1000;
      const el = performance.now() - t0;
      if (el < minMs) await sleep(minMs - el);
      job.stdout = stdout;
      job.stderr = stderr;
      job.finished = new Date();
      job.runtime = (performance.now() - t0) / 1000;
      const ok = code === 0 && t.outputs.every((o) => this.fs.exists(wd + '/' + o.file(job.params)));
      if (!ok) {
        job.state = 'error';
        outs.forEach((d) => (d.state = 'error'));
        this.renderHistory();
        bus.emit('gx:job', { tool: t.id, state: 'error', job: job.id });
        return;
      }
      for (const d of outs) {
        const o = t.outputs.find((x) => x.name === d.outName);
        const src = wd + '/' + o.file(job.params);
        this.fs.rename(src, d.path);
        if (this.fs.exists(src + '.bai')) this.fs.rename(src + '.bai', d.path + '.bai');
        const e = this.fs.get(d.path);
        d.size = this.fs.size(e);
        try {
          const meta = o.describe ? await o.describe(this, d, job) : {};
          Object.assign(d, meta);
        } catch (err) {
          console.error(err);
        }
        d.state = 'ok';
      }
      job.state = 'ok';
      this.renderHistory();
      bus.emit('gx:job', { tool: t.id, state: 'ok', job: job.id, invocation: job.invocation });
    }

    /* ================= dataset views ================= */
    async showDataset(hid) {
      const d = this.ds(hid);
      if (!d) return;
      this.view = 'dataset';
      this.root.classList.remove('gx-editing');
      const C = this.center;
      C.innerHTML = '';
      C.appendChild(h('div.gx-toolh', h('h3', `${d.hid}: ${d.name}`), h('span.muted', `${d.ext} · ${MG.humanSize(d.size || 0)}B`)));
      bus.emit('gx:view', { hid, ext: d.ext });
      if (d.ext === 'html' && d.report) {
        C.appendChild(h('p', { html: 'This dataset is a FastQC web page. It has opened in the <b>Report</b> tab.' }));
        await MG.app.fastqc.load(d.report, MG.simData.fastqc[d.report].json);
        MG.app.showWorkbench('report');
        return;
      }
      if (d.ext === 'bam') {
        C.append(h('p', 'Binary BAM alignments cannot be shown as text. Galaxy shows a summary and lets you display the reads in a genome browser.'), h('pre.gx-pre', d.peek || ''));
        const b = h('button.btn', { type: 'button', html: MG.icon('genome') + '<span>Display with IGV</span>' });
        b.addEventListener('click', () => this.displayIGV(hid));
        C.appendChild(b);
        return;
      }
      let text = '';
      try {
        text = await this.fs.readText(d.path);
      } catch (e) {
        const en = this.fs.get(d.path);
        if (en && en.kind === 'virtual' && en.meta.head) text = en.meta.head(200).join('\n') + `\n… (${MG.shellUtil.fmtN(en.meta.lines)} lines in total)`;
      }
      if (d.ext === 'vcf' || d.ext === 'tabular') {
        C.appendChild(tsvTable(text, d.ext === 'vcf'));
        if (d.ext === 'vcf') {
          const b = h('button.btn', { type: 'button', html: MG.icon('genome') + '<span>Display with IGV</span>' });
          b.addEventListener('click', () => this.displayIGV(hid));
          C.appendChild(b);
        }
      } else C.appendChild(h('pre.gx-pre', text.length > 200000 ? text.slice(0, 200000) + '\n…' : text));
    }
    showDetails(hid) {
      const d = this.ds(hid);
      if (!d) return;
      this.view = 'details';
      this.root.classList.remove('gx-editing');
      const C = this.center;
      C.innerHTML = '';
      C.appendChild(h('h3', 'Dataset details'));
      const tbl = h('table.table.small.gx-details');
      const row = (k, v) => tbl.appendChild(h('tr', h('th', k), h('td', v instanceof Node ? v : String(v == null ? '' : v))));
      row('Number', d.hid);
      row('Name', d.name);
      row('Created', d.created.toLocaleString('en-GB'));
      row('Size', MG.humanSize(d.size || 0) + 'B');
      row('Database/build', d.dbkey || 'hg19');
      row('Format', d.ext);
      if (d.job) {
        row('Tool', d.job.toolName);
        row('Tool version', d.job.version);
        row('Job state', d.job.state);
        row('Job runtime', (d.job.runtime || 0).toFixed(1) + ' s');
      } else row('Source', d.source || 'Imported from the course data library');
      C.appendChild(tbl);
      if (d.job) {
        C.appendChild(h('h4', 'Command line'));
        C.appendChild(h('p.muted.small', 'Galaxy writes a shell script for every job. This is the command it ran – you could paste it into a terminal and get the same result.'));
        C.appendChild(h('pre.gx-cmd', d.job.command || ''));
        C.appendChild(h('h4', 'Job parameters'));
        const pt = h('table.table.small');
        const t = this.toolById.get(d.job.toolId);
        (t.inputs || []).forEach((inp) => {
          const x = d.job.inputs.find((i) => i.name === inp.name);
          const src = x && this.ds(x.hid);
          pt.appendChild(h('tr', h('th', inp.label), h('td', src ? `${src.hid}: ${src.name}` : '')));
        });
        (t.params || []).forEach((p) => {
          let v = d.job.params[p.name];
          if (p.type === 'select') v = (p.options.find((o) => o[0] === v) || [v, v])[1];
          if (p.type === 'bool') v = v ? 'Yes' : 'No';
          pt.appendChild(h('tr', h('th', p.label), h('td', String(v))));
        });
        C.appendChild(pt);
        C.appendChild(h('h4', 'Tool standard output / error'));
        C.appendChild(h('pre.gx-pre.small', (d.job.stderr || '') + (d.job.stdout && d.ext !== 'txt' && d.ext !== 'tabular' && d.ext !== 'vcf' ? d.job.stdout.slice(0, 4000) : '') || '(empty)'));
        if (d.job.invocation) C.appendChild(h('p.muted.small', `Run as part of workflow invocation #${d.job.invocation}.`));
      }
      bus.emit('gx:details', { hid, tool: d.job && d.job.toolId });
    }

    /* ================= workflows ================= */
    showWorkflows() {
      this.view = 'workflows';
      this.root.classList.remove('gx-editing');
      this.editing = null;
      this.setNav('wf');
      const C = this.center;
      C.innerHTML = '';
      C.appendChild(h('h3', 'Workflows'));
      C.appendChild(h('p.muted', 'A workflow is a saved chain of tools. The inputs of each step are connected to the outputs of earlier steps, so the whole pipeline can be run again on new data.'));
      const t = h('table.table.gx-wft');
      t.appendChild(h('tr', h('th', 'Name'), h('th', 'Steps'), h('th', '')));
      this.workflows.forEach((w, i) => {
        const ed = h('button.btn.small', { type: 'button', html: MG.icon('pencil') + '<span>Edit</span>' });
        ed.addEventListener('click', () => this.showEditor(i));
        const run = h('button.btn.small.primary', { type: 'button', html: MG.icon('play') + '<span>Run</span>' });
        run.addEventListener('click', () => this.showRunForm(i));
        t.appendChild(h('tr', h('td', h('b', w.name), h('div.muted.small', w.annotation || '')), h('td', String(w.steps.length)), h('td.nowrap', ed, ' ', run)));
      });
      C.appendChild(t);
      const nw = h('button.btn', { type: 'button', html: MG.icon('plus') + '<span>Create a new workflow</span>' });
      nw.addEventListener('click', () => {
        this.workflows.push({ name: 'My workflow ' + (this.workflows.length + 1), annotation: '', steps: [{ id: 's1', type: 'input', label: 'Input dataset', ext: ['fastqsanger.gz'], x: 30, y: 60 }] });
        this.showEditor(this.workflows.length - 1);
      });
      C.appendChild(nw);
      bus.emit('gx:workflows', {});
    }

    /* ---------- editor ---------- */
    showEditor(i) {
      const w = this.workflows[i];
      this.view = 'editor';
      this.root.classList.add('gx-editing');
      this.editing = w;
      this.editingIndex = i;
      this.setNav('wf');
      const C = this.center;
      C.innerHTML = '';
      const nameIn = h('input.gx-wfname', { type: 'text', value: w.name, 'aria-label': 'Workflow name' });
      nameIn.addEventListener('input', () => (w.name = nameIn.value));
      const runB = h('button.btn.small.primary', { type: 'button', html: MG.icon('play') + '<span>Run</span>' });
      runB.addEventListener('click', () => this.showRunForm(i));
      const backB = h('button.btn.small', { type: 'button', text: '← All workflows' });
      backB.addEventListener('click', () => this.showWorkflows());
      const layoutB = h('button.btn.small', { type: 'button', text: 'Tidy layout' });
      layoutB.addEventListener('click', () => {
        autoLayout(w, this.toolById);
        this.drawEditor();
      });
      const inB = h('button.btn.small', { type: 'button', html: MG.icon('plus') + '<span>Input</span>' });
      inB.addEventListener('click', () => {
        const n = w.steps.filter((s) => s.type === 'input').length + 1;
        w.steps.push({ id: 's' + Date.now().toString(36), type: 'input', label: 'Input dataset ' + n, ext: ['fastqsanger.gz'], x: 20, y: 40 + 90 * n });
        this.drawEditor();
      });
      C.appendChild(h('div.gx-edbar', backB, nameIn, h('span.grow'), inB, layoutB, runB));
      C.appendChild(h('p.muted.small.gx-edhint', { html: 'Drag a box to move it. Drag from an <b>output</b> (right-hand dot) to an <b>input</b> (left-hand dot) to connect two steps – only matching data types connect. Click a step to see its settings. Click a tool on the left to add it.' }));
      this.canvas = h('div.gx-canvas');
      this.side = this.sideCol;
      this.side.innerHTML = '';
      C.appendChild(h('div.gx-edwrap', this.canvas));
      this.drawEditor();
      bus.emit('gx:editor', { name: w.name });
    }
    editorAddTool(id) {
      const w = this.editing;
      const t = this.toolById.get(id);
      const maxX = Math.max(0, ...w.steps.map((s) => s.x || 0));
      w.steps.push({ id: 's' + Date.now().toString(36), type: 'tool', tool: id, params: defaults(t), connections: {}, x: Math.min(maxX + 40, 760), y: 30 + (w.steps.length % 5) * 80 });
      this.drawEditor();
      toast(`Added <b>${esc(t.name)}</b> – now connect its input.`);
      bus.emit('gx:added', { tool: id });
    }
    drawEditor() {
      const w = this.editing;
      const cv = this.canvas;
      cv.innerHTML = '';
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'gx-wires');
      cv.appendChild(svg);
      const nodes = new Map();
      w.steps.forEach((st) => {
        const t = st.type === 'tool' ? this.toolById.get(st.tool) : null;
        const el = h('div.gx-node' + (st.type === 'input' ? '.input' : ''), { dataset: { id: st.id } });
        el.style.left = (st.x || 0) + 'px';
        el.style.top = (st.y || 0) + 'px';
        const title = h('div.gx-node-t', h('span', st.type === 'input' ? st.label : t.name));
        const del = h('button.gx-node-x', { type: 'button', title: 'Remove this step', html: MG.icon('x') });
        del.addEventListener('pointerdown', (e) => e.stopPropagation());
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          w.steps = w.steps.filter((s) => s !== st);
          w.steps.forEach((s) => Object.keys(s.connections || {}).forEach((k) => s.connections[k] && s.connections[k].step === st.id && delete s.connections[k]));
          this.drawEditor();
        });
        title.appendChild(del);
        el.appendChild(title);
        const ins = st.type === 'input' ? [] : t.inputs;
        const outs = st.type === 'input' ? [{ name: 'output', ext: st.ext, label: 'output' }] : t.outputs.map((o) => ({ name: o.name, ext: [typeof o.ext === 'function' ? o.ext(st.params || {}) : o.ext], label: o.short || o.name }));
        const portsIn = h('div.gx-ports.in');
        ins.forEach((inp) => {
          const p = h('div.gx-port.in', { dataset: { step: st.id, name: inp.name }, title: inp.label + ' – accepts ' + inp.ext.join(', ') }, h('i.dot'), h('span', inp.short || inp.label.replace(/^(Select|Choose) /, '')), h('small', inp.ext.map((x) => x.replace('fastqsanger', 'fastq')).join('/')));
          portsIn.appendChild(p);
        });
        const portsOut = h('div.gx-ports.out');
        outs.forEach((o) => {
          const p = h('div.gx-port.out', { dataset: { step: st.id, name: o.name, ext: o.ext.join(',') }, title: 'produces ' + o.ext.join(', ') }, h('small', o.ext.map((x) => x.replace('fastqsanger', 'fastq')).join('/')), h('span', o.label), h('i.dot'));
          portsOut.appendChild(p);
          p.querySelector('.dot').addEventListener('pointerdown', (e) => this._startWire(e, st, o, svg));
        });
        el.append(portsIn, portsOut);
        this._draggable(el, st);
        el.addEventListener('click', () => this.showStepSettings(st));
        cv.appendChild(el);
        nodes.set(st.id, el);
      });
      // size the canvas
      const maxX = Math.max(600, ...w.steps.map((s) => (s.x || 0) + 200));
      const maxY = Math.max(360, ...w.steps.map((s) => (s.y || 0) + 150));
      cv.style.width = maxX + 'px';
      cv.style.height = maxY + 'px';
      svg.setAttribute('width', maxX);
      svg.setAttribute('height', maxY);
      requestAnimationFrame(() => this._drawWires(svg));
      this.showStepSettings(this._selStep && w.steps.includes(this._selStep) ? this._selStep : null);
    }
    _portPos(stepId, name, dir) {
      const el = this.canvas.querySelector(`.gx-port.${dir}[data-step="${stepId}"][data-name="${CSS.escape(name)}"] .dot`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const c = this.canvas.getBoundingClientRect();
      return { x: r.left - c.left + r.width / 2, y: r.top - c.top + r.height / 2 };
    }
    _drawWires(svg) {
      const w = this.editing;
      Array.from(svg.querySelectorAll('path')).forEach((p) => p.remove());
      w.steps.forEach((st) => {
        Object.entries(st.connections || {}).forEach(([inName, c]) => {
          if (!c) return;
          const a = this._portPos(c.step, c.output, 'out');
          const b = this._portPos(st.id, inName, 'in');
          if (!a || !b) return;
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          const dx = Math.max(40, (b.x - a.x) / 2);
          path.setAttribute('d', `M${a.x} ${a.y} C${a.x + dx} ${a.y} ${b.x - dx} ${b.y} ${b.x} ${b.y}`);
          path.setAttribute('class', 'gx-wire');
          path.addEventListener('click', () => {
            delete st.connections[inName];
            this.drawEditor();
          });
          const tt = document.createElementNS('http://www.w3.org/2000/svg', 'title');
          tt.textContent = 'Click to remove this connection';
          path.appendChild(tt);
          svg.appendChild(path);
        });
      });
    }
    _draggable(el, st) {
      let start = null;
      el.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.dot') || e.target.closest('button')) return;
        start = { x: e.clientX, y: e.clientY, sx: st.x || 0, sy: st.y || 0, moved: false };
        el.setPointerCapture(e.pointerId);
      });
      el.addEventListener('pointermove', (e) => {
        if (!start) return;
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) start.moved = true;
        st.x = Math.max(0, start.sx + dx);
        st.y = Math.max(0, start.sy + dy);
        el.style.left = st.x + 'px';
        el.style.top = st.y + 'px';
        this._drawWires(this.canvas.querySelector('svg'));
      });
      el.addEventListener('pointerup', (e) => {
        if (start && start.moved) e.stopPropagation();
        start = null;
      });
    }
    _startWire(e, st, out, svg) {
      e.preventDefault();
      e.stopPropagation();
      const c = this.canvas.getBoundingClientRect();
      const a = this._portPos(st.id, out.name, 'out');
      const tmp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      tmp.setAttribute('class', 'gx-wire tmp');
      svg.appendChild(tmp);
      // highlight compatible inputs
      this.canvas.querySelectorAll('.gx-port.in').forEach((p) => {
        const step = this.editing.steps.find((s) => s.id === p.dataset.step);
        const t = step && this.toolById.get(step.tool);
        const inp = t && t.inputs.find((i) => i.name === p.dataset.name);
        const ok = inp && out.ext.some((x) => inp.ext.includes(x)) && step.id !== st.id;
        p.classList.add(ok ? 'ok' : 'bad');
      });
      const move = (ev) => {
        const x = ev.clientX - c.left, y = ev.clientY - c.top;
        const dx = Math.max(40, (x - a.x) / 2);
        tmp.setAttribute('d', `M${a.x} ${a.y} C${a.x + dx} ${a.y} ${x - dx} ${y} ${x} ${y}`);
      };
      const up = (ev) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        tmp.remove();
        this.canvas.querySelectorAll('.gx-port.in').forEach((p) => p.classList.remove('ok', 'bad'));
        const target = document.elementFromPoint(ev.clientX, ev.clientY);
        const port = target && target.closest('.gx-port.in');
        if (!port) return;
        const step = this.editing.steps.find((s) => s.id === port.dataset.step);
        const t = this.toolById.get(step.tool);
        const inp = t.inputs.find((i) => i.name === port.dataset.name);
        if (step.id === st.id) return;
        if (!out.ext.some((x) => inp.ext.includes(x))) {
          toast(`Can't connect: <b>${esc(t.name)}</b> needs <b>${esc(inp.ext.join(' or '))}</b>, but this output is <b>${esc(out.ext.join(', '))}</b>.`, 'error', 6000);
          bus.emit('gx:badwire', { from: st.tool || 'input', to: step.tool, need: inp.ext.join(','), got: out.ext.join(',') });
          return;
        }
        step.connections = step.connections || {};
        step.connections[inp.name] = { step: st.id, output: out.name };
        this.drawEditor();
        bus.emit('gx:wire', { from: st.tool || 'input', to: step.tool, input: inp.name });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    }
    showStepSettings(st) {
      this._selStep = st;
      const S = this.side;
      if (!S) return;
      S.innerHTML = '';
      this.canvas.querySelectorAll('.gx-node').forEach((n) => n.classList.toggle('sel', !!st && n.dataset.id === st.id));
      if (!st) {
        S.appendChild(h('p.muted.small', 'Click a step to see and change its settings.'));
        return;
      }
      if (st.type === 'input') {
        S.appendChild(h('h4', 'Input dataset'));
        const lab = h('input', { type: 'text', value: st.label });
        lab.addEventListener('input', () => {
          st.label = lab.value;
          const n = this.canvas.querySelector(`.gx-node[data-id="${st.id}"] .gx-node-t span`);
          if (n) n.textContent = st.label;
        });
        S.appendChild(field('Label', lab));
        const fmt = h('select');
        [['fastqsanger.gz', 'fastqsanger.gz (reads)'], ['bam', 'bam (alignments)'], ['vcf', 'vcf (variants)']].forEach(([v, l]) => fmt.appendChild(h('option', { value: v }, l)));
        fmt.value = st.ext[0];
        fmt.addEventListener('change', () => {
          st.ext = [fmt.value];
          this.drawEditor();
        });
        S.appendChild(field('Format', fmt));
        return;
      }
      const t = this.toolById.get(st.tool);
      S.appendChild(h('h4', t.name));
      S.appendChild(h('p.muted.small', t.desc + ' · version ' + t.version));
      (t.params || []).forEach((p) => {
        let ctl;
        const cur = st.params && p.name in st.params ? st.params[p.name] : p.default;
        if (p.type === 'select') {
          ctl = h('select');
          p.options.forEach(([v, l]) => ctl.appendChild(h('option', { value: v }, l)));
          ctl.value = cur;
        } else if (p.type === 'bool') {
          ctl = h('input', { type: 'checkbox' });
          ctl.checked = !!cur;
        } else {
          ctl = h('input', { type: p.type === 'text' ? 'text' : 'number', step: p.type === 'float' ? 'any' : '1' });
          ctl.value = cur;
        }
        ctl.addEventListener('change', () => {
          st.params = st.params || {};
          st.params[p.name] = p.type === 'bool' ? ctl.checked : p.type === 'int' ? parseInt(ctl.value, 10) : p.type === 'float' ? parseFloat(ctl.value) : ctl.value;
          bus.emit('gx:param', { tool: st.tool, name: p.name, value: st.params[p.name] });
        });
        S.appendChild(field(p.label, ctl, null, p.help));
      });
      const missing = t.inputs.filter((i) => !(st.connections || {})[i.name]);
      if (missing.length) S.appendChild(h('p.warnline', `Not connected: ${missing.map((m) => m.label).join(', ')}`));
    }

    /* ---------- run a workflow ---------- */
    showRunForm(i) {
      const w = this.workflows[i];
      this.root.classList.remove('gx-editing');
      const problems = validateWorkflow(w, this.toolById);
      this.view = 'runform';
      this.setNav('wf');
      const C = this.center;
      C.innerHTML = '';
      C.appendChild(h('h3', 'Run workflow: ' + w.name));
      if (problems.length) {
        C.appendChild(h('div.callout.warn', h('div.co-t', 'This workflow is not ready'), h('ul', ...problems.map((p) => h('li', p)))));
        const ed = h('button.btn', { type: 'button', text: 'Open in the editor' });
        ed.addEventListener('click', () => this.showEditor(i));
        C.appendChild(ed);
        return;
      }
      const form = h('form.gx-form');
      const pickers = {};
      w.steps.filter((s) => s.type === 'input').forEach((s) => {
        const sel = h('select');
        const cand = this.datasets.filter((d) => !d.deleted && d.state === 'ok' && s.ext.includes(d.ext));
        cand.forEach((d) => sel.appendChild(h('option', { value: String(d.hid) }, `${d.hid}: ${d.name}`)));
        const guess = cand.find((d) => s.pick && new RegExp(s.pick, 'i').test(d.name));
        if (guess) sel.value = String(guess.hid);
        pickers[s.id] = sel;
        form.appendChild(field(s.label, sel, s.ext.join(', ')));
      });
      const summary = h('ol.gx-steps');
      order(w).filter((s) => s.type === 'tool').forEach((s) => {
        const t = this.toolById.get(s.tool);
        const ps = (t.params || []).map((p) => `${p.short || p.label}: ${fmtParam(p, s.params && p.name in s.params ? s.params[p.name] : p.default)}`).join(' · ');
        summary.appendChild(h('li', h('b', t.name), ps ? h('span.muted.small', ' – ' + ps) : null));
      });
      form.appendChild(h('div.gx-field', h('label', 'Steps that will run'), summary));
      const run = h('button.btn.primary', { type: 'submit', html: MG.icon('play') + '<span>Run workflow</span>' });
      form.appendChild(h('div.gx-runrow', run));
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const inputs = {};
        for (const [sid, sel] of Object.entries(pickers)) {
          if (!sel.value) return toast('Choose a dataset for every input.', 'warn');
          inputs[sid] = +sel.value;
        }
        this.invoke(w, inputs);
      });
      C.appendChild(form);
    }
    invoke(w, inputs) {
      this.root.classList.remove('gx-editing');
      const inv = (this._inv = (this._inv || 0) + 1);
      const produced = {}; // stepId -> {outName: hid}
      Object.entries(inputs).forEach(([sid, hid]) => (produced[sid] = { output: hid }));
      const steps = order(w).filter((s) => s.type === 'tool');
      const C = this.center;
      C.innerHTML = '';
      C.appendChild(h('h3', { html: MG.icon('workflow') + ' Workflow invocation #' + inv }));
      C.appendChild(h('p', `"${w.name}" has been scheduled: ${steps.length} jobs. Watch the history fill up – grey (queued) → yellow (running) → green (done).`));
      const list = h('ol.gx-inv');
      C.appendChild(list);
      const items = [];
      steps.forEach((s) => {
        const t = this.toolById.get(s.tool);
        const ins = t.inputs.map((inp) => {
          const c = s.connections[inp.name];
          return { name: inp.name, hid: produced[c.step] && produced[c.step][c.output] };
        });
        const params = Object.assign(defaults(t), s.params || {});
        const { job, outs } = this.submit(t.id, ins, params, { invocation: inv });
        produced[s.id] = {};
        t.outputs.forEach((o, k) => (produced[s.id][o.name] = outs[k].hid));
        const li = h('li', h('b', t.name), h('span.gx-invstate', 'queued'));
        list.appendChild(li);
        items.push({ li, job });
      });
      const tick = setInterval(() => {
        let done = 0;
        items.forEach(({ li, job }) => {
          const st = li.querySelector('.gx-invstate');
          st.textContent = job.state;
          st.className = 'gx-invstate ' + job.state;
          if (job.state === 'ok' || job.state === 'error') done++;
        });
        if (done === items.length) {
          clearInterval(tick);
          const ok = items.every((x) => x.job.state === 'ok');
          C.appendChild(h('p' + (ok ? '.okline' : '.warnline'), ok ? '✓ All steps finished. Open the datasets in your history to look at the results.' : 'Some steps failed – open the ⓘ of the red dataset to see why.'));
          bus.emit('gx:invocation', { inv, ok, steps: items.length, workflow: w.name });
        }
      }, 500);
      bus.emit('gx:invoked', { inv, workflow: w.name });
    }
  }

  /* ================= helpers ================= */
  function accepts(inp, ext) {
    return inp.ext.includes(ext);
  }
  function defaults(t) {
    const o = {};
    (t.params || []).forEach((p) => (o[p.name] = p.default));
    return o;
  }
  function fmtParam(p, v) {
    if (p.type === 'select') return (p.options.find((o) => o[0] === v) || [v, v])[1];
    if (p.type === 'bool') return v ? 'yes' : 'no';
    return String(v);
  }
  function field(label, ctl, ext, help) {
    const f = h('div.gx-field');
    f.appendChild(h('label', label));
    f.appendChild(ctl);
    if (ext) f.appendChild(h('small.muted', 'Format: ' + ext));
    if (help) f.appendChild(h('small.gx-fhelp', help));
    return f;
  }
  function card(ic, title, text) {
    return h('div.gx-card', h('div.gx-card-t', { html: MG.icon(ic) + '<b>' + esc(title) + '</b>' }), h('p', text));
  }
  function tsvTable(text, vcf) {
    const L = text.split('\n').filter(Boolean);
    const meta = vcf ? L.filter((l) => l.startsWith('##')) : [];
    const rows = L.filter((l) => !l.startsWith('##'));
    const wrap = h('div.gx-tablewrap');
    if (meta.length) {
      const d = h('details');
      d.appendChild(h('summary', `${meta.length} header lines (##) – click to show`));
      d.appendChild(h('pre.gx-pre.small', meta.join('\n')));
      wrap.appendChild(d);
    }
    const t = h('table.table.small.mono');
    rows.slice(0, 300).forEach((r, i) => {
      const cells = r.split('\t');
      const tr = h('tr');
      cells.forEach((c) => tr.appendChild(h(i === 0 && (r.startsWith('#') || !vcf) && vcf ? 'th' : 'td', c.length > 60 ? c.slice(0, 57) + '…' : c)));
      t.appendChild(tr);
    });
    wrap.appendChild(h('div.ch-table-scroll', t));
    if (rows.length > 300) wrap.appendChild(h('p.muted.small', `Showing the first 300 of ${rows.length} lines.`));
    return wrap;
  }
  function order(w) {
    const done = new Set();
    const out = [];
    let guard = 0;
    while (out.length < w.steps.length && guard++ < 100) {
      w.steps.forEach((s) => {
        if (done.has(s.id)) return;
        const deps = Object.values(s.connections || {}).filter(Boolean).map((c) => c.step);
        if (deps.every((d) => done.has(d))) {
          done.add(s.id);
          out.push(s);
        }
      });
    }
    return out;
  }
  function validateWorkflow(w, toolById) {
    const probs = [];
    if (!w.steps.some((s) => s.type === 'input')) probs.push('It has no input dataset.');
    w.steps.forEach((s) => {
      if (s.type !== 'tool') return;
      const t = toolById.get(s.tool);
      t.inputs.forEach((i) => {
        const c = (s.connections || {})[i.name];
        if (!c) probs.push(`${t.name}: “${i.label}” is not connected.`);
        else if (!w.steps.find((x) => x.id === c.step)) probs.push(`${t.name}: “${i.label}” is connected to a step that was removed.`);
      });
    });
    if (order(w).length < w.steps.length) probs.push('The connections form a loop.');
    return probs;
  }
  function autoLayout(w, toolById) {
    const depth = {};
    order(w).forEach((s) => {
      const deps = Object.values(s.connections || {}).filter(Boolean).map((c) => depth[c.step] || 0);
      depth[s.id] = deps.length ? Math.max(...deps) + 1 : 0;
    });
    const cols = {};
    w.steps.forEach((s) => {
      const d = depth[s.id] || 0;
      cols[d] = (cols[d] || 0) + 1;
      s.x = 16 + d * 212;
      s.y = 16 + (cols[d] - 1) * 104;
    });
    void toolById;
  }

  MG.WorkflowEngine = WorkflowEngine;
  MG.workflowUtil = { order, validateWorkflow, autoLayout };
})();
