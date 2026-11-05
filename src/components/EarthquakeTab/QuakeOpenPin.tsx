import { useEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from 'react'
// 巻けるかは CSS の `overflow` で決める（いまあふれているかでは選ばない。開いた直後は一覧がまだ短い）
import { scrollParentOf } from '../../hooks/useFollowScroll'
import { prefersReducedMotion } from './quakeMotion'

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
 * 下端を過ぎても次の行の上に被ったまま残る。貼りつく位置は一覧の見出しの行と日付の区切りの下
 * （`--qk-head-h` ＋ `--qk-day-h`）。
 *
 * **出すのは震度の枠が半分隠れたとき**（2026-11-05 ユーザー選択「枠が半分隠れたら」。それまでは枠が全部隠れてから）。
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
  const [state, setState] = useState<{ show: boolean }>({ show: false })
  // カードの下端で帯を押し上げる量（px。0 か負）。**React を通さず、巻いた合図の中で帯へ直に書く。**
  // state に入れると巻くたびに描き直し、帯が巻く指に描画 1 回ぶん遅れて付いてくる
  const shiftRef = useRef(0)
  const enteredRef = useRef(false)
  // 帯の段階。`rendered` は中身を描いているか、`entered` は下ろしきった位置に置くか、`sliding` は出し入れの最中か。
  // **出すときは、中身を描いて隠れた位置に置いた次の描画で下ろす。** 中身の無い帯は余白ぶんの高さしか無く、
  // 同じ描画で下ろすと「帯の高さぶん上」が十数 px にしかならず、滑り下りて見えない（引っ込めるときは中身があるので見えていた）。
  // 消すときも中身を残したまま上へ戻し、遷移の長さが過ぎてから外す（**時間で外す** —— 動きを減らす設定や、
  // 帯ごと隠している組（display: none）では遷移の終わりの合図が来ない）。
  const [phase, setPhase] = useState({ rendered: false, entered: false, sliding: false })
  useEffect(() => {
    if (state.show) {
      setPhase(p => (p.rendered ? p : { ...p, rendered: true }))
      // 隠れた位置で 1 度描かせてから下ろす（同じフレームにまとめられると遷移が始まらない）
      // 滑り終えの印は、下ろし始めたのと同じ所で仕掛ける（先に仕掛けると、描画が遅い端末では下ろす前に切れ、
      // 出し入れの最中の印が立ったまま残って押し出しにも遷移が掛かる）
      let id2 = 0
      let done = 0
      const id1 = requestAnimationFrame(() => {
        id2 = requestAnimationFrame(() => {
          setPhase({ rendered: true, entered: true, sliding: true })
          done = window.setTimeout(() => setPhase(p => (p.sliding ? { ...p, sliding: false } : p)), BAND_SLIDE_MS + 50)
        })
      })
      return () => { cancelAnimationFrame(id1); cancelAnimationFrame(id2); window.clearTimeout(done) }
    }
    setPhase(p => (p.entered || p.rendered ? { rendered: p.rendered, entered: false, sliding: true } : p))
    const id = window.setTimeout(() => setPhase(p => (p.rendered || p.sliding ? { rendered: false, entered: false, sliding: false } : p)), BAND_SLIDE_MS + 50)
    return () => window.clearTimeout(id)
  }, [state.show])
  const rendered = phase.rendered
  enteredRef.current = phase.entered
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
      // 上に貼りついて残る一覧の見出しの行と日付の区切りの高さ。カードの scroll-margin-top と同じ値（px に解決済み）を読む
      const headPx = card ? parseFloat(getComputedStyle(card).scrollMarginTop) || 0 : 0
      const top = root.getBoundingClientRect().top + headPx
      // 枠が半分より上へ抜けたら出す（下にあってまだ見えていないときは出さない）。帯ごと隠している組では出さない
      const hidden = pinRef.current !== null && getComputedStyle(pinRef.current).display === 'none'
      const box = target.getBoundingClientRect()
      const show = !hidden && box.top + box.height / 2 < top
      // 押し上げの量は、受け皿（高さ 0 の貼りつく箱）が今いる位置から測る。受け皿もカードの下端に近づくと
      // カードと一緒に上がるので、貼りつく位置（top）から測ると押し上げが二重に効く
      const pinTop = pinRef.current ? pinRef.current.getBoundingClientRect().top : top
      const room = card ? card.getBoundingClientRect().bottom - pinTop : Infinity
      const shift = Math.min(0, room - bandHeightRef.current)
      if (shift !== shiftRef.current) {
        shiftRef.current = shift
        if (enteredRef.current && bandRef.current) bandRef.current.style.transform = bandTransform(true, shift)
      }
      setState(prev => (prev.show === show ? prev : { show }))
    }
    const watch = (measure: boolean) => {
      // 巻ける祖先は画面の向き・幅で入れ替わる（左右分割と上下分割で巻く箱が違う）ので、変わったら張り直す
      const next = scrollParentOf(target)
      if (next !== root) {
        root?.removeEventListener('scroll', update)
        root = next
        root?.addEventListener('scroll', update, { passive: true })
      }
      if (measure) update()
    }
    // 報の一覧・補足の開閉でカードの高さが変わったときも測り直す（巻かなくても枠の位置は動く）
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    // 張った直後は測らず、ResizeObserver の初回の呼び出しに任せる（カードを開いた描き直しの中で位置を読むと、
    // レイアウトを 1 回余計に強いる。開いた直後は帯を出さないのが正しいので、初期値のままで困らない）
    watch(ro === null || card === null)
    const onResize = () => watch(true)
    window.addEventListener('resize', onResize)
    if (ro && card) ro.observe(card)
    return () => {
      window.removeEventListener('resize', onResize)
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
  // 押せるのは帯が見えてから（下ろす前の 2 描画ほどは見えない）
  const activate = state.show && phase.entered ? onActivate : undefined
  const onClick = (e: MouseEvent) => {
    if (onLpgmActivate && (e.target as HTMLElement).closest('[data-tile-lpgm]')) onLpgmActivate()
    else activate?.()
  }
  return (
    <div ref={pinRef} className="quake-pin sticky z-[3] h-0" style={{ top: 'calc(var(--qk-head-h) + var(--qk-day-h))', margin: '0 calc(-1 * var(--qk-pad))' }} aria-hidden={!state.show}>
      <div
        ref={bandRef}
        role={activate ? 'button' : undefined}
        tabIndex={activate ? 0 : undefined}
        aria-expanded={activate ? true : undefined}
        onClick={activate ? onClick : undefined}
        onKeyDown={activate ? (e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          // 札に止まっているときは長周期の節へ、それ以外は畳む（押したときと同じ振り分け）
          if (onLpgmActivate && (e.target as HTMLElement).closest('[data-tile-lpgm]')) onLpgmActivate()
          else activate()
        } : undefined}
        className={`border-b border-border bg-card ${phase.entered ? '' : 'invisible'} ${activate ? 'cursor-pointer quake-press-row' : ''}`}
        style={{
          padding: '7px var(--qk-pad)',
          // **遷移はここで書く。** 出ている間は押せる行の印（`quake-press-row`）が付き、その `transition: filter …` が
          // クラスで書いた遷移を上書きする（クラスに任せると、出るときだけ滑らない）。
          // 出し入れの最中だけ transform も遷移させ、押し出しには掛けない。動きを減らす設定なら掛けない
          transition: prefersReducedMotion()
            ? 'none'
            : phase.sliding
              ? `transform ${BAND_SLIDE_MS}ms ease-out, visibility ${BAND_SLIDE_MS}ms, filter 100ms ease-out`
              : 'filter 100ms ease-out',
          boxShadow: '0 3px 8px rgba(0,0,0,.55)',
          // 押し出しの量は巻いた合図の中でも直に書く（→ shiftRef）。掛けると巻く指に遅れるので、押し出しには遷移を掛けない
          transform: bandTransform(phase.entered, shiftRef.current),
        }}
      >
        {/* 隠れている間は中身を描かない（同じ行が一覧に 2 つ並んで見えないように） */}
        {rendered && children}
      </div>
    </div>
  )
}

/** 帯の位置。隠すときは帯の高さぶん上へ、出すときは 0（カードの下端では上へ押し出す量）。 */
function bandTransform(entered: boolean, shift: number): string {
  if (!entered) return 'translateY(-100%)'
  return shift < 0 ? `translateY(${shift}px)` : 'translateY(0)'
}
