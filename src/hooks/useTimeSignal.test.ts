// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { DEFAULTS, type AppSettings } from './useSettings'

// 時計・音・声を差し替える。時計は偽のタイマーの Date.now() に `clockJump` を足したもの
const h = vi.hoisted(() => ({
  clockJump: 0,
  busy: false,
  pending: false,
  ctxState: 'running' as string,
  cancel: vi.fn(),
  schedule: vi.fn(),
  speak: vi.fn(),
  prewarm: vi.fn(),
  prewarmBuffer: { duration: 1.2 } as { duration: number } | null,
  ctxBase: 0,
  /** 端末の声で読むか（`routesToSystemVoice` の答え） */
  systemVoice: false,
  measure: vi.fn(),
  /** 端末の声で測った長さ（秒）。null は測れなかった */
  measureSec: 1.0 as number | null,
}))

vi.mock('../utils/clock', () => ({
  serverNow: () => Date.now() + h.clockJump,
  // ロガーが時刻の頭書きに使う
  serverDate: () => new Date(Date.now() + h.clockJump),
}))
vi.mock('../utils/alertSound', () => ({
  getAudioContext: () => ({
    get state() { return h.ctxState },
    get currentTime() { return (Date.now() - h.ctxBase) / 1000 },
    resume: () => Promise.resolve(),
  }),
  isAlertSpeechPending: () => false,
  scheduleTimeSignalSound: (...args: unknown[]) => { h.schedule(...args); return { cancel: h.cancel } },
}))
vi.mock('../utils/voicevox', () => ({
  isSpeaking: () => h.busy,
  routesToSystemVoice: () => h.systemVoice,
  measureSystemSpeechSec: (text: string) => { h.measure(text); return Promise.resolve(h.measureSec) },
  prewarmVoicevox: (_url: string, text: string) => {
    h.prewarm(text)
    return { text, first: Promise.resolve(h.prewarmBuffer), abort: () => {} }
  },
  speakWithVoicevoxUncounted: (...args: unknown[]) => { h.speak(...args); return Promise.resolve({ spoke: true, spokenChunks: [] }) },
}))

vi.mock('../utils/systemSpeech', () => ({
  isSystemSpeechSupported: () => true,
}))

vi.mock('../utils/pendingSpeech', () => ({
  hasPendingSpeech: () => h.pending,
}))

// 対象はモックを張ったあとで読む（トップレベルで読むと、テスト本体の 1 件目に読み込みの待ちが乗らない）
const { useTimeSignal } = await import('./useTimeSignal')

const URL = 'http://localhost:50021'
const settings = (over: Partial<AppSettings> = {}): AppSettings => ({
  ...DEFAULTS, timeSignalEnabled: true, ttsEnabled: true, ...over,
})

/** 偽の時計を進める（タイマーの発火で起きる更新を act で包む） */
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.useFakeTimers()
  // 15:59:50（現地時刻）から始める。境 16:00 の支度は最初の時計の確認で始まる
  vi.setSystemTime(new Date(2026, 10, 4, 15, 59, 50))
  h.ctxBase = Date.now()
  h.clockJump = 0
  h.busy = false
  h.pending = false
  h.ctxState = 'running'
  h.prewarmBuffer = { duration: 1.2 }
  h.systemVoice = false
  h.measureSec = 1.0
  h.cancel.mockReset(); h.schedule.mockReset(); h.speak.mockReset(); h.prewarm.mockReset(); h.measure.mockReset()
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  warn.mockRestore()
  vi.useRealTimers()
})

const warnedWith = (s: string) => warn.mock.calls.some((c: unknown[]) => c.some(a => typeof a === 'string' && a.includes(s)))

describe('useTimeSignal', () => {
  it('境の 10 秒前に音を予約し、音が鳴り終わってから「16時です」と読む', async () => {
    renderHook(() => useTimeSignal(settings(), URL))
    expect(h.schedule).toHaveBeenCalledTimes(1)
    const [kind, mark, volume] = h.schedule.mock.calls[0]
    expect(kind).toBe('pips')
    // 合図は AudioContext の時刻で 10 秒後（境ちょうど）
    expect(mark as number).toBeCloseTo(10, 2)
    expect(volume).toBeNull()
    // 合成は声の 6 秒前（境 +1.5 秒の 6 秒前 = 今から 5.5 秒後）まで投げない
    expect(h.prewarm).not.toHaveBeenCalled()
    await advance(5_600)
    expect(h.prewarm).toHaveBeenCalledWith('16時です')
    await advance(10_000 + 1_400 - 5_600)
    expect(h.speak).not.toHaveBeenCalled()
    await advance(200)
    expect(h.speak).toHaveBeenCalledTimes(1)
    expect(h.speak.mock.calls[0][1]).toBe('16時です')
  })

  it('他の読み上げの最中なら、音だけ鳴らして声を省く（既定）。先の合成も投げない', async () => {
    h.busy = true
    renderHook(() => useTimeSignal(settings(), URL))
    await advance(15_000)
    expect(h.schedule).toHaveBeenCalledTimes(1)
    expect(h.cancel).not.toHaveBeenCalled()
    expect(h.prewarm).not.toHaveBeenCalled()
    expect(h.speak).not.toHaveBeenCalled()
  })

  it('電文の読み上げが控えている（まだ読み始めていない）ときも声を省く', async () => {
    h.pending = true
    renderHook(() => useTimeSignal(settings(), URL))
    await advance(15_000)
    expect(h.speak).not.toHaveBeenCalled()
  })

  it('空いていれば読む（対照: 控えが解けたあとは省かない）', async () => {
    h.pending = true
    renderHook(() => useTimeSignal(settings(), URL))
    await advance(5_000)
    h.pending = false
    await advance(10_000)
    expect(h.speak).toHaveBeenCalledTimes(1)
  })

  it('「鳴らさない」を選んでいれば、他の読み上げの最中は音も取り消す', async () => {
    h.busy = true
    renderHook(() => useTimeSignal(settings({ timeSignalWhileSpeaking: 'skip' }), URL))
    await advance(15_000)
    expect(h.cancel).toHaveBeenCalled()
    expect(h.speak).not.toHaveBeenCalled()
  })

  it('読み上げが先で「鳴らさない」のとき、声の時点で他の読み上げが始まっていれば音も取り消す', async () => {
    renderHook(() => useTimeSignal(settings({ timeSignalOrder: 'speechFirst', timeSignalWhileSpeaking: 'skip' }), URL))
    await advance(1_000)
    h.busy = true
    await advance(15_000)
    expect(h.speak).not.toHaveBeenCalled()
    expect(h.cancel).toHaveBeenCalled()
  })

  it('鳴らさない時間帯の境は支度しない。時間帯の外の境は鳴らす', async () => {
    // 16:00 を含む時間帯
    const quiet = settings({ timeSignalQuietEnabled: true, timeSignalQuietStartMin: 15 * 60 + 30, timeSignalQuietEndMin: 16 * 60 + 5 })
    const first = renderHook(() => useTimeSignal(quiet, URL))
    await advance(15_000)
    expect(h.schedule).not.toHaveBeenCalled()
    first.unmount()
    // 終わりの 16:05 は含まない（5 分ごとにして確かめる）
    vi.setSystemTime(new Date(2026, 10, 4, 16, 4, 50))
    renderHook(() => useTimeSignal({ ...quiet, timeSignalIntervalMin: 5 }, URL))
    expect(h.schedule).toHaveBeenCalledTimes(1)
  })

  it('支度のあとで時計が動いたら、予約を取り消して取り直す（リプレイの頭出し・較正のし直し）', async () => {
    renderHook(() => useTimeSignal(settings(), URL))
    expect(h.schedule).toHaveBeenCalledTimes(1)
    // 時計が 3 秒進んだ（境まで 7 秒）
    h.clockJump = 3_000
    await advance(1_000)
    expect(h.cancel).toHaveBeenCalledTimes(1)
    expect(h.schedule).toHaveBeenCalledTimes(2)
    // 取り直した合図は、AudioContext の時刻で「今から 6 秒後」（1 秒進めたうえで境まで 6 秒）
    expect(h.schedule.mock.calls[1][1] as number).toBeCloseTo(1 + 6, 2)
  })

  it('時計が少し揺れただけなら取り直さない', async () => {
    renderHook(() => useTimeSignal(settings(), URL))
    h.clockJump = 100
    await advance(1_000)
    expect(h.cancel).not.toHaveBeenCalled()
    expect(h.schedule).toHaveBeenCalledTimes(1)
  })

  it('時計が境の向こうへ跳んだら（リプレイの停止）、予約した音を取り消し、その境は取り直さない', async () => {
    renderHook(() => useTimeSignal(settings(), URL))
    expect(h.schedule).toHaveBeenCalledTimes(1)
    h.clockJump = 20_000
    await advance(1_000)
    expect(h.cancel).toHaveBeenCalledTimes(1)
    expect(h.schedule).toHaveBeenCalledTimes(1)
    await advance(15_000)
    expect(h.speak).not.toHaveBeenCalled()
  })

  it('時計の揺れが続いても、同じ境の取り直しは上限で打ち切って警告する', async () => {
    renderHook(() => useTimeSignal(settings(), URL))
    for (let i = 0; i < 8; i++) {
      h.clockJump = i % 2 === 0 ? 400 : 0
      await advance(1_000)
    }
    // 最初の支度 + 取り直し 3 回まで
    expect(h.schedule.mock.calls.length).toBeLessThanOrEqual(4)
    expect(warnedWith('揺れ続ける')).toBe(true)
  })

  it('時計の確認が実際に止まって境を飛び越えたら、鳴らせなかったことを警告する', async () => {
    // 境の 2 分前。支度の窓（75 秒）の外
    vi.setSystemTime(new Date(2026, 10, 4, 15, 58, 0))
    let perfJump = 0
    const realPerf = performance.now.bind(performance)
    const perf = vi.spyOn(performance, 'now').mockImplementation(() => realPerf() + perfJump)
    renderHook(() => useTimeSignal(settings(), URL))
    expect(h.schedule).not.toHaveBeenCalled()
    // 次の確認までに 3 分止まっていた（時計も実際の経過も進んだ）
    h.clockJump = 180_000
    perfJump = 180_000
    await advance(1_000)
    expect(warnedWith('鳴らせなかった')).toBe(true)
    perf.mockRestore()
  })

  it('時計だけが跳んだとき（リプレイの停止・較正の切り替え）は、鳴らせなかったと警告しない', async () => {
    vi.setSystemTime(new Date(2026, 10, 4, 15, 58, 0))
    renderHook(() => useTimeSignal(settings(), URL))
    h.clockJump = 180_000
    await advance(1_000)
    expect(warnedWith('鳴らせなかった')).toBe(false)
  })

  it('境の 75 秒前には支度が始まる（タブが裏に回って 1 分に 1 回しか起きなくても窓に入る）', async () => {
    vi.setSystemTime(new Date(2026, 10, 4, 15, 58, 50))
    renderHook(() => useTimeSignal(settings(), URL))
    expect(h.schedule).toHaveBeenCalledTimes(1)
  })

  it('音声出力が止まっていれば飛ばし、続く間の警告は 1 回だけ', async () => {
    h.ctxState = 'suspended'
    renderHook(() => useTimeSignal(settings({ timeSignalIntervalMin: 5 }), URL))
    await advance(5 * 60_000)
    expect(h.schedule).not.toHaveBeenCalled()
    const n = warn.mock.calls.filter((c: unknown[]) => c.some(a => typeof a === 'string' && a.includes('音声出力がまだ使えない'))).length
    expect(n).toBe(1)
  })

  it('読み上げが先なら、合成した長さから逆算してピッの前に読み終わる', async () => {
    renderHook(() => useTimeSignal(settings({ timeSignalOrder: 'speechFirst' }), URL))
    // 声 1.2 秒・前置き 3 秒・間 0.3 秒 → 境の 4.5 秒前に読み始める（今から 5.5 秒後）
    await advance(5_400)
    expect(h.speak).not.toHaveBeenCalled()
    await advance(200)
    expect(h.speak).toHaveBeenCalledTimes(1)
  })

  describe('端末の声（システムの読み上げ）で読みが先', () => {
    it('正: 1 分前に黙って測った長さから逆算してピッの前に読み終わり、VOICEVOX へは合成を頼まない', async () => {
      h.systemVoice = true
      renderHook(() => useTimeSignal(settings({ timeSignalOrder: 'speechFirst', ttsVoice: 'system' }), URL))
      // 境まで 10 秒（1 分前はもう過ぎている）ので、すぐ測る
      await advance(10)
      expect(h.measure).toHaveBeenCalledWith('16時です')
      // 声 1.0 秒・前置き 3 秒・間 0.3 秒 → 境の 4.3 秒前に読み始める（今から 5.7 秒後）
      await advance(5_600)
      expect(h.speak).not.toHaveBeenCalled()
      await advance(200)
      expect(h.speak).toHaveBeenCalledTimes(1)
      expect(h.prewarm).not.toHaveBeenCalled()
    })

    it('対照: 測れなかった回は、音が先にする（音が鳴り終わってから読む）', async () => {
      h.systemVoice = true
      h.measureSec = null
      renderHook(() => useTimeSignal(settings({ timeSignalOrder: 'speechFirst', ttsVoice: 'system' }), URL))
      await advance(10_000 + 1_400)
      expect(h.speak).not.toHaveBeenCalled()
      await advance(200)
      expect(h.speak).toHaveBeenCalledTimes(1)
    })

    it('安全弁: 他の読み上げの最中なら測らない（測る発話が読み上げを待たせない）', async () => {
      h.systemVoice = true
      h.busy = true
      renderHook(() => useTimeSignal(settings({ timeSignalOrder: 'speechFirst', ttsVoice: 'system' }), URL))
      await advance(15_000)
      expect(h.measure).not.toHaveBeenCalled()
      expect(h.speak).not.toHaveBeenCalled()
    })
  })

  it('切ると、支度した予約を取り消す', async () => {
    const { rerender } = renderHook(({ s }) => useTimeSignal(s, URL), { initialProps: { s: settings() } })
    expect(h.schedule).toHaveBeenCalledTimes(1)
    rerender({ s: settings({ timeSignalEnabled: false }) })
    expect(h.cancel).toHaveBeenCalledTimes(1)
    await advance(15_000)
    expect(h.speak).not.toHaveBeenCalled()
  })

  it('録画ツール向けの記録に、音は鳴り始めに、声は始まりと終わりを載せる', async () => {
    const { peekReplayEvents } = await import('../utils/replayEventLog')
    const before = peekReplayEvents().events.length
    renderHook(() => useTimeSignal(settings(), URL))
    // 予約した時点では載せない（最初のピッは境の 3 秒前 = 今から 7 秒後）
    expect(peekReplayEvents().events.length).toBe(before)
    await advance(7_100)
    const sound = peekReplayEvents().events.slice(before).filter(e => e.type === 'sound')
    expect(sound).toHaveLength(1)
    expect(sound[0]).toMatchObject({ sound: 'timeSignal', telegram: null })
    await advance(5_000)
    const speech = peekReplayEvents().events.slice(before).filter(e => e.type === 'speechStart' || e.type === 'speechEnd')
    expect(speech.map(e => e.type)).toEqual(['speechStart', 'speechEnd'])
    expect(speech[0]).toMatchObject({ topic: 'timeSignal', telegram: null, text: '16時です' })
  })

  it('同じ境を二度鳴らさない', async () => {
    renderHook(() => useTimeSignal(settings(), URL))
    await advance(30_000)
    expect(h.schedule).toHaveBeenCalledTimes(1)
    expect(h.speak).toHaveBeenCalledTimes(1)
  })
})
