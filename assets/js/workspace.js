/* =====================================================================
   Saving the student's work in this browser.

   What a student makes on a page – the files in the terminal, the
   workflow engine's history, the variant table, the 3D viewer, the
   tracks open in IGV – is saved in the browser's own database
   (IndexedDB) as they work, and put back when they open the page again,
   even after the browser has been closed. Nothing leaves the computer.

   The files a page makes for itself (the practical's data and the
   reference genome) are not saved, because the page makes them again
   every time it opens.

   If the same page is open in two tabs, only the first one saves, so
   that the two cannot overwrite each other's work; the second tab says
   so at the top of the workbench.
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const { h, esc, bus, toast } = MG;
  const CFG = MG.config || {};
  const PAGE = (document.body && document.body.dataset.page) || 'page';
  // one database for each site: several sites can share a web address (user.github.io/one/, /two/)
  const DB_NAME = (CFG.storePrefix || 'genomics') + ':work:' + new URL('.', location.href).pathname;
  const LOCK = DB_NAME + '|' + PAGE;
  const KEY = (name) => PAGE + '\u0000' + name;
  const RANGE = () => IDBKeyRange.bound(PAGE + '\u0000', PAGE + '\u0001', false, true);
  const SOON_MS = 500;

  /* bus events that mean a part of the page has changed, and the name it is saved under */
  const ROUTES = [
    ['term:', 'term'],
    ['gx:', 'gx'],
    ['vx:', 'vx'],
    ['igv:', 'igv'],
    ['viewer:', 'viewer'],
    ['fastqc:', 'report'],
    ['app:bench', 'bench']
  ];

  let db = null;

  /* ------------------------------------------------------------------
     IndexedDB
     ------------------------------------------------------------------ */
  function openDB() {
    return new Promise((resolve, reject) => {
      let req;
      try {
        req = window.indexedDB.open(DB_NAME, 1);
      } catch (e) {
        reject(e);
        return;
      }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
        if (!d.objectStoreNames.contains('state')) d.createObjectStore('state');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB could not be opened'));
      req.onblocked = () => reject(new Error('IndexedDB is blocked'));
    });
  }
  /** run fn(transaction) in one transaction; resolves when it has been written */
  function txn(stores, mode, fn) {
    return new Promise((resolve, reject) => {
      let t;
      try {
        t = db.transaction(stores, mode);
        fn(t);
      } catch (e) {
        reject(e);
        return;
      }
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('The save was abandoned'));
    });
  }

  /* only one tab saves a page: the first one to open it */
  function takeLock() {
    if (!navigator.locks || !navigator.locks.request) return Promise.resolve(true);
    return new Promise((resolve) => {
      navigator.locks
        .request(LOCK, { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(false);
            return null;
          }
          resolve(true);
          return new Promise(() => {}); // held for as long as the page is open
        })
        .catch(() => resolve(true));
    });
  }

  /* ------------------------------------------------------------------
     files <-> saved records
     ------------------------------------------------------------------ */
  /** what identifies one version of a file: if this changes, the file is saved again */
  function sig(e) {
    const size = e.kind === 'text' ? (e.text || '').length : e.kind === 'blob' ? (e.blob && e.blob.size) || 0 : e.size || 0;
    return [e.kind, e.mtime || 0, size, e.apath || e.url || '', e.hidden ? 1 : 0, e.protected ? 1 : 0, e.mode || ''].join('|');
  }

  /** a simulated (virtual) file: its numbers and first and last lines, and a recipe when the simulation can remake it */
  function metaToRecord(meta) {
    if (!meta) return null;
    const out = { plain: {}, head: [], tail: [] };
    Object.entries(meta).forEach(([k, v]) => {
      if (v != null && ['string', 'number', 'boolean'].includes(typeof v)) out.plain[k] = v;
    });
    const lines = Math.max(0, Number(meta.lines) || 0);
    try {
      if (typeof meta.head === 'function') out.head = meta.head(Math.min(lines, 400)) || [];
    } catch (e) {
      out.head = [];
    }
    try {
      if (typeof meta.tail === 'function' && lines) out.tail = meta.tail(Math.min(lines, 200)) || [];
    } catch (e) {
      out.tail = [];
    }
    try {
      const recipe = MG.simRecipe && MG.simRecipe(meta);
      if (recipe) out.recipe = recipe;
    } catch (e) {
      /* the copy above is enough */
    }
    return out;
  }
  function metaFromRecord(m) {
    if (!m) return null;
    if (m.recipe && MG.simRebuild) {
      try {
        const meta = MG.simRebuild(m.recipe);
        if (meta) return meta;
      } catch (e) {
        /* fall back to the copy */
      }
    }
    const H = m.head || [];
    const T = m.tail || [];
    return Object.assign({}, m.plain || {}, {
      head: (n) => H.slice(0, Math.max(0, Math.min(n, H.length))),
      tail: (n) => (n > 0 ? T.slice(-n) : [])
    });
  }
  const aPath = (abs) => (MG.wasm && MG.wasm.apath ? MG.wasm.apath(abs) : '/shared/vfs' + abs);

  async function recordFromEntry(path, e) {
    const r = { path, kind: e.kind, mtime: e.mtime || Date.now() };
    if (e.hidden) r.hidden = true;
    if (e.protected) r.protected = true;
    if (e.mode) r.mode = e.mode;
    switch (e.kind) {
      case 'dir':
        break;
      case 'text':
        r.text = e.text || '';
        break;
      case 'url':
        r.url = e.url;
        r.size = e.size || 0;
        break;
      case 'blob':
        if (!e.blob) return null;
        r.blob = e.blob;
        break;
      case 'aioli': {
        // a real file made by samtools or bcftools: it lives in the WebAssembly file system
        let blob = e.saved;
        if (!blob) {
          if (!MG.wasm || !MG.wasm.ready) return null;
          const bytes = await MG.wasm.readBytes(e.apath);
          blob = new File([bytes], MG.path.basename(path));
        }
        r.blob = blob;
        r.size = blob.size;
        break;
      }
      case 'virtual':
        r.meta = metaToRecord(e.meta);
        break;
      default:
        return null;
    }
    return r;
  }
  function entryFromRecord(r) {
    const e = { mtime: r.mtime || Date.now() };
    if (r.hidden) e.hidden = true;
    if (r.protected) e.protected = true;
    if (r.mode) e.mode = r.mode;
    switch (r.kind) {
      case 'text':
        return Object.assign(e, { kind: 'text', text: r.text || '' });
      case 'url':
        return Object.assign(e, { kind: 'url', url: r.url, size: r.size || 0 });
      case 'blob':
        return r.blob ? Object.assign(e, { kind: 'blob', blob: r.blob, size: r.blob.size }) : null;
      case 'aioli':
        // written back into the WebAssembly file system when a program first needs it (tools-wasm.js)
        return r.blob ? Object.assign(e, { kind: 'aioli', apath: aPath(r.path), size: r.blob.size, saved: r.blob }) : null;
      case 'virtual': {
        const meta = metaFromRecord(r.meta);
        return meta ? Object.assign(e, { kind: 'virtual', meta }) : null;
      }
      default:
        return null;
    }
  }
  const isQuota = (e) => e && (e.name === 'QuotaExceededError' || /quota/i.test(String(e.message || e)));

  /* ------------------------------------------------------------------
     the workspace of this page
     ------------------------------------------------------------------ */
  const ws = {
    page: PAGE,
    available: false, // this browser can save (IndexedDB works here)
    readOnly: false, // the page is also open in another tab, and that one saves
    started: false, // saving starts once the page has put the saved work back
    cleared: false,
    files: new Map(), // path -> saved record
    state: new Map(), // name -> saved value
    restoredFiles: 0,
    savers: new Map(), // name -> function returning what to save (undefined: nothing to save now)
    timers: new Map(),
    fs: null,
    baseline: null, // path -> the entry the page made itself (not saved)
    savedSig: new Map(), // path -> sig of the version that is saved
    failedSig: new Map(), // path -> sig of a version that could not be saved (not tried again)
    warned: {},

    /** anything saved for this page from an earlier visit */
    hasWork() {
      return this.files.size > 0 || this.state.size > 0;
    },
    get(name) {
      return this.state.get(name);
    },
    canSave() {
      return this.available && !this.readOnly && !this.cleared;
    },

    /* ---------- files ---------- */
    /** note the files the page has made for itself, then put back the files the student made */
    restoreFiles(fs) {
      this.fs = fs;
      this.baseline = new Map(fs.entries);
      const recs = Array.from(this.files.values()).sort((a, b) => (a.kind === 'dir' ? 0 : 1) - (b.kind === 'dir' ? 0 : 1) || a.path.localeCompare(b.path));
      let n = 0;
      for (const r of recs) {
        try {
          if (r.kind === 'dir') {
            if (!fs.entries.has(r.path)) fs.mkdirp(r.path);
            continue;
          }
          const e = entryFromRecord(r);
          if (!e) continue;
          fs.put(r.path, e);
          n++;
        } catch (err) {
          console.warn('Could not restore', r.path, err);
        }
      }
      const cwd = this.state.get('cwd');
      if (cwd && fs.isDir(cwd)) fs.cwd = cwd;
      // what the file system holds now is what is saved
      this.savedSig = new Map();
      for (const [p, e] of fs.entries) if (this.baseline.get(p) !== e && this.files.has(p)) this.savedSig.set(p, sig(e));
      this.restoredFiles = n;
      return n;
    },
    /** save the files from now on, a moment after each change */
    watchFiles(fs) {
      this.fs = fs;
      if (!this.baseline) this.baseline = new Map(fs.entries);
      fs.onChange(() => this.filesSoon());
    },
    filesSoon() {
      if (!this.canSave() || !this.started) return;
      clearTimeout(this.timers.get('files'));
      this.timers.set('files', setTimeout(() => this.saveFiles(), SOON_MS));
    },
    async saveFiles() {
      if (!this.canSave() || !this.fs) return;
      if (this.savingFiles) {
        this.filesAgain = true;
        return;
      }
      this.savingFiles = true;
      try {
        do {
          this.filesAgain = false;
          const fs = this.fs;
          const current = new Set();
          const todo = [];
          for (const [p, e] of Array.from(fs.entries)) {
            if (this.baseline.get(p) === e) continue;
            current.add(p);
            const s = sig(e);
            if (this.savedSig.get(p) === s || this.failedSig.get(p) === s) continue;
            todo.push([p, e, s]);
          }
          const gone = Array.from(this.savedSig.keys()).filter((p) => !current.has(p));
          if (gone.length) {
            await txn(['files'], 'readwrite', (t) => gone.forEach((p) => t.objectStore('files').delete(KEY(p))));
            gone.forEach((p) => {
              this.savedSig.delete(p);
              this.files.delete(p);
            });
          }
          // one transaction per file, so that one file too big to keep does not stop the others
          for (const [p, e, s] of todo) {
            let rec = null;
            try {
              rec = await recordFromEntry(p, e);
            } catch (err) {
              console.warn('Could not read', p, err);
            }
            if (!rec || this.cleared) continue;
            try {
              await txn(['files'], 'readwrite', (t) => t.objectStore('files').put(rec, KEY(p)));
              this.savedSig.set(p, s);
              this.failedSig.delete(p);
              this.files.set(p, rec);
            } catch (err) {
              this.failedSig.set(p, s);
              this.problem(err, p);
            }
          }
          if (fs.cwd !== this.state.get('cwd')) await this.put('cwd', fs.cwd);
        } while (this.filesAgain && !this.cleared);
      } catch (err) {
        this.problem(err);
      } finally {
        this.savingFiles = false;
      }
    },

    /* ---------- everything else ---------- */
    /** fn() returns what to save under name (anything the browser can store); undefined means nothing to save now */
    saver(name, fn) {
      this.savers.set(name, fn);
    },
    changed(name) {
      if (!this.canSave() || !this.started || !this.savers.has(name)) return;
      clearTimeout(this.timers.get(name));
      this.timers.set(name, setTimeout(() => this.saveNow(name), SOON_MS));
    },
    async saveNow(name) {
      const fn = this.savers.get(name);
      if (!fn || !this.canSave() || !this.started) return;
      let value;
      try {
        value = await fn();
      } catch (e) {
        console.warn('Could not take a copy of', name, e);
        return;
      }
      if (value !== undefined) await this.put(name, value);
    },
    async put(name, value) {
      if (!this.canSave()) return;
      try {
        await txn(['state'], 'readwrite', (t) => t.objectStore('state').put({ name, value }, KEY(name)));
        this.state.set(name, value);
      } catch (e) {
        this.problem(e, name);
      }
    },
    /** the page has put the saved work back: from now on, changes are saved */
    start() {
      this.started = true;
    },
    /** save everything now (the page is being hidden or closed) */
    flush() {
      if (!this.canSave() || !this.started) return;
      this.timers.forEach((t) => clearTimeout(t));
      this.timers.clear();
      this.savers.forEach((fn, name) => this.saveNow(name));
      this.saveFiles();
    },
    /** delete everything saved for this page (Start again) */
    async clear() {
      this.cleared = true;
      this.timers.forEach((t) => clearTimeout(t));
      if (!db) return;
      try {
        await txn(['files', 'state'], 'readwrite', (t) => {
          t.objectStore('files').delete(RANGE());
          t.objectStore('state').delete(RANGE());
        });
      } catch (e) {
        console.warn('Could not clear the saved work', e);
      }
    },
    /** put back the workbench tab that was open last time */
    restoreBench() {
      const b = this.get('bench');
      if (b && MG.app.showWorkbench && b !== MG.app.currentBench) MG.app.showWorkbench(b, { noOpen: true });
    },

    /* ---------- telling the student ---------- */
    problem(e, what) {
      console.warn('Saving in this browser failed' + (what ? ' (' + what + ')' : ''), e);
      if (isQuota(e)) {
        if (this.warned.quota) return;
        this.warned.quota = true;
        const which = what && what.startsWith('/') ? '<b>' + esc(MG.path.basename(what)) + '</b>' : 'all your work';
        toast(`There isn't room in this browser to save ${which}, so it won't be kept if you reload the page.${MG.app && MG.app.term ? ' Use <code>download FILE</code> to keep a copy of any file you need.' : ''}`, 'warn', 12000);
      } else {
        if (this.warned.other) return;
        this.warned.other = true;
        toast('Your latest work could not be saved in this browser. Keep the page open, and download anything you need before you close it.', 'warn', 10000);
      }
    },
    showBanner(text, action) {
      let el = document.querySelector('.ws-banner');
      if (!el) {
        el = h('div.ws-banner', { role: 'status' });
        const bench = document.querySelector('.bench');
        const tabs = bench && bench.querySelector('.wb-tabs');
        if (tabs) tabs.after(el);
        else document.body.prepend(el);
      }
      el.innerHTML = '';
      el.append(h('span', { html: text }));
      if (action) {
        const b = h('button.btn.small', { type: 'button' }, action[0]);
        b.addEventListener('click', action[1]);
        el.append(b);
      }
    }
  };

  /* ------------------------------------------------------------------
     open the database and read what was saved for this page
     ------------------------------------------------------------------ */
  ws.loaded = (async () => {
    try {
      if (!window.indexedDB) throw new Error('IndexedDB is not available');
      const read = (async () => {
        db = await openDB();
        const out = {};
        await txn(['files', 'state'], 'readonly', (t) => {
          t.objectStore('files').getAll(RANGE()).onsuccess = (ev) => (out.files = ev.target.result);
          t.objectStore('state').getAll(RANGE()).onsuccess = (ev) => (out.state = ev.target.result);
        });
        return out;
      })();
      // a database that does not answer must not stop the page from working
      const out = await Promise.race([read, new Promise((resolve, reject) => setTimeout(() => reject(new Error('IndexedDB did not answer')), 8000))]);
      (out.files || []).forEach((r) => r && r.path && ws.files.set(r.path, r));
      (out.state || []).forEach((r) => r && r.name && ws.state.set(r.name, r.value));
      ws.available = true;
    } catch (e) {
      console.warn('Work cannot be saved in this browser:', e);
      ws.available = false;
      ws.files.clear();
      ws.state.clear();
    }
    if (ws.available && !(await takeLock())) {
      ws.readOnly = true;
      ws.showBanner('This page is also open in another tab or window. Carry on in that one: <b>work you do in this tab won’t be saved</b>.');
      // when the other tab closes, this one can take over after a reload
      navigator.locks.request(LOCK, () => {
        ws.showBanner('The other tab has been closed. Reload this page to carry on here with your saved work.', ['Reload', () => location.reload()]);
      });
    }
    return ws;
  })();

  bus.on('*', (d, type) => {
    if (type === 'term:command') ws.filesSoon(); // (cd changes the folder the terminal is in)
    for (const [pre, name] of ROUTES) {
      if (type.startsWith(pre)) {
        ws.changed(name);
        return;
      }
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') ws.flush();
  });
  window.addEventListener('pagehide', () => ws.flush());

  MG.workspace = ws;
  MG.workspaceNote = 'This browser isn’t keeping your work for this page (in a private window, for example), so it will be lost when you reload or close the page.';
})();
