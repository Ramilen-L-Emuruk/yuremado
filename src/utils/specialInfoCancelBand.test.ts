import { describe, it, expect } from 'vitest'
import type { JMAEarthquakeCount, JMANankai } from '../types/earthquake'
import { addSpecialInfoCancelBand, removeSpecialInfoCancelBand, specialInfoCancelBand } from './specialInfoCancelBand'

const nankai = (over: Partial<JMANankai> = {}): JMANankai => ({
  id: 'n1', time: '2026-01-01T12:00:00+09:00', eventId: 'e1', body: '  誤りですので取り消します。\n', cancelled: true, retracted: true,
  ...over,
} as JMANankai)

const count = (over: Partial<JMAEarthquakeCount> = {}): JMAEarthquakeCount => ({
  id: 'c1', time: '2026-01-01T12:00:00+09:00', eventId: 'e2', body: '地震回数に関する情報をお知らせします。', cancelled: true,
  cancelText: '先ほどの地震回数に関する情報を取り消します。', items: [], ...over,
} as JMAEarthquakeCount)

describe('specialInfoCancelBand', () => {
  it('正: 情報名と、電文の取消しの理由を前後の空白だけ落として持つ', () => {
    const c = specialInfoCancelBand({ kind: 'nankai', data: nankai() }, ['n0'])
    expect(c).toEqual({ id: 'nankai:n1|2026-01-01T12:00:00+09:00', kind: 'nankai', name: '南海トラフ地震臨時情報', reason: '誤りですので取り消します。', targetIds: ['n0'] })
  })

  it('正: 地震回数だけは理由を `cancelText` から取る（`body` は取消でない報の本文）', () => {
    expect(specialInfoCancelBand({ kind: 'earthquakeCount', data: count() }, []).reason).toBe('先ほどの地震回数に関する情報を取り消します。')
    expect(specialInfoCancelBand({ kind: 'earthquakeCount', data: count({ cancelText: undefined }) }, []).reason).toBe('')
  })

  it('安全弁: 同じ取消は 2 度足さず、外すのは鍵が合うものだけ', () => {
    const a = specialInfoCancelBand({ kind: 'nankai', data: nankai() }, [])
    const b = specialInfoCancelBand({ kind: 'earthquakeCount', data: count() }, [])
    const list = addSpecialInfoCancelBand(addSpecialInfoCancelBand([], a), b)
    expect(addSpecialInfoCancelBand(list, a)).toBe(list)
    expect(removeSpecialInfoCancelBand(list, 'nothing')).toBe(list)
    expect(removeSpecialInfoCancelBand(list, a.id)).toEqual([b])
  })
})
