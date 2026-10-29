// @vitest-environment jsdom
//
// useKyoshinDetectorV2 の「結線」のテスト。検知そのものは組み合わせの検知器のテスト
// （kyoshinEnsembleDetector.test.ts ほか）で見ているため、ここでは束ね役を偽物に差し替え、
// React ラッパーが持つ守りだけを見る:
//   1. Worker が無い環境では主スレッドへ倒れ、結果は区切りの後に（非同期で）届く
//   2. 慢性ノイズ床を観測点の並びで返し、どの観測点配列で計算したかを添える
//   3. 結果を出せないフレームが続いたら、凍結した結果を表示へ流し続けない
//   4. 時間軸が変わったら旧い軸の検知を引き継がない
//   5. 助走・抜けた区間の取り直しが届くまで通常フレームを待たせ、上限で諦める
// どれも「静かに劣化する」タイプの問題で、検知器の単体テストでは捉えられない。
//
// 主スレッドの係は `setTimeout(0)` で区切って動くので、偽のタイマーを `act()` の中で進めて結果を受け取る。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { muteConsoleError } from '../test-utils/muteConsoleError'
import { renderHook, cleanup, act } from '@testing-library/react'
import { siteSignature, RESULT_STALL_RESET_FRAMES, WARMUP_WAIT_MAX_FRAMES, useKyoshinDetectorV2 } from './useKyoshinDetectorV2'
import type { KyoshinBackfill, KyoshinWarmup } from './useKyoshinRealtime'
import { MAX_DT_GAP_MS, MAX_RESUME_GAP_MS } from '../utils/kyoshinNoiseFloor'
import * as noiseFloor from '../utils/kyoshinNoiseFloor'
import type { EnsembleReport } from '../utils/kyoshinEnsembleDetector'
import type { SiteCoords } from '../services/kyoshin'
import { log } from '../utils/logger'

/**
 * 束ね役の偽物。作られた回数（＝係が作り直された回数）・食わされた時刻を数え、返す報告と例外をテストが決める。
 * 本物は観測点 3 点では何も出さないので、検知が出ている状態を作るのに要る。
 */
const fake = vi.hoisted(() => ({
  created: 0,
  pushed: [] as number[],
  report: null as null | ((ms: number, instance: number) => EnsembleReport[]),
  throwAt: null as null | ((ms: number) => boolean),
}))

vi.mock('../utils/kyoshinEnsembleDetector', async (orig) => {
  const actual = await orig<typeof import('../utils/kyoshinEnsembleDetector')>()
  return {
    ...actual,
    createEnsembleDetector: () => {
      const instance = ++fake.created
      return {
        push(f: { ms: number }) {
          fake.pushed.push(f.ms)
          if (fake.throwAt?.(f.ms)) throw new Error('束ね役が壊れた')
          return fake.report?.(f.ms, instance) ?? []
        },
        setTables() {},
      }
    },
  }
})

// 平常のゆらぎの表は取りに行かない（取得と、それを受けて立つ学び直しの係はこのテストの対象外）
vi.mock('../utils/kyoshinQuietTablesLoader', async (orig) => {
  const actual = await orig<typeof import('../utils/kyoshinQuietTablesLoader')>()
  return {
    ...actual,
    getKyoshinQuietTables: () => actual.FALLBACK_QUIET_TABLES,
    loadKyoshinQuietTables: () => Promise.resolve(actual.FALLBACK_QUIET_TABLES),
    onKyoshinQuietTablesLoaded: () => () => {},
  }
})

/** この一連のテストで使う供給の識別子。 */
const SUPPLY_KEY = 'test-supply'
/**
 * 「助走は無い」ことを伝える値。
 *
 * フックは助走が届くまで通常フレームを待たせるので、渡さないと何も食わせない。
 * 助走そのものの振る舞いは下の「助走」の describe で見る。
 */
const NO_WARMUP: KyoshinWarmup = { supplyKey: SUPPLY_KEY, frames: [] }

const SITES: SiteCoords = [[35.0, 139.0], [35.1, 139.1], [35.2, 139.2]]
const SHAKE = [12, 12, 12]
const START_MS = Date.UTC(2026, 0, 1, 0, 0, 0)
const at = (offsetSec: number): string => new Date(START_MS + offsetSec * 1000).toISOString()

/** 束ね役が毎秒「この束は確かな段」と報告する（`instance` は係が作り直された回数。束の id に入れる） */
function reportConfirmed(ms: number, instance: number): EnsembleReport[] {
  return [{ id: `r${instance}`, tier: 'confirmed', lat: 35, lng: 139, startMs: ms, sites: [0, 1, 2], sources: ['stat'] }]
}

interface Props {
  sites: SiteCoords
  v: number[]
  t: string
  sCfg: string | null
  iCfg: string | null
  k: string
  w: KyoshinWarmup | null
  b: KyoshinBackfill | null
}

/** フックを描く。指定しない引数は「同じ版の 3 点・助走なし・取り直しなし」 */
function mount(initial: Partial<Props> = {}) {
  const base: Props = { sites: SITES, v: SHAKE, t: at(0), sCfg: 'cfg', iCfg: 'cfg', k: SUPPLY_KEY, w: NO_WARMUP, b: null, ...initial }
  const view = renderHook(
    (p: Props) => useKyoshinDetectorV2(p.sites, p.v, p.t, p.sCfg, p.iCfg, true, p.k, p.w, p.b),
    { initialProps: base },
  )
  let cur = base
  return {
    result: view.result,
    rerender(next: Partial<Props>) {
      cur = { ...cur, ...next }
      view.rerender(cur)
    },
  }
}

/** 主スレッドの係が予約した区切りをすべて走らせる（結果は区切りの中で届く） */
function flush() {
  act(() => {
    vi.runAllTimers()
  })
}

/** 慢性ノイズ床の係へ食わせたデータ時刻の並び */
function floorTimes(spy: { mock: { calls: unknown[][] } }): number[] {
  return spy.mock.calls.map((c) => c[1] as number)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  localStorage.clear()
  fake.created = 0
  fake.pushed = []
  fake.report = null
  fake.throwAt = null
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('siteSignature: 観測点集合の変化を取りこぼさない', () => {
  it('点数・先頭・末尾が同じでも、中間が差し替わればシグネチャが変わる', () => {
    // 以前は「点数＋先頭・末尾座標」だけで判定していたため、この差し替えを検知できなかった。
    // 検知できないと古い観測点キーを使い続け、表示側が毎回作り直すキーとずれる
    // （座標が重複する観測点で `#2` の割り当て順が変わりうる）。
    const before: SiteCoords = [[35.0, 139.0], [36.0, 140.0], [37.0, 141.0]]
    const after: SiteCoords = [[35.0, 139.0], [36.5, 140.5], [37.0, 141.0]]
    expect(siteSignature(before)).not.toBe(siteSignature(after))
  })

  it('同じ内容なら別配列でも同じシグネチャ（無駄なキーの作り直しを避ける）', () => {
    const a: SiteCoords = [[35.0, 139.0], [36.0, 140.0]]
    const b: SiteCoords = [[35.0, 139.0], [36.0, 140.0]]
    expect(siteSignature(a)).toBe(siteSignature(b))
  })

  it('空配列は空文字', () => {
    expect(siteSignature([])).toBe('')
  })

  it('座標の丸め単位（約100m）より細かい違いは同一とみなす', () => {
    // siteKey は小数第3位で丸める。sitelist 更新時の丸め誤差で別集合と誤判定しないため。
    const a: SiteCoords = [[35.00001, 139.00001]]
    const b: SiteCoords = [[35.00002, 139.00002]]
    expect(siteSignature(a)).toBe(siteSignature(b))
  })

  it('座標が重複する点の位置が動けばシグネチャが変わる（#2 の割り当てが変わるため）', () => {
    const adjacent: SiteCoords = [[35.0, 139.0], [35.0, 139.0], [36.0, 140.0]]
    const apart: SiteCoords = [[35.0, 139.0], [36.0, 140.0], [35.0, 139.0]]
    expect(siteSignature(adjacent)).not.toBe(siteSignature(apart))
  })
})

describe('useKyoshinDetectorV2: Worker が無い環境では主スレッドで動かす', () => {
  it('正: Worker を作れなければ主スレッドへ倒れたことを記録し、検知器へフレームを食わせる', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    mount()
    flush()
    expect(warn.mock.calls.some((c) => String(c[0]).includes('主スレッドで区切って動かします'))).toBe(true)
    expect(fake.pushed).toEqual([START_MS])
  })

  it('正: 結果は区切りを走らせた後に届く（データ時刻は処理したフレームのもの）', () => {
    fake.report = reportConfirmed
    const { result } = mount()
    flush()
    expect(result.current.dataTime).toBe(at(0))
    expect(result.current.detections.map((d) => d.id)).toEqual(['r1'])
    expect(result.current.detections[0].confidence).toBe('confirmed')
  })

  it('対照: 区切りを走らせる前は結果が届いていない（同じレンダーの中では処理しない）', () => {
    fake.report = reportConfirmed
    const { result } = mount()
    expect(result.current.dataTime).toBe('')
    expect(result.current.detections).toEqual([])
    expect(fake.pushed).toEqual([])
  })
})

describe('useKyoshinDetectorV2: 床は観測点の並びで返す', () => {
  const DUP: [number, number] = [35.0, 139.0]
  // 先頭 2 点が同一座標。同じ座標に複数の実観測点が載る Yahoo の観測点リストを模す。
  const sites: SiteCoords = [DUP, DUP, [36.0, 140.0]]
  // 先頭だけ強く揺れている状態（index12 = value 3.0）。2 点目・3 点目は静穏（index2 = value -2.0）。
  const indices = [12, 2, 2]

  function driveFloors(count: number, values: number[] = indices) {
    const view = mount({ sites, v: values })
    for (let i = 1; i < count; i++) view.rerender({ t: at(i) })
    flush()
    return view.result
  }

  it('観測点と同じ長さの配列を返す', () => {
    expect(driveFloors(2).current.floors).toHaveLength(sites.length)
  })

  it('同一座標の 2 点がそれぞれの床を持つ（先頭の床で上書きされない）', () => {
    const floors = driveFloors(3).current.floors
    expect(floors[0]).not.toBe(floors[1])
  })

  it('床は自分の観測値から作られる（隣の実体の値を拾わない）', () => {
    const floors = driveFloors(3).current.floors
    // 静穏な 2 点目・3 点目は同じ入力なので同じ床になる。揺れている先頭だけが離れる。
    expect(floors[1]).toBe(floors[2])
    expect(floors[0]).toBeGreaterThan(floors[1])
  })

  // 途絶明けと作り直しの両方で、欠測している点の学習済みの床が残ることを固定する（設計書§37）
  it.each([
    ['途絶明け（作り直さない飛び）', MAX_DT_GAP_MS + 1000],
    ['作り直す飛び', MAX_RESUME_GAP_MS + 1000],
  ])('大きな時刻の飛びの直後に欠測している点も、学習済みの床を保つ（%s）', (_label, gapMs) => {
    const view = mount({ sites, v: indices })
    flush()
    const before = view.result.current.floors[2]
    expect(before).not.toBe(0)
    // 時刻を大きく飛ばし、その回で 3 点目だけ欠測させる
    view.rerender({ t: new Date(START_MS + gapMs).toISOString(), v: [12, 2, -1] })
    flush()
    expect(view.result.current.dataTime).toBe(new Date(START_MS + gapMs).toISOString())
    expect(view.result.current.floors[2]).toBe(before)
    expect(view.result.current.floors[1]).not.toBe(0)
  })

  it('一度も観測できていない欠測点の床は 0（学習前は表示しない側へ倒れる）', () => {
    const floors = driveFloors(3, [12, 2, -1]).current.floors
    expect(floors).toHaveLength(sites.length)
    expect(floors[2]).toBe(0)
    // 観測できている点は 0 埋めされない（欠測の扱いが全点へ波及していないこと）
    expect(floors[1]).not.toBe(0)
  })

  it('floorsSites は床を計算した観測点配列と同一参照（位置対応が有効かの判定に使う）', () => {
    expect(driveFloors(2).current.floorsSites).toBe(sites)
  })
})

// 観測点リストが差し替わってから床が追いつくまでの窓。ここを取り違えると、新しい観測点へ古い床を
// 当ててしまう（点数が偶然一致すると長さの検査では捕まらない）。呼び出し側はこの窓を `floorsSites`
// の参照比較で見分ける。
describe('useKyoshinDetectorV2: 床が追いつくまでは古い観測点配列を指す', () => {
  const a: SiteCoords = [[35.0, 139.0], [35.1, 139.1], [35.2, 139.2]]
  const b: SiteCoords = [[36.0, 140.0], [36.1, 140.1], [36.2, 140.2]] // 同じ点数・別の観測点

  it('データ時刻が進むまで floorsSites は差し替え前の配列のまま', () => {
    const view = mount({ sites: a })
    flush()
    expect(view.result.current.floorsSites).toBe(a)

    // 観測点だけ差し替える（床はデータ時刻の更新でしか学ばないため据え置かれる）
    view.rerender({ sites: b })
    flush()
    expect(view.result.current.floorsSites).toBe(a)

    // 次のデータ時刻で追いつく
    view.rerender({ sites: b, t: at(1) })
    flush()
    expect(view.result.current.floorsSites).toBe(b)
  })
})

describe('useKyoshinDetectorV2: 検知器が例外を投げ続けたら検知結果を空にする', () => {
  beforeEach(() => {
    muteConsoleError()
  })

  it('正: 例外が閾値の回数続いたら detections を空にし、stalled で伝える', () => {
    fake.report = reportConfirmed
    const view = mount()
    flush()
    expect(view.result.current.detections).toHaveLength(1)
    fake.throwAt = () => true
    for (let i = 1; i <= RESULT_STALL_RESET_FRAMES; i++) view.rerender({ t: at(i) })
    flush()
    expect(view.result.current.detections).toEqual([])
    expect(view.result.current.recentOnsetKeys.size).toBe(0)
    // 「判らなくなった」ことを伝える（発報側が復帰で鳴らし直さないために要る）
    expect(view.result.current.stalled).toBe(true)
  })

  it('対照: 閾値に達する前の一過性の例外では直前の結果を保持する（明滅させない）', () => {
    fake.report = reportConfirmed
    const view = mount()
    flush()
    fake.throwAt = () => true
    for (let i = 1; i < RESULT_STALL_RESET_FRAMES; i++) view.rerender({ t: at(i) })
    flush()
    expect(view.result.current.dataTime).toBe(at(0))
    expect(view.result.current.detections).toHaveLength(1)
    expect(view.result.current.stalled).toBe(false)
  })

  it('安全弁: 検知器の例外では床を残す（床の係は主スレッドで学び続けていて、観測点との対応も保っている）', () => {
    const view = mount()
    flush()
    fake.throwAt = () => true
    for (let i = 1; i <= RESULT_STALL_RESET_FRAMES; i++) view.rerender({ t: at(i) })
    flush()
    expect(view.result.current.stalled).toBe(true)
    expect(view.result.current.floors).toHaveLength(SITES.length)
    expect(view.result.current.floorsSites).toBe(SITES)
  })

  it('安全弁: 例外が止まって結果が届けば数え直す（1 回成功を挟めば閾値まで数えない）', () => {
    fake.report = reportConfirmed
    const view = mount()
    flush()
    // 閾値-1 回失敗 → 1 回成功 → 閾値-1 回失敗
    const fail = new Set<number>()
    for (let i = 1; i < RESULT_STALL_RESET_FRAMES; i++) fail.add(START_MS + i * 1000)
    for (let i = RESULT_STALL_RESET_FRAMES + 1; i < RESULT_STALL_RESET_FRAMES * 2; i++) fail.add(START_MS + i * 1000)
    fake.throwAt = (ms) => fail.has(ms)
    for (let i = 1; i < RESULT_STALL_RESET_FRAMES * 2; i++) view.rerender({ t: at(i) })
    flush()
    expect(view.result.current.stalled).toBe(false)
    expect(view.result.current.dataTime).toBe(at(RESULT_STALL_RESET_FRAMES))
  })
})

// 観測点数と震度の件数が食い違うと検知器へ入れず、揺れ検知が丸ごと止まる。例外ではないので
// 記録しないと平常時と見分けがつかない。
describe('useKyoshinDetectorV2: 観測点数と震度の件数が食い違うとき', () => {
  beforeEach(() => {
    muteConsoleError()
  })

  function drive(values: number[], sCfg = 'cfg', iCfg = 'cfg', frames = 1) {
    const view = mount({ v: values, sCfg, iCfg })
    for (let i = 1; i < frames; i++) view.rerender({ t: at(i) })
    return view
  }

  it('記録に残す（検知が止まったことに気づけるように）', () => {
    drive([12, 12]) // 観測点は 3 点
    expect(console.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('食い違う'),
    )
  })

  it('件数が揃っていれば記録しない', () => {
    drive([12, 12, 12])
    flush()
    expect(console.error).not.toHaveBeenCalled()
  })

  it('siteConfigId が揃っていない間は記録しない（切替中は件数が違って当たり前）', () => {
    drive([12, 12], 'old', 'new')
    expect(console.error).not.toHaveBeenCalled()
  })

  it('食い違いが続いても間引く（毎フレーム出さない）', () => {
    // 閾値に達すると「結果を空にする」側の記録が別に 1 本出るため、そこへ届かない回数で見る。
    drive([12, 12], 'cfg', 'cfg', RESULT_STALL_RESET_FRAMES - 1)
    expect(console.error).toHaveBeenCalledTimes(1)
  })

  /** 正常フレームで結果を持たせてから、件数の食い違いを指定回数続ける。 */
  function stallAfterNormalFrame(mismatchFrames: number) {
    fake.report = reportConfirmed
    const view = mount()
    flush()
    expect(view.result.current.detections).toHaveLength(1)
    for (let i = 1; i <= mismatchFrames; i++) view.rerender({ t: at(i), v: [12, 12] })
    flush()
    return view.result
  }

  it('正: 食い違いが続いたら検知結果を空にする（凍結したまま音や地図へ流さない）', () => {
    const result = stallAfterNormalFrame(RESULT_STALL_RESET_FRAMES)
    expect(result.current.dataTime).toBe('')
    expect(result.current.detections).toEqual([])
    expect(result.current.floors).toEqual([])
  })

  it('正: 空にしたことを stalled で伝える（発報側が「揺れが収まった」と区別するために要る）', () => {
    expect(stallAfterNormalFrame(RESULT_STALL_RESET_FRAMES).current.stalled).toBe(true)
  })

  it('対照: 閾値に達する前は直前の結果を保持する（一過性で明滅させない）', () => {
    const result = stallAfterNormalFrame(RESULT_STALL_RESET_FRAMES - 1)
    expect(result.current.dataTime).toBe(at(0))
    expect(result.current.stalled).toBe(false)
  })

  it('安全弁: 例外と食い違いが混ざっても合算で数える（片方だけでは閾値に届かない場合）', () => {
    // 理由ごとにカウンタを分けると、交互に起きたときいつまでも凍結が解けない。
    fake.report = reportConfirmed
    const view = mount()
    flush()
    // 検知器の例外を 2 回（件数は揃えて検知器まで通す）
    fake.throwAt = (ms) => ms > START_MS
    view.rerender({ t: at(1) })
    view.rerender({ t: at(2) })
    flush()
    expect(view.result.current.dataTime).toBe(at(0))
    // 続けて件数の食い違いを 3 回。合算で閾値に達する
    for (let i = 3; i <= 5; i++) view.rerender({ t: at(i), v: [12, 12] })
    expect(view.result.current.dataTime).toBe('')
    expect(view.result.current.stalled).toBe(true)
  })
})

// 供給の作り直し（リプレイの時間軸の切替・ローカルアーカイブの出入り）は、`useKyoshinRealtime` が
// 震度とデータ時刻を空にする形で届く。その空を受けても結果が凍結すると、旧い時間軸の検知が
// 新しい軸の画面・音・行動チェックリストへ流れ続ける。
describe('useKyoshinDetectorV2: 供給が作り直されたら結果を空にする', () => {
  /** フレームを何回か進めてから結果を受け取っておく。 */
  function drive(frames = 3) {
    const view = mount()
    for (let i = 1; i < frames; i++) view.rerender({ t: at(i) })
    flush()
    return view
  }

  it('正: データ時刻が空になったら検知結果・床をその場で空にする', () => {
    fake.report = reportConfirmed
    const view = drive()
    expect(view.result.current.detections).toHaveLength(1)
    expect(view.result.current.floors.length).toBeGreaterThan(0)

    view.rerender({ t: '', v: [] })
    // 区切りを待たずに空になる（旧い軸の結果を 1 レンダーも残さない）
    expect(view.result.current.detections).toEqual([])
    expect(view.result.current.recentOnsetKeys.size).toBe(0)
    expect(view.result.current.dataTime).toBe('')
    expect(view.result.current.floors).toEqual([])
    expect(view.result.current.floorsSites).toEqual([])
  })

  it('安全弁: stalled は立てない（上流の異常ではなく、こちらから作り直したため）', () => {
    // stalled は「結果を出せなくなった」ことを伝える語で、下流の振る舞いが変わる。行動
    // チェックリストは表示中の帯を地震情報へ差し替えるのをやめ（useActionChecklist）、
    // 発報側は次の検知を「同じ揺れの再開」と見なして検知音とブラウザ通知を省く
    // （useKyoshinAlerts）。どちらも時間軸の切替では起きてほしくない。
    const view = drive()
    view.rerender({ t: '', v: [] })
    expect(view.result.current.stalled).toBe(false)
  })

  it('安全弁: 学習資産は捨てない（次のフレームで床が戻る）', () => {
    const view = drive()
    const floorBefore = view.result.current.floors[1]
    expect(floorBefore).not.toBe(0)

    view.rerender({ t: '', v: [] })
    expect(view.result.current.floors).toEqual([])

    // 新しい時間軸の最初のフレーム。床を学び直すのではなく、持っていた値がそのまま出ること
    view.rerender({ t: at(60), v: SHAKE })
    flush()
    expect(view.result.current.floors[1]).toBe(floorBefore)
  })

  it('対照: まだ 1 フレームも来ていない間は何もしない（初回マウントと区別する）', () => {
    const spy = vi.spyOn(noiseFloor, 'stepNoiseFloor')
    const view = mount({ t: '', v: [] })
    view.rerender({ t: '', v: [] })
    flush()
    expect(view.result.current.detections).toEqual([])
    expect(view.result.current.stalled).toBe(false)
    expect(spy).not.toHaveBeenCalled()
    expect(fake.pushed).toEqual([])
  })

  // 時間軸の切替は、フレームの間隔からは見分けられない（数秒だけ先へ飛ぶ切替は普通の続きに見える）。
  // 検知器は切替の合図で作り直す（設計書§37）
  it('正: 切替の直後に数秒しか進まない新しい軸でも、旧い軸の検知を引き継がない', () => {
    fake.report = reportConfirmed
    const view = drive()
    expect(view.result.current.detections.map((d) => d.id)).toEqual(['r1'])

    view.rerender({ t: '', v: [] })
    view.rerender({ t: at(4), v: SHAKE })
    flush()
    // 検知器を作り直したので、旧い束（r1）は残っていない
    expect(view.result.current.detections.map((d) => d.id)).toEqual(['r2'])
  })

  it('対照: 切替を挟まなければ、同じ 2 秒先のフレームで同じ束が続く', () => {
    fake.report = reportConfirmed
    const view = drive()
    view.rerender({ t: at(4) })
    flush()
    expect(view.result.current.detections.map((d) => d.id)).toEqual(['r1'])
    expect(fake.created).toBe(1)
  })

  it('対照: データ時刻が進んでいる間は空にしない', () => {
    const view = drive()
    view.rerender({ t: at(5) })
    flush()
    expect(view.result.current.dataTime).toBe(at(5))
    expect(view.result.current.floors.length).toBeGreaterThan(0)
  })
})

describe('useKyoshinDetectorV2: 助走', () => {
  /** 助走フレームを作る（開始時刻の `sec` 秒前から 1 秒刻み）。 */
  function warmupFrames(sec: number, sitesKey = 'cfg'): KyoshinWarmup {
    const frames = []
    for (let i = sec; i >= 1; i--) {
      const t = new Date(START_MS - i * 1000)
      frames.push({ time: t, dataTime: t.toISOString(), sitesKey, indices: SHAKE })
    }
    return { supplyKey: SUPPLY_KEY, frames }
  }

  it('正: 助走が届いたら、開始より前のフレームを先に食わせてから今のフレームを処理する', () => {
    const spy = vi.spyOn(noiseFloor, 'stepNoiseFloor')
    mount({ w: warmupFrames(3) })
    flush()
    const expected = [START_MS - 3000, START_MS - 2000, START_MS - 1000, START_MS]
    // 床の係と検知器の両方へ、同じ順で食わせる
    expect(floorTimes(spy)).toEqual(expected)
    expect(fake.pushed).toEqual(expected)
  })

  it('対照: 助走が届くまでは通常フレームを食わせない（先に食わせると助走が巻き戻りになる）', () => {
    const spy = vi.spyOn(noiseFloor, 'stepNoiseFloor')
    const view = mount({ w: null })
    view.rerender({ t: at(1) })
    view.rerender({ t: at(2) })
    flush()
    expect(spy).not.toHaveBeenCalled()
    expect(fake.pushed).toEqual([])
  })

  it('正: 待たせていたフレームは、助走のあとに時刻の順で食わせる', () => {
    const spy = vi.spyOn(noiseFloor, 'stepNoiseFloor')
    const view = mount({ w: null })
    view.rerender({ t: at(1) })
    view.rerender({ t: at(2), w: warmupFrames(2) })
    flush()
    const expected = [START_MS - 2000, START_MS - 1000, START_MS, START_MS + 1000, START_MS + 2000]
    expect(floorTimes(spy)).toEqual(expected)
    expect(fake.pushed).toEqual(expected)
  })

  it('安全弁: 助走が届かないまま上限に達したら、助走なしで検知を始める', () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    const spy = vi.spyOn(noiseFloor, 'stepNoiseFloor')
    const view = mount({ w: null })
    for (let i = 1; i < WARMUP_WAIT_MAX_FRAMES - 1; i++) view.rerender({ t: at(i) })
    flush()
    // 上限の 1 フレーム手前ではまだ待っている
    expect(spy).not.toHaveBeenCalled()
    view.rerender({ t: at(WARMUP_WAIT_MAX_FRAMES - 1) })
    flush()
    // 上限に達したフレームで、溜めていた分がまとめて流れる
    expect(spy).toHaveBeenCalledTimes(WARMUP_WAIT_MAX_FRAMES)
    expect(floorTimes(spy)[0]).toBe(START_MS)
    expect(fake.pushed).toHaveLength(WARMUP_WAIT_MAX_FRAMES)
  })

  it('安全弁: 助走と重なる時刻を 2 度食わせない（同じ時刻は不連続として状態を作り直す）', () => {
    const spy = vi.spyOn(noiseFloor, 'stepNoiseFloor')
    // 助走の末尾が「今のフレーム」と同じ時刻になっている場合
    const w = warmupFrames(2)
    w.frames.push({ time: new Date(START_MS), dataTime: at(0), sitesKey: 'cfg', indices: SHAKE })
    mount({ w })
    flush()
    const expected = [START_MS - 2000, START_MS - 1000, START_MS]
    expect(floorTimes(spy)).toEqual(expected)
    expect(fake.pushed).toEqual(expected)
  })

  /** 結果を画面へ出した秒（出した秒にだけ確かな段の記録が出る） */
  function publishedTimes(debug: { mock: { calls: unknown[][] } }): string[] {
    return debug.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.startsWith('[kyoshinV2] confirmed='))
      .map((m) => m.slice(m.indexOf('@') + 1))
  }

  it('正: 助走のフレームの結果は画面へ出さない（直前の揺れの音・通知を起動のたびに繰り返さない）', () => {
    const debug = vi.spyOn(log, 'debug').mockImplementation(() => {})
    fake.report = reportConfirmed
    mount({ w: warmupFrames(3) })
    flush()
    // 検知器へは助走も食わせる
    expect(fake.pushed).toEqual([START_MS - 3000, START_MS - 2000, START_MS - 1000, START_MS])
    // 画面へ出したのは今のフレームだけ
    expect(publishedTimes(debug)).toEqual([at(0)])
  })

  it('対照: 助走の無いフレームは 1 秒ごとに結果を画面へ出す', () => {
    const debug = vi.spyOn(log, 'debug').mockImplementation(() => {})
    fake.report = reportConfirmed
    const view = mount()
    flush()
    view.rerender({ t: at(1) })
    flush()
    expect(publishedTimes(debug)).toEqual([at(0), at(1)])
  })

  it('安全弁: 待たせていた分は最後の 1 件（今届いたフレーム）だけ画面へ出す', () => {
    const debug = vi.spyOn(log, 'debug').mockImplementation(() => {})
    fake.report = reportConfirmed
    const view = mount({ w: null })
    view.rerender({ t: at(1) })
    view.rerender({ t: at(2), w: warmupFrames(2) })
    flush()
    expect(fake.pushed).toEqual([START_MS - 2000, START_MS - 1000, START_MS, START_MS + 1000, START_MS + 2000])
    expect(publishedTimes(debug)).toEqual([at(2)])
  })

  it('安全弁: 観測点リストの版が違う助走フレームは使わない', () => {
    const spy = vi.spyOn(noiseFloor, 'stepNoiseFloor')
    mount({ w: warmupFrames(3, 'other-cfg') })
    flush()
    expect(floorTimes(spy)).toEqual([START_MS])
    expect(fake.pushed).toEqual([START_MS])
  })

  describe('抜けた区間の取り直し（#986・#1183）', () => {
    /** 開始の `fromSec`〜`toSec` 秒後（含まない）を 1 秒刻みで。 */
    function holeFrames(fromSec: number, toSec: number) {
      const frames = []
      for (let s = fromSec; s < toSec; s++) frames.push({ time: new Date(START_MS + s * 1000), dataTime: at(s), sitesKey: 'cfg', indices: SHAKE })
      return frames
    }

    it('正: 取り直しが始まったら通常フレームを待たせ、穴のフレームを先に食わせる（検知器は作り直さない）', () => {
      const spy = vi.spyOn(noiseFloor, 'stepNoiseFloor')
      const view = mount()
      // 1〜9 秒後は全滅していて、10 秒後に戻った。戻った秒より先に `begin` が届く。
      view.rerender({ t: at(10), b: { supplyKey: SUPPLY_KEY, id: 1, frames: null } })
      view.rerender({ t: at(11) })
      flush()
      expect(floorTimes(spy)).toEqual([START_MS])
      view.rerender({ b: { supplyKey: SUPPLY_KEY, id: 1, frames: holeFrames(1, 10) } })
      flush()
      const expected = Array.from({ length: 12 }, (_, s) => START_MS + s * 1000)
      expect(floorTimes(spy)).toEqual(expected)
      expect(fake.pushed).toEqual(expected)
      expect(fake.created).toBe(1)
    })

    it('対照: 取り直しが無ければ待たない', () => {
      const spy = vi.spyOn(noiseFloor, 'stepNoiseFloor')
      const view = mount()
      view.rerender({ t: at(10) })
      flush()
      expect(floorTimes(spy)).toEqual([START_MS, START_MS + 10_000])
    })

    it('安全弁: 助走を待っている間に始まった取り直しは使わない（助走が穴の手前の履歴を作るので、穴は巻き戻りになる）', () => {
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
      const spy = vi.spyOn(noiseFloor, 'stepNoiseFloor')
      const view = mount({ w: null })
      const begin = { supplyKey: SUPPLY_KEY, id: 1, frames: null }
      view.rerender({ t: at(1), b: begin })
      // 助走が届いたら、取り直しを待たずに進む
      view.rerender({ t: at(2), w: warmupFrames(2) })
      expect(floorTimes(spy)).toEqual([START_MS - 2000, START_MS - 1000, START_MS, START_MS + 1000, START_MS + 2000])
      // 後から穴のフレームが届いても食わせない
      view.rerender({ t: at(3), b: { supplyKey: SUPPLY_KEY, id: 1, frames: [] } })
      expect(floorTimes(spy)).toEqual([START_MS - 2000, START_MS - 1000, START_MS, START_MS + 1000, START_MS + 2000, START_MS + 3000])
      expect(warn.mock.calls.some((c) => String(c[0]).includes('助走を待っている間に抜けた区間の取り直しが始まった'))).toBe(true)
    })

    it('安全弁: 穴のフレームが届かないまま上限に達したら、穴のまま進む（同じ番号で待ち直さない）', () => {
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
      const spy = vi.spyOn(noiseFloor, 'stepNoiseFloor')
      const view = mount()
      const begin = { supplyKey: SUPPLY_KEY, id: 1, frames: null }
      for (let i = 10; i < 10 + WARMUP_WAIT_MAX_FRAMES; i++) view.rerender({ t: at(i), b: begin })
      expect(spy).toHaveBeenCalledTimes(1 + WARMUP_WAIT_MAX_FRAMES)
      view.rerender({ t: at(10 + WARMUP_WAIT_MAX_FRAMES) })
      expect(spy).toHaveBeenCalledTimes(2 + WARMUP_WAIT_MAX_FRAMES)
      // 諦めた後に届いた穴のフレームは食わせず、使わなかったことを 1 行だけ残す
      view.rerender({ t: at(11 + WARMUP_WAIT_MAX_FRAMES), b: { supplyKey: SUPPLY_KEY, id: 1, frames: holeFrames(1, 10) } })
      view.rerender({ t: at(12 + WARMUP_WAIT_MAX_FRAMES) })
      expect(spy).toHaveBeenCalledTimes(4 + WARMUP_WAIT_MAX_FRAMES)
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('待ちきれずに穴のまま進めた取り直しが後から届いた'))).toHaveLength(1)
    })
  })

  it('安全弁: 助走の消化で床の係が例外を投げても、今のフレームの検知は続ける', () => {
    muteConsoleError()
    const real = noiseFloor.stepNoiseFloor
    let calls = 0
    const spy = vi.spyOn(noiseFloor, 'stepNoiseFloor').mockImplementation((...args) => {
      calls++
      if (calls === 1) throw new Error('助走で壊れた')
      return real(...args)
    })
    const { result } = mount({ w: warmupFrames(3) })
    flush()
    expect(spy.mock.calls.length).toBeGreaterThan(1)
    expect(result.current.dataTime).toBe(at(0))
  })
})

describe('useKyoshinDetectorV2: 助走が遅れて届いたとき', () => {
  // 実運用では、通常フレームの取得（1 件）が助走の取得（最大 15 ブロック × 60 件）より速いので、
  // **データ時刻が変わらないまま助走だけが届くレンダー**が必ず起きる。
  function warmupFrames(sec: number): KyoshinWarmup {
    const frames = []
    for (let i = sec; i >= 1; i--) {
      const t = new Date(START_MS - i * 1000)
      frames.push({ time: t, dataTime: t.toISOString(), sitesKey: 'cfg', indices: SHAKE })
    }
    return { supplyKey: SUPPLY_KEY, frames }
  }

  it('正: 助走だけが届いたレンダーでも、待たせていた最後のフレームの検知結果を画面へ出す', () => {
    const view = mount({ w: null })
    flush()
    // 助走が来ないので待たせている
    expect(view.result.current.dataTime).toBe('')

    // データ時刻は変わらないまま助走だけが届く
    view.rerender({ w: warmupFrames(3) })
    flush()

    // 待たせていたフレームがそのまま結果になること。ここが空のままだと、次のフレームが
    // 届くまで（ライブなら約 1 秒）画面・音・自動タブ切替に何も流れない。
    expect(view.result.current.dataTime).toBe(at(0))
    expect(view.result.current.floors.length).toBeGreaterThan(0)
  })

  it('対照: 同じデータ時刻で何度レンダーされても、その時刻を 2 度食わせない', () => {
    const spy = vi.spyOn(noiseFloor, 'stepNoiseFloor')
    const view = mount({ w: null })
    view.rerender({ w: null })
    view.rerender({ w: warmupFrames(2) })
    flush()
    const expected = [START_MS - 2000, START_MS - 1000, START_MS]
    expect(floorTimes(spy)).toEqual(expected)
    expect(fake.pushed).toEqual(expected)
  })
})

describe('useKyoshinDetectorV2: 助走を待つのは時間軸が変わったときだけ', () => {
  beforeEach(() => {
    muteConsoleError()
  })

  it('対照: 供給元だけが替わった（時間軸は続いている）ときは助走を待たない', () => {
    // ローカル履歴アーカイブの収録範囲を再生中に跨ぐと供給元だけが替わる。そこで待ちに
    // 入ると、検知器の状態は有効なのに結果が古い値で凍結する。
    const spy = vi.spyOn(noiseFloor, 'stepNoiseFloor')
    const view = mount()
    view.rerender({ t: at(1), k: 'other-supply' })
    flush()
    expect(floorTimes(spy)).toEqual([START_MS, START_MS + 1000])
  })

  it('正: 時間軸が変わったら（データ時刻が空に転じたら）また助走を待つ', () => {
    const spy = vi.spyOn(noiseFloor, 'stepNoiseFloor')
    const view = mount()
    // 供給が作り直された（リプレイの開始・停止）
    view.rerender({ t: '', v: [], w: null })
    spy.mockClear()
    // 新しい軸のフレームが届いても、助走が来るまでは食わせない
    view.rerender({ t: at(100), v: SHAKE })
    flush()
    expect(spy).not.toHaveBeenCalled()
  })

  it('安全弁: 待たせている間に観測点集合の版が替わったら、その分は食わせない', () => {
    // 版が違うフレームは座標と震度の対応が取れない。長さの検証では、点数がたまたま一致すれば通ってしまう。
    const spy = vi.spyOn(noiseFloor, 'stepNoiseFloor')
    const sitesB: SiteCoords = [[36.0, 140.0], [36.1, 140.1], [36.2, 140.2]]
    const view = mount({ sCfg: 'cfg-a', iCfg: 'cfg-a', w: null })
    view.rerender({ t: at(1), sites: sitesB, sCfg: 'cfg-b', iCfg: 'cfg-b' })
    view.rerender({ t: at(2), w: { supplyKey: SUPPLY_KEY, frames: [] } })
    flush()
    // 版 a のフレーム（時刻 0）は捨て、版 b の分だけを食わせる
    expect(floorTimes(spy)).toEqual([START_MS + 1000, START_MS + 2000])
    expect(fake.pushed).toEqual([START_MS + 1000, START_MS + 2000])
  })

  it('安全弁: 待たせていたフレームの消化で例外が出ても、外へ投げない', () => {
    // このフックは `App()` の中で呼ばれる。投げるとエフェクトごと未捕捉例外で抜け、
    // **根のエラー境界まで飛んで画面全体が落ちる**（地図も地震カードも設定も消える）。
    const real = noiseFloor.stepNoiseFloor
    let calls = 0
    vi.spyOn(noiseFloor, 'stepNoiseFloor').mockImplementation((...args) => {
      calls++
      // 助走の 1 件目だけ通し、待たせていた分（2 件目以降）で投げる
      if (calls >= 2) throw new Error('壊れた')
      return real(...args)
    })
    const view = mount({ w: null })
    expect(() => {
      view.rerender({ t: at(1) })
      view.rerender({
        t: at(2),
        w: { supplyKey: SUPPLY_KEY, frames: [{ time: new Date(START_MS - 1000), dataTime: at(-1), sitesKey: 'cfg', indices: SHAKE }] },
      })
      flush()
    }).not.toThrow()
  })
})
