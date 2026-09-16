# TODO

## My ideas for the next features

- Currency converter extension for the command palette
- ~~Notifications shelf~~ — **done, basic**. Windows' own centre, mirrored on a
  Notices screen with a bell in the header. ⚠️ A MIRROR: dismissing one here
  dismisses it there, and nothing is kept on disk. The header shows a count and
  never a word of content.
  - [ ] No quick actions yet beyond dismiss and clear — no reply, no snooze,
        and no opening the app that sent it.
  - [ ] No app icons on the rows; the app's NAME is the only mark. `AppInfo`
        can give a logo and that is the obvious next thing.
  - [ ] A 4s poll, so a toast takes up to four seconds to land on the screen.
- ~~Pomodoro widget~~ — **done**, in the header beside the bell, with a plain
  countdown in the same chip (`timer 12` in the palette). Lengths in Settings.
  - [ ] It does not claim the collapsed pill, so a running pomodoro is only
        visible with the island open. Deliberate for now — the pill is busy.
- ~~A shortcut that opens a ring around the mouse~~ — **done**, `Ctrl+Alt+R`.
  Every screen at a direction, the palette in the middle, picking one opens the
  island on it. ⚠️ Eight at most: past that, aiming stops being faster than
  reading.
  - [ ] Tap-to-open only. Hold-the-key-and-release-to-pick is the gesture that
        would make it properly fast, and the plugin does report key release.
  - [ ] No actions on it, only screens — "add a task" and "shelve the
        clipboard" would both earn a wedge.
- [ ] **The rail budget** (agreed, not yet applied): a screen earns a rail stop
      only if you would sit on it for thirty seconds. Everything else is a
      palette command or a Home section. System and Review are the two that
      should come off the default rail.

- ~~Quick note widget with history of all notes, search~~ — **done**. A Notes
  screen: a field that saves on Enter, the pile newest-first, and a search that
  folds accents and matches every word anywhere. Palette: "Write a note".
  - [ ] No global shortcut of its own — the palette command is the fast path.
        One would mean a seventh key and a seventh row in Settings.
  - [x] Pin a note to the desktop — its own always-on-top, undecorated,
        draggable window. Position and size are remembered; pinned notes come
        back when the app restarts.
  - [ ] Notes are not searchable _from the palette_ yet, only from the screen.
  - [ ] A pinned note has no colour of its own — they are all the same paper.
        A colour per note is the obvious next thing if the desktop gets busy.
  - [x] Simple formatting — `**bold**`, `*italic*`, `` `code` ``, `~~strike~~`,
        `-` and `1.` lists, `>` quotes, `#` headings, ``` fences. Stored as the
        text you typed; parsed on the way out.
  - [ ] No nesting: `**a *b* c**` renders the outer marker only. Every attempt
        at one grows a state machine, and a note is not a document.

- Feature (media): live lyrics sync using LRCLIB
- ~~Feature: In call mode with controls~~ — **done**. The microphone is the
  signal: an app with an active capture session is in a call, which is the same
  fact Windows draws its own microphone glyph for. Collapsed, the strip keeps
  the clock and gains mute + hang up; expanded, it is the call with its own
  screen. Zoom, Teams, Meet, WhatsApp — and Discord and Slack, which the table
  gave away for free.
  - [ ] Controls are the apps' own keyboard shortcuts, so the call window comes
        forward for an instant when you press one. There is no other mechanism:
        `PostMessage` does not reach a Chromium or WebView2 window. AGENTS 413.
  - [ ] **Google Meet cannot be hung up from the keyboard** and WhatsApp
        publishes no in-call shortcuts at all, so neither offers those buttons.
        The microphone is still cut for both, which is what the mute mostly is.
  - [ ] No participant count, and there cannot be one: nothing on Windows says
        how many people are in a meeting. The elapsed time is in that slot.
  - [ ] Nothing reads back whether the APP thinks it is muted — no API does.
        The mute presses both the app's button and the microphone endpoint, so
        the state shown is the endpoint's, which is the one that is true.
  - [ ] Detection is a 1.5s poll, so joining shows up a beat late.
  - [ ] Only tested against a capture stream this repo opens itself (AGENTS
        412). The app table, the window titles and every keystroke are
        unexercised until a real meeting.
- Feature (media): Add volume mixer. Control volume per app

- Improve (today): Overhaul the Today screen. Fix the flashy category tabs, remove category from the heading and improve readibility of the list. Propose and implement features that make the Today (tasks) screen more useful and productive. We need features that will make the user want to complete the tasks.

- Fix: when dragging the screen rail (over the limit) the content seems to animate from a wrong direction (the target screen content)

---

---

## 7. Agent states were inverted — DONE

⚠️ **The two states a session can be in were exactly the wrong way round**,
and each looked plausible on its own.

- A turn ending in prose — the work came back, no question — was reported as
  _waiting_. True of the file, false of you: it pulsed amber and held the pill
  until the terminal was closed. It is **done** now, which is idle.
- A QUESTION was reported as _working_. `AskUserQuestion` arrives as a
  `tool_use` block exactly like `Bash`, so the mid-flight check swallowed the
  one moment that genuinely wanted you — no pulse, no notification. It is
  **waiting** now.

Verified against a real transcript rather than argued: the question is an
assistant record whose only block is that tool call, and nothing follows it
until the answer arrives as a `tool_result`.

- [ ] Permission prompts are still not detected. Blocking on "allow this
      command?" looks like a tool call with a result that has not arrived —
      indistinguishable, from the transcript alone, from a `cargo build` that
      is still running. It needs a time threshold or a hook.

---

## Done

- Fix: Arcs and screen rail/switcher are visible when the command palette is open. The command palette should be a separate layer that doesn't show the global island UI
- Fix (system): Unnecessary padding bottom on device and bluetooth cards.
- Fix (command palette): When closing the command palette, expanded island shows up before folding. Fix that.
- Feature: reordering screens/tabs, hiding them, and a colour each — eight
  preset tones plus a custom picker, right-click to clear back to the accent.

- ~~Style (shelf): cards with a plinth, title, format and size~~ — done, and the
  plinth now carries the file's **real** preview. ⚠️ The shell's thumbnail, by
  shelf ID — not Tauri's asset protocol, which would have handed the WebView
  the disk. Asked once per file per modification time, and a file the shell
  has nothing for keeps its glyph.

---

## Decisions this must not quietly undo

- The bezel shape. Everything is welded to a screen edge and keeps the fillet.
- One settings window. Anything new that is a preference goes in `prefs.rs` and
  gets a control there — not a popover somewhere else.
- The accent is one variable. No new hardcoded colour; derive with `color-mix`.
- Tokens never reach a WebView, a log, or an error message.
- `AGENTS.md` is the log of things that failed silently. Every trap this pass
  turns up gets a numbered entry.
