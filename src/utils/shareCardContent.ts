import type { EEWAlert, JMAQuake, JMATsunami } from '../types/earthquake'
import type { MapMode } from '../components/Map/mapTypes'
import { computeDisplayEEWLevel, eewKindLabel, eewMaxScale, eewMaxScaleInfo, isProvisionalHypocenter } from './eew'
import { QUAKE_ARRIVAL_TIME_LABEL, formatDateTime, formatQuakeDateTime, formatTimeMin, formatDepth, formatMagnitude, formatMagnitudeCondition, formatMagnitudeWithCondition, formatTsunamiGrade, hasDepth, hasHypocenterFacts } from './formatters'
import { getIntensityColor, getIntensityLabelWithOrAbove, getIntensityLabelWithApproxAbove, isValidIntensityScale } from './intensity'
import { isMaxScaleUnreceived } from './quakePoints'
import { ATTRIBUTION_SOURCES, attributionLine, EEW_NOTICE, type ShareCardHeader } from './shareCard'
import { isTsunamiForecastOnly, sourceEarthquakeTime, tsunamiOverallGrade } from './tsunami'
import { hasKnownEpicenter } from './geo'
import { kyoshinDetectionScaleLabel } from './kyoshinIntensity'

// 共有カードの見出しと出典行を、いま地図が見せているものから組み立てる。
//
// 画面の状態に触れない純粋な関数として置いてある。撮影（captureMap.ts）と合成（shareCard.ts）は
// 地図とキャンバスに依存するが、「何を書くか」の判断はそのどちらにも依存しないため。

/** 見出しの各項目を並べるときの区切り。全角の空きで、読点より軽く見せる。 */
const SUBTITLE_SEPARATOR = '　'

export interface ShareCardContentInput {
  mode: MapMode
  quake: JMAQuake | null
  tsunamis: JMATsunami[]
  eews: EEWAlert[]
  /**
   * 地図に描いているか（設定の値をそのまま渡す）。
   * **描いているものだけを出典に挙げる**ため、表示の設定が出典の中身を決める。
   * **表示を切り替えられるレイヤーを足したら、ここへも足すこと。**
   */
  showBathymetry: boolean
  showActiveFaults: boolean
  showPlateBoundaries: boolean
  /** 公開観測点の三角の印を描いているか（下部に公開観測点の波形を出している間。モードを問わない）。 */
  showPublicStations: boolean
  /**
   * 強震モニタの揺れ検知（緊急地震速報が無いときのリアルタイム震度の見出しに使う）。検知していなければ null。
   * `maxIndex` は推定最大震度の強震モニタの段（ブラウザ通知の本文と同じ値。`useKyoshinAlerts` の `effectiveKyoshinMaxIndex`）。
   */
  kyoshinDetection: { state: 'confirmed' | 'candidate'; maxIndex: number } | null
}

export interface ShareCardContent {
  header: ShareCardHeader
  notices: string[]
  /** 共有先へ画像と一緒に渡す本文。 */
  shareText: string
  /** 保存名に使う語。日本語のファイル名を扱えない環境があるので ASCII に限る。 */
  filenameLabel: string
}

/**
 * 見出し・出典行を組み立てる。
 *
 * 注意文の要否は**モードで決めない**。緊急地震速報の予報円と震源は、地図のモードに関わらず
 * 描かれる（`JapanMapGL` の `PsWaveGL` / `EewEpicentersGL` はどのモードでも表示する）。
 * 「地震モードだから緊急地震速報は写らない」は成り立たないため、発報中かどうかで判断する。
 */
export function buildShareCardContent(
  {
    mode,
    quake,
    tsunamis,
    eews,
    showBathymetry,
    showActiveFaults,
    showPlateBoundaries,
    showPublicStations,
    kyoshinDetection,
  }: ShareCardContentInput,
  appUrl: string,
): ShareCardContent {
  const liveEews = eews.filter((e) => !e.cancelled && !e.expired)
  // **描いていないものを出典に挙げない**——読み手が画像の中に探しても見つからない。逆に
  // 描いているのに挙げないのは帰属表示の欠落になる。判定は表示の設定とモードの両方を見る。
  //
  // 気象庁のデータ（境界線・区域・電文）はどのモードでも必ず写るので条件を持たない。
  const derived: string[] = [ATTRIBUTION_SOURCES.jma]
  const asIs: string[] = []
  if (showBathymetry) asIs.push(ATTRIBUTION_SOURCES.bathymetry)
  // 活断層は地震／リアルタイム震度／震源カタログモードで、プレート境界はそれに津波モードを加えて描かれる（`JapanMapGL` の
  // `showOverlayLines`・`showPlateLines`。**式をここと揃える**）。設定が入りでも、描かないモードの画像には写らない。
  // 震源カタログモードも描いているのに挙げていなかった（PB2002 は帰属表示が利用条件。2026-10-24 ユーザー選択「一緒に直す
  // (Recommended)」）。プレート境界を津波モードでも描くのは 2026-10-22 ユーザー選択「プレート境界だけ出す (Recommended)」。
  const showsOverlayLines = mode === 'quake' || mode === 'kyoshin' || mode === 'catalog'
  const showsPlateBoundaryLines = showsOverlayLines || mode === 'tsunami'
  if (showsOverlayLines && showActiveFaults) derived.push(ATTRIBUTION_SOURCES.activeFaults)
  if (showsPlateBoundaryLines && showPlateBoundaries) derived.push(ATTRIBUTION_SOURCES.plateBoundaries)
  // 公開観測点の印（位置と番号）。座標は EarthScope の観測点の目録から作った表で、加工の側に入る
  // （`docs/public-waveform-design.md` §0。CC BY 4.0 の「変更を加えた旨」もこの句が担う）。
  if (showPublicStations) derived.push(ATTRIBUTION_SOURCES.earthScope)
  const notices = [attributionLine({ derived, asIs })]
  if (liveEews.length > 0) notices.unshift(EEW_NOTICE)

  const base =
    mode === 'tsunami' ? tsunamiContent(tsunamis) : mode === 'kyoshin' ? kyoshinContent(liveEews, kyoshinDetection) : quakeContent(quake)
  return { ...base, notices, shareText: buildShareText(base.header, appUrl) }
}

/**
 * 共有先の本文を組み立てる。**材料は見出しと同じ**——画像と本文で違うことを述べないため。
 *
 * **注意文は入れない。** 緊急地震速報の注意文（EEW_NOTICE）は画像へ焼いてあり、本文と画像は
 * 共有シートで一緒に渡る。本文にも重ねると X の全角 140 字にほぼ届き、震源名が長ければ超える
 * ——利用者が削ることになり、削られた結果として注意文そのものが落ちうる。
 */
function buildShareText(header: ShareCardHeader, appUrl: string): string {
  const lines = [[header.title, header.subtitle].filter(Boolean).join(SUBTITLE_SEPARATOR)]
  if (header.meta) lines.push(header.meta)
  lines.push(appUrl)
  return lines.join('\n')
}

type ContentWithoutNotices = Omit<ShareCardContent, 'notices' | 'shareText'>

/**
 * 共有カードに焼く規模。**規模が不明でも「M不明」と焼く**（2026-10-23 ユーザー選択「「不明」も焼く」。推した「今のまま」ではない。
 * 語は 2026-10-24 ユーザー選択「この語で (Recommended)」）。以前は項目ごと落としていたが、落とすと「規模を伝えていない」のか
 * 「規模が判らない」のかが画像から読めない。整形は画面と同じ部品で、説明が無いときの「不明」だけを「M不明」へ置く
 * （「M」を付けないと、何が不明なのか読めない）。「Ｍ８を超える巨大地震」のような説明はそのまま出す。
 */
function shareMagnitudeText(magnitude: number, condition: string | undefined, magnitudeType: string | undefined): string {
  const text = formatMagnitudeWithCondition(magnitude, condition, magnitudeType)
  return text === '不明' ? 'M不明' : text
}

/** 共有カードに焼く深さ。判らなければ「深さ 不明」（規模と同じ理由で落とさない）。 */
function shareDepthText(depth: number | undefined, depthAtLeast: boolean | undefined): string {
  return depth !== undefined && hasDepth(depth) ? `深さ ${formatDepth(depth, depthAtLeast === true)}` : '深さ 不明'
}

function quakeContent(quake: JMAQuake | null): ContentWithoutNotices {
  if (!quake) return { header: { title: '地震情報' }, filenameLabel: 'quake' }
  const { hypocenter, maxScale, time } = quake.earthquake
  // 震度を伝えない電文（震源情報など）は maxScale がセンチネル（-1）で届く。
  // 「最大震度 不明」と書くくらいなら見出しを種別名に落とす。
  const knownScale = isValidIntensityScale(maxScale) && maxScale >= 0
  const parts = [hypocenter.name]
  // 規模・深さが不明でも「M不明」「深さ 不明」と焼く（→ `shareMagnitudeText`）。**震源要素をまったく伝えていない電文
  // （震度速報。座標がセンチネルで規模・深さも無い）では足さない** —— その電文は規模・深さを「不明」と言っているのではなく、
  // まだ伝えていない。**位置だけが判らない電文（震源要素不明）では足す** —— 判っている規模・深さを位置と一緒に伏せない
  // （判定は地震カードと同じ `hasHypocenterFacts`）。
  if (hasKnownEpicenter(hypocenter.latitude, hypocenter.longitude) || hasHypocenterFacts(hypocenter)) {
    parts.push(shareMagnitudeText(hypocenter.magnitude, hypocenter.magnitudeCondition, hypocenter.magnitudeType))
    parts.push(shareDepthText(hypocenter.depth, hypocenter.depthAtLeast))
  }
  // 日時として読めない時刻は欄ごと落とす。**画像は訂正できない**ので、「地震発現時刻 null」のような
  // 壊れた文字列を焼き付けるくらいなら出さない（規模・深さの「不明」を落とすのと同じ考え方）。
  //
  // **秒は出さない**（電文に秒が無い。2026-10-22 ユーザー承認「5-A 秒と発生を落とす」）。
  // 名前は値の公式名「地震発現時刻」で、「ごろ」は付けない（2026-10-23 ユーザー選択「公式名を付ける (Recommended)」）。
  const timeText = formatQuakeDateTime(time)
  return {
    header: {
      // 未入電なら「以上」を付ける。**画像は訂正できない**ので、下限だけが確定した値を
      // 断定形で焼き付けない（仮定震源要素で規模を出さないのと同じ理由。→ share-card-spec.md）。
      title: knownScale
        ? `最大震度 ${getIntensityLabelWithOrAbove(maxScale, isMaxScaleUnreceived(maxScale, quake.points))}`
        : '地震情報',
      titleColor: knownScale ? getIntensityColor(maxScale) : undefined,
      subtitle: parts.join(SUBTITLE_SEPARATOR),
      meta: timeText ? `${QUAKE_ARRIVAL_TIME_LABEL} ${timeText}` : undefined,
    },
    filenameLabel: 'quake',
  }
}

function tsunamiContent(tsunamis: JMATsunami[]): ContentWithoutNotices {
  // **解除表示中（`cancelledAt`）も外す。** 等級の判定（`tsunamiOverallGrade`・`isTsunamiForecastOnly`）は
  // どちらも外すので、ここで残すと見出しは発表中の津波、区域数・震源・時刻は解除された津波、と出どころが割れる。
  const live = tsunamis.filter((t) => !t.cancelled && !t.cancelledAt)
  // **予報だけの津波も等級を名乗る**（2026-10-21 ユーザー選択「おすすめで」）。`tsunamiOverallGrade` は
  // 予報を数えないので、それだけで決めると予報の画像は「津波情報」の一語になり、震源も区域も載らない。
  // 等級の読めない区域が混じれば予報と言い切らず（`isTsunamiForecastOnly`）、従来どおり「津波情報」に落とす。
  const grade = tsunamiOverallGrade(live) ?? (isTsunamiForecastOnly(live) ? 'Forecast' : null)
  if (!grade) return { header: { title: '津波情報' }, filenameLabel: 'tsunami' }
  // **見出しの文字色は付けない**（既定の白。2026-10-21 ユーザー選択「おすすめで」）。`formatTsunamiGrade` の
  // `color` は等級の地の色（`bg`）に載せる文字の色で、注意報では黒になる —— 暗い見出し帯の上では読めない。
  // 地の色を文字色にすると、大津波警報の紫がこの帯の上でコントラスト比 2.5 ほどしか取れない。
  const { text } = formatTsunamiGrade(grade)
  const areaCount = new Set(live.flatMap((t) => t.areas.map((a) => a.name))).size
  // 原因地震が複数あれば（EventID に番号が足された津波）全件を「／」で並べる。長いと折り返す
  // （2026-10-15 ユーザー承認「全件を並べる」。2026-10-19 ユーザー選択「全件を並べる（今の形） (推奨)」で維持）。同じ地震を複数の報が運ぶので、震源名・規模・地震発現時刻の組で重ねる。
  // **震源名と規模が同じ別の地震には地震発現時刻を添える**（2026-10-21 ユーザー選択「B は案1」。全期間の津波電文 651 通のうち
  // 1 通。2023-12-03 の VTSE41 がフィリピン付近の M7.0 を 2 つ載せた）。添えないと同じ文が 2 つ並ぶか、1 つに畳まれて地震が消える。
  const collected: { text: string; time: string | undefined; ms: number }[] = []
  for (const source of live.flatMap((t) => t.sourceEarthquakes ?? [])) {
    // 規模が数値で無いときは説明を出す（「Ｍ８を超える巨大地震」）。落とすと、**最も重大な
    // 地震ほど震源名だけの薄い画像になる**。
    // 規模の記号は電文の種別（`Mj7.6`）。津波カードの原因地震の行・地図の吹き出しと揃える
    // （2026-10-29 ユーザー承認「吹き出しと共有カードも (Recommended)」）。揃えないと、同じ地震が地震の共有カードでは
    // `Mj`、津波の共有カードでは `M` と割れる。
    const magnitudeText = source.magnitude != null
      ? `　${formatMagnitude(source.magnitude, source.magnitudeType)}`
      // 地震側と同じ述語を通す。素通しにすると同じ電文由来の同じ事実が、地震の共有カードでは
      // 半角・津波の共有カードでは全角、と表記が割れる。どちらも無ければ「M不明」（地震・EEW と揃える）
      : `　${source.magnitudeCondition ? formatMagnitudeCondition(source.magnitudeCondition) : 'M不明'}`
    // **深さも焼く**（2026-10-23 ユーザー選択「どちらも出す (Recommended)」。全期間で 439 件中 266 件が深さを持つ）。
    // 判らなければ「深さ 不明」（地震・EEW と揃える）。
    const text = `${source.hypocenterName}${magnitudeText}　${shareDepthText(source.depth, source.depthAtLeast)}`
    const time = sourceEarthquakeTime(source)
    // 時刻は瞬間で比べる（同じ時刻でも表記が報ごとに違いうる）。
    const ms = time ? Date.parse(time) : NaN
    if (!collected.some((e) => e.text === text && (e.ms === ms || (Number.isNaN(e.ms) && Number.isNaN(ms))))) {
      collected.push({ text, time, ms })
    }
  }
  // 時刻を読めない地震は、同じ文で時刻の読める地震があればそちらと重ねる（別の地震と決められず、並べても見分けが付かない）。
  // 届いた順によらないよう、集め終えてから落とす。
  const sourceEntries = collected.filter((e) =>
    !Number.isNaN(e.ms) || !collected.some((o) => o.text === e.text && !Number.isNaN(o.ms)))
  const sourceTexts = sourceEntries.map(({ text, time }) => {
    if (sourceEntries.filter((e) => e.text === text).length < 2) return text
    const hm = time ? formatTimeMin(time) : null
    return hm ? `${text}（${QUAKE_ARRIVAL_TIME_LABEL} ${hm}）` : text
  })
  const parts: string[] = []
  if (sourceTexts.length > 0) parts.push(sourceTexts.join(' ／ '))
  if (areaCount > 0) parts.push(`${areaCount} 区域`)
  const issued = live[0]?.issue.time ?? live[0]?.time
  // 日時として読めない発表時刻は、時刻を持たない電文と同じく欄ごと落とす。
  const issuedText = issued ? formatDateTime(issued) : null
  return {
    header: {
      title: text,
      subtitle: parts.join(SUBTITLE_SEPARATOR),
      meta: issuedText ? `${issuedText} 発表` : undefined,
    },
    filenameLabel: 'tsunami',
  }
}

function kyoshinContent(liveEews: EEWAlert[], detection: ShareCardContentInput['kyoshinDetection']): ContentWithoutNotices {
  const eew = pickMostSevereEew(liveEews)
  if (!eew) return detectionContent(detection)
  // **複数の緊急地震速報が発表中なら、副見出しに全件を並べる**（2026-10-23 ユーザー選択「全件を並べる」。全期間で同時発表の組
  // 108・200 地震。並べ方は 2026-10-24 ユーザー選択「副見出しで折り返す (Recommended)」）。見出しの区分・色と右上の報番号・
  // 発生時刻は最も深刻な 1 件のまま。並びは深刻な順（見出しの 1 件が先頭）。
  const subtitle = sortEewsBySeverity(liveEews).map(eewSubtitle).join(' ／ ')
  const info = eewMaxScaleInfo(eew)
  const knownScale = isValidIntensityScale(info.scale) && info.scale >= 0
  const serial = eew.issue?.serial
  // 日時として読めない発生時刻は落とすが、**報番号は残す**（別の事実なので巻き込まない）。
  // 両方とも無ければ欄ごと出さない。
  // **値が無いときは整形を呼ばない**（「非常に強い揺れを検知」の報は発生時刻を持たない）。呼ぶと
  // 「読めない値が来た」として記録され、電文が時刻を持たないことと区別が付かなくなる（`RealtimeTab` と同じ）。
  const originText = eew.earthquake.originTime ? formatDateTime(eew.earthquake.originTime) : null
  const metaParts = [serial ? `第${serial}報` : '', originText ? `${originText} 発生` : ''].filter(Boolean)
  return {
    header: {
      title: eewKindLabel(computeDisplayEEWLevel(eew)),
      titleColor: knownScale ? getIntensityColor(info.scale) : undefined,
      subtitle,
      meta: metaParts.length > 0 ? metaParts.join('　') : undefined,
    },
    filenameLabel: 'eew',
  }
}

/**
 * 緊急地震速報が無いときのリアルタイム震度の見出し。**揺れを検知していれば、検知と推定最大震度を出す**（2026-10-23 ユーザー選択
 * 「揺れ検知中は推定最大震度を出す (Recommended)」。文面は 2026-10-24 ユーザー選択「この文面で (Recommended)」）。見出しは
 * ウィンドウタイトルと同じ「揺れ検知」／「揺れの可能性」、副見出しはブラウザ通知の本文と同じ「推定最大震度 5弱（強震モニタ）」。
 * 推定最大震度の呼び名は通知と同じ（`kyoshinDetectionScaleLabel`）。震度0 未満は「0以下」と焼く（2026-10-29 ユーザー選択
 * 「「0以下」を焼く (Recommended)」。測った値で、不明ではない）。欠測なら副見出しは出さない（通知は「?」を出すが、画像は訂正できないので焼かない）。
 */
function detectionContent(detection: ShareCardContentInput['kyoshinDetection']): ContentWithoutNotices {
  if (!detection) return { header: { title: 'リアルタイム震度' }, filenameLabel: 'realtime' }
  const label = kyoshinDetectionScaleLabel(detection.maxIndex)
  return {
    header: {
      title: detection.state === 'confirmed' ? '揺れ検知' : '揺れの可能性',
      subtitle: label ? `推定最大震度 ${label}（強震モニタ）` : undefined,
    },
    filenameLabel: 'realtime',
  }
}

/**
 * 緊急地震速報 1 件ぶんの副見出し（震源名・規模・深さ・予想最大震度）。
 *
 * **仮定震源要素（震源未確定）・「非常に強い揺れを検知」の報では規模も深さも出さない**（`isProvisionalHypocenter`）。
 * 電文には数値が入っているが、地震学的に意味を持たない仮の値。画面でも隠している（`RealtimeTab`）ので、
 * 画像にも焼かない——共有された画像は後から訂正できない（画面で隠すことは 2026-10-21 ユーザー選択「今のまま記録する
 * (Recommended)」。共有カードも同じ判断で揃える）。
 * **`condition` を参照する箇所は eew-spec.md §5 に列挙する決まり。足したらそちらも更新すること。**
 * **深さも焼く**（2026-10-23 ユーザー選択「どちらも出す (Recommended)」。全期間 45,079 報すべてが深さを持つ）。
 */
function eewSubtitle(eew: EEWAlert): string {
  const { hypocenter } = eew.earthquake
  const info = eewMaxScaleInfo(eew)
  const knownScale = isValidIntensityScale(info.scale) && info.scale >= 0
  // 震央地名が空の報は、画面のカード・地図の吹き出しと同じ「震源調査中」を名前の位置に置く
  // （2026-10-22 ユーザー承認「「震源調査中」を入れる」）
  const parts = [hypocenter.name || '震源調査中']
  if (!isProvisionalHypocenter(eew)) {
    // 数値が無くても「Ｍ８を超える巨大地震」は落とさない（地震情報の共有カードと同じ。2026-10-22 ユーザー承認
    // 「吹き出しと共有カードも揃える (Recommended)」）。不明なら「M不明」
    parts.push(shareMagnitudeText(hypocenter.magnitude, hypocenter.magnitudeCondition, hypocenter.magnitudeType))
    parts.push(shareDepthText(hypocenter.depth, hypocenter.depthAtLeast))
  }
  if (knownScale) parts.push(`予想最大震度 ${getIntensityLabelWithApproxAbove(info.scale, info.orAbove)}`)
  return parts.join(SUBTITLE_SEPARATOR)
}

/** 深刻な順に並べる（区分 → 予想最大震度。同じなら受け取った順）。見出しの 1 件（`pickMostSevereEew`）が先頭に来る。 */
function sortEewsBySeverity(eews: EEWAlert[]): EEWAlert[] {
  return eews
    .map((eew, i) => ({ eew, i, level: computeDisplayEEWLevel(eew), scale: eewMaxScale(eew) }))
    .sort((a, b) => b.level - a.level || b.scale - a.scale || a.i - b.i)
    .map(e => e.eew)
}

/**
 * 複数発報しているときに見出しへ載せる 1 件を選ぶ。
 *
 * **受け取った順で先頭を採らないこと。** 並びは発報を受けた順で深刻さとは無関係なので、
 * 連続する余震や離れた 2 地域でほぼ同時に起きた場合に、弱い方を見出しにしてしまう。
 * 区分（警報級か）を先に見て、同じなら予想最大震度で決める。
 */
function pickMostSevereEew(eews: EEWAlert[]): EEWAlert | null {
  let best: { eew: EEWAlert; level: number; scale: number } | null = null
  for (const eew of eews) {
    const level = computeDisplayEEWLevel(eew)
    const scale = eewMaxScale(eew)
    if (!best || level > best.level || (level === best.level && scale > best.scale)) best = { eew, level, scale }
  }
  return best?.eew ?? null
}
