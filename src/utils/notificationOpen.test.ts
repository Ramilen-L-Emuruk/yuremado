import { describe, it, expect } from 'vitest'
import { notificationOpenQuery, parseNotificationOpen, withoutNotificationOpen, type NotificationOpen } from './notificationOpen'

describe('notificationOpenQuery / parseNotificationOpen', () => {
  const cases: NotificationOpen[] = [
    { tab: 'realtime' },
    { tab: 'tsunami' },
    { tab: 'earthquake', quake: '20260101162200' },
    { tab: 'earthquake', lpgm: '20260101161000' },
    { tab: 'earthquake', estimated: '2026-01-01T16:10:00+09:00', lat: 37.5, lon: 137.27 },
    { tab: 'earthquake', estimated: '2026-01-01T16:10:00+09:00' },
  ]
  it('正: 問い合わせの形へ直して読み戻すと同じ開き先になる（記号を含む値も）', () => {
    for (const open of cases) {
      expect(parseNotificationOpen(notificationOpenQuery(open))).toEqual(open)
      expect(parseNotificationOpen(`?${notificationOpenQuery(open)}`)).toEqual(open)
    }
  })

  it('対照: 開き先が無ければ空文字で、空文字は読んでも null', () => {
    expect(notificationOpenQuery(null)).toBe('')
    expect(parseNotificationOpen('')).toBeNull()
  })

  it('安全弁: 形が合わない値は開き先ごと捨てる（知らないタブ・地震を指さない地震タブ）', () => {
    expect(parseNotificationOpen('open=catalog')).toBeNull()
    expect(parseNotificationOpen('open=earthquake')).toBeNull()
    expect(parseNotificationOpen('quake=20260101162200')).toBeNull()
  })

  it('安全弁: 推計の震源が片方だけ・数でなければ、震源を捨てて時刻だけで当てる', () => {
    expect(parseNotificationOpen('open=earthquake&estimated=t&lat=37.5')).toEqual({ tab: 'earthquake', estimated: 't' })
    expect(parseNotificationOpen('open=earthquake&estimated=t&lat=x&lon=1')).toEqual({ tab: 'earthquake', estimated: 't' })
    expect(notificationOpenQuery({ tab: 'earthquake', estimated: 't', lat: NaN, lon: 1 })).toBe('open=earthquake&estimated=t')
  })
})

describe('withoutNotificationOpen', () => {
  it('正: 開き先の名前だけを取り除き、他の問い合わせは残す', () => {
    expect(withoutNotificationOpen('?open=earthquake&quake=1&debug=1')).toBe('?debug=1')
  })
  it('対照: 開き先しか無ければ空になり、開き先が無ければそのまま', () => {
    expect(withoutNotificationOpen('?open=realtime')).toBe('')
    expect(withoutNotificationOpen('?debug=1')).toBe('?debug=1')
    expect(withoutNotificationOpen('')).toBe('')
  })
})
