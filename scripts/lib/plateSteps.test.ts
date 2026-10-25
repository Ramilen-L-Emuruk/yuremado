// PB2002 の歩の 7 分類を境界線へ割り当てる部品（plateSteps.mjs）のテスト。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseSteps, indexSteps, splitLineByClass, PLATE_STEP_CLASSES } from './plateSteps.mjs'
import { PLATE_BOUNDARY_CLASSES } from '../../src/utils/plateBoundaries'

// 原典の書式どおりの 3 歩（AF-AN の頭 3 行。2 歩目までが OTF、3 歩目が OSR）。
const STEPS = [
  '   1  AF-AN   -0.438 -54.852   -0.039 -54.677  32.1  53  13.2  48    1.2   13.1  -1584   2  OTF ',
  '   2 :AF-AN   -0.039 -54.677    0.443 -54.451  40.0  51  13.2  47    0.9   13.1  -1639   5 :OTF ',
  '   3 :AF-AN    0.443 -54.451    0.965 -54.832  54.0 142  13.2  47   13.1   -1.1  -1687   4  OSR ',
].join('\r\n')

const grid = indexSteps(parseSteps(STEPS))

describe('splitLineByClass（境界線を 7 分類で割る）', () => {
  it('正: 同じ分類が続く区間をまとめ、分類が変わる点で割る', () => {
    const r = splitLineByClass(grid, [[-0.438, -54.852], [-0.039, -54.677], [0.443, -54.451], [0.965, -54.832]])
    expect(r?.runs.map((x) => [x.cls, x.coords.length])).toEqual([['OTF', 3], ['OSR', 2]])
    expect(r?.unmatched).toBe(0)
  })

  it('正: 逆向きの線でも、端点の丸めが 0.001 度ずれていても当たる', () => {
    const r = splitLineByClass(grid, [[0.966, -54.831], [0.443, -54.451]])
    expect(r?.runs.map((x) => x.cls)).toEqual(['OSR'])
  })

  it('対照: 歩に当たらない区間は直前の区間の分類を引き継ぐ（日付変更線で足された点）', () => {
    const r = splitLineByClass(grid, [[-0.438, -54.852], [-0.039, -54.677], [-0.02, -54.66]])
    expect(r?.runs.map((x) => x.cls)).toEqual(['OTF'])
    expect(r?.unmatched).toBe(1)
  })

  it('正: 日付変更線の片側だけの切れ端は、日付変更線をまたぐ歩の分類を取る', () => {
    const g = indexSteps(parseSteps(
      '4900 :AU-BR  179.938 -15.640 -179.739 -15.542  26.0  80  10.0  40    1.0    9.9  -2000   3 :CTF ',
    ))
    expect(splitLineByClass(g, [[-180, -15.620711], [-179.739, -15.5422]])?.runs.map((x) => x.cls)).toEqual(['CTF'])
    expect(splitLineByClass(g, [[179.938, -15.64], [180, -15.620711]])?.runs.map((x) => x.cls)).toEqual(['CTF'])
  })

  it('安全弁: 1 区間も当たらない線には分類を付けない', () => {
    expect(splitLineByClass(grid, [[10, 10], [11, 11]])).toBeNull()
  })

  it('安全弁: 表に無い分類の行は読まずに止める', () => {
    expect(() => parseSteps(STEPS.replace(' OSR ', ' XXX '))).toThrow()
  })
})

describe('生成済みのプレート境界（public/data/plate-boundaries.json）', () => {
  const data = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'data', 'plate-boundaries.json'), 'utf8'),
  ) as { type: string }[]

  it('正: 全件が 7 分類のどれかを持ち、7 分類すべてが現れる', () => {
    const types = new Set(data.map((d) => d.type))
    expect([...types].filter((t) => !(t in PLATE_BOUNDARY_CLASSES))).toEqual([])
    expect([...types].sort()).toEqual([...PLATE_STEP_CLASSES].sort())
  })

  it('安全弁: 生成側と画面側の分類表が同じ顔ぶれ', () => {
    expect(Object.keys(PLATE_BOUNDARY_CLASSES).sort()).toEqual([...PLATE_STEP_CLASSES].sort())
  })
})
