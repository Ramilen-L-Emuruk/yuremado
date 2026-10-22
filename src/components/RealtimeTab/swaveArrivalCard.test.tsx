// @vitest-environment jsdom
//
// 主要動の到達カード（`SWaveArrivalCard`）で、ホーム地点の区域に気象庁の到達予測時刻が出ていない地震を
// 距離だけの行として見せる形を固定する（2026-10-14 ユーザー承認「距離だけのカードを出す」、
// 行の中での見せ方は 2026-10-19 ユーザー承認「行として最後に並べる (推奨)」）。
//
// - 1 件だけ: 見出し「震源から N km」・区域名・本文。注記は出さない
// - 予測のある地震と並ぶ: 見出しは今までどおり、予測の無い行に本文を添える。注記は出す
// - どの行にも予測が無い: 見出し「主要動の到達予測なし」・灰色の枠・注記は出さない
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RealtimeTab } from './index'
import type { SWaveArrival, SWaveArrivalRow } from '../../hooks/useSWaveCountdown'

const BODY = 'ホーム地点の地域には、気象庁の到達予測時刻が出ていません'
const NOTE = '※気象庁が発表した地域ごとの到達予測時刻です。同じ地域の中でも場所によって異なります'

function row(over: Partial<SWaveArrivalRow> & { key: string }): SWaveArrivalRow {
  return {
    source: 'telegram',
    hypocenterName: null,
    provisional: false,
    distanceKm: null,
    etaSec: null,
    arrived: false,
    noForecast: false,
    ...over,
  }
}

const noForecastRow = (key: string, name: string, km: number) =>
  row({ key, hypocenterName: name, distanceKm: km, noForecast: true })

function renderCard(rows: SWaveArrivalRow[], source: SWaveArrival['source'] = 'telegram') {
  const arrival: SWaveArrival = { source, areaName: source === 'own' ? null : '石川県能登', rows }
  return render(
    <RealtimeTab eewNoForecastSettledKeys={new Set()} eews={[]} swaveArrival={arrival} kyoshinV2Detections={[]} kyoshinDetectedPoints={[]} visible />,
  )
}

/** 見出しの文字を持つ要素から、カードの枠（border の色を持つ要素）を引く。 */
const cardOf = (heading: string) => screen.getByText(heading).closest('div.border-2') as HTMLElement

describe('主要動の到達カード: 到達予測の出ていない地震', () => {
  it('1 件だけなら見出しを距離にし、本文を出して注記は出さない', () => {
    renderCard([noForecastRow('a', '佐渡付近', 120.4)])
    expect(screen.getByText('震源から 120 km')).toBeTruthy()
    expect(screen.getByText('石川県能登')).toBeTruthy()
    expect(screen.getByText(BODY)).toBeTruthy()
    expect(screen.queryByText(NOTE)).toBeNull()
    expect(screen.queryByText('主要動 到達カウントダウン')).toBeNull()
    // 予測を出していないので、秒読みの橙ではなく灰色の枠
    expect(cardOf('震源から 120 km').style.borderColor).toBe('rgb(107, 114, 128)')
  })

  it('予測のある地震と並ぶときは、予測の無い行にだけ本文を添え、注記は出す', () => {
    renderCard([
      row({ key: 'near', hypocenterName: '能登半島沖', distanceKm: 40, etaSec: 23 }),
      noForecastRow('far', '佐渡付近', 150),
    ])
    expect(screen.getByText('主要動 到達カウントダウン')).toBeTruthy()
    expect(screen.getByText('23')).toBeTruthy()
    expect(screen.getByText('佐渡付近')).toBeTruthy()
    expect(screen.getByText('震源から 150 km')).toBeTruthy()
    expect(screen.getAllByText(BODY)).toHaveLength(1)
    expect(screen.getByText(NOTE)).toBeTruthy()
  })

  it('どの行にも予測が無ければ見出しを「主要動の到達予測なし」にし、灰色の枠で注記は出さない', () => {
    renderCard([noForecastRow('a', '能登半島沖', 40), noForecastRow('b', '佐渡付近', 150)])
    expect(screen.getByText('主要動の到達予測なし')).toBeTruthy()
    expect(screen.getAllByText(BODY)).toHaveLength(2)
    expect(screen.queryByText(NOTE)).toBeNull()
    expect(cardOf('主要動の到達予測なし').style.borderColor).toBe('rgb(107, 114, 128)')
  })

  // 対照: 予測のある 1 件だけなら今までの見た目のまま（見出し・距離・注記）。
  it('予測のある 1 件だけなら今までどおり', () => {
    renderCard([row({ key: 'near', hypocenterName: '能登半島沖', distanceKm: 40, etaSec: 23 })])
    expect(screen.getByText('主要動 到達カウントダウン')).toBeTruthy()
    expect(screen.getByText('震源から 40 km')).toBeTruthy()
    expect(screen.getByText(NOTE)).toBeTruthy()
    expect(screen.queryByText(BODY)).toBeNull()
  })
})

// 到達予想キーの端末で、自前計算の行と発表値の行が混ざった枠（2026-10-22 ユーザー承認「行ごとに範囲を出す (Recommended)」）
describe('主要動の到達カード: 自前計算の行と発表値の行が混ざったとき', () => {
  const OWN_NOTE = '※推定値。実際の到達時間は異なる場合があります'

  it('行ごとに範囲を出し、注記は 2 つとも出す', () => {
    renderCard([
      row({ key: 'near', source: 'own', hypocenterName: '能登半島沖', distanceKm: 40, etaSec: 10 }),
      row({ key: 'other', source: 'telegram', hypocenterName: '石川県能登地方', distanceKm: 20, etaSec: 23 }),
    ], 'mixed')
    expect(screen.getByText('ホーム地点')).toBeTruthy()
    expect(screen.getByText('石川県能登')).toBeTruthy()
    expect(screen.getByText(NOTE)).toBeTruthy()
    expect(screen.getByText(OWN_NOTE)).toBeTruthy()
  })

  it('気象庁の値の行が距離だけなら、気象庁の注記は出さず推定値の注記だけ出す', () => {
    renderCard([
      row({ key: 'near', source: 'own', hypocenterName: '能登半島沖', distanceKm: 40, etaSec: 10 }),
      row({ key: 'far', source: 'telegram', hypocenterName: '佐渡付近', distanceKm: 150, noForecast: true }),
    ], 'mixed')
    expect(screen.getByText(OWN_NOTE)).toBeTruthy()
    expect(screen.queryByText(NOTE)).toBeNull()
    expect(screen.getByText(BODY)).toBeTruthy()
  })

  it('対照: 自前計算の行だけなら範囲は 1 回・注記は推定値の 1 つだけ', () => {
    renderCard([
      row({ key: 'near', source: 'own', hypocenterName: '能登半島沖', distanceKm: 40, etaSec: 10 }),
      row({ key: 'far', source: 'own', hypocenterName: '佐渡付近', distanceKm: 150, etaSec: 30 }),
    ], 'own')
    expect(screen.getAllByText('ホーム地点')).toHaveLength(1)
    expect(screen.getByText(OWN_NOTE)).toBeTruthy()
    expect(screen.queryByText(NOTE)).toBeNull()
  })
})
