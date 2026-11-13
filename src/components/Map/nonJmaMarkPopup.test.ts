// 地図の吹き出しに出る観測点名へ、気象庁以外が運用する観測点の印（`＊`）を戻すこと。
//
// 電文は名前の末尾にこの印を付けるが、読み取りの側では外して持っている（座標表をはじめ、
// 印の無い名前を鍵にしている先がいくつもあるため。一覧は `docs/spec/quake-spec.md` §8 の表）。
// **戻すのは表示のここだけ**なので、震度と長周期の両方で同じ扱いになっていることを固定する。
import { describe, it, expect } from 'vitest'
import type { MapGeoJSONFeature } from 'maplibre-gl'
import { quakePointPopupTitle } from './QuakeIntensityPointsGL'
import { lpgmPointPopupTitle } from './LpgmPointsGL'
import { JA_PLACE_NAMES, PLACE_NAME_KINDS, placeNameLookup, type PlaceNameTable } from '../../i18n/placeNames'

const feature = (properties: Record<string, unknown>) =>
  ({ properties } as unknown as MapGeoJSONFeature)

describe('地図の吹き出しの観測点名', () => {
  // 正: 印の付く観測点は末尾に `＊` が出る（震度・長周期とも）。
  it('気象庁以外の観測点には印が付く', () => {
    expect(quakePointPopupTitle(feature({ addr: '普代村銅屋', nonJma: true }), JA_PLACE_NAMES)).toBe('普代村銅屋＊')
    expect(lpgmPointPopupTitle(feature({ name: '東京千代田区大手町', nonJma: true }), JA_PLACE_NAMES)).toBe('東京千代田区大手町＊')
  })

  // 対照: 気象庁の観測点には付かない。
  it('気象庁の観測点には印が付かない', () => {
    expect(quakePointPopupTitle(feature({ addr: '輪島市門前町', nonJma: false }), JA_PLACE_NAMES)).toBe('輪島市門前町')
    expect(lpgmPointPopupTitle(feature({ name: '輪島市門前町', nonJma: false }), JA_PLACE_NAMES)).toBe('輪島市門前町')
  })

  // 安全弁: 印の有無を持たない点（`nonJma` が無い点）でも名前を壊さない。
  it('印の有無を持たない点は名前をそのまま出す', () => {
    expect(quakePointPopupTitle(feature({ addr: '輪島市門前町' }), JA_PLACE_NAMES)).toBe('輪島市門前町')
    expect(lpgmPointPopupTitle(feature({ name: '輪島市門前町' }), JA_PLACE_NAMES)).toBe('輪島市門前町')
  })

  // 安全弁: 区域の代表点（`isArea`）にも同じ経路を通す。区域は運用機関を持たないので
  // 印は立たないが、名前が落ちないことは確かめておく。
  it('区域の代表点でも名前が落ちない', () => {
    expect(quakePointPopupTitle(feature({ addr: '石川県能登', isArea: true }), JA_PLACE_NAMES)).toBe('石川県能登')
  })

  // 地名の訳: 観測点は観測点の表、区域の代表点は区域の表で引き、印は訳の後ろへ付ける
  it('訳した名前にも印を付け、区域と観測点で表を分けて引く', () => {
    const table = Object.fromEntries(PLACE_NAME_KINDS.map((k) => [k, {}])) as Record<string, Record<string, string>>
    table.station = { 普代村銅屋: 'Fudai-mura Doya', 石川県能登: 'wrong' }
    table.area = { 石川県能登: 'Noto, Ishikawa Prefecture' }
    const place = placeNameLookup(table as unknown as PlaceNameTable)
    expect(quakePointPopupTitle(feature({ addr: '普代村銅屋', nonJma: true }), place)).toBe('Fudai-mura Doya＊')
    expect(lpgmPointPopupTitle(feature({ name: '普代村銅屋', nonJma: true }), place)).toBe('Fudai-mura Doya＊')
    expect(quakePointPopupTitle(feature({ addr: '石川県能登', isArea: true }), place)).toBe('Noto, Ishikawa Prefecture')
  })
})
