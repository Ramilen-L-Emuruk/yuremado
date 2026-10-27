# ネイティブアプリの方針（読み上げに VOICEVOX CORE を組み込む）

ブラウザの中では VOICEVOX の声を合成できない（[`browser-voicevox-survey.md`](browser-voicevox-survey.md)）。
そこで、各プラットフォームのネイティブアプリを作り、合成ライブラリ（VOICEVOX CORE）を組み込む。この資料は、その作り方の決まったことと、決まっていないことの記録。

**読者は、ネイティブアプリに着手する開発者。** 調べたのは 2026-10-27（日本時間）で、外の状況（配布物・規約・各ストアの決まり）は変わりうる。日付は、ことわりが無ければその日の時点。読み直すときは §3 の出典を引き直すこと。
中継の設計書（[`relay-server-design.md`](relay-server-design.md)）で読み上げを扱う段（段 4。段の一覧は同 §11）にあたる。

## 用語

| 語 | 意味 |
|---|---|
| VOICEVOX CORE | 合成を担うライブラリ（`VOICEVOX/voicevox_core`）。アプリへ組み込んで使える |
| VVM | 声のモデルのファイル（`VOICEVOX/voicevox_vvm`） |
| ONNX Runtime | モデルを動かす実行系。CORE は VOICEVOX 版のもの（`voicevox_onnxruntime`）を使う |
| Open JTalk | 日本語の文を読み・アクセントへ解析するライブラリ。CORE が中で使い、辞書を別に配る |
| エンジン | 利用者が自分で立てる HTTP の合成サーバー。いまの PWA が叩いている相手 |
| 中継 | DMDATA の電文を中継する自前のサーバー（[`relay-server-design.md`](relay-server-design.md)） |
| 段 | 中継の設計書が作業を分けた単位（段 1a〜4。同 §11） |
| 2 つの版 | いまの PWA の標準版（P2PQuake で受ける）と DMDSS 版（DMDATA で受ける）。中継の段 3b で 1 つにまとめる |
| 前面サービス | Android で、アプリが画面に出ていない間も動き続けるための仕組み（Foreground Service） |

## 0. 決まっていること

**ここでいうユーザーは、開発者（リポジトリの所有者）。** 右の列は、問いとユーザーの答えの原文。原文中の「#809」は中継と 2 つの版の一本化の作業を指す。

| 決まっていること | 原文 |
|---|---|
| 読み上げは、各プラットフォームのネイティブアプリを作り、CORE を組み込む方向で進める（2026-10-26） | 経緯と原文は [`browser-voicevox-survey.md`](browser-voicevox-survey.md) §0。答えは「それぞれのネイティブアプリを作成し組み込みたいです。」 |
| 作る OS は iOS・Android・Windows・macOS の 4 つ（2026-10-27） | 問い「ネイティブアプリを作る OS はどれ？（「それぞれ」の範囲。複数選べます）」に、選択肢「iOS」「Android」「Windows」「macOS」をすべて選んだ |
| PWA を包むのではなく、ネイティブで作り直す（2026-10-27） | 問い「ネイティブアプリと PWA の関係はどうする？」に選択肢「ネイティブで作り直す」。その説明は「Swift / Kotlin で画面から作る。読み上げの組み立て（約 7,000 行）・電文のパーサー・地図をそれぞれ移植することになり、PWA と 2〜3 系統を並べて保守する。OS の部品（通知・背景の動き）に最も素直に乗れるのが得。」。ほかの選択肢は「PWA を包む (Recommended)」「合成だけの小さなアプリ」（説明の「それぞれ移植」は、2 行下の問いで中核を共有すると決めた） |
| 作るのは中継の後。中継の段 1a〜3b（中継と 2 つの版の一本化）が済んでから（2026-10-27） | 問い「中継（#809）の段 4 として、いつ作る？」に選択肢「中継の後 (Recommended)」。ほかの選択肢は「中継より先に」「並行して進める」 |
| 電文の読み取りと読み上げ文の組み立て（中核）を 1 本にして 4 つのアプリで共有し、画面と通知は各 OS の部品で書く（2026-10-27） | 問い「4 つの OS のアプリで、電文の読み取り・読み上げ文の組み立てを共通の 1 本にする？」に選択肢「中核を 1 本にして共有 (Recommended)」。もう 1 つは「各 OS で全部書く」 |
| 最初の版から、いまの PWA と同じ機能を全部持たせる（2026-10-27） | 問い「ネイティブアプリの最初の版に、どこまでの機能を入れる？」に選択肢「PWA と同じ機能を全部」。もう 1 つは「中核から順に足す (Recommended)」 |
| ネイティブアプリを出した後も PWA を続けるかは、今は決めない。その間 PWA は今までどおり更新する（2026-10-27） | 問い「ネイティブアプリを出した後も、PWA を続ける？」に選択肢「今は決めない」（説明は「アプリが出揃うまで決めない。そのあいだ PWA はいまどおり更新を続ける。」）。ほかの選択肢は「続ける」「揃ったら止める」 |
| 移した読み上げが同じ読みになるかは、いまの PWA から書き出した答え（読み上げ文・句の区切り・アクセントの核）と自動のテストで突き合わせて確かめる（2026-10-27） | 問い「移した読み上げが、いまと同じ読みになることをどう確かめる？」に選択肢「書き出した答えと突き合わせる (Recommended)」。もう 1 つは「耳で聞き比べる」 |
| 各社のストア（App Store・Google Play・Microsoft Store）と直接配布の両方で配る（2026-10-27） | 問い「アプリをどこから配る？（複数選べます）」への答え「日本でも代替アプリ使えますが,各社のストア,直接配布」（選択肢「各社のストア」「直接配布」を選び、日本でも代替アプリストアが使えると書き添えた。選ばなかった選択肢は「自分の端末だけ」） |
| 最初に作るのは iOS（2026-10-27） | 問い「4 つの OS のうち、どれから作る？」に選択肢「iOS から (Recommended)」。ほかの選択肢は「Android から」「後で決める」 |
| 作った音声の利用をアプリの利用者に許す。利用規約に入れる 2 点は §1.5（2026-10-27） | 問い「作った音声の利用を、アプリの利用者に許す？」に選択肢「許す」（説明は「利用者が音声を使えるようにする（録画した動画の公開など）。その場合、利用規約に『音声ライブラリ（話者）の規約に従う』『さらに他者へ許すなら同じ義務を課す』の 2 点を入れる必要がある。」）。ほかの選択肢は「許さない（聞くだけ）」「後で決める」 |
| VOICEVOX を使ったことの表記と「VOICEVOX:話者名」の置き場所と文言は、画面を作るときに文面を用意して諮る（2026-10-27） | 問い「VOICEVOX を使ったことの表記を、いつ決める？」に選択肢「画面を作るときに諸る (Recommended)」（選択肢名の表記どおり。「諮る」の誤記）。もう 1 つは「今決める」 |
| 中核（電文の読み取りと読み上げ文の組み立て）は Rust で書く。画面と通知は上の行のとおり各 OS の部品で書く（2026-10-27。言語ごとの事実は §1.6） | 1 つ目の答えは問い返しで、決めたのは 2 つ目の答え。最初の問い「4 つのアプリで共有する中核（電文の読み取り・読み上げ文の組み立て）を、何で書く？」（選択肢は「いまの TypeScript を埋め込む (Recommended)」「Kotlin Multiplatform で書き直す」「Rust で書き直す」）への答えは「新規で作るとして一番正しいのは？」。続く問い「新しく作るなら一番正しいのは Rust だと考える。中核を何で書く？」に選択肢「Rust で作る (Recommended)」。ほかの選択肢は「Kotlin Multiplatform で作る」「いまの TypeScript を埋め込む」 |

## 1. 前提になる事実

### 1.1 CORE の配布物

CORE 0.17.0 のリリースには、次の添付がある（2026-10-27 に GitHub のリリースの添付一覧で確かめた）。

| OS | 添付 | 呼び方 |
|---|---|---|
| iOS | `voicevox_core-xcframework-0.17.0.zip` | C API（Swift から呼べる形） |
| Android | `voicevox_core-android-arm64-0.17.0.zip`・`voicevox_core-android-x86_64-0.17.0.zip`・`java_packages.zip` | Java API（Kotlin から呼べる） |
| macOS | `voicevox_core-osx-arm64-0.17.0.zip`・`voicevox_core-osx-x64-0.17.0.zip` | C API |
| Windows | `voicevox_core-windows-x64-0.17.0.zip`・`voicevox_core-windows-x86-0.17.0.zip` | C API |

### 1.2 いまの読み上げが使う口と、CORE の関数

いまの PWA がエンジンへ投げる口は 6 種で（[`voicevox.ts`](../src/utils/voicevox.ts)）、CORE 0.17.0 の C API（`voicevox_core.h`）にそれぞれ当たる関数がある。

| エンジンの口 | 呼んでいる所 | CORE の関数 |
|---|---|---|
| `/version` | `voicevox.ts:428` | （無い。CORE を組み込めば接続の確認そのものが要らない） |
| `/speakers` | `voicevox.ts:445` | `voicevox_synthesizer_create_metas_json` |
| `/audio_query` | `voicevox.ts:522`・`:805` | `voicevox_synthesizer_create_audio_query` |
| `/accent_phrases`（`is_kana=true`） | `voicevox.ts:561` | `voicevox_synthesizer_create_accent_phrases_from_kana` |
| `/mora_data` | `voicevox.ts:324` | `voicevox_synthesizer_replace_mora_data` |
| `/synthesis` | `voicevox.ts:930` | `voicevox_synthesizer_synthesis` |

行番号は、それぞれの口を叩く呼び出しの行（`/speakers` は `fetchWithTimeout(` に渡す URL の行、ほかは `fetch(` の行。2026-10-27 時点）。

**関数がヘッダーにあることは確かめた。同じ入力で同じ結果が返るかは、動かして確かめていない。**
辞書の句割り・アクセントの核・間の当て方は、エンジンの口の外側で PWA が組み立てている（[`audio-tts-spec.md`](spec/audio-tts-spec.md) §3）。
ネイティブで作り直すので、この組み立て（`ttsText.ts` 4,830 行・`voicevox.ts` 2,135 行。2026-10-27 の行数）は、4 つのアプリで共有する中核として Rust で書き直す（§0・§1.6）。

### 1.3 大きさと速さ

大きさ（声のモデル 59 MB・Open JTalk の辞書が展開後約 102 MB）と、iPhone 15 Pro Max での速さ（合成は音の長さの 0.52〜0.65 倍・読み込み 614 ms・メモリ 313 MB）は [`browser-voicevox-survey.md`](browser-voicevox-survey.md) §3.2・§3.3。
Android・Windows・macOS では測っていない。

### 1.4 背景で動くときの制約

| OS | 制約 | 確かめた度合い |
|---|---|---|
| iOS | アプリが背面に回ると、WebSocket の接続は保てない。背面で警報を受けて鳴らすにはプッシュ通知が要る | 一般に知られた制約。出典は引いておらず、実機でも確かめていない |
| iOS | おやすみモードや消音を越えて鳴らす通知（重大な通知・Critical Alerts）は Apple への申請制で、許可される種類は狭い | §3 の二次資料 2 件だけ。地震のアプリが許可された例は見つけていない |
| Android | Android 15 以降を対象にしたアプリでは、前面サービスのうち `dataSync`・`mediaProcessing` の型は、背面で 24 時間に合わせて 6 時間までしか動けない | §3 の Android の開発者向け資料 |
| Android | 常駐して受信し続けるために、前面サービスのどの型を選び、Google Play へどう申告するか | 調べていない |

中継の設計書では、プッシュ通知は中継の段 3b の後と書いている（[`relay-server-design.md`](relay-server-design.md) §12）。

### 1.5 組み込んで配るときの規約

組み込むものは ONNX Runtime・CORE 本体・声のモデル（VVM）・Open JTalk の辞書の 4 つ。**どれもアプリへ組み込んで配ってよい。** 配るときに要ることは、ONNX Runtime が下の 2 つの条件、ほかの 3 つが末尾の表。

CORE は声の合成に、VOICEVOX 版の ONNX Runtime を使う。CORE 0.17.0 が既定で取るのは 1.17.3（2026-10-27 時点。1.23.2 もあるが、リリースに先行版の印が付いていて既定では選ばれない）。その配布物に入っている規約（`TERMS.txt`。表題は「VOICEVOX ONNX Runtime 利用規約」）を読んだ。

| 項目 | 規約の文 |
|---|---|
| 使ってよい範囲 | 「商用・非商用問わず利用することができます」 |
| アプリへの組み込み | 「アプリケーションに組み込んで再配布することができます」 |
| 作った音声 | 「作成された音声を利用する際は、各音声ライブラリの規約に従ってください」 |
| 作った音声の利用を他者に許すとき | 「作成された音声の利用を他者に許諾する際は、当該他者に対し本許諾内容の 3 及び 4 の遵守を義務付けてください」 |
| 禁止事項 | 「逆コンパイル・リバースエンジニアリング及びこれらの方法の公開すること」「製作者または第三者に不利益をもたらす行為」「公序良俗に反する行為」 |
| 表記 | 「ご利用の際は VOICEVOX を利用したことがわかるクレジット表記が必要です。」 |

ONNX Runtime の条件は 2 つ。

- 各アプリに、VOICEVOX を使ったことの表記を置く。声のモデル（VVM）の規約が求める「VOICEVOX:話者名」の表記とは別のもので、両方が要る
- 作った音声の利用を利用者に許すと決めた（§0）ので、利用者にも上の表の「作った音声」と「作った音声の利用を他者に許すとき」の 2 行を守らせる

（読んだのは 1.17.3 と 1.23.2 の、Windows（`win-x86`）・Android（`android-arm64`）・iOS（`ios-arm64`）・macOS（`osx-arm64`）の CPU 版の 8 本。改行の形を揃えると 8 本とも同じ文だった。GPU 版は見ていない。）

| 組み込むもの | 規約 | 配るときに要ること | 確かめた度合い |
|---|---|---|---|
| CORE 本体 | MIT（著作権者は Hiroshiba Kazuyuki） | 著作権表示と許諾の文を同梱する | 0.17.0 の `LICENSE` を読んだ |
| 声のモデル（VVM） | 商用・非商用に使え、アプリへ組み込んで再配布できる | 「VOICEVOX:話者名」の表記 | 0.17.0 の README.txt を読んだ（[`browser-voicevox-survey.md`](browser-voicevox-survey.md) §3.1） |
| Open JTalk の辞書 | 3 条項 BSD が 3 本（著作権者は奈良先端科学技術大学院大学・UniDic コンソーシアム・名古屋工業大学） | バイナリで配るときは、3 本の著作権表示・条件・免責の文を同梱の文書に載せる。奈良先端科学技術大学院大学・UniDic コンソーシアム・HTS working group（と貢献者）の名前を、許可なく宣伝に使わない | `r9y9/open_jtalk` の `src/mecab-naist-jdic/COPYING` を読んだ。配布物の `open_jtalk_dic_utf_8-1.11.tar.gz` の中身とは突き合わせていない |

### 1.6 中核の言語ごとの事実

2026-10-27 に、CORE 0.17.0 の配布物・資料と、各言語の公式の対応表で確かめた。表の語は次のとおり。

- **Tier**: 各言語の公式が OS ごとに付ける対応の等級。1 が最も手厚く、数字が大きいほど保証が薄い。等級の定義は Rust と Kotlin で別
- **`load-onnxruntime` / `link-onnxruntime`**: CORE のビルドの選び方。前者は ONNX Runtime を実行時に読み込み（`dlopen`）、後者はビルド時につなぐ
- **MSVC / MinGW**: Windows の 2 種類のビルド環境。片方で作ったライブラリをもう片方から呼べるとは限らない

| 言語 | CORE の呼び方 | 4 つの OS への対応 |
|---|---|---|
| Rust | CORE の Rust の口（`voicevox_core` クレート）を直接使う。crates.io には無く、git から取る（CORE の資料 `languages.md` の表で「パッケージレジストリ」が無い）。CORE の C API のリリースは、`dlopen` の利用が厳しい iOS でだけ `link-onnxruntime` でビルドしている（`feature-options.md`）。Rust の口を iOS で使うときに何が要るかは確かめていない | Rust の対応表で macOS（`aarch64-apple-darwin`）・Windows（`x86_64-pc-windows-msvc`）は Tier 1、iOS（`aarch64-apple-ios`）・Android（`aarch64-linux-android`）は Tier 2（「ビルドは保証される」）。WASM（`wasm32-unknown-unknown`）も Tier 2 |
| Kotlin Multiplatform | Android は Java 版（リリースの `java_packages.zip` の中の `voicevoxcore-android-0.17.0.aar`。arm64・x86_64）。iOS・macOS は Kotlin/Native から C API。同じ zip に PC 向けの Java 版（Windows・macOS・Linux のライブラリ入りの jar）もある。ただし CORE の API 資料の原稿では、Java の項が「Java APIが正式版になったら」という注記つきでコメントアウトされていて、資料の目次に出ていない | Kotlin の対応表で iOS（`iosArm64`）・macOS（`macosArm64`）は Tier 1、Windows（`mingwX64`）は Tier 3（CI での試験が保証されない）。CORE の Windows 版は MSVC の dll なので、MinGW から呼べるかは試していない |
| いまの TypeScript を埋め込む | 各 OS の側で CORE を呼ぶ。`ttsText.ts`・`dmdataParser.ts` は `window`・`document`・`localStorage`・`AudioContext` を使わない。ブラウザの API に頼るのは `dmdataParser.ts` が XML を読む `DOMParser` だけで、代わりの部品が要る |

Rust を選んだので、いまの TypeScript の中核（`dmdataParser.ts` 3,425 行・`ttsText.ts` 4,830 行・`voicevox.ts` 2,135 行。2026-10-27 の行数）は Rust で書き直す。PWA が TypeScript のままの間は、2 本を並べて保守する（§2 の WASM の行）。 各アプリに JS の実行環境が要る。iOS・macOS は OS に JavaScriptCore がある。Android・Windows で何を使うかは調べていない |

## 2. 決まっていないこと

「未決」は判断がまだのもの、「未確認」は事実をまだ調べていないもの。

| 決まっていないこと | 状態 |
|---|---|
| ネイティブアプリが出そろった後に PWA を続けるか | 未決（出そろうまで決めない。§0） |
| §0 の「最初の版から全機能」の「最初の版」が、最初に出す iOS 版を指すか、4 つの OS がそろった版を指すか（問いは「ネイティブアプリの最初の版」とだけ訊いた） | 未決（ユーザー判断待ち） |
| Rust の中核を、各 OS の画面（Swift・Kotlin・Windows の画面部品）から呼べる形にする仕組みを何にするか。候補の 1 つは UniFFI（Rust 側の定義から Swift・Kotlin 向けの呼び出し口を作る道具）で、ほかの候補はまだ挙げていない | 未決（候補を調べてから諮る。画面を何で書くかの行と合わせて決める） |
| Rust の中核を WASM にして PWA にも入れるか（入れれば PWA とアプリが 1 本のソースになる） | 未決（ユーザー判断待ち） |
| Rust の中核と CORE の Rust の口を、1 つの iOS アプリにまとめてビルドできるか（ONNX Runtime をどうつなぐか） | 未確認（試していない） |
| 画面を何で書くか（Windows の画面部品、iOS と macOS で画面を分けるか） | 未決（ユーザー判断待ち） |
| iOS の次にどの順で作るか | 未決（ユーザー判断待ち） |
| 各社のストアの審査に通るか。日本で使える代替アプリストアを iOS の直接配布の経路として使うか | 未確認（調べていない） |
| PWA の読み上げをどうするか | [`relay-server-design.md`](relay-server-design.md) §12 の「読み上げの残り」の行のまま未決 |
| 背面での受信とプッシュ通知、中継が読み上げで受け持つものがあるか | [`relay-server-design.md`](relay-server-design.md) §12 の行のまま未決 |
| 利用者が画面と音声を録って公開するとき、「VOICEVOX:話者名」の表記をどう残してもらうか（いまの PWA には録画向けの「録画モード」がある。[`settings-pwa-spec.md`](spec/settings-pwa-spec.md) §2） | 未決（ユーザー判断待ち） |

## 3. 出典

- [VOICEVOX/voicevox_core 0.17.0 のリリース](https://github.com/VOICEVOX/voicevox_core/releases/tag/0.17.0)（添付の一覧）
- [VOICEVOX/onnxruntime-builder voicevox_onnxruntime-1.17.3 のリリース](https://github.com/VOICEVOX/onnxruntime-builder/releases/tag/voicevox_onnxruntime-1.17.3)と[同 1.23.2（先行版）](https://github.com/VOICEVOX/onnxruntime-builder/releases/tag/voicevox_onnxruntime-1.23.2)（`TERMS.txt` は各添付の中）
- [voicevox_core `crates/downloader/src/main.rs`（0.17.0）](https://github.com/VOICEVOX/voicevox_core/blob/0.17.0/crates/downloader/src/main.rs)（69〜70 行の `SUPPORTED_ONNXRUNTIME_VERSIONS` が受け付ける版の範囲 `>=1.17.3,<1.24`。既定では、その範囲の先行版でない最新を取る）
- [voicevox_core `docs/guide/user/languages.md`（0.17.0）](https://github.com/VOICEVOX/voicevox_core/blob/0.17.0/docs/guide/user/languages.md)
- [voicevox_core `docs/guide/user/feature-options.md`（0.17.0）](https://github.com/VOICEVOX/voicevox_core/blob/0.17.0/docs/guide/user/feature-options.md)
- [VOICEVOX CORE の API 資料](https://voicevox.github.io/voicevox_core/apis/)（Java の項がコメントアウトされているのはページのソース）
- [Rust: Platform Support](https://doc.rust-lang.org/nightly/rustc/platform-support.html)
- [Kotlin/Native target support](https://kotlinlang.org/docs/native-target-support.html)
- [voicevox_core `LICENSE`（0.17.0）](https://github.com/VOICEVOX/voicevox_core/blob/0.17.0/LICENSE)
- [r9y9/open_jtalk `src/mecab-naist-jdic/COPYING`](https://github.com/r9y9/open_jtalk/blob/master/src/mecab-naist-jdic/COPYING)（Open JTalk の辞書の規約）
- [voicevox_core `voicevox_core.h`（0.17.0）](https://github.com/VOICEVOX/voicevox_core/blob/0.17.0/crates/voicevox_core_c_api/include/voicevox_core.h)
- [Android: Foreground service timeouts](https://developer.android.com/develop/background-work/services/fg-service-timeout)
- Apple の重大な通知の申請については二次資料だけを見た（[newly.app の解説](https://newly.app/articles/critical-alerts-entitlement)・[Apple Developer Forums の質問](https://developer.apple.com/forums/thread/794822)）
