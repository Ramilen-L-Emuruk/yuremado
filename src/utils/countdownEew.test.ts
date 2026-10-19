// 地図の下端の波形の P/S 線を引く相手（地震ごと）と、公開観測点を選ぶ材料（1 件）の選び方を固定する。

import { describe, expect, it } from 'vitest'

import type { PsWaveCircle } from '../services/kyoshin'
import type { EEWAlert } from '../types/earthquake'
import { pickArrivalEews, pickPublicWaveEew } from './countdownEew'

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

describe('pickPublicWaveEew', () => {
  const at = (id: string, originTime: string, eventId = id) =>
    ({ id, issue: { eventId }, earthquake: { originTime } }) as unknown as EEWAlert

  // 正: 予報円が引けるなら、S 波の波面がいちばん外側にある円の速報を使う（新しい速報があっても）。
  it('予報円があれば S 波の半径がいちばん大きい速報を使う', () => {
    const a = at('a', '2026-10-15T10:00:00+09:00')
    const b = at('b', '2026-10-15T10:05:00+09:00')
    expect(pickPublicWaveEew([circle('b', 10), circle('a', 40)], [a, b])?.id).toBe('a')
  })

  // 正: 予報円を描かない速報（仮定震源要素・深さ不明）だけのときも、発生のいちばん新しいものを材料にする。
  it('予報円が無ければ発生のいちばん新しい速報を使う', () => {
    expect(pickPublicWaveEew([], [at('old', '2026-10-15T10:00:00+09:00'), at('new', '2026-10-15T10:05:00+09:00')])?.id).toBe('new')
  })

  // 安全弁: いちばん大きい円の速報が一覧から消えていたら、新しさで選ぶ側へ倒す（別の円へ黙って移らない）。
  it('円の速報を引き当てられなければ発生のいちばん新しい速報を使う', () => {
    const got = pickPublicWaveEew([circle('gone', 40)], [at('old', '2026-10-15T10:00:00+09:00'), at('new', '2026-10-15T10:05:00+09:00')])
    expect(got?.id).toBe('new')
  })

  it('発生時刻の無い強震検知報は発現時刻で新しさを比べる', () => {
    const old = at('old', '2026-10-15T10:00:00+09:00')
    const newest = { ...at('strong', ''), strongShakingOnly: true, earthquake: { originTime: '', arrivalTime: '2026-10-15T10:05:00+09:00' } } as unknown as EEWAlert
    expect(pickPublicWaveEew([], [old, newest])?.id).toBe('strong')
    // 発生時刻があれば発現時刻より優先し、読めない報で有効な時刻を押し退けない。
    const earlier = { ...newest, earthquake: { originTime: '2026-10-15T09:59:00+09:00', arrivalTime: '2026-10-15T10:06:00+09:00' } } as unknown as EEWAlert
    expect(pickPublicWaveEew([], [earlier, old, at('unknown', '')])?.id).toBe('old')
  })

  it('速報が無ければ null', () => {
    expect(pickPublicWaveEew([], [])).toBeNull()
  })
})
