/**
 * 長周期地震動に関する観測情報（VXSE62）の取消を、届く順番によらず効かせる。
 *
 * 地震情報には取消の台帳（`quakeMerge.ts` の `QuakeRetraction`）があるのに、長周期には無かった。
 * ライブは取消で地震ごとの 1 通（`lpgmByEventId`）を消すが、起動時の履歴と「もっと見る」は取消を
 * 飛ばして残りの最新を入れるだけだったので、**ライブで消えた長周期の表示がリロードで戻っていた**
 * （棚卸し F16。電文解説資料 別紙ウ 1. の取消は全種別に共通。控えに長周期の取消の標本は無い）。
 *
 * 取消は「その時点までに発表した報を取り下げる」意味なので、取消より前に発表された同じ地震の報は
 * 後から届いても採らない。取消より後に発表された報（発表し直した報）は採る。前後の比べ方は
 * 地震情報と同じ `compareReportAge`（作成時刻があれば秒まで、同じなら取消を尊重する）。
 */
import type { JMALpgm } from '../types/earthquake'
import { compareReportAge, reportOrderKey } from './quakeMerge'
import { log } from './logger'

/** 長周期の取消を見た事実。 */
export interface LpgmRetraction {
  eventId: string
  /** 取消電文の発表時刻。 */
  time: string
  /** 取消電文の作成時刻（`Control/DateTime`）のミリ秒。 */
  createdAtMs?: number
}

/** 台帳の上限。地震情報の台帳（`MAX_QUAKE_RETRACTIONS`）と同じ 20 件。 */
export const MAX_LPGM_RETRACTIONS = 20

/** 取消電文から台帳の 1 件を作る。 */
export function lpgmRetractionOf(cancel: JMALpgm): LpgmRetraction {
  return {
    eventId: cancel.eventId,
    time: cancel.time,
    ...(cancel.createdAtMs !== undefined && { createdAtMs: cancel.createdAtMs }),
  }
}

/**
 * 台帳へ足す。**同じ取消は二度積まない**（ライブと履歴の重なり・「もっと見る」の読み直しで
 * 同じ取消が何度も届く。重複を許すと上限が同じ取消で埋まる。→ `addQuakeRetraction`）。
 */
export function addLpgmRetraction(list: LpgmRetraction[], r: LpgmRetraction, max: number): void {
  // 地震を指せない取消は台帳に積まない（どの報にも当たらず、上限の枠だけを食う）
  if (!r.eventId || !r.time) {
    log.warn(`[lpgm] 地震を指せない取消を台帳へ積まなかった (eventId=${r.eventId || '(空)'} time=${r.time || '(空)'})`)
    return
  }
  if (list.some(k => k.eventId === r.eventId && k.time === r.time && k.createdAtMs === r.createdAtMs)) return
  list.push(r)
  if (list.length > max) {
    const dropped = list.splice(0, list.length - max)
    log.warn(`[lpgm] 取消の台帳が上限を超えたので古い ${dropped.length} 件を捨てた (上限=${max}): ${dropped.map(d => d.eventId).join(', ')}`)
  }
}

/**
 * この報が取り下げ済みか（同じ地震の取消より前に発表された報か）。
 * 発表時刻が空の報は取り下げ側へ倒す（`isRetractedQuakeReport` と同じ）。
 */
export function isRetractedLpgm(retractions: readonly LpgmRetraction[], lpgm: JMALpgm): boolean {
  return retractions.some(r =>
    r.eventId === lpgm.eventId
    // 取消の側の時刻が空でも取り下げ側へ倒す（台帳には積まないので、ここへ来るのはライブの 1 通だけ）
    && (!lpgm.time || !r.time || compareReportAge(lpgm, { time: r.time, createdAtMs: r.createdAtMs }) <= 0)
  )
}

/**
 * ライブで届いた 1 通を地震ごとの 1 通へ当てる（新しい Map を返す）。
 *
 * 取消は**その取消より前に発表された報だけを消す**（履歴の畳み込みと同じ規則。取消より後に
 * 発表し直された報が先に届いていれば残す）。取り下げ済みの報の判定（`isRetractedLpgm`）は
 * 呼び出し側が台帳で先に済ませておく。
 */
export function applyLiveLpgm(base: ReadonlyMap<string, JMALpgm>, lpgm: JMALpgm): Map<string, JMALpgm> {
  const next = new Map(base)
  if (lpgm.cancelled) {
    const existing = next.get(lpgm.eventId)
    if (existing && isRetractedLpgm([lpgmRetractionOf(lpgm)], existing)) next.delete(lpgm.eventId)
  } else {
    next.set(lpgm.eventId, lpgm)
  }
  return next
}

/**
 * 履歴に入っていた取消を台帳へ積む。**畳み込み（`foldLpgmHistory`）より先に呼ぶ** ——
 * 取消を先に全部積んでから当てれば、1 回の中で取消が報より前に並んでいても後ろに並んでいても、
 * 取り下げる範囲は「取消より前に発表された報」で決まり、並びには依らない。
 *
 * 畳み込みと分けてあるのは、台帳への書き込みを状態更新の関数の外で行うため（React は更新の関数を
 * 2 度呼ぶことがある）。
 */
export function recordLpgmRetractions(events: readonly JMALpgm[], retractions: LpgmRetraction[]): void {
  for (const lpgm of events) {
    if (lpgm.cancelled) addLpgmRetraction(retractions, lpgmRetractionOf(lpgm), MAX_LPGM_RETRACTIONS)
  }
}

/**
 * 履歴の長周期を地震ごとの 1 通へ畳む。`base` は既に持っている分（「もっと見る」では画面の値）。
 * **台帳は読むだけ**（ライブと共有する台帳へ履歴の取消を残すのは `recordLpgmRetractions` の役目）。
 * `events` の中の取消は、台帳に積まれていなくてもこの畳み込みの中では効かせる。
 *
 * - 取り下げ済みの報（台帳か `events` の取消に当たる報）は、`base` にあっても履歴から来ても採らない
 * - 同じ地震の報は新しい方を残す（`compareReportAge`）
 */
export function foldLpgmHistory(
  base: ReadonlyMap<string, JMALpgm>,
  events: readonly JMALpgm[],
  ledger: readonly LpgmRetraction[],
): Map<string, JMALpgm> {
  // 地震を指せない取消（eventId・発表時刻が空）は台帳と同じく使わない。使うと、取消より後に
  // 発表し直された報まで履歴の畳み込みだけで落ち、ライブとリロードで結果がずれる
  const retractions = [...ledger, ...events.filter(e => e.cancelled && e.eventId && e.time).map(lpgmRetractionOf)]
  const result = new Map(base)
  const ordered = [...events].sort((a, b) => {
    const at = reportOrderKey(a)
    const bt = reportOrderKey(b)
    return at === bt ? 0 : at - bt
  })
  for (const [eventId, lpgm] of result) {
    if (isRetractedLpgm(retractions, lpgm)) result.delete(eventId)
  }
  for (const lpgm of ordered) {
    if (lpgm.cancelled || isRetractedLpgm(retractions, lpgm)) continue
    const existing = result.get(lpgm.eventId)
    if (!existing || compareReportAge(lpgm, existing) > 0) result.set(lpgm.eventId, lpgm)
  }
  return result
}
