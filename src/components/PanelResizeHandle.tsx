import { memo, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { PANEL_RATIO_MIN, PANEL_RATIO_MAX, PANEL_WIDTH_MIN_REM } from '../hooks/useSettings'
import { panelWidthRangePx, panelWidthRemFromPx, shownPanelWidthPx, type PanelWidthEnv } from '../utils/panelWidth'

// この距離（px）以内で指・マウスを離した場合はドラッグではなくタップとみなし、
// 折りたたみのトグルとして扱う。小さすぎると畳もうとして僅かに動いただけで
// リサイズ扱いになり、大きすぎると短いドラッグが勝手に折りたたみになる。
const TAP_THRESHOLD_PX = 6
// キーボード（上下キー）操作 1 回あたりの比率の変化量。
const KEY_STEP = 0.05
// キーボード（左右キー）操作 1 回あたりの幅の変化量（rem）。
const KEY_STEP_REM = 2

function clampRatio(ratio: number): number {
  return Math.min(PANEL_RATIO_MAX, Math.max(PANEL_RATIO_MIN, ratio))
}

/**
 * つまみのドラッグとタップの見分け。縦積み（高さの比率）と左右分割（幅）で共用する。
 *
 * `delta` は「パネルが広がる向き」へ動いた量（px）。パネルは地図の下・右にあるので、どちらも
 * 起点の座標から今の座標を引けば広がる向きが正になる。
 */
function useHandleDrag<V>(opts: {
  axis: 'x' | 'y'
  /** ドラッグを始めたときの値。以降は「開始位置からの移動量」で値を求める */
  begin: () => V | null
  /** 開始時の値と移動量から、今の値を求める。求められなければ null */
  valueAt: (start: V, delta: number) => V | null
  onChange: (value: V) => void
  onCommit: (value: V) => void
  onToggle: () => void
}) {
  // ドラッグ中の状態。moved=false のまま離されたらタップ（折りたたみトグル）と判定する。
  // pointerId を保持するのは、つまみに 2 本目の指が触れうるため。
  // 追跡中でない指のイベントは無視し、起点情報が上書きされないようにする。
  const dragRef = useRef<{ pointerId: number; startPos: number; start: V; moved: boolean; value: V } | null>(null)
  const pos = (e: ReactPointerEvent) => (opts.axis === 'x' ? e.clientX : e.clientY)

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // 既に別の指を追跡中なら、そちらを優先して 2 本目以降は無視する。
    if (dragRef.current) return
    const start = opts.begin()
    if (start === null) return
    // ポインタを捕捉して、指が地図やパネルの上へ滑ってもドラッグを継続させる。
    // 捕捉に失敗しても（無効な pointerId 等）ドラッグ自体は続行できるので、状態の初期化は必ず行う。
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch { /* 捕捉できない環境・状況では通常のイベント伝播にまかせる */ }
    dragRef.current = { pointerId: e.pointerId, startPos: pos(e), start, moved: false, value: start }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    // 閾値を超えるまではタップの可能性を残す（微小なブレでリサイズを始めない）。
    if (!drag.moved && Math.abs(pos(e) - drag.startPos) < TAP_THRESHOLD_PX) return
    // 閾値を超えた時点でドラッグと確定させる。値の計算の成否より先に立てるのが要点で、
    // 後に回すと「計算に失敗した長いドラッグ」が指を離した瞬間にタップ扱いとなり、
    // 意図しない折りたたみが起きる（危険側の誤動作）。
    drag.moved = true
    const next = opts.valueAt(drag.start, drag.startPos - pos(e))
    if (next === null) return
    drag.value = next
    opts.onChange(next)
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    // 追跡していない指が離れただけなら何もしない（2 本目の指で折りたたみが起きるのを防ぐ）。
    if (!drag || drag.pointerId !== e.pointerId) return
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    if (!drag.moved) {
      opts.onToggle()
      return
    }
    opts.onCommit(drag.value)
  }

  // ドラッグ中に他要素がポインタを奪った場合（システムジェスチャー等）。
  // 直前までの値は onChange で反映済みのため、確定させて状態を揃える。
  const onPointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    dragRef.current = null
    if (drag.moved) opts.onCommit(drag.value)
  }

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel }
}

interface Props {
  /** 現在のパネル高さ比率（0.2〜0.8）。折りたたみ中も「展開したときの比率」を保持する。 */
  ratio: number
  /** パネルが折りたたまれているか。つまみの見た目と aria-expanded に反映する。 */
  collapsed: boolean
  /** ドラッグ中の連続更新（設定への保存は行わない）。 */
  onRatioChange: (ratio: number) => void
  /** ドラッグ確定時の更新（設定へ保存する）。 */
  onRatioCommit: (ratio: number) => void
  /** タップ・Enter/Space による折りたたみトグル。 */
  onToggleCollapse: () => void
}

// 地図とパネルの境界に置くつまみ。縦積みレイアウト（スマホ縦など）専用で、
// 左右分割時（side ブレークポイント）は非表示になり、代わりに `PanelWidthHandle` が出る。
// ドラッグで地図とパネルの比率を変え、タップで折りたたみをトグルする。
export const PanelResizeHandle = memo(function PanelResizeHandle({
  ratio, collapsed, onRatioChange, onRatioCommit, onToggleCollapse,
}: Props) {
  const handleRef = useRef<HTMLDivElement>(null)
  // ドラッグ開始位置からの移動量でパネル高さ比率を求める。
  // ポインタの絶対位置から求めると、親コンテナ（地図＋つまみ＋パネル＋アイコンナビ）の
  // 下端とパネルの下端がナビの高さぶんずれているため、指とつまみの位置が離れていく。
  // 移動量ベースなら比率の変化量が指の移動量と 1 対 1 で対応する。
  const drag = useHandleDrag<number>({
    axis: 'y',
    begin: () => ratio,
    valueAt: (startRatio, delta) => {
      const container = handleRef.current?.parentElement
      if (!container) return null
      const height = container.getBoundingClientRect().height
      if (height <= 0) return null
      // 上へ動かすほどパネルが広がる（比率が増える）。
      return clampRatio(startRatio + delta / height)
    },
    onChange: onRatioChange,
    onCommit: onRatioCommit,
    onToggle: onToggleCollapse,
  })

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      // 上キーでパネルを広げ（地図が狭まる）、下キーで狭める。
      onRatioCommit(clampRatio(ratio + (e.key === 'ArrowUp' ? KEY_STEP : -KEY_STEP)))
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onToggleCollapse()
    }
  }

  return (
    <div
      ref={handleRef}
      role="separator"
      aria-orientation="horizontal"
      aria-label="地図と情報パネルの境界（ドラッグで高さ調整・タップで折りたたみ）"
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={Math.round(PANEL_RATIO_MIN * 100)}
      aria-valuemax={Math.round(PANEL_RATIO_MAX * 100)}
      aria-expanded={!collapsed}
      tabIndex={0}
      {...drag}
      onKeyDown={handleKeyDown}
      // touch-none（touch-action: none）でブラウザのスクロール・ズームジェスチャーより
      // ドラッグを優先する。これがないとタッチ操作でポインタイベントが途中で奪われる。
      className="side:hidden shrink-0 relative z-10 -mt-(--wave-overlap,0px) h-5 flex items-center justify-center bg-panel border-t border-border cursor-row-resize touch-none select-none focus:outline-hidden focus-visible:ring-1 focus-visible:ring-white/40"
    >
      <div
        className={`rounded-sm transition-all motion-reduce:transition-none ${collapsed ? 'w-14 h-1.5 bg-white/50' : 'w-10 h-1 bg-white/25'}`}
      />
    </div>
  )
})

/** 今の画面の寸法。ドラッグを始めるたびに読む（UI 倍率と画面の幅は変わりうる） */
function readPanelWidthEnv(): PanelWidthEnv | null {
  if (typeof window === 'undefined') return null
  const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize)
  if (!Number.isFinite(remPx) || remPx <= 0) return null
  return { viewportWidth: window.innerWidth, remPx }
}

interface WidthProps {
  /** 保存した幅（rem）。`null` は動かしていない（既定の幅） */
  widthRem: number | null
  /** 動かしていないときの幅（rem）。PC とスマホ横で違う */
  defaultRem: number
  /** パネルが折りたたまれているか。つまみの見た目と aria-expanded に反映する。 */
  collapsed: boolean
  /** ドラッグ中の連続更新（設定への保存は行わない）。 */
  onWidthChange: (rem: number) => void
  /** ドラッグ確定時・キー操作の更新（設定へ保存する）。 */
  onWidthCommit: (rem: number) => void
  /** タップ・Enter/Space による折りたたみトグル。 */
  onToggleCollapse: () => void
}

// 左右分割（side ブレークポイント）で地図とパネルの境に置く縦のつまみ。縦積みでは出さない。
// 横へのドラッグでパネルの幅を変え、タップで折りたたみをトグルする（2026-11-05 ユーザー選択「境に縦のつまみ (Recommended)」）。
// 幅 0 の箱の中に掴める帯を重ねて置くので、地図とパネルの幅は変わらない。
export const PanelWidthHandle = memo(function PanelWidthHandle({
  widthRem, defaultRem, collapsed, onWidthChange, onWidthCommit, onToggleCollapse,
}: WidthProps) {
  // 読み上げ用の値（aria-value*）に使う画面の寸法。**描画のたびには読まない**（ルートの文字の大きさを読むと
  // スタイルの計算をやり直させる）。画面の大きさが変わったときと、操作を始めたときに読み直す。
  const [env, setEnv] = useState<PanelWidthEnv | null>(readPanelWidthEnv)
  useEffect(() => {
    const onResize = () => setEnv(readPanelWidthEnv())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 畳んでいるときも、引き出す起点は展開したときの幅（縦積みのつまみが比率を保つのと同じ）
  const drag = useHandleDrag<{ px: number; env: PanelWidthEnv; rem: number }>({
    axis: 'x',
    begin: () => {
      const now = readPanelWidthEnv()
      if (!now) return null
      setEnv(now)
      const px = shownPanelWidthPx(widthRem, defaultRem, now)
      return { px, env: now, rem: panelWidthRemFromPx(px, now) }
    },
    // 左へ動かすほどパネルが広がる
    valueAt: (start, delta) => ({ ...start, rem: panelWidthRemFromPx(start.px + delta, start.env) }),
    onChange: (v) => onWidthChange(v.rem),
    onCommit: (v) => onWidthCommit(v.rem),
    onToggle: onToggleCollapse,
  })

  const range = env ? panelWidthRangePx(env) : null
  const shownRem = env ? shownPanelWidthPx(widthRem, defaultRem, env) / env.remPx : (widthRem ?? defaultRem)

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      const now = readPanelWidthEnv()
      if (!now) return
      setEnv(now)
      const px = shownPanelWidthPx(widthRem, defaultRem, now)
      // 左キーでパネルを広げ（地図が狭まる）、右キーで狭める。
      onWidthCommit(panelWidthRemFromPx(px + (e.key === 'ArrowLeft' ? 1 : -1) * KEY_STEP_REM * now.remPx, now))
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onToggleCollapse()
    }
  }

  return (
    <div className="hidden side:block relative w-0 shrink-0 z-20">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="地図と情報パネルの境界（ドラッグで幅調整・タップで折りたたみ）"
        aria-valuenow={Math.round(shownRem)}
        aria-valuemin={range && env ? Math.round(range.min / env.remPx) : PANEL_WIDTH_MIN_REM}
        aria-valuemax={range && env ? Math.round(range.max / env.remPx) : undefined}
        aria-expanded={!collapsed}
        tabIndex={0}
        {...drag}
        onKeyDown={handleKeyDown}
        // 地図側へ広く、パネル側へは 4px だけ掛ける（パネルの端のボタンや文字を奪わない）。指で触る画面は帯を広げる。
        // touch-none は縦積みのつまみと同じ理由
        className="group absolute inset-y-0 -left-2 w-3 pointer-coarse:-left-4 pointer-coarse:w-5 flex items-center justify-center cursor-col-resize touch-none select-none focus:outline-hidden focus-visible:ring-1 focus-visible:ring-white/40"
      >
        <div
          className={`rounded-sm transition-all motion-reduce:transition-none ${collapsed ? 'h-14 w-1.5 bg-white/50' : 'h-10 w-1 bg-white/25 group-hover:bg-white/45'}`}
        />
      </div>
    </div>
  )
})
