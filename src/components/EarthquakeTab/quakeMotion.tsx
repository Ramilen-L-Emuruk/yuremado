/**
 * 地震タブの動き（2026-11-03 選択「カードの開閉」「カードの中の開閉」「新しい地震の差し込み」「取消の覆いをふわっと」。
 * 説明「どれも端末で『動きを減らす』を選んでいる人には動かさない」）。
 *
 * 高さの動きは Web Animations で付ける（CSS の `height: auto` への遷移は使えない端末がある）。動いている間だけ
 * `overflow: hidden` にして、終わったら外す（開いたカードの中の貼りつく帯・枠は `overflow` の祖先で止まるため）。
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

/** 高さを動かしている要素ごとの、いま走っている動きと、動かす前の `overflow`。 */
const resizing = new WeakMap<HTMLElement, { anim: Animation; overflow: string }>()

/**
 * 要素の高さを `fromPx` から今の高さへ動かす。動かさない条件（動きを減らす・測れない）では null。
 *
 * - **同じ要素の先の動きは止めてから始める。** 重ねると、後の動きが先の動きの付けた `hidden` を
 *   「元の値」と取り違え、終わっても `overflow: hidden` が残る（貼りつく枠が効かなくなる）。元の値は最初の動きのときだけ控える
 * - `settleInner`: 中に動いているもの（開いた中身の伸び）があれば、先に終わらせてから行き先を測る。
 *   カードを開き直すと中の県・補足も一斉に 0 から伸び始め、そのまま測ると行き先が低く出る
 */
export function growFrom(el: HTMLElement, fromPx: number, ms: number, id?: string, settleInner = false): Animation | null {
  if (prefersReducedMotion() || typeof el.animate !== 'function') return null
  const prev = resizing.get(el)
  const overflow = prev ? prev.overflow : el.style.overflow
  if (prev) {
    resizing.delete(el)
    prev.anim.cancel()
  }
  if (settleInner) {
    for (const a of el.getAnimations?.({ subtree: true }) ?? []) {
      if (a.effect instanceof KeyframeEffect && a.effect.target !== el) a.finish()
    }
  }
  const to = el.getBoundingClientRect().height
  if (!(to > 0) || Math.abs(to - fromPx) < 1) {
    el.style.overflow = overflow
    return null
  }
  el.style.overflow = 'hidden'
  const anim = el.animate([{ height: `${fromPx}px` }, { height: `${to}px` }], { duration: ms, easing: 'ease-out' })
  if (id) anim.id = id
  resizing.set(el, { anim, overflow })
  // 後から始まった動きに止められたときは、そちらが戻すので触らない
  const restore = () => {
    if (resizing.get(el)?.anim !== anim) return
    resizing.delete(el)
    el.style.overflow = overflow
  }
  anim.finished.then(restore, restore)
  return anim
}

/** 要素を薄くから濃く出す。 */
export function fadeIn(el: HTMLElement, ms: number): void {
  if (prefersReducedMotion() || typeof el.animate !== 'function') return
  el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing: 'ease-out' })
}

/**
 * 中身を出した瞬間に、高さ 0 から伸ばす（カードの中の開閉）。要素の `ref` にそのまま渡す。
 * **関数は 1 つだけ（モジュールに置く）** —— 毎回作り直すと、描き直すたびに React が付け直して何度も伸びる。
 */
export function growInOnMount(el: HTMLElement | null): void {
  if (el) growFrom(el, 0, INNER_GROW_MS)
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
