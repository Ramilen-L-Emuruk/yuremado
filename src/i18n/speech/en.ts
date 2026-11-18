import type { SpeechWordsInProgress } from '../speechWords'
import type { UnreceivedUnit } from '../../utils/quakePoints'
import { en } from '../messages/en'
import { clockTime, englishOrdinal, firstWaveKindIn, intensityIn, markHeightOrMore, regionNameIn, reportNameIn, showsApproxAbove, tsunamiEvacuationIn, tsunamiGradeNamesIn, tsunamiHeightIn } from './shared'

const intensity = intensityIn(en)
const lead = {
  forecast: 'Ground motion forecast.',
  warning: 'Earthquake Early Warning.',
  hypocenterUpdate: 'Hypocenter updated.',
}
/** 未入電の単位（単数・複数）。「件」は観測点と地域が混ざったとき */
const UNIT: Readonly<Record<UnreceivedUnit, readonly [string, string]>> = {
  '地点': ['station', 'stations'],
  '地域': ['area', 'areas'],
  '件': ['place', 'places'],
}
const unitOf = (count: number, unit: UnreceivedUnit) => UNIT[unit][count === 1 ? 0 : 1]
const atLeastOf = (atLeast: string) => (atLeast ? ` ${atLeast}` : '')
/** 距離（1 だけ単数） */
const kilometers = (km: number) => `${km} ${km === 1 ? 'kilometer' : 'kilometers'}`
const ELSEWHERE = "JMA's original text is in the Telegram Log."
const notReceived = 'but the intensity has not been received.'
const fiveLowerOrHigher = `${intensity(45)} or higher`
/** 波高（1 だけ単数） */
const meters = (value: string) => `${value} ${value === '1' ? 'meter' : 'meters'}`
/** 上限で読まなかった観測点の数（1 だけ単数） */
const otherSites = (n: number) => `${n} other ${n === 1 ? 'site' : 'sites'}`
/** 原因地震の呼び方（1 つ目の地震か、2 つ目以降の地震か） */
const theQuake = (first: boolean) => (first ? 'this earthquake' : 'the other earthquake')
/** 津波の観測点の句の述語の語幹（更新・観測） */
const STEM_UPDATED = 'updated to'
const STEM_OBSERVED = 'observed'

/**
 * 読み上げの文の語表（英語。訳し終えた区分だけ → `SpeechWordsInProgress`）。
 * 文面は 2026-11-17 ユーザー選択「この案で入れる (Recommended)」の表。気象庁「緊急地震速報・津波警報の多言語辞書」の定型文
 * （Watch out for strong tremors など）と画面の辞書の訳にそろえた。震央・対象地方・観測した地名は「:」で示す（前置詞が地名の訳とぶつかるため）。
 *
 * 地震情報の断片は区切りを挟まずにつなぐので、文の終わりになる語は後ろに空白を 1 つ持つ
 */
export const enSpeech: SpeechWordsInProgress = {
  common: {
    listSep: ', ',
    sentenceSep: ' ',
    intensity,
    time: clockTime,
    telegramTextElsewhere: ELSEWHERE,
    day: (d) => `the ${englishOrdinal(d)}`,
    dayTime: (d, hour, minute) => `${clockTime(hour, minute)} on the ${englishOrdinal(d)}`,
    cancelReasonLead: (infoName) => `Here is the reason the ${infoName} was cancelled. `,
    issued: (label) => `${label}. `,
    updated: (label) => `The ${label} has been updated. `,
    atAround: (time) => `Around ${time}, `,
    also: 'Also, ',
    dayHour: (d, hour) => `${hour}:00 on the ${englishOrdinal(d)}`,
    telegramTextLead: (label) => `Here is JMA's text on the ${label}. `,
  },
  eew: {
    upgrade: 'Upgraded to an Earthquake Early Warning.',
    warningRegionsClosing: 'watch out for strong tremors',
    lpgmClassZero: 'Maximum forecast long-period ground motion class 0.',
    cancelledAt: (time) => `The Earthquake Early Warning issued at ${time} has been cancelled.`,
    cancelled: 'The Earthquake Early Warning has been cancelled.',
    lead,
    leadAlone: (l) => l,
    leadWithEpicenter: (l, epicenter) => `${l} Earthquake: ${epicenter}.`,
    warningRegionName: regionNameIn(en),
    warningRegionsAdditional: (names, closing) => `Also ${names}: ${closing}.`,
    warningRegions: (names, closing) => `${names}: ${closing}.`,
    noForecast: {
      singleStation: 'No intensity forecast: single-station.',
      deep: 'No intensity forecast: deep earthquake.',
      belowScale1: 'Maximum forecast intensity 0.',
      unknown: 'No intensity forecast.',
    },
    maxScale: (scale, orAbove) => {
      const label = intensity(scale)
      return `Maximum forecast intensity ${showsApproxAbove(scale, orAbove) ? `about ${label} or higher` : label}.`
    },
    maxLpgmClass: (cls, over) => `Maximum forecast long-period ground motion class ${over ? `about ${cls} or higher` : cls}.`,
  },
  quake: {
    regionSep: '; ',
    // 階級ごとに文を切る（2026-11-17 ユーザー選択「階級ごとに文を切る (Recommended)」）。初めて観測した地域の文は次の文にも「Newly」（同日ユーザー選択「文ごとに繰り返す (Recommended)」）
    intensityGroupSep: (fresh) => (fresh ? '. Newly, ' : '. '),
    unreceivedCountOnly: (count, unit) => `At ${count} ${unitOf(count, unit)}, intensity ${fiveLowerOrHigher} is estimated, ${notReceived} `,
    unreceivedOmitted: (count, unit) => `, and ${count} other ${unitOf(count, unit)}`,
    unreceivedTailPartial: `: intensity ${fiveLowerOrHigher} is estimated at some stations, ${notReceived} `,
    unreceivedTail: `: estimated at intensity ${fiveLowerOrHigher}, ${notReceived} `,
    intensityLead: (isMax, i) => `${isMax ? 'Maximum intensity' : 'Intensity'} ${i} observed: `,
    regionsOmitted: (count) => `, and ${count} other ${count === 1 ? 'area' : 'areas'}`,
    observedTail: '. ',
    fresh: 'Newly, ',
    freshAfterUpgraded: 'Also newly, ',
    magnitudeOf: (magnitude) => `of magnitude ${magnitude}`,
    magnitudeConditionPredicate: {
      'Ｍ不明': 'The magnitude is unknown. ',
      'Ｍ８を超える巨大地震': 'The earthquake is estimated to be huge with a magnitude over 8. ',
    },
    // 知らない表記（日本語）は読まず、数値でないと言う。在処の文は発話の末尾に 1 度だけ続く
    // （2026-11-17 ユーザー選択「数値でないと言い、在処を言う (Recommended)」）
    magnitudeConditionUnknown: (_body) => 'The magnitude is not given as a number. ',
    magnitudeIs: (predicate) => predicate,
    magnitudeAmended: (predicate) => `The magnitude has been updated. ${predicate}`,
    depthVeryShallowPlace: 'very shallow',
    depthOf: (km, atLeast) => `depth ${kilometers(km)}${atLeastOf(atLeast)}`,
    depthAtLeast: 'or deeper',
    depthAmendKm: (km, atLeast) => `Hypocenter depth updated to ${kilometers(km)}${atLeastOf(atLeast)}`,
    depthAmendVeryShallowContinuing: 'Hypocenter depth updated to very shallow',
    depthAmendIs: (value) => `Hypocenter depth updated to ${value}`,
    maxScaleOnlyUnreceived: (i) => `The maximum intensity is estimated at ${i} or higher, ${notReceived} `,
    maxScaleOnly: (i) => `Maximum intensity ${i} observed. `,
    label: {
      intensityReport: 'Seismic Intensity Information',
      distant: 'Distant Earthquake Information',
      epicenter: 'Earthquake Information',
      // 震源情報（Earthquake Information）と聞き分ける（2026-11-17 ユーザー選択「Earthquake and Seismic Intensity Information (Recommended)」）
      quake: 'Earthquake and Seismic Intensity Information',
    },
    hypocenterAmended: (name) => `Hypocenter updated: ${name}. `,
    magnitudeAmendedTo: (magnitude) => `The magnitude has been updated to ${magnitude}. `,
    depthAmendedTo: (depth) => `The hypocenter depth has been updated to ${depth}. `,
    observedIntensityUpdated: 'The observed intensities have been updated. ',
    stationsAddedRegionsSame: 'Stations have been added, but the maximum intensity in each area has not changed. ',
    stationsUpdatedRegionsSame: 'The observed intensities have been updated, but the maximum intensity in each area has not changed. ',
    noChange: 'There is no change in the content. ',
    intensityNoChange: 'There is no change in the observed intensities. ',
    hypocenterNoChange: 'There is no change in the hypocenter. ',
    prominentAmendHead: (time, epicenter) =>
      `Notice of Updated Hypocenter of a Significant Earthquake. Earthquake${time ? ` at around ${time}` : ''}: ${epicenter}. `,
    amendSep: ', ',
    magnitudeValue: (magnitude) => `magnitude updated to ${magnitude}`,
    amendedTail: '. ',
    hypocenterElementsAmended: 'The hypocenter has been updated. ',
    depthKm: (km, atLeast) => `${kilometers(km)}${atLeastOf(atLeast)}`,
    cancelledAt: (time) => `The Earthquake Information issued at ${time} has been cancelled.`,
    cancelled: 'The Earthquake Information has been cancelled.',
    reportCancelledAt: (name, time) => `The ${name} issued at ${time} has been cancelled.`,
    reportCancelled: (name) => `The ${name} has been cancelled.`,
    reportName: reportNameIn(en),
    hypocenterDepthSep: ', ',
    // 「地震が起きた」を先に言い、震源を後の文で言う（2026-11-17 ユーザー選択「言語の側で決める (Recommended)」）
    occurrence: (t) => [
      { kind: 'text', text: 'an earthquake' },
      ...(t.magnitude !== undefined ? [{ kind: 'text', text: ' ' } as const, { kind: 'magnitude' } as const] : []),
      { kind: 'text', text: ' occurred. ' },
      ...(t.name !== undefined
        ? [
          { kind: 'text', text: 'Hypocenter: ' } as const,
          { kind: 'name' } as const,
          ...(t.depth !== undefined ? [{ kind: 'text', text: ', ' } as const, { kind: 'depth' } as const] : []),
          { kind: 'text', text: '. ' } as const,
        ]
        : []),
      ...(t.magnitudeSentence !== undefined ? [{ kind: 'magnitudeSentence' } as const] : []),
    ],
    domesticTsunami: {
      'なし': 'This earthquake poses no tsunami risk. ',
      '若干の海面変動': 'Due to this earthquake, slight sea-level changes may be observed in coastal regions of Japan, but no tsunami damage is expected. ',
      '調査中': 'Whether this earthquake has generated a tsunami is under investigation. ',
      '海面変動の可能性': 'Because the hypocenter is under the sea, a tsunami may be generated. ',
      '注意報': 'A Tsunami Advisory is currently in effect. ',
      '警報等': 'Tsunami warnings or advisories are currently in effect. ',
      '不明': 'Tsunami information is unknown. ',
    },
    domesticTsunamiCode: {
      '0211': 'Tsunami warnings or advisories are currently in effect. ',
      '0212': 'Due to this earthquake, slight sea-level changes may be observed in coastal regions of Japan, but no tsunami damage is expected. ',
      '0213': 'Sea-level changes are expected to continue for a while, so take care when swimming in the sea or fishing from the rocks. ',
      '0214': 'Sea-level changes are expected to continue for a while, so take care when fishing from the rocks. ',
      '0215': 'This earthquake poses no tsunami risk. ',
      '0216': 'If the hypocenter is under the sea, a tsunami may be generated. ',
      '0217': 'Please watch for further information. ',
      '0229': 'Whether a tsunami will affect Japan is currently under investigation. ',
      '0230': 'This earthquake has no tsunami impact on Japan. ',
    },
    // 2026-11-17 ユーザー選択「022x の文を訳して読む (Recommended)」
    foreignTsunamiCode: {
      '0221': 'There is a possibility of a tsunami across a wide area of the Pacific Ocean. ',
      '0222': 'There is a possibility of a tsunami in the Pacific Ocean. ',
      '0226': 'There is a possibility of a tsunami near the hypocenter. ',
      '0228': 'Generally, when an earthquake of this size occurs in a shallow area under the sea, a tsunami may be generated. ',
    },
  },
  tsunami: {
    infoLabel: 'Tsunami Information',
    gradeName: tsunamiGradeNamesIn(en),
    heightToSpeech: tsunamiHeightIn(({ value, limit }) => {
      const m = meters(value)
      return limit === 'over' ? `over ${m}` : limit === 'under' ? `under ${m}` : limit === 'orMore' ? `${m} or more` : m
    }),
    nonNumericHeight: { 巨大: 'huge', 高い: 'high' },
    heightLabel: { height: markHeightOrMore },
    // 区域名の訳はコンマを含む（「Noto Area, Ishikawa Prefecture」）ので、区域・観測点の区切りは「; 」、区域と観測点の間は「: 」
    areaSep: '; ',
    heightGroupSep: '. ',
    districtStationSep: ': ',
    stationSep: '; ',
    forecastHeightAt: (h) => `: estimated height ${h}`,
    observedHeightAt: (h) => `, ${h}`,
    heightsExpected: '. ',
    alsoIssued: (g) => `: ${g} also in effect. `,
    // 必ず「Also, 」の後ろに来るので小文字で始める
    issuedForAreasBelow: (g) => `a ${g} has been issued for the following coastal regions of Japan. `,
    issuedFor: (g) => `: ${g} in effect. `,
    issuedForAreas: (g) => `: ${g} issued. `,
    gradeIssued: (g) => `${g} issued. `,
    downgradedBelow: (g) => `Downgraded to ${g}. A ${g} is now in effect for the following coastal regions of Japan. `,
    downgradedLead: (g) => `Downgraded to ${g}. Currently, `,
    areaLifted: (g) => `: ${g} lifted. `,
    warningsEtc: 'tsunami warnings and advisories',
    areaGradeChanged: (from, to, raised) => `: ${from} ${raised ? 'upgraded' : 'downgraded'} to ${to}. `,
    forecastHeightChanged: 'The estimated maximum tsunami heights have changed. ',
    fallbackEvacuation: tsunamiEvacuationIn(en, ' '),
    sourceLead: 'Hypocenter of this earthquake: ',
    sourceLeadOther: 'Also, hypocenter of the other earthquake: ',
    sourceMagnitudeLead: ', magnitude ',
    sourceMagnitude: (magnitude) => magnitude,
    sourceTail: '. ',
    sourceHypocenterAmended: (first, name) => `Hypocenter of ${theQuake(first)} updated: ${name}. `,
    sourceMagnitudeAmendedTo: (first, magnitude) => `The magnitude of ${theQuake(first)} has been updated to ${magnitude}. `,
    sourceMagnitudeAmended: (first, predicate) => `The magnitude of ${theQuake(first)} has been updated. ${predicate}`,
    sourceDepthAmendedTo: (first, depth) => `The hypocenter depth of ${theQuake(first)} has been updated to ${depth}. `,
    expiryLead: (g, _time) => `This ${g} expires at `,
    expiryTail: '. ',
    // 延長か変更かを時刻の前で言う（2026-11-17 ユーザー選択「この案で入れる (Recommended)」の 15 節）
    expiryChangeLead: (g, extended, _time) => `The ${g} has been ${extended ? 'extended' : 'changed'}; it now expires at `,
    expiryExtended: '. ',
    expiryChanged: '. ',
    retracted: 'The tsunami warnings and advisories were issued in error and have been cancelled.',
    expired: 'The Tsunami Forecast has expired.',
    allLifted: 'All tsunami warnings and advisories have been lifted.',
    infoRetracted: 'The Tsunami Information has been cancelled.',
    offshoreRetracted: 'The Offshore Tsunami Observation Information has been cancelled.',
    firstWaveKind: firstWaveKindIn('initial rise', 'initial drop', 'initial wave'),
    // 語幹を値の前に置く。更新は観測した時刻だと分かる形にする（「updated to 0.9 meters, observed at 16:41」。同日の 15 節）
    heightClause: (firstWave, at, value, updated) =>
      `, ${firstWave ? `${firstWave.initial} arrived at ${firstWave.time}, ` : ''}${updated
        ? `${STEM_UPDATED} ${value}${at ? `, observed at ${at}` : ''}`
        : `${STEM_OBSERVED} ${value}${at ? ` at ${at}` : ''}`}`,
    observationInfoLead: 'Tsunami Observation Information. ',
    maxWaveUpdatedLead: 'The maximum wave has been updated at the following sites. ',
    newlyObservedLead: 'A tsunami has been newly observed at the following sites. ',
    stemUpdated: STEM_UPDATED,
    stemObserved: STEM_OBSERVED,
    tailUpdated: '. ',
    tailObserved: '. ',
    omittedObserving: (n) => `A tsunami is also being observed at ${otherSites(n)}. `,
    omittedArrival: (n) => `Arrival has also been confirmed at ${otherSites(n)}. `,
    omittedUpdated: (n) => `Updates have also been made at ${otherSites(n)}. `,
    omittedMissing: (n) => `Data are also missing at ${otherSites(n)}. `,
    omittedWarningLevel: (n) => `A tsunami at the Tsunami Warning level is also being observed at ${otherSites(n)}. `,
    arrivalLead: 'Tsunami arrival has been confirmed at the following sites. ',
    firstWaveObservedClause: (time, initial) => `, ${initial} observed at ${time}`,
    firstWaveUpdatedClause: (time, initial) => `, updated to ${initial} at ${time}`,
    arrivalConfirmedClause: ', arrival confirmed',
    arrivalConfirmedTail: ': arrival confirmed. ',
    maxHeightObserving: 'Maximum wave height: information pending. ',
    maxHeightWeak: 'Maximum wave height: weak. ',
    updatedAtClause: (at) => (at ? `, updated to ${at}` : ', updated'),
    maxHeightTimeLead: 'The observation time of the maximum wave has been updated at the following sites. ',
    maxHeightTimeTail: ': the observation time of the maximum wave has been updated. ',
    missingMaxHeightTimeLead: 'At sites where data are missing, the observation time of the maximum wave has been updated. ',
    missingPrefix: 'Sites with missing data. ',
    firstWaveUpdatedLead: 'The initial wave has been updated at the following sites. ',
    firstWaveArrivedLead: 'Arrival of the initial tsunami wave has been confirmed at the following sites. ',
    observationNoChange: 'Tsunami Observation Information. There is no change in the observed wave heights. ',
    observationLowered: 'Tsunami Observation Information has been issued. ',
    tideFallbackHeadline: 'Here are the high tide times and the estimated initial tsunami arrival times for each area. ',
    tide: {
      tide: 'The high tide times have been updated. ',
      arrival: 'The tsunami arrival status has been updated. ',
      arrivalTime: 'The estimated tsunami arrival times have been updated. ',
      none: 'There is no change in the content. ',
    },
    missingObservedLead: 'The following was observed before data became unavailable. ',
    weakTsunamiAt: ', a weak tsunami',
    missingObservedTail: '. Data are now missing. ',
    missingTail: ': no data. ',
    warningLevelTail: ': a tsunami at the Tsunami Warning level is being observed. ',
  },
}
