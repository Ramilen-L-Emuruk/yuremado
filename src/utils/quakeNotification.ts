// 地震情報のブラウザ通知（OS 通知）の中身と、出すかどうかを決める。**通知を出すのは App の担当**で、
// ここは純粋な判定だけ（単体テストの対象）。背景は docs/spec/settings-pwa-spec.md §2「ブラウザ通知」。
//
// **1 つの地震で出すのは最大 2 回**（2026-10-19 ユーザー承認「速報の文＋震源で置き換え (推奨)」）。
// - 震度速報（震源がまだ判らない報）が閾値を満たせば、まず「震度速報 {区域} 最大震度{震度}」を出す
// - 同じ地震で震源が判った報が来たら、もう 1 度だけ「{震源名} 最大震度{震度} {規模}」を出す
// - その後の続報では出さない
// 通知の tag を地震ごと（`quakeEventKey`）にするので、2 回目は OS 上で 1 回目を置き換える。
import type { AreaPrefIndex } from './quakePoints'
import { isAreaPoint, isMaxScaleUnreceived } from './quakePoints'
import type { JMAQuake } from '../types/earthquake'
import { getIntensityLabelWithOrAbove } from './intensity'
import { formatMagnitudeWithCondition } from './formatters'
import { isHypocenterPending, quakeEventKey } from './quakeMerge'

/** 最後に通知した地震と、そのとき震源が判っていたか。 */
export interface QuakeNotifiedState {
  readonly key: string
  readonly withHypocenter: boolean
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

/** 出す通知。 */
export interface QuakeNotification {
  readonly title: string
  readonly body: string
  /** OS 上で同じ地震の通知を置き換えるための印（地震ごとの鍵）。 */
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

/**
 * いちばん新しい地震について通知を出すかを決める。
 *
 * - 閾値（`notifyMinScale`。負なら通知しない）は従来どおり最大震度で見る
 * - 前回通知した地震と同じ鍵なら、**震源なしで出したあとに震源が判ったときだけ**もう 1 度出す
 * - 震源が判ったかは震源の欄が埋まったか（`isHypocenterPending`）で見る。本文が震源名を使うため
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
  if (quake.earthquake.maxScale < notifyMinScale) return null
  const key = quakeEventKey(quake)
  const withHypocenter = !isHypocenterPending(quake)
  if (previous && previous.key === key && (previous.withHypocenter || !withHypocenter)) return null
  return {
    notification: {
      title: '地震情報',
      body: withHypocenter ? hypocenterNotificationBody(quake) : scalePromptNotificationBody(quake, areaPrefIndex),
      tag: key,
    },
    next: { key, withHypocenter },
  }
}
