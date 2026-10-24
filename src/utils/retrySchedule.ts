// 取れなかった取得を、間隔を広げつつ回数に上限を置いて取り直す規則。
//
// **5 か所で同じ値を使う**（2026-10-24 ユーザー選択「30秒から倍々・5回 (Recommended)」）——
// 自作地震計の下端の波形の穴埋め（`services/seismoWaveRefill.ts`）・自作地震計の地震カード
// （`hooks/useSeismoQuakeWaves.ts`）・自作地震計の再生中の読み返し（`hooks/useSeismoReplay.ts`）・
// リプレイの先読み（`hooks/useReplayController.ts`）・公開観測点の地震カード（`hooks/usePublicQuakeWaves.ts`）。
// 別々に書くと、同じ「取れなかった」に諦めるまでの時間が場所ごとに違ってくる。
//
// **リプレイの強震モニタの全滅した区間（`services/kyoshinSource.ts`）だけは別の規則**で、1 秒ずつ先読みと同じ回数で取る
// （検知は巻き戻せず、待てるのは 90 フレームまでなので、30 秒から倍々では間に合わない。2026-10-24 選択「今の取得の規則で取る (Recommended)」）。
//
// 間隔は 30 秒 → 1 分 → 2 分 → 4 分 → 5 分（上限）。取り直しは 5 回までで、最初の取得から
// 約 12 分半で諦める。**諦めたことは呼び手が記録へ残す**（画面からは「取れなかった」と
// 「記録が無かった」の見分けが付かない）。

/** 1 回目の取り直しまでの間隔（ms）。 */
export const RETRY_FIRST_DELAY_MS = 30_000

/** 間隔の上限（ms）。 */
export const RETRY_MAX_DELAY_MS = 5 * 60_000

/** 取り直す回数の上限（**最初の取得を含まない**）。 */
export const RETRY_MAX_RETRIES = 5

/**
 * 失敗を `failures` 回重ねたあと、次に取り直すまでの間隔（ms）。**諦める番なら `null`。**
 *
 * @param failures 続けて失敗した回数（最初の取得の失敗を 1 と数える）
 */
export function retryDelayAfter(failures: number): number | null {
  if (!Number.isInteger(failures) || failures < 1) return null
  if (failures > RETRY_MAX_RETRIES) return null
  return Math.min(RETRY_FIRST_DELAY_MS * 2 ** (failures - 1), RETRY_MAX_DELAY_MS)
}
