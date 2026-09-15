export default class SampleRelay {
  static name = "dsh-sample-relay";
  constructor(ctx) {
    this.kind = "relay";
    ctx?.provide?.("sample-relay", this);
  }
  ping() {
    return "relay-ok";
  }
  hop(from, to) {
    return `${from}->${to}`;
  }
}
