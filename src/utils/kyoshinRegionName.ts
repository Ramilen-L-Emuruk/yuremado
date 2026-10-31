import type { SubRegion } from './subregions'
import { nearestSubRegionName, subRegionNameAt } from './subregions'

/** 区域名を決めるのに使う点（検知に入った観測点）。 */
export interface RegionPoint {
  readonly lat: number
  readonly lng: number
  /** 強震モニタの段（計測震度 = −3.0 + 0.5×段）。負の値は欠測 */
  readonly index: number
}

/**
 * K-NET の相模湾の海底観測点 KNG201〜206 の座標（強震モニタの観測点一覧の値。0.1 度刻み）。
 *
 * 海底にあるので、陸の一次細分区域の境界から外れる（最寄りの区域まで 5km を超える）。陸の地名で呼ぶと
 * 海底の揺れを陸で揺れたように伝えるので、「相模湾」と呼ぶ（2026-10-31 ユーザー選択「海底は「相模湾」・島は最寄り (Recommended)」）。
 * 座標は 2019〜2026 年の観測点一覧 4 版で同じ（各 1 点）。
 */
const SAGAMI_BAY_SEAFLOOR = new Set(['34.6,139.9', '34.7,139.8', '34.8,139.6', '34.9,139.6', '34.9,139.4', '35.1,139.4'])

/**
 * 相模湾の海底観測点の座標か。0.1 度の格子へ揃えてから照らすが、揃える前との差が浮動小数の誤差（1e-6 度）を
 * 超える座標は格子の点とみなさない —— 34.599999… のような表し方の揺れは拾い、0.04 度ずれた陸の点は拾わない。
 */
function isSagamiBaySeafloor(lat: number, lng: number): boolean {
  const gLat = Math.round(lat * 10) / 10
  const gLng = Math.round(lng * 10) / 10
  if (Math.abs(lat - gLat) > 1e-6 || Math.abs(lng - gLng) > 1e-6) return false
  return SAGAMI_BAY_SEAFLOOR.has(`${gLat},${gLng}`)
}

/** 相模湾の海底観測点の呼び名。 */
export const SAGAMI_BAY_SEAFLOOR_NAME = '相模湾'

/**
 * 強震モニタの観測点 1 つの区域名。区域データがあれば必ず名前が付く。
 *
 * 1. 相模湾の海底観測点なら「相模湾」
 * 2. 区域の中か、境界から 5km 以内なら、その区域（`subRegionNameAt`）
 * 3. それ以外は距離を問わず最寄りの区域（`nearestSubRegionName`）。強震モニタの座標は 0.1 度刻みに丸めて
 *    配られるので、島の縁の観測点（種子島・久米島）が海へ出る（同日の選択「島は最寄り」）
 */
export function kyoshinPointRegionName(lat: number, lng: number, subregions: readonly SubRegion[]): string | null {
  if (isSagamiBaySeafloor(lat, lng)) return SAGAMI_BAY_SEAFLOOR_NAME
  return subRegionNameAt(lat, lng, subregions) ?? nearestSubRegionName(lat, lng, subregions)
}

/**
 * 検知に入った点から、揺れている区域の名前を 1 つ決める。検知カードの区域名と、揺れ検知の
 * 読み上げ（「〇〇で揺れを検知。」「〇〇でも揺れを検知。」）が同じ値を使う。
 *
 * **区域ごとに「点の数×強さ」を足し、いちばん大きい区域を選ぶ**（2026-10-31 ユーザー選択
 * 「点数×強さ (Recommended)」、カードも「揃える (Recommended)」）。強さは計測震度 +3.5
 * （`0.5×段 + 0.5`。段 0＝計測震度 −3.0 でも 0 にしない）。最も強い 1 点で選ぶと、境界で同じ強さの点が
 * 並んだとき並び順で片方に決まり、1 段の差で隣の区域へ跳ぶ。評価台の 692 窓で、確かな段に上がった瞬間の
 * 区域が震央の区域と一致したのは、この決め方で 606（87.6%）、最も強い 1 点で 569（82.2%）だった。
 *
 * - 欠測（負の段）の点は強さに数えない。**全部の点が欠測なら、点の数だけで決める**（値が無くても場所は
 *   分かっている。2026-10-31 ユーザー選択「埋める・取れない時は「別の地点でも」 (Recommended)」）
 * - 区域は `kyoshinPointRegionName` で引く（区域データがあれば必ず名前が付く）
 * - 合計が同じなら、点の並びで先に現れた区域（検知器が点を束ねた順＝先に揺れ始めた側）
 * - 区域データが無い・点が 1 つも無いときは null（呼び出し側は名前を出さない）
 */
export function dominantRegionName(
  points: Iterable<RegionPoint>,
  subregions: readonly SubRegion[] | null,
): string | null {
  if (!subregions) return null
  const list = [...points]
  let sums = tally(list, subregions, (p) => (p.index >= 0 ? p.index * 0.5 + 0.5 : null))
  if (sums.size === 0) sums = tally(list, subregions, () => 1)
  let best: string | null = null
  let bestSum = -Infinity
  // Map は入れた順に回るので、同点なら先に現れた区域が残る（`>` で比べる）
  for (const [name, sum] of sums) {
    if (sum > bestSum) { best = name; bestSum = sum }
  }
  return best
}

/** 区域ごとに重みを足す。重みが null の点は数えない。 */
function tally(
  points: readonly RegionPoint[],
  subregions: readonly SubRegion[],
  weightOf: (p: RegionPoint) => number | null,
): Map<string, number> {
  const sums = new Map<string, number>()
  for (const p of points) {
    const w = weightOf(p)
    if (w === null) continue
    const name = kyoshinPointRegionName(p.lat, p.lng, subregions)
    if (!name) continue
    sums.set(name, (sums.get(name) ?? 0) + w)
  }
  return sums
}

/**
 * 揺れ検知の読み上げ文（2026-10-31 ユーザー選択「地名だけ・1回 (Recommended)」）。
 * 区域が決まらない（境界データを取れなかった）ときは地名を言わない。
 */
export function kyoshinDetectSpeechText(regionName: string | null): string {
  return regionName ? `${regionName}で揺れを検知。` : '揺れを検知。'
}

/**
 * 「別の地点で揺れを検知」の読み上げ文（2026-10-31 ユーザー選択「境を直してから読む (Recommended)」、
 * 選択肢の説明「別地点でも「茨城県南部でも揺れを検知。」と 1 回読む」）。区域が決まらない（境界データを
 * 取れなかった）ときは「別の地点でも揺れを検知。」（同日「埋める・取れない時は「別の地点でも」 (Recommended)」）。
 */
export function kyoshinOtherRegionSpeechText(regionName: string | null): string {
  return regionName ? `${regionName}でも揺れを検知。` : '別の地点でも揺れを検知。'
}
