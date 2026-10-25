import type { JMATsunami, TsunamiArea, TsunamiObservation } from '../types/earthquake'
import { tsunamiMaxGrade, tsunamiLiftText, sortAreasAcrossGradesForCardDisplay, observationHeightText, isObservationMissing } from './tsunami'
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
 * 発表中の津波の報の通知。**等級を発表しない報（VTSE51・VTSE52）・解除と取消の報は対象外**で、
 * 呼び出し側が弾く（`isTsunamiGradeReport`・`isTsunamiObservationOnly`・`cancelled`）。
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

/** 観測情報の通知で名前を挙げる観測点の数。超えた分は「ほか N 地点」にまとめる（区域の 5 件と揃える）。 */
export const TSUNAMI_OBS_NOTIFY_MAX_POINTS = 5

/**
 * 観測点を通知の 1 行へ並べるときの、観測点ごとの語（「輪島港 1.2m」「珠洲市長橋 到達確認」「富山 欠測」）。
 *
 * 値の語はカードの行と同じ関数から採る（波高は {@link observationHeightText}、欠測・到達確認は
 * {@link observationBadges} の語）。波高を持つ欠測は「富山 0.3m 欠測」、微弱のまま欠測は「〇〇 微弱 欠測」になる —— 値を
 * 観測できていたことと、いま観測できていないことの両方が事実なので、片方へ丸めない（この 2 つの形は 2026-10-24 ユーザー選択
 * 「この形で残す (Recommended)」）。
 */
function observationNotifyLabel(o: TsunamiObservation): string {
  const height = observationHeightText(o)
  const missing = isObservationMissing(o)
  if (o.height) return missing ? `${o.name} ${height} 欠測` : `${o.name} ${height}`
  if (missing) return o.condition?.weak ? `${o.name} 微弱 欠測` : `${o.name} 欠測`
  if (height && height !== '観測中') return `${o.name} ${height}`
  return `${o.name} 到達確認`
}

/** 観測情報の通知の札。発表中の通知（`tsunami`）と分ける（理由は {@link tsunamiObservationNotification}）。 */
export const TSUNAMI_OBS_NOTIFICATION_TAG = 'tsunami-obs'

/**
 * 等級を発表しない報（津波情報 VTSE51・沖合の観測 VTSE52）の通知（2026-10-21 ユーザー選択「観測でも通知する」。
 * 形は 2026-10-24 ユーザー選択「別の通知にする (Recommended)」。VTSE51 を区域の有無に関わらずこちらへ回すのは
 * 2026-10-25 ユーザー選択「A 発表は VTSE41 だけ (Recommended)」）。
 *
 * - 見出しは電文が名乗る情報名（「津波観測に関する情報」「沖合の津波観測に関する情報」）
 * - 本文はその報で**カードに印が付いた観測点**を、カードの並びで 5 件まで（例「輪島港 1.2m、珠洲市長橋 到達確認、
 *   富山 欠測 ほか 2 地点」）。印の付いた観測点が無い報（同じ値の再送）は呼び出し側が通知しない
 * - **閉じるまでは残さない**。札（tag）は発表中の通知と分ける —— 同じ札にすると、閉じるまで残す
 *   大津波警報の通知が観測の通知に置き換わって消える
 */
export function tsunamiObservationNotification(
  event: Pick<JMATsunami, 'infoName'>,
  marked: readonly TsunamiObservation[],
): TsunamiNotification {
  const shown = marked.slice(0, TSUNAMI_OBS_NOTIFY_MAX_POINTS).map(observationNotifyLabel).join('、')
  const rest = marked.length - TSUNAMI_OBS_NOTIFY_MAX_POINTS
  return {
    title: event.infoName || '津波観測に関する情報',
    body: rest > 0 ? `${shown} ほか ${rest} 地点` : shown,
    requireInteraction: false,
  }
}

/**
 * 津波警報等の取消（`cancelReason: 'retracted'`）と津波予報の失効（`'expired'`）の通知
 * （2026-10-21 ユーザー選択「取消も失効も通知 (Recommended)」。文面は 2026-10-24 ユーザー選択「この文面で (Recommended)」）。
 *
 * 札は発表中の通知と同じなので、閉じるまで残していた前の通知はこれで置き換わる（解除の通知と同じ）。
 * 閉じるまでは残さない。**津波情報だけの取消（警報等は続いている）は対象外**で、呼び出し側が通さない。
 */
export function tsunamiEndNotification(event: Pick<JMATsunami, 'cancelReason' | 'cancelText'>): TsunamiNotification | null {
  if (event.cancelReason === 'retracted') {
    return {
      title: '津波警報等の取消',
      body: event.cancelText?.trim() || '津波警報等は誤って発表されたため取り消されました。',
      requireInteraction: false,
    }
  }
  if (event.cancelReason === 'expired') {
    return { title: '津波予報の失効', body: '津波予報は失効しました。', requireInteraction: false }
  }
  return null
}
