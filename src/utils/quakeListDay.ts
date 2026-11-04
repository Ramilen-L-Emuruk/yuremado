import { readDateTime } from './formatters'

/**
 * 地震一覧の日付の区切り（見本の「11月1日」。→ docs/quake-tab-redesign.md「共通の土台」）。
 *
 * 区切りの鍵は端末の時刻での年月日。
 */
export interface QuakeListDay {
  /** 同じ日かを比べる鍵。 */
  key: string
  /** 区切りに出す文字。 */
  label: string
}

/**
 * 地震の時刻から区切りを作る。今年の地震でも年を出し、どの区切りも「2026年11月2日」の形にする
 * （2026-11-02 ユーザー選択「D 常に年を出す」。元の問いは「常に年出しちゃだめなの？」）。
 *
 * 時刻が読めなければ区切りを作らない（null。読めなかったことは `readDateTime` が記録する）。
 * 実電文で地震の時刻が読めなかった例は無く、取消だけの報もカードにならないので、専用の区切りは置かない
 * （2026-11-02 ユーザー選択「2 つとも外す (Recommended)」）。
 */
export function quakeListDay(time: string): QuakeListDay | null {
  const d = readDateTime('quakeListDay', time)
  if (!d) return null
  const y = d.getFullYear()
  const m = d.getMonth() + 1
  const day = d.getDate()
  return { key: `${y}-${m}-${day}`, label: `${y}年${m}月${day}日` }
}
