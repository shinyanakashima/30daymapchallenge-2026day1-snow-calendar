# 冬は、北から来る？ ― 北海道22地点の雪の暦

#30DayMapChallenge 2026 Day 1「Points」の作品です。
北海道の気象官署8地点と特別地域気象観測所14地点、計22地点について、初雪・積雪・根雪（長期積雪）の初日と終日を、日付スライダーでたどれるようにしました。

「冬は緯度の順に来るのか」を見比べるための地図です。地形や海流などとの因果関係は、このデータだけでは判断できないため、作品の中でも断定していません。

- 公開先（GitHub Pages）: https://shinyanakashima.github.io/30daymapchallenge-2026day1-snow-calendar/

## できること

| 操作 | 内容 |
|---|---|
| データの切り替え | 平年値（1991〜2020寒候年）／2025–26年の冬（実測）／今季 2026–27年の冬（速報） |
| 現象の切り替え | 初雪 ／ 積雪 ／ 根雪 |
| 日付の帯・再生 | 10月1日〜5月31日を1日ずつ。帯の白い刻みは各地点の初日、灰色は終日。←→キーで1日ずつ、スペースキーで再生／停止 |
| 地点を選ぶ | 地図の点か暦の行を選ぶと、3つのデータの初日・終日を並べて表示 |
| 暦の並び順 | 北の地点から（緯度順）／初日の早い順 |

点の状態と演出は次のとおりです。

| 状態 | 表現 |
|---|---|
| 初日より前 | 白抜きの輪 |
| 初日（3日間） | 白い点＋外側の輪。再生中は初日に波紋と粒が散る |
| 初日〜終日の間 | 白い点。初雪・積雪では「その間ずっと降っている／積もっている」という意味ではない |
| 根雪の期間 | 白い点のまわりに光。根雪の初日から日数とともに広がり、終日に向けて弱まる（根雪のときだけ） |
| 終日を過ぎた | 小さな灰色の点。終日の翌日に破線の波紋 |
| 未観測（今季の速報で公表日より先） | 灰色の破線 |

そのほか、背景と陸地の明るさは「その日に初日〜終日の間にある地点の割合」に合わせて変わります。右上の「この冬の記録」には、その日までに起きた初日・終日を新しい順に表示します。起動時は北の地点から順に点が現れ、自動で再生が始まります（OSの「視差効果を減らす」設定が有効な場合は演出を止めます）。

## データ

| 用途 | 資料 | 保存先 |
|---|---|---|
| 平年値 | 札幌管区気象台「初雪などの平年値」 https://www.data.jma.go.jp/sapporo/tenki/snow-frost-ice/snowfrostice_normals.html | `data/raw/snowfrostice_normals.html` |
| 前の冬の実測 | 同「観測状況（前の寒候年）」 https://www.jma-net.go.jp/sapporo/tenki/snow-frost-ice/snow_previous.html | `data/raw/snow_previous.html` |
| 今季の速報 | 同「観測状況」 https://www.data.jma.go.jp/sapporo/tenki/snow-frost-ice/snow.html | `data/raw/snow.html` |
| 地点の位置 | 気象庁「地上気象観測 地点情報履歴」 https://www.data.jma.go.jp/stats/data/mdrr/chiten/meta/smaster.index.zip （仕様: smasterindex_format.pdf） | `data/raw/smaster.index.zip` |
| 用語の解説 | 同「よくあるご質問」 | `data/raw/snowfrostice_faq.html` |
| 背景の陸地 | Natural Earth 10m land（パブリックドメイン） | `public/data/land.geojson`（切り抜き済み） |

取得日時とSHA-256は `data/raw/manifest.json` に記録しています。今回の取得は2026年11月1日です。

### 採用した期間・時点

- 平年値: 表の脚注「1990年8月～2020年7月の平年値」（1991〜2020寒候年の30年）。2026年11月1日に取得したページで確認。
- 前の冬: 2026寒候年（2025年8月1日〜2026年7月31日）。表は2026年10月6日現在。
- 今季: 2027寒候年（2026年8月1日〜2027年7月31日）。表は2026年10月31日現在の速報。

### 用語（混同しないように）

- **初雪**: 寒候年（8月1日〜翌年7月31日）で最初に観測された雪。みぞれを含む。終日は「雪の終日」。
- **積雪の初日・終日**: 日最深積雪1cm以上から算出した日。積雪1cm以上の初日を「初雪」とは表示していません。
- **根雪**: 統計上の「長期積雪」。30日以上の継続などの規則で気象庁が算出した初日・終日を、そのまま使っています。自前で連続日数から計算し直してはいません。
- 平年の初日・終日は統計的な代表日で、ある年の毎日の積雪状態を再現するものではありません。

### 整形の要点

`scripts/build_data.py`（Python標準ライブラリのみ）で行います。

1. **平年値の表**: セル結合（`colspan`・`rowspan`）を展開して列を復元してから読みます。元HTMLには閉じタグの漏れ（留萌の行）や余分な `</td>`（北見枝幸の行）があり、列番号を固定して読むとずれるためです。展開後に12列あること、見出しが想定どおりであることを検査します。
2. **記号**: 「@」は参考値として `normal_flags` に残します（雪・積雪・長期積雪の列には現れていません）。「///」は欠測、`no-obs` は観測なしとして値を空にします。
3. **観測状況**: 空欄は「未観測・未確定」として `null` のまま残し、ゼロや「雪なし確定」にはしません。
4. **地点の対応付け**: 平年値の22地点名を地点情報履歴の漢字地点名と照合し、地点番号が一意に決まること、22地点に重複・欠落がないことを検査します。観測状況ページの地点名とも突き合わせます。
5. **座標**: 地点情報履歴の緯度経度は度分表記（仕様の例「45度24.9分 → 452490」）。度＋0.1分単位の分3桁＋末尾1桁として十進度に変換します。
6. **採用位置**: 適用終了日が `99999999`（現在も継続）の行、つまり**現在の観測場所**を使っています。平年値の統計期間中に位置の記録が変わった地点（旭川・小樽・釧路・倶知安・広尾）は `quality_flags` に `moved_during_normal_period` を付け、期間中の位置を `position_history_in_normal_period` に残しています。
7. **照合**: 調査時に確認した値（札幌 初雪10/28・根雪12/6〜4/2、帯広 11/1・12/7〜3/24、釧路 11/7・12/30〜3/11）と一致しない場合は処理を止めます。
8. **年越し**: ブラウザ側で8月1日を0とする季節内の日番号に変換しているため、12月から1月への境目で並びが崩れません（2月29日は扱いません）。

出力:

- `public/data/stations.json` … 画面が読むデータ（3種類のデータ、出典、取得日を含む）
- `data/stations.csv` … 平年値と座標の一覧（照合用）
  `station_id, name, kind, longitude, latitude, first_snow_mmdd, last_snow_mmdd, first_snow_cover_mmdd, last_snow_cover_mmdd, persistent_snow_start_mmdd, persistent_snow_end_mmdd, data_kind, reference_period, quality_flags, source_url`

## 作り直す手順

```bash
./scripts/fetch_sources.sh
```

```bash
python3 -I scripts/build_data.py
```

背景の陸地を作り直す場合（shapely が必要）:

```bash
python3 -m venv .venv && .venv/bin/pip install shapely
```

```bash
curl -fsSLo data/raw/ne_10m_land.geojson https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson
```

```bash
.venv/bin/python scripts/build_basemap.py data/raw/ne_10m_land.geojson
```

画面の確認とビルド:

```bash
npm install
```

```bash
npm run dev
```

```bash
npm run build
```

気象庁への取得は制作時の `fetch_sources.sh` だけで行い、閲覧のたびにアクセスする作りにはしていません。今季の速報を新しくする場合は、上の2つのコマンドを実行してからコミットします。

## 技術構成

- Vite + TypeScript、d3-geo（投影と描画のみ）。地図はSVGで描き、外部のタイル配信には依存しません。
  点22個を主役にした小さな図なので、MapLibre GL JSではなくSVGにしました。
- 投影法: ランベルト正角円錐図法（標準緯線 北緯42度・45度、中央経線 東経143度）
- デプロイ: `main` へのpushで GitHub Actions（`.github/workflows/pages.yml`）がビルドし、GitHub Pages に公開します。リポジトリの Settings → Pages で Source を「GitHub Actions」にしてください。

## 拡張候補（初版には含めていません）

- 積雪深を観測している地点の日別値（気象庁「過去の気象データ・ダウンロード」）を使う別モード。観測項目・期間は地点で異なり、品質情報・欠測を保持する必要があります。全道分の取得や積雪観測地点数の確定はまだ行っていません。取得していないデータを実測値として作ることはしません。
- 過去の各冬との比較（複数年の観測状況の取り込み）。

## 利用条件・出典表記

気象庁の資料は、権利表記が別にないものについて「公共データ利用規約」に準拠して利用しています（https://www.jma.go.jp/jma/kishou/info/coment.html）。
この作品は上記の資料をもとに作者が編集・加工したもので、気象庁の公式の作品や予報ではありません。
背景の陸地は Natural Earth（パブリックドメイン）です。
