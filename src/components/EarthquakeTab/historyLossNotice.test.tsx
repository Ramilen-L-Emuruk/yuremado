// @vitest-environment jsdom
//
// 履歴の一部が取れなかったことを地震タブへ出す。
//
// 履歴取得の大半は例外を投げずに一部の失敗を吸収するため `error` は立たない。**画面には取れた分の
// カードだけが出て、失敗は何も出ない**状態だった（実測 2026-09-15: 起動時の電文本体 85 件のうち
// 81 件が 429 で失敗し、4 件しか出ていなかった）。取得元が「日」単位なので、1 日落ちれば
// 失う電文は多い。
//
// **いちばん効くのはカードが 0 件のとき。** 出さないと「7 日のうち 6 日が落ちて 0 件」が
// 「まったく静かな期間だった」と同じ画になる。
//
// 取得がまるごと失敗して `error` が立ったときも、カードがあれば一覧を残し、失敗は帯の先頭で知らせる
// （カードが 0 件なら全画面の失敗表示）。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { flushDataEffects } from '../../test-utils/flushDataEffects'
import { EarthquakeTab } from './index'
import { quakeEventKey } from '../../utils/quakeMerge'
import type { JMAQuake } from '../../types/earthquake'
import { createEmptyTelegramLoss, addTelegramLoss, type TelegramLoss } from '../../utils/telegramLoss'

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

afterEach(cleanup)

HTMLElement.prototype.scrollIntoView = () => {}

const EVENT_ID = '20240101161000'

const QUAKE: JMAQuake = {
  kind: 'quake',
  id: `dmdata-quake-${EVENT_ID}-1`,
  eventId: EVENT_ID,
  time: '2024-01-01T07:24:00Z',
  issue: { source: 'テスト', time: '2024-01-01T07:24:00Z', type: '震源・震度情報', correct: 'なし' },
  earthquake: {
    time: '2024-01-01T16:10:00+09:00',
    hypocenter: { name: '石川県能登地方', latitude: 37.495, longitude: 137.27, depth: 16, magnitude: 7.6 },
    maxScale: 45,
    domesticTsunami: '警報等',
  },
  points: [{ pref: '石川県', addr: '石川県能登', isArea: true, scale: 45 }],
}

async function renderTab(opts: {
  earthquakes?: JMAQuake[]
  historyLoss?: TelegramLoss
  loadMoreFailed?: boolean
  reconnectGapLoss?: boolean
  fetchThrottled?: boolean
  error?: string | null
}) {
  const earthquakes = opts.earthquakes ?? [QUAKE]
  const result = render(
    <EarthquakeTab
      earthquakes={earthquakes}
      selectedId={earthquakes[0] ? quakeEventKey(earthquakes[0]) : null}
      speakingKey={null}
      followSpeech={false}
      onSelect={() => {}}
      isLoading={false}
      isLoadingMore={false}
      hasMore={false}
      onLoadMore={() => {}}
      watchLoadMoreThrottle={false}
      error={opts.error ?? null}
      historyLoss={opts.historyLoss ?? createEmptyTelegramLoss()}
      loadMoreFailed={opts.loadMoreFailed ?? false}
      reconnectGapLoss={opts.reconnectGapLoss ?? false}
      fetchThrottled={opts.fetchThrottled ?? false}
      lpgmByEventId={new Map()}
      updateMarks={new Map()}
      activeLpgmEventId={null}
      onToggleLpgm={() => {}}
      estimatedIntensities={[]}
      internationalTsunamis={[]}
      distributionQuakeKey={null}
      onToggleDistribution={() => {}}
      unreceivedQuakeKey={null}
      onToggleUnreceived={() => {}}
      onFocusMap={() => {}}
      speakingTelegramTextSubject={null}
      seismoWaves={new Map()}
      seismoWaveFailedKeys={new Set()}
      seismoWaveView="composite"
    />,
  )
  // 観測点を持たない空の一覧（`earthquakes: []`）ではカードが 1 枚も描かれず、
  // `useSubRegions` の失敗経路も起きない。それでも毎回呼んでおけば無害。
  await flushDataEffects()
  return result
}

describe('履歴の一部が取れなかったときの帯', () => {
  it('正: 取得元が 1 件でも読めなければ帯を出す', async () => {
    await renderTab({ historyLoss: addTelegramLoss(createEmptyTelegramLoss(), skips(0), ['https://x/a']) })

    expect(screen.getByText(/取得元1件.*取り込めず/)).toBeTruthy()
  })

  // **カードは覆わない。** 全画面のエラー表示と違って、取れた分は見られなければならない。
  it('正: 帯を出してもカードは残る', async () => {
    await renderTab({ historyLoss: addTelegramLoss(createEmptyTelegramLoss(), skips(2), []) })

    expect(screen.getByText(/電文2件/)).toBeTruthy()
    expect(screen.getByText('石川県能登地方')).toBeTruthy()
  })

  // ここが「静かな期間だった」との見分け。
  it('正: カードが 0 件でも帯を出す（「地震情報はありません」だけにしない）', async () => {
    await renderTab({
      earthquakes: [],
      historyLoss: addTelegramLoss(createEmptyTelegramLoss(), skips(0), ['https://x/a', 'https://x/b']),
    })

    expect(screen.getByText('地震情報はありません')).toBeTruthy()
    expect(screen.getByText(/取得元2件/)).toBeTruthy()
  })

  it('対照: 何も欠けていなければ帯は出ない', async () => {
    await renderTab({})

    expect(screen.queryByText(/取り込めず/)).toBeNull()
  })

  it('対照: カードが 0 件でも、欠けていなければ帯は出ない', async () => {
    await renderTab({ earthquakes: [] })

    expect(screen.getByText('地震情報はありません')).toBeTruthy()
    expect(screen.queryByText(/取り込めず/)).toBeNull()
  })

  // 確定した損失と、押し直せば回復しうる失敗は別の文面で出す。混ぜると、戻せない損失と
  // 戻せる失敗が同じ重さに見える。
  it('正: 「もっと見る」の失敗は別の文面で出す', async () => {
    await renderTab({ loadMoreFailed: true })

    expect(screen.getByText(/続きの読み込みに失敗/)).toBeTruthy()
  })

  // 接続が切れていた間の取りこぼし（2026-10-21 ユーザー承認「A・X・揃える」）。履歴の損失と同じ帯の並びに出す
  it('正: 接続が切れていた間の電文を取り戻せていなければ、その文面で出す', async () => {
    await renderTab({ reconnectGapLoss: true })

    expect(screen.getByText('接続が切れていた間の電文を取り込めず（再読み込みで取得し直します）')).toBeTruthy()
    expect(screen.getByText('石川県能登地方')).toBeTruthy()
  })

  it('正: 接続が切れていた間の取りこぼしは、カードが 0 件でも出す', async () => {
    await renderTab({ earthquakes: [], reconnectGapLoss: true })

    expect(screen.getByText('地震情報はありません')).toBeTruthy()
    expect(screen.getByText(/接続が切れていた間の電文を取り込めず/)).toBeTruthy()
  })

  it('対照: 履歴の損失だけなら、接続が切れていた間の文面は出ない', async () => {
    await renderTab({ historyLoss: addTelegramLoss(createEmptyTelegramLoss(), skips(1), []) })

    expect(screen.queryByText(/接続が切れていた間/)).toBeNull()
  })

  it('正: 両方あれば両方出す', async () => {
    await renderTab({
      historyLoss: addTelegramLoss(createEmptyTelegramLoss(), skips(1), []),
      loadMoreFailed: true,
    })

    expect(screen.getByText(/電文1件/)).toBeTruthy()
    expect(screen.getByText(/続きの読み込みに失敗/)).toBeTruthy()
  })

  // 安全弁: カードが 1 枚も無いとき（`error`）は全画面の失敗表示が出る。そこへ帯を重ねない
  // ——「一部が欠けた」と「まるごと失敗した」が同じ画面に並ぶと、どちらの話か読めない。
  it('安全弁: カードが無いときの全滅の表示には帯を重ねない', async () => {
    await renderTab({
      earthquakes: [],
      error: '取得失敗',
      historyLoss: addTelegramLoss(createEmptyTelegramLoss(), skips(1), ['https://x/a']),
    })

    expect(screen.getByText('データの取得に失敗')).toBeTruthy()
    expect(screen.queryByText(/取り込めず（再読み込み/)).toBeNull()
  })

  // 正（2026-10-21 に覆した。以前はカードがあっても一覧ごと全画面の失敗表示へ差し替えていた）:
  // 起動時の履歴より先に、または失敗の後にライブで届いた地震は state にあるので、一覧を残して
  // 失敗は帯で知らせる。文面は全画面の表示と同じ語に、中身を括弧で添える。
  it('正: カードがあれば一覧を残し、失敗を帯で出す', async () => {
    await renderTab({ error: 'HTTP 500' })

    expect(screen.getByText('データの取得に失敗（HTTP 500）')).toBeTruthy()
    expect(screen.getByText(/石川県能登地方/)).toBeTruthy()
  })

  // 安全弁: 中身が空の例外でも失敗は知らせる（空文字は偽なので、真偽で見ると帯も全画面の表示も消える）。
  // 空のときは括弧を付けない。
  it('安全弁: エラーの中身が空でも失敗を知らせる', async () => {
    await renderTab({ error: '' })
    expect(screen.getByText('データの取得に失敗')).toBeTruthy()
    expect(screen.getByText(/石川県能登地方/)).toBeTruthy()
  })

  // 安全弁: 失敗の帯は損失の帯の先頭に並ぶ（履歴がまるごと取れていないので、日ごとの欠けより重い）。
  // 他の帯を押しのけて消さない。
  it('安全弁: 失敗の帯と損失の帯が両方出て、失敗が先頭に来る', async () => {
    await renderTab({
      error: '取得失敗',
      historyLoss: addTelegramLoss(createEmptyTelegramLoss(), skips(1), ['https://x/a']),
    })

    const failed = screen.getByText('データの取得に失敗（取得失敗）')
    const loss = screen.getByText(/取り込めず（再読み込み/)
    expect(failed.compareDocumentPosition(loss) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

// 配信元の上限に達したことを画面へ出す。**2 つは性質が違う** ——
// 待っているだけ（欠けない）か、その回は見送った（欠けている）か。
describe('取得制限中の帯', () => {
  // 正: 待たされているあいだは出す。**利用者から見れば「止まっている」ようにしか見えない**ので、
  // 理由が画面に無いと故障と区別が付かない。
  it('正: 上限に達して待っているあいだ、自動で再開すると伝える', async () => {
    await renderTab({ fetchThrottled: true })

    expect(screen.getByText('リクエスト過多のため、取得制限中（自動で再開します）')).toBeTruthy()
  })

  // 対照: 待っていなければ出さない
  it('対照: 待っていなければ出さない', async () => {
    await renderTab({})

    expect(screen.queryByText(/取得制限中/)).toBeNull()
  })

  // 正: 429 の窓で見送った分は、件数を添えて出す。
  // **この経路は型と集計だけがあって消費先が 1 つも無く、画面に一度も出ていなかった。**
  it('正: 429 で見送った分を、取得元と電文それぞれの件数で出す', async () => {
    await renderTab({
      historyLoss: addTelegramLoss(createEmptyTelegramLoss(), skips(0), [], {
        sources: ['https://x/a', 'https://x/b'], telegrams: 5,
      }),
    })

    expect(screen.getByText('リクエスト過多のため、取得制限中（取得元2件・電文5件が未取得）')).toBeTruthy()
  })

  // 安全弁: **取得元と電文は単位が違うので合算しない。** 取得元単位で見送った日は
  // 「その日に何通あったか」すら分からないため、電文数へ足せない。
  it('安全弁: 取得元だけのときに電文の件数を足さない', async () => {
    await renderTab({
      historyLoss: addTelegramLoss(createEmptyTelegramLoss(), skips(0), [], { sources: ['https://x/a'] }),
    })

    expect(screen.getByText('リクエスト過多のため、取得制限中（取得元1件が未取得）')).toBeTruthy()
  })

  // 安全弁: **見送りと確定した損失は別の帯で出す。** 混ぜると、待てば取れるものが
  // 取り返しのつかない損失として読まれる。
  it('安全弁: 確定した損失と見送りは別々の帯になる', async () => {
    await renderTab({
      historyLoss: addTelegramLoss(createEmptyTelegramLoss(), skips(3), ['https://x/a'], { telegrams: 2 }),
    })

    expect(screen.getByText(/取り込めず（再読み込み/)).toBeTruthy()
    expect(screen.getByText('リクエスト過多のため、取得制限中（電文2件が未取得）')).toBeTruthy()
    // **形をそろえたぶん、差は語だけが担う。** 確定した損失は「取り込めず」、
    // 見送りは「未取得」。片方の帯にもう片方の語が混ざっていないことまで見る。
    expect(screen.getByText(/取り込めず（再読み込み/).textContent).not.toMatch(/未取得/)
  })
})
