// 長期震源カタログの生成（build-hypocenter-catalog.ts）が使う判定のうち、境界を持つもの。
// 生成スクリプト本体は import すると main() の門を経由するので、テストしやすいよう純関数だけをここへ置く。
// 背景は docs/spec/data-sources-spec.md §6「長期震源カタログ」。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000

/**
 * 直近の年の ZIP を控えから読む期限。**これより古い控えは取り直す。**
 *
 * 確定値の ZIP が公開後に差し替わるかは確かめていない（差し替わらないとも言い切れない）。
 * 取り直しは直近 {@link ZIP_RECENT_YEARS} 年の数本だけなので、控えを信じ続けるより安い。
 * 6 日は週次更新（7 日ごと）が毎回取り直す長さ。CI は控えを残すため、期限が無いと
 * 一度取った年を二度と取りに行かない。
 */
export const ZIP_RECENT_MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000
/** 期限を当てる年数（日本時間の今年を含めて数える）。 */
export const ZIP_RECENT_YEARS = 3

/**
 * 控えの ZIP を取り直すべきか。
 *
 * @param file ZIP の名前から `h` と `.zip` を除いたもの（`2024`・まとめの `1919`・分割の `199701`）。
 *   年は先頭 4 桁で決める —— まとめ ZIP は最も古い年の名前なので、期限は掛からない
 */
export function isZipCacheStale(file: string, mtimeMs: number, nowMs: number): boolean {
  const year = Number(file.slice(0, 4))
  const thisYear = new Date(nowMs + JST_OFFSET_MS).getUTCFullYear()
  if (year <= thisYear - ZIP_RECENT_YEARS) return false
  return nowMs - mtimeMs > ZIP_RECENT_MAX_AGE_MS
}

/**
 * 年ファイルの M の列（`mag`）が、件数と長さが合い、`null` と有限数だけでできているか。
 *
 * 合わない年を索引へ載せると、M 未決定の件数が実態とずれたまま公開される（読み取り側は
 * 年を開いた時点で失敗するが、索引だけでは気づけない）。
 */
export function isYearMagColumnValid(mag: unknown, count: number): boolean {
  return (
    Array.isArray(mag) &&
    mag.length === count &&
    mag.every((m) => m === null || (typeof m === 'number' && Number.isFinite(m)))
  )
}
