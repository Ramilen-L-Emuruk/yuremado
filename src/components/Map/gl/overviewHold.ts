import type { Map as MapLibreMap } from 'maplibre-gl'
import { log } from '../../../utils/logger'
import { PREFETCH_REFRESH_MS, type TileXYZ } from '../../../utils/gebcoPrefetch'
import { fillTileCache, resolveTileCacheAccess, type FillResult, type TileCacheAccess } from './tileCacheAccess'

// 録画モードのあいだ、海底地形の下地のタイルを地図の控えへ載せておく係（`BaseMapGL` の録画モードの effect が使う）。
// 控えへ触る口そのものは `tileCacheAccess.ts`。ここは「いつ口を作るか・いつ載せるか・失敗をどう知らせるか」を持つ。
//
// 状態は 4 つで、遷移はここにしか無い。
// - 待ち（口がまだ作れない）: `RETRY_MS` ごとに試し直す。**待ちの間は諦めない**（1 回の試しは軽い）。下地を出している
//   間だけ待ち時間を数え、`NOT_YET_WARN_MS` に届いたら警告する（待ちに入り直すたびに数え直す）
// - 使える: 決まった範囲（holdTiles）を載せ、寄せのたびに寄せ先のぶんと、押し出されて欠けたぶんを補う。決まった範囲が
//   1 枚も読めなかった後は、どこかが読めるまで寄せのたびには補わず、1 時間ごとの補いまで待つ（配信元が止まっている
//   間に投げ続けない）。読めなかったタイルは、1 時間は決まった範囲の補いで飛ばす
// - 使えない（形が確かに違う）: 1 度だけ警告し、以後は試さない（呼び出し側は HTTP の先読みだけに戻る）。
//   一時的かもしれない状態（例外・スタイルが無い）では、ここへは移らない
// - 止めた: タイマーと読み込みを止め、上げた控えの上限を戻す
// ソースが作り直されて持ち主が替わったら（`isCurrent`）、使える → 待ちへ戻して作り直す。
// その口で走っていた読み込み（決まった範囲のぶんも寄せ先のぶんも）は、口ごとの打ち切りでまとめて止める。

/** 口が作れないときに試し直す間隔。 */
export const RETRY_MS = 2000
/** 下地を出しているのに口が作れない状態がこれだけ続いたら、警告する。 */
export const NOT_YET_WARN_MS = 60_000
/** 読めないことがこの枚数続いたら、その回の読み込みをやめる（配信元が止まっているときに投げ続けない）。 */
export const FAIL_LIMIT = 8
/** 録画モードに入った直後などの一括で同時に読む枚数。急ぐものではないので、地図自身の取得（同時 16 本）を押しのけない。 */
export const HOLD_CONCURRENCY = 2
/** 寄せ始めに寄せ先の下地を同時に読む枚数。着地までに間に合わせたいので多めにする（それでも地図の枠の半分）。 */
export const TARGET_CONCURRENCY = 8

export interface OverviewHoldOptions {
  sourceId: string
  /** いつも控えに置いておく下地のタイル（`buildOverviewHoldTiles`）。 */
  holdTiles: readonly TileXYZ[]
  /** 通信節約の設定・低速回線なら true（読まない）。 */
  shouldSkip: () => boolean
  /** 下地を出しているか。出していない間は、口が作れなくても待ち時間を数えない（このソースのタイルが表示されないのは当然）。 */
  isShown: () => boolean
  /** 口が作れた（作り直せた）ときに呼ぶ。 */
  onReady: () => void
}

export interface OverviewHold {
  /**
   * 寄せ先の下地のタイルを控えへ載せる。口が使えれば true、使えなければ false
   * （呼び出し側はそのタイルを HTTP の先読みへ回す）。
   */
  loadTarget(tiles: readonly TileXYZ[], signal: AbortSignal): boolean
  /** 止める（タイマー・読み込みを止め、上げた控えの上限を戻す）。 */
  stop(): void
}

/**
 * 2 つの打ち切りのどちらかで打ち切られる合図。使い終わったら `dispose` で付けた聞き手を外す
 * （片方は口が生きている間ずっと生きる合図なので、外さないと読み込みのたびに聞き手が溜まる）。
 */
function eitherAborted(a: AbortSignal, b: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const both = new AbortController()
  const fire = () => both.abort()
  if (a.aborted || b.aborted) both.abort()
  else {
    a.addEventListener('abort', fire, { once: true })
    b.addEventListener('abort', fire, { once: true })
  }
  return {
    signal: both.signal,
    dispose: () => {
      a.removeEventListener('abort', fire)
      b.removeEventListener('abort', fire)
    },
  }
}

export function startOverviewHold(map: MapLibreMap, opts: OverviewHoldOptions): OverviewHold {
  let access: TileCacheAccess | null = null
  /** いまの口で走っている読み込みをまとめて打ち切る合図（口を捨てるときに打つ）。 */
  let accessAbort: AbortController | null = null
  let releaseRoom: (() => void) | null = null
  let unsupported = false
  let stopped = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  /** 下地を出しながら待っている合計（ミリ秒）と、最後に数えた時刻。 */
  let waitedMs = 0
  let lastWaitAt: number | null = null
  let waitWarned = false
  /** 決まった範囲が前回 1 枚も読めなかったか（寄せのたびの補いを止め、1 時間ごとの補いまで待つ） */
  let holdFailedAll = false
  /** 全部読めなかったときの警告を出したか（決まった範囲と寄せ先で別に持つ）。読めた結果か、失敗せずに終わった回を見たら下ろす。口を捨てても下ろす。 */
  const allFailedWarned = { hold: false, target: false }
  let holdRun: AbortController | null = null
  /** 決まった範囲を読んでいる最中に補いを頼まれたら、終わった後にもう 1 度回す。 */
  let refillAgain = false
  /**
   * 決まった範囲の補いを始める位置。読めないことが続いて打ち切った回の後は、打ち切った位置の続きから始める
   * （配信元で欠けたタイルが続く場所があっても、毎回そこで止まって後ろへ届かない、を避ける）。時刻では持たない。
   */
  let holdStart = 0

  const report = (which: 'hold' | 'target', r: FillResult) => {
    // 読めた結果は、打ち切られた回でも配信元が戻った印として扱う（決まった範囲の全滅の印を下ろす）
    if (r.loaded > 0) {
      allFailedWarned[which] = false
      holdFailedAll = false
    }
    if (r.aborted) return
    // 決まった範囲の全滅は、試したぶんが 1 枚も読めなかったときだけ立てる。失敗せずに終わった回（全部載り済みを含む）では下ろす。
    // 何も試さなかった回（並びが空）では変えない
    if (which === 'hold' && r.loaded === 0 && r.failed > 0) holdFailedAll = true
    else if (which === 'hold' && r.failed === 0 && r.skipped > 0) holdFailedAll = false
    if (r.failed === 0) {
      // 失敗せずに終わった回（全部載り済みを含む）は戻った印。次の全滅でまた警告する
      if (r.skipped > 0) allFailedWarned[which] = false
      return
    }
    const cutShort = r.gaveUp ? `（続けて読めないので、残り ${r.unread} 枚は読まずにやめた）` : ''
    const what = which === 'hold' ? '下地' : '寄せ先の下地'
    if (r.loaded === 0 && !allFailedWarned[which]) {
      allFailedWarned[which] = true
      const alreadyHeld = r.skipped > 0 ? `（ほかの ${r.skipped} 枚は載り済み）` : ''
      log.warn(`[gebco] ${what}を地図の控えへ載せようとした ${r.failed} 枚が、1 枚も読めなかった${alreadyHeld}${cutShort}（最初の理由: ${r.firstError}）。遠くへ寄せた直後に海底地形が黒く抜けることがある`)
      return
    }
    log.debug(`[gebco] ${what}: ${r.loaded} 枚を載せ、${r.failed} 枚を載せられなかった${cutShort}（最初の理由: ${r.firstError}）`)
  }

  /** 口を捨てる（その口の読み込みを打ち切り、上げた上限を戻す）。次の待ちは数え直す。 */
  const drop = () => {
    holdFailedAll = false
    // 作り直した口が全滅したら、また警告する
    allFailedWarned.hold = false
    allFailedWarned.target = false
    // 作り直した口の控えは空なので、低い z の土台から載せ直す
    holdStart = 0
    accessAbort?.abort()
    accessAbort = null
    holdRun = null
    refillAgain = false
    try { releaseRoom?.() } catch (e) { log.debug('[gebco] 下地の控えの上限を戻せなかった', e) }
    releaseRoom = null
    access = null
    waitedMs = 0
    lastWaitAt = null
    waitWarned = false
  }

  const scheduleRetry = () => {
    if (retryTimer === null && !stopped) retryTimer = setTimeout(() => { retryTimer = null; tryResolve() }, RETRY_MS)
  }

  /** 待ちの間の時間を数える。下地を出していない間は数えない（出していない間の時間で警告しない）。 */
  const countWait = (reason: string) => {
    const now = Date.now()
    if (lastWaitAt !== null && opts.isShown()) waitedMs += now - lastWaitAt
    lastWaitAt = now
    if (!waitWarned && waitedMs >= NOT_YET_WARN_MS) {
      waitWarned = true
      log.warn(`[gebco] 下地を地図の控えへ載せる準備が ${Math.round(waitedMs / 1000)} 秒たっても整わない（${reason}）。遠くへ寄せた直後に海底地形が黒く抜けることがある`)
    }
  }

  const giveUp = (reason: string) => {
    unsupported = true
    log.warn(`[gebco] 地図の控えへ下地を先に載せられない（${reason}）。遠くへ寄せた直後に海底地形が黒く抜けることがある`)
  }

  function tryResolve() {
    if (stopped || access || unsupported) return
    const r = resolveTileCacheAccess(map, opts.sourceId)
    if (r.kind === 'notYet') {
      if (lastWaitAt === null) log.debug(`[gebco] 下地の控えはまだ載せられない（${r.reason}）。${RETRY_MS / 1000} 秒ごとに試し直す`)
      countWait(r.reason)
      scheduleRetry()
      return
    }
    if (r.kind === 'unsupported') { giveUp(r.reason); return }
    // 口ができた後の準備で例外が出たら、口を捨てて形が違うものとして扱う（中途半端な状態で残さない。
    // ここは effect の本体からも同期で呼ばれるので、例外を外へ漏らすと effect の後始末が返らない）
    try {
      access = r.access
      accessAbort = new AbortController()
      lastWaitAt = null
      waitedMs = 0
      releaseRoom = access.reserve(opts.holdTiles.length)
      opts.onReady()
    } catch (e) {
      drop()
      giveUp(`口を作った後の準備で例外（${e instanceof Error ? e.message : String(e)}）`)
      return
    }
    fillHold()
  }

  /** いまの口。持ち主が替わっていたら作り直す（作り直せなければ null）。 */
  const current = (): TileCacheAccess | null => {
    if (access && !access.isCurrent()) {
      drop()
      tryResolve()
    }
    return access
  }

  /** 決まった範囲の欠けたぶんを補う。1 本ずつ走らせ、走っている間に頼まれたら終わった後にもう 1 度回す。 */
  function fillHold() {
    if (stopped) return
    if (opts.shouldSkip()) { holdRun?.abort(); holdRun = null; refillAgain = false; return }
    const a = current()
    if (!a || !accessAbort) return
    if (holdRun) { refillAgain = true; return }
    const run = new AbortController()
    holdRun = run
    const sig = eitherAborted(run.signal, accessAbort.signal)
    const all = opts.holdTiles
    const start = all.length > 0 ? holdStart % all.length : 0
    const tiles = start === 0 ? all : [...all.slice(start), ...all.slice(0, start)]
    void fillTileCache(a, tiles, sig.signal, HOLD_CONCURRENCY, FAIL_LIMIT).then((r) => {
      sig.dispose()
      if (holdRun !== run) return
      holdRun = null
      // 打ち切った回は、読まずに残した位置から次を始める。最後まで回ったら先頭（低い z）へ戻す
      holdStart = r.gaveUp ? start + (tiles.length - r.unread) : 0
      report('hold', r)
      if (refillAgain && !r.aborted && !holdFailedAll) {
        refillAgain = false
        fillHold()
      }
    })
  }

  tryResolve()
  const refreshTimer = setInterval(fillHold, PREFETCH_REFRESH_MS)

  return {
    loadTarget: (tiles, signal) => {
      if (stopped) return false
      const a = current()
      if (!a || !accessAbort) return false
      // ここで true を返すと、呼び出し側はこの下地を HTTP の先読みから外す。読めなかったタイルを HTTP へ回し直すことは
      // しない —— 同じ URL を HTTP で取っても同じく読めず、次の寄せで打ち切られたタイルはもう行き先ではない。
      // 着地すれば地図が自分で取りに行くので、今までより悪くはならない。
      const sig = eitherAborted(signal, accessAbort.signal)
      // 打ち切りの枚数は同時に読む枚数より多くする（同時に投げた 1 回ぶんの失敗だけで、その回をやめないため）
      void fillTileCache(a, tiles, sig.signal, TARGET_CONCURRENCY, TARGET_CONCURRENCY + FAIL_LIMIT).then((r) => {
        sig.dispose()
        report('target', r)
        // 寄せ先のタイルが控えを押し出したぶんを補う（欠けたものだけ読む）。決まった範囲が前回 1 枚も読めず、
        // その後どこも読めていないなら、寄せのたびには投げ直さず、1 時間ごとの補いまで待つ
        if (!r.aborted && !holdFailedAll) fillHold()
      })
      return true
    },
    stop: () => {
      stopped = true
      if (retryTimer !== null) clearTimeout(retryTimer)
      retryTimer = null
      clearInterval(refreshTimer)
      drop()
    },
  }
}
