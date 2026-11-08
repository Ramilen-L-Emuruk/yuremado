// @vitest-environment jsdom
//
// 端末の声（Web Speech API）で読む経路（→ `voicevox.ts` の `speakWithSystemVoice`）。
// 声を「システムの読み上げ」にしたとき・VOICEVOX に繋がらないときに、読み上げの流れ（既読・追従・割り込み・取り下げ）が
// VOICEVOX と同じ約束を守るかを見る。`speechSynthesis` は偽物に差し替え、鳴り始めと終わりをタイマーで起こす。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  speakWithVoicevox, stopSpeech, isAudioPlaying, prewarmVoicevox, setSpeechVoice, splitIntoSystemSentences, splitIntoChunks,
  measureSystemSpeechSec, clearVoicevoxDown, SYSTEM_SPEECH_MEASURE_MARGIN_SEC,
  __resetSpeechVoiceForTest, __resetAudioPlaybackStateForTest,
} from './voicevox'
import {
  SYSTEM_SPEECH_RATE, pickJapaneseVoice, speakSystemUtterance, unlockSystemSpeech, __resetSystemSpeechForTest,
} from './systemSpeech'

vi.mock('./ttsPhraseBreakDict', () => ({
  loadTtsPhraseBreakDict: () => Promise.resolve(null),
  getTtsPhraseBreakDictCache: () => null,
  findPhraseBreakMatch: () => null,
  isPlaceNameKey: () => false,
}))
vi.mock('./ttsStationReadings', async (importOriginal) => ({
  ...await importOriginal<typeof import('./ttsStationReadings')>(),
  loadTtsStationReadings: () => Promise.resolve({}),
  getTtsStationReadingsCache: () => null,
}))
vi.mock('./ttsEpicenterAccents', () => ({
  loadTtsEpicenterAccents: async () => ({}),
  getTtsEpicenterAccentsCache: () => null,
}))
const ctx = {
  currentTime: 0,
  state: 'running',
  resume: () => Promise.resolve(),
  createGain: () => ({ gain: { value: 0 }, connect: () => {} }),
  createBufferSource: () => { throw new Error('VOICEVOX の音を鳴らそうとした') },
  decodeAudioData: () => Promise.reject(new Error('合成していない')),
}
vi.mock('./alertSound', () => ({
  getAudioContext: () => ctx,
  getMasterInput: () => ({}),
  syncKeepAlive: () => {},
}))

/** 1 つの発話が鳴る時間（ms） */
const UTTER_MS = 300

class FakeUtterance {
  text: string
  lang = ''
  rate = 1
  volume = 1
  voice: unknown = null
  onstart: (() => void) | null = null
  onend: (() => void) | null = null
  onerror: ((ev: { error: string }) => void) | null = null
  constructor(text: string) { this.text = text }
}

/** 鳴らした発話（鳴り始めた順） */
let started: FakeUtterance[] = []
let current: FakeUtterance | null = null
let queue: FakeUtterance[] = []
let endTimer: ReturnType<typeof setTimeout> | undefined

function startNext(): void {
  const next = queue.shift()
  if (!next) { current = null; return }
  current = next
  setTimeout(() => {
    if (current !== next) return
    started.push(next)
    next.onstart?.()
    endTimer = setTimeout(() => {
      if (current !== next) return
      next.onend?.()
      startNext()
    }, UTTER_MS)
  }, 0)
}

const fakeSynth = {
  // 声の一覧は最初から埋まっている（空の一覧を待つ経路は別のテストで見る）
  getVoices: () => [{ name: 'Microsoft Haruka Desktop', lang: 'ja-JP', localService: true }] as unknown[],
  speak: (u: FakeUtterance) => { queue.push(u); if (current === null) startNext() },
  cancel: () => {
    clearTimeout(endTimer)
    const was = current
    const waiting = queue
    current = null
    queue = []
    if (was) setTimeout(() => was.onerror?.({ error: 'interrupted' }), 0)
    for (const u of waiting) setTimeout(() => u.onerror?.({ error: 'canceled' }), 0)
  },
}

let fetchCalls = 0

beforeEach(() => {
  vi.useFakeTimers()
  started = []
  current = null
  queue = []
  fetchCalls = 0
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
  Object.defineProperty(window, 'speechSynthesis', { value: fakeSynth, configurable: true })
  // VOICEVOX は繋がらない（未起動のときの fetch の失敗）
  vi.stubGlobal('fetch', vi.fn(() => { fetchCalls++; return Promise.reject(new TypeError('Failed to fetch')) }))
  __resetSpeechVoiceForTest()
  __resetAudioPlaybackStateForTest()
  __resetSystemSpeechForTest()
})

afterEach(() => {
  stopSpeech()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  // 「鳴り始めない」の差し替え（speak を黙らせる）を次のテストへ持ち越さない
  vi.restoreAllMocks()
})

const URL_OK = 'http://localhost:50021'
const TEXT = '震度3以上の揺れを観測しました。震源は石川県能登地方です。'

describe('声を「システムの読み上げ」にしたとき', () => {
  it('正: VOICEVOX へは繋がず、チャンクごとに 1.1 倍の端末の声で読み、全チャンクを鳴ったと返す', async () => {
    setSpeechVoice('system')
    const scheduled: number[] = []
    const p = speakWithVoicevox(URL_OK, TEXT, 1, 0.5, undefined, null, i => { scheduled.push(i) })
    await vi.advanceTimersByTimeAsync(5000)
    const outcome = await p
    const chunks = splitIntoSystemSentences(TEXT)
    expect(fetchCalls).toBe(0)
    expect(started.map(u => u.text)).toEqual(chunks)
    expect(started.every(u => u.rate === SYSTEM_SPEECH_RATE && u.lang === 'ja-JP' && u.volume === 0.5)).toBe(true)
    expect(outcome).toEqual({ spoke: true, spokenChunks: chunks })
    expect(scheduled).toEqual(chunks.map((_, i) => i))
  })

  it('正: 鳴っている間は「音が出ている」と答え、鳴り終われば答えない', async () => {
    setSpeechVoice('system')
    const p = speakWithVoicevox(URL_OK, '震度3以上の揺れを観測しました。', 1, 1)
    await vi.advanceTimersByTimeAsync(10)
    expect(isAudioPlaying()).toBe(true)
    await vi.advanceTimersByTimeAsync(5000)
    await p
    expect(isAudioPlaying()).toBe(false)
  })

  it('正: 先行合成は投げない（null を返す）', () => {
    setSpeechVoice('system')
    expect(prewarmVoicevox(URL_OK, TEXT, 1)).toBeNull()
    expect(fetchCalls).toBe(0)
  })

  it('安全弁: 割り込まれたら残りは読まず、途中で止まった文は既読に数えない（鳴り始めたことは spoke で返す）', async () => {
    setSpeechVoice('system')
    const p = speakWithVoicevox(URL_OK, TEXT, 1, 1)
    await vi.advanceTimersByTimeAsync(10)
    stopSpeech()
    await vi.advanceTimersByTimeAsync(5000)
    const outcome = await p
    expect(outcome).toEqual({ spoke: true, spokenChunks: [] })
    expect(started).toHaveLength(1)
  })

  it('対照: 1 文目を読み終えてから割り込まれたら、1 文目だけを既読に数える', async () => {
    setSpeechVoice('system')
    const chunks = splitIntoSystemSentences(TEXT)
    const p = speakWithVoicevox(URL_OK, TEXT, 1, 1)
    await vi.advanceTimersByTimeAsync(UTTER_MS + 50)
    stopSpeech()
    await vi.advanceTimersByTimeAsync(5000)
    expect(await p).toEqual({ spoke: true, spokenChunks: [chunks[0]] })
  })

  it('正: 取り下げの判定を添えた読み上げ（緊急地震速報）は、読点ごとに 1 発話で読む（取り下げを読点で効かせる）', async () => {
    setSpeechVoice('system')
    const text = '緊急地震速報、石川県能登、新潟県上越では強い揺れに警戒してください。'
    const p = speakWithVoicevox(URL_OK, text, 1, 1, () => true)
    await vi.advanceTimersByTimeAsync(20_000)
    await p
    expect(started.map(u => u.text)).toEqual(splitIntoChunks(text))
    expect(started.length).toBeGreaterThan(1)
  })

  it('対照: 取り下げの判定が無い読み上げは、同じ文を 1 発話で読む', async () => {
    setSpeechVoice('system')
    const text = '緊急地震速報、石川県能登、新潟県上越では強い揺れに警戒してください。'
    const p = speakWithVoicevox(URL_OK, text, 1, 1)
    await vi.advanceTimersByTimeAsync(20_000)
    await p
    expect(started.map(u => u.text)).toEqual([text])
  })

  it('安全弁: 鳴らす直前の判定が偽になったら、以降のチャンクを読まない', async () => {
    setSpeechVoice('system')
    const chunks = splitIntoChunks(TEXT)
    let calls = 0
    const p = speakWithVoicevox(URL_OK, TEXT, 1, 1, () => ++calls === 1)
    await vi.advanceTimersByTimeAsync(5000)
    const outcome = await p
    expect(outcome.spokenChunks).toEqual([chunks[0]])
  })

  it('安全弁: 鳴り始めない（操作の前で黙る）ときは見切って、鳴らなかったと返す', async () => {
    setSpeechVoice('system')
    vi.spyOn(fakeSynth, 'speak').mockImplementation(() => { /* 黙る */ })
    const p = speakWithVoicevox(URL_OK, '震度3以上の揺れを観測しました。', 1, 1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await p).toEqual({ spoke: false, spokenChunks: [] })
  })
})

describe('声を VOICEVOX にして、VOICEVOX に繋がらないとき', () => {
  it('対照: 繋がらないと分かる前は、先行合成を VOICEVOX へ投げる', () => {
    expect(prewarmVoicevox(URL_OK, TEXT, 1)).not.toBeNull()
  })

  it('正: その報を端末の声で読み、続く報は VOICEVOX を試さずに端末の声で読む', async () => {
    const p1 = speakWithVoicevox(URL_OK, TEXT, 1, 1)
    await vi.advanceTimersByTimeAsync(20_000)
    const o1 = await p1
    expect(o1.spokenChunks).toEqual(splitIntoSystemSentences(TEXT))
    expect(fetchCalls).toBeGreaterThan(0)

    const before = fetchCalls
    const p2 = speakWithVoicevox(URL_OK, '震度3以上の揺れを観測しました。', 1, 1)
    await vi.advanceTimersByTimeAsync(5000)
    expect((await p2).spoke).toBe(true)
    expect(fetchCalls).toBe(before)
    expect(prewarmVoicevox(URL_OK, TEXT, 1)).toBeNull()
  })

  it('正: 接続先が URL として成り立たなければ、VOICEVOX を試さずに端末の声で読む', async () => {
    const p = speakWithVoicevox('localhost:50021', '震度3以上の揺れを観測しました。', 1, 1)
    await vi.advanceTimersByTimeAsync(5000)
    expect((await p).spoke).toBe(true)
    expect(fetchCalls).toBe(0)
  })

  it('安全弁: 印は解く口（設定を直した・試聴）で解け、次の報から VOICEVOX を試す', async () => {
    const p1 = speakWithVoicevox(URL_OK, '震度3以上の揺れを観測しました。', 1, 1)
    await vi.advanceTimersByTimeAsync(20_000)
    await p1
    clearVoicevoxDown()
    const before = fetchCalls
    const p2 = speakWithVoicevox(URL_OK, '震度3以上の揺れを観測しました。', 1, 1)
    await vi.advanceTimersByTimeAsync(20_000)
    await p2
    expect(fetchCalls).toBeGreaterThan(before)
  })

  it('対照: 別の接続先には印が効かない（接続先を変えたらすぐ試す）', async () => {
    const p1 = speakWithVoicevox(URL_OK, '震度3以上の揺れを観測しました。', 1, 1)
    await vi.advanceTimersByTimeAsync(20_000)
    await p1
    const before = fetchCalls
    const p2 = speakWithVoicevox('http://192.0.2.1:50021', '震度3以上の揺れを観測しました。', 1, 1)
    await vi.advanceTimersByTimeAsync(20_000)
    await p2
    expect(fetchCalls).toBeGreaterThan(before)
  })

  it('安全弁: 1 分たてば VOICEVOX をもう一度試す', async () => {
    const p1 = speakWithVoicevox(URL_OK, '震度3以上の揺れを観測しました。', 1, 1)
    await vi.advanceTimersByTimeAsync(20_000)
    await p1
    await vi.advanceTimersByTimeAsync(61_000)
    const before = fetchCalls
    const p2 = speakWithVoicevox(URL_OK, '震度3以上の揺れを観測しました。', 1, 1)
    await vi.advanceTimersByTimeAsync(20_000)
    await p2
    expect(fetchCalls).toBeGreaterThan(before)
  })
})

describe('1 発話の部品（speakSystemUtterance）', () => {
  it('安全弁: 鳴り始めない発話を見切っても、その後に渡した別の発話は止めない', async () => {
    // 1 本目は黙る（onstart が来ない）。2 本目は鳴る
    const speak = vi.spyOn(fakeSynth, 'speak')
    speak.mockImplementationOnce(() => { /* 黙る */ })
    const first = speakSystemUtterance('一本目', 1, () => {})
    await vi.advanceTimersByTimeAsync(10)
    // 1 本目が見切られる前に 2 本目を渡す（1 本目は「止めた」で終わる）
    const second = speakSystemUtterance('二本目の文です', 1, () => {})
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await first).toBe('cancelled')
    expect(await second).toBe('ended')
    expect(started.map(u => u.text)).toEqual(['二本目の文です'])
  })

  it('正: 鳴り始めてから壊れたら、最後まで鳴ったとはしない', async () => {
    vi.spyOn(fakeSynth, 'speak').mockImplementationOnce((u: FakeUtterance) => {
      setTimeout(() => { u.onstart?.(); setTimeout(() => u.onerror?.({ error: 'synthesis-failed' }), 50) }, 0)
    })
    const result = speakSystemUtterance('壊れる文', 1, () => {})
    await vi.advanceTimersByTimeAsync(1000)
    expect(await result).toBe('failed')
  })

  it('正: 最初の操作の空の発話が残っていても、本番の発話はすぐ鳴る（空の発話を止めてから渡す）', async () => {
    vi.spyOn(fakeSynth, 'speak').mockImplementationOnce(() => { /* 空の発話は鳴り終わらないまま残る */ })
    unlockSystemSpeech()
    const result = speakSystemUtterance('本番の文です', 1, () => {})
    await vi.advanceTimersByTimeAsync(1000)
    expect(await result).toBe('ended')
  })

  it('対照: 声の一覧が空なら届くまで待ってから渡し、届かなければ 1 秒で見切って渡す。待つのは最初の 1 回だけ', async () => {
    vi.spyOn(fakeSynth, 'getVoices').mockReturnValue([])
    const result = speakSystemUtterance('一覧の無い文', 1, () => {})
    await vi.advanceTimersByTimeAsync(900)
    expect(started).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await result).toBe('ended')
    // 2 本目は待たずに渡す（声が 1 つも無い端末で、チャンクごとに 1 秒遅れない）
    const second = speakSystemUtterance('二本目の文です', 1, () => {})
    await vi.advanceTimersByTimeAsync(10)
    expect(started).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1000)
    await second
  })
})

describe('端末の声の有効化（unlockSystemSpeech）', () => {
  it('正: 操作と数えられない瞬間に渡して鳴らなかった有効化の発話は、1 秒たってからの次の操作で渡し直し、鳴り始めたら以後は要らないと返す', async () => {
    const speak = vi.spyOn(fakeSynth, 'speak')
    speak.mockImplementationOnce(() => { /* iPhone で指が触れた瞬間に渡した形: 鳴り始めない */ })
    expect(unlockSystemSpeech()).toBe(false)
    await vi.advanceTimersByTimeAsync(1100)
    expect(started).toHaveLength(0)
    expect(unlockSystemSpeech()).toBe(false)
    expect(speak).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(10)
    expect(started.map(u => u.text)).toEqual([' '])
    expect(unlockSystemSpeech()).toBe(true)
    expect(speak).toHaveBeenCalledTimes(2)
  })

  it('対照: 渡したばかり（1 秒以内）の有効化の発話は、同じ操作から続けて呼ばれても渡し直さない', async () => {
    const speak = vi.spyOn(fakeSynth, 'speak')
    speak.mockImplementationOnce(() => { /* 鳴り始めない */ })
    unlockSystemSpeech()
    await vi.advanceTimersByTimeAsync(500)
    expect(unlockSystemSpeech()).toBe(false)
    expect(speak).toHaveBeenCalledTimes(1)
  })

  it('安全弁: 本番の発話が一度でも鳴り始めていれば、有効化の発話を渡さずに要らないと返す', async () => {
    const speak = vi.spyOn(fakeSynth, 'speak')
    const result = speakSystemUtterance('本番の文です', 1, () => {})
    await vi.advanceTimersByTimeAsync(10)
    expect(unlockSystemSpeech()).toBe(true)
    expect(speak).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await result).toBe('ended')
  })

  it('安全弁: 本番の発話が持ち主でまだ鳴り始めていないときに呼ばれても、本番を止めない', async () => {
    const speak = vi.spyOn(fakeSynth, 'speak')
    speak.mockImplementationOnce(() => { /* 本番の発話はまだ鳴り始めていない */ })
    const cancel = vi.spyOn(fakeSynth, 'cancel')
    const result = speakSystemUtterance('本番の文です', 1, () => {})
    await vi.advanceTimersByTimeAsync(2000)
    expect(speak).toHaveBeenCalledTimes(1)
    expect(unlockSystemSpeech()).toBe(false)
    expect(speak).toHaveBeenCalledTimes(1)
    expect(cancel).not.toHaveBeenCalled()
    // 本番はそのまま自分の見切り（4 秒）で終わる。有効化には止められていない
    await vi.advanceTimersByTimeAsync(3000)
    expect(await result).toBe('failed')
  })

  it('正: 鳴り始めの知らせが無く終わりだけ来ても（声の無い端末）、有効化は済んだとして以後は渡さない', async () => {
    const speak = vi.spyOn(fakeSynth, 'speak')
    speak.mockImplementationOnce((u: FakeUtterance) => { setTimeout(() => u.onend?.(), 0) })
    expect(unlockSystemSpeech()).toBe(false)
    await vi.advanceTimersByTimeAsync(10)
    expect(unlockSystemSpeech()).toBe(true)
    expect(speak).toHaveBeenCalledTimes(1)
  })

  it('安全弁: 鳴らずに捨てた有効化の発話に後から終わりの知らせが届いても、済んだとは数えず渡し直す', async () => {
    const speak = vi.spyOn(fakeSynth, 'speak')
    let dropped: FakeUtterance | null = null
    speak.mockImplementationOnce((u: FakeUtterance) => { dropped = u /* 鳴り始めない */ })
    unlockSystemSpeech()
    await vi.advanceTimersByTimeAsync(1100)
    speak.mockImplementationOnce(() => { /* 渡し直しも鳴り始めない */ })
    expect(unlockSystemSpeech()).toBe(false)  // 前の発話を捨てて渡し直す
    ;(dropped as FakeUtterance | null)?.onend?.()  // 捨てた発話に遅れて届いた終わり
    await vi.advanceTimersByTimeAsync(1100)
    expect(unlockSystemSpeech()).toBe(false)
    expect(speak).toHaveBeenCalledTimes(3)
  })

  it('正: 見切った後に遅れて鳴り始めても、端末の声は使えるとして以後は有効化しない', async () => {
    let late: FakeUtterance | null = null
    vi.spyOn(fakeSynth, 'speak').mockImplementationOnce((u: FakeUtterance) => { late = u })
    const result = speakSystemUtterance('本番の文です', 1, () => {})
    await vi.advanceTimersByTimeAsync(4100)
    expect(await result).toBe('failed')
    ;(late as FakeUtterance | null)?.onstart?.()
    expect(unlockSystemSpeech()).toBe(true)
  })

  it('対照: 有効化の発話が失敗で終わった直後（1 秒以内）の操作では渡し直さない', async () => {
    const speak = vi.spyOn(fakeSynth, 'speak')
    speak.mockImplementationOnce((u: FakeUtterance) => { setTimeout(() => u.onerror?.({ error: 'not-allowed' }), 0) })
    unlockSystemSpeech()
    await vi.advanceTimersByTimeAsync(10)
    expect(unlockSystemSpeech()).toBe(false)
    expect(speak).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1100)
    unlockSystemSpeech()
    expect(speak).toHaveBeenCalledTimes(2)
  })

  it('安全弁: 鳴り始めも終わりも来ない環境でも打ち止めにせず、1 秒空けた操作のたびに試し続ける（使えないまま止まらない）', async () => {
    const speak = vi.spyOn(fakeSynth, 'speak').mockImplementation(() => { /* 何も起きない */ })
    for (let i = 0; i < 7; i++) {
      expect(unlockSystemSpeech()).toBe(false)
      await vi.advanceTimersByTimeAsync(1100)
    }
    expect(speak).toHaveBeenCalledTimes(7)
  })
})

describe('端末の声で声の長さを測る（measureSystemSpeechSec）', () => {
  it('正: 音量 0 で 2 回読み、2 回目の長さに余裕を足して返す', async () => {
    const p = measureSystemSpeechSec('16時です')
    await vi.advanceTimersByTimeAsync(5000)
    const sec = await p
    expect(started).toHaveLength(2)
    expect(started.every(u => u.volume === 0)).toBe(true)
    expect(sec).toBeCloseTo(UTTER_MS / 1000 + SYSTEM_SPEECH_MEASURE_MARGIN_SEC, 1)
  })

  it('正: 同じ文はもう一度測らない（時報のたびに無音の合成を重ねない）', async () => {
    const p1 = measureSystemSpeechSec('16時です')
    await vi.advanceTimersByTimeAsync(5000)
    await p1
    const p2 = measureSystemSpeechSec('16時です')
    await vi.advanceTimersByTimeAsync(5000)
    expect(await p2).toBe(await p1)
    expect(started).toHaveLength(2)
  })

  it('安全弁: 読み終わりの知らせが来ず見切った回は測れなかったとし、見切った時間を長さとして覚えない', async () => {
    // 鳴り始めるが onend を出さない発話（Chrome が onend を落とす形）
    const speak = vi.spyOn(fakeSynth, 'speak').mockImplementation((u: FakeUtterance) => { setTimeout(() => u.onstart?.(), 0) })
    const p1 = measureSystemSpeechSec('16時です')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await p1).toBeNull()
    speak.mockRestore()
    // 次は測り直す（覚えていない）
    const p2 = measureSystemSpeechSec('16時です')
    await vi.advanceTimersByTimeAsync(5000)
    expect(await p2).not.toBeNull()
  })

  it('正: 読み上げ本体と同じく文ごとに 1 発話で測る（2 文なら 1 回に 2 発話、2 回で 4 発話）', async () => {
    const text = '16時をお知らせします。ただいまの時刻です。'
    const p = measureSystemSpeechSec(text)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await p).not.toBeNull()
    expect(started.map(u => u.text)).toEqual([...splitIntoSystemSentences(text), ...splitIntoSystemSentences(text)])
    expect(started).toHaveLength(4)
  })

  it('安全弁: 測っている間に読み上げが始まったら打ち切り、null を返して読み上げを鳴らす', async () => {
    setSpeechVoice('system')
    const m = measureSystemSpeechSec('16時です')
    await vi.advanceTimersByTimeAsync(10)
    const speech = speakWithVoicevox(URL_OK, '震度3以上の揺れを観測しました。', 1, 1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await m).toBeNull()
    expect((await speech).spoke).toBe(true)
  })
})

describe('端末の声の区切り（splitIntoSystemSentences）', () => {
  it('正: 読点では分けず、文（。）ごとにまとめる', () => {
    expect(splitIntoSystemSentences('緊急地震速報、三陸沖で地震。強い揺れに警戒してください。'))
      .toEqual(['緊急地震速報、三陸沖で地震。', '強い揺れに警戒してください。'])
  })
  it('正: 句読点の直後に空白（電文の改行）があっても、各要素は元の文をそのまま切り出したもの（追従が元の文の中を探せる）', () => {
    const text = '揺れの強い地域、 宮城県北部、 岩手県南部。 津波の心配はありません。'
    const parts = splitIntoSystemSentences(text)
    expect(parts).toEqual(['揺れの強い地域、 宮城県北部、 岩手県南部。', '津波の心配はありません。'])
    expect(parts.every(p => text.includes(p))).toBe(true)
  })
  it('正: 閉じ括弧だけの断片は単独の発話にせず、前の文に付ける', () => {
    expect(splitIntoSystemSentences('「強い揺れに警戒してください。」と発表しました。'))
      .toEqual(['「強い揺れに警戒してください。」', 'と発表しました。'])
  })
  it('正: 文の後ろに続く句点・閉じ括弧だけの断片（！？・。。・。」。）は単独の発話にせず、前の文に付ける', () => {
    expect(splitIntoSystemSentences('本当ですか！？次の文です。')).toEqual(['本当ですか！？', '次の文です。'])
    expect(splitIntoSystemSentences('揺れました。。次の文です。')).toEqual(['揺れました。。', '次の文です。'])
    expect(splitIntoSystemSentences('「警戒してください。」。次の文です。')).toEqual(['「警戒してください。」。', '次の文です。'])
  })
  it('安全弁: 80 字を超える文は読点で分け、継ぐと元の文に戻る（Chrome が長い発話を切るため）', () => {
    const long = Array.from({ length: 12 }, (_, i) => `地域${i}は震度三、 `).join('') + '以上です。'
    const parts = splitIntoSystemSentences(long)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every(p => p.length <= 80)).toBe(true)
    expect(parts.every(p => long.includes(p))).toBe(true)
    expect(parts.join(' ')).toBe(long)
  })
  it('対照: 80 字ちょうどの文は分けない', () => {
    const exact = 'あ'.repeat(40) + '、' + 'い'.repeat(38) + '。'
    expect(exact.length).toBe(80)
    expect(splitIntoSystemSentences(exact)).toEqual([exact])
  })
  it('対照: 句点の無い文はそのまま 1 つ・空の文は 0 個', () => {
    expect(splitIntoSystemSentences('16時です')).toEqual(['16時です'])
    expect(splitIntoSystemSentences('')).toEqual([])
  })
})

describe('pickJapaneseVoice', () => {
  const v = (name: string, lang: string, localService = true) => ({ name, lang, localService }) as SpeechSynthesisVoice
  it('正: Haruka・Kyoko を先に選び、端末の中で動く声を優先する', () => {
    expect(pickJapaneseVoice([v('Microsoft Ayumi', 'ja-JP'), v('Microsoft Haruka Online', 'ja-JP', false), v('Microsoft Haruka Desktop', 'ja-JP')])?.name)
      .toBe('Microsoft Haruka Desktop')
    expect(pickJapaneseVoice([v('Eddy', 'ja-JP'), v('Kyoko', 'ja_JP')])?.name).toBe('Kyoko')
  })
  it('対照: 選んだ名前が無ければ日本語の声のどれか、日本語が無ければ null', () => {
    expect(pickJapaneseVoice([v('Samantha', 'en-US'), v('Ayumi', 'ja-JP')])?.name).toBe('Ayumi')
    expect(pickJapaneseVoice([v('Samantha', 'en-US')])).toBeNull()
  })
})
