// @vitest-environment jsdom
//
// 海底地形の先読みが**録画モードのときだけ**走ることを固定する。
//
// 止めたいのは据え置きの端末が配信元へ毎時 1 巡ぶん（いまは 4,244 枚）のリクエストを出し続ける状態で、ブラウザ実測では
// 効いていることを確かめてある（2026-09-16 の実測: 録画 OFF で視野内のタイルだけ、録画 ON で 15 秒時点 1,753 件。
// 当時の 1 巡は 1,911 枚）。
// **その実測は、依存配列や早期 return を書き換えたときに再現されない。** 実測で分かるのは
// 「そのときのコードがそうだった」ことだけなので、条件そのものをここで押さえる。
//
// 先読みの中身（巡回・打ち切り・節約設定の判定）は `utils/gebcoPrefetch.test.ts` の担当。
// ここで見るのは**呼ばれるか・呼ばれないか**と、やめたときに止まるかだけ。
//
// 偽 map は `./testing/fakeMapGL`（同じ役割の代役は他にもある。役割の違いと寄せていない理由は
// `fakeMapGL.ts` の冒頭）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import type { Map as MapLibreMap } from 'maplibre-gl'

// `vi.mock` の factory は巻き上げられるので、スパイもそこから見える形で作る。
const { prefetchSpy, tileListSpy, flightListeners } = vi.hoisted(() => ({
  prefetchSpy: vi.fn<(signal: AbortSignal) => void>(),
  tileListSpy: vi.fn<(tiles: unknown[], signal: AbortSignal) => void>(),
  flightListeners: new Set<(t: { center: [number, number]; zoom: number; bearing: number; pitch: number }) => void>(),
}))

// **全置換にしない。** このモジュールは `BATHYMETRY_URL` と `GEBCO_*` の定数も export しており、
// `BaseMapGL` がラスタ層の定義に使う。原物を残して先読みの起動だけ差し替える。
vi.mock('../../utils/gebcoPrefetch', async importOriginal => ({
  ...(await importOriginal<typeof import('../../utils/gebcoPrefetch')>()),
  startBathymetryPrefetch: prefetchSpy,
  prefetchTileList: tileListSpy,
}))

// 寄せ始めの知らせは、受け手を手元に控えて直接呼ぶ（偽 map は fly/fit を持たない）。
vi.mock('./gl/camera', async importOriginal => ({
  ...(await importOriginal<typeof import('./gl/camera')>()),
  subscribeFlightTarget: (_map: unknown, listener: Parameters<typeof flightListeners.add>[0]) => {
    flightListeners.add(listener)
    return () => { flightListeners.delete(listener) }
  },
}))

// 地図の控えへ触る口は、本物の地図の中身が要るので差し替える。既定は「この版では使えない」で、
// 既存のテスト（HTTP の先読みだけの経路）はそのまま通る。控えへ載せる経路は下の describe で口を渡して見る。
const { resolveSpy, fillSpy } = vi.hoisted(() => ({
  resolveSpy: vi.fn<(map: unknown, sourceId: string) => unknown>(() => ({ kind: 'unsupported', reason: 'テストの既定' })),
  fillSpy: vi.fn<(access: unknown, tiles: { z: number }[], signal: AbortSignal, concurrency: number) => Promise<unknown>>(
    async () => ({ loaded: 0, skipped: 0, failed: 0, firstError: null, aborted: false, gaveUp: false, unread: 0 })),
}))
vi.mock('./gl/tileCacheAccess', async importOriginal => ({
  ...(await importOriginal<typeof import('./gl/tileCacheAccess')>()),
  resolveTileCacheAccess: resolveSpy,
  fillTileCache: fillSpy,
}))

// 陸地塗り・境界線は生成データ（遅延読込）の到着後に追加される。解決しない Promise で止めて、
// その後段（共有ソースの追加・区域ポップアップの登録）を走らせない。**このテストの対象は
// `[map, recording]` 依存の別の effect** なので、止めてもそちらは通る。
//
// reject でも空データでもなく pending にする理由: reject は取得失敗の警告を 2 本出してテストの
// 出力を汚し、空データは後段が走るぶん偽 map へ要求するメソッドが増える。
vi.mock('../../utils/prefectures', async importOriginal => ({
  ...(await importOriginal<typeof import('../../utils/prefectures')>()),
  loadPrefectures: () => new Promise<never>(() => {}),
}))
vi.mock('../../utils/subregions', async importOriginal => ({
  ...(await importOriginal<typeof import('../../utils/subregions')>()),
  loadSubRegions: () => new Promise<never>(() => {}),
}))

import { BaseMapGL } from './BaseMapGL'
import { MapGLContext } from './mapGLContext'
import { createFakeMapGL } from './testing/fakeMapGL'
import { RETRY_MS } from './gl/overviewHold'

// BaseMapGL の高解像度ラスタ層の id（同ファイルの `LYR_GEBCO`）。コンポーネントが実際に
// レンダーを終えたかどうかの目印に使う。
const LYR_GEBCO = 'gebco-raster'

interface Props {
  showBathymetry: boolean
  recording: boolean
}

function renderMap(map: MapLibreMap | null, props: Props) {
  const view = (p: Props) => (
    <MapGLContext.Provider value={map}>
      <BaseMapGL {...p} />
    </MapGLContext.Provider>
  )
  const result = render(view(props))
  return { update: (p: Props) => result.rerender(view(p)) }
}

/** 直近の呼び出しで渡された signal。まだ呼ばれていなければ落とす。 */
function signalOf(callIndex: number): AbortSignal {
  const call = prefetchSpy.mock.calls[callIndex]
  expect(call, `${callIndex + 1} 回目の呼び出しが無い`).toBeDefined()
  return call[0]
}

describe('海底地形の先読みは録画モードのときだけ走る', () => {
  beforeEach(() => {
    prefetchSpy.mockClear()
  })
  afterEach(cleanup)

  // 正
  it('録画モードなら先読みが始まる', () => {
    const fake = createFakeMapGL()
    renderMap(fake.map, { showBathymetry: true, recording: true })

    expect(prefetchSpy).toHaveBeenCalledTimes(1)
    expect(signalOf(0).aborted).toBe(false)
  })

  // 対照
  it('録画モードでなければ先読みは始まらない', () => {
    const fake = createFakeMapGL()
    renderMap(fake.map, { showBathymetry: true, recording: false })

    // **ラスタ層が載ったことを併せて見る。** 見ないと、コンポーネントが例外で
    // 何もしなかった場合にもこのテストは通ってしまい、対照として意味を持たない。
    expect(fake.layerIds()).toContain(LYR_GEBCO)
    expect(prefetchSpy).not.toHaveBeenCalled()
  })

  // 対照（もう一方の早期 return）
  it('map がまだ無い間は先読みを始めない', () => {
    renderMap(null, { showBathymetry: true, recording: true })

    expect(prefetchSpy).not.toHaveBeenCalled()
  })

  // 安全弁: やめたときに止まる
  it('録画モードを解くと、渡した signal が abort される', () => {
    const fake = createFakeMapGL()
    const { update } = renderMap(fake.map, { showBathymetry: true, recording: true })
    const signal = signalOf(0)
    expect(signal.aborted).toBe(false)

    update({ showBathymetry: true, recording: false })

    expect(signal.aborted).toBe(true)
    // 解いたあとに新しい巡回を始めていないこと。
    expect(prefetchSpy).toHaveBeenCalledTimes(1)
  })

  // 安全弁: 依存配列に余計なものを入れていない
  it('録画モードのまま他の props が変わっても二重に走らない', () => {
    // `showBathymetry` を依存配列へ足すと、海底地形の表示を切り替えるたびに
    // 巡回が積み増される（前の巡回は abort されるが、リクエストは出てしまう）。
    const fake = createFakeMapGL()
    const { update } = renderMap(fake.map, { showBathymetry: true, recording: true })

    update({ showBathymetry: false, recording: true })
    update({ showBathymetry: true, recording: true })

    expect(prefetchSpy).toHaveBeenCalledTimes(1)
    expect(signalOf(0).aborted).toBe(false)
  })

  // 安全弁: 切り直しても重ならない
  it('録画モードを入れ直すと、新しい signal で 1 本だけ走る', () => {
    const fake = createFakeMapGL()
    const { update } = renderMap(fake.map, { showBathymetry: true, recording: true })
    const first = signalOf(0)

    update({ showBathymetry: true, recording: false })
    update({ showBathymetry: true, recording: true })

    expect(prefetchSpy).toHaveBeenCalledTimes(2)
    const second = signalOf(1)
    expect(second).not.toBe(first)
    // 前の巡回は止まっており、生きているのは新しい 1 本だけ。
    expect(first.aborted).toBe(true)
    expect(second.aborted).toBe(false)
  })

  // 安全弁: 画面を閉じたら止まる（録画モードのまま外れる経路）
  it('画面から外れると signal が abort される', () => {
    const fake = createFakeMapGL()
    renderMap(fake.map, { showBathymetry: true, recording: true })
    const signal = signalOf(0)

    cleanup()

    expect(signal.aborted).toBe(true)
  })
})

describe('録画モードでは寄せ始めに着地先のタイルを取りに行く', () => {
  const target = { center: [139.77, 35.68] as [number, number], zoom: 8, bearing: 0, pitch: 0 }
  const withPane = (map: MapLibreMap) =>
    Object.assign(map, { getContainer: () => ({ clientWidth: 1920, clientHeight: 1080 }) })

  beforeEach(() => {
    prefetchSpy.mockClear()
    tileListSpy.mockClear()
    flightListeners.clear()
  })
  afterEach(cleanup)

  it('録画モードなら、知らせを受けて着地先のタイルを渡す（正）', () => {
    const fake = createFakeMapGL()
    renderMap(withPane(fake.map), { showBathymetry: true, recording: true })
    expect(flightListeners.size).toBe(1)

    for (const l of flightListeners) l(target)

    expect(tileListSpy).toHaveBeenCalledTimes(1)
    expect(tileListSpy.mock.calls[0][0].length).toBeGreaterThan(0)
    expect(tileListSpy.mock.calls[0][1].aborted).toBe(false)
  })

  it('録画モードでなければ購読しない（対照）', () => {
    const fake = createFakeMapGL()
    renderMap(withPane(fake.map), { showBathymetry: true, recording: false })
    expect(flightListeners.size).toBe(0)
  })

  it('次の寄せが来たら前のぶんを打ち切り、録画モードを解くと購読をやめて打ち切る（安全弁）', () => {
    const fake = createFakeMapGL()
    const { update } = renderMap(withPane(fake.map), { showBathymetry: true, recording: true })
    for (const l of flightListeners) l(target)
    for (const l of flightListeners) l({ ...target, center: [130, 33] })
    const first = tileListSpy.mock.calls[0][1]
    const second = tileListSpy.mock.calls[1][1]
    expect(first.aborted).toBe(true)
    expect(second.aborted).toBe(false)

    update({ showBathymetry: true, recording: false })

    expect(second.aborted).toBe(true)
    expect(flightListeners.size).toBe(0)
  })

  it('着地先のタイルが前の寄せと同じなら、打ち切らず投げ直しもしない', () => {
    const fake = createFakeMapGL()
    renderMap(withPane(fake.map), { showBathymetry: true, recording: true })
    for (const l of flightListeners) l(target)
    for (const l of flightListeners) l({ ...target })

    expect(tileListSpy).toHaveBeenCalledTimes(1)
    expect(tileListSpy.mock.calls[0][1].aborted).toBe(false)

    // 別の画へ寄せたあと元の画へ戻れば、また取りに行く
    for (const l of flightListeners) l({ ...target, center: [130, 33] })
    for (const l of flightListeners) l(target)
    expect(tileListSpy).toHaveBeenCalledTimes(3)
  })
})

describe('録画モードでは下地のタイルを地図の控えへ先に載せる', () => {
  const target = { center: [-100, 15] as [number, number], zoom: 6, bearing: 0, pitch: 0 }
  const withPane = (map: MapLibreMap) =>
    Object.assign(map, { getContainer: () => ({ clientWidth: 1920, clientHeight: 1080 }) })
  /** 控えの口の代役。reserve で上げた枚数と、戻したかを覚える。 */
  const makeAccess = () => {
    const restore = vi.fn()
    const access = { has: () => false, load: async () => true, reserve: vi.fn((_extra: number) => restore), isCurrent: vi.fn(() => true) }
    return { access, restore }
  }

  beforeEach(() => {
    prefetchSpy.mockClear()
    tileListSpy.mockClear()
    flightListeners.clear()
    resolveSpy.mockReset()
    fillSpy.mockClear()
  })
  afterEach(cleanup)

  it('口が作れたら、帯と全球の低い z を控えへ載せ、上限をその枚数だけ上げる（正）', () => {
    const { access } = makeAccess()
    resolveSpy.mockReturnValue({ kind: 'ready', access })
    const fake = createFakeMapGL()
    renderMap(withPane(fake.map), { showBathymetry: true, recording: true })

    expect(resolveSpy).toHaveBeenCalledWith(fake.map, 'gebco-overview')
    expect(access.reserve).toHaveBeenCalledWith(290)
    expect(fillSpy).toHaveBeenCalledTimes(1)
    const [, tiles, signal] = fillSpy.mock.calls[0]
    expect(tiles).toHaveLength(290)
    expect(tiles.every(t => t.z <= 5)).toBe(true)
    expect(signal.aborted).toBe(false)
  })

  it('寄せ始めには、下地のぶんを控えへ載せ、HTTP の先読みには高解像度のぶんだけを渡す（正）', () => {
    const { access } = makeAccess()
    resolveSpy.mockReturnValue({ kind: 'ready', access })
    const fake = createFakeMapGL()
    renderMap(withPane(fake.map), { showBathymetry: true, recording: true })
    fillSpy.mockClear()

    for (const l of flightListeners) l(target)

    expect(fillSpy).toHaveBeenCalledTimes(1)
    const overview = fillSpy.mock.calls[0][1]
    expect(overview.length).toBeGreaterThan(0)
    expect(overview.every(t => t.z <= 5)).toBe(true)
    const rest = tileListSpy.mock.calls[0][0] as { z: number }[]
    expect(rest.length).toBeGreaterThan(0)
    expect(rest.every(t => t.z > 5)).toBe(true)
  })

  it('録画モードでなければ口を作らない（対照）', () => {
    const fake = createFakeMapGL()
    renderMap(withPane(fake.map), { showBathymetry: true, recording: false })
    expect(resolveSpy).not.toHaveBeenCalled()
    expect(fillSpy).not.toHaveBeenCalled()
  })

  it('この版で使えなければ控えへは載せず、寄せ始めのタイルはすべて HTTP の先読みへ渡す（安全弁）', () => {
    resolveSpy.mockReturnValue({ kind: 'unsupported', reason: 'テスト' })
    const fake = createFakeMapGL()
    renderMap(withPane(fake.map), { showBathymetry: true, recording: true })

    for (const l of flightListeners) l(target)

    expect(fillSpy).not.toHaveBeenCalled()
    const all = tileListSpy.mock.calls[0][0] as { z: number }[]
    expect(all.some(t => t.z <= 5)).toBe(true)
    expect(all.some(t => t.z > 5)).toBe(true)
  })

  it('まだ口が作れなければ、少し置いて試し直す', () => {
    vi.useFakeTimers()
    try {
      const { access } = makeAccess()
      resolveSpy.mockReturnValueOnce({ kind: 'notYet', reason: 'テスト' }).mockReturnValue({ kind: 'ready', access })
      const fake = createFakeMapGL()
      renderMap(withPane(fake.map), { showBathymetry: true, recording: true })
      expect(fillSpy).not.toHaveBeenCalled()

      vi.advanceTimersByTime(RETRY_MS)

      expect(access.reserve).toHaveBeenCalledTimes(1)
      expect(fillSpy).toHaveBeenCalledTimes(1)
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it('録画モードを解くと、載せている途中のぶんを打ち切り、上げた上限を戻す（安全弁）', () => {
    const { access, restore } = makeAccess()
    resolveSpy.mockReturnValue({ kind: 'ready', access })
    const fake = createFakeMapGL()
    const { update } = renderMap(withPane(fake.map), { showBathymetry: true, recording: true })
    const holdSignal = fillSpy.mock.calls[0][2]

    update({ showBathymetry: true, recording: false })

    expect(holdSignal.aborted).toBe(true)
    expect(restore).toHaveBeenCalledTimes(1)
  })
  it('ソースが作り直されて口が古くなったら、上限を戻して口を作り直す', () => {
    const first = makeAccess()
    const second = makeAccess()
    resolveSpy.mockReturnValueOnce({ kind: 'ready', access: first.access }).mockReturnValue({ kind: 'ready', access: second.access })
    const fake = createFakeMapGL()
    renderMap(withPane(fake.map), { showBathymetry: true, recording: true })
    first.access.isCurrent.mockReturnValue(false)

    for (const l of flightListeners) l(target)

    expect(first.restore).toHaveBeenCalledTimes(1)
    expect(resolveSpy).toHaveBeenCalledTimes(2)
    expect(second.access.reserve).toHaveBeenCalledWith(290)
  })

  it('口ができる前の寄せと同じ行き先へもう一度寄せたら、下地を控えへ載せる', () => {
    const { access } = makeAccess()
    resolveSpy.mockReturnValueOnce({ kind: 'notYet', reason: 'テスト' }).mockReturnValue({ kind: 'ready', access })
    vi.useFakeTimers()
    try {
      const fake = createFakeMapGL()
      renderMap(withPane(fake.map), { showBathymetry: true, recording: true })
      for (const l of flightListeners) l(target)
      expect(tileListSpy).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(RETRY_MS)
      fillSpy.mockClear()

      for (const l of flightListeners) l(target)

      expect(fillSpy).toHaveBeenCalledTimes(1)
      expect(fillSpy.mock.calls[0][1].every(t => t.z <= 5)).toBe(true)
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })
})
