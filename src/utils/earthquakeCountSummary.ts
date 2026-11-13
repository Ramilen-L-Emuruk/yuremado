import type { JMAEarthquakeCount, JMAEarthquakeCountItem } from '../types/earthquake'

/**
 * 地震回数に関する情報（VXSE60）のうち、**畳んだ帯の見出しと読み上げで伝える 1 区間**を選ぶ。
 *
 * **見出し（{@link earthquakeCountHeadlineText}）と読み上げ（`ttsText.ts` の
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

/**
 * 畳んだ帯に出す一行。
 *
 * **電文の見出し（`Head/Headline/Text`）は使わない** —— 「地震回数に関する情報をお知らせします。」
 * という中身の無い定型文で、畳んだままでは何も伝わらない。区間の数字から組む。
 *
 * **どの区間の数字を出すかは読み上げと同じ関数で選ぶ**（`pickEarthquakeCountSummaryItem`。
 * 累積 → 地震回数 → 最新の１時間地震回数）。選べなければ種別名だけを返す。
 *
 * **気象庁が発表しない値（電文の `-1`。型では `null`）は句ごと出さない**
 * （2026-10-19 ユーザー承認「-1 を「発表なし」に (推奨)」）。回数だけが無ければ
 * 「8/24 15時から 有感 1回」、有感だけが無ければ「8/24 15時から 5回」、両方無ければ種別名。
 *
 * **取消の分岐は持たない。** 取消が自分の群発に一致すれば `applyEarthquakeCount` が帯ごと消し、
 * 一致しなければ表示中の帯はそのまま残る —— どちらの道でも取消の報がここへ渡ることはない。
 * 防御のつもりで分岐を置くと、次に触る人へ「取消も描ける」という誤った保証を与える。
 *
 * 語は辞書（`specialInfo`）から渡す。帯・ウィンドウの題名・通知はいまの言語の辞書、中継のプッシュ通知は日本語の辞書を渡す。
 */
export function earthquakeCountHeadlineText(count: JMAEarthquakeCount, w: EarthquakeCountHeadlineWords): string {
  const total = pickEarthquakeCountSummaryItem(count)
  if (!total) return w.countHeadlineNone
  const { number, feltNumber } = total
  if (number === null && feltNumber === null) return w.countHeadlineNone
  // 日本時間で読む。端末の時間帯で読むと、中継（UTC で動く）が送るプッシュ通知と画面の帯で時刻がずれる
  const start = new Date(new Date(total.startTime).getTime() + 9 * 60 * 60 * 1000)
  const since = Number.isFinite(start.getTime())
    ? { monthDay: `${start.getUTCMonth() + 1}/${start.getUTCDate()}`, hour: String(start.getUTCHours()).padStart(2, '0') }
    : null
  return w.countHeadline(since, number === null ? null : formatCount(number), feltNumber === null ? null : formatCount(feltNumber))
}

/** 見出しの語（辞書の `specialInfo` の一部）。 */
export interface EarthquakeCountHeadlineWords {
  /** `since` は区間の初め（日本時間の「月/日」と時）、`count`・`felt` は桁を区切った回数（発表なしは null。両方 null では呼ばない） */
  countHeadline: (since: { monthDay: string; hour: string } | null, count: string | null, felt: string | null) => string
  countHeadlineNone: string
}

/** 回数を桁区切りで出す。**発表なし（`null`）は「—」**（開いた表のセルと同じ）。 */
function formatCount(n: number | null): string {
  return n === null ? '—' : n.toLocaleString('ja-JP')
}
