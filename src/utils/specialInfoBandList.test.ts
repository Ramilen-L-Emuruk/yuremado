import { describe, it, expect } from 'vitest'
import { dropExpiredUpTo, earliestExpiryMs, putBandItem, type BandListItem } from './specialInfoBandList'
import { cancelOverOtherUnitInList, earthquakeCountListDecision, kohatsuListDecision, nankaiCommentaryListDecision } from './specialInfoBands'

type Item = BandListItem & { unit: string }
const item = (id: string, unit: string, minute: number, expireMinute = minute + 60): Item => ({
  id, unit,
  reportDateTime: `2026-01-01T12:${String(minute).padStart(2, '0')}:00+09:00`,
  expireAt: new Date(Date.parse('2026-01-01T12:00:00+09:00') + expireMinute * 60_000).toISOString(),
})

describe('putBandItem', () => {
  it('正: 別件は積み、新しい順に並べる', () => {
    const first = putBandItem([], item('a', 'A', 10), s => s.unit === 'A')!
    const list = putBandItem(first, item('b', 'B', 20), s => s.unit === 'B')!
    expect(list.map(i => i.id)).toEqual(['b', 'a'])
  })

  it('対照: 同じ件は置き換える', () => {
    const list = putBandItem([item('a1', 'A', 10), item('b', 'B', 5)], item('a2', 'A', 15), s => s.unit === 'A')!
    expect(list.map(i => i.id)).toEqual(['a2', 'b'])
  })

  it('安全弁: 同じ件のより新しい報が既にあれば、遅れて届いた古い報では置き換えない', () => {
    expect(putBandItem([item('a2', 'A', 15)], item('a1', 'A', 10), s => s.unit === 'A')).toBe(null)
  })

  it('遅れて届いた古い別件は後ろへ並ぶ', () => {
    const list = putBandItem([item('b', 'B', 20)], item('a', 'A', 10), s => s.unit === 'A')!
    expect(list.map(i => i.id)).toEqual(['b', 'a'])
  })
})

describe('期限', () => {
  it('いちばん早い期限を返し、そこまでの報だけを外す（1 件ずつ）', () => {
    const list = [item('a', 'A', 10, 30), item('b', 'B', 20, 90)]
    const until = earliestExpiryMs(list)
    expect(until).toBe(Date.parse(list[0].expireAt))
    expect(dropExpiredUpTo(list, until!).map(i => i.id)).toEqual(['b'])
  })

  it('安全弁: 外すものが無ければ同じ一覧を返す（参照が変わらない）', () => {
    const list = [item('a', 'A', 10, 30)]
    expect(dropExpiredUpTo(list, Date.parse(list[0].expireAt) - 1)).toBe(list)
    expect(earliestExpiryMs([])).toBeNull()
  })
})

// 一覧向けの判定は、共用の判定（中継のプッシュ通知と同じ答え）へ照合先を選んで渡すだけ
describe('一覧向けの帯の判定', () => {
  const now = Date.parse('2026-01-01T12:00:00+09:00')
  const future = '2026-01-08T12:00:00+09:00'

  it('正: 一覧にある単位への取消は当てる', () => {
    expect(kohatsuListDecision(['k-A', 'k-B'], { eventId: 'k-B', cancelled: true, retracted: true, expireAt: future }, now)).toEqual({ apply: true })
    expect(nankaiCommentaryListDecision(['c-A', 'c-B'], { id: 'c-A', cancelled: true, expireAt: future }, now)).toEqual({ apply: true })
    expect(earthquakeCountListDecision(['e-A'], { eventId: 'e-A', cancelled: true, items: [], body: '', expireAt: future }, now)).toEqual({ apply: true })
  })

  it('対照: 一覧に無い単位への取消は当てない。一覧が空なら「出していない」', () => {
    expect(kohatsuListDecision(['k-A'], { eventId: 'k-X', cancelled: true, retracted: true, expireAt: future }, now)).toEqual({ apply: false, reason: 'otherUnit' })
    expect(kohatsuListDecision([], { eventId: 'k-X', cancelled: true, retracted: true, expireAt: future }, now)).toEqual({ apply: false, reason: 'notShown' })
    expect(nankaiCommentaryListDecision(['c-A'], { id: 'c-X', cancelled: true, expireAt: future }, now)).toEqual({ apply: false, reason: 'otherUnit' })
    expect(earthquakeCountListDecision([], { eventId: 'e-X', cancelled: true, items: [], body: '', expireAt: future }, now)).toEqual({ apply: false, reason: 'notShown' })
  })

  it('別の単位が出ているときの古い取消かを、一覧で見る', () => {
    const cancel = { eventId: 'k-X', cancelled: true, retracted: true }
    expect(cancelOverOtherUnitInList(['k-A'], cancel)).toBe(true)
    expect(cancelOverOtherUnitInList(['k-A', 'k-X'], cancel)).toBe(false)
    expect(cancelOverOtherUnitInList([], cancel)).toBe(false)
  })
})
