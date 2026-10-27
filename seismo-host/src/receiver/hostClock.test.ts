import dgram from 'node:dgram'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import {
  HOST_CLOCK_INTERVAL_MS_DEFAULT,
  HostClock,
  NTP_UNIX_OFFSET_SEC,
  anchorFromExchange,
  buildSntpRequest,
  hostClockSyncDelayMs,
  parseSntpReply,
  udpSntpExchange,
  type HostClockOptions,
  type SntpExchange,
} from './hostClock'

/** unix ミリ秒を NTP の 64 ビット時刻として buf の off へ書く。 */
function writeNtpTime(buf: Buffer, off: number, unixMs: number): void {
  const sec = Math.floor(unixMs / 1000)
  const frac = Math.round(((unixMs - sec * 1000) / 1000) * 2 ** 32)
  buf.writeUInt32BE((sec + NTP_UNIX_OFFSET_SEC) >>> 0, off)
  buf.writeUInt32BE(Math.min(frac, 2 ** 32 - 1) >>> 0, off + 4)
}

/** 要求に対する、正しい形の応答を作る。 */
function reply(
  request: Buffer,
  t2: number,
  t3: number,
  opts: { stratum?: number; li?: number; mode?: number; origin?: Buffer } = {},
): Buffer {
  const buf = Buffer.alloc(48)
  buf[0] = ((opts.li ?? 0) << 6) | (4 << 3) | (opts.mode ?? 4)
  buf[1] = opts.stratum ?? 1
  ;(opts.origin ?? request.subarray(40, 48)).copy(buf, 24)
  writeNtpTime(buf, 32, t2)
  writeNtpTime(buf, 40, t3)
  return buf
}

describe('buildSntpRequest', () => {
  it('48 バイトの版 4・依頼側の要求で、送信時刻の欄に合言葉を入れる', () => {
    const nonce = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
    const req = buildSntpRequest(nonce)
    expect(req.length).toBe(48)
    expect(req[0]).toBe(0x23)
    expect(req.subarray(40, 48)).toEqual(nonce)
  })
})

describe('parseSntpReply', () => {
  const nonce = Buffer.from([9, 9, 9, 9, 1, 2, 3, 4])
  const req = buildSntpRequest(nonce)

  it('受け取った時刻と送った時刻を unix ミリ秒で読む', () => {
    const r = parseSntpReply(reply(req, 1_793_000_000_123, 1_793_000_000_124), nonce)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.receiveMs).toBeCloseTo(1_793_000_000_123, 0)
    expect(r.transmitMs).toBeCloseTo(1_793_000_000_124, 0)
    expect(r.stratum).toBe(1)
  })

  it('合言葉が返ってこない応答は採らない（別の要求への応答・なりすまし）', () => {
    const r = parseSntpReply(reply(req, 1, 2, { origin: Buffer.alloc(8) }), nonce)
    expect(r).toEqual({ ok: false, reason: 'origin' })
  })

  it('相手が自分の時計を合わせていない応答（閏指示子 3・階層 0）は採らない', () => {
    expect(parseSntpReply(reply(req, 1, 2, { li: 3 }), nonce)).toEqual({ ok: false, reason: 'unsynchronized' })
    expect(parseSntpReply(reply(req, 1, 2, { stratum: 0 }), nonce)).toEqual({ ok: false, reason: 'unsynchronized' })
  })

  it('配り手の応答でないもの・短いものは採らない', () => {
    expect(parseSntpReply(reply(req, 1, 2, { mode: 3 }), nonce)).toEqual({ ok: false, reason: 'mode' })
    expect(parseSntpReply(Buffer.alloc(47), nonce)).toEqual({ ok: false, reason: 'short' })
  })
})

describe('anchorFromExchange', () => {
  it('往復から相手の処理時間を引き、片道ぶんを送った時刻へ足した時点を真の時刻とする', () => {
    // 送ってから受け取るまで単調時計で 40 ms、相手の中で 2 ms → 往復 38 ms・片道 19 ms
    const a = anchorFromExchange({ sentMonoMs: 1_000, receivedMonoMs: 1_040, serverReceiveMs: 5_000, serverTransmitMs: 5_002 })
    expect(a.rttMs).toBe(38)
    expect(a.monoMs).toBe(1_040)
    expect(a.trueMs).toBe(5_021)
  })

  it('相手の処理時間が往復より長く見える（相手の時計の刻みの粗さ）ときは往復を 0 にする', () => {
    const a = anchorFromExchange({ sentMonoMs: 0, receivedMonoMs: 1, serverReceiveMs: 100, serverTransmitMs: 105 })
    expect(a.rttMs).toBe(0)
    expect(a.trueMs).toBe(105)
  })
})

describe('hostClockSyncDelayMs', () => {
  it('合わせられている間は 15 分ごと', () => {
    expect(hostClockSyncDelayMs(0)).toBe(HOST_CLOCK_INTERVAL_MS_DEFAULT)
  })

  it('続けて失敗している間は 10 秒から倍々（正）', () => {
    expect(hostClockSyncDelayMs(1)).toBe(10_000)
    expect(hostClockSyncDelayMs(2)).toBe(20_000)
    expect(hostClockSyncDelayMs(7)).toBe(640_000)
  })

  it('倍々は 15 分で止める（安全弁）', () => {
    expect(hostClockSyncDelayMs(8)).toBe(HOST_CLOCK_INTERVAL_MS_DEFAULT)
    expect(hostClockSyncDelayMs(10_000)).toBe(HOST_CLOCK_INTERVAL_MS_DEFAULT)
  })
})

/** 偽の単調時計と OS の時計、相手を差し替えられる時計を作る。 */
function harness(opts: { osAheadMs?: number; maxRttMs?: number; log?: HostClockOptions['log'] } = {}) {
  let mono = 10_000
  let trueNow = 1_793_000_000_000
  let osAhead = opts.osAheadMs ?? 0
  let serverBias = 0
  const advance = (ms: number) => {
    mono += ms
    trueNow += ms
  }
  const answers = new Map<string, (req: Buffer) => Promise<Buffer>>()
  const resolveFails = new Set<string>()
  let resolveDelayMs = 0
  const asked: string[] = []
  const exchange: SntpExchange = async (address, req) => {
    asked.push(address)
    const answer = answers.get(address)
    if (answer === undefined) throw new Error('時間切れ')
    return answer(req)
  }
  /** 片道 halfMs で、真の時刻（＋ serverBias）を返す相手。 */
  const honest = (halfMs: number) => async (req: Buffer) => {
    advance(halfMs)
    const t = trueNow + serverBias
    advance(halfMs)
    return reply(req, t, t)
  }
  const logs: string[] = []
  const clock = new HostClock({
    servers: ['ntp.nict.jp', 'pool.ntp.org'],
    resolve: async (server) => {
      advance(resolveDelayMs)
      if (resolveFails.has(server)) throw new Error('ENOTFOUND')
      return server
    },
    exchange,
    mono: () => mono,
    wall: () => trueNow + osAhead,
    maxRttMs: opts.maxRttMs ?? 1_000,
    log: opts.log ?? ((level, kind, line) => logs.push(`${level} ${kind} ${line}`)),
  })
  return {
    clock,
    answers,
    honest,
    advance,
    asked,
    logs,
    resolveFails,
    trueNow: () => trueNow,
    /** 単調時計を止めたまま、真の時刻と OS の時計だけを進める（休止の間に単調時計が止まる環境）。 */
    sleepWithMonoStopped: (ms: number) => {
      trueNow += ms
    },
    setOsAhead: (ms: number) => {
      osAhead = ms
    },
    setServerBias: (ms: number) => {
      serverBias = ms
    },
    setResolveDelay: (ms: number) => {
      resolveDelayMs = ms
    },
  }
}

describe('HostClock', () => {
  it('一度も合わせていない間は OS の時計を返し、その旨を名乗る（倒し先）', () => {
    const h = harness({ osAheadMs: 300 })
    expect(h.clock.now()).toBe(h.trueNow() + 300)
    expect(h.clock.snapshot().source).toBe('os')
  })

  it('合わせた後は OS の時計がずれていても真の時刻を返す（正）', async () => {
    const h = harness({ osAheadMs: 300 })
    h.answers.set('ntp.nict.jp', h.honest(18))
    await h.clock.syncNow('起動')
    expect(h.clock.now()).toBe(h.trueNow())
    const s = h.clock.snapshot()
    expect(s.source).toBe('ntp')
    expect(s.server).toBe('ntp.nict.jp')
    expect(s.lastRttMs).toBe(36)
    expect(s.offsetFromOsMs).toBe(-300)
    expect(s.syncedAtMs).toBe(h.trueNow())
    expect(h.logs.some((l) => l.startsWith('info synced [time] ntp.nict.jp で時計を合わせた'))).toBe(true)
  })

  it('合わせた後に OS の時計が跳んでも、単調時計で進めるので引きずられない', async () => {
    const h = harness()
    h.answers.set('ntp.nict.jp', h.honest(10))
    await h.clock.syncNow('起動')
    // 休止からの復帰で OS の時計が CMOS から読み直されて跳んだ
    h.setOsAhead(290)
    h.advance(118_000)
    expect(h.clock.now()).toBe(h.trueNow())
    // OS の時計の 1 秒未満の跳びでは倒さない（対照）
    expect(h.clock.checkAgainstOs()).toBeNull()
    expect(h.clock.snapshot().source).toBe('ntp')
  })

  it('単調時計と OS の時計が食い違ったら、まず合わせ直す。合わせ直せれば OS の時計へは倒さない（正）', async () => {
    const h = harness({ osAheadMs: 200 })
    h.answers.set('ntp.nict.jp', h.honest(10))
    await h.clock.syncNow('起動')
    h.sleepWithMonoStopped(3_600_000)
    // 気づく前は 1 時間遅れた時刻を返している
    expect(h.clock.now()).toBe(h.trueNow() - 3_600_000)
    const recovering = h.clock.checkAgainstOs()
    expect(recovering).not.toBeNull()
    await recovering
    expect(h.clock.now()).toBe(h.trueNow())
    const s = h.clock.snapshot()
    expect(s.source).toBe('ntp')
    expect(s.osFallbacks).toBe(0)
  })

  it('食い違ったうえに合わせ直せなければ、OS の時計へ倒して 1 行残す（安全弁）', async () => {
    const h = harness({ osAheadMs: 200 })
    h.answers.set('ntp.nict.jp', h.honest(10))
    await h.clock.syncNow('起動')
    h.answers.clear()
    h.sleepWithMonoStopped(3_600_000)
    await h.clock.checkAgainstOs()
    expect(h.clock.now()).toBe(h.trueNow() + 200)
    const s = h.clock.snapshot()
    expect(s.source).toBe('os')
    expect(s.osFallbacks).toBe(1)
    expect(s.consecutiveFailures).toBe(1)
    expect(h.logs.some((l) => l.startsWith('warn os-fallback [time] 単調時計と OS の時計の進みが'))).toBe(true)
  })

  it('立て直しの最中に毎秒呼ばれても、相手へ重ねて訊かない', async () => {
    const h = harness()
    h.answers.set('ntp.nict.jp', h.honest(10))
    await h.clock.syncNow('起動')
    h.asked.length = 0
    h.sleepWithMonoStopped(3_600_000)
    const a = h.clock.checkAgainstOs()
    const b = h.clock.checkAgainstOs()
    expect(b).toBe(a)
    await a
    expect(h.asked).toEqual(['ntp.nict.jp'])
  })

  it('一度も合わせていない間は、OS の時計と比べても何もしない（安全弁）', () => {
    const h = harness()
    h.sleepWithMonoStopped(3_600_000)
    expect(h.clock.checkAgainstOs()).toBeNull()
    expect(h.clock.snapshot().osFallbacks).toBe(0)
  })

  it('1 台目が答えなければ 2 台目に訊く', async () => {
    const h = harness()
    h.answers.set('pool.ntp.org', h.honest(30))
    await h.clock.syncNow('起動')
    expect(h.asked).toEqual(['ntp.nict.jp', 'pool.ntp.org'])
    expect(h.clock.snapshot().server).toBe('pool.ntp.org')
  })

  it('名前を引けなかった相手は飛ばし、理由を残す', async () => {
    const h = harness()
    h.resolveFails.add('ntp.nict.jp')
    h.answers.set('ntp.nict.jp', h.honest(10))
    h.answers.set('pool.ntp.org', h.honest(10))
    await h.clock.syncNow('起動')
    expect(h.asked).toEqual(['pool.ntp.org'])
    expect(h.clock.snapshot().server).toBe('pool.ntp.org')
  })

  it('名前の引き当てにかかった時間は往復に入れない', async () => {
    const h = harness({ maxRttMs: 200 })
    h.setResolveDelay(150)
    h.answers.set('ntp.nict.jp', h.honest(18))
    await h.clock.syncNow('起動')
    expect(h.clock.snapshot().lastRttMs).toBe(36)
    expect(h.clock.now()).toBe(h.trueNow())
  })

  it('往復が長すぎる応答は採らない（片道の見積もりが粗すぎる）', async () => {
    const h = harness({ osAheadMs: 300, maxRttMs: 500 })
    h.answers.set('ntp.nict.jp', h.honest(400))
    h.answers.set('pool.ntp.org', h.honest(400))
    await h.clock.syncNow('起動')
    expect(h.clock.snapshot().source).toBe('os')
    expect(h.clock.now()).toBe(h.trueNow() + 300)
  })

  it('往復が上限ちょうどの応答は採る（対照）', async () => {
    const h = harness({ maxRttMs: 500 })
    h.answers.set('ntp.nict.jp', h.honest(250))
    await h.clock.syncNow('起動')
    expect(h.clock.snapshot().source).toBe('ntp')
  })

  it('往復が上限を 1 ms 超える応答は採らない（境の向こう側）', async () => {
    const h = harness({ maxRttMs: 500 })
    h.answers.set('ntp.nict.jp', h.honest(250.5))
    h.answers.set('pool.ntp.org', h.honest(250.5))
    await h.clock.syncNow('起動')
    expect(h.clock.snapshot().source).toBe('os')
    expect(h.clock.snapshot().lastError).toContain('上限 500 ms')
  })

  it('どちらも答えなければ OS の時計のまま、失敗を数えて 1 行残す', async () => {
    const h = harness({ osAheadMs: 300 })
    await h.clock.syncNow('起動')
    const s = h.clock.snapshot()
    expect(s.source).toBe('os')
    expect(s.failures).toBe(1)
    expect(s.consecutiveFailures).toBe(1)
    expect(s.lastError).toContain('ntp.nict.jp')
    expect(s.lastError).toContain('pool.ntp.org')
    expect(h.logs.some((l) => l.startsWith('warn sync-failed [time] 時計を合わせられなかった'))).toBe(true)
  })

  it('続けて失敗している間は早めに取り直し、合わせられたら 15 分へ戻る', async () => {
    const h = harness()
    await h.clock.syncNow('起動')
    expect(h.clock.nextSyncDelayMs()).toBe(10_000)
    await h.clock.syncNow('定期')
    expect(h.clock.nextSyncDelayMs()).toBe(20_000)
    h.answers.set('ntp.nict.jp', h.honest(10))
    await h.clock.syncNow('定期')
    expect(h.clock.snapshot().consecutiveFailures).toBe(0)
    expect(h.clock.nextSyncDelayMs()).toBe(HOST_CLOCK_INTERVAL_MS_DEFAULT)
  })

  it('一度合わせた後に取り直しが失敗しても、前に合わせた時点から進め続ける（安全弁）', async () => {
    const h = harness({ osAheadMs: 300 })
    h.answers.set('ntp.nict.jp', h.honest(10))
    await h.clock.syncNow('起動')
    h.answers.clear()
    h.advance(60_000)
    await h.clock.syncNow('定期')
    expect(h.clock.now()).toBe(h.trueNow())
    expect(h.clock.snapshot().source).toBe('ntp')
    expect(h.clock.snapshot().failures).toBe(1)
    expect(h.logs.some((l) => l.startsWith('warn sync-failed [time] 時計を合わせ直せなかった'))).toBe(true)
  })

  it('相手が投げたのが Error でなくても、取り直しは投げずに失敗として数える', async () => {
    const h = harness()
    h.answers.set('ntp.nict.jp', async () => {
      throw 'おかしな値'
    })
    await expect(h.clock.syncNow('起動')).resolves.toBeUndefined()
    expect(h.clock.snapshot().lastError).toContain('おかしな値')
  })

  it('ログを出す側が投げても、取り直しは投げない', async () => {
    const h = harness({
      log: () => {
        throw new Error('書けない')
      },
    })
    await expect(h.clock.syncNow('起動')).resolves.toBeUndefined()
    expect(h.clock.snapshot().failures).toBe(1)
  })

  it('同時に呼ばれた取り直しは 1 回の問い合わせに相乗りする', async () => {
    const h = harness()
    h.answers.set('ntp.nict.jp', h.honest(10))
    await Promise.all([h.clock.syncNow('定期'), h.clock.syncNow('処理の止まり明け')])
    expect(h.asked).toEqual(['ntp.nict.jp'])
  })

  it('取り直しで時刻が動いた幅を覚える。50 ms 未満は黙る（対照）', async () => {
    const h = harness()
    h.answers.set('ntp.nict.jp', h.honest(0))
    await h.clock.syncNow('起動')
    expect(h.clock.snapshot().lastStepMs).toBeNull()
    h.advance(1_000)
    h.setServerBias(49)
    await h.clock.syncNow('定期')
    expect(h.clock.snapshot().lastStepMs).toBe(49)
    expect(h.logs.some((l) => l.includes('動いた'))).toBe(false)
  })

  it('取り直しで時刻が 50 ms 以上動いたら 1 行出す（正）', async () => {
    const h = harness()
    h.answers.set('ntp.nict.jp', h.honest(0))
    await h.clock.syncNow('起動')
    h.advance(1_000)
    h.setServerBias(60)
    await h.clock.syncNow('定期')
    expect(h.clock.snapshot().lastStepMs).toBe(60)
    expect(h.logs.some((l) => l.startsWith('warn step [time] ntp.nict.jp で合わせ直して時刻が 60 ms 動いた'))).toBe(true)
  })

  it('時刻が 1 秒以内で後ろへ動いたら、追いつくまで前に返した値を返す', async () => {
    const h = harness()
    h.answers.set('ntp.nict.jp', h.honest(0))
    await h.clock.syncNow('起動')
    h.advance(1_000)
    const before = h.clock.now()
    h.setServerBias(-300)
    await h.clock.syncNow('定期')
    expect(h.clock.snapshot().lastStepMs).toBe(-300)
    expect(h.clock.now()).toBe(before)
    h.advance(100)
    expect(h.clock.now()).toBe(before)
    h.advance(300)
    expect(h.clock.now()).toBe(h.trueNow() - 300)
  })

  it('1 秒を超えて後ろへ動いたときは据え置かない（安全弁）', async () => {
    const h = harness()
    h.answers.set('ntp.nict.jp', h.honest(0))
    await h.clock.syncNow('起動')
    h.advance(1_000)
    h.clock.now()
    h.setServerBias(-2_000)
    await h.clock.syncNow('定期')
    expect(h.clock.now()).toBe(h.trueNow() - 2_000)
  })
})

describe('udpSntpExchange', () => {
  const sockets: dgram.Socket[] = []
  afterEach(() => {
    for (const s of sockets.splice(0)) s.close()
  })

  async function bindLocal(onMessage: (sock: dgram.Socket, msg: Buffer, rinfo: dgram.RemoteInfo) => void) {
    const sock = dgram.createSocket('udp4')
    sockets.push(sock)
    sock.on('message', (msg, rinfo) => onMessage(sock, msg, rinfo))
    await new Promise<void>((resolve) => sock.bind(0, '127.0.0.1', resolve))
    return (sock.address() as AddressInfo).port
  }

  it('手元の相手へ送り、返ってきた応答を返す', async () => {
    const port = await bindLocal((sock, msg, rinfo) => sock.send(reply(msg, 1, 2), rinfo.port, rinfo.address))
    const req = buildSntpRequest(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))
    const res = await udpSntpExchange(1_000, port)('127.0.0.1', req)
    expect(res.subarray(24, 32)).toEqual(req.subarray(40, 48))
  })

  it('答えない相手は打ち切りで投げる', async () => {
    const port = await bindLocal(() => {})
    const req = buildSntpRequest(Buffer.alloc(8))
    await expect(udpSntpExchange(50, port)('127.0.0.1', req)).rejects.toThrow('50 ms で応答が無かった')
  })
})
