// 電文ログの保持（経路ごとの枠・経路を指して落とす）。
//
// **枠を 1 本に戻すと落ちるように書いてある。** テストボタンを数回押しただけで本物の受信の
// 記録が押し出される症状は、例外もログも出ず、画面からは「その電文は届かなかった」のと
// 見分けが付かない。
import { describe, it, expect } from 'vitest'
import { appendToTelegramLog, dropTelegramLogOrigins, TELEGRAM_LOG_LIMITS } from './telegramLogBuffer'
import type { TelegramLogEntry, TelegramOrigin } from '../types/earthquake'
// **トップレベルで読む。** テスト本体の中で初めて読むと、モジュールの解決・変換の待ち（全ファイルを並列で
// 回すと数秒）が 1 件目の所要時間へ丸ごと乗り、既定の 5 秒で時間切れになる（→ CLAUDE.md「検証」）。
import { makeReplayLogEntry } from '../services/telegramLogEntry'

const entry = (origin: TelegramOrigin, id: string): TelegramLogEntry => ({
  id,
  receivedAt: new Date('2026-10-23T12:00:00Z'),
  source: 'dmdss',
  origin,
  headType: 'VXSE53',
  isTest: false,
  status: 'parsed',
  rawBody: '<Report/>',
})

/** `n` 件積む（古い順に積むので、戻り値の先頭が最後に積んだもの）。 */
const fill = (origin: TelegramOrigin, n: number, prefix = origin): TelegramLogEntry[] => {
  let log: TelegramLogEntry[] = []
  for (let i = 0; i < n; i++) log = appendToTelegramLog(log, entry(origin, `${prefix}-${i}`))
  return log
}

describe('appendToTelegramLog', () => {
  it('新しい行が先頭へ来る', () => {
    const log = fill('live', 3)
    expect(log.map(e => e.id)).toEqual(['live-2', 'live-1', 'live-0'])
  })

  // 正: その経路が上限を超えたら、同じ経路の古い行から捨てる
  it('上限を超えたら、その経路の古い行から捨てる', () => {
    const log = fill('test', TELEGRAM_LOG_LIMITS.test + 5)
    expect(log).toHaveLength(TELEGRAM_LOG_LIMITS.test)
    // 最初に積んだ 5 件が落ちている
    expect(log.some(e => e.id === 'test-0')).toBe(false)
    expect(log.some(e => e.id === 'test-4')).toBe(false)
    expect(log.some(e => e.id === 'test-5')).toBe(true)
  })

  // 対照: 上限の手前では 1 件も落ちない
  it('上限に達していなければ落とさない', () => {
    const log = fill('test', TELEGRAM_LOG_LIMITS.test)
    expect(log).toHaveLength(TELEGRAM_LOG_LIMITS.test)
    expect(log.some(e => e.id === 'test-0')).toBe(true)
  })

  // 安全弁: **これが落ちたら枠が 1 本に戻っている。**
  // テストの電文をいくら積んでも、ライブの行は 1 件も押し出されてはならない。
  it('テストの電文を上限いっぱい積んでも、ライブの行は 1 件も消えない', () => {
    let log = fill('live', TELEGRAM_LOG_LIMITS.live)
    for (let i = 0; i < TELEGRAM_LOG_LIMITS.test * 3; i++) {
      log = appendToTelegramLog(log, entry('test', `test-${i}`))
    }
    const live = log.filter(e => e.origin === 'live')
    expect(live).toHaveLength(TELEGRAM_LOG_LIMITS.live)
    // いちばん古いライブの行も残っている
    expect(live.some(e => e.id === 'live-0')).toBe(true)
  })

  // 安全弁: 再生も同じ（こちらの枠だけで収まる）
  it('再生の電文を積んでも、ライブとテストの行は消えない', () => {
    let log = [...fill('test', 3), ...fill('live', 3)]
    for (let i = 0; i < TELEGRAM_LOG_LIMITS.replay + 10; i++) {
      log = appendToTelegramLog(log, entry('replay', `replay-${i}`))
    }
    expect(log.filter(e => e.origin === 'live')).toHaveLength(3)
    expect(log.filter(e => e.origin === 'test')).toHaveLength(3)
    expect(log.filter(e => e.origin === 'replay')).toHaveLength(TELEGRAM_LOG_LIMITS.replay)
  })
})

describe('dropTelegramLogOrigins', () => {
  // 正: リプレイの開始・停止で落とす 2 経路
  it('指定した経路の行だけを落とす', () => {
    const log = [...fill('live', 2), ...fill('test', 2), ...fill('replay', 2)]
    const kept = dropTelegramLogOrigins(log, ['test', 'replay'])
    expect(kept.map(e => e.origin)).toEqual(['live', 'live'])
  })

  // 安全弁: **これが落ちたらライブの記録まで消している。**
  it('ライブの行は残す', () => {
    const log = [...fill('live', 5), ...fill('replay', 5)]
    const kept = dropTelegramLogOrigins(log, ['test', 'replay'])
    expect(kept).toHaveLength(5)
    expect(kept.every(e => e.origin === 'live')).toBe(true)
  })

  // 対照: 指定しなければ何も落ちない
  it('空の指定では 1 件も落ちない', () => {
    const log = [...fill('live', 2), ...fill('test', 2)]
    expect(dropTelegramLogOrigins(log, [])).toHaveLength(4)
  })
})

// 組み立て側（`services/telegramLogEntry.ts`）の分岐。**いまの呼び出し元は読めたものしか
// 渡さない**ので `filtered` は実運用では通らないが、載せると決めたときにここを通す。
// 未テストのまま残すと、通した途端に壊れていても気づけない。
describe('makeReplayLogEntry', () => {
  it('読めた電文は parsed、読めなかった電文は filtered として組む', () => {
    const parsed = makeReplayLogEntry({
      headType: 'VXSE53', origin: 'test', rawBody: '<Report/>',
      payload: { kind: 'nankai', data: {} as never }, isTest: false,
    })
    expect(parsed.status).toBe('parsed')
    expect(parsed.kind).toBe('nankai')

    const failed = makeReplayLogEntry({
      headType: 'VXSE53', origin: 'replay', rawBody: '<broken', payload: null, isTest: false,
    })
    expect(failed.status).toBe('filtered')
    // 読めなかったときは電文種別コードから種別を引く（ライブと同じ）
    expect(failed.kind).toBe('quake')
  })

  it('配信元は既定で DMDSS、指定すれば標準版になる', () => {
    const base = { headType: '551', origin: 'replay' as const, rawBody: {}, payload: null, isTest: false }
    expect(makeReplayLogEntry(base).source).toBe('dmdss')
    expect(makeReplayLogEntry({ ...base, source: 'p2pquake' }).source).toBe('p2pquake')
  })
})
