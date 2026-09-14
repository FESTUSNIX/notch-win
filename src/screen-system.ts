/* The machine: volume, brightness, where the sound goes, what is connected —
 * and where the day went.
 *
 * Everything the OS already owns and buries three clicks deep in a flyout. The
 * island is already on screen, so it is a better place to keep them.
 *
 * ⚠️ Read on demand, never polled. Brightness is a DDC/CI round trip down the
 * display cable, and Bluetooth enumeration walks the radio's device list —
 * neither is something to do every second for a screen nobody is looking at.
 * `system.rs` polls only the connected-device list, and only to raise a notice.
 */
import { listen } from "@tauri-apps/api/event";
import { element } from "./task-list";
import { paintIcon, type TaskIcon } from "./task-icons";
import { call, native } from "./task-client";
import { deviceName } from "./media-format";
import type { AudioDevice } from "./screen-media";
import type { Activity } from "./island-activity";

export interface BluetoothDevice {
  name: string;
  connected: boolean;
  paired: boolean;
}

export interface SystemState {
  /** 0..100, or -1 when there is nothing to ask. */
  volume: number;
  muted: boolean;
  /** 0..100, or -1 when no monitor answered over DDC/CI. */
  brightness: number;
  bluetooth: BluetoothDevice[];
}

export interface Machine {
  /** Percentages, or -1 where the figure could not be taken. */
  cpu: number;
  memory: number;
  diskUsed: number;
  diskFree: number;
  network: string;
  uptime: number;
}

export interface AppTime {
  day: string;
  total: number;
  apps: { name: string; seconds: number }[];
}

export const emptySystem = (): SystemState => ({ volume: -1, muted: false, brightness: -1, bluetooth: [] });


/** "3h 12m", "48m". Hours only when there are any — "0h 48m" reads as a
 *  placeholder rather than as three quarters of an hour. */
export function spanText(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

export class SystemScreen {
  state: SystemState = emptySystem();
  devices: AudioDevice[] = [];
  machine: Machine = { cpu: -1, memory: -1, diskUsed: -1, diskFree: 0, network: "", uptime: 0 };
  error = "";
  /** Which summary tile has its sheet open, if any. */
  private open: "output" | "bluetooth" | null = null;
  private notice: { name: string; until: number } | null = null;
  private loaded = false;

  constructor(private host: HTMLElement, private changed: () => void) {}

  async boot() {
    if (native) {
      await listen<string>("system:connected", event => {
        // Six seconds is long enough to read and short enough that it is gone
        // before it becomes part of the furniture.
        this.notice = { name: event.payload, until: Date.now() + 6000 };
        void this.load();
        this.changed();
      });
    }
  }

  /** Something plugged in, briefly, at the top of the stack. */
  activity(): Activity | null {
    if (!this.notice) return null;
    if (Date.now() > this.notice.until) {
      this.notice = null;
      return null;
    }
    return {
      // Above everything: it is the newest fact on the machine and it expires.
      priority: 60,
      screen: "system",
      kind: "event",
      icon: "bluetooth",
      label: this.notice.name,
      value: "connected",
    };
  }

  /** Re-read the machine. Called when the screen is opened, not on a timer. */
  async load() {
    try {
      const [state, devices, machine] = await Promise.all([
        call<SystemState>("get_system"),
        call<AudioDevice[]>("get_audio_devices"),
        call<Machine>("get_machine"),
      ]);
      this.state = state;
      this.devices = devices;
      this.machine = machine;
      this.error = "";
    } catch (error) {
      this.error = String(error);
    }
    this.loaded = true;
    this.changed();
  }

  /* ── The capsule ───────────────────────────────────────────────────────────
   * A tall rounded tile that fills from the bottom, with the glyph sitting in
   * it — the Control Centre shape, because it is a better control than a rail
   * and a dot: the whole thing is the target, so it can be hit without aiming.
   *
   * ⚠️ Not `<input type=range>`. That gives a horizontal 4px rail whose thumb
   * is the only hit area, and restyling it into this shape means fighting three
   * vendor pseudo-elements. It keeps `role="slider"` and the arrow keys so
   * nothing is lost by leaving the native control behind. */
  private capsule(icon: TaskIcon, label: string, value: number, commit: (level: number) => void): HTMLElement {
    const cap = element("div", "cap");
    cap.setAttribute("role", "slider");
    cap.setAttribute("tabindex", "0");
    cap.setAttribute("aria-label", label);
    cap.setAttribute("aria-valuemin", "0");
    cap.setAttribute("aria-valuemax", "100");
    cap.setAttribute("aria-valuenow", String(Math.max(0, value)));
    const fill = element("i", "cap-fill");
    fill.style.height = `${Math.max(0, value)}%`;
    const mark = element("span", "cap-icon");
    paintIcon(mark, icon);
    const readout = element("span", "cap-readout", `${Math.max(0, value)}%`);
    cap.append(fill, mark, readout);

    // Bottom is zero: the fill grows the way the value does.
    const levelAt = (clientY: number) => {
      const box = cap.getBoundingClientRect();
      return Math.round(Math.max(0, Math.min(1, (box.bottom - clientY) / box.height)) * 100);
    };
    let dragging = false;
    cap.addEventListener("pointerdown", event => {
      dragging = true;
      cap.setPointerCapture(event.pointerId);
      commit(levelAt(event.clientY));
    });
    cap.addEventListener("pointermove", event => { if (dragging) commit(levelAt(event.clientY)); });
    const stop = (event: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      try { cap.releasePointerCapture(event.pointerId); } catch { /* already gone */ }
    };
    cap.addEventListener("pointerup", stop);
    cap.addEventListener("pointercancel", stop);
    cap.onkeydown = event => {
      const step = event.key === "ArrowUp" ? 5 : event.key === "ArrowDown" ? -5 : 0;
      if (!step) return;
      event.preventDefault();
      commit(Math.max(0, Math.min(100, Math.max(0, value) + step)));
    };
    return cap;
  }

  private async setVolume(level: number, muted?: boolean) {
    this.state = { ...this.state, volume: level, ...(muted === undefined ? {} : { muted }) };
    this.changed();
    try { await call("set_volume", { level, muted: muted ?? null }); }
    catch (error) { this.error = String(error); this.changed(); }
  }

  private async setBrightness(level: number) {
    this.state = { ...this.state, brightness: level };
    this.changed();
    try { await call("set_brightness", { level }); }
    catch (error) { this.error = String(error); this.changed(); }
  }

  private async chooseOutput(id: string) {
    this.devices = this.devices.map(d => ({ ...d, isDefault: d.id === id }));
    // Choosing is the sheet's whole purpose, so it closes behind the choice.
    this.open = null;
    this.changed();
    try { await call("set_audio_device", { id }); }
    catch (error) { this.error = String(error); }
    await this.load();
  }

  private tile(title: string, cls = ""): HTMLElement {
    const tile = element("section", `tile ${cls}`);
    tile.append(element("h4", "tile-head", title));
    return tile;
  }

  /* ── A list that does not grow the panel ──────────────────────────────────
   * ⚠️ This is the whole reason the screen was redesigned. Seven audio
   * endpoints — and a developer's machine has Steam's two virtual ones, every
   * monitor, and the real speakers — made a column taller than the island can
   * be, so the tile underneath was simply cut off with nothing to scroll. A
   * tile now shows what is *in use* and puts the rest behind one press, which
   * costs the same two rows whether there are three devices or thirty. */
  private popover(anchor: HTMLElement, id: string, rows: HTMLElement[]) {
    const sheet = element("div", "sheet");
    sheet.append(...rows);
    anchor.append(sheet);
    // Dismiss on anything that is not this sheet. Registered on the next tick
    // so the press that opened it does not immediately close it again.
    const away = (event: Event) => {
      if (event.target instanceof Node && sheet.contains(event.target)) return;
      this.open = null;
      this.changed();
    };
    window.setTimeout(() => document.addEventListener("pointerdown", away, { once: true }), 0);
    void id;
  }

  private summaryTile(
    title: string, id: "output" | "bluetooth", lead: HTMLElement[], rest: number, rows: () => HTMLElement[],
  ): HTMLElement {
    const tile = this.tile(title, `sys-${id}`);
    tile.append(...lead);
    if (rest > 0) {
      const more = element("button", "tile-more", `${rest} more`);
      (more as HTMLButtonElement).type = "button";
      more.setAttribute("aria-expanded", String(this.open === id));
      more.onclick = event => {
        event.stopPropagation();
        this.open = this.open === id ? null : id;
        this.changed();
      };
      tile.append(more);
    }
    if (this.open === id) this.popover(tile, id, rows());
    return tile;
  }

  private outputRow(device: AudioDevice, compact = false): HTMLElement {
    const row = element("button", `sys-row${device.isDefault ? " is-on" : ""}${compact ? " lead" : ""}`);
    (row as HTMLButtonElement).type = "button";
    const mark = element("span", "sys-mark");
    paintIcon(mark, device.isBluetooth ? "bluetooth" : "speaker");
    row.append(mark, element("span", "sys-name", deviceName(device.name)));
    if (device.isDefault) row.append(element("span", "sys-tick", "✓"));
    row.onclick = () => { void this.chooseOutput(device.id); };
    return row;
  }

  private bluetoothRow(device: BluetoothDevice): HTMLElement {
    // Not a button: Windows exposes no supported way to connect or disconnect a
    // device from another process, so this is a readout and says so by never
    // looking clickable.
    const row = element("div", `sys-row static${device.connected ? " is-on" : ""}`);
    const mark = element("span", "sys-mark");
    paintIcon(mark, "bluetooth");
    row.append(mark, element("span", "sys-name", device.name));
    row.append(element("span", "sys-state", device.connected ? "on" : "off"));
    return row;
  }

  /** A labelled meter. Amber past 80%, red past 92% — a disk at 97% is the one
   *  fact on this screen that is actually urgent. */
  private meter(label: string, percent: number, note: string): HTMLElement {
    const row = element("div", "meter");
    const head = element("div", "meter-head");
    head.append(element("span", "meter-label", label), element("span", "meter-note", note));
    const rail = element("div", "meter-rail");
    const fill = element("i");
    fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    if (percent >= 92) fill.classList.add("hot");
    else if (percent >= 80) fill.classList.add("warm");
    rail.append(fill);
    row.append(head, rail);
    return row;
  }

  /** The day, as a stacked bar with the top few named. */

  render() {
    this.host.replaceChildren();
    if (!this.loaded) {
      this.host.append(element("p", "home-empty", "Reading the machine…"));
      return;
    }

    /* ── Sound and light ── */
    const controls = this.tile("Sound & light", "sys-controls");
    const caps = element("div", "cap-row");
    if (this.state.volume >= 0) {
      const cap = this.capsule("volume", "Volume", this.state.volume, level => this.setVolume(level));
      cap.classList.toggle("is-muted", this.state.muted);
      caps.append(cap);
    }
    if (this.state.brightness >= 0) {
      caps.append(this.capsule("sun", "Brightness", this.state.brightness, level => this.setBrightness(level)));
    }
    const pips = element("div", "pip-col");
    if (this.state.volume >= 0) {
      const mute = element("button", `pip${this.state.muted ? " is-on" : ""}`);
      (mute as HTMLButtonElement).type = "button";
      mute.setAttribute("aria-pressed", String(this.state.muted));
      mute.setAttribute("aria-label", this.state.muted ? "Unmute" : "Mute");
      mute.title = this.state.muted ? "Unmute" : "Mute";
      paintIcon(mute, this.state.muted ? "volumeOff" : "volume");
      mute.onclick = () => this.setVolume(this.state.volume, !this.state.muted);
      pips.append(mute);
    }
    const lock = element("button", "pip");
    (lock as HTMLButtonElement).type = "button";
    lock.setAttribute("aria-label", "Lock the session");
    lock.title = "Lock";
    paintIcon(lock, "lock");
    lock.onclick = () => { void call("lock_workstation").catch(e => { this.error = String(e); this.changed(); }); };
    pips.append(lock);
    caps.append(pips);
    controls.append(caps);
    if (this.state.brightness < 0) {
      // Said plainly rather than shown as a dead control: plenty of desktop
      // monitors simply refuse DDC/CI, and that is not a failure to report.
      controls.append(element("p", "tile-note", "No brightness over this cable"));
    }

    /* ── Output: what is in use, and the rest behind one press ── */
    const current = this.devices.find(d => d.isDefault);
    const output = this.summaryTile(
      "Output", "output",
      current ? [this.outputRow(current, true)] : [element("p", "home-empty", "No outputs found")],
      Math.max(0, this.devices.length - 1),
      () => this.devices.map(device => this.outputRow(device)),
    );

    /* ── Bluetooth, same shape ── */
    const connected = this.state.bluetooth.filter(d => d.connected);
    const bluetooth = this.summaryTile(
      "Bluetooth", "bluetooth",
      connected.length
        ? connected.slice(0, 2).map(device => this.bluetoothRow(device))
        : [element("p", "home-empty", "Nothing connected")],
      Math.max(0, this.state.bluetooth.length - Math.min(connected.length, 2)),
      () => this.state.bluetooth.map(device => this.bluetoothRow(device)),
    );

    /* ── The machine ── */
    const machine = this.tile("This PC", "sys-machine");
    const gb = (bytes: number) => `${(bytes / 1e9).toFixed(bytes < 1e10 ? 1 : 0)} GB`;
    if (this.machine.cpu >= 0) machine.append(this.meter("CPU", this.machine.cpu, `${this.machine.cpu}%`));
    if (this.machine.memory >= 0) machine.append(this.meter("Memory", this.machine.memory, `${this.machine.memory}%`));
    if (this.machine.diskUsed >= 0) {
      machine.append(this.meter("Disk", this.machine.diskUsed, `${gb(this.machine.diskFree)} free`));
    }
    const facts = element("div", "sys-facts");
    if (this.machine.network) {
      const net = element("span", "sys-fact");
      net.append(element("b", "", "●"), element("span", "", this.machine.network));
      facts.append(net);
    }
    if (this.machine.uptime) {
      // Days once there are any: "up 112h 00m" is arithmetic, "up 4d 16h" is
      // the thing you actually wanted to know.
      const hours = Math.floor(this.machine.uptime / 3600);
      const up = hours >= 48
        ? `${Math.floor(hours / 24)}d ${hours % 24}h`
        : spanText(this.machine.uptime);
      facts.append(element("span", "sys-fact", `up ${up}`));
    }
    if (facts.childElementCount) machine.append(facts);

    this.host.append(controls, output, bluetooth, machine);
    if (this.error) this.host.append(element("p", "screen-error", this.error));
  }
}
