// 区域塗りの吹き出しに足す、市町村ごとの震度の行（regionCityRowsHtml）のテスト。
import { describe, it, expect } from 'vitest'
import { regionCityRowsHtml, POPUP_CITY_LIMIT } from './QuakeRegionFillGL'
import type { JMAQuakeCity, IntensityScale } from '../../types/earthquake'

const city = (name: string, scale: IntensityScale, extra: Partial<JMAQuakeCity> = {}): JMAQuakeCity =>
  ({ name, area: '石川県能登', pref: '石川県', scale, ...extra })

/** 行に並んだ市町村名を、出た順に取り出す。 */
const namesIn = (html: string): string[] =>
  [...html.matchAll(/<span style="color:#cbd5e1">([^<]+)<\/span>/g)].map((m) => m[1])

describe('regionCityRowsHtml（区域の吹き出しの市町村の行）', () => {
  // 正: 震度の高い順に並べ、同じ震度は電文の順（気象庁の標準順）を保つ。
  it('震度の高い順に並べ、同じ震度は電文の順を保つ', () => {
    const html = regionCityRowsHtml([
      city('穴水町', 55), city('輪島市', 70), city('志賀町', 55), city('珠洲市', 60),
    ])
    expect(namesIn(html)).toEqual(['輪島市', '珠洲市', '穴水町', '志賀町'])
  })

  // 正: 上限を超えた分は「ほか N 市町村」にまとめる（数の前後に空白）。
  it(`${POPUP_CITY_LIMIT} を超えた分は「ほか N 市町村」にまとめる`, () => {
    const many = Array.from({ length: POPUP_CITY_LIMIT + 3 }, (_, i) => city(`町${i}`, 30))
    const html = regionCityRowsHtml(many)
    expect(namesIn(html)).toHaveLength(POPUP_CITY_LIMIT)
    expect(html).toContain('ほか 3 市町村')
  })

  // 対照: 上限ちょうどなら「ほか」の行を出さない。
  it(`ちょうど ${POPUP_CITY_LIMIT} なら「ほか」の行を出さない`, () => {
    const html = regionCityRowsHtml(Array.from({ length: POPUP_CITY_LIMIT }, (_, i) => city(`町${i}`, 30)))
    expect(namesIn(html)).toHaveLength(POPUP_CITY_LIMIT)
    expect(html).not.toContain('ほか')
  })

  // 対照: 市町村の震度を載せない報（震度速報・標準版）は何も足さない。
  it('市町村が無ければ空文字を返す', () => {
    expect(regionCityRowsHtml([])).toBe('')
  })

  // 安全弁: 値が入っていない市町村は断定せず「5弱以上」、観測できたうえで未入電がある市町村は「未入電あり」を添える。
  // 同じ震度なら観測できた市町村を先に置く。
  it('値の無い市町村は「5弱以上」、未入電のある市町村は「未入電あり」を添え、観測できた方を先に置く', () => {
    const html = regionCityRowsHtml([
      city('能登町', 45, { unreceived: true }),
      city('七尾市', 45, { hasUnreceived: true }),
    ])
    expect(namesIn(html)).toEqual(['七尾市', '能登町'])
    expect(html).toContain('5弱以上')
    expect(html.match(/未入電あり/g)).toHaveLength(1)
  })

  // 安全弁: 名前は HTML として解釈させない。
  it('市町村名をエスケープする', () => {
    expect(regionCityRowsHtml([city('<b>x</b>', 30)])).toContain('&lt;b&gt;x&lt;/b&gt;')
  })
})
