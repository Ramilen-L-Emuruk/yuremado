// テストから、テストボタンの台本（`utils/testTelegramScripts.ts`）の電文を取り出す入口。
//
// **アプリ本体は使わない。** 本体は `utils/testTelegrams.ts` の `buildTestTelegramEntries` を
// 直接呼ぶ（ブラウザから `fetch` する）。こちらはその Node 版で、置いてある電文をファイルから
// 読む点だけが違う。
//
// ## なぜ要るのか
//
// テストボタンの中身が「手で組んだ内部型」から「電文をパーサーへ通したもの」へ変わった
// （→ `utils/testTelegrams.ts` 冒頭）。既存のテストはその内部型を同期的に作る関数
// （`createTestEEWWarning` など）を呼んでいたので、同じものを台本から取れるようにする。
//
// **1 回読んだら控える。** 同じ電文を何度も読む（`useEarthquakes.wiring.test.ts` は 1 ファイルで
// 20 回以上呼ぶ）ので、読み直すとテストが目に見えて遅くなる。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppEvent, EEWAlert, JMAQuake, JMATsunami, JMALpgm, JMANankai, JMANankaiCommentary, JMAKohatsu, JMAQuakeNotice, JMAEarthquakeCount, JMAEstimatedIntensity } from '../types/earthquake'
import type { ReplayPayload } from '../types/replay'
import { buildTestTelegramEntries, type TestTelegramScript } from '../utils/testTelegrams'

// **`new URL(`…${file}`, import.meta.url)` の形で書かないこと。** Vite はこの形を静的な資材の
// 参照へ書き換え、`public` 配下は対象外なので `undefined` を返す。
const TELEGRAM_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../public/data/test-telegrams')
const fetcher = async (file: string): Promise<string> => readFileSync(join(TELEGRAM_DIR, file), 'utf8')
const binaryFetcher = async (file: string): Promise<Uint8Array> => new Uint8Array(readFileSync(join(TELEGRAM_DIR, file)))

// `DOMParser` / `XMLSerializer` が無ければ jsdom から借りる。
//
// **電文の読み取り（`dmdataParser.ts`）と書き換え（`testTelegramRewrite.ts`）はどちらもこれを使う。**
// 呼ぶ側のテストが jsdom 環境とは限らない（既定は node）ので、ここで揃えておく —— 揃えないと、
// node 環境のテストから台本を取ったときだけ「電文を読み取れなかった」で空が返り、**何も確かめない
// まま通る**（パーサーは読めない電文を捨てて `null` を返す）。
//
// **トップレベルで読む。** テスト本体の中で初めて読むと、jsdom の解決と変換（実測 42 秒）が
// 1 件目の所要時間に乗って時間切れになる（→ CLAUDE.md「テスト本体の中で対象モジュールを
// 初めて読まないこと」）。ここで読めば待ちはファイル読み込み時へ移り、`testTimeout` の対象から外れる。
if (typeof globalThis.DOMParser === 'undefined' || typeof globalThis.XMLSerializer === 'undefined') {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('')
  Object.assign(globalThis, { DOMParser: dom.window.DOMParser, XMLSerializer: dom.window.XMLSerializer })
}

/** 台本を組んだ結果（控える）。鍵は台本の名前と版。 */
const cache = new Map<string, Promise<ReplayPayload[]>>()

/** テストが使う「いま」。**固定する** —— 電文の時刻の寄せ方と事象の識別子がここから決まる。 */
export const FIXTURE_NOW = new Date('2026-10-22T03:00:00.000Z')

/**
 * 台本の電文をパーサーへ通して返す。
 *
 * @param name 台本の名前（`testTelegramScripts.ts` の export 名）
 * @param options.isDmdss DMDSS 版として組むか（既定は true）
 * @param options.now 「いま」。**押すたびに別の地震にしたいときだけ変える**（既定は固定値）
 */
export async function telegramPayloads(
  name: string,
  options: { isDmdss?: boolean; now?: Date } = {},
): Promise<ReplayPayload[]> {
  const isDmdss = options.isDmdss ?? true
  const now = options.now ?? FIXTURE_NOW
  const key = `${name}|${isDmdss}|${now.getTime()}`
  let pending = cache.get(key)
  if (!pending) {
    pending = (async () => {
      const scripts = await import('../utils/testTelegramScripts') as unknown as Record<string, TestTelegramScript>
      const script = scripts[name]
      if (!script) throw new Error(`テスト用の台本がありません: ${name}`)
      const built = await buildTestTelegramEntries(script, { isDmdss, now, fetcher, binaryFetcher })
      return built.map(b => b.entry.payload)
    })()
    cache.set(key, pending)
  }
  return pending
}

/** 台本の電文のうち、画面へ流す出来事（地震・津波・緊急地震速報）だけ。 */
export async function telegramEvents(name: string, options?: { isDmdss?: boolean; now?: Date }): Promise<AppEvent[]> {
  const payloads = await telegramPayloads(name, options)
  return payloads.flatMap(p => (p.kind === 'event' ? [p.event] : []))
}

/** 取り出しの引数。どれも同じなのでまとめる。 */
type Options = { isDmdss?: boolean; now?: Date }

/**
 * 種別ごとの取り出し。**空で返ったらテスト側の台本の選び方が違う**（型では気づけないので、
 * 1 通だけ要るときは {@link first} を通すこと）。
 *
 * **ジェネリクスでまとめない。** 1 つの関数で全種別を返そうとすると、戻り値の型が
 * 「どの種別の `data` でもある」交差型になって使えない。種別ごとに書くほうが短く読める。
 */
export const telegramQuakes = async (name: string, o?: Options): Promise<JMAQuake[]> =>
  (await telegramEvents(name, o)).flatMap(e => (e.kind === 'quake' ? [e] : []))
export const telegramTsunamis = async (name: string, o?: Options): Promise<JMATsunami[]> =>
  (await telegramEvents(name, o)).flatMap(e => (e.kind === 'tsunami' ? [e] : []))
export const telegramEews = async (name: string, o?: Options): Promise<EEWAlert[]> =>
  (await telegramEvents(name, o)).flatMap(e => (e.kind === 'eew' ? [e] : []))
export const telegramLpgms = async (name: string, o?: Options): Promise<JMALpgm[]> =>
  (await telegramPayloads(name, o)).flatMap(p => (p.kind === 'lpgm' ? [p.data] : []))
export const telegramNankais = async (name: string, o?: Options): Promise<JMANankai[]> =>
  (await telegramPayloads(name, o)).flatMap(p => (p.kind === 'nankai' ? [p.data] : []))
export const telegramCommentaries = async (name: string, o?: Options): Promise<JMANankaiCommentary[]> =>
  (await telegramPayloads(name, o)).flatMap(p => (p.kind === 'nankaiCommentary' ? [p.data] : []))
export const telegramKohatsus = async (name: string, o?: Options): Promise<JMAKohatsu[]> =>
  (await telegramPayloads(name, o)).flatMap(p => (p.kind === 'kohatsu' ? [p.data] : []))
export const telegramNotices = async (name: string, o?: Options): Promise<JMAQuakeNotice[]> =>
  (await telegramPayloads(name, o)).flatMap(p => (p.kind === 'quakeNotice' ? [p.data] : []))
export const telegramCounts = async (name: string, o?: Options): Promise<JMAEarthquakeCount[]> =>
  (await telegramPayloads(name, o)).flatMap(p => (p.kind === 'earthquakeCount' ? [p.data] : []))
export const telegramEstimatedIntensities = async (name: string, o?: Options): Promise<JMAEstimatedIntensity[]> =>
  (await telegramPayloads(name, o)).flatMap(p => (p.kind === 'estimatedIntensity' ? [p.data] : []))

/**
 * 緊急地震速報の報を、**事象の識別子と報番号を指定して**作る。
 *
 * 台本（`EEW_WARNING` の警報報）を土台に、識別子・報番号・発表時刻だけを差し替える。
 * 続報の扱い（報番号で古い報を弾く・同じ地震へ束ねる）を確かめるテストが使う。
 *
 * **中身は実電文のまま。** 予想区域・精度・固定付加文はサンプル電文（2024-04-17 豊後水道）の値で、
 * 手で組んだ頃のように「実配信に無い組み合わせ」になる心配が無い。
 *
 * @param eventId 事象の識別子（14 桁）
 * @param serial 報番号（1 から）
 * @param over 上書きしたい欄（取消の印など）
 */
export function makeEewReport(base: EEWAlert, eventId: string, serial = 1, over: Partial<EEWAlert> = {}): EEWAlert {
  // **時刻は呼んだ時点へ寄せる。** 台本の電文は 2024-04-17 のもので、そのまま流すと自動解除
  // （`calcEEWCancelTime`。発生時刻から数えて消す）が**受け取った瞬間に走って画面から消える**。
  //
  // **合わせるのは発表時刻。** 実電文では発表時刻がいちばん遅いので、ここを「いま」にすれば
  // 発生時刻・発現時刻は過去に収まる。発生時刻を「いま」にすると**発表時刻が未来**になり、
  // 実配信には無い形の報になる（台本の寄せ方も同じ考え方。→ `utils/testTelegrams.ts` の `anchor`）。
  const deltaMs = Date.now() - Date.parse(base.time)
  const shift = (iso: string): string => {
    const ms = Date.parse(iso)
    return Number.isFinite(ms) ? new Date(ms + deltaMs).toISOString() : iso
  }
  // **発表時刻は「いま」。報番号ぶん進めない。** 進めると未来の発表時刻になり、アプリが
  // 受け取らない（実配信に無い形なので弾く）。報どうしの前後は、テスト側が偽の時計を
  // 進めてから次の報を作ることで付く（元のテストデータも `serverDate()` を呼び直していた）。
  const time = new Date().toISOString()
  return {
    ...base,
    id: `dmdata-eew-${eventId}-${serial}`,
    time,
    earthquake: {
      ...base.earthquake,
      originTime: shift(base.earthquake.originTime),
      arrivalTime: shift(base.earthquake.arrivalTime),
    },
    areas: base.areas?.map(a => ({ ...a, arrivalTime: a.arrivalTime === null ? null : shift(a.arrivalTime) })),
    issue: { ...base.issue, eventId, serial: String(serial), time },
    ...over,
  }
}

/**
 * {@link makeEewReport} の土台（`EEW_WARNING` の警報報）。
 *
 * **同期と非同期を分けてある。** `act()` の中や同期の関数定義からも報を作れるように、
 * 電文を読むのはここ（トップレベルで 1 回）、報を組むのは {@link makeEewReport}（同期）。
 */
export const eewWarningBase = async (): Promise<EEWAlert> =>
  first((await telegramEews('EEW_WARNING')).filter(e => e.severity === 'Warning'), '緊急地震速報（警報）')

/** 1 通だけ要るとき。**無ければ例外**（空の配列を黙って使うと、確かめたい形が出ないまま通る）。 */
export function first<T>(items: T[], label: string): T {
  const [item] = items
  if (!item) throw new Error(`テスト用の台本から ${label} を取れませんでした`)
  return item
}
