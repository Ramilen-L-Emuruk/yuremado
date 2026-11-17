// @vitest-environment jsdom
//
// 解析の窓の発震機構の表を描く。素材は中継の本番から取った能登（2024-01-01）の答え。
// 幅のある画面は表、狭い画面は 1 解 2 行の並びを、片方だけ組む（`matchMedia` を差し替えて両方を見る）。
// 言語の配り役で包まないので、辞書は既定の日本語になる。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import noto from '../../services/relayAnalysis.noto.fixture.json'
import { parseQuakeAnalysis } from '../../services/relayAnalysis'
import { AgencyPanel, MechTable } from './QuakeAnalysisAgency'

const a = parseQuakeAnalysis(noto)

/** 幅の問い合わせへの答えを決める（`useMediaQuery` は描く時点で読む） */
function setWide(wide: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: wide, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }))
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('MechTable', () => {
  it('幅のある画面は表だけを組み、値の無い列は出さない（EMSC には深さ・届いた時刻があり、観測点は無い）', () => {
    setWide(true)
    const { container } = render(<MechTable a={a} solutions={a.solutions.filter(s => s.source === 'emsc')} withSource={false} />)
    expect(container.querySelectorAll('table')).toHaveLength(1)
    const heads = [...container.querySelectorAll('th')].map(th => th.textContent)
    expect(heads[0]).toBe('機関')
    expect(heads).toContain('深さ')
    expect(heads).toContain('届いた時刻')
    // [対照] どの EMSC の解にも観測点数は無いので、その列は出さない
    expect(heads).not.toContain('観測点')
    // 6 機関 → 解の行 6 つと、その下のテンソルの行 6 つ
    expect(container.querySelectorAll('tbody tr')).toHaveLength(12)
  })

  it('機関ごとのタブは、隣のタブに同じ値の解がある NEIC・GFZ にだけ「同じ」と添える', () => {
    setWide(true)
    render(<MechTable a={a} solutions={a.solutions.filter(s => s.source === 'emsc')} withSource={false} />)
    expect(screen.getAllByText('USGS のタブの解と同じ')).toHaveLength(1)
    expect(screen.getAllByText('GEOFON のタブの解と同じ')).toHaveLength(1)
  })

  it('[対照] 種類ごとの表（全機関が 1 つの表に並ぶ）では「同じ」と添えない', () => {
    setWide(true)
    render(<MechTable a={a} solutions={a.solutions} withSource />)
    expect(screen.queryByText(/のタブの解と同じ/)).toBeNull()
  })

  it('狭い画面は並びだけを組み、注記は値と同じ「・」でつなぐ', () => {
    setWide(false)
    const { container } = render(<MechTable a={a} solutions={a.solutions.filter(s => s.source === 'emsc')} withSource={false} />)
    expect(container.querySelectorAll('table')).toHaveLength(0)
    const note = screen.getByText('USGS のタブの解と同じ')
    // 直前に区切りの「・」がある（値の並びの続きとして出る。行の頭に「・」だけが浮かない）
    expect(note.previousElementSibling?.textContent).toBe('・')
    expect(note.parentElement?.firstElementChild?.textContent).not.toBe('・')
  })

  it('見直しの段階は値のある取得元だけ列に出し、テンソルの 6 成分は行の下に添える', () => {
    setWide(true)
    const { container } = render(<MechTable a={a} solutions={a.solutions.filter(s => s.source === 'geofon')} withSource={false} />)
    const heads = [...container.querySelectorAll('th')].map(th => th.textContent)
    expect(heads).toContain('見直し')
    expect(screen.getByText('手で見直した')).toBeTruthy()
    // テンソルは列ではなく、表の幅の行（見出しには出ない）
    expect(heads).not.toContain('モーメントテンソル')
    expect(screen.getByText(/^モーメントテンソル Mrr 1\.84 Mtt −0\.74 Mff −1\.10 Mrt 0\.33 Mrf −0\.68 Mtf −0\.94 \(×10²⁰ N·m\)$/)).toBeTruthy()
    // [対照] EMSC の解は見直しの段階を持たないので、その列は出さない
    cleanup()
    const emsc = render(<MechTable a={a} solutions={a.solutions.filter(s => s.source === 'emsc')} withSource={false} />)
    expect([...emsc.container.querySelectorAll('th')].map(th => th.textContent)).not.toContain('見直し')
  })

  it('前の版は「ほか N 版」を押したときだけ組む', () => {
    setWide(true)
    const { container } = render(<MechTable a={a} solutions={a.solutions.filter(s => s.source === 'usgs')} withSource={false} />)
    // 最新の版の行とテンソルの行
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2)
    const more = screen.getByRole('button', { name: /ほか 5 版/ })
    expect(more.getAttribute('aria-expanded')).toBe('false')
    act(() => { fireEvent.click(more) })
    // 前の 5 版が、それぞれの行とテンソルの行の 2 行ずつ足される（前の版のテンソルも落とさない）
    expect(container.querySelectorAll('tbody tr')).toHaveLength(12)
    expect(more.getAttribute('aria-expanded')).toBe('true')
  })
})

describe('AgencyPanel の震源の深さ', () => {
  const withDepthType = (depthType: string | null) => {
    const c = structuredClone(a)
    c.sources.geofon = { ...c.sources.geofon, event: { ...c.sources.geofon.event!, depthType } }
    return c
  }

  it('深さの決め方を語で添え、名前の無い決め方は取得元の値のまま添える', () => {
    setWide(true)
    render(<AgencyPanel a={withDepthType('from location')} source="geofon">{null}</AgencyPanel>)
    expect(screen.getByText('（震源と一緒に求めた値）', { exact: false })).toBeTruthy()
    cleanup()
    render(<AgencyPanel a={withDepthType('from modeling')} source="geofon">{null}</AgencyPanel>)
    expect(screen.getByText('(from modeling)', { exact: false })).toBeTruthy()
    // [正] 能登の素材のまま（operator assigned）は担当者が置いた値の札
    cleanup()
    render(<AgencyPanel a={a} source="geofon">{null}</AgencyPanel>)
    expect(screen.getByText('（担当者が置いた値）')).toBeTruthy()
    // [対照] 決め方が無ければ何も添えない
    cleanup()
    render(<AgencyPanel a={withDepthType(null)} source="geofon">{null}</AgencyPanel>)
    expect(screen.queryByText(/求めた値|置いた値|\(from /)).toBeNull()
  })
})
