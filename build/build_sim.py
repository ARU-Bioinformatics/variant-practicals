#!/usr/bin/env python3
"""Build data/reads/sim.json (+ FastQC JSON) for the 'Reads to variants' practical
from the outputs of prep_reads.sh.  usage: build_sim.py <site data dir> <hg19 index dir>"""
import gzip, json, os, re, sys, subprocess

OUT = sys.argv[1]
IDXDIR = sys.argv[2]
W = '/home/claude/data/p450'
RUN = W + '/run'
os.makedirs(OUT + '/fastqc', exist_ok=True)

def fastq_info(path):
    head, n, nbytes, tail = [], 0, 0, []
    at_start = at_any = plus_start = plus_any = 0
    with gzip.open(path, 'rt') as f:
        for line in f:
            line = line.rstrip('\n')
            if n < 400:
                head.append(line)
            tail.append(line)
            if len(tail) > 40:
                tail.pop(0)
            n += 1
            nbytes += len(line) + 1
            if line.startswith('@'): at_start += 1
            if '@' in line: at_any += 1
            if line.startswith('+'): plus_start += 1
            if '+' in line: plus_any += 1
    return {'lines': n, 'reads': n // 4, 'bytes': nbytes, 'gzBytes': os.path.getsize(path), 'head': head, 'tail': tail,
            'atStart': at_start, 'atAny': at_any, 'plusStart': plus_start, 'plusAny': plus_any}

def fastqc_json(zipdir, name):
    txt = open(zipdir + '/fastqc_data.txt').read()
    mods = []
    version = re.search(r'##FastQC\t(\S+)', txt).group(1)
    for block in re.finditer(r'>>(.+?)\t(\w+)\n(.*?)>>END_MODULE', txt, re.S):
        mname, status, body = block.group(1), block.group(2), block.group(3)
        lines = [l for l in body.split('\n') if l.strip()]
        extra = {}
        cols, rows = [], []
        for l in lines:
            if l.startswith('#Total Deduplicated Percentage'):
                extra['dedup'] = l.split('\t')[1]
                continue
            if l.startswith('#'):
                cols = l[1:].split('\t')
                continue
            rows.append(l.split('\t'))
        mods.append({'name': mname, 'status': status, 'cols': cols, 'rows': rows, 'extra': extra})
    summary = open(zipdir + '/summary.txt').read()
    return {'file': name, 'version': version, 'modules': mods}, txt, summary

d = {}
d['fastq'] = {}
for k in ('R1', 'R2'):
    name = f'NA12878_chr10_{k}.fastq.gz'
    info = fastq_info(f'{W}/{name}')
    info['name'] = name
    d['fastq'][k] = info
d['fastqc'] = {}
for k in ('R1', 'R2'):
    stem = f'NA12878_chr10_{k}'
    js, raw, summary = fastqc_json(f'{W}/{stem}_fastqc', stem + '.fastq.gz')
    json.dump(js, open(f'{OUT}/fastqc/{stem}.json', 'w'), separators=(',', ':'))
    d['fastqc'][k] = {
        'json': f'data/reads/fastqc/{stem}.json',
        'htmlBytes': os.path.getsize(f'{W}/{stem}_fastqc.html'),
        'zipBytes': os.path.getsize(f'{W}/{stem}_fastqc.zip'),
        'raw': raw,
        'summary': summary,
    }

# bwa log (stderr) – drop the CMD/real-time lines we regenerate
log = [l.rstrip('\n') for l in open(RUN + '/results/bwa.log')]
cpu = 0.0
for l in log:
    m = re.search(r'CPU: ([\d.]+) sec', l)
    if m:
        cpu = float(m.group(1))
d['bwa'] = {'log': log, 'cpuSecs': cpu}
# SAM: head / tail / counts
head, tail, n, nbytes, hdr = [], [], 0, 0, 0
with open(RUN + '/results/aligned.sam') as f:
    for line in f:
        line = line.rstrip('\n')
        if line.startswith('@'):
            hdr += 1
        if n < hdr + 60 or line.startswith('@'):
            head.append(line)
        tail.append(line)
        if len(tail) > 30:
            tail.pop(0)
        n += 1
        nbytes += len(line) + 1
flag = open(RUN + '/flagstat.sam.txt').read()
mapped = int(re.search(r'(\d+) \+ 0 mapped \(', flag).group(1))
records = int(re.search(r'(\d+) \+ 0 in total', flag).group(1))
d['bwa']['sam'] = {'lines': n, 'bytes': nbytes, 'headerLines': hdr, 'head': head, 'tail': tail, 'records': records, 'mapped': mapped}
d['bwa']['flagstat'] = flag
d['bwa']['unsortedBamBytes'] = os.path.getsize(RUN + '/aligned.unsorted.bam')
d['sorted'] = {'url': 'data/reads/aligned.sorted.bam', 'bai': 'data/reads/aligned.sorted.bam.bai', 'bytes': os.path.getsize(RUN + '/results/aligned.sorted.bam'), 'baiBytes': os.path.getsize(RUN + '/results/aligned.sorted.bam.bai')}
d['idxstats'] = open(RUN + '/idxstats.txt').read()

def nrec(p):
    if not os.path.exists(p):
        return 0
    return sum(1 for l in open(p) if not l.startswith('#'))
d['freebayes'] = {
    'default': {'url': 'data/reads/freebayes.default.vcf', 'records': nrec(OUT + '/freebayes.default.vcf')},
    'filtered': {'url': 'data/reads/freebayes.filtered.vcf', 'records': nrec(OUT + '/freebayes.filtered.vcf')},
}
# reference
fai = open(OUT + '/hg19.masked.fa.gz.fai').read()
ref_len = sum(int(l.split('\t')[1]) for l in fai.strip().split('\n'))
# real-looking head/tail of the hg19 FASTA (first contig)
first = fai.split('\t')[0]
seq = subprocess.run(['/home/claude/tools/env/bin/samtools', 'faidx', '/home/claude/data/hg19/hg19.fa', f'{first}:1-3000'], capture_output=True, text=True).stdout.split('\n')[1:]
seq = ''.join(seq)
head = ['>' + first] + [seq[i:i + 60] for i in range(0, 60 * 40, 60)]
tailseq = 'N' * 60
d['ref'] = {
    'fasta': 'data/reads/hg19.masked.fa.gz',
    'fai': 'data/reads/hg19.masked.fa.gz.fai',
    'gzi': 'data/reads/hg19.masked.fa.gz.gzi',
    'faiBytes': os.path.getsize(OUT + '/hg19.masked.fa.gz.fai'),
    'gziBytes': os.path.getsize(OUT + '/hg19.masked.fa.gz.gzi'),
    'bytes': ref_len + ref_len // 60 + 26 * 8,
    'lines': ref_len // 60 + 25,
    'head': head,
    'tail': ['>chrY'] + [tailseq] * 20,
    'bwaIndex': {ext: os.path.getsize(f'{IDXDIR}/hg19.{ext}') for ext in ('amb', 'ann', 'bwt', 'pac', 'sa')} if os.path.exists(f'{IDXDIR}/hg19.sa') else {'amb': 6663, 'ann': 939, 'bwt': 3131861752, 'pac': 782965417, 'sa': 1565930888},
}
d['readme'] = open('/home/claude/build/README_practical.txt').read()
json.dump(d, open(OUT + '/sim.json', 'w'), separators=(',', ':'))
print('sim.json', os.path.getsize(OUT + '/sim.json'))
