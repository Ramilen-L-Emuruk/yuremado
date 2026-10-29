// 遠い地震の P 波の頭を、走時表の到達予想にそろえて重ねる（調査用）
// 引数: フレーム JSON・震源の緯度・経度・深さ・発生時刻（日本時間 YYYY-MM-DDTHH:MM:SS）
import { readFileSync } from 'node:fs'
import { travelTimeSec } from '../../src/utils/travelTime.ts'
type Frame = { ms: number; ts: string; indices: number[]; cfg: string }
const repo = process.cwd().replace(/\\/g, '/')
const [path, latS, lngS, depS, originS] = process.argv.slice(2)
const lat0 = +latS, lng0 = +lngS, dep = +depS
const m = originS.match(/(\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+)/)!
const origin = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
const frames = JSON.parse(readFileSync(path, 'utf8')) as Frame[]
const sites = JSON.parse(readFileSync(`${repo}/.probe-cache/sites_${frames[0].cfg}.json`, 'utf8')) as [number, number][]
const hav = (a: number, b: number, c: number, d: number) => { const r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 2 * 6371 * Math.asin(Math.sqrt(x)) }
const byMs = new Map(frames.map(f => [f.ms, f]))
const t0 = frames[0].ms
// 観測点ごとの P 波到達予想（走時表の範囲 2000km 以内だけ）
const tp: (number | null)[] = sites.map(([a, b]) => {
  const km = hav(lat0, lng0, a, b)
  if (km > 1990 || km < +(process.env.DMIN ?? 0) || km > +(process.env.DMAX ?? 9999)) return null
  const t = travelTimeSec('P', km, Math.min(dep, 700))
  return Number.isFinite(t) ? origin + t * 1000 : null
})
const usable = tp.map((t, i) => t != null && t - 125_000 >= t0 ? i : -1).filter(i => i >= 0)
console.log(`観測点 ${sites.length}・到達予想が窓の中に収まる点 ${usable.length}`)
// 平常の上限: 到達予想の 125〜5 秒前の最大値（欠測は除く）
const base = new Map<number, number>()
for (const i of usable) {
  let mx = -99
  for (let t = tp[i]! - 125_000; t <= tp[i]! - 5_000; t += 1000) { const f = byMs.get(Math.round(t / 1000) * 1000); if (f && f.indices[i] >= 0) mx = Math.max(mx, f.indices[i]) }
  if (mx > -99) base.set(i, mx)
}
// 到達予想からのずれ δ ごとに、平常の上限を 1 段・2 段超えた点の割合
console.log('S-P (1100km) ' + (travelTimeSec('S', 1100, dep) - travelTimeSec('P', 1100, dep)).toFixed(0) + ' 秒・P 1100km ' + travelTimeSec('P', 1100, dep).toFixed(0) + ' 秒'); console.log('δ(秒)\t点数\t+1段超\t+2段超\t値の中央値（段）')
for (let d = -20; d <= 60; d += 2) {
  let n = 0, up1 = 0, up2 = 0; const vals: number[] = []
  for (const [i, b] of base) {
    const f = byMs.get(Math.round((tp[i]! + d * 1000) / 1000) * 1000)
    if (!f || f.indices[i] < 0) continue
    n++; const x = f.indices[i] - b; vals.push(f.indices[i])
    if (x >= 1) up1++
    if (x >= 2) up2++
  }
  vals.sort((a, b) => a - b)
  console.log(`${d}\t${n}\t${(100 * up1 / Math.max(n, 1)).toFixed(0)}%\t${(100 * up2 / Math.max(n, 1)).toFixed(0)}%\t${vals.length ? vals[vals.length >> 1] : '-'}`)
}
