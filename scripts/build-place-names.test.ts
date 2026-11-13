import { describe, expect, it } from 'vitest'
import { buildPlaceNameTable, checkUntranslated, KNOWN_UNTRANSLATED, latinSeparators, PLACE_NAME_LOCALES, tidy, type BuildReport, type PlaceNameSources } from './build-place-names'

const en = PLACE_NAME_LOCALES.find((l) => l.id === 'en')!
const ko = PLACE_NAME_LOCALES.find((l) => l.id === 'ko')!
const entry = (japanese: string, english: string, korean: string) => ({ japanese, english, korean })

function sources(over: Partial<PlaceNameSources> = {}): PlaceNameSources {
  return {
    epi: {
      '220': entry('宮城県中部', 'Central Miyagi Prefecture ', '미야기 현 중부'),
      '240': entry('山形県庄内地方', 'Shonai Region,  Yamagata Prefecture', '야마가타 현 쇼나이 지방'),
    },
    pref: { '04': entry('宮城県', 'Miyagi Prefecture', '미야기 현') },
    city: { '0420200': entry('石巻市', 'Ishinomaki City', '이시노마키 시') },
    tsunamiArea: { '220': entry('宮城県', 'Miyagi Prefecture', '미야기 현') },
    eqStations: [
      { region: { code: '220', name: '宮城県中部', kana: 'ミヤギケンチュウブ' }, city: { code: '0420200', name: '石巻市', kana: 'イシノマキシ' }, code: '0420230', name: '石巻市泉町', kana: 'イシノマキシイズミマチ' },
      { region: { code: '240', name: '山形県庄内', kana: 'ヤマガタケンショウナイ' }, city: { code: '0420200', name: '石巻市', kana: 'イシノマキシ' }, code: '0420231', name: '石巻市旧', kana: 'イシノマキシキュウ' },
      { region: { code: '355', name: '伊豆大島', kana: 'イズオオシマ' }, city: { code: '0420200', name: '石巻市', kana: 'イシノマキシ' }, code: '0420232', name: '石巻市旧', kana: 'イシノマキシキュウ' },
    ],
    tsunamiStations: [{ code: '22001', name: '石巻市鮎川', kana: 'イシノマキシアユカワ' }, { code: '22900', name: '宮城沖１５０ｋｍＡ', kana: 'ミヤギオキ１５０ｋｍＡ' }],
    enPairs: { area: [], city: [{ code: '0420200', name: '石巻市', kana: 'イシノマキシ', en: 'Ishinomaki-shi' }], station: [{ code: '0420231', name: '石巻市旧＊', kana: 'イシノマキシキュウ', en: 'Ishinomaki-shi Kyu*' }] },
    ...over,
  }
}

describe('buildPlaceNameTable', () => {
  it('辞書の種類は辞書の訳を空白を整えて入れる', () => {
    const { table } = buildPlaceNameTable(sources(), en)
    expect(table.epi['宮城県中部']).toBe('Central Miyagi Prefecture')
    expect(table.pref['宮城県']).toBe('Miyagi Prefecture')
    expect(table.city['石巻市']).toBe('Ishinomaki City')
  })
  it('区域は同じ名前か、同じコードの「名前＋地方」の辞書の訳を使う', () => {
    const { table } = buildPlaceNameTable(sources(), ko)
    expect(table.area['宮城県中部']).toBe('미야기 현 중부')
    expect(table.area['山形県庄内']).toBe('야마가타 현 쇼나이 지방')
  })
  it('辞書の無い区域・観測点は、英字の言語だけ作り、中韓は持たない（対照）', () => {
    expect(buildPlaceNameTable(sources(), en).table.area['伊豆大島']).toBe('Izuoshima')
    const k = buildPlaceNameTable(sources(), ko).table
    expect(k.area['伊豆大島']).toBeUndefined()
    expect(Object.keys(k.station)).toHaveLength(0)
    expect(Object.keys(k.tsunamiStation)).toHaveLength(0)
  })
  it('観測点は集めた英語名を * を外して先に使い、同じ名前の別のコードもそれにそろえる', () => {
    const { table, report } = buildPlaceNameTable(sources(), en)
    expect(table.station['石巻市旧']).toBe('Ishinomaki-shi Kyu')
    expect(table.station['石巻市泉町']).toBe('Ishinomaki-shi Izumimachi')
    expect(report.romaji.station).toBe(1)
  })
  it('津波観測点は市町村名で区切り、沖合は距離と記号を付ける', () => {
    const { table } = buildPlaceNameTable(sources(), en)
    expect(table.tsunamiStation['石巻市鮎川']).toBe('Ishinomaki-shi Ayukawa')
    expect(table.tsunamiStation['宮城沖１５０ｋｍＡ']).toBe('Miyagi-oki 150km A')
  })
  it('同じ名前に違う訳が来たら止まる（安全弁）', () => {
    const src = sources({ city: { a: entry('石巻市', 'Ishinomaki City', ''), b: entry('石巻市', 'Other City', '') } })
    expect(() => buildPlaceNameTable(src, en)).toThrow('1 つに決まらない')
  })
})

describe('tidy', () => {
  it('正: ゼロ幅の空白を外し、隣の空白とまとめる', () => {
    // 見えない文字は文字コードから組む（直に書くと読めない）
    const zwsp = String.fromCharCode(0x200b)
    const bom = String.fromCharCode(0xfeff)
    expect(tidy(`Adjacent Sea of${zwsp} Sakhalin`)).toBe('Adjacent Sea of Sakhalin')
    expect(tidy(`Adjacent Sea of ${zwsp}${zwsp}Izu-Oshima Island`)).toBe('Adjacent Sea of Izu-Oshima Island')
    // 語の途中に挟む（端だと後段の空白の整理と trim でも消えるので、ゼロ幅の除去を確かめられない）
    expect(tidy(`Ishi${bom}kari`)).toBe('Ishikari')
  })
  it('対照: ふつうの空白だけの訳は 2 つ続く空白と端の空白を整えるだけ', () => {
    expect(tidy(' Ishikari  Region ')).toBe('Ishikari Region')
  })
})

describe('latinSeparators', () => {
  it('正: 英字の訳の中黒を前後の空白ごと「, 」にする', () => {
    expect(latinSeparators('Baía de Ise ・Baía de Mikawa')).toBe('Baía de Ise, Baía de Mikawa')
    expect(latinSeparators('Mar perto de Iki・Tsushima')).toBe('Mar perto de Iki, Tsushima')
  })
  it('対照: 中黒の無い訳と、英語の辞書の「·」（半角の中点）は変えない', () => {
    expect(latinSeparators('Eastern Region · Fuji Five Lakes')).toBe('Eastern Region · Fuji Five Lakes')
  })
  it('安全弁: 中国語・韓国語の表には当てない（区切りの決まりが別。i18n-spec §5）', () => {
    const src = sources({ epi: { a: entry('壱岐・対馬近海', 'Adjacent Sea of Iki・Tsushima', '이키・쓰시마 근해') } })
    expect(buildPlaceNameTable(src, en).table.epi['壱岐・対馬近海']).toBe('Adjacent Sea of Iki, Tsushima')
    expect(buildPlaceNameTable(src, ko).table.epi['壱岐・対馬近海']).toBe('이키・쓰시마 근해')
  })
})

describe('checkUntranslated', () => {
  const report = (area: string[]): BuildReport => ({
    locale: 'en',
    counts: { epi: 0, pref: 0, city: 0, tsunamiArea: 0, area: 0, station: 0, tsunamiStation: 0 },
    romaji: { area: 0, station: 0, tsunamiStation: 0 },
    untranslated: { area, station: [], tsunamiStation: [] },
  })
  it('対照: 日本語のまま出すと決めた名前だけなら通す', () => {
    expect(() => checkUntranslated(report([...KNOWN_UNTRANSLATED.area]))).not.toThrow()
  })
  it('正: それ以外に訳を作れない名前が出たら止める', () => {
    expect(() => checkUntranslated(report(['石狩地方北部']))).toThrow('訳を作れない名前が増えた')
  })
})
