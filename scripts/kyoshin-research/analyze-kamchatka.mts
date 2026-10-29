// 当日のフレームで、北海道の観測点がいつ・どれだけ平常から上がったかと、検知エンジンの反応を見る
import { readFileSync, existsSync } from 'node:fs'
import { initState, buildStationMeta, step, indexToValue } from '../../src/utils/kyoshinDetector.ts'

type Frame = { ms: number; ts: string; indices: number[]; cfg: string }
const frames = JSON.parse(readFileSync(process.argv[2], 'utf8')) as Frame[]
const repo = process.cwd().replace(/\\/g, '/')
const cfg = frames[0].cfg
const sitesPath = `${repo}/.probe-cache/sites_${cfg}.json`
if (!existsSync(sitesPath)) { console.log('観測点リストの控え無し', cfg); process.exit(1) }
const sites = JSON.parse(readFileSync(sitesPath, 'utf8')) as [number, number][]
console.log('版', cfg, '観測点', sites.length, 'フレーム', frames.length, 'cfg混在', new Set(frames.map(f => f.cfg)).size)

const hk = sites.map(([lat, lng], i) => ({ i, lat, lng })).filter(s => s.lat > 41.3)
const east = hk.filter(s => s.lng >= 143.0)
const north = hk.filter(s => s.lat >= 44.3 && s.lng < 143.0)
const rest = hk.filter(s => !east.includes(s) && !north.includes(s))
const honshu = sites.map(([lat, lng], i) => ({ i, lat, lng })).filter(s => s.lat <= 41.3)
console.log('北海道', hk.length, '東部(経度143以東)', east.length, '北部', north.length, 'その他', rest.length)

// 平常値: 12:33:00〜12:36:30 の中央値
const base = new Map<number, number>()
const pre = frames.filter(f => f.ts.slice(8) < '123630')
for (let i = 0; i < sites.length; i++) {
  const v = pre.map(f => f.indices[i]).filter(x => x >= 0).sort((a, b) => a - b)
  base.set(i, v.length ? v[Math.floor(v.length / 2)] : NaN)
}
function stat(group: { i: number }[], f: Frame) {
  let up1 = 0, up2 = 0, maxV = -9, n = 0
  for (const s of group) {
    const x = f.indices[s.i]; const b = base.get(s.i)!
    if (x < 0 || Number.isNaN(b)) continue
    n++
    if (x - b >= 1) up1++   // 0.5 段（計測震度 0.5）以上
    if (x - b >= 2) up2++   // 1.0 以上
    maxV = Math.max(maxV, indexToValue(x))
  }
  return `${String(up1).padStart(3)}/${String(up2).padStart(3)} max${maxV.toFixed(1).padStart(5)}`
}

const meta = buildStationMeta(sites)
let st = initState(frames[0].ms - 1000)
console.log('時刻   | 東部 +0.5/+1.0 | 北部 | 道その他 | 本州以南 | 検知エンジン: 立ち上がり点(北海道) 確定揺れ点 イベント')
for (const f of frames) {
  const missing = f.indices.map(v => v < 0)
  const r = step(st, { dataTimeMs: f.ms, sites, values: f.indices, missing, eewActive: false }, meta)
  st = r.state
  const t = f.ts.slice(8)
  if (t < '123700' || t > '123930') continue
  const hkKeys = new Set(hk.map(s => `${s.lat.toFixed(3)},${s.lng.toFixed(3)}`))
  const onsetHk = r.recentOnsetKeys.filter(k => hkKeys.has(k)).length
  const conf = r.triggers.filter(x => x.confirmedShaking).length
  const ev = r.detections.map(d => `${d.confidence}:${d.memberKeys.length}:${d.maxIntensity.toFixed(1)}`).join(',')
  console.log(`${t} | ${stat(east, f)} | ${stat(north, f)} | ${stat(rest, f)} | ${stat(honshu, f)} | ${onsetHk} ${conf} ${ev}`)
}
