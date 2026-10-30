import type { JMALpgm } from '../../types/earthquake'
import { lpgmQuakeFactParts } from '../../utils/lpgm'
import { formatCoordinate, formatNameFromMark } from '../../utils/formatters'
import type { QuakeCardMarks } from '../../utils/quakeUpdateMark'
import { UpdateDot } from '../UpdateDot'

/**
 * 地震カードの長周期の欄に、長周期地震動観測情報が持つ震源・規模・全国の最大震度・地震発現時刻を出す
 * （2026-10-29 ユーザー承認「長周期の欄にも出す」、形は同日「1行・名前と深さ (Recommended)」）。
 *
 * **同じ地震の値は地震カード本体も出している。** それでも長周期の欄に置くのは、この欄の階級と
 * 震度が「どの震源・規模の地震についての観測か」を電文自身の値で読めるようにするため。
 * 並びと書き方は {@link lpgmQuakeFactParts} が決める。
 *
 * **震源決定機関は地震カードと同じ文で別の行に出す**（2026-10-29 ユーザー承認「含める (Recommended)」）。
 * 気象庁以外が震源を決めたときだけ電文に入る（→ `LpgmHypocenter.source`）。
 *
 * **更新の印は地震カードと同じく値の肩の点**（2026-10-29 ユーザー承認「地震カードと同じく付ける」）。
 * 印は長周期の報どうしの差分で付く（→ `lpgmFactSnapshot`）。地震発現時刻は印を持たない。
 *
 * **震央補助表現と震源の座標も、地震カードと同じ文・同じ並びで別の行に出す**（2026-10-30 ユーザー承認・L5。
 * 読み上げには入れない）。並びは地震カードと同じ「補助表現 → 震源決定機関 → 座標」。
 */
export function LpgmQuakeFacts({ lpgm, marks }: { lpgm: JMALpgm; marks: QuakeCardMarks | undefined }) {
  const parts = lpgmQuakeFactParts(lpgm)
  const h = lpgm.hypocenter
  const source = h?.source
  const nameFromMark = h?.nameFromMark
  const hasLocation = h?.latitude !== undefined && h.longitude !== undefined
    && Number.isFinite(h.latitude) && Number.isFinite(h.longitude)
  if (parts.length === 0 && !source && !nameFromMark && !hasLocation) return null
  const dot = (field: 'nameFromMark' | 'coordinate') => {
    const status = marks?.facts.get(field)
    return status && <UpdateDot status={status} size="sm" className="align-top ml-0.5" />
  }
  return (
    <div className="text-secondary" style={{ fontSize: '0.75rem', lineHeight: 1.5 }}>
      {parts.length > 0 && (
        <div className="flex flex-wrap gap-x-2">
          {parts.map((p, i) => {
            const status = p.field ? marks?.facts.get(p.field) : undefined
            return (
              <span key={i} className="whitespace-nowrap">
                {p.text}
                {status && <UpdateDot status={status} size="sm" className="align-top ml-0.5" />}
              </span>
            )
          })}
        </div>
      )}
      {nameFromMark && <div>{formatNameFromMark(nameFromMark)}{dot('nameFromMark')}</div>}
      {source && <div>震源決定: {source}（気象庁以外）</div>}
      {hasLocation && <div>{formatCoordinate(h.latitude!, h.longitude!)}{dot('coordinate')}</div>}
    </div>
  )
}
