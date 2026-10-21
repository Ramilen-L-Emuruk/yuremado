// @vitest-environment jsdom
//
// useEarthquakes の「再生中の結線」のテスト。
//
// このフックは WebSocket 接続・REST 履歴取得・イベントキュー・接続状態を一手に担うが、
// 全部を覆うのは現実的でないため、**画面を見ても気づけない結線**に絞る:
//
//   - `connectionStatus` がライブ受信の実態とずれないこと。再生中は WebSocket を意図的に
//     切るため、更新し忘れると直前の値（多くは 'connected'）が残り、受信していないのに
//     「接続中」と表示され続ける。型でも例外でも捕まらず、画面上は繋がって見える
//   - 再生中もキューの予約が発火時刻を待つこと。潰すと EEW が最終報の直後に自動解除され、
//     最低 60 秒の猶予が消える
//   - EEW 発報テストの報の推移が実運用と揃っていること。報番号・発表時刻が進まず、逆に
//     震源時刻が続報のたびに進んでしまう形は、画面上は「動いているように見える」ため
//     テストで固定しないと気づけない
//
// 差し替えるのは外部 I/O（WebSocket・REST・観測点座標）だけ。時計や純粋関数は本物を使う。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, cleanup, act } from '@testing-library/react'
import type { AppEvent, LiveEvent, LiveEventMeta, EEWAlert, JMAQuake, JMATsunami, JMANankai, JMANankaiCommentary, JMAQuakeNotice, JMAEarthquakeCount, JMAEstimatedIntensity, IntensityScale } from '../types/earthquake'
import type { ReplayEntry, ReplayPayload } from '../types/replay'
import type { JMAKohatsu } from '../types/earthquake'
import { serverDate, setReplayOffset } from '../utils/clock'
import {
  drainReplayEvents, __resetReplayEventLogForTest, type ReplayTelegramEvent,
} from '../utils/replayEventLog'
import { DMDATA_API_KEY_INVALID_MESSAGE } from '../utils/dmdataApiKey'
import { log } from '../utils/logger'
import { CELL_LAT_DEG, CELL_LON_DEG } from '../utils/bufrEstimatedIntensity'
import { ACTIVE_EEW_WINDOW_MS } from '../utils/eew'
// **テストボタンのデータをここで先に読む。** 値は使わないが、これが無いと
// `simulate*` を最初に呼ぶテストが「このファイルで初回のモジュール解決・変換」を
// テスト本体の中で行うことになる —— 実データ 3 つで 824 KB あり、全ファイル並列実行では
// 他ワーカーとの順番待ちで数秒に伸びて、既定の 5 秒に届かない。トップレベルへ置けば
// 待ちはファイル読み込み時へ移り `testTimeout` の対象から外れる
// （同じ手当ての先例は `services/akamaiClock.test.ts` 冒頭）。
//
// **アプリの分割には影響しない。** 分割を作っているのは `utils/testDataLoader.ts` の
// `import()` で、テストファイルは本番ビルドの依存グラフに入らない
// （`utils/testData.test.ts` も同じく静的に取り込んでいる）。
import '../utils/testData'

// isDmdss はモジュールスコープの定数。テストごとに切り替えるため getter で公開する。
let mockIsDmdss = true
vi.mock('../utils/env', () => ({
  get isDmdss() { return mockIsDmdss },
}))

// log だけを差し替え、それ以外（createLogThrottle 等）は実物を使う。全置換にすると
// logger に export が増えるたびに、無関係な import グラフの都合でこのテストが落ちる。
vi.mock('../utils/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/logger')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// 観測点座標は遅延読込の外部データ。接続状態の観察には不要なので空で即解決させる。
vi.mock('../utils/stationCoords', () => ({
  loadStationCoords: vi.fn(() => Promise.resolve({})),
  onStationCoordsLoaded: vi.fn(() => () => {}),
  areaPrefIndexOf: vi.fn(() => new Map()),
  // 点の役割の判定へ渡す索引（→ quakePoints.ts の isAreaPoint）。この配線テストは区域名の
  // 衝突を見ないので、座標テーブル未読み込みと同じ null を返す。
  getAreaPrefIndexCache: vi.fn(() => null),
}))

// WebSocket の代役。`new` で呼ばれるためクラスで用意する（アロー関数はコンストラクタになれない）。
// vi.mock のファクトリはファイル先頭へ巻き上げられるので、クラス定義も vi.hoisted で一緒に上げる。
const { sockets, FakeWebSocket, socketOptions } = vi.hoisted(() => {
  const sockets: {
    connected: boolean
    onStatusChange: ((s: string) => void) | null
    onEvent: ((e: unknown) => void) | null
    onReconnected: ((lastReceivedAtMs: number) => void) | null
    onClassifications: ((c: readonly string[]) => void) | null
    onClassificationsUnsettled: ((reason: 'auth' | 'timeout') => void) | null
    onStarted: ((info: { previousAliveAtMs: number | null }) => void) | null
  }[] = []
  /**
   * 次に作る代役の振る舞い。`holdClassifications` を立てると、最初の取り決めがいつまでも決まらない
   * （同時接続の上限で 409 が続く形）。テストごとに `beforeEach` で戻す。
   */
  const socketOptions = { holdClassifications: false }
  class FakeWebSocket {
    onEvent: ((e: unknown) => void) | null = null
    onStatusChange: ((s: string) => void) | null = null
    onRawMessage: ((e: unknown) => void) | null = null
    onReconnected: ((lastReceivedAtMs: number) => void) | null = null
    onClassifications: ((c: readonly string[]) => void) | null = null
    onClassificationsUnsettled: ((reason: 'auth' | 'timeout') => void) | null = null
    onStarted: ((info: { previousAliveAtMs: number | null }) => void) | null = null
    hasReceivedTelegram(_id: string): boolean { return false }
    // 本物は最初の取り決めが済んだ時点で解決する。ここでは全区分を受けている人として即座に返す
    readonly classificationsReady: Promise<readonly string[]> = socketOptions.holdClassifications
      ? new Promise<readonly string[]>(() => {})
      : Promise.resolve(['eew.forecast', 'telegram.earthquake'])
    connected = false
    constructor() { sockets.push(this) }
    connect() { this.connected = true }
    disconnect() { this.connected = false }
  }
  return { sockets, FakeWebSocket, socketOptions }
})

// 取得系はモック関数だけを置き、戻り値は下の beforeEach で `vi.mocked(...).mockResolvedValue(...)`
// で与える。**ファクトリ内でリテラルを書くと型検査が効かない**ため、そこを取り違えると初回履歴取得が
// TypeError で落ち、実装側の catch に飲まれて error state に入る（接続状態だけ見ていると緑のまま
// 通ってしまう）。`vi.mocked` 経由なら実関数の戻り値型で縛られるので、取り違えは型エラーになる。
/**
 * 履歴取得（`fetchDmdataQuakeHistory`）の戻り値を組み立てる。
 *
 * 地震・津波・帯・長周期が 1 本で返るので、テストは足したいものだけを渡す。
 */
function history(opts: {
  quakes?: JMAQuake[]
  tsunamis?: JMATsunami[]
  extras?: ReplayEntry[]
  hasMore?: boolean
  /** 取り込めなかった電文の通数（一部失敗の再現用）。 */
  skipped?: number
  /** 読めなかった取得元（同上）。 */
  failedArchiveUrls?: string[]
  /** 読み切った最古の JST 日（＝次のカーソル）。省略すると「1 件も読まなかった」。 */
  oldestLoadedDay?: string | null
} = {}) {
  return {
    quakes: opts.quakes ?? [],
    tsunamis: opts.tsunamis ?? [],
    extras: opts.extras ?? [],
    skippedByDay: skips(opts.skipped ?? 0),
    failedArchiveUrls: opts.failedArchiveUrls ?? ([] as string[]),
    rateLimitedSources: [] as string[],
    rateLimitedTelegrams: 0,
    hasMore: opts.hasMore ?? false,
    oldestLoadedDay: opts.oldestLoadedDay ?? null,
  }
}

/** 帯・長周期を `extras` の 1 件として包む。 */
function extra(payload: ReplayPayload): ReplayEntry {
  return { payload, replayTime: new Date('2026-01-01T00:00:00Z'), silent: true }
}

// **丸ごと差し替える（`importOriginal` を混ぜない）。** 実物を残すと、ここでモックし忘れた
// 関数がテスト中に本物の通信を始める。代償として `dmdata.ts` が export を増やすたびにこの
// 一覧へ足す必要があるが、**落ちて気づける**ぶん、黙って通信が走るより良い。
// 旧来の 1 件ずつ取る 8 本は撤去済みなので、残るのは受信の入口と発表中の緊急地震速報の復元だけ。
vi.mock('../services/dmdata', () => ({
  DmdataWebSocket: FakeWebSocket,
  // 戻り値を持たせるのは、呼び出し側が `.then` で受けるため（`vi.fn()` のままだと
  // `undefined.then` で落ちる）。
  fetchDmdataActiveEews: vi.fn(async () => []),
}))

// 履歴の取得はアーカイブ経由の 1 本へ寄せてある（→ `services/dmdataReplay.ts` の
// `fetchDmdataQuakeHistory`）。地震・津波・帯・長周期がまとめて返る。
// **こちらは `importOriginal` を混ぜる** —— `HISTORY_WINDOW_DAYS` 等の定数を実物から採るため。
// 通信するのは `fetchDmdataQuakeHistory` 1 本なので、それを差し替えれば漏れは出ない。
// フックが呼ぶのは区分の門（`fetchDmdataQuakeHistoryFor`）なので、門の先を差し替えたものへ流す
// （実物の門は同じモジュールの中の本物を直接呼ぶので、`fetchDmdataQuakeHistory` だけを差し替えても届かない）。
vi.mock('../services/dmdataReplay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/dmdataReplay')>()
  const fetchDmdataQuakeHistory = vi.fn<typeof actual.fetchDmdataQuakeHistory>()
  return {
    ...actual,
    fetchDmdataQuakeHistory,
    fetchDmdataQuakeHistoryFor: (
      _classifications: unknown, ...args: Parameters<typeof actual.fetchDmdataQuakeHistory>
    ) => fetchDmdataQuakeHistory(...args),
  }
})

// 張り直しの取り戻し（`fetchLiveTelegramsBetween`）だけを差し替える。ほかは実物（`dmdataReplay` が使う）
vi.mock('../services/dmdataReplayLive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/dmdataReplayLive')>()
  return { ...actual, fetchLiveTelegramsBetween: vi.fn<typeof actual.fetchLiveTelegramsBetween>() }
})

vi.mock('../services/p2pquake', () => ({
  P2PQuakeWebSocket: FakeWebSocket,
  fetchHistory: vi.fn(),
  fetchHistorySince: vi.fn(),
  fetchJmaQuake: vi.fn(),
}))

// 1 回の窓の幅は実装側の定数を正とする（テストへ数値を書き写すと、窓を動かしたときに
// テストだけが古い値のまま通ってしまう）。モックのファクトリで実物を展開しているので本物が来る。
const { fetchDmdataQuakeHistory, HISTORY_WINDOW_DAYS } = await import('../services/dmdataReplay')
const { fetchHistory, fetchHistorySince, fetchJmaQuake } = await import('../services/p2pquake')

const { useEarthquakes } = await import('./useEarthquakes')

// テストボタンのデータ（`utils/testData.ts`）をここで読んでおく。**テスト本体の中で初めて
// 読ませない**ためで、値としては使わない。
//
// 実装はこれを `loadTestData()` の動的 import で読む（押されるまで読まない作り。理由は
// `utils/testDataLoader.ts`）。そのため最初に `simulate*` を呼ぶテストが、`testData.ts` が
// 抱える JSON 5 本（計 1.1 MB）の解決・変換を丸ごと自分の所要時間として負う。実測では
// このファイル単体の実行で 118ms、全ファイル並列実行だと他ワーカーとの順番待ちが乗って
// 907ms まで伸び、混雑した回は既定の 5 秒を超えて時間切れになった（同じファイルの他の
// テストはどれも 3ms 前後）。**1 件目が時間切れになると、以降 95 件が `h.current` を
// null として掴んで連鎖的に落ちる**ので、症状は「このファイルだけ全滅」に見える。
//
// トップレベルで一度読めば、待ちはファイル読み込み時へ移って `testTimeout` の対象から
// 外れる（→ CLAUDE.md「検証」節）。
//
// 引き換えに、読み込みに失敗したときはこのファイルが丸ごと落ちる（前は `simulate*` を使う
// テストだけが落ちた）。読むのは生成済みの JSON なので失敗の目は薄いと見て、単純さを採る。
await import('../utils/testData')
const { totalSkipped } = await import('../utils/telegramLoss')


/**
 * テスト用: 取りこぼしを日ごとの Map にする。
 *
 * 実装が件数ひとつから日ごとへ変わったのは、同じ日を二度読んでも二重に数えず、別の日の分も
 * 失わないため（→ `utils/telegramLoss.ts` の `skippedByDay`）。日を書き分けたいテストは
 * 第 2 引数を渡す。
 */
function skips(count: number, day = '2026-08-10'): Map<string, number> {
  return count > 0 ? new Map([[day, count]]) : new Map()
}


beforeEach(() => {
  sockets.length = 0
  socketOptions.holdClassifications = false
  mockIsDmdss = true
  // 戻り値の形はここで型付きに与える（実シグネチャと違えば型エラーになる）
  vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history())
  vi.mocked(fetchHistory).mockResolvedValue([])
  vi.mocked(fetchHistorySince).mockResolvedValue({ events: [], rawCount: 0, truncated: false })
  vi.mocked(fetchJmaQuake).mockResolvedValue([])
})

afterEach(cleanup)

/** replayTimeOffset を差し替えられるハーネス。onLiveEvent は生の電文を覗きたいときだけ渡す。 */
function setup(opts: {
  apiKey?: string; offset?: number | null; onLiveEvent?: (event: LiveEvent) => void
  /** 起動時に復元した緊急地震速報を読み上げ側へ渡す口（`App.tsx` では `restoreStartupEews`） */
  onStartupRestoreEews?: (eews: readonly EEWAlert[]) => void
  /** 起動時の復元が出す画面の要求（`App.tsx` では `handleStartupRestore`） */
  onStartupRestore?: Parameters<typeof useEarthquakes>[4]
} = {}) {
  const view = renderHook(
    ({ offset }: { offset: number | null }) =>
      useEarthquakes(opts.onLiveEvent, opts.apiKey ?? 'test-key', false, offset, opts.onStartupRestore, opts.onStartupRestoreEews),
    { initialProps: { offset: opts.offset ?? null } },
  )
  return {
    get current() { return view.result.current },
    setOffset(offset: number | null) {
      act(() => { view.rerender({ offset }) })
    },
    /**
     * 実装の初回履歴取得（`Promise.all` → `then(async ...)` → `setState`）を流し切る。
     *
     * `act` の同期版はエフェクト本体までしか進めないため、これを挟まないと取得の失敗
     * （例: モックの戻り値の形違いによる TypeError）が state へ届く前に assert してしまい、
     * 「見ているつもりで何も見ていない」テストになる。
     *
     * 1 回で足りる。`await` はマイクロタスクキューが空になるまでドレインするため、
     * チェーンが何段あってもマイクロタスクだけで構成されている限りまとめて流れる
     * （実測で tick=1 の時点で error state へ反映されることを確認済み）。
     */
    async flush() {
      await act(async () => { await Promise.resolve() })
    },
  }
}

describe('DMDSS 版: 再生中は接続状態を replay にする（ライブ接続は切る）', () => {
  it('replayTimeOffset が入ると replay へ移り、読み込み中も降りる', async () => {
    const h = setup({ offset: null })
    // 再生前の初回履歴取得を流し切ってから見る（取得の失敗が state へ届くのを待つ）
    await h.flush()
    expect(h.current.error).toBeNull()

    h.setOffset(-3600_000)
    expect(h.current.connectionStatus).toBe('replay')
    expect(h.current.isLoading).toBe(false)
  })

  it('再生中は DMDATA の WebSocket を張らない（張ったものは切る）', () => {
    const h = setup({ offset: null })
    // 再生開始前に 1 本張られている
    expect(sockets.length).toBe(1)
    expect(sockets[0].connected).toBe(true)

    h.setOffset(-3600_000)
    // 前の effect の cleanup で切られ、新しい接続は張られない
    expect(sockets[0].connected).toBe(false)
    expect(sockets.length).toBe(1)
  })

  it('再生を終えると接続を張り直し、connecting へ戻る（API キーあり）', async () => {
    const h = setup({ offset: -3600_000 })
    expect(h.current.connectionStatus).toBe('replay')

    h.setOffset(null)
    // 再生を終えた側の初回履歴取得（API キーがあるため走る）を流し切ってから見る。
    await h.flush()
    expect(h.current.connectionStatus).toBe('connecting')
    expect(sockets.length).toBe(1)
    expect(sockets[0].connected).toBe(true)
  })

  it('API キーが無ければ、再生を終えたあとは disconnected へ戻る', () => {
    const h = setup({ apiKey: '', offset: -3600_000 })
    expect(h.current.connectionStatus).toBe('replay')

    h.setOffset(null)
    expect(h.current.connectionStatus).toBe('disconnected')
    expect(h.current.isLoading).toBe(false)
  })

  it('接続後に再生へ入っても replay で上書きする（connected のまま残さない）', () => {
    const h = setup({ offset: null })
    act(() => { sockets[0].onStatusChange?.('connected') })
    expect(h.current.connectionStatus).toBe('connected')

    h.setOffset(-3600_000)
    expect(h.current.connectionStatus).toBe('replay')
  })
})

describe('standard 版も再生中はライブ受信を止める（VAR-1）', () => {
  beforeEach(() => { mockIsDmdss = false })

  // かつては standard 版だけ P2PQuake の受信を続けていた（リプレイが強震モニタの時計ずらしに
  // 過ぎず、地震・津波は何も流れなかったため）。standard 版も当時の電文を流すようになった今は
  // DMDSS 版と同じ扱いで、再生中はライブ接続を切る。
  it('replayTimeOffset が入ると replay へ移る', () => {
    const h = setup({ offset: null })
    act(() => { sockets[0].onStatusChange?.('connected') })
    expect(h.current.connectionStatus).toBe('connected')

    h.setOffset(-3600_000)
    expect(h.current.connectionStatus).toBe('replay')
  })

  it('再生中はライブ接続を張らない（張ったものは切る）', () => {
    const h = setup({ offset: null })
    expect(sockets.length).toBe(1)
    expect(sockets[0].connected).toBe(true)

    h.setOffset(-3600_000)
    // 前の effect の cleanup で切られ、新しい接続は張られない
    expect(sockets[0].connected).toBe(false)
    expect(sockets.length).toBe(1)
  })

  it('再生を終えるとライブ接続を張り直し、読み込み中へ戻す', async () => {
    const h = setup({ offset: -3600_000 })
    expect(h.current.connectionStatus).toBe('replay')

    h.setOffset(null)
    expect(sockets.length).toBe(1)
    expect(sockets[0].connected).toBe(true)
    // 取得前に読み込み中へ戻すこと。ここを見ないと、リセット直後の未取得の状態が
    // 「地震情報はありません」（0 件）として表示される回帰を通してしまう。
    expect(h.current.isLoading).toBe(true)

    await h.flush()
    expect(h.current.error).toBeNull()
    expect(h.current.isLoading).toBe(false)
  })

  describe('張り直したら、切れていた間の情報を取り戻す', () => {
    const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()
    const backfilledQuake = (): JMAQuake => ({
      kind: 'quake',
      id: 'backfilled-quake',
      time: at(-60_000),
      issue: { source: '気象庁', time: at(-60_000), type: '震源・震度情報', correct: 'なし' },
      earthquake: {
        time: at(-120_000),
        hypocenter: { name: 'テスト沖', latitude: 35, longitude: 140, depth: 10, magnitude: 4.0 },
        maxScale: 10,
        domesticTsunami: 'なし',
      },
      points: [{ pref: '', addr: 'テスト県北部', isArea: true, scale: 10 }],
    })
    const tsunami = (id: string, time: string, cancelled: boolean): JMATsunami => ({
      kind: 'tsunami',
      id,
      time,
      cancelled,
      issue: { source: '気象庁', time, type: 'Focus' },
      areas: cancelled ? [] : [{ grade: 'Watch', immediate: false, name: 'テスト沿岸' }],
    })

    // 正: 張り直しの知らせを受けたら、最後に届いた時刻の少し前から取り、一覧へ黙って積む。
    it('取り戻した地震情報を一覧へ積み、音・読み上げの経路へは流さない', async () => {
      const onLiveEvent = vi.fn()
      const h = setup({ offset: null, onLiveEvent })
      await h.flush()
      vi.mocked(fetchHistorySince).mockResolvedValue({ events: [backfilledQuake()], rawCount: 1, truncated: false })

      const lastReceived = Date.now() - 10 * 60_000
      act(() => { sockets[0].onReconnected?.(lastReceived) })
      await h.flush()

      const [codes, since] = vi.mocked(fetchHistorySince).mock.calls[0]
      expect(codes).toEqual([551, 552])
      expect(since).toBeLessThan(lastReceived)
      expect(h.current.earthquakes.some(q => q.id === 'backfilled-quake')).toBe(true)
      expect(onLiveEvent).not.toHaveBeenCalled()
    })

    // 正: 切れていた間に出た津波は、起動時の履歴と同じく画面へ出す。
    it('取り戻した津波が手元のより新しければ差し替える', async () => {
      const h = setup({ offset: null })
      await h.flush()
      vi.mocked(fetchHistorySince).mockResolvedValue({
        events: [tsunami('backfilled-tsunami', at(-60_000), false)], rawCount: 1, truncated: false,
      })
      act(() => { sockets[0].onReconnected?.(Date.now() - 10 * 60_000) })
      await h.flush()
      expect(h.current.tsunamis.map(t => t.id)).toEqual(['backfilled-tsunami'])
    })

    // 安全弁: 張り直した直後にライブで届いた取消を、取り戻した古い発表報で甦らせない。
    it('ライブで先に届いたより新しい津波の報を、古い取り戻しで上書きしない', async () => {
      const h = setup({ offset: null })
      await h.flush()
      act(() => { sockets[0].onEvent?.(tsunami('live-cancel', at(0), true)) })
      vi.mocked(fetchHistorySince).mockResolvedValue({
        events: [tsunami('backfilled-old', at(-60_000), false)], rawCount: 1, truncated: false,
      })
      act(() => { sockets[0].onReconnected?.(Date.now() - 10 * 60_000) })
      await h.flush()
      expect(h.current.tsunamis.some(t => t.id === 'backfilled-old')).toBe(false)
    })

    // 安全弁: 張り直しが重なっても、取り戻しは前の回が終わってから次を走らせる（並行して枠を使わない）。
    it('張り直しが重なったら、取り戻しを 1 本ずつ順に走らせる', async () => {
      const h = setup({ offset: null })
      await h.flush()
      // 前のテストの呼び出しが数に残っているので、ここから数え直す
      vi.mocked(fetchHistorySince).mockClear()
      let releaseFirst: () => void = () => {}
      vi.mocked(fetchHistorySince)
        .mockImplementationOnce(() => new Promise(resolve => {
          releaseFirst = () => resolve({ events: [], rawCount: 0, truncated: false })
        }))
        .mockResolvedValueOnce({ events: [], rawCount: 0, truncated: false })
      act(() => {
        sockets[0].onReconnected?.(Date.now() - 20 * 60_000)
        sockets[0].onReconnected?.(Date.now() - 60_000)
      })
      await h.flush()
      // 1 本目が終わるまで 2 本目は出ない
      expect(vi.mocked(fetchHistorySince)).toHaveBeenCalledTimes(1)
      await act(async () => { releaseFirst(); await Promise.resolve() })
      await h.flush()
      expect(vi.mocked(fetchHistorySince)).toHaveBeenCalledTimes(2)
    })

    // 安全弁: 起動時の履歴は一覧を空から組み直すので、取り戻しはその後に走らせる（先に終わると消される）。
    it('起動時の履歴が片付くまで取り戻しを始めず、取り戻した分が残る', async () => {
      // 起動時の取得を止めておく（setup が effect を走らせる前に仕込む。既定値は beforeEach が後から入れない）
      let releaseStartup: () => void = () => {}
      vi.mocked(fetchJmaQuake).mockImplementationOnce(() => new Promise(resolve => {
        releaseStartup = () => resolve([])
      }))
      vi.mocked(fetchHistorySince).mockClear()
      vi.mocked(fetchHistorySince).mockResolvedValue({ events: [backfilledQuake()], rawCount: 1, truncated: false })
      const h = setup({ offset: null })
      act(() => { sockets[sockets.length - 1].onReconnected?.(Date.now() - 10 * 60_000) })
      await h.flush()
      expect(vi.mocked(fetchHistorySince)).not.toHaveBeenCalled()

      await act(async () => { releaseStartup(); await Promise.resolve() })
      await h.flush()
      expect(vi.mocked(fetchHistorySince)).toHaveBeenCalledTimes(1)
      expect(h.current.earthquakes.some(q => q.id === 'backfilled-quake')).toBe(true)
    })
  })

  // 再生開始時に読み込み中・エラー表示を畳むこと。畳まないと、初回履歴の取得中や失敗直後に
  // 再生を始めた場合、その取得は cleanup で破棄される一方で表示を戻す経路が無くなり、
  // 再生した電文が「データを取得中…」や取得失敗の文言の裏に隠れ続ける。
  it('再生開始時に読み込み中・エラー表示を畳む', () => {
    const h = setup({ offset: null })
    expect(h.current.isLoading).toBe(true)

    h.setOffset(-3600_000)
    expect(h.current.isLoading).toBe(false)
    expect(h.current.error).toBeNull()
  })
})

describe('再生中もキューの予約は発火時刻を待つ', () => {
  // かつては再生中だけ予約の発火時刻を `now` へ潰していた（VAR-1 の緩和策）。その結果、
  // EEW 最終報を受けた次のティック（10ms 後）に自動解除が走り、EEW が出た瞬間に消えていた。
  // 猶予の長さ自体は `calcEEWCancelTime` の責務（最終報から最低 60 秒）なので、ここでは
  // 「再生中もその猶予がキューに残ること」だけを見る。
  const OFFSET_MS = -3600_000

  /**
   * 最終報の EEW。規模を小さく取り、猶予が下限（60 秒）で決まるようにする。
   *
   * `time` / `originTime` は上書きできる。**解除時刻はこの 2 つから決まる**ので、
   * 読めない値を入れたときの振る舞いをここで作れる（→ 下の「解除時刻を決められないとき」）。
   */
  function finalEEW(at: Date, override: { time?: string; originTime?: string; arrivalTime?: string } = {}): EEWAlert {
    const iso = at.toISOString()
    return {
      kind: 'eew',
      origin: 'dmdata',
      id: 'replay-final',
      time: override.time ?? iso,
      test: false,
      earthquake: {
        originTime: override.originTime ?? iso,
        arrivalTime: override.arrivalTime ?? iso,
        condition: '',
        hypocenter: { name: 'テスト沖', latitude: 35, longitude: 140, depth: 10, magnitude: 4.0 },
      },
      severity: 'Forecast',
      cancelled: false,
      isFinal: true,
      issue: { eventId: 'replay-final-event', serial: '2', time: override.time ?? iso },
      areas: [],
    }
  }

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    vi.useRealTimers()
    setReplayOffset(null)
  })

  // 取消電文は報番号の台帳を進めず、状態側も取消前の報番号を保ったまま `cancelledAt` を足す。
  // そのため**同じ報番号の非取消報が届くと「古い報」の判定をすり抜ける**。起動時の復元が
  // 取消の直前に発表された報を拾ったとき（一覧 API が取消を反映するまでの遅れ）と、ライブで
  // 到着順が入れ替わったときに現実に起きる。
  it('取消済みの EEW は、同じ報番号の非取消報が届いても復活しない', async () => {
    const h = setup({})
    // 初回履歴取得（空の結果が返るが、その反映も act() の外では起こさない）を流し切る。
    await h.flush()
    const at = serverDate()

    act(() => { h.current.injectEvent(finalEEW(at)) })
    expect(h.current.activeEEWs.size).toBe(1)

    act(() => { h.current.injectEvent({ ...finalEEW(at), cancelled: true }) })
    expect(h.current.activeEEWs.get('replay-final-event')?.cancelledAt).toBeTruthy()

    // 復元経路が拾ってきた「取消前の報」を模す（報番号は取消前と同じ）
    act(() => { h.current.injectEvent(finalEEW(at)) })

    // 取消の印が残っていること。消えると表示が復活し、10 秒後の purge も空振りする
    expect(h.current.activeEEWs.get('replay-final-event')?.cancelledAt).toBeTruthy()
  })

  it('EEW 最終報を受けても猶予の内は解除せず、猶予を過ぎたら解除する', () => {
    // 時計も再生側へ寄せる（実装は getTimeRef=serverDate 経由で再生時刻を読む）
    setReplayOffset(OFFSET_MS)
    const h = setup({ offset: OFFSET_MS })

    act(() => { h.current.injectEvent(finalEEW(serverDate())) })
    expect(h.current.activeEEWs.size).toBe(1)

    // キューのディスパッチャは 10ms 間隔。回しても猶予の内は消えない
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(h.current.activeEEWs.size).toBe(1)

    act(() => { vi.advanceTimersByTime(31_000) })
    expect(h.current.activeEEWs.size).toBe(0)
  })

  /** 有効期限を持つ津波予報（DMDSS 版の「若干の海面変動」相当。解除電文が来ず期限だけで終わる）。 */
  function tsunamiWithValidDateTime(at: Date, validForMs: number): JMATsunami {
    const iso = at.toISOString()
    return {
      kind: 'tsunami',
      id: 'replay-tsunami',
      eventId: 'replay-tsunami-event',
      time: iso,
      cancelled: false,
      validDateTime: new Date(at.getTime() + validForMs).toISOString(),
      issue: { source: '気象庁', time: iso, type: 'Focus' },
      areas: [{ grade: 'Forecast', immediate: false, name: 'テスト沿岸' }],
    }
  }

  // EEW と同じ理由で、津波の有効期限（`validDateTime`）も潰されていた。しかも症状は逆で、
  // 予約時刻が `now` 以下に潰れると `alreadyExpired` が常に真になり、本編再生分（非サイレント）は
  // 失効予約が積まれないまま残り続けていた。EEW 側だけ直してもこちらは守られない。
  it('津波の有効期限も前倒しされず、期限を過ぎてから失効する', () => {
    setReplayOffset(OFFSET_MS)
    const h = setup({ offset: OFFSET_MS })

    act(() => { h.current.injectEvent(tsunamiWithValidDateTime(serverDate(), 60_000)) })
    expect(h.current.tsunamis.length).toBe(1)
    expect(h.current.tsunamis[0].cancelledAt).toBeUndefined()

    act(() => { vi.advanceTimersByTime(30_000) })
    expect(h.current.tsunamis[0].cancelledAt).toBeUndefined()

    act(() => { vi.advanceTimersByTime(31_000) })
    expect(h.current.tsunamis[0].cancelledAt).toBeInstanceOf(Date)
    expect(h.current.tsunamis[0].cancelReason).toBe('expired')
  })

  // ---- 解除時刻を決められないとき ----
  //
  // 自動解除はこの 1 回の予約が全てで、キューは発火時刻が読めないエントリを捨てる。
  // **捨てられるとその EEW は取消が来るまで画面に残り続ける。**

  // 正: 発表時刻が読めなくても震源時刻が読めれば予約できる（`calcEEWCancelTime`）。
  it('発表時刻が読めなくても、震源時刻から自動解除を予約する', () => {
    setReplayOffset(OFFSET_MS)
    const h = setup({ offset: OFFSET_MS })

    act(() => { h.current.injectEvent(finalEEW(serverDate(), { time: '' })) })
    expect(h.current.activeEEWs.size).toBe(1)

    act(() => { vi.advanceTimersByTime(30_000) })
    expect(h.current.activeEEWs.size).toBe(1)

    act(() => { vi.advanceTimersByTime(31_000) })
    expect(h.current.activeEEWs.size).toBe(0)
  })

  // 安全弁: どちらも読めなければ予約できない。**そのことを記録する** ——
  // キューの汎用ログ（発火時刻が読めないエントリを捨てた）だけでは、
  // 「なぜこの EEW が消えないか」に辿り着けない。
  it('発表時刻も震源時刻も読めなければ、予約できないことを記録する', () => {
    // このファイルは `log` 全体をモックしている（冒頭の `vi.mock`）ので、`vi.spyOn` を
    // 重ねず素の呼び出し履歴を見る。他のテストの分が混ざらないよう先に落とす。
    const err = vi.mocked(log.error)
    err.mockClear()
    setReplayOffset(OFFSET_MS)
    const h = setup({ offset: OFFSET_MS })

    act(() => { h.current.injectEvent(finalEEW(serverDate(), { time: '', originTime: '', arrivalTime: '' })) })
    expect(h.current.activeEEWs.size).toBe(1)
    expect(err.mock.calls.filter(c => String(c[0]).includes('自動解除を予約できません'))).toHaveLength(1)

    // 予約が無いので猶予を過ぎても消えない（取消が来るまで残る）
    act(() => { vi.advanceTimersByTime(300_000) })
    expect(h.current.activeEEWs.size).toBe(1)
  })
})

// キュー配列の identity。津波の失効予約の張り替えはキューの中身に触るが、**配列を作り直しては
// いけない**。ディスパッチャは 1 ティックで複数のエントリを続けて処理するため、その途中で
// 差し替えると、それ以降に取り出した電文が差し替え前の配列からしか消えず、新しい配列には
// 残ったままになる。次のティックはその配列を先頭から読むので同じ電文を再処理する。
//
// 実測（2024-01-02 16:59 からの再生）では地震情報 1 通で受信音が 15 回鳴り、キューからの
// 取り出しが 3779 回に達した。画面には「同じカードが更新され続ける」ようにしか映らず、
// 型検査でも例外でも捕まらないため、ここで固定する。
describe('キューは配列を差し替えない（同じ電文を二度処理しない）', () => {
  const OFFSET_MS = -3600_000

  /** 有効期限を持つ津波。処理すると失効予約の張り替えが走る（キューの中身に触る形）。 */
  const 津波 = (at: Date, validForMs: number, 連番 = 1): JMATsunami => {
    const iso = at.toISOString()
    return {
      kind: 'tsunami',
      id: `queue-identity-tsunami-${連番}`,
      eventId: `queue-identity-tsunami-event-${連番}`,
      time: iso,
      cancelled: false,
      validDateTime: new Date(at.getTime() + validForMs).toISOString(),
      issue: { source: '気象庁', time: iso, type: 'Focus' },
      areas: [{ grade: 'Forecast', immediate: false, name: 'テスト沿岸' }],
    }
  }

  /** 津波より後ろへ積む地震情報。通知が 1 回だけであることを見る。 */
  const 地震情報 = (at: Date, 連番 = 1): JMAQuake => {
    const iso = at.toISOString()
    return {
      kind: 'quake',
      id: `queue-identity-quake-${連番}`,
      time: iso,
      issue: { source: '気象庁', time: iso, type: '震源・震度情報', correct: 'なし' },
      earthquake: {
        time: iso,
        hypocenter: { name: 'テスト沖', latitude: 35, longitude: 140, depth: 10, magnitude: 4.0 },
        maxScale: 10,
        domesticTsunami: 'なし',
      },
      points: [{ pref: '', addr: 'テスト県北部', isArea: true, scale: 10 }],
    }
  }

  const 地震の通知数 = (fn: ReturnType<typeof vi.fn>) =>
    fn.mock.calls.filter(([e]) => (e as LiveEvent).kind === 'quake').length

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    vi.useRealTimers()
    setReplayOffset(null)
  })

  it('津波と同じティックで処理した地震情報を、一度だけ通知する', () => {
    setReplayOffset(OFFSET_MS)
    const onLiveEvent = vi.fn()
    const h = setup({ offset: OFFSET_MS, onLiveEvent })
    const at = serverDate()

    // 津波を先に積む。**この順序が要る**——張り替えは津波の処理で走るので、地震情報が
    // その後ろに無いと差し替えの影響を受けるエントリが存在しない。
    act(() => {
      h.current.loadReplayEvents([
        { payload: { kind: 'event', event: 津波(at, 60_000) }, replayTime: at },
        { payload: { kind: 'event', event: 地震情報(at) }, replayTime: at },
      ])
    })

    act(() => { vi.advanceTimersByTime(100) })
    expect(地震の通知数(onLiveEvent)).toBe(1)

    // ティックを回し続けても増えない（キューに残っていない）。
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(地震の通知数(onLiveEvent)).toBe(1)
  })

  // 実際の再現（2024-01-02 16:59 開始）ではキューに数十件が並び、張り替えは何度も起きていた。
  // 上の 2 件構成は最小の再現形でしかないため、**張り替えが連鎖する形**も固定する。ここが無いと、
  // 「1 回の差し替えだけ避ける」ような部分的な直し方でもテストが通ってしまう。
  it('張り替えが続けて起きても、後ろの電文をそれぞれ一度だけ通知する', () => {
    setReplayOffset(OFFSET_MS)
    const onLiveEvent = vi.fn()
    const h = setup({ offset: OFFSET_MS, onLiveEvent })
    const at = serverDate()

    act(() => {
      h.current.loadReplayEvents([
        { payload: { kind: 'event', event: 津波(at, 60_000, 1) }, replayTime: at },
        { payload: { kind: 'event', event: 地震情報(at, 1) }, replayTime: at },
        { payload: { kind: 'event', event: 津波(at, 90_000, 2) }, replayTime: at },
        { payload: { kind: 'event', event: 地震情報(at, 2) }, replayTime: at },
      ])
    })

    act(() => { vi.advanceTimersByTime(100) })
    expect(地震の通知数(onLiveEvent)).toBe(2)

    act(() => { vi.advanceTimersByTime(5_000) })
    expect(地震の通知数(onLiveEvent)).toBe(2)
  })

  // 発火時刻が日時として読めないエントリは、積む時点で弾く。取り出し側では弾けない——NaN は
  // `<=` と `>` のどちらとも偽になるため、判定の書き方で「即座に発火する」と「以後すべて止まる」の
  // どちらかに転ぶ（どちらの形がどちらへ転ぶかは `EventQueue` の `push` の注記）。**どちらの壊れ方も
  // ログにも例外にも出ない**ため、入口で弾いていることをここで固定する。
  it('発火時刻が読めないエントリは積まず、後続の電文を止めない', () => {
    setReplayOffset(OFFSET_MS)
    const onLiveEvent = vi.fn()
    const h = setup({ offset: OFFSET_MS, onLiveEvent })
    const at = serverDate()

    act(() => {
      h.current.loadReplayEvents([
        { payload: { kind: 'event', event: 地震情報(at, 1) }, replayTime: new Date(NaN) },
        { payload: { kind: 'event', event: 地震情報(at, 2) }, replayTime: at },
      ])
    })

    act(() => { vi.advanceTimersByTime(100) })
    // 読めない時刻の 1 件目は積まれず、2 件目だけが通る（1 件目で止まらない・1 件目が即発火しない）
    const 通知された = onLiveEvent.mock.calls
      .map(([e]) => e as LiveEvent)
      .filter(e => e.kind === 'quake')
      .map(e => (e as JMAQuake).id)
    expect(通知された).toEqual(['queue-identity-quake-2'])
  })

  it('張り替えは効いたままで、続報で期限を延ばすと古い予約は消える', () => {
    setReplayOffset(OFFSET_MS)
    const h = setup({ offset: OFFSET_MS })
    const at = serverDate()

    // 初報の期限は 60 秒後、続報で 120 秒後へ延ばす。古い予約が残っていれば 60 秒で失効する。
    act(() => { h.current.injectEvent(津波(at, 60_000)) })
    act(() => { h.current.injectEvent(津波(at, 120_000)) })

    act(() => { vi.advanceTimersByTime(70_000) })
    expect(h.current.tsunamis[0].cancelledAt).toBeUndefined()

    act(() => { vi.advanceTimersByTime(60_000) })
    expect(h.current.tsunamis[0].cancelledAt).toBeInstanceOf(Date)
    expect(h.current.tsunamis[0].cancelReason).toBe('expired')
  })
})

// EEW 発報テスト（設定タブのテストボタン）が作る「報の推移」。
//
// 実運用（dmdataParser.parseEEW）では 1 報ごとに報番号・id・発表時刻が進み、**震源時刻も
// 続報でずれる**（実電文は震源推定が更新されるたび作り直す）。**一方、地震発現時刻は不変** ——
// 観測点が実際に検知した時刻なので震源推定の更新とは無関係（実測は → `docs/spec/eew-spec.md` §3）。
// テスト側がここを取り違えると、
//   - 最終報の報番号が進まない → 「#1 → #1 最終報」という実運用ではあり得ない推移になる
//   - 基準時刻が現在時刻へ張り替わる → 予報円が押すたび中心に戻り、発生時刻表示も動く
//   - 震源時刻まで固定される → 続報で予報円の半径が跳ねる形を実機で一度も見られない
// のいずれも画面上は「それらしく」見えてしまうため、値そのものを固定して守る。
describe('EEW 発報テストの報の推移', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  /** activeEEWs の唯一の要素を取り出す（テストボタンは 1 イベントしか作らない）。 */
  function onlyEEW(h: ReturnType<typeof setup>): EEWAlert {
    const list = [...h.current.activeEEWs.values()]
    expect(list.length).toBe(1)
    return list[0]
  }

  // **かつて「震源時刻は初報のまま保つ」と固定していたテストを覆したもの。** 実電文の震源時刻は
  // 続報で動く（→ `docs/spec/eew-spec.md` §3「地震の時刻は発生時刻を出す」）。
  it('続報は報番号・発表時刻・震源時刻を進め、地震発現時刻だけを引き継ぐ', async () => {
    const h = setup()

    await act(async () => { await h.current.simulateEEWForecast() })
    const first = onlyEEW(h)
    expect(first.issue?.serial).toBe('1')
    expect(first.isFinal).toBeFalsy()

    // 沈黙時間（10 秒）より短い間隔なら続報になる
    act(() => { vi.advanceTimersByTime(3_000) })
    await act(async () => { await h.current.simulateEEWForecast() })
    const second = onlyEEW(h)

    expect(second.issue?.serial).toBe('2')
    expect(second.isFinal).toBeFalsy()
    // 対照: 地震発現時刻は動かない（実測では 15 地震すべてで 1 通も動かなかった）
    expect(second.earthquake.arrivalTime).toBe(first.earthquake.arrivalTime)
    // 正: 震源時刻はずれる。実電文は震源推定が更新されるたび動くため
    // （`utils/testData.ts` の `EEW_ORIGIN_DRIFT_SEC`）
    expect(Date.parse(second.earthquake.originTime) - Date.parse(first.earthquake.originTime)).toBe(-3_000)
    // 発表時刻と id は報ごとに変わる（issue.time は型上 optional なので解釈可能かも見る）
    const firstIssued = Date.parse(first.issue?.time ?? '')
    const secondIssued = Date.parse(second.issue?.time ?? '')
    expect(Number.isNaN(firstIssued)).toBe(false)
    expect(secondIssued).toBeGreaterThan(firstIssued)
    expect(second.id).not.toBe(first.id)
  })

  // 「非常に強い揺れを検知」の第 1 報の印と本文は、続報（仮定震源要素）で持ち越さない。
  // 続報は報を丸ごと置き換えるので、印が残ると確定へ進んだ後も予報円が出ず本文が居座る。
  it('強い揺れ検知の第 1 報の印と本文は、続報で消える', async () => {
    const h = setup()

    await act(async () => { await h.current.simulateEEWStrongShaking() })
    const first = onlyEEW(h)
    expect(first.strongShakingOnly).toBe(true)
    expect(first.strongShakingText).toBeTruthy()

    act(() => { vi.advanceTimersByTime(3_000) })
    await act(async () => { await h.current.simulateEEWStrongShaking() })
    const second = onlyEEW(h)
    expect(second.issue?.serial).toBe('2')
    expect(second.strongShakingOnly).toBeUndefined()
    expect(second.strongShakingText).toBeUndefined()
    expect(second.earthquake.condition).toBe('仮定震源要素')
  })

  it('最終報も独立した 1 報として報番号を進める', async () => {
    const h = setup()

    await act(async () => { await h.current.simulateEEWForecast() })
    const first = onlyEEW(h)

    // 再クリックが無いまま沈黙時間が過ぎると最終報が確定する
    act(() => { vi.advanceTimersByTime(10_000) })
    const final = onlyEEW(h)

    expect(final.isFinal).toBe(true)
    expect(final.issue?.serial).toBe('2')
    // 同じ地震の報なので地震発現時刻は引き継ぐ（震源時刻は続報と同じくずれる）
    expect(final.earthquake.arrivalTime).toBe(first.earthquake.arrivalTime)
    expect(Date.parse(final.earthquake.originTime) - Date.parse(first.earthquake.originTime)).toBe(-3_000)
  })

  // activeEEWs は取消を受けても直前の確定状態を保つ（表示を空にしないための実装）ため、
  // 取消電文そのものの形は state からは見えない。onLiveEvent に届く生の電文で確かめる。
  it('誤報取消も独立した 1 報として報番号を進め、対象地域を持たない', async () => {
    const events: LiveEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })

    await act(async () => { await h.current.simulateEEWRetraction() })
    act(() => { vi.advanceTimersByTime(10_000) })

    const eews = events.filter((e): e is EEWAlert => e.kind === 'eew')
    expect(eews.length).toBe(2)
    const [report, cancel] = eews

    expect(report.issue?.serial).toBe('1')
    expect(report.areas?.length).toBeGreaterThan(0)

    expect(cancel.cancelled).toBe(true)
    expect(cancel.issue?.serial).toBe('2')
    expect(cancel.areas).toEqual([])
    // 実運用の取消電文は `Earthquake` 要素を持たない —— `dmdataParser` と同じく震源名は空・
    // 座標は位置不明（-200）。**以前は名前を残し座標を 0 にしていた**（実電文に無い形で、
    // 名前の空の取消で通知が崩れる経路を一度も通れなかった。覆したのはこの前提）
    expect(cancel.earthquake.hypocenter.latitude).toBe(-200)
    expect(cancel.earthquake.hypocenter.longitude).toBe(-200)
    expect(cancel.earthquake.hypocenter.name).toBe('')
    expect(report.earthquake.hypocenter.name).not.toBe('')
    // 予想も持たない（実運用の取消電文は forecastMaxScale / forecastMaxLpgmClass が入らない）
    expect(cancel.forecastMaxScale).toBeUndefined()
    expect(cancel.forecastMaxLpgmClass).toBeUndefined()
    // 取消は最終報ではない（自動解除と区別され、音・通知・読み上げを伴う）
    expect(cancel.isFinal).toBeFalsy()
    expect(h.current.activeEEWs.size).toBe(1)
  })

  // 取消しの概要（電文の `Body/Text`）は XML を読む dmdataParser でしか作れない。
  // 津波の解除テストと同じ形で、バリアントの境目を正・対照の対で固定する。
  it('DMDSS 版: 誤報取消は取消しの概要を持つ', async () => {
    const events: LiveEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })

    await act(async () => { await h.current.simulateEEWRetraction() })
    act(() => { vi.advanceTimersByTime(10_000) })

    const cancel = events.filter((e): e is EEWAlert => e.kind === 'eew')[1]
    expect(cancel.cancelled).toBe(true)
    expect(cancel.cancelText).toBeTruthy()
  })

  // 対照: standard 版の P2PQuake には対応するフィールドが無い。テストボタンが実電文の形から
  // 外れると、実機では一度も起きない表示・読み上げが「起きる」ように見える
  it('standard 版: 取消しの概要を持たない（P2PQuake には無い項目）', async () => {
    mockIsDmdss = false
    const events: LiveEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })

    await act(async () => { await h.current.simulateEEWRetraction() })
    act(() => { vi.advanceTimersByTime(10_000) })

    const cancel = events.filter((e): e is EEWAlert => e.kind === 'eew')[1]
    expect(cancel.cancelled).toBe(true)
    expect(cancel.cancelText).toBeUndefined()
  })
})

// 津波テストの解除電文。EEW の最終報と同じ「直前の電文を流用して据え置く」形になっていた。
// 実運用（dmdataParser / p2pquake の 552）はどちらの経路も区域を空にして送るため、
// 区域が残ったままの解除は実運用では起こらない。解除理由はバリアントで持つ/持たないが分かれる。
describe('津波テストの解除電文', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  /** 発表 → 解除の 2 通を取り出す。 */
  function tsunamiPair(events: LiveEvent[]): [JMATsunami, JMATsunami] {
    const list = events.filter((e): e is JMATsunami => e.kind === 'tsunami')
    expect(list.length).toBe(2)
    return [list[0], list[1]]
  }

  /**
   * 初回履歴の取り込みを先に流し切る。
   *
   * テストデータは動的 import で読むので、シミュレーション関数は Promise を返す。それを await
   * すると**同じ待ちのあいだに初回履歴取得（`fetchDmdataQuakeHistory`）の解決も進む**ため、
   * 順番しだいで履歴の `setState` が、いま流したテスト電文を上書きする。症状は
   * **「`onLiveEvent` には 2 通とも届いているのにカードが空」** —— 電文の形を見る assertion は
   * 通り、state を見る assertion だけが落ちるので、電文側だけ確かめていると気づけない。
   *
   * `setup()` の直後に空の act を 1 度回して初回取り込みを終わらせておけば、以後は競合しない。
   */
  async function flushInitialLoad() {
    await act(async () => {})
  }

  it('DMDSS 版: 解除は区域を空にし、発表時刻を解除時点へ進める', async () => {
    const events: LiveEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })

    await flushInitialLoad()

    await act(async () => { await h.current.simulateTsunamiWatch() })
    act(() => { vi.advanceTimersByTime(90_000) })

    const [first, cancel] = tsunamiPair(events)
    expect(first.areas.length).toBeGreaterThan(0)
    // DMDATA の電文は常に eventId を持つ
    expect(first.eventId).toBeTruthy()

    expect(cancel.cancelled).toBe(true)
    expect(cancel.areas).toEqual([])
    expect(cancel.cancelReason).toBe('lifted')
    expect(new Date(cancel.time).getTime()).toBeGreaterThan(new Date(first.time).getTime())
    expect(cancel.id).not.toBe(first.id)

    // 電文の形だけでなく、state が実際に解除されたことまで見る。onLiveEvent は reducer の
    // 成否に関わらず呼ばれるため、ここを見ないと「音は鳴るがカードは残る」状態を通してしまう。
    expect(h.current.tsunamis[0]?.cancelledAt).toBeInstanceOf(Date)
    expect(h.current.tsunamis[0]?.cancelReason).toBe('lifted')
  })

  // 取消電文だけが持つ項目は、表示中のカードを土台にする更新で**名指しで移さないと落ちる**。
  // パーサーも読み上げも通っているのに画面にだけ出ない、という形になり、型検査でも捕まらない
  // （オプショナルなので）。実際にブラウザ確認で見つかった。
  it('DMDSS 版: 誤報取消の理由をカードへ引き継ぐ', async () => {
    const h = setup()
    await flushInitialLoad()
    await act(async () => { await h.current.simulateTsunamiRetraction() })
    act(() => { vi.advanceTimersByTime(90_000) })

    expect(h.current.tsunamis[0]?.cancelReason).toBe('retracted')
    expect(h.current.tsunamis[0]?.cancelText).toBeTruthy()
  })

  // 対照: 解除（`lifted`）は取消電文ではないので理由を持たない。**無いものを作らない**
  it('解除では取消の理由を持たない', async () => {
    const h = setup()
    await flushInitialLoad()
    await act(async () => { await h.current.simulateTsunamiWatch() })
    act(() => { vi.advanceTimersByTime(90_000) })

    expect(h.current.tsunamis[0]?.cancelReason).toBe('lifted')
    expect(h.current.tsunamis[0]?.cancelText).toBeUndefined()
  })

  // 全区域解除の報に気象庁が書いた文（`liftText`）も、取消の理由と同じく名指しで移さないと落ちる。
  // 落ちても読み上げは鳴るので、画面にだけ文が出ない食い違いになる。
  it('正: DMDSS 版の全区域解除は、気象庁の文をカードへ引き継ぐ', async () => {
    const h = setup()
    await flushInitialLoad()
    await act(async () => { await h.current.simulateTsunamiWatch() })
    act(() => { vi.advanceTimersByTime(90_000) })

    expect(h.current.tsunamis[0]?.cancelReason).toBe('lifted')
    expect(h.current.tsunamis[0]?.liftText).toContain('現在、大津波警報・津波警報・津波注意報を発表している沿岸はありません。')
  })

  it('対照: 誤報取消は解除の文を持たない', async () => {
    const h = setup()
    await flushInitialLoad()
    await act(async () => { await h.current.simulateTsunamiRetraction() })
    act(() => { vi.advanceTimersByTime(90_000) })

    expect(h.current.tsunamis[0]?.cancelReason).toBe('retracted')
    expect(h.current.tsunamis[0]?.liftText).toBeUndefined()
  })

  it('安全弁: standard 版の解除は文を持たないので、カードにも付けない', async () => {
    mockIsDmdss = false
    const h = setup()
    await flushInitialLoad()
    await act(async () => { await h.current.simulateTsunamiWatch() })
    act(() => { vi.advanceTimersByTime(90_000) })

    expect(h.current.tsunamis[0]?.cancelledAt).toBeInstanceOf(Date)
    expect(h.current.tsunamis[0]?.liftText).toBeUndefined()
  })

  it('standard 版: 解除理由と eventId を持たない（P2PQuake では判別できない項目）', async () => {
    mockIsDmdss = false
    const events: LiveEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })

    await flushInitialLoad()

    await act(async () => { await h.current.simulateTsunamiRetraction() })
    act(() => { vi.advanceTimersByTime(90_000) })

    const [first, cancel] = tsunamiPair(events)
    expect(first.eventId).toBeUndefined()
    expect(cancel.cancelled).toBe(true)
    expect(cancel.areas).toEqual([])
    // 誤報取消でも standard 版は「取消」と判別できないため理由を付けない
    expect(cancel.cancelReason).toBeUndefined()

    // eventId が無く id も別物（実運用の P2PQuake と同じ形）でも解除が state へ届くこと。
    // ここを id 照合で捨てていたのが standard 版の「カードが消えない」不具合だった。
    expect(h.current.tsunamis[0]?.cancelledAt).toBeInstanceOf(Date)
    expect(h.current.tsunamis[0]?.cancelReason).toBeUndefined()
  })

  // 上の 2 件はテストボタン経由。こちらは reducer の解除照合そのものを、実運用の
  // P2PQuake 相当の電文（eventId 無し・発表と解除で id が別）で直接確かめる。
  it('eventId を持たない経路では、id が違っても解除を受け入れる（P2PQuake 相当）', async () => {
    mockIsDmdss = false
    const h = setup()
    await flushInitialLoad()

    const base = serverDate().toISOString()
    const announce: JMATsunami = {
      kind: 'tsunami',
      id: 'p2p-552-announce',
      time: base,
      cancelled: false,
      issue: { source: '気象庁', time: base, type: 'Focus' },
      areas: [{ grade: 'Watch', immediate: false, name: 'テスト沿岸' }],
    }
    act(() => { h.current.injectEvent(announce) })
    expect(h.current.tsunamis.length).toBe(1)

    // 解除は別電文なので id が異なる（P2PQuake の id は電文ごとの文書 ID）
    act(() => {
      h.current.injectEvent({
        ...announce,
        id: 'p2p-552-cancel',
        time: new Date(Date.parse(base) + 60_000).toISOString(),
        cancelled: true,
        areas: [],
      })
    })
    expect(h.current.tsunamis[0]?.cancelledAt).toBeInstanceOf(Date)
  })

  // ただし照合できないからといって何でも受け入れるわけではない。表示中より古い発表時刻の解除は
  // 「別イベントの遅延到達」として捨てる（1 件スロットのため、受け入れると別の津波が消える）。
  it('eventId が無い経路でも、表示中より古い発表時刻の解除は受け入れない', async () => {
    mockIsDmdss = false
    const h = setup()
    await flushInitialLoad()

    const older = new Date(Date.now() - 600_000).toISOString()
    const newer = new Date().toISOString()

    // 先に古いイベント A を出し、続いて新しいイベント B に置き換わった状態を作る
    const eventA: JMATsunami = {
      kind: 'tsunami',
      id: 'p2p-552-A',
      time: older,
      cancelled: false,
      issue: { source: '気象庁', time: older, type: 'Focus' },
      areas: [{ grade: 'Watch', immediate: false, name: 'テスト沿岸' }],
    }
    act(() => { h.current.injectEvent(eventA) })
    act(() => {
      h.current.injectEvent({ ...eventA, id: 'p2p-552-B', time: newer, issue: { source: '気象庁', time: newer, type: 'Focus' } })
    })

    // A の解除が遅れて届く（発表時刻は B より古い）
    act(() => {
      h.current.injectEvent({ ...eventA, id: 'p2p-552-A-cancel', cancelled: true, areas: [] })
    })
    expect(h.current.tsunamis[0]?.cancelledAt).toBeUndefined()
    expect(h.current.tsunamis[0]?.id).toBe('p2p-552-B')
  })

  // 一方、双方が eventId を持つ DMDSS 経路では別イベントの解除に巻き込まれないこと。
  it('双方が eventId を持つ場合は、別イベントの解除では消えない', async () => {
    const h = setup()
    await flushInitialLoad()

    const base = serverDate().toISOString()
    const announce: JMATsunami = {
      kind: 'tsunami',
      id: 'dmdata-tsunami-A-1',
      eventId: '20260820100000',
      time: base,
      cancelled: false,
      issue: { source: '気象庁', time: base, type: 'Focus' },
      areas: [{ grade: 'Watch', immediate: false, name: 'テスト沿岸' }],
    }
    act(() => { h.current.injectEvent(announce) })

    act(() => {
      h.current.injectEvent({
        ...announce,
        id: 'dmdata-tsunami-B-1',
        eventId: '20260820110000',
        cancelled: true,
        areas: [],
      })
    })
    expect(h.current.tsunamis[0]?.cancelledAt).toBeUndefined()
  })
})

describe('南海トラフ関連解説情報の帯は期限で畳む', () => {
  // 解説情報には解除電文が無く、定例解説（VYSE52）は平常時にも毎月届く。期限で畳まないと
  // 帯が常駐する。逆に期限切れを載せてしまうと「先月の解説」が起動のたびに出る。
  // どちらも画面を見ただけでは「そういう仕様」と区別がつかないため、ここで固定する。

  /** expireInMs 後に期限が切れる解説情報。 */
  function commentary(id: string, expireInMs: number): JMANankaiCommentary {
    const now = serverDate()
    return {
      id,
      time: now.toISOString(),
      eventId: `${id}-event`,
      serialCode: '200',
      serialName: '定例解説',
      headline: '南海トラフ地震関連解説情報',
      summary: '要約',
      body: '本文',
      cancelled: false,
      reportDateTime: now.toISOString(),
      expireAt: new Date(now.getTime() + expireInMs).toISOString(),
    }
  }

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('初回取得で期限内の解説情報を帯に載せる', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ extras: [extra({ kind: 'nankaiCommentary', data: commentary('c-fresh', 60_000) })] }))
    const h = setup()
    await h.flush()
    expect(h.current.nankaiCommentary?.id).toBe('c-fresh')
  })

  it('期限切れの解説情報は載せない（先月の定例解説が起動時に出ないこと）', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ extras: [extra({ kind: 'nankaiCommentary', data: commentary('c-stale', -1_000) })] }))
    const h = setup()
    await h.flush()
    expect(h.current.nankaiCommentary).toBeNull()
  })

  it('期限が来たら帯を畳む', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ extras: [extra({ kind: 'nankaiCommentary', data: commentary('c-expiring', 5_000) })] }))
    const h = setup()
    await h.flush()
    expect(h.current.nankaiCommentary?.id).toBe('c-expiring')

    act(() => { vi.advanceTimersByTime(5_001) })
    expect(h.current.nankaiCommentary).toBeNull()
  })

  it('期限日時が壊れていれば載せない（期限計算が破綻した状態で帯を出さない）', async () => {
    const broken = { ...commentary('c-broken', 60_000), expireAt: 'not-a-date' }
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ extras: [extra({ kind: 'nankaiCommentary', data: broken })] }))
    const h = setup()
    await h.flush()
    expect(h.current.nankaiCommentary).toBeNull()
  })

  it('取消電文で帯を消す（期限を待たずに畳む）', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ extras: [extra({ kind: 'nankaiCommentary', data: commentary('c-live', 60_000) })] }))
    const h = setup()
    await h.flush()
    expect(h.current.nankaiCommentary?.id).toBe('c-live')

    // 取消はライブ受信経路（injectEvent は AppEvent 専用なので、キュー経由の payload を使う）。
    // **取消は対象と同じ `eventId` を持つ**（電文解説資料 Ⅰ.別紙ウ「独立した情報単位」）ので、
    // フィクスチャもその形にする。
    act(() => {
      h.current.loadReplayEvents([{
        payload: { kind: 'nankaiCommentary', data: { ...commentary('c-live', 60_000), cancelled: true } },
        replayTime: serverDate(),
      }])
    })
    act(() => { vi.advanceTimersByTime(50) })
    expect(h.current.nankaiCommentary).toBeNull()
  })

  // 安全弁: 表示中でない解説情報の取消は、表示中の帯の期限タイマーを止めない。
  // 以前は照合の前にタイマーを止めていたので、別の解説情報の取消が 1 通届くだけで帯が期限で畳まれなくなった。
  it('安全弁: 別の解説情報の取消が届いても、表示中の帯は期限で畳む', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ extras: [extra({ kind: 'nankaiCommentary', data: commentary('c-shown', 5_000) })] }))
    const h = setup()
    await h.flush()
    expect(h.current.nankaiCommentary?.id).toBe('c-shown')

    act(() => {
      h.current.loadReplayEvents([{
        payload: { kind: 'nankaiCommentary', data: { ...commentary('c-other', 60_000), cancelled: true } },
        replayTime: serverDate(),
      }])
    })
    act(() => { vi.advanceTimersByTime(50) })
    expect(h.current.nankaiCommentary?.id).toBe('c-shown')

    act(() => { vi.advanceTimersByTime(5_001) })
    expect(h.current.nankaiCommentary).toBeNull()
  })

  // 安全弁: 別の情報単位に向けた取消で、いま出ている帯を消さない。気象庁は発表ごとに別の
  // `EventID` を割り振るため（同 Ⅰ.別紙エ）、遅れて届いた古い取消がこの形で来うる
  it('別の eventId に向けた取消では帯を消さない', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ extras: [extra({ kind: 'nankaiCommentary', data: commentary('c-live', 60_000) })] }))
    const h = setup()
    await h.flush()
    expect(h.current.nankaiCommentary?.id).toBe('c-live')

    act(() => {
      h.current.loadReplayEvents([{
        payload: { kind: 'nankaiCommentary', data: { ...commentary('c-other', 60_000), cancelled: true } },
        replayTime: serverDate(),
      }])
    })
    act(() => { vi.advanceTimersByTime(50) })
    expect(h.current.nankaiCommentary?.id).toBe('c-live')
  })
})

describe('震源・津波区分を津波電文から借りる結線', () => {
  // **借りる契機は両方向に要る**（地震が先・津波が先）。どちらが先かは決まっていないのに、
  // 片方の配線が落ちても画面には「その順序のときだけ震源が出ない」としか現れない。
  // 純関数（`utils/borrowFromTsunami.ts`）のテストでは、reducer のどの分岐に繋いだかを見られない。
  const EVENT_ID = '20240101161010'

  /** 震源を持たない震度速報（実電文と同じくセンチネルで埋める）。 */
  function prompt(): JMAQuake {
    const at = serverDate().toISOString()
    return {
      kind: 'quake',
      id: `dmdata-quake-${EVENT_ID}-1`,
      time: at,
      issue: { source: 'dmdata', time: at, type: '震度速報', correct: 'なし' },
      earthquake: {
        time: at,
        hypocenter: { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: NaN },
        maxScale: 70,
        domesticTsunami: '調査中',
      },
      points: [{ pref: '石川県', addr: '石川県能登', isArea: true, scale: 70 }],
    }
  }

  /** 原因地震（震源）と大津波警報を載せた津波。 */
  function tsunami(over: { eventId?: string } = {}): JMATsunami {
    const at = serverDate().toISOString()
    return {
      kind: 'tsunami',
      id: `dmdata-tsunami-${EVENT_ID}-1`,
      eventId: over.eventId ?? EVENT_ID,
      time: at,
      cancelled: false,
      infoName: '津波警報・津波注意報・津波予報',
      issue: { source: 'dmdata', time: at, type: 'Focus' },
      areas: [{ grade: 'MajorWarning', immediate: true, name: '石川県能登' }],
      sourceEarthquakes: [{
        hypocenterName: '石川県能登地方',
        magnitude: 7.4,
        originTime: at,
        latitude: 37.5,
        longitude: 137.2,
        depth: 0,
      }],
    }
  }

  /** 地震・津波は AppEvent の入口（`injectEvent`）から流す。 */
  function push(h: ReturnType<typeof setup>, event: JMAQuake | JMATsunami) {
    act(() => { h.current.injectEvent(event) })
  }

  // 正: 津波が先。受信側（'quake' ケース）が、既に画面にある津波から借りる。
  it('津波が先に届いていれば、あとから来た震度速報が震源と津波区分を借りる', async () => {
    const h = setup()
    await h.flush()
    push(h, tsunami())
    push(h, prompt())
    const card = h.current.earthquakes[0]
    expect(card.earthquake.hypocenter.name).toBe('石川県能登地方')
    expect(card.earthquake.domesticTsunami).toBe('警報等')
    expect(card.hypocenterSource?.shortLabel).toBe('津波情報')
    expect(card.domesticTsunamiSource?.shortLabel).toBe('津波情報')
  })

  // 正: 地震が先。配る側（'tsunami' ケース）が、既にあるカードへ配る。
  it('震度速報が先に届いていれば、あとから来た津波がカードへ配る', async () => {
    const h = setup()
    await h.flush()
    push(h, prompt())
    expect(h.current.earthquakes[0].earthquake.hypocenter.name).toBe('')
    push(h, tsunami())
    const card = h.current.earthquakes[0]
    expect(card.earthquake.hypocenter.name).toBe('石川県能登地方')
    expect(card.earthquake.domesticTsunami).toBe('警報等')
  })

  // 安全弁: 別の地震の津波からは借りない（結ぶ根拠は `eventId` の一致だけ）。
  it('eventId が違う津波からは借りない', async () => {
    const h = setup()
    await h.flush()
    push(h, tsunami({ eventId: '20240101999999' }))
    push(h, prompt())
    const card = h.current.earthquakes[0]
    expect(card.earthquake.hypocenter.name).toBe('')
    expect(card.earthquake.domesticTsunami).toBe('調査中')
    expect(card.hypocenterSource).toBeUndefined()
  })
})

describe('地震・津波に関するお知らせ（VZSE40）と地震回数（VXSE60）の結線', () => {
  // どちらも実機で偶然踏んで気づくことが期待できない（お知らせは実配信に届くが取消は未観測、
  // 地震回数は実配信で観測できていない）。畳み方と取消の照合はここで固定しておく。

  /** expireInMs 後に期限が切れるお知らせ。 */
  function notice(id: string, expireInMs: number): JMAQuakeNotice {
    const now = serverDate()
    return {
      id,
      time: now.toISOString(),
      eventId: `${id}-event`,
      headline: '沖縄県の震度データ入電停止のお知らせ',
      body: '本文',
      cancelled: false,
      reportDateTime: now.toISOString(),
      expireAt: new Date(now.getTime() + expireInMs).toISOString(),
    }
  }

  /** 区間を items 件持つ地震回数の報。`expireInMs` 後に期限が切れる。 */
  function count(eventId: string, items: JMAEarthquakeCount['items'], expireInMs = 60_000): JMAEarthquakeCount {
    const now = serverDate()
    return {
      id: `dmdata-quake-count-${eventId}-1`,
      time: now.toISOString(),
      eventId,
      headline: '地震回数に関する情報をお知らせします。',
      items,
      cancelled: false,
      reportDateTime: now.toISOString(),
      expireAt: new Date(now.getTime() + expireInMs).toISOString(),
    }
  }

  const item = (type: string, number: number, feltNumber: number): JMAEarthquakeCount['items'][number] => ({
    type,
    startTime: serverDate().toISOString(),
    endTime: serverDate().toISOString(),
    number,
    feltNumber,
  })

  /** キュー経由で 1 件流す（`injectEvent` は AppEvent 専用なのでこちらを使う）。 */
  function push(h: ReturnType<typeof setup>, payload: import('../types/replay').ReplayPayload) {
    act(() => { h.current.loadReplayEvents([{ payload, replayTime: serverDate() }]) })
    act(() => { vi.advanceTimersByTime(50) })
  }

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  // 正: 帯を出し、7 日（ここでは短縮した期限）で畳む。
  it('お知らせは期限で畳む', async () => {
    const h = setup()
    await h.flush()
    push(h, { kind: 'quakeNotice', data: notice('n-live', 5_000) })
    expect(h.current.quakeNotice?.id).toBe('n-live')

    act(() => { vi.advanceTimersByTime(5_001) })
    expect(h.current.quakeNotice).toBeNull()
  })

  // 対照: 期限切れのお知らせは載せない（リプレイで過去の窓を再生したときに出ないこと）。
  it('期限切れのお知らせは載せない', async () => {
    const h = setup()
    await h.flush()
    push(h, { kind: 'quakeNotice', data: notice('n-stale', -1_000) })
    expect(h.current.quakeNotice).toBeNull()
  })

  // 正: 取消で帯を消す。**照合は `EventID`** ―― 取消は元のお知らせの `EventID` を引き継ぐが、
  // `id` には取消自身の作成時刻が入るので、元のお知らせの `id` とは一致しない。
  it('取消電文で帯を消す（id が違っても EventID が同じなら消す）', async () => {
    const h = setup()
    await h.flush()
    push(h, { kind: 'quakeNotice', data: notice('n-live', 60_000) })
    expect(h.current.quakeNotice?.id).toBe('n-live')

    push(h, { kind: 'quakeNotice', data: { ...notice('n-live', 60_000), id: 'n-live-cancel', cancelled: true } })
    expect(h.current.quakeNotice).toBeNull()
  })

  // 既知の限界を固定する: 同じ分に別のお知らせ（EventID が同じ）が出て表示を置き換えたあと、先の
  // お知らせ宛ての取消が届くと、表示中の 1 通を消す。取消は分までの EventID しか持たず、どちら宛てかを
  // 電文から決められないため。
  it('同じ EventID の別のお知らせが表示中なら、取消はそれを消す', async () => {
    const h = setup()
    await h.flush()
    push(h, { kind: 'quakeNotice', data: notice('n-a', 60_000) })
    push(h, { kind: 'quakeNotice', data: { ...notice('n-b', 60_000), eventId: 'n-a-event' } })
    expect(h.current.quakeNotice?.id).toBe('n-b')
    push(h, { kind: 'quakeNotice', data: { ...notice('n-a', 60_000), id: 'n-a-cancel', cancelled: true } })
    expect(h.current.quakeNotice).toBeNull()
  })

  // 安全弁: EventID が空の取消は照合しない（空どうしは同じお知らせの証拠にならない）。
  it('EventID が空の取消では帯を消さない', async () => {
    const h = setup()
    await h.flush()
    push(h, { kind: 'quakeNotice', data: { ...notice('n-live', 60_000), eventId: '' } })
    push(h, { kind: 'quakeNotice', data: { ...notice('n-cancel', 60_000), eventId: '', cancelled: true } })
    expect(h.current.quakeNotice?.id).toBe('n-live')
  })

  // 安全弁: 別のお知らせに向けた取消で、いま出ている帯を消さない。
  it('別のお知らせに向けた取消では帯を消さない', async () => {
    const h = setup()
    await h.flush()
    push(h, { kind: 'quakeNotice', data: notice('n-live', 60_000) })
    push(h, { kind: 'quakeNotice', data: { ...notice('n-other', 60_000), cancelled: true } })
    expect(h.current.quakeNotice?.id).toBe('n-live')
  })

  // 正: 地震回数も**期限で畳む**。気象庁はこの情報の終わりを宣言しない（群発が収まれば発表が
  // 止まるだけ）ので、次報と取消だけを畳む契機にすると、収まったあとも帯が居座る。
  //
  // 対照として、期限がまだ来ていない報は残ることも見る（「いつでも消える」ではないこと）。
  // （7 日ぶんの時間を進める形にはしない —— キューの巡回が 10ms 間隔で、6000 万回まわる。）
  it('地震回数は期限で畳む', async () => {
    const h = setup()
    await h.flush()
    push(h, { kind: 'earthquakeCount', data: count('20080824150500', [item('累積地震回数', 1704, 1)], 5_000) })
    expect(h.current.earthquakeCount?.items[0].number).toBe(1704)

    act(() => { vi.advanceTimersByTime(4_000) })
    expect(h.current.earthquakeCount?.items[0].number).toBe(1704)

    act(() => { vi.advanceTimersByTime(1_001) })
    expect(h.current.earthquakeCount).toBeNull()
  })

  // 対照: 期限切れの報は載せない（リプレイで過去の窓を再生したときに出ないこと）。
  it('期限切れの地震回数は載せない', async () => {
    const h = setup()
    await h.flush()
    push(h, { kind: 'earthquakeCount', data: count('20080824150500', [item('累積地震回数', 1704, 1)], -1_000) })
    expect(h.current.earthquakeCount).toBeNull()
  })

  // 正: 続報で置き換わる。
  it('地震回数は続報で置き換わる', async () => {
    const h = setup()
    await h.flush()
    push(h, { kind: 'earthquakeCount', data: count('20080824150500', [item('累積地震回数', 1704, 1)]) })
    push(h, { kind: 'earthquakeCount', data: count('20080824150500', [item('累積地震回数', 1810, 2)]) })
    expect(h.current.earthquakeCount?.items[0].number).toBe(1810)
  })

  // 正: 取消でカードを消す。**照合は `eventId`** ―― 回数情報は同じ群発について報を重ねるので、
  // 取消が指すのは「その群発について直前に出した報」になる。
  it('地震回数は取消で帯を消す', async () => {
    const h = setup()
    await h.flush()
    push(h, { kind: 'earthquakeCount', data: count('20080824150500', [item('累積地震回数', 1704, 1)]) })
    push(h, { kind: 'earthquakeCount', data: { ...count('20080824150500', []), cancelled: true } })
    expect(h.current.earthquakeCount).toBeNull()
  })

  // 安全弁: 別の群発に向けた取消では消さない。
  it('別の群発に向けた取消では帯を消さない', async () => {
    const h = setup()
    await h.flush()
    push(h, { kind: 'earthquakeCount', data: count('20080824150500', [item('累積地震回数', 1704, 1)]) })
    push(h, { kind: 'earthquakeCount', data: { ...count('20260101000000', []), cancelled: true } })
    expect(h.current.earthquakeCount?.eventId).toBe('20080824150500')
  })

  // 安全弁: 区間も本文も無い報は帯にしない。中身が空の帯を出しても伝わる
  // ものが無く、読み取りの失敗はパーサー側が記録している。
  it('区間も本文も無い報は帯にしない', async () => {
    const h = setup()
    await h.flush()
    push(h, { kind: 'earthquakeCount', data: count('20080824150500', []) })
    expect(h.current.earthquakeCount).toBeNull()
  })

  // 正: 回数を伴わない発表報（区間 0 件・本文あり）は帯にする
  // （2026-10-19 ユーザー承認「-1 を「発表なし」に (推奨)」）。
  it('回数を伴わない発表報は本文があれば帯にする', async () => {
    const h = setup()
    await h.flush()
    push(h, { kind: 'earthquakeCount', data: { ...count('20080824150500', []), body: '本文です。' } })
    expect(h.current.earthquakeCount?.body).toBe('本文です。')
  })

  // 安全弁: リセット（リプレイの開始・ライブ復帰）で両方とも消える。**時間軸が変わる**ので、
  // 前の軸で出した帯を残すと、再生時刻と食い違ったものが画面に居座る。
  it('リセットで両方の帯が消える', async () => {
    const h = setup()
    await h.flush()
    push(h, { kind: 'quakeNotice', data: notice('n-live', 60_000) })
    push(h, { kind: 'earthquakeCount', data: count('20080824150500', [item('累積地震回数', 1704, 1)]) })
    expect(h.current.quakeNotice).not.toBeNull()
    expect(h.current.earthquakeCount).not.toBeNull()

    act(() => { h.current.resetState() })
    expect(h.current.quakeNotice).toBeNull()
    expect(h.current.earthquakeCount).toBeNull()
  })

  // 安全弁: **種別をまたいで記憶を巻き込まない。** お知らせの取消処理が地震回数の識別子まで
  // `null` にしていたことがある（別の種別の行が紛れ込んでいた）。こうなると、そのあと届いた
  // 本物の取消が「別の群発への取消」と誤判定されて帯が消えず、しかもログには
  // それらしい説明が出るので気づけない。
  it('お知らせの取消は地震回数の記憶を巻き込まない', async () => {
    const h = setup()
    await h.flush()
    push(h, { kind: 'earthquakeCount', data: count('20080824150500', [item('累積地震回数', 1704, 1)]) })
    push(h, { kind: 'quakeNotice', data: notice('n-live', 60_000) })
    push(h, { kind: 'quakeNotice', data: { ...notice('n-live', 60_000), cancelled: true } })
    expect(h.current.quakeNotice).toBeNull()

    // ここで地震回数の記憶が消えていると、この取消が効かない
    push(h, { kind: 'earthquakeCount', data: { ...count('20080824150500', []), cancelled: true } })
    expect(h.current.earthquakeCount).toBeNull()
  })

  // 安全弁: リセットは**表示中の識別情報の記憶も落とす**。落とし忘れると、リセット後に
  // 届いた取消が「消えた帯」の id と照合され、次に出した帯を消せなくなる。
  // **帯とカードの両方で見る** —— 記憶は種別ごとに別の ref なので、片方だけ落とす形になりやすい。
  it('リセット後に同じお知らせ・同じ地震回数を出し直せる', async () => {
    const h = setup()
    await h.flush()
    push(h, { kind: 'quakeNotice', data: notice('n-live', 60_000) })
    push(h, { kind: 'earthquakeCount', data: count('20080824150500', [item('累積地震回数', 1704, 1)]) })
    act(() => { h.current.resetState() })

    push(h, { kind: 'quakeNotice', data: notice('n-live', 60_000) })
    push(h, { kind: 'earthquakeCount', data: count('20080824150500', [item('累積地震回数', 1704, 1)]) })
    expect(h.current.quakeNotice?.id).toBe('n-live')
    expect(h.current.earthquakeCount?.eventId).toBe('20080824150500')

    push(h, { kind: 'quakeNotice', data: { ...notice('n-live', 60_000), cancelled: true } })
    push(h, { kind: 'earthquakeCount', data: { ...count('20080824150500', []), cancelled: true } })
    expect(h.current.quakeNotice).toBeNull()
    expect(h.current.earthquakeCount).toBeNull()
  })
})

// 推計震度分布図の結線。
//
// 判定そのものは純関数へ切り出してテストしてある（`utils/estimatedIntensity.test.ts`）。
// **ここで見るのは包み側** —— 反映しないと決めた報で `onLiveEvent` まで止まること。
// 止め損ねると、画面の分布は据え置きのまま**音と読み上げだけが鳴り、分布モードが勝手に開く**。
// 判定が正しくても包み側で漏れるので、純関数のテストでは捕まらない。
describe('推計震度分布図の結線', () => {
  function ei(arrivalTime: string, time: string, count: number): JMAEstimatedIntensity {
    return {
      id: `ix-${time}`, time, arrivalTime,
      hypocenter: { lat: 32.6, lon: 130.7, depthKm: 10 },
      magnitude: 4.2, areaCode: 741, telegramKind: 0,
      grades: [{ scale: 4, modifier: 'none', lower: 35, upper: 44 }],
      count,
      lat: new Float32Array([32.6]), lon: new Float32Array([130.7]), si: new Uint8Array([42]),
      cellLatDeg: CELL_LAT_DEG, cellLonDeg: CELL_LON_DEG,
      bounds: { south: 32.6, north: 32.61, west: 130.7, east: 130.71 },
    }
  }
  const KUMA = ei('2026-07-28T07:27:00.000Z', '2026-07-28T07:32:00+09:00', 1693)
  const LATER = ei('2026-07-28T07:31:00.000Z', '2026-07-28T07:36:00+09:00', 812)
  // KUMA と同じ地震の続報（発現時刻が同じ・発表時刻だけ後）。
  const KUMA_FOLLOW = ei('2026-07-28T07:27:00.000Z', '2026-07-28T07:40:00+09:00', 1700)

  function push(h: ReturnType<typeof setup>, data: JMAEstimatedIntensity, silent = false) {
    act(() => { h.current.loadReplayEvents([{ payload: { kind: 'estimatedIntensity', data }, replayTime: serverDate(), silent }]) })
    act(() => { vi.advanceTimersByTime(50) })
  }

  /** 鳴らす経路へ流れた分の「初報か続報か」だけを取り出す。 */
  function isNewFlags(events: LiveEvent[]): boolean[] {
    return events
      .filter(e => (e.kind as string) === 'estimatedIntensity')
      .map(e => (e as { isNew: boolean }).isNew)
  }

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  // 正: 届いた分布を反映し、音と読み上げの経路へも流す。
  it('届いた分布を反映して鳴らす経路へ流す', async () => {
    const events: LiveEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()
    push(h, KUMA)
    expect(h.current.estimatedIntensities.map(e => e.arrivalTime)).toEqual([KUMA.arrivalTime])
    expect(events.filter(e => (e.kind as string) === 'estimatedIntensity')).toHaveLength(1)
  })

  // 正: **別の地震の分布は置き換えずに足す**（地震ごとに 1 通持つ）。前の地震のカードは
  // 自分の分布を出し続ける。
  it('別の地震の分布は足して両方持つ', async () => {
    const events: LiveEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()
    push(h, KUMA)
    push(h, LATER)
    expect(h.current.estimatedIntensities.map(e => e.arrivalTime)).toEqual([KUMA.arrivalTime, LATER.arrivalTime])
    expect(events.filter(e => (e.kind as string) === 'estimatedIntensity')).toHaveLength(2)
  })

  // 正: 遅れて届いた**別の地震の**分布も足す。新しい地震の分布は押しのけられない
  // （最新の 1 通しか持たなかった頃は、押しのけを防ぐために古い地震の分布を捨てていた）。
  it('遅れて届いた別の地震の分布も、新しい地震の分布を残したまま足す', async () => {
    const events: LiveEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()
    push(h, LATER)
    push(h, KUMA)
    expect(h.current.estimatedIntensities.map(e => e.arrivalTime)).toEqual([LATER.arrivalTime, KUMA.arrivalTime])
    expect(events.filter(e => (e.kind as string) === 'estimatedIntensity')).toHaveLength(2)
  })

  // 対照: **同じ地震の、発表が古い報では退行しない。** 到着順は発表順と一致しない
  // （分割の結合が遅れる・当日経路とライブが前後する・履歴の補完が後から届く）。
  it('同じ地震の発表が古い報では退行しない', async () => {
    const events: LiveEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()
    push(h, KUMA_FOLLOW)
    push(h, KUMA)
    expect(h.current.estimatedIntensities).toHaveLength(1)
    expect(h.current.estimatedIntensities[0]?.time).toBe(KUMA_FOLLOW.time)
    expect(events.filter(e => (e.kind as string) === 'estimatedIntensity')).toHaveLength(1)
  })

  // 安全弁: **反映しない報では鳴らす経路へも流さない。** 内容が同じ重複配信は実電文で
  // 観測している。流すと画面は変わらないのに音と読み上げだけが二度鳴る。
  it('内容が同じ重複配信では鳴らす経路へ流さない', async () => {
    const events: LiveEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()
    push(h, KUMA)
    push(h, { ...KUMA })
    expect(events.filter(e => (e.kind as string) === 'estimatedIntensity')).toHaveLength(1)
  })

  // 安全弁: リセットで記憶も落とす。落とし忘れると、再生し直した同じ分布が
  // 「重複配信」と判定されて二度と出なくなる。
  it('リセット後に同じ分布を出し直せる', async () => {
    const h = setup()
    await h.flush()
    push(h, KUMA)
    act(() => { h.current.resetState() })
    expect(h.current.estimatedIntensities).toEqual([])

    push(h, KUMA)
    expect(h.current.estimatedIntensities.map(e => e.arrivalTime)).toEqual([KUMA.arrivalTime])
  })

  // 正: **起動時の履歴（7 日）に入っていた分布も持つ**。過去の地震のカードにも分布が付く。
  // 音・読み上げの経路へは流さない（いま届いたものではない）。
  it('起動時の履歴に入っていた分布を、鳴らさずに地震ごとに持つ', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValueOnce(history({
      extras: [extra({ kind: 'estimatedIntensity', data: KUMA }), extra({ kind: 'estimatedIntensity', data: LATER })],
    }))
    const events: LiveEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()

    expect(h.current.estimatedIntensities.map(e => e.arrivalTime)).toEqual([KUMA.arrivalTime, LATER.arrivalTime])
    expect(events.filter(e => (e.kind as string) === 'estimatedIntensity')).toHaveLength(0)
  })

  // 安全弁: 履歴から黙って取り込んだ地震の続報がライブで届いたら、**「受信しました」側で読む**。
  // 分布を持ってはいるが、まだ伝えていない —— 「更新されました」と読むと、聞き手は
  // 前の報を聞き逃したと思う（判定は読み上げの台帳。→ `isNewEstimatedIntensity`）。
  it('履歴から黙って取り込んだ地震の続報は、初報として読む', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValueOnce(history({
      extras: [extra({ kind: 'estimatedIntensity', data: KUMA })],
    }))
    const events: LiveEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()

    push(h, KUMA_FOLLOW)

    expect(isNewFlags(events)).toEqual([true])
    expect(h.current.estimatedIntensities).toHaveLength(1)
    expect(h.current.estimatedIntensities[0]?.time).toBe(KUMA_FOLLOW.time)
  })

  // 正: **「もっと見る」で遡った分の分布も持つ**（押して増えたカードに分布が付く）。
  // 対照を兼ねる: 既に持っている新しい地震の分布は押しのけない。
  it('「もっと見る」で遡った分布も、今ある分布を残したまま足す', async () => {
    vi.mocked(fetchDmdataQuakeHistory)
      .mockResolvedValueOnce(history({ extras: [extra({ kind: 'estimatedIntensity', data: LATER })], hasMore: true, oldestLoadedDay: '2026-07-28' }))
      .mockResolvedValueOnce(history({ extras: [extra({ kind: 'estimatedIntensity', data: KUMA })] }))
    const events: LiveEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()

    await act(async () => { await h.current.loadMoreEarthquakes() })

    expect(h.current.estimatedIntensities.map(e => e.arrivalTime)).toEqual([LATER.arrivalTime, KUMA.arrivalTime])
    expect(events.filter(e => (e.kind as string) === 'estimatedIntensity')).toHaveLength(0)
  })

  // 正: **別の地震の分布を挟んでも、同じ地震の続報は続報として流す。**
  // 実電文（2024-01-01 の能登半島地震）がこの並びで、①本震 ②別の地震 ③本震の続報 と届いた。
  // 「いま出している 1 通」との比較だけで決めていた頃は、③が初報として読まれていた。
  it('別の地震の分布を挟んでも、同じ地震の続報は続報として流す', async () => {
    const events: LiveEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()
    push(h, KUMA)
    push(h, LATER)
    push(h, KUMA_FOLLOW)
    expect(isNewFlags(events)).toEqual([true, true, false])
  })

  // 対照: 挟まずに続けて届いた続報も、当然「続報」。
  it('続けて届いた同じ地震の続報は続報として流す', async () => {
    const events: LiveEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()
    push(h, KUMA)
    push(h, KUMA_FOLLOW)
    expect(isNewFlags(events)).toEqual([true, false])
  })

  // 安全弁: **音も声も伴わない注入では台帳へ積まない。** リプレイ開始時の初期状態は画面を
  // 組み立てるだけで何も鳴らないので、積むと直後の続報が「更新されました」と読まれ、
  // 聞き手は前の報を聞き逃したと思う。
  it('初期状態の注入は台帳へ積まない', async () => {
    const events: LiveEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()
    push(h, KUMA, true)
    expect(isNewFlags(events)).toEqual([])
    push(h, KUMA_FOLLOW)
    expect(isNewFlags(events)).toEqual([true])
  })

  // 安全弁: リセットで台帳も空にする。リプレイの開始・リセットで時間軸が変わるため、
  // 残すと新しい軸の初報が「更新されました」と読まれる。
  it('リセット後は同じ地震でも初報として流す', async () => {
    const events: LiveEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()
    push(h, KUMA)
    act(() => { h.current.resetState() })
    push(h, KUMA_FOLLOW)
    expect(isNewFlags(events)).toEqual([true, true])
  })
})

// キーが不正なとき、通信を起こす前に止まること。ここが「呼ぶかどうか」を決める最上流のゲートで、
// 下流（dmdataApiKey.test.ts・dmdata.test.ts）をいくら固めてもここが外れれば全部素通りになる。
// エフェクトの依存配列やゲートの位置が動いたときに気づけるよう、取得関数が呼ばれないことまで見る。
describe('DMDSS 版: APIキーが不正なら通信しない', () => {
  // このファイルの beforeEach は戻り値を再設定するだけで呼び出し履歴は消さない。
  // 履歴を消さずに「呼ばれないこと」を見ると、他のテストの呼び出しを拾って落ちる。
  // 逆に「呼ばれること」の側は履歴が残っているせいで常に通り、検証にならない。
  beforeEach(() => {
    vi.mocked(fetchDmdataQuakeHistory).mockClear()
  })

  it('disconnected へ落ち、理由を error に載せ、取得を一度も呼ばない', async () => {
    const h = setup({ apiKey: 'abc123あ' })
    await h.flush()

    expect(h.current.connectionStatus).toBe('disconnected')
    expect(h.current.isLoading).toBe(false)
    expect(h.current.error).toBe(DMDATA_API_KEY_INVALID_MESSAGE)
    expect(fetchDmdataQuakeHistory).not.toHaveBeenCalled()
    // WebSocket も張らない（張ると 30 秒間隔の再接続が無音で回り続ける）
    expect(sockets.length).toBe(0)
  })

  // 対照: 形が正しいキーなら従来どおり接続と取得へ進む。ゲートを広げすぎていないことの確認。
  it('形が正しいキー（ピリオド入り）は従来どおり接続へ進む', async () => {
    const h = setup({ apiKey: 'dummy.key.with-period_123' })
    await h.flush()

    expect(h.current.error).toBeNull()
    expect(fetchDmdataQuakeHistory).toHaveBeenCalled()
    expect(sockets.length).toBe(1)
    expect(sockets[0].connected).toBe(true)
  })

  // 安全弁: キーを直したら error が残らずに接続へ復帰すること。
  it('キーを直すと error が消えて接続へ復帰する', async () => {
    const view = renderHook(
      ({ apiKey }: { apiKey: string }) => useEarthquakes(undefined, apiKey, false, null),
      { initialProps: { apiKey: 'abc123あ' } },
    )
    await act(async () => { await Promise.resolve() })
    expect(view.result.current.error).toBe(DMDATA_API_KEY_INVALID_MESSAGE)

    await act(async () => {
      view.rerender({ apiKey: 'dummy.key.with-period_123' })
      await Promise.resolve()
    })

    expect(view.result.current.error).toBeNull()
    expect(view.result.current.connectionStatus).not.toBe('disconnected')
  })
})

// リプレイ開始時の地震カードの扱い。
//
// 一覧の厚みはライブと再生で基準が違う（ライブ＝件数・初期状態の再現＝時間）ため、
// 履歴は専用の口から流し込む。ここで見るのは、その口が既存カードを壊さないことと、
// 「もっと見る」がライブの最新履歴を引き込む経路を塞いであること。
describe('リプレイ開始時の地震カード', () => {
  /** 履歴の 1 通。統合は mergeQuakeHistory（本物）に任せるので最小形でよい。 */
  function quakeTelegram(eventId: string, time: string): JMAQuake {
    return {
      kind: 'quake' as const,
      id: `dmdata-quake-${eventId}-1`,
      time,
      issue: { source: '気象庁', time, type: '各地の震度情報' as const, correct: 'なし' as const },
      earthquake: {
        time,
        hypocenter: { name: '岩手県沖', latitude: 39.9, longitude: 142.2, depth: 50, magnitude: 5.1 },
        maxScale: 40,
        domesticTsunami: 'なし' as const,
      },
      points: [{ pref: '岩手県', addr: '宮古市', isArea: false, scale: 40 }],
    }
  }

  // 押すと `loadMoreEarthquakes` がライブの最新履歴を取りに行き、再生時刻より未来の地震が
  // カードに並ぶ。カードを空にするだけでボタンを残すと、再生中もこれが押せてしまう。
  it('表示をリセットすると「もっと見る」を畳む', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ hasMore: true }))
    const h = setup({ offset: null })
    await h.flush()
    expect(h.current.hasMore).toBe(true)

    act(() => { h.current.resetState() })

    expect(h.current.hasMore).toBe(false)
  })

  it('履歴を流し込むとカードが並ぶ', async () => {
    const h = setup({ offset: null })
    await h.flush()

    act(() => {
      h.current.restoreQuakeHistory([
        quakeTelegram('20260810010000', '2026-08-10T01:05:00+09:00'),
        quakeTelegram('20260810020000', '2026-08-10T02:05:00+09:00'),
      ])
    })

    expect(h.current.earthquakes).toHaveLength(2)
  })

  // 履歴の取得は初期状態の注入や本編の再生より後に終わることがある。既存のカードを
  // base に統合しないと、先に出来ていたカードを消してしまう。
  it('履歴が後から届いても、既にあるカードを消さずに統合する', async () => {
    const h = setup({ offset: null })
    await h.flush()

    act(() => { h.current.restoreQuakeHistory([quakeTelegram('20260810020000', '2026-08-10T02:05:00+09:00')]) })
    act(() => { h.current.restoreQuakeHistory([quakeTelegram('20260810010000', '2026-08-10T01:05:00+09:00')]) })

    expect(h.current.earthquakes).toHaveLength(2)
  })
})

describe('DMDSS 版: 「もっと見る」で遡れる範囲', () => {
  /** 履歴の 1 通（`リプレイ開始時の地震カード` の同名ヘルパと同じ最小形）。 */
  function quakeTelegram(eventId: string, time: string): JMAQuake {
    return {
      kind: 'quake' as const,
      id: `dmdata-quake-${eventId}-1`,
      time,
      issue: { source: '気象庁', time, type: '各地の震度情報' as const, correct: 'なし' as const },
      earthquake: {
        time,
        hypocenter: { name: '岩手県沖', latitude: 39.9, longitude: 142.2, depth: 50, magnitude: 5.1 },
        maxScale: 40,
        domesticTsunami: 'なし' as const,
      },
      points: [{ pref: '岩手県', addr: '宮古市', isArea: false, scale: 40 }],
    }
  }

  /** 呼ばれたときの `maxDays`（第 3 引数）を順に返す。 */
  function requestedDays(): number[] {
    return vi.mocked(fetchDmdataQuakeHistory).mock.calls.map(c => c[2])
  }

  /** 呼ばれたときの窓の上端（第 2 引数＝カーソル）を ISO で順に返す。 */
  function requestedBefore(): string[] {
    return vi.mocked(fetchDmdataQuakeHistory).mock.calls.map(c => c[1].toISOString())
  }

  beforeEach(() => {
    // 呼び出し履歴（`requestedDays` / `requestedBefore`）を見るので、前のテストのぶんを消して
    // おく（このファイルは `clearMocks` を使っていないため、同じ `vi.fn()` に積まれ続ける）。
    vi.mocked(fetchDmdataQuakeHistory).mockClear()
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ hasMore: true }))
  })

  // **1 週間まるごと震度1以上の地震が無いことは普通に起きる。** それは「もっと古い在庫が無い」
  // ことを何も意味しない（実測でアーカイブの目録は 135 日以上さかのぼれた）。増えたかどうかで
  // 打ち切る作りにしていた頃は、静かな 1 週間に当たった時点で以後の遡りが永久に塞がっていた。
  it('正: カードが増えなかった回でも、まだ遡れるなら押せるままにする', async () => {
    const h = setup({ offset: null })
    await h.flush()

    await act(async () => { await h.current.loadMoreEarthquakes() })

    expect(h.current.earthquakes).toHaveLength(0)
    expect(h.current.hasMore).toBe(true)
  })

  // **カーソル方式の要。** 押すたびに「前回読み切った最古の日の直前」を次の窓の上端にする。
  // 窓が重ならないので、遡るほど読み直す量が増えることがない。
  it('正: 押すたびに、前回読み切った日の手前から続きを読む', async () => {
    const h = setup({ offset: null })
    await h.flush()

    // **`setup()` の初回取得より後に仕込む**（理由は下の「取得中の解除」テストと同じ）。
    vi.mocked(fetchDmdataQuakeHistory)
      .mockResolvedValueOnce(history({ hasMore: true, oldestLoadedDay: '2026-08-20' }))
      .mockResolvedValue(history({ hasMore: true, oldestLoadedDay: '2026-08-01' }))

    await act(async () => { await h.current.loadMoreEarthquakes() })
    await act(async () => { await h.current.loadMoreEarthquakes() })

    // 上端は「前回読み切った最古の日の 00:00 JST の 1ms 前」
    const [, , third] = requestedBefore()
    expect(third).toBe(new Date(Date.parse('2026-08-20T00:00:00+09:00') - 1).toISOString())
  })

  // 「もっと見る」の取得にだけ門の印を付ける。ボタンはこの印の待ちだけを数えるので
  // （→ `components/EarthquakeTab/LoadMoreButton.tsx`）、渡し忘れると残り時間が出ず「取得中…」に戻る。
  //
  // **印は押すたびに作り直す。** 使い回すと、中断された前回の待ちが門に残ったとき、次の押下の
  // 残り時間にそれまで「自分の分」として混ざる（→ `services/dmdataRequestGates.ts` の `beginLoadMoreGateTag`）。
  it('正: 「もっと見る」は押すたびに新しい印を付けて取り、起動時の履歴は付けない', async () => {
    const h = setup({ offset: null })
    await h.flush()

    await act(async () => { await h.current.loadMoreEarthquakes() })
    await act(async () => { await h.current.loadMoreEarthquakes() })

    const tags = vi.mocked(fetchDmdataQuakeHistory).mock.calls.map(c => c[7])
    expect(tags[0]).toBeUndefined()                    // 起動時
    expect(tags[1]).toEqual({ label: 'load-more' })    // もっと見る（1 回目）
    expect(tags[2]).toEqual({ label: 'load-more' })    // もっと見る（2 回目）
    expect(tags[2]).not.toBe(tags[1])                  // 別の印
  })

  // 窓の幅は毎回同じ。**日数を伸ばしていく形へ戻さないこと** —— あれは押すたびに範囲全体を
  // 読み直す作りで、遡るほど 1 回の解析量が増えていた。
  it('正: 窓の幅は毎回一定', async () => {
    const h = setup({ offset: null })
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(
      history({ hasMore: true, oldestLoadedDay: '2026-08-20' }),
    )
    await h.flush()

    await act(async () => { await h.current.loadMoreEarthquakes() })
    await act(async () => { await h.current.loadMoreEarthquakes() })

    // 初回（起動時）だけは起動用の短い窓、以後は「もっと見る」の窓
    expect(requestedDays().slice(1)).toEqual([HISTORY_WINDOW_DAYS, HISTORY_WINDOW_DAYS])
  })

  // **元の不具合の回帰テスト。** 件数の安全弁に達して打ち切った回（窓の途中までしか読んで
  // いない）でも、在庫が残っているなら押せたままでなければならない。
  //
  // かつては呼び出し側が「要求した日数が上限に達したか」を重ねて見ており、件数で打ち切って
  // 読み残した日があってもボタンが死んだ。**症状は「9/19 に見ているのに 8/3 より前へ行けない」**で、
  // 取得は成功しているので画面には何の警告も出ない。
  it('安全弁: 件数で打ち切った回でも、在庫が残っていれば押せるままにする', async () => {
    const h = setup({ offset: null })
    await h.flush()

    // 窓の途中で目標に達した（＝読み切った最古の日が窓の下端より新しい）形
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(
      history({ hasMore: true, oldestLoadedDay: '2026-09-10' }),
    )
    for (let i = 0; i < 12; i++) {
      await act(async () => { await h.current.loadMoreEarthquakes() })
    }

    expect(h.current.hasMore).toBe(true)
  })


  // 取得側が「もう要らない（打ち切った）」と言ったら従う。日数の上限とは別の理由。
  it('対照: 取得側が打ち切ったら押せなくする', async () => {
    const h = setup({ offset: null })
    await h.flush()
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ hasMore: false }))

    await act(async () => { await h.current.loadMoreEarthquakes() })

    expect(h.current.hasMore).toBe(false)
  })

  // 押してから接続が張り直される（API キーの差し替え・リプレイの開始・試験報の設定変更）と、
  // 待っていた取得は別の時間軸の一覧へ流し込まれるので結果ごと捨てる。**そのとき「取得中」を
  // 解除しないと、冒頭のガードと噛み合ってボタンがリロードまで死ぬ**（押せない「取得中…」が
  // 残るだけで、例外もログも出ない）。
  it('安全弁: 押した後に接続が張り直されても、取得中の表示は解ける', async () => {
    const h = setup({ offset: null })
    await h.flush()
    expect(h.current.hasMore).toBe(true)

    // **`setup()` の初回取得より後に仕込む。** 先に仕込むと `mockReturnValueOnce` を
    // 初回取得が消費し、押す側は既定の解決済みモックを受け取ってこのテストが空振りする。
    let settle: (v: ReturnType<typeof history>) => void = () => {}
    vi.mocked(fetchDmdataQuakeHistory).mockReturnValueOnce(new Promise((r) => { settle = r }))
    const click = act(async () => { await h.current.loadMoreEarthquakes() })
    // 世代を進める（リプレイ開始と同じ経路）
    h.setOffset(-3600_000)
    settle(history({ hasMore: true }))
    await click

    expect(h.current.isLoadingMore).toBe(false)
  })

  // 接続を張り直す effect は、世代を進めるのと同じ同期ブロックでカーソルを初期値へ戻す。
  // 旧世代の取得結果でカーソルを進めると、**新しい時間軸の「もっと見る」が旧世代で読んだ
  // 位置から続きを読む**（その範囲は新しい軸ではまだ一度も読んでいない）。
  it('安全弁: 世代が変わった後は、旧世代の結果でカーソルを進めない', async () => {
    const h = setup({ offset: null })
    await h.flush()
    // 1 回押してカーソルを進めておく
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValueOnce(
      history({ hasMore: true, oldestLoadedDay: '2026-08-20' }),
    )
    await act(async () => { await h.current.loadMoreEarthquakes() })

    let settle: (v: ReturnType<typeof history>) => void = () => {}
    vi.mocked(fetchDmdataQuakeHistory).mockReturnValueOnce(new Promise((r) => { settle = r }))
    const click = act(async () => { await h.current.loadMoreEarthquakes() })
    // 待っているあいだに世代が進む（= カーソルは null へ戻っている）
    h.setOffset(-3600_000)
    settle(history({ hasMore: true, oldestLoadedDay: '2026-07-01' }))
    await click

    // 再生をやめて押し直すと、初回ロードが置いたカーソル（ここでは null＝現在時刻）から読む。
    // 旧世代が返した 2026-07-01 は使わない
    h.setOffset(null)
    await h.flush()
    vi.mocked(fetchDmdataQuakeHistory).mockClear()
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ hasMore: true }))
    await act(async () => { await h.current.loadMoreEarthquakes() })

    const stale = new Date(Date.parse('2026-07-01T00:00:00+09:00') - 1).toISOString()
    expect(requestedBefore()).not.toContain(stale)
  })

  // 失敗した回のぶんまでカーソルを進めると、飛ばした範囲の履歴が二度と読まれない。
  it('安全弁: 失敗したらカーソルを進めず、押し直しで同じ範囲を読む', async () => {
    const h = setup({ offset: null })
    await h.flush()
    // 1 回目を成功させてカーソルを進めておく（進んでいない状態では「据え置き」を確かめられない）
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValueOnce(
      history({ hasMore: true, oldestLoadedDay: '2026-08-20' }),
    )
    await act(async () => { await h.current.loadMoreEarthquakes() })

    vi.mocked(fetchDmdataQuakeHistory).mockRejectedValueOnce(new Error('取得に失敗'))
    await act(async () => { await h.current.loadMoreEarthquakes() })
    expect(h.current.isLoadingMore).toBe(false)
    expect(h.current.hasMore).toBe(true)

    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(
      history({
        hasMore: true, oldestLoadedDay: '2026-08-01',
        quakes: [quakeTelegram('20260810010000', '2026-08-10T01:05:00+09:00')],
      }),
    )
    await act(async () => { await h.current.loadMoreEarthquakes() })

    // 失敗した回と、その次の回が同じ上端を要求している（先へ飛ばさない）
    const [, , failed, retried] = requestedBefore()
    expect(retried).toBe(failed)
    expect(failed).toBe(new Date(Date.parse('2026-08-20T00:00:00+09:00') - 1).toISOString())
    expect(h.current.earthquakes).toHaveLength(1)
  })

  // **まるごと失敗したことも画面へ出す。** 出さないと「押したのに何も起きない」だけに見え、
  // もう一度押せば直るのか、これ以上遡れないのかが分からない。
  it('正: まるごと失敗したら印を立て、押し直して成功したら消す', async () => {
    const h = setup({ offset: null })
    await h.flush()
    expect(h.current.loadMoreFailed).toBe(false)

    vi.mocked(fetchDmdataQuakeHistory).mockRejectedValueOnce(new Error('取得に失敗'))
    await act(async () => { await h.current.loadMoreEarthquakes() })
    expect(h.current.loadMoreFailed).toBe(true)

    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ hasMore: true }))
    await act(async () => { await h.current.loadMoreEarthquakes() })

    expect(h.current.loadMoreFailed).toBe(false)
  })

  // 全滅では「その時点の全範囲」が得られていないので、前回の像をそのまま保つ
  //（`historyLoss` は置き換える値が無い）。
  it('安全弁: まるごと失敗しても、それまでに確定した損失は消さない', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(
      history({ hasMore: true, failedArchiveUrls: ['https://x/a'] }),
    )
    const h = setup({ offset: null })
    await h.flush()

    vi.mocked(fetchDmdataQuakeHistory).mockRejectedValueOnce(new Error('取得に失敗'))
    await act(async () => { await h.current.loadMoreEarthquakes() })

    expect(h.current.loadMoreFailed).toBe(true)
    expect(h.current.historyLoss.failedSources.size).toBe(1)
  })
})

describe('EEW の続報は古い報で退行しない', () => {
  // 同じ地震の報は同じ秒に複数届く（能登本震の実配信で 46 報中 13 報）。キューは電文の時刻
  // （秒精度）でしか並べ替えられず、WebSocket の受信は body の展開（gunzip）を待たずに次へ
  // 進むため、同じ秒に来た報は展開の完了順で処理されうる。順序が入れ替わったまま丸ごと
  // 上書きすると、地図の区域塗りが古い内容へ戻る。報番号で弾いていることを固定する。
  //
  // 画面上は「区域が減っただけ」に見えて電文どおりか退行かの区別がつかないため、
  // テストで押さえないと気づけない。
  const AT = '2024-01-01T16:10:20+09:00'

  /** 同一秒・同一 eventId の報。報番号と対象区域だけを変える。 */
  function report(
    serial: string, areaNames: string[], over: { serial?: string; scaleTo?: IntensityScale } = {},
  ): EEWAlert {
    return {
      kind: 'eew',
      origin: 'dmdata',
      id: `dmdata-eew-stale-${serial}`,
      time: AT,
      test: false,
      earthquake: {
        originTime: AT,
        arrivalTime: AT,
        condition: '',
        hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 10, magnitude: 7.6 },
      },
      severity: 'Warning',
      cancelled: false,
      isFinal: false,
      issue: { eventId: 'stale-event', serial: over.serial ?? serial, time: AT },
      areas: areaNames.map(name => ({ pref: '', name, scaleFrom: 40, scaleTo: over.scaleTo ?? 50, kindCode: '11', arrivalTime: null })),
    }
  }

  const areasOf = (h: ReturnType<typeof setup>) =>
    [...h.current.activeEEWs.values()][0]?.areas?.map(a => a.name) ?? []

  it('新しい報は反映する', async () => {
    const h = setup()
    await h.flush()
    act(() => { h.current.injectEvent(report('1', ['石川県能登'])) })
    act(() => { h.current.injectEvent(report('2', ['石川県能登', '富山県西部', '新潟県上越'])) })
    expect(areasOf(h)).toEqual(['石川県能登', '富山県西部', '新潟県上越'])
  })

  // 対照: これがこの修正の本体。展開順の入れ替わりを模して、古い報を後から入れる。
  it('古い報が後から届いても上書きしない', async () => {
    const h = setup()
    await h.flush()
    act(() => { h.current.injectEvent(report('2', ['石川県能登', '富山県西部', '新潟県上越'])) })
    act(() => { h.current.injectEvent(report('1', ['石川県能登'])) })
    expect(areasOf(h)).toEqual(['石川県能登', '富山県西部', '新潟県上越'])
  })

  // 安全弁 1: 同じ報番号の再送は弾かない（内容が同じなので上書きしても害がなく、
  // 弾く実装にすると「同番の訂正報」を取りこぼす）。
  it('同じ報番号の再送は受け入れる', async () => {
    const h = setup()
    await h.flush()
    act(() => { h.current.injectEvent(report('2', ['石川県能登'])) })
    act(() => { h.current.injectEvent(report('2', ['石川県能登', '富山県西部'])) })
    expect(areasOf(h)).toEqual(['石川県能登', '富山県西部'])
  })

  // 安全弁 2: 報番号が読めない報では報番号で判定しない（0 で埋めて比較すると正しい報まで
  // 捨ててしまう）。この報は発表時刻が同じなので、発表時刻の比較でも古いとは見なさない。
  it('報番号を持たない報は従来どおり後着を採る', async () => {
    const h = setup()
    await h.flush()
    act(() => { h.current.injectEvent(report('2', ['石川県能登', '富山県西部'])) })
    act(() => { h.current.injectEvent(report('x', ['石川県能登'], { serial: '' })) })
    expect(areasOf(h)).toEqual(['石川県能登'])
  })

  // 状態（activeEEWs）だけを守っても足りない。通知は setState の外・入口で走るため、
  // ここを素通ししていると地図・カードは新しい報、読み上げとウィンドウタイトルは古い報という
  // 食い違いが起きる。揃って退行するより始末が悪いので、入口で捨てることを固定する。
  it('古い報は通知（読み上げ・タイトル）へも渡さない', async () => {
    const seen: string[] = []
    const h = setup({
      onLiveEvent: (e) => { if (e.kind === 'eew') seen.push((e as EEWAlert).issue?.serial ?? '') },
    })
    await h.flush()
    act(() => { h.current.injectEvent(report('2', ['石川県能登', '富山県西部'])) })
    act(() => { h.current.injectEvent(report('1', ['石川県能登'])) })
    expect(seen).toEqual(['2'])
  })

  // 本番のキューディスパッチャは 1 ティックの中で複数のイベントを連続処理する（同じ秒の報が
  // まとめてキューに載るため、順序が入れ替わりうる場面ほどこうなる）。その間はレンダーが
  // 挟まらないので、判定を「レンダーで進む値」に頼ると直前に受理した報を見落とす。
  // レンダーを挟まない連続呼び出しでも守られることを固定する。
  it('同じティックで連続処理されても古い報を通さない（状態・通知とも）', async () => {
    const seen: string[] = []
    const h = setup({
      onLiveEvent: (e) => { if (e.kind === 'eew') seen.push((e as EEWAlert).issue?.serial ?? '') },
    })
    await h.flush()
    // 単一の act の中で 2 件続けて注入する＝間にレンダーが入らない
    act(() => {
      h.current.injectEvent(report('2', ['石川県能登', '富山県西部']))
      h.current.injectEvent(report('1', ['石川県能登']))
    })
    expect(seen).toEqual(['2'])
    expect(areasOf(h)).toEqual(['石川県能登', '富山県西部'])
  })

  // `eewSerial`（utils/eew.ts）に判定を委ねているため、0・負値・小数は報番号として採らない
  // ＝比較しない。ここを独自実装に戻すと、その値をそのまま大小比較に使ってしまう。
  it('報番号として成立しない値（0）は判定に使わない', async () => {
    const h = setup()
    await h.flush()
    act(() => { h.current.injectEvent(report('2', ['石川県能登', '富山県西部'])) })
    act(() => { h.current.injectEvent(report('0', ['石川県能登'], { serial: '0' })) })
    expect(areasOf(h)).toEqual(['石川県能登'])
  })

  // 台帳は表示が終わった EEW の分を落とす。落とさないと伸び続け、逆に落としすぎると保護が
  // 効かなくなる。解除で消えたあと、同じキーの報を初報として受け直せることで確認する。
  // **消えてから `ACTIVE_EEW_WINDOW_MS` の間は、消えた地震の記憶（`eewEndedRef`）が同じ報・古い報を弾く**
  // （2026-10-21 ユーザー承認「おすすめで」）ので、その窓を過ぎてから受け直す。
  it('表示が終わった EEW の報番号は台帳に残さない', async () => {
    vi.useFakeTimers()
    try {
      const h = setup()
      await h.flush()
      act(() => { h.current.injectEvent(report('5', ['石川県能登', '富山県西部'])) })
      expect(h.current.activeEEWs.size).toBe(1)

      // 最終報の自動解除を待つ（猶予はマグニチュード起因。十分に進めて消えるまで回す）
      act(() => { h.current.injectEvent({ ...report('6', ['石川県能登']), isFinal: true }) })
      act(() => { vi.advanceTimersByTime(30 * 60_000) })
      expect(h.current.activeEEWs.size).toBe(0)
      act(() => { vi.advanceTimersByTime(ACTIVE_EEW_WINDOW_MS + 1000) })
      // 窓を過ぎた記憶を落とすのは画面の掛け替えのとき。ここでは落ちていなくても使わない（`endedEewMatch` が経過で見る）

      // 台帳が残っていると #1 は「古い報」として弾かれ、二度と表示できなくなる
      act(() => { h.current.injectEvent(report('1', ['新潟県上越'])) })
      expect(areasOf(h)).toEqual(['新潟県上越'])
    } finally {
      vi.useRealTimers()
    }
  })

  // 安全弁 3: 取消はガードの手前で処理される。報番号で弾かれると誤報を消せなくなる。
  it('取消は報番号が古くても効く', async () => {
    const h = setup()
    await h.flush()
    act(() => { h.current.injectEvent(report('5', ['石川県能登'])) })
    act(() => {
      h.current.injectEvent({ ...report('1', []), cancelled: true })
    })
    const eew = [...h.current.activeEEWs.values()][0]
    expect(eew?.cancelledAt).toBeInstanceOf(Date)
  })

  // 取消電文だけが持つ項目は、**表示中の EEW を土台にする更新で名指しで移さないと落ちる**。
  // 地震・津波側と対の回帰テスト（3 種別すべての状態更新に同じ落とし穴がある）。
  // 描画側のテスト（`RealtimeTab/cancelReason.test.tsx`）は `EEWAlert` を直接渡すので
  // ここを通らない。両方無いと「電文は持っているのに画面へ届かない」を捕まえられない。
  it('取消の理由を表示中の EEW へ引き継ぐ', async () => {
    const h = setup()
    await h.flush()
    act(() => { h.current.injectEvent(report('1', ['石川県能登'])) })
    act(() => {
      h.current.injectEvent({
        ...report('2', []),
        cancelled: true,
        cancelText: 'システムの障害により誤った緊急地震速報を配信しました。',
      })
    })
    const eew = [...h.current.activeEEWs.values()][0]
    expect(eew?.cancelledAt).toBeInstanceOf(Date)
    expect(eew?.cancelText).toBe('システムの障害により誤った緊急地震速報を配信しました。')
  })

  // 対照: 理由を持たない取消電文では作らない（無いものを埋めない）
  it('理由を持たない取消では持たせない', async () => {
    const h = setup()
    await h.flush()
    act(() => { h.current.injectEvent(report('1', ['石川県能登'])) })
    act(() => { h.current.injectEvent({ ...report('2', []), cancelled: true }) })
    const eew = [...h.current.activeEEWs.values()][0]
    expect(eew?.cancelledAt).toBeInstanceOf(Date)
    expect(eew?.cancelText).toBeUndefined()
  })

  // 特別警報の下げ止まり（`everSpecialWarning`）。震度が下がる続報が来ても、一度特別警報
  // （震度6弱以上）に達した事実は残す（アプリ独自の判断。eew-spec.md §4）。
  describe('特別警報の下げ止まり', () => {
    // 正: 初報が特別警報相当（scaleTo:60）→続報で警報未満（scaleTo:40）に下がっても印は残る。
    it('特別警報になった後の続報で震度が下がっても印は立ったまま', async () => {
      const h = setup()
      await h.flush()
      act(() => { h.current.injectEvent(report('1', ['石川県能登'], { scaleTo: 60 })) })
      act(() => { h.current.injectEvent(report('2', ['石川県能登'], { scaleTo: 40 })) })
      const eew = [...h.current.activeEEWs.values()][0]
      expect(eew?.everSpecialWarning).toBe(true)
    })

    // 対照: 一度も特別警報相当に達していなければ印は立たない。
    it('特別警報に達していない地震では印が立たない', async () => {
      const h = setup()
      await h.flush()
      act(() => { h.current.injectEvent(report('1', ['石川県能登'], { scaleTo: 40 })) })
      act(() => { h.current.injectEvent(report('2', ['石川県能登'], { scaleTo: 40 })) })
      const eew = [...h.current.activeEEWs.values()][0]
      expect(eew?.everSpecialWarning).toBeFalsy()
    })

    // 安全弁: 解除後に別の eventId で始まった地震は、前の地震の印を引き継がない。
    it('別の地震（別 eventId）には印を引き継がない', async () => {
      const h = setup()
      await h.flush()
      act(() => { h.current.injectEvent(report('1', ['石川県能登'], { scaleTo: 60 })) })
      act(() => {
        h.current.injectEvent({
          ...report('1', ['富山県西部'], { scaleTo: 40 }),
          id: 'dmdata-eew-other-event',
          issue: { eventId: 'other-event', serial: '1', time: AT },
        })
      })
      const eews = [...h.current.activeEEWs.values()]
      const other = eews.find(e => e.issue?.eventId === 'other-event')
      expect(other?.everSpecialWarning).toBeFalsy()
    })

    // 起動時・張り直しの復元は、詳細の全報から「途中で特別警報だった」印を載せてくる。取得の間にライブの
    // 新しい報が先に着くと、復元の報は古い報として入口で捨てられる —— 報を捨てても印は移す。
    // 正: 古い報が運んだ印は、表示中の速報へ移る（報そのものの値は新しい報のまま）
    it('古い報として捨てた報が運んだ特別警報の印は、表示中の速報へ移る', async () => {
      const h = setup()
      await h.flush()
      act(() => { h.current.injectEvent(report('3', ['石川県能登'], { scaleTo: 50 })) })
      act(() => { h.current.injectEvent({ ...report('2', ['石川県能登'], { scaleTo: 50 }), everSpecialWarning: true }) })
      const eew = [...h.current.activeEEWs.values()][0]
      expect(eew?.everSpecialWarning).toBe(true)
      expect(eew?.issue?.serial).toBe('3')
    })

    // 安全弁: 取り消された速報には、印つきの古い報が着いても付けない
    it('取り消された速報には、古い報が運んだ印を付けない', async () => {
      const h = setup()
      await h.flush()
      act(() => { h.current.injectEvent(report('3', ['石川県能登'], { scaleTo: 50 })) })
      act(() => { h.current.injectEvent({ ...report('4', []), cancelled: true }) })
      act(() => { h.current.injectEvent({ ...report('2', ['石川県能登'], { scaleTo: 50 }), everSpecialWarning: true }) })
      const eew = [...h.current.activeEEWs.values()][0]
      expect(eew?.cancelledAt).toBeInstanceOf(Date)
      expect(eew?.everSpecialWarning).toBeFalsy()
    })

    // 対照: 印を運ばない古い報では立たない
    it('印を運ばない古い報では印が立たない', async () => {
      const h = setup()
      await h.flush()
      act(() => { h.current.injectEvent(report('3', ['石川県能登'], { scaleTo: 50 })) })
      act(() => { h.current.injectEvent(report('2', ['石川県能登'], { scaleTo: 50 })) })
      const eew = [...h.current.activeEEWs.values()][0]
      expect(eew?.everSpecialWarning).toBeFalsy()
    })

    // 安全弁: 移した印は次の続報にも残る。画面の状態だけでなく、受信処理へ渡す値（入口の写しから統合した報）にも載る
    // —— 写しに載せないと、状態と受信処理へ渡した値で印が食い違う。捨てた古い報そのものは受信処理へ渡さない（音を鳴らさない）
    it('移した印は次の続報で消えず、受信処理へ渡す値にも載る', async () => {
      const onLiveEvent = vi.fn()
      const h = setup({ onLiveEvent })
      await h.flush()
      act(() => { h.current.injectEvent(report('3', ['石川県能登'], { scaleTo: 50 })) })
      act(() => { h.current.injectEvent({ ...report('2', ['石川県能登'], { scaleTo: 50 }), everSpecialWarning: true }) })
      const eewCalls = () => onLiveEvent.mock.calls.map(c => c[0] as LiveEvent).filter((e): e is EEWAlert & LiveEvent => e.kind === 'eew')
      expect(eewCalls().map(e => e.issue?.serial)).toEqual(['3'])
      act(() => { h.current.injectEvent(report('4', ['石川県能登'], { scaleTo: 45 })) })
      const eew = [...h.current.activeEEWs.values()][0]
      expect(eew?.issue?.serial).toBe('4')
      expect(eew?.everSpecialWarning).toBe(true)
      const calls = eewCalls()
      expect(calls[calls.length - 1]?.everSpecialWarning).toBe(true)
    })
  })
})

// 標準版の緊急地震速報は 2 つの経路（Yahoo の hypoInfo・P2PQuake の 556）が同じ報を運ぶ。
// どちらも同じキュー・同じ台帳を通る。**運ばない欄は前の報の値を保つ**（Yahoo は区域・仮定震源・
// 到達予測を持たない）こと、**報番号は経路ごとに、発表時刻は経路をまたいで**比べること、
// **同じ報が 2 度目に届いても音を鳴らし直さない**こと、P2PQuake には最終報の印が無いので
// **見張りの解除を積む**ことを固定する（2026-10-14 ユーザー承認「直前の P2PQuake の値を保つ」
// 「解除の予約も続報の音・声も直す」、2026-10-18 ユーザー承認「最初の 1 通だけ」）。
//
// かつては P2PQuake の報をキューに通さず補完だけしていた（`enrichEEW`）。Yahoo が先に出ていると
// P2PQuake の報番号（警報だけの通し番号）と Yahoo の報番号（全報の通し番号）を同じ物差しで比べ、
// P2PQuake の内容を丸ごと捨てていた（2026-10-16 千島列島の実測: 同じ報が P2PQuake 1・2、Yahoo 17・19）。
describe('標準版: P2PQuake と Yahoo の緊急地震速報をまとめる', () => {
  beforeEach(() => {
    mockIsDmdss = false
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    setReplayOffset(null)
  })

  const T1 = '2024-01-01T16:10:20+09:00'
  const T2 = '2024-01-01T16:10:41+09:00'

  function p2p(serial: string, issueTime: string, areaNames: string[], over: Partial<EEWAlert> = {}): EEWAlert {
    return {
      kind: 'eew',
      origin: 'p2pquake',
      id: `p2p-eew-${serial}`,
      time: issueTime,
      test: false,
      earthquake: {
        originTime: T1,
        arrivalTime: T1,
        condition: '仮定震源要素',
        hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 10, magnitude: 7.6 },
      },
      severity: 'Warning',
      cancelled: false,
      isFinal: false,
      issue: { eventId: 'merge-event', serial, time: issueTime },
      areas: areaNames.map(name => ({ pref: '', name, scaleFrom: 40, scaleTo: 50, kindCode: '11', arrivalTime: null })),
      ...over,
    }
  }

  /** Yahoo の hypoInfo 由来の報。区域・仮定震源・到達予測を持たない（予想最大震度は持つ）。 */
  function yahoo(serial: string, issueTime: string, over: Partial<EEWAlert> = {}): EEWAlert {
    return {
      kind: 'eew',
      origin: 'yahoo',
      id: `yahoo-eew-${serial}`,
      time: issueTime,
      test: false,
      earthquake: {
        originTime: T1,
        arrivalTime: '',
        condition: '',
        hypocenter: { name: '能登半島沖', latitude: 37.6, longitude: 137.3, depth: 20, magnitude: 7.4 },
      },
      severity: 'Warning',
      cancelled: false,
      isFinal: false,
      issue: { eventId: 'merge-event', serial, time: issueTime },
      // P2PQuake の区域の最大（5弱）と揃える。同じ報なら同じ値を運ぶ
      forecastMaxScale: 50,
      ...over,
    }
  }

  const shown = (h: ReturnType<typeof setup>) => [...h.current.activeEEWs.values()][0]
  const areasOf = (h: ReturnType<typeof setup>) => shown(h)?.areas?.map(a => a.name) ?? []
  const sameReportMarks = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls
    .filter(([e]) => (e as LiveEvent).kind === 'eew')
    .map(([, meta]) => (meta as LiveEventMeta | undefined)?.eewSameReport === true)

  it('P2PQuake の報は WebSocket からキューを通って画面へ届く', async () => {
    const h = setup()
    await h.flush()
    // 発表時刻は「いま」に置く。古い時刻だと、見張りの解除（発表から 60 秒）がその場で発火して消える
    const now = new Date(Math.floor(serverDate().getTime() / 1000) * 1000).toISOString()
    act(() => { sockets[0].onEvent?.(p2p('1', now, ['石川県能登'])) })
    act(() => { vi.advanceTimersByTime(50) })
    expect(areasOf(h)).toEqual(['石川県能登'])
  })

  // 本体 1: Yahoo の続報が P2PQuake の区域・仮定震源を消さない
  it('Yahoo の続報は運ばない欄（区域・仮定震源）を前の P2PQuake の値のまま保ち、震源は差し替える', async () => {
    const h = setup()
    await h.flush()
    act(() => { h.current.injectEvent(p2p('1', T1, ['石川県能登', '富山県西部'])) })
    act(() => { h.current.injectEvent(yahoo('19', T2)) })
    expect(areasOf(h)).toEqual(['石川県能登', '富山県西部'])
    expect(shown(h)?.earthquake.condition).toBe('仮定震源要素')
    expect(shown(h)?.earthquake.hypocenter.name).toBe('能登半島沖')
    expect(shown(h)?.origin).toBe('yahoo')
  })

  // 本体 2: Yahoo が先に出ていても、P2PQuake の報番号は Yahoo と比べない
  it('Yahoo が先に出ていても、同じ発表時刻の P2PQuake の報は採る', async () => {
    const h = setup()
    await h.flush()
    act(() => { h.current.injectEvent(yahoo('17', T1)) })
    act(() => { h.current.injectEvent(p2p('1', T1, ['石川県能登'])) })
    expect(areasOf(h)).toEqual(['石川県能登'])
    expect(shown(h)?.earthquake.hypocenter.name).toBe('石川県能登地方')
  })

  // 遅れて届いた P2PQuake の報: 区域・仮定震源の別だけを補い、震源・報番号は新しい側のまま
  it('Yahoo の新しい報より後に着いた P2PQuake の報は、区域と仮定震源の別だけを補う', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()
    act(() => { h.current.injectEvent(yahoo('19', T2)) })
    act(() => { h.current.injectEvent(p2p('1', T1, ['新潟県上越'])) })
    expect(areasOf(h)).toEqual(['新潟県上越'])
    expect(shown(h)?.earthquake.condition).toBe('仮定震源要素')
    expect(shown(h)?.earthquake.hypocenter.name, '古い報の震源へ戻っている').toBe('能登半島沖')
    expect(shown(h)?.issue?.serial).toBe('19')
    // 新しい報ではないので音・タブ移動は起こさない
    expect(sameReportMarks(onLiveEvent)).toEqual([false, true])
  })

  // 安全弁: 遅れて届いた報でも、補った結果の区分が上がったなら知らせる
  it('遅れて届いた P2PQuake の報で区分が上がったなら「同じ報」の印を付けない', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()
    act(() => { h.current.injectEvent(yahoo('19', T2, { severity: 'Forecast' })) })
    act(() => {
      h.current.injectEvent(p2p('1', T1, [], {
        areas: [{ pref: '', name: '石川県能登', scaleFrom: 55, scaleTo: 60, kindCode: '11', arrivalTime: null }],
      }))
    })
    expect(sameReportMarks(onLiveEvent)).toEqual([false, false])
  })

  // 区域を運ばない Yahoo の続報が予想の最大震度を上げたら、保っている古い区域ではなくそちらで見る
  it('Yahoo の続報で予想の最大震度が上がれば、前の P2PQuake の区域に隠されず特別警報へ上がる', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()
    act(() => { h.current.injectEvent(p2p('1', T1, ['石川県能登'])) })
    expect(shown(h)?.everSpecialWarning).toBeFalsy()
    act(() => { h.current.injectEvent(yahoo('19', T2, { forecastMaxScale: 55 })) })
    expect(shown(h)?.everSpecialWarning, '古い区域（5弱）が新しい 6弱を隠している').toBe(true)
    // 対照: P2PQuake の新しい報が区域を運んだら、最大はまた区域で見る
    act(() => {
      h.current.injectEvent(p2p('2', '2024-01-01T16:10:50+09:00', [], {
        areas: [{ pref: '', name: '石川県能登', scaleFrom: 40, scaleTo: 45, kindCode: '11', arrivalTime: null }],
      }))
    })
    expect(shown(h)?.maxScaleFromForecast).toBe(false)
  })

  // 取消は終端: 取消の後に届いた報で音・通知・見張りを動かさない
  it('取消を受けた速報へ後から届いた報は、通知にも回さない', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()
    act(() => { h.current.injectEvent(p2p('1', T1, ['石川県能登'])) })
    act(() => { h.current.injectEvent({ ...p2p('1', T1, []), cancelled: true }) })
    const before = onLiveEvent.mock.calls.length
    act(() => { h.current.injectEvent(p2p('2', T2, ['石川県能登'])) })
    expect(onLiveEvent.mock.calls.length, '取消の後の報が通知へ回っている').toBe(before)
    expect(shown(h)?.cancelledAt).toBeDefined()
  })

  // 対照: 補うのは P2PQuake の報だけ。Yahoo の古い報は採らない
  it('受けた報より発表時刻の古い Yahoo の報は採らない', async () => {
    const h = setup()
    await h.flush()
    act(() => { h.current.injectEvent(p2p('2', T2, ['石川県能登'])) })
    act(() => { h.current.injectEvent(yahoo('17', T1)) })
    expect(shown(h)?.earthquake.hypocenter.name).toBe('石川県能登地方')
    expect(shown(h)?.issue?.serial).toBe('2')
  })

  // 対照: 同じ経路の中では報番号で比べる（同じ秒に 2 報が来る）
  it('同じ経路で報番号の古い報は採らない', async () => {
    const h = setup()
    await h.flush()
    act(() => { h.current.injectEvent(p2p('3', T1, ['石川県能登'])) })
    act(() => { h.current.injectEvent(p2p('2', T1, ['新潟県上越'])) })
    expect(areasOf(h)).toEqual(['石川県能登'])
  })

  // 音を鳴らし直さない印。読み上げ・タイトルは止めないので、通知そのものは届く。
  it('別の経路から届いた同じ報には「同じ報」の印を付け、新しい報には付けない', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()
    act(() => { h.current.injectEvent(yahoo('17', T1)) })
    act(() => { h.current.injectEvent(p2p('1', T1, ['石川県能登'])) })
    act(() => { h.current.injectEvent(p2p('2', T2, ['石川県能登'])) })
    expect(sameReportMarks(onLiveEvent)).toEqual([false, true, false])
  })

  // 安全弁: 同じ報でも区分が上がったなら鳴らす
  it('同じ報でも、まとめた結果の区分が上がったなら印を付けない', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()
    act(() => { h.current.injectEvent(yahoo('17', T1, { severity: 'Forecast' })) })
    act(() => {
      h.current.injectEvent(p2p('1', T1, [], {
        areas: [{ pref: '', name: '石川県能登', scaleFrom: 55, scaleTo: 60, kindCode: '11', arrivalTime: null }],
      }))
    })
    expect(sameReportMarks(onLiveEvent)).toEqual([false, false])
  })

  // 特別警報の下げ止まり（eew-spec.md §4）。弱い区域の続報で印を消さない。
  it('続報の区域が弱くなっても、既に立っていた特別警報の印は消えない', async () => {
    const h = setup()
    await h.flush()
    act(() => {
      h.current.injectEvent(p2p('1', T1, [], {
        areas: [{ pref: '', name: '石川県能登', scaleFrom: 55, scaleTo: 60, kindCode: '11', arrivalTime: null }],
      }))
    })
    expect(shown(h)?.everSpecialWarning).toBe(true)
    act(() => { h.current.injectEvent(p2p('2', T2, ['新潟県上越'])) })
    expect(shown(h)?.everSpecialWarning, '弱い区域の続報で印が消えている').toBe(true)
  })

  describe('P2PQuake には最終報の印が無いので、見張りの解除を積む', () => {
    // 再生側の時計に寄せる（キューは getTimeRef=serverDate で発火を決める）
    const OFFSET_MS = -3600_000
    /** 規模を小さく取り、解除までの時間を下限（発表から 60 秒）で決める。 */
    const small = (serial: string, issueTime: string, origin: 'p2pquake' | 'yahoo' = 'p2pquake') => p2p(serial, issueTime, ['石川県能登'], {
      origin,
      earthquake: {
        originTime: issueTime,
        arrivalTime: issueTime,
        condition: '',
        hypocenter: { name: 'テスト沖', latitude: 35, longitude: 140, depth: 10, magnitude: 4.0 },
      },
    })
    /** 秒単位で丸めた「いま」（発表時刻は秒までしか比べない）。 */
    const nowIso = () => new Date(Math.floor(serverDate().getTime() / 1000) * 1000).toISOString()

    it('続報が来なければ、猶予を過ぎたら消す', () => {
      setReplayOffset(OFFSET_MS)
      const h = setup({ offset: OFFSET_MS })
      act(() => { h.current.injectEvent(small('1', nowIso())) })
      act(() => { vi.advanceTimersByTime(55_000) })
      expect(h.current.activeEEWs.size).toBe(1)
      act(() => { vi.advanceTimersByTime(10_000) })
      expect(h.current.activeEEWs.size).toBe(0)
    })

    // 対照: 前の報の見張りは、より新しい報を受けていれば捨てる
    it('続報を受けていれば、前の報の見張りでは消さない', () => {
      setReplayOffset(OFFSET_MS)
      const h = setup({ offset: OFFSET_MS })
      act(() => { h.current.injectEvent(small('1', nowIso())) })
      act(() => { vi.advanceTimersByTime(30_000) })
      act(() => { h.current.injectEvent(small('2', nowIso())) })
      // 1 報目の見張り（60 秒）は過ぎたが、2 報目の見張り（90 秒）はまだ
      act(() => { vi.advanceTimersByTime(35_000) })
      expect(h.current.activeEEWs.size).toBe(1)
      act(() => { vi.advanceTimersByTime(30_000) })
      expect(h.current.activeEEWs.size).toBe(0)
    })

    // 経路をまたいで見る: Yahoo で新しい報を受けていれば、その報から測り直す
    it('別の経路（Yahoo）で新しい報を受けていれば、その報から張り直し、Yahoo が止まったら消す', () => {
      setReplayOffset(OFFSET_MS)
      const h = setup({ offset: OFFSET_MS })
      act(() => { h.current.injectEvent(small('1', nowIso())) })
      act(() => { vi.advanceTimersByTime(30_000) })
      act(() => { h.current.injectEvent(small('20', nowIso(), 'yahoo')) })
      // P2PQuake の見張り（60 秒）は過ぎたが、Yahoo の報（30 秒後）から 60 秒はまだ
      act(() => { vi.advanceTimersByTime(40_000) })
      expect(h.current.activeEEWs.size).toBe(1)
      // Yahoo の取得が止まったまま 90 秒を過ぎたら消す（捨てると居座る）
      act(() => { vi.advanceTimersByTime(25_000) })
      expect(h.current.activeEEWs.size, 'Yahoo の続報のあと見張りが残っていない').toBe(0)
    })

    // 取消を受けた速報には見張りを効かせない（取消の表示を見張りの解除で上書きしない）
    it('取消を受けていれば、見張りの解除は何もしない', () => {
      setReplayOffset(OFFSET_MS)
      const onLiveEvent = vi.fn()
      const h = setup({ offset: OFFSET_MS, onLiveEvent })
      act(() => { h.current.injectEvent(small('1', nowIso())) })
      act(() => { h.current.injectEvent({ ...small('2', nowIso()), cancelled: true }) })
      const before = onLiveEvent.mock.calls.length
      act(() => { vi.advanceTimersByTime(65_000) })
      const expiredAfter = onLiveEvent.mock.calls.slice(before)
        .filter(([e]) => (e as LiveEvent).kind === 'eew' && (e as EEWAlert).expired)
      expect(expiredAfter).toEqual([])
    })
  })
})

// 取消の後に届いた報の結線。純粋関数側（`quakeMerge.test.ts`）は判定そのものを厚く固定して
// いるが、**それを正しい引数・正しいタイミングで呼んでいるか**はここでしか見えない。
// 台帳の受け渡しを 1 箇所忘れても型チェックもユニットテストも通ってしまう（実際に、実装途中で
// 台帳を作ったのに 1 箇所も渡していない状態が敵対的レビューで観測された）。
describe('DMDSS 版: 取消の後に届いた報', () => {
  const 地震の時刻 = '2026-01-01T07:06:00+09:00'
  const 震度速報 = (id: string, time: string): JMAQuake => ({
    kind: 'quake',
    id,
    time,
    issue: { source: '気象庁', time, type: '震度速報', correct: 'なし' },
    earthquake: {
      time: 地震の時刻,
      hypocenter: { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: NaN },
      maxScale: 50,
      domesticTsunami: '調査中',
    },
    points: [{ pref: '', addr: '石川県能登', isArea: true, scale: 50 }],
  })
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    vi.useRealTimers()
    setReplayOffset(null)
  })

  const 取消 = (id: string, time: string): JMAQuake => ({
    ...震度速報(id, time),
    cancelled: true,
    earthquake: {
      time: '',
      hypocenter: { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: 0 },
      maxScale: -1,
      domesticTsunami: '不明',
    },
    points: [],
  })

  // 取消電文だけが持つ項目は、**表示中のカードを土台にする更新で名指しで移さないと落ちる**。
  // 津波側と対の回帰テスト。パーサーも読み上げも通り、オプショナルなので型検査も素通りするため、
  // ここが無いと「画面にだけ出ない」状態を検出できない。
  it('取消の理由をカードへ引き継ぐ', async () => {
    const h = setup()
    await h.flush()

    act(() => { h.current.injectEvent(震度速報('dmdata-quake-20260101160612-1', '2026-01-01T07:07:00+09:00')) })
    act(() => {
      h.current.injectEvent({
        ...取消('dmdata-quake-20260101160612-2', '2026-01-01T07:10:00+09:00'),
        cancelText: '先ほどの地震情報は誤りでしたので取り消します。',
      })
    })

    expect(h.current.earthquakes[0]?.cancelledAt).toBeInstanceOf(Date)
    expect(h.current.earthquakes[0]?.cancelText).toBe('先ほどの地震情報は誤りでしたので取り消します。')
  })

  // 対照: 理由を持たない取消電文では作らない（無いものを埋めない）
  it('理由を持たない取消では持たせない', async () => {
    const h = setup()
    await h.flush()

    act(() => { h.current.injectEvent(震度速報('dmdata-quake-20260101160613-1', '2026-01-01T07:07:00+09:00')) })
    act(() => { h.current.injectEvent(取消('dmdata-quake-20260101160613-2', '2026-01-01T07:10:00+09:00')) })

    expect(h.current.earthquakes[0]?.cancelledAt).toBeInstanceOf(Date)
    expect(h.current.earthquakes[0]?.cancelText).toBeUndefined()
  })

  it('取消より前に発表された報は、purge を過ぎて届いても採らない', async () => {
    const h = setup()
    await h.flush()

    act(() => { h.current.injectEvent(震度速報('dmdata-quake-20260101160610-1', '2026-01-01T07:07:00+09:00')) })
    expect(h.current.earthquakes).toHaveLength(1)

    // 取消を受けるとカードは 10 秒表示され、そのあと消える。
    act(() => { h.current.injectEvent(取消('dmdata-quake-20260101160610-2', '2026-01-01T07:10:00+09:00')) })
    expect(h.current.earthquakes[0]?.cancelledAt).toBeInstanceOf(Date)
    act(() => { vi.advanceTimersByTime(11_000) })
    expect(h.current.earthquakes).toHaveLength(0)

    // **カードが消えた後**に、取消より前に発表された報が遅れて届く。台帳が無いと復活する。
    act(() => { h.current.injectEvent(震度速報('dmdata-quake-20260101160610-3', '2026-01-01T07:09:00+09:00')) })
    expect(h.current.earthquakes).toHaveLength(0)
  })

  it('取消より後に発表された報は、別カードとして立てる', async () => {
    const h = setup()
    await h.flush()

    act(() => { h.current.injectEvent(震度速報('dmdata-quake-20260101160611-1', '2026-01-01T07:07:00+09:00')) })
    act(() => { h.current.injectEvent(取消('dmdata-quake-20260101160611-2', '2026-01-01T07:10:00+09:00')) })
    act(() => { vi.advanceTimersByTime(11_000) })
    expect(h.current.earthquakes).toHaveLength(0)

    act(() => { h.current.injectEvent(震度速報('dmdata-quake-20260101160611-3', '2026-01-01T07:11:00+09:00')) })
    expect(h.current.earthquakes).toHaveLength(1)
  })

  it('取消の 10 秒表示中に続報が来ても、取消の表示と消滅を妨げない', async () => {
    const h = setup()
    await h.flush()

    act(() => { h.current.injectEvent(震度速報('dmdata-quake-20260101160612-1', '2026-01-01T07:07:00+09:00')) })
    act(() => { h.current.injectEvent(取消('dmdata-quake-20260101160612-2', '2026-01-01T07:10:00+09:00')) })

    // 取消より後に発表された報。取消済みカードを置換せず、別カードとして立つ。
    act(() => { h.current.injectEvent(震度速報('dmdata-quake-20260101160612-3', '2026-01-01T07:11:00+09:00')) })
    expect(h.current.earthquakes.filter(q => q.cancelledAt)).toHaveLength(1)

    // purge が空振りせず、取消済みカードだけが消える。
    act(() => { vi.advanceTimersByTime(11_000) })
    expect(h.current.earthquakes.filter(q => q.cancelledAt)).toHaveLength(0)
    expect(h.current.earthquakes).toHaveLength(1)
  })

  // `resetState` はリプレイの開始・停止でリプレイ制御側が呼ぶ（このフックは公開するだけ）。
  it('resetState で台帳を空にする（時間軸が変わるため）', async () => {
    const h = setup()
    await h.flush()

    act(() => { h.current.injectEvent(震度速報('dmdata-quake-20260101160613-1', '2026-01-01T07:07:00+09:00')) })
    act(() => { h.current.injectEvent(取消('dmdata-quake-20260101160613-2', '2026-01-01T07:10:00+09:00')) })
    act(() => { vi.advanceTimersByTime(11_000) })
    expect(h.current.earthquakes).toHaveLength(0)

    act(() => { h.current.resetState() })

    // 台帳が空いたので、同じ報がもう一度届けばカードになる。
    act(() => { h.current.injectEvent(震度速報('dmdata-quake-20260101160613-3', '2026-01-01T07:09:00+09:00')) })
    expect(h.current.earthquakes).toHaveLength(1)
  })

  // 台帳は件数に上限を置き、古いものから落とす。向きを取り違えると「直近の取消を忘れて古い取消を
  // 覚え続ける」形になり、症状は「取り消したはずの地震が復活する」——仕様書 §6.2 が塞いだ穴へ戻る。
  it('台帳が上限を超えたら古い記録から落とす', async () => {
    const h = setup()
    await h.flush()

    // 上限（20 件）を 1 件超える取消を、それぞれ別イベントとして入れる。
    // カードが無くても記録は残る（順序の入れ替わりで取消が先に届く場合に備えるため）。
    const eventIds = Array.from({ length: 21 }, (_, i) => `2026010117${String(i).padStart(4, '0')}`)
    for (const eventId of eventIds) {
      act(() => { h.current.injectEvent(取消(`dmdata-quake-${eventId}-1`, '2026-01-01T07:10:00+09:00')) })
    }

    // 最も古い取消は台帳から落ちているので、その報は弾かれずカードになる。
    act(() => {
      h.current.injectEvent(震度速報(`dmdata-quake-${eventIds[0]}-2`, '2026-01-01T07:09:00+09:00'))
    })
    expect(h.current.earthquakes).toHaveLength(1)

    // 2 件目以降は残っているので、引き続き弾かれる（落とす向きが逆でないことの確認）。
    act(() => {
      h.current.injectEvent(震度速報(`dmdata-quake-${eventIds[1]}-2`, '2026-01-01T07:09:00+09:00'))
    })
    expect(h.current.earthquakes).toHaveLength(1)
  })

  it('対照: resetState を挟まなければ、同じ報は引き続き弾かれる', async () => {
    const h = setup()
    await h.flush()

    act(() => { h.current.injectEvent(震度速報('dmdata-quake-20260101160614-1', '2026-01-01T07:07:00+09:00')) })
    act(() => { h.current.injectEvent(取消('dmdata-quake-20260101160614-2', '2026-01-01T07:10:00+09:00')) })
    act(() => { vi.advanceTimersByTime(11_000) })

    act(() => { h.current.injectEvent(震度速報('dmdata-quake-20260101160614-3', '2026-01-01T07:09:00+09:00')) })
    expect(h.current.earthquakes).toHaveLength(0)
  })
})

// 失効の予約は「報を当てたあとの津波」の期限で決める（→ `stepTsunamiState`）。届いた報の期限だけを
// 見ていた頃は、状態が報の種類ごとに決め直す期限と食い違っていた（#836 の敵対的レビューで判明）。
describe('津波の失効予約は状態と同じ期限で動く', () => {
  const EVENT_ID = '20240101161010'
  function report(opts: {
    id: string; time: string; headType: 'VTSE41' | 'VTSE51'; grade?: 'Forecast' | 'Watch'
    validDateTime?: string; eventId?: string; cancelled?: boolean
  }): JMATsunami {
    return {
      kind: 'tsunami',
      id: opts.id,
      eventId: opts.eventId ?? EVENT_ID,
      headType: opts.headType,
      time: opts.time,
      cancelled: opts.cancelled ?? false,
      ...(opts.cancelled && { cancelReason: 'retracted' as const }),
      validDateTime: opts.validDateTime,
      issue: { source: '気象庁', time: opts.time, type: 'Focus' },
      areas: opts.cancelled ? [] : [{ grade: opts.grade ?? 'Forecast', immediate: false, name: '石川県能登' }],
    }
  }
  const EXPIRE_AT = '2024-01-02T17:00:00+09:00'

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  // 正: 期限を載せない津波注意報（VTSE41）へ引き上がったら、予報のときの期限では失効しない。
  // 状態は「期限は最新の VTSE41 が決める」で期限を消すのに、予約だけが残って注意報の発表中に
  // 「失効」していた。
  it('期限なしの注意報へ引き上がると、予報のときの失効予約は外れる', async () => {
    vi.setSystemTime(new Date('2024-01-02T16:50:00+09:00'))
    const h = setup()
    await h.flush()

    act(() => { h.current.injectEvent(report({ id: 'f', time: '2024-01-02T16:40:00+09:00', headType: 'VTSE41', validDateTime: EXPIRE_AT })) })
    act(() => { h.current.injectEvent(report({ id: 'w', time: '2024-01-02T16:50:00+09:00', headType: 'VTSE41', grade: 'Watch' })) })
    act(() => { vi.advanceTimersByTime(15 * 60_000) })

    expect(h.current.tsunamis).toHaveLength(1)
    expect(h.current.tsunamis[0].cancelledAt).toBeUndefined()
    expect(h.current.tsunamis[0].validDateTime).toBeUndefined()
  })

  // 正: 同じ周回に「期限なしの注意報」と「津波情報」が続けて届いても、予報のときの期限では失効しない。
  // 2 通目を描き直し前の状態（予報）の上で判定すると、1 通目で外した予約を古い期限で積み直していた。
  it('同じ周回に注意報と津波情報が続けて届いても、予報のときの期限では失効しない', async () => {
    vi.setSystemTime(new Date('2024-01-02T16:50:00+09:00'))
    const h = setup()
    await h.flush()

    act(() => { h.current.injectEvent(report({ id: 'f', time: '2024-01-02T16:40:00+09:00', headType: 'VTSE41', validDateTime: EXPIRE_AT })) })
    act(() => {
      h.current.injectEvent(report({ id: 'w', time: '2024-01-02T16:50:00+09:00', headType: 'VTSE41', grade: 'Watch' }))
      h.current.injectEvent(report({ id: 'i', time: '2024-01-02T16:50:30+09:00', headType: 'VTSE51' }))
    })
    act(() => { vi.advanceTimersByTime(15 * 60_000) })

    expect(h.current.tsunamis).toHaveLength(1)
    expect(h.current.tsunamis[0].cancelledAt).toBeUndefined()
  })

  // 対照: 期限を持つ予報だけなら期限で失効する（予約そのものを止めていない）。
  it('期限を持つ予報は期限で失効する', async () => {
    vi.setSystemTime(new Date('2024-01-02T16:50:00+09:00'))
    const h = setup()
    await h.flush()

    act(() => { h.current.injectEvent(report({ id: 'f', time: '2024-01-02T16:40:00+09:00', headType: 'VTSE41', validDateTime: EXPIRE_AT })) })
    act(() => { vi.advanceTimersByTime(10 * 60_000 + 5_000) })

    expect(h.current.tsunamis[0].cancelReason).toBe('expired')
  })

  // 正: 津波情報（VTSE51）だけの取消は予報を残すので、予報の期限で失効し続ける。取消を「津波全体の
  // 取消」と同じに扱っていた頃は、予約がすべて外れて予報が居座った（DMDSS 版は 24 時間の保険も無い）。
  it('津波情報だけの取消のあとも、予報は期限で失効する', async () => {
    vi.setSystemTime(new Date('2024-01-02T16:50:00+09:00'))
    const h = setup()
    await h.flush()

    act(() => { h.current.injectEvent(report({ id: 'f', time: '2024-01-02T16:40:00+09:00', headType: 'VTSE41', validDateTime: EXPIRE_AT })) })
    act(() => { h.current.injectEvent(report({ id: 'i', time: '2024-01-02T16:45:00+09:00', headType: 'VTSE51' })) })
    act(() => { h.current.injectEvent(report({ id: 'r', time: '2024-01-02T16:50:00+09:00', headType: 'VTSE51', cancelled: true })) })
    act(() => { vi.advanceTimersByTime(100) })
    expect(h.current.tsunamis[0].cancelledAt).toBeUndefined()

    act(() => { vi.advanceTimersByTime(10 * 60_000 + 5_000 - 100) })
    expect(h.current.tsunamis[0].cancelReason).toBe('expired')
  })

  // 安全弁: 表示中の津波に当たらない解除（番号の重ならない別の津波）では、予約に触れない。
  it('別の津波の解除が届いても、表示中の予報は期限で失効する', async () => {
    vi.setSystemTime(new Date('2024-01-02T16:50:00+09:00'))
    const h = setup()
    await h.flush()

    act(() => { h.current.injectEvent(report({ id: 'f', time: '2024-01-02T16:40:00+09:00', headType: 'VTSE41', validDateTime: EXPIRE_AT })) })
    act(() => {
      h.current.injectEvent({ ...report({ id: 'x', time: '2024-01-02T16:50:00+09:00', headType: 'VTSE41', eventId: '20240808164300', cancelled: true }), cancelReason: 'lifted' as const })
    })
    act(() => { vi.advanceTimersByTime(100) })
    expect(h.current.tsunamis[0].cancelledAt).toBeUndefined()

    act(() => { vi.advanceTimersByTime(10 * 60_000 + 5_000 - 100) })
    expect(h.current.tsunamis[0].cancelReason).toBe('expired')
  })
})

// 有効期限は報ではなく津波に付く事実として扱う（実データと理由は utils/tsunami の
// `latestValidDateTime`）。気象庁は期限が決まった報で一度だけ ValidDateTime を載せ、以後の
// 続報には載せない。報 1 通だけを見ると、最後の報が期限を持たない津波は失効しなくなる。
describe('津波の有効期限は報を跨いで引き継ぐ', () => {
  // 2024 年能登半島地震の並びに合わせる。10:00 の報が「01/02 17:00 まで」を伝え、10:03 の報は
  // 期限を持たない。以降、解除電文は出ない。
  const EXPIRE_AT = '2024-01-02T17:00:00+09:00'
  const WITH_EXPIRE = { id: 'noto-1', time: '2024-01-02T10:00:00+09:00', validDateTime: EXPIRE_AT }
  const WITHOUT_EXPIRE = { id: 'noto-2', time: '2024-01-02T10:03:00+09:00' }

  function forecast(opts: { id: string; time: string; validDateTime?: string; eventId?: string }): JMATsunami {
    return {
      kind: 'tsunami',
      id: opts.id,
      eventId: opts.eventId ?? 'noto-tsunami',
      time: opts.time,
      cancelled: false,
      validDateTime: opts.validDateTime,
      issue: { source: '気象庁', time: opts.time, type: 'Focus' },
      areas: [{ grade: 'Forecast', immediate: false, name: '石川県能登' }],
    }
  }

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('期限を持たない続報を受けてもカードは期限を保つ', async () => {
    vi.setSystemTime(new Date('2024-01-02T16:50:00+09:00'))
    const h = setup()
    await h.flush()

    act(() => { h.current.injectEvent(forecast(WITH_EXPIRE)) })
    act(() => { h.current.injectEvent(forecast(WITHOUT_EXPIRE)) })
    act(() => { vi.advanceTimersByTime(100) })

    expect(h.current.tsunamis[0].id).toBe('noto-2')
    expect(h.current.tsunamis[0].validDateTime).toBe(EXPIRE_AT)
  })

  // 電文の本文（`Body/Text`）も報を跨いで引き継ぐ。**気象庁は毎報には載せない** ——
  // 実電文を数えると津波予報の VTSE41 の半数に入るだけで、続報の VTSE51/52 には 1 通も無い。
  // 引き継がないと「いつ来ていつまで続くか」が最初の観測情報で消える（この等級では区域に
  // 波高も到達時刻も付かないので、その文にしか無い）。
  it('本文を持たない続報を受けてもカードは本文を保つ', async () => {
    vi.setSystemTime(new Date('2024-01-02T16:50:00+09:00'))
    const h = setup()
    await h.flush()
    const BODY = '若干の海面変動が予想される時刻は、早い沿岸で０２日１０時３０分頃です。'

    act(() => { h.current.injectEvent({ ...forecast(WITH_EXPIRE), bodyText: BODY }) })
    act(() => { h.current.injectEvent(forecast(WITHOUT_EXPIRE)) })
    act(() => { vi.advanceTimersByTime(100) })

    expect(h.current.tsunamis[0].id).toBe('noto-2')
    expect(h.current.tsunamis[0].bodyText).toBe(BODY)
  })

  // 対照: 新しい報が本文を持てばそちらへ従う（前報で固定しない）
  it('本文を持つ続報ではそちらへ差し替わる', async () => {
    vi.setSystemTime(new Date('2024-01-02T16:50:00+09:00'))
    const h = setup()
    await h.flush()

    act(() => { h.current.injectEvent({ ...forecast(WITH_EXPIRE), bodyText: '前の本文' }) })
    act(() => { h.current.injectEvent({ ...forecast(WITHOUT_EXPIRE), bodyText: '新しい本文' }) })
    act(() => { vi.advanceTimersByTime(100) })

    expect(h.current.tsunamis[0].bodyText).toBe('新しい本文')
  })

  // 安全弁: 別の津波へ持ち込まない。引き継ぎは `isTsunamiContinuation`（`eventId` 一致）の
  // 内側でしか働かないことを固定する —— 緩めると、無関係な津波の本文を出すことになる。
  it('別イベントの津波には前報の本文を引き継がない', async () => {
    vi.setSystemTime(new Date('2024-01-02T16:50:00+09:00'))
    const h = setup()
    await h.flush()

    act(() => { h.current.injectEvent({ ...forecast(WITH_EXPIRE), bodyText: '能登の本文' }) })
    act(() => {
      h.current.injectEvent(forecast({ ...WITHOUT_EXPIRE, eventId: 'hyuganada-tsunami' }))
    })
    act(() => { vi.advanceTimersByTime(100) })

    expect(h.current.tsunamis[0].bodyText).toBeUndefined()
  })

  // 観測状況を確定した時刻（`Head/TargetDateTime`）も `bodyText` と同じ `sameEvent` の内側で
  // 引き継ぐ。**3 つのフィールドが同じ門を共有している**ので、片方だけ門を狭める変更が
  // 入っても気づけるよう、それぞれに対を置く。
  //
  // 正: 観測時点を持たない続報（等級の発表）が挟まっても、前報の値が残る。入るのは観測情報
  // （VTSE51/52）だけなので、落とすとカードの「観測 ◯◯ 時点」が出たり消えたりする。
  it('観測時点を持たない続報が挟まっても前報の観測時点が残る', async () => {
    vi.setSystemTime(new Date('2024-01-02T16:50:00+09:00'))
    const h = setup()
    await h.flush()

    act(() => { h.current.injectEvent({ ...forecast(WITH_EXPIRE), observationDateTime: '2024-01-02T16:45:00+09:00' }) })
    act(() => { h.current.injectEvent(forecast(WITHOUT_EXPIRE)) })
    act(() => { vi.advanceTimersByTime(100) })

    expect(h.current.tsunamis[0].observationDateTime).toBe('2024-01-02T16:45:00+09:00')
  })

  // 対照: 新しい観測時点を持つ続報が来たらそちらへ従う（古い値に居座らせない）。
  it('新しい観測時点を持つ続報ではそちらへ従う', async () => {
    vi.setSystemTime(new Date('2024-01-02T16:50:00+09:00'))
    const h = setup()
    await h.flush()

    act(() => { h.current.injectEvent({ ...forecast(WITH_EXPIRE), observationDateTime: '2024-01-02T16:45:00+09:00' }) })
    act(() => { h.current.injectEvent({ ...forecast(WITHOUT_EXPIRE), observationDateTime: '2024-01-02T16:48:00+09:00' }) })
    act(() => { act(() => { vi.advanceTimersByTime(100) }) })

    expect(h.current.tsunamis[0].observationDateTime).toBe('2024-01-02T16:48:00+09:00')
  })

  // 安全弁: 別の津波へ持ち込まない（`bodyText` と同じ門の内側であることを固定する）。
  it('別イベントの津波には前報の観測時点を引き継がない', async () => {
    vi.setSystemTime(new Date('2024-01-02T16:50:00+09:00'))
    const h = setup()
    await h.flush()

    act(() => { h.current.injectEvent({ ...forecast(WITH_EXPIRE), observationDateTime: '2024-01-02T16:45:00+09:00' }) })
    act(() => {
      h.current.injectEvent(forecast({ ...WITHOUT_EXPIRE, eventId: 'hyuganada-tsunami' }))
    })
    act(() => { vi.advanceTimersByTime(100) })

    expect(h.current.tsunamis[0].observationDateTime).toBeUndefined()
  })

  it('日時として読めない期限を持つ続報でも、カードには前報の読める期限が残る', async () => {
    vi.setSystemTime(new Date('2024-01-02T16:50:00+09:00'))
    const h = setup()
    await h.flush()

    act(() => { h.current.injectEvent(forecast(WITH_EXPIRE)) })
    act(() => { h.current.injectEvent(forecast({ ...WITHOUT_EXPIRE, validDateTime: '壊れた期限' })) })
    act(() => { vi.advanceTimersByTime(100) })

    expect(h.current.tsunamis[0].validDateTime).toBe(EXPIRE_AT)
  })

  it('履歴からの復元でも期限を引き継ぎ、期限を過ぎたら失効する', async () => {
    vi.setSystemTime(new Date('2024-01-02T16:50:00+09:00'))
    // 履歴は新しい順に並ぶとは限らないため、実装側の並べ替えに任せて逆順で渡す
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ tsunamis: [forecast(WITH_EXPIRE), forecast(WITHOUT_EXPIRE)] }))
    const h = setup()
    await h.flush()

    expect(h.current.tsunamis).toHaveLength(1)
    expect(h.current.tsunamis[0].id).toBe('noto-2')

    act(() => { vi.advanceTimersByTime(9 * 60_000) })
    expect(h.current.tsunamis[0].cancelledAt).toBeUndefined()

    act(() => { vi.advanceTimersByTime(2 * 60_000) })
    expect(h.current.tsunamis[0].cancelReason).toBe('expired')
  })

  // **ライブ受信では出るのにリロードすると消える、を防ぐ。** 履歴からの復元は最新の 1 報だけを
  // 画面へ載せるため、続報の上書きと同じものを引き継がないと片方だけ落ちる。
  it('履歴からの復元でも本文を引き継ぐ', async () => {
    vi.setSystemTime(new Date('2024-01-02T16:50:00+09:00'))
    const BODY = '若干の海面変動が予想される時刻は、早い沿岸で０２日１０時３０分頃です。'
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ tsunamis: [
      { ...forecast(WITH_EXPIRE), bodyText: BODY },
      forecast(WITHOUT_EXPIRE),
    ] }))
    const h = setup()
    await h.flush()

    expect(h.current.tsunamis[0].id).toBe('noto-2')
    expect(h.current.tsunamis[0].bodyText).toBe(BODY)
  })

  it('履歴からの復元で、期限を過ぎていれば最初から表示しない', async () => {
    vi.setSystemTime(new Date('2024-01-02T17:30:00+09:00'))
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ tsunamis: [forecast(WITH_EXPIRE), forecast(WITHOUT_EXPIRE)] }))
    const h = setup()
    await h.flush()

    expect(h.current.tsunamis).toEqual([])
  })

  // standard 版（P2PQuake）は 552 に期限相当のフィールドを持たないため、この引き継ぎは何もしない。
  // 「持たないこと」を固定しておく（API が拡張されて期限相当の値が現れたら、ここが落ちて気づける）。
  it('standard 版では期限を持たないため引き継ぎが働かず、解除電文で消えるまで残る', async () => {
    vi.setSystemTime(new Date('2024-01-02T17:30:00+09:00'))
    mockIsDmdss = false
    vi.mocked(fetchHistory).mockResolvedValue([
      { ...forecast(WITH_EXPIRE), eventId: undefined, validDateTime: undefined },
      { ...forecast(WITHOUT_EXPIRE), eventId: undefined, validDateTime: undefined },
    ] as unknown as AppEvent[])
    const h = setup()
    await h.flush()

    expect(h.current.tsunamis.map(t => t.id)).toEqual(['noto-2'])
    expect(h.current.tsunamis[0].validDateTime).toBeUndefined()
  })

  it('別イベントの報からは期限を引き継がない（無関係な期限で消さない）', async () => {
    vi.setSystemTime(new Date('2024-01-02T17:30:00+09:00'))
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ tsunamis: [
      forecast({ ...WITH_EXPIRE, eventId: 'other-tsunami' }),
      forecast(WITHOUT_EXPIRE),
    ] }))
    const h = setup()
    await h.flush()

    expect(h.current.tsunamis.map(t => t.id)).toEqual(['noto-2'])
  })
})

// 南海トラフ臨時情報の取消は「その電文が指す情報単位」だけを消す。
//
// **ライブ受信（WebSocket）とキュー（リプレイ・テストボタン）の 2 経路がある。** 規則を片方に
// しか書かなかったため、テストとリプレイでは防げるのに本番の受信では素通りする、という状態を
// 一度作った。ここで両経路を通す。
describe('南海トラフ臨時情報の取消の適用先', () => {
  function nankai(eventId: string, o: Record<string, unknown> = {}) {
    const now = serverDate().toISOString()
    return {
      kind: 'nankai' as const,
      data: {
        id: `n-${eventId}`, time: now, eventId,
        kindCode: '0202', kindName: '巨大地震注意',
        headline: '南海トラフ地震臨時情報（巨大地震注意）', body: '',
        cancelled: false, reportDateTime: now,
        ...o,
      },
    }
  }

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('正: ライブ受信でも、別の識別情報への取消では帯を消さない', async () => {
    const h = setup()
    await h.flush()
    act(() => { sockets[0].onEvent?.(nankai('evt-A')) })
    expect(h.current.nankai?.eventId).toBe('evt-A')

    // 遅れて届いた別の情報単位への取消
    act(() => { sockets[0].onEvent?.(nankai('evt-OLD', { cancelled: true, retracted: true, kindCode: '', kindName: '' })) })
    expect(h.current.nankai?.eventId).toBe('evt-A')
  })

  it('正: 同じ識別情報への取消なら帯を消す', async () => {
    const h = setup()
    await h.flush()
    act(() => { sockets[0].onEvent?.(nankai('evt-A')) })
    act(() => { sockets[0].onEvent?.(nankai('evt-A', { cancelled: true, retracted: true, kindCode: '', kindName: '' })) })
    expect(h.current.nankai).toBeNull()
  })

  // 安全弁: **これを照合すると帯が永久に消えない。** 「調査終了」は気象庁が調査の結果として
  // 発表する別の報で、臨時情報は発表ごとに別の識別情報を割り振るため、段階の報と一致しない
  it('安全弁: 識別情報が違っても「調査終了」では帯を消す', async () => {
    const h = setup()
    await h.flush()
    act(() => { sockets[0].onEvent?.(nankai('evt-A')) })
    act(() => {
      sockets[0].onEvent?.(nankai('evt-B', { cancelled: true, kindCode: '0204', kindName: '調査終了' }))
    })
    expect(h.current.nankai).toBeNull()
  })

  it('安全弁: 見送った取消では読み上げ・通知のイベントを起こさない', async () => {
    const events: unknown[] = []
    const h = setup({ onLiveEvent: (e: unknown) => { events.push(e) } })
    await h.flush()
    act(() => { sockets[0].onEvent?.(nankai('evt-A')) })
    const before = events.length
    act(() => { sockets[0].onEvent?.(nankai('evt-OLD', { cancelled: true, retracted: true, kindCode: '', kindName: '' })) })
    // 帯を消していないので、「取り消されました」を伝える経路にも乗せない
    expect(events.length).toBe(before)
  })

  it('正: 何も表示していないときの取消は、読み上げ・通知を起こさない', async () => {
    // 帯を出していない状態で古い取消が届く経路（起動直後・再接続直後）。取り消された情報
    // そのものを利用者は見ていないので、「取り消されました」と告げても伝わらない
    const events: unknown[] = []
    const h = setup({ onLiveEvent: (e: unknown) => { events.push(e) } })
    await h.flush()
    const before = events.length
    act(() => { sockets[0].onEvent?.(nankai('evt-X', { cancelled: true, retracted: true, kindCode: '', kindName: '' })) })
    expect(events.length).toBe(before)
    expect(h.current.nankai).toBeNull()
  })

  it('対照: 何も表示していなくても「調査終了」は伝える', async () => {
    // 調査終了はそれ自体が意味を持つ報（調査の結果が通常の範囲内だった）。取消と違い、
    // 対象の帯を見ていなくても伝わる。**取消の抑制をここまで広げないこと**
    const events: unknown[] = []
    const h = setup({ onLiveEvent: (e: unknown) => { events.push(e) } })
    await h.flush()
    const before = events.length
    act(() => { sockets[0].onEvent?.(nankai('evt-Y', { cancelled: true, kindCode: '', kindName: '調査終了' })) })
    expect(events.length).toBe(before + 1)
  })
})

// テストボタンが張る「待ち」を、リセットとアンマウントで確実に落とすこと。
// 落とす先は `clearTestSimulationTimers` の 1 箇所に集約してある。
//
// **多くがキューを通らない経路。** 津波と EEW のテストは `handleEvent` を直接呼ぶので、
// `eventQueueRef.current.clear()` では止まらない。待ちを ref で追えていないと、
// リセット済みの画面へ電文が 1 通だけ単独で届く —— **例外もログも出ない。**
//
// 症状は待ちの種類で重さが違う。津波の解除は画面に出ないぶん音と読み上げだけが鳴るが、
// **EEW の最終報はカードごと生える。**
//
// 地震回数・南海トラフの取消テストも同じ形の待ちを持つ（そちらはキュー経由だが、
// **待ちそのものは同じように取り残されうる**）。
describe('テストボタンの待ちの後始末', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  // 正: 押しっぱなしにすれば続報は届く（待ちが機能していることの確認）。
  it('津波の等級変化テストは続報を届ける', async () => {
    const h = setup()
    await h.flush()
    await act(async () => { await h.current.simulateTsunamiGradeChange() })
    expect(h.current.tsunamis[0]?.areas.some(a => a.lastGrade)).toBe(false)

    // TEST_AUTO_DISMISS_MS(90s) の半分で続報が入る
    act(() => { vi.advanceTimersByTime(46_000) })
    expect(h.current.tsunamis[0]?.areas.some(a => a.lastGrade)).toBe(true)
  })

  // 対照: リセットを挟めば、その後に待ちが明けても何も起きない。
  // **ここが落ちると、消したはずの津波が 45 秒後に単独で復活する。**
  it('リセット後は津波の続報が届かない', async () => {
    const h = setup()
    await h.flush()
    await act(async () => { await h.current.simulateTsunamiGradeChange() })
    expect(h.current.tsunamis.length).toBeGreaterThan(0)

    act(() => { h.current.resetState() })
    expect(h.current.tsunamis).toEqual([])

    act(() => { vi.advanceTimersByTime(120_000) })
    expect(h.current.tsunamis).toEqual([])
  })

  // 対照: 地震回数の取消テストも同じ。
  it('リセット後は地震回数の取消が届かない', async () => {
    const h = setup()
    await h.flush()
    await act(async () => { await h.current.simulateEarthquakeCountRetraction() })
    act(() => { vi.advanceTimersByTime(50) })
    expect(h.current.earthquakeCount).not.toBeNull()

    act(() => { h.current.resetState() })
    expect(h.current.earthquakeCount).toBeNull()

    // 取消が遅れて届いても、リセット後の画面には何も起こさない
    act(() => { vi.advanceTimersByTime(120_000) })
    expect(h.current.earthquakeCount).toBeNull()
  })

  // 安全弁: 押し直したときに前の待ちを引きずらない。**前の待ちが生きていると、
  // 2 回目の発表に対して 1 回目の続報が割り込む**（報番号も内容も噛み合わない）。
  it('押し直すと前の待ちは落ちる', async () => {
    const h = setup()
    await h.flush()
    await act(async () => { await h.current.simulateTsunamiGradeChange() })
    act(() => { vi.advanceTimersByTime(30_000) })
    // 30 秒目で押し直す（1 回目の続報はまだ来ていない）
    await act(async () => { await h.current.simulateTsunamiGradeChange() })

    // 1 回目の待ちが生きていれば、ここで続報が入ってしまう（押し直しから 16 秒しか経っていない）
    act(() => { vi.advanceTimersByTime(16_000) })
    expect(h.current.tsunamis[0]?.areas.some(a => a.lastGrade)).toBe(false)

    // 2 回目の待ちは正しく明ける
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(h.current.tsunamis[0]?.areas.some(a => a.lastGrade)).toBe(true)
  })

  // ── 失効時刻テスト（津波警報 → 津波予報）──
  //
  // **2 本のタイマーを 1 つのコールバックの中で入れ替える**ので、他のテストボタンより配線が
  // 込み合っている —— 段 2 を流す直前に `runSimulateTsunami` が張った解除の待ちを落とし、
  // 以後は失効時刻の予約（`cancelReason: 'expired'`）に任せる。**落とし忘れれば解除電文で
  // 消え、落としすぎれば警報が画面に居座る。** どちらも型検査には掛からない。

  // 正: 押しっぱなしにすれば 45 秒後に予報へ下がり、失効時刻が付く。
  it('失効時刻テストは 45 秒後に予報へ降格した続報を届ける', async () => {
    const h = setup()
    await h.flush()
    await act(async () => { await h.current.simulateTsunamiExpiry() })
    // 1 段目は津波警報。失効時刻はまだ無い
    expect(h.current.tsunamis[0]?.areas.some(a => a.grade === 'Warning')).toBe(true)
    expect(h.current.tsunamis[0]?.validDateTime).toBeUndefined()

    act(() => { vi.advanceTimersByTime(46_000) })
    expect(h.current.tsunamis[0]?.areas.some(a => a.grade === 'Warning')).toBe(false)
    expect(h.current.tsunamis[0]?.validDateTime).toBeTruthy()
  })

  // 正: そのまま待てば、解除電文ではなく**失効**で消える（予報だけになった津波に解除は出ない）。
  it('失効時刻テストは解除電文ではなく失効でカードを閉じる', async () => {
    const h = setup()
    await h.flush()
    await act(async () => { await h.current.simulateTsunamiExpiry() })
    act(() => { vi.advanceTimersByTime(46_000) })
    expect(h.current.tsunamis[0]?.cancelledAt).toBeUndefined()

    // 降格報から 45 秒で失効時刻に達する
    act(() => { vi.advanceTimersByTime(46_000) })
    expect(h.current.tsunamis[0]?.cancelledAt).toBeInstanceOf(Date)
    expect(h.current.tsunamis[0]?.cancelReason).toBe('expired')
  })

  // 対照: リセットを挟めば、その後に待ちが明けても何も起きない。
  // **ここが落ちると、消したはずの画面へ 45 秒後に津波予報が単独で生える。**
  it('リセット後は失効時刻テストの続報が届かない', async () => {
    const h = setup()
    await h.flush()
    await act(async () => { await h.current.simulateTsunamiExpiry() })
    expect(h.current.tsunamis.length).toBeGreaterThan(0)

    act(() => { h.current.resetState() })
    expect(h.current.tsunamis).toEqual([])

    act(() => { vi.advanceTimersByTime(120_000) })
    expect(h.current.tsunamis).toEqual([])
  })

  // 安全弁: 押し直したときに前の待ちを引きずらない。
  it('失効時刻テストを押し直すと前の待ちは落ちる', async () => {
    const h = setup()
    await h.flush()
    await act(async () => { await h.current.simulateTsunamiExpiry() })
    act(() => { vi.advanceTimersByTime(30_000) })
    // 30 秒目で押し直す（1 回目の続報はまだ来ていない）
    await act(async () => { await h.current.simulateTsunamiExpiry() })

    // 1 回目の待ちが生きていれば、ここで降格報が入ってしまう（押し直しから 16 秒しか経っていない）
    act(() => { vi.advanceTimersByTime(16_000) })
    expect(h.current.tsunamis[0]?.validDateTime).toBeUndefined()

    // 2 回目の待ちは正しく明ける
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(h.current.tsunamis[0]?.validDateTime).toBeTruthy()
  })

  /** 生の電文から種別で絞る（state に出ない解除・取消はこちらでしか見えない）。 */
  function kindsOf(events: LiveEvent[], kind: LiveEvent['kind']): LiveEvent[] {
    return events.filter(e => e.kind === kind)
  }

  // 正: リセットを挟まなければ、EEW の最終報は沈黙時間（10 秒）の後に届く。
  it('EEW テストは最終報を届ける', async () => {
    const events: LiveEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()

    await act(async () => { await h.current.simulateEEWForecast() })
    act(() => { vi.advanceTimersByTime(10_000) })

    const eews = kindsOf(events, 'eew') as EEWAlert[]
    expect(eews.length).toBe(2)
    expect(eews[1].isFinal).toBe(true)
  })

  // 対照: リセットを挟めば最終報は届かない。
  // **ここが落ちると、消したはずの画面に EEW がカードごと 1 枚生える。**
  it('リセット後は EEW の最終報が届かない', async () => {
    const events: LiveEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()

    await act(async () => { await h.current.simulateEEWForecast() })
    expect(h.current.activeEEWs.size).toBe(1)

    act(() => { h.current.resetState() })
    expect(h.current.activeEEWs.size).toBe(0)

    events.length = 0
    act(() => { vi.advanceTimersByTime(120_000) })
    expect(kindsOf(events, 'eew')).toEqual([])
    expect(h.current.activeEEWs.size).toBe(0)
  })

  // 対照: EEW 誤報取消の待ちも同じ。**取消は音・通知・読み上げを伴う**ので、
  // 取り残すとリセット後に「誤報でした」とだけ鳴る。
  it('リセット後は EEW の誤報取消が届かない', async () => {
    const events: LiveEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()

    await act(async () => { await h.current.simulateEEWRetraction() })
    expect(h.current.activeEEWs.size).toBe(1)

    act(() => { h.current.resetState() })
    events.length = 0
    act(() => { vi.advanceTimersByTime(120_000) })

    expect(kindsOf(events, 'eew')).toEqual([])
  })

  // 対照: 津波テストの自動解除も同じ。**解除は画面を変えないので state では見えない** ——
  // 音と読み上げは表示中の津波の有無を判定せずに走る（→ docs/spec/tsunami-spec.md §5）ため、
  // 生の電文で見る。
  it('リセット後は津波の自動解除が届かない', async () => {
    const events: LiveEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()

    await act(async () => { await h.current.simulateTsunamiWatch() })
    expect(h.current.tsunamis.length).toBeGreaterThan(0)

    act(() => { h.current.resetState() })
    expect(h.current.tsunamis).toEqual([])

    events.length = 0
    act(() => { vi.advanceTimersByTime(120_000) })
    expect(kindsOf(events, 'tsunami')).toEqual([])
  })

  // 安全弁: 南海トラフ臨時情報の取消。**この ref は元から配線済み**で今回直した穴ではないが、
  // 6 つのうちこれだけ固定が無いと、次に `clearTestSimulationTimers` を書き換えたとき
  // 1 つだけ検知が効かなくなる。上の 3 つ（対照）とは性質が違う。
  it('リセット後は南海トラフ臨時情報の取消が届かない', async () => {
    const h = setup()
    await h.flush()

    await act(async () => { await h.current.simulateNankaiRetraction() })
    act(() => { vi.advanceTimersByTime(50) })
    expect(h.current.nankai).not.toBeNull()

    act(() => { h.current.resetState() })
    expect(h.current.nankai).toBeNull()

    act(() => { vi.advanceTimersByTime(120_000) })
    expect(h.current.nankai).toBeNull()
  })

  // 安全弁: 落とすのは待ちだけでなく**種別ごとの記憶（報番号・eventId）も**。
  // 記憶を残したまま待ちだけ落とすと、リセット後の 1 通目が #2 として届き、
  // 前の時間軸の eventId を引きずる。
  it('リセット後に押し直すと EEW は初報から始まる', async () => {
    const h = setup()
    await h.flush()

    await act(async () => { await h.current.simulateEEWForecast() })
    const first = [...h.current.activeEEWs.values()][0]
    expect(first.issue?.serial).toBe('1')

    act(() => { vi.advanceTimersByTime(3_000) })
    await act(async () => { await h.current.simulateEEWForecast() })
    expect([...h.current.activeEEWs.values()][0].issue?.serial).toBe('2')

    act(() => { h.current.resetState() })
    await act(async () => { await h.current.simulateEEWForecast() })
    const restarted = [...h.current.activeEEWs.values()][0]
    expect(restarted.issue?.serial).toBe('1')
    expect(restarted.issue?.eventId).not.toBe(first.issue?.eventId)
  })

  // 正: 3 つ目の形（`setTimeout` を張らず、キューへ発火時刻つきで積む）も待ちとして働くこと。
  // 推計震度分布図テストは地震情報を先に出し、`TEST_ESTIMATED_INTENSITY_DELAY_MS` 後に分布を流す。
  it('推計震度分布図テストは地震情報の後から分布を届ける', async () => {
    const h = setup()
    await h.flush()

    await act(async () => { await h.current.simulateEstimatedIntensity() })
    expect(h.current.estimatedIntensities).toHaveLength(0)

    act(() => { vi.advanceTimersByTime(5_000) })
    expect(h.current.estimatedIntensities).toHaveLength(1)
  })

  // 正: 続報まで流し、**初報と続報で「初めて受信したか」の印が入れ替わる**こと。
  // 読み上げが「受信しました」／「更新されました」を言い分ける唯一の材料で、印が
  // 付かないまま渡ると続報が初報と同じ文で読まれる（画面にも記録にも出ない食い違い）。
  it('推計震度分布図テストは続報まで流し、続報には更新の印が付く', async () => {
    const events: LiveEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()

    await act(async () => { await h.current.simulateEstimatedIntensity() })
    // 続報は初報の 16 秒後（`TEST_ESTIMATED_INTENSITY_FOLLOW_UP_DELAY_MS`）。初報の読み上げが
    // 鳴り終わるまで空けてあるので、10 秒では届かない。
    act(() => { vi.advanceTimersByTime(30_000) })

    const distributions = events.filter(
      (e): e is Extract<LiveEvent, { kind: 'estimatedIntensity' }> => e.kind === 'estimatedIntensity',
    )
    expect(distributions.map(e => e.isNew)).toEqual([true, false])
  })

  // 対照: **続報は同じ地震のものであること。** 発現時刻を進めてしまうと「別の地震へ入れ替え」
  // 扱いになり、反映はされるのに読み上げは初報と同じ文へ戻る（上のテストだけでは、印が
  // `[true, true]` になった理由が発現時刻のずれなのか写像のせいなのか分からない）。
  it('推計震度分布図テストの続報は同じ地震の発現時刻を保つ', async () => {
    const { createTestEstimatedIntensity } = await import('../utils/testData')
    const { quake, estimated, followUp } = createTestEstimatedIntensity()
    expect(followUp.arrivalTime).toBe(estimated.arrivalTime)
    expect(followUp.arrivalTime).toBe(quake.earthquake.time)
    // 発表時刻だけが進む（反映の判定はここしか見ない）
    expect(followUp.time > estimated.time).toBe(true)
  })

  // 正: 訂正報テストも同じ形（キューへ 2 通積む）で、**同じカードが更新される**こと。
  // 枚数まで見るのは、`eventId` を取り違えると 2 枚に割れるため —— そうなると「訂正された」
  // ようには見えず、印だけが別のカードに付く。実機でも 1 枚のまま更新されることを確かめている。
  it('訂正報テストは初報の後から訂正報を届け、同じカードを更新する', async () => {
    const h = setup()
    await h.flush()

    await act(async () => { await h.current.simulateQuakeAmendment() })
    // キューのディスパッチャは 10ms 周期なので、積んだ直後はまだ届いていない。
    act(() => { vi.advanceTimersByTime(100) })
    expect(h.current.earthquakes.length).toBe(1)
    expect(h.current.earthquakes[0].issue.correct).toBe('なし')
    expect(h.current.earthquakes[0].earthquake.hypocenter.magnitude).toBe(7.4)

    act(() => { vi.advanceTimersByTime(5_000) })
    expect(h.current.earthquakes.length).toBe(1)
    expect(h.current.earthquakes[0].issue.correct).toBe('震源を訂正')
    expect(h.current.earthquakes[0].earthquake.hypocenter.magnitude).toBe(7.6)
  })

  // 対照: 訂正報テストもリセットで 2 通目が落ちること。**推計震度分布図の対照と別に要る** ——
  // 同じ仕組みに乗っているが、種別ごとに分岐する変更が入ったとき、片方だけ通り続けても
  // 気づけない（こちらは「消したはずの画面へ 3 秒後に訂正報が 1 通届く」形で現れる）。
  it('リセット後は訂正報が届かない', async () => {
    const h = setup()
    await h.flush()

    await act(async () => { await h.current.simulateQuakeAmendment() })
    act(() => { vi.advanceTimersByTime(100) })
    expect(h.current.earthquakes[0].issue.correct).toBe('なし')

    act(() => { h.current.resetState() })
    act(() => { vi.advanceTimersByTime(10_000) })
    // 初報ごと消えている（訂正報だけが後から生えることもない）
    expect(h.current.earthquakes.filter(q => q.issue.correct !== 'なし')).toEqual([])
  })

  // 対照: この形は `clearTestSimulationTimers` の対象では**ない**。落とすのはキューのほうで、
  // `eventQueueRef.current.clear()` が効く。**仕様書の表（settings-pwa-spec.md §7）が
  // 「キューを空にすれば足りる」と主張している 3 つ目の形の裏付け** —— ここを固定しておかないと、
  // `resetState` がキューを空にする位置がずれたときに黙って通る。
  it('リセット後は推計震度分布図が届かない', async () => {
    const h = setup()
    await h.flush()

    await act(async () => { await h.current.simulateEstimatedIntensity() })
    act(() => { h.current.resetState() })

    act(() => { vi.advanceTimersByTime(10_000) })
    expect(h.current.estimatedIntensities).toHaveLength(0)
  })

  // 安全弁: アンマウントでも落ちること。**リセットだけ配線して cleanup を忘れる**のが
  // いちばん起きやすい取りこぼしで、そちらは画面を閉じた後に setState が走る形になる。
  //
  // **6 種すべてを起こしてから閉じる。** 一部だけだと、cleanup の `useEffect` の依存配列や
  // 呼び出しを壊す回帰（古いクロージャを握る・一部の ref だけ呼ばなくなる）を、
  // 起こさなかった待ちについて検出できない。上の対照は `resetState` 側しか通らない。
  it('アンマウント後は待ちが発火しても電文が流れない', async () => {
    const events: LiveEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()

    // 待ちを持つテストを全種類起こす（津波の 2 つは同じ `testTsunamiRef` を共有するため、
    // 後から押したほうが前の自動解除を畳む。それでも待ちは 1 本残る）
    await act(async () => { await h.current.simulateEEWForecast() })
    await act(async () => { await h.current.simulateEEWRetraction() })
    await act(async () => { await h.current.simulateTsunamiWatch() })
    await act(async () => { await h.current.simulateTsunamiGradeChange() })
    await act(async () => { await h.current.simulateNankaiRetraction() })
    await act(async () => { await h.current.simulateEarthquakeCountRetraction() })

    events.length = 0
    cleanup()
    act(() => { vi.advanceTimersByTime(120_000) })

    expect(events).toEqual([])
  })
})

// 津波の続報で、新報が運ばない情報を前報から引き継ぐこと。
//
// **画面を見ても気づけない。** 症状は「数十秒だけ満潮時刻が消える」「避難の呼びかけが別の
// 注記に差し替わる」で、どちらも例外もログも出ず、次の報で元に戻ることさえある。
//
// 並びは実電文（2026-04-20 三陸沖・`eventId=20260420165303`）のとおり:
//   16:55 VTSE41 津波警報等   区域 13・観測点なし・固定付加文は避難行動
//   16:56 VTSE51 満潮時刻     同じ区域 13・観測点あり・固定付加文は満潮の注記
//   17:08 VTSE41 津波警報等   区域が 17 へ増える・観測点なし・固定付加文は避難行動
describe('津波の続報マージ（前報から引き継ぐもの）', () => {
  const EVENT_ID = '20260420165303'
  const AREA_NAMES = ['北海道太平洋沿岸中部', '岩手県']

  /** 津波警報等（VTSE41）。区域一覧を全量で載せるが、区域の中に観測点を持たない。 */
  function warningTelegram(serial: number, areaNames: string[]): JMATsunami {
    const iso = new Date(Date.UTC(2026, 3, 20, 7, 55 + serial)).toISOString()
    return {
      kind: 'tsunami',
      id: `dmdata-tsunami-${EVENT_ID}-w${serial}`,
      eventId: EVENT_ID,
      time: iso,
      cancelled: false,
      carriesForecastStations: false,
      infoName: '津波警報・津波注意報・津波予報',
      warningComments: [{ key: 'VTSE41', text: 'ただちに避難してください。' }],
      freeText: '［予想される津波の高さの解説］',
      issue: { source: '気象庁', time: iso, type: 'Focus' },
      areas: areaNames.map(name => ({ grade: 'Warning' as const, immediate: false, name })),
    }
  }

  /** 満潮時刻・津波到達予想時刻（VTSE51）。同じ区域一覧に観測点を足して載せる。 */
  function highTideTelegram(serial: number, areaNames: string[]): JMATsunami {
    const iso = new Date(Date.UTC(2026, 3, 20, 7, 56 + serial)).toISOString()
    return {
      kind: 'tsunami',
      id: `dmdata-tsunami-${EVENT_ID}-h${serial}`,
      eventId: EVENT_ID,
      time: iso,
      cancelled: false,
      carriesForecastStations: true,
      infoName: '各地の満潮時刻・津波到達予想時刻に関する情報',
      warningComments: [{
        key: 'VTSE51|各地の満潮時刻・津波到達予想時刻に関する情報',
        text: '津波と満潮が重なると、津波はより高くなりますので一層厳重な警戒が必要です。',
      }],
      issue: { source: '気象庁', time: iso, type: 'Focus' },
      areas: areaNames.map(name => ({
        grade: 'Warning' as const,
        immediate: false,
        name,
        stations: [{ name: `${name}の観測点`, code: `${name}1`, highTideDateTime: '2026-04-20T18:30:00+09:00' }],
      })),
    }
  }

  const stationsOf = (h: ReturnType<typeof setup>, areaName: string) =>
    h.current.tsunamis[0].areas.find(a => a.name === areaName)?.stations

  // このファイルの他の describe と揃えて偽タイマーで回す。本物のタイマーで回すと、フックの
  // キュー配信（10ms 間隔）が実時間で動き続け、全ファイル並列のときだけ効いてくる負荷になる。
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    vi.useRealTimers()
    setReplayOffset(null)
  })

  // 正: 観測点を運ばない津波警報等が届いても、満潮時刻が残る。
  it('津波警報等が届いても満潮時刻が消えない', async () => {
    const h = setup()
    await h.flush()
    act(() => { h.current.injectEvent(warningTelegram(0, AREA_NAMES)) })
    act(() => { h.current.injectEvent(highTideTelegram(0, AREA_NAMES)) })
    expect(stationsOf(h, '岩手県')?.[0].highTideDateTime).toBe('2026-04-20T18:30:00+09:00')

    // 区域が増える続報（実電文では 13 → 17）。増えた区域には引き当てる前報が無い。
    act(() => { h.current.injectEvent(warningTelegram(1, [...AREA_NAMES, '宮城県'])) })
    expect(h.current.tsunamis[0].areas.map(a => a.name)).toEqual([...AREA_NAMES, '宮城県'])
    expect(stationsOf(h, '岩手県')?.[0].highTideDateTime).toBe('2026-04-20T18:30:00+09:00')
    expect(stationsOf(h, '宮城県')).toBeUndefined()
  })

  // 対照: 観測点を運ぶ種別が観測点を載せなくなったら落とす（気象庁が発表をやめた合図）。
  // 実電文では等級が津波予報まで下がった時点でこの形になる。
  it('津波情報が観測点を載せなくなったら落とす', async () => {
    const h = setup()
    await h.flush()
    act(() => { h.current.injectEvent(highTideTelegram(0, AREA_NAMES)) })
    const empty = highTideTelegram(1, AREA_NAMES)
    empty.areas = empty.areas.map(a => ({ ...a, stations: undefined }))
    act(() => { h.current.injectEvent(empty) })
    expect(stationsOf(h, '岩手県')).toBeUndefined()
  })

  // 安全弁: 一部解除で区域が減ったら、減ったまま。前報から復活させない。
  it('電文から消えた区域を前報から復活させない', async () => {
    const h = setup()
    await h.flush()
    act(() => { h.current.injectEvent(highTideTelegram(0, AREA_NAMES)) })
    act(() => { h.current.injectEvent(warningTelegram(1, ['岩手県'])) })
    expect(h.current.tsunamis[0].areas.map(a => a.name)).toEqual(['岩手県'])
  })

  // 正: 固定付加文は主題ごとに束ねる。避難の呼びかけが満潮の注記に差し替わらない。
  it('避難の呼びかけが満潮時刻の報で消えない', async () => {
    const h = setup()
    await h.flush()
    act(() => { h.current.injectEvent(warningTelegram(0, AREA_NAMES)) })
    act(() => { h.current.injectEvent(highTideTelegram(0, AREA_NAMES)) })
    const texts = h.current.tsunamis[0].warningComments!.map(c => c.text)
    expect(texts[0]).toContain('ただちに避難してください')
    expect(texts[1]).toContain('津波と満潮が重なると')
  })

  // 正: 自由付加文も引き継ぐ。入るのは津波警報等だけなので、引き継がないと最初の続報で消える。
  it('自由付加文が続報で消えない', async () => {
    const h = setup()
    await h.flush()
    act(() => { h.current.injectEvent(warningTelegram(0, AREA_NAMES)) })
    act(() => { h.current.injectEvent(highTideTelegram(0, AREA_NAMES)) })
    expect(h.current.tsunamis[0].freeText).toContain('予想される津波の高さの解説')
  })

  // 正: 沿岸への推定も引き継ぐ。**入るのは沖合の津波観測（VTSE52）だけ**で、実電文では最後の
  // VTSE52 のあとに津波情報が 20 通以上続く。引き継がないと次の報で推定が消える。
  it('沿岸への推定が次の報で消えない', async () => {
    const h = setup()
    await h.flush()
    const offshoreReport: JMATsunami = {
      ...highTideTelegram(0, AREA_NAMES),
      id: `dmdata-tsunami-${EVENT_ID}-o1`,
      carriesForecastStations: false,
      infoName: '沖合の津波観測に関する情報',
      areas: [],
      estimations: [{ name: '岩手県', arrivalTime: '2026-04-20T17:30:00+09:00' }],
    }
    act(() => { h.current.injectEvent(warningTelegram(0, AREA_NAMES)) })
    act(() => { h.current.injectEvent(offshoreReport) })
    expect(h.current.tsunamis[0].estimations?.length).toBe(1)
    // 沖合の推定を持たない報が届いても残る
    act(() => { h.current.injectEvent(highTideTelegram(1, AREA_NAMES)) })
    expect(h.current.tsunamis[0].estimations?.map(e => e.name)).toEqual(['岩手県'])
  })

  // 安全弁: 名乗り（`infoName`）は引き継がない。その報が何を出しているかを表すもので、
  // 引き継ぐと満潮時刻の報を見ているのに「津波警報・津波注意報・津波予報」と名乗る。
  it('名乗りは最新の報のものを出す', async () => {
    const h = setup()
    await h.flush()
    act(() => { h.current.injectEvent(warningTelegram(0, AREA_NAMES)) })
    act(() => { h.current.injectEvent(highTideTelegram(0, AREA_NAMES)) })
    expect(h.current.tsunamis[0].infoName).toBe('各地の満潮時刻・津波到達予想時刻に関する情報')
  })
})

// 7 日間表示され続ける帯（地震回数・お知らせ）を、起動時にも復元する。
//
// 以前は南海トラフの 3 種だけを復元していて、この 2 つは抜けていた。**群発の最中に
// リロードすると、いちばん見たい回数の経過が消えていた。**
describe('DMDSS 版: 起動時に 7 日間の帯を復元する', () => {
  // **期限は実時刻からの相対で作る。** 固定の未来日時にすると、`setTimeout` が扱える上限
  // （約 24.8 日）を超えて**即座に発火**し、張った直後に帯が消える。
  const expireAt = () => new Date(Date.now() + 3 * 86_400_000).toISOString()

  const count = (): import('../types/earthquake').JMAEarthquakeCount => ({
    id: 'c1', eventId: '20260819120000', time: '2026-08-19T12:00:00+09:00',
    headline: '地震回数に関する情報をお知らせします。',
    reportDateTime: '2026-08-19T12:00:00+09:00', expireAt: expireAt(),
    items: [{ type: '累積地震回数', startTime: '2026-08-19T00:00:00+09:00', endTime: '2026-08-19T12:00:00+09:00', number: 12, feltNumber: 3 }],
    cancelled: false,
  })

  const notice = (): import('../types/earthquake').JMAQuakeNotice => ({
    id: 'n1', eventId: '20260819120000', time: '2026-08-19T12:00:00+09:00',
    headline: 'お知らせ', reportDateTime: '2026-08-19T12:00:00+09:00', expireAt: expireAt(),
    body: '観測点の入電停止について', cancelled: false,
  })

  it('正: 地震回数とお知らせを取りに行き、帯として出す', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({
      extras: [
        extra({ kind: 'earthquakeCount', data: count() }),
        extra({ kind: 'quakeNotice', data: notice() }),
      ],
    }))
    const h = setup()
    await h.flush()

    expect(fetchDmdataQuakeHistory).toHaveBeenCalled()
    expect(h.current.earthquakeCount?.id).toBe('c1')
    expect(h.current.quakeNotice?.id).toBe('n1')
  })

  // 安全弁: この経路（起動・API キー変更・リプレイ往復の再接続のたびに走る）で拾った最大 7 日前の
  // お知らせを、「いま届いた」電文（`notDispatched`・`onLiveEvent`）のように扱わない。
  // 他の帯と同じく `silentReplayInit` として記録される（下の「起動時の履歴復元」）。
  it('安全弁: 起動時の復元で拾ったお知らせを「いま届いた」電文として記録しない', async () => {
    __resetReplayEventLogForTest()
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({
      extras: [extra({ kind: 'quakeNotice', data: notice() })],
    }))
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()

    expect(h.current.quakeNotice?.id).toBe('n1')
    // 起動時に拾った古いお知らせを読み上げへ流さない
    expect(onLiveEvent).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'quakeNotice' }))
    const notDispatched = drainReplayEvents().events
      .filter((e): e is ReplayTelegramEvent => e.type === 'telegram' && e.skipped === 'notDispatched')
    expect(notDispatched).toHaveLength(0)
  })

  it('対照: 発表が無ければ帯は出ない', async () => {
    const h = setup()
    await h.flush()

    expect(h.current.earthquakeCount).toBeNull()
    expect(h.current.quakeNotice).toBeNull()
  })

  // 安全弁: 履歴の取得が落ちたら**黙って空にしない**。
  //
  // 帯・長周期・地震・津波は 1 本の取得（`fetchDmdataQuakeHistory`）で返るので、
  // **「帯だけ落ちて他は出る」形はもう無い**。落ちたら全部出ないので、
  // 「発表が無かった」と区別が付くようにエラーを出す必要がある
  // （アーカイブが 1 日でも読めれば部分成功になるので、ここへ来るのは全滅したときだけ）。
  it('安全弁: 履歴の取得が落ちたらエラーを出す（黙って空にしない）', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockRejectedValue(new Error('落ちた'))
    const h = setup()
    await h.flush()

    expect(h.current.earthquakeCount).toBeNull()
    expect(h.current.error).toBe('落ちた')
  })
})

// 後発地震注意情報は発表から 7 日で失効する。**履歴はその 7 日ぶんを遡る**ので、
// 期限切れの報が「遡り幅の中の最新 1 通」として渡ってくることが現実に起きる。
//
// かつては取得側（`fetchDmdataKohatsu`）が期限切れを除いて返していたので届かなかった。
// 履歴をアーカイブ経由の 1 本へ寄せたときにその濾し器が無くなり、**期限切れの帯が出たまま
// 消えない**形になっていた（タイマーを張らないだけでは足りない）。
describe('後発地震注意情報の帯は期限で弾く', () => {
  function kohatsuInfo(expireInMs: number): JMAKohatsu {
    const now = serverDate()
    return {
      id: 'dmdata-kohatsu-k1-1',
      time: now.toISOString(),
      eventId: 'k1',
      headline: '北海道・三陸沖後発地震注意情報',
      body: '巨大地震が発生する可能性が平常時と比べて相対的に高まっています。',
      cancelled: false,
      reportDateTime: now.toISOString(),
      expireAt: new Date(now.getTime() + expireInMs).toISOString(),
    }
  }

  const withKohatsu = (k: JMAKohatsu) =>
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ extras: [extra({ kind: 'kohatsu', data: k })] }))

  // 正: 期限内なら帯に出す
  it('期限内なら帯に出す', async () => {
    withKohatsu(kohatsuInfo(60_000))
    const h = setup()
    await h.flush()

    expect(h.current.kohatsu?.eventId).toBe('k1')
  })

  // 対照: 期限切れは出さない。**これが濾し器を失って壊れていた形**
  it('期限切れは帯に出さない', async () => {
    withKohatsu(kohatsuInfo(-1_000))
    const h = setup()
    await h.flush()

    expect(h.current.kohatsu).toBeNull()
  })

  // 安全弁: 日時が壊れていても出さない。**「正当に期限切れ」と同じ無言の見送りに潰さず記録する**
  // （他の帯と同じ方針）
  it('期限が日時として読めないときは出さず、記録を残す', async () => {
    withKohatsu({ ...kohatsuInfo(60_000), expireAt: '壊れた日時' })
    const h = setup()
    await h.flush()

    expect(h.current.kohatsu).toBeNull()
    expect(vi.mocked(log.warn).mock.calls.map(c => c.join(' ')).join(' | '))
      .toContain('後発地震注意情報の期限を計算できません')
  })

  // 受け手の当て方: 履歴が発表 → 取消の順に渡せば、取消が発表を消して帯は出ない。
  // （履歴が帯を電文ごとに渡すこと自体は、取得側の `dmdataReplay.test.ts`・`historyExtraKey` のテストが見る。
  // ここでは取得をモックしているので、畳み込みの欠陥はこのテストでは再現しない）
  it('履歴の帯は発表 → 取消の順に当て、帯は出ない', async () => {
    const k = kohatsuInfo(60_000)
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ extras: [
      extra({ kind: 'kohatsu', data: k }),
      extra({ kind: 'kohatsu', data: { ...k, id: 'dmdata-kohatsu-k1-2', cancelled: true, retracted: true } }),
    ] }))
    const h = setup()
    await h.flush()

    expect(h.current.kohatsu).toBeNull()
  })
})

describe('後発地震注意情報の期限タイマーは、帯を書き換えるときだけ張り直す', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function kohatsu(eventId: string, expireInMs: number, cancelled = false): JMAKohatsu {
    const now = serverDate()
    return {
      id: `dmdata-kohatsu-${eventId}-${cancelled ? 2 : 1}`,
      time: now.toISOString(),
      eventId,
      headline: '北海道・三陸沖後発地震注意情報',
      body: '巨大地震が発生する可能性が平常時と比べて相対的に高まっています。',
      cancelled,
      // 後発地震注意情報の取消は誤報取消（`InfoType` = 取消）なので `retracted` を伴う（→ `JMAKohatsu.retracted`）
      ...(cancelled && { retracted: true }),
      reportDateTime: now.toISOString(),
      expireAt: new Date(now.getTime() + expireInMs).toISOString(),
    }
  }

  const inject = (h: ReturnType<typeof setup>, k: JMAKohatsu) => {
    act(() => { h.current.loadReplayEvents([{ payload: { kind: 'kohatsu', data: k }, replayTime: serverDate() }]) })
    act(() => { vi.advanceTimersByTime(50) })
  }

  // 安全弁: 期限切れで弾かれる報・別の識別情報の取消は、表示中の帯の期限タイマーを止めない。
  // 以前は照合の前にタイマーを止めていたので、弾かれる報が 1 通届くだけで帯が期限を過ぎても残った。
  it('安全弁: 弾かれる報が届いても、表示中の帯は期限で消える', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ extras: [extra({ kind: 'kohatsu', data: kohatsu('k1', 5_000) })] }))
    const h = setup()
    await h.flush()
    expect(h.current.kohatsu?.eventId).toBe('k1')

    inject(h, kohatsu('k2', -1_000))
    inject(h, kohatsu('k3', 60_000, true))
    expect(h.current.kohatsu?.eventId).toBe('k1')

    act(() => { vi.advanceTimersByTime(5_001) })
    expect(h.current.kohatsu).toBeNull()
  })

  // 対照: 同じ識別情報の取消は帯を消し、期限のタイマーも残さない。
  it('対照: 同じ識別情報の取消は帯を消す', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ extras: [extra({ kind: 'kohatsu', data: kohatsu('k1', 5_000) })] }))
    const h = setup()
    await h.flush()

    inject(h, kohatsu('k1', 5_000, true))
    expect(h.current.kohatsu).toBeNull()
  })
})

// 履歴取得は例外を投げずに一部の失敗を吸収するため `error` は立たない。欠けたことを
// 状態へ残さないと、画面には「取れた分だけのカード」が出て失敗は何も出ない。
describe('履歴取得の一部失敗は状態へ残す', () => {
  it('正: 読めなかった取得元と取り込めなかった電文を積む', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(
      history({ skipped: 3, failedArchiveUrls: ['https://x/a', 'live:2026-09-15'] }),
    )
    const h = setup()
    await h.flush()

    expect(totalSkipped(h.current.historyLoss)).toBe(3)
    expect(h.current.historyLoss.failedSources.size).toBe(2)
    // 全滅ではないので、全画面の失敗表示は出さない
    expect(h.current.error).toBeNull()
  })

  it('対照: 何も欠けていなければ空のまま', async () => {
    const h = setup()
    await h.flush()

    expect(totalSkipped(h.current.historyLoss)).toBe(0)
    expect(h.current.historyLoss.failedSources.size).toBe(0)
  })

  // 再生中はリプレイ側が自分の損失を出す。ライブで欠けた分を残すと同じ画面に 2 つの損失が並ぶ。
  it('安全弁: 再生が始まったら落とす', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ skipped: 2 }))
    const h = setup({ offset: null })
    await h.flush()
    expect(totalSkipped(h.current.historyLoss)).toBe(2)

    h.setOffset(-3_600_000)
    await h.flush()

    expect(totalSkipped(h.current.historyLoss)).toBe(0)
  })

  // **取得元の失敗は置き換え、壊れた電文は積む。** 直り方が違うので扱いを分ける。
  //
  // 取得元（日）の失敗は、その日でカーソルが止まるので次に押せば必ず読み直す
  // （→ 取得側の `oldestLoadedDay`）。だから消えてよい。
  it('正: 2 度目の取得で取得元が回復したら、その分は消える', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(
      history({ hasMore: true, failedArchiveUrls: ['https://x/a'] }),
    )
    const h = setup({ offset: null })
    await h.flush()
    expect(h.current.historyLoss.failedSources.size).toBe(1)

    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(
      history({ hasMore: true, oldestLoadedDay: '2026-08-20' }),
    )
    await act(async () => { await h.current.loadMoreEarthquakes() })

    expect(h.current.historyLoss.failedSources.size).toBe(0)
  })

  // **壊れた電文は取り直しても直らない。** その日自体は読み切れているのでカーソルは進み、
  // 窓は重ならないので次の取得では 0 件になる。置き換えると**何も直っていないのに表示だけ
  // 消え、「もう欠けは無い」と読める**。
  it('正: 壊れた電文の分は、次に押しても消さずに積む', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(
      history({ hasMore: true, skipped: 2, oldestLoadedDay: '2026-09-10' }),
    )
    const h = setup({ offset: null })
    await h.flush()
    expect(totalSkipped(h.current.historyLoss)).toBe(2)

    // 次の窓には壊れた電文が無い（窓が重ならないので当然）
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(
      history({ hasMore: true, oldestLoadedDay: '2026-09-03' }),
    )
    await act(async () => { await h.current.loadMoreEarthquakes() })

    expect(totalSkipped(h.current.historyLoss)).toBe(2)
  })

  it('対照: 2 度目も同じ取得元が読めなければ残る', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(
      history({ hasMore: true, failedArchiveUrls: ['https://x/a'] }),
    )
    const h = setup({ offset: null })
    await h.flush()
    await act(async () => { await h.current.loadMoreEarthquakes() })

    expect(h.current.historyLoss.failedSources.size).toBe(1)
  })

  // **壊れた電文は積むが、押した回数だけ増えてはいけない。**
  //
  // カーソル方式では窓が重ならないので、同じ日を二度走査しない —— 1 通の破損は 1 回しか
  // 数えられない。**旧実装（毎回いちばん新しい日から読み直す）では同じ日を何度も走査するため、
  // 積む形にすると押した回数だけ増えていた**。窓が重ならないことが、積んでよい前提。
  it('安全弁: 壊れた電文は積むが、窓が進めば押した回数だけ増えない', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(
      history({ hasMore: true, skipped: 1, oldestLoadedDay: '2026-09-10' }),
    )
    const h = setup({ offset: null })
    await h.flush()

    // 以後の窓に破損は無い（同じ日を読み直さないので当然）
    vi.mocked(fetchDmdataQuakeHistory)
      .mockResolvedValueOnce(history({ hasMore: true, oldestLoadedDay: '2026-09-03' }))
      .mockResolvedValue(history({ hasMore: true, oldestLoadedDay: '2026-08-27' }))
    await act(async () => { await h.current.loadMoreEarthquakes() })
    await act(async () => { await h.current.loadMoreEarthquakes() })

    expect(totalSkipped(h.current.historyLoss)).toBe(1)
  })

  it('安全弁: 接続をやり直したら空へ戻す', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ skipped: 2 }))
    const h = setup({ offset: null })
    await h.flush()
    expect(totalSkipped(h.current.historyLoss)).toBe(2)

    // 再生へ入って戻す（接続 effect が張り直され、遡り幅と一緒に損失も初期化される）
    h.setOffset(-3_600_000)
    await h.flush()
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history())
    h.setOffset(null)
    await h.flush()

    expect(totalSkipped(h.current.historyLoss)).toBe(0)
  })
})

// 近く発火する電文を覗く口（`peekUpcomingPayloads`）。リプレイ中の投機的先行合成
// （`utils/speechPrefetch.ts`）だけが使う。
//
// **返す顔ぶれが狂っても画面には何も出ない。** 投機が空振りするか、要らないものを焼いて
// 控えを圧迫するだけで、症状は「なんとなく速くならない」にしかならない。
//
// 正・対照・安全弁の分担:
//   正   ＝ 地平線の内側にある未来の電文を返す
//   対照 ＝ 地平線の外と、もう時刻が来たものは返さない
//   安全弁＝ 焼いても使われないもの（サイレント注入・表示の片付け）を混ぜない
describe('近く発火する電文を覗く', () => {
  function commentaryPayload(id: string): ReplayPayload {
    const now = serverDate()
    return {
      kind: 'nankaiCommentary',
      data: {
        id,
        time: now.toISOString(),
        eventId: `${id}-event`,
        serialCode: '200',
        serialName: '定例解説',
        headline: '南海トラフ地震関連解説情報',
        summary: '要約',
        body: '本文',
        cancelled: false,
        reportDateTime: now.toISOString(),
        expireAt: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
      },
    }
  }
  /** `payload` から識別子だけ取り出す（比較を読みやすくするため）。 */
  const idsOf = (payloads: readonly ReplayPayload[]) =>
    payloads.map(p => (p.kind === 'nankaiCommentary' ? p.data.id : p.kind))

  it('地平線の内側にある未来の電文を返す（正）', async () => {
    const h = setup()
    await h.flush()
    const now = serverDate()
    act(() => {
      h.current.loadReplayEvents([
        { payload: commentaryPayload('in-10s'), replayTime: new Date(now.getTime() + 10_000) },
        { payload: commentaryPayload('in-30s'), replayTime: new Date(now.getTime() + 30_000) },
      ])
    })
    expect(idsOf(h.current.peekUpcomingPayloads(60_000))).toEqual(['in-10s', 'in-30s'])
  })

  it('地平線より先の電文は返さない（対照）', async () => {
    const h = setup()
    await h.flush()
    const now = serverDate()
    act(() => {
      h.current.loadReplayEvents([
        { payload: commentaryPayload('in-10s'), replayTime: new Date(now.getTime() + 10_000) },
        { payload: commentaryPayload('in-5m'), replayTime: new Date(now.getTime() + 300_000) },
      ])
    })
    expect(idsOf(h.current.peekUpcomingPayloads(60_000))).toEqual(['in-10s'])
  })

  // 時刻が来たものは次のティックで取り出される。いまから焼いても間に合わない。
  it('もう時刻が来た電文は返さない（対照）', async () => {
    const h = setup()
    await h.flush()
    const now = serverDate()
    act(() => {
      h.current.loadReplayEvents([
        { payload: commentaryPayload('past'), replayTime: new Date(now.getTime() - 1000) },
        { payload: commentaryPayload('future'), replayTime: new Date(now.getTime() + 10_000) },
      ])
    })
    expect(idsOf(h.current.peekUpcomingPayloads(60_000))).toEqual(['future'])
  })

  // **サイレント注入は音も読み上げも鳴らさない**（初期状態の復元）。焼いても一度も使われない。
  // 発火時刻が過去なので上の判定でも落ちるが、**その理由に頼らない** —— 注入の時刻の決め方が
  // 変われば、大量の無駄な合成が静かに始まる。
  it('サイレント注入の電文は返さない（安全弁）', async () => {
    const h = setup()
    await h.flush()
    const now = serverDate()
    act(() => {
      h.current.loadReplayEvents([
        { payload: commentaryPayload('silent'), replayTime: new Date(now.getTime() + 10_000), silent: true },
        { payload: commentaryPayload('normal'), replayTime: new Date(now.getTime() + 20_000) },
      ])
    })
    expect(idsOf(h.current.peekUpcomingPayloads(60_000))).toEqual(['normal'])
  })

  it('日時として読めない地平線では何も返さない（安全弁）', async () => {
    const h = setup()
    await h.flush()
    const now = serverDate()
    act(() => {
      h.current.loadReplayEvents([
        { payload: commentaryPayload('in-10s'), replayTime: new Date(now.getTime() + 10_000) },
      ])
    })
    expect(h.current.peekUpcomingPayloads(Number.NaN)).toEqual([])
  })
})

// 2024-11-26 22:47 の大阪府北部（M2.5・最大震度1）の完全版の 55 秒後、1 分後に起きた石川県
// 西方沖（M6.6）の揺れが紛れ込んだ震度速報（福井県嶺南・滋賀県北部の震度3）が、**同じ
// EventID で**届いた。カードは据え置いていたのに、音・読み上げ・ウィンドウタイトルを起こす側は
// その判定を見ておらず、声だけが「新たに最大震度3を…観測しました」と言い、タイトルも
// 「最大震度3」へ変わっていた。気象庁自身は完全版で最大震度1 と確定させている
// （→ docs/spec/quake-spec.md §6.3）。
//
// **画面を見ても気づけない**（カードのほうは正しく据え置かれている）ので、ここで固定する。
// 止めるのは音・読み上げ・タイトルだけで `onLiveEvent` 自体は呼ぶため、見るのは呼び出しの
// 有無ではなく**印**（`LiveEventMeta.quakeHeldBack`）。
describe('カードが採らない電文には「据え置き」の印を付けて渡す', () => {
  const 地震の時刻 = '2024-11-26T22:45:00+09:00'

  const 完全版 = (連番: number, time: string, scale: IntensityScale = 10): JMAQuake => ({
    kind: 'quake',
    id: `dmdata-quake-20241126224512-${連番}`,
    time,
    issue: { source: '気象庁', time, type: '震源・震度情報', correct: 'なし' },
    earthquake: {
      time: 地震の時刻,
      hypocenter: { name: '大阪府北部', latitude: 34.8, longitude: 135.6, depth: 10, magnitude: 2.5 },
      maxScale: scale,
      domesticTsunami: 'なし',
    },
    points: [
      { pref: '大阪府', addr: '大阪府', isArea: true, scale },
      { pref: '', addr: '大阪府北部', isArea: true, scale },
      { pref: '大阪府', addr: '枚方市大垣内', isArea: false, scale },
    ],
  })

  // 実電文どおり震源を持たない（震度速報に `Earthquake` 要素は出現しない）。
  const 震度速報 = (連番: number, time: string): JMAQuake => ({
    kind: 'quake',
    id: `dmdata-quake-20241126224512-${連番}`,
    time,
    issue: { source: '気象庁', time, type: '震度速報', correct: 'なし' },
    earthquake: {
      time: 地震の時刻,
      hypocenter: { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: NaN },
      maxScale: 30,
      domesticTsunami: '調査中',
    },
    points: [
      { pref: '福井県', addr: '福井県', isArea: true, scale: 30 },
      { pref: '', addr: '福井県嶺南', isArea: true, scale: 30 },
      { pref: '滋賀県', addr: '滋賀県', isArea: true, scale: 30 },
      { pref: '', addr: '滋賀県北部', isArea: true, scale: 30 },
    ],
  })

  /** 震度を持たない電文（震源情報）。種別優先度では完全版に負ける。 */
  const 震源情報 = (連番: number, time: string): JMAQuake => ({
    ...完全版(連番, time),
    issue: { source: '気象庁', time, type: '震源情報', correct: 'なし' },
    earthquake: { ...完全版(連番, time).earthquake, maxScale: -1 },
    points: [],
  })

  /** 顕著な地震の震源要素更新（VXSE61）。震度は持たず、震源だけを訂正する。 */
  const 震源要素更新 = (連番: number, time: string, magnitude: number): JMAQuake => ({
    ...完全版(連番, time),
    issue: { source: '気象庁', time, type: '顕著な地震の震源要素更新のお知らせ', correct: 'なし' },
    earthquake: {
      time: 地震の時刻,
      hypocenter: { name: '大阪府北部', latitude: 34.8, longitude: 135.6, depth: 12, magnitude },
      maxScale: -1,
      domesticTsunami: 'なし',
    },
    points: [],
    freeText: '震源要素を訂正します。',
  })

  const 取消 = (連番: number, time: string): JMAQuake => ({
    ...完全版(連番, time),
    cancelled: true,
    issue: { source: '気象庁', time, type: '震源・震度情報', correct: 'なし' },
    earthquake: {
      time: '',
      hypocenter: { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: 0 },
      maxScale: -1,
      domesticTsunami: '不明',
    },
    points: [],
  })

  /** 通知された地震情報の「最大震度と据え置きの印」。 */
  const 通知 = (fn: ReturnType<typeof vi.fn>): [number, boolean][] =>
    fn.mock.calls
      .filter(([e]) => (e as LiveEvent).kind === 'quake')
      .map(([e, meta]) => [
        (e as JMAQuake).earthquake.maxScale,
        (meta as LiveEventMeta | undefined)?.quakeHeldBack === true,
      ])

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    vi.useRealTimers()
    setReplayOffset(null)
  })

  it('完全版の後に届いた震度速報には印が立つ（正）', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()

    act(() => { h.current.injectEvent(完全版(1, '2024-11-26T22:47:00+09:00')) })
    act(() => { h.current.injectEvent(震度速報(1, '2024-11-26T22:48:00+09:00')) })

    // 震度速報も `onLiveEvent` へは渡る（カードの選択・分布モードを閉じる・既読の記録は要る）が、
    // 印が立つので音・読み上げ・タイトルは起きない
    expect(通知(onLiveEvent)).toEqual([[10, false], [30, true]])
    // 表示も従来どおり据え置かれている（この 2 つが揃って初めて食い違いが消える）
    expect(h.current.earthquakes[0]?.earthquake.maxScale).toBe(10)
    expect(h.current.earthquakes[0]?.earthquake.hypocenter.name).toBe('大阪府北部')
  })

  it('完全版より前の震度速報には立たない（対照）', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()

    act(() => { h.current.injectEvent(震度速報(1, '2024-11-26T22:46:00+09:00')) })
    act(() => { h.current.injectEvent(完全版(1, '2024-11-26T22:47:00+09:00')) })

    expect(通知(onLiveEvent)).toEqual([[30, false], [10, false]])
  })

  // 安全弁: 印が立つ範囲が「据え置かれた電文」より広がっていないこと。同じ地震の続報でも、
  // カードが内容を採るものは従来どおり音・読み上げ・タイトル・タブ移動を起こす。
  it('カードが内容を採る続報には立たない（安全弁）', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()

    act(() => { h.current.injectEvent(完全版(1, '2024-11-26T22:47:00+09:00')) })
    act(() => {
      h.current.injectEvent({
        ...完全版(2, '2024-11-26T22:51:00+09:00', 20),
        issue: { source: '気象庁', time: '2024-11-26T22:51:00+09:00', type: '各地の震度情報', correct: 'なし' },
      })
    })

    expect(通知(onLiveEvent)).toEqual([[10, false], [20, false]])
    expect(h.current.earthquakes[0]?.earthquake.maxScale).toBe(20)
  })

  // 安全弁: 印を立てる側へ倒しすぎないこと。**判定に使う `stateRef` はレンダー時にしか
  // 進まない**ので、同じティックで取消を処理した直後は取消済みのカードが `cancelledAt` を
  // 持たないまま見える。統合側は取消済みカードを候補から外して**別カードとして立てる**ため、
  // ここで印を立てると「画面には新しいカードが出ているのに声だけ止まる」逆向きの食い違いに
  // なる。取消を見た事実は入口で同期に台帳へ積まれるので、そちらと照合して避ける。
  it('取消を見た地震では立てない（同じティックで取消を処理した直後）', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()

    act(() => { h.current.injectEvent(完全版(1, '2024-11-26T22:47:00+09:00')) })
    // 取消と、そのあとに発表された報を**同じ `act` で**流す（＝あいだにレンダーを挟まない）。
    // 震源情報は震度を持たないので、取消を見ていなければ種別優先度で据え置き扱いになる。
    act(() => {
      h.current.injectEvent(取消(2, '2024-11-26T22:50:00+09:00'))
      h.current.injectEvent(震源情報(3, '2024-11-26T22:52:00+09:00'))
    })

    expect(通知(onLiveEvent).map(([, 印]) => 印)).toEqual([false, false, false])
  })

  // 正: 上の見送りは**取消対象のカードを掴んでいるあいだだけ**でなければならない。「取消を見た
  // 地震か」だけで見送ると、`sameQuakeEntry` が照合するのは地震そのものの同一性（`eventId`・
  // 地震の時刻）で**その地震が生きているあいだ不変**なので、一度取消を経験した地震では以後
  // すべての報で判定がバイパスされ、**この仕組みが塞いだはずの食い違いがそのまま戻る**。
  // 取消のあとに再発表があれば、そこから先は通常どおり判定する。
  it('取消のあと再発表された地震では、また印が立つ', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()

    act(() => { h.current.injectEvent(完全版(1, '2024-11-26T22:47:00+09:00')) })
    act(() => { h.current.injectEvent(取消(2, '2024-11-26T22:50:00+09:00')) })
    // 再発表（取消より後に発表された報なので、統合側は別カードとして立てる＝§6.2）
    act(() => { h.current.injectEvent(完全版(3, '2024-11-26T22:51:00+09:00')) })
    // その新しいカードに対して、紛れ込んだ震度速報が届く
    act(() => { h.current.injectEvent(震度速報(4, '2024-11-26T22:52:00+09:00')) })

    expect(通知(onLiveEvent).map(([, 印]) => 印)).toEqual([false, false, false, true])
    // 表示も据え置かれている（再発表の完全版のまま）
    expect(h.current.earthquakes[0]?.earthquake.maxScale).toBe(10)
  })

  // 正: **同じティックで捌かれた直前の報も既存として見える。** 判定に使う既存カードを
  // `stateRef`（レンダー時にしか進まない）だけから引くと、キューが 1 ティックでまとめて
  // 捌いたときに直前の報を見られず、据え置きに気づけない。同じティックの写しを持つのは
  // このため（→ `pendingQuakeCardsRef`）。
  it('同じティックで完全版と震度速報が続いても印が立つ', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()

    // 2 件を**同じ act で**流す（＝あいだにレンダーを挟まないので `stateRef` は空のまま）
    act(() => {
      h.current.injectEvent(完全版(1, '2024-11-26T22:47:00+09:00'))
      h.current.injectEvent(震度速報(2, '2024-11-26T22:48:00+09:00'))
    })

    expect(通知(onLiveEvent).map(([, 印]) => 印)).toEqual([false, true])
  })

  // 正: **同じティックで 3 件以上が捌けても判定が続く。** キューのディスパッチャは 1 ティックで
  // 発火済みのエントリをすべて処理するので（バックグラウンドタブでタイマーが間引かれると
  // まとめて落ちる）、「取消 → 再発表 → 紛れ込んだ震度速報」が 1 つのティックに並びうる。
  // 判定に使う既存カードを**同じティックの写し**から引いているので、レンダーを挟まなくても
  // 3 件目で正しく印が立つ。
  it('同じティックで取消・再発表・紛れ込み報が続いても印が立つ', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()

    act(() => { h.current.injectEvent(完全版(1, '2024-11-26T22:47:00+09:00')) })
    // 3 件を**同じ act で**流す（＝あいだにレンダーを挟まない）
    act(() => {
      h.current.injectEvent(取消(2, '2024-11-26T22:50:00+09:00'))
      h.current.injectEvent(完全版(3, '2024-11-26T22:51:00+09:00'))
      h.current.injectEvent(震度速報(4, '2024-11-26T22:52:00+09:00'))
    })

    expect(通知(onLiveEvent).map(([, 印]) => 印)).toEqual([false, false, false, true])
  })

  // 正: **カードが採らない門は据え置きだけではない。** 取消より前に発表された報は「取り下げ済みの
  // 内容」として丸ごと捨てられる（§6.2）。このとき対象カードは取消済みなので既存カードの
  // 候補から外れ、**据え置き判定からは「既存カードなし」に見える** —— そこで通してしまうと
  // 画面には何も出ないのに声だけが鳴る。統合側と同じ述語（`isRetractedQuakeReport`）を見る。
  it('取消より前に発表された報にも印が立つ', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()

    act(() => { h.current.injectEvent(完全版(1, '2024-11-26T22:47:00+09:00')) })
    act(() => { h.current.injectEvent(取消(2, '2024-11-26T22:50:00+09:00')) })
    // 取消より**前**に発表された報が遅れて届く（到着順の入れ替わり。当日の REST 経路・
    // リプレイで普通に起きる）。種別は取消と同じ＝`isRetractedQuakeReport` の条件を満たす。
    act(() => { h.current.injectEvent(完全版(3, '2024-11-26T22:48:00+09:00')) })

    expect(通知(onLiveEvent).map(([, 印]) => 印)).toEqual([false, false, true])
    // 統合側もその報を捨てている（カードは取消表示のまま増えない）
    expect(h.current.earthquakes.filter(q => !q.cancelledAt)).toHaveLength(0)
  })

  // 正: **震源要素更新（VXSE61）はどんな既存カードでも採る。** 統合側は専用の分岐で必ず受理して
  // 抜けるので、切り出した述語もその前提を持たなければならない。持たないと、1 通目でカードの
  // 種別が VXSE61 へ変わったあと、2 通目以降が「既存が VXSE61」の理由で据え置き扱いになり、
  // **カードは震源も規模も更新されているのに音・声・タイトルだけ止まる**（逆向きの食い違い）。
  it('震源要素更新の 2 通目にも印は立たない（カードは更新される）', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()

    act(() => { h.current.injectEvent(完全版(1, '2024-11-26T22:47:00+09:00')) })
    act(() => { h.current.injectEvent(震源要素更新(2, '2024-11-26T22:55:00+09:00', 2.6)) })
    // 精査後のモーメントマグニチュードが添えられる 2 通目（実運用で起きる）
    act(() => { h.current.injectEvent(震源要素更新(3, '2024-11-26T23:10:00+09:00', 2.7)) })

    expect(通知(onLiveEvent).map(([, 印]) => 印)).toEqual([false, false, false])
    // カードは 2 通目の値を採っている（据え置いていない）
    expect(h.current.earthquakes[0]?.earthquake.hypocenter.magnitude).toBe(2.7)
    // 震度は完全版のものが残る（VXSE61 は震度を運ばない）
    expect(h.current.earthquakes[0]?.earthquake.maxScale).toBe(10)
  })

  // 正: **状態が受理しない報は、同じティックの写しへも載せない。** 取消より前に発表された報は
  // 状態更新が丸ごと捨てる（§6.2）のに、写しの更新だけがその門を通っていなかった —— 取消済み
  // カードを未取消カードで上書きし、**そのあとに届いた正規の再発表が汚染された写しを既存として
  // 見て据え置き扱いになる**（画面には新しいカードが出るのに声だけ止まる）。
  it('同じティックで取消・取消以前の報・再発表が続いても、再発表には印が立たない', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()

    act(() => { h.current.injectEvent(完全版(1, '2024-11-26T22:47:00+09:00')) })
    // 4 件を**同じ act で**流す（＝あいだにレンダーを挟まないので写しが生きたまま繋がる）
    act(() => {
      h.current.injectEvent(取消(2, '2024-11-26T22:50:00+09:00'))
      // 取消より**前**に発表された報（到着順の入れ替わり。状態更新はこれを捨てる）
      h.current.injectEvent(完全版(3, '2024-11-26T22:48:00+09:00'))
      // 正規の再発表（取消より後に発表されたので別カードとして立つ）
      h.current.injectEvent(震度速報(4, '2024-11-26T22:52:00+09:00'))
    })

    expect(通知(onLiveEvent).map(([, 印]) => 印)).toEqual([false, false, true, false])
  })

  // 安全弁: **記録に残さない理由でも印は立つ。** `notable` は「記録するか」だけを決める値で、
  // 「止めるか」とは別の軸。`return held.notable` のように混ぜると、**いちばん頻度の高い
  // 据え置き（発表時刻が古いだけ。実測で 96 件中 94 件）で音と声だけが元の症状へ戻る**。
  it('記録に残さない理由（発表時刻が古いだけ）でも印は立つ', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()

    act(() => { h.current.injectEvent(完全版(1, '2024-11-26T22:47:00+09:00')) })
    // 発表時刻が古い続報（並び替えや遅延で日常的に届く＝`olderReport`・記録は出ない）
    act(() => { h.current.injectEvent(完全版(2, '2024-11-26T22:46:00+09:00', 20)) })

    expect(通知(onLiveEvent).map(([, 印]) => 印)).toEqual([false, true])
    // 表示も据え置かれている（古い報の震度を採っていない）
    expect(h.current.earthquakes[0]?.earthquake.maxScale).toBe(10)
  })

  // 正: **取消の判定は受信の入口で 1 回だけ行い、状態更新の中で再計算しない。** 再計算して
  // いた頃は、同じティックで「報 → 取消」の順に届いたとき**取消より前に発表された正当な報まで
  // 捨てていた** —— 状態更新はレンダー時に走るので、そのとき台帳には後から積まれた取消が既に
  // 載っている。§6.2 が捨てると定めているのは「取消の**後に届いた**報」なので、入口で決める
  // ほうが規則どおり。
  it('同じティックで「報 → 取消」の順なら、報は受理されてから取消される', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()

    // 2 件を**同じ act で**流す（＝報の状態更新がレンダーで走る時点では、台帳に取消が載る）
    act(() => {
      h.current.injectEvent(完全版(1, '2024-11-26T22:48:00+09:00'))
      h.current.injectEvent(取消(2, '2024-11-26T22:50:00+09:00'))
    })

    // 報は捨てられず、カードが立ってから取消表示になる
    expect(h.current.earthquakes).toHaveLength(1)
    expect(h.current.earthquakes[0]?.cancelledAt).toBeTruthy()
  })

  // 対照: 取消より**後**に発表された報は別カードとして立つ（§6.2）ので、印は立たない
  it('取消より後に発表された報には印が立たない', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()

    act(() => { h.current.injectEvent(完全版(1, '2024-11-26T22:47:00+09:00')) })
    act(() => { h.current.injectEvent(取消(2, '2024-11-26T22:50:00+09:00')) })
    act(() => { h.current.injectEvent(完全版(3, '2024-11-26T22:51:00+09:00')) })

    expect(通知(onLiveEvent).map(([, 印]) => 印)).toEqual([false, false, false])
    expect(h.current.earthquakes.filter(q => !q.cancelledAt)).toHaveLength(1)
  })
})

// 据え置かれた電文の震度・地域が、震度キャッシュ（`quakeIntensityCacheRef`）を経由して
// 裏口からカードへ入り込まないこと（→ docs/spec/quake-spec.md §6.3）。
//
// キャッシュは VXSE51（震度速報）の値を控え、後続の震度を持たない電文（震源情報等）を
// `fillIntensityFromCache` で補うためのもの。据え置かれた震度速報の値を書いてしまうと、
// 後続の震源情報がその値で補完され、`hasIntensity(incoming)` が真になって
// `mergeQuakeInto` の「既存の震度で補完する」分岐を通らなくなる —— カードは正しく
// 据え置いたはずの震度・地域ではなく、据え置かれた電文の震度・地域をそのまま採用してしまう。
describe('据え置かれた震度速報は震度キャッシュを汚さない', () => {
  const eventId = '20260101120000'

  const 震度速報 = (連番: number, time: string, maxScale: number, addr: string): JMAQuake => ({
    kind: 'quake',
    id: `dmdata-quake-${eventId}-${連番}`,
    time,
    issue: { source: '気象庁', time, type: '震度速報', correct: 'なし' },
    earthquake: {
      time: '2026-01-01T12:00:00+09:00',
      hypocenter: { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: NaN },
      maxScale,
      domesticTsunami: '調査中',
    },
    points: [{ pref: '', addr, isArea: true, scale: maxScale }],
  }) as JMAQuake

  const 震源情報 = (連番: number, time: string): JMAQuake => ({
    kind: 'quake',
    id: `dmdata-quake-${eventId}-${連番}`,
    time,
    issue: { source: '気象庁', time, type: '震源情報', correct: 'なし' },
    earthquake: {
      time: '2026-01-01T12:00:00+09:00',
      hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 10, magnitude: 5.2 },
      maxScale: -1,
      domesticTsunami: 'なし',
    },
    points: [],
  }) as JMAQuake

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    vi.useRealTimers()
    setReplayOffset(null)
  })

  // 正: 発表時刻が古く据え置かれた震度速報の値は、後続の震源情報の補完に使われない。
  it('据え置かれた震度速報の値で震源情報が補完されない', async () => {
    const h = setup({})
    await h.flush()

    // 1 通目（カードを確定させる）
    act(() => { h.current.injectEvent(震度速報(1, '2026-01-01T12:02:00+09:00', 10, '石川県能登')) })
    // 発表時刻が 1 通目より古い震度速報（`olderReport` で据え置かれる）
    act(() => { h.current.injectEvent(震度速報(2, '2026-01-01T12:01:00+09:00', 30, '福井県嶺南')) })
    // 震度を持たない震源情報（発表時刻は 1 通目より新しい）
    act(() => { h.current.injectEvent(震源情報(3, '2026-01-01T12:03:00+09:00')) })

    // 据え置いた 1 通目の値のまま（2 通目の値がキャッシュ経由で紛れ込んでいない）
    expect(h.current.earthquakes[0]?.earthquake.maxScale).toBe(10)
    expect(h.current.earthquakes[0]?.points.some(p => p.addr === '福井県嶺南')).toBe(false)
  })

  // 対照: 据え置かれない震度速報は従来どおりキャッシュを更新し、震源情報が正しく補完される
  // （ガードが書き込みの機構そのものを壊していないこと）。
  it('据え置かれない震度速報は震源情報を正しく補完する', async () => {
    const h = setup({})
    await h.flush()

    act(() => { h.current.injectEvent(震度速報(1, '2026-01-01T12:02:00+09:00', 10, '石川県能登')) })
    act(() => { h.current.injectEvent(震源情報(3, '2026-01-01T12:03:00+09:00')) })

    expect(h.current.earthquakes[0]?.earthquake.maxScale).toBe(10)
    expect(h.current.earthquakes[0]?.points.some(p => p.addr === '石川県能登')).toBe(true)
  })

  // 安全弁: ガードは「据え置いた回だけ」書き込みを止める。据え置きの直後に届く、据え置かれない
  // 震度速報（発表時刻が最も新しい）は通常どおりキャッシュを更新し、震源情報を正しく補完する。
  it('据え置きの直後でも、据え置かれない震度速報は震源情報を正しく補完する', async () => {
    const h = setup({})
    await h.flush()

    act(() => { h.current.injectEvent(震度速報(1, '2026-01-01T12:02:00+09:00', 10, '石川県能登')) })
    // 発表時刻が古く据え置かれる
    act(() => { h.current.injectEvent(震度速報(2, '2026-01-01T12:01:00+09:00', 30, '福井県嶺南')) })
    // 発表時刻が最も新しく、据え置かれない
    act(() => { h.current.injectEvent(震度速報(4, '2026-01-01T12:04:00+09:00', 50, '新潟県上越')) })
    act(() => { h.current.injectEvent(震源情報(3, '2026-01-01T12:05:00+09:00')) })

    // 震源情報は最新の（据え置かれなかった）値で補完される
    expect(h.current.earthquakes[0]?.earthquake.maxScale).toBe(50)
    expect(h.current.earthquakes[0]?.points.some(p => p.addr === '新潟県上越')).toBe(true)
  })

  // 安全弁: 「取消より前に発表された報」（`quakeRetracted`）経由でもキャッシュへ書かない。
  //
  // ガードは `!quakeHeldBack && !quakeRetracted` の 2 項。`quakeHeldBack` はサイレント注入
  // （`isSilentRef.current` が真の間）は判定自体をスキップして常に偽のまま固定される
  // （`useEarthquakes.ts` の `!isSilentRef.current && !event.cancelled` のガード）。
  // 一方 `quakeRetracted` はサイレント注入かどうかを見ずに計算されるため、この経路では
  // `!quakeRetracted` だけがキャッシュ書き込みを止める役に立つ。「`quakeHeldBack` に
  // 統合したので `quakeRetracted` は不要」という誤った簡略化が起きても、上の3テストは
  // どれも通り続けてしまうため、この経路だけを別に固定する。
  it('取消より前に発表された震度速報（サイレント注入）は震度キャッシュを汚さない', async () => {
    const h = setup({})
    await h.flush()

    act(() => { h.current.injectEvent(震度速報(1, '2026-01-01T12:02:00+09:00', 10, '石川県能登')) })
    const cancelTime = '2026-01-01T12:03:00+09:00'
    act(() => {
      h.current.injectEvent({
        kind: 'quake', id: `dmdata-quake-${eventId}-2`, time: cancelTime,
        cancelled: true,
        issue: { source: '気象庁', time: cancelTime, type: '震度速報', correct: 'なし' },
        earthquake: {
          time: '', hypocenter: { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: 0 },
          maxScale: -1, domesticTsunami: '不明',
        },
        points: [],
      } as unknown as JMAQuake)
    })

    // 取消より前に発表された震度速報を、サイレント経路（`isSilentRef.current` が真になる）で流す。
    const retracted = 震度速報(3, '2026-01-01T12:01:00+09:00', 30, '福井県嶺南')
    act(() => {
      h.current.loadReplayEvents([
        { payload: { kind: 'event', event: retracted }, replayTime: new Date(serverDate().getTime() - 1000), silent: true },
      ])
    })
    act(() => { vi.advanceTimersByTime(50) })

    // 既存カードは取消済みなので、震源情報は新規カードとして処理される。
    // キャッシュが汚染されていれば、ここで福井県嶺南の値が紛れ込む。
    act(() => { h.current.injectEvent(震源情報(4, '2026-01-01T12:04:00+09:00')) })
    expect(h.current.earthquakes.some(q => q.points.some(p => p.addr === '福井県嶺南'))).toBe(false)
  })
})

// 録画ツール向けのイベントログ（→ `docs/spec/recording-interface-spec.md`）。
//
// **`onLiveEvent` まで届く電文は `useLiveEventHandler` が記録する。** ここで固定するのは、
// その手前で落としている電文にも記録が残ること —— 残らないと、編集する側からは「配信が
// 無かった」のと区別が付かない。
describe('録画ツール向けの記録: onLiveEvent へ届かない電文', () => {
  const AT = '2024-01-01T16:10:20+09:00'

  function eewReport(serial: string): EEWAlert {
    return {
      kind: 'eew',
      origin: 'dmdata',
      id: `dmdata-eew-replaylog-${serial}`,
      time: AT,
      test: false,
      earthquake: {
        originTime: AT, arrivalTime: AT, condition: '',
        hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 10, magnitude: 7.6 },
      },
      severity: 'Warning',
      cancelled: false,
      isFinal: false,
      issue: { eventId: 'replaylog-event', serial, time: AT },
      areas: [{ pref: '', name: '石川県能登', scaleFrom: 40, scaleTo: 50, kindCode: '11', arrivalTime: null }],
    }
  }

  const loggedTelegrams = () =>
    drainReplayEvents().events.filter((e): e is ReplayTelegramEvent => e.type === 'telegram')

  beforeEach(() => { __resetReplayEventLogForTest() })
  afterEach(() => { __resetReplayEventLogForTest(); vi.useRealTimers() })

  it('緊急地震速報の古い報にも記録が残る', async () => {
    const h = setup()
    await h.flush()
    act(() => { h.current.injectEvent(eewReport('2')) })
    act(() => { h.current.injectEvent(eewReport('1')) })

    const skipped = loggedTelegrams().filter(t => t.skipped === 'staleSerial')
    expect(skipped).toHaveLength(1)
    expect(skipped[0].kind).toBe('eew')
    expect(skipped[0].serial).toBe('1')
  })

  it('対照: 受理した報には見送りの印が付かない', async () => {
    const h = setup()
    await h.flush()
    act(() => { h.current.injectEvent(eewReport('1')) })
    // 受理した分の記録は `useLiveEventHandler` の担当なので、ここには落とした分だけが出る
    expect(loggedTelegrams().filter(t => t.skipped === 'staleSerial')).toHaveLength(0)
  })

  // お知らせは帯へ反映できたら `onLiveEvent` へ流す（読み上げるかは受け手が設定で決める）。
  // 流したものは受け手の側で記録されるので、ここに「流さなかった」記録は残らない。
  it('地震・津波に関するお知らせは onLiveEvent へ流し、流さなかった記録を残さない', async () => {
    // キューの捌きを進めるため（この経路は `injectEvent` と違って即時ではない）
    vi.useFakeTimers()
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()
    const now = serverDate()
    act(() => {
      h.current.loadReplayEvents([{
        payload: {
          kind: 'quakeNotice',
          data: {
            id: 'notice-replaylog', time: now.toISOString(), eventId: 'notice-replaylog-event',
            headline: '沖縄県の震度データ入電停止のお知らせ', body: '本文', cancelled: false,
            reportDateTime: now.toISOString(),
            expireAt: new Date(now.getTime() + 60_000).toISOString(),
          },
        },
        replayTime: now,
      }])
    })
    // キューは 10ms 間隔で捌く（`injectEvent` と違い即時ではない）
    act(() => { vi.advanceTimersByTime(50) })

    expect(onLiveEvent).toHaveBeenCalledWith({ kind: 'quakeNotice', data: expect.objectContaining({ id: 'notice-replaylog' }) })
    expect(loggedTelegrams().filter(t => t.kind === 'quakeNotice')).toHaveLength(0)
  })

  // 安全弁: 別のお知らせ宛ての取消は、表示中のお知らせの期限タイマーを止めない（帯が居座らない）。
  it('別のお知らせ宛ての取消が届いても、表示中のお知らせは期限で消える', async () => {
    vi.useFakeTimers()
    const h = setup()
    await h.flush()
    const now = serverDate()
    const base = {
      time: now.toISOString(), headline: '沖縄県の震度データ入電停止のお知らせ', body: '本文',
      reportDateTime: now.toISOString(), expireAt: new Date(now.getTime() + 60_000).toISOString(),
    }
    act(() => {
      h.current.loadReplayEvents([
        { payload: { kind: 'quakeNotice', data: { ...base, id: 'notice-a', eventId: 'a', cancelled: false } }, replayTime: now },
        { payload: { kind: 'quakeNotice', data: { ...base, id: 'notice-b', eventId: 'b', cancelled: true } }, replayTime: now },
      ])
    })
    act(() => { vi.advanceTimersByTime(50) })
    expect(h.current.quakeNotice?.id).toBe('notice-a')
    act(() => { vi.advanceTimersByTime(61_000) })
    expect(h.current.quakeNotice).toBeNull()
  })

  // 対照: 期限切れで帯へ反映できなかったお知らせは流さず、notApplied として記録する
  it('対照: 期限切れのお知らせは onLiveEvent へ流さず notApplied で記録する', async () => {
    vi.useFakeTimers()
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()
    const now = serverDate()
    act(() => {
      h.current.loadReplayEvents([{
        payload: {
          kind: 'quakeNotice',
          data: {
            id: 'notice-expired', time: now.toISOString(), eventId: 'notice-expired-event',
            headline: '沖縄県の震度データ入電停止のお知らせ', body: '本文', cancelled: false,
            reportDateTime: now.toISOString(),
            expireAt: new Date(now.getTime() - 60_000).toISOString(),
          },
        },
        replayTime: now,
      }])
    })
    act(() => { vi.advanceTimersByTime(50) })

    expect(onLiveEvent).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'quakeNotice' }))
    const records = loggedTelegrams().filter(t => t.kind === 'quakeNotice')
    expect(records).toHaveLength(1)
    expect(records[0].skipped).toBe('notApplied')
  })

  // 正: リプレイ開始時の「窓の手前」を作るサイレント注入（silent: true）は onLiveEvent を
  // 呼ばないため、この経路で記録しないと録画ツールから再生開始直後の状態を電文一覧から
  // 追えなくなる（→ docs/spec/recording-interface-spec.md「電文の受信」）。
  it('サイレント注入（silent: true）の南海トラフ臨時情報にも記録が残る', async () => {
    vi.useFakeTimers()
    const h = setup()
    await h.flush()
    const now = serverDate()
    act(() => {
      h.current.loadReplayEvents([{
        payload: {
          kind: 'nankai',
          data: {
            id: 'n-replaylog-silent', time: now.toISOString(), eventId: 'nankai-replaylog-silent',
            kindCode: '0202', kindName: '巨大地震注意',
            headline: '南海トラフ地震臨時情報（巨大地震注意）', body: '',
            cancelled: false, reportDateTime: now.toISOString(),
          },
        },
        replayTime: now,
        silent: true,
      }])
    })
    act(() => { vi.advanceTimersByTime(50) })

    const silentInit = loggedTelegrams().filter(t => t.skipped === 'silentReplayInit')
    expect(silentInit).toHaveLength(1)
    expect(silentInit[0].kind).toBe('nankai')
    expect(silentInit[0].eventId).toBe('nankai-replaylog-silent')
  })

  // 対照: サイレントでなければ従来どおり `onLiveEvent` を呼ぶので記録は残らない
  it('対照: サイレントでない南海トラフ臨時情報には silentReplayInit が付かない', async () => {
    vi.useFakeTimers()
    const h = setup()
    await h.flush()
    const now = serverDate()
    act(() => {
      h.current.loadReplayEvents([{
        payload: {
          kind: 'nankai',
          data: {
            id: 'n-replaylog-live', time: now.toISOString(), eventId: 'nankai-replaylog-live',
            kindCode: '0202', kindName: '巨大地震注意',
            headline: '南海トラフ地震臨時情報（巨大地震注意）', body: '',
            cancelled: false, reportDateTime: now.toISOString(),
          },
        },
        replayTime: now,
      }])
    })
    act(() => { vi.advanceTimersByTime(50) })

    expect(loggedTelegrams().filter(t => t.skipped === 'silentReplayInit')).toHaveLength(0)
  })

  // 安全弁: 反映されなかった電文（棄却）は `notApplied` として記録する——サイレントかどうかとは
  // 独立の理由。「表示していない情報単位への取消」で `applyNankai` が偽を返すケースを使う。
  it('反映されなかった南海トラフ臨時情報の取消には notApplied が付く', async () => {
    vi.useFakeTimers()
    const h = setup()
    await h.flush()
    const now = serverDate()
    act(() => {
      // 表示中の情報が無い状態で、取消（retracted）だけを流す → `applyNankai` は偽を返す
      h.current.loadReplayEvents([{
        payload: {
          kind: 'nankai',
          data: {
            id: 'n-replaylog-notapplied', time: now.toISOString(), eventId: 'nankai-replaylog-notapplied',
            kindCode: '', kindName: '',
            headline: '', body: '', cancelled: true, retracted: true, reportDateTime: now.toISOString(),
          },
        },
        replayTime: now,
      }])
    })
    act(() => { vi.advanceTimersByTime(50) })

    const notApplied = loggedTelegrams().filter(t => t.skipped === 'notApplied')
    expect(notApplied).toHaveLength(1)
    expect(notApplied[0].kind).toBe('nankai')
  })

  // 安全弁: `lpgm` だけ `cancelled`（取消）・`maxClass < 1`（階級 0）のとき、
  // `silent` の真偽を問わずどちらの記録も残らなかった（2 巡目レビューで検出）。
  // 「onLiveEvent を呼ぶかどうかに関わらず全件」出す規約が lpgm では成立していなかった。
  function lpgmData(over: { cancelled?: boolean, maxClass?: number } = {}) {
    const now = serverDate()
    return {
      id: 'lpgm-replaylog', time: now.toISOString(), eventId: 'lpgm-replaylog-event',
      originTime: now.toISOString(),
      maxClass: over.maxClass ?? 1, cancelled: over.cancelled ?? false,
    }
  }

  // **理由は `notApplied` ではなく `notDispatched`。** `lpgmByEventId` は取消・階級 0 でも
  // 必ず書き換わる（＝反映される）ので、「反映されなかった」を意味する `notApplied` は
  // 使えない（3 巡目レビューで検出）。
  it('取消された長周期地震動にも notDispatched の記録が残る', async () => {
    vi.useFakeTimers()
    const h = setup()
    await h.flush()
    act(() => {
      h.current.loadReplayEvents([{
        payload: { kind: 'lpgm', data: lpgmData({ cancelled: true }) },
        replayTime: serverDate(),
      }])
    })
    act(() => { vi.advanceTimersByTime(50) })

    const notDispatched = loggedTelegrams().filter(t => t.skipped === 'notDispatched')
    expect(notDispatched).toHaveLength(1)
    expect(notDispatched[0].kind).toBe('lpgm')
  })

  it('階級 0 の長周期地震動にも notDispatched の記録が残る', async () => {
    vi.useFakeTimers()
    const h = setup()
    await h.flush()
    act(() => {
      h.current.loadReplayEvents([{
        payload: { kind: 'lpgm', data: lpgmData({ maxClass: 0 }) },
        replayTime: serverDate(),
      }])
    })
    act(() => { vi.advanceTimersByTime(50) })

    const notDispatched = loggedTelegrams().filter(t => t.skipped === 'notDispatched')
    expect(notDispatched).toHaveLength(1)
    expect(notDispatched[0].kind).toBe('lpgm')
  })

  // 対照: 取消でも階級 0 でもない長周期地震動は、サイレントなら silentReplayInit として記録する
  // （他の 5 種別と同じ if/else に揃えたことの確認）。
  it('対照: 取消でも階級 0 でもない長周期地震動はサイレント注入として記録する', async () => {
    vi.useFakeTimers()
    const h = setup()
    await h.flush()
    act(() => {
      h.current.loadReplayEvents([{
        payload: { kind: 'lpgm', data: lpgmData() },
        replayTime: serverDate(),
        silent: true,
      }])
    })
    act(() => { vi.advanceTimersByTime(50) })

    const silentInit = loggedTelegrams().filter(t => t.skipped === 'silentReplayInit')
    expect(silentInit).toHaveLength(1)
    expect(silentInit[0].kind).toBe('lpgm')
  })

  // 安全弁: ライブ WebSocket（`ws.onEvent`）経由の lpgm にも同じ穴があった——else 節が
  // 無く、取消・階級 0 のときは記録もされずに黙って処理が終わっていた（3 巡目レビューで
  // 検出。キュー経路とは別のコードパスなので、キュー経路を直しても波及しない）。
  it('ライブ WebSocket 経由で取消された長周期地震動にも notDispatched の記録が残る', async () => {
    vi.useFakeTimers()
    const h = setup()
    await h.flush()
    act(() => { sockets[0].onEvent?.({ kind: 'lpgm', data: lpgmData({ cancelled: true }) }) })

    const notDispatched = loggedTelegrams().filter(t => t.skipped === 'notDispatched')
    expect(notDispatched).toHaveLength(1)
    expect(notDispatched[0].kind).toBe('lpgm')
  })

  it('ライブ WebSocket 経由で階級 0 の長周期地震動にも notDispatched の記録が残る', async () => {
    vi.useFakeTimers()
    const h = setup()
    await h.flush()
    act(() => { sockets[0].onEvent?.({ kind: 'lpgm', data: lpgmData({ maxClass: 0 }) }) })

    const notDispatched = loggedTelegrams().filter(t => t.skipped === 'notDispatched')
    expect(notDispatched).toHaveLength(1)
    expect(notDispatched[0].kind).toBe('lpgm')
  })

  // 対照: ライブ WebSocket 経路は silent の概念を持たないので、取消でも階級 0 でもない
  // lpgm は素直に onLiveEvent を呼び、telegram 記録は残らない。
  it('対照: ライブ WebSocket 経由で取消でも階級 0 でもない長周期地震動には記録が残らない', async () => {
    vi.useFakeTimers()
    const h = setup()
    await h.flush()
    act(() => { sockets[0].onEvent?.({ kind: 'lpgm', data: lpgmData() }) })

    expect(loggedTelegrams().filter(t => t.kind === 'lpgm')).toHaveLength(0)
  })

  // 正: 表示中の長周期地震動を消した取消は受け手へ渡す（読み上げで取り消されたことを伝える）。
  // 渡さないと、画面の一覧とバッジが黙って消えるだけになる。
  describe('長周期地震動の取消を受け手へ渡す条件', () => {
    const cancelOf = (base: ReturnType<typeof lpgmData>) => ({
      ...base, id: `${base.id}-cancel`, time: new Date(Date.parse(base.time) + 60_000).toISOString(),
      maxClass: 0, cancelled: true,
    })
    const lpgmCalls = (fn: ReturnType<typeof vi.fn>) =>
      fn.mock.calls.map(c => c[0] as LiveEvent).filter(e => e.kind === 'lpgm')

    it('表示中の長周期を消した取消は受け手へ渡す', async () => {
      vi.useFakeTimers()
      const onLiveEvent = vi.fn()
      const h = setup({ onLiveEvent })
      await h.flush()
      const shown = lpgmData()
      act(() => { sockets[0].onEvent?.({ kind: 'lpgm', data: shown }) })
      act(() => { sockets[0].onEvent?.({ kind: 'lpgm', data: cancelOf(shown) }) })

      const calls = lpgmCalls(onLiveEvent)
      expect(calls).toHaveLength(2)
      expect(calls[1].kind === 'lpgm' && calls[1].data.cancelled).toBe(true)
      expect(h.current.lpgmByEventId.has(shown.eventId)).toBe(false)
    })

    // 正: 表示へ反映される前（同じ処理の回）に届いた取消も、直前の報を消したと判定する。
    // 状態は描き直しまで進まないので、状態だけを見ると「何も消していない」に化ける。
    it('同じ回に届いた報と取消でも、取消を受け手へ渡す', async () => {
      vi.useFakeTimers()
      const onLiveEvent = vi.fn()
      const h = setup({ onLiveEvent })
      await h.flush()
      const shown = lpgmData()
      act(() => {
        sockets[0].onEvent?.({ kind: 'lpgm', data: shown })
        sockets[0].onEvent?.({ kind: 'lpgm', data: cancelOf(shown) })
      })

      const calls = lpgmCalls(onLiveEvent)
      expect(calls).toHaveLength(2)
      expect(calls[1].kind === 'lpgm' && calls[1].data.cancelled).toBe(true)
    })

    // 対照: 消すものが無い取消は渡さない（画面に何も起きていないのに「取り消されました」と言わない）。
    it('表示に無い長周期の取消は受け手へ渡さない', async () => {
      vi.useFakeTimers()
      const onLiveEvent = vi.fn()
      const h = setup({ onLiveEvent })
      await h.flush()
      act(() => { sockets[0].onEvent?.({ kind: 'lpgm', data: cancelOf(lpgmData()) }) })

      expect(lpgmCalls(onLiveEvent)).toHaveLength(0)
    })

    // 対照: 階級 0 の長周期は画面に出ない（カードは階級 1 以上だけを描く）ので、それを消した取消は
    // 「表示中を消した」に当たらず、受け手へ渡さない。
    it('階級 0 の長周期を消した取消は受け手へ渡さない', async () => {
      vi.useFakeTimers()
      const onLiveEvent = vi.fn()
      const h = setup({ onLiveEvent })
      await h.flush()
      const shown = lpgmData({ maxClass: 0 })
      act(() => { sockets[0].onEvent?.({ kind: 'lpgm', data: shown }) })
      act(() => { sockets[0].onEvent?.({ kind: 'lpgm', data: cancelOf(shown) }) })

      expect(lpgmCalls(onLiveEvent)).toHaveLength(0)
    })

    // 安全弁: 同じ取消が 2 通届いても、2 通目は消すものが無いので渡さない（二重に読まない）。
    it('同じ取消の 2 通目は受け手へ渡さない', async () => {
      vi.useFakeTimers()
      const onLiveEvent = vi.fn()
      const h = setup({ onLiveEvent })
      await h.flush()
      const shown = lpgmData()
      act(() => { sockets[0].onEvent?.({ kind: 'lpgm', data: shown }) })
      act(() => { sockets[0].onEvent?.({ kind: 'lpgm', data: cancelOf(shown) }) })
      act(() => { sockets[0].onEvent?.({ kind: 'lpgm', data: cancelOf(shown) }) })

      expect(lpgmCalls(onLiveEvent).filter(e => e.kind === 'lpgm' && e.data.cancelled)).toHaveLength(1)
    })
  })

  // 履歴バッチ復元（起動時・「もっと見る」）は onLiveEvent を呼ばずに直接 state を書き換える
  // 独立した経路で、上のキュー・ライブ WebSocket 経路の穴を直しても波及しない
  // （→ `docs/spec/recording-interface-spec.md` §4）。
  describe('履歴バッチ復元（起動時・「もっと見る」）', () => {
    function nankaiData(id: string, over: { cancelled?: boolean, retracted?: boolean } = {}) {
      const now = serverDate()
      return {
        id, time: now.toISOString(), eventId: `${id}-event`,
        kindCode: '0202', kindName: '巨大地震注意',
        headline: '南海トラフ地震臨時情報（巨大地震注意）', body: '',
        cancelled: over.cancelled ?? false, retracted: over.retracted, reportDateTime: now.toISOString(),
      }
    }

    describe('起動時の履歴復元', () => {
      // 正: 反映された（表示された）南海トラフ臨時情報には silentReplayInit が付く。
      // この経路は `applied` の戻り値を無視していたため記録が一切残っていなかった。
      it('正: 反映された南海トラフ臨時情報に silentReplayInit の記録が残る', async () => {
        vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(
          history({ extras: [extra({ kind: 'nankai', data: nankaiData('n-startup-applied') })] }),
        )
        const h = setup()
        await h.flush()

        expect(h.current.nankai?.id).toBe('n-startup-applied')
        const silentInit = loggedTelegrams().filter(t => t.kind === 'nankai' && t.skipped === 'silentReplayInit')
        expect(silentInit).toHaveLength(1)
        expect(silentInit[0].eventId).toBe('n-startup-applied-event')
      })

      // 対照: 表示していない情報単位への取消は `applyNankai` が偽を返す（棄却）ので notApplied。
      it('対照: 反映されなかった南海トラフ臨時情報の取消に notApplied の記録が残る', async () => {
        vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(
          history({ extras: [extra({ kind: 'nankai', data: nankaiData('n-startup-notapplied', { cancelled: true, retracted: true }) })] }),
        )
        const h = setup()
        await h.flush()

        expect(h.current.nankai).toBeNull()
        const notApplied = loggedTelegrams().filter(t => t.kind === 'nankai' && t.skipped === 'notApplied')
        expect(notApplied).toHaveLength(1)
        expect(notApplied[0].eventId).toBe('n-startup-notapplied-event')
      })

      // 安全弁: lpgm は `lpgmEvents` の構築ループ側で記録する。取消は `lpgmByEventId` に
      // 反映されない（＝画面にも出ない）が、キュー経路と同じ理由で notDispatched を使う。
      it('安全弁: 取消された長周期地震動にも notDispatched の記録が残る', async () => {
        vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(
          history({ extras: [extra({ kind: 'lpgm', data: lpgmData({ cancelled: true }) })] }),
        )
        const h = setup()
        await h.flush()

        expect(h.current.lpgmByEventId.has('lpgm-replaylog-event')).toBe(false)
        const notDispatched = loggedTelegrams().filter(t => t.kind === 'lpgm' && t.skipped === 'notDispatched')
        expect(notDispatched).toHaveLength(1)
      })

      // 安全弁: `applyNankai` が例外を投げても、`history.extras` の後続要素（ここでは
      // kohatsu）の処理・記録は続行され、例外を投げた電文自体の記録も残る
      // （2 巡目の敵対的レビューで検出した記録漏れの回帰テスト。1 巡目で直した
      // 「ループ全体・津波失効予約への巻き添え」自体は別観点で、こちらは対象外）。
      // `retracted` を getter にして意図的に例外を発生させる——`applyNankai` は
      // `cancelled: true` の分岐でのみこれを読むが、記録側の `replayTelegramFacts`
      // （`eventId`/`cancelled`/`kindName` のみ読む）は読まないため、
      // 「apply だけが失敗し、記録自体は成功する」状況を再現できる。
      // `JMANankai` 自体は型どおりのオブジェクトなので、通常の入力ではこの経路は起きない。
      it('安全弁: 例外を投げる南海トラフ臨時情報があっても、後続の extras は続行され、両方に記録が残る', async () => {
        const now = serverDate()
        const throwingNankai = {
          get retracted(): boolean { throw new Error('boom') },
          cancelled: true,
          eventId: 'n-startup-throws-event',
          id: 'n-startup-throws', time: now.toISOString(),
          kindCode: '0202', kindName: '巨大地震注意',
          headline: '南海トラフ地震臨時情報（巨大地震注意）', body: '',
          reportDateTime: now.toISOString(),
        }
        const kohatsu = {
          id: 'dmdata-kohatsu-k-after-throw-1', time: now.toISOString(), eventId: 'k-after-throw',
          headline: '北海道・三陸沖後発地震注意情報',
          body: '巨大地震が発生する可能性が平常時と比べて相対的に高まっています。',
          cancelled: false, reportDateTime: now.toISOString(),
          expireAt: new Date(now.getTime() + 60_000).toISOString(),
        }
        vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({
          extras: [
            extra({ kind: 'nankai', data: throwingNankai as unknown as JMANankai }),
            extra({ kind: 'kohatsu', data: kohatsu }),
          ],
        }))
        const h = setup()
        await h.flush()

        // **`loggedTelegrams()` は呼ぶたびにバッファを drain する。** 1 回だけ呼んで
        // 結果を保持する（2 回呼ぶと 2 回目は空になり、後続の記録漏れと見分けが付かない）。
        const telegrams = loggedTelegrams()

        // 例外を投げた電文自体も、反映されなかったものとして記録される（握り潰さない）
        const nankaiRecords = telegrams.filter(t => t.kind === 'nankai')
        expect(nankaiRecords).toHaveLength(1)
        expect(nankaiRecords[0].skipped).toBe('notApplied')

        // 後続の kohatsu は例外に巻き込まれず、通常どおり反映・記録される
        expect(h.current.kohatsu?.eventId).toBe('k-after-throw')
        const kohatsuRecords = telegrams.filter(t => t.kind === 'kohatsu')
        expect(kohatsuRecords).toHaveLength(1)
        expect(kohatsuRecords[0].skipped).toBe('silentReplayInit')
      })

      // 正: お知らせも他の帯と同じく、反映できたものを silentReplayInit として記録する
      // （かつては記録自体を出さない唯一の例外だった。読み上げを持ったので揃えた）。
      it('正: 起動時のお知らせは反映し silentReplayInit として記録する', async () => {
        const now = serverDate()
        vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({
          extras: [extra({
            kind: 'quakeNotice',
            data: {
              id: 'notice-startup', time: now.toISOString(), eventId: 'notice-startup-event',
              headline: '沖縄県の震度データ入電停止のお知らせ', body: '本文', cancelled: false,
              reportDateTime: now.toISOString(),
              expireAt: new Date(now.getTime() + 60_000).toISOString(),
            },
          })],
        }))
        const h = setup()
        await h.flush()

        expect(h.current.quakeNotice?.id).toBe('notice-startup')
        const records = loggedTelegrams().filter(t => t.kind === 'quakeNotice')
        expect(records).toHaveLength(1)
        expect(records[0].skipped).toBe('silentReplayInit')
      })
    })

    describe('「もっと見る」', () => {
      // 正: 「もっと見る」は南海トラフ臨時情報を画面へ反映しない（現在表示中の帯を
      // 遡った古い日の内容で上書きしてしまう副作用を避けるため）が、電文が届いた事実は
      // notDispatched として記録する。
      it('正: 「もっと見る」の南海トラフ臨時情報は反映せず notDispatched として記録する', async () => {
        // **`hasMore` は起動時の取得結果として確定する**——「もっと見る」を呼ぶ前に
        // 立てておかないと `loadMoreEarthquakes` が早期リターンし、後で差し替える
        // extras 付きのモックが一度も呼ばれない。
        vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ hasMore: true }))
        const h = setup({ offset: null })
        await h.flush()
        vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(
          history({ hasMore: true, extras: [extra({ kind: 'nankai', data: nankaiData('n-loadmore') })] }),
        )

        await act(async () => { await h.current.loadMoreEarthquakes() })

        // 画面へは反映しない（起動時と違い、上書きの副作用があるため）
        expect(h.current.nankai).toBeNull()
        const notDispatched = loggedTelegrams().filter(t => t.kind === 'nankai' && t.skipped === 'notDispatched')
        expect(notDispatched).toHaveLength(1)
        expect(notDispatched[0].eventId).toBe('n-loadmore-event')
      })

      // 対照: lpgm は地震カードに紐づく情報なので、「もっと見る」でも従来どおり画面へ反映する。
      // 記録はキュー経路と同じ判定（`lpgmNotifiable`）で silentReplayInit になる。
      it('対照: 「もっと見る」の長周期地震動は画面へ反映しつつ silentReplayInit として記録する', async () => {
        vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ hasMore: true }))
        const h = setup({ offset: null })
        await h.flush()
        vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(
          history({ hasMore: true, extras: [extra({ kind: 'lpgm', data: lpgmData() })] }),
        )

        await act(async () => { await h.current.loadMoreEarthquakes() })

        expect(h.current.lpgmByEventId.has('lpgm-replaylog-event')).toBe(true)
        const silentInit = loggedTelegrams().filter(t => t.kind === 'lpgm' && t.skipped === 'silentReplayInit')
        expect(silentInit).toHaveLength(1)
      })

      // 安全弁: 「もっと見る」のお知らせは南海トラフ臨時情報と同じく反映せず、notDispatched で記録する
      // （古い日のお知らせで今の帯を上書きしない）。
      it('安全弁: 「もっと見る」のお知らせは反映せず notDispatched として記録する', async () => {
        vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ hasMore: true }))
        const h = setup({ offset: null })
        await h.flush()
        const now = serverDate()
        vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({
          hasMore: true,
          extras: [extra({
            kind: 'quakeNotice',
            data: {
              id: 'notice-loadmore', time: now.toISOString(), eventId: 'notice-loadmore-event',
              headline: '沖縄県の震度データ入電停止のお知らせ', body: '本文', cancelled: false,
              reportDateTime: now.toISOString(),
              expireAt: new Date(now.getTime() + 60_000).toISOString(),
            },
          })],
        }))

        await act(async () => { await h.current.loadMoreEarthquakes() })

        expect(h.current.quakeNotice).toBeNull()
        const records = loggedTelegrams().filter(t => t.kind === 'quakeNotice')
        expect(records).toHaveLength(1)
        expect(records[0].skipped).toBe('notDispatched')
      })
    })
  })
})

// 地震情報の取消が「どのカードにどう効いたか」は受信の入口で決め、`onLiveEvent` の 2 つ目の引数で
// 読み上げへ渡す（→ `LiveEventMeta.quakeCancel`）。読み上げが画面の状態から探し直すと、同じティックに
// 続けて届いた報がまだ状態へ入っていないとき「全体の取消」と「一部の取消」を取り違える。
describe('取消の効き方を読み上げへ渡す（LiveEventMeta.quakeCancel）', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  /** 取消の報について渡った判断。 */
  const 取消の判断 = (fn: ReturnType<typeof vi.fn>) =>
    fn.mock.calls
      .filter(([e]) => (e as LiveEvent).kind === 'quake' && (e as JMAQuake).cancelled)
      .map(([, meta]) => (meta as LiveEventMeta | undefined)?.quakeCancel)

  it('正: 一部の取消では、取り下げた情報名と当たったカードが渡る', async () => {
    const { createTestQuakePartialCancel } = await import('../utils/testData')
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()

    // 同じティックで流す（状態がまだ追いついていなくても、写しで当たり先を引ける）
    act(() => { for (const q of createTestQuakePartialCancel()) h.current.injectEvent(q) })

    const [decided] = 取消の判断(onLiveEvent)
    expect(decided?.target).toBeDefined()
    expect(decided?.retracted?.issueType).toBe('震度速報')
  })

  it('対照: 取り消された種別の報しか受けていなければ、全体の取消として渡る（retracted なし）', async () => {
    const { createTestQuakeCancel } = await import('../utils/testData')
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()

    act(() => { for (const q of createTestQuakeCancel()) h.current.injectEvent(q) })

    const [decided] = 取消の判断(onLiveEvent)
    expect(decided?.target).toBeDefined()
    expect(decided?.retracted).toBeUndefined()
  })

  it('安全弁: 当たるカードが無い取消は、当たり先なしで渡る（画面の古いカードを拾わない）', async () => {
    const { createTestQuakeCancel } = await import('../utils/testData')
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()

    const [, cancel] = createTestQuakeCancel()
    act(() => { h.current.injectEvent(cancel) })

    const [decided] = 取消の判断(onLiveEvent)
    expect(decided).toEqual({ target: undefined, retracted: undefined, duplicate: false })
  })

  it('安全弁: 同じ取消が二度届いたら、2 通目はもう伝えた取消として渡る（1 通目は渡らない）', async () => {
    const { createTestQuakeCancel } = await import('../utils/testData')
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()

    const [prompt, cancel] = createTestQuakeCancel()
    act(() => { h.current.injectEvent(prompt) })
    act(() => { h.current.injectEvent(cancel) })
    act(() => { h.current.injectEvent(cancel) })

    expect(取消の判断(onLiveEvent).map(d => d?.duplicate)).toEqual([false, true])
  })

  it('安全弁: 同じティックで一部の取消が二度届いても、2 通目は一部の取消を名乗らない（写しで完結する）', async () => {
    // 写しには 1 通目で当て直したカードが載る。2 通目が画面の状態（まだ当て直す前）へ落ちると、
    // 取り下げた震度速報がまだ残るカードを拾って「一部の取消」を名乗る
    const { createTestQuakePartialCancel } = await import('../utils/testData')
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()

    const telegrams = createTestQuakePartialCancel()
    const cancel = telegrams[telegrams.length - 1]
    act(() => {
      for (const q of telegrams) h.current.injectEvent(q)
      h.current.injectEvent(cancel)
    })

    const [first, second] = 取消の判断(onLiveEvent)
    expect(first?.retracted?.issueType).toBe('震度速報')
    expect(second?.retracted).toBeUndefined()
    expect(second?.duplicate).toBe(true)
  })
})

// 前回受け付けられた区分を覚えておき、起動直後にその区分で履歴と発表中の緊急地震速報を取る
// （→ `services/dmdataClassificationMemory.ts`）。チケットの発行に 1.2〜2.2 秒、同時接続の上限で
// 409 が続けば最大 15 秒、履歴と復元が待たされていた（2026-10-19 実測）。
const { fetchDmdataActiveEews } = await import('../services/dmdata')
const { rememberClassifications, loadRememberedClassifications } = await import('../services/dmdataClassificationMemory')
const { createTestEEWWarning } = await import('../utils/testData')

describe('DMDSS 版: 前回受け付けられた区分で、履歴と復元を申し込みの結果より先に始める', () => {
  beforeEach(() => {
    localStorage.clear()
    // 呼ばれた回数を数えるので、前のテストの記録を消す（戻り値は上の beforeEach が与え直す）
    vi.mocked(fetchDmdataActiveEews).mockClear()
    vi.mocked(fetchDmdataQuakeHistory).mockClear()
    // 最初の取り決めがいつまでも決まらない（同時接続の上限で 409 が続く）
    socketOptions.holdClassifications = true
  })
  afterEach(() => {
    localStorage.clear()
  })

  // 正
  it('覚えがあれば、申し込みの結果を待たずにその区分で取る', async () => {
    rememberClassifications('test-key', ['eew.warning', 'telegram.earthquake'])
    const h = setup()
    await h.flush()
    expect(vi.mocked(fetchDmdataQuakeHistory)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetchDmdataActiveEews)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetchDmdataActiveEews).mock.calls[0][1]).toEqual(['eew.warning', 'telegram.earthquake'])
  })

  // 対照: 覚えが無ければ今までどおり待つ（受けられない区分の一覧を引いて断られる取得を出さない）
  it('覚えが無ければ、申し込みの結果が出るまで取らない', async () => {
    const h = setup()
    await h.flush()
    expect(vi.mocked(fetchDmdataQuakeHistory)).not.toHaveBeenCalled()
    expect(vi.mocked(fetchDmdataActiveEews)).not.toHaveBeenCalled()
  })

  // 対照: 別の鍵の覚えは当てない（契約の違う鍵かもしれない）
  it('別の鍵で覚えた区分では取らない', async () => {
    rememberClassifications('other-key', ['eew.forecast', 'telegram.earthquake'])
    const h = setup()
    await h.flush()
    expect(vi.mocked(fetchDmdataActiveEews)).not.toHaveBeenCalled()
  })

  it('受け付けられた区分が覚えと違えば、その区分で取り直して覚え直す', async () => {
    rememberClassifications('test-key', ['eew.forecast', 'telegram.earthquake'])
    const h = setup()
    await h.flush()
    act(() => { sockets[0].onClassifications?.(['eew.warning', 'telegram.earthquake']) })
    await h.flush()
    expect(vi.mocked(fetchDmdataQuakeHistory)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(fetchDmdataActiveEews).mock.calls.map(c => c[1])).toEqual([
      ['eew.forecast', 'telegram.earthquake'],
      ['eew.warning', 'telegram.earthquake'],
    ])
    expect(loadRememberedClassifications('test-key')).toEqual(['eew.warning', 'telegram.earthquake'])
  })

  // 取り直しで捨てた版の結果を当てない（古い区分で取った「もっと見る」の続きの位置などで上書きしない）
  it('取り直しの前の版が後から返っても、その結果は当てない', async () => {
    let releaseFirst: (v: ReturnType<typeof history>) => void = () => {}
    vi.mocked(fetchDmdataQuakeHistory)
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve }))
      .mockResolvedValueOnce(history({ oldestLoadedDay: '2026-10-12', hasMore: true }))
    rememberClassifications('test-key', ['eew.forecast', 'telegram.earthquake'])
    const h = setup()
    await h.flush()
    act(() => { sockets[0].onClassifications?.(['eew.warning', 'telegram.earthquake']) })
    await h.flush()
    expect(h.current.hasMore).toBe(true)
    // 前の版が遅れて返る（打ち切りを無視して値を返した形）
    await act(async () => { releaseFirst(history({ hasMore: false })) })
    await h.flush()
    expect(h.current.hasMore).toBe(true)
  })

  // 安全弁: 同じなら取り直さない
  it('受け付けられた区分が覚えと同じなら取り直さない', async () => {
    rememberClassifications('test-key', ['eew.forecast', 'telegram.earthquake'])
    const h = setup()
    await h.flush()
    act(() => { sockets[0].onClassifications?.(['telegram.earthquake', 'eew.forecast']) })
    await h.flush()
    expect(vi.mocked(fetchDmdataQuakeHistory)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetchDmdataActiveEews)).toHaveBeenCalledTimes(1)
  })

  // 安全弁: 比べるのは最初に受け付けられた区分だけ。再接続のたびに履歴を取り直さない
  it('再接続で区分が変わっても、2 度目以降は取り直さない', async () => {
    rememberClassifications('test-key', ['eew.forecast', 'telegram.earthquake'])
    const h = setup()
    await h.flush()
    act(() => { sockets[0].onClassifications?.(['eew.forecast', 'telegram.earthquake']) })
    act(() => { sockets[0].onClassifications?.(['telegram.earthquake']) })
    await h.flush()
    expect(vi.mocked(fetchDmdataQuakeHistory)).toHaveBeenCalledTimes(1)
    // 覚えは最新の受け付けに合わせる（次に開いたときはこちらで取る）
    expect(loadRememberedClassifications('test-key')).toEqual(['telegram.earthquake'])
  })

  // 取り直しで、発表中の緊急地震速報を二重に積まない（前の版が積み終えた電文は数えない）
  it('取り直しで同じ緊急地震速報が返っても、復元は 1 度だけ積む', async () => {
    const eew = createTestEEWWarning(true, '20261019120000')
    // 1 回だけの指定にする（既定の空配列を後のテストへ持ち越さない）
    vi.mocked(fetchDmdataActiveEews).mockResolvedValueOnce([eew]).mockResolvedValueOnce([eew])
    vi.mocked(log.info).mockClear()
    rememberClassifications('test-key', ['eew.forecast', 'telegram.earthquake'])
    const h = setup()
    await h.flush()
    act(() => { sockets[0].onClassifications?.(['eew.warning', 'telegram.earthquake']) })
    await h.flush()
    expect(vi.mocked(fetchDmdataActiveEews)).toHaveBeenCalledTimes(2)
    const restored = vi.mocked(log.info).mock.calls
      .filter(c => typeof c[0] === 'string' && c[0].includes('発表中の緊急地震速報を復元しました'))
    expect(restored).toHaveLength(1)
  })

  // 起動時に復元した緊急地震速報を読み上げ側へも渡す。渡さないと、その後に届いた取消が
  // 「表示中の速報ではない」と判定されて鳴らず読まれない（→ `useLiveEventHandler` の `restoreStartupEews`）
  it('復元した緊急地震速報を、読み上げ側の口へも渡す', async () => {
    const eew = createTestEEWWarning(true, '20261019120000')
    vi.mocked(fetchDmdataActiveEews).mockResolvedValueOnce([eew])
    rememberClassifications('test-key', ['eew.forecast', 'telegram.earthquake'])
    const received: (readonly EEWAlert[])[] = []
    const h = setup({ onStartupRestoreEews: (eews) => { received.push(eews) } })
    await h.flush()
    expect(received).toHaveLength(1)
    expect(received[0].map(e => e.id)).toEqual([eew.id])
  })

  // 安全弁: 読み上げ側で投げても、画面の要求（発表中の速報を見せる）は出す
  it('読み上げ側の口が投げても、画面の要求は出す', async () => {
    const eew = createTestEEWWarning(true, '20261019120000')
    vi.mocked(fetchDmdataActiveEews).mockResolvedValueOnce([eew])
    rememberClassifications('test-key', ['eew.forecast', 'telegram.earthquake'])
    const requested: string[] = []
    const h = setup({
      onStartupRestoreEews: () => { throw new Error('boom') },
      onStartupRestore: (tab) => { requested.push(tab) },
    })
    await h.flush()
    expect(requested).toContain('realtime')
    expect(vi.mocked(log.error).mock.calls.some(c => String(c[0]).includes('読み上げ側へ渡せませんでした'))).toBe(true)
  })

  // 取り直している間は読み込み中へ戻す（古い区分の一覧を確かなものとして見せ続けない）
  it('取り直しの間は読み込み中に戻り、取り終えたら降りる', async () => {
    let releaseSecond: (v: ReturnType<typeof history>) => void = () => {}
    vi.mocked(fetchDmdataQuakeHistory)
      .mockResolvedValueOnce(history())
      .mockImplementationOnce(() => new Promise((resolve) => { releaseSecond = resolve }))
    rememberClassifications('test-key', ['eew.forecast', 'telegram.earthquake'])
    const h = setup()
    await h.flush()
    expect(h.current.isLoading).toBe(false)
    act(() => { sockets[0].onClassifications?.(['eew.warning', 'telegram.earthquake']) })
    await h.flush()
    expect(h.current.isLoading).toBe(true)
    await act(async () => { releaseSecond(history()) })
    await h.flush()
    expect(h.current.isLoading).toBe(false)
  })

  // 取り直しの途中で押された「もっと見る」は、取り直しが決着してから、その続きを読む
  // （先に読むと、後から終わった取り直しがカーソルを新しい側へ戻し、次の押下が同じ窓を読み直す）
  it('取り直しの途中で押した「もっと見る」は、取り直しを待ってからその続きを読む', async () => {
    let releaseSecond: (v: ReturnType<typeof history>) => void = () => {}
    vi.mocked(fetchDmdataQuakeHistory)
      .mockResolvedValueOnce(history({ oldestLoadedDay: '2026-10-12', hasMore: true }))
      .mockImplementationOnce(() => new Promise((resolve) => { releaseSecond = resolve }))
      .mockResolvedValueOnce(history({ oldestLoadedDay: '2026-10-05', hasMore: true }))
    rememberClassifications('test-key', ['eew.forecast', 'telegram.earthquake'])
    const h = setup()
    await h.flush()
    act(() => { sockets[0].onClassifications?.(['eew.warning', 'telegram.earthquake']) })
    await h.flush()
    let pressed: Promise<void> = Promise.resolve()
    act(() => { pressed = h.current.loadMoreEarthquakes() })
    await h.flush()
    // 取り直しが決着するまでは「もっと見る」の取得を出さない
    expect(vi.mocked(fetchDmdataQuakeHistory)).toHaveBeenCalledTimes(2)
    expect(h.current.isLoadingMore).toBe(true)
    await act(async () => { releaseSecond(history({ oldestLoadedDay: '2026-10-11', hasMore: true })) })
    await act(async () => { await pressed })
    expect(vi.mocked(fetchDmdataQuakeHistory)).toHaveBeenCalledTimes(3)
    // 取り直しの最古日（10-11）の続き＝ 10-10 の終わり（日本時間）から読む。前の版の 10-12 からではない
    const before = vi.mocked(fetchDmdataQuakeHistory).mock.calls[2][1] as Date
    expect(before.toISOString()).toBe('2026-10-10T14:59:59.999Z')
    expect(h.current.isLoadingMore).toBe(false)
  })

  // 認証エラーで決着したら覚えを消す（次の起動で受けられない区分を引かない）。この起動は取り直さない
  it('認証エラーで決着したら覚えを消し、取り直さない', async () => {
    rememberClassifications('test-key', ['eew.forecast', 'telegram.earthquake'])
    const h = setup()
    await h.flush()
    act(() => { sockets[0].onClassificationsUnsettled?.('auth') })
    await h.flush()
    expect(loadRememberedClassifications('test-key')).toBeNull()
    expect(vi.mocked(fetchDmdataQuakeHistory)).toHaveBeenCalledTimes(1)
  })

  // 時間切れでは覚えを残して続ける。突き合わせは続き、後で違う区分が受け付けられたら取り直す
  it('時間切れでは覚えを残し、後で違う区分が受け付けられたら取り直す', async () => {
    rememberClassifications('test-key', ['eew.forecast', 'telegram.earthquake'])
    const h = setup()
    await h.flush()
    act(() => { sockets[0].onClassificationsUnsettled?.('timeout') })
    await h.flush()
    expect(loadRememberedClassifications('test-key')).toEqual(['eew.forecast', 'telegram.earthquake'])
    expect(vi.mocked(fetchDmdataQuakeHistory)).toHaveBeenCalledTimes(1)
    act(() => { sockets[0].onClassifications?.(['eew.warning', 'telegram.earthquake']) })
    await h.flush()
    expect(vi.mocked(fetchDmdataQuakeHistory)).toHaveBeenCalledTimes(2)
  })

  // 対照: 覚えが無いまま決着しても何もしない（覚えも取り直しも無関係）
  it('覚えが無いまま認証エラーで決着しても、別の鍵の覚えは消さない', async () => {
    rememberClassifications('other-key', ['eew.forecast', 'telegram.earthquake'])
    setup()
    act(() => { sockets[0].onClassificationsUnsettled?.('auth') })
    expect(loadRememberedClassifications('other-key')).toEqual(['eew.forecast', 'telegram.earthquake'])
  })
})

describe('DMDSS 版: 起動時履歴は、ライブで当てた津波の報より古ければ津波を書き換えない', () => {
  // 履歴の取得はライブの接続と並行して走り、数十秒〜数分かかる。その間にライブで当てた報を、取り込みの最後に
  // 履歴の古い最新報（または空）で上書きすると、引き上げが巻き戻る・ライブで出た津波が消える・解除した津波が甦る
  // （→ `useEarthquakes.ts` の `liveTsunamiSeenKeyRef`）。ここでは履歴の取得を止めておき、その間にライブで流す。
  const EVENT_ID = '20240101161010'

  function tsunami(over: { id: string; ageSec: number; grade?: 'Warning' | 'Watch'; cancelled?: boolean; validInMs?: number }): JMATsunami {
    const createdAtMs = serverDate().getTime() - over.ageSec * 1000
    const at = new Date(Math.floor(createdAtMs / 60_000) * 60_000).toISOString()
    return {
      kind: 'tsunami',
      id: over.id,
      eventId: EVENT_ID,
      headType: 'VTSE41',
      time: at,
      createdAtMs,
      cancelled: over.cancelled ?? false,
      ...(over.cancelled && { cancelReason: 'lifted' as const }),
      ...(over.validInMs !== undefined && { validDateTime: new Date(serverDate().getTime() + over.validInMs).toISOString() }),
      infoName: '津波警報・注意報・予報',
      issue: { source: 'dmdata', time: at, type: 'Focus' },
      areas: over.cancelled ? [] : [{ grade: over.grade ?? 'Watch', immediate: false, name: '石川県能登' }],
    }
  }

  /** 履歴の取得を止めておき、あとで解く。 */
  function holdHistory() {
    let release: (v: ReturnType<typeof history>) => void = () => {}
    vi.mocked(fetchDmdataQuakeHistory).mockImplementationOnce(() => new Promise(r => { release = r }))
    return (v: ReturnType<typeof history>) => release(v)
  }

  async function settle(h: ReturnType<typeof setup>) {
    await h.flush()
    await h.flush()
  }

  // 正: 取得中にライブで引き上げた報を、履歴の古い最新報で巻き戻さない
  it('ライブで当てた報より古い履歴は、津波を巻き戻さない', async () => {
    const release = holdHistory()
    const h = setup()
    await h.flush()
    act(() => { h.current.injectEvent(tsunami({ id: 'live-warning', ageSec: 10, grade: 'Warning' })) })
    release(history({ tsunamis: [tsunami({ id: 'history-watch', ageSec: 600, grade: 'Watch', validInMs: 3_600_000 })] }))
    await settle(h)
    expect(h.current.tsunamis.map(t => t.areas[0]?.grade)).toEqual(['Warning'])
  })

  // 正: 履歴に津波が無くても、ライブで出た津波を消さない
  it('履歴に津波が無くても、ライブで出た津波を残す', async () => {
    const release = holdHistory()
    const h = setup()
    await h.flush()
    act(() => { h.current.injectEvent(tsunami({ id: 'live-watch', ageSec: 10 })) })
    release(history())
    await settle(h)
    expect(h.current.tsunamis.length).toBe(1)
  })

  // 正: ライブで解除した津波を、履歴の古い発表報で甦らせない
  it('ライブで解除した津波を、履歴の古い報で甦らせない', async () => {
    const release = holdHistory()
    const h = setup()
    await h.flush()
    act(() => { h.current.injectEvent(tsunami({ id: 'live-lift', ageSec: 10, cancelled: true })) })
    release(history({ tsunamis: [tsunami({ id: 'history-watch', ageSec: 600, validInMs: 3_600_000 })] }))
    await settle(h)
    expect(h.current.tsunamis.some(t => t.id === 'history-watch' && !t.cancelled && !t.cancelledAt)).toBe(false)
  })

  // 対照: ライブで何も当てていなければ、履歴の最新報を当てる（従来どおり）
  it('ライブで何も当てていなければ、履歴の最新報を当てる', async () => {
    const release = holdHistory()
    const h = setup()
    await h.flush()
    release(history({ tsunamis: [tsunami({ id: 'history-watch', ageSec: 600, validInMs: 3_600_000 })] }))
    await settle(h)
    expect(h.current.tsunamis.map(t => t.id)).toEqual(['history-watch'])
  })

  // 対照: ライブで当てた報より履歴の最新報が新しければ、履歴を当てる
  it('履歴の最新報のほうが新しければ、履歴を当てる', async () => {
    const release = holdHistory()
    const h = setup()
    await h.flush()
    act(() => { h.current.injectEvent(tsunami({ id: 'live-watch', ageSec: 600 })) })
    release(history({ tsunamis: [tsunami({ id: 'history-warning', ageSec: 10, grade: 'Warning', validInMs: 3_600_000 })] }))
    await settle(h)
    expect(h.current.tsunamis.map(t => t.id)).toEqual(['history-warning'])
  })

  // 正: 状態を変えなかった報（表示中が無いときの一部取消）では鍵を進めない。進めると取り消されていない履歴の津波まで落ちる
  it('取得中に何にも当たらなかった取消が届いても、履歴の津波は当てる', async () => {
    const release = holdHistory()
    const h = setup()
    await h.flush()
    act(() => { h.current.injectEvent({ ...tsunami({ id: 'live-retract', ageSec: 10, cancelled: true }), headType: 'VTSE51' as const, cancelReason: 'retracted' as const }) })
    release(history({ tsunamis: [tsunami({ id: 'history-watch', ageSec: 600, validInMs: 3_600_000 })] }))
    await settle(h)
    expect(h.current.tsunamis.map(t => t.id)).toEqual(['history-watch'])
  })

  describe('失効予約', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => {
      vi.useRealTimers()
      socketOptions.holdClassifications = false
      localStorage.clear()
    })

    // 正: 履歴を当てたら、ライブで先に当てた報の予約を外す（外さないと早いほうが今の津波を終わらせる）
    it('履歴を当てたら、ライブで当てた報の早い予約では失効しない', async () => {
      const release = holdHistory()
      const h = setup()
      await h.flush()
      act(() => { h.current.injectEvent(tsunami({ id: 'live-watch', ageSec: 600, validInMs: 30_000 })) })
      release(history({ tsunamis: [tsunami({ id: 'history-watch', ageSec: 10, validInMs: 120_000 })] }))
      await settle(h)
      act(() => { vi.advanceTimersByTime(31_000) })
      expect(h.current.tsunamis[0].cancelledAt).toBeUndefined()
      act(() => { vi.advanceTimersByTime(90_000) })
      expect(h.current.tsunamis[0].cancelReason).toBe('expired')
    })

    // 正: 区分の食い違いで取り直す 2 回目も予約を積む（1 回目の予約を外したまま積み直さないと、失効しない津波になる）
    it('履歴を取り直しても、津波は期限で失効する', async () => {
      const t = tsunami({ id: 'history-watch', ageSec: 600, validInMs: 60_000 })
      vi.mocked(fetchDmdataQuakeHistory).mockClear()
      vi.mocked(fetchDmdataQuakeHistory)
        .mockResolvedValueOnce(history({ tsunamis: [t] }))
        .mockResolvedValueOnce(history({ tsunamis: [t] }))
      socketOptions.holdClassifications = true
      rememberClassifications('test-key', ['eew.forecast', 'telegram.earthquake'])
      const h = setup()
      await settle(h)
      act(() => { sockets[0].onClassifications?.(['eew.warning', 'telegram.earthquake']) })
      await settle(h)
      expect(vi.mocked(fetchDmdataQuakeHistory)).toHaveBeenCalledTimes(2)
      expect(h.current.tsunamis[0].cancelledAt).toBeUndefined()
      act(() => { vi.advanceTimersByTime(61_000) })
      expect(h.current.tsunamis[0].cancelReason).toBe('expired')
    })
  })
})

// DMDATA の WebSocket は張り直しても切れていた間の電文を送り直さない（#927）。張り直したとき・起動直後に
// 履歴の目録を引いてから繋がるまでの隙間を、一覧から取り戻す。音・読み上げ・タブ移動は起こさない
// （2026-10-20 ユーザー承認「おすすめで」）。
const { fetchLiveTelegramsBetween } = await import('../services/dmdataReplayLive')

describe('DMDSS 版: 繋がっていなかった間の電文を取り戻す', () => {
  const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()
  const missedQuake = (): JMAQuake => ({
    kind: 'quake',
    id: 'dmdata-quake-missed',
    time: at(-60_000),
    issue: { source: '気象庁', time: at(-60_000), type: '震源・震度情報', correct: 'なし' },
    earthquake: {
      time: at(-120_000),
      hypocenter: { name: '岩手県沖', latitude: 39.9, longitude: 142.2, depth: 50, magnitude: 5.1 },
      maxScale: 40,
      domesticTsunami: 'なし',
    },
    points: [{ pref: '', addr: '岩手県沿岸南部', isArea: true, scale: 40 }],
  })
  const got = (quakes: JMAQuake[] = []) => ({
    quakes, tsunamis: [] as JMATsunami[], extras: [] as ReplayEntry[],
    receivedAt: new Map(quakes.map(q => [q, new Date(q.time)] as const)),
    alreadyReceivedCount: 0, skipped: 0, rateLimitedTelegrams: 0, failedTelegrams: 0, reachedOnlyBack: null as Date | null,
  })

  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(fetchLiveTelegramsBetween).mockReset()
    vi.mocked(fetchLiveTelegramsBetween).mockResolvedValue(got())
    vi.mocked(fetchDmdataActiveEews).mockClear()
    // 履歴の右端を呼び出しの記録から読むので、前のテストの記録を消す
    vi.mocked(fetchDmdataQuakeHistory).mockClear()
  })
  afterEach(() => { vi.useRealTimers() })

  // 正: 張り直したら、前の接続で最後に受けた時刻の 5 分前から取り、一覧へ黙って積む
  it('張り直しで取り戻した地震情報を一覧へ積み、音・読み上げの経路へは流さない', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: null }) })
    await h.flush()
    vi.mocked(fetchLiveTelegramsBetween).mockClear()
    vi.mocked(fetchDmdataActiveEews).mockClear()
    vi.mocked(fetchLiveTelegramsBetween).mockResolvedValueOnce(got([missedQuake()]))

    const lastAlive = Date.now() - 10 * 60_000
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: lastAlive }) })
    await h.flush()
    act(() => { vi.advanceTimersByTime(100) })

    const [, from, to] = vi.mocked(fetchLiveTelegramsBetween).mock.calls[0]
    expect(from.getTime()).toBe(lastAlive - 5 * 60_000)
    expect(to.getTime()).toBeGreaterThanOrEqual(lastAlive)
    expect(h.current.earthquakes.some(q => q.eventId === missedQuake().eventId || q.id === 'dmdata-quake-missed')).toBe(true)
    expect(onLiveEvent).not.toHaveBeenCalled()
    // 切れていた間に発表された緊急地震速報も取り直す
    expect(vi.mocked(fetchDmdataActiveEews)).toHaveBeenCalledTimes(1)
  })

  // 正: 起動直後は、履歴が目録を引いた時刻から最初に繋がるまでを取る
  it('最初に繋がったとき、履歴が先に始まっていればその右端から取る', async () => {
    const h = setup()
    await h.flush()
    const historyBefore = vi.mocked(fetchDmdataQuakeHistory).mock.calls[0][1] as Date
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: null }) })
    await h.flush()

    expect(vi.mocked(fetchLiveTelegramsBetween)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetchLiveTelegramsBetween).mock.calls[0][1].getTime()).toBe(historyBefore.getTime() - 5 * 60_000)
    // 起動時の復元は履歴と一緒に 1 度だけ（最初の接続では取り直さない）
    expect(vi.mocked(fetchDmdataActiveEews)).toHaveBeenCalledTimes(1)
  })

  // 対照: 最初に繋がった時点で履歴がまだ始まっていなければ、履歴が繋がった後の分まで引くので取らない
  it('最初に繋がった時点で履歴がまだ始まっていなければ取らない', async () => {
    socketOptions.holdClassifications = true
    const h = setup()
    await h.flush()
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: null }) })
    await h.flush()
    expect(vi.mocked(fetchLiveTelegramsBetween)).not.toHaveBeenCalled()
  })

  // 安全弁: 取り戻しが失敗しても記録して止まらない（次の張り直しでまた取りに行く）
  it('取り戻しが失敗したら記録し、次の張り直しでは取りに行く', async () => {
    const h = setup()
    await h.flush()
    vi.mocked(log.warn).mockClear()
    vi.mocked(fetchLiveTelegramsBetween).mockRejectedValueOnce(new Error('一覧のページ上限'))
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: Date.now() - 60_000 }) })
    await h.flush()
    expect(vi.mocked(log.warn).mock.calls.some(c => String(c[0]).includes('電文の一覧を引けませんでした'))).toBe(true)

    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: Date.now() - 30_000 }) })
    await h.flush()
    expect(vi.mocked(fetchLiveTelegramsBetween)).toHaveBeenCalledTimes(2)
  })

  // 正: 失敗した区間は次の取り戻しへ持ち越す（次の窓は新しい「最後に受けた時刻」から始まるので、
  // 持ち越さないと失敗した区間が二度と引かれない）。取れたら持ち越しを捨てる
  it('取り戻しに失敗した区間の左端から、次の張り直しで引き直す', async () => {
    const h = setup()
    await h.flush()
    vi.mocked(fetchLiveTelegramsBetween).mockRejectedValueOnce(new Error('一覧のページ上限'))
    const firstAlive = Date.now() - 60_000
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: firstAlive }) })
    await h.flush()

    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: Date.now() - 10_000 }) })
    await h.flush()
    const calls = vi.mocked(fetchLiveTelegramsBetween).mock.calls
    expect(calls[1][1].getTime()).toBe(firstAlive - 5 * 60_000)

    // 2 回目は取れたので、3 回目は新しい区間から
    const thirdAlive = Date.now() - 5_000
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: thirdAlive }) })
    await h.flush()
    expect(calls[2][1].getTime()).toBe(thirdAlive - 5 * 60_000)
  })

  // 正: 取得制限で見送った電文がある区間も、次の取り戻しで同じ左端から引き直す
  it('取得制限で見送った電文があれば、次の張り直しで同じ区間から引き直す', async () => {
    const h = setup()
    await h.flush()
    vi.mocked(fetchLiveTelegramsBetween).mockResolvedValueOnce({ ...got(), rateLimitedTelegrams: 2 })
    const firstAlive = Date.now() - 60_000
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: firstAlive }) })
    await h.flush()
    expect(vi.mocked(log.warn).mock.calls.some(c => String(c[0]).includes('取得制限のため 2 通を見送りました'))).toBe(true)

    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: Date.now() - 10_000 }) })
    await h.flush()
    expect(vi.mocked(fetchLiveTelegramsBetween).mock.calls[1][1].getTime()).toBe(firstAlive - 5 * 60_000)
  })

  // 安全弁: 履歴を当て終えるまでは取り戻さない（先に当てると、履歴が引き継ぐ津波の有効期限より前に
  // 同じ報が引き継ぎ元の無いまま当たる）
  it('起動時の履歴が決着するまで取り戻しを待つ', async () => {
    let release: (v: ReturnType<typeof history>) => void = () => {}
    vi.mocked(fetchDmdataQuakeHistory).mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const h = setup()
    await h.flush()
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: null }) })
    await h.flush()
    expect(vi.mocked(fetchLiveTelegramsBetween)).not.toHaveBeenCalled()

    await act(async () => { release(history()) })
    await h.flush()
    expect(vi.mocked(fetchLiveTelegramsBetween)).toHaveBeenCalledTimes(1)
  })

  // 正: 本体の取得が例外で終わった電文がある区間も、次の取り戻しで同じ左端から引き直す（取り直せば読めることがある）
  it('本体を取れなかった電文があれば、次の張り直しで同じ区間から引き直す', async () => {
    const h = setup()
    await h.flush()
    vi.mocked(fetchLiveTelegramsBetween).mockResolvedValueOnce({ ...got(), skipped: 1, failedTelegrams: 1 })
    const firstAlive = Date.now() - 60_000
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: firstAlive }) })
    await h.flush()

    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: Date.now() - 10_000 }) })
    await h.flush()
    expect(vi.mocked(fetchLiveTelegramsBetween).mock.calls[1][1].getTime()).toBe(firstAlive - 5 * 60_000)
  })

  // 対照: 一覧のページ上限で止まった区間は持ち越さない（引き直しても同じところで止まる。記録して諦める）
  it('一覧のページ上限に当たったら、読めた新しい側は当て、届かなかった古い側は持ち越さずに記録して諦める', async () => {
    const h = setup()
    await h.flush()
    vi.mocked(log.error).mockClear()
    vi.mocked(fetchLiveTelegramsBetween).mockResolvedValueOnce({ ...got([missedQuake()]), reachedOnlyBack: new Date(Date.now() - 30 * 60_000) })
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: Date.now() - 60 * 60_000 }) })
    await h.flush()
    act(() => { vi.advanceTimersByTime(100) })
    expect(h.current.earthquakes.some(q => q.id === 'dmdata-quake-missed')).toBe(true)
    expect(vi.mocked(log.error).mock.calls.some(c => String(c[0]).includes('ページの上限に当たりました'))).toBe(true)

    const nextAlive = Date.now() - 10_000
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: nextAlive }) })
    await h.flush()
    expect(vi.mocked(fetchLiveTelegramsBetween).mock.calls[1][1].getTime()).toBe(nextAlive - 5 * 60_000)
  })

  // 安全弁: 持ち越すのは 1 度だけ。引き直した回でもまた取れなければ諦め、次は新しい区間から引く
  // （恒久的に読めない電文があっても、左端が古いまま窓が伸び続けない）
  it('引き直した回でもまた取れなければ、持ち越さずに諦める', async () => {
    const h = setup()
    await h.flush()
    vi.mocked(log.error).mockClear()
    vi.mocked(fetchLiveTelegramsBetween)
      .mockResolvedValueOnce({ ...got(), skipped: 1, failedTelegrams: 1 })
      .mockResolvedValueOnce({ ...got(), skipped: 1, failedTelegrams: 1 })
    const firstAlive = Date.now() - 60_000
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: firstAlive }) })
    await h.flush()
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: Date.now() - 20_000 }) })
    await h.flush()
    const calls = vi.mocked(fetchLiveTelegramsBetween).mock.calls
    expect(calls[1][1].getTime()).toBe(firstAlive - 5 * 60_000)
    expect(vi.mocked(log.error).mock.calls.some(c => String(c[0]).includes('取り戻しを諦めました'))).toBe(true)

    const thirdAlive = Date.now() - 5_000
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: thirdAlive }) })
    await h.flush()
    expect(calls[2][1].getTime()).toBe(thirdAlive - 5 * 60_000)
  })

  // 対照: 取得制限だけで取れなかった回は引き直しの回数に数えない（429 の窓は待てば明ける）
  it('取得制限だけで取れなかったときは、引き直しの回でも諦めずに持ち越す', async () => {
    const h = setup()
    await h.flush()
    vi.mocked(fetchLiveTelegramsBetween)
      .mockResolvedValueOnce({ ...got(), rateLimitedTelegrams: 1 })
      .mockResolvedValueOnce({ ...got(), rateLimitedTelegrams: 1 })
    const firstAlive = Date.now() - 60_000
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: firstAlive }) })
    await h.flush()
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: Date.now() - 20_000 }) })
    await h.flush()
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: Date.now() - 5_000 }) })
    await h.flush()
    const calls = vi.mocked(fetchLiveTelegramsBetween).mock.calls
    expect(calls[2][1].getTime()).toBe(firstAlive - 5 * 60_000)
  })

  // 正: ページ上限に当たった回で取得の失敗もあれば、持ち越すのは読めた新しい側だけ
  it('ページ上限と取得の失敗が重なったら、新しい側だけを持ち越す', async () => {
    const h = setup()
    await h.flush()
    const reached = new Date(Date.now() - 30 * 60_000)
    vi.mocked(fetchLiveTelegramsBetween).mockResolvedValueOnce({ ...got(), skipped: 1, failedTelegrams: 1, reachedOnlyBack: reached })
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: Date.now() - 60 * 60_000 }) })
    await h.flush()
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: Date.now() - 10_000 }) })
    await h.flush()
    expect(vi.mocked(fetchLiveTelegramsBetween).mock.calls[1][1].getTime()).toBe(reached.getTime())
  })

  // 正: 取り戻しの最中に張り直しが来て、その回が失敗したら、次の回は両方を含む古いほうの左端から引く
  it('取り戻しの最中に来た張り直しと、その回の失敗が重なっても区間を失わない', async () => {
    let reject: (e: Error) => void = () => {}
    vi.mocked(fetchLiveTelegramsBetween).mockImplementationOnce(() => new Promise((_, r) => { reject = r }))
    const h = setup()
    await h.flush()
    const firstAlive = Date.now() - 60_000
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: firstAlive }) })
    await h.flush()
    expect(vi.mocked(fetchLiveTelegramsBetween)).toHaveBeenCalledTimes(1)
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: Date.now() - 20_000 }) })
    await act(async () => { reject(new Error('通信の失敗')) })
    await h.flush()
    const calls = vi.mocked(fetchLiveTelegramsBetween).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[1][1].getTime()).toBe(firstAlive - 5 * 60_000)
  })

  // 正: 履歴を待っている間に張り直しが重なっても、取り戻しは 1 回にまとめ、いちばん古い左端から引く
  it('待っている間に重なった張り直しは 1 回の取り戻しにまとめる', async () => {
    let release: (v: ReturnType<typeof history>) => void = () => {}
    vi.mocked(fetchDmdataQuakeHistory).mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const h = setup()
    await h.flush()
    const oldest = Date.now() - 30 * 60_000
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: Date.now() - 10 * 60_000 }) })
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: oldest }) })
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: Date.now() - 60_000 }) })
    await h.flush()
    expect(vi.mocked(fetchLiveTelegramsBetween)).not.toHaveBeenCalled()

    await act(async () => { release(history()) })
    await h.flush()
    expect(vi.mocked(fetchLiveTelegramsBetween)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetchLiveTelegramsBetween).mock.calls[0][1].getTime()).toBe(oldest - 5 * 60_000)
  })

  // 正: 緊急地震速報の取り戻しは履歴を待たない（張り直しの直後にいちばん要る）
  it('履歴の取得が終わっていなくても、張り直しの間の緊急地震速報は取り直す', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockImplementationOnce(() => new Promise(() => {}))
    const h = setup()
    await h.flush()
    vi.mocked(fetchDmdataActiveEews).mockClear()
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: Date.now() - 60_000 }) })
    await h.flush()
    expect(vi.mocked(fetchDmdataActiveEews)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetchLiveTelegramsBetween)).not.toHaveBeenCalled()
  })

  // 正: 張り直しで戻す緊急地震速報は、受け取った報番号より新しい報だけ（表示中の速報の続報も入る）
  it('張り直しで戻す緊急地震速報は、ライブで受け取った報番号より新しい報だけ', async () => {
    const r1 = createTestEEWWarning(true, '20261020120000', 1)
    const r2 = createTestEEWWarning(true, '20261020120000', 2)
    const r3 = createTestEEWWarning(true, '20261020120000', 3)
    const handed: (readonly EEWAlert[])[] = []
    const h = setup({ onStartupRestoreEews: (eews) => { handed.push(eews) } })
    await h.flush()
    // 第 2 報はライブで受け取った（起動時の復元を通っていないので、id の控えには載っていない）
    act(() => { sockets[0].onEvent?.({ kind: 'eew', data: r2 }) })
    act(() => { vi.advanceTimersByTime(100) })
    await h.flush()

    vi.mocked(fetchDmdataActiveEews).mockResolvedValueOnce([r1, r2])
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: Date.now() - 60_000 }) })
    await h.flush()
    // 第 1 報は古く、第 2 報は受け取り済み。どちらも積まない
    expect(handed).toHaveLength(0)

    // 正: 切れている間に出た第 3 報は積む
    vi.mocked(fetchDmdataActiveEews).mockResolvedValueOnce([r3])
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: Date.now() - 30_000 }) })
    await h.flush()
    expect(handed).toHaveLength(1)
    expect(handed[0].map(e => e.id)).toEqual([r3.id])
  })

  // 正: 受け取り済みの報番号の報は積まないが、詳細の全報から載せた特別警報の印は表示中の速報へ移す。
  // 取得の間にライブが追いつくとここで落ちるので、移さないと切れていた間に特別警報だった速報が警報のまま残る
  it('張り直しで積まない受け取り済みの報でも、運んできた特別警報の印は移す', async () => {
    const r2 = createTestEEWWarning(true, '20261020120000', 2)
    const handed: (readonly EEWAlert[])[] = []
    const h = setup({ onStartupRestoreEews: (eews) => { handed.push(eews) } })
    await h.flush()
    act(() => { sockets[0].onEvent?.({ kind: 'eew', data: { ...r2, everSpecialWarning: undefined } }) })
    act(() => { vi.advanceTimersByTime(100) })
    await h.flush()
    const before = [...h.current.activeEEWs.values()][0]
    expect(before?.everSpecialWarning).toBeFalsy()

    vi.mocked(fetchDmdataActiveEews).mockResolvedValueOnce([{ ...r2, everSpecialWarning: true }])
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: Date.now() - 60_000 }) })
    await h.flush()
    expect(handed).toHaveLength(0)
    expect([...h.current.activeEEWs.values()][0]?.everSpecialWarning).toBe(true)
  })

  // 対照: 印を運ばない受け取り済みの報では立たない
  it('張り直しで積まない受け取り済みの報が印を運ばなければ、印は立たない', async () => {
    const r2 = createTestEEWWarning(true, '20261020120000', 2)
    const h = setup()
    await h.flush()
    act(() => { sockets[0].onEvent?.({ kind: 'eew', data: { ...r2, everSpecialWarning: undefined } }) })
    act(() => { vi.advanceTimersByTime(100) })
    await h.flush()
    vi.mocked(fetchDmdataActiveEews).mockResolvedValueOnce([{ ...r2, everSpecialWarning: undefined }])
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: Date.now() - 60_000 }) })
    await h.flush()
    expect([...h.current.activeEEWs.values()][0]?.everSpecialWarning).toBeFalsy()
  })

  // 正: 切れていた間に始まった地震（台帳に無い）を戻したら、起動時と同じく実時間タブを要求する
  // （2026-10-21 ユーザー承認「おすすめで」）。ライブなら発報で移っていた
  it('張り直しで初めて見る地震を戻したら、実時間タブを要求する', async () => {
    const requested: string[] = []
    const h = setup({ onStartupRestore: (tab) => { requested.push(tab) } })
    await h.flush()
    requested.length = 0
    vi.mocked(fetchDmdataActiveEews).mockResolvedValueOnce([createTestEEWWarning(true, '20261020121500', 2)])
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: Date.now() - 60_000 }) })
    await h.flush()
    expect(requested).toEqual(['realtime'])
  })

  // 対照: 見ていた地震の続報だけなら要求しない（その画面は切れる前に移している）
  it('張り直しで見ていた地震の続報だけを戻したときは、タブを要求しない', async () => {
    const requested: string[] = []
    const h = setup({ onStartupRestore: (tab) => { requested.push(tab) } })
    await h.flush()
    act(() => { sockets[0].onEvent?.({ kind: 'eew', data: createTestEEWWarning(true, '20261020121500', 1) }) })
    act(() => { vi.advanceTimersByTime(100) })
    await h.flush()
    requested.length = 0
    vi.mocked(fetchDmdataActiveEews).mockResolvedValueOnce([createTestEEWWarning(true, '20261020121500', 2)])
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: Date.now() - 60_000 }) })
    await h.flush()
    expect(h.current.activeEEWs.size).toBe(1)
    expect(requested).toEqual([])
  })
})

// 発表中の速報の取り直し（起動時・張り直し）が、取り直しの最中に自動解除で終えた速報を「発表中」として返すことがある。
// 台帳は画面から消えた時点で捨てるので、終えた地震として別に覚えて弾く（→ `eewEndedRef`）。戻すと読み上げ側の帳面に
// 終わった速報が居座り、本物の速報が全部解除されてもタイトルが戻らない（読み上げ側は `useLiveEventHandler.eewTts.test.ts`）
describe('DMDSS 版: 取り直しの最中に終えた緊急地震速報を戻さない', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(fetchDmdataActiveEews).mockReset()
    vi.mocked(fetchDmdataActiveEews).mockResolvedValue([])
  })
  afterEach(() => { vi.useRealTimers() })

  const finalReport = (serial: number) => ({ ...createTestEEWWarning(true, '20261020130000', serial), isFinal: true })

  /** 最終報をライブで受け、張り直しの取り直しを返さずに待たせたまま自動解除させる */
  async function expireDuringReconnectRestore(handed: (readonly EEWAlert[])[]) {
    const h = setup({ onStartupRestoreEews: (eews) => { handed.push(eews) } })
    await h.flush()
    act(() => { sockets[0].onEvent?.({ kind: 'eew', data: finalReport(3) }) })
    act(() => { vi.advanceTimersByTime(100) })
    await h.flush()
    expect(h.current.activeEEWs.size).toBe(1)
    let resolve: (v: EEWAlert[]) => void = () => {}
    vi.mocked(fetchDmdataActiveEews).mockImplementationOnce(() => new Promise(r => { resolve = r }))
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: Date.now() - 60_000 }) })
    await h.flush()
    act(() => { vi.advanceTimersByTime(10 * 60_000) })
    await h.flush()
    expect(h.current.activeEEWs.size).toBe(0)
    return { h, resolve: (eews: EEWAlert[]) => resolve(eews) }
  }

  // 正: 取り直しの最中に自動解除で終えた速報は、取り直しが返しても戻さない
  it('張り直しの取り直しが、その最中に自動解除した速報を返しても戻さない', async () => {
    const handed: (readonly EEWAlert[])[] = []
    const { h, resolve } = await expireDuringReconnectRestore(handed)
    await act(async () => { resolve([finalReport(3)]) })
    await h.flush()
    act(() => { vi.advanceTimersByTime(50) })
    expect(handed).toHaveLength(0)
    expect(h.current.activeEEWs.size).toBe(0)
  })

  // 安全弁: 終えた後に、より新しい報番号の報が返ったら通す（終わったのではなく続いている）
  it('終えた後でも、より新しい報番号の報は戻す', async () => {
    const handed: (readonly EEWAlert[])[] = []
    const { h, resolve } = await expireDuringReconnectRestore(handed)
    await act(async () => { resolve([{ ...finalReport(4), isFinal: false }]) })
    await h.flush()
    expect(handed).toHaveLength(1)
    expect(handed[0].map(e => e.issue?.serial)).toEqual(['4'])
  })

  // 正: 起動時の取り直しも同じ。ライブで最終報を受けて自動解除した後に取り直しが返っても戻さない
  it('起動時の取り直しが、その最中に自動解除した速報を返しても戻さない', async () => {
    let resolve: (v: EEWAlert[]) => void = () => {}
    vi.mocked(fetchDmdataActiveEews).mockImplementationOnce(() => new Promise(r => { resolve = r }))
    const handed: (readonly EEWAlert[])[] = []
    const h = setup({ onStartupRestoreEews: (eews) => { handed.push(eews) } })
    await h.flush()
    act(() => { sockets[0].onEvent?.({ kind: 'eew', data: finalReport(3) }) })
    act(() => { vi.advanceTimersByTime(100) })
    await h.flush()
    act(() => { vi.advanceTimersByTime(10 * 60_000) })
    await h.flush()
    expect(h.current.activeEEWs.size).toBe(0)

    // 対照: 同じ取り直しに入っていた、終えていない地震の速報は戻す（起動時の経路そのものが働いている証拠）
    const other = createTestEEWWarning(true, '20261020130600', 1)
    await act(async () => { resolve([finalReport(3), other]) })
    await h.flush()
    expect(handed).toHaveLength(1)
    expect(handed[0].map(e => e.id)).toEqual([other.id])
    // 弾いたことは記録に残す（黙って弾くと、誤って本物を弾いたときに追えない）
    expect(vi.mocked(log.info).mock.calls.some(c => String(c[0]).includes('起動時の復元') && String(c[0]).includes('画面から消えた地震の報なので採りません'))).toBe(true)
  })

  // 正: 誤報取消で画面から消えた地震も同じ。取消の前の報を取り直しが返しても戻さない
  it('取消で画面から消えた地震の報を、張り直しの取り直しが返しても戻さない', async () => {
    const handed: (readonly EEWAlert[])[] = []
    const h = setup({ onStartupRestoreEews: (eews) => { handed.push(eews) } })
    await h.flush()
    const live = createTestEEWWarning(true, '20261020131000', 3)
    act(() => { sockets[0].onEvent?.({ kind: 'eew', data: live }) })
    act(() => { vi.advanceTimersByTime(100) })
    await h.flush()
    act(() => { sockets[0].onEvent?.({ kind: 'eew', data: { ...createTestEEWWarning(true, '20261020131000', 4), cancelled: true } }) })
    act(() => { vi.advanceTimersByTime(100) })
    await h.flush()
    expect([...h.current.activeEEWs.values()][0]?.cancelledAt).toBeTruthy()
    act(() => { vi.advanceTimersByTime(30_000) })
    await h.flush()
    expect(h.current.activeEEWs.size).toBe(0)

    vi.mocked(fetchDmdataActiveEews).mockResolvedValueOnce([live])
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: Date.now() - 60_000 }) })
    await h.flush()
    expect(handed).toHaveLength(0)
  })

  // 安全弁: リセット（リプレイの開始など）の後は前の時間軸の記憶を使わない。同じ地震の報を取り直したら戻す
  it('リセットの後は、前に終えた地震の報でも取り直しで戻す', async () => {
    const handed: (readonly EEWAlert[])[] = []
    const { h, resolve } = await expireDuringReconnectRestore(handed)
    act(() => { h.current.resetState() })
    await h.flush()
    await act(async () => { resolve([finalReport(3)]) })
    await h.flush()
    expect(handed).toHaveLength(1)
  })

  // 対照: 終えていない速報（ライブで受けていない地震）は、これまでどおり戻す
  it('終えていない地震の速報は、張り直しの取り直しで戻す', async () => {
    const handed: (readonly EEWAlert[])[] = []
    const h = setup({ onStartupRestoreEews: (eews) => { handed.push(eews) } })
    await h.flush()
    vi.mocked(fetchDmdataActiveEews).mockResolvedValueOnce([createTestEEWWarning(true, '20261020130500', 2)])
    act(() => { sockets[0].onStarted?.({ previousAliveAtMs: Date.now() - 60_000 }) })
    await h.flush()
    expect(handed).toHaveLength(1)
  })
})

// 画面から消えた地震の報がライブで遅れて・重ねて届いても、終わった速報を戻さない（→ `eewEndedRef`）。台帳と写しは消えた
// 時点で捨てるので、入口の新旧の比べ方だけでは同じ報・古い報を「新しい報」と見なし、音と読み上げごと戻ってしまう。
// 取消で終えた地震は報番号によらず採らない（取消は終端。2026-10-21 ユーザー承認「おすすめで」）
describe('ライブの入口: 画面から消えた地震の報を採らない', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(fetchDmdataActiveEews).mockReset()
    vi.mocked(fetchDmdataActiveEews).mockResolvedValue([])
  })
  afterEach(() => { vi.useRealTimers() })

  const report = (serial: number, over: Partial<EEWAlert> = {}) =>
    ({ ...createTestEEWWarning(true, '20261020140000', serial), ...over })

  /** ライブで受けた最終報を自動解除させる */
  async function expireLive() {
    const h = setup()
    await h.flush()
    const final = report(3, { isFinal: true })
    act(() => { sockets[0].onEvent?.({ kind: 'eew', data: final }) })
    act(() => { vi.advanceTimersByTime(100) })
    await h.flush()
    expect(h.current.activeEEWs.size).toBe(1)
    act(() => { vi.advanceTimersByTime(10 * 60_000) })
    await h.flush()
    expect(h.current.activeEEWs.size).toBe(0)
    return Object.assign(h, { final })
  }

  const deliver = async (h: ReturnType<typeof setup>, eew: EEWAlert) => {
    act(() => { sockets[0].onEvent?.({ kind: 'eew', data: eew }) })
    act(() => { vi.advanceTimersByTime(100) })
    await h.flush()
  }

  // 正: 自動解除で消えた後に、同じ報・古い報が届いても戻さない。弾いたことは記録に残す
  it('自動解除で消えた地震の、同じ報・古い報は戻さない', async () => {
    const h = await expireLive()
    await deliver(h, report(3, { isFinal: true }))
    await deliver(h, report(2))
    expect(h.current.activeEEWs.size).toBe(0)
    expect(vi.mocked(log.info).mock.calls.some(c => String(c[0]).includes('ライブの受信') && String(c[0]).includes('画面から消えた地震の報なので採りません'))).toBe(true)
  })

  // 安全弁: 自動解除で消えた後でも、より新しい報番号の報は通す（終わったのではなく続いている）
  it('自動解除で消えた後でも、より新しい報番号の報は出す', async () => {
    const h = await expireLive()
    await deliver(h, report(4))
    expect(h.current.activeEEWs.size).toBe(1)
  })

  // 正: 取消で消えた地震は、より新しい報番号の報も戻さない（取消は終端）
  it('取消で消えた地震は、より新しい報番号の報も出さない', async () => {
    const h = setup()
    await h.flush()
    await deliver(h, report(3))
    await deliver(h, report(4, { cancelled: true }))
    expect([...h.current.activeEEWs.values()][0]?.cancelledAt).toBeTruthy()
    act(() => { vi.advanceTimersByTime(30_000) })
    await h.flush()
    expect(h.current.activeEEWs.size).toBe(0)
    await deliver(h, report(5))
    expect(h.current.activeEEWs.size).toBe(0)
  })

  // 正: 消えた後に取消が届いたら、その後の新しい報番号の報も出さない（取消は終端）
  it('消えた後に届いた取消も、その後の新しい報番号の報を止める', async () => {
    const h = await expireLive()
    await deliver(h, report(4, { cancelled: true }))
    expect(h.current.activeEEWs.size).toBe(0)
    await deliver(h, report(5))
    expect(h.current.activeEEWs.size).toBe(0)
  })

  // 経路をまたぐと報番号を比べられないので発表時刻で比べる（標準版の Yahoo と P2PQuake）。同じ秒以前は弾き、新しければ出す
  it('別の経路の報は発表時刻で比べる（同じ秒以前は弾き、新しければ出す）', async () => {
    const h = await expireLive()
    const shown = h.final
    const sameTime = { ...report(1), origin: 'p2pquake' as const, time: shown.time, issue: { ...shown.issue!, serial: '1' } }
    await deliver(h, sameTime)
    expect(h.current.activeEEWs.size).toBe(0)
    const later = new Date(Date.parse(shown.issue!.time ?? shown.time) + 5000).toISOString()
    await deliver(h, { ...sameTime, time: later, issue: { ...sameTime.issue!, time: later } })
    expect(h.current.activeEEWs.size).toBe(1)
  })

  // 対照: 覚えておく窓（ACTIVE_EEW_WINDOW_MS）を過ぎた記憶では弾かない
  it('消えてから覚えておく窓を過ぎれば、同じ地震の報も弾かない', async () => {
    const h = await expireLive()
    act(() => { vi.advanceTimersByTime(ACTIVE_EEW_WINDOW_MS + 1000) })
    await h.flush()
    await deliver(h, report(2))
    expect(h.current.activeEEWs.size).toBe(1)
  })
})
