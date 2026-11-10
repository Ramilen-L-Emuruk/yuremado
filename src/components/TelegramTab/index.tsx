import { Fragment, memo, useState, useCallback, useMemo } from 'react'
import { zipSync } from 'fflate'
import type { TelegramLogEntry } from '../../types/earthquake'
import { formatFileStamp, readDateTime } from '../../utils/formatters'
import { quakeListDay } from '../../utils/quakeListDay'
import { isBinaryTelegramType } from '../../services/dmdataTelegramPayload'
import { Marquee } from '../Marquee'
import { Reveal } from '../EarthquakeTab/quakeMotion'
import { QuakeListDayLabel } from '../EarthquakeTab/QuakeListRow'
import {
  KIND_OPTIONS, ORIGIN_OPTIONS, localizedTelegramTitle, matchesTelegramFilter, operationBadgeOf,
  originBadgeOf, originFilterLabel, readKindFilter, readOriginFilter,
  type KindFilter, type OriginFilter,
} from './labels'
import { useMessages } from '../../i18n/I18nProvider'

// 行には発信元の印を出さない。発信元が DMDATA の 1 つだけで、全行が同じ印になっていた
// （2026-11-04 ユーザー選択「外す (Recommended)」。発信元が増えたら戻す）。

/** ダウンロードするファイル名に入れる発信元。発信元が増えたら型が落とすよう、`source` のすべての値を持つ表にする */
const SOURCE_FILE_NAME: Record<TelegramLogEntry['source'], string> = {
  dmdss: 'DMDSS',
}

const STATUS_BADGE: Record<TelegramLogEntry['status'], { label: string; className: string }> = {
  parsed:   { label: '✓', className: 'text-green-400' },
  filtered: { label: '⊘', className: 'text-secondary' },
  error:    { label: '✗', className: 'text-red-400' },
}

/**
 * 電文を受け取った時刻。**表示用の `formatters.ts` の同名関数とは別**（こちらは `Date` を
 * 受け、秒まで出す）。
 *
 * 受け取る値はアプリ時計（`serverDate()`）が作る。時計のオフセットが壊れれば `Invalid Date`
 * になりうるので、同じ検査を通す（素通しにすると `toLocaleTimeString` が `"Invalid Date"` を
 * 返し、行に混ざったまま記録も残らない）。
 */
function formatTime(date: Date): string | null {
  const d = readDateTime('TelegramTab.formatTime', date)
  return d?.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) ?? null
}

function buildDownloadPayload(entry: TelegramLogEntry): unknown {
  return entry.rawHead !== undefined ? { head: entry.rawHead, body: entry.rawBody } : entry.rawBody
}

/**
 * 本文が復号済みの XML か。
 *
 * **「文字列かどうか」では判定できない。** 復号に失敗した電文と、復号の前に捨てた試験報は、
 * 復号前の base64 文字列がそのまま `rawBody` に入る（`dmdata.ts` の失敗経路）。これを XML と
 * 見なすと、base64 の塊に `.xml` が付き、ヘッダも落ちたファイルが落ちてくる。
 * base64 は `<` で始まらないので、中身で見分ける。
 */
function isXmlBody(body: unknown): body is string {
  return typeof body === 'string' && body.trimStart().startsWith('<')
}

/** 開閉を動かす本文の上限（字数）。これより大きい行はすぐ開け閉めする（地震情報の大きいものは 40 万字近い） */
const ANIMATED_BODY_MAX_CHARS = 50_000

/**
 * 本文が、復号できずに base64 のまま入った文字列か（`dmdata.ts` が `body decode failed` の行に入れる）。
 * 平文の電文（国際津波関連情報）や推計震度分布図の要約の文と見分けるのに使う。
 */
function isUndecodedBody(entry: TelegramLogEntry): boolean {
  return typeof entry.rawBody === 'string' && entry.errorMessage === 'body decode failed'
}

/**
 * 展開表示・コピー用の本文。
 *
 * **文字列の本文は `JSON.stringify` に通さない。** 通すと全体がエスケープされ、改行が `\n` の 2 文字に
 * 潰れて 1 行になり、目視でもコピペでも使えなくなる（XML も、平文の国際津波関連情報も。後者は
 * 2026-11-04 ユーザー選択「改行どおりに出す (Recommended)」）。ヘッダは電文の外側の情報なので、
 * 本文の前に JSON として置く。復号できなかった base64 も、そのまま見せてかまわない。
 */
export function formatEntryForView(entry: TelegramLogEntry): string {
  if (typeof entry.rawBody === 'string') {
    const head = entry.rawHead !== undefined ? `${JSON.stringify(entry.rawHead, null, 2)}\n\n` : ''
    return head + entry.rawBody
  }
  return JSON.stringify(buildDownloadPayload(entry), null, 2)
}

/**
 * 画面に描くときだけ、改行・復帰・タブ以外の制御文字を Unicode の制御文字の図記号（U+2400〜。ETX なら「␃」）へ置き換える。
 * 国際津波関連情報の末尾には回線の終わりの印 ETX（`\x03`）が付いて来て、そのままでは化けて見える。字があることは
 * 伝えたまま化けだけを消す（2026-11-07 ユーザー選択「見える記号に置き換える (Recommended)」）。
 * コピーとダウンロードは {@link formatEntryForView}・{@link formatEntryForDownload} の生のままで、これを通さない。
 */
export function showControlChars(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, c => (c === '\x7f' ? '␡' : String.fromCharCode(0x2400 + c.charCodeAt(0))))
}

/** 単体ダウンロードの中身。文字の電文は `text`、二進の電文は `bytes`。 */
export type EntryDownload =
  | { text: string; ext: 'xml' | 'txt' | 'json' }
  | { bytes: Uint8Array; ext: 'bin' }

/**
 * 単体ダウンロードの中身と拡張子。
 *
 * - 推計震度分布図は、結合した元の電文（`rawBytes`）を `.bin` で落とす（2026-11-04 ユーザー選択「残して落とせる (Recommended)」）
 * - XML の電文はそのまま `.xml` で落とす（パーサや検証器へそのまま渡せる形にする）。
 *   ヘッダは付けない —— 付けると XML 宣言が先頭でなくなり、XML として読めなくなる
 * - XML でない文字の電文（平文の国際津波関連情報）は、本文そのままの `.txt`
 * - 復号に失敗した base64・オブジェクトの本文・二進の電文で元の二進を持たない行（結合待ちの断片の要約、
 *   base64 のまま積んだ試験報）は、ヘッダごと `.json` で落とす（.txt にすると元の電文に見える）
 */
export function formatEntryForDownload(entry: TelegramLogEntry): EntryDownload {
  if (entry.rawBytes) return { bytes: entry.rawBytes, ext: 'bin' }
  if (isXmlBody(entry.rawBody)) return { text: entry.rawBody, ext: 'xml' }
  if (typeof entry.rawBody === 'string' && !isUndecodedBody(entry) && !isBinaryTelegramType(entry.headType)) {
    return { text: entry.rawBody, ext: 'txt' }
  }
  return { text: JSON.stringify(buildDownloadPayload(entry), null, 2), ext: 'json' }
}

/** 二進を base64 の文字へ。最大 1.2 MB 程度なので、引数の上限に掛からないよう区切って文字にする */
function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

const DOWNLOAD_TYPE: Record<EntryDownload['ext'], string> = {
  xml: 'application/xml',
  txt: 'text/plain;charset=utf-8',
  json: 'application/json',
  bin: 'application/octet-stream',
}

function triggerDownload(data: string | Uint8Array, filename: string, ext: EntryDownload['ext']) {
  const blob = new Blob([data as BlobPart], { type: DOWNLOAD_TYPE[ext] })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

interface Props {
  telegramLog: TelegramLogEntry[]
  onClear: () => void
  /** このタブを開いているか。開いていない間は、電文が届いても描き直さない（{@link skipWhileHidden}）。 */
  active: boolean
}

/**
 * 開いていない間は描き直さない（`React.memo` の比較）。
 *
 * 電文ログは直近 24 時間ぶん（最大 2,022 行）を持つ。タブは隠しても DOM ごと残るので、memo だけでは
 * 電文が届くたびに全行を描き直す（2026-10-25 ユーザー選択「開いていない間は描かない (Recommended)」）。
 * 開いた時点で、そのときの全行を一度だけ描く。絞り込み・選択の状態は部品の中に残る。
 */
function skipWhileHidden(prev: Props, next: Props): boolean {
  if (!prev.active && !next.active) return true
  return prev.telegramLog === next.telegramLog && prev.onClear === next.onClear && prev.active === next.active
}

// React.memo 化の理由と props 参照安定性の要件は docs/spec/architecture-spec.md 参照。
export const TelegramTab = memo(function TelegramTab({ telegramLog, onClear }: Props) {
  const m = useMessages()
  const tm = m.telegramLog
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [originFilter, setOriginFilter] = useState<OriginFilter>('all')
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [copied, setCopied] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const filtered = useMemo(
    () => telegramLog.filter(entry => matchesTelegramFilter(entry, kindFilter, originFilter)),
    [telegramLog, kindFilter, originFilter],
  )

  const allFilteredSelected = filtered.length > 0 && filtered.every(e => selectedIds.has(e.id))

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }, [])

  const toggleSelectAll = useCallback(() => {
    setSelectedIds(prev => {
      const allIds = filtered.map(e => e.id)
      const allSelected = allIds.every(id => prev.has(id))
      if (allSelected) {
        const next = new Set(prev)
        allIds.forEach(id => next.delete(id))
        return next
      }
      const next = new Set(prev)
      allIds.forEach(id => next.add(id))
      return next
    })
  }, [filtered])

  const clearSelection = useCallback(() => setSelectedIds(new Set()), [])

  const handleCopy = useCallback((entry: TelegramLogEntry) => {
    navigator.clipboard.writeText(formatEntryForView(entry)).then(() => {
      setCopied(entry.id)
      setTimeout(() => setCopied(id => id === entry.id ? null : id), 1500)
    }).catch(() => {})
  }, [])

  const handleDownload = useCallback((entry: TelegramLogEntry) => {
    const download = formatEntryForDownload(entry)
    const ts = formatFileStamp(entry.receivedAt.getTime())
    const source = SOURCE_FILE_NAME[entry.source]
    triggerDownload('bytes' in download ? download.bytes : download.text, `${ts}_${source}_${entry.headType}.${download.ext}`, download.ext)
  }, [])

  const handleDownloadSelected = useCallback(() => {
    const entries = telegramLog.filter(e => selectedIds.has(e.id))
    if (entries.length === 0) return
    const payload = entries.map(e => ({
      source: e.source,
      // **経路も書き出す。** 画面ではバッジで分かるが、書き出したファイルでは
      // テスト・再生で流した電文が本番の受信と見分けられなくなる。
      origin: e.origin,
      headType: e.headType,
      // **`toISOString()` を素で呼ばない。** `Invalid Date` に対しては `RangeError` を
      // **投げる**（`NaN` を返すだけの `getTime()` とは違う）。選んだ電文に 1 件でも壊れた
      // 時刻が混じると `map` ごと例外で止まり、**ダウンロードが何も起きずに終わる**
      // —— 正常な電文まで道連れになるうえ、利用者には何も伝わらない。
      // 読めない時刻は `null` にして、書き出した JSON の読み手にもそれと分かるようにする。
      receivedAt: readDateTime('TelegramTab.receivedAt', e.receivedAt)?.toISOString() ?? null,
      ...(e.rawHead !== undefined ? { head: e.rawHead, body: e.rawBody } : { body: e.rawBody }),
      // 推計震度分布図の元の電文は JSON に入らないので base64 で添える（ZIP では .bin のまま入る）
      ...(e.rawBytes ? { bodyBase64: bytesToBase64(e.rawBytes) } : {}),
    }))
    const json = JSON.stringify(payload, null, 2)
    const ts = formatFileStamp(Date.now())
    triggerDownload(json, `${ts}_telegrams_${tm.downloadCount(entries.length)}.json`, 'json')
  }, [telegramLog, selectedIds, tm])

  const handleDownloadZip = useCallback(() => {
    const entries = telegramLog.filter(e => selectedIds.has(e.id))
    if (entries.length === 0) return
    const enc = new TextEncoder()
    const files: Record<string, Uint8Array> = {}
    for (const e of entries) {
      const download = formatEntryForDownload(e)
      const ext = download.ext
      const source = SOURCE_FILE_NAME[e.source]
      const ts = formatFileStamp(e.receivedAt.getTime())
      // 同じ名前があれば、空いている連番まで進める（連番を付けた名前が別の行の名前と重なっても上書きしない）
      let filename = `${ts}_${source}_${e.headType}.${ext}`
      for (let n = 2; filename in files; n++) filename = `${ts}_${source}_${e.headType}_${n}.${ext}`
      files[filename] = 'bytes' in download ? download.bytes : enc.encode(download.text)
    }
    const zipped = zipSync(files)
    const ts = formatFileStamp(Date.now())
    const blob = new Blob([zipped], { type: 'application/zip' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${ts}_telegrams_${tm.downloadCount(entries.length)}.zip`
    a.click()
    URL.revokeObjectURL(url)
  }, [telegramLog, selectedIds, tm])

  const toggleExpand = useCallback((id: string) => {
    setExpandedId(prev => prev === id ? null : id)
  }, [])

  // 日付が前の行と変わったところに区切りを置く（地震一覧と同じ「2026年11月4日」）
  // 行を選ぶ・開くたびに全行ぶん日付を読み直さないよう、絞り込んだ一覧が変わったときだけ数える
  const dayLabels = useMemo(() => {
    let lastDayKey: string | null = null
    return filtered.map(entry => {
      const d = readDateTime('TelegramTab.dayLabel', entry.receivedAt)
      const day = d ? quakeListDay(d.toISOString()) : null
      // 時刻の読めない行（行には「時刻不明」と出る）の次の行には、同じ日でも区切りを出し直す。
      // 出し直さないと、不明な行を挟んだ後の行が、前の日の区切りの下に紛れて見える
      if (!day) {
        lastDayKey = null
        return null
      }
      if (day.key === lastDayKey) return null
      lastDayKey = day.key
      return day.label
    })
  }, [filtered])

  return (
    <div className="quake-list flex flex-col h-full">
     <div className="quake-list-scope flex flex-col h-full min-h-0" style={{ fontSize: 'var(--qk-fs)' }}>
      <div className="flex items-center justify-between border-b border-border shrink-0" style={{ padding: '10px var(--qk-pad)' }}>
        <span className="font-bold text-white" style={{ fontSize: 'var(--qk-f)' }}>
          {m.nav.telegrams}
          <span className="ml-2 font-normal text-secondary tabular-nums" style={{ fontSize: 'var(--qk-fs)' }}>({filtered.length} / {telegramLog.length})</span>
        </span>
        <button
          onClick={onClear}
          className="text-secondary hover:text-white transition-colors motion-reduce:transition-none px-2 py-1 rounded-md hover:bg-white/5"
        >
          {tm.clear}
        </button>
      </div>

      <div className="flex gap-2 border-b border-border shrink-0" style={{ padding: '8px var(--qk-pad)' }}>
        <select
          value={kindFilter}
          onChange={e => setKindFilter(readKindFilter(e.target.value))}
          className="flex-1 min-w-0 bg-card border border-border rounded-sm px-2 py-1 text-secondary focus:text-white focus:outline-hidden"
        >
          <option value="all">{tm.allKinds}</option>
          {KIND_OPTIONS.map(kind => (
            <option key={kind} value={kind}>{tm.kind[kind]}</option>
          ))}
          <option value="filtered">{tm.skipped}</option>
          <option value="error">{tm.errors}</option>
        </select>
        <select
          value={originFilter}
          onChange={e => setOriginFilter(readOriginFilter(e.target.value))}
          className="flex-1 min-w-0 bg-card border border-border rounded-sm px-2 py-1 text-secondary focus:text-white focus:outline-hidden"
        >
          {ORIGIN_OPTIONS.map(value => (
            <option key={value} value={value}>{originFilterLabel(value, tm)}</option>
          ))}
        </select>
      </div>

      {selectedIds.size > 0 && (
        <div className="flex items-center justify-between border-b border-border shrink-0 bg-white/5" style={{ padding: '8px var(--qk-pad)' }}>
          <span className="text-white">{tm.selectedCount(selectedIds.size)}</span>
          <div className="flex gap-1">
            <button
              onClick={handleDownloadSelected}
              className="text-white bg-white/15 hover:bg-white/25 transition-colors motion-reduce:transition-none px-3 py-1 rounded-md"
            >
              JSON
            </button>
            <button
              onClick={handleDownloadZip}
              className="text-white bg-white/15 hover:bg-white/25 transition-colors motion-reduce:transition-none px-3 py-1 rounded-md"
            >
              ZIP
            </button>
            <button
              onClick={clearSelection}
              className="text-secondary hover:text-white transition-colors motion-reduce:transition-none px-2 py-1 rounded-md hover:bg-white/5"
            >
              {tm.deselect}
            </button>
          </div>
        </div>
      )}

      {/* ここが実際のスクロール領域（ヘッダーは shrink-0 で固定）。overflow-y だけを auto に
          すると overflow-x も auto に格上げされ横スクロールしてしまうため、App.tsx の
          TAB_SCROLLER_CLASS と同じ指定で塞ぐ（祖先の指定は子の overflow 計算に効かない）。 */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden overscroll-x-none">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-secondary" style={{ fontSize: 'var(--qk-f)' }}>
            {telegramLog.length === 0 ? tm.waiting : tm.noMatch}
          </div>
        ) : (
          <>
            <div className="sticky top-0 z-[2] flex items-center border-b border-border bg-panel" style={{ padding: '0 var(--qk-pad)', height: 'var(--qk-head-h)' }}>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={allFilteredSelected}
                  onChange={toggleSelectAll}
                  className="accent-white w-3.5 h-3.5"
                />
                <span className="text-secondary">{tm.selectAll}</span>
              </label>
            </div>
            <ul>
              {filtered.map((entry, i) => {
                const badge = STATUS_BADGE[entry.status]
                const isExpanded = expandedId === entry.id
                const isSelected = selectedIds.has(entry.id)
                const title = localizedTelegramTitle(entry, tm)
                const originBadge = originBadgeOf(entry.origin)
                const operationBadge = operationBadgeOf(entry)

                return (
                  <Fragment key={entry.id}>
                  {/* 日付の区切りは行とは別の要素にする（行の中に入れると、選んだ行の地が区切りまで染まる）。
                      巻いている間は全選択の行の下に貼りつき、どの日の行を見ているかが分かる（津波タブからの横展開） */}
                  {dayLabels[i] && (
                    <li role="presentation" className="sticky z-[1] bg-panel" style={{ top: 'var(--qk-head-h)' }}>
                      <QuakeListDayLabel label={dayLabels[i]!} />
                    </li>
                  )}
                  <li className={`border-b border-border/60 ${isSelected ? 'bg-white/5' : ''}`}>
                    <div className="flex items-start">
                      <label
                        className="flex items-start cursor-pointer shrink-0 self-stretch pt-3"
                        style={{ paddingLeft: 'var(--qk-pad)', paddingRight: '6px' }}
                        onClick={e => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(entry.id)}
                          className="accent-white w-3.5 h-3.5"
                        />
                      </label>
                      <div className="flex-1 min-w-0">
                        <button
                          onClick={() => toggleExpand(entry.id)}
                          aria-expanded={isExpanded}
                          className="quake-press-row w-full text-left py-2"
                          style={{ paddingRight: 'var(--qk-pad)' }}
                        >
                          <div className="flex items-center min-w-0" style={{ columnGap: 'var(--qk-gap)' }}>
                            <span className={`font-mono shrink-0 w-3 ${badge.className}`}>{badge.label}</span>
                            {/* 日時として読めなければ語を出す。空欄にすると列が詰まって
                                隣の値が時刻の位置に見える。 */}
                            <span className="text-secondary font-mono tabular-nums shrink-0">{formatTime(entry.receivedAt) ?? tm.timeUnknown}</span>
                            {/* 経路の印。ライブには出さない（既定の経路なので、付けると全行が賑やかになる）。 */}
                            {originBadge && (
                              <span className="font-bold bg-amber-400/20 text-amber-200 rounded-[3px] px-1 shrink-0">{tm.origin[originBadge]}</span>
                            )}
                            <span className="font-mono text-white shrink-0">{entry.headType}</span>
                            {/* 訓練・試験の印。種別名は消さずに後ろへ並べる（何の訓練かが分からなくなるため）。 */}
                            {operationBadge && (
                              <span className={`font-bold rounded-[3px] px-1 shrink-0 ${operationBadge.className}`}>{tm.operation[operationBadge.key]}</span>
                            )}
                            {/* 名前が欄に収まらないときは、開いた行だけ端まで流して頭へ戻す（2026-11-04 流し方の問いへの答え
                                「この場合ループより先頭に戻るほうがいいかも」、続く選択「開いた行だけ (Recommended)」）。畳んだ行は「…」で切る */}
                            <span className="min-w-0 flex-1 text-white" style={{ fontSize: 'var(--qk-f)' }}>
                              {isExpanded ? <Marquee text={title} mode="return" /> : <span className="block truncate">{title}</span>}
                            </span>
                          </div>
                          {entry.errorMessage && (
                            <div className="text-red-400 mt-0.5 pl-5 truncate">{entry.errorMessage}</div>
                          )}
                        </button>

                        {(() => {
                          const body = () => (
                            <>
                              <div className="flex justify-end gap-1 mb-1">
                                <button
                                  onClick={e => { e.stopPropagation(); handleDownload(entry) }}
                                  className="text-secondary hover:text-white transition-colors motion-reduce:transition-none px-2 py-0.5 rounded-md hover:bg-white/5"
                                >
                                  {tm.download}
                                </button>
                                <button
                                  onClick={e => { e.stopPropagation(); handleCopy(entry) }}
                                  className="text-secondary hover:text-white transition-colors motion-reduce:transition-none px-2 py-0.5 rounded-md hover:bg-white/5"
                                >
                                  {copied === entry.id ? tm.copied : tm.copy}
                                </button>
                              </div>
                              <pre className="font-mono text-secondary bg-black/30 rounded-sm p-2 overflow-x-auto max-h-[min(24rem,45dvh)] whitespace-pre-wrap break-all">
                                {showControlChars(formatEntryForView(entry))}
                              </pre>
                            </>
                          )
                          // 本文の大きい行は開閉を動かさない。高さを動かす間は毎フレーム本文を組み直すので、
                          // 37 万字の地震情報では詰まったフレームが動きなしの約 3 倍（8 → 25）になった
                          // 見るのは文字列の本文だけ（オブジェクトの本文は大きくならない。測るために全文を組むと、それ自体が重い）
                          return typeof entry.rawBody === 'string' && entry.rawBody.length > ANIMATED_BODY_MAX_CHARS
                            ? isExpanded && <div className="pb-3" style={{ paddingRight: 'var(--qk-pad)' }}>{body()}</div>
                            : <Reveal open={isExpanded} className="pb-3" style={{ paddingRight: 'var(--qk-pad)' }}>{body}</Reveal>
                        })()}
                      </div>
                    </div>
                  </li>
                  </Fragment>
                )
              })}
            </ul>
          </>
        )}
      </div>
     </div>
    </div>
  )
}, skipWhileHidden)
