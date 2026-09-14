/** Host half: never finish apply(), keep the event loop, exit on cooperative stop. */
export const name = "dsh-spaces-hang-fixture";

function stopHang() {
  try {
    process.exit(0);
  } catch {
    /* already exiting */
  }
}

export function apply() {
  process.on("SIGTERM", stopHang);
  process.on("message", (message) => {
    if (message && message.type === "dsh-spaces:stop") stopHang();
  });
  return new Promise(() => {});
}
