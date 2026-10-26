import { compareVersions } from '../utils/releaseNotes'
import { log } from '../utils/logger'

/**
 * 新しい版の検出と適用。
 *
 * サービスワーカーは **新しい版を見つけても自分からは有効にならない**（`sw.js` は `SKIP_WAITING` の合図を
 * 受けたときだけ有効になり、開いているページを横取りもしない）。待っている（waiting）間、開いているページは
 * 古い版のファイルのまま動き続けるので、読みかけのファイルが足元で消えることが無い。有効にするのは
 * {@link AppUpdater.apply} を呼んだときだけで、有効になったらこのタブを 1 回だけ読み直す。
 *
 * **別のタブが適用したときは、このタブを勝手に読み直さない。** 新しい版が有効になった時点で古い版の
 * ファイルは控えから消えるので、このタブも読み直しを待つ状態（{@link AppUpdateSnapshot.waiting}）にして、
 * 発表中・入力中なら待つ条件（`utils/appUpdateGate.ts`）を通してから読み直す。
 *
 * **サービスワーカーの配下に無いページも取り残さない。** 初めて開いたページは配下に入らないので、
 * 待っている版の知らせが届かない。配信されている版の番号を自分の番号と比べて気づく。
 *
 * **開きっぱなしでも新しい版に気づく。** ブラウザが自分から確かめるのは主にページを開いたときなので、
 * 一定の間隔と、タブへ戻ったとき・回線が戻ったときに確かめに行く（2026-10-26 ユーザー承認
 * 「更新を定期的に確かめる」）。
 *
 * いつ適用するかは `utils/appUpdateGate.ts` が決める。ここは「待っている版があるか」と「適用する」だけを持つ。
 */

export interface AppUpdateSnapshot {
  /** 新しい版が待っているか（別のタブが適用して、このタブの読み直しが要る場合も含む）。 */
  readonly waiting: boolean
  /** 待っている版の番号。取れなければ `null`（番号の無い札を出す）。 */
  readonly newVersion: string | null
  /**
   * 静かなときに自分で適用してよいか。前の起動で適用を頼んでも有効にならず保険で読み直していたら `false`
   * （自動で繰り返すと、静かなときに読み直しを延々と続ける）。札の［今すぐ更新］は押せる。
   */
  readonly autoApply: boolean
}

/** ブラウザのサービスワーカーの口のうち、ここで使うもの。 */
export interface SwPlatform {
  /** サービスワーカーを登録する。 */
  register(): Promise<ServiceWorkerRegistration>
  /** このページを受け持つサービスワーカーが替わったときに呼ぶ関数を登録する。 */
  onControllerChange(listener: () => void): void
  /** 起動したとき、このページがサービスワーカーの配下にあったか。 */
  readonly controlledAtStart: boolean
}

/**
 * 新しい版へ移るつもりで読み直したことを、読み直しをまたいで覚える場所（sessionStorage）。
 * 覚えるのは読み直す前の版の番号。次の起動で自分の番号と同じなら、移れていない。
 */
export interface ApplyFailureMemo {
  /** 前の起動で読み直したときの版の番号。無ければ `null`。読んだら消す。 */
  takePrevious(): string | null
  remember(fromVersion: string): void
}

export interface AppUpdaterDeps {
  /** サービスワーカーの口。使えない環境では `null`（配信されている版の番号を比べるだけで気づく） */
  platform: SwPlatform | null
  applyFailureMemo: ApplyFailureMemo
  /** いま動いている版の番号（`__APP_VERSION__`）。 */
  currentVersion: string
  /** 配信されている版の番号を取る。取れなければ `null`。 */
  fetchVersion: () => Promise<string | null>
  /** 回線が繋がっているか（`navigator.onLine`）。 */
  isOnline: () => boolean
  /** タブが見えているか（`document.visibilityState === 'visible'`）。 */
  isVisible: () => boolean
  /** タブへ戻った・回線が戻ったときに呼ぶ関数を登録する。 */
  onWake: (listener: () => void) => void
  /** `performance.now()`。 */
  now: () => number
  setInterval: (fn: () => void, ms: number) => unknown
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (id: unknown) => void
  reload: () => void
}

/** 新しい版を確かめに行く間隔。 */
export const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000

/**
 * タブへ戻ったときに確かめに行く最短の間隔。タブを行き来するたびに取りに行かないため。
 */
export const UPDATE_RECHECK_ON_WAKE_MS = 5 * 60 * 1000

/**
 * 適用を頼んでから新しい版が有効になるまでの待ちの上限。普段は 1 秒ほどで有効になる。
 * 過ぎたら読み直して、ブラウザに取り込みをやり直させる。
 */
export const APPLY_RELOAD_FALLBACK_MS = 10_000

export interface AppUpdater {
  start(): void
  getSnapshot(): AppUpdateSnapshot
  subscribe(listener: () => void): () => void
  /** 待っている版を有効にして読み直す。待っている版が無ければ何もしない。 */
  apply(): void
  /** 定期の確認を待たずに、いま新しい版を確かめに行く（自分のファイルが読めなかったとき。main.tsx）。 */
  checkNow(): void
}

/**
 * いま使う更新の係。**`main.tsx` が `installAppUpdater` で本物を据える**（テストや Service Worker の
 * 無い環境では据えない）。据えるまでは「待っている版は無い」と答え続ける。
 */
const INERT_SNAPSHOT: AppUpdateSnapshot = { waiting: false, newVersion: null, autoApply: true }
let current: AppUpdater = {
  start() {},
  getSnapshot: () => INERT_SNAPSHOT,
  subscribe: () => () => {},
  apply() {},
  checkNow() {},
}

export function installAppUpdater(updater: AppUpdater): void {
  current = updater
}

export function currentAppUpdater(): AppUpdater {
  return current
}

export function createAppUpdater(deps: AppUpdaterDeps): AppUpdater {
  const { platform } = deps
  let snapshot: AppUpdateSnapshot = INERT_SNAPSHOT
  const listeners = new Set<() => void>()
  let registration: ServiceWorkerRegistration | null = null
  /** 有効にすれば済む、待っている版。別のタブが適用した後・番号の比較で気づいたときは `null`（読み直すだけ） */
  let waitingWorker: ServiceWorker | null = null
  /** 別のタブが新しい版を有効にした（待っている版が取り下げられても、読み直しは要る） */
  let takenOver = false
  let lastCheckMs = Number.NEGATIVE_INFINITY
  let started = false
  let applying = false
  let reloading = false
  /** 適用を頼んだときの保険の読み直し。有効になって読み直したら外す */
  let applyFallback: unknown = null
  /** 前の起動で新しい版へ移るつもりで読み直したのに、同じ版のまま起動した（この起動では自動で適用しない） */
  let applyFailedBefore = false
  let failedBeforeLogged = false
  /** サービスワーカーの知らせを受け取れない（配下に無い・登録できない・使えない）ので番号で比べる */
  const needsVersionCompare = () => platform === null || !platform.controlledAtStart || registration === null

  const publish = (next: AppUpdateSnapshot) => {
    snapshot = next
    for (const l of listeners) l()
  }

  /** 読み直しは 1 回だけ（有効になった知らせが 2 つの経路から届くため）。 */
  const reloadOnce = () => {
    if (reloading) return
    reloading = true
    if (applyFallback !== null) {
      deps.clearTimeout(applyFallback)
      applyFallback = null
    }
    deps.reload()
  }

  /**
   * 前の起動で読み直しても新しい版にならなかったのに、また待っているなら、自分では適用しない（読み直しを繰り返すだけ）。
   * 別のタブが適用した後は新しい版が既に有効なので、読み直せば必ず移れる。
   */
  const autoApply = () => !applyFailedBefore || takenOver

  /**
   * 待っていることを知らせる。番号が分かっていなければ取りに行く。`keepVersion` が偽なら前の番号を捨てる
   * （待っている版が別の版に替わったとき、古い番号を名乗らないため）。
   */
  const announce = (knownVersion: string | null, keepVersion = true) => {
    if (applyFailedBefore && !takenOver && !failedBeforeLogged) {
      failedBeforeLogged = true
      log.error('[sw] 前回、新しい版へ読み直しても移れなかったが、まだ新しい版が待っている（自動の適用をやめ、［今すぐ更新］だけにする）')
    }
    const carried = keepVersion ? snapshot.newVersion : null
    publish({ waiting: true, newVersion: knownVersion ?? carried, autoApply: autoApply() })
    if (knownVersion !== null) return
    deps.fetchVersion()
      .then((version) => {
        if (version === null) {
          log.warn('[sw] 新しい版の番号を読めなかった（番号なしで知らせる）')
          return
        }
        // 配信の伝わり途中では、取れた番号がまだ今の版のことがある。今の版を「新しいバージョン」とは名乗らない
        if ((compareVersions(version, deps.currentVersion) ?? 0) <= 0) {
          log.warn(`[sw] 取れた番号（${version}）がこのページの版（${deps.currentVersion}）より新しくない（番号なしで知らせる）`)
          return
        }
        if (snapshot.waiting) publish({ ...snapshot, newVersion: version })
      })
      .catch((err: unknown) => {
        log.warn('[sw] 新しい版の番号を取れなかった（番号なしで知らせる）', err)
      })
  }

  const markWaiting = (worker: ServiceWorker) => {
    if (waitingWorker === worker) return
    waitingWorker = worker
    worker.addEventListener('statechange', () => {
      // さらに新しい版に置き換えられた・取り込みに失敗した。有効になった（別のタブが適用した）ときは
      // controllerchange の側で受ける
      if (worker.state !== 'redundant' || waitingWorker !== worker || applying) return
      waitingWorker = null
      const next = registration?.waiting ?? null
      if (next !== null && registration?.active) {
        markWaiting(next)
        return
      }
      if (takenOver) return
      log.info('[sw] 待っていた版が取り下げられた（新しい版の知らせを消す）')
      publish(INERT_SNAPSHOT)
    })
    announce(null, false)
  }

  /**
   * 待っている版を見張る。**前の版が有効なときだけ数える** —— 初めての登録では、取り込んだ版が待たずに
   * そのまま有効になるので、知らせるものが無い。
   */
  const watchInstalling = (reg: ServiceWorkerRegistration, worker: ServiceWorker) => {
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && reg.active !== null) markWaiting(worker)
    })
  }
  const watchWaiting = (reg: ServiceWorkerRegistration) => {
    if (reg.waiting !== null && reg.active !== null) markWaiting(reg.waiting)
    // ページを開いたときのブラウザの確認は、この JS が動く前に取り込みを始めていることがある。
    // updatefound はもう撃ち終わっているので、取り込み中の版を直接見張る
    if (reg.installing !== null) watchInstalling(reg, reg.installing)
    reg.addEventListener('updatefound', () => {
      if (reg.installing !== null) watchInstalling(reg, reg.installing)
    })
  }

  /** 配信されている版の番号を自分の番号と比べる（サービスワーカーの知らせが届かないページのため）。 */
  const compareDeployed = () => {
    if (snapshot.waiting || !deps.isOnline()) return
    deps.fetchVersion()
      .then((version) => {
        if (version === null || snapshot.waiting) return
        const cmp = compareVersions(version, deps.currentVersion)
        if (cmp === null) {
          log.warn(`[sw] 配信されている版の番号「${version}」を読めなかった（比べない）`)
          return
        }
        if (cmp <= 0) return
        log.info(`[sw] 配信されている版（${version}）がこのページ（${deps.currentVersion}）より新しい`)
        announce(version)
      })
      .catch((err: unknown) => {
        log.warn('[sw] 配信されている版の番号を取れなかった（次の確認で取り直す）', err)
      })
  }

  /** 新しい版を確かめに行く。見送ったときは理由を返す。 */
  const check = (): string | null => {
    if (needsVersionCompare()) compareDeployed()
    const reg = registration
    if (reg === null) return platform === null ? 'サービスワーカーが使えない' : '登録が済んでいない'
    // 見張りの外で待つ版になっていたら拾う（取りこぼしても次の確認で気づく）
    if (reg.waiting !== null && reg.active !== null && !takenOver) markWaiting(reg.waiting)
    if (!deps.isOnline()) return '回線が切れている'
    // 取り込み中の版があるなら、その結果（waiting か redundant）を待つ。重ねて確かめても同じものを取るだけ
    if (reg.installing !== null) return '取り込み中の版がある'
    lastCheckMs = deps.now()
    reg.update().catch((err: unknown) => {
      log.warn('[sw] 新しい版を確かめに行けなかった（次の確認で取り直す）', err)
    })
    return null
  }

  const onControllerChange = () => {
    if (applying) {
      reloadOnce()
      return
    }
    if (platform === null || !platform.controlledAtStart) {
      compareDeployed()
      return
    }
    log.info('[sw] 別のタブが新しい版を有効にした（このタブも読み直しを待つ）')
    takenOver = true
    waitingWorker = null
    announce(null)
  }

  return {
    start() {
      if (started) return
      started = true
      const reloadedFrom = deps.applyFailureMemo.takePrevious()
      applyFailedBefore = reloadedFrom === deps.currentVersion
      if (reloadedFrom !== null && !applyFailedBefore) {
        log.info(`[sw] 前の起動で読み直した版（${reloadedFrom}）から ${deps.currentVersion} へ移れた`)
      }
      deps.setInterval(() => {
        if (deps.isVisible()) check()
      }, UPDATE_CHECK_INTERVAL_MS)
      deps.onWake(() => {
        if (deps.isVisible() && deps.now() - lastCheckMs >= UPDATE_RECHECK_ON_WAKE_MS) check()
      })
      if (platform === null) {
        compareDeployed()
        return
      }
      platform.onControllerChange(onControllerChange)
      platform.register()
        .then((reg) => {
          registration = reg
          lastCheckMs = deps.now()
          try {
            watchWaiting(reg)
          } catch (err) {
            log.error('[sw] 登録はできたが、待っている版の見張りを張れなかった（新しい版は定期の確認で拾う）', err)
          }
          if (!platform.controlledAtStart) compareDeployed()
        })
        .catch((err: unknown) => {
          log.error('[sw] サービスワーカーを登録できなかった（新しい版は番号を比べて確かめる）', err)
          compareDeployed()
        })
    },
    getSnapshot: () => snapshot,
    checkNow() {
      const skipped = check()
      if (skipped === null) return
      log.info(needsVersionCompare()
        ? `[sw] サービスワーカーへの確認は見送り、配信されている版の番号だけ確かめに行った（${skipped}）`
        : `[sw] いま確かめるのを見送った（${skipped}）`)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    apply() {
      if (!snapshot.waiting) {
        log.info('[sw] 適用を頼まれたが、待っている版が無い（何もしない）')
        return
      }
      if (applying) {
        log.info('[sw] 適用を頼まれたが、既に適用を始めている')
        return
      }
      applying = true
      // 番号の比較で気づいた後に待っている版が届いていれば、それを有効にする。読み直すだけだと、
      // 古い版のサービスワーカーの配下へ戻ってしまう
      const active = registration?.active ?? null
      const worker = waitingWorker ?? (active !== null ? registration?.waiting ?? null : null)
      log.info(`[sw] 新しい版（${snapshot.newVersion ?? '番号不明'}）を適用する`)
      if (worker === null) {
        // 読み直すだけで移れるかは、読み直した先でしか分からない。移れていれば次の起動の版の番号が変わるので、印は効かない
        if (!takenOver) deps.applyFailureMemo.remember(deps.currentVersion)
        reloadOnce()
        return
      }
      applyFallback = deps.setTimeout(() => {
        applyFallback = null
        if (reloading) return
        log.warn(`[sw] 適用を頼んで ${APPLY_RELOAD_FALLBACK_MS / 1000} 秒経っても有効にならなかったので、読み直す`)
        deps.applyFailureMemo.remember(deps.currentVersion)
        reloadOnce()
      }, APPLY_RELOAD_FALLBACK_MS)
      // 配下に無いページには controllerchange が届かないので、版が有効になったことでも読み直す
      worker.addEventListener('statechange', () => {
        if (worker.state === 'activated') reloadOnce()
      })
      try {
        worker.postMessage({ type: 'SKIP_WAITING' })
      } catch (err) {
        deps.clearTimeout(applyFallback)
        applyFallback = null
        log.error('[sw] 新しい版を有効にできなかった（読み直して取り込みを試す）', err)
        deps.applyFailureMemo.remember(deps.currentVersion)
        reloadOnce()
      }
    },
  }
}
