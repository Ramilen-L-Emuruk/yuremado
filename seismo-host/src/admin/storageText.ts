// 保存先と容量の文言（2026-10-13 ユーザー承認）。**保存先タブと稼働状況タブの両方がここを読む** ——
// 別々に書くと、片方だけ直したときに同じ事実が 2 通りの言い方で出る。
//
// 返す HTML はすべて組み立て済み（理由やパスは `escapeHtml` を通す。パスは運用者の入力で、理由には
// OS の例外の文面が混ざる）。

import { namedWarning, singleWarning, type StatusWarning } from './statusWarnings'

/** 空き容量の警告が解消したときの呼び名（2026-10-27 ユーザー承認）。 */
const STORAGE_LOW_LABEL = '保存先の空き容量が少ない'

/** `GET /api/storage` の形（`receiver/storageControl.ts` の `StorageReport`）。**画面が読む分だけ。** */
export interface StorageReportView {
  readonly source: 'env' | 'settings' | 'default'
  readonly root: string | null
  readonly dirs: { readonly raw: string; readonly wave: string; readonly summary: string; readonly events: string }
  readonly pendingRoot: string | null
  readonly pendingIgnored: string | null
  readonly startupProblem: string | null
  readonly journalProblem: string | null
  readonly usage: StorageUsageView
  readonly migration: MigrationView | null
}

export type StorageKindView = 'raw' | 'wave' | 'events' | 'summary'

export interface DriveView {
  readonly kinds: readonly StorageKindView[]
  readonly freeBytes: number
  readonly totalBytes: number
  readonly growthBytesPerDay: number | null
  readonly daysLeft: number | null
  readonly warning: 'low-days' | 'low-free' | null
}

export interface StorageUsageView {
  readonly kinds:
    | readonly { readonly kind: StorageKindView; readonly path: string; readonly bytes: number; readonly files: number }[]
    | null
  readonly countedAtMs: number | null
  readonly drives: readonly DriveView[]
  readonly lastError: string | null
}

export interface MigrationView {
  readonly from: string
  readonly to: string
  readonly state: 'copying' | 'copied' | 'purging' | 'done'
  readonly totalFiles: number | null
  readonly totalBytes: number | null
  readonly doneFiles: number
  readonly doneBytes: number
  readonly skippedExists: number
  readonly skippedUnreadable: number
  readonly blockedBySpace: { readonly neededBytes: number; readonly freeBytes: number } | null
  readonly lastError: string | null
  readonly purgeable: { readonly files: number; readonly bytes: number } | null
  /** 複製の途中で前の保存先が見つからない（「複製をやめる」を出す）。v5.49.0 までのホストは送らない。 */
  readonly sourceMissing?: boolean
  /** いま消している最中の進み具合。v5.49.0 までのホストは送らない。 */
  readonly purgeProgress?: { readonly doneFiles: number; readonly totalFiles: number } | null
  readonly purged: { readonly files: number; readonly bytes: number; readonly kept: number } | null
}

/** `/status` の `storage` 欄（パスを含まない。`receiver/storageControl.ts` の `StorageBrief`）。 */
export interface StorageBriefView {
  readonly drives: readonly DriveView[]
  readonly lastError: string | null
  readonly migration: {
    readonly state: MigrationView['state']
    readonly blockedBySpace: boolean
    readonly lastError: string | null
  } | null
  readonly startupProblem: string | null
  readonly journalProblem: string | null
}

export const KIND_LABELS: Readonly<Record<StorageKindView, string>> = {
  raw: '生データ',
  wave: '合成波形',
  summary: '要約',
  events: '揺れの記録',
}

/** 表の並び（保存先タブ）。 */
export const KIND_ORDER: readonly StorageKindView[] = ['raw', 'wave', 'summary', 'events']

export const LOW_FREE_PERCENT = 5

/** バイト数を GB・MB・KB へ。GB と MB は小数 1 桁、KB 以下は整数。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const GB = 1024 ** 3
  const MB = 1024 ** 2
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

export function formatCount(n: number): string {
  return n.toLocaleString('ja-JP')
}

/** 「あと」の欄。出せない間（測り始め・増えていない）は「—」。 */
export function daysLeftText(days: number | null): string {
  return days === null ? '—' : `約 ${Math.max(0, Math.round(days))} 日`
}

export function growthText(bytesPerDay: number | null): string {
  return bytesPerDay === null ? '—' : `${formatBytes(bytesPerDay)}/日`
}

/** `PUT /api/storage` で受け付けなかった理由。 */
export function setPendingProblemText(problem: string, detail: string | null): string {
  switch (problem) {
    case 'not-absolute':
      return '絶対パスで入力してください'
    case 'same':
      return 'いまの保存先と同じ'
    case 'nested':
      return 'いまの保存先と入れ子になっている'
    case 'not-writable':
      return `書き込めない: ${detail ?? ''}`
    case 'not-enough-space': {
      const [needed, free] = (detail ?? '').split('/').map(Number)
      return needed !== undefined && free !== undefined && Number.isFinite(needed) && Number.isFinite(free)
        ? spaceShortText(needed, free)
        : '空き容量が不足している'
    }
    case 'locked':
      return '環境変数で固定されているので変えられない'
    case 'migrating':
      return '前の保存先からの複製が終わるまで変えられない'
    default:
      return problem
  }
}

export function spaceShortText(neededBytes: number, freeBytes: number): string {
  return `空き容量が不足している: 必要 ${formatBytes(neededBytes)}、空き ${formatBytes(freeBytes)}`
}

/** 警告の行（組み立て済みの HTML）。稼働状況タブの警告の欄と、保存先タブの上に出す。 */
export function storageWarnings(brief: StorageBriefView): readonly string[] {
  return storageWarningList(brief).map((w) => w.html)
}

/**
 * {@link storageWarnings} の組の形（通知の見張りが出入りを見るのに使う）。**ドライブの警告の鍵は、
 * そのドライブに置いている種類の並び**（`DriveView` はドライブの名前を持たない。種類の割り当ては
 * 保存先を変えない限り動かない）。
 *
 * **「10% を切った」と「あと約 N 日」は同じ 1 つの警告として扱う**（鍵は同じ・解消の呼び名は
 * 「保存先の空き容量が少ない」。2026-10-27 ユーザー承認「1 つにまとめる」）。分けると、あと N 日から
 * 10% を切ったへ悪くなったときに「解消した」が出る。
 */
export function storageWarningList(brief: StorageBriefView): readonly StatusWarning[] {
  const out: StatusWarning[] = []
  for (const d of brief.drives) {
    const key = `storage-low:${[...d.kinds].sort().join(',')}`
    if (d.warning === 'low-free') {
      out.push(
        namedWarning(
          key,
          STORAGE_LOW_LABEL,
          `保存先の空き容量が ${LOW_FREE_PERCENT}% を切った（空き ${formatBytes(d.freeBytes)} / ${formatBytes(d.totalBytes)}）`,
        ),
      )
    } else if (d.warning === 'low-days' && d.daysLeft !== null) {
      out.push(
        namedWarning(key, STORAGE_LOW_LABEL, `保存先の空き容量があと約 ${Math.max(0, Math.round(d.daysLeft))} 日でなくなる`),
      )
    }
  }
  if (brief.migration?.blockedBySpace === true) {
    out.push(singleWarning('storage-copy-blocked', '前の保存先からの複製が止まっている: 空き容量が不足している'))
  }
  // 複製している間の失敗だけ。削除のときの「残したもの」は複製の欄の件数で伝える（`migrationHtml`）。
  if (brief.migration?.state === 'copying' && brief.migration.lastError !== null) {
    out.push(singleWarning('storage-copy-failed', '前の保存先からの複製に失敗した', brief.migration.lastError))
  }
  // 削除は裏で走るので、消せなかった理由はここでしか画面に届かない（2026-10-13 ユーザー承認）。
  if (brief.migration?.state === 'purging' && brief.migration.lastError !== null) {
    out.push(singleWarning('storage-purge-failed', '前の保存先から削除できなかった', brief.migration.lastError))
  }
  if (brief.journalProblem !== null) {
    out.push(singleWarning('storage-journal', '複製の記録を読めない', brief.journalProblem))
  }
  if (brief.startupProblem !== null) {
    out.push(singleWarning('storage-startup', '保存先を移せなかった', brief.startupProblem))
  }
  if (brief.lastError !== null) out.push(singleWarning('storage-measure', '容量を測れない', brief.lastError))
  return out
}

/** `POST /api/storage/purge-old` で消せなかった理由（`receiver/storageControl.ts` の `PurgeResult`）。 */
export function purgeProblemText(reason: string, detail: string | null): string {
  switch (reason) {
    case 'failed':
      return `前の保存先から削除できなかった: ${detail ?? ''}`
    case 'busy':
      return '前の保存先から削除している最中'
    case 'not-copied':
      return '複製が終わっていないので削除できない'
    default:
      return reason
  }
}

/** 複製をやめる確認の窓の本文（2026-10-13 ユーザー承認）。 */
export function abandonConfirmBody(from: string): string {
  return `${from} からの複製をやめます。まだ複製していない分は前の保存先に残り、この画面からは削除できなくなります。`
}

/** 保存先の確認の窓の本文。 */
export function purgeConfirmBody(from: string, files: number, bytes: number): string {
  return `${from} から、複製と照合が済んだ ${formatCount(files)} 件（${formatBytes(bytes)}）を削除します。この操作は元に戻せません。`
}
