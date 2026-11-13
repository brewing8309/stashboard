#!/bin/sh
# Takes over the latest Stash Curator from the fork into curator/ (a git
# subtree; nothing in there is changed by hand). Optional: Stashboard works
# with whichever Curator it has. Afterwards:
#   node scripts/curator.js check   — do the patches still apply, is curator-core current?
#   if not current: run the "Curator core" workflow on the branch (Actions tab),
#   or locally with Go: node scripts/curator.js build-core --upload
set -e
cd "$(dirname "$0")/.."
git subtree pull --prefix=curator "${CURATOR_REPO:-https://github.com/brewing8309/stash-curator.git}" "${1:-main}" --squash \
  -m "Take over Stash Curator ${1:-main} into curator/"
node scripts/curator.js check || true
