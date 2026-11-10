import type { Messages } from '../messages'

/** スペイン語の辞書。気象庁の多言語辞書にある語はそれに合わせ、無い語は作った（語ごとの出どころは `docs/spec/i18n-spec.md` §4）。 */
export const es: Messages = {
  nav: {
    earthquake: 'Información de terremotos',
    realtime: 'Tiempo real',
    tsunami: 'Información del tsunami',
    catalog: 'Catálogo de hipocentros',
    settings: 'Configuración',
    telegrams: 'Registro de telegramas',
  },
  navHint: {
    active: (name, collapsed) => `${name} (pulse de nuevo para ${collapsed ? 'desplegar' : 'plegar'} el panel)`,
  },
  appUpdate: {
    reloadIn: (seconds) => `Recargando en ${seconds} s`,
    updateIn: (seconds) => `Actualizando en ${seconds} s`,
    later: 'Más tarde',
    newVersion: (version) => (version !== null ? `Nueva versión ${version}` : 'Nueva versión'),
    whatsNew: 'Novedades',
    updateNow: 'Actualizar ahora',
    updatedTo: (version) => `Actualizado a la versión ${version}`,
    close: 'Cerrar',
  },
  releaseNotes: {
    titleFor: (version) => `Novedades de ${version}`,
    title: 'Novedades',
    close: 'Cerrar',
    loading: 'Cargando',
    loadFailed: 'No se pudieron cargar las novedades',
    retry: 'Reintentar',
    minorOnly: 'Correcciones menores',
    added: 'Añadido',
    fixed: 'Corregido',
  },
  errorScreen: {
    rootTitle: 'La pantalla ya no se puede mostrar',
    rootReceivingStopped: 'También se detuvo la recepción de información',
    reload: 'Recargar',
    cannotShow: (label) => `No se puede mostrar ${label}`,
    showAgain: 'Mostrar de nuevo',
    reloadMayFix: 'Recargar puede solucionarlo',
    mapLabel: 'Mapa',
  },
  mapCorner: {
    cannotDraw: (names) => `No se pudo dibujar ${names}`,
    notClickable: (names) => `${names} no responde a los clics`,
    nameList: (shown, rest) => (rest > 0 ? `${shown.join(', ')} y ${rest} más` : shown.join(', ')),
    loadingData: 'Cargando datos…',
    updatedAt: (time) => (time !== null ? `Actualizado ${time}` : 'Esperando datos…'),
    seismoDisconnected: 'Sismómetro no conectado',
  },
  panelBorder: {
    height: 'Borde entre el mapa y el panel de información (arrastre para ajustar la altura, toque para plegar)',
    width: 'Borde entre el mapa y el panel de información (arrastre para ajustar el ancho, toque para plegar)',
  },
  rangeSlider: {
    lower: 'Inicio',
    upper: 'Fin',
    thumb: (label, end) => `${end} de ${label}`,
  },
  replayConfirm: {
    title: '¿Reproducir este terremoto?',
    body: 'Durante la reproducción no se muestran la nueva información sísmica ni las alertas tempranas de terremoto.',
    cancel: 'Cancelar',
    confirm: 'Reproducir',
  },
  shareCard: {
    idle: 'Compartir el mapa como imagen',
    working: 'Creando la imagen',
    error: 'No se pudo crear la imagen',
    copied: 'Imagen guardada y texto copiado',
    copyFailed: 'Imagen guardada (no se pudo copiar el texto)',
  },
  usageConsent: {
    title: 'Ayúdenos a mejorar Yuremado',
    body: '¿Permite enviar datos de uso (pestañas abiertas, funciones usadas, ajustes, tipo de dispositivo, etc.) al desarrollador? No se envían su nombre, su dirección IP ni la ubicación registrada. Puede cambiar este ajuste en cualquier momento.',
    privacyPolicy: 'Política de privacidad',
    deny: 'No permitir',
    allow: 'Permitir',
  },
}
