// 1 行に収まらない文を、右から左へ流し続けて見せる（2026-11-04 ユーザー選択「この形で作る」。
// 原文「スマホの帯が二行になってるのが気になりました。一行にしてはみ出たら自動でぐるぐる回る？ようにしたら？」
// 「最後まで行ったら戻るんじゃなくて、ループさせるのは？」）。
//
// - **収まるときは流さない。** 幅を測り、はみ出したときだけ流す
// - 流すときは同じ文を間を空けて 2 つ並べ、1 つぶん（文の幅＋間）進んだところで頭へ戻す。
//   2 つ目が 1 つ目のいた所にちょうど来るので、戻っても切れ目が見えない
// - **動きを減らす設定では流さず「…」で切る**（`index.css` の `.marquee-run`）
// - 読み上げ・支援技術には全文を 1 回だけ渡す（流すときに足す 2 つ目だけを `aria-hidden` にする。
//   1 つ目は普段の文のままなので、中身の文字を読むテストからも 1 回に見える）

import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

/** 流す速さ（px/秒）。 */
const SPEED_PX_PER_SEC = 40
/** 2 つ並べる文の間（em）。 */
const GAP_EM = 3

export function Marquee({ text, className = '', testId }: { text: string; className?: string; testId?: string }) {
  const boxRef = useRef<HTMLSpanElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)
  // 流すときの 1 周の距離（px）。null なら収まっているので流さない
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
  }, [text])

  return (
    <span ref={boxRef} data-testid={testId} className={`block min-w-0 overflow-hidden whitespace-nowrap ${className}`}>
      <span
        className={shift === null ? 'inline-block' : 'marquee-run'}
        style={shift === null ? undefined : {
          '--marquee-shift': `${shift}px`,
          animationDuration: `${shift / SPEED_PX_PER_SEC}s`,
        } as CSSProperties}
      >
        <span ref={textRef} className="inline-block">{text}</span>
        {shift !== null && <span aria-hidden className="inline-block" style={{ paddingLeft: `${GAP_EM}em` }}>{text}</span>}
      </span>
    </span>
  )
}
