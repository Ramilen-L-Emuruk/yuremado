import { describe, expect, it } from 'vitest'
import {
  SLIP_LOOP_MS, SLIP_SHIFT, add, axisVector, blockFaces, clipPolygon, cross, dot, faultFrame, fromScreen, initialView, scale, slipProgress, toScreen, unit, visibleFaces, isDrawableAxis, isDrawablePlane, lowerHemisphereVisibility,
  type Vec3,
} from './faultGeometry'

const close = (a: Vec3, b: Vec3, eps = 1e-9) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], -Math.log10(eps)))

describe('faultFrame', () => {
  const reverse = { strike: 47, dip: 37, rake: 100 }

  it('走向・傾斜・法線は互いに直角の単位ベクトル', () => {
    const f = faultFrame(reverse)
    for (const v of [f.strike, f.dip, f.normal, f.slip]) expect(Math.hypot(...v)).toBeCloseTo(1, 9)
    expect(dot(f.strike, f.dip)).toBeCloseTo(0, 9)
    expect(dot(f.strike, f.normal)).toBeCloseTo(0, 9)
    expect(dot(f.dip, f.normal)).toBeCloseTo(0, 9)
    // すべりは断層面の中（法線と直角）
    expect(dot(f.slip, f.normal)).toBeCloseTo(0, 9)
  })

  it('法線は上盤の側（上向き）を向く', () => {
    expect(faultFrame(reverse).normal[2]).toBeLessThan(0)
  })

  it('逆断層（すべり角 +90°）は上盤が上へ、正断層（−90°）は下へ、横ずれ（0°）は水平に動く', () => {
    // z は下向きが正
    expect(faultFrame({ strike: 0, dip: 40, rake: 90 }).slip[2]).toBeLessThan(0)
    expect(faultFrame({ strike: 0, dip: 40, rake: -90 }).slip[2]).toBeGreaterThan(0)
    expect(faultFrame({ strike: 0, dip: 40, rake: 0 }).slip[2]).toBeCloseTo(0, 9)
  })

  it('取得した P 軸・T 軸と、節面から求めた向きが同じ（USGS の能登の解。P 310°/4°・T 68°/81°）', () => {
    const f = faultFrame({ strike: 49.23, dip: 41.32, rake: 102.5 })
    const t = unit(add(f.normal, f.slip))
    const p = unit(add(f.normal, scale(f.slip, -1)))
    // 軸は向きの無い直線（逆向きも同じ軸）なので、内積の大きさで比べる
    expect(Math.abs(dot(t, axisVector({ azimuth: 68, plunge: 81 })))).toBeGreaterThan(Math.cos(1.5 * Math.PI / 180))
    expect(Math.abs(dot(p, axisVector({ azimuth: 310, plunge: 4 })))).toBeGreaterThan(Math.cos(1.5 * Math.PI / 180))
  })
})

describe('axisVector', () => {
  it('北向き水平・東向き水平・真下', () => {
    close(axisVector({ azimuth: 0, plunge: 0 }), [1, 0, 0])
    close(axisVector({ azimuth: 90, plunge: 0 }), [0, 1, 0])
    close(axisVector({ azimuth: 123, plunge: 90 }), [0, 0, 1])
  })
})

describe('toScreen / fromScreen', () => {
  it('回して戻すと元の向きになる', () => {
    const v: Vec3 = [0.3, -0.7, 0.5]
    const view = { yaw: 1.1, pitch: -0.4 }
    close(fromScreen(toScreen(v, view), view), v, 1e-9)
  })

  it('向きを変えても長さは変わらない', () => {
    const v: Vec3 = [0.3, -0.7, 0.5]
    expect(Math.hypot(...toScreen(v, { yaw: 2, pitch: 0.9 }))).toBeCloseTo(Math.hypot(...v), 9)
  })

  it('北を上にして下を奥にして見下ろすと、東は右に来る（鏡に映した像にならない。ユーザー発言「北を上にして、下を奥にしたとき、東が左に来る」の直し）', () => {
    const view = { yaw: 0, pitch: Math.PI / 2 }
    close(toScreen([1, 0, 0], view), [0, 1, 0], 1e-9)
    close(toScreen([0, 0, 1], view), [0, 0, -1], 1e-9)
    close(toScreen([0, 1, 0], view), [1, 0, 0], 1e-9)
  })

  it('画面の座標は右手系（右 × 上 = 手前）。世界の座標も右手系（北 × 東 = 下）なので、向きを変えても行列式は +1', () => {
    for (const view of [{ yaw: 0, pitch: 0 }, { yaw: 1.3, pitch: -0.7 }, { yaw: -2.2, pitch: 1.1 }]) {
      const n = toScreen([1, 0, 0], view), e = toScreen([0, 1, 0], view), d = toScreen([0, 0, 1], view)
      expect(dot(cross(n, e), d)).toBeCloseTo(1, 9)
    }
    // 画面の右 × 上 = 手前（東 × 上 = 手前＝南向き）
    const e = toScreen([0, 1, 0], { yaw: 0, pitch: 0 }), up = toScreen([0, 0, -1], { yaw: 0, pitch: 0 })
    close(cross(e, up), [0, 0, 1], 1e-9)
  })

  it('真上（上向き）は、見下ろすほど画面の手前側へ向く', () => {
    const up: Vec3 = [0, 0, -1]
    expect(toScreen(up, { yaw: 0, pitch: 0 })[1]).toBeCloseTo(1, 9)
    expect(toScreen(up, { yaw: 0, pitch: Math.PI / 2 })[2]).toBeCloseTo(1, 9)
  })
})

describe('slipProgress', () => {
  const at = (r: number) => slipProgress(r * SLIP_LOOP_MS)

  it('止まる → なめらかにずれる → ずれた位置で止まる（正）', () => {
    expect(at(0)).toBe(0)
    expect(at(0.14)).toBe(0)
    expect(at(0.2)).toBeGreaterThan(0)
    expect(at(0.35)).toBeGreaterThan(at(0.25))
    expect(at(0.55)).toBeCloseTo(1, 9)
    expect(at(0.7)).toBe(1)
    expect(at(0.84)).toBe(1)
  })

  it('ずれたあとは戻る途中を通らず、ぱっと元の位置へ（対照。0.84 で 1、0.86 で 0）', () => {
    expect(at(0.84)).toBe(1)
    expect(at(0.86)).toBe(0)
    // 0.85 から 1 まで、ずれ量は 0 のまま
    for (const r of [0.86, 0.9, 0.95, 0.999]) expect(at(r)).toBe(0)
  })

  it('ずれている間は一方向へだけ進み、途中で戻らない（安全弁）', () => {
    let prev = 0
    for (let r = 0.15; r <= 0.55; r += 0.01) {
      const v = at(r)
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12)
      prev = v
    }
  })

  it('ひと巡りで同じ値に戻る（負の時刻でも）', () => {
    expect(slipProgress(1234)).toBeCloseTo(slipProgress(1234 + SLIP_LOOP_MS), 9)
    expect(slipProgress(-100)).toBeCloseTo(slipProgress(SLIP_LOOP_MS - 100), 9)
  })
})

describe('lowerHemisphereVisibility（上半球を消した球で見える点）', () => {
  const down: Vec3 = [0, 0, 1], up: Vec3 = [0, 0, -1]

  it('上半球の点は、どの向きからでも見えない（正）', () => {
    for (const view of [{ yaw: 0, pitch: Math.PI / 2 }, { yaw: 1, pitch: 0.3 }, { yaw: 2, pitch: -1 }]) {
      expect(lowerHemisphereVisibility(up, view)).toBe('hidden')
      expect(lowerHemisphereVisibility([0.3, 0.2, -0.9], view)).toBe('hidden')
    }
  })

  it('真上から見下ろすと、下半球は内側が全部見える（表の震源球と同じ並び。真下も縁の水平の点も）', () => {
    const view = { yaw: 0, pitch: Math.PI / 2 }
    expect(lowerHemisphereVisibility(down, view)).toBe('visible')
    expect(lowerHemisphereVisibility([1, 0, 0], view)).toBe('visible')
    expect(lowerHemisphereVisibility(unit([0.5, 0.5, 0.7]), view)).toBe('visible')
  })

  it('真下から見上げると、下半球の外側が見える', () => {
    expect(lowerHemisphereVisibility(down, { yaw: 0, pitch: -Math.PI / 2 })).toBe('visible')
  })

  it('横から見ると、手前の下半球は見え、その奥の下半球は手前に隠れる（対照）', () => {
    const view = { yaw: 0, pitch: 0 }
    expect(lowerHemisphereVisibility([-0.6, 0, 0.8], view)).toBe('visible')
    expect(lowerHemisphereVisibility([0.6, 0, 0.8], view)).toBe('occluded')
  })
})

describe('clipPolygon', () => {
  const square: Vec3[] = [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]]

  it('平面の片側だけを残す', () => {
    const half = clipPolygon(square, [1, 0, 0], 1, 1)
    expect(half.every(p => p[0] >= 1 - 1e-9)).toBe(true)
    expect(half.length).toBe(4)
  })

  it('全部が反対側なら空になる', () => {
    expect(clipPolygon(square, [1, 0, 0], 5, 1)).toEqual([])
  })
})

describe('blockFaces', () => {
  const frame = faultFrame({ strike: 47, dip: 37, rake: 100 })
  const centroid = (pts: Vec3[]): Vec3 => scale(pts.reduce((a, b) => add(a, b), [0, 0, 0] as Vec3), 1 / pts.length)

  it('下盤と上盤に、それぞれ断層面の切り口がある', () => {
    const faces = blockFaces(frame, 0)
    expect(faces.filter(f => f.kind === 'cut' && f.moving)).toHaveLength(1)
    expect(faces.filter(f => f.kind === 'cut' && !f.moving)).toHaveLength(1)
    expect(faces.some(f => f.kind === 'top' && f.moving)).toBe(true)
    expect(faces.some(f => f.kind === 'top' && !f.moving)).toBe(true)
  })

  it('動くのは上盤だけで、すべりの向きへ「ずれ量 × 飾りの量」だけずれる', () => {
    const a = blockFaces(frame, 0), b = blockFaces(frame, 1)
    expect(b.length).toBe(a.length)
    a.forEach((fa, i) => {
      const fb = b[i]
      const d = add(centroid(fb.points), scale(centroid(fa.points), -1))
      if (fa.moving) close(d, scale(frame.slip, SLIP_SHIFT), 1e-9)
      else close(d, [0, 0, 0], 1e-12)
    })
  })

  it('ずれる前は、上盤の面がすべて断層面の上盤の側にある（対照）', () => {
    for (const f of blockFaces(frame, 0)) {
      const side = f.points.map(p => dot(p, frame.normal))
      if (f.kind === 'cut') side.forEach(s => expect(Math.abs(s)).toBeLessThan(1e-9))
      else if (f.moving) side.forEach(s => expect(s).toBeGreaterThanOrEqual(-1e-9))
      else side.forEach(s => expect(s).toBeLessThanOrEqual(1e-9))
    }
  })

  it('ほぼ垂直な横ずれ断層でも、2 つの塊に切れる（安全弁）', () => {
    const faces = blockFaces(faultFrame({ strike: 20, dip: 85, rake: 5 }), 0.5)
    expect(faces.filter(f => f.kind === 'cut')).toHaveLength(2)
    expect(faces.some(f => f.moving)).toBe(true)
    expect(faces.some(f => !f.moving)).toBe(true)
  })
})

describe('visibleFaces', () => {
  const planes = [{ strike: 47, dip: 37, rake: 100 }, { strike: 215, dip: 54, rake: -90 }, { strike: 20, dip: 85, rake: 5 }]

  it('どの向きからでも、見る人に向いた面だけが並び、遠い側の塊が先に来る（正）', () => {
    for (const p of planes) {
      const frame = faultFrame(p)
      for (let yaw = -3.1; yaw <= 3.1; yaw += 0.35) {
        for (const pitch of [-1.2, -0.4, 0.3, 0.9, 1.4]) {
          const view = { yaw, pitch }
          const toViewer = fromScreen([0, 0, 1], view)
          const list = visibleFaces(blockFaces(frame, 1), frame, view)
          list.forEach(f => expect(dot(f.normal, toViewer)).toBeGreaterThan(0))
          const movingNear = dot(toViewer, frame.normal) > 0
          // 先に描く側（奥）の面がすべて、手前側の面より前に並ぶ
          const firstNear = list.findIndex(f => f.moving === movingNear)
          if (firstNear >= 0) expect(list.slice(firstNear).every(f => f.moving === movingNear)).toBe(true)
        }
      }
    }
  })

  it('ずれる前でも同じ（上盤と下盤の面が両方とも描かれる。安全弁）', () => {
    const frame = faultFrame(planes[0])
    const list = visibleFaces(blockFaces(frame, 0), frame, { yaw: 0.6, pitch: 0.5 })
    expect(list.some(f => f.moving)).toBe(true)
    expect(list.some(f => !f.moving)).toBe(true)
  })
})

describe('isDrawablePlane / isDrawableAxis', () => {
  it('傾斜が 0〜90° で、3 つとも数値なら描ける（正）', () => {
    expect(isDrawablePlane({ strike: 47, dip: 37, rake: 100 })).toBe(true)
    expect(isDrawablePlane({ strike: 0, dip: 0, rake: -180 })).toBe(true)
    expect(isDrawablePlane({ strike: 359.9, dip: 90, rake: 180 })).toBe(true)
  })

  it('傾斜が範囲外・数値でない値は描かない（対照。上盤の側が逆になる・黒い球になる）', () => {
    expect(isDrawablePlane({ strike: 47, dip: -1, rake: 100 })).toBe(false)
    expect(isDrawablePlane({ strike: 47, dip: 91, rake: 100 })).toBe(false)
    expect(isDrawablePlane({ strike: Number.NaN, dip: 37, rake: 100 })).toBe(false)
    expect(isDrawablePlane({ strike: 47, dip: 37, rake: Number.POSITIVE_INFINITY })).toBe(false)
  })

  it('主軸は方位と傾斜が数値のときだけ描ける', () => {
    expect(isDrawableAxis({ azimuth: 310, plunge: 4 })).toBe(true)
    expect(isDrawableAxis({ azimuth: Number.NaN, plunge: 4 })).toBe(false)
    expect(isDrawableAxis({ azimuth: 310, plunge: Number.POSITIVE_INFINITY })).toBe(false)
  })
})

describe('initialView', () => {
  it('逆断層・正断層は横から、横ずれは上から見下ろす', () => {
    expect(initialView({ strike: 47, dip: 37, rake: 100 }).pitch).toBeLessThan(0.8)
    expect(initialView({ strike: 215, dip: 54, rake: -90 }).pitch).toBeLessThan(0.8)
    expect(initialView({ strike: 20, dip: 85, rake: 5 }).pitch).toBeGreaterThan(1)
  })
})
