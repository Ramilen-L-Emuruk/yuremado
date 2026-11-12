// @vitest-environment jsdom
//
// 辞書を読めなかったときに日本語へ戻ることを固定する。韓国語の辞書の読み込みをわざと失敗させるので、
// ほかのテストと混ざらないようファイルを分けている。
import { describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { I18nProvider, useLocale, useLocaleLoadFailed, useMessages } from './I18nProvider'
import { loadMessages, type Locale } from './messages'
import { muteConsoleError } from '../test-utils/muteConsoleError'

vi.mock('./messages/ko', () => { throw new Error('読み込みの失敗を作る') })

// 英語の辞書を先に一度読んでおく。初回の変換の待ちをテスト本体に載せないため
await import('./messages/en')

function Probe() {
  return <span data-testid="probe">{`${useLocale()}:${useMessages().nav.earthquake}`}</span>
}

function FailedProbe() {
  return <span data-testid="failed">{useLocaleLoadFailed() ?? 'none'}</span>
}

async function settle(locale: Locale) {
  await loadMessages(locale).catch(() => {})
  await new Promise((r) => setTimeout(r, 0))
}

describe('I18nProvider の読み込みの失敗', () => {
  it('英語を出した後に韓国語を読めなければ、英語のまま残さず日本語へ戻す', async () => {
    const muted = muteConsoleError()
    try {
      let view!: ReturnType<typeof render>
      await act(async () => { view = render(<I18nProvider locale="en"><Probe /></I18nProvider>); await settle('en') })
      expect(screen.getByTestId('probe').textContent).toBe('en:Earthquake Information')
      await act(async () => { view.rerender(<I18nProvider locale="ko"><Probe /></I18nProvider>); await settle('ko') })
      expect(screen.getByTestId('probe').textContent).toBe('ja:地震情報')
      expect(document.documentElement.lang).toBe('ja')
      // 日本語へ戻したことで効果が走り直しても、読めなかった言語を読み直さない（記録も 1 回だけ）
      await act(async () => { await settle('ko') })
      const i18nErrors = muted.mock.calls.filter((args) => args.some((a) => typeof a === 'string' && a.includes('[i18n]')))
      expect(i18nErrors).toHaveLength(1)
    } finally {
      muted.mockRestore()
    }
  })

  it('読めなかった言語は、回線が戻ったらもう一度読みに行く（読めなければ日本語のまま、記録をもう 1 回残す）', async () => {
    const muted = muteConsoleError()
    try {
      await act(async () => { render(<I18nProvider locale="ko"><Probe /><FailedProbe /></I18nProvider>); await settle('ko') })
      const errorsOf = () => muted.mock.calls.filter((args) => args.some((a) => typeof a === 'string' && a.includes('[i18n]'))).length
      expect(errorsOf()).toBe(1)
      await act(async () => { window.dispatchEvent(new Event('online')); await settle('ko') })
      expect(errorsOf()).toBe(2)
      expect(screen.getByTestId('probe').textContent).toBe('ja:地震情報')
      // 設定の窓が知らせを出すための印も立ったまま
      expect(screen.getByTestId('failed').textContent).toBe('ko')
    } finally {
      muted.mockRestore()
    }
  })

  it('表に無い言語は、同期で投げずに拒否で返す', async () => {
    let thrown = false
    let promise: Promise<unknown> | undefined
    try { promise = loadMessages('xx' as Locale) } catch { thrown = true }
    expect(thrown).toBe(false)
    await expect(promise).rejects.toThrow()
  })
})
