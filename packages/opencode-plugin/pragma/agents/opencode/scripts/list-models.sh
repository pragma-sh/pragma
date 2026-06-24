#!/bin/sh
set -eu

output=""
if output=$(opencode models --json 2>/dev/null); then
  printf '%s\n' "$output"
elif output=$(opencode models --verbose 2>/dev/null); then
  printf '%s\n' "$output"
else
  opencode models 2>/dev/null
fi | python3 -c '
import json
import re
import sys

ansi = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
text = ansi.sub("", sys.stdin.read())

def walk(value):
    if isinstance(value, dict):
        model_id = value.get("id") or value.get("model")
        name = value.get("name") or value.get("displayName") or value.get("label") or model_id
        provider = value.get("provider") or value.get("providerID") or value.get("providerId")
        has_model_shape = (
            isinstance(model_id, str)
            and isinstance(name, str)
            and (provider is not None or value.get("cost") is not None or value.get("limits") is not None or value.get("modalities") is not None)
        )
        if has_model_shape:
            yield {"id": model_id, "name": name, "provider": provider}
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)

def text_items():
    for raw in text.splitlines():
        line = raw.strip(" │\t")
        lowered = line.lower()
        if not line or lowered.startswith(("model", "provider", "tip", "usage")):
            continue
        if set(line) <= set("─━│┃┌┐└┘├┤┬┴┼-+"):
            continue
        if " - " in line:
            model_id, name = line.split(" - ", 1)
        else:
            parts = line.split()
            if "/" not in parts[0]:
                continue
            model_id = parts[0]
            name = " ".join(parts[1:]) if len(parts) > 1 else display_name(model_id)
        model_id = model_id.strip()
        name = name.strip()
        if model_id and name and not re.search(r"\s", model_id):
            yield {"id": model_id, "name": name}

def display_name(model_id):
    _, _, model = model_id.partition("/")
    words = model.replace("-", " ").replace("_", " ").split()
    name = " ".join(word.upper() if word in {"gpt", "glm"} else word.capitalize() for word in words)
    return name or model_id

def with_provider(model_id, name, provider=None):
    if not provider and "/" in model_id:
        provider = model_id.split("/", 1)[0]
    provider = (provider or "").strip()
    if not provider or name.endswith(f"({provider})"):
        return name
    return f"{name} ({provider})"

try:
    parsed = json.loads(text)
    candidates = walk(parsed)
except Exception:
    candidates = text_items()

items = []
seen = set()
for item in candidates:
    model_id = item["id"].strip()
    name = item["name"].strip()
    if not model_id or not name or model_id in seen:
        continue
    seen.add(model_id)
    items.append({"id": model_id, "name": with_provider(model_id, name, item.get("provider"))})

print(json.dumps(items, separators=(",", ":")))
'
