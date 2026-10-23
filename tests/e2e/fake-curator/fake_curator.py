"""Stash Curator test double: reads Stash's raw plugin input from stdin and
answers get_slate the way Curator's core does ({"output": {"items": [...]}})."""
import json
import sys

LANES = {
    "for_you": ["30", "29", "28", "5", "11"],
    "best_bets": ["7", "2"],
    "revisit": ["4", "8"],
}

payload = json.load(sys.stdin)
args = payload.get("args") or {}
if args.get("operation") != "get_slate":
    print(json.dumps({"error": "unsupported operation in test double"}))
    sys.exit(0)
ids = LANES.get(args.get("lane"), [])[: int(args.get("count") or 20)]
print(json.dumps({"output": {"lane": args.get("lane"), "items": [{"scene_id": i} for i in ids], "has_more": False}}))
