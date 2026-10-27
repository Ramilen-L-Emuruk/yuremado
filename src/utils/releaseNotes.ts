/**
 * 版ごとの変更内容（`public/release-notes.json`）を、画面に出す形へ選ぶ。
 *
 * 変更内容はリリースのときに利用者向けに書く（2026-10-26 ユーザー承認「リリース時に利用者向けに書く」。
 * 書き方の決まりは `.claude/skills/release/SKILL.md`）。**アプリへは同梱しない** —— 待っている新しい版の
 * 内容を、古い版のページから読む必要があるので、配信されているファイルを取りに行く。
 */

/**
 * 変更内容を書き始めた版。これより前の版は書かない（2026-10-26 ユーザー承認「この仕組みを出す版から」）。
 * この版から先は、`package.json` の版に必ず対応する行がある（`releaseNotes.test.ts` が落とす）。
 */
export const FIRST_NOTED_VERSION = '5.70.0'

/** どちらの版に関係する行か。 */
export type ReleaseNoteVariant = 'both' | 'standard' | 'dmdss'

export interface ReleaseNoteItem {
  text: string
  variant: ReleaseNoteVariant
}

export interface ReleaseNoteEntry {
  version: string
  /** 出した日（`YYYY-MM-DD`、日本時間）。 */
  date: string
  /** 新しくできるようになったこと。 */
  added: ReleaseNoteItem[]
  /** 直したこと。 */
  fixed: ReleaseNoteItem[]
}

/** 画面に出す 1 版ぶん。関係する行が 1 つも無い版は `minorOnly` が立つ（「軽微な修正」の 1 行を出す）。 */
export interface ReleaseNoteView {
  version: string
  date: string
  added: string[]
  fixed: string[]
  minorOnly: boolean
}

/**
 * `a` と `b` の版を比べる（`5.70.0` の形。数字の並びとして比べる）。読めない番号は `null`。
 */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (pa === null || pb === null) return null
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}

function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())
  if (m === null) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** その版の利用者に関係する行か。 */
function concerns(item: ReleaseNoteItem, variant: 'standard' | 'dmdss'): boolean {
  return item.variant === 'both' || item.variant === variant
}

function toView(entry: ReleaseNoteEntry, variant: 'standard' | 'dmdss'): ReleaseNoteView {
  const added = entry.added.filter((i) => concerns(i, variant)).map((i) => i.text)
  const fixed = entry.fixed.filter((i) => concerns(i, variant)).map((i) => i.text)
  return { version: entry.version, date: entry.date, added, fixed, minorOnly: added.length === 0 && fixed.length === 0 }
}

/**
 * `fromExclusive` より新しく `toInclusive` まで（含む）の版を、新しい順に並べる（2026-10-26 ユーザー承認
 * 「間の版を新しい順に全部」）。`fromExclusive` が `null`（前に開いた版を覚えていない）なら `toInclusive` の
 * 1 版だけ。読めない番号の版は入れない。
 */
export function notesBetween(
  entries: readonly ReleaseNoteEntry[],
  fromExclusive: string | null,
  toInclusive: string,
  variant: 'standard' | 'dmdss',
): ReleaseNoteView[] {
  return sortNewestFirst(entries)
    .filter((e) => {
      const upper = compareVersions(e.version, toInclusive)
      if (upper === null || upper > 0) return false
      if (fromExclusive === null) return upper === 0
      const lower = compareVersions(e.version, fromExclusive)
      return lower !== null && lower > 0
    })
    .map((e) => toView(e, variant))
}

/**
 * 更新した後に出す版（`notesBetween`）。資料に更新先の版が載っていなければ、更新先を「軽微な修正」として出す
 * —— 何も出さないと、更新したのに変更内容が空の窓になる（2026-10-26 ユーザー承認「変更内容なしは混乱の元」）。
 */
export function notesForUpdate(
  entries: readonly ReleaseNoteEntry[],
  fromExclusive: string | null,
  toInclusive: string,
  variant: 'standard' | 'dmdss',
): ReleaseNoteView[] {
  const views = notesBetween(entries, fromExclusive, toInclusive, variant)
  if (views.some((v) => v.version === toInclusive)) return views
  return [{ version: toInclusive, date: '', added: [], fixed: [], minorOnly: true }, ...views]
}

/** 全部の版を新しい順に（設定の窓の「変更履歴」）。 */
export function allNotes(entries: readonly ReleaseNoteEntry[], variant: 'standard' | 'dmdss'): ReleaseNoteView[] {
  return sortNewestFirst(entries).map((e) => toView(e, variant))
}

function sortNewestFirst(entries: readonly ReleaseNoteEntry[]): ReleaseNoteEntry[] {
  return entries
    .filter((e) => parseVersion(e.version) !== null)
    .slice()
    .sort((a, b) => compareVersions(b.version, a.version) ?? 0)
}

/**
 * 取ってきた中身を読む。形が違う行は捨て、捨てた数を返す（記録に残すため。黙って欠けさせない）。
 */
export function parseReleaseNotes(body: unknown): { entries: ReleaseNoteEntry[]; dropped: number } {
  const list = typeof body === 'object' && body !== null ? (body as { versions?: unknown }).versions : undefined
  if (!Array.isArray(list)) return { entries: [], dropped: 0 }
  const entries: ReleaseNoteEntry[] = []
  let dropped = 0
  for (const raw of list) {
    const entry = readEntry(raw)
    if (entry === null) dropped++
    else entries.push(entry)
  }
  return { entries, dropped }
}

function readEntry(raw: unknown): ReleaseNoteEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.version !== 'string' || parseVersion(r.version) === null) return null
  if (typeof r.date !== 'string') return null
  const added = readItems(r.added)
  const fixed = readItems(r.fixed)
  if (added === null || fixed === null) return null
  return { version: r.version, date: r.date, added, fixed }
}

function readItems(raw: unknown): ReleaseNoteItem[] | null {
  if (!Array.isArray(raw)) return null
  const items: ReleaseNoteItem[] = []
  for (const it of raw) {
    if (typeof it !== 'object' || it === null) return null
    const { text, variant } = it as Record<string, unknown>
    if (typeof text !== 'string' || text === '') return null
    if (variant !== 'both' && variant !== 'standard' && variant !== 'dmdss') return null
    items.push({ text, variant })
  }
  return items
}
