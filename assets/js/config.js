/* =====================================================================
   SITE SETTINGS – edit this file to adapt the practicals.
   (No build step: edit, commit, and GitHub Pages updates.)
   ===================================================================== */
window.MG_CONFIG = {
  courseTitle: 'Genomic variant analysis',
  courseSubtitle: 'MSc Molecular Genetics & Bioinformatics',

  /* Model answers in the two practicals.
     true  – students can reveal a model answer after attempting a question
     false – "Show answer" buttons are hidden (add ?answers to the page
             address to see them, e.g. when demonstrating in class).
     The coursework page never contains answers. */
  showModelAnswers: true,

  /* Where the browser keeps each student's progress (localStorage prefix) */
  storePrefix: 'genomics',

  /* samtools / bcftools / htslib compiled to WebAssembly (biowasm) */
  biowasmBase: 'assets/vendor/biowasm',

  /* Ensembl VEP server for GRCh37/hg19 (the build used throughout) */
  vepServer: 'https://grch37.rest.ensembl.org',

  /* Structures stored with the site, so that chain names and numbering
     always match the text. Anything else is fetched live from the PDB. */
  preferBundledData: true,
  bundled: {
    pdb: {
      '4GQS': 'data/pdb/4gqs.bcif',
      '1R9O': 'data/pdb/1r9o.bcif',
      '2NNI': 'data/pdb/2nni.bcif',
      '1KTZ': 'data/pdb/1ktz.bcif'
    },
    alphafold: {},
    uniprot: {}
  },

  /* Friendly names for chains and ligands ('sele' uses NGL selection
     language: [RES] = residue name, :A = chain A) */
  presets: {
    '4GQS': {
      chainNames: { A: 'CYP2C19', B: 'CYP2C19 copy 2', C: 'CYP2C19 copy 3', D: 'CYP2C19 copy 4' },
      groups: [
        { name: 'Haem', short: 'haem', sele: '[HEM] and :A', desc: 'Iron protoporphyrin IX of chain A – the catalytic centre, bound to Cys435' },
        { name: 'Inhibitor', short: 'inhibitor', sele: '[0XV] and :A', desc: 'A benzbromarone-like inhibitor in the active site of chain A', carbon: '#c026d3' },
        { name: 'Haem (copies 2–4)', short: 'haem2', sele: '[HEM] and not :A' },
        { name: 'Inhibitor (copies 2–4)', short: 'inhibitor2', sele: '[0XV] and not :A', carbon: '#c026d3' },
        { name: 'Glycerol', short: 'glycerol', sele: '[GOL]', kind: 'other' }
      ]
    },
    '1R9O': {
      chainNames: { A: 'CYP2C9' },
      groups: [
        { name: 'Haem', short: 'haem', sele: '[HEM]', desc: 'Iron protoporphyrin IX – the catalytic centre, bound to Cys435' },
        { name: 'Flurbiprofen', short: 'flurbiprofen', sele: '[FLP]', desc: 'The NSAID flurbiprofen, a CYP2C9 substrate', carbon: '#c026d3' },
        { name: 'Glycerol', short: 'glycerol', sele: '[GOL]', kind: 'other' }
      ]
    },
    '2NNI': {
      chainNames: { A: 'CYP2C8' },
      groups: [
        { name: 'Haem', short: 'haem', sele: '[HEM]', desc: 'Iron protoporphyrin IX – the catalytic centre, bound to Cys435' },
        { name: 'Montelukast', short: 'montelukast', sele: '[MTK]', desc: 'The asthma drug montelukast, a CYP2C8 inhibitor', carbon: '#c026d3' },
        { name: 'Palmitic acid', short: 'palmitate', sele: '[PLM]', kind: 'other' },
        { name: 'Sulfate', short: 'sulfate', sele: '[SO4]', kind: 'ion' }
      ]
    }
  }
};
