import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  LOCK_RETRY_DELAYS_MS,
  LOCK_RETRY_LOG_INTERVAL_MS,
  isLockError,
  lockTolerantRename,
  lockTolerantRenameSync,
  retriedLogLine,
  type LockRetried,
} from './lockTolerantRename'

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: rename`), { code })
}

/** 最初の `fails` 回だけ `code` で落ちる rename の偽物。呼ばれた回数を数える。 */
function flakyRename(fails: number, code = 'EPERM') {
  let calls = 0
  return {
    impl: (): void => {
      calls += 1
      if (calls <= fails) throw errno(code)
    },
    calls: () => calls,
  }
}

describe('isLockError', () => {
  it('Windows の EPERM・EACCES・EBUSY だけを掴まれた失敗とみなす', () => {
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) expect(isLockError(errno(code), 'win32')).toBe(true)
    expect(isLockError(errno('ENOENT'), 'win32')).toBe(false)
    expect(isLockError(new Error('符号なし'), 'win32')).toBe(false)
    expect(isLockError(null, 'win32')).toBe(false)
  })

  it('Windows 以外では、同じ符号でも掴まれた失敗とみなさない', () => {
    expect(isLockError(errno('EPERM'), 'linux')).toBe(false)
    expect(isLockError(errno('EBUSY'), 'darwin')).toBe(false)
  })
})

describe('lockTolerantRenameSync', () => {
  it('正: Windows で 2 回 EPERM が出ても、待ってやり直して通り、通ったことを知らせる', () => {
    const r = flakyRename(2)
    const slept: number[] = []
    const retried: LockRetried[] = []
    lockTolerantRenameSync('a.tmp', 'a', {
      platform: 'win32',
      renameImpl: r.impl,
      sleepImpl: (ms) => slept.push(ms),
      onRetried: (info) => retried.push(info),
    })
    expect(r.calls()).toBe(3)
    expect(slept).toEqual([10, 20])
    expect(retried).toEqual([{ from: 'a.tmp', to: 'a', retries: 2, code: 'EPERM', ok: true }])
  })

  it('対照: 1 回目で通れば待たず、知らせも出さない', () => {
    const r = flakyRename(0)
    const slept: number[] = []
    const retried: LockRetried[] = []
    lockTolerantRenameSync('a.tmp', 'a', {
      platform: 'win32',
      renameImpl: r.impl,
      sleepImpl: (ms) => slept.push(ms),
      onRetried: (info) => retried.push(info),
    })
    expect(r.calls()).toBe(1)
    expect(slept).toEqual([])
    expect(retried).toEqual([])
  })

  it('対照: 掴まれた失敗でなければ（ENOENT）待たずにそのまま投げ、知らせも出さない', () => {
    const r = flakyRename(1, 'ENOENT')
    const slept: number[] = []
    const retried: LockRetried[] = []
    expect(() =>
      lockTolerantRenameSync('a.tmp', 'a', {
        platform: 'win32',
        renameImpl: r.impl,
        sleepImpl: (ms) => slept.push(ms),
        onRetried: (info) => retried.push(info),
      }),
    ).toThrow(/ENOENT/)
    expect(r.calls()).toBe(1)
    expect(slept).toEqual([])
    expect(retried).toEqual([])
  })

  it('安全弁: EPERM が続けば上限（6 回・合計 630 ms）で諦め、最後の EPERM をそのまま投げ、諦めたことを知らせる', () => {
    const r = flakyRename(Number.POSITIVE_INFINITY)
    const slept: number[] = []
    const retried: LockRetried[] = []
    let thrown: unknown
    try {
      lockTolerantRenameSync('a.tmp', 'a', {
        platform: 'win32',
        renameImpl: r.impl,
        sleepImpl: (ms) => slept.push(ms),
        onRetried: (info) => retried.push(info),
      })
    } catch (error) {
      thrown = error
    }
    expect((thrown as NodeJS.ErrnoException).code).toBe('EPERM')
    expect(r.calls()).toBe(LOCK_RETRY_DELAYS_MS.length + 1)
    expect(slept).toEqual([...LOCK_RETRY_DELAYS_MS])
    expect(slept.reduce((a, b) => a + b, 0)).toBe(630)
    expect(retried).toEqual([{ from: 'a.tmp', to: 'a', retries: LOCK_RETRY_DELAYS_MS.length, code: 'EPERM', ok: false }])
  })

  it('安全弁: Windows 以外では EPERM でもやり直さない（待っても直らない失敗を遅らせない）', () => {
    const r = flakyRename(1)
    const slept: number[] = []
    expect(() =>
      lockTolerantRenameSync('a.tmp', 'a', { platform: 'linux', renameImpl: r.impl, sleepImpl: (ms) => slept.push(ms) }),
    ).toThrow(/EPERM/)
    expect(r.calls()).toBe(1)
    expect(slept).toEqual([])
  })

  it('安全弁: 知らせる側が投げても、置き換えは成功のまま（もう一度 rename しない）', () => {
    const r = flakyRename(1)
    expect(() =>
      lockTolerantRenameSync('a.tmp', 'a', {
        platform: 'win32',
        renameImpl: r.impl,
        sleepImpl: () => {},
        onRetried: () => {
          throw errno('EPIPE')
        },
      }),
    ).not.toThrow()
    expect(r.calls()).toBe(2)
  })
})

describe('lockTolerantRename（非同期版）', () => {
  it('正: Windows で 3 回 EBUSY が出ても、待ってやり直して通る', async () => {
    const r = flakyRename(3, 'EBUSY')
    const slept: number[] = []
    const retried: LockRetried[] = []
    await lockTolerantRename('a.tmp', 'a', {
      platform: 'win32',
      renameImpl: async () => r.impl(),
      sleepImpl: async (ms) => {
        slept.push(ms)
      },
      onRetried: (info) => retried.push(info),
    })
    expect(r.calls()).toBe(4)
    expect(slept).toEqual([10, 20, 40])
    expect(retried).toEqual([{ from: 'a.tmp', to: 'a', retries: 3, code: 'EBUSY', ok: true }])
  })

  it('対照: 掴まれた失敗でなければ待たずにそのまま投げる', async () => {
    const r = flakyRename(1, 'ENOENT')
    const slept: number[] = []
    await expect(
      lockTolerantRename('a.tmp', 'a', {
        platform: 'win32',
        renameImpl: async () => r.impl(),
        sleepImpl: async (ms) => {
          slept.push(ms)
        },
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(slept).toEqual([])
  })

  it('安全弁: EPERM が続けば上限で諦め、最後の EPERM をそのまま投げ、諦めたことを知らせる', async () => {
    const r = flakyRename(Number.POSITIVE_INFINITY)
    const slept: number[] = []
    const retried: LockRetried[] = []
    await expect(
      lockTolerantRename('a.tmp', 'a', {
        platform: 'win32',
        renameImpl: async () => r.impl(),
        sleepImpl: async (ms) => {
          slept.push(ms)
        },
        onRetried: (info) => retried.push(info),
      }),
    ).rejects.toMatchObject({ code: 'EPERM' })
    expect(r.calls()).toBe(LOCK_RETRY_DELAYS_MS.length + 1)
    expect(slept).toEqual([...LOCK_RETRY_DELAYS_MS])
    expect(retried.map((x) => x.ok)).toEqual([false])
  })

  it('安全弁: 知らせる側が投げても、置き換えは成功のまま', async () => {
    const r = flakyRename(1)
    await expect(
      lockTolerantRename('a.tmp', 'a', {
        platform: 'win32',
        renameImpl: async () => r.impl(),
        sleepImpl: async () => {},
        onRetried: () => {
          throw errno('EPIPE')
        },
      }),
    ).resolves.toBeUndefined()
    expect(r.calls()).toBe(2)
  })
})

describe('retriedLogLine（既定のログの行）', () => {
  const ok = (to: string): LockRetried => ({ from: `${to}.tmp`, to, retries: 2, code: 'EPERM', ok: true })

  it('正: 通ったときは、何を何へ置き換えたか・符号・待った回数を 1 行で出す', () => {
    const book = new Map()
    expect(retriedLogLine(ok('a'), 0, book)).toBe('[fs] a.tmp → a の置き換えが掴まれていた（EPERM）。2 回待って通した')
  })

  it('正: 同じ置き換え先の「通った」は 10 分に 1 回へ間引き、次の行に間引いた回数を添える', () => {
    const book = new Map()
    expect(retriedLogLine(ok('a'), 0, book)).not.toBeNull()
    expect(retriedLogLine(ok('a'), 5_000, book)).toBeNull()
    expect(retriedLogLine(ok('a'), 10_000, book)).toBeNull()
    expect(retriedLogLine(ok('a'), LOCK_RETRY_LOG_INTERVAL_MS, book)).toBe(
      '[fs] a.tmp → a の置き換えが掴まれていた（EPERM）。2 回待って通した（前の行から 2 回は書かずにおいた）',
    )
  })

  it('対照: 別の置き換え先は間引かない', () => {
    const book = new Map()
    expect(retriedLogLine(ok('a'), 0, book)).not.toBeNull()
    expect(retriedLogLine(ok('b'), 1, book)).not.toBeNull()
  })

  it('安全弁: 通らなかったときは間引かない（呼び出し側の失敗の記録と突き合わせられるように）', () => {
    const book = new Map()
    expect(retriedLogLine(ok('a'), 0, book)).not.toBeNull()
    expect(retriedLogLine({ ...ok('a'), retries: 6, ok: false }, 1, book)).toBe(
      '[fs] a.tmp → a の置き換えが掴まれていた（EPERM）。6 回待っても通らなかった',
    )
  })
})

// **本物の掴みで確かめる（Windows だけ）。** 外のプロセス（PowerShell）がファイルを削除の共有なしで開く ——
// ウイルス対策・索引が書いた直後のファイルを読みに来るのと同じ形。CI（Linux）では飛ぶ。
// **離すのは時間ではなく合図で決める。** 時間で離すと、重い全件並列で PowerShell が遅れて上限（630 ms）を
// 超え、落ちる（実際に落ちた）。ここでは 1 回目の失敗の後の「待ち」の中で離させるので、
// 「掴まれている間は本物の EPERM・離した後は本物の rename が通る」を負荷によらず確かめられる。
describe.runIf(process.platform === 'win32')('本物の掴み（Windows）', () => {
  let base: string
  const holders: Holder[] = []

  interface Holder {
    /** 掴みを離し、離し終えるまで待つ。何度呼んでもよい。 */
    readonly release: () => Promise<void>
  }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'lock-rename-'))
  })

  afterEach(async () => {
    // 途中で落ちたテストの掴みも離してから消す（残ると rmSync が EPERM で落ち、元の失敗を隠す）
    for (const h of holders.splice(0)) await h.release()
    rmSync(base, { recursive: true, force: true, maxRetries: 5 })
  })

  /** `paths` を削除の共有なしで開いた PowerShell を立てる。開けた時点で解決する。標準入力の 1 行で離す。 */
  function hold(paths: string[]): Promise<Holder> {
    // パスは環境変数で渡す（命令文へ埋め込むと ' を含むパスで壊れる。-Command の後ろの引数は $args に入らない）。
    // 区切りの | は Windows のパスに使えない文字
    const script =
      "$hs = @($env:LOCK_HOLD_PATHS -split '\\|' | ForEach-Object { [IO.File]::Open($_,'Open','Read','ReadWrite') }); " +
      "'HELD'; [Console]::In.ReadLine() | Out-Null; $hs | ForEach-Object { $_.Close() }; 'RELEASED'"
    const ps: ChildProcess = spawn('powershell.exe', ['-NoProfile', '-Command', script], {
      env: { ...process.env, LOCK_HOLD_PATHS: paths.join('|') },
    })
    let stdout = ''
    let stderr = ''
    const exited = new Promise<void>((resolve) => ps.on('exit', () => resolve()))
    ps.stderr?.on('data', (d) => {
      stderr += String(d)
    })
    let releasing: Promise<void> | null = null
    const holder: Holder = {
      release: () => {
        releasing ??= (async () => {
          if (ps.exitCode === null) ps.stdin?.end('\n')
          await exited
        })()
        return releasing
      },
    }
    holders.push(holder)
    return new Promise((resolve, reject) => {
      ps.stdout?.on('data', (d) => {
        stdout += String(d)
        if (stdout.includes('HELD')) resolve(holder)
      })
      ps.on('error', reject)
      ps.on('exit', (code) => reject(new Error(`PowerShell が掴む前に終わった（${code}）: ${stderr.trim()}`)))
    })
  }

  /** 1 回目の待ちで掴みを離す sleep。待った回数を数える。 */
  function releasingSleep(holder: Holder) {
    let calls = 0
    return {
      impl: async (): Promise<void> => {
        calls += 1
        if (calls === 1) await holder.release()
      },
      calls: () => calls,
    }
  }

  it('正: 置き換え先が掴まれていれば本物の EPERM で落ち、離された後に置き換わる（stations.xml の形）', async () => {
    const target = join(base, 'stations.xml')
    writeFileSync(target, 'OLD')
    writeFileSync(`${target}.tmp`, 'NEW')
    const holder = await hold([target])
    const sleep = releasingSleep(holder)
    const retried: LockRetried[] = []
    await lockTolerantRename(`${target}.tmp`, target, { sleepImpl: sleep.impl, onRetried: (info) => retried.push(info) })
    expect(readFileSync(target, 'utf8')).toBe('NEW')
    expect(existsSync(`${target}.tmp`)).toBe(false)
    expect(sleep.calls()).toBe(1)
    expect(retried).toEqual([{ from: `${target}.tmp`, to: target, retries: 1, code: 'EPERM', ok: true }])
  }, 30_000)

  it('正: 中身を掴まれたフォルダも本物の EPERM で落ち、離された後に改名できる（移行テストの old → away の形）', async () => {
    const from = join(base, 'old')
    mkdirSync(join(from, 'raw'), { recursive: true })
    const inner = join(from, 'raw', 'a.mseed3')
    writeFileSync(inner, 'RAW0')
    const holder = await hold([inner])
    const sleep = releasingSleep(holder)
    const retried: LockRetried[] = []
    await lockTolerantRename(from, join(base, 'away'), { sleepImpl: sleep.impl, onRetried: (info) => retried.push(info) })
    expect(existsSync(join(base, 'away', 'raw', 'a.mseed3'))).toBe(true)
    expect(sleep.calls()).toBe(1)
    expect(retried).toEqual([{ from, to: join(base, 'away'), retries: 1, code: 'EPERM', ok: true }])
  }, 30_000)

  it('安全弁: 掴まれたままなら上限で諦めて本物の EPERM を投げ、置き換え先は元のまま', async () => {
    const target = join(base, 'stations.xml')
    writeFileSync(target, 'OLD')
    writeFileSync(`${target}.tmp`, 'NEW')
    const holder = await hold([target])
    const retried: LockRetried[] = []
    await expect(
      lockTolerantRename(`${target}.tmp`, target, { sleepImpl: async () => {}, onRetried: (info) => retried.push(info) }),
    ).rejects.toMatchObject({ code: 'EPERM' })
    await holder.release()
    expect(readFileSync(target, 'utf8')).toBe('OLD')
    expect(retried.map((x) => x.ok)).toEqual([false])
  }, 30_000)
})

