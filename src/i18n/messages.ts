import { ja } from './messages/ja'

/**
 * 辞書の形。日本語の辞書（`messages/ja.ts`）から作る。
 *
 * 文字列の値は `string` へ広げ、関数の値は引数と戻り値の型をそのまま保つ。ほかの言語の辞書を
 * `Messages` として書けば、**キーが 1 つ欠けても・余っても・関数の引数が違っても型チェックで落ちる**。
 */
export type Messages = Widen<typeof ja>

type Widen<T> =
  T extends string ? string
  : T extends (...args: infer A) => string ? (...args: A) => string
  : { readonly [K in keyof T]: Widen<T[K]> }

/**
 * 画面に出せる言語。並びは言語を選ぶ欄に出す順。
 *
 * `tag` は `<html lang>` と `Intl` に渡す BCP 47 の言語タグ。`name` は言語を選ぶ欄に出す名前で、
 * **どの言語の画面でもその言語自身の書き方で出す**（読めない言語になった人が自分の言語を見つけられるように。
 * 2026-11-12 ユーザー選択「言語 (Language) (Recommended)」の選択肢の説明）。辞書には置かない。
 */
export const LOCALES = [
  { id: 'ja', tag: 'ja', name: '日本語' },
  { id: 'en', tag: 'en', name: 'English' },
  { id: 'zh-Hans', tag: 'zh-Hans', name: '简体中文' },
  { id: 'zh-Hant', tag: 'zh-Hant', name: '繁體中文' },
  { id: 'ko', tag: 'ko', name: '한국어' },
  { id: 'pt-BR', tag: 'pt-BR', name: 'Português (Brasil)' },
  { id: 'es', tag: 'es', name: 'Español' },
] as const

export type Locale = (typeof LOCALES)[number]['id']

/** 設定に保存する言語。`auto` は端末（ブラウザ）の言語に合わせる。 */
export type LocaleSetting = 'auto' | Locale

export const LOCALE_SETTINGS: readonly LocaleSetting[] = ['auto', ...LOCALES.map((l) => l.id)]

/**
 * 端末の言語が 7 つのどれにも当たらないときの言語（2026-11-12 ユーザー選択「新しい人だけ端末に合わせる (Recommended)」の
 * 説明「7 言語に当たらなければ英語」）。
 */
export const FALLBACK_LOCALE: Locale = 'en'

/**
 * 選んだ言語の辞書を読めず日本語で出しているときに、設定の窓の言語の行へ出す知らせ（日本語の行と英語の行。
 * 2026-11-12 ユーザー選択「日本語＋英語で出す (Recommended)」）。
 * 出すのは選んだ言語の辞書が無いときだけなので、どの言語の辞書にも置かずここに置く（辞書に置くと日本語・英語以外の訳は一度も描かれない）
 */
export const LOCALE_LOAD_FAILED_JA = 'この言語を読み込めないため、日本語で表示しています。回線が戻ると読み込み直します。'
export const LOCALE_LOAD_FAILED_EN = 'Couldn\'t load this language, so the app is shown in Japanese. It will retry when you\'re back online.'

/**
 * ブラウザの言語の並び（`navigator.languages`）を前から見て、最初に当たった言語を返す。どれにも当たらなければ英語。
 *
 * 中国語は文字の種類（`Hans`・`Hant`）があればそれに従い、無ければ台湾・香港・マカオを繁体、それ以外を簡体にする。
 * ポルトガル語はポルトガル式（`pt-PT`）もブラジル式の辞書で出す。
 */
export function localeFromLanguageTags(tags: readonly string[]): Locale {
  for (const raw of tags) {
    const [lang, ...rest] = raw.toLowerCase().split(/[-_]/)
    switch (lang) {
      case 'ja': return 'ja'
      case 'en': return 'en'
      case 'ko': return 'ko'
      case 'es': return 'es'
      case 'pt': return 'pt-BR'
      case 'zh':
        if (rest.includes('hans')) return 'zh-Hans'
        return rest.some((p) => p === 'hant' || p === 'tw' || p === 'hk' || p === 'mo') ? 'zh-Hant' : 'zh-Hans'
    }
  }
  return FALLBACK_LOCALE
}

/** 設定の言語から、画面に出す言語を決める。 */
export function resolveLocale(setting: LocaleSetting, deviceLanguageTags: readonly string[]): Locale {
  return setting === 'auto' ? localeFromLanguageTags(deviceLanguageTags) : setting
}

/** 端末の言語の並び。`navigator.languages` が空の端末では `navigator.language` だけを見る。 */
export function deviceLanguageTags(): readonly string[] {
  if (typeof navigator === 'undefined') return []
  if (navigator.languages && navigator.languages.length > 0) return navigator.languages
  return navigator.language ? [navigator.language] : []
}

/**
 * 日本語以外の辞書の読み込み。日本語の辞書は起動の束に入れ、ほかは選ばれたときに初めて読む
 * （使わない言語の文字列を、全員の起動の束に載せない）。
 */
const LOADERS: Record<Exclude<Locale, 'ja'>, () => Promise<Messages>> = {
  en: () => import('./messages/en').then((m) => m.en),
  'zh-Hans': () => import('./messages/zhHans').then((m) => m.zhHans),
  'zh-Hant': () => import('./messages/zhHant').then((m) => m.zhHant),
  ko: () => import('./messages/ko').then((m) => m.ko),
  'pt-BR': () => import('./messages/ptBR').then((m) => m.ptBR),
  es: () => import('./messages/es').then((m) => m.es),
}

export function isLocale(value: unknown): value is Locale {
  return LOCALES.some((l) => l.id === value)
}

export function localeTag(locale: Locale): string {
  return LOCALES.find((l) => l.id === locale)?.tag ?? 'ja'
}

/** 日本語の辞書。読み込みを待たずに使える（ほかの言語の読み込みが済むまでの表示にも使う）。 */
export const JA_MESSAGES: Messages = ja

/** その言語の辞書を読む。日本語はすぐ返る。 */
export function loadMessages(locale: Locale): Promise<Messages> {
  if (locale === 'ja') return Promise.resolve(JA_MESSAGES)
  // 型を `as` で外した値（保存した設定を読み直した値など）が来ても、同期で投げず拒否で返す
  const load = isLocale(locale) ? LOADERS[locale] : undefined
  if (!load) return Promise.reject(new Error(`言語「${String(locale)}」は表に無い`))
  return load()
}
