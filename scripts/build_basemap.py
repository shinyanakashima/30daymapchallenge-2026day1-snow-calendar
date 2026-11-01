"""Natural Earth（パブリックドメイン）の陸地ポリゴンを北海道周辺で切り抜き、
背景用の軽いGeoJSONにする。境界線は描かず、陸地の形だけを使う。

  python3 -m venv .venv && .venv/bin/pip install shapely
  curl -fsSLo data/raw/ne_10m_land.geojson \
    https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson
  .venv/bin/python scripts/build_basemap.py data/raw/ne_10m_land.geojson
"""
import json
import sys
from pathlib import Path

from shapely.geometry import box, mapping, shape
from shapely.ops import unary_union

BBOX = (138.8, 40.9, 146.6, 46.0)  # 西, 南, 東, 北
OUT = Path(__file__).resolve().parent.parent / "public" / "data" / "land.geojson"


def rnd(obj, nd=3):
    if isinstance(obj, (list, tuple)):
        return [rnd(o, nd) for o in obj]
    return round(obj, nd)


def main(src: str) -> None:
    clip = box(*BBOX)
    geoms = []
    for f in json.loads(Path(src).read_text(encoding="utf-8"))["features"]:
        g = shape(f["geometry"])
        if g.intersects(clip):
            geoms.append(g.intersection(clip))
    land = unary_union(geoms).simplify(0.004, preserve_topology=True)
    geom = mapping(land)
    geom = {"type": geom["type"], "coordinates": rnd(geom["coordinates"])}
    fc = {
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "properties": {"source": "Natural Earth 10m land"}, "geometry": geom}],
    }
    OUT.write_text(json.dumps(fc, separators=(",", ":")), encoding="utf-8")
    print(f"→ {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main(sys.argv[1])
