# Stash Curator inside Stashboard

Stashboard includes [**Stash Curator**](https://github.com/mrx-31415/stash-curator) — local
recommendations learned from your library and plays, and stash-box discovery — by its authors,
under the AGPL-3.0-only. It comes from the fork
[brewing8309/stash-curator](https://github.com/brewing8309/stash-curator) and lives, unchanged,
in [`curator/`](curator/). Stashboard uses Curator's backend for its Curator modules (the
spotlight's best bet, the top 5, Best bets, Revisit, …, the radar's Performer Hunt) and ships
Curator's own pages and settings as they are, for now; they'll move into Stashboard's own UI
step by step.

There's no separate Curator plugin to install any more. If one is installed, Stashboard says
so on the front page: uninstall it, or Curator runs twice.

## What Stashboard changes

Nothing in `curator/` is edited by hand. Everything Stashboard does differently is outside it:

| Where | What |
|---|---|
| [`curator-adapter/patches.json`](curator-adapter/patches.json) | The seven places that name Curator's plugin id, `stash-curator` → `stashboard`: in Curator's UI (operations, tasks, settings) and its Go backend (settings). Applied at build time to copies. Each patch says how often its text must occur, so an update that moves one fails the build instead of shipping a half-renamed Curator. Curator's page stays at `/plugins/stash-curator`. |
| [`curator-adapter/stashboard-launcher.py`](curator-adapter/stashboard-launcher.py) | Stashboard's backend entry point. On its first run it copies an installed Stash Curator's data directory (model, history, answers) into Stashboard's, if Stashboard has none yet, then runs Curator's own `launcher.py`. |
| [`scripts/curator.js`](scripts/curator.js) | Merges Curator's manifest (backend, settings, tasks, hooks, UI files) into Stashboard's, lists Curator's files for the package, and builds curator-core. |
| [`curator-adapter/core.lock.json`](curator-adapter/core.lock.json) | The curator-core binaries (Go, five platforms) built from the patched `curator/`, kept as assets of a `curator-core-…` release, deflated, with their checksums. Stashboard's package takes them as they are, so it stays byte for byte reproducible. |
| `plugin/stashboard.js` | Talks to Curator's backend under Stashboard's own plugin id, and once takes over the separate Curator plugin's settings. |

## Taking over an update from Curator

Optional: Stashboard works with the Curator it has.

```sh
scripts/update-curator.sh            # git subtree pull of the fork's main into curator/
node scripts/curator.js check        # do the patches still apply? is curator-core current?
```

- If `check` names a patch that no longer fits, look at what Curator changed there and adjust
  `curator-adapter/patches.json`.
- If only curator-core is out of date (Curator changed `curator/core/`), run the **Curator core**
  workflow on the branch (Actions → Curator core → Run workflow). It builds the binaries, attaches
  them to a new `curator-core-…` release and commits the new `core.lock.json`. Locally, with Go
  and Python 3.11+: `node scripts/curator.js build-core --upload`.
- Then the usual: tests, a Stashboard release.

To take over from upstream instead of the fork: `CURATOR_REPO=https://github.com/mrx-31415/stash-curator.git scripts/update-curator.sh`.
