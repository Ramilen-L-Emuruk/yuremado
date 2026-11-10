import type { Messages } from '../messages'

/** 英語の辞書。気象庁の英語がある語はそれに合わせ、無い語は作った（語ごとの出どころは `docs/spec/i18n-spec.md` §4）。 */
export const en: Messages = {
  nav: {
    earthquake: 'Earthquake Information',
    realtime: 'Real-time',
    tsunami: 'Tsunami Information',
    catalog: 'Hypocenter Catalog',
    settings: 'Settings',
    telegrams: 'Telegram Log',
  },
  navHint: {
    active: (name, collapsed) => `${name} (press again to ${collapsed ? 'expand' : 'collapse'} the panel)`,
  },
  appUpdate: {
    reloadIn: (seconds) => `Reloading in ${seconds} s`,
    updateIn: (seconds) => `Updating in ${seconds} s`,
    later: 'Later',
    newVersion: (version) => (version !== null ? `New version ${version}` : 'New version'),
    whatsNew: "What's new",
    updateNow: 'Update now',
    updatedTo: (version) => `Updated to version ${version}`,
    close: 'Close',
  },
  releaseNotes: {
    titleFor: (version) => `What's new in ${version}`,
    title: "What's new",
    close: 'Close',
    loading: 'Loading',
    loadFailed: "Couldn't load what's new",
    retry: 'Try again',
    minorOnly: 'Minor fixes',
    added: 'Added',
    fixed: 'Fixed',
  },
  errorScreen: {
    rootTitle: 'The screen can no longer be shown',
    rootReceivingStopped: 'Receiving information has also stopped',
    reload: 'Reload',
    cannotShow: (label) => `Can't show ${label}`,
    showAgain: 'Show again',
    reloadMayFix: 'Reloading may fix this',
    mapLabel: 'Map',
  },
  mapCorner: {
    cannotDraw: (names) => `Couldn't draw ${names}`,
    notClickable: (names) => `${names} not responding to clicks`,
    nameList: (shown, rest) => (rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ')),
    loadingData: 'Loading data…',
    updatedAt: (time) => (time !== null ? `Updated ${time}` : 'Waiting for data…'),
    seismoDisconnected: 'Seismometer not connected',
  },
  panelBorder: {
    height: 'Border between the map and the info panel (drag to adjust height, tap to collapse)',
    width: 'Border between the map and the info panel (drag to adjust width, tap to collapse)',
  },
  rangeSlider: {
    lower: 'Start',
    upper: 'End',
    thumb: (label, end) => `${end} of ${label}`,
  },
  replayConfirm: {
    title: 'Replay this earthquake?',
    body: 'While replaying, newly issued earthquake information and Earthquake Early Warnings are not shown.',
    cancel: 'Cancel',
    confirm: 'Replay',
  },
  shareCard: {
    idle: 'Share the map as an image',
    working: 'Creating image',
    error: "Couldn't create the image",
    copied: 'Image saved and text copied',
    copyFailed: "Image saved (couldn't copy the text)",
  },
  usageConsent: {
    title: 'Help us improve Yuremado',
    body: 'Allow sending usage data (tabs opened, features used, settings, device type, etc.) to the developer? Your name, IP address and registered location are not sent. You can change this at any time.',
    privacyPolicy: 'Privacy Policy',
    deny: "Don't allow",
    allow: 'Allow',
  },
}
