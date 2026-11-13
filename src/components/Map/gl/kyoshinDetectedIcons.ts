import type { Map as MapLibreMap } from 'maplibre-gl'
import { getIntensityColor, intensityShortLabel, type IntensityWords } from '../../../utils/intensity'
import { SHINDO0_COLOR } from '../../../utils/measuredIntensity'
import { readableTextColor } from '../../../utils/contrast'
import { KYOSHIN_SUB_ZERO_STEP_COLORS, KYOSHIN_SUB_ZERO_STEPS, kyoshinSubZeroStepRatio } from '../../../utils/kyoshinIntensity'

// 揺れ検知点（KyoshinDetectedPointsGL の confirmed=確定／likely=候補）の丸バッジ（震度ラベル込み）を
// Canvas2D で事前ラスタライズし、symbol レイヤーの icon-image として登録する。
// 震度観測点（QuakeIntensityPointsGL、gl/intensityIcons.ts）と同じ「丸背景＋文字を1枚の画像に
// 統合する」方式。丸背景を circle レイヤーで、震度ラベルを別の symbol レイヤーで重ねる旧実装は、
// circle が衝突判定に一切参加しない仕様のため丸同士の重なりを防げず、文字レイヤーも丸レイヤーとは
// 独立に描画されるため「下に完全に隠れた丸の文字まで表示してしまう」問題があった
// （2026-08-10 の実機検証）。丸ごと1枚の画像にすることで、icon-allow-overlap:true のまま
// （重なりは許容）でも、symbol-sort-key で前面に来た1点は「丸＋文字セット」で必ず正しく読める。

/** アイコン生成のベース半径(px)。実際の表示サイズは icon-size でこの半径からの比率をかけて決める。 */
export const KYOSHIN_DETECTED_ICON_BASE_RADIUS = 32
const PADDING = 8
// confirmed の白フチ幅（旧 circle 版 CONFIRMED_STROKE_WIDTH の見た目を踏襲、ベース半径基準で少し太め）。
const CONFIRMED_RING_WIDTH = 4

// kyoshinIndexToJma の rank(0〜9) と対応する代表 scale（震度0は色を別途 SHINDO0_COLOR にする）。
const RANK_SCALES = [10, 10, 20, 30, 40, 45, 50, 55, 60, 70]

/**
 * rank の丸の中の字。震度0 は震度の札の表に無いので「0」を置き、ほかは地図の震度の丸と同じ短い札
 * （{@link intensityShortLabel}。日本語は「5弱」、英語などは「5-」）。
 */
function rankLabel(rank: number, w: IntensityWords): string {
  return rank === 0 ? '0' : intensityShortLabel(RANK_SCALES[rank] ?? 10, w)
}

/**
 * 検知に加わった震度0 未満の点の印（文字なし・白フチ。2026-10-29 ユーザー選択「文字なしの小さな印 (Recommended)」）。
 * 段（インデックス 0〜5）ごとに塗りと白フチの濃さを変える（2026-10-30 ユーザー選択「明るさと大きさで段を付ける (Recommended)」）。
 * 白フチを段で薄くするのは、弱い段の暗い塗りに白い輪だけが残ると、どの段も同じ明るさの輪に見えてしまうため。
 * フチの太さで確定／早い段を見分ける形は変えない
 */
// 下限を 0.5 にするのは、早い段（フチ ×0.7）が欠測の保持（icon-opacity 0.35）に入っても、
// いちばん弱い段の暗い塗りが背景へ溶けて「検知しているのに描いていない」ように見えないため
const SUB_ZERO_RING_ALPHA_MIN = 0.5

/** 段の白フチの濃さ（弱い段 0.5 → 強い段 1） */
function subZeroRingAlpha(step: number): number {
  return SUB_ZERO_RING_ALPHA_MIN + (1 - SUB_ZERO_RING_ALPHA_MIN) * kyoshinSubZeroStepRatio(step)
}

/** @param step 震度0 未満の段（`kyoshinSubZeroStep` の戻り値） */
export function kyoshinDetectedSubZeroIconId(step: number, confirmed: boolean): string {
  return `kyoshin-detected-badge-subzero-${step}-${confirmed ? 'confirmed' : 'candidate'}`
}

export function kyoshinDetectedIconId(rank: number, confirmed: boolean): string {
  return `kyoshin-detected-badge-${rank}-${confirmed ? 'confirmed' : 'candidate'}`
}

function rankColor(rank: number): string {
  return rank === 0 ? SHINDO0_COLOR : getIntensityColor(RANK_SCALES[rank] ?? 10)
}

function drawBadge(rank: number, confirmed: boolean, label: string): ImageData {
  const r = KYOSHIN_DETECTED_ICON_BASE_RADIUS
  const size = (r + PADDING) * 2
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const cx = size / 2
  const cy = size / 2

  const fill = rankColor(rank)

  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.7)'
  ctx.shadowBlur = 3
  ctx.fillStyle = fill
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  // confirmed は太めの白フチで一段目立たせる（旧 circle 版の confidence 差別化を踏襲）。
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = confirmed ? CONFIRMED_RING_WIDTH : 2
  ctx.globalAlpha = confirmed ? 1 : 0.7
  ctx.beginPath()
  ctx.arc(cx, cy, r - ctx.lineWidth / 2, 0, Math.PI * 2)
  ctx.stroke()
  ctx.globalAlpha = 1

  // 文字色は丸の塗り色から決める（白固定だと震度4 の黄で 1.30:1 まで落ちる。intensityIcons.ts と同様）。
  ctx.fillStyle = readableTextColor(fill)
  // "Noto Sans JP" は @font-face 未登録で効いておらず、同梱も撤去済み（理由は intensityIcons.ts 参照）。
  const fontPx = label.length > 1 ? r * 0.85 : r * 1.15
  ctx.font = `700 ${fontPx}px sans-serif`
  // 丸に収まらない長い札だけ字を縮める（日本語の札はこの幅に収まり、今の大きさのまま。intensityIcons.ts と同じ）
  const maxWidth = r * 1.8
  const width = ctx.measureText(label).width
  if (width > maxWidth) ctx.font = `700 ${(fontPx * maxWidth) / width}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, cx, cy)

  return ctx.getImageData(0, 0, size, size)
}

function drawSubZeroBadge(step: number, confirmed: boolean): ImageData {
  const r = KYOSHIN_DETECTED_ICON_BASE_RADIUS
  const size = (r + PADDING) * 2
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const cx = size / 2
  const cy = size / 2
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.5)'
  ctx.shadowBlur = 3
  // 段は呼び出し側で 0〜5 へ収めてある。`??` は添字の読みを undefined 込みで返す型の都合だけ
  ctx.fillStyle = KYOSHIN_SUB_ZERO_STEP_COLORS[step] ?? KYOSHIN_SUB_ZERO_STEP_COLORS[0]
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = confirmed ? CONFIRMED_RING_WIDTH : 2
  ctx.globalAlpha = (confirmed ? 1 : 0.7) * subZeroRingAlpha(step)
  ctx.beginPath()
  ctx.arc(cx, cy, r - ctx.lineWidth / 2, 0, Math.PI * 2)
  ctx.stroke()
  ctx.globalAlpha = 1
  return ctx.getImageData(0, 0, size, size)
}

/** 地図ごとに、いま焼いてある丸の字（画像の id → 字）。言語を変えたときに字の違う丸だけ焼き直すのに使う */
const bakedLabels = new WeakMap<MapLibreMap, Map<string, string>>()

/**
 * map インスタンスへ揺れ検知点バッジ画像（rank 0〜9 × confirmed/candidate と、震度0 未満の 6 段の印）を一括登録する。
 * 丸の中の字は言語に合わせ、**字が変わった丸だけ同じ id のまま `updateImage` で焼き直す**（地物の `iconId` は言語によらない。
 * 考え方は intensityIcons.ts の `ensureIntensityIcons`）。震度0 未満の印は字を持たないので 1 回だけ登録する。
 */
export function ensureKyoshinDetectedIcons(map: MapLibreMap, w: IntensityWords): void {
  let baked = bakedLabels.get(map)
  if (!baked) {
    baked = new Map()
    bakedLabels.set(map, baked)
  }
  for (let rank = 0; rank < RANK_SCALES.length; rank++) {
    const label = rankLabel(rank, w)
    for (const confirmed of [true, false]) {
      const id = kyoshinDetectedIconId(rank, confirmed)
      if (map.hasImage(id)) {
        // 焼いた字の控えが無いのは、この部品の外で登録された画像。字が分からないので焼き直す
        if (baked.get(id) === label) continue
        map.updateImage(id, drawBadge(rank, confirmed, label))
      } else {
        map.addImage(id, drawBadge(rank, confirmed, label))
      }
      baked.set(id, label)
    }
  }
  for (let step = 0; step < KYOSHIN_SUB_ZERO_STEPS; step++) {
    for (const confirmed of [true, false]) {
      const id = kyoshinDetectedSubZeroIconId(step, confirmed)
      if (!map.hasImage(id)) map.addImage(id, drawSubZeroBadge(step, confirmed))
    }
  }
}
