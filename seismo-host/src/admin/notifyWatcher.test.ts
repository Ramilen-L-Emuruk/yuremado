import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AdminNotification } from './adminNotify'
import {
  readNotifySettings,
  startNotifyWatcher,
  watcherProblems,
  writeNotifySettings,
  type NotifyWatcherDeps,
} from './notifyWatcher'
import type { StatusReportView } from './viewStatus'
import type { WaveStreamOptions, WaveStreamState } from './waveStream'

const NOW = 1_800_000_000_000

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

/** 返事を手で決める偽の取得。打ち切りの合図が来たら断る（本物の fetch と同じ）。 */
function fakeFetch() {
  const calls: { resolve: (s: StatusReportView | 'fail') => void; signal: AbortSignal }[] = []
  const fetch: NotifyWatcherDeps['fetch'] = (_url, init) =>
    new Promise<Response>((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('打ち切り')), { once: true })
      calls.push({
        signal: init.signal,
        resolve: (s) => {
          if (s === 'fail') reject(new Error('繋がらない'))
          else resolve({ ok: true, json: async () => s } as unknown as Response)
        },
      })
    })
  return { fetch, calls }
}

function fakeStream() {
  const opened: WaveStreamOptions[] = []
  const openStream: NotifyWatcherDeps['openStream'] = (options) => {
    opened.push(options)
    options.onState('connecting')
  }
  return { openStream, opened }
}

function setup() {
  const f = fakeFetch()
  const s = fakeStream()
  const shown: AdminNotification[] = []
  const ctl = new AbortController()
  startNotifyWatcher(ctl.signal, {
    fetch: f.fetch,
    openStream: s.openStream,
    storage: () => null,
    show: (n) => shown.push(n),
    now: () => NOW,
  })
  return { ...f, ...s, shown, ctl }
}

/** 取得の返事を流し、続く then の連鎖を片付ける。 */
async function answer(call: { resolve: (s: StatusReportView | 'fail') => void }, s: StatusReportView | 'fail') {
  call.resolve(s)
  await vi.advanceTimersByTimeAsync(0)
}

describe('startNotifyWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('安全弁: 前の回が終わるまで次の読み取りを投げない', async () => {
    const t = setup()
    expect(t.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(t.calls).toHaveLength(1)
    await answer(t.calls[0]!, status())
    await vi.advanceTimersByTimeAsync(5_000)
    expect(t.calls).toHaveLength(2)
    t.ctl.abort()
  })

  it('正: 応答が返らない回は 10 秒で打ち切り、読めなかった回に数える', async () => {
    const t = setup()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(t.calls[0]!.signal.aborted).toBe(true)
    // 打ち切りの後は次の回を投げられる
    await vi.advanceTimersByTimeAsync(5_000)
    expect(t.calls.length).toBeGreaterThanOrEqual(2)
    t.ctl.abort()
  })

  it('正: 3 回続けて読めなければ「ホストの状態を読めない」を知らせ、戻ったら解消を知らせる', async () => {
    const t = setup()
    await answer(t.calls[0]!, status())
    for (let i = 1; i <= 3; i += 1) {
      await vi.advanceTimersByTimeAsync(5_000)
      await answer(t.calls[i]!, 'fail')
    }
    expect(t.shown.map((n) => n.body)).toEqual(['ホストの状態を読めない'])
    expect(watcherProblems().hostUnreachable).toBe(true)
    await vi.advanceTimersByTimeAsync(5_000)
    await answer(t.calls[4]!, status())
    expect(t.shown.map((n) => n.title)).toEqual(['自作地震計の警告', '警告が解消した'])
    expect(watcherProblems().hostUnreachable).toBe(false)
    t.ctl.abort()
  })

  it('正: 押し出しが閉じたら 30 秒あけて 1 回だけ開き直し、開いたら不調の行を下ろす', async () => {
    const t = setup()
    const first = t.opened[0]!
    first.onState('open')
    expect(watcherProblems().streamDown).toBe(false)
    first.onState('closed' as WaveStreamState)
    expect(watcherProblems().streamDown).toBe(true)
    expect(first.signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(t.opened).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(t.opened).toHaveLength(2)
    // 開き直した直後の「繋いでいる」は、まだ切れている側に数える
    expect(watcherProblems().streamDown).toBe(true)
    t.opened[1]!.onState('open')
    expect(watcherProblems().streamDown).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(t.opened).toHaveLength(2)
    t.ctl.abort()
  })

  it('対照: 止めた後は開き直さず、いまの押し出しも閉じる', async () => {
    const t = setup()
    t.opened[0]!.onState('closed' as WaveStreamState)
    t.ctl.abort()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(t.opened).toHaveLength(1)
  })
})

describe('readNotifySettings・writeNotifySettings', () => {
  it('安全弁: 保存先が使えない・投げるときは既定へ倒し、書けなかったことを返す', () => {
    expect(readNotifySettings(null)).toEqual({ warnings: true, resolved: true, shakes: true })
    const throwing = {
      getItem: () => {
        throw new Error('使えない')
      },
      setItem: () => {
        throw new Error('いっぱい')
      },
    }
    expect(readNotifySettings(throwing)).toEqual({ warnings: true, resolved: true, shakes: true })
    expect(writeNotifySettings(throwing, { warnings: false, resolved: true, shakes: true })).toBe(false)
    expect(writeNotifySettings(null, { warnings: false, resolved: true, shakes: true })).toBe(false)
  })
})
