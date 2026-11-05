// 電文ログの保持（経路ごとの枠・経路を指して落とす）。
//
// **枠を 1 本に戻すと落ちるように書いてある。** テストボタンを数回押しただけで本物の受信の
// 記録が押し出される症状は、例外もログも出ず、画面からは「その電文は届かなかった」のと
// 見分けが付かない。
import { describe, it, expect } from 'vitest'
import {
  appendToTelegramLog, dropTelegramLogOrigins, pruneTelegramLog,
  TELEGRAM_LOG_COUNT_LIMITS, TELEGRAM_LOG_LIVE_WINDOW_MS,
} from './telegramLogBuffer'
import type { TelegramLogEntry, TelegramOrigin } from '../types/earthquake'
// **トップレベルで読む。** テスト本体の中で初めて読むと、モジュールの解決・変換の待ち（全ファイルを並列で
// 回すと数秒）が 1 件目の所要時間へ丸ごと乗り、既定の 5 秒で時間切れになる（→ CLAUDE.md「検証」）。
import { makeReplayLogEntry } from '../services/telegramLogEntry'

const NOW = Date.parse('2026-10-23T12:00:00Z')
const entry = (origin: TelegramOrigin, id: string, receivedAtMs = NOW): TelegramLogEntry => ({
  id,
  receivedAt: new Date(receivedAtMs),
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
  for (let i = 0; i < n; i++) log = appendToTelegramLog(log, entry(origin, `${prefix}-${i}`), NOW)
  return log
}

describe('appendToTelegramLog', () => {
  it('新しい行が先頭へ来る', () => {
    const log = fill('live', 3)
    expect(log.map(e => e.id)).toEqual(['live-2', 'live-1', 'live-0'])
  })

  // 正: その経路が上限を超えたら、同じ経路の古い行から捨てる
  it('上限を超えたら、その経路の古い行から捨てる', () => {
    const log = fill('test', TELEGRAM_LOG_COUNT_LIMITS.test + 5)
    expect(log).toHaveLength(TELEGRAM_LOG_COUNT_LIMITS.test)
    // 最初に積んだ 5 件が落ちている
    expect(log.some(e => e.id === 'test-0')).toBe(false)
    expect(log.some(e => e.id === 'test-4')).toBe(false)
    expect(log.some(e => e.id === 'test-5')).toBe(true)
  })

  // 対照: 上限の手前では 1 件も落ちない
  it('上限に達していなければ落とさない', () => {
    const log = fill('test', TELEGRAM_LOG_COUNT_LIMITS.test)
    expect(log).toHaveLength(TELEGRAM_LOG_COUNT_LIMITS.test)
    expect(log.some(e => e.id === 'test-0')).toBe(true)
  })

  // 安全弁: **これが落ちたら枠が 1 本に戻っている。**
  // テストの電文をいくら積んでも、ライブの行は 1 件も押し出されてはならない。
  it('テストの電文を上限いっぱい積んでも、ライブの行は 1 件も消えない', () => {
    let log = fill('live', 300)
    for (let i = 0; i < TELEGRAM_LOG_COUNT_LIMITS.test * 3; i++) {
      log = appendToTelegramLog(log, entry('test', `test-${i}`), NOW)
    }
    const live = log.filter(e => e.origin === 'live')
    expect(live).toHaveLength(300)
    // いちばん古いライブの行も残っている
    expect(live.some(e => e.id === 'live-0')).toBe(true)
  })

  // 安全弁: 再生も同じ（こちらの枠だけで収まる）
  it('再生の電文を積んでも、ライブとテストの行は消えない', () => {
    let log = [...fill('test', 3), ...fill('live', 3)]
    for (let i = 0; i < TELEGRAM_LOG_COUNT_LIMITS.replay + 10; i++) {
      log = appendToTelegramLog(log, entry('replay', `replay-${i}`), NOW)
    }
    expect(log.filter(e => e.origin === 'live')).toHaveLength(3)
    expect(log.filter(e => e.origin === 'test')).toHaveLength(3)
    expect(log.filter(e => e.origin === 'replay')).toHaveLength(TELEGRAM_LOG_COUNT_LIMITS.replay)
  })
})

// ライブは件数ではなく 24 時間で持つ（2026-10-23 ユーザー選択「直近 24 時間ぶんを持つ (Recommended)」）
describe('ライブの行の 24 時間', () => {
  // 正: 24 時間より古いライブの行は、次の 1 行を積んだときに捨てる
  it('24 時間より古いライブの行を捨てる', () => {
    const old = entry('live', 'old', NOW - TELEGRAM_LOG_LIVE_WINDOW_MS - 1)
    const log = appendToTelegramLog([old], entry('live', 'new'), NOW)
    expect(log.map(e => e.id)).toEqual(['new'])
  })

  // 対照: ちょうど 24 時間の行は残す。件数が 200 を超えても残す（以前の上限で切らない）
  it('24 時間以内なら件数によらず残す', () => {
    const edge = entry('live', 'edge', NOW - TELEGRAM_LOG_LIVE_WINDOW_MS)
    let log: TelegramLogEntry[] = [edge]
    for (let i = 0; i < 500; i++) log = appendToTelegramLog(log, entry('live', `l-${i}`), NOW)
    expect(log).toHaveLength(501)
    expect(log.some(e => e.id === 'edge')).toBe(true)
  })

  // 安全弁: **再生中は時計が再生時刻を名乗る。** そのとき、再生前に受けたライブの行（「未来」の時刻）を消さない
  it('時計が過去（再生時刻）を指していても、ライブの行は消えない', () => {
    const live = entry('live', 'live-now', NOW)
    const replayNow = NOW - 30 * 24 * 60 * 60 * 1000
    const log = appendToTelegramLog([live], entry('replay', 'r', replayNow), replayNow)
    expect(log.map(e => e.id)).toEqual(['r', 'live-now'])
  })

  // 安全弁: 24 時間はライブだけ。テストと再生の行は古くても件数の枠で持つ（2026-10-25 ユーザー選択「ライブだけ24時間 (Recommended)」）
  it('テストと再生の行は 24 時間より古くても捨てない', () => {
    const old = NOW - 2 * TELEGRAM_LOG_LIVE_WINDOW_MS
    const log = pruneTelegramLog([entry('test', 't', old), entry('replay', 'r', old)], NOW)
    expect(log).toHaveLength(2)
  })

  it('捨てるものが無ければ同じ配列を返す（定期の見回りで描き直させない）', () => {
    const log = [entry('live', 'a')]
    expect(pruneTelegramLog(log, NOW)).toBe(log)
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

// 組み立て側（`services/telegramLogEntry.ts`）の分岐。再生はライブと同じく、取り込まない電文（`filtered`）と
// 読めなかった電文（`filtered`・`error`）の行も積む（2026-11-04 ユーザー選択「ライブと同じに積む (Recommended)」）。
describe('makeReplayLogEntry', () => {
  const head = { type: 'VXSE53', author: 'RJTD', time: '2026-10-30T16:47:00.000Z', designation: null, test: false }

  it('読めた電文は parsed、読めなかった電文は filtered として組む', () => {
    const parsed = makeReplayLogEntry({
      headType: 'VXSE53', origin: 'test', rawHead: undefined, rawBody: '<Report/>', rawBytes: null,
      payload: { kind: 'nankai', data: {} as never }, errorMessage: null, isTest: false,
    })
    expect(parsed.status).toBe('parsed')
    expect(parsed.kind).toBe('nankai')
    expect(parsed.errorMessage).toBeUndefined()

    const failed = makeReplayLogEntry({
      headType: 'VXSE53', origin: 'replay', rawHead: head, rawBody: '<broken', rawBytes: null,
      payload: null, errorMessage: null, isTest: false,
    })
    expect(failed.status).toBe('filtered')
    // 読めなかったときは電文種別コードから種別を引く（ライブと同じ）
    expect(failed.kind).toBe('quake')
  })

  it('理由を渡すと error の行になり、理由を errorMessage に持つ（ライブと同じ語）', () => {
    const entry = makeReplayLogEntry({
      headType: 'IXAC41', origin: 'replay', rawHead: head, rawBody: '（BUFR 3 バイト）', rawBytes: new Uint8Array([1, 2, 3]),
      payload: null, errorMessage: 'bufr decode failed', isTest: false,
    })
    expect(entry.status).toBe('error')
    expect(entry.errorMessage).toBe('bufr decode failed')
  })

  it('見出し（rawHead）と結合した二進（rawBytes）をそのまま持つ／持たないときは rawBytes の欄ごと無い', () => {
    const bytes = new Uint8Array([0x42, 0x55, 0x46, 0x52])
    const withBytes = makeReplayLogEntry({
      headType: 'IXAC41', origin: 'replay', rawHead: head, rawBody: '（BUFR 4 バイト・1 セル）', rawBytes: bytes,
      payload: null, errorMessage: null, isTest: false,
    })
    expect(withBytes.rawHead).toBe(head)
    expect(withBytes.rawBytes).toBe(bytes)
    // 対照: 結合待ちの断片・XML の電文は二進を持たない
    const without = makeReplayLogEntry({
      headType: 'IXAC41', origin: 'replay', rawHead: head, rawBody: '（BUFR の断片 4 バイト・結合待ち）', rawBytes: null,
      payload: null, errorMessage: null, isTest: false,
    })
    expect('rawBytes' in without).toBe(false)
    // 安全弁: 見出しの無い経路（テストボタン）は undefined のまま
    const noHead = makeReplayLogEntry({
      headType: 'VXSE53', origin: 'test', rawHead: undefined, rawBody: '<Report/>', rawBytes: null,
      payload: null, errorMessage: null, isTest: false,
    })
    expect(noHead.rawHead).toBeUndefined()
  })
})
