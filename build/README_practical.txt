Reads to variants - practical data
==================================

Sample     NA12878, a woman from a Utah (CEPH) family whose genome has been
           sequenced many times (HapMap, 1000 Genomes, Genome in a Bottle).
           It is used worldwide as a reference sample for testing pipelines.

Data       data/NA12878_chr10_R1.fastq.gz   read 1 of each pair
           data/NA12878_chr10_R2.fastq.gz   read 2 of each pair
           Illumina paired-end exome sequencing, 76 bases per read
           (1000 Genomes run SRR098401). Only pairs from part of
           chromosome 10 (the CYP2C gene cluster) are included, so the
           practical runs in minutes instead of hours.

Reference  ref/hg19.fa   the human reference genome, build GRCh37/hg19
           ref/hg19.fa.fai                     samtools index
           ref/hg19.fa.amb .ann .bwt .pac .sa  BWA index (made once with
                                               bwa index ref/hg19.fa)

Results    results/      empty - write your output files here

The plan
  1. check the reads            fastqc
  2. align them to the genome   bwa mem
  3. sort and index             samtools sort, samtools index
  4. call variants              bcftools mpileup | bcftools call
  5. filter and inspect         bcftools view, IGV

Type  help  to see the commands, or  man COMMAND  for help on one.
