export default class SampleSketch {
  static name = "dsh-sample-sketch";
  constructor(ctx) {
    this.kind = "sketch";
    ctx?.provide?.("sample-sketch", this);
  }
  ping() {
    return "sketch-ok";
  }
  canvas() {
    return { width: 320, height: 240 };
  }
}
