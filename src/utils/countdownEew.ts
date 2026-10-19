// 発表中の緊急地震速報のうち、**「この端末の場所へ何が来るか」を語る相手**を選ぶ。
//
// 使うのは 2 箇所 ——地図の下端の波形（自作地震計・公開観測点）へ引く P/S の到達線（`components/SeismoWaveChart`）と、
// 下端に出す公開観測点を選ぶ材料（`hooks/usePublicWaves.ts`）。
//
// **P/S 線は地震ごとに引く**（2026-10-14 ユーザー決定「地震ごとに並べて出す」）。予報円のある速報をすべて相手にし、
// どの地震の線かは見分けない —— どれも「P」「S」（2026-10-18 ユーザー承認「見分けない」）。登録地点への到達の
// カウントダウンも地震ごとに行を並べる（`hooks/useSWaveCountdown.ts`）ので、選び方を共有する必要は無くなった。
//
// **公開観測点も地震ごとに選んで合わせる**（2026-10-19 ユーザー承認「地震ごとに選んで合わせる (推奨)」）。
// ここでは材料にする速報を、番号を振る順に並べるだけ。

import type { PsWaveCircle } from '../services/kyoshin'
import type { EEWAlert } from '../types/earthquake'
import { compareEewNewestFirst, eewEventKey } from './eew'

/**
 * 予報円を描いている速報（＝P/S 線を引ける速報）。**順は予報円の順**で、1 つも無ければ空。
 *
 * 予報円は `usePsWaveCalc` の時点で、取消済み・位置不明・仮定震源要素・深さ不明・まだ発生していない
 * ものを外してある（`computeEewCircle`）。ここではそれ以上は絞らない。円の `eventId` は
 * `eew.issue?.eventId ?? eew.id`（`computeEewCircle`）なので、同じ式（`eewEventKey`）で引く。
 * **引き当てられない円は飛ばす**（円を作った速報が一覧から消えた —— 別の速報を代わりに使わない）。
 */
export function pickArrivalEews(psWave: readonly PsWaveCircle[], eews: readonly EEWAlert[]): EEWAlert[] {
  const out: EEWAlert[] = []
  for (const circle of psWave) {
    const eew = eews.find((e) => eewEventKey(e) === circle.eventId)
    if (eew !== undefined && !out.includes(eew)) out.push(eew)
  }
  return out
}

/**
 * 下部の波形に出す公開観測点を選ぶ材料にする緊急地震速報（`hooks/usePublicWaves.ts`）。**発表中の速報をすべて返し、
 * 並びは観測点に番号を振る順**（2026-10-19 ユーザー承認「地震ごとに選んで合わせる (推奨)」）。
 *
 * - **予報円を描いている速報が先で、S 波の波面が外側にあるものから**（円の半径の大きい順）
 * - **予報円を描かない速報**（仮定震源要素・深さ不明・まだ発生していない・円の速報が一覧から消えた）**はその後ろで、
 *   地震の発生（無ければ発現）が新しいものから**。そうした報でも観測点を選ぶと決めてあるため
 *   （`docs/public-waveform-design.md` §0「震源の要素が欠けるとき」）
 *
 * `eews` は取消を外したもの（`App.tsx` の `eewsForMap`）。速報が無ければ空。
 */
export function pickPublicWaveEews(psWave: readonly PsWaveCircle[], eews: readonly EEWAlert[]): EEWAlert[] {
  const withCircle: { eew: EEWAlert; sRadius: number }[] = []
  for (const c of psWave) {
    const eew = eews.find((e) => eewEventKey(e) === c.eventId)
    if (eew === undefined || withCircle.some((w) => w.eew === eew)) continue
    withCircle.push({ eew, sRadius: c.sRadius })
  }
  withCircle.sort((a, b) => b.sRadius - a.sRadius)
  const rest = eews.filter((e) => !withCircle.some((w) => w.eew === e)).sort(compareEewNewestFirst)
  return [...withCircle.map((w) => w.eew), ...rest]
}
