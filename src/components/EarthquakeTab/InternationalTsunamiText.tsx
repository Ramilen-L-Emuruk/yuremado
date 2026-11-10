// 国際津波関連情報（英文）の本文。初めから日本語訳を出し、「原文」と切り替える
// （2026-11-08 ユーザー発言「切り替えだけどせっかくなんだからデフォ翻訳でいいんじゃない」、同日の選択「この形で決める (Recommended)」）。
// 訳せなかった行は英語のまま「（未訳）」を付けて残す。訳は `utils/wepa60Translate.ts`。
import { useLocale, useMessages } from '../../i18n/I18nProvider'
import { useEffect, useMemo, useState } from 'react'
import type { JMAInternationalTsunami } from '../../types/earthquake'
import { translateWepa60 } from '../../utils/wepa60Translate'
import { getCachedWepa60RegionNames, loadWepa60RegionNames, nearestTsunamiStation, type Wepa60RegionNames } from '../../utils/wepa60RegionNames'
import { loadTsunamiObsCoords, type TsunamiObsCoords } from '../../utils/tsunamiObsCoords'
import { log } from '../../utils/logger'

interface Props {
  readonly report: JMAInternationalTsunami
  /** 英文が付いた地震カードの気象庁の震央地名（英文だけのカード・取り消されたカードでは渡さない） */
  readonly quakeName?: string
  /**
   * 原文から始めるか。地震カードは日本語訳から（2026-11-08 ユーザー発言「デフォ翻訳でいいんじゃない」）。特別な情報の帯の通信試験は
   * 訳の対象外なので原文から（2026-11-09 ユーザー選択「帯に出す (Recommended)」の説明「開くと英文の原文（日本語訳の対象外なら原文のまま）」）
   */
  readonly startWithOriginal: boolean
}

export function InternationalTsunamiText({ report, quakeName, startWithOriginal }: Props) {
  const q = useMessages().quake
  // 日本語訳は日本語の画面にだけ出す。ほかの言語では切り替えを出さず原文だけを出す（2026-11-10 ユーザー選択「原文だけ出す (Recommended)」）
  const japanese = useLocale() === 'ja'
  const [showOriginal, setShowOriginal] = useState(startWithOriginal)
  // 訳に使う表は、訳を初めて見るときに取る。原文から始めた欄（帯の通信試験）では「日本語訳」を押すまで取らない。
  // 言語は欄を開いたまま変わりうるので、言語は状態に焼き込まず、日本語の画面のときだけ取る形で導く
  // （焼き込むと、ほかの言語で開いてから日本語へ戻したとき「日本語訳」の札が選ばれたまま原文が出続ける）
  const [translationRequested, setTranslationRequested] = useState(!startWithOriginal)
  const wantsTranslation = japanese && translationRequested
  // 取得済みなら最初の描画から訳を出す（開き直すたびに原文→訳と描き替えない）
  const [regionNames, setRegionNames] = useState<Wepa60RegionNames | null>(getCachedWepa60RegionNames)
  const [stations, setStations] = useState<TsunamiObsCoords | null>(null)

  useEffect(() => {
    if (!wantsTranslation) return
    let alive = true
    if (getCachedWepa60RegionNames() === null) loadWepa60RegionNames().then(d => { if (alive) setRegionNames(d) }).catch((err) => {
      // 表が無くても訳は出す（震央の地名だけ英語のまま未訳になる）
      log.warn('[data] wepa60-region-names 取得失敗（震央の地名は英語のまま）', err)
      if (alive) setRegionNames({})
    })
    // 観測点の座標は地図も読む表で、地図の側が取り直しを持つ。ここでは待たずに訳を出し、届いたら観測点の名前を当て直す
    loadTsunamiObsCoords().then(d => { if (alive) setStations(d) }).catch((err) => {
      log.warn('[data] tsunami-obs-coords 取得失敗（観測の表の日本の地点は英語のまま）', err)
    })
    return () => { alive = false }
  }, [wantsTranslation])

  const translated = useMemo(() => {
    if (!wantsTranslation || regionNames === null) return null
    return translateWepa60(report.text, report.time, {
      regionNames,
      ...(quakeName && { quakeName }),
      tsunamiStationNameAt: (lat, lon) => (stations ? nearestTsunamiStation(stations, lat, lon) : undefined),
    })
  }, [report.text, report.time, quakeName, regionNames, stations, wantsTranslation])

  const tab = (label: string, active: boolean, onClick: () => void) => (
    <button
      type="button"
      aria-pressed={active}
      onClick={(e) => { e.stopPropagation(); onClick() }}
      className={`rounded px-2 py-0.5 ${active ? 'bg-white/15 text-white' : 'text-secondary hover:text-white'}`}
    >{label}</button>
  )

  return (
    <div className="pb-2">
      {japanese && (
        <div className="mb-1 flex gap-1">
          {tab(q.intlTranslation, !showOriginal, () => { setShowOriginal(false); setTranslationRequested(true) })}
          {tab(q.intlOriginal, showOriginal, () => setShowOriginal(true))}
        </div>
      )}
      {!japanese || showOriginal || translated === null ? (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono leading-relaxed">{report.text}</pre>
      ) : (
        <div className="whitespace-pre-wrap break-words leading-relaxed">
          {translated.map((line, i) => line.untranslated
            ? <div key={i} className="font-mono"><span className="mr-1 font-sans text-secondary">{q.intlUntranslated}</span>{line.text}</div>
            : <div key={i}>{line.text === '' ? ' ' : line.text}</div>)}
        </div>
      )}
    </div>
  )
}
