// @vitest-environment jsdom
//
// 地震カードの長周期の欄に、長周期の電文自身の震源・規模・全国の最大震度・地震発現時刻を出す
// （2026-10-29 ユーザー承認「長周期の欄にも出す」、形は「1行・名前と深さ (Recommended)」、
// 印は「地震カードと同じく付ける」）。
//   正  : 値と震源決定の行を出し、動いた欄の肩に印を置く
//   対照: 印が無ければ点を出さない
//   安全弁: 出す値が 1 つも無ければ何も描かない
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { LpgmQuakeFacts } from './LpgmQuakeFacts'
import type { JMALpgm } from '../../types/earthquake'
import type { QuakeCardMarks } from '../../utils/quakeUpdateMark'

const lpgm: JMALpgm = {
  id: 'x', eventId: '20240101161000', time: '2024-01-01T16:23:00+09:00', originTime: '2024-01-01T16:10:00+09:00',
  maxClass: 4, cancelled: false,
  hypocenter: { name: '石川県能登地方', depth: 10, source: 'ＵＳＧＳ' },
  magnitude: 7.6, magnitudeType: 'Mj', maxInt: 70, arrivalTime: '2024-01-01T16:10:00+09:00',
}

describe('LpgmQuakeFacts', () => {
  it('値の行と震源決定の行を出し、動いた欄に印を置く', () => {
    const marks: QuakeCardMarks = { facts: new Map([['magnitude', 'raised']]), rows: new Map(), markedAt: 0 }
    const { container } = render(<LpgmQuakeFacts lpgm={lpgm} marks={marks} />)
    expect(container.textContent).toContain('石川県能登地方')
    expect(container.textContent).toContain('深さ10km')
    expect(container.textContent).toContain('Mj7.6')
    expect(container.textContent).toContain('最大震度7')
    expect(container.textContent).toContain('地震発現時刻 1月1日 16:10')
    expect(container.textContent).toContain('震源決定: ＵＳＧＳ（気象庁以外）')
    const spans = [...container.querySelectorAll('span')].filter(s => s.textContent?.startsWith('Mj7.6'))
    expect(spans[0]?.children.length).toBe(1)
  })

  it('印が無ければ点を出さない', () => {
    const { container } = render(<LpgmQuakeFacts lpgm={lpgm} marks={undefined} />)
    const spans = [...container.querySelectorAll('span')].filter(s => s.textContent === 'Mj7.6')
    expect(spans[0]?.children.length).toBe(0)
  })

  it('出す値が 1 つも無ければ何も描かない', () => {
    const { container } = render(<LpgmQuakeFacts lpgm={{ ...lpgm, hypocenter: undefined, magnitude: undefined, maxInt: undefined, arrivalTime: undefined }} marks={undefined} />)
    expect(container.innerHTML).toBe('')
  })
})
