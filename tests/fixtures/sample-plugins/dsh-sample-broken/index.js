export default class SampleBroken {
  static name = "dsh-sample-broken";
  ping() {
    return "broken-should-not-run";
  }
}
