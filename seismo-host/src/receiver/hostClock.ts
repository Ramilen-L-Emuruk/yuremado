// ホストが自分で合わせる時計。基板と同じ NTP の相手に SNTP で訊き、真の時刻を返す。
//
// **OS の時計に預けない。** Windows は起動・休止からの復帰のたびに時計を CMOS から読み直し、
// 秒より細かい値を持たないので 1 秒未満ずれて入る。しかも既定の設定では、インターネットの時刻へ
// 問い合わせるのが約 4.5 時間ごと（SpecialPollInterval 16384 秒）、ずれを寄せる調整が 1 時間に 1 回
// （UpdateInterval 360000）なので、そのずれが何時間も残る。2026-10-27 の実機では、起動の後に
// −120 ms、休止からの復帰の後に +290 ms ずれ、基板 4 枚の時計の警告（`boardClockVerdict.ts`）が
// そろって鳴り続けた（2026-10-27 ユーザー決定「基板と同じ NTP」）。
//
// **単調時計の上に載せる。** 真の時刻 = 合わせた時点の真の時刻 ＋ その後に単調時計が進んだ分。
// OS の時計が跳んでも引きずられない。単調時計そのものの進みの狂いは、15 分ごとの取り直しで吸収する。
//
// **単調時計が休止状態の間も進むとは決めつけない。** 2026-10-27 の実機では進んだ（`loopStall.ts` が
// 単調時計の差だけで電源を切っていた長さと同じ 118.2 秒を出した）が、確かめたのはその 1 回だけ。
// 進まなかったら、真の時刻は休止していた長さだけ遅れる。そこで OS の時計の進みと毎秒比べ
// （`checkAgainstOs`）、`HOST_CLOCK_OS_DIVERGENCE_MS_DEFAULT` を超えて食い違ったら合わせ直し、
// 合わせ直せなければ OS の時計へ倒す —— OS の時計のずれは 1 秒未満なので、何時間も遅れるよりずっと近い。
//
// **相手は基板と同じ**（`firmware/seismo-node/seismo-node.ino` の `configTime` と同じ順）。
// 物差しの出どころが揃うので、基板の時計の判定（`boardClock.ts`）が相手の違いを拾わない。
//
// **一度も合わせられていない間は OS の時計を返す。** 合わせた後に取り直しが失敗したときは、
// 前に合わせた時点から単調時計で進め続ける（OS の時計へ戻すと、起動直後のずれへ戻ってしまう）。

import { randomBytes } from 'node:crypto'
import dgram from 'node:dgram'
import { lookup } from 'node:dns/promises'

/** NTP の時刻（1900 年起点）と unix 時刻（1970 年起点）の差（秒）。 */
export const NTP_UNIX_OFFSET_SEC = 2_208_988_800

/** 訊く相手。基板と同じ順（`seismo-node.ino` の `configTime`）。 */
export const HOST_CLOCK_SERVERS_DEFAULT: readonly string[] = ['ntp.nict.jp', 'pool.ntp.org']

/** 取り直しの間隔。基板の取り直し（`SNTP_SYNC_INTERVAL_MS`）と揃える。 */
export const HOST_CLOCK_INTERVAL_MS_DEFAULT = 15 * 60 * 1000

/**
 * 合わせられなかった後の 1 回目の取り直しまでの待ち。以後は倍々にし、`HOST_CLOCK_INTERVAL_MS_DEFAULT` で止める。
 *
 * **15 分待たない。** サービスは起動直後や休止からの復帰直後にネットワークがまだ繋がっていないことが多い。
 * 15 分後に初めて合わさると、受信の最中に時刻が大きく動く。
 */
export const HOST_CLOCK_RETRY_FIRST_MS_DEFAULT = 10_000

/**
 * 採る応答の往復の上限（ミリ秒）。
 *
 * **片道の見積もりの誤差は往復の半分まで**なので、上限は誤差の上限を決める。基板の時計の警告の
 * 境（`CLOCK_OFFSET_WARN_MS` の 100 ms）を誤差で食わないよう、半分が 100 ms を超えない 200 ms にする。
 * 実機の往復は ntp.nict.jp で 36 ms、pool.ntp.org で 67 ms（2026-10-27）。往復には名前の引き当てを
 * 含めない（`runSync` が引き当てを済ませてから測り始める）。
 */
export const HOST_CLOCK_MAX_RTT_MS_DEFAULT = 200

/** 1 回の問い合わせの打ち切り（ミリ秒）。 */
export const HOST_CLOCK_QUERY_TIMEOUT_MS_DEFAULT = 3000

/**
 * 合わせ直しで時刻が動いた幅がこれ以上なら 1 行出す（ミリ秒）。
 *
 * 単調時計の進みの狂いは 15 分で数 ms に収まる。これを超える段差は、相手の応答か単調時計に何かあった印。
 */
export const HOST_CLOCK_STEP_WARN_MS_DEFAULT = 50

/**
 * 時刻が後ろへ動いたとき、追いつくまで値を据え置く上限（ミリ秒）。
 *
 * **受け取った時刻が前へしか進まないようにする**（途絶の判定・溜め置きの判定は時刻の差で測る）。
 * これより大きく戻ったときは据え置かない —— 何秒も同じ時刻を返し続けるほうが害が大きい。
 * 1 秒を超えて戻りうるのは、OS の時計のまま動いていた後に初めて合わさったとき（起動時に合わせられず、
 * 受信の最中に合わさった場合を含む）で、そのとき OS の時計が 1 秒より大きく進んでいたときに限る。
 * 起動・復帰でのずれは 1 秒未満なので、普通は起きない。
 */
export const HOST_CLOCK_BACKWARD_HOLD_MAX_MS_DEFAULT = 1000

/**
 * 単調時計と OS の時計の進みの食い違いがこれを超えたら、合わせ直し、できなければ OS の時計へ倒す（ミリ秒）。
 *
 * OS の時計は起動・復帰で 1 秒未満、w32time の調整で数百 ms 動く。それより十分大きく、
 * 休止の間に単調時計が止まったとき（休止の長さだけ食い違う）には必ず超える値にする。
 */
export const HOST_CLOCK_OS_DIVERGENCE_MS_DEFAULT = 5000

/** 依頼側の要求（48 バイト・版 4・モード 3）を作る。**送信時刻の欄に合言葉を入れる。** */
export function buildSntpRequest(nonce: Buffer): Buffer {
  const req = Buffer.alloc(48)
  req[0] = 0x23 // 閏指示子 0・版 4・依頼側
  nonce.copy(req, 40, 0, 8)
  return req
}

export type SntpReply =
  | { readonly ok: true; readonly receiveMs: number; readonly transmitMs: number; readonly stratum: number }
  | { readonly ok: false; readonly reason: 'short' | 'mode' | 'origin' | 'unsynchronized' | 'time' }

function readNtpTime(buf: Buffer, off: number): number {
  const sec = buf.readUInt32BE(off)
  const frac = buf.readUInt32BE(off + 4)
  return (sec - NTP_UNIX_OFFSET_SEC) * 1000 + (frac * 1000) / 2 ** 32
}

/**
 * 応答を読む。
 *
 * **送った合言葉が「元の送信時刻」の欄に返ってこない応答は採らない** —— 別の要求への遅れた応答や、
 * なりすましを弾く。相手が自分の時計を合わせていない応答（閏指示子 3、階層 0 の断り）も採らない。
 */
export function parseSntpReply(buf: Buffer, nonce: Buffer): SntpReply {
  if (buf.length < 48) return { ok: false, reason: 'short' }
  if ((buf[0] & 0x07) !== 4) return { ok: false, reason: 'mode' }
  if (!buf.subarray(24, 32).equals(nonce.subarray(0, 8))) return { ok: false, reason: 'origin' }
  const li = buf[0] >> 6
  const stratum = buf[1]
  if (li === 3 || stratum === 0) return { ok: false, reason: 'unsynchronized' }
  const receiveMs = readNtpTime(buf, 32)
  const transmitMs = readNtpTime(buf, 40)
  if (!Number.isFinite(receiveMs) || !Number.isFinite(transmitMs) || transmitMs <= 0) {
    return { ok: false, reason: 'time' }
  }
  return { ok: true, receiveMs, transmitMs, stratum }
}

export interface SntpTiming {
  readonly sentMonoMs: number
  readonly receivedMonoMs: number
  readonly serverReceiveMs: number
  readonly serverTransmitMs: number
}

export interface ClockAnchor {
  /** この時点の単調時計。 */
  readonly monoMs: number
  /** その時点の真の時刻（unix ミリ秒）。 */
  readonly trueMs: number
  /** 往復（相手の処理時間を除く）。 */
  readonly rttMs: number
}

/**
 * やり取り 1 回から、単調時計と真の時刻の対応を作る。
 *
 * 受け取った時点の真の時刻は「相手が送った時刻 ＋ 片道」。片道は往復の半分と見る（行きと帰りが
 * 同じ長さという前提。誤差は往復の半分まで）。往復は「送ってから受け取るまで」から「相手の中に
 * いた時間」を引いたもの。**相手の時計の刻みが粗いと負に見えることがあるので 0 で止める。**
 */
export function anchorFromExchange(t: SntpTiming): ClockAnchor {
  const rttMs = Math.max(0, t.receivedMonoMs - t.sentMonoMs - (t.serverTransmitMs - t.serverReceiveMs))
  return { monoMs: t.receivedMonoMs, trueMs: t.serverTransmitMs + rttMs / 2, rttMs }
}

/**
 * 次に合わせに行くまでの待ち（ミリ秒）。合わせられている間は `intervalMs`、
 * 続けて失敗している間は `firstRetryMs` から倍々にして `intervalMs` で止める。
 */
export function hostClockSyncDelayMs(
  consecutiveFailures: number,
  intervalMs: number = HOST_CLOCK_INTERVAL_MS_DEFAULT,
  firstRetryMs: number = HOST_CLOCK_RETRY_FIRST_MS_DEFAULT,
): number {
  if (consecutiveFailures <= 0) return intervalMs
  // 30 回を超えると 2 の累乗が大きくなりすぎるので、指数を先に止める
  const exp = Math.min(consecutiveFailures - 1, 30)
  return Math.min(intervalMs, firstRetryMs * 2 ** exp)
}

/** 相手の名前をアドレスへ引き当てる。引けなければ投げる。 */
export type HostResolver = (server: string) => Promise<string>

/** 相手（アドレス）へ要求を送り、応答を返す。届かなければ投げる。 */
export type SntpExchange = (address: string, request: Buffer) => Promise<Buffer>

export interface HostClockSnapshot {
  /** いま返している時刻の出どころ。`os` は合わせられていない（一度も・または OS の時計へ倒した）。 */
  readonly source: 'ntp' | 'os'
  /** 最後に合わせた相手。 */
  readonly server: string | null
  /** 最後に合わせた時刻（真の時刻）。 */
  readonly syncedAtMs: number | null
  /** 最後に合わせたときの往復（ミリ秒）。 */
  readonly lastRttMs: number | null
  /** いまの「この時計 − OS の時計」（ミリ秒）。正なら OS の時計が遅れている。 */
  readonly offsetFromOsMs: number
  /** 最後の取り直しで時刻が動いた幅（ミリ秒）。2 回目より前は null。 */
  readonly lastStepMs: number | null
  /** 合わせられた回数。 */
  readonly syncs: number
  /** 合わせられなかった回数（相手を全部試して駄目だった回）。 */
  readonly failures: number
  /** いま続けて合わせられていない回数。合わせられたら 0 へ戻る。 */
  readonly consecutiveFailures: number
  /** 単調時計と OS の時計が食い違って、OS の時計へ倒した回数。 */
  readonly osFallbacks: number
  /** 最後に合わせられなかった理由。 */
  readonly lastError: string | null
}

export interface HostClockOptions {
  readonly servers: readonly string[]
  readonly resolve: HostResolver
  readonly exchange: SntpExchange
  /** 単調時計（`performance.now()`）。 */
  readonly mono: () => number
  /** OS の時計（`Date.now()`）。 */
  readonly wall: () => number
  readonly maxRttMs: number
  /**
   * 1 行出す。合わせられなかったとき・時刻が大きく動いたとき・OS の時計へ倒したときは `warn`。
   * **`kind` は行の種類**（間引くときの鍵。種類が違えば別の枠で数える）。
   */
  readonly log: (level: 'info' | 'warn', kind: HostClockLogKind, line: string) => void
}

/** ログの行の種類。合わせた・合わせられなかった・合わせ直して動いた・OS の時計へ倒した。 */
export type HostClockLogKind = 'synced' | 'sync-failed' | 'step' | 'os-fallback'

interface AnchorState extends ClockAnchor {
  /** 合わせた時点の OS の時計。単調時計の進みと比べる起点。 */
  readonly wallMs: number
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export class HostClock {
  private readonly opts: HostClockOptions
  private anchor: AnchorState | null = null
  private server: string | null = null
  private lastStepMs: number | null = null
  private lastReturnedMs = -Infinity
  private syncs = 0
  private failures = 0
  private consecutiveFailures = 0
  private osFallbacks = 0
  private lastError: string | null = null
  private running: Promise<void> | null = null

  constructor(opts: HostClockOptions) {
    this.opts = opts
  }

  /**
   * いまの真の時刻（unix ミリ秒）。合わせられていなければ OS の時計。
   *
   * **後ろへは `HOST_CLOCK_BACKWARD_HOLD_MAX_MS_DEFAULT` まで動かさない** —— それ以内の巻き戻りは、
   * 追いつくまで前に返した値を返す。
   */
  now(): number {
    const raw = this.rawNow()
    const last = this.lastReturnedMs
    if (raw < last && last - raw <= HOST_CLOCK_BACKWARD_HOLD_MAX_MS_DEFAULT) return last
    this.lastReturnedMs = raw
    return raw
  }

  private rawNow(): number {
    const a = this.anchor
    if (a === null) return this.opts.wall()
    return a.trueMs + (this.opts.mono() - a.monoMs)
  }

  /** 合わせた時点からの「この時計 − OS の時計」の変わり幅。合わせていなければ null。 */
  private divergenceMs(): number | null {
    const a = this.anchor
    if (a === null) return null
    return this.rawNow() - this.opts.wall() - (a.trueMs - a.wallMs)
  }

  private recovering: Promise<void> | null = null

  /**
   * 単調時計の進みを OS の時計の進みと比べる。**毎秒呼ぶ。**
   *
   * 変わり幅が `HOST_CLOCK_OS_DIVERGENCE_MS_DEFAULT` を超えていたら、**まず合わせ直しを試し**、
   * 合わせ直せなかったときだけ OS の時計へ倒す。食い違いは「単調時計が止まった（休止）」でも
   * 「OS の時計が大きく動いた（手での変更など）」でも起き、どちらが正しいかは相手に訊くまで
   * 分からない。**訊けなかったときは OS の時計を採る** —— 休止の間に単調時計が止まると何時間も
   * 遅れるが、OS の時計のずれは起動・復帰で 1 秒未満（2026-10-27 の実機）。
   *
   * 食い違っていて立て直しを始めた（または立て直しの最中）ならその約束を返し、何もなければ null。
   */
  checkAgainstOs(): Promise<void> | null {
    if (this.recovering !== null) return this.recovering
    const drift = this.divergenceMs()
    if (drift === null || !(Math.abs(drift) > HOST_CLOCK_OS_DIVERGENCE_MS_DEFAULT)) return null
    const run = this.syncNow('単調時計と OS の時計の食い違い')
      .then(() => {
        const still = this.divergenceMs()
        if (still === null || !(Math.abs(still) > HOST_CLOCK_OS_DIVERGENCE_MS_DEFAULT)) return
        this.anchor = null
        this.osFallbacks += 1
        this.log(
          'warn',
          'os-fallback',
          `[time] 単調時計と OS の時計の進みが ${Math.round(still)} ms 食い違い、合わせ直せなかった。OS の時計へ倒す`,
        )
      })
      .finally(() => {
        this.recovering = null
      })
    this.recovering = run
    return run
  }

  /**
   * 合わせ直す。**同時に呼ばれたら、走っている 1 回に相乗りする**（相手へ重ねて訊かない）。
   * **投げない** —— 失敗は数えて記録する（呼び手は `void` で捨ててよい）。
   */
  syncNow(reason: string): Promise<void> {
    if (this.running !== null) return this.running
    const run = this.runSync(reason)
      .catch((e: unknown) => this.noteFailure(reason, `取り直しの途中で例外: ${errorText(e)}`))
      .finally(() => {
        this.running = null
      })
    this.running = run
    return run
  }

  private async runSync(reason: string): Promise<void> {
    const errors: string[] = []
    for (const server of this.opts.servers) {
      // **名前の引き当ては往復に入れない** —— 片道の見積もりに半分が乗る。
      let address: string
      try {
        address = await this.opts.resolve(server)
      } catch (e) {
        errors.push(`${server}: 名前を引けなかった（${errorText(e)}）`)
        continue
      }
      const nonce = randomBytes(8)
      const request = buildSntpRequest(nonce)
      let response: Buffer
      const sentMonoMs = this.opts.mono()
      try {
        response = await this.opts.exchange(address, request)
      } catch (e) {
        errors.push(`${server}: ${errorText(e)}`)
        continue
      }
      const receivedMonoMs = this.opts.mono()
      const parsed = parseSntpReply(response, nonce)
      if (!parsed.ok) {
        errors.push(`${server}: 応答を採らなかった（${parsed.reason}）`)
        continue
      }
      const next = anchorFromExchange({
        sentMonoMs,
        receivedMonoMs,
        serverReceiveMs: parsed.receiveMs,
        serverTransmitMs: parsed.transmitMs,
      })
      if (next.rttMs > this.opts.maxRttMs) {
        errors.push(`${server}: 往復 ${Math.round(next.rttMs)} ms が上限 ${this.opts.maxRttMs} ms を超えた`)
        continue
      }
      this.applyAnchor(next, server, reason)
      return
    }
    this.noteFailure(reason, errors.join('・'))
  }

  private applyAnchor(next: ClockAnchor, server: string, reason: string): void {
    const hadNtp = this.anchor !== null
    const before = this.rawNow()
    this.anchor = { ...next, wallMs: this.opts.wall() }
    this.server = server
    this.syncs += 1
    this.consecutiveFailures = 0
    const after = this.rawNow()
    const rtt = Math.round(next.rttMs)
    if (!hadNtp) {
      // **一度も合わせていない・OS の時計へ倒していた後は、OS の時計からの段差として出す。**
      this.lastStepMs = this.syncs === 1 ? null : after - before
      this.log(
        'info',
        'synced',
        `[time] ${server} で時計を合わせた（${reason}）。OS の時計との差 ${Math.round(after - this.opts.wall())} ms・往復 ${rtt} ms`,
      )
      return
    }
    const step = after - before
    this.lastStepMs = step
    if (Math.abs(step) >= HOST_CLOCK_STEP_WARN_MS_DEFAULT) {
      this.log(
        'warn',
        'step',
        `[time] ${server} で合わせ直して時刻が ${Math.round(step)} ms 動いた（${reason}・往復 ${rtt} ms）`,
      )
    }
  }

  private noteFailure(reason: string, detail: string): void {
    this.failures += 1
    this.consecutiveFailures += 1
    this.lastError = detail
    this.log(
      'warn',
      'sync-failed',
      this.anchor === null
        ? `[time] 時計を合わせられなかった（${reason}・${detail}）。OS の時計のまま動く`
        : `[time] 時計を合わせ直せなかった（${reason}・${detail}）。前に合わせた時点から進め続ける`,
    )
  }

  /**
   * 1 行出す。**出す側が投げても時計は止めない** —— 出せなかった行を知らせる先はもう無いので捨てる。
   * ここで投げると、失敗を数える処理そのものが投げ、`syncNow` の「投げない」が崩れる。
   */
  private log(level: 'info' | 'warn', kind: HostClockLogKind, line: string): void {
    try {
      this.opts.log(level, kind, line)
    } catch {
      // 上のとおり捨てる
    }
  }

  /** 次に合わせに行くまでの待ち（ミリ秒）。 */
  nextSyncDelayMs(): number {
    return hostClockSyncDelayMs(this.consecutiveFailures)
  }

  snapshot(): HostClockSnapshot {
    const a = this.anchor
    return {
      source: a === null ? 'os' : 'ntp',
      server: this.server,
      syncedAtMs: a === null ? null : Math.round(a.trueMs),
      lastRttMs: a === null ? null : Math.round(a.rttMs),
      offsetFromOsMs: Math.round(this.rawNow() - this.opts.wall()),
      lastStepMs: this.lastStepMs === null ? null : Math.round(this.lastStepMs),
      syncs: this.syncs,
      failures: this.failures,
      consecutiveFailures: this.consecutiveFailures,
      osFallbacks: this.osFallbacks,
      lastError: this.lastError,
    }
  }
}

/** 名前を IPv4 のアドレスへ引き当てる（`udpSntpExchange` が udp4 で送るため）。 */
export const dnsResolveIpv4: HostResolver = async (server) => (await lookup(server, { family: 4 })).address

/** UDP の 123 番（`port`）へ要求を送り、最初の応答を返す。打ち切りで投げる。 */
export function udpSntpExchange(timeoutMs: number = HOST_CLOCK_QUERY_TIMEOUT_MS_DEFAULT, port = 123): SntpExchange {
  return (address, request) =>
    new Promise<Buffer>((resolve, reject) => {
      const sock = dgram.createSocket('udp4')
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        sock.close()
        fn()
      }
      const timer = setTimeout(() => finish(() => reject(new Error(`${timeoutMs} ms で応答が無かった`))), timeoutMs)
      sock.on('message', (msg) => finish(() => resolve(msg)))
      sock.on('error', (e) => finish(() => reject(e)))
      // **同期で投げても閉じる** —— 投げたまま抜けると、ソケットと打ち切りのタイマーが残る。
      try {
        sock.send(request, port, address, (e) => {
          if (e) finish(() => reject(e))
        })
      } catch (e) {
        finish(() => reject(e))
      }
    })
}
