import { Clock, Layer } from "effect";
import { JscpdClock } from "./services.js";

/** Live scheduling clock; tests replace this layer without patching global timers. */
export const jscpdClockLive: JscpdClock = Object.freeze({
  now: Clock.currentTimeMillis,
  sleep: (milliseconds: number) => Clock.sleep(milliseconds),
});

export const JscpdClockLive = Layer.succeed(JscpdClock, jscpdClockLive);
