import type { JMATsunami, TsunamiArea, TsunamiObservation } from '../types/earthquake'
import { tsunamiMaxGrade, tsunamiLiftText, sortAreasAcrossGradesForCardDisplay } from './tsunami'
import { TSUNAMI_ALL_LIFTED_SENTENCE } from './ttsText'

/** 津波のブラウザ通知に出す中身。`showBrowserNotification` の引数へそのまま渡す。 */
export interface TsunamiNotification {
  readonly title: string
  readonly body: string
  /** 閉じるまで残すか。 */
  readonly requireInteraction: boolean
}

/**
 * 通知が区域を挙げるのに使う材料。受信処理の `tsunamiCardOrderBasis` がそのまま渡る
 * （**カードと同じ材料**。電文の値だけで並べるとカードの並びと食い違う。理由はあちらの宣言箇所）。
 */
export interface TsunamiNotificationBasis {
  readonly areas: readonly TsunamiArea[]
  readonly observations: readonly TsunamiObservation[]
  readonly liftedAreas: readonly TsunamiArea[]
}

/** 1 行に名前を挙げる区域の数。超えた分は「ほか N 区域」にまとめる。 */
export const TSUNAMI_NOTIFY_MAX_AREAS = 5

/**
 * 区域名を通知の 1 行へ並べる。{@link TSUNAMI_NOTIFY_MAX_AREAS} を超えた分は件数だけ添える
 * （2026-10-14 ユーザー選択「「ほか N 区域」を足す（推奨）」。書き方は 2026-10-19 ユーザー選択
 * 「空白を入れる (Recommended)」＝描画の不調の「○・○ ほか 2 件」・共有カードの「12 区域」と揃える）。
 *
 * 黙って切ると、6 件目以降の区域が通知から消えたことに読み手は気づけない。
 */
export function joinAreaNamesForNotification(areas: readonly TsunamiArea[]): string {
  const names = areas.slice(0, TSUNAMI_NOTIFY_MAX_AREAS).map(a => a.name).join('、')
  const rest = areas.length - TSUNAMI_NOTIFY_MAX_AREAS
  return rest > 0 ? `${names} ほか ${rest} 区域` : names
}

/**
 * 発表中の津波の報の通知。**等級を伝えていない報（区域が空）・解除と取消の報は対象外**で、
 * 呼び出し側が弾く（`isTsunamiObservationOnly`・`cancelled`）。
 *
 * - 見出しは発表中のいちばん高い等級
 * - 1 行目はいま出ている区域を**カードの並び**で（受信処理の `tsunamiCardOrderBasis` が作る材料。電文順＝気象庁の地理順で
 *   切ると、カードの先頭に並ぶ深刻な区域が通知から落ちる）
 * - **この報で解除された区域は「解除：」を頭に付けた別の行に出す**（2026-10-14 ユーザー選択
 *   「解除区域を別の行で出す」。書き方は 2026-10-19 ユーザー選択「「解除：」を頭に付ける
 *   (Recommended)」）。1 行目へ混ぜると、見出しの等級の下に並ぶので**まだ出ている**と読める
 * - **閉じるまで残すのは津波注意報以上**。津波予報は自然に消える（2026-10-14 ユーザー選択
 *   「注意報以上を残す（推奨）」）
 */
export function tsunamiIssueNotification(event: JMATsunami, basis: TsunamiNotificationBasis): TsunamiNotification {
  const grade = tsunamiMaxGrade(event)
  const title = grade === 'MajorWarning' ? '大津波警報'
    : grade === 'Warning' ? '津波警報'
    : grade === 'Forecast' ? '津波予報（若干の海面変動）'
    : '津波注意報'
  const lines = [joinAreaNamesForNotification(sortAreasAcrossGradesForCardDisplay(basis.areas, basis.observations))]
  // 並びはカードの解除の枠と同じ材料（`liftedAreas`）から取る。
  if (basis.liftedAreas.length > 0) lines.push(`解除：${joinAreaNamesForNotification(basis.liftedAreas)}`)
  // 等級を読めなかった報（`Unknown`）は残さない。選んだのは「注意報以上を残す」で、読めない等級はそこに入らない
  const requireInteraction = grade === 'MajorWarning' || grade === 'Warning' || grade === 'Watch'
  return { title, body: lines.join('\n'), requireInteraction }
}

/**
 * 全区域が解除された報（`cancelReason: 'lifted'`）の通知（2026-10-19 ユーザー選択「送る (Recommended)」）。
 *
 * 本文は気象庁がその報に書いた文（固定付加文 0107 など。画面の解除表示と同じ `tsunamiLiftText`）。
 * 文を持たない報（P2PQuake など）では読み上げと同じ文にする（2026-10-19 ユーザー選択「読み上げと同じ文
 * (Recommended)」）。**閉じるまでは残さない** —— 終わったことの報せなので、自然に消えてよい。
 * tag は発表中の通知と同じなので、閉じるまで残していた前の通知はこれで置き換わる。
 */
export function tsunamiLiftNotification(event: Pick<JMATsunami, 'bodyText' | 'warningComments' | 'freeText'>): TsunamiNotification {
  return {
    title: '津波警報等の解除',
    body: tsunamiLiftText(event) ?? TSUNAMI_ALL_LIFTED_SENTENCE,
    requireInteraction: false,
  }
}
