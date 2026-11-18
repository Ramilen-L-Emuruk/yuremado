// @vitest-environment jsdom
// 読み上げを画面の言語へ切り替えるのは、その言語の読み上げの語表と地名の表がそろってからにすること。片方でも読めなければ日本語で読み、
// 設定の窓へ知らせを出し、回線が戻ったら読み直してそろえば切り替えること（2026-11-18 ユーザー選択「そろうまで日本語、回線で読み直す (Recommended)」
// 「出す (Recommended)」）。
//
// 正・対照・安全弁の分担:
//   正   ＝ 語表と地名の表がそろえば画面の言語で読み、知らせは出ない
//   対照 ＝ 語表だけ・地名の表だけでは日本語で読み、読めなかった方があれば知らせを出す
//   安全弁＝ 読めなかった後、回線が戻ったら読み直し、そろえば画面の言語へ切り替えて知らせを消す
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import type { PlaceNameTable } from './placeNames'

const h = vi.hoisted(() => ({
  /** 読み上げの語表の読み込みが成功するか */
  speechOk: true,
  /** 地名の表の読み込みが成功するか */
  placeOk: true,
  /** 読み終えた地名の表（失敗中は無い） */
  placeCache: null as unknown,
  speechCalls: 0,
  placeCalls: 0,
  /** 真なら語表の読み込みを保留し、`release` で成功させる（読み直しの最中を作る） */
  speechHold: false,
  release: null as (() => void) | null,
}))

vi.mock('../utils/systemSpeech', () => ({
  hasSystemVoiceFor: () => true,
  onSystemVoicesChanged: () => () => {},
}))

vi.mock('./placeNameLoader', () => ({
  getCachedPlaceNames: () => h.placeCache,
  loadPlaceNames: () => {
    h.placeCalls++
    if (!h.placeOk) return Promise.reject(new Error('テスト用の地名の表の読み込みの失敗'))
    h.placeCache = EN_PLACE_TABLE
    return Promise.resolve(EN_PLACE_TABLE)
  },
}))

// 語表の読み込みの口だけを差し替える（辞書は描く前に渡すので読まない）
vi.mock('./messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./messages')>()
  const { registerSpeechWords } = await import('./speechWords')
  const { enSpeech } = await import('./speech/en')
  return {
    ...actual,
    loadSpeechWordsFor: () => {
      h.speechCalls++
      if (!h.speechOk) return Promise.reject(new Error('テスト用の語表の読み込みの失敗'))
      if (h.speechHold) {
        return new Promise<void>((resolve) => {
          h.release = () => { registerSpeechWords('en', enSpeech); resolve() }
        })
      }
      registerSpeechWords('en', enSpeech)
      return Promise.resolve()
    },
    hasSpeechWordsLoadFailed: () => false,
    clearSpeechWordsLoadFailedMark: () => {},
  }
})

// jsdom の下では `import.meta.url` が file の URL にならないので、テストの起点（リポジトリの根）から読む
const EN_PLACE_TABLE: PlaceNameTable = JSON.parse(readFileSync('public/data/place-names/en.json', 'utf8'))

// 対象はモックを張ったあとで、トップレベルで読む（テスト本体の 1 件目に読み込みの待ちを乗せない）
const { I18nProvider, useSpeechDataLoadFailed } = await import('./I18nProvider')
const { useSpeechLocaleDecision } = await import('../hooks/useSpeechLocale')
const { __resetSpeechWordsForTest } = await import('./speechWords')
const { en } = await import('./messages/en')
const { log } = await import('../utils/logger')

function Probe() {
  const d = useSpeechLocaleDecision()
  const failed = useSpeechDataLoadFailed()
  return <div data-testid="probe">{`${d.speechLocale}|${failed ?? 'なし'}`}</div>
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })
}

async function setup() {
  render(<I18nProvider locale="en" preloaded={en}><Probe /></I18nProvider>)
  await flush()
  return () => screen.getByTestId('probe').textContent
}

beforeEach(() => {
  h.speechOk = true
  h.placeOk = true
  h.placeCache = null
  h.speechCalls = 0
  h.placeCalls = 0
  h.speechHold = false
  h.release = null
  __resetSpeechWordsForTest()
  vi.spyOn(log, 'error').mockImplementation(() => {})
  vi.spyOn(log, 'info').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('読み上げのデータがそろうまで日本語で読む', () => {
  it('正: 語表と地名の表がそろえば画面の言語で読み、知らせは出ない', async () => {
    const probe = await setup()
    expect(probe()).toBe('en|なし')
  })

  it('対照: 語表は読めたが地名の表が読めなければ、日本語で読み知らせを出す', async () => {
    h.placeOk = false
    const probe = await setup()
    expect(probe()).toBe('ja|en')
  })

  it('対照: 地名の表は読めたが語表が読めなければ、日本語で読み知らせを出す', async () => {
    h.speechOk = false
    const probe = await setup()
    expect(probe()).toBe('ja|en')
  })

  it('安全弁: 語表を読めなかった後、回線が戻ったら読み直し、そろえば画面の言語へ切り替えて知らせを消す', async () => {
    h.speechOk = false
    const probe = await setup()
    expect(probe()).toBe('ja|en')
    const before = h.speechCalls
    h.speechOk = true
    act(() => { window.dispatchEvent(new Event('online')) })
    await flush()
    expect(h.speechCalls).toBe(before + 1)
    expect(probe()).toBe('en|なし')
  })

  it('安全弁: 読み直しの最中は知らせを出し続け、読み直しが成功したら消す', async () => {
    h.speechOk = false
    const probe = await setup()
    expect(probe()).toBe('ja|en')
    h.speechOk = true
    h.speechHold = true
    act(() => { window.dispatchEvent(new Event('online')) })
    await flush()
    // 読み直しの約束はまだ保留中
    expect(h.release).not.toBeNull()
    expect(probe()).toBe('ja|en')
    act(() => { h.release!() })
    await flush()
    expect(probe()).toBe('en|なし')
  })

  it('安全弁: 読み直しの最中に言語を変え、その間に読み直しが成功したら、戻ったときに知らせは残らない', async () => {
    h.speechOk = false
    const { rerender } = render(<I18nProvider locale="en" preloaded={en}><Probe /></I18nProvider>)
    await flush()
    const probe = () => screen.getByTestId('probe').textContent
    expect(probe()).toBe('ja|en')
    h.speechOk = true
    h.speechHold = true
    act(() => { window.dispatchEvent(new Event('online')) })
    await flush()
    expect(h.release).not.toBeNull()
    // 読み直しの途中で韓国語へ変える（英語の読み込みの効果は片付けられる）
    rerender(<I18nProvider locale="ko"><Probe /></I18nProvider>)
    await waitFor(() => expect(document.documentElement.lang).toBe('ko'))
    // 英語の読み直しは裏で成功する
    act(() => { h.release!() })
    await flush()
    // 英語へ戻る（語表も地名の表もそろっているので読み込みは走らない）
    rerender(<I18nProvider locale="en"><Probe /></I18nProvider>)
    await waitFor(() => expect(document.documentElement.lang).toBe('en'))
    await flush()
    expect(probe()).toBe('en|なし')
  })

  it('安全弁: 読み直しに失敗したら知らせは残る', async () => {
    h.speechOk = false
    const probe = await setup()
    const before = h.speechCalls
    act(() => { window.dispatchEvent(new Event('online')) })
    await flush()
    expect(h.speechCalls).toBe(before + 1)
    expect(probe()).toBe('ja|en')
  })

  it('安全弁: 地名の表を読めなかった後、回線が戻ったら読み直し、そろえば画面の言語へ切り替える', async () => {
    h.placeOk = false
    const probe = await setup()
    expect(probe()).toBe('ja|en')
    h.placeOk = true
    act(() => { window.dispatchEvent(new Event('online')) })
    await flush()
    expect(probe()).toBe('en|なし')
  })
})
