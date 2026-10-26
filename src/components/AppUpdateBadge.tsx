import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ReloadSchedule } from '../hooks/useReloadSchedule'
import { isDmdss } from '../utils/env'
import { log } from '../utils/logger'
import { compareVersions, notesBetween, notesForUpdate, type ReleaseNoteEntry } from '../utils/releaseNotes'
import { lastOpenedVersionKey, previousVersionToAnnounce } from '../utils/updatedNotice'
import { ReleaseNotesDialog } from './ReleaseNotesDialog'

const VARIANT = isDmdss ? 'dmdss' : 'standard'

/** 「バージョン X に更新しました」を出しておく時間（2026-10-26 ユーザー承認「30 秒で消える」）。 */
export const UPDATED_NOTICE_MS = 30_000

/**
 * 地図左上の列（アプリの状態の列）に出す、更新の札（2026-10-26 ユーザー承認「地図の右上の列」「体言止めの形」。
 * 列ごと左上へ移したのは 2026-10-27 ユーザー指示「そもそも右上じゃなくて左上にしたい(地震計と入れ替える。日本列島が右上向きだから)」）。
 *
 * - 秒読み中: 「10 秒後に更新します」（毎朝の読み直しなら「再読み込みします」）と［後で］
 * - 新しい版が待っている（発表中・再生中・入力中・「後で」で待たせている間も）: 「新しいバージョン 5.70.0」と
 *   ［変更内容］［今すぐ更新］
 * - 更新した直後: 「バージョン 5.70.0 に更新しました」と［変更内容］［閉じる］。30 秒で消える
 *
 * 前に開いた版は localStorage にバリアントごとに覚える（`utils/updatedNotice.ts`）。
 */
export function AppUpdateBadge({ schedule }: { schedule: ReloadSchedule }) {
  // **読むのは初期値の段、書くのは効果の段に分ける。** 効果の中で読んでから書くと、開発時の StrictMode が
  // 効果を 2 回走らせたとき、2 回目が自分の書いた今の版を読んで「更新していない」と判断する
  const [updatedFrom, setUpdatedFrom] = useState<string | null>(() => {
    try {
      return previousVersionToAnnounce(localStorage.getItem(lastOpenedVersionKey(VARIANT)), __APP_VERSION__)
    } catch (err) {
      log.warn('[更新] 前に開いた版を読めなかった（更新しましたの知らせは出さない）', err)
      return null
    }
  })
  // 窓に出す範囲は **開いた時点で固定する**。開いている間に新しい版が届いても、読んでいる中身を差し替えない
  const [notes, setNotes] = useState<{ kind: 'waiting'; to: string | null } | { kind: 'updated'; from: string } | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(lastOpenedVersionKey(VARIANT), __APP_VERSION__)
    } catch (err) {
      log.warn('[更新] 開いた版を覚えられなかった（次に更新しても知らせが出ない）', err)
    }
  }, [])

  const newVersion = schedule.update.newVersion
  const showingUpdated = schedule.countdown === null && !schedule.update.waiting && updatedFrom !== null && notes === null
  // 30 秒は「更新しました」の札が見えている間だけ数える（秒読みや窓の陰にいる間に消えないように）
  useEffect(() => {
    if (!showingUpdated) return
    const id = window.setTimeout(() => setUpdatedFrom(null), UPDATED_NOTICE_MS)
    return () => window.clearTimeout(id)
  }, [showingUpdated])

  const openNotes = (range: NonNullable<typeof notes>) => setNotes(range)
  const closeNotes = useCallback(() => setNotes(null), [])

  const select = useMemo(() => {
    if (notes === null) return null
    if (notes.kind === 'updated') {
      const { from } = notes
      return (entries: readonly ReleaseNoteEntry[]) => notesForUpdate(entries, from, __APP_VERSION__, VARIANT)
    }
    const { to } = notes
    // 待っている版の変更内容。番号を取れていなければ、資料に載っているいちばん新しい版までを出す
    return (entries: readonly ReleaseNoteEntry[]) => {
      if (to !== null) return notesForUpdate(entries, __APP_VERSION__, to, VARIANT)
      const latest = entries.reduce<string>((best, e) => ((compareVersions(e.version, best) ?? 0) > 0 ? e.version : best), __APP_VERSION__)
      return notesBetween(entries, __APP_VERSION__, latest, VARIANT)
    }
  }, [notes])

  const openWaitingNotes = () => {
    if (newVersion === null) log.warn('[更新] 新しい版の番号が分からないまま変更内容を開いた（資料のいちばん新しい版までを出す）')
    openNotes({ kind: 'waiting', to: newVersion })
  }

  let body: ReactNode = null
  if (schedule.countdown !== null) {
    const verb = schedule.countdownReason === 'periodic' ? '再読み込みします' : '更新します'
    body = (
      <>
        <span>{schedule.countdown} 秒後に{verb}</span>
        <BadgeButton onClick={schedule.postpone}>後で</BadgeButton>
      </>
    )
  } else if (schedule.update.waiting) {
    body = (
      <>
        <span>新しいバージョン{newVersion !== null ? ` ${newVersion}` : ''}</span>
        <BadgeButton onClick={openWaitingNotes}>変更内容</BadgeButton>
        <BadgeButton onClick={schedule.applyNow}>今すぐ更新</BadgeButton>
      </>
    )
  } else if (updatedFrom !== null) {
    body = (
      <>
        <span>バージョン {__APP_VERSION__} に更新しました</span>
        <BadgeButton onClick={() => openNotes({ kind: 'updated', from: updatedFrom })}>変更内容</BadgeButton>
        <BadgeButton onClick={() => setUpdatedFrom(null)}>閉じる</BadgeButton>
      </>
    )
  }

  return (
    <>
      {body !== null && (
        <div className="pointer-events-auto flex items-center gap-2 bg-black/80 rounded-sm text-xs px-2 py-1 roomy:text-lg roomy:px-2.5 text-white">
          {body}
        </div>
      )}
      {select !== null && <ReleaseNotesDialog title={null} select={select} onClose={closeNotes} />}
    </>
  )
}

function BadgeButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-sm border border-white/30 px-2 py-0.5 hover:bg-white/15"
    >
      {children}
    </button>
  )
}
