// @vitest-environment jsdom
//
// 検知カードの区域名。
//
// 区域名は検知に入った点を一次細分区域ごとに「点の数×強さ」で足し、いちばん大きい区域から引く（2026-10-22
// ユーザー選択「地域名を出す (Recommended)」、出し方は 2026-10-24 ユーザー選択「本文と内訳の両方 (Recommended)」、
// 決め方は 2026-10-31 ユーザー選択「揃える (Recommended)」・文言は同日「「最も強く揺れている地域：〇〇」 (Recommended)」）。
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
import type { EnsembleDetection } from '../../utils/kyoshinEnsembleTracker'
import { fakeEnsembleDetection } from '../../test-utils/ensembleDetection'
import type { DetectedPoint } from '../../utils/kyoshinDetectionView'

afterEach(() => {
  cleanup()
  loaded = SUBREGIONS
})

function ev(overrides: Partial<EnsembleDetection> & Pick<EnsembleDetection, 'id' | 'confidence'>): EnsembleDetection {
  return fakeEnsembleDetection({ maxIntensity: 1.0, originTimeMs: Date.UTC(2026, 0, 1, 0, 0, 0), ...overrides })
}

const inside = (key: string, index: number): DetectedPoint => ({ key, lat: 35.5, lng: 139.5, index })
const farAway = (key: string, index: number): DetectedPoint => ({ key, lat: 43, lng: 145, index })

function renderTab(detections: EnsembleDetection[], points: DetectedPoint[]) {
  return render(
    <RealtimeTab
      eewNoForecastSettledKeys={new Set()}
      eews={[]}
      swaveArrival={null}
      kyoshinV2Detections={detections}
      kyoshinDetectedPoints={points}
      visible
    />,
  )
}

describe('検知カードの区域名', () => {
  it('正: 区域に寄せられる点から区域名を本文に出す（区域外の点が最も強くても、区域内の点で決める）', () => {
    renderTab([ev({ id: 'evt-1', confidence: 'confirmed' })], [farAway('a', 7), inside('b', 11)])
    expect(screen.getByText('最も強く揺れている地域：テスト区域')).toBeTruthy()
  })

  // 意図的に覆した: 以前は区域から 5km より離れた点に名前を付けず、行を出さなかった。2026-10-31 に、離れた点も
  // 最寄りの区域で呼ぶと決めた（ユーザー選択「海底は「相模湾」・島は最寄り (Recommended)」）
  it('正: どの区域からも離れた点だけでも、最寄りの区域の名前を出す', () => {
    renderTab([ev({ id: 'evt-1', confidence: 'confirmed' })], [farAway('a', 11), farAway('c', 7)])
    expect(screen.getByText('最も強く揺れている地域：テスト区域')).toBeTruthy()
  })

  it('対照: 区域データが未読み込みなら行を出さない', () => {
    loaded = null
    renderTab([ev({ id: 'evt-1', confidence: 'confirmed' })], [inside('b', 11)])
    expect(screen.queryByText(/最も強く揺れている地域/)).toBeNull()
  })

  it('正: 内訳では地域ごとに、そのメンバーで最も強く揺れている区域名を添える', () => {
    renderTab(
      [
        ev({ id: 'evt-1', confidence: 'confirmed', memberKeys: ['b'] }),
        ev({ id: 'evt-2', confidence: 'likely', memberKeys: ['a'] }),
      ],
      [inside('b', 11), farAway('a', 9)],
    )
    fireEvent.click(screen.getByText('判定の内訳'))
    expect(screen.getByText('地域 1・テスト区域（検知）')).toBeTruthy()
    // 区域から離れた点の地域も、最寄りの区域の名前を添える
    expect(screen.getByText('地域 2・テスト区域（可能性）')).toBeTruthy()
  })

  it('対照: 内訳で、描いた点が 1 つも無い地域は番号だけ', () => {
    renderTab(
      [
        ev({ id: 'evt-1', confidence: 'confirmed', memberKeys: ['b'] }),
        ev({ id: 'evt-2', confidence: 'likely', memberKeys: ['z'] }),
      ],
      [inside('b', 11)],
    )
    fireEvent.click(screen.getByText('判定の内訳'))
    expect(screen.getByText('地域 1・テスト区域（検知）')).toBeTruthy()
    expect(screen.getByText('地域 2（可能性）')).toBeTruthy()
  })

  // 震度0 未満の点だけの反応でも、反応が続いている間は名前を出し、収まったら消す
  // （2026-10-31 ユーザー選択「両方出す (Recommended)」）。index 3 は計測震度 −1.5（震度0 未満）
  it('正: 確かな段で震度0 未満の点だけが反応している間も、区域名を出す', () => {
    renderTab([ev({ id: 'evt-1', confidence: 'confirmed', memberKeys: ['b'] })], [inside('b', 3)])
    expect(screen.getByText('最も強く揺れている地域：テスト区域')).toBeTruthy()
  })

  it('対照: 早い段で震度0 未満の点だけなら反応は収まった扱いなので、本文にも内訳にも区域名を出さない', () => {
    renderTab(
      [
        ev({ id: 'evt-1', confidence: 'likely', memberKeys: ['b'] }),
        ev({ id: 'evt-2', confidence: 'likely', memberKeys: ['c'] }),
      ],
      [inside('b', 3), inside('c', 3)],
    )
    expect(screen.getByText(/観測点の反応は収まりました/)).toBeTruthy()
    expect(screen.queryByText(/最も強く揺れている地域/)).toBeNull()
    fireEvent.click(screen.getByText('判定の内訳'))
    expect(screen.queryByText(/テスト区域/)).toBeNull()
  })

  it('安全弁: 欠測（負の値）の点しか無ければ、反応中でも区域名を出さない', () => {
    renderTab([ev({ id: 'evt-1', confidence: 'confirmed', memberKeys: ['b'] })], [inside('b', -1)])
    expect(screen.queryByText(/最も強く揺れている地域/)).toBeNull()
  })
})
