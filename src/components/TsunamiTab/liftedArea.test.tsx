// @vitest-environment jsdom
//
// 解除された区域の観測点の置き場所と、全区域解除の報に気象庁が書いた文の表示
// （→ docs/spec/tsunami-spec.md §9・§10）。
//
// **描いてみないと確かめられない。** 観測点をどの枠へ置くかは、表示中の区域・解除された区域・
// どちらにも当たらないもの（「沖合観測」）の 3 つへの振り分けで決まり、型検査も `utils/tsunami.ts`
// のユニットテストも通らない。振り分けを誤ると観測点がどの枠からも消える。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { TsunamiTab } from './index'
import type { JMATsunami, TsunamiObservation } from '../../types/earthquake'
import { NO_TSUNAMI_VALUE_MARKS } from '../../utils/tsunami'

afterEach(cleanup)

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver

const fukaura: TsunamiObservation = {
  name: '深浦', districtCode: '200', districtName: '青森県日本海沿岸',
  height: { value: 0.2, description: '0.2m' },
}
const hachinohe: TsunamiObservation = {
  name: '八戸', districtCode: '201', districtName: '青森県太平洋沿岸',
  height: { value: 0.4, description: '0.4m' },
}
const offshore: TsunamiObservation = {
  name: '岩手釜石沖', height: { value: 0.1, description: '0.1m' },
}

function makeTsunami(): JMATsunami {
  return {
    kind: 'tsunami',
    id: 'test-tsunami-lifted',
    eventId: '20260420050000',
    time: '2026-04-20T05:30:00',
    cancelled: false,
    issue: { source: 'テスト', time: '2026-04-20T05:30:00', type: 'Focus' },
    areas: [{ code: '201', name: '青森県太平洋沿岸', grade: 'Watch', lastGrade: 'Watch', immediate: false, maxHeight: { description: '1m', value: 1 } }],
    cancelledAreas: [{ code: '200', name: '青森県日本海沿岸', grade: 'Unknown', lastGrade: 'Watch', immediate: false }],
    observations: [fukaura, hachinohe, offshore],
  }
}

/** 観測点の名前を含むカード（`bg-card`）。 */
function cardOf(name: string): Element | null {
  return screen.getByText(name).closest('.bg-card')
}

describe('解除された区域の観測点', () => {
  // 2026-10-19 ユーザー選択「解除の区域の下へ移す（推奨）」
  it('正: 解除された区域の観測点は、解除のカードの中に出す', () => {
    render(<TsunamiTab tsunamiValueMarks={NO_TSUNAMI_VALUE_MARKS} tsunamis={[makeTsunami()]} />)
    const card = cardOf('深浦')
    expect(card?.textContent).toContain('解除')
    expect(card?.textContent).not.toContain('沖合観測')
  })

  it('対照: どの区域にも当たらない観測点は「沖合観測」に残す', () => {
    render(<TsunamiTab tsunamiValueMarks={NO_TSUNAMI_VALUE_MARKS} tsunamis={[makeTsunami()]} />)
    expect(cardOf('岩手釜石沖')?.textContent).toContain('沖合観測')
  })

  it('安全弁: 表示中の区域の観測点は、その区域のカードから動かない', () => {
    render(<TsunamiTab tsunamiValueMarks={NO_TSUNAMI_VALUE_MARKS} tsunamis={[makeTsunami()]} />)
    const card = cardOf('八戸')
    expect(card?.textContent).toContain('青森県太平洋沿岸')
    expect(card?.textContent).not.toContain('沖合観測')
    expect(card).not.toBe(cardOf('深浦'))
  })

  it('観測点はどれも 1 回だけ出る', () => {
    render(<TsunamiTab tsunamiValueMarks={NO_TSUNAMI_VALUE_MARKS} tsunamis={[makeTsunami()]} />)
    for (const name of ['深浦', '八戸', '岩手釜石沖']) expect(screen.getAllByText(name)).toHaveLength(1)
  })
})

describe('全区域解除の報の気象庁の文', () => {
  const LIFT_TEXT = '現在、大津波警報・津波警報・津波注意報を発表している沿岸はありません。'
  const ended = (liftText?: string): JMATsunami => ({
    ...makeTsunami(),
    cancelledAt: new Date('2026-04-20T06:00:00'),
    cancelReason: 'lifted',
    ...(liftText && { liftText }),
  })

  // 2026-10-14 ユーザー選択「画面にも出し、読み上げる」
  it('正: 解除の表示の間、気象庁の文を出す', () => {
    render(<TsunamiTab tsunamiValueMarks={NO_TSUNAMI_VALUE_MARKS} tsunamis={[ended(LIFT_TEXT)]} />)
    expect(screen.getByText(LIFT_TEXT)).toBeTruthy()
  })

  it('対照: 文を持たない解除では何も足さない', () => {
    render(<TsunamiTab tsunamiValueMarks={NO_TSUNAMI_VALUE_MARKS} tsunamis={[ended()]} />)
    expect(screen.queryByText(LIFT_TEXT)).toBeNull()
  })
})
