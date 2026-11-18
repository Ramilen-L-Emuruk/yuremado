// @vitest-environment jsdom
//
// 発震機構の表の行を押して、3D に出す解を切り替える。素材は中継の本番から取った能登（2024-01-01）の答え。
// 言語の配り役で包まないので、辞書は既定の日本語になる。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import noto from '../../services/relayAnalysis.noto.fixture.json'
import { groupSolutionVersions, parseQuakeAnalysis, representativeGroup } from '../../services/relayAnalysis'
import { AgencyPanel, MechTable, chosenGroup } from './QuakeAnalysisAgency'

const a = parseQuakeAnalysis(noto)

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('min-width'), media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const selectedRows = (c: HTMLElement) => [...c.querySelectorAll('tr[aria-current="true"]')]

describe('chosenGroup', () => {
  const groups = groupSolutionVersions(a.solutions.filter(s => s.source === 'emsc'))

  it('選んだ鍵の解の組を返し、無い・見つからないときは代表の解に戻る', () => {
    const other = groups.find(g => g !== representativeGroup(groups))!
    expect(chosenGroup(groups, other.latest.key)).toBe(other)
    expect(chosenGroup(groups, null)).toBe(representativeGroup(groups))
    expect(chosenGroup(groups, 'ない鍵')).toBe(representativeGroup(groups))
  })
})

describe('MechTable の行の選択', () => {
  function Harness({ solutions }: { solutions: typeof a.solutions }) {
    const [key, setKey] = useState<string | null>(null)
    return <MechTable a={a} solutions={solutions} withSource={false} selectedKey={key} onSelect={setKey} />
  }
  const emsc = a.solutions.filter(s => s.source === 'emsc')

  it('行を押すと、その行だけが選んだ印になる', () => {
    const { container } = render(<Harness solutions={emsc} />)
    expect(selectedRows(container)).toHaveLength(0)
    const rows = [...container.querySelectorAll<HTMLElement>('tbody tr[tabindex="0"]')]
    expect(rows.length).toBeGreaterThan(1)
    fireEvent.click(rows[1])
    expect(selectedRows(container)).toEqual([rows[1]])
    fireEvent.click(rows[0])
    expect(selectedRows(container)).toEqual([rows[0]])
  })

  it('ホバーの色は、解の行とモーメントテンソルの行の 2 行にそろって付き、外すと消える（正と対照）', () => {
    const { container } = render(<Harness solutions={emsc} />)
    const rows = [...container.querySelectorAll<HTMLElement>('tbody tr')]
    const first = rows[0], tensor = rows[1], second = rows[2]
    const hoverBg = (r: HTMLElement) => r.className.includes('bg-[#222d3a]')
    expect(hoverBg(first)).toBe(false)
    fireEvent.mouseEnter(first)
    expect(hoverBg(first)).toBe(true)
    expect(hoverBg(tensor)).toBe(true)
    // [対照] 隣の解の行には付かない
    expect(hoverBg(second)).toBe(false)
    // テンソルの行へ移っても、同じ解の 2 行は付いたまま
    fireEvent.mouseLeave(first)
    fireEvent.mouseEnter(tensor)
    expect(hoverBg(first)).toBe(true)
    expect(hoverBg(tensor)).toBe(true)
    fireEvent.mouseLeave(tensor)
    expect(hoverBg(first)).toBe(false)
    expect(hoverBg(tensor)).toBe(false)
  })

  it('選んだ行は、ホバーより選んだ色を優先し、2 行そろって選んだ色になる（安全弁）', () => {
    const { container } = render(<Harness solutions={emsc} />)
    const rows = [...container.querySelectorAll<HTMLElement>('tbody tr')]
    fireEvent.click(rows[0])
    fireEvent.mouseEnter(rows[0])
    expect(rows[0].className).toContain('bg-[#24303d]')
    expect(rows[1].className).toContain('bg-[#24303d]')
    expect(rows[0].className).not.toContain('bg-[#222d3a]')
  })

  it('キーボードでは Enter と Space で選べ、ほかのキーでは選ばない（対照）', () => {
    const { container } = render(<Harness solutions={emsc} />)
    const rows = [...container.querySelectorAll<HTMLElement>('tbody tr[tabindex="0"]')]
    fireEvent.keyDown(rows[1], { key: 'a' })
    expect(selectedRows(container)).toHaveLength(0)
    fireEvent.keyDown(rows[1], { key: 'Enter' })
    expect(selectedRows(container)).toEqual([rows[1]])
    fireEvent.keyDown(rows[0], { key: ' ' })
    expect(selectedRows(container)).toEqual([rows[0]])
  })

  it('節面の無い解の行は選べない（3D に出せないので押しても何も起きない。安全弁）', () => {
    const noPlane = emsc.map((s, i) => (i === 0 ? { ...s, planes: null } : s))
    const { container } = render(<Harness solutions={noPlane} />)
    const selectable = container.querySelectorAll('tbody tr[tabindex="0"]').length
    const withPlanes = groupSolutionVersions(noPlane).filter(g => g.latest.planes !== null).length
    expect(selectable).toBe(withPlanes)
    expect(withPlanes).toBeLessThan(groupSolutionVersions(noPlane).length)
  })
})

describe('AgencyPanel の機関の切り替え', () => {
  it('機関ごとに選択が分かれる（key を機関にすると、戻った機関は代表の解から始まる）', () => {
    function Tabs() {
      const [src, setSrc] = useState<'emsc' | 'usgs'>('emsc')
      return (
        <>
          <button type="button" onClick={() => setSrc(s => (s === 'emsc' ? 'usgs' : 'emsc'))}>切り替え</button>
          <AgencyPanel key={src} a={a} source={src}><span /></AgencyPanel>
        </>
      )
    }
    const { container } = render(<Tabs />)
    const rows = () => [...container.querySelectorAll<HTMLElement>('tbody tr[tabindex="0"]')]
    const initial = rows().findIndex(r => r.getAttribute('aria-current') === 'true')
    const other = rows().findIndex((_, i) => i !== initial)
    fireEvent.click(rows()[other])
    expect(rows().findIndex(r => r.getAttribute('aria-current') === 'true')).toBe(other)
    fireEvent.click(screen.getByText('切り替え'))
    fireEvent.click(screen.getByText('切り替え'))
    expect(rows().findIndex(r => r.getAttribute('aria-current') === 'true')).toBe(initial)
  })
})

describe('AgencyPanel', () => {
  it('3D は選んだ行の解で出し、行を押すと切り替わる（見出しは 1 つのまま）', () => {
    const { container } = render(<AgencyPanel a={a} source="emsc"><span /></AgencyPanel>)
    expect(screen.getAllByText('震源球と断層のずれ')).toHaveLength(1)
    // 初めは代表の解の行が選んだ印になっている
    expect(selectedRows(container)).toHaveLength(1)
    const rows = [...container.querySelectorAll<HTMLElement>('tbody tr[tabindex="0"]')]
    const next = rows.find(r => r.getAttribute('aria-current') !== 'true')!
    fireEvent.click(next)
    expect(selectedRows(container)).toEqual([next])
    expect(screen.getAllByText('震源球と断層のずれ')).toHaveLength(1)
  })
})
