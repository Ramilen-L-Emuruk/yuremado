import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JA_PLACE_NAMES, PLACE_NAME_KINDS, placeNameLookup, validatePlaceNameTable, type PlaceNameTable } from './placeNames'
import { LOCALES } from './messages'

const empty = Object.fromEntries(PLACE_NAME_KINDS.map((k) => [k, {}])) as Record<string, Record<string, string>>
const table = (parts: Partial<PlaceNameTable>): PlaceNameTable => ({ ...empty, ...parts }) as PlaceNameTable

describe('placeNameLookup', () => {
  it('種類ごとに訳を引く', () => {
    const lookup = placeNameLookup(table({ epi: { 石狩地方北部: 'Northern Ishikari' }, station: { 石狩市花川: 'Ishikari-shi Hanakawa' } }))
    expect(lookup('epi', '石狩地方北部')).toBe('Northern Ishikari')
    expect(lookup('station', '石狩市花川')).toBe('Ishikari-shi Hanakawa')
  })
  it('同じ名前でも別の種類の訳は使わない（対照）', () => {
    const lookup = placeNameLookup(table({ pref: { 宮城県: 'Miyagi Prefecture' } }))
    expect(lookup('tsunamiArea', '宮城県')).toBe('宮城県')
  })
  it('訳の無い名前は日本語のまま返す（安全弁）', () => {
    const lookup = placeNameLookup(table({}))
    expect(lookup('epi', '架空の沖')).toBe('架空の沖')
    expect(JA_PLACE_NAMES('city', '石狩市')).toBe('石狩市')
  })
})

describe('validatePlaceNameTable', () => {
  it('種類が欠けた表・空の表を弾く', () => {
    expect(() => validatePlaceNameTable({ epi: { a: 'b' } })).toThrow('種類')
    expect(() => validatePlaceNameTable(empty)).toThrow('空')
    expect(() => validatePlaceNameTable({ ...empty, epi: { a: 1 } })).toThrow('文字列')
  })
})

describe('public/data/place-names', () => {
  // 生成物が、日本語を除く全言語ぶんそろい、読み込みの確かめを通ることを固定する（生成し忘れ・言語の足し忘れを落とす）
  const dir = join(__dirname, '..', '..', 'public', 'data', 'place-names')
  for (const { id } of LOCALES.filter((l) => l.id !== 'ja')) {
    it(`${id} の表がある`, () => {
      const table = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as unknown
      expect(() => validatePlaceNameTable(table)).not.toThrow()
    })
  }
})
