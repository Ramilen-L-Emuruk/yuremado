import json,sys,statistics
fire=json.load(open(sys.argv[1]))
b=json.load(open('scripts/kyoshin-bench/baseline.json',encoding='utf-8'))['results']
w={x['label']:x for x in json.load(open('scripts/kyoshin-bench/windows.json',encoding='utf-8'))['windows']}
def fsec(ts): return int(ts[8:10])*3600+int(ts[10:12])*60+int(ts[12:14])
def hsec(h): a,b_,c=map(int,h.split(':')); return a*3600+b_*60+c
def scale(s):
    return {10:'1',20:'2',30:'3',40:'4',45:'5弱',50:'5強',55:'6弱',60:'6強',70:'7'}.get(s,str(s))
groups={}
for lab,ts in fire.items():
    x=w.get(lab); r=b.get(lab)
    if not x or not r or x['category'] not in ('catalog','positive','major') or not x.get('quakes'): continue
    q=max(x['quakes'],key=lambda q:q.get('mag') or 0)
    m=q.get('mag') or 0; d=q.get('depth') or 0; s=q.get('maxScale') or 0
    if d>=200: g='深さ200km以上'
    elif m>=6: g='M6以上'
    elif m>=5: g='M5台'
    elif m>=4: g='M4台'
    elif m>=3: g='M3台'
    else: g='M3未満'
    G=groups.setdefault(g,{'n':0,'new':0,'eng':0,'both':0,'newonly':0,'engonly':0,'diff':[]})
    G['n']+=1
    eng=r['tier']!='none'
    G['new']+= ts is not None; G['eng']+=eng
    if ts and eng and r.get('firstLikely'): G['both']+=1; G['diff'].append(fsec(ts)-hsec(r['firstLikely']))
    elif ts and not eng: G['newonly']+=1
    elif eng and not ts: G['engonly']+=1
order=['M3未満','M3台','M4台','M5台','M6以上','深さ200km以上']
print('区分\t窓\t新しい判定\tエンジン\t新だけ\tエンジンだけ\t両方の差(新−エンジン)中央値\t新が先')
for g in order:
    G=groups.get(g)
    if not G: continue
    d=G['diff']
    print(f"{g}\t{G['n']}\t{G['new']}\t{G['eng']}\t{G['newonly']}\t{G['engonly']}\t{statistics.median(d) if d else '-'}秒\t{sum(v<0 for v in d)}/{len(d)}")
