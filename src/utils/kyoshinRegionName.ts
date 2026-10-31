import type { SubRegion } from './subregions'
import { subRegionNameAt } from './subregions'

/** 区域名を決めるのに使う点（検知に入った観測点）。 */
export interface RegionPoint {
  readonly lat: number
  readonly lng: number
  /** 強震モニタの段（計測震度 = −3.0 + 0.5×段）。負の値は欠測 */
  readonly index: number
}

/**
 * 検知に入った点から、揺れている区域の名前を 1 つ決める。検知カードの区域名と、揺れ検知の
 * 読み上げ（「〇〇で揺れを検知。」）が同じ値を使う。
 *
 * **区域ごとに「点の数×強さ」を足し、いちばん大きい区域を選ぶ**（2026-10-31 ユーザー選択
 * 「点数×強さ (Recommended)」、カードも「揃える (Recommended)」）。強さは計測震度 +3.5
 * （`0.5×段 + 0.5`。段 0＝計測震度 −3.0 でも 0 にしない）。最も強い 1 点で選ぶと、境界で同じ強さの点が
 * 並んだとき並び順で片方に決まり、1 段の差で隣の区域へ跳ぶ。評価台の 692 窓で、確かな段に上がった瞬間の
 * 区域が震央の区域と一致したのは、この決め方で 606（87.6%）、最も強い 1 点で 569（82.2%）だった。
 *
 * - 欠測（負の段）の点は数えない。区域に寄せられない点（海の上で 5 km より遠い）も数えない
 * - 合計が同じなら、点の並びで先に現れた区域（検知器が点を束ねた順＝先に揺れ始めた側）
 * - 区域データが無い・数えられる点が無いときは null（呼び出し側は名前を出さない）
 */
export function dominantRegionName(
  points: Iterable<RegionPoint>,
  subregions: readonly SubRegion[] | null,
): string | null {
  if (!subregions) return null
  const sums = new Map<string, number>()
  for (const p of points) {
    if (!(p.index >= 0)) continue
    const name = subRegionNameAt(p.lat, p.lng, subregions)
    if (!name) continue
    sums.set(name, (sums.get(name) ?? 0) + p.index * 0.5 + 0.5)
  }
  let best: string | null = null
  let bestSum = -Infinity
  // Map は入れた順に回るので、同点なら先に現れた区域が残る（`>` で比べる）
  for (const [name, sum] of sums) {
    if (sum > bestSum) { best = name; bestSum = sum }
  }
  return best
}

/**
 * 揺れ検知の読み上げ文（2026-10-31 ユーザー選択「地名だけ・1回 (Recommended)」）。
 * 区域が決まらないときは地名を言わない。
 */
export function kyoshinDetectSpeechText(regionName: string | null): string {
  return regionName ? `${regionName}で揺れを検知。` : '揺れを検知。'
}
