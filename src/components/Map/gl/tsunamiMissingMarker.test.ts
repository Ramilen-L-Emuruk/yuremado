import { describe, it, expect, vi, afterEach } from 'vitest'
import type * as maplibregl from 'maplibre-gl'
import type { TsunamiMissingMarker } from '../../../hooks/useTsunamiLayerData'
import { drawTsunamiMissingMarkers, missingMarkMetrics } from './tsunamiMissingMarker'
import { TSUNAMI_MISSING_COLOR } from '../../../utils/tsunamiStyle'
import { log } from '../../../utils/logger'

// 欠測マーカーを共有カードへ描き直す処理。DOM の印は WebGL のキャンバスに写らないので、
// ここが描かなければ画像から欠測の観測点だけが消える（到達確認・観測棒は別の関数が描く）。

/** 描いた操作だけを記録する 2D コンテキストの代役。 */
function fakeContext() {
  const fills: string[] = []
  const rects: [number, number, number, number][] = []
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    globalAlpha: 1,
    shadowColor: '',
    shadowBlur: 0,
    save: vi.fn(),
    restore: vi.fn(),
    scale: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(() => { fills.push(ctx.fillStyle) }),
    fillRect: vi.fn((x: number, y: number, w: number, h: number) => { rects.push([x, y, w, h]) }),
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fills, rects }
}

/** 経緯度を 10 倍しただけの投影。`backSide` に入れた点は、戻すと別の場所になる（地球の裏側の扱い）。 */
function fakeMap(backSide: Set<string> = new Set()): maplibregl.Map {
  return {
    project: ([lng, lat]: [number, number]) => ({ x: lng * 10, y: lat * 10, lng, lat }),
    unproject: ([x, y]: [number, number]) => {
      const lng = x / 10
      const lat = y / 10
      return backSide.has(`${lng},${lat}`) ? { lng: lng + 90, lat } : { lng, lat }
    },
  } as unknown as maplibregl.Map
}

const marker = (name: string, lat: number, lng: number) => ({ name, lat, lng }) as TsunamiMissingMarker

afterEach(() => { vi.restoreAllMocks() })

describe('drawTsunamiMissingMarkers', () => {
  it('手前の面にある観測点へ、欠測の色の丸と中央の横棒を描く', () => {
    const { ctx, fills, rects } = fakeContext()
    drawTsunamiMissingMarkers(ctx, fakeMap(), 2, [marker('釜石', 39.27, 141.89)], 1)
    expect(fills).toEqual([TSUNAMI_MISSING_COLOR])
    const { length, thickness } = missingMarkMetrics(1)
    expect(rects).toHaveLength(1)
    const [x, y, w, h] = rects[0]!
    expect(w).toBe(length)
    expect(h).toBe(thickness)
    // 横棒の中心が観測点の位置に来る（論理 px。撮影の倍率は `ctx.scale` が掛ける）。
    expect(x + w / 2).toBeCloseTo(1418.9, 6)
    expect(y + h / 2).toBeCloseTo(392.7, 6)
    expect(ctx.scale).toHaveBeenCalledWith(2, 2)
  })

  // 対照: 地球の裏側と判定された点は描かない（球投影では裏側の点にも画面内の座標が返るため）。
  it('裏側の観測点は描かず、手前の点だけを描く', () => {
    const { ctx, rects } = fakeContext()
    const map = fakeMap(new Set(['141.89,39.27']))
    drawTsunamiMissingMarkers(ctx, map, 1, [marker('釜石', 39.27, 141.89), marker('宮古', 39.64, 141.98)], 1)
    expect(rects).toHaveLength(1)
    expect(rects[0]![0] + rects[0]![2] / 2).toBeCloseTo(1419.8, 6)
  })

  // 安全弁: 対象があるのに 1 つも描けなかったことは記録に残す（画像から黙って消える形にしない）。
  it('対象があるのに 1 つも描けなかったら警告を残す', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const { ctx, rects } = fakeContext()
    drawTsunamiMissingMarkers(ctx, fakeMap(new Set(['141.89,39.27'])), 1, [marker('釜石', 39.27, 141.89)], 1)
    expect(rects).toHaveLength(0)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('対象が無ければ何もしない（警告も出さない）', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const { ctx } = fakeContext()
    drawTsunamiMissingMarkers(ctx, fakeMap(), 1, [], 1)
    expect(ctx.save).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })
})
