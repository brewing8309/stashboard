"""Stash Curator test double: reads Stash's raw plugin input from stdin and
answers the operations Stashboard uses the way Curator's core does
({"output": ...}). What Discover changes (📌, ✕, the catalogue being built)
is kept in state.json next to this file."""
import json
import os
import sys

STATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "state.json")
IMAGES = "https://img.stashboard.test"

LANES = {
    "for_you": ["30", "29", "28", "5", "11"],
    "best_bets": ["7", "2"],
    "revisit": ["4", "8"],
}


def box_scene(title, n=0, **extra):
    scene = {"title": title, "release_date": "2026-10-%02d" % (1 + n % 28), "duration": 1800 + n * 30,
             "studio": {"id": "st", "name": "Hunt Studio"},
             "tags": [{"id": "tg", "name": "Outdoor"}],
             "images": [{"url": "%s/%s.svg" % (IMAGES, title.replace(" ", "-")), "width": 1280, "height": 720}],
             "performers": [{"performer": {"id": "sdb-perf-mary", "name": "Mary Major", "gender": "FEMALE"}}]}
    scene.update(extra)
    return scene


# Performer Hunt for Mary: scored, newest first like Curator; h3 is "already
# local" by pHash. Anyone else: nothing (Stashboard then asks StashDB).
HUNTS = {
    "sdb-perf-mary": [
        {"id": "h1", "score": 0.3, "payload": box_scene("Hunt One")},
        {"id": "h2", "score": 0.8, "payload": box_scene("Hunt Two")},
        {"id": "h3", "score": 0.9, "payload": box_scene("Hunt Three", curator_local_match={"type": "phash"})},
    ],
    "fp1": [{"id": "fh%d" % i, "score": 1 - i / 10, "payload": box_scene("Face Hunt %d" % i, i)} for i in range(1, 4)],
    "sdb-perf-jane": [{"id": "jh%d" % i, "score": 1 - i / 10, "payload": box_scene("Jane Hunt %d" % i, i)} for i in range(1, 6)],
}

# Expand's catalogue: 200 matches, best first. x3 Curator matched locally,
# sdb-scene-2 is in the library by its StashDB id (Stashboard hides it).
MATCHES = [{"id": "x%d" % i, "score": round(1 - i / 100, 2),
            "payload": box_scene("Match %02d" % i, i, why=["Studio you like", "Performers you like"])} for i in range(1, 201)]
MATCHES[2]["payload"]["curator_local_match"] = {"type": "phash"}
MATCHES.insert(1, {"id": "sdb-scene-2", "score": 0.99, "payload": box_scene("Owned Already", 2)})
FRESH = [{"id": "fr%d" % i, "score": 0.5, "payload": box_scene("Fresh %d" % i, 27 - i, why=["New from Hunt Studio"])} for i in range(1, 9)]
FACES = [{"id": "fp%d" % i, "score": 0.9, "payload": {"name": "Face %d" % i, "why": ["Similar to Jane Doe in hair colour"],
          "images": [{"url": "%s/face-%d.svg" % (IMAGES, i), "width": 400, "height": 600}]}} for i in range(1, 9)]
CATALOGUE = {item["id"]: item for item in MATCHES + FRESH}


def load_state():
    try:
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"ready": True, "dismissed": [], "shortlist": []}


def save_state(state):
    with open(STATE, "w", encoding="utf-8") as f:
        json.dump(state, f)


def page_of(items, args):
    page, count = int(args.get("page") or 1), int(args.get("count") or 20)
    return items[(page - 1) * count: page * count]


def answer(args):
    operation = args.get("operation")
    state = load_state()
    if operation == "get_slate":
        ids = LANES.get(args.get("lane"), [])[: int(args.get("count") or 20)]
        return {"lane": args.get("lane"), "items": [{"scene_id": i} for i in ids], "has_more": False}
    if operation == "get_performer_hunt":
        items = HUNTS.get(args.get("performer_id"), [])
        return {"ready": True, "performer_id": args.get("performer_id"), "items": items, "total": len(items)}
    if operation == "get_expand":
        if not state["ready"]:
            return {"ready": False, "initializing": True, "items": [], "total": 0}
        if args.get("entity_type") == "performer":
            items = FACES
        else:
            items = FRESH if args.get("sort") == "newest" else MATCHES
            items = [dict(i, shortlisted=i["id"] in state["shortlist"]) for i in items if i["id"] not in state["dismissed"]]
        return {"ready": True, "items": page_of(items, args), "total": len(items)}
    if operation == "refresh_expand":
        state["ready"] = True
        save_state(state)
        return {"started": True}
    if operation == "get_similar":
        return {"entity_type": "scene", "items": [{"entity_id": i, "similarity": 0.8} for i in ["9", "10", "13"]]}
    if operation == "get_external_similar":
        items = [MATCHES[5], MATCHES[6], {"id": "sdb-scene-4", "score": 0.9, "payload": box_scene("Owned Similar")}]
        return {"ready": True, "items": [i for i in items if i["id"] not in state["dismissed"]]}
    if operation == "get_stashdb_performer_search":
        return {"items": [{"id": "fp1", "name": "Searched Star", "disambiguation": "", "scene_count": 42, "images": []}]}
    if operation == "get_shortlist":
        items = [dict(CATALOGUE[i], shortlisted=True, entity_type="scene") for i in reversed(state["shortlist"]) if i in CATALOGUE]
        return {"items": items, "total": len(items)}
    if operation == "update_shortlist":
        sid = args.get("external_id")
        if sid not in CATALOGUE:
            raise ValueError("external entity is not in the current Expand cache")
        state["shortlist"] = [i for i in state["shortlist"] if i != sid] + ([sid] if args.get("selected") else [])
        save_state(state)
        return {"shortlisted": bool(args.get("selected"))}
    if operation == "update_external_dismissal":
        state["dismissed"].append(args.get("external_id"))
        save_state(state)
        return {"external_id": args.get("external_id"), "kind": args.get("kind")}
    raise ValueError("unsupported operation in test double: %s" % operation)


payload = json.load(sys.stdin)
try:
    print(json.dumps({"output": answer(payload.get("args") or {})}))
except ValueError as error:
    print(json.dumps({"error": str(error)}))
