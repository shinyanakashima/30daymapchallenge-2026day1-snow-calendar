#!/usr/bin/env bash
# 気象庁の公開資料を data/raw/ に保存し、取得日時を manifest.json に残す。
# 制作時に1回だけ実行する（閲覧のたびに気象庁へアクセスしない）。
set -euo pipefail
cd "$(dirname "$0")/../data/raw"

declare -A SRC=(
  [snowfrostice_normals.html]="https://www.data.jma.go.jp/sapporo/tenki/snow-frost-ice/snowfrostice_normals.html"
  [snow.html]="https://www.data.jma.go.jp/sapporo/tenki/snow-frost-ice/snow.html"
  [snow_previous.html]="https://www.jma-net.go.jp/sapporo/tenki/snow-frost-ice/snow_previous.html"
  [snowfrostice_faq.html]="https://www.jma-net.go.jp/sapporo/tenki/snow-frost-ice/snowfrostice_faq.html"
  [smaster.index.zip]="https://www.data.jma.go.jp/stats/data/mdrr/chiten/meta/smaster.index.zip"
  [smasterindex_format.pdf]="https://www.data.jma.go.jp/stats/mdrr/man/smasterindex_format.pdf"
)

echo "{" > manifest.json.tmp
first=1
for f in snowfrostice_normals.html snow.html snow_previous.html snowfrostice_faq.html smaster.index.zip smasterindex_format.pdf; do
  url="${SRC[$f]}"
  curl -fsS -o "$f" "$url"
  sum=$(sha256sum "$f" | cut -d' ' -f1)
  ts=$(TZ=Asia/Tokyo date '+%Y-%m-%dT%H:%M:%S+09:00')
  [ $first -eq 1 ] || echo "," >> manifest.json.tmp
  first=0
  printf '  "%s": {"url": "%s", "retrieved": "%s", "sha256": "%s"}' "$f" "$url" "$ts" "$sum" >> manifest.json.tmp
  echo "saved $f"
done
printf '\n}\n' >> manifest.json.tmp
mv manifest.json.tmp manifest.json
