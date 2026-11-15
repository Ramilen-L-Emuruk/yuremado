// @vitest-environment jsdom
//
// 緊急地震速報・長周期地震動・帯の電文（南海トラフ臨時情報・解説情報・後発地震・お知らせ・地震回数）から、
// 電文を編集した官署（`Control/EditorialOffice`）と発表した官署（`Control/PublishingOffice`）を読む。
// 地震情報・津波と同じく、互いに落とさない（片方が無ければ、その欄だけ無い）。
// 素材はテストボタンが流すのと同じ電文（`public/data/test-telegrams/`）。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseEEWFromXml, parseLpgmFromXml, parseNankaiFromXml, parseNankaiCommentaryFromXml, parseVyse60FromXml,
  parseQuakeNoticeFromXml, parseEarthquakeCountFromXml,
} from './dmdataParser'
import type { TelegramOffices } from '../types/earthquake'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../public/data/test-telegrams')
const read = (path: string) => readFileSync(join(DIR, path), 'utf8')

const CASES: { name: string; file: string; parse: (xml: string) => TelegramOffices | null }[] = [
  { name: '緊急地震速報（VXSE45）', file: 'jma-sample/77_01_01_240613_VXSE45.xml', parse: xml => parseEEWFromXml('VXSE45', xml) },
  { name: '長周期地震動（VXSE62）', file: 'nii/20240101072337_0_VXSE62_010000.xml', parse: parseLpgmFromXml },
  { name: '南海トラフ臨時情報（VYSE50）', file: 'jma-sample/74_01_04_200512_VYSE50.xml', parse: parseNankaiFromXml },
  { name: '南海トラフ関連解説情報（VYSE51）', file: 'nii/20240815080252_0_VYSE51_010000.xml', parse: parseNankaiCommentaryFromXml },
  { name: '後発地震注意情報（VYSE60）', file: 'jma-sample/80_01_01_260917_VYSE60.xml', parse: parseVyse60FromXml },
  { name: 'お知らせ（VZSE40）', file: 'jma-sample/42_01_01_100514_VZSE40.xml', parse: parseQuakeNoticeFromXml },
  { name: '地震回数（VXSE60）', file: 'jma-sample/32-35_03_01_100514_VXSE60.xml', parse: parseEarthquakeCountFromXml },
]

describe.each(CASES)('$name の官署', ({ file, parse }) => {
  const xml = read(file)

  // 正: 両方を電文のまま読む
  it('編集官署と発表官署を読む', () => {
    const r = parse(xml)!
    expect(r.editorialOffice).toBe('気象庁本庁')
    expect(r.publishingOffice).toBe('気象庁')
  })

  // 対照: 編集官署が無ければ、発表官署へ落とさない（「編集官署」と名乗って別の値を出さない）
  it('編集官署が無ければ編集官署の欄は無い', () => {
    const r = parse(xml.replace(/<EditorialOffice>[^<]*<\/EditorialOffice>/, ''))!
    expect(r.editorialOffice).toBeUndefined()
    expect(r.publishingOffice).toBe('気象庁')
  })

  // 安全弁: 発表官署が無くても、編集官署は残る
  it('発表官署が無くても編集官署は残る', () => {
    const r = parse(xml.replace(/<PublishingOffice>[^<]*<\/PublishingOffice>/, ''))!
    expect(r.publishingOffice).toBeUndefined()
    expect(r.editorialOffice).toBe('気象庁本庁')
  })
})
