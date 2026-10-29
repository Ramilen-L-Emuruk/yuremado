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

const THR = +(process.env.THR ?? 20)
type Q = { time: string; name: string; lat: number; lng: number; mag: number; depth: number; maxScale?: number }
const win = JSON.parse(readFileSync(`${repo}/scripts/kyoshin-bench/windows.json`, 'utf8')).windows as { label: string; category: string; start: string; quakes?: Q[] }[]
const jst = (s: string) => { const m = s.match(/(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})/)!; return Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]) }
const km = (a: number[], b: number[]) => { const dLat=(a[0]-b[0])*111, dLng=(a[1]-b[1])*111*Math.cos(a[0]*Math.PI/180); return Math.hypot(dLat,dLng) }
const out: Record<string, string | null> = {}
const byCat = new Map<string, { n: number; secs: number; fired: number; firedNear: number; firedFar: string[] }>()
for (const w of win) {
  let fr: Frame[]
  try { fr = JSON.parse(readFileSync(`${repo}/.probe-cache/${w.label}.json`, 'utf8')) } catch { continue }
  if (fr.length < 60) continue
  let rr
  try { rr = run(fr) } catch { continue }
  const sites = sitesOf(fr[0].cfg)
  const c = byCat.get(w.category) ?? { n: 0, secs: 0, fired: 0, firedNear: 0, firedFar: [] }
  c.n++; c.secs += rr.length
  const first = rr.find(x => x.best >= THR)
  out[w.label] = first ? first.ts : null
  if (first) {
    c.fired++
    const p = sites[first.at]
    const t = fr.find(f => f.ts === first.ts)!.ms
    // 発生前〜発生後 5 分で、震央から 1500km 以内の地震があれば「その地震」とみなす
    const near = (w.quakes ?? []).some(q => km([q.lat, q.lng], p) <= 1500 && t >= jst(q.time) - 5000 && t <= jst(q.time) + 300000)
    if (near) c.firedNear++
    else c.firedFar.push(`${w.label}@${first.ts.slice(8)}(${p[0].toFixed(1)},${p[1].toFixed(1)})max${Math.max(...rr.map(x=>x.best))}`)
  }
  byCat.set(w.category, c)
}
console.log(`閾値 ${THR}%（+${RISE} 段・${HOLD} 秒・半径 ${R_KM}km）`)
for (const [k, c] of byCat) console.log(`${k}: 窓 ${c.n}・${c.secs} 秒 発火 ${c.fired}（窓の地震に結びつく ${c.firedNear}・結びつかない ${c.fired - c.firedNear}）`)
for (const [k, c] of byCat) for (const f of c.firedFar) console.log(`  結びつかない ${k} ${f}`)

import { writeFileSync } from 'node:fs'
writeFileSync(`${process.argv[2]}/c5_${THR}.json`, JSON.stringify(out))
