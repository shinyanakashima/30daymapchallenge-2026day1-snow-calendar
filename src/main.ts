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

const MODES: Record<
  ModeId,
  { label: string; first: Key; last: Key; firstLabel: string; lastLabel: string; startWord: string; endWord: string }
> = {
  snow: {
    label: "初雪",
    first: "snow_first",
    last: "snow_last",
    firstLabel: "初雪",
    lastLabel: "雪の終日",
    startWord: "初雪",
    endWord: "雪の終日",
  },
  cover: {
    label: "積雪",
    first: "cover_first",
    last: "cover_last",
    firstLabel: "積雪の初日",
    lastLabel: "積雪の終日",
    startWord: "積雪の初日",
    endWord: "積雪の終日",
  },
  persistent: {
    label: "根雪",
    first: "persistent_first",
    last: "persistent_last",
    firstLabel: "根雪の初日",
    lastLabel: "根雪の終日",
    startWord: "根雪はじまる",
    endWord: "根雪おわる",
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
const ARRIVE_DAYS = 3;
const MONTH_TICKS = ["10-01", "11-01", "12-01", "01-01", "02-01", "03-01", "04-01", "05-01"];
const STEP_MS = 120;

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------------ 状態

const app = {
  data: null as unknown as DataFile,
  land: null as unknown as FeatureCollection,
  dataset: "normal" as DatasetId,
  mode: "snow" as ModeId,
  sort: "lat" as SortId,
  day: DAY_MIN,
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
const byId = (id: string) => app.data.stations.find((s) => s.station_id === id)!;

// ------------------------------------------------------------------ データ参照

function winterYear(ds: DatasetId): number | null {
  if (ds === "prev") return app.data.datasets.observed_prev.winter_year;
  if (ds === "cur") return app.data.datasets.observed_cur.winter_year;
  return null;
}

function datesOf(s: Station, ds: DatasetId = app.dataset): Dates {
  if (ds === "normal") return s.normal;
  return s.observed[String(winterYear(ds))];
}

function asOfDay(ds: DatasetId = app.dataset): number | null {
  if (ds !== "cur") return null;
  return toDay(app.data.datasets.observed_cur.as_of.slice(5));
}

function span(s: Station, ds: DatasetId = app.dataset, mode: ModeId = app.mode) {
  const d = datesOf(s, ds);
  return { f: toDay(d[MODES[mode].first]), l: toDay(d[MODES[mode].last]) };
}

function stateOf(s: Station, day: number, ds: DatasetId = app.dataset, mode: ModeId = app.mode): State {
  const { f, l } = span(s, ds, mode);
  const asOf = asOfDay(ds);
  if (asOf !== null && day > asOf) return "unknown"; // 速報の先は分からない
  if (f === null) return ds === "cur" ? "pending" : "none";
  if (day < f) return "pending";
  if (l !== null && day > l) return "ended";
  if (day < f + ARRIVE_DAYS) return "arrive";
  return "on";
}

function dateLabel(ds: DatasetId, day: number): string {
  const { m, d } = fromDay(day);
  const wy = winterYear(ds);
  if (wy === null) return `${m}月${d}日`;
  return `${m >= 8 ? wy - 1 : wy}年${m}月${d}日`;
}

function mdLabel(mmdd: string | null): string {
  if (!mmdd) return "—";
  const [m, d] = mmdd.split("-").map(Number);
  return `${m}月${d}日`;
}

function datasetName(ds: DatasetId): string {
  const D = app.data.datasets;
  if (ds === "normal") return "平年値";
  if (ds === "prev") return `${D.observed_prev.winter_year - 1}–${String(D.observed_prev.winter_year).slice(2)}年の冬`;
  return `今季 ${Number(D.observed_cur.as_of.slice(5, 7))}/${Number(D.observed_cur.as_of.slice(8, 10))}時点`;
}

// ------------------------------------------------------------------ 地図

const MAP_W = 640;
const MAP_H = 600;
const projection = geoConicConformal().parallels([42, 45]).rotate([-143, 0]);
const stationXY = new Map<string, [number, number]>();
let glowLayer: SVGGElement;
let fxLayer: SVGGElement;

const LABEL_POS: Record<string, [number, number, "start" | "end" | "middle"]> = {
  稚内: [10, 4, "start"],
  北見枝幸: [10, 4, "start"],
  雄武: [10, 4, "start"],
  紋別: [10, 4, "start"],
  網走: [10, 4, "start"],
  羽幌: [-10, 4, "end"],
  留萌: [-10, 4, "end"],
  旭川: [10, 4, "start"],
  岩見沢: [10, 4, "start"],
  札幌: [10, 12, "start"],
  小樽: [-10, -2, "end"],
  倶知安: [0, -11, "middle"],
  寿都: [-10, 4, "end"],
  江差: [-10, 4, "end"],
  函館: [10, 10, "start"],
  室蘭: [-10, 12, "end"],
  苫小牧: [10, 10, "start"],
  浦河: [10, 10, "start"],
  広尾: [10, 8, "start"],
  帯広: [10, 4, "start"],
  釧路: [10, 12, "start"],
  根室: [-6, -11, "end"],
};
const MINOR_LABELS = ["小樽", "倶知安", "岩見沢"];

function buildMap() {
  const svg = $<SVGSVGElement>("#map");
  svg.setAttribute("viewBox", `0 0 ${MAP_W} ${MAP_H}`);
  svg.innerHTML = "";

  const extent: GeoJSON.Feature = {
    type: "Feature",
    properties: {},
    geometry: {
      type: "MultiPoint",
      coordinates: [[139.6, 41.15], [145.8, 45.55], ...app.data.stations.map((s) => [s.longitude, s.latitude])],
    },
  };
  projection.fitExtent(
    [
      [24, 20],
      [MAP_W - 24, MAP_H - 20],
    ],
    extent,
  );
  const path = geoPath(projection);

  const defs = el("defs", {}, svg);
  const rg = el("radialGradient", { id: "glow" }, defs);
  el("stop", { offset: "0%", "stop-color": "#fff", "stop-opacity": 0.85 }, rg);
  el("stop", { offset: "35%", "stop-color": "#fff", "stop-opacity": 0.32 }, rg);
  el("stop", { offset: "100%", "stop-color": "#fff", "stop-opacity": 0 }, rg);

  const land = el("g", { class: "land" }, svg);
  for (const f of app.land.features) el("path", { d: path(f) ?? "" }, land);

  const grat = el("g", { class: "graticule" }, svg);
  for (let lat = 42; lat <= 45; lat++) {
    const line: GeoJSON.Feature = {
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: Array.from({ length: 41 }, (_, i) => [138.5 + i * 0.2, lat]) },
    };
    el("path", { d: path(line) ?? "" }, grat);
    const p = projection([145.95, lat]);
    if (p) {
      const t = el("text", { x: p[0], y: p[1] - 5, "text-anchor": "end", "data-dx": 0, "data-dy": -5 }, grat);
      t.textContent = `${lat}°N`;
    }
  }

  glowLayer = el("g", { class: "glows" }, svg);
  const layer = el("g", { class: "stations" }, svg);
  fxLayer = el("g", { class: "fx" }, svg);

  // 北の地点から順に現れる（初回のみ）
  const order = [...app.data.stations].sort((a, b) => b.latitude - a.latitude).map((s) => s.station_id);

  for (const s of app.data.stations) {
    const p = projection([s.longitude, s.latitude])!;
    stationXY.set(s.station_id, p);
    const tr = `translate(${p[0].toFixed(1)},${p[1].toFixed(1)})`;

    el("circle", { class: "glow", r: 0, fill: "url(#glow)", transform: tr, "data-id": s.station_id }, glowLayer);

    const gs = el(
      "g",
      { class: "st", transform: tr, "data-id": s.station_id, tabindex: 0, role: "button", "aria-label": s.name },
      layer,
    );
    gs.style.setProperty("--i", String(order.indexOf(s.station_id)));
    el("circle", { class: "hit", r: 16 }, gs);
    el("circle", { class: "ring", r: 9 }, gs);
    el("circle", { class: "dot", r: 5 }, gs);
    const [dx, dy, anchor] = LABEL_POS[s.name] ?? [10, 4, "start"];
    const minor = MINOR_LABELS.includes(s.name) ? " minor" : "";
    const t = el("text", { x: dx, y: dy, "data-dx": dx, "data-dy": dy, "text-anchor": anchor, class: `name${minor}` }, gs);
    t.textContent = s.name;

    gs.addEventListener("click", () => select(s.station_id));
    gs.addEventListener("keydown", (e) => {
      const k = (e as KeyboardEvent).key;
      if (k === "Enter" || k === " ") {
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
    const s = byId(gs.dataset.id!);
    const st = stateOf(s, app.day);
    gs.setAttribute(
      "class",
      `st s-${st}${app.selected === s.station_id ? " sel" : ""}${app.hover === s.station_id ? " hov" : ""}`,
    );
  }
  // 根雪の期間だけ、点のまわりを光らせる（日数とともに少しずつ広がる）
  for (const g of glowLayer.querySelectorAll<SVGCircleElement>(".glow")) {
    const s = byId(g.dataset.id!);
    let r = 0;
    if (app.mode === "persistent") {
      const st = stateOf(s, app.day);
      const { f, l } = span(s);
      if ((st === "on" || st === "arrive") && f !== null) {
        const grow = Math.min(1, (app.day - f + 1) / 24);
        const fade = l !== null ? Math.min(1, (l - app.day + 1) / 10) : 1;
        r = (16 + 30 * grow) * fade;
      }
    }
    g.setAttribute("r", r.toFixed(1));
  }
  // 画面全体の明るさ：その日に該当する地点の割合
  let n = 0;
  for (const s of app.data.stations) {
    const st = stateOf(s, app.day);
    if (st === "arrive" || st === "on") n++;
  }
  document.documentElement.style.setProperty("--snow", (n / app.data.stations.length).toFixed(3));
}

// ------------------------------------------------------------------ 演出（初日・終日の瞬間）

function burst(id: string, kind: "start" | "end") {
  if (reduceMotion) return;
  const p = stationXY.get(id);
  if (!p) return;
  const k = mapScale();
  const g = el("g", { transform: `translate(${p[0]},${p[1]})` }, fxLayer);

  if (kind === "start") {
    for (const [delay, max] of [
      [0, 46],
      [180, 78],
    ]) {
      const c = el("circle", { class: "ripple", r: 10 }, g);
      c.animate(
        [
          { transform: "scale(0.4)", opacity: 0.95 },
          { transform: `scale(${(max * k) / 10})`, opacity: 0 },
        ],
        { duration: 1500, delay, easing: "cubic-bezier(.15,.7,.3,1)", fill: "both" },
      );
    }
    const n = 12;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
      const dist = (22 + Math.random() * 26) * k;
      const c = el("circle", { class: "flake", r: (0.9 + Math.random() * 1.4) * Math.sqrt(k) }, g);
      c.animate(
        [
          { transform: "translate(0px,0px)", opacity: 1 },
          { transform: `translate(${Math.cos(a) * dist}px,${Math.sin(a) * dist}px)`, opacity: 0 },
        ],
        { duration: 1100 + Math.random() * 500, easing: "cubic-bezier(.1,.6,.3,1)", fill: "forwards" },
      );
    }
    const label = document.querySelector<SVGTextElement>(`#map .st[data-id="${id}"] .name`);
    label?.animate([{ fill: "#ffffff" }, { fill: "#ffffff", offset: 0.6 }, {}], { duration: 1800 });
  } else {
    const c = el("circle", { class: "ripple end", r: 10 }, g);
    c.animate(
      [
        { transform: "scale(0.8)", opacity: 0.8 },
        { transform: `scale(${2.8 * k})`, opacity: 0 },
      ],
      { duration: 1200, easing: "ease-out", fill: "both" },
    );
  }
  window.setTimeout(() => g.remove(), 2000);
}

function fireEvents(from: number, to: number) {
  // 1日〜数日ずつ進めたときだけ演出する（大きく飛ばしたときは出さない）
  if (to <= from || to - from > 4) return;
  for (const s of app.data.stations) {
    const { f, l } = span(s);
    const asOf = asOfDay();
    if (f !== null && f > from && f <= to && (asOf === null || f <= asOf)) burst(s.station_id, "start");
    if (l !== null && l + 1 > from && l + 1 <= to && (asOf === null || l <= asOf)) burst(s.station_id, "end");
  }
}

function mapScale() {
  const w = $<SVGSVGElement>("#map").clientWidth || MAP_W;
  return Math.min(1.9, Math.max(1, MAP_W / w));
}

// ------------------------------------------------------------------ 記録（起きたことを新しい順に）

function updateLog() {
  const m = MODES[app.mode];
  const asOf = asOfDay();
  const events: { day: number; text: string; id: string; end: boolean }[] = [];
  for (const s of app.data.stations) {
    const { f, l } = span(s);
    if (f !== null && f <= app.day && (asOf === null || f <= asOf)) events.push({ day: f, text: m.startWord, id: s.station_id, end: false });
    if (l !== null && l <= app.day && (asOf === null || l <= asOf)) events.push({ day: l, text: m.endWord, id: s.station_id, end: true });
  }
  events.sort((a, b) => b.day - a.day || byId(b.id).latitude - byId(a.id).latitude);
  const recent = events.slice(0, 7);
  const ol = $("#log");
  if (recent.length === 0) {
    ol.innerHTML = `<li class="empty">${dateLabel(app.dataset, app.day)}時点では、まだ${m.firstLabel}を迎えた地点はありません。</li>`;
    return;
  }
  ol.innerHTML = recent
    .map((e) => {
      const { m: mm, d } = fromDay(e.day);
      const fresh = app.day - e.day < ARRIVE_DAYS ? " fresh" : "";
      return `<li class="${e.end ? "end" : "start"}${fresh}" data-id="${e.id}"><time>${mm}.${String(d).padStart(2, "0")}</time><b>${byId(e.id).name}</b><span>${e.text}</span></li>`;
    })
    .join("");
  for (const li of ol.querySelectorAll<HTMLLIElement>("li[data-id]")) {
    li.addEventListener("click", () => select(li.dataset.id!));
  }
}

// ------------------------------------------------------------------ 日付まわりの表示

function updateHero() {
  const { m, d } = fromDay(app.day);
  $("#hero-m").textContent = String(m);
  $("#hero-d").textContent = String(d);
  const wy = winterYear(app.dataset);
  const yearText = wy === null ? "平年" : `${m >= 8 ? wy - 1 : wy}年`;
  $("#hero-kind").textContent = `${yearText}　${MODES[app.mode].label}`;

  const counts: Record<State, number> = { pending: 0, arrive: 0, on: 0, ended: 0, unknown: 0, none: 0 };
  for (const s of app.data.stations) counts[stateOf(s, app.day)]++;
  const total = app.data.stations.length;
  let text: string;
  if (counts.unknown === total) text = "この日付はまだ観測されていません";
  else if (app.mode === "persistent")
    text = `根雪の地点 <b>${counts.arrive + counts.on}</b><small>／${total}</small>${counts.ended ? `　終わった地点 ${counts.ended}` : ""}`;
  else text = `${MODES[app.mode].firstLabel}を迎えた地点 <b>${counts.arrive + counts.on + counts.ended}</b><small>／${total}</small>`;
  $("#hero-count").innerHTML = text;
}

// 下の帯：日付スライダーの背景に、各地点の初日（白）と終日（灰）の刻みを描く
const STRIP_H = 46;
function buildStrip() {
  const svg = $<SVGSVGElement>("#strip");
  const W = Math.max(200, svg.parentElement!.clientWidth);
  svg.setAttribute("viewBox", `0 0 ${W} ${STRIP_H}`);
  svg.setAttribute("width", String(W));
  svg.innerHTML = "";
  const x = (day: number) => ((day - DAY_MIN) / (DAY_MAX - DAY_MIN)) * W;

  el("line", { x1: 0, x2: W, y1: 24, y2: 24, class: "strip-base" }, svg);
  for (const mm of MONTH_TICKS) {
    const xx = x(toDay(mm)!);
    el("line", { x1: xx, x2: xx, y1: 18, y2: 30, class: "strip-month" }, svg);
    const t = el("text", { x: xx + 3, y: 42, class: "strip-label" }, svg);
    t.textContent = `${Number(mm.slice(0, 2))}月`;
  }
  const asOf = asOfDay();
  if (asOf !== null) {
    el("rect", { x: x(asOf + 0.5), y: 6, width: W - x(asOf + 0.5), height: 24, class: "strip-future" }, svg);
  }
  for (const s of app.data.stations) {
    const { f, l } = span(s);
    if (f !== null) el("line", { x1: x(f), x2: x(f), y1: 8, y2: 24, class: "strip-first" }, svg);
    if (l !== null) el("line", { x1: x(l), x2: x(l), y1: 24, y2: 32, class: "strip-last" }, svg);
  }
  el("line", { id: "strip-now", x1: 0, x2: 0, y1: 2, y2: 34, class: "strip-now" }, svg);
  el("rect", { id: "strip-done", x: 0, y: 23, width: 0, height: 2, class: "strip-done" }, svg);
  updateStrip();
}
function updateStrip() {
  const svg = $<SVGSVGElement>("#strip");
  const W = Number(svg.getAttribute("width")) || 1;
  const xx = ((app.day - DAY_MIN) / (DAY_MAX - DAY_MIN)) * W;
  const now = svg.querySelector("#strip-now");
  now?.setAttribute("x1", String(xx));
  now?.setAttribute("x2", String(xx));
  svg.querySelector("#strip-done")?.setAttribute("width", String(xx));
}

// ------------------------------------------------------------------ 暦（地点×日付）

let CAL_W = 720;
const ROW_H = 24;
const CAL_LEFT = 112;
const CAL_RIGHT = 12;
const CAL_TOP = 28;

function calX(day: number) {
  return CAL_LEFT + ((day - DAY_MIN) / (DAY_MAX - DAY_MIN)) * (CAL_W - CAL_LEFT - CAL_RIGHT);
}

function sortedStations(): Station[] {
  const list = [...app.data.stations];
  if (app.sort === "lat") return list.sort((a, b) => b.latitude - a.latitude);
  return list.sort((a, b) => (span(a).f ?? 9999) - (span(b).f ?? 9999) || b.latitude - a.latitude);
}

function buildCalendar() {
  const svg = $<SVGSVGElement>("#calendar");
  CAL_W = Math.max(320, Math.round(svg.parentElement!.clientWidth));
  const n = app.data.stations.length;
  const H = CAL_TOP + n * ROW_H + 8;
  svg.setAttribute("viewBox", `0 0 ${CAL_W} ${H}`);
  svg.setAttribute("width", String(CAL_W));
  svg.innerHTML = "";

  const axis = el("g", { class: "cal-axis" }, svg);
  for (const mm of MONTH_TICKS) {
    const x = calX(toDay(mm)!);
    el("line", { x1: x, x2: x, y1: CAL_TOP - 6, y2: H - 6 }, axis);
    const t = el("text", { x: x + 3, y: CAL_TOP - 12 }, axis);
    t.textContent = `${Number(mm.slice(0, 2))}月`;
  }

  const asOf = asOfDay();
  if (asOf !== null) {
    const x = calX(asOf + 1);
    el("rect", { x, y: CAL_TOP - 6, width: CAL_W - CAL_RIGHT - x, height: H - CAL_TOP, class: "cal-future" }, svg);
    const t = el("text", { x: x + 6, y: H - 12, class: "cal-future-label" }, svg);
    t.textContent = "未観測";
  }

  const rows = el("g", {}, svg);
  sortedStations().forEach((s, i) => {
    const y = CAL_TOP + i * ROW_H;
    const { f, l } = span(s);
    const g = el("g", { class: "cal-row", "data-id": s.station_id, transform: `translate(0,${y})` }, rows);
    el("rect", { class: "cal-hit", x: 0, y: 0, width: CAL_W, height: ROW_H }, g);
    el("text", { x: 2, y: ROW_H / 2 + 5, class: "cal-name" }, g).textContent = s.name;
    el("text", { x: CAL_LEFT - 10, y: ROW_H / 2 + 4, class: "cal-lat", "text-anchor": "end" }, g).textContent =
      `${s.latitude.toFixed(1)}°`;
    if (f !== null) {
      const end = l ?? asOf ?? f;
      el("rect", { class: `cal-bar${l === null ? " open" : ""}`, x: calX(f), y: ROW_H / 2 - 3, width: Math.max(2, calX(end) - calX(f)), height: 6 }, g);
      el("rect", { class: "cal-start", x: calX(f) - 1.5, y: ROW_H / 2 - 8, width: 3, height: 16 }, g);
      if (l !== null) el("rect", { class: "cal-end", x: calX(l) - 1, y: ROW_H / 2 - 5, width: 2, height: 10 }, g);
    }
    g.addEventListener("click", () => select(s.station_id));
    g.addEventListener("pointerenter", (e) => setHover(s.station_id, e as PointerEvent));
    g.addEventListener("pointermove", (e) => moveTip(e as PointerEvent));
    g.addEventListener("pointerleave", () => setHover(null));
  });

  el("line", { id: "cal-now", class: "cal-now", x1: 0, x2: 0, y1: CAL_TOP - 8, y2: H - 4 }, svg);

  const m = MODES[app.mode];
  $("#cal-title").textContent = `${m.label}の暦　${datasetName(app.dataset)}`;
  $("#cal-note").textContent =
    app.sort === "lat"
      ? `上から北の地点順。太い縦線が${m.firstLabel}、細い縦線が${m.lastLabel}。太い縦線が右下がりに並べば「北から順」に近いことになります。`
      : `${m.firstLabel}の早い順。左の数字は緯度です。`;
}

function updateCalendar() {
  const x = calX(Math.max(DAY_MIN, Math.min(DAY_MAX, app.day)));
  const now = $<SVGLineElement>("#cal-now");
  now.setAttribute("x1", String(x));
  now.setAttribute("x2", String(x));
  for (const g of document.querySelectorAll<SVGGElement>("#calendar .cal-row")) {
    const s = byId(g.dataset.id!);
    g.setAttribute(
      "class",
      `cal-row s-${stateOf(s, app.day)}${app.selected === s.station_id ? " sel" : ""}${app.hover === s.station_id ? " hov" : ""}`,
    );
  }
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
  const s = app.selected ? byId(app.selected) : null;
  if (!s) {
    box.innerHTML = `<p class="hint">点を選ぶと、その地点の初日と終日を並べて表示します。</p>`;
    return;
  }
  const cols: DatasetId[] = ["normal", "prev", "cur"];
  const head = (ds: DatasetId) =>
    ds === "normal" ? "平年" : ds === "prev" ? datasetName("prev").replace("の冬", "") : "今季";
  const rows: [string, Key][] = [
    ["初雪", "snow_first"],
    ["雪の終日", "snow_last"],
    ["積雪 初日", "cover_first"],
    ["積雪 終日", "cover_last"],
    ["根雪 初日", "persistent_first"],
    ["根雪 終日", "persistent_last"],
  ];
  const cell = (ds: DatasetId, k: Key) => {
    const v = datesOf(s, ds)[k];
    if (v) return mdLabel(v) + (ds === "normal" && s.normal_flags[k].includes("reference") ? "<sup>@</sup>" : "");
    return `<span class="muted">${ds === "cur" ? "未観測" : "記載なし"}</span>`;
  };
  const moved = s.position_history_in_normal_period.length > 1;
  box.innerHTML = `
    <div class="detail-head">
      <h2>${s.name}<span class="kana">${s.kana}</span></h2>
      <button type="button" class="close" aria-label="閉じる">閉じる</button>
    </div>
    <p class="meta">${s.kind}　${s.station_id}<br>${s.latitude.toFixed(2)}°N ${s.longitude.toFixed(2)}°E${s.elevation_m !== null ? `　標高${s.elevation_m}m` : ""}</p>
    <table class="dt">
      <thead><tr><th></th>${cols.map((c) => `<th${c === app.dataset ? ' class="cur"' : ""}>${head(c)}</th>`).join("")}</tr></thead>
      <tbody>${rows
        .map(([label, k]) => `<tr${MODES[app.mode].first === k || MODES[app.mode].last === k ? ' class="hl"' : ""}><th>${label}</th>${cols.map((c) => `<td${c === app.dataset ? ' class="cur"' : ""}>${cell(c, k)}</td>`).join("")}</tr>`)
        .join("")}</tbody>
    </table>
    <p class="meta small">今季は${app.data.datasets.observed_cur.as_of.replace(/-/g, "/")}時点の速報。${moved ? "平年値の統計期間中に観測場所が移っています（地図は現在の位置）。" : ""}</p>`;
  box.querySelector(".close")!.addEventListener("click", () => select(null));
}

// ------------------------------------------------------------------ ツールチップ

function setHover(id: string | null, e?: PointerEvent) {
  app.hover = id;
  const tip = $("#tip");
  if (!id) tip.hidden = true;
  else {
    const s = byId(id);
    const d = datesOf(s);
    const m = MODES[app.mode];
    tip.innerHTML = `<b>${s.name}</b>　${m.firstLabel} ${mdLabel(d[m.first])} ／ ${m.lastLabel} ${mdLabel(d[m.last])}<br><span class="muted">${dateLabel(app.dataset, app.day)}　${STATE_TEXT[app.mode][stateOf(s, app.day)]}</span>`;
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
  let x = e.clientX + pad;
  if (x + tip.offsetWidth > window.innerWidth - 8) x = e.clientX - tip.offsetWidth - pad;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${e.clientY + pad}px`;
}

// ------------------------------------------------------------------ 操作

function tabs<T extends string>(host: HTMLElement, items: { id: T; label: string }[], current: () => T, onPick: (id: T) => void) {
  host.innerHTML = "";
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "radio");
    b.textContent = it.label;
    b.dataset.id = it.id;
    b.addEventListener("click", () => {
      onPick(it.id);
      refreshTabs(host, current());
    });
    host.appendChild(b);
  }
  refreshTabs(host, current());
}
function refreshTabs(host: HTMLElement, id: string) {
  for (const b of host.querySelectorAll<HTMLButtonElement>("button")) {
    b.classList.toggle("on", b.dataset.id === id);
    b.setAttribute("aria-checked", String(b.dataset.id === id));
  }
}

function setDay(day: number) {
  const prev = app.day;
  app.day = Math.max(DAY_MIN, Math.min(DAY_MAX, day));
  $<HTMLInputElement>("#slider").value = String(app.day);
  const asOf = asOfDay();
  const notice = $("#notice");
  if (asOf !== null && app.day > asOf) {
    notice.hidden = false;
    notice.textContent = `今季は${app.data.datasets.observed_cur.as_of.replace(/-/g, "/")}時点の速報です。この先はまだ観測されていません。`;
  } else notice.hidden = true;
  fireEvents(prev, app.day);
  updateMap();
  updateHero();
  updateStrip();
  updateCalendar();
  updateLog();
  if (app.hover) setHover(app.hover);
}

function stop() {
  app.playing = false;
  window.clearInterval(app.timer);
  $("#play").classList.remove("playing");
  $("#play").setAttribute("aria-label", "再生");
}

function play() {
  const limit = asOfDay() ?? DAY_MAX; // 今季は速報の日付で止める
  if (app.day >= limit) setDay(DAY_MIN);
  app.playing = true;
  $("#play").classList.add("playing");
  $("#play").setAttribute("aria-label", "一時停止");
  app.timer = window.setInterval(() => {
    if (app.day >= limit) return stop();
    setDay(app.day + 1);
  }, STEP_MS);
}

function rebuildForData() {
  buildStrip();
  buildCalendar();
  renderDetail();
  setDay(app.day);
}

function renderSources() {
  const D = app.data.datasets;
  const day = (s: string | null) => (s ? s.slice(0, 10).replace(/-/g, "/") : "—");
  $("#sources").innerHTML = [
    `札幌管区気象台「<a href="${D.normal.source_url}" target="_blank" rel="noopener">初雪などの平年値</a>」統計期間 ${D.normal.reference_period}（${day(D.normal.retrieved)}取得）`,
    `札幌管区気象台「<a href="${D.observed_prev.source_url}" target="_blank" rel="noopener">雪・積雪・長期積雪（根雪）の初日、終日の観測状況（前の寒候年）</a>」${D.observed_prev.winter_year}寒候年、${day(D.observed_prev.as_of)}現在（${day(D.observed_prev.retrieved)}取得）`,
    `札幌管区気象台「<a href="${D.observed_cur.source_url}" target="_blank" rel="noopener">同（今の寒候年）</a>」${D.observed_cur.winter_year}寒候年、${day(D.observed_cur.as_of)}現在（${day(D.observed_cur.retrieved)}取得）`,
    `気象庁「<a href="${app.data.station_source.source_url}" target="_blank" rel="noopener">地上気象観測 地点情報履歴</a>」（${day(app.data.station_source.retrieved)}取得）`,
  ].join("<br>");
}

function fitMapText() {
  const k = mapScale();
  document.documentElement.style.setProperty("--map-k", k.toFixed(2));
  document.documentElement.classList.toggle("narrow-map", k > 1.3);
  for (const t of document.querySelectorAll<SVGTextElement>("#map text[data-dx]")) {
    t.setAttribute("x", String(Number(t.dataset.dx) * k));
    t.setAttribute("y", String(Number(t.dataset.dy) * k));
  }
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

  tabs<ModeId>(
    $("#mode"),
    (Object.keys(MODES) as ModeId[]).map((id) => ({ id, label: MODES[id].label })),
    () => app.mode,
    (id) => {
      app.mode = id;
      rebuildForData();
    },
  );
  tabs<DatasetId>(
    $("#dataset"),
    (["normal", "prev", "cur"] as DatasetId[]).map((id) => ({ id, label: datasetName(id) })),
    () => app.dataset,
    (id) => {
      app.dataset = id;
      if (id === "cur") {
        stop();
        app.day = asOfDay()!;
      }
      rebuildForData();
    },
  );
  tabs<SortId>(
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
  slider.step = "1";
  slider.addEventListener("input", () => {
    stop();
    setDay(Number(slider.value));
  });
  $("#play").addEventListener("click", () => (app.playing ? stop() : play()));
  document.addEventListener("keydown", (e) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "BUTTON") return;
    if (e.key === "ArrowRight") setDay(app.day + 1);
    if (e.key === "ArrowLeft") setDay(app.day - 1);
    if (e.key === " ") {
      e.preventDefault();
      app.playing ? stop() : play();
    }
  });

  let lastW = window.innerWidth;
  window.addEventListener("resize", () => {
    if (window.innerWidth === lastW) return;
    lastW = window.innerWidth;
    fitMapText();
    buildStrip();
    buildCalendar();
    updateCalendar();
  });

  buildMap();
  fitMapText();
  buildStrip();
  buildCalendar();
  renderDetail();
  renderSources();
  setDay(DAY_MIN);

  document.documentElement.classList.add("ready");
  // 地点が出そろってから、自動で再生を始める
  if (!reduceMotion) window.setTimeout(() => !app.playing && app.day === DAY_MIN && play(), 2200);
}

init().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML("beforeend", `<p class="notice">データを読み込めませんでした。</p>`);
});
