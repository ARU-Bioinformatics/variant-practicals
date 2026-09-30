#!/bin/bash
# Build the data for the "Reads to variants" practical.
# Runs the students' exact commands in a folder laid out like the practical
# (data/ ref/ results/) so that logs and BAM headers match what they type.
# usage: prep_reads.sh <bwa index prefix> <reference fasta (indexed)> <outdir>
set -euo pipefail
export PATH=/home/claude/tools/env/bin:$PATH
IDX=$1; REF=$2; OUT=$3
W=/home/claude/data/p450
RUN=$W/run
mkdir -p $OUT $RUN/data $RUN/ref $RUN/results
for x in amb ann bwt pac sa; do ln -sf $IDX.$x $RUN/ref/hg19.fa.$x; done
ln -sf $REF $RUN/ref/hg19.fa
ln -sf $REF.fai $RUN/ref/hg19.fa.fai
ln -sf $W/NA12878_chr10_R1.fastq.gz $RUN/data/NA12878_chr10_R1.fastq.gz
ln -sf $W/NA12878_chr10_R2.fastq.gz $RUN/data/NA12878_chr10_R2.fastq.gz
cd $RUN
# 1. alignment exactly as the students will type it (paired-end, 1 thread, no read group)
if [ ! -s results/aligned.sam ] || [ "${FORCE:-0}" = 1 ]; then
  bwa mem ref/hg19.fa data/NA12878_chr10_R1.fastq.gz data/NA12878_chr10_R2.fastq.gz > results/aligned.sam 2> results/bwa.log
fi
samtools flagstat results/aligned.sam > flagstat.sam.txt
samtools sort -o results/aligned.sorted.bam results/aligned.sam
samtools index results/aligned.sorted.bam
samtools flagstat results/aligned.sorted.bam > flagstat.bam.txt
samtools idxstats results/aligned.sorted.bam > idxstats.txt
samtools view -b results/aligned.sam > aligned.unsorted.bam
# 2. masked reference: every contig in the BAM header, real sequence only near reads
samtools view -H results/aligned.sorted.bam | awk -F'\t' '$1=="@SQ"{sub("SN:","",$2); sub("LN:","",$3); print $2"\t"$3}' > genome.txt
bedtools genomecov -ibam results/aligned.sorted.bam -bg | bedtools merge -d 100 -i - > covered.bed
bedtools slop -i covered.bed -g genome.txt -b 300 | bedtools merge -i - > keep.bed
bedtools complement -i keep.bed -g genome.txt > mask.bed
bedtools maskfasta -fi $REF -bed mask.bed -fo ref.masked.fa
bgzip -f -@2 -c ref.masked.fa > $OUT/hg19.masked.fa.gz
samtools faidx $OUT/hg19.masked.fa.gz
samtools faidx ref.masked.fa
# 3. FreeBayes (recorded outputs), run as in the practical
ln -sf $RUN/ref.masked.fa $RUN/ref/hg19.masked.fa
freebayes -f ref/hg19.fa results/aligned.sorted.bam > $OUT/freebayes.default.vcf
freebayes -f ref/hg19.fa --standard-filters --min-coverage 10 results/aligned.sorted.bam > $OUT/freebayes.filtered.vcf
cp results/aligned.sorted.bam results/aligned.sorted.bam.bai $OUT/
ls -la $OUT
