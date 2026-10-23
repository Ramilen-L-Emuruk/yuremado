// 国内の地震情報の津波の一文と、固定付加文の残りの読み上げ。
//
// - 津波の一文は、区分を決めた固定付加文のコードの気象庁の文を読む（→ `domesticTsunamiSegmentOf`）。
//   区分から文を起こすと気象庁が書いていないことを言う（コード表との突き合わせは docs/jma-wording-audit.md E1〜E3）
// - 固定付加文のうち津波の一文以外は、「気象庁の発表文」の内訳「固定付加文」（`quakeForecast`）で読む
//   （2026-10-23 ユーザー選択「A: 発表文の内訳に足す (Recommended)」）
import { describe, it, expect, vi } from 'vitest'
import { log } from './logger'
import {
  earthquakeToSegments, earthquakeToText, createQuakeSpokenState, applySpokenRefs, telegramTextToSpeak,
  TELEGRAM_BOILERPLATE_DEFAULT_READS, TELEGRAM_TEXT_BLOCK_KEYS, DOMESTIC_TSUNAMI_CODE_TEXT, type TtsSpeechOptions, type TelegramTextBlocks,
} from './ttsText'
import { joinSegments } from './ttsFollow'
import type { DomesticTsunami, DomesticTsunamiCode, IssueType, JMAQuake } from '../types/earthquake'

const OPTS: TtsSpeechOptions = { intensityLevels: 0, maxRegions: 0, alwaysReadScale: -1, regionTolerance: 0 }

// コード表（地震火山関連コード表・固定付加文）の文。
const TEXT_0230 = 'この地震による日本への津波の影響はありません。'
const TEXT_0212 = 'この地震により、日本の沿岸では若干の海面変動があるかもしれませんが、被害の心配はありません。'
const TEXT_0213 = '今後もしばらく海面変動が続くと思われますので、海水浴や磯釣り等を行う際は注意してください。'
const TEXT_0215 = 'この地震による津波の心配はありません。'
const TEXT_0226 = '震源の近傍で津波発生の可能性があります。'
const TEXT_0241 = 'この地震について、緊急地震速報を発表しています。'

function quake(over: {
  domesticTsunami: DomesticTsunami
  code?: DomesticTsunamiCode
  forecastText?: string
  borrowed?: boolean
  type?: IssueType
}): JMAQuake {
  return {
    kind: 'quake',
    id: 'dmdata-quake-20260417120000-1',
    eventId: '20260417120000',
    time: '2026-04-17T12:03:00+09:00',
    issue: { source: '気象庁', time: '2026-04-17T12:03:00+09:00', type: over.type ?? '震源情報', correct: 'なし' },
    earthquake: {
      time: '2026-04-17T12:00:00+09:00',
      hypocenter: { name: '日向灘', latitude: 32.0, longitude: 132.0, depth: 30, magnitude: 5.2 },
      maxScale: -1,
      domesticTsunami: over.domesticTsunami,
      ...(over.code && { domesticTsunamiCode: over.code }),
    },
    points: [],
    forecastText: over.forecastText,
    ...(over.borrowed && { domesticTsunamiSource: { shortLabel: '津波情報', infoName: '津波警報・津波注意報・津波予報', reportTime: '2026-04-17T12:05:00+09:00' } }),
  }
}

describe('国内の地震情報の津波の一文', () => {
  // 正: 区分を決めたコードがあれば、そのコードの気象庁の文を読む。区分の文（0215 の文）へ丸めない。
  it('0230 は「日本への津波の影響はありません」と読む', () => {
    const text = earthquakeToText(quake({ domesticTsunami: 'なし', code: '0230', forecastText: TEXT_0230 }), OPTS, true)
    expect(text).toContain(TEXT_0230)
    expect(text).not.toContain(TEXT_0215)
  })

  // 正: 注意の呼びかけを「被害の心配はありません」へ変えない。
  it('0213 は注意の呼びかけのまま読む', () => {
    const text = earthquakeToText(quake({ domesticTsunami: '若干の海面変動', code: '0213', forecastText: TEXT_0213 }), OPTS, true)
    expect(text).toContain(TEXT_0213)
    expect(text).not.toContain('被害の心配はありません')
  })

  // 正: 原文が欠けていても（取得の失敗・統合で原文だけが別の報のもの）、コードがあれば気象庁の文を読む。
  it('原文が無くてもコードの文を読む', () => {
    const text = earthquakeToText(quake({ domesticTsunami: 'なし', code: '0230' }), OPTS, true)
    expect(text).toContain(TEXT_0230)
  })

  // 対照: コードを持たない経路（P2PQuake）は区分の文のまま。
  it('コードが無ければ区分の文を読む', () => {
    const text = earthquakeToText(quake({ domesticTsunami: 'なし' }), OPTS, true)
    expect(text).toContain(TEXT_0215)
  })

  // 安全弁: 津波の一文の位置に、同じ枠のほかの文（0226・0241）を混ぜない。そちらは発表文の層で選んで読む。
  it('同じ枠のほかの文は本体では読まない', () => {
    const forecastText = `${TEXT_0212}${TEXT_0226}${TEXT_0241}`
    const text = earthquakeToText(quake({ domesticTsunami: '若干の海面変動', code: '0212', forecastText }), OPTS, true)
    expect(text).toContain(TEXT_0212)
    expect(text).not.toContain(TEXT_0226)
    expect(text).not.toContain(TEXT_0241)
  })
})

describe('続報で津波の一文のコードだけが変わったとき', () => {
  // 正: 区分が同じでもコードが変われば読む文が違うので、差分として読む（0212 → 0213 はどちらも「若干の海面変動」）。
  it('区分が同じでもコードが変われば続報で読む', () => {
    const state = createQuakeSpokenState()
    applySpokenRefs(state, earthquakeToSegments(quake({ domesticTsunami: '若干の海面変動', code: '0212' }), OPTS, true, state).flatMap(s => s.refs ?? []))
    const next = joinSegments(earthquakeToSegments(quake({ domesticTsunami: '若干の海面変動', code: '0213' }), OPTS, false, state))
    expect(next).toContain(TEXT_0213)
  })

  // 対照: コードも区分も同じなら言い直さない。
  it('コードも区分も同じなら言い直さない', () => {
    const state = createQuakeSpokenState()
    applySpokenRefs(state, earthquakeToSegments(quake({ domesticTsunami: '若干の海面変動', code: '0212' }), OPTS, true, state).flatMap(s => s.refs ?? []))
    const next = joinSegments(earthquakeToSegments(quake({ domesticTsunami: '若干の海面変動', code: '0212' }), OPTS, false, state))
    expect(next).not.toContain(TEXT_0212)
  })
})

describe('「気象庁の発表文」の内訳「固定付加文」', () => {
  const allBlocks = Object.fromEntries(TELEGRAM_TEXT_BLOCK_KEYS.map(k => [k, true])) as TelegramTextBlocks
  const LAYER: TtsSpeechOptions = { ...OPTS, readTelegramText: true, telegramTextBlocks: allBlocks }
  const withForecast = quake({ domesticTsunami: '若干の海面変動', code: '0212', forecastText: `${TEXT_0212}${TEXT_0226}${TEXT_0241}` })

  // 正: 津波の一文を除いた残りを読む。津波の一文は本体が読むので 2 度言わない。
  it('津波の一文を除いた残りを読む', () => {
    const body = telegramTextToSpeak(withForecast, LAYER)?.body ?? ''
    expect(body).toContain(TEXT_0226)
    expect(body).not.toContain(TEXT_0212)
  })

  // 対照: 内訳で切れば読まない。
  it('内訳で切れば読まない', () => {
    const body = telegramTextToSpeak(withForecast, { ...LAYER, telegramTextBlocks: { ...allBlocks, quakeForecast: false } })?.body ?? ''
    expect(body).not.toContain(TEXT_0226)
  })

  // 安全弁: 定型文の設定は発表文のほかの枠と同じに効く（0241 は既定で落ちる・読む設定なら読む）。
  it('0241 は定型文の設定どおりに落とす・読む', () => {
    const dropped = telegramTextToSpeak(withForecast, LAYER)?.body ?? ''
    expect(dropped).not.toContain(TEXT_0241)
    const kept = telegramTextToSpeak(withForecast, { ...LAYER, telegramBoilerplate: { ...TELEGRAM_BOILERPLATE_DEFAULT_READS, eewIssued: true } })?.body ?? ''
    expect(kept).toContain(TEXT_0241)
  })

  // 安全弁: 原文が本体の津波の一文と別の報のものでも、原文に残った津波の文は読まない。
  // 区分を借りた（コードを捨てる）・震源要素更新が区分だけ運んだ（原文は前の報のまま）の 2 形。
  it('区分を借りたカードでも原文の津波の文は読まない', () => {
    const borrowed = quake({ domesticTsunami: '警報等', borrowed: true, forecastText: `今後の情報に注意してください。${TEXT_0226}` })
    const body = telegramTextToSpeak(borrowed, LAYER)?.body ?? ''
    expect(body).toContain(TEXT_0226)
    expect(body).not.toContain('今後の情報に注意してください。')
  })

  it('原文が前の報のままでも、その津波の文は読まない', () => {
    const stale = quake({ domesticTsunami: '警報等', code: '0211', forecastText: `${TEXT_0215}${TEXT_0226}` })
    const body = telegramTextToSpeak(stale, LAYER)?.body ?? ''
    expect(body).toContain(TEXT_0226)
    expect(body).not.toContain(TEXT_0215)
  })

  // 正: コードを持つのにその文が原文に無ければ（気象庁が文面を変えた疑い）記録を残し、残りは読む。
  it('コードの文が原文に無ければ記録を残す', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const changed = quake({ domesticTsunami: '若干の海面変動', code: '0212', forecastText: `文面の変わった津波の文。${TEXT_0226}` })
      const body = telegramTextToSpeak(changed, LAYER)?.body ?? ''
      expect(body).toContain(TEXT_0226)
      expect(warn.mock.calls.some(c => String(c[0]).includes('0212'))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  // 対照: 原文に別のコードの文があるだけ（原文が前の報のまま）なら、文面の変更ではないので記録しない。
  it('原文に別のコードの文があるだけなら記録しない', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      telegramTextToSpeak(quake({ domesticTsunami: '警報等', code: '0211', forecastText: `${TEXT_0215}${TEXT_0226}` }), LAYER)
      expect(warn.mock.calls.some(c => String(c[0]).includes('区分を決めるコードの文が見つかりません'))).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })

  // 安全弁: 区分を決めるコードの文は 9 文とも 1 文ずつ除かれ、どの 2 文も互いを含まない
  // （含むと、短い文を除くときに長い文の一部だけが消えて壊れた文が残る）。
  it('区分を決めるコードの文は 9 文とも除かれ、互いを含まない', () => {
    const entries = Object.entries(DOMESTIC_TSUNAMI_CODE_TEXT) as [DomesticTsunamiCode, string][]
    expect(entries).toHaveLength(9)
    for (const [code, sentence] of entries) {
      const body = telegramTextToSpeak(quake({ domesticTsunami: 'なし', code, forecastText: `${sentence}${TEXT_0226}` }), LAYER)?.body ?? ''
      expect(body, code).toContain(TEXT_0226)
      expect(body, code).not.toContain(sentence)
      for (const [other, otherSentence] of entries) {
        if (other !== code) expect(sentence.includes(otherSentence), `${code} が ${other} を含む`).toBe(false)
      }
    }
  })

  // 安全弁: 遠地地震は本体が固定付加文を全文読むので、発表文の層では読まない。
  it('遠地地震では読まない', () => {
    const foreign = quake({ type: '遠地地震', domesticTsunami: 'なし', code: '0230', forecastText: `${TEXT_0226}${TEXT_0230}` })
    const body = telegramTextToSpeak(foreign, LAYER)?.body ?? ''
    expect(body).not.toContain(TEXT_0226)
  })
})
