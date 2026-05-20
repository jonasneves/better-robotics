// Direct-command intent matcher. Lets short imperative utterances
// ("drive forward", "stop", "turn left for 1 second") skip the LLM
// round-trip and dispatch the corresponding tool call immediately.
// Anything that doesn't match a pattern (or is too long, or contains a
// conjunction) falls through to the existing askWithTools flow.
//
// Pattern is mirrored from Mycroft / OpenVoiceOS: regex intent layer
// first, LLM fallback for everything else. Works identically for typed
// input and dictated input since it sits in onSubmit, not in
// voice-input.js — speech is just one way to produce text.

const SPEED = 40;        // firmware caps to ±40 anyway; saturating is fine
const PULSE_MS = 500;    // default drive duration
const TURN_MS  = 300;    // tighter for in-place turns
const SPIN_MS  = 1000;   // longer for sustained spins

// Pull "for N seconds" / "N seconds" / "N ms" out of the utterance. The
// firmware clamps to [50, 2000] ms anyway, but we mirror that here so
// the pill's reported duration matches what'll actually run.
function parseDuration(s, fallback) {
  const sec = s.match(/(?:for\s+)?(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)\b/i);
  if (sec) return clampDur(Math.round(parseFloat(sec[1]) * 1000));
  const ms = s.match(/(\d+)\s*(?:ms|milliseconds?)\b/i);
  if (ms) return clampDur(parseInt(ms[1], 10));
  return fallback;
}
function clampDur(ms) { return Math.min(2000, Math.max(50, ms)); }

const PATTERNS = [
  {
    name: "drive_forward",
    rx: /^(?:drive|go|move|head)\s+(?:forward|fwd|ahead|straight)\b/i,
    build: (t) => ({ l:  SPEED, r:  SPEED, duration_ms: parseDuration(t, PULSE_MS) }),
  },
  {
    name: "drive_backward",
    rx: /^(?:drive|go|move|reverse)\s+(?:back(?:ward)?|reverse)\b/i,
    build: (t) => ({ l: -SPEED, r: -SPEED, duration_ms: parseDuration(t, PULSE_MS) }),
  },
  {
    name: "turn_left",
    rx: /^(?:turn|rotate|go|veer)\s+left\b/i,
    build: (t) => ({ l: -SPEED, r:  SPEED, duration_ms: parseDuration(t, TURN_MS) }),
  },
  {
    name: "turn_right",
    rx: /^(?:turn|rotate|go|veer)\s+right\b/i,
    build: (t) => ({ l:  SPEED, r: -SPEED, duration_ms: parseDuration(t, TURN_MS) }),
  },
  {
    name: "spin_left",
    rx: /^spin\s+left\b/i,
    build: (t) => ({ l: -SPEED, r:  SPEED, duration_ms: parseDuration(t, SPIN_MS) }),
  },
  {
    name: "spin_right",
    rx: /^spin\s+right\b/i,
    build: (t) => ({ l:  SPEED, r: -SPEED, duration_ms: parseDuration(t, SPIN_MS) }),
  },
  {
    name: "stop",
    // Bare "stop" / "halt" / "brake" / "freeze" — exact match, no trailing words.
    rx: /^(?:stop|halt|brake|freeze)[.!]?\s*$/i,
    build: () => ({ l: 0, r: 0, duration_ms: 50 }),
  },
];

// Conjunctions or question-words → likely conversational, route to Claude.
const SKIP_RX = /\b(?:and|then|but|while|after|because|why|how|what|when|where|if|please|could|would|should)\b/i;
const MAX_WORDS = 8;

// Intents that should fire INSTANTLY (on the first final-chunk match,
// before the silence-commit timer) and also interrupt any running
// agent loop. Tesla "cancel", Spot tablet "stop" — the safety-override
// pattern. Keep the set conservative: false positives here cancel
// long-running work, so only verbs whose meaning is unambiguous.
export const SAFETY_INTENTS = new Set(["stop"]);

// After a verb-pattern matches, drop the matched prefix + any optional
// duration phrase ("for 1 second", "300ms") and see whether anything
// else is left. If yes, the user wasn't issuing a bare verb — they were
// saying a natural-language sentence that happens to start with one
// ("turn left to the kitchen", "go forward toward the book") — and we
// should route to Claude, not direct-dispatch a brief pulse and silently
// drop the rest. Without this check, the matchers fire on partial
// matches and the planner never sees the utterance.
const DURATION_SUFFIX_RX = /(?:^|\s)(?:for\s+)?\d+(?:\.\d+)?\s*(?:s|sec|seconds?|ms|milliseconds?)\b/i;

export function tryMatchCommand(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;
  if (trimmed.split(/\s+/).length > MAX_WORDS) return null;
  if (SKIP_RX.test(trimmed)) return null;
  for (const p of PATTERNS) {
    const m = p.rx.exec(trimmed);
    if (!m) continue;
    const after = trimmed.slice(m[0].length)
      .replace(DURATION_SUFFIX_RX, "")
      .replace(/[.!?,;\s]+$/, "")
      .trim();
    if (after.length > 0) return null;
    return {
      intent: p.name,
      tool: "move_motor",
      partialInput: p.build(trimmed),
    };
  }
  return null;
}
