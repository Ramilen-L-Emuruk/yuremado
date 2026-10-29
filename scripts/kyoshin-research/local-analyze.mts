// 近くて小さな地震の窓（発生の 3 分前から 300 秒）に 4 つの判定を掛ける
// 「その地震を拾えた」= 震央から 150km 以内で、発生から 60 秒以内に出た
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { runEnsemble } from './ensemble-engine.mts'
import { runPwave, P, type Frame } from './pwave.mts'
import { kyoshinBenchCacheDir } from '../lib/kyoshinBenchCache.ts'
const repo = process.cwd().replace(/\\/g, '/')
const probeCache = kyoshinBenchCacheDir().replace(/\\/g, '/')
const sitesCache = new Map<string, [number, number][]>()
const sitesOf = (cfg: string) => { if (!sitesCache.has(cfg)) sitesCache.set(cfg, JSON.parse(readFileSync(`${probeCache}/sites_${cfg}.json`, 'utf8'))); return sitesCache.get(cfg)! }
const hav = (a: number, b: number, c: number, d: number) => { const r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 2 * 6371 * Math.asin(Math.sqrt(x)) }
type Q = { time: string; lat: number; lng: number; mag: number; depth: number; maxScale?: number }
const win = new Map((JSON.parse(readFileSync(`${repo}/scripts/kyoshin-bench/windows.json`, 'utf8')).windows as { label: string; quakes?: Q[] }[]).map(w => [w.label, w]))
// 窓は古い検知器（0b395805 のベースライン）の取りこぼしで選んだので、群分けもその版で行う
const base = JSON.parse(readFileSync(`${repo}/.cache/kyoshin-research/baseline-0b395805.json`, 'utf8')).results as Record<string, { tier: string }>
const jst = (s: string) => { const m = s.match(/(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})/)!; return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) }
// 前の試作（震度0未満の広がり）: 直前 2 分の最大値から +2 段を 5 秒・半径 150km の円の 20%
function collective(frames: Frame[], sites: [number, number][]) {
  const n = sites.length, nb: number[][] = sites.map(() => [])
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (hav(sites[i][0], sites[i][1], sites[j][0], sites[j][1]) <= 150) nb[i].push(j)
  const hist: number[][] = sites.map(() => []), run = new Int32Array(n), out: { ms: number; at: [number, number] }[] = []
  let last = -Infinity
  for (const f of frames) {
    const hit = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      const x = f.indices[i]; if (x < 0) { run[i] = 0; continue }
      const h = hist[i]; h.push(x); if (h.length > 130) h.shift()
      if (h.length < 130) continue
      let b = -99; for (let k = 0; k < h.length - 10; k++) if (h[k] > b) b = h[k]
      run[i] = x - b >= 2 ? run[i] + 1 : 0; hit[i] = run[i] >= 5 ? 1 : 0
    }
    if (f.ms - last < 60_000) continue
    for (let i = 0; i < n; i++) if (hit[i]) {
      let c = 0, t = 0; for (const j of nb[i]) { if (f.indices[j] >= 0) t++; if (hit[j]) c++ }
      if (t >= 10 && c / t >= 0.2) { out.push({ ms: f.ms, at: sites[i] }); last = f.ms; break }
    }
  }
  return out
}
function engine(frames: Frame[], sites: [number, number][]) {
  return runEnsemble(frames, sites).map(h => ({ ms: h.likelyMs, at: h.at }))
}
function pw(frames: Frame[], sites: [number, number][], r: number, nmin: number) {
  const keep = { R: P.R_KM, N: P.MIN_N }; P.R_KM = r; P.MIN_N = nmin
  try { return runPwave(frames, sites).map(f => ({ ms: f.ms, at: f.at })) } finally { P.R_KM = keep.R; P.MIN_N = keep.N }
}
const dir = `${repo}/.cache/kyoshin-local-windows`
const names = ['組み合わせ', '前の試作', 'P波100km', 'P波40km'] as const
type Row = { label: string; mag: number; missed: boolean; got: Record<string, number | null>; unrel: Record<string, number> }
const rows: Row[] = []
for (const f of readdirSync(dir).filter(x => x.endsWith('.json'))) {
  const label = f.replace('.json', '').replace(/^local-/, ''); const w = win.get(label); if (!w?.quakes?.length) continue
  const fr = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as Frame[]
  if (fr.length < 200 || !existsSync(`${probeCache}/sites_${fr[0].cfg}.json`)) continue
  const sites = sitesOf(fr[0].cfg)
  const q = w.quakes.reduce((a, b) => (b.mag ?? 0) > (a.mag ?? 0) ? b : a), t0 = jst(q.time)
  const res = { '組み合わせ': engine(fr, sites), '前の試作': collective(fr, sites), 'P波100km': pw(fr, sites, 100, 6), 'P波40km': pw(fr, sites, 40, 3) }
  const row: Row = { label, mag: q.mag, missed: base[label]?.tier === 'none', got: {}, unrel: {} }
  for (const k of names) {
    const rel = res[k].find(x => w.quakes!.some(qq => hav(qq.lat, qq.lng, x.at[0], x.at[1]) <= 150 && x.ms >= jst(qq.time) && x.ms <= jst(qq.time) + 60_000))
    row.got[k] = rel ? (rel.ms - t0) / 1000 : null
    row.unrel[k] = res[k].filter(x => x !== rel && !w.quakes!.some(qq => hav(qq.lat, qq.lng, x.at[0], x.at[1]) <= 300 && x.ms >= jst(qq.time) - 5000 && x.ms <= jst(qq.time) + 180_000)).length
  }
  rows.push(row)
}
for (const grp of [['ベンチで古い検知器が取りこぼした', true], ['ベンチで古い検知器が拾えた（M3 未満）', false]] as const) {
  const R = rows.filter(r => r.missed === grp[1])
  console.log(`== ${grp[0]}: ${R.length} 窓`)
  for (const k of names) {
    const got = R.filter(r => r.got[k] != null).map(r => r.got[k]!); got.sort((a, b) => a - b)
    const un = R.reduce((s, r) => s + r.unrel[k], 0)
    console.log(`   ${k}: 拾えた ${got.length}（発生からの秒の中央値 ${got.length ? got[got.length >> 1] : '-'}）・地震と関係ない発火 ${un}`)
  }
  for (const band of [[0, 2.5], [2.5, 3], [3, 3.5], [3.5, 9]]) {
    const B = R.filter(r => r.mag >= band[0] && r.mag < band[1]); if (!B.length) continue
    console.log(`   M${band[0]}〜${band[1] === 9 ? '' : band[1]}: ${B.length} 窓 ` + names.map(k => `${k} ${B.filter(r => r.got[k] != null).length}`).join('・'))
  }
}
