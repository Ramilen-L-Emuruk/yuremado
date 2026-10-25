// 地震情報のブラウザ通知（OS 通知）の中身と、出すかどうかを決める。**通知を出すのは App の担当**で、
// ここは純粋な判定だけ（単体テストの対象）。背景は docs/spec/settings-pwa-spec.md §2「ブラウザ通知」。
//
// **1 つの地震で出すのは、震度速報・震源が判った報・最大震度が上がった報の 3 つの場面**。
// - 震度速報（震源がまだ判らない報）が閾値を満たせば、まず「震度速報 {区域} 最大震度{震度}」を出す
// - 同じ地震で震源が判った報が来たら、もう 1 度「{震源名} 最大震度{震度} {規模}」を出す
//   （ここまで 2026-10-19 ユーザー承認「速報の文＋震源で置き換え (推奨)」）
// - 震源が判ったあとの続報で、最大震度の階級が前に通知したときより上がったら
//   「最大震度更新 {震源名} 最大震度{震度} {規模}」を出し、音も鳴らし直す
//   （2026-10-21 選択「上がったら出し直す (Recommended)」・2026-10-22 選択「頭に「最大震度更新」 (Recommended)」）
// - 遠地地震は設定の震度に関係なく、地震ごとに 1 回「遠地地震 {震源名} {規模}」を出す
//   （2026-10-22 選択「全部出す (Recommended)」。震源名は詳細震央地名）
// 通知の tag を地震ごと（`quakeEventKey`）にするので、2 回目以降は OS 上で前の通知を置き換える。
import type { AreaPrefIndex } from './quakePoints'
import { isAreaPoint, isMaxScaleUnreceived } from './quakePoints'
import type { JMAQuake } from '../types/earthquake'
import { getIntensityLabelWithOrAbove } from './intensity'
import { formatMagnitudeWithCondition } from './formatters'
import { isHypocenterPending, quakeEventKey, sameQuakeEntry } from './quakeMerge'

/** 最後に通知した地震と、そのとき震源が判っていたか・最大震度は何だったか。 */
export interface QuakeNotifiedState {
  readonly key: string
  readonly withHypocenter: boolean
  /** 最後に通知したときの最大震度。上がったら出し直す（→ {@link decideQuakeNotification}）。 */
  readonly maxScale: number
}

/**
 * 通知した地震を覚えておく数の上限。超えたら古いものから忘れる（忘れた地震の続報が先頭に戻ると
 * 震源の報でもう 1 度出しうるが、200 件前の地震が先頭へ戻ることは無い）。
 */
export const QUAKE_NOTIFIED_MEMORY_MAX = 200

/**
 * 通知した地震を**地震ごとに**覚える。1 件だけ覚える形だと、地震 A・B の報が交互に先頭へ来たとき
 * A を忘れて「3 回目は出さない」が崩れる（同じ分の別地震・群発で起きる）。
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
 */
export function scheduleQuakeNotification(args: {
  chains: Map<string, Promise<void>>
  memory: Map<string, QuakeNotifiedState>
  quake: JMAQuake
  notifyMinScale: number
  areaPrefIndex: AreaPrefIndex
  show: (notification: QuakeNotification) => Promise<void>
}): Promise<void> {
  const { chains, memory, quake, notifyMinScale, areaPrefIndex, show } = args
  const key = quakeEventKey(quake)
  const before = chains.get(key) ?? Promise.resolve()
  const run = before.then(async () => {
    const decided = decideQuakeNotification(quake, memory.get(key) ?? null, notifyMinScale, areaPrefIndex)
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
  /** OS 上で同じ地震の通知を置き換えるための印（地震ごとの鍵）。 */
  readonly tag: string
  /**
   * 置き換えるときも音を鳴らし直すか（Notification の `renotify`）。最大震度が上がった報だけ真 ——
   * 同じ tag の通知は既定では黙って差し替わるので、上がったことに気づけない。
   */
  readonly renotify: boolean
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
 * その地震について通知を出すかを決める。
 *
 * - 渡された閾値が負なら出さない（通知しないとき `effectiveNotifyMinScale` が -1 を返す）
 * - 遠地地震（国内の震度を持たない）は閾値に関係なく、地震ごとに 1 回だけ出す
 * - それ以外は最大震度が閾値（`notifyMinScale`）以上のときだけ見る
 * - 前回通知した地震と同じ鍵なら、次のどちらかのときだけもう 1 度出す
 *   - 震源なしで出したあとに震源が判った
 *   - 震源が判ったあとで、最大震度が前に通知したときより上がった（音も鳴らし直す）
 * - 震源が判ったかは震源の欄が埋まったか（`isHypocenterPending`）で見る。本文が震源名を使うため
 *
 * **震源がまだ判らないうちに最大震度が上がっても出さない。** 震源が判った報で、そのときの最大震度を出す。
 *
 * @returns 出す通知と、次に覚えておく状態。出さなければ `null`（状態も変えない）
 */
export function decideQuakeNotification(
  quake: JMAQuake,
  previous: QuakeNotifiedState | null,
  notifyMinScale: number,
  areaPrefIndex: AreaPrefIndex,
): { notification: QuakeNotification; next: QuakeNotifiedState } | null {
  if (notifyMinScale < 0) return null
  const key = quakeEventKey(quake)
  const sameQuake = previous !== null && previous.key === key
  const maxScale = quake.earthquake.maxScale
  if (quake.issue.type === '遠地地震') {
    if (sameQuake) return null
    return {
      notification: { title: '地震情報', body: foreignQuakeNotificationBody(quake), tag: key, renotify: false },
      next: { key, withHypocenter: true, maxScale },
    }
  }
  if (maxScale < notifyMinScale) return null
  const withHypocenter = !isHypocenterPending(quake)
  if (sameQuake) {
    if (!previous.withHypocenter && withHypocenter) {
      return {
        notification: { title: '地震情報', body: hypocenterNotificationBody(quake), tag: key, renotify: false },
        next: { key, withHypocenter, maxScale },
      }
    }
    if (previous.withHypocenter && withHypocenter && maxScale > previous.maxScale) {
      return {
        notification: { title: '地震情報', body: maxScaleRaisedNotificationBody(quake), tag: key, renotify: true },
        next: { key, withHypocenter, maxScale },
      }
    }
    return null
  }
  return {
    notification: {
      title: '地震情報',
      body: withHypocenter ? hypocenterNotificationBody(quake) : scalePromptNotificationBody(quake, areaPrefIndex),
      tag: key,
      renotify: false,
    },
    next: { key, withHypocenter, maxScale },
  }
}

/**
 * ライブで届いた報から、通知を考える地震カードを引く。受信側の統合と同じ当て方（`sameQuakeEntry`）で、
 * 取り消されたカードは外す。同じカードに当たった報は 1 つにまとめる（同じティックに続報が並んだとき）。
 *
 * @returns 引けたカードと、引けなかった報（状態が採らなかった・取り消された報。呼び出し側が記録する）
 */
export function collectQuakesToNotify(
  pending: readonly JMAQuake[],
  earthquakes: readonly JMAQuake[],
  areaPrefIndex: AreaPrefIndex,
): { cards: JMAQuake[]; unmatched: JMAQuake[] } {
  const cards: JMAQuake[] = []
  const unmatched: JMAQuake[] = []
  for (const incoming of pending) {
    const card = earthquakes.find(c => !c.cancelledAt && sameQuakeEntry(c, incoming, areaPrefIndex))
    if (!card) unmatched.push(incoming)
    else if (!cards.includes(card)) cards.push(card)
  }
  return { cards, unmatched }
}
