// tests/matcher.test.ts — port verification for lib/tracking/word/dictation_matcher.dart (549 lines)
import { normalConfig, TrackerConfig } from '../src/config';
import { PhoneticCostEngine, matchWord, WordMatchResult } from '../src/engine/matcher';

const ch = (c: number): string => String.fromCharCode(c);
const cfg = (over: Partial<TrackerConfig> = {}): TrackerConfig => ({ ...normalConfig(), ...over });

const T = (n: number): number[] => Array.from({ length: n }, (_, i) => 0.1 * (i + 1));

// ═══════════════════════════════════════════════════════════════════════════
// PHONETIC COST ENGINE — table-driven (dictation_matcher.dart:58-214)
// ═══════════════════════════════════════════════════════════════════════════

describe('zero-cost markers (dictation_matcher.dart:60-66)', () => {
  test.each([0x0686, 0x06dc, 0x0619, 0x06ea, 0x0640])('0x%s is a zero-cost marker', (c) => {
    expect(PhoneticCostEngine.isZeroCostMarker(c)).toBe(true);
  });
  test.each([0x0621, 0x0645, 0x064e, 0x0628])('0x%s is not a zero-cost marker', (c) => {
    expect(PhoneticCostEngine.isZeroCostMarker(c)).toBe(false);
  });
});

describe('tashkeel / madd vowel detectors (dictation_matcher.dart:138-143)', () => {
  test.each([0x064e, 0x064f, 0x0650])('0x%s is tashkeel (Fatha/Damma/Kasra)', (c) =>
    expect(PhoneticCostEngine.isTashkeel(c)).toBe(true));
  test.each([0x0652, 0x064b, 0x0640, 0x0628])('0x%s is not tashkeel', (c) =>
    expect(PhoneticCostEngine.isTashkeel(c)).toBe(false));
  test.each([0x0627, 0x0648, 0x064a, 0x06e5, 0x06e6])('0x%s is a madd vowel', (c) =>
    expect(PhoneticCostEngine.isMaddVowel(c)).toBe(true));
  test.each([0x0646, 0x0645, 0x064e])('0x%s is not a madd vowel', (c) =>
    expect(PhoneticCostEngine.isMaddVowel(c)).toBe(false));
});

describe('equivalent glyph pairs (dictation_matcher.dart:69-91)', () => {
  const equiv: Array<[number, number, string]> = [
    [0x0645, 0x06fe, 'م <-> ۾ (Iqlab)'],
    [0x0646, 0x06ba, 'ن <-> ں (Ikhfaa)'],
    [0x0648, 0x06e5, 'و <-> ۥ (Waw)'],
    [0x064a, 0x06e6, 'ي <-> ۦ (Yaa)'],
    [0x0621, 0x0622, 'ء <-> آ'],
    [0x0621, 0x0623, 'ء <-> أ'],
    [0x0621, 0x0625, 'ء <-> إ'],
    [0x0621, 0x0672, 'ء <-> ٲ'],
    [0x0622, 0x0625, 'آ <-> إ'],
    [0x0629, 0x0647, 'ة <-> ه'],
  ];
  test.each(equiv)('equivalent both orders: %s', (a, b) => {
    expect(PhoneticCostEngine.isEquivalentGlyph(a, b)).toBe(true);
    expect(PhoneticCostEngine.isEquivalentGlyph(b, a)).toBe(true);
    expect(PhoneticCostEngine.getSubstitutionCost(a, b)).toBe(0.0);
    expect(PhoneticCostEngine.getSubstitutionCost(b, a)).toBe(0.0);
  });
  test('identical codes are equivalent', () => {
    expect(PhoneticCostEngine.isEquivalentGlyph(0x0628, 0x0628)).toBe(true);
  });
  test('Haa vs Taa are NOT equivalent (comment at :86)', () => {
    expect(PhoneticCostEngine.isEquivalentGlyph(0x0647, 0x062a)).toBe(false);
    expect(PhoneticCostEngine.isEquivalentGlyph(0x062a, 0x0647)).toBe(false);
    expect(PhoneticCostEngine.getSubstitutionCost(0x0647, 0x062a)).toBe(1.0);
    expect(PhoneticCostEngine.getSubstitutionCost(0x062a, 0x0647)).toBe(1.0);
  });
  test('Taa vs Ta-Marbuta: condition at :88 is unreachable after the :73-77 swap (dead code preserved)', () => {
    // After normalization asrCode is always the SMALLER unit (ة=0x0629 < ت=0x062A),
    // so `asrCode == 0x062A && refCode == 0x0629` can never hold — actual Dart
    // behavior is cost 1.0 despite the 'ت <-> ة' comment. Ported line-by-line.
    expect(PhoneticCostEngine.isEquivalentGlyph(0x062a, 0x0629)).toBe(false);
    expect(PhoneticCostEngine.isEquivalentGlyph(0x0629, 0x062a)).toBe(false);
    expect(PhoneticCostEngine.getSubstitutionCost(0x062a, 0x0629)).toBe(1.0);
    expect(PhoneticCostEngine.getSubstitutionCost(0x0629, 0x062a)).toBe(1.0);
  });
});

describe('acoustic confusion pairs → acousticConfusionCost (dictation_matcher.dart:97-135)', () => {
  const pairs: Array<[number, number, string]> = [
    [0x0627, 0x064e, 'ا <-> fatha'],
    [0x0648, 0x064f, 'و <-> damma'],
    [0x064f, 0x06e5, 'damma <-> small waw'],
    [0x064a, 0x0650, 'ي <-> kasra'],
    [0x0650, 0x06e6, 'kasra <-> small yaa'],
    [0x062a, 0x0637, 'ت <-> ط'],
    [0x062c, 0x0632, 'ج <-> ز'],
    [0x062e, 0x063a, 'خ <-> غ'],
    [0x062f, 0x0636, 'د <-> ض'],
    [0x0630, 0x0632, 'ذ <-> ز'],
    [0x0630, 0x0638, 'ذ <-> ظ'],
    [0x0633, 0x0635, 'س <-> ص'],
    [0x0642, 0x0643, 'ق <-> ك'],
  ];
  test.each(pairs)('confusion both orders default acc: %s', (a, b) => {
    expect(PhoneticCostEngine.isAcousticConfusion(a, b)).toBe(true);
    expect(PhoneticCostEngine.isAcousticConfusion(b, a)).toBe(true);
    expect(PhoneticCostEngine.getSubstitutionCost(a, b)).toBe(0.25);
    expect(PhoneticCostEngine.getSubstitutionCost(b, a)).toBe(0.25);
  });
  test('custom acousticConfusionCost parameter is honoured', () => {
    expect(PhoneticCostEngine.getSubstitutionCost(0x0627, 0x064e, 0.5)).toBe(0.5);
    expect(PhoneticCostEngine.getSubstitutionCost(0x062a, 0x0637, 0.5)).toBe(0.5);
  });
  test('acoustic confusion is checked BEFORE tashkeel penalty (:157-165)', () => {
    // Damma (tashkeel) vs Small Waw is in the matrix → 0.25, not 1.00
    expect(PhoneticCostEngine.getSubstitutionCost(0x064f, 0x06e5)).toBe(0.25);
    // Fatha (tashkeel) vs Alif is in the matrix → 0.25, not 1.00
    expect(PhoneticCostEngine.getSubstitutionCost(0x064e, 0x0627)).toBe(0.25);
  });
  test('non-pair confusions are rejected', () => {
    expect(PhoneticCostEngine.isAcousticConfusion(0x0628, 0x062c)).toBe(false);
    expect(PhoneticCostEngine.isAcousticConfusion(0x0645, 0x0646)).toBe(false);
    expect(PhoneticCostEngine.isAcousticConfusion(0x0628, 0x0628)).toBe(false);
  });
});

describe('substitution cost check order: equal → equivalent → acoustic → tashkeel → 1.0 (:146-168)', () => {
  test('identical codes cost 0 (even tashkeel)', () => {
    expect(PhoneticCostEngine.getSubstitutionCost(0x064e, 0x064e)).toBe(0.0);
    expect(PhoneticCostEngine.getSubstitutionCost(0x0628, 0x0628)).toBe(0.0);
  });
  test('tashkeel not in the matrix → 1.00 strict harakat penalty', () => {
    expect(PhoneticCostEngine.getSubstitutionCost(0x064e, 0x064f)).toBe(1.0);
    expect(PhoneticCostEngine.getSubstitutionCost(0x0650, 0x064b)).toBe(1.0);
    expect(PhoneticCostEngine.getSubstitutionCost(0x064e, 0x0628)).toBe(1.0);
    expect(PhoneticCostEngine.getSubstitutionCost(0x0628, 0x064e)).toBe(1.0);
  });
  test('plain consonant mismatch → 1.0', () => {
    expect(PhoneticCostEngine.getSubstitutionCost(0x0628, 0x062c)).toBe(1.0);
    expect(PhoneticCostEngine.getSubstitutionCost(0x0645, 0x0646)).toBe(1.0);
    expect(PhoneticCostEngine.getSubstitutionCost(0x0648, 0x0644)).toBe(1.0);
  });
});

describe('deletion cost (dictation_matcher.dart:171-192)', () => {
  test('out-of-range index → standardDeletionCost', () => {
    expect(PhoneticCostEngine.getDeletionCost('بسم', -1)).toBe(1.0);
    expect(PhoneticCostEngine.getDeletionCost('بسم', 3)).toBe(1.0);
  });
  test('zero-cost marker → 0.0', () => {
    expect(PhoneticCostEngine.getDeletionCost('بـ', 1)).toBe(0.0);
    expect(PhoneticCostEngine.getDeletionCost('ـب', 0)).toBe(0.0);
    expect(PhoneticCostEngine.getDeletionCost('بۜ', 1)).toBe(0.0);
  });
  test('hamza variant → acousticConfusionCost', () => {
    expect(PhoneticCostEngine.getDeletionCost('بء', 1)).toBe(0.25);
    expect(PhoneticCostEngine.getDeletionCost('بأ', 1)).toBe(0.25);
    expect(PhoneticCostEngine.getDeletionCost('بإ', 1)).toBe(0.25);
  });
  test('repeat of predecessor (CTC collapse) → acousticConfusionCost', () => {
    expect(PhoneticCostEngine.getDeletionCost('بب', 1)).toBe(0.25);
    expect(PhoneticCostEngine.getDeletionCost('ببب', 2)).toBe(0.25);
  });
  test('otherwise → standardDeletionCost', () => {
    expect(PhoneticCostEngine.getDeletionCost('بسم', 0)).toBe(1.0);
    expect(PhoneticCostEngine.getDeletionCost('بسم', 1)).toBe(1.0);
    expect(PhoneticCostEngine.getDeletionCost('بسس', 1)).toBe(1.0); // 'س' preceded by 'ب'
  });
  test('custom standard/acoustic parameters are honoured', () => {
    expect(PhoneticCostEngine.getDeletionCost('بسم', 1, 0.7, 0.5)).toBe(0.7);
    expect(PhoneticCostEngine.getDeletionCost('بب', 1, 0.7, 0.5)).toBe(0.5);
    expect(PhoneticCostEngine.getDeletionCost('بء', 1, 0.7, 0.5)).toBe(0.5);
  });
});

describe('insertion cost (dictation_matcher.dart:195-213)', () => {
  test('out-of-range index → standardInsertionCost', () => {
    expect(PhoneticCostEngine.getInsertionCost('بسم', -1)).toBe(1.0);
    expect(PhoneticCostEngine.getInsertionCost('بسم', 3)).toBe(1.0);
  });
  test('zero-cost marker → 0.0', () => {
    expect(PhoneticCostEngine.getInsertionCost('بـ', 1)).toBe(0.0);
    expect(PhoneticCostEngine.getInsertionCost('ـب', 0)).toBe(0.0);
  });
  test('repeat AND madd vowel → acousticConfusionCost', () => {
    expect(PhoneticCostEngine.getInsertionCost('اا', 1)).toBe(0.25);
    expect(PhoneticCostEngine.getInsertionCost('وو', 1)).toBe(0.25);
    expect(PhoneticCostEngine.getInsertionCost('يي', 1)).toBe(0.25);
  });
  test('repeat but NOT madd → standardInsertionCost (the AND matters)', () => {
    expect(PhoneticCostEngine.getInsertionCost('بب', 1)).toBe(1.0);
    expect(PhoneticCostEngine.getInsertionCost('سس', 1)).toBe(1.0);
  });
  test('madd vowel that is NOT a repeat → standardInsertionCost', () => {
    expect(PhoneticCostEngine.getInsertionCost('وا', 1)).toBe(1.0);
    expect(PhoneticCostEngine.getInsertionCost('ب', 0)).toBe(1.0);
  });
  test('custom standard/acoustic parameters are honoured', () => {
    expect(PhoneticCostEngine.getInsertionCost('بسم', 1, 0.7, 0.5)).toBe(0.7);
    expect(PhoneticCostEngine.getInsertionCost('اا', 1, 0.7, 0.5)).toBe(0.5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ALIGNMENT SCENARIOS (brief Step 1, scenarios a-f)
// ═══════════════════════════════════════════════════════════════════════════

describe('(a) exact match', () => {
  test("asr='بسم' vs ref='بسم' → pathCost 0, tokensConsumed 3", () => {
    const r = matchWord({
      asrText: 'بسم', asrTimestamps: [0.1, 0.2, 0.3],
      fullPhonemes: 'بسم', refStart: 0, refEnd: 3,
      config: cfg(), isTajweed: false,
    });
    expect(r).toEqual({
      pathCost: 0,
      tokensConsumed: 3,
      cleanAsr: 'بسم',
      timestamps: [0.1, 0.2, 0.3],
      trace: [
        { opType: 'match', refIdx: 0, predIdx: 0 },
        { opType: 'match', refIdx: 1, predIdx: 1 },
        { opType: 'match', refIdx: 2, predIdx: 2 },
      ],
      isPartial: false,
    });
  });
  test('refIdx is absolute (refStart offset preserved in trace)', () => {
    const r = matchWord({
      asrText: 'بسم', asrTimestamps: [0.1, 0.2, 0.3],
      fullPhonemes: 'سما' + 'بسم', refStart: 3, refEnd: 6,
      config: cfg(), isTajweed: true,
    });
    expect(r).not.toBeNull();
    expect(r!.trace.map((t) => t.refIdx)).toEqual([3, 4, 5]);
    expect(r!.tokensConsumed).toBe(3);
    expect(r!.pathCost).toBe(0);
  });
});

describe('(b) free-start: leading ASR noise is free', () => {
  test("asr='xxبسم' still matches, tokensConsumed >= 3", () => {
    const r = matchWord({
      asrText: 'xxبسم', asrTimestamps: [0.1, 0.2, 0.3, 0.4, 0.5],
      fullPhonemes: 'بسم', refStart: 0, refEnd: 3,
      config: cfg(), isTajweed: false,
    });
    expect(r).not.toBeNull();
    expect(r!.pathCost).toBe(0);
    expect(r!.tokensConsumed).toBeGreaterThanOrEqual(3);
    expect(r!.tokensConsumed).toBe(5);
    expect(r!.cleanAsr).toBe('xxبسم');
    // leading noise never appears in the trace (column 0 is free)
    expect(r!.trace).toEqual([
      { opType: 'match', refIdx: 0, predIdx: 2 },
      { opType: 'match', refIdx: 1, predIdx: 3 },
      { opType: 'match', refIdx: 2, predIdx: 4 },
    ]);
    expect(r!.timestamps).toEqual([0.3, 0.4, 0.5]);
    expect(r!.isPartial).toBe(false);
  });
});

describe('(c) threshold gating: short word (<=3 eff chars) rejects noise', () => {
  test("asr='بززز' vs ref='بسم' → null (effN=3, threshold 0.25)", () => {
    const r = matchWord({
      asrText: 'بززز', asrTimestamps: T(4),
      fullPhonemes: 'بسم', refStart: 0, refEnd: 3,
      config: cfg(), isTajweed: false,
    });
    expect(r).toBeNull();
  });
  test('identical short word passes the same threshold (contrast)', () => {
    const r = matchWord({
      asrText: 'بسم', asrTimestamps: T(3),
      fullPhonemes: 'بسم', refStart: 0, refEnd: 3,
      config: cfg(), isTajweed: false,
    });
    expect(r).not.toBeNull();
    expect(r!.pathCost).toBe(0);
  });
});

describe('(d) partial sentinel: Tajweed-on strict frontier misses a core consonant', () => {
  test("asr='الرحم' vs ref='الرحمن', Tajweed ON → partial sentinel", () => {
    const r = matchWord({
      asrText: 'الرحم', asrTimestamps: T(5),
      fullPhonemes: 'الرحمن', refStart: 0, refEnd: 6,
      config: cfg(), isTajweed: true,
    });
    expect(r).toEqual({
      pathCost: 0,
      tokensConsumed: 0,
      cleanAsr: '',
      timestamps: [],
      trace: [],
      isPartial: true,
    });
  });
  test('same input with Tajweed OFF → full match (no strict frontier)', () => {
    const r = matchWord({
      asrText: 'الرحم', asrTimestamps: T(5),
      fullPhonemes: 'الرحمن', refStart: 0, refEnd: 6,
      config: cfg(), isTajweed: false,
    });
    expect(r).not.toBeNull();
    expect(r!.isPartial).toBe(false);
    expect(r!.tokensConsumed).toBe(5);
    expect(r!.cleanAsr).toBe('الرحم');
    expect(r!.pathCost).toBeCloseTo(1 / 6, 12); // one deletion / effN 6
    // trailing omission is represented as `delete` at the END of the path
    expect(r!.trace[r!.trace.length - 1]).toEqual({ opType: 'delete', refIdx: 5, predIdx: -1 });
    expect(r!.trace.slice(0, 5).every((t, i) => t.opType === 'match' && t.refIdx === i)).toBe(true);
    expect(r!.timestamps).toEqual(T(5));
  });
});

describe('(e) null when nothing aligns', () => {
  test("asr='ققققق' vs ref='بسم' → null", () => {
    expect(matchWord({
      asrText: 'ققققق', asrTimestamps: T(5),
      fullPhonemes: 'بسم', refStart: 0, refEnd: 3,
      config: cfg(), isTajweed: false,
    })).toBeNull();
  });
  test('empty ASR → null', () => {
    expect(matchWord({
      asrText: '', asrTimestamps: [],
      fullPhonemes: 'بسم', refStart: 0, refEnd: 3,
      config: cfg(), isTajweed: false,
    })).toBeNull();
  });
  test('empty reference slice (refEnd <= refStart) → null', () => {
    expect(matchWord({
      asrText: 'بسم', asrTimestamps: T(3),
      fullPhonemes: 'بسم', refStart: 2, refEnd: 2,
      config: cfg(), isTajweed: false,
    })).toBeNull();
  });
});

describe('(f) deletion tie-break: equal sub/del prefers deletions (dictation_matcher.dart:321-334)', () => {
  test('trailing tie at the final cell resolves to `delete` (deletion trails)', () => {
    // at cell (2,2): sub == del == ins == 0.0 → bt = 1 (delete), NOT 0 (match)
    const r = matchWord({
      asrText: 'بـ', asrTimestamps: [0.1, 0.2],
      fullPhonemes: 'بـ', refStart: 0, refEnd: 2,
      config: cfg(), isTajweed: false,
    });
    expect(r).not.toBeNull();
    expect(r!.pathCost).toBe(0);
    expect(r!.tokensConsumed).toBe(2);
    expect(r!.trace.map((t) => t.opType)).toEqual(['match', 'insert', 'delete']);
    expect(r!.trace[r!.trace.length - 1]).toEqual({ opType: 'delete', refIdx: 1, predIdx: -1 });
    expect(r!.timestamps).toEqual([0.1]);
  });
  test('mid-path tie (sub == del == 1.0) resolves to `delete`, not `replace`', () => {
    // at cell (1,1): sub = del = 1.0, ins = 2.0 → sub<del is false → delete branch.
    // (A `sub <= del` rule would emit `replace` here instead.)
    const loose = cfg({ defaultMaxPathCost: 1.0, shortWordPathCost: 1.0, mediumWordPathCost: 1.0 });
    const r = matchWord({
      asrText: 'بب', asrTimestamps: [0.1, 0.2],
      fullPhonemes: 'جب', refStart: 0, refEnd: 2,
      config: loose, isTajweed: false,
    });
    expect(r).not.toBeNull();
    expect(r!.pathCost).toBeCloseTo(0.5, 12); // dp = 1.0 / effN 2
    expect(r!.tokensConsumed).toBe(2);
    expect(r!.trace).toEqual([
      { opType: 'delete', refIdx: 0, predIdx: -1 },
      { opType: 'match', refIdx: 1, predIdx: 1 },
    ]);
    expect(r!.timestamps).toEqual([0.2]);
  });
});
