// 近くて小さな地震: P 波の判定を小さな円で流し、いまのエンジンが取りこぼした窓を拾えるか・平常時に出ないかを見る
import { readFileSync, existsSync } from 'node:fs'
import { runPwave, P, type Frame } from './pwave.mts'
const repo = process.cwd().replace(/\\/g, '/')
const sitesOf = (cfg: string) => JSON.parse(readFileSync(`${repo}/.probe-cache/sites_${cfg}.json`, 'utf8')) as [number, number][]
const hav = (a: number, b: number, c: number, d: number) => { const r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 2 * 6371 * Math.asin(Math.sqrt(x)) }
type Q = { time: string; lat: number; lng: number; mag: number; depth: number; maxScale?: number }
const win = JSON.parse(readFileSync(`${repo}/scripts/kyoshin-bench/windows.json`, 'utf8')).windows as { label: string; category: string; quakes?: Q[] }[]
const base = JSON.parse(readFileSync(`${repo}/scripts/kyoshin-bench/baseline.json`, 'utf8')).results as Record<string, { tier: string; firstLikely?: string }>
const jst = (s: string) => { const m = s.match(/(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})/)!; return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) }
const bins: Record<string, { n: number; eng: number; pw: number; pwRel: number; gain: number; pwUnrel: number }> = {}
let quietFires = 0, quietSecs = 0
const unrel: string[] = []
for (const w of win) {
  let fr: Frame[]
  try { fr = JSON.parse(readFileSync(`${repo}/.probe-cache/${w.label}.json`, 'utf8')) } catch { continue }
  if (fr.length < 60 || !existsSync(`${repo}/.probe-cache/sites_${fr[0].cfg}.json`)) continue
  const fires = runPwave(fr, sitesOf(fr[0].cfg))
  if (w.category === 'quiet' || w.category === 'negative') { quietFires += fires.length; quietSecs += fr.length; continue }
  if (w.category !== 'catalog' || !w.quakes?.length) continue
  const q = w.quakes.reduce((a, b) => (b.mag ?? 0) > (a.mag ?? 0) ? b : a)
  const g = q.mag < 2.5 ? 'M2.5未満' : q.mag < 3 ? 'M2.5〜3' : q.mag < 3.5 ? 'M3〜3.5' : q.mag < 4 ? 'M3.5〜4' : 'M4以上'
  const b = bins[g] ??= { n: 0, eng: 0, pw: 0, pwRel: 0, gain: 0, pwUnrel: 0 }
  b.n++
  const eng = base[w.label]?.tier !== 'none'
  if (eng) b.eng++
  if (fires.length) b.pw++
  // 震央から 150km 以内・発生から 60 秒以内の発火を「その地震」とみなす
  const rel = fires.some(f => w.quakes!.some(qq => hav(qq.lat, qq.lng, f.at[0], f.at[1]) <= 150 && f.ms >= jst(qq.time) && f.ms <= jst(qq.time) + 60_000))
  if (rel) { b.pwRel++; if (!eng) b.gain++ }
  else if (fires.length) { b.pwUnrel++; if (unrel.length < 10) unrel.push(`${w.label}@${new Date(fires[0].ms).toISOString().slice(11, 19)}(${fires[0].at.map(v => v.toFixed(1)).join(',')})`) }
}
console.log('条件', JSON.stringify({ R: P.R_KM, N: P.MIN_N, FRAC: P.FRAC, RISE: P.RISE, HOLD: P.HOLD }))
console.log(`平常時の窓 ${quietSecs} 秒で発火 ${quietFires} 回`)
console.log('区分\t窓\tエンジン\tP波判定(その地震)\tエンジンが取りこぼしP波判定だけ\t地震と離れた発火')
for (const g of ['M2.5未満', 'M2.5〜3', 'M3〜3.5', 'M3.5〜4', 'M4以上']) { const b = bins[g]; if (b) console.log(`${g}\t${b.n}\t${b.eng}\t${b.pwRel}\t${b.gain}\t${b.pwUnrel}`) }
if (unrel.length) console.log('離れた発火の例', unrel.join(' '))
