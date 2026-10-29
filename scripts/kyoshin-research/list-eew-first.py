# 遠い地震ごとに、発生から 10 分以内の最初の緊急地震速報（VXSE43/44/45。訓練・試験を除く）の時刻と震央地名を拾う
# 時刻はファイル名の UTC から日本時間へ直す。控えに無い日は「控え無し」
import tarfile, glob, os, re, sys, datetime as dt
root, far_path = sys.argv[1], sys.argv[2]
J = dt.timedelta(hours=9)
idx = {}
for sub in ('eew-forecast', 'eew-warning'):
    for p in glob.glob(os.path.join(root, sub, '*.tar.gz')):
        idx.setdefault(os.path.basename(p)[:10], []).append(p)
for ln in open(far_path, encoding='utf-8'):
    t = ln.split()[0]
    origin = dt.datetime.strptime(t, '%Y-%m-%dT%H:%M')
    days = {(origin - J).strftime('%Y-%m-%d'), (origin - J + dt.timedelta(minutes=10)).strftime('%Y-%m-%d')}
    paths = [p for d in days for p in idx.get(d, [])]
    if not paths:
        print(t, '控え無し')
        continue
    best = None
    for p in paths:
        try:
            tf = tarfile.open(p)
        except Exception:
            continue
        for m in tf:
            n = os.path.basename(m.name)
            mm = re.match(r'(VXSE4[345])_RJTD_(\d{14})', n)
            if not mm or not n.endswith('.xml'):
                continue
            ts = dt.datetime.strptime(mm.group(2), '%Y%m%d%H%M%S') + J
            if not (origin - dt.timedelta(minutes=1) <= ts <= origin + dt.timedelta(minutes=10)):
                continue
            s = tf.extractfile(m).read().decode('utf-8', 'replace')
            if '<Status>通常</Status>' not in s:
                continue
            if best is None or ts < best[0]:
                nm = re.search(r'<Hypocenter>.*?<Name>([^<]+)', s, re.S)
                best = (ts, mm.group(1), nm.group(1) if nm else '')
    print(t, best[0].strftime('%H:%M:%S') + ' ' + best[1] + ' ' + best[2] if best else '発表なし')
