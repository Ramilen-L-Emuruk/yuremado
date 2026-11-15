import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { buildPlateNames, matchPlateItems, MISSING, PLATE_NAME_LOCALES } from './build-plate-names.mjs'
import { PLATE_NAMES } from './lib/plateNames.mjs'

const OpenCC = createRequire(import.meta.url)('opencc-js')
const toHans: (s: string) => string = OpenCC.Converter({ from: 'tw', to: 'cn' })
const toHant: (s: string) => string = OpenCC.Converter({ from: 'cn', to: 'tw' })

const WIKI: Record<string, string> = { en: 'en', 'pt-BR': 'pt', es: 'es', 'zh-Hans': 'zh', 'zh-Hant': 'zh', ko: 'ko' }
const same = (s: string) => s
const codes = Object.keys(PLATE_NAMES)

/** 略号ごとに項目 1 つ（Q<略号>）と、MISSING の無い言語版の記事名「<略号>-<言語版>」を持つ合成の材料 */
function sources(edit: (code: string, articles: Record<string, string>) => void = () => {}) {
  const items: Record<string, string[]> = Object.fromEntries(codes.map((c) => [c, [`Q${c}`]]))
  const bindings: object[] = []
  for (const code of codes) {
    const articles: Record<string, string> = {}
    for (const locale of PLATE_NAME_LOCALES) {
      if (MISSING[code]?.[locale] === undefined) articles[WIKI[locale]] = `${code}-${WIKI[locale]}`
    }
    edit(code, articles)
    for (const [wiki, title] of Object.entries(articles)) {
      bindings.push({ item: { value: `http://www.wikidata.org/entity/Q${code}` }, site: { value: `https://${wiki}.wikipedia.org/` }, title: { value: title } })
    }
  }
  return { items, titles: { results: { bindings } } }
}

describe('buildPlateNames', () => {
  it('正: 記事のある欄は記事名、無い欄は MISSING の訳にする', () => {
    const { items, titles } = sources()
    const t = buildPlateNames(items, titles, same, same)
    expect(t['太平洋プレート']).toEqual({ en: 'PA-en', 'pt-BR': 'PA-pt', es: 'PA-es', 'zh-Hans': 'PA-zh', 'zh-Hant': 'PA-zh', ko: 'PA-ko' })
    expect(t['フツナプレート']['pt-BR']).toBe('Placa de Futuna')
    expect(t['アルティプラノプレート'].en).toBe('Altiplano plate')
  })
  it('正: 簡体の記事名は、繁体の欄だけ字形を変える', () => {
    const { items, titles } = sources((code, a) => { if (code === 'OK') a.zh = '鄂霍次克板块' })
    const t = buildPlateNames(items, titles, toHans, toHant)
    expect(t['オホーツクプレート']['zh-Hans']).toBe('鄂霍次克板块')
    expect(t['オホーツクプレート']['zh-Hant']).toBe('鄂霍次克板塊')
  })
  it('対照: 繁体の記事名は、繁体の欄でそのまま使い、簡体→繁体を掛けない（「里」が「裡」にならない）', () => {
    const { items, titles } = sources((code, a) => { if (code === 'MA') a.zh = '馬里亞納板塊' })
    const t = buildPlateNames(items, titles, toHans, toHant)
    expect(t['マリアナプレート']['zh-Hant']).toBe('馬里亞納板塊')
    expect(t['マリアナプレート']['zh-Hans']).toBe('马里亚纳板块')
  })
  it('同じプレートの 2 つの項目は、片方にだけ記事があればそれを、両方が同じ記事名ならそれを使う', () => {
    const { items, titles } = sources()
    items.TO = ['QTO', 'QTO2']
    titles.results.bindings.push({ item: { value: 'http://www.wikidata.org/entity/QTO2' }, site: { value: 'https://ko.wikipedia.org/' }, title: { value: 'TO-ko' } })
    expect(buildPlateNames(items, titles, same, same)['トンガプレート'].ko).toBe('TO-ko')
    items.CO = ['QCO-none', 'QCO']
    expect(buildPlateNames(items, titles, same, same)['ココスプレート'].en).toBe('CO-en')
  })
  it('対照: 52 プレートすべて、日本語以外の 6 言語が揃う', () => {
    const { items, titles } = sources()
    const t = buildPlateNames(items, titles, same, same)
    expect(Object.keys(t)).toHaveLength(52)
    for (const row of Object.values(t)) expect(Object.keys(row).sort()).toEqual([...PLATE_NAME_LOCALES].sort())
  })
  it('安全弁: MISSING の欄に記事ができたら止める（作った訳を見直す）', () => {
    const { items, titles } = sources((code, a) => { if (code === 'FT') a.pt = 'Placa Futuna' })
    expect(() => buildPlateNames(items, titles, same, same)).toThrow('記事「Placa Futuna」ができた')
  })
  it('安全弁: 記事が無く MISSING にも無い欄があれば止める', () => {
    const { items, titles } = sources((code, a) => { if (code === 'TO') delete a.es })
    expect(() => buildPlateNames(items, titles, same, same)).toThrow('TO es: 記事が無く')
  })
  it('安全弁: 同じプレートの 2 つの項目で記事名が食い違えば止める', () => {
    const { items, titles } = sources()
    items.TO = ['QTO', 'QTO2']
    titles.results.bindings.push({ item: { value: 'http://www.wikidata.org/entity/QTO2' }, site: { value: 'https://ko.wikipedia.org/' }, title: { value: '통가 판' } })
    expect(() => buildPlateNames(items, titles, same, same)).toThrow('記事名が 1 つに決まらない')
  })
})

describe('matchPlateItems', () => {
  const pb2002 = { features: codes.map((c) => ({ properties: { Code: c, PlateName: c === 'AF' ? 'Africa' : `${c}x` } })) }
  const wikidata = (extra: { id: string; en: string }[]) => ({
    results: {
      bindings: [
        ...codes.filter((c) => c !== 'AF').map((c) => ({ item: { value: `http://www.wikidata.org/entity/Q${c}` }, en: { value: `${c}x Plate` } })),
        ...extra.map((e) => ({ item: { value: `http://www.wikidata.org/entity/${e.id}` }, en: { value: e.en } })),
      ],
    },
  })
  it('正: PB2002 の地名を英語名で結び、形容詞形は言い換えで結ぶ', () => {
    const items = matchPlateItems(pb2002, wikidata([{ id: 'Q1', en: 'African Plate' }]))
    expect(items.AF).toEqual(['Q1'])
    expect(items.PA).toEqual(['QPA'])
  })
  it('同じ英語名の項目が 2 つあれば、両方を返す（Futuna）', () => {
    const items = matchPlateItems(pb2002, wikidata([{ id: 'Q1', en: 'African Plate' }, { id: 'Q2', en: 'African plate' }]))
    expect(items.AF).toEqual(['Q1', 'Q2'])
  })
  it('安全弁: 結べないプレートがあれば止める', () => {
    expect(() => matchPlateItems(pb2002, wikidata([]))).toThrow('AF（Africa）: Wikidata の項目に結べない')
  })
})
