// tests/sequencer.test.ts — port verification for lib/tracking/word/dictation_sequencer.dart (455 lines)
import { copyWithConfig, normalConfig, TrackerConfig } from '../src/config';
import {
  DictationSequencer,
  SequencerEvent,
  SetSurahReferenceCmd,
  SyncStreamCmd,
} from '../src/engine/sequencer';
import {
  ErrorCategory,
  SpeechErrorType,
  TajweedDurationStatus,
  WordTajweedRule,
} from '../src/types';

type Highlight = Extract<SequencerEvent, { type: 'highlight' }>;
type Debug = Extract<SequencerEvent, { type: 'debug' }>;

const highlights = (events: SequencerEvent[]): Highlight[] =>
  events.filter((e): e is Highlight => e.type === 'highlight');
const debugs = (events: SequencerEvent[]): Debug[] =>
  events.filter((e): e is Debug => e.type === 'debug');

const tsOf = (n: number, step = 0.1): number[] =>
  Array.from({ length: n }, (_, i) => step * (i + 1));

interface Ref {
  phonemes: string;
  boundaries: number[];
  words: string[];
}

function buildRef(words: string[]): Ref {
  const phonemes = words.join('');
  const boundaries: number[] = [];
  let acc = 0;
  for (const w of words) {
    boundaries.push(acc);
    acc += w.length;
  }
  boundaries.push(acc);
  return { phonemes, boundaries, words };
}

function makeSeq(config: TrackerConfig = normalConfig()) {
  const events: SequencerEvent[] = [];
  const seq = new DictationSequencer((e) => {
    events.push(e);
  });
  seq.updateConfig(config);
  return { seq, events };
}

function setRef(seq: DictationSequencer, ref: Ref, over: Partial<SetSurahReferenceCmd> = {}) {
  seq.setSurahReference({
    phonemes: ref.phonemes,
    boundaries: ref.boundaries,
    surahNumber: 1,
    isTajweed: false,
    forceClear: true,
    startGlobalWord: 0,
    wordRules: null,
    ...over,
  });
}

function sync(seq: DictationSequencer, text: string, over: Partial<SyncStreamCmd> = {}) {
  seq.syncStream({
    text,
    timestamps: tsOf(text.length),
    isNewSegment: false,
    ayahNumber: 1,
    ...over,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// (a) CLEAN SEQUENTIAL MATCH — ordered green events (brief Step 1a)
// ═══════════════════════════════════════════════════════════════════════════

describe('(a) clean sequential match → ordered green events', () => {
  const ref = buildRef(['بسم', 'الله', 'رحمن']);

  test('single sync commits words 0..2 in order with score 1', () => {
    const { seq, events } = makeSeq();
    setRef(seq, ref);
    sync(seq, ref.phonemes);

    const hs = highlights(events);
    expect(hs.map((h) => h.wordId)).toEqual([0, 1, 2]);
    expect(hs.map((h) => h.cleanAsr)).toEqual(['بسم', 'الله', 'رحمن']);
    expect(hs.map((h) => h.score)).toEqual([1, 1, 1]);
    expect(hs.every((h) => !h.isRed && !h.isNeutral)).toBe(true);
    expect(hs.every((h) => h.tajweedErrors === null)).toBe(true);
  });

  test('chunked syncs accumulate greens without duplicates (match progression)', () => {
    const { seq, events } = makeSeq();
    setRef(seq, ref);

    sync(seq, ref.words[0]);
    expect(highlights(events).map((h) => h.wordId)).toEqual([0]);

    sync(seq, ref.words[0] + ref.words[1]);
    expect(highlights(events).map((h) => h.wordId)).toEqual([0, 1]);

    sync(seq, ref.phonemes);
    expect(highlights(events).map((h) => h.wordId)).toEqual([0, 1, 2]);
  });

  test('debug events carry the exact message and the asrBuffer from the anchor', () => {
    const { seq, events } = makeSeq();
    setRef(seq, ref);
    sync(seq, ref.phonemes);

    const dbg = debugs(events);
    expect(dbg.map((d) => d.message)).toEqual([
      '📖 Surah 1 | 3 words | cursor=0 | tajweed=false',
      '✅ [GREEN] Word 0 (Ref: "بسم") -> ASR: "بسم" (cost=0.00)',
      '✅ [GREEN] Word 1 (Ref: "الله") -> ASR: "الله" (cost=0.00)',
      '✅ [GREEN] Word 2 (Ref: "رحمن") -> ASR: "رحمن" (cost=0.00)',
    ]);
    expect(dbg.map((d) => d.asrBuffer)).toEqual([
      '',
      ref.phonemes,
      ref.phonemes.slice(3),
      ref.phonemes.slice(7),
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (b) GAP IN ASR — red event for the skipped word (brief Step 1b)
// ═══════════════════════════════════════════════════════════════════════════

describe('(b) gap in ASR → red event for the skipped word', () => {
  const ref = buildRef(['بسم', 'الله', 'رحمن']);

  test('omitted word 0 commits red before greens for words 1 and 2', () => {
    const { seq, events } = makeSeq();
    setRef(seq, ref);
    sync(seq, ref.words[1] + ref.words[2]);

    const hs = highlights(events);
    expect(hs.map((h) => h.wordId)).toEqual([0, 1, 2]);
    expect(hs[0]).toEqual({
      type: 'highlight',
      wordId: 0,
      score: 0,
      cleanAsr: '',
      tajweedErrors: null,
      isRed: true,
      isNeutral: false,
    });
    expect(hs[1]).toMatchObject({
      wordId: 1,
      score: 1,
      cleanAsr: ref.words[1],
      isRed: false,
      isNeutral: false,
    });
    expect(hs[2]).toMatchObject({
      wordId: 2,
      score: 1,
      cleanAsr: ref.words[2],
      isRed: false,
      isNeutral: false,
    });
    expect(
      debugs(events).some(
        (d) =>
          d.message ===
          '❌ [RED] Word 0 (Ref: "بسم") skipped because lookahead matched Word 1 (Ref: "الله")',
      ),
    ).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (c) MERGE ACROSS WORD BOUNDARY — Wasl commits both green (brief Step 1c)
// ═══════════════════════════════════════════════════════════════════════════

describe('(c) merge across word boundary (Wasl) commits both green', () => {
  const ref = buildRef(['حمد', 'لكم']);

  test("single-word match fails, 2-word merge commits both with shared score", () => {
    const { seq, events } = makeSeq();
    setRef(seq, ref);
    // Word 0's final 'د' is elided at the boundary (connected-speech Wasl)
    const asr = 'حم' + ref.words[1];
    sync(seq, asr);

    const hs = highlights(events);
    expect(hs.map((h) => h.wordId)).toEqual([0, 1]);
    expect(hs.map((h) => h.isRed)).toEqual([false, false]);
    for (const h of hs) {
      expect(h.score).toBeCloseTo(1 - 1 / 6, 10); // score = 1 - pathCost (1 deletion / 6 eff chars)
      expect(h.cleanAsr).toBe(asr);
      expect(h.tajweedErrors).toBeNull();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (d) PARTIAL MATCH — waits, then completes on the next sync (brief Step 1d)
// ═══════════════════════════════════════════════════════════════════════════

describe('(d) partial match waits, then completes on next sync', () => {
  const ref = buildRef(['بسم', 'الله', 'رحمن']);

  test('prefix of word 0 emits no event until the word completes', () => {
    const { seq, events } = makeSeq();
    setRef(seq, ref);

    sync(seq, 'بس');
    expect(highlights(events)).toEqual([]);

    sync(seq, ref.phonemes);
    const hs = highlights(events);
    expect(hs.map((h) => h.wordId)).toEqual([0, 1, 2]);
    expect(hs[0].score).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (e) HEAD-TRIM — stable matching across >100 chars + stale reset (brief 1e)
// ═══════════════════════════════════════════════════════════════════════════

describe('(e) head-trim keeps events stable across >100 chars', () => {
  const heads = 'ب ح ر س ع ف ك ل م ن ط ض ق غ ش ص ظ ج خ ذ'.split(' ');
  const words = heads.map((h) => h + 'محلبكن'); // 20 words × 7 chars
  const ref = buildRef(words);

  test('anchor > 100 trims to the 50-char cushion and keeps committing', () => {
    const { seq, events } = makeSeq();
    setRef(seq, ref);
    sync(seq, ref.phonemes.slice(0, 105)); // first 15 words = 105 chars

    expect(highlights(events).map((h) => h.wordId)).toEqual([...Array(15).keys()]);
    expect(seq.currentSegmentAsrText.length).toBe(50); // 105 - (105 - 50)
  });

  test('stale sync (text shorter than trimmed offset) resets and resumes', () => {
    const { seq, events } = makeSeq();
    setRef(seq, ref);
    sync(seq, ref.phonemes.slice(0, 105));
    events.length = 0;

    const stale = ref.phonemes.slice(105, 112); // word 15 only: 7 chars < offset 55
    sync(seq, stale);

    const hs = highlights(events);
    expect(hs.map((h) => h.wordId)).toEqual([15]);
    expect(hs[0].cleanAsr).toBe(stale);
    expect(hs[0].score).toBe(1);
    expect(seq.currentSegmentAsrText).toBe(stale);
  });

  test('non-stale sync continues from the anchor via substring(trimmedOffset)', () => {
    const { seq, events } = makeSeq();
    setRef(seq, ref);
    sync(seq, ref.phonemes.slice(0, 105));
    events.length = 0;

    sync(seq, ref.phonemes.slice(0, 112)); // 16 words = 112 chars ≥ offset 55 → no reset

    const hs = highlights(events);
    expect(hs.map((h) => h.wordId)).toEqual([15]);
    expect(seq.currentSegmentAsrText.length).toBe(57); // 112 - 55
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (f) SCORE FORMULA — score = max(0, 1 - pathCost) (brief Step 1f)
// ═══════════════════════════════════════════════════════════════════════════

describe('(f) score = max(0, 1 - pathCost)', () => {
  test('pathCost 1.0 floors the score at 0', () => {
    const ref = buildRef(['بسم']);
    const permissive = copyWithConfig(normalConfig(), {
      defaultMaxPathCost: 5,
      shortWordPathCost: 5,
      mediumWordPathCost: 5,
    });
    const { seq, events } = makeSeq(permissive);
    setRef(seq, ref);
    sync(seq, 'رزز'); // every reference character mismatches → pathCost = 1.0

    const hs = highlights(events);
    expect(hs).toHaveLength(1);
    expect(hs[0].score).toBe(0); // max(0, 1 - 1.0) = 0
    expect(hs[0].isRed).toBe(false);
    expect(hs[0].cleanAsr).toBe('رزز');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (g) TAJWEED ERRORS — attached only when isTajweed (brief Step 1g)
// ═══════════════════════════════════════════════════════════════════════════

describe('(g) tajweed errors attach only when isTajweed', () => {
  const ref = buildRef(['اا']);
  const wordRules: WordTajweedRule[][] = [
    [{ ruleId: 2, nameAr: 'X', nameEn: 'Y', goldenLen: 99 }],
  ];

  const run = (isTajweed: boolean): Highlight => {
    const { seq, events } = makeSeq();
    setRef(seq, ref, { isTajweed, wordRules });
    sync(seq, 'اا', { timestamps: [0.05, 0.05] });
    const hs = highlights(events);
    expect(hs).toHaveLength(1);
    return hs[0];
  };

  test('isTajweed=false → tajweedErrors stays null', () => {
    const h = run(false);
    expect(h).toMatchObject({ wordId: 0, score: 1, isRed: false, isNeutral: false });
    expect(h.tajweedErrors).toBeNull();
  });

  test('isTajweed=true → short Madd duration produces a defect error', () => {
    const h = run(true);
    expect(h.score).toBe(1);
    expect(h.tajweedErrors).not.toBeNull();
    expect(h.tajweedErrors).toHaveLength(1);

    const e = h.tajweedErrors![0];
    expect(e.errorType).toBe(ErrorCategory.tajweed);
    expect(e.speechErrorType).toBe(SpeechErrorType.replace);
    expect(e.durationStatus).toBe(TajweedDurationStatus.defect);
    expect(e.expectedPh).toBe('اا');
    expect(e.expectedDuration).toBeCloseTo(0.8, 10); // Monfasel goldenLen 4 × 0.20s
    expect(e.actualDuration).toBeCloseTo(0.1, 10); // 0.05 + 0.05 from the synced timestamps
    expect(e.expectedRule).toEqual({
      type: 'MonfaselMaddRule',
      nameAr: 'المد المنفصل',
      nameEn: 'Monfasel Madd',
      goldenLen: 4,
    });
    expect(e.predictedRule).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PENDING TAIL — early-matching reservation, drain and shield (L140-182, 260-280)
// ═══════════════════════════════════════════════════════════════════════════

describe('early-matching pending tail bookkeeping (reserve / drain / shield)', () => {
  const w0 = 'حمدللهكم'; // 8 chars; ASR of the first 6 leaves the tail 'كم'
  const asr1 = 'حمدلله';

  test('tail reserved when the match ends before the word reference end', () => {
    const { seq, events } = makeSeq();
    setRef(seq, buildRef([w0, 'كرم']));
    sync(seq, asr1);

    const hs = highlights(events);
    expect(hs).toHaveLength(1);
    expect(hs[0]).toMatchObject({ wordId: 0, score: 0.75, cleanAsr: asr1, isRed: false }); // 1 - 2/8
  });

  test('shield absorbs the reserved tail char instead of letting word 1 reuse it', () => {
    const ref = buildRef([w0, 'كرم']);

    const on = makeSeq();
    setRef(on.seq, ref);
    sync(on.seq, asr1);
    sync(on.seq, asr1 + 'كرم');
    // tail 'كم' ate the leading 'ك' → word 1 ('كرم') cannot match the residue 'رم'
    expect(highlights(on.events).map((h) => h.wordId)).toEqual([0]);

    const off = makeSeq(copyWithConfig(normalConfig(), { enableEarlyMatching: false }));
    setRef(off.seq, ref);
    sync(off.seq, asr1);
    sync(off.seq, asr1 + 'كرم');
    expect(highlights(off.events).map((h) => h.wordId)).toEqual([0, 1]);
    expect(highlights(off.events)[1].score).toBe(1);
  });

  test('full tail drain lifts the shield and word 1 then matches exactly', () => {
    const ref = buildRef([w0, 'كرم']);
    const { seq, events } = makeSeq();
    setRef(seq, ref);
    sync(seq, asr1);
    sync(seq, asr1 + 'كم' + 'كرم');

    const hs = highlights(events);
    expect(hs.map((h) => h.wordId)).toEqual([0, 1]);
    expect(hs[1]).toMatchObject({ wordId: 1, score: 1, cleanAsr: 'كرم' });
  });

  test('mismatch on the first tail char lifts the shield immediately', () => {
    const ref = buildRef([w0, 'رحمن']);
    const { seq, events } = makeSeq();
    setRef(seq, ref);
    sync(seq, asr1);
    sync(seq, asr1 + 'رحمن');

    const hs = highlights(events);
    expect(hs.map((h) => h.wordId)).toEqual([0, 1]);
    expect(hs[1]).toMatchObject({ wordId: 1, score: 1, cleanAsr: 'رحمن' });
  });

  test('madd vowel absorbs repeated frames without consuming the tail slot', () => {
    const ref = buildRef(['حمدللهكا', 'ورم']);
    const asr1b = 'حمدللهك'; // 7 chars; tail = 'ا' (madd)

    const on = makeSeq();
    setRef(on.seq, ref);
    sync(on.seq, asr1b);
    expect(highlights(on.events)[0]).toMatchObject({ wordId: 0, score: 0.875 }); // 1 - 1/8
    sync(on.seq, asr1b + 'و' + 'رم');
    // 'و' absorbed into the reserved 'ا' tail → word 1 ('ورم') only sees 'رم' → cannot match
    expect(highlights(on.events).map((h) => h.wordId)).toEqual([0]);

    const off = makeSeq(copyWithConfig(normalConfig(), { enableEarlyMatching: false }));
    setRef(off.seq, ref);
    sync(off.seq, asr1b);
    sync(off.seq, asr1b + 'و' + 'رم');
    expect(highlights(off.events).map((h) => h.wordId)).toEqual([0, 1]);
    expect(highlights(off.events)[1].score).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// NEW SEGMENT / AYAH BOUNDARY — syncStream reset semantics (L116-129)
// ═══════════════════════════════════════════════════════════════════════════

describe('new segment / ayah boundary resets the buffer, keeps cursor state', () => {
  const ref = buildRef(['بسم', 'الله', 'رحمن']);

  test('isNewSegment resets so matching restarts at the current cursor', () => {
    const { seq, events } = makeSeq();
    setRef(seq, ref);
    sync(seq, ref.words[0]);
    expect(highlights(events).map((h) => h.wordId)).toEqual([0]);

    sync(seq, ref.words[1] + ref.words[2], { isNewSegment: true, ayahNumber: 2 });

    const hs = highlights(events);
    expect(hs.map((h) => h.wordId)).toEqual([0, 1, 2]);
    expect(hs[1]).toMatchObject({ wordId: 1, isRed: false, score: 1, cleanAsr: ref.words[1] });
    expect(debugs(events).some((d) => d.message === '🔄 New segment')).toBe(true);
    expect(seq.currentSegmentAsrText).toBe(ref.words[1] + ref.words[2]);
  });

  test('ayahNumber is carried but unused (parity with Dart SyncStreamCommand)', () => {
    const a = makeSeq();
    setRef(a.seq, ref);
    sync(a.seq, ref.phonemes, { ayahNumber: 1 });

    const b = makeSeq();
    setRef(b.seq, ref);
    sync(b.seq, ref.phonemes, { ayahNumber: 7 });

    expect(b.events).toEqual(a.events);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// setSurahReference — reference swap, spaces, forceClear, startGlobalWord (L73-101)
// ═══════════════════════════════════════════════════════════════════════════

describe('setSurahReference', () => {
  const ref = buildRef(['بسم', 'الله', 'رحمن']);

  test('spaces are stripped from the phoneme reference (L75)', () => {
    const { seq, events } = makeSeq();
    setRef(seq, { ...ref, phonemes: 'بسم الله رحمن' });
    expect(seq.fullPhonemes).toBe(ref.phonemes);

    sync(seq, ref.phonemes);
    const hs = highlights(events);
    expect(hs.map((h) => [h.wordId, h.score, h.cleanAsr])).toEqual([
      [0, 1, 'بسم'],
      [1, 1, 'الله'],
      [2, 1, 'رحمن'],
    ]);
  });

  test('forceClear=false reprocesses the retained buffer immediately', () => {
    const { seq, events } = makeSeq();
    setRef(seq, ref);
    sync(seq, ref.phonemes);
    expect(highlights(events)).toHaveLength(3);
    events.length = 0;

    seq.setSurahReference({
      phonemes: ref.phonemes,
      boundaries: ref.boundaries,
      surahNumber: 1,
      isTajweed: false,
      forceClear: false,
      startGlobalWord: 0,
      wordRules: null,
    });
    // committed sets cleared → the retained buffer re-emits every green
    expect(highlights(events).map((h) => h.wordId)).toEqual([0, 1, 2]);
  });

  test('forceClear=true drops the retained buffer (no reprocess)', () => {
    const { seq, events } = makeSeq();
    setRef(seq, ref);
    sync(seq, ref.phonemes);
    events.length = 0;

    seq.setSurahReference({
      phonemes: ref.phonemes,
      boundaries: ref.boundaries,
      surahNumber: 1,
      isTajweed: false,
      forceClear: true,
      startGlobalWord: 0,
      wordRules: null,
    });
    expect(highlights(events)).toEqual([]);
    expect(seq.currentSegmentAsrText).toBe('');
  });

  test('startGlobalWord clamps into [0, wordCount]', () => {
    const high = makeSeq();
    setRef(high.seq, ref, { startGlobalWord: 99 });
    sync(high.seq, ref.phonemes);
    expect(highlights(high.events)).toEqual([]); // cursor parked at wordCount

    const low = makeSeq();
    setRef(low.seq, ref, { startGlobalWord: -5 });
    sync(low.seq, ref.phonemes);
    expect(highlights(low.events).map((h) => h.wordId)).toEqual([0, 1, 2]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// jumpToWord — buffer clear + committed >= cursor removal (L103-114)
// ═══════════════════════════════════════════════════════════════════════════

describe('jumpToWord', () => {
  const ref = buildRef(['بسم', 'الله', 'رحمن']);

  test('clears the buffer and re-commits only from the jumped word', () => {
    const { seq, events } = makeSeq();
    setRef(seq, ref);
    sync(seq, ref.phonemes);
    expect(highlights(events).map((h) => h.wordId)).toEqual([0, 1, 2]);

    seq.jumpToWord(1);
    expect(seq.currentSegmentAsrText).toBe('');
    expect(debugs(events).some((d) => d.message === '🎯 Jumped to word 1')).toBe(true);
    events.length = 0;

    sync(seq, ref.words[1] + ref.words[2]);
    expect(highlights(events).map((h) => h.wordId)).toEqual([1, 2]); // word 0 stays committed
  });

  test('clamps out-of-range targets', () => {
    const high = makeSeq();
    setRef(high.seq, ref);
    high.seq.jumpToWord(99);
    sync(high.seq, ref.phonemes);
    expect(highlights(high.events)).toEqual([]); // cursor parked at wordCount

    const low = makeSeq();
    setRef(low.seq, ref);
    sync(low.seq, ref.phonemes);
    expect(highlights(low.events)).toHaveLength(3);
    low.seq.jumpToWord(-3); // → 0, removes every committed word (w >= 0)
    low.events.length = 0;
    sync(low.seq, ref.phonemes);
    expect(highlights(low.events).map((h) => h.wordId)).toEqual([0, 1, 2]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// updateConfig & setTajweedMode (brief interface)
// ═══════════════════════════════════════════════════════════════════════════

describe('updateConfig & setTajweedMode', () => {
  const ref = buildRef(['بسم', 'الله', 'رحمن']);

  test('updateConfig(maxSkipWords: 0) disables lookahead — nothing commits', () => {
    const { seq, events } = makeSeq(copyWithConfig(normalConfig(), { maxSkipWords: 0 }));
    setRef(seq, ref);
    sync(seq, ref.words[1] + ref.words[2]);
    expect(highlights(events)).toEqual([]);
  });

  test('setTajweedMode toggles the strict-frontier partial behavior', () => {
    const r = buildRef(['رحمن']);
    const { seq, events } = makeSeq();
    setRef(seq, r);

    seq.setTajweedMode(true);
    expect(seq.isTajweed).toBe(true);
    sync(seq, 'رحم'); // core consonant 'ن' missing → strict frontier waits
    expect(highlights(events)).toEqual([]);

    sync(seq, 'رحمن');
    expect(highlights(events).map((h) => h.wordId)).toEqual([0]);

    seq.setTajweedMode(false);
    expect(seq.isTajweed).toBe(false);
  });
});
