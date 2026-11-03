import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

const PRIVACY_POLICY_URL = 'https://github.com/Ramilen-L-Emuruk/yuremado/blob/main/docs/privacy-policy.md'

/**
 * 使用状況データを送ってよいかを尋ねる窓（設計書 §6.6）。初めて開いたとき（更新して来た人も）に 1 度だけ出す。
 * ［許可しない］・Esc・窓の外・閉じるは、どれも「送らない」（2026-11-03 ユーザー発言「そこで同意しなかったり
 * ポップアップを消した人の情報を送るべきじゃない」）。答えた後は二度と出さない（同日ユーザー選択「二度と出さない (Recommended)」）。
 * 作りは変更内容の窓（`ReleaseNotesDialog`）に揃える。文面は同日ユーザー選択「許可する／許可しない (Recommended)」。
 */
export function UsageConsentDialog({ onAnswer }: {
  /** 許可したら true。許可しない・閉じたら false */
  onAnswer: (allowed: boolean) => void
}) {
  const denyRef = useRef<HTMLButtonElement | null>(null)

  // 既定の焦点は［許可しない］に置く（Enter を押しただけで送る側に倒れないように）
  useEffect(() => { denyRef.current?.focus() }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onAnswer(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onAnswer])

  const button = 'rounded-sm border border-border px-3 py-1 text-xs hover:bg-white/10 hover:text-white'
  const content = (
    <div
      className="fixed inset-0 z-100000 flex items-center justify-center bg-black/60 p-2 sm:p-6"
      onClick={(e) => {
        e.stopPropagation()
        if (e.target === e.currentTarget) onAnswer(false)
      }}
      onPointerDown={(e) => e.stopPropagation()}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="usage-consent-title"
        className="flex w-full max-w-md flex-col gap-3 rounded-lg border border-border bg-panel p-4 text-sm shadow-2xl shadow-black/60"
      >
        <div id="usage-consent-title" className="text-white">揺れ窓の改善にご協力ください</div>
        <p className="text-xs leading-relaxed text-secondary">
          使用状況データ（開いたタブ・使っている機能・端末の種類など）を開発者に送信することを許可しますか？
          名前・IP アドレス・登録した地点は送信しません。この設定はいつでも変更できます。
        </p>
        <a href={PRIVACY_POLICY_URL} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:text-blue-300">
          プライバシーポリシー
        </a>
        <div className="flex justify-end gap-2">
          <button ref={denyRef} type="button" onClick={() => onAnswer(false)} className={`${button} text-secondary`}>
            許可しない
          </button>
          <button type="button" onClick={() => onAnswer(true)} className={`${button} text-white`}>
            許可する
          </button>
        </div>
      </div>
    </div>
  )
  return createPortal(content, document.body)
}
