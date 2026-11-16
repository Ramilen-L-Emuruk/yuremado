import { LOCALES, type Locale } from '../i18n/messages'

/**
 * 版ごとの変更内容（`public/release-notes.json`）を、画面に出す形へ選ぶ。
 *
 * 変更内容はリリースのときに利用者向けに書く（2026-10-26 ユーザー承認「リリース時に利用者向けに書く」。
 * 書き方の決まりは `.claude/skills/release/SKILL.md`）。**アプリへは同梱しない** —— 待っている新しい版の
 * 内容を、古い版のページから読む必要があるので、配信されているファイルを取りに行く。
 *
 * 各行は日本語の `text` と、日本語以外の 6 言語の訳 `translations` を持つ（2026-11-15 ユーザー選択
 * 「各行に訳の欄を足す (Recommended)」）。古い版のアプリは `text` と `variant` だけを読み、訳の欄は見ない。
 */

/** 訳を持つ言語（日本語以外）。 */
export type ReleaseNoteLocale = Exclude<Locale, 'ja'>

const TRANSLATED_LOCALES: readonly ReleaseNoteLocale[] = LOCALES.map((l) => l.id).filter((id): id is ReleaseNoteLocale => id !== 'ja')

export type ReleaseNoteTranslations = Readonly<Partial<Record<ReleaseNoteLocale, string>>>

/**
 * 変更内容を書き始めた版。これより前の版は書かない（2026-10-26 ユーザー承認「この仕組みを出す版から」）。
 * この版から先は、`package.json` の版に必ず対応する行がある（`releaseNotes.test.ts` が落とす）。
 */
export const FIRST_NOTED_VERSION = '5.70.0'

/**
 * どちらの版に関係する行か。**版を 1 つにまとめた後は画面の絞り込みに使わない**（docs/isdmdss-allocation.md の
 * 「変更履歴を版で絞る」の行）。資料には残す —— まとめる前の版のアプリも同じ `release-notes.json` を読み、
 * この欄が無い行を捨てるので、待っている新しい版の内容が出なくなる。新しく書く行は `both` にする。
 */
export type ReleaseNoteVariant = 'both' | 'standard' | 'dmdss'

export interface ReleaseNoteItem {
  /** 日本語の文。 */
  text: string
  variant: ReleaseNoteVariant
  /** 日本語以外の言語の訳。欠けた言語と、読めない訳の言語（`readTranslations` が捨てる）は日本語の文で出す（`releaseNoteText`）。 */
  translations: ReleaseNoteTranslations
}

/** 画面に出す 1 行。言語は描くときに選ぶ（`releaseNoteText`）。 */
export type ReleaseNoteLine = Pick<ReleaseNoteItem, 'text' | 'translations'>

/** 1 行を画面の言語で出す。訳が無い言語は日本語の文のまま。 */
export function releaseNoteText(line: ReleaseNoteLine, locale: Locale): string {
  if (locale === 'ja') return line.text
  return line.translations[locale] ?? line.text
}

/** 訳が欠けている言語。`releaseNotes.test.ts` が、リリースで訳を書き忘れた行を CI で止めるために使う。 */
export function missingTranslations(line: ReleaseNoteLine): ReleaseNoteLocale[] {
  return TRANSLATED_LOCALES.filter((l) => line.translations[l] === undefined)
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
  added: ReleaseNoteLine[]
  fixed: ReleaseNoteLine[]
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

function toView(entry: ReleaseNoteEntry): ReleaseNoteView {
  const added = entry.added.map(({ text, translations }) => ({ text, translations }))
  const fixed = entry.fixed.map(({ text, translations }) => ({ text, translations }))
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
): ReleaseNoteView[] {
  return sortNewestFirst(entries)
    .filter((e) => {
      const upper = compareVersions(e.version, toInclusive)
      if (upper === null || upper > 0) return false
      if (fromExclusive === null) return upper === 0
      const lower = compareVersions(e.version, fromExclusive)
      return lower !== null && lower > 0
    })
    .map(toView)
}

/**
 * 更新した後に出す版（`notesBetween`）。資料に更新先の版が載っていなければ、更新先を「軽微な修正」として出す
 * —— 何も出さないと、更新したのに変更内容が空の窓になる（2026-10-26 ユーザー承認「変更内容なしは混乱の元」）。
 */
export function notesForUpdate(
  entries: readonly ReleaseNoteEntry[],
  fromExclusive: string | null,
  toInclusive: string,
): ReleaseNoteView[] {
  const views = notesBetween(entries, fromExclusive, toInclusive)
  if (views.some((v) => v.version === toInclusive)) return views
  return [{ version: toInclusive, date: '', added: [], fixed: [], minorOnly: true }, ...views]
}

/** 全部の版を新しい順に（設定の窓の「変更履歴」）。 */
export function allNotes(entries: readonly ReleaseNoteEntry[]): ReleaseNoteView[] {
  return sortNewestFirst(entries).map(toView)
}

function sortNewestFirst(entries: readonly ReleaseNoteEntry[]): ReleaseNoteEntry[] {
  return entries
    .filter((e) => parseVersion(e.version) !== null)
    .slice()
    .sort((a, b) => compareVersions(b.version, a.version) ?? 0)
}

/**
 * 取ってきた中身を読む。形が違う版は捨て、捨てた数を返す（記録に残すため。黙って欠けさせない）。
 *
 * `ignoredTranslations` は、読まずに捨てた訳の数（知らない言語・空白だけの文・文字列でない値、欄そのものの形の誤り）。
 * 訳の誤りでは版を捨てない —— その言語だけ日本語で出す。この版のアプリが知らない言語の訳を、後の版が足しても
 * 窓が欠けないようにするため。書き忘れ・書き誤りは `releaseNotes.test.ts` が実ファイルで止める。
 */
export function parseReleaseNotes(body: unknown): { entries: ReleaseNoteEntry[]; dropped: number; ignoredTranslations: number } {
  const list = typeof body === 'object' && body !== null ? (body as { versions?: unknown }).versions : undefined
  if (!Array.isArray(list)) return { entries: [], dropped: 0, ignoredTranslations: 0 }
  const entries: ReleaseNoteEntry[] = []
  const ignored = { count: 0 }
  let dropped = 0
  for (const raw of list) {
    const entry = readEntry(raw, ignored)
    if (entry === null) dropped++
    else entries.push(entry)
  }
  return { entries, dropped, ignoredTranslations: ignored.count }
}

function readEntry(raw: unknown, ignored: { count: number }): ReleaseNoteEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.version !== 'string' || parseVersion(r.version) === null) return null
  if (typeof r.date !== 'string') return null
  const added = readItems(r.added, ignored)
  const fixed = readItems(r.fixed, ignored)
  if (added === null || fixed === null) return null
  return { version: r.version, date: r.date, added, fixed }
}

function readItems(raw: unknown, ignored: { count: number }): ReleaseNoteItem[] | null {
  if (!Array.isArray(raw)) return null
  const items: ReleaseNoteItem[] = []
  for (const it of raw) {
    if (typeof it !== 'object' || it === null) return null
    const { text, variant, translations } = it as Record<string, unknown>
    if (typeof text !== 'string' || text === '') return null
    if (variant !== 'both' && variant !== 'standard' && variant !== 'dmdss') return null
    items.push({ text, variant, translations: readTranslations(translations, ignored) })
  }
  return items
}

/** 訳の欄。無ければ訳なし。読めない訳はその言語だけ捨てて数える（その言語の画面は日本語の文で出る）。 */
function readTranslations(raw: unknown, ignored: { count: number }): ReleaseNoteTranslations {
  if (raw === undefined) return {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    ignored.count++
    return {}
  }
  const out: Partial<Record<ReleaseNoteLocale, string>> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(TRANSLATED_LOCALES as readonly string[]).includes(key) || typeof value !== 'string' || value.trim() === '') {
      ignored.count++
      continue
    }
    out[key as ReleaseNoteLocale] = value
  }
  return out
}
