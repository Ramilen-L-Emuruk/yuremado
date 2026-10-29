// @vitest-environment jsdom
//
// EEW カードの固定付加文（電文の `Comments/WarningComment/Text`。実電文では
// 「強い揺れに警戒してください。」の 1 種類だけ）。
//
// **置き場所そのものが要件。** 電文が言う唯一の行動指示なので、カードの末尾に置くと
// 区域一覧や到達予測の下に埋もれる（→ docs/spec/eew-spec.md §3「固定付加文」）。
// 予想値のバナー群の直後に出ていることを DOM の並びで固定する。
//
// **取消の判定は `cancelledAt`。** `cancelled` は受け取った電文が取消報かを表すフラグで、
// 画面が持つ EEW には伝わらない（状態更新は `{ ...表示中の EEW, cancelledAt }` の形で当てる）。
// `!eew.cancelled` と書いていた版があり、常に真で素通りしていた。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { RealtimeTab } from './index'
import type { EEWAlert } from '../../types/earthquake'

afterEach(cleanup)

const COMMENT = '強い揺れに警戒してください。'

function makeEEW(over: Partial<EEWAlert> = {}): EEWAlert {
  return {
    kind: 'eew',
    origin: 'dmdata',
    id: 'test-eew',
    time: '2026-01-01T12:00:00Z',
    test: false,
    earthquake: {
      originTime: '2026-01-01T12:00:00Z',
      arrivalTime: '2026-01-01T12:00:20Z',
      condition: '',
      hypocenter: { name: '日向灘', latitude: 32.0, longitude: 132.0, depth: 30, magnitude: 6.5 },
    },
    severity: 'Warning',
    cancelled: false,
    forecastMaxScale: 50,
    warningComment: COMMENT,
    ...over,
  }
}

const renderTab = (eew: EEWAlert) =>
  render(
    <RealtimeTab eewNoForecastSettledKeys={new Set()} eews={[eew]} swaveArrival={null} kyoshinV2Detections={[]} kyoshinDetectedPoints={[]} visible />,
  )

/** a が b より前に出ているか。 */
function precedes(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

describe('EEW カードの固定付加文', () => {
  // 正: 警報級の報で付加文が出る。
  it('付加文を持つ報では原文をそのまま出す', () => {
    renderTab(makeEEW())
    expect(screen.getByText(COMMENT)).toBeTruthy()
  })

  // 安全弁: 位置が予想値のバナー群の直後であること（末尾へ戻していないこと）。
  it('予想最大震度より後・発生時刻より前に置く', () => {
    renderTab(makeEEW())
    const comment = screen.getByText(COMMENT)
    const maxScaleLabel = screen.getByText('予想最大震度')
    const originTime = screen.getByText(/^地震発生時刻 /)
    expect(precedes(maxScaleLabel, comment)).toBe(true)
    expect(precedes(comment, originTime)).toBe(true)
  })

  // 対照: 付加文を持たない報（実電文では予報級）では何も足さない。
  it('付加文が無ければ出さない', () => {
    renderTab(makeEEW({ warningComment: undefined }))
    expect(screen.queryByText(COMMENT)).toBeNull()
  })

  // 安全弁: 取消の印は `cancelledAt`。判定を `cancelled` へ戻すとこのテストが落ちる ——
  // 画面が持つ EEW の `cancelled` は取消後も false のままなので、付加文が出てしまう。
  it('取消（cancelledAt）では出さない', () => {
    renderTab(makeEEW({ cancelledAt: new Date('2026-01-01T12:01:00Z') }))
    expect(screen.queryByText(COMMENT)).toBeNull()
  })
})

// 新たに警報の対象に加わった地方（電文の 2 つ目の `Item`）だけを、他の欄と同じ減衰で一瞬光らせる
// （2026-10-22 ユーザー承認「一瞬色を付ける」。→ docs/spec/eew-spec.md §3「警報の対象地方」）。
describe('EEW カードの新たに加わった警報の地方', () => {
  const rerenderTab = (r: ReturnType<typeof renderTab>, eew: EEWAlert) =>
    r.rerender(
      <RealtimeTab eewNoForecastSettledKeys={new Set()} eews={[eew]} swaveArrival={null} kyoshinV2Detections={[]} kyoshinDetectedPoints={[]} visible />,
    )
  const regionSpan = (name: string) => {
    return screen.getByText((_, node) => node?.tagName === 'SPAN' && node.textContent === name) as HTMLElement
  }

  // 正: 続報で加わった地方にだけ「上がった」の色を当てる
  it('続報で加わった地方にだけ色を付ける', () => {
    const r = renderTab(makeEEW({ warningRegions: ['北陸'] }))
    // id は変えない —— 色付けは同じ地震の続報どうしで比べる（id が変われば別の地震として初出に戻る）
    rerenderTab(r, makeEEW({ warningRegions: ['北陸', '甲信', '関東'], addedWarningRegions: ['甲信', '関東'] }))
    for (const name of ['甲信', '関東']) {
      expect(regionSpan(name).className).toContain('update-fade-text')
      expect(regionSpan(name).style.getPropertyValue('--update-mark-color')).toBe('#f87171')
    }
    // 対照: 前から警報だった地方は色を付けない（span で包まない）
    expect(screen.queryAllByText((_, node) => node?.tagName === 'SPAN' && node.textContent === '北陸')).toHaveLength(0)
    expect(r.container.textContent).toContain('関東・北陸・甲信')  // 並びは読み上げと同じ標準順
  })

  // 対照: 初めて見た報は、加わった地方を持っていても光らせない（欄の初出は動いたことにしない）
  it('初めて見た報では光らせない', () => {
    renderTab(makeEEW({ warningRegions: ['北陸', '甲信'], addedWarningRegions: ['甲信'] }))
    expect(regionSpan('甲信').className).not.toContain('update-fade')
  })
})
