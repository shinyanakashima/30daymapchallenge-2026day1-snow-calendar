import "./style.css";
import { geoConicConformal, geoPath } from "d3-geo";
import type { FeatureCollection } from "geojson";

// ------------------------------------------------------------------ 型

type Key =
  | "snow_first"
  | "snow_last"
  | "cover_first"
  | "cover_last"
  | "persistent_first"
  | "persistent_last";
type Dates = Record<Key, string | null>;

interface Station {
  station_id: string;
  name: string;
  kana: string;
  kind: string;
  longitude: number;
  latitude: number;
  elevation_m: number | null;
  position_history_in_normal_period: { lat: number; lon: number }[];
  normal: Dates;
  normal_flags: Record<Key, string[]>;
  observed: Record<string, Dates>;
  quality_flags: string[];
}

interface ObsMeta {
  winter_year: number;
  period: string;
  as_of: string;
  season_complete: boolean;
  source_url: string;
  retrieved: string | null;
}

interface DataFile {
  datasets: {
    normal: { label: string; reference_period: string; source_url: string; retrieved: string | null };
    observed_prev: ObsMeta;
    observed_cur: ObsMeta;
  };
  station_source: { source_url: string; retrieved: string | null };
  stations: Station[];
}

type DatasetId = "normal" | "prev" | "cur";
type ModeId = "snow" | "cover" | "persistent";
type SortId = "lat" | "date";

type State = "pending" | "arrive" | "on" | "ended" | "unknown" | "none";

// ------------------------------------------------------------------ 定数

const MODES: Record<ModeId, { label: string; first: Key; last: Key; firstLabel: string; lastLabel: string }> = {
  snow: { label: "初雪", first: "snow_first", last: "snow_last", firstLabel: "初雪", lastLabel: "終雪（雪の終日）" },
  cover: { label: "積雪", first: "cover_first", last: "cover_last", firstLabel: "積雪の初日", lastLabel: "積雪の終日" },
  persistent: {
    label: "根雪",
    first: "persistent_first",
    last: "persistent_last",
    firstLabel: "根雪の初日",
    lastLabel: "根雪の終日",
  },
};

const STATE_TEXT: Record<ModeId, Record<State, string>> = {
  snow: {
    pending: "まだ初雪がない",
    arrive: "初雪を観測した日",
    on: "初雪を観測済み",
    ended: "雪の終日を過ぎた",
    unknown: "この日付はまだ観測されていない",
    none: "記載なし",
  },
  cover: {
    pending: "まだ積雪がない",
    arrive: "積雪の初日",
    on: "積雪の初日〜終日の間",
    ended: "積雪の終日を過ぎた",
    unknown: "この日付はまだ観測されていない",
    none: "記載なし",
  },
  persistent: {
    pending: "根雪の前",
    arrive: "根雪の初日",
    on: "根雪の期間",
    ended: "根雪が終わった",
    unknown: "この日付はまだ観測されていない／根雪は未確定",
    none: "記載なし",
  },
};

// 8月1日を0とする寒候年内の日番号（365日暦、2/29は扱わない）
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const SEASON_MONTHS = [8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7];

function toDay(mmdd: string | null): number | null {
  if (!mmdd) return null;
  const [m, d] = mmdd.split("-").map(Number);
  let n = 0;
  for (const sm of SEASON_MONTHS) {
    if (sm === m) return n + d - 1;
    n += MONTH_DAYS[sm - 1];
  }
  return null;
}

function fromDay(day: number): { m: number; d: number } {
  let n = day;
  for (const sm of SEASON_MONTHS) {
    const len = MONTH_DAYS[sm - 1];
    if (n < len) return { m: sm, d: n + 1 };
    n -= len;
  }
  return { m: 7, d: 31 };
}

const DAY_MIN = toDay("10-01")!;
const DAY_MAX = toDay("05-31")!;
const ARRIVE_DAYS = 3; // 初日の強調を何日見せるか

// ------------------------------------------------------------------ 状態

const app = {
  data: null as unknown as DataFile,
  land: null as unknown as FeatureCollection,
  dataset: "normal" as DatasetId,
  mode: "snow" as ModeId,
  sort: "lat" as SortId,
  day: toDay("10-15")!,
  selected: null as string | null,
  hover: null as string | null,
  playing: false,
  timer: 0,
};

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const SVGNS = "http://www.w3.org/2000/svg";
function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, parent?: Element) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (parent) parent.appendChild(e);
  return e;
}

// ------------------------------------------------------------------ データ参照

function datesOf(s: Station, ds: DatasetId = app.dataset): Dates {
  if (ds === "normal") return s.normal;
  const y = ds === "prev" ? app.data.datasets.observed_prev.winter_year : app.data.datasets.observed_cur.winter_year;
  return s.observed[String(y)];
}

function asOfDay(ds: DatasetId = app.dataset): number | null {
  if (ds !== "cur") return null;
  const a = app.data.datasets.observed_cur.as_of; // YYYY-MM-DD
  return toDay(a.slice(5));
}

function stateOf(s: Station, day: number, ds: DatasetId = app.dataset, mode: ModeId = app.mode): State {
  const d = datesOf(s, ds);
  const f = toDay(d[MODES[mode].first]);
  const l = toDay(d[MODES[mode].last]);
  const asOf = asOfDay(ds);

  if (asOf !== null && day > asOf) {
    // 速報の先は分からない。ただし既に観測された初日の強調だけは残さない。
    return "unknown";
  }
  if (f === null) {
    // 平年値・前の冬で空欄なら「記載なし」。今季は as_of までに未観測。
    return ds === "cur" ? "pending" : "none";
  }
  if (day < f) return "pending";
  if (l !== null && day > l) return "ended";
  if (day < f + ARRIVE_DAYS) return "arrive";
  return "on";
}

function seasonYearLabel(ds: DatasetId, day: number): string {
  const { m, d } = fromDay(day);
  if (ds === "normal") return `${m}月${d}日`;
  const wy = ds === "prev" ? app.data.datasets.observed_prev.winter_year : app.data.datasets.observed_cur.winter_year;
  const y = m >= 8 ? wy - 1 : wy;
  return `${y}年${m}月${d}日`;
}

function mdLabel(mmdd: string | null): string {
  if (!mmdd) return "—";
  const [m, d] = mmdd.split("-").map(Number);
  return `${m}月${d}日`;
}

// ------------------------------------------------------------------ 地図

const MAP_W = 640;
const MAP_H = 560;
const projection = geoConicConformal().parallels([42, 45]).rotate([-143, 0]);
let stationXY = new Map<string, [number, number]>();

// ラベルの置き方（混み合う地点だけ手で調整）
const LABEL_POS: Record<string, [number, number, "start" | "end" | "middle"]> = {
  稚内: [9, 4, "start"],
  北見枝幸: [9, 4, "start"],
  雄武: [9, 4, "start"],
  紋別: [9, 4, "start"],
  網走: [9, 4, "start"],
  羽幌: [-9, 4, "end"],
  留萌: [-9, 4, "end"],
  旭川: [9, 4, "start"],
  岩見沢: [9, 4, "start"],
  札幌: [9, 12, "start"],
  小樽: [-9, -2, "end"],
  倶知安: [0, -10, "middle"],
  寿都: [-9, 4, "end"],
  江差: [-9, 4, "end"],
  函館: [9, 10, "start"],
  室蘭: [-9, 12, "end"],
  苫小牧: [9, 10, "start"],
  浦河: [9, 10, "start"],
  広尾: [9, 8, "start"],
  帯広: [9, 4, "start"],
  釧路: [9, 12, "start"],
  根室: [-6, -10, "end"],
};

// 狭い画面では、混み合う地点の名前を選択・ホバー時だけ出す
const MINOR_LABELS = ["小樽", "倶知安", "岩見沢"];

function buildMap() {
  const svg = $<SVGSVGElement>("#map");
  svg.setAttribute("viewBox", `0 0 ${MAP_W} ${MAP_H}`);
  svg.innerHTML = "";

  const pts: GeoJSON.Feature = {
    type: "Feature",
    properties: {},
    geometry: {
      type: "MultiPoint",
      coordinates: [
        [139.6, 41.05],
        [145.75, 45.55],
        ...app.data.stations.map((s) => [s.longitude, s.latitude]),
      ],
    },
  };
  projection.fitExtent(
    [
      [36, 24],
      [MAP_W - 36, MAP_H - 20],
    ],
    pts,
  );
  const path = geoPath(projection);

  el("rect", { x: 0, y: 0, width: MAP_W, height: MAP_H, class: "sea" }, svg);
  const g = el("g", { class: "land" }, svg);
  for (const f of app.land.features) el("path", { d: path(f) ?? "" }, g);

  // 緯度線（1度おき）
  const grat = el("g", { class: "graticule" }, svg);
  for (let lat = 42; lat <= 45; lat++) {
    const line: GeoJSON.Feature = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "LineString",
        coordinates: Array.from({ length: 41 }, (_, i) => [138.5 + i * 0.2, lat]),
      },
    };
    el("path", { d: path(line) ?? "" }, grat);
    const p = projection([139.05, lat]);
    if (p) {
      const t = el("text", { x: p[0] + 2, y: p[1] - 4 }, grat);
      t.textContent = `北緯${lat}°`;
    }
  }

  stationXY = new Map();
  const layer = el("g", { class: "stations" }, svg);
  for (const s of app.data.stations) {
    const p = projection([s.longitude, s.latitude])!;
    stationXY.set(s.station_id, p);
    const gs = el("g", { class: "st", transform: `translate(${p[0].toFixed(1)},${p[1].toFixed(1)})`, "data-id": s.station_id, tabindex: 0, role: "button", "aria-label": s.name }, layer);
    el("circle", { class: "hit", r: 16 }, gs);
    el("circle", { class: "halo", r: 6 }, gs);
    el("circle", { class: "dot", r: 5.5 }, gs);
    const [dx, dy, anchor] = LABEL_POS[s.name] ?? [9, 4, "start"];
    const minor = MINOR_LABELS.includes(s.name) ? " minor" : "";
    const t = el("text", { x: dx, y: dy, "data-dx": dx, "data-dy": dy, "text-anchor": anchor, class: `name${minor}` }, gs);
    t.textContent = s.name;

    gs.addEventListener("click", () => select(s.station_id));
    gs.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter" || (e as KeyboardEvent).key === " ") {
        e.preventDefault();
        select(s.station_id);
      }
    });
    gs.addEventListener("pointerenter", (e) => setHover(s.station_id, e as PointerEvent));
    gs.addEventListener("pointermove", (e) => moveTip(e as PointerEvent));
    gs.addEventListener("pointerleave", () => setHover(null));
  }
}

function updateMap() {
  for (const gs of document.querySelectorAll<SVGGElement>("#map .st")) {
    const s = app.data.stations.find((x) => x.station_id === gs.dataset.id)!;
    const st = stateOf(s, app.day);
    gs.setAttribute("class", `st s-${st}${app.selected === s.station_id ? " sel" : ""}${app.hover === s.station_id ? " hov" : ""}`);
  }
}

// ------------------------------------------------------------------ 暦（地点×日付）

let CAL_W = 520;
const ROW_H = 22;
const CAL_LEFT = 104;
const CAL_RIGHT = 12;
const CAL_TOP = 26;

function calX(day: number) {
  return CAL_LEFT + ((day - DAY_MIN) / (DAY_MAX - DAY_MIN)) * (CAL_W - CAL_LEFT - CAL_RIGHT);
}

function sortedStations(): Station[] {
  const list = [...app.data.stations];
  if (app.sort === "lat") return list.sort((a, b) => b.latitude - a.latitude);
  const key = MODES[app.mode].first;
  return list.sort((a, b) => {
    const da = toDay(datesOf(a)[key]) ?? 9999;
    const db = toDay(datesOf(b)[key]) ?? 9999;
    return da - db || b.latitude - a.latitude;
  });
}

function buildCalendar() {
  const svg = $<SVGSVGElement>("#calendar");
  // 画面の幅に合わせて描き直す（文字を実寸で保つ）
  CAL_W = Math.max(300, Math.round(svg.parentElement!.clientWidth));
  svg.setAttribute("width", String(CAL_W));
  const n = app.data.stations.length;
  const H = CAL_TOP + n * ROW_H + 8;
  svg.setAttribute("viewBox", `0 0 ${CAL_W} ${H}`);
  svg.innerHTML = "";

  // 月の目盛り
  const axis = el("g", { class: "cal-axis" }, svg);
  for (const mm of ["10-01", "11-01", "12-01", "01-01", "02-01", "03-01", "04-01", "05-01"]) {
    const x = calX(toDay(mm)!);
    el("line", { x1: x, x2: x, y1: CAL_TOP - 6, y2: H - 6 }, axis);
    const t = el("text", { x: x + 3, y: CAL_TOP - 10 }, axis);
    t.textContent = `${Number(mm.slice(0, 2))}月`;
  }

  // 速報の範囲外（as_of より先）
  const asOf = asOfDay();
  if (asOf !== null) {
    const x = calX(asOf + 1);
    el("rect", { x, y: CAL_TOP - 6, width: CAL_W - CAL_RIGHT - x, height: H - CAL_TOP, class: "cal-future" }, svg);
    const t = el("text", { x: x + 4, y: H - 12, class: "cal-future-label" }, svg);
    t.textContent = "未観測";
  }

  const rows = el("g", { class: "cal-rows" }, svg);
  const m = MODES[app.mode];
  sortedStations().forEach((s, i) => {
    const y = CAL_TOP + i * ROW_H;
    const d = datesOf(s);
    const f = toDay(d[m.first]);
    const l = toDay(d[m.last]);
    const g = el("g", { class: "cal-row", "data-id": s.station_id, transform: `translate(0,${y})` }, rows);
    el("rect", { class: "cal-hit", x: 0, y: 0, width: CAL_W, height: ROW_H }, g);
    const name = el("text", { x: 4, y: ROW_H / 2 + 4, class: "cal-name" }, g);
    name.textContent = s.name;
    const lat = el("text", { x: CAL_LEFT - 8, y: ROW_H / 2 + 4, class: "cal-lat", "text-anchor": "end" }, g);
    lat.textContent = `${s.latitude.toFixed(1)}°`;

    if (f !== null) {
      const end = l ?? (asOf ?? f);
      el("rect", {
        class: `cal-bar${l === null ? " open" : ""}`,
        x: calX(f),
        y: ROW_H / 2 - 4,
        width: Math.max(2, calX(end) - calX(f)),
        height: 8,
        rx: 4,
      }, g);
      el("circle", { class: "cal-start", cx: calX(f), cy: ROW_H / 2, r: 4.5 }, g);
      if (l !== null) el("circle", { class: "cal-end", cx: calX(l), cy: ROW_H / 2, r: 3 }, g);
    }

    g.addEventListener("click", () => select(s.station_id));
    g.addEventListener("pointerenter", (e) => setHover(s.station_id, e as PointerEvent));
    g.addEventListener("pointermove", (e) => moveTip(e as PointerEvent));
    g.addEventListener("pointerleave", () => setHover(null));
  });

  el("line", { id: "cal-now", class: "cal-now", x1: 0, x2: 0, y1: CAL_TOP - 6, y2: H - 6 }, svg);

  $("#cal-title").textContent = `${m.label}：地点ごとの初日〜終日`;
  $("#cal-note").textContent =
    app.sort === "lat"
      ? "上から北の地点順。●が初日、・が終日。初日の●が右下がりに並べば「北から順」に近いことになります。"
      : `${m.firstLabel}の早い順。右の数字は緯度です。`;
}

function updateCalendar() {
  const x = calX(Math.max(DAY_MIN, Math.min(DAY_MAX, app.day)));
  const now = $<SVGLineElement>("#cal-now");
  now.setAttribute("x1", String(x));
  now.setAttribute("x2", String(x));
  for (const g of document.querySelectorAll<SVGGElement>("#calendar .cal-row")) {
    const s = app.data.stations.find((x) => x.station_id === g.dataset.id)!;
    const st = stateOf(s, app.day);
    g.setAttribute("class", `cal-row s-${st}${app.selected === s.station_id ? " sel" : ""}${app.hover === s.station_id ? " hov" : ""}`);
  }
}

// ------------------------------------------------------------------ 凡例・数

function updateLegend() {
  const t = STATE_TEXT[app.mode];
  const items: State[] = ["pending", "arrive", "on", "ended"];
  if (app.dataset === "cur") items.push("unknown");
  $("#legend").innerHTML = items
    .map(
      (k) =>
        `<span class="lg"><svg width="16" height="16" viewBox="-8 -8 16 16" class="st s-${k}"><circle class="halo" r="6"/><circle class="dot" r="5"/></svg>${t[k]}</span>`,
    )
    .join("");
}

function updateCounts() {
  const counts: Record<State, number> = { pending: 0, arrive: 0, on: 0, ended: 0, unknown: 0, none: 0 };
  for (const s of app.data.stations) counts[stateOf(s, app.day)]++;
  const m = MODES[app.mode];
  const reached = counts.arrive + counts.on + counts.ended;
  const label =
    app.mode === "persistent"
      ? `根雪の期間中 ${counts.arrive + counts.on} 地点 ／ 終了 ${counts.ended} 地点`
      : `${m.firstLabel}を迎えた地点 ${reached} / ${app.data.stations.length}`;
  $("#count-label").textContent = counts.unknown === app.data.stations.length ? "この日付はまだ観測されていません" : label;
}

// ------------------------------------------------------------------ 地点の詳細

function select(id: string | null) {
  app.selected = app.selected === id ? null : id;
  renderDetail();
  updateMap();
  updateCalendar();
}

function renderDetail() {
  const box = $("#detail");
  const s = app.data.stations.find((x) => x.station_id === app.selected);
  if (!s) {
    box.innerHTML = `<p class="detail-empty">地図の点か暦の行を選ぶと、その地点の初日・終日を表示します。</p>`;
    return;
  }
  const D = app.data.datasets;
  const cols: { id: DatasetId; head: string }[] = [
    { id: "normal", head: "平年値" },
    { id: "prev", head: `${D.observed_prev.winter_year - 1}–${String(D.observed_prev.winter_year).slice(2)}年` },
    { id: "cur", head: `${D.observed_cur.winter_year - 1}–${String(D.observed_cur.winter_year).slice(2)}年<small>速報</small>` },
  ];
  const rows: [string, Key][] = [
    ["初雪", "snow_first"],
    ["終雪", "snow_last"],
    ["積雪の初日", "cover_first"],
    ["積雪の終日", "cover_last"],
    ["根雪の初日", "persistent_first"],
    ["根雪の終日", "persistent_last"],
  ];
  const cell = (ds: DatasetId, k: Key) => {
    const v = datesOf(s, ds)[k];
    if (v) {
      const ref = ds === "normal" && s.normal_flags[k].includes("reference") ? "<sup>@</sup>" : "";
      return mdLabel(v) + ref;
    }
    return ds === "cur" ? `<span class="muted">未観測</span>` : `<span class="muted">記載なし</span>`;
  };
  const moved = s.position_history_in_normal_period.length > 1;
  box.innerHTML = `
    <div class="detail-head">
      <h3>${s.name}<span class="kana">${s.kana}</span></h3>
      <button type="button" class="close" aria-label="閉じる">×</button>
    </div>
    <p class="meta">${s.kind}（地点番号 ${s.station_id}）<br>北緯${s.latitude.toFixed(2)}° 東経${s.longitude.toFixed(2)}°${s.elevation_m !== null ? ` ／ 標高${s.elevation_m}m` : ""}</p>
    <table class="dt">
      <thead><tr><th></th>${cols.map((c) => `<th${c.id === app.dataset ? ' class="cur"' : ""}>${c.head}</th>`).join("")}</tr></thead>
      <tbody>${rows
        .map(([label, k]) => `<tr><th>${label}</th>${cols.map((c) => `<td${c.id === app.dataset ? ' class="cur"' : ""}>${cell(c.id, k)}</td>`).join("")}</tr>`)
        .join("")}</tbody>
    </table>
    <p class="meta small">速報は${D.observed_cur.as_of.replace(/-/g, "/")}現在。${
      moved ? "平年値の統計期間中に観測場所の移転記録があります（地図は現在の位置）。" : ""
    }</p>`;
  box.querySelector(".close")!.addEventListener("click", () => select(null));
}

// ------------------------------------------------------------------ ツールチップ

function setHover(id: string | null, e?: PointerEvent) {
  app.hover = id;
  const tip = $("#tip");
  if (!id) {
    tip.hidden = true;
  } else {
    const s = app.data.stations.find((x) => x.station_id === id)!;
    const d = datesOf(s);
    const m = MODES[app.mode];
    const st = stateOf(s, app.day);
    tip.innerHTML = `<b>${s.name}</b> <span class="muted">北緯${s.latitude.toFixed(1)}°</span><br>${m.firstLabel} ${mdLabel(d[m.first])}　${m.lastLabel.replace(/（.*）/, "")} ${mdLabel(d[m.last])}<br><span class="muted">${seasonYearLabel(app.dataset, app.day)}：${STATE_TEXT[app.mode][st]}</span>`;
    tip.hidden = false;
    if (e) moveTip(e);
  }
  updateMap();
  updateCalendar();
}

function moveTip(e: PointerEvent) {
  const tip = $("#tip");
  if (tip.hidden) return;
  const pad = 14;
  const w = tip.offsetWidth;
  let x = e.clientX + pad;
  if (x + w > window.innerWidth - 8) x = e.clientX - w - pad;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${e.clientY + pad}px`;
}

// ------------------------------------------------------------------ 操作部

function segmented<T extends string>(host: HTMLElement, items: { id: T; label: string }[], current: () => T, onPick: (id: T) => void) {
  host.innerHTML = "";
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.role = "radio";
    b.textContent = it.label;
    b.dataset.id = it.id;
    b.addEventListener("click", () => {
      onPick(it.id);
      refreshSeg(host, current());
    });
    host.appendChild(b);
  }
  refreshSeg(host, current());
}
function refreshSeg(host: HTMLElement, id: string) {
  for (const b of host.querySelectorAll<HTMLButtonElement>("button")) {
    const on = b.dataset.id === id;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  }
}

function setDay(day: number) {
  app.day = Math.max(DAY_MIN, Math.min(DAY_MAX, day));
  $<HTMLInputElement>("#slider").value = String(app.day);
  $("#date-label").textContent = seasonYearLabel(app.dataset, app.day);
  const asOf = asOfDay();
  const notice = $("#notice");
  if (asOf !== null && app.day > asOf) {
    notice.hidden = false;
    notice.textContent = `今季のデータは${app.data.datasets.observed_cur.as_of.replace(/-/g, "/")}現在の速報です。それより先の日付は未観測のため、点を灰色の破線で示しています。`;
  } else {
    notice.hidden = true;
  }
  updateMap();
  updateCalendar();
  updateCounts();
  if (app.hover) setHover(app.hover);
}

function stop() {
  app.playing = false;
  window.clearInterval(app.timer);
  $("#play").textContent = "▶";
  $("#play").setAttribute("aria-label", "再生");
}

function play() {
  const limit = asOfDay() ?? DAY_MAX; // 今季は速報の日付で止める
  if (app.day >= limit) setDay(DAY_MIN);
  app.playing = true;
  $("#play").textContent = "❚❚";
  $("#play").setAttribute("aria-label", "一時停止");
  app.timer = window.setInterval(() => {
    if (app.day >= limit) {
      stop();
      return;
    }
    setDay(app.day + 1);
  }, 110);
}

function buildTicks() {
  const host = $("#ticks");
  host.innerHTML = "";
  for (const mm of ["10-01", "11-01", "12-01", "01-01", "02-01", "03-01", "04-01", "05-01"]) {
    const s = document.createElement("span");
    s.textContent = `${Number(mm.slice(0, 2))}月`;
    s.style.left = `${((toDay(mm)! - DAY_MIN) / (DAY_MAX - DAY_MIN)) * 100}%`;
    host.appendChild(s);
  }
}

function renderSources() {
  const D = app.data.datasets;
  const day = (s: string | null) => (s ? s.slice(0, 10).replace(/-/g, "/") : "—");
  $("#sources").innerHTML = [
    `札幌管区気象台「<a href="${D.normal.source_url}" target="_blank" rel="noopener">初雪などの平年値</a>」（統計期間 ${D.normal.reference_period}、${day(D.normal.retrieved)}取得）`,
    `札幌管区気象台「<a href="${D.observed_prev.source_url}" target="_blank" rel="noopener">雪・積雪・長期積雪（根雪）の初日、終日の観測状況（前の寒候年）</a>」（${D.observed_prev.winter_year}寒候年、${day(D.observed_prev.as_of)}現在の表、${day(D.observed_prev.retrieved)}取得）`,
    `札幌管区気象台「<a href="${D.observed_cur.source_url}" target="_blank" rel="noopener">同（今の寒候年）</a>」（${D.observed_cur.winter_year}寒候年、${day(D.observed_cur.as_of)}現在の表、${day(D.observed_cur.retrieved)}取得）`,
    `気象庁「<a href="${app.data.station_source.source_url}" target="_blank" rel="noopener">地上気象観測 地点情報履歴</a>」（${day(app.data.station_source.retrieved)}取得）`,
  ].join("<br>");
}

// ------------------------------------------------------------------ 起動

async function init() {
  const base = import.meta.env.BASE_URL;
  const [data, land] = await Promise.all([
    fetch(`${base}data/stations.json`).then((r) => r.json() as Promise<DataFile>),
    fetch(`${base}data/land.geojson`).then((r) => r.json() as Promise<FeatureCollection>),
  ]);
  app.data = data;
  app.land = land;

  const D = data.datasets;
  segmented<DatasetId>(
    $("#dataset"),
    [
      { id: "normal", label: "平年値" },
      { id: "prev", label: `${D.observed_prev.winter_year - 1}–${String(D.observed_prev.winter_year).slice(2)}年の冬` },
      { id: "cur", label: `今季（${Number(D.observed_cur.as_of.slice(5, 7))}/${Number(D.observed_cur.as_of.slice(8, 10))}現在）` },
    ],
    () => app.dataset,
    (id) => {
      app.dataset = id;
      if (id === "cur") {
        stop();
        app.day = asOfDay()!;
      }
      buildCalendar();
      updateLegend();
      renderDetail();
      setDay(app.day);
    },
  );
  segmented<ModeId>(
    $("#mode"),
    (Object.keys(MODES) as ModeId[]).map((id) => ({ id, label: MODES[id].label })),
    () => app.mode,
    (id) => {
      app.mode = id;
      buildCalendar();
      updateLegend();
      setDay(app.day);
    },
  );
  segmented<SortId>(
    $("#sort"),
    [
      { id: "lat", label: "北から" },
      { id: "date", label: "早い順" },
    ],
    () => app.sort,
    (id) => {
      app.sort = id;
      buildCalendar();
      updateCalendar();
    },
  );

  const slider = $<HTMLInputElement>("#slider");
  slider.min = String(DAY_MIN);
  slider.max = String(DAY_MAX);
  slider.addEventListener("input", () => {
    stop();
    setDay(Number(slider.value));
  });
  $("#play").addEventListener("click", () => (app.playing ? stop() : play()));
  document.addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    if (e.key === "ArrowRight") setDay(app.day + 1);
    if (e.key === "ArrowLeft") setDay(app.day - 1);
  });

  // 地図は viewBox で拡縮するため、狭い画面では文字を相対的に大きくする
  const fitMapText = () => {
    const w = $<SVGSVGElement>("#map").clientWidth || MAP_W;
    const k = Math.min(1.9, Math.max(1, MAP_W / w));
    document.documentElement.style.setProperty("--map-k", k.toFixed(2));
    document.documentElement.classList.toggle("narrow-map", k > 1.3);
    for (const t of document.querySelectorAll<SVGTextElement>("#map .name")) {
      t.setAttribute("x", String(Number(t.dataset.dx) * k));
      t.setAttribute("y", String(Number(t.dataset.dy) * k));
    }
  };
  let lastW = window.innerWidth;
  window.addEventListener("resize", () => {
    if (window.innerWidth === lastW) return;
    lastW = window.innerWidth;
    fitMapText();
    buildCalendar();
    updateCalendar();
  });

  buildTicks();
  buildMap();
  fitMapText();
  buildCalendar();
  updateLegend();
  renderSources();
  setDay(app.day);
}

init().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML("beforeend", `<p class="notice">データを読み込めませんでした。</p>`);
});
