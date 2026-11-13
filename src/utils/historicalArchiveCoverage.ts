import type { HistoricalArchiveMeta } from '../types/historicalArchive'
import type { Messages } from '../i18n/messages'

// 設定の窓「収録済みの地震」のホバーに出す、収録した期間の書き方。

/** 期間を書く区切りの語（辞書の `formats` の節が満たす形）。範囲の記号と並べる区切りは言語ごと */
export type ArchiveCoverageWords = Pick<Messages['formats'], 'range' | 'rangeSpaced' | 'listSep'>

/** 日本時間の年・月・日（集めた範囲は日本時間の日で区切ってあるため、端末のタイムゾーンで読まない）。 */
function jstYmd(ms: number): { y: number; m: number; d: number } {
  const jst = new Date(ms + 9 * 60 * 60 * 1000)
  return { y: jst.getUTCFullYear(), m: jst.getUTCMonth() + 1, d: jst.getUTCDate() }
}

/** 集めた範囲 1 つを「2018/9/6〜9/7」の形で書く（終わりは半開区間なので 1 ミリ秒手前の日）。年が変わるときは終わりにも年を書く。 */
function formatDayRange(fromIso: string, toIso: string, w: ArchiveCoverageWords): string {
  const s = jstYmd(new Date(fromIso).getTime())
  const e = jstYmd(new Date(toIso).getTime() - 1)
  const head = `${s.y}/${s.m}/${s.d}`
  if (s.y === e.y && s.m === e.m && s.d === e.d) return head
  return w.range(head, s.y === e.y ? `${e.m}/${e.d}` : `${e.y}/${e.m}/${e.d}`)
}

/**
 * 収録した期間。**途切れなく集めたアーカイブは従来どおり始まりと終わりの日時**を、日を選んで集めたアーカイブは
 * 集めた日を並べる（例「2018/9/6〜9/7、2018/10/5〜10/6、2019/2/21〜2/22」。2026-10-22 ユーザー選択
 * 「止めて理由を出す (Recommended)」）。始まりと終わりだけを書くと、間の集めていない月まで収録しているように読める。
 */
export function formatArchiveCoverage(meta: HistoricalArchiveMeta, w: ArchiveCoverageWords): string {
  if (meta.coveredRanges.length <= 1) {
    return w.rangeSpaced(new Date(meta.from).toLocaleString('ja-JP'), new Date(meta.to).toLocaleString('ja-JP'))
  }
  return meta.coveredRanges.map((r) => formatDayRange(r.from, r.to, w)).join(w.listSep)
}
