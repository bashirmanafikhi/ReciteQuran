// tests/errorExplainer.test.ts — port verification for lib/tracking/tajweed/error_explainer.dart (703 lines)
import { normalConfig } from '../src/config';
import {
  ErrorCategory,
  PhonemeGroupAlignment,
  SpeechErrorType,
  TajweedDurationStatus,
  WordTajweedRule,
} from '../src/types';
import {
  EvaluatePreAlignedWordsArgs,
  ReciterError,
  _instantiateTajweedRule,
  evaluatePreAlignedWords,
} from '../src/tajweed/errorExplainer';
import { MonfaselMaddRule, NormalMaddRule } from '../src/tajweed/rules';

const cfg = normalConfig(); // harakatDurationSeconds = 0.20, hideExpectedAsrNoise = true

function baseArgs(over: Partial<EvaluatePreAlignedWordsArgs> = {}): EvaluatePreAlignedWordsArgs {
  return {
    alignments: [],
    fullPhonemes: '',
    wordBoundaries: [0, 0],
    currentAsrText: '',
    trackingTimestamps: [],
    bestAsrStartIdx: 0,
    targetCharCursor: 0,
    startWordId: 0,
    nextWordId: 1,
    totalAyahWords: 1,
    expectedWordRules: [],
    config: cfg,
    ...over,
  };
}

const align = (refIdx: number, predIdx: number, opType = 'match'): PhonemeGroupAlignment => ({
  opType,
  refIdx,
  predIdx,
});

// ═══════════════════════════════════════════════════════════════════════════
// (a) DURATION AGGREGATION — unique predIdx (error_explainer.dart:246-260)
// ═══════════════════════════════════════════════════════════════════════════

describe('duration aggregation (error_explainer.dart:246-260)', () => {
  test('a predIdx repeated across alignments is summed exactly once', () => {
    const result = evaluatePreAlignedWords(
      baseArgs({
        fullPhonemes: 'اا',
        wordBoundaries: [0, 2],
        currentAsrText: 'ا',
        trackingTimestamps: [0.1],
        alignments: [align(0, 0), align(1, 0)],
        expectedWordRules: [{ ruleId: 1, nameAr: '', nameEn: '', goldenLen: 1.2 }],
      }),
    );

    const errors = result.get(0)!;
    expect(errors).toHaveLength(1);
    // 0.10 counted once (0.20 would mean the duplicate predIdx was double-counted)
    expect(errors[0].actualDuration).toBeCloseTo(0.1, 10);
    expect(errors[0].durationStatus).toBe(TajweedDurationStatus.defect);
  });

  test('distinct predIdx values are each summed (absPred = bestAsrStartIdx + predIdx)', () => {
    const result = evaluatePreAlignedWords(
      baseArgs({
        fullPhonemes: 'اااا',
        wordBoundaries: [0, 4],
        currentAsrText: 'اااا',
        bestAsrStartIdx: 0,
        trackingTimestamps: [0.05, 0.05, 0.05, 0.05],
        alignments: [align(0, 0), align(1, 1), align(2, 2), align(3, 3)],
        expectedWordRules: [{ ruleId: 6, nameAr: '', nameEn: '', goldenLen: 6 }],
      }),
    );

    const errors = result.get(0)!;
    expect(errors).toHaveLength(1);
    expect(errors[0].actualDuration).toBeCloseTo(0.2, 10); // Lazem needs 1.20 → defect
    expect(errors[0].expectedRule!.type).toBe('LazemMaddRule');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (b) MADD DEFECT — serialized map shape (error_explainer.dart:78-90, 519-542)
// ═══════════════════════════════════════════════════════════════════════════

describe('Madd defect evaluation (error_explainer.dart:519-542)', () => {
  test('defect error map matches toMap() keys and ordinals exactly', () => {
    const result = evaluatePreAlignedWords(
      baseArgs({
        fullPhonemes: 'اا',
        wordBoundaries: [0, 2],
        currentAsrText: 'ا',
        trackingTimestamps: [0.1],
        alignments: [align(0, 0)],
        expectedWordRules: [{ ruleId: 2, nameAr: 'X', nameEn: 'Y', goldenLen: 99 }],
      }),
    );

    const errors = result.get(0)!;
    expect(errors).toHaveLength(1);
    const e = errors[0];

    expect(Object.keys(e)).toEqual([
      'errorType',
      'speechErrorType',
      'durationStatus',
      'expectedPh',
      'predictedPh',
      'expectedRule',
      'predictedRule',
      'expectedDuration',
      'actualDuration',
    ]);

    expect(e.errorType).toBe(ErrorCategory.tajweed);
    expect(e.speechErrorType).toBe(SpeechErrorType.replace);
    expect(e.durationStatus).toBe(TajweedDurationStatus.defect);
    expect(e.expectedPh).toBe('اا');
    expect(e.predictedPh).toBe('ا');
    expect(e.expectedRule).toEqual({
      type: 'MonfaselMaddRule',
      nameAr: 'المد المنفصل',
      nameEn: 'Monfasel Madd',
      goldenLen: 4, // rule-class goldenLen, JSON goldenLen 99 ignored
    });
    expect(e.predictedRule).toBeNull();
    expect(e.expectedDuration).toBeCloseTo(0.8, 10); // 4 * 0.20
    expect(e.actualDuration).toBeCloseTo(0.1, 10);
  });

  test('duration >= required produces no tajweed error (defect-only)', () => {
    const result = evaluatePreAlignedWords(
      baseArgs({
        fullPhonemes: 'اا',
        wordBoundaries: [0, 2],
        currentAsrText: 'اا',
        trackingTimestamps: [0.5, 0.4],
        alignments: [align(0, 0), align(1, 1)],
        expectedWordRules: [{ ruleId: 1, nameAr: '', nameEn: '', goldenLen: 1.2 }],
      }),
    );

    expect(result.size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (c) SURPLUS FILTERING (error_explainer.dart:285-291)
// ═══════════════════════════════════════════════════════════════════════════

describe('post-processing filters (error_explainer.dart:285-291)', () => {
  test('surplus duration errors are dropped; other errors in the same word survive', () => {
    // 'رر' = Shaddah span held 1.00s (surplus, and only one 'ر' predicted → error produced),
    // 'ب'  = deleted base consonant (normal error, not ASR noise) must survive.
    const result = evaluatePreAlignedWords(
      baseArgs({
        fullPhonemes: 'ررب',
        wordBoundaries: [0, 3],
        currentAsrText: 'رَ',
        trackingTimestamps: [1.0, 0.0],
        alignments: [align(0, 0), align(1, 1), align(2, 9, 'delete')],
      }),
    );

    const errors = result.get(0)!;
    expect(errors).toHaveLength(1);
    expect(errors[0].errorType).toBe(ErrorCategory.normal);
    expect(errors[0].speechErrorType).toBe(SpeechErrorType.delete);
    expect(errors[0].expectedPh).toBe('ب');
    expect(errors[0].predictedPh).toBe('');
  });

  test('normal errors on expected ASR noise are dropped when hideExpectedAsrNoise', () => {
    const noisy = evaluatePreAlignedWords(
      baseArgs({
        fullPhonemes: 'ا',
        wordBoundaries: [0, 1],
        currentAsrText: 'ز',
        trackingTimestamps: [0.1],
        alignments: [align(0, 9, 'delete')],
        config: { ...cfg, hideExpectedAsrNoise: true },
      }),
    );
    expect(noisy.size).toBe(0);

    const shown = evaluatePreAlignedWords(
      baseArgs({
        fullPhonemes: 'ا',
        wordBoundaries: [0, 1],
        currentAsrText: 'ز',
        trackingTimestamps: [0.1],
        alignments: [align(0, 9, 'delete')],
        config: { ...cfg, hideExpectedAsrNoise: false },
      }),
    );
    const errors = shown.get(0)!;
    expect(errors).toHaveLength(1);
    expect(errors[0].errorType).toBe(ErrorCategory.normal);
    expect(errors[0].speechErrorType).toBe(SpeechErrorType.delete);
    expect(errors[0].expectedPh).toBe('ا');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (d) ruleId → class mapping (error_explainer.dart:647-676)
// ═══════════════════════════════════════════════════════════════════════════

describe('_instantiateTajweedRule mapping (error_explainer.dart:647-676)', () => {
  const maddCases: Array<[number, string, number, number]> = [
    [1, 'NormalMaddRule', 1.2, 0.24],
    [2, 'MonfaselMaddRule', 4, 0.8],
    [3, 'MottaselMaddRule', 4, 0.8],
    [4, 'MottaselMaddPauseRule', 4, 0.8],
    [5, 'AaredMaddRule', 4, 0.8],
    [6, 'LazemMaddRule', 6, 1.2],
    [7, 'LeenMaddRule', 4, 0.8],
  ];

  test.each(maddCases)(
    'ruleId %i → %s with class goldenLen (JSON goldenLen ignored)',
    (ruleId, type, goldenLen, required) => {
      const result = evaluatePreAlignedWords(
        baseArgs({
          fullPhonemes: 'اا',
          wordBoundaries: [0, 2],
          currentAsrText: 'ا',
          trackingTimestamps: [0.1],
          alignments: [align(0, 0)],
          expectedWordRules: [{ ruleId, nameAr: 'مرفوض', nameEn: 'Ignored', goldenLen: 99 }],
        }),
      );

      const e = result.get(0)![0];
      expect(e.expectedRule!.type).toBe(type);
      expect(e.expectedRule!.goldenLen).toBe(goldenLen);
      expect(e.expectedRule!.nameAr).not.toBe('مرفوض');
      expect(e.expectedDuration).toBeCloseTo(required, 10);
      expect(e.durationStatus).toBe(TajweedDurationStatus.defect); // 0.10 < required
    },
  );

  test('ruleId 10 → MushaddadGhunnahRule using the word-rule names, goldenLen forced to 2', () => {
    const result = evaluatePreAlignedWords(
      baseArgs({
        fullPhonemes: 'نننَ',
        wordBoundaries: [0, 4],
        currentAsrText: 'ن',
        trackingTimestamps: [0.1],
        alignments: [align(0, 0)],
        expectedWordRules: [
          { ruleId: 10, nameAr: 'النون المشددة', nameEn: 'Mushaddad Noon', goldenLen: 99 },
        ],
      }),
    );

    const e = result.get(0)![0];
    expect(e.expectedRule).toEqual({
      type: 'MushaddadGhunnahRule',
      nameAr: 'النون المشددة',
      nameEn: 'Mushaddad Noon',
      goldenLen: 2,
    });
    expect(e.expectedDuration).toBeCloseTo(0.4, 10);
    expect(e.durationStatus).toBe(TajweedDurationStatus.defect);
  });

  test('unmapped ruleId (e.g. 8) → MaddRule carrying the JSON goldenLen', () => {
    const rule = _instantiateTajweedRule({
      ruleId: 8,
      nameAr: 'مخصص',
      nameEn: 'Custom',
      goldenLen: 3,
    });

    expect(rule.type).toBe('MaddRule');
    expect(rule.goldenLen).toBe(3);
    expect(rule.name.ar).toBe('مخصص');
    expect(rule.name.en).toBe('Custom');
    expect(rule.toRuleMap()).toEqual({
      type: 'MaddRule',
      nameAr: 'مخصص',
      nameEn: 'Custom',
      goldenLen: 3,
    });
  });

  test('Madd span with no matching word rule derives the class from span length (error_explainer.dart:623-627)', () => {
    const short = evaluatePreAlignedWords(
      baseArgs({
        fullPhonemes: 'اا',
        wordBoundaries: [0, 2],
        currentAsrText: 'ا',
        trackingTimestamps: [0.1],
        alignments: [align(0, 0)],
        expectedWordRules: [{ ruleId: 8, nameAr: '', nameEn: '', goldenLen: 99 }],
      }),
    );
    const e = short.get(0)![0];
    expect(e.expectedRule!.type).toBe('NormalMaddRule'); // len 2 < 4
    expect(e.expectedDuration).toBeCloseTo(0.24, 10);

    const long = evaluatePreAlignedWords(
      baseArgs({
        fullPhonemes: 'اااااا',
        wordBoundaries: [0, 6],
        currentAsrText: 'ا',
        trackingTimestamps: [0.1],
        alignments: [align(0, 0)],
        expectedWordRules: [{ ruleId: 8, nameAr: '', nameEn: '', goldenLen: 99 }],
      }),
    );
    const e2 = long.get(0)![0];
    expect(e2.expectedRule!.type).toBe('LazemMaddRule'); // len 6 >= 6
    expect(e2.expectedDuration).toBeCloseTo(1.2, 10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (e) DEDUPLICATION (error_explainer.dart:293-302)
// ═══════════════════════════════════════════════════════════════════════════

describe('deduplication (error_explainer.dart:293-302)', () => {
  test('two spans yielding the same errorType_ruleType_expectedPh keep only the first', () => {
    const result = evaluatePreAlignedWords(
      baseArgs({
        fullPhonemes: 'ااباا',
        wordBoundaries: [0, 5],
        currentAsrText: 'ا',
        trackingTimestamps: [0.1],
        alignments: [align(0, 0), align(1, 0), align(3, 0), align(4, 0)],
      }),
    );

    const errors = result.get(0)!;
    expect(errors).toHaveLength(1);
    expect(errors[0].errorType).toBe(ErrorCategory.tajweed);
    expect(errors[0].expectedPh).toBe('اا');
    expect(errors[0].expectedRule!.type).toBe('NormalMaddRule');
    expect(errors[0].actualDuration).toBeCloseTo(0.1, 10);
  });

  test('errors differing only by category are not deduplicated', () => {
    // 'تَ' tashkeel mismatch + deleted 'ب' normal error + Madd defect → all three survive
    const result = evaluatePreAlignedWords(
      baseArgs({
        fullPhonemes: 'تَباا',
        wordBoundaries: [0, 5],
        currentAsrText: 'تُتا',
        trackingTimestamps: [0, 0, 0, 0.1],
        alignments: [align(0, 0), align(1, 1), align(2, 2), align(3, 3), align(4, 3)],
        expectedWordRules: [{ ruleId: 1, nameAr: '', nameEn: '', goldenLen: 1.2 }],
      }),
    );

    const errors = result.get(0)!;
    expect(errors).toHaveLength(3);
    // sort priority: normal=0, tashkeel=1, Madd=2 (error_explainer.dart:694-701)
    expect(errors.map((e) => e.errorType)).toEqual([
      ErrorCategory.normal,
      ErrorCategory.tashkeel,
      ErrorCategory.tajweed,
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TASHKEEL PHASE + terminal-waqf exception (error_explainer.dart:597-614)
// ═══════════════════════════════════════════════════════════════════════════

describe('tashkeel phase (error_explainer.dart:597-614)', () => {
  test('sukoon on the terminal letter is waqf, not a tashkeel error', () => {
    const terminal = evaluatePreAlignedWords(
      baseArgs({
        fullPhonemes: 'بَ',
        wordBoundaries: [0, 2],
        currentAsrText: 'ب',
        trackingTimestamps: [0.1],
        alignments: [align(0, 0)],
      }),
    );
    expect(terminal.size).toBe(0);

    const nonTerminal = evaluatePreAlignedWords(
      baseArgs({
        fullPhonemes: 'بَت',
        wordBoundaries: [0, 3],
        currentAsrText: 'ب',
        trackingTimestamps: [0.1],
        alignments: [align(0, 0)],
      }),
    );
    const errors = nonTerminal.get(0)!;
    expect(errors).toHaveLength(1);
    expect(errors[0].errorType).toBe(ErrorCategory.tashkeel);
    expect(errors[0].speechErrorType).toBe(SpeechErrorType.replace);
    expect(errors[0].expectedPh).toBe('بَ');
    expect(errors[0].predictedPh).toBe('ب');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ReciterError serialization (error_explainer.dart:73-142)
// ═══════════════════════════════════════════════════════════════════════════

describe('ReciterError toMap/fromMap (error_explainer.dart:78-142)', () => {
  test('toMap → fromMap round trip preserves categories, rule class and durations', () => {
    const err = new ReciterError({
      errorType: ErrorCategory.tajweed,
      speechErrorType: SpeechErrorType.replace,
      durationStatus: TajweedDurationStatus.defect,
      expectedPh: 'اا',
      predictedPh: 'ا',
      expectedRule: new MonfaselMaddRule(),
      expectedDuration: 0.5,
      actualDuration: 0.25,
    });

    const map = err.toMap();
    expect(Object.keys(map)).toEqual([
      'errorType',
      'speechErrorType',
      'durationStatus',
      'expectedPh',
      'predictedPh',
      'expectedRule',
      'predictedRule',
      'expectedDuration',
      'actualDuration',
    ]);
    expect(map.errorType).toBe(0);
    expect(map.speechErrorType).toBe(2);
    expect(map.durationStatus).toBe(1);

    const back = ReciterError.fromMap(map);
    expect(back.errorType).toBe(ErrorCategory.tajweed);
    expect(back.speechErrorType).toBe(SpeechErrorType.replace);
    expect(back.durationStatus).toBe(TajweedDurationStatus.defect);
    expect(back.expectedPh).toBe('اا');
    expect(back.predictedPh).toBe('ا');
    expect(back.expectedRule!.type).toBe('MonfaselMaddRule');
    expect(back.expectedRule!.goldenLen).toBe(4);
    expect(back.predictedRule).toBeNull();
    expect(back.expectedDuration).toBe(0.5);
    expect(back.actualDuration).toBe(0.25);
  });

  test('fromMap with absent rule/durations falls back to nulls', () => {
    const back = ReciterError.fromMap({
      errorType: 1,
      speechErrorType: 1,
      durationStatus: null,
      expectedPh: 'ب',
      predictedPh: '',
      expectedRule: null,
      predictedRule: null,
      expectedDuration: null,
      actualDuration: null,
    });
    expect(back.errorType).toBe(ErrorCategory.normal);
    expect(back.expectedRule).toBeNull();
    expect(back.expectedDuration).toBeNull();
  });

  test('toString matches the Dart debug format (error_explainer.dart:73-76)', () => {
    const err = new ReciterError({
      errorType: ErrorCategory.tajweed,
      speechErrorType: SpeechErrorType.replace,
      durationStatus: TajweedDurationStatus.defect,
      expectedPh: 'اا',
      predictedPh: 'ا',
      expectedRule: new NormalMaddRule(),
      expectedDuration: 0.5,
      actualDuration: 0.25,
    });
    expect(err.toString()).toBe(
      'ReciterError(type: ErrorCategory.tajweed, action: SpeechErrorType.replace, ' +
        'status: TajweedDurationStatus.defect, expected: "اا", predicted: "ا", ' +
        'expectedRule: Normal Madd, expDur: 0.5, actDur: 0.25)',
    );
  });
});
