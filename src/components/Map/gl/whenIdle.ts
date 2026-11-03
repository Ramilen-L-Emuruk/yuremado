/**
 * 手の空いた時間に `work` を走らせる（ブラウザの `requestIdleCallback`。無ければ次のフレームの後の `setTimeout`）。
 * 返り値は予約の取り消し。
 *
 * 地図の出ていない層へデータを流し込むのに使う。利用者の操作と同じフレームで流すと、地図が切り分け直す分だけ
 * そのフレームが伸びる。**遅くとも `timeoutMs` で走らせる** —— 地図が描き続けて手が空かなくても、層を出す前には
 * 中身を入れておきたい。
 */
export function whenIdle(work: () => void, timeoutMs = 1000): () => void {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(() => work(), { timeout: timeoutMs })
    return () => cancelIdleCallback(id)
  }
  const id = setTimeout(work, 50)
  return () => clearTimeout(id)
}
