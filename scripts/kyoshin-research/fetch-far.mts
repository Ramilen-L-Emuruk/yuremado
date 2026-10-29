// 遠い地震・深発地震の窓を Yahoo 強震モニタから取る（調査用）。DRY=1 で URL を数えるだけ
// 窓 = 最寄りの観測点への P 波到達の見込み（直線距離 / 7.5 km/s）の 120 秒前から 300 秒
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { kyoshinBenchCacheDir } from '../lib/kyoshinBenchCache.ts'
const repo = process.cwd().replace(/\\/g, '/')
const probeCache = kyoshinBenchCacheDir().replace(/\\/g, '/')
const OUT = `${repo}/.cache/kyoshin-far-windows`
const SECONDS = 300
const DRY = process.env.DRY === '1'
const sites = JSON.parse(readFileSync(`${probeCache}/sites_20260123000000.json`, 'utf8')) as [number, number][]
const lines = readFileSync(process.argv[2], 'utf8').trim().split('\n')
const hav = (a: number, b: number, c: number, d: number) => {
  const r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(x))
}
const p = (n: number) => String(n).padStart(2, '0')
type Job = { label: string; startMs: number }
const jobs: Job[] = []
for (const ln of lines) {
  const [t, name, M, lat, lng, dep] = ln.split(' ')
  if (t.startsWith('2026-10-16T12:35')) continue // 取得済み
  const [d0, hm] = t.split('T')
  const [Y, Mo, D] = d0.split('-').map(Number); const [h, mi] = hm.split(':').map(Number)
  const origin = Date.UTC(Y, Mo - 1, D, h, mi, 0) // 日本時間の壁時計を UTC として扱う（ベンチと同じ物差し）
  let dmin = Infinity
  for (const [a, b] of sites) dmin = Math.min(dmin, hav(+lat, +lng, a, b))
  const depth = dep === 'None' ? 10 : +dep
  const tt = Math.hypot(dmin, depth) / 7.5
  jobs.push({ label: `far-${d0.replaceAll('-', '')}-${p(h)}${p(mi)}`, startMs: origin + Math.round(tt) * 1000 - 120_000 })
  console.log(`${t} ${name} M${M} 最寄り ${dmin.toFixed(0)}km 見込み ${tt.toFixed(0)} 秒`)
}
const todo = jobs.filter(j => !existsSync(`${OUT}/${j.label}.json`))
console.log(`窓 ${jobs.length}（未取得 ${todo.length}）・取得予定 ${todo.length * SECONDS} 件（エッジを替えて取り直す分を除く）`)
if (DRY) process.exit(0)
mkdirSync(OUT, { recursive: true })
let req = 0
async function one(ms: number) {
  const d = new Date(ms)
  const dateStr = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
  const ts = `${dateStr}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  for (const edge of ['west', 'east']) {
    req++
    try {
      const r = await fetch(`https://weather-kyoshin.${edge}.edge.storage-yahoo.jp/RealTimeData/${dateStr}/${ts}.json`)
      if (!r.ok) continue
      const j = (await r.json()) as { realTimeData?: { siteConfigId?: string; intensity?: string } }
      const rt = j.realTimeData
      if (!rt?.intensity) continue
      return { ms, ts, indices: Array.from(rt.intensity, c => c.charCodeAt(0) - 100), cfg: rt.siteConfigId ?? '' }
    } catch { /* 次のエッジへ */ }
  }
  return null
}
for (const j of todo) {
  const frames: unknown[] = []
  for (let i = 0; i < SECONDS; i += 4) {
    const got = await Promise.all([0, 1, 2, 3].filter(k => i + k < SECONDS).map(k => one(j.startMs + (i + k) * 1000)))
    for (const g of got) if (g) frames.push(g)
  }
  writeFileSync(`${OUT}/${j.label}.json`, JSON.stringify(frames))
  console.log(`${j.label} 取れた ${frames.length}/${SECONDS} 通算リクエスト ${req}`)
}
