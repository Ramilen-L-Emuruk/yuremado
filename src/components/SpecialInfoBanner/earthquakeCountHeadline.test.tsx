// @vitest-environment jsdom
//
// 地震回数に関する情報（VXSE60）の帯の見出しと開いた表。
//
// **気象庁が発表しない値（電文の `-1`。型では `null`）を数として出さない**
// （2026-10-19 ユーザー承認「-1 を「発表なし」に (推奨)」）。資料の事例（電文解説資料 Ⅱ.35）は
// 全区間の回数が `-1` で、有感だけが値を持つ —— そのまま出すと帯に「-1回」と並ぶ。
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { EarthquakeCountDetail, earthquakeCountHeadline } from './EarthquakeCountDetail'
import { withTz } from '../../test-utils/withTz'
import type { JMAEarthquakeCount, JMAEarthquakeCountItem } from '../../types/earthquake'

const item = (over: Partial<JMAEarthquakeCountItem> = {}): JMAEarthquakeCountItem => ({
  type: '累積地震回数',
  startTime: '2008-08-24T15:00:00+09:00',
  endTime: '2008-08-25T12:00:00+09:00',
  number: 5,
  feltNumber: 1,
  ...over,
})

const count = (items: JMAEarthquakeCountItem[], over: Partial<JMAEarthquakeCount> = {}): JMAEarthquakeCount => ({
  id: 'c1',
  time: '2008-08-25T12:00:00+09:00',
  eventId: 'ev1',
  headline: '地震回数に関する情報をお知らせします。',
  items,
  cancelled: false,
  reportDateTime: '2008-08-25T12:00:00+09:00',
  expireAt: '2008-09-01T12:00:00+09:00',
  ...over,
})

describe('earthquakeCountHeadline', () => {
  // 対照: 両方あればいまどおり
  it('回数も有感もあればいまどおり', () => {
    withTz('Asia/Tokyo', () => {
      expect(earthquakeCountHeadline(count([item()]))).toBe('8/24 15時から 5回（うち有感 1回）')
    })
  })

  // 正: 回数が発表なし → 有感だけ
  it('回数が発表なし・有感 1 → 「有感 1回」', () => {
    withTz('Asia/Tokyo', () => {
      expect(earthquakeCountHeadline(count([item({ number: null })]))).toBe('8/24 15時から 有感 1回')
    })
  })

  // 正: 有感が発表なし → 回数だけ
  it('回数 5・有感が発表なし → 「5回」', () => {
    withTz('Asia/Tokyo', () => {
      expect(earthquakeCountHeadline(count([item({ feltNumber: null })]))).toBe('8/24 15時から 5回')
    })
  })

  // 安全弁: 両方が発表なし → 種別名だけ（数の句を作らない）
  it('両方が発表なし → 種別名', () => {
    expect(earthquakeCountHeadline(count([item({ number: null, feltNumber: null })]))).toBe('地震回数に関する情報')
  })

  // 正: 累積が無ければ「地震回数」の区間（読み上げと同じ関数で選ぶ）
  it('累積が無ければ「地震回数」の区間の数字を出す', () => {
    withTz('Asia/Tokyo', () => {
      const items = [
        item({ type: '地震回数', endTime: '2008-08-25T09:00:00+09:00', number: 1587 }),
        item({ type: '１時間地震回数', startTime: '2008-08-25T09:00:00+09:00', endTime: '2008-08-25T10:00:00+09:00', number: 35, feltNumber: 0 }),
      ]
      expect(earthquakeCountHeadline(count(items))).toBe('8/24 15時から 1,587回（うち有感 1回）')
    })
  })

  // 安全弁: 区間の無い報（回数を伴わない発表報）は種別名
  it('区間の無い報は種別名', () => {
    expect(earthquakeCountHeadline(count([], { body: '本文' }))).toBe('地震回数に関する情報')
  })
})

describe('EarthquakeCountDetail', () => {
  // 正: 発表なしのセルは「—」。「-1」を出さない
  it('発表なしのセルは「—」', () => {
    const { container } = render(<EarthquakeCountDetail count={count([item({ number: null, feltNumber: 3 })])} />)
    const cells = [...container.querySelectorAll('tbody td')].map(td => td.textContent)
    expect(cells).toContain('—')
    expect(cells).toContain('3')
    expect(container.textContent).not.toContain('-1')
  })

  // 正: 回数を伴わない発表報は本文を出す（改行を保つ）
  it('回数を伴わない発表報は本文を出す', () => {
    const { container } = render(<EarthquakeCountDetail count={count([], { body: '一行目\n二行目' })} />)
    const p = [...container.querySelectorAll('p')].find(el => el.textContent?.includes('一行目'))
    expect(p?.textContent).toBe('一行目\n二行目')
    expect(p?.className).toContain('whitespace-pre-wrap')
    // 区間が無いので表は出さない
    expect(container.querySelector('table')).toBeNull()
  })
})
