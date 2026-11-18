// 画面の辞書の読み込みが、読み上げの語表も同じ読み込みで読んで登録すること（2026-11-18 ユーザー選択「辞書と一緒に後から読む (Recommended)」）。
//
// 正・対照・安全弁の分担:
//   正   ＝ 辞書を読み終えた時点で語表も登録済み（画面がその言語になった描画で読み上げもその言語で組める）。登録は知らせを出し、
//          その言語の組は画面の言語の文を組む
//   対照 ＝ 日本語は語表を読まない（起動の束の日本語の語表のまま）
//   安全弁＝ 語表だけが読めなくても辞書の読み込みは止まらず、読み上げは日本語で読み、記録を残す
import { afterEach, describe, expect, it, vi } from 'vitest'

// スペイン語の語表だけ読めない形を作る（辞書は読める）
vi.mock('./speech/es', () => { throw new Error('テスト用の語表の読み込みの失敗') })

// 対象はモックを張ったあとで、トップレベルで読む（テスト本体の 1 件目に読み込みの待ちを乗せない）
const { loadMessages, loadSpeechWordsFor, hasSpeechWordsLoadFailed } = await import('./messages')
const { speechWordsFor, subscribeSpeechWords, __resetSpeechWordsForTest } = await import('./speechWords')
const { speechTextFor, canBuildSpeechText } = await import('../utils/ttsText')
const { decideSpeechLocale } = await import('../hooks/useSpeechLocale')
const { JA_PLACE_NAMES } = await import('./placeNames')
const { log } = await import('../utils/logger')
// 変換の待ちをテスト本体に乗せないよう、先に一度読んでおく（登録は各テストの前に消す）
await Promise.all([loadMessages('en'), loadMessages('ko'), loadMessages('es')])

afterEach(() => {
  __resetSpeechWordsForTest()
  vi.restoreAllMocks()
})

describe('辞書と語表を一緒に読む', () => {
  it('正: 辞書を読み終えた時点で語表が登録され、知らせが出る', async () => {
    __resetSpeechWordsForTest()
    const notified = vi.fn()
    subscribeSpeechWords(notified)
    expect(speechWordsFor('ko')).toBeNull()
    const messages = await loadMessages('ko')
    expect(messages.settings).toBeDefined()
    expect(speechWordsFor('ko')).not.toBeNull()
    expect(notified).toHaveBeenCalledTimes(1)
  })

  it('正: 登録した後は、声のある端末で画面の言語で読む（組がその言語の文を組む）', async () => {
    __resetSpeechWordsForTest()
    await loadMessages('en')
    expect(decideSpeechLocale('en', () => true, canBuildSpeechText, true, true)).toEqual({ speechLocale: 'en', missingVoice: false })
    const st = speechTextFor('en', JA_PLACE_NAMES)
    expect(st.locale).toBe('en')
    expect(st.kyoshinDetectionText({ kind: 'detected', regionName: null })).toBe('Shaking detected.')
  })

  it('対照: 日本語は語表を読み込まない（知らせも出ない）', async () => {
    __resetSpeechWordsForTest()
    const notified = vi.fn()
    subscribeSpeechWords(notified)
    await loadMessages('ja')
    expect(notified).not.toHaveBeenCalled()
    expect(speechWordsFor('ja')).not.toBeNull()
  })

  it('安全弁: 語表だけが読めなくても辞書は返り、読み上げは日本語で読み、記録を残す', async () => {
    __resetSpeechWordsForTest()
    const error = vi.spyOn(log, 'error').mockImplementation(() => {})
    const messages = await loadMessages('es')
    expect(messages.settings).toBeDefined()
    expect(speechWordsFor('es')).toBeNull()
    expect(decideSpeechLocale('es', () => true, canBuildSpeechText, true, true)).toEqual({ speechLocale: 'ja', missingVoice: false })
    expect(hasSpeechWordsLoadFailed('es')).toBe(true)
    expect(error.mock.calls.filter((c) => String(c[0]).includes('読み上げの語表を読めず'))).toHaveLength(1)
  })

  it('安全弁: 同じ言語を並んで読んでも、読み込みは 1 つにまとまり、失敗の記録は 1 度だけ', async () => {
    __resetSpeechWordsForTest()
    const error = vi.spyOn(log, 'error').mockImplementation(() => {})
    const a = loadSpeechWordsFor('es')
    const b = loadSpeechWordsFor('es')
    expect(a).toBe(b)
    await Promise.allSettled([a, b, loadMessages('es')])
    expect(error.mock.calls.filter((c) => String(c[0]).includes('読み上げの語表を読めず'))).toHaveLength(1)
    expect(speechTextFor('es', JA_PLACE_NAMES).locale).toBe('ja')
    expect(error.mock.calls.some((c) => String(c[0]).includes('読み上げの語表を読めず'))).toBe(true)
  })
})
