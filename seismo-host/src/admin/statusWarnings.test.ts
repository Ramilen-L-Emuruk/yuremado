import { describe, expect, it } from 'vitest'

import { listWarning, singleWarning, warningItem } from './statusWarnings'
import { storageWarningList } from './storageText'
import {
  assignedSilenceWarningList,
  boardClockWarningList,
  collectStatusWarnings,
  type StatusReportView,
} from './viewStatus'

const NOW = 1_800_000_000_000

const board = (boardKey: string, state: string, lastPacketMs: number | null = null) => ({
  boardKey,
  stationId: 'garage',
  lastPacketMs,
  state,
  sensors: [],
})

const clock = (boardKey: string, offsetMs: number) => ({
  boardKey,
  offsetMs,
  windowEndMs: NOW - 1_000,
  packets: 600,
  lastPacketMs: NOW - 100,
})

function status(over: Partial<StatusReportView> = {}): StatusReportView {
  return {
    generatedAtMs: NOW,
    uptimeSec: 60,
    sensors: [],
    stationIntensities: [],
    mseed: {
      writeErrors: 0,
      lostRecords: 0,
      recordsWritten: 0,
      unreadableWritten: 0,
      lastWriteError: null,
      lastInternalError: null,
    },
    stationConfigWarning: null,
    ungroupedMultiBoardStations: [],
    ...over,
  }
}

describe('singleWarning・listWarning・warningItem', () => {
  it('正: 素の文はエスケープせず、HTML だけエスケープする', () => {
    const w = singleWarning('k', '観測点設定', 'a<b>')
    expect(w.text).toBe('観測点設定: a<b>')
    expect(w.html).toBe('観測点設定: a&lt;b&gt;')
    expect(w.items).toEqual([])
  })

  it('正: 対象の並ぶ行は「頭: 対象、対象」で、呼び名は括弧の中を持たない', () => {
    const w = listWarning('k', '頭', [
      warningItem('a', 'a<1>', { html: 'x&amp;', text: 'x&' }),
      warningItem('b', 'b'),
    ])
    expect(w?.text).toBe('頭: a<1>（x&）、b')
    expect(w?.html).toBe('頭: a&lt;1&gt;（x&amp;）、b')
    expect(w?.items.map((i) => i.label)).toEqual(['a<1>', 'b'])
  })

  it('対照: 対象が 1 つも無ければ行を作らない', () => {
    expect(listWarning('k', '頭', [])).toBeNull()
  })
})

describe('boardClockWarningList', () => {
  it('安全弁: ずれの量が変わっても鍵は動かない（通知が 5 秒ごとに出直さない）', () => {
    const a = boardClockWarningList(NOW, [clock('mac:a0b7', 1301)])
    const b = boardClockWarningList(NOW, [clock('mac:a0b7', 2400)])
    expect(a[0]?.key).toBe(b[0]?.key)
    expect(a[0]?.items.map((i) => i.key)).toEqual(b[0]?.items.map((i) => i.key))
    expect(a[0]?.text).not.toBe(b[0]?.text)
  })
})

describe('assignedSilenceWarningList', () => {
  it('正: 黙った基板を 1 枚ずつ対象に持ち、経過時間は文にだけ入る', () => {
    const [w] = assignedSilenceWarningList(NOW, [board('mac:aa', 'silent'), board('mac:bb', 'silent', NOW - 95_000)])
    expect(w?.key).toBe('assigned-board-silent')
    expect(w?.items.map((i) => i.key)).toEqual(['mac:aa', 'mac:bb'])
    expect(w?.items.map((i) => i.label)).toEqual(['mac:aa', 'mac:bb'])
    expect(w?.items[1]?.text).toContain('最後に届いてから 95 秒')
  })

  it('安全弁: センサーの鍵は区切り文字で繋がない（boardKey に「/」を含む基板と取り違えない）', () => {
    const [w] = assignedSilenceWarningList(NOW, [
      {
        boardKey: 'name:a / b',
        stationId: 'garage',
        lastPacketMs: NOW,
        state: 'live',
        sensors: [{ sensorId: 'c', lastPacketMs: null, state: 'silent' }],
      },
      {
        boardKey: 'name:a',
        stationId: 'garage',
        lastPacketMs: NOW,
        state: 'live',
        sensors: [{ sensorId: 'b / c', lastPacketMs: null, state: 'silent' }],
      },
    ])
    const keys = w?.items.map((i) => i.key) ?? []
    expect(new Set(keys).size).toBe(2)
  })
})

describe('storageWarningList', () => {
  it('正: ドライブの警告の鍵は置いている種類で決まり、残りの日数でも「10% を切った」へ移っても動かない', () => {
    const drive = (daysLeft: number) => ({
      kinds: ['wave', 'raw'] as const,
      freeBytes: 1,
      totalBytes: 100,
      growthBytesPerDay: 1,
      daysLeft,
      warning: 'low-days' as const,
    })
    const brief = (daysLeft: number) => ({
      drives: [drive(daysLeft)],
      lastError: null,
      migration: null,
      startupProblem: null,
      journalProblem: null,
    })
    const [a] = storageWarningList(brief(12))
    const [b] = storageWarningList(brief(11))
    expect(a?.key).toBe('storage-low:raw,wave')
    expect(a?.key).toBe(b?.key)
    expect(a?.text).not.toBe(b?.text)
    const [c] = storageWarningList({ ...brief(3), drives: [{ ...drive(3), warning: 'low-free' as const }] })
    expect(c?.key).toBe(a?.key)
    // 解消したときの呼び名は数字を持たない（2026-10-27 ユーザー承認）
    expect(a?.label).toBe('保存先の空き容量が少ない')
    expect(c?.label).toBe('保存先の空き容量が少ない')
  })

  it('安全弁: 画面に出す行は数字を含んだまま（呼び名だけが変わる）', () => {
    const [w] = storageWarningList({
      drives: [{ kinds: ['raw'], freeBytes: 1, totalBytes: 100, growthBytesPerDay: 1, daysLeft: 12, warning: 'low-days' }],
      lastError: null,
      migration: null,
      startupProblem: null,
      journalProblem: null,
    })
    expect(w?.html).toBe('保存先の空き容量があと約 12 日でなくなる')
  })
})

describe('collectStatusWarnings', () => {
  it('正: 稼働状況の行と同じ並びで、すべての種類を集める', () => {
    const ws = collectStatusWarnings(
      status({
        stationConfigWarning: '読めない',
        ungroupedMultiBoardStations: ['st1', 'st2'],
        assignedBoards: [board('mac:aa', 'silent')],
        boardClocks: { boards: [clock('mac:bb', 1301)] },
      }),
    )
    expect(ws.map((w) => w.key)).toEqual([
      'station-config',
      'ungrouped-stations',
      'assigned-board-silent',
      'board-clock',
    ])
    expect(ws[1]?.html).toBe('基板を複数割り当てたが、合成できていない観測点: st1、st2')
  })

  it('正: ホストの時計を合わせられていなければ、基板の時計の警告より先に並べる', () => {
    const ws = collectStatusWarnings(
      status({
        hostClock: { source: 'os', consecutiveFailures: 1 },
        boardClocks: { boards: [clock('mac:bb', 1301)] },
      }),
    )
    expect(ws.map((w) => w.key)).toEqual(['host-clock', 'board-clock'])
  })

  it('対照: ホストの時計が合っていれば、ホストの時計の警告は出さない', () => {
    const ws = collectStatusWarnings(status({ hostClock: { source: 'ntp', consecutiveFailures: 3 } }))
    expect(ws.map((w) => w.key)).toEqual([])
  })

  it('対照: 何も起きていなければ空', () => {
    expect(collectStatusWarnings(status())).toEqual([])
  })
})
