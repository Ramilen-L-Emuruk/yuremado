import type { JMAEarthquakeCount, JMAEarthquakeCountItem } from '../types/earthquake'

/**
 * 地震回数に関する情報（VXSE60）のうち、**畳んだ帯の見出しと読み上げで伝える 1 区間**を選ぶ。
 *
 * **見出し（`EarthquakeCountDetail.tsx` の `earthquakeCountHeadline`）と読み上げ（`ttsText.ts` の
 * `earthquakeCountToText`）は必ずこの関数を通すこと。** 別々に選ぶと、画面と声で違う区間の数字を
 * 伝える。
 *
 * 選ぶ順（2026-10-19 ユーザー承認「-1 を「発表なし」に (推奨)」の範囲で決めた順）:
 * 1. 「累積」を含む区間（初めからの累計。全体像を表す）
 * 2. 無ければ「地震回数」の区間
 * 3. それも無ければ「１時間地震回数」のうち終了時刻が最も遅いもの（最新の 1 時間）
 *
 * **判定は `type` の語で行う。** 並び順（最後が累積）は電文の書き方にすぎず、`type` のほうが
 * 電文自身の宣言。
 *
 * @returns 選んだ区間。どれも無ければ `undefined`（区間を持たない報・未知の `type` だけの報）
 */
export function pickEarthquakeCountSummaryItem(count: JMAEarthquakeCount): JMAEarthquakeCountItem | undefined {
  const cumulative = count.items.find(it => it.type.includes('累積'))
  if (cumulative) return cumulative
  const whole = count.items.find(it => it.type === '地震回数')
  if (whole) return whole
  let latestHour: JMAEarthquakeCountItem | undefined
  let latestKey = -Infinity
  for (const it of count.items) {
    if (it.type !== '１時間地震回数') continue
    // 終了時刻が読めない区間はいちばん古い扱いにする（読める区間があればそちらが勝つ）。
    // 同じ値どうしは文書順で後ろのものを採る（電文は古い区間から並べる）。
    const end = new Date(it.endTime).getTime()
    const key = Number.isFinite(end) ? end : -Infinity
    if (latestHour === undefined || key >= latestKey) {
      latestHour = it
      latestKey = key
    }
  }
  return latestHour
}
