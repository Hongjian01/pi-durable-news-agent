// Deterministic process faults are only available with the explicit faux
// provider; production code never enables them through a model/tool argument.
export function faultPoint(provider: string, point: string) {
  if (provider === "faux" && process.env.DNA_TEST_CRASH_POINT === point)
    process.kill(process.pid, "SIGKILL");
}
