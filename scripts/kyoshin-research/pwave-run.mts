// 試作の P 波判定を、遠い地震・深発地震・ベンチの窓に流す
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { runPwave, P, type Frame } from './pwave.mts'
import { kyoshinBenchCacheDir } from '../lib/kyoshinBenchCache.ts'
const repo = process.cwd().replace(/\\/g, '/')
const probeCache = kyoshinBenchCacheDir().replace(/\\/g, '/')
const S = process.argv[2]
const sitesOf = (cfg: string) => JSON.parse(readFileSync(`${probeCache}/sites_${cfg}.json`, 'utf8')) as [number, number][]
const hh = (ms: number) => new Date(ms).toISOString().slice(11, 19)
const fmt = (fs: ReturnType<typeof runPwave>) => fs.length ? fs.map(x => `${hh(x.ms)}(${x.n}点 rms${x.rms.toFixed(1)} ${x.vKmS > 99 ? '∞' : x.vKmS.toFixed(0)}km/s 方角${x.azDeg.toFixed(0)}° @${x.at.map(v => v.toFixed(1)).join(',')})`).join(' ') : '—'
console.log('条件', JSON.stringify(P))
// 遠い地震・深発地震
const dir = `${repo}/.cache/kyoshin-far-windows`
const far = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => `${dir}/${f}`).concat([`${S}/kamchatka.json`])
for (const p of far) {
  const fr = JSON.parse(readFileSync(p, 'utf8')) as Frame[]
  if (fr.length < 60 || !existsSync(`${probeCache}/sites_${fr[0].cfg}.json`)) continue
  console.log(`遠・深 ${p.split('/').pop()!.replace('.json', '')}\t${fmt(runPwave(fr, sitesOf(fr[0].cfg)))}`)
}
// ベンチ: 平常時の窓（誤検知）と地震の窓（数だけ）
const win = JSON.parse(readFileSync(`${repo}/scripts/kyoshin-bench/windows.json`, 'utf8')).windows as { label: string; category: string }[]
const tally: Record<string, { n: number; fired: number; secs: number }> = {}
for (const w of win) {
  let fr: Frame[]
  try { fr = JSON.parse(readFileSync(`${probeCache}/${w.label}.json`, 'utf8')) } catch { continue }
  if (fr.length < 60 || !existsSync(`${probeCache}/sites_${fr[0].cfg}.json`)) continue
  const fs = runPwave(fr, sitesOf(fr[0].cfg))
  const t = tally[w.category] ??= { n: 0, fired: 0, secs: 0 }
  t.n++; t.secs += fr.length; if (fs.length) t.fired++
  if (fs.length && (w.category === 'quiet' || w.category === 'negative' || w.category === 'reported-false-positive')) console.log(`平常で発火 ${w.category} ${w.label}\t${fmt(fs)}`)
}
for (const [k, t] of Object.entries(tally)) console.log(`ベンチ ${k}: 窓 ${t.n}・${t.secs} 秒・発火した窓 ${t.fired}` + ((t as any).ev != null ? `・発火の回数 ${(t as any).ev}` : ''))
