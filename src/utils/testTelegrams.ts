// テストボタンが流す電文を、リポジトリに置いた電文 XML（`public/data/test-telegrams/`）から組む。
//
// ## なぜ XML から組むのか
//
// テストボタンは**本物の電文を再現するもの**で、実機で挙動を確かめる入口になっている
// （→ CLAUDE.md「テストボタンは実機確認の唯一の入口」）。内部型を手で組み立てる形では、
//
// - パーサーを一度も通らないので、電文を正しく読めているかの証拠にならない
// - 何の電文を元にしたのかが、コメントにしか残らない
//
// ここでは XML を**ライブ・リプレイと同じ入口**（`buildXmlPayload`）へ通し、実地震テストシナリオと
// 同じ時刻の寄せ方（`instantiateScenario`）で「いま」へ寄せてから、受信と同じイベントキューへ積む。
// 待ちをキューに持たせるので、リセット（リプレイの開始・停止）とアンマウントで一緒に落ちる。
//
// 置く XML は 2 種類（→ `public/data/test-telegrams/README.md`）。
//
// - `nii/` … 国立情報学研究所「気象庁防災情報XMLデータベース」の実電文そのもの（CC BY 4.0）
// - `synthetic/` … 実電文の標本が無い形を、気象庁の書式で書いたもの
//
// 実電文の一部だけを変えて流す場合（訓練報の印・訂正報など）は、**変える箇所を `rewrite` に書く**。
// 元の XML を丸ごと写した合成ファイルを作るより、何を変えたかが一目で分かる。
import type { ReplayEntry, ReplayPayload } from '../types/replay'
import type { TestScenarioFile } from '../types/testScenario'
import { buildXmlPayload, buildBinaryPayload, isBinaryTelegramType, EEW_HEAD_TYPES, type EewHeadType } from '../services/dmdataTelegramPayload'
import { instantiateScenario } from './testScenarioReplay'
import { fetchWithTimeout } from './fetchWithTimeout'
import { DATA_FETCH_TIMEOUT_MS } from './fetchJson'

/** 台本の 1 通。 */
export interface TestTelegramStep {
  /** `public/data/test-telegrams/` からの相対パス。 */
  file: string
  /** 電文種別（`Head` ではなく配信の種別。`VXSE53` など）。パーサーの振り分けに使う。 */
  headType: string
  /** 押してから流すまで（ミリ秒）。 */
  atMs: number
  /**
   * 片方の版でだけ流す。
   *
   * - `'dmdss'` … **DMDATA 経路でしか届かない電文**（長周期地震動の観測情報など）
   * - `'standard'` … 標準版でだけ要る報。予報だけの津波は DMDSS 版では失効時刻で消える（解除の報は
   *   出ない）が、標準版は失効の予約を持たないので、テストの後片付けに解除の報を流す
   *
   * 標準版の受信元（P2PQuake）は廃止する予定で（2026-10-22 ユーザー原文「XMLにしましょう。近いうちに
   * 2つは統合するので。」「統合すると言うかP2PQuakeは廃止する」）、両版とも同じ XML の読み取り結果を
   * 流す。ここで分けるのは、統合までのあいだ**電文そのものの届き方・消え方が違う**ところだけ。
   */
  onlyIn?: 'dmdss' | 'standard'
  /**
   * 実電文の一部を書き換えて流すとき、その書き換え。**変える箇所だけを書く**こと。
   * 書き換えが効かなかった（置き換える文字列が見つからなかった）ら例外にする —— 黙って
   * 元のまま流すと、確かめたい形が一度も出ないまま気づけない（→ `replaceOnce`）。
   */
  /**
   * 電文の書き換え。**「いま」を受け取れる** —— 本文に日時を書く形（「非常に強い揺れを検知」の報）は、
   * 電文の時刻をずらしても本文は追随しないので、組むときの時刻から作る必要がある。
   */
  rewrite?: (xml: string, ctx: { now: Date }) => string
}

/** テストボタン 1 つぶんの台本。 */
export interface TestTelegramScript {
  steps: readonly TestTelegramStep[]
  /**
   * **押すたびに次の 1 通だけを流す。** 緊急地震速報のテストで使う（2026-10-22 ユーザー選択
   * 「押すたびに 1 通のまま」）。
   *
   * 続報は実配信では 1〜2 秒ごとに自動で届くが、テストボタンは**押した人が段を進める**作りに
   * してある —— 任意の段で止めて画面を見られる。`atMs` は使わず、押すたびに `steps` の先頭から
   * 1 通ずつ進む（`silenceMs` 黙ると、残りを飛ばして最終報を流す）。
   */
  stepByPress?: {
    /**
     * 何も押されないまま、この時間が過ぎたら `steps` の末尾（取消を持つ台本では `cancelIndex`）を流す。
     * **押して進められるのは、その 1 つ手前まで。**
     */
    silenceMs: number
    /** 黙ったときに、末尾の代わりに流す取消（`steps` の添字）。持たない台本では省く。 */
    cancelIndex?: number
  }
  /**
   * どの電文の時刻を「いま」に合わせるか（`steps` の添字）。
   *
   * 電文どうしの時刻の差は実電文のまま保つ（1 つの差分だけずらす）。地震情報は**最後の報**に
   * 合わせて、どの報も「いま」より前の時刻にする —— 未来の発表時刻を持つ報は実配信に無い。
   * 緊急地震速報のように到達までの秒読みがあるものは**最初の報**に合わせる。
   */
  anchor: number
}

/** 置き場所。`import.meta.env.BASE_URL` の後ろへ繋ぐ。 */
export const TEST_TELEGRAM_DIR = 'data/test-telegrams'

/** XML の取得。テストでは差し替える。 */
export type TestTelegramFetcher = (file: string) => Promise<string>

const defaultFetcher: TestTelegramFetcher = (file) =>
  fetchWithTimeout(
    `${import.meta.env.BASE_URL}${TEST_TELEGRAM_DIR}/${file}`,
    { timeoutMs: DATA_FETCH_TIMEOUT_MS, signal: null },
    async (res) => {
      if (!res.ok) throw new Error(`テスト用の電文を取得できませんでした（HTTP ${res.status}）: ${file}`)
      return res.text()
    },
  )

/** 二進の電文（推計震度分布図）の取得。テストでは差し替える。 */
export type TestTelegramBinaryFetcher = (file: string) => Promise<Uint8Array>

const defaultBinaryFetcher: TestTelegramBinaryFetcher = (file) =>
  fetchWithTimeout(
    `${import.meta.env.BASE_URL}${TEST_TELEGRAM_DIR}/${file}`,
    { timeoutMs: DATA_FETCH_TIMEOUT_MS, signal: null },
    async (res) => {
      if (!res.ok) throw new Error(`テスト用の電文を取得できませんでした（HTTP ${res.status}）: ${file}`)
      return new Uint8Array(await res.arrayBuffer())
    },
  )

const xmlCache = new Map<string, Promise<string>>()
const binaryCache = new Map<string, Promise<Uint8Array>>()

/** 二進の電文を読む（控えの扱いは {@link loadTestTelegramXml} と同じ）。 */
export function loadTestTelegramBytes(file: string, fetcher: TestTelegramBinaryFetcher = defaultBinaryFetcher): Promise<Uint8Array> {
  let pending = binaryCache.get(file)
  if (!pending) {
    pending = fetcher(file).catch((err: unknown) => {
      binaryCache.delete(file)
      throw err
    })
    binaryCache.set(file, pending)
  }
  return pending
}

/**
 * 電文 XML を読む（2 回目以降は読み込み済みのものを返す）。
 *
 * **失敗したら覚えない**（→ `testDataLoader.ts` の `loadTestData` と同じ理由。一度失敗した
 * Promise を握ったままにすると、ページを開き直すまでそのボタンが無反応になる）。
 */
export function loadTestTelegramXml(file: string, fetcher: TestTelegramFetcher = defaultFetcher): Promise<string> {
  let pending = xmlCache.get(file)
  if (!pending) {
    pending = fetcher(file).catch((err: unknown) => {
      xmlCache.delete(file)
      throw err
    })
    xmlCache.set(file, pending)
  }
  return pending
}

/** テスト用。読み込みの控えを捨てる。 */
export function clearTestTelegramCacheForTest(): void {
  xmlCache.clear()
  binaryCache.clear()
}

/**
 * 1 箇所だけ書き換える。**見つからなければ例外**にする（`rewrite` の説明）。
 * 2 箇所以上あるときも例外にする —— どちらを変えたつもりかが曖昧になる。
 */
export function replaceOnce(xml: string, from: string | RegExp, to: string): string {
  const pattern = typeof from === 'string' ? from : new RegExp(from.source, from.flags.replace('g', ''))
  const count = typeof from === 'string'
    ? xml.split(from).length - 1
    : (xml.match(new RegExp(from.source, from.flags.includes('g') ? from.flags : `${from.flags}g`)) ?? []).length
  if (count !== 1) {
    throw new Error(`テスト用の電文の書き換え先が ${count} 箇所ありました（1 箇所であるべき）: ${String(from)}`)
  }
  return xml.replace(pattern, to)
}

/** 電文が名乗る時刻。台本の基準（`anchor`）に使う。 */
function payloadTime(payload: ReplayPayload): string {
  return payload.kind === 'event' ? payload.event.time : payload.data.time
}

/**
 * 二進電文（BUFR）の発表時刻を、**台本の時間軸へ乗せ直す**。
 *
 * 二進電文は発表時刻を本文に持たないので、読むときに外から渡している。そこで実時刻を入れると、
 * このあとの寄せ（`instantiateScenario` が全ペイロードへ一律に足す差分）が**二重に効いて**
 * 何年も先の報になる（能登本震を基準にした台本で実測 2029 年）。基準の時刻からの差で置けば、
 * 寄せた後にちょうど「いま ＋ `atMs`」になる。
 */
function alignBinaryTime(payload: ReplayPayload, baseTime: string, atMs: number): ReplayPayload {
  if (payload.kind !== 'estimatedIntensity') return payload
  const base = Date.parse(baseTime)
  if (!Number.isFinite(base)) throw new Error(`テスト用の台本の基準の時刻を読めませんでした: ${baseTime}`)
  return { ...payload, data: { ...payload.data, time: new Date(base + atMs).toISOString() } }
}

/** 組んだ 1 通。電文ログへ本文を残すために XML も返す。 */
export interface BuiltTestTelegram {
  step: TestTelegramStep
  xml: string
  entry: ReplayEntry
}

export interface BuildTestTelegramOptions {
  /** DMDSS 版か。`onlyIn` の電文を選り分けるのに使う。 */
  isDmdss: boolean
  /** 「いま」。`serverDate()` を渡す。 */
  now: Date
  /** 緊急地震速報として読む種別。テストボタンは予報（VXSE45）を受けている形で流す。 */
  eewHeadType?: EewHeadType
  fetcher?: TestTelegramFetcher
  binaryFetcher?: TestTelegramBinaryFetcher
  /**
   * 組む範囲を `steps` の先頭から数通に絞る（押すたびに進む台本で使う）。
   *
   * **絞っても基準（`anchor`）は台本のまま**なので、何通目まで流しても時刻の寄せ方は変わらない。
   */
  limit?: number
}

/**
 * 台本の電文を読み、パーサーへ通し、「いま」へ寄せて、キューへ積める形にする。
 *
 * **1 通でも読めなければ全体を失敗にする。** 一部だけ流すと、続報が前の報を欠いたまま届き、
 * 確かめたい形にならない（しかも画面からは欠けたことが分からない）。
 */
export async function buildTestTelegramEntries(
  script: TestTelegramScript,
  options: BuildTestTelegramOptions,
): Promise<BuiltTestTelegram[]> {
  const { isDmdss, now, eewHeadType = 'VXSE45', fetcher = defaultFetcher, binaryFetcher = defaultBinaryFetcher } = options
  const anchorStep = script.steps[script.anchor]
  if (!anchorStep) throw new Error(`テスト用の台本の基準（${script.anchor} 通目）がありません`)
  // **絞り込みは読む前に。** 後ろでやると、流さない段の取得や書き換えが失敗しただけで
  // 全体が失敗する（しかもそのバリアントでは一度も使わない電文のために取りに行く）。
  const steps = script.steps.filter(step => step.onlyIn === undefined || step.onlyIn === (isDmdss ? 'dmdss' : 'standard'))
  // **押すたびに進む台本では、バリアントで段を分けられない。** 押下の回数を段の添字に使うので
  // （→ `useEarthquakes.ts` の `pressTestTelegramScript`）、片方の版で段が落ちると黙ってずれる。
  if (script.stepByPress && steps.length !== script.steps.length) {
    throw new Error('押すたびに進む台本では、バリアントで段を分けられません')
  }
  const anchorIndex = steps.indexOf(anchorStep)
  if (anchorIndex < 0) throw new Error(`テスト用の台本の基準（${script.anchor} 通目）が、このバリアントでは流れません`)

  const loaded = await Promise.all(steps.map(async (step) => {
    if (isBinaryTelegramType(step.headType)) {
      // 二進電文（推計震度分布図）。**書き換えは持たせない** —— ビット列なので文字列の置換が
      // 効かず、形を変えるなら組み直す側（`scripts/build-test-estimated-intensity-bufr.ts`）を直す。
      if (step.rewrite) throw new Error(`二進の電文は書き換えられません: ${step.file}`)
      const bytes = await loadTestTelegramBytes(step.file, binaryFetcher)
      // **発表時刻は段ごとに違えること。** 二進電文（BUFR）は発表時刻を本文に持たないので、
      // 読むときに外から渡す。同じ時刻を渡すと、続報が「同じ発表時刻の再送」になって
      // 反映されない（判定は発表時刻しか見ない。→ `utils/estimatedIntensity.ts`）。
      const issuedAt = new Date(now.getTime() + step.atMs).toISOString()
      const payload = buildBinaryPayload(step.headType, bytes, `test-${step.file}`, issuedAt)
      if (!payload) throw new Error(`テスト用の電文を読めませんでした: ${step.file}（${step.headType}）`)
      return { step, xml: '', payload }
    }
    const raw = await loadTestTelegramXml(step.file, fetcher)
    const xml = step.rewrite ? step.rewrite(raw, { now }) : raw
    const payload = buildXmlPayload(step.headType, xml, EEW_HEAD_TYPES.has(step.headType) ? eewHeadType : null)
    if (!payload) throw new Error(`テスト用の電文を読めませんでした: ${step.file}（${step.headType}）`)
    return { step, xml, payload }
  }))

  const anchor = loaded[anchorIndex]
  const scenario: TestScenarioFile = {
    id: 'test-telegram',
    label: '',
    description: '',
    category: 'quake',
    durationMs: Math.max(0, ...steps.map(s => s.atMs)),
    baseTime: payloadTime(anchor.payload),
    entries: [],
  }
  const kept = loaded.slice(0, options.limit)
  scenario.entries = kept.map(({ step, payload }) => ({ offsetMs: step.atMs, payload: alignBinaryTime(payload, scenario.baseTime, step.atMs) }))
  const entries = instantiateScenario(scenario, now)
  return kept.map(({ step, xml }, i) => ({ step, xml, entry: entries[i] }))
}
