"""Stash Curator test double: reads Stash's raw plugin input from stdin and
answers get_slate the way Curator's core does ({"output": {"items": [...]}})."""
import json
import sys

LANES = {
    "for_you": ["30", "29", "28", "5", "11"],
    "best_bets": ["7", "2"],
    "revisit": ["4", "8"],
}


def hunt_scene(title, **extra):
    scene = {"title": title, "release_date": "2026-10-01", "duration": 1800,
             "studio": {"id": "st", "name": "Hunt Studio"},
             "images": [{"url": "https://img.stashboard.test/%s.svg" % title, "width": 1280, "height": 720}],
             "performers": [{"performer": {"id": "sdb-perf-mary", "name": "Mary Major", "gender": "FEMALE"}}]}
    scene.update(extra)
    return scene


# Performer Hunt for Mary: scored, newest first like Curator; h3 is "already
# local" by pHash. Anyone else: nothing (Stashboard then asks StashDB).
HUNTS = {
    "sdb-perf-mary": [
        {"id": "h1", "score": 0.3, "payload": hunt_scene("Hunt One")},
        {"id": "h2", "score": 0.8, "payload": hunt_scene("Hunt Two")},
        {"id": "h3", "score": 0.9, "payload": hunt_scene("Hunt Three", curator_local_match={"type": "phash"})},
    ],
}

payload = json.load(sys.stdin)
args = payload.get("args") or {}
operation = args.get("operation")
if operation == "get_slate":
    ids = LANES.get(args.get("lane"), [])[: int(args.get("count") or 20)]
    print(json.dumps({"output": {"lane": args.get("lane"), "items": [{"scene_id": i} for i in ids], "has_more": False}}))
elif operation == "get_performer_hunt":
    items = HUNTS.get(args.get("performer_id"), [])
    print(json.dumps({"output": {"ready": True, "performer_id": args.get("performer_id"), "items": items, "total": len(items)}}))
else:
    print(json.dumps({"error": "unsupported operation in test double"}))
