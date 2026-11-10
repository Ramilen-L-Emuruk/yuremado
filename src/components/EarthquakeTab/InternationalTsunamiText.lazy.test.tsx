// @vitest-environment jsdom
//
// 原文から始めた欄（特別な情報の帯の通信試験）は、「日本語訳」を押すまで訳の表を取らない。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent } from '@testing-library/react'
import type { JMAInternationalTsunami } from '../../types/earthquake'

const loadRegionNames = vi.fn(async () => ({}))
const loadStations = vi.fn(async () => [])
vi.mock('../../utils/wepa60RegionNames', async (orig) => ({
  ...(await orig<typeof import('../../utils/wepa60RegionNames')>()),
  getCachedWepa60RegionNames: () => null,
  loadWepa60RegionNames: () => loadRegionNames(),
}))
vi.mock('../../utils/tsunamiObsCoords', async (orig) => ({
  ...(await orig<typeof import('../../utils/tsunamiObsCoords')>()),
  loadTsunamiObsCoords: () => loadStations(),
}))

const { InternationalTsunamiText } = await import('./InternationalTsunamiText')

const report = {
  id: 'w1', title: 'NWPTA COMMUNICATIONS TEST', time: '2026-01-01T12:00:00Z', isCommunicationsTest: true,
  text: 'WEPA60 RJTD 011200\nNWPTA COMMUNICATIONS TEST\n\nTHIS IS A TEST MESSAGE.',
} as JMAInternationalTsunami

beforeEach(() => { loadRegionNames.mockClear(); loadStations.mockClear() })

describe('訳の表を取る時', () => {
  it('正: 原文から始めた欄は、開いただけでは表を取らない', () => {
    render(<InternationalTsunamiText report={report} startWithOriginal />)
    expect(screen.getByText(/THIS IS A TEST MESSAGE\./)).toBeTruthy()
    expect(loadRegionNames).not.toHaveBeenCalled()
    expect(loadStations).not.toHaveBeenCalled()
  })

  it('正: 「日本語訳」を押したら表を取る', async () => {
    render(<InternationalTsunamiText report={report} startWithOriginal />)
    await act(async () => { fireEvent.click(screen.getByText('日本語訳')) })
    expect(loadRegionNames).toHaveBeenCalledTimes(1)
    expect(loadStations).toHaveBeenCalledTimes(1)
  })

  it('対照: 日本語訳から始める欄（地震カード）は初めから表を取る', async () => {
    await act(async () => { render(<InternationalTsunamiText report={report} startWithOriginal={false} />) })
    expect(loadRegionNames).toHaveBeenCalledTimes(1)
  })
})
