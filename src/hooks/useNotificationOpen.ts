import { useEffect, useRef } from 'react'
import type { TabId } from '../components/IconNav'
import type { JMAQuake } from '../types/earthquake'
import { matchEstimatedIntensityArrival } from '../utils/estimatedIntensity'
import { internationalTsunamiOpenKey } from '../utils/internationalTsunami'
import { log } from '../utils/logger'
import { notificationOpenQuery, parseNotificationOpen, withoutNotificationOpen, type NotificationOpen } from '../utils/notificationOpen'
import { subscribeNotificationOpen } from '../utils/notificationClick'
import { extractQuakeEventId, quakeEventKey } from '../utils/quakeMerge'

/**
 * 押した通知の地震がまだ一覧に無いとき、届くのを待つ上限（ms）。アプリが閉じていて通知から開いたときは、
 * 地震の一覧を取り終えるまでカードが無い（2026-11-05 ユーザー選択「手で選んだのと同じ扱い (Recommended)」の説明
 * 「届くまで最大 30 秒待ってから選ぶ。それでも無ければタブだけ移す」）。
 */
export const NOTIFICATION_OPEN_WAIT_MS = 30_000

/** 開き先の地震を、いまの一覧でどう扱うか */
export type NotificationOpenTarget =
  /**
   * 選べる（鍵は `quakeEventKey`）。`pin` が真なら、地震タブの絞りで隠れている地震なので、
   * 絞りの例外として一覧にも出してから選ぶ（2026-11-07 選択「その地震を一覧にも出して開く (Recommended)」）
   */
  | { readonly kind: 'select'; readonly key: string; readonly pin: boolean }
  /** まだ一覧に無い（届くのを待つ） */
  | { readonly kind: 'wait' }
  /** 一覧にはあるが選べない（待っても変わらない） */
  | { readonly kind: 'giveUp'; readonly reason: string }
  /** 地震を指さない開き先（タブを移すだけ） */
  | { readonly kind: 'none' }

/**
 * 開き先の地震を引く。`all` は届いた地震カードすべて、`shown` はそのうち地震タブに出ているもの（表示の絞りを通した一覧）。
 * 取り消されたカード（選ぶとすぐ外れる）は、待っても選べないので諦める。
 */
export function resolveNotificationOpen(
  open: NotificationOpen, shown: readonly JMAQuake[], all: readonly JMAQuake[],
): NotificationOpenTarget {
  let candidates: readonly JMAQuake[]
  if ('quake' in open) candidates = all.filter(q => quakeEventKey(q) === open.quake)
  else if ('lpgm' in open) candidates = all.filter(q => extractQuakeEventId(q) === open.lpgm)
  else if ('estimated' in open) candidates = all.filter(q => matchEstimatedIntensityArrival(q, open.estimated, open.lat, open.lon))
  else if ('wepa60' in open) {
    // 画面と同じ選び方で付く先を引く。付く地震カードの無い英文は、英文だけのカードとして `shown` にだけある（届いた地震カードの一覧には無い）
    const key = internationalTsunamiOpenKey(all, open.wepa60, open.lat, open.lon)
    candidates = [...all, ...shown.filter(q => q.fromInternationalTsunami)].filter(q => quakeEventKey(q) === key)
  } else return { kind: 'none' }
  if (candidates.length === 0) return { kind: 'wait' }
  const live = candidates.filter(q => !q.cancelledAt)
  if (live.length === 0) return { kind: 'giveUp', reason: '取り消された地震' }
  // 候補が複数あるとき（推計を時刻だけで当てたときなど）は、地震タブに出ているものを選ぶ。
  // どれも絞りで隠れていれば、最初の候補を一覧にも出して選ぶ
  const shownKeys = new Set(shown.map(quakeEventKey))
  const visible = live.find(q => shownKeys.has(quakeEventKey(q)))
  return visible ? { kind: 'select', key: quakeEventKey(visible), pin: false } : { kind: 'select', key: quakeEventKey(live[0]), pin: true }
}

export interface NotificationOpenActions {
  /** 手で選んだのと同じ扱いでタブを移す（`setActiveTabByUser`） */
  readonly openTab: (tab: TabId) => void
  /** 手で選んだのと同じ扱いで地震カードを選び、地図を寄せる（`selectQuake(key, { explicit: true })`） */
  readonly selectQuake: (eventKey: string) => void
  /** 地震タブの絞りで隠れている地震を、絞りの例外として一覧に出す（選ぶ前に呼ぶ） */
  readonly pinQuake: (eventKey: string) => void
  /** 長周期の表示を開く（電文の `eventId`） */
  readonly openLpgm: (eventId: string) => void
  /** その地震カードの震度分布を開く（推計震度分布図の通知） */
  readonly openDistribution: (eventKey: string) => void
}

/** 利用者の操作を見るための、いまの画面の状態 */
export interface NotificationOpenScreen {
  /** 表示中のタブ */
  readonly activeTab: TabId
  /** 地震を明示的に選んだ回数（`quakeSelectionTick`。カードを押す・リンクで移る、で進む） */
  readonly selectionTick: number
}

interface Pending {
  readonly open: NotificationOpen
  /** 待つ期限（`performance.now()` の値。壁時計は補正で前後するので使わない） */
  readonly deadline: number
  /** 張った時点の選択の回数。進んだら利用者が地震を選び直したので、待ちを捨てる */
  readonly selectionTick: number
  /** 開き先のタブへ移ったのを見たか。見た後で別のタブになったら、利用者が移ったので待ちを捨てる */
  tabReached: boolean
}

/**
 * 通知を押したときの開き先へ画面を移す（→ `utils/notificationOpen.ts`）。
 *
 * - **開いている画面**へは Service Worker・ページの通知から知らされる（`subscribeNotificationOpen`）
 * - **閉じていたとき**は開き先が URL の問い合わせに付いて開くので、最初の描画で読み、URL からは消す
 *   （再読み込みでもう一度その地震へ飛ばない）
 *
 * タブはすぐ移す。地震を指す開き先は、カードが一覧に現れたら選ぶ。{@link NOTIFICATION_OPEN_WAIT_MS} 待っても
 * 現れなければ、タブを移しただけで諦めて記録を残す。**待っている間に利用者が地震を選び直したり別のタブへ移ったら、
 * 待ちを捨てる**（後から届いた一覧で、手で選んだものを奪わない）。後から別の通知を押したときも、前の待ちは捨てる。
 */
export function useNotificationOpen(
  shown: readonly JMAQuake[], all: readonly JMAQuake[], screen: NotificationOpenScreen, actions: NotificationOpenActions,
): void {
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  const shownRef = useRef(shown)
  shownRef.current = shown
  const allRef = useRef(all)
  allRef.current = all
  const screenRef = useRef(screen)
  screenRef.current = screen
  const pendingRef = useRef<Pending | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  /** 待っている開き先を、いまの一覧と画面で決着させる。`expired` は期限のタイマーから呼んだとき */
  const resolvePending = useRef((expired: boolean) => {
    const pending = pendingRef.current
    if (pending === null) return
    const query = notificationOpenQuery(pending.open)
    const { activeTab, selectionTick } = screenRef.current
    if (activeTab === pending.open.tab) pending.tabReached = true
    if (selectionTick !== pending.selectionTick || (pending.tabReached && activeTab !== pending.open.tab)) {
      pendingRef.current = null
      clearTimeout(timerRef.current)
      log.info(`[notify] 押した通知の地震を待つ間に、別の地震を選んだか別のタブへ移ったので、待ちをやめた（${query}）`)
      return
    }
    const target = resolveNotificationOpen(pending.open, shownRef.current, allRef.current)
    if (target.kind === 'wait') {
      if (!expired && performance.now() < pending.deadline) return
      pendingRef.current = null
      log.warn(`[notify] 押した通知の地震が ${NOTIFICATION_OPEN_WAIT_MS / 1000} 秒待っても届かないので、タブだけ移した（${query}）`)
      return
    }
    pendingRef.current = null
    clearTimeout(timerRef.current)
    if (target.kind === 'giveUp') {
      log.warn(`[notify] 押した通知の地震は${target.reason}なので、タブだけ移した（${query}）`)
      return
    }
    if (target.kind === 'none') return
    const a = actionsRef.current
    if (target.pin) a.pinQuake(target.key)
    a.selectQuake(target.key)
    if ('lpgm' in pending.open) a.openLpgm(pending.open.lpgm)
    else if ('estimated' in pending.open) a.openDistribution(target.key)
  }).current

  useEffect(() => {
    const arm = (ms: number) => {
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => resolvePending(true), Math.max(0, ms))
    }
    const apply = (open: NotificationOpen) => {
      actionsRef.current.openTab(open.tab)
      pendingRef.current = {
        open,
        deadline: performance.now() + NOTIFICATION_OPEN_WAIT_MS,
        selectionTick: screenRef.current.selectionTick,
        tabReached: false,
      }
      clearTimeout(timerRef.current)
      resolvePending(false)
      // 一覧が変わらないまま期限を過ぎたときも、諦めた記録を残す
      if (pendingRef.current !== null) arm(NOTIFICATION_OPEN_WAIT_MS)
    }
    // 外して付け直したとき（開発時の二重実行など）も、残っている待ちの期限を張り直す
    if (pendingRef.current !== null) arm(pendingRef.current.deadline - performance.now())
    const unsubscribe = subscribeNotificationOpen(apply)
    const search = window.location.search
    const rest = withoutNotificationOpen(search)
    if (search !== rest) {
      const fromUrl = parseNotificationOpen(search)
      window.history.replaceState(window.history.state, '', window.location.pathname + rest + window.location.hash)
      if (fromUrl) {
        log.info(`[notify] 通知から開いたので、その開き先へ移る（${notificationOpenQuery(fromUrl)}）`)
        apply(fromUrl)
      } else {
        log.warn(`[notify] 通知から開いたが、URL の開き先を読めなかった（${search}）`)
      }
    }
    return () => {
      unsubscribe()
      clearTimeout(timerRef.current)
    }
  }, [resolvePending])

  // 一覧や画面が変わるたびに、待っている地震が現れたか・利用者が選び直したかを見る
  useEffect(() => { resolvePending(false) }, [shown, all, screen.activeTab, screen.selectionTick, resolvePending])
}
