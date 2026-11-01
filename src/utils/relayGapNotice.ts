import type { RelayListGap } from '../services/relayListGaps'
import { formatHourMinute } from './formatters'

/**
 * 中継が見ていない区間の帯（地震タブ。docs/relay-server-design.md §0 の「見ていない時間があった日」の行）の文。
 *
 * 1 区間に 1 行。突き合わせが済んで区間が帳面から消えれば、行も消える（→ `services/relayListGaps.ts`）。
 *
 * 文面は 2026-10-31 ユーザー選択「「…の電文が欠けている可能性（照合中）」 (Recommended)」。区分ごとに
 * 何の電文かを名前で言う —— 警報だけの区分（`eew.warning`）は「緊急地震速報（警報）」、地震・津波の区分は
 * 「地震・津波の電文」。知らない区分は「電文」とだけ言う（黙って捨てると、見ていない時間が「見た」に化ける）。
 */
export function formatRelayGapNotices(gaps: readonly RelayListGap[]): string[] {
  return gaps.map(g => `${formatGapRange(g.fromMs, g.toMs)} の${gapSubject(g.classification)}が欠けている可能性（照合中）`)
}

function gapSubject(classification: string): string {
  switch (classification) {
    case 'telegram.earthquake':
      return '地震・津波の電文'
    case 'eew.warning':
      return '緊急地震速報（警報）'
    default:
      return '電文'
  }
}

/** 「10/31 3:12〜3:40」。日をまたぐなら終わりにも日付を付ける（「10/31 23:50〜11/1 0:20」） */
function formatGapRange(fromMs: number, toMs: number): string {
  const from = new Date(fromMs)
  const to = new Date(toMs)
  const sameDay = from.getFullYear() === to.getFullYear() && from.getMonth() === to.getMonth() && from.getDate() === to.getDate()
  return `${monthDay(from)} ${formatHourMinute(from)}〜${sameDay ? '' : `${monthDay(to)} `}${formatHourMinute(to)}`
}

function monthDay(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}`
}

