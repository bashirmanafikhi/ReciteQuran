// src/engine/sequencer.ts
// Line-by-line transliteration of lib/tracking/word/dictation_sequencer.dart (455 lines).
// Dart sources are the read-only source of truth; nothing under lib/ is modified.
// charCodeAt/UTF-16 code units match Dart String.codeUnitAt for all BMP Quranic glyphs.
// TrackerConfig, shared types and matchWord/WordMatchResult are imported — never redeclared.

import { normalConfig, TrackerConfig } from '../config';
import { evaluatePreAlignedWords } from '../tajweed/errorExplainer';
import { ReciterErrorMap, WordTajweedRule } from '../types';
import { matchWord, PhoneticCostEngine, WordMatchResult } from './matcher';

// ═══════════════════════════════════════════════════════════════════════════════
// Forward Dictation Sequencer (Direct Continuous String Matching)
//
// Per-word sequential matching with anchored consumption:
// 1. Slice the continuous ASR string at the character anchor.
// 2. Try matching the current word. If GREEN → commit, advance anchor & cursor.
// 3. If current word fails, try skip+1 and skip+2 (omission detection).
// 4. If nothing matches → stay NEUTRAL, wait for more text.
// 5. Loop: after each commit, immediately try the next word.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Event union emitted by the sequencer — the serialized isolate protocol
 * (phoneme_alignment_isolate_protocol.dart:194-268) as a discriminated union:
 * `highlight` = WordMatchedEvent.toMap(), `debug` = DebugLogEvent.toMap().
 */
export type SequencerEvent =
  | {
      type: 'highlight';
      wordId: number;
      score: number;
      cleanAsr: string;
      tajweedErrors: ReciterErrorMap[] | null;
      isRed: boolean;
      isNeutral: boolean;
    }
  | { type: 'debug'; message: string; asrBuffer: string };

/** SetSurahReferenceCommand (phoneme_alignment_isolate_protocol.dart:86-118). */
export interface SetSurahReferenceCmd {
  phonemes: string;
  boundaries: number[];
  surahNumber: number;
  isTajweed: boolean;
  forceClear: boolean;
  startGlobalWord: number;
  wordRules: WordTajweedRule[][] | null;
}

/** SyncStreamCommand (phoneme_alignment_isolate_protocol.dart:120-141). */
export interface SyncStreamCmd {
  text: string;
  timestamps: number[];
  isNewSegment: boolean;
  ayahNumber: number;
}

/** Dart `int.clamp(lower, upper)` (dictation_sequencer.dart:91, :104). */
function clamp(value: number, lower: number, upper: number): number {
  return Math.min(Math.max(value, lower), upper);
}

export class DictationSequencer {
  readonly onEvent: (e: SequencerEvent) => void;

  // ── Reference ──
  wordBoundaries: number[] = [];
  fullPhonemes = '';
  isTajweed = false;
  currentSurahNumber = 0;
  surahWordRules: WordTajweedRule[][] | null = null;

  // ── ASR Stream ──
  readonly currentSegmentAsrText = '';
  currentSegmentTimestamps: number[] = [];
  asrCharAnchor = 0;
  private trimmedOffset = 0;
  private pendingTail: string | null = null;

  // ── Tracking ──
  targetWordCursor = 0;
  readonly committedGreenWords = new Set<number>();
  readonly committedRedWords = new Set<number>();
  lastMatchedPhoneme: string | null = null;

  // =========================================================================
  // [EARLY MATCHING / FAST WORD COMMITTING - TAJWEED OFF]
  // -------------------------------------------------------------------------
  // Governed dynamically by `config.enableEarlyMatching`.
  // - When FALSE: All early matching, tail reservation, and shield logic are
  //   completely skipped. Sequencer behaves 100% identically to baseline.
  // - When TRUE:  Shield holds upcoming words while trailing Madd/vowels decay.
  // =========================================================================
  config: TrackerConfig = normalConfig();

  constructor(onEvent: (e: SequencerEvent) => void) {
    this.onEvent = onEvent;
  }

  /** Updates the tracking configuration dynamically at runtime. (dictation_sequencer.dart:56-58) */
  updateConfig(newConfig: TrackerConfig): void {
    this.config = newConfig;
  }

  private get wordCount(): number {
    return Math.max(0, this.wordBoundaries.length - 1);
  }

  debugLog(message: string): void {
    const buf =
      this.asrCharAnchor < this.currentSegmentAsrText.length
        ? this.currentSegmentAsrText.substring(this.asrCharAnchor)
        : '';
    this.onEvent({ type: 'debug', message, asrBuffer: buf });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Public API (called from Isolate message handler)
  // ─────────────────────────────────────────────────────────────────────────────

  setSurahReference(cmd: SetSurahReferenceCmd): void {
    this.currentSurahNumber = cmd.surahNumber;
    this.fullPhonemes = cmd.phonemes.replace(/ /g, '');
    this.wordBoundaries = cmd.boundaries;
    this.isTajweed = cmd.isTajweed;
    this.surahWordRules = cmd.wordRules;

    this.committedGreenWords.clear();
    this.committedRedWords.clear();
    this.asrCharAnchor = 0;
    this.trimmedOffset = 0;
    this.pendingTail = null;

    if (cmd.forceClear) {
      (this as { currentSegmentAsrText: string }).currentSegmentAsrText = '';
      this.currentSegmentTimestamps = [];
    }

    this.targetWordCursor = clamp(cmd.startGlobalWord, 0, this.wordCount);
    this.lastMatchedPhoneme = null;

    this.debugLog(
      `📖 Surah ${this.currentSurahNumber} | ${this.wordCount} words | cursor=${this.targetWordCursor} | tajweed=${this.isTajweed}`,
    );

    if (!cmd.forceClear && this.currentSegmentAsrText.length > 0) {
      this.processSequence();
    }
  }

  jumpToWord(globalWordIndex: number): void {
    this.targetWordCursor = clamp(globalWordIndex, 0, this.wordCount);
    (this as { currentSegmentAsrText: string }).currentSegmentAsrText = '';
    this.currentSegmentTimestamps = [];
    this.asrCharAnchor = 0;
    this.trimmedOffset = 0;
    this.pendingTail = null;
    this.lastMatchedPhoneme = null;
    for (const w of [...this.committedGreenWords]) {
      if (w >= this.targetWordCursor) this.committedGreenWords.delete(w);
    }
    for (const w of [...this.committedRedWords]) {
      if (w >= this.targetWordCursor) this.committedRedWords.delete(w);
    }
    this.debugLog(`🎯 Jumped to word ${this.targetWordCursor}`);
  }

  syncStream(cmd: SyncStreamCmd): void {
    if (cmd.isNewSegment || cmd.text.length < this.trimmedOffset) {
      (this as { currentSegmentAsrText: string }).currentSegmentAsrText = '';
      this.currentSegmentTimestamps = [];
      this.asrCharAnchor = 0;
      this.trimmedOffset = 0;
      this.pendingTail = null;
      this.debugLog('🔄 New segment');
    }
    (this as { currentSegmentAsrText: string }).currentSegmentAsrText = cmd.text.substring(
      this.trimmedOffset,
    );
    const tsStart = Math.min(this.trimmedOffset, cmd.timestamps.length);
    this.currentSegmentTimestamps = cmd.timestamps.slice(tsStart);
    this.processSequence();
  }

  /** SetTajweedModeCommand handler (phoneme_alignment_isolate_io.dart:43-44). */
  setTajweedMode(isTajweed: boolean): void {
    this.isTajweed = isTajweed;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Core Tracking Loop
  // ─────────────────────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────────────────────
  // [EARLY MATCHING - TAIL DRAIN HELPER: START]
  // Absorbs prolonged Madd vowels or unuttered trailing letters of an early-committed
  // word. If reciter moves on to next word (non-tail phoneme), lifts immediately.
  // (dictation_sequencer.dart:140-167)
  // ─────────────────────────────────────────────────────────────────────────────
  private drainPendingTail(): void {
    if (!this.config.enableEarlyMatching) {
      this.pendingTail = null;
      return;
    }
    if (this.pendingTail === null || this.pendingTail.length === 0) return;
    let tailIdx = 0;
    while (
      this.asrCharAnchor < this.currentSegmentAsrText.length &&
      tailIdx < this.pendingTail.length
    ) {
      const code = this.currentSegmentAsrText.charCodeAt(this.asrCharAnchor);
      const expectedCode = this.pendingTail.charCodeAt(tailIdx);
      if (code === expectedCode) {
        this.asrCharAnchor++;
        tailIdx++;
      } else if (
        PhoneticCostEngine.isMaddVowel(expectedCode) &&
        PhoneticCostEngine.isMaddVowel(code)
      ) {
        // Absorbs repeated / prolonged vowel frames without advancing tailIdx
        this.asrCharAnchor++;
      } else {
        // Non-tail sound arrived (reciter moved on to next word); lift shield immediately
        this.pendingTail = null;
        return;
      }
    }
    if (tailIdx >= this.pendingTail.length) {
      this.pendingTail = null;
    }
  }
  // [EARLY MATCHING - TAIL DRAIN HELPER: END]
  // ─────────────────────────────────────────────────────────────────────────────

  private processSequence(): void {
    const wordCount = this.wordCount;

    while (
      this.asrCharAnchor < this.currentSegmentAsrText.length &&
      this.targetWordCursor < wordCount
    ) {
      // [EARLY MATCHING - FRONTIER SHIELD: START]
      // When early matching is enabled and Tajweed is OFF, drain unuttered tail
      // phonemes from previous word before matching the next word.
      // (dictation_sequencer.dart:176-183)
      if (this.config.enableEarlyMatching && !this.isTajweed && this.pendingTail !== null) {
        this.drainPendingTail();
        if (this.pendingTail !== null) break;
      }
      // [EARLY MATCHING - FRONTIER SHIELD: END]

      const unconsumed = this.currentSegmentAsrText.substring(this.asrCharAnchor);
      const tsStart = Math.min(this.asrCharAnchor, this.currentSegmentTimestamps.length);
      const unconsumedTs = this.currentSegmentTimestamps.slice(tsStart);

      let matched = false;
      let waitingForPartial = false;

      // Outer loop: how many words to SKIP (0 = no skip, 1 = skip W, etc.)
      // (dictation_sequencer.dart:193-197)
      for (
        let skip = 0;
        skip <= this.config.maxSkipWords && this.targetWordCursor + skip < wordCount;
        skip++
      ) {
        const startW = this.targetWordCursor + skip;

        // Inner loop: try single word first, then try merging with the next word (Wasl handling)
        // (dictation_sequencer.dart:201-203)
        for (let merge = 1; merge <= 2; merge++) {
          const endW = startW + merge - 1;
          if (endW >= wordCount) break;

          const refStart = this.wordBoundaries[startW];
          const refEnd =
            endW + 1 < this.wordBoundaries.length
              ? this.wordBoundaries[endW + 1]
              : this.fullPhonemes.length;

          const result: WordMatchResult | null = matchWord({
            asrText: unconsumed,
            asrTimestamps: unconsumedTs,
            fullPhonemes: this.fullPhonemes,
            refStart,
            refEnd,
            config: this.config,
            isTajweed: this.isTajweed,
          });

          if (result !== null) {
            if (result.isPartial) {
              if (skip === 0) {
                waitingForPartial = true;
                break; // Stop looking ahead, wait for next segment
              } else {
                continue; // A future word is partially matched, ignore for now
              }
            }

            if (result.tokensConsumed > 0) {
              // Ensure that merged words are actually legitimate boundary-merges (Wasl/Idgham)
              if (merge > 1 && !this.isValidMerge(result, startW, endW, unconsumed)) {
                continue; // Reject this merge and try another combination
              }

              // 1. Mark skipped words RED
              for (let s = 0; s < skip; s++) {
                this.commitRed(this.targetWordCursor + s, startW);
              }
              // 2. Mark the matched (or merged) words GREEN
              for (let m = 0; m < merge; m++) {
                const w = startW + m;
                this.commitGreen(w, result, unconsumed, unconsumedTs);
              }

              this.asrCharAnchor += result.tokensConsumed;
              this.targetWordCursor = endW + 1;
              matched = true;

              // ─────────────────────────────────────────────────────────────────
              // [EARLY MATCHING - TAIL RESERVATION: START]
              // -----------------------------------------------------------------
              // If early matching is active and Tajweed is OFF:
              // When a word commits early (before reciter finished trailing letters),
              // reserve the remaining unuttered phonemes as `pendingTail`.
              // Upcoming words won't be allowed to match against these leftovers.
              // If `enableEarlyMatching == false`, this block is completely skipped.
              // (dictation_sequencer.dart:260-280)
              // -----------------------------------------------------------------
              if (this.config.enableEarlyMatching && !this.isTajweed) {
                const wordRefEnd =
                  endW + 1 < this.wordBoundaries.length
                    ? this.wordBoundaries[endW + 1]
                    : this.fullPhonemes.length;
                let lastMatchedRef = -1;
                for (let k = result.trace.length - 1; k >= 0; k--) {
                  if (result.trace[k].opType !== 'delete') {
                    lastMatchedRef = result.trace[k].refIdx;
                    break;
                  }
                }
                if (lastMatchedRef !== -1 && lastMatchedRef < wordRefEnd - 1) {
                  this.pendingTail = this.fullPhonemes.substring(
                    lastMatchedRef + 1,
                    wordRefEnd,
                  );
                  this.drainPendingTail();
                } else {
                  this.pendingTail = null;
                }
              }
              // [EARLY MATCHING - TAIL RESERVATION: END]
              // ─────────────────────────────────────────────────────────────────
              break;
            }
          }
        }

        if (matched || waitingForPartial) break;
      }

      if (!matched) break; // Wait for more ASR text
    }

    // Sliding-window head-trimming:
    // Keep a generous 50-phoneme cushion (~7-9 words) of consumed text.
    // If consumed text exceeds 100 phonemes, trim the oldest text from the head.
    // (dictation_sequencer.dart:294-307)
    const keepCushion = 50;
    if (this.asrCharAnchor > keepCushion + 50) {
      const trim = this.asrCharAnchor - keepCushion;
      this.trimmedOffset += trim;
      (this as { currentSegmentAsrText: string }).currentSegmentAsrText =
        this.currentSegmentAsrText.substring(trim);
      this.currentSegmentTimestamps = this.currentSegmentTimestamps.slice(
        Math.min(trim, this.currentSegmentTimestamps.length),
      );
      this.asrCharAnchor = keepCushion;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Commit Helpers (dictation_sequencer.dart:309-454)
  // ─────────────────────────────────────────────────────────────────────────────

  private commitGreen(
    w: number,
    result: WordMatchResult,
    slicedAsr: string,
    slicedTs: number[],
  ): void {
    if (this.committedGreenWords.has(w)) return;
    this.committedGreenWords.add(w);
    this.committedRedWords.delete(w);

    // Tajweed evaluation (dictation_sequencer.dart:323-348)
    let tajweedErrors: ReciterErrorMap[] | null = null;
    if (this.isTajweed && result.trace.length > 0) {
      const expectedWordRules: WordTajweedRule[] =
        this.surahWordRules !== null && w < this.surahWordRules.length
          ? this.surahWordRules[w]
          : [];

      const errors = evaluatePreAlignedWords({
        alignments: result.trace,
        fullPhonemes: this.fullPhonemes,
        wordBoundaries: this.wordBoundaries,
        currentAsrText: slicedAsr,
        trackingTimestamps: slicedTs,
        bestAsrStartIdx: 0,
        targetCharCursor: 0,
        startWordId: w,
        nextWordId: w + 1,
        totalAyahWords: Math.max(1, this.wordCount),
        expectedWordRules,
        config: this.config,
      });
      if (errors.has(w)) {
        tajweedErrors = errors.get(w)!;
      }
    }

    const refText = this.getWordReference(w);
    this.debugLog(
      `✅ [GREEN] Word ${w} (Ref: "${refText}") -> ASR: "${result.cleanAsr}" (cost=${result.pathCost.toFixed(2)})`,
    );

    this.onEvent({
      type: 'highlight',
      wordId: w,
      score: Math.max(0, 1.0 - result.pathCost),
      cleanAsr: result.cleanAsr,
      tajweedErrors,
      isRed: false,
      isNeutral: false,
    });

    if (
      w + 1 < this.wordBoundaries.length &&
      this.wordBoundaries[w + 1] - 1 < this.fullPhonemes.length
    ) {
      this.lastMatchedPhoneme = this.fullPhonemes.charAt(this.wordBoundaries[w + 1] - 1);
    }
  }

  private commitRed(w: number, matchedWordIndex: number): void {
    if (this.committedRedWords.has(w) || this.committedGreenWords.has(w)) {
      return;
    }
    this.committedRedWords.add(w);

    const refText = this.getWordReference(w);
    const matchedRefText = this.getWordReference(matchedWordIndex);

    this.debugLog(
      `❌ [RED] Word ${w} (Ref: "${refText}") skipped because lookahead matched Word ${matchedWordIndex} (Ref: "${matchedRefText}")`,
    );

    this.onEvent({
      type: 'highlight',
      wordId: w,
      score: 0.0,
      cleanAsr: '',
      tajweedErrors: null,
      isRed: true,
      isNeutral: false,
    });
  }

  private getWordReference(w: number): string {
    if (w < 0 || w >= this.wordCount) return '';
    const start = this.wordBoundaries[w];
    const end = w + 1 < this.wordBoundaries.length ? this.wordBoundaries[w + 1] : this.fullPhonemes.length;
    return this.fullPhonemes.substring(start, Math.min(end, this.fullPhonemes.length));
  }

  private isValidMerge(
    result: WordMatchResult,
    startW: number,
    endW: number,
    asrText: string,
  ): boolean {
    if (startW === endW) return true;

    // The merge feature is specifically for Idgham, Iqlab, Wasl, etc., which happen at the BOUNDARIES.
    for (let w = startW; w <= endW; w++) {
      const refStart = this.wordBoundaries[w];
      const refEnd =
        w + 1 < this.wordBoundaries.length
          ? this.wordBoundaries[w + 1]
          : this.fullPhonemes.length;
      const wordLen = refEnd - refStart;

      const forgiveStart = w > startW ? Math.min(2, Math.floor(wordLen / 3)) : 0;
      const forgiveEnd = w < endW ? Math.min(2, Math.floor(wordLen / 3)) : 0;

      const coreStart = refStart + forgiveStart;
      const coreEnd = refEnd - forgiveEnd;
      const coreLen = coreEnd - coreStart;

      if (coreLen <= 0) continue;

      let coreCost = 0.0;

      for (const align of result.trace) {
        if (align.refIdx >= coreStart && align.refIdx < coreEnd) {
          if (align.opType === 'delete') {
            coreCost += this.config.standardDeletionCost; // config.costDel
          } else if (align.opType === 'replace') {
            if (
              align.predIdx >= 0 &&
              align.refIdx >= 0 &&
              align.predIdx < asrText.length
            ) {
              const asrCode = asrText.charCodeAt(align.predIdx);
              const refCode = this.fullPhonemes.charCodeAt(align.refIdx);
              coreCost += PhoneticCostEngine.getSubstitutionCost(asrCode, refCode);
            } else {
              coreCost += this.config.standardInsertionCost; // config.costIns
            }
          }
        }
      }

      if (coreCost / coreLen > this.config.defaultMaxPathCost) {
        // config.maxPathCost getter => defaultMaxPathCost
        return false;
      }
    }
    return true;
  }
}
