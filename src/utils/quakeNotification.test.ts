// 地震情報のブラウザ通知の中身と、出す回数を固定する。
// 震度速報 → 震源が判った報の 2 回（2026-10-19 ユーザー承認「速報の文＋震源で置き換え (推奨)」）に加え、
// 震源が判ったあとに最大震度が上がったら出し直す（2026-10-22 選択「頭に「最大震度更新」 (Recommended)」）。
// 遠地地震は震度に関係なく 1 回（2026-10-22 選択「全部出す (Recommended)」）。tag は地震ごとで、置き換える。
import { describe, it, expect, vi } from 'vitest'
import type { EarthquakePoint, IntensityScale, JMAQuake } from '../types/earthquake'
import { collectQuakesToNotify, decideQuakeNotification, maxScaleAreaLabel, rememberQuakeNotified, scalePromptNotificationBody, scheduleQuakeNotification, type QuakeNotification, type QuakeNotifiedState } from './quakeNotification'

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
    expect(r.notification).toEqual({ title: '地震情報', body: '震度速報 石川県能登 最大震度5弱', tag: '20260101162200', renotify: false })
    expect(r.next).toEqual({ key: '20260101162200', withHypocenter: false, maxScale: 45 })
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

  // 正: 震源が判ったあとで最大震度の階級が上がったら、頭に「最大震度更新」を付けて出し直す。音も鳴らし直す。
  it('震源が判ったあと最大震度が上がったら「最大震度更新」で出し直す', () => {
    const first = decideQuakeNotification(withHypo, null, 30, null)!
    const raised = makeQuake({ hypoName: '石川県能登地方', maxScale: 55, points: [area('石川県能登', 55)] })
    const r = decideQuakeNotification(raised, first.next, 30, null)!
    expect(r.notification).toEqual({ title: '地震情報', body: '最大震度更新 石川県能登地方 最大震度6弱 M5.2', tag: first.notification.tag, renotify: true })
    expect(r.next.maxScale).toBe(55)
    // 同じ階級のままの続報では、もう出さない
    expect(decideQuakeNotification(raised, r.next, 30, null)).toBeNull()
  })

  // 対照: 下がった・据え置きの続報では出さない。「以上」が付いただけでも階級は同じなので出さない。
  it('最大震度が下がった・変わらない続報では出さない', () => {
    const first = decideQuakeNotification(withHypo, null, 30, null)!
    const lowered = makeQuake({ hypoName: '石川県能登地方', maxScale: 40, points: [area('石川県能登', 40)] })
    expect(decideQuakeNotification(lowered, first.next, 30, null)).toBeNull()
    const orAbove = makeQuake({ hypoName: '石川県能登地方', points: [area('石川県能登', 45, true)] })
    expect(decideQuakeNotification(orAbove, first.next, 30, null)).toBeNull()
  })

  // 安全弁: 震源がまだ判らないうちに上がっても出さない（震源が判った報で、そのときの最大震度を出す）。
  it('震源が判る前に最大震度が上がっても出さず、震源の報で上がった値を出す', () => {
    const first = decideQuakeNotification(prompt, null, 30, null)!
    const raisedPrompt = makeQuake({ maxScale: 50, points: [area('石川県能登', 50)] })
    expect(decideQuakeNotification(raisedPrompt, first.next, 30, null)).toBeNull()
    const raisedHypo = makeQuake({ hypoName: '石川県能登地方', maxScale: 50, points: [area('石川県能登', 50)] })
    expect(decideQuakeNotification(raisedHypo, first.next, 30, null)!.notification).toMatchObject({ body: '石川県能登地方 最大震度5強 M5.2', renotify: false })
  })

  it('別の地震なら前の状態に関わらず出す', () => {
    const other = { ...withHypo, eventKey: '20260101170000' }
    const first = decideQuakeNotification(withHypo, null, 30, null)!
    expect(decideQuakeNotification(other, first.next, 30, null)?.notification.tag).toBe('20260101170000')
  })
})

describe('decideQuakeNotification（遠地地震）', () => {
  const foreign = {
    ...makeQuake({ hypoName: 'メキシコ、チアパス州沿岸', mag: 7.4, maxScale: -1, points: [] }),
    issue: { source: 'dmdata', time: '2026-01-01T07:22:30Z', type: '遠地地震', correct: 'なし' },
  } as JMAQuake

  // 正: 国内の震度を持たなくても、設定の震度に関係なく出す。本文は詳細震央地名と規模。
  it('震度の閾値に関係なく、遠地地震の文で出す', () => {
    const r = decideQuakeNotification(foreign, null, 50, null)!
    expect(r.notification).toEqual({ title: '地震情報', body: '遠地地震 メキシコ、チアパス州沿岸 M7.4', tag: '20260101162200', renotify: false })
  })

  // 対照: 同じ地震の続報では出さない（地震ごとに 1 回）。
  it('同じ遠地地震の続報では出さない', () => {
    const r = decideQuakeNotification(foreign, null, 30, null)!
    expect(decideQuakeNotification(foreign, r.next, 30, null)).toBeNull()
  })

  // 安全弁: 通知を切っていれば遠地地震も出さない。
  it('通知を切っている（負の閾値）なら出さない', () => {
    expect(decideQuakeNotification(foreign, null, -1, null)).toBeNull()
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
    for (const key of ['a', 'b', 'c']) rememberQuakeNotified(memory, { key, withHypocenter: true, maxScale: 45 }, 2)
    expect([...memory.keys()]).toEqual(['b', 'c'])
  })

  // 対照: 同じ地震を覚え直すと新しい側へ移り、すぐには落ちない。
  it('同じ地震を覚え直すと、古い側から外れる', () => {
    const memory = new Map<string, QuakeNotifiedState>()
    rememberQuakeNotified(memory, { key: 'a', withHypocenter: false, maxScale: 45 }, 2)
    rememberQuakeNotified(memory, { key: 'b', withHypocenter: true, maxScale: 45 }, 2)
    rememberQuakeNotified(memory, { key: 'a', withHypocenter: true, maxScale: 45 }, 2)
    rememberQuakeNotified(memory, { key: 'c', withHypocenter: true, maxScale: 45 }, 2)
    expect([...memory.keys()]).toEqual(['a', 'c'])
  })
})

describe('collectQuakesToNotify', () => {
  const card = makeQuake({ hypoName: '石川県能登地方' })
  const other = { ...makeQuake({ hypoName: '福島県沖' }), id: 'dmdata-quake-20260101170000-1', eventKey: '20260101170000', earthquake: { ...makeQuake({ hypoName: '福島県沖' }).earthquake, time: '2026-01-01T08:00:00Z' } } as JMAQuake

  // 正: 先頭でない地震の報も引く。同じ地震の報が並んでも 1 つにまとめる。
  it('一覧の先頭でない地震も引き、同じカードに当たる報はまとめる', () => {
    const r = collectQuakesToNotify([card, card], [other, card], null)
    expect(r.cards).toEqual([card])
    expect(r.unmatched).toEqual([])
  })

  // 対照: 引けない報は外して返す（呼び出し側が記録する）。
  it('当たるカードが無い報は unmatched に返す', () => {
    const r = collectQuakesToNotify([other], [card], null)
    expect(r.cards).toEqual([])
    expect(r.unmatched).toEqual([other])
  })

  // 安全弁: 取り消されたカードには当てない。
  it('取り消されたカードには当てない', () => {
    const cancelled = { ...card, cancelledAt: new Date('2026-01-01T07:30:00Z') } as JMAQuake
    expect(collectQuakesToNotify([card], [cancelled], null).cards).toEqual([])
  })
})

// 通知は Service Worker の返事を待つので、出せたかがすぐには分からない。同じ地震の通知は前が済んでから
// 判定し、出せたときだけ覚える（`scheduleQuakeNotification`）
describe('scheduleQuakeNotification', () => {
  /** 呼ばれた順に記録し、`results` の順に成功・失敗を返す `show`。 */
  function makeShow(results: ('ok' | 'fail')[]) {
    const shown: QuakeNotification[] = []
    const show = vi.fn((n: QuakeNotification) => {
      shown.push(n)
      return results.shift() === 'fail' ? Promise.reject(new TypeError('Illegal constructor')) : Promise.resolve()
    })
    return { shown, show }
  }
  const prompt = makeQuake()
  const withHypo = makeQuake({ hypoName: '石川県能登地方' })

  function schedule(chains: Map<string, Promise<void>>, memory: Map<string, QuakeNotifiedState>, quake: JMAQuake, show: (n: QuakeNotification) => Promise<void>) {
    return scheduleQuakeNotification({ chains, memory, quake, notifyMinScale: 30, areaPrefIndex: null, show })
  }

  it('正: 出せたら覚え、同じ内容の報が続いても 2 度は出さない', async () => {
    const chains = new Map<string, Promise<void>>()
    const memory = new Map<string, QuakeNotifiedState>()
    const { shown, show } = makeShow(['ok', 'ok'])
    const a = schedule(chains, memory, prompt, show)
    const b = schedule(chains, memory, prompt, show)
    await Promise.all([a, b])
    expect(shown).toHaveLength(1)
    expect(memory.size).toBe(1)
  })

  // 先に覚えて失敗で戻す形だと、2 通とも出せなかったとき、1 通目が通知済みとして残った
  it('安全弁: 続けて 2 通とも出せなければ、何も覚えない', async () => {
    const chains = new Map<string, Promise<void>>()
    const memory = new Map<string, QuakeNotifiedState>()
    const { show } = makeShow(['fail', 'fail'])
    const a = schedule(chains, memory, prompt, show)
    const b = schedule(chains, memory, withHypo, show)
    await expect(a).rejects.toThrow()
    await expect(b).rejects.toThrow()
    expect(memory.size).toBe(0)
  })

  it('正: 前が出せなくても、次の報はその前提（何も出ていない）で判定して出す', async () => {
    const chains = new Map<string, Promise<void>>()
    const memory = new Map<string, QuakeNotifiedState>()
    const { shown, show } = makeShow(['fail', 'ok'])
    const a = schedule(chains, memory, prompt, show)
    const b = schedule(chains, memory, prompt, show)
    await expect(a).rejects.toThrow()
    await b
    expect(shown).toHaveLength(2)
    expect(memory.size).toBe(1)
  })

  it('対照: 同じ地震の次の報は、前の通知が済むまで出さない', async () => {
    const chains = new Map<string, Promise<void>>()
    const memory = new Map<string, QuakeNotifiedState>()
    let release!: () => void
    const order: string[] = []
    const show = vi.fn((n: QuakeNotification) => {
      order.push(n.title)
      return order.length === 1 ? new Promise<void>(resolve => { release = resolve }) : Promise.resolve()
    })
    const a = schedule(chains, memory, prompt, show)
    const b = schedule(chains, memory, withHypo, show)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(show).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([a, b])
    expect(show).toHaveBeenCalledTimes(2)
    expect(chains.size).toBe(0)
  })

  // 出せたかが分かるのは返事が来てから。返事の前に覚えると、出せなかった通知が通知済みになる
  it('安全弁: 返事が来るまでは覚えず、出せてから渡した memory へ覚える', async () => {
    const chains = new Map<string, Promise<void>>()
    const memory = new Map<string, QuakeNotifiedState>()
    let release!: () => void
    const show = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
    const a = schedule(chains, memory, prompt, show)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(memory.size).toBe(0)
    release()
    await a
    expect(memory.size).toBe(1)
  })
})
