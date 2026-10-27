import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShakeEventRecord } from '../detection/shakeEvent'
import { IIS, IIS_AXES, SECONDS, T0, config, mirroredConfig, packets } from './boardMirror.fixture'
import {
  BoardMirrorRunner,
  EMPTY_MIRROR_VOTE_BOOK,
  MIRROR_KEEP_VOTES,
  mirrorSuspects,
  mirrorWatchRows,
  parseMirrorVoteBook,
  readMirrorVoteBookFile,
  writeMirrorVoteBookFile,
  type BoardMirrorEvent,
  type MirrorVoteBook,
} from './boardMirrorRunner'
import type { StationConfig } from './stationConfigTypes'

/** 揺れの記録（見張りが読む欄だけ）。 */
function shake(over: Partial<ShakeEventRecord> = {}): ShakeEventRecord {
  return { rev: 1, stationId: 'st1', startMs: T0 + 5_000, endMs: T0 + (SECONDS - 5) * 1000, ...over } as ShakeEventRecord
}

function runner(opts: { cfg?: StationConfig | 'changed' | null; initial?: MirrorVoteBook } = {}) {
  const cfg = opts.cfg === undefined ? mirroredConfig() : opts.cfg
  const saves: MirrorVoteBook[] = []
  const readPackets = vi.fn(async () => packets(IIS_AXES))
  const r = new BoardMirrorRunner({
    configThrough: () => cfg,
    readPackets,
    initial: opts.initial ?? EMPTY_MIRROR_VOTE_BOOK,
    save: async (book) => {
      saves.push(book)
    },
    onEvent: () => {},
  })
  return { r, saves, readPackets }
}

describe('BoardMirrorRunner（揺れの記録ごとに 1 票）', () => {
  it('正: 鏡像で入った基板は、揺れ 3 回で疑いに載り、票を残す', async () => {
    const { r, saves } = runner()
    for (let k = 0; k < 3; k++) r.onShake(shake())
    await r.idle()
    expect(mirrorSuspects(r.votes, mirroredConfig())).toEqual([{ boardKey: IIS, mirrored: 3, ok: 0 }])
    expect(saves).toHaveLength(3)
  })

  it('対照: 正しく入った基板は疑いに載らない', async () => {
    const { r } = runner({ cfg: config(IIS_AXES) })
    for (let k = 0; k < 3; k++) r.onShake(shake())
    await r.idle()
    expect(mirrorSuspects(r.votes, config(IIS_AXES))).toEqual([])
    expect(r.votes.boards[IIS]?.votes.map((v) => v.vote)).toEqual(['ok', 'ok', 'ok'])
  })

  it('対照: 照合の版（rev 2 以降）は数えない', async () => {
    const { r, readPackets } = runner()
    r.onShake(shake({ rev: 2 }))
    await r.idle()
    expect(readPackets).not.toHaveBeenCalled()
  })

  it('安全弁: 区間の中で設定が変わった・履歴を読めていないなら読まない', async () => {
    for (const cfg of ['changed', null] as const) {
      const { r, readPackets } = runner({ cfg })
      r.onShake(shake())
      await r.idle()
      expect(readPackets).not.toHaveBeenCalled()
    }
  })

  it('安全弁: 6 面法をやり直して校正値が変わったら、前の票は数えない', async () => {
    const { r } = runner()
    for (let k = 0; k < 3; k++) r.onShake(shake())
    await r.idle()
    const redone = config(IIS_AXES.map((axes) => axes.map((v) => [v[0], v[1], -v[2]] as const)))
    expect(mirrorSuspects(r.votes, redone)).toEqual([])
  })

  it(`安全弁: 票は最近の ${MIRROR_KEEP_VOTES} 票だけ残す`, async () => {
    const { r } = runner()
    for (let k = 0; k < MIRROR_KEEP_VOTES + 2; k++) r.onShake(shake())
    await r.idle()
    expect(r.votes.boards[IIS]?.votes).toHaveLength(MIRROR_KEEP_VOTES)
  })

  it('安全弁: 残せなくても票は手元に持ち、失敗を知らせる', async () => {
    const events: string[] = []
    const r = new BoardMirrorRunner({
      configThrough: () => mirroredConfig(),
      readPackets: async () => packets(IIS_AXES),
      initial: EMPTY_MIRROR_VOTE_BOOK,
      save: async () => {
        throw new Error('書けない')
      },
      onEvent: (e) => events.push(e.kind),
    })
    r.onShake(shake())
    await r.idle()
    expect(r.votes.boards[IIS]?.votes).toHaveLength(1)
    expect(events).toEqual(['voted', 'failed'])
  })

  function recording(cfg: StationConfig | 'changed' | null, onEvent?: (e: BoardMirrorEvent) => void) {
    const events: BoardMirrorEvent[] = []
    const readPackets = vi.fn(async () => packets(IIS_AXES))
    const r = new BoardMirrorRunner({
      configThrough: () => cfg,
      readPackets,
      initial: EMPTY_MIRROR_VOTE_BOOK,
      save: async () => {},
      onEvent: onEvent ?? ((e) => events.push(e)),
    })
    return { r, events, readPackets }
  }

  it('正: 票にしなかった理由を知らせる（区間の中で設定が変わった）', async () => {
    const { r, events } = recording('changed')
    r.onShake(shake())
    await r.idle()
    expect(events).toEqual([{ kind: 'skipped', reason: 'config-changed', stationId: 'st1' }])
  })

  it('対照: 設定の履歴を読めていないのは、区間の中で変わったのと別の理由で知らせる', async () => {
    const { r, events } = recording(null)
    r.onShake(shake())
    await r.idle()
    expect(events).toEqual([{ kind: 'skipped', reason: 'config-unread', stationId: 'st1' }])
  })

  it('安全弁: 校正値を変えた後の揺れの票があるところへ、古い区間の揺れが回ってきても上書きしない', async () => {
    const newer = mirroredConfig()
    const initial: MirrorVoteBook = {
      version: 1,
      boards: { [IIS]: { fingerprint: 'あとで入れた校正値', votes: [{ atMs: T0 + 60_000, vote: 'ok', current: 0.3, mirrored: 0.1 }] } },
    }
    const events: BoardMirrorEvent[] = []
    const r = new BoardMirrorRunner({
      configThrough: () => newer,
      readPackets: async () => packets(IIS_AXES),
      initial,
      save: async () => {},
      onEvent: (e) => events.push(e),
    })
    r.onShake(shake({ startMs: T0 + 5_000 }))
    await r.idle()
    expect(events).toEqual([{ kind: 'skipped', reason: 'stale-calibration', stationId: 'st1', boardKey: IIS }])
    expect(r.votes.boards[IIS]).toEqual(initial.boards[IIS])
  })

  it('正: 同じ観測点に 3 軸のセンサーが無ければ、生データを読まずに理由を知らせる', async () => {
    const c = mirroredConfig()
    const { r, events, readPackets } = recording({ ...c, boards: c.boards.filter((b) => b.boardKey === IIS) })
    r.onShake(shake())
    await r.idle()
    expect(readPackets).not.toHaveBeenCalled()
    expect(events).toEqual([{ kind: 'skipped', reason: 'no-reference', stationId: 'st1' }])
  })

  it('対照: 見張る基板の無い観測点の揺れでは何も知らせない', async () => {
    const { r, events, readPackets } = recording(mirroredConfig())
    r.onShake(shake({ stationId: 'st2' }))
    await r.idle()
    expect(readPackets).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it('正: 校正値が変わって前の票を捨てたら知らせる', async () => {
    const events: BoardMirrorEvent[] = []
    let cfg: StationConfig = mirroredConfig()
    const r = new BoardMirrorRunner({
      configThrough: () => cfg,
      readPackets: async () => packets(IIS_AXES),
      initial: EMPTY_MIRROR_VOTE_BOOK,
      save: async () => {},
      onEvent: (e) => events.push(e),
    })
    r.onShake(shake())
    r.onShake(shake())
    await r.idle()
    cfg = config(IIS_AXES)
    r.onShake(shake())
    await r.idle()
    expect(events.filter((e) => e.kind === 'reset')).toEqual([{ kind: 'reset', boardKey: IIS, dropped: 2 }])
    expect(r.votes.boards[IIS]?.votes.map((v) => v.vote)).toEqual(['ok'])
  })

  it('安全弁: 知らせる口が投げても、次の揺れは回る', async () => {
    let calls = 0
    const { r } = recording(mirroredConfig(), () => {
      calls++
      throw new Error('知らせられない')
    })
    r.onShake(shake())
    r.onShake(shake())
    await r.idle()
    expect(calls).toBe(2)
    expect(r.votes.boards[IIS]?.votes).toHaveLength(2)
  })
})

describe('mirrorWatchRows（稼働状況に出す見張りの票）', () => {
  it('正: 見張っている基板ごとに、票の内訳と最後の票の時刻を返す', async () => {
    const { r } = runner()
    r.onShake(shake({ startMs: T0 + 1_000 }))
    r.onShake(shake({ startMs: T0 + 2_000 }))
    await r.idle()
    expect(mirrorWatchRows(r.votes, mirroredConfig())).toEqual([{ boardKey: IIS, mirrored: 2, ok: 0, lastVoteMs: T0 + 2_000 }])
  })

  it('対照: 票が無くても見張っている基板は載せ、3 軸のセンサーを持つ基板は載せない', () => {
    const rows = mirrorWatchRows(EMPTY_MIRROR_VOTE_BOOK, mirroredConfig())
    expect(rows).toEqual([{ boardKey: IIS, mirrored: 0, ok: 0, lastVoteMs: null }])
  })

  it('安全弁: 比べる相手が無い観測点の基板は載せず、校正値が変わった後の古い票は数えない', async () => {
    const c = mirroredConfig()
    expect(mirrorWatchRows(EMPTY_MIRROR_VOTE_BOOK, { ...c, boards: c.boards.filter((b) => b.boardKey === IIS) })).toEqual([])
    const { r } = runner()
    r.onShake(shake())
    await r.idle()
    expect(mirrorWatchRows(r.votes, config(IIS_AXES))).toEqual([{ boardKey: IIS, mirrored: 0, ok: 0, lastVoteMs: null }])
  })
})

describe('readMirrorVoteBookFile（残した票を読む）', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mirror-votes-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('正: 書いた票を読み戻す', async () => {
    const path = join(dir, 'v.json')
    const book: MirrorVoteBook = { version: 1, boards: { a: { fingerprint: 'f', votes: [{ atMs: 1, vote: 'ok', current: 0.3, mirrored: 0.1 }] } } }
    await writeMirrorVoteBookFile(path, book)
    expect(await readMirrorVoteBookFile(path)).toEqual({ book, problem: null })
  })

  it('対照: 無ければ問題なしで空から始める', async () => {
    expect(await readMirrorVoteBookFile(join(dir, 'none.json'))).toEqual({ book: EMPTY_MIRROR_VOTE_BOOK, problem: null })
  })

  it('安全弁: 読めない中身は退避してから空で始める（次の保存で上書きしない）', async () => {
    const path = join(dir, 'v.json')
    await writeFile(path, '{壊れた')
    const got = await readMirrorVoteBookFile(path, 1234)
    expect(got.book).toEqual(EMPTY_MIRROR_VOTE_BOOK)
    expect(got.problem).toContain('退避した')
    expect(await readFile(`${path}.unreadable-1234`, 'utf8')).toBe('{壊れた')
    await expect(readFile(path, 'utf8')).rejects.toThrow()
  })

  it('安全弁: 形の合わない基板・票を捨てたら、その数を問題として返す', async () => {
    const path = join(dir, 'v.json')
    await writeFile(path, JSON.stringify({ version: 1, boards: { a: { fingerprint: 'f', votes: [{ atMs: 1, vote: 'x' }] }, b: {} } }))
    const got = await readMirrorVoteBookFile(path)
    expect(got.problem).toBe('形の合わない基板 1 枚・票 1 件を捨てた')
  })
})

describe('parseMirrorVoteBook（残した票を読み戻す）', () => {
  it('対照: 形の合わない基板・票は捨てる', () => {
    const book = parseMirrorVoteBook({
      version: 1,
      boards: {
        a: { fingerprint: 'f', votes: [{ atMs: 1, vote: 'ok', current: 0.3, mirrored: 0.1 }, { atMs: 2, vote: 'x' }] },
        b: { votes: [] },
      },
    })
    expect(Object.keys(book.boards)).toEqual(['a'])
    expect(book.boards.a?.votes).toHaveLength(1)
  })
  it('安全弁: 版が違う・壊れていれば空から始める', () => {
    expect(parseMirrorVoteBook({ version: 2 })).toEqual(EMPTY_MIRROR_VOTE_BOOK)
    expect(parseMirrorVoteBook('x')).toEqual(EMPTY_MIRROR_VOTE_BOOK)
  })
})
