/**
 * 組み合わせの揺れ検知器（`kyoshinEnsembleDetector.ts`）の報告を、1 つの揺れにつき 1 件の検知へまとめる。
 *
 * 束ね役は秒ごとに「その秒に出ている束」を段階ごとに 1 行ずつ返すだけで、束が前の秒に何だったかは持たない。
 * 画面・音・診断が要るのは「その揺れがいまどの段か・どの観測点が加わったか・いつ確かな段になったか」なので、
 * ここで束の id ごとに積み上げる。
 *
 * - 段階は戻さない。一度確かな段の行が出た束は、その後に早い段の行しか出なくても確かな段のまま
 * - 加わった観測点は、束が生きている間に報告された点をすべて合わせる（減らさない）
 * - 地図に描く点（とカメラの寄せ先）は別に持つ。加わった点のうち、震度0 未満が `DRAWN_FADE_MS` 続いた点を外し、
 *   残りのうち相手の鎖で `DRAWN_GROUP_MIN` 点以上つながらず、`DRAWN_KEEP_INDEX` 以上の点も含まない塊の点も外す（`drawnKeys`）
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

/**
 * 地図に描く点を、相手（`HOLD_PARTNER_KM`・`HOLD_PARTNER_NEAREST`）の鎖でこの点数以上つながる塊に限る。
 * 加わった点は減らないので、弱い揺れが全国へ届くと、遠くでぽつんと加わった 1〜2 点にも揺れの最中ずっと印が付いていた
 * （2026-11-09 13:52 茨城県沖）。塊ごとに見るので、前の検知に呑まれた別の地震の点（3 点以上で揃う）は印が残る。
 * どの塊もこの点数に届かないときは、いちばん大きい塊（同じ大きさなら先に加わった点を含む塊）を残す（描く点を空にしない）。
 * 震度0 未満の点も外さない（2026-11-10 ユーザー発言「大前提震度0以下はP波の表示に必要です」）。
 * 2026-11-10 ユーザー選択「案D で入れる (Recommended)」（前の検知に呑まれた有感 26 件・11-09 の値は設計書§84）
 */
export const DRAWN_GROUP_MIN = 3

/**
 * この震度インデックス（計測震度 1.5・震度2 相当）以上の点を含む塊は、`DRAWN_GROUP_MIN` 点に届かなくても描く。
 * 周りの点が描く点に入っていない強い 1〜2 点（能登の週で震央近くの震度4 相当の点）まで外れていたため。
 * 地元のゆらぎで外したい点（2026-11-09 の四国の点など）は震度1 相当（インデックス 7〜8）までだった。
 * 2026-11-10 ユーザー選択「震度2相当以上は残す (Recommended)」（測った値は設計書§84）
 */
export const DRAWN_KEEP_INDEX = 9

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
   * 震度0 未満が `DRAWN_FADE_MS` 続いた点と、相手の鎖で `DRAWN_GROUP_MIN` 点以上つながらず `DRAWN_KEEP_INDEX` 以上の点も含まない塊の点を外す。
   * `memberKeys` と違って減ることがあるが、空にはならない
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

/** 点ごとに持つ近い順の並びの点数。値の届く点が `HOLD_PARTNER_NEAREST` 個そろわない秒（欠測が多い）だけ、その秒の値で探し直す */
const NEAREST_PREFIX = 16

/** 近い点を探すために観測点を分ける、緯度・経度の升の大きさ（度） */
const GRID_DEG = 0.5

/** 観測点の並びごとに一度だけ作る、近い点の索引（升・近い順の並び・`HOLD_PARTNER_KM` 以内の点） */
interface SiteIndex {
  /** i の升からちょうど `ring` 重外の升にある点を `visit` へ渡す */
  eachInRing(i: number, ring: number, visit: (k: number) => void): void
  /** 升をいくつ外へ広げれば全点を見終えるか */
  lastRing: number
  /** 升を 1 重外へ広げるごとに、まだ見ていない点が少なくともこれだけ離れていると言える長さ（km） */
  ringKm: number
  /** 点ごとの近い順の並び（値を問わず、自分を除く）。`NEAREST_PREFIX` 点まで */
  prefix: Int32Array[]
  /** 点ごとの `HOLD_PARTNER_KM` 以内の点（自分を除く） */
  within: Int32Array[]
}

/**
 * 観測点の並び（配列そのもの）ごとの索引。検知の組み立ては、時間が飛んだときや表示の時間軸が変わったときにも作り直すが、
 * 観測点の並びが同じなら索引は同じなので作り直さない（1,725 点で 55〜71 ms かかる。設計書§84）
 */
const siteIndexCache = new WeakMap<object, SiteIndex>()

/** i から近い順に、`accept` を満たす点を `count` 個（同じ距離なら番号の小さい点が先）。`acceptTotal` は満たす点の総数（自分を除く）で、見つけ終えたらそこで止める */
function searchNearest(sites: [number, number][], idx: Pick<SiteIndex, 'eachInRing' | 'lastRing' | 'ringKm'>, i: number, count: number, accept: (k: number) => boolean, acceptTotal: number): Int32Array {
  const found: { k: number; d: number }[] = []
  const byDistance = (a: { k: number; d: number }, b: { k: number; d: number }) => a.d - b.d || a.k - b.k
  let seen = 0
  for (let ring = 0; ring <= idx.lastRing && seen < acceptTotal; ring++) {
    idx.eachInRing(i, ring, k => { if (accept(k)) { seen++; found.push({ k, d: distanceKm(sites[i], sites[k]) }) } })
    if (found.length < count) continue
    found.sort(byDistance)
    found.length = count
    // 升の外の点は少なくとも ring × ringKm 離れているので、最後の点がそれより近ければ確定する
    if (found[count - 1].d < ring * idx.ringKm) break
  }
  found.sort(byDistance)
  return Int32Array.from(found.slice(0, count), x => x.k)
}

function siteIndexOf(sites: [number, number][]): SiteIndex {
  const hit = siteIndexCache.get(sites)
  if (hit) return hit
  const cellKey = (r: number, c: number) => (r + 2048) * 4096 + (c + 2048)
  const rowOf = (lat: number) => Math.floor(lat / GRID_DEG)
  const colOf = (lng: number) => Math.floor(lng / GRID_DEG)
  const grid = new Map<number, number[]>()
  let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity, maxAbsLat = 0
  sites.forEach(([lat, lng], k) => {
    const r = rowOf(lat), c = colOf(lng)
    minR = Math.min(minR, r); maxR = Math.max(maxR, r); minC = Math.min(minC, c); maxC = Math.max(maxC, c)
    maxAbsLat = Math.max(maxAbsLat, Math.abs(lat))
    const key = cellKey(r, c)
    const cell = grid.get(key)
    if (cell) cell.push(k)
    else grid.set(key, [k])
  })
  // 升 1 重の幅のうち短いほう（緯度方向か、いちばん北（南）の観測点の緯度での経度方向）を少し割り引く。
  // 割り引くのは、升の端どうしでも升の幅より近くならないことを、球面の誤差込みで言えるようにするため
  const cellKm = Math.min(GRID_DEG * 111.19, GRID_DEG * 111.19 * Math.cos(Math.min(maxAbsLat + GRID_DEG, 89) * DEG))
  const idx: SiteIndex = {
    eachInRing(i, ring, visit) {
      const r0 = rowOf(sites[i][0]), c0 = colOf(sites[i][1])
      for (let dr = -ring; dr <= ring; dr++) {
        const edge = dr === -ring || dr === ring
        for (let dc = -ring; dc <= ring; dc += edge || ring === 0 ? 1 : 2 * ring) {
          const cell = grid.get(cellKey(r0 + dr, c0 + dc))
          if (cell) for (const k of cell) if (k !== i) visit(k)
        }
      }
    },
    lastRing: sites.length > 0 ? Math.max(maxR - minR, maxC - minC) + 1 : 0,
    ringKm: cellKm * 0.95,
    prefix: [],
    within: [],
  }
  const withinRings = Math.ceil(HOLD_PARTNER_KM / idx.ringKm)
  for (let i = 0; i < sites.length; i++) {
    idx.prefix[i] = searchNearest(sites, idx, i, NEAREST_PREFIX, () => true, sites.length - 1)
    const close: number[] = []
    for (let ring = 0; ring <= withinRings; ring++) {
      idx.eachInRing(i, ring, k => { if (distanceKm(sites[i], sites[k]) <= HOLD_PARTNER_KM) close.push(k) })
    }
    idx.within[i] = Int32Array.from(close)
  }
  siteIndexCache.set(sites, idx)
  return idx
}

/**
 * 2 点が `HOLD_PARTNER_KM`・`HOLD_PARTNER_NEAREST` の意味で互いに相手かを見る。近い点は観測点の升から外へ順に探す
 * （全点を見ると、描く点が一度に増えた秒に点の数の 2 乗の距離計算が重なり、1,725 点で 1 秒の処理が 130 ms を超えた。設計書§84）。
 * 升・近い順の並び・`HOLD_PARTNER_KM` 以内の点は観測点の並びごとに一度だけ作り（`siteIndexOf`）、値の届く近い点は秒ごとに
 * `beginFrame` で捨てる。`sites` は検知の組み立てを作り直すまで中身を書き換えない前提。テストから全点を総当たりする形と突き合わせるために出す
 */
export function createPartnerTest(sites: [number, number][]) {
  const idx = siteIndexOf(sites)
  /** この秒に求めた、点ごとの値の届く近い点（`stamp` が今の秒の番号と同じものだけ使う） */
  const nearest: Int32Array[] = []
  const stamp = new Int32Array(sites.length).fill(-1)
  let frameNo = 0
  /** この秒の値の届く点の数 */
  let validCount = 0
  /** i から近い順に、値の届いている点を `HOLD_PARTNER_NEAREST` 個（欠測の点は飛ばす。同じ距離なら番号の小さい点が先） */
  const nearestOf = (i: number, values: ArrayLike<number>): Int32Array => {
    if (frameNo === 0) throw new Error('相手の判定は beginFrame でその秒の値を渡してから使ってください')
    if (stamp[i] === frameNo) return nearest[i]
    const o = idx.prefix[i]
    const picked: number[] = []
    for (let x = 0; x < o.length && picked.length < HOLD_PARTNER_NEAREST; x++) if (values[o[x]] >= 0) picked.push(o[x])
    stamp[i] = frameNo
    if (picked.length < HOLD_PARTNER_NEAREST && o.length < sites.length - 1) {
      // 近い順の並びの中で 5 つそろわない（欠測が多い）秒だけ、その秒の値で升を広げて探す。値の届く点を数え終えたら止める
      const total = validCount - (values[i] >= 0 ? 1 : 0)
      return (nearest[i] = searchNearest(sites, idx, i, HOLD_PARTNER_NEAREST, k => values[k] >= 0, total))
    }
    return (nearest[i] = Int32Array.from(picked))
  }
  return {
    /** 新しい秒の値で見る前に呼ぶ（前の秒に求めた近い点を捨てる） */
    beginFrame(values: ArrayLike<number>): void {
      frameNo++
      validCount = 0
      for (let k = 0; k < values.length; k++) if (values[k] >= 0) validCount++
    },
    /** i と j が互いに相手か */
    isPartner: (i: number, j: number, values: ArrayLike<number>): boolean =>
      distanceKm(sites[i], sites[j]) <= HOLD_PARTNER_KM || nearestOf(i, values).includes(j) || nearestOf(j, values).includes(i),
    /**
     * i から相手と決まる点（`HOLD_PARTNER_KM` 以内の点と、i から近い順に値の届く `HOLD_PARTNER_NEAREST` 点）を `visit` へ渡す。
     * 「j から近い 5 点に i が入る」側の組は、j の側から辿ったときに渡るので、全員を辿れば相手の組をすべて渡る
     */
    eachPartnerFrom(i: number, values: ArrayLike<number>, visit: (k: number) => void): void {
      for (const k of idx.within[i]) visit(k)
      for (const k of nearestOf(i, values)) visit(k)
    },
  }
}

type PartnerTest = ReturnType<typeof createPartnerTest>

/**
 * 描く点を、相手の鎖で `DRAWN_GROUP_MIN` 点以上つながる塊と、`DRAWN_KEEP_INDEX` 以上の点を含む塊に限る。どれも無ければいちばん大きい塊
 * （同じ大きさなら `points` の先に出る点を含む塊）。返す点は `points` の順のまま。
 * `slotOf` は観測点ごとの作業用の列（全部 -1 で渡し、全部 -1 に戻して返す）
 */
function keepLinkedGroups(points: readonly number[], values: ArrayLike<number>, partners: PartnerTest, slotOf: Int32Array): number[] {
  if (points.length < 2) return [...points]
  points.forEach((i, x) => { slotOf[i] = x })
  const parent = points.map((_, x) => x)
  const root = (x: number): number => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] }
    return x
  }
  points.forEach((i, x) => partners.eachPartnerFrom(i, values, k => {
    const y = slotOf[k]
    if (y < 0) return
    const a = root(x), b = root(y)
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b)
  }))
  for (const i of points) slotOf[i] = -1
  const size = new Int32Array(points.length)
  const strong = new Uint8Array(points.length)
  for (let x = 0; x < points.length; x++) {
    const r = root(x)
    size[r]++
    if (values[points[x]] >= DRAWN_KEEP_INDEX) strong[r] = 1
  }
  const kept = points.filter((_, x) => size[root(x)] >= DRAWN_GROUP_MIN || strong[root(x)] === 1)
  if (kept.length > 0) return kept
  let best = -1, bestSize = 0
  for (let x = 0; x < points.length; x++) {
    const r = root(x)
    if (size[r] > bestSize) { best = r; bestSize = size[r] }
  }
  return points.filter((_, x) => root(x) === best)
}

/** 加わった点のうち震度1 以上の点に、互いに相手になる 2 点の組があるか */
function hasShakingPair(members: readonly number[], values: ArrayLike<number>, isPartner: PartnerTest['isPartner']): boolean {
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
  const partners = createPartnerTest(sites)
  const slotOf = new Int32Array(sites.length).fill(-1)

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
      partners.beginFrame(f.values)
      for (const [id, s] of live) {
        if (hasShakingPair(s.members, f.values, partners.isPartner)) s.shakingMs = f.ms
        if (f.ms - Math.max(s.lastReportMs, s.shakingMs) > ENSEMBLE_KEEP_MS) live.delete(id)
      }
      const out: EnsembleDetection[] = []
      for (const s of live.values()) {
        const drawn: number[] = []
        for (const i of s.members) {
          if (f.values[i] >= ZERO_INDEX) s.lastUpMs.set(i, f.ms)
          if (f.ms - (s.lastUpMs.get(i) ?? f.ms) <= DRAWN_FADE_MS) drawn.push(i)
        }
        const drawnMembers = keepLinkedGroups(drawn.length > 0 ? drawn : lastToFade(s.members, s.lastUpMs), f.values, partners, slotOf)
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
