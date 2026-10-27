import { describe, expect, it } from 'vitest'

import {
  RedetectRunner,
  adaptRedetectChild,
  parseRedetectSummary,
  readRedetectSummaryFile,
  redetectArgs,
  redetectFailureReason,
} from './redetectRunner'
import type { ChildProcessLike, RedetectChild, RedetectExit, RedetectRequest } from './redetectRunner'

const DIRS = { wave: '/d/wave', events: '/d/events', stations: '/c/stations.xml' }
const REQ: RedetectRequest = { fromMs: Date.UTC(2026, 9, 3), toMs: Date.UTC(2026, 9, 4), stationId: null }

function exitOf(code: number | null, extra: Partial<RedetectExit> = {}): RedetectExit {
  return { code, signal: null, error: null, ...extra }
}

function fakeChild() {
  let listener: ((exit: RedetectExit) => void) | null = null
  let killed = 0
  const child: RedetectChild = {
    onExit: (l) => {
      listener = l
    },
    kill: () => {
      killed += 1
    },
  }
  return {
    child,
    exit: (code: number | null, extra: Partial<RedetectExit> = {}) => listener?.(exitOf(code, extra)),
    killed: () => killed,
  }
}

function setup(summary: string | null = null) {
  const spawned: (readonly string[])[] = []
  const children: ReturnType<typeof fakeChild>[] = []
  const lines: string[] = []
  let n = 0
  let clock = 1000
  const runner = new RedetectRunner({
    spawn: (args) => {
      spawned.push(args)
      const c = fakeChild()
      children.push(c)
      return c.child
    },
    summaryPath: () => `/tmp/summary-${++n}.json`,
    readSummary: () => summary,
    dirs: () => DIRS,
    now: () => clock,
    log: (l) => lines.push(l),
  })
  return { runner, spawned, children, lines, tick: (ms: number) => (clock += ms) }
}

describe('parseRedetectSummary', () => {
  it('正: 道具が書く形を読む', () => {
    expect(parseRedetectSummary('{"ok":true,"written":3,"existing":1,"problems":[],"warnings":["W"]}')).toEqual({
      ok: true,
      written: 3,
      existing: 1,
      problems: [],
      warnings: ['W'],
    })
  })

  it('安全弁: 形が違う・JSON でないなら null（「結果を読めなかった」へ倒す）', () => {
    expect(parseRedetectSummary('not json')).toBeNull()
    expect(parseRedetectSummary('{"ok":true,"written":-1,"existing":0,"problems":[],"warnings":[]}')).toBeNull()
    expect(parseRedetectSummary('{"ok":true,"written":1,"existing":0,"problems":[1],"warnings":[]}')).toBeNull()
  })

  it('安全弁: warnings が無い（前の版の道具）なら読めなかった扱い', () => {
    expect(parseRedetectSummary('{"ok":true,"written":1,"existing":0,"problems":[]}')).toBeNull()
  })
})

describe('redetectArgs', () => {
  it('正: 範囲を ISO で渡し、ホストと同じ置き場所と結果のファイルを指す', () => {
    expect(redetectArgs(REQ, DIRS, '/tmp/s.json')).toEqual([
      '--from',
      '2026-10-03T00:00:00.000Z',
      '--to',
      '2026-10-04T00:00:00.000Z',
      '--wave',
      '/d/wave',
      '--events',
      '/d/events',
      '--stations',
      '/c/stations.xml',
      '--summary',
      '/tmp/s.json',
    ])
  })

  it('正: 観測点を選んだときだけ --station を足す', () => {
    expect(redetectArgs({ ...REQ, stationId: 'sta1' }, DIRS, '/tmp/s.json').slice(-2)).toEqual(['--station', 'sta1'])
  })
})

describe('redetectFailureReason', () => {
  const ok = { ok: true, written: 1, existing: 0, problems: [], warnings: [] }
  it('正: 0 で終わり結果が ok なら理由なし', () => {
    expect(redetectFailureReason(exitOf(0), ok)).toBeNull()
  })
  it('正: 道具が理由を書いていれば、その文をそのまま繋いで出す', () => {
    expect(redetectFailureReason(exitOf(1), { ...ok, ok: false, problems: ['A', 'B'] })).toBe('A／B')
  })
  it('対照: 理由の文が無いまま 0 以外で終わったら終了コード', () => {
    expect(redetectFailureReason(exitOf(1), null)).toBe('終了コード 1')
  })
  it('正: シグナルで止まったら、終了コードではなくシグナルを言う', () => {
    expect(redetectFailureReason(exitOf(null, { signal: 'SIGTERM' }), null)).toBe('シグナル SIGTERM で止まった')
  })
  it('安全弁: 0 で終わっても結果を読めなければ成功と言わない', () => {
    expect(redetectFailureReason(exitOf(0), null)).toBe('結果を読めなかった')
  })
  it('起動できなかったときは、その理由を出す', () => {
    expect(redetectFailureReason(exitOf(null, { error: 'ENOENT' }), null)).toBe('起動できなかった: ENOENT')
  })
})

describe('RedetectRunner', () => {
  it('正: 始めると running になり、終わると結果の数を持って done になる', () => {
    const s = setup('{"ok":true,"written":2,"existing":5,"problems":[],"warnings":[]}')
    expect(s.runner.start(REQ)).toBe('started')
    expect(s.runner.current()).toEqual({ kind: 'running', startedAtMs: 1000, request: REQ })
    expect(s.spawned[0]).toContain('/tmp/summary-1.json')
    s.tick(60_000)
    s.children[0]!.exit(0)
    expect(s.runner.current()).toEqual({
      kind: 'done',
      startedAtMs: 1000,
      finishedAtMs: 61_000,
      request: REQ,
      ok: true,
      written: 2,
      existing: 5,
      reason: null,
      warnings: [],
    })
  })

  it('正: 成功でも道具の警告は持ち越し、ログに件数を添える', () => {
    const s = setup('{"ok":true,"written":1,"existing":0,"problems":[],"warnings":["[redetect] sta1: 読めなかった控えがある"]}')
    s.runner.start(REQ)
    s.children[0]!.exit(0)
    const st = s.runner.current()
    expect(st.kind === 'done' && st.ok).toBe(true)
    expect(st.kind === 'done' && st.warnings).toEqual(['[redetect] sta1: 読めなかった控えがある'])
    expect(s.lines.some((l) => l.includes('流せなかった所 1 件'))).toBe(true)
  })

  it('安全弁: 走っている間の 2 本目は断り、子を増やさない', () => {
    const s = setup()
    s.runner.start(REQ)
    expect(s.runner.start(REQ)).toBe('busy')
    expect(s.spawned).toHaveLength(1)
  })

  it('対照: 終わった後なら次を始められる', () => {
    const s = setup('{"ok":true,"written":0,"existing":0,"problems":[],"warnings":[]}')
    s.runner.start(REQ)
    s.children[0]!.exit(0)
    expect(s.runner.start(REQ)).toBe('started')
    expect(s.spawned).toHaveLength(2)
  })

  it('安全弁: 範囲が逆・読めないなら起こさない', () => {
    const s = setup()
    expect(s.runner.start({ ...REQ, fromMs: REQ.toMs })).toBe('bad-range')
    expect(s.runner.start({ ...REQ, fromMs: Number.NaN })).toBe('bad-range')
    expect(s.spawned).toHaveLength(0)
    expect(s.runner.current()).toEqual({ kind: 'idle' })
  })

  it('失敗したら道具の文を理由に持ち、ログにも残す', () => {
    const s = setup('{"ok":false,"written":1,"existing":0,"problems":["[redetect] 地震情報を取れなかった: HTTP 503"],"warnings":[]}')
    s.runner.start(REQ)
    s.children[0]!.exit(1)
    const st = s.runner.current()
    expect(st.kind === 'done' && st.reason).toBe('[redetect] 地震情報を取れなかった: HTTP 503')
    expect(s.lines.some((l) => l.includes('うまくいかなかった'))).toBe(true)
  })

  it('安全弁: 起こすところで投げても running のまま残さない', () => {
    const lines: string[] = []
    const runner = new RedetectRunner({
      spawn: () => {
        throw new Error('spawn EACCES')
      },
      summaryPath: () => '/tmp/s.json',
      readSummary: () => null,
      dirs: () => DIRS,
      now: () => 0,
      log: (l) => lines.push(l),
    })
    runner.start(REQ)
    const st = runner.current()
    expect(st.kind).toBe('done')
    expect(st.kind === 'done' && st.reason).toBe('起動できなかった: spawn EACCES')
  })

  it('安全弁: 始めのログで投げても running のまま残さない', () => {
    let calls = 0
    const runner = new RedetectRunner({
      spawn: () => {
        throw new Error('呼ばれないはず')
      },
      summaryPath: () => '/tmp/s.json',
      readSummary: () => null,
      dirs: () => DIRS,
      now: () => 0,
      log: () => {
        calls += 1
        if (calls === 1) throw new Error('ログを書けない')
      },
    })
    expect(runner.start(REQ)).toBe('started')
    const st = runner.current()
    expect(st.kind === 'done' && st.reason).toBe('起動できなかった: ログを書けない')
    // 2 本目を断らない（busy のまま固まらない）。
    expect(runner.start(REQ)).toBe('started')
  })

  it('安全弁: 終わりの知らせが 2 度来ても 1 度目の結果を保つ（error の後の exit など）', () => {
    const s = setup(null)
    s.runner.start(REQ)
    s.children[0]!.exit(null, { error: 'ENOENT' })
    s.children[0]!.exit(0)
    const st = s.runner.current()
    expect(st.kind === 'done' && st.reason).toBe('起動できなかった: ENOENT')
  })

  it('stop は走っている子を止め、止めたことをログに残す', () => {
    const s = setup()
    s.runner.start(REQ)
    s.runner.stop()
    expect(s.children[0]!.killed()).toBe(1)
    expect(s.lines).toContain('[redetect] ホストの締めくくりで流し直しを止めた')
  })

  it('対照: 走っていなければ stop は何もログに出さない', () => {
    const s = setup()
    s.runner.stop()
    expect(s.lines).toHaveLength(0)
  })

  it('安全弁: 締めくくりとプロセスの終わりの両方から止めても、kill とログは 1 度', () => {
    const s = setup()
    s.runner.start(REQ)
    s.runner.stop()
    s.runner.stop()
    expect(s.children[0]!.killed()).toBe(1)
    expect(s.lines.filter((l) => l.includes('止めた'))).toHaveLength(1)
  })
})

function fakeProcess(pid: number | undefined, killOk = true) {
  const handlers: { error?: (e: Error) => void; exit?: (code: number | null, signal: string | null) => void } = {}
  const proc: ChildProcessLike = {
    pid,
    once: ((event: 'error' | 'exit', listener: never) => {
      handlers[event] = listener
      return proc
    }) as ChildProcessLike['once'],
    kill: () => killOk,
  }
  return { proc, handlers }
}

describe('adaptRedetectChild', () => {
  it('正: 起動できなかった（pid が無い）ときの error を終わりとして渡す', () => {
    const { proc, handlers } = fakeProcess(undefined)
    const exits: RedetectExit[] = []
    adaptRedetectChild(proc, () => {}).onExit((e) => exits.push(e))
    handlers.error!(new Error('spawn ENOENT'))
    expect(exits).toEqual([{ code: null, signal: null, error: 'spawn ENOENT' }])
  })

  it('安全弁: 起動した後の error（kill の失敗など）では終わりにせず、ログへ残して exit を待つ', () => {
    const { proc, handlers } = fakeProcess(1234)
    const exits: RedetectExit[] = []
    const lines: string[] = []
    adaptRedetectChild(proc, (l) => lines.push(l)).onExit((e) => exits.push(e))
    handlers.error!(new Error('kill EPERM'))
    expect(exits).toEqual([])
    expect(lines.some((l) => l.includes('kill EPERM'))).toBe(true)
    handlers.exit!(null, 'SIGTERM')
    expect(exits).toEqual([{ code: null, signal: 'SIGTERM', error: null }])
  })

  it('対照: 止められなかったらログへ残す', () => {
    const lines: string[] = []
    adaptRedetectChild(fakeProcess(1234, false).proc, (l) => lines.push(l)).kill()
    expect(lines.some((l) => l.includes('止められなかった'))).toBe(true)
  })
})

describe('readRedetectSummaryFile', () => {
  const enoent = Object.assign(new Error('無い'), { code: 'ENOENT' })
  it('正: 読んでから消す', () => {
    const unlinked: string[] = []
    const warns: string[] = []
    const text = readRedetectSummaryFile('/t/s.json', { readFile: () => '{}', unlink: (p) => unlinked.push(p) }, (l) => warns.push(l))
    expect(text).toBe('{}')
    expect(unlinked).toEqual(['/t/s.json'])
    expect(warns).toEqual([])
  })
  it('安全弁: 消せなくても、読めた結果は捨てない（理由はログへ）', () => {
    const warns: string[] = []
    const text = readRedetectSummaryFile(
      '/t/s.json',
      {
        readFile: () => '{}',
        unlink: () => {
          throw new Error('EBUSY')
        },
      },
      (l) => warns.push(l),
    )
    expect(text).toBe('{}')
    expect(warns.some((l) => l.includes('消せなかった') && l.includes('EBUSY'))).toBe(true)
  })
  it('対照: 無い（子が書く前に止まった）のは黙って null、それ以外の読めなさはログへ', () => {
    const warns: string[] = []
    const throwing = (e: Error) => ({
      readFile: () => {
        throw e
      },
      unlink: () => {},
    })
    expect(readRedetectSummaryFile('/t/a.json', throwing(enoent), (l) => warns.push(l))).toBeNull()
    expect(warns).toEqual([])
    expect(readRedetectSummaryFile('/t/b.json', throwing(new Error('EACCES')), (l) => warns.push(l))).toBeNull()
    expect(warns.some((l) => l.includes('読めなかった') && l.includes('EACCES'))).toBe(true)
  })
})
