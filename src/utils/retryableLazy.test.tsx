// @vitest-environment jsdom
//
// 遅延読込が一度失敗しても、境界の［再表示］で読み込みからやり直せることを固定する
// （設定の窓の中身 `App.tsx` の `SettingsTab` が使う）。
import { lazy, Suspense, type ComponentType } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, fireEvent, cleanup } from '@testing-library/react'
import { muteConsoleError } from '../test-utils/muteConsoleError'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { retryableLazy } from './retryableLazy'

function Content({ text }: { text: string }) {
  return <div>{text}</div>
}

/**
 * 外から倒せる間は失敗し続ける読み込み。**「N 回目で直る」とは書かない** —— React は境界が受け止めた
 * 例外をもう一度描いて確かめに行くので、回数で決めると［再表示］を押す前に直ってしまう（実際に踏んだ）
 */
function flakyLoader() {
  const state = { failing: true }
  const load = vi.fn(() => (state.failing
    ? Promise.reject(new Error('チャンクを読めなかった'))
    : Promise.resolve({ default: Content })))
  return { load, state }
}

function renderInBoundary(Lazy: ComponentType<{ text: string }>, onCatch: () => void) {
  return render(
    <ErrorBoundary variant="region" label="設定" onCatch={onCatch}>
      <Suspense fallback={null}>
        <Lazy text="設定の中身" />
      </Suspense>
    </ErrorBoundary>,
  )
}

/** 読み込みの Promise と、それを受けた描き直しを済ませる */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

beforeEach(() => {
  // 境界が受け止めた例外を React が console へ出すので黙らせる
  muteConsoleError()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('retryableLazy', () => {
  // 正: 1 回目の読み込みが失敗しても、［再表示］で読み直して中身が出る
  it('読み込みに失敗した後、再表示で読み直して中身を出す', async () => {
    const { load, state } = flakyLoader()
    const Lazy = retryableLazy(load)
    renderInBoundary(Lazy, Lazy.reset)
    await settle()
    expect(screen.getByText('設定を表示できません')).toBeTruthy()
    // 失敗している間に読み込みを繰り返さない（作り直しは境界が受け止めた後だけ）
    expect(load).toHaveBeenCalledTimes(1)

    state.failing = false
    fireEvent.click(screen.getByRole('button', { name: '再表示' }))
    await settle()
    expect(screen.getByText('設定の中身')).toBeTruthy()
    expect(load).toHaveBeenCalledTimes(2)
  })

  // 対照: 境界が `reset` を呼ばなければ、作り直さず表示できないまま（読み直しは受け止めた後の `reset` が起こす）
  it('境界に reset を渡さなければ、再表示を押しても読み直さない', async () => {
    const { load, state } = flakyLoader()
    renderInBoundary(retryableLazy(load), () => {})
    await settle()
    state.failing = false
    fireEvent.click(screen.getByRole('button', { name: '再表示' }))
    await settle()
    expect(screen.queryByText('設定の中身')).toBeNull()
    expect(load).toHaveBeenCalledTimes(1)
  })

  // 対照: 素の `lazy` は失敗を覚え続け、再表示を押しても読み直さない（これを直すための部品であること）
  it('素の lazy では再表示を押しても読み直さず、表示できないまま', async () => {
    const { load, state } = flakyLoader()
    renderInBoundary(lazy(load), () => {})
    await settle()
    expect(screen.getByText('設定を表示できません')).toBeTruthy()

    state.failing = false
    fireEvent.click(screen.getByRole('button', { name: '再表示' }))
    await settle()
    expect(screen.queryByText('設定の中身')).toBeNull()
    expect(load).toHaveBeenCalledTimes(1)
  })

  // 安全弁: 成功した後は差し替えないので、置き直しても読み直さない
  it('一度読めたら、置き直しても読み込みは 1 回だけ', async () => {
    const load = vi.fn(() => Promise.resolve({ default: Content }))
    const Lazy = retryableLazy(load)
    const first = renderInBoundary(Lazy, Lazy.reset)
    await settle()
    expect(screen.getByText('設定の中身')).toBeTruthy()
    first.unmount()

    renderInBoundary(Lazy, Lazy.reset)
    await settle()
    expect(screen.getByText('設定の中身')).toBeTruthy()
    expect(load).toHaveBeenCalledTimes(1)
  })
})
