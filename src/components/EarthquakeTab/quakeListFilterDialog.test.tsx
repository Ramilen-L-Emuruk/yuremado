// @vitest-environment jsdom
//
// 地震タブの絞り込みの窓（2026-11-08 の棚卸しで決めた動き）。
// - 期間の札は、選んでいるものをもう一度押すと外れる（選択「もう一度押すと外れる」）
// - 震度・規模・深さは、絞っていないときも「制限なし」と出す（選択「カタログと同じくいつも出す」）
// - 件数は「読み込んだ数件中 条件に合う数件」（選択「条件に合う数だけ」。数は呼び出し側が渡す）
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import { useState } from 'react'
import { DEFAULT_QUAKE_LIST_FILTER, type QuakeListFilter } from '../../utils/quakeListView'
import { QuakeListFilterDialog } from './QuakeListFilterBar'
import { flushDataEffects } from '../../test-utils/flushDataEffects'

afterEach(cleanup)

function Harness({ initial, onFilter }: { initial: QuakeListFilter; onFilter?: (f: QuakeListFilter) => void }) {
  const [filter, setFilter] = useState(initial)
  return (
    <QuakeListFilterDialog
      filter={filter}
      onChange={f => { setFilter(f); onFilter?.(f) }}
      quakes={[]}
      open
      onClose={() => {}}
      shownCount={3}
      totalCount={50}
      loadNote={null}
    />
  )
}

const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === name) ?? null

describe('期間の札', () => {
  // 正: 選んでいる札をもう一度押すと期間の絞りが外れる。対照: 別の札を押すとその期間へ移る
  it('選んでいる札をもう一度押すと外れ、別の札なら移る', async () => {
    let last: QuakeListFilter | null = null
    render(<Harness initial={DEFAULT_QUAKE_LIST_FILTER} onFilter={f => { last = f }} />)
    await flushDataEffects()
    act(() => { fireEvent.click(button('3日')!) })
    expect(last!.period).toEqual({ kind: 'hours', hours: 72 })
    act(() => { fireEvent.click(button('7日')!) })
    expect(last!.period).toEqual({ kind: 'hours', hours: 168 })
    act(() => { fireEvent.click(button('7日')!) })
    expect(last!.period).toBeNull()
  })

  // 正: 「日付を指定」も、選んでいる間にもう一度押すと外れる
  it('「日付を指定」ももう一度押すと外れる', async () => {
    let last: QuakeListFilter | null = null
    render(<Harness initial={DEFAULT_QUAKE_LIST_FILTER} onFilter={f => { last = f }} />)
    await flushDataEffects()
    act(() => { fireEvent.click(button('日付を指定')!) })
    expect(last!.period?.kind).toBe('range')
    act(() => { fireEvent.click(button('日付を指定')!) })
    expect(last!.period).toBeNull()
  })
})

describe('値の文と件数', () => {
  // 正: 絞っていない震度・規模・深さは「制限なし」。対照: 絞った震度は範囲の文に替わる
  it('絞っていない範囲は「制限なし」と出す', async () => {
    render(<Harness initial={DEFAULT_QUAKE_LIST_FILTER} />)
    await flushDataEffects()
    const texts = () => [...document.querySelectorAll('[role="dialog"] p')].map(p => p.textContent)
    expect(texts().filter(t => t === '制限なし')).toHaveLength(3)
    cleanup()
    render(<Harness initial={{ ...DEFAULT_QUAKE_LIST_FILTER, scale: { min: 30, max: null } }} />)
    await flushDataEffects()
    expect(texts().filter(t => t === '制限なし')).toHaveLength(2)
  })

  // 正: 絞っているときは「読み込んだ数件中 渡された数件」。対照: 絞っていなければ読み込んだ数だけ
  it('件数は絞っているときだけ「◯件中 ◯件」', async () => {
    render(<Harness initial={{ ...DEFAULT_QUAKE_LIST_FILTER, scale: { min: 30, max: null } }} />)
    await flushDataEffects()
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('50件中 3件')
    cleanup()
    render(<Harness initial={DEFAULT_QUAKE_LIST_FILTER} />)
    await flushDataEffects()
    const text = document.querySelector('[role="dialog"]')!.textContent!
    expect(text).toContain('50件')
    expect(text).not.toContain('件中')
  })
})
