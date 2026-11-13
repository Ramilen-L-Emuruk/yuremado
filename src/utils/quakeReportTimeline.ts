import type { JMAQuake } from '../types/earthquake'
import { readDateTime } from './formatters'
import type { Messages } from '../i18n/messages'

/**
 * 開いた地震カードの「更新 ▾」で開く報の一覧（見本 opened.html の .rlist）。
 *
 * **時刻は各報の発表時刻（`Head/ReportDateTime`）だけを分まで出す。作成時刻は出さない**
 * （→ docs/quake-tab-redesign.md。2026-11-02 選択「発表時刻だけ（分まで）」。全期間 20,993 通で、
 * 通常の報の発表時刻の秒はすべて 00）。地震情報の報はカードに当てた電文（{@link JMAQuake.sourceTelegrams}）の
 * `issue.time` から、長周期地震動・国際津波関連情報・推計震度分布図・借りた津波の電文は、それぞれの報が
 * 持つ発表時刻をそのまま渡してもらう。
 */
export interface QuakeTimelineEntry {
  /** 一覧に出す名前（例「震源・震度情報 #2」）。 */
  label: string
  /** 発表時刻（ミリ秒）。読めなければ null（一覧の末尾へ回す）。 */
  ms: number | null
}

/**
 * 報の一覧を発表時刻の古い順に組む。
 *
 * **地震情報の報は、見出しの記録（`reports`）ではなく当てた電文の控えから並べる。** 見出しは
 * 震源・震度情報が届くと震度速報・震源情報を呑み込む（→ `utils/quakeMerge.ts` の `normalizeReports`）
 * ので、そちらから組むと受け取った速報段階の報が一覧から消える。控えを持たないカード
 * （統合を通っていないもの）は、カード自身を 1 報として並べる。
 *
 * 番号は種別ごとに、電文が名乗った最大の報番号（`reportSerial`）から逆に振る —— 途中から
 * 受信した端末でも、最後の報の番号は電文どおりになる。番号が 1 しかない種別には付けない
 * （閉じた行・見出しと同じ書き方）。読めない時刻の記録は `readDateTime` が残す。
 */
export function quakeReportTimeline(
  quake: Pick<JMAQuake, 'issue' | 'reportSerial' | 'sourceTelegrams'>,
  extra: readonly { label: string; time: string }[] = [],
): QuakeTimelineEntry[] {
  const telegrams = quake.sourceTelegrams ?? [quake]
  const labels = quakeTelegramLabels(telegrams)
  const out: QuakeTimelineEntry[] = []
  for (const t of telegrams) out.push({ label: labels.get(t) ?? t.issue.type, ms: msOf(t.issue.time) })
  for (const e of extra) out.push({ label: e.label, ms: msOf(e.time) })
  return sortTimeline(out)
}

/**
 * 地震情報の報それぞれに一覧の名前を付ける（例「震源・震度情報 #2」）。番号の振り方は {@link quakeReportTimeline} の注記。
 * 報の時点のカードを組む側（`utils/quakeReportHistory.ts`）も同じ名前を使う。
 */
export function quakeTelegramLabels(
  telegrams: readonly Pick<JMAQuake, 'issue' | 'reportSerial'>[],
): Map<Pick<JMAQuake, 'issue' | 'reportSerial'>, string> {
  const byType = new Map<string, Pick<JMAQuake, 'issue' | 'reportSerial'>[]>()
  for (const t of telegrams) {
    const list = byType.get(t.issue.type)
    if (list) list.push(t)
    else byType.set(t.issue.type, [t])
  }
  const labels = new Map<Pick<JMAQuake, 'issue' | 'reportSerial'>, string>()
  for (const [type, list] of byType) {
    const n = list.length
    const named = list.map(t => t.reportSerial).filter((s): s is number => s !== undefined)
    const last = named.length > 0 ? Math.max(...named) : n
    list.forEach((t, idx) => {
      const no = last - (n - 1 - idx)
      labels.set(t, last > 1 && no >= 1 ? `${type} #${no}` : type)
    })
  }
  return labels
}

/**
 * 発表時刻の古い順に並べる。読めない時刻は末尾、同じ時刻は渡した順のまま（安定）。
 * 報の時点のカードを組む側（`utils/quakeReportHistory.ts`）も同じ並びを使う —— 押した行より上の報で組むので、
 * 並びが違うと「上にある報」と「当てた報」が食い違う。
 */
export function sortTimeline<T extends { ms: number | null }>(entries: readonly T[]): T[] {
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      if (a.e.ms === null && b.e.ms === null) return a.i - b.i
      if (a.e.ms === null) return 1
      if (b.e.ms === null) return -1
      return a.e.ms - b.e.ms || a.i - b.i
    })
    .map(x => x.e)
}

export function msOf(time: string): number | null {
  const d = readDateTime('quakeReportTimeline', time)
  return d ? d.getTime() : null
}

/** 一覧と「更新」の時刻の書き方（見本の「1日 16:12」。ほかの言語は辞書の `dayTime` の形）。 */
export function formatTimelineTime(ms: number, w: Pick<Messages['formats'], 'dayTime'>): string {
  return w.dayTime(new Date(ms))
}
