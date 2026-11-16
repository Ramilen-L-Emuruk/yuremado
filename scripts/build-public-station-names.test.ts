import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildPublicStationNames } from './build-public-station-names'
import { NAMES_JA } from './build-public-stations'
import { PUBLIC_STATION_READINGS } from './lib/publicStationReadings'

const ROOT = resolve(__dirname, '..')
const readJson = (p: string) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'))
const tables = { 'zh-Hans': readJson('public/data/place-names/zh-Hans.json'), 'zh-Hant': readJson('public/data/place-names/zh-Hant.json') }

describe('公開観測点の名前の訳', () => {
  it('画面に出る観測点（表に残る点）の日本語名すべてに読み仮名がある（観測点が増えたら読みを足す）', () => {
    // NAMES_JA には波形の成分を持たず表から外した点（`excluded`）の名前もあるが、画面には出ないので見ない
    const shown = new Set((readJson('public/data/public-stations.json').stations as { nameJa: string }[]).map((s) => s.nameJa))
    expect([...shown].every((n) => Object.values(NAMES_JA).includes(n))).toBe(true)
    expect([...shown].filter((n) => PUBLIC_STATION_READINGS[n] === undefined)).toEqual([])
  })

  it('生成した表が、いまの読みと地名の表から作り直したものと同じ（作り直し忘れを止める）', () => {
    const names = (readJson('public/data/public-stations.json').stations as { nameJa: string }[]).map((s) => s.nameJa)
    const { rows, problems } = buildPublicStationNames(names, tables)
    expect(problems).toEqual([])
    expect(readJson('src/data/publicStationNames.json')).toEqual(rows)
  })

  it('英字の言語は語の切れ目に空白を入れたローマ字、韓国語は切れ目で空けたハングル', () => {
    const { rows } = buildPublicStationNames(['佐渡島銀山', '与那国島'], tables)
    expect(rows['佐渡島銀山']).toMatchObject({ en: 'Sadogashima Ginzan', 'pt-BR': 'Sadogashima Ginzan', es: 'Sadogashima Ginzan', ko: '사도가시마 긴잔' })
    expect(rows['与那国島']).toMatchObject({ en: 'Yonagunijima', 'zh-Hans': '与那国岛', 'zh-Hant': '與那國島' })
  })

  it('仮名の名前の中国語は、地名の表の市町村の訳から市町村の語を落とす（えりも → 襟裳）', () => {
    const { rows, problems } = buildPublicStationNames(['えりも'], tables)
    expect(problems).toEqual([])
    expect(rows['えりも']).toMatchObject({ 'zh-Hans': '襟裳', 'zh-Hant': '襟裳', en: 'Erimo', ko: '에리모' })
  })

  it('読みの無い名前は作らずに問題として返す（黙って日本語のまま書かない）', () => {
    const { rows, problems } = buildPublicStationNames(['架空観測点'], tables)
    expect(rows).toEqual({})
    expect(problems).toEqual([expect.stringContaining('架空観測点')])
  })
})
