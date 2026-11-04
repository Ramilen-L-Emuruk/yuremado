import { describe, expect, it } from 'vitest'
import {
  TIME_SIGNAL_SOUND_SHAPE, TIME_SIGNAL_SPEECH_GAP_SEC,
  isInQuietHours, nextSignalAt, speechStartOffsetSec, timeSignalClockText, timeSignalSpeechText,
} from './timeSignal'

// 日時は現地時刻で組む（境も現地時刻で決まるので、CI の時間帯によらず同じに通る）
const at = (h: number, m: number, s = 0, ms = 0) => new Date(2026, 10, 4, h, m, s, ms).getTime()

describe('nextSignalAt', () => {
  it('毎正時なら次の正時', () => {
    expect(nextSignalAt(at(15, 12, 34), 60)).toBe(at(16, 0))
  })
  it('15 分ごとなら次の 15 分の刻み', () => {
    expect(nextSignalAt(at(15, 12, 34), 15)).toBe(at(15, 15))
    expect(nextSignalAt(at(15, 59, 59, 999), 15)).toBe(at(16, 0))
  })
  it('ちょうど境の時刻なら、その境ではなく次の境（鳴らしたばかりの境を選び直さない）', () => {
    expect(nextSignalAt(at(15, 30), 30)).toBe(at(16, 0))
    expect(nextSignalAt(at(15, 30), 5)).toBe(at(15, 35))
  })
  it('境の 1ms 前なら、その境', () => {
    expect(nextSignalAt(at(15, 29, 59, 999), 30)).toBe(at(15, 30))
  })
  it('日をまたぐ', () => {
    expect(nextSignalAt(at(23, 58), 10)).toBe(new Date(2026, 10, 5, 0, 0).getTime())
  })
})

describe('isInQuietHours', () => {
  const start = 22 * 60
  const end = 7 * 60
  it('日をまたぐ時間帯: 始まりは含み、終わりは含まない', () => {
    expect(isInQuietHours(at(22, 0), start, end)).toBe(true)
    expect(isInQuietHours(at(3, 0), start, end)).toBe(true)
    expect(isInQuietHours(at(6, 59), start, end)).toBe(true)
    expect(isInQuietHours(at(7, 0), start, end)).toBe(false)
    expect(isInQuietHours(at(21, 59), start, end)).toBe(false)
  })
  it('日をまたがない時間帯', () => {
    expect(isInQuietHours(at(12, 30), 12 * 60, 13 * 60)).toBe(true)
    expect(isInQuietHours(at(13, 0), 12 * 60, 13 * 60)).toBe(false)
    expect(isInQuietHours(at(11, 59), 12 * 60, 13 * 60)).toBe(false)
  })
  it('始まりと終わりが同じなら空（いつでも鳴らす）', () => {
    expect(isInQuietHours(at(8, 0), 8 * 60, 8 * 60)).toBe(false)
    expect(isInQuietHours(at(20, 0), 8 * 60, 8 * 60)).toBe(false)
  })
})

describe('timeSignalClockText', () => {
  it('24 時間制。正時は分を読まない', () => {
    expect(timeSignalClockText(at(15, 30), '24h')).toBe('15時30分')
    expect(timeSignalClockText(at(15, 0), '24h')).toBe('15時')
    expect(timeSignalClockText(at(0, 5), '24h')).toBe('0時5分')
  })
  it('12 時間制。正午は午後0時、0 時は午前0時', () => {
    expect(timeSignalClockText(at(15, 30), '12h')).toBe('午後3時30分')
    expect(timeSignalClockText(at(12, 0), '12h')).toBe('午後0時')
    expect(timeSignalClockText(at(0, 0), '12h')).toBe('午前0時')
    expect(timeSignalClockText(at(11, 55), '12h')).toBe('午前11時55分')
  })
})

describe('timeSignalSpeechText', () => {
  it('4 つの文の形', () => {
    expect(timeSignalSpeechText(at(15, 30), '24h', 'oshirase')).toBe('15時30分をお知らせします')
    expect(timeSignalSpeechText(at(15, 30), '24h', 'desu')).toBe('15時30分です')
    expect(timeSignalSpeechText(at(15, 30), '24h', 'narimashita')).toBe('15時30分になりました')
    expect(timeSignalSpeechText(at(15, 30), '24h', 'bare')).toBe('15時30分')
  })
})

describe('speechStartOffsetSec', () => {
  it('音が先: 音の余韻が終わって間を置いてから読む', () => {
    expect(speechStartOffsetSec('pips', 'soundFirst', 1.5))
      .toBeCloseTo(TIME_SIGNAL_SOUND_SHAPE.pips.tailSec + TIME_SIGNAL_SPEECH_GAP_SEC)
  })
  it('音が先でも音なしなら、境ちょうどに読み始める', () => {
    expect(speechStartOffsetSec('none', 'soundFirst', 1.5)).toBe(0)
  })
  it('読み上げが先: ピッの鳴り始めの間の手前で読み終わる', () => {
    const start = speechStartOffsetSec('pips', 'speechFirst', 1.5)
    expect(start + 1.5).toBeCloseTo(-TIME_SIGNAL_SOUND_SHAPE.pips.leadSec - TIME_SIGNAL_SPEECH_GAP_SEC)
  })
  it('読み上げが先で音なしなら、境ちょうどに読み終わる', () => {
    expect(speechStartOffsetSec('none', 'speechFirst', 1.5)).toBeCloseTo(-1.5)
  })
})
