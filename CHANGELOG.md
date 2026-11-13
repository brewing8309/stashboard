# Changelog

## 3.1.0 — 2026-11-13

### Added

- **🧭 Discover is a tab of its own**, with its own address (`/?stashboard=discover`). The start
  page ends with a window into it. New in Discover, from Curator's Find: **Find of the day**,
  **New faces**, **Made for you on StashDB**, **More like …** (Similar, in your library and on
  StashDB), **Just released**, **Performer Hunt** (your performers or anyone found on StashDB) and
  **Your shortlist**. **📌** keeps a scene on the shortlist, **✕** says not interested; **🎲**
  shows others, **🎲 Shuffle Discover** has every module draw again. While Curator still builds its
  StashDB catalogue, Discover says so and can start that.
- **Your performers**: clicking one with unwatched scenes opens them right below the faces.
- Hovered a moment, scene pictures and the spotlight pop out a little bigger while the preview
  plays.

### Changed

- **Curator: your top 5 today** has livelier numbers: gold, silver, bronze, and a crown for #1.
- Discover can't be folded away any more; it's a tab now.

### Fixed

- Stash's own front page rows no longer flash up before the dashboard has loaded.

## 3.0.0 — 2026-11-13

### Changed

- **Stash Curator comes with Stashboard.** Curator (from the fork
  [brewing8309/stash-curator](https://github.com/brewing8309/stash-curator), unchanged, see
  [CURATOR.md](CURATOR.md)) runs inside Stashboard: its backend, tasks, hooks, settings and pages.
  The separate Stash Curator plugin isn't needed any more; uninstall it after the first start —
  the dashboard reminds you while both are on. Stashboard takes over its data (model, history,
  answers) and settings once.
- **License: AGPL-3.0-only** (was PolyForm Noncommercial 1.0.0), as Curator's license requires for
  the combined plugin. The Required Notices stay, now as additional terms under section 7(b).
  Releases up to 2.0.0 stay available under PolyForm Noncommercial.
- Each module has its own colour and symbol, so they tell apart at a glance.
- **Curator: your top 5 today** shows the pictures in their own 16:9: number one big, the next four
  beside it.
- **Discover** keeps more in reserve: **More** shows up to 20 trending scenes, 16 per StashDB
  module and 12 scenes on a radar profile.
- **Surprise me** has no 🎲 any more (its picture is blurred anyway); New mix draws a new one.
- The browser tab reads **Stashboard | Stash** on the dashboard (Stash's front page sets no title
  of its own).

### Changes for setups

- Stash needs Python for Stashboard now (Curator's backend starts through it). The package is
  bigger (about 25 MB): Curator's backend for Linux, macOS and Windows.

## 2.0.0 — 2026-11-13

### Changed

- **A new front page: modules instead of rows.** Inspired by streaming apps, the dashboard is now a
  grid of modules that each show a handful of scenes, several side by side, instead of rows of a
  dozen cards across the whole width. Hovered pictures play their preview.
  - **Spotlight** with the scene's performers, tags and studio, and **↻ Another pick**.
  - **Up next** right next to it: the scenes you started with progress bar and minutes left, ✓ and
    ✕ as small buttons, then what's new in your library.
  - **Your performers**: favourites and radar performers as round faces with their unwatched count.
  - **Curator: your top 5 today** with big numbers, **Tag of the day** as a mosaic with chips to
    switch tags, **Studio spotlight** with logo and counts, **Watched … days ago** as a single
    question, and **Surprise me**: one random scene you haven't started, revealed on ▶ Go.
  - In Discover: **📡 On your radar** as a profile with portrait, numbers and four scenes,
    **Trending on StashDB** as a top-five chart, and **New from your StashDB favourites** as four
    cards.
- Off by default now, and still there in Customise: Recently added, Unwatched with your favourites,
  Top rated, Curator's other lanes, New on StashDB with your performers, New on StashDB.
- The layout is stored under a new name (`modules`), so the row layout of 1.x isn't carried over:
  everyone starts from the new default.

### Removed

- The setting **Scenes per row**: each module shows as many scenes as fit its design.

## 1.3.0 — 2026-11-13

### Added

- **🧭 Discover.** The front page now has two parts: what's in your library on top (the spotlight,
  your rows, Curator), and below it, in its own colour, everything that isn't (yet): the StashDB
  rows and **More from …**. Scenes you don't have carry a **StashDB** label; **▴ Hide** folds
  Discover away and that's remembered. Customise groups the rows the same way.
- **Watched from 80%.** Stash only forgets where you stopped once you're past 98%, so scenes you
  stopped during the last minutes stayed in "Continue watching". Scenes stopped past 80% (new
  setting **Watched from (%)**, 0 turns it off) now leave the row and count as watched: Stashboard
  resets their resume time and records a play unless Stash already counted one.
- **✕ Remove in Continue watching**, next to ✓ Watched: for scenes you started but don't want to
  finish. It deletes that unfinished viewing from the scene's history (the play Stash recorded when
  playback started, and where you stopped), so the scene leaves the row and is back to unwatched
  if that was its only play.

### Changed

- **More from … shows one performer from your radar**, picked at random each time the page loads
  and never the same one twice in a row, instead of up to four rows. With their portrait, and
  **🎲 Someone else** to pick another; a divider marks where the scenes you don't have begin.
  Favourite or take one off the radar and the next one takes their place.
- New default order: library and Curator rows first, then Discover. A saved layout keeps its
  order within each part.

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
