export default class SampleNotes {
  static name = "dsh-sample-notes";
  constructor(ctx) {
    this.kind = "notes";
    ctx?.provide?.("sample-notes", this);
  }
  ping() {
    return "notes-ok";
  }
  list() {
    return ["inbox", "scratch"];
  }
}
