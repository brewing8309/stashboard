// Fills an empty Stash with a small, fictional library for the end-to-end
// test: studios, performers (one favourite), tags and scenes without files,
// some linked to StashDB, some played long ago, one half watched.
"use strict";

const STASHDB = "https://stashdb.org/graphql";

async function gql(base, query, variables) {
  const res = await fetch(`${base}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (json.errors) throw new Error(`${json.errors[0].message} (in ${query.slice(0, 60)}…)`);
  return json.data;
}

const DAY = 86400000;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

async function seed(base, now = Date.now()) {
  const id = async (mutation, input, key) => (await gql(base, mutation, { input }))[key].id;

  const studios = {
    acme: await id("mutation($input: StudioCreateInput!) { studioCreate(input: $input) { id } }",
      { name: "Acme Studio", stash_ids: [{ endpoint: STASHDB, stash_id: "sdb-studio-acme" }] }, "studioCreate"),
    beta: await id("mutation($input: StudioCreateInput!) { studioCreate(input: $input) { id } }",
      { name: "Beta Films" }, "studioCreate")
  };

  const performer = (input) => id("mutation($input: PerformerCreateInput!) { performerCreate(input: $input) { id } }", input, "performerCreate");
  const performers = {
    jane: await performer({ name: "Jane Doe", gender: "FEMALE", favorite: true, stash_ids: [{ endpoint: STASHDB, stash_id: "sdb-perf-jane" }] }),
    mary: await performer({ name: "Mary Major", gender: "FEMALE", stash_ids: [{ endpoint: STASHDB, stash_id: "sdb-perf-mary" }] }),
    john: await performer({ name: "John Roe", gender: "MALE" })
  };

  const tag = (name) => id("mutation($input: TagCreateInput!) { tagCreate(input: $input) { id } }", { name }, "tagCreate");
  const tags = { outdoor: await tag("Outdoor"), romantic: await tag("Romantic"), classic: await tag("Classic") };

  const scenes = [];
  for (let i = 1; i <= 30; i++) {
    const input = {
      title: `Fictional Scene ${String(i).padStart(2, "0")}`,
      date: isoDay(now - i * 20 * DAY),
      studio_id: i % 3 === 0 ? studios.beta : studios.acme,
      performer_ids: [i % 2 ? performers.jane : performers.mary, ...(i % 5 === 0 ? [performers.john] : [])],
      tag_ids: [[tags.outdoor], [tags.romantic], [tags.classic]][i % 3],
      rating100: i % 4 === 0 ? 90 : i % 7 === 0 ? 60 : null
    };
    // Scenes 1–6 are "the StashDB scenes you already have" for the stash-box rows.
    if (i <= 6) input.stash_ids = [{ endpoint: STASHDB, stash_id: `sdb-scene-${i}` }];
    scenes.push(await id("mutation($input: SceneCreateInput!) { sceneCreate(input: $input) { id } }", input, "sceneCreate"));
  }

  // Played long ago (for "not watched in a while"), played recently, and one in progress.
  for (const n of [4, 8, 12, 16]) {
    await gql(base, "mutation($id: ID!, $times: [Timestamp!]) { sceneAddPlay(id: $id, times: $times) { count } }",
      { id: scenes[n - 1], times: [new Date(now - 200 * DAY).toISOString()] });
  }
  await gql(base, "mutation($id: ID!, $times: [Timestamp!]) { sceneAddPlay(id: $id, times: $times) { count } }",
    { id: scenes[19], times: [new Date(now - 2 * DAY).toISOString()] });
  await gql(base, "mutation($id: ID!) { sceneSaveActivity(id: $id, resume_time: 321.5, playDuration: 30) }", { id: scenes[2] });

  return { studios, performers, tags, scenes };
}

module.exports = { seed, gql, STASHDB };

if (require.main === module) {
  seed(process.argv[2] || "http://127.0.0.1:9999")
    .then((ids) => console.log(JSON.stringify(ids)))
    .catch((e) => { console.error(e); process.exit(1); });
}
