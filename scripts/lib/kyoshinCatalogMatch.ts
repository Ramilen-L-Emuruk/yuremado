/**
 * 強震モニタの検知を、気象庁の震源（無感の地震も入る）と突き合わせる規則。
 *
 * 評価台（`scripts/bench-kyoshin.ts`）と、連続した日を流す評価（`scripts/eval-kyoshin-continuous.ts`）が
 * 同じ規則で数えるために、ここに 1 つだけ置く。
 *
 * 当てはまりの条件は 2 つ。
 * - 震央が検知の位置から M と深さに応じた距離（{@link catalogReachKm}）以内にある
 * - 検知が見え始めた時刻が、震源までの距離（深さ込み）で揺れが届く頃（{@link catalogWindowMs}）に入る
 *
 * 時刻はどれも実時刻（UTC のミリ秒）で渡す。
 */
import { haversineKm } from '../../src/utils/geo'

/** 揺れが届く前に見え始めてもよい幅（震源時刻・検知の位置の誤差のぶん） */
const LEAD_MS = 10_000
/** 近い地震の窓の終わり（発生から 120 秒）。遠い地震は S 波の到達＋{@link S_TAIL_MS} まで伸ばす */
const NEAR_TAIL_MS = 120_000
/** P 波の速さ（km/s）。遠い地震では、これより早く見え始めた検知はその地震のものとみなさない */
const P_KM_PER_S = 8
/** S 波（と、その後の表面波の頭）の遅めの速さ（km/s） */
const S_KM_PER_S = 3
/** S 波の到達から、検知が見え始めるまでの余裕 */
const S_TAIL_MS = 60_000
/** P 波の到達より手前に許す幅（検知の位置は束の中心で、最初に揺れた点ではないため） */
const P_SLACK_MS = 20_000

/**
 * 震央からの距離 `km` の検知が、発生から何ミリ秒後〜何ミリ秒後に見え始めたらその地震のものとみなすか。
 * 160 km までは「発生の 10 秒前〜120 秒後」で、遠くなるほど P 波・S 波の到達に合わせて後ろへずらす
 * （台湾の M7 の揺れは、九州・東北で 190〜320 秒後に見え始めた）。
 */
export function catalogWindowMs(km: number): [number, number] {
  const lo = -LEAD_MS + Math.max(0, (km / P_KM_PER_S) * 1000 - P_SLACK_MS)
  const hi = Math.max(NEAR_TAIL_MS, (km / S_KM_PER_S) * 1000 + S_TAIL_MS)
  return [lo, hi]
}

/** この深さ以上の地震は、震央の周りではなくスラブに沿った先（太平洋側）が強く揺れる（異常震域）。評価台の `DEEP_FOCUS_KM` と同じ値 */
export const CATALOG_DEEP_FOCUS_KM = 100
/** 深い地震を、規模によらず照合する震央からの距離（評価台の `relatedKmFor` の深発と同じ値） */
const DEEP_FOCUS_REACH_KM = 800

/**
 * 震央から何 km までの検知を、その地震のものとみなすか（M が決まっていない地震は M3 未満と同じ扱い）。
 * M3 未満の 150 km は、M2.7・M2.9 の地震から 107・131 km の束が S 波の到達どおりの時刻に見え始めた実例に合わせた。
 * M6 以上の 3,000 km は、台湾の M7 の揺れが東北まで届いて検知になった実例に合わせた。
 * 深さ {@link CATALOG_DEEP_FOCUS_KM} km 以上で M3 以上なら 800 km まで（三重県沖の深さ 363 km の M3.6 で、
 * 305・433 km 離れた関東・茨城に確かな段の束が出た実例がある）。M が決まっていない・M3 未満の深い地震は広げない
 * （M 不明の深さ 141 km の地震が 794 km 先の検知に当たった例があり、規模の分からない地震に遠くの揺れの説明は付けられない）。
 */
export function catalogReachKm(mag: number, depthKm: number): number {
  const byMag = !Number.isFinite(mag) || mag < 3 ? 150 : mag < 4 ? 200 : mag < 5 ? 400 : mag < 6 ? 1000 : 3000
  const deep = Number.isFinite(depthKm) && depthKm >= CATALOG_DEEP_FOCUS_KM && Number.isFinite(mag) && mag >= 3
  return deep ? Math.max(byMag, DEEP_FOCUS_REACH_KM) : byMag
}

/** 震源までの距離（深さが分からない地震は震央までの距離） */
function hypocentralKm(epicentralKm: number, depthKm: number): number {
  return Number.isFinite(depthKm) ? Math.hypot(epicentralKm, depthKm) : epicentralKm
}

export interface CatalogQuake {
  /** 発生時刻（UTC のミリ秒） */
  t: number
  lat: number
  lng: number
  /** 深さ（km）。決まっていない地震は NaN */
  depth: number
  /** M。決まっていない地震は NaN */
  mag: number
}

export interface CatalogMatch {
  quake: CatalogQuake
  km: number
}

/** 見え始めた時刻 `seenMs` と位置 `pos` の検知に当てはまる地震のうち、いちばん近いもの。無ければ null。 */
export function matchCatalog(seenMs: number, pos: readonly [number, number], quakes: readonly CatalogQuake[]): CatalogMatch | null {
  let best: CatalogMatch | null = null
  for (const q of quakes) {
    // 遠い地震でも窓の終わりは 3,000 km で 17 分ほど。それより外は距離を測るまでもなく外す
    const reach = catalogReachKm(q.mag, q.depth)
    if (q.t > seenMs + LEAD_MS || q.t < seenMs - catalogWindowMs(hypocentralKm(reach, q.depth))[1]) continue
    const km = haversineKm(pos[0], pos[1], q.lat, q.lng)
    if (km > reach) continue
    const [lo, hi] = catalogWindowMs(hypocentralKm(km, q.depth))
    if (seenMs < q.t + lo || seenMs > q.t + hi) continue
    if (!best || km < best.km) best = { quake: q, km }
  }
  return best
}

/**
 * 同じ位置の検知が、`fromMs` から `seconds` 秒の間のどの 1 秒に見え始めたとしても当てはまってしまう割合。
 *
 * 地震の多い日・多い場所では、本物でない検知でも規則に当てはまることがある。当てはまった件数から
 * この割合の合計（偶然でも当たる見込み）を引かないと、当てはまりの多さを本物の多さと読み違える。
 *
 * `watched` を渡すと、検知器が実際に見ていた秒（1 が立った秒）だけで割合を数える。流していない時間・助走の間は
 * 検知が出ようがないので、分母にも分子にも入れない。見ていた秒が 1 つも無ければ 0。
 */
export function chanceOfMatch(
  pos: readonly [number, number], quakes: readonly CatalogQuake[], fromMs: number, seconds: number, watched?: Uint8Array,
): number {
  if (seconds <= 0) return 0
  const covered = new Uint8Array(seconds)
  for (const q of quakes) {
    const km = haversineKm(pos[0], pos[1], q.lat, q.lng)
    if (km > catalogReachKm(q.mag, q.depth)) continue
    const [lo, hi] = catalogWindowMs(hypocentralKm(km, q.depth))
    const a = Math.max(0, Math.ceil((q.t + lo - fromMs) / 1000))
    const b = Math.min(seconds - 1, Math.floor((q.t + hi - fromMs) / 1000))
    for (let s = a; s <= b; s++) covered[s] = 1
  }
  let hit = 0
  let total = 0
  for (let s = 0; s < seconds; s++) {
    if (watched && !watched[s]) continue
    total++
    hit += covered[s]
  }
  return total === 0 ? 0 : hit / total
}

/** 取りこぼしを数える地震は、起きた後この秒数だけ見続けていたものに限る（近い地震の窓の終わりと同じ） */
export const MISS_WATCH_TAIL_SEC = NEAR_TAIL_MS / 1000

/**
 * 取りこぼしを数える地震を選ぶ。検知器が見ていた秒（`watched`。`fromMs` から 1 秒刻み）に起き、
 * その後 {@link MISS_WATCH_TAIL_SEC} 秒も見続けていた地震だけを残す。
 *
 * 流していない時間・助走の間・期間の終わりの直前に起きた地震は、検知が出ようがない（または出ても見ていない）ので、
 * 数えると「取りこぼし」が調査の穴の分だけ水増しされる。
 */
export function watchedQuakes(quakes: readonly CatalogQuake[], fromMs: number, watched: Uint8Array): CatalogQuake[] {
  const tail = MISS_WATCH_TAIL_SEC
  return quakes.filter((q) => {
    const s = Math.floor((q.t - fromMs) / 1000)
    if (s < 0 || s + tail >= watched.length) return false
    for (let k = s; k <= s + tail; k++) if (!watched[k]) return false
    return true
  })
}
