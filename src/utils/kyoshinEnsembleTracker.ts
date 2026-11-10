/**
 * 組み合わせの揺れ検知器（`kyoshinEnsembleDetector.ts`）の報告を、1 つの揺れにつき 1 件の検知へまとめる。
 *
 * 束ね役は秒ごとに「その秒に出ている束」を段階ごとに 1 行ずつ返すだけで、束が前の秒に何だったかは持たない。
 * 画面・音・診断が要るのは「その揺れがいまどの段か・どの観測点が加わったか・いつ確かな段になったか」なので、
 * ここで束の id ごとに積み上げる。
 *
 * - 段階は戻さない。一度確かな段の行が出た束は、その後に早い段の行しか出なくても確かな段のまま
 * - 加わった観測点は、束が生きている間に報告された点をすべて合わせる（減らさない）
 * - 地図に描く点（とカメラの寄せ先）は別に持つ。加わった点のうち、震度0 未満が `DRAWN_FADE_MS` 続いた点を外す（`drawnKeys`）
 * - 検知を消すのは、どの部分からも `ENSEMBLE_KEEP_MS` 報告されず、加わった点のうち震度1 以上の 2 点が互いに相手だった
 *   （`HOLD_PARTNER_KM`）最後の秒からも `ENSEMBLE_KEEP_MS` たったとき（揺れている点が残る間は消さない）
 */
import { computeSiteKeys, indexToValue } from './kyoshinSiteKeys'
import { ENSEMBLE_KEEP_MS, type DetectorFrame, type EnsembleReport, type EnsembleSource } from './kyoshinEnsembleDetector'
import type { QuietTables } from './kyoshinQuietTables'

/**
 * 加わった点を地図に描く点から外すまでの、震度0 未満が続いた長さ（ミリ秒）。
 * 測るのは最後に震度0 以上だった秒からの長さで、震度0 以上へ戻ったら描き直す。欠測の秒は震度0 以上に数えない
 * （欠測の点はどのみち地図に描かれず、カメラの寄せ先からも外れる）。
 * 外すと描く点が 1 つも残らない束では、最後に震度0 以上だった時刻がいちばん新しい点（同じ秒なら全部）だけを残す
 * （カメラの寄せ先を空にしないため。加わった点すべてへ戻すと、収まる直前に印とカメラの範囲が一斉に跳ねる。
 * 2026-10-29 ユーザー選択「最後まで残っていた点だけ (Recommended)」）。
 * 2026-10-29 ユーザー選択「60秒＋空にしない守り (Recommended)」（評価台の値は設計書§45）
 */
export const DRAWN_FADE_MS = 60_000

/** 加わった点のうち、最後に震度0 以上だった時刻がいちばん新しい点（同じ秒なら全部）。描く点が空になるときの残し先 */
function lastToFade(members: number[], lastUpMs: Map<number, number>): number[] {
  let latest = -Infinity
  for (const i of members) latest = Math.max(latest, lastUpMs.get(i) ?? -Infinity)
  return members.filter(i => lastUpMs.get(i) === latest)
}

/** 震度インデックスのうち計測震度 0.0（震度0 の下端）。これ未満が「震度0 未満」 */
const ZERO_INDEX = 6

/** 震度インデックスのうち計測震度 0.5（震度1 の下端） */
const ONE_INDEX = 7
/**
 * 検知を消さずに残すのは、加わった点のうち震度1 以上の 2 点が互いに相手になっている間。
 * 1 点で残さないのは、値が上がったまま居座る点 1 つで検知がいつまでも消えなくなるのを防ぐため（2026-11-05 ユーザー選択
 * 「B で入れる (Recommended)」・2026-11-06 ユーザー選択「まとめず、合図を 30 秒間引く (Recommended)」。設計書§70）。
 * 相手とみるのは、2 点の間が `HOLD_PARTNER_KM` 以内か、どちらかから近い順に値の届いている点を `HOLD_PARTNER_NEAREST` 個
 * たどる間にもう片方が入るとき。どこにいても 2 点を数える形では、加わった点が減らないので（`memberKeys`）、全国へ広がった
 * 点のうち離れた 2 点がたまたま震度1 相当のゆらぎを出すだけで検知が消えなかった（2026-11-09 13:52 茨城県沖）。
 * 距離だけでは観測点のまばらな所（能登）で同じ揺れの 2 点を切り、近さの順だけでは密な所で近い 2 点を切る（近い 5 点だけで数えた試作は、評価台の東京付近の窓で 9 km の 2 点を切った）。
 * 2026-11-10 ユーザー選択「40km か近い5点で入れる (Recommended)」（評価台・3 週の値は設計書§83）
 */
export const HOLD_PARTNER_KM = 40
export const HOLD_PARTNER_NEAREST = 5

/** 束ね役のうち、ここが使う口。テストで偽物を差し込めるよう、生の束ね役ではなくこれを受け取る */
export interface EnsembleReporter {
  push(f: DetectorFrame): EnsembleReport[]
  /** 平常のゆらぎの表を差し替える（作り直さないので、揺れの最中でも検知は途切れない） */
  setTables(tables: QuietTables): void
}

export interface EnsembleDetection {
  /** 束の id。同じ揺れの間は変わらない */
  id: string
  /** 早い段（`likely`）か確かな段（`confirmed`） */
  confidence: 'likely' | 'confirmed'
  /** 束を作った検知の位置（緯度・経度）。震源の推定ではない */
  epicenter: [number, number]
  /** 束を作った検知の揺れ始め（データ時刻・ミリ秒） */
  originTimeMs: number
  /** 加わった観測点の鍵（`computeSiteKeys`）。加わった順 */
  memberKeys: string[]
  /**
   * 加わった観測点のうち、地図に描く点（とカメラの寄せ先）の鍵。加わった順。
   * 震度0 未満が `DRAWN_FADE_MS` 続いた点を外す。`memberKeys` と違って減ることがあるが、空にはならない
   */
  drawnKeys: string[]
  /** 加わった観測点のいまの計測震度の最大。いま全員が欠測なら null */
  maxIntensity: number | null
  /** 初めて確かな段になったデータ時刻。まだなら null */
  firstConfirmedAtMs: number | null
  /** 束を支えた部分（統計・波面・高い震度の近道・まばらな所の規則）。束が生きている間に支えたものを合わせる */
  sources: EnsembleSource[]
  /** 束ね役が最後にこの束を報告したデータ時刻 */
  lastReportMs: number
  /**
   * 確かな段になった瞬間（その秒の観測点を足し終えた後）の点数と最大震度。まだなら null。
   * 画面の「6点・震度2で確定」はこれから作る。いまの値で言うと、収まりかけた後に点数も震度も確定した時と違って見える
   */
  confirmedSnapshot: { size: number; maxIntensity: number | null } | null
}

interface State {
  id: string
  confirmed: boolean
  epicenter: [number, number]
  originTimeMs: number
  members: number[]
  memberSet: Set<number>
  /** 点ごとの、最後に震度0 以上だった（まだなら加わった）データ時刻 */
  lastUpMs: Map<number, number>
  firstConfirmedAtMs: number | null
  confirmedSnapshot: { size: number; maxIntensity: number | null } | null
  sources: Set<EnsembleSource>
  lastReportMs: number
  /** 加わった点のうち震度1 以上の 2 点が互いに相手だった（`HOLD_PARTNER_KM`）最後のデータ時刻 */
  shakingMs: number
}

/** 加わった観測点のいまの計測震度の最大。全員が欠測なら null */
function maxIntensityOf(members: readonly number[], values: ArrayLike<number>): number | null {
  let max: number | null = null
  for (const i of members) {
    const v = values[i]
    if (v < 0) continue
    const x = indexToValue(v)
    if (max === null || x > max) max = x
  }
  return max
}

const DEG = Math.PI / 180

/** 2 点の大円距離（km） */
function distanceKm(a: [number, number], b: [number, number]): number {
  const x = Math.sin((b[0] - a[0]) * DEG / 2) ** 2 + Math.cos(a[0] * DEG) * Math.cos(b[0] * DEG) * Math.sin((b[1] - a[1]) * DEG / 2) ** 2
  return 12742 * Math.asin(Math.sqrt(x))
}

/**
 * 近い順の並びのうち、初めに作る点数。たどる間に値の届く点が `HOLD_PARTNER_NEAREST` 個そろわなかった（欠測が多い）ときだけ、
 * 全点の並びを作り直す。初めから全点を並べると、離れた点が一斉に震度1 相当になった秒に数百点ぶんの並べ替えが重なり、
 * 1 秒の処理が 70 ms を超えた（2026-11-09 13:52 の再生。設計書§83）
 */
const NEAREST_PREFIX = 16

/**
 * 震度1 以上の点の組が `HOLD_PARTNER_KM`・`HOLD_PARTNER_NEAREST` の意味で互いに相手かを見る。
 * 点ごとの近い順の並びは、距離で相手と決まらなかった組に初めて入ったときに作って持つ。
 * `sites` は検知の組み立てを作り直すまで変わらない前提（観測点の並びが変わるときは呼び出し元が作り直す）
 */
function createPartnerTest(sites: [number, number][]) {
  /** 点ごとの近い順の並び（自分を除く）と、それが全点を並べたものか */
  const order: ({ idx: Int32Array; full: boolean } | undefined)[] = []
  const build = (i: number, limit: number): { idx: Int32Array; full: boolean } => {
    const n = Math.min(limit, sites.length - 1)
    const idx = new Int32Array(n)
    const dist = new Float64Array(n).fill(Infinity)
    let filled = 0
    // 近い n 点を、距離の昇順に保った短い列へ差し込みながら選ぶ（同じ距離なら番号の小さい点が先。全点を並べたときと同じ順）
    for (let k = 0; k < sites.length; k++) {
      if (k === i) continue
      const d = distanceKm(sites[i], sites[k])
      if (filled === n && d >= dist[n - 1]) continue
      let p = filled < n ? filled++ : n - 1
      while (p > 0 && dist[p - 1] > d) { dist[p] = dist[p - 1]; idx[p] = idx[p - 1]; p-- }
      dist[p] = d
      idx[p] = k
    }
    return { idx, full: n === sites.length - 1 }
  }
  /** i から近い順に値の届いている点を `HOLD_PARTNER_NEAREST` 個たどる間に j が入るか */
  const amongNearest = (i: number, j: number, values: ArrayLike<number>): boolean => {
    let o = order[i] ?? (order[i] = build(i, NEAREST_PREFIX))
    for (;;) {
      let seen = 0
      for (let x = 0; x < o.idx.length && seen < HOLD_PARTNER_NEAREST; x++) {
        const k = o.idx[x]
        if (values[k] < 0) continue
        if (k === j) return true
        seen++
      }
      if (seen >= HOLD_PARTNER_NEAREST || o.full) return false
      o = order[i] = build(i, sites.length - 1)
    }
  }
  return (i: number, j: number, values: ArrayLike<number>): boolean =>
    distanceKm(sites[i], sites[j]) <= HOLD_PARTNER_KM || amongNearest(i, j, values) || amongNearest(j, i, values)
}

/** 加わった点のうち震度1 以上の点に、互いに相手になる 2 点の組があるか */
function hasShakingPair(members: readonly number[], values: ArrayLike<number>, isPartner: (i: number, j: number, values: ArrayLike<number>) => boolean): boolean {
  const hot: number[] = []
  for (const i of members) if (values[i] >= ONE_INDEX) hot.push(i)
  for (let a = 0; a < hot.length; a++) {
    for (let b = a + 1; b < hot.length; b++) if (isPartner(hot[a], hot[b], values)) return true
  }
  return false
}

export function createEnsembleTracker(sites: [number, number][], reporter: EnsembleReporter) {
  const keys = computeSiteKeys(sites)
  const live = new Map<string, State>()
  const isPartner = createPartnerTest(sites)

  return {
    /** 平常のゆらぎの表を束ね役へ渡す。積み上げた検知はそのまま残す */
    setTables(tables: QuietTables): void {
      reporter.setTables(tables)
    },
    /** 1 秒ぶんを入れ、いま生きている検知を揺れ始めの早い順に返す */
    push(f: DetectorFrame): EnsembleDetection[] {
      if (f.values.length !== sites.length) throw new Error(`観測点の数（${sites.length}）と値の数（${f.values.length}）が食い違っています`)
      for (const r of reporter.push(f)) {
        let s = live.get(r.id)
        if (!s) {
          s = { id: r.id, confirmed: false, epicenter: [r.lat, r.lng], originTimeMs: r.startMs, members: [], memberSet: new Set(), lastUpMs: new Map(), firstConfirmedAtMs: null, confirmedSnapshot: null, sources: new Set(), lastReportMs: f.ms, shakingMs: f.ms }
          live.set(r.id, s)
        }
        s.lastReportMs = f.ms
        if (r.tier === 'confirmed' && !s.confirmed) {
          s.confirmed = true
          s.firstConfirmedAtMs = f.ms
        }
        for (const i of r.sites) if (!s.memberSet.has(i)) { s.memberSet.add(i); s.members.push(i); s.lastUpMs.set(i, f.ms) }
        for (const src of r.sources) s.sources.add(src)
      }
      for (const [id, s] of live) {
        if (hasShakingPair(s.members, f.values, isPartner)) s.shakingMs = f.ms
        if (f.ms - Math.max(s.lastReportMs, s.shakingMs) > ENSEMBLE_KEEP_MS) live.delete(id)
      }
      const out: EnsembleDetection[] = []
      for (const s of live.values()) {
        const drawn: number[] = []
        for (const i of s.members) {
          if (f.values[i] >= ZERO_INDEX) s.lastUpMs.set(i, f.ms)
          if (f.ms - (s.lastUpMs.get(i) ?? f.ms) <= DRAWN_FADE_MS) drawn.push(i)
        }
        const drawnMembers = drawn.length > 0 ? drawn : lastToFade(s.members, s.lastUpMs)
        const max = maxIntensityOf(s.members, f.values)
        // 確かな段になった秒の観測点をすべて足し終えてから控える（同じ秒の別の行が点を足すことがある）
        if (s.firstConfirmedAtMs === f.ms && s.confirmedSnapshot === null) s.confirmedSnapshot = { size: s.members.length, maxIntensity: max }
        out.push({
          id: s.id,
          confidence: s.confirmed ? 'confirmed' : 'likely',
          epicenter: s.epicenter,
          originTimeMs: s.originTimeMs,
          memberKeys: s.members.map(i => keys[i]),
          drawnKeys: drawnMembers.map(i => keys[i]),
          maxIntensity: max,
          firstConfirmedAtMs: s.firstConfirmedAtMs,
          confirmedSnapshot: s.confirmedSnapshot,
          sources: [...s.sources],
          lastReportMs: s.lastReportMs,
        })
      }
      return out.sort((a, b) => a.originTimeMs - b.originTimeMs)
    },
  }
}
