// 地図へ重ねる凡例の中身を決める（描画は index.tsx・画像への焼き込みは utils/shareCard.ts）。
//
// **「いま地図が実際に描いているもの」だけを並べる。地図モードから推し量らない。**
// 津波の海岸線はモードに関わらず描かれ（`JapanMapGL` の `TsunamiLinesGL` は `tsunamiLines.length > 0`
// だけを見る）、活断層は津波モードでは描かれない（`showOverlayLines`。プレート境界は津波モードでも
// 描く —— `showPlateLines`）。モードで
// 決め打つと、地図に無い色が凡例へ並ぶ。判定に使う値は `JapanMapGL` が各レイヤーの `visible` と
// 同じ式から組んで渡す（`MapLegendSources`）。
//
// **色は描いている側と同じ定数・同じ関数から採る。** ここへ色を書き写すと、配色を変えたときに
// 凡例だけが古くなる。
//
// **同じ色スケールを複数の描画物が使うときは 1 ブロックにまとめ、見出しに用途を並べる。**
// リアルタイム震度・揺れの検知点・緊急地震速報の予想区域はどれも気象庁の震度配色で塗られる
// （`kyoshinIntensityColor` / `kyoshinDetectedIcons` / `EewRegionFillGL` がいずれも
// `getIntensityColor` を通る）。別ブロックにすると同じ色列が画面に 2 度並ぶ。

import { INTENSITY_COLORS, INTENSITY_LABELS } from '../../utils/intensity'
import { SHINDO0_COLOR } from '../../utils/measuredIntensity'
import { getLpgmClassColor, getLpgmClassLabel } from '../../utils/lpgm'
import { TSUNAMI_STYLE, TSUNAMI_MISSING_COLOR } from '../../utils/tsunamiStyle'
import { TSUNAMI_OBS_HEIGHT_STEPS } from '../Map/gl/tsunamiObsBarStyle'
import { UNRECEIVED_COLOR } from '../Map/gl/intensityIcons'
import { ARRIVAL_COLOR } from '../Map/gl/tsunamiArrivalMarker'
import { S_WAVE_COLOR, P_WAVE_COLOR } from '../Map/gl/psWaveStyle'
import { HEATMAP_DENSITY_STOPS } from '../Map/gl/heatmapRamp'
import type { HeatmapPeriod } from '../../utils/quakeHeatmap'
import {
  FAULT_COLOR,
  SUBDUCTION_COLOR,
  PLATE_CONVERGENT_COLOR,
  PLATE_DIVERGENT_COLOR,
  PLATE_TRANSFORM_COLOR,
} from '../Map/gl/overlayLineStyle'
import {
  DEPTH_RAMP,
  MAGNITUDE_RAMP,
  TIME_RAMP,
  MAGNITUDE_RAMP_RANGE,
  UNKNOWN_MAGNITUDE_HEX,
  depthRampT,
  jstYearOf,
  type CatalogColorBy,
  type Ramp,
} from '../../utils/hypocenterCatalogView'

/** 凡例の 1 ブロックを表す鍵。並び順とテストの参照に使う。 */
export type LegendKey =
  | 'intensity'
  | 'unreceived'
  | 'lpgm'
  | 'psWave'
  | 'tsunamiGrade'
  | 'tsunamiObsHeight'
  | 'tsunamiStation'
  | 'catalog'
  | 'heatmap'
  | 'lines'

/** 色の升目（震度階級のように段が決まっているもの）。 */
export interface LegendCell {
  label: string
  color: string
}

/**
 * 色の見本と名前の組（線・点のように段になっていないもの）。
 *
 * 形は地図の描き方に合わせる（`line`＝海岸線・予報円・活断層／`dot`＝観測点の丸印／
 * `bar`＝潮位観測点に立てる観測棒）。同じ色を別の意味で使っている組があるため、形が見分けを担う。
 */
export interface LegendChip {
  label: string
  color: string
  shape: 'line' | 'dot' | 'bar' | 'ring'
}

/** 連続した色帯の折れ点。`at` は 0〜1。 */
export interface LegendStop {
  at: number
  color: string
}

/** 色帯に添える目盛り。`at` は 0〜1。 */
export interface LegendTick {
  at: number
  label: string
}

export type LegendSwatch =
  | { kind: 'scale'; cells: LegendCell[] }
  | { kind: 'chips'; chips: LegendChip[] }
  | {
      kind: 'ramp'
      stops: LegendStop[]
      ticks: LegendTick[]
      /**
       * 色帯の下に添える見本。色帯のどこにも無い色で描いたものを説明する
       * （震源カタログの「M 不明」）。無ければ省く。
       */
      chips?: LegendChip[]
    }

/**
 * ヒートマップ欄に添える期間（スライダーと「期間 ○ 〜 いま」の行）。地図の描き方ではなく利用者の
 * 選択なので、`MapLegendSources` ではなく `withHeatmapPeriod` で後から載せる。
 */
export interface LegendHeatmapPeriod {
  period: HeatmapPeriod
  /** 期間の始まり（`2026/09/25`）。 */
  startLabel: string
  /** 再生中か（終わりを「いま」ではなく「再生時刻」と書く）。 */
  replay: boolean
  /** 観測網の疎な時代に掛かるときの注記。掛からなければ `null`。 */
  note: string | null
}

/**
 * 期間の行の文（「期間 2026/09/25 〜 いま」）。**画面の凡例と共有カードの画像が同じ文を出すよう、ここで組む。**
 */
export function heatmapPeriodText(period: LegendHeatmapPeriod): string {
  return `期間 ${period.startLabel} 〜 ${period.replay ? '再生時刻' : 'いま'}`
}

export interface LegendBlock {
  key: LegendKey
  /** 展開時の見出し。 */
  title: string
  /** 畳んだときに色見本へ添える短い名前。 */
  shortTitle: string
  swatch: LegendSwatch
  /** ヒートマップ欄だけが持つ。 */
  heatmapPeriod?: LegendHeatmapPeriod
}

/**
 * いま地図が描いているもの。`JapanMapGL` が各レイヤーの `visible` と同じ式から組む。
 *
 * **真偽値を並べた素の形にしてある。** 地図の内部の型（観測点の配列など）を渡すと、凡例の判定が
 * 描画の都合に引きずられる。ここへ来るのは「出ているかどうか」だけでよい。
 */
export interface MapLegendSources {
  /** 震度色で描くもの（区域塗り・観測点バッジ・震度の面・推計震度分布図）。 */
  quakeIntensity: boolean
  /** リアルタイム震度（観測点の丸・揺れの検知点）。どちらも同じ配色で、出る条件も同じ。 */
  realtimeIntensity: boolean
  /** 緊急地震速報の予想震度（区域塗り）。 */
  eewIntensity: boolean
  /** 震度を入手していない地点の印。 */
  unreceived: boolean
  /** 長周期地震動階級（観測）。 */
  lpgm: boolean
  /** 緊急地震速報の予想長周期地震動階級（区域塗り）。 */
  eewLpgm: boolean
  /** 予報円。 */
  psWave: boolean
  /** 津波の等級（海岸線）。 */
  tsunamiGrade: boolean
  /** 観測した津波の高さ（潮位観測点に立てる観測棒）。 */
  tsunamiObsHeight: boolean
  /** 到達を確認した潮位観測点の印。 */
  tsunamiArrival: boolean
  /** 欠測の潮位観測点の印。 */
  tsunamiMissing: boolean
  /** 地震活動の密度（ヒートマップ）。 */
  heatmap: boolean
  /** 活断層線。 */
  activeFaults: boolean
  /** プレート境界線。 */
  plateBoundaries: boolean
  /**
   * いま見ている画面の主役（先に読ませたい鍵を並べる）。
   *
   * **中身を絞るためではなく、並べる順を決めるためのもの。** 何を出すかは上の真偽値だけで決まり、
   * ここに無いものも消えない。震源カタログを眺めている最中に津波が発表されていれば、津波の
   * 等級も凡例に残る——ただし先頭に来るのは深さの帯で、畳めばそれが代表になる
   * （その画面で見ているものと、凡例が残すものを揃える）。
   */
  primary: LegendKey[]
  /** 震源カタログの点群を描いているときの色分け。描いていなければ `null`。 */
  catalogColorBy: CatalogColorBy | null
  /**
   * 発生年で色を付けているときの両端（UTC epoch ミリ秒）。
   *
   * **期間の指定ではなく、色を付けるのに実際に使った幅を渡すこと**（`CatalogPointCloud.timeRange`）。
   * 絞り込みで端まで点が残っていないことがあり、指定から目盛りを組むと色と食い違う。
   */
  catalogYearRange: { lo: number; hi: number } | null
  /**
   * 描いている点群に、M が決まっていない地震が 1 件でも入っているか（`CatalogPointCloud.unknownMagnitudeCount`）。
   * マグニチュードで色を付けているときだけ、色帯の下に「M 不明」の見本を添える。
   */
  catalogUnknownMagnitude: boolean
  /**
   * 描いている点群に、深さが決まっていない地震が 1 件でも入っているか（`CatalogPointCloud.unknownDepthCount`）。
   * 深さで色を付けているときだけ、色帯の下に「深さ不明」の見本を添える（灰色で塗るのはそのときだけ）。
   */
  catalogUnknownDepth: boolean
  /**
   * 描いている点群に、気象庁以外の機関が決めた震源が 1 件でも入っているか（`CatalogPointCloud.externalCount`）。
   * 色分けによらず、輪の見本を添える（形で見分けるので、どの色分けでも輪で描く）。
   */
  catalogExternal: boolean
}

/** 何も描いていない状態。テストと、地図がまだ出来ていないときの既定値に使う。 */
export const EMPTY_LEGEND_SOURCES: MapLegendSources = {
  quakeIntensity: false,
  realtimeIntensity: false,
  eewIntensity: false,
  unreceived: false,
  lpgm: false,
  eewLpgm: false,
  psWave: false,
  tsunamiGrade: false,
  tsunamiObsHeight: false,
  tsunamiArrival: false,
  tsunamiMissing: false,
  heatmap: false,
  activeFaults: false,
  plateBoundaries: false,
  primary: [],
  catalogColorBy: null,
  catalogYearRange: null,
  catalogUnknownMagnitude: false,
  catalogUnknownDepth: false,
  catalogExternal: false,
}

/** 気象庁の震度階級（不明を除く）を階級値の昇順で。 */
function intensityCells(): LegendCell[] {
  return Object.keys(INTENSITY_LABELS)
    .map(Number)
    .filter((scale) => scale >= 0)
    .sort((a, b) => a - b)
    .map((scale) => ({ label: INTENSITY_LABELS[scale], color: INTENSITY_COLORS[scale] }))
}

/** 0〜1 の RGB を持つ色の段を CSS の色へ。 */
function rampStops(ramp: Ramp): LegendStop[] {
  return ramp.map(([at, r, g, b]) => ({
    at,
    color: `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`,
  }))
}

/**
 * 深さの目盛り。
 *
 * **位置は `depthRampT` で求める。** 色は平方根で浅い側へ寄せてあるので（`DEPTH_RAMP_MAX_KM`）、
 * km を等間隔に置くと目盛りと色がずれる。
 */
function depthTicks(): LegendTick[] {
  const km = [0, 30, 120, 270, 750]
  return km.map((v, i) => ({ at: depthRampT(v), label: i === km.length - 1 ? `${v}km` : String(v) }))
}

function magnitudeTicks(): LegendTick[] {
  const { min, max } = MAGNITUDE_RAMP_RANGE
  const values = [min, 4, 6, 8, max]
  return values.map((m, i) => ({
    at: (m - min) / (max - min),
    label: i === 0 ? `M${m}` : String(m),
  }))
}

/**
 * 発生年の目盛り。両端の年だけを出す。
 *
 * 同じ年に収まっているときは 1 つにする（同じ数字を両端へ並べても読めない）。
 */
function yearTicks(range: { lo: number; hi: number }): LegendTick[] {
  const lo = jstYearOf(range.lo)
  const hi = jstYearOf(range.hi)
  if (lo === hi) return [{ at: 0, label: String(lo) }]
  return [
    { at: 0, label: String(lo) },
    { at: 1, label: String(hi) },
  ]
}

/** 気象庁以外の機関の震源を示す輪の見本の色。輪の実際の色は点ごとの色分けに従うので、見本は中立の灰色にする。 */
const EXTERNAL_RING_HEX = '#d1d5db'

const CATALOG_TITLES: Record<CatalogColorBy, { title: string; shortTitle: string }> = {
  depth: { title: '震源の深さ', shortTitle: '深さ' },
  magnitude: { title: 'マグニチュード', shortTitle: 'M' },
  time: { title: '発生年', shortTitle: '発生年' },
}

/**
 * 震源カタログの色帯。
 *
 * **`switch` で書き、既定の枝を `never` で閉じる。** `if` の連なりだと、色分けの種類が増えたときに
 * 見出しだけ新しく色帯は発生年のまま、という食い違いが型検査を通ってしまう（見出しの表は
 * `Record<CatalogColorBy, …>` なので追加を強制される）。
 */
function catalogBlock(sources: MapLegendSources): LegendBlock | null {
  const colorBy = sources.catalogColorBy
  if (!colorBy) return null
  const { title, shortTitle } = CATALOG_TITLES[colorBy]
  const base = { key: 'catalog' as const, title, shortTitle }
  // 気象庁以外の機関の震源は、色分けによらず輪で描く。描かれているときだけ見本を添える
  // （2026-10-25 ユーザー選択「足す (Recommended)」）。輪の色は点ごとに違うので、見本は中立の灰色。
  const externalChip: LegendChip[] = sources.catalogExternal
    ? [{ label: '気象庁以外の機関の震源', color: EXTERNAL_RING_HEX, shape: 'ring' }]
    : []
  const withChips = (chips: LegendChip[]) => (chips.length > 0 ? { chips } : {})
  switch (colorBy) {
    case 'depth': {
      // **深さ不明の点が描かれているときだけ添える**（2026-10-25 ユーザー選択「足す (Recommended)」）。
      // 灰色で塗るのは深さで色を付けているときだけなので、見本もこの枝だけに置く。色は点を塗る側と同じ定数。
      const chips: LegendChip[] = [
        ...(sources.catalogUnknownDepth ? [{ label: '深さ不明', color: UNKNOWN_MAGNITUDE_HEX, shape: 'dot' as const }] : []),
        ...externalChip,
      ]
      return { ...base, swatch: { kind: 'ramp', stops: rampStops(DEPTH_RAMP), ticks: depthTicks(), ...withChips(chips) } }
    }
    case 'magnitude': {
      // **M 不明の点が描かれているときだけ添える**（2026-10-18 ユーザー選択「灰色＋凡例「M 不明」」）。
      // 色は点を塗る側と同じ定数から採る。
      const chips: LegendChip[] = [
        ...(sources.catalogUnknownMagnitude ? [{ label: 'M 不明', color: UNKNOWN_MAGNITUDE_HEX, shape: 'dot' as const }] : []),
        ...externalChip,
      ]
      return {
        ...base,
        swatch: { kind: 'ramp', stops: rampStops(MAGNITUDE_RAMP), ticks: magnitudeTicks(), ...withChips(chips) },
      }
    }
    case 'time': {
      // **両端が判らなければ目盛りを出さない**（色の向きだけは伝わる）。点が 1 件も残って
      // いないときに `timeRange` が `null` で来る。
      const ticks = sources.catalogYearRange ? yearTicks(sources.catalogYearRange) : []
      return { ...base, swatch: { kind: 'ramp', stops: rampStops(TIME_RAMP), ticks, ...withChips(externalChip) } }
    }
    default: {
      const exhaustive: never = colorBy
      return exhaustive
    }
  }
}

/**
 * 震度スケールの見出し。使っている描画物の名前を並べる。
 *
 * **「震度」と「リアルタイム震度」を混ぜない。** 前者は気象庁の発表値、後者は強震モニタの推定値で、
 * 同じ配色でも意味が違う（リアルタイム震度は発表震度より高く振れる）。
 */
function intensityTitle(sources: MapLegendSources): string {
  const names: string[] = []
  if (sources.quakeIntensity) names.push('震度')
  if (sources.realtimeIntensity) names.push('リアルタイム震度')
  if (sources.eewIntensity) names.push('緊急地震速報の予想')
  return names.join('・')
}

function lpgmTitle(sources: MapLegendSources): string {
  const names: string[] = []
  if (sources.lpgm) names.push('長周期地震動階級')
  if (sources.eewLpgm) names.push('緊急地震速報の予想')
  return names.join('・')
}

/** ヒートマップ欄に期間を載せる。ヒートマップ欄が無ければそのまま返す。 */
export function withHeatmapPeriod(blocks: LegendBlock[], period: LegendHeatmapPeriod | null): LegendBlock[] {
  if (!period || !blocks.some((b) => b.key === 'heatmap')) return blocks
  return blocks.map((b) => (b.key === 'heatmap' ? { ...b, heatmapPeriod: period } : b))
}

/** 観測網の疎な時代に掛かるときの注記。文はカタログタブの注記と同じ。 */
export function heatmapCompletenessNote(completeness: { fromYear: number; minMagnitude: number } | null): string | null {
  if (!completeness) return null
  return `${completeness.fromYear} 年まで遡ると、記録が揃うのは M ${completeness.minMagnitude.toFixed(1)} 以上です。それより小さい地震は少なく見えます。`
}

/**
 * いま出ているものから凡例のブロックを組む。並びは固定で、出ていないものは現れない。
 *
 * 並べる順は「いま起きていること（震度・津波）→ 背景（カタログ・密度・線）」。
 */
export function buildLegendBlocks(sources: MapLegendSources): LegendBlock[] {
  const blocks: LegendBlock[] = []

  const showsIntensity = sources.quakeIntensity || sources.realtimeIntensity || sources.eewIntensity
  if (showsIntensity) {
    const cells = intensityCells()
    // リアルタイム震度だけが震度0 を描く（`kyoshinIntensityColor` が `SHINDO0_COLOR` を返す）。
    // 発表値の震度に震度0 の色は無い。
    if (sources.realtimeIntensity) cells.unshift({ label: '0', color: SHINDO0_COLOR })
    blocks.push({
      key: 'intensity',
      title: intensityTitle(sources),
      shortTitle: sources.quakeIntensity ? '震度' : 'リアルタイム震度',
      swatch: { kind: 'scale', cells },
    })
  }

  if (sources.unreceived) {
    blocks.push({
      key: 'unreceived',
      title: '震度を入手していない地点',
      shortTitle: '未入電',
      swatch: { kind: 'chips', chips: [{ label: '未入電', color: UNRECEIVED_COLOR, shape: 'dot' }] },
    })
  }

  if (sources.lpgm || sources.eewLpgm) {
    blocks.push({
      key: 'lpgm',
      title: lpgmTitle(sources),
      shortTitle: '長周期階級',
      swatch: {
        kind: 'scale',
        // 観測の長周期を描いているときだけ 0 の枠を足す。0 は観測情報にだけ現れる値で、
        // 緊急地震速報の予想は 1〜4 しか描かない（2026-10-24 ユーザー選択「この形でよい (Recommended)」）。
        cells: (sources.lpgm ? [0, 1, 2, 3, 4] : [1, 2, 3, 4])
          .map((cls) => ({ label: getLpgmClassLabel(cls).replace('階級', ''), color: getLpgmClassColor(cls) })),
      },
    })
  }

  if (sources.psWave) {
    blocks.push({
      key: 'psWave',
      title: '緊急地震速報の予報円',
      shortTitle: '予報円',
      swatch: {
        kind: 'chips',
        chips: [
          { label: 'P波', color: P_WAVE_COLOR, shape: 'line' },
          { label: 'S波', color: S_WAVE_COLOR, shape: 'line' },
        ],
      },
    })
  }

  if (sources.tsunamiGrade) {
    // `Unknown` は等級を語れない電文のための値で、海岸線に等級として現れる語ではない。
    const grades = ['MajorWarning', 'Warning', 'Watch', 'Forecast'] as const
    blocks.push({
      key: 'tsunamiGrade',
      title: '津波',
      shortTitle: '津波',
      swatch: {
        kind: 'chips',
        chips: grades.map((g) => ({ label: TSUNAMI_STYLE[g].label, color: TSUNAMI_STYLE[g].color, shape: 'line' as const })),
      },
    })
  }

  if (sources.tsunamiObsHeight) {
    // **等級（上のブロック）と分ける。** 1m 以上の赤・0.2m 未満のシアンは津波警報・津波予報と
    // 同じ色なので、同じブロックへ並べると観測値を発表された等級と読み違える。
    blocks.push({
      key: 'tsunamiObsHeight',
      title: '観測した津波の高さ',
      shortTitle: '観測波高',
      swatch: {
        kind: 'chips',
        chips: TSUNAMI_OBS_HEIGHT_STEPS.map((s) => ({ label: s.label, color: s.color, shape: 'bar' as const })),
      },
    })
  }

  if (sources.tsunamiArrival || sources.tsunamiMissing) {
    const chips: LegendChip[] = []
    if (sources.tsunamiArrival) chips.push({ label: '到達確認', color: ARRIVAL_COLOR, shape: 'dot' })
    if (sources.tsunamiMissing) chips.push({ label: '欠測', color: TSUNAMI_MISSING_COLOR, shape: 'dot' })
    blocks.push({ key: 'tsunamiStation', title: '潮位観測点', shortTitle: '観測点', swatch: { kind: 'chips', chips } })
  }

  const catalog = catalogBlock(sources)
  if (catalog) blocks.push(catalog)

  if (sources.heatmap) {
    blocks.push({
      key: 'heatmap',
      // 期間は下の行とスライダーで示すので、見出しには書かない（2026-10-25 ユーザー選択「E の案でよい (Recommended)」）。
      title: '地震活動の密度',
      shortTitle: '地震活動の密度',
      swatch: {
        kind: 'ramp',
        stops: HEATMAP_DENSITY_STOPS.map((s) => ({ at: s.at, color: s.color })),
        ticks: [
          { at: 0, label: '少' },
          { at: 1, label: '多' },
        ],
      },
    })
  }

  if (sources.activeFaults || sources.plateBoundaries) {
    const chips: LegendChip[] = []
    if (sources.activeFaults) chips.push({ label: '活断層', color: FAULT_COLOR, shape: 'line' })
    if (sources.plateBoundaries) {
      // 7 分類を 4 系統にまとめて出す（2026-10-25 ユーザー承認「B の案でよい (Recommended)」）。
      chips.push({ label: 'プレート境界（沈み込み帯）', color: SUBDUCTION_COLOR, shape: 'line' })
      chips.push({ label: 'プレート境界（収束）', color: PLATE_CONVERGENT_COLOR, shape: 'line' })
      chips.push({ label: 'プレート境界（拡大・リフト）', color: PLATE_DIVERGENT_COLOR, shape: 'line' })
      chips.push({ label: 'プレート境界（トランスフォーム断層）', color: PLATE_TRANSFORM_COLOR, shape: 'line' })
    }
    blocks.push({ key: 'lines', title: '線', shortTitle: '線', swatch: { kind: 'chips', chips } })
  }

  return sortByPrimary(blocks, sources.primary)
}

/**
 * いま見ている画面の主役を先頭へ寄せる。**残りの相対順は崩さない**（上の並びが意味を持つ）。
 *
 * `primary` に並べた順で先に出すので、呼び出し側は「その画面で先に読ませたいもの」を優先度順に
 * 渡す。含まれない鍵も落とさない —— 地図に描いてあるものは、後ろに回るだけで消えない。
 */
function sortByPrimary(blocks: LegendBlock[], primary: LegendKey[]): LegendBlock[] {
  if (primary.length === 0) return blocks
  const rank = (key: LegendKey) => {
    const i = primary.indexOf(key)
    return i < 0 ? primary.length : i
  }
  return blocks
    .map((block, at) => ({ block, at, rank: rank(block.key) }))
    .sort((a, b) => a.rank - b.rank || a.at - b.at)
    .map((e) => e.block)
}

/**
 * 畳んだときに 1 つだけ出すブロック。
 *
 * **並びの先頭をそのまま採る。** 先頭はその画面の主役（`sources.primary`）なので、畳んだ凡例が
 * 残すものと利用者が見ているものが揃う。**別の優先順位を持たせない** —— 以前は「津波が出ていれば
 * 畳んでも津波」という表を別に持っていたが、震源カタログを眺めているときに津波の等級が代表に
 * なって、いま見ているものが凡例から消えた。
 *
 * **これは震源カタログに限らず 4 モードすべてに効く。** 地震情報・リアルタイム震度を見ている
 * 最中に津波警報が出ていても、畳んだ凡例に残るのはその画面の主役で、津波は先頭に来ない
 * （凡例に警報の告知を兼ねさせない。津波の発表は帯・タブの印・タイトル・音と読み上げ・
 * 自動タブ切替が伝える）。
 */
export function representativeBlock(blocks: LegendBlock[]): LegendBlock | null {
  return blocks[0] ?? null
}
