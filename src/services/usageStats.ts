/**
 * 使用状況データ（docs/relay-server-design.md §6.6・プライバシーポリシー §1「使用状況データ」）。
 *
 * 送るのは、利用者が同意の窓で［許可する］を押したか、設定の窓「使用状況データを送信する」をオンにした間だけ
 * （既定はオフ。2026-11-03 ユーザー発言「やっぱ規定オフのほうがいいかな。で全員最初にポップアップするようにして、
 * そこで同意した人だけ送るようにするのが誠実な気がする。そこで同意しなかったりポップアップを消した人の情報を送るべきじゃない」）。
 *
 * - 一意の識別子: 初めて許可したときに作るランダムな 32 桁の 16 進。オフにすると消す
 * - 札を取るとき（`POST /token`）に、識別子と端末・設定の情報を添える（→ `relayEndpoint.ts` の `setUsage`）
 * - 操作の回数はメモリで数え、30 分ごとと画面が隠れたときに `POST /usage` へまとめて送る
 *
 * 名前・IP アドレス・登録した地点・鍵の中身は送らない。
 */

import { log } from '../utils/logger'
import {
  encodeUsageSetting, USAGE_NESTED_SETTINGS, USAGE_SETTING_NESTED_SEPARATOR, USAGE_SETTING_SPECS, USAGE_TELEGRAM_BOILERPLATE,
  USAGE_TELEGRAM_TEXT_BLOCKS, USAGE_TOP_LEVEL_SPECS, type UsageTopLevelSettingName,
} from '../utils/usageSettings'
import type { AppSettings } from '../hooks/useSettings'
import { RELAY_ORIGIN, type RelayTokenStore } from './relayEndpoint'

/**
 * タブの名前（`components/IconNav.tsx` の TabId と同じ）。ここは画面の部品を読まない層なので、写して持つ。
 * 型の上で TabId と食い違えば App の `countUsage(\`tab:${tab}\`)` が型で落ちる
 */
type UsageTab = 'earthquake' | 'realtime' | 'tsunami' | 'catalog' | 'telegrams'

/** 一意の識別子を置く鍵 */
export const USAGE_INSTALL_KEY = 'yuremado-usage-install-id'
/**
 * 最後に中継へ送れた設定の全項目の控え（識別子・日本時間の日・値の並び）。同じ日に同じ値なら送らない
 * （2026-11-05 ユーザー選択「変わったときと 1 日 1 回 (Recommended)」。1 回の札で 106 件書くので、札のたびに送ると書き込みが多すぎる）
 */
export const USAGE_PREFS_SENT_KEY = 'yuremado-usage-prefs-sent'
/** 同意の窓に答えた（または閉じた）印。あれば二度と窓を出さない（2026-11-03 ユーザー選択「二度と出さない (Recommended)」） */
export const USAGE_CONSENT_ASKED_KEY = 'yuremado-usage-consent-asked'

/** 送る回数の名前。中継の `usage.ts` の USAGE_NAMES と同じ一覧（中継は一覧に無い名前を捨てる） */
export type UsageName = `tab:${UsageTab}` | 'settings' | 'replay' | 'test' | 'share'

export interface UsageReport {
  install: string
  version: string
  standalone: boolean
  os: string
  browser: string
  form: string
  lang: string
  settings: { apiKey: boolean; tts: boolean; sound: boolean; notify: boolean; seismo: boolean }
  /** 設定の窓の全項目を記録の文字列にしたもの（{@link usageSettingValues}。名前と値の決まりは `utils/usageSettings.ts`） */
  prefs: Record<string, string>
}

/** 報告に載せる設定。値の中身（鍵・URL）は持たず、使っているかだけ */
export interface UsageSettingsFlags {
  apiKey: boolean
  tts: boolean
  sound: boolean
  notify: boolean
  seismo: boolean
}

type Same<A, B> = [Exclude<A, B>, Exclude<B, A>] extends [never, never] ? true : false
type Assert<T extends true> = T
/**
 * 送る項目が設定の全項目と一致していることを型で縛る（設定を足して `utils/usageSettings.ts` へ書き忘れると、ここで型が落ちる）。
 * 入れ子の 2 つ（気象庁の発表文の区分と定型文）は、中の区分まで揃っていることを見る
 */
export type UsageSettingsCoverAll = Assert<Same<keyof AppSettings, UsageTopLevelSettingName | (typeof USAGE_NESTED_SETTINGS)[number]>>
export type UsageTelegramTextBlocksCoverAll = Assert<Same<keyof AppSettings['ttsTelegramTextBlocks'], keyof typeof USAGE_TELEGRAM_TEXT_BLOCKS>>
export type UsageTelegramBoilerplateCoverAll = Assert<Same<keyof AppSettings['ttsTelegramBoilerplate'], keyof typeof USAGE_TELEGRAM_BOILERPLATE>>
type TopSpecs = typeof USAGE_TOP_LEVEL_SPECS
type ChoiceValues<K extends UsageTopLevelSettingName> = Extract<TopSpecs[K]['rule'], { kind: 'choice' }>['values'][number]
type ChoiceKeys = { [K in UsageTopLevelSettingName]: TopSpecs[K]['rule'] extends { kind: 'choice' } ? K : never }[UsageTopLevelSettingName]
/**
 * 選択肢の項目は、決まりの一覧と設定の型が同じ値の集まりであることを型で縛る（設定に値を足して一覧へ書き忘れると落ちる）。
 * 型が素の数（震度・長周期の階級）のものは型では見られないので、`usageSettings.test.ts` が設定の読み込みと突き合わせる
 */
type ChoiceMismatch = { [K in ChoiceKeys]: number extends AppSettings[K] ? never : Same<AppSettings[K], ChoiceValues<K>> extends true ? never : K }[ChoiceKeys]
export type UsageChoicesMatch = Assert<Same<ChoiceMismatch, never>>

/**
 * 設定の窓の全項目を、使用状況データの記録の文字列にする（決まりは `utils/usageSettings.ts`）。
 * 鍵・接続先・登録した地点は入れているかだけ、通知する地域は選んだ数だけになる。
 * 決まりに合わない値（設定の読み込みが揃えるので、ふつうは無い）は送らずにログへ残す。`defaults` は接続先が既定のままかを見るのに使う
 */
export function usageSettingValues(settings: AppSettings, defaults: AppSettings): Record<string, string> {
  const pick = (from: AppSettings, name: string): unknown => {
    const [top, sub] = name.split(USAGE_SETTING_NESTED_SEPARATOR)
    const v = (from as unknown as Record<string, unknown>)[top]
    return sub === undefined ? v : (v as Record<string, unknown> | undefined)?.[sub]
  }
  const out: Record<string, string> = {}
  const rejected: string[] = []
  for (const [name, spec] of Object.entries(USAGE_SETTING_SPECS)) {
    const v = encodeUsageSetting(spec, pick(settings, name), pick(defaults, name))
    if (v === null) rejected.push(name)
    else out[name] = v
  }
  if (rejected.length > 0) log.warn('[使用状況] 決まりに合わない設定の値を送らなかった', rejected)
  return out
}

/** ブラウザの名乗りから、OS とブラウザの種類を粗く見分ける。分からなければ other（中継も一覧に無い値は other に丸める） */
export function classifyUserAgent(ua: string, maxTouchPoints: number): { os: string; browser: string } {
  let os = 'other'
  // iPadOS の Safari は Mac と名乗る。触れる点があれば iPad とみなす
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) os = 'ios'
  else if (/Android/.test(ua)) os = 'android'
  else if (/CrOS/.test(ua)) os = 'chromeos'
  else if (/Windows/.test(ua)) os = 'windows'
  else if (/Macintosh|Mac OS X/.test(ua)) os = 'mac'
  else if (/Linux/.test(ua)) os = 'linux'
  let browser = 'other'
  if (/Edg(A|iOS)?\//.test(ua)) browser = 'edge'
  else if (/SamsungBrowser\//.test(ua)) browser = 'samsung'
  else if (/Firefox\/|FxiOS\//.test(ua)) browser = 'firefox'
  else if (/Chrome\/|CriOS\//.test(ua)) browser = 'chrome'
  else if (/Safari\//.test(ua)) browser = 'safari'
  return { os, browser }
}

/** 画面の大きさの区分。短い辺で分ける（向きを変えても変わらない） */
export function formFactor(width: number, height: number): 'phone' | 'tablet' | 'desktop' {
  const short = Math.min(width, height)
  if (short < 600) return 'phone'
  if (short < 900) return 'tablet'
  return 'desktop'
}

/**
 * ランダムな 32 桁の 16 進。`crypto.randomUUID` は安全な接続（https・localhost）にしか無いので使わない
 * （常時表示の端末は LAN の http:// で開くことがある）。`getRandomValues` はどこでも使える
 */
export function newInstallId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** 保存してある識別子。無い・形が違えば null */
export function storedInstallId(storage: Pick<Storage, 'getItem'>): string | null {
  try {
    const v = storage.getItem(USAGE_INSTALL_KEY)
    return v !== null && /^[0-9a-f]{32}$/.test(v) ? v : null
  } catch (err) {
    log.warn('[使用状況] 識別子を読めなかった', err)
    return null
  }
}

/**
 * 許可しているなら識別子を返す（無ければ作って保存する）。許可していないなら消して null を返す。
 * 保存できない端末では、その起動の間だけの識別子を返す（人数が多めに出るだけで、許可していない人の分は混ざらない）
 */
export function syncInstallId(enabled: boolean, storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): string | null {
  if (!enabled) {
    try { storage.removeItem(USAGE_INSTALL_KEY) } catch (err) { log.warn('[使用状況] 識別子を消せなかった', err) }
    try { storage.removeItem(USAGE_PREFS_SENT_KEY) } catch (err) { log.warn('[使用状況] 送った設定の控えを消せなかった', err) }
    return null
  }
  const existing = storedInstallId(storage)
  if (existing !== null) return existing
  const id = newInstallId()
  try { storage.setItem(USAGE_INSTALL_KEY, id) } catch (err) { log.warn('[使用状況] 識別子を保存できなかった（この起動の間だけ使う）', err) }
  return id
}

/** 端末の保存領域を開けないブラウザ（保存を禁じた設定など）では null */
function localStorageOrNull(): Storage | null {
  try { return window.localStorage } catch { return null }
}

/** {@link syncInstallId} を端末の保存領域で呼ぶ。保存領域が開けなければ、許可していればこの起動の間だけの識別子 */
export function syncInstallIdSafely(enabled: boolean): string | null {
  // 記録のための処理で画面を落とさない。識別子を作れなければ送らない側へ倒す
  try {
    const storage = localStorageOrNull()
    if (storage === null) return enabled ? newInstallId() : null
    return syncInstallId(enabled, storage)
  } catch (err) {
    log.warn('[使用状況] 識別子を用意できなかった（使用状況データを送らない）', err)
    return null
  }
}

/**
 * 同意の窓にもう答えたか（閉じたのも答えに数える）。**保存領域が開けない端末では答えたとみなす** ——
 * 答えを覚えられないので、開くたびに窓が出続ける。出さなければ既定のオフのままで、何も送らない
 */
export function usageConsentAnswered(): boolean {
  const storage = localStorageOrNull()
  if (storage === null) return true
  try {
    return storage.getItem(USAGE_CONSENT_ASKED_KEY) !== null
  } catch (err) {
    log.warn('[使用状況] 同意の窓に答えた印を読めなかった（窓を出さず、送らない）', err)
    return true
  }
}

export function markUsageConsentAnswered(): void {
  try {
    localStorageOrNull()?.setItem(USAGE_CONSENT_ASKED_KEY, '1')
  } catch (err) {
    log.warn('[使用状況] 同意の窓に答えた印を保存できなかった（次に開いたときもう一度出る）', err)
  }
}

/** 日本時間の日の通し番号（1970-01-01 が 0） */
export function usageDay(wallMs: number): number {
  return Math.floor((wallMs + 9 * 3600_000) / 86400_000)
}

function prefsSignature(prefs: Record<string, string>): string {
  return Object.keys(prefs).sort().map(k => `${k}=${prefs[k]}`).join('&')
}

/**
 * 札に添える設定の全項目。同じ識別子で、同じ日（日本時間）に同じ値を送れていれば空にする（送らない）。
 * 控えが読めない・保存できない端末では毎回送る（数が多めに書かれるだけで、欠けはしない）
 */
export function prefsToSend(install: string, prefs: Record<string, string>, wallMs: number, storage: Pick<Storage, 'getItem'> | null): Record<string, string> {
  if (storage === null) return prefs
  try {
    const raw = storage.getItem(USAGE_PREFS_SENT_KEY)
    if (raw === null) return prefs
    const sent = JSON.parse(raw) as { install?: unknown; day?: unknown; sig?: unknown }
    if (sent.install === install && sent.day === usageDay(wallMs) && sent.sig === prefsSignature(prefs)) return {}
    return prefs
  } catch (err) {
    log.warn('[使用状況] 送った設定の控えを読めなかった（設定を送る）', err)
    return prefs
  }
}

/**
 * 中継が報告を添えた札を出したら、送れた設定を控える。中継が受け付けた件数（書けた＋決まりに合わず捨てた。`prefsRecorded`）が
 * 送った件数と揃ったときだけ控える（記録を切ってある・書けなかった・前の版の中継で件数が返らないときは控えず、次の札で送り直す）。
 * 捨てた項目は送り直しても捨てられるだけなので、揃ったものとして扱う。
 * 設定を添えていない報告（同じ日に送り済み）は控えを変えない。日は報告を組んだときの日（{@link usageReportDay}）
 */
export function markPrefsSent(install: string, report: unknown, prefsRecorded: number | null, day: number, storage: Pick<Storage, 'setItem'> | null): void {
  const prefs = (report as { prefs?: unknown } | null)?.prefs
  if (storage === null || typeof prefs !== 'object' || prefs === null) return
  const count = Object.keys(prefs).length
  if (count === 0 || prefsRecorded !== count) return
  try {
    storage.setItem(USAGE_PREFS_SENT_KEY, JSON.stringify({ install, day, sig: prefsSignature(prefs as Record<string, string>) }))
  } catch (err) {
    log.warn('[使用状況] 送った設定の控えを保存できなかった（次の札でも設定を送る）', err)
  }
}

/** 報告を組んだときの日（日本時間）。送れたと控えるときにこの日を使う（日をまたいで返った札で、翌日の分を送り済みにしない） */
const reportDays = new WeakMap<object, number>()
export function usageReportDay(report: unknown): number | null {
  return typeof report === 'object' && report !== null ? reportDays.get(report) ?? null : null
}

/** 札に添える報告を組む（設定の全項目は、同じ日に同じ値を送れていれば空）。組んだ日を覚えておく。`nowMs` はサーバーの時刻 */
export function buildUsageReportNow(install: string, flags: UsageSettingsFlags, allPrefs: Record<string, string>, env: Parameters<typeof buildUsageReport>[3], nowMs: number): UsageReport {
  const report = buildUsageReport(install, flags, prefsToSend(install, allPrefs, nowMs, localStorageOrNull()), env)
  reportDays.set(report, usageDay(nowMs))
  return report
}

/** {@link markPrefsSent} を端末の保存領域で呼ぶ（日は報告を組んだときの日。分からなければ控えない） */
export function markPrefsSentSafely(install: string, report: unknown, prefsRecorded: number | null): void {
  const day = usageReportDay(report)
  if (day === null) return
  markPrefsSent(install, report, prefsRecorded, day, localStorageOrNull())
}

/** 操作の回数をまとめて送る間隔 */
export const USAGE_FLUSH_INTERVAL_MS = 30 * 60_000

/** 札に添える報告を組む */
export function buildUsageReport(install: string, flags: UsageSettingsFlags, prefs: Record<string, string>, env: {
  version: string
  standalone: boolean
  userAgent: string
  maxTouchPoints: number
  screenWidth: number
  screenHeight: number
  language: string
}): UsageReport {
  const { os, browser } = classifyUserAgent(env.userAgent, env.maxTouchPoints)
  return {
    install, version: env.version, standalone: env.standalone, os, browser,
    form: formFactor(env.screenWidth, env.screenHeight),
    lang: env.language, settings: { ...flags }, prefs: { ...prefs },
  }
}

/** いまの端末の様子（ブラウザの値を読む）。版はビルドが注入した値を呼ぶ側から渡す */
export function browserUsageEnv(version: string): Parameters<typeof buildUsageReport>[3] {
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches === true
    || (navigator as Navigator & { standalone?: boolean }).standalone === true
  return {
    version,
    standalone,
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    screenWidth: window.screen?.width ?? window.innerWidth,
    screenHeight: window.screen?.height ?? window.innerHeight,
    language: navigator.language ?? '',
  }
}

/** 操作の回数。送るまでメモリで数える（送れなかった分は次の回に足す） */
export function createUsageCounter() {
  let counts = new Map<UsageName, number>()
  return {
    count(name: UsageName): void {
      counts.set(name, (counts.get(name) ?? 0) + 1)
    },
    /** 数えた分を取り出して空にする */
    take(): Record<string, number> | null {
      if (counts.size === 0) return null
      const out = Object.fromEntries(counts)
      counts = new Map()
      return out
    },
    /** 送れなかった分を戻す。数えるのをやめている（許可を外した）なら戻さない —— 次に許可したときの別の識別子へ混ぜない */
    restore(back: Record<string, number>): void {
      if (!counting) return
      for (const [k, n] of Object.entries(back)) counts.set(k as UsageName, (counts.get(k as UsageName) ?? 0) + n)
    },
    clear(): void {
      counts = new Map()
    },
  }
}

export type UsageCounter = ReturnType<typeof createUsageCounter>

/**
 * 数えた回数を `POST /usage` へ送る。札は識別子入りのものを使う（許可していない端末は呼ばない）。
 * `keepalive` で送るので、画面を閉じる間際でも届く。失敗した分は数え直しに戻す
 */
export async function flushUsage(counter: UsageCounter, store: RelayTokenStore, fetcher: typeof fetch = fetch): Promise<void> {
  const counts = counter.take()
  if (counts === null) return
  if (store.usageInstall() === null) return
  try {
    // 接続を張りっぱなしの端末では札が切れたままのことがある（札は張り直すときにしか取り直さない）。送る前に用意する
    const token = await store.ensure()
    // 待っている間に許可を外した
    if (store.usageInstall() === null) return
    const res = await fetcher(`${RELAY_ORIGIN}/usage`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ counts }),
      keepalive: true,
    })
    if (res.ok) return
    // 札の期限切れ（401）・混み合い（429）・中継の不調（5xx）は次の回に送り直す。ほか（識別子の無い札・形が違う）は戻さない
    const retry = res.status === 401 || res.status === 429 || res.status >= 500
    if (res.status === 401) store.invalidate()
    if (retry) counter.restore(counts)
    log.warn(`[使用状況] 操作の回数を送れなかった（HTTP ${res.status}・${retry ? '次の回に送る' : '捨てる'}）`)
  } catch (err) {
    counter.restore(counts)
    log.warn('[使用状況] 操作の回数を送れなかった（次の回に送る）', err)
  }
}

/** アプリが使う 1 つの数え手 */
export const usageCounter = createUsageCounter()

/** 許可している間だけ数える。許可していなければ何もしない（数えた分も持たない） */
let counting = false
export function setUsageCounting(on: boolean): void {
  counting = on
  if (!on) usageCounter.clear()
}

export function countUsage(name: UsageName): void {
  if (counting) usageCounter.count(name)
}

/** 手の一式を、呼ぶたびに `name` を 1 回数える形に包む（テストボタンの一式など） */
export function withUsageCount<T extends Record<string, (...args: never[]) => unknown>>(name: UsageName, handlers: T): T {
  const out: Record<string, (...args: never[]) => unknown> = {}
  for (const [key, fn] of Object.entries(handlers)) {
    out[key] = (...args: never[]) => {
      countUsage(name)
      return fn(...args)
    }
  }
  return out as T
}
