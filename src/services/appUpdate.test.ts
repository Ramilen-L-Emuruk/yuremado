import { describe, expect, it, vi } from 'vitest'
import {
  APPLY_RELOAD_FALLBACK_MS,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_RECHECK_ON_WAKE_MS,
  createAppUpdater,
  type AppUpdaterDeps,
} from './appUpdate'

class FakeWorker extends EventTarget {
  state: ServiceWorkerState
  postMessage = vi.fn()
  constructor(state: ServiceWorkerState) {
    super()
    this.state = state
  }
  to(state: ServiceWorkerState) {
    this.state = state
    this.dispatchEvent(new Event('statechange'))
  }
}

class FakeRegistration extends EventTarget {
  installing: FakeWorker | null = null
  waiting: FakeWorker | null = null
  active: FakeWorker | null = new FakeWorker('activated')
  update = vi.fn(async () => {})
  /** 新しい版を取り込み始め、取り込み終えて待つところまで進める */
  install(): FakeWorker {
    const w = new FakeWorker('installing')
    this.installing = w
    this.dispatchEvent(new Event('updatefound'))
    this.installing = null
    this.waiting = w
    w.to('installed')
    return w
  }
}

function setup(opts: {
  controlled?: boolean
  registerFails?: boolean
  noServiceWorker?: boolean
  /** 前の起動で読み直したことにする（同じ版のまま起動した＝移れていない） */
  failedBefore?: boolean
  /** 前の起動で読み直したときの版の番号を直に渡す */
  reloadedFrom?: string
  /** 登録の結果が返る前にしておくこと（ブラウザが先に取り込みを始めていた形など） */
  beforeRegister?: (reg: FakeRegistration) => void
  fetchVersion?: AppUpdaterDeps['fetchVersion']
} = {}) {
  const reg = new FakeRegistration()
  opts.beforeRegister?.(reg)
  let memo: string | null = opts.reloadedFrom ?? (opts.failedBefore === true ? '5.69.0' : null)
  const remembered = vi.fn((from: string) => { memo = from })
  let controllerListener: (() => void) | null = null
  let now = 0
  const intervals: { fn: () => void; ms: number }[] = []
  const timeouts: { fn: () => void; ms: number }[] = []
  const cleared: unknown[] = []
  const wakes: (() => void)[] = []
  const reload = vi.fn()
  let online = true
  let visible = true
  const deps: AppUpdaterDeps = {
    platform: opts.noServiceWorker === true ? null : {
      register: () => (opts.registerFails ? Promise.reject(new Error('登録の失敗')) : Promise.resolve(reg as unknown as ServiceWorkerRegistration)),
      onControllerChange: (l) => { controllerListener = l },
      controlledAtStart: opts.controlled ?? true,
    },
    applyFailureMemo: {
      takePrevious: () => {
        const from = memo
        memo = null
        return from
      },
      remember: remembered,
    },
    currentVersion: '5.69.0',
    fetchVersion: opts.fetchVersion ?? (async () => '5.70.0'),
    isOnline: () => online,
    isVisible: () => visible,
    onWake: (l) => { wakes.push(l) },
    now: () => now,
    setInterval: (fn, ms) => { intervals.push({ fn, ms }) },
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length },
    clearTimeout: (id) => { cleared.push(id) },
    reload,
  }
  const updater = createAppUpdater(deps)
  updater.start()
  return {
    updater,
    reg,
    reload,
    remembered,
    intervals,
    timeouts,
    cleared,
    wakes,
    controllerChange: () => controllerListener?.(),
    setNow: (ms: number) => { now = ms },
    setOnline: (v: boolean) => { online = v },
    setVisible: (v: boolean) => { visible = v },
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('createAppUpdater: 待っている版の検出', () => {
  it('前の版が有効なところへ新しい版が届いたら、待っている状態と番号を出す（正）', async () => {
    const t = setup()
    await flush()
    const seen: unknown[] = []
    t.updater.subscribe(() => seen.push(t.updater.getSnapshot()))
    t.reg.install()
    expect(t.updater.getSnapshot()).toEqual({ waiting: true, newVersion: null, autoApply: true })
    await flush()
    expect(t.updater.getSnapshot()).toEqual({ waiting: true, newVersion: '5.70.0', autoApply: true })
    expect(seen).toHaveLength(2)
  })

  it('初めての登録（前の版が無い）では待っている版として扱わない（対照）', async () => {
    const t = setup({ controlled: false, fetchVersion: async () => '5.69.0' })
    await flush()
    t.reg.active = null
    t.reg.install()
    await flush()
    expect(t.updater.getSnapshot().waiting).toBe(false)
  })

  it('登録した時点で既に待っている版があれば知らせる', async () => {
    const t = setup()
    // 登録の結果が返る前に置く（register は次の小さな仕事で解決する）
    t.reg.waiting = new FakeWorker('installed')
    await flush()
    expect(t.updater.getSnapshot().waiting).toBe(true)
  })

  it('この JS が動く前にブラウザが取り込みを始めていた版も、取り込み終えたら知らせる', async () => {
    let early: FakeWorker | null = null
    const t = setup({ beforeRegister: (reg) => { early = new FakeWorker('installing'); reg.installing = early } })
    await flush()
    expect(t.updater.getSnapshot().waiting).toBe(false)
    t.reg.installing = null
    t.reg.waiting = early
    early!.to('installed')
    expect(t.updater.getSnapshot().waiting).toBe(true)
  })

  it('見張りの外で待つ版になっていても、確かめに行ったときに拾う', async () => {
    const t = setup()
    await flush()
    t.reg.waiting = new FakeWorker('installed')
    t.intervals[0].fn()
    expect(t.updater.getSnapshot().waiting).toBe(true)
  })

  it('取れた番号がこのページの版より新しくなければ、番号なしで知らせる（配信の伝わり途中）', async () => {
    const t = setup({ fetchVersion: async () => '5.69.0' })
    await flush()
    t.reg.install()
    await flush()
    expect(t.updater.getSnapshot()).toEqual({ waiting: true, newVersion: null, autoApply: true })
  })

  it('番号を取れなくても、待っていることは知らせる', async () => {
    const t = setup({ fetchVersion: async () => { throw new Error('取得の失敗') } })
    await flush()
    t.reg.install()
    await flush()
    expect(t.updater.getSnapshot()).toEqual({ waiting: true, newVersion: null, autoApply: true })
  })

  it('待っていた版が取り下げられたら知らせを消す（さらに新しい版が待っていればそちらへ移る）', async () => {
    const t = setup()
    await flush()
    const first = t.reg.install()
    await flush()
    t.reg.waiting = null
    first.to('redundant')
    expect(t.updater.getSnapshot().waiting).toBe(false)

    const second = t.reg.install()
    await flush()
    const third = new FakeWorker('installed')
    t.reg.waiting = third
    second.to('redundant')
    expect(t.updater.getSnapshot().waiting).toBe(true)
    t.updater.apply()
    expect(third.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
  })
})

describe('createAppUpdater: 別のタブが適用したとき', () => {
  it('このタブは読み直さず、読み直しを待つ状態にする（安全弁: 待つ条件を通すため）', async () => {
    const t = setup()
    await flush()
    t.controllerChange()
    expect(t.reload).not.toHaveBeenCalled()
    expect(t.updater.getSnapshot().waiting).toBe(true)
    await flush()
    expect(t.updater.getSnapshot().newVersion).toBe('5.70.0')
  })

  it('その後に適用すると、合図を送らずに読み直すだけ', async () => {
    const t = setup()
    await flush()
    const w = t.reg.install()
    t.reg.waiting = null
    t.controllerChange()
    w.to('redundant')
    expect(t.updater.getSnapshot().waiting).toBe(true)
    t.updater.apply()
    expect(w.postMessage).not.toHaveBeenCalled()
    expect(t.reload).toHaveBeenCalledTimes(1)
  })
})

describe('createAppUpdater: サービスワーカーの配下に無いページ', () => {
  it('配信されている版の番号が新しければ、待っている状態にする（正）', async () => {
    const t = setup({ controlled: false })
    await flush()
    await flush()
    expect(t.updater.getSnapshot()).toEqual({ waiting: true, newVersion: '5.70.0', autoApply: true })
  })

  it('同じ版・読めない番号なら何も出さない（対照）', async () => {
    const same = setup({ controlled: false, fetchVersion: async () => '5.69.0' })
    const broken = setup({ controlled: false, fetchVersion: async () => '壊れた値' })
    await flush()
    await flush()
    expect(same.updater.getSnapshot().waiting).toBe(false)
    expect(broken.updater.getSnapshot().waiting).toBe(false)
  })

  it('配下にあるページは、確かめに行くたびに番号を取りには行かない（対照）', async () => {
    const fetchVersion = vi.fn(async () => '5.70.0')
    const t = setup({ fetchVersion })
    await flush()
    t.intervals[0].fn()
    await flush()
    expect(fetchVersion).not.toHaveBeenCalled()
  })

  it('適用した版が有効になったら読み直す（controllerchange が届かないため）', async () => {
    const t = setup({ controlled: false, fetchVersion: async () => '5.69.0' })
    await flush()
    const w = t.reg.install()
    t.updater.apply()
    expect(t.reload).not.toHaveBeenCalled()
    w.to('activated')
    expect(t.reload).toHaveBeenCalledTimes(1)
  })

  it('番号の比較で気づいた後に待っている版が届いていれば、読み直す前にそれを有効にする', async () => {
    const t = setup({ controlled: false })
    await flush()
    await flush()
    const w = new FakeWorker('installed')
    t.reg.waiting = w
    t.updater.apply()
    expect(w.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    expect(t.reload).not.toHaveBeenCalled()
  })

  it('登録に失敗しても、確かめに行くたびに番号で比べる', async () => {
    const fetchVersion = vi.fn(async () => '5.69.0')
    const t = setup({ registerFails: true, fetchVersion })
    await flush()
    fetchVersion.mockResolvedValue('5.70.0')
    t.intervals[0].fn()
    await flush()
    expect(t.updater.getSnapshot().waiting).toBe(true)
  })
})

describe('createAppUpdater: サービスワーカーを使えないブラウザ', () => {
  it('配信されている版の番号を比べて新しい版に気づき、適用は読み直すだけ（正）', async () => {
    const t = setup({ noServiceWorker: true })
    await flush()
    expect(t.updater.getSnapshot()).toEqual({ waiting: true, newVersion: '5.70.0', autoApply: true })
    t.updater.apply()
    expect(t.reload).toHaveBeenCalledTimes(1)
    expect(t.timeouts).toHaveLength(0)
  })

  it('同じ版なら何も出さず、確かめに行くたびに番号を取り直す（対照）', async () => {
    const fetchVersion = vi.fn(async () => '5.69.0')
    const t = setup({ noServiceWorker: true, fetchVersion })
    await flush()
    expect(t.updater.getSnapshot().waiting).toBe(false)
    t.intervals[0].fn()
    await flush()
    expect(fetchVersion).toHaveBeenCalledTimes(2)
  })
})

describe('createAppUpdater: 確かめに行く間隔', () => {
  it('一定の間隔で新しい版を確かめに行く（正）', async () => {
    const t = setup()
    await flush()
    expect(t.intervals).toHaveLength(1)
    expect(t.intervals[0].ms).toBe(UPDATE_CHECK_INTERVAL_MS)
    t.intervals[0].fn()
    expect(t.reg.update).toHaveBeenCalledTimes(1)
  })

  it('タブが隠れている間・回線が切れている間は確かめに行かない（対照）', async () => {
    const t = setup()
    await flush()
    t.setVisible(false)
    t.intervals[0].fn()
    t.setVisible(true)
    t.setOnline(false)
    t.intervals[0].fn()
    expect(t.reg.update).not.toHaveBeenCalled()
  })

  it('タブへ戻ったときは、前に確かめてから一定時間経っていれば確かめに行く（境界）', async () => {
    const t = setup()
    await flush()
    t.setNow(UPDATE_RECHECK_ON_WAKE_MS - 1)
    t.wakes[0]()
    expect(t.reg.update).not.toHaveBeenCalled()
    t.setNow(UPDATE_RECHECK_ON_WAKE_MS)
    t.wakes[0]()
    expect(t.reg.update).toHaveBeenCalledTimes(1)
  })

  it('いま確かめるよう頼まれたら、定期の確認を待たずに確かめに行く（登録の前は何もしない）', async () => {
    const t = setup()
    t.updater.checkNow()
    expect(t.reg.update).not.toHaveBeenCalled()
    await flush()
    t.updater.checkNow()
    expect(t.reg.update).toHaveBeenCalledTimes(1)
  })

  it('取り込み中の版があるときは重ねて確かめない', async () => {
    const t = setup()
    await flush()
    t.reg.installing = new FakeWorker('installing')
    t.intervals[0].fn()
    expect(t.reg.update).not.toHaveBeenCalled()
  })
})

describe('createAppUpdater: 適用', () => {
  it('待っている版が無ければ何もしない（安全弁: 押しても読み直さない）', async () => {
    const t = setup()
    await flush()
    t.updater.apply()
    expect(t.timeouts).toHaveLength(0)
    expect(t.reload).not.toHaveBeenCalled()
  })

  it('待っている版へ合図を送り、受け持ちが替わったら 1 回だけ読み直す', async () => {
    const t = setup()
    await flush()
    const w = t.reg.install()
    t.updater.apply()
    expect(w.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    expect(t.reload).not.toHaveBeenCalled()
    t.controllerChange()
    w.to('activated')
    expect(t.reload).toHaveBeenCalledTimes(1)
  })

  it('有効にならなければ、上限の時間で読み直す', async () => {
    const t = setup()
    await flush()
    t.reg.install()
    t.updater.apply()
    expect(t.timeouts[0].ms).toBe(APPLY_RELOAD_FALLBACK_MS)
    t.timeouts[0].fn()
    expect(t.reload).toHaveBeenCalledTimes(1)
    expect(t.remembered).toHaveBeenCalledTimes(1)
  })

  it('有効になれば、適用が効かなかったとは覚えない（対照）', async () => {
    const t = setup()
    await flush()
    const w = t.reg.install()
    t.updater.apply()
    w.to('activated')
    expect(t.remembered).not.toHaveBeenCalled()
    // 読み直しの応答が遅く、保険の時間を過ぎても、効かなかったとは覚えない
    expect(t.cleared).toEqual([1])
    t.timeouts[0].fn()
    expect(t.remembered).not.toHaveBeenCalled()
    expect(t.reload).toHaveBeenCalledTimes(1)
  })

  it('前の起動で適用が効かなかったら、静かなときに自分で適用しないよう知らせる（安全弁: 読み直しを繰り返さない）', async () => {
    const t = setup({ failedBefore: true })
    await flush()
    const w = t.reg.install()
    await flush()
    expect(t.updater.getSnapshot()).toEqual({ waiting: true, newVersion: '5.70.0', autoApply: false })
    // 札の［今すぐ更新］からは適用できる
    t.updater.apply()
    expect(w.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
  })

  it('前の起動で読み直した後、新しい版へ移れていれば印は効かない（対照: 次の更新も自分で適用する）', async () => {
    const t = setup({ controlled: false, reloadedFrom: '5.68.0' })
    await flush()
    await flush()
    expect(t.updater.getSnapshot()).toEqual({ waiting: true, newVersion: '5.70.0', autoApply: true })
  })

  it('番号の比較で気づいて読み直すときも覚える（読み直しても古い版のままなら、次は自分で適用しない）', async () => {
    const t = setup({ controlled: false })
    await flush()
    await flush()
    t.updater.apply()
    expect(t.reload).toHaveBeenCalledTimes(1)
    expect(t.remembered).toHaveBeenCalledTimes(1)

    const next = setup({ controlled: false, failedBefore: true })
    await flush()
    await flush()
    expect(next.updater.getSnapshot()).toEqual({ waiting: true, newVersion: '5.70.0', autoApply: false })
  })

  it('別のタブが適用した後は、前の起動で効かなかったとしても自分で読み直す（対照: 読み直せば必ず移れる）', async () => {
    const t = setup({ failedBefore: true })
    await flush()
    t.controllerChange()
    expect(t.updater.getSnapshot().autoApply).toBe(true)
    t.updater.apply()
    expect(t.reload).toHaveBeenCalledTimes(1)
    expect(t.remembered).not.toHaveBeenCalled()
  })

  it('待っている版が別の版に替わったら、前の番号を名乗らない', async () => {
    let version: string | null = '5.70.0'
    const t = setup({ fetchVersion: async () => version })
    await flush()
    const first = t.reg.install()
    await flush()
    expect(t.updater.getSnapshot().newVersion).toBe('5.70.0')
    version = null
    const second = new FakeWorker('installed')
    t.reg.waiting = second
    first.to('redundant')
    await flush()
    expect(t.updater.getSnapshot()).toEqual({ waiting: true, newVersion: null, autoApply: true })
  })

  it('登録に失敗したら、定期の確認を待たずに番号で比べる', async () => {
    const t = setup({ registerFails: true })
    await flush()
    await flush()
    expect(t.updater.getSnapshot().waiting).toBe(true)
  })

  it('合図を送れなければ、保険のタイマーを外して読み直す', async () => {
    const t = setup()
    await flush()
    const w = t.reg.install()
    w.postMessage.mockImplementation(() => { throw new Error('送れない') })
    t.updater.apply()
    expect(t.cleared).toEqual([1])
    expect(t.reload).toHaveBeenCalledTimes(1)
    expect(t.remembered).toHaveBeenCalledTimes(1)
  })

  it('適用を 2 度押しても 1 回しか合図を送らない', async () => {
    const t = setup()
    await flush()
    const w = t.reg.install()
    t.updater.apply()
    t.updater.apply()
    expect(w.postMessage).toHaveBeenCalledTimes(1)
  })
})
