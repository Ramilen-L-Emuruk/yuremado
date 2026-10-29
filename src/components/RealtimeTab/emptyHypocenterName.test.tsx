// @vitest-environment jsdom
//
// EEW カードで震央地名が空の報。
//
// **地名が付かないだけで震源が決まっている報は、マグニチュード・深さを出す。** 欄の条件を
// 地名の有無で書くと、座標も深さも規模も届いているのにカードからだけ消える。判定は
// 「仮の震源でない」かつ「地名がある、または座標が判っている」。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { RealtimeTab } from './index'
import type { EEWAlert } from '../../types/earthquake'

afterEach(cleanup)

function makeEEW(over: { name?: string; latitude?: number; longitude?: number; condition?: string; strongShakingOnly?: true } = {}): EEWAlert {
  return {
    ...(over.strongShakingOnly ? { strongShakingOnly: true as const } : {}),
    kind: 'eew',
    origin: 'dmdata',
    id: 'test-eew',
    time: '2026-01-01T12:00:00Z',
    test: false,
    earthquake: {
      originTime: '2026-01-01T12:00:00Z',
      arrivalTime: '2026-01-01T12:00:20Z',
      condition: over.condition ?? '',
      hypocenter: {
        name: over.name ?? '',
        latitude: over.latitude ?? 36.2,
        longitude: over.longitude ?? 141.0,
        depth: 30,
        magnitude: 6.5,
      },
    },
    severity: 'Warning',
    cancelled: false,
  }
}

const renderTab = (eew: EEWAlert) =>
  render(
    <RealtimeTab eewNoForecastSettledKeys={new Set()} eews={[eew]} swaveArrival={null} kyoshinV2Detections={[]} kyoshinDetectedPoints={[]} visible />,
  )

describe('EEW カード: 震央地名が空の報', () => {
  // 正: 地名が空でも座標が判っていれば M・深さを出す（見出しは「震源調査中」）
  it('座標が判っていればマグニチュードと深さを出す', () => {
    renderTab(makeEEW())
    expect(screen.getByText('震源調査中')).toBeTruthy()
    expect(screen.getByText('マグニチュード')).toBeTruthy()
    expect(screen.getByText('M6.5')).toBeTruthy()
    expect(screen.getByText('深さ')).toBeTruthy()
  })

  // 対照: 地名も座標も判らない報は出さない
  it('座標も判らなければマグニチュードの欄を出さない', () => {
    renderTab(makeEEW({ latitude: -200, longitude: -200 }))
    expect(screen.queryByText(/マグニチュード/)).toBeNull()
  })

  // 安全弁: 仮定震源要素は地名の有無によらず伏せたまま
  it('仮定震源要素ならマグニチュードの欄を出さない', () => {
    renderTab(makeEEW({ condition: '仮定震源要素' }))
    expect(screen.queryByText(/マグニチュード/)).toBeNull()
  })

  // 安全弁: 「非常に強い揺れを検知」の報も地名の有無によらず伏せたまま
  it('「非常に強い揺れを検知」の報ならマグニチュードの欄を出さない', () => {
    renderTab(makeEEW({ strongShakingOnly: true }))
    expect(screen.queryByText(/マグニチュード/)).toBeNull()
  })
})
