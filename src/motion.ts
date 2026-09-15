// Shared integrated spring; parameters come from the original usage notch.
export class Spring {
  value: number;
  private velocity = 0;
  private target: number;
  private omega: number;
  private zeta: number;

  constructor(value: number, response: number, damping: number) {
    this.value = value;
    this.target = value;
    this.omega = (2 * Math.PI) / response;
    this.zeta = damping;
  }

  setTarget(target: number) {
    this.target = target;
  }

  get settled(): boolean {
    return (
      Math.abs(this.value - this.target) < 0.01 && Math.abs(this.velocity) < 0.01
    );
  }

  step(dt: number) {
    // Semi-implicit Euler, sub-stepped so a dropped frame cannot blow it up.
    const steps = Math.max(1, Math.ceil(dt / 0.008));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const accel =
        -this.omega * this.omega * (this.value - this.target) -
        2 * this.zeta * this.omega * this.velocity;
      this.velocity += accel * h;
      this.value += this.velocity * h;
    }
  }

  /** Change the shape of the spring without moving it.
   *
   * ⚠️ Velocity is KEPT. This is called mid-flight — a panel that is already
   * travelling is told the reason it is travelling has changed — and zeroing
   * the velocity there would stop it dead and start again, which is the one
   * thing a spring is supposed to make impossible. */
  retune(response: number, damping: number) {
    this.omega = (2 * Math.PI) / response;
    this.zeta = damping;
  }

  snap(value: number) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
  }
}

