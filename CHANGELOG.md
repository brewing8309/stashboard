# Changelog

## 1.2.0 — 2026-10-27

### Added

- **📡 On your radar.** For performers who caught your eye but aren't a favourite (yet): 📡 on
  their performer card (on a scene's page, in the performer lists) or **📡 Radar** on their
  performer page. The front page then gets a **More from …** row for them: their unwatched scenes
  in your library, then their most popular StashDB scenes you don't have (ranked by Curator's
  Performer Hunt when Curator is installed), with **⬇ Download** through stasharr. After 30 days
  (setting **Radar decision after**) or three of their scenes watched, the row asks: **★
  Favourite** or **✕ Off the radar**. Radar performers also follow right after favourites in
  "New on StashDB with your performers". Stored as the performer custom field `radar` (the day
  it was set), which stasharr 1.7 can set from StashDB too.
- **✓ Watched in Continue watching.** A button under each card marks the scene as watched: Stash
  forgets where you stopped (the same as **Reset resume time** in the scene's History tab) and
  records a play, so it leaves the row and counts as seen. Stash does this by itself when you
  watch at least 98% of a scene; the button is for the ones you're done with earlier.

## 1.1.0 — 2026-10-23

### Added

- **⬇ Download on StashDB tiles.** With [stasharr](https://github.com/brewing8309/stasharr) 1.6
  or newer in the browser, every StashDB scene you don't have yet gets a Download button: it opens
  the scene on StashDB with stasharr's Prowlarr search already running, and you pick the release
  there. The button only shows where stasharr has marked the Stash page, so without stasharr
  nothing changes.

## 1.0.0 — 2026-10-23

The first release: a dashboard for Stash's front page.

### Added

- **Rows from your library:** Continue watching, Recently added, Unwatched with your favourites,
  Tag of the day, Studio spotlight, Not watched in a while, Top rated and Random picks — with
  Stash's own scene cards. "Random" rows are random per day; **🔀 New mix** draws again.
- **Spotlight:** one big pick at the top, with **▶ Play**.
- **StashDB rows:** New from your StashDB favourites, Trending on StashDB, New on StashDB with
  your performers, and New on StashDB. Scenes you already have are marked **✓ In your library**
  and open your copy. Uses the StashDB stash-box set up in Stash; FansDB, PMV Stash and JAV Stash
  work too.
- **Curator rows:** with Stash Curator installed, its lanes (For you, Best bets, Revisit, …) as
  rows, and its best bet in the Spotlight.
- **Customise:** switch rows on and off and reorder them; saved in Stash for every browser.
- **Settings:** hide Stash's own front page rows, hide owned StashDB scenes, don't contact
  stash-boxes at all, scenes per row, and how long StashDB rows are cached.
- English and German, following Stash's interface language.
- Installs from its own plugin source; tested end to end against Stash 0.31.1 and the current
  development build.
