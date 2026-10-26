import { compareVersions } from './releaseNotes'

/**
 * 前に開いた版を覚えておく場所。**バリアントごとに分ける** —— 標準版（`/yuremado/`）と DMDSS 版
 * （`/yuremado/dmdss/`）は同じオリジンで localStorage を共有するので、分けないと片方を開いただけで
 * もう片方の「更新しました」が消える。
 */
export function lastOpenedVersionKey(variant: 'standard' | 'dmdss'): string {
  return `yuremado-last-opened-version-${variant}`
}

/**
 * 「バージョン X に更新しました」を出すか。出すなら、前に開いていた版を返す（変更内容をそこから先だけ出すため）。
 *
 * - 覚えていない（初めて開いた・覚える前の版から来た）なら出さない —— 何から更新したのか言えない
 * - 前と同じか古い版（戻した）なら出さない
 * - 番号が読めなければ出さない
 */
export function previousVersionToAnnounce(stored: string | null, current: string): string | null {
  if (stored === null) return null
  const cmp = compareVersions(current, stored)
  return cmp !== null && cmp > 0 ? stored : null
}
