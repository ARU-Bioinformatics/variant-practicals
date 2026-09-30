/* =====================================================================
   Proteins in 3D – save / open a whole viewer session as a .json file
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const { toast, esc, bus } = MG;

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

  async function save() {
    const V = MG.app.viewer, UI = MG.app.vui, A = MG.app.annot;
    if (!V.structures.length) return toast('Nothing to save yet – load a structure first.', 'warn');
    const structures = [];
    for (const st of V.structures) {
      const s = { uid: st.uid, name: st.name, source: st.source, kind: st.kind };
      if (st.source.type === 'file' && st.fileBlob) {
        s.fileName = st.source.fileName;
        s.data = await blobToBase64(st.fileBlob);
      }
      structures.push(s);
    }
    const out = {
      app: 'proteins-in-3d',
      version: 1,
      saved: new Date().toISOString(),
      structures,
      viewer: V.getState(),
      annotations: A.getState(),
      views: UI.views.map((v) => ({ name: v.name, state: v.state, ann: v.ann, thumb: v.thumb, structures: v.structures }))
    };
    const name = 'session-' + V.structures.map((s) => s.name).join('-') + '.json';
    MG.downloadText(JSON.stringify(out), name, 'application/json');
    UI.log('# saved session ' + name);
    toast('Session saved as <b>' + esc(name) + '</b>. Open it later from Views → Open session.');
    bus.emit('viewer:session-saved', {});
  }

  async function open(file) {
    const V = MG.app.viewer, UI = MG.app.vui, A = MG.app.annot;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (e) {
      return toast('That file is not a session file.', 'error');
    }
    if (!data || data.app !== 'proteins-in-3d') return toast('That file is not a session saved by this page.', 'error');
    MG.app.showWorkbench && MG.app.showWorkbench('viewer');
    V.clear();
    A.clearAll();
    const uidMap = new Map();
    for (const s of data.structures || []) {
      try {
        let st;
        if (s.source && s.source.type === 'pdb') st = await V.loadPDB(s.source.id);
        else if (s.source && s.source.type === 'alphafold') st = await V.loadAlphaFold(s.source.acc);
        else if (s.data) {
          const f = new File([base64ToBlob(s.data)], s.fileName || s.name + '.pdb');
          st = await V.loadFile(f);
        } else if (s.source && s.source.url) st = await V.loadURL(s.source.url);
        if (st) uidMap.set(s.uid, st.uid);
      } catch (e) {
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
    UI.log('# opened session ' + file.name);
    toast('Session restored.');
  }
  function mapAnn(ann, uidMap) {
    const c = JSON.parse(JSON.stringify(ann));
    (c.items || []).forEach((it) => it.anchor && uidMap.has(it.anchor.uid) && (it.anchor.uid = uidMap.get(it.anchor.uid)));
    return c;
  }

  MG.session = { save, open };
})();
