import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TIMESTAMP_TOLERANCE_S = 0.08; // 80 ms (1 encoder frame)
const SCORE_EPSILON = 1e-4;

function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;

  for (const k of keysA) {
    if (!keysB.includes(k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

export function compareEvents(rnEvents, dartEvents) {
  const diffs = [];
  if (rnEvents.length !== dartEvents.length) {
    diffs.push(`Event count mismatch: RN produced ${rnEvents.length} events, Dart produced ${dartEvents.length} events.`);
  }

  const minLen = Math.min(rnEvents.length, dartEvents.length);
  for (let i = 0; i < minLen; i++) {
    const rn = rnEvents[i];
    const dart = dartEvents[i];

    if (rn.wordId !== dart.wordId) {
      diffs.push(`Event #${i} wordId mismatch: RN=${rn.wordId}, Dart=${dart.wordId}`);
    }
    if (Boolean(rn.isRed) !== Boolean(dart.isRed)) {
      diffs.push(`Event #${i} isRed mismatch: RN=${rn.isRed}, Dart=${dart.isRed}`);
    }
    if (Boolean(rn.isNeutral) !== Boolean(dart.isNeutral)) {
      diffs.push(`Event #${i} isNeutral mismatch: RN=${rn.isNeutral}, Dart=${dart.isNeutral}`);
    }
    if (rn.cleanAsr !== dart.cleanAsr) {
      diffs.push(`Event #${i} cleanAsr mismatch: RN="${rn.cleanAsr}", Dart="${dart.cleanAsr}"`);
    }
    if (Math.abs((rn.score ?? 0) - (dart.score ?? 0)) > SCORE_EPSILON) {
      diffs.push(`Event #${i} score mismatch: RN=${rn.score}, Dart=${dart.score}`);
    }
    if (!deepEqual(rn.tajweedErrors, dart.tajweedErrors)) {
      diffs.push(
        `Event #${i} tajweedErrors mismatch:\n  RN:   ${JSON.stringify(rn.tajweedErrors)}\n  Dart: ${JSON.stringify(dart.tajweedErrors)}`
      );
    }
  }

  return diffs;
}

export function compareTokens(rnTokens, dartTokens) {
  const diffs = [];
  if (rnTokens.length !== dartTokens.length) {
    diffs.push(`Token stream length mismatch: RN=${rnTokens.length}, Dart=${dartTokens.length}`);
  }

  const minLen = Math.min(rnTokens.length, dartTokens.length);
  for (let i = 0; i < minLen; i++) {
    const rn = rnTokens[i];
    const dart = dartTokens[i];

    if (rn.tokens.length !== dart.tokens.length) {
      diffs.push(`Result #${i} token array length mismatch: RN=${rn.tokens.length}, Dart=${dart.tokens.length}`);
      continue;
    }

    for (let j = 0; j < rn.tokens.length; j++) {
      if (rn.tokens[j] !== dart.tokens[j]) {
        diffs.push(`Result #${i} token [${j}] mismatch: RN="${rn.tokens[j]}", Dart="${dart.tokens[j]}"`);
      }
      const tsDiff = Math.abs((rn.timestamps[j] ?? 0) - (dart.timestamps[j] ?? 0));
      if (tsDiff > TIMESTAMP_TOLERANCE_S) {
        diffs.push(
          `Result #${i} timestamp [${j}] diff ${tsDiff.toFixed(3)}s > tolerance (${TIMESTAMP_TOLERANCE_S}s): RN=${rn.timestamps[j]}, Dart=${dart.timestamps[j]}`
        );
      }
    }
  }

  return diffs;
}

function main() {
  const outDir = path.resolve(__dirname, 'out');
  const rnEventsPath = path.join(outDir, 'rn-events.json');
  const dartEventsPath = path.join(outDir, 'dart-events.json');
  const rnTokensPath = path.join(outDir, 'rn-tokens.json');
  const dartTokensPath = path.join(outDir, 'dart-tokens.json');

  if (!fs.existsSync(rnEventsPath) || !fs.existsSync(dartEventsPath)) {
    console.error('Missing rn-events.json or dart-events.json in verification/out/');
    process.exit(1);
  }

  const rnEvents = JSON.parse(fs.readFileSync(rnEventsPath, 'utf8'));
  const dartEvents = JSON.parse(fs.readFileSync(dartEventsPath, 'utf8'));

  console.log('=== Comparing Events ===');
  const eventDiffs = compareEvents(rnEvents, dartEvents);
  if (eventDiffs.length === 0) {
    console.log('✅ Events comparison PASSED (exact match on words, skips, tajweed & scores)');
  } else {
    console.error(`❌ Events comparison FAILED with ${eventDiffs.length} differences:`);
    for (const d of eventDiffs) {
      console.error(`  - ${d}`);
    }
  }

  if (fs.existsSync(rnTokensPath) && fs.existsSync(dartTokensPath)) {
    console.log('\n=== Comparing Tokens & Timestamps ===');
    const rnTokens = JSON.parse(fs.readFileSync(rnTokensPath, 'utf8'));
    const dartTokens = JSON.parse(fs.readFileSync(dartTokensPath, 'utf8'));
    const tokenDiffs = compareTokens(rnTokens, dartTokens);
    if (tokenDiffs.length === 0) {
      console.log('✅ Tokens & timestamps comparison PASSED');
    } else {
      console.error(`❌ Tokens comparison FAILED with ${tokenDiffs.length} differences:`);
      for (const d of tokenDiffs) {
        console.error(`  - ${d}`);
      }
    }
  }

  if (eventDiffs.length > 0) {
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
