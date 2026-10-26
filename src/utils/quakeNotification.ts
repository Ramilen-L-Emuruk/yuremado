// 地震情報のブラウザ通知（OS 通知）の中身と、出すかどうかを決める。**通知を出すのは App の担当**で、
// ここは純粋な判定だけ（単体テストの対象）。背景は docs/spec/settings-pwa-spec.md §2「ブラウザ通知」。
//
// **カードが採った続報はすべて通知する**（2026-10-26 ユーザー選択「カードが採った続報すべて (Recommended)」。
// 原文「どの情報でも続報が来たなら通知はしてほしいです。アプリに表示している以上。」）。本文は報の段階で変わる。
// - 震源がまだ判らない報は「震度速報 {区域} 最大震度{震度}」
// - 震源が判った報は「{震源名} 最大震度{震度} {規模}」
//   （ここまで 2026-10-19 ユーザー承認「速報の文＋震源で置き換え (推奨)」）
// - 震源が判った報で、最大震度の階級が前に通知したときより上がっていれば、頭に「最大震度更新」を付ける
//   （2026-10-22 選択「頭に「最大震度更新」 (Recommended)」）
// - 遠地地震は設定の震度に関係なく「遠地地震 {震源名} {規模}」（2026-10-22 選択「全部出す (Recommended)」。震源名は詳細震央地名）
// 最低震度に届かない報・据え置いた報（カードが採らない）・取消では出さない。同じ報が 2 度届いても 1 度だけ。
// 通知の tag を地震ごと（`quakeEventKey`）にするので、2 回目以降は OS 上で前の通知を置き換える。
// 置き換えでも知らせ直す（`renotify`）のは呼び出し側（App の `showQuakeNotification`）。
import type { AreaPrefIndex } from './quakePoints'
import { isAreaPoint, isMaxScaleUnreceived } from './quakePoints'
import type { JMAQuake } from '../types/earthquake'
import { getIntensityLabelWithOrAbove } from './intensity'
import { formatMagnitudeWithCondition } from './formatters'
import { isHypocenterPending, quakeEventKey, sameQuakeEntry } from './quakeMerge'
import { log } from './logger'

/**
 * 通知の重複判定に使う、報の鍵。電文の鍵（`telegramKey`）が無い報は **id・発表時刻・種別の組**で作る
 * （統合側の `isSameTelegram` と同じ見分け方）。`id` だけで代用すると、DMDATA の震度速報・震源情報は
 * `Head/Serial` が空で同じ地震の全報が同じ `id` になるため、2 通目以降を重複として黙らせてしまう。
 */
export function notifiedReportKey(q: JMAQuake): string {
  return q.telegramKey ?? `${q.id}|${q.time ?? ''}|${q.issue.type}`
}

/** 通知した地震と、最後に通知したときの震源・最大震度、通知した報。 */
export interface QuakeNotifiedState {
  readonly key: string
  /** 最後に通知したとき震源が判っていたか。遠地地震は真。 */
  readonly withHypocenter: boolean
  /**
   * 最後に通知したときの最大震度。震源が判った報どうしで上がったら、本文の頭に「最大震度更新」を付ける
   * （→ {@link decideQuakeNotification}）。
   */
  readonly maxScale: number
  /**
   * 通知を出した報の鍵（`notifiedReportKey`）。同じ報が 2 度届いたときに出し直さないために持つ。
   * 新しい順に {@link QUAKE_NOTIFIED_REPORTS_MAX} 件まで。
   */
  readonly reportKeys: readonly string[]
}

/**
 * 1 つの地震で覚えておく、通知した報の数（覚え続けないための上限）。溢れて忘れた古い報がもう一度届くと
 * 出し直すが、重複は直後に届くものなので、新しい側を残せば足りる。
 */
export const QUAKE_NOTIFIED_REPORTS_MAX = 50

/**
 * 通知した地震を覚えておく数の上限。超えたら古いものから忘れる（忘れた地震に続報が届くと、
 * 「最大震度更新」の頭を付けずに出すだけ）。
 */
export const QUAKE_NOTIFIED_MEMORY_MAX = 200

/**
 * 通知した地震を**地震ごとに**覚える。1 件だけ覚える形だと、地震 A・B の報が交互に届いたとき
 * A を忘れて、A の報の重複を出し直し、最大震度が上がったかも分からなくなる（同じ分の別地震・群発で起きる）。
 * 挿入順を保つ Map なので、上限を超えたら先頭（最も古く覚えたもの）から落とす。
 */
export function rememberQuakeNotified(
  memory: Map<string, QuakeNotifiedState>,
  state: QuakeNotifiedState,
  max: number = QUAKE_NOTIFIED_MEMORY_MAX,
): void {
  memory.delete(state.key)
  memory.set(state.key, state)
  while (memory.size > max) {
    const oldest = memory.keys().next().value
    if (oldest === undefined) break
    memory.delete(oldest)
    log.debug(`[notify] 通知した地震の記憶が上限 ${max} 件を超えたので、最も古い地震を忘れる（${oldest}）`)
  }
}

/**
 * 地震 1 件ぶんの通知を、同じ地震の前の通知が済んでから判定して出す。**出せたときだけ覚える。**
 *
 * 通知は Service Worker の返事を待つので、出せたかがすぐには分からない。同じ地震の報が続けて届いたとき、
 * 前の結果を待たずに判定すると、前の通知が出せたかを知らないまま `previous` を読むことになる
 * （先に覚えて失敗で戻す形にすると、2 通続けて出せなかったとき、出ていない通知が通知済みとして残る）。
 * そこで地震ごとに 1 本の列へ並べ、前が済んでから `memory` を読んで判定する。別の地震は待たない。
 * 同じ tag の通知が出す順に並ぶ（震度速報の通知が震源の報の通知を後から上書きしない）ことも、この列が保つ。
 *
 * `chains` と `memory` は呼び出した時点のものを使う（リセットで差し替えられた後に済んだ通知は、
 * 古いほうへ覚えるだけで新しい記憶を汚さない）。出せなければ reject する（記録は呼び出し側）。
 *
 * `reportKeys` はこの通知を起こした報の鍵（`notifiedReportKey`。{@link collectQuakesToNotify} が返す）。
 */
export function scheduleQuakeNotification(args: {
  chains: Map<string, Promise<void>>
  memory: Map<string, QuakeNotifiedState>
  quake: JMAQuake
  reportKeys: readonly string[]
  notifyMinScale: number
  areaPrefIndex: AreaPrefIndex
  show: (notification: QuakeNotification) => Promise<void>
}): Promise<void> {
  const { chains, memory, quake, reportKeys, notifyMinScale, areaPrefIndex, show } = args
  const key = quakeEventKey(quake)
  const before = chains.get(key) ?? Promise.resolve()
  const run = before.then(async () => {
    const decided = decideQuakeNotification(quake, reportKeys, memory.get(key) ?? null, notifyMinScale, areaPrefIndex)
    if (!decided) return
    await show(decided.notification)
    rememberQuakeNotified(memory, decided.next)
  })
  // 列の末尾は失敗しても次を止めない形で持つ。済んだら、後ろに誰も並んでいなければ列ごと消す
  const tail = run.catch(() => undefined)
  chains.set(key, tail)
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key) })
  return run
}

/** 出す通知。 */
export interface QuakeNotification {
  readonly title: string
  readonly body: string
  /**
   * OS 上で同じ地震の通知を置き換えるための印（地震ごとの鍵）。置き換えでも知らせ直すよう、
   * 出す側は `renotify` を付ける（付けないと、前の通知が残っている間は黙って差し替わる）。
   */
  readonly tag: string
}

/**
 * 最大震度の表記。**断定形で出さない**（→ docs/spec/quake-spec.md §4「震度5弱以上未入電」）。
 * OS 通知はカードを開かない利用者が最初に目にする経路なので、「以上」を落とすと
 * 「実際にはもっと強いかもしれない」が誰にも届かない。
 */
function maxScaleLabel(quake: JMAQuake): string {
  return getIntensityLabelWithOrAbove(
    quake.earthquake.maxScale,
    isMaxScaleUnreceived(quake.earthquake.maxScale, quake.points),
  )
}

/**
 * 最大震度を観測した区域の名前。複数なら先頭に「ほか」を付ける。無ければ `null`。
 *
 * 区域は電文の区域の行（`isAreaPoint`。都道府県のロールアップ点は除く）。並びは電文の順のまま
 * （気象庁の並び）で、その先頭を採る。
 */
export function maxScaleAreaLabel(quake: JMAQuake, areaPrefIndex: AreaPrefIndex): string | null {
  const names: string[] = []
  for (const p of quake.points) {
    if (p.scale !== quake.earthquake.maxScale) continue
    if (!isAreaPoint(p, areaPrefIndex)) continue
    if (!names.includes(p.addr)) names.push(p.addr)
  }
  if (names.length === 0) return null
  return names.length === 1 ? names[0] : `${names[0]}ほか`
}

/**
 * 震度速報（震源がまだ判らない報）の本文。例「震度速報 石川県能登ほか 最大震度5弱」。
 * 最大震度の区域が読めないときは区域を省く（「震度速報 最大震度5弱」）。
 */
export function scalePromptNotificationBody(quake: JMAQuake, areaPrefIndex: AreaPrefIndex): string {
  const area = maxScaleAreaLabel(quake, areaPrefIndex)
  return area === null
    ? `震度速報 最大震度${maxScaleLabel(quake)}`
    : `震度速報 ${area} 最大震度${maxScaleLabel(quake)}`
}

/** 震源が判った報の本文。例「石川県能登地方 最大震度5弱 M5.2」。 */
export function hypocenterNotificationBody(quake: JMAQuake): string {
  const { name, magnitude, magnitudeCondition, magnitudeType } = quake.earthquake.hypocenter
  return `${name} 最大震度${maxScaleLabel(quake)} ${formatMagnitudeWithCondition(magnitude, magnitudeCondition, magnitudeType)}`
}

/** 最大震度が上がった報の本文。例「最大震度更新 石川県能登地方 最大震度6強 M7.6」。 */
export function maxScaleRaisedNotificationBody(quake: JMAQuake): string {
  return `最大震度更新 ${hypocenterNotificationBody(quake)}`
}

/**
 * 遠地地震の本文。例「遠地地震 メキシコ、チアパス州沿岸 M7.4」。震源名は詳細震央地名
 * （パーサーが `Area/DetailedName` を優先して入れる）。名前が無ければ省く。
 */
export function foreignQuakeNotificationBody(quake: JMAQuake): string {
  const { name, magnitude, magnitudeCondition, magnitudeType } = quake.earthquake.hypocenter
  const mag = formatMagnitudeWithCondition(magnitude, magnitudeCondition, magnitudeType)
  return name ? `遠地地震 ${name} ${mag}` : `遠地地震 ${mag}`
}

/**
 * その地震について通知を出すかを決める。**カードが採った報は、まだ通知していない報なら毎回出す**
 * （2026-10-26 ユーザー選択「カードが採った続報すべて (Recommended)」）。
 *
 * - 渡された閾値が負なら出さない（通知しないとき `effectiveNotifyMinScale` が -1 を返す）
 * - 遠地地震（国内の震度を持たない）は閾値に関係なく出す
 * - それ以外は最大震度が閾値（`notifyMinScale`）以上のときだけ出す
 * - 同じ地震で、`reportKeys` がすべて通知済みの報なら出さない（同じ報が 2 度届いたとき）
 * - 本文は、震源がまだ判らなければ震度速報の文、判っていれば震源の文。震源が判った報どうしで最大震度が
 *   前に通知したときより上がっていれば、頭に「最大震度更新」を付ける
 * - 震源が判ったかは震源の欄が埋まったか（`isHypocenterPending`）で見る。本文が震源名を使うため
 *
 * @returns 出す通知と、次に覚えておく状態。出さなければ `null`（状態も変えない）
 */
export function decideQuakeNotification(
  quake: JMAQuake,
  reportKeys: readonly string[],
  previous: QuakeNotifiedState | null,
  notifyMinScale: number,
  areaPrefIndex: AreaPrefIndex,
): { notification: QuakeNotification; next: QuakeNotifiedState } | null {
  if (notifyMinScale < 0) return null
  const key = quakeEventKey(quake)
  const same = previous !== null && previous.key === key ? previous : null
  // 鍵が 1 つも無い呼び出しは重複と見なさない（空配列の every は真なので、黙って止まる）
  if (same && reportKeys.length > 0 && reportKeys.every(k => same.reportKeys.includes(k))) {
    log.debug(`[notify] 地震情報の同じ報が届き直したので、通知を出し直さない（${key}・${reportKeys.join(', ')}）`)
    return null
  }
  const maxScale = quake.earthquake.maxScale
  const foreign = quake.issue.type === '遠地地震'
  if (!foreign && maxScale < notifyMinScale) return null
  const withHypocenter = foreign || !isHypocenterPending(quake)
  const body = foreign ? foreignQuakeNotificationBody(quake)
    : !withHypocenter ? scalePromptNotificationBody(quake, areaPrefIndex)
    : same?.withHypocenter && maxScale > same.maxScale ? maxScaleRaisedNotificationBody(quake)
    : hypocenterNotificationBody(quake)
  // 新しい順に並べる（`reportKeys` は届いた順なので、新しい報が先頭へ来るよう裏返す）
  const notified = [...reportKeys.filter(k => !same?.reportKeys.includes(k)).reverse(), ...(same?.reportKeys ?? [])]
  if (notified.length > QUAKE_NOTIFIED_REPORTS_MAX) {
    log.debug(`[notify] 地震情報の通知した報の記憶が上限 ${QUAKE_NOTIFIED_REPORTS_MAX} 件を超えたので、古い ${notified.length - QUAKE_NOTIFIED_REPORTS_MAX} 件を忘れる（${key}）`)
  }
  return {
    notification: { title: '地震情報', body, tag: key },
    next: { key, withHypocenter, maxScale, reportKeys: notified.slice(0, QUAKE_NOTIFIED_REPORTS_MAX) },
  }
}

/** 通知を考える地震カードと、そのカードが採った報の鍵（`notifiedReportKey`）。 */
export interface QuakeToNotify {
  readonly card: JMAQuake
  readonly reportKeys: readonly string[]
}

/**
 * ライブで届いた報から、通知を考える地震カードを引く。受信側の統合と同じ当て方（`sameQuakeEntry`）で、
 * 取り消されたカードは外す。同じカードに当たった報は 1 つにまとめ、報の鍵を並べて持つ（同じティックに
 * 続報が並んだとき）。**鍵は届いた報から取る** —— カード自身の鍵は、統合の分岐によっては前の報のものが残る。
 *
 * @returns 引けたカードと、引けなかった報（状態が採らなかった・取り消された報。呼び出し側が記録する）
 */
export function collectQuakesToNotify(
  pending: readonly JMAQuake[],
  earthquakes: readonly JMAQuake[],
  areaPrefIndex: AreaPrefIndex,
): { cards: QuakeToNotify[]; unmatched: JMAQuake[] } {
  const keysByCard = new Map<JMAQuake, string[]>()
  const unmatched: JMAQuake[] = []
  for (const incoming of pending) {
    const card = earthquakes.find(c => !c.cancelledAt && sameQuakeEntry(c, incoming, areaPrefIndex))
    if (!card) { unmatched.push(incoming); continue }
    const keys = keysByCard.get(card) ?? []
    const reportKey = notifiedReportKey(incoming)
    if (!keys.includes(reportKey)) keys.push(reportKey)
    keysByCard.set(card, keys)
  }
  return { cards: [...keysByCard].map(([card, reportKeys]) => ({ card, reportKeys })), unmatched }
}
