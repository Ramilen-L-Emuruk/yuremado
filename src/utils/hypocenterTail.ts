// 長期震源カタログの終端より後（震源リストに載る前の約 2 日）を、中継の地震情報の電文から作る
// （カタログタブ。2026-11-06 ユーザー選択「カタログタブにも足す (Recommended)」）。
//
// 電文の地震を年ファイルと同じ形（`HypocenterYear`）へ組み直して、年の並びの後ろへ足す。そうすれば絞り込み・
// 件数・点群の組み立て（`hypocenterCatalogView.ts`）を同じ経路で通れる。
//
// **数値の列に入らない電文の値は、点ごとの語（`TelegramPointLabels`）として持つ。** 地震情報の発生時刻は分まで、
// 規模は「M8を超える巨大地震」のような説明で届くことがあり、深さは「700km以上」、最大震度は「5弱以上（未入電）」が
// ある。数値の列だけにすると、これらが画面から消えるか別の値に化ける（アプリの基本理念。CLAUDE.md）。

import type { JMAQuake } from '../types/earthquake'
import type { HypocenterYear, TelegramPointLabels } from './hypocenterCatalog'
import { formatDepth, formatHypocenterSource, formatMagnitudeWithCondition, hasDepth, hasMagnitude } from './formatters'
import { getIntensityLabelWithOrAbove, isValidIntensityScale } from './intensity'
import { isMaxScaleUnreceived } from './quakePoints'
import { hasValidHypocenter } from './quakeHeatmap'
import { log } from './logger'

const JST_OFFSET_MS = 9 * 3600 * 1000

/** 日本時間の `2026/11/05 12:34`（電文の発生時刻は分まで） */
function formatMinuteJst(ms: number): string {
  const d = new Date(ms + JST_OFFSET_MS)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

/**
 * 地震情報の電文の地震から、カタログの末尾の年を作る。
 *
 * 入れるのは発生時刻が `[fromMs, untilMs)` に入り、震央の座標を持つ地震だけ（震源の決まっていない報は点に置けない）。
 * 時刻順に並べる（年ファイルと同じく、点群の組み立ては並び順を問わないが、吹き出しの添字は列とそろえる）。
 *
 * @param fromMs カタログの終端（排他。この時刻から後を末尾にする）
 * @param untilMs 末尾を取った範囲の終わり（排他）
 */
export function tailYearFromQuakes(quakes: readonly JMAQuake[], fromMs: number, untilMs: number): HypocenterYear {
  const parsed = quakes.map((q) => ({ q, timeMs: Date.parse(q.earthquake.time) }))
  // 発生時刻を読めない報は点に置けない。読み取りが壊れたときに件数が減るだけにならないよう、数えて残す
  const unreadable = parsed.filter(({ timeMs }) => !Number.isFinite(timeMs))
  if (unreadable.length > 0) {
    log.warn(`[hypocenterTail] 発生時刻を読めない地震情報が ${unreadable.length} 件あり、震源カタログの末尾に入れませんでした（最初の id=${unreadable[0].q.id}）`)
  }
  const picked = parsed
    .filter(({ q, timeMs }) =>
      Number.isFinite(timeMs) && timeMs >= fromMs && timeMs < untilMs
      && hasValidHypocenter(q.earthquake.hypocenter.latitude, q.earthquake.hypocenter.longitude))
    .sort((a, b) => a.timeMs - b.timeMs)
  const n = picked.length
  const timeMs = new Float64Array(n)
  const lat = new Float64Array(n)
  const lng = new Float64Array(n)
  const depth = new Float32Array(n)
  const magnitude = new Float32Array(n)
  const external = new Uint8Array(n)
  const nameIdx = new Int32Array(n)
  const names: string[] = []
  const nameIndex = new Map<string, number>()
  const labels: TelegramPointLabels[] = []
  picked.forEach(({ q, timeMs: t }, i) => {
    const h = q.earthquake.hypocenter
    timeMs[i] = t
    lat[i] = h.latitude
    lng[i] = h.longitude
    // 列は数で絞り込み・色分けに使う。「700km以上」は 700 として置き、語の側で「以上」を残す
    depth[i] = hasDepth(h.depth) ? h.depth : NaN
    magnitude[i] = hasMagnitude(h.magnitude) ? h.magnitude : NaN
    external[i] = h.source ? 1 : 0
    if (h.name) {
      let k = nameIndex.get(h.name)
      if (k === undefined) {
        k = names.length
        names.push(h.name)
        nameIndex.set(h.name, k)
      }
      nameIdx[i] = k
    } else {
      nameIdx[i] = -1
    }
    const scale = q.earthquake.maxScale
    labels.push({
      time: formatMinuteJst(t),
      intensity: isValidIntensityScale(scale) && scale > 0
        ? `最大震度 ${getIntensityLabelWithOrAbove(scale, isMaxScaleUnreceived(scale, q.points))}`
        : null,
      // 数値が無く説明も無いときだけ、カタログの点と同じ「M 不明」（吹き出しは M と深さを 1 行に並べるので「不明」だけにしない）
      magnitude: hasMagnitude(h.magnitude) || h.magnitudeCondition
        ? formatMagnitudeWithCondition(h.magnitude, h.magnitudeCondition, h.magnitudeType)
        : 'M 不明',
      depth: hasDepth(h.depth) ? `深さ ${formatDepth(h.depth, h.depthAtLeast ?? false)}` : '深さ不明',
      source: h.source ? formatHypocenterSource(h.source) : null,
    })
  })
  return {
    year: new Date(fromMs + JST_OFFSET_MS).getUTCFullYear(),
    source: 'telegram',
    telegramLabels: labels,
    count: n,
    coveredThroughMs: untilMs,
    // 震源リストの速報値とは別の値（電文の震源）。吹き出しは `source` で言い分けるので、ここは速報値の側に置く
    quality: 'preliminary',
    timeMs,
    lat,
    lng,
    depth,
    names,
    nameIdx,
    external,
    // 最大震度は語（`telegramLabels`）の側で出す。カタログの震度の符号には「以上」を表す形が無い
    intensityCode: new Map(),
    magnitude,
  }
}
