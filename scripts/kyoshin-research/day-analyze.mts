// 「平常値から +1.0 以上を 5 秒続けた点」が、半径 150km の円の中に何点あるか（最大の円）を秒ごとに数える。
// カムチャツカの日と、ベンチの平常時の窓（quiet / negative）で比べる。
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { runPwave } from './pwave.mts'
import { initState, buildStationMeta, step } from '../../src/utils/kyoshinDetector.ts'
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
// ---- 平常の日: 発火した区間を拾い、長期震源カタログの地震と突き合わせる ----
const THR = +(process.env.THR ?? 20)
const qdir = `${repo}/.cache/kyoshin-quiet-days`
const day = process.argv[3]
const frames: Frame[] = []
for (let h = 0; h < 24; h++) {
  const path = `${qdir}/${day}-${String(h).padStart(2, '0')}.bin`
  if (!existsSync(path)) { console.log(`欠け ${day}-${h}`); continue }
  const buf = readFileSync(path)
  const nl = buf.indexOf(10)
  const { cfgs } = JSON.parse(buf.subarray(0, nl).toString('utf8')) as { cfgs: string[] }
  let o = nl + 1
  while (o < buf.length) {
    const sec = buf.readUInt32LE(o), ci = buf[o + 4], n = buf.readUInt16LE(o + 5)
    const idx = new Int8Array(n); for (let i = 0; i < n; i++) idx[i] = buf[o + 7 + i] - 1
    o += 7 + n
    const Y = +day.slice(0, 4), M = +day.slice(4, 6), D = +day.slice(6, 8)
    frames.push({ ms: Date.UTC(Y, M - 1, D) + sec * 1000, ts: '', indices: idx as unknown as number[], cfg: cfgs[ci] })
  }
}
console.log(`${day} フレーム ${frames.length}・版 ${[...new Set(frames.map(f => f.cfg))].join(' ')}`)
// 版が変わったら区切って流す
const res: { ms: number; best: number; at: number; cfg: string }[] = []
let s0 = 0
for (let i = 1; i <= frames.length; i++) {
  if (i === frames.length || frames[i].cfg !== frames[s0].cfg) {
    const seg = frames.slice(s0, i).map(f => ({ ...f, ts: String(f.ms) }))
    for (const x of run(seg)) res.push({ ms: +x.ts, best: x.best, at: x.at, cfg: seg[0].cfg })
    s0 = i
  }
}
// カタログ（日本時間の壁時計へ揃える）
const Y = +day.slice(0, 4)
const cat = JSON.parse(readFileSync(`${repo}/public/data/hypocenter/${Y}.json`, 'utf8'))
const quakes: { ms: number; lat: number; lng: number; mag: number | null; name: string }[] = []
for (let i = 0; i < cat.count; i++) {
  const ms = cat.startMs + cat.t[i] * (1000 / cat.timeScale) + 9 * 3600_000
  quakes.push({ ms, lat: cat.lat[i] / cat.coordScale, lng: cat.lng[i] / cat.coordScale, mag: cat.mag[i] == null ? null : cat.mag[i] / cat.magScale, name: cat.names[cat.nameIdx[i]] })
}
const dayStart = Date.UTC(Y, +day.slice(4, 6) - 1, +day.slice(6, 8))
console.log(`カタログの範囲の端 ${new Date(cat.coveredThroughMs + 9 * 3600_000).toISOString().slice(0, 16)}（日本時間）`)
const hav = (a: number, b: number, c: number, d: number) => { const r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 2 * 6371 * Math.asin(Math.sqrt(x)) }
const hh = (ms: number) => new Date(ms).toISOString().slice(11, 19)
let ep: { start: number; end: number; peak: number; at: [number, number] } | null = null
const eps: NonNullable<typeof ep>[] = []
for (const x of res) {
  if (x.best >= THR) {
    const p = sitesOf(x.cfg)[x.at] as [number, number]
    if (ep && x.ms - ep.end <= 10_000) { ep.end = x.ms; if (x.best > ep.peak) ep.peak = x.best }
    else { if (ep) eps.push(ep); ep = { start: x.ms, end: x.ms, peak: x.best, at: p } }
  }
}
if (ep) eps.push(ep)
if (process.env.MODE === 'pwave') {
  eps.length = 0
  let s1 = 0
  for (let i = 1; i <= frames.length; i++) {
    if (i === frames.length || frames[i].cfg !== frames[s1].cfg) {
      for (const f of runPwave(frames.slice(s1, i), sitesOf(frames[s1].cfg))) eps.push({ start: f.ms, end: f.ms, peak: f.n, at: f.at })
      s1 = i
    }
  }
}
const dist = new Map<number, number>()
for (const x of res) dist.set(Math.min(Math.floor(x.best / 5) * 5, 50), (dist.get(Math.min(Math.floor(x.best / 5) * 5, 50)) ?? 0) + 1)
console.log('秒ごとの割合の分布', [...dist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}%〜:${v}`).join(' '))
console.log(`発火した区間 ${eps.length}`)
for (const e of eps) {
  // 発火の 5 分前〜30 秒後に起きた地震のうち、距離に見合うもの（M2 以上は 300km・M5 以上は 2000km 以内）
  const cand = quakes.filter(q => q.ms >= e.start - 300_000 && q.ms <= e.start + 30_000)
    .map(q => ({ q, km: hav(q.lat, q.lng, e.at[0], e.at[1]) }))
    .filter(({ q, km }) => km <= ((q.mag ?? 0) >= 5 ? 2000 : (q.mag ?? 0) >= 3.5 ? 800 : 300))
    .sort((a, b) => (b.q.mag ?? 0) - (a.q.mag ?? 0))
  const tag = cand.length ? `地震 ${hh(cand[0].q.ms)} ${cand[0].q.name} M${cand[0].q.mag ?? '不明'} ${cand[0].km.toFixed(0)}km` : '結びつく地震なし'
  console.log(`  ${hh(e.start)}〜${hh(e.end)} 最大${e.peak}% @${e.at.map(v => v.toFixed(1)).join(',')} → ${tag}`)
}
if (dayStart) { /* 型の都合で残す */ }
