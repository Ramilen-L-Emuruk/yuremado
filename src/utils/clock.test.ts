// @vitest-environment jsdom
//
// アプリ時計の較正状態のテスト。
//
// 見るのは「較正されているか」と「その較正がいつのものか」の 2 つ。後者（鮮度）を取り違えると、
// 較正が止まっているのに値だけは返る状態を「正常」と読んでしまう。診断ログはこの区別に依存して
// いるため、壊れてもユーザーには見えない一方で、障害の切り分けを静かに誤らせる。
//
// visibilitychange を扱うため、このファイルだけ jsdom 環境で実行する（既定の node は変えない）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  feedServerSample,
  getServerClockOffsetMs,
  getServerClockSampleAgeMs,
  isServerClockTrusted,
  RESUME_DISCARD_THRESHOLD_MS,
  RESUME_REPLACE_MIN_DRIFT_MS,
  serverNow,
  setReplayOffset,
} from './clock'

// 未較正フォールバックの警告を黙らせる（console を潰すと本物の異常が見えなくなるためロガー側を差し替える）。
vi.mock('./logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./logger')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

/** タブ復帰を模す。 */
function fireVisible() {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  document.dispatchEvent(new Event('visibilitychange'))
}

/** 壁時計だけを `ms` 動かしてからタブ復帰を模す（スリープ復帰などで時計の関係が飛んだ形）。 */
function fireVisibleAfterWallJump(ms: number) {
  const realNow = Date.now
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + ms)
  fireVisible()
}

describe('サーバー時刻の較正状態', () => {
  beforeEach(() => {
    setReplayOffset(null)
    // 各テストを未較正から始める。K の破棄経路（時計の関係が飛んだタブ復帰）を使う。
    fireVisibleAfterWallJump(60_000)
    vi.restoreAllMocks()
  })

  afterEach(() => {
    setReplayOffset(null)
    vi.restoreAllMocks()
  })

  // 「いまの時刻と比べて古いから捨てる」判定（緊急地震速報の入口）がこれを見る。未較正を信じると、
  // ずれた壁時計で本物の報を捨てる
  it('時計を信じてよいのは、再生中か較正済みのときだけ', () => {
    expect(isServerClockTrusted()).toBe(false)
    setReplayOffset(0)
    expect(isServerClockTrusted()).toBe(true)
    setReplayOffset(null)
    expect(isServerClockTrusted()).toBe(false)
    feedServerSample(Date.now() + 500, 'primary')
    expect(isServerClockTrusted()).toBe(true)
    // タブ復帰で較正を捨てたら、また信じない
    fireVisibleAfterWallJump(60_000)
    expect(isServerClockTrusted()).toBe(false)
  })

  it('較正前は オフセットも鮮度も null（壁時計フォールバック中であることが分かる）', () => {
    expect(getServerClockOffsetMs()).toBeNull()
    expect(getServerClockSampleAgeMs()).toBeNull()
  })

  it('サンプルを与えると較正され、鮮度が返るようになる', () => {
    feedServerSample(Date.now() + 500, 'primary')

    expect(getServerClockOffsetMs()).not.toBeNull()
    const age = getServerClockSampleAgeMs()
    expect(age).not.toBeNull()
    expect(age).toBeLessThan(1000)
  })

  it('鮮度は時間の経過とともに増える（止まった較正を見分けられる）', async () => {
    feedServerSample(Date.now(), 'primary')
    const first = getServerClockSampleAgeMs()!

    // performance.now() を進める。壁時計ではなく単調時計を基準にしているため。
    const base = performance.now()
    vi.spyOn(performance, 'now').mockReturnValue(base + 5000)

    expect(getServerClockSampleAgeMs()!).toBeGreaterThanOrEqual(first + 4000)
  })

  it('タブ復帰で K を捨てるとき、鮮度も一緒に捨てる', () => {
    feedServerSample(Date.now(), 'primary')
    expect(getServerClockSampleAgeMs()).not.toBeNull()

    fireVisibleAfterWallJump(60_000)

    // 片方だけ残ると「未較正なのに直近で較正済み」と読める矛盾した診断になる。
    expect(getServerClockOffsetMs()).toBeNull()
    expect(getServerClockSampleAgeMs()).toBeNull()
  })

  // 正: 時計の関係が閾値以上動いたタブ復帰では K を捨てる（スリープ復帰など）
  it('時計の関係が閾値以上動いていたら、タブ復帰で K を捨てる', () => {
    feedServerSample(Date.now() + 500, 'primary')
    // 境目ちょうどではなく少し越えた値で見る（テストの中でも本物の時計がわずかに進み、差が縮むため）
    fireVisibleAfterWallJump(RESUME_DISCARD_THRESHOLD_MS + 10)
    expect(getServerClockOffsetMs()).toBeNull()
  })

  // 対照: 関係がほとんど動いていない（ただのタブ切替）なら K を保つ
  it('時計の関係が閾値の手前なら、タブ復帰でも K を保つ', () => {
    feedServerSample(Date.now() + 500, 'primary')
    fireVisibleAfterWallJump(RESUME_DISCARD_THRESHOLD_MS - 50)
    // K はそのまま。壁時計だけ 450 ms 進めたので、壁時計との差は 500 − 450 ≈ 50 に見える
    expect(Math.abs(getServerClockOffsetMs()! - 50)).toBeLessThan(30)
    expect(getServerClockSampleAgeMs()).not.toBeNull()
  })

  // 正: 差が置き換えの下限以上動いて K を保ったとき、次の主経路のサンプルは EMA を通さず K を置き換える
  it('差が動いて K を保ったタブ復帰の次の主経路のサンプルは、K を置き換える', () => {
    feedServerSample(Date.now() + 500, 'primary')
    fireVisibleAfterWallJump(100)
    feedServerSample(Date.now() + 2000, 'primary')
    // EMA なら 400×0.8＋2000×0.2 ≈ 720。置き換えなら ≈ 2000
    expect(Math.abs(getServerClockOffsetMs()! - 2000)).toBeLessThan(30)
  })

  // 対照: タブ復帰を挟まなければ、2 つ目のサンプルは EMA で混ぜる
  it('タブ復帰を挟まなければ、次のサンプルは EMA で混ぜる', () => {
    feedServerSample(Date.now() + 500, 'primary')
    feedServerSample(Date.now() + 2000, 'primary')
    expect(Math.abs(getServerClockOffsetMs()! - 800)).toBeLessThan(30)
  })

  // 対照: ただのタブ切替（差がほとんど動かない）では、平均で均した K を 1 サンプルへ差し替えない
  it('差がほとんど動いていないタブ復帰の後は、EMA のまま混ぜる', () => {
    feedServerSample(Date.now() + 500, 'primary')
    fireVisible()
    feedServerSample(Date.now() + 2000, 'primary')
    expect(Math.abs(getServerClockOffsetMs()! - 800)).toBeLessThan(30)
  })

  // 境界: 置き換えの下限の手前では混ぜ、越えたら置き換える
  // （テストの中でも本物の時計がわずかに進み差が縮むので、境目ちょうどではなく ±5 ms で見る）
  it.each([
    { jump: RESUME_REPLACE_MIN_DRIFT_MS - 5, replaced: false },
    { jump: RESUME_REPLACE_MIN_DRIFT_MS + 5, replaced: true },
  ])('差が $jump ms 動いたタブ復帰の後、置き換えるのは $replaced', ({ jump, replaced }) => {
    feedServerSample(Date.now() + 500, 'primary')
    fireVisibleAfterWallJump(jump)
    feedServerSample(Date.now() + 2000, 'primary')
    const ema = (500 - jump) * 0.8 + 2000 * 0.2
    expect(Math.abs(getServerClockOffsetMs()! - (replaced ? 2000 : ema))).toBeLessThan(30)
  })

  // 安全弁: フォールバックのサンプルでは置き換えず、置き換えは次の主経路のサンプルまで残す
  it('フォールバックのサンプルでは置き換えず、次の主経路のサンプルで置き換える', () => {
    feedServerSample(Date.now() + 500, 'primary')
    fireVisibleAfterWallJump(100)
    feedServerSample(Date.now() + 2000, 'fallback')
    // EMA: 400×0.8＋2000×0.2 ≈ 720
    expect(Math.abs(getServerClockOffsetMs()! - 720)).toBeLessThan(30)
    feedServerSample(Date.now() + 1000, 'primary')
    expect(Math.abs(getServerClockOffsetMs()! - 1000)).toBeLessThan(30)
  })

  // 安全弁: 置き換えは 1 回きり。その次からは EMA へ戻る
  it('置き換えは 1 回だけで、その次は EMA へ戻る', () => {
    feedServerSample(Date.now() + 500, 'primary')
    fireVisibleAfterWallJump(100)
    feedServerSample(Date.now() + 2000, 'primary')
    feedServerSample(Date.now(), 'primary')
    // 2000×0.8＋0×0.2 ≈ 1600
    expect(Math.abs(getServerClockOffsetMs()! - 1600)).toBeLessThan(30)
  })

  // 対照: 壁時計が逆向きに飛んだ場合も捨てる（どちらの時計が飛んだかは区別できない）
  it('壁時計が戻る向きに飛んでも、閾値以上なら捨てる', () => {
    feedServerSample(Date.now(), 'primary')
    fireVisibleAfterWallJump(-RESUME_DISCARD_THRESHOLD_MS * 2)
    expect(getServerClockOffsetMs()).toBeNull()
  })

  // 安全弁: リプレイ中のタブ復帰は較正に触らない（K は保ったまま、リプレイが終われば使える）
  it('リプレイ中のタブ復帰では、時計が飛んでいても K に触らない', () => {
    feedServerSample(Date.now(), 'primary')
    setReplayOffset(-3600_000)
    fireVisibleAfterWallJump(60_000)
    vi.restoreAllMocks()
    setReplayOffset(null)
    expect(getServerClockOffsetMs()).not.toBeNull()
  })

  it('リプレイ中はサンプルを受け付けない（アーカイブ時刻で K を汚さない）', () => {
    setReplayOffset(-3600_000)
    feedServerSample(Date.now(), 'primary')

    expect(getServerClockSampleAgeMs()).toBeNull()
    // リプレイ中の serverNow はオフセット適用の壁時計。
    expect(serverNow()).toBeLessThan(Date.now())
  })

  it('有限でない値は較正に使わない', () => {
    feedServerSample(Number.NaN, 'primary')
    expect(getServerClockSampleAgeMs()).toBeNull()

    feedServerSample(Number.POSITIVE_INFINITY, 'primary')
    expect(getServerClockSampleAgeMs()).toBeNull()
  })
})
