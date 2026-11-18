// @vitest-environment jsdom
// 読み上げの言語の決め直しの時機（語表の登録・声の一覧が遅れて届いた・画面が前に出た）と、決めを 1 か所から配ることを固定する。
//
// 正・対照・安全弁の分担:
//   正   ＝ 語表が登録されたら、測り直しを待たずに画面の言語で読む。声の一覧が 5 秒より後に届いても（知らせの無い端末）、
//          間を広げた測り直しか、画面が前に出たときに拾って画面の言語へ切り替える
//   対照 ＝ 声が見つかったら測り直しを止める。日本語の画面では測り直しを置かない
//   安全弁＝ 語表が登録されていない言語は、声があっても日本語で読み「声が無い」とも出さない。設定の窓の注記は置き場の値を読み、
//          自分で決め直さない（読んでいる言語と食い違わない）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { Locale } from '../i18n/messages'

const h = vi.hoisted(() => ({
  locale: 'en' as string,
  /** 端末の声の一覧の答え（null はまだ届いていない） */
  voice: null as boolean | null,
}))

// 地名の表は読めている形（日本語の引き方と別の引き方を配る。語表と地名の表のそろい方は `i18n/speechDataReady.test.tsx`）
const READY_PLACE_NAMES = Object.assign((_kind: string, name: string) => name, { has: () => false })
vi.mock('../i18n/I18nProvider', () => ({ useLocale: () => h.locale, usePlaceNames: () => READY_PLACE_NAMES }))
vi.mock('../utils/systemSpeech', () => ({
  hasSystemVoiceFor: (l: Locale) => (l === 'ja' ? true : h.voice),
  // 声の一覧の知らせを出さない端末（Safari の一部）の形
  onSystemVoicesChanged: () => () => {},
}))

// 対象と語表はモックを張ったあとで、トップレベルで読む（テスト本体の 1 件目に読み込みの待ちを乗せない）
const { useSpeechLocaleDecision, useSpeechVoiceMissing } = await import('./useSpeechLocale')
const { registerSpeechWords, __resetSpeechWordsForTest } = await import('../i18n/speechWords')
const { enSpeech } = await import('../i18n/speech/en')
const { setSpeechLocaleDecision, __resetSpeechLocaleForTest } = await import('../utils/speechLocale')

beforeEach(() => {
  vi.useFakeTimers()
  h.locale = 'en'
  h.voice = null
  __resetSpeechWordsForTest()
  __resetSpeechLocaleForTest()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

describe('語表の登録の知らせ', () => {
  it('正: 語表が登録されたら、測り直しを待たずに画面の言語で読む', async () => {
    h.voice = true
    const { result } = renderHook(() => useSpeechLocaleDecision())
    await advance(0)
    expect(result.current).toEqual({ speechLocale: 'ja', missingVoice: false })
    act(() => registerSpeechWords('en', enSpeech))
    expect(result.current).toEqual({ speechLocale: 'en', missingVoice: false })
  })

  it('安全弁: 語表が登録されていない言語は、声があっても日本語で読み、「声が無い」とも出さない', async () => {
    h.voice = true
    const { result } = renderHook(() => useSpeechLocaleDecision())
    await advance(6000)
    expect(result.current).toEqual({ speechLocale: 'ja', missingVoice: false })
  })
})

describe('声の一覧が遅れて届く端末', () => {
  beforeEach(() => { registerSpeechWords('en', enSpeech) })

  it('正: 5 秒を過ぎて一覧が届いても、間を広げた測り直しで拾って画面の言語へ切り替える', async () => {
    const { result } = renderHook(() => useSpeechLocaleDecision())
    await advance(5000)
    // 5 秒たっても一覧が空 → 声が無いとして日本語で読み、注記を出す
    expect(result.current).toEqual({ speechLocale: 'ja', missingVoice: true })
    // 20 秒の時点で一覧が埋まる（知らせは来ない）
    await advance(15_000)
    h.voice = true
    // 5 秒 + 10 秒の測り直しはもう過ぎた。次は 5 + 10 + 30 秒
    expect(result.current).toEqual({ speechLocale: 'ja', missingVoice: true })
    await advance(25_000)
    expect(result.current).toEqual({ speechLocale: 'en', missingVoice: false })
  })

  it('対照: 声が見つかったら測り直しを止める', async () => {
    renderHook(() => useSpeechLocaleDecision())
    await advance(5000)
    h.voice = true
    await advance(10_000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('正: 画面が前に出たときにも測り直す', async () => {
    const { result } = renderHook(() => useSpeechLocaleDecision())
    await advance(5000)
    expect(result.current.missingVoice).toBe(true)
    h.voice = true
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(result.current).toEqual({ speechLocale: 'en', missingVoice: false })
  })

  it('対照: 日本語の画面では、声の一覧を待つ測り直しを置かない', async () => {
    h.locale = 'ja'
    renderHook(() => useSpeechLocaleDecision())
    await advance(5000)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('決めを 1 か所から配る', () => {
  it('安全弁: 設定の窓の注記は置き場の値を読み、自分で決め直さない', () => {
    // 声があり語表もある（自分で決め直せば「声が無い」にはならない）のに、App が置いた値をそのまま出す
    h.voice = true
    registerSpeechWords('en', enSpeech)
    const { result } = renderHook(() => useSpeechVoiceMissing())
    expect(result.current).toBe(false)
    act(() => setSpeechLocaleDecision({ speechLocale: 'ja', missingVoice: true }))
    expect(result.current).toBe(true)
    act(() => setSpeechLocaleDecision({ speechLocale: 'en', missingVoice: false }))
    expect(result.current).toBe(false)
  })
})
