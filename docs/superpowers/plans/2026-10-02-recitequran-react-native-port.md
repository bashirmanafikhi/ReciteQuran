# ReciteQuran Flutter → React Native/Expo Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the ReciteQuran recitation-tracking engine (audio → sherpa-onnx Zipformer2-CTC → CTC token processing → semi-global DTW word matching → sequencing → Tajweed duration analysis) from Dart/Flutter to a React Native + Expo Android library with behavior identical to the original for the same audio input.

**Architecture:** Kotlin owns microphone capture and sherpa-onnx inference (mirroring the original isolate's recognizer config byte-for-byte, including 7,680-sample silence priming). Cumulative CTC token + timestamp arrays cross the JS bridge (~2/s). TypeScript ports the entire pure-Dart post-processing pipeline (`AsrTokenProcessor` → `PhoneticCostEngine`/`QuranDictationMatcher` → `DictationSequencer` → `ErrorExplainer`) plus Quran data loading and the session facade. The original `lib/` Dart engine stays in the repo as source of truth and verification reference.

**Tech Stack:** TypeScript (Node ≥ 18, Jest), Kotlin (Android, sherpa-onnx Android AAR), React Native library layout, Expo config plugin, sherpa-onnx npm package (verification harness only).

**Spec:** This plan argues directly from the original Dart sources — every port task lists the exact `file:line` range that is the authoritative specification. The user's port brief (steps 1–6 + important rules) is the project spec: no Whisper, no cloud ASR, no model/threshold/algorithm changes, logical commits, fork preserved.

## Global Constraints

- Do NOT change: model (`zipformer_p_arabic_v3.int8.onnx`), thresholds, cost matrices, Quran data, matching/sequencing algorithms, constants. Platform-required deviations only, documented in commits.
- Dart and JS both use UTF-16 code units; port all Arabic string indexing/`codeUnitAt` logic with equivalent JS (`.charCodeAt`, `.length`, `.substring`) — never code-point iteration.
- Build output goes to `dist/` (NOT `lib/` — `lib/` is the original Dart source).
- Keep repository a fork: original `lib/`, `assets/`, `bin/`, `pubspec.yaml`, `README.md`, `LICENSE` remain; only `example/` and Flutter scaffolding are deleted.
- Every task ends with `npx tsc --noEmit` + `npx jest` green (from Task 2 on) and a git commit.
- Environment: Windows, Node v26, Java 17. Flutter/Dart is NOT installed (install only at Task 15).

---

### Task 1: Repository cleanup (remove Flutter demo/scaffolding)

**Files:**
- Delete: `example/` (entire directory), `.metadata`, `.pubignore`
- Keep untouched: `lib/`, `assets/`, `bin/`, `pubspec.yaml`, `pubspec.lock`, `README.md`, `LICENSE`, `CHANGELOG.md`, `.gitignore`

**Interfaces:**
- Consumes: nothing
- Produces: clean repo; Dart engine in `lib/` still runnable later for verification harness (Task 15)

- [ ] **Step 1: Confirm `example/` has nothing engine-related**

Run: `git ls-files example | Measure-Object -Line` and spot-check that `example/lib` is only UI (known: `main.dart`, `ui/`, `state/` — all demo).

- [ ] **Step 2: Delete demo + scaffolding**

```powershell
git rm -r -q example
git rm -q .metadata .pubignore
```

- [ ] **Step 3: Verify engine untouched**

Run: `git status --short` — only deletions under `example/` and the two root files.

- [ ] **Step 4: Commit**

```powershell
git add -A
git commit -m "chore: remove Flutter demo app and scaffolding (keep engine for port)"
```

---

### Task 2: npm package scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `jest.config.js`, `.gitignore` (append; keep existing Flutter entries)

**Interfaces:**
- Consumes: nothing
- Produces: `npm test` / `npm run typecheck` / `npm run build` commands used by all later tasks

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "react-native-recite-quran",
  "version": "0.1.0",
  "description": "On-device Quran recitation tracking (Zipformer2-CTC + DTW + Tajweed) for React Native / Expo (Android)",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist", "android", "plugin", "app.plugin.ts", "assets/model/tokens.txt"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit",
    "test": "jest"
  },
  "peerDependencies": { "react": "*", "react-native": "*" },
  "devDependencies": {
    "typescript": "^5.5.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.2.0",
    "@types/jest": "^29.5.0",
    "@types/react": "*"
  }
}
```

Note: React/React Native are only needed for the thin native-binding file (Task 12); core engine must import nothing from `react-native` (injectable transport instead) so Jest runs pure.

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020", "module": "commonjs", "lib": ["ES2020"],
    "outDir": "dist", "rootDir": "src", "strict": true,
    "declaration": true, "esModuleInterop": true, "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `jest.config.js`**

```js
module.exports = { preset: 'ts-jest', testEnvironment: 'node', testMatch: ['**/tests/**/*.test.ts'] };
```

- [ ] **Step 4: Install and verify**

Run: `npm install` then `npx tsc --noEmit` (empty src is OK) and `npx jest` (no tests yet, exits 1 with "no tests found" → add `--passWithNoTests` to the test script initially).

- [ ] **Step 5: Append node entries to `.gitignore`** (`node_modules/`, `dist/`, `verification/**/node_modules/`, `*.tsbuildinfo`, `assets/model/*.onnx`)

- [ ] **Step 6: Commit** — `chore: scaffold TypeScript package (tsc + jest)`

---

### Task 3: Port `TrackerConfig` + shared types

**Files:**
- Create: `src/config.ts`, `src/types.ts`, `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces (used by every later port):
  - `export interface TrackerConfig { defaultMaxPathCost: number; shortWordPathCost: number; mediumWordPathCost: number; maxSkipWords: number; acousticConfusionCost: number; standardInsertionCost: number; standardDeletionCost: number; harakatDurationSeconds: number; maxTokenDurationAllowed: number; lookaheadDelay: number; hideExpectedAsrNoise: boolean; enableEarlyMatching: boolean; }`
  - `export const TrackerConfigPresets = { normal(), easy(), strict() }` and `copyWithConfig(cfg, partial)`
  - `src/types.ts`: `TranscriptionResult { text, isFinal, startTime, tokens: string[], timestamps: number[], streamEpoch }`, `ProcessedAudioStream { tokens: string[]; durations: number[] }`, `WordMatchedEvent { wordId, score, cleanAsr, tajweedErrors: ReciterErrorMap[] | null, isRed, isNeutral }`, `ReciterErrorMap` (map form of `ReciterError`, `error_explainer.dart:78-90`), `WordTajweedRule { ruleId, nameAr, nameEn, goldenLen }` (`quran_data.dart:10-36`), `ContinuousQuranWord { globalIndex, surah, ayah, wordInAyah, uthmani, phoneme, rules }` (`quran_data.dart:258-276`), `PhonemeGroupAlignment { opType, refIdx, predIdx }` (`error_explainer.dart:146-156`)

- [ ] **Step 1: Write failing tests** — `tests/config.test.ts` asserting exact preset numbers from `tracker_config.dart:55-87`:

```ts
import { normalConfig, easyConfig, strictConfig, copyWithConfig } from '../src/config';
test('normal preset defaults', () => {
  expect(normalConfig()).toEqual({
    defaultMaxPathCost: 0.30, shortWordPathCost: 0.25, mediumWordPathCost: 0.28,
    maxSkipWords: 2, acousticConfusionCost: 0.25, standardInsertionCost: 0.75,
    standardDeletionCost: 1.0, harakatDurationSeconds: 0.200,
    maxTokenDurationAllowed: 2.5, lookaheadDelay: 0.320,
    hideExpectedAsrNoise: true, enableEarlyMatching: true,
  });
});
test('easy preset', () => expect(easyConfig()).toMatchObject(
  { defaultMaxPathCost: 0.40, shortWordPathCost: 0.30, mediumWordPathCost: 0.35,
    maxSkipWords: 3, acousticConfusionCost: 0.15, standardInsertionCost: 0.50,
    standardDeletionCost: 0.80, harakatDurationSeconds: 0.150, maxTokenDurationAllowed: 3.0 }));
test('strict preset', () => expect(strictConfig()).toMatchObject(
  { defaultMaxPathCost: 0.25, shortWordPathCost: 0.20, mediumWordPathCost: 0.23,
    maxSkipWords: 1, acousticConfusionCost: 0.35, standardInsertionCost: 1.0,
    standardDeletionCost: 1.0, harakatDurationSeconds: 0.250, maxTokenDurationAllowed: 2.0,
    hideExpectedAsrNoise: false, enableEarlyMatching: false }));
test('copyWith keeps other fields', () =>
  expect(copyWithConfig(normalConfig(), { maxSkipWords: 5 }).defaultMaxPathCost).toBe(0.30));
```

- [ ] **Step 2: Run** `npx jest tests/config.test.ts` → FAIL (module missing)
- [ ] **Step 3: Implement** `src/config.ts` (literal values from `tracker_config.dart:39-118`) and `src/types.ts` (field-for-field from the file:line refs above)
- [ ] **Step 4: Run** `npx jest` → PASS; `npx tsc --noEmit` → clean
- [ ] **Step 5: Commit** — `feat(ts): port TrackerConfig and shared event types`

---

### Task 4: Port Tajweed duration rules

**Files:**
- Create: `src/tajweed/rules.ts`, `tests/rules.test.ts`

**Interfaces:**
- Consumes: `TrackerConfig` (`harakatDurationSeconds`)
- Produces: `LangName`, `TajweedDurationStatus = 'valid' | 'defect' | 'surplus'`, abstract `TajweedRule { name; goldenLen; requiredDuration(hBase); checkDurationStatus(d, hBase) }`, concrete classes `NormalMaddRule(1.2)`, `MonfaselMaddRule(4)`, `MottaselMaddRule(4)`, `MottaselMaddPauseRule(4)`, `AaredMaddRule(4)`, `LazemMaddRule(6)`, `LeenMaddRule(4)`, `MushaddadGhunnahRule(2)`, `ShaddahRule(1)` — exact class names preserved because `ReciterError` serialization uses `runtimeType.toString()` (`error_explainer.dart:109`) → in TS a `type` string per class matching the Dart class name.

**Spec:** `tajweed_rules.dart` (all 236 lines, zero imports). Key math: required = `goldenLen * hBase`; defect if `< required`; surplus if `> required + (goldenLen <= 2 ? 2.5 : 4.0) * hBase` (`tajweed_rules.dart:89-113`); overrides: `MushaddadGhunnahRule.getRequiredDuration = 2.0 * hBase` (L218), `ShaddahRule.getRequiredDuration = 1.5 * hBase` (L234).

- [ ] **Step 1: Write failing tests** (expected values at `hBase = 0.20`): NormalMadd required `0.24` (goldenLen 1.2), 4-harakat rules `0.80`, Lazem `1.20`, Ghunnah `0.40`, Shaddah `0.30`; status matrix: `checkDurationStatus(0.20, 0.2)` on NormalMadd → `'defect'`; `(0.24)` → `'valid'`; `(0.24 + 2.5*0.2 + ε)` → `'surplus'`; `goldenLen<=2` uses 2.5×cap, `>2` uses 4.0×cap; `goldenLen<=0` → `'valid'`.
- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement** `src/tajweed/rules.ts` as a direct transliteration; each class has `readonly type: string` = exact Dart class name (`'NormalMaddRule'`, …).
- [ ] **Step 4: Run → PASS**, `tsc --noEmit` clean
- [ ] **Step 5: Commit** — `feat(ts): port Tajweed duration rules`

---

### Task 5: Port the DTW matcher (PhoneticCostEngine + QuranDictationMatcher)

**Files:**
- Create: `src/engine/matcher.ts`, `tests/matcher.test.ts`

**Interfaces:**
- Consumes: `TrackerConfig` (Task 3), `PhonemeGroupAlignment`, `ReciterErrorMap` types (Task 3)
- Produces:
  - `export interface WordMatchResult { pathCost: number; tokensConsumed: number; cleanAsr: string; timestamps: number[]; trace: PhonemeGroupAlignment[]; isPartial: boolean; }`
  - `export const PhoneticCostEngine = { isTashkeel(c), isMaddVowel(c), isZeroCostMarker(c), isEquivalentGlyph(a,b), isAcousticConfusion(a,b), getSubstitutionCost(a,b,acc?), getDeletionCost(full,gIdx,del?,acc?), getInsertionCost(asr,idx,ins?,acc?) }`
  - `export function matchWord(args: { asrText: string; asrTimestamps: number[]; fullPhonemes: string; refStart: number; refEnd: number; config: TrackerConfig; isTajweed: boolean }): WordMatchResult | null`

**Spec:** `dictation_matcher.dart` (549 lines). Critical exact behaviors:
- Cost tiers (`L58-214`): zero-cost markers `0x0686 0x06DC 0x0619 0x06EA 0x0640`; equivalent glyph pairs list (L69-91); acoustic confusion pairs (L97-135) → `config.acousticConfusionCost`; everything else `1.0`. `getSubstitutionCost` check order: equal → equivalent → acoustic → tashkeel → 1.0.
- `getDeletionCost`: zero-cost marker → 0; hamza variant → acc cost; repeat of predecessor → acc cost; else del cost (L171-192).
- `getInsertionCost`: zero-cost marker → 0; repeat AND madd vowel → acc cost; else ins cost (L195-213).
- DP (`L253-336`): row 0 = cumulative deletion costs; **column 0 = 0.0 free-start with bt=2**; tie-break `sub < del && sub <= ins → sub; del <= ins → del; else ins` (asymmetric on purpose, L321-334). Buffers `Float64Array`/`Uint8Array` grown by doubling from 2048.
- `effN` (L367-382): exclude zero-cost markers and Madd vowel identical to predecessor; clamp ≥ 1.
- Threshold (L386-393): `min(config.defaultMaxPathCost, effN<=3 ? shortWordPathCost : effN<=7 ? mediumWordPathCost : defaultMaxPathCost)`.
- Endpoint search (L405-414): `norm = dp[i*stride+n]/effN`, gate `<= threshold`, `allowEarlyBreak = enableEarlyMatching && !isTajweed && effN >= 4`; early → strict `<` + break at 0.0; baseline → `<=` taking latest i.
- Partial rules (L421-489): strict-frontier (Tajweed on, `bestI == m`) and prefix fallback (`minJ = n>2?2:1`, `startI = max(1, m-2)`); returns sentinel `{pathCost:0, tokensConsumed:0, cleanAsr:'', timestamps:[], trace:[], isPartial:true}`; `bestI < 0` and not partial → `null`.
- Traceback (L494-547): ops `match|replace|delete|insert`, `refIdx` absolute, push `asrTimestamps[ci-1]` guarded; result `cleanAsr = asrText.substring(0, bestI)`, reversed to forward order.

- [ ] **Step 1: Write failing tests** — table-driven cost tests (exact pairs above), then alignment tests: (a) exact match `asr='بسم'` vs ref `'بسم'` → pathCost 0, tokensConsumed 3; (b) leading ASR noise free-start: `asr='xxبسم'` still matches with tokensConsumed ≥ 3; (c) threshold gating: short word (≤3 eff chars) rejects noisy candidate; (d) partial sentinel when Tajweed-on frontier misses a core consonant; (e) `null` when nothing aligns; (f) deletion tie-break: equal sub/del prefers path where deletions trail.
- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement** `src/engine/matcher.ts` as a line-by-line transliteration of `dictation_matcher.dart:58-549`. Use `charCodeAt` (UTF-16, matches Dart `codeUnitAt`).
- [ ] **Step 4: Run → PASS**, `tsc --noEmit` clean
- [ ] **Step 5: Commit** — `feat(ts): port semi-global DTW matcher and phonetic cost engine`

---

### Task 6: Port ErrorExplainer (Tajweed diagnostics)

**Files:**
- Create: `src/tajweed/errorExplainer.ts`, `tests/errorExplainer.test.ts`

**Interfaces:**
- Consumes: Task 3 types (`WordTajweedRule`, `PhonemeGroupAlignment`, `ReciterErrorMap`, `TrackerConfig`), Task 4 rules
- Produces: `export function evaluatePreAlignedWords(args: { alignments: PhonemeGroupAlignment[]; fullPhonemes: string; wordBoundaries: number[]; currentAsrText: string; trackingTimestamps: number[]; bestAsrStartIdx: number; targetCharCursor: number; startWordId: number; nextWordId: number; totalAyahWords: number; expectedWordRules: WordTajweedRule[]; config: TrackerConfig }): Map<number, ReciterErrorMap[]>` — returns per-word error maps (serializable, identical map keys to `error_explainer.dart:78-90`: `errorType`/`speechErrorType` as ordinal indices, rule as `{type, nameAr, nameEn, goldenLen}`).

**Spec:** `error_explainer.dart` (703 lines). Critical behaviors:
- Span building (L327-475): Madd runs of `اۥۦ`; Ghunnah base `نم` ≥3 repeats + trailing harakah, ruleId 10 goldenLen 2; Shaddah adjacent duplicate not in `اۥۦ` + trailing harakah, ruleId 9 goldenLen 1; else consonant + residuals from `َُِڇؙ۪ۜـ`.
- Duration aggregation (L246-260): unique `predIdx`, `absPred = bestAsrStartIdx + predIdx`, sum `trackingTimestamps[absPred]`.
- Evaluation phases (L480-617): hBase = `config.harakatDurationSeconds`; only `defect` produces tajweed/replace errors; Shaddah also fails if `predBaseCount < 2`; tashkeel phase with `isTerminalWaqf` exception.
- `_instantiateTajweedRule` (L647-676): ruleId 1→NormalMadd, 2→Monfasel, 3→Mottasel, 4→MottaselPause, 5→Aared, 6→Lazem, 7→Leen, 9→Shaddah, 10→MushaddadGhunnah (JSON goldenLen deliberately ignored — preserve!), default→Madd with goldenLen.
- Post-processing (L280-302): sort by priority (normal=0, tashkeel=1, Madd=2, Ghunnah=3, Shaddah=4, else 5); **drop all `surplus`**; drop `normal` when `hideExpectedAsrNoise && _isExpectedAsrNoise` (noise set L687-688); dedupe key `${errorType}_${ruleType}_${expectedPh}`.
- Enums serialized by ordinal: `ErrorCategory {tajweed, normal, tashkeel}`, `SpeechErrorType {insert, delete, replace}`, `TajweedDurationStatus {valid, defect, surplus}` — declare as const arrays to freeze ordinals.

- [ ] **Step 1: Write failing tests**: (a) duration sum over alignments with duplicated predIdx counted once; (b) Madd defect detected with goldenLen from rule; (c) surplus errors filtered out; (d) ruleId→class mapping incl. goldenLen-ignored case; (e) dedupe identical errors.
- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement** transliteration of `error_explainer.dart:26-703`.
- [ ] **Step 4: Run → PASS**, `tsc --noEmit` clean
- [ ] **Step 5: Commit** — `feat(ts): port Tajweed error explainer`

---

### Task 7: Port DictationSequencer

**Files:**
- Create: `src/engine/sequencer.ts`, `tests/sequencer.test.ts`

**Interfaces:**
- Consumes: `matchWord` (Task 5), `evaluatePreAlignedWords` (Task 6), `TrackerConfig` (Task 3)
- Produces:
  - `export type SequencerEvent = { type: 'highlight'; wordId; score; cleanAsr; tajweedErrors; isRed; isNeutral } | { type: 'debug'; message; asrBuffer }`
  - `export class DictationSequencer { constructor(onEvent: (e: SequencerEvent) => void); setSurahReference(cmd: {phonemes: string; boundaries: number[]; surahNumber: number; isTajweed: boolean; forceClear: boolean; startGlobalWord: number; wordRules: WordTajweedRule[][] | null}); syncStream(cmd: {text: string; timestamps: number[]; isNewSegment: boolean; ayahNumber: number}); jumpToWord(globalWordIndex: number); setTajweedMode(v: boolean); updateConfig(c: TrackerConfig); readonly currentSegmentAsrText: string; }`

**Spec:** `dictation_sequencer.dart` (455 lines). Critical behaviors:
- State (L22-51): `fullPhonemes` spaces stripped (L75), `wordBoundaries`, `asrCharAnchor`, `_trimmedOffset`, `_pendingTail`, `targetWordCursor`, committed sets.
- Main loop `_processSequence` (L171-307): early-matching shield (drain pending tail first, L179-182); slice unconsumed text + timestamps at anchor (L185-187); **skip loop** `for skip in 0..config.maxSkipWords` (L193); **merge loop** `for merge in 1..2` (Wasl/Idgham, L201); `refEnd = boundaries[endW+1] ?? fullPhonemes.length`; partial → wait (skip==0) or ignore (skip>0); red commits for skipped words (L237-240); green commits for merged range (L241-245); anchor += tokensConsumed, cursor = endW+1; pending-tail reservation only when `enableEarlyMatching && !isTajweed` (L260-280); head trim: cushion 50, trim when anchor > 100 (L294-306).
- `_drainPendingTail` (L140-167): exact char match advances both; both-madd-vowel advances anchor only; mismatch clears tail.
- `_commitGreen` (L355-364): `score = max(0, 1 - pathCost)`; tajweedErrors from `evaluatePreAlignedWords` only when `isTajweed && trace.length > 0` (args L324-348: `targetCharCursor: 0, bestAsrStartIdx: 0`, currentAsrText = unconsumed slice).
- `_commitRed` (L371-393): guards committed sets; `score 0`, `isRed: true`.
- `_isValidMerge` (L404-454): forgive edge `min(2, wordLen~/3)` on interior edges; coreCost average vs `config.defaultMaxPathCost` (0.30).
- `setSurahReference` clears committed sets, cursor = `startGlobalWord.clamp(0, wordCount)`; `jumpToWord` clears buffer/anchor and removes committed ≥ cursor; `syncStream` resets on `isNewSegment || text.length < _trimmedOffset`.

- [ ] **Step 1: Write failing tests** with a synthetic reference (e.g. words `["بِسمِ", "للَااهِ"]` → phonemes + boundaries): (a) clean sequential match → green events in order with score ≈ 1; (b) gap in ASR → red event for skipped word; (c) merge across word boundary (Wasl) commits both green; (d) partial match waits (no event) then completes next sync; (e) head-trim keeps events stable across >100 chars; (f) score = `1 - pathCost` clamp at 0; (g) tajweed errors attached only when isTajweed.
- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement** transliteration of `dictation_sequencer.dart`.
- [ ] **Step 4: Run → PASS**, `tsc --noEmit` clean
- [ ] **Step 5: Commit** — `feat(ts): port dictation sequencer (skip/merge/wasl/commit logic)`

---

### Task 8: Port AsrTokenProcessor (CTC token → durations)

**Files:**
- Create: `src/engine/tokenProcessor.ts`, `tests/tokenProcessor.test.ts`

**Interfaces:**
- Consumes: `TranscriptionResult`, `ProcessedAudioStream`, `TrackerConfig` (Task 3)
- Produces: `export class AsrTokenProcessor { constructor(config?: TrackerConfig); get lookaheadDelay(): number; reset(): void; process(result: TranscriptionResult): ProcessedAudioStream }`

**Spec:** `highlighting_controller.dart:46-179` (only this class; rest of file is Flutter UI, not ported). Critical behaviors:
- Common-prefix diff vs `_lastRawTokens`; prefix shrink → full reset (L73-86).
- `realTs = max(0, timestamps[i] - lookaheadDelay)` (L101); blanks (`''`, `<blank>`, `<blk>`, `<eps>`, `eps`) skipped, remembering `lastBlankTs` (L103-110).
- Per-token duration = `min(maxTokenDurationAllowed, max(0.04, interval))`, **max(backward, forward)** attribution, forward interval clamped at intervening blank; first token fallback `curSpike - 0.15` (L120-172).

- [ ] **Step 1: Write failing tests**: (a) blank tokens dropped; (b) lookaheadDelay subtracted and clamped ≥ 0; (c) min duration 0.04, max = config; (d) backward/forward max rule; (e) cumulative result with growing prefix → deltas only; (f) prefix shrink → reset.
- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement** transliteration.
- [ ] **Step 4: Run → PASS**, `tsc --noEmit` clean
- [ ] **Step 5: Commit** — `feat(ts): port CTC token processor (durations + lookahead)`

---

### Task 9: Port Quran data layer

**Files:**
- Create: `src/data/quranData.ts`, `tests/quranData.test.ts`

**Interfaces:**
- Consumes: `assets/model/ordered_quran_phonemes.json` (kept in repo), `WordTajweedRule`, `ContinuousQuranWord` (Task 3)
- Produces:
  - `export class QuranMetadataService { constructor(loader: () => unknown | Promise<unknown>); load(): Promise<void>; get rawJson(): any }` — loader is injected (Node test passes `require`/`fs.read`; RN passes Metro `require('../assets/model/ordered_quran_phonemes.json')`). Default loader throws with a clear message.
  - `export class QuranRepository { constructor(service); loadSurah(surah: number): Promise<void>; getSurahWords(surah: number): ContinuousQuranWord[]; getAyahStartGlobalIndex(surah, ayah): number; getVerse(surah, ayah): QuranVerse | null; getNextVerse(surah, ayah): QuranVerse | null; get surahMetadata(): {surah, ayah, ...}[] }`
  - `calculateBoundaries(phonemeWords: string[]): number[]` (cumulative, `recite_quran.dart:197-205`)

**Spec:** `quran_data.dart` (425 lines). Critical parsing (`QuranVerse.fromJson`, L92-219): `aya_ui` split, **drop last word if count > 1** (ayah number), strip `۞۩`; `aya_phonemes_list` padded with `''` to uthmani count; rules: JSON `rules` entries `[pos, ruleId, harakat]` mapped through char offsets in `aya_text` (ruleId 1-7 only, L145-154); Ghunnah if phoneme contains `نننن`/`مممم` (goldenLen 2); Shaddah first adjacent duplicate not in `اۥۦ` (goldenLen 1). Repository: parse keys `"<s>:<a>"` for ayah 1..300 until missing (L350-352); `getSurahWords` flattens with increasing `globalIndex` and records ayah start indices (L364-399).

- [ ] **Step 1: Write failing tests** loading the real JSON from `assets/model/ordered_quran_phonemes.json` via fs: (a) surah 1 has 7 ayahs / word count matches `getAyahStartGlobalIndex(1,1) == 0`; (b) `1:1` phonemeWords = `["بِسمِ","للَااهِ","ررَحمَاانِ","ررَحِۦۦۦۦم"]`; (c) ayah-number word stripped from uthmani; (d) Madd rule from JSON mapped to word 0 with ruleId 1; (e) boundaries cumulative; (f) total words across all surahs = expected continuous indexing (spot-check surah 2 start index).
- [ ] **Step 2: Run → FAIL** (note: first run parses 12.8 MB — keep tests fast by loading once in `beforeAll`)
- [ ] **Step 3: Implement** transliteration (JSON.parse replaces jsonDecode).
- [ ] **Step 4: Run → PASS**, `tsc --noEmit` clean
- [ ] **Step 5: Commit** — `feat(ts): port Quran metadata service and repository`

---

### Task 10: Port the session facade (ReciteQuran → TS pipeline)

**Files:**
- Create: `src/session.ts`, `src/index.ts`, `tests/session.test.ts`

**Interfaces:**
- Consumes: Tasks 3–9; an injected `AsrTransport` interface (so tests don't need React Native):
  ```ts
  export interface AsrTransport {
    initialize(): Promise<void>;
    start(onResult: (r: TranscriptionResult) => void): void; // starts mic + inference
    stop(): Promise<void>;
    resetBuffer(): void;
    destroy(): void;
  }
  ```
- Produces (public API per user brief):
  ```ts
  export class ReciteQuran {
    static createSession(opts: { surah: number; ayahFrom?: number; ayahTo?: number;
      config?: TrackerConfig; isTajweed?: boolean; transport?: AsrTransport }): Promise<ReciteQuran>;
    start(): Promise<void>;
    stop(): Promise<void>;
    onWordMatched(cb: (e: WordMatchedEvent) => void): () => void;
    onWordSkipped(cb: (e: WordMatchedEvent) => void): () => void;   // isRed events
    onTranscript(cb: (t: string) => void): () => void;
    onTajweed(cb: (e: WordMatchedEvent) => void): () => void;       // green with errors
    setTargetSurah(surah: number, opts?: { startGlobalWord?: number; ayahFrom?: number; ayahTo?: number }): Promise<void>;
    jumpToWord(globalWordIndex: number): void;
    resetBuffer(): void;
    setTajweedMode(active: boolean): void;
    updateConfig(cfg: TrackerConfig): void;
    dispose(): void;
  }
  ```
  Internal wiring mirrors `recite_quran.dart:94-207`: transport result → `AsrTokenProcessor.process` → per-char duration expansion when tajweed (see below) → `DictationSequencer.syncStream` → events dispatched to subscribers (isRed → skipped; else matched; green+errors → tajweed too).
  - **Ayah range (`ayahFrom`/`ayahTo`)**: build `fullPhonemes`/`boundaries` only from the ayah window (cumulative offsets rebased to 0) — semantics equal to original `setTargetSurah` + `startGlobalWord`, implemented via `getSurahWords` slicing: `start = getAyahStartGlobalIndex(surah, ayahFrom)`, end at last word of `ayahTo`.
  - **Per-char timestamp expansion**: original `HighlightingController` expands token durations to per-char before `syncStream` (`highlighting_controller.dart:612-619`: `duration / max(1, token.length)` per char). Port THAT behavior (it is the path the example app actually used); token-level path in `recite_quran.dart` is the legacy outlier. Document this in the commit message.

- [ ] **Step 1: Write failing tests** with a `FakeAsrTransport` emitting scripted `TranscriptionResult`s: (a) happy path — surah 1, feed token stream of Al-Fatihah words → green events in order with correct wordIds; (b) missing word → red/skipped event; (c) tajweed defect → matched event carries `tajweedErrors`; (d) `onWordSkipped` receives only isRed; (e) `setTargetSurah` + `jumpToWord` reset behavior; (f) ayah range slicing (surah 1 ayah 1..3 only).
- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement** `src/session.ts` + `src/index.ts` (exports public API only).
- [ ] **Step 4: Run → PASS**, `npx tsc --noEmit` clean, `npm run build` produces `dist/`.
- [ ] **Step 5: Commit** — `feat(ts): port ReciteQuran session facade with injectable ASR transport`

---

### Task 11: Android native module (audio + sherpa-onnx + bridge)

**Files:**
- Create: `android/build.gradle`, `android/src/main/AndroidManifest.xml`, `android/src/main/java/com/recitequran/ReciteQuranPackage.kt`, `.../ReciteQuranModule.kt`, `.../SherpaAsrEngine.kt`, `.../AudioRecorder.kt`
- Modify: `package.json` (add `"react-native": { ... }` autolinking hints if needed)

**Interfaces:**
- Consumes: model file name/URL from `bin/download_model.dart:13-17` (`zipformer_p_arabic_v3.int8.onnx`, `https://github.com/Iam-Muslim/Natlu/releases/download/models-latest/zipformer_p_arabic_v3.int8.onnx`), `tokens.txt` (bundled npm asset), recognizer config from `sherpa_engine_io.dart:274-296`
- Produces (bridge contract used by Task 12):
  - Methods: `initialize(modelPath?: string): Promise<{ok: boolean; error?: string}>` (extract/download model + tokens to files dir), `prefetchModel(onProgress?: (pct:number)=>void): Promise<string>`, `start(): void` (mic + inference), `stop(): Promise<void>`, `resetBuffer(): void`, `feedAudioBase64(b64: string, isFinal: boolean): boolean` (offline/test path), `processWav(path: string): Promise<void>` (debug: emits results for a WAV file — verification aid)
  - Events: `ReciteQuranTokenResult` → `{ text: string; tokens: string[]; timestamps: number[]; isFinal: boolean; startTime: number; streamEpoch: number }`

**Spec (must match exactly):**
- Recognizer: `OnlineRecognizer` with `feat(sampleRate=16000, featureDim=80)`, `zipformer2Ctc(model=…)`, `tokens=…`, `numThreads=2`, `modelType='zipformer2_ctc'`, `provider='xnnpack'` on Android (fallback `'cpu'` on init failure, mirroring marker logic `sherpa_engine_io.dart:302-360` simplified to try/catch), `enableEndpoint=true`, rule1=10.0, rule2=4.0, rule3=9999.0 (`sherpa_engine_io.dart:274-296`).
- Stream lifecycle: create stream → accept priming **7,680 zero floats** → `while(isReady) decode` (`sherpa_engine_io.dart:358-366`); per audio buffer `acceptWaveform(16000, samples)` → decode loop → `getResult` → emit unless endpoint detected; `isFinal` → `inputFinished()` + drain + final emit; `resetBuffer` → `recognizer.reset(stream)` + re-prime (L452-460); bump `streamEpoch` on reset (both sides, L217-232).
- Audio: `AudioRecord` 16,000 Hz, mono, PCM16, `VOICE_RECOGNITION` source with `NoiseSuppressor`/`AutomaticGainControl` disabled when available (mirrors `record` plugin `noiseSuppress:false, autoGain:false` — verify against record_android source during implementation and note the chosen `AudioSource` in the commit message). Feed continuous floats to the recognizer (chunk framing is internal to `acceptWaveform`, so results are identical to 480 ms framing).
- Model management: if files-dir copy missing or `< 1024` bytes, download with progress to `.tmp` then atomic rename (`sherpa_engine_io.dart:73-111` semantics); tokens.txt extracted from npm package assets.

- [ ] **Step 1: Write `android/build.gradle`** using `com.k2fsa.sherpa:onnx` AAR — **determine the AAR version matching sherpa-onnx Dart 1.13.6** (check `pubspec.lock`/sherpa_onnx package changelog → native sherpa-onnx version → pick same from Maven Central). Document the match in the commit message.
- [ ] **Step 2: Implement `SherpaAsrEngine.kt`** (recognizer lifecycle + config above), **`AudioRecorder.kt`** (AudioRecord loop), **`ReciteQuranModule.kt`** (bridge methods/events), **`ReciteQuranPackage.kt`**.
- [ ] **Step 3: Compile check** — `cd android && gradlew :compileReleaseKotlin` is not available standalone; instead verify by `npx tsc` unaffected + defer full compile to Task 13's example build OR run `gradle` assemble if a host RN project exists. (Minimum: code review against sherpa-onnx Java API javadoc.)
- [ ] **Step 4: Commit** — `feat(android): sherpa-onnx + AudioRecord native module (mirrors Dart engine config)`

---

### Task 12: RN TypeScript native binding

**Files:**
- Create: `src/nativeTransport.ts`, `src/nativeModule.ts`
- Modify: `src/index.ts` (export `createNativeTransport()`)

**Interfaces:**
- Consumes: Task 10 `AsrTransport`, Task 11 bridge contract
- Produces: `export function createNativeTransport(opts?: { modelUrl?: string }): AsrTransport` — subscribes to `ReciteQuranTokenResult` events, adapts to `TranscriptionResult`, implements init/start/stop/resetBuffer/destroy via `NativeModules.ReciteQuran` (lazy `require('react-native')` so Node tests never load RN).

- [ ] **Step 1: Write unit tests with a mocked `react-native` module** (`jest.mock('react-native', …)`) verifying event → `TranscriptionResult` adaptation and epoch bump handling.
- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement**, keeping ALL engine logic out of this file (transport only).
- [ ] **Step 4: Run → PASS**, `tsc --noEmit` clean
- [ ] **Step 5: Commit** — `feat(ts): native ASR transport binding`

---

### Task 13: Expo config plugin + package docs

**Files:**
- Create: `app.plugin.ts`, `plugin/withReciteQuran.ts` (or plain JS `plugin/src/index.js` to avoid requiring the consumer to compile TS), `README-rn.md` (or append section to README.md)

**Interfaces:**
- Consumes: `@expo/config-plugins` (peer/dev dep)
- Produces: Expo plugin adding Android `RECORD_AUDIO` permission + iOS `NSMicrophoneUsageDescription`; package.json `"main"` stays `dist/index.js`, add `"expo": { "plugins": ["./app.plugin.ts"] }` only if we ship compiled plugin — simplest: ship plugin as plain CommonJS `plugin/index.js` referenced by `"expo": {"plugins": ["./plugin/index.js"]}`.

- [ ] **Step 1: Write plugin** (`withAndroidPermissions` RECORD_AUDIO; iOS plist string as bonus).
- [ ] **Step 2: Document usage** in `README-rn.md`: install, `npx expo prebuild` / dev build required (NOT Expo Go), model download, minimal `createSession` example from the user's API brief.
- [ ] **Step 3: Verify plugin loads**: `node -e "require('./plugin/index.js')"`.
- [ ] **Step 4: Commit** — `feat(expo): config plugin + usage docs`

---

### Task 14: Verification harness — TypeScript side (Node)

**Files:**
- Create: `verification/harness-rn/package.json`, `verification/harness-rn/run.ts` (or `.mjs`), `verification/compare.mjs`, `verification/fixtures/.gitkeep`
- Model prerequisite: `assets/model/zipformer_p_arabic_v3.int8.onnx` downloaded (reuse `bin/download_model.dart` logic — port the download to a small node script `verification/download-model.mjs` using the same URL, since Dart isn't installed yet)

**Interfaces:**
- Consumes: `src/` pipeline (Tasks 3–10), `assets/model/tokens.txt`, ONNX model, sherpa-onnx npm package (dev-only dep of harness)
- Produces: `verification/out/rn-events.json` — array of `{ t: 'highlight', wordId, score, cleanAsr, isRed, isNeutral, tajweedErrors }` plus `verification/out/rn-tokens.json` (raw `tokens[]`+`timestamps[]` per result)

- [ ] **Step 1: Write `download-model.mjs`** (same URL, progress, atomic rename) and run it → ONNX present.
- [ ] **Step 2: Harness**: read a 16 kHz mono WAV fixture (`verification/fixtures/*.wav` — see Task 16), convert to Float32, feed through sherpa-onnx npm `OnlineRecognizer` with the **exact config from Task 11** (zipformer2_ctc, tokens, numThreads 2, endpoint 10/4/9999, priming 7,680 zeros), collect cumulative `(tokens, timestamps)` per decode → run `AsrTokenProcessor` → per-char expansion → `DictationSequencer` via `ReciteQuran.createSession({surah, transport: fileTransport})` → dump events JSON.
- [ ] **Step 3: Run on a fixture → JSON produced**, `npx tsc --noEmit` clean
- [ ] **Step 4: Commit** — `feat(verification): Node harness (sherpa-onnx npm → TS pipeline → events.json)`

---

### Task 15: Verification harness — original Dart side

**Files:**
- Create: `verification/harness-dart/` — a minimal Flutter Windows **integration test** (`test_driver` or plain `flutter test`) inside the original package that: loads assets (rootBundle with the package's own pubspec assets), instantiates `ReciteQuran` with a file-fed transport (`feedAudioChunk` from WAV), captures `onWordMatched` → writes `verification/out/dart-events.json` + `dart-tokens.json`.
- Prerequisite: **install Flutter SDK** (not present). Install to `C:\flutter`, `flutter doctor`, confirm `sherpa_onnx` Windows DLLs load.

**Interfaces:**
- Consumes: original `lib/` engine unchanged, same WAV fixture as Task 14
- Produces: `verification/out/dart-events.json`, `verification/out/dart-tokens.json` (same schema)

- [ ] **Step 1: Install Flutter** (`git clone https://github.com/flutter/flutter.git -b stable C:\flutter`, add to PATH, `flutter --version`).
- [ ] **Step 2: `flutter pub get`** in repo root; confirm no code changes to `lib/`.
- [ ] **Step 3: Write harness test** feeding WAV via `AudioProcessor`-equivalent framing (480 ms / 7,680-sample chunks, `int16/32768`) into `ReciteQuran.feedAudioChunk`, with `QuranMetadataService` loading real assets; log events with identical schema.
- [ ] **Step 4: Run** `flutter test verification/harness-dart` → JSON produced.
- [ ] **Step 5: Commit** — `feat(verification): Dart reference harness (original engine, same fixtures)`

---

### Task 16: Fixture recordings + A/B comparison + fix loop

**Files:**
- Create: `verification/fixtures/*.wav` (16 kHz mono PCM16 recitations — **requires user-provided or device-recorded audio**; ask the user for 1–3 recordings covering Al-Fatihah incl. a deliberate skipped word)
- Modify: `verification/compare.mjs`, then port sources as diffs demand

**Interfaces:**
- Consumes: both `verification/out/*.json`
- Produces: diff report (per-event: wordId, score ±ε, isRed, tajweedErrors; per-token: token string + timestamp ±80 ms frame)

- [ ] **Step 1: Obtain fixtures** (ask user for WAVs; fallback: record on Android device via the module's `processWav`/mic and pull file).
- [ ] **Step 2: Write `compare.mjs`** — aligns token streams (exact string match, timestamps tolerance = 0.08 s), then event lists (exact wordId/isRed/score ε=1e-6/tajweedErrors deep-equal); prints PASS/FAIL summary.
- [ ] **Step 3: Run both harnesses on each fixture, then compare.**
- [ ] **Step 4: Iterate** — any mismatch → investigate original Dart source, fix TS/Kotlin side, re-run. NO new heuristics, NO threshold changes. Record each fix in its own commit (`fix(ts): …` mirroring `file:line` behavior).
- [ ] **Step 5: Final commit** — `test(verification): A/B fixtures pass against original Dart engine`

---

### Task 17 (optional/deferred): Ayah voice search port

**Files:** `src/ayahSearch/fuzzySearch.ts`, `src/ayahSearch/phoneticSearch.ts` (uses `ref_norm_ph.txt` + `ph_index.npy` — parse NPY `<u2` header in TS), `src/ayahSearch/voiceSearch.ts`.
- Spec: `ayah_search/*.dart`. Port only core-tracking verification passes first (per spec: do not optimize/expand before the port works). Bit-parallel Myers 64-bit → implement via two uint32 words to preserve exact semantics; fall back to DP path exactly as Dart dispatches (`n <= 64`).
- Commit: `feat(ts): port ayah voice search (optional feature)`

---

## Self-Review

1. **Spec coverage:** Step 1 report → Task 1 (delete demo) ✓, keep engine ✓; Step 3 port → Tasks 3–10 (TS) + 11 (Kotlin) ✓; Step 4 API → Task 10 (`createSession/start/onWordMatched/onWordSkipped/stop`) ✓; Step 5 Expo → Tasks 11–13 (dev build, config plugin) ✓; Step 6 verification → Tasks 14–16 (phonemes, timestamps, words, skips, sequence, scores, tajweed all in compare schema) ✓; git fork + logical commits → every task commits, `lib/` preserved ✓; rules (no Whisper/model/threshold changes) → Global Constraints ✓.
2. **Placeholders:** none — every step names exact files, source `file:line` specs, commands, or test code. Android compile step is honestly deferred (standalone RN module compilation requires a host app; noted in Task 11 Step 3).
3. **Type consistency:** `TrackerConfig` (T3) reused by T4–T10; `WordMatchResult.matchWord` signature consistent T5→T7; `SequencerEvent` T7→T10; `AsrTransport` T10→T11/T12; bridge event shape T11→T12→T14; output JSON schema T14/T15→T16. ✓
