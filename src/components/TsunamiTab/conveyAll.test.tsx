// @vitest-environment jsdom
//
// 津波カードに電文の値をそのまま出す変更（2026-10-30 の決定）をカードの描画で固定する。
//   - 等級の帯は電文の名前（`Kind/Name`）を出し、名前ごとにカードを分ける（「大津波警報：発表」）
//   - 津波予報は「津波予報（若干の海面変動）」と名乗る
//   - 見出し文（`Head/Headline/Text`）をそのまま出す
//   - 編集官署の隣に発表官署を出す
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { TsunamiTab } from './index'
import type { JMATsunami, TsunamiArea } from '../../types/earthquake'
import { NO_TSUNAMI_VALUE_MARKS } from '../../utils/tsunami'

vi.mock('../../hooks/useTsunamiZones', () => ({ useTsunamiZones: () => ({}) }))
vi.mock('../../hooks/useTsunamiObsCoords', () => ({ useTsunamiObsCoords: () => ({}) }))

afterEach(cleanup)

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver

const area = (name: string, code: string, grade: TsunamiArea['grade'], kindName?: string): TsunamiArea =>
  ({ name, code, grade, immediate: false, ...(kindName && { kindName }) })

function makeTsunami(over: Partial<JMATsunami> = {}): JMATsunami {
  return {
    kind: 'tsunami', id: 'test-tsunami-convey', eventId: '20110311144640', time: '2011-03-11T14:53:00', cancelled: false,
    issue: { source: 'テスト', editorialOffice: '気象庁本庁', publishingOffice: '気象庁', time: '2011-03-11T14:53:00', type: 'Focus' },
    areas: [
      area('青森県太平洋沿岸', '201', 'MajorWarning', '大津波警報：発表'),
      area('岩手県', '210', 'MajorWarning', '大津波警報'),
      area('北海道太平洋沿岸西部', '102', 'Forecast', '津波予報（若干の海面変動）'),
    ],
    observations: [],
    ...over,
  }
}

const renderTab = (tsunami: JMATsunami) =>
  render(<TsunamiTab tsunamiValueMarks={NO_TSUNAMI_VALUE_MARKS} tsunamis={[tsunami]} isVisible />)

describe('等級の帯は電文の名前を出す', () => {
  it('正: 「大津波警報：発表」の区域は、その名前のカードに分けて出す', () => {
    renderTab(makeTsunami())
    expect(screen.getByText('大津波警報：発表')).toBeTruthy()
    expect(screen.getByText('大津波警報')).toBeTruthy()
  })

  it('対照: 名前を持たない区域（標準版）は等級の名前で 1 枚にまとめる', () => {
    renderTab(makeTsunami({ areas: [area('岩手県', '210', 'MajorWarning'), area('宮城県', '220', 'MajorWarning')] }))
    expect(screen.getAllByText('大津波警報')).toHaveLength(1)
    expect(screen.queryByText('大津波警報：発表')).toBeNull()
  })

  it('津波予報は「津波予報（若干の海面変動）」と名乗る', () => {
    renderTab(makeTsunami())
    expect(screen.getByText('津波予報（若干の海面変動）')).toBeTruthy()
  })
})

describe('見出し文と官署', () => {
  it('見出し文をそのまま出す', () => {
    renderTab(makeTsunami({ headline: '東北地方太平洋沿岸に大津波警報を発表しました。' }))
    expect(screen.getByText('東北地方太平洋沿岸に大津波警報を発表しました。')).toBeTruthy()
  })

  it('編集官署の隣に発表官署を出す', () => {
    renderTab(makeTsunami())
    expect(screen.getByText(/編集官署 気象庁本庁 ／ 発表官署 気象庁/)).toBeTruthy()
  })
})
