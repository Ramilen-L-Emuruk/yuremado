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
 * `tag` は `<html lang>` と `Intl` に渡す BCP 47 の言語タグ。
 */
export const LOCALES = [
  { id: 'ja', tag: 'ja' },
  { id: 'en', tag: 'en' },
  { id: 'zh-Hans', tag: 'zh-Hans' },
  { id: 'zh-Hant', tag: 'zh-Hant' },
  { id: 'ko', tag: 'ko' },
  { id: 'pt-BR', tag: 'pt-BR' },
  { id: 'es', tag: 'es' },
] as const

export type Locale = (typeof LOCALES)[number]['id']

export const DEFAULT_LOCALE: Locale = 'ja'

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
