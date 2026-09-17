# TODO

## My ideas for the next features

- Currency converter extension for the command palette

- ~~A shortcut that opens a ring around the mouse~~ — **done**, `Ctrl+Alt+R`.
  Every screen at a direction, the palette in the middle, picking one opens the
  island on it. ⚠️ Eight at most: past that, aiming stops being faster than
  reading.
  - [x] **Hold and let go to pick.** Press, flick the wrist, let go — one
        gesture, no click. A tap still opens it and leaves it up, which is what
        somebody reading the labels is doing. 200ms is the line.
  - [x] **Verbs as well as screens**, and they are what stops it being a
        navigation menu: add a task, write a note (both with the caret where it
        belongs), shelve the clipboard, start a pomodoro. Chosen in
        `Settings → Island → The ring`, eight at most.
  - [ ] The chosen list is ordered by the settings list rather than dragged. A
        ring whose wedges move about is one where aiming stops working, so the
        order has to come from somewhere fixed — but "somewhere fixed" is
        currently "the order this list happens to be written in".
- [x] **The rail budget**: a screen earns a rail stop only if you would sit on
      it for thirty seconds. **System is off it now**, with a chip in the
      header beside the timer and the bell — it is a place you visit for one
      thing and leave. Review is still there and is the remaining candidate.

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

- ~~Feature (media): volume mixer, per app~~ — **done**, on the System screen:
  a row per app with a rail and a mute, sorted by what is making a sound now.
  ⚠️ `eRender` sessions, read on OPEN and never polled — it is a COM walk of
  every session on the machine. A write goes to every session of that process,
  because a browser opens one per renderer.
  - [x] The app's own icon on each row, from the shell — the same extractor
        the palette and the call strip use, so there is one leaky-handle path
        rather than three.
  - [ ] Pid 0 — Windows' own system sounds — is left out: it has no process to
        name and no icon, and a row that cannot say what it is is a slider
        nobody dares move.

- ~~Improve (today): overhaul the Today screen~~ — **done**. The chips are
  raised rather than washed in their list's colour (the dot carries it); the
  heading no longer names the list the rail below is already wearing lit; the
  overdue chip is text and a hairline rather than a filled amber pill.
  - **One thing to do next**: the first row that can actually be ticked wears
    an accent edge. A list is a set of things you could do; a queue is one
    thing you are about to do.
  - **What you have finished**, beside what is left. A day that only counts
    down can only get worse.
  - **The day emptying** sweeps the rail once — the reward for finishing is
    that the list is empty, which is a quiet thing.
  - [ ] No streak, and it is the obvious next one: "three days clear" is the
        strongest thing this screen could say and it needs history the app
        does not keep yet. The Review screen is where that would come from.

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
- ~~Feature: In call mode with controls~~ — **done**. The microphone is the
  signal: an app with an active capture session is in a call, which is the same
  fact Windows draws its own microphone glyph for. Collapsed, the strip keeps
  the clock and gains mute + hang up; expanded, it is the call with its own
  screen. Zoom, Teams, Meet, WhatsApp — and Discord and Slack, which the table
  gave away for free.
- ~~Notifications shelf~~ — **done, basic**. Windows' own centre, mirrored on a
  Notices screen with a bell in the header. ⚠️ A MIRROR: dismissing one here
  dismisses it there, and nothing is kept on disk. The header shows a count and
  never a word of content.
  Cards with the app's own logo, the title, the app and two lines of body — the
  shape the notification had when it flew past. Dismiss, clear all, and pressing
  a card opens the app it came from.
  - [ ] ⚠️ **Reply and snooze are not possible.** A notification cannot be
        activated from outside — `UserNotification` has no method for it — so
        the only handle is the app's AUMID, which opens Slack and never the
        thread. Those actions live in the notification's own buttons, which
        Windows does not expose.
  - [ ] The poll is 1.5s now, not 4. Instant would need `NotificationChanged`,
        which is documented as needing a background-task registration a desktop
        app cannot make.
  - [ ] One app in fifty still has no logo anywhere (WinRT, the AUMID registry
        key, the Start Menu) and falls back to a letter tile.
- ~~Fix: Upcoming event stuck on the island~~ — **done**

- ~~Pomodoro widget~~ — **done**, and then rebuilt as two faces on one screen,
  and then as two ENGINES behind them: a pomodoro and a timer run side by
  side. One state meant starting a timer silently threw away a run four rounds
  in. The tab you are not on wears a dot when its countdown is live.

- ~~Improve: context awareness for the notch~~ — **done**. Opening it lands on
  whatever is happening rather than wherever you last were: the pill has
  already picked the most live claim, and the island follows it. ⚠️ Above 40
  only — a call, an agent waiting, a meeting about to start, a countdown — and
  never for a toast, which outranks everything and is a message rather than a
  place. `Settings → Island → Opening` switches it off.
  - [ ] It follows on EVERY open, so walking to Notes and reopening goes back
        to the call. That is the feature; if it grates, the escape is a grace
        period after a deliberate screen change rather than a new setting.

- ~~Feature (media): live lyrics sync using LRCLIB~~ — **done**. Its own panel
  under the player and the queue, opened from the button beside the output
  picker and closed by default; the island grows for it. The whole file is in
  the DOM and the window travels over it, fading and blurring out from the
  line being sung — so it can be scrolled to read ahead, and a line change
  reads as movement rather than as a caption being replaced. The change itself
  is a timer aimed at the next line's own second, not a poll. ⚠️ LRCLIB's
  `/api/get` is a fingerprint (artist + track + album + duration) and answers
  404 on a near miss, which is the behaviour to want — nothing beats another
  recording's words against this one's clock. No key, no account, cached by
  the same fingerprint on both sides.
  - [ ] Unsynced files are ignored. LRCLIB serves plain words too, and pacing
        them by dividing the track's length by the line count is an invention
        that is wrong from the second line on. A block of static text would be
        honest and is not drawn yet.
  - [ ] Nothing on the collapsed strip. A line of lyric is the most tempting
        thing to put there and the one most likely to be read over somebody's
        shoulder — the same argument that keeps a notification's words off it.

---

## Decisions this must not quietly undo

- The bezel shape. Everything is welded to a screen edge and keeps the fillet.
- One settings window. Anything new that is a preference goes in `prefs.rs` and
  gets a control there — not a popover somewhere else.
- The accent is one variable. No new hardcoded colour; derive with `color-mix`.
- Tokens never reach a WebView, a log, or an error message.
- `AGENTS.md` is the log of things that failed silently. Every trap this pass
  turns up gets a numbered entry.
