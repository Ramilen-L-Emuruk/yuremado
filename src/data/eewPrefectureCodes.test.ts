import { describe, expect, it } from 'vitest'

import { EEW_PREFECTURE_CODES, eewPrefDisplayName } from './eewPrefectureCodes'
import { JA_PLACE_NAMES, type PlaceNameLookup } from '../i18n/placeNames'

// 緊急地震速報の控えの全期間（警報 VXSE43 の 69 日分・予報 VXSE45 の 1,552 日分）にあった府県予報区の名前と符号の組（56 種）
const OBSERVED: ReadonlyArray<readonly [string, number]> = [
  ['愛知', 9230],
  ['愛媛', 9380],
  ['伊豆諸島', 9132],
  ['茨城', 9080],
  ['奄美', 9462],
  ['岡山', 9330],
  ['岩手', 9030],
  ['岐阜', 9210],
  ['宮古島', 9473],
  ['宮崎', 9450],
  ['宮城', 9040],
  ['京都', 9260],
  ['熊本', 9430],
  ['群馬', 9100],
  ['広島', 9340],
  ['香川', 9370],
  ['高知', 9390],
  ['佐賀', 9410],
  ['埼玉', 9110],
  ['三重', 9240],
  ['山形', 9060],
  ['山口', 9350],
  ['山梨', 9190],
  ['滋賀', 9250],
  ['鹿児島', 9461],
  ['秋田', 9050],
  ['新潟', 9150],
  ['神奈川', 9140],
  ['青森', 9020],
  ['静岡', 9220],
  ['石川', 9170],
  ['千葉', 9120],
  ['大阪', 9270],
  ['大分', 9440],
  ['長崎', 9420],
  ['長野', 9200],
  ['鳥取', 9310],
  ['島根', 9320],
  ['東京', 9131],
  ['徳島', 9360],
  ['栃木', 9090],
  ['奈良', 9290],
  ['八重山', 9474],
  ['富山', 9160],
  ['福井', 9180],
  ['福岡', 9400],
  ['福島', 9070],
  ['兵庫', 9280],
  ['北海道道央', 9011],
  ['北海道道東', 9014],
  ['北海道道南', 9012],
  ['北海道道北', 9013],
  ['和歌山', 9300],
  ['沖縄本島', 9471],
  ['小笠原', 9133],
  ['大東島', 9472],
]

describe('EEW_PREFECTURE_CODES', () => {
  it('実電文にあった府県予報区の名前をすべて引け、符号の「(符号 − 9000) ÷ 10」と同じ都道府県になる', () => {
    for (const [name, code] of OBSERVED) {
      expect(EEW_PREFECTURE_CODES.get(name), name).toBe(String(Math.floor((code - 9000) / 10)).padStart(2, '0'))
    }
  })

  it('表に余分な名前が無い（実電文の 56 種と同じ数）', () => {
    expect(EEW_PREFECTURE_CODES.size).toBe(OBSERVED.length)
  })

  it('対照: 「県」の付いた都道府県名や、分ける前の名前は府県予報区ではないので引かない', () => {
    expect(EEW_PREFECTURE_CODES.has('熊本県')).toBe(false)
    expect(EEW_PREFECTURE_CODES.has('北海道')).toBe(false)
    expect(EEW_PREFECTURE_CODES.has('沖縄')).toBe(false)
  })
})

describe('eewPrefDisplayName', () => {
  const en: PlaceNameLookup = (kind, name) => (kind === 'pref' ? ({ 熊本県: 'Kumamoto Prefecture', 東京都: 'Tokyo Metropolis', 北海道: 'Hokkaido Prefecture' } as Record<string, string>)[name] ?? name : name)

  it('正: 都道府県と同じ範囲の府県予報区（「県」が付かない名前）は、その都道府県の訳で出す', () => {
    expect(eewPrefDisplayName('熊本', en)).toBe('Kumamoto Prefecture')
    expect(eewPrefDisplayName('東京', en)).toBe('Tokyo Metropolis')
  })

  it('対照: 都道府県を分けた府県予報区は電文の名前のまま（都道府県の訳に広げない）', () => {
    expect(eewPrefDisplayName('北海道道央', en)).toBe('北海道道央')
    expect(eewPrefDisplayName('伊豆諸島', en)).toBe('伊豆諸島')
    expect(eewPrefDisplayName('沖縄本島', en)).toBe('沖縄本島')
  })

  it('安全弁: 日本語の画面では電文の名前を書き換えない（「熊本」を「熊本県」にしない）。表に無い名前もそのまま', () => {
    expect(eewPrefDisplayName('熊本', JA_PLACE_NAMES)).toBe('熊本')
    expect(eewPrefDisplayName('知らない予報区', en)).toBe('知らない予報区')
  })
})
