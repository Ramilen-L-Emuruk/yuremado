import type { SpeechWordsInProgress } from '../speechWords'
import type { UnreceivedUnit } from '../../utils/quakePoints'
import { en } from '../messages/en'
import { clockTime, englishOrdinal, intensityIn, regionNameIn, reportNameIn, showsApproxAbove } from './shared'

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
}
