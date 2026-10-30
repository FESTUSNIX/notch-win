/* Closing the day (batch 12, 30 Oct): one focused view in the Helm screen,
 * top to bottom, opened from the Guardian's "Zamykamy dzień?" moment, the
 * moon in Today's header, or the palette ("Zamknij dzień").
 *
 * The reading first — his time, Claude's, what got done, and the Guardian's
 * two lines on the day — then three decisions, each a flat list (the panel's
 * rules: rows, never cards in a card): CZAS Z KODU (coded time not logged:
 * the minutes in a small field, Zaloguj or Pomiń), ZOSTAŁO (Today's entries
 * still open: Zrobione, Jutro, Odpuść) and JUTRO NA START (one of Helm's
 * candidates, radio rows). Then ONE filled button, Zamknij dzień.
 *
 * ⚠️ Every row decision is optimistic: the row turns at once (dimmed, its
 * outcome in a word where the buttons were) and turns back with Helm's
 * reason if the call fails. Nothing here waits for the next reading.
 *
 * Shapes and the queue acts are helm-link.ts's (`readClose`, `leftActs`,
 * `logAct`), node-tested; this is only the drawing.
 */
import "./helm-close.css";
import { element } from "./dom";
import { call } from "./task-client";
import { paintIcon, type TaskIcon } from "./task-icons";
import { iconButton, logoTile, wordButton, faceOf } from "./helm-parts";
import { leftActs, logAct, projectById, readClose, spoken, type CloseDay, type CloseLeft, type CloseLog, type LeftChoice } from "./helm-link";
import type { HelmSource } from "./screen-helm";

export interface CloseHooks {
  /** Back to Today (Esc, the back arrow, or the day closed). */
  back: () => void;
  /** The view changed size: measure the island again. */
  changed: () => void;
  /** A field took the caret (or let it go): the island takes the keyboard. */
  input: (on: boolean) => void;
  /** The day is closed: its moment goes, and the pill says so. */
  closed: (first: string | null) => void;
}

type Outcome = { word: string; icon: TaskIcon };

const OUTCOME: Record<LeftChoice | "logged" | "skipped", Outcome> = {
  done: { word: "Zrobione", icon: "check" },
  tomorrow: { word: "Jutro", icon: "later" },
  drop: { word: "Odpuszczone", icon: "close" },
  logged: { word: "Zalogowane", icon: "check" },
  skipped: { word: "Pominięte", icon: "close" },
};

const clean = (error: unknown) => String(error).replace(/^(invoke error|error): /i, "").slice(0, 120);

export class HelmClose {
  readonly el = element("div", "task-list scrolls helm-close");
  private day: CloseDay | null = null;
  /** null: not read yet; "none": a Helm without the endpoint; a string: why it failed. */
  private problem: string | null = null;
  private loading = false;
  private outcome = new Map<string, keyof typeof OUTCOME>();
  private minutes = new Map<string, number>();
  private first: string | null = null;
  private finishing = false;
  private gen = 0;

  constructor(private source: HelmSource, private hooks: CloseHooks) {
    this.el.hidden = true;
    this.el.setAttribute("role", "region");
    this.el.setAttribute("aria-label", "Zamknij dzień");
  }

  get open(): boolean { return !this.el.hidden; }

  /** Up, reading the day afresh. */
  show() {
    this.el.hidden = false;
    this.outcome.clear();
    this.minutes.clear();
    this.first = null;
    this.finishing = false;
    void this.read();
  }

  hide() { this.el.hidden = true; }

  private async read() {
    const gen = ++this.gen;
    this.loading = true;
    this.problem = null;
    this.paint();
    try {
      const raw = await call<unknown>("helm_close_day");
      if (gen !== this.gen) return;
      this.day = raw == null ? null : readClose(raw);
      this.problem = raw == null ? "none" : this.day ? null : "Helm sent something unexpected.";
      this.first = this.day?.firsts[0]?.key ?? null;
    } catch (error) {
      if (gen !== this.gen) return;
      this.problem = clean(error);
    }
    this.loading = false;
    this.paint();
  }

  /* ── Drawing ─────────────────────────────────────────────────────────── */

  private paint() {
    const top = element("div", "hc-top");
    top.append(iconButton("back", "Wróć", "k-icon hc-back", () => this.hooks.back()), element("h2", "hc-title", "Zamykamy dzień"));
    const parts: HTMLElement[] = [top];
    const day = this.day;
    if (this.loading && !day) parts.push(element("p", "hc-note", "Czytam dzień…"));
    else if (this.problem === "none") parts.push(element("p", "hc-note", "Ten Helm nie zamyka jeszcze dnia."));
    else if (this.problem) {
      const note = element("p", "hc-note is-error", this.problem);
      note.append(wordButton("retry", "Jeszcze raz", "hp-btn is-ghost", () => void this.read()));
      parts.push(note);
    }
    if (day) {
      parts.push(this.reading(day));
      if (day.closed) {
        const done = element("p", "hc-closed");
        const mark = element("span", "hc-closed-mark");
        paintIcon(mark, "check");
        done.append(mark, element("span", "", "Dzień zamknięty"));
        parts.push(done);
      } else {
        if (day.logs.length) parts.push(this.section("code", "Czas z kodu", day.logs.map(row => this.logRow(row))));
        if (day.left.length) parts.push(this.section("today", "Zostało", day.left.map(row => this.leftRow(row))));
        if (day.firsts.length) parts.push(this.section("sunrise", "Jutro na start", [this.firsts(day)]));
        const foot = element("div", "hc-foot");
        const go = wordButton("moon", this.finishing ? "Zamykam…" : "Zamknij dzień", "hp-btn is-primary hc-go", () => void this.finish());
        go.disabled = this.finishing;
        foot.append(go);
        parts.push(foot);
      }
    }
    this.el.replaceChildren(...parts);
    this.hooks.changed();
  }

  /** The hero: three figures, each a mark in its colour (you iris, Claude
   *  terracotta, done green), then the Guardian's two lines. */
  private reading(day: CloseDay): HTMLElement {
    const box = element("section", "hc-reading");
    const figs = element("div", "hc-figs");
    const fig = (cls: string, icon: TaskIcon, value: string, word: string, tip: string) => {
      const one = element("div", `hc-fig ${cls}`);
      const mark = element("span", "hc-fig-mark");
      paintIcon(mark, icon);
      one.append(mark, element("b", "hc-fig-value", value), element("span", "hc-fig-word", word));
      one.dataset.tip = tip;
      return one;
    };
    figs.append(fig("is-you", "you", spoken(day.worked.you), "ty", `Twój czas: ${spoken(day.worked.you)}`));
    if (day.worked.agents) figs.append(fig("is-agents", "claude", spoken(day.worked.agents), "Claude", `Czas Claude'a: ${spoken(day.worked.agents)}`));
    const doneTip = day.done.titles.length ? day.done.titles.join(" · ") : `${day.done.count} zrobione`;
    figs.append(fig("is-done", "check", String(day.done.count), "zrobione", doneTip));
    box.append(figs);
    if (day.summary) {
      const said = element("p", "hc-summary");
      const mark = element("span", "hc-summary-mark");
      paintIcon(mark, "guardian");
      said.append(mark, element("span", "hc-summary-text", day.summary));
      box.append(said);
    }
    return box;
  }

  private section(icon: TaskIcon, title: string, rows: HTMLElement[]): HTMLElement {
    const sec = element("section", "hc-sec");
    const head = element("h3", "hc-sec-head");
    const mark = element("span", "hc-sec-mark");
    paintIcon(mark, icon);
    head.append(mark, element("span", "", title));
    const list = element("div", "hc-rows");
    list.setAttribute("role", "list");
    list.append(...rows);
    sec.append(head, list);
    return sec;
  }

  private row(key: string, face: HTMLElement, title: string, context: string | null): { row: HTMLElement; end: HTMLElement } {
    const row = element("div", "hc-row");
    row.dataset.key = key;
    row.setAttribute("role", "listitem");
    const text = element("div", "hc-row-text");
    text.append(element("span", "hc-row-title", title));
    if (context) text.append(element("span", "hc-row-ctx", context));
    const end = element("div", "hc-row-end");
    row.append(face, text, end);
    const outcome = this.outcome.get(key);
    if (outcome) {
      row.classList.add("is-settled");
      const said = OUTCOME[outcome];
      const chip = element("span", `hc-outcome is-${outcome}`);
      const mark = element("span", "hc-outcome-mark");
      paintIcon(mark, said.icon);
      chip.append(mark, element("span", "", outcome === "logged" ? `${said.word} ${spoken(this.minutes.get(key) ?? 0)}` : said.word));
      end.append(chip);
    }
    return { row, end };
  }

  private face(projectId: number | null, name: string): HTMLElement {
    const project = projectById(projectId, this.source.notch);
    return logoTile(faceOf(project, this.source.logo(project), name ? { name } : null), "sm");
  }

  private logRow(log: CloseLog): HTMLElement {
    const { row, end } = this.row(log.key, this.face(log.projectId, log.project), log.project, null);
    if (this.outcome.has(log.key)) return row;
    const minutes = this.minutes.get(log.key) ?? log.minutes;
    const field = element("label", "hc-min");
    const input = element("input", "hc-min-input") as HTMLInputElement;
    input.type = "number";
    input.min = "1";
    input.max = "720";
    input.step = "5";
    input.value = String(minutes);
    input.setAttribute("aria-label", `Minuty: ${log.project}`);
    input.addEventListener("focus", () => this.hooks.input(true));
    input.addEventListener("blur", () => this.hooks.input(false));
    input.addEventListener("input", () => { const v = Number(input.value); if (v > 0) this.minutes.set(log.key, v); });
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); this.log(log); }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); input.blur(); }
    });
    field.append(input, element("span", "hc-min-unit", "min"));
    end.append(
      field,
      wordButton("check", "Zaloguj", "hp-btn hc-log", () => this.log(log)),
      wordButton(null, "Pomiń", "hp-btn is-ghost hc-skip", () => this.settle(log.key, "skipped", [])),
    );
    return row;
  }

  private leftRow(left: CloseLeft): HTMLElement {
    const icon: TaskIcon | null = left.type === "small" ? "list" : null;
    const face = icon ? logoTile({ name: "small", icon }, "sm") : this.face(null, left.context ?? "");
    const title = left.type === "item" ? left.title : `${left.title}`;
    const { row, end } = this.row(left.key, face, title, left.context);
    if (this.outcome.has(left.key)) return row;
    if (left.minutes) end.append(element("span", "hc-row-min", spoken(left.minutes)));
    const acts = element("div", "hc-acts");
    acts.append(
      iconButton("check", "Zrobione", "hc-act is-done", () => this.settle(left.key, "done", leftActs(left, "done"))),
      iconButton("later", "Jutro", "hc-act is-later", () => this.settle(left.key, "tomorrow", leftActs(left, "tomorrow"))),
      iconButton("close", "Odpuść", "hc-act is-drop", () => this.settle(left.key, "drop", leftActs(left, "drop"))),
    );
    end.append(acts);
    return row;
  }

  private firsts(day: CloseDay): HTMLElement {
    const group = element("div", "hc-firsts");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", "Jutro na start");
    for (const f of day.firsts) {
      const pick = element("button", "hc-first") as HTMLButtonElement;
      pick.type = "button";
      pick.dataset.key = f.key;
      pick.setAttribute("role", "radio");
      const on = this.first === f.key;
      pick.setAttribute("aria-checked", String(on));
      pick.classList.toggle("is-on", on);
      const dot = element("span", "hc-first-dot");
      const text = element("span", "hc-row-text");
      text.append(element("span", "hc-row-title", f.title));
      if (f.context) text.append(element("span", "hc-row-ctx", f.context));
      pick.append(dot, text);
      // A second press lets go: tomorrow then starts as Helm plans it.
      pick.onclick = () => { this.first = this.first === f.key ? null : f.key; this.paint(); };
      group.append(pick);
    }
    return group;
  }

  /* ── Acting ──────────────────────────────────────────────────────────── */

  private log(log: CloseLog) {
    const minutes = this.minutes.get(log.key) ?? log.minutes;
    this.minutes.set(log.key, minutes);
    this.settle(log.key, "logged", [logAct(log, minutes)]);
  }

  /** The row turns now; the acts go to `/api/queue` in order; a failure turns it back. */
  private settle(key: string, outcome: keyof typeof OUTCOME, acts: Record<string, unknown>[]) {
    this.outcome.set(key, outcome);
    this.paint();
    void (async () => {
      for (const action of acts) await call("helm_queue", { action });
    })().catch(error => {
      this.outcome.delete(key);
      this.source.tell("Helm", clean(error));
      this.paint();
    });
  }

  private async finish() {
    if (this.finishing) return;
    this.finishing = true;
    this.paint();
    try {
      const answer = await call<{ ok?: boolean; error?: string }>("helm_notch_post", { path: "/api/notch/close", body: this.first ? { first: this.first } : {} });
      if (answer && answer.ok === false) throw new Error(answer.error || "Helm said no.");
      const first = this.day?.firsts.find(f => f.key === this.first)?.title ?? null;
      this.finishing = false;
      this.hooks.closed(first);
      this.hooks.back();
    } catch (error) {
      this.finishing = false;
      this.source.tell("Helm", clean(error));
      this.paint();
    }
  }
}
