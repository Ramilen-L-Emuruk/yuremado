// 発表中の緊急地震速報のうち、**「この端末の場所へ何が来るか」を語る相手**を選ぶ。
//
// 使うのは 2 箇所 ——地図の下端の波形（自作地震計・公開観測点）へ引く P/S の到達線（`components/SeismoWaveChart`）と、
// 下端に出す公開観測点を選ぶ材料（`hooks/usePublicWaves.ts`）。
//
// **P/S 線は地震ごとに引く**（2026-10-14 ユーザー決定「地震ごとに並べて出す」）。予報円のある速報をすべて相手にし、
// どの地震の線かは見分けない —— どれも「P」「S」（2026-10-18 ユーザー承認「見分けない」）。登録地点への到達の
// カウントダウンも地震ごとに行を並べる（`hooks/useSWaveCountdown.ts`）ので、選び方を共有する必要は無くなった。
//
// **公開観測点を選ぶ材料は今も 1 件**（S 波の円がいちばん大きい速報）。観測点の選び方を地震ごとに広げるかは
// 決めていない。

import type { PsWaveCircle } from '../services/kyoshin'
import type { EEWAlert } from '../types/earthquake'
import { eewEventKey, eewSortTimeMs } from './eew'

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
 * 下部の波形に出す公開観測点を選ぶ材料にする緊急地震速報（`hooks/usePublicWaves.ts`）。
 *
 * **予報円が引けるなら、S 波の波面がいちばん外側にある円の速報を使う**（P/S 線は地震ごとに引くが、観測点を選ぶ材料は 1 件のまま。
 * 地震ごとに選ぶかは未決 —— `docs/spec/data-sources-spec.md` §4.6）。
 * 予報円を描かない速報 ——仮定震源要素・深さ不明——だけが出ているときは、**発表中のうち地震の発生
 * （無ければ発現）がいちばん新しいものを使う**。そうした報でも観測点を選ぶと決めてあるため
 * （`docs/public-waveform-design.md` §0「震源の要素が欠けるとき」）。
 * `eews` は取消を外したもの（`App.tsx` の `eewsForMap`）。
 */
export function pickPublicWaveEew(psWave: readonly PsWaveCircle[], eews: readonly EEWAlert[]): EEWAlert | null {
  if (psWave.length > 0) {
    const widest = psWave.reduce((best, c) => (c.sRadius > best.sRadius ? c : best), psWave[0])
    const eew = eews.find((e) => eewEventKey(e) === widest.eventId)
    if (eew !== undefined) return eew
  }
  let best: EEWAlert | null = null
  let bestMs = -Infinity
  for (const e of eews) {
    const key = eewSortTimeMs(e)
    if (best === null || key > bestMs) {
      best = e
      bestMs = key
    }
  }
  return best
}
