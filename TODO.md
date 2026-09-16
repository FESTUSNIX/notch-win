# TODO

## My ideas for the next features

- Currency converter extension for the command palette
- Notifications shelf/screen which keeps recent notifications and allows for quick actions
- Pomodoro widget

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

- ~~Style (shelf): cards with a plinth, title, format and size~~ — done, and the
  plinth now carries the file's **real** preview. ⚠️ The shell's thumbnail, by
  shelf ID — not Tauri's asset protocol, which would have handed the WebView
  the disk. Asked once per file per modification time, and a file the shell
  has nothing for keeps its glyph.
- Feature (media): live lyrics sync using LRCLIB
- Feature: In call mode with controls (mute, hand up, camera, etc.), integrate Teams, Zoom, Google Meet and WhatsApp if possible.
- Feature (media): Add volume mixer. Control volume per app

- Improve (today): Overhaul the Today screen. Fix the flashy category tabs, remove category from the heading and improve readibility of the list. Propose and implement features that make the Today (tasks) screen more useful and productive. We need features that will make the user want to complete the tasks.

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

---

## Decisions this must not quietly undo

- The bezel shape. Everything is welded to a screen edge and keeps the fillet.
- One settings window. Anything new that is a preference goes in `prefs.rs` and
  gets a control there — not a popover somewhere else.
- The accent is one variable. No new hardcoded colour; derive with `color-mix`.
- Tokens never reach a WebView, a log, or an error message.
- `AGENTS.md` is the log of things that failed silently. Every trap this pass
  turns up gets a numbered entry.
