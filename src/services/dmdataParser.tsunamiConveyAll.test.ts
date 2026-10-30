// @vitest-environment jsdom
//
// 津波の電文から、画面へそのまま出すために読む値（等級の名前・前回の等級の名前・発表官署・見出し文）。
// 素材は気象庁のサンプル電文（2011 東北・14:53 の津波警報の続報）。テストボタンの大津波警報テストが流すものと同じ。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTsunamiFromXml } from './dmdataParser'

const SAMPLE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../public/data/test-telegrams/jma-sample')
const read = (name: string) => readFileSync(join(SAMPLE_DIR, `${name}.xml`), 'utf8')

describe('津波の電文から等級の名前・発表官署・見出し文を読む', () => {
  const upgrade = parseTsunamiFromXml('VTSE41', read('32-39_11_06_250206_VTSE41'))!

  it('区域の等級の名前（Kind/Name）を丸めずに持つ —— 「大津波警報：発表」（コード 53）', () => {
    // この報で津波警報から大津波警報へ引き上げられた区域
    const aomori = upgrade.areas.find(a => a.name === '青森県太平洋沿岸')!
    expect(aomori.grade).toBe('MajorWarning')
    expect(aomori.kindName).toBe('大津波警報：発表')
    expect(aomori.lastKindName).toBe('津波警報')
  })

  it('前回の等級の名前（LastKind/Name）も持つ', () => {
    // 14:49 に大津波警報となった区域。前回の名前が 53 を指す
    const iwate = upgrade.areas.find(a => a.name === '岩手県')!
    expect(iwate.kindName).toBe('大津波警報')
    expect(iwate.lastKindName).toBe('大津波警報：発表')
  })

  it('発表官署（Control/PublishingOffice）を編集官署と別に持つ', () => {
    expect(upgrade.issue.publishingOffice).toBe('気象庁')
    expect(upgrade.issue.editorialOffice).toBeTruthy()
  })

  it('見出し文（Head/Headline/Text）を持つ', () => {
    expect(upgrade.headline).toBeTruthy()
  })

  it('15:00 の続報は等級の名前が 52 へ戻り、前回の名前が 53 を指す', () => {
    const update = parseTsunamiFromXml('VTSE41', read('32-39_11_09_250206_VTSE41'))!
    const aomori = update.areas.find(a => a.name === '青森県太平洋沿岸')!
    expect(aomori.kindName).toBe('大津波警報')
    expect(aomori.lastKindName).toBe('大津波警報：発表')
    expect(aomori.lastGrade).toBe('MajorWarning')
    expect(aomori.maxHeight?.revise).toBe('更新')
  })
})
