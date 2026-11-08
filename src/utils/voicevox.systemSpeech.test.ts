// @vitest-environment jsdom
//
// 端末の声（Web Speech API）で読む経路（→ `voicevox.ts` の `speakWithSystemVoice`）。
// 声を「システムの読み上げ」にしたとき・VOICEVOX に繋がらないときに、読み上げの流れ（既読・追従・割り込み・取り下げ）が
// VOICEVOX と同じ約束を守るかを見る。`speechSynthesis` は偽物に差し替え、鳴り始めと終わりをタイマーで起こす。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  speakWithVoicevox, stopSpeech, isAudioPlaying, prewarmVoicevox, setSpeechVoice, splitIntoChunks,
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
    const chunks = splitIntoChunks(TEXT)
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

  it('安全弁: 割り込まれたら、鳴り始めていたチャンクまでを鳴ったと返し、残りは読まない', async () => {
    setSpeechVoice('system')
    const chunks = splitIntoChunks(TEXT)
    const p = speakWithVoicevox(URL_OK, TEXT, 1, 1)
    await vi.advanceTimersByTimeAsync(10)
    stopSpeech()
    await vi.advanceTimersByTimeAsync(5000)
    const outcome = await p
    expect(outcome).toEqual({ spoke: true, spokenChunks: [chunks[0]] })
    expect(started).toHaveLength(1)
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
    expect(o1.spokenChunks).toEqual(splitIntoChunks(TEXT))
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
