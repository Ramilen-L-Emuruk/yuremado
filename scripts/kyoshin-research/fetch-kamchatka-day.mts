// 2026-10-16 カムチャツカ地震の前後を Yahoo 強震モニタから取る（調査用）
// DRY=1 で URL を数えるだけ
import { writeFileSync, existsSync } from 'node:fs'

const OUT = process.argv[2]
const START = Date.UTC(2026, 9, 16, 12, 33, 0) // JST の壁時計を UTC として扱う
const SECONDS = 480
const DRY = process.env.DRY === '1'
const p = (n: number) => String(n).padStart(2, '0')
const urls: { ms: number; dateStr: string; ts: string }[] = []
for (let i = 0; i < SECONDS; i++) {
  const d = new Date(START + i * 1000)
  const dateStr = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
  urls.push({ ms: START + i * 1000, dateStr, ts: `${dateStr}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}` })
}
console.log(`取得予定 ${urls.length} 件 先頭 ${urls[0].ts} 末尾 ${urls[urls.length - 1].ts}`)
if (DRY) process.exit(0)
if (existsSync(OUT)) { console.log('既にある'); process.exit(0) }

const frames: unknown[] = []
let req = 0
async function one(u: (typeof urls)[number]) {
  for (const edge of ['west', 'east']) {
    req++
    try {
      const r = await fetch(`https://weather-kyoshin.${edge}.edge.storage-yahoo.jp/RealTimeData/${u.dateStr}/${u.ts}.json`)
      if (!r.ok) continue
      const j = (await r.json()) as { realTimeData?: { siteConfigId?: string; intensity?: string } }
      const rt = j.realTimeData
      if (!rt?.intensity) continue
      return { ms: u.ms, ts: u.ts, indices: Array.from(rt.intensity, (c) => c.charCodeAt(0) - 100), cfg: rt.siteConfigId ?? '' }
    } catch { /* 次のエッジへ */ }
  }
  return null
}
for (let i = 0; i < urls.length; i += 4) {
  const got = await Promise.all(urls.slice(i, i + 4).map(one))
  for (const g of got) if (g) frames.push(g)
}
writeFileSync(OUT, JSON.stringify(frames))
console.log(`取れた ${frames.length}/${urls.length} リクエスト ${req}`)
