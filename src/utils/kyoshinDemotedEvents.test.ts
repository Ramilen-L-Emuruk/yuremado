import { describe, it, expect } from 'vitest'
import { createDemotedEventsState, stepDemotedEvents, DEMOTED_CARD_MS } from './kyoshinDemotedEvents'
import { initGates, type DetectionEvent } from './kyoshinDetector'

function ev(id: string, confidence: DetectionEvent['confidence'], soloStale = false, memberKeys: string[] = [id]): DetectionEvent {
  return {
    id, confidence, memberKeys, maxIntensity: 1, cells: [], originTimeMs: 0, lastOnsetAtMs: 0,
    lastSize: 1, epicenter: null, confirmStreak: 0, everConfirmed: true, firstConfirmedAtMs: 0,
    everMultiPoint: false, isolated: false, isolatedStuckKeys: [], isolatedSilentKeys: [],
    lastSpreadAtMs: 0, everNeighborRise: true, gates: { ...initGates(), soloStale }, confirmedBy: null,
  }
}

const T = 1_000_000

describe('stepDemotedEvents', () => {
  it('正: 降ろした検知は DEMOTED_CARD_MS の間だけ返す', () => {
    const s = createDemotedEventsState()
    expect(stepDemotedEvents(s, [ev('a', 'weak', true)], T).map((e) => e.id)).toEqual(['a'])
    expect(stepDemotedEvents(s, [ev('a', 'weak', true)], T + DEMOTED_CARD_MS)).toHaveLength(1)
    expect(stepDemotedEvents(s, [ev('a', 'weak', true)], T + DEMOTED_CARD_MS + 1000)).toHaveLength(0)
  })

  it('正: エンジンから消えても、期間中は最後の姿のまま返す', () => {
    const s = createDemotedEventsState()
    stepDemotedEvents(s, [ev('a', 'weak', true)], T)
    expect(stepDemotedEvents(s, [], T + 3000).map((e) => e.id)).toEqual(['a'])
  })

  it('対照: 降ろした印の無い weak（確定していないまま弱まったもの）は返さない', () => {
    const s = createDemotedEventsState()
    expect(stepDemotedEvents(s, [ev('a', 'weak', false)], T)).toHaveLength(0)
  })

  it('対照: 確定へ戻ったら外す（通常のカードが担う）', () => {
    const s = createDemotedEventsState()
    stepDemotedEvents(s, [ev('a', 'weak', true)], T)
    expect(stepDemotedEvents(s, [ev('a', 'confirmed')], T + 1000)).toHaveLength(0)
  })

  it('対照: 降ろした印が消えた weak（別の理由で弱まった）になったら外す', () => {
    const s = createDemotedEventsState()
    stepDemotedEvents(s, [ev('a', 'weak', true)], T)
    expect(stepDemotedEvents(s, [ev('a', 'weak', false)], T + 1000)).toHaveLength(0)
  })

  it('対照: 同じ観測点を持つ検知が別の ID で出ていれば外す（併合・立ち上がり直し）', () => {
    const s = createDemotedEventsState()
    stepDemotedEvents(s, [ev('a', 'weak', true, ['k1'])], T)
    expect(stepDemotedEvents(s, [ev('b', 'confirmed', false, ['k1', 'k2'])], T + 1000)).toHaveLength(0)
  })

  it('安全弁: 別の場所の検知が出ていても、降ろした検知は残す', () => {
    const s = createDemotedEventsState()
    stepDemotedEvents(s, [ev('a', 'weak', true, ['k1'])], T)
    expect(stepDemotedEvents(s, [ev('a', 'weak', true, ['k1']), ev('b', 'confirmed', false, ['k9'])], T + 1000)).toHaveLength(1)
  })

  it('安全弁: 同じフレームを二度渡しても結果は変わらない（StrictMode の二重実行）', () => {
    const s = createDemotedEventsState()
    const d = [ev('a', 'weak', true)]
    const first = stepDemotedEvents(s, d, T)
    expect(stepDemotedEvents(s, d, T)).toEqual(first)
  })

  it('安全弁: データ時刻が巻き戻ったら（リプレイの開始）すべて捨てる', () => {
    const s = createDemotedEventsState()
    stepDemotedEvents(s, [ev('a', 'weak', true)], T)
    expect(stepDemotedEvents(s, [], T - 60_000)).toHaveLength(0)
  })

  it('安全弁: データ時刻が読めない（検知が止まって結果を空にした）間は記憶を空にする', () => {
    // 残すと期限が進まず、供給が戻るまで「取り下げ」が出たままになる
    const s = createDemotedEventsState()
    stepDemotedEvents(s, [ev('a', 'weak', true)], T)
    expect(stepDemotedEvents(s, [], NaN)).toEqual([])
    expect(stepDemotedEvents(s, [], T + 1000)).toEqual([])
  })
})
