// 試作: 弱い P 波の頭を「近くの点の 1 段の立ち上がりが、平面波の走時にそろって乗る」で拾う（調査用）
// 実時間で 1 秒ずつ進め、未来は見ない
export type Frame = { ms: number; ts?: string; indices: ArrayLike<number>; cfg: string }
export const P = {
  BASE_SEC: 120, GUARD_SEC: 10, RISE: +(process.env.P_RISE ?? 1), HOLD: +(process.env.P_HOLD ?? 3),
  WIN_SEC: +(process.env.P_WIN ?? 15), R_KM: +(process.env.P_R ?? 250), MIN_N: +(process.env.P_N ?? 8),
  MAX_RMS: +(process.env.P_RMS ?? 1.5), MIN_V: +(process.env.P_VMIN ?? 4), REFRACT_SEC: 60, FRAC: +(process.env.P_FRAC ?? 0.3), MIN_AVAIL: 10,
}
const hav = (a: number, b: number, c: number, d: number) => { const r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 2 * 6371 * Math.asin(Math.sqrt(x)) }
const nbCache = new Map<string, number[][]>()
function neighbors(cfg: string, sites: [number, number][]) {
  const ck = `${cfg}:${P.R_KM}`; const hit = nbCache.get(ck); if (hit) return hit
  const out: number[][] = sites.map(() => [])
  for (let i = 0; i < sites.length; i++) for (let j = 0; j < sites.length; j++) if (hav(sites[i][0], sites[i][1], sites[j][0], sites[j][1]) <= P.R_KM) out[i].push(j)
  nbCache.set(ck, out); return out
}
export type Fire = { ms: number; n: number; rms: number; vKmS: number; azDeg: number; at: [number, number] }
// 3 変数の最小二乗 t = t0 + px·E + py·N
function planeFit(xs: number[], ys: number[], ts: number[]) {
  const n = xs.length; let sx = 0, sy = 0, st = 0
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; st += ts[i] }
  const mx = sx / n, my = sy / n, mt = st / n
  let a = 0, b = 0, c = 0, d = 0, e = 0
  for (let i = 0; i < n; i++) { const x = xs[i] - mx, y = ys[i] - my, t = ts[i] - mt; a += x * x; b += x * y; c += y * y; d += x * t; e += y * t }
  const det = a * c - b * b; if (Math.abs(det) < 1e-6) return null
  const px = (d * c - e * b) / det, py = (a * e - b * d) / det
  let ss = 0; for (let i = 0; i < n; i++) { const r = (ts[i] - mt) - px * (xs[i] - mx) - py * (ys[i] - my); ss += r * r }
  return { px, py, rms: Math.sqrt(ss / n) }
}
export function runPwave(frames: Frame[], sites: [number, number][]): Fire[] {
  const cfg = frames[0].cfg, nb = neighbors(cfg, sites), n = sites.length
  const hist: number[][] = Array.from({ length: n }, () => [])
  const run = new Int32Array(n), onset = new Float64Array(n).fill(-Infinity)
  const fires: Fire[] = []
  let lastFire = -Infinity
  for (const f of frames) {
    if (f.cfg !== cfg) break
    const now = f.ms, fresh: number[] = []
    for (let i = 0; i < n; i++) {
      const x = f.indices[i]; const h = hist[i]
      if (x < 0) { run[i] = 0; continue }
      h.push(x); if (h.length > P.BASE_SEC + P.GUARD_SEC) h.shift()
      if (h.length < P.BASE_SEC + P.GUARD_SEC) continue
      let base = -99; for (let k = 0; k < h.length - P.GUARD_SEC; k++) if (h[k] > base) base = h[k]
      run[i] = x - base >= P.RISE ? run[i] + 1 : 0
      if (run[i] === P.HOLD && now - onset[i] > P.REFRACT_SEC * 1000) { onset[i] = now - (P.HOLD - 1) * 1000; fresh.push(i) }
    }
    if (now - lastFire < 60_000) continue
    for (const c of fresh) {
      const mem = nb[c].filter(j => now - onset[j] <= P.WIN_SEC * 1000)
      const avail = nb[c].filter(j => f.indices[j] >= 0).length
      if (avail < P.MIN_AVAIL || mem.length < Math.max(P.MIN_N, P.FRAC * avail)) continue
      const [la, lo] = sites[c], k = Math.cos(la * Math.PI / 180) * 111
      const xs = mem.map(j => (sites[j][1] - lo) * k), ys = mem.map(j => (sites[j][0] - la) * 111), ts = mem.map(j => (onset[j] - now) / 1000)
      // 外れた点を 2 回まで外して当てはめ直す（1 秒の量子化とゆらぎの点を許す）
      let idx = mem.map((_, q) => q), fit = planeFit(xs, ys, ts)
      for (let it = 0; it < 2 && fit; it++) {
        const ftt = fit
        const mx = idx.reduce((s, q) => s + xs[q], 0) / idx.length, my = idx.reduce((s, q) => s + ys[q], 0) / idx.length, mt = idx.reduce((s, q) => s + ts[q], 0) / idx.length
        const keep = idx.filter(q => Math.abs((ts[q] - mt) - ftt.px * (xs[q] - mx) - ftt.py * (ys[q] - my)) <= 2.5)
        if (keep.length === idx.length || keep.length < P.MIN_N) break
        idx = keep; fit = planeFit(idx.map(q => xs[q]), idx.map(q => ys[q]), idx.map(q => ts[q]))
      }
      if (!fit || idx.length < Math.max(P.MIN_N, P.FRAC * avail) || fit.rms > P.MAX_RMS) continue
      const s = Math.hypot(fit.px, fit.py), v = s > 0 ? 1 / s : Infinity
      if (v < P.MIN_V) continue
      // 時刻が全部同じ（1 秒に固まった）なら波面の向きが決まらない。散らばりを要求する
      const span = Math.max(...idx.map(q => ts[q])) - Math.min(...idx.map(q => ts[q]))
      if (span < 2) continue
      const az = (Math.atan2(-fit.px, -fit.py) * 180 / Math.PI + 360) % 360 // 波が来る方角
      fires.push({ ms: now, n: idx.length, rms: fit.rms, vKmS: v, azDeg: az, at: [la, lo] })
      lastFire = now
      break
    }
  }
  return fires
}
