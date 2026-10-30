// 国際津波関連情報（WEPA60）を持つ一覧と、遠地地震のカードへの結び付け。
// 型と電文の形は `types/earthquake.ts` の `JMAInternationalTsunami`。
import type { JMAInternationalTsunami, JMAQuake } from '../types/earthquake'

/**
 * 発生時刻の突き合わせで許すずれ。WEPA60 の `ORIGIN TIME` は分まで（秒を切り捨てた UTC）なので、
 * 遠地地震に関する情報の発生時刻（秒まで）より最大 59 秒早い。1 分の幅に、震源の決め直しで
 * 発生時刻が動く分の余裕を 1 分足す。
 */
export const ORIGIN_MATCH_TOLERANCE_MS = 120_000

/**
 * 一覧へ 1 通を足す。同じ `id`（発表時刻と題名が同じ）の報は 1 通にまとめる（ライブと取り戻しで
 * 同じ報を 2 度受けることがある）。並びは発表時刻の古い順。
 *
 * @returns 足したら新しい一覧、既にあれば null（画面を描き直さない）
 */
export function upsertInternationalTsunami(
  list: readonly JMAInternationalTsunami[], item: JMAInternationalTsunami,
): JMAInternationalTsunami[] | null {
  if (list.some(x => x.id === item.id)) return null
  return [...list, item].sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
}

/**
 * 地震カードに添える報。**遠地地震に関する情報のカードにだけ付ける**（国内の地震には WEPA60 は出ない）。
 * 通信試験の報と、発生時刻を読めなかった報はどのカードにも付かない。
 */
export function internationalTsunamisFor(
  quake: JMAQuake, list: readonly JMAInternationalTsunami[],
): readonly JMAInternationalTsunami[] {
  // 付かないカード（ほとんどすべて）には同じ空の配列を返す。毎回新しい配列を渡すとカードの `memo` が素通りする
  if (quake.issue.type !== '遠地地震' || list.length === 0) return NONE
  const quakeMs = Date.parse(quake.earthquake.time)
  if (!Number.isFinite(quakeMs)) return NONE
  const matched = list.filter(x => {
    if (x.isCommunicationsTest || x.originTime === undefined) return false
    const ms = Date.parse(x.originTime)
    return Number.isFinite(ms) && Math.abs(ms - quakeMs) <= ORIGIN_MATCH_TOLERANCE_MS
  })
  return matched.length === 0 ? NONE : matched
}

const NONE: readonly JMAInternationalTsunami[] = []

/**
 * どの地震カードにも付いていない報（通信試験を除く）。**画面にはどこにも出ていない**ので記録に残すために使う。
 * 発生時刻を読めなかった報は永久にどこにも付かない。読めた報も、遠地地震のカードがまだ届いていないだけのことがある。
 */
export function unattachedInternationalTsunamis(
  quakes: readonly JMAQuake[], list: readonly JMAInternationalTsunami[],
): JMAInternationalTsunami[] {
  if (list.length === 0) return []
  const attached = new Set<string>()
  for (const q of quakes) for (const x of internationalTsunamisFor(q, list)) attached.add(x.id)
  return list.filter(x => !x.isCommunicationsTest && !attached.has(x.id))
}
