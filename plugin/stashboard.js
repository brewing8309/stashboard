/*
 * Stashboard: a dashboard for Stash's front page. Rows of scenes from the
 * library (continue watching, recently added, the day's tag, …), from the
 * Stash Curator plugin when it's installed, and from the stash-boxes set
 * up in Stash (trending on StashDB, new from your favourites, …).
 *
 * The logic lives in stashboard-core.js (window.StashboardCore); this file
 * does the talking (Stash GraphQL, stash-boxes, Curator) and the React UI.
 * It replaces the FrontPage component and keeps Stash's own front page
 * rows below the dashboard unless they're switched off. Whatever goes
 * wrong in here, the front page falls back to Stash's own.
 */
(function () {
  "use strict";

  if (window.__stashboardLoaded) return;
  window.__stashboardLoaded = true;

  const Api = window.PluginApi;
  const Core = window.StashboardCore;
  if (!Api || !Core) {
    console.error("[Stashboard] PluginApi or stashboard-core.js is missing; not loading.");
    return;
  }

  const React = Api.React;
  const h = React.createElement;
  const { useState, useEffect, useRef, useCallback } = React;
  const { Link } = Api.libraries.ReactRouterDOM;
  const { Button, Modal, Form } = Api.libraries.Bootstrap;

  const CARD_WIDTH = 300;
  const LOG = "[Stashboard]";

  /* ------------------------------------------------------------------ *
   * Talking to Stash, stash-boxes and Curator                          *
   * ------------------------------------------------------------------ */

  // Respects a reverse-proxy prefix: Stash sets <base href> to it.
  function graphqlUrl() {
    return new URL("graphql", document.baseURI).href;
  }

  async function stashQuery(query, variables) {
    const res = await fetch(graphqlUrl(), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables })
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json) throw new Error(`Stash: HTTP ${res.status}`);
    if (json.errors && json.errors.length) throw new Error(json.errors[0].message);
    return json.data;
  }

  // Scenes for SceneCard come through Stash's own client and FindScenes
  // document, so they always carry exactly the fields this Stash version's
  // cards expect.
  async function findSlimScenes(variables) {
    const client = Api.utils.StashService.getClient();
    const res = await client.query({ query: Api.GQL.FindScenesDocument, variables, fetchPolicy: "network-only" });
    return res.data.findScenes;
  }

  class CodedError extends Error {
    constructor(code, message) {
      super(message || code);
      this.code = code;
    }
  }

  async function boxQuery(box, query, variables) {
    if (!box.apiKey) throw new CodedError("noKey");
    const res = await fetch(box.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ApiKey: box.apiKey },
      body: JSON.stringify({ query, variables })
    });
    if (res.status === 401 || res.status === 403) throw new CodedError("noKey");
    const json = await res.json().catch(() => null);
    if (!res.ok || !json) throw new Error(`${box.name}: HTTP ${res.status}`);
    if (json.errors && json.errors.length) {
      // A request without a key gets 200 and this error; a wrong key gets 401.
      if (/not authori[sz]ed/i.test(json.errors[0].message)) throw new CodedError("noKey");
      throw new Error(`${box.name}: ${json.errors[0].message}`);
    }
    return json.data;
  }

  async function curatorOperation(args) {
    const data = await stashQuery(
      `mutation StashboardCurator($args: Map!) { runPluginOperation(plugin_id: "${Core.CURATOR_PLUGIN_ID}", args: $args) }`,
      { args }
    );
    return data.runPluginOperation;
  }

  const ENV_QUERY = `query StashboardEnvironment {
  configuration {
    general { stashBoxes { endpoint api_key name } }
    interface { language }
    plugins(include: ["${Core.PLUGIN_ID}"])
  }
  plugins { id enabled }
}`;

  async function loadEnvironment() {
    const data = await stashQuery(ENV_QUERY);
    const raw = (data.configuration.plugins && data.configuration.plugins[Core.PLUGIN_ID]) || {};
    const settings = Core.readSettings(raw);
    const { boxes, unsupported } = Core.usableBoxes(data.configuration.general.stashBoxes);
    const env = {
      lang: Core.langOf(data.configuration.interface && data.configuration.interface.language),
      curator: Core.curatorAvailable(data.plugins),
      boxes,
      unsupported,
      disableExternal: settings.disableExternal
    };
    return { env, settings, raw, layout: Core.resolveLayout(settings.layout, env) };
  }

  async function saveSettings(raw, changes) {
    await stashQuery(
      `mutation StashboardSave($input: Map!) { configurePlugin(plugin_id: "${Core.PLUGIN_ID}", input: $input) }`,
      { input: { ...raw, ...changes } }
    );
  }

  function storage() {
    try {
      return window.localStorage;
    } catch (e) {
      return null;
    }
  }

  function sessionNumber(key) {
    try {
      return parseInt(window.sessionStorage.getItem(key), 10) || 0;
    } catch (e) {
      return 0;
    }
  }

  function setSessionNumber(key, value) {
    try {
      window.sessionStorage.setItem(key, String(value));
    } catch (e) { /* not kept across navigation then */ }
  }

  /* ------------------------------------------------------------------ *
   * Row data                                                            *
   * ------------------------------------------------------------------ */

  function dig(obj, path) {
    return path.reduce((o, k) => (o == null ? o : o[k]), obj);
  }

  async function loadLocalRow(row, ctx) {
    let picked = null;
    const pick = Core.pickQuery(row.kind, ctx.seed);
    if (pick) {
      picked = (dig(await stashQuery(pick.query, pick.variables), pick.path) || [])[0] || null;
      if (!picked) return { scenes: [], picked };
    }
    const variables = Core.localRowQuery(row.kind, { count: ctx.count, seed: ctx.seed, now: ctx.now, pickedId: picked && picked.id });
    if (!variables) return { scenes: [], picked };
    const result = await findSlimScenes(variables);
    return { scenes: result.scenes, picked };
  }

  async function loadCuratorRow(lane, ctx) {
    const output = await curatorOperation({ operation: "get_slate", lane, count: ctx.count, page: 1, draw_seed: `stashboard-${ctx.seed}` });
    const ids = Core.curatorSceneIds(output);
    if (!ids.length) return { scenes: [] };
    const result = await findSlimScenes({ filter: { per_page: ids.length }, scene_ids: ids.map(Number) });
    return { scenes: Core.orderByIds(result.scenes, ids) };
  }

  const FOLLOWED_QUERY = `query StashboardFollowed($filter: FindFilterType, $f: PerformerFilterType) {
  findPerformers(filter: $filter, performer_filter: $f) { performers { id favorite stash_ids { endpoint stash_id } } }
}`;

  async function followedPerformers(box) {
    const linked = { stash_id_endpoint: { endpoint: box.endpoint, modifier: "NOT_NULL" } };
    const [favourites, collected] = await Promise.all([
      stashQuery(FOLLOWED_QUERY, { filter: { per_page: Core.BOX_PERFORMERS_MAX, sort: "scenes_count", direction: "DESC" }, f: { ...linked, filter_favorites: true } }),
      stashQuery(FOLLOWED_QUERY, { filter: { per_page: Core.BOX_PERFORMERS_MAX, sort: "scenes_count", direction: "DESC" }, f: linked })
    ]);
    return Core.followedPerformerIds([...favourites.findPerformers.performers, ...collected.findPerformers.performers], box.endpoint);
  }

  const OWNED_QUERY = `query StashboardOwned($f: SceneFilterType) {
  findScenes(scene_filter: $f, filter: { per_page: -1 }) { scenes { id stash_ids { endpoint stash_id } } }
}`;

  // Needs Stash 0.31+ (stash_ids_endpoint takes a list); older versions
  // just don't get the ✓.
  async function ownedScenes(box, ids) {
    if (!ids.length) return {};
    try {
      const data = await stashQuery(OWNED_QUERY, { f: { stash_ids_endpoint: { endpoint: box.endpoint, stash_ids: ids, modifier: "EQUALS" } } });
      return Core.ownedMap(data.findScenes.scenes, box.endpoint);
    } catch (e) {
      console.warn(LOG, "Couldn't check which scenes are already in the library:", e.message);
      return {};
    }
  }

  async function loadBoxRow(row, box, ctx) {
    // Ask for more when owned scenes get hidden, so the row stays full.
    // Not keyed by the mix: these rows aren't random, so New mix doesn't
    // need to ask the stash-box again.
    const want = ctx.hideOwned ? ctx.count * 2 : ctx.count;
    const key = `${box.host}:${row.kind}:${want}:${ctx.day}`;
    let cards = Core.cacheGet(storage(), key, ctx.cacheHours * 3600000, ctx.now);
    if (!cards) {
      let performerIds;
      if (row.kind === "performers") {
        performerIds = await followedPerformers(box);
        if (!performerIds.length) return { cards: [] };
      }
      const input = Core.boxRowInput(row.kind, { count: want, now: ctx.now, performerIds });
      const data = await boxQuery(box, Core.BOX_SCENES_QUERY, { input });
      cards = ((data.queryScenes && data.queryScenes.scenes) || []).map((s) => Core.normalizeBoxScene(s, box));
      Core.cacheSet(storage(), key, cards, ctx.now);
    }
    const owned = await ownedScenes(box, cards.map((c) => c.id));
    return { cards: Core.applyOwnership(cards, owned, ctx.hideOwned).slice(0, ctx.count) };
  }

  async function loadSpotlight(env, ctx) {
    if (env.curator) {
      try {
        const { scenes } = await loadCuratorRow("best_bets", { ...ctx, count: 1 });
        if (scenes[0]) return { scene: scenes[0], reason: "spotlight.curator" };
      } catch (e) {
        console.warn(LOG, "Curator spotlight unavailable:", e.message);
      }
    }
    for (const [kind, reason] of [["top_rated", "spotlight.local"], ["random", "spotlight.random"]]) {
      const variables = Core.localRowQuery(kind, { count: 1, seed: ctx.seed, now: ctx.now });
      const result = await findSlimScenes(variables);
      if (result.scenes[0]) return { scene: result.scenes[0], reason };
    }
    return { scene: null };
  }

  // Runs `load` once the row is on (or near) screen; drops the answer if
  // the row has changed or gone meanwhile.
  function useRowData(load, key, active) {
    const [state, setState] = useState({ status: "idle" });
    useEffect(() => {
      if (!active) return undefined;
      let current = true;
      setState({ status: "loading" });
      load().then(
        (data) => current && setState({ status: "done", data }),
        (error) => {
          if (!current) return;
          console.warn(LOG, key, error);
          setState({ status: "error", error });
        }
      );
      return () => { current = false; };
      // `load` is rebuilt every render; `key` says when it really changed.
    }, [key, active]);
    return state;
  }

  function useNearScreen(ref) {
    const [near, setNear] = useState(typeof IntersectionObserver === "undefined");
    useEffect(() => {
      if (near || !ref.current) return undefined;
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      }, { rootMargin: "600px 0px" });
      observer.observe(ref.current);
      return () => observer.disconnect();
    }, [near]);
    return near;
  }

  /* ------------------------------------------------------------------ *
   * Building blocks                                                     *
   * ------------------------------------------------------------------ */

  class Boundary extends React.Component {
    constructor(props) {
      super(props);
      this.state = { failed: false };
    }

    static getDerivedStateFromError() {
      return { failed: true };
    }

    componentDidCatch(error) {
      console.error(LOG, this.props.name || "", error);
    }

    render() {
      if (this.state.failed) return this.props.fallback === undefined ? null : this.props.fallback;
      return this.props.children;
    }
  }

  function RowFrame({ id, title, href, label, children }) {
    const linkEl = href ? h(Link, { to: href, className: "stashboard-view-all" }, label) : h("span");
    const Native = Api.components.RecommendationRow;
    const className = `stashboard-row stashboard-row-${id.replace(/[^a-z0-9]+/gi, "-")}`;
    if (Native) return h(Native, { className, header: title, link: linkEl }, children);
    return h("div", { className: `recommendation-row ${className}` },
      h("div", { className: "recommendation-row-head" }, h("div", null, h("h2", null, title)), linkEl),
      children);
  }

  function Strip({ lang, children }) {
    const ref = useRef(null);
    const scroll = (dir) => {
      const el = ref.current;
      if (el) el.scrollBy({ left: dir * Math.max(CARD_WIDTH, el.clientWidth * 0.8), behavior: "smooth" });
    };
    return h("div", { className: "stashboard-strip-wrap" },
      h("button", { type: "button", className: "stashboard-strip-btn stashboard-strip-left", title: Core.t(lang, "action.scrollLeft"), "aria-label": Core.t(lang, "action.scrollLeft"), onClick: () => scroll(-1) }, "‹"),
      h("div", { className: "stashboard-strip", ref }, children),
      h("button", { type: "button", className: "stashboard-strip-btn stashboard-strip-right", title: Core.t(lang, "action.scrollRight"), "aria-label": Core.t(lang, "action.scrollRight"), onClick: () => scroll(1) }, "›"));
  }

  function Skeletons({ count }) {
    return Array.from({ length: Math.min(count, 6) }, (_, i) =>
      h("div", { key: `s${i}`, className: "stashboard-skeleton", style: { width: CARD_WIDTH } }));
  }

  function LocalCard({ scene, index }) {
    const Card = Api.components.SceneCard;
    if (Card) return h(Card, { scene, index, width: CARD_WIDTH, zoomIndex: 1 });
    return h(Link, { to: `/scenes/${scene.id}`, className: "stashboard-ext-card", style: { width: CARD_WIDTH } },
      h("div", { className: "stashboard-ext-thumb" }, scene.paths && scene.paths.screenshot ? h("img", { src: scene.paths.screenshot, alt: "", loading: "lazy" }) : null),
      h("div", { className: "stashboard-ext-body" }, h("div", { className: "stashboard-ext-title" }, scene.title || `#${scene.id}`)));
  }

  // stasharr's version, once it has marked the page (it may do so after
  // the dashboard has rendered), or null.
  function useStasharr() {
    const read = () => document.documentElement.getAttribute(Core.STASHARR_ATTRIBUTE);
    const [version, setVersion] = useState(read);
    useEffect(() => {
      const update = () => setVersion(read());
      window.addEventListener("stasharr:ready", update);
      const observer = new MutationObserver(update);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: [Core.STASHARR_ATTRIBUTE] });
      update();
      return () => {
        window.removeEventListener("stasharr:ready", update);
        observer.disconnect();
      };
    }, []);
    return version;
  }

  function BoxCard({ card, box, lang, stasharr }) {
    const owned = !!card.localId;
    const download = stasharr ? Core.downloadLink(card, box) : null;
    const meta = [card.studio, card.date].filter(Boolean).join(" · ");
    const thumb = [
      card.image ? h("img", { key: "i", src: card.image, alt: "", loading: "lazy", referrerPolicy: "no-referrer" }) : h("div", { key: "i", className: "stashboard-ext-noimg" }),
      card.duration ? h("span", { key: "d", className: "stashboard-ext-duration" }, Core.formatDuration(card.duration)) : null
    ];
    const external = { href: card.url, target: "_blank", rel: "noopener noreferrer" };
    return h("div", { className: `stashboard-ext-card${owned ? " is-owned" : ""}`, style: { width: CARD_WIDTH } },
      owned
        ? h(Link, { to: `/scenes/${card.localId}`, className: "stashboard-ext-thumb" }, thumb)
        : h("a", { ...external, className: "stashboard-ext-thumb" }, thumb),
      h("div", { className: "stashboard-ext-body" },
        owned ? h(Link, { to: `/scenes/${card.localId}`, className: "stashboard-badge stashboard-badge-owned" }, Core.t(lang, "badge.owned")) : null,
        h("a", { ...external, className: "stashboard-ext-title", title: card.title }, card.title || "—"),
        meta ? h("div", { className: "stashboard-ext-meta" }, meta) : null,
        card.performers.length ? h("div", { className: "stashboard-ext-performers", title: card.performers.join(", ") }, card.performers.join(", ")) : null,
        h("div", { className: "stashboard-ext-actions" },
          download
            ? h("a", { href: download, target: "_blank", rel: "noopener noreferrer", className: "btn btn-primary btn-sm stashboard-download", title: Core.t(lang, "action.download.title") }, `⬇ ${Core.t(lang, "action.download")}`)
            : null,
          h("a", { ...external, className: "stashboard-ext-source" }, `↗ ${box.name}`))));
  }

  function RowMessage({ text }) {
    return h("div", { className: "stashboard-row-message" }, text);
  }

  function errorText(error, lang, box) {
    if (error && error.code === "noKey") return Core.t(lang, "error.noKey", { box: box ? box.name : "" });
    const message = (error && error.message) || String(error);
    if (/model|no recommendations|not ready|sync/i.test(message) && !box) return Core.t(lang, "error.curatorModel");
    return Core.t(lang, "error.row", { message });
  }

  /* ------------------------------------------------------------------ *
   * Rows                                                                *
   * ------------------------------------------------------------------ */

  function Row({ id, env, ctx }) {
    const ref = useRef(null);
    const stasharr = useStasharr();
    const near = useNearScreen(ref);
    const row = Core.parseRowId(id);
    const box = row.source === "box" ? env.boxes.find((b) => b.host === row.host) : null;
    const seed = Core.rowSeed(ctx.day, id, ctx.mix);
    const rowCtx = { ...ctx, seed };
    const state = useRowData(() => {
      if (row.source === "local") return loadLocalRow(row, rowCtx);
      if (row.source === "curator") return loadCuratorRow(row.lane, rowCtx);
      return loadBoxRow(row, box, rowCtx);
    }, `${id}|${seed}|${ctx.refresh}|${ctx.count}|${ctx.hideOwned}`, near);

    const data = state.data || {};
    const items = row.source === "box" ? data.cards : data.scenes;
    // An empty row says nothing; hide it. Errors are shown, the row was asked for.
    if (state.status === "done" && (!items || !items.length)) return h("div", { ref, className: "stashboard-row-empty", "data-row": id });

    const title = Core.rowTitle(env.lang, id, env, data.picked);
    const href = row.source === "local" ? Core.localRowLink(row.kind, data.picked) : null;
    let body;
    if (state.status === "error") body = h(RowMessage, { text: errorText(state.error, env.lang, box) });
    else if (state.status !== "done") body = h(Strip, { lang: env.lang }, h(Skeletons, { count: ctx.count }));
    else if (row.source === "box") body = h(Strip, { lang: env.lang }, items.map((card) => h(BoxCard, { key: card.id, card, box, lang: env.lang, stasharr })));
    else body = h(Strip, { lang: env.lang }, items.map((scene, i) => h(LocalCard, { key: scene.id, scene, index: i })));

    return h("div", { ref, "data-row": id },
      h(RowFrame, { id, title, href, label: Core.t(env.lang, "action.viewAll") }, body));
  }

  function Spotlight({ env, ctx }) {
    const seed = Core.rowSeed(ctx.day, "spotlight", ctx.mix);
    const state = useRowData(() => loadSpotlight(env, { ...ctx, seed }), `spotlight|${seed}|${ctx.refresh}`, true);
    const scene = state.data && state.data.scene;
    if (state.status === "error" || (state.status === "done" && !scene)) return null;
    if (!scene) return h("div", { className: "stashboard-spotlight stashboard-spotlight-loading", "data-row": "spotlight" });

    const lang = env.lang;
    const file = (scene.files || [])[0];
    const meta = [scene.studio && scene.studio.name, scene.date, file && Core.formatDuration(file.duration)].filter(Boolean).join(" · ");
    const performers = (scene.performers || []).map((p) => p.name).join(", ");
    const image = scene.paths && scene.paths.screenshot;
    return h("section", { className: "stashboard-spotlight", "data-row": "spotlight" },
      image ? h("div", { className: "stashboard-spotlight-image", style: { backgroundImage: `url("${String(image).replace(/"/g, "%22")}")` } }) : null,
      h("div", { className: "stashboard-spotlight-shade" }),
      h("div", { className: "stashboard-spotlight-content" },
        h("span", { className: "stashboard-spotlight-reason" }, Core.t(lang, state.data.reason)),
        h("h2", { className: "stashboard-spotlight-title" }, h(Link, { to: `/scenes/${scene.id}` }, scene.title || `#${scene.id}`)),
        meta ? h("div", { className: "stashboard-spotlight-meta" }, meta) : null,
        performers ? h("div", { className: "stashboard-spotlight-performers" }, performers) : null,
        scene.details ? h("p", { className: "stashboard-spotlight-details" }, scene.details) : null,
        h("div", { className: "stashboard-spotlight-actions" },
          h(Link, { to: `/scenes/${scene.id}?autoplay=true`, className: "btn btn-primary" }, `▶ ${Core.t(lang, "action.play")}`),
          h(Link, { to: `/scenes/${scene.id}`, className: "btn btn-secondary" }, Core.t(lang, "action.details")))));
  }

  /* ------------------------------------------------------------------ *
   * Customise dialog                                                    *
   * ------------------------------------------------------------------ */

  function sourceLabel(lang, id, env) {
    const row = Core.parseRowId(id);
    if (row.source === "curator") return Core.t(lang, "source.curator");
    if (row.source === "box") {
      const box = env.boxes.find((b) => b.host === row.host);
      return Core.t(lang, "source.box", { box: box ? box.name : row.host });
    }
    return Core.t(lang, "source.local");
  }

  function Customise({ state, onClose, onSave }) {
    const { env } = state;
    const lang = env.lang;
    const available = new Set(Core.availableRows(env));
    const [rows, setRows] = useState(() => state.layout.map((r) => ({ ...r })));
    const [saving, setSaving] = useState(false);
    const shown = rows.filter((r) => available.has(r.id));

    const move = (id, dir) => setRows((list) => {
      const visible = list.filter((r) => available.has(r.id));
      const i = visible.findIndex((r) => r.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= visible.length) return list;
      const next = list.slice();
      const a = next.indexOf(visible[i]);
      const b = next.indexOf(visible[j]);
      [next[a], next[b]] = [next[b], next[a]];
      return next;
    });
    const toggle = (id) => setRows((list) => list.map((r) => (r.id === id ? { ...r, on: !r.on } : r)));
    const save = async () => {
      setSaving(true);
      try {
        await onSave(rows);
      } finally {
        setSaving(false);
      }
    };

    const hints = [];
    if (!env.boxes.length && !env.disableExternal) hints.push(Core.t(lang, "customise.noBoxes"));
    if (env.unsupported.length) hints.push(Core.t(lang, "customise.unsupported", { known: Core.KNOWN_BOXES.map((b) => b.name).join(", "), names: env.unsupported.join(", ") }));
    if (!env.curator) hints.push(Core.t(lang, "customise.noCurator"));

    return h(Modal, { show: true, onHide: onClose, size: "lg", className: "stashboard-customise", scrollable: true },
      h(Modal.Header, { closeButton: true }, h(Modal.Title, null, Core.t(lang, "customise.title"))),
      h(Modal.Body, null,
        h("p", { className: "text-muted" }, Core.t(lang, "customise.hint")),
        hints.map((text, i) => h("p", { key: i, className: "stashboard-customise-hint" }, text)),
        h("ul", { className: "stashboard-customise-list" },
          shown.map((r, i) => h("li", { key: r.id, className: r.on ? "" : "is-off", "data-row": r.id },
            h(Form.Check, {
              type: "switch",
              id: `stashboard-row-${r.id}`,
              checked: r.on,
              onChange: () => toggle(r.id),
              label: Core.rowTitle(lang, r.id, env, null)
            }),
            h("span", { className: "stashboard-customise-source" }, sourceLabel(lang, r.id, env)),
            h("span", { className: "stashboard-customise-move" },
              h(Button, { variant: "secondary", size: "sm", disabled: i === 0, title: Core.t(lang, "action.up"), "aria-label": Core.t(lang, "action.up"), onClick: () => move(r.id, -1) }, "↑"),
              h(Button, { variant: "secondary", size: "sm", disabled: i === shown.length - 1, title: Core.t(lang, "action.down"), "aria-label": Core.t(lang, "action.down"), onClick: () => move(r.id, 1) }, "↓")))))),
      h("div", { className: "stashboard-notice" },
        h("p", null, "Copyright 2026 brewing8309 — ", h("a", { href: "https://github.com/brewing8309/stashboard", target: "_blank", rel: "noopener noreferrer" }, "github.com/brewing8309/stashboard")),
        h("p", null, h("strong", null, "This software is vibecoded."), " It was written end to end by an AI (Claude) from natural-language prompts. No human wrote or reviewed the code by hand. It ships with automated tests but no warranty."),
        h("p", null, "Licensed under the PolyForm Noncommercial License 1.0.0 — free to use and modify for any noncommercial purpose; selling it is not permitted.")),
      h(Modal.Footer, null,
        h(Button, { variant: "outline-secondary", className: "mr-auto me-auto", onClick: () => setRows(Core.defaultLayout(env)) }, Core.t(lang, "action.reset")),
        h(Button, { variant: "secondary", onClick: onClose }, Core.t(lang, "action.cancel")),
        h(Button, { variant: "primary", disabled: saving, onClick: save, className: "stashboard-save" }, Core.t(lang, "action.save"))));
  }

  /* ------------------------------------------------------------------ *
   * The dashboard                                                       *
   * ------------------------------------------------------------------ */

  const MIX_KEY = "stashboard:mix";

  function Dashboard({ onSettings }) {
    const [state, setState] = useState(null);
    const [failed, setFailed] = useState(null);
    const [mix, setMix] = useState(() => sessionNumber(MIX_KEY));
    const [refresh, setRefresh] = useState(0);
    const [customising, setCustomising] = useState(false);

    const reload = useCallback(() => {
      loadEnvironment().then((loaded) => {
        setState(loaded);
        onSettings(loaded.settings);
      }, (e) => {
        console.error(LOG, "Couldn't load Stashboard's settings:", e);
        setFailed(e);
      });
    }, []);
    useEffect(reload, []);

    if (failed) return null;
    if (!state) return h("div", { className: "stashboard stashboard-loading" });

    const { env, settings } = state;
    const lang = env.lang;
    const now = Date.now();
    const ctx = {
      day: Core.dayKey(new Date(now)),
      now,
      mix,
      refresh,
      count: settings.itemsPerRow,
      hideOwned: settings.hideOwned,
      cacheHours: settings.cacheHours
    };

    const newMix = () => {
      setMix(mix + 1);
      setSessionNumber(MIX_KEY, mix + 1);
    };
    const refreshAll = () => {
      Core.cacheClear(storage());
      setRefresh(refresh + 1);
    };
    const saveLayout = async (rows) => {
      await saveSettings(state.raw, { layout: Core.serializeLayout(rows) });
      setCustomising(false);
      reload();
    };

    const rows = Core.visibleRows(state.layout, env);
    return h("div", { className: "stashboard" },
      h("div", { className: "stashboard-toolbar" },
        h("span", { className: "stashboard-brand" }, "Stashboard"),
        h("span", { className: "stashboard-toolbar-actions" },
          h(Button, { variant: "secondary", size: "sm", onClick: newMix, className: "stashboard-mix" }, `🔀 ${Core.t(lang, "action.mix")}`),
          h(Button, { variant: "secondary", size: "sm", onClick: refreshAll, className: "stashboard-refresh" }, `⟳ ${Core.t(lang, "action.refresh")}`),
          h(Button, { variant: "secondary", size: "sm", onClick: () => setCustomising(true), className: "stashboard-customise-open" }, `⚙ ${Core.t(lang, "action.customise")}`))),
      rows.map((id) => h(Boundary, { key: `${id}|${mix}|${refresh}`, name: id },
        id === "spotlight" ? h(Spotlight, { env, ctx }) : h(Row, { id, env, ctx }))),
      customising ? h(Customise, { state, onClose: () => setCustomising(false), onSave: saveLayout }) : null);
  }

  // Stash's own front page, rendered as its own component so its hooks
  // live in their own fiber.
  function NativeFrontPage({ render, args }) {
    return render(...args);
  }

  // Shows Stash's own rows below the dashboard unless switched off. Until
  // the settings are in (and if Stashboard fails) they show.
  function FrontPage({ args, render }) {
    const [hideNative, setHideNative] = useState(false);
    const onSettings = useCallback((settings) => setHideNative(settings.hideNativeRows), []);
    return h("div", { className: "recommendations-container stashboard-front" },
      h(Boundary, { name: "dashboard", fallback: null }, h(Dashboard, { onSettings })),
      hideNative ? null : h("div", { className: "stashboard-native" }, h(NativeFrontPage, { render, args })));
  }

  Api.patch.instead("FrontPage", function (...args) {
    const render = args[args.length - 1];
    const own = args.slice(0, -1);
    return h(Boundary, { name: "front page", fallback: h(NativeFrontPage, { render, args: own }) },
      h(FrontPage, { args: own, render }));
  });
})();
