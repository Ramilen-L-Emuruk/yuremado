import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useAutoOpenWhileSpeaking, useAutoOpenWhileSpeakingIn } from '../../hooks/useAutoOpenWhileSpeaking'
import { telegramTextSubject } from '../../utils/ttsFollow'
import { log } from '../../utils/logger'
import type {
  EarthquakeInfoMeta, JMANankai, JMANankaiCommentary, JMAKohatsu, JMAQuakeNotice, JMAEarthquakeCount,
  TelegramOperationStatus,
} from '../../types/earthquake'
import { EarthquakeCountDetail } from './EarthquakeCountDetail'
import { Marquee } from '../Marquee'
import { DisclosureCaret, Reveal } from '../EarthquakeTab/quakeMotion'
import { earthquakeCountHeadline } from '../../utils/earthquakeCountSummary'
import type { InternationalTsunamiBandItem } from '../../utils/internationalTsunami'
import type { SpecialInfoCancelBand, SpecialInfoCancelKind } from '../../utils/specialInfoCancelBand'
import { InternationalTsunamiText } from '../EarthquakeTab/InternationalTsunamiText'
import type { SpecialInfoBanners, StackedSpecialInfo } from './useSpecialInfoBanners'

interface Props {
  /**
   * 帯の束の状態（`useSpecialInfoBanners`）。**描くのは `visible`（閉じた電文を除いたもの）だけ。**
   * 閉じた状態を呼び出し側が持つので、共有ボタンの置き場所も同じ「いま出ている帯」で決められる。
   */
  banners: SpecialInfoBanners
  /**
   * いま気象庁が書いた文を読み上げている電文の主題（`telegramText:<kind>`。読んでいなければ null）。
   * 帯は自分が対象なら中身を開く（→ `useAutoOpenWhileSpeaking`）。
   */
  speakingTelegramTextSubject: string | null
  /**
   * 気象庁が書いた文の読み上げに参考情報（`Appendix`）を含める設定か（→ `telegramTextToSpeak` の
   * `earthquakeInfoAppendix`）。真なら、南海トラフ・後発地震の帯は文を読んでいる間「この種類の情報について」も開く
   * （2026-10-24 ユーザー選択「読む間は開く (Recommended)」）。
   */
  readsAppendix: boolean
  /**
   * 帯の束がいま画面の下端に接しているか。地図の下に波形が出ていれば、帯は地図の中にあって
   * 下端には届かないので false。真のときだけ下端の余白（`SAFE_BOTTOM`）を付ける —— ただし
   * 余白が効くのは `sideShort` の画面だけで、縦積みや PC では真でも付かない。
   */
  atScreenBottom: boolean
  /**
   * 開いた帯の本文を重ねてよい上端（地図の上端からの px）。上の隅の表示（更新時刻・凡例の見出しなど）の下。
   * 行動チェックリストを開いたときの上端（`ActionChecklist` の `topInset`）と同じ値を渡す。
   */
  bodyTopInset: number
  /**
   * 縦並びの中で帯より上にあるものの下端を指す要素（`App` の縦並びの伸びる空白）。本文はこの要素の上端より上へは出さない
   * —— 上端に行動チェックリストが並んでいれば、その下で止まる。
   */
  bodyTopEdgeRef: RefObject<HTMLElement | null>
}

/**
 * 開いた帯の本文を出す層（→ `BandBody`）。帯の見出しの並びの外、すぐ上に重ねる。
 * 見出しの並びは閉じたときの高さのままなので、開いても凡例・共有ボタン・他の帯の見出しが動かない
 * （2026-11-09 ユーザー選択「この形にする (Recommended)」。説明「帯の見出しは閉じたときの位置のまま、開いた帯の本文だけを
 * 見出しの上に重ねて出し、上の隅の表示の下までで巻く。凡例・共有ボタンは動かないが、開いている間は本文の下に隠れる」）。
 */
const BandBodyLayer = createContext<HTMLElement | null>(null)

/**
 * 本文を重ねる層の中の並び。開けるのは 1 本だけだが、別の帯へ切り替えた直後は閉じかけの本文と開きかけの本文が
 * 一瞬並ぶので、そのときも見出しと同じ順にする
 */
const BODY_ORDER: Record<string, number> = { nankai: 0, nankaiCommentary: 1, kohatsu: 2, earthquakeCount: 3, quakeNotice: 4, internationalTsunami: 5 }

/**
 * いま開いている帯（`BODY_ORDER` の鍵）。**開けるのは一度に 1 本だけ**で、別の帯を開くと前の帯は閉じる
 * （2026-11-09 ユーザー発言「どれかしか開けなくすれば」。「1 本だけ開け、別の帯を開いたら前の帯は閉じる」の確認に
 * ユーザー選択「その意味で合っている」）。本文が層に積み重ならないので、
 * 開いた本文はいつも層の先頭から出る。
 */
const OpenBand = createContext<{ openSubject: string | null; setOpenSubject: (update: (prev: string | null) => string | null) => void } | null>(null)

/**
 * 帯の開閉。開いているかは帯の束が 1 つだけ持つ（→ `OpenBand`）。読み上げのあいだ開く規約は
 * `useAutoOpenWhileSpeakingIn` のまま —— 読み上げが始まると読んでいる帯へ切り替え、読み終えたらその帯だけ閉じる。
 * 手で開いていた別の帯は、切り替えで閉じたまま戻さない（2026-11-09 ユーザー選択「切り替えて、戻さない」）。
 */
function useBandOpen(speaking: boolean, subject: string): [boolean, (open: boolean) => void] {
  const ctx = useContext(OpenBand)
  if (!ctx) throw new Error('帯の開閉は BannerStack の中でしか使えません')
  const { openSubject, setOpenSubject } = ctx
  const isOpen = openSubject === subject
  const setOpen = (next: boolean) => setOpenSubject(prev => next ? subject : (prev === subject ? null : prev))
  return [isOpen, useAutoOpenWhileSpeakingIn(speaking, isOpen, setOpen, subject)]
}

/**
 * 開いた帯の本文。層（`BandBodyLayer`）へ出す。層が付く前（帯の束が現れた最初の描画）は何も描かない ——
 * そこで見出しの下に一度組み立てると、層が付いた次の描画で組み直すことになる。
 * 地の色と上の線は帯と同じもの（`frameClass`）を本文の箱に付ける。
 */
function BandBody({ open, subject, frameClass, children }: { open: boolean; subject: string; frameClass: string; children: () => ReactNode }) {
  const layer = useContext(BandBodyLayer)
  if (!layer) return null
  return createPortal(
    <div style={{ order: BODY_ORDER[subject] }} data-testid="band-body" data-band={subject}>
      <Reveal open={open} className={frameClass}>{children}</Reveal>
    </div>,
    layer,
  )
}

// 閉じた電文の id の覚え方（localStorage のキー・書式の揃え方）は useSpecialInfoBanners.ts にある。

function NankaiIcon() {
  return (
    <svg className="w-5 h-5 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
    </svg>
  )
}

function CommentaryIcon() {
  return (
    <svg className="w-5 h-5 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  )
}

function CloseIcon({ small = false }: { small?: boolean }) {
  return (
    <svg className={small ? 'w-3.5 h-3.5' : 'w-4 h-4'} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  )
}

// お知らせ（VZSE40）の印。拡声器。地震そのものではなく「運用のお知らせ」なので、
// 他の 3 枚が使う警告・文書・情報のいずれとも重ならない形にする。
function NoticeIcon() {
  return (
    <svg className="w-5 h-5 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" />
    </svg>
  )
}

// 地震回数の印。棒グラフ（数を数えている情報であることを形で示す）。
function CountIcon() {
  return (
    <svg className="w-5 h-5 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
    </svg>
  )
}

function KohatsuIcon() {
  return (
    <svg className="w-5 h-5 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function nankaiColors(kindName: string): { bg: string; border: string; badge: string } {
  if (kindName === '巨大地震警戒') return { bg: 'bg-red-900/95',    border: 'border-red-500',    badge: 'bg-red-500' }
  if (kindName === '巨大地震注意') return { bg: 'bg-orange-900/95', border: 'border-orange-400', badge: 'bg-orange-400' }
  return                                  { bg: 'bg-yellow-900/95', border: 'border-yellow-400', badge: 'bg-yellow-400' }
}

// 下端の safe-area（ホームインジケータ）を避けるための余白。帯を並べる包みに付け、最後の帯へ効かせる。
// **色の付いた箱の内側に入る。** 余白は最後の帯自身の padding になるので、背景色は画面下端まで届く。
//   包みや外側のラッパーの padding にすると帯ごと持ち上がり、下に地図が覗いて隙間に見える。
// 最後の 1 枚だけ … 5 枚同時に出うるため、余白が要るのは下端に接する最後の 1 枚だけ。上の帯にも入れると
//   帯と帯の間に隙間ができる。並び順を JS 側で数えると種類が増えたときに追従漏れを起こすので、
//   :last-child に判定させて実際に最後へ描画された要素だけに効かせる。
// sideShort: … 横向きかつ高さ 600px 以下（主にスマホの横画面）。縦積みでは地図の下につまみ・パネル・ナビが
//   続いて下端に届かない。iPad の横画面は余白を取らない（→ docs/spec/architecture-spec.md §4 規則 2）。
//   env() は要素の位置に関わらず値を返すため、どちらも条件で表す必要がある。
// atScreenBottom: … 地図の下に波形が出ているときは、帯は画面の下端に届かないので付けない。
const SAFE_BOTTOM = 'sideShort:[&>*:last-child]:pb-[env(safe-area-inset-bottom,0px)]'

/**
 * 地図の左下の共有ボタンを包む要素の、下の位置のクラス。帯の下端の余白と同じ条件で下端の safe-area を避ける
 * （→ docs/spec/architecture-spec.md §4）。帯が出ていればボタンは帯のすぐ上に載り、下端に届くのは帯の側なので避けない。
 * **クラス名は字面のまま書く**（Tailwind は文字列をそのまま拾う。組み立てると生成されない）。
 */
export function shareButtonBottomClass(bannerShown: boolean, atScreenBottom: boolean): string {
  return !bannerShown && atScreenBottom
    ? 'bottom-2 sideShort:bottom-[max(0.5rem,env(safe-area-inset-bottom,0px))]'
    : 'bottom-2'
}

/**
 * 共有ボタンを載せる行の高さのクラス。**行動チェックリストの帯が出ている間だけ高さを持たせる。**
 * 普段は高さ 0 の行からボタンを上へはみ出させるので、縦並びの分け合いに加わらない。ところが帯は地図の下端まで
 * 伸びうるので、そのままだとボタンが帯の左下に重なる（2026-10-27 実測・390×844 で横 30・縦 29px。
 * 2026-10-27 ユーザー選択「共有ボタンの高さを帯の下限に入れる (Recommended)」）。
 * 高さはボタン（2.25rem）＋ `shareButtonBottomClass` と同じ下の余白で、両者を同じ条件で切り替える。
 */
export function shareButtonRowHeightClass(checklistShown: boolean, bannerShown: boolean, atScreenBottom: boolean): string {
  if (!checklistShown) return 'h-0'
  return !bannerShown && atScreenBottom
    ? 'h-11 sideShort:h-[calc(2.25rem+max(0.5rem,env(safe-area-inset-bottom,0px)))]'
    : 'h-11'
}

export function SpecialInfoBanner({ banners, speakingTelegramTextSubject, readsAppendix, atScreenBottom, bodyTopInset, bodyTopEdgeRef }: Props) {
  /**
   * この帯の文をいま読み上げているか。**主題は `telegramText:<電文の kind>`**
   * （→ `useLiveEventHandler` の `speakTelegramText`）。
   */
  const speaking = (kind: string) => speakingTelegramTextSubject === telegramTextSubject(kind)
  // **閉じた帯しか残っていなければ何も描かない**（外枠の下限 2.5rem だけが空で残らないように）
  if (!banners.shown) return null
  return (
    <BannerStack banners={banners} speaking={speaking} readsAppendix={readsAppendix} atScreenBottom={atScreenBottom}
      bodyTopInset={bodyTopInset} bodyTopEdgeRef={bodyTopEdgeRef} />
  )
}

/**
 * 本文の層の高さの上限を測る。帯の束の上端から、上の隅の表示の下（`bodyTopInset`）か、帯より上に並ぶもの
 * （行動チェックリスト）の下端（`bodyTopEdgeRef` の上端）の低いほうまで。
 * **測るのは大きさが変わったときだけ**（`ResizeObserver`）。描き直しのたびには読まない。
 * 値は state に持たず層の `style.maxHeight` へ直に書く —— 行動チェックリストの開閉やつまみのドラッグの間は
 * 毎フレーム値が変わるので、state にすると帯の束と開いた本文がフレームごとに描き直される。
 */
/** `ResizeObserver` が無い環境の警告は 1 度だけ出す（帯の束が現れるたびに出さない） */
let warnedNoResizeObserver = false

function useBodyLayerMax(rootRef: RefObject<HTMLElement | null>, layer: HTMLElement | null, bodyTopInset: number, bodyTopEdgeRef: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const root = rootRef.current
    const stack = root?.parentElement
    if (!root || !stack || !layer) return
    const edge = bodyTopEdgeRef.current
    const measure = () => {
      const top = root.getBoundingClientRect().top
      const stackTop = stack.getBoundingClientRect().top
      const limit = Math.max(stackTop + bodyTopInset, edge ? edge.getBoundingClientRect().top : stackTop)
      const max = `${Math.max(0, Math.floor(top - limit))}px`
      if (layer.style.maxHeight !== max) layer.style.maxHeight = max
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      if (!warnedNoResizeObserver) log.warn('[layout] 帯の束の大きさを見張れないため、開いた帯の本文の高さの上限が初回の値のままになります')
      warnedNoResizeObserver = true
      return
    }
    // 縦並びの子をすべて見る。上端（`edge`）は大きさが変わらず位置だけ動くことがある
    // （伸びる空白が 0 のまま、行動チェックリストが伸びて凡例だけが縮むとき）ので、空白だけを見ても拾えない
    const ro = new ResizeObserver(measure)
    ro.observe(stack)
    for (const child of Array.from(stack.children)) ro.observe(child)
    if (edge && edge.parentElement !== stack) ro.observe(edge)
    // 帯が出た後に現れる子（行動チェックリスト・凡例・共有ボタンの行）も見る。子の増減は大きさの変化として届かない
    const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(records => {
      for (const r of records) for (const n of Array.from(r.addedNodes)) if (n instanceof Element) ro.observe(n)
      measure()
    })
    mo?.observe(stack, { childList: true })
    return () => { ro.disconnect(); mo?.disconnect() }
  }, [rootRef, layer, bodyTopInset, bodyTopEdgeRef])
}

function BannerStack({ banners, speaking, readsAppendix, atScreenBottom, bodyTopInset, bodyTopEdgeRef }: {
  banners: SpecialInfoBanners
  speaking: (kind: string) => boolean
  readsAppendix: boolean
  atScreenBottom: boolean
  bodyTopInset: number
  bodyTopEdgeRef: RefObject<HTMLElement | null>
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [layer, setLayer] = useState<HTMLDivElement | null>(null)
  useBodyLayerMax(rootRef, layer, bodyTopInset, bodyTopEdgeRef)
  const { nankai, nankaiCommentary, kohatsu, quakeNotice, earthquakeCount, internationalTsunami, cancels } = banners.visible
  const [openSubject, setOpenSubject] = useState<string | null>(null)
  const openBand = useMemo(() => ({ openSubject, setOpenSubject }), [openSubject])
  // 開いていた帯が消えたら（× で閉じた・期限が切れた）、開いている印も外す。残すと、同じ種類の帯が
  // 次に出たときに開いたまま現れる
  const present: Record<string, boolean> = {
    nankai: !!nankai, nankaiCommentary: nankaiCommentary.length > 0, kohatsu: kohatsu.length > 0,
    earthquakeCount: earthquakeCount.length > 0, quakeNotice: quakeNotice.length > 0, internationalTsunami: internationalTsunami.length > 0,
  }
  // 取消の表示は、その種類の帯のすぐ上に出す（その種類の帯が無くなっていれば、帯があった場所に出る）
  const cancelBands = (kind: SpecialInfoCancelKind) => cancels.filter(c => c.kind === kind).map(c => (
    <CancelBand key={c.id} cancel={c} onDismiss={() => banners.dismissCancel(c.id)} />
  ))
  const gone = openSubject !== null && !present[openSubject] ? openSubject : null
  // 消えた帯の名前で外す —— 同じ描き直しで別の帯の読み上げが開いていたら、それを上書きしない
  useEffect(() => { if (gone) setOpenSubject(prev => (prev === gone ? null : prev)) }, [gone])
  // 別の帯へ切り替えたら、層を先頭へ戻す（前の本文を巻いた位置のまま、次の本文の途中から見せない）
  useLayoutEffect(() => { if (layer && openSubject) layer.scrollTop = 0 }, [layer, openSubject])

  return (
    // **自分では絶対配置しない。** 地図の下端へ積む枠は呼び出し側（`App`）が持っており、
    // この帯と凡例（`MapLegend`）が同じ縦並びに入る。帯が出れば凡例が押し上がる。
    // 自前で `absolute bottom-0` を持つと凡例の上に重なって隠す。
    // `flex-col`: 呼び出し側の縦並びが地図の高さで縮めたとき、下のスクロール領域まで縮みが
    // 届くようにする。これが無いと中身の高さで止まり、地図の上へはみ出す。
    // **縮むのは 2.5rem（帯の見出し 1 行ぶん）まで。** 0 まで縮めると、地図がごく低いときに
    // 南海トラフ臨時情報が記録も印も残さずに消える（はみ出していた頃より気づきにくい）。
    // 下限は値で書く —— 何も書かない（`auto`）と縦並びの子は中身の高さで止まり、縮まない。
    // 帯が 1 枚も無ければこのコンポーネント自体が何も描かないので、下限も場所を取らない。
    <div ref={rootRef} className="ui-text w-full min-h-10 flex flex-col pointer-events-none relative">
      {/* 開いた帯の本文を出す層（→ `BandBody`）。見出しの並びのすぐ上に重ね、縦並びの高さの分け合いには加わらない
          （絶対配置）。中身が無ければ高さ 0。高さの上限は `useBodyLayerMax` が測って `style.maxHeight` へ直に書き、超えたらこの層の中で巻く
          （`style` を JSX に書かないこと。描き直しで書いた上限が消える）。
          `ui-text-scope` は見出しの並びと同じ字の大きさを効かせるため。 */}
      <div ref={setLayer} className="ui-text-scope absolute inset-x-0 bottom-full flex flex-col pointer-events-auto overflow-y-auto overflow-x-hidden overscroll-contain"
        data-testid="band-body-layer" />
      {/* 見出しの並び。開いても本文はここに入らない（上の層へ出る）ので、高さは見出しの分だけで変わらない。
          呼び出し側の縦並びが地図の高さから決める残りで縮み（`min-h-0`）、見出しが入りきらないときだけこの中で巻く
          （→ docs/spec/architecture-spec.md §4）。南海トラフ臨時情報は先頭なので、縮んでもスクロールの先頭に残る。
          overflow-y だけを auto にすると overflow-x も auto に格上げされ横スクロールしてしまうため、明示的に塞ぐ。
          SAFE_BOTTOM はここの直接の子の最後に効くので、バナー以外をこの中に足さないこと。 */}
      <OpenBand.Provider value={openBand}>
      <BandBodyLayer.Provider value={layer}>
      <div data-testid="band-headers" className={`ui-text-scope pointer-events-auto min-h-0 overflow-y-auto overflow-x-hidden overscroll-x-none${atScreenBottom ? ` ${SAFE_BOTTOM}` : ''}`}>
        {/* 南海トラフの 2 枚（臨時情報とその解説情報）を隣り合わせる。臨時情報の発表期間中は
            解説情報が毎日届いて両方が同時に出るため、間に別の事象（後発地震＝北海道・三陸沖）を
            挟むと同じ事象の話が分断されて読みにくい。重さの順よりこちらを優先する。 */}
        {cancelBands('nankai')}
        {nankai && <NankaiBanner nankai={nankai} speaking={speaking('nankai')} readsAppendix={readsAppendix} onDismiss={() => banners.dismiss('nankai')} />}
        {/* 積む 5 種は、同じ種類が何通あっても 1 本の帯（→ `StackedBanner`）。閉じ方は帯の × が全件・行の × が 1 件 */}
        {cancelBands('nankaiCommentary')}
        {nankaiCommentary.length > 0 && <CommentaryBanner list={nankaiCommentary} speaking={speaking('nankaiCommentary')} readsAppendix={readsAppendix} banners={banners} />}
        {cancelBands('kohatsu')}
        {kohatsu.length > 0 && <KohatsuBanner list={kohatsu} speaking={speaking('kohatsu')} readsAppendix={readsAppendix} banners={banners} />}
        {cancelBands('earthquakeCount')}
        {earthquakeCount.length > 0 && <EarthquakeCountBanner list={earthquakeCount} speaking={speaking('earthquakeCount')} banners={banners} />}
        {/* お知らせ（運用連絡）は事象の帯の後。上の 4 枚は「いま起きている・起こりうる地震」の話で、
            こちらは観測点の入電停止・配信試験といった裏方の連絡。同時に出たときに
            事象の話を先に読ませる。 */}
        {cancelBands('quakeNotice')}
        {quakeNotice.length > 0 && <NoticeBanner list={quakeNotice} speaking={speaking('quakeNotice')} banners={banners} />}
        {/* 地震カードに付かない国際津波関連情報（通信試験など）は最後。受信機関への運用連絡で、お知らせと同じ性質 */}
        {internationalTsunami.length > 0 && <InternationalTsunamiBanner list={internationalTsunami} banners={banners} />}
      </div>
      </BandBodyLayer.Provider>
      </OpenBand.Provider>
    </div>
  )
}

/**
 * 南海トラフ・後発地震の帯を開いたときの中身。
 *
 * **3 つの帯（臨時情報・解説情報・後発地震注意情報）で同じものを同じ順に出す。**
 * 別々に書いていたため「解説情報だけが要約を出していて、臨時情報と後発地震は出していない」
 * という食い違いができていた。項目を足すときはここへ足せば 3 つとも揃う。
 *
 * 並びの理由:
 * 1. **要約**（気象庁が書いた一文）—— 本文は 1000 字を超えることがあり、先に結論を置く
 * 2. **本文**
 * 3. **次の情報**（`NextAdvisory`）—— 続報を待つべきかの判断に直結する。**南海トラフだけが持つ**
 *    （後発地震注意情報の電文はこの要素を持たない）。見出しに「今後」「発表」を使わないのは、
 *    直後に来る電文の文が「今後は……発表します」で始まり、同じことを 2 回言って見えるため
 * 4. **この種類の情報について**（`Appendix`）—— 制度の解説。**電文ごとに変わらない固定文**で
 *    長いため畳んでおく。初めてこの情報を受け取る人には要るが、毎報そのまま積むと本文が埋もれる。
 *    「この情報について」ではなく「この種類の」と冠するのは、**今回届いた発表の補足ではなく
 *    制度そのものの説明**だと分かるようにするため
 */
function EarthquakeInfoDetail({ info, speakingAppendix, subject, footer }: {
  info: EarthquakeInfoMeta & { body: string }
  /**
   * いま参考情報を含む文を読み上げているか。真のあいだ「この種類の情報について」を開く
   * （開き方の規約は帯の本文と同じ `useAutoOpenWhileSpeaking`。自分が開いた分だけ読み終わりで閉じる）。
   */
  speakingAppendix: boolean
  /** 録画ツール向けの記録に載せる主題（電文の種別）。`:appendix` を付けて本文の開閉と分ける */
  subject: string
  footer: React.ReactNode
}) {
  const [appendixOpen, setAppendixOpen] = useAutoOpenWhileSpeaking(speakingAppendix && !!info.appendix, `${subject}:appendix`)
  return (
    <div className="px-3 pb-2">
      {info.summary && (
        <p className="text-white text-(length:--ui-fs) font-medium leading-relaxed whitespace-pre-wrap mb-1">{info.summary}</p>
      )}
      {info.body && (
        <p className="text-white text-(length:--ui-fs) leading-relaxed whitespace-pre-wrap mb-1">{info.body}</p>
      )}
      {info.nextAdvisory && (
        <div className="mb-1 border-l-2 border-white/30 pl-2">
          <p className="text-secondary text-(length:--ui-fs) font-bold mb-0.5">次の情報</p>
          <p className="text-white text-(length:--ui-fs) leading-relaxed whitespace-pre-wrap">{info.nextAdvisory}</p>
        </div>
      )}
      {info.appendix && (
        <div className="mb-1">
          <button
            className="text-secondary hover:text-white text-(length:--ui-fs) underline decoration-dotted underline-offset-2"
            onClick={() => setAppendixOpen(!appendixOpen)}
          >
            この種類の情報について{appendixOpen ? '（閉じる）' : '（開く）'}
          </button>
          <Reveal open={appendixOpen}>{() => (
            <p className="text-secondary text-(length:--ui-fs) leading-relaxed whitespace-pre-wrap mt-1">{info.appendix}</p>
          )}</Reveal>
        </div>
      )}
      {footer}
    </div>
  )
}

/**
 * 電文が自分で名乗っている運用種別（`Control/Status`）の印。訓練・試験のときだけ出す。
 *
 * **バナーで出る種別ほど訓練報の割合が高い。** 実電文を数えたところ、後発地震注意情報は
 * 訓練 5 / 通常 2、南海トラフ臨時情報は訓練 4 / 通常 4 だった（発表頻度が低いぶん、これまでに
 * 配信されたものに占める訓練の割合が大きい）。印が無いと、訓練の「巨大地震注意」が本物と
 * 同じ顔で出る。
 *
 * 本文にも「＊＊＊これは訓練です＊＊＊」と書かれることがあるが、**帯は畳まれていることが多い**
 * ので、開かなくても分かるところに出す。
 */
function OperationStatusBadge({ status }: { status?: TelegramOperationStatus }) {
  if (!status) return null
  return (
    <span
      className="text-(length:--ui-fs) font-bold px-1.5 py-0.5 rounded-[3px] shrink-0"
      style={{ backgroundColor: '#1f2937', color: '#fcd34d', border: '1px solid #d97706' }}
    >
      {status}報
    </span>
  )
}

// 臨時情報と後発地震注意情報の帯にも閉じるボタンを付ける（2026-10-22 ユーザー選択「閉じられるようにする」。
// ボタンの名前は 2026-10-24 ユーザー選択「この案でよい (Recommended)」）。閉じても段階が変われば出直す
// （→ `useSpecialInfoBanners` の `DISMISSED_KEYS`）。
/**
 * 電文が名乗る情報の種別（`Body/EarthquakeInfo` の `@type` と `InfoKind`）を、帯の見出しの下に小さく添える
 * （2026-10-30 ユーザー選択「帯に添える (Recommended)」。形は「南海トラフ地震に関連する情報／南海トラフ地震臨時情報」）。
 * **読み上げには足さない**（同じ選択）。片方しか無ければ、ある方だけを出す。**2 つが同じ語なら 1 つにする** ——
 * 後発地震注意情報（VYSE60）は `@type` も `InfoKind` も「北海道・三陸沖後発地震注意情報」で、並べると同じ語が 2 回続く。
 */
function InfoKindLine({ info }: { info: { earthquakeInfoType?: string; earthquakeInfoKind?: string } }) {
  const text = [...new Set([info.earthquakeInfoType, info.earthquakeInfoKind].filter(Boolean))].join('／')
  if (!text) return null
  return <Marquee className="text-secondary text-(length:--ui-fs) leading-tight mt-0.5" text={text} testId="info-kind-line" />
}

function NankaiBanner({ nankai, speaking, readsAppendix, onDismiss }: { nankai: JMANankai; speaking: boolean; readsAppendix: boolean; onDismiss: () => void }) {
  // 読み上げているあいだだけ開く（自分が開いた分だけ閉じる）
  const [open, setOpen] = useBandOpen(speaking, 'nankai')
  const { bg, border, badge } = nankaiColors(nankai.kindName)

  return (
    <div className={`${bg} border-t-2 ${border}`}>
      {/* 展開トグルと閉じるボタンを横に並べる（button の入れ子は不正な HTML になるため） */}
      <div className="w-full px-3 py-2 flex items-center gap-2">
        <button
          className="min-w-0 flex-1 flex items-center gap-2 text-left"
          onClick={() => setOpen(!open)}
        >
          <NankaiIcon />
          <div className="min-w-0 flex-1">
            <div className="min-w-0 flex items-center gap-2">
              <span className={`text-(length:--ui-fs) font-bold text-white px-1.5 py-0.5 rounded-[3px] shrink-0 ${badge}`}>
                {nankai.kindName}
              </span>
              <OperationStatusBadge status={nankai.operationStatus} />
              <Marquee className="flex-1 text-white text-(length:--ui-f) font-bold leading-tight" text={nankai.headline} />
            </div>
            <InfoKindLine info={nankai} />
          </div>
          <span className="shrink-0 text-secondary text-(length:--ui-f)"><DisclosureCaret open={open} /></span>
        </button>
        <button
          className="shrink-0 p-1 text-secondary hover:text-white"
          onClick={onDismiss}
          aria-label="臨時情報を閉じる"
        >
          <CloseIcon />
        </button>
      </div>
      <BandBody open={open} subject="nankai" frameClass={`${bg} border-t-2 ${border} pt-2`}>{() => (
        <EarthquakeInfoDetail info={nankai} speakingAppendix={speaking && readsAppendix} subject="nankai" footer={
          <p className="text-secondary text-(length:--ui-fs)">
            発表: {new Date(nankai.reportDateTime).toLocaleString('ja-JP')}
          </p>
        } />
      )}</BandBody>
    </div>
  )
}

/**
 * 積んでいる残りの件数（「ほか 2 件」。2026-11-04 ユーザー選択「「ほか 2 件」 (Recommended)」）。札の横に添える。
 * **1 通だけなら出さない。読み上げには足さない**（同じ選択）。
 */
function MoreCount({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span className="text-secondary text-(length:--ui-fs) shrink-0" data-testid="band-more-count">
      ほか {count} 件
    </span>
  )
}

/**
 * 同じ種類の報を 1 本に積んだ帯（解説情報・後発地震注意情報・地震回数・お知らせ）。2026-11-04 ユーザー選択「1 本に積む
 * (Recommended)」「帯は全件・行は 1 件 (Recommended)」。
 *
 * - **見出しは最新の 1 通**（`list` の先頭。一覧は新しい順で届く）。札の横に残りの件数を添える
 * - **開くと**、1 通だけならその本文。2 通以上なら新しい順に全件を行で並べ、最新の 1 件は開いた形、ほかは表題の行を押すと本文が開く
 * - **右端の ×** は積まれている全件を閉じる。**行の ×** は 1 件だけを閉じる（残りがあれば帯は残り、見出しは次に新しい 1 通へ替わる）
 */
function StackedBanner<T extends { id: string; reportDateTime: string }>({
  list, frameClass, icon, speaking, subject, header, rowTitle, detail, dismissAllLabel, dismissOneLabel, onDismissAll, onDismissOne,
}: {
  list: readonly T[]
  /** 帯の地と上の線の色（種類ごとの色。変えない） */
  frameClass: string
  icon: ReactNode
  /** この種類の文をいま読み上げているか。真のあいだ帯を開く（→ `useAutoOpenWhileSpeaking`） */
  speaking: boolean
  /** 録画ツール向けの記録に載せる主題（電文の種別） */
  subject: StackedSpecialInfo
  /** 見出しの中身。`more` は残りの件数（`MoreCount`）で、札の横に置く */
  header: (latest: T, more: ReactNode) => ReactNode
  /** 開いた一覧の行の表題 */
  rowTitle: (item: T) => ReactNode
  /** 本文。`latest` は最新の 1 通か（読み上げ中に参考情報を開くのは最新の 1 通だけ） */
  detail: (item: T, latest: boolean) => ReactNode
  dismissAllLabel: string
  dismissOneLabel: string
  onDismissAll: () => void
  onDismissOne: (id: string) => void
}) {
  const [open, setOpen] = useBandOpen(speaking, subject)
  const latest = list[0]
  return (
    <div className={frameClass}>
      {/* 展開トグルと閉じるボタンを横に並べる（button の入れ子は不正な HTML になるため） */}
      <div className="w-full px-3 py-2 flex items-center gap-2">
        <button
          className="min-w-0 flex-1 flex items-center gap-2 text-left"
          onClick={() => setOpen(!open)}
        >
          {icon}
          {header(latest, <MoreCount count={list.length - 1} />)}
          <span className="shrink-0 text-secondary text-(length:--ui-f)"><DisclosureCaret open={open} /></span>
        </button>
        <button
          className="shrink-0 p-1 text-secondary hover:text-white"
          onClick={onDismissAll}
          aria-label={dismissAllLabel}
        >
          <CloseIcon />
        </button>
      </div>
      <BandBody open={open} subject={subject} frameClass={`${frameClass} pt-2`}>{() => (
        list.length === 1
          ? detail(latest, true)
          : (
            <div className="pb-1">
              {/* 最新の 1 件は開いた形で出す。新しい報が届く・最新の 1 件を閉じるで最新が入れ替わったら、
                  key を替えて開き直す（前の最新は畳んだ形へ戻る） */}
              {list.map((item, i) => (
                <StackedRow key={i === 0 ? `${item.id}:latest` : item.id} defaultOpen={i === 0} title={rowTitle(item)} reportedAt={item.reportDateTime} detail={() => detail(item, i === 0)}
                  dismissLabel={dismissOneLabel} onDismiss={() => onDismissOne(item.id)} />
              ))}
            </div>
          )
      )}</BandBody>
    </div>
  )
}

/** 積んだ帯を開いたときの 1 行（表題・開閉の印・その 1 件を閉じる ×）。本文は表題の行を押すと開く */
function StackedRow({ defaultOpen, title, reportedAt, detail, dismissLabel, onDismiss }: {
  defaultOpen: boolean
  title: ReactNode
  /** 発表時刻（ISO 8601）。同じ表題が並んでも見分けられるよう、表題の右に「11/04 16:05」の形で添える
   *（2026-11-04 ユーザー選択「行の右に「11/04 16:05」 (Recommended)」） */
  reportedAt: string
  detail: () => ReactNode
  dismissLabel: string
  onDismiss: () => void
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border-t border-white/15" data-testid="band-row">
      <div className="w-full px-3 py-1 flex items-center gap-2">
        <button
          className="min-w-0 flex-1 flex items-center gap-2 text-left"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          {title}
          <span className="shrink-0 text-secondary text-(length:--ui-fs) tabular-nums">{rowTimeText(reportedAt)}</span>
          <span className="shrink-0 text-secondary text-(length:--ui-fs)"><DisclosureCaret open={open} /></span>
        </button>
        <button
          className="shrink-0 p-1 text-secondary hover:text-white"
          onClick={onDismiss}
          aria-label={dismissLabel}
        >
          <CloseIcon small />
        </button>
      </div>
      <Reveal open={open}>{detail}</Reveal>
    </div>
  )
}

/** 行の発表時刻（日本時間の「月/日 時:分」）。読めない日時は空にする（行の表題だけで出す） */
function rowTimeText(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** 行の表題の字（見出しより一段控えめに、太字にしない） */
const ROW_TITLE = 'flex-1 text-white text-(length:--ui-f) leading-tight'

function KohatsuBanner({ list, speaking, readsAppendix, banners }: { list: readonly JMAKohatsu[]; speaking: boolean; readsAppendix: boolean; banners: SpecialInfoBanners }) {
  return (
    <StackedBanner
      list={list}
      frameClass="bg-blue-900/95 border-t-2 border-blue-400"
      icon={<KohatsuIcon />}
      speaking={speaking}
      subject="kohatsu"
      header={(kohatsu, more) => (
        <div className="min-w-0 flex-1">
          <div className="min-w-0 flex items-center gap-2">
            {/* **情報名の札は置かない。** 南海トラフの帯は気象庁のキーワード（「巨大地震注意」等）を
                札に出すが、後発地震注意情報にはそれに当たる語が無い。情報名を入れると、すぐ隣の
                見出し（電文の `Head/Headline/Text`。実電文は「北海道・三陸沖後発地震注意情報」）と
                同じ文字列が 2 つ並ぶ。**幅は足りる**（390px 幅でも札 186px・行 314px で収まり、
                見出しが次行へ回るだけ）が、同じ言葉を二度読ませる意味が無い。残りの件数は札の位置（行の頭）に置く。 */}
            {more}
            <OperationStatusBadge status={kohatsu.operationStatus} />
            <Marquee className="flex-1 text-white text-(length:--ui-f) font-bold leading-tight" text={kohatsu.headline} />
          </div>
          <InfoKindLine info={kohatsu} />
        </div>
      )}
      rowTitle={kohatsu => (
        <>
          <OperationStatusBadge status={kohatsu.operationStatus} />
          <Marquee className={ROW_TITLE} text={kohatsu.headline} />
        </>
      )}
      // **期限は出さない**（2026-10-19 ユーザー選択「発表時刻だけにする (Recommended)」）。
      // 電文に期限の要素は無く、届いて 7 日で帯から外すのはアプリの都合（`expireAt`）。これを「まで有効」と
      // 言い切ると、気象庁が定めた期間のように読める。注意を呼びかける期間は気象庁の本文が語っている。
      detail={(kohatsu, latest) => (
        <EarthquakeInfoDetail info={kohatsu} speakingAppendix={latest && speaking && readsAppendix} subject="kohatsu" footer={
          <p className="text-secondary text-(length:--ui-fs)">
            発表: {new Date(kohatsu.reportDateTime).toLocaleString('ja-JP')}
          </p>
        } />
      )}
      dismissAllLabel="後発地震注意情報を閉じる"
      dismissOneLabel="この後発地震注意情報を閉じる"
      onDismissAll={() => banners.dismiss('kohatsu')}
      onDismissOne={id => banners.dismissOne('kohatsu', id)}
    />
  )
}

// 南海トラフ地震関連解説情報の帯。
//
// 臨時情報（NankaiBanner）とは色もバッジも分けている。あちらの黄／橙／赤は段階の重さを表すが、
// 解説情報は段階を持たないため、警戒度を読み取られない情報色（teal）にしている。
//
// 有効期限は出さない。内部では届いて 7 日で一覧から外しているが、それは帯を常駐させないための
// 表示上の都合であって、気象庁が期限を定めているわけではない（後発地震注意情報の帯の 7 日も同じ）。
// 7 日で外し期限を出さない形は 2026-10-22 ユーザー選択「今のまま記録する (Recommended)」（お知らせ・地震回数の帯も同じ）。
function CommentaryBanner({ list, speaking, readsAppendix, banners }: { list: readonly JMANankaiCommentary[]; speaking: boolean; readsAppendix: boolean; banners: SpecialInfoBanners }) {
  const serialBadge = (commentary: JMANankaiCommentary) => (
    <span className="text-(length:--ui-fs) font-bold text-white px-1.5 py-0.5 rounded-[3px] shrink-0 bg-teal-500">
      {commentary.serialName}
    </span>
  )
  return (
    <StackedBanner
      list={list}
      frameClass="bg-teal-900/95 border-t-2 border-teal-400"
      icon={<CommentaryIcon />}
      speaking={speaking}
      subject="nankaiCommentary"
      header={(commentary, more) => (
        <div className="min-w-0 flex-1">
          <div className="min-w-0 flex items-center gap-2">
            {serialBadge(commentary)}
            {more}
            <OperationStatusBadge status={commentary.operationStatus} />
            <Marquee className="flex-1 text-white text-(length:--ui-f) font-bold leading-tight" text={commentary.headline} />
          </div>
          <InfoKindLine info={commentary} />
        </div>
      )}
      rowTitle={commentary => (
        <>
          {serialBadge(commentary)}
          <OperationStatusBadge status={commentary.operationStatus} />
          <Marquee className={ROW_TITLE} text={commentary.headline} />
        </>
      )}
      detail={(commentary, latest) => (
        <EarthquakeInfoDetail info={commentary} speakingAppendix={latest && speaking && readsAppendix} subject="nankaiCommentary" footer={
          <p className="text-secondary text-(length:--ui-fs)">
            発表: {new Date(commentary.reportDateTime).toLocaleString('ja-JP')}
          </p>
        } />
      )}
      dismissAllLabel="解説情報を閉じる"
      dismissOneLabel="この解説情報を閉じる"
      onDismissAll={() => banners.dismiss('nankaiCommentary')}
      onDismissOne={id => banners.dismissOne('nankaiCommentary', id)}
    />
  )
}

// 地震・津波に関するお知らせ（VZSE40）の帯。
//
// 中身は観測点の入電停止・配信試験・訓練の予告といった**運用連絡**で、地震そのものの発表ではない。
// そのため色は無彩色（slate）にして、他の 3 枚（黄／橙／赤＝段階の重さ・teal＝南海トラフの解説・
// 青＝後発地震）のどれとも警戒度を取り違えられないようにしている。
//
// 本文は `Body/Text` の自由文ひとつきり。要約も次回発表予定も持たないので `EarthquakeInfoDetail`
// は通さない。**改行と全角スペースをそのまま出す** —— 気象庁は「記」から始まる箇条書きを
// 全角スペースの字下げで組んでおり、詰めると期間や連絡先の対応が崩れる。
//
// 有効期限（届いて 7 日）は出さない。解説情報と同じく帯を常駐させないための表示上の都合で、
// 気象庁が定めた期限ではない（2026-10-22 ユーザー選択「今のまま記録する (Recommended)」）。
function NoticeBanner({ list, speaking, banners }: { list: readonly JMAQuakeNotice[]; speaking: boolean; banners: SpecialInfoBanners }) {
  // 本文を読み上げている間は開く（他の帯と同じ。読み上げは設定で有効にしたときだけ）
  return (
    <StackedBanner
      list={list}
      frameClass="bg-slate-800/95 border-t-2 border-slate-400"
      icon={<NoticeIcon />}
      speaking={speaking}
      subject="quakeNotice"
      header={(notice, more) => (
        <div className="min-w-0 flex-1 flex items-center gap-2">
          <span className="text-(length:--ui-fs) font-bold text-white px-1.5 py-0.5 rounded-[3px] shrink-0 bg-slate-500">
            お知らせ
          </span>
          {more}
          <OperationStatusBadge status={notice.operationStatus} />
          <Marquee className="flex-1 text-white text-(length:--ui-f) font-bold leading-tight" text={notice.headline} />
        </div>
      )}
      rowTitle={notice => (
        <>
          <OperationStatusBadge status={notice.operationStatus} />
          <Marquee className={ROW_TITLE} text={notice.headline} />
        </>
      )}
      detail={notice => (
        <div className="px-3 pb-2">
          {notice.body && (
            <p className="text-white text-(length:--ui-fs) leading-relaxed whitespace-pre-wrap mb-1">{notice.body}</p>
          )}
          {/* 自由付加文は本文の後に空行を挟んで原文のまま出す（2026-10-19 ユーザー承認
              「本文に続けて出す (推奨)」）。空行は段落の間（`mt-3`）で表す */}
          {notice.freeText && (
            <p className={`text-white text-(length:--ui-fs) leading-relaxed whitespace-pre-wrap mb-1 ${notice.body ? 'mt-3' : ''}`}>{notice.freeText}</p>
          )}
          <p className="text-secondary text-(length:--ui-fs)">
            発表: {new Date(notice.reportDateTime).toLocaleString('ja-JP')}
          </p>
        </div>
      )}
      dismissAllLabel="お知らせを閉じる"
      dismissOneLabel="このお知らせを閉じる"
      onDismissAll={() => banners.dismiss('quakeNotice')}
      onDismissOne={id => banners.dismissOne('quakeNotice', id)}
    />
  )
}

// 地震回数に関する情報（VXSE60）の帯。
//
// **タブのカードではなく帯にしている。** 群発は日をまたいで続く「状況」で、地震カードのように
// 1 件ずつ増える「出来事」ではない。しかも群発の最中は小さな地震で揺れ検知が繰り返し発火して
// リアルタイムタブへ画面を持っていくので、地震情報タブへ置くと**いちばん見たいときに見えない**。
// 帯は地図に重ねて出るのでどのタブからも読める。
//
// 色は青緑（cyan）。南海トラフの解説（teal）とは隣り合わないので紛れにくく、
// 段階の重さを表す黄／橙／赤とも、運用連絡の無彩色とも別に見える。
function EarthquakeCountBanner({ list, speaking, banners }: { list: readonly JMAEarthquakeCount[]; speaking: boolean; banners: SpecialInfoBanners }) {
  return (
    <StackedBanner
      list={list}
      frameClass="bg-cyan-900/95 border-t-2 border-cyan-400"
      icon={<CountIcon />}
      speaking={speaking}
      subject="earthquakeCount"
      header={(count, more) => (
        <div className="min-w-0 flex-1 flex items-center gap-2">
          <span className="text-(length:--ui-fs) font-bold text-white px-1.5 py-0.5 rounded-[3px] shrink-0 bg-cyan-600">
            地震回数
          </span>
          {more}
          <OperationStatusBadge status={count.operationStatus} />
          {/* **電文の見出しではなく累積の数字を出す。** 電文の見出しは「地震回数に関する情報を
              お知らせします。」で、畳んだままでは何も伝わらない */}
          <Marquee className="flex-1 text-white text-(length:--ui-f) font-bold leading-tight" text={earthquakeCountHeadline(count)} />
        </div>
      )}
      rowTitle={count => (
        <>
          <OperationStatusBadge status={count.operationStatus} />
          <Marquee className={ROW_TITLE} text={earthquakeCountHeadline(count)} />
        </>
      )}
      detail={count => (
        <>
          <EarthquakeCountDetail count={count} />
          <p className="px-3 pb-2 text-secondary text-(length:--ui-fs)">
            発表: {new Date(count.reportDateTime).toLocaleString('ja-JP')}
          </p>
        </>
      )}
      dismissAllLabel="地震回数を閉じる"
      dismissOneLabel="この地震回数の情報を閉じる"
      onDismissAll={() => banners.dismiss('earthquakeCount')}
      onDismissOne={id => banners.dismissOne('earthquakeCount', id)}
    />
  )
}

/** 取消の表示に出す印（その種類の帯と同じ形を灰で） */
const CANCEL_ICONS: Record<SpecialInfoCancelKind, () => ReactNode> = {
  nankai: NankaiIcon,
  nankaiCommentary: CommentaryIcon,
  kohatsu: KohatsuIcon,
  quakeNotice: NoticeIcon,
  earthquakeCount: CountIcon,
}

/** 取消の表示の地と線・字の色（津波タブの取消の表示 `TsunamiTab` の `bannerBand`・`bannerFg` と同じ灰） */
const CANCEL_BAND = '#4b5563'
const CANCEL_FG = '#9ca3af'

/**
 * 帯に出していた報が取り消されたときの表示（→ `utils/specialInfoCancelBand.ts`）。帯の中に 3 行 —— 見出し「〇〇 取消」・
 * 1 行目「〇〇は取り消されました」・2 行目に電文の取消しの理由（無ければ出さない）。押して開く形にしない（10 秒で消えるので、
 * 押さずに読めるように。2026-11-10 ユーザー選択「A 帯の中に 3 行 (Recommended)」）。× で 10 秒を待たずに閉じられる
 */
function CancelBand({ cancel, onDismiss }: { cancel: SpecialInfoCancelBand; onDismiss: () => void }) {
  const Icon = CANCEL_ICONS[cancel.kind]
  return (
    <div className="bg-gray-800/95 border-t-2" style={{ borderTopColor: CANCEL_BAND }} data-testid="band-cancel" data-band={cancel.kind}>
      <div className="w-full px-3 py-2 flex items-start gap-2">
        <span className="shrink-0" style={{ color: CANCEL_FG }}><Icon /></span>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-(length:--ui-f) leading-tight" style={{ color: CANCEL_FG }}>{cancel.name} 取消</p>
          <p className="mt-1 font-bold text-(length:--ui-f) leading-tight" style={{ color: CANCEL_FG }}>{cancel.name}は取り消されました</p>
          {cancel.reason && (
            <p className="mt-0.5 text-secondary text-(length:--ui-fs) leading-relaxed whitespace-pre-line">{cancel.reason}</p>
          )}
        </div>
        <button
          className="shrink-0 p-1 text-secondary hover:text-white"
          onClick={onDismiss}
          aria-label={`${cancel.name}の取消の表示を閉じる`}
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  )
}

/** 国際津波関連情報の帯の見出し。通信試験はそうと書く（2026-11-09 ユーザー選択「帯に出す (Recommended)」の説明の見出し） */
function internationalTsunamiBandTitle(item: InternationalTsunamiBandItem): string {
  return item.report.isCommunicationsTest ? '国際津波関連情報 通信試験' : '国際津波関連情報'
}

// 地震カードに付かない国際津波関連情報（WEPA60）の帯。通信試験（設定「試験報を受信」が入の端末だけ）と、発生時刻を読めない報。
//
// 色はお知らせと同じ無彩色（2026-11-10 ユーザー選択「灰（お知らせと同じ）」）。中身は受信機関への運用連絡で、お知らせと同じ性質。
// 開くと英文（地震カードの欄と同じ部品。訳せる行は日本語訳、「原文」で英文へ切り替える。通信試験の文は訳の対象外なので原文のまま）。
// 期限（発表から 7 日）は出さない（他の帯と同じく表示上の都合で、気象庁が定めた期限ではない）。
function InternationalTsunamiBanner({ list, banners }: { list: readonly InternationalTsunamiBandItem[]; banners: SpecialInfoBanners }) {
  return (
    <StackedBanner
      list={list}
      frameClass="bg-slate-800/95 border-t-2 border-slate-400"
      icon={<NoticeIcon />}
      speaking={false}
      subject="internationalTsunami"
      header={(item, more) => (
        <div className="min-w-0 flex-1 flex items-center gap-2">
          {more}
          <Marquee className="flex-1 text-white text-(length:--ui-f) font-bold leading-tight" text={internationalTsunamiBandTitle(item)} />
        </div>
      )}
      rowTitle={item => <Marquee className={ROW_TITLE} text={internationalTsunamiBandTitle(item)} />}
      detail={item => (
        <div className="px-3 pb-2 text-white text-(length:--ui-fs)">
          <InternationalTsunamiText report={item.report} startWithOriginal={item.report.isCommunicationsTest} />
          <p className="text-secondary text-(length:--ui-fs)">
            発表: {new Date(item.reportDateTime).toLocaleString('ja-JP')}
          </p>
        </div>
      )}
      dismissAllLabel="国際津波関連情報を閉じる"
      dismissOneLabel="この国際津波関連情報を閉じる"
      onDismissAll={() => banners.dismiss('internationalTsunami')}
      onDismissOne={id => banners.dismissOne('internationalTsunami', id)}
    />
  )
}
