# ネイティブアプリの方針（読み上げに VOICEVOX CORE を組み込む）

ブラウザの中では VOICEVOX の声を合成できない（[`browser-voicevox-survey.md`](browser-voicevox-survey.md)）。
そこで、各プラットフォームのネイティブアプリを作り、合成ライブラリ（VOICEVOX CORE）を組み込む。この資料は、その作り方の決まったことと、決まっていないことの記録。

**読者は、ネイティブアプリに着手する開発者。** 調べたのは 2026-10-27（日本時間）で、外の状況（配布物・規約・各ストアの決まり）は変わりうる。日付は、ことわりが無ければその日の時点。読み直すときは §3 の出典を引き直すこと。
中継の設計書（[`relay-server-design.md`](relay-server-design.md)）で読み上げを扱う段（段 4。段の一覧は同 §11）にあたる。

## 用語

| 語 | 意味 |
|---|---|
| VOICEVOX CORE | 合成を担うライブラリ（`VOICEVOX/voicevox_core`）。アプリへ組み込んで使える |
| エンジン | 利用者が自分で立てる HTTP の合成サーバー。いまの PWA が叩いている相手 |
| 中継 | DMDATA の電文を中継する自前のサーバー（[`relay-server-design.md`](relay-server-design.md)） |
| 段 | 中継の設計書が作業を分けた単位（段 1a〜4。同 §11） |
| 2 つの版 | いまの PWA の標準版（P2PQuake で受ける）と DMDSS 版（DMDATA で受ける）。中継の段 3b で 1 つにまとめる |
| 前面サービス | Android で、アプリが画面に出ていない間も動き続けるための仕組み（Foreground Service） |

## 0. 決まっていること

**ここでいうユーザーは、開発者（リポジトリの所有者）。** 行ごとに、問いとユーザーの答えを、その場の問答から原文のまま写す。原文の「#809」は開発者の手元の課題の番号で、中継と 2 つの版の一本化の作業を指す。説明の「約 7,000 行」は §1.2 の 2 ファイルの合計（6,965 行）。

| 決まっていること | 原文 |
|---|---|
| 読み上げは、各プラットフォームのネイティブアプリを作り、CORE を組み込む方向で進める（2026-10-26） | 経緯と原文は [`browser-voicevox-survey.md`](browser-voicevox-survey.md) §0。答えは「それぞれのネイティブアプリを作成し組み込みたいです。」 |
| 作る OS は iOS・Android・Windows・macOS の 4 つ（2026-10-27） | 問い「ネイティブアプリを作る OS はどれ？（「それぞれ」の範囲。複数選べます）」に、選択肢「iOS」「Android」「Windows」「macOS」をすべて選んだ |
| PWA を包むのではなく、ネイティブで作り直す（2026-10-27） | 問い「ネイティブアプリと PWA の関係はどうする？」に選択肢「ネイティブで作り直す」。その説明は「Swift / Kotlin で画面から作る。読み上げの組み立て（約 7,000 行）・電文のパーサー・地図をそれぞれ移植することになり、PWA と 2〜3 系統を並べて保守する。OS の部品（通知・背景の動き）に最も素直に乗れるのが得。」。ほかの選択肢は「PWA を包む (Recommended)」「合成だけの小さなアプリ」 |
| 作るのは中継の後。中継の段 1a〜3b（中継と 2 つの版の一本化）が済んでから（2026-10-27） | 問い「中継（#809）の段 4 として、いつ作る？」に選択肢「中継の後 (Recommended)」。ほかの選択肢は「中継より先に」「並行して進める」 |

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

行番号は、それぞれの口を叩く `fetch(` の行（2026-10-27 時点）。

**関数がヘッダーにあることは確かめた。同じ入力で同じ結果が返るかは、動かして確かめていない。**
辞書の句割り・アクセントの核・間の当て方は、エンジンの口の外側で PWA が組み立てている（[`audio-tts-spec.md`](spec/audio-tts-spec.md) §3）。
ネイティブで作り直すので、この組み立て（`ttsText.ts` 4,830 行・`voicevox.ts` 2,135 行。2026-10-27 の行数）は各アプリへ移すことになる。

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

CORE は声の合成に、VOICEVOX 版の ONNX Runtime（モデルを動かす実行系）を使う。CORE 0.17.0 が既定で取るのは 1.17.3（2026-10-27 時点。1.23.2 もあるが先行版で、既定では選ばれない）。その配布物に入っている規約（`TERMS.txt`。表題は「VOICEVOX ONNX Runtime 利用規約」）を読んだ。

| 項目 | 規約の文 |
|---|---|
| 使ってよい範囲 | 「商用・非商用問わず利用することができます」 |
| アプリへの組み込み | 「アプリケーションに組み込んで再配布することができます」 |
| 作った音声 | 「作成された音声を利用する際は、各音声ライブラリの規約に従ってください」 |
| 作った音声の利用を他者に許すとき | 「作成された音声の利用を他者に許諾する際は、当該他者に対し本許諾内容の 3 及び 4 の遵守を義務付けてください」 |
| 禁止事項 | 「逆コンパイル・リバースエンジニアリング及びこれらの方法の公開すること」「製作者または第三者に不利益をもたらす行為」「公序良俗に反する行為」 |
| 表記 | 「ご利用の際は VOICEVOX を利用したことがわかるクレジット表記が必要です。」 |

**ONNX Runtime については、アプリへ組み込んで配ってよい。** 条件は 2 つある。

- 各アプリに、VOICEVOX を使ったことの表記を置く。声のモデル（VVM）の規約が求める「VOICEVOX:話者名」の表記とは別のもので、両方が要る（VVM の規約は [`browser-voicevox-survey.md`](browser-voicevox-survey.md) §3.1）
- 作った音声の利用をアプリの利用者に許すなら、利用者にも上の表の「作った音声」と「作った音声の利用を他者に許すとき」の 2 行を守らせる

読んだのは 1.17.3 と 1.23.2 の、Windows（`win-x86`）・Android（`android-arm64`）・iOS（`ios-arm64`）・macOS（`osx-arm64`）の CPU 版の 8 本で、改行の形を揃えると 8 本とも同じ文だった。GPU 版（CUDA・DirectML）は見ていない。
ONNX Runtime 以外に組み込むものの規約は、ここでは扱っていない。CORE 本体はリポジトリのライセンスが MIT（GitHub の判定）、声のモデルは上記のとおり。Open JTalk の辞書は §2。

## 2. 決まっていないこと

| 決まっていないこと | 状態 |
|---|---|
| 各 OS をどの言語・画面部品で書くか。選んだ選択肢の説明にあったのは「Swift / Kotlin」まで。Windows を何で書くか、iOS と macOS で画面を分けるか、OS をまたいで共通に持つ層を作るか | 未決（ユーザー判断待ち） |
| どの機能まで移すか（地図・強震モニタの検知・リプレイ・テストボタン・共有カード・自作地震計・設定の書き出し） | 未決（ユーザー判断待ち） |
| ネイティブアプリを出した後も PWA を続けるか（選んだ選択肢の説明は「PWA と 2〜3 系統を並べて保守する」だったが、続けるかを名指しで訊いてはいない） | 未決（ユーザー判断待ち） |
| PWA の読み上げをどうするか | [`relay-server-design.md`](relay-server-design.md) §12 の「読み上げの残り」の行のまま未決 |
| 読み上げの組み立てを各言語へ移したとき、いまと同じ文・同じ句・同じ核になることをどう確かめるか | 未決（ユーザー判断待ち） |
| どこから配るか（App Store・Google Play・Microsoft Store・直接配布）と、それぞれの審査に通るか | 未決（ユーザー判断待ち） |
| 4 つの OS をどの順で作るか | 未決（ユーザー判断待ち） |
| Open JTalk の辞書（`open_jtalk_dic_utf_8-1.11`）の規約で、アプリへ組み込んで配れるか | 未確認（読んでいない） |
| VOICEVOX を使ったことの表記と「VOICEVOX:話者名」の表記を、アプリのどこにどの文言で置くか | 未決（ユーザー判断待ち） |
| 作った音声の利用をアプリの利用者に許すか（許すなら、§1.5 の条件を利用規約に入れる） | 未決（ユーザー判断待ち） |
| 背面での受信とプッシュ通知、中継が読み上げで受け持つものがあるか | [`relay-server-design.md`](relay-server-design.md) §12 の行のまま未決 |

## 3. 出典

- [VOICEVOX/voicevox_core 0.17.0 のリリース](https://github.com/VOICEVOX/voicevox_core/releases/tag/0.17.0)（添付の一覧）
- [VOICEVOX/onnxruntime-builder voicevox_onnxruntime-1.17.3 のリリース](https://github.com/VOICEVOX/onnxruntime-builder/releases/tag/voicevox_onnxruntime-1.17.3)と[同 1.23.2（先行版）](https://github.com/VOICEVOX/onnxruntime-builder/releases/tag/voicevox_onnxruntime-1.23.2)（`TERMS.txt` は各添付の中）
- [voicevox_core `crates/downloader/src/main.rs`（0.17.0）](https://github.com/VOICEVOX/voicevox_core/blob/0.17.0/crates/downloader/src/main.rs)（69〜70 行の `SUPPORTED_ONNXRUNTIME_VERSIONS` が受け付ける版の範囲 `>=1.17.3,<1.24`。既定では、その範囲の先行版でない最新を取る）
- [voicevox_core `voicevox_core.h`（0.17.0）](https://github.com/VOICEVOX/voicevox_core/blob/0.17.0/crates/voicevox_core_c_api/include/voicevox_core.h)
- [Android: Foreground service timeouts](https://developer.android.com/develop/background-work/services/fg-service-timeout)
- Apple の重大な通知の申請については二次資料だけを見た（[newly.app の解説](https://newly.app/articles/critical-alerts-entitlement)・[Apple Developer Forums の質問](https://developer.apple.com/forums/thread/794822)）
