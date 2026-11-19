import { log } from './logger'

// 文書のスクロール位置を、0 でなくなったら 0 へ戻す。
//
// **このアプリの文書は、本来スクロールしない**（`html`・`body`・`#root` は `overflow: hidden`）。ところが iOS のホーム画面から
// 通知を押して開いたあと、文書がステータスバーの帯の分だけスクロールした状態になり、固定配置の外枠の描画と当たり判定が
// その分ずれて、押した場所より下に当たり判定が出ることがあった。`scrollTo(0, 0)` で直った。実測と判定手順は
// docs/spec/architecture-spec.md「画面いっぱいへの広がりとセーフエリア」規則 5。
//
// **iOS がその位置を置く瞬間にどのイベントが出るかは分かっていない**（手で `scrollTo` しても元へ押し戻され、再現できない）。
// そこで、スクロール・画面が前に出た・向きや大きさの変化・押した・入力欄から離れた、のどれでも見る。
// 押したときの確認は、その押下そのものは直らない（当たり判定は押す前に決まる）が、次の押下から直す保険。

/** 戻す対象。`window` をそのまま渡せる形で、テストでは作り物を渡す */
export interface PageScrollTarget {
  readonly scrollX: number
  readonly scrollY: number
  scrollTo(x: number, y: number): void
  addEventListener(type: string, listener: () => void, options?: boolean | { capture?: boolean; passive?: boolean }): void
  removeEventListener(type: string, listener: () => void, options?: boolean | { capture?: boolean }): void
  readonly document: {
    readonly activeElement: { readonly tagName: string; readonly type?: string; readonly isContentEditable?: boolean } | null
    addEventListener(type: string, listener: () => void): void
    removeEventListener(type: string, listener: () => void): void
  }
}

/** キーボードを出さない `<input>` の種類。ここに無い種類（text・search・email・number・password・日付など）は、文字を入力する欄として扱う */
const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set(['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'file', 'color', 'image'])

/**
 * 文字を入力する欄にフォーカスがあるか。キーボードを出した iOS が欄を見せるために文書をずらすので、そのときは戻さない。
 * チェックボックス・スライダーなどはキーボードを出さないので入力中に数えない（フォーカスが残っても戻す）。
 */
function isEditing(doc: PageScrollTarget['document']): boolean {
  const el = doc.activeElement
  if (el === null) return false
  if (el.tagName === 'INPUT') return !NON_TEXT_INPUT_TYPES.has((el.type ?? 'text').toLowerCase())
  return el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable === true
}

/** 戻したことの記録を出す最短の間隔 (ms)。押すたびに走る合図があるので、戻らない状況が続いても記録を溢れさせない */
const LOG_INTERVAL_MS = 10_000
let lastLogAt = Number.NEGATIVE_INFINITY

/** 入力欄から離れたあと、移った先の欄にフォーカスが入るのを待つ時間 (ms)。欄から欄へ移る途中で戻さないため */
const FOCUS_OUT_SETTLE_MS = 300

/** テスト用。記録の間引きの記憶を空に戻す */
export function resetPageScrollLogForTest(): void {
  lastLogAt = Number.NEGATIVE_INFINITY
}

/** 文書のスクロール位置が 0 でなければ戻す。戻したら true */
export function resetPageScroll(target: PageScrollTarget, trigger: string): boolean {
  if (target.scrollX === 0 && target.scrollY === 0) return false
  if (isEditing(target.document)) return false
  const { scrollX, scrollY } = target
  target.scrollTo(0, 0)
  const now = performance.now()
  if (now - lastLogAt >= LOG_INTERVAL_MS) {
    lastLogAt = now
    log.info(`[画面] 文書のスクロール位置が (${scrollX}, ${scrollY}) になっていたので 0 へ戻した（${trigger}）`)
  }
  return true
}

/**
 * 文書のスクロール位置を見張り、0 でなくなったら戻すようにする。`main.tsx` から 1 度だけ呼ぶ。
 * 外すときの関数を返す。
 */
export function installPageScrollReset(target: PageScrollTarget): () => void {
  const windowEvents = ['scroll', 'resize', 'orientationchange', 'focus', 'pageshow'] as const
  const handlers = new Map<string, () => void>()
  for (const type of windowEvents) {
    const handler = () => { resetPageScroll(target, type) }
    handlers.set(type, handler)
    target.addEventListener(type, handler)
  }
  // 押下は、他の処理より先に見る（捕捉の段）
  const onPointerDown = () => { resetPageScroll(target, 'pointerdown') }
  target.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })
  const onVisibility = () => { resetPageScroll(target, 'visibilitychange') }
  target.document.addEventListener('visibilitychange', onVisibility)
  // 入力欄から離れた直後は戻さずに待つ（欄から欄へ移るときは、移った先にフォーカスが入ると戻さない条件に戻る）。
  // 待った後で見て、入力中でなければ戻す。入力中に止めていた分を、離れたあとに取りこぼさない
  let focusOutTimer: ReturnType<typeof setTimeout> | undefined
  const onFocusOut = () => {
    clearTimeout(focusOutTimer)
    focusOutTimer = setTimeout(() => { resetPageScroll(target, 'focusout') }, FOCUS_OUT_SETTLE_MS)
  }
  target.document.addEventListener('focusout', onFocusOut)
  // 入れた時点で既にずれていることがある（起動の途中で置かれたとき）
  resetPageScroll(target, '起動')
  return () => {
    for (const [type, handler] of handlers) target.removeEventListener(type, handler)
    target.removeEventListener('pointerdown', onPointerDown, { capture: true })
    target.document.removeEventListener('visibilitychange', onVisibility)
    target.document.removeEventListener('focusout', onFocusOut)
    clearTimeout(focusOutTimer)
  }
}
