// @vitest-environment jsdom
//
// 種別ヘッダーに添える報番号の見た目（→ `components/SerialBadge.tsx`）。
//
// **緊急地震速報と地震情報カードで揃っていることを守る。** 揃える理由は部品側に書いてある。
//
// 見た目は描いてみないと確かめられないので、クラス名の一致ではなく**両方をレンダーして
// 突き合わせる**。文字列で書き写すと、写した側だけが古くなる。
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { flushDataEffects } from '../test-utils/flushDataEffects'
import { RealtimeTab } from './RealtimeTab'
import { EarthquakeTab } from './EarthquakeTab'
import { quakeEventKey } from '../utils/quakeMerge'
import type { EEWAlert, JMAQuake, QuakeReportRecord } from '../types/earthquake'
import { createEmptyTelegramLoss } from '../utils/telegramLoss'

afterEach(cleanup)

// jsdom は `scrollIntoView` を持たない（寄せる動きはこのテストの対象ではない）。
HTMLElement.prototype.scrollIntoView = () => {}

function makeEEW(serial: string): EEWAlert {
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
      hypocenter: { name: '茨城県沖', latitude: 36.2, longitude: 141.0, depth: 30, magnitude: 6.5 },
    },
    severity: 'Warning',
    cancelled: false,
    issue: { serial },
  }
}

function makeQuake(reports: QuakeReportRecord[]): JMAQuake {
  return {
    kind: 'quake',
    id: 'dmdata-quake-20240101160610-1',
    eventId: '20240101160610',
    time: '2024-01-01T07:10:00Z',
    issue: { source: 'テスト', time: '2024-01-01T07:10:00Z', type: '震度速報', correct: 'なし' },
    earthquake: {
      time: '2024-01-01T07:06:00Z',
      hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.3, depth: 16, magnitude: 7.6 },
      maxScale: 70,
      domesticTsunami: '警報等',
    },
    points: [{ pref: '石川県', addr: '石川県能登', isArea: true, scale: 70 }],
    reports,
  }
}

const renderEEW = async (eew: EEWAlert) => {
  const { container } = render(
    <RealtimeTab eewNoForecastSettledKeys={new Set()} eews={[eew]} swaveArrival={null} kyoshinV2Detections={[]} kyoshinDetectedPoints={[]} visible />,
  )
  await flushDataEffects()
  return container
}

const renderQuake = async (quake: JMAQuake, selected = true) => {
  const { container } = render(
    <EarthquakeTab
      earthquakes={[quake]}
      selectedId={selected ? quakeEventKey(quake) : 'other'}
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
    />,
  )
  await flushDataEffects()
  return container
}

/**
 * 緊急地震速報の見出しの段（`緊急地震速報（警報）` と報番号を並べる行）。種別名の要素から 1 つ上の行を取る ——
 * 見た目のクラスを目印にすると、見出しの体裁を変えるたびにこのテストが黙って null を掴む。
 */
const header = (container: HTMLElement) =>
  ([...container.querySelectorAll('b')].find(el => el.textContent?.startsWith('緊急地震速報'))?.parentElement ?? null) as HTMLElement

/** 開いた地震情報カードの見出し（`震度速報 #2 / 震源情報` を出す、押すと畳むボタン）。 */
const quakeHeading = (container: HTMLElement) => container.querySelector('button[aria-expanded="true"]') as HTMLElement

/**
 * ヘッダーの中の報番号だけを取り出す。
 *
 * **地の文から切り出さない。** 番号が種別名と別の要素になっていること自体が守りたい形なので、
 * 要素として引けるかどうかで判定する。
 */
const serialEl = (host: HTMLElement) =>
  [...host.querySelectorAll('span')].find(el => el.textContent?.trim().startsWith('#')) ?? null

/** 2 通受け取った震度速報と、1 通だけの震源情報。 */
const TWO_AND_ONE: QuakeReportRecord[] = [
  { type: '震度速報', keys: ['2024-01-01T07:07:40Z', '2024-01-01T07:12:00Z'] },
  { type: '震源情報', keys: ['2024-01-01T07:10:30Z'] },
]

describe('報番号の見た目', () => {
  // 正: 緊急地震速報の報番号が、種別名とは別の要素として出る。
  it('緊急地震速報では報番号が別の要素で出る', async () => {
    const head = header(await renderEEW(makeEEW('1')))
    expect(head.textContent).toContain('緊急地震速報（警報）')
    const badge = serialEl(head)
    expect(badge).not.toBeNull()
    expect(badge!.textContent).toBe('#1')
  })

  // 正: 地震情報カードでも同じ形で出る。**種別名へ直付けしない。**
  it('地震情報カードでも報番号が別の要素で出る', async () => {
    const head = quakeHeading(await renderQuake(makeQuake(TWO_AND_ONE)))
    expect(head.textContent).toContain('震度速報')
    expect(head.textContent).toContain('震源情報')
    const badge = serialEl(head)
    expect(badge).not.toBeNull()
    expect(badge!.textContent).toBe('#2')
    // 種別名は器の外。`震度速報#2` のように 1 つの要素へ畳まれていたら落ちる。
    expect(badge!.textContent).not.toContain('震度速報')
  })

  // **安全弁: 報番号の器が同じ見た目であること。** 片方だけ書き換えたらここで止まる。
  // 見出しそのものの体裁は揃えない —— 地震情報カードは一覧の行と同じ見出し行に種別を書く。
  it('緊急地震速報と地震情報カードで報番号のクラスが一致する', async () => {
    const eewClass = serialEl(header(await renderEEW(makeEEW('1'))))!.className
    cleanup()
    const quakeHead = quakeHeading(await renderQuake(makeQuake(TWO_AND_ONE)))
    expect(serialEl(quakeHead)!.className).toBe(eewClass)
  })

  // 対照: 1 通しか受け取っていない種別には番号を付けない。
  it('1 通だけの種別には報番号を出さない', async () => {
    const head = quakeHeading(await renderQuake(makeQuake([{ type: '震源情報', keys: ['2024-01-01T07:10:30Z'] }])))
    expect(head.textContent).toContain('震源情報')
    expect(serialEl(head)).toBeNull()
  })

  // 正: 畳んだカードの種別バッジでも同じ形で出す（開いた表示と語を揃える）。
  it('畳んだカードでも報番号が別の要素で出る', async () => {
    const container = await renderQuake(makeQuake(TWO_AND_ONE), false)
    const badge = serialEl(container)
    expect(badge).not.toBeNull()
    expect(badge!.textContent).toBe('#2')
  })
})
