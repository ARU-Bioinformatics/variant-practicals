import json, sys, collections
SO = ['transcript_ablation','splice_acceptor_variant','splice_donor_variant','stop_gained','frameshift_variant','stop_lost','start_lost','transcript_amplification','feature_elongation','feature_truncation','inframe_insertion','inframe_deletion','missense_variant','protein_altering_variant','splice_donor_5th_base_variant','splice_region_variant','splice_donor_region_variant','splice_polypyrimidine_tract_variant','incomplete_terminal_codon_variant','start_retained_variant','stop_retained_variant','synonymous_variant','coding_sequence_variant','mature_miRNA_variant','5_prime_UTR_variant','3_prime_UTR_variant','non_coding_transcript_exon_variant','intron_variant','NMD_transcript_variant','non_coding_transcript_variant','coding_transcript_variant','upstream_gene_variant','downstream_gene_variant','TFBS_ablation','TFBS_amplification','TF_binding_site_variant','regulatory_region_ablation','regulatory_region_amplification','regulatory_region_variant','intergenic_variant','sequence_variant']
R = {t:i for i,t in enumerate(SO)}
rank = lambda terms: min(R.get(t,99) for t in terms)
vcf, vep = sys.argv[1], sys.argv[2]
recs = []
for l in open(vcf):
    if l.startswith('#'): continue
    f = l.rstrip('\n').split('\t')
    fmt = f[8].split(':'); sm = dict(zip(fmt, f[9].split(':')))
    for alt in f[4].split(','):
        recs.append(dict(chrom=f[0], pos=int(f[1]), ref=f[3], alt=alt, qual=float(f[5]), gt=sm.get('GT'), ad=sm.get('AD'), key=f"{f[0].replace('chr','')}:{f[1]}:{f[3]}:{alt}"))
V = {}
for v in json.load(open(vep)):
    p = v['input'].split(); V[f'{p[0]}:{p[1]}:{p[3]}:{p[4]}'] = v
def allele(r):
    if len(r['ref']) == len(r['alt']): return r['alt']
    if r['ref'][0] == r['alt'][0]: return r['alt'][1:] or '-'
    return r['alt']
out = []
for r in recs:
    v = V.get(r['key'])
    if not v: print('no vep', r['key']); continue
    a = allele(r)
    tcs = [t for t in v.get('transcript_consequences', []) if t.get('variant_allele', a) == a]
    canon = sorted([t for t in tcs if t.get('canonical') and t.get('biotype') == 'protein_coding'], key=lambda t: rank(t['consequence_terms']))
    others = sorted(tcs, key=lambda t: (-(t.get('canonical') or 0), -(t.get('biotype') == 'protein_coding'), rank(t['consequence_terms'])))
    t = canon[0] if canon else (others[0] if others else None)
    co = [c for c in v.get('colocated_variants', []) if c.get('id') and not c['id'].startswith(('COSV','CM','CS','CD','CI','CR','CX','HM'))]
    rs = next((c['id'] for c in co if c['id'].startswith('rs')), '')
    af = None; pops = None
    for c in co:
        fr = (c.get('frequencies') or {}).get(a)
        if fr and fr.get('gnomade') is not None and af is None: af = fr['gnomade']; pops = fr
    if af is None:
        for c in co:
            fr = (c.get('frequencies') or {}).get(a)
            if fr and fr.get('gnomadg') is not None: af = fr['gnomadg']; break
    sp = t.get('spliceai') if t else None
    spmax = max(sp.get('DS_AG',0), sp.get('DS_AL',0), sp.get('DS_DG',0), sp.get('DS_DL',0)) if sp else None
    conseq = sorted(t['consequence_terms'], key=lambda x: R.get(x,99))[0] if t else v['most_severe_consequence']
    out.append(dict(r, gene=t.get('gene_symbol','') if t else '', conseq=conseq, worst=v['most_severe_consequence'], impact=t['impact'] if t else 'MODIFIER', hgvsp=((t or {}).get('hgvsp') or '').split(':')[-1], hgvsc=((t or {}).get('hgvsc') or '').split(':')[-1], rs=rs, af=af, pops=pops, sift=(t.get('sift_prediction'), t.get('sift_score')) if t else None, polyphen=(t.get('polyphen_prediction'), t.get('polyphen_score')) if t else None, cadd=t.get('cadd_phred') if t else None, spliceai=spmax, sp=sp, t=t, tcs=tcs, clin=[s for c in co for s in (c.get('clin_sig') or [])]))
print('records', len(out))
genes = collections.Counter(o['gene'] or '(intergenic)' for o in out)
print('genes', genes.most_common())
print('novel (no rs)', sum(1 for o in out if not o['rs']), [ (o['chrom'],o['pos'],o['gene'],o['conseq']) for o in out if not o['rs']])
print('impact', collections.Counter(o['impact'] for o in out))
print('conseq', collections.Counter(o['conseq'] for o in out).most_common())
hm = [o for o in out if o['impact'] in ('HIGH','MODERATE')]
print('HIGH/MOD', len(hm))
for o in hm: print('  ', o['chrom'], o['pos'], o['ref'], o['alt'], o['gt'], o['ad'], o['gene'], o['conseq'], o['hgvsp'], o['rs'], o['af'], o['sift'], o['polyphen'], o['cadd'], o['spliceai'])
rare = [o for o in out if o['af'] is None or o['af'] < 0.01]
print('rare', len(rare))
for o in rare: print('  ', o['chrom'], o['pos'], o['ref'], o['alt'], o['gene'], o['conseq'], o['impact'], o['rs'], o['af'], o['qual'], o['ad'])
print('funnel classic', len(hm), len([o for o in hm if o['af'] is None or o['af'] < 0.01]))
sp = [o for o in out if o['impact'] in ('HIGH','MODERATE') or (o['spliceai'] is not None and o['spliceai'] >= 0.5)]
print('funnel splice', len(sp), [ (o['gene'], o['pos'], o['spliceai']) for o in sp if o['impact'] not in ('HIGH','MODERATE')], len([o for o in sp if o['af'] is None or o['af'] < 0.01]))
pg = [o for o in out if o['gene'] in ('CYP2C8','CYP2C9','CYP2C19')]
pg2 = [o for o in pg if o['rs']]
pg3 = [o for o in pg2 if o['impact'] in ('HIGH','MODERATE') or (o['spliceai'] is not None and o['spliceai'] >= 0.5)]
print('funnel pgx', len(pg), len(pg2), len(pg3), [(o['gene'], o['hgvsp'], o['rs']) for o in pg3])
top = sorted([o for o in out if o['spliceai'] is not None], key=lambda o: -o['spliceai'])[:5]
print('top spliceai', [(o['gene'], o['pos'], o['conseq'], o['spliceai']) for o in top])
topc = sorted([o for o in out if o['cadd'] is not None], key=lambda o: -o['cadd'])[:6]
print('top cadd', [(o['gene'], o['pos'], o['conseq'], o['cadd']) for o in topc])
for o in out:
    if o['pos'] in (96541616, 96702047, 96798749, 96827030):
        print('**', o['pos'], o['gene'], o['conseq'], o['hgvsc'], o['hgvsp'], o['rs'], o['af'], o['cadd'], o['sp'], o['clin'])
        print('   pops', {k: v for k, v in (o['pops'] or {}).items()})
        print('   tcs', [(t.get('transcript_id'), t.get('gene_symbol'), t.get('biotype'), ','.join(t['consequence_terms']), (t.get('hgvsp') or '').split(':')[-1], t.get('canonical')) for t in o['tcs']])
