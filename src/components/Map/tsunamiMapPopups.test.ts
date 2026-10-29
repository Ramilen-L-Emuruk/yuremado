// @vitest-environment jsdom
//
// 津波タブの地図の吹き出し（2026-10-21 の棚卸し④・⑧の決定）を固定する。
//   - 観測棒・到達確認・欠測の吹き出しの中身（最大波の観測時刻・第1波の形を揃える）
//   - 押して開いたままにする・もう一度か別の場所で閉じる・1 枚だけ出す・行から開く
//   - 海岸線の吹き出しの予想波高と到達予想
//   - 津波の原因地震の震源の×印（置ける震源・吹き出し）
import { describe, it, expect, vi } from 'vitest'
import { obsBarTooltipHtml } from './TsunamiObsBarsGL'
import { arrivalTooltipHtml } from './TsunamiArrivalMarkersGL'
import { missingTooltipHtml } from './TsunamiMissingMarkersGL'
import { tsunamiLinePopupHtml } from './TsunamiLinesGL'
import { buildSourcePoints, sourcePopupHtml } from './TsunamiSourceEpicentersGL'
import { attachTsunamiMarkerPopup, openTsunamiMarkerPopup, closeTsunamiMarkerPopups } from './gl/tsunamiMarkerPopup'
import { observationFirstWaveText, tsunamiAreaPopupLines } from '../../utils/tsunami'
import type { TsunamiArea } from '../../types/earthquake'

vi.mock('./gl/popupRegistry', () => ({ closeMapPopup: vi.fn() }))

// 時刻は `formatTimeMin` がローカル時刻で組むため、オフセットを書かない表記を使う（CI は TZ=UTC）。
describe('第1波の語（3 つの吹き出しで共有）', () => {
  it('正: 時刻と押し引きを「第1波 05:12 押し波」の形にする', () => {
    expect(observationFirstWaveText({ arrivalTime: '2026-04-20T05:12:00', initial: '押し' })).toBe('第1波 05:12 押し波')
  })
  it('正: 時刻が無く電文が「第１波識別不能」と言っていれば「第1波 到達時刻不明」', () => {
    expect(observationFirstWaveText({ condition: { firstWaveUnidentifiable: true } })).toBe('第1波 到達時刻不明')
  })
  it('対照: 伝えるものが無ければ空', () => {
    expect(observationFirstWaveText({ arrivalTime: 'こわれた値' })).toBe('')
  })
})

describe('観測点の印の吹き出しの中身', () => {
  const base = { name: '輪島港', lat: 37.4, lng: 136.9, barPx: 40, color: '#ff0000', blinking: false }
  // 正（2026-10-21 ユーザー選択「時刻と第1波も出す (Recommended)」・形は 2026-10-24 ユーザー選択「この形で揃える」）
  it('正: 観測棒の吹き出しに最大波の観測時刻と第1波を出す', () => {
    const html = obsBarTooltipHtml({ ...base, height: { value: 1.2, description: '1.2m' }, maxHeightDateTime: '2026-04-20T05:40:00', arrivalTime: '2026-04-20T05:12:00', initial: '押し' })
    expect(html).toContain('1.2m')
    expect(html).toContain('最大波 05:40')
    expect(html).toContain('第1波 05:12 押し波')
  })
  it('正: 到達確認・欠測の吹き出しも同じ形の第1波を出す', () => {
    expect(arrivalTooltipHtml({ name: '珠洲', lat: 0, lng: 0, arrivalTime: '2026-04-20T05:12:00', initial: '引き', blinking: false })).toContain('第1波 05:12 引き波')
    expect(missingTooltipHtml({ name: '富山', lat: 0, lng: 0, arrivalTime: '2026-04-20T05:12:00', initial: '押し', blinking: false })).toContain('第1波 05:12 押し波')
  })
  it('安全弁: 時刻が無い到達確認は「到達を確認」と言う（到達そのものは確定している）', () => {
    expect(arrivalTooltipHtml({ name: '珠洲', lat: 0, lng: 0, blinking: false })).toContain('到達を確認')
  })
})

describe('海岸線の吹き出し（予想波高と到達予想）', () => {
  const area = (over: Partial<TsunamiArea>): TsunamiArea => ({ name: '石川県能登', code: '360', grade: 'MajorWarning', immediate: false, ...over })
  // 正（2026-10-21 ユーザー選択「波高と到達予想も出す (Recommended)」）
  it('正: 予想波高と到達予想時刻を行にする', () => {
    expect(tsunamiAreaPopupLines(area({ maxHeight: { description: '5m', value: 5 }, firstHeight: { arrivalTime: '2026-04-20T16:12:00', condition: '' } })))
      .toEqual(['予想 5m', '到達予想 16:12'])
  })
  it('正: 時刻が無ければカードと同じバッジの語を出す', () => {
    expect(tsunamiAreaPopupLines(area({ maxHeight: { description: '巨大' }, firstHeight: { condition: '津波到達中と推測' } })))
      .toEqual(['予想 巨大', '到達中'])
  })
  it('正: 区域名・等級の下に行を並べる', () => {
    const html = tsunamiLinePopupHtml('石川県能登', '大津波警報', ['予想 5m', 'まもなく到達'])
    expect(html.indexOf('大津波警報')).toBeLessThan(html.indexOf('予想 5m'))
    expect(html).toContain('まもなく到達')
  })
})

describe('津波の原因地震の震源', () => {
  it('正: 座標のある原因地震だけを置き、1 つにつき震央と震源の 2 点を出す', () => {
    const { points, owners } = buildSourcePoints([
      { hypocenterName: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 10 },
      { hypocenterName: '座標の無い地震' },
    ], 1)
    expect(points).toHaveLength(2)
    expect(owners).toEqual([0, 0])
    expect(points[1]).toMatchObject({ shape: 'cross', depthKm: 10 })
  })
  it('安全弁: 深さが判らない震源は地表に置き、途切れた×にする（「ごく浅い」と見分ける）', () => {
    const { points } = buildSourcePoints([{ hypocenterName: 'X', latitude: 37.5, longitude: 137.2, depth: -1 }], 1)
    expect(points[1]).toMatchObject({ shape: 'crossBroken', depthKm: 0 })
  })
  // 正（2026-10-24 ユーザー選択「この形で (Recommended)」）
  it('正: 吹き出しは震源名／「M7.6　深さ 10km」／「地震発現時刻 16:10」', () => {
    const html = sourcePopupHtml({ hypocenterName: '石川県能登地方', magnitude: 7.6, depth: 10, arrivalTime: '2026-04-20T16:10:00' })
    expect(html).toContain('石川県能登地方')
    expect(html).toContain('M7.6　深さ 10km')
    expect(html).toContain('地震発現時刻 16:10')
  })
  // 規模の記号は電文の種別（2026-10-29 ユーザー承認「吹き出しと共有カードも (Recommended)」）。
  it('正: 種別 Mj の規模は「Mj7.6」、遠地の M は「M8.0」と電文のまま出す', () => {
    expect(sourcePopupHtml({ hypocenterName: 'X', magnitude: 7.6, magnitudeType: 'Mj' })).toContain('Mj7.6')
    expect(sourcePopupHtml({ hypocenterName: 'X', magnitude: 8, magnitudeType: 'M' })).toContain('M8.0')
  })
  it('安全弁: 規模が数値で無ければ種別があっても説明を出す（「Mj不明」にしない）', () => {
    const html = sourcePopupHtml({ hypocenterName: 'X', magnitudeType: 'Mj', magnitudeCondition: 'Ｍ８を超える巨大地震' })
    expect(html).toContain('M8を超える巨大地震')
    expect(html).not.toContain('Mj')
  })
})

describe('印の吹き出しの開き方', () => {
  /** 地図の click を後から発火できる偽の地図と、開閉を記録する偽の吹き出し。 */
  function setup() {
    const listeners: (() => void)[] = []
    const map = {
      on: (_t: string, f: () => void) => { listeners.push(f) },
      off: (_t: string, f: () => void) => { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1) },
    }
    const mapClick = () => { for (const f of [...listeners]) f() }
    const makePopup = () => {
      const p = { open: false, setLngLat: () => p, addTo: () => { p.open = true; return p }, remove: () => { p.open = false; return p } }
      return p
    }
    return { map: map as never, mapClick, makePopup }
  }
  const pointer = (type: string, pointerType: string) => Object.assign(new Event(type), { pointerType })

  it('正: 押すと開いたままになり、もう一度押すと閉じる', () => {
    const { map, makePopup } = setup()
    const el = document.createElement('div')
    const popup = makePopup()
    attachTsunamiMarkerPopup(map, el, popup as never, '輪島港', 'bar', () => [0, 0])
    el.click()
    expect(popup.open).toBe(true)
    el.dispatchEvent(pointer('pointerleave', 'mouse'))
    expect(popup.open).toBe(true)
    el.click()
    expect(popup.open).toBe(false)
  })

  it('正: 地図の別の場所を押すと閉じる', () => {
    const { map, mapClick, makePopup } = setup()
    const el = document.createElement('div')
    const popup = makePopup()
    attachTsunamiMarkerPopup(map, el, popup as never, '輪島港', 'bar', () => [0, 0])
    el.click()
    mapClick()
    expect(popup.open).toBe(false)
  })

  it('対照: マウスを乗せている間だけ開く（タッチの乗せ外しでは開かない）', () => {
    const { map, makePopup } = setup()
    const el = document.createElement('div')
    const popup = makePopup()
    attachTsunamiMarkerPopup(map, el, popup as never, '輪島港', 'bar', () => [0, 0])
    el.dispatchEvent(pointer('pointerenter', 'touch'))
    expect(popup.open).toBe(false)
    el.dispatchEvent(pointer('pointerenter', 'mouse'))
    expect(popup.open).toBe(true)
    el.dispatchEvent(pointer('pointerleave', 'mouse'))
    expect(popup.open).toBe(false)
  })

  it('安全弁: 印を押したことを地図の click へ伝えない（下地の海岸線の吹き出しを同時に開かない）', () => {
    const { map, makePopup } = setup()
    const parent = document.createElement('div')
    const el = document.createElement('div')
    parent.appendChild(el)
    const onParentClick = vi.fn()
    parent.addEventListener('click', onParentClick)
    attachTsunamiMarkerPopup(map, el, makePopup() as never, '輪島港', 'bar', () => [0, 0])
    el.click()
    expect(onParentClick).not.toHaveBeenCalled()
  })

  it('正: 1 枚だけ出す（別の印を押すと前の印の吹き出しは閉じる）', () => {
    const { map, makePopup } = setup()
    const [a, b] = [document.createElement('div'), document.createElement('div')]
    const [pa, pb] = [makePopup(), makePopup()]
    attachTsunamiMarkerPopup(map, a, pa as never, 'A', 'bar', () => [0, 0])
    attachTsunamiMarkerPopup(map, b, pb as never, 'B', 'bar', () => [0, 0])
    a.click()
    b.click()
    expect([pa.open, pb.open]).toEqual([false, true])
  })

  // 正（2026-10-21 ユーザー選択「吹き出しも開く (Recommended)」）: 行から開くときは、棒と欠測が重なれば棒を開く
  it('正: 行から開くときは観測棒を優先し、印が無い観測点では何もしない', () => {
    const { map, makePopup } = setup()
    const [missingEl, barEl] = [document.createElement('div'), document.createElement('div')]
    const [pm, pb] = [makePopup(), makePopup()]
    attachTsunamiMarkerPopup(map, missingEl, pm as never, '富山', 'missing', () => [0, 0])
    attachTsunamiMarkerPopup(map, barEl, pb as never, '富山', 'bar', () => [0, 0])
    expect(openTsunamiMarkerPopup(map, '富山')).toBe(true)
    expect([pb.open, pm.open]).toEqual([true, false])
    expect(openTsunamiMarkerPopup(map, '印の無い観測点')).toBe(false)
  })

  // 到達確認の印に波高が付くと観測棒へ移る。印を作り直しただけで、読んでいた吹き出しを黙って閉じない
  it('正: 開いたままの印が別の種類の印へ作り直されたら、新しい印で開き直す（外すのが後）', () => {
    const { map, makePopup } = setup()
    const [arrEl, barEl] = [document.createElement('div'), document.createElement('div')]
    const [pa, pb] = [makePopup(), makePopup()]
    const arrival = attachTsunamiMarkerPopup(map, arrEl, pa as never, '輪島港', 'arrival', () => [0, 0])
    arrEl.click()
    attachTsunamiMarkerPopup(map, barEl, pb as never, '輪島港', 'bar', () => [0, 0])
    arrival.dispose()
    expect([pa.open, pb.open]).toEqual([false, true])
  })

  it('正: 外すのが先でも、同じ描き直しの中でできた印で開き直す', () => {
    const { map, makePopup } = setup()
    const [arrEl, barEl] = [document.createElement('div'), document.createElement('div')]
    const [pa, pb] = [makePopup(), makePopup()]
    const arrival = attachTsunamiMarkerPopup(map, arrEl, pa as never, '輪島港', 'arrival', () => [0, 0])
    arrEl.click()
    arrival.dispose()
    attachTsunamiMarkerPopup(map, barEl, pb as never, '輪島港', 'bar', () => [0, 0])
    expect(pb.open).toBe(true)
  })

  // 対照: 開いていなかった印の作り直しでは開かない／しばらく後に同じ観測点が現れても勝手に開かない
  it('対照: 開いていなかった印や、描き直しの後に現れた印では開かない', async () => {
    const { map, makePopup } = setup()
    const [aEl, bEl, cEl] = [document.createElement('div'), document.createElement('div'), document.createElement('div')]
    const [pa, pb, pc] = [makePopup(), makePopup(), makePopup()]
    attachTsunamiMarkerPopup(map, aEl, pa as never, '輪島港', 'arrival', () => [0, 0]).dispose()
    attachTsunamiMarkerPopup(map, bEl, pb as never, '輪島港', 'bar', () => [0, 0])
    expect(pb.open).toBe(false)
    const pinnedThenGone = attachTsunamiMarkerPopup(map, cEl, pc as never, '富山', 'arrival', () => [0, 0])
    cEl.click()
    pinnedThenGone.dispose()
    await new Promise(r => setTimeout(r, 0))
    const later = makePopup()
    attachTsunamiMarkerPopup(map, document.createElement('div'), later as never, '富山', 'bar', () => [0, 0])
    expect(later.open).toBe(false)
  })

  // 行から寄せるときは、開いたままの印の吹き出しも閉じる（地図の吹き出しを閉じる `closeMapPopup` は印の吹き出しを知らない）
  it('正: 印の吹き出しをまとめて閉じられ、閉じたあとの作り直しでは開き直さない', () => {
    const { map, makePopup } = setup()
    const [aEl, bEl] = [document.createElement('div'), document.createElement('div')]
    const [pa, pb] = [makePopup(), makePopup()]
    const a = attachTsunamiMarkerPopup(map, aEl, pa as never, '輪島港', 'arrival', () => [0, 0])
    aEl.click()
    closeTsunamiMarkerPopups(map)
    expect(pa.open).toBe(false)
    a.dispose()
    attachTsunamiMarkerPopup(map, bEl, pb as never, '輪島港', 'bar', () => [0, 0])
    expect(pb.open).toBe(false)
  })

  it('安全弁: 開いたままの吹き出しがあるときは、別の印にマウスを乗せても 2 枚目を出さない', () => {
    const { map, makePopup } = setup()
    const [a, b] = [document.createElement('div'), document.createElement('div')]
    const [pa, pb] = [makePopup(), makePopup()]
    attachTsunamiMarkerPopup(map, a, pa as never, 'A', 'bar', () => [0, 0])
    attachTsunamiMarkerPopup(map, b, pb as never, 'B', 'bar', () => [0, 0])
    a.click()
    b.dispatchEvent(pointer('pointerenter', 'mouse'))
    expect([pa.open, pb.open]).toEqual([true, false])
  })
})
