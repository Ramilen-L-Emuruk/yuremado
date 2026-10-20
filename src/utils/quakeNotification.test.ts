// 地震情報のブラウザ通知の中身と、出す回数を固定する。
// 1 つの地震で最大 2 回（震度速報 → 震源が判った報）。2 回目は tag で 1 回目を置き換える
// （2026-10-19 ユーザー承認「速報の文＋震源で置き換え (推奨)」）。
import { describe, it, expect } from 'vitest'
import type { EarthquakePoint, IntensityScale, JMAQuake } from '../types/earthquake'
import { decideQuakeNotification, maxScaleAreaLabel, rememberQuakeNotified, scalePromptNotificationBody, type QuakeNotifiedState } from './quakeNotification'

/** DMDATA 経路の区域の点（`pref` は空。→ quake-spec.md §4）。 */
const area = (addr: string, scale: IntensityScale, unreceived = false): EarthquakePoint =>
  ({ pref: '', addr, isArea: true, scale, ...(unreceived && { unreceived: true }) })

function makeQuake(o: { hypoName?: string; maxScale?: IntensityScale; points?: EarthquakePoint[]; mag?: number; magnitudeCondition?: string } = {}): JMAQuake {
  return {
    kind: 'quake',
    id: 'dmdata-quake-20260101162200-1',
    eventKey: '20260101162200',
    time: '2026-01-01T07:22:30Z',
    issue: { source: 'dmdata', time: '2026-01-01T07:22:30Z', type: o.hypoName ? '震源・震度に関する情報' : '震度速報', correct: 'なし' },
    earthquake: {
      time: '2026-01-01T07:22:00Z',
      hypocenter: {
        name: o.hypoName ?? '',
        latitude: o.hypoName ? 37.5 : -200,
        longitude: o.hypoName ? 137.2 : -200,
        depth: o.hypoName ? 10 : -1,
        magnitude: o.mag ?? (o.hypoName ? 5.2 : NaN),
        ...(o.magnitudeCondition && { magnitudeCondition: o.magnitudeCondition }),
      },
      maxScale: o.maxScale ?? 45,
      domesticTsunami: 'なし',
    },
    points: o.points ?? [area('石川県能登', 45), area('石川県加賀', 30)],
  } as JMAQuake
}

describe('scalePromptNotificationBody', () => {
  // 正: 最大震度の区域の名前を出す。
  it('最大震度の区域が 1 つなら、その名前', () => {
    expect(scalePromptNotificationBody(makeQuake(), null)).toBe('震度速報 石川県能登 最大震度5弱')
  })

  it('最大震度の区域が複数なら、先頭に「ほか」', () => {
    const q = makeQuake({ points: [area('石川県能登', 45), area('新潟県上越', 45), area('富山県東部', 30)] })
    expect(scalePromptNotificationBody(q, null)).toBe('震度速報 石川県能登ほか 最大震度5弱')
  })

  // 対照: 最大震度より低い区域・都道府県のロールアップ点は数えない。
  it('都道府県のロールアップ点は区域として数えない', () => {
    const q = makeQuake({ points: [{ pref: '石川県', addr: '石川県', isArea: true, scale: 45 }, area('石川県能登', 45)] })
    expect(maxScaleAreaLabel(q, null)).toBe('石川県能登')
  })

  // 安全弁: 「以上」（未入電）を落とさない（既存の表記に揃える）。
  it('最大震度が「5弱以上」なら断定形にしない', () => {
    const q = makeQuake({ points: [area('石川県能登', 45, true), area('新潟県上越', 45)] })
    expect(scalePromptNotificationBody(q, null)).toBe('震度速報 石川県能登ほか 最大震度5弱以上')
  })
})

describe('decideQuakeNotification', () => {
  const prompt = makeQuake()
  const withHypo = makeQuake({ hypoName: '石川県能登地方' })

  // 正: 震度速報で 1 回目を出す。tag は地震ごとの鍵。
  it('震度速報なら速報の文で出す', () => {
    const r = decideQuakeNotification(prompt, null, 30, null)!
    expect(r.notification).toEqual({ title: '地震情報', body: '震度速報 石川県能登 最大震度5弱', tag: '20260101162200' })
    expect(r.next).toEqual({ key: '20260101162200', withHypocenter: false })
  })

  // 正: 同じ地震で震源が判ったら 2 回目。tag が同じなので OS 上で置き換わる。
  it('震度速報のあと震源が判った報が来たら、もう 1 度だけ出す', () => {
    const first = decideQuakeNotification(prompt, null, 30, null)!
    const second = decideQuakeNotification(withHypo, first.next, 30, null)!
    expect(second.notification.body).toBe('石川県能登地方 最大震度5弱 M5.2')
    expect(second.notification.tag).toBe(first.notification.tag)
    expect(second.next.withHypocenter).toBe(true)
  })

  // 対照: 3 回目は出さない（その後の続報）。
  it('震源が判ったあとの続報では出さない', () => {
    const first = decideQuakeNotification(prompt, null, 30, null)!
    const second = decideQuakeNotification(withHypo, first.next, 30, null)!
    expect(decideQuakeNotification(withHypo, second.next, 30, null)).toBeNull()
  })

  it('震源が判らないままの続報（震度速報の続き）では出さない', () => {
    const first = decideQuakeNotification(prompt, null, 30, null)!
    expect(decideQuakeNotification(prompt, first.next, 30, null)).toBeNull()
  })

  it('最初から震源が判っていれば従来の文で 1 回だけ', () => {
    const r = decideQuakeNotification(withHypo, null, 30, null)!
    expect(r.notification.body).toBe('石川県能登地方 最大震度5弱 M5.2')
    expect(decideQuakeNotification(withHypo, r.next, 30, null)).toBeNull()
  })

  it('規模が数値にならないときは気象庁の説明を出す', () => {
    const huge = makeQuake({ hypoName: '石川県能登地方', mag: NaN, magnitudeCondition: 'Ｍ８を超える巨大地震' })
    expect(decideQuakeNotification(huge, null, 30, null)!.notification.body).toBe('石川県能登地方 最大震度5弱 M8を超える巨大地震')
  })

  // 安全弁: 閾値の判定は従来どおり。
  it('最大震度が閾値に届かなければ出さない。負の閾値は通知しない', () => {
    expect(decideQuakeNotification(prompt, null, 50, null)).toBeNull()
    expect(decideQuakeNotification(prompt, null, -1, null)).toBeNull()
  })

  it('別の地震なら前の状態に関わらず出す', () => {
    const other = { ...withHypo, eventKey: '20260101170000' }
    const first = decideQuakeNotification(withHypo, null, 30, null)!
    expect(decideQuakeNotification(other, first.next, 30, null)?.notification.tag).toBe('20260101170000')
  })
})

describe('rememberQuakeNotified', () => {
  const quakeA = makeQuake({ hypoName: '石川県能登地方' })
  const quakeB = { ...quakeA, eventKey: '20260101170000' } as JMAQuake
  const decideFrom = (memory: Map<string, QuakeNotifiedState>, q: JMAQuake) => {
    const d = decideQuakeNotification(q, memory.get(q.eventKey!) ?? null, 30, null)
    if (d) rememberQuakeNotified(memory, d.next)
    return d
  }

  // 正: 2 つの地震の報が交互に先頭へ来ても、通知済みの地震を忘れない。
  it('地震 A・B が交互に来ても、A の 2 回目以降は出さない', () => {
    const memory = new Map<string, QuakeNotifiedState>()
    expect(decideFrom(memory, quakeA)).not.toBeNull()
    expect(decideFrom(memory, quakeB)).not.toBeNull()
    expect(decideFrom(memory, quakeA)).toBeNull()
  })

  // 安全弁: 上限を超えたら古いものから落とす（覚え続けない）。
  it('上限を超えたら最も古く覚えた地震から忘れる', () => {
    const memory = new Map<string, QuakeNotifiedState>()
    for (const key of ['a', 'b', 'c']) rememberQuakeNotified(memory, { key, withHypocenter: true }, 2)
    expect([...memory.keys()]).toEqual(['b', 'c'])
  })

  // 対照: 同じ地震を覚え直すと新しい側へ移り、すぐには落ちない。
  it('同じ地震を覚え直すと、古い側から外れる', () => {
    const memory = new Map<string, QuakeNotifiedState>()
    rememberQuakeNotified(memory, { key: 'a', withHypocenter: false }, 2)
    rememberQuakeNotified(memory, { key: 'b', withHypocenter: true }, 2)
    rememberQuakeNotified(memory, { key: 'a', withHypocenter: true }, 2)
    rememberQuakeNotified(memory, { key: 'c', withHypocenter: true }, 2)
    expect([...memory.keys()]).toEqual(['a', 'c'])
  })
})
