# Genomic variant analysis – browser practicals

**Two practicals and a coursework workbench for teaching NGS variant analysis, entirely in the web browser.**

Students go from raw exome reads to a clinically meaningful variant, then learn to annotate, filter and interpret variants, and finally analyse a patient's exome for their coursework. The instructions are on the left of the screen and a workbench is on the right. Everything runs in the student's browser: a real Linux-style command line with **samtools** and **bcftools**, a **Galaxy-style workflow engine**, the **IGV** genome browser, **Ensembl VEP** annotation and a **3D protein viewer**. Nothing needs to be installed, and the site is static (HTML, CSS and JavaScript with no build step), so it can be hosted free on **GitHub Pages**.

The practicals are not numbered by week, so they can be timetabled however you like.

---

## Contents

1. [The pages](#the-pages)
2. [What is real and what is simulated](#what-is-real-and-what-is-simulated)
3. [Put it on GitHub Pages](#put-it-on-github-pages)
4. [Try it on your own computer](#try-it-on-your-own-computer)
5. [Suggested timetable](#suggested-timetable)
6. [Editing the content](#editing-the-content)
7. [Settings: `config.js`](#settings-configjs)
8. [Files](#files)
9. [Data sources and how they were made](#data-sources-and-how-they-were-made)
10. [Privacy and patient data](#privacy-and-patient-data)
11. [Browser support](#browser-support)
12. [Credits and licences](#credits-and-licences)

---

## The pages

| Page | What students do | Workbench | Time |
|---|---|---|---|
| `index.html` | Landing page linking the three pages | – | – |
| `reads-to-variants.html` – **Reads to variants** | Does NA12878 carry *CYP2C19\*2* (clopidogrel response)? Linux basics and FASTQ; FastQC; BWA-MEM and the SAM format; sorting, indexing, flagstat and idxstats; `bcftools mpileup \| bcftools call`; reading and filtering a VCF; finding *CYP2C19\*2* (heterozygous); checking it in IGV and reading the codon (Pro227, synonymous). Then the same pipeline in a Galaxy-style engine: tool forms, dataset provenance, completing and running a workflow (it produces exactly the same 218 variants). Command line vs workflow engine; quiz. | Terminal · Report (FastQC) · IGV · Workflow engine | ≈ 2½ h |
| `variants-to-meaning.html` – **Variants to meaning** | Starts from the same 218 variants. Ensembl VEP annotation (live, or saved results); consequence terms, impact, transcripts and HGVS; gnomAD frequencies; SIFT, PolyPhen-2, CADD and SpliceAI; how the “synonymous” *CYP2C19\*2* causes a 40-bp exon deletion, a frameshift and a 234-residue protein; rare-disease vs pharmacogenomic filtering funnels; star alleles, phasing and CPIC advice; the variants on CYP2C19 (4GQS), CYP2C9 (1R9O) and CYP2C8 (2NNI) in 3D; how to report a variant; quiz. | Variants (VEP table) · IGV · 3D viewer | ≈ 2 h |
| `coursework.html` – **Coursework workbench** | The Rienhoff-syndrome coursework, reworked into a real analysis: students load their copy of `daughters-reads.bam`/`.bai` (never uploaded), check it with samtools, **call variants with bcftools**, filter, annotate with VEP, prioritise with a funnel, inspect candidates in IGV, research them and show the residue in 3D. Notes boxes form a lab notebook they can download. **No answers or positions are on this page.** | Data · Terminal · Variants · IGV · 3D viewer | coursework |

Every step has a **▶ show me** button, many steps tick themselves when the student does them, and answers are saved in the student's own browser (**My answers** downloads them as an HTML file).

The revised coursework brief (Word) and the staff notes (answers, expected coursework results and a checkpoint sheet) are supplied separately. **Do not add the staff notes to this repository** – anything in a public GitHub Pages repository can be read by students.

## What is real and what is simulated

| Real (runs in the browser) | Replayed (recorded real output) |
|---|---|
| **samtools 1.17, bcftools 1.10, bgzip, tabix** compiled to WebAssembly by [biowasm](https://biowasm.com) – every `samtools`/`bcftools` command students type really runs on real files | **FastQC 0.12.1**, **BWA-MEM 0.7.19** and **FreeBayes 1.3.10** need Java or a 5 GB genome index, so the terminal replays their real output on exactly these reads (recorded when the site was built) |
| **IGV** (igv.js) with a hosted hg19 reference and RefSeq genes | The FASTQ files and the SAM file are too big to host, so they are “virtual”: `head`, `tail`, `wc -l`, `grep -c` etc. give the true answers from the real files |
| **Ensembl VEP** via its public REST server (GRCh37), with gnomAD, SIFT, PolyPhen-2, CADD and SpliceAI | The workflow engine imitates Galaxy's interface and tool names; its jobs run the same programs as the terminal |
| **NGL** 3D viewer with bundled PDB structures | |

The sorted BAM that `samtools sort` “produces” is the real BAM made from the real SAM; from `samtools index` onwards everything is computed live. Calling variants on the whole BAM takes about a minute in a browser (the page tells students so).

## Put it on GitHub Pages

1. On GitHub, create a **new repository** (e.g. `variant-practicals`). It must be public unless your plan supports Pages for private repositories.
2. Upload the site: `index.html` must be at the **top level**, with `assets/` and `data/` beside it.
   - If you received the site as two downloads, first put `aligned.sorted.bam` and `aligned.sorted.bam.bai` (from `variant-practicals-bam.zip`) into `data/reads/`. The practicals need them; they were sent separately only because of attachment size limits.
   - **In the browser:** *Add file → Upload files*, drag in the contents of the unzipped folder, *Commit changes*. (The biggest file is 22 MB, well under GitHub's 100 MB limit; the whole site is about 60 MB.)
   - **Or with git:**
     ```bash
     cd variant-practicals
     git init && git add . && git commit -m "Variant analysis practicals"
     git branch -M main
     git remote add origin https://github.com/<you>/variant-practicals.git
     git push -u origin main
     ```
3. *Settings → Pages → Build and deployment*: Source **Deploy from a branch**, branch **main**, folder **/ (root)**. Save.
4. After a minute the site is at `https://<you>.github.io/variant-practicals/`. Share the address of `index.html` (or of a single page) on Canvas.

GitHub Pages supports the HTTP range requests the page relies on (the BAM and reference files are read in pieces), and the empty file `.nojekyll` stops GitHub from processing the site.

## Try it on your own computer

Opening the HTML files directly (`file://…`) does not work – browsers block the data files. Serve the folder instead. Python's built-in server works, but it cannot serve parts of files, so a small server with range support is included:

```bash
cd variant-practicals
python3 serve.py 8000        # then open http://localhost:8000
```

## Suggested timetable

The material fits three sessions, but nothing on the site says “week 1/2/3”, so split it as suits your module. For example:

| Session | Content |
|---|---|
| A | *Reads to variants* chapters 0–6 (command line → *CYP2C19\*2* in IGV) |
| B | *Reads to variants* chapters 7–8 (workflow engine, comparison); *Variants to meaning* chapters 1–4 |
| C | *Variants to meaning* chapters 5–8; introduce the coursework and the workbench (steps A–B in class) |

## Editing the content

All text is plain HTML in the three page files. Each chapter is a `<section class="chapter" id="…" data-num="…" data-title="…" data-bench="…">`; `data-bench` chooses the workbench tab shown with it.

- **Activities:** `<li data-task="unique-id">…</li>` inside `<ol class="steps">`. Add `data-auto="EVENT key=value …"` to tick it automatically, e.g. `data-auto="term:command line~flagstat code=0"` (a terminal command containing “flagstat” that succeeded), `data-auto="gx:job tool=fastqc state=ok"` (a workflow-engine job), `data-auto="viewer:loaded id=4GQS"`. Or `data-check="name:arg"` for page checks such as `exists:results/aligned.sam`.
- **Questions:** `<div class="q" data-q="id"><div class="q-text">…</div><div class="q-model">model answer</div></div>`. Add `data-accept="regex||regex"` for a short answer checked automatically, or `data-type="mcq"` with `<div class="mcq"><label data-correct data-why="…"><input type="radio"> …</label>…</div>`. Omit `.q-model` for a notes box with no model answer (as on the coursework page).
- **▶ buttons:** `<button class="do showme" type="button" data-term="samtools index results/aligned.sorted.bam">show me</button>` types a command into the terminal (`data-term-run` also runs it). Others: `data-igv="chr10:96,541,616"` (IGV), `data-cmd="load 4gqs; isolate 4GQS A"` (3D viewer commands), `data-gx="tool:fastqc"` / `data-gx="workflows"` (workflow engine), `data-vx="saved"` / `data-vx="funnel:classic"` / `data-vx="find:chr10:96541616"` (variant table), `data-goto="chapter-id"`.
- **Extension sections:** wrap in `<div class="optional">…</div>` (not counted in progress).

The page logic lives in `assets/js/page-reads.js`, `page-meaning.js` and `page-coursework.js` (workbench set-up, Galaxy tool definitions and the workflow, filtering funnels, checks).

## Settings: `config.js`

`assets/js/config.js`:

| Setting | Meaning |
|---|---|
| `showModelAnswers` | `true`: students can reveal model answers in the two practicals after trying. `false`: the buttons are hidden (add `?answers` to a page address to see them, e.g. when demonstrating). The answers are still in the page source, so to withhold them completely remove the `q-model` blocks from your copy. The coursework page never contains answers. |
| `vepServer` | The Ensembl VEP REST server for GRCh37 (`https://grch37.rest.ensembl.org`). |
| `bundled.pdb` / `presets` | Structures stored with the site and friendly names for their chains and ligands. |

## Files

```
index.html, reads-to-variants.html, variants-to-meaning.html, coursework.html
serve.py                  local test server with range support
assets/css/               app.css (layout, shared with the molecular graphics practical) + genomics.css
assets/js/
  core.js, icons.js, tutorial.js      page framework: chapters, tasks, questions, progress, answers
  vfs.js, shell.js, terminal.js       the file system, a bash-like shell (pipes, redirects, globs) and the terminal
  tools-wasm.js                       samtools/bcftools/bgzip/tabix in WebAssembly (with safeguards for huge outputs)
  tools-sim.js                        replayed FastQC, BWA and FreeBayes; simulated FASTQ/SAM files
  fastqc.js, charts.js                FastQC report viewer
  igv-panel.js                        IGV tab (igv.js)
  workflow.js                         the Galaxy-style workflow engine
  variants.js                         VEP annotation table, filters and funnel
  viewer-*.js, commands.js, annot.js, alphafold.js, session.js   3D viewer (NGL)
  page-*.js, config.js                page set-up and settings
assets/vendor/            biowasm (Aioli + samtools/bcftools/htslib), igv.js, NGL – with licences
data/reads/               NA12878 reads practical: sorted BAM + index, masked hg19, FastQC data, recorded outputs (sim.json)
data/meaning/             the 218 filtered calls and their saved VEP annotation
data/coursework/          hg19 chromosomes 14 and 18 (masked) for the coursework – no patient data
data/annot/               RefSeq genes (chr10; chr14+18) and hg19 cytobands for IGV
data/pdb/                 4GQS, 1R9O, 2NNI, 1KTZ (BinaryCIF)
build/                    the scripts used to make data/ (for reference; paths need editing)
```

## Data sources and how they were made

- **Reads:** 1000 Genomes Project exome of NA12878 (run SRR098401, Illumina 76-bp paired-end). Read pairs whose 1000 Genomes alignment lay in chr10:95–98 Mb were extracted (153,180 pairs) and re-aligned to UCSC **hg19** with `bwa mem ref/hg19.fa R1 R2 > aligned.sam` – the students' exact command – then sorted with samtools.
- **Reference:** UCSC hg19 (GRCh37, 25 primary sequences). To keep it small, bases more than 300 bp from any read are replaced by N (the sequence near the reads is untouched and all coordinates are unchanged); it is bgzip-compressed with `.fai` and `.gzi` indexes. The coursework reference (chromosomes 14 and 18) was made the same way.
- **Recorded outputs:** FastQC 0.12.1, BWA 0.7.19 and FreeBayes 1.3.10 were run on the same files; their logs and outputs are in `data/reads/`.
- **Numbers quoted in the text** (e.g. 2,744 raw and 218 filtered calls, AD 44,48 at *CYP2C19\*2*) were produced by the in-browser bcftools 1.10 and checked against native runs.
- **VEP:** saved results come from the same Ensembl REST service the page uses. Ensembl updates its databases, so live results can differ slightly from the saved ones over time.
- **Structures:** RCSB PDB 4GQS, 1R9O, 2NNI, 1KTZ. **Genes:** NCBI RefSeq via UCSC. **Cytobands:** UCSC.

## Privacy and patient data

- The coursework BAM file is **not** part of this site. Students load their own copy from Canvas; the page reads it locally (samtools, bcftools and IGV run inside the page) and it is never uploaded.
- When a student presses **Annotate with VEP**, the chromosome, position and alleles of their variant calls (no reads, no names) are sent to Ensembl's server – the same as pasting a VCF into the VEP web page, as students were shown in previous years.
- Progress and answers are kept only in the student's browser (localStorage). No analytics, no cookies, no accounts.

## Browser support

Current Chrome, Edge, Firefox and Safari on laptops and desktops (WebAssembly, Web Workers and WebGL are required). A screen at least 1280 px wide is best; on narrow screens the workbench slides over the instructions. Calling variants needs about 1 GB of free memory.

## Credits and licences

- **samtools, bcftools, htslib** – Danecek P *et al.* (2021) *GigaScience* 10:giab008 (MIT/Expat). WebAssembly builds by **biowasm** and **Aioli** – Aboukhalil R (MIT).
- **igv.js** – Robinson JT *et al.* (2023) *Bioinformatics* 39:btac830 (MIT). **NGL Viewer** – Rose AS *et al.* (2018) *Bioinformatics* 34:3755–3758 (MIT).
- **Galaxy** (whose interface the workflow engine imitates) – The Galaxy Community (2024) *Nucleic Acids Res* 52:W83–W94.
- **Ensembl VEP** – McLaren W *et al.* (2016) *Genome Biol* 17:122; gnomAD, SIFT, PolyPhen-2, CADD and SpliceAI as cited in the pages.
- Data: 1000 Genomes Project; UCSC Genome Browser; NCBI RefSeq; RCSB PDB.
- Content adapted from the module's Galaxy variant-calling practical, IGV and cytochrome P450 tutorials, VEP walkthrough, molecular graphics tutorial and the Rienhoff-syndrome coursework.

The teaching content is adapted from the module's handouts – © 2020 Tim Hearn, with material contributed by Martin Symonds, Oliver Smart, the Babraham Bioinformatics group (Simon Andrews), the Galaxy project and the Melbourne Bioinformatics group – which are distributed under the [Creative Commons Attribution-NonCommercial-ShareAlike 2.0 UK licence](https://creativecommons.org/licenses/by-nc-sa/2.0/uk/). The adapted content is shared under the same licence. The site code may be reused and adapted; the bundled libraries keep their own licences (see `assets/vendor/`).
