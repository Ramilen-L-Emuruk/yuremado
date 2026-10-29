import { describe, it, expect } from 'vitest'
import { lngLatBoundsForCamera, mercatorBoxForCamera } from './cameraViewBounds'

const tokyo = { center: [139.77, 35.68] as [number, number], zoom: 6, bearing: 0, pitch: 0 }

describe('lngLatBoundsForCamera', () => {
  it('向きも傾きも無い画は、画面の幅ぶんの経度を中心の左右へ半分ずつ取る（正）', () => {
    const b = lngLatBoundsForCamera(tokyo, 1920, 1080)!
    // マップズーム 6 で世界の幅は 512×64 px。画面 1920 px はその 1920/32768 にあたる。
    const span = (1920 / (512 * 2 ** 6)) * 360
    expect(b.east - b.west).toBeCloseTo(span, 6)
    expect((b.east + b.west) / 2).toBeCloseTo(139.77, 6)
    expect(b.north).toBeGreaterThan(35.68)
    expect(b.south).toBeLessThan(35.68)
  })

  it('90 度回した画は、縦と横を入れ替えた広さになる', () => {
    const flat = lngLatBoundsForCamera(tokyo, 1920, 1080)!
    const turned = lngLatBoundsForCamera({ ...tokyo, bearing: 90 }, 1920, 1080)!
    expect(turned.east - turned.west).toBeCloseTo(((1080 / (512 * 2 ** 6)) * 360), 6)
    expect(turned.east - turned.west).toBeLessThan(flat.east - flat.west)
  })

  it('傾けた画は広めに見積もる（取りこぼす側へ外さない）', () => {
    const flat = mercatorBoxForCamera(tokyo, 1920, 1080)!
    const tilted = mercatorBoxForCamera({ ...tokyo, pitch: 45 }, 1920, 1080)!
    expect(tilted.x1 - tilted.x0).toBeGreaterThan(flat.x1 - flat.x0)
    expect(tilted.y1 - tilted.y0).toBeGreaterThan(flat.y1 - flat.y0)
  })

  it('寸法が取れない・ズームや中心が数でないときは null（安全弁）', () => {
    expect(lngLatBoundsForCamera(tokyo, 0, 1080)).toBeNull()
    expect(lngLatBoundsForCamera({ ...tokyo, zoom: Number.NaN }, 1920, 1080)).toBeNull()
    expect(lngLatBoundsForCamera({ ...tokyo, center: [Number.NaN, 35] }, 1920, 1080)).toBeNull()
  })
})
