// @vitest-environment jsdom
//
// 地震カードが電文の値をそのまま出す 4 つの欄（2026-10-22 ユーザー承認）。
//
// - 規模の種別（`jmx_eb:Magnitude@type`）＝「1-A 電文のまま」
// - 編集した官署（`Control/EditorialOffice`）＝「3-B 編集官署 …」
// - 長周期地震動の名乗り（`Head/Title`）＝「4-B 種別ヘッダー」
// - 震源を決めた機関（`Hypocenter/Source`）＝「6-A 津波タブと同じ」
//
// **どれも「電文が持っているのに画面へ出していなかった」もの。** 出し忘れても型検査は通り、
// 例外も出ない —— 画面を見た人が気づくまで分からないので、ここで固定する。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { flushDataEffects } from '../../test-utils/flushDataEffects'
import { EarthquakeTab } from './index'
import { quakeEventKey } from '../../utils/quakeMerge'
import type { JMAQuake, JMALpgm, Hypocenter } from '../../types/earthquake'
import { createEmptyTelegramLoss } from '../../utils/telegramLoss'

afterEach(cleanup)

HTMLElement.prototype.scrollIntoView = () => {}

const EVENT_ID = '20240101161000'

function makeQuake(o: { hypocenter?: Partial<Hypocenter>; issueSource?: string; editorialOffice?: string | null } = {}): JMAQuake {
  return {
    kind: 'quake',
    id: `dmdata-quake-${EVENT_ID}-1`,
    eventId: EVENT_ID,
    time: '2024-01-01T07:24:00Z',
    issue: {
      source: o.issueSource ?? '気象庁',
      ...(o.editorialOffice !== null && { editorialOffice: o.editorialOffice ?? '気象庁本庁' }),
      time: '2024-01-01T07:24:00Z',
      type: '震源・震度情報',
      correct: 'なし',
    },
    earthquake: {
      time: '2024-01-01T07:10:00Z',
      hypocenter: {
        name: '石川県能登地方', latitude: 37.495, longitude: 137.27, depth: 16, magnitude: 7.6,
        ...o.hypocenter,
      },
      maxScale: 45,
      domesticTsunami: '警報等',
    },
    points: [{ pref: '石川県', addr: '石川県能登', isArea: true, scale: 45 }],
  }
}

function makeLpgm(infoName?: string): JMALpgm {
  return {
    id: `dmdata-lpgm-${EVENT_ID}-1`,
    eventId: EVENT_ID,
    time: '2024-01-01T07:30:00Z',
    ...(infoName && { infoName }),
    originTime: '2024-01-01T07:10:00Z',
    maxClass: 4,
    cancelled: false,
  }
}

const renderTab = async (quake: JMAQuake, selected: boolean, lpgm?: JMALpgm) => {
  const result = render(
    <EarthquakeTab
      earthquakes={[quake]}
      selectedId={selected ? quakeEventKey(quake) : null}
      speakingKey={null}
      followSpeech={false}
      onSelect={() => {}}
      isLoading={false}
      isLoadingMore={false}
      hasMore={false}
      onLoadMore={() => {}}
      watchLoadMoreThrottle={false}
      error={null}
      historyLoss={createEmptyTelegramLoss()}
      loadMoreFailed={false}
      reconnectGapLoss={false}
      fetchThrottled={false}
      lpgmByEventId={lpgm ? new Map([[EVENT_ID, lpgm]]) : new Map()}
      updateMarks={new Map()}
      activeLpgmEventId={null}
      onToggleLpgm={() => {}}
      estimatedIntensities={[]}
      distributionQuakeKey={null}
      onToggleDistribution={() => {}}
      unreceivedQuakeKey={null}
      onToggleUnreceived={() => {}}
      onFocusMap={() => {}}
      speakingTelegramTextSubject={null}
      seismoWaves={new Map()}
      seismoWaveFailedKeys={new Set()}
      seismoWaveView="composite"
    />
  )
  await flushDataEffects()
  return result
}

describe('規模の種別（Mj／M）', () => {
  // 正: 畳んだ表示の前置きが電文の種別になる。
  it('畳んだ表示は電文の種別を前置きにする', async () => {
    await renderTab(makeQuake({ hypocenter: { magnitudeType: 'Mj' } }), false)
    expect(screen.getAllByText(/Mj7\.6/).length).toBeGreaterThan(0)
  })

  // 対照: 種別を持たない電文（標準版）は従来どおり `M`。
  it('種別が無ければ従来どおり M', async () => {
    await renderTab(makeQuake(), false)
    expect(screen.getAllByText(/M7\.6/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Mj7\.6/)).toBeNull()
  })

  // 正: 開いた表示は、見出しが種別の名前を名乗り、値は記号つきで出す（2026-10-23 ユーザー承認
  // 「まあそれで行きましょう」）。値の下へ名前を添えていた版は「マグニチュード 7.6 気象庁マグニチュード」と読めた。
  it('開いた表示は見出しで種別を名乗り、値に記号を付ける', async () => {
    await renderTab(makeQuake({ hypocenter: { magnitudeType: 'Mj' } }), true)
    const heading = screen.getByText('気象庁マグニチュード')
    expect(heading.nextElementSibling?.textContent).toMatch(/^Mj7\.6/)
    expect(screen.queryByText('マグニチュード')).toBeNull()
  })

  // 対照: **`M` には語を添えない**（2026-10-23 ユーザー承認「資料の裏付けがある分だけ」）。
  // 気象庁の資料が定めているのは `Mj` だけ。誰が決めた値かは、機関が入っているときだけ
  // 別の行（「震源決定: …（気象庁以外）」）で出す。記号の `M6.8` は畳んだ表示に出る。
  it('M には語を添えない', async () => {
    await renderTab(makeQuake({ hypocenter: { magnitudeType: 'M' } }), true)
    expect(screen.queryByText('気象庁マグニチュード')).toBeNull()
    expect(screen.getByText('マグニチュード').nextElementSibling?.textContent).toMatch(/^M7\.6/)
    expect(screen.queryByText('気象庁以外の値')).toBeNull()
  })

  // 安全弁: **知らない種別にも語を添えない。** 意味を推し量って言い換えない。
  it('知らない種別には語を添えない', async () => {
    await renderTab(makeQuake({ hypocenter: { magnitudeType: 'Mw' } }), true)
    expect(screen.queryByText('気象庁マグニチュード')).toBeNull()
  })
})

describe('編集した官署', () => {
  // 正: 常に出す（2026-10-21 ユーザー「常に出したいです。」）。
  it('開いた表示に出す', async () => {
    await renderTab(makeQuake({ editorialOffice: '大阪管区気象台' }), true)
    expect(screen.getAllByText('編集官署 大阪管区気象台').length).toBeGreaterThan(0)
  })

  // 対照: 編集官署を持たない電文（標準版）では、欄ごと出さない。
  it('電文に無ければ出さない', async () => {
    await renderTab(makeQuake({ editorialOffice: null }), true)
    expect(screen.queryByText(/編集官署/)).toBeNull()
  })

  // 安全弁: **`issue.source` は出さない。** あちらは DMDATA では発表官署（「気象庁」）へ落ち、
  // 標準版では P2PQuake の発表元が入る。「編集官署」と名乗って出すとラベルが事実を誤らせる
  // （2026-10-23 ユーザー承認「欄を分ける」。この守りが無いと標準版の全カードに
  // 「編集官署 気象庁」が出る）。
  it('発表元を編集官署として出さない', async () => {
    await renderTab(makeQuake({ issueSource: '気象庁', editorialOffice: null }), true)
    expect(screen.queryByText(/編集官署/)).toBeNull()
    expect(screen.queryByText('編集官署 気象庁')).toBeNull()
  })
})

describe('震源を決めた機関', () => {
  // 正: 気象庁以外が決めた震源のときだけ出る。**機関名だけでは含意が伝わらない**ので
  // ラベルに書く（津波カードと同じ文面）。
  it('機関名と「気象庁以外」を並べて出す', async () => {
    await renderTab(makeQuake({ hypocenter: { source: 'ＵＳＧＳ' } }), true)
    expect(screen.getAllByText(/震源決定: ＵＳＧＳ（気象庁以外）/).length).toBeGreaterThan(0)
  })

  // 対照: 気象庁が決めた震源では電文に入らないので、行ごと出ない。
  it('電文に無ければ行ごと出さない', async () => {
    await renderTab(makeQuake(), true)
    expect(screen.queryByText(/震源決定/)).toBeNull()
  })
})

describe('長周期地震動の名乗り', () => {
  // 正: 種別ヘッダーへ並べる。あそこは「どの電文を受け取ったか」を出す場所。
  it('種別ヘッダーへ並べる', async () => {
    await renderTab(makeQuake(), true, makeLpgm('長周期地震動に関する観測情報'))
    expect(screen.getAllByText(/長周期地震動に関する観測情報/).length).toBeGreaterThan(0)
  })

  // 対照: 長周期の電文を受けていないカードには出ない。
  it('長周期を受けていなければ出ない', async () => {
    await renderTab(makeQuake(), true)
    expect(screen.queryByText(/長周期地震動に関する観測情報/)).toBeNull()
  })

  // 安全弁: **帯のラベルは「長周期地震動」のまま。** あちらは階級の見出しなので、
  // 名乗りで置き換えると長くなる（名乗りはヘッダー側に出す）。
  it('帯のラベルは短いまま', async () => {
    await renderTab(makeQuake(), true, makeLpgm('長周期地震動に関する観測情報'))
    expect(screen.getAllByText('長周期地震動').length).toBeGreaterThan(0)
  })
})
