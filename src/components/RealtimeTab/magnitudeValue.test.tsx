// @vitest-environment jsdom
//
// EEW カードの「マグニチュード」の欄。
//
// **規模が判らない報（`NaN`）で数字を作らない。** かつて強震モニタ（Yahoo）の経路は
// 読めない規模を `0` にしていて、カードに「0.0」と出ていた。いまは `NaN` で持つので、
// 素の `toFixed(1)` では「NaN」が出る —— 欄の値は `formatMagnitudeWithCondition` を通す。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { RealtimeTab } from './index'
import type { EEWAlert } from '../../types/earthquake'

afterEach(cleanup)

function makeEEW(magnitude: number, magnitudeCondition?: string, magnitudeType?: string): EEWAlert {
  return {
    kind: 'eew',
    origin: 'yahoo',
    id: 'test-eew',
    time: '2026-01-01T12:00:00Z',
    test: false,
    earthquake: {
      originTime: '2026-01-01T12:00:00Z',
      arrivalTime: '',
      condition: '',
      hypocenter: {
        name: '茨城県沖', latitude: 36.2, longitude: 141.0, depth: 30, magnitude,
        ...(magnitudeCondition && { magnitudeCondition }),
        ...(magnitudeType && { magnitudeType }),
      },
    },
    severity: 'Forecast',
    cancelled: false,
  }
}

const renderTab = (eew: EEWAlert) =>
  render(
    <RealtimeTab eewNoForecastSettledKeys={new Set()} eews={[eew]} swaveArrival={null} kyoshinV2Detections={[]} kyoshinDetectedPoints={[]} kyoshinDemoted={[]} visible />,
  )

/** 規模の見出しの隣に出る値。 */
function magnitudeValue(heading = 'マグニチュード'): string | null {
  const label = screen.getByText(heading)
  return label.nextElementSibling?.textContent ?? null
}

describe('EEW カードのマグニチュードの欄', () => {
  // 正: 判らない規模は「不明」（「NaN」「0.0」を出さない）
  it('規模が NaN なら「不明」', () => {
    renderTab(makeEEW(Number.NaN))
    expect(magnitudeValue()).toBe('不明')
  })

  // 対照: 読めた規模は小数 1 桁
  it('読めた規模は記号つきの小数 1 桁', () => {
    renderTab(makeEEW(5.4))
    expect(magnitudeValue()).toBe('M5.4')
  })

  // 正: `Mj` の報は見出しが種別の名前を名乗り、値は `Mj` で始まる（開いた地震カードと同じ形）。
  it('Mj の報は見出しが「気象庁マグニチュード」・値が Mj つき', () => {
    renderTab(makeEEW(5.4, undefined, 'Mj'))
    expect(magnitudeValue('気象庁マグニチュード')).toBe('Mj5.4')
    expect(screen.queryByText('マグニチュード')).toBeNull()
  })

  // 安全弁: 規模の説明（「Ｍ８を超える巨大地震」など）を持つ報は、説明を「不明」で潰さない
  it('規模の説明がある報は説明を出す', () => {
    renderTab(makeEEW(Number.NaN, 'Ｍ８を超える巨大地震'))
    expect(magnitudeValue()).toBe('M8を超える巨大地震')
  })
})
