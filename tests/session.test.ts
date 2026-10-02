// tests/session.test.ts — port verification for the session facade
// (lib/recite_quran.dart, 229 lines, read-only source of truth), including the
// per-character duration expansion that the port deliberately takes from
// HighlightingController._onResult (highlighting_controller.dart:612-619).
//
// The ASR side is stubbed (FakeAsrTransport) so the pipeline runs without React
// Native; the Quran side is the real assets/model/ordered_quran_phonemes.json
// (loaded once in beforeAll) plus a synthetic asset for hand-derived durations.

import * as fs from 'fs';
import * as path from 'path';

import { normalConfig, TrackerConfig } from '../src/config';
import { QuranMetadataService, QuranRepository } from '../src/data/quranData';
import { AsrTransport, CreateSessionOptions, ReciteQuran } from '../src/session';
import {
  ContinuousQuranWord,
  ErrorCategory,
  SpeechErrorType,
  TajweedDurationStatus,
  TranscriptionResult,
  WordMatchedEvent,
} from '../src/types';

const ASSET_PATH = path.join(__dirname, '..', 'assets', 'model', 'ordered_quran_phonemes.json');

// ═══════════════════════════════════════════════════════════════════════════
// Test doubles
// ═══════════════════════════════════════════════════════════════════════════

/** Records the exact call order the session makes into the transport. */
class FakeAsrTransport implements AsrTransport {
  readonly calls: string[] = [];
  failInitialize: Error | null = null;
  destroyed = false;
  private _onResult: ((r: TranscriptionResult) => void) | null = null;

  async initialize(): Promise<void> {
    this.calls.push('initialize');
    if (this.failInitialize !== null) throw this.failInitialize;
  }

  start(onResult: (r: TranscriptionResult) => void): void {
    this.calls.push('start');
    this._onResult = onResult;
  }

  async stop(): Promise<void> {
    this.calls.push('stop');
    this._onResult = null;
  }

  resetBuffer(): void {
    this.calls.push('resetBuffer');
  }

  destroy(): void {
    this.calls.push('destroy');
    this.destroyed = true;
    this._onResult = null;
  }

  /** Delivers one scripted TranscriptionResult (as the native engine would). */
  emit(result: Partial<TranscriptionResult> & { tokens: string[]; timestamps: number[] }): void {
    if (this._onResult === null) throw new Error('FakeAsrTransport: emit() with no active start()');
    this._onResult({
      text: '',
      isFinal: false,
      startTime: 0,
      streamEpoch: 0,
      ...result,
    });
  }

  /** Emits `tokens` one per result, each token spaced `step` seconds apart. */
  emitCumulative(tokens: string[], step = 0.3, startTs = step): void {
    for (let n = 1; n <= tokens.length; n++) {
      this.emit({
        tokens: tokens.slice(0, n),
        timestamps: tokens.slice(0, n).map((_, i) => startTs + step * i),
      });
    }
  }

  /** Spreads the phonemes of `words` into single-character tokens. */
  static chars(words: string[]): string[] {
    return words.join('').split('');
  }
}

interface SyntheticAyah {
  words: string[];
  /** `[pos, ruleId, harakat]` triples mapped onto aya_text offsets (word w starts at 2*w). */
  rules?: [number, number, number][];
}

/** Minimal asset payload shaped exactly like ordered_quran_phonemes.json. */
function syntheticAsset(surah: number, ayahs: SyntheticAyah[]): Record<string, unknown> {
  const verses: Record<string, unknown> = {};
  ayahs.forEach((ayah, i) => {
    verses[`${surah}:${i + 1}`] = {
      aya_ui: ayah.words.map((w) => `w${w.length}`).join(' ') + ' 1',
      aya_phoneme: ayah.words.join(''),
      aya_phonemes_list: ayah.words,
      aya_text: ayah.words.map(() => 'w').join(' '),
      rules: ayah.rules ?? [],
      suraname_ar: 'AR',
      suraname_en: 'EN',
    };
  });
  return {
    verses,
    rule_names: {
      '1': { ar: 'المد الطبيعي', en: 'Natural Madd' },
    },
  };
}

type DebugEvent = { message: string; asrBuffer: string };

async function newSession(
  opts: Partial<CreateSessionOptions> & Pick<CreateSessionOptions, 'surah'>,
  transport = new FakeAsrTransport(),
  loader?: () => unknown,
  repository?: QuranRepository,
): Promise<{ session: ReciteQuran; transport: FakeAsrTransport }> {
  const session = await ReciteQuran.createSession({
    transport,
    ...(repository !== undefined
      ? { repository }
      : { loader, repository: new QuranRepository(new QuranMetadataService(loader)) }),
    ...opts,
  });
  return { session, transport };
}

/** Real asset, loaded once and shared by the data-driven specs. */
let realRepo: QuranRepository;
let surah1: ContinuousQuranWord[];

beforeAll(async () => {
  realRepo = new QuranRepository(
    new QuranMetadataService(() => fs.readFileSync(ASSET_PATH, 'utf8')),
  );
  await realRepo.loadSurah(1);
  surah1 = realRepo.getSurahWords(1);
}, 120_000);

// ═══════════════════════════════════════════════════════════════════════════
// 1. LIFECYCLE (recite_quran.dart:94-113, :209-228)
// ═══════════════════════════════════════════════════════════════════════════

describe('session lifecycle', () => {
  test('createSession initializes the transport, subscribes and reports state', async () => {
    const transport = new FakeAsrTransport();
    const { session } = await newSession({ surah: 1 }, transport, () => fs.readFileSync(ASSET_PATH, 'utf8'));

    expect(transport.calls).toEqual(['initialize']);
    expect(session.isInitialized).toBe(true);
    expect(session.isDisposed).toBe(false);
    expect(session.isStarted).toBe(false);
    expect(session.targetSurah).toBe(1);
    expect(session.config).toEqual(normalConfig());
    expect(session.isTajweed).toBe(true);

    session.dispose();
    expect(session.isDisposed).toBe(true);
    expect(session.isInitialized).toBe(false);
  });

  test('start/stop drive the transport in order and are idempotent', async () => {
    const transport = new FakeAsrTransport();
    const { session } = await newSession({ surah: 1 }, transport, () => fs.readFileSync(ASSET_PATH, 'utf8'));

    await session.start();
    await session.start();
    expect(session.isStarted).toBe(true);

    await session.stop();
    expect(session.isStarted).toBe(false);

    session.dispose();
    // start() is idempotent: the transport is asked to open the mic once only.
    expect(transport.calls).toEqual(['initialize', 'start', 'stop', 'destroy']);
  });

  test('createSession defaults isTajweed to true and honours overrides', async () => {
    const { session } = await newSession(
      { surah: 1, isTajweed: false, config: { ...normalConfig(), maxSkipWords: 0 } },
      new FakeAsrTransport(),
      () => fs.readFileSync(ASSET_PATH, 'utf8'),
    );

    expect(session.isTajweed).toBe(false);
    expect(session.config.maxSkipWords).toBe(0);
    session.dispose();
  });

  test('dispose() is idempotent and destroys the transport exactly once', async () => {
    const transport = new FakeAsrTransport();
    const { session } = await newSession({ surah: 1 }, transport, () => fs.readFileSync(ASSET_PATH, 'utf8'));

    await session.start();
    session.dispose();
    session.dispose();

    expect(transport.calls.filter((c) => c === 'destroy')).toHaveLength(1);
    expect(transport.destroyed).toBe(true);
  });

  test('dispose() drops subscribers: late results emit nothing', async () => {
    const transport = new FakeAsrTransport();
    const { session } = await newSession({ surah: 1 }, transport, () => fs.readFileSync(ASSET_PATH, 'utf8'));

    const matched: WordMatchedEvent[] = [];
    session.onWordMatched((e) => matched.push(e));
    await session.start();

    transport.emitCumulative(FakeAsrTransport.chars(surah1.slice(0, 4).map((w) => w.phoneme)));
    expect(matched.length).toBeGreaterThan(0);

    // Keep a handle on the callback so we can fire it after dispose.
    const stale = (transport as unknown as { _onResult: (r: TranscriptionResult) => void })._onResult;
    session.dispose();
    matched.length = 0;
    stale({
      text: 'late',
      isFinal: true,
      startTime: 9,
      tokens: ['بسم'],
      timestamps: [9],
      streamEpoch: 1,
    });

    expect(matched).toEqual([]);
  });

  test('every mutation is a silent no-op after dispose (recite_quran.dart:123, 147, 161, 167, 174)', async () => {
    const transport = new FakeAsrTransport();
    const { session } = await newSession({ surah: 1 }, transport, () => fs.readFileSync(ASSET_PATH, 'utf8'));

    session.dispose();
    const callsAfterDispose = [...transport.calls];

    await session.setTargetSurah(2, { ayahFrom: 1, ayahTo: 2 });
    session.jumpToWord(3);
    session.resetBuffer();
    session.setTajweedMode(false);
    session.updateConfig(normalConfig());
    await session.stop();

    expect(transport.calls).toEqual(callsAfterDispose);
    expect(session.isTajweed).toBe(true);
    expect(session.targetSurah).toBe(1);
  });

  test('start() after dispose throws the StateError equivalent', async () => {
    const { session } = await newSession({ surah: 1 }, new FakeAsrTransport(), () =>
      fs.readFileSync(ASSET_PATH, 'utf8'),
    );
    session.dispose();
    await expect(session.start()).rejects.toThrow(/disposed/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. COMMAND DISPATCH — setTargetSurah (recite_quran.dart:118-143)
// ═══════════════════════════════════════════════════════════════════════════

describe('setTargetSurah command dispatch', () => {
  test('feeds the whole surah and re-targets after a surah change', async () => {
    const transport = new FakeAsrTransport();
    const repo = new QuranRepository(new QuranMetadataService(() => fs.readFileSync(ASSET_PATH, 'utf8')));
    const { session } = await newSession({ surah: 1 }, transport, undefined, repo);

    await session.start();
    const events: WordMatchedEvent[] = [];
    session.onWordMatched((e) => events.push(e));

    transport.emitCumulative(FakeAsrTransport.chars(surah1.slice(0, 8).map((w) => w.phoneme)));
    expect(events.map((e) => e.wordId)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    // Retarget surah 2: word ids restart at 0 and reference words change.
    events.length = 0;
    await session.setTargetSurah(2);
    expect(session.targetSurah).toBe(2);

    const surah2 = repo.getSurahWords(2);
    transport.emitCumulative(FakeAsrTransport.chars(surah2.slice(0, 3).map((w) => w.phoneme)));
    expect(events.slice(0, 3).map((e) => e.wordId)).toEqual([0, 1, 2]);
    // The matcher may shift a zero-cost Harakah across a word boundary and may
    // leave the frontier's trailing Harakah for the next word, so the matched
    // slices must be a prefix of the reference — never an insertion.
    const matchedSlices = events.slice(0, 3).map((e) => e.cleanAsr).join('');
    expect(surah2.slice(0, 3).map((w) => w.phoneme).join('').startsWith(matchedSlices)).toBe(true);
    session.dispose();
  });

  test('startGlobalWord places the cursor (rebased to the window)', async () => {
    const transport = new FakeAsrTransport();
    const { session } = await newSession(
      { surah: 1, ayahFrom: 2, ayahTo: 2, startGlobalWord: 2 },
      transport,
      () => fs.readFileSync(ASSET_PATH, 'utf8'),
    );
    await session.start();

    const events: WordMatchedEvent[] = [];
    session.onWordMatched((e) => events.push(e));

    const ayah2 = surah1.filter((w) => w.ayah === 2).map((w) => w.phoneme);
    transport.emitCumulative(FakeAsrTransport.chars(ayah2));

    expect(events.map((e) => e.wordId)).toEqual([2, 3]);
    session.dispose();
  });

  test('an unknown surah updates targetSurah but leaves the reference intact', async () => {
    const transport = new FakeAsrTransport();
    const { session } = await newSession({ surah: 1 }, transport, () => fs.readFileSync(ASSET_PATH, 'utf8'));
    await session.start();

    const events: WordMatchedEvent[] = [];
    session.onWordMatched((e) => events.push(e));

    await session.setTargetSurah(999);
    expect(session.targetSurah).toBe(999);

    transport.emitCumulative(FakeAsrTransport.chars(surah1.slice(0, 4).map((w) => w.phoneme)));
    expect(events.map((e) => e.wordId)).toEqual([0, 1, 2, 3]);
    session.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. AYAH-RANGE SLICING (brief: boundaries rebased to 0 over the ayah window)
// ═══════════════════════════════════════════════════════════════════════════

describe('ayah range windowing', () => {
  // Surah 1 word counts (verified against the real asset): 4, 4, 2, 3, 4, 3, 9 = 29.
  test('ayah 1..3 restricts the reference to the first 10 words and rebases ids to 0', async () => {
    const transport = new FakeAsrTransport();
    const { session } = await newSession(
      { surah: 1, ayahFrom: 1, ayahTo: 3 },
      transport,
      () => fs.readFileSync(ASSET_PATH, 'utf8'),
    );
    await session.start();

    const events: WordMatchedEvent[] = [];
    session.onWordMatched((e) => events.push(e));

    // Reciting the whole surah stops at the window edge: ayah 4+ never matches.
    transport.emitCumulative(FakeAsrTransport.chars(surah1.map((w) => w.phoneme)));

    expect(events.map((e) => e.wordId)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(events.map((e) => e.cleanAsr).join('')).toBe(
      surah1.filter((w) => w.ayah <= 3).map((w) => w.phoneme).join(''),
    );
    session.dispose();
  });

  test('a single-ayah window rebases word ids to 0', async () => {
    const transport = new FakeAsrTransport();
    const { session } = await newSession(
      { surah: 1, ayahFrom: 3, ayahTo: 3 },
      transport,
      () => fs.readFileSync(ASSET_PATH, 'utf8'),
    );
    await session.start();

    const events: WordMatchedEvent[] = [];
    session.onWordMatched((e) => events.push(e));

    const ayah3 = surah1.filter((w) => w.ayah === 3).map((w) => w.phoneme);
    transport.emitCumulative(FakeAsrTransport.chars(ayah3));

    expect(events.map((e) => e.wordId)).toEqual([0, 1]);
    const matchedSlices = events.map((e) => e.cleanAsr).join('');
    expect(ayah3.join('').startsWith(matchedSlices)).toBe(true);
    session.dispose();
  });

  test('ayahFrom without ayahTo tracks from that ayah to the end of the surah', async () => {
    const transport = new FakeAsrTransport();
    const { session } = await newSession(
      { surah: 1, ayahFrom: 7 },
      transport,
      () => fs.readFileSync(ASSET_PATH, 'utf8'),
    );
    await session.start();

    const events: WordMatchedEvent[] = [];
    session.onWordMatched((e) => events.push(e));
    transport.emitCumulative(FakeAsrTransport.chars(surah1.map((w) => w.phoneme)));

    expect(events).toHaveLength(9);
    expect(events.map((e) => e.wordId)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    session.dispose();
  });

  test('an inverted range is empty: no reference is installed', async () => {
    const transport = new FakeAsrTransport();
    const { session } = await newSession({ surah: 1 }, transport, () => fs.readFileSync(ASSET_PATH, 'utf8'));
    await session.start();

    const events: WordMatchedEvent[] = [];
    session.onWordMatched((e) => events.push(e));

    // ayahFrom 3 / ayahTo 1 selects no words, so the whole-surah reference that
    // createSession installed is left untouched (recite_quran.dart:126).
    await session.setTargetSurah(1, { ayahFrom: 3, ayahTo: 1 });
    expect(session.targetSurah).toBe(1);

    transport.emitCumulative(FakeAsrTransport.chars(surah1.map((w) => w.phoneme)));
    expect(events.map((e) => e.wordId)).toEqual(surah1.map((_, i) => i));
    session.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. (a) HAPPY PATH + (b) SKIP / RED + (d) ROUTING
//    Surah 2 ("بسم", "الله", "رحمن") — single-ayah synthetic window.
// ═══════════════════════════════════════════════════════════════════════════

describe('(a)+(b)+(d) matching, skipping and event routing', () => {
  const WORDS = ['بسم', 'الله', 'رحمن'];

  function threeWordSession(
    transport = new FakeAsrTransport(),
    overrides: Partial<CreateSessionOptions> = {},
  ): Promise<{ session: ReciteQuran; transport: FakeAsrTransport }> {
    return newSession(
      { surah: 2, ayahFrom: 1, ayahTo: 1, ...overrides },
      transport,
      () => syntheticAsset(2, [{ words: WORDS }]),
    );
  }

  test('(a) a perfect stream emits ordered green events with the right wordIds', async () => {
    const { session, transport } = await threeWordSession();
    await session.start();

    const matched: WordMatchedEvent[] = [];
    const transcripts: string[] = [];
    const skipped: WordMatchedEvent[] = [];
    const tajweed: WordMatchedEvent[] = [];
    session.onWordMatched((e) => matched.push(e));
    session.onTranscript((t) => transcripts.push(t));
    session.onWordSkipped((e) => skipped.push(e));
    session.onTajweed((e) => tajweed.push(e));

    transport.emitCumulative(FakeAsrTransport.chars(WORDS), 0.3);

    expect(matched.map((e) => e.wordId)).toEqual([0, 1, 2]);
    expect(matched.map((e) => e.cleanAsr)).toEqual(WORDS);
    expect(matched.map((e) => e.score)).toEqual([1, 1, 1]);
    expect(matched.every((e) => !e.isRed && !e.isNeutral)).toBe(true);
    expect(matched.every((e) => e.tajweedErrors === null)).toBe(true);
    // Tajweed is ON but nothing is held long enough to fault.
    expect(tajweed).toEqual([]);
    // (d) nothing is red, so the skipped channel stays empty.
    expect(skipped).toEqual([]);
    // The fake transport sends empty text, which is never emitted as a transcript.
    expect(transcripts).toEqual([]);
    session.dispose();
  });

  test('(a) transcripts carry the ASR text, and empty text is never emitted', async () => {
    const { session, transport } = await threeWordSession();
    await session.start();
    const transcripts: string[] = [];
    session.onTranscript((t) => transcripts.push(t));

    transport.emit({ text: 'بسم', tokens: FakeAsrTransport.chars([WORDS[0]]), timestamps: [0.4] });
    transport.emit({ text: '', tokens: FakeAsrTransport.chars([WORDS[0]]), timestamps: [0.6] });

    expect(transcripts).toEqual(['بسم']);
    session.dispose();
  });

  test('(b) a missing word is reported as isRed and only on the skipped channel', async () => {
    const { session, transport } = await threeWordSession();
    await session.start();

    const matched: WordMatchedEvent[] = [];
    const skipped: WordMatchedEvent[] = [];
    const tajweed: WordMatchedEvent[] = [];
    session.onWordMatched((e) => matched.push(e));
    session.onWordSkipped((e) => skipped.push(e));
    session.onTajweed((e) => tajweed.push(e));

    // Reciter jumps from word 0 straight to word 2 → word 1 is skipped.
    transport.emitCumulative(FakeAsrTransport.chars([WORDS[0], WORDS[2]]), 0.3);

    expect(matched.map((e) => [e.wordId, e.isRed])).toEqual([
      [0, false],
      [1, true],
      [2, false],
    ]);
    expect(skipped.map((e) => e.wordId)).toEqual([1]);
    expect(skipped[0].score).toBe(0);
    expect(skipped[0].cleanAsr).toBe('');
    expect(skipped[0].tajweedErrors).toBeNull();
    expect(tajweed).toEqual([]);
    session.dispose();
  });

  test('(d) unsubscribing stops delivery on every channel', async () => {
    const { session, transport } = await threeWordSession();
    await session.start();

    const matched: WordMatchedEvent[] = [];
    const skipped: WordMatchedEvent[] = [];
    const transcripts: string[] = [];
    const tajweed: WordMatchedEvent[] = [];
    const offMatched = session.onWordMatched((e) => matched.push(e));
    const offSkipped = session.onWordSkipped((e) => skipped.push(e));
    const offTranscript = session.onTranscript((t) => transcripts.push(t));
    const offTajweed = session.onTajweed((e) => tajweed.push(e));

    offMatched();
    offSkipped();
    offTranscript();
    offTajweed();

    transport.emitCumulative(FakeAsrTransport.chars(WORDS), 0.3);

    expect(matched).toEqual([]);
    expect(skipped).toEqual([]);
    expect(transcripts).toEqual([]);
    expect(tajweed).toEqual([]);
    session.dispose();
  });

  test('(e) a re-delivered stream does not duplicate committed greens', async () => {
    const { session, transport } = await threeWordSession();
    await session.start();
    const events: WordMatchedEvent[] = [];
    session.onWordMatched((e) => events.push(e));

    const chars = FakeAsrTransport.chars(WORDS);
    transport.emitCumulative(chars, 0.3);
    expect(events.map((e) => e.wordId)).toEqual([0, 1, 2]);

    // Same final text again (no new tokens) — the processor returns its live
    // buffers unchanged and the sequencer refuses to re-commit.
    transport.emit({ tokens: chars, timestamps: chars.map((_, i) => 0.3 * (i + 1)) });
    expect(events.map((e) => e.wordId)).toEqual([0, 1, 2]);
    session.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. (e) jumpToWord reset behaviour
// ═══════════════════════════════════════════════════════════════════════════

describe('(e) jumpToWord reset behaviour', () => {
  const WORDS = ['بسم', 'الله', 'رحمن'];

  async function fourWordSession(): Promise<{
    session: ReciteQuran;
    transport: FakeAsrTransport;
    events: WordMatchedEvent[];
  }> {
    const transport = new FakeAsrTransport();
    const { session } = await newSession(
      { surah: 2, ayahFrom: 1, ayahTo: 1 },
      transport,
      () => syntheticAsset(2, [{ words: WORDS }]),
    );
    await session.start();
    const events: WordMatchedEvent[] = [];
    session.onWordMatched((e) => events.push(e));
    return { session, transport, events };
  }

  test('jumpToWord moves the cursor and clears the committed sets', async () => {
    const { session, transport, events } = await fourWordSession();
    const chars = FakeAsrTransport.chars(WORDS);

    transport.emitCumulative(chars, 0.3);
    expect(events.map((e) => e.wordId)).toEqual([0, 1, 2]);

    session.jumpToWord(0);
    // The ASR segment restarts empty, so re-delivering the same text matches again.
    transport.emit({ tokens: chars, timestamps: chars.map((_, i) => 0.3 * (i + 1)) });
    expect(events.map((e) => e.wordId)).toEqual([0, 1, 2, 0, 1, 2]);
    session.dispose();
  });

  test('jumpToWord past the end is clamped and yields no further matches', async () => {
    const { session, transport, events } = await fourWordSession();
    const chars = FakeAsrTransport.chars(WORDS);

    session.jumpToWord(99);
    transport.emit({ tokens: chars, timestamps: chars.map((_, i) => 0.3 * (i + 1)) });
    expect(events).toEqual([]);

    // Negative indices clamp to the first word.
    session.jumpToWord(-5);
    transport.emit({ tokens: chars, timestamps: chars.map((_, i) => 0.3 * (i + 1)) });
    expect(events.map((e) => e.wordId)).toEqual([0, 1, 2]);
    session.dispose();
  });

  test('jumpToWord(1) keeps word 0 committed but lets 1..2 re-commit', async () => {
    const { session, transport, events } = await fourWordSession();
    const chars = FakeAsrTransport.chars(WORDS);

    transport.emitCumulative(chars, 0.3);
    expect(events.map((e) => e.wordId)).toEqual([0, 1, 2]);

    session.jumpToWord(1);
    transport.emit({ tokens: chars, timestamps: chars.map((_, i) => 0.3 * (i + 1)) });
    expect(events.map((e) => e.wordId)).toEqual([0, 1, 2, 1, 2]);
    session.dispose();
  });

  test('resetBuffer() reaches the transport and clears the ASR buffer', async () => {
    const transport = new FakeAsrTransport();
    const { session } = await newSession(
      { surah: 2, ayahFrom: 1, ayahTo: 1 },
      transport,
      () => syntheticAsset(2, [{ words: WORDS }]),
    );
    await session.start();
    session.resetBuffer();
    session.resetBuffer();
    expect(transport.calls).toEqual(['initialize', 'start', 'resetBuffer', 'resetBuffer']);
    session.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. (c) TAJWEED DEFECTS — per-character expansion + error routing
//    Synthetic word "بَاا": madd span "اا" with a Natural Madd rule (ruleId 1).
// ═══════════════════════════════════════════════════════════════════════════

describe('(c) tajweed evaluation', () => {
  const MADD_WORD = 'بَاا';

  function maddSession(overrides: Partial<CreateSessionOptions> = {}): Promise<{
    session: ReciteQuran;
    transport: FakeAsrTransport;
  }> {
    return newSession(
      { surah: 3, ayahFrom: 1, ayahTo: 1, isTajweed: true, ...overrides },
      new FakeAsrTransport(),
      // rule [2, 1, 4] lands inside word 1 ("بَاا" starts at aya_text offset 2).
      () => syntheticAsset(3, [{ words: ['سلم', MADD_WORD, 'عمر'], rules: [[2, 1, 4]] }]),
    );
  }

  test('a short madd is a green match carrying tajweedErrors (per-char durations)', async () => {
    const { session, transport } = await maddSession();
    await session.start();

    const matched: WordMatchedEvent[] = [];
    const tajweed: WordMatchedEvent[] = [];
    session.onWordMatched((e) => matched.push(e));
    session.onTajweed((e) => tajweed.push(e));

    // One token for the whole word, delivered at ts=0.72 so that
    // realTs = 0.72 - lookaheadDelay(0.32) = 0.40 and, being the first token,
    // its duration is 0.40 - (0.40 - 0.15) = 0.15.
    // Per-character expansion (highlighting_controller.dart:612-619) splits that
    // 0.15 across 4 code units → 0.0375 each → the 2-char madd span lasts 0.075,
    // well under the 1.2 harakat (0.24 s) Natural Madd requirement.
    transport.emit({ tokens: [MADD_WORD], timestamps: [0.72] });

    const evt = matched.find((e) => e.wordId === 1)!;
    expect(evt.isRed).toBe(false);
    expect(evt.tajweedErrors).not.toBeNull();
    expect(evt.tajweedErrors).toHaveLength(1);

    const err = evt.tajweedErrors![0];
    expect(err.errorType).toBe(ErrorCategory.tajweed);
    expect(err.speechErrorType).toBe(SpeechErrorType.replace);
    expect(err.durationStatus).toBe(TajweedDurationStatus.defect);
    expect(err.expectedPh).toBe('اا');
    expect(err.predictedPh).toBe('اا');
    expect(err.expectedRule).toEqual({
      // ruleId 1 maps to NormalMaddRule; the JSON rule_names are not used
      // (error_explainer.dart:647-676).
      type: 'NormalMaddRule',
      nameAr: 'المد الطبيعي',
      nameEn: 'Normal Madd',
      goldenLen: 1.2,
    });
    expect(err.expectedDuration).toBeCloseTo(0.24, 10);
    expect(err.actualDuration).toBeCloseTo(0.075, 10);

    // (d) the tajweed channel gets green-with-errors only.
    expect(tajweed.map((e) => e.wordId)).toEqual([1]);
    session.dispose();
  });

  test('a well-held madd commits clean (tajweedErrors === null)', async () => {
    const { session, transport } = await maddSession();
    await session.start();

    const matched: WordMatchedEvent[] = [];
    const tajweed: WordMatchedEvent[] = [];
    session.onWordMatched((e) => matched.push(e));
    session.onTajweed((e) => tajweed.push(e));

    // Per-character tokens 0.3 s apart → the madd span lasts ~0.6 s, inside
    // Natural Madd's 0.24 s … 0.74 s window.
    transport.emitCumulative(FakeAsrTransport.chars([MADD_WORD]), 0.3);

    const evt = matched.find((e) => e.wordId === 1)!;
    expect(evt.tajweedErrors).toBeNull();
    expect(tajweed).toEqual([]);
    session.dispose();
  });

  test('setTajweedMode(false) suppresses evaluation entirely', async () => {
    const { session, transport } = await maddSession();
    await session.start();

    const matched: WordMatchedEvent[] = [];
    const tajweed: WordMatchedEvent[] = [];
    session.onWordMatched((e) => matched.push(e));
    session.onTajweed((e) => tajweed.push(e));

    session.setTajweedMode(false);
    expect(session.isTajweed).toBe(false);
    transport.emit({ tokens: [MADD_WORD], timestamps: [0.72] });

    const evt = matched.find((e) => e.wordId === 1)!;
    expect(evt.tajweedErrors).toBeNull();
    expect(tajweed).toEqual([]);
    session.dispose();
  });

  test('red words never reach the tajweed channel', async () => {
    const transport = new FakeAsrTransport();
    const { session } = await newSession(
      { surah: 4, ayahFrom: 1, ayahTo: 1, isTajweed: true },
      transport,
      () =>
        syntheticAsset(4, [
          { words: ['سلم', MADD_WORD, 'عمر'], rules: [[2, 1, 4]] },
        ]),
    );
    await session.start();

    const skipped: WordMatchedEvent[] = [];
    const matched: WordMatchedEvent[] = [];
    const tajweed: WordMatchedEvent[] = [];
    session.onWordSkipped((e) => skipped.push(e));
    session.onWordMatched((e) => matched.push(e));
    session.onTajweed((e) => tajweed.push(e));

    // The reciter skips the madd word entirely, so it goes red rather than green.
    transport.emitCumulative(FakeAsrTransport.chars(['سلم', 'عمر']), 0.3);

    expect(skipped.map((e) => e.wordId)).toEqual([1]);
    expect(skipped.every((e) => e.tajweedErrors === null)).toBe(true);
    expect(matched.filter((e) => !e.isRed).map((e) => e.wordId)).toEqual([0, 2]);
    expect(tajweed).toEqual([]);
    session.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. CONFIG PLUMBING (recite_quran.dart:173-178)
// ═══════════════════════════════════════════════════════════════════════════

describe('updateConfig', () => {
  test('maxSkipWords=0 forbids the skip+1 lookahead', async () => {
    const WORDS = ['بسم', 'الله', 'رحمن'];
    const transport = new FakeAsrTransport();
    const { session } = await newSession(
      { surah: 5, ayahFrom: 1, ayahTo: 1, config: { ...normalConfig(), maxSkipWords: 0 } },
      transport,
      () => syntheticAsset(5, [{ words: WORDS }]),
    );
    await session.start();

    const events: WordMatchedEvent[] = [];
    session.onWordMatched((e) => events.push(e));

    transport.emitCumulative(FakeAsrTransport.chars([WORDS[0], WORDS[2]]), 0.3);
    expect(events.map((e) => e.wordId)).toEqual([0]);
    session.dispose();
  });

  test('a live updateConfig replaces the runtime thresholds', async () => {
    const WORDS = ['بسم', 'الله', 'رحمن'];
    const transport = new FakeAsrTransport();
    const { session } = await newSession(
      { surah: 6, ayahFrom: 1, ayahTo: 1 },
      transport,
      () => syntheticAsset(6, [{ words: WORDS }]),
    );
    await session.start();

    const events: WordMatchedEvent[] = [];
    session.onWordMatched((e) => events.push(e));

    session.updateConfig({ ...normalConfig(), maxSkipWords: 0 } as TrackerConfig);
    expect(session.config.maxSkipWords).toBe(0);

    transport.emitCumulative(FakeAsrTransport.chars([WORDS[0], WORDS[2]]), 0.3);
    expect(events.map((e) => e.wordId)).toEqual([0]);
    session.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. ERROR PATHS
// ═══════════════════════════════════════════════════════════════════════════

describe('error paths', () => {
  test('a failing transport.initialize rejects createSession', async () => {
    const transport = new FakeAsrTransport();
    transport.failInitialize = new Error('sherpa model missing');

    await expect(
      ReciteQuran.createSession({
        surah: 1,
        transport,
        repository: new QuranRepository(new QuranMetadataService(() => fs.readFileSync(ASSET_PATH, 'utf8'))),
      }),
    ).rejects.toThrow('sherpa model missing');
    expect(transport.calls).toEqual(['initialize']);
  });

  test('without an injected transport the session fails loudly', async () => {
    await expect(
      ReciteQuran.createSession({
        surah: 1,
        repository: new QuranRepository(new QuranMetadataService(() => fs.readFileSync(ASSET_PATH, 'utf8'))),
      }),
    ).rejects.toThrow(/AsrTransport/);
  });

  test('a missing quran asset surfaces the loader diagnostic', async () => {
    await expect(
      ReciteQuran.createSession({
        surah: 1,
        transport: new FakeAsrTransport(),
        repository: new QuranRepository(new QuranMetadataService()),
      }),
    ).rejects.toThrow(/loader/i);
  });

  test('a loader-based repository is accepted (no repository needed)', async () => {
    const { session, transport } = await newSession({ surah: 7, ayahFrom: 1, ayahTo: 1 }, new FakeAsrTransport(), () =>
      syntheticAsset(7, [{ words: ['سلم', 'عمر'] }]),
    );
    await session.start();
    const events: WordMatchedEvent[] = [];
    session.onWordMatched((e) => events.push(e));
    transport.emitCumulative(FakeAsrTransport.chars(['سلم', 'عمر']), 0.3);

    expect(session.targetSurah).toBe(7);
    expect(events.map((e) => e.wordId)).toEqual([0, 1]);
    session.dispose();
  });

  test('a throwing sequencer is wrapped into the isolate-error debug event', async () => {
    const transport = new FakeAsrTransport();
    const { session } = await newSession({ surah: 1 }, transport, () => fs.readFileSync(ASSET_PATH, 'utf8'));
    await session.start();

    const debug: DebugEvent[] = [];
    (session as unknown as { _onDebug: (e: DebugEvent) => void })._onDebug = (e) => debug.push(e);

    // Replace the internal sequencer with one that throws, as a malformed
    // reference would inside the worker.
    (session as unknown as { _sequencer: unknown })._sequencer = {
      syncStream: () => {
        throw new Error('boom in syncStream');
      },
    };

    transport.emit({ tokens: ['ب', 'س', 'م'], timestamps: [0.4, 0.7, 1.0] });

    expect(debug).toHaveLength(1);
    expect(debug[0].message).toContain('[ISOLATE ERROR]');
    expect(debug[0].message).toContain('boom in syncStream');
    session.dispose();
  });

  test('without a debug hook an isolate error falls back to console.warn', async () => {
    const transport = new FakeAsrTransport();
    const { session } = await newSession({ surah: 1 }, transport, () => fs.readFileSync(ASSET_PATH, 'utf8'));
    await session.start();

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      (session as unknown as { _sequencer: unknown })._sequencer = {
        syncStream: () => {
          throw new Error('boom again');
        },
      };
      transport.emit({ tokens: ['ب', 'س', 'م'], timestamps: [0.4, 0.7, 1.0] });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('boom again');
    } finally {
      warn.mockRestore();
      session.dispose();
    }
  });

  test('blank-only results are dropped before the sequencer', async () => {
    const transport = new FakeAsrTransport();
    const { session } = await newSession({ surah: 1 }, transport, () => fs.readFileSync(ASSET_PATH, 'utf8'));
    await session.start();

    const events: WordMatchedEvent[] = [];
    const transcripts: string[] = [];
    session.onWordMatched((e) => events.push(e));
    session.onTranscript((t) => transcripts.push(t));

    const syncSpy = jest.fn();
    (session as unknown as { _sequencer: { syncStream: unknown } })._sequencer.syncStream = syncSpy;

    transport.emit({ tokens: ['<blank>', '<blk>', '<eps>'], timestamps: [0.4, 0.7, 1.0] });

    expect(syncSpy).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(transcripts).toEqual([]);
    session.dispose();
  });
});