// @vitest-environment jsdom
//
// 検知カードの区域名と、確定を降ろした検知のカード。
//
// 区域名は最も強い観測点が入る一次細分区域から引く（2026-10-22 ユーザー選択「地域名を出す
// (Recommended)」、出し方は 2026-10-24 ユーザー選択「本文と内訳の両方 (Recommended)」）。
// 降ろした検知は理由を添えて残す（2026-10-22 ユーザー選択「理由をカードに残す (Recommended)」）。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import type { SubRegion } from '../../utils/subregions'

/** 経度 139〜140・緯度 35〜36 の正方形の区域「テスト区域」だけを持つ境界データ。 */
const SUBREGIONS: SubRegion[] = [
  {
    name: 'テスト区域',
    label: [35.5, 139.5],
    room: [0, 0],
    rings: [[[35, 139], [35, 140], [36, 140], [36, 139], [35, 139]]],
  },
]
let loaded: SubRegion[] | null = SUBREGIONS

vi.mock('../../utils/subregions', async (orig) => {
  const actual = await orig<typeof import('../../utils/subregions')>()
  return {
    ...actual,
    getSubRegionsCache: () => loaded,
    onSubRegionsLoaded: (fn: (d: SubRegion[]) => void) => {
      if (loaded) fn(loaded)
      return () => {}
    },
  }
})

import { RealtimeTab } from './index'
import { initGates, type DetectionEvent } from '../../utils/kyoshinDetector'
import type { DetectedPoint } from '../../utils/kyoshinDetectionView'

afterEach(() => {
  cleanup()
  loaded = SUBREGIONS
})

function ev(overrides: Partial<DetectionEvent> & Pick<DetectionEvent, 'id' | 'confidence'>): DetectionEvent {
  return {
    memberKeys: [], maxIntensity: 1.0, cells: [], originTimeMs: Date.UTC(2026, 0, 1, 0, 0, 0),
    lastOnsetAtMs: 0, lastSize: 0, epicenter: null, confirmStreak: 0, firstConfirmedAtMs: 0,
    everMultiPoint: false, isolated: false, isolatedStuckKeys: [], isolatedSilentKeys: [],
    everConfirmed: overrides.confidence === 'confirmed', lastSpreadAtMs: 0,
    everNeighborRise: overrides.confidence !== 'faint', gates: initGates(), confirmedBy: null,
    ...overrides,
  }
}

const inside = (key: string, index: number): DetectedPoint => ({ key, lat: 35.5, lng: 139.5, index })
const farAway = (key: string, index: number): DetectedPoint => ({ key, lat: 43, lng: 145, index })

function renderTab(detections: DetectionEvent[], points: DetectedPoint[], demoted: DetectionEvent[] = []) {
  return render(
    <RealtimeTab
      eewNoForecastSettledKeys={new Set()}
      eews={[]}
      swaveArrival={null}
      kyoshinV2Detections={detections}
      kyoshinDetectedPoints={points}
      kyoshinDemoted={demoted}
      visible
    />,
  )
}

describe('検知カードの区域名', () => {
  it('正: 最も強い観測点の区域名を本文に出す', () => {
    renderTab([ev({ id: 'evt-1', confidence: 'confirmed' })], [farAway('a', 7), inside('b', 11)])
    expect(screen.getByText('最も強い観測点：テスト区域')).toBeTruthy()
  })

  it('対照: 最も強い観測点がどの区域にも寄せられなければ、行を出さない', () => {
    renderTab([ev({ id: 'evt-1', confidence: 'confirmed' })], [farAway('a', 11), inside('b', 7)])
    expect(screen.queryByText(/最も強い観測点/)).toBeNull()
  })

  it('対照: 区域データが未読み込みなら行を出さない', () => {
    loaded = null
    renderTab([ev({ id: 'evt-1', confidence: 'confirmed' })], [inside('b', 11)])
    expect(screen.queryByText(/最も強い観測点/)).toBeNull()
  })

  it('正: 内訳では地域ごとに、そのメンバーの最も強い観測点の区域名を添える', () => {
    renderTab(
      [
        ev({ id: 'evt-1', confidence: 'confirmed', memberKeys: ['b'] }),
        ev({ id: 'evt-2', confidence: 'likely', memberKeys: ['a'] }),
      ],
      [inside('b', 11), farAway('a', 9)],
    )
    fireEvent.click(screen.getByText('判定の内訳'))
    expect(screen.getByText('地域 1・テスト区域（検知）')).toBeTruthy()
    // 区域へ寄せられない地域は番号だけ
    expect(screen.getByText('地域 2（可能性）')).toBeTruthy()
  })
})

describe('確定を降ろした検知のカード', () => {
  const demoted = ev({
    id: 'evt-9',
    confidence: 'weak',
    gates: { ...initGates(), soloStale: true, soloStaleFlat: true },
  })

  it('正: 降ろした検知は「取り下げ」と理由を出す（ほかの検知が無くても）', () => {
    renderTab([demoted], [], [demoted])
    expect(screen.getByText('取り下げ')).toBeTruthy()
    expect(screen.getByText('値が動かないまま続いたため取り下げ')).toBeTruthy()
  })

  it('対照: 降ろした検知が渡されなければ、weak だけではカードを出さない', () => {
    renderTab([demoted], [])
    expect(screen.queryByText('取り下げ')).toBeNull()
    expect(screen.queryByText(/強震モニタ検知/)).toBeNull()
  })

  it('安全弁: ほかの検知が続いていれば、主のカードと並べて出す', () => {
    renderTab([ev({ id: 'evt-1', confidence: 'confirmed' }), demoted], [inside('b', 11)], [demoted])
    expect(screen.getByText('取り下げ')).toBeTruthy()
    expect(screen.getByText('最も強い観測点：テスト区域')).toBeTruthy()
  })
})
