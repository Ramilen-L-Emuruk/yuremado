import { memo, useState, useCallback } from 'react'
import { zipSync } from 'fflate'
import type { TelegramLogEntry } from '../../types/earthquake'
import { isDmdss } from '../../utils/env'
import { formatFileStamp, readDateTime } from '../../utils/formatters'
import {
  KIND_LABEL, KIND_OPTIONS, ORIGIN_OPTIONS, headTypeLabel, matchesTelegramFilter, operationBadgeOf, originBadgeOf,
  readKindFilter, readOriginFilter, telegramLogKindOf,
  type KindFilter, type OriginFilter, type SourceFilter,
} from './labels'

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

/**
 * 展開表示・コピー用の本文。
 *
 * **XML は `JSON.stringify` に通さない。** 通すと全体がエスケープされ、改行が `\n` の 2 文字に
 * 潰れて 1 行になり、目視でもコピペでも使えなくなる。ヘッダは電文の外側の情報なので、
 * XML の前に JSON として置く。
 */
export function formatEntryForView(entry: TelegramLogEntry): string {
  if (isXmlBody(entry.rawBody)) {
    const head = entry.rawHead !== undefined ? `${JSON.stringify(entry.rawHead, null, 2)}\n\n` : ''
    return head + entry.rawBody
  }
  return JSON.stringify(buildDownloadPayload(entry), null, 2)
}

/**
 * 単体ダウンロードの中身と拡張子。
 *
 * XML の電文はそのまま `.xml` で落とす（パーサや検証器へそのまま渡せる形にする）。
 * ヘッダは付けない —— 付けると XML 宣言が先頭でなくなり、XML として読めなくなる。
 * XML でない本文（復号に失敗した base64・P2PQuake の JSON）は、ヘッダごと `.json` で落とす。
 */
export function formatEntryForDownload(entry: TelegramLogEntry): { text: string; ext: 'xml' | 'json' } {
  if (isXmlBody(entry.rawBody)) return { text: entry.rawBody, ext: 'xml' }
  return { text: JSON.stringify(buildDownloadPayload(entry), null, 2), ext: 'json' }
}

function triggerDownload(text: string, filename: string) {
  const blob = new Blob([text], { type: filename.endsWith('.xml') ? 'application/xml' : 'application/json' })
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
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [originFilter, setOriginFilter] = useState<OriginFilter>('all')
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [copied, setCopied] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const filtered = telegramLog.filter(entry => matchesTelegramFilter(entry, sourceFilter, kindFilter, originFilter))

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
    const { text, ext } = formatEntryForDownload(entry)
    const ts = formatFileStamp(entry.receivedAt.getTime())
    const source = entry.source === 'dmdss' ? 'DMDSS' : 'P2PQuake'
    triggerDownload(text, `${ts}_${source}_${entry.headType}.${ext}`)
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
    }))
    const json = JSON.stringify(payload, null, 2)
    const ts = formatFileStamp(Date.now())
    triggerDownload(json, `${ts}_telegrams_${entries.length}件.json`)
  }, [telegramLog, selectedIds])

  const handleDownloadZip = useCallback(() => {
    const entries = telegramLog.filter(e => selectedIds.has(e.id))
    if (entries.length === 0) return
    const enc = new TextEncoder()
    const files: Record<string, Uint8Array> = {}
    const usedNames = new Map<string, number>()
    for (const e of entries) {
      const { text: body, ext } = formatEntryForDownload(e)
      const source = e.source === 'dmdss' ? 'DMDSS' : 'P2PQuake'
      const ts = formatFileStamp(e.receivedAt.getTime())
      const base = `${ts}_${source}_${e.headType}.${ext}`
      const count = usedNames.get(base) ?? 0
      usedNames.set(base, count + 1)
      const filename = count === 0 ? base : `${ts}_${source}_${e.headType}_${count + 1}.${ext}`
      files[filename] = enc.encode(body)
    }
    const zipped = zipSync(files)
    const ts = formatFileStamp(Date.now())
    const blob = new Blob([zipped], { type: 'application/zip' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${ts}_telegrams_${entries.length}件.zip`
    a.click()
    URL.revokeObjectURL(url)
  }, [telegramLog, selectedIds])

  const toggleExpand = useCallback((id: string) => {
    setExpandedId(prev => prev === id ? null : id)
  }, [])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <span className="text-sm font-medium text-white">
          電文ログ
          <span className="ml-2 text-xs text-secondary">({filtered.length} / {telegramLog.length})</span>
        </span>
        <button
          onClick={onClear}
          className="text-xs text-secondary hover:text-white transition-colors px-2 py-1 rounded-sm hover:bg-white/5"
        >
          クリア
        </button>
      </div>

      <div className="flex gap-2 px-4 py-2 border-b border-border shrink-0">
        {/* standard 版は P2PQuake のみを受信するためソースフィルタは意味を持たない（唯一の選択肢が P2PQuake になる）。
            DMDSS 版のみ dmdss/p2pquake の共存があり、フィルタとして機能する。 */}
        {isDmdss && (
          <select
            value={sourceFilter}
            onChange={e => setSourceFilter(e.target.value as SourceFilter)}
            className="flex-1 text-xs bg-card border border-border rounded-sm px-2 py-1 text-secondary focus:text-white focus:outline-hidden"
          >
            <option value="all">全ソース</option>
            <option value="dmdss">DMDSS</option>
            <option value="p2pquake">P2PQuake</option>
          </select>
        )}
        <select
          value={kindFilter}
          onChange={e => setKindFilter(readKindFilter(e.target.value))}
          className="flex-1 text-xs bg-card border border-border rounded-sm px-2 py-1 text-secondary focus:text-white focus:outline-hidden"
        >
          <option value="all">全種別</option>
          {KIND_OPTIONS.map(kind => (
            <option key={kind} value={kind}>{KIND_LABEL[kind]}</option>
          ))}
          <option value="filtered">スキップ</option>
          <option value="error">エラー</option>
        </select>
        <select
          value={originFilter}
          onChange={e => setOriginFilter(readOriginFilter(e.target.value))}
          className="flex-1 text-xs bg-card border border-border rounded-sm px-2 py-1 text-secondary focus:text-white focus:outline-hidden"
        >
          {ORIGIN_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>

      {selectedIds.size > 0 && (
        <div className="flex items-center justify-between px-4 py-2 border-b border-border shrink-0 bg-white/5">
          <span className="text-xs text-white">{selectedIds.size}件選択中</span>
          <div className="flex gap-1">
            <button
              onClick={handleDownloadSelected}
              className="text-xs text-white bg-white/15 hover:bg-white/25 transition-colors px-3 py-1 rounded-sm"
            >
              JSON
            </button>
            <button
              onClick={handleDownloadZip}
              className="text-xs text-white bg-white/15 hover:bg-white/25 transition-colors px-3 py-1 rounded-sm"
            >
              ZIP
            </button>
            <button
              onClick={clearSelection}
              className="text-xs text-secondary hover:text-white transition-colors px-2 py-1 rounded-sm hover:bg-white/5"
            >
              選択解除
            </button>
          </div>
        </div>
      )}

      {/* ここが実際のスクロール領域（ヘッダーは shrink-0 で固定）。overflow-y だけを auto に
          すると overflow-x も auto に格上げされ横スクロールしてしまうため、App.tsx の
          TAB_SCROLLER_CLASS と同じ指定で塞ぐ（祖先の指定は子の overflow 計算に効かない）。 */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden overscroll-x-none">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-sm text-secondary">
            {telegramLog.length === 0 ? '電文を待機中…' : 'フィルタ条件に一致なし'}
          </div>
        ) : (
          <>
            <div className="flex items-center px-4 py-1.5 border-b border-border bg-black/20">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={allFilteredSelected}
                  onChange={toggleSelectAll}
                  className="accent-white w-3 h-3"
                />
                <span className="text-xs text-secondary">全選択</span>
              </label>
            </div>
            <ul>
              {filtered.map(entry => {
                const badge = STATUS_BADGE[entry.status]
                const isExpanded = expandedId === entry.id
                const isSelected = selectedIds.has(entry.id)
                const typeLabel = headTypeLabel(entry.headType)
                const kind = telegramLogKindOf(entry)
                const kindLabel = kind ? KIND_LABEL[kind] : null
                const sourceLabel = entry.source === 'dmdss' ? 'DM' : 'P2'
                const originBadge = originBadgeOf(entry.origin)
                const operationBadge = operationBadgeOf(entry)

                return (
                  <li key={entry.id} className={`border-b border-border last:border-b-0 ${isSelected ? 'bg-white/5' : ''}`}>
                    <div className="flex items-start">
                      <label
                        className="flex items-center px-3 py-3 cursor-pointer shrink-0"
                        onClick={e => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(entry.id)}
                          className="accent-white w-3 h-3"
                        />
                      </label>
                      <div className="flex-1 min-w-0">
                        <button
                          onClick={() => toggleExpand(entry.id)}
                          className="w-full text-left px-2 py-2 hover:bg-white/5 transition-colors"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className={`text-xs font-mono shrink-0 w-3 ${badge.className}`}>{badge.label}</span>
                            {/* 日時として読めなければ語を出す。空欄にすると列が詰まって
                                隣の値が時刻の位置に見える。 */}
                            <span className="text-xs text-secondary font-mono shrink-0">{formatTime(entry.receivedAt) ?? '時刻不明'}</span>
                            <span className="text-xs font-mono bg-white/10 rounded-sm px-1 shrink-0 text-secondary">{sourceLabel}</span>
                            {/* 経路の印。ライブには出さない（既定の経路なので、付けると全行が賑やかになる）。
                                発信元（DM/P2）とは別の軸なので、色を変えて並べる。 */}
                            {originBadge && (
                              <span className="text-xs font-mono bg-amber-400/20 text-amber-200 rounded-sm px-1 shrink-0">{originBadge}</span>
                            )}
                            <span className="text-xs font-mono text-white shrink-0">{entry.headType}</span>
                            {/* 訓練・試験の印。種別名は消さずに後ろへ並べる（何の訓練かが分からなくなるため）。
                                経路の印とは別の軸なので、色も分ける。 */}
                            {operationBadge && (
                              <span className={`text-xs rounded-sm px-1 shrink-0 ${operationBadge.className}`}>{operationBadge.label}</span>
                            )}
                            <span className="text-xs text-secondary truncate">
                              {(kindLabel ? `${kindLabel} · ` : '') + typeLabel}
                            </span>
                          </div>
                          {entry.errorMessage && (
                            <div className="text-xs text-red-400 mt-0.5 pl-5 truncate">{entry.errorMessage}</div>
                          )}
                        </button>

                        {isExpanded && (
                          <div className="px-2 pb-3">
                            <div className="flex justify-end gap-1 mb-1">
                              <button
                                onClick={e => { e.stopPropagation(); handleDownload(entry) }}
                                className="text-xs text-secondary hover:text-white transition-colors px-2 py-0.5 rounded-sm hover:bg-white/5"
                              >
                                ダウンロード
                              </button>
                              <button
                                onClick={e => { e.stopPropagation(); handleCopy(entry) }}
                                className="text-xs text-secondary hover:text-white transition-colors px-2 py-0.5 rounded-sm hover:bg-white/5"
                              >
                                {copied === entry.id ? 'コピー済み' : 'コピー'}
                              </button>
                            </div>
                            <pre className="text-xs font-mono text-secondary bg-black/30 rounded-sm p-2 overflow-x-auto max-h-96 whitespace-pre-wrap break-all">
                              {formatEntryForView(entry)}
                            </pre>
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}, skipWhileHidden)
