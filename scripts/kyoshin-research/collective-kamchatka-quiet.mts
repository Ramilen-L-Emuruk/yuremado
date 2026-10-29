// 「平常値から +1.0 以上を 5 秒続けた点」が、半径 150km の円の中に何点あるか（最大の円）を秒ごとに数える。
// カムチャツカの日と、ベンチの平常時の窓（quiet / negative）で比べる。
import { readFileSync, readdirSync } from 'node:fs'
type Frame = { ms: number; ts: string; indices: number[]; cfg: string }
const repo = process.cwd().replace(/\\/g, '/')
const BASE_SEC = 120, HOLD = 5, RISE = +(process.env.RISE ?? 1), R_KM = 150
const sitesCache = new Map<string, [number, number][]>()
const sitesOf = (cfg: string) => {
  if (!sitesCache.has(cfg)) sitesCache.set(cfg, JSON.parse(readFileSync(`${repo}/.probe-cache/sites_${cfg}.json`, 'utf8')))
  return sitesCache.get(cfg)!
}
const nbCache = new Map<string, number[][]>()
function neighbors(cfg: string) {
  if (nbCache.has(cfg)) return nbCache.get(cfg)!
  const s = sitesOf(cfg)
  const out: number[][] = s.map(() => [])
  for (let i = 0; i < s.length; i++) for (let j = 0; j < s.length; j++) {
    const dLat = (s[i][0] - s[j][0]) * 111, dLng = (s[i][1] - s[j][1]) * 111 * Math.cos(s[i][0] * Math.PI / 180)
    if (dLat * dLat + dLng * dLng <= R_KM * R_KM) out[i].push(j)
  }
  nbCache.set(cfg, out); return out
}
// 返り値: 秒ごとの「最大の円の中の点数」
function run(frames: Frame[]): { ts: string; best: number; at: number }[] {
  const cfg = frames[0].cfg
  const nb = neighbors(cfg); const n = sitesOf(cfg).length
  const hist: number[][] = Array.from({ length: n }, () => [])
  const run_: number[] = new Array(n).fill(0)
  const res: { ts: string; best: number; at: number }[] = []
  for (const f of frames) {
    if (f.cfg !== cfg) break
    const hit = new Array(n).fill(false)
    for (let i = 0; i < n; i++) {
      const x = f.indices[i]
      if (x < 0) { run_[i] = 0; continue }
      const h = hist[i]
      h.push(x); if (h.length > BASE_SEC + 10) h.shift()
      if (h.length >= 40) {
        let base = -99
        for (let k = 0; k < h.length - 10; k++) if (h[k] > base) base = h[k]
        run_[i] = x - base >= RISE ? run_[i] + 1 : 0
        hit[i] = run_[i] >= HOLD
      }
    }
    let best = 0, at = -1
    for (let i = 0; i < n; i++) if (hit[i]) {
      let c = 0, tot = 0; for (const j of nb[i]) { if (f.indices[j] >= 0) tot++; if (hit[j]) c++ }
      const score = tot >= 10 ? Math.round(100 * c / tot) : 0
      if (score > best) { best = score; at = i }
    }
    res.push({ ts: f.ts, best, at })
  }
  return res
}
const S = process.argv[2]
const kam = JSON.parse(readFileSync(`${S}/kamchatka.json`, 'utf8')) as Frame[]
const r = run(kam)
const s = sitesOf(kam[0].cfg)
const pre = r.filter(x => x.ts.slice(8) >= '123500' && x.ts.slice(8) < '123805')
console.log('カムチャツカの日: 揺れの前（12:35:00〜12:38:04）の最大', Math.max(...pre.map(x => x.best)))
for (const x of r) { const t = x.ts.slice(8); if (t >= '123806' && t <= '123850') console.log(t, x.best, x.at >= 0 ? s[x.at].map(v => v.toFixed(2)).join(',') : '') }

// 平常時の窓
const win = JSON.parse(readFileSync(`${repo}/scripts/kyoshin-bench/windows.json`, 'utf8')).windows as { label: string; category: string }[]
const cats = ['quiet', 'negative']
const dist: number[] = []
let files = 0, secs = 0
const worst: [number, string, string][] = []
for (const w of win.filter(w => cats.includes(w.category))) {
  let fr: Frame[]
  try { fr = JSON.parse(readFileSync(`${repo}/.probe-cache/${w.label}.json`, 'utf8')) } catch { continue }
  if (fr.length < 60) continue
  files++
  const rr = run(fr).slice(30)
  secs += rr.length
  let m = 0, mt = ''
  for (const x of rr) { dist.push(x.best); if (x.best > m) { m = x.best; mt = x.ts } }
  worst.push([m, w.label, mt])
}
worst.sort((a, b) => b[0] - a[0])
const cnt = (k: number) => dist.filter(v => v >= k).length
console.log(`平常時の窓 ${files} 本・${secs} 秒（${cats.join('/')}）`)
for (const k of [5, 10, 15, 20, 30, 40, 50]) console.log(`  円の中の割合 ${k}% 以上: ${cnt(k)} 秒`)
console.log('  上位', worst.slice(0, 8).map(w => `${w[1]}:${w[0]}@${w[2].slice(8)}`).join(' '))
