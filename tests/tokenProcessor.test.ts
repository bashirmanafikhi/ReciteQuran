// tests/tokenProcessor.test.ts — port verification for the AsrTokenProcessor class
// in lib/tracking/word/highlighting_controller.dart:46-179 (read-only source of truth),
// plus the per-char duration expansion at highlighting_controller.dart:612-619
// (ledger ruling: per-char path, NOT the legacy token-level path in recite_quran.dart:188-194).
import { copyWithConfig, normalConfig } from '../src/config';
import { AsrTokenProcessor, expandCharDurations } from '../src/engine/tokenProcessor';
import { ProcessedAudioStream, TranscriptionResult } from '../src/types';

/** Minimal TranscriptionResult — only tokens/timestamps are read by the processor. */
function tx(tokens: string[], timestamps: number[]): TranscriptionResult {
  return {
    text: tokens.join(''),
    isFinal: false,
    startTime: 0,
    tokens,
    timestamps,
    streamEpoch: 0,
  };
}

/** Float assertions: Dart doubles vs IEEE-754 JS arithmetic differ in the ~1e-16 tail. */
function expectClose(actual: number[], expected: number[]): void {
  expect(actual).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i]).toBeCloseTo(expected[i], 9);
  }
}

describe('AsrTokenProcessor', () => {
  test('exposes lookaheadDelay and maxTokenDuration from TrackerConfig', () => {
    const p = new AsrTokenProcessor();
    expect(p.lookaheadDelay).toBeCloseTo(0.320, 9);
    expect(p.maxTokenDuration).toBeCloseTo(2.5, 9);

    const custom = new AsrTokenProcessor(
      copyWithConfig(normalConfig(), { lookaheadDelay: 0.5, maxTokenDurationAllowed: 1.0 }),
    );
    expect(custom.lookaheadDelay).toBeCloseTo(0.5, 9);
    expect(custom.maxTokenDuration).toBeCloseTo(1.0, 9);
  });

  // ── (a) blank tokens dropped + token→stream mapping ────────────────────────

  test('drops blank tokens (\'\', <blank>, <blk>, <eps>, eps) and maps the rest in order', () => {
    const p = new AsrTokenProcessor();
    const s = p.process(
      tx(
        ['a', '', 'b', '<blank>', '<blk>', '<eps>', 'eps', 'c'],
        [0.5, 0.6, 0.9, 1.0, 1.1, 1.2, 1.3, 1.7],
      ),
    );

    expect(s.tokens).toEqual(['a', 'b', 'c']);
    expect(s.tokens.join('')).toBe('abc');
    expect(s.tokens).toHaveLength(s.durations.length);
    // Hand-derived vs highlighting_controller.dart:99-172 with lookaheadDelay 0.320:
    // a: 0.18 spike, fallback 0.15 backward, blank-clamped forward 0.10 → 0.15
    // b: 0.58 spike, lastBlank 0.28 → backward 0.30, forward (blank 0.98) 0.40 → 0.40
    // c: 1.38 spike, lastBlank 0.98 → backward 0.40 → 0.40
    expectClose(s.durations, [0.15, 0.40, 0.40]);
  });

  test('remembers lastBlankTs (starts at -1, updated by blanks) for interval origins', () => {
    const p = new AsrTokenProcessor();
    // No blank → lastBlankTs stays -1, never raises a spike origin.
    // a: 0.15 (fallback), b: forward-a 1.00 / backward-b 1.00.
    const noBlank = p.process(tx(['a', 'b'], [1.0, 2.0]));
    expectClose(noBlank.durations, [1.0, 1.0]);
    p.reset();

    // Leading blanks: last realTs 2.18 > fallback origin 2.13 → first spike restarts
    // at the blank: 2.28 - 2.18 = 0.10 (0.15 if lastBlankTs were not remembered).
    const blanksFirst = p.process(tx(['<blank>', '', 'a'], [2.0, 2.5, 2.6]));
    expect(blanksFirst.tokens).toEqual(['a']);
    expectClose(blanksFirst.durations, [0.10]);
  });

  // ── (b) lookaheadDelay subtracted and clamped ≥ 0 ─────────────────────────

  test('subtracts lookaheadDelay from raw timestamps and clamps realTs at zero', () => {
    const delayed = new AsrTokenProcessor(); // lookaheadDelay 0.320
    expect(delayed.lookaheadDelay).toBeCloseTo(0.320, 9);

    // a: raw 0.2 → realTs max(0, 0.2-0.32)=0 (clamped); b: raw 1.0 → 0.68.
    // Without the clamp spikes[0] would be -0.12 and both durations would be 0.80.
    const s1 = delayed.process(tx(['a', 'b'], [0.2, 1.0]));
    expectClose(s1.durations, [0.68, 0.68]);

    // Same raw input with delay 0: a=0.2 (backward 0.05→fallback 0.15), gap 0.8.
    const immediate = new AsrTokenProcessor(
      copyWithConfig(normalConfig(), { lookaheadDelay: 0 }),
    );
    const s2 = immediate.process(tx(['a', 'b'], [0.2, 1.0]));
    expectClose(s2.durations, [0.8, 0.8]);
  });

  // ── (c) duration clamps: floor 0.04, ceiling config.maxTokenDurationAllowed ─

  test('clamps every duration to at least 0.04', () => {
    const p = new AsrTokenProcessor();
    // Identical spikes → zero intervals → floor applies (b) and retroactive forward (a).
    const s = p.process(tx(['a', 'b'], [1.0, 1.0]));
    expectClose(s.durations, [0.15, 0.04]);
  });

  test('clamps every duration to config.maxTokenDurationAllowed', () => {
    const p = new AsrTokenProcessor();
    // Gap 4.0s > default ceiling 2.5 → both intervals capped at 2.5.
    const s = p.process(tx(['a', 'b'], [1.0, 5.0]));
    expectClose(s.durations, [2.5, 2.5]);
    p.reset();

    const capped = new AsrTokenProcessor(
      copyWithConfig(normalConfig(), { maxTokenDurationAllowed: 0.5 }),
    );
    const s2 = capped.process(tx(['a', 'b'], [1.0, 5.0]));
    expectClose(s2.durations, [0.5, 0.5]);
  });

  // ── (d) max(backward, forward) attribution ────────────────────────────────

  test('first token uses curSpike - 0.15 fallback as its backward origin', () => {
    const p = new AsrTokenProcessor();
    // realTs 0.68 → prevSpikeTime = 0.68-0.15 = 0.53 → backward 0.15.
    // (Without the 0.15 fallback, prevSpikeTime 0 would yield 0.68.)
    const s = p.process(tx(['a'], [1.0]));
    expect(s.tokens).toEqual(['a']);
    expectClose(s.durations, [0.15]);
  });

  test('takes max(backward, forward) per token, updating the previous token forward', () => {
    const p = new AsrTokenProcessor();
    // spikes: a=0.68, b=0.80, c=1.68
    // a: backward 0.15 (fallback) vs forward 0.12 → 0.15 (backward wins)
    // b: backward 0.12, then retroactive forward 0.88 → 0.88 (forward wins)
    // c: backward 0.88
    const s = p.process(tx(['a', 'b', 'c'], [1.0, 1.12, 2.0]));
    expect(s.tokens).toEqual(['a', 'b', 'c']);
    expectClose(s.durations, [0.15, 0.88, 0.88]);
  });

  test('clamps the forward interval at an intervening blank', () => {
    const p = new AsrTokenProcessor();
    // spikes: a=0.68, blank=0.78, b=1.68.
    // a's forward would be 1.68-0.68=1.00 without the blank → 0.78-0.68=0.10 with it,
    // so a keeps its backward 0.15. b restarts at the blank: 1.68-0.78=0.90.
    const s = p.process(tx(['a', '', 'b'], [1.0, 1.1, 2.0]));
    expect(s.tokens).toEqual(['a', 'b']);
    expectClose(s.durations, [0.15, 0.90]);
  });

  // ── (e) cumulative results: growing prefix → suffix deltas only ───────────

  test('growing prefix processes only the new suffix (deltas only)', () => {
    const p = new AsrTokenProcessor();
    const first = p.process(tx(['a', 'b'], [1.0, 1.5]));
    expect(first.tokens).toEqual(['a', 'b']);
    expectClose(first.durations, [0.5, 0.5]);

    // Same prefix + one new token → only 'c' is consumed; a/b durations stay put.
    const second = p.process(tx(['a', 'b', 'c'], [1.0, 1.5, 2.0]));
    expect(second.tokens).toEqual(['a', 'b', 'c']);
    expectClose(second.durations, [0.5, 0.5, 0.5]);

    // Dart passes the live internal Lists into ProcessedAudioStream (no copy):
    // the earlier stream sees the appended entries too.
    expect(first.tokens).toHaveLength(3);
    expect(first.durations).toHaveLength(3);
  });

  test('identical result (full common prefix) returns without duplicating tokens', () => {
    const p = new AsrTokenProcessor();
    p.process(tx(['a', 'b'], [1.0, 1.5]));
    const again = p.process(tx(['a', 'b'], [1.0, 1.5]));
    expect(again.tokens).toEqual(['a', 'b']);
    expectClose(again.durations, [0.5, 0.5]);

    const third = p.process(tx(['a', 'b'], [1.0, 1.5]));
    expect(third.tokens).toHaveLength(2);
    expect(third.durations).toHaveLength(2);
  });

  // ── (f) prefix shrink → full reset ────────────────────────────────────────

  test('prefix shrink resets all state and rebuilds from scratch', () => {
    const p = new AsrTokenProcessor();
    const first = p.process(tx(['a', 'b', 'c'], [1.0, 1.5, 2.0]));
    expect(first.tokens).toEqual(['a', 'b', 'c']);

    // 'b' ≠ 'x' at index 1 → common prefix shrinks → full reset (dart:83-86).
    const shrunk = p.process(tx(['a', 'x'], [1.0, 1.5]));
    expect(shrunk.tokens).toEqual(['a', 'x']);
    expectClose(shrunk.durations, [0.5, 0.5]);
    expect(shrunk.tokens).not.toContain('b');
    expect(shrunk.tokens).not.toContain('c');
  });

  test('reset() clears tokens, durations and raw prefix', () => {
    const p = new AsrTokenProcessor();
    p.process(tx(['a', 'b'], [1.0, 1.5]));
    p.reset();

    const afterReset = p.process(tx([], []));
    expect(afterReset.tokens).toEqual([]);
    expect(afterReset.durations).toEqual([]);

    // Raw prefix was cleared too → the old result is fully reprocessed.
    const fresh = p.process(tx(['a', 'b'], [1.0, 1.5]));
    expect(fresh.tokens).toEqual(['a', 'b']);
    expectClose(fresh.durations, [0.5, 0.5]);
  });

  // ── token/timestamp array length mismatch ─────────────────────────────────

  test('consumes only min(tokens.length, timestamps.length) entries', () => {
    const p = new AsrTokenProcessor();
    const fewerTs = p.process(tx(['a', 'b', 'c'], [1.0]));
    expect(fewerTs.tokens).toEqual(['a']);
    expectClose(fewerTs.durations, [0.15]);
    p.reset();

    const fewerTokens = p.process(tx(['a'], [1.0, 2.0]));
    expect(fewerTokens.tokens).toEqual(['a']);
    expectClose(fewerTokens.durations, [0.15]);
  });
});

describe('expandCharDurations (highlighting_controller.dart:612-619)', () => {
  const stream = (tokens: string[], durations: number[]): ProcessedAudioStream => ({
    tokens,
    durations,
  });

  test('splits each token duration across its UTF-16 code units', () => {
    // dur / max(1, token.length) repeated token.length times.
    const chars = expandCharDurations(stream(['ab', 'c'], [0.5, 0.2]));
    expectClose(chars, [0.25, 0.25, 0.2]);
  });

  test('empty tokens contribute no characters (loop runs 0 times)', () => {
    const chars = expandCharDurations(stream(['ab', '', 'c'], [0.5, 0.9, 0.2]));
    expectClose(chars, [0.25, 0.25, 0.2]);
  });

  test('uses UTF-16 code-unit length (surrogate pairs count as 2), matching Dart String.length', () => {
    const chars = expandCharDurations(stream(['🙂'], [1.0]));
    expect(chars).toHaveLength(2);
    expectClose(chars, [0.5, 0.5]);
  });

  test('conserves total duration across non-empty tokens', () => {
    const input = stream(['اَ', 'ببب', 'س'], [0.4, 0.9, 0.2]);
    const chars = expandCharDurations(input);
    const total = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
    expect(chars).toHaveLength(2 + 3 + 1);
    expect(total(chars)).toBeCloseTo(total(input.durations), 9);
  });

  test('expands the processor output end-to-end', () => {
    const p = new AsrTokenProcessor();
    const s = p.process(tx(['a', 'bb'], [1.0, 1.5]));
    const chars = expandCharDurations(s);
    expect(chars).toHaveLength(3);
    expectClose(chars, [0.5, 0.25, 0.25]);
  });
});
