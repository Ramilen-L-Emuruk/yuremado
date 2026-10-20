/**
 * DMDATA の地震情報の電文を一意に指す鍵。→ `JMAQuake.telegramKey`
 *
 * **`Control/Title`（電文の種別名）と `Control/DateTime`（電文を作成した時刻・秒精度）の組。**
 * 作成時刻だけでは、同じ地震で同じ秒に作られた別種別の電文が重なり、統合の控え（`sourceTelegrams`）から
 * 2 通目が落ちる。実測と壊れ方は docs/spec/quake-spec.md §8「同じ電文を二度数えない」。
 *
 * パーサーとテストボタンのデータの両方がこれを通す（形が食い違うと、テストボタンだけが
 * 実電文と違う鍵で数えられる）。
 */
export function dmdataTelegramKey(controlTitle: string, controlDateTime: string): string {
  return `${controlTitle}|${controlDateTime}`
}
