// 地図の下端の波形の P/S 線を引く相手と、公開観測点を選ぶ材料の選び方を固定する（どちらも地震ごと）。

import { describe, expect, it } from 'vitest'

import type { PsWaveCircle } from '../services/kyoshin'
import type { EEWAlert } from '../types/earthquake'
import { pickArrivalEews, pickPublicWaveEews } from './countdownEew'

function circle(eventId: string, sRadius: number): PsWaveCircle {
  return { eventId, lat: 37, lng: 137, pRadius: sRadius * 1.7, sRadius, depth: 10, magnitude: 6 }
}

/** 引き当てに使う欄だけを持つ速報。 */
function eew(id: string, eventId?: string): EEWAlert {
  return { id, issue: eventId === undefined ? undefined : { eventId } } as unknown as EEWAlert
}

describe('pickArrivalEews', () => {
  // 正（2026-10-14 ユーザー決定「地震ごとに並べて出す」）: 予報円のある速報はすべて線の相手にする。
  // 以前は S 波の円がいちばん大きい 1 件だけで、近い別の地震の線が引かれなかった。
  it('予報円のある速報をすべて返す', () => {
    const eews = [eew('t1', '20260101000000'), eew('t2', '20260101000100')]
    const got = pickArrivalEews([circle('20260101000000', 10), circle('20260101000100', 40)], eews)
    expect(got.map((e) => e.id)).toEqual(['t1', 't2'])
  })

  // 対照: 予報円の無い速報（仮定震源要素・深さ不明など）は線の相手にしない。
  it('予報円の無い速報は含めない', () => {
    const eews = [eew('t1', '20260101000000'), eew('t2', '20260101000100')]
    expect(pickArrivalEews([circle('20260101000100', 40)], eews).map((e) => e.id)).toEqual(['t2'])
  })

  // 対照: `issue` が無ければ id で引く（`computeEewCircle` と同じ式）。
  it('issue が無ければ id で引く', () => {
    expect(pickArrivalEews([circle('t9', 30)], [eew('t9')]).map((e) => e.id)).toEqual(['t9'])
  })

  // 安全弁: 引き当てられない円（円を作った速報が一覧から消えた）は飛ばす。別の速報を代わりに返さない。
  it('引き当てられない円は飛ばす', () => {
    expect(pickArrivalEews([circle('gone', 30)], [eew('t1', 'other')])).toEqual([])
  })
})

describe('pickPublicWaveEews', () => {
  const at = (id: string, originTime: string, eventId = id) =>
    ({ id, issue: { eventId }, earthquake: { originTime } }) as unknown as EEWAlert
  const ids = (list: EEWAlert[]) => list.map((e) => e.id)

  // 正（2026-10-19 ユーザー承認「地震ごとに選んで合わせる (推奨)」）: 発表中の速報をすべて返す。以前は S 波の円が
  // いちばん大きい 1 件だけで、円の小さい別の地震に近い観測点は、大きいほうの速報が終わるまで出なかった。
  it('予報円のある速報をすべて、S 波の半径の大きい順に返す', () => {
    const a = at('a', '2026-10-15T10:00:00+09:00')
    const b = at('b', '2026-10-15T10:05:00+09:00')
    expect(ids(pickPublicWaveEews([circle('b', 10), circle('a', 40)], [a, b]))).toEqual(['a', 'b'])
  })

  // 正: 予報円を描かない速報（仮定震源要素・深さ不明）も材料にし、円のある速報の後ろへ新しい順に並べる。
  it('予報円の無い速報は円のある速報の後ろへ、発生の新しい順に並べる', () => {
    const withCircle = at('c', '2026-10-15T09:00:00+09:00')
    const old = at('old', '2026-10-15T10:00:00+09:00')
    const newer = at('new', '2026-10-15T10:05:00+09:00')
    expect(ids(pickPublicWaveEews([circle('c', 20)], [old, withCircle, newer]))).toEqual(['c', 'new', 'old'])
  })

  // 安全弁: 円を作った速報が一覧から消えていたら、その円は飛ばす（別の速報を円の順へ黙って入れない）。
  it('引き当てられない円は飛ばし、残りは新しさで並べる', () => {
    const got = pickPublicWaveEews([circle('gone', 40)], [at('old', '2026-10-15T10:00:00+09:00'), at('new', '2026-10-15T10:05:00+09:00')])
    expect(ids(got)).toEqual(['new', 'old'])
  })

  it('発生時刻の無い強震検知報は発現時刻で新しさを比べ、時刻の読めない報は後ろへ', () => {
    const old = at('old', '2026-10-15T10:00:00+09:00')
    const strong = { ...at('strong', ''), strongShakingOnly: true, earthquake: { originTime: '', arrivalTime: '2026-10-15T10:05:00+09:00' } } as unknown as EEWAlert
    expect(ids(pickPublicWaveEews([], [at('unknown', ''), old, strong]))).toEqual(['strong', 'old', 'unknown'])
  })

  it('速報が無ければ空', () => {
    expect(pickPublicWaveEews([], [])).toEqual([])
  })
})
