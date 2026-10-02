// src/data/quranData.ts
// Line-by-line transliteration of lib/data/quran_data.dart (425 lines, zero Dart
// imports) plus ReciterQuran._calculateBoundaries (lib/recite_quran.dart:197-205).
// Dart lib/ is the read-only source of truth; nothing under lib/ is modified and the
// 12.8 MB asset is read at runtime — never copied, forked or transformed on disk.
//
// What this layer guarantees (verbatim from Dart):
//   * `aya_ui` (UI font glyph stream) is the source of `uthmaniWords`; the trailing
//     ayah-number word is dropped and ۞/۩ markers are stripped (dart:99-108).
//   * `aya_phonemes_list` is padded with '' to the Uthmani word count, never truncated
//     (dart:113-124).
//   * Word Tajweed rules: Madd ids 1-7 from the JSON `rules` array mapped through
//     aya_text character offsets (dart:143-165), Ghunnah (id 10) when the phoneme
//     contains نننن / مممم (dart:167-187), otherwise Shaddah (id 9) on the first
//     adjacent duplicated consonant outside ا ۥ ۦ (dart:188-205).
//   * Verses are parsed lazily per surah from the decoded JSON map, with three caches
//     (surah verses, surah words, ayah start word index) (dart:278-425).
//
// Deviations from Dart (deliberate, port-mandated):
//   * `jsonDecode` → `JSON.parse`; the asset arrives through an injected loader
//     (Node: fs.readFileSync; React Native: Metro `require` of the JSON module), so
//     `rootBundle` and its two-path fallback move out of this module into the loader.
//     A string payload is parsed; an already-parsed object (Metro) is used as-is.
//   * Method renames per the port brief: loadData→load, loadSurahAsync→loadSurah.
//   * 'اۥۦ'.contains(c) is expressed as a UTF-16 code-unit set so the comparison is
//     numeric rather than substring based. Behaviour is identical, including for
//     lone surrogates (a surrogate code unit is in neither set).

import { ContinuousQuranWord, WordTajweedRule } from '../types';

/**
 * Asset locations tried by the Dart `rootBundle` loader, in the original order
 * (quran_data.dart:233-239). Kept as data so the platform layer can build a loader
 * from them and so the default loader can name the expected paths.
 */
export const QURAN_PHONEME_ASSET_PATHS: readonly string[] = [
  'packages/recite_quran/assets/model/ordered_quran_phonemes.json',
  'assets/model/ordered_quran_phonemes.json',
];

/**
 * Supplies `ordered_quran_phonemes.json` as a JSON string (Node) or an already
 * parsed object (Metro `require`). May be async.
 */
export type QuranDataLoader = () => unknown | Promise<unknown>;

/** Declared shape of one entry of the asset's `rule_names` map (dart:152-154). */
interface RuleNameMeta {
  ar?: string;
  en?: string;
}

/** Parsed verse payload (Dart `QuranVerse`, quran_data.dart:38-219). */
export interface QuranVerseInit {
  surah: number;
  ayah: number;
  textUthmani: string;
  surahName: string;
  surahNameEn: string;
  uthmaniWords: string[];
  textPhoneme: string;
  phonemeWords: string[];
  wordRules?: WordTajweedRule[][];
  wordMap?: number[] | null;
}

/** ── Shaddah exclusion set: Dart `!'اۥۦ'.contains(c1)` (quran_data.dart:193). ── */
const SHADDAH_EXCLUDED_CODE_UNITS: ReadonlySet<number> = new Set([
  0x0627, // ا  ALEF
  0x06e5, // ۥ  ARABIC SMALL HIGH DOTLESS SEEN (rounded ya)
  0x06e6, // ۦ  ARABIC SMALL HIGH DOTLESS FARSI YEH (dotless yeh)
]);

/** ── Hizb / Sajdah markers stripped from every Uthmani word (dart:90, 106). ── */
const HIZB_SAJDAH_REGEX = /[۞۩]/g;

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1: WordTajweedRule (quran_data.dart:10-36)
// ═══════════════════════════════════════════════════════════════════════════════

// The WordTajweedRule record itself lives in src/types.ts (Task 3) so a rule parsed
// here is assignable to the tajweed layer without a second declaration; rules are
// built as object literals below. Its live map form — Dart toMap()/fromMap()
// (quran_data.dart:23-35), the serialize pair of the alignment worker protocol at
// phoneme_alignment_isolate_protocol.dart:114-116 / :22-26 — is ported as
// wordTajweedRuleToMap / wordTajweedRuleFromMap in src/tajweed/rules.ts.

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2: QuranVerse (quran_data.dart:38-219)
// ═══════════════════════════════════════════════════════════════════════════════

export class QuranVerse {
  /** The surah (chapter) number, 1-indexed. */
  readonly surah: number;

  /** The ayah (verse) number within this surah, 1-indexed. */
  readonly ayah: number;

  /** Full Uthmani text of this ayah (the Uthmani words joined by a space). */
  readonly textUthmani: string;

  /** Arabic name of the surah (e.g. "الفاتحة"). */
  readonly surahName: string;

  /** Transliterated English name of the surah (e.g. "Al-Fatihah"). */
  readonly surahNameEn: string;

  /** Per-word Uthmani strings. Index [i] corresponds to the i-th word. */
  readonly uthmaniWords: string[];

  /** Full phonetic text of this ayah. */
  readonly textPhoneme: string;

  /** Per-word Phonetic strings. Index [i] corresponds to the i-th word. */
  readonly phonemeWords: string[];

  /** Pre-assigned Tajweed duration rules per word (Madds 1-7, Shaddah, Mushaddad Ghunnah). */
  readonly wordRules: WordTajweedRule[][];

  /**
   * Maps an index in [uthmaniWords] to the corresponding index in [phonemeWords].
   * This fixes UI drifting when idgham/wasl merges multiple Uthmani words into one
   * phoneme word (dart:66-75). Null until first read, then memoized.
   */
  private _wordMap: number[] | null;

  constructor(init: QuranVerseInit) {
    this.surah = init.surah;
    this.ayah = init.ayah;
    this.textUthmani = init.textUthmani;
    this.surahName = init.surahName;
    this.surahNameEn = init.surahNameEn;
    this.uthmaniWords = init.uthmaniWords;
    this.textPhoneme = init.textPhoneme;
    this.phonemeWords = init.phonemeWords;
    this.wordRules = init.wordRules ?? [];
    this._wordMap = init.wordMap ?? null;
  }

  get wordMap(): number[] {
    if (this._wordMap === null) {
      this._wordMap = this.uthmaniWords.map((_, i) => i);
    }
    return this._wordMap;
  }

  /**
   * quran_data.dart:92-219. Parses one asset entry into a QuranVerse:
   * 1. `aya_ui` split on ' ', drop the trailing ayah-number word when there is more
   *    than one word, strip ۞/۩, then drop words left empty.
   * 2. `aya_phonemes_list` padded with '' up to the Uthmani word count.
   * 3. Per-word rules: JSON Madd ids 1-7 by aya_text offset, else Ghunnah on
   *    نننن / مممم, else Shaddah on the first doubled consonant.
   */
  static fromJson(
    surahNum: number,
    ayahNum: number,
    json: Record<string, any>,
    globalRuleNames?: Record<string, RuleNameMeta> | null,
  ): QuranVerse {
    const rawUthmani = (json['aya_ui'] as string | undefined) ?? '';
    const rawWords = rawUthmani.trim().split(' ');

    if (rawWords.length > 1) {
      rawWords.pop();
    }

    const uthmaniWords = rawWords
      .map((w) => w.replace(HIZB_SAJDAH_REGEX, ''))
      .filter((s) => s.length > 0);

    const phonemeStr = (json['aya_phoneme'] as string | undefined) ?? '';
    let phonemeWords: string[];

    if (Object.prototype.hasOwnProperty.call(json, 'aya_phonemes_list')) {
      // Dart `List<String>.from(json['aya_phonemes_list'])` — a present-but-null
      // value throws here as it does there.
      phonemeWords = (json['aya_phonemes_list'] as string[]).slice();

      // Safety check: Pad if mismatch
      if (phonemeWords.length < uthmaniWords.length) {
        while (phonemeWords.length < uthmaniWords.length) {
          phonemeWords.push('');
        }
      }
    } else {
      phonemeWords = new Array<string>(uthmaniWords.length).fill('');
    }

    // ── Build Word Tajweed Rules directly from V2 JSON and reference phonemes ──
    const wordRules: WordTajweedRule[][] = uthmaniWords.map(() => [] as WordTajweedRule[]);

    const rawText = (json['aya_text'] as string | undefined) ?? '';
    const textWords = rawText.trim().split(' ');
    const rawRules = (json['rules'] as unknown[] | undefined) ?? [];

    let curOffset = 0;
    for (let w = 0; w < uthmaniWords.length; w++) {
      const textLen = w < textWords.length ? textWords[w].length : 0;
      const start = curOffset;
      const end = curOffset + textLen;
      curOffset = end + 1; // space

      // 1. Direct Madd Rules (IDs 1-7) from V2 rules array
      for (const r of rawRules) {
        if (Array.isArray(r) && r.length >= 3) {
          const pos = r[0] as number;
          const rId = r[1] as number;
          const harakat = r[2] as number;

          // Only keep Madd rules (1-7)
          if (rId >= 1 && rId <= 7 && pos >= start && pos < end) {
            const meta = globalRuleNames?.[String(rId)] ?? {};
            const nameAr = meta.ar ?? 'مد';
            const nameEn = meta.en ?? 'Madd';
            wordRules[w].push({
              ruleId: rId,
              nameAr,
              nameEn,
              goldenLen: harakat,
            });
          }
        }
      }

      // 2. Direct Ghunnah (~2 beats) on Mushaddad Noon & Meem only
      const ph = w < phonemeWords.length ? phonemeWords[w] : '';

      if (ph.includes('نننن')) {
        wordRules[w].push({
          ruleId: 10,
          nameAr: 'النون المشددة',
          nameEn: 'Mushaddad Noon',
          goldenLen: 2,
        });
      } else if (ph.includes('مممم')) {
        wordRules[w].push({
          ruleId: 10,
          nameAr: 'الميم المشددة',
          nameEn: 'Mushaddad Meem',
          goldenLen: 2,
        });
      } else {
        // 3. Direct Shaddah (~1-1.5 beats) on any other doubled consonant
        for (let i = 0; i < ph.length - 1; i++) {
          const c1 = ph.charCodeAt(i);
          const c2 = ph.charCodeAt(i + 1);
          if (c1 === c2 && !SHADDAH_EXCLUDED_CODE_UNITS.has(c1)) {
            wordRules[w].push({
              ruleId: 9,
              nameAr: 'الشدة',
              nameEn: 'Shaddah',
              goldenLen: 1,
            });
            break;
          }
        }
      }
    }

    return new QuranVerse({
      surah: surahNum,
      ayah: ayahNum,
      textUthmani: uthmaniWords.join(' '),
      surahName: (json['suraname_ar'] as string | undefined) ?? '',
      surahNameEn: (json['suraname_en'] as string | undefined) ?? '',
      uthmaniWords,
      textPhoneme: phonemeStr,
      phonemeWords,
      wordRules,
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3: QuranMetadataService (quran_data.dart:224-256)
// ═══════════════════════════════════════════════════════════════════════════════

// The entire database is no longer parsed upfront: the raw map is kept decoded and
// verses are parsed lazily on demand from it (dart:222-223).

function defaultLoader(): unknown {
  throw new Error(
    'QuranMetadataService: no loader was provided. Pass a loader that returns ' +
      `${QURAN_PHONEME_ASSET_PATHS.join(' or ')} (React Native: Metro ` +
      "require('../assets/model/ordered_quran_phonemes.json'); Node: fs.readFileSync(path, 'utf8')).",
  );
}

export class QuranMetadataService {
  private _rawJson: any = null;

  private readonly _loader: QuranDataLoader;

  constructor(loader: QuranDataLoader = defaultLoader) {
    this._loader = loader;
  }

  async load(): Promise<void> {
    if (this._rawJson != null) return;

    let payload: unknown;
    try {
      payload = await this._loader();
    } catch (e) {
      // Re-throw so the Orchestrator can show an error instead of silently breaking
      // the matching system (dart:241-244).
      console.error('CRITICAL ERROR loading quran phonemes:', e);
      throw e;
    }

    // Decode synchronously, exactly like the Dart jsonDecode: spawning a third
    // concurrent worker here (alongside the ASR engine and the alignment worker)
    // pushes RSS to ~300MB+ during startup on low-RAM 32-bit devices. Parsing the
    // ~13MB Quran JSON takes well under a second — acceptable for a one-time load.
    this._rawJson = typeof payload === 'string' ? JSON.parse(payload) : payload;
  }

  get rawJson(): any {
    return this._rawJson;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4: QuranRepository (quran_data.dart:278-425)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Lazily-parsed access layer over the decoded asset. ContinuousQuranWord comes from
 * src/types.ts (quran_data.dart:258-276) and is emitted here as a plain object.
 */
export class QuranRepository {
  private readonly _service: QuranMetadataService;

  private _isLoaded = false;
  private readonly _surahCache = new Map<number, QuranVerse[]>();
  private readonly _surahWordsCache = new Map<number, ContinuousQuranWord[]>();
  private readonly _ayahStartWordIndexCache = new Map<number, Map<number, number>>();

  private readonly _fallbackMetadata: QuranVerse[] = [];

  constructor(service: QuranMetadataService) {
    this._service = service;
  }

  /** One lazily parsed verse per surah (its ayah 1) carrying the surah names. */
  get surahMetadata(): QuranVerse[] {
    if (!this._isLoaded) return [];

    // We lazily parse Surah 1 verse 1 for each Surah to get the metadata
    // (surahName, surahNameEn, etc.) without parsing the whole Surah.
    if (this._fallbackMetadata.length === 0 && this._service.rawJson != null) {
      const raw = this._service.rawJson;
      const versesMap: Record<string, any> = raw['verses'] ?? raw;
      const ruleNames: Record<string, RuleNameMeta> | null = raw['rule_names'] ?? null;

      for (let i = 1; i <= 114; i++) {
        const key = `${i}:1`;
        const obj = versesMap[key];
        if (obj != null) {
          this._fallbackMetadata.push(
            QuranVerse.fromJson(i, 1, obj as Record<string, any>, ruleNames),
          );
        }
      }
    }
    return this._fallbackMetadata;
  }

  /** Loads the asset on first use, then parses (and caches) the requested surah. */
  async loadSurah(surah: number): Promise<void> {
    if (!this._isLoaded) {
      await this._service.load();
      this._isLoaded = true;
    }
    this._ensureSurahParsed(surah);
  }

  private _ensureSurahParsed(surah: number): void {
    if (this._surahCache.has(surah)) return;

    const rawJson = this._service.rawJson;
    if (rawJson == null) return;

    const versesMap: Record<string, any> = rawJson['verses'] ?? rawJson;
    const ruleNames: Record<string, RuleNameMeta> | null = rawJson['rule_names'] ?? null;

    const verses: QuranVerse[] = [];

    // Most surahs have < 300 ayahs (Al-Baqarah has 286).
    for (let ayah = 1; ayah <= 300; ayah++) {
      const key = `${surah}:${ayah}`;
      const phonemeObj = versesMap[key];
      if (phonemeObj != null) {
        verses.push(
          QuranVerse.fromJson(surah, ayah, phonemeObj as Record<string, any>, ruleNames),
        );
      } else {
        break; // Assume ayahs are contiguous and we reached the end
      }
    }

    this._surahCache.set(surah, verses);
  }

  getSurah(surah: number): QuranVerse[] {
    if (!this._isLoaded) return [];
    this._ensureSurahParsed(surah);
    return this._surahCache.get(surah) ?? [];
  }

  getSurahWords(surah: number): ContinuousQuranWord[] {
    if (!this._isLoaded) return [];
    if (this._surahWordsCache.has(surah)) {
      return this._surahWordsCache.get(surah)!;
    }

    const verses = this.getSurah(surah);

    const words: ContinuousQuranWord[] = [];
    const ayahStartMap = new Map<number, number>();
    let globalIdx = 0;

    for (const verse of verses) {
      ayahStartMap.set(verse.ayah, globalIdx);
      for (let i = 0; i < verse.phonemeWords.length; i++) {
        const uthmani = i < verse.uthmaniWords.length ? verse.uthmaniWords[i] : '';
        const rules = i < verse.wordRules.length ? verse.wordRules[i] : [];
        words.push({
          globalIndex: globalIdx++,
          surah: verse.surah,
          ayah: verse.ayah,
          wordInAyah: i,
          uthmani,
          phoneme: verse.phonemeWords[i],
          rules,
        });
      }
    }

    this._ayahStartWordIndexCache.set(surah, ayahStartMap);
    this._surahWordsCache.set(surah, words);
    return words;
  }

  getAyahStartGlobalIndex(surah: number, ayah: number): number {
    if (!this._surahWordsCache.has(surah)) {
      this.getSurahWords(surah);
    }
    return this._ayahStartWordIndexCache.get(surah)?.get(ayah) ?? 0;
  }

  getVerse(surah: number, ayah: number): QuranVerse | null {
    if (!this._isLoaded) return null;
    const verses = this.getSurah(surah);
    if (ayah >= 1 && ayah <= verses.length) {
      return verses[ayah - 1];
    }
    return null;
  }

  getNextVerse(surah: number, ayah: number): QuranVerse | null {
    const verses = this.getSurah(surah);
    if (ayah >= 1 && ayah < verses.length) {
      return verses[ayah]; // 0-indexed internally
    }
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5: WORD BOUNDARIES (lib/recite_quran.dart:197-205)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Cumulative UTF-16 code-unit offsets of each phoneme word inside
 * `phonemeWords.join('')` — the reference consumed by the alignment worker
 * (recite_quran.dart:125-131) and by the highlighting controller
 * (highlighting_controller.dart:288-293). Length is `phonemeWords.length + 1`.
 */
export function calculateBoundaries(phonemeWords: string[]): number[] {
  const boundaries: number[] = [0];
  let currentOffset = 0;
  for (const w of phonemeWords) {
    currentOffset += w.length;
    boundaries.push(currentOffset);
  }
  return boundaries;
}