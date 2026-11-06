import { useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'

/**
 * 地震タブの動き（2026-11-03 選択「カードの開閉」「カードの中の開閉」「新しい地震の差し込み」「取消の覆いをふわっと」。
 * 説明「どれも端末で『動きを減らす』を選んでいる人には動かさない」）。
 *
 * 高さの動きは Web Animations で付ける（CSS の `height: auto` への遷移は使えない端末がある）。動いている間だけ
 * はみ出しを切り、終わったら戻す。切り方は `overflow: clip`（{@link CLIP_OVERFLOW}）—— `hidden` は巻く箱を作るので、
 * 中の貼りつく見出しの段・震度の枠・帯が、動いている間だけ一覧に貼りつかなくなる。`clip` は巻く箱を作らない。
 */

/** カードを開く・畳むときの高さの動きの長さ。 */
export const CARD_RESIZE_MS = 180
/** カードの中（県・区域・市町村・補足・報の一覧）を開くときの長さ。 */
export const INNER_GROW_MS = 150
/** 新しい地震を一覧の先頭へ差し込む長さ。 */
export const ROW_INSERT_MS = 200
/** 取消の覆いを出す長さ。 */
export const CANCEL_FADE_MS = 250

/**
 * カードの高さの動きに付ける名前。一覧の寄せ（`useFollowScroll`）はこれが走っている間は待ち、
 * 伸び終えてから寄せる（伸びている途中の高さで寄せ方を決めないように）。
 */
export const CARD_RESIZE_ANIMATION_ID = 'quake-card-resize'

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
}

/** はみ出しの切り方。`clip` が使えない古い端末では `hidden`（動いている間だけ貼りつきが切れる）。 */
const CLIP_OVERFLOW = typeof CSS !== 'undefined' && CSS.supports?.('overflow', 'clip') ? 'clip' : 'hidden'

/** 高さを動かしている要素ごとの、いま走っている動きと、動かす前の `overflow`。 */
const resizing = new WeakMap<HTMLElement, { anim: Animation; overflow: string }>()
/**
 * いま高さを動かしている要素。`settleInner` が中の動きを探すのに使う。ページ中の動きを
 * `getAnimations({ subtree: true })` で集めると、開いたカードの中身の数だけ毎回なめることになり重い。
 */
const resizingEls = new Set<HTMLElement>()

/**
 * 要素の高さを `fromPx` から `toPx`（省略すると今の高さ）へ動かす。動かさない条件（動きを減らす・測れない）では null。
 *
 * - **同じ要素の先の動きは止めてから始める。** 重ねると、後の動きが先の動きの付けた切り方を
 *   「元の値」と取り違え、終わっても切ったままになる。元の値は最初の動きのときだけ控える
 * - `settleInner`: 中に動いているもの（開いた中身の伸び）があれば、先に終わらせてから行き先を測る。
 *   カードを開き直すと中の県・補足も一斉に 0 から伸び始め、そのまま測ると行き先が低く出る
 * - `fade`: 高さと一緒に薄さも動かす（`in` は薄くから濃く、`out` は濃くから薄く）。高さだけを動かすと、
 *   伸び縮みの途中で行が上半分だけ切れて見え、崩れたように見える
 */
export function resizeHeight(
  el: HTMLElement, fromPx: number, toPx: number | undefined, ms: number,
  opts: { id?: string; settleInner?: boolean; fade?: 'in' | 'out' } = {},
): Animation | null {
  if (prefersReducedMotion() || typeof el.animate !== 'function') return null
  const prev = resizing.get(el)
  const overflow = prev ? prev.overflow : el.style.overflow
  // 動きの途中で向きが変わったら、薄さもいまの値から動かす（0 か 1 から始めると、連打で明滅する）
  const opacityNow = prev ? parseFloat(getComputedStyle(el).opacity) : NaN
  if (prev) {
    resizing.delete(el)
    resizingEls.delete(el)
    prev.anim.cancel()
  }
  if (opts.settleInner) {
    for (const inner of [...resizingEls]) {
      if (inner !== el && el.contains(inner)) resizing.get(inner)?.anim.finish()
    }
  }
  const to = toPx ?? el.getBoundingClientRect().height
  if (!(to >= 0) || Math.abs(to - fromPx) < 1) {
    el.style.overflow = overflow
    return null
  }
  el.style.overflow = CLIP_OVERFLOW
  const fadeFrom = Number.isFinite(opacityNow) ? opacityNow : opts.fade === 'in' ? 0 : 1
  const from = { height: `${fromPx}px`, ...(opts.fade ? { opacity: fadeFrom } : {}) }
  const end = { height: `${to}px`, ...(opts.fade === 'in' ? { opacity: 1 } : opts.fade === 'out' ? { opacity: 0 } : {}) }
  const anim = el.animate([from, end], { duration: ms, easing: 'ease-in-out', fill: opts.fade === 'out' ? 'forwards' : 'none' })
  if (opts.id) anim.id = opts.id
  resizing.set(el, { anim, overflow })
  resizingEls.add(el)
  // 後から始まった動きに止められたときは、そちらが戻すので触らない
  const restore = () => {
    if (resizing.get(el)?.anim !== anim) return
    resizing.delete(el)
    resizingEls.delete(el)
    el.style.overflow = overflow
  }
  anim.finished.then(restore, restore)
  return anim
}

/** 要素の高さを `fromPx` から今の高さへ伸ばす（{@link resizeHeight} の短い形）。 */
export function growFrom(el: HTMLElement, fromPx: number, ms: number, id?: string, settleInner = false): Animation | null {
  return resizeHeight(el, fromPx, undefined, ms, { id, settleInner })
}

/** 要素を薄くから濃く出す。 */
export function fadeIn(el: HTMLElement, ms: number): void {
  if (prefersReducedMotion() || typeof el.animate !== 'function') return
  el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing: 'ease-out' })
}

/**
 * カードの中の開閉（県・区域・市町村・補足・報の一覧）。`open` が真の間は中身を出し、偽になったら
 * **中身を残したまま 0 まで縮めて薄くし、縮み終えてから外す**（2026-11-03 発言「カードの中の開閉ぎこちなくない？
 * 閉まるときアニメーション無いし」）。開くときは 0 から伸ばしながら濃くする。縮みかけで開き直したら、
 * いまの高さから伸ばし直す。初めから開いて描かれたとき（カードを開いた時点で開いていた県など）は動かさない
 * （外側が丸ごと伸びる）。
 *
 * - **動かすのは外側の箱だけ。** 余白・枠・詰め物（`className`・`style` など）は内側の箱に付ける。外側に付けると、
 *   高さを 0 にしても詰め物と余白が残り、縮み終えて外した瞬間に下の行が跳ぶ。外側は `flow-root` で
 *   内側の余白を自分の高さに含める（含めないと、余白が外へ抜けて同じ跳びになる）
 * - **中身は関数で受け、出している間だけ組み立てる。** 閉じている県の中身まで毎回組み立てると、観測点が
 *   千点ある地震では、閉じているだけで描き直しのたびに全点を作ることになる
 */
export function Reveal({ open, children, ...rest }: { open: boolean; children: () => ReactNode } & Omit<HTMLAttributes<HTMLDivElement>, 'children'>) {
  const [mounted, setMounted] = useState(open)
  const ref = useRef<HTMLDivElement>(null)
  // 縮みが終わる・止められたときに、そのとき開いているかを読む
  const openRef = useRef(open)
  openRef.current = open
  // 初めから開いて描かれたか（カードを開いた・上の県を開いた時点で、前から開いていた中身）
  const firstLayoutRef = useRef(true)
  if (open && !mounted) setMounted(true)
  // 外されたら「初回」に戻す（StrictMode の dev は付けて外して付け直すので、戻さないと 2 回目を初回でないと取り違える）
  useLayoutEffect(() => () => { firstLayoutRef.current = true }, [])
  useLayoutEffect(() => {
    const el = ref.current
    const first = firstLayoutRef.current
    firstLayoutRef.current = false
    if (!el) return
    if (open) {
      // 初めから開いて描かれた中身は動かさない。外側（カード・上の県）が丸ごと伸びるので、ここで伸ばしても
      // 外側の行き先を測るときに終わらせるだけになる。動かすと、開いた県の数だけ高さの読み取りと動きの
      // 片付けが走り、地震を切り替えた瞬間のフレームが落ちる
      if (first) return
      // 縮みかけなら、いまの高さから伸ばし直す
      const now = resizing.has(el) ? el.getBoundingClientRect().height : 0
      // 中に前から開いていた区域・市町村は、初めから開いて描かれるので動かない（上の `first`）。中でまだ動いている
      // もの（縮みかけの区域など）があれば、先に終わらせてから行き先を測る —— 途中の高さで行き先を決めると、
      // 伸び終えた所で中の分がいきなり足される（2026-11-03 発言「その中がすでに開いている場合アニメーションおかしくない？」）
      resizeHeight(el, now, undefined, INNER_GROW_MS, { fade: 'in', settleInner: true })
      return
    }
    const anim = resizeHeight(el, el.getBoundingClientRect().height, 0, INNER_GROW_MS, { fade: 'out' })
    if (!anim) {
      setMounted(false)
      return
    }
    // 開き直されて止められたとき（cancel）は外さない。ほかの理由で止められても、閉じたままなら外す
    const unmountIfClosed = () => { if (!openRef.current) setMounted(false) }
    anim.finished.then(unmountIfClosed, unmountIfClosed)
  }, [open, mounted])
  if (!mounted) return null
  return (
    <div ref={ref} style={{ display: 'flow-root' }}>
      <div {...rest}>{children()}</div>
    </div>
  )
}

/**
 * 開閉の印。▸ を開くと下向きへ回す（`turn` は開いたときの回し方。▸→▾ は 90 度、▾→▴ は 180 度）。
 * 文字を差し替えずに回すので、印の位置は動かない。
 */
export function DisclosureCaret({ open, glyph = '▸', turn = 90 }: { open: boolean; glyph?: string; turn?: number }) {
  return (
    <span
      aria-hidden
      className="inline-block transition-transform duration-150 ease-out motion-reduce:transition-none"
      style={{ transform: open ? `rotate(${turn}deg)` : undefined }}
    >
      {glyph}
    </span>
  )
}
