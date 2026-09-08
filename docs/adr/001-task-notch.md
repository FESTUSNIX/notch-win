# ADR-001: A sibling task notch backed by TickTick

**Status:** Accepted; first implementation available
**Date:** 2026-09-08
**Deciders:** Project owner

## Implementation status

The first version implements a separate four-edge task notch, pinning, Today /
Overdue / All lists, nested display, checklist toggles, task completion, quick
add directly in the panel, rename and a focusable account editor with Windows Credential Manager token setup.
It shares native window helpers while keeping masks and positions independent.

The sections below retain the design direction. Scope limits in the delivered
version: no indent/outdent or full-task undo, no persistent task cache/offline
queue, and only task lists exposed by TickTick's project endpoint. Exact daily
progress is withheld when history reaches the API cap. Live account testing
requires the owner to connect TickTick in the app. See README for current setup
and validation commands.

## Context

The requested sibling to Codenotch should show nested tasks, a daily plan and
progress, with the compact black surface and green progress ring in the supplied
reference. The existing application uses Tauri 2, Rust and vanilla TypeScript.
The owner already uses TickTick Premium, synced with Google Calendar and then
Samsung Calendar. Phone sync is important and a new subscription is undesirable.

The existing window plumbing is single-instance: `hover.rs`, `drag.rs` and
commands in `lib.rs` address the `notch` window directly. Interactive rectangles,
drag state, edge and position also belong to that one notch. The reusable parts
are the shape and scale functions in `src/layout.ts`, and the Win32 window
helpers in `win.rs`.

The usage notch deliberately has `WS_EX_NOACTIVATE`. A task list can support
mouse completion without taking focus, but task creation and editing require
an explicitly opened, keyboard-focusable surface.

## Proposed decision

Build a distinct task notch in the same application initially, with independent
position and visibility. Share the existing shape and Windows behavior through
window-specific state. Keep task storage behind a small task-source boundary;
only implement one source in the first release.

Use TickTick as the source of truth through its official Open API. Keep the
existing phone and Google/Samsung calendar workflow. The notch reads and updates
TickTick directly; calendar events are not an intermediate task store.

No additional hosted backend, paid automation service or task subscription is
part of this design. The public API reference does not specify a separate API
fee; verify access with the existing account during setup rather than treating
that absence as a contractual pricing guarantee.

Local persistence is a cache and UI preferences, not a second editable task
database. Use TickTick task IDs for every operation and preserve its recurrence,
parent relationships and completion semantics.

## Options considered

| Option | Complexity | Cost/dependency | Fit | Main trade-off |
| --- | --- | --- | --- | --- |
| **TickTick integration (recommended)** | Medium | Existing Premium account; no new sync service | Current phone/calendar workflow plus a custom notch | Validate recurrence and nested editing against live API behavior |
| Local task store | Medium | No service account | Custom nested daily workflow | We own persistence, history and eventual sync |
| Obsidian integration | Medium | Obsidian installation and configured vault | Tasks alongside notes and daily journals | Markdown identity, external edits and plugin conventions need care |
| Todoist integration | Medium | Account, credentials and network | Existing task workflow across devices | Service semantics constrain the custom outliner |

### TickTick: selected direction

The current official API reference was read on 2026-09-08, including its
underlying `openapi.md`. It documents:

- Personal API tokens via the web app's Settings > Account > API Token, and
  OAuth for applications authorizing other users.
- Project retrieval and project task data.
- Task creation, updating, completion, batch operations and filtering.
- `parentId` on tasks, separately from checklist `items`.
- Completed-task queries filtered by projects and completion time, with at most
  200 results per request.
- Completion timestamps, task time zones, scheduling and recurrence fields.

Prefer a direct Rust HTTP client using the existing reqwest dependency. No CLI,
Node runtime, AI model or Codex connector is needed to run the installed notch.
For personal use, provide a masked token input in the settings window and store
the token in Windows Credential Manager. Never return it to the task page,
include it in logs, or save it in the repository. An OAuth flow can follow if
the application is distributed to other users.

Begin with Today, overdue tasks, project grouping, nested display, completion,
quick add and a daily progress ring. Refresh on a restrained cadence and after
mutations; read both active and completed tasks so phone completions appear.
Separate checklist completion (`1`) from full task completion (`2`). Do not
equate checklist items with independently nested tasks.

Validate `parentId` write behavior, parent completion/reopening and recurring
task instances before enabling indent/outdent or broad undo. Preserve unknown
fields and fetch current task data before checklist edits. A task disappearing
from active results is not evidence it was completed: it could have moved,
been deleted or become inaccessible.

Completion-history queries are capped at 200. Use narrower time windows where
needed and visibly mark incomplete history instead of presenting a partial
count as complete. Prototype local-day boundaries, phone completion, recurrence
and restart before claiming an accurate daily denominator.

Sources: [TickTick Open API](https://developer.ticktick.com/docs/index.html#/openapi)
and [reference Markdown](https://developer.ticktick.com/docs/openapi.md).
TickTick confirms cross-device sync on its [product page](https://ticktick.com/home).
No authenticated account requests or remote task changes have been made.

### Local store (alternative, not selected)

Use a versioned task document with stable IDs and parent IDs, task ordering,
optional notes, planned day, optional due date and completion timestamp. Persist
under `%APPDATA%\codenotch-win\tasks\`, independently of usage settings and
readings. Persist with atomic replacement and a recoverable previous version;
report write failures and never turn malformed data into an empty saved list.

JSON is a straightforward initial canonical store. Markdown export/import can
make the data portable, but export alone is not an Obsidian integration. If
editing the same files in Obsidian is a requirement, choose the Obsidian option
before implementing storage.

### Obsidian (alternative, not selected)

The official CLI supports reading daily notes, listing tasks, appending tasks
and changing checkbox status. It requires the supported installer, CLI enabled,
and Obsidian running (or launched by the command). This avoids inventing a local
HTTP server or requiring a community REST plugin.

Before selecting it, verify the installed version, vault and actual task syntax.
Use an explicit vault and paths. File/line task references must be refreshed and
their content checked before writes because another editor can move lines.
Do not assume CLI task queries implement the Tasks community plugin's recurrence
or custom-status behavior. Prototype nested task round trips before committing.

Source: [Obsidian CLI](https://obsidian.md/help/cli), checked 2026-09-08.
Daily notes: [official documentation](https://obsidian.md/help/Plugins/Daily+notes).

### Todoist (alternative, not selected)

The official API exposes tasks, parent IDs, project membership and due dates,
making a notch client feasible. Verify completed-task queries, ordering and
completion behavior in a small integration spike. Keep credentials in the native
backend; show stale data and failed mutations explicitly. A source outage must
not silently revert a checkbox or discard queued user intent.

Source: [Todoist API v1](https://developer.todoist.com/api/v1/), checked 2026-09-08.

## First-release interaction

- Collapsed: a focus/target mark, today's completed/total count and progress ring.
- Hover: today's plan grouped by project or parent task, expandable children,
  checkboxes, short notes and a hide-completed control.
- Click to pin: keep the list open while working through it.
- Explicit Add/Edit: open a keyboard-focusable compact editor. Escape dismisses
  it. Merely hovering never takes focus from the current application.
- Editor: quick add and rename within TickTick projects. Nested display comes
  first; indent/outdent, reordering and full project planning follow successful
  API round-trip tests. Open TickTick for operations not yet supported.
- Unfinished planned tasks remain visible as carry-over the next day; changing
  the day does not erase tasks or their completion history.

## Progress semantics

- Initially match TickTick's scheduled-day behavior. Verify how its start/due
  fields correspond to Today rather than introducing a separate local daily
  plan that cannot sync to the phone. A separate focus selection is optional
  later and must be explicitly labeled if it is local-only.
- Count actionable leaf tasks once. Parents with children summarize their
  descendant leaves and do not add another unit to the denominator.
- Parent checkboxes must follow verified TickTick completion behavior. Display
  partial progress; defer bulk completion and undo until recurrence and parent
  reopening have been tested.
- Daily progress uses today's scheduled actionable leaves, including completed
  members. Show overdue carry-over separately. Fetch required parent context
  without counting it twice, and distinguish recurring occurrences.
- An empty plan says "Plan today" instead of presenting 0/0 as a percentage.
- Derive the day from the local calendar; refresh on midnight and resume from
  sleep. Keep completion timestamps so historical progress is not reconstructed
  from today's checkbox state.

## Implementation consequences

Use per-window hover rectangles, drag state, placement and event routing. Preserve
the first-tick `Option<bool>` click-through fix and reapply `win::harden` after
every cursor-event toggle. Scope new task commands to the task windows. Provide
both a task-state getter and change events so a listener cannot miss boot state.

Keep notch proportions in `FRAME` and reuse its existing shape. Record any new
task-panel measurements with their reference or a clearly identified design
decision. Avoid continuously animated progress rings in the transparent window.

The first release can stay in one executable and tray while presenting two
independent notches. A separate executable is possible later, but is unnecessary
for independent screen placement. Avoid overlap by giving each notch an explicit
initial position and separate reset/visibility controls.

## Action items

1. Task source identified: TickTick Premium; preserve phone sync and avoid new subscriptions.
2. Build token setup and validate TickTick access, nested tasks, recurrence,
   completion history and day changes with the owner's account.
3. Add the TickTick adapter, cache, progress logic and integration tests.
4. Refactor window plumbing to address each notch independently.
5. Build the compact task view and focusable editor using the existing stack.
6. Verify completion/undo, parent progress, carry-over, restart and failed saves.
7. Verify a release build for typing, focus, click-through, both notches, scaling,
   screen-edge placement and suspend/resume. Debug-only verification is insufficient.

The follow-up UI uses a shared spring and resting pill, compact content height,
four-edge controls, and an inline composer with temporary keyboard activation.
The earlier editor-only form constraint below is superseded by this explicit
focus lifecycle, as requested by the owner.
