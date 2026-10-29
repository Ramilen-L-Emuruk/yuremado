# 電文の控え（地震情報）から、震央が日本の陸の外か深さ 300km 以上で、日本で震度が付いた M6.0 以上を拾う
# 2020 年以降（Yahoo が持つ範囲）。出力は UTF-8 でファイルへ
import tarfile, glob, re, os, sys
root, out_path = sys.argv[1], sys.argv[2]
rows = {}
for p in sorted(glob.glob(os.path.join(root, '*.tar.gz'))):
    if os.path.basename(p)[:4] < '2020':
        continue
    try:
        t = tarfile.open(p)
    except Exception:
        continue
    for m in t:
        n = os.path.basename(m.name)
        if not (n.startswith('VXSE53') and n.endswith('.xml')):
            continue
        s = t.extractfile(m).read().decode('utf-8', 'replace')
        o = re.search(r'<OriginTime>([^<]+)', s)
        nm = re.search(r'<Hypocenter>.*?<Name>([^<]+)', s, re.S)
        mg = re.search(r'<jmx_eb:Magnitude[^>]*>([^<]+)<', s)
        co = re.search(r'<jmx_eb:Coordinate[^>]*>([+-][\d.]+)([+-][\d.]+)([+-]\d+)?/', s)
        mi = re.search(r'<Observation>\s*<CodeDefine>.*?</CodeDefine>\s*<MaxInt>([^<]+)', s, re.S)
        if not (o and nm and mg and co and mi):
            continue
        try:
            M = float(mg.group(1)); lat = float(co.group(1)); lng = float(co.group(2))
        except ValueError:
            continue
        dep = -int(co.group(3)) / 1000 if co.group(3) else None
        outside = False
        deep = dep is not None and dep >= 250
        if M >= 4.0 and deep:
            rows[o.group(1)[:16]] = (nm.group(1), M, lat, lng, dep, mi.group(1))
with open(out_path, 'w', encoding='utf-8') as f:
    for k in sorted(rows):
        f.write(' '.join(map(str, (k,) + rows[k])) + '\n')
print(len(rows))
