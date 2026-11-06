// 国際津波関連情報（WEPA60）を受けたときに読み上げる文と、通知の本文。
// 型と電文の形は `types/earthquake.ts` の `JMAInternationalTsunami`。中継のプッシュ通知も同じ文を使う（中継へは写して使う）ので、
// ブラウザにしか無いもの（画面・設定・端末の時間帯）を読まない。
import type { InternationalTsunamiEvaluation, JMAInternationalTsunami } from '../types/earthquake'

export const INTERNATIONAL_TSUNAMI_NAME = '国際津波関連情報'

/**
 * 津波発生の可能性（`EVALUATION`）の読み方。英文の 5 種と 1 対 1（2026-11-06 ユーザー選択「VERY SMALL だけ原文に寄せる」。
 * そのとき示した文面と、ユーザーが書いた「震源付近に被害をもたらす津波の可能性があります」「津波の可能性は非常に小さいです」）。
 * 気象庁の日本語訳は無い（技術情報 第502号・第522号は英文の 5 種を並べるだけ）ので、この訳はアプリが作ったもの。
 * 上の引用は当時の文面で、文末が「あります」「です」だった。いまは文の中で「〈評価〉と発表されました」と結ぶので、
 * 言い切りの形で持つ（2026-11-06 ユーザー選択「と発表されました (Recommended)」）。
 */
export const EVALUATION_SPEECH: Readonly<Record<InternationalTsunamiEvaluation, string>> = {
  oceanWide: '太平洋の広い範囲に被害をもたらす津波の可能性がある',
  regional: '震源から離れた地域まで被害をもたらす津波の可能性がある',
  localNearEpicenter: '震源付近に被害をもたらす津波の可能性がある',
  verySmall: '被害をもたらす津波の可能性は非常に小さい',
  none: '津波の可能性はない',
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000

/** 「25日8時43分」。電文の時刻（UTC）を日本時間で読む。読めなければ null */
function dayTimeJst(iso: string): string | null {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  const d = new Date(ms + JST_OFFSET_MS)
  return `${d.getUTCDate()}日${d.getUTCHours()}時${d.getUTCMinutes()}分`
}

/** 「北緯13.9度、東経120.5度」。南緯・西経は電文どおり言い分ける */
function coordinatePhrase(lat: number, lon: number): string {
  const ns = lat < 0 ? '南緯' : '北緯'
  const ew = lon < 0 ? '西経' : '東経'
  return `${ns}${Math.abs(lat).toFixed(1)}度、${ew}${Math.abs(lon).toFixed(1)}度`
}

/**
 * 名乗りの後ろの本文（「25日8時43分頃、〈震源〉で発生した…の地震について、〈評価〉と発表されました。」）。通知の本文にも使う
 * （2026-11-06 ユーザー選択「通知もそろえる (Recommended)」）。
 *
 * - 〈震源〉は、同じ地震の地震カードに結べたときはその日本語の震源名（`quakeName`）、結べなければ電文の座標を読む
 *   （電文の地名は英語の Flinn-Engdahl 地域名で、日本語の名は電文に無い）。どちらも無ければ震源の句ごと落とす
 * - 深さは電文にあるときだけ（100 km 以深の地震だけ書かれる。気象庁 技術情報 第522号 別紙1（4））
 * - 評価が 5 種のどれとしても読めない報は、評価の句を落として「〜地震について、国際津波関連情報が発表されました」で結ぶ
 *   （原文は画面に出ている）
 * - 通信試験は「国際津波関連情報の通信試験です。」から名乗りを除いた「通信試験です。」
 */
export function internationalTsunamiBody(x: JMAInternationalTsunami, quakeName?: string): string {
  if (x.isCommunicationsTest) return '通信試験です。'
  const when = x.originTime ? dayTimeJst(x.originTime) : null
  const where = quakeName?.trim() || (x.epicenter ? coordinatePhrase(x.epicenter.latitude, x.epicenter.longitude) : '')
  const depth = x.depthKm !== undefined ? `深さ${x.depthKm}キロメートル、` : ''
  const mag = x.magnitude !== undefined && Number.isFinite(x.magnitude) ? `マグニチュード${x.magnitude.toFixed(1)}の` : ''
  // 「25日8時43分頃、〈震源〉で発生した深さ139キロメートル、マグニチュード7.0の地震」。欠けた要素は句ごと落とす
  const subject = `${when ? `${when}頃、` : ''}${where ? `${where}で` : ''}発生した${depth}${mag}地震`
  const evaluation = x.evaluation ? EVALUATION_SPEECH[x.evaluation] : null
  return evaluation
    ? `${subject}について、${evaluation}と発表されました。`
    : `${subject}について、${INTERNATIONAL_TSUNAMI_NAME}が発表されました。`
}

/**
 * 読み上げの文。初報は「国際津波関連情報。」、続報（題名の番号が 2 以上）は「国際津波関連情報が更新されました。」で始める
 * （2026-11-06 ユーザー選択「震源つきで評価まで読む (Recommended)」）。
 */
export function internationalTsunamiToText(x: JMAInternationalTsunami, quakeName?: string): string {
  if (x.isCommunicationsTest) return `${INTERNATIONAL_TSUNAMI_NAME}の通信試験です。`
  const lead = (x.bulletinNumber ?? 1) >= 2 ? `${INTERNATIONAL_TSUNAMI_NAME}が更新されました。` : `${INTERNATIONAL_TSUNAMI_NAME}。`
  return `${lead}${internationalTsunamiBody(x, quakeName)}`
}
