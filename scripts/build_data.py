"""気象庁の公開資料（制作時に保存したHTML・地点情報）から、表示用JSONを作る。

入力（data/raw/、scripts/fetch_sources.sh で取得）
  snowfrostice_normals.html  初雪などの平年値（札幌管区気象台）
  snow_previous.html         前の寒候年の観測状況
  snow.html                  今の寒候年の観測状況
  smaster.index.zip          地上気象観測 地点情報履歴

出力
  public/data/stations.json  地図・グラフが読む整形済みデータ
  data/stations.csv          照合用の一覧（平年値と座標）

標準ライブラリだけで動く。python3 -I scripts/build_data.py
"""

from __future__ import annotations

import csv
import io
import json
import re
import sys
import zipfile
from datetime import date
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT_JSON = ROOT / "public" / "data" / "stations.json"
OUT_CSV = ROOT / "data" / "stations.csv"
MANIFEST = RAW / "manifest.json"

NORMALS_URL = "https://www.data.jma.go.jp/sapporo/tenki/snow-frost-ice/snowfrostice_normals.html"
CURRENT_URL = "https://www.data.jma.go.jp/sapporo/tenki/snow-frost-ice/snow.html"
PREVIOUS_URL = "https://www.jma-net.go.jp/sapporo/tenki/snow-frost-ice/snow_previous.html"
SMASTER_URL = "https://www.data.jma.go.jp/stats/data/mdrr/chiten/meta/smaster.index.zip"

# 平年値の統計期間（1991〜2020寒候年）。地点の移転有無を調べる範囲にも使う。
NORMAL_FROM = 19900801
NORMAL_TO = 20200731

# 平年値表の列（rowspan/colspanを展開した後の位置）
NORMAL_COLUMNS = [
    "snow_first", "snow_last",          # 雪（初雪・終雪）
    "frost_first", "frost_last",        # 霜
    "ice_first", "ice_last",            # 結氷
    "capped_first", "capped_mountain",  # 冠雪
    "cover_first", "cover_last",        # 積雪（日最深積雪1cm以上）
    "persistent_first", "persistent_last",  # 長期積雪（根雪）
]
USE_KEYS = ["snow_first", "snow_last", "cover_first", "cover_last", "persistent_first", "persistent_last"]

OBS_TABLES = {
    "雪の初日": "snow_first",
    "雪の終日": "snow_last",
    "積雪の初日": "cover_first",
    "積雪の終日": "cover_last",
    "長期積雪の初日": "persistent_first",
    "長期積雪の終日": "persistent_last",
}

# 調査時に確認した値（引き継ぎ資料）。取り込み結果と照合する。
SPOT_CHECKS = {
    "札幌": {"snow_first": "10-28", "persistent_first": "12-06", "persistent_last": "04-02"},
    "帯広": {"snow_first": "11-01", "persistent_first": "12-07", "persistent_last": "03-24"},
    "釧路": {"snow_first": "11-07", "persistent_first": "12-30", "persistent_last": "03-11"},
}


# ---------------------------------------------------------------- HTML表の読み取り

class TableParser(HTMLParser):
    """table/tr/th/td を、rowspan・colspanの情報付きで素直に集める。

    閉じタグ漏れや余分な </td> があっても、新しいセルの開始で前のセルを閉じる。
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tables: list[dict] = []
        self._table: dict | None = None
        self._row: list | None = None
        self._cell: dict | None = None
        self._in_caption = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "table":
            self._table = {"attrs": a, "rows": [], "caption": ""}
        elif self._table is None:
            return
        elif tag == "caption":
            self._in_caption = True
        elif tag == "tr":
            self._close_cell()
            self._close_row()
            self._row = []
        elif tag in ("td", "th"):
            self._close_cell()
            if self._row is None:
                self._row = []
            self._cell = {
                "tag": tag,
                "text": "",
                "rowspan": int(a.get("rowspan") or 1),
                "colspan": int(a.get("colspan") or 1),
                "class": a.get("class") or "",
                "abbr": a.get("abbr") or "",
            }
        elif tag == "br" and self._in_caption:
            self._table["caption"] += "\n"

    def handle_endtag(self, tag):
        if self._table is None:
            return
        if tag in ("td", "th"):
            self._close_cell()
        elif tag == "tr":
            self._close_cell()
            self._close_row()
        elif tag == "caption":
            self._in_caption = False
        elif tag == "table":
            self._close_cell()
            self._close_row()
            self.tables.append(self._table)
            self._table = None

    def handle_data(self, data):
        if self._table is None:
            return
        if self._in_caption:
            self._table["caption"] += data
        elif self._cell is not None:
            self._cell["text"] += data

    def _close_cell(self):
        if self._cell is not None and self._row is not None:
            self._cell["text"] = self._cell["text"].replace("\xa0", " ").strip()
            self._row.append(self._cell)
        self._cell = None

    def _close_row(self):
        if self._row is not None and self._table is not None:
            self._table["rows"].append(self._row)
        self._row = None


def expand_grid(rows: list[list[dict]]) -> list[list[dict | None]]:
    """rowspan/colspanを展開して、行×列の格子に置き直す。

    colspanで広がったセルは各列に同じセルを置き、"span_from" で元の列を示す。
    """
    grid: list[list[dict | None]] = []
    pending: dict[tuple[int, int], dict] = {}
    for r, row in enumerate(rows):
        out: list[dict | None] = []
        c = 0
        cells = list(row)
        while cells or (r, c) in pending:
            if (r, c) in pending:
                out.append(pending.pop((r, c)))
                c += 1
                continue
            cell = cells.pop(0)
            for dc in range(cell["colspan"]):
                item = dict(cell, span_offset=dc)
                out.append(item)
                for dr in range(1, cell["rowspan"]):
                    pending[(r + dr, c + dc)] = dict(item, rowspan_cont=True)
            c += cell["colspan"]
        grid.append(out)
    return grid


DATE_RE = re.compile(r"^(\d{1,2})月\s*(\d{1,2})日\s*(@?)$")


def parse_md(text: str) -> tuple[str | None, list[str]]:
    """'11月 1日@' → ('11-01', ['reference'])。空・////は None。"""
    t = re.sub(r"\s+", " ", text).strip()
    if t == "":
        return None, ["blank"]
    if t.startswith("///"):
        return None, ["missing"]
    m = DATE_RE.match(t.replace(" ", ""))
    if not m:
        raise ValueError(f"日付として読めない値: {text!r}")
    mm, dd, ref = int(m.group(1)), int(m.group(2)), m.group(3)
    date(2001, mm, dd)  # 実在日付か確認（2/29は平年値に現れない想定）
    return f"{mm:02d}-{dd:02d}", (["reference"] if ref else [])


def read_html(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def parse_normals(html: str) -> tuple[list[dict], str]:
    p = TableParser()
    p.feed(html)
    tables = [t for t in p.tables if t["attrs"].get("summary") == "寒候期現象_平年値"]
    if len(tables) != 1:
        raise SystemExit("平年値の表が見つからない")
    grid = expand_grid(tables[0]["rows"])

    # 2行目までが見出し。1列目は地点名(th)、以降12列。
    header_top = [c["text"] for c in grid[0]]
    header_sub = [c["text"] for c in grid[1]]
    assert header_top[0] == "観測官署", header_top
    assert header_sub[0] == "観測官署" and header_sub[1:3] == ["初日", "終日"], header_sub
    assert header_top[1] == "雪" and header_top[9].startswith("積雪") and header_top[11].startswith("長期積雪"), header_top

    footnote = ""
    records = []
    for row in grid[2:]:
        if not row:
            continue
        if row[0]["tag"] == "td":  # 脚注行
            footnote = row[0]["text"]
            continue
        name = row[0]["text"]
        cells = row[1:]
        if len(cells) != 12:
            raise SystemExit(f"{name}: 展開後の列数が12でない ({len(cells)})")
        rec = {"name": name, "values": {}, "flags": {}}
        for key, cell in zip(NORMAL_COLUMNS, cells):
            if key == "capped_mountain":
                continue
            if "no-obs" in cell["class"]:
                rec["values"][key] = None
                rec["flags"][key] = ["not_observed"]
                continue
            v, fl = parse_md(cell["text"])
            rec["values"][key] = v
            rec["flags"][key] = fl
        records.append(rec)

    period = re.search(r"(\d{4}年\d{1,2}月～\d{4}年\d{1,2}月)", footnote)
    return records, period.group(1) if period else ""


def parse_observed(html: str) -> tuple[dict[str, dict], dict]:
    """観測状況ページの6つの表を {地点: {key: 'MM-DD'|None}} にまとめる。"""
    p = TableParser()
    p.feed(html)
    out: dict[str, dict] = {}
    meta = {"winter_year": None, "as_of": None}
    for t in p.tables:
        key = OBS_TABLES.get(t["attrs"].get("summary", ""))
        if key is None:
            continue
        cap = re.sub(r"\s+", "", t["caption"])
        wy = re.search(r"(\d{4})寒候年", cap)
        ao = re.search(r"(\d{4})年(\d{1,2})月(\d{1,2})日現在", cap)
        if wy:
            meta["winter_year"] = int(wy.group(1))
        if ao:
            meta["as_of"] = f"{int(ao.group(1)):04d}-{int(ao.group(2)):02d}-{int(ao.group(3)):02d}"
        for row in t["rows"][1:]:
            if not row or row[0]["tag"] != "th":
                continue
            name = row[0]["text"]
            v, _ = parse_md(row[1]["text"]) if len(row) > 1 else (None, [])
            out.setdefault(name, {})[key] = v
    return out, meta


# ---------------------------------------------------------------- 地点情報履歴

def dm_to_deg(s: str, deg_digits: int) -> float:
    """度分表記 → 十進度。仕様の例「45度24.9分 → 452490」に従い、
    度(2or3桁)＋分(0.1分単位3桁)＋末尾1桁(0) と読む。"""
    s = s.strip()
    if s[deg_digits + 3:] not in ("", "0"):
        raise ValueError(f"末尾桁が0でない: {s}")
    d = int(s[:deg_digits])
    minutes = int(s[deg_digits:deg_digits + 3]) / 10
    if not 0 <= minutes < 60:
        raise ValueError(f"分が範囲外: {s}")
    return d + minutes / 60


def read_smaster(zip_path: Path) -> list[dict]:
    with zipfile.ZipFile(zip_path) as z:
        raw = z.read("smaster.index")
    recs = []
    for line in raw.split(b"\n"):
        line = line.rstrip(b"\r")
        if len(line) < 118:
            continue

        def f(a: int, b: int) -> bytes:  # フォーマット仕様の開始バイト(1起点)・バイト数
            return line[a - 1:a - 1 + b]

        name = f(81, 12).decode("cp932").replace("　", "").strip()
        recs.append({
            "station_no": int(f(1, 3)),
            "kana": f(17, 8).decode("cp932").strip(),
            "romaji": f(25, 12).decode("ascii").strip(),
            "lat_raw": f(37, 6).decode("ascii"),
            "lon_raw": f(43, 7).decode("ascii"),
            "start": int(f(65, 8)),
            "end": int(f(73, 8)),
            "name": name,
            "office": f(93, 18).decode("cp932").replace("　", "").strip(),
            "elevation_raw": f(119, 5).decode("ascii"),
            "special": f(136, 1).decode("ascii"),
        })
    return recs


# ---------------------------------------------------------------- main

def main() -> int:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.exists() else {}

    normals, period = parse_normals(read_html(RAW / "snowfrostice_normals.html"))
    if len(normals) != 22:
        raise SystemExit(f"平年値の地点数が22でない: {len(normals)}")
    if period != "1990年8月～2020年7月":
        print(f"注意: 平年値の統計期間の表記が想定と異なる: {period}", file=sys.stderr)

    prev, prev_meta = parse_observed(read_html(RAW / "snow_previous.html"))
    cur, cur_meta = parse_observed(read_html(RAW / "snow.html"))

    smaster = read_smaster(RAW / "smaster.index.zip")
    by_name: dict[str, list[dict]] = {}
    for r in smaster:
        by_name.setdefault(r["name"], []).append(r)

    errors: list[str] = []
    stations = []
    for rec in normals:
        name = rec["name"]
        hist = by_name.get(name, [])
        nos = {r["station_no"] for r in hist}
        if len(nos) != 1:
            errors.append(f"{name}: 地点情報の対応が一意でない {sorted(nos)}")
            continue
        current = [r for r in hist if r["end"] == 99999999]
        if len(current) != 1:
            errors.append(f"{name}: 現在の地点情報が一意でない")
            continue
        cr = current[0]
        lat = dm_to_deg(cr["lat_raw"], 2)
        lon = dm_to_deg(cr["lon_raw"], 3)
        if not (41.3 < lat < 45.6 and 139.3 < lon < 145.9):
            errors.append(f"{name}: 座標が北海道の範囲外 {lat},{lon}")

        # 平年値期間中に位置（度分）が変わったか
        in_period = [r for r in hist if r["end"] >= NORMAL_FROM and r["start"] <= NORMAL_TO]
        positions = sorted({(r["lat_raw"], r["lon_raw"]) for r in in_period})
        elev_m = int(cr["elevation_raw"]) / 10 if cr["elevation_raw"].strip() else None

        quality = []
        if len(positions) > 1:
            quality.append("moved_during_normal_period")
        for k in USE_KEYS:
            if "reference" in rec["flags"][k]:
                quality.append(f"reference_value:{k}")
            if rec["values"][k] is None:
                quality.append(f"no_value:{k}")

        for k, expect in SPOT_CHECKS.get(name, {}).items():
            if rec["values"][k] != expect:
                errors.append(f"{name}: {k} が調査時の値と違う {rec['values'][k]} != {expect}")

        def obs_block(src: dict, meta: dict) -> dict:
            row = src.get(name)
            if row is None:
                errors.append(f"{name}: {meta.get('winter_year')}寒候年の観測状況に地点がない")
                row = {}
            return {k: row.get(k) for k in USE_KEYS}

        stations.append({
            "station_id": f"47{cr['station_no']:03d}",
            "name": name,
            "kana": cr["kana"],
            "romaji": cr["romaji"],
            "office": cr["office"],
            "kind": "気象官署" if cr["special"] != "1" else "特別地域気象観測所",
            "longitude": round(lon, 5),
            "latitude": round(lat, 5),
            "elevation_m": elev_m,
            "position_basis": "現在の地点（地点情報履歴で終了日が99999999の行）",
            "position_history_in_normal_period": [
                {"lat": round(dm_to_deg(a, 2), 5), "lon": round(dm_to_deg(b, 3), 5)} for a, b in positions
            ],
            "normal": {k: rec["values"][k] for k in USE_KEYS},
            "normal_flags": {k: rec["flags"][k] for k in USE_KEYS},
            "observed": {
                str(prev_meta["winter_year"]): obs_block(prev, prev_meta),
                str(cur_meta["winter_year"]): obs_block(cur, cur_meta),
            },
            "quality_flags": quality,
        })

    # 名称の重複・欠落の検査
    names = [s["name"] for s in stations]
    if len(set(names)) != len(names):
        errors.append("地点名が重複している")
    ids = [s["station_id"] for s in stations]
    if len(set(ids)) != len(ids):
        errors.append("地点番号が重複している")
    for src, label in ((prev, "前の寒候年"), (cur, "今の寒候年")):
        extra = set(src) - set(names)
        if extra:
            errors.append(f"{label}の観測状況に平年値にない地点: {sorted(extra)}")

    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1

    def obs_meta(meta: dict, url: str, file: str, complete: bool) -> dict:
        return {
            "winter_year": meta["winter_year"],
            "period": f"{meta['winter_year'] - 1}年8月1日～{meta['winter_year']}年7月31日",
            "as_of": meta["as_of"],
            "season_complete": complete,
            "source_url": url,
            "retrieved": manifest.get(file, {}).get("retrieved"),
        }

    out = {
        "title": "冬は、北から来る？",
        "generated": date.today().isoformat(),
        "season_day_origin": "08-01",
        "datasets": {
            "normal": {
                "label": "平年値",
                "data_kind": "normal",
                "reference_period": period,
                "reference_period_note": "1991寒候年～2020寒候年の30年平均（1990年8月～2020年7月）",
                "source_url": NORMALS_URL,
                "retrieved": manifest.get("snowfrostice_normals.html", {}).get("retrieved"),
            },
            "observed_prev": obs_meta(prev_meta, PREVIOUS_URL, "snow_previous.html", True),
            "observed_cur": obs_meta(cur_meta, CURRENT_URL, "snow.html", False),
        },
        "station_source": {
            "source_url": SMASTER_URL,
            "retrieved": manifest.get("smaster.index.zip", {}).get("retrieved"),
            "note": "緯度経度は度分（0.1分単位）を十進度へ変換。現在の地点位置を採用。",
        },
        "stations": stations,
    }
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    with OUT_CSV.open("w", encoding="utf-8", newline="") as fp:
        w = csv.writer(fp)
        w.writerow([
            "station_id", "name", "kind", "longitude", "latitude",
            "first_snow_mmdd", "last_snow_mmdd",
            "first_snow_cover_mmdd", "last_snow_cover_mmdd",
            "persistent_snow_start_mmdd", "persistent_snow_end_mmdd",
            "data_kind", "reference_period", "quality_flags", "source_url",
        ])
        for s in stations:
            n = s["normal"]
            w.writerow([
                s["station_id"], s["name"], s["kind"], s["longitude"], s["latitude"],
                n["snow_first"], n["snow_last"], n["cover_first"], n["cover_last"],
                n["persistent_first"], n["persistent_last"],
                "normal", period, ";".join(s["quality_flags"]), NORMALS_URL,
            ])

    moved = [s["name"] for s in stations if "moved_during_normal_period" in s["quality_flags"]]
    print(f"地点: {len(stations)}  平年値期間: {period}")
    print(f"観測状況: {prev_meta}  /  {cur_meta}")
    print(f"平年値期間中に位置の記録が変わった地点: {', '.join(moved) or 'なし'}")
    print(f"→ {OUT_JSON.relative_to(ROOT)} , {OUT_CSV.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
