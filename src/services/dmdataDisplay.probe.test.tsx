// @vitest-environment jsdom
//
// パーサーが読み取った値が、画面と読み上げのどこかに出ているかを実電文で数える計測台。
// 内部型の欄を 1 つずつ消して描画と読み上げを作り直し、1 文字も変わらない欄を「出ていない」の候補として残す。
//
// 測り方・環境変数・結果の枠の意味・見ない出口・誤検出の型は、docs/spec/telegram-coverage-audit.md の
// §2「画面と読み上げに出しているかを測る」にある。環境変数を渡したときだけ動く（通常の `npm test` は汚さない）。
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { act } from 'react'
// @ts-expect-error -- 型定義を持たない .mjs（`dmdataCoverage.probe.test.ts` と同じ扱い）
import { writeArtifact } from '../../scripts/lib/incompleteness.mjs'
// @ts-expect-error -- 同上
import { absorbSampleCollectionMarks } from '../../scripts/telegram-audit/collection-mark.mjs'
import { render, cleanup } from '@testing-library/react'
import { flushDataEffects } from '../test-utils/flushDataEffects'
import {
  parseEEWFromXml, parseEarthquakeFromXml, parseTsunamiFromXml,
  parseLpgmFromXml, parseNankaiFromXml, parseNankaiCommentaryFromXml, parseVyse60FromXml,
  parseEarthquakeCountFromXml, parseQuakeNoticeFromXml,
} from './dmdataParser'
import { EarthquakeTab } from '../components/EarthquakeTab'
import { RealtimeTab } from '../components/RealtimeTab'
import { TsunamiTab } from '../components/TsunamiTab'
import { SpecialInfoBanner } from '../components/SpecialInfoBanner'
import { quakeEventKey } from '../utils/quakeMerge'
import { createEmptyTelegramLoss } from '../utils/telegramLoss'
import { NO_TSUNAMI_VALUE_MARKS } from '../utils/tsunami'
import {
  earthquakeToText, eewAlertToText, tsunamiToText, lpgmToText, nankaiToText, nankaiCommentaryToText,
  kohatsuToText, quakeNoticeToText, earthquakeCountToText, telegramTextToSpeak,
  eewWarningRegionsText, eewIntensityText, eewCancelToText,
} from '../utils/ttsText'
import { eewMaxScaleInfo, eewMaxLpgmClassInfo } from '../utils/eew'
import type { TtsSpeechOptions } from '../utils/ttsText'
import type {
  JMAQuake, EEWAlert, JMATsunami, JMALpgm, JMANankai, JMANankaiCommentary, JMAKohatsu,
  JMAQuakeNotice, JMAEarthquakeCount,
} from '../types/earthquake'

const CACHE = process.env.TELEGRAM_CACHE ?? ''
const OUT = process.env.DISPLAY_OUT ?? ''
/**
 * 種別ごとに流す電文の上限。**標本は「まだ測っていない欄を最も多く持つ電文」から順に足し、
 * その種別の全電文に現れる欄を覆ったら止める**（欄の多い順に採ると、取消・訓練・仮定震源のように
 * 欄の少ない電文にしか無い欄が一度も測られない）。上限で覆い切れなかった欄は `unmeasured` に残す
 */
const PER_TYPE = Number(process.env.DISPLAY_PER_TYPE) || 20
/** 測る種別を絞る（カンマ区切り。空ならすべて） */
const ONLY_TYPES = (process.env.DISPLAY_TYPES ?? '').split(',').map(s => s.trim()).filter(Boolean)

/** 読み上げは「全部読む」設定で作る（設定で絞った結果を「出ていない」と数えないため） */
const OPTS_ALL: TtsSpeechOptions = {
  intensityLevels: 9, maxRegions: 0, alwaysReadScale: 0, alwaysReadLpgmClass: 0, regionTolerance: 9,
  readTelegramText: true,
  telegramBoilerplate: { starMark: true, eewIssued: true, lpgmClassTable: true, tsunamiHeightLegend: true, earthquakeInfoAppendix: true },
} as TtsSpeechOptions

/**
 * 判別子・照合鍵。消すと型の分岐や部品の照合が外れて出力が丸ごと変わるが、値として出ているわけではない。
 * 測らずに `discriminators` へ回す
 */
const DISCRIMINATORS = new Set(['kind'])

/**
 * 「その値のときは何も出さない」中立値・不明値。標本で見た値がすべてこれなら `neutralInSample` へ回す。
 * `undefined` は入れない —— 値の無い葉は `leafPaths` が数えないので、ここへ届かない
 */
const NEUTRAL = new Set(['false', 'なし', 'NaN', '-1', '-200'])

/** 読めなかった電文（パーサーが投げた・null を返した）のうち、結果へ名前を出す件数 */
const UNREADABLE_EXAMPLES = 5

HTMLElement.prototype.scrollIntoView = () => {}

// jsdom は ResizeObserver を持たない。寸法は測らなくても文字は描かれる
class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver

/**
 * 生成データ（`/data/…`）への取得は `public/data/` のファイルから返す。**それ以外の取得は外へ出さない**（404 を返す）
 * —— この計測台が配信元へリクエストを投げることは無い。
 */
const PUBLIC_DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../public')
globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const at = url.indexOf('/data/')
  if (at >= 0) {
    try {
      const bytes = fs.readFileSync(path.join(PUBLIC_DIR, url.slice(at + 1).split('?')[0]))
      return Promise.resolve(new Response(new Uint8Array(bytes), { status: 200 }))
    } catch { /* 下の 404 へ */ }
  }
  return Promise.resolve(new Response('', { status: 404 }))
}) as typeof fetch

type Parse = (headType: string, xml: string) => unknown
const PARSE: Record<string, Parse> = {
  VTSE41: (h, x) => parseTsunamiFromXml(h, x),
  VTSE51: (h, x) => parseTsunamiFromXml(h, x),
  VTSE52: (h, x) => parseTsunamiFromXml(h, x),
  VXSE43: (h, x) => parseEEWFromXml(h, x),
  VXSE45: (h, x) => parseEEWFromXml(h, x),
  VXSE51: (h, x) => parseEarthquakeFromXml(h, x),
  VXSE52: (h, x) => parseEarthquakeFromXml(h, x),
  VXSE53: (h, x) => parseEarthquakeFromXml(h, x),
  VXSE61: (h, x) => parseEarthquakeFromXml(h, x),
  VXSE60: (_h, x) => parseEarthquakeCountFromXml(x),
  VXSE62: (_h, x) => parseLpgmFromXml(x),
  VYSE50: (_h, x) => parseNankaiFromXml(x),
  VYSE51: (_h, x) => parseNankaiCommentaryFromXml(x),
  VYSE52: (_h, x) => parseNankaiCommentaryFromXml(x),
  VYSE60: (_h, x) => parseVyse60FromXml(x),
  VZSE40: (_h, x) => parseQuakeNoticeFromXml(x),
}

/** 描いた DOM から、利用者の目に届く文字を集める（本文・`title`・`aria-label`・`alt`） */
function domText(root: HTMLElement): string {
  const parts = [root.textContent ?? '']
  for (const el of Array.from(root.querySelectorAll('[title],[aria-label],[alt]'))) {
    for (const a of ['title', 'aria-label', 'alt']) {
      const v = el.getAttribute(a)
      if (v) parts.push(`${a}=${v}`)
    }
  }
  return parts.join('\n')
}

/**
 * 畳まれている所を開き切る。開くと新しい開閉が現れることがあるので、何周か回す。
 *
 * **1 周の押下は 1 回の `act` にまとめる。** 1 つずつ `fireEvent.click` すると押すたびにタブ全体が描き直され、
 * 震度一覧（観測点が数百行）を開き切るのに 1 通 2 分以上かかった。まとめれば描き直しは 1 周に 1 回で済む。
 */
function expandAll(root: HTMLElement): void {
  for (let pass = 0; pass < 6; pass++) {
    const closed = Array.from(root.querySelectorAll<HTMLElement>('[aria-expanded="false"]'))
    for (const d of Array.from(root.querySelectorAll('details'))) (d as HTMLDetailsElement).open = true
    if (closed.length === 0) break
    act(() => { for (const el of closed) el.click() })
  }
}

function safe(fn: () => string): string {
  try { return fn() } catch (e) { return `（読み上げで例外: ${(e as Error).message}）` }
}

/**
 * `aria-expanded` を持たない開閉ボタン（特別情報の帯）を 1 つずつ 1 回だけ押す。
 * 閉じるボタン（ラベルか文字に「閉じる」を含む）は押さない。押すと帯ごと消える。
 * **地震カード・津波カードには使わない** —— カード自体がボタンなので、押すと選択が外れる。
 */
function pressOpenButtons(root: HTMLElement): void {
  const pressed = new WeakSet<Element>()
  for (let pass = 0; pass < 6; pass++) {
    const targets = Array.from(root.querySelectorAll<HTMLElement>('button')).filter(b =>
      !pressed.has(b) && !b.hasAttribute('aria-expanded')
      && !(b.getAttribute('aria-label') ?? '').includes('閉じる') && !(b.textContent ?? '').includes('閉じる'))
    if (targets.length === 0) break
    for (const b of targets) pressed.add(b)
    act(() => { for (const b of targets) b.click() })
  }
}

/** 描いて開き切り、文字を取って片付ける */
async function renderText(node: React.ReactElement, opts: { pressButtons?: boolean } = {}): Promise<string> {
  const r = render(node)
  await flushDataEffects()
  expandAll(r.container)
  if (opts.pressButtons) pressOpenButtons(r.container)
  await flushDataEffects()
  const t = domText(r.container)
  cleanup()
  return t
}

function earthquakeTabProps() {
  return {
    speakingKey: null, followSpeech: false, onSelect: () => {}, isLoading: false, isLoadingMore: false,
    hasMore: false, onLoadMore: () => {}, watchLoadMoreThrottle: false, error: null,
    historyLoss: createEmptyTelegramLoss(), loadMoreFailed: false, reconnectGapLoss: false, fetchThrottled: false,
    updateMarks: new Map(), onToggleLpgm: () => {}, estimatedIntensities: [], distributionQuakeKey: null,
    onToggleDistribution: () => {}, unreceivedQuakeKey: null, onToggleUnreceived: () => {}, onFocusMap: () => {},
    speakingTelegramTextSubject: null, seismoWaves: new Map(), seismoWaveFailedKeys: new Set<string>(),
    seismoWaveView: 'composite',
  } as const
}

/** 種別ごとの出口。描画と読み上げを 1 本の文字列にまとめて返す */
async function outputOf(type: string, ev: unknown, orig: unknown = ev): Promise<string> {
  const tg = safe(() => JSON.stringify(telegramTextToSpeak(ev as never, OPTS_ALL)))
  if (/^VXSE5[123]$|^VXSE61$/.test(type)) {
    const q = ev as JMAQuake
    const dom = await renderText(
      <EarthquakeTab {...earthquakeTabProps()} earthquakes={[q]} selectedId={quakeEventKey(q)}
        lpgmByEventId={new Map<string, JMALpgm>()} activeLpgmEventId={null} />,
    )
    return [dom, safe(() => earthquakeToText(q, OPTS_ALL, true)), tg].join('\n--\n')
  }
  if (type === 'VXSE62') {
    const l = ev as JMALpgm
    // 長周期は地震カードの中に開く。カードは `id` の中の地震の番号で長周期を引く（`extractQuakeEventId`）ので、
    // 殻の `id` も電文と同じ形にする。**同じ地震の地震カードを空の殻で用意する**（殻の欄が長周期の欄を隠さないよう、
    // 震源・規模は持たせない）
    // **殻の識別子と時刻は元の電文から・固定の時刻で作る。** 消した写しから作ると、`eventId` や `time` を
    // 消しただけで殻との照合や殻の時刻が変わり、長周期の値でないものを「出ている」と数える
    const eid = (orig as JMALpgm).eventId
    const SHELL_TIME = '2000-01-01T00:00:00+09:00'
    const shell = {
      kind: 'quake', id: `dmdata-quake-${eid}-1`, eventId: eid, time: SHELL_TIME,
      issue: { source: '', time: SHELL_TIME, type: '震度速報', correct: 'なし' },
      earthquake: { time: SHELL_TIME, hypocenter: { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: -1 }, maxScale: -1, domesticTsunami: '' },
      points: [],
    } as unknown as JMAQuake
    const dom = await renderText(
      <EarthquakeTab {...earthquakeTabProps()} earthquakes={[shell]} selectedId={quakeEventKey(shell)}
        lpgmByEventId={new Map([[eid, l]])} activeLpgmEventId={eid} />,
    )
    return [dom, safe(() => lpgmToText(l, OPTS_ALL, true)), tg].join('\n--\n')
  }
  if (type === 'VXSE43' || type === 'VXSE45') {
    const e = ev as EEWAlert
    const dom = await renderText(
      <RealtimeTab eewNoForecastSettledKeys={new Set()} eews={[e]} swaveArrival={null} kyoshinV2Detections={[]}
        kyoshinDetectedPoints={[]} kyoshinDemoted={[]} visible />,
    )
    return [dom, safe(() => eewAlertToText(e, 'warning')), safe(() => eewAlertToText(e, 'forecast')),
      safe(() => eewAlertToText(e, 'hypocenterUpdate')),
      // 予想値・警報の地方・取消は別の関数が声にする（導入句の関数は「◯◯で地震。」しか返さない）
      safe(() => eewWarningRegionsText(e.warningRegions ?? [], false)),
      safe(() => { const lp = eewMaxLpgmClassInfo(e); return eewIntensityText(eewMaxScaleInfo(e), lp.cls, e, true, false, lp.over, OPTS_ALL) }),
      safe(() => e.cancelled ? eewCancelToText(e, e.issue?.time ?? null) : ''),
      tg].join('\n--\n')
  }
  if (/^VTSE/.test(type)) {
    const t = ev as JMATsunami
    const dom = await renderText(<TsunamiTab tsunamiValueMarks={NO_TSUNAMI_VALUE_MARKS} tsunamis={[t]} isVisible />)
    return [dom, safe(() => tsunamiToText(t)), tg].join('\n--\n')
  }
  const slot: Record<string, string> = {
    VYSE50: 'nankai', VYSE51: 'nankaiCommentary', VYSE52: 'nankaiCommentary', VYSE60: 'kohatsu',
    VZSE40: 'quakeNotice', VXSE60: 'earthquakeCount',
  }
  const visible = { nankai: null, nankaiCommentary: null, kohatsu: null, quakeNotice: null, earthquakeCount: null, [slot[type]]: ev }
  const dom = await renderText(
    <SpecialInfoBanner banners={{ shown: true, visible } as never} speakingTelegramTextSubject={null} readsAppendix atScreenBottom={false} />,
    { pressButtons: true },
  )
  const tts = {
    VYSE50: () => nankaiToText(ev as JMANankai),
    VYSE51: () => nankaiCommentaryToText(ev as JMANankaiCommentary),
    VYSE52: () => nankaiCommentaryToText(ev as JMANankaiCommentary),
    VYSE60: () => kohatsuToText(ev as JMAKohatsu),
    VZSE40: () => quakeNoticeToText(ev as JMAQuakeNotice),
    VXSE60: () => earthquakeCountToText(ev as JMAEarthquakeCount),
  }[type]
  return [dom, tts ? safe(tts) : '', tg].join('\n--\n')
}

/** 値の入った葉の経路（配列は `[]` に畳む）。空文字・null・undefined・空配列は数えない */
function leafPaths(value: unknown, prefix = '', out = new Set<string>()): Set<string> {
  if (value === null || value === undefined || value === '') return out
  if (Array.isArray(value)) { for (const v of value) leafPaths(v, `${prefix}[]`, out); return out }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) leafPaths(v, prefix ? `${prefix}.${k}` : k, out)
    return out
  }
  out.add(prefix)
  return out
}

/**
 * 経路の葉の値を、配列のすべての要素から集める（文字列にして 50 字まで）。**先頭の要素だけを見ない** ——
 * 先頭に無くて 2 つ目以降にある値が `undefined` に化け、中立値と取り違える
 */
function valuesAt(obj: unknown, p: string): string[] {
  let nodes: unknown[] = [obj]
  for (const seg of p.split('.')) {
    const key = seg.replace(/\[\]$/, '')
    const next: unknown[] = []
    for (const n of nodes) {
      const x = (n as Record<string, unknown> | null | undefined)?.[key]
      if (seg.endsWith('[]') && Array.isArray(x)) next.push(...x)
      else next.push(x)
    }
    nodes = next
  }
  return nodes.filter(v => v !== undefined && v !== null && v !== '').map(v => String(v).slice(0, 50))
}

/** 経路の葉を消した写しを返す（配列の中なら、すべての要素から消す） */
function withoutLeaf(obj: unknown, p: string): unknown {
  const copy = structuredClone(obj)
  const segs = p.split('.')
  const walk = (node: unknown, i: number): void => {
    if (node === null || typeof node !== 'object') return
    let key = segs[i]
    const isArr = key.endsWith('[]')
    if (isArr) key = key.slice(0, -2)
    const rec = node as Record<string, unknown>
    if (i === segs.length - 1) {
      if (isArr) { if (Array.isArray(rec[key])) rec[key] = [] } else delete rec[key]
      return
    }
    const child = rec[key]
    if (isArr && Array.isArray(child)) for (const c of child) walk(c, i + 1)
    else walk(child, i + 1)
  }
  walk(copy, 0)
  return copy
}

/** 電文の時刻。描画が「今」と比べて隠すものがあるので、時計をこの少し後へ合わせる */
function telegramTime(ev: unknown): number {
  const t = (ev as { time?: string; reportDateTime?: string }).time ?? (ev as { reportDateTime?: string }).reportDateTime
  const ms = t ? Date.parse(t) : NaN
  return Number.isFinite(ms) ? ms + 60_000 : Date.now()
}

describe('読み取った値が画面・読み上げに出ているか（動的計測）', () => {
  it.skipIf(!CACHE || !OUT)('欄を 1 つずつ消して、出力が変わらない欄を数える', { timeout: 3_600_000 }, async () => {
    const byType = new Map<string, string[]>()
    for (const f of fs.readdirSync(CACHE).filter(f => f.endsWith('.xml')).sort()) {
      const type = f.split('_')[0]
      if (!PARSE[type]) continue
      if (ONLY_TYPES.length > 0 && !ONLY_TYPES.includes(type)) continue
      byType.set(type, [...(byType.get(type) ?? []), f])
    }
    const result: Record<string, unknown> = {}
    for (const [type, files] of [...byType].sort()) {
      // **読めなかった電文は種別ごとに数えて結果へ出す。** 黙って落とすと、その電文にしか無い欄が
      // 「見ていない」のに、結果からは「出ていない欄が無い」と区別できなくなる
      const unreadable = { threw: 0, returnedNull: 0, files: [] as string[] }
      const all = files.map(f => {
        let ev: unknown = null
        let threw = false
        try { ev = PARSE[type](type, fs.readFileSync(path.join(CACHE, f), 'utf8')) } catch { threw = true }
        if (!ev) {
          if (threw) unreadable.threw++
          else unreadable.returnedNull++
          if (unreadable.files.length < UNREADABLE_EXAMPLES) unreadable.files.push(f)
        }
        return { f, ev }
      }).filter((x): x is { f: string; ev: object } => !!x.ev)
        .map(x => ({ ...x, leaves: leafPaths(x.ev) }))
      // **まだ測っていない欄を最も多く持つ電文から足し、全電文の欄を覆ったら止める**（→ PER_TYPE）
      const universe = new Set<string>()
      for (const x of all) for (const p of x.leaves) universe.add(p)
      const parsed: typeof all = []
      const covered = new Set<string>()
      const pool = [...all]
      while (parsed.length < PER_TYPE && covered.size < universe.size) {
        let best = -1
        let gain = 0
        pool.forEach((x, i) => {
          let g = 0
          for (const p of x.leaves) if (!covered.has(p)) g++
          if (g > gain) { gain = g; best = i }
        })
        if (best < 0) break
        const [pick] = pool.splice(best, 1)
        parsed.push(pick)
        for (const p of pick.leaves) covered.add(p)
      }
      const shown = new Set<string>()
      const crashed = new Set<string>()
      /** 欄ごとに、標本で見た値（重複を除いて 5 つまで。結果に添える見本） */
      const samples = new Map<string, Set<string>>()
      /**
       * 標本で一度でも中立値でない値を見た欄。**見本の 5 件とは別に、見た値すべてで判定する** ——
       * 見本だけで判定すると、6 件目以降にしか無い非中立の値を見落として `neutralInSample` へ回してしまう
       */
      const sawNonNeutral = new Set<string>()
      /** 同じ親の欄をまとめて消すと出力が変わった組（片方が欠けても、もう片方が同じ事実を出す） */
      const jointly = new Map<string, string[]>()
      for (const { ev } of parsed) {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(telegramTime(ev))
        let base: string
        const t0 = performance.now()
        try { base = await outputOf(type, ev) } catch (e) {
          cleanup(); vi.useRealTimers()
          throw new Error(`${type} の全部入りの描画で例外: ${(e as Error).message}`)
        }
        const leaves = leafPaths(ev)
        // 経過は標準エラーへ出す（何分かかる計測かを途中で見られるように）
        process.stderr.write(`[表示の計測] ${type}: 全部入り ${Math.round(performance.now() - t0)}ms・欄 ${leaves.size}\n`)
        const t1 = performance.now()
        for (const p of leaves) {
          const seen = samples.get(p) ?? new Set<string>()
          for (const v of valuesAt(ev, p)) {
            if (seen.size < 5) seen.add(v)
            if (!NEUTRAL.has(v)) sawNonNeutral.add(p)
          }
          samples.set(p, seen)
          if (shown.has(p) || DISCRIMINATORS.has(p)) continue
          let out: string
          // 消して描画が投げた欄は、不正な電文を作っただけで「出ている」証拠にならない。`crashed` にだけ数える
          try { out = await outputOf(type, withoutLeaf(ev, p), ev) } catch { cleanup(); crashed.add(p); continue }
          if (out !== base) shown.add(p)
        }
        // **同じ親の「出ていない」欄をまとめて消す。** `a || b` の代替や重複排除は、片方ずつ消しても変わらない
        // （`lpgm.arrivalTime || lpgm.originTime` など）。まとめて消して変われば、組の中で単独で出力を支えられる欄を
        // 「1 つ残して他を消しても変わらない欄」として特定する
        const groups = new Map<string, string[]>()
        for (const p of leaves) {
          if (shown.has(p) || crashed.has(p) || DISCRIMINATORS.has(p)) continue
          const parent = p.includes('.') ? p.slice(0, p.lastIndexOf('.')) : '(先頭)'
          groups.set(parent, [...(groups.get(parent) ?? []), p])
        }
        for (const [parent, members] of groups) {
          if (members.length < 2) continue
          const without = (keep: string | null) => members.filter(m => m !== keep).reduce<unknown>((o, m) => withoutLeaf(o, m), ev)
          let allRemoved: string
          try { allRemoved = await outputOf(type, without(null), ev) } catch { cleanup(); continue }
          if (allRemoved === base) continue
          const providers: string[] = []
          for (const m of members) {
            try { if (await outputOf(type, without(m), ev) === base) providers.push(m) } catch { cleanup() }
          }
          for (const m of providers) shown.add(m)
          jointly.set(parent, [...new Set([...(jointly.get(parent) ?? []), ...(providers.length > 0 ? providers : members.map(m => `${m}（組でのみ）`))])])
        }
        process.stderr.write(`[表示の計測] ${type}: 欄を消した描き直し ${Math.round(performance.now() - t1)}ms\n`)
        vi.useRealTimers()
      }
      // **別の電文で出力を変えた欄は `shown` を優先し、`crashed` から外す。** ある電文で消したら投げ、
      // 別の電文では消すと出力が変わった欄は、出している証拠が 1 つあるので「出ている」に数える
      for (const p of shown) crashed.delete(p)
      const notShown: Record<string, string> = {}
      const neutralInSample: Record<string, string> = {}
      for (const [p, vs] of [...samples].sort()) {
        if (shown.has(p) || crashed.has(p) || DISCRIMINATORS.has(p)) continue
        const v = [...vs].join(' / ').slice(0, 80)
        if (!sawNonNeutral.has(p)) neutralInSample[p] = v
        else notShown[p] = v
      }
      const measured = new Set([...samples.keys()])
      result[type] = {
        // `telegramsInCache` は置き場所にあった通数。読めた通数はそこから `unreadable` の 2 つを引いた数
        telegrams: parsed.length, telegramsInCache: files.length,
        unreadable: { count: unreadable.threw + unreadable.returnedNull, ...unreadable },
        shown: [...shown].sort(), notShown, neutralInSample,
        jointlyShown: Object.fromEntries([...jointly].sort()),
        crashed: [...crashed].sort(),
        discriminators: [...DISCRIMINATORS].filter(p => measured.has(p)),
        // 上限で覆い切れなかった欄。一度も測っていないので、出ている・出ていないのどちらにも数えない
        unmeasured: [...universe].filter(p => !measured.has(p)).sort(),
      }
      // 種別ごとに途中まで書き出す（途中で止まっても、測り終えた種別は残る）
      fs.writeFileSync(`${OUT}.partial`, JSON.stringify(result, null, 1))
    }
    // 収集の札を読んでから書く。標本の収集が途中で落ちていても、置き場所の電文だけを見ると
    // 「その種別の電文が無い」としか見えない。札の取りこぼしは `writeArtifact` の印として結果へ載る
    // （→ `scripts/telegram-audit/collection-mark.mjs`。読んだ要素の計測台と同じ扱い）
    absorbSampleCollectionMarks(CACHE)
    writeArtifact(OUT, {
      __meta: {
        measuredAt: new Date().toISOString(), perType: PER_TYPE,
        covered: ['地震タブ（選んで開き切った地震カード）', 'リアルタイムタブ（EEW カード）', '津波タブ', '特別情報の帯', '各種別の読み上げ文', '気象庁が書いた文の読み上げ'],
        notCovered: [
          '地図', 'ブラウザ通知', '共有カード', 'ウィンドウタイトル',
          '地図下端の波形の P/S 線（SeismoWaveChart）', '行動チェックリスト', 'カメラの追従', '電文ログ',
          '推計震度分布図（二進電文。PARSE に無い）',
          '前の報と比べて初めて出るもの（地震の差分読み・更新の印・津波の観測/到達/満潮/第 1 波/欠測/降格の読み上げ・津波の更新の印）',
        ],
      },
      ...result,
    })
    expect(Object.keys(result).length).toBeGreaterThan(0)
  })
})
