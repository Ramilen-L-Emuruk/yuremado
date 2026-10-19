// 地図の下端の波形の描き分け（`drawLanes`）。**固定するのは 4 つ** ——展開かどうかを段の数ではなく
// `expanded` で決めること・畳んだ合成が描けなければ 3 成分へ戻すこと・線が 1 本だけの絵に平均の線を重ねること・
// 列を列数ごとに 1 回だけ組むこと。
// 描画そのもの（`paintWave.ts`）は差し替え、どの描き方をどの引数で呼んだかだけを見る。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetWaveAxes, toggleWaveAxis } from '../../hooks/useSeismoWaveAxes'
import type { SeismoWaveWindow } from '../../utils/seismoWaveBuffer'
import { quietScaledGal } from '../../utils/seismoQuietScale'
import {
  drawLanes,
  liveArrivalMarks,
  presentShiftMs,
  presentSourceX,
  singleVisibleAxis,
  type Lane,
  type LaneTarget,
  type LiveTimeline,
} from './liveLanes'
import { PUBLIC_WAVE_UNIT, SEISMO_WAVE_UNIT } from './waveUnit'
import { SharedLaneScales, sharedPaint, type LaneScales } from './sharedScale'
import { compressedVertical, LINEAR_VERTICAL } from './verticalMap'
import { paintCompositeColumnsAt, paintMarks, paintWaveColumnsAt } from './paintWave'
import { buildWaveColumns } from './waveColumns'

vi.mock('./paintWave', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./paintWave')>()
  return { ...orig, paintCompositeColumnsAt: vi.fn(), paintWaveColumnsAt: vi.fn() }
})
vi.mock('./waveColumns', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./waveColumns')>()
  return { ...orig, buildWaveColumns: vi.fn(orig.buildWaveColumns) }
})

const composite = vi.mocked(paintCompositeColumnsAt)
const overlay = vi.mocked(paintWaveColumnsAt)
const build = vi.mocked(buildWaveColumns)

/** 100 Hz・2 秒の窓（3 成分とも値あり）。 */
function windowOf(): SeismoWaveWindow {
  const n = 200
  const axis = () => Float32Array.from({ length: n }, (_, i) => Math.sin(i / 5))
  return { firstSampleMs: 1_000_000, msPerSample: 10, gal: [axis(), axis(), axis()], memberCount: new Float32Array(n).fill(3) }
}

function targetsFor(lanes: readonly Lane[]): Map<string, LaneTarget> {
  const keys = lanes.map((l) => (l.kind === 'axis' ? `axis-${l.axis}` : l.kind))
  return new Map(keys.map((k) => [k, { canvas: {} as HTMLCanvasElement, size: { width: 400, height: 60 } }]))
}

/** 窓の最後のサンプルを「いま」に置いた時間の取り方（先の余白 0.6 秒）。 */
function timelineAtLastSample(win: SeismoWaveWindow): LiveTimeline {
  return { nowMs: win.firstSampleMs + (win.gal[0].length - 1) * win.msPerSample, spanMs: 60_000, leadMs: 600, clockCalibrated: true }
}

/** 重ねる線が値を持つか。**本数だけでは足りない** ——作り忘れた平均も `NaN` の線として同じ本数で返る。 */
function allHaveValues(lines: readonly { values: ArrayLike<number> }[] | undefined): boolean {
  return lines !== undefined && lines.length > 0 && lines.every((l) => Array.from(l.values).some(Number.isFinite))
}

function run(lanes: readonly Lane[], expanded: boolean) {
  const win = windowOf()
  return drawLanes({ targets: targetsFor(lanes), lanes, expanded, win, stale: false, quietLevel: 0.2, arrivals: [], timeline: timelineAtLastSample(win), unit: SEISMO_WAVE_UNIT, sharing: null })
}

beforeEach(() => {
  composite.mockReset()
  overlay.mockReset()
  build.mockClear()
})

describe('drawLanes の展開', () => {
  // 正: 展開していれば、段が 2 つ（合成＋1 成分）に減っても展開の描き方（平均線・詳細の窓と同じ下限）で描く。
  it('展開なら段の数によらず平均線と ×1.5 の下限で描く', () => {
    composite.mockReturnValue('0〜1.00 gal')
    overlay.mockReturnValue('±1.00 gal')
    run([{ kind: 'composite' }, { kind: 'axis', axis: 2 }], true)
    const opts = composite.mock.calls[0][4]
    expect(opts.overlays).toBeDefined()
    expect(opts.minScale).toBeCloseTo(quietScaledGal('detail', 0.2))
  })

  // 正（2026-10-13 に覆した）: 畳んだ合成も線が 1 本なので、均した線を重ねる。下限は ×3 のまま。
  // 以前は「畳んでいれば平均線なし」を固定していた。
  it('畳んだ合成にも均した線を重ね、下限は ×3', () => {
    composite.mockReturnValue('0〜1.00 gal')
    run([{ kind: 'composite' }], false)
    const opts = composite.mock.calls[0][4]
    expect(opts.overlays).toBeDefined()
    expect(opts.overlays?.(50)).toHaveLength(1)
    expect(allHaveValues(opts.overlays?.(50))).toBe(true)
    expect(opts.minScale).toBeCloseTo(quietScaledGal('card', 0.2))
  })
})

describe('drawLanes の 3 成分を重ねる絵', () => {
  afterEach(() => resetWaveAxes())

  // 正: 向きが 1 つだけなら、その成分の正側・負側の平均の線を重ねる。
  it('向きが 1 つだけなら平均の線を 2 本重ねる', () => {
    toggleWaveAxis(0)
    toggleWaveAxis(1)
    overlay.mockReturnValue('±1.00 gal')
    run([{ kind: 'overlay' }], false)
    const opts = overlay.mock.calls[0][4]
    expect(opts?.overlays?.(50)).toHaveLength(2)
    expect(allHaveValues(opts?.overlays?.(50))).toBe(true)
  })

  // 対照: 2 本以上重ねているときは足さない（線の数が倍になって読めない）。
  it('向きが 2 つ以上なら重ねない', () => {
    toggleWaveAxis(0)
    overlay.mockReturnValue('±1.00 gal')
    run([{ kind: 'overlay' }], false)
    expect(overlay.mock.calls[0][4]?.overlays).toBeUndefined()
  })

  // 安全弁: 畳んだ合成から 3 成分へ戻した絵にも同じ判定を通す（戻した先だけ線が欠けない）。
  it('合成から戻した絵でも向きが 1 つなら重ねる', () => {
    toggleWaveAxis(1)
    toggleWaveAxis(2)
    composite.mockReturnValue(null)
    overlay.mockReturnValue('±1.00 gal')
    run([{ kind: 'composite' }], false)
    expect(overlay.mock.calls[0][4]?.overlays?.(50)).toHaveLength(2)
    expect(allHaveValues(overlay.mock.calls[0][4]?.overlays?.(50))).toBe(true)
  })

  // 安全弁: 合成の段が先に（成分なしで）平均を作っていても、後の成分の段の線は値を持つ。
  it('展開した成分の段の平均は、合成の段の後でも値を持つ', () => {
    composite.mockImplementation((_c, _z, _b, _s, o) => (o.overlays?.(50), '0〜1.00 gal'))
    overlay.mockReturnValue('±1.00 gal')
    run([{ kind: 'composite' }, { kind: 'axis', axis: 2 }], true)
    expect(allHaveValues(overlay.mock.calls[0][4]?.overlays?.(50))).toBe(true)
  })
})

describe('singleVisibleAxis', () => {
  it('1 つだけ見えていればその番号', () => {
    expect(singleVisibleAxis([false, true, false])).toBe(1)
  })
  it('2 つ以上・0 個なら null', () => {
    expect(singleVisibleAxis([true, true, false])).toBeNull()
    expect(singleVisibleAxis([false, false, false])).toBeNull()
  })
})

describe('drawLanes の 3 成分への戻し', () => {
  // 正: 畳んだ合成が描けなければ 3 成分を重ねて描き、「戻した」と返す。
  it('畳んだ合成が null なら 3 成分を重ねる', () => {
    composite.mockReturnValue(null)
    overlay.mockReturnValue('±1.00 gal')
    const out = run([{ kind: 'composite' }], false)
    expect(overlay).toHaveBeenCalledTimes(1)
    expect(out.compositeFellBack).toBe(true)
    expect(out.texts.composite).toBe('±1.00 gal')
  })

  // 対照: 展開しているときの合成の段は戻さない（成分の段が下にある）。
  it('展開中の合成の段は戻さない', () => {
    composite.mockReturnValue(null)
    overlay.mockReturnValue('±1.00 gal')
    const out = run([{ kind: 'composite' }, { kind: 'axis', axis: 0 }], true)
    expect(out.compositeFellBack).toBe(false)
    expect(out.texts.composite).toBeNull()
  })

  // 安全弁: 重ねた絵も描けなければ（値が 1 つも無い）「戻した」とは数えない。
  it('重ねた絵も描けなければ戻したと数えない', () => {
    composite.mockReturnValue(null)
    overlay.mockReturnValue(null)
    expect(run([{ kind: 'composite' }], false).compositeFellBack).toBe(false)
  })
})

describe('drawLanes の列の組み立て', () => {
  // 正: 同じ列数なら、段がいくつあっても列は 1 回だけ組む。
  it('同じ列数なら 1 回だけ組む', () => {
    composite.mockImplementation((_c, _z, b) => (b(50), '0〜1.00 gal'))
    overlay.mockImplementation((_c, _z, b) => (b(50), '±1.00 gal'))
    run([{ kind: 'composite' }, { kind: 'axis', axis: 0 }, { kind: 'axis', axis: 1 }], true)
    expect(build).toHaveBeenCalledTimes(1)
  })

  // 対照: 列数が変われば組み直す（古い列を返さない）。
  it('列数が違えば組み直す', () => {
    composite.mockImplementation((_c, _z, b) => (b(50), '0〜1.00 gal'))
    overlay.mockImplementation((_c, _z, b) => (b(60), '±1.00 gal'))
    run([{ kind: 'composite' }, { kind: 'axis', axis: 0 }], true)
    expect(build).toHaveBeenCalledTimes(2)
  })
})

// 地図の下端の P/S 線は到達予想キーの門を掛けずに引く（2026-10-14 ユーザー承認）。予報業務に当たらないとした整理は
// 「右端＝いま、それより先の時刻の線を描かない」ことに拠る（`docs/forecast-computation-audit.md` の 11）ので、その歯止めを
// 位置の計算（`liveArrivalMarks`）と描く側（`paintMarks`）を通して固定する。裏の絵は「いま」の先に余白を持つので、
// **余白の中に落ちる線も入れない**ことまで見る（入れると、画面へ写す間に右端から先に現れる）。
describe('地図の下端の P/S 線は、まだ来ていない時刻を描かない', () => {
  const nowMs = 1_001_990
  const timeline: LiveTimeline = { nowMs, spanMs: 60_000, leadMs: 600, clockCalibrated: true }

  /** 線とラベルを数えるだけの描画先。 */

  function recordingCtx() {

    const labels: string[] = []

    let strokes = 0

    const ctx = {

      font: '',

      textBaseline: '',

      strokeStyle: '',

      fillStyle: '',

      lineWidth: 0,

      setLineDash: () => {},

      beginPath: () => {},

      moveTo: () => {},

      lineTo: () => {},

      stroke: () => {

        strokes += 1

      },

      measureText: () => ({ width: 6 }),

      fillText: (text: string) => {

        labels.push(text)

      },

    } as unknown as CanvasRenderingContext2D

    return { ctx, labels, strokes: () => strokes }

  }



  // 正: 既に過ぎた P は入り、まだ来ていない S は入らない。
  it('いまより先の到達は入れない', () => {
    const marks = liveArrivalMarks(timeline, [{ pMs: nowMs - 1_000, sMs: nowMs + 5_000 }])
    expect(marks.map((m) => m.label)).toEqual(['P'])
    expect(marks[0].ratio).toBeGreaterThanOrEqual(0)
    expect(marks[0].ratio).toBeLessThanOrEqual(1)
  })

  // 安全弁: 先の余白（いま〜いま＋0.6 秒）に落ちる線も入れない。裏の絵の範囲には収まるので、捨てるのは描く側ではなくここ。
  it('先の余白に落ちる到達も入れない', () => {
    expect(liveArrivalMarks(timeline, [{ pMs: nowMs + 300, sMs: nowMs + 599 }])).toEqual([])
  })

  // 安全弁（2026-10-15 ユーザー承認）: 時計を較正していない間は、過ぎた到達でも線を入れない（そのときの「いま」は
  // 端末の時計で、進んでいれば到達より先に線が出る）。
  it('時計を較正していない間は過ぎた到達も入れない', () => {
    expect(liveArrivalMarks({ ...timeline, clockCalibrated: false }, [{ pMs: nowMs - 1_500, sMs: nowMs - 500 }])).toEqual([])
  })

  // 対照: どちらも過ぎていれば 2 本とも入れる（捨てる判定が広すぎないこと）。
  it('どちらも過ぎていれば両方描く', () => {
    const { ctx, labels } = recordingCtx()
    paintMarks(ctx, liveArrivalMarks(timeline, [{ pMs: nowMs - 1_500, sMs: nowMs - 500 }]), 400, 60, 1)
    expect(labels).toEqual(['P', 'S'])
  })

  // 正（2026-10-14 ユーザー決定「地震ごとに並べて出す」）: 地震が 2 つあれば、どちらの線も引く。
  // どの地震の線かは見分けない（2026-10-18 ユーザー承認「見分けない」）—— どれも「P」「S」。
  it('地震が 2 つあれば両方の線を同じ名前で引く', () => {
    const marks = liveArrivalMarks(timeline, [
      { pMs: nowMs - 3_000, sMs: nowMs - 2_000 },
      { pMs: nowMs - 1_500, sMs: nowMs - 500 },
    ])
    expect(marks.map((m) => m.label)).toEqual(['P', 'S', 'P', 'S'])
  })

  // 安全弁: 2 つ目の地震の「いまより先」の線は、1 つ目の線と別に捨てる（片方が過ぎていても巻き込まない）。
  it('地震ごとに、いまより先の線だけを捨てる', () => {
    const marks = liveArrivalMarks(timeline, [
      { pMs: nowMs - 3_000, sMs: nowMs - 2_000 },
      { pMs: nowMs + 1_000, sMs: nowMs + 3_000 },
    ])
    expect(marks.map((m) => m.label)).toEqual(['P', 'S'])
  })

  // 対照: 地震が無ければ線も無い。
  it('地震が無ければ線を引かない', () => {
    expect(liveArrivalMarks(timeline, [])).toEqual([])
  })

  // 安全弁: ちょうど「いま」の時刻は描いてよい過去に含める。その 1 ms 後は入れない。
  it('いまと同じ時刻は描き、その 1 ms 後は描かない', () => {
    const { ctx, labels } = recordingCtx()
    paintMarks(ctx, liveArrivalMarks(timeline, [{ pMs: nowMs, sMs: nowMs + 1 }]), 400, 60, 1)
    expect(labels).toEqual(['P'])
  })

  // 正（結線）: drawLanes は合成の段と成分の段の両方へ、いまより先の線を除いた印を渡す。
  it('drawLanes はいまより先の線を渡さない', () => {
    const lanes: Lane[] = [{ kind: 'composite' }, { kind: 'axis', axis: 0 }]
    drawLanes({
      targets: targetsFor(lanes),
      lanes,
      expanded: true,
      win: windowOf(),
      stale: false,
      quietLevel: 0.2,
      arrivals: [{ pMs: nowMs - 1_000, sMs: nowMs + 5_000 }],
      timeline,
      unit: SEISMO_WAVE_UNIT,
      sharing: null,
    })
    for (const marks of [composite.mock.calls[0][4]?.marks, overlay.mock.calls[0][4]?.marks]) {
      expect((marks ?? []).length).toBe(1)
    }
  })
})

describe('drawLanes の右端', () => {
  // 正: 列は「いま＋先の余白」を右端に、60 秒＋余白の幅で組む（右端を最後のサンプルへ戻す・幅を 60 秒へ戻す回帰を落とす）。
  it('列を いま＋余白 の右端・60 秒＋余白 の幅で組む', () => {
    // 描く部品は差し替えてあるので、受け取った「列を組む関数」を呼んで組ませる。
    composite.mockImplementation((_c, _z, b) => (b(100), '0〜1.00 gal'))
    const win = windowOf()
    const timeline = timelineAtLastSample(win)
    drawLanes({ targets: targetsFor([{ kind: 'composite' }]), lanes: [{ kind: 'composite' }], expanded: false, win, stale: false, quietLevel: 0.2, arrivals: [], timeline, unit: SEISMO_WAVE_UNIT, sharing: null })
    expect(build).toHaveBeenCalled()
    const args = build.mock.calls[0][0]
    expect(args.rightEdge).toBe(timeline.nowMs + timeline.leadMs)
    expect(args.spanMs).toBe(timeline.spanMs + timeline.leadMs)
  })
})

describe('presentShiftMs（写すときにずらす時間）', () => {
  const timeline: LiveTimeline = { nowMs: 1_000_000, spanMs: 60_000, leadMs: 600, clockCalibrated: true }

  // 正: 組んでから進んだ分だけずらす。
  it('組んでから進んだ分を返す', () => {
    expect(presentShiftMs(timeline, 1_000_250)).toBe(250)
  })

  // 対照: 余白を超えたら端で止める（余白の外の空白を写さない）。
  it('余白を超えたら余白の長さで止まる', () => {
    expect(presentShiftMs(timeline, 1_005_000)).toBe(600)
  })

  // 安全弁: 時計が戻った・壊れたときは組んだ位置のまま（先の余白を写して、いまより先を見せない）。
  it('時計が戻ったら 0、数でなければ 0', () => {
    expect(presentShiftMs(timeline, 999_000)).toBe(0)
    expect(presentShiftMs(timeline, Number.NaN)).toBe(0)
  })

  it('ずらす画素は 60 秒ぶんの幅に対する割合', () => {
    expect(presentSourceX(600, 120_000, 600, 2)).toBeCloseTo((600 / 120_000) * 600 * 2)
  })
})

describe('drawLanes の単位', () => {
  // 正: 公開観測点は速度の単位と、その物差しの下限で描く（gal の下限を当てない）。
  it('公開観測点は μm/s と公開観測点の下限で描く', () => {
    const win = windowOf()
    drawLanes({ targets: targetsFor([{ kind: 'composite' }]), lanes: [{ kind: 'composite' }], expanded: false, win, stale: false, quietLevel: 0.2, arrivals: [], timeline: timelineAtLastSample(win), unit: PUBLIC_WAVE_UNIT, sharing: null })
    const opts = composite.mock.calls[0][4]
    expect(opts.unit).toBe('μm/s')
    expect(opts.minScale).toBeCloseTo(PUBLIC_WAVE_UNIT.minScale('card', 0.2))
  })

  // 対照: 自作地震計は gal のまま。
  it('自作地震計は gal で描く', () => {
    const win = windowOf()
    drawLanes({ targets: targetsFor([{ kind: 'composite' }]), lanes: [{ kind: 'composite' }], expanded: false, win, stale: false, quietLevel: 0.2, arrivals: [], timeline: timelineAtLastSample(win), unit: SEISMO_WAVE_UNIT, sharing: null })
    expect(composite.mock.calls[0][4].unit).toBe('gal')
  })

  // 安全弁: 公開観測点で静かさを測れないときは、gal の測れないときの値ではなく公開観測点の仮の値を使う。
  it('測れないときの値を単位ごとに持つ', () => {
    expect(PUBLIC_WAVE_UNIT.minScale('card', null)).not.toBe(SEISMO_WAVE_UNIT.minScale('card', null))
    expect(PUBLIC_WAVE_UNIT.minScale('detail', 0)).toBeGreaterThan(0)
  })
})

// 公開観測点の段は縦の範囲を全段で揃える（2026-10-19 ユーザー選択「線形で始めて測る (Recommended)」）。
// drawLanes は「揃える範囲」を受け取って描き、「揃える前の自分の範囲」を返す。
describe('drawLanes の縦の範囲を揃える', () => {
  function runShared(lanes: readonly Lane[], expanded: boolean, shared: LaneScales | null) {
    const win = windowOf()
    return drawLanes({ targets: targetsFor(lanes), lanes, expanded, win, stale: false, quietLevel: 0.2, arrivals: [], timeline: timelineAtLastSample(win), unit: PUBLIC_WAVE_UNIT, sharing: { shared } })
  }

  // 正: 他の観測点の範囲が自分より大きければ、そちらで描く（合成は下限として、3 成分は縦の範囲として渡る）。
  it('揃える範囲が大きければ、合成も 3 成分もその範囲で描く', () => {
    let signedScale = NaN
    composite.mockReturnValue('0〜500 μm/s')
    overlay.mockImplementation((_c, _z, b) => ((signedScale = b(50)?.scaleGal ?? NaN), '±400 μm/s'))
    runShared([{ kind: 'composite' }, { kind: 'axis', axis: 0 }], true, { signed: 400, magnitude: 500, floor: 1 })
    expect(composite.mock.calls[0][4].minScale).toBe(500)
    expect(signedScale).toBe(400)
  })

  // 対照: 揃える範囲が自分より小さければ、自分の範囲のまま（小さい側へ縮めない）。
  it('揃える範囲が小さければ自分の範囲で描く', () => {
    let signedScale = NaN
    composite.mockReturnValue('0〜1 μm/s')
    overlay.mockImplementation((_c, _z, b) => ((signedScale = b(50)?.scaleGal ?? NaN), '±1 μm/s'))
    runShared([{ kind: 'composite' }, { kind: 'axis', axis: 0 }], true, { signed: 1e-6, magnitude: 1e-6, floor: 1e-6 })
    expect(composite.mock.calls[0][4].minScale).toBeCloseTo(PUBLIC_WAVE_UNIT.minScale('detail', 0.2))
    // 窓の振れは ±1（sin）なので、下限 1.5 × 0.2 = 0.3 より大きい 1 前後になる。
    expect(signedScale).toBeGreaterThan(0.9)
    expect(signedScale).toBeLessThanOrEqual(1)
  })

  // 安全弁: 返す自分の範囲は揃える前の値（揃えた値を返すと、一度大きく揃えた範囲が自分を縛り続けて下がらない）。
  it('返す自分の範囲は揃える前の値', () => {
    composite.mockImplementation((_c, _z, b) => (b(50), '0〜500 μm/s'))
    overlay.mockReturnValue('±400 μm/s')
    const { ownScale } = runShared([{ kind: 'composite' }, { kind: 'axis', axis: 0 }], true, { signed: 400, magnitude: 500, floor: 1 })
    expect(ownScale).not.toBeNull()
    expect(ownScale!.signed).toBeLessThanOrEqual(1)
    expect(ownScale!.magnitude).toBeLessThan(2)
  })

  // 安全弁: 揃えない段（自作地震計）は今までどおり自分の下限だけで描く。
  it('揃えない段は自分の下限で描く', () => {
    composite.mockReturnValue('0〜1.00 gal')
    run([{ kind: 'composite' }], false)
    expect(composite.mock.calls[0][4].minScale).toBeCloseTo(quietScaledGal('card', 0.2))
  })

  // 安全弁: 列を 1 つも組まなかった（描く段が無い・窓が空）なら、自分の範囲は返さない（古い値で他の段を縛らない）。
  it('列を組まなければ自分の範囲は null', () => {
    composite.mockReturnValue(null)
    overlay.mockReturnValue(null)
    expect(runShared([{ kind: 'composite' }], false, null).ownScale).toBeNull()
  })
})

describe('SharedLaneScales', () => {
  // 正: 全員の最大を、3 成分と合成で別々に取る。
  it('3 成分と合成の最大を別々に取る', () => {
    const s = new SharedLaneScales()
    s.publish('a', { signed: 10, magnitude: 3, floor: 1 })
    s.publish('b', { signed: 2, magnitude: 30, floor: 2 })
    expect(s.shared()).toEqual({ signed: 10, magnitude: 30, floor: 2 })
  })

  // 対照: 誰も書いていなければ揃える相手はいない。
  it('誰も書いていなければ null', () => {
    expect(new SharedLaneScales().shared()).toBeNull()
  })

  // 安全弁: 外した段・null を書いた段は最大に残らない。数でない値は材料にしない。
  it('外した段と数でない値は最大に入れない', () => {
    const s = new SharedLaneScales()
    s.publish('a', { signed: 100, magnitude: 100, floor: 50 })
    s.publish('b', { signed: 5, magnitude: 6, floor: 1 })
    s.publish('c', { signed: Infinity, magnitude: NaN, floor: Infinity })
    s.remove('a')
    expect(s.shared()).toEqual({ signed: 5, magnitude: 6, floor: 1 })
    s.publish('b', null)
    expect(s.shared()).toBeNull()
  })

  // 正: 値が変わったら購読者へ知らせ、番号が進む（地震カードの段はこれで描き直す）。
  it('値が変わったら知らせる', () => {
    const s = new SharedLaneScales()
    const listener = vi.fn()
    s.subscribe(listener)
    s.publish('a', { signed: 1, magnitude: 2, floor: 0.5 })
    s.publish('a', { signed: 3, magnitude: 2, floor: 0.5 })
    s.remove('a')
    expect(listener).toHaveBeenCalledTimes(3)
    expect(s.version()).toBe(3)
  })

  // 対照: 同じ値を書き直しても・いない段を外しても知らせない（知らせると、描き直すたびに書き戻して往復する）。
  it('同じ値・いない段では知らせない', () => {
    const s = new SharedLaneScales()
    s.publish('a', { signed: 1, magnitude: 2, floor: 0.5 })
    const listener = vi.fn()
    const unsubscribe = s.subscribe(listener)
    s.publish('a', { signed: 1, magnitude: 2, floor: 0.5 })
    s.publish('b', null)
    s.remove('c')
    expect(listener).not.toHaveBeenCalled()
    // 安全弁: 購読をやめたら呼ばない。
    unsubscribe()
    s.publish('a', { signed: 9, magnitude: 2, floor: 0.5 })
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('sharedPaint', () => {
  // 正: 揃える段は相手の範囲まで広げ、曲線で描く。
  it('揃える段は広げて曲線で描く', () => {
    const p = sharedPaint(1, { shared: { signed: 50, magnitude: 80, floor: 2 } })
    expect(p.widen({ scaleGal: 5 }).scaleGal).toBe(50)
    expect(p.compositeMinScale).toBe(80)
    expect(p.vertical).not.toBe(LINEAR_VERTICAL)
    // 折れ目は全員の下限の最大（2）。
    expect(p.vertical(3, 50)).toBeCloseTo(compressedVertical(2)(3, 50))
  })

  // 対照: 揃えない段は線形で、範囲もそのまま。
  it('揃えない段は線形のまま', () => {
    const p = sharedPaint(1, null)
    expect(p.widen({ scaleGal: 5 }).scaleGal).toBe(5)
    expect(p.compositeMinScale).toBe(1)
    expect(p.vertical).toBe(LINEAR_VERTICAL)
  })

  // 安全弁: 相手の範囲が狭くても狭めない。相手がまだいなくても曲線で描く（揃った瞬間に絵が跳ねない）。
  it('狭めない・相手がいなくても曲線', () => {
    const narrower = sharedPaint(1, { shared: { signed: 2, magnitude: 0.5, floor: 0.1 } })
    expect(narrower.widen({ scaleGal: 5 }).scaleGal).toBe(5)
    expect(narrower.compositeMinScale).toBe(1)
    const alone = sharedPaint(1, { shared: null })
    expect(alone.vertical).not.toBe(LINEAR_VERTICAL)
    expect(alone.vertical(0.5, 10)).toBeCloseTo(compressedVertical(1)(0.5, 10))
  })
})

// 縦の圧縮（2026-10-19 ユーザー選択「縦を圧縮する (Recommended)」）。揃える段（公開観測点）だけ曲線で描く。
describe('drawLanes の縦の圧縮', () => {
  function runShared(lanes: readonly Lane[], shared: LaneScales | null) {
    const win = windowOf()
    return drawLanes({ targets: targetsFor(lanes), lanes, expanded: false, win, stale: false, quietLevel: 0.2, arrivals: [], timeline: timelineAtLastSample(win), unit: PUBLIC_WAVE_UNIT, sharing: { shared } })
  }

  // 正: 揃える段は曲線で描き、小さい値が線形より高く出る（遠い観測点が埋もれない）。
  it('揃える段は曲線で描く', () => {
    composite.mockReturnValue('0〜500 μm/s')
    runShared([{ kind: 'composite' }], { signed: 400, magnitude: 500, floor: 1 })
    const v = composite.mock.calls[0][4].vertical
    expect(v(5, 500)).toBeGreaterThan((5 / 500) * 10)
    expect(v(500, 500)).toBeCloseTo(1)
  })

  // 対照: 揃えない段（自作地震計）は線形のまま。
  it('揃えない段は線形', () => {
    composite.mockReturnValue('0〜1.00 gal')
    run([{ kind: 'composite' }], false)
    expect(composite.mock.calls[0][4].vertical).toBe(LINEAR_VERTICAL)
  })

  // 安全弁: 畳んだ合成が描けず 3 成分へ戻した絵も、揃えた範囲で描く（戻した先だけ観測点ごとの範囲にならない）。
  it('合成から 3 成分へ戻した絵も揃えた範囲で描く', () => {
    let signedScale = NaN
    composite.mockReturnValue(null)
    overlay.mockImplementation((_c, _z, b) => ((signedScale = b(50)?.scaleGal ?? NaN), '±400 μm/s'))
    runShared([{ kind: 'composite' }], { signed: 400, magnitude: 500, floor: 1 })
    expect(signedScale).toBe(400)
  })

  // 安全弁: 揃える相手がまだいなくても曲線で描く（最初の 1 回だけ線形になると、揃った瞬間に絵が跳ねる）。
  it('相手がまだいなくても曲線で描く', () => {
    composite.mockReturnValue('0〜1 μm/s')
    runShared([{ kind: 'composite' }], null)
    expect(composite.mock.calls[0][4].vertical).not.toBe(LINEAR_VERTICAL)
  })
})

describe('compressedVertical', () => {
  // 正: 端は 1、0 は 0、符号を保ち、大小の順も保つ。
  it('端・0・符号・順を保つ', () => {
    const v = compressedVertical(2)
    expect(v(100, 100)).toBeCloseTo(1)
    expect(v(0, 100)).toBe(0)
    expect(v(-100, 100)).toBeCloseTo(-1)
    expect(v(10, 100)).toBeLessThan(v(20, 100))
  })

  // 対照: 折れ目よりずっと小さい値ではほぼ線形（比が保たれる）。
  it('折れ目より小さい値はほぼ線形', () => {
    const v = compressedVertical(1000)
    expect(v(1, 2) / v(2, 2)).toBeCloseTo(0.5, 3)
  })

  // 安全弁: 折れ目が正の数でなければ線形へ戻す（0 で割ると全部の線が端へ張り付く）。
  it('折れ目が使えなければ線形', () => {
    expect(compressedVertical(0)).toBe(LINEAR_VERTICAL)
    expect(compressedVertical(Number.NaN)).toBe(LINEAR_VERTICAL)
  })
})
