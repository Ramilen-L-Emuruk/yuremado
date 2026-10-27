// 管理画面のブラウザ通知の見張り（#313・2026-10-27 ユーザー承認）。
//
// - **どのタブを開いていても動く**（タブの世代とは別に、画面を開いてから閉じるまで 1 本）。
//   稼働状況タブの見回り（`viewStatus.ts`）は自分のタブにいる間しか `/status` を読まないので、それとは別に読む。
// - **設定はブラウザごと**（localStorage。同日ユーザー承認）。読むのは通知を出す直前で、タブで切り替えたら次から効く。
// - **許されていないあいだも控えは進める。** 許した瞬間に、それまでに出ていた警告がまとめて届かないように。
// - **見張りの不調は通知タブに 1 行ずつ出す**（同日ユーザー承認「通知＋通知タブ」。{@link watcherProblems}）。
//   ホストの状態を読めないことは、警告として通知も出す（`adminNotify.ts` の `WarningTracker`）。
// - 何を知らせるかは `adminNotify.ts` が決める。ここは取りに行って、渡して、出すだけ。

import { ShakeTracker, WarningTracker, type AdminNotification } from './adminNotify'
import { collectStatusWarnings, type StatusReportView } from './viewStatus'
import { openWaveStream, type WaveStreamState } from './waveStream'

/** 設定を置く localStorage の鍵。 */
export const NOTIFY_SETTINGS_KEY = 'seismo-admin-notify'

export interface NotifySettings {
  /** 稼働状況の警告が出たとき。 */
  readonly warnings: boolean
  /** 警告が解消したとき。 */
  readonly resolved: boolean
  /** 揺れを記録したとき（照合で判定が変わったら書き換える）。 */
  readonly shakes: boolean
}

/** 初めて開いたときは 3 つとも出す（どれも知らせると決めたもの）。通知を出すかはブラウザの許可で決まる。 */
export const DEFAULT_NOTIFY_SETTINGS: NotifySettings = { warnings: true, resolved: true, shakes: true }

/**
 * この画面の localStorage。**使えないブラウザ（保存を切った・プライベートの一部）では null。**
 * 参照しただけで投げるブラウザがあるので、`localStorage` を直に書かずにこれを通す。
 */
export function notifyStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** 設定を読む。**読めないとき・読めない欄は既定へ倒す**（前の版が書いた形や、手で書き換えた値で画面を止めない）。 */
export function readNotifySettings(storage: Pick<Storage, 'getItem'> | null): NotifySettings {
  if (storage === null) return DEFAULT_NOTIFY_SETTINGS
  let raw: unknown
  try {
    raw = JSON.parse(storage.getItem(NOTIFY_SETTINGS_KEY) ?? 'null')
  } catch {
    return DEFAULT_NOTIFY_SETTINGS
  }
  if (typeof raw !== 'object' || raw === null) return DEFAULT_NOTIFY_SETTINGS
  const v = raw as Record<string, unknown>
  const pick = (key: keyof NotifySettings): boolean =>
    typeof v[key] === 'boolean' ? (v[key] as boolean) : DEFAULT_NOTIFY_SETTINGS[key]
  return { warnings: pick('warnings'), resolved: pick('resolved'), shakes: pick('shakes') }
}

/** 設定を書く。**書けたかを返す**（容量・保存を切ったブラウザで投げる。呼び手が画面に出す）。 */
export function writeNotifySettings(storage: Pick<Storage, 'setItem'> | null, settings: NotifySettings): boolean {
  if (storage === null) return false
  try {
    storage.setItem(NOTIFY_SETTINGS_KEY, JSON.stringify(settings))
    return true
  } catch {
    return false
  }
}

/**
 * 通知を出せるか。**使えない開き方（https でも localhost でもない）は「拒否」と同じに扱う**
 * （画面の一言も同じ。2026-10-27 ユーザー承認「ブロックと同じ文」）。
 */
export type NotifyPermission = 'granted' | 'default' | 'blocked'

export function notifyPermission(): NotifyPermission {
  if (typeof Notification === 'undefined' || !globalThis.isSecureContext) return 'blocked'
  if (Notification.permission === 'granted') return 'granted'
  if (Notification.permission === 'denied') return 'blocked'
  return 'default'
}

/** 見張りの不調（通知タブに 1 行ずつ出す）。不調が無ければ全部 false / null。 */
export interface WatcherProblems {
  /** `/status` を続けて読めていない。 */
  readonly hostUnreachable: boolean
  /** 揺れの記録の押し出しが切れている（繋ぎ直している）。 */
  readonly streamDown: boolean
  /** 最後に通知を出せなかった理由（出せたら null へ戻す）。 */
  readonly notifyError: string | null
}

let problems: WatcherProblems = { hostUnreachable: false, streamDown: false, notifyError: null }
const problemListeners = new Set<(p: WatcherProblems) => void>()

/** いまの不調。 */
export function watcherProblems(): WatcherProblems {
  return problems
}

/** 不調が変わったら呼ぶ。返り値で外す。 */
export function onWatcherProblems(listener: (p: WatcherProblems) => void): () => void {
  problemListeners.add(listener)
  return () => problemListeners.delete(listener)
}

function setProblems(patch: Partial<WatcherProblems>): void {
  const next = { ...problems, ...patch }
  if (
    next.hostUnreachable === problems.hostUnreachable &&
    next.streamDown === problems.streamDown &&
    next.notifyError === problems.notifyError
  ) {
    return
  }
  problems = next
  for (const l of problemListeners) l(problems)
}

/** 稼働状況を読み直す間隔。稼働状況タブの見回りと同じ。 */
const POLL_MS = 5000

/** 1 回の読み取りの上限。応答が返らない回も「読めなかった」に数える。 */
const POLL_TIMEOUT_MS = 10_000

/** 押し出しが閉じた（向こうが繋ぎ直しをやめた）ときに開き直すまでの間。 */
const STREAM_REOPEN_MS = 30_000

/** ブラウザの通知を出す。出せたかを不調の 1 行へ反映する。 */
function showBrowserNotification(n: AdminNotification): void {
  if (notifyPermission() !== 'granted') return
  try {
    new Notification(n.title, { body: n.body, tag: n.tag })
    setProblems({ notifyError: null })
  } catch (error) {
    // 出せなかったことは画面の働きを止める理由にならない。通知タブに理由を出す。
    const reason = error instanceof Error ? error.message : String(error)
    console.warn('[admin] 通知を出せない:', reason)
    setProblems({ notifyError: reason })
  }
}

/** 見張りが外とやりとりする口（テストで差し替える）。 */
export interface NotifyWatcherDeps {
  readonly fetch: (url: string, init: { signal: AbortSignal }) => Promise<Response>
  readonly openStream: typeof openWaveStream
  readonly storage: () => Pick<Storage, 'getItem'> | null
  readonly show: (n: AdminNotification) => void
  readonly now: () => number
}

const DEFAULT_DEPS: NotifyWatcherDeps = {
  fetch: (url, init) => fetch(url, init),
  openStream: openWaveStream,
  storage: notifyStorage,
  show: showBrowserNotification,
  now: () => Date.now(),
}

/**
 * `signal` か時間切れのどちらかで打ち切る合図を作る。**`AbortSignal.any`・`AbortSignal.timeout` を使わない** ——
 * 無いブラウザ（Safari 17.4 より前など）で毎回投げると、ホストが元気でも「ホストの状態を読めない」を出し続ける。
 */
function abortAfter(signal: AbortSignal, ms: number): { readonly signal: AbortSignal; readonly done: () => void } {
  const ctl = new AbortController()
  const onAbort = (): void => ctl.abort()
  if (signal.aborted) ctl.abort()
  else signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => ctl.abort(), ms)
  return {
    signal: ctl.signal,
    done: () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    },
  }
}

/** 見張りを始める。**画面を閉じるまで動かし続ける**（`signal` は試すときに止めるため）。 */
export function startNotifyWatcher(signal: AbortSignal, deps: NotifyWatcherDeps = DEFAULT_DEPS): void {
  const warnings = new WarningTracker()
  const shakes = new ShakeTracker(deps.now())
  const show = deps.show
  let polling = false
  setProblems({ hostUnreachable: false, streamDown: false, notifyError: null })

  const poll = async (): Promise<void> => {
    // **前の回が終わるまで次を投げない。** 遅れて届いた古い応答で控えを巻き戻すと、無かった出入りを知らせる。
    if (polling || signal.aborted) return
    polling = true
    try {
      let status: StatusReportView | null = null
      const cut = abortAfter(signal, POLL_TIMEOUT_MS)
      try {
        const res = await deps.fetch('/status', { signal: cut.signal })
        if (res.ok) status = (await res.json()) as StatusReportView
      } catch {
        // 下で「読めなかった回」として数える。
      } finally {
        cut.done()
      }
      if (signal.aborted) return
      const want = readNotifySettings(deps.storage())
      let out: readonly AdminNotification[]
      if (status === null) {
        out = warnings.onFailure(want)
      } else {
        try {
          out = warnings.onStatus(collectStatusWarnings(status), want)
        } catch (error) {
          // 形の合わない応答は「読めなかった回」と同じに扱う（控えは動かさない）。
          console.warn('[admin] 稼働状況を通知の見張りで読めない:', error instanceof Error ? error.message : String(error))
          out = warnings.onFailure(want)
        }
      }
      setProblems({ hostUnreachable: warnings.hostUnreachable })
      for (const n of out) show(n)
    } finally {
      polling = false
    }
  }

  void poll()
  const timer = setInterval(() => void poll(), POLL_MS)
  signal.addEventListener('abort', () => clearInterval(timer), { once: true })

  let unreadableWarned = false
  /** 閉じて開き直している最中か（開き直した直後の「繋いでいる」も、切れている側に数える）。 */
  let reopening = false
  /** いまの押し出しを止める合図と、開き直しの待ち。**どちらも 1 つだけ持つ**（開き直すたびに待ち受けを足さない）。 */
  let current: AbortController | null = null
  let reopenTimer: ReturnType<typeof setTimeout> | null = null
  signal.addEventListener(
    'abort',
    () => {
      current?.abort()
      if (reopenTimer !== null) clearTimeout(reopenTimer)
    },
    { once: true },
  )
  const openStream = (): void => {
    reopenTimer = null
    if (signal.aborted) return
    const local = new AbortController()
    current = local
    deps.openStream({
      wave: false,
      diff: null,
      residual: null,
      signal: local.signal,
      onState: (state: WaveStreamState) => {
        if (state === 'open') reopening = false
        if (state === 'closed') reopening = true
        setProblems({ streamDown: state === 'reconnecting' || state === 'closed' || (state === 'connecting' && reopening) })
        if (state !== 'closed' || local.signal.aborted) return
        // **閉じたら自分で開き直す。** 向こうは繋ぎ直しをやめるので（`waveStream.ts`）、放っておくと
        // 揺れの記録の通知が二度と来ない（購読の上限で断られた・ホストを再起動した、など）。
        local.abort()
        if (!signal.aborted) reopenTimer = setTimeout(openStream, STREAM_REOPEN_MS)
      },
      onShakeEvent: (rec) => {
        const n = shakes.onRecord(rec)
        if (n !== null && readNotifySettings(deps.storage()).shakes) show(n)
      },
      onUnreadable: (_count, detail) => {
        // 1 件ごとに出すとコンソールが埋まる。最初の 1 回だけ。
        if (unreadableWarned) return
        unreadableWarned = true
        console.warn('[admin] 通知の見張りで読めない押し出し:', detail)
      },
    })
  }
  openStream()
}
