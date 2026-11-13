#!/usr/bin/env python3
"""Stashboard's backend entry point: Curator's, plus one look for old data.

Stash runs this for every operation, task and hook (see the merged
stashboard.yml). Once per install it looks for the data of a separately
installed Stash Curator plugin and copies it into Stashboard's own data
directory, so the model, history and answers carry over. Then it hands
over to Curator's own launcher (launcher.py, shipped unchanged), which
execs the curator-core binary for this platform.

Like Curator's launcher it runs with `-S` and imports only os and sys on
the common path: a marker file ends the search after the first run.
"""

import os
import sys

PLUGIN_DIR = os.path.realpath(sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(__file__))
DATA = os.path.join(PLUGIN_DIR, "data")
MARKER = os.path.join(DATA, ".stashboard-curator-migration")
DATABASE = "curator.sqlite3"
OLD_MANIFEST = "stash-curator.yml"


def _old_curator_data():
    """The data directory of an installed Stash Curator: a directory next to
    Stashboard's (or one level further up, under another plugin source)
    that holds stash-curator.yml and data/curator.sqlite3."""
    here = os.path.dirname(PLUGIN_DIR)
    for root in (here, os.path.dirname(here)):
        try:
            entries = sorted(os.listdir(root))
        except OSError:
            continue
        for name in entries:
            for candidate in (os.path.join(root, name), *(os.path.join(root, name, sub) for sub in _subdirs(os.path.join(root, name)))):
                if os.path.realpath(candidate) == PLUGIN_DIR:
                    continue
                data = os.path.join(candidate, "data")
                if os.path.isfile(os.path.join(candidate, OLD_MANIFEST)) and os.path.isfile(os.path.join(data, DATABASE)):
                    return data
    return None


def _subdirs(path):
    try:
        return [name for name in sorted(os.listdir(path)) if os.path.isdir(os.path.join(path, name))]
    except OSError:
        return []


def migrate():
    """Copy an old Curator's data once, if Stashboard has none of its own.
    Copies, never moves: the old plugin keeps working until it's removed."""
    if os.path.exists(MARKER):
        return
    note = "nothing to take over"
    if not os.path.exists(os.path.join(DATA, DATABASE)):
        source = _old_curator_data()
        if source:
            import shutil

            shutil.copytree(source, DATA, dirs_exist_ok=True)
            note = f"copied from {source}"
    os.makedirs(DATA, exist_ok=True)
    with open(MARKER, "w", encoding="utf-8") as marker:
        marker.write(note + "\n")
    if note != "nothing to take over":
        sys.stderr.write(f"stashboard: Curator data {note}\n")


def main():
    try:
        migrate()
    except OSError as error:
        # Never block Curator over this; it starts with its own data then.
        sys.stderr.write(f"stashboard: couldn't take over old Curator data: {error}\n")
    sys.path.insert(0, PLUGIN_DIR)
    import launcher

    launcher.main()


if __name__ == "__main__":
    main()
