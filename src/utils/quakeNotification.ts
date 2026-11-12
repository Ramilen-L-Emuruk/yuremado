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
// - 震度を観測しなかった国内の地震（最大震度を持たない報）も、遠地地震と同じく設定の震度に関係なく出す（2026-11-09 ユーザー選択
//   「閾値に関係なく出す」）。本文は「{震源名} {規模}（震度1以上の観測なし）」（2026-11-09 ユーザー選択「地名 M のあとに添える」）
// 最低震度に届かない報・据え置いた報（カードが採らない）では出さない。同じ報が 2 度届いても 1 度だけ。
// 取消は、その地震を通知していたときだけ、同じ tag で「〈通知した文〉は取り消されました」に置き換える
// （2026-11-09 ユーザー選択「同じ札で置き換え、何を取り消したか言う (Recommended)」。→ {@link decideQuakeCancelNotification}）
// 通知の tag を地震ごと（`quakeEventKey`）にするので、2 回目以降は OS 上で前の通知を置き換える。
// 置き換えでも知らせ直す（`renotify`）のは呼び出し側（App の `showQuakeNotification`）。
import type { AreaPrefIndex } from './quakePoints'
import { isAreaPoint, isMaxScaleUnreceived } from './quakePoints'
import type { JMAQuake } from '../types/earthquake'
import { intensityLabelWithOrAbove } from './intensity'
import { magnitudeWithConditionText } from './formatters'
import { isHypocenterPending, quakeEventKey, sameQuakeEntry } from './quakeMerge'
import { log } from './logger'
import type { NotificationOpen } from './notificationOpen'
import type { Messages } from '../i18n/messages'

/**
 * 通知の文を組む語（辞書の通知の節と書式の語）。アプリはいまの言語の辞書、中継は日本語の辞書（`JA_MESSAGES`）を渡す。
 * 通知の記憶（`QuakeNotifiedState.bodies`）に入る本文は、出したときの言語の文のまま。
 */
export type QuakeNotificationWords = Pick<Messages, 'alertText' | 'formats'>

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
  /**
   * 情報名（`issue.type`。震度速報・震源・震度に関する情報 等）ごとに、最後に通知した本文。取消の通知が「何を取り消したか」を
   * 言うのに使う（→ {@link decideQuakeCancelNotification}）。この欄を持たない古い記憶（中継の保存分）は空として扱う
   */
  readonly bodies?: Readonly<Record<string, string>>
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
 *
 * `show` は通知が実際に出たかを返す（`false` は許可が無い・「アプリを開いている間は通知しない」で出さなかった）。
 * 出なかった報も、同じ報を 2 度出さない・最大震度が上がったかを比べるためには覚えるが、**取消で言う文（`bodies`）は
 * 覚えない** —— 覚えると、出ていない通知を取消で「取り消されました」と新しく出してしまう（2026-11-09 ユーザー選択
 * 「通知していない報なら出さない (Recommended)」）。
 */
export function scheduleQuakeNotification(args: {
  chains: Map<string, Promise<void>>
  memory: Map<string, QuakeNotifiedState>
  quake: JMAQuake
  reportKeys: readonly string[]
  notifyMinScale: number
  areaPrefIndex: AreaPrefIndex
  m: QuakeNotificationWords
  show: (notification: QuakeNotification) => Promise<boolean>
}): Promise<void> {
  const { chains, memory, quake, reportKeys, notifyMinScale, areaPrefIndex, m, show } = args
  const key = quakeEventKey(quake)
  const before = chains.get(key) ?? Promise.resolve()
  const run = before.then(async () => {
    const decided = decideQuakeNotification(quake, reportKeys, memory.get(key) ?? null, notifyMinScale, areaPrefIndex, m)
    if (!decided) return
    const previous = memory.get(key) ?? null
    const shown = await show(decided.notification)
    rememberQuakeNotified(memory, shown ? decided.next : { ...decided.next, bodies: previous?.bodies ?? {} })
  })
  // 列の末尾は失敗しても次を止めない形で持つ。済んだら、後ろに誰も並んでいなければ列ごと消す
  const tail = run.catch(() => undefined)
  chains.set(key, tail)
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key) })
  return run
}

/**
 * 地震情報の取消の通知を、同じ地震の前の通知が済んでから判定して出す（並べ方は {@link scheduleQuakeNotification} と同じ列）。
 * 出せたら記憶を進める（全体の取消なら忘れ、一部の取消なら取り消した情報名の文だけを消す）。
 */
export function scheduleQuakeCancelNotification(args: {
  chains: Map<string, Promise<void>>
  memory: Map<string, QuakeNotifiedState>
  target: JMAQuake
  cancel: JMAQuake
  whole: boolean
  notifyMinScale: number
  m: QuakeNotificationWords
  show: (notification: QuakeNotification) => Promise<boolean>
}): Promise<void> {
  const { chains, memory, target, cancel, whole, notifyMinScale, m, show } = args
  const key = quakeEventKey(target)
  const before = chains.get(key) ?? Promise.resolve()
  const run = before.then(async () => {
    const decided = decideQuakeCancelNotification(target, cancel, whole, memory.get(key) ?? null, notifyMinScale, m)
    if (!decided) return
    await show(decided.notification)
    if (decided.next) rememberQuakeNotified(memory, decided.next)
    else memory.delete(key)
  })
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
  /** 押したときに開く先（その地震カード。→ `notificationOpen.ts`） */
  readonly open: NotificationOpen
}

/**
 * 最大震度の表記。**断定形で出さない**（→ docs/spec/quake-spec.md §4「震度5弱以上未入電」）。
 * OS 通知はカードを開かない利用者が最初に目にする経路なので、「以上」を落とすと
 * 「実際にはもっと強いかもしれない」が誰にも届かない。
 */
function maxScaleLabel(quake: JMAQuake, m: QuakeNotificationWords): string {
  return intensityLabelWithOrAbove(
    quake.earthquake.maxScale,
    isMaxScaleUnreceived(quake.earthquake.maxScale, quake.points),
    m.formats,
  )
}

/** 規模の語（説明つきの規模は電文の説明を辞書の語へ） */
function magnitudeLabel(quake: JMAQuake, m: QuakeNotificationWords): string {
  const { magnitude, magnitudeCondition, magnitudeType } = quake.earthquake.hypocenter
  return magnitudeWithConditionText(magnitude, magnitudeCondition, magnitudeType, m.formats)
}

/**
 * 最大震度を観測した区域の名前。複数なら先頭に「ほか」を付ける。無ければ `null`。
 *
 * 区域は電文の区域の行（`isAreaPoint`。都道府県のロールアップ点は除く）。並びは電文の順のまま
 * （気象庁の並び）で、その先頭を採る。
 */
export function maxScaleAreaLabel(quake: JMAQuake, areaPrefIndex: AreaPrefIndex, m: QuakeNotificationWords): string | null {
  const names: string[] = []
  for (const p of quake.points) {
    if (p.scale !== quake.earthquake.maxScale) continue
    if (!isAreaPoint(p, areaPrefIndex)) continue
    if (!names.includes(p.addr)) names.push(p.addr)
  }
  if (names.length === 0) return null
  return names.length === 1 ? names[0] : m.alertText.areaAndOthers(names[0])
}

/**
 * 震度速報（震源がまだ判らない報）の本文。例「震度速報 石川県能登ほか 最大震度5弱」。
 * 最大震度の区域が読めないときは区域を省く（「震度速報 最大震度5弱」）。
 */
export function scalePromptNotificationBody(quake: JMAQuake, areaPrefIndex: AreaPrefIndex, m: QuakeNotificationWords): string {
  return m.alertText.scalePrompt(maxScaleAreaLabel(quake, areaPrefIndex, m), maxScaleLabel(quake, m))
}

/** 震源が判った報の本文。例「石川県能登地方 最大震度5弱 M5.2」。 */
export function hypocenterNotificationBody(quake: JMAQuake, m: QuakeNotificationWords): string {
  return m.alertText.hypocenter(quake.earthquake.hypocenter.name, maxScaleLabel(quake, m), magnitudeLabel(quake, m))
}

/** 最大震度が上がった報の本文。例「最大震度更新 石川県能登地方 最大震度6強 M7.6」。 */
export function maxScaleRaisedNotificationBody(quake: JMAQuake, m: QuakeNotificationWords): string {
  return m.alertText.maxScaleRaised(hypocenterNotificationBody(quake, m))
}

/**
 * 最大震度を持たない国内の地震の本文。震源名が無ければ省く。
 *
 * - **震源・震度情報（VXSE53）に震度が無い**なら、電文が「震度1以上を観測しなかった」と言っている。
 *   例「鳥島近海 M6.5（震度1以上の観測なし）」（2026-11-09 ユーザー選択「地名 M のあとに添える」）
 * - **震源情報（VXSE52）・震源要素更新のお知らせ（VXSE61）**はもともと震度を運ばない。震度が無いのは「観測しなかった」ではなく
 *   「この報が言っていない」だけ（控えの全期間で、VXSE52 が 1 通目に届き後から震度つきの報が来た地震が 32 件）。震度に触れず
 *   「鳥島近海 M6.5」とだけ言う（2026-11-09 ユーザー選択「扱いは残し本文を地名と規模だけに (Recommended)」）
 */
export function noIntensityQuakeNotificationBody(quake: JMAQuake, m: QuakeNotificationWords): string {
  return m.alertText.noIntensity(quake.earthquake.hypocenter.name, magnitudeLabel(quake, m), quake.issue.type === '震源・震度情報')
}

/**
 * 遠地地震の本文。例「遠地地震 メキシコ、チアパス州沿岸 M7.4」。震源名は詳細震央地名
 * （パーサーが `Area/DetailedName` を優先して入れる）。名前が無ければ省く。
 */
export function foreignQuakeNotificationBody(quake: JMAQuake, m: QuakeNotificationWords): string {
  return m.alertText.foreignQuake(quake.earthquake.hypocenter.name, magnitudeLabel(quake, m))
}

/**
 * その地震について通知を出すかを決める。**カードが採った報は、まだ通知していない報なら毎回出す**
 * （2026-10-26 ユーザー選択「カードが採った続報すべて (Recommended)」）。
 *
 * - 渡された閾値が負なら出さない（通知しないとき `effectiveNotifyMinScale` が -1 を返す）
 * - 遠地地震（国内の震度を持たない）と、震度を観測しなかった国内の地震（最大震度を持たない報）は閾値に関係なく出す
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
  m: QuakeNotificationWords,
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
  // 震度を観測しなかった国内の地震（震源は判っていて、最大震度を持たない報）。控えの全期間で 6 地震（鳥島近海・台湾付近）
  const noIntensity = !foreign && maxScale < 0 && !isHypocenterPending(quake)
  // 最大震度が「5弱以上（未入電）」なら、実際は 5強以上だった可能性があるので、5強以上を選んでいても通知する
  // （2026-11-04 ユーザー選択「5強以上の設定でも残す (Recommended)」。地震タブの震度の絞り `passesQuakeListFilter` と同じ扱い）
  if (!foreign && !noIntensity && maxScale < notifyMinScale && !isMaxScaleUnreceived(maxScale, quake.points)) return null
  const withHypocenter = foreign || !isHypocenterPending(quake)
  const body = foreign ? foreignQuakeNotificationBody(quake, m)
    : noIntensity ? noIntensityQuakeNotificationBody(quake, m)
    : !withHypocenter ? scalePromptNotificationBody(quake, areaPrefIndex, m)
    // 「最大震度更新」は、前の通知が震度を言っていたときだけ（震度に触れない通知の後に初めて震度が付いた報は、ふつうの震源の文。
    // 2026-11-09 ユーザー選択「「最大震度更新」を付けない (Recommended)」）
    : same?.withHypocenter && same.maxScale >= 0 && maxScale > same.maxScale ? maxScaleRaisedNotificationBody(quake, m)
    : hypocenterNotificationBody(quake, m)
  // 新しい順に並べる（`reportKeys` は届いた順なので、新しい報が先頭へ来るよう裏返す）
  const notified = [...reportKeys.filter(k => !same?.reportKeys.includes(k)).reverse(), ...(same?.reportKeys ?? [])]
  if (notified.length > QUAKE_NOTIFIED_REPORTS_MAX) {
    log.debug(`[notify] 地震情報の通知した報の記憶が上限 ${QUAKE_NOTIFIED_REPORTS_MAX} 件を超えたので、古い ${notified.length - QUAKE_NOTIFIED_REPORTS_MAX} 件を忘れる（${key}）`)
  }
  return {
    notification: { title: m.alertText.quakeTitle, body, tag: key, open: { tab: 'earthquake', quake: key } },
    next: {
      key, withHypocenter, maxScale, reportKeys: notified.slice(0, QUAKE_NOTIFIED_REPORTS_MAX),
      // 最後に通知した情報名が末尾に来るよう、同じ情報名を一度外してから足す（取消の通知の既定の文は末尾を使う）
      bodies: {
        ...Object.fromEntries(Object.entries(same?.bodies ?? {}).filter(([type]) => type !== quake.issue.type)),
        [quake.issue.type]: body,
      },
    },
  }
}

/**
 * 地震情報の取消の通知を決める。**その地震を通知していたときだけ出す**（他の種類の取消と同じ。2026-10-24 ユーザー選択
 * 「発表を通知したものだけ (Recommended)」）。発表と同じ tag で置き換えるので、取り消された通知は通知センターに残らない。
 * 本文は「〈取り消された情報名で最後に通知した文〉は取り消されました」（2026-11-09 ユーザー選択「同じ札で置き換え、何を取り消したか
 * 言う (Recommended)」）。**一部の取消は、取り消された情報名をこの端末が通知していたときだけ出す**（通知していない報の取消で、有効なままの
 * 通知を「取り消された」と言わない。2026-11-09 ユーザー選択「通知していない報なら出さない (Recommended)」）。全体の取消は、その情報名で
 * 通知していなければ、その地震で最後に通知した文を使う（地震ごと取り消されるので、どの通知も取り消されている）。
 *
 * @param target 取消が当たったカード（全体の取消なら取消済みの印の付いたカード、一部の取消なら当て直したカード）
 * @param cancel 取消の電文（`issue.type` が取り消された情報名）
 * @param whole カード全体の取消か。全体なら記憶を消し、一部なら取り消した情報名の文だけを消す
 * @returns 出す通知と次に覚える状態（`null` なら忘れる）。通知していない地震・通知を切っているときは `null`
 */
export function decideQuakeCancelNotification(
  target: JMAQuake,
  cancel: JMAQuake,
  whole: boolean,
  previous: QuakeNotifiedState | null,
  notifyMinScale: number,
  m: QuakeNotificationWords,
): { notification: QuakeNotification; next: QuakeNotifiedState | null } | null {
  if (notifyMinScale < 0) return null
  const key = quakeEventKey(target)
  if (!previous || previous.key !== key) return null
  const bodies = previous.bodies ?? {}
  const all = Object.values(bodies)
  const cancelledBody = bodies[cancel.issue.type] ?? (whole ? all[all.length - 1] : undefined)
  if (cancelledBody === undefined) return null
  const rest = Object.fromEntries(Object.entries(bodies).filter(([type]) => type !== cancel.issue.type))
  return {
    notification: { title: m.alertText.quakeCancelTitle, body: m.alertText.quakeCancelled(cancelledBody), tag: key, open: { tab: 'earthquake', quake: key } },
    next: whole ? null : { ...previous, bodies: rest },
  }
}

/**
 * ライブで届いた取消を、取消の通知の待ち行列へ積むか。**どのカードにも当たらなかった取消・同じ取消の 2 通目は積まない**
 * （当たらない取消を積むと、後から同じ地震の別のカードを引いて、有効なままの通知を「取り消された」と言ってしまう）。
 * `whole` は全体の取消か（一部の取消は取り消した情報名 `retracted` を持つ）。
 *
 * @param applied 受信側が決めた取消の当たり方（`LiveEventMeta.quakeCancel`）。決められなかったときは undefined
 */
export function quakeCancelToNotify(
  applied: { readonly target: unknown; readonly retracted: unknown; readonly duplicate: boolean } | undefined,
): { whole: boolean } | null {
  if (!applied?.target || applied.duplicate) return null
  return { whole: applied.retracted === undefined }
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
