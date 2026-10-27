// 自作地震計（`seismo-host/`）の観測点の震度を、地図の右上へ重ねる。
//
// **観測点 1 つにつき 1 行の帯。** 周りに並ぶもの（更新時刻・取得状況）がどれも 1 行なので、
// ここだけ段を積むと浮く。見出し（「自作地震計」）は置かず、**観測点名が
// 気象庁の発表でないことを示す**（「自宅」のような名前は電文には現れない）。
//
// **押せない**（`pointer-events-none`）。地図のレイヤーは作らず、座標も使わない。
// 重ね位置（absolute・z-index・セーフエリア）と左上の列との並べ方は App.tsx 側の地図の上の隅が持つ。

import type { SeismoStationState } from '../../hooks/useSeismoStation'
import { readableTextColor } from '../../utils/contrast'

import { seismoOverlayRows } from './seismoOverlayRows'

interface Props {
  readonly stations: readonly SeismoStationState[]
}

/** 帯 1 本ぶんの見た目。**周りの帯（`MapUpdateTime` ほか）と揃える。** */
const ROW_CLASS =
  'bg-black/80 rounded-sm text-sm px-2 py-0.5 roomy:text-xl roomy:px-2.5 roomy:py-1' +
  ' pointer-events-none flex items-center gap-1.5 roomy:gap-2 max-w-full'

/** 震度バッジ。**行の高さを変えない**よう `leading-none` で詰める。 */
const BADGE_CLASS = 'font-bold leading-none rounded-sm px-1.5 py-1 min-w-5 text-center shrink-0'

export function SeismoOverlay({ stations }: Props) {
  const rows = seismoOverlayRows(stations)
  // **行が 1 つも無ければ出さない**（震度が 1 件も届いておらず、猶予を過ぎた「未着」も無い）。接続の状態では判定しない ——
  // 短い切断なら状態層が 5 秒は値を保つので消えず、長い切断なら消える。
  // ここで別に接続を見ると、同じ事実に判定が 2 つできる。
  //
  // 空の帯を常駐させないのも同じ理由。「揺れていない」と「繋がっていない」が
  // 見分けられなくなる —— **繋がっていないことは地図の左上が受け持つ**
  // （`components/SeismoLinkStatus.tsx`）。あちらの待ちもこの帯と同じ 5 秒だが、
  // **黙って切れた繋ぎでは最大 45 秒遅れる**（理由はあちらの `GRACE_MS`）。
  if (rows.length === 0) return null

  return (
    <>
      {rows.map((row) => {
        // **値が途絶えたことは色だけで示す。文言は 1 つも足さない。**
        // 隣に並ぶ更新時刻の帯（`components/MapUpdateTime.tsx`）が、更新が止まったときに
        // 文面を変えず `text-red-400` へ替えるのと同じ作法 —— 枠の見た目（`bg-black/80` の
        // 丸角）もあちらと揃えてあるので、表現を分けると同じ「止まっている」が 2 通りの
        // 見え方になる。
        const tone = row.silent ? 'text-red-400' : 'text-white'
        return (
          <div key={row.stationId} className={ROW_CLASS}>
            {row.gradeLabel !== null && row.gradeColor !== null ? (
              <span
                className={BADGE_CLASS}
                style={{ background: row.gradeColor, color: readableTextColor(row.gradeColor) }}
              >
                {row.gradeLabel}
              </span>
            ) : (
              <span
                className={`${BADGE_CLASS} bg-neutral-700 ${row.silent ? 'text-red-400' : 'text-secondary'}`}
              >
                —
              </span>
            )}
            {/* **観測点名だけ幅を切る。** 名前は利用者が管理コンソールで自由に付けるので長くなりうる。
                上限で切るうえ、左上の列と横に並べたとき幅が足りなければさらに縮む（`min-w-0`。
                並べ方は App.tsx の地図の上の隅）。震度・値・名乗りは縮めない。 */}
            <span className={`${tone} truncate min-w-0 max-w-32 roomy:max-w-56`}>
              {row.displayName}
            </span>
            <span className={`font-mono ${tone} tabular-nums shrink-0`}>{row.valueText ?? '—'}</span>
            {/* 合成と途絶は名乗りが空（→ seismoOverlayRows.ts）。空のときは要素ごと置かない ——
                空の要素でも `gap` の幅だけ右に隙間が残る。未着だけ「未着」を行と同じ赤で出す。 */}
            {row.sourceText !== '' && (
              <span className={`text-xs roomy:text-base shrink-0 ${row.silent ? 'text-red-400' : 'text-secondary'}`}>{row.sourceText}</span>
            )}
          </div>
        )
      })}
    </>
  )
}
