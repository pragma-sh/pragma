#!/bin/sh
set -eu

agent models 2>/dev/null | python3 -c '
import json
import re
import sys

LEVELS = {
    "none": "None",
    "low": "Low",
    "medium": "Medium",
    "high": "High",
    "xhigh": "Extra High",
    "extra-high": "Extra High",
    "max": "Max",
}
LEVEL_ORDER = ["none", "low", "medium", "high", "xhigh", "extra-high", "max"]

def clean_name_and_reasoning(name):
    reasoning = []
    cleaned = name
    matches = list(re.finditer(r"[\[(]([^\])()]*(?:low|medium|high)[^\])()]*)[\])]\s*$", name, re.I))
    if matches:
        match = matches[-1]
        found = []
        for token in re.split(r"[,/| ]+", match.group(1).lower()):
            if token in LEVELS and token not in found:
                found.append(token)
        if found:
            reasoning = [{"id": item, "name": LEVELS[item]} for item in found]
            cleaned = name[:match.start()].strip(" -–—")
    return cleaned or name, reasoning

def split_model_id(model_id):
    fast = model_id.endswith("-fast")
    without_fast = model_id[:-5] if fast else model_id
    for effort in sorted(LEVEL_ORDER, key=len, reverse=True):
        suffix = f"-{effort}"
        if without_fast.endswith(suffix):
            base = without_fast[: -len(suffix)]
            return (f"{base}-fast" if fast else base), effort
    return model_id, None

def clean_name(name, effort):
    fast = " Fast" if name.endswith(" Fast") else ""
    if fast:
        name = name[:-5]
    if effort:
        effort_name = LEVELS[effort]
        patterns = [
            rf"\s+{re.escape(effort_name)}(?=\s+Thinking(?:\s+\([^)]*\))?$)",
            rf"\s+{re.escape(effort_name)}(?=(?:\s+\([^)]*\))?$)",
        ]
        for pattern in patterns:
            next_name = re.sub(pattern, "", name, flags=re.I).strip()
            if next_name != name:
                name = next_name
                break
    return f"{name}{fast}".strip()

items_by_id = {}
order = []
for raw in sys.stdin:
    line = raw.strip()
    if " - " not in line:
        continue
    model_id, name = line.split(" - ", 1)
    model_id = model_id.strip()
    name = name.strip()
    if model_id == "auto" or not model_id or not name or re.search(r"\s", model_id):
        continue
    base_id, effort = split_model_id(model_id)
    name, explicit_reasoning = clean_name_and_reasoning(name)
    name = clean_name(name, effort)
    if base_id not in items_by_id:
        items_by_id[base_id] = {"id": base_id, "name": name, "reasoning": []}
        order.append(base_id)
    reasoning = explicit_reasoning or ([{"id": effort, "name": LEVELS[effort]}] if effort else [])
    for entry in reasoning:
        if all(existing["id"] != entry["id"] for existing in items_by_id[base_id]["reasoning"]):
            items_by_id[base_id]["reasoning"].append(entry)

items = []
for model_id in order:
    item = items_by_id[model_id]
    if not item["reasoning"]:
        item.pop("reasoning")
    items.append(item)

print(json.dumps(items, separators=(",", ":")))
'
