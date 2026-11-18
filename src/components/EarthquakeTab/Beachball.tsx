import { useEffect, useRef } from 'react'
import type { NodalPlane } from '../../services/relayAnalysis'

/**
 * 発震機構の図（ビーチボール）。走向・傾斜・すべり角から、ダブルカップルの下半球投影（等積）を描き、
 * 押し（P 波の初動が押し）の象限を塗る（気象庁・USGS の図と同じ向き）。
 * 解析の窓の中だけで描く（48px・画素ごとに 1 回の計算で 1 万点ほど）。
 */
export function Beachball({ plane, size }: { plane: NodalPlane; size: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = Math.round(size * dpr)
    c.height = Math.round(size * dpr)
    const g = c.getContext('2d')
    if (!g) return
    const img = g.createImageData(c.width, c.height)
    const m = momentTensor(plane)
    const R = c.width / 2
    for (let py = 0; py < c.height; py++) {
      for (let px = 0; px < c.width; px++) {
        const x = (px - R) / R
        const y = (R - py) / R
        const r = Math.hypot(x, y)
        if (r > 1) continue
        const inc = 2 * Math.asin(Math.min(1, r / Math.SQRT2))
        const az = Math.atan2(x, y)
        const n0 = Math.sin(inc) * Math.cos(az), n1 = Math.sin(inc) * Math.sin(az), n2 = Math.cos(inc)
        const amp = m.xx * n0 * n0 + m.yy * n1 * n1 + m.zz * n2 * n2 + 2 * (m.xy * n0 * n1 + m.xz * n0 * n2 + m.yz * n1 * n2)
        const v = amp > 0 ? PUSH : PULL
        const i4 = (py * c.width + px) * 4
        img.data[i4] = v[0]
        img.data[i4 + 1] = v[1]
        img.data[i4 + 2] = v[2]
        img.data[i4 + 3] = 255
      }
    }
    g.putImageData(img, 0, 0)
    g.strokeStyle = '#666'
    g.lineWidth = dpr
    g.beginPath()
    g.arc(R, R, R - dpr / 2, 0, Math.PI * 2)
    g.stroke()
  }, [plane, size])
  return <canvas ref={ref} style={{ width: size, height: size }} className="shrink-0" aria-hidden="true" />
}

export const PUSH = [217, 72, 72] as const
export const PULL = [236, 236, 236] as const

/** 節面からモーメントテンソル（Aki & Richards。x 北・y 東・z 下）を作る */
export function momentTensor(p: NodalPlane): { xx: number; yy: number; zz: number; xy: number; xz: number; yz: number } {
  const d2r = Math.PI / 180
  const f = p.strike * d2r, d = p.dip * d2r, l = p.rake * d2r
  return {
    xx: -(Math.sin(d) * Math.cos(l) * Math.sin(2 * f) + Math.sin(2 * d) * Math.sin(l) * Math.sin(f) ** 2),
    xy: Math.sin(d) * Math.cos(l) * Math.cos(2 * f) + 0.5 * Math.sin(2 * d) * Math.sin(l) * Math.sin(2 * f),
    xz: -(Math.cos(d) * Math.cos(l) * Math.cos(f) + Math.cos(2 * d) * Math.sin(l) * Math.sin(f)),
    yy: Math.sin(d) * Math.cos(l) * Math.sin(2 * f) - Math.sin(2 * d) * Math.sin(l) * Math.cos(f) ** 2,
    yz: -(Math.cos(d) * Math.cos(l) * Math.sin(f) - Math.cos(2 * d) * Math.sin(l) * Math.cos(f)),
    zz: Math.sin(2 * d) * Math.sin(l),
  }
}
