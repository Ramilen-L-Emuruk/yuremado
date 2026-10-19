// 震源の吹き出しに出る都道府県別最大震度。
//
// **「救済」と「印」は別の話。** 救済は値を出すかどうか（観測値が 1 件も無い県だけ）、印は
// 未入電があると伝えるかどうか（**カードと同じく、1 件でもあれば**）。1 つのフラグに畳むと、
// 観測値がある県では未入電を 1 件も伝えられない —— カードが「震度4 愛媛県 未入電あり」と
// 出しているのに、吹き出しは「愛媛県 4」とだけ言う形になる（→ docs/spec/quake-spec.md §4）。
import { describe, it, expect } from 'vitest'
import { buildPopupHtml } from './HypocenterDepthGL'
import type { PrefIntensity } from '../../hooks/useQuakeLayerData'
import type { JMAQuake } from '../../types/earthquake'

const QUAKE: JMAQuake = {
  kind: 'quake',
  id: 'q1',
  time: '2026-09-13T03:00:00Z',
  issue: { source: 'dmdata', time: '2026-09-13T03:00:00Z', type: '震源・震度情報', correct: 'なし' },
  earthquake: {
    time: '2026-09-13T03:00:00Z',
    hypocenter: { name: '日向灘', latitude: 32.7, longitude: 132.1, depth: 40, magnitude: 6.4 },
    maxScale: 55,
    domesticTsunami: 'なし',
  },
  points: [],
}

const row = (over: Partial<PrefIntensity>): PrefIntensity =>
  ({ pref: '愛媛県', scale: 40, unreceived: false, hasUnreceived: false, ...over })

describe('震源の吹き出しの都道府県別最大震度', () => {
  // 正: 観測できた県でも、未入電があれば印を出す。
  it('観測値がある県に「未入電あり」を出す', () => {
    const html = buildPopupHtml(QUAKE, [row({ hasUnreceived: true })])
    expect(html).toContain('愛媛県')
    expect(html).toContain('未入電あり')
    // 値そのものは観測値のまま（印は値を書き換えない）。
    expect(html).toContain('>4<')
  })

  // 対照: 未入電を持たない県には出さない。
  it('未入電を持たない県には出さない', () => {
    expect(buildPopupHtml(QUAKE, [row({})])).not.toContain('未入電')
  })

  // 安全弁: 値そのものが推定の県には重ねない（「5弱以上」が既にそれを言っている）。
  it('値が推定の県に「未入電あり」を重ねない', () => {
    const html = buildPopupHtml(QUAKE, [row({ scale: 45, unreceived: true })])
    expect(html).toContain('5弱以上')
    expect(html).not.toContain('未入電あり')
  })
})

// 6 県を超えた分は黙って切らず、件数を添える。足すこと自体は 2026-10-14 ユーザー選択
// 「断定を外し、「ほか N 都道府県」を足す（推奨）」、書き方（数の前後に空白）は 2026-10-19「空白を入れる (Recommended)」。
// **並べ替えはしない** —— 強い順にするのは呼び出し側（`useQuakeLayerData` の `prefIntensities`）で、
// ここでは渡された順の先頭 6 件を出し、残りを数えるだけ。
describe('震源の吹き出しで 6 県を超えたとき', () => {
  const PREFS = ['石川県', '富山県', '新潟県', '福井県', '岐阜県', '長野県', '群馬県', '山形県']
  const rows = (n: number) => PREFS.slice(0, n).map((pref, i) => row({ pref, scale: 70 - i * 5 }))

  // 正: 超えた分の件数を末尾の 1 行で添える。
  it('8 県なら「ほか 2 都道府県」を添える', () => {
    expect(buildPopupHtml(QUAKE, rows(8))).toContain('ほか 2 都道府県')
  })

  // 対照: ちょうど 6 県なら添えない（境界の手前）。
  it('6 県ちょうどなら添えない', () => {
    expect(buildPopupHtml(QUAKE, rows(6))).not.toContain('ほか')
  })

  // 安全弁: 並べるのは強い順の上位 6 県のままで、7 県目以降の名前は出さない。
  it('7 県目以降の名前は並べない', () => {
    const html = buildPopupHtml(QUAKE, rows(8))
    expect(html).toContain('長野県')
    expect(html).not.toContain('群馬県')
    expect(html).not.toContain('山形県')
  })
})
