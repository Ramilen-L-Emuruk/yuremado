// @vitest-environment jsdom
//
// 配り役が言語の地名の表を読み、地名を出す部品へ配ることを固定する。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { I18nProvider, useLocale, usePlaceNames } from './I18nProvider'
import { loadMessages } from './messages'
import { PLACE_NAME_KINDS } from './placeNames'
import { muteConsoleError } from '../test-utils/muteConsoleError'

// 使う言語の辞書を先に一度ずつ読んでおく。初回の変換の待ちをテスト本体に載せないため
// （全件を並列で回すと、本体で初めて読んだ辞書の待ちで 5 秒を超えた）
await Promise.all([
  import('./messages/en'), import('./messages/es'), import('./messages/ko'),
  import('./messages/ptBR'), import('./messages/zhHans'), import('./messages/zhHant'),
])

function Probe() {
  const place = usePlaceNames()
  return <span data-testid="probe">{place('epi', '石狩地方北部')}</span>
}

const table = { ...Object.fromEntries(PLACE_NAME_KINDS.map((k) => [k, {}])), epi: { 石狩地方北部: 'Northern Ishikari Region, Hokkaido' } }

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('I18nProvider の地名', () => {
  it('日本語の画面では表を読まず、名前をそのまま出す', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await act(async () => { render(<I18nProvider locale="ja"><Probe /></I18nProvider>) })
    expect(screen.getByTestId('probe').textContent).toBe('石狩地方北部')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ほかの言語では、その言語の表を読んでから訳を出す', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(table), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const en = await loadMessages('en')
    await act(async () => {
      render(<I18nProvider locale="en" preloaded={en}><Probe /></I18nProvider>)
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('data/place-names/en.json')
    expect(screen.getByTestId('probe').textContent).toBe('Northern Ishikari Region, Hokkaido')
  })

  it('表を読めなければ、地名は日本語のまま出す（安全弁）', async () => {
    const muted = muteConsoleError()
    try {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })))
      const ko = await loadMessages('ko')
      await act(async () => {
        render(<I18nProvider locale="ko" preloaded={ko}><Probe /></I18nProvider>)
        await new Promise((r) => setTimeout(r, 0))
      })
      expect(screen.getByTestId('probe').textContent).toBe('石狩地方北部')
      expect(placeNameErrors(muted)).toBe(1)
    } finally {
      muted.mockRestore()
    }
  })

  it('読めなかった表は、回線が戻ったらもう一度読みに行き、読めたら訳を出す', async () => {
    const muted = muteConsoleError()
    try {
      let ok = false
      const fetchMock = vi.fn(async () => (ok
        ? new Response(JSON.stringify(table), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response('not found', { status: 404 })))
      vi.stubGlobal('fetch', fetchMock)
      const es = await loadMessages('es')
      await act(async () => {
        render(<I18nProvider locale="es" preloaded={es}><Probe /></I18nProvider>)
        await new Promise((r) => setTimeout(r, 0))
      })
      expect(screen.getByTestId('probe').textContent).toBe('石狩地方北部')
      // 失敗した後は、回線が戻るまで同じ言語を取りに行かない
      expect(fetchMock).toHaveBeenCalledTimes(1)
      ok = true
      await act(async () => {
        window.dispatchEvent(new Event('online'))
        await new Promise((r) => setTimeout(r, 0))
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(screen.getByTestId('probe').textContent).toBe('Northern Ishikari Region, Hokkaido')
      expect(placeNameErrors(muted)).toBe(1)
    } finally {
      muted.mockRestore()
    }
  })

  // 正: 言語を切り替えた直後、次の言語の表を読み終えるまでは、前の言語の訳を出さず日本語の名前で出す
  it('切り替えた先の表を読み終えるまでは、前の言語の訳ではなく日本語の名前を出す', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => (String(url).includes('pt-BR')
      ? new Response(JSON.stringify(table), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Promise<Response>(() => {}))) // 中国語（簡体）の表は返らないまま
    vi.stubGlobal('fetch', fetchMock)
    const pt = await loadMessages('pt-BR')
    const zh = await loadMessages('zh-Hans')
    // 描くたびに言語と地名を控える。切り替えの直後の 1 回だけ前の言語の表が残りうるので、最後の画面だけでは見えない
    const seen: string[] = []
    function Recorder() {
      seen.push(`${useLocale()}:${usePlaceNames()('epi', '石狩地方北部')}`)
      return null
    }
    let view!: ReturnType<typeof render>
    await act(async () => {
      view = render(<I18nProvider locale="pt-BR" preloaded={pt}><Recorder /></I18nProvider>)
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(seen[seen.length - 1]).toBe('pt-BR:Northern Ishikari Region, Hokkaido')
    seen.length = 0
    await act(async () => {
      view.rerender(<I18nProvider locale="zh-Hans" preloaded={zh}><Recorder /></I18nProvider>)
      await new Promise((r) => setTimeout(r, 0))
    })
    const zhRenders = seen.filter((s) => s.startsWith('zh-Hans:'))
    expect(zhRenders.length).toBeGreaterThan(0)
    expect(zhRenders.every((s) => s === 'zh-Hans:石狩地方北部')).toBe(true)
  })

  // 対照: 言語が変わらなければ、読み終えた表の訳を出し続ける（切り替えの判定が同じ言語では効かない）。
  // 取り直しの有無は、読んだ表がモジュールの控えに残るので取得の回数では見分けられない。ここでは確かめない
  it('対照: 同じ言語のまま描き直しても、訳を出し続ける', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(table), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const pt = await loadMessages('pt-BR')
    let view!: ReturnType<typeof render>
    await act(async () => {
      view = render(<I18nProvider locale="pt-BR" preloaded={pt}><Probe /></I18nProvider>)
      await new Promise((r) => setTimeout(r, 0))
    })
    await act(async () => {
      view.rerender(<I18nProvider locale="pt-BR" preloaded={pt}><Probe /></I18nProvider>)
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(screen.getByTestId('probe').textContent).toBe('Northern Ishikari Region, Hokkaido')
  })

  // 安全弁: 読めなかった言語から別の言語へ移ると失敗の印を外すので、戻ったときにもう一度読みに行く
  it('読めなかった言語から別の言語へ移って戻ると、その言語の表をもう一度読みに行く', async () => {
    const muted = muteConsoleError()
    try {
      const fetchMock = vi.fn(async (url: string | URL) => (String(url).includes('zh-Hant')
        ? new Response('not found', { status: 404 })
        : new Response(JSON.stringify(table), { status: 200, headers: { 'content-type': 'application/json' } })))
      vi.stubGlobal('fetch', fetchMock)
      const hant = await loadMessages('zh-Hant')
      const en = await loadMessages('en')
      const hantCalls = () => fetchMock.mock.calls.filter((c) => String((c as unknown[])[0]).includes('zh-Hant')).length
      let view!: ReturnType<typeof render>
      await act(async () => {
        view = render(<I18nProvider locale="zh-Hant" preloaded={hant}><Probe /></I18nProvider>)
        await new Promise((r) => setTimeout(r, 0))
      })
      expect(hantCalls()).toBe(1)
      await act(async () => {
        view.rerender(<I18nProvider locale="en" preloaded={en}><Probe /></I18nProvider>)
        await new Promise((r) => setTimeout(r, 0))
      })
      await act(async () => {
        view.rerender(<I18nProvider locale="zh-Hant" preloaded={hant}><Probe /></I18nProvider>)
        await new Promise((r) => setTimeout(r, 0))
      })
      expect(hantCalls()).toBe(2)
      expect(screen.getByTestId('probe').textContent).toBe('石狩地方北部')
    } finally {
      muted.mockRestore()
    }
  })
})

function placeNameErrors(muted: ReturnType<typeof muteConsoleError>): number {
  return muted.mock.calls.filter((args) => args.some((a) => typeof a === 'string' && a.includes('の地名の表を読めず'))).length
}
