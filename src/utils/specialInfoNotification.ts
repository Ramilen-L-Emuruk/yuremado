import type {
  JMANankai, JMANankaiCommentary, JMAKohatsu, JMALpgm, JMAEarthquakeCount, JMAEstimatedIntensity, JMAInternationalTsunami,
  JMAQuakeNotice,
} from '../types/earthquake'
import type { Messages } from '../i18n/messages'
import type { PlaceNameLookup } from '../i18n/placeNames'
import { readDateTime } from './formatters'
import type { NotificationOpen } from './notificationOpen'

/**
 * 南海トラフ・後発地震・関連解説情報・長周期地震動・推計震度分布図・地震回数のブラウザ通知の中身。
 * `showBrowserNotification` の引数へそのまま渡す。
 *
 * **文面は 2026-10-24 ユーザー選択「この案でよい (Recommended)」**（通知を出すこと自体は 2026-10-22
 * ユーザー選択「通知を出す (Recommended)」「タイトルと通知を出す (Recommended)」「「受信した」を通知する」と
 * 2026-10-23 ユーザー選択「タイトルと通知を臨時情報と揃える (Recommended)」）。
 *
 * - 見出しは電文の情報名（言語に合わせて電文ログの題名の語で引く）。本文は気象庁の要約（見出し文）か、帯・読み上げと同じ言い方
 * - **同じ種類の通知は後から来た報で置き換える**（`tag` を種類ごとに固定する。長周期・推計は地震ごと）
 * - 取消は「〇〇 取消」／「〇〇は取り消されました」。緊急地震速報の取消の通知と同じ形。南海トラフ・後発・関連解説・
 *   地震回数・お知らせは、電文が取消の理由（`Body/Text`）を持てば本文をその文にする（2026-11-09 ユーザー選択
 *   「帯を取消に切り替え＋通知に理由 (Recommended)」。説明「ブラウザ通知・プッシュ通知の本文を理由の文に（空なら今の定型文）」）
 * - 電文の値（要約・見出し文・取消の理由・震源名）は辞書を通さない
 */
export interface SpecialInfoNotification {
  readonly title: string
  readonly body: string
  readonly tag: string
  /**
   * 押したときに開く先。長周期・推計は、その地震を選んで表示を開く。南海トラフ・後発・関連解説・地震回数と
   * 取消は持たない（`null`。帯はどの画面でも地図の上に出ているので、アプリを前に出すだけ）
   */
  readonly open: NotificationOpen | null
}

/** 通知の文を組む語。アプリはいまの言語の辞書、中継は日本語の辞書（`JA_MESSAGES`）を渡す */
export type SpecialInfoNotificationWords = Pick<Messages, 'alertText' | 'telegramLog' | 'specialInfo' | 'formats'>

// 情報名（電文の `Control/Title`）。取消の帯（→ `specialInfoCancelBand.ts`）も同じ名前を辞書の鍵にする
export const NANKAI_NAME = '南海トラフ地震臨時情報'
export const KOHATSU_NAME = '北海道・三陸沖後発地震注意情報'
export const COMMENTARY_NAME = '南海トラフ地震関連解説情報'
const LPGM_NAME = '長周期地震動に関する観測情報'
export const COUNT_NAME = '地震回数に関する情報'
export const QUAKE_NOTICE_NAME = '地震・津波に関するお知らせ'
const JST_OFFSET_MS = 9 * 60 * 60 * 1000

/** 情報名を言語に合わせる（電文ログの題名の語）。表に無い名前はそのまま。ウィンドウの題名も同じ語を使う */
export function localizedInfoName(name: string, m: Pick<Messages, 'telegramLog'>): string {
  const titles: Readonly<Record<string, string>> = m.telegramLog.controlTitle
  return Object.prototype.hasOwnProperty.call(titles, name) ? titles[name] : name
}

/** 南海トラフ地震臨時情報の段階名（電文の `InfoSerial/Name`）を言語に合わせる（帯の札の語）。表に無い語はそのまま */
export function localizedNankaiStage(stage: string, m: Pick<Messages, 'specialInfo'>): string {
  return Object.prototype.hasOwnProperty.call(m.specialInfo.nankaiKind, stage) ? m.specialInfo.nankaiKind[stage] : stage
}

function cancelled(name: string, tag: string, subject: string, reason: string, m: SpecialInfoNotificationWords): SpecialInfoNotification {
  return { title: m.specialInfo.cancelTitle(name), body: reason.trim() || m.specialInfo.cancelText(subject), tag, open: null }
}

/**
 * 臨時情報の通知。段階（調査中・巨大地震注意・巨大地震警戒・調査終了）を見出しへ括弧で入れる
 * （ウィンドウタイトルと同じ書き方）。**取消（`retracted`）と調査終了を混ぜない**（→ `JMANankai.retracted`）。
 * 段階名を読めない報は情報名だけを見出しにする。要約の無い報は本文なし。段階名は帯の札の語で引き、表に無い語は電文のまま。
 */
export function nankaiNotification(event: JMANankai, m: SpecialInfoNotificationWords): SpecialInfoNotification {
  const name = localizedInfoName(NANKAI_NAME, m)
  if (event.retracted) return cancelled(name, 'nankai', name, event.body ?? '', m)
  const stage = event.kindName || (event.cancelled ? '調査終了' : '')
  return { title: stage ? m.alertText.withStage(name, localizedNankaiStage(stage, m)) : name, body: event.summary ?? '', tag: 'nankai', open: null }
}

/** 後発地震注意情報の通知。この電文に終了の報は無いので、`cancelled` が立つのは取消だけ。 */
export function kohatsuNotification(event: JMAKohatsu, m: SpecialInfoNotificationWords): SpecialInfoNotification {
  const name = localizedInfoName(KOHATSU_NAME, m)
  if (event.cancelled) return cancelled(name, 'kohatsu', name, event.body ?? '', m)
  return { title: name, body: event.summary ?? '', tag: 'kohatsu', open: null }
}

/**
 * 関連解説情報の通知（臨時解説・定例解説とも同じ形。どちらを出すかの設定は `planSpecialInfoNotification`）。
 * 見出しは電文の情報名（臨時解説は「（第１号）」を含む。電文の値なのでどの言語もそのまま）。読めなければ種別名。
 */
export function nankaiCommentaryNotification(event: JMANankaiCommentary, m: SpecialInfoNotificationWords): SpecialInfoNotification {
  const name = localizedInfoName(COMMENTARY_NAME, m)
  if (event.cancelled) return cancelled(name, 'nankai-commentary', name, event.body ?? '', m)
  return { title: event.headline.trim() || name, body: event.summary ?? '', tag: 'nankai-commentary', open: null }
}

/**
 * 長周期地震動に関する観測情報の通知。本文は震央地名と最大長周期地震動階級（地名が無ければ階級だけ）。
 * 最大階級 0 の報も同じ形で出す（2026-10-30 ユーザー選択「階級 1 以上と同じ型 (Recommended)」・#1201。
 * それまでは 2026-10-24 ユーザー選択「階級1以上 (Recommended)」で呼び出し側が 1 以上に絞っていた）。
 * 取消は表示中の報から地名を引けないこともあるので、`name` を呼び出し側が渡す（空なら地名なし）。
 */
export function lpgmNotification(event: JMALpgm, cancelSubjectName: string, m: SpecialInfoNotificationWords, place: PlaceNameLookup): SpecialInfoNotification {
  const tag = `lpgm-${event.eventId}`
  const lpgmName = localizedInfoName(LPGM_NAME, m)
  if (event.cancelled) {
    const name = cancelSubjectName.trim()
    return cancelled(lpgmName, tag, name ? m.alertText.lpgmFor(place('epi', name), lpgmName) : lpgmName, '', m)
  }
  const raw = event.hypocenter?.name.trim() ?? ''
  const name = raw ? place('epi', raw) : ''
  const body = m.alertText.joinParts([name, m.alertText.lpgmMaxClass(event.maxClass)].filter(p => p !== ''))
  return { title: lpgmName, body, tag, open: { tab: 'earthquake', lpgm: event.eventId } }
}

/**
 * 推計震度分布図の通知。どの地震の分布かは地震発現時刻で言う（読み上げ `estimatedIntensityToText` と同じ言い方）。
 * **推計の最大震度は出さない**（2026-10-22 ユーザー選択「「受信した」を通知する」。⑤ E10 と揃う）。
 */
export function estimatedIntensityNotification(event: JMAEstimatedIntensity, isNew: boolean, m: SpecialInfoNotificationWords): SpecialInfoNotification {
  const d = readDateTime('estimatedIntensityNotification', event.arrivalTime)
  // 時刻は日本時間で読む。端末の時間帯で読むと、中継（UTC で動く）が送るプッシュ通知と画面内の通知で時刻がずれる
  const jst = d ? new Date(d.getTime() + JST_OFFSET_MS) : null
  const at = jst ? { hour: jst.getUTCHours(), minute: jst.getUTCMinutes() } : null
  const name = m.telegramLog.kind.estimatedIntensity
  return {
    title: name,
    body: m.alertText.estimatedIntensity(at, name, isNew),
    tag: `estimated-intensity-${event.arrivalTime}`,
    open: { tab: 'earthquake', estimated: event.arrivalTime, lat: event.hypocenter?.lat, lon: event.hypocenter?.lon },
  }
}

/**
 * 地震回数に関する情報の通知。本文は帯の見出しと同じ（`earthquakeCountHeadlineText` に同じ辞書を渡した結果を渡す）。
 * 見出しが種別名だけ（伝える回数が無い報）なら本文なし。
 */
export function earthquakeCountNotification(event: JMAEarthquakeCount, headline: string, m: SpecialInfoNotificationWords): SpecialInfoNotification {
  const name = localizedInfoName(COUNT_NAME, m)
  if (event.cancelled) return cancelled(name, 'earthquake-count', name, event.cancelText ?? '', m)
  return { title: name, body: headline === m.specialInfo.countHeadlineNone ? '' : headline, tag: 'earthquake-count', open: null }
}

/**
 * 地震・津波に関するお知らせの通知。見出しは情報名、本文は電文の見出し文（`Head/Headline/Text`）そのまま
 * （2026-11-09 ユーザー選択「この文面でよい (Recommended)」）。押したらアプリを前に出すだけ（帯はどの画面でも地図の上に出ている）。
 */
export function quakeNoticeNotification(event: JMAQuakeNotice, m: SpecialInfoNotificationWords): SpecialInfoNotification {
  const name = localizedInfoName(QUAKE_NOTICE_NAME, m)
  if (event.cancelled) return cancelled(name, 'quake-notice', name, event.body ?? '', m)
  return { title: name, body: event.headline.trim(), tag: 'quake-notice', open: null }
}

/**
 * 国際津波関連情報の通知の本文。日本語は読み上げの文から名乗りを除いたもの（`internationalTsunamiSpeech.ts` の
 * `internationalTsunamiBody` と同じ文。2026-11-06 ユーザー選択「通知もそろえる (Recommended)」）。
 *
 * - 発生時刻は日本時間（端末の時間帯で読まない。中継は UTC で動く）
 * - 震源は、同じ地震の地震カードに結べたときはその震源名（`quakeName`。表示する言語へ `place` で訳し、表に無い名前は日本語のまま）、結べなければ電文の座標
 * - 深さは電文にあるときだけ。評価が 5 種のどれとしても読めない報は、評価の句の代わりに情報名で結ぶ
 */
export function internationalTsunamiNotificationBody(x: JMAInternationalTsunami, quakeName: string | undefined, m: SpecialInfoNotificationWords, place: PlaceNameLookup): string {
  const w = m.alertText
  if (x.isCommunicationsTest) return w.communicationsTest
  const ms = x.originTime ? Date.parse(x.originTime) : NaN
  const named = quakeName?.trim()
  const where = (named ? place('epi', named) : '')
    || (x.epicenter ? w.internationalTsunamiCoordinate(x.epicenter.latitude, x.epicenter.longitude, m.formats.coordinate) : '')
  return w.internationalTsunami({
    // その瞬間をそのまま渡し、日本時間で書くのは辞書（端末の時刻として組み直すと、端末の夏時間の切り替わりで 1 時間ずれる）
    when: Number.isFinite(ms) ? new Date(ms) : null,
    where,
    depthKm: x.depthKm ?? null,
    magnitude: x.magnitude !== undefined && Number.isFinite(x.magnitude) ? x.magnitude : null,
    evaluation: x.evaluation ? w.internationalTsunamiEvaluation[x.evaluation] : null,
    name: m.specialInfo.internationalTsunami,
  })
}

/**
 * 国際津波関連情報の通知（2026-11-06 ユーザー選択「津波の通知の設定で出す (Recommended)」）。見出しは情報名、本文は
 * {@link internationalTsunamiNotificationBody}。同じ地震の報は後の報で置き換える（`tag` は発生時刻ごと）。
 * 押したら、その地震のカード（結べた地震カードか、英文だけのカード）を選ぶ。通信試験は開き先を持たない。
 */
export function internationalTsunamiNotification(event: JMAInternationalTsunami, quakeName: string | undefined, m: SpecialInfoNotificationWords, place: PlaceNameLookup): SpecialInfoNotification {
  const body = internationalTsunamiNotificationBody(event, quakeName, m, place)
  const title = m.specialInfo.internationalTsunami
  if (event.isCommunicationsTest || event.originTime === undefined) {
    return { title, body, tag: 'international-tsunami', open: null }
  }
  return {
    title,
    body,
    tag: `international-tsunami-${event.originTime}`,
    open: { tab: 'earthquake', wepa60: event.originTime, lat: event.epicenter?.latitude, lon: event.epicenter?.longitude },
  }
}
