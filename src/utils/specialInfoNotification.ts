import type {
  JMANankai, JMANankaiCommentary, JMAKohatsu, JMALpgm, JMAEarthquakeCount, JMAEstimatedIntensity,
} from '../types/earthquake'
import { readDateTime } from './formatters'

/**
 * 南海トラフ・後発地震・関連解説情報・長周期地震動・推計震度分布図・地震回数のブラウザ通知の中身。
 * `showBrowserNotification` の引数へそのまま渡す。
 *
 * **文面は 2026-10-24 ユーザー選択「この案でよい (Recommended)」**（通知を出すこと自体は 2026-10-22
 * ユーザー選択「通知を出す (Recommended)」「タイトルと通知を出す (Recommended)」「「受信した」を通知する」と
 * 2026-10-23 ユーザー選択「タイトルと通知を臨時情報と揃える (Recommended)」）。
 *
 * - 見出しは電文の情報名。本文は気象庁の要約（見出し文）か、帯・読み上げと同じ言い方
 * - **同じ種類の通知は後から来た報で置き換える**（`tag` を種類ごとに固定する。長周期・推計は地震ごと）
 * - 取消は「〇〇 取消」／「〇〇は取り消されました」。緊急地震速報の取消の通知と同じ形
 */
export interface SpecialInfoNotification {
  readonly title: string
  readonly body: string
  readonly tag: string
}

const NANKAI_NAME = '南海トラフ地震臨時情報'
const KOHATSU_NAME = '北海道・三陸沖後発地震注意情報'
const COMMENTARY_NAME = '南海トラフ地震関連解説情報'
const LPGM_NAME = '長周期地震動に関する観測情報'
const ESTIMATED_NAME = '推計震度分布図'
const COUNT_NAME = '地震回数に関する情報'

function cancelled(name: string, tag: string, subject = name): SpecialInfoNotification {
  return { title: `${name} 取消`, body: `${subject}は取り消されました`, tag }
}

/**
 * 臨時情報の通知。段階（調査中・巨大地震注意・巨大地震警戒・調査終了）を見出しへ括弧で入れる
 * （ウィンドウタイトルと同じ書き方）。**取消（`retracted`）と調査終了を混ぜない**（→ `JMANankai.retracted`）。
 * 段階名を読めない報は情報名だけを見出しにする。要約の無い報は本文なし。
 */
export function nankaiNotification(event: JMANankai): SpecialInfoNotification {
  if (event.retracted) return cancelled(NANKAI_NAME, 'nankai')
  const stage = event.kindName || (event.cancelled ? '調査終了' : '')
  return { title: stage ? `${NANKAI_NAME}（${stage}）` : NANKAI_NAME, body: event.summary ?? '', tag: 'nankai' }
}

/** 後発地震注意情報の通知。この電文に終了の報は無いので、`cancelled` が立つのは取消だけ。 */
export function kohatsuNotification(event: JMAKohatsu): SpecialInfoNotification {
  if (event.cancelled) return cancelled(KOHATSU_NAME, 'kohatsu')
  return { title: KOHATSU_NAME, body: event.summary ?? '', tag: 'kohatsu' }
}

/**
 * 関連解説情報の通知。**呼び出し側が臨時解説だけに絞る**（定例解説は毎月届くので出さない。
 * 2026-10-24 ユーザー選択「出す (Recommended)」）。見出しは電文の情報名（「（第１号）」を含む）。
 */
export function nankaiCommentaryNotification(event: JMANankaiCommentary): SpecialInfoNotification {
  if (event.cancelled) return cancelled(COMMENTARY_NAME, 'nankai-commentary')
  return { title: event.headline.trim() || COMMENTARY_NAME, body: event.summary ?? '', tag: 'nankai-commentary' }
}

/**
 * 長周期地震動に関する観測情報の通知。本文は震央地名と最大長周期地震動階級（地名が無ければ階級だけ）。
 * 最大階級 0 の報も同じ形で出す（2026-10-30 ユーザー選択「階級 1 以上と同じ型 (Recommended)」・#1201。
 * それまでは 2026-10-24 ユーザー選択「階級1以上 (Recommended)」で呼び出し側が 1 以上に絞っていた）。
 * 取消は表示中の報から地名を引けないこともあるので、`name` を呼び出し側が渡す（空なら地名なし）。
 */
export function lpgmNotification(event: JMALpgm, cancelSubjectName: string): SpecialInfoNotification {
  const tag = `lpgm-${event.eventId}`
  if (event.cancelled) {
    const name = cancelSubjectName.trim()
    return cancelled(LPGM_NAME, tag, name ? `${name}の${LPGM_NAME}` : LPGM_NAME)
  }
  const name = event.hypocenter?.name.trim() ?? ''
  const cls = `最大長周期地震動階級${event.maxClass}`
  return { title: LPGM_NAME, body: name ? `${name} ${cls}` : cls, tag }
}

/**
 * 推計震度分布図の通知。どの地震の分布かは地震発現時刻で言う（読み上げ `estimatedIntensityToText` と同じ言い方）。
 * **推計の最大震度は出さない**（2026-10-22 ユーザー選択「「受信した」を通知する」。⑤ E10 と揃う）。
 */
export function estimatedIntensityNotification(event: JMAEstimatedIntensity, isNew: boolean): SpecialInfoNotification {
  const d = readDateTime('estimatedIntensityNotification', event.arrivalTime)
  const when = d ? `${d.getHours()}時${String(d.getMinutes()).padStart(2, '0')}分頃発生した地震の` : ''
  return {
    title: ESTIMATED_NAME,
    body: `${when}${ESTIMATED_NAME}${isNew ? 'を受信しました' : 'が更新されました'}`,
    tag: `estimated-intensity-${event.arrivalTime}`,
  }
}

/**
 * 地震回数に関する情報の通知。本文は帯の見出しと同じ（`earthquakeCountHeadline` の結果を渡す）。
 * 見出しが種別名だけ（伝える回数が無い報）なら本文なし。
 */
export function earthquakeCountNotification(event: JMAEarthquakeCount, headline: string): SpecialInfoNotification {
  if (event.cancelled) return cancelled(COUNT_NAME, 'earthquake-count')
  return { title: COUNT_NAME, body: headline === COUNT_NAME ? '' : headline, tag: 'earthquake-count' }
}
