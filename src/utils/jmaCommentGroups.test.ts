import { describe, it, expect } from 'vitest'
import { jmaCommentGroups, splitJmaSentences } from './jmaCommentGroups'

describe('splitJmaSentences', () => {
  // 正: 句点の後ろで割り、句点は文に残す
  it('続けて書かれた 2 文を 2 行に割る', () => {
    expect(splitJmaSentences('この地震による津波の心配はありません。この地震について、緊急地震速報を発表しています。'))
      .toEqual(['この地震による津波の心配はありません。', 'この地震について、緊急地震速報を発表しています。'])
  })

  // 安全弁: 自由付加文の表（全角空白で桁を揃えた行）は行頭の空白を残す
  it('表の行の頭の全角空白は残す', () => {
    expect(splitJmaSentences('各長周期地震動階級に対する簡易な現象表現\n　階級１　やや大きな揺れ'))
      .toEqual(['各長周期地震動階級に対する簡易な現象表現', '　階級１　やや大きな揺れ'])
  })

  // 対照: 空の文字列は何も返さない
  it('空なら空', () => {
    expect(splitJmaSentences('')).toEqual([])
    expect(splitJmaSentences('  \n ')).toEqual([])
  })
})

describe('jmaCommentGroups', () => {
  // 正: 固定付加文の津波の文と緊急地震速報の文を別の見出しへ分ける
  it('津波と緊急地震速報の文を分け、見出しを付ける', () => {
    const r = jmaCommentGroups({
      forecast: 'この地震による津波の心配はありません。この地震について、緊急地震速報を発表しています。',
      varComment: '＊印は気象庁以外の震度観測点についての情報です。',
    })
    expect(r.showHeadings).toBe(true)
    expect(r.groups.map(g => [g.heading, g.lines])).toEqual([
      ['津波', ['この地震による津波の心配はありません。']],
      ['緊急地震速報', ['この地震について、緊急地震速報を発表しています。']],
      ['その他', ['＊印は気象庁以外の震度観測点についての情報です。']],
    ])
  })

  // 対照: 種類が 1 つだけなら見出しを付けない（震度速報の 0217 だけの報）
  it('種類が 1 つだけなら見出しを付けない', () => {
    const r = jmaCommentGroups({ forecast: '今後の情報に注意してください。' })
    expect(r.showHeadings).toBe(false)
    expect(r.groups).toHaveLength(1)
  })

  // 安全弁: 空の種類は出さない
  it('空の種類は出さない', () => {
    const r = jmaCommentGroups({ forecast: '', varComment: undefined, free: '自由付加文の本文。' })
    expect(r.groups.map(g => g.kind)).toEqual(['free'])
    expect(r.showHeadings).toBe(false)
  })
})
