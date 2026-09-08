// Shared integrated spring; parameters come from the original usage notch.
export class Spring {
  value: number;
  private velocity = 0;
  private target: number;
  private readonly omega: number;
  private readonly zeta: number;

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

  snap(value: number) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
  }
}

