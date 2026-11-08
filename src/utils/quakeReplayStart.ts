// 地震カードの再生ボタンで、その地震をどの時刻から再生するかを決める。
//
// **地震の 30 秒前から始める**（2026-11-08 ユーザー発言「地震の30秒前が良い。60は長すぎると思う。」）。
// 「地震」は発生時刻のこと。ただしカードが電文から持つ発生時刻は分までしか無い（秒は 00。→ `quakeOriginSeconds.ts`）ので、
// 起点は次の順に採る（2026-11-08 ユーザー選択「起こりうる最も早い時刻の30秒前 (Recommended)」）。
//
//   1. **秒まで決まった発生時刻**（緊急地震速報の発生時刻か気象庁の震源リスト。→ `hooks/useQuakeOriginSeconds.ts`）
//   2. 決まらなければ、**発生が入りうる最も早い時刻**（`earliestOriginMs`）。揺れ始めを取りこぼさない代わりに、
//      本当の発生までの待ちは 30 秒より長くなる（最長で 1 分半ほど）
//
// **国内の震度・震源の報を 1 つも持たないカード（遠地地震・国際津波関連情報だけのカード）は、最初の報の 30 秒前から始める**
// （2026-11-08 ユーザー選択「最初の報の30秒前から (Recommended)」）。発生から最初の報までの間は国内に揺れも報も無く、
// 発生の 30 秒前から始めるとカードが出るまで何も起きない時間が続くため。

import type { IssueType, JMAQuake } from '../types/earthquake'
import { earliestOriginMs, parseJstTimeMs, telegramOriginMinuteMs, type OriginSeconds } from './quakeOriginSeconds'

/** 起点より前に置く余白 (ms)。 */
export const QUAKE_REPLAY_LEAD_MS = 30_000

/** 国内で揺れを観測した地震だけに出る報の種別。これを 1 つでも持てば「地震の 30 秒前」から始める。 */
const DOMESTIC_REPORT_TYPES: ReadonlySet<IssueType> = new Set<IssueType>([
  '震度速報', '震源情報', '震源・震度情報', '各地の震度情報', '顕著な地震の震源要素更新のお知らせ',
])

/**
 * 国内の震度・震源の報を 1 つでも持つカードか。持たなければ再生は最初の報の 30 秒前から始める。
 *
 * 受け取った種別の記録（`reports`）を見る。記録を持たないカード（統合前の 1 通など）は、最後の報の種別（`issue.type`）で見る。
 * 国際津波関連情報だけのカードは種別が「遠地地震」なので、国内の報を持たない側に入る（→ `utils/internationalTsunami.ts`）。
 */
export function hasDomesticQuakeReport(quake: Pick<JMAQuake, 'reports' | 'issue'>): boolean {
  const types = quake.reports !== undefined && quake.reports.length > 0
    ? quake.reports.map((r) => r.type)
    : [quake.issue.type]
  return types.some((t) => DOMESTIC_REPORT_TYPES.has(t))
}

/**
 * その地震の再生を始める時刻（エポックミリ秒）。**起点が 1 つも読めなければ `NaN`**（呼び出し側は再生しない・ボタンを出さない）。
 *
 * @param originSeconds 秒まで決まった発生時刻。決まっていなければ `undefined`
 * @param firstReportMs カードの最初の報の発表時刻（報の一覧の最も早い時刻）。国内の報を持たないカードで使う。読めなければ `null`
 */
export function quakeReplayStartMs(
  quake: Pick<JMAQuake, 'earthquake' | 'reports' | 'issue'>,
  originSeconds: OriginSeconds | undefined,
  firstReportMs: number | null,
): number {
  if (!hasDomesticQuakeReport(quake)) {
    return firstReportMs !== null && Number.isFinite(firstReportMs) ? firstReportMs - QUAKE_REPLAY_LEAD_MS : Number.NaN
  }
  const base = originSeconds !== undefined && Number.isFinite(originSeconds.originMs)
    ? originSeconds.originMs
    : earliestOriginMs(parseJstTimeMs(quake.earthquake.time), telegramOriginMinuteMs(quake))
  return Number.isFinite(base) ? base - QUAKE_REPLAY_LEAD_MS : Number.NaN
}
