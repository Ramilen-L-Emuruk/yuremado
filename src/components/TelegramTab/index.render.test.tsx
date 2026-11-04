// @vitest-environment jsdom
//
// 電文ログの行と絞り込みを、画面に出る形で固定する。行はライブ受信でしか積まれないので、
// 南海トラフの情報のような滅多に来ない種別は、ここでしか見た目を確かめられない。
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import type { TelegramLogEntry } from '../../types/earthquake'
import { TelegramTab } from './index'

const entry = (id: string, patch: Partial<TelegramLogEntry>): TelegramLogEntry => ({
  id,
  receivedAt: new Date('2026-10-15T00:00:00Z'),
  source: 'dmdss',
  origin: 'live',
  headType: 'VXSE53',
  isTest: false,
  status: 'parsed',
  rawBody: '<Report/>',
  ...patch,
})

const log: TelegramLogEntry[] = [
  entry('a', { headType: 'VYSE51', kind: 'nankaiCommentary' }),
  entry('b', { headType: 'IXAC41', kind: 'estimatedIntensity' }),
  entry('c', { headType: 'VXSE53', kind: 'quake' }),
  // 結合待ちの断片。種別を持たずに記録される
  entry('d', { headType: 'IXAC41', status: 'filtered' }),
  // 扱わないコード（試験報を捨てたときは種別を問わず filtered で記録する）
  entry('e', { headType: 'VZSE41', status: 'filtered' }),
]

const rowTexts = () => screen.getAllByRole('listitem').map(li => li.textContent ?? '')

describe('TelegramTab', () => {
  it('Title の無い電文は、種別の前置きを付けずに短い名前を出す', () => {
    render(<TelegramTab telegramLog={log} onClear={() => {}} active />)
    const rows = rowTexts()
    expect(rows[0]).toContain('南海トラフ地震関連解説情報（臨時解説）')
    expect(rows[1]).toContain('推計震度分布図作図用データ')
    expect(rows[2]).toContain('震源・震度')
    expect(rows.some(row => row.includes('·'))).toBe(false)
    // 扱わないコードは名前を付けず、コードだけを出す
    expect(rows[4]).toContain('VZSE41')
    // 発信元は 1 つだけなので、印を出さない
    expect(rows.some(row => row.includes('DM'))).toBe(false)
  })

  it('XML の電文は Control/Title をそのまま名前にする', () => {
    const xml = '<Report><Control><Title>震源・震度に関する情報</Title></Control><Head><Title>震源・震度情報</Title></Head></Report>'
    render(<TelegramTab telegramLog={[entry('x', { headType: 'VXSE53', kind: 'quake', rawBody: xml })]} onClear={() => {}} active />)
    expect(rowTexts()[0]).toContain('震源・震度に関する情報')
  })

  it('受けた日が変わる所に日付の区切りを置く', () => {
    const two = [
      entry('n', { receivedAt: new Date(2026, 10, 4, 0, 5) }),
      entry('o', { receivedAt: new Date(2026, 10, 3, 23, 55) }),
    ]
    const { container } = render(<TelegramTab telegramLog={two} onClear={() => {}} active />)
    // 区切りは行とは別の要素（選んだ行の地が区切りまで染まらないように）。行の数は電文の数のまま
    expect(rowTexts()).toHaveLength(2)
    const items = [...container.querySelectorAll('ul > li')].map(li => li.textContent ?? '')
    expect(items[0]).toBe('2026年11月4日')
    expect(items[2]).toBe('2026年11月3日')
  })

  // 安全弁: 時刻の読めない行の次の行には、同じ日でも区切りを出し直す（前の日の区切りの下に紛れない）
  it('時刻の読めない行の後は、同じ日でも区切りを出し直す', () => {
    const three = [
      entry('p', { receivedAt: new Date(2026, 10, 4, 0, 5) }),
      entry('q', { receivedAt: new Date(Number.NaN) }),
      entry('r', { receivedAt: new Date(2026, 10, 4, 0, 1) }),
    ]
    const { container } = render(<TelegramTab telegramLog={three} onClear={() => {}} active />)
    const separators = [...container.querySelectorAll('ul > li[role="presentation"]')].map(li => li.textContent)
    expect(separators).toEqual(['2026年11月4日', '2026年11月4日'])
  })

  it('いままで絞れなかった種別で絞れる', () => {
    render(<TelegramTab telegramLog={log} onClear={() => {}} active />)
    const select = screen.getAllByRole('combobox').find(s =>
      within(s).queryByRole('option', { name: 'エラー' }) !== null) as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'estimatedIntensity' } })
    // 読めた行と結合待ちの断片の 2 行
    const rows = rowTexts()
    expect(rows).toHaveLength(2)
    expect(rows.every(row => row.includes('IXAC41'))).toBe(true)
  })

  // 電文ログは最大 2,022 行を持つ。隠したタブは DOM ごと残るので、届くたびに描き直さない
  describe('開いていない間', () => {
    // 正: 閉じている間に届いた行は出ない（描き直していない）
    it('閉じている間に届いた行は描かない', () => {
      const { rerender } = render(<TelegramTab telegramLog={log.slice(0, 1)} onClear={() => {}} active={false} />)
      rerender(<TelegramTab telegramLog={log} onClear={() => {}} active={false} />)
      expect(rowTexts()).toHaveLength(1)
    })

    // 対照: 開いた時点で全行を描く
    it('開いたら、その時点の全行を描く', () => {
      const { rerender } = render(<TelegramTab telegramLog={log.slice(0, 1)} onClear={() => {}} active={false} />)
      rerender(<TelegramTab telegramLog={log} onClear={() => {}} active />)
      expect(rowTexts()).toHaveLength(log.length)
    })

    // 安全弁: 開いている間は届くたびに描き直す
    it('開いている間は届いた行を描く', () => {
      const { rerender } = render(<TelegramTab telegramLog={log.slice(0, 1)} onClear={() => {}} active />)
      rerender(<TelegramTab telegramLog={log} onClear={() => {}} active />)
      expect(rowTexts()).toHaveLength(log.length)
    })
  })
})
