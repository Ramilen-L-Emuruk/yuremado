/**
 * 帯に**種類ごとに複数を積む** 4 種（南海トラフ地震関連解説情報・北海道三陸沖後発地震注意情報・地震回数に関する情報・
 * 地震・津波に関するお知らせ）の一覧の扱い（2026-11-04 ユーザー選択「1 本に積む (Recommended)」。南海トラフ地震臨時情報は
 * 積まずに置き換える —— 同日選択「臨時情報は最新で置き換える (Recommended)」）。
 *
 * 一覧は**新しい順**（発表時刻の降順）に持つ。帯の見出しは先頭の 1 通、開くとこの順に並ぶ。
 * 帯へ当てるかの判定は `specialInfoBands.ts`、一覧を持つのは `useEarthquakes` で、ここは一覧の形だけを決める。
 */

/** 一覧に積む報が持つもの */
export interface BandListItem {
  id: string
  reportDateTime: string
  expireAt: string
}

function reportMs(item: BandListItem): number {
  const ms = new Date(item.reportDateTime).getTime()
  // 読めない発表時刻は末尾へ（並びのためだけに捨てない）
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY
}

/**
 * 一覧へ 1 通を入れる。**同じ件の報（`sameUnit` が真）は置き換え**、別件は足す。新しい順に並べ直して返す。
 * 発表時刻が同じものどうしは、後から入れたものを前に置く。
 *
 * **同じ件のより新しい報が既にあれば入れずに `null` を返す。** 履歴の取り込みとライブ・再接続の取り戻しが重なると、
 * 同じ件の古い報が後から届くことがある。置き換えると、地震回数の累積が古い値へ戻り、音と読み上げも鳴り直す
 */
export function putBandItem<T extends BandListItem>(list: readonly T[], item: T, sameUnit: (shown: T) => boolean): readonly T[] | null {
  if (list.some(shown => sameUnit(shown) && reportMs(shown) > reportMs(item))) return null
  const rest = list.filter(shown => !sameUnit(shown))
  const next = [item, ...rest]
  // 安定な並べ替えなので、同じ発表時刻どうしは「入れたばかりのものが前」のまま残る
  return next.sort((a, b) => reportMs(b) - reportMs(a))
}

/** 一覧の中でいちばん早い期限（ミリ秒）。読めない期限は数えない（一覧へは入らない —— 当てる前の判定が弾く） */
export function earliestExpiryMs(list: readonly BandListItem[]): number | null {
  let min: number | null = null
  for (const item of list) {
    const ms = new Date(item.expireAt).getTime()
    if (!Number.isFinite(ms)) continue
    if (min === null || ms < min) min = ms
  }
  return min
}

/**
 * 期限が `untilMs` 以前の報を外す（**1 件ずつ消える**。2026-11-04 ユーザー選択）。期限の予約が発火したときに、
 * 予約した時刻を渡す —— 発火した時点の時計で比べ直すと、時計の較正でずれたときに外し損ねて予約が回り続ける。
 */
export function dropExpiredUpTo<T extends BandListItem>(list: readonly T[], untilMs: number): readonly T[] {
  const kept = list.filter(item => {
    const ms = new Date(item.expireAt).getTime()
    return !(Number.isFinite(ms) && ms <= untilMs)
  })
  return kept.length === list.length ? list : kept
}
