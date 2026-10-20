/**
 * DMDATA 由来の電文 id を扱うユーティリティ。
 *
 * 電文 id はアプリが組み立てる文字列（`dmdata-<種別>-<eventId>-<serial>` の形）で、
 * 電文そのものには含まれない。**localStorage に残る値**でもあるため、書式を変えると
 * 更新前に保存された値と一致しなくなる。ここはその橋渡しを 1 箇所にまとめる場所。
 */

/**
 * 電文 id から、経路を XML へ一本化する前に挟まっていた `xml-` を落とす。
 *
 * かつては JSON 経路と XML 経路の出所を見分けるため `dmdata-xml-…` と付けていた。
 * JSON 経路を撤去して区別が要らなくなったので作る側は付けなくなったが、
 * **既読の記録のように永続化された値には旧書式が残る**。保存値と突き合わせる前に
 * 両辺をこれに通すと、更新をまたいだ利用者に「閉じたはずのものが出てくる」ことがない。
 */
export function normalizeDmdataTelegramId(id: string): string {
  return id.replace(/^dmdata-xml-/, 'dmdata-')
}

/**
 * 地震・津波に関するお知らせ（VZSE40）の id。`Head/EventID` と `Control/DateTime` の組。
 *
 * **`EventID` だけでは別のお知らせが同じ id になる。** お知らせの `EventID` は発表時刻を分で
 * 切ったもので、同じ分に別のお知らせが続けて出ることがある（自治体ごとの「震度データ入電停止」が
 * 数十秒おきに並ぶ等）。`Serial` は空で届く。`Control/DateTime`（電文の作成時刻・秒精度）なら
 * 別のお知らせどうしで重ならない。実測は docs/spec/data-sources-spec.md §2「扱う電文種別」。
 *
 * パーサーとテストボタンのデータの両方がこれを通す。
 */
export function quakeNoticeId(eventId: string, controlDateTime: string): string {
  return `dmdata-quake-notice-${eventId}-${controlDateTime}`
}

/** 旧い書式（`dmdata-quake-notice-<EventID>-<Serial>`）のお知らせの id から `EventID` を取り出す。 */
const LEGACY_QUAKE_NOTICE_ID = /^dmdata-quake-notice-(\d{14})-\d+$/

/**
 * 閉じた帯の記録（localStorage）が、そのお知らせを指しているか。
 *
 * **旧い書式の記録は `EventID` で突き合わせる。** id へ作成時刻を入れる前に閉じた記録は
 * `…-<EventID>-<Serial>`（`Serial` は数字。空なら 1）の形で残っていて、新しい id とは一致しない。
 * そのままではアプリを更新した直後に、閉じたはずの帯が出直す。旧い記録には作成時刻が無いので、
 * 同じ分の別のお知らせも閉じたものとして扱う。次に帯を閉じれば記録は新しい書式へ置き換わり、
 * 旧い記録が指すお知らせも発表から 7 日で帯から消えるので、効くのはその間だけ。
 */
export function isQuakeNoticeDismissed(dismissedId: string | null, notice: { id: string; eventId: string }): boolean {
  if (dismissedId == null) return false
  const stored = normalizeDmdataTelegramId(dismissedId)
  if (stored === normalizeDmdataTelegramId(notice.id)) return true
  const legacy = LEGACY_QUAKE_NOTICE_ID.exec(stored)
  return legacy != null && legacy[1] === notice.eventId
}
