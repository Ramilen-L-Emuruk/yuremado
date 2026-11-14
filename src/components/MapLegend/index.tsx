import { memo, useLayoutEffect, useRef, useState } from 'react'
import { DisclosureCaret, INNER_GROW_MS, prefersReducedMotion } from '../EarthquakeTab/quakeMotion'
import { readableTextColor } from '../../utils/contrast'
import { representativeBlock, type LegendBlock, type LegendChip, type LegendHeatmapPeriod, type LegendSwatch, type LegendTick } from './legendBlocks'
import { HEATMAP_PERIODS, type HeatmapPeriod } from '../../utils/quakeHeatmap'
import { useMessages } from '../../i18n/I18nProvider'

// 地図へ重ねる凡例。中身を決めるのは legendBlocks.ts で、ここは描くだけ。
//
// **器を中身より大きくしない。** 地図の上に乗るものなので、余白・行間・見出しの行高はどれも
// 詰める。専用の見出し行（「凡例」＋開閉の印）は持たず、**1 つ目のブロックの見出しが開閉を兼ねる**
// ——開いている間その行は情報を持たないのに、高さは中身 1 ブロック分を取っていた。
//
// **畳んでも色見本を残す。** 見出しだけにすると、畳んだ状態が既定になる狭い画面では
// 凡例が一度も役に立たない。残すのは並びの先頭（`representativeBlock`）。
//
// 文字は rem で書く（地図の描画物に掛ける `iconScale` は UI には掛けない決まり）。

/**
 * 寸法の組。**狭い画面ではひと段小さくする**（`compact`）。
 *
 * 幅は変えず（色見本の折り返しが変わると読み方が変わる）、文字と余白だけを詰める。判定は
 * 地図領域の実寸で、畳みの既定と同じ物差しを使う（`autoCollapse.ts`）——狭いから畳む画面では、
 * 開いたときも小さいほうが釣り合う。
 */
interface Metrics {
  /** 見出しの文字。 */
  title: string
  /** 色見本に添える文字。 */
  label: string
  /** 升目 1 つの最小幅と上下の詰め。 */
  cell: string
  /** ブロックのあいだ。 */
  gap: string
  /** 枠の内側。 */
  pad: string
  /** 色見本の図形（線・丸・縦棒）。**文字だけ詰めると図形との釣り合いが崩れる。** */
  mark: { line: string; dot: string; bar: string }
  /**
   * 押せる範囲の張り出し。**見た目の高さは増やさず、当たり判定だけ枠の外へ広げる。**
   *
   * 畳んだ凡例は「開くための入口」で、狭い画面ほど小さくなる——タッチで操作する画面でこそ
   * 的が小さくなる、という逆向きの結果を避ける。ただし**高さで稼ぐと畳んだ意味が薄れる**ので
   * （実測で 19px が 46px まで太った）、透明な疑似要素を上下へ伸ばして指の的だけを確保する。
   * 広げるのは上下 8px 程度で、そのぶん地図のドラッグを奪うが、凡例の縁のごく近くに限る。
   */
  hit: { collapsed: string; heading: string }
}

const REGULAR: Metrics = {
  title: 'text-[0.5625rem] leading-[1.1]',
  label: 'text-[0.625rem] leading-none',
  cell: 'min-w-[0.6rem] px-1 py-[0.15rem] text-[0.625rem]',
  gap: 'mt-1',
  pad: 'px-[0.4rem] py-[0.3rem]',
  mark: { line: 'h-[3px] w-3', dot: 'h-[0.6rem] w-[0.6rem]', bar: 'h-[0.7rem] w-1' },
  hit: {
    collapsed: "relative after:absolute after:inset-x-0 after:inset-y-[-0.4rem] after:content-['']",
    heading: "relative after:absolute after:inset-x-0 after:-inset-y-1 after:content-['']",
  },
}

const COMPACT: Metrics = {
  title: 'text-[0.5rem] leading-[1.1]',
  label: 'text-[0.5625rem] leading-none',
  cell: 'min-w-[0.55rem] px-[0.2rem] py-[0.1rem] text-[0.5625rem]',
  gap: 'mt-[0.2rem]',
  pad: 'px-[0.35rem] py-1',
  mark: { line: 'h-[2px] w-[0.65rem]', dot: 'h-2 w-2', bar: 'h-[0.6rem] w-[0.2rem]' },
  // 畳んだ状態は指で開くもの。狭い画面ほど的を広げる（見た目の詰めは保ったまま）。
  hit: {
    collapsed: "relative after:absolute after:inset-x-0 after:inset-y-[-0.55rem] after:content-['']",
    heading: "relative after:absolute after:inset-x-0 after:inset-y-[-0.3rem] after:content-['']",
  },
}

/** 色の升目（震度階級のように段が決まっているもの）。文字色は背景から選ぶ。 */
function ScaleCells({ cells, m }: { cells: { label: string; color: string }[]; m: Metrics }) {
  return (
    <div className="inline-flex overflow-hidden rounded-[3px]">
      {cells.map((cell) => (
        <span
          key={cell.label}
          className={`${m.cell} text-center font-bold leading-none`}
          style={{ backgroundColor: cell.color, color: readableTextColor(cell.color) }}
        >
          {cell.label}
        </span>
      ))}
    </div>
  )
}

/** 色見本の形。地図での描き方に合わせる（線・丸・縦棒）。寸法は `Metrics` から採る。 */
function ChipMark({ chip, m }: { chip: LegendChip; m: Metrics }) {
  if (chip.shape === 'line') {
    return <i className={`inline-block rounded-xs ${m.mark.line}`} style={{ backgroundColor: chip.color }} />
  }
  if (chip.shape === 'bar') {
    // 観測棒は縦に立てるので、凡例でも縦長にする（丸印と混ざらないため）。
    return <i className={`inline-block rounded-[1px] ${m.mark.bar}`} style={{ backgroundColor: chip.color }} />
  }
  if (chip.shape === 'ring') {
    // 中を抜いた丸（震源カタログで気象庁以外の機関の震源を描く形）。
    return <i className={`inline-block rounded-full border-2 ${m.mark.dot}`} style={{ borderColor: chip.color }} />
  }
  return (
    <i
      className={`inline-block rounded-full border border-white/90 ${m.mark.dot}`}
      style={{ backgroundColor: chip.color }}
    />
  )
}

/**
 * 色見本と名前を並べる。
 *
 * **畳んだときは名前を省く**（`labels: false`）。等級のように見本が 4 つ以上あると、名前つきでは
 * 折り返して 2 行になり、畳んだ意味が消える。色の並びだけでも「どの色が使われているか」は伝わり、
 * 意味は開けば読める。
 */
function Chips({ chips, m, labels = true }: { chips: LegendChip[]; m: Metrics; labels?: boolean }) {
  return (
    <div
      className={`flex items-center text-white ${m.label} ${
        labels ? 'flex-wrap gap-x-[0.4rem] gap-y-[0.15rem]' : 'gap-x-1'
      }`}
    >
      {chips.map((chip) => (
        <span
          key={chip.label}
          className="inline-flex items-center gap-[0.2rem] whitespace-nowrap"
          // 名前を省いた分は読み上げと吹き出しへ残す（色だけでは何の色か分からない）。
          title={labels ? undefined : chip.label}
          aria-label={labels ? undefined : chip.label}
        >
          <ChipMark chip={chip} m={m} />
          {labels && <span>{chip.label}</span>}
        </span>
      ))}
    </div>
  )
}

/** 連続した色帯。目盛りは位置（0〜1）で置く。 */
function Ramp({
  stops,
  ticks,
  width,
  m,
}: {
  stops: { at: number; color: string }[]
  ticks: LegendTick[]
  width: string
  m: Metrics
}) {
  const gradient = `linear-gradient(to right, ${stops.map((s) => `${s.color} ${(s.at * 100).toFixed(1)}%`).join(', ')})`
  return (
    <div style={{ width }}>
      <div className="h-[0.4rem] rounded-xs" style={{ background: gradient }} />
      {ticks.length > 0 && (
        <div className={`relative mt-[0.1rem] h-[0.6rem] text-secondary ${m.title}`}>
          {ticks.map((tick) => (
            <span
              key={tick.label}
              className="absolute whitespace-nowrap"
              // 両端は枠の内側へ寄せる（中央揃えのままでは外へはみ出す）。
              style={
                tick.at <= 0
                  ? { left: 0 }
                  : tick.at >= 1
                    ? { right: 0 }
                    : { left: `${tick.at * 100}%`, transform: 'translateX(-50%)' }
              }
            >
              {tick.label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function Swatch({
  swatch,
  rampWidth,
  m,
  labels = true,
}: {
  swatch: LegendSwatch
  rampWidth: string
  m: Metrics
  labels?: boolean
}) {
  if (swatch.kind === 'scale') return <ScaleCells cells={swatch.cells} m={m} />
  if (swatch.kind === 'chips') return <Chips chips={swatch.chips} m={m} labels={labels} />
  const ramp = <Ramp stops={swatch.stops} ticks={swatch.ticks} width={rampWidth} m={m} />
  // **畳んだときは色帯だけにする。** 添えた見本まで並べると 1 行に収まらない（`Chips` の名前を省くのと同じ理由）。
  if (!swatch.chips || swatch.chips.length === 0 || !labels) return ramp
  return (
    <div>
      {ramp}
      <div className="mt-[0.15rem]">
        <Chips chips={swatch.chips} m={m} />
      </div>
    </div>
  )
}

/**
 * ヒートマップの期間（2026-10-25 ユーザー選択「E の案でよい (Recommended)」）。目盛りは `HEATMAP_PERIODS` の 10 段で、
 * 左ほど短い。期間の始まりを日付で添え、終わりは「いま」（再生中は「再生時刻」）。
 */
function HeatmapPeriodControl({
  value,
  width,
  m,
  onChange,
}: {
  value: LegendHeatmapPeriod
  width: string
  m: Metrics
  onChange: (period: HeatmapPeriod) => void
}) {
  const w = useMessages().map.legend
  const index = Math.max(0, HEATMAP_PERIODS.findIndex((p) => p.key === value.period))
  return (
    <div style={{ width }} className="mt-[0.2rem]">
      <div className={`text-secondary ${m.title}`}>
        {value.text}
      </div>
      <input
        type="range"
        min={0}
        max={HEATMAP_PERIODS.length - 1}
        step={1}
        value={index}
        aria-label={w.period}
        aria-valuetext={w.heatmapPeriod[HEATMAP_PERIODS[index].key]}
        title={w.heatmapPeriod[HEATMAP_PERIODS[index].key]}
        onChange={(e) => {
          const next = HEATMAP_PERIODS[Number(e.target.value)]
          if (next) onChange(next.key)
        }}
        className="block w-full h-3 accent-sky-400"
      />
      {value.note && <div className={`text-yellow-400 ${m.title}`}>{value.note}</div>}
    </div>
  )
}

/** 開閉の向きを示す三角。**状態は `aria-expanded` が伝えるので読み上げからは外す。** */
function Caret({ open }: { open: boolean }) {
  return <span aria-hidden className="text-[0.5rem] leading-none opacity-70"><DisclosureCaret open={open} /></span>
}

interface Props {
  blocks: LegendBlock[]
  collapsed: boolean
  onToggle: () => void
  /** 地図が低い画面（`isMapAreaShort`）。文字と余白をひと段詰める。 */
  compact?: boolean
  /** ヒートマップの期間を変えたとき（ヒートマップ欄のスライダー）。 */
  onHeatmapPeriodChange: (period: HeatmapPeriod) => void
}

/**
 * 開閉の動き（2026-11-04 選択「決定どおり動かす (Recommended)」）。畳んだ形と開いた形は中身も幅も違うので、
 * 枠の幅と高さを前の大きさから今の大きさへ動かし、その間だけ前の中身を薄くしながら重ねる。新しい中身は薄くから出す。
 * 凡例は地図の右下の隅に立つので、前の中身は枠の右下に揃えて重ねる（枠は右下を軸に伸び縮みする）。
 */
function useLegendMotion(collapsed: boolean) {
  const boxRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  /** 動いていない間の枠の大きさ。開閉の動きの出発点（動きの途中で押されたら、そのときの見た目の大きさから始める） */
  const sizeRef = useRef<{ w: number; h: number } | null>(null)
  const prevCollapsedRef = useRef(collapsed)
  const animRef = useRef<{ box: Animation; body: Animation | null } | null>(null)
  /** 薄くしながら重ねている前の中身（畳み具合・そのときの枠の幅・重ね直すたびに変える鍵）。null なら重ねていない */
  const [ghost, setGhost] = useState<{ collapsed: boolean; width: number; key: number } | null>(null)
  /** 印の向き。新しい中身の印を前の向きで描き、次の描画で今の向きへ回す（同じ向きで描くと回らない） */
  const [caretOpen, setCaretOpen] = useState(!collapsed)

  const measure = () => {
    const box = boxRef.current
    if (!box) return
    const r = box.getBoundingClientRect()
    sizeRef.current = { w: r.width, h: r.height }
  }

  useLayoutEffect(() => {
    if (prevCollapsedRef.current === collapsed) return
    const before = prevCollapsedRef.current
    prevCollapsedRef.current = collapsed
    const raf = requestAnimationFrame(() => setCaretOpen(!collapsed))
    const box = boxRef.current
    const body = bodyRef.current
    // 動きの途中で押されたら、いま見えている大きさと濃さから始める（控えの値から始めると一瞬跳ぶ）
    const running = animRef.current
    const live = running && box ? box.getBoundingClientRect() : null
    const from = live ? { w: live.width, h: live.height } : sizeRef.current
    const bodyOpacity = running && body ? parseFloat(getComputedStyle(body).opacity) : 0
    running?.box.cancel()
    running?.body?.cancel()
    animRef.current = null
    if (box) box.style.overflow = ''
    if (body) body.style.width = ''
    measure()
    const to = sizeRef.current
    if (!box || !body || !from || !to || prefersReducedMotion() || typeof box.animate !== 'function') {
      setGhost(null)
      return () => cancelAnimationFrame(raf)
    }
    // 新しい中身は行き先の幅で組んだまま見せる（枠の途中の幅で組み直すと、折り返してから伸びる）
    body.style.width = `${body.getBoundingClientRect().width}px`
    setGhost(g => ({ collapsed: before, width: from.w, key: (g?.key ?? 0) + 1 }))
    box.style.overflow = 'clip'
    const boxAnim = box.animate(
      [{ width: `${from.w}px`, height: `${from.h}px` }, { width: `${to.w}px`, height: `${to.h}px` }],
      { duration: INNER_GROW_MS, easing: 'ease-in-out' },
    )
    const bodyAnim = body.animate([{ opacity: Number.isFinite(bodyOpacity) ? bodyOpacity : 0 }, { opacity: 1 }], { duration: INNER_GROW_MS, easing: 'ease-out' })
    const mine = { box: boxAnim, body: bodyAnim }
    animRef.current = mine
    // 止められた動きの後始末は、次の動きが済ませている（ここで戻すと次の動きの切り方と重ねを消す）
    const done = () => {
      if (animRef.current !== mine) return
      animRef.current = null
      box.style.overflow = ''
      body.style.width = ''
      setGhost(null)
      measure()
    }
    boxAnim.finished.then(done, done)
    return () => cancelAnimationFrame(raf)
  }, [collapsed])

  // 枠の大きさは、中身が替わったときも、パネルの比率・画面の向き・文字の大きさが変わったときも控え直す
  // （描き直されないまま大きさだけ変わることがある）。動いている間は測らない —— 測ると途中の大きさを控える
  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box) return
    if (animRef.current === null) measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => { if (animRef.current === null) measure() })
    ro.observe(box)
    return () => ro.disconnect()
  })

  useLayoutEffect(() => () => {
    animRef.current?.box.cancel()
    animRef.current?.body?.cancel()
  }, [])

  return { boxRef, bodyRef, ghost, caretOpen }
}

export const MapLegend = memo(function MapLegend({ blocks, collapsed, onToggle, compact = false, onHeatmapPeriodChange }: Props) {
  const { boxRef, bodyRef, ghost, caretOpen } = useLegendMotion(collapsed)
  // 描くものが無ければ枠ごと出さない（空の箱は地図を隠すだけ）。
  if (blocks.length === 0) return null

  const m = compact ? COMPACT : REGULAR

  return (
    <div
      ref={boxRef}
      className={`relative pointer-events-auto rounded-md border border-border bg-panel/90 shadow-[0_3px_8px_rgba(0,0,0,.55)] ${m.pad}`}
      style={{
        // 幅の上限は、反対の隅（左下）に立つ共有ボタン（幅 2.25rem・左端から `max(0.5rem, 左のセーフエリア)`）と
        // その右の隙間 0.5rem を差し引いた幅。差し引かないと、凡例を開いた 360px 幅の画面でボタンに 12px 重なる。
        maxWidth: 'min(20rem, calc(100% - max(0.5rem, env(safe-area-inset-left, 0px)) - 2.75rem - max(0.5rem, env(safe-area-inset-right, 0px))))',
        marginRight: 'max(0.5rem, env(safe-area-inset-right, 0px))',
        marginBottom: '0.5rem',
      }}
    >
      <div ref={bodyRef}>
        <LegendBody blocks={blocks} collapsed={collapsed} caretOpen={caretOpen} onToggle={onToggle} m={m} compact={compact} onHeatmapPeriodChange={onHeatmapPeriodChange} />
      </div>
      {ghost !== null && (
        // 前の中身。押せないようにし、読み上げからも外す（今の中身と二重に読まれる）
        <div
          key={ghost.key}
          aria-hidden
          {...{ inert: '' }}
          className={`legend-ghost pointer-events-none absolute bottom-0 right-0 ${m.pad}`}
          style={{ width: ghost.width }}
        >
          <LegendBody blocks={blocks} collapsed={ghost.collapsed} caretOpen={!ghost.collapsed} onToggle={onToggle} m={m} compact={compact} onHeatmapPeriodChange={onHeatmapPeriodChange} />
        </div>
      )}
    </div>
  )
})

function LegendBody({ blocks, collapsed, caretOpen, onToggle, m, compact, onHeatmapPeriodChange }: {
  blocks: LegendBlock[]
  collapsed: boolean
  caretOpen: boolean
  onToggle: () => void
  m: typeof REGULAR
  compact: boolean
  onHeatmapPeriodChange: (period: HeatmapPeriod) => void
}) {
  const representative = collapsed ? representativeBlock(blocks) : null
  const rampWidth = compact ? '8.5rem' : '10rem'
  return (
    <>
      {representative ? (
        // 畳んだとき。見出しは短い名前にして、色見本と 1 行へ収める。
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={false}
          className={`flex w-full items-center gap-[0.35rem] text-left ${m.hit.collapsed}`}
        >
          <span className={`font-bold text-secondary ${m.title}`}>{representative.shortTitle}</span>
          <Swatch swatch={representative.swatch} rampWidth={rampWidth} m={m} labels={false} />
          <Caret open={caretOpen} />
        </button>
      ) : (
        blocks.map((block, i) => (
          <div key={block.key} className={i > 0 ? m.gap : undefined}>
            {/* **1 つ目の見出しが開閉を兼ねる。** 専用の行を足すと、開いている間ずっと
                情報を持たない行が高さを取る。 */}
            {i === 0 ? (
              <button
                type="button"
                onClick={onToggle}
                aria-expanded
                className={`flex w-full items-center justify-between gap-2 text-left font-bold tracking-wide text-secondary ${m.title} ${m.hit.heading}`}
              >
                <span>{block.title}</span>
                <Caret open={caretOpen} />
              </button>
            ) : (
              <div className={`font-bold tracking-wide text-secondary ${m.title}`}>{block.title}</div>
            )}
            <div className="mt-[0.1rem]">
              <Swatch swatch={block.swatch} rampWidth={rampWidth} m={m} />
              {block.heatmapPeriod && (
                <HeatmapPeriodControl value={block.heatmapPeriod} width={rampWidth} m={m} onChange={onHeatmapPeriodChange} />
              )}
            </div>
          </div>
        ))
      )}
    </>
  )
}
