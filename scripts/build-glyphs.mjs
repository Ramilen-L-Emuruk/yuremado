// 地名ラベル用 SDF グリフ PBF を事前生成する（§8 テキスト描画 B案・移行計画 docs/webgl-rendering-migration-plan.md §8）。
//
// 背景: MapLibre は glyphs 未設定だと text-font の文字を実行時に TinySDF でクライアント
// ラスタライズする。日本語（漢字数百字）の初回生成が実機 Surface Go 2 で 75〜260ms のメイン
// スレッドブロックを生み、区域名初出＝地震検知の自動ズームと重なる最悪局面で 100〜260ms 停止し
// うる（実機計測 docs/webgl-production-build-measure-result 系・計画書 §8）。B案は SDF グリフを
// ビルド時に PBF へ焼き、実行時はフェッチするだけにして生成スパイクを恒久的に消す。
//
// 生成器: @mapbox/tiny-sdf（MapLibre 本体が使うのと同一の SDF 生成器。fontSize24/buffer3/
// radius8/cutoff0.25 の既定でグリフ PBF フォーマットにそのまま対応）。Node には DOM canvas が
// 無いため document.createElement('canvas') を @napi-rs/canvas（プリビルド配布・native コンパイル
// 不要）でシムする。標準の node-fontnik は native ビルドが Node 24 で通らず不採用（この経路なら
// Windows 開発機でも Linux CI でも同一スクリプトが動く）。
//
// 出力: public/fonts/<組>/<start>-<end>.pbf（MapLibre の glyphs URL 規約）。組（フォントスタック）ごとに、
//       その組で描く字を含む 256 ブロックだけを生成する（ラベルは既知有限集合のため軽量）。
//
// 組は 2 種類ある（組の名前の単一情報源は src/components/Map/gl/fontStack.ts）:
//   - M PLUS Rounded 1c（JP_FONT_STACK）: 日本語の地方名・県名・区域名・震度の字・英字の言語の訳。
//   - 言語ごとの組（PLACE_LABEL_FONT_STACKS。Noto Sans SC/TC/KR Black）: その言語の地方名（辞書の map.regionName）・県名・区域名の訳だけ。
//     M PLUS に無い字（简体の县・한글など）を使うため（2026-11-15 ユーザー承認）。
//     訳の無い名前（日本語のまま）は M PLUS の組で描くので、こちらには焼かない。
//
// 使い方:
//   node scripts/build-glyphs.mjs                    # 既定: 同梱のフォントで全部の組を焼く
//   GLYPH_FONT=path/to/Other.ttf \                   # M PLUS の組だけ別フォントで焼く場合のみ上書き
//     GLYPH_FAMILY="Internal Family" GLYPH_STACK="Other Family" node scripts/build-glyphs.mjs
//
// 本番フォント: 再配布可能なフォント（OFL 1.1）を scripts/fonts/ に同梱し、既定で登録する
// （システム Meiryo / UD デジタル教科書体は再配布不可のため不採用）。M PLUS Rounded 1c ExtraBold は
// 丸ゴシック＋ExtraBold で、暗い地図上の小さな地名ラベル（13〜17px）で輪郭が識別しやすく太さも稼げるため。
// 中韓の組は Noto Sans SC/TC/KR の Black（元のフォントを丸ごと同梱。2026-11-15 ユーザー承認）。
// perf 特性（事前生成で TinySDF スパイクを消す）はフォントに依らず不変。

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PbfReader, PbfWriter } from 'pbf'

// 検証モード（--check）は native 依存（@napi-rs/canvas）を読み込まない。native addon は環境差で読み込みに
// 失敗しうるため、ビルドの前段に置く検証がその都合で巻き添えになることは避けたい。そこで native 依存は
// 動的 import にし、実際に焼くとき（main）だけ読み込む。
// ただし完全に生成物だけで閉じるわけではなく、フォント指紋の照合のため scripts/fonts/ のフォント実体は
// --check でも読む（後述の buildFingerprint）。
const CHECK_ONLY = process.argv.includes('--check')

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const FONTS_DIR = path.join(ROOT, 'scripts', 'fonts')

// SDF パラメータ（MapLibre 既定・サーバーグリフと一致させる）。
const FONT_SIZE = 24
// 【変更禁止】MapLibre クライアントは glyph atlas 構築時にグリフ境界を 3px 固定で前提し、
// ビットマップ寸法を (width+2*3)×(height+2*3) として再計算する（GLYPH_PBF_BORDER=3 の公開規約）。
// ここを変えると PBF に書く width/height と実ビットマップ長の対応が崩れ、無音で描画が壊れる。
const BUFFER = 3
const RADIUS = 8
const CUTOFF = 0.25

// M PLUS の組。GLYPH_FONT にファイルパスが与えられれば登録して使う。既定は本リポジトリに同梱した
// M PLUS Rounded 1c ExtraBold(OFL・再配布可)。これにより `node scripts/build-glyphs.mjs` 一発で
// 開発機でも Linux CI でも同一の glyph を再生成できる（区域名の増減時に回し直す想定）。
const DEFAULT_FONT_FILE = path.join(FONTS_DIR, 'MPLUSRounded1c-ExtraBold.ttf')
const PRIMARY_FONT_FILE = process.env.GLYPH_FONT ?? (fs.existsSync(DEFAULT_FONT_FILE) ? DEFAULT_FONT_FILE : '')

/**
 * 組の定義。
 * - `family`: canvas に渡す「内部」ファミリ名。配布名とフォント内部の名前は一致しないことがある（M PLUS Rounded 1c
 *   ExtraBold は "Rounded Mplus 1c" の weight 800、Noto Sans SC Black は "Noto Sans SC" の weight 900 として登録される）。
 *   ここに配布名を書くと skia がフォントを見つけられず、例外を出さないまま別フォントで焼いてしまうため実測値を使う。
 * - `weight`: 暗い地図の上の小さなラベルでも読めるよう、太いウェイトを使う。tiny-sdf は
 *   canvas の font 文字列にこの値を渡し、napi-rs/canvas (skia) が登録済みフォントから該当ウェイトを選ぶ
 *   （同梱フォントはどれも 1 ウェイト単体なので、変えるなら対応ウェイトのフォントも差し替えること）。
 * - `license`: OFL 1.1 第2条は、フォントソフトウェアの派生物を配布する各コピーに著作権表示とライセンス全文を
 *   添付することを求める。エンドユーザーへ実際に配信されるのは public/fonts/<組>/ 配下の SDF 派生物なので、
 *   ライセンス文を出力先にも複製する（scripts/fonts/ はビルド時ソースで配信対象外のため）。
 */
const PRIMARY = {
  stack: process.env.GLYPH_STACK ?? 'M PLUS Rounded 1c',
  file: PRIMARY_FONT_FILE,
  family: process.env.GLYPH_FAMILY ?? 'Rounded Mplus 1c',
  weight: process.env.GLYPH_WEIGHT ?? '800',
  // GLYPH_FONT で別フォントに差し替えた場合は同梱ライセンスと対応しなくなるので複製しない。
  // 判定は path.resolve で正規化してから行う（GLYPH_FONT に相対パスやフォワードスラッシュで同じ
  // ファイルを指定されたとき、素の文字列比較では別物と見なされ複製が漏れるため）。
  license:
    PRIMARY_FONT_FILE !== '' && path.resolve(PRIMARY_FONT_FILE) === path.resolve(DEFAULT_FONT_FILE)
      ? path.join(FONTS_DIR, 'OFL.txt')
      : '',
}
/** 言語ごとの組（組の名前 → フォント）。どの言語がどの組かは fontStack.ts の PLACE_LABEL_FONT_STACKS が決める */
const LOCALE_FONTS = {
  'Noto Sans SC Black': { file: 'NotoSansSC-Black.otf', family: 'Noto Sans SC', weight: '900' },
  'Noto Sans TC Black': { file: 'NotoSansTC-Black.otf', family: 'Noto Sans TC', weight: '900' },
  'Noto Sans KR Black': { file: 'NotoSansKR-Black.otf', family: 'Noto Sans KR', weight: '900' },
}
const NOTO_LICENSE = path.join(FONTS_DIR, 'NotoSansCJK-OFL.txt')

// フォントスタック名の単一情報源(src/components/Map/gl/fontStack.ts)と、これから出力する組が一致することを
// ビルド時に照合する。ずれると MapLibre は該当テキストを無音で描かなくなる(glyphs URL の {fontstack} と
// public/fonts/<stack>/ が食い違うサイレント障害)ため、ここで早期失敗させる。.mjs は .ts を import できない
// ためソースを読んでリテラルを取り出して突き合わせる。
const FONT_STACK_SRC = fs.readFileSync(path.join(ROOT, 'src', 'components', 'Map', 'gl', 'fontStack.ts'), 'utf8')
function readAppFontStack() {
  const m = FONT_STACK_SRC.match(/JP_FONT_STACK\s*=\s*'([^']+)'/)
  if (!m) throw new Error('fontStack.ts から JP_FONT_STACK を読み取れなかった')
  return m[1]
}
/** fontStack.ts の PLACE_LABEL_FONT_STACKS（言語 → 組の名前）。読めなければ止める */
function readLocaleFontStacks() {
  const block = FONT_STACK_SRC.match(/PLACE_LABEL_FONT_STACKS[^=]*=\s*\{\r?\n([^}]*)\r?\n\}/)
  // 1 行に 1 言語（`'言語': '組の名前',`）だけを許す。読めない行があれば止める（コメントや別の書き方を黙って読み飛ばさない）
  const lines = block ? block[1].split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '') : []
  const pairs = lines.map((l) => {
    const m = l.match(/^'?([A-Za-z-]+)'?\s*:\s*'([^']+)',?$/)
    if (!m) throw new Error(`fontStack.ts の PLACE_LABEL_FONT_STACKS に読めない行がある: ${l}（1 行に 1 言語の \`'言語': '組の名前',\` で書くこと）`)
    return [m[1], m[2]]
  })
  if (pairs.length === 0) throw new Error('fontStack.ts から PLACE_LABEL_FONT_STACKS を読み取れなかった')
  return new Map(pairs)
}
const APP_FONT_STACK = readAppFontStack()
if (PRIMARY.stack !== APP_FONT_STACK) {
  throw new Error(
    `フォントスタック名の不一致: build-glyphs の STACK="${PRIMARY.stack}" ≠ アプリの JP_FONT_STACK="${APP_FONT_STACK}"。` +
      `public/fonts/<stack>/ と text-font がずれるとテキストが無音で消える。fontStack.ts と GLYPH_STACK/GLYPH_FAMILY を揃えること。`,
  )
}
const LOCALE_STACK_OF = readLocaleFontStacks()
{
  const appStacks = new Set(LOCALE_STACK_OF.values())
  const unknown = [...appStacks].filter((s) => !(s in LOCALE_FONTS))
  const unused = Object.keys(LOCALE_FONTS).filter((s) => !appStacks.has(s))
  if (unknown.length || unused.length) {
    throw new Error(
      `言語ごとの組がアプリと食い違う: フォントの無い組 ${unknown.join(', ') || '(なし)'} / アプリが使わない組 ${unused.join(', ') || '(なし)'}。` +
        'fontStack.ts の PLACE_LABEL_FONT_STACKS と build-glyphs.mjs の LOCALE_FONTS を揃えること。',
    )
  }
  // 組を持つのに訳さない言語があると、その組には ASCII しか焼かれず、検査も通ってしまう
  const labelLocales = new Set(readLabelLocales())
  const notLabeled = [...LOCALE_STACK_OF.keys()].filter((l) => !labelLocales.has(l))
  if (notLabeled.length) {
    throw new Error(`PLACE_LABEL_FONT_STACKS の言語が MAP_LABEL_LOCALES に無い: ${notLabeled.join(', ')}。訳さない言語に組を持たせないか、MAP_LABEL_LOCALES に足すこと。`)
  }
}

/** 焼く組の一覧（M PLUS の組が先頭） */
const STACKS = [
  PRIMARY,
  ...Object.entries(LOCALE_FONTS).map(([stack, f]) => ({ stack, file: path.join(FONTS_DIR, f.file), family: f.family, weight: f.weight, license: NOTO_LICENSE })),
]
const outDirOf = (stack) => path.join(ROOT, 'public', 'fonts', stack.stack)

/**
 * グリフ生成に必要な native 依存を読み込み、全部の組のフォントを登録して設定の整合を検証する。
 * 検証モード（--check）からは呼ばない（生成物を読むだけの処理を native の可用性に依存させないため）。
 * @returns TinySDF コンストラクタ
 */
async function setupFonts() {
  const { createCanvas, GlobalFonts } = await import('@napi-rs/canvas')
  // tiny-sdf は document.createElement('canvas') を使うため Node 上でシムする。
  globalThis.document = {
    createElement(tag) {
      if (tag !== 'canvas') throw new Error(`想定外の要素: ${tag}`)
      return createCanvas(1, 1)
    },
  }
  for (const s of STACKS) {
    const familiesBefore = new Set(GlobalFonts.families.map((f) => f.family))
    if (s.file) {
      const ok = GlobalFonts.registerFromPath(path.resolve(s.file))
      if (!ok) throw new Error(`フォントを登録できなかった: ${s.file}`)
    }
    // registerFromPath が成功しても、canvas に渡す family がフォント内部の名前と食い違っていれば skia は
    // 例外を投げずシステム既定フォントで描いてしまう（実測で確認済み。配布名 "M PLUS Rounded 1c" を渡すと
    // 別形状のグリフが無言で生成された）。ビルドは成功ログを出したまま全グリフが化けるため、登録結果と
    // 突き合わせてここで失敗させる。フォント未指定時はシステム側の全ファミリを対象にする。
    const candidates = s.file ? GlobalFonts.families.filter((f) => !familiesBefore.has(f.family)) : GlobalFonts.families
    const matched = candidates.find((f) => f.family === s.family)
    if (!matched) {
      throw new Error(
        `フォントファミリ名の不一致（組 "${s.stack}"）: family="${s.family}" が見つからない。skia は例外を出さず別フォントで` +
          `焼くため停止する。${
            s.file
              ? `${path.basename(s.file)} が登録したファミリ: ${candidates.map((f) => f.family).join(' / ') || '(なし)'}` +
                (familiesBefore.has(s.family) ? `（同じ名前の "${s.family}" が登録の前から入っている。端末に入っている同名の書体が先に読まれた可能性がある）` : '')
              : 'GLYPH_FONT でフォントファイルを指定するか、GLYPH_FAMILY を実在するファミリ名にすること。'
          }`,
      )
    }
    // ウェイトも同様に無言で代替される（同梱フォントは 1 ウェイト単体なので、別の値を渡しても同じ字形が
    // 返るだけで指定ミスに気付けない）。持っていないウェイトを要求していたら止める。
    if (!matched.styles.some((st) => String(st.weight) === s.weight)) {
      throw new Error(
        `フォントウェイトの不一致（組 "${s.stack}"）: weight=${s.weight} は "${s.family}" に存在しない` +
          `（利用可能: ${matched.styles.map((st) => st.weight).join(' / ')}）。skia が近いウェイトで無言に代替するため停止する。`,
      )
    }
  }
  return (await import('@mapbox/tiny-sdf')).default
}

const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), 'utf8'))

/** 地図のラベルを訳す言語（src/i18n/placeNames.ts の MAP_LABEL_LOCALES）。読めなければ止める */
function readLabelLocales() {
  // .mjs は .ts を import できないためソースから一覧を取り出す。読めなければ止める——読めないまま進むと、
  // 訳の字が欠けて空白の混ざったラベルになるのに検査は通ってしまう
  const placeNamesSrc = fs.readFileSync(path.join(ROOT, 'src', 'i18n', 'placeNames.ts'), 'utf8')
  const localesMatch = placeNamesSrc.match(/MAP_LABEL_LOCALES:[^=]*=\s*\[([^\]]*)\]/)
  const labelLocales = localesMatch ? [...localesMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : []
  if (labelLocales.length === 0) throw new Error('placeNames.ts から MAP_LABEL_LOCALES を読み取れなかった')
  return labelLocales
}

/** その言語の県名・区域名の訳の字を足す */
function addTranslations(locale, add) {
  const table = readJson('public', 'data', 'place-names', `${locale}.json`)
  for (const kind of ['pref', 'area']) Object.values(table[kind]).forEach(add)
}

/**
 * その言語の辞書（src/i18n/messages/<言語>.ts）の map.regionName から、地方名の訳を読む。.mjs は .ts を import できないので
 * ソースを読む。地方（regions.ts の REGIONS）の数とそろわなければ止める（訳の欠けた地方が空白で描かれるのを防ぐ）
 */
function readRegionTranslations(locale, regionNames) {
  const file = path.join(ROOT, 'src', 'i18n', 'messages', `${locale.replace('-', '')}.ts`)
  const block = fs.readFileSync(file, 'utf8').match(/regionName:\s*\{([^}]*)\}/)
  if (!block) throw new Error(`${file} から map.regionName を読み取れなかった`)
  // 読めるのは「鍵: '値',」の形だけ。逃がし文字・二重引用符・テンプレート文字列・コメントがあれば、途中で切れた字を焼かないよう止める
  if (/[\\"`]|\/\//.test(block[1])) throw new Error(`${file} の map.regionName に読めない書き方がある（値は ' で囲み、\\・"・\`・コメントを使わないこと）`)
  const entries = new Map([...block[1].matchAll(/([^\s,:']+):\s*'([^']+)'/g)].map((m) => [m[1], m[2]]))
  const missing = regionNames.filter((n) => !entries.has(n))
  if (missing.length) throw new Error(`${file} の map.regionName に地方 ${missing.join('・')} の訳が無い`)
  return regionNames.map((n) => entries.get(n))
}

/** 組ごとに、その組で描く Unicode コードポイント集合を集める（組の名前 → 集合）。 */
function collectCodepoints() {
  const sets = new Map(STACKS.map((s) => [s.stack, new Set()]))
  const adder = (stack) => (s) => {
    for (const ch of s) sets.get(stack).add(ch.codePointAt(0))
  }
  const add = adder(PRIMARY.stack)
  // 地方 14（気象庁の地方予報区）。単一情報源 src/utils/regions.ts の REGIONS から名前を読む（リテラル再定義だと LabelsGL が
  // 使う REGIONS と非連動になり、地方区分変更時に新しい地方名だけ空白表示になる。.mjs は .ts を import
  // できないためソースを読んで name を取り出す）。
  const regionsSrc = fs.readFileSync(path.join(ROOT, 'src', 'utils', 'regions.ts'), 'utf8')
  const regionNames = [...regionsSrc.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1])
  if (regionNames.length === 0) throw new Error('regions.ts から地方名を読み取れなかった')
  regionNames.forEach(add)
  // 震度ラベル（poc/label.ts の INTENSITY_LABELS と一致）
  ;['1', '2', '3', '4', '5弱', '5強', '6弱', '6強', '7'].forEach(add)
  // 県 47（prefectures.json のキー）。訳の無い名前は日本語のまま M PLUS の組で描く
  Object.keys(readJson('public', 'data', 'prefectures.json')).forEach(add)
  // 区域 192（subregions.json の name）
  for (const s of readJson('public', 'data', 'subregions.json')) add(s.name)
  // 県名・区域名の訳。自分の組を持つ言語はその組へ、ほかは M PLUS の組へ。
  // 自分の組を持たない言語の訳に、日本語の地名に無い漢字・ハングルなど（U+2E80 以降）が来たら止める。M PLUS に字形が無いと、
  // 空白で焼けるか、skia が別の書体で黙って補うかのどちらかで、どちらも検査を通りうるため（中韓は言語ごとの組を足して描く）
  const japaneseChars = new Set(sets.get(PRIMARY.stack))
  for (const locale of readLabelLocales()) {
    const own = LOCALE_STACK_OF.get(locale)
    if (own) {
      addTranslations(locale, adder(own))
      // 地方名の訳（辞書の map.regionName）もその言語の組で描く（LabelsGL の regionFont）
      readRegionTranslations(locale, regionNames).forEach(adder(own))
      continue
    }
    const foreign = new Set()
    addTranslations(locale, (s) => {
      for (const ch of s) if (ch.codePointAt(0) >= 0x2e80 && !japaneseChars.has(ch.codePointAt(0))) foreign.add(ch)
    })
    if (foreign.size) {
      throw new Error(
        `言語 ${locale} の訳に、日本語の地名に無い字が ${foreign.size} 字ある（${[...foreign].slice(0, 20).join('')}）。` +
          'M PLUS の組では描けないので、fontStack.ts の PLACE_LABEL_FONT_STACKS にその言語の組を足すこと。',
      )
    }
    addTranslations(locale, add)
  }
  // ASCII 基本ラテン（数字・記号の保険）。どの組にも入れる
  for (const set of sets.values()) for (let c = 0x20; c < 0x7f; c++) set.add(c)
  return sets
}

/** codepoint 集合を 256 ブロック単位に振り分ける。 */
function groupByBlock(cps) {
  const blocks = new Map() // block -> number[]
  for (const cp of cps) {
    const b = Math.floor(cp / 256)
    if (!blocks.has(b)) blocks.set(b, [])
    blocks.get(b).push(cp)
  }
  return blocks
}

/** 1 グリフを PBF へ書く（glyphs.proto の glyph メッセージ）。 */
function writeGlyph(g, pbf) {
  pbf.writeVarintField(1, g.id)
  if (g.bitmap && g.bitmap.length) pbf.writeBytesField(2, g.bitmap)
  pbf.writeVarintField(3, g.width)
  pbf.writeVarintField(4, g.height)
  pbf.writeSVarintField(5, g.left)
  pbf.writeSVarintField(6, g.top)
  pbf.writeVarintField(7, g.advance)
}

/** 1 fontstack を PBF へ書く（glyphs.proto の fontstack メッセージ）。 */
function writeStack(stack, pbf) {
  pbf.writeStringField(1, stack.name)
  pbf.writeStringField(2, stack.range)
  for (const g of stack.glyphs) pbf.writeMessage(3, writeGlyph, g)
}

/** glyphs（トップレベル・stacks は repeated fontstack= field 1）を書く。 */
function writeGlyphsProto(data, pbf) {
  pbf.writeMessage(1, writeStack, data)
}

/** 1 つの組を焼く */
function bakeStack(TinySDF, s, cps) {
  const sdf = new TinySDF({
    fontSize: FONT_SIZE,
    buffer: BUFFER,
    radius: RADIUS,
    cutoff: CUTOFF,
    fontFamily: s.family,
    fontWeight: s.weight,
  })
  const outDir = outDirOf(s)
  const blocks = groupByBlock(cps)
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
  if (s.license) {
    // ライセンス文の無い派生物を配らない（OFL 1.1 第2条）。黙って飛ばさずに止める
    if (!fs.existsSync(s.license)) throw new Error(`組 "${s.stack}" のライセンス文が無い: ${s.license}`)
    fs.copyFileSync(s.license, path.join(outDir, 'OFL.txt'))
  }

  // 焼いた条件を残す（--check がこれと現在の設定を突き合わせ、フォント差し替え後の焼き直し忘れを検知する）。
  fs.writeFileSync(path.join(outDir, BUILD_INFO_FILE), `${JSON.stringify(buildFingerprint(s), null, 2)}\n`)

  const sortedBlocks = [...blocks.keys()].sort((a, b) => a - b)
  let totalGlyphs = 0
  let bytes = 0
  for (const b of sortedBlocks) {
    const start = b * 256
    const end = start + 255
    const glyphs = []
    for (const cp of blocks.get(b).sort((a, c) => a - c)) {
      const d = sdf.draw(String.fromCodePoint(cp))
      glyphs.push({
        id: cp,
        bitmap: Buffer.from(d.data.buffer, d.data.byteOffset, d.data.byteLength),
        width: d.glyphWidth,
        height: d.glyphHeight,
        left: d.glyphLeft,
        top: d.glyphTop,
        // advance は unsigned varint で書くため負値を渡すと桁あふれする。異常系フォントで
        // measureText().width が負を返しても安全側に倒す。
        advance: Math.max(0, Math.round(d.glyphAdvance)),
      })
    }
    const pbf = new PbfWriter()
    writeGlyphsProto({ name: s.stack, range: `${start}-${end}`, glyphs }, pbf)
    const buf = pbf.finish()
    bytes += buf.length
    fs.writeFileSync(path.join(outDir, `${start}-${end}.pbf`), buf)
    totalGlyphs += glyphs.length
  }
  console.log(
    `グリフを作った: stack="${s.stack}" font="${s.file || s.family}" weight=${s.weight} ` +
      `codepoints=${cps.size} blocks=${sortedBlocks.length} glyphs=${totalGlyphs} ${(bytes / 1024).toFixed(0)}KB -> public/fonts/${s.stack}/`,
  )
}

async function main() {
  const TinySDF = await setupFonts()
  const sets = collectCodepoints()
  for (const s of STACKS) bakeStack(TinySDF, s, sets.get(s.stack))
}

// 半角スペースは字形を持たないため幅・高さ 0 で焼かれるのが正常（実測でも空になるのはこれだけ）。
// 下の「空グリフ」検査から除外する。
const SPACE_CODEPOINT = 0x20

// グリフを焼いた条件を残すファイル（出力先に置く）。MapLibre は <start>-<end>.pbf しか取りに行かないため、
// 同居させてもグリフ取得には影響しない。**生成物と一緒にコミットすること**（CI は --check しか実行せず、
// このファイルが無いと「焼いた条件を確認できない」で停止する）。
const BUILD_INFO_FILE = 'build-info.json'

/**
 * 焼いたときの条件（フォント実体・ファミリ・ウェイト・SDF パラメータ）の指紋。
 *
 * 収録文字が同じでも、フォントやウェイトを差し替えて焼き直しを忘れれば、字形だけが古いまま配信される。
 * 「どの文字が入っているか」を見る検査では捕まえられないため、生成時に指紋を残して --check で照合する。
 * フォントはファイル名が同じでも中身が変わりうるのでハッシュを取る。
 *
 * 注意: これにより --check は scripts/fonts/ のフォント実体にも依存する（生成物だけでは完結しない）。
 */
function buildFingerprint(s) {
  // GLYPH_FONT で明示指定された場合は存在チェックを経ていないため、ここで確認する。
  // これが無いと readFileSync の生の ENOENT になり、他の失敗系と違って何をすべきか分からない。
  if (s.file && !fs.existsSync(s.file)) {
    throw new Error(`フォントが見つからない: ${s.file}（組 "${s.stack}"。GLYPH_FONT の指定を確認すること）。指紋の照合にはフォント実体が要る。`)
  }
  return {
    font: s.file ? path.basename(s.file) : '(system font)',
    fontSha256: s.file ? crypto.createHash('sha256').update(fs.readFileSync(s.file)).digest('hex') : '',
    family: s.family,
    weight: s.weight,
    sdf: { fontSize: FONT_SIZE, buffer: BUFFER, radius: RADIUS, cutoff: CUTOFF },
  }
}

/** 指紋を 1 行で読める形にする（食い違いをその場で見比べられるように）。 */
function describeFingerprint(f) {
  const sha = String(f?.fontSha256 ?? '').slice(0, 12) || '-'
  const sdf = f?.sdf ?? {}
  return `font=${f?.font} sha=${sha} family="${f?.family}" weight=${f?.weight} sdf=${sdf.fontSize}/${sdf.buffer}/${sdf.radius}/${sdf.cutoff}`
}

/**
 * 指紋の相違点を列挙する（JSON 文字列の比較だとキーの並び順を変えられただけで誤検知するため、
 * 値そのものを項目ごとに突き合わせる）。
 */
function diffFingerprints(recorded, current) {
  const differences = []
  for (const key of ['font', 'fontSha256', 'family', 'weight']) {
    if (String(recorded?.[key] ?? '') !== String(current[key])) differences.push(key)
  }
  for (const key of ['fontSize', 'buffer', 'radius', 'cutoff']) {
    if (Number(recorded?.sdf?.[key]) !== current.sdf[key]) differences.push(`sdf.${key}`)
  }
  return differences
}

/**
 * 生成済み PBF から収録グリフを読み出す（glyphs.proto: fontstack=1 / glyphs=3 / id=1・width=3・height=4）。
 * PbfReader.readFields はコールバックが読まなかったフィールドを自動でスキップするため、必要な階層だけ辿る。
 *
 * 幅・高さまで読むのは、id は書かれているのに中身が空というグリフを見分けるため。writeGlyph は id を
 * 常に書く一方でビットマップは空なら省くので、id の有無だけを見ると「収録済みだが画面では空白」を
 * 収録済みと誤判定する。
 */
function readGlyphs(buf) {
  const glyphs = []
  new PbfReader(buf).readFields((tag, _res, pbf) => {
    if (tag !== 1) return
    pbf.readMessage((stackTag, _r, stackPbf) => {
      if (stackTag !== 3) return
      const g = { id: -1, width: 0, height: 0 }
      stackPbf.readMessage((glyphTag, _r2, glyphPbf) => {
        if (glyphTag === 1) g.id = glyphPbf.readVarint()
        else if (glyphTag === 3) g.width = glyphPbf.readVarint()
        else if (glyphTag === 4) g.height = glyphPbf.readVarint()
      }, null)
      if (g.id >= 0) glyphs.push(g)
    }, null)
  }, null)
  return glyphs
}

/**
 * ラベルに必要な文字が、組ごとに生成済みグリフに全て収録されているかを検証する（--check）。
 *
 * 地名（地方・県・区域）を増減したのに再生成を忘れると、その文字は MapLibre 側でエラーにならず
 * 静かに欠ける（既存の 256 文字ブロック内に落ちた場合は警告すら出ない）。型チェックもビルドも通って
 * しまうため、ビルドの前段でここを機械的に突き合わせる。実際に配信される PBF を読んで確認する。
 */
function checkStack(s, required) {
  const outDir = outDirOf(s)
  if (!fs.existsSync(outDir)) {
    throw new Error(
      `グリフ未生成: public/fonts/${s.stack}/ が存在しない。` +
        '`node scripts/build-glyphs.mjs` を実行すること' +
        '（別のフォントスタック名で生成した名残が残っているだけの場合は、その古いディレクトリを削除すること）。',
    )
  }
  const present = new Map()
  for (const file of fs.readdirSync(outDir)) {
    if (!file.endsWith('.pbf')) continue
    for (const g of readGlyphs(fs.readFileSync(path.join(outDir, file)))) present.set(g.id, g)
  }
  const describe = (cps) => cps.map((cp) => `${String.fromCodePoint(cp)}(U+${cp.toString(16).toUpperCase()})`).join(' ')

  const missing = [...required].filter((cp) => !present.has(cp))
  if (missing.length > 0) {
    throw new Error(
      `グリフ未生成の文字が ${missing.length} 件ある（組 "${s.stack}"）: ${describe(missing)}\n` +
        '地名データを更新したら `node scripts/build-glyphs.mjs` で焼き直すこと' +
        '（このまま配信すると、ラベル上でその文字だけが無警告で空白になる）。',
    )
  }
  // 収録されていても中身が空（幅・高さが 0）なら、その文字は画面上で空白になる。フォント側に字形が
  // 無いまま焼いた場合に起こるため、収録の有無とは別に検査する。
  const blank = [...required].filter(
    (cp) => cp !== SPACE_CODEPOINT && present.get(cp).width === 0 && present.get(cp).height === 0,
  )
  if (blank.length > 0) {
    throw new Error(
      `字形が空のグリフが ${blank.length} 件ある（組 "${s.stack}"）: ${describe(blank)}\n` +
        '使用中のフォントに該当する字形が無い可能性がある' +
        '（収録はされているため取りこぼしには見えないが、ラベル上では空白で描かれる）。',
    )
  }
  // ここまでで「どの文字が入っているか」は保証できるが、フォント自体を差し替えて焼き直しを忘れた場合は
  // 収録も字形も揃ったまま形だけが古い。生成時に残した指紋と現在の設定を突き合わせて検知する。
  const infoPath = path.join(outDir, BUILD_INFO_FILE)
  if (!fs.existsSync(infoPath)) {
    throw new Error(
      `${BUILD_INFO_FILE} が無く、組 "${s.stack}" のグリフを焼いた条件を確認できない（生成物と一緒にコミットし忘れた可能性）。` +
        '`node scripts/build-glyphs.mjs` で焼き直すこと。',
    )
  }
  let recorded
  try {
    // Windows のエディタ等で保存し直されると先頭に BOM が付き、JSON.parse はこれを受け付けない。
    // 内容としては壊れていないので取り除いてから読む。
    recorded = JSON.parse(fs.readFileSync(infoPath, 'utf8').replace(/^﻿/, ''))
  } catch (e) {
    // 壊れた JSON をそのまま投げると用途不明な SyntaxError になる。どのファイルをどうすべきか添える。
    throw new Error(`${infoPath} を読めない（内容が壊れている）。\`node scripts/build-glyphs.mjs\` で焼き直すこと。 — ${e.message}`)
  }
  const current = buildFingerprint(s)
  const differences = diffFingerprints(recorded, current)
  if (differences.length > 0) {
    throw new Error(
      `組 "${s.stack}" のグリフを焼いた条件が現在の設定と食い違う（収録文字は足りているが、字形が古いまま配信される）。\n` +
        `  相違点  : ${differences.join(', ')}\n` +
        `  焼いた時: ${describeFingerprint(recorded)}\n` +
        `  現在    : ${describeFingerprint(current)}\n` +
        '`node scripts/build-glyphs.mjs` で焼き直すこと。',
    )
  }

  if (s.license && !fs.existsSync(path.join(outDir, 'OFL.txt'))) {
    throw new Error(`組 "${s.stack}" の出力先に OFL.txt が無い（ライセンス文の無い派生物を配ることになる）。\`node scripts/build-glyphs.mjs\` で焼き直すこと。`)
  }

  // 余分は害がない（使われなくなった文字が残っているだけ）ので停止はしない。再生成の目安として報告する。
  const extra = [...present.keys()].filter((cp) => !required.has(cp))
  const extraNote = extra.length > 0 ? ` / 未使用の収録文字 ${extra.length} 件（再生成で除去できる）` : ''
  console.log(`glyphs check: ok — stack="${s.stack}" 必要 ${required.size} 文字が全て収録済み${extraNote}`)
}

function check() {
  const sets = collectCodepoints()
  for (const s of STACKS) checkStack(s, sets.get(s.stack))
}

if (CHECK_ONLY) check()
else await main()
