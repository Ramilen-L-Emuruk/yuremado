import { useEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from 'react'
// 巻けるかは CSS の `overflow` で決める（いまあふれているかでは選ばない。開いた直後は一覧がまだ短い）
import { scrollParentOf } from '../../hooks/useFollowScroll'

/** 帯の高さを測る前に使う値（閉じた行の高さ。見本で 59px）。 */
const PIN_HEIGHT_GUESS_PX = 59
/** 帯を滑り下ろす・戻す長さ（2026-11-03 選択「帯を上から滑り下ろす」の説明「150ms ほど」）。 */
const BAND_SLIDE_MS = 150

/**
 * スマホ幅の開いたカードで、震度の枠が一覧の上へ出て見えなくなったら、閉じた行と同じ帯を上に貼りつける
 * （2026-11-02 選択「畳んだ行の帯 (Recommended)」。見本 opened.html の .pin）。
 *
 * 一覧が広い組（520px 以上）で地図とパネルが左右に並ぶときは、見出しの段と震度の枠そのものが貼りつく
 * （→ index.css の `quake-open-head`・`quake-stick`）ので、帯は CSS で隠す。上下に分かれるときは広い組でも帯を出す。
 * 高さ 0 の貼りつく箱に帯を吊るすので、帯が出ても下の中身は押し下げない。
 *
 * **カードの下端が来たら帯を上へ押し出す。** 吊るした帯はカードの外へはみ出せるので、押し出さないと
 * 下端を過ぎても次の行の上に被ったまま残る。貼りつく位置は一覧の見出しの行の下（`--qk-head-h`）。
 *
 * **見せる・隠すは `visibility` を親から受け継ぐ形にする。** タブは `invisible` の付け外しで切り替わるので、
 * ここで `visible` を明示すると、隠れたタブの上に帯だけが残る。
 *
 * 出すときは上から滑り下ろし、消すときは上へ戻す（2026-11-03 選択「帯を上から滑り下ろす」。説明「150ms ほど。
 * 端末で動きを減らす設定の人には動かさずに出す」）。押すとカードを畳む（`onActivate`。2026-11-03 選択
 * 「見出しも帯も閉じるだけ (Recommended)」）。取り消された地震では押せない（`onActivate` を渡さない）。
 * 帯の長周期の札（`data-tile-lpgm`）を押したときだけは畳まず、長周期地震動の節へ巻く（`onLpgmActivate`。
 * 同日選択「長周期の札→長周期の節へ」。説明「狭い画面の帯の札でも同じ」）。
 */
export function QuakeOpenPin({ targetRef, onActivate, onLpgmActivate, children }: {
  targetRef: RefObject<HTMLElement | null>
  onActivate: (() => void) | undefined
  onLpgmActivate: (() => void) | undefined
  children: ReactNode
}) {
  const [state, setState] = useState<{ show: boolean; shift: number }>({ show: false, shift: 0 })
  // 上へ戻している間も中身を残す（消した瞬間に空の帯が滑っていかないように）。外すのは遷移の長さが過ぎてから。
  // **時間で外す** —— 動きを減らす設定や、帯ごと隠している組（display: none）では遷移の終わりの合図が来ない
  const [rendered, setRendered] = useState(false)
  useEffect(() => {
    if (state.show) {
      setRendered(true)
      return
    }
    const id = window.setTimeout(() => setRendered(false), BAND_SLIDE_MS + 50)
    return () => window.clearTimeout(id)
  }, [state.show])
  const pinRef = useRef<HTMLDivElement>(null)
  const bandRef = useRef<HTMLDivElement>(null)
  const bandHeightRef = useRef(PIN_HEIGHT_GUESS_PX)
  useEffect(() => {
    const target = targetRef.current
    if (!target) return
    const card = target.closest<HTMLElement>('[data-quake-key]')
    let root: HTMLElement | null = null
    const update = () => {
      if (!root) return
      // 一覧の見出しの行の高さ。カードの scroll-margin-top と同じ値（px に解決済み）を読む
      const headPx = card ? parseFloat(getComputedStyle(card).scrollMarginTop) || 0 : 0
      const top = root.getBoundingClientRect().top + headPx
      // 枠が上へ抜けたときだけ出す（下にあってまだ見えていないときは出さない）。帯ごと隠している組では出さない
      const hidden = pinRef.current !== null && getComputedStyle(pinRef.current).display === 'none'
      const show = !hidden && target.getBoundingClientRect().bottom < top + 4
      const room = card ? card.getBoundingClientRect().bottom - top : Infinity
      const shift = Math.min(0, room - bandHeightRef.current)
      setState(prev => (prev.show === show && prev.shift === shift ? prev : { show, shift }))
    }
    const watch = () => {
      // 巻ける祖先は画面の向き・幅で入れ替わる（左右分割と上下分割で巻く箱が違う）ので、変わったら張り直す
      const next = scrollParentOf(target)
      if (next !== root) {
        root?.removeEventListener('scroll', update)
        root = next
        root?.addEventListener('scroll', update, { passive: true })
      }
      update()
    }
    watch()
    window.addEventListener('resize', watch)
    // 報の一覧・補足の開閉でカードの高さが変わったときも測り直す（巻かなくても枠の位置は動く）
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    if (ro && card) ro.observe(card)
    return () => {
      window.removeEventListener('resize', watch)
      root?.removeEventListener('scroll', update)
      ro?.disconnect()
    }
  }, [targetRef])
  // 出ている帯の高さを覚え、要素にも書く（押し出しの量と、節へ巻くときに差し引く量。字の大きさで変わるので
  // 決め打ちしない）。再描画を待たずに読めるよう、属性は直に書く（→ EarthquakeCard の pinBandHeight）
  useEffect(() => {
    if (!state.show || !bandRef.current || !pinRef.current) return
    const h = bandRef.current.getBoundingClientRect().height
    bandHeightRef.current = h
    pinRef.current.dataset.bandH = String(h)
  }, [state.show, rendered])
  const activate = state.show ? onActivate : undefined
  const onClick = (e: MouseEvent) => {
    if (onLpgmActivate && (e.target as HTMLElement).closest('[data-tile-lpgm]')) onLpgmActivate()
    else activate?.()
  }
  return (
    <div ref={pinRef} className="quake-pin sticky z-[3] h-0" style={{ top: 'var(--qk-head-h)', margin: '0 calc(-1 * var(--qk-pad))' }} aria-hidden={!state.show}>
      <div
        ref={bandRef}
        role={activate ? 'button' : undefined}
        tabIndex={activate ? 0 : undefined}
        aria-expanded={activate ? true : undefined}
        onClick={activate ? onClick : undefined}
        onKeyDown={activate ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate() } } : undefined}
        className={`border-b border-border bg-card transition-[transform,visibility] ease-out motion-reduce:transition-none ${state.show ? '' : 'invisible'} ${activate ? 'cursor-pointer' : ''}`}
        style={{
          padding: '7px var(--qk-pad)',
          transitionDuration: `${BAND_SLIDE_MS}ms`,
          boxShadow: '0 3px 8px rgba(0,0,0,.55)',
          // 隠すときは帯の高さぶん上へ。出すときは 0（カードの下端では上へ押し出す量）
          transform: state.show ? (state.shift < 0 ? `translateY(${state.shift}px)` : 'translateY(0)') : 'translateY(-100%)',
        }}
      >
        {/* 隠れている間は中身を描かない（同じ行が一覧に 2 つ並んで見えないように） */}
        {(state.show || rendered) && children}
      </div>
    </div>
  )
}
