// EEW の出どころの選び方（planEewSection・buildEewSection）。fc_hist の控えの読み込みと控えの置き場所だけを
// 差し替え、偽の fc_hist ページ（実ページの見本を書き換えたもの）と偽の pub_hist の控えを渡す。通信しない。
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { state } = vi.hoisted(() => ({
  state: { dir: '', pages: [] as { capture: { eventId: string; timestamp: string; original: string }; html: string }[] },
}))

vi.mock('./waybackFcHist', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./waybackFcHist')>()
  return {
    ...actual,
    mainCheckoutCacheDir: (name: string) => join(state.dir, name),
    loadFcHistPages: async () => ({ pages: state.pages, datesWithoutCdx: [], unavailable: [] }),
  }
})

import { buildEewSection, planEewSection } from './localEarthquakeArchiveBuilder'

const SAMPLE = readFileSync(join(__dirname, 'fc-hist-20160416012510.fixture.html'), 'utf-8')
const CANCEL_SAMPLE = readFileSync(join(__dirname, 'fc-hist-20160416023300.fixture.html'), 'utf-8')
const ROOT = join(__dirname, '..')

/** 予測震度の欄を全報「---」にしたページ（深発地震の形） */
const NO_FORECAST = SAMPLE.replace(/<td nowrap>※\d<\/td>/g, '<td nowrap>---</td>')
/** 通常の報の行を消し、検知の行と取消の行だけにしたページ */
const CANCEL_ONLY = CANCEL_SAMPLE.replace(/<tr><td>[12]<\/td>.*<\/tr>\r?\n/g, '')
/** 秒まで書く pub_hist の形にしたページ（同じ地震） */
const PUB_HIST = SAMPLE.replace('平成28年04月16日01時25分', '平成28年04月16日01時25分05.4秒')

const page = (eventId: string, html: string) => ({ capture: { eventId, timestamp: '20160422000000', original: `x/${eventId}/index.html` }, html })

const opts = (pubHistEvents: { idPrefix: string; dir: string }[]) => ({
  idBase: 'test',
  pubHistBase: 'https://example.test/pub_hist',
  pubHistEvents,
  dates: ['20160416'],
  windowStart: new Date('2016-04-16T00:00:00+09:00'),
  windowEnd: new Date('2016-04-17T00:00:00+09:00'),
  repoRoot: ROOT,
})

beforeEach(async () => {
  state.dir = await mkdtemp(join(tmpdir(), 'eew-plan-'))
  state.pages = []
})

afterEach(async () => {
  await rm(state.dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function putPubHist(dir: string, html: string) {
  await mkdir(join(state.dir, 'jma-pub-hist-cache'), { recursive: true })
  await writeFile(join(state.dir, 'jma-pub-hist-cache', `${dir}.html`), html, 'utf-8')
}

describe('planEewSection の振り分け', () => {
  it('前提: 書き換えたページは想定どおりの形', () => {
    expect(NO_FORECAST).not.toMatch(/<td nowrap>※\d<\/td>/)
    expect(CANCEL_ONLY).not.toMatch(/<tr><td>1<\/td>/)
    expect(CANCEL_ONLY).toMatch(/<td>キャンセル<\/td>/)
  })

  it('正: fc_hist から報を作れた地震は fc_hist から作り、pub_hist の補いから外す', async () => {
    state.pages = [page('20160416012510', SAMPLE)]
    const plan = await planEewSection(opts([{ idPrefix: 'main', dir: '20160416012510' }]))
    expect(plan.fcHistBuilt.map((b) => b.eventId)).toEqual(['20160416012510'])
    expect(plan.pubHistEvents).toEqual([])
    expect(plan.gaps).toEqual([])
  })

  it('正: ページは読めたが予報を組めなかった地震は、警報の地震なら pub_hist で補う', async () => {
    state.pages = [page('20160416012510', NO_FORECAST)]
    await putPubHist('20160416012510', PUB_HIST)
    const plan = await planEewSection(opts([{ idPrefix: 'main', dir: '20160416012510' }]))
    expect(plan.supplementedByPubHist).toEqual(['20160416012510'])
    expect(plan.pubHistEvents.map((e) => e.dir)).toEqual(['20160416012510'])
    expect(plan.pubHistToFetch).toEqual([])
    expect(plan.gaps).toEqual([])
  })

  it('対照: 警報の地震でなければ補えず、予測震度なし（no-forecast）の欠けになる', async () => {
    state.pages = [page('20160416012510', NO_FORECAST)]
    const plan = await planEewSection(opts([]))
    expect(plan.supplementedByPubHist).toEqual([])
    expect(plan.gaps).toEqual([{ kind: 'no-forecast', eventId: '20160416012510', date: '20160416' }])
  })

  it('安全弁: 検知の行と取消の行しか無いページは、予測震度なしではなく通常の報なし（no-normal-report）に振り分ける', async () => {
    state.pages = [page('20160416023300', CANCEL_ONLY)]
    const plan = await planEewSection(opts([]))
    expect(plan.fcHistBuilt).toEqual([])
    expect(plan.gaps).toEqual([{ kind: 'no-normal-report', eventId: '20160416023300', date: '20160416' }])
  })
})

describe('buildEewSection は控えだけを読む', () => {
  it('安全弁: pub_hist の控えが無ければ、配信元へ取りに行かずに止まる', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await expect(
      buildEewSection({ ...opts([{ idPrefix: 'fore', dir: '20160416012510' }]), knownGaps: [] }),
    ).rejects.toThrow(/fetch-pub-hist\.ts/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('対照: 控えがあれば、そこから組み立てる', async () => {
    await putPubHist('20160416012510', PUB_HIST)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const result = await buildEewSection({ ...opts([{ idPrefix: 'fore', dir: '20160416012510' }]), knownGaps: [] })
    expect(result.pubHistEventIds).toEqual(['20160416012510'])
    expect(result.entries.length).toBe(12)
  })
})
