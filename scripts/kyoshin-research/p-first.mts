import { readFileSync } from 'node:fs'
import { travelTimeSec } from '../../src/utils/travelTime.ts'
const repo = process.cwd().replace(/\\/g, '/')
const frames = JSON.parse(readFileSync(process.argv[2], 'utf8')) as { ms: number; indices: number[]; cfg: string }[]
const sites = JSON.parse(readFileSync(`${repo}/.probe-cache/sites_${frames[0].cfg}.json`, 'utf8')) as [number, number][]
const hav = (a: number, b: number, c: number, d: number) => { const r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 2 * 6371 * Math.asin(Math.sqrt(x)) }
const origin = Date.UTC(2026, 9, 16, 12, 35, 31)
const tp = sites.map(([a, b]) => { const km = hav(51.985, 157.27, a, b); return { km, t: origin + travelTimeSec('P', km, 135) * 1000 } })
const ord = tp.map((x, i) => ({ ...x, i })).sort((a, b) => a.t - b.t)
const f = (ms: number) => new Date(ms).toISOString().slice(11, 19)
console.log('最初に P 波が届く見込みの点', ord.slice(0, 3).map(o => `${sites[o.i].join(',')} ${o.km.toFixed(0)}km ${f(o.t)}`).join(' / '))
// 実時間で: 各点が「直前 2 分の最大値を 1 段以上超え、3 秒続いた」最初の時刻（P 到達予想の前後 20 秒に入ったものだけ数える）
const byMs = new Map(frames.map(x => [x.ms, x]))
const hit: number[] = []
for (const o of ord.filter(o => o.km < 1600)) {
  const i = o.i
  let run = 0
  for (let t = o.t - 20_000; t <= o.t + 20_000; t += 1000) {
    const fr = byMs.get(Math.round(t / 1000) * 1000); if (!fr || fr.indices[i] < 0) { run = 0; continue }
    let mx = -99; for (let u = t - 130_000; u <= t - 10_000; u += 1000) { const g = byMs.get(Math.round(u / 1000) * 1000); if (g && g.indices[i] >= 0) mx = Math.max(mx, g.indices[i]) }
    run = fr.indices[i] - mx >= 1 ? run + 1 : 0
    if (run >= 3) { hit.push(t); break }
  }
}
hit.sort((a, b) => a - b)
for (const k of [1, 3, 5, 10, 20, 40]) console.log(`${k} 点目が +1 段を 3 秒続けた時刻 ${hit[k - 1] ? f(hit[k - 1]) : '—'}`)
