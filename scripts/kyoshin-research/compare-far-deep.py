import re,sys,statistics,os
S=sys.argv[1]
def sec(h): h=h.replace(':',''); return int(h[0:2])*3600+int(h[2:4])*60+int(h[4:6])
pw={}
for ln in open(os.path.join(S,'pwave_100_6_0.3.txt'),encoding='utf-8'):
    m=re.match(r'遠・深 (\S+)\t(\S+)',ln)
    if m: pw[m.group(1)]=None if m.group(2)=='—' else m.group(2)[:8]
co={};en={}
for ln in open(os.path.join(S,os.environ.get('FAR', 'far-analyze2.txt')),encoding='utf-8'):
    p=ln.rstrip('\n').split('\t')
    if len(p)<4: continue
    lab=p[0]; j=re.search(r'判定 (\d{6}|—)',p[2]); e=re.search(r'likely (\d{6}|—)',p[3])
    co[lab]=None if not j or j.group(1)=='—' else j.group(1)
    en[lab]=None if not e or e.group(1)=='—' else e.group(1)
ee={}
for ln in open(os.path.join(S,'eew_fardeep.txt'),encoding='utf-8'):
    p=ln.split()
    lab='far-'+p[0][:10].replace('-','')+'-'+p[0][11:16].replace(':','')
    ee[lab]=p[1] if re.match(r'\d\d:\d\d:\d\d',p[1]) else None
info={}
for ln in open(os.path.join(S,'fardeep.txt'),encoding='utf-8'):
    p=ln.split()
    lab='far-'+p[0][:10].replace('-','')+'-'+p[0][11:16].replace(':','')
    info[lab]=(p[1],float(p[2]),p[5])
info['kamchatka']=('カムチャツカ半島付近',6.9,'135'); ee['kamchatka']='12:38:27'
rows=[]
for lab in sorted(pw):
    if lab not in info: continue
    name,M,dep=info[lab]; deep=dep!='None' and float(dep)>=250
    rows.append((lab,name,M,dep,deep,pw.get(lab),co.get(lab),en.get(lab),ee.get(lab)))
def first(*ts):
    v=[sec(t) for t in ts if t]; return min(v) if v else None
for grp,flag in (('深さ250km以上',True),('遠い地震（日本の陸の外・浅め）',False)):
    R=[r for r in rows if r[4]==flag]
    n=len(R); a=sum(1 for r in R if r[5]); b=sum(1 for r in R if r[6]); c=sum(1 for r in R if r[7]); ev=sum(1 for r in R if r[8])
    print(f'== {grp}: {n} 件  P波判定 {a}・前の試作 {b}・エンジン {c}・EEW {ev}')
    only=[r for r in R if r[5] and not r[7]]
    print(f'   P波判定だけ出た（エンジンは出ない）: {len(only)} 件')
    d_en=[sec(r[5])-sec(r[7]) for r in R if r[5] and r[7]]
    if d_en: print(f'   P波判定−エンジン: 中央値 {statistics.median(d_en)} 秒・P波判定が先 {sum(x<0 for x in d_en)}/{len(d_en)}')
    d_co=[sec(r[5])-sec(r[6]) for r in R if r[5] and r[6]]
    if d_co: print(f'   P波判定−前の試作: 中央値 {statistics.median(d_co)} 秒・P波判定が先 {sum(x<0 for x in d_co)}/{len(d_co)}')
    d_ee=[sec(r[5])-sec(r[8]) for r in R if r[5] and r[8]]
    if d_ee: print(f'   P波判定−EEW第1報: 中央値 {statistics.median(d_ee)} 秒・P波判定が先 {sum(x<0 for x in d_ee)}/{len(d_ee)}')
    d_first=[sec(r[5])-first(r[6],r[7]) for r in R if r[5] and first(r[6],r[7]) is not None]
    if d_first: print(f'   P波判定−（前の試作とエンジンの早い方）: 中央値 {statistics.median(d_first)} 秒・先 {sum(x<0 for x in d_first)}/{len(d_first)}')
print()
print('地震\tM\t深さ\tP波判定\t前の試作\tエンジン\tEEW')
for r in rows:
    if r[2]>=6.5 or r[0]=='kamchatka' or (r[5] and not r[7]):
        print(f"{r[0][4:] if r[0]!='kamchatka' else '20261016-1235'} {r[1]}\tM{r[2]}\t{r[3]}\t{r[5] or '—'}\t{(r[6] or '—')}\t{r[7] or '—'}\t{r[8] or '—'}")
