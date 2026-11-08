// @vitest-environment jsdom
//
// 地震カードの「気象庁からの補足」（→ docs/spec/quake-spec.md §3「地震カードには付加文を 1 つの枠で出す」）。
//
// - 固定付加文（`forecastText`）・その他（`varCommentText`）・自由付加文（`freeText`）を **1 つの枠**に、
//   電文と同じ並びで出す（2026-10-23 ユーザー承認「一つにまとめましょうか。」）
// - 1 文 1 行にし、種類が 2 つ以上のときだけ「津波」「緊急地震速報」「その他」「自由付加文」の見出しを付ける
//   （→ docs/quake-tab-redesign.md。2026-11-01「中身で呼ぶ (Recommended)」）
// - 固定付加文から、津波の区分を決めるコードの文を除く（2026-10-23「それで進めて。」）。津波の札が同じ事実を伝えている
//
// 区分にならない文（0245「この地震で緊急地震速報を発表しましたが、強い揺れは観測されませんでした。」）は
// この枠にしか現れない。消しても型検査は通り例外も出ないので、ここで固定する。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
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

/**
 * 描いて、`openNotes` なら「気象庁からの補足」を開く。**開く行は必ず在ることを確かめる** ——
 * 在るときだけ押す形だと、行ごと消えても中身の確かめが空振りして通ってしまう。
 */
const renderTab = async (quake: JMAQuake, { selected = true, openNotes = true } = {}) => {
  render(
    <EarthquakeTab
      earthquakes={[quake]}
      selectedId={selected ? quakeEventKey(quake) : null}
      selectSeq={0}
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
      onDismissKeyReentry={null}
      lpgmByEventId={new Map()}
      updateMarks={new Map()}
      activeLpgmEventId={null}
      onToggleLpgm={() => {}}
      lpgmFocus={null}
      estimatedIntensities={[]}
      internationalTsunamisByQuake={new Map()}
      distributionQuakeKey={null}
      onToggleDistribution={() => {}}
      unreceivedQuakeKey={null}
      onToggleUnreceived={() => {}}
      onFocusMap={() => {}}
      speakingTelegramTextSubject={null}
      seismoWaves={new Map()}
      seismoWaveFailedKeys={new Set()}
      seismoWaveView="composite"
      historyInputs={null}
      historyPickedId={null}
      historyView={null}
      onPickHistory={() => {}}
      onReplayQuake={() => {}}
      replayError={null}
    />,
  )
  await flushDataEffects()
  // 気象庁が添えた文は畳んで置くので、開いてから確かめる（畳んだ枠は中身を描かない）
  if (openNotes) {
    const toggle = screen.getByRole('button', { name: /^気象庁からの補足/ })
    act(() => { fireEvent.click(toggle) })
  }
}

/** 補足の枠の中の行を、出ている順に返す（1 文 1 行）。 */
function notesLines(): string[] {
  return Array.from(document.querySelectorAll('[data-jma-notes] [data-jma-line]')).map(el => el.textContent ?? '')
}

/** 補足の枠の中の見出しを、出ている順に返す。 */
function notesHeadings(): string[] {
  return Array.from(document.querySelectorAll('[data-jma-notes] [data-jma-heading]')).map(el => el.textContent ?? '')
}

/** 補足の行そのものが無い（枠を出さない）。 */
function expectNoNotes() {
  expect(screen.queryByRole('button', { name: /^気象庁からの補足/ })).toBeNull()
  expect(document.querySelector('[data-jma-notes]')).toBeNull()
}

describe('地震カードの付加文の枠', () => {
  // 正: 区分にならない文は出し、津波の区分の文は除く。
  it('津波の区分の文を除き、残りを出す', async () => {
    await renderTab(makeQuake())
    expect(notesLines()).toEqual([EEW_SENTENCE, VAR_COMMENT_TEXT])
    expect(screen.queryByText(TSUNAMI_SENTENCE, { exact: false })).toBeNull()
  })

  // 正: 3 種を 1 つの枠に、電文と同じ並び（固定付加文 → その他 → 自由付加文）で、見出しを付けて出す。
  it('3 種を 1 つの枠に電文の並びで、見出しを付けて出す', async () => {
    const freeText = '震源の近傍で、やや強い揺れを観測しました。'
    await renderTab(makeQuake({ freeText }))
    expect(notesLines()).toEqual([EEW_SENTENCE, VAR_COMMENT_TEXT, freeText])
    expect(notesHeadings()).toEqual(['緊急地震速報', 'その他', '自由付加文'])
  })

  // 正: 続けて書かれた 2 文は 2 行に割る（1 文 1 行）。
  it('続けて書かれた文を 1 文ずつの行に割る', async () => {
    const second = 'この地震について、緊急地震速報を発表しています。'
    await renderTab(makeQuake({ forecastText: TSUNAMI_SENTENCE + EEW_SENTENCE + second, varCommentText: undefined }))
    expect(notesLines()).toEqual([EEW_SENTENCE, second])
  })

  // 対照: 区分の文しか無い固定付加文は行を作らず、種類が 1 つになるので見出しも付けない。
  it('区分の文しか無ければ固定付加文の行を作らず、見出しも付けない', async () => {
    await renderTab(makeQuake({ forecastText: TSUNAMI_SENTENCE }))
    expect(notesLines()).toEqual([VAR_COMMENT_TEXT])
    expect(notesHeadings()).toEqual([])
  })

  // 対照: どれも残らなければ枠ごと出さない（付加文を持たない電文も同じ）。
  it('何も残らなければ枠を出さない', async () => {
    await renderTab(makeQuake({ forecastText: TSUNAMI_SENTENCE, varCommentText: undefined }), { openNotes: false })
    expect(screen.queryByText(TSUNAMI_SENTENCE, { exact: false })).toBeNull()
    expectNoNotes()
  })

  // 安全弁: 区分を津波電文から借りてコードを持たないカードでも、原文の津波の文は除く
  // （残すと「津波警報等」の札の下に「津波の心配はありません」が並ぶ）。
  it('コードを持たないカードでも区分の文を除く', async () => {
    const base = makeQuake()
    await renderTab(makeQuake({ earthquake: { ...base.earthquake, domesticTsunami: '警報等', domesticTsunamiCode: undefined } }))
    expect(notesLines()).toEqual([EEW_SENTENCE, VAR_COMMENT_TEXT])
    expect(screen.queryByText(TSUNAMI_SENTENCE, { exact: false })).toBeNull()
  })

  // 正: 札が伝えきれないコード（0212 の「被害の心配はありません」）は、カード自身のコードの文を残す
  // （2026-10-23 ユーザー選択「Aでお願いします。」）。津波の文と緊急地震速報の文は別の見出しへ分かれる。
  it('札が伝えきれないコードの文は残す', async () => {
    const own = 'この地震により、日本の沿岸では若干の海面変動があるかもしれませんが、被害の心配はありません。'
    const base = makeQuake()
    await renderTab(makeQuake({
      forecastText: own + EEW_SENTENCE,
      earthquake: { ...base.earthquake, domesticTsunami: '若干の海面変動', domesticTsunamiCode: '0212' },
    }))
    expect(notesLines()).toEqual([own, EEW_SENTENCE, VAR_COMMENT_TEXT])
    expect(notesHeadings()).toEqual(['津波', '緊急地震速報', 'その他'])
  })

  // 安全弁: 残すのはカード自身のコードの文だけ。コード 0212 のカードでも、原文が前の報のまま（0215 の文）なら除く。
  it('原文が別のコードの文なら、残すコードのカードでも除く', async () => {
    const base = makeQuake()
    await renderTab(makeQuake({
      earthquake: { ...base.earthquake, domesticTsunami: '若干の海面変動', domesticTsunamiCode: '0212' },
    }))
    expect(notesLines()).toEqual([EEW_SENTENCE, VAR_COMMENT_TEXT])
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
    expect(notesLines()).toEqual([changed])
  })

  // 固定付加文を持たず、海外への津波の見通しを値から起こした文（`foreignTsunamiText`）で持つ報。
  // 固定付加文と同じ先頭の行に出す（2026-10-29 ユーザー承認「原文のまま (Recommended)」「先頭 (Recommended)」）。
  describe('値から起こした海外への津波の見通し', () => {
    const FOREIGN = '太平洋の広域に津波発生の可能性があります。'
    const FREE = '震源の近傍で、やや強い揺れを観測しました。'
    // 固定付加文・その他は無く、区分のコードも持たない形。
    const p2pQuake = (over: Partial<JMAQuake> = {}) => {
      const base = makeQuake()
      return makeQuake({
        forecastText: undefined, varCommentText: undefined,
        earthquake: { ...base.earthquake, domesticTsunami: 'なし', domesticTsunamiCode: undefined },
        foreignTsunamiText: FOREIGN,
        ...over,
      })
    }

    // 正: 固定付加文が無ければ、見通しの文を先頭の行に出す（津波の文なので見出しは「津波」）。
    it('固定付加文の位置に出す', async () => {
      await renderTab(p2pQuake({ freeText: FREE }))
      expect(notesLines()).toEqual([FOREIGN, FREE])
      expect(notesHeadings()).toEqual(['津波', '自由付加文'])
    })

    // 対照: 見通しが無ければ（None・Unknown・Checking）枠を出さない。
    it('見通しが無ければ枠を出さない', async () => {
      await renderTab(p2pQuake({ foreignTsunamiText: undefined }), { openNotes: false })
      expectNoNotes()
    })

    // 安全弁: 固定付加文の原文があれば原文を使い、見通しを重ねない（同じ文が二度出る）。
    // 原文から津波の区分の文を除いて空になっても、見通しへは倒さない。
    it('原文があれば見通しを重ねない', async () => {
      await renderTab(makeQuake({ foreignTsunamiText: FOREIGN }))
      expect(screen.queryByText(FOREIGN, { exact: false })).toBeNull()
      expect(notesLines()).toEqual([EEW_SENTENCE, VAR_COMMENT_TEXT])
    })
    it('原文が津波の区分の文だけでも見通しへ倒さない', async () => {
      await renderTab(makeQuake({ forecastText: TSUNAMI_SENTENCE, varCommentText: undefined, foreignTsunamiText: FOREIGN }), { openNotes: false })
      expect(screen.queryByText(FOREIGN, { exact: false })).toBeNull()
      expectNoNotes()
    })

    // 安全弁: 空白だけの原文・空の原文は無いものとして見通しを出す（読み上げと同じ扱い）。
    it.each([['空白だけ', '  '], ['空', '']])('%sの原文なら見通しを出す', async (_label, forecastText) => {
      await renderTab(p2pQuake({ forecastText, varCommentText: VAR_COMMENT_TEXT }))
      expect(notesLines()).toEqual([FOREIGN, VAR_COMMENT_TEXT])
    })
  })

  // 安全弁: 一覧の畳んだカードには出さない（選択中のカードだけ）。
  it('選んでいないカードには出さない', async () => {
    await renderTab(makeQuake(), { selected: false, openNotes: false })
    expect(screen.queryByText(EEW_SENTENCE)).toBeNull()
    expectNoNotes()
  })
})
