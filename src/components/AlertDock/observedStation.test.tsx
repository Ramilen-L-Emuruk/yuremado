// @vitest-environment jsdom
//
// 下の帯の津波の行で、観測した最大波の観測点名を括る括弧が言語の形になること（段 10e）。
import { describe, expect, it } from 'vitest'
import { act, render } from '@testing-library/react'
import { AlertDock } from './index'
import { I18nProvider } from '../../i18n/I18nProvider'
import { settleI18n } from '../../test-utils/settleI18n'
import type { TsunamiDockItem } from '../../utils/alertDock'

// 英語の辞書を先に一度読んでおく。初回の変換の待ちをテスト本体に載せないため
await import('../../i18n/messages/en')

const tsunami: TsunamiDockItem = {
  kind: 'tsunami', key: 't1', title: '津波警報', titleColor: '#fff', accent: '#f00',
  status: null, chip: null, updated: null,
  observed: { value: '0.3m', station: '石巻市鮎川' },
  firstWave: null, home: null,
}

describe('下の帯の観測点名の括弧', () => {
  // 対照: 日本語は全角の括弧のまま
  it('日本語は全角の括弧で括る', async () => {
    let view!: ReturnType<typeof render>
    await act(async () => {
      view = render(<I18nProvider locale="ja"><AlertDock eews={[]} tsunami={tsunami} onOpen={() => {}} /></I18nProvider>)
    })
    expect(view.container.textContent).toContain('（石巻市鮎川）')
    view.unmount()
  })

  // 正: 英語は半角の括弧で括る
  it('英語は半角の括弧で括る', async () => {
    let view!: ReturnType<typeof render>
    await act(async () => {
      view = render(<I18nProvider locale="en"><AlertDock eews={[]} tsunami={tsunami} onOpen={() => {}} /></I18nProvider>)
      await settleI18n('en')
    })
    expect(view.container.textContent).toContain('(石巻市鮎川)')
    expect(view.container.textContent).not.toContain('（')
    view.unmount()
  })
})
