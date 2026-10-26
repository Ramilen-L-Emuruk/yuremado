import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { fetchReleaseNotes } from '../services/releaseNotesSource'
import { isAbortedByCaller } from '../utils/fetchWithTimeout'
import { log } from '../utils/logger'
import { markReleaseNotesOpen } from '../utils/releaseNotesOpen'
import type { ReleaseNoteEntry, ReleaseNoteView } from '../utils/releaseNotes'

/**
 * 版ごとの変更内容を出す窓。更新後の知らせの［変更内容］と、設定タブの「変更履歴」の［表示］から開く。
 * 作りは波形の詳細の窓（`SeismoWaveDetail`）に揃える —— 画面全体を暗くして真ん中に出し、
 * ［閉じる］・Esc・窓の外で閉じる（2026-10-26 ユーザー承認「［表示］で窓を開く」）。
 *
 * 開くたびに配信されている変更内容を取り直す（`fetchReleaseNotes`）。どの版を出すかは呼ぶ側が
 * `select` で決める（更新後は前に開いた版より新しいものだけ、変更履歴は全部）。
 */
export function ReleaseNotesDialog({ title, select, onClose }: {
  /** 窓の見出し。無ければ版ごとの見出しだけを出す */
  title: string | null
  select: (entries: readonly ReleaseNoteEntry[]) => ReleaseNoteView[]
  onClose: () => void
}) {
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; views: ReleaseNoteView[] }>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const closeRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    setState({ kind: 'loading' })
    fetchReleaseNotes(ac.signal)
      .then((entries) => {
        const views = select(entries)
        if (views.length === 0) log.warn(`[更新] 出す変更内容が 1 件も無かった（資料の版の数 ${entries.length}）`)
        setState({ kind: 'ready', views })
      })
      .catch((err: unknown) => {
        if (isAbortedByCaller(err)) return
        log.warn('[更新] 変更内容を読み込めなかった', err)
        setState({ kind: 'failed' })
      })
    return () => ac.abort()
  }, [select, attempt])

  useEffect(() => { closeRef.current?.focus() }, [])
  // 開いている間は読み直しの秒読みを止める（窓が札を覆うので［後で］を押せない）
  useEffect(() => markReleaseNotesOpen(), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  const content = (
    <div
      className="fixed inset-0 z-100000 flex items-center justify-center bg-black/60 p-2 sm:p-6"
      onClick={(e) => {
        e.stopPropagation()
        if (e.target === e.currentTarget) onClose()
      }}
      onPointerDown={(e) => e.stopPropagation()}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title ?? (state.kind === 'ready' && state.views[0] !== undefined ? `${state.views[0].version} の変更内容` : '変更内容')}
        className="flex max-h-full w-full max-w-lg flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-panel p-4 text-sm shadow-2xl shadow-black/60"
      >
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 text-white">{title}</div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded-sm border border-border px-3 py-1 text-xs text-secondary hover:bg-white/10 hover:text-white"
          >
            閉じる
          </button>
        </div>
        {state.kind === 'loading' && <div className="text-xs text-secondary">読み込み中</div>}
        {state.kind === 'failed' && (
          <div className="flex items-center gap-3 text-xs text-secondary">
            <span>変更内容を読み込めませんでした</span>
            <button
              type="button"
              onClick={retry}
              className="rounded-sm border border-border px-3 py-1 text-xs text-secondary hover:bg-white/10 hover:text-white"
            >
              もう一度
            </button>
          </div>
        )}
        {state.kind === 'ready' && state.views.map((v) => <VersionNotes key={v.version} view={v} />)}
      </div>
    </div>
  )
  return createPortal(content, document.body)
}

function VersionNotes({ view }: { view: ReleaseNoteView }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-sm text-white">{view.version} の変更内容</h3>
      {view.minorOnly
        ? <p className="text-xs text-white/85">軽微な修正</p>
        : (
          <>
            <NoteList label="追加" items={view.added} />
            <NoteList label="修正" items={view.fixed} />
          </>
        )}
    </section>
  )
}

function NoteList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <div>
      <div className="text-xs text-secondary">{label}</div>
      <ul className="ml-4 list-disc text-xs text-white/85">
        {items.map((t, i) => <li key={i}>{t}</li>)}
      </ul>
    </div>
  )
}
