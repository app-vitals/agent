---
name: investigate-cron
description: >
  Diagnose why a cron run behaved unexpectedly. Looks up the exact run via the
  admin cron-runs API (by cron name and approximate time, or by the work item id
  it was dispatched against), finds the matching Claude Code session transcript
  using the run's sessionId, reads what the model did and why, cross-checks
  Sentry when configured, and explains it in plain language. Triggers on "why
  did the <name> cron do X", "investigate the cron run at <time>", or
  "investigate-cron". No log files needed; the transcript is the source of truth.
---

# investigate-cron

Diagnose a cron run either by cron name and approximate execution time, or by
the work item id it was dispatched against.

**Usage:**
- `/agent-platform:investigate-cron <name> <time>` - find the run of cron
  `<name>` closest to `<time>`
- `/agent-platform:investigate-cron --item <itemId> [--cron <name>]` - find every
  recorded dispatch for a work item id, optionally limited to one cron

Arguments:

- `<name>` - the cron's `name` as returned by `GET /agents/{id}/crons`
  (a stable key for system crons; user-created crons may have a null name, in
  which case match on `id` instead).
- `<time>` - approximate time the cron fired, e.g. `6pm`, `14:30`, `2:30pm PST`.
  Timezone defaults to Pacific if not specified.
- `--item <itemId>` - the opaque `itemId` the run was dispatched against (stored
  verbatim on the run record). No time argument is needed or used.

**Examples:**
- `/agent-platform:investigate-cron nightly-report 6pm`
- `/agent-platform:investigate-cron --item ABC-1.2`

## Environment

Every variable below is set by the agent platform runtime (see
`runtime/config.ts`) except the two Sentry ones, which are optional and supplied
by the operator as agent env vars:

| Variable | Use |
|----------|-----|
| `SHIPWRIGHT_API_URL` | Admin API base URL |
| `SHIPWRIGHT_AGENT_API_KEY` | Bearer token for the admin API |
| `SHIPWRIGHT_AGENT_ID` | This agent's id |
| `AGENT_HOME` | Agent home directory (used in the no-match diagnostics) |
| `SENTRY_ORG`, `SENTRY_AUTH_TOKEN` | Optional, Step 4 only |

---

## Step 0: Bind invocation arguments and pick a mode

```bash
# Set these from the user's invocation:
#   /agent-platform:investigate-cron <name> <time>
#   /agent-platform:investigate-cron --item <itemId> [--cron <name>]

if [ "$1" = "--item" ]; then
  MODE="item"
  ITEM_ARG="$2"        # opaque item id, e.g. "ABC-1.2"
  CRON_NAME="${4:-}"   # optional, only when "--cron <name>" follows
else
  MODE="name-time"
  CRON_NAME="$1"       # e.g. nightly-report
  TIME_ARG="$2"        # e.g. 6pm
fi
```

`--item` mode skips time parsing entirely (2a does not apply): the runs
endpoint returns every dispatch for that item directly.

Do not proceed to Step 1 until the mode and its variables are set.

---

## Step 1: Resolve the run via the admin cron-runs API

The admin API (`$SHIPWRIGHT_API_URL`, authenticated with
`Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY`, agent id
`$SHIPWRIGHT_AGENT_ID`) is the exact source for cron run history. It replaces
guessing from transcript file mtimes.

### 1a. List crons and resolve the cron to query

`GET /agents/{id}/crons` returns this agent's crons as a plain JSON array. Be
tolerant of a `{ "crons": [...] }` wrapper as well.

```bash
CRONS_JSON=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/crons" \
  | jq 'if type == "array" then . else .crons end')
```

A cron is either top-level (`parentCronId == null`) or a **phase** child of a
parent cron (`parentCronId == <parent id>`). Runs for a phase are recorded
against the **parent** cron and tagged with `phaseId = <phase cron id>`; runs
of a top-level cron with no phases are recorded against the cron itself.

```bash
# name-time mode: find the named cron (exact name, or id).
TARGET=$(echo "$CRONS_JSON" | jq -c --arg n "$CRON_NAME" \
  '[.[] | select(.name == $n or .id == $n)] | first // empty')

if [ -n "$TARGET" ]; then
  PARENT_ID=$(echo "$TARGET" | jq -r '.parentCronId // empty')
  if [ -n "$PARENT_ID" ]; then
    RUNS_CRON_ID="$PARENT_ID"                 # phase: runs live on the parent
    PHASE_ID=$(echo "$TARGET" | jq -r '.id')  # ...filtered by phaseId
  else
    RUNS_CRON_ID=$(echo "$TARGET" | jq -r '.id')
    PHASE_ID=""                               # no phase filter
  fi
  TARGET_CRON_ID=$(echo "$TARGET" | jq -r '.id')  # id the runtime tags dispatches with
  echo "runsCronId: $RUNS_CRON_ID phaseId: ${PHASE_ID:-<none>}"
else
  echo "No cron named \"$CRON_NAME\" found via the admin API - see the Fallback section."
fi
```

`phaseId` handling is optional: crons without a parent never need it, and the
`phaseId` query param is simply omitted.

In item mode, if `--cron <name>` was given resolve it exactly as above;
otherwise query every top-level cron (`parentCronId == null`) in turn:

```bash
ITEM_CRON_IDS=$(echo "$CRONS_JSON" | jq -r '.[] | select(.parentCronId == null) | .id')
```

### 1b. List runs, filtered server-side

`GET /agents/{id}/crons/{cronId}/runs` returns `{ items, total, limit, offset }`
(newest `startedAt` first) and supports `limit`/`offset` plus server-side
`itemId` and `phaseId` query filters. Pass them as query params; do not
paginate the whole history and filter client-side.

**Name+time mode** - fetch runs (scoped to `phaseId` when the cron is a phase):

```bash
FILTER=""
[ -n "$PHASE_ID" ] && FILTER="phaseId=$PHASE_ID&"

RUNS_JSON=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/crons/$RUNS_CRON_ID/runs?${FILTER}limit=100")
RUNS_FILE=$(mktemp)
echo "$RUNS_JSON" | jq '.items' > "$RUNS_FILE"

TOTAL=$(echo "$RUNS_JSON" | jq -r '.total')
OFFSET=100
while [ "$OFFSET" -lt "$TOTAL" ]; do
  PAGE_JSON=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
    "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/crons/$RUNS_CRON_ID/runs?${FILTER}limit=100&offset=$OFFSET")
  NEW_FILE=$(mktemp)
  jq -s '.[0] + .[1]' "$RUNS_FILE" <(echo "$PAGE_JSON" | jq '.items') > "$NEW_FILE"
  mv "$NEW_FILE" "$RUNS_FILE"
  OFFSET=$((OFFSET + 100))
done
echo "Fetched $(jq 'length' "$RUNS_FILE") runs"
```

Then pick the run whose `startedAt` is closest to `TARGET_EPOCH` (computed in
2a). The API has no "closest to a timestamp" query, so this ranking is
client-side:

```bash
BEST_RUN=$(jq -r --argjson target "$TARGET_EPOCH" '
  map(. + {distance: ((((.startedAt | sub("\\.[0-9]+Z$"; "Z")) | fromdateiso8601) - $target) | if . < 0 then -. else . end)})
  | sort_by(.distance)
  | first
' "$RUNS_FILE")

if [ "$BEST_RUN" = "null" ] || [ -z "$BEST_RUN" ]; then
  echo "No runs found - fall back to the pre-admin-API path."
else
  RUN_STARTED_AT=$(echo "$BEST_RUN" | jq -r '.startedAt')
  ITEM_ARG=$(echo "$BEST_RUN" | jq -r '.itemId // empty')
  echo "Matched run: $(echo "$BEST_RUN" | jq -r '.id') startedAt=$RUN_STARTED_AT itemId=${ITEM_ARG:-<none>}"
fi
```

If the run has no `itemId` (not dispatched against a specific item), `ITEM_ARG`
stays empty; that is fine.

**Item mode** - the `itemId` filter is passed straight through to the server:

```bash
ITEM_RUNS="[]"
for CRON_ID in $ITEM_CRON_IDS; do
  PAGE=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
    --get --data-urlencode "itemId=$ITEM_ARG" --data-urlencode "limit=100" \
    "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/crons/$CRON_ID/runs" | jq '.items')
  ITEM_RUNS=$(jq -s '.[0] + .[1]' <(echo "$ITEM_RUNS") <(echo "$PAGE"))
done

# API order is startedAt desc; re-sort ascending for the dispatch narrative.
ITEM_RUNS=$(echo "$ITEM_RUNS" | jq 'sort_by(.startedAt)')
echo "Found $(echo "$ITEM_RUNS" | jq 'length') dispatch(es) for item \"$ITEM_ARG\":"
echo "$ITEM_RUNS" | jq -r '.[] | "  \(.startedAt)  phaseId=\(.phaseId)  outcome=\(.outcome)  skipped=\(.skipped)"'
```

If `total` exceeds the fetched `limit` for any cron, paginate with `offset`
the same way as name+time mode. If `ITEM_RUNS` is empty, no run was ever
recorded for that item; report that no dispatch history exists.

### 1c. From the resolved run to a transcript

Check the run's `sessionId` first. It is the exact Claude session id the run
recorded, not a guess:

```bash
SESSION_ID=$(echo "$BEST_RUN" | jq -r '.sessionId // empty')  # or per-entry in ITEM_RUNS
```

**If `sessionId` is non-null**, skip the mtime-window search and build the
transcript path directly from the transcript directory derived in 2b:

```bash
TRANSCRIPT_PATH="$TRANSCRIPT_DIR/$SESSION_ID.jsonl"
if [ -f "$TRANSCRIPT_PATH" ]; then
  echo "Transcript resolved directly via sessionId: $TRANSCRIPT_PATH"
else
  echo "Run has sessionId=$SESSION_ID but no file at $TRANSCRIPT_PATH - the transcript may have been pruned. Fall back to the mtime-window search (2b)."
fi
```

**If `sessionId` is null** (older run, or the CLI produced no stdout), use the
tight mtime-window search around the run's exact `startedAt` described in 2b.

---

## Step 2: Locate and extract the transcript

### 2a. Convert the time argument (name+time mode only)

Item mode has no time argument and skips this. Parse `<time>` to a Unix epoch in
the **Pacific timezone** (default). This produces `TARGET_EPOCH`, used in Step 1b.

```bash
TARGET_EPOCH=$(python3 -c "
import sys, re, zoneinfo
from datetime import datetime

time_arg = '${TIME_ARG}'
today = '$(date +%Y-%m-%d)'
tz = zoneinfo.ZoneInfo('America/Los_Angeles')
if 'EST' in time_arg or 'EDT' in time_arg:
    tz = zoneinfo.ZoneInfo('America/New_York')
elif 'UTC' in time_arg:
    tz = zoneinfo.ZoneInfo('UTC')
clean = re.sub(r'\s*(PST|PDT|EST|EDT|UTC)', '', time_arg).strip().upper()
for fmt in ['%I%p', '%I:%M%p', '%H:%M', '%H']:
    try:
        t = datetime.strptime(clean, fmt)
        dt = datetime(int(today[:4]), int(today[5:7]), int(today[8:]), t.hour, t.minute, tzinfo=tz)
        print(int(dt.timestamp()))
        break
    except ValueError:
        pass
else:
    sys.stderr.write(f'Could not parse time: {clean}\n'); sys.exit(1)
") || { echo "Error: could not parse time '${TIME_ARG}'"; exit 1; }
echo "Target epoch: $TARGET_EPOCH"
```

Steps 1b and 2a are interdependent in name+time mode: run 2a first, then 1b.

### 2b. Find matching sessions

Claude Code stores session transcripts at `~/.claude/projects/<encoded-cwd>/`.
The encoding rule: replace every `/` and `.` character with `-`.

```bash
CWD=$(pwd)
ENCODED=$(echo "$CWD" | tr '/.' '-')
TRANSCRIPT_DIR="$HOME/.claude/projects/$ENCODED"
echo "Transcript directory: $TRANSCRIPT_DIR"
ls "$TRANSCRIPT_DIR"/*.jsonl 2>/dev/null | head -20
```

Example: `/data/agent/home/workspace` encodes to `-data-agent-home-workspace`,
so transcripts live at `~/.claude/projects/-data-agent-home-workspace/`.

If the directory is missing or has no `.jsonl` files, this workspace has no
session history at this path; verify the CWD is the agent workspace root.

**When `sessionId` is null: mtime-window fallback.** Use a tight window
(about +/-5 minutes) around the run's exact `startedAt` against `.jsonl` file
mtimes. Convert `startedAt` (ISO 8601) to epoch seconds first (in item mode,
repeat per entry in `ITEM_RUNS`):

```bash
RUN_STARTED_EPOCH=$(date -d "$RUN_STARTED_AT" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%S" "${RUN_STARTED_AT%%.*}" +%s)
```

```bash
python3 -c "
import os, glob

transcript_dir = '$TRANSCRIPT_DIR'
run_started_epoch = $RUN_STARTED_EPOCH
window = 300  # 5 minutes

candidates = []
for path in glob.glob(os.path.join(transcript_dir, '*.jsonl')):
    mtime = os.path.getmtime(path)
    if abs(mtime - run_started_epoch) <= window:
        candidates.append((mtime, path))

candidates.sort()
for mtime, path in candidates:
    session_id = os.path.basename(path).replace('.jsonl', '')
    print(f'{session_id}  mtime={mtime}  path={path}')
"
```

One candidate is the transcript. With several, pick the one whose first entry
timestamp (not mtime) is closest to `run_started_epoch`. With none, the
transcript may have been pruned or the CWD differs from where the cron ran.

---

## Fallback: pre-admin-API history

If the admin API can't resolve the run (unreachable, no cron with that name,
no runs returned), fall back to a fuzzy approach: a +/-90 minute mtime window
plus `[Cron job:]` string-matching in the transcript's first user message. The
runtime tags every cron-dispatched message as `[Cron job: <jobId>]`. This only
applies to `name-time` mode; `--item` mode has no time to build a window from,
so report that no dispatch history was found rather than guessing.

```bash
WINDOW=5400  # 90 minutes in seconds
LOWER=$((TARGET_EPOCH - WINDOW))
UPPER=$((TARGET_EPOCH + WINDOW))

python3 -c "
import os, glob, json

transcript_dir = '$TRANSCRIPT_DIR'
lower = $LOWER
upper = $UPPER
cron_name = '$CRON_NAME'.lower()
# The runtime tags messages with the cron id, not its name, so match on the id
# when it resolved (TARGET_CRON_ID, empty if the admin API was unreachable) and
# on the lowercased name or the raw argument as a last resort.
needles = [n.lower() for n in ('$TARGET_CRON_ID', '$CRON_NAME') if n]

candidates = []
for path in glob.glob(os.path.join(transcript_dir, '*.jsonl')):
    mtime = os.path.getmtime(path)
    if lower <= mtime <= upper:
        candidates.append((mtime, path))

candidates.sort()
print(f'Found {len(candidates)} candidate files in +/-90min window')

matches = []
for mtime, path in candidates:
    with open(path) as f:
        for line in f:
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if entry.get('type') != 'user':
                continue
            content = entry.get('message', {}).get('content', '')
            if not isinstance(content, str):
                continue
            lowered = content.lower()
            if '[cron job:' in lowered and any(n in lowered for n in needles):
                session_id = os.path.basename(path).replace('.jsonl', '')
                matches.append({'path': path, 'mtime': mtime, 'session_id': session_id,
                                 'prompt_preview': content[:200]})
                break

print(f'Matching sessions for cron \"{cron_name}\": {len(matches)}')
for m in matches:
    print(f'  {m[\"session_id\"]}  Prompt: {m[\"prompt_preview\"]}')
"
```

If multiple match, pick the one closest to the target time. If none, skip to
the no-match handler at the end.

### 2c. Extract what happened

Parse the matching session JSONL to extract the narrative: initial prompt,
assistant text outputs, key Bash commands, and whether the session ended
silently.

```python
#!/usr/bin/env python3
import json, sys

path = sys.argv[1]  # path to the matching .jsonl file

initial_prompt = None
assistant_texts = []
bash_commands = []
ended_silently = False

with open(path) as f:
    for line in f:
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue

        role = entry.get('type')
        msg = entry.get('message', {})
        content = msg.get('content', '')

        if role == 'user' and isinstance(content, str) and initial_prompt is None:
            initial_prompt = content

        elif role == 'assistant' and isinstance(content, list):
            for block in content:
                btype = block.get('type')
                if btype == 'text':
                    text = block.get('text', '').strip()
                    if text:
                        if '[silent]' in text:
                            ended_silently = True
                        assistant_texts.append(text)
                elif btype == 'thinking':
                    pass  # skip thinking blocks
                elif btype == 'tool_use' and block.get('name') == 'Bash':
                    inp = block.get('input', {})
                    cmd = inp.get('command', '')
                    desc = inp.get('description', '')
                    if cmd:
                        bash_commands.append({'command': cmd[:300], 'description': desc})

print('=== INITIAL PROMPT ===')
print((initial_prompt or '')[:500])
print()
print(f'=== ASSISTANT OUTPUTS ({len(assistant_texts)} blocks) ===')
for i, t in enumerate(assistant_texts[:10], 1):
    print(f'[{i}] {t[:400]}')
    print()
print(f'=== BASH COMMANDS ({len(bash_commands)} total) ===')
for b in bash_commands[:20]:
    print(f'  # {b["description"]}')
    print(f'  {b["command"][:200]}')
    print()
print(f'=== SILENT: {ended_silently} ===')
```

In item mode, run this once per session matched to each entry in `ITEM_RUNS`;
the goal is a chronological narrative across every dispatch.

**Key signals to look for:**

- The **initial prompt** confirms which cron fired and its trigger context
- **Assistant text blocks** reveal the model's reasoning, decisions, and conclusions
- **Bash commands** show exactly what actions were taken
- **`[silent]`** in the final assistant message means the cron ran but had nothing
  to report; this is expected behavior (e.g. preCheck passed but nothing qualified)
- Missing or empty outputs may indicate the session was aborted or hit a context limit

---

## Step 3: Sentry cross-check

Cross-check the transcript's account against what Sentry recorded for the same
window. An unhandled exception or a smoking-gun `console.error` line often
explains unexpected cron behavior more directly than the transcript does.

### 3a. Preconditions

Confirm `SENTRY_ORG` and `SENTRY_AUTH_TOKEN` are both set
(`echo "org_set=$([ -n "$SENTRY_ORG" ] && echo yes || echo no)
token_set=$([ -n "$SENTRY_AUTH_TOKEN" ] && echo yes || echo no)"`). If either is
unset or empty, print:

```
investigate-cron's Sentry cross-check requires SENTRY_ORG and SENTRY_AUTH_TOKEN to be set in the environment. Skipping this step - continuing without Sentry data.
```

and skip straight to Step 4. **Never block the rest of the investigation** on
missing Sentry credentials. Never print, log, or persist the literal values of
`$SENTRY_AUTH_TOKEN` or `$SENTRY_ORG`; reference only the env var names.

Determine the run's window before calling either API: the run's `startedAt`
plus a margin (e.g. +/-30-60 minutes), or run-to-now for something still in
progress.

### 3b. Issues API - unresolved exceptions

```bash
ISSUES_JSON=$(curl -sS -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
  "https://sentry.io/api/0/organizations/$SENTRY_ORG/issues/?query=is:unresolved")
```

The endpoint takes no time-window param here, so scope the result **client-side**
by comparing each issue's `firstSeen`/`lastSeen` against the window:

```bash
echo "$ISSUES_JSON" | jq -r --arg lower "$WINDOW_LOWER_ISO" --arg upper "$WINDOW_UPPER_ISO" '
  .[] | select(.lastSeen >= $lower and .firstSeen <= $upper) |
  "\(.shortId)  \(.title)  firstSeen=\(.firstSeen)  lastSeen=\(.lastSeen)  \(.permalink)"
'
```

State explicitly in the output that window filtering happened client-side; a raw
`is:unresolved` result includes every unresolved issue org-wide.

### 3c. ourlogs - structured console output for the same window

The `ourlogs` dataset carries `console.log`/`console.warn`/`console.error`
output forwarded to Sentry as structured logs. Query it via the Events API:

```bash
curl -s -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
  --data-urlencode "dataset=ourlogs" \
  --data-urlencode "project=<numeric_project_id>" \
  --data-urlencode "field=timestamp" --data-urlencode "field=message" \
  --data-urlencode "query=<search text>" \
  --data-urlencode "start=<RUN_STARTED_AT minus margin>" \
  --data-urlencode "end=<RUN_STARTED_AT plus margin, or now>" \
  --data-urlencode "sort=-timestamp" --data-urlencode "per_page=100" \
  -G "https://sentry.io/api/0/organizations/$SENTRY_ORG/events/"
```

- `<search text>` should target the cron or item under investigation (cron
  name, item id) so results are not every log line in the window.
- `<numeric_project_id>` must be resolved first via
  `GET https://sentry.io/api/0/organizations/$SENTRY_ORG/projects/`; pick the
  project whose `slug` matches the service under investigation.
- `per_page=100` caps the page; if exactly 100 rows come back, narrow the query
  or page via the cursor rather than trusting one page as complete.

If Sentry surfaces a clear unhandled exception or smoking-gun log line inside
the window, note it plainly and cite it as `[verified: Sentry]` in Step 4.

---

## Step 4: Synthesize the explanation

Tag every claim with its evidence level:

- `[verified: <source>]` - directly observed in a primary record: the admin run
  record (`admin API`), the session transcript (`transcript`), or Sentry
  (`Sentry`). Quote or cite the specific field, line, or issue.
- `[inferred]` - your reasoning from the evidence, not observed directly. Say
  what it is inferred from. Never present an inference as verified.

Cover:

1. **Cron name** - which cron was investigated; in item mode, every cron that
   dispatched against the item
2. **Time** - when it fired (the run's `startedAt`, or the JSONL mtime/first
   entry timestamp on the fallback path)
3. **Session ID** - the run's `sessionId` when available, else the JSONL
   filename matched via the mtime window
4. **What it did** - summarize the Bash commands and assistant reasoning in 2-5 sentences
5. **Conclusion** - what the cron decided and why (completed, skipped, silenced, errored)
6. **Why (if unexpected)** - the root cause if the behavior was surprising

**Output format (name+time mode):**

```
Cron: <name>
Time: <time> Pacific (session: <session-id>)

What happened:
<2-5 sentence narrative, each claim tagged [verified: ...] or [inferred]>

Conclusion:
<What the cron ultimately decided, and why>

Why (if unexpected):
<Root cause explanation if the result was surprising>
```

**Output format (item mode)** - one entry per dispatch, chronological:

```
Item: <itemId>
Dispatch history (<N> run(s)):

[1] Cron: <name>  Time: <startedAt> (session: <session-id>)
    What happened: <narrative>
    Conclusion: <decision>

[2] Cron: <name>  Time: <startedAt> (session: <session-id>)
    ...
```

---

## No match / preCheck skipped

If no matching run or session is found (via the admin API or the +/-90 minute
fallback window):

```
No session found for cron "<name>" around <time> Pacific.
(or, in item mode: No dispatch history found for item "<item>".)

Possible reasons:
1. The preCheck script returned non-zero - the cron was suppressed before Claude ran.
   preCheck failures are logged to stdout via console.error with an "[agent:cron]" prefix
   (runtime/cron-handler.ts) - check the container's stdout/log aggregator around <time>.
2. The cron was disabled at the time. Verify via:
      curl -s -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
        "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/crons" | jq '.[] | select(.name | test("<name>"))'
3. The cron fired in a different workspace - check whether $AGENT_HOME differs.
4. Name+time mode only: the +/-90 minute fallback search window was too narrow. Try a broader time range.
5. Item mode only: the item was never dispatched through an admin-tracked cron.
```

---

## Notes

- This skill reads the admin API, transcript files, and (optionally, Step 3)
  Sentry. It does **not** require container stdout or any external log system.
  The session JSONL is the authoritative record of what the model concluded and
  why; the admin API's cron run records are the authoritative record of exactly
  when a cron fired and against what item.
- Prefer the admin-API path (Step 1) over the fallback whenever it is reachable:
  it gives an exact `startedAt` and `sessionId` instead of a guess, and item
  mode is only possible through it.
- The Sentry step is best-effort and never blocking.
- A `[silent]` response is **expected behavior** when the cron found nothing to
  do; look at the Bash commands to see what it checked.
- JSONL entries with `type: "summary"` are condensed context records; skip them
  when extracting the narrative.
