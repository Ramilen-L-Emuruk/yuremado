/**
 * 「予想が変わった」の帯を、報ごとに手元で初めて見た時刻（実時計）。鍵は地震・報番号・文言。
 * カードの作り直しで計時がやり直しにならないよう、コンポーネントの外に持つ。上限を超えたら古い順に捨てる。
 *
 * **リプレイの開始・停止で空にする**（`App` の `resetLocalState` → {@link resetEewForecastChangeSeen}）。
 * 残すと、同じ窓を再生し直したとき、前の再生で見た報の帯が一度も出ない。
 */
const firstSeen = new Map<string, number>()
const SEEN_MAX = 200

/** その報を手元で初めて見た時刻。初めて見た報なら `nowMs` を覚えて返す。 */
export function eewForecastChangeFirstSeenAt(key: string, nowMs: number): number {
  const known = firstSeen.get(key)
  if (known !== undefined) return known
  firstSeen.set(key, nowMs)
  if (firstSeen.size > SEEN_MAX) {
    const oldest = firstSeen.keys().next().value
    if (oldest !== undefined) firstSeen.delete(oldest)
  }
  return nowMs
}

/** 覚えた初見時刻をすべて捨てる。リプレイの開始・停止で呼ぶ。 */
export function resetEewForecastChangeSeen(): void {
  firstSeen.clear()
}
