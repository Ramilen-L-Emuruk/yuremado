import { useCallback, useEffect, useRef, useState } from 'react'
import { useMessages } from '../../i18n/I18nProvider'
import type { NodalPlane, PrincipalAxes } from '../../services/relayAnalysis'
import {
  BLOCK_DEPTH, add, axisVector, blockFaces, clampPitch, cross, dot, faultFrame, initialView, isDrawableAxis, isDrawablePlane, scale, slipProgress,
  lowerHemisphereVisibility, toScreen, unit, visibleFaces, type HemisphereVisibility, type Vec3, type ViewAngles,
} from '../../utils/faultGeometry'
import { PULL, PUSH, momentTensor } from './Beachball'

interface Props { planes: readonly [NodalPlane, NodalPlane]; axes: PrincipalAxes | null }

/**
 * 震源球と断層のずれの 3D（解析の窓）。左が 3D の震源球（押し・引きと 2 つの節面・上盤のすべる向き・P 軸と T 軸）、
 * 右が地面を切った箱（上盤が節面のすべる向きへずれ、ずれきるとぱっと元の位置へ戻るのを繰り返す）。ドラッグで 2 つ一緒に回る。
 * ずれの量は見やすくした飾りで、向きは取得した角度のとおり。球は回したときにだけ、箱はずれの量が変わったときにだけ描き直す。
 * 節面の値が数値でない・傾斜が 0〜90° の外にあるときは、誤った向きの絵を出さないよう何も描かない
 */
export function FaultViewer3D({ planes, axes }: Props) {
  if (!isDrawablePlane(planes[0]) || !isDrawablePlane(planes[1])) return null
  return <Viewer planes={planes} axes={axes && isDrawableAxis(axes.p) && isDrawableAxis(axes.t) ? axes : null} />
}

function Viewer({ planes, axes }: Props) {
  const m = useMessages().quake.analysis
  const w = m.viewer
  const wrapRef = useRef<HTMLDivElement>(null)
  const ballRef = useRef<HTMLCanvasElement>(null)
  const blockRef = useRef<HTMLCanvasElement>(null)
  const viewRef = useRef<ViewAngles>(initialView(planes[0]))
  /** 断層として箱とすべりに使う節面（0 = 断層面解1、1 = 断層面解2）。どちらが実際の断層かは震源球だけでは決まらない */
  const [planeIx, setPlaneIx] = useState<0 | 1>(0)
  /** 球の上半球（上向きの方向）を出すか。表の震源球は下半球だけなので、消すと真上から見て表の図と並びが同じになる。初めは出す */
  const [showUpper, setShowUpper] = useState(true)
  const dataRef = useRef<Data>({ planes, plane: planeIx, upper: showUpper, axes, words: { north: w.north, east: w.east, down: w.down, p: m.axisLetters.p, t: m.axisLetters.t } })
  const clockRef = useRef<{ ms: number; last: number | null }>({ ms: 0, last: null })
  /** 表示の幅（CSS ピクセル）。描くたびに読むと強制レイアウトになるので、大きさが変わったときに控える */
  const sizeRef = useRef({ ball: 0, block: 0 })
  const dirtyRef = useRef({ ball: true, block: true })
  const lastProgressRef = useRef(-1)
  const visibleRef = useRef(true)
  const failedRef = useRef(false)
  const [failed, setFailed] = useState(false)
  const rafRef = useRef(0)
  const [paused, setPaused] = useState(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  const pausedRef = useRef(paused)
  const drawRef = useRef<() => void>(() => {})

  const request = useCallback(() => {
    if (rafRef.current === 0) rafRef.current = requestAnimationFrame(() => { rafRef.current = 0; drawRef.current() })
  }, [])

  // 描く関数（毎回の組み直しを避け、最新の値は ref から読む）
  useEffect(() => {
    const clock = clockRef.current
    drawRef.current = () => {
      if (failedRef.current) return
      const now = performance.now()
      const playing = !pausedRef.current && !document.hidden && visibleRef.current
      if (playing) {
        clock.ms += clock.last === null ? 0 : Math.min(100, now - clock.last)
        clock.last = now
      } else {
        clock.last = null
      }
      try {
        const ball = ballRef.current, block = blockRef.current
        if (ball && dirtyRef.current.ball && sizeRef.current.ball >= 2) {
          drawBall(ball, sizeRef.current.ball, dataRef.current, viewRef.current)
          dirtyRef.current.ball = false
        }
        const progress = slipProgress(clock.ms)
        if (block && sizeRef.current.block >= 2 && (dirtyRef.current.block || progress !== lastProgressRef.current)) {
          drawBlock(block, sizeRef.current.block, dataRef.current, viewRef.current, progress)
          dirtyRef.current.block = false
          lastProgressRef.current = progress
        }
      } catch (cause) {
        // 描けなくなったら、毎フレーム投げ続けず止め、枠の中に「描画に失敗しました。」を出す（2026-11-18 ユーザー発言「描画に失敗しました。ぐらいは出してほしい。」）
        failedRef.current = true
        console.error('解析の 3D の描画に失敗しました', cause)
        setFailed(true)
        return
      }
      if (playing) request()
    }
    request()
  }, [request])

  // 値が変わったとき（別の解へ切り替え・言語の切り替え）は描き直す。向きと時刻は保つ
  useEffect(() => {
    dataRef.current = { planes, plane: planeIx, upper: showUpper, axes, words: { north: w.north, east: w.east, down: w.down, p: m.axisLetters.p, t: m.axisLetters.t } }
    dirtyRef.current = { ball: true, block: true }
    request()
  }, [planes, planeIx, showUpper, axes, w.north, w.east, w.down, m.axisLetters.p, m.axisLetters.t, request])

  useEffect(() => {
    pausedRef.current = paused
    clockRef.current.last = null
    request()
  }, [paused, request])

  // 大きさが変わったら描き直す。非表示（タブ・画面の外）の間は止まっていて、戻ったら再開する
  useEffect(() => {
    const ro = typeof ResizeObserver === 'function'
      ? new ResizeObserver(entries => {
        for (const e of entries) {
          if (e.target === ballRef.current) sizeRef.current.ball = e.contentRect.width
          else if (e.target === blockRef.current) sizeRef.current.block = e.contentRect.width
        }
        dirtyRef.current = { ball: true, block: true }
        request()
      })
      : null
    for (const c of [ballRef.current, blockRef.current]) if (c && ro) ro.observe(c)
    const io = typeof IntersectionObserver === 'function' && wrapRef.current
      ? new IntersectionObserver(entries => {
        visibleRef.current = entries.some(e => e.isIntersecting)
        request()
      })
      : null
    if (io && wrapRef.current) io.observe(wrapRef.current)
    document.addEventListener('visibilitychange', request)
    return () => {
      ro?.disconnect()
      io?.disconnect()
      document.removeEventListener('visibilitychange', request)
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
  }, [request])

  const rotate = useCallback((dx: number, dy: number) => {
    const v = viewRef.current
    viewRef.current = { yaw: v.yaw + dx, pitch: clampPitch(v.pitch + dy) }
    dirtyRef.current = { ball: true, block: true }
    request()
  }, [request])

  const drag = useRef<{ x: number; y: number } | null>(null)
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, y: e.clientY }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    rotate((e.clientX - d.x) * 0.01, (e.clientY - d.y) * 0.01)
    drag.current = { x: e.clientX, y: e.clientY }
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = 0.12
    const d = e.key === 'ArrowLeft' ? [-step, 0] : e.key === 'ArrowRight' ? [step, 0] : e.key === 'ArrowUp' ? [0, -step] : e.key === 'ArrowDown' ? [0, step] : null
    if (!d) return
    e.preventDefault()
    e.stopPropagation()
    rotate(d[0], d[1])
  }

  return (
    // 見出し・ボタン・図は同じ幅（窓が広くても、ボタンが図から離れないよう、全体で 36rem までにする）
    <div className="flex flex-col gap-1.5 self-start" style={{ width: 'min(100%, 36rem)' }}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        <h3 className="m-0 text-xs font-semibold text-white">{w.title}</h3>
        <div className="flex flex-wrap items-center gap-1.5">
          {/* 下半球投影（気象庁の語。表の震源球と同じく下半球だけを見せる）。押すと上半球を消し、真上から見て表の図と並びが同じになる。初めは押されていない（上半球が出ている） */}
          <button type="button" aria-pressed={!showUpper} onClick={(e) => { e.stopPropagation(); setShowUpper(v => !v) }}
            className={`whitespace-nowrap rounded border border-border px-2 py-0.5 text-[11px] ${showUpper ? 'text-secondary hover:text-white' : 'bg-[#24303d] text-white'}`}>{w.lowerProjection}</button>
          {/* どちらの節面を断層として箱とすべりに出すか。語は表の見出しと同じ（震源球だけでは、どちらが実際の断層かは決まらない） */}
          <div className="flex divide-x divide-border overflow-hidden rounded border border-border text-[11px]">
            {([m.col.plane1, m.col.plane2] as const).map((name, i) => (
              <button key={i} type="button" aria-pressed={planeIx === i} onClick={(e) => { e.stopPropagation(); setPlaneIx(i as 0 | 1) }}
                className={`whitespace-nowrap px-2 py-0.5 ${planeIx === i ? 'bg-[#24303d] text-white' : 'text-secondary hover:text-white'}`}>{name}</button>
            ))}
          </div>
          <button type="button" onClick={(e) => { e.stopPropagation(); setPaused(p => !p) }}
            className="rounded border border-border px-2 py-0.5 text-[11px] text-secondary hover:bg-white/10 hover:text-white">{paused ? w.play : w.pause}</button>
        </div>
      </div>
      {/* 縦の動きは窓のスクロールへ渡す（タッチでは横の動きだけが回転。縦の回転はマウスと矢印キー） */}
      <div ref={wrapRef} role="img" aria-label={w.title} tabIndex={0} onKeyDown={onKeyDown}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}
        className="grid w-full grid-cols-2 gap-2 rounded-md border border-border bg-[#171b22] p-1.5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-white/60"
        style={{ touchAction: 'pan-y' }}>
        {failed ? (
          <div role="alert" className="col-span-2 flex aspect-[2/1] items-center justify-center text-secondary">{w.failed}</div>
        ) : (
          <>
            <canvas ref={ballRef} aria-hidden="true" className="block aspect-square w-full cursor-grab active:cursor-grabbing" />
            <canvas ref={blockRef} aria-hidden="true" className="block aspect-square w-full cursor-grab active:cursor-grabbing" />
          </>
        )}
      </div>
    </div>
  )
}

interface Data { planes: readonly [NodalPlane, NodalPlane]; plane: 0 | 1; upper: boolean; axes: PrincipalAxes | null; words: { north: string; east: string; down: string; p: string; t: string } }

const AXIS_P = '#ff9a4d'
const AXIS_T = '#5cc8ff'
const SLIP = '#7fe08a'
const NODAL = '#ffcf5c'

/** キャンバスの内部の大きさを、表示の幅 × 画素比に合わせる（最大 2 倍）。表示の幅は呼び出し側が控えた値 */
function fit(c: HTMLCanvasElement, cssWidth: number): { g: CanvasRenderingContext2D; size: number; dpr: number } {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const size = Math.round(cssWidth * dpr)
  if (c.width !== size || c.height !== size) { c.width = size; c.height = size }
  const g = c.getContext('2d')
  if (!g) throw new Error('キャンバスの 2D の描画面が取れません')
  return { g, size, dpr }
}

function arrow(g: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, col: string, dpr: number, alpha = 1): void {
  g.save()
  g.globalAlpha = alpha
  g.strokeStyle = col
  g.fillStyle = col
  g.lineWidth = 2.5 * dpr
  g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke()
  const a = Math.atan2(y2 - y1, x2 - x1), h = 8 * dpr
  g.beginPath(); g.moveTo(x2, y2)
  g.lineTo(x2 - h * Math.cos(a - 0.4), y2 - h * Math.sin(a - 0.4))
  g.lineTo(x2 - h * Math.cos(a + 0.4), y2 - h * Math.sin(a + 0.4))
  g.closePath(); g.fill()
  g.restore()
}

function label(g: CanvasRenderingContext2D, text: string, x: number, y: number, col: string, dpr: number, bold = false): void {
  g.save()
  g.fillStyle = col
  g.font = `${bold ? 'bold ' : ''}${11 * dpr}px sans-serif`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(text, x, y)
  g.restore()
}

/** 球の画素の入れ物（大きさが変わるまで使い回す。円の外は書かないので透明のまま残る） */
const imageCache = new WeakMap<HTMLCanvasElement, ImageData>()

/** 3D の震源球（全周）。押し・引きの色は画素ごとに、方向 → 震源から出る P 波の押し引き（モーメントテンソルとの積の符号） */
function drawBall(c: HTMLCanvasElement, cssWidth: number, d: Data, view: ViewAngles): void {
  const { g, size, dpr } = fit(c, cssWidth)
  const centre = size / 2
  const R = size / 2 - 16 * dpr
  const t = momentTensor(d.planes[0])
  g.clearRect(0, 0, size, size)
  const x0 = Math.floor(centre - R), y0 = Math.floor(centre - R), span = Math.ceil(R * 2) + 1
  let img = imageCache.get(c)
  if (!img || img.width !== span) { img = g.createImageData(span, span); imageCache.set(c, img) }
  const data = img.data
  // 回転は画素の外で 1 回だけ（画素ごとに配列を作らない）。式は `fromScreen` と同じ
  const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch)
  // 画面の点（x, y, 奥行き z）の方向の押し引きの大きさ。その方向の下向きの成分は `dn` へ（下半球かの判定に使う）
  let dn = 0
  const ampAt = (x: number, y: number, z: number): number => {
    const z1 = -y * sp + z * cp
    const n = -(x * sy + z1 * cy), e = x * cy - z1 * sy
    dn = -(y * cp + z * sp)
    return t.xx * n * n + t.yy * e * e + t.zz * dn * dn + 2 * (t.xy * n * e + t.xz * n * dn + t.yz * e * dn)
  }
  // 上半球を出さないとき（表の震源球と同じく下半球だけ）は、手前の面が上半球ならその奥の下半球の内側を描く。出すときは手前の面だけ
  for (let py = 0; py < span; py++) {
    const y = (centre - (py + y0)) / R
    for (let px = 0; px < span; px++) {
      const x = (px + x0 - centre) / R, r2 = x * x + y * y
      if (r2 > 1) continue
      const z = Math.sqrt(1 - r2)
      const i = (py * span + px) * 4
      let amp = ampAt(x, y, z)
      let shade = 0.55 + 0.45 * (-0.35 * x + 0.45 * y + 0.82 * z)
      if (dn < 0 && !d.upper) {
        amp = ampAt(x, y, -z)
        if (dn < 0) { data[i + 3] = 0; continue }
        shade = 0.9
      }
      const base = amp > 0 ? PUSH : PULL
      data[i] = base[0] * shade
      data[i + 1] = base[1] * shade
      data[i + 2] = base[2] * shade
      data[i + 3] = 255
    }
  }
  g.putImageData(img, x0, y0)
  // 球の輪郭（上半球を消したときは、消した分も薄く残す）
  if (!d.upper) {
    g.strokeStyle = 'rgba(154,164,181,.35)'
    g.lineWidth = dpr
    g.beginPath(); g.arc(centre, centre, R, 0, Math.PI * 2); g.stroke()
  }
  const P = (v: Vec3): [number, number, number] => { const s = toScreen(v, view); return [centre + s[0] * R, centre - s[1] * R, s[2]] }
  // 点・線の見え方。上半球を出すときは手前の面（奥行きが正）だけが見え、奥は薄く。消すときは下半球だけ（上半球は描かない）
  const visOf = (v: Vec3): HemisphereVisibility => (d.upper ? (toScreen(v, view)[2] > 0 ? 'visible' : 'occluded') : lowerHemisphereVisibility(v, view))
  const frames = [faultFrame(d.planes[0]), faultFrame(d.planes[1])] as const
  const fr = frames[d.plane]
  // 2 つの節面（大円）。下半球の部分だけを描き、手前に隠れる所は薄く。断層として選んだ節面は太く
  const circle = (nrm: Vec3, chosen: boolean) => {
    const e1 = unit(cross(nrm, Math.abs(nrm[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]))
    const e2 = cross(nrm, e1)
    let prev: { p: [number, number, number]; vis: HemisphereVisibility } | null = null
    for (let k = 0; k <= 120; k++) {
      const th = (k / 120) * Math.PI * 2
      const v = add(scale(e1, Math.cos(th)), scale(e2, Math.sin(th)))
      const cur = { p: P(v), vis: visOf(v) }
      if (prev && prev.vis !== 'hidden' && cur.vis !== 'hidden') {
        const solid = prev.vis === 'visible' && cur.vis === 'visible'
        g.strokeStyle = solid ? NODAL : 'rgba(255,207,92,.28)'
        g.lineWidth = (solid ? (chosen ? 3.5 : 1.8) : 1.2) * dpr
        g.beginPath(); g.moveTo(prev.p[0], prev.p[1]); g.lineTo(cur.p[0], cur.p[1]); g.stroke()
      }
      prev = cur
    }
  }
  circle(frames[0].normal, d.plane === 0)
  circle(frames[1].normal, d.plane === 1)
  // 主軸（P・T）の点: 球の表面の 2 か所ずつ。上半球の側は描かない
  if (d.axes) {
    for (const [ax, col, text] of [[axisVector(d.axes.p), AXIS_P, d.words.p], [axisVector(d.axes.t), AXIS_T, d.words.t]] as const) {
      for (const sg of [1, -1]) {
        const v = scale(ax, sg)
        const vis = visOf(v)
        if (vis === 'hidden') continue
        const q = P(v)
        g.save()
        g.globalAlpha = vis === 'visible' ? 1 : 0.3
        g.fillStyle = col
        g.beginPath(); g.arc(q[0], q[1], 6 * dpr, 0, Math.PI * 2); g.fill()
        label(g, text, q[0], q[1], '#10141b', dpr, true)
        g.restore()
      }
    }
  }
  // 上盤のすべる向き（選んだ節面のもの）
  // 球の中心から球の面の手前まで（輪郭の円の内側に収め、消した上半球の側へ飛び出させない）
  const tip = P(scale(fr.slip, 0.92)), from = P(scale(fr.slip, 0.2))
  arrow(g, from[0], from[1], tip[0], tip[1], SLIP, dpr, tip[2] > -0.2 ? 1 : 0.35)
  // 方角の目印
  for (const [v, text] of [[[1, 0, 0], d.words.north], [[0, 1, 0], d.words.east], [[0, 0, 1], d.words.down]] as const) {
    const q = P(scale(v, 1.1))
    g.save(); g.globalAlpha = q[2] > -0.1 ? 1 : 0.4; label(g, text, q[0], q[1], '#9aa4b5', dpr); g.restore()
  }
}

/** 光の来る向き（北・東・下。下が正なので、負の下は上から） */
const LIGHT = unit([-0.4, -0.6, -0.7])

/** 地面を切った箱。2 つの塊を奥から手前へ描き、上盤だけをすべりの向きへずらす */
function drawBlock(c: HTMLCanvasElement, cssWidth: number, d: Data, view: ViewAngles, progress: number): void {
  const { g, size, dpr } = fit(c, cssWidth)
  const centre = size / 2
  const S = size * 0.27
  g.clearRect(0, 0, size, size)
  const fr = faultFrame(d.planes[d.plane])
  const P = (v: Vec3): [number, number, number] => {
    const s = toScreen([v[0], v[1], v[2] - BLOCK_DEPTH / 2], view)
    return [centre + s[0] * S, centre - s[1] * S, s[2]]
  }
  for (const face of visibleFaces(blockFaces(fr, progress), fr, view)) {
    const lam = Math.max(0, dot(face.normal, LIGHT))
    const k = 0.55 + 0.6 * lam
    const base = face.kind === 'top' ? [92, 160, 100] : face.moving ? [96, 130, 190] : [70, 84, 112]
    g.beginPath()
    face.points.forEach((p, i) => { const q = P(p); if (i === 0) g.moveTo(q[0], q[1]); else g.lineTo(q[0], q[1]) })
    g.closePath()
    g.fillStyle = face.kind === 'cut' ? `rgba(${Math.round(255 * k)},${Math.round(207 * k)},92,.7)` : `rgb(${Math.round(base[0] * k)},${Math.round(base[1] * k)},${Math.round(base[2] * k)})`
    g.fill()
    g.strokeStyle = 'rgba(15,18,24,.9)'
    g.lineWidth = dpr
    g.stroke()
  }
  // 上盤のすべる向き（箱の上に浮かべる）
  const a0v = scale(fr.dip, 0.45)
  const a0 = P(a0v), a1 = P(add(a0v, scale(fr.slip, 0.55)))
  arrow(g, a0[0], a0[1], a1[0], a1[1], SLIP, dpr)
  // 力のかかった向き: P 軸は両側から押す（内向き）、T 軸は両側へ引く（外向き）。取得した軸があるときだけ
  if (d.axes) {
    const centreV: Vec3 = [0, 0, BLOCK_DEPTH / 2]
    for (const [ax, inward, col, text] of [[axisVector(d.axes.p), true, AXIS_P, d.words.p], [axisVector(d.axes.t), false, AXIS_T, d.words.t]] as const) {
      for (const sg of [1, -1]) {
        const far = add(centreV, scale(ax, sg * 1.45)), near = add(centreV, scale(ax, sg * 1.05))
        const a = P(inward ? far : near), b = P(inward ? near : far)
        arrow(g, a[0], a[1], b[0], b[1], col, dpr)
      }
      const lp = P(add(centreV, scale(ax, 1.6)))
      label(g, text, lp[0], lp[1], col, dpr, true)
    }
  }
  const n = P([1.3, 0, 0])
  label(g, d.words.north, n[0], n[1], '#9aa4b5', dpr)
}
