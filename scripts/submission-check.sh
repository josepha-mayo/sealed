#!/usr/bin/env bash
# Pre-flight check for the Colosseum submission package.
# Validates docs/submission-fields.md against the form's constraints and
# confirms every artifact referenced by the docs exists on disk.
# Usage: scripts/submission-check.sh   (exit 0 = ready to paste)
set -uo pipefail
cd "$(dirname "$0")/.."
F=docs/submission-fields.md
fail=0

python3 - <<'PY' || fail=1
import re, sys
LIMIT = 1200
txt = open("docs/submission-fields.md").read()
parts = re.split(r"^## ", txt, flags=re.M)[1:]
required = {"shortDescription","problemStatement","technicalApproach",
            "solanaIntegration","tractionMilestones","targetAudience",
            "businessModel","competitiveLandscape","futureVision",
            "teamBackground","demoVideo"}
seen = {}
for p in parts:
    name = p.split("\n")[0].split(" (")[0].split(" /")[0].strip()
    seen[name] = p.split("\n",1)[1].strip() if "\n" in p else ""
missing = required - set(seen)
if missing:
    print("MISSING FIELDS:", sorted(missing)); sys.exit(1)
ok = True
for name, body in seen.items():
    over = len(body) > LIMIT
    todo = bool(re.search(r"\[(?:fill|todo|your|insert)[^\]]*\]", body, re.I)) and name != "teamBackground"
    print(f"{name:24} {len(body):5} chars" + ("  ** OVER LIMIT **" if over else "") + ("  ** STRAY PLACEHOLDER **" if todo else ""))
    ok &= not over and not todo
sys.exit(0 if ok else 1)
PY

echo "--- artifact links resolve?"
for f in docs/demo.mp4 docs/demo.cast docs/demo.gif docs/dark.cast docs/dark.gif \
         docs/unseen.cast docs/unseen.gif docs/evidence/dark-run.txt \
         docs/evidence/snapshot.json web/snapshot.json web/index.html \
         docs/threat-model.md docs/judges.md docs/deck.md docs/mainnet.md \
         SECURITY.md .github/workflows/pages.yml; do
  [ -f "$f" ] && echo "ok  $f" || { echo "MISSING  $f"; fail=1; }
done

echo "--- forbidden claims"
grep -rniE "devnet (flow|pipeline|callback).*(work|land|succeed|live)" docs/ README.md | grep -v "outage\|not submitting\|stall\|honest" && fail=1 || echo "ok  no devnet overclaims"

[ "$fail" = 0 ] && echo "=== READY ===" || echo "=== FIX THE ABOVE ==="
exit "$fail"
