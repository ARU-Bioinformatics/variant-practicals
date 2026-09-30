#!/usr/bin/env python3
"""Annotate a VCF with the Ensembl VEP REST API (GRCh37), in batches of 150.
usage: vep_rest.py in.vcf out.json"""
import json, sys, time, urllib.request
URL = 'https://grch37.rest.ensembl.org/vep/homo_sapiens/region'
OPTS = {"canonical": 1, "hgvs": 1, "af_gnomade": 1, "af_gnomadg": 1, "CADD": 1, "numbers": 1,
        "variant_class": 1, "SpliceAI": 1, "af": 1, "protein": 1}
recs = []
for line in open(sys.argv[1]):
    if line.startswith('#'):
        continue
    f = line.rstrip('\n').split('\t')
    chrom = f[0].replace('chr', '')
    for alt in f[4].split(','):
        recs.append(f"{chrom} {f[1]} {f[2] if f[2] != '.' else '.'} {f[3]} {alt} . . .")
out = []
for i in range(0, len(recs), 150):
    body = dict(OPTS, variants=recs[i:i + 150])
    for attempt in range(5):
        try:
            req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json', 'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=120) as r:
                out.extend(json.load(r))
            break
        except Exception as e:
            print('retry', attempt, e, file=sys.stderr)
            time.sleep(3 * (attempt + 1))
    else:
        sys.exit('VEP failed')
    time.sleep(0.5)
json.dump(out, open(sys.argv[2], 'w'), separators=(',', ':'))
print(len(recs), 'variants ->', len(out), 'annotations')
