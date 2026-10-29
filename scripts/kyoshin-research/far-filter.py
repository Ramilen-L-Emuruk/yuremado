# 遠い地震・深発地震の窓で、その地震の波とみなせる検知だけを残して数え直す
# 使い方: python -X utf8 far-filter.py <$S> <.probe-cache のパス>
#
# 窓の頭は「分で切り捨てた発生時刻 + 最寄りの観測点への P 波の見込み − 120 秒」（fetch-far.mts）。
# 発生時刻を切り捨てているので、本当の P 波は見込み（窓の頭 + 120 秒）と同じか、最大 60 秒遅い。
# 残す検知:
#   時刻 — 見込みの 5 秒前から 120 秒後まで（前に出たものは P 波より前で、その地震ではない）
#   場所 — 重心が「震源から最寄りの観測点までの距離 + 300 km」より内側（日本の反対側で鳴ったものを外す）
# 組み合わせ（far-ensemble-hits.txt）と P 波の判定（pwave_100_6_0.3.txt）の両方に同じ条件を掛ける。
import json, math, os, re, statistics, sys

S, PROBE = sys.argv[1], sys.argv[2]
REPO = os.path.abspath(os.path.join(S, '..', '..'))
T_MIN, T_MAX, SLACK_KM = -5, 120, 300

def hav(a, b, c, d):
    r = math.pi / 180
    x = math.sin((c - a) * r / 2) ** 2 + math.cos(a * r) * math.cos(c * r) * math.sin((d - b) * r / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(x))

def sec(hms):
    hms = hms.replace(':', '')
    return int(hms[0:2]) * 3600 + int(hms[2:4]) * 60 + int(hms[4:6])

# 震源（far_felt.txt と deep_felt.txt。fardeep.txt は両方を合わせた一覧）
quake = {}
deep = set()
for name in ('far_felt.txt', 'deep_felt.txt'):
    for ln in open(os.path.join(S, name), encoding='utf-8'):
        p = ln.split()
        if len(p) < 6:
            continue
        t, lat, lng = p[0], float(p[-4]), float(p[-3])
        d0, hm = t.split('T')
        label = f"far-{d0.replace('-', '')}-{hm.replace(':', '')}"
        quake[label] = (lat, lng)
        if name == 'deep_felt.txt':
            deep.add(label)

# EEW 第 1 報（compare-far-deep の表の EEW 列）
eew = {}
for ln in open(os.path.join(S, 'compare-far-deep-ensemble.txt'), encoding='utf-8'):
    p = ln.rstrip('\n').split('\t')
    if len(p) == 7 and p[0] != '地震' and p[6] != '—':
        eew['far-' + p[0].split()[0]] = sec(p[6])

def window_info(label):
    fr = json.load(open(os.path.join(REPO, '.cache', 'kyoshin-far-windows', label + '.json'), encoding='utf-8'))
    sites = json.load(open(os.path.join(PROBE, f"sites_{fr[0]['cfg']}.json"), encoding='utf-8'))
    lat, lng = quake[label]
    dmin = min(hav(lat, lng, a, b) for a, b in sites)
    return sec(fr[0]['ts'][8:14]) + 120, dmin

def ok(label, rel, at, dmin):
    lat, lng = quake[label]
    return T_MIN <= rel <= T_MAX and hav(lat, lng, at[0], at[1]) <= dmin + SLACK_KM

ens = {}
for ln in open(os.path.join(S, 'far-ensemble-hits.txt'), encoding='utf-8'):
    label, rest = ln.rstrip('\n').split('\t')
    if label not in quake:
        continue
    p0, dmin = window_info(label)
    hits = []
    for l, c, a, b in re.findall(r'(-?\d+)/(—|-?\d+)@(-?[\d.]+),(-?[\d.]+)', rest):
        hits.append((int(l), None if c == '—' else int(c), (float(a), float(b))))
    keep = [h for h in hits if ok(label, h[0], h[2], dmin)]
    first_l = min((h[0] for h in keep), default=None)
    first_c = min((h[1] for h in keep if h[1] is not None and h[1] >= T_MIN), default=None)
    ens[label] = (p0, dmin, first_l, first_c, len(hits) - len(keep))

pw = {}
for ln in open(os.path.join(S, 'pwave_100_6_0.3.txt'), encoding='utf-8'):
    m = re.match(r'遠・深 (\S+)\t(.*)', ln.rstrip('\n'))
    if not m or m.group(1) not in ens:
        continue
    label = m.group(1)
    p0, dmin = ens[label][0], ens[label][1]
    firsts = [sec(t) - p0 for t, a, b in re.findall(r'(\d\d:\d\d:\d\d)\([^@]*@(-?[\d.]+),(-?[\d.]+)\)', m.group(2))
              if ok(label, sec(t) - p0, (float(a), float(b)), dmin)]
    pw[label] = min(firsts, default=None)

for grp, members in (('深さ 250km 以上', [l for l in ens if l in deep]), ('陸の外・浅め', [l for l in ens if l not in deep])):
    n = len(members)
    el = [l for l in members if ens[l][2] is not None]
    ec = [l for l in members if ens[l][3] is not None]
    pl = [l for l in members if pw.get(l) is not None]
    both = [l for l in members if ens[l][2] is not None and pw.get(l) is not None]
    diff = [pw[l] - ens[l][2] for l in both]
    only_pw = [l for l in pl if ens[l][2] is None]
    dropped = sum(ens[l][4] for l in members)
    print(f'== {grp}: {n} 窓')
    print(f'   組み合わせ 早い段 {len(el)}・確かな段 {len(ec)}・P 波の判定 {len(pl)}・P 波の判定だけ {len(only_pw)} {only_pw}')
    if diff:
        print(f'   P 波の判定 − 組み合わせ（早い段）: 中央値 {statistics.median(diff)} 秒・P 波の判定が先 {sum(d < 0 for d in diff)}/{len(diff)}')
    ed = [ens[l][2] + ens[l][0] - eew[l] for l in members if l in eew and ens[l][2] is not None]
    if ed:
        print(f'   組み合わせ（早い段）− EEW 第 1 報: {sorted(ed)} 中央値 {statistics.median(ed)}・先 {sum(d < 0 for d in ed)}/{len(ed)}')
    print(f'   外した検知 {dropped} 件')
