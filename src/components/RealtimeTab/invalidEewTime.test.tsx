// @vitest-environment jsdom
//
// 緊急地震速報カードの時刻が、日時として読めない値のときに何を出すか。
//
// `formatDateTime` は読めない値で `null` を返す（→ `utils/formatters.ts` の `readDateTime`）。
// **JSX へ素で埋めると `null` は何も描画されず、見出しだけが残る** —— 発生時刻なら「地震発生時刻」。
// 型検査は通ってしまうので、DOM で固定する。
//
// **落とし先を欄ごとに変えている。** 発生時刻・発現時刻は行ごと落とし（見出しだけ残さない）、
// 区域の到達予測は語（「不明」）を出す（区域名だけが並ぶと値を読み落としたように見える）。
// 後者を担うのは `arrivalEtaSec`（残り秒数を出す側）で、そちらは電文を経由しない経路
// （テストデータ・履歴アーカイブ）のために独自にガードを持つ。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { RealtimeTab } from './index'
import type { EEWAlert, EEWRegion } from '../../types/earthquake'

afterEach(cleanup)

/** 到達予測時刻を持つ区域（種別コードは PLUM 法でない予報級）。 */
const forecastArea = (name: string, arrivalTime: string | null): EEWRegion => ({
  pref: '宮崎県', name, scaleFrom: 40, scaleTo: 40, kindCode: '00', arrivalTime,
})

function makeEEW(originTime: string, areas: EEWRegion[], arrivalTime = '2026-01-01T12:00:20Z'): EEWAlert {
  return {
    kind: 'eew',
    origin: 'dmdata',
    id: 'test-eew',
    time: '2026-01-01T12:00:00Z',
    test: false,
    earthquake: {
      originTime,
      arrivalTime,
      condition: '',
      hypocenter: { name: '日向灘', latitude: 32.0, longitude: 132.0, depth: 30, magnitude: 6.5 },
    },
    severity: 'Warning',
    cancelled: false,
    forecastMaxScale: 50,
    areas,
  }
}

const renderTab = (eew: EEWAlert) =>
  render(
    <RealtimeTab eewNoForecastSettledKeys={new Set()} eews={[eew]} swaveArrival={null} kyoshinV2Detections={[]} kyoshinDetectedPoints={[]} kyoshinDemoted={[]} visible />,
  )

describe('緊急地震速報カードの時刻が読めないとき', () => {
  // 対照: 読める値では 2 行とも気象庁の名前を見出しにして出し、到達予測も「不明」にならない。
  it('読める値では従来どおり出す', () => {
    const { container } = renderTab(makeEEW('2026-01-01T12:00:00Z', [forecastArea('宮崎県南部平野部', '2026-01-01T12:00:40Z')]))
    expect(container.textContent).toMatch(/地震発生時刻 2026\/01\/01 \d{2}:\d{2}:00/)
    expect(container.textContent).toMatch(/地震発現時刻 2026\/01\/01 \d{2}:\d{2}:20/)
    expect(container.textContent).not.toContain('ごろ')
    // 発現時刻の見出しにだけ意味の吹き出しを添える（2026-10-22 ユーザー承認「ホバーで説明を出す」）。
    // 吹き出しは開くまで描かれない。押して（タップと同じ）中身を確かめる。
    fireEvent.click(screen.getByRole('button', { name: '地震発現時刻' }))
    expect(screen.getByRole('tooltip').textContent).toBe('観測点が地震を検知した時刻')
    // 対照: 発生時刻の見出しには添えない
    expect(screen.queryByRole('button', { name: '地震発生時刻' })).toBeNull()
    // 到達予測は残り秒数で出る（→ docs/spec/eew-spec.md §4）。**実際の秒数は今の時刻に
    // 依存する**ので値では固定せず、「不明」へ落ちていないことだけを見る。
    expect(screen.queryByText('不明')).toBeNull()
  })

  // 正: 発生時刻が読めなければその行ごと落とす。見出しだけが残らないこと。
  it('発生時刻が読めなければ見出しだけを残さない', () => {
    const { container } = renderTab(makeEEW('壊れた値', [forecastArea('宮崎県南部平野部', '2026-01-01T12:00:40Z')]))
    expect(container.textContent).not.toContain('地震発生時刻')
    // 対照: 発現時刻の行は道連れにならない。
    expect(container.textContent).toMatch(/地震発現時刻 2026\/01\/01/)
    expect(container.textContent).not.toContain('NaN')
    // 対照: 震源名など他の情報は残る（時刻が読めないことで欄が道連れにならない）。
    expect(screen.getByText('日向灘')).toBeTruthy()
  })

  // 正: 発現時刻を配信しない経路（標準版の Yahoo hypoInfo は空文字を入れる）では行を出さない。
  it('発現時刻が空なら行を出さない', () => {
    const { container } = renderTab(makeEEW('2026-01-01T12:00:00Z', [forecastArea('宮崎県南部平野部', '2026-01-01T12:00:40Z')], ''))
    expect(container.textContent).not.toContain('地震発現時刻')
    expect(container.textContent).toContain('地震発生時刻')
  })

  // 正: 区域の到達予測時刻が読めなければ語を出す。空欄にすると区域名だけが並び、
  // 値を読み落としたように見える。**「まもなく」に混ぜない** —— 差し迫っていることと、
  // 値が壊れていることは別の事実（`NaN > 0` は偽なので、素朴に書くと壊れた値が
  // 「もうすぐ来る」という確度の高い表示に化ける）。
  it('区域の到達予測時刻が読めなければ「不明」を出す', () => {
    renderTab(makeEEW('2026-01-01T12:00:00Z', [forecastArea('宮崎県南部平野部', '壊れた値')]))
    expect(screen.getByText('不明')).toBeTruthy()
    expect(screen.queryByText('まもなく')).toBeNull()
  })

  // 安全弁: `NaN` がそのまま画面へ出ない（これが元の症状）。
  it('NaN を画面に出さない', () => {
    const { container } = renderTab(makeEEW('壊れた値', [forecastArea('宮崎県南部平野部', '壊れた値')]))
    expect(container.textContent).not.toContain('NaN')
  })
})
