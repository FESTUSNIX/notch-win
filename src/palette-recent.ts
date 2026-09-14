/* What you actually use, first.
 *
 * With nothing typed the palette had no opinion at all: it listed the providers
 * in declaration order, so the first thing you saw was whatever happened to be
 * registered first, for ever. That is the state the palette is in every single
 * time it opens, and it was the one state nobody had designed.
 *
 * ⚠️ Recency, not frequency. A count never forgets — something run twenty times
 * last month outranks the thing you have been doing all morning, and the list
 * slowly ossifies into a record of what you used to do. A half-life lets the
 * order follow what you are working on this week.
 */

/** Just enough of `localStorage` to be faked in a test. */
export interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = "codenotch.palette.recent";
/** Enough to cover a week of real use; past that the tail scores nothing
 *  anyway, and the ids of finished tasks and dead sessions pile up. */
const KEEP = 40;
const HALF_LIFE = 3 * 24 * 60 * 60 * 1000;
/** ⚠️ Under WORD (45) in palette-match on purpose. Recency should decide
 *  between two things that match about as well; it must never drag a weak
 *  match over a strong one, or typing stops feeling like it is in charge. */
const TOP = 34;

export class Recent {
  private when = new Map<string, number>();
  private store?: Store;
  private clock: () => number;

  /* ⚠️ Written out rather than declared as constructor parameter
   * properties: the node tests import this `.ts` directly, and Node strips
   * types rather than compiling them, so a parameter property is a hard
   * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` that fails the whole test file at
   * import. Same note in palette-calc.ts. */
  constructor(store?: Store, clock: () => number = Date.now) {
    this.store = store;
    this.clock = clock;
    this.load();
  }

  /** ⚠️ Every read and write is guarded. `localStorage` is not merely empty in
   *  a private window or with site data blocked — the accessor itself throws,
   *  and an exception here would take the palette down with it. */
  private load() {
    try {
      const raw = this.store?.getItem(KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Record<string, number>;
      for (const [id, at] of Object.entries(saved)) {
        if (typeof at === "number") this.when.set(id, at);
      }
    } catch { /* an unreadable store is the same as an empty one */ }
  }

  private save() {
    try {
      const kept = [...this.when.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, KEEP);
      this.when = new Map(kept);
      this.store?.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
    } catch { /* nothing to be done, and nothing worth saying about it */ }
  }

  record(id: string) {
    this.when.set(id, this.clock());
    this.save();
  }

  /** Decays by half every three days, so the order follows the week rather
   *  than the year. Never negative: an id nobody has run scores nothing, and
   *  is not penalised for it. */
  boost(id: string): number {
    const at = this.when.get(id);
    if (!at) return 0;
    const age = this.clock() - at;
    if (age < 0) return TOP;   // a clock that went backwards is not a demotion
    return TOP * Math.pow(2, -age / HALF_LIFE);
  }
}
