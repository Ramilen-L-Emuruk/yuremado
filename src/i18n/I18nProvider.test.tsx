// @vitest-environment jsdom
//
// 言語の配り役と、ナビがその辞書を使うことを固定する。
import { describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { I18nProvider, useLocale, useMessages } from './I18nProvider'
import { IconNav } from '../components/IconNav'
import { loadMessages } from './messages'

// 英語の辞書を先に一度読んでおく。初回の変換の待ちをテスト本体に載せないため
await import('./messages/en')

function Probe() {
  const m = useMessages()
  return <span data-testid="probe">{`${useLocale()}:${m.nav.earthquake}`}</span>
}

describe('I18nProvider', () => {
  it('配り役の外でも日本語の辞書を返す（テストや部品単体の描画で落ちない）', () => {
    render(<Probe />)
    expect(screen.getByTestId('probe').textContent).toBe('ja:地震情報')
  })

  it('日本語を配ると <html lang> を ja にする', async () => {
    document.documentElement.lang = ''
    await act(async () => { render(<I18nProvider locale="ja"><Probe /></I18nProvider>) })
    expect(screen.getByTestId('probe').textContent).toBe('ja:地震情報')
    expect(document.documentElement.lang).toBe('ja')
  })

  it('日本語以外を配ると、辞書を読み終えてから差し替え、<html lang> もその言語にする', async () => {
    let view!: ReturnType<typeof render>
    await act(async () => {
      view = render(<I18nProvider locale="en"><Probe /></I18nProvider>)
      // 配り役が待っている読み込みと同じものを待ち、差し替えの描き直しまで act の中で済ませる
      await loadMessages('en')
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(screen.getByTestId('probe').textContent).toBe('en:Earthquake Information')
    expect(document.documentElement.lang).toBe('en')
    // 日本語へ戻すと、日本語の辞書と lang へ戻る
    await act(async () => { view.rerender(<I18nProvider locale="ja"><Probe /></I18nProvider>) })
    expect(screen.getByTestId('probe').textContent).toBe('ja:地震情報')
    expect(document.documentElement.lang).toBe('ja')
  })

  it('ナビのボタン名は辞書から引く（日本語の画面は今までと同じ名前）', async () => {
    await act(async () => {
      render(
        <I18nProvider locale="ja">
          <IconNav
            activeTab="earthquake" onTabChange={() => {}} panelCollapsed={false}
            settingsOpen={false} onToggleSettings={() => {}} settingsButtonRef={createRef()}
            tsunamiGrade={null} eewLevel={null}
          />
        </I18nProvider>,
      )
    })
    const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))
    expect(names).toEqual(['地震情報', 'リアルタイム', '津波情報', '震源カタログ', '設定', '電文ログ'])
  })
})
