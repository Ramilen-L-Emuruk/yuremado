import type { SpeechWords } from '../speechWords'
import type { UnreceivedUnit } from '../../utils/quakePoints'
import { es } from '../messages/es'
import { clockTime, decimalComma, firstWaveKindIn, halfWidthDigits, intensityIn, isOneOClock, markHeightOrMore, regionNameIn, reportNameIn, showsApproxAbove, tsunamiEvacuationIn, tsunamiGradeNamesIn, tsunamiHeightIn, dayPeriodOf } from './shared'

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
/** 時刻の前の前置詞と冠詞だけ（後ろに時刻の断片が続くとき） */
const clockPrep = (time: string) => (isOneOClock(time) ? 'a la' : 'a las')
/** 時刻（前置詞と冠詞つき。{@link at} と同じ。語表の関数の引数 `at`（最大波の時刻）と名前がぶつかる所で使う） */
const atClock = at
/** 津波の等級の呼び名と、前の等級を読めない解除区域の呼び名 */
const GRADE = tsunamiGradeNamesIn(es)
const WARNINGS_ETC = 'alertas y advertencias de tsunami'
/** 等級の名前の性と数（Alerta・Advertencia は女性・Pronóstico は男性。`warningsEtc` は女性の複数） */
const MASCULINE: ReadonlySet<string> = new Set([GRADE.Forecast])
const PLURAL: ReadonlySet<string> = new Set([WARNINGS_ETC])
/** 名前に合わせた過去分詞（`stem` は「decretad」など語尾の前まで） */
const agree = (name: string, stem: string) => `${stem}${MASCULINE.has(name) ? 'o' : 'a'}${PLURAL.has(name) ? 's' : ''}`
/** 名前に合わせた定冠詞 */
const article = (name: string) => (MASCULINE.has(name) ? 'el' : 'la')
/** 波高（1 だけ単数） */
const meters = (value: string) => `${decimalComma(value)} ${value === '1' ? 'metro' : 'metros'}`
/** 波高に合わせた「観測した」（1 メートルだけ単数） */
const observedOf = (value: string) => (/\bmetro\b/.test(value) ? 'observado' : 'observados')
/** 上限で読まなかった観測点の数（1 だけ単数） */
const moreSites = (n: number) => `${n} ${n === 1 ? 'lugar' : 'lugares'} más`
/** 原因地震の呼び方（1 つ目の地震か、2 つ目以降の地震か） */
const ofTheQuake = (first: boolean) => (first ? 'de este terremoto' : 'del otro terremoto')
/** 津波の観測点の句の述語の語幹（更新・観測） */
const STEM_UPDATED = 'actualización a'
const STEM_OBSERVED = 'observación de'

const NANKAI = es.telegramLog.controlTitle['南海トラフ地震臨時情報']
const COMMENTARY = es.telegramLog.controlTitle['南海トラフ地震関連解説情報']
const COUNT = es.telegramLog.controlTitle['地震回数に関する情報']
const NOTICE = es.telegramLog.controlTitle['地震・津波に関するお知らせ']
const KOHATSU = es.telegramLog.controlTitle['北海道・三陸沖後発地震注意情報']
const LPGM = es.quake.infoName.lpgm
const INTERNATIONAL_TSUNAMI = es.quake.infoName.internationalTsunami
const WATCH = 'Esté atento a la información posterior.'
/** 想定震源域（「zona de origen prevista de un terremoto de la Fosa de Nankai」） */
const SOURCE_AREA = 'de la zona de origen prevista de un terremoto de la Fosa de Nankai'
const MEASURES = 'medidas preventivas contra desastres'
const PERIOD = { small: 'de la madrugada', morning: 'de la mañana', noon: 'del mediodía', afternoon: 'de la tarde', night: 'de la noche' } as const
/**
 * 時報の時刻（数字で書く。2026-11-18 ユーザー選択「時刻を数字で書く (Recommended)」）。12 時間制は時間帯の語
 * （同日「言語ごとの時間帯の語で言う (Recommended)」。0 時台は「las 0:30 de la madrugada」、12 時台は「las 12:30 del mediodía」）。
 * 20 時以降は「de la noche」（同日「夜の語を足す (Recommended)」）
 */
const signalClock = (hour: number, minute: number, clock: '24h' | '12h') => {
  if (clock === '24h') return clockTime(hour, minute)
  const p = dayPeriodOf(hour, 20)
  return `${clockTime(p.hour, minute)} ${PERIOD[p.period]}`
}

/**
 * 読み上げの文の語表（スペイン語）。
 * 文面は 2026-11-17 ユーザー選択「この案で入れる (Recommended)」の表（緊急地震速報・地震情報・津波）と、2026-11-18 ユーザー選択
 * 「この案で入れる (Recommended)」の表（長周期・特別情報・揺れ検知・国際津波関連情報。時報は同日「時刻を数字で書く (Recommended)」）。
 * 気象庁の多言語辞書の定型文（Manténgase alerta contra fuertes temblores・canceló）と画面の辞書の訳（Alerta Temprana de Terremoto・
 * Intensidad máx. prevista など）にそろえた。震央・対象地方・観測した地名は「:」で示す。
 *
 * 規模の小数点はコンマにする。地震情報の断片は区切りを挟まずにつなぐので、文の終わりになる語は後ろに空白を 1 つ持つ
 */
export const esSpeech: SpeechWords = {
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
    label: es.quake.jmaNoteHeading.eew,
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
  tsunami: {
    infoLabel: 'Información del tsunami',
    gradeName: GRADE,
    heightToSpeech: tsunamiHeightIn(({ value, limit }) => {
      const m = meters(value)
      return limit === 'over' ? `más de ${m}` : limit === 'under' ? `menos de ${m}` : limit === 'orMore' ? `${m} o más` : m
    }),
    nonNumericHeight: { 巨大: 'tsunami gigante', 高い: 'tsunami alto' },
    heightLabel: { height: markHeightOrMore },
    // 区域名の訳はコンマを含むので、区域・観測点の区切りは「; 」、区域と観測点の間は「: 」
    areaSep: '; ',
    heightGroupSep: '. ',
    districtStationSep: ': ',
    stationSep: '; ',
    forecastHeightAt: (h) => `: previsión de ${h}`,
    observedHeightAt: (h) => `, ${h}`,
    heightsExpected: '. ',
    alsoIssued: (g) => `: ${g} también en vigor. `,
    // 必ず「Además, 」の後ろに来るので小文字で始める
    issuedForAreasBelow: (g) => `las costas en ${g} son las siguientes. `,
    issuedFor: (g) => `: ${g} en vigor. `,
    issuedForAreas: (g) => `: ${g} ${agree(g, 'decretad')}. `,
    gradeIssued: (g) => `Se ha decretado ${article(g)} ${g}. `,
    downgradedBelow: (g) => `Bajada del nivel a ${g}. Actualmente, las costas en ${g} son las siguientes. `,
    downgradedLead: (g) => `Bajada del nivel a ${g}. Actualmente, `,
    areaLifted: (g) => `: ${g} ${agree(g, 'desactivad')}. `,
    warningsEtc: WARNINGS_ETC,
    // 「名前, 名詞句」の形にして性の一致を避ける
    areaGradeChanged: (from, to, raised) => `: ${from}, ${raised ? 'subida' : 'bajada'} del nivel a ${to}. `,
    forecastHeightChanged: 'La altura máxima prevista del tsunami ha cambiado. ',
    fallbackEvacuation: tsunamiEvacuationIn(es, ' '),
    sourceLead: 'Hipocentro de este terremoto: ',
    sourceLeadOther: 'Además, hipocentro del otro terremoto: ',
    sourceMagnitudeLead: ', magnitud ',
    sourceMagnitude: decimalComma,
    sourceTail: '. ',
    sourceHypocenterAmended: (first, name) => `Hipocentro ${ofTheQuake(first)} actualizado: ${name}. `,
    sourceMagnitudeAmendedTo: (first, magnitude) => `Se ha actualizado la magnitud ${ofTheQuake(first)} a ${decimalComma(magnitude)}. `,
    sourceMagnitudeAmended: (first, predicate) => `Se ha actualizado la magnitud ${ofTheQuake(first)}. ${predicate}`,
    // 値は「:」で示す（「muy superficial」が入ったとき前置詞が崩れないように）
    sourceDepthAmendedTo: (first, depth) => `Se ha actualizado la profundidad del hipocentro ${ofTheQuake(first)}: ${depth}. `,
    expiryLead: (g, time) => `${g}: vence ${clockPrep(time)} `,
    expiryTail: '. ',
    // 延長か変更かを時刻の前で言う（2026-11-17 ユーザー選択「この案で入れる (Recommended)」の 15 節）
    expiryChangeLead: (g, extended, time) => `${g}: ${extended ? 'el plazo se ha prorrogado' : 'la hora se ha cambiado'}; ahora vence ${clockPrep(time)} `,
    expiryExtended: '. ',
    expiryChanged: '. ',
    retracted: 'Las alertas y advertencias de tsunami se emitieron por error y se han cancelado.',
    expired: 'El Pronóstico del tsunami ha vencido.',
    allLifted: 'Todas las alertas y advertencias de tsunami han sido desactivadas.',
    infoRetracted: 'Se ha cancelado la Información del tsunami.',
    offshoreRetracted: 'Se ha cancelado la Información de observación del tsunami en alta mar.',
    firstWaveKind: firstWaveKindIn('subida inicial', 'bajada inicial', 'primera ola'),
    // 更新は観測した時刻だと分かる形にする（「actualización a 0,9 metros, observados a las 16:41」。同日の 15 節）。第 1 波の 3 つの語はどれも女性名詞
    heightClause: (firstWave, at, value, updated) =>
      `, ${firstWave ? `la ${firstWave.initial} llegó ${atClock(firstWave.time)}, ` : ''}${updated
        ? `${STEM_UPDATED} ${value}${at ? `, ${observedOf(value)} ${atClock(at)}` : ''}`
        : `${STEM_OBSERVED} ${value}${at ? ` ${atClock(at)}` : ''}`}`,
    observationInfoLead: 'Información de observación del tsunami. ',
    maxWaveUpdatedLead: 'Se ha actualizado la ola máxima en los siguientes lugares. ',
    newlyObservedLead: 'Se ha observado un tsunami por primera vez en los siguientes lugares. ',
    stemUpdated: STEM_UPDATED,
    stemObserved: STEM_OBSERVED,
    tailUpdated: '. ',
    tailObserved: '. ',
    omittedObserving: (n) => `También se observa el tsunami en ${moreSites(n)}. `,
    omittedArrival: (n) => `También se ha confirmado la llegada en ${moreSites(n)}. `,
    omittedUpdated: (n) => `También se ha actualizado en ${moreSites(n)}. `,
    omittedMissing: (n) => (n === 1 ? 'Otro lugar también está sin datos. ' : `Otros ${n} lugares también están sin datos. `),
    omittedWarningLevel: (n) => `También se observa un tsunami de nivel de Alerta de Tsunami en ${moreSites(n)}. `,
    arrivalLead: 'Se ha confirmado la llegada del tsunami en los siguientes lugares. ',
    firstWaveObservedClause: (time, initial) => `, ${initial} observada ${atClock(time)}`,
    firstWaveUpdatedClause: (time, initial) => `, actualización a ${initial} ${atClock(time)}`,
    arrivalConfirmedClause: ', llegada confirmada',
    arrivalConfirmedTail: ': llegada confirmada. ',
    maxHeightObserving: 'Altura máxima de la ola: información pendiente. ',
    maxHeightWeak: 'Altura máxima de la ola: débil. ',
    updatedAtClause: (time) => (time ? `, actualización ${atClock(time)}` : ', actualización'),
    maxHeightTimeLead: 'Se ha actualizado la hora de observación de la ola máxima en los siguientes lugares. ',
    maxHeightTimeTail: ': se ha actualizado la hora de observación de la ola máxima. ',
    missingMaxHeightTimeLead: 'En los lugares sin datos, se ha actualizado la hora de observación de la ola máxima. ',
    missingPrefix: 'Lugares sin datos. ',
    firstWaveUpdatedLead: 'Se ha actualizado la primera ola en los siguientes lugares. ',
    firstWaveArrivedLead: 'Se ha confirmado la llegada de la primera ola del tsunami en los siguientes lugares. ',
    observationNoChange: 'Información de observación del tsunami. No hay cambios en las alturas de ola observadas. ',
    observationLowered: 'Se ha emitido la Información de observación del tsunami. ',
    tideFallbackHeadline: 'A continuación, las horas de marea alta y las horas previstas de llegada de la primera ola del tsunami en cada lugar. ',
    tide: {
      tide: 'Se han actualizado las horas de marea alta. ',
      arrival: 'Se ha actualizado la situación de llegada del tsunami. ',
      arrivalTime: 'Se han actualizado las horas previstas de llegada del tsunami. ',
      none: 'No hay cambios en el contenido. ',
    },
    missingObservedLead: 'Observado antes de quedar sin datos. ',
    weakTsunamiAt: ', tsunami débil',
    missingObservedTail: '. Actualmente, sin datos. ',
    missingTail: ': sin datos. ',
    warningLevelTail: ': se observa un tsunami de nivel de Alerta de Tsunami. ',
  },
  lpgm: {
    label: LPGM,
    retracted: `La ${LPGM} fue cancelada.`,
    occurredAt: (time) => `Terremoto ocurrido alrededor ${around(time)}. `,
    // 2 組目からは短く言う（2026-11-18 ユーザー選択「この案で入れる (Recommended)」の 5 節の 1）
    classAt: (cls, names, isFirst) => `Clase ${cls}${isFirst ? ' de movimiento sísmico de período largo' : ''} observada: ${names}`,
    regions: (regionText) => regionText,
    maxClassOnly: (cls) => `Clase ${cls} de movimiento sísmico de período largo observada.`,
  },
  special: {
    nankaiLabel: NANKAI,
    // 主語と動詞を持つ形（「Como 〈きっかけ〉,」で受ける）
    nankaiTrigger: {
      '111': 'se produjo un terremoto de magnitud 6,8 o superior en la zona vigilada',
      '112': 'se observó un cambio significativo en los extensómetros',
      '113': 'se observó un fenómeno distinto de lo habitual',
    },
    nankaiRetracted: `La ${NANKAI} fue cancelada.`,
    nankaiEnded: `${NANKAI}: investigación concluida. La posibilidad de un terremoto en la Fosa de Nankai estaba dentro de lo normal.`,
    nankaiInvestigating: (trigger) =>
      `${NANKAI}: en investigación. ${trigger ? `Como ${trigger}, se está investigando` : 'Se está investigando'} la posibilidad de un terremoto en la Fosa de Nankai. ${WATCH}`,
    nankaiMajorWarning: `${NANKAI}: Alerta ante megaterremoto. Se ha producido un gran terremoto dentro ${SOURCE_AREA}. Tome inmediatamente ${MEASURES}.`,
    nankaiMajorAdvisory: `${NANKAI}: Precaución ante megaterremoto. Se ha producido un terremoto dentro ${SOURCE_AREA}. Revise sus ${MEASURES}.`,
    nankaiOther: `${NANKAI}. Se ha emitido información extraordinaria sobre un terremoto de la Fosa de Nankai. ${WATCH}`,
    commentaryLabel: COMMENTARY,
    commentaryRetracted: `El ${COMMENTARY} fue cancelado.`,
    commentaryRegular: `${COMMENTARY}. Se han publicado los resultados de la reunión ordinaria del Comité de Evaluación de Terremotos de la Fosa de Nankai.`,
    // 号数は語で言う（画面の「n.º」は声で崩れる）
    commentary: (serial) =>
      `${COMMENTARY}${serial ? `, número ${halfWidthDigits(serial)}` : ''}. Se ha emitido un comentario sobre la situación en la zona de origen prevista de un terremoto de la Fosa de Nankai.`,
    countLabel: COUNT,
    countRetracted: `La ${COUNT} fue cancelada.`,
    countLead: `${COUNT}. `,
    countSpanUnknown: 'Hasta ahora',
    countSpan: (from, to) => `Desde ${isOneOClock(from) ? 'la' : 'las'} ${from} hasta ${isOneOClock(to) ? 'la' : 'las'} ${to}`,
    countFeltOnly: (span, felt) =>
      `${span}, ${felt === 1 ? 'se observó 1 terremoto' : `se observaron ${felt} terremotos`} con intensidad sísmica 1 o superior. `,
    countOccurred: (span, count) => `${span}, ${count === 1 ? 'se ha producido 1 terremoto' : `se han producido ${count} terremotos`}. `,
    countFeltOf: (felt) => `De ellos, ${felt} ${felt === 1 ? 'tuvo' : 'tuvieron'} intensidad sísmica 1 o superior. `,
    countFeltNone: 'Ninguno de ellos tuvo intensidad sísmica 1 o superior. ',
    noticeLabel: NOTICE,
    noticeRetracted: `El ${NOTICE} fue cancelado.`,
    noticeLead: `${NOTICE}. `,
    noticeWithHeadline: (_headline) => `${NOTICE}. ${ELSEWHERE}`,
    kohatsuLabel: KOHATSU,
    kohatsuRetracted: `El ${KOHATSU} fue cancelado.`,
    kohatsu: (headline) =>
      `${KOHATSU}. ${headline === null ? `${ELSEWHERE} ` : ''}La posibilidad de un gran terremoto es mayor de lo habitual. Revise sus ${MEASURES}.`,
    estimatedIntensity: (time, isNew) =>
      `Se ha ${isNew ? 'recibido' : 'actualizado'} el ${es.quake.infoName.estimatedIntensity} de la Agencia Meteorológica de Japón${time ? ` para el terremoto de alrededor ${around(time)}` : ''}.`,
  },
  kyoshin: {
    detected: (name) => (name ? `Movimiento detectado: ${name}.` : 'Movimiento detectado.'),
    otherRegion: (name) => (name ? `También se detectó movimiento: ${name}.` : 'También se detectó movimiento en otro lugar.'),
  },
  internationalTsunami: {
    label: INTERNATIONAL_TSUNAMI,
    communicationsTest: `${INTERNATIONAL_TSUNAMI}: prueba de comunicación.`,
    evaluation: es.alertText.internationalTsunamiEvaluation,
    when: (d, hour, minute) => `${clockTime(hour, minute)} del día ${d}`,
    coordinate: (lat, lon) =>
      `latitud ${decimalComma(Math.abs(lat).toFixed(1))} grados ${lat < 0 ? 'sur' : 'norte'}, longitud ${decimalComma(Math.abs(lon).toFixed(1))} grados ${lon < 0 ? 'oeste' : 'este'}`,
    body: (p) => {
      const details = [p.where, p.depthKm !== null ? `profundidad ${kilometers(p.depthKm)}` : null, p.magnitude !== null ? `magnitud ${decimalComma(p.magnitude)}` : null]
        .filter((s): s is string => s !== null && s !== '')
      return `Terremoto${p.when ? ` alrededor ${around(p.when)}` : ''}${details.length > 0 ? `: ${details.join(', ')}` : ''}. ${p.evaluation !== null ? `${p.evaluation}.` : `Se ha emitido la ${INTERNATIONAL_TSUNAMI}.`}`
    },
  },
  timeSignal: {
    // 1 時台だけ単数の冠詞（「Es la 1:30」）
    say: (phrase, hour, minute, clock) => {
      const t = signalClock(hour, minute, clock)
      const one = isOneOClock(t)
      switch (phrase) {
        case 'oshirase': return `Hora exacta: ${one ? 'la' : 'las'} ${t}.`
        case 'desu': return `${one ? 'Es la' : 'Son las'} ${t}.`
        case 'narimashita': return `Ya ${one ? 'es la' : 'son las'} ${t}.`
        case 'bare': return `${one ? 'La' : 'Las'} ${t}`
      }
    },
  },
}
