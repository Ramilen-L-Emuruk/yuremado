import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { SETTINGS_DIALOG_ATTR } from '../../utils/appUpdateGate'
import { useMessages } from '../../i18n/I18nProvider'
import { SETTINGS_CATEGORIES, type SettingsCategoryId } from './settingsCategories'

export { SETTINGS_CATEGORIES, type SettingsCategoryId } from './settingsCategories'

const ActiveCategoryContext = createContext<SettingsCategoryId | null>(null)

/**
 * その分類がいま選ばれているか。選ばれていない分類の見出しは**外さずに隠す**（`SettingsTab` の `Section`）——
 * 中の行が持つ状態（入力途中の値・設定の読み込みの結果・診断ログの件数など）を、分類を移るたびに捨てないため。
 */
export function useIsSettingsCategoryActive(id: SettingsCategoryId): boolean {
  return useContext(ActiveCategoryContext) === id
}

/**
 * 設定の窓（2026-10-27 ユーザー承認）。
 *
 * - **幅 640px 以上**: 画面の中央に出す 2 ペインの窓。左に分類の一覧、右に選んだ分類の中身
 *   （選んだ選択肢「2ペインの窓 (Recommended)」）
 * - **幅 640px 未満**: 全画面。最初は分類の一覧で、押すと中身へ進み、左上の「←」で一覧へ戻る
 *   （選んだ選択肢「全画面で一覧→中身 (Recommended)」）
 *
 * 閉じる操作は ×・Esc・窓の外（幅 640px 以上のときだけ外側が見える）。**閉じても中身は外さずに隠す**
 * （`hidden`）。中の行の状態を、開け閉めのたびに捨てないため。
 *
 * **開いている間は、窓の後ろのページ（`#root`）を `inert` にする。** 窓は全面を覆うが、それだけでは
 * Tab で後ろのナビや地図へフォーカスが抜け、見えない要素を操作できてしまう（そのとき Esc も窓へ届かない）。
 * 窓は `document.body` 直下へ出すので、`#root` を止めても窓の中は止まらない。
 *
 * 自動のタブ移動で画面を移すときに閉じるのは App 側（`setActiveTab` の包み）が受け持つ。
 * **タブ移動を伴わない表示（特別情報の帯・行動チェックリストの帯）では閉じない。** 開いている間は窓の後ろに
 * 隠れ、閉じればそこに出ている（2026-10-27 ユーザー承認。選んだ選択肢「今のまま」）。
 */
export function SettingsDialog({ open, onClose, returnFocusRef, children }: {
  open: boolean
  onClose: () => void
  /**
   * 閉じたときにフォーカスを戻す先（ナビの歯車）。開く直前の `document.activeElement` から推し量らないのは、
   * Safari ではボタンを押してもフォーカスが移らず、控えられるのが `body` になるため。
   */
  returnFocusRef: RefObject<HTMLElement>
  children: ReactNode
}) {
  const [active, setActive] = useState<SettingsCategoryId>(SETTINGS_CATEGORIES[0].id)
  // 幅 640px 未満で、分類の一覧を出しているか（中身へ進んだら偽）。幅 640px 以上では使わない（両方を並べる）。
  const [showList, setShowList] = useState(true)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  // 一度でも開いたか。初回の描画（閉じたまま）でフォーカスを動かさないため。
  const openedRef = useRef(false)
  // 直前の押下が暗幕の上だったか（窓の外を押して閉じる判定に使う）
  const pressedOnBackdropRef = useRef(false)

  useLayoutEffect(() => {
    const page = document.getElementById('root')
    if (open) {
      openedRef.current = true
      if (page) page.inert = true
      // 幅の狭い画面では、開くたびに分類の一覧から始める（前に見ていた中身の途中から始まると、どこにいるか分からない）
      setShowList(true)
      closeRef.current?.focus()
      return
    }
    // 先に `inert` を外す。外す前に戻すと、戻し先が止まったままでフォーカスが入らない。
    if (page) page.inert = false
    if (!openedRef.current) return
    // 窓の中にフォーカスが残っている（隠した直後はブラウザが `body` へ落とすこともある）ときだけ戻す。
    // 閉じた後に利用者が別の場所を操作し始めていたら、そのフォーカスは奪わない。
    const focused = document.activeElement
    if (focused === null || focused === document.body || dialogRef.current?.contains(focused)) {
      returnFocusRef.current?.focus()
    }
  }, [open, returnFocusRef])

  // 開いたまま外されたとき（画面ごと落ちたときなど）に、ページを止めたまま残さない
  useEffect(() => () => {
    const page = document.getElementById('root')
    if (page) page.inert = false
  }, [])

  // 分類を移ったら中身を先頭から見せる（中身のスクロール領域は全分類で 1 つなので、前の分類の位置が残る）
  useLayoutEffect(() => {
    contentRef.current?.scrollTo({ top: 0 })
  }, [active, showList])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // 日本語入力の変換を取り消す Esc で、窓ごと閉じない
      if (e.isComposing) return
      // 説明の吹き出しが出ているなら、その Esc は吹き出しを閉じるためのもの（`DescriptionTip` が閉じる）。
      // 窓まで一緒に閉じると、説明を読み終えて閉じたつもりが設定ごと消える。
      // 探すのは窓の中だけ（吹き出しは行の中にそのまま描かれる）。窓の外のものまで拾うと、後ろのページで
      // 開いたままの吹き出しが窓の Esc を塞ぐ。
      if (dialogRef.current?.querySelector('[role="tooltip"]')) return
      // 窓の上に重ねた別の窓（変更履歴）の Esc は、その窓が受け持つ。こちらは窓の中にフォーカスがあるときだけ閉じる。
      const target = e.target
      if (target instanceof Node && target !== document.body && !dialogRef.current?.contains(target)) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const w = useMessages().settings
  const activeLabel = w.categories[active]

  const content = (
    <div
      hidden={!open}
      // 属性だけでなくクラスでも隠す。`flex` と `hidden` 属性の兼ね合いを、プリフライトの `[hidden]` の扱いに預けない
      className={`${open ? 'flex' : 'hidden'} fixed inset-0 z-100000 items-stretch justify-center bg-black/60 sm:items-center sm:p-6`}
      // 押したときも離したときも暗幕の上だったときだけ閉じる。窓の中で押して外で離すと（入力欄の文字を
      // 選んでいて枠の外へはみ出したときなど）、ブラウザは共通の祖先＝暗幕へ click を送るので、離した側だけでは決めない。
      onPointerDown={(e) => {
        pressedOnBackdropRef.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        const pressedOnBackdrop = pressedOnBackdropRef.current
        pressedOnBackdropRef.current = false
        if (pressedOnBackdrop && e.target === e.currentTarget) onClose()
      }}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={w.dialog.title}
        {...{ [SETTINGS_DIALOG_ATTR]: '' }}
        // 角丸と影は全画面でそろえた物差し（窓は rounded-md・影は 1 種）
        className="flex h-full w-full flex-col overflow-hidden bg-app sm:h-[85dvh] sm:max-h-full sm:max-w-[880px] sm:rounded-md sm:border sm:border-border sm:shadow-[0_3px_8px_rgba(0,0,0,.55)]"
        // 窓の下のページ（App）は、操作のたびにアイドル復帰の時間を計り直す。窓の中の操作もその「操作」に
        // 数えたいので、ここでは伝播を止めない。
      >
        {/* 窓の中の文字を地震タブの 2 組にそろえる（2026-11-04 共通部が配った物差し「帯と窓だけ揃える (Recommended)」）。
            狭い組は本文 14.5px・小 11.5px、窓の幅が 520px 以上なら本文 16px・小 12.5px。窓の中は `text-sm`（本文）と
            `text-xs`（小）で書いてあるので、その 2 つの大きさの変数をここで差し替える。`contents` なので並びには効かない。
            **境は画面の幅で測る**（`min-[520px]:`）。窓の幅は 640px 未満では画面と同じ、以上では 520px を下回らないので、
            窓の幅で測るのと同じ境になる。窓をコンテナクエリの器にしないのは、器が中の `fixed`（説明の吹き出し）の
            包含ブロックになり、吹き出しの位置が窓の左上基準へずれるため。body へ出す別窓（`PrefecturePicker` など）には
            この変数が届かないので、それぞれの根で同じ組を当てる */}
        <div className="contents [--text-sm:0.90625rem] [--text-xs:0.71875rem] min-[520px]:[--text-sm:1rem] min-[520px]:[--text-xs:0.78125rem]">
        <div
          className="flex shrink-0 items-center gap-2 border-b border-border bg-panel px-3 py-2"
          style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top, 0px))' }}
        >
          {!showList && (
            <button
              type="button"
              onClick={() => setShowList(true)}
              aria-label={w.dialog.back}
              className="flex h-9 w-9 items-center justify-center rounded-md text-secondary hover:bg-white/10 hover:text-white sm:hidden"
            >
              <span aria-hidden="true" className="text-lg leading-none">←</span>
            </button>
          )}
          <h2 className="min-w-0 flex-1 truncate text-sm font-bold text-white">
            {/* 幅の狭い画面で中身を見ているときは分類名を出す（一覧が隠れているので、どこにいるかを見出しで示す） */}
            <span className={showList ? '' : 'hidden sm:inline'}>{w.dialog.title}</span>
            {!showList && <span className="sm:hidden">{activeLabel}</span>}
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={w.dialog.close}
            className="flex h-9 w-9 items-center justify-center rounded-md text-secondary hover:bg-white/10 hover:text-white"
          >
            <span aria-hidden="true" className="text-lg leading-none">×</span>
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <nav
            aria-label={w.dialog.categoryList}
            className={`${showList ? 'flex' : 'hidden'} w-full flex-col overflow-y-auto py-2 sm:flex sm:w-52 sm:shrink-0 sm:border-r sm:border-border sm:bg-panel`}
          >
            {SETTINGS_CATEGORIES.map((c) => {
              const selected = c.id === active
              return (
                <div key={c.id}>
                  {'separated' in c && <div aria-hidden="true" className="mx-3 my-2 border-t border-border" />}
                  <button
                    type="button"
                    aria-current={selected ? 'page' : undefined}
                    onClick={() => {
                      setActive(c.id)
                      setShowList(false)
                    }}
                    className={`flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm transition-colors motion-reduce:transition-none sm:py-2 ${
                      selected ? 'sm:bg-white/15 sm:text-white' : ''
                    } ${'separated' in c ? 'text-secondary' : 'text-white'} hover:bg-white/5`}
                  >
                    <span>{w.categories[c.id]}</span>
                    <span aria-hidden="true" className="text-secondary sm:hidden">›</span>
                  </button>
                </div>
              )
            })}
          </nav>
          <div
            ref={contentRef}
            className={`${showList ? 'hidden' : 'block'} min-w-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain sm:block`}
            style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
          >
            {/* 幅が広い画面では行が横へ伸びすぎないよう上限を置く。分類名の見出しは置かない（左の一覧で選んでいる分類と同じ名前の繰り返しになる） */}
            <div className="mx-auto max-w-[640px] px-4 py-4 sm:px-6 sm:py-5">
              <ActiveCategoryContext.Provider value={active}>{children}</ActiveCategoryContext.Provider>
            </div>
          </div>
        </div>
        </div>
      </div>
    </div>
  )
  return createPortal(content, document.body)
}
