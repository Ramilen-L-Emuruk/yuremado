// 平常の 1 日（日本時間 0〜24 時）を Yahoo 強震モニタから取り、1 時間ごとの二進ファイルへ控える（調査用）
// 形: 先頭に JSON 1 行 {"cfgs":[...]}、続けてフレームごとに [秒(uint32 LE)][版の番号(uint8)][点数(uint16 LE)][index+1 の uint8 × 点数]
// DRY=1 で件数だけ出す。既にある時間は飛ばす（途中で止まっても続きから）
import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
const OUT = process.cwd().replace(/\\/g, '/') + '/.cache/kyoshin-quiet-days'
const days = process.argv.slice(2) // YYYYMMDD …
const DRY = process.env.DRY === '1'
const p = (n: number) => String(n).padStart(2, '0')
const hours: { day: string; h: number }[] = []
for (const d of days) for (let h = 0; h < 24; h++) if (!existsSync(`${OUT}/${d}-${p(h)}.bin`)) hours.push({ day: d, h })
console.log(`日 ${days.join(' ')}・未取得 ${hours.length} 時間・取得予定 ${hours.length * 3600} 件（エッジを替えて取り直す分を除く）`)
if (DRY) process.exit(0)
mkdirSync(OUT, { recursive: true })
let req = 0
async function one(dateStr: string, ts: string) {
  for (const edge of ['west', 'east']) {
    req++
    try {
      const r = await fetch(`https://weather-kyoshin.${edge}.edge.storage-yahoo.jp/RealTimeData/${dateStr}/${ts}.json`)
      if (!r.ok) continue
      const j = (await r.json()) as { realTimeData?: { siteConfigId?: string; intensity?: string } }
      const rt = j.realTimeData
      if (!rt?.intensity) continue
      return { cfg: rt.siteConfigId ?? '', s: rt.intensity }
    } catch { /* 次のエッジへ */ }
  }
  return null
}
for (const { day, h } of hours) {
  const cfgs: string[] = []
  const chunks: Buffer[] = []
  let got = 0
  for (let s = 0; s < 3600; s += 4) {
    const res = await Promise.all([0, 1, 2, 3].map(async k => {
      const sec = h * 3600 + s + k
      const ts = `${day}${p(Math.floor(sec / 3600))}${p(Math.floor(sec / 60) % 60)}${p(sec % 60)}`
      return { sec, r: await one(day, ts) }
    }))
    for (const { sec, r } of res) {
      if (!r) continue
      let ci = cfgs.indexOf(r.cfg); if (ci < 0) { cfgs.push(r.cfg); ci = cfgs.length - 1 }
      const b = Buffer.alloc(7 + r.s.length)
      b.writeUInt32LE(sec, 0); b.writeUInt8(ci, 4); b.writeUInt16LE(r.s.length, 5)
      for (let i = 0; i < r.s.length; i++) b[7 + i] = r.s.charCodeAt(i) - 100 + 1
      chunks.push(b); got++
    }
  }
  writeFileSync(`${OUT}/${day}-${p(h)}.bin`, Buffer.concat([Buffer.from(JSON.stringify({ cfgs }) + '\n'), ...chunks]))
  console.log(`${day}-${p(h)} 取れた ${got}/3600 通算リクエスト ${req}`)
}
