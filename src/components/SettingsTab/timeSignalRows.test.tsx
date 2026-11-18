// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { DEFAULTS, type AppSettings } from '../../hooks/useSettings'
import { setSpeechLocale, __resetSpeechLocaleForTest } from '../../utils/speechLocale'
import { registerSpeechWords, __resetSpeechWordsForTest } from '../../i18n/speechWords'

// 設定の窓の本体と英語の語表はトップレベルで読む（テスト本体の 1 件目に読み込みの待ちを乗せない）
const { TimeSignalRows } = await import('./index')
const { enSpeech } = await import('../../i18n/speech/en')

const SPEAKERS = [{ name: '四国めたん', speaker_uuid: 'u', styles: [{ name: 'ノーマル', id: 2 }] }]

function setup(over: Partial<AppSettings>, speakers = SPEAKERS) {
  const onUpdate = vi.fn()
  const settings: AppSettings = { ...DEFAULTS, ...over }
  render(<TimeSignalRows settings={settings} onUpdate={onUpdate} voicevoxSpeakers={speakers} />)
  return onUpdate
}

const has = (label: string) => screen.queryAllByText(label, { exact: true }).length > 0

describe('TimeSignalRows', () => {
  it('切のときは入り切りの行だけ', () => {
    setup({ timeSignalEnabled: false, ttsEnabled: true })
    expect(has('時報')).toBe(true)
    expect(has('間隔')).toBe(false)
  })

  it('読み上げを切っていると、読み上げにだけ効く行と声の行を出さない', () => {
    setup({ timeSignalEnabled: true, ttsEnabled: false })
    for (const l of ['間隔', '音', '鳴らさない時間帯', '時報の音量']) expect(has(l)).toBe(true)
    for (const l of ['順番', '読み上げの文', '時刻の読み方', '読み上げと重なったとき', '時報の声']) expect(has(l)).toBe(false)
  })

  it('読み上げを入れていれば出す。声の行は話者が取れているときだけ（対照）', () => {
    setup({ timeSignalEnabled: true, ttsEnabled: true })
    for (const l of ['順番', '読み上げの文', '時刻の読み方', '読み上げと重なったとき', '時報の声']) expect(has(l)).toBe(true)
  })

  it('話者が取れていなければ声の行を出さない', () => {
    setup({ timeSignalEnabled: true, ttsEnabled: true }, [])
    expect(has('時報の声')).toBe(false)
  })

  it('読み上げの文の例は、選んだ時刻の読み方で出す', () => {
    setup({ timeSignalEnabled: true, ttsEnabled: true, timeSignalClock: '12h' })
    expect(has('午後3時30分です')).toBe(true)
    expect(has('15時30分です')).toBe(false)
  })

  // 読み上げの文の例は、時報が実際に読む言語（読み上げの言語）の文で出す（2026-11-18 ユーザー選択「時刻を数字で書く (Recommended)」）
  describe('読み上げの文の例の言語', () => {
    afterEach(() => {
      __resetSpeechLocaleForTest()
      __resetSpeechWordsForTest()
    })

    it('正: 読み上げの言語が英語なら、例を英語の文で出す', () => {
      registerSpeechWords('en', enSpeech)
      setSpeechLocale('en')
      setup({ timeSignalEnabled: true, ttsEnabled: true })
      for (const l of ['The time is 15:30.', "It's 15:30.", 'It is now 15:30.', '15:30']) expect(has(l)).toBe(true)
      expect(has('15時30分です')).toBe(false)
    })

    it('安全弁: 読み上げの言語の語表がまだ無ければ、日本語の文で出す（時報も日本語で読む）', () => {
      setSpeechLocale('en')
      setup({ timeSignalEnabled: true, ttsEnabled: true })
      expect(has('15時30分です')).toBe(true)
    })
  })

  it('「通知音と同じ」を外すと、いまの共通の音量から始める。戻すと null', () => {
    const onUpdate = setup({ timeSignalEnabled: true, soundVolume: 0.4, timeSignalVolume: null })
    const row = screen.getByText('時報の音量').closest('[data-settings-row]') as HTMLElement
    act(() => { row.querySelector<HTMLElement>('button, [role=switch], input[type=checkbox]')!.click() })
    expect(onUpdate).toHaveBeenCalledWith('timeSignalVolume', 0.4)
  })

  it('個別の音量のときは「通知音と同じ」を入れると null に戻す', () => {
    const onUpdate = setup({ timeSignalEnabled: true, timeSignalVolume: 0.7 })
    const row = screen.getByText('時報の音量').closest('[data-settings-row]') as HTMLElement
    expect(row.querySelector('input[type=range]')).not.toBeNull()
    act(() => { row.querySelector<HTMLElement>('button, [role=switch], input[type=checkbox]')!.click() })
    expect(onUpdate).toHaveBeenCalledWith('timeSignalVolume', null)
  })
})
