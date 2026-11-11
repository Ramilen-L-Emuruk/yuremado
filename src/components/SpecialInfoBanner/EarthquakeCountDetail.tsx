import type { JMAEarthquakeCount } from '../../types/earthquake'
import { useMessages } from '../../i18n/I18nProvider'

/**
 * 地震回数に関する情報（VXSE60）の帯を開いたときの中身。
 *
 * 他の帯は本文が自由文ひとつきりなので `EarthquakeInfoDetail` にまとめてあるが、こちらは
 * **区間ごとの回数を表で出す**ため別に持つ。
 *
 * **取消しの理由（`cancelText`）は描かない。** `applyEarthquakeCount` は取消が自分の群発に
 * 一致すれば帯ごと消し、一致しなければ表示中の帯をそのまま残す —— どちらの道でも取消の報が
 * ここへ渡ることはない。理由は取消の表示（`CancelBand`・`utils/specialInfoCancelBand.ts`）と読み上げ
 * （`ttsText.ts` の `earthquakeCountToText`）が出す。お知らせ（VZSE40）も同じ構造（→ `docs/spec/data-sources-spec.md` §2）。
 * 防御のつもりで分岐を置くと、次に触る人へ「取消も描ける」という誤った保証を与える
 * （`utils/earthquakeCountSummary.ts` の `earthquakeCountHeadline` と同じ理由）。
 */
const fmt = new Intl.DateTimeFormat('ja-JP', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
})
const fmtTimeOnly = new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' })

/**
 * 区間の期間を「9/10 15:00〜16:00」の形にする。
 *
 * 同じ日に収まる区間では終わりの日付を省く。1 時間区間が縦に並ぶため、毎行に日付を書くと
 * 数字ばかりになって回数のほうが読み取りにくくなる。**日をまたぐ区間では省かない** ——
 * 累積区間は初めの地震から現在までを指すので、何日ぶんの数字かが分からなくなる。
 */
export function formatSpan(startTime: string, endTime: string, unknown: string): string {
  const start = new Date(startTime)
  const end = new Date(endTime)
  const startOk = Number.isFinite(start.getTime())
  const endOk = Number.isFinite(end.getTime())
  // **電文に入っていた文字列はここへ届かない。** 読み取りの時点で捨てて記録に残す作りに
  // なっている（`dmdataParser.ts` の `readTelegramDateTime`）ので、読めない端は空文字で来る。
  // **原因はコンソールの `[dmdata XML] 地震回数の区間の…` を見ること。**
  //
  // **片方だけ読めたら、読めた側を出す**（2026-10-22 ユーザー選択「読めた側を出す (Recommended)」、
  // 形は 2026-10-24 選択「この形でよい (Recommended)」）。相手の端が無いので日付は省かない。
  // 「〜」を読めない端の側に置いて、区間が閉じていないことを見せる。
  if (startOk && !endOk) return `${fmt.format(start)}〜`
  if (!startOk && endOk) return `〜${fmt.format(end)}`
  if (!startOk || !endOk) return unknown
  const sameDay = start.getFullYear() === end.getFullYear()
    && start.getMonth() === end.getMonth()
    && start.getDate() === end.getDate()
  return `${fmt.format(start)}〜${sameDay ? fmtTimeOnly.format(end) : fmt.format(end)}`
}

/** 回数を桁区切りで出す。**発表なし（`null`）は「—」**（開いた表のセルと同じ）。 */
function formatCount(n: number | null): string {
  return n === null ? '—' : n.toLocaleString('ja-JP')
}

export function EarthquakeCountDetail({ count }: { count: JMAEarthquakeCount }) {
  const si = useMessages().specialInfo
  return (
    <div className="px-3 pb-2">
      {/* 回数を伴わない発表報は本文（`Body/Text`）だけを運ぶ。改行は保つ */}
      {count.body && (
        <p className="text-white/90 text-xs leading-relaxed whitespace-pre-wrap mb-2">{count.body}</p>
      )}
      {count.freeText && (
        <p className="text-white/90 text-xs leading-relaxed whitespace-pre-wrap mb-2">{count.freeText}</p>
      )}

      {count.items.length > 0 && (
        // 幅が足りないときは表だけ横に流す（帯ごと横スクロールさせない）
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="text-white/60">
                <th className="text-left font-normal py-0.5 pr-2 whitespace-nowrap">{si.countTable.interval}</th>
                <th className="text-left font-normal py-0.5 pr-2 whitespace-nowrap">{si.countTable.period}</th>
                <th className="text-right font-normal py-0.5 pr-2 whitespace-nowrap">{si.countTable.count}</th>
                {/* 「有感」だけでは何を数えた列か初見で伝わらないので、表の下に一言添える */}
                <th className="text-right font-normal py-0.5 whitespace-nowrap">{si.countTable.felt}</th>
              </tr>
            </thead>
            <tbody>
              {count.items.map((item, i) => (
                <tr
                  // 同じ `type` の区間が並ぶうえ、続報では区間そのものが入れ替わる。位置で
                  // 引くのが素直で、行に状態も持たせていない。
                  key={i}
                  // 累積の行だけ地の色を変えて区切る。電文は「区間ごとの回数」と「初めからの累計」を
                  // 同じ `Item` の並びで送ってくるので、見た目を揃えると 1 時間の 47 回と累計の
                  // 1704 回が同じ重みで並んでしまう。
                  className={`border-t border-white/15 ${item.type.includes('累積') ? 'bg-white/10 font-bold' : ''}`}
                >
                  {/* 電文の語（「１時間地震回数」等）をそのまま出す。言い換えると、
                      気象庁が区間をどう区切ったかが伝わらなくなる */}
                  <td className="py-0.5 pr-2 text-white whitespace-nowrap">{item.type}</td>
                  <td className="py-0.5 pr-2 text-white/70 whitespace-nowrap">
                    {formatSpan(item.startTime, item.endTime, si.countPeriodUnknown)}
                  </td>
                  <td className="py-0.5 pr-2 text-white text-right tabular-nums whitespace-nowrap">
                    {formatCount(item.number)}
                  </td>
                  <td className="py-0.5 text-white text-right tabular-nums whitespace-nowrap">
                    {formatCount(item.feltNumber)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-white/60 text-[0.6875rem] mt-1">{si.countFeltNote}</p>
        </div>
      )}

      {count.nextAdvisory && (
        <p className="text-white/90 text-xs leading-relaxed whitespace-pre-wrap mt-2">{count.nextAdvisory}</p>
      )}
    </div>
  )
}
