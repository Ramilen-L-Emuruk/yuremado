// @vitest-environment jsdom
//
// `QuakeRegionFillGL` の流し込みの時機を固定する。出ていない層へは、地震を選んだのと同じ描き直しで流さない
// （空を流してから、手の空いた時間に本物を流す）。出ているときはその場で流す。
// 判定は `setData` に渡った中身の件数で見る（→ docs/spec/map-rendering-spec.md §9「setData churn 対策」）。
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { MapGLContext } from './mapGLContext'
import { QuakeRegionFillGL } from './QuakeRegionFillGL'
import type { RegionAggregate } from '../../hooks/useQuakeLayerData'

// ポップアップの登録とアイコンの用意は地図の中身まで要求する。ここで見るのは流し込みだけなので差し替える。
vi.mock('./gl/popupRegistry', () => ({ registerPopupSource: () => ({ remove: () => {} }) }))
vi.mock('./gl/intensityIcons', async (orig) => ({ ...(await orig<typeof import('./gl/intensityIcons')>()), ensureIntensityIcons: () => {} }))

let idle: (() => void)[] = []
beforeEach(() => {
  idle = []
  vi.stubGlobal('requestIdleCallback', (cb: () => void) => { idle.push(cb); return idle.length })
  vi.stubGlobal('cancelIdleCallback', (id: number) => { idle[id - 1] = () => {} })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function fakeMap() {
  const calls: number[] = []
  const layers = new Set<string>()
  const map = {
    addSource: () => {},
    getSource: (id: string) => (id === 'quake-region-fill'
      ? { setData: (d: { features: unknown[] }) => calls.push(d.features.length) }
      : { setData: () => {} }),
    removeSource: () => {},
    addLayer: (layer: { id: string }) => { layers.add(layer.id) },
    getLayer: (id: string) => (layers.has(id) ? { id } : undefined),
    removeLayer: (id: string) => { layers.delete(id) },
    setLayoutProperty: () => {},
    getStyle: () => ({}),
  }
  return { map: map as unknown as MapLibreMap, calls }
}

const region = (name: string): RegionAggregate => ({
  name, scale: 30, cities: [], label: [35, 139],
  rings: [[[35, 139], [35, 140], [36, 140], [35, 139]]],
})

const view = (map: MapLibreMap, regions: RegionAggregate[], visible: boolean) => (
  <MapGLContext.Provider value={map}>
    <QuakeRegionFillGL regionAggregates={regions} iconScale={1} visible={visible} />
  </MapGLContext.Provider>
)

describe('QuakeRegionFillGL の流し込みの時機', () => {
  // 正: 出ていない間に地震が替わったら、その場では空だけを流し、本物は手の空いた時間に流す
  it('隠れている間は空を流し、本物は手の空いた時間に流す', () => {
    const f = fakeMap()
    const r = render(view(f.map, [region('A')], true))
    expect(f.calls).toEqual([1])
    r.rerender(view(f.map, [region('A')], false))
    r.rerender(view(f.map, [region('B'), region('C')], false))
    expect(f.calls).toEqual([1, 0])
    idle.forEach((cb) => cb())
    expect(f.calls).toEqual([1, 0, 2])
  })

  // 対照: 出ているときは、その場で流す
  it('出ているときは地震が替わったその場で流す', () => {
    const f = fakeMap()
    const r = render(view(f.map, [region('A')], true))
    r.rerender(view(f.map, [region('B'), region('C')], true))
    expect(f.calls).toEqual([1, 2])
    expect(idle).toHaveLength(0)
  })

  // 安全弁: 先読みが済む前に出すことになったら、その場で本物を流す（空のまま出さない・前の地震を出さない）
  it('先読みの前に出すことになったら、その場で流し、予約は取り消す', () => {
    const f = fakeMap()
    const r = render(view(f.map, [region('A')], true))
    r.rerender(view(f.map, [region('A')], false))
    const next = [region('B'), region('C')]
    r.rerender(view(f.map, next, false))
    r.rerender(view(f.map, next, true))
    expect(f.calls).toEqual([1, 0, 2])
    idle.forEach((cb) => cb())
    expect(f.calls).toEqual([1, 0, 2])
  })
})
