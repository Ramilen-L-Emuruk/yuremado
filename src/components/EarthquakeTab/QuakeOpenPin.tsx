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
 *
 * **カードの下端で帯を押し上げるのはブラウザに任せる**（2026-11-05 ユーザー選択「CSS の貼りつきで作り直す (Recommended)」）。
 * 帯の受け皿（`quake-pin`。帯と同じ高さで貼りつく）を、カードと同じ大きさの透明な箱（`quake-pin-track`）に入れる。
 * 貼りつく要素は入れ物の外へ出られないので、カードの下端が来ると受け皿ごと上へ押し出される。巻く合図で位置を測って
 * 書く形だと、巻きそのものが描画の側で先に動くぶん帯が指に遅れていた。透明な箱は絶対配置なので下の中身を押し下げず、
 * 押せないようにしてある（押せるのは帯だけ）。貼りつく位置は一覧の見出しの行と日付の区切りの下
 * （`--qk-head-h` ＋ `--qk-day-h`）。帯は日付の区切りより下に描く（2026-11-05 ユーザー回答「下に書いて」。
 * 滑り下りる途中も、押し上げられるときも、日付の区切りの裏を通る）。
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
      // 出し入れの最中の印が立ったまま残る）
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
  const pinRef = useRef<HTMLDivElement>(null)
  const bandRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const target = targetRef.current
    if (!target) return
    const card = target.closest<HTMLElement>('[data-quake-key]')
    let root: HTMLElement | null = null
    // 巻くたびには変わらない値（上に貼りついて残る高さ・帯ごと隠している組か）は、大きさが変わったときだけ読む。
    // 巻く合図のたびに getComputedStyle を呼ぶと、巻くあいだ毎回スタイルを解決させる
    let headPx = 0
    let hidden = false
    const readStatic = () => {
      // 上に貼りついて残る一覧の見出しの行と日付の区切りの高さ。カードの scroll-margin-top と同じ値（px に解決済み）を読む
      headPx = card ? parseFloat(getComputedStyle(card).scrollMarginTop) || 0 : 0
      hidden = pinRef.current !== null && getComputedStyle(pinRef.current).display === 'none'
    }
    const update = () => {
      if (!root) return
      const top = root.getBoundingClientRect().top + headPx
      // 枠が半分より上へ抜けたら出す（下にあってまだ見えていないときは出さない）。帯ごと隠している組では出さない
      const box = target.getBoundingClientRect()
      const show = !hidden && box.top + box.height / 2 < top
      setState(prev => (prev.show === show ? prev : { show }))
    }
    // 報の一覧・補足の開閉でカードの高さが変わったときも測り直す（巻かなくても枠の位置は動く）。
    // 受け皿も見る —— 広い組で貼りつくか（data-stick-tall）は一覧の見える高さで決まり、カードの大きさが変わらずに
    // 付け外しされることがある（上下分割の境のつまみ・窓の高さ）。そのとき受け皿は display: none と表示の間を行き来し、
    // 大きさが 0 と 0 でないの間で変わるので、ここで「帯ごと隠している組か」を読み直せる。
    // 巻く箱も見る（見出しの行の高さが変わってもカードの大きさが変わらないことがある）
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { readStatic(); update() })
    const watch = (measure: boolean) => {
      // 巻ける祖先は画面の向き・幅で入れ替わる（左右分割と上下分割で巻く箱が違う）ので、変わったら張り直す
      const next = scrollParentOf(target)
      if (next !== root) {
        root?.removeEventListener('scroll', update)
        if (root && ro) ro.unobserve(root)
        root = next
        root?.addEventListener('scroll', update, { passive: true })
        if (root && ro) ro.observe(root)
      }
      if (measure) { readStatic(); update() }
    }
    // 張った直後は測らず、ResizeObserver の初回の呼び出しに任せる（カードを開いた描き直しの中で位置を読むと、
    // レイアウトを 1 回余計に強いる。開いた直後は帯を出さないのが正しいので、初期値のままで困らない）
    watch(ro === null || card === null)
    const onResize = () => watch(true)
    window.addEventListener('resize', onResize)
    if (ro && card) ro.observe(card)
    if (ro && pinRef.current) ro.observe(pinRef.current)
    return () => {
      window.removeEventListener('resize', onResize)
      root?.removeEventListener('scroll', update)
      ro?.disconnect()
    }
  }, [targetRef])
  // 出ている帯の高さを要素に書く（節へ巻くときに差し引く量。字の大きさで変わるので決め打ちしない）。
  // 再描画を待たずに読めるよう、属性は直に書く（→ EarthquakeCard の pinBandHeight）
  useEffect(() => {
    if (!state.show || !bandRef.current || !pinRef.current) return
    pinRef.current.dataset.bandH = String(bandRef.current.getBoundingClientRect().height || PIN_HEIGHT_GUESS_PX)
  }, [state.show, rendered])
  // 押せるのは帯が見えてから（下ろす前の 2 描画ほどは見えない）
  const activate = state.show && phase.entered ? onActivate : undefined
  const onClick = (e: MouseEvent) => {
    if (onLpgmActivate && (e.target as HTMLElement).closest('[data-tile-lpgm]')) onLpgmActivate()
    else activate?.()
  }
  return (
    // カードと同じ大きさの透明な箱。受け皿が貼りつける範囲をカードの中に限る（下端で押し上げられる）。押せない。
    // 箱はカードの枠線の内側なので、押し上げられた帯の下端はカードの下の枠線の 1px 上で止まる
    <div className="quake-pin-track pointer-events-none absolute inset-0" aria-hidden={!state.show}>
      {/* 受け皿。帯と同じ高さで貼りつく。日付の区切り（z-[3]）・一覧の見出しの行（z-[4]）より下に描く */}
      <div ref={pinRef} className="quake-pin sticky z-[2]" style={{ top: 'calc(var(--qk-head-h) + var(--qk-day-h))' }}>
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
          className={`border-b border-border bg-card ${phase.entered ? 'pointer-events-auto' : 'invisible'} ${activate ? 'cursor-pointer quake-press-row' : ''}`}
          style={{
            padding: '7px var(--qk-pad)',
            // **遷移はここで書く。** 出ている間は押せる行の印（`quake-press-row`）が付き、その `transition: filter …` が
            // クラスで書いた遷移を上書きする（クラスに任せると、出るときだけ滑らない）。
            // 出し入れの最中だけ transform も遷移させる。動きを減らす設定なら掛けない
            transition: prefersReducedMotion()
              ? 'none'
              : phase.sliding
                ? `transform ${BAND_SLIDE_MS}ms ease-out, visibility ${BAND_SLIDE_MS}ms, filter 100ms ease-out`
                : 'filter 100ms ease-out',
            boxShadow: '0 3px 8px rgba(0,0,0,.55)',
            // 隠すときは帯の高さぶん上へ（押し上げはブラウザの貼りつきが行うので、ここでは出し入れだけ）
            transform: phase.entered ? 'translateY(0)' : 'translateY(-100%)',
          }}
        >
          {/* 隠れている間は中身を描かない（同じ行が一覧に 2 つ並んで見えないように） */}
          {rendered && children}
        </div>
      </div>
    </div>
  )
}
