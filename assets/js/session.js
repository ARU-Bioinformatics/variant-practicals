/* =====================================================================
   Proteins in 3D – save / open a whole viewer session as a .json file.
   The same snapshot is also kept in the browser as the student works
   (workspace.js), so the viewer comes back as it was after a reload.
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const { toast, esc, bus } = MG;
  let restoring = false;
  let incomplete = false; // a structure could not be reloaded: keep the saved copy until the student changes something

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }
  function base64ToBlob(b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr]);
  }
  const plain = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));

  /** everything needed to rebuild the viewer. opts.base64: structures from files as text (for a .json file);
      otherwise they are kept as Blobs (for the browser's own storage) */
  async function snapshot(opts = {}) {
    const V = MG.app.viewer, UI = MG.app.vui, A = MG.app.annot;
    if (!V || typeof V.getState !== 'function' || !A || !UI) return undefined;
    const structures = [];
    for (const st of V.structures) {
      const s = { uid: st.uid, name: st.name, source: plain(st.source), kind: st.kind };
      if (st.source.type === 'file' && st.fileBlob) {
        s.fileName = st.source.fileName;
        if (opts.base64) s.data = await blobToBase64(st.fileBlob);
        else s.blob = st.fileBlob;
      }
      structures.push(s);
    }
    return {
      app: 'proteins-in-3d',
      version: 1,
      saved: new Date().toISOString(),
      structures,
      viewer: plain(V.getState()),
      annotations: plain(A.getState()),
      views: plain(UI.views.map((v) => ({ name: v.name, state: v.state, ann: v.ann, thumb: v.thumb, structures: v.structures })))
    };
  }

  async function save() {
    const V = MG.app.viewer, UI = MG.app.vui;
    if (!V.structures.length) return toast('Nothing to save yet – load a structure first.', 'warn');
    const out = await snapshot({ base64: true });
    const name = 'session-' + V.structures.map((s) => s.name).join('-') + '.json';
    MG.downloadText(JSON.stringify(out), name, 'application/json');
    UI.log('# saved session ' + name);
    toast('Session saved as <b>' + esc(name) + '</b>. Open it later from Views → Open session.');
    bus.emit('viewer:session-saved', {});
  }

  /** rebuild the viewer from a snapshot. opts.quiet: no message when done */
  async function restore(data, opts = {}) {
    const V = MG.app.viewer, UI = MG.app.vui, A = MG.app.annot;
    restoring = true;
    let failed = 0;
    try {
      V.clear();
      A.clearAll();
      const uidMap = new Map();
      for (const s of data.structures || []) {
        try {
          let st;
          if (s.source && s.source.type === 'pdb') st = await V.loadPDB(s.source.id);
          else if (s.source && s.source.type === 'alphafold') st = await V.loadAlphaFold(s.source.acc);
          else if (s.blob || s.data) {
            const f = s.blob ? new File([s.blob], s.fileName || s.name + '.pdb') : new File([base64ToBlob(s.data)], s.fileName || s.name + '.pdb');
            st = await V.loadFile(f);
          } else if (s.source && s.source.url) st = await V.loadURL(s.source.url);
          if (st) uidMap.set(s.uid, st.uid);
        } catch (e) {
          failed++;
          toast('Could not reload ' + esc(s.name) + ': ' + esc(e.message), 'error');
        }
      }
      const mapState = (state) => {
        if (!state) return state;
        const c = JSON.parse(JSON.stringify(state));
        (c.structures || []).forEach((ss) => uidMap.has(ss.uid) && (ss.uid = uidMap.get(ss.uid)));
        return c;
      };
      V.setState(mapState(data.viewer));
      A.setState(data.annotations, uidMap);
      UI.views = (data.views || []).map((v) => Object.assign({}, v, { state: mapState(v.state), ann: v.ann ? mapAnn(v.ann, uidMap) : v.ann }));
      UI.renderViews();
      if (!opts.quiet) toast('Session restored.');
    } finally {
      restoring = false;
      incomplete = failed > 0;
    }
  }

  async function open(file) {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (e) {
      return toast('That file is not a session file.', 'error');
    }
    if (!data || data.app !== 'proteins-in-3d') return toast('That file is not a session saved by this page.', 'error');
    MG.app.showWorkbench && MG.app.showWorkbench('viewer');
    await restore(data);
    MG.app.vui.log('# opened session ' + file.name);
  }
  function mapAnn(ann, uidMap) {
    const c = JSON.parse(JSON.stringify(ann));
    (c.items || []).forEach((it) => it.anchor && uidMap.has(it.anchor.uid) && (it.anchor.uid = uidMap.get(it.anchor.uid)));
    return c;
  }

  /** what to keep in the browser (workspace.js): nothing while a session is being rebuilt, or after one
      was rebuilt only in part, until the student loads or changes something */
  function forWorkspace() {
    if (restoring || incomplete) return undefined;
    return snapshot();
  }
  bus.on('viewer:command', () => !restoring && (incomplete = false));
  bus.on('viewer:loaded', () => !restoring && (incomplete = false));

  /** when the viewer is first made: put back the scene saved in the browser last time, if there is one */
  function restoreSaved() {
    if (!MG.workspace) return;
    MG.workspace.loaded.then((ws) => {
      const saved = ws.get('viewer');
      if (saved && saved.structures && saved.structures.length && MG.app.viewer && typeof MG.app.viewer.getState === 'function') restore(saved, { quiet: true }).catch((e) => console.warn(e));
    });
  }

  MG.session = { save, open, snapshot, restore, forWorkspace, restoreSaved };
})();
