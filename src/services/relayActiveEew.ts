/**
 * 中継が繋いだ直後に送る「いま発表中の警報」（`relay-active-eew`。docs/relay-server-design.md §6.1）から、
 * 起動時・張り直しの復元に渡す一覧を組む。
 *
 * 中継は発表中と決めた地震の VXSE43 を第 1 報から最新報まで全部送る（§0）。鍵の経路の復元
 * （`fetchDmdataActiveEewsOutcome` が `/v2/gd/eew` の詳細から組む形）と同じものをここで作る ——
 * 地震ごとに最新の報を 1 通選び、途中の報で特別警報だった印と第 1 報の発表時刻を載せる。
 * 選び方はリプレイの初期状態・鍵の経路と同じ `selectActiveEews` を通す（判定を二重に持たない）。
 */
import type { EEWAlert } from '../types/earthquake'
import { selectActiveEews, computeEverSpecialWarningEventIds, computeFirstIssueTimes, eewEventKey } from '../utils/eew'
import type { DmdataEvent } from './dmdata'

/**
 * @param events 中継の `relay-active-eew` を読んだもの（`DmdataWebSocket.onRelayActiveEew`）
 * @param now この時刻の時点で発表中のものを選ぶ（サーバー時計）
 */
export function activeEewsFromRelay(events: readonly DmdataEvent[], now: Date): EEWAlert[] {
  const reports: EEWAlert[] = []
  for (const ev of events) if (ev.kind === 'eew') reports.push(ev.data)
  if (reports.length === 0) return []
  const firstIssueByEvent = computeFirstIssueTimes(reports)
  const everSpecialByEvent = computeEverSpecialWarningEventIds(reports)
  return selectActiveEews(reports.map(eew => ({ eew, value: eew })), now, 'relay').map((eew) => {
    const key = eewEventKey(eew)
    return {
      ...eew,
      // 拾えなければ null（取消は時刻を言わずに読む。→ `EEWAlert.firstIssueTime`）
      firstIssueTime: firstIssueByEvent.get(key) ?? null,
      ...(everSpecialByEvent.has(key) && { everSpecialWarning: true }),
    }
  })
}
