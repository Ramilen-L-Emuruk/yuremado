// 1 行に収まらない文を、右から左へ流して見せる（2026-11-04 ユーザー選択「この形で作る」。
// 原文「スマホの帯が二行になってるのが気になりました。一行にしてはみ出たら自動でぐるぐる回る？ようにしたら？」
// 「最後まで行ったら戻るんじゃなくて、ループさせるのは？」）。
//
// - **収まるときは流さない。** 幅を測り、はみ出したときだけ流す
// - 流し方は 2 つ。既定の `loop` は同じ文を、それぞれの後ろに間を付けて 2 つ並べ、1 つぶん（文の幅＋間）進んだところで
//   頭へ戻す。2 つ目が 1 つ目のいた所にちょうど来るので、戻っても切れ目が見えない。
//   `return` は文の末尾が右端に来るまで流し、少し止まってから頭へ戻り、少し止まってまた流す（電文ログの開いた行の名前。
//   2026-11-04 電文ログの見直しでのユーザー発言「この場合ループより先頭に戻るほうがいいかも」）
// - **動きを減らす設定では流さず「…」で切る**（`loop` は `index.css` の `.marquee-run`、`return` はこの中で見る）
// - 読み上げ・支援技術には全文を 1 回だけ渡す（`loop` で足す 2 つ目だけを `aria-hidden` にする。
//   1 つ目は普段の文のままなので、中身の文字を読むテストからも 1 回に見える）

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'

/** 流す速さ（px/秒）。 */
const SPEED_PX_PER_SEC = 40
/** `loop` で 2 つ並べる文の間（em）。 */
const GAP_EM = 3
/** `return` で両端に止まる長さ（ms）。 */
const RETURN_PAUSE_MS = 1500
/** `return` で頭へ戻る長さ（ms）。一瞬で飛ぶと、どこへ行ったか目で追えない */
const RETURN_BACK_MS = 400

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

export type MarqueeMode = 'loop' | 'return'

export function Marquee({ text, className = '', testId, mode = 'loop' }: {
  text: string
  className?: string
  testId?: string
  mode?: MarqueeMode
}) {
  const boxRef = useRef<HTMLSpanElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)
  // `loop` は 1 周の距離（文の幅＋間）、`return` ははみ出した幅（px）。null なら収まっているので流さない
  const [shift, setShift] = useState<number | null>(null)

  useLayoutEffect(() => {
    const box = boxRef.current
    const first = textRef.current
    if (!box || !first) return
    const measure = () => {
      const textWidth = first.getBoundingClientRect().width
      const boxWidth = box.getBoundingClientRect().width
      // 誤差で流したり止めたりを繰り返さないよう 0.5px の遊びを持たせる
      if (textWidth <= boxWidth + 0.5) {
        setShift(null)
        return
      }
      if (mode === 'return') {
        setShift(Math.round(textWidth - boxWidth))
        return
      }
      const gap = GAP_EM * parseFloat(getComputedStyle(first).fontSize)
      setShift(Math.round(textWidth + gap))
    }
    measure()
    // 見張れない環境（古い端末・試験の環境）では、最初に測った結果のまま
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(box)
    ro.observe(first)
    return () => ro.disconnect()
  }, [text, mode])

  if (mode === 'return') return <ReturnRun boxRef={boxRef} textRef={textRef} text={text} overflow={shift} className={className} testId={testId} />

  return (
    <span ref={boxRef} data-testid={testId} className={`block min-w-0 overflow-hidden whitespace-nowrap ${className}`}>
      <span
        className={shift === null ? 'inline-block' : 'marquee-run'}
        style={shift === null ? undefined : { animationDuration: `${shift / SPEED_PX_PER_SEC}s` } as CSSProperties}
      >
        {/* 流すときは 2 つの文それぞれの後ろに同じ間を付け、列の幅をちょうど 2 周ぶんにする。動きは列の半分（-50%）
            だけ進めるので、keyframes に測った値を持ち込まずに済む（合成の段だけで回せる形）。
            測るのは文そのもの（間を含まない内側）—— 間を含めて測ると、流し始めた途端に幅が変わって測り直しになる */}
        <span className="inline-block" style={shift === null ? undefined : { paddingRight: `${GAP_EM}em` }}>
          <span ref={textRef}>{text}</span>
        </span>
        {shift !== null && <span aria-hidden className="inline-block" style={{ paddingRight: `${GAP_EM}em` }}>{text}</span>}
      </span>
    </span>
  )
}

/**
 * `return` の流し方。止まる・流す・戻るの区切りが測った幅で変わるので、CSS の keyframes ではなく
 * Web Animations で組む（transform だけを動かすので、`loop` と同じく合成の段だけで回る）。
 */
function ReturnRun({ boxRef, textRef, text, overflow, className, testId }: {
  boxRef: RefObject<HTMLSpanElement>
  textRef: RefObject<HTMLSpanElement>
  text: string
  overflow: number | null
  className: string
  testId?: string
}) {
  const [reduced, setReduced] = useState(() => typeof matchMedia === 'function' && matchMedia(REDUCED_MOTION).matches)

  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const mq = matchMedia(REDUCED_MOTION)
    const onChange = () => setReduced(mq.matches)
    // Safari 13 以前の MediaQueryList は addEventListener を持たない（古い addListener だけ）
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    }
    mq.addListener(onChange)
    return () => mq.removeListener(onChange)
  }, [])

  useEffect(() => {
    const el = textRef.current
    // 動かせない環境（試験の環境）では止まったまま
    if (overflow === null || reduced || !el || typeof el.animate !== 'function') return
    const runMs = (overflow / SPEED_PX_PER_SEC) * 1000
    const total = RETURN_PAUSE_MS * 2 + runMs + RETURN_BACK_MS
    const at = (ms: number) => ms / total
    const anim = el.animate([
      { transform: 'translateX(0)', offset: 0 },
      { transform: 'translateX(0)', offset: at(RETURN_PAUSE_MS) },
      { transform: `translateX(${-overflow}px)`, offset: at(RETURN_PAUSE_MS + runMs) },
      { transform: `translateX(${-overflow}px)`, offset: at(RETURN_PAUSE_MS * 2 + runMs), easing: 'ease-in-out' },
      { transform: 'translateX(0)', offset: 1 },
    ], { duration: total, iterations: Infinity })
    return () => anim.cancel()
  }, [overflow, reduced, textRef])

  const truncate = overflow !== null && reduced
  return (
    <span ref={boxRef} data-testid={testId} className={`block min-w-0 overflow-hidden whitespace-nowrap ${truncate ? 'text-ellipsis' : ''} ${className}`}>
      <span ref={textRef} className={truncate ? 'inline' : 'inline-block'}>{text}</span>
    </span>
  )
}
