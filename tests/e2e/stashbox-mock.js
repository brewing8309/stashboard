// What the end-to-end test's fake StashDB answers, by the kind of
// queryScenes request Stashboard sends. sdb-scene-1…3 are in the seeded
// library (see seed.js), so they must come back marked as owned.
"use strict";

const IMAGE_HOST = "https://img.stashboard.test";

function scene(id, n, extra = {}) {
  return {
    id,
    title: `StashDB Scene ${id}`,
    release_date: `2026-10-${String(1 + (n % 20)).padStart(2, "0")}`,
    duration: 1500 + n * 60,
    studio: { id: "st", name: n % 2 ? "Acme Studio" : "Gamma Pictures" },
    images: [{ url: `${IMAGE_HOST}/${id}.svg`, width: 1280, height: 720 }],
    performers: [
      { as: null, performer: { id: "m", name: "John Roe", gender: "MALE" } },
      { as: null, performer: { id: "sdb-perf-jane", name: "Jane Doe", gender: "FEMALE" } }
    ],
    ...extra
  };
}

const ROWS = {
  trending: ["sdb-scene-1", "t2", "t3", "sdb-scene-2", "t5", "t6", "t7", "t8", "t9", "t10", "t11", "t12", "t13", "t14"],
  favorites: ["f1", "sdb-scene-3", "f3", "f4", "f5", "f6"],
  performers: ["p1", "p2", "p3", "p4"],
  new: ["n1", "n2", "n3"]
};

function kindOf(input) {
  if (input.sort === "TRENDING") return "trending";
  if (input.favorites) return "favorites";
  if (input.performers) return "performers";
  return "new";
}

function answer(input) {
  const ids = ROWS[kindOf(input)].slice(0, input.per_page || 25);
  return { data: { queryScenes: { count: ids.length, scenes: ids.map((id, n) => scene(id, n)) } } };
}

function imageSvg(label) {
  const hue = [...label].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,42%)"/><stop offset="1" stop-color="hsl(${(hue + 70) % 360},55%,22%)"/></linearGradient></defs><rect width="1280" height="720" fill="url(#g)"/></svg>`;
}

module.exports = { IMAGE_HOST, ROWS, kindOf, answer, imageSvg };
