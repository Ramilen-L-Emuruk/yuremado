import type {
  JMAEarthquakeCount, JMAEstimatedIntensity, JMAInternationalTsunami, JMAKohatsu, JMALpgm, JMANankai, JMANankaiCommentary,
  JMAQuakeNotice,
} from '../types/earthquake'
import { earthquakeCountHeadline } from './earthquakeCountSummary'
import {
  earthquakeCountNotification, estimatedIntensityNotification, internationalTsunamiNotification, kohatsuNotification,
  lpgmNotification, nankaiCommentaryNotification, nankaiNotification, quakeNoticeNotification, type SpecialInfoNotification,
} from './specialInfoNotification'

/**
 * 南海トラフ・後発地震・関連解説情報・長周期地震動・推計震度分布図・地震回数・国際津波関連情報・地震・津波に関するお知らせの通知を、**出すかの判定と文面**まで決める。
 * アプリ（画面内の通知）と中継（プッシュ通知）が同じものを使う（docs/relay-server-design.md §6.7）ので、
 * ブラウザにしか無いもの（画面・設定・音）を読まない。設定で止めるか（`notificationAllowed`）と、地域で絞るかは呼び出し側。
 *
 * **取消は、発表を通知した電文にだけ出す**（2026-10-24 ユーザー選択「発表を通知したものだけ (Recommended)」）。
 * そのための記憶は呼び出し側が持つ —— 画面内の通知は「この端末で出した」もの、中継は「送った」ものを覚える。
 */

/** 設定のどの入り切りに従うか（`NotificationKind` のうちこの種類が使うもの） */
export type SpecialInfoKind = 'quake' | 'nankai' | 'nankaiRoutine' | 'quakeNotice' | 'tsunami'

/**
 * 通知を出すかを決める設定の組（種類の入り切りと、臨時解説の「解説情報の音・読み上げ」）。発表を通知したら覚えておき、
 * 取消はこの組に従う（取消の電文が定例か臨時かを運ぶとは限らないため。2026-11-09 ユーザー選択「発表を通知した設定に従う」）。
 * 中継の記憶も同じ形にする
 */
export interface SpecialInfoGate {
  kind: SpecialInfoKind
  commentary?: true
}

export type SpecialInfoEvent =
  | { kind: 'lpgm'; data: JMALpgm }
  | { kind: 'estimatedIntensity'; data: JMAEstimatedIntensity; isNew: boolean }
  | { kind: 'earthquakeCount'; data: JMAEarthquakeCount }
  | { kind: 'nankaiCommentary'; data: JMANankaiCommentary }
  | { kind: 'nankai'; data: JMANankai }
  | { kind: 'kohatsu'; data: JMAKohatsu }
  | { kind: 'quakeNotice'; data: JMAQuakeNotice }
  /**
   * 国際津波関連情報。`quakeName` は同じ地震の地震カードの震源名（結べたときだけ。アプリが地震カードから引く）。
   * 中継は地震カードを持たないので渡さず、本文は電文の座標で震源を言う
   */
  | { kind: 'internationalTsunami'; data: JMAInternationalTsunami; quakeName?: string }

export interface SpecialInfoPlan {
  notification: SpecialInfoNotification
  /** 従う設定の種類 */
  kind: SpecialInfoKind
  /**
   * 地域で絞るときの都道府県（2 桁のコード）。`null` は地域で絞らない（南海トラフ・後発地震・地震回数）。
   * **推計震度分布図も `null` を返す** —— 電文が都道府県を持たず、元の地震の震度の都道府県で絞る（2026-11-03 ユーザー選択
   * 「推計震度は元の地震で絞る」）には地震カードが要る。アプリは呼ぶ側が地震カードから引く（`estimatedIntensityPrefectures`）
   */
  prefectures: readonly string[] | null
  /** 発表の通知。出したら、この鍵を覚える（後の取消の通知のため） */
  remember?: string
  /** 取消の通知。この鍵を覚えているとき（発表を通知していたとき）だけ出す。出したら忘れる */
  requires?: string
  /**
   * 臨時解説の通知。設定「解説情報の音・読み上げ」（`nankaiCommentaryAlerts`）が切れていれば出さない。
   * 定例解説は付けない —— 定例の通知は自分の入り切り（`nankaiRoutine`）だけに従う（2026-11-09 ユーザー選択「新設・既定オフ」）
   */
  commentary?: true
}

/** 取消の通知で地名を言うための、発表で読んだ長周期の震央地名（地震ごと） */
export type LpgmNameLookup = (eventId: string) => string | undefined

/** 通知を出しうるなら、その中身と条件を返す（今はどの種類も返す。`null` は出さない報のための口） */
export function planSpecialInfoNotification(event: SpecialInfoEvent, lpgmName: LpgmNameLookup): SpecialInfoPlan | null {
  switch (event.kind) {
    case 'lpgm': {
      const e = event.data
      const key = `lpgm:${e.eventId}`
      if (e.cancelled) {
        return { notification: lpgmNotification(e, lpgmName(e.eventId) ?? ''), kind: 'quake', prefectures: null, requires: key }
      }
      // 長周期地震動は電文に都道府県ごとの階級を持つので、その県で絞る（2026-11-03 の問いの説明「長周期地震動は電文に
      // 都道府県ごとの階級があるので、その県で絞る」）
      const prefectures = (e.prefs ?? []).map(p => p.code).filter(c => /^\d{2}$/.test(c))
      // 都道府県を 1 つも読めなかった報は、絞れないので絞らない（空のまま渡すと、地域を選んだ人には届かなくなる）
      return { notification: lpgmNotification(e, ''), kind: 'quake', prefectures: prefectures.length > 0 ? prefectures : null, remember: key }
    }
    case 'estimatedIntensity':
      return { notification: estimatedIntensityNotification(event.data, event.isNew), kind: 'quake', prefectures: null }
    case 'earthquakeCount': {
      const e = event.data
      const key = `earthquakeCount:${e.eventId}`
      if (e.cancelled) return { notification: earthquakeCountNotification(e, ''), kind: 'quake', prefectures: null, requires: key }
      return { notification: earthquakeCountNotification(e, earthquakeCountHeadline(e)), kind: 'quake', prefectures: null, remember: key }
    }
    case 'nankaiCommentary': {
      const e = event.data
      const key = `nankaiCommentary:${e.id}`
      // 定例解説は設定「定例の解説情報の通知」（既定は切）に従う（2026-11-09 ユーザー選択「新設・既定オフ」）。
      // 臨時解説は「南海トラフ・後発地震の通知」と「解説情報の音・読み上げ」に従う（2026-10-24 ユーザー選択「出す (Recommended)」）。
      // 定例は名称かコード（定例解説は 200）で見分け、それ以外は臨時の設定に従う（控えの全期間の 92 通は、どれも名称とコードが
      // 定例解説 200 か臨時解説 210・219 だった）。取消は発表を通知した設定に従う（呼び出し側が覚えた `SpecialInfoGate`）ので、
      // ここで取消に付ける設定は使われない。発表を通知したものにだけ出すのはどちらも同じ
      const routine = e.serialName === '定例解説' || e.serialCode === '200'
      const gate = routine ? { kind: 'nankaiRoutine' as const } : { kind: 'nankai' as const, commentary: true as const }
      if (e.cancelled) return { notification: nankaiCommentaryNotification(e), ...gate, prefectures: null, requires: key }
      return { notification: nankaiCommentaryNotification(e), ...gate, prefectures: null, remember: key }
    }
    case 'quakeNotice': {
      // 地震・津波に関するお知らせ。設定「お知らせの通知」（既定は切）に従い、地域では絞らない（2026-11-09 ユーザー選択「新設・既定オフ」）。
      // 取消は発表を通知したものにだけ出す（他の種類と同じ。2026-10-24 ユーザー選択「発表を通知したものだけ (Recommended)」）
      const e = event.data
      // 鍵は `EventID`。id は電文の作成時刻まで含み、取消の電文とは一致しない（帯の取消も `EventID` で照合する
      // → `applyQuakeNotice`）
      const key = `quakeNotice:${e.eventId}`
      if (e.cancelled) return { notification: quakeNoticeNotification(e), kind: 'quakeNotice', prefectures: null, requires: key }
      return { notification: quakeNoticeNotification(e), kind: 'quakeNotice', prefectures: null, remember: key }
    }
    case 'nankai':
      return { notification: nankaiNotification(event.data), kind: 'nankai', prefectures: null }
    case 'kohatsu':
      return { notification: kohatsuNotification(event.data), kind: 'nankai', prefectures: null }
    case 'internationalTsunami':
      // 津波の通知の設定に従い、地域では絞らない（2026-11-06 ユーザー選択「津波の通知の設定で出す (Recommended)」。説明は
      // 「通知する地域では絞らない（国外の地震で県が無いため。南海トラフと同じ扱い）」）。通信試験も出す（同日の選択
      // 「遠地地震の音・試験も伝える (Recommended)」）
      return { notification: internationalTsunamiNotification(event.data, event.quakeName), kind: 'tsunami', prefectures: null }
  }
}
