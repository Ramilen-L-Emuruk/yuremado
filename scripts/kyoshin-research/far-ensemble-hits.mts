// 遠い地震・深発地震の窓ごとに、組み合わせの検知を全部、P 波到達の見込み（窓の頭 + 120 秒）からの秒で書き出す
// 窓の中の別の揺れ（地元の小さな地震・ノイズ）と、遠い地震そのものを見分けるため
// 書式: <窓>\t<早い段の秒>/<確かな段の秒>@<重心の緯度>,<経度> …（確かな段に上がらなければ —）
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { runEnsemble } from './ensemble-engine.mts'
type Frame = { ms: number; ts: string; indices: number[]; cfg: string }
const repo = process.cwd().replace(/\\/g, '/')
const probeCache = (process.env.KYOSHIN_BENCH_CACHE ?? `${repo}/.probe-cache`).replace(/\\/g, '/')
const dir = `${repo}/.cache/kyoshin-far-windows`
for (const f of readdirSync(dir).filter(x => x.endsWith('.json')).sort()) {
  const fr = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as Frame[]
  const cfg = fr[0].cfg
  if (!existsSync(`${probeCache}/sites_${cfg}.json`)) { console.log(`${f}\t観測点リストの控えが無い ${cfg}`); continue }
  const sites = JSON.parse(readFileSync(`${probeCache}/sites_${cfg}.json`, 'utf8')) as [number, number][]
  const p = fr[0].ms + 120_000
  const sec = (ms: number) => Math.round((ms - p) / 1000)
  const hits = runEnsemble(fr, sites).map(h => `${sec(h.likelyMs)}/${h.confirmedMs == null ? '—' : sec(h.confirmedMs)}@${h.at[0].toFixed(1)},${h.at[1].toFixed(1)}`)
  console.log(`${f.replace('.json', '')}\t${hits.join(' ') || '—'}`)
}
