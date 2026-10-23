/**
 * カードを、タブの枠の中で見える位置へ寄せる（地震カードの一覧と緊急地震速報のカードで共有する）。
 *
 * 寄せる量は津波カードの追従と同じ `planFollowScroll` が決める。収まっていれば動かさず、
 * 外れていればカードの頭を枠の上端から余白を取って揃え、枠より高いカードは頭に揃える。
 * 以前の `scrollIntoView({ block: 'nearest' })` は、枠より高いカードに対して「上端揃え・
 * 下端揃え・何もしない」のどれになるかが直前の位置で変わり、余白も取らずに縁を切っていた
 * （→ docs/spec/quake-spec.md §8「一覧の寄せ方」）。
 */
import { useLayoutEffect, useRef } from 'react'
import { planFollowScroll } from '../utils/ttsFollow'
import { log } from '../utils/logger'

/** 縦にスクロールする最も近い祖先（タブごとの枠。`App.tsx` の `TAB_SCROLLER_CLASS`）。 */
export function scrollParentOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const overflowY = getComputedStyle(p).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return p
  }
  return null
}

/**
 * 枠が見つからないことを記録したか。**アプリ全体で 1 回だけ** —— フックはカードの枚数ぶんあり、
 * 原因（レイアウトの組み方）は共通なので、1 回で足りる。
 */
let warnedNoScroller = false

/**
 * `signature` が変わったときだけ、`findTarget` が返す要素を寄せる。
 *
 * **寄せるのは合図（`signature`）が変わったときだけ。** 利用者がスクロールして読んでいる位置を、
 * 関係のない更新で動かさない。`null` は「寄せる相手が無い」。**`null` を挟んでも、前と同じ合図では
 * 寄せ直さない** —— 寄せ直したい場面（語り終えてから、また語り始めた等）は、呼び出し側が合図を変える。
 *
 * **寄せられなかった合図は持ち越す。** 基準の要素がまだ描かれていない（読み込み中）・枠の高さが 0
 * （パネルを畳んでいる）ときは何もせず、次に描かれたとき、または枠の寸法が変わったときにやり直す。
 * パネルの開閉・比率の変更は CSS 変数だけで起き、呼び出し側を描き直さないことがある（memo が止める）
 * ので、枠を `ResizeObserver` で見張る。見張りを持たない環境（テストの jsdom）では張らない。
 *
 * @param anchorRef 枠を探す起点（寄せる相手そのものでも、それを含む一覧でもよい）
 * @param findTarget 寄せる相手。見つからなければ `null`（そのときは持ち越す）
 */
export function useFollowScroll(
  anchorRef: React.RefObject<HTMLElement | null>,
  signature: string | null,
  findTarget: () => HTMLElement | null,
): void {
  const appliedRef = useRef<string | null>(null)
  // 見張りのコールバックから最新の値を読むため（レンダーごとに書き換える）。
  const latestRef = useRef({ signature, findTarget })
  latestRef.current = { signature, findTarget }
  const observerRef = useRef<{ observer: ResizeObserver; scroller: HTMLElement } | null>(null)

  // 寄せを試みる。寄せられない回（基準が無い・枠の高さが 0・相手が無い）は合図を書かずに返す。
  const tryApply = useRef(() => {
    const { signature: sig, findTarget: find } = latestRef.current
    if (sig === null || appliedRef.current === sig) return
    const anchor = anchorRef.current
    if (!anchor) return
    const scroller = scrollParentOf(anchor)
    if (!scroller) {
      // 持ち越しても自然には直らない（レイアウトの組み方が変わった）。黙ると寄せが止まったことに誰も気づけない。
      if (!warnedNoScroller) {
        warnedNoScroller = true
        log.warn(`[scroll] 縦にスクロールする枠が祖先に見つからないため、カードを寄せられません（合図 ${sig}）`)
      }
      return
    }
    if (typeof ResizeObserver === 'function' && observerRef.current?.scroller !== scroller) {
      observerRef.current?.observer.disconnect()
      const observer = new ResizeObserver(() => tryApply.current())
      observer.observe(scroller)
      observerRef.current = { observer, scroller }
    }
    if (scroller.clientHeight <= 0) return
    const target = find()
    if (!target) return
    appliedRef.current = sig
    const view = scroller.getBoundingClientRect()
    const rect = target.getBoundingClientRect()
    const next = planFollowScroll({
      viewTop: view.top,
      viewBottom: view.top + scroller.clientHeight,
      currentRects: [{ top: rect.top, bottom: rect.bottom }],
      upcomingRects: [],
      currentScrollTop: scroller.scrollTop,
      maxScrollTop: scroller.scrollHeight - scroller.clientHeight,
    })
    if (next !== null) scroller.scrollTo({ top: next, behavior: 'smooth' })
  })

  // 依存を持たせない: 寄せられなかった合図を、次のレンダーでも拾い直すため（判定は軽い）。
  useLayoutEffect(() => { tryApply.current() })
  // 外したら覚えも捨てる。残すと、開発時の StrictMode の付け外しの後で「同じ枠を見張っている」と
  // 取り違えて張り直さず、パネルを開き直しても寄らなくなる。
  useLayoutEffect(() => () => {
    observerRef.current?.observer.disconnect()
    observerRef.current = null
  }, [])
}
