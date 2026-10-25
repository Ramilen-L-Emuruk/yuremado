// ヒートマップへ点を流し込み直すかの判定（`isSameHeatData`）を固定する。
// `setData` は中身が同じでも地図全体を描き直させるので、ここを外すと、ヒートマップを
// 出していなくても親が描き直されるたびにフル再描画が走る（理由は関数の説明）。
import { describe, it, expect } from 'vitest'
import type { MapGeoJSONFeature } from 'maplibre-gl'
import { clickHtml, hoverHtml, isSameHeatData } from './QuakeHeatmapGL'
import type { HeatPoint } from '../../utils/quakeHeatmap'

const point = (name: string): HeatPoint =>
  ({ lat: 35, lng: 139, weight: 0.5, name, time: '2026-10-10T00:00:00+09:00', depth: 10, magnitude: 3 }) as HeatPoint

describe('isSameHeatData', () => {
  // 正: 出す点が無いまま親が描き直されても、流し込み直さない。直す前は `heatPoints ?? []` が
  // 描き直しのたびに新しい空配列を作り、毎回ここを素通りしていた。
  it('どちらも空なら、別の配列でも null でも同じとみなす', () => {
    expect(isSameHeatData([], [])).toBe(true)
    expect(isSameHeatData(null, [])).toBe(true)
    expect(isSameHeatData([], null)).toBe(true)
    expect(isSameHeatData(null, null)).toBe(true)
  })

  it('同じ配列なら同じとみなす', () => {
    const pts = [point('a')]
    expect(isSameHeatData(pts, pts)).toBe(true)
  })

  // 対照: 点が新しく届いたら流し込む。
  it('空から点がある配列へ変わったら違うとみなす', () => {
    expect(isSameHeatData(null, [point('a')])).toBe(false)
    expect(isSameHeatData([], [point('a')])).toBe(false)
  })

  it('点がある別の配列なら、中身が同じでも違うとみなす（中身は比べない）', () => {
    expect(isSameHeatData([point('a')], [point('a')])).toBe(false)
  })

  // 安全弁: 表示を切った・点が無くなったときは、残っている点を消すために流し込む。
  it('点がある配列から空へ変わったら違うとみなす', () => {
    expect(isSameHeatData([point('a')], [])).toBe(false)
    expect(isSameHeatData([point('a')], null)).toBe(false)
  })

  // 安全弁: ソースを作り直した直後（まだ何も流し込んでいない）は、空でも必ず流し込む。
  it('まだ何も流し込んでいない（undefined）なら、空でも違うとみなす', () => {
    expect(isSameHeatData(undefined, [])).toBe(false)
    expect(isSameHeatData(undefined, null)).toBe(false)
  })
})

// 吹き出しの規模の札。巨大地震は気象庁の説明を出し、M 不明は「不明」のまま
// （2026-10-19 ユーザー承認「巨大地震を言い分ける (推奨)」）。
describe('吹き出しの規模の札', () => {
  const feature = (properties: Record<string, unknown>) => ({ properties }) as unknown as MapGeoJSONFeature

  it('巨大地震は「M8を超える巨大地震 震源名」と出す（ホバー・クリックとも）', () => {
    const f = feature({ name: '石川県能登地方', magnitude: -1, magnitudeCondition: 'Ｍ８を超える巨大地震', depth: 10, time: '' })
    const hover = hoverHtml(f).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    expect(hover).toBe('M8を超える巨大地震 石川県能登地方')
    expect(clickHtml(f)).toContain('M8を超える巨大地震')
  })

  // 対照: M 不明・説明の欄が落ちた地物は「不明」。
  it('M 不明は「不明」のまま', () => {
    expect(hoverHtml(feature({ name: 'A', magnitude: -1, magnitudeCondition: 'Ｍ不明' }))).toContain('>不明<')
    expect(hoverHtml(feature({ name: 'A', magnitude: -1 }))).toContain('>不明<')
  })

  it('数値の規模は従来どおり', () => {
    expect(hoverHtml(feature({ name: 'A', magnitude: 3.2, magnitudeCondition: null }))).toContain('>M3.2<')
  })

  // 深さが「700km以上」という下限だけの値なら、クリックの吹き出しでもそう出す（印は点が運ぶ）。
  it('深さの下限の印があれば「700km以上」、無ければ従来どおり', () => {
    expect(clickHtml(feature({ name: 'A', magnitude: 6, depth: 700, depthAtLeast: true }))).toContain('深さ 700km以上')
    expect(clickHtml(feature({ name: 'A', magnitude: 6, depth: 700, depthAtLeast: false }))).toContain('深さ 700km<')
  })
})

// 長い期間で格子にまとめた点の吹き出し（2026-10-25 ユーザー選択「A 件数・最大・最新 (Recommended)」）。
describe('格子にまとめた点の吹き出し', () => {
  const feature = (properties: Record<string, unknown>) => ({ properties }) as unknown as MapGeoJSONFeature
  const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

  it('[正] 2 件以上なら「この付近 N 件」と最大の規模・最新の時刻を出す', () => {
    const f = feature({ name: '', magnitude: 6.1, count: 1234, depth: -1, time: '2026-10-17T03:34:00.000Z' })
    expect(text(hoverHtml(f))).toBe('M6.1 この付近 1,234 件')
    const click = text(clickHtml(f))
    expect(click).toContain('この付近の地震 1,234 件')
    expect(click).toContain('最大 M6.1')
    expect(click).toMatch(/最新 \S+/)
    expect(click).not.toContain('深さ')
  })

  it('[対照] 1 件の点（count 1・欄なし）は従来の 1 つの地震の吹き出し', () => {
    expect(text(hoverHtml(feature({ name: 'A', magnitude: 3.2, count: 1 })))).toBe('M3.2 A')
    expect(text(hoverHtml(feature({ name: 'A', magnitude: 3.2 })))).toBe('M3.2 A')
  })
})
