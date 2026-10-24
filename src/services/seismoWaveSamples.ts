// 過ぎた合成波形を、列に畳まずサンプルのまま取る（`GET /waves` を `columns` なしで呼ぶ）。
//
// **使うのは詳細の窓（`components/SeismoWaveDetail`。区切りごとに取れたかを返す {@link fetchSeismoWaveSamplesParts}）と、
// 下部の波形の穴埋め（`services/seismoWaveRefill.ts`）・再生中の下部の波形（`hooks/useSeismoReplay.ts`）。**
// 穴埋めは抱えている 180 秒の中の穴の範囲だけを取る（2 分を超える穴なら、下の分割で 2 回に分かれる）。
// 詳細の窓について —— カードの列（上下の端）では、
// 寄せたときにサンプルが時間順にどう動いたかが分からず、波の形を描けない
// （2026-10-05 のユーザー指摘「拡大したら波になってない」）。窓を開いたときに区間ぶんを
// まとめて取り、拡大・送りの最中には取りに行かない。
//
// **ホストは 1 回 2 分まで**（`seismo-host` の `WAVE_RAW_RANGE_MAX_MS`。10 分を素のまま返すと
// 数 MB になる）。それより長い区間は 2 分ずつ順に取る。
//
// **受け取る形はここに書く。** ホスト側の型を借りない理由は `seismoStream.ts` の冒頭と同じ。

import { log } from '../utils/logger'
import { arr, obj, str } from './parseHelpers'
import { isValidSeismoHostUrl } from './seismoStream'

/** ホストが 1 回で返す範囲の上限（ms）。**`seismo-host` の `WAVE_RAW_RANGE_MAX_MS` と同じ値。** */
export const SAMPLES_RANGE_MAX_MS = 2 * 60 * 1000

/** {@link fetchSeismoWaveSamples} が 1 回に扱う範囲の上限（ms）。**ホストの列の上限（10 分）以下。** 詳細の窓は {@link SAMPLES_DETAIL_SPAN_MAX_MS}。 */
export const SAMPLES_SPAN_MAX_MS = 10 * 60 * 1000

/** 取るときの打ち切り（ms）。1 回で 500 KB 前後になるので列より長めに取る。 */
const FETCH_TIMEOUT_MS = 20_000

/** サンプルのまとまり 1 つ。**欠けたサンプルは `NaN`**（ホストは `null` で返す）。 */
export interface WaveSampleChunk {
  readonly firstSampleMs: number
  readonly msPerSample: number
  readonly gal: readonly [Float32Array, Float32Array, Float32Array]
  /**
   * そのサンプルへ効いたセンサーの本数（`gal` と同じ長さ）。下部の波形の穴を埋めるとき
   * （`utils/seismoWaveBuffer.ts` の `fill`）に、押し出しで届いた値と同じく本数も置くために読む。
   */
  readonly memberCount: Float32Array
}

/** 取り込んだサンプルと、ホストが申告した読み込みの欠け。 */
export interface WaveSamples {
  readonly stationKnown: boolean
  readonly chunks: readonly WaveSampleChunk[]
  readonly filesFailed: number
  readonly skippedBytes: number
  readonly truncated: boolean
}

export type WaveSamplesResult =
  | { readonly kind: 'ok'; readonly samples: WaveSamples }
  | { readonly kind: 'bad-request'; readonly detail: string }
  | { readonly kind: 'unreachable'; readonly detail: string }
  | { readonly kind: 'http-error'; readonly status: number }
  | { readonly kind: 'unreadable'; readonly detail: string }
  /** 呼び出し側が取り消した（窓を閉じた）。**失敗ではないので記録へ残さない。** */
  | { readonly kind: 'aborted' }

/**
 * 成分 1 つぶんの配列を読む。**`null` は欠測として `NaN` に**、それ以外の数でない要素があれば
 * 読めないとする（詰めると時間の縮んだ絵になる。`seismoWaveHistory.ts` の `readWaveHistory` と同じ判断）。
 */
function readAxis(value: unknown): Float32Array | null {
  if (!Array.isArray(value)) return null
  const out = new Float32Array(value.length)
  for (let i = 0; i < value.length; i += 1) {
    const v: unknown = value[i]
    if (v === null) out[i] = Number.NaN
    else if (typeof v === 'number' && Number.isFinite(v)) out[i] = v
    else return null
  }
  return out
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 応答を読む。**読めないまとまりが 1 つでもあれば、その応答ごと捨てる。** */
export function readWaveSamples(parsed: unknown): { value: WaveSamples } | { detail: string } {
  const root = obj(parsed)
  if (str(root.stationId) === '') return { detail: 'stationId が無い' }
  if (!Array.isArray(root.chunks)) return { detail: 'chunks が配列ではない' }
  const chunks: WaveSampleChunk[] = []
  for (const raw of arr(root.chunks)) {
    const c = obj(raw)
    const firstSampleMs = c.firstSampleMs
    const msPerSample = c.msPerSample
    if (typeof firstSampleMs !== 'number' || !Number.isFinite(firstSampleMs)) return { detail: 'firstSampleMs を読めない' }
    if (typeof msPerSample !== 'number' || !(msPerSample > 0)) return { detail: 'msPerSample を読めない' }
    const gal = arr(c.gal)
    if (gal.length !== 3) return { detail: 'gal が 3 成分ではない' }
    const ew = readAxis(gal[0])
    const ns = readAxis(gal[1])
    const ud = readAxis(gal[2])
    if (ew === null || ns === null || ud === null) return { detail: 'gal を読めない' }
    if (ew.length !== ns.length || ew.length !== ud.length) return { detail: 'gal の成分の長さが揃っていない' }
    // **本数も値と同じ規則で読む**（`null` は 0、数でなければ応答ごと捨てる）。長さがずれたまま置くと、
    // 別のサンプルの本数を見せることになる。
    const members = readAxis(c.memberCount)
    if (members === null || members.length !== ew.length) return { detail: 'memberCount が gal と揃っていない' }
    for (let i = 0; i < members.length; i += 1) if (Number.isNaN(members[i])) members[i] = 0
    chunks.push({ firstSampleMs, msPerSample, gal: [ew, ns, ud], memberCount: members })
  }
  return {
    value: {
      stationKnown: root.stationKnown === true,
      chunks,
      filesFailed: finiteOr(root.filesFailed, 0),
      skippedBytes: finiteOr(root.skippedBytes, 0),
      truncated: root.truncated === true,
    },
  }
}

function apiBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

const fail = <T extends WaveSamplesResult>(result: T, why: string): T => {
  log.warn(`[seismo] 過ぎた波形をサンプルのまま読めず（${result.kind}）: ${why}`)
  return result
}

/** 2 分以内の範囲を 1 回で取る。 */
async function fetchOnce(params: {
  baseUrl: string
  stationId: string
  fromMs: number
  toMs: number
  signal?: AbortSignal
  fetchImpl: typeof fetch
}): Promise<WaveSamplesResult> {
  const { baseUrl, stationId, fromMs, toMs, signal, fetchImpl } = params
  const query = new URLSearchParams({ station: stationId, from: String(fromMs), to: String(toMs) })
  let res: Response
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    const onAbort = (): void => ctrl.abort()
    signal?.addEventListener('abort', onAbort)
    if (signal?.aborted === true) ctrl.abort()
    try {
      res = await fetchImpl(`${apiBase(baseUrl)}/waves?${query.toString()}`, { signal: ctrl.signal, cache: 'no-store' })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  } catch (error) {
    // 呼び出し側の取り消しと時間切れの見分け方は `seismoWaveHistory.ts` と同じ。
    if (signal?.aborted === true) return { kind: 'aborted' as const }
    const detail = describeError(error)
    return fail({ kind: 'unreachable' as const, detail }, detail)
  }
  if (!res.ok) return fail({ kind: 'http-error' as const, status: res.status }, `HTTP ${res.status}`)
  let parsed: unknown
  try {
    parsed = await res.json()
  } catch (error) {
    if (signal?.aborted === true) return { kind: 'aborted' as const }
    const detail = describeError(error)
    return fail({ kind: 'unreadable' as const, detail }, detail)
  }
  const read = readWaveSamples(parsed)
  if ('detail' in read) return fail({ kind: 'unreadable' as const, detail: read.detail }, read.detail)
  return { kind: 'ok', samples: read.value }
}

/**
 * 詳細の窓が 1 回に取る長さの上限（ms）。**地震カードの区間の最長（発生の 60 秒前〜発生 + 30 分の安全弁）を覆う 32 分。**
 * 区間を全部描くため（2026-10-22 選択「区間を全部描く (Recommended)」）。ホストへは 2 分ずつ順に訊くので、1 回の重さは変わらない。
 */
export const SAMPLES_DETAIL_SPAN_MAX_MS = 32 * 60 * 1000

/** {@link fetchSeismoWaveSamplesParts} の結果。 */
export type WaveSamplePartsResult =
  /**
   * 1 つ以上の区切りが取れた。**取れなかった区切りは `missing` に並ぶ**（時刻順）。描く側は、そこを「揺れていなかった」と
   * 読ませないよう別の描き方にする（`components/SeismoWaveDetail`）。
   */
  | { readonly kind: 'ok'; readonly samples: WaveSamples; readonly missing: readonly { readonly fromMs: number; readonly toMs: number }[] }
  /** 1 つも取れなかった（最後の失敗を返す）・範囲が不正・取り消された。 */
  | Exclude<WaveSamplesResult, { kind: 'ok' }>

/**
 * 区間のサンプルを 2 分ずつ取り、**取れた区切りだけを返す**（2026-10-22 選択「取れた区間だけ生で描き、残りは粗い絵」）。
 * {@link fetchSeismoWaveSamples} と違い、1 つの失敗で全部を捨てない。1 つも取れなければその失敗を返す。
 */
export async function fetchSeismoWaveSamplesParts(params: {
  baseUrl: string
  stationId: string
  fromMs: number
  toMs: number
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<WaveSamplePartsResult> {
  const { baseUrl, stationId, signal } = params
  const fetchImpl = params.fetchImpl ?? globalThis.fetch
  const fromMs = Math.floor(params.fromMs)
  const toMs = Math.ceil(params.toMs)
  if (!isValidSeismoHostUrl(baseUrl)) return fail({ kind: 'bad-request' as const, detail: 'URL の形が正しくない' }, 'URL の形が正しくない')
  if (stationId === '') return fail({ kind: 'bad-request' as const, detail: '観測点が空' }, '観測点が空')
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return fail({ kind: 'bad-request' as const, detail: '範囲が不正' }, '範囲が不正')
  }
  if (toMs - fromMs > SAMPLES_DETAIL_SPAN_MAX_MS) {
    return fail({ kind: 'bad-request' as const, detail: '範囲が上限を超える' }, '範囲が上限を超える')
  }
  const chunks: WaveSampleChunk[] = []
  const missing: { fromMs: number; toMs: number }[] = []
  let stationKnown = true
  let filesFailed = 0
  let skippedBytes = 0
  let truncated = false
  let lastFailure: Exclude<WaveSamplesResult, { kind: 'ok' }> | null = null
  let gotAny = false
  for (let from = fromMs; from < toMs; from += SAMPLES_RANGE_MAX_MS) {
    const to = Math.min(toMs, from + SAMPLES_RANGE_MAX_MS)
    const got = await fetchOnce({ baseUrl, stationId, fromMs: from, toMs: to, signal, fetchImpl })
    if (got.kind === 'aborted') return got
    if (got.kind !== 'ok') {
      lastFailure = got
      // 続けて欠けた区切りは 1 つへまとめる（境目の線を区切りごとに引かない）。
      const prev = missing[missing.length - 1]
      if (prev !== undefined && prev.toMs === from) prev.toMs = to
      else missing.push({ fromMs: from, toMs: to })
      continue
    }
    gotAny = true
    stationKnown &&= got.samples.stationKnown
    filesFailed += got.samples.filesFailed
    skippedBytes += got.samples.skippedBytes
    truncated ||= got.samples.truncated
    chunks.push(...got.samples.chunks)
  }
  if (!gotAny && lastFailure !== null) return lastFailure
  if (missing.length > 0) {
    log.warn(
      `[seismo] 過ぎた波形のサンプルを一部取れなかった（${stationId}）: ` +
        missing.map((m) => `${new Date(m.fromMs).toISOString()}〜${new Date(m.toMs).toISOString()}`).join('・'),
    )
  }
  if (filesFailed > 0 || skippedBytes > 0 || truncated) {
    log.warn(
      `[seismo] 過ぎた波形のサンプルに読み込みの欠け（${stationId}）: 読めなかったファイル ${filesFailed}・読み飛ばし ${skippedBytes} バイト${truncated ? '・打ち切りあり' : ''}`,
    )
  }
  if (!stationKnown) log.warn(`[seismo] 過ぎた波形のサンプル: ホストがこの観測点を知らない（${stationId}）`)
  return { kind: 'ok', samples: { stationKnown, chunks, filesFailed, skippedBytes, truncated }, missing }
}

/**
 * 区間のサンプルを取る。**2 分を超える区間は 2 分ずつ順に取り、1 つでも失敗したらその失敗を返す**
 * （一部だけ描くと、取れなかった区間が「揺れていなかった」ように見える）。
 *
 * **ホストが申告した読み込みの欠けは記録へ残す**（値は描けるので、画面からは分からない）。
 */
export async function fetchSeismoWaveSamples(params: {
  baseUrl: string
  stationId: string
  fromMs: number
  toMs: number
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<WaveSamplesResult> {
  const { baseUrl, stationId, signal } = params
  const fetchImpl = params.fetchImpl ?? globalThis.fetch
  const fromMs = Math.floor(params.fromMs)
  const toMs = Math.ceil(params.toMs)
  if (!isValidSeismoHostUrl(baseUrl)) return fail({ kind: 'bad-request' as const, detail: 'URL の形が正しくない' }, 'URL の形が正しくない')
  if (stationId === '') return fail({ kind: 'bad-request' as const, detail: '観測点が空' }, '観測点が空')
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return fail({ kind: 'bad-request' as const, detail: '範囲が不正' }, '範囲が不正')
  }
  if (toMs - fromMs > SAMPLES_SPAN_MAX_MS) {
    return fail({ kind: 'bad-request' as const, detail: '範囲が上限を超える' }, '範囲が上限を超える')
  }

  const chunks: WaveSampleChunk[] = []
  let stationKnown = true
  let filesFailed = 0
  let skippedBytes = 0
  let truncated = false
  for (let from = fromMs; from < toMs; from += SAMPLES_RANGE_MAX_MS) {
    const to = Math.min(toMs, from + SAMPLES_RANGE_MAX_MS)
    const got = await fetchOnce({ baseUrl, stationId, fromMs: from, toMs: to, signal, fetchImpl })
    if (got.kind !== 'ok') return got
    stationKnown &&= got.samples.stationKnown
    filesFailed += got.samples.filesFailed
    skippedBytes += got.samples.skippedBytes
    truncated ||= got.samples.truncated
    chunks.push(...got.samples.chunks)
  }
  if (filesFailed > 0 || skippedBytes > 0 || truncated) {
    log.warn(
      `[seismo] 過ぎた波形のサンプルに読み込みの欠け（${stationId}）: 読めなかったファイル ${filesFailed}・読み飛ばし ${skippedBytes} バイト${truncated ? '・打ち切りあり' : ''}`,
    )
  }
  if (!stationKnown) log.warn(`[seismo] 過ぎた波形のサンプル: ホストがこの観測点を知らない（${stationId}）`)
  return { kind: 'ok', samples: { stationKnown, chunks, filesFailed, skippedBytes, truncated } }
}
