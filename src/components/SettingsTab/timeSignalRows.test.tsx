// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { DEFAULTS, type AppSettings } from '../../hooks/useSettings'

// 設定の窓の本体はトップレベルで読む（テスト本体の 1 件目に読み込みの待ちを乗せない）
const { TimeSignalRows } = await import('./index')

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
    setup({ timeSignalEnabled: false, voicevoxEnabled: true })
    expect(has('時報')).toBe(true)
    expect(has('間隔')).toBe(false)
  })

  it('読み上げを切っていると、読み上げにだけ効く行と声の行を出さない', () => {
    setup({ timeSignalEnabled: true, voicevoxEnabled: false })
    for (const l of ['間隔', '音', '鳴らさない時間帯', '時報の音量']) expect(has(l)).toBe(true)
    for (const l of ['順番', '読み上げの文', '時刻の読み方', '読み上げと重なったとき', '時報の声']) expect(has(l)).toBe(false)
  })

  it('読み上げを入れていれば出す。声の行は話者が取れているときだけ（対照）', () => {
    setup({ timeSignalEnabled: true, voicevoxEnabled: true })
    for (const l of ['順番', '読み上げの文', '時刻の読み方', '読み上げと重なったとき', '時報の声']) expect(has(l)).toBe(true)
  })

  it('話者が取れていなければ声の行を出さない', () => {
    setup({ timeSignalEnabled: true, voicevoxEnabled: true }, [])
    expect(has('時報の声')).toBe(false)
  })

  it('読み上げの文の例は、選んだ時刻の読み方で出す', () => {
    setup({ timeSignalEnabled: true, voicevoxEnabled: true, timeSignalClock: '12h' })
    expect(has('午後3時30分です')).toBe(true)
    expect(has('15時30分です')).toBe(false)
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
