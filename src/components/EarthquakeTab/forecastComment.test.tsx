// @vitest-environment jsdom
//
// 地震カードの「気象庁が添えた文」の枠（→ docs/spec/quake-spec.md §3「地震カードには付加文を 1 つの枠で出す」）。
//
// - 固定付加文（`forecastText`）・その他（`varCommentText`）・自由付加文（`freeText`）を **1 つの枠**に、
//   電文と同じ並びで出す（2026-10-23 ユーザー承認「一つにまとめましょうか。」）
// - 固定付加文から、津波の区分を決めるコードの文を除く（同日「それで進めて。」）。津波の札が同じ事実を伝えている
//
// 区分にならない文（0245「この地震で緊急地震速報を発表しましたが、強い揺れは観測されませんでした。」）は
// この枠にしか現れない。消しても型検査は通り例外も出ないので、ここで固定する。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { flushDataEffects } from '../../test-utils/flushDataEffects'
import { EarthquakeTab } from './index'
import { quakeEventKey } from '../../utils/quakeMerge'
import type { JMAQuake } from '../../types/earthquake'
import { createEmptyTelegramLoss } from '../../utils/telegramLoss'
import { log } from '../../utils/logger'

afterEach(cleanup)

// jsdom は `scrollIntoView` を持たない（寄せる動きはこのテストの対象ではない）。
HTMLElement.prototype.scrollIntoView = () => {}

/** 2026-10-16 カムチャツカ半島付近 M6.9 の実電文（VXSE53）の固定付加文。パーサーは改行を詰めて 1 行にする。 */
const TSUNAMI_SENTENCE = 'この地震による津波の心配はありません。'
const EEW_SENTENCE = 'この地震で緊急地震速報を発表しましたが、強い揺れは観測されませんでした。'
const FORECAST_TEXT = TSUNAMI_SENTENCE + EEW_SENTENCE
const VAR_COMMENT_TEXT = '＊印は気象庁以外の震度観測点についての情報です。'

function makeQuake(over: Partial<JMAQuake> = {}): JMAQuake {
  return {
    kind: 'quake',
    id: 'dmdata-quake-20261016123810-1',
    eventId: '20261016123810',
    time: '2026-10-16T03:52:00Z',
    issue: { source: 'テスト', time: '2026-10-16T03:52:00Z', type: '震源・震度情報', correct: 'なし' },
    earthquake: {
      time: '2026-10-16T03:35:00Z',
      hypocenter: { name: 'カムチャツカ半島付近', latitude: 50.0, longitude: 158.1, depth: 160, magnitude: 6.9 },
      maxScale: 10,
      domesticTsunami: 'なし',
      domesticTsunamiCode: '0215',
    },
    points: [],
    forecastText: FORECAST_TEXT,
    varCommentText: VAR_COMMENT_TEXT,
    ...over,
  }
}

const renderTab = async (quake: JMAQuake, selected = true) => {
  render(
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
      lpgmByEventId={new Map()}
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
      seismoWaveView="composite"
    />,
  )
  await flushDataEffects()
}

/** 枠の中の段落を、出ている順に返す。 */
function paragraphsInBox(anyText: string): string[] {
  const box = screen.getByText(anyText).parentElement
  if (!box) throw new Error('枠が見つかりません')
  return Array.from(box.children).map(el => el.textContent ?? '')
}

describe('地震カードの付加文の枠', () => {
  // 正: 区分にならない文は出し、津波の区分の文は除く。
  it('津波の区分の文を除き、残りを出す', async () => {
    await renderTab(makeQuake())
    expect(screen.getByText(EEW_SENTENCE)).toBeTruthy()
    expect(screen.queryByText(TSUNAMI_SENTENCE, { exact: false })).toBeNull()
  })

  // 正: 3 種を 1 つの枠に、電文と同じ並び（固定付加文 → その他 → 自由付加文）で出す。
  it('3 種を 1 つの枠に電文の並びで出す', async () => {
    const freeText = '震源の近傍で、やや強い揺れを観測しました。'
    await renderTab(makeQuake({ freeText }))
    expect(paragraphsInBox(EEW_SENTENCE)).toEqual([EEW_SENTENCE, VAR_COMMENT_TEXT, freeText])
  })

  // 対照: 区分の文しか無い固定付加文は段落を作らない（空の段落を残さない）。
  it('区分の文しか無ければ固定付加文の段落を作らない', async () => {
    await renderTab(makeQuake({ forecastText: TSUNAMI_SENTENCE }))
    expect(paragraphsInBox(VAR_COMMENT_TEXT)).toEqual([VAR_COMMENT_TEXT])
  })

  // 対照: どれも残らなければ枠ごと出さない（P2PQuake 経路など付加文を持たない電文も同じ）。
  it('何も残らなければ枠を出さない', async () => {
    await renderTab(makeQuake({ forecastText: TSUNAMI_SENTENCE, varCommentText: undefined }))
    expect(screen.queryByText(TSUNAMI_SENTENCE, { exact: false })).toBeNull()
    expect(document.querySelector('.whitespace-pre-wrap.bg-panel')).toBeNull()
  })

  // 安全弁: 区分を津波電文から借りてコードを持たないカードでも、原文の津波の文は除く
  // （残すと「津波警報等」の札の下に「津波の心配はありません」が並ぶ）。
  it('コードを持たないカードでも区分の文を除く', async () => {
    const base = makeQuake()
    await renderTab(makeQuake({ earthquake: { ...base.earthquake, domesticTsunami: '警報等', domesticTsunamiCode: undefined } }))
    expect(screen.getByText(EEW_SENTENCE)).toBeTruthy()
    expect(screen.queryByText(TSUNAMI_SENTENCE, { exact: false })).toBeNull()
  })

  // 正: 札が伝えきれないコード（0212 の「被害の心配はありません」）は、カード自身のコードの文を残す
  // （2026-10-23 ユーザー選択「Aでお願いします。」）。
  it('札が伝えきれないコードの文は残す', async () => {
    const own = 'この地震により、日本の沿岸では若干の海面変動があるかもしれませんが、被害の心配はありません。'
    const base = makeQuake()
    await renderTab(makeQuake({
      forecastText: own + EEW_SENTENCE,
      earthquake: { ...base.earthquake, domesticTsunami: '若干の海面変動', domesticTsunamiCode: '0212' },
    }))
    expect(paragraphsInBox(VAR_COMMENT_TEXT)[0]).toBe(own + EEW_SENTENCE)
  })

  // 安全弁: 残すのはカード自身のコードの文だけ。コード 0212 のカードでも、原文が前の報のまま（0215 の文）なら除く。
  it('原文が別のコードの文なら、残すコードのカードでも除く', async () => {
    const base = makeQuake()
    await renderTab(makeQuake({
      earthquake: { ...base.earthquake, domesticTsunami: '若干の海面変動', domesticTsunamiCode: '0212' },
    }))
    expect(paragraphsInBox(EEW_SENTENCE)[0]).toBe(EEW_SENTENCE)
  })

  // 正: コードを持つのに表の文が原文に 1 つも無ければ（気象庁が文面を変えた疑い）記録を残す。
  it('表の文が原文に無ければ記録を残す', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      await renderTab(makeQuake({ forecastText: `文面の変わった津波の文。${EEW_SENTENCE}` }))
      expect(warn.mock.calls.some(c => String(c[0]).includes('区分を決めるコードの文が見つかりません'))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  // 対照: 表の文が原文にあれば記録しない。
  it('表の文が原文にあれば記録しない', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      await renderTab(makeQuake())
      expect(warn.mock.calls.some(c => String(c[0]).includes('区分を決めるコードの文が見つかりません'))).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })

  // 安全弁: 表と一字でも違う文は除かない（推し量って落とし過ぎない）。
  it('表と一致しない文は残す', async () => {
    const changed = 'この地震による津波の心配はありません'  // 句点が無い
    await renderTab(makeQuake({ forecastText: changed, varCommentText: undefined }))
    expect(screen.getByText(changed)).toBeTruthy()
  })

  // 安全弁: 一覧の畳んだカードには出さない（選択中のカードだけ）。
  it('選んでいないカードには出さない', async () => {
    await renderTab(makeQuake(), false)
    expect(screen.queryByText(EEW_SENTENCE)).toBeNull()
  })
})
