export default class SampleCrash {
  static name = "dsh-sample-crash";
  constructor() {
    throw new Error("dsh-sample-crash exploded during start");
  }
}
