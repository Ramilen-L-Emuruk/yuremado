// 遠い地震・深発地震の窓を Yahoo 強震モニタから取る（調査用）。DRY=1 で URL を数えるだけ
// 窓 = 最寄りの観測点への P 波到達の見込み（直線距離 / 7.5 km/s）の 120 秒前から 300 秒
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
const repo = process.cwd().replace(/\\/g, '/')
const OUT = `${repo}/.cache/kyoshin-local-windows`
const SECONDS = 300
const DRY = process.env.DRY === '1'
const win = JSON.parse(readFileSync(repo + '/scripts/kyoshin-bench/windows.json', 'utf8')).windows as { label: string; category: string; quakes?: { time: string; mag: number }[] }[]
const base = JSON.parse(readFileSync(repo + '/scripts/kyoshin-bench/baseline.json', 'utf8')).results as Record<string, { tier: string }>
const p = (n: number) => String(n).padStart(2, '0')
type Job = { label: string; startMs: number }
const jobs: Job[] = []
const cat = win.filter(w => w.category === 'catalog' && w.quakes?.length && base[w.label])
const miss = cat.filter(w => base[w.label].tier === 'none')
const hitSmall = cat.filter(w => base[w.label].tier !== 'none' && Math.max(...w.quakes!.map(q => q.mag ?? 0)) < 3).slice(0, 30)
for (const w of [...miss, ...hitSmall]) {
  const q = w.quakes![0]
  const m = q.time.match(/(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})/)!
  const origin = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
  jobs.push({ label: 'local-' + w.label, startMs: origin - 180_000 })
}
console.log('取りこぼし ' + miss.length + '・拾えた小さな地震 ' + hitSmall.length)
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
