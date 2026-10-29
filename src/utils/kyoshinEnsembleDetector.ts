/**
 * 組み合わせの揺れ検知器。統計（`kyoshinStatDetector.ts`）と波面（`kyoshinClusterDetector.ts`）を並べて走らせ、
 * 高い震度の近道とまばらな所の規則を足して、検知を束ねる。
 *
 * - 確かな段 = 統計の確かな段・波面の確かな段・近道・まばらな所の規則（組になったもの）のどれか
 * - 早い段 = 統計の早い段か、どれかの確かな段か、まばらな所の早い段だけの経路（波面の早い段は誤検知が多いので使わない）
 * - 同じ揺れは 1 つの id: 新しく出た検知は、生きている束の位置から MERGE_KM 以内・始まりの差が MERGE_SEC 秒以内なら同じ束へ。
 *   位置と始まりは、束を作った検知のもの（後から入った検知で動かさない）
 *
 * 値はすべて、組み合わせの検知器を評価したときのもの（値の一覧は仕様書§5、評価の経緯は設計書§43）。
 */
import { createClusterDetector } from './kyoshinClusterDetector'
import type { QuietTables } from './kyoshinQuietTables'
import { createStatDetector, type DetectorFrame, type DetectorReport } from './kyoshinStatDetector'

export type { DetectorFrame, DetectorReport } from './kyoshinStatDetector'

const MERGE_KM = 100
const MERGE_SEC = 15
const KEEP_SEC = 30
/** 束がどの部分からも報告されなくなってから捨てるまで（ミリ秒）。検知の組み立て（`kyoshinEnsembleTracker.ts`）も同じ長さで検知を消す */
export const ENSEMBLE_KEEP_MS = KEEP_SEC * 1000
/**
 * 高い震度の近道: ある点が直前 F_WIN 秒の最小より F_RISE 段以上跳ねて段 F_HI 以上（段 12 = 計測震度 3.0）、
 * かつ F_NB_KM 以内の別の点も F_NB_RISE 段以上上がって段 F_NB_LV 以上（段 8 = 計測震度 1.0）なら、その場で確かな段にする。
 * 大きな地震は最初の数点が数秒で何段も跳ねるのに、統計・波面は点の数がそろうまで確定しないため
 */
const F_HI = 12, F_RISE = 6, F_NB_KM = 40, F_NB_LV = 8, F_NB_RISE = 4, F_WIN = 10, F_HOLD = 30
/**
 * まばらな所の規則: SP_KM 以内の点が SP_MAXN 以下しかない点だけが対象。その点が直前 F_WIN 秒の最小より SP_RISE 段以上跳ね、
 * SP_KM 以内の別の点も SP_NB 段以上上がっていて、上がった時刻の差が「距離 / 3 km/s + SP_SLACK 秒」以内なら検知する。
 * 同じ点が SP_QUIET 秒の内に跳ねていたら、揺れの続きとして新しい跳ねに数えない（ゆらぎの多い点の判定は SP_NOISE_*）
 */
const SP_KM = 120, SP_MAXN = 6, SP_RISE = 5, SP_NB = 3, SP_SLACK = 3, SP_QUIET = 60
/** 早い段だけを出す低いしきい値の経路 */
const SP_ERISE = 4
/** 跳ねた点より隣が後から上がっても、跳ねてからこの秒数までは組にする */
const SP_PAIR_MAX = 45
/** 直前 SP_NOISE_WIN 秒（直近 SP_QUIET 秒は数えない）に SP_NB 段以上上がった秒が SP_NOISE_MAX を超える点は、ゆらぎの多い点として使わない */
const SP_NOISE_WIN = 1800, SP_NOISE_MAX = 3
/** 1 点だけの跳ね（早い段だけ）: まばらな点がこの段数以上跳ねたら、隣の裏付けが無くても、ゆらぎの多い点でなければ早い段を出す */
const SP_SOLO = 6

const RAD = Math.PI / 180
const hav = (a: number, b: number, c: number, d: number) => {
  const x = Math.sin((c - a) * RAD / 2) ** 2 + Math.cos(a * RAD) * Math.cos(c * RAD) * Math.sin((d - b) * RAD / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(x))
}

/** 束を支えた部分。統計・波面・高い震度の近道・まばらな所の規則 */
export type EnsembleSource = 'stat' | 'cluster' | 'fast' | 'sparse'
/** 束の出力。その秒に束を支えた観測点（`sites`）は、どの部分が支えたかを問わず合わせたもの */
export interface EnsembleReport extends DetectorReport {
  sources: readonly EnsembleSource[]
}
/** 束の鍵の頭の文字から、支えた部分を引く */
const SOURCE_OF: Record<string, EnsembleSource> = { s: 'stat', c: 'cluster', f: 'fast', p: 'sparse', q: 'sparse' }

type Fast = { id: string; site: number; startMs: number; lastHit: number }
type Bundle = { id: string; lat: number; lng: number; startMs: number; lastSeen: number }

export function createEnsembleDetector(sites: readonly (readonly [number, number])[], tables: QuietTables) {
  const stat = createStatDetector(sites, tables)
  const cluster = createClusterDetector(sites, tables)
  const bundles: Bundle[] = []
  const owner = new Map<string, Bundle>()
  let seq = 0
  const n = sites.length
  /** 直近 F_WIN 秒の値（近道とまばらな所の規則が共有する） */
  const ring: Int8Array[] = []
  const nbF: Int32Array[] = sites.map((s, i) => {
    const l: number[] = []
    for (let j = 0; j < n; j++) if (j !== i && hav(s[0], s[1], sites[j][0], sites[j][1]) <= F_NB_KM) l.push(j)
    return Int32Array.from(l)
  })
  const fasts: Fast[] = []
  let fseq = 0
  /** 直前 F_WIN 秒の点ごとの最小（127 = 値が無い） */
  let mn = new Int8Array(n).fill(127)
  const ringMin = () => { mn = new Int8Array(n).fill(127); for (const r of ring) for (let i = 0; i < n; i++) if (r[i] >= 0 && r[i] < mn[i]) mn[i] = r[i] }
  const nbS: { j: number; d: number }[][] = sites.map((s, i) => {
    const l: { j: number; d: number }[] = []
    for (let j = 0; j < n; j++) if (j !== i) { const d = hav(s[0], s[1], sites[j][0], sites[j][1]); if (d <= SP_KM) l.push({ j, d }) }
    return l
  })

  /** まばらな所の規則。跳ねの段数ごとに状態を分けて持つ。withConfirmed が偽なら早い段だけを出す */
  const makeSparse = (spRise: number, withConfirmed: boolean, tag: string) => {
    const lastNb = new Float64Array(n).fill(-Infinity), lastBig = new Float64Array(n).fill(-Infinity)
    const sparses: Fast[] = []
    const trigAt = new Float64Array(n).fill(-Infinity)
    /** 点ごとの SP_NB 段以上の上がりがあった秒（ゆらぎの多さを数える） */
    const nbSecs: number[][] = Array.from({ length: n }, () => [])
    const noisy = (i: number, now: number) => {
      let c = 0
      for (const t of nbSecs[i]) if (now - t > SP_QUIET * 1000) c++
      return c > SP_NOISE_MAX
    }
    let sseq = 0
    const hit = (i: number, startMs: number, now: number) => {
      let e = sparses.find(x => now - x.lastHit <= F_HOLD * 1000 && hav(sites[x.site][0], sites[x.site][1], sites[i][0], sites[i][1]) <= MERGE_KM)
      if (!e) { e = { id: `${tag}${sseq++}`, site: i, startMs, lastHit: now }; sparses.push(e) }
      e.lastHit = now
    }
    return (f: DetectorFrame): [string, DetectorReport][] => {
      const v = f.values, out: [string, DetectorReport][] = []
      if (ring.length >= 3) {
        const rise = (i: number) => (v[i] >= 0 && mn[i] !== 127 ? v[i] - mn[i] : -99)
        for (let i = 0; i < n; i++) {
          const r = rise(i)
          if (r >= SP_NB) {
            lastNb[i] = f.ms
            const l = nbSecs[i]
            l.push(f.ms)
            while (l.length && f.ms - l[0] > SP_NOISE_WIN * 1000) l.shift()
          }
          if (r < spRise || nbS[i].length > SP_MAXN || nbS[i].length === 0) { if (r >= spRise) lastBig[i] = f.ms; continue }
          const quiet = f.ms - lastBig[i] > SP_QUIET * 1000 || f.ms - lastBig[i] <= 1000
          if (f.ms - lastBig[i] > 1000) lastBig[i] = f.ms
          if (!quiet) continue
          let ok = false
          for (const { j, d } of nbS[i]) if (Math.abs(f.ms - lastNb[j]) <= (d / 3 + SP_SLACK) * 1000) { ok = true; break }
          if (!ok && !withConfirmed && r >= SP_SOLO && !noisy(i, f.ms)) { hit(i, f.ms - 1000, f.ms); continue }
          if (!ok) { trigAt[i] = f.ms; continue }
          if (!withConfirmed && noisy(i, f.ms)) continue
          hit(i, f.ms - 1000, f.ms)
        }
        // 跳ねた点より隣が後から上がった場合も、同じ時間差の内なら組にする
        for (let i = 0; i < n; i++) {
          if (f.ms - trigAt[i] > SP_PAIR_MAX * 1000) continue
          if (noisy(i, trigAt[i])) { trigAt[i] = -Infinity; continue }
          for (const { j, d } of nbS[i]) {
            if (noisy(j, lastNb[j])) continue
            const dt = lastNb[j] - trigAt[i]
            if (dt >= 0 && dt <= (d / 3 + SP_SLACK) * 1000) { hit(i, trigAt[i] - 1000, f.ms); trigAt[i] = -Infinity; break }
          }
        }
      }
      for (let k = sparses.length - 1; k >= 0; k--) {
        const e = sparses[k]
        if (f.ms - e.lastHit > F_HOLD * 1000) { sparses.splice(k, 1); continue }
        const r: DetectorReport = { id: e.id, tier: 'early', lat: sites[e.site][0], lng: sites[e.site][1], startMs: e.startMs, sites: [e.site] }
        out.push([`${tag}:${e.id}`, r])
        if (withConfirmed) out.push([`${tag}:${e.id}`, { ...r, tier: 'confirmed' }])
      }
      return out
    }
  }
  const sparseMain = makeSparse(SP_RISE, true, 'p')
  const sparseEarly = makeSparse(SP_ERISE, false, 'q')

  const fastStep = (f: DetectorFrame): [string, DetectorReport][] => {
    const v = f.values, out: [string, DetectorReport][] = []
    if (ring.length >= 3) {
      const rise = (i: number) => (v[i] >= 0 && mn[i] !== 127 ? v[i] - mn[i] : -99)
      for (let i = 0; i < n; i++) {
        if (v[i] < F_HI || rise(i) < F_RISE) continue
        let ok = false
        for (const j of nbF[i]) if (v[j] >= F_NB_LV && rise(j) >= F_NB_RISE) { ok = true; break }
        if (!ok) continue
        let e = fasts.find(x => f.ms - x.lastHit <= F_HOLD * 1000 && hav(sites[x.site][0], sites[x.site][1], sites[i][0], sites[i][1]) <= MERGE_KM)
        if (!e) { e = { id: `f${fseq++}`, site: i, startMs: f.ms - 1000, lastHit: f.ms }; fasts.push(e) }
        e.lastHit = f.ms
      }
    }
    for (let k = fasts.length - 1; k >= 0; k--) {
      const e = fasts[k]
      if (f.ms - e.lastHit > F_HOLD * 1000) { fasts.splice(k, 1); continue }
      const r: DetectorReport = { id: e.id, tier: 'confirmed', lat: sites[e.site][0], lng: sites[e.site][1], startMs: e.startMs, sites: [e.site] }
      out.push([`f:${e.id}`, r], [`f:${e.id}`, { ...r, tier: 'early' }])
    }
    return out
  }

  const bundleOf = (key: string, r: DetectorReport, now: number) => {
    let b = owner.get(key)
    if (b) return b
    b = bundles.find(x => now - x.lastSeen <= KEEP_SEC * 1000 && Math.abs(x.startMs - r.startMs) <= MERGE_SEC * 1000 && hav(x.lat, x.lng, r.lat, r.lng) <= MERGE_KM)
    if (!b) { b = { id: `e${seq++}`, lat: r.lat, lng: r.lng, startMs: r.startMs, lastSeen: now }; bundles.push(b) }
    owner.set(key, b)
    return b
  }

  return {
    /**
     * 平常のゆらぎの表を差し替える（端末で学び直した表を入れるため）。追っている揺れ・直近に数えた分は残すので、
     * 作り直す（`createEnsembleDetector` を呼び直す）のと違い、揺れの最中に入れ替えても検知が途切れない
     */
    setTables(next: QuietTables): void {
      stat.setTables(next)
      cluster.setTables(next)
    },
    /** 1 秒ぶんを入れ、いま出ている束（段階ごとに 1 行）を返す */
    push(f: DetectorFrame): EnsembleReport[] {
      const subs: [string, DetectorReport][] = stat.push(f).map(r => [`s:${r.id}`, r] as [string, DetectorReport])
      for (const r of cluster.push(f)) { subs.push([`c:${r.id}`, r]); subs.push([`c:${r.id}`, { ...r, tier: 'early' }]) }
      if (ring.length >= 3) ringMin()
      subs.push(...fastStep(f))
      subs.push(...sparseMain(f), ...sparseEarly(f))
      ring.push(Int8Array.from(f.values))
      if (ring.length > F_WIN) ring.shift()
      type Row = { sites: Set<number>; sources: Set<EnsembleSource> }
      const tiers = new Map<Bundle, Map<DetectorReport['tier'], Row>>()
      const add = (b: Bundle, r: DetectorReport, source: EnsembleSource) => {
        let byTier = tiers.get(b)
        if (!byTier) { byTier = new Map(); tiers.set(b, byTier) }
        let row = byTier.get(r.tier)
        if (!row) { row = { sites: new Set(), sources: new Set() }; byTier.set(r.tier, row) }
        for (const i of r.sites) row.sites.add(i)
        row.sources.add(source)
      }
      for (const [key, r] of subs) {
        const b = bundleOf(key, r, f.ms)
        b.lastSeen = f.ms
        add(b, r, SOURCE_OF[key[0]])
      }
      for (let k = bundles.length - 1; k >= 0; k--) {
        if (f.ms - bundles[k].lastSeen <= KEEP_SEC * 1000) continue
        const b = bundles[k]
        bundles.splice(k, 1)
        for (const [key, o] of owner) if (o === b) owner.delete(key)
      }
      const out: EnsembleReport[] = []
      for (const [b, byTier] of tiers) {
        for (const [t, row] of byTier) out.push({ id: b.id, tier: t, lat: b.lat, lng: b.lng, startMs: b.startMs, sites: [...row.sites], sources: [...row.sources] })
      }
      return out
    },
  }
}
