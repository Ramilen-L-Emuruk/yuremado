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
import { quietSiteKey, type QuietTables } from './kyoshinQuietTables'
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
 * まばらな所の規則: SP_KM 以内の点が SP_MAXN 以下しかない点と、近くの点だけが少ない点（下記 SP_NEAR_*。条件を絞る）が対象。その点が直前 F_WIN 秒の最小（静かな点は SP_WIDE_WIN 秒の最小も）より SP_RISE 段以上跳ね、
 * SP_KM 以内の別の点も SP_NB 段以上上がっていて、上がった時刻の差が「距離 / 3 km/s + SP_SLACK 秒」以内なら検知する。
 * 同じ点が SP_QUIET 秒の内に跳ねていたら、揺れの続きとして新しい跳ねに数えない（ゆらぎの多い点の判定は SP_NOISE_*）
 * 近くの点だけが少ない点では、組にする隣の距離と上がりの条件が別になる（下記 SP_NEAR_*）
 */
const SP_KM = 120, SP_MAXN = 6, SP_RISE = 5, SP_NB = 3, SP_SLACK = 3, SP_QUIET = 60
/** 早い段だけを出す低いしきい値の経路 */
const SP_ERISE = 4
/** 跳ねた点より隣が後から上がっても、跳ねてからこの秒数までは組にする */
const SP_PAIR_MAX = 45
/**
 * 直前 SP_NOISE_WIN 秒（直近 SP_QUIET 秒は数えない）に SP_NB 段以上上がった秒が SP_NOISE_MAX を超える点は、ゆらぎの多い点として使わない。
 * 数えるのは、上がってから SP_SPIKE_SEC 秒以内に元の値（上がる前の最小 +1 段）へ戻った上がりだけ。上がったまま続いた秒は地震の揺れなので数えない
 * —— 数えると、有感地震の後 30 分はその点の余震を拾えず、取りこぼした揺れがまた数えられて次の地震も落ちる
 */
const SP_NOISE_WIN = 1800, SP_NOISE_MAX = 3, SP_SPIKE_SEC = 5
/** 1 点だけの跳ね（早い段だけ）: まばらな点がこの段数以上跳ねたら、隣の裏付けが無くても、ゆらぎの多い点でなければ早い段を出す */
const SP_SOLO = 6
/**
 * 広い窓: 平常から細かくちらつかない点に限り、跳ねを直前 SP_WIDE_WIN フレームの最小からも測る（大きい方を使う）。
 * 揺れが 10 秒以上かけて少しずつ上がる点は、F_WIN フレームの最小からでは SP_RISE 段に届かない。
 * 細かくちらつく点では長い窓の最小がちらつきの谷を拾い、上がったまま留まった値まで跳ねに数えてしまうので、
 * 平常のゆらぎの表で 1 段以上の上がりが 1 時間に SP_WIDE_FIRE1 秒以下の点だけに効かせる（表に無い点は広げない）。
 * 長い窓の最小は、欠測を挟まない直近の続きだけから取る —— 欠測の前の最小から、欠測明けの値を跳ねとして測らないため
 */
const SP_WIDE_WIN = 30, SP_WIDE_FIRE1 = 20
/**
 * 騒がしい点の天井: 平常のゆらぎの表で 1 段以上の上がりが 1 時間に SP_WIDE_FIRE1 秒を超える点は、早い段だけの経路では、
 * 跳ねた値が直前 SP_CEIL_LAG〜SP_CEIL_L−1 秒の最大を SP_CEIL_RISE 段以上超えたときだけ起点にする。
 * 沖縄本島の点などは、上がって 1 分ほど居座ってから戻るゆらぎを 1 日に何度も出し、一瞬落ちてから元の高さへ戻るだけで
 * 直前 F_WIN 秒の最小からは跳ねに見える。直前 1 分の最大（平常のゆらぎの表の雑音の物差しと同じ窓）を超えない戻りは起点にしない（設計書§67）
 */
const SP_CEIL_LAG = 3, SP_CEIL_L = 60, SP_CEIL_RISE = 3
/**
 * その場で騒がしいとみる点: 直近 SP_LOUD_WIN 秒に、隣の点が時間差（「距離 / 3 km/s ＋ SP_SLACK」）の内に 1 つも上がらなかった居座り
 * （SP_SPIKE_SEC 秒のうちに戻らなかった SP_NB 段以上の上がり）を SP_LOUD_N 回以上出した点も、騒がしい点と同じく天井を見る。
 * 表を焼いた日には静かでも、その時期だけ居座るゆらぎを繰り返す点（久米島・対馬など）があるため（設計書§68）。
 * 隣の裏付けがあったかは、上がり始めから SP_PAIR_MAX 秒たってから、点ごとに直近 SP_HIST_SEC 秒の上がった秒で見る
 */
const SP_LOUD_WIN = 21600, SP_LOUD_N = 3, SP_HIST_SEC = 100
/**
 * 近くの点だけが少ない点: SP_KM 以内には点が多くても、SP_NEAR_KM 以内に 1〜SP_NEAR_MAXN 点しかない点（伊豆諸島・奥尻・対馬など）も規則に入れる。
 * ただし主の経路で同じ時間差の内に組になったときだけ当て（早い段だけの経路・1 点の跳ね・後から組にする向きでは当てない）、組にする隣は SP_NEAR_KM 以内で SP_NEAR_NB 段以上上がった点に限り、
 * 跳ねた点も隣もゆらぎの多い点でないことを求める —— 絞らないと、離島の点のゆらぎで当たらない確かな段が大きく増える（設計書§54）
 */
const SP_NEAR_KM = 40, SP_NEAR_MAXN = 2, SP_NEAR_NB = 4

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
  /** 直近 SP_WIDE_WIN 秒の値と、その点ごとの最小（まばらな所の規則の広い窓）。最小は新しい方から欠測に当たるまでの値で取る */
  const wideRing: Int8Array[] = []
  let wideMn = new Int8Array(n).fill(127)
  const wideRingMin = () => {
    wideMn = new Int8Array(n).fill(127)
    for (let i = 0; i < n; i++) {
      for (let k = wideRing.length - 1; k >= 0; k--) {
        const x = wideRing[k][i]
        if (x < 0) break
        if (x < wideMn[i]) wideMn[i] = x
      }
    }
  }
  /** 広い窓を効かせる点（平常から細かくちらつかない点）。表を差し替えたら引き直す */
  const wideOkOf = (t: QuietTables) => sites.map((s) => { const r = t.fire[quietSiteKey(s)]; return !!r && r[0] <= SP_WIDE_FIRE1 })
  let wideOk = wideOkOf(tables)
  /** 天井を見る点（騒がしい点）と、直前 SP_CEIL_L−1 秒の値 */
  const loudOf = (t: QuietTables) => sites.map((s) => { const r = t.fire[quietSiteKey(s)]; return !!r && r[0] > SP_WIDE_FIRE1 })
  let loud = loudOf(tables)
  const ceilRing: Int8Array[] = []
  const ceilOf = (i: number) => {
    let mx = -1
    for (let d = SP_CEIL_LAG; d <= ceilRing.length; d++) { const x = ceilRing[ceilRing.length - d][i]; if (x > mx) mx = x }
    return mx
  }
  const nbS: { j: number; d: number }[][] = sites.map((s, i) => {
    const l: { j: number; d: number }[] = []
    for (let j = 0; j < n; j++) if (j !== i) { const d = hav(s[0], s[1], sites[j][0], sites[j][1]); if (d <= SP_KM) l.push({ j, d }) }
    return l
  })
  /** まばらな所の規則の対象。0 = 対象外・1 = SP_KM 以内の点が少ない点・2 = 近くの点だけが少ない点（SP_NEAR_KM 以内に 1〜SP_NEAR_MAXN 点） */
  const sparseKind = nbS.map((l) => {
    if (l.length === 0) return 0
    if (l.length <= SP_MAXN) return 1
    const c = l.filter(x => x.d <= SP_NEAR_KM).length
    return c >= 1 && c <= SP_NEAR_MAXN ? 2 : 0
  })

  /** まばらな所の規則。跳ねの段数ごとに状態を分けて持つ。withConfirmed が偽なら早い段だけを出す */
  const makeSparse = (spRise: number, withConfirmed: boolean, tag: string) => {
    const lastNb = new Float64Array(n).fill(-Infinity), lastBig = new Float64Array(n).fill(-Infinity)
    /** 点ごとの、直前 F_WIN フレームの最小から SP_NEAR_NB 段以上上がった最後のフレームの時刻（近くの点だけが少ない点の組の相手） */
    const lastNear = new Float64Array(n).fill(-Infinity)
    const sparses: Fast[] = []
    const trigAt = new Float64Array(n).fill(-Infinity)
    /** 点ごとの、すぐ戻った SP_NB 段以上の上がりの秒（ゆらぎの多さを数える） */
    const nbSecs: number[][] = Array.from({ length: n }, () => [])
    /** 戻るのを待っている上がりの秒と、上がる前の最小 */
    const pend: number[][] = Array.from({ length: n }, () => [])
    const pendBase = new Int8Array(n)
    /**
     * SP_SPIKE_SEC 秒のうちに戻らなかった上がりが居座り始めた時刻（居座っていなければ NaN）。居座りの間は新しい上がりを待ち始めない
     * —— 始めると、10 秒ほど続いてから急に静まる揺れの後半を、すぐ戻った跳ねとして数えてしまう。元の値へ戻るか、
     * SP_NOISE_WIN 秒たつ（元の値そのものが上がったまま）まで続ける
     */
    const heldAt = new Float64Array(n).fill(NaN)
    /** 点ごとの、直近 SP_HIST_SEC 秒に SP_NB 段以上上がった秒（居座った上がりに隣の裏付けがあったかを後から見る） */
    const nbHist: number[][] = Array.from({ length: n }, () => [])
    /** 裏付けを待っている居座った上がり（点・上がり始め） */
    const heldPend: { i: number; t0: number }[] = []
    /** 点ごとの、隣の裏付けの無い居座った上がりの始まり（直近 SP_LOUD_WIN 秒） */
    const soloHolds: number[][] = Array.from({ length: n }, () => [])
    /** 天井を見る点か: 平常のゆらぎの表で騒がしい点か、直近に隣の裏付けの無い居座りを SP_LOUD_N 回以上出した点 */
    const loudNow = (i: number, now: number) => {
      if (loud[i]) return true
      let c = 0
      for (const t of soloHolds[i]) if (now - t <= SP_LOUD_WIN * 1000) c++
      return c >= SP_LOUD_N
    }
    const noisy = (i: number, now: number) => {
      let c = 0
      for (const t of nbSecs[i]) if (now - t > SP_QUIET * 1000 && now - t <= SP_NOISE_WIN * 1000) c++
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
        /** この秒に跳ねた、近くの点だけが少ない点 */
        const nearCands: number[] = []
        // 居座った上がりのうち、隣の点が時間差の内に 1 つも上がらなかったものを、その点の居座る雑音として数える
        for (let k = heldPend.length - 1; k >= 0; k--) {
          const h = heldPend[k]
          if (f.ms - h.t0 < SP_PAIR_MAX * 1000) continue
          heldPend.splice(k, 1)
          if (nbS[h.i].some(({ j, d }) => nbHist[j].some(t => Math.abs(t - h.t0) <= (d / 3 + SP_SLACK) * 1000))) continue
          const l = soloHolds[h.i]
          l.push(h.t0)
          while (l.length && f.ms - l[0] > SP_LOUD_WIN * 1000) l.shift()
        }
        for (let i = 0; i < n; i++) {
          const r = rise(i)
          // その場で騒がしいとみる点の数え（天井を見るのは早い段だけの経路なので、主の経路では数えない）
          if (!withConfirmed && r >= SP_NB) {
            const hl = nbHist[i]
            hl.push(f.ms)
            while (hl.length && f.ms - hl[0] > SP_HIST_SEC * 1000) hl.shift()
          }
          /** 跳ね（広い窓を効かせる点は、長い窓の最小からの上がりと大きい方）。隣の上がりとゆらぎの数え方は r のまま */
          const jump = wideOk[i] && v[i] >= 0 && wideMn[i] !== 127 ? Math.max(r, v[i] - wideMn[i]) : r
          const p = pend[i]
          const held = !Number.isNaN(heldAt[i])
          if (p.length || held) {
            if (v[i] >= 0 && v[i] <= pendBase[i] + 1) {
              // SP_SPIKE_SEC 秒以内に戻った上がりだけをゆらぎとして数える（居座った上がりは数えない）
              if (p.length && f.ms - p[0] <= SP_SPIKE_SEC * 1000) {
                const l = nbSecs[i]
                l.push(...p)
                while (l.length && f.ms - l[0] > SP_NOISE_WIN * 1000) l.shift()
              }
              p.length = 0
              heldAt[i] = NaN
            } else if (p.length && f.ms - p[0] > SP_SPIKE_SEC * 1000) {
              if (!withConfirmed && sparseKind[i] !== 0) heldPend.push({ i, t0: p[0] })
              p.length = 0
              heldAt[i] = f.ms
            } else if (held && f.ms - heldAt[i] > SP_NOISE_WIN * 1000) heldAt[i] = NaN
          }
          if (r >= SP_NEAR_NB) lastNear[i] = f.ms
          if (r >= SP_NB) {
            lastNb[i] = f.ms
            if (Number.isNaN(heldAt[i])) {
              if (!p.length) pendBase[i] = mn[i]
              p.push(f.ms)
            }
          }
          if (jump < spRise || sparseKind[i] === 0) { if (jump >= spRise) lastBig[i] = f.ms; continue }
          // 騒がしい点（表で騒がしいか、直近に隣の裏付けの無い居座りを繰り返した点）は、直前 1 分の天井へ戻っただけの跳ねを起点にしない（隣の相手としての上がりは数えたまま）
          if (!withConfirmed && loudNow(i, f.ms) && v[i] - ceilOf(i) < SP_CEIL_RISE) continue
          const quiet = f.ms - lastBig[i] > SP_QUIET * 1000 || f.ms - lastBig[i] <= 1000
          if (f.ms - lastBig[i] > 1000) lastBig[i] = f.ms
          if (!quiet) continue
          if (sparseKind[i] === 2) {
            // 組の相手は全点の lastNear を書き終えてから見る（観測点の並び順で、同じ秒に上がった隣を取りこぼさないため）
            if (withConfirmed && !noisy(i, f.ms)) nearCands.push(i)
            continue
          }
          let ok = false
          for (const { j, d } of nbS[i]) if (Math.abs(f.ms - lastNb[j]) <= (d / 3 + SP_SLACK) * 1000) { ok = true; break }
          if (!ok && !withConfirmed && jump >= SP_SOLO && !noisy(i, f.ms)) { hit(i, f.ms - 1000, f.ms); continue }
          if (!ok) { trigAt[i] = f.ms; continue }
          if (!withConfirmed && noisy(i, f.ms)) continue
          hit(i, f.ms - 1000, f.ms)
        }
        for (const i of nearCands) {
          for (const { j, d } of nbS[i]) {
            if (d <= SP_NEAR_KM && !noisy(j, f.ms) && Math.abs(f.ms - lastNear[j]) <= (d / 3 + SP_SLACK) * 1000) { hit(i, f.ms - 1000, f.ms); break }
          }
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
      wideOk = wideOkOf(next)
      loud = loudOf(next)
    },
    /** 1 秒ぶんを入れ、いま出ている束（段階ごとに 1 行）を返す */
    push(f: DetectorFrame): EnsembleReport[] {
      const subs: [string, DetectorReport][] = stat.push(f).map(r => [`s:${r.id}`, r] as [string, DetectorReport])
      for (const r of cluster.push(f)) { subs.push([`c:${r.id}`, r]); subs.push([`c:${r.id}`, { ...r, tier: 'early' }]) }
      if (ring.length >= 3) { ringMin(); wideRingMin() }
      subs.push(...fastStep(f))
      subs.push(...sparseMain(f), ...sparseEarly(f))
      ring.push(Int8Array.from(f.values))
      if (ring.length > F_WIN) ring.shift()
      wideRing.push(Int8Array.from(f.values))
      if (wideRing.length > SP_WIDE_WIN) wideRing.shift()
      ceilRing.push(Int8Array.from(f.values))
      if (ceilRing.length > SP_CEIL_L - 1) ceilRing.shift()
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
