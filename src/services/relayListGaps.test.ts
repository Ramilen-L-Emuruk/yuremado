import { describe, it, expect, vi } from 'vitest'
import { createRelayGapStore, parseRelayListGaps } from './relayListGaps'

const T = (iso: string) => Date.parse(iso)

describe('parseRelayListGaps', () => {
  it('語る範囲と区分ごとの見ていない区間を読む', () => {
    const r = parseRelayListGaps({
      status: 'ok', items: [],
      gapsSpan: { from: '2026-10-30T00:00:00Z', to: '2026-10-31T00:00:00Z' },
      gaps: [{ classification: 'eew.warning', from: '2026-10-30T03:00:00Z', to: '2026-10-30T04:00:00Z' }],
    })
    expect(r).toEqual({
      span: { fromMs: T('2026-10-30T00:00:00Z'), toMs: T('2026-10-31T00:00:00Z') },
      gaps: [{ classification: 'eew.warning', fromMs: T('2026-10-30T03:00:00Z'), toMs: T('2026-10-30T04:00:00Z') }],
    })
  })

  it('対照: 語る範囲が無い応答（DMDATA の一覧）は読まない', () => {
    expect(parseRelayListGaps({ status: 'ok', items: [] })).toBeNull()
    expect(parseRelayListGaps({ status: 'ok', gapsSpan: { from: 'x', to: 'y' } })).toBeNull()
  })

  it('安全弁: 読めない区間は捨てずに、範囲いっぱいの欠けとして扱う', () => {
    const r = parseRelayListGaps({
      gapsSpan: { from: '2026-10-30T00:00:00Z', to: '2026-10-31T00:00:00Z' },
      gaps: [{ classification: 'telegram.earthquake', from: '壊れた', to: null }],
    })
    expect(r?.gaps).toEqual([
      { classification: 'telegram.earthquake', fromMs: T('2026-10-30T00:00:00Z'), toMs: T('2026-10-31T00:00:00Z') },
    ])
  })
})

describe('createRelayGapStore', () => {
  const span = (from: string, to: string) => ({ fromMs: T(from), toMs: T(to) })
  const gap = (from: string, to: string, classification = 'telegram.earthquake') => ({ classification, fromMs: T(from), toMs: T(to) })

  it('観測した範囲の中は新しい答えで置き換え、突き合わせの済んだ印を消す', () => {
    const store = createRelayGapStore()
    store.note({ span: span('2026-10-30T00:00:00Z', '2026-10-31T00:00:00Z'), gaps: [gap('2026-10-30T03:00:00Z', '2026-10-30T04:00:00Z')] })
    expect(store.snapshot()).toHaveLength(1)
    store.note({ span: span('2026-10-30T00:00:00Z', '2026-10-31T00:00:00Z'), gaps: [] })
    expect(store.snapshot()).toEqual([])
  })

  it('対照: 範囲の外で前に見た印は残す（範囲の端で切る）', () => {
    const store = createRelayGapStore()
    store.note({ span: span('2026-10-29T00:00:00Z', '2026-10-31T00:00:00Z'), gaps: [gap('2026-10-29T22:00:00Z', '2026-10-30T02:00:00Z')] })
    store.note({ span: span('2026-10-30T00:00:00Z', '2026-10-31T00:00:00Z'), gaps: [] })
    expect(store.snapshot()).toEqual([gap('2026-10-29T22:00:00Z', '2026-10-30T00:00:00Z')])
  })

  it('安全弁: 中身が変わらなければ知らせない', () => {
    const store = createRelayGapStore()
    const listener = vi.fn()
    store.subscribe(listener)
    const observed = { span: span('2026-10-30T00:00:00Z', '2026-10-31T00:00:00Z'), gaps: [gap('2026-10-30T03:00:00Z', '2026-10-30T04:00:00Z')] }
    store.note(observed)
    store.note(observed)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
