import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  FIRST_NOTED_VERSION,
  allNotes,
  compareVersions,
  notesBetween,
  missingTranslations,
  notesForUpdate,
  parseReleaseNotes,
  releaseNoteText,
  type ReleaseNoteEntry,
} from './releaseNotes'

describe('public/release-notes.json', () => {
  const pkgVersion = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version
  const body = JSON.parse(readFileSync('public/release-notes.json', 'utf8')) as { versions: unknown[] }
  const { entries, dropped, ignoredTranslations } = parseReleaseNotes(body)

  it('読めない版が 1 つも無い', () => {
    expect(dropped).toBe(0)
    expect(entries).toHaveLength(body.versions.length)
  })

  it('読まずに捨てた訳が 1 つも無い（知らない言語・空の文・文字列でない値を書いたら CI で止める）', () => {
    expect(ignoredTranslations).toBe(0)
  })

  it('書き始めた版より後は、いまの版の変更内容が必ずある（リリースで書き忘れたら CI で止める）', () => {
    if ((compareVersions(pkgVersion, FIRST_NOTED_VERSION) ?? -1) < 0) return
    // バリアントで絞ると、片方の版にしか項目の無い版が落ちるので、資料そのものに載っているかを見る
    expect(entries.some((e) => e.version === pkgVersion)).toBe(true)
  })

  it('同じ版が 2 回載っていない', () => {
    const versions = entries.map((e) => e.version)
    expect(new Set(versions).size).toBe(versions.length)
  })

  it('どの行も日本語以外の 6 言語の訳を持つ（リリースで訳を書き忘れたら CI で止める）', () => {
    const missing = entries.flatMap((e) => [...e.added, ...e.fixed].flatMap((item) => {
      const langs = missingTranslations(item)
      return langs.length === 0 ? [] : [`${e.version}「${item.text}」: ${langs.join(', ')}`]
    }))
    expect(missing).toEqual([])
  })
})

const entries: ReleaseNoteEntry[] = [
  { version: '5.68.0', date: '2026-10-25', added: [], fixed: [{ text: 'A', variant: 'both', translations: {} }] },
  { version: '5.70.0', date: '2026-10-27', added: [{ text: 'B', variant: 'dmdss', translations: {} }], fixed: [] },
  { version: '5.69.0', date: '2026-10-26', added: [{ text: 'C', variant: 'standard', translations: {} }], fixed: [{ text: 'D', variant: 'both', translations: {} }] },
  { version: '5.10.0', date: '2026-08-01', added: [], fixed: [] },
]
const line = (text: string) => ({ text, translations: {} })

describe('compareVersions', () => {
  it('数字として比べる（文字の並びでは 5.10 が 5.9 より小さくなる）', () => {
    expect(compareVersions('5.10.0', '5.9.0')).toBeGreaterThan(0)
    expect(compareVersions('5.69.0', '5.69.0')).toBe(0)
    expect(compareVersions('5.69.0', 'x')).toBeNull()
  })
})

describe('notesBetween', () => {
  it('飛ばした版も、前に開いた版より新しいものを新しい順に全部出す', () => {
    expect(notesBetween(entries, '5.68.0', '5.70.0').map((v) => v.version)).toEqual(['5.70.0', '5.69.0'])
  })

  it('前に開いた版を覚えていなければ、更新先の 1 版だけ', () => {
    expect(notesBetween(entries, null, '5.70.0').map((v) => v.version)).toEqual(['5.70.0'])
  })

  it('更新先より新しい版は出さない（配信の途中で資料だけ先に新しくなった場合）', () => {
    expect(notesBetween(entries, '5.68.0', '5.69.0').map((v) => v.version)).toEqual(['5.69.0'])
  })

  // 版を 1 つにまとめたので、資料の `variant` では絞らない（まとめる前の版の行もすべて出す）
  it('資料の版の印によらず全部の行を出し、行の無い版は「軽微な修正」に倒す', () => {
    const [v570, v569] = notesBetween(entries, '5.68.0', '5.70.0')
    expect(v570).toMatchObject({ version: '5.70.0', added: [line('B')], fixed: [], minorOnly: false })
    expect(v569).toMatchObject({ added: [line('C')], fixed: [line('D')], minorOnly: false })
    const empty = notesBetween([{ version: '5.71.0', date: '2026-10-28', added: [], fixed: [] }], '5.70.0', '5.71.0')
    expect(empty[0]).toMatchObject({ minorOnly: true })
  })
})

describe('notesForUpdate', () => {
  it('更新先の版が資料に無ければ、更新先を「軽微な修正」として先頭に出す（空の窓にしない）', () => {
    const views = notesForUpdate(entries, '5.69.0', '5.71.0')
    expect(views.map((v) => [v.version, v.minorOnly])).toEqual([['5.71.0', true], ['5.70.0', false]])
  })

  it('載っていればそのまま（対照）', () => {
    expect(notesForUpdate(entries, '5.68.0', '5.70.0').map((v) => v.version)).toEqual(['5.70.0', '5.69.0'])
  })
})

describe('releaseNoteText', () => {
  const item = { text: '甲を追加', translations: { en: 'Added A', 'zh-Hant': '新增甲' } }
  it('正: 画面の言語の訳を出す', () => {
    expect(releaseNoteText(item, 'en')).toBe('Added A')
    expect(releaseNoteText(item, 'zh-Hant')).toBe('新增甲')
  })
  it('対照: 日本語の画面は日本語の文', () => {
    expect(releaseNoteText(item, 'ja')).toBe('甲を追加')
  })
  it('安全弁: 訳が無い言語は日本語の文のまま出す（空の行にしない）', () => {
    expect(releaseNoteText(item, 'ko')).toBe('甲を追加')
    expect(missingTranslations(item)).toEqual(['zh-Hans', 'ko', 'pt-BR', 'es'])
  })
})

describe('allNotes', () => {
  it('全部の版を新しい順に並べる', () => {
    expect(allNotes(entries).map((v) => v.version)).toEqual(['5.70.0', '5.69.0', '5.68.0', '5.10.0'])
  })
})

describe('parseReleaseNotes', () => {
  it('形の違う版は捨てて数える（黙って欠けさせない）', () => {
    const body = {
      versions: [
        { version: '5.70.0', date: '2026-10-27', added: [], fixed: [] },
        { version: 'x', date: '2026-10-27', added: [], fixed: [] },
        { version: '5.69.0', date: '2026-10-26', added: [{ text: '', variant: 'both' }], fixed: [] },
        { version: '5.68.0', date: '2026-10-25', added: [{ text: 'E', variant: 'all' }], fixed: [] },
      ],
    }
    const { entries: got, dropped } = parseReleaseNotes(body)
    expect(got.map((e) => e.version)).toEqual(['5.70.0'])
    expect(dropped).toBe(3)
  })

  it('訳の欄を読む。無い行は訳なしとして読む（訳を書く前の資料も読める）', () => {
    const body = {
      versions: [{
        version: '6.17.0', date: '2026-11-16', fixed: [],
        added: [{ text: '甲', variant: 'both', translations: { en: 'A', ko: '가' } }, { text: '乙', variant: 'both' }],
      }],
    }
    const { entries: got, dropped } = parseReleaseNotes(body)
    expect(dropped).toBe(0)
    expect(got[0].added).toEqual([
      { text: '甲', variant: 'both', translations: { en: 'A', ko: '가' } },
      { text: '乙', variant: 'both', translations: {} },
    ])
  })

  it('安全弁: 読めない訳はその言語だけ捨てて数え、版は捨てない（後の版が足した言語の訳で窓が欠けない）', () => {
    const translations = { en: 'A', fr: 'Ajouté', ko: '', es: 1 }
    const body = { versions: [
      { version: '6.17.0', date: '2026-11-16', fixed: [], added: [{ text: '甲', variant: 'both', translations }] },
      { version: '6.17.1', date: '2026-11-16', fixed: [], added: [{ text: '乙', variant: 'both', translations: ['en'] }] },
    ] }
    const { entries: got, dropped, ignoredTranslations } = parseReleaseNotes(body)
    expect(dropped).toBe(0)
    expect(got.map((e) => e.added[0].translations)).toEqual([{ en: 'A' }, {}])
    expect(ignoredTranslations).toBe(4)
    expect(releaseNoteText(got[0].added[0], 'ko')).toBe('甲')
  })

  it('入れ物の形が違えば空として読む', () => {
    expect(parseReleaseNotes(null)).toEqual({ entries: [], dropped: 0, ignoredTranslations: 0 })
    expect(parseReleaseNotes({ versions: 'x' })).toEqual({ entries: [], dropped: 0, ignoredTranslations: 0 })
  })
})
