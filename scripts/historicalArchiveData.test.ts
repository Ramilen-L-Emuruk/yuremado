// ローカル履歴アーカイブ（生成物）と、その設定（historicalArchiveTargets.ts）を読んで確かめる。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ARCHIVE_IDS, ARCHIVE_TARGETS } from './historicalArchiveTargets'
import { checkKnownGaps, eventIdOfPubHistDir } from './localEarthquakeArchiveBuilder'
import type { EEWAlert } from '../src/types/earthquake'
import type { HistoricalArchiveFile } from '../src/types/historicalArchive'

const DIR = join(__dirname, '..', 'public', 'data', 'historical-archives')

describe('アーカイブの EEW の震央地名', () => {
  // 取り消された地震の取消前の報は、原典（fc_hist）の震源要素の表が「(キャンセル報)」と数値だけで地名を
  // 持たないので、震央地名が空のまま入る（2026-10-25 ユーザー選択「空のまま記録 (Recommended)」）。
  // **空になるのはその報だけ** —— 取消の無い地震の報の震央地名が空なら、読み取りが壊れている
  for (const id of ARCHIVE_IDS) {
    it(`${id}: 震央地名が空の報（取消の報を除く）は、取消のある地震の報だけ`, () => {
      const file = JSON.parse(readFileSync(join(DIR, `${id}.json`), 'utf-8')) as HistoricalArchiveFile
      const eews = file.entries
        .map((e) => (e.payload as { event?: EEWAlert }).event)
        .filter((e): e is EEWAlert => e?.kind === 'eew')
      const cancelledEvents = new Set(eews.filter((e) => e.cancelled).map((e) => e.issue?.eventId))
      const unnamed = eews.filter((e) => !e.cancelled && e.earthquake.hypocenter.name === '')
      expect(unnamed.filter((e) => !cancelledEvents.has(e.issue?.eventId)).map((e) => e.id)).toEqual([])
    })
  }
})

describe('アーカイブの設定（historicalArchiveTargets.ts）', () => {
  for (const id of ARCHIVE_IDS) {
    const t = ARCHIVE_TARGETS[id]
    it(`${id}: 取得日・警報の地震・再生の起点が収録範囲に収まる`, () => {
      const day = (d: string) => new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00+09:00`).getTime()
      for (const d of t.dates) {
        expect(day(d) + 24 * 3600_000).toBeGreaterThan(t.windowStart.getTime())
        expect(day(d)).toBeLessThan(t.windowEnd.getTime())
      }
      for (const e of t.pubHistEvents) {
        const ev = eventIdOfPubHistDir(e.dir)
        expect(t.dates).toContain(ev.slice(0, 8))
      }
      const start = new Date(t.replayStartTime).getTime()
      expect(start).toBeGreaterThanOrEqual(t.windowStart.getTime())
      expect(start).toBeLessThan(t.windowEnd.getTime())
    })

    it(`${id}: 既知の欠けの日付は取得日のどれか`, () => {
      for (const g of t.knownGaps) expect(t.dates).toContain(g.date)
    })
  }
})

describe('checkKnownGaps', () => {
  const known = [
    { kind: 'no-forecast' as const, eventId: '20160415002615', date: '20160415', reason: '深発地震' },
    { kind: 'no-cdx-date' as const, date: '20160414', reason: '目録なし' },
  ]

  it('正: 見つかった欠けが一覧と同じなら通る', () => {
    expect(() =>
      checkKnownGaps(
        [
          { kind: 'no-cdx-date', date: '20160414' },
          { kind: 'no-forecast', eventId: '20160415002615', date: '20160415' },
        ],
        known,
      ),
    ).not.toThrow()
  })

  it('安全弁: 一覧に無い欠けが出たら止める', () => {
    expect(() =>
      checkKnownGaps(
        [
          { kind: 'no-cdx-date', date: '20160414' },
          { kind: 'no-forecast', eventId: '20160415002615', date: '20160415' },
          { kind: 'fc-hist-unavailable', eventId: '20160416072359', date: '20160416' },
        ],
        known,
      ),
    ).toThrow(/一覧に無い欠け: fc-hist-unavailable:20160416072359/)
  })

  it('安全弁: 一覧にあるのに出なかった欠けも止める（取り直して埋まった欠けを一覧に残さない）', () => {
    expect(() => checkKnownGaps([{ kind: 'no-cdx-date', date: '20160414' }], known)).toThrow(
      /一覧にあるのに出なかった欠け: no-forecast:20160415002615/,
    )
  })
})
