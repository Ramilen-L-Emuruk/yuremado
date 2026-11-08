import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { PREFECTURES } from '../../data/prefectureCodes'
import { OVERLAY_BACKDROP_PAD } from '../../rootFrame'

/** 選んだ都道府県の一言。何も選んでいなければ「全国」（2026-11-03 ユーザー選択「通知する地域」の説明で決めた表示） */
export function prefectureSummary(codes: readonly string[]): string {
  if (codes.length === 0) return '全国'
  const names = PREFECTURES.filter(p => codes.includes(p.code)).map(p => p.name)
  if (names.length === 0) return '全国'
  return names.length === 1 ? names[0] : `${names[0]}ほか ${names.length - 1}`
}

/**
 * 設定「通知する地域」。押すとポップアップで 47 都道府県の一覧を開き、選んだ県だけを通知する。全部外すと全国に戻る
 * （一覧を行の中に開いたままにしない。2026-11-03 ユーザー発言「いやぁ流石に常時表示はありえない。ポップアップとかにして。」）。
 *
 * 作りは設定の窓の上に重ねる変更履歴の窓（`ReleaseNotesDialog`）に揃える —— 設定の窓と同じ重なり順で body に描き
 * （後から足した側が上に来る）、開いたらフォーカスを［閉じる］へ移す。設定の窓の Esc は窓の中にフォーカスがあるときだけ
 * 閉じるので、移さないと Esc で設定の窓ごと閉じる。閉じたら押しボタンへ戻す。
 */
export function PrefecturePicker({ value, onChange }: { value: readonly string[]; onChange: (codes: string[]) => void }) {
  const [open, setOpen] = useState(false)
  const openerRef = useRef<HTMLButtonElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true
      closeRef.current?.focus()
      // 先に受けて伝わりを止める。フォーカスが body に落ちていると、設定の窓の Esc も窓を閉じてしまう
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== 'Escape' || e.isComposing) return
        e.stopImmediatePropagation()
        setOpen(false)
      }
      window.addEventListener('keydown', onKey, true)
      return () => window.removeEventListener('keydown', onKey, true)
    }
    if (wasOpenRef.current) {
      wasOpenRef.current = false
      openerRef.current?.focus()
    }
  }, [open])
  const toggle = (code: string) => {
    const next = value.includes(code) ? value.filter(c => c !== code) : [...value, code]
    onChange(next.sort())
  }
  return (
    <>
      <button
        ref={openerRef}
        type="button"
        className="rounded-md border border-border bg-panel px-3 py-1.5 text-xs text-white whitespace-nowrap transition-colors motion-reduce:transition-none hover:bg-white/10"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        {prefectureSummary(value)}
      </button>
      {open && createPortal(
        <div
          className={`fixed inset-0 z-100000 flex items-center justify-center bg-black/60 ${OVERLAY_BACKDROP_PAD} [--text-sm:0.90625rem] [--text-xs:0.71875rem] min-[520px]:[--text-sm:1rem] min-[520px]:[--text-xs:0.78125rem]`}
          // ポータルでも React のイベントは設定の窓の暗幕まで伝わるので、ここで止める（変更履歴の窓と同じ）
          onClick={e => {
            e.stopPropagation()
            if (e.target === e.currentTarget) setOpen(false)
          }}
          onPointerDown={e => e.stopPropagation()}
          role="presentation"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="通知する地域"
            className="max-h-full overflow-y-auto rounded-md border border-border bg-panel p-4 shadow-[0_3px_8px_rgba(0,0,0,.55)]"
          >
            <div className="mb-3 flex items-center justify-between gap-4">
              <span className="text-sm text-white">通知する地域</span>
              <span className="text-xs text-secondary">{prefectureSummary(value)}</span>
            </div>
            <div className="grid grid-cols-3 gap-x-4 gap-y-1.5 text-xs text-secondary">
              {PREFECTURES.map(p => (
                <label key={p.code} className="flex cursor-pointer items-center gap-1 whitespace-nowrap">
                  <input type="checkbox" checked={value.includes(p.code)} onChange={() => toggle(p.code)} />
                  {p.name}
                </label>
              ))}
            </div>
            <div className="mt-4 flex justify-end">
              <button ref={closeRef} type="button" className="rounded-md border border-border bg-panel px-3 py-1.5 text-xs text-white whitespace-nowrap transition-colors motion-reduce:transition-none hover:bg-white/10" onClick={() => setOpen(false)}>
                閉じる
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
