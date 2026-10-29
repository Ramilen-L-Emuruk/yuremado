// 「平常値から +1.0 以上を 5 秒続けた点」が、半径 150km の円の中に何点あるか（最大の円）を秒ごとに数える。
// カムチャツカの日と、ベンチの平常時の窓（quiet / negative）で比べる。
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { runEnsemble } from './ensemble-engine.mts'
import { kyoshinBenchCacheDir } from '../lib/kyoshinBenchCache.ts'
type Frame = { ms: number; ts: string; indices: number[]; cfg: string }
const repo = process.cwd().replace(/\\/g, '/')
const probeCache = kyoshinBenchCacheDir().replace(/\\/g, '/')
const BASE_SEC = 120, HOLD = 5, RISE = +(process.env.RISE ?? 1), R_KM = 150
const sitesCache = new Map<string, [number, number][]>()
const sitesOf = (cfg: string) => {
  if (!sitesCache.has(cfg)) sitesCache.set(cfg, JSON.parse(readFileSync(`${probeCache}/sites_${cfg}.json`, 'utf8')))
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
// ---- 遠い地震の窓ごとに、新しい判定といまのエンジンの初出を出す ----
const THR = +(process.env.THR ?? 20)
const dir = `${repo}/.cache/kyoshin-far-windows`
const files = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => `${dir}/${f}`)
files.push(`${process.argv[2]}/kamchatka.json`)
const missingCfg = new Set<string>()
for (const path of files) {
  const fr = JSON.parse(readFileSync(path, 'utf8')) as Frame[]
  const label = path.split('/').pop()!.replace('.json', '')
  if (fr.length < 60) { console.log(`${label} フレーム不足 ${fr.length}`); continue }
  const cfg = fr[0].cfg
  if (!existsSync(`${probeCache}/sites_${cfg}.json`)) { missingCfg.add(cfg); continue }
  const rr = run(fr)
  const sites = sitesOf(cfg)
  const first = rr.find(x => x.best >= THR)
  const peak = Math.max(...rr.map(x => x.best))
  const hits = runEnsemble(fr, sites)
  const hhmmss = (ms: number) => new Date(ms).toISOString().slice(11, 19).replace(/:/g, '')
  const lMs = hits.length ? Math.min(...hits.map(h => h.likelyMs)) : null
  const cs = hits.filter(h => h.confirmedMs != null).map(h => h.confirmedMs!)
  const likely = lMs != null ? hhmmss(lMs) : null, conf = cs.length ? hhmmss(Math.min(...cs)) : null
  const at = first ? sites[first.at].map(v => v.toFixed(1)).join(',') : ''
  console.log(`${label}\t最大${peak}%\t判定 ${first ? first.ts.slice(8) + '@' + at : '—'}\t組み合わせ likely ${likely ?? '—'} confirmed ${conf ?? '—'}`)
}
if (missingCfg.size) console.log('観測点リストの控えが無い版', [...missingCfg].join(' '))
