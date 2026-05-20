// Tests for the verb matcher in public/voice-commands.js.
// Regression coverage for the partial-match misfire bug: utterances
// like "turn left to the kitchen" used to silently dispatch a brief
// turn-left pulse and never reach the LLM. The matcher now requires
// the whole utterance to be a bare verb (optionally followed by a
// duration phrase) — anything else falls through.

import { test } from "node:test";
import assert from "node:assert";
import { tryMatchCommand } from "../public/voice-commands.js";

test("matches bare verbs", () => {
  assert.equal(tryMatchCommand("turn left")?.intent,   "turn_left");
  assert.equal(tryMatchCommand("turn right")?.intent,  "turn_right");
  assert.equal(tryMatchCommand("drive forward")?.intent, "drive_forward");
  assert.equal(tryMatchCommand("go backward")?.intent, "drive_backward");
  assert.equal(tryMatchCommand("spin left")?.intent,   "spin_left");
  assert.equal(tryMatchCommand("stop")?.intent,        "stop");
  assert.equal(tryMatchCommand("halt")?.intent,        "stop");
});

test("matches verb + duration suffix", () => {
  assert.equal(tryMatchCommand("turn left for 2 seconds")?.intent, "turn_left");
  assert.equal(tryMatchCommand("drive forward 500ms")?.intent,    "drive_forward");
  assert.equal(tryMatchCommand("spin right for 1.5s")?.intent,    "spin_right");
});

test("falls through to LLM on natural-language sentences containing a verb", () => {
  // The bug: these used to silently dispatch a brief direct turn and
  // the LLM never saw them.
  assert.equal(tryMatchCommand("turn left to the kitchen"),       null);
  assert.equal(tryMatchCommand("turn around towards the yellow book"), null);
  assert.equal(tryMatchCommand("go forward and then turn left"),  null);
  assert.equal(tryMatchCommand("drive forward toward the chair"), null);
  assert.equal(tryMatchCommand("turn right then stop"),           null);
});

test("returns null on empty / over-long / conjunction utterances", () => {
  assert.equal(tryMatchCommand(""),                                null);
  assert.equal(tryMatchCommand("   "),                             null);
  // Over MAX_WORDS — falls through to LLM regardless of pattern shape.
  assert.equal(tryMatchCommand("turn left one two three four five six seven"), null);
  // SKIP_RX hits — "please" / "could" / "would" routes to LLM even for
  // verb-shaped utterances, so the planner can read the politeness.
  assert.equal(tryMatchCommand("could you turn left"), null);
});
