# How the data were made

These scripts produced the files in `data/`. They are kept for reference and
will need their paths edited before re-use. Tools used: bwa 0.7.19, samtools
1.24 (native), bedtools, htslib bgzip, FreeBayes 1.3.10, FastQC 0.12.1, and
Python 3.

1. `prep_reads.sh <bwa index prefix> <hg19.fa> <outdir>` – runs the students'
   exact commands (`bwa mem ref/hg19.fa R1 R2 > results/aligned.sam`,
   `samtools sort`, `samtools index`) in a folder laid out like the practical,
   makes the masked reference (N more than 300 bp from any read), and records
   FreeBayes with default settings and with
   `--standard-filters --min-coverage 10`.
2. `build_sim.py <data/reads> <hg19 index dir>` – writes `data/reads/sim.json`
   (FASTQ heads/tails and exact line/grep counts, the BWA log, the SAM head,
   flagstat, reference details) and the FastQC JSON files.
3. The variant calls in `data/meaning/calls.filtered.vcf` were made in the
   browser with the page's own bcftools 1.10 (WebAssembly), then annotated with
   `vep_rest.py calls.filtered.vcf calls.filtered.vep.json` (Ensembl REST,
   GRCh37). `analyse_vep.py` summarises an annotated VCF the way the page does.
