import { useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { CANCEL_FADE_MS, fadeIn } from './EarthquakeTab/quakeMotion'
import { useMessages } from '../i18n/I18nProvider'
import { OVERLAY_BACKDROP_PAD } from '../rootFrame'

/**
 * 地震カードの再生ボタンを、ライブ表示中に押したときに出す確認の窓。
 *
 * **ライブ中だけ出す**（2026-11-08 ユーザー選択「ライブ中だけ確認する (Recommended)」。文面とボタンも同じ選択の説明のまま）。
 * 再生を始めるとライブの受信が止まり、表示中の地震・津波・速報はいったん捨てられる（→ `useReplayController` の `start`）。
 * 誤って触ったとき、その間の本物の速報が画面に出ないので止める。再生中に押したときは既にライブが止まっているので出さない。
 *
 * ［やめる］・Esc・窓の外は、どれも「再生しない」。作りは使用状況データの窓（`UsageConsentDialog`）に揃える。
 */
export function QuakeReplayConfirmDialog({ onAnswer }: {
  /** 再生するなら true。やめる・閉じたら false */
  onAnswer: (start: boolean) => void
}) {
  const t = useMessages().replayConfirm
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (panelRef.current) fadeIn(panelRef.current, CANCEL_FADE_MS)
  }, [])

  // 既定の焦点は［やめる］に置く（Enter を押しただけでライブが止まらないように）
  useEffect(() => { cancelRef.current?.focus() }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onAnswer(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onAnswer])

  const button = 'rounded-md border border-border bg-panel px-3 py-1 text-(length:--ui-fs) hover:bg-white/10 hover:text-white'
  const content = (
    <div
      className={`fixed inset-0 z-100000 flex items-center justify-center bg-black/60 ${OVERLAY_BACKDROP_PAD}`}
      onClick={(e) => {
        e.stopPropagation()
        if (e.target === e.currentTarget) onAnswer(false)
      }}
      onPointerDown={(e) => e.stopPropagation()}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="quake-replay-confirm-title"
        className="ui-text flex w-full max-w-md flex-col gap-3 rounded-md border border-border bg-panel p-4 shadow-[0_3px_8px_rgba(0,0,0,.55)]"
      >
        <div className="ui-text-scope contents text-(length:--ui-f)">
        <div id="quake-replay-confirm-title" className="text-white">{t.title}</div>
        <p className="text-(length:--ui-fs) leading-relaxed text-secondary">
          {t.body}
        </p>
        <div className="flex justify-end gap-2">
          <button ref={cancelRef} type="button" onClick={() => onAnswer(false)} className={`${button} text-secondary`}>
            {t.cancel}
          </button>
          <button type="button" onClick={() => onAnswer(true)} className={`${button} text-white`}>
            {t.confirm}
          </button>
        </div>
        </div>
      </div>
    </div>
  )
  return createPortal(content, document.body)
}
