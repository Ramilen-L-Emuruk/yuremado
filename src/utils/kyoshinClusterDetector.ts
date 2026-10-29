/**
 * 組み合わせの検知器の「波面」の部分。時空間のクラスタリングと波面の当てはめで揺れを見つける。
 *
 * 1. 点ごとの「発火」: いまの段が、3〜59 秒前の最大より thr 段以上高い。thr は点ごとの普段の雑音
 *    （平常のゆらぎの表の `fire`）で決め、窓の中で空振りが多い点は上げる
 * 2. 発火を時空間の塊にまとめる: 距離 LINK_KM 以内で、時刻の差が「距離 ÷ VLINK ＋ TSLACK」以内なら同じ塊
 * 3. 塊ごとに波面を当てはめる: 早い点を中心にした同心円（深さ H・速さ V を振り、到達 = t0 + (√(r²+H²) − H)/V）か、
 *    広い塊では平面波。乗った点の重み（1 ＋ しきい値からの超過）を数え、中心から内側で発火していない点は差し引く
 * 4. 確かな段: 波面に乗った点が 4 点・重み 8 以上（まばらな所は 3 点・重み 9 以上）。以後は足跡の中の発火を引き取る
 *
 * 組み合わせの検知器（`kyoshinEnsembleDetector.ts`）はこの検知器の確かな段だけを使う。
 * 値はすべて、組み合わせの検知器を評価したときのもの。
 */
import { quietSiteKey, type QuietTables } from './kyoshinQuietTables'
import type { DetectorFrame, DetectorReport } from './kyoshinStatDetector'

const P = {
  L: 60, LAG: 3,
  /** 発火のしきい値を決める普段の率（秒/時）。これ以下になる最小の段差を thr にする */
  RATE: 2.0,
  THR_MIN: 2, THR_DEFAULT: 3,
  LINK_KM: 70,
  /** 同じ塊に繋ぐときの見かけの速さの下限（km/s） */
  VLINK: 5.0,
  TSLACK: 1.5,
  /** 発火が塊の材料として残る秒数 */
  ACTIVE_SEC: 30,
  CONF_MIN: 4,
  CONF_EXTENT_KM: 15,
  /** 波面の当てはめで許す時刻のずれ（秒）＋ 距離 × FIT_RES_K */
  FIT_RES: 1.5,
  FIT_RES_K: 0.05,
  /** 同心円の当てはめで試す速さ（km/s） */
  VS: [5, 6.5, 8],
  /** 同心円の当てはめで試す震源の深さ（km） */
  HS: [0, 40, 100, 300],
  PLANE_MIN: 6, PLANE_VMIN: 5, PLANE_RES: 2.0, PLANE_EXT: 120,
  EX_CAP: 4,
  ORIGIN_CAND: 6,
  MISS_PEN: 0.5,
  /** 確かな段に要る重み（説明できた点の 1 ＋ 超過 の和） */
  CONF_W: 8,
  /** 点がまばらな所: 3 点でも、超過が大きければ確かな段 */
  CONF2_MIN: 3, CONF2_W: 9,
  /** 確かな段は最後に点が増えてからこの秒数まで出し続ける */
  HOLD_SEC: 60,
  /** 確かな段の塊は、乗った点から FOOT_KM 以内の新しい発火を REFRACT_SEC 秒まで引き取る */
  REFRACT_SEC: 120, FOOT_KM: 30, FOOT_GAP: 20,
  /** 空振りの多い点のしきい値を上げる（2 時間で減衰・4 回ごとに 1 段） */
  ADAPT_TAU: 7200, ADAPT_N: 4, ADAPT_MAXUP: 2,
} as const

const RAD = Math.PI / 180
const hav = (a: number, b: number, c: number, d: number) => {
  const x = Math.sin((c - a) * RAD / 2) ** 2 + Math.cos(a * RAD) * Math.cos(c * RAD) * Math.sin((d - b) * RAD / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(x))
}

type Pick = { i: number; t: number; e: number; cl: number; foot?: number }
type Cluster = { id: number; picks: Pick[]; first: Pick; startMs: number; lastGrow: number; confirmed: boolean; confAt: number; born: number }
type Fit = { k: number; w: number; o: Pick | null; t0: number }

export function createClusterDetector(sites: readonly (readonly [number, number])[], tables: QuietTables) {
  const n = sites.length, L = P.L, LAG = P.LAG
  const ring = new Int8Array(n * L).fill(-1)
  /** 窓（3〜59 秒前。t-LAG の値を入れ、t-L の値を出す）に入っている段の数 */
  const cnt = new Uint16Array(n * 22)
  const mx = new Int8Array(n).fill(-1)
  let pos = 0, frames = 0
  const thr = new Int8Array(n)
  /** 雑音の表から、その点の発火のしきい値（何段の上がりで揺れ始めと見るか）を決める。表に無い点は既定の段 */
  const thresholdOf = (r: number[] | undefined): number => {
    if (!r) return P.THR_DEFAULT
    for (let t = P.THR_MIN; t <= 5; t++) if (r[t - 1] <= P.RATE) return t
    return 5
  }
  for (let i = 0; i < n; i++) thr[i] = thresholdOf(tables.fire[quietSiteKey(sites[i])])
  const thr0 = Int8Array.from(thr), orphan = new Float64Array(n), orphanT = new Float64Array(n)
  const nb: number[][] = sites.map(() => [])
  const dd: number[][] = sites.map(() => [])
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const d = hav(sites[i][0], sites[i][1], sites[j][0], sites[j][1])
    if (d <= P.LINK_KM) { nb[i].push(j); dd[i].push(d); nb[j].push(i); dd[j].push(d) }
  }
  const pickOf = new Array<Pick | null>(n).fill(null)
  const footId = new Int32Array(n), footUntil = new Float64Array(n)
  const markFoot = (i: number, id: number, now: number) => {
    const until = now + P.REFRACT_SEC * 1000
    footId[i] = id; footUntil[i] = until
    const ns = nb[i], ds = dd[i]
    for (let k = 0; k < ns.length; k++) if (ds[k] <= P.FOOT_KM) { footId[ns[k]] = id; footUntil[ns[k]] = until }
  }
  const clusters = new Map<number, Cluster>()
  let nextId = 1
  const dist = (a: number, b: number) => hav(sites[a][0], sites[a][1], sites[b][0], sites[b][1])
  let lastV: Int8Array<ArrayBufferLike> = new Int8Array(n)

  // 波面の当てはめ: 説明できる点の数 k と重み w（1 ＋ しきい値からの超過 の和）を返す
  const wOf = (p: Pick) => 1 + Math.min(P.EX_CAP, p.e - thr[p.i])
  function fitWave(c: Cluster): Fit {
    const ps = c.picks
    let best: Fit = { k: ps.length, w: ps.reduce((a, p) => a + wOf(p), 0), o: null, t0: 0 }
    if (ps.length < 3) return best
    best = { k: 0, w: 0, o: null, t0: 0 }
    let bestSc = -Infinity
    // 同心円: 中心の候補は早い順に ORIGIN_CAND 点
    const early = [...ps].sort((a, b) => a.t - b.t).slice(0, P.ORIGIN_CAND)
    for (const o of early) {
      const dAll = new Float32Array(n)
      for (let j = 0; j < n; j++) dAll[j] = dist(o.i, j)
      const r = ps.map(p => dAll[p.i])
      for (const H of P.HS) for (const V of P.VS) {
        const res = ps.map((p, j) => (p.t - o.t) / 1000 - (Math.hypot(r[j], H) - H) / V)
        const s = [...res].sort((a, b) => a - b), t0 = s[s.length >> 1]
        if (Math.abs(t0) > P.FIT_RES) continue // 中心に選んだ点そのものが波面に乗らない
        let k = 0, w = 0
        const inFit = new Set<number>(), rs: number[] = []
        for (let j = 0; j < ps.length; j++) if (Math.abs(res[j] - t0) <= P.FIT_RES + P.FIT_RES_K * r[j]) { k++; w += wOf(ps[j]); inFit.add(ps[j].i); rs.push(r[j]) }
        // 中心から、乗った点の距離の中央値までの内側で、発火していない点を数えて差し引く（中心の取り違えを防ぐ）
        rs.sort((a, b) => a - b)
        const Rm = rs[rs.length >> 1]
        let miss = 0
        if (Rm > 0) for (let j = 0; j < n; j++) if (j !== o.i && dAll[j] <= Rm && !inFit.has(j) && lastV[j] >= 0) miss++
        const sc = w - P.MISS_PEN * miss
        if (sc > bestSc) { bestSc = sc; best = { k, w, o, t0: o.t + t0 * 1000 } }
      }
    }
    // 平面波: 最小二乗で t = a + bx + cy
    if (ps.length >= P.PLANE_MIN) {
      const lat0 = sites[ps[0].i][0], lng0 = sites[ps[0].i][1], kx = 111.32 * Math.cos(lat0 * RAD)
      let S = 0, Sx = 0, Sy = 0, St = 0, Sxx = 0, Syy = 0, Sxy = 0, Sxt = 0, Syt = 0
      const xs = ps.map(p => [(sites[p.i][1] - lng0) * kx, (sites[p.i][0] - lat0) * 110.57, (p.t - ps[0].t) / 1000])
      for (const [x, y, t] of xs) { S++; Sx += x; Sy += y; St += t; Sxx += x * x; Syy += y * y; Sxy += x * y; Sxt += x * t; Syt += y * t }
      const mxx = Sxx - Sx * Sx / S, myy = Syy - Sy * Sy / S, mxy = Sxy - Sx * Sy / S, mxt = Sxt - Sx * St / S, myt = Syt - Sy * St / S
      const det = mxx * myy - mxy * mxy
      if (det > 1e-6) {
        const b = (mxt * myy - myt * mxy) / det, cc = (myt * mxx - mxt * mxy) / det
        const slow = Math.hypot(b, cc)
        if (slow <= 1 / P.PLANE_VMIN) {
          const a = (St - b * Sx - cc * Sy) / S
          let k = 0, w = 0, o: Pick | null = null
          xs.forEach(([x, y, t], j) => { if (Math.abs(t - (a + b * x + cc * y)) <= P.PLANE_RES) { k++; w += wOf(ps[j]); if (!o || ps[j].t < o.t) o = ps[j] } })
          let ext = 0
          if (o) {
            const oi = ps.indexOf(o)
            for (const [x, y, t] of xs) if (Math.abs(t - (a + b * x + cc * y)) <= P.PLANE_RES) ext = Math.max(ext, Math.hypot(x - xs[oi][0], y - xs[oi][1]))
          }
          if (k >= P.PLANE_MIN && ext >= P.PLANE_EXT && w > bestSc) {
            const oi = o ? ps.indexOf(o) : -1
            best = { k, w, o, t0: o ? ps[0].t + (a + b * xs[oi][0] + cc * xs[oi][1]) * 1000 : 0 }
          }
        }
      }
    }
    return best
  }
  const okFit = (f: Fit) => (f.k >= P.CONF_MIN && f.w >= P.CONF_W) || (f.k >= P.CONF2_MIN && f.w >= P.CONF2_W)
  function extentKm(c: Cluster) { let m = 0; for (const p of c.picks) { const d = dist(c.first.i, p.i); if (d > m) m = d } return m }

  return {
    /** 平常のゆらぎの表を差し替える。発火のしきい値の基準を作り直し、実行中に引き上げた分は差として残す */
    setTables(next: QuietTables): void {
      for (let i = 0; i < n; i++) {
        const up = thr[i] - thr0[i]
        thr0[i] = thresholdOf(next.fire[quietSiteKey(sites[i])])
        thr[i] = thr0[i] + up
      }
    },
    /** 1 秒ぶんを入れ、確かな段の塊を返す */
    push(f: DetectorFrame): DetectorReport[] {
      const v = f.values, now = f.ms
      lastV = v
      // 窓の更新: t-LAG の値を入れ、t-L の値を出す（ring は直近 L 個）
      if (frames >= LAG) {
        const pin = (pos - LAG + L) % L
        for (let i = 0; i < n; i++) {
          const x = ring[pin * n + i]
          if (x < 0) continue
          cnt[i * 22 + x]++
          if (x > mx[i]) mx[i] = x
        }
      }
      if (frames >= L) {
        const pout = pos // これから上書きする所 = L 秒前
        for (let i = 0; i < n; i++) {
          const x = ring[pout * n + i]
          if (x < 0) continue
          const c = --cnt[i * 22 + x]
          if (c === 0 && x === mx[i]) { let m = x; while (m >= 0 && cnt[i * 22 + m] === 0) m--; mx[i] = m }
        }
      }
      ring.set(v, pos * n); pos = (pos + 1) % L; frames++
      if (frames < 20) return []
      // 発火
      const newPicks: Pick[] = []
      for (let i = 0; i < n; i++) {
        const p = pickOf[i]
        if (p && (now - p.t > P.ACTIVE_SEC * 1000)) {
          pickOf[i] = null
          // 確かな段に乗らなかった発火は、その点の「空振り」として数え、多ければしきい値を上げる（学習は窓の中だけ）
          if (!clusters.get(p.cl)?.confirmed) {
            orphan[i] = orphan[i] * Math.exp(-(now - orphanT[i]) / (P.ADAPT_TAU * 1000)) + 1; orphanT[i] = now
            thr[i] = thr0[i] + Math.min(P.ADAPT_MAXUP, Math.floor(orphan[i] / P.ADAPT_N))
          }
        }
        if (thr[i] > thr0[i] && now - orphanT[i] > 600_000) {
          orphan[i] *= Math.exp(-(now - orphanT[i]) / (P.ADAPT_TAU * 1000)); orphanT[i] = now
          thr[i] = thr0[i] + Math.min(P.ADAPT_MAXUP, Math.floor(orphan[i] / P.ADAPT_N))
        }
        if (v[i] < 0 || mx[i] < 0) continue
        const e = v[i] - mx[i]
        const cur = pickOf[i]
        if (cur) { if (e > cur.e) cur.e = e; continue }
        if (e >= thr[i]) { const np: Pick = { i, t: now, e, cl: 0 }; pickOf[i] = np; newPicks.push(np) }
      }
      // 塊へ: 新しい発火ごとに、近くの生きた発火の塊を集める
      for (const p of newPicks) {
        const cand = new Set<number>()
        const ns = nb[p.i], ds = dd[p.i]
        for (let k = 0; k < ns.length; k++) {
          const q = pickOf[ns[k]]
          if (!q || q === p || q.cl === 0) continue
          if (Math.abs(p.t - q.t) / 1000 <= ds[k] / P.VLINK + P.TSLACK) cand.add(q.cl)
        }
        // 確かな段を出した塊の足跡の中なら、その塊へ戻す（同じ揺れの後続の波で別の検知を立てない）
        if (cand.size === 0 && footUntil[p.i] > now && clusters.has(footId[p.i]) && now - clusters.get(footId[p.i])!.lastGrow <= P.FOOT_GAP * 1000) cand.add(footId[p.i])
        if (cand.size === 0) {
          const c: Cluster = { id: nextId++, picks: [p], first: p, startMs: p.t, lastGrow: now, confirmed: false, confAt: 0, born: now }
          clusters.set(c.id, c); p.cl = c.id
        } else {
          const ids = [...cand].sort((a, b) => a - b)
          const keepId = ids.find(id => clusters.get(id)!.confirmed) ?? ids[0], keep = clusters.get(keepId)!
          for (const id of ids.filter(x => x !== keepId)) {
            const o = clusters.get(id)!
            for (const q of o.picks) { q.cl = keep.id; keep.picks.push(q) }
            if (!keep.confirmed && o.first.t < keep.first.t) keep.first = o.first
            clusters.delete(id)
          }
          keep.picks.push(p); p.cl = keep.id; keep.lastGrow = now
        }
      }
      // 塊の判定
      const out: DetectorReport[] = []
      for (const c of [...clusters.values()]) {
        c.picks = c.picks.filter(p => pickOf[p.i] === p)
        if (c.picks.length === 0 && !(c.confirmed && now - c.lastGrow <= P.REFRACT_SEC * 1000)) { clusters.delete(c.id); continue }
        if (c.confirmed) for (const p of c.picks) if (p.foot !== c.id) { p.foot = c.id; markFoot(p.i, c.id, now) }
        if (!c.confirmed) {
          c.first = c.picks.reduce((a, p) => (p.t < a.t ? p : a)); c.startMs = c.first.t
          if (c.picks.length >= 3) {
            const fit = fitWave(c)
            if (fit.o) { c.first = fit.o; c.startMs = Math.max(fit.t0, c.first.t - P.FIT_RES * 1000) }
            if (c.picks.length >= Math.min(P.CONF_MIN, P.CONF2_MIN) && extentKm(c) >= P.CONF_EXTENT_KM && okFit(fit)) {
              c.confirmed = true; c.confAt = now
              for (const p of c.picks) { p.foot = c.id; markFoot(p.i, c.id, now) }
            }
          }
        }
        if (c.confirmed && now - c.lastGrow <= P.HOLD_SEC * 1000) {
          const loc = sites[c.first.i]
          // 足跡で保っている間は生きた発火が無いこともあるので、そのときは波面の起点の点で支える
          const members = c.picks.length ? c.picks.map(p => p.i) : [c.first.i]
          out.push({ id: `c${c.id}`, tier: 'confirmed', lat: loc[0], lng: loc[1], startMs: Math.round(c.startMs), sites: members })
        }
      }
      return out
    },
  }
}
