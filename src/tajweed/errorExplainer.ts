// src/tajweed/errorExplainer.ts
// Direct transliteration of lib/tracking/tajweed/error_explainer.dart (703 lines, zero heuristics).
// Evaluates pre-aligned phoneme traces per committed word window:
//   Phase 1: Base Consonant & Deletion/Insertion Verification (`ErrorCategory.normal`).
//   Phase 2: Harakat & Tashkeel Modification Verification (`ErrorCategory.tashkeel`).
//   Phase 3: Direct Tajweed Duration Evaluation (`ErrorCategory.tajweed`).
// Dart lib/ is read-only source of truth. Enums (ErrorCategory, SpeechErrorType,
// TajweedDurationStatus), TrackerConfig, WordTajweedRule and the rule classes are
// reused from src/types.ts, src/config.ts and src/tajweed/rules.ts — never redeclared.

import { TrackerConfig } from '../config';
import {
  ErrorCategory,
  PhonemeGroupAlignment,
  ReciterErrorMap,
  ReciterErrorRuleMap,
  SpeechErrorType,
  TajweedDurationStatus,
  WordTajweedRule,
} from '../types';
import { PhoneticCostEngine } from '../engine/matcher';
import {
  AaredMaddRule,
  LangName,
  LazemMaddRule,
  LeenMaddRule,
  MaddRule,
  MonfaselMaddRule,
  MottaselMaddPauseRule,
  MottaselMaddRule,
  MushaddadGhunnahRule,
  NormalMaddRule,
  ShaddahRule,
  TajweedRule,
} from './rules';

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1: DATA MODELS & ENUMS (enum declarations live in src/types.ts:26-52)
// ═══════════════════════════════════════════════════════════════════════════════

/** Dart enum member names, frozen declaration order (error_explainer.dart:26-35). */
const ERROR_CATEGORY_NAMES = ['tajweed', 'normal', 'tashkeel'] as const;
/** Dart enum member names, frozen declaration order (error_explainer.dart:38-47). */
const SPEECH_ERROR_TYPE_NAMES = ['insert', 'delete', 'replace'] as const;
/** Dart enum member names, frozen declaration order (tajweed_rules.dart:54-63). */
const DURATION_STATUS_NAMES = ['valid', 'defect', 'surplus'] as const;

/** error_explainer.dart:50-143 — immutable diagnostic record of a detected mismatch. */
export class ReciterError {
  readonly errorType: ErrorCategory;
  readonly speechErrorType: SpeechErrorType;
  readonly durationStatus: TajweedDurationStatus | null;
  readonly expectedPh: string;
  readonly predictedPh: string;
  readonly expectedRule: TajweedRule | null;
  readonly predictedRule: TajweedRule | null;
  readonly expectedDuration: number | null;
  readonly actualDuration: number | null;

  constructor(init: {
    errorType: ErrorCategory;
    speechErrorType: SpeechErrorType;
    durationStatus?: TajweedDurationStatus | null;
    expectedPh: string;
    predictedPh: string;
    expectedRule?: TajweedRule | null;
    predictedRule?: TajweedRule | null;
    expectedDuration?: number | null;
    actualDuration?: number | null;
  }) {
    this.errorType = init.errorType;
    this.speechErrorType = init.speechErrorType;
    this.durationStatus = init.durationStatus ?? null;
    this.expectedPh = init.expectedPh;
    this.predictedPh = init.predictedPh;
    this.expectedRule = init.expectedRule ?? null;
    this.predictedRule = init.predictedRule ?? null;
    this.expectedDuration = init.expectedDuration ?? null;
    this.actualDuration = init.actualDuration ?? null;
  }

  /** error_explainer.dart:73-76 */
  toString(): string {
    const status =
      this.durationStatus != null
        ? `TajweedDurationStatus.${DURATION_STATUS_NAMES[this.durationStatus]}`
        : 'null';
    const expRule = this.expectedRule != null ? this.expectedRule.name.en : 'null';
    return (
      `ReciterError(type: ErrorCategory.${ERROR_CATEGORY_NAMES[this.errorType]}, ` +
      `action: SpeechErrorType.${SPEECH_ERROR_TYPE_NAMES[this.speechErrorType]}, ` +
      `status: ${status}, expected: "${this.expectedPh}", predicted: "${this.predictedPh}", ` +
      `expectedRule: ${expRule}, expDur: ${this.expectedDuration}, actDur: ${this.actualDuration})`
    );
  }

  /** error_explainer.dart:78-90 — key order and enum ordinals frozen. */
  toMap(): ReciterErrorMap {
    return {
      errorType: this.errorType,
      speechErrorType: this.speechErrorType,
      durationStatus: this.durationStatus,
      expectedPh: this.expectedPh,
      predictedPh: this.predictedPh,
      expectedRule: ReciterError._ruleToMap(this.expectedRule),
      predictedRule: ReciterError._ruleToMap(this.predictedRule),
      expectedDuration: this.expectedDuration,
      actualDuration: this.actualDuration,
    };
  }

  /** error_explainer.dart:92-107 */
  static fromMap(map: ReciterErrorMap): ReciterError {
    return new ReciterError({
      errorType: map.errorType as ErrorCategory,
      speechErrorType: map.speechErrorType as SpeechErrorType,
      durationStatus:
        map.durationStatus != null ? (map.durationStatus as TajweedDurationStatus) : null,
      expectedPh: map.expectedPh ?? '',
      predictedPh: map.predictedPh ?? '',
      expectedRule: ReciterError._ruleFromMap(map.expectedRule),
      predictedRule: ReciterError._ruleFromMap(map.predictedRule),
      expectedDuration: map.expectedDuration ?? null,
      actualDuration: map.actualDuration ?? null,
    });
  }

  /** error_explainer.dart:109-117 */
  private static _ruleToMap(rule: TajweedRule | null): ReciterErrorRuleMap | null {
    if (rule == null) return null;
    return rule.toRuleMap();
  }

  /** error_explainer.dart:119-142 */
  private static _ruleFromMap(map: ReciterErrorRuleMap | null): TajweedRule | null {
    if (map == null) return null;
    const type: string = map.type ?? '';
    const nameAr: string = map.nameAr ?? '';
    const nameEn: string = map.nameEn ?? '';
    const goldenLen: number = map.goldenLen ?? 2;

    if (type === 'LazemMaddRule') return new LazemMaddRule();
    if (type === 'LeenMaddRule') return new LeenMaddRule();
    if (type === 'AaredMaddRule') return new AaredMaddRule();
    if (type === 'MonfaselMaddRule') return new MonfaselMaddRule();
    if (type === 'MottaselMaddRule') return new MottaselMaddRule();
    if (type === 'MottaselMaddPauseRule') return new MottaselMaddPauseRule();
    if (type === 'NormalMaddRule') return new NormalMaddRule();
    if (type === 'MushaddadGhunnahRule') {
      return MushaddadGhunnahRule.withNames({ nameAr, nameEn });
    }
    if (type === 'ShaddahRule') return new ShaddahRule();

    return new MaddRule({ name: new LangName({ ar: nameAr, en: nameEn }), goldenLen });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2: REFERENCE PHONETIC SPAN MODEL (error_explainer.dart:162-182)
// ═══════════════════════════════════════════════════════════════════════════════

class PhoneticSpan {
  /** absolute index in fullPhonemes */
  readonly refStart: number;
  /** absolute index in fullPhonemes */
  readonly refEnd: number;
  readonly refText: string;
  readonly baseChar: string;
  readonly isMadd: boolean;
  readonly isShaddah: boolean;
  readonly isGhunnah: boolean;
  readonly matchedWordRule: WordTajweedRule | null;

  constructor(init: {
    refStart: number;
    refEnd: number;
    refText: string;
    baseChar: string;
    isMadd: boolean;
    isShaddah: boolean;
    isGhunnah: boolean;
    matchedWordRule?: WordTajweedRule | null;
  }) {
    this.refStart = init.refStart;
    this.refEnd = init.refEnd;
    this.refText = init.refText;
    this.baseChar = init.baseChar;
    this.isMadd = init.isMadd;
    this.isShaddah = init.isShaddah;
    this.isGhunnah = init.isGhunnah;
    this.matchedWordRule = init.matchedWordRule ?? null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3: ERROR EXPLAINER ENGINE (error_explainer.dart:188-702)
// ═══════════════════════════════════════════════════════════════════════════════

export interface EvaluatePreAlignedWordsArgs {
  alignments: PhonemeGroupAlignment[];
  fullPhonemes: string;
  wordBoundaries: number[];
  currentAsrText: string;
  trackingTimestamps: number[];
  bestAsrStartIdx: number;
  targetCharCursor: number;
  startWordId: number;
  nextWordId: number;
  totalAyahWords: number;
  expectedWordRules: WordTajweedRule[];
  config: TrackerConfig;
}

/** Evaluates pre-aligned phoneme traces for a specific committed word window (error_explainer.dart:190-321). */
export function evaluatePreAlignedWords(
  args: EvaluatePreAlignedWordsArgs,
): Map<number, ReciterErrorMap[]> {
  const {
    alignments,
    fullPhonemes,
    wordBoundaries,
    currentAsrText,
    trackingTimestamps,
    bestAsrStartIdx,
    targetCharCursor,
    startWordId,
    nextWordId,
    expectedWordRules,
    config,
  } = args;

  const errorsByWord = new Map<number, ReciterErrorMap[]>();

  for (let w = startWordId; w < nextWordId; w++) {
    if (w < 0 || w >= wordBoundaries.length - 1) continue;

    const wordRefStart = wordBoundaries[w];
    const wordRefEnd =
      w + 1 < wordBoundaries.length ? wordBoundaries[w + 1] : fullPhonemes.length;
    if (wordRefStart >= wordRefEnd) continue;

    const wordText = fullPhonemes.substring(
      wordRefStart,
      Math.min(wordRefEnd, fullPhonemes.length),
    );

    // 1. Build cohesive phonetic spans for this word
    const spans = _buildWordSpans({
      fullPhonemes,
      wordRefStart,
      wordRefEnd,
      expectedWordRules,
    });

    const wordErrors: ReciterError[] = [];

    // 2. Evaluate each span with aggregated ASR alignments and durations
    for (const span of spans) {
      // Collect all alignment items belonging to this reference span
      const spanAlignments = alignments.filter((a) => {
        const absRef = targetCharCursor + a.refIdx;
        return absRef >= span.refStart && absRef < span.refEnd;
      });

      if (spanAlignments.length === 0) continue;

      // Collect matched predicted characters and sum actual acoustic duration
      const predChunks: string[] = [];
      const usedPredIndices = new Set<number>();
      let totalSpanDuration = 0.0;
      let hasDelete = false;

      for (const a of spanAlignments) {
        if (a.opType === 'delete') {
          hasDelete = true;
        }
        const absPred = bestAsrStartIdx + a.predIdx;
        if (absPred >= 0 && absPred < currentAsrText.length) {
          predChunks.push(currentAsrText.charAt(absPred));
          if (!usedPredIndices.has(absPred)) {
            usedPredIndices.add(absPred);
            if (absPred < trackingTimestamps.length) {
              totalSpanDuration += trackingTimestamps[absPred];
            }
          }
        }
      }

      const predText = predChunks.join('');

      // Evaluate the span against Madd, Shaddah, Ghunnah, Tashkeel, or Consonants
      const spanErrors = _evaluateSpan({
        span,
        predText,
        spanDuration: totalSpanDuration,
        hasDelete,
        wordText,
        wordRefEnd,
        config,
      });

      wordErrors.push(...spanErrors);
    }

    if (wordErrors.length > 0) {
      // Sort errors by UI priority
      wordErrors.sort((a, b) => _getErrorPriority(a) - _getErrorPriority(b));

      // Filter out expected ASR noise and surplus duration
      const filtered = wordErrors.filter((e) => {
        if (e.durationStatus === TajweedDurationStatus.surplus) return false;
        if (e.errorType === ErrorCategory.normal) {
          return !(config.hideExpectedAsrNoise && _isExpectedAsrNoise(e, config));
        }
        return true;
      });

      // Deduplicate identical errors on the same rule/phoneme
      const deduplicated: ReciterError[] = [];
      const seenKeys = new Set<string>();
      for (const e of filtered) {
        const key = `${ERROR_CATEGORY_NAMES[e.errorType]}_${
          e.expectedRule != null ? e.expectedRule.type : 'null'
        }_${e.expectedPh}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          deduplicated.push(e);
        }
      }

      if (deduplicated.length > 0) {
        errorsByWord.set(
          w,
          deduplicated.map((e) => e.toMap()),
        );
        // DebugLogger.log('Error', ...) — debug-only in Dart, no logger ported.
      }
    }
  }

  return errorsByWord;
}

// ───────────────────────────────────────────────────────────────────────────
// 3.2 REFERENCE SPAN BUILDER (error_explainer.dart:327-475)
// Groups contiguous repeating characters (Madd, Shaddah, Ghunnah) into spans
// ───────────────────────────────────────────────────────────────────────────
function _buildWordSpans(args: {
  fullPhonemes: string;
  wordRefStart: number;
  wordRefEnd: number;
  expectedWordRules: WordTajweedRule[];
}): PhoneticSpan[] {
  const { fullPhonemes, wordRefStart, wordRefEnd, expectedWordRules } = args;
  const spans: PhoneticSpan[] = [];
  let cursor = wordRefStart;

  while (cursor < wordRefEnd) {
    const ch = fullPhonemes.charAt(cursor);

    // ── 1. Madd Span (Consecutive Madd vowels: ا, ۥ, ۦ) ──
    if ('اۥۦ'.includes(ch)) {
      let end = cursor;
      while (end < wordRefEnd && fullPhonemes.charAt(end) === ch) {
        end++;
      }
      const refText = fullPhonemes.substring(cursor, end);

      // Find matching Madd rule in expectedWordRules
      let matchedRule: WordTajweedRule | null = null;
      for (const r of expectedWordRules) {
        if (r.ruleId >= 1 && r.ruleId <= 7) {
          matchedRule = r;
          break;
        }
      }

      spans.push(
        new PhoneticSpan({
          refStart: cursor,
          refEnd: end,
          refText,
          baseChar: ch,
          isMadd: true,
          isShaddah: false,
          isGhunnah: false,
          matchedWordRule: matchedRule,
        }),
      );
      cursor = end;
      continue;
    }

    // ── 2. Mushaddad Ghunnah Span (نننن or مممم) ──
    if (
      'نم'.includes(ch) &&
      cursor + 1 < wordRefEnd &&
      fullPhonemes.charAt(cursor + 1) === ch &&
      cursor + 2 < wordRefEnd &&
      fullPhonemes.charAt(cursor + 2) === ch
    ) {
      let end = cursor;
      while (end < wordRefEnd && fullPhonemes.charAt(end) === ch) {
        end++;
      }
      // Include attached Harakah if present
      if (end < wordRefEnd && 'َُِ'.includes(fullPhonemes.charAt(end))) {
        end++;
      }
      const refText = fullPhonemes.substring(cursor, end);

      let matchedRule: WordTajweedRule | null = null;
      for (const r of expectedWordRules) {
        if (r.ruleId === 10) {
          matchedRule = r;
          break;
        }
      }

      spans.push(
        new PhoneticSpan({
          refStart: cursor,
          refEnd: end,
          refText,
          baseChar: ch,
          isMadd: false,
          isShaddah: false,
          isGhunnah: true,
          matchedWordRule:
            matchedRule ??
            {
              ruleId: 10,
              nameAr: ch === 'ن' ? 'النون المشددة' : 'الميم المشددة',
              nameEn: ch === 'ن' ? 'Mushaddad Noon' : 'Mushaddad Meem',
              goldenLen: 2,
            },
        }),
      );
      cursor = end;
      continue;
    }

    // ── 3. Shaddah Span (Doubled consonants: رر, لل, تت, etc.) ──
    if (
      cursor + 1 < wordRefEnd &&
      fullPhonemes.charAt(cursor + 1) === ch &&
      !'اۥۦ'.includes(ch)
    ) {
      let end = cursor;
      while (end < wordRefEnd && fullPhonemes.charAt(end) === ch) {
        end++;
      }
      // Include attached Harakah if present
      if (end < wordRefEnd && 'َُِ'.includes(fullPhonemes.charAt(end))) {
        end++;
      }
      const refText = fullPhonemes.substring(cursor, end);

      spans.push(
        new PhoneticSpan({
          refStart: cursor,
          refEnd: end,
          refText,
          baseChar: ch,
          isMadd: false,
          isShaddah: true,
          isGhunnah: false,
          matchedWordRule: {
            ruleId: 9,
            nameAr: 'الشدة',
            nameEn: 'Shaddah',
            goldenLen: 1,
          },
        }),
      );
      cursor = end;
      continue;
    }

    // ── 4. Single Consonant + Harakah / Diacritic Span ──
    let end = cursor + 1;
    while (end < wordRefEnd && 'َُِڇؙ۪ۜـ'.includes(fullPhonemes.charAt(end))) {
      end++;
    }
    const refText = fullPhonemes.substring(cursor, end);

    spans.push(
      new PhoneticSpan({
        refStart: cursor,
        refEnd: end,
        refText,
        baseChar: ch,
        isMadd: false,
        isShaddah: false,
        isGhunnah: false,
      }),
    );
    cursor = end;
  }

  return spans;
}

// ───────────────────────────────────────────────────────────────────────────
// 3.3 SPAN EVALUATION PIPELINE (error_explainer.dart:480-617)
// ───────────────────────────────────────────────────────────────────────────
function _evaluateSpan(args: {
  span: PhoneticSpan;
  predText: string;
  spanDuration: number;
  hasDelete: boolean;
  wordText: string;
  wordRefEnd: number;
  config: TrackerConfig;
}): ReciterError[] {
  const { span, predText, spanDuration, wordRefEnd, config } = args;
  const errors: ReciterError[] = [];
  const hBase = config.harakatDurationSeconds;

  // ── Phase 1: Base Character Verification (Letter Identity & Deletion) ──
  if (span.refText.length > 0) {
    if (predText.length === 0) {
      errors.push(
        new ReciterError({
          errorType: ErrorCategory.normal,
          speechErrorType: SpeechErrorType.delete,
          expectedPh: span.refText,
          predictedPh: '',
        }),
      );
      return errors;
    } else if (span.baseChar !== predText.charAt(0)) {
      // Base consonant / Madd vowel substituted (e.g. ي vs ت, ۦ vs ۥ)
      errors.push(
        new ReciterError({
          errorType: ErrorCategory.normal,
          speechErrorType: SpeechErrorType.replace,
          expectedPh: span.refText,
          predictedPh: predText,
        }),
      );
      return errors;
    }
  }

  // ── Phase 2: Tajweed Duration Rules (Madd, Ghunnah, Shaddah) ──
  if (span.isMadd) {
    const rule =
      span.matchedWordRule != null
        ? _instantiateTajweedRule(span.matchedWordRule)
        : _deriveMaddRuleFromLength(span.refText.length);

    const req = rule.getRequiredDuration(hBase);
    const durStatus = rule.checkDurationStatus(spanDuration, hBase);

    if (durStatus === TajweedDurationStatus.defect) {
      errors.push(
        new ReciterError({
          errorType: ErrorCategory.tajweed,
          speechErrorType: SpeechErrorType.replace,
          durationStatus: durStatus,
          expectedPh: span.refText,
          predictedPh: predText,
          expectedRule: rule,
          expectedDuration: req,
          actualDuration: spanDuration,
        }),
      );
    }
    return errors;
  }

  if (span.isGhunnah) {
    const rule =
      span.matchedWordRule != null
        ? _instantiateTajweedRule(span.matchedWordRule)
        : MushaddadGhunnahRule.withNames({
            nameAr: span.baseChar === 'ن' ? 'النون المشددة' : 'الميم المشددة',
            nameEn: span.baseChar === 'ن' ? 'Mushaddad Noon' : 'Mushaddad Meem',
          });

    const req = rule.getRequiredDuration(hBase);
    const durStatus = rule.checkDurationStatus(spanDuration, hBase);

    if (durStatus === TajweedDurationStatus.defect) {
      errors.push(
        new ReciterError({
          errorType: ErrorCategory.tajweed,
          speechErrorType: SpeechErrorType.replace,
          durationStatus: durStatus,
          expectedPh: span.refText,
          predictedPh: predText,
          expectedRule: rule,
          expectedDuration: req,
          actualDuration: spanDuration,
        }),
      );
    }
    return errors;
  }

  if (span.isShaddah) {
    const rule = new ShaddahRule();
    const req = rule.getRequiredDuration(hBase);

    const predBaseCount = _countBaseOccurrences(predText, span.baseChar);
    const predDoubled = predBaseCount >= 2;
    const durStatus = rule.checkDurationStatus(spanDuration, hBase);

    if (!predDoubled || durStatus === TajweedDurationStatus.defect) {
      errors.push(
        new ReciterError({
          errorType: ErrorCategory.tajweed,
          speechErrorType: SpeechErrorType.replace,
          durationStatus: durStatus,
          expectedPh: span.refText,
          predictedPh: predText,
          expectedRule: rule,
          expectedDuration: req,
          actualDuration: spanDuration,
        }),
      );
    }
    return errors;
  }

  // ── Phase 3: Tashkeel / Harakat Evaluation on Matching Base Consonants ──
  const refVowels = _extractVowels(span.refText);
  const predVowels = _extractVowels(predText);

  if (refVowels.length > 0 || predVowels.length > 0) {
    // Stopping on Sukoon (no vowel) on the terminal letter of the word is valid Waqf
    const isTerminalWaqf = span.refEnd === wordRefEnd && predVowels.length === 0;
    if (!isTerminalWaqf && refVowels !== predVowels) {
      errors.push(
        new ReciterError({
          errorType: ErrorCategory.tashkeel,
          speechErrorType: SpeechErrorType.replace,
          expectedPh: span.refText,
          predictedPh: predText,
        }),
      );
    }
  }

  return errors;
}

// ───────────────────────────────────────────────────────────────────────────
// 3.4 HELPER METHODS (error_explainer.dart:623-701)
// ───────────────────────────────────────────────────────────────────────────

function _deriveMaddRuleFromLength(len: number): TajweedRule {
  if (len >= 6) return new LazemMaddRule();
  if (len >= 4) return new AaredMaddRule();
  return new NormalMaddRule();
}

function _countBaseOccurrences(text: string, base: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charAt(i) === base) count++;
  }
  return count;
}

function _extractVowels(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if ('َُِ'.includes(text.charAt(i))) {
      out += text.charAt(i);
    }
  }
  return out;
}

/** error_explainer.dart:647-676 — ruleId → rule class. JSON goldenLen is deliberately ignored for mapped ids. */
export function _instantiateTajweedRule(wRule: WordTajweedRule): TajweedRule {
  switch (wRule.ruleId) {
    case 1:
      return new NormalMaddRule();
    case 2:
      return new MonfaselMaddRule();
    case 3:
      return new MottaselMaddRule();
    case 4:
      return new MottaselMaddPauseRule();
    case 5:
      return new AaredMaddRule();
    case 6:
      return new LazemMaddRule();
    case 7:
      return new LeenMaddRule();
    case 9:
      return new ShaddahRule();
    case 10:
      return MushaddadGhunnahRule.withNames({
        nameAr: wRule.nameAr,
        nameEn: wRule.nameEn,
      });
    default:
      return new MaddRule({
        name: new LangName({ ar: wRule.nameAr, en: wRule.nameEn }),
        goldenLen: wRule.goldenLen,
      });
  }
}

function _isExpectedAsrNoise(e: ReciterError, config: TrackerConfig): boolean {
  const refCode = e.expectedPh.length > 0 ? e.expectedPh.charCodeAt(0) : 0;
  const asrCode = e.predictedPh.length > 0 ? e.predictedPh.charCodeAt(0) : 0;

  switch (e.speechErrorType) {
    case SpeechErrorType.replace:
      return (
        refCode > 0 &&
        asrCode > 0 &&
        PhoneticCostEngine.getSubstitutionCost(asrCode, refCode, config.acousticConfusionCost) <=
          config.acousticConfusionCost
      );
    case SpeechErrorType.delete:
      // Common ASR drops (ا, ء, ل, ٱ) and Madd vowels (و, ي, ۥ, ۦ)
      return (
        refCode === 0x0627 ||
        refCode === 0x0621 ||
        refCode === 0x0644 ||
        refCode === 0x0671 ||
        refCode === 0x0648 ||
        refCode === 0x064a ||
        refCode === 0x06e5 ||
        refCode === 0x06e6
      );
    case SpeechErrorType.insert:
      return (
        asrCode > 0 &&
        (PhoneticCostEngine.isTashkeel(asrCode) ||
          PhoneticCostEngine.getInsertionCost(
            e.predictedPh,
            0,
            config.standardInsertionCost,
            config.acousticConfusionCost,
          ) <= config.acousticConfusionCost)
      );
    default:
      return false;
  }
}

function _getErrorPriority(e: ReciterError): number {
  if (e.errorType === ErrorCategory.normal) return 0;
  if (e.errorType === ErrorCategory.tashkeel) return 1;
  if (e.expectedRule instanceof MaddRule) return 2;
  if (e.expectedRule instanceof MushaddadGhunnahRule) return 3;
  if (e.expectedRule instanceof ShaddahRule) return 4;
  return 5;
}
