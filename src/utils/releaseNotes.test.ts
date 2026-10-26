import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  FIRST_NOTED_VERSION,
  allNotes,
  compareVersions,
  notesBetween,
  notesForUpdate,
  parseReleaseNotes,
  type ReleaseNoteEntry,
} from './releaseNotes'

describe('public/release-notes.json', () => {
  const pkgVersion = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version
  const { entries, dropped } = parseReleaseNotes(JSON.parse(readFileSync('public/release-notes.json', 'utf8')))

  it('読めない版が 1 つも無い', () => {
    expect(dropped).toBe(0)
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
})

const entries: ReleaseNoteEntry[] = [
  { version: '5.68.0', date: '2026-10-25', added: [], fixed: [{ text: 'A', variant: 'both' }] },
  { version: '5.70.0', date: '2026-10-27', added: [{ text: 'B', variant: 'dmdss' }], fixed: [] },
  { version: '5.69.0', date: '2026-10-26', added: [{ text: 'C', variant: 'standard' }], fixed: [{ text: 'D', variant: 'both' }] },
  { version: '5.10.0', date: '2026-08-01', added: [], fixed: [] },
]

describe('compareVersions', () => {
  it('数字として比べる（文字の並びでは 5.10 が 5.9 より小さくなる）', () => {
    expect(compareVersions('5.10.0', '5.9.0')).toBeGreaterThan(0)
    expect(compareVersions('5.69.0', '5.69.0')).toBe(0)
    expect(compareVersions('5.69.0', 'x')).toBeNull()
  })
})

describe('notesBetween', () => {
  it('飛ばした版も、前に開いた版より新しいものを新しい順に全部出す', () => {
    expect(notesBetween(entries, '5.68.0', '5.70.0', 'dmdss').map((v) => v.version)).toEqual(['5.70.0', '5.69.0'])
  })

  it('前に開いた版を覚えていなければ、更新先の 1 版だけ', () => {
    expect(notesBetween(entries, null, '5.70.0', 'dmdss').map((v) => v.version)).toEqual(['5.70.0'])
  })

  it('更新先より新しい版は出さない（配信の途中で資料だけ先に新しくなった場合）', () => {
    expect(notesBetween(entries, '5.68.0', '5.69.0', 'dmdss').map((v) => v.version)).toEqual(['5.69.0'])
  })

  it('開いている版に関係する行だけを出し、何も残らない版は「軽微な修正」に倒す', () => {
    const [v570, v569] = notesBetween(entries, '5.68.0', '5.70.0', 'standard')
    expect(v570).toMatchObject({ version: '5.70.0', added: [], fixed: [], minorOnly: true })
    expect(v569).toMatchObject({ added: ['C'], fixed: ['D'], minorOnly: false })
  })
})

describe('notesForUpdate', () => {
  it('更新先の版が資料に無ければ、更新先を「軽微な修正」として先頭に出す（空の窓にしない）', () => {
    const views = notesForUpdate(entries, '5.69.0', '5.71.0', 'dmdss')
    expect(views.map((v) => [v.version, v.minorOnly])).toEqual([['5.71.0', true], ['5.70.0', false]])
  })

  it('載っていればそのまま（対照）', () => {
    expect(notesForUpdate(entries, '5.68.0', '5.70.0', 'dmdss').map((v) => v.version)).toEqual(['5.70.0', '5.69.0'])
  })
})

describe('allNotes', () => {
  it('全部の版を新しい順に並べる', () => {
    expect(allNotes(entries, 'dmdss').map((v) => v.version)).toEqual(['5.70.0', '5.69.0', '5.68.0', '5.10.0'])
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

  it('入れ物の形が違えば空として読む', () => {
    expect(parseReleaseNotes(null)).toEqual({ entries: [], dropped: 0 })
    expect(parseReleaseNotes({ versions: 'x' })).toEqual({ entries: [], dropped: 0 })
  })
})
