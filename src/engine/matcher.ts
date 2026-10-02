// src/engine/matcher.ts
// Line-by-line transliteration of lib/tracking/word/dictation_matcher.dart (549 lines).
// Dart sources are the read-only source of truth; nothing under lib/ is modified.
// charCodeAt/UTF-16 code units match Dart String.codeUnitAt for all BMP Quranic glyphs.

import { TrackerConfig } from '../config';
import { PhonemeGroupAlignment } from '../types';

// ═══════════════════════════════════════════════════════════════════════════════
// Per-Word Semi-Global DTW Matcher (Direct Character-Level Alignment)
//
// Each word is matched independently against the unconsumed ASR buffer.
// Free-start: leading noise characters are free (handles Wasl and CTC jitter).
// First-valid-endpoint: consumes the minimum number of ASR characters.
// ═══════════════════════════════════════════════════════════════════════════════

/** Result of aligning ASR characters against a single word's reference. (dictation_matcher.dart:18-45) */
export interface WordMatchResult {
  /** Total edit cost normalized by reference length. */
  pathCost: number;
  /** How many ASR characters this match consumed from the buffer. */
  tokensConsumed: number;
  /** Substring of ASR phonemes that aligned to the word. */
  cleanAsr: string;
  /** Timestamps of the aligned ASR characters. */
  timestamps: number[];
  /** Full alignment trace for Tajweed evaluation. */
  trace: PhonemeGroupAlignment[];
  /** Indicates if this is a partial match (word is still being spoken). */
  isPartial: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHONETIC & TAJWEED COST ENGINE (MODEL-SPECIFIC ACOUSTIC MATRIX)
// ═══════════════════════════════════════════════════════════════════════════════

function isHamzaVariant(code: number): boolean {
  return code === 0x0621 || code === 0x0622 || code === 0x0623 || code === 0x0625 || code === 0x0672;
}

/** dictation_matcher.dart:60-66 (exposed publicly per brief). */
function isZeroCostMarker(codeUnit: number): boolean {
  return codeUnit === 0x0686 || // 'ڇ' - Qalqalah release burst
         codeUnit === 0x06DC || // 'ۜ' - Sakt
         codeUnit === 0x0619 || // 'ؙ' - Ishmam
         codeUnit === 0x06EA || // '۪' - Imalah
         codeUnit === 0x0640;   // 'ـ' - Tatweel
}

/** dictation_matcher.dart:69-91 — Interchangeable Quranic Glyphs (Cost = 0.0). */
function isEquivalentGlyph(asrCode: number, refCode: number): boolean {
  if (asrCode === refCode) return true;

  // Swap to ensure 'asrCode' is always the smaller code unit
  if (asrCode > refCode) {
    const temp = asrCode;
    asrCode = refCode;
    refCode = temp;
  }

  if (asrCode === 0x0645 && refCode === 0x06FE) return true; // م <-> ۾ (Iqlab)
  if (asrCode === 0x0646 && refCode === 0x06BA) return true; // ن <-> ں (Ikhfaa)
  if (asrCode === 0x0648 && refCode === 0x06E5) return true; // و <-> ۥ (Waw)
  if (asrCode === 0x064A && refCode === 0x06E6) return true; // ي <-> ۦ (Yaa)

  if (isHamzaVariant(asrCode) && isHamzaVariant(refCode)) return true;

  // Ta-Marbuta (ة) can sound like Haa (ه) or Taa (ت), but Haa and Taa cannot match each other!
  if (asrCode === 0x0629 && refCode === 0x0647) return true; // ة <-> ه
  if (asrCode === 0x062A && refCode === 0x0629) return true; // ت <-> ة

  return false;
}

/** dictation_matcher.dart:97-135 — Model Acoustic Confusion Matrix (Cost = 0.25). */
function isAcousticConfusion(asrCode: number, refCode: number): boolean {
  if (asrCode > refCode) {
    const temp = asrCode;
    asrCode = refCode;
    refCode = temp;
  }

  switch (asrCode) {
    // Vowels vs Harakat (Short vs Long vowel duration confusion)
    case 0x0627: return refCode === 0x064E; // ا (Alif)  <-> َ (Fatha)
    case 0x0648: return refCode === 0x064F; // و (Waw)   <-> ُ (Damma)
    case 0x064F: return refCode === 0x06E5; // ُ (Damma) <-> ۥ (Small Waw)
    case 0x064A: return refCode === 0x0650; // ي (Yaa)   <-> ِ (Kasra)
    case 0x0650: return refCode === 0x06E6; // ِ (Kasra) <-> ۦ (Small Yaa)

    // Consonant acoustic confusions
    case 0x062A: return refCode === 0x0637; // ت <-> ط
    case 0x062C: return refCode === 0x0632; // ج <-> ز
    case 0x062E: return refCode === 0x063A; // خ <-> غ
    case 0x062F: return refCode === 0x0636; // د <-> ض
    case 0x0630: return refCode === 0x0632 || refCode === 0x0638; // ذ <-> ز, ظ
    case 0x0633: return refCode === 0x0635; // س <-> ص
    case 0x0642: return refCode === 0x0643; // ق <-> ك
    default: return false;
  }
}

/** dictation_matcher.dart:138-139 — Tashkeel / Short Vowel Detection. */
function isTashkeel(code: number): boolean {
  return code === 0x064E || code === 0x064F || code === 0x0650; // Fatha, Damma, Kasra
}

/** dictation_matcher.dart:142-143 — Madd / Long Vowels (ا, و, ي, ۥ, ۦ). */
function isMaddVowel(code: number): boolean {
  return code === 0x0627 || code === 0x0648 || code === 0x064A || code === 0x06E5 || code === 0x06E6;
}

/** dictation_matcher.dart:146-168 — Substitution Cost Evaluation. */
function getSubstitutionCost(
  asrCodeUnit: number,
  refCodeUnit: number,
  acousticConfusionCost = 0.25,
): number {
  if (asrCodeUnit === refCodeUnit) return 0.0;

  if (isEquivalentGlyph(asrCodeUnit, refCodeUnit)) {
    return 0.0;
  }

  // CHECK CONFUSIONS FIRST: (Allows Fatha <-> Alif to pass with acousticConfusionCost)
  if (isAcousticConfusion(asrCodeUnit, refCodeUnit)) {
    return acousticConfusionCost;
  }

  // STRICT HARAKAT PENALTY: (If it involves a Harakat but wasn't in the matrix above, it's a 1.0 error)
  if (isTashkeel(asrCodeUnit) || isTashkeel(refCodeUnit)) {
    return 1.0;
  }

  return 1.0;
}

/** dictation_matcher.dart:171-192 — Deletion Cost (Expected phoneme missing from stream). */
function getDeletionCost(
  fullPhonemes: string,
  gRefIdx: number,
  standardDeletionCost = 1.0,
  acousticConfusionCost = 0.25,
): number {
  if (gRefIdx < 0 || gRefIdx >= fullPhonemes.length) return standardDeletionCost;
  const code = fullPhonemes.charCodeAt(gRefIdx);

  if (isZeroCostMarker(code)) return 0.0;

  if (isHamzaVariant(code)) return acousticConfusionCost;

  if (gRefIdx > 0 && code === fullPhonemes.charCodeAt(gRefIdx - 1)) {
    // In CTC, repeated phonetic features (like Madd vowels or Shaddah consonants)
    // are often emitted as a single acoustic spike by the ASR model unless heavily emphasized.
    // We apply an acoustic confusion discount so a single 'ب' can align with 'بب'.
    return acousticConfusionCost;
  }

  return standardDeletionCost;
}

/** dictation_matcher.dart:195-213 — Insertion Cost (Extra phoneme in ASR stream). */
function getInsertionCost(
  asrText: string,
  asrIdx: number,
  standardInsertionCost = 1.0,
  acousticConfusionCost = 0.25,
): number {
  if (asrIdx < 0 || asrIdx >= asrText.length) return standardInsertionCost;
  const code = asrText.charCodeAt(asrIdx);

  if (isZeroCostMarker(code)) return 0.0;

  if (asrIdx > 0 && code === asrText.charCodeAt(asrIdx - 1)) {
    if (isMaddVowel(code)) {
      return acousticConfusionCost;
    }
  }

  return standardInsertionCost;
}

export const PhoneticCostEngine = {
  isTashkeel,
  isMaddVowel,
  isZeroCostMarker,
  isEquivalentGlyph,
  isAcousticConfusion,
  getSubstitutionCost,
  getDeletionCost,
  getInsertionCost,
};

// ═══════════════════════════════════════════════════════════════════════════════
// Per-word semi-global DTW matcher operating directly on character strings.
// dictation_matcher.dart:220-549 (QuranDictationMatcher.matchWord)
// ═══════════════════════════════════════════════════════════════════════════════

// Reusable DP buffers (dictation_matcher.dart:231-232), grown by doubling from 2048.
let dpBuf = new Float64Array(2048);
let btBuf = new Uint8Array(2048);

export interface MatchWordArgs {
  asrText: string;
  asrTimestamps: number[];
  fullPhonemes: string;
  refStart: number;
  refEnd: number;
  config: TrackerConfig;
  isTajweed: boolean;
}

/** Aligns asrText against the reference slice [refStart, refEnd) in fullPhonemes. Returns the best match or null if no alignment meets the threshold. */
export function matchWord(args: MatchWordArgs): WordMatchResult | null {
  const { asrText, asrTimestamps, fullPhonemes, refStart, refEnd, config, isTajweed } = args;
  const m = asrText.length;
  const n = refEnd - refStart;
  if (m === 0 || n <= 0) return null;

  // ═════════════════════════════════════════════════════════════════════════
  // 1. BUFFER MANAGEMENT (dictation_matcher.dart:250-262)
  // ═════════════════════════════════════════════════════════════════════════
  const stride = n + 1;
  const cells = (m + 1) * stride;
  if (dpBuf.length < cells) {
    const sz = Math.max(cells, dpBuf.length * 2);
    dpBuf = new Float64Array(sz);
    btBuf = new Uint8Array(sz);
  }

  const dp = dpBuf;
  const bt = btBuf;

  // ═════════════════════════════════════════════════════════════════════════
  // 2. MATRIX INITIALIZATION (dictation_matcher.dart:264-285)
  // ═════════════════════════════════════════════════════════════════════════
  // Row 0: reference deletions (word phonemes with no ASR)
  dp[0] = 0.0;
  bt[0] = 0;
  for (let j = 1; j <= n; j++) {
    const delCost = PhoneticCostEngine.getDeletionCost(
      fullPhonemes,
      refStart + j - 1,
      config.standardDeletionCost,
      config.acousticConfusionCost,
    );
    dp[j] = dp[j - 1] + delCost;
    bt[j] = 1; // delete
  }

  // Column 0: FREE START (skip leading ASR noise characters at zero cost)
  for (let i = 1; i <= m; i++) {
    dp[i * stride] = 0.0;
    bt[i * stride] = 2; // free insert
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 3. CORE DP FILL (DYNAMIC TIME WARPING WITH PHONETIC COST MATRIX)
  //    (dictation_matcher.dart:287-336)
  // ═════════════════════════════════════════════════════════════════════════
  for (let i = 1; i <= m; i++) {
    const aCode = asrText.charCodeAt(i - 1);
    const row = i * stride;
    const prev = (i - 1) * stride;
    const insCost = PhoneticCostEngine.getInsertionCost(
      asrText,
      i - 1,
      config.standardInsertionCost,
      config.acousticConfusionCost,
    );

    for (let j = 1; j <= n; j++) {
      const rRef = refStart + j - 1;
      const rCode = fullPhonemes.charCodeAt(rRef);

      const subCost = PhoneticCostEngine.getSubstitutionCost(
        aCode,
        rCode,
        config.acousticConfusionCost,
      );
      const delCost = PhoneticCostEngine.getDeletionCost(
        fullPhonemes,
        rRef,
        config.standardDeletionCost,
        config.acousticConfusionCost,
      );

      const sub = dp[prev + j - 1] + subCost;
      const del = dp[row + j - 1] + delCost;
      const ins = dp[prev + j] + insCost;

      // We use `sub < del` instead of `sub <= del` to break ties in favor of deletions.
      // This forces the DP to match EARLY and delete LATE, ensuring trailing omissions
      // are correctly represented as `op == 1` (Deletion) at the end of the path,
      // which makes the Strict Frontier rule work reliably.
      if (sub < del && sub <= ins) {
        dp[row + j] = sub;
        bt[row + j] = 0; // match/sub
      } else if (del <= ins) {
        dp[row + j] = del;
        bt[row + j] = 1; // delete
      } else {
        dp[row + j] = ins;
        bt[row + j] = 2; // insert
      }
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 4. ENDPOINT DETECTION (CALIBRATED DYNAMIC THRESHOLD)
  //    (dictation_matcher.dart:338-415 — architectural comment elided)
  // ═════════════════════════════════════════════════════════════════════════
  let bestI = -1;
  let bestCost = Infinity;

  // Effective length: collapse consecutive identical Madd vowels (ا, و, ي, ۥ, ۦ)
  // and skip zero-cost markers so the error budget reflects real word content.
  let effN = 0;
  for (let j = 0; j < n; j++) {
    const code = fullPhonemes.charCodeAt(refStart + j);
    if (PhoneticCostEngine.isZeroCostMarker(code)) continue;
    if (j > 0 && code === fullPhonemes.charCodeAt(refStart + j - 1) &&
        PhoneticCostEngine.isMaddVowel(code)) {
      continue;
    }
    effN++;
  }
  if (effN < 1) effN = 1;

  // Dynamic threshold: scaled to guarantee matching at >= 70% accuracy (up to 30% error)
  // while preventing random acoustic noise from triggering false greens on short words.
  let threshold = config.defaultMaxPathCost;
  if (effN <= 3) {
    threshold = Math.min(threshold, config.shortWordPathCost);
  } else if (effN <= 7) {
    threshold = Math.min(threshold, config.mediumWordPathCost);
  } else {
    threshold = Math.min(threshold, config.defaultMaxPathCost);
  }

  // [EARLY MATCHING - TAJWEED OFF: ENDPOINT SEARCH] (dictation_matcher.dart:395-415)
  // - When FALSE: Uses baseline `norm <= bestCost` and searches all endpoints.
  // - When TRUE:  For words >= 4 phonemes (Tajweed OFF), commits immediately on
  //               exact match (`norm < bestCost` and break on `bestCost == 0.0`).
  const allowEarlyBreak = config.enableEarlyMatching && !isTajweed && effN >= 4;
  for (let i = 1; i <= m; i++) {
    const norm = dp[i * stride + n] / effN;
    if (norm <= threshold) {
      if (allowEarlyBreak ? (norm < bestCost) : (norm <= bestCost)) {
        bestI = i;
        bestCost = norm;
        if (allowEarlyBreak && bestCost === 0.0) break;
      }
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 5. PARTIAL MATCHING LOGIC (dictation_matcher.dart:418-489)
  // ═════════════════════════════════════════════════════════════════════════
  let isPartial = false;
  // Strict Frontier Rule: If Tajweed is ON, and we consumed the entire buffer (bestI == m),
  // we ONLY wait if a core consonant or vowel is missing/incomplete at the trailing edge.
  // If the trailing error is merely Tashkeel/Waqf, the word is complete and commits immediately.
  if (isTajweed && bestI > 0 && bestI === m) {
    const curJStart = n;
    const curI = bestI;
    let curJ = curJStart;
    let hasCoreConsonantMissing = false;

    // 1. Check all trailing deletions at the stream frontier
    while (curJ > 0 && curI === bestI && bt[curI * stride + curJ] === 1) {
      const rCode = fullPhonemes.charCodeAt(refStart + curJ - 1);
      const isRepeated = curJ > 1 && rCode === fullPhonemes.charCodeAt(refStart + curJ - 2);

      // If the trailing deleted character is a core non-repeated consonant, the word is incomplete.
      if (!PhoneticCostEngine.isTashkeel(rCode) &&
          !PhoneticCostEngine.isZeroCostMarker(rCode) &&
          !isRepeated) {
        hasCoreConsonantMissing = true;
        break;
      }
      curJ--;
    }

    if (hasCoreConsonantMissing) {
      isPartial = true;
    } else if (curJ > 0 && bt[curI * stride + curJ] === 0) {
      // 2. Trailing substitution at the frontier
      const asrCode = asrText.charCodeAt(bestI - 1);
      const refCode = fullPhonemes.charCodeAt(refStart + curJ - 1);

      // If both are Tashkeel (e.g. 'ُ' vs 'ِ'), it's a Tashkeel error on a completed word, NOT a partial stream
      if (PhoneticCostEngine.isTashkeel(asrCode) && PhoneticCostEngine.isTashkeel(refCode)) {
        isPartial = false;
      } else if (PhoneticCostEngine.getSubstitutionCost(asrCode, refCode) > 0.0) {
        isPartial = true;
      }
    }
  } else if (bestI < 0) {
    // ── 1. Prefix Match (For words that failed the full cost threshold) ──
    const minJ = n > 2 ? 2 : 1;
    const startI = Math.max(1, m - 2);
    for (let i = startI; i <= m && !isPartial; i++) {
      for (let j = minJ; j < n; j++) {
        if (dp[i * stride + j] / j <= threshold) {
          isPartial = true;
          break;
        }
      }
    }
  }

  if (isPartial) {
    return {
      pathCost: 0.0,
      tokensConsumed: 0,
      cleanAsr: '',
      timestamps: [],
      trace: [],
      isPartial: true,
    };
  }

  // If no full match was found and prefix match also failed, it's a complete mismatch
  if (bestI < 0) {
    return null;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 6. TRACEBACK & RESULTS (dictation_matcher.dart:491-547)
  // ═════════════════════════════════════════════════════════════════════════
  let ci = bestI, cj = n;
  const rawTrace: PhonemeGroupAlignment[] = [];
  const ts: number[] = [];

  while (cj > 0) {
    if (ci === 0) {
      rawTrace.push({
        opType: 'delete',
        refIdx: refStart + cj - 1,
        predIdx: -1,
      });
      cj--;
      continue;
    }

    const op = bt[ci * stride + cj];
    const gRef = refStart + cj - 1;

    if (op === 0) {
      const asrCode = asrText.charCodeAt(ci - 1);
      const refCode = fullPhonemes.charCodeAt(gRef);
      const isMatch = PhoneticCostEngine.getSubstitutionCost(asrCode, refCode) === 0.0;
      rawTrace.push({
        opType: isMatch ? 'match' : 'replace',
        refIdx: gRef,
        predIdx: ci - 1,
      });
      if (ci - 1 < asrTimestamps.length) ts.push(asrTimestamps[ci - 1]);
      ci--;
      cj--;
    } else if (op === 1) {
      rawTrace.push({ opType: 'delete', refIdx: gRef, predIdx: -1 });
      cj--;
    } else {
      rawTrace.push({ opType: 'insert', refIdx: gRef, predIdx: ci - 1 });
      ci--;
    }
  }

  return {
    pathCost: bestCost,
    tokensConsumed: bestI,
    cleanAsr: asrText.substring(0, bestI),
    timestamps: ts.slice().reverse(),
    trace: rawTrace.slice().reverse(),
    isPartial: false,
  };
}
