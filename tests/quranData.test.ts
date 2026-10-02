// tests/quranData.test.ts — port verification for the Quran data layer
// (lib/data/quran_data.dart, 425 lines, read-only source of truth) and for
// ReciterQuran._calculateBoundaries (lib/recite_quran.dart:197-205).
//
// Ground truth: the real 12.8 MB assets/model/ordered_quran_phonemes.json is loaded
// once in beforeAll (brief step 2) — every expectation below was derived from the
// data itself (see task-9-report.md), never from the implementation.

import * as fs from 'fs';
import * as path from 'path';

import {
  QURAN_PHONEME_ASSET_PATHS,
  QuranMetadataService,
  QuranRepository,
  QuranVerse,
  calculateBoundaries,
} from '../src/data/quranData';
import { ContinuousQuranWord, WordTajweedRule } from '../src/types';

const ASSET_PATH = path.join(__dirname, '..', 'assets', 'model', 'ordered_quran_phonemes.json');

const NATURAL_MADD: WordTajweedRule = { ruleId: 1, nameAr: 'المد الطبيعي', nameEn: 'Natural Madd', goldenLen: 2 };
const CONNECTED_MADD: WordTajweedRule = { ruleId: 3, nameAr: 'المد المتصل', nameEn: 'Connected Madd', goldenLen: 4 };
const TEMPORARY_MADD: WordTajweedRule = { ruleId: 5, nameAr: 'المد العارض للسكون', nameEn: 'Temporary Madd', goldenLen: 4 };
const LAZIM_MADD: WordTajweedRule = { ruleId: 6, nameAr: 'المد اللازم', nameEn: 'Lazim Madd', goldenLen: 6 };
const SHADDAH: WordTajweedRule = { ruleId: 9, nameAr: 'الشدة', nameEn: 'Shaddah', goldenLen: 1 };
const GHUNNAH_NOON: WordTajweedRule = { ruleId: 10, nameAr: 'النون المشددة', nameEn: 'Mushaddad Noon', goldenLen: 2 };
const GHUNNAH_MEEM: WordTajweedRule = { ruleId: 10, nameAr: 'الميم المشددة', nameEn: 'Mushaddad Meem', goldenLen: 2 };

/** Verse-shaped fixture; every field the Dart parser touches is overridable. */
function verseJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    aya_ui: 'w1 w2 num',
    aya_phoneme: 'p1p2',
    aya_phonemes_list: ['p1', 'p2'],
    aya_text: 'aa bb',
    rules: [],
    suraname_ar: 'AR',
    suraname_en: 'EN',
    ...over,
  };
}

/** Loads the real asset once and shares one repository across the data-driven specs. */
let service: QuranMetadataService;
let repo: QuranRepository;
let rawJson: Record<string, any>;

beforeAll(async () => {
  service = new QuranMetadataService(() => fs.readFileSync(ASSET_PATH, 'utf8'));
  repo = new QuranRepository(service);
  await repo.loadSurah(1);
  rawJson = service.rawJson;
}, 120_000);

// ═══════════════════════════════════════════════════════════════════════════════
// QuranMetadataService (quran_data.dart:224-256)
// ═══════════════════════════════════════════════════════════════════════════════

describe('QuranMetadataService', () => {
  test('exposes the Dart asset paths and throws a clear message without a loader', async () => {
    expect(QURAN_PHONEME_ASSET_PATHS).toEqual([
      'packages/recite_quran/assets/model/ordered_quran_phonemes.json',
      'assets/model/ordered_quran_phonemes.json',
    ]);

    const bare = new QuranMetadataService();
    expect(bare.rawJson).toBeNull();
    await expect(bare.load()).rejects.toThrow(/loader/i);
    await expect(bare.load()).rejects.toThrow(/assets\/model\/ordered_quran_phonemes\.json/);
    // Dart rethrows (quran_data.dart:241-244) — a failed load must not poison rawJson.
    expect(bare.rawJson).toBeNull();
  });

  test('parses a JSON string payload and caches it (loader runs once)', async () => {
    let calls = 0;
    const svc = new QuranMetadataService(() => {
      calls++;
      return JSON.stringify({ verses: { '1:1': verseJson() }, rule_names: {} });
    });

    expect(svc.rawJson).toBeNull();
    await svc.load();
    await svc.load();
    expect(calls).toBe(1);
    expect(Object.keys(svc.rawJson.verses)).toEqual(['1:1']);
  });

  test('accepts an already-parsed object payload (Metro require)', async () => {
    const payload = { verses: { '1:1': verseJson() }, rule_names: {} };
    const svc = new QuranMetadataService(() => payload);
    await svc.load();
    expect(svc.rawJson).toBe(payload);
  });

  test('rethrows loader failures and keeps rawJson null', async () => {
    const svc = new QuranMetadataService(() => {
      throw new Error('asset missing');
    });
    await expect(svc.load()).rejects.toThrow('asset missing');
    expect(svc.rawJson).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// QuranRepository over the real asset
// ═══════════════════════════════════════════════════════════════════════════════

describe('QuranRepository — real asset', () => {
  // ── (a) surah 1 structure + word counts ─────────────────────────────────────

  test('surah 1 has 7 ayahs, 29 words and matching ayah start indices', async () => {
    const surah1 = repo.getSurah(1);
    expect(surah1).toHaveLength(7);
    expect(surah1.map((v) => v.ayah)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    const words = repo.getSurahWords(1);
    expect(words).toHaveLength(29);
    expect(repo.getAyahStartGlobalIndex(1, 1)).toBe(0);
    expect([1, 2, 3, 4, 5, 6, 7].map((a) => repo.getAyahStartGlobalIndex(1, a))).toEqual([
      0, 4, 8, 10, 13, 17, 20,
    ]);
    // Unknown ayahs fall back to 0 (quran_data.dart:406).
    expect(repo.getAyahStartGlobalIndex(1, 99)).toBe(0);
  });

  test('getVerse/getNextVerse walk ayahs and stop at the surah end', async () => {
    expect(repo.getVerse(1, 1)!.ayah).toBe(1);
    expect(repo.getVerse(1, 7)!.ayah).toBe(7);
    expect(repo.getVerse(1, 8)).toBeNull();
    expect(repo.getVerse(1, 0)).toBeNull();
    expect(repo.getNextVerse(1, 6)).toBe(repo.getVerse(1, 7));
    expect(repo.getNextVerse(1, 7)).toBeNull(); // last ayah of the surah
    expect(repo.getNextVerse(1, 0)).toBeNull();
  });

  // ── (b) phoneme words + (c) ayah-number word stripped ──────────────────────

  test('1:1 phoneme words are taken verbatim from aya_phonemes_list', () => {
    const verse = repo.getVerse(1, 1)!;
    expect(verse.phonemeWords).toEqual(['بِسمِ', 'للَااهِ', 'ررَحمَاانِ', 'ررَحِۦۦۦۦم']);
    expect(verse.textPhoneme).toBe(rawJson.verses['1:1'].aya_phoneme);
    expect(verse.textPhoneme).toBe(verse.phonemeWords.join(''));
    expect(verse.surahName).toBe('الفَاتِحة');
    expect(verse.surahNameEn).toBe('Al-Fātiḥah');
    expect(verse.surah).toBe(1);
    expect(verse.ayah).toBe(1);
  });

  test('the trailing ayah-number word of aya_ui is dropped (quran_data.dart:101-103)', () => {
    const rawWords = (rawJson.verses['1:1'].aya_ui as string).trim().split(' ');
    expect(rawWords).toHaveLength(5);
    // The trailing cell of aya_ui is a lone UI-font glyph (U+E95A in this build).
    expect(rawWords[4]).toBe('\u200f\uE95A');

    const verse = repo.getVerse(1, 1)!;
    expect(verse.uthmaniWords).toHaveLength(rawWords.length - 1);
    expect(verse.textUthmani).toBe(verse.uthmaniWords.join(' '));
    expect(verse.textUthmani).not.toContain('\uE95A');
    expect(verse.uthmaniWords.every((w) => w.length > 0)).toBe(true);
  });

  // ── (d) JSON Madd rules mapped through aya_text character offsets ───────────

  test('1:3 word 0 carries the JSON Madd rule (pos 10 → word 0, ruleId 1)', () => {
    // aya_text = "ٱلرَّحْمَـٰنِ ٱلرَّحِيمِ" (13 + 10 code units), rules [[10,1,2],[21,5,4]]
    // → spans [0,13) and [14,24); the Ghunnah/Shaddah branch follows the Madd rules.
    const verse = repo.getVerse(1, 3)!;
    expect(verse.wordRules).toHaveLength(verse.uthmaniWords.length);
    expect(verse.wordRules[0]).toEqual([NATURAL_MADD, SHADDAH]);
    expect(verse.wordRules[1]).toEqual([TEMPORARY_MADD, SHADDAH]);
  });

  test('2:3 keeps only Madd ids 1-7 and appends one entry per matching JSON rule', () => {
    // rules: [[6,1,2],[18,1,2],[40,1,2],[43,1,2],[54,1,2],[66,1,2],[72,8,0],[77,1,2],[90,5,4]]
    // pos 72 (ruleId 8, Qalqalah) must be dropped; pos 40 and 43 both land in word 3.
    const verse = repo.getVerse(2, 3)!;
    expect(verse.wordRules[3]).toEqual([NATURAL_MADD, NATURAL_MADD]);
    expect(verse.wordRules[7]).toEqual([TEMPORARY_MADD, SHADDAH]);
    for (const rules of verse.wordRules) {
      for (const rule of rules) expect([1, 2, 3, 4, 5, 6, 7, 9, 10]).toContain(rule.ruleId);
    }
    expect(verse.wordRules.flat().some((r) => r.ruleId === 8)).toBe(false);
    expect(verse.wordRules.flat().some((r) => r.goldenLen === 0)).toBe(false);
    // "وَمِممممَاا" → Mushaddad Meem after the Madd rule.
    expect(verse.wordRules[5]).toEqual([NATURAL_MADD, GHUNNAH_MEEM]);
  });

  test('2:6 word 0 is Mushaddad Noon and word 3 keeps Connected Madd', () => {
    const verse = repo.getVerse(2, 6)!;
    expect(verse.phonemeWords[0]).toBe('ءِننننَ');
    expect(verse.wordRules[0]).toEqual([GHUNNAH_NOON]); // "نننن" wins over Shaddah
    expect(verse.wordRules[3]).toEqual([CONNECTED_MADD]); // rules[2] = [30,3,4]
  });

  test('2:1 carries two Lazim Madd entries plus Mushaddad Meem', () => {
    const verse = repo.getVerse(2, 1)!;
    expect(verse.wordRules).toHaveLength(1);
    expect(verse.wordRules[0]).toEqual([LAZIM_MADD, LAZIM_MADD, GHUNNAH_MEEM]);
  });

  // ── Shaddah: first adjacent duplicate, excluding ا (0627) ۥ (06E5) ۦ (06E6) ─

  test('Shaddah fires on the first doubled consonant and skips the اۥۦ set', () => {
    // "ررَحِۦۦۦۦم" — first duplicate is رر, so Shaddah is added.
    expect(repo.getVerse(1, 1)!.wordRules[3]).toEqual([TEMPORARY_MADD, SHADDAH]);
    // "لمَغضُۥۥبِ" — its only duplicate is ۥۥ (excluded) → no Shaddah.
    expect(repo.getVerse(1, 7)!.wordRules[5]).toEqual([NATURAL_MADD]);
    // "لعَاالَمِۦۦۦۦن" — duplicates are اا and ۦۦ (both excluded) → no Shaddah.
    expect(repo.getVerse(1, 2)!.wordRules[3]).toEqual([NATURAL_MADD, TEMPORARY_MADD]);
    // "لَاا" — اا is excluded → Madd only.
    expect(repo.getVerse(2, 2)!.wordRules[2]).toEqual([NATURAL_MADD]);
  });

  // ── (f) continuous per-surah indexing ─────────────────────────────────────

  test('surah 2 words are contiguous with per-surah globalIndex restarting at 0', async () => {
    await repo.loadSurah(2);
    const words = repo.getSurahWords(2);
    expect(words).toHaveLength(6117);
    expect(repo.getAyahStartGlobalIndex(2, 1)).toBe(0);
    expect(repo.getAyahStartGlobalIndex(2, 2)).toBe(1);
    expect(repo.getAyahStartGlobalIndex(2, 286)).toBe(6068);

    words.forEach((w: ContinuousQuranWord, i: number) => {
      expect(w.globalIndex).toBe(i);
      expect(w.surah).toBe(2);
      if (i > 0) expect(w.ayah >= words[i - 1].ayah).toBe(true);
      if (w.wordInAyah === 0) expect(repo.getAyahStartGlobalIndex(2, w.ayah)).toBe(i);
    });

    // Word-level projection stays aligned with the verse payload.
    const verse = repo.getVerse(2, 2)!;
    const slice = words.slice(repo.getAyahStartGlobalIndex(2, 2), repo.getAyahStartGlobalIndex(2, 3));
    expect(slice.map((w) => w.phoneme)).toEqual(verse.phonemeWords);
    expect(slice.map((w) => w.wordInAyah)).toEqual(verse.phonemeWords.map((_, i) => i));
    expect(slice.map((w) => w.rules)).toEqual(verse.wordRules);
    expect(slice.map((w) => w.uthmani)).toEqual(verse.uthmaniWords);
  });

  test('every surah indexes from 0 and the corpus totals 77433 words', async () => {
    let grand = 0;
    for (let surah = 1; surah <= 114; surah++) {
      await repo.loadSurah(surah);
      expect(repo.getAyahStartGlobalIndex(surah, 1)).toBe(0);
      const words = repo.getSurahWords(surah);
      expect(words.length).toBeGreaterThan(0);
      grand += words.length;
    }
    expect(grand).toBe(77433);
    expect(repo.getSurahWords(1)).toHaveLength(29);
    expect(repo.getSurahWords(114)).toHaveLength(20);
  }, 120_000);

  // ── surahMetadata + caching ───────────────────────────────────────────────

  test('surahMetadata lazily parses ayah 1 of all 114 surahs and caches', () => {
    const meta = repo.surahMetadata;
    expect(meta).toHaveLength(114);
    expect(meta[0].surah).toBe(1);
    expect(meta[0].ayah).toBe(1);
    expect(meta[0].surahName).toBe('الفَاتِحة');
    expect(meta[0].surahNameEn).toBe('Al-Fātiḥah');
    expect(meta[113].surah).toBe(114);
    // Al-Nas written with explicit escapes so no copy-paste normalisation of the
    // shaddah/fatha order can change the expected code-point sequence.
    expect(meta[113].surahName).toBe(String.fromCharCode(0x0627,0x0644,0x0646,0x0651,0x064e,0x0627,0x0633));
    expect(meta[113].surahNameEn).toBe('An-Nās');
    expect(repo.surahMetadata).toBe(meta);
    expect(repo.surahMetadata[0]).toBe(meta[0]);
  });

  test('parsed verses and words are cached by surah', async () => {
    expect(repo.getSurahWords(1)).toBe(repo.getSurahWords(1));
    expect(repo.getVerse(1, 1)).toBe(repo.getVerse(1, 1));
    await repo.loadSurah(3);
    const before = repo.getVerse(3, 1);
    await repo.loadSurah(3);
    expect(repo.getVerse(3, 1)).toBe(before);
  });

  test('nothing is parsed before the repository is loaded', () => {
    let loaded = false;
    const fresh = new QuranRepository(
      new QuranMetadataService(() => {
        loaded = true;
        return { verses: {} };
      }),
    );
    expect(fresh.surahMetadata).toEqual([]);
    expect(fresh.getSurahWords(1)).toEqual([]);
    expect(fresh.getVerse(1, 1)).toBeNull();
    expect(fresh.getNextVerse(1, 1)).toBeNull();
    expect(fresh.getAyahStartGlobalIndex(1, 1)).toBe(0);
    expect(loaded).toBe(false);
  });

  test('a payload without a verses key is treated as the verse map itself', async () => {
    const flat = { '1:1': verseJson({ aya_phonemes_list: ['p1'], aya_ui: 'w1 num' }) };
    const svc = new QuranMetadataService(() => ({ rule_names: {} , ...flat }));
    const r = new QuranRepository(svc);
    await r.loadSurah(1);
    expect(r.getSurah(1)).toHaveLength(1);
    expect(r.getSurahWords(1)).toHaveLength(1);
    expect(r.surahMetadata).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// QuranVerse.fromJson — synthetic fixtures for the defensive branches
// (quran_data.dart:92-219)
// ═══════════════════════════════════════════════════════════════════════════════

describe('QuranVerse.fromJson', () => {
  const parse = (over: Record<string, unknown> = {}, ruleNames?: Record<string, { ar?: string; en?: string }> | null) =>
    QuranVerse.fromJson(7, 3, verseJson(over), ruleNames);

  // ── aya_ui word split ────────────────────────────────────────────────────

  test('drops the trailing ayah-number word only when there is more than one word', () => {
    expect(parse().uthmaniWords).toEqual(['w1', 'w2']);
    expect(parse({ aya_ui: 'w1' }).uthmaniWords).toEqual(['w1']);
    // Single empty token → no removal, then the isNotEmpty filter empties the list.
    const blank = parse({ aya_ui: '' });
    expect(blank.uthmaniWords).toEqual([]);
    expect(blank.textUthmani).toBe('');
  });

  test('drops empty tokens produced by repeated separators', () => {
    expect(parse({ aya_ui: 'w1  w2 num' }).uthmaniWords).toEqual(['w1', 'w2']);
    expect(parse({ aya_ui: '  w1 w2 num  ' }).uthmaniWords).toEqual(['w1', 'w2']);
  });

  test('strips hizb/sajdah markers (۞۩) and drops words emptied by the strip', () => {
    expect(parse({ aya_ui: 'w۞1 w2 num' }).uthmaniWords).toEqual(['w1', 'w2']);
    expect(parse({ aya_ui: 'w1 ۩ w2 num' }).uthmaniWords).toEqual(['w1', 'w2']);
    expect(parse({ aya_ui: '۞ w1 w2 num' }).uthmaniWords).toEqual(['w1', 'w2']);
  });

  test('missing aya_ui / aya_text / aya_phoneme degrade to empty strings', () => {
    const v = QuranVerse.fromJson(1, 1, {
      aya_phonemes_list: ['p1'],
    } as Record<string, unknown>);
    expect(v.uthmaniWords).toEqual([]);
    expect(v.phonemeWords).toEqual(['p1']); // padding never shrinks a longer list
    expect(v.textPhoneme).toBe('');
    expect(v.textUthmani).toBe('');
    expect(v.surahName).toBe('');
    expect(v.surahNameEn).toBe('');
    expect(v.wordRules).toEqual([]);
    expect(v.wordMap).toEqual([]);
  });

  // ── aya_phonemes_list alignment ───────────────────────────────────────────

  test('pads a short aya_phonemes_list with empty strings', () => {
    const v = parse({ aya_phonemes_list: ['p1'] });
    expect(v.uthmaniWords).toHaveLength(2);
    expect(v.phonemeWords).toEqual(['p1', '']);
  });

  test('fills the whole list with empty strings when aya_phonemes_list is absent', () => {
    const json = verseJson();
    delete json.aya_phonemes_list;
    expect(QuranVerse.fromJson(1, 1, json).phonemeWords).toEqual(['', '']);
  });

  test('a present-but-null aya_phonemes_list throws, mirroring List.from(null)', () => {
    expect(() => parse({ aya_phonemes_list: null })).toThrow();
  });

  test('a longer aya_phonemes_list is kept as-is (never truncated)', () => {
    expect(parse({ aya_phonemes_list: ['p1', 'p2', 'p3'] }).phonemeWords).toEqual(['p1', 'p2', 'p3']);
  });

  // ── rule position mapping ─────────────────────────────────────────────────

  test('maps a rule onto the aya_text word span that contains its position', () => {
    // aya_text "aa bb" → spans [0,2) and [3,5).
    expect(parse({ rules: [[0, 1, 2]] }).wordRules[0]).toEqual([{ ruleId: 1, nameAr: 'مد', nameEn: 'Madd', goldenLen: 2 }]);
    expect(parse({ rules: [[1, 1, 2]] }).wordRules[0]).toHaveLength(1);
    expect(parse({ rules: [[3, 1, 2]] }).wordRules[1]).toHaveLength(1);
    expect(parse({ rules: [[4, 1, 2]] }).wordRules[1]).toHaveLength(1);
    // Positions on the separator (2) and past the text (5) match no span at all.
    expect(parse({ rules: [[2, 1, 2]] }).wordRules.flat()).toEqual([]);
    expect(parse({ rules: [[5, 1, 2]] }).wordRules.flat()).toEqual([]);
    expect(parse({ rules: [[6, 1, 2]] }).wordRules.flat()).toEqual([]);
    expect(parse({ rules: [[99, 1, 2]] }).wordRules.flat()).toEqual([]);
    expect(parse({ rules: [[-1, 1, 2]] }).wordRules.flat()).toEqual([]);
  });

  test('keeps only Madd rule ids 1-7 and skips malformed rule entries', () => {
    for (const ruleId of [0, 8, 9, 10, 11]) {
      const v = parse({ rules: [[0, ruleId, 2]] });
      expect(v.wordRules[0]).toEqual([]);
    }
    // Non-list entries and entries shorter than 3 elements are ignored.
    const bad = parse({ rules: ['x', {}, [0, 1], [], [0, 1, 2]] });
    expect(bad.wordRules[0]).toEqual([{ ruleId: 1, nameAr: 'مد', nameEn: 'Madd', goldenLen: 2 }]);
  });

  test('uses rule_names for display names and harakat for goldenLen', () => {
    const v = parse({ rules: [[0, 4, 6]] }, { '4': { ar: 'متصل وقفا', en: 'Connected at Pause' } });
    expect(v.wordRules[0]).toEqual([{ ruleId: 4, nameAr: 'متصل وقفا', nameEn: 'Connected at Pause', goldenLen: 6 }]);

    // A rule id missing from rule_names falls back to the Dart defaults.
    const partial = parse({ rules: [[0, 4, 6]] }, { '1': { ar: 'x', en: 'y' } });
    expect(partial.wordRules[0]).toEqual([{ ruleId: 4, nameAr: 'مد', nameEn: 'Madd', goldenLen: 6 }]);
  });

  test('word length beyond aya_text yields zero-width spans for the extra words', () => {
    const v = parse({ aya_ui: 'w1 w2 w3 num', aya_text: 'aa', aya_phonemes_list: ['p1', 'p2', 'p3'], rules: [[4, 1, 2]] });
    expect(v.uthmaniWords).toEqual(['w1', 'w2', 'w3']);
    expect(v.wordRules[1]).toEqual([]); // span [3,3) is empty
    expect(v.wordRules[2]).toEqual([]);
  });

  // ── Ghunnah / Shaddah ────────────────────────────────────────────────────

  test('Ghunnah wins over Shaddah and takes precedence for noon over meem', () => {
    expect(parse({ aya_phonemes_list: ['نننن', 'p2'] }).wordRules[0]).toEqual([GHUNNAH_NOON]);
    expect(parse({ aya_phonemes_list: ['مممم', 'p2'] }).wordRules[0]).toEqual([GHUNNAH_MEEM]);
    expect(parse({ aya_phonemes_list: ['ننننمممم', 'p2'] }).wordRules[0]).toEqual([GHUNNAH_NOON]);
    // Partial runs do not trigger Ghunnah; the doubled consonant gives Shaddah instead.
    expect(parse({ aya_phonemes_list: ['نن', 'p2'] }).wordRules[0]).toEqual([SHADDAH]);
    expect(parse({ aya_phonemes_list: ['رر', 'p2'] }).wordRules[0]).toEqual([SHADDAH]);
    // An empty phoneme word cannot produce any rule.
    expect(parse({ aya_phonemes_list: ['', 'p2'] }).wordRules[0]).toEqual([]);
  });

  test('Shaddah is emitted at most once per word, on the first doubled consonant', () => {
    expect(parse({ aya_phonemes_list: ['ررمممم', 'p2'] }).wordRules[0]).toEqual([GHUNNAH_MEEM]);
    expect(parse({ aya_phonemes_list: ['للر', 'p2'] }).wordRules[0]).toEqual([SHADDAH]);
    expect(parse({ aya_phonemes_list: ['للتت', 'p2'] }).wordRules[0]).toEqual([SHADDAH]);
    // Excluded code units never produce Shaddah, even when doubled.
    expect(parse({ aya_phonemes_list: ['اا', 'p2'] }).wordRules[0]).toEqual([]);
    expect(parse({ aya_phonemes_list: ['ۥۥ', 'p2'] }).wordRules[0]).toEqual([]);
    expect(parse({ aya_phonemes_list: ['ۦۦ', 'p2'] }).wordRules[0]).toEqual([]);
    // A lone trailing consonant has no successor to pair with.
    expect(parse({ aya_phonemes_list: ['ر', 'p2'] }).wordRules[0]).toEqual([]);
  });

  test('wordRules has one bucket per uthmani word', () => {
    const v = parse({ aya_ui: 'w1 w2 w3 w4 num', aya_phonemes_list: ['p1', 'p2', 'p3', 'p4'] });
    expect(v.wordRules).toHaveLength(4);
    expect(v.wordRules.every((rs) => Array.isArray(rs) && rs.length === 0)).toBe(true);
  });

  // ── wordMap ───────────────────────────────────────────────────────────────

  test('wordMap is the lazy identity map over uthmaniWords', () => {
    const v = QuranVerse.fromJson(1, 1, verseJson());
    expect(v.wordMap).toEqual([0, 1]);
    expect(v.wordMap).toBe(v.wordMap); // memoized
    // A constructor-supplied map is kept verbatim (idgham/wasl drift fix-up, dart:68-75).
    const mapped = new QuranVerse({
      surah: 1,
      ayah: 1,
      textUthmani: 'a b',
      surahName: 'AR',
      surahNameEn: 'EN',
      uthmaniWords: ['a', 'b'],
      textPhoneme: 'ab',
      phonemeWords: ['ab'],
      wordMap: [0, 0],
    });
    expect(mapped.wordMap).toEqual([0, 0]);
  });

  test('constructor defaults rules to an empty list and wordMap to null', () => {
    const v = new QuranVerse({
      surah: 1,
      ayah: 2,
      textUthmani: 'a b',
      surahName: 'AR',
      surahNameEn: 'EN',
      uthmaniWords: ['a', 'b'],
      textPhoneme: 'ab',
      phonemeWords: ['a', 'b'],
    });
    expect(v.wordRules).toEqual([]);
    expect(v.wordMap).toEqual([0, 1]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// calculateBoundaries (recite_quran.dart:197-205)
// ═══════════════════════════════════════════════════════════════════════════════

describe('calculateBoundaries', () => {
  test('returns cumulative offsets starting at 0', () => {
    expect(calculateBoundaries(['abc', 'de', 'f'])).toEqual([0, 3, 5, 6]);
    expect(calculateBoundaries([])).toEqual([0]);
    expect(calculateBoundaries([''])).toEqual([0, 0]);
  });

  test('empty words contribute nothing and boundaries stay non-decreasing', () => {
    expect(calculateBoundaries(['', 'ab', '', 'c'])).toEqual([0, 0, 2, 2, 3]);
  });

  test('counts UTF-16 code units, matching Dart String.length', () => {
    expect(calculateBoundaries(['🙂', 'a'])).toEqual([0, 2, 3]);
    expect(calculateBoundaries(['a', 'bb', ''])).toEqual([0, 1, 3, 3]);
    // بِسْمِ = U+0628 U+0650 U+0633 U+0652 U+0645 U+0650 → 6 units.
    // ٱلرَّحِيمِ = 10 units: the shaddah+fatha pair is 2 units, not one grapheme cluster.
    const bism = String.fromCharCode(0x0628, 0x0650, 0x0633, 0x0652, 0x0645, 0x0650);
    const rahim = String.fromCharCode(0x0671, 0x0644, 0x0631, 0x0651, 0x064e, 0x062d, 0x0650, 0x064a, 0x0645, 0x0650);
    expect(calculateBoundaries([bism, rahim])).toEqual([0, 6, 16]);
  });

  test('final boundary equals the joined phoneme string length', () => {
    const words = repo.getSurahWords(1).map((w) => w.phoneme);
    const boundaries = calculateBoundaries(words);
    expect(boundaries).toHaveLength(words.length + 1);
    expect(boundaries[boundaries.length - 1]).toBe(words.join('').length);
  });
});
