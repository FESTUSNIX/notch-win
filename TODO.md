# TODO

## My ideas for the next features

- Currency converter extension for the command palette

- ~~Pomodoro widget~~ — **done**, and then rebuilt as two faces on one screen,
  and then as two ENGINES behind them: a pomodoro and a timer run side by
  side. One state meant starting a timer silently threw away a run four rounds
  in. The tab you are not on wears a dot when its countdown is live.
  - **Timer**: a ruler of minutes you drag under a fixed mark, which glides on
    to read what is LEFT once it starts — setting it and watching it are one
    picture. Wheel works too. The strip follows the hand between the marks and
    eases onto one when you let go, the ends give rather than stopping dead,
    and the mark under the arrow lights white. Full width: the fade is a mask
    on the dial, not an opacity written onto 242 ticks every frame.
  - **Collapsed (pomodoro)**: quiet by default — the phase icon, the session
    name, and a fluid line along the bottom edge; the countdown comes back
    under the pointer. ⚠️ Which means it comes back in CLICK mode only, since
    hover opening replaces the strip with the panel before a pointer lands on
    it. `Settings → On the notch` switches it back to the number.
  - **Focus and break** are a vivid accent and a pale tint of the same accent,
    plus a focus glyph and a coffee cup. ⚠️ A tint rather than a second hue:
    the accent is one variable and a fixed blue would clash with half of what
    somebody might pick.
  - **A finished break** hands back the next round ready rather than ending the
    run — the rounds you did are kept and the button says "Start round 3".
  - **Collapsed (timer)**: a circle torn off the notch's side —
    level with its bottom, a shade smaller, tucked into the flare. The ring is
    how far through, the middle is the minutes over the seconds, and under the
    pointer it becomes pause/resume. Pressing the ring opens the screen. ⚠️ It is
    reported as a PASSIVE rect: clickable, and not a thing you open the island
    by pointing at. A pomodoro still takes the strip, with the countdown as
    the biggest thing on it.
  - **Pomodoro**: an optional session name as a big borderless heading (it is
    what the collapsed pill then says, because "Focus" you already knew), the
    whole four-round cycle drawn as a track sized by real minutes, and Start /
    Pause / Skip / Stop. Lengths behind a button on the screen itself.
  - **Sound**: Windows' own notification sounds, nothing shipped. Chime,
    Calendar, Alarm or none, in Settings. ⚠️ Played directly rather than
    through the toast, because Focus Assist suppresses a toast and Focus Assist
    is what somebody running a pomodoro has switched on.
  - [ ] The lengths are in two places on purpose — the drawer writes the same
        preference the settings window does. One value, two controls.
  - [ ] No per-session history: how many pomodoros you did yesterday is not
        recorded anywhere. The Review screen is where that would go.
  - [ ] The header chip speaks for ONE of the two. With both running it shows
        the pomodoro and wears a pip for the timer; the timer's own figure is
        on the circle beside the notch, which the open panel hides.
  - [ ] A ready round waits for ever. Nothing nudges you again after the first
        toast, so a pomodoro can sit at "round 3, ready" all afternoon.
  - [ ] The dial is timer-only, deliberately: a pomodoro's lengths are a
        setting you choose once, and under a drag they become a thing to fiddle
        with.
  - [ ] No momentum on the dial. A flick that carries on is right for a list
        and wrong for a value you are aiming at — the release would routinely
        land ten minutes past the one you stopped on.
  - [ ] The bubble's middle is the only pause, so the ring around it is the
        only way to open the screen. That annulus is about six pixels wide —
        the right way round (a mis-hit pauses, which costs one press, rather
        than opening the panel over what you were looking at) but still thin.
        Two actions on a 29px control is one too many; if it annoys, the
        circle should just open the screen and the pause should go.
  - [ ] Nothing counts down beside the notch on a vertical edge unless the
        island has room below it; it is placed there, untested on a real
        side-mounted display.
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

- Improve: Context awareness for the notch. It's aware of what we are doing (call, timer/pomodoro, music/media etc.), we can use that even better to open up (expand) the notch on the correct screen isntead of opening it on home screen every time

- Feature (media): live lyrics sync using LRCLIB

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

---

## Decisions this must not quietly undo

- The bezel shape. Everything is welded to a screen edge and keeps the fillet.
- One settings window. Anything new that is a preference goes in `prefs.rs` and
  gets a control there — not a popover somewhere else.
- The accent is one variable. No new hardcoded colour; derive with `color-mix`.
- Tokens never reach a WebView, a log, or an error message.
- `AGENTS.md` is the log of things that failed silently. Every trap this pass
  turns up gets a numbered entry.
