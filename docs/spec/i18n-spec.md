# 画面の言語（多言語対応）仕様

> **読み手**: 画面の文言を辞書へ移す人・言語を足す人。**食い違いがある場合は実コードを正とする。**
>
> 関連: 文言の決め方 [`docs/ui-wording-procedure.md`](../ui-wording-procedure.md)・タブが落ちたときの表示 [`architecture-spec.md`](architecture-spec.md)・設定の保存 [`settings-pwa-spec.md`](settings-pwa-spec.md)（言語を選ぶ設定はまだ無い）

## 1. いまの状態

- 仕組み（辞書・配り役・言語の表）はある。**言語を選ぶ設定はまだ無く、画面は日本語で固定**（`src/main.tsx` が `DEFAULT_LOCALE` を配る）。
- 辞書へ移した文言は、ナビのボタン名 6 語だけ（`nav`）。同じ語を各タブが落ちたときの表示（`App.tsx` の `ErrorBoundary` の `label`）にも使う。ほかの画面の文言（地図が落ちたときの「地図」を含む）はコードの中に日本語で書いたまま。
- 言語は日本語・英語・中国語（簡体字）・中国語（繁体字）・韓国語・ポルトガル語（ブラジル式）・スペイン語の 7 つ。日本語のほかは、気象庁の多言語辞書が持つ 6 言語（英語・中国語 2 字体・韓国語・ポルトガル語・スペイン語。辞書のやさしい日本語は数えていない）と同じ。
- 言語を決めた問いと答え（どれも 2026-11-10 ユーザー選択）:
  - 日本語に足す言語は →「英語・中国語・韓国語」
  - 中国語の字体は →「簡体字と繁体字の両方 (Recommended)」
  - 辞書にあるスペイン語・ポルトガル語を足すか →「両方足す (Recommended)」
  - ポルトガル語はブラジル式か本国式か →「ブラジル式・pt-BR (Recommended)」
    - 選ぶときに示した数字: 法務省「令和6年6月末現在における在留外国人数」の国籍別の表で、ブラジルは 212,325 人（5 位）。ポルトガルは表に載る 20 か国・地域に入らず、最小の英国 19,587 人より少ない（控えは `.cache/language-demand-stats/`。メインの checkout）

## 2. 作り（`src/i18n/`）

| ファイル | 役割 |
|---|---|
| `messages/ja.ts` | 日本語の辞書。**この形が正** |
| `messages.ts` | 辞書の型 `Messages`・言語の表 `LOCALES`・読み込み `loadMessages` |
| `messages/en.ts` ほか | 日本語以外の辞書。`Messages` として書く |
| `I18nProvider.tsx` | 言語を配る。`useMessages()` で辞書を、`useLocale()` で言語を引く |

- **辞書の型は日本語の辞書から作る。** ほかの言語の辞書でキーが欠けても、余っても、関数の引数が違っても型チェックで落ちる（`messages.test.ts` が固定する）。
- **値が入る文は、言語ごとの関数で書く**（いまの辞書にはまだ無い。足すときの決まり）。差し込みの書式（`{n}` など）は決めない。語順や助数詞は言語ごとに、その言語の文として組み立てる。英語の単数・複数は `Intl.PluralRules` で分ける。
- **日本語の辞書は起動の束に入れ、ほかの言語は選ばれたときに初めて読む**（`import()`）。使わない言語の文字列を、全員の起動の束に載せない。
- **読み込みが済むまでと読めなかったときは日本語で出す**（別の言語を出していた後でも日本語へ戻す）。読めなければ `[i18n]` のログを残す。表に無い言語を渡された `loadMessages` は、投げずに拒否で返す。
- `<html lang>` は、いま出している辞書の言語に合わせる（`LOCALES` の `tag`）。
- 配り役の外で `useMessages()` を呼ぶと日本語の辞書が返る（部品だけを描くテストで落ちない）。

## 3. 言語を足すとき

1. `messages/<名前>.ts` を `Messages` として書く
2. `messages.ts` の `LOCALES` に 1 行、`LOADERS` に 1 行足す

辞書の形がそろっているかは型チェックと `npm test` が見る。

## 4. 語の出どころ

**自分で訳語を作らない。** 先に気象庁の語を探す（利用者向けの文言の決め方は [`docs/ui-wording-procedure.md`](../ui-wording-procedure.md)）。

| 出どころ | 中身 | 控え |
|---|---|---|
| 気象庁「緊急地震速報・津波警報の多言語辞書」（平成27年10月29日版。気象庁・内閣府・観光庁） | 緊急地震速報・津波警報の用語・定型文・取るべき行動。英語・中国語（簡体字・繁体字）・韓国語・ポルトガル語・スペイン語・やさしい日本語。地名の表は無い | `.cache/jma-tagengo-dictionary/`（メインの checkout） |
| 気象庁サイトの JSON（`www.jma.go.jp/bosai/quake/data/list.json` と地震・津波の報ごとの JSON。2026-11-10 に 3 本を見た） | 一覧の題名・震央の英語（`en_ttl`・`en_anm`。空の項目もある）、報ごとの JSON の震央・都道府県・細分区域・市町村・震度観測点・津波予報区の英語名（`enName`）、決まった付加文の英語（`enText`）。見た津波の 1 本では、自由文（`FreeFormComment`）に英語の欄が無かった | `.cache/jma-bosai-en/`（メインの checkout） |

未確認:

- 地名の英語名を全件まとめた表があるか（報ごとの JSON には、その報に出た分しか無い）
- 地名の中国語・韓国語
- 訪日客の国別の数（JNTO の 2025 年の表は文字に起こせたが、列と値の対応が崩れ、スペインの行に 224 万人のような有りえない値が並ぶ。どの値がどの国の何の数かを決められていない）
- 下の表の作った語・組み立てた語が、母語話者に自然に読めるか（ポルトガル語・スペイン語の地震情報は、辞書が津波情報の形しか持たないので組み立てた）

### 決めた語（ナビ）

ナビの 6 語の訳案（作った語を含む。出どころを添えて示した）を、2026-11-10 にユーザーが選んだ（英語「気象庁の語に合わせる (Recommended)」・中国語・韓国語・ポルトガル語・スペイン語はいずれも「この案でよい (Recommended)」）。ポルトガル語の語はブラジル式の綴りで、その後に地域を問われて「ブラジル式・pt-BR (Recommended)」を選んだ（§1）。

| キー | 日本語 | 英語 | 簡体字 | 繁体字 | 韓国語 | ポルトガル語（ブラジル式） | スペイン語 |
|---|---|---|---|---|---|---|---|
| `nav.earthquake` | 地震情報 | Earthquake Information | 地震信息 | 地震訊息 | 지진 정보 | Informação sobre terremotos | Información de terremotos |
| `nav.realtime` | リアルタイム | Real-time | 实时 | 即時 | 실시간 | Tempo real | Tiempo real |
| `nav.tsunami` | 津波情報 | Tsunami Information | 海啸信息 | 海嘯訊息 | 지진해일 정보 | Informação sobre tsunami | Información del tsunami |
| `nav.catalog` | 震源カタログ | Hypocenter Catalog | 震源目录 | 震源目錄 | 진원 목록 | Catálogo de hipocentros | Catálogo de hipocentros |
| `nav.settings` | 設定 | Settings | 设置 | 設定 | 설정 | Configurações | Configuración |
| `nav.telegrams` | 電文ログ | Telegram Log | 电文记录 | 電文紀錄 | 전문 로그 | Registro de telegramas | Registro de telegramas |

- 辞書の語そのまま: 津波情報（6 言語とも）
- 辞書の語から組み立てた: 地震情報（簡体字・繁体字・韓国語は辞書の「情報」の訳を、ポルトガル語・スペイン語は辞書の津波情報の形に緊急地震速報の訳の Terremoto を当てた）・震源カタログの「震源」（Hypocenter・震源・진원・Hipocentro。ポルトガル語の辞書の訳は Hipocentro do Terremoto）
- ポルトガル語の辞書は「情報」を Informações とも書くが、津波情報の形にそろえて単数にした
- 気象庁サイトの JSON から: 英語の「Earthquake … Information」（`en_ttl`）
- 作った語: リアルタイム・震源カタログの「カタログ」・電文ログ（全言語）、設定（一般の語）

ナビの名前は画面に字では出ず、吹き出し（`title`）と読み上げソフト（`aria-label`）に出る（`components/IconNav.tsx`）。選択中のボタンの吹き出しに続く「（もう一度押すとパネルを開く／畳む）」は、まだ辞書に移していない。
