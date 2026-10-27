/**
 * 変更内容の窓がいくつ開いているか。開いている間は読み直しの秒読みを止める（`utils/appUpdateGate.ts` の `reading`）。
 *
 * **窓の側で数える。** 開く場所（更新の札・設定の窓の「変更履歴」）ごとに伝えさせると、伝え忘れた場所から開いた
 * 窓の下で秒読みが進み、読んでいる途中で画面が消える。
 */
let openCount = 0
const listeners = new Set<() => void>()

/** 窓を開いたときに呼ぶ。返した関数を閉じたときに呼ぶ（2 回呼んでも 1 回しか数えない）。 */
export function markReleaseNotesOpen(): () => void {
  openCount += 1
  notify()
  let closed = false
  return () => {
    if (closed) return
    closed = true
    openCount -= 1
    notify()
  }
}

export function isReleaseNotesOpen(): boolean {
  return openCount > 0
}

export function subscribeReleaseNotesOpen(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function notify(): void {
  for (const l of listeners) l()
}
