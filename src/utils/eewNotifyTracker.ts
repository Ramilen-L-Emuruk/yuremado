// 緊急地震速報の「報を採るか」と「通知を出すか」の判定（純関数）。アプリの入口（`hooks/useEarthquakes.ts` の `handleEvent`）と
// 受け手（`hooks/useLiveEventHandler.ts`）が使い、中継のプッシュ通知も同じものを写して使う（docs/relay-server-design.md §6.7。
// 2026-11-03 ユーザー選択「判定をすべて共用する (Recommended)」）。
//
// 記憶（受け付けの台帳・統合した最新の報・区分・通知の基準・消えた地震）は呼び出し側が持ち、ここは引数で受けて決定を返す。
// アプリは React の ref に、中継は SQL に持つ。どちらもこの決定どおりに記憶を書き換える。

import type { EEWAlert } from '../types/earthquake'
import { OPEN_REALTIME, type NotificationOpen } from './notificationOpen'
import { hasMagnitude } from './formatters'
import {
  type EewAcceptance, type EndedEew, type EndedEewMatch, type EewNotifiedForecast,
  ACTIVE_EEW_WINDOW_MS, acceptEewReport, calcEEWCancelTime, computeDisplayEEWLevel, computeSingleEEWLevel,
  eewCancelNotificationBody, eewIssueTimeMs, eewKindText, eewNotificationBody, eewNotifiedForecast, eewStaleness,
  endedEewMatch, isLateEewCancel, isSameReportFromOtherOrigin, mergeEewReport, noteEewNotified, raisesEewAlert,
  raisesNotifiedForecast, supplementEewReport,
} from './eew'
import type { Messages } from '../i18n/messages'

/**
 * 報の自動解除の時刻を、その報自身から求めたもの（`calcEEWCancelTime` に発表時刻を渡す）。発表時刻が読めない報・
 * 時刻を決められない報は null（弾かない側へ倒す。理由は {@link decideEewReportEntry} の `expired`）
 */
export function eewReportCancelMs(eew: EEWAlert): { issueMs: number; cancelMs: number } | null {
  const issueMs = eewIssueTimeMs(eew)
  if (issueMs === null) return null
  const cancelMs = calcEEWCancelTime(eew, new Date(issueMs)).getTime()
  return Number.isFinite(cancelMs) ? { issueMs, cancelMs } : null
}

/** 入口で報（取消・自動解除・テストではないもの）を採るかの決定 */
export type EewReportEntry =
  /** 取消で終えた地震へ届いた報。取消は終端（docs/spec/eew-spec.md §10） */
  | { readonly kind: 'cancelledTerminal' }
  /** 画面から消えた地震の報（{@link endedEewMatch}） */
  | { readonly kind: 'ended'; readonly match: EndedEewMatch; readonly ended: EndedEew }
  /** その報自身の自動解除の時刻を過ぎた報 */
  | { readonly kind: 'expired'; readonly issueMs: number; readonly cancelMs: number }
  /**
   * 自動解除の時刻を過ぎて見えるが、時計を信じられないので採った。採ったあとの扱いは `accept` 系と同じで、
   * 呼び出し側が記録を残すための印（`then` が本当の決定）
   */
  | { readonly kind: 'expiredUntrusted'; readonly issueMs: number; readonly cancelMs: number; readonly then: EewReportTaken }
  | EewReportTaken

/**
 * 入口が報を採った（または捨てた）ときの、受け付けの記憶の扱い。`expired` 系より後の判定。
 * 捨てる報（`stale`）は記憶を変えない。第 1 報の時刻を覚えるのは呼び出し側の役目（`rememberEewFirstIssueTime`）
 */
export type EewReportTaken =
  /** 同じ経路の中で古い報。捨てる */
  | { readonly kind: 'stale' }
  /**
   * 別の経路がもっと新しい報を先に運んだあとに届いた電文の報。捨てずに、電文しか運ばない欄だけを補う（{@link supplementEewReport}）。
   * 新しい報ではないので、区分や予想の最大震度が上がったときだけ知らせる（`sameReport` が偽）
   */
  | { readonly kind: 'supplement'; readonly merged: EEWAlert; readonly sameReport: boolean; readonly acceptance: EewAcceptance }
  /** 新しい報。統合した値と、別の経路から受けた同じ報か */
  | { readonly kind: 'accept'; readonly merged: EEWAlert; readonly sameReport: boolean; readonly acceptance: EewAcceptance }

/**
 * 入口で報を採るか。アプリの入口と中継のプッシュ通知が同じ順で判定する。
 *
 * 1. 表示中の報が取り消し済みなら捨てる（取消は終端）
 * 2. 受け付けの記憶も表示中の報も無ければ、消えた地震の報か（{@link endedEewMatch}）、自動解除の時刻を過ぎた報かを見る。
 *    後者は **時計を信じられないときは採る**（未較正の端末は壁時計がずれている）。**静かに積む報（起動時の復元・リプレイの初期状態）は
 *    時刻で落とさない**（古さは取得側が判定している）
 * 3. 受け付けの記憶と比べる（{@link eewStaleness}）
 *
 * @param o.previous 統合した最新の報（アプリは入口の写しか、なければ状態の値）
 * @param o.checkExpired 自動解除の時刻で落とす判定を使うか（アプリは静かに積む報でないとき真。中継は常に真）
 * @param o.clockTrusted 時計を信じられるか（アプリは `isServerClockTrusted`。中継は真）
 */
export function decideEewReportEntry(o: {
  readonly incoming: EEWAlert
  readonly acceptance: EewAcceptance | undefined
  readonly previous: EEWAlert | undefined
  readonly ended: EndedEew | undefined
  readonly nowMs: number
  readonly checkExpired: boolean
  readonly clockTrusted: boolean
}): EewReportEntry {
  const { incoming, acceptance, previous } = o
  if (previous?.cancelled || previous?.cancelledAt) return { kind: 'cancelledTerminal' }
  if (!acceptance && !previous) {
    const match = endedEewMatch(o.ended, incoming, o.nowMs, ACTIVE_EEW_WINDOW_MS)
    if (match !== null && o.ended) return { kind: 'ended', match, ended: o.ended }
    if (o.checkExpired) {
      const times = eewReportCancelMs(incoming)
      if (times && times.cancelMs <= o.nowMs) {
        if (o.clockTrusted) return { kind: 'expired', ...times }
        return { kind: 'expiredUntrusted', ...times, then: takeEewReport(incoming, acceptance, previous) }
      }
    }
  }
  return takeEewReport(incoming, acceptance, previous)
}

function takeEewReport(incoming: EEWAlert, acceptance: EewAcceptance | undefined, previous: EEWAlert | undefined): EewReportTaken {
  const staleness = eewStaleness(acceptance, incoming)
  if (staleness === 'olderFromOtherOrigin' && incoming.origin === 'dmdata' && previous) {
    const merged = supplementEewReport(previous, incoming)
    return { kind: 'supplement', merged, sameReport: !raisesEewAlert(merged, previous), acceptance: acceptEewReport(acceptance, incoming) }
  }
  if (staleness !== 'fresh') return { kind: 'stale' }
  const merged = mergeEewReport(previous, incoming)
  // **区分や予想の最大震度が上がった報は「同じ報」として黙らせない**（上がったこと自体を知らせる）。
  // 同じ秒に別の報が出ることがある（能登本震の実配信で 46 報中 13 報）ので、秒だけでは「同じ報」と言い切れない
  const sameReport = previous !== undefined
    && isSameReportFromOtherOrigin(acceptance, incoming)
    && !raisesEewAlert(merged, previous)
  const accepted = acceptEewReport(acceptance, incoming)
  return { kind: 'accept', merged, sameReport, acceptance: sameReport ? accepted : noteEewNotified(accepted, incoming) }
}

/**
 * 画面から消えた地震の記憶を作る。**前に消えたときの記憶があれば、経路ごとの報番号と発表時刻は大きいほうを残す** ——
 * 台帳は消えた時点で捨てるので、載り直した地震の台帳は載り直した後の報しか数えていない。上書きすると記憶が縮み、
 * 前に消えたときの報を取り直しが返したとき通してしまう。取消で終えた印も、一度立てば落とさない（取消は終端）。
 */
export function mergeEndedEew(
  previous: EndedEew | undefined, acceptance: EewAcceptance, cancelled: boolean, nowMs: number,
  lastReport: EEWAlert, firstIssueTime: string | null | undefined,
): EndedEew {
  const serialBySeries = new Map(previous?.serialBySeries)
  for (const [series, serial] of acceptance.serialBySeries) {
    serialBySeries.set(series, Math.max(serial, serialBySeries.get(series) ?? serial))
  }
  const issues = [previous?.latestIssueMs, acceptance.latestIssueMs].filter((v): v is number => typeof v === 'number')
  return {
    serialBySeries,
    latestIssueMs: issues.length > 0 ? Math.max(...issues) : null,
    endedAtMs: nowMs,
    cancelled: cancelled || (previous?.cancelled ?? false),
    lastReport,
    // 第 1 報の時刻は一度覚えたら変えない（前に消えたときの記憶が先）
    firstIssueTime: previous?.firstIssueTime !== undefined ? previous.firstIssueTime : firstIssueTime,
  }
}

/**
 * 自動解除（最終報の解除の時刻が来た）で地震を終えたときの、消えた地震の記憶。表示中の報と受け付けの記憶があり、
 * 取消で終えていない地震だけが対象（null は記憶を変えない）
 */
export function endEewOnExpiry(o: {
  readonly ended: EndedEew | undefined
  readonly shown: EEWAlert | undefined
  readonly acceptance: EewAcceptance | undefined
  readonly nowMs: number
  readonly firstIssueTime: string | null | undefined
}): EndedEew | null {
  const { shown, acceptance } = o
  if (!shown || !acceptance || shown.cancelled || shown.cancelledAt) return null
  const { cancelledAt: _cancelledAt, ...lastReport } = shown
  return mergeEndedEew(o.ended, acceptance, false, o.nowMs, lastReport, o.firstIssueTime)
}

/**
 * 誤報取消を入口で受けたときの、消えた地震の記憶の扱い。消えた後に届いた取消なら、記憶に取消を載せる
 * （載せないと、その後に届いた新しい報番号の報が「続いている速報」として通る）。そのうち、**最後の報があり窓の内なら
 * 普通の誤報取消と同じく伝える**（`late`。2026-10-21 ユーザー承認「直す (Recommended)」）。同じ取消が別の経路から
 * 遅れて届いても、記憶に取消が載っているので 2 度は伝えない。
 *
 * @param o.gone 地震が画面に出ていない（または自動解除の途中）か
 * @param o.latest 入口の写し（統合した最新の報）。あれば消えた地震ではない
 */
export function decideEewCancelEntry(o: {
  readonly incoming: EEWAlert
  readonly ended: EndedEew | undefined
  readonly latest: EEWAlert | undefined
  readonly gone: boolean
  readonly nowMs: number
}): { readonly ended: EndedEew; readonly late: EndedEew & { readonly lastReport: EEWAlert } | null } | null {
  const { ended } = o
  if (!ended || ended.cancelled || o.latest || !o.gone) return null
  const late = isLateEewCancel(ended, o.incoming, o.nowMs, ACTIVE_EEW_WINDOW_MS) ? ended : null
  return { ended: { ...ended, cancelled: true }, late }
}

/** 受け手が地震ごとに持つ、発表の通知の記憶 */
export interface EewAnnounceMemory {
  /** これまでの区分（最大）。無ければその地震はまだ受けていない（新規の発表） */
  readonly level: 0 | 1 | 2 | undefined
  /** 通知に出した予想の基準（上げるだけ）。無ければまだ基準が無い */
  readonly baseline: EewNotifiedForecast | undefined
}

/** 受け手が報を受けたときの決定（通知を出すかの材料と、書き換えた後の記憶） */
export interface EewAnnounceStep {
  readonly isNew: boolean
  /** 区分が上がった（予報→警報・警報→特別警報） */
  readonly levelUpgraded: boolean
  /** 予報→警報の格上げ（区分そのものが変わる） */
  readonly severityUpgraded: boolean
  /** その報そのものの区分 */
  readonly currentLevel: 0 | 1 | 2
  readonly prevLevel: 0 | 1 | 2
  /** 通知に出した予想より上がった（同じ通知を出し直す。2026-10-21 ユーザー承認「直す (Recommended)」） */
  readonly forecastRaised: boolean
  /** 通知に出す予想 */
  readonly forecast: EewNotifiedForecast
  /** 書き換えた後の記憶（区分も基準も必ず埋まる） */
  readonly memory: { readonly level: 0 | 1 | 2; readonly baseline: EewNotifiedForecast }
}

/**
 * 受け手が報（取消でない）を受けたときの区分と予想の追跡。新規か・区分の格上げか・通知に出した予想より上がったかを決め、
 * 記憶を書き換えた後の値を返す。別の経路から受けた同じ報（`sameReport`）は値が上がっていないことが入口で決まっている。
 */
export function stepEewAnnounce(event: EEWAlert, sameReport: boolean, memory: EewAnnounceMemory): EewAnnounceStep {
  const currentLevel = computeSingleEEWLevel(event)
  const isNew = memory.level === undefined
  const prevLevel = memory.level ?? 0
  const levelUpgraded = !isNew && currentLevel > prevLevel
  const severityUpgraded = !isNew && currentLevel >= 1 && prevLevel < 1
  const level = (isNew ? currentLevel : Math.max(prevLevel, currentLevel)) as 0 | 1 | 2
  const forecast = eewNotifiedForecast(event)
  const forecastRaised = !sameReport && raisesNotifiedForecast(forecast, memory.baseline)
  // 基準は上げるだけ（下がった続報で下げると、戻ったときに同じ予想で出し直す）
  const baseline = !memory.baseline || raisesNotifiedForecast(forecast, memory.baseline) ? forecast : memory.baseline
  return {
    isNew, levelUpgraded, severityUpgraded, currentLevel, prevLevel, forecastRaised, forecast,
    memory: { level, baseline },
  }
}

/** 通知 1 件の題・本文・tag。アプリの画面内の通知とプッシュ通知が同じ tag で 1 つにまとまる（§0） */
export interface EewNotice {
  readonly title: string
  readonly body: string
  readonly tag: string
  /** 押したときに開く先（リアルタイムタブ。取消も同じ） */
  readonly open: NotificationOpen
}

/**
 * 発表・続報の通知。**見出しは表示用の区分で決める**（特別警報の下げ止まり。→ eew-spec.md §4）。一度でも特別警報だった地震は、
 * 続報で震度が下がってから長周期の予想が上がる・格上げが立つなどで出し直しても「特別警報」のまま。
 * 予報級の電文は VXSE45「緊急地震速報（地震動予報）」なので、見出しも「地震動予報」
 */
export function eewAnnounceNotice(key: string, event: EEWAlert, forecast: EewNotifiedForecast, m: Pick<Messages, 'alertText' | 'formats'>): EewNotice {
  const level = computeDisplayEEWLevel(event)
  const w = m.alertText
  const kind = level === 2 ? w.eewSpecialWarningTitle : level === 1 ? w.eewWarningTitle : eewKindText(0, m)
  return {
    // 最終報は見出しに添え、本文に規模を足す（2026-11-09 ユーザー選択「規模と最終報を足し、変わったら静かに差し替え (Recommended)」）
    title: event.isFinal ? w.eewFinal(kind) : kind,
    body: eewNotificationBody(event.earthquake.hypocenter.name, forecast, eewNoticeMagnitude(event), m),
    tag: `eew-${key}`,
    open: OPEN_REALTIME,
  }
}

/**
 * 通知の本文に添える規模（例「M6.3」）。仮定震源要素の報（規模を推定していない）と、規模の読めない報では添えない
 * （画面の速報カードが規模を出さない報と同じ。→ `RealtimeTab` の `isAssumed`・`hasMagnitude`）
 */
function eewNoticeMagnitude(event: EEWAlert): string {
  const { magnitude } = event.earthquake.hypocenter
  if (event.earthquake.condition === '仮定震源要素' || !hasMagnitude(magnitude)) return ''
  return `M${magnitude.toFixed(1)}`
}

/**
 * 発表・続報で通知を出さなかった報のうち、**本文か見出しが前に出した通知から変わった報**の通知（鳴らさずに同じ札で
 * 差し替える。2026-11-09 ユーザー選択「規模と最終報を足し、変わったら静かに差し替え (Recommended)」）。前に通知していない
 * 地震・字面の変わらない報は null
 */
export function eewQuietReplaceNotice(notice: EewNotice, lastShown: Pick<EewNotice, 'title' | 'body'> | undefined): EewNotice | null {
  if (!lastShown) return null
  return lastShown.title === notice.title && lastShown.body === notice.body ? null : notice
}

/** 誤報取消の通知。名前は取消の報・覚えた震央地名・消えた地震の最後の報の順に引いたもの（無ければ名前抜きの文） */
export function eewCancelNotice(key: string, name: string | undefined, m: Pick<Messages, 'alertText'>): EewNotice {
  return { title: m.alertText.eewCancelTitle, body: eewCancelNotificationBody(name, m), tag: `eew-cancel-${key}`, open: OPEN_REALTIME }
}
