// リプレイ中の投機的先行合成が組む文（`speechPrefetch.ts`）。
//
// **この仕掛けの存在理由は「投機した文が、本番の読み上げとチャンクを共有すること」**。
// 共有していなければ控えは一度も当たらず、症状は「なんとなく速くならない」だけで
// 画面にもログにも出ない。だから固定するのはそこを中心に据える。
//
// 正・対照・安全弁の分担:
//   正   ＝ 状態に依らない文は、本番と 1 文字も違わない
//   対照 ＝ 読み上げない電文からは何も作らない
//   安全弁＝ 電文が壊れていても投機で再生を壊さない
import { describe, it, expect } from 'vitest'
import { speculativeSpeechTexts, speculativeSpeechTextsSafe } from './speechPrefetch'
import { tsunamiPartialRetractionToText, telegramTextToSpeak, nankaiToText, nankaiCommentaryToText, kohatsuToText, earthquakeCountToText, quakeNoticeToText, lpgmToText, estimatedIntensityToText, type TtsSpeechOptions } from './ttsText'
import { splitIntoChunks } from './voicevox'
// テストボタンと同じ電文（→ `utils/testTelegramScripts.ts`）。**実電文をパーサーへ通したもの**で、
// 本番の読み上げが受け取るのと同じ形になる。
//
// **トップレベルで読む。** テスト本体の中で初めて読むと、電文の読み込みが 1 件目の所要時間に
// 乗って時間切れになる（→ CLAUDE.md「テスト本体の中で対象モジュールを初めて読まないこと」）。
import {
  first, telegramNankais, telegramCommentaries, telegramKohatsus,
  telegramCounts, telegramNotices, telegramEews, telegramLpgms, telegramQuakes,
} from '../test-utils/testTelegramFixtures'

const nankai = first(await telegramNankais('NANKAI_WATCH'), '南海トラフ臨時情報')
const commentary = first(await telegramCommentaries('NANKAI_COMMENTARY_AD_HOC'), '南海トラフ関連解説情報')
const kohatsu = first(await telegramKohatsus('KOHATSU'), '後発地震注意情報')
const earthquakeCount = first(await telegramCounts('EARTHQUAKE_COUNT'), '地震回数に関する情報')
const quakeNotice = first(await telegramNotices('QUAKE_NOTICE'), '地震・津波に関するお知らせ')
const eewWarning = first((await telegramEews('EEW_WARNING')).filter(e => e.severity === 'Warning'), '緊急地震速報（警報）')
const lpgm = first(await telegramLpgms('EARTHQUAKE'), '長周期地震動に関する観測情報')
const quake = first(await telegramQuakes('EARTHQUAKE'), '地震情報')
import type { ReplayPayload } from '../types/replay'
import type { JMAEstimatedIntensity } from '../types/earthquake'

/**
 * 既定の読み上げオプション（設定を何も触っていない状態に相当）。
 *
 * 値は `useSettings.ts` の `DEFAULTS` に揃えてある。**`ttsRegionOptions` を呼ばないのは、
 * あれが `AppSettings` 全体を要求するため** —— この検証に要るのは読み上げの詳しさだけ。
 */
const OPTS: TtsSpeechOptions = {
  intensityLevels: 2,
  maxRegions: 10,
  alwaysReadScale: 30,
  alwaysReadLpgmClass: 1,
  regionTolerance: 2,
}

/**
 * 気象庁が書いた文まで読む設定。
 *
 * **既定（`ttsReadTelegramText`）は偽**なので、この文が声になるのは設定を入れた利用者だけ。
 * 投機がいちばん効くのはここ（本文が数十チャンクになる）なので、その形で固定しておく。
 */
const OPTS_WITH_TELEGRAM_TEXT: TtsSpeechOptions = { ...OPTS, readTelegramText: true }

describe('状態に依らない電文は、本番と同じ文を先に作れる', () => {
  // **ここが投機の柱。** 南海トラフ解説の本文は 1721 字＝65 チャンクあり、合成が再生に
  // 追いつかなくなるのはまさにこの長さの文。1 文字でもずれると控えが当たらない。
  it('南海トラフ地震関連解説情報：本番の文と完全に一致する（正）', () => {
    const data = commentary
    const payload: ReplayPayload = { kind: 'nankaiCommentary', data }
    expect(speculativeSpeechTexts(payload, OPTS)).toContain(nankaiCommentaryToText(data))
  })

  it('南海トラフ地震臨時情報：本番の文と完全に一致する（正）', () => {
    const data = nankai
    const payload: ReplayPayload = { kind: 'nankai', data }
    expect(speculativeSpeechTexts(payload, OPTS)).toContain(nankaiToText(data))
  })

  it('後発地震注意情報：本番の文と完全に一致する（正）', () => {
    const data = kohatsu
    const payload: ReplayPayload = { kind: 'kohatsu', data }
    expect(speculativeSpeechTexts(payload, OPTS)).toContain(kohatsuToText(data))
  })

  it('地震回数に関する情報：本番の文と完全に一致する（正）', () => {
    const data = earthquakeCount
    const payload: ReplayPayload = { kind: 'earthquakeCount', data }
    expect(speculativeSpeechTexts(payload, OPTS)).toContain(earthquakeCountToText(data))
  })

  // 気象庁が書いた文は本体とは別の発話として最下位の層で読まれる（→ audio-tts-spec.md §6）。
  // **別々に焼くこと**が要る —— 1 つへ繋ぐと、実際に鳴るときのチャンクの割れ目が変わる。
  it('気象庁が書いた文を、本体とは別の文として作る（正）', () => {
    const data = nankai
    const payload: ReplayPayload = { kind: 'nankai', data }
    const expected = telegramTextToSpeak({ kind: 'nankai', data }, OPTS_WITH_TELEGRAM_TEXT)?.text
    expect(expected).toBeTruthy()
    const texts = speculativeSpeechTexts(payload, OPTS_WITH_TELEGRAM_TEXT)
    expect(texts).toContain(expected)
    // 本体と繋がっていない（別の要素として並ぶ）
    expect(texts.length).toBeGreaterThan(1)
  })

  // **設定で切られているものは焼かない（対照）。** 焼いても一度も使われないので、
  // その分だけ控えを圧迫して本当に要るチャンクを追い出す。
  it('気象庁の文を読まない設定なら、その文は作らない（対照）', () => {
    const data = nankai
    const withText = speculativeSpeechTexts({ kind: 'nankai', data }, OPTS_WITH_TELEGRAM_TEXT)
    const without = speculativeSpeechTexts({ kind: 'nankai', data }, OPTS)
    expect(without.length).toBeLessThan(withText.length)
  })
})

describe('チャンクの一致', () => {
  // 控えの鍵はチャンクなので、**文が一致すれば割れ方も一致する**。ここを固定しておけば、
  // 将来チャンクの割り方を変えたときに投機と本番がずれていないことを確かめられる。
  it('投機した文を割ると、本番の文を割ったものと同じ並びになる（正）', () => {
    const data = commentary
    const spec = speculativeSpeechTexts({ kind: 'nankaiCommentary', data }, OPTS)
    const real = nankaiCommentaryToText(data)
    const specChunks = spec.flatMap(t => splitIntoChunks(t))
    for (const chunk of splitIntoChunks(real)) {
      expect(specChunks).toContain(chunk)
    }
  })

  // **合成が再生に追いつかなくなるのは、この長さの文。** 本体（名乗りと要約）は短く、
  // 長いのは気象庁が書いた本文のほう ―― そしてそれは状態に依らないので、投機で完全に当たる。
  it('気象庁が書いた本文は数十チャンクになり、投機がそれを丸ごと覆う（正）', () => {
    const data = commentary
    const body = telegramTextToSpeak({ kind: 'nankaiCommentary', data }, OPTS_WITH_TELEGRAM_TEXT)?.text
    expect(body).toBeTruthy()
    const bodyChunks = splitIntoChunks(body as string)
    // 1〜2 チャンクしか出ないなら、テストデータが実電文の形から外れている
    // （→ CLAUDE.md「実電文の形に合わせる」）。
    expect(bodyChunks.length).toBeGreaterThan(10)

    // その全チャンクが投機の対象に入る
    const spec = speculativeSpeechTexts({ kind: 'nankaiCommentary', data }, OPTS_WITH_TELEGRAM_TEXT)
    const specChunks = spec.flatMap(t => splitIntoChunks(t))
    for (const chunk of bodyChunks) {
      expect(specChunks).toContain(chunk)
    }
  })
})

describe('地震・津波に関するお知らせ', () => {
  // 読み上げは設定で有効にしたときだけだが、投機は種別ごとの設定を見ない（解説情報と同じ）。
  it('見出しの文を焼く', () => {
    const data = quakeNotice
    expect(speculativeSpeechTexts({ kind: 'quakeNotice', data }, OPTS)).toEqual([quakeNoticeToText(data)])
  })

  it('気象庁の文を読む設定なら本文も焼く', () => {
    const data = quakeNotice
    const texts = speculativeSpeechTexts({ kind: 'quakeNotice', data }, OPTS_WITH_TELEGRAM_TEXT)
    expect(texts).toHaveLength(2)
    expect(texts[1]).toContain('沖縄県本庁舎の電力設備点検')
  })
})

describe('読み上げない電文', () => {
  // 緊急地震速報の固定付加文は読まない（秒を争うため）。第 1 フェーズの文だけが出る。
  it('緊急地震速報：第 1 フェーズの文は作るが、固定付加文は作らない（対照）', () => {
    const event = eewWarning
    const texts = speculativeSpeechTexts({ kind: 'event', event }, OPTS)
    expect(texts.length).toBe(1)
    expect(texts[0]).toContain('で地震。')
  })

  // **区分を選ばないでよい理由の固定。** 切り出し語（「緊急地震速報、」等）は 3 通りとも
  // 独立したチャンクになり、起動時の作り置きが既に焼いている。残る「〇〇で地震。」は
  // 区分に依らず同じなので、どれか 1 つで焼けば足りる。
  it('緊急地震速報：震源の句は区分に依らず同じチャンクになる（安全弁）', () => {
    const event = eewWarning
    const texts = speculativeSpeechTexts({ kind: 'event', event }, OPTS)
    const chunks = splitIntoChunks(texts[0])
    // 先頭は切り出し語、その後ろが震源の句
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks[chunks.length - 1]).toMatch(/で地震。$/)
    expect(chunks[chunks.length - 1]).not.toContain('緊急地震速報')
  })
})

// 真偽 1 つで文頭が変わるものは、**両方とも焼く**。分岐に投機の精度を賭ける理由がなく、
// 外した側の損は控えの 1 件ぶんに収まる。
describe('真偽 1 つで変わる文は 2 通りとも作る', () => {
  it('長周期地震動：初報・続報の両方を作る（正）', () => {
    const data = lpgm
    const texts = speculativeSpeechTexts({ kind: 'lpgm', data }, OPTS)
    expect(texts).toContain(lpgmToText(data, OPTS, true))
    expect(texts).toContain(lpgmToText(data, OPTS, false))
  })

  it('推計震度分布図：初報・続報の両方を作る（正）', () => {
    const arrivalTime = '2024-01-01T16:10:00+09:00'
    const data = { arrivalTime } as unknown as JMAEstimatedIntensity
    const texts = speculativeSpeechTexts({ kind: 'estimatedIntensity', data }, OPTS)
    expect(texts).toContain(estimatedIntensityToText(arrivalTime, true))
    expect(texts).toContain(estimatedIntensityToText(arrivalTime, false))
    // 文頭が違うので 2 通りとも並ぶ（同じ文なら 1 つに畳まれてしまう）
    expect(new Set(texts).size).toBe(2)
  })
})

// 取消は本体が理由を読む（付加文は添えない）。**分岐を間違えると投機が空になる**が、
// 症状は「取消の読み上げだけ控えが当たらない」で、聞いても気づけない。
describe('取消の報', () => {
  it('地震の取消：取消の文を作る（正）', () => {
    const base = quake
    const cancelled = { ...base, cancelled: true, cancelText: '先ほどの地震情報を取り消します。' }
    const texts = speculativeSpeechTexts({ kind: 'event', event: cancelled }, OPTS)
    expect(texts.length).toBeGreaterThan(0)
    expect(texts.some(t => t.includes('取り消'))).toBe(true)
  })

  it('地震の発表報：取消の文は作らない（対照）', () => {
    const base = quake
    const texts = speculativeSpeechTexts({ kind: 'event', event: base }, OPTS)
    expect(texts.length).toBeGreaterThan(0)
    expect(texts.some(t => t.includes('取り消'))).toBe(false)
  })
})

describe('投機で再生を壊さない', () => {
  // **1 通ずつ受け止める。** ここが投げると、覗いた電文の並びごと処理が止まって
  // 以降の投機が走らなくなる。実データにしか無い形は必ずあるので、落ちても次へ進む。
  it('文を組む途中で例外が出ても、空を返して次へ進む（安全弁）', () => {
    // `data` が欠けた電文（型の上ではありえないが、実データの取り違えでは起こりうる）
    const broken = { kind: 'nankai', data: undefined } as unknown as ReplayPayload
    expect(() => speculativeSpeechTextsSafe(broken, OPTS)).not.toThrow()
    expect(speculativeSpeechTextsSafe(broken, OPTS)).toEqual([])
  })

  it('壊れていない電文なら、安全側の入口でも同じ結果を返す（対照）', () => {
    const data = kohatsu
    const payload: ReplayPayload = { kind: 'kohatsu', data }
    expect(speculativeSpeechTextsSafe(payload, OPTS)).toEqual(speculativeSpeechTexts(payload, OPTS))
  })
})

describe('津波情報だけの取消', () => {
  const retraction = {
    kind: 'tsunami', id: 'r-1', eventId: '20240101161000', headType: 'VTSE51',
    time: '2024-01-01T17:00:00+09:00', cancelled: true, cancelReason: 'retracted',
    issue: { source: '気象庁', time: '2024-01-01T17:00:00+09:00', type: 'Focus' }, areas: [],
  }

  // 正: 一部取消は、受信処理が実際に読む文（解除・誤報取消の文ではない）を焼く
  it('一部取消の文を焼く', () => {
    const texts = speculativeSpeechTexts({ kind: 'event', event: retraction } as unknown as ReplayPayload, OPTS)
    expect(texts).toEqual([tsunamiPartialRetractionToText('VTSE51')])
  })

  // 対照: 津波警報等の取消は従来どおり取消の文
  it('津波警報等の取消は取消の文を焼く', () => {
    const texts = speculativeSpeechTexts({ kind: 'event', event: { ...retraction, headType: 'VTSE41' } } as unknown as ReplayPayload, OPTS)
    expect(texts).not.toContain(tsunamiPartialRetractionToText('VTSE51'))
    expect(texts.length).toBeGreaterThan(0)
  })
})
