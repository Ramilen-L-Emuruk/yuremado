import { describe, expect, it } from 'vitest'
import { areaEnFromKana, cityEnFromKana, romanizeKana, stationEnFromKana, tsunamiStationEnFromKana } from './placeNameRomaji'

describe('romanizeKana', () => {
  it('長音を落とし、ン の後が b・m・p なら m にする', () => {
    expect(romanizeKana('トウキョウ')).toBe('tokyo')
    expect(romanizeKana('ナンブ')).toBe('nambu')
    expect(romanizeKana('オオサカ')).toBe('osaka')
  })
  it('促音は次の子音を重ね、チ の前は t にする', () => {
    expect(romanizeKana('ハットリ')).toBe('hattori')
    expect(romanizeKana('ハッチョウ')).toBe('hatcho')
  })
  it('ン の後が b・m・p でなければ n のまま（対照）', () => {
    expect(romanizeKana('ナンセイ')).toBe('nansei')
  })
  it('知らない文字が混じれば null（安全弁）', () => {
    expect(romanizeKana('ABC')).toBeNull()
    expect(romanizeKana('ティ')).toBeNull()
    expect(romanizeKana('アッ')).toBeNull()
  })
})

describe('cityEnFromKana', () => {
  it('接尾を読み仮名どおりに付ける', () => {
    expect(cityEnFromKana('阿久根市', 'アクネシ')).toBe('Akune-shi')
    expect(cityEnFromKana('住田町', 'スミタチョウ')).toBe('Sumita-cho')
    expect(cityEnFromKana('球磨村', 'クマムラ')).toBe('Kuma-mura')
    expect(cityEnFromKana('大滝村', 'オオタキムラ')).toBe('Otaki-mura')
  })
  it('接尾に当たらなければ 1 語にする（対照）', () => {
    expect(cityEnFromKana('三宅島', 'ミヤケジマ')).toBe('Miyakejima')
  })
  it('読み仮名を作れなければ null（安全弁）', () => {
    expect(cityEnFromKana('某市', 'ティシ')).toBeNull()
  })
})

describe('areaEnFromKana', () => {
  it('県・都・府・地方の頭で 3 語に分ける', () => {
    expect(areaEnFromKana('宮城県中部', 'ミヤギケンチュウブ')).toBe('Miyagi Ken Chubu')
    expect(areaEnFromKana('石狩地方南部', 'イシカリチホウナンブ')).toBe('Ishikari Chiho Nambu')
    expect(areaEnFromKana('東京都多摩東部', 'トウキョウトタマトウブ')).toBe('Tokyo To Tamatobu')
  })
  it('京都府は「都」ではなく「府」で切る', () => {
    expect(areaEnFromKana('京都府南部', 'キョウトフナンブ')).toBe('Kyoto Fu Nambu')
    expect(areaEnFromKana('大阪府北部', 'オオサカフホクブ')).toBe('Osaka Fu Hokubu')
  })
  it('頭の語が無い名前は 1 語にする（対照）', () => {
    expect(areaEnFromKana('伊豆大島', 'イズオオシマ')).toBe('Izuoshima')
  })
  it('読み仮名を作れなければ null（安全弁）', () => {
    expect(areaEnFromKana('某県中部', 'ティケンチュウブ')).toBeNull()
  })
})

describe('stationEnFromKana', () => {
  it('市町村の英語名に残りを付け、末尾の ＊ を写す', () => {
    expect(stationEnFromKana('大滝村鈴ヶ沢＊', 'オオタキムラスズガサワ', 'Otaki-mura', 'オオタキムラ')).toBe('Otaki-mura Suzugasawa*')
  })
  it('観測点の読み仮名が市町村と同じなら市町村の英語名だけ', () => {
    expect(stationEnFromKana('球磨村＊', 'クマムラ', 'Kuma-mura', 'クマムラ')).toBe('Kuma-mura*')
  })
  it('市町村の読み仮名で始まらなければ全体を 1 語にする（対照）', () => {
    expect(stationEnFromKana('鈴ヶ沢', 'スズガサワ', 'Otaki-mura', 'オオタキムラ')).toBe('Suzugasawa')
  })
  it('残りを作れなければ null（安全弁）', () => {
    expect(stationEnFromKana('大滝村某', 'オオタキムラティ', 'Otaki-mura', 'オオタキムラ')).toBeNull()
  })
})

describe('tsunamiStationEnFromKana', () => {
  it('1 語にする', () => {
    expect(tsunamiStationEnFromKana('オオフナト')).toBe('Ofunato')
  })
  it('沖合の観測点は「場所-oki 距離 記号」にする', () => {
    expect(tsunamiStationEnFromKana('クシロオキ１００ｋｍＡ')).toBe('Kushiro-oki 100km A')
    expect(tsunamiStationEnFromKana('ネムロナントウオキ４０ｋｍ')).toBe('Nemuronanto-oki 40km')
  })
  it('沖合の形でない全角の英数字は作らない（安全弁）', () => {
    expect(tsunamiStationEnFromKana('クシロ１００')).toBeNull()
  })
})
