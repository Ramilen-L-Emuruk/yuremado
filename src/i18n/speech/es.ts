import type { SpeechWordsInProgress } from '../speechWords'
import type { UnreceivedUnit } from '../../utils/quakePoints'
import { es } from '../messages/es'
import { clockTime, decimalComma, intensityIn, isOneOClock, regionNameIn, reportNameIn, showsApproxAbove } from './shared'

const intensity = intensityIn(es)
/** 未入電の単位（単数・複数）。「件」は観測点と地域が混ざったとき */
const UNIT: Readonly<Record<UnreceivedUnit, readonly [string, string]>> = {
  '地点': ['estación', 'estaciones'],
  '地域': ['zona', 'zonas'],
  '件': ['lugar', 'lugares'],
}
const unitOf = (count: number, unit: UnreceivedUnit) => UNIT[unit][count === 1 ? 0 : 1]
const atLeastOf = (atLeast: string) => (atLeast ? ` ${atLeast}` : '')
/** 距離（1 だけ単数） */
const kilometers = (km: number) => `${km} ${km === 1 ? 'kilómetro' : 'kilómetros'}`
const ELSEWHERE = 'El texto original de la Agencia Meteorológica de Japón está en el Registro de telegramas.'
/** 時刻の前の前置詞と冠詞（1 時台だけ単数。「a las 12:40」「a la 1:40」） */
const at = (time: string) => `${isOneOClock(time) ? 'a la' : 'a las'} ${time}`
/** 「〜頃」の前置詞と冠詞（「de las 12:34」「de la 1:05」） */
const around = (time: string) => `${isOneOClock(time) ? 'de la' : 'de las'} ${time}`
const fiveLowerOrHigher = `${intensity(45)} o superior`
const notReceived = 'pero la intensidad no se ha recibido.'

/**
 * 読み上げの文の語表（スペイン語。訳し終えた区分だけ → `SpeechWordsInProgress`）。
 * 文面は 2026-11-17 ユーザー選択「この案で入れる (Recommended)」の表。気象庁の多言語辞書の定型文（Manténgase alerta contra fuertes temblores・canceló）と
 * 画面の辞書の訳（Alerta Temprana de Terremoto・Intensidad máx. prevista など）にそろえた。震央・対象地方・観測した地名は「:」で示す。
 *
 * 規模の小数点はコンマにする。地震情報の断片は区切りを挟まずにつなぐので、文の終わりになる語は後ろに空白を 1 つ持つ
 */
export const esSpeech: SpeechWordsInProgress = {
  common: {
    listSep: ', ',
    sentenceSep: ' ',
    intensity,
    time: clockTime,
    telegramTextElsewhere: ELSEWHERE,
    day: (d) => `día ${d}`,
    dayTime: (d, hour, minute) => `${clockTime(hour, minute)} del día ${d}`,
    cancelReasonLead: (infoName) => `A continuación, el motivo de la cancelación de la ${infoName}. `,
    issued: (label) => `${label}. `,
    updated: (label) => `Se ha actualizado la ${label}. `,
    atAround: (time) => `Alrededor ${around(time)}, `,
    also: 'Además, ',
    dayHour: (d, hour) => `${hour}:00 del día ${d}`,
    telegramTextLead: (label) => `A continuación, el texto de la Agencia Meteorológica de Japón sobre la ${label}. `,
  },
  eew: {
    upgrade: 'Elevado a Alerta Temprana de Terremoto.',
    warningRegionsClosing: 'manténgase alerta contra fuertes temblores',
    lpgmClassZero: 'Clase máxima prevista de movimiento sísmico de período largo 0.',
    cancelledAt: (time) => `La Alerta Temprana de Terremoto emitida ${at(time)} fue cancelada.`,
    cancelled: 'La Alerta Temprana de Terremoto fue cancelada.',
    lead: {
      forecast: 'Pronóstico del movimiento sísmico.',
      warning: 'Alerta Temprana de Terremoto.',
      hypocenterUpdate: 'Hipocentro actualizado.',
    },
    leadAlone: (l) => l,
    leadWithEpicenter: (l, epicenter) => `${l} Terremoto: ${epicenter}.`,
    warningRegionName: regionNameIn(es),
    warningRegionsAdditional: (names, closing) => `También ${names}: ${closing}.`,
    warningRegions: (names, closing) => `${names}: ${closing}.`,
    noForecast: {
      singleStation: 'Sin intensidad prevista: estación única.',
      deep: 'Sin intensidad prevista: sismo profundo.',
      belowScale1: 'Intensidad máxima prevista 0.',
      unknown: 'Sin intensidad prevista.',
    },
    maxScale: (scale, orAbove) => {
      const label = intensity(scale)
      return `Intensidad máxima prevista ${showsApproxAbove(scale, orAbove) ? `alrededor de ${label} o superior` : label}.`
    },
    maxLpgmClass: (cls, over) => `Clase máxima prevista de movimiento sísmico de período largo ${over ? `alrededor de ${cls} o superior` : cls}.`,
  },
  quake: {
    regionSep: '; ',
    // 階級ごとに文を切る（2026-11-17 ユーザー選択「階級ごとに文を切る (Recommended)」）。初めて観測した地域の文は次の文にも「Por primera vez」（同日ユーザー選択「文ごとに繰り返す (Recommended)」）
    intensityGroupSep: (fresh) => (fresh ? '. Por primera vez, ' : '. '),
    unreceivedCountOnly: (count, unit) => `En ${count} ${unitOf(count, unit)} se estima una intensidad de ${fiveLowerOrHigher}, ${notReceived} `,
    unreceivedOmitted: (count, unit) => `, y ${count} ${unitOf(count, unit)} más`,
    unreceivedTailPartial: `: en algunas estaciones se estima una intensidad de ${fiveLowerOrHigher}, ${notReceived} `,
    unreceivedTail: `: se estima una intensidad de ${fiveLowerOrHigher}, ${notReceived} `,
    intensityLead: (isMax, i) => `${isMax ? 'Intensidad máxima' : 'Intensidad'} ${i} observada: `,
    regionsOmitted: (count) => `, y ${count} ${count === 1 ? 'zona' : 'zonas'} más`,
    observedTail: '. ',
    fresh: 'Por primera vez, ',
    freshAfterUpgraded: 'Además, por primera vez, ',
    magnitudeOf: (magnitude) => `de magnitud ${decimalComma(magnitude)}`,
    magnitudeConditionPredicate: {
      'Ｍ不明': 'La magnitud es desconocida. ',
      'Ｍ８を超える巨大地震': 'Se estima que es un terremoto extremadamente fuerte de magnitud superior a 8. ',
    },
    // 知らない表記（日本語）は読まず、数値でないと言う。在処の文は発話の末尾に 1 度だけ続く
    // （2026-11-17 ユーザー選択「数値でないと言い、在処を言う (Recommended)」）
    magnitudeConditionUnknown: (_body) => 'La magnitud no se ha publicado como número. ',
    magnitudeIs: (predicate) => predicate,
    magnitudeAmended: (predicate) => `Se ha actualizado la magnitud. ${predicate}`,
    depthVeryShallowPlace: 'muy superficial',
    depthOf: (km, atLeast) => `profundidad de ${kilometers(km)}${atLeastOf(atLeast)}`,
    depthAtLeast: 'o más',
    depthAmendKm: (km, atLeast) => `Profundidad del hipocentro actualizada a ${kilometers(km)}${atLeastOf(atLeast)}`,
    depthAmendVeryShallowContinuing: 'Profundidad del hipocentro actualizada a muy superficial',
    depthAmendIs: (value) => `Profundidad del hipocentro actualizada a ${value}`,
    maxScaleOnlyUnreceived: (i) => `Se estima una intensidad máxima de ${i} o superior, ${notReceived} `,
    maxScaleOnly: (i) => `Intensidad máxima ${i} observada. `,
    label: {
      intensityReport: 'Información de intensidad sísmica',
      distant: 'Información de terremoto lejano',
      epicenter: 'Información del hipocentro',
      quake: 'Información de terremotos',
    },
    hypocenterAmended: (name) => `Hipocentro actualizado: ${name}. `,
    magnitudeAmendedTo: (magnitude) => `Se ha actualizado la magnitud a ${decimalComma(magnitude)}. `,
    depthAmendedTo: (depth) => `Se ha actualizado la profundidad del hipocentro: ${depth}. `,
    observedIntensityUpdated: 'Se han actualizado las intensidades observadas. ',
    stationsAddedRegionsSame: 'Se han añadido estaciones, pero la intensidad máxima de cada zona no ha cambiado. ',
    stationsUpdatedRegionsSame: 'Se han actualizado las intensidades observadas, pero la intensidad máxima de cada zona no ha cambiado. ',
    noChange: 'No hay cambios en el contenido. ',
    intensityNoChange: 'No hay cambios en las intensidades observadas. ',
    hypocenterNoChange: 'No hay cambios en el hipocentro. ',
    prominentAmendHead: (time, epicenter) =>
      `Aviso de actualización del hipocentro de un terremoto significativo. Terremoto${time ? ` alrededor ${around(time)}` : ''}: ${epicenter}. `,
    amendSep: ', ',
    magnitudeValue: (magnitude) => `magnitud actualizada a ${decimalComma(magnitude)}`,
    amendedTail: '. ',
    hypocenterElementsAmended: 'Se ha actualizado el hipocentro. ',
    depthKm: (km, atLeast) => `${kilometers(km)}${atLeastOf(atLeast)}`,
    cancelledAt: (time) => `La Información de terremotos emitida ${at(time)} fue cancelada.`,
    cancelled: 'La Información de terremotos fue cancelada.',
    // 名前ごとに性が違う（Aviso は男性）ので、冠詞と過去分詞を名前に合わせない形（画面の `quake.retracted` と同じ「X: cancelada」）
    reportCancelledAt: (name, time) => `${name}, emitida ${at(time)}: cancelada.`,
    reportCancelled: (name) => `${name}: cancelada.`,
    reportName: reportNameIn(es),
    hypocenterDepthSep: ', ',
    // 「地震が起きた」を先に言い、震源を後の文で言う（2026-11-17 ユーザー選択「言語の側で決める (Recommended)」）
    occurrence: (t) => [
      { kind: 'text', text: 'se produjo un terremoto' },
      ...(t.magnitude !== undefined ? [{ kind: 'text', text: ' ' } as const, { kind: 'magnitude' } as const] : []),
      { kind: 'text', text: '. ' },
      ...(t.name !== undefined
        ? [
          { kind: 'text', text: 'Hipocentro: ' } as const,
          { kind: 'name' } as const,
          ...(t.depth !== undefined ? [{ kind: 'text', text: ', ' } as const, { kind: 'depth' } as const] : []),
          { kind: 'text', text: '. ' } as const,
        ]
        : []),
      ...(t.magnitudeSentence !== undefined ? [{ kind: 'magnitudeSentence' } as const] : []),
    ],
    domesticTsunami: {
      'なし': 'Este terremoto no presenta riesgo de tsunami. ',
      '若干の海面変動': 'Debido a este terremoto, puede haber una ligera alteración en la superficie del mar en las costas de Japón, pero no hay riesgo de daño. ',
      '調査中': 'La posibilidad de tsunami por este terremoto está en investigación. ',
      '海面変動の可能性': 'Como el hipocentro está bajo el mar, es posible que se produzca un tsunami. ',
      '注意報': 'Actualmente está emitida la Advertencia de Tsunami. ',
      '警報等': 'Actualmente está emitida la Alerta de Tsunami, etc. ',
      '不明': 'La información de tsunami es desconocida. ',
    },
    domesticTsunamiCode: {
      '0211': 'Fue emitida la Alerta de Tsunami, etc. ',
      '0212': 'Debido a este terremoto, puede haber una ligera alteración en la superficie del mar en las costas de Japón, pero no hay riesgo de daño. ',
      '0213': 'Se prevé que las alteraciones del nivel del mar continúen durante un tiempo; tenga cuidado al bañarse en el mar o pescar en las rocas. ',
      '0214': 'Se prevé que las alteraciones del nivel del mar continúen durante un tiempo; tenga cuidado al pescar en las rocas. ',
      '0215': 'Este terremoto no presenta riesgo de tsunami. ',
      '0216': 'Si el hipocentro está bajo el mar, es posible que se produzca un tsunami. ',
      '0217': 'Preste atención a la información posterior. ',
      '0229': 'Actualmente está en investigación si habrá tsunami en Japón. ',
      '0230': 'Este terremoto no tiene impacto de tsunami en Japón. ',
    },
    // 2026-11-17 ユーザー選択「022x の文を訳して読む (Recommended)」
    foreignTsunamiCode: {
      '0221': 'Es posible que se produzca un tsunami en una amplia zona del océano Pacífico. ',
      '0222': 'Es posible que se produzca un tsunami en el océano Pacífico. ',
      '0226': 'Es posible que se produzca un tsunami cerca del hipocentro. ',
      '0228': 'En general, cuando un terremoto de esta magnitud ocurre en una zona poco profunda bajo el mar, puede producirse un tsunami. ',
    },
  },
}
