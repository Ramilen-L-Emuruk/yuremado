import type { JMAQuake } from '../types/earthquake'
import type { AreaPrefIndex } from './quakePoints'
import { createQuakeFoldKeys } from './quakeMerge'
import { log } from './logger'

/** 地震カードの履歴で、どの地震を選ぶか。 */
export interface QuakeHistorySelection {
  /**
   * 選ぶ地震の上限。`null` なら件数では切らない。
   *
   * **数えるのは地震で、電文ではない。** 電文で数えると、地震の多い期間ほど 1 地震あたりの報が
   * 枠を食い、同じ設定でも一覧の枚数が期間ごとに変わる（ローカル履歴アーカイブの熊本の本震直前は、
   * 電文 50 通で切ると 52 地震のうち 18 枚しか残らなかった）。
   */
  maxEvents: number | null
  /**
   * 窓の下端（ミリ秒）。この時刻以降に 1 通でも報を持つ地震だけを選ぶ。`null` なら下端なし。
   *
   * **下端より前の報も、選んだ地震のものなら返す**（窓を地震で閉じる。→ 下の本文）。
   */
  windowStartMs: number | null
}

/**
 * 地震カードの履歴に載せる電文を選ぶ。**地震に畳んで選び、選んだ地震の電文は全部返す。**
 *
 * 履歴の取得元（標準版の P2PQuake・ローカル履歴アーカイブ）はどれも電文の並びを返すが、
 * 一覧に並ぶのは地震のカード。電文の単位で切ると次の 2 つが起きるので、ここで地震の単位に揃える。
 *
 * - **一覧の枚数が電文の数で決まる**（→ {@link QuakeHistorySelection.maxEvents}）
 * - **途中で切れたカードができる。** 選んだ地震の古い報が、別の地震の新しい報の後ろに並ぶことは
 *   普通にある（報は数分〜数時間にわたって出る）。件数に達した時点で並びを抜けると、その古い報が
 *   落ち、一覧の最も古いカードだけが震度速報のまま残るような形になる
 *
 * **同じ地震かどうかはライブ経路と同じ判定で決める**（`createQuakeFoldKeys`）。別の物差しで
 * 数えると、統合した後の枚数と合わない。判定はカードを育てながら行うので、**発表の順に見る**
 * （入力の並びには頼らず、ここで並べ直す）。
 *
 * **判定が投げた電文は、その 1 通だけで 1 地震として扱う。** 畳めないだけで内容は失われない
 * （初期状態の `foldPreWindowQuakes` と同じ扱い）。
 *
 * @param items 候補の電文（並びは問わない）。窓の上端（`before`）より後のものは呼び出し側で除く
 * @param quakeOf 候補から地震情報を取り出す
 * @param timeOf 候補の時刻（ミリ秒）。並べ替え・窓の判定・新しさの比較に使う。
 *   **有限の値であること**（読めない時刻の電文は呼び出し側で除く。`NaN` が混ざると並べ替えが壊れる）
 * @returns 選んだ地震の電文。**入力の並びのまま**
 */
export function selectQuakeHistory<T>(
  items: readonly T[],
  quakeOf: (item: T) => JMAQuake,
  timeOf: (item: T) => number,
  selection: QuakeHistorySelection,
  areaPrefIndex: AreaPrefIndex,
): T[] {
  const foldKeyOf = createQuakeFoldKeys(areaPrefIndex)
  const order = items.map((_, i) => i).sort((a, b) => timeOf(items[a]) - timeOf(items[b]))
  const keyOfIndex = new Array<string>(items.length)
  /** 地震ごとの最新の報の時刻と、最初に現れた順（同じ時刻の地震どうしの並びを決める）。 */
  const groups = new Map<string, { latestMs: number; firstSeen: number }>()
  for (const i of order) {
    let key: string
    try {
      key = foldKeyOf(quakeOf(items[i])).key
    } catch (e) {
      log.warn(`[replay] 履歴の地震を畳めなかったため、その報だけで 1 件として扱います: id=${quakeOf(items[i]).id}`, e)
      key = `unfolded:${i}`
    }
    keyOfIndex[i] = key
    const t = timeOf(items[i])
    const group = groups.get(key)
    if (!group) groups.set(key, { latestMs: t, firstSeen: groups.size })
    else if (t > group.latestMs) group.latestMs = t
  }

  const candidates = [...groups.entries()]
    .filter(([, g]) => selection.windowStartMs === null || g.latestMs >= selection.windowStartMs)
    .sort(([, a], [, b]) => b.latestMs - a.latestMs || a.firstSeen - b.firstSeen)
  const chosen = new Set(
    (selection.maxEvents === null ? candidates : candidates.slice(0, selection.maxEvents)).map(([key]) => key),
  )
  return items.filter((_, i) => chosen.has(keyOfIndex[i]))
}
