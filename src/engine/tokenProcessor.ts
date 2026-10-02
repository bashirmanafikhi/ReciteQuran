// src/engine/tokenProcessor.ts
// Line-by-line transliteration of the AsrTokenProcessor class in
// lib/tracking/word/highlighting_controller.dart:46-179 (read-only source of truth),
// plus the per-char duration expansion at highlighting_controller.dart:612-619.
// TrackerConfig, TranscriptionResult and ProcessedAudioStream are imported — never redeclared.
// Dart String.length / List indexing map to UTF-16 code units (no code-point scanning).

import { normalConfig, TrackerConfig } from '../config';
import { ProcessedAudioStream, TranscriptionResult } from '../types';

// ═══════════════════════════════════════════════════════════════════════════════
// ASR ACOUSTIC TOKEN PROCESSOR
// ═══════════════════════════════════════════════════════════════════════════════

export class AsrTokenProcessor {
  config: TrackerConfig;

  constructor(config: TrackerConfig = normalConfig()) {
    this.config = config;
  }

  get lookaheadDelay(): number {
    return this.config.lookaheadDelay;
  }

  get maxTokenDuration(): number {
    return this.config.maxTokenDurationAllowed;
  }

  private _lastRawTokens: string[] = [];

  private readonly _filteredTokens: string[] = [];
  private readonly _filteredSpikeTimes: number[] = [];
  private readonly _filteredLastBlanks: number[] = [];

  private readonly _tokenDurations: number[] = [];

  reset(): void {
    this._lastRawTokens.length = 0;
    this._filteredTokens.length = 0;
    this._filteredSpikeTimes.length = 0;
    this._filteredLastBlanks.length = 0;
    this._tokenDurations.length = 0;
  }

  process(result: TranscriptionResult): ProcessedAudioStream {
    const maxCount = Math.min(result.tokens.length, result.timestamps.length);

    let commonLen = 0;
    const minLen = Math.min(this._lastRawTokens.length, maxCount);
    for (let i = 0; i < minLen; i++) {
      if (this._lastRawTokens[i] === result.tokens[i]) {
        commonLen++;
      } else {
        break;
      }
    }

    if (commonLen < this._lastRawTokens.length) {
      this.reset();
      commonLen = 0;
    }

    this._lastRawTokens = result.tokens.slice(0, maxCount);

    if (commonLen === maxCount) {
      return {
        tokens: this._filteredTokens,
        durations: this._tokenDurations,
      };
    }

    let lastBlankTs =
      this._filteredLastBlanks.length > 0
        ? this._filteredLastBlanks[this._filteredLastBlanks.length - 1]
        : -1.0;

    for (let i = commonLen; i < maxCount; i++) {
      const tok = result.tokens[i];
      const realTs = Math.max(0.0, result.timestamps[i] - this.lookaheadDelay);

      if (
        tok.length === 0 ||
        tok === '<blank>' ||
        tok === '<blk>' ||
        tok === '<eps>' ||
        tok === 'eps'
      ) {
        lastBlankTs = realTs;
        continue;
      }

      this._filteredTokens.push(tok);
      this._filteredSpikeTimes.push(realTs);
      this._filteredLastBlanks.push(lastBlankTs);

      const fIdx = this._filteredTokens.length - 1;
      const curSpike = this._filteredSpikeTimes[fIdx];
      const lastBlankBefore = this._filteredLastBlanks[fIdx];

      // ── Max(Backward, Forward) Duration Attribution ──
      //
      // CTC spikes mark peak posterior probability, NOT sound onset.
      // The backward interval (prev_spike → cur_spike) partially
      // overlaps with BOTH the previous token's tail AND the current
      // token's onset delay. Neither interval alone captures a token's
      // full acoustic duration:
      //
      //  - Short Madds (2 Harakat): backward interval is larger because
      //    it captures the onset delay before the CTC spike fired.
      //  - Long Madds (4-6 Harakat): forward interval is larger because
      //    the vowel is held long after the spike until the next sound.
      //
      // Using max(backward, forward) per token provides a robust
      // estimate: whichever interval captured more of the token's
      // actual acoustic time wins.

      // 1. Retroactively update PREVIOUS token with its forward interval.
      //    The previous token's duration becomes max(backward, forward).
      if (fIdx > 0) {
        const prevIdx = fIdx - 1;
        const prevSpike = this._filteredSpikeTimes[prevIdx];

        // If a blank (silence) occurred between spikes, the previous
        // token's voicing ended at the blank, not at the current spike.
        let prevEnd = curSpike;
        if (lastBlankBefore > prevSpike && lastBlankBefore < curSpike) {
          prevEnd = lastBlankBefore;
        }

        const forwardInterval = Math.min(
          this.maxTokenDuration,
          Math.max(0.04, prevEnd - prevSpike),
        );

        // max(backward already stored, forward just computed)
        this._tokenDurations[prevIdx] = Math.max(
          this._tokenDurations[prevIdx],
          forwardInterval,
        );
      }

      // 2. Current token: backward interval as initial estimate.
      //    Will be max'd with its forward interval when the next
      //    token arrives (step 1 above on the next iteration).
      let prevSpikeTime =
        fIdx === 0
          ? Math.max(0.0, curSpike - 0.15)
          : this._filteredSpikeTimes[fIdx - 1];

      if (lastBlankBefore > prevSpikeTime) {
        prevSpikeTime = lastBlankBefore;
      }

      const backwardInterval = Math.min(
        this.maxTokenDuration,
        Math.max(0.04, curSpike - prevSpikeTime),
      );
      this._tokenDurations.push(backwardInterval);
    }

    return {
      tokens: this._filteredTokens,
      durations: this._tokenDurations,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PER-CHARACTER DURATION EXPANSION
// (highlighting_controller.dart:612-619 — the path the example app actually used;
//  the token-level path in recite_quran.dart:188-194 is the legacy outlier and
//  is deliberately NOT ported, per the SDD ledger ruling.)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Expands per-token durations into per-UTF-16-code-unit durations before
 * `syncStream`: each token contributes `duration / max(1, token.length)`
 * exactly `token.length` times (empty tokens contribute nothing).
 */
export function expandCharDurations(stream: ProcessedAudioStream): number[] {
  const charDurations: number[] = [];
  for (let i = 0; i < stream.tokens.length; i++) {
    const tok = stream.tokens[i];
    const dur = stream.durations[i] / Math.max(1, tok.length);
    for (let c = 0; c < tok.length; c++) {
      charDurations.push(dur);
    }
  }
  return charDurations;
}
