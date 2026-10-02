// src/tajweed/rules.ts
// Direct transliteration of lib/tracking/tajweed/tajweed_rules.dart (236 lines, zero Dart imports).
// Pure duration-based, fully deterministic Tajweed rules:
//   1. Madd (`المدود`) — 7 types (1.2 / 4 / 6 beats).
//   2. Ghunnah on Mushaddad Noon & Meem (`النون والميم المشددتان`) — 2 beats.
//   3. Shaddah (`الشدة`) — ~1.5 beats hold.
// Dart lib/ is read-only source of truth; class names are frozen because
// ReciterError serialization uses `runtimeType.toString()` (error_explainer.dart:109).

import { ReciterErrorRuleMap, TajweedDurationStatus } from '../types';

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1: TAJWEED TIMING CONFIGURATION (tajweed_rules.dart:16-40)
// ═══════════════════════════════════════════════════════════════════════════════

export class TajweedTimingConfig {
  /** Base duration of a single Harakah (vowel beat unit) in seconds. Standard Tadweer calibration 0.20s. */
  static readonly harakahBaseSeconds = 0.20;

  /** ── 1. Shaddah (الشدة): 1.5 Harakat. */
  static readonly shaddahSeconds = 1.5 * TajweedTimingConfig.harakahBaseSeconds;

  /** ── 2. Normal Madd (المد الطبيعي): 1.2 Harakat = 0.24s. */
  static readonly normalMaddSeconds = 1.2 * TajweedTimingConfig.harakahBaseSeconds;

  /** ── 3. Ghunnah on Mushaddad Noon/Meem (غنة النون والميم المشددتين): 2.0 Harakat. */
  static readonly ghunnahSeconds = 2.0 * TajweedTimingConfig.harakahBaseSeconds;

  /** ── 4. The 4-Harakat Madd group (Monfasel, Mottasel, Aared, Leen). */
  static readonly group4MaddSeconds = 4.0 * TajweedTimingConfig.harakahBaseSeconds;

  /** ── 5. Lazem Madd (المد اللازم): 6.0 Harakat. */
  static readonly lazemMaddSeconds = 6.0 * TajweedTimingConfig.harakahBaseSeconds;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2: BASE CLASSES & METADATA (tajweed_rules.dart:46-114)
// ═══════════════════════════════════════════════════════════════════════════════

/** Bilingual display name (Arabic and English) for user-facing errors. */
export class LangName {
  readonly ar: string;
  readonly en: string;
  constructor({ ar, en }: { ar: string; en: string }) {
    this.ar = ar;
    this.en = en;
  }
}

/**
 * Abstract base class representing a single duration check in Quranic recitation.
 * `TajweedDurationStatus` is imported from src/types.ts (ordinals valid=0, defect=1, surplus=2).
 */
export abstract class TajweedRule {
  /** Exact Dart class name (`runtimeType.toString()`) used by ReciterError serialization. */
  abstract readonly type: string;
  readonly name: LangName;
  /** Expected Harakat count (e.g. 1.2 for Normal Madd). Dart `num`. */
  readonly goldenLen: number;

  constructor({ name, goldenLen }: { name: LangName; goldenLen: number }) {
    this.name = name;
    this.goldenLen = goldenLen;
  }

  /** Exact required acoustic duration in seconds. */
  getRequiredDuration(harakahBase: number = TajweedTimingConfig.harakahBaseSeconds): number {
    return this.goldenLen * harakahBase;
  }

  /** True iff the actual duration meets the required threshold within tolerance. */
  checkDuration(
    durationSeconds: number,
    harakahBase: number = TajweedTimingConfig.harakahBaseSeconds,
  ): boolean {
    return this.checkDurationStatus(durationSeconds, harakahBase) === TajweedDurationStatus.valid;
  }

  /** valid / defect (too short) / surplus (far too long). tajweed_rules.dart:89-113. */
  checkDurationStatus(
    durationSeconds: number,
    harakahBase: number = TajweedTimingConfig.harakahBaseSeconds,
  ): TajweedDurationStatus {
    if (this.goldenLen <= 0) return TajweedDurationStatus.valid;
    const req = this.getRequiredDuration(harakahBase);

    // 1. Defect (Lower Bound): must hold at least the required duration threshold.
    if (durationSeconds < req) {
      return TajweedDurationStatus.defect;
    }

    // 2. Surplus (Upper Bound Tolerance):
    // - short rules (<= 2 Harakat like Shaddah/Ghunnah): +2.5 Harakat headroom.
    // - long rules (4-6 Harakat like Lazem Madd): +4.0 Harakat headroom.
    const maxAllowedSeconds = this.goldenLen <= 2
      ? req + 2.5 * harakahBase
      : req + 4.0 * harakahBase;

    if (durationSeconds > maxAllowedSeconds) {
      return TajweedDurationStatus.surplus;
    }

    return TajweedDurationStatus.valid;
  }

  /** ReciterError._ruleToMap (error_explainer.dart:109-117). */
  toRuleMap(): ReciterErrorRuleMap {
    return {
      type: this.type,
      nameAr: this.name.ar,
      nameEn: this.name.en,
      goldenLen: this.goldenLen,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3: MADD RULES (المدود) (tajweed_rules.dart:120-191)
// ═══════════════════════════════════════════════════════════════════════════════

/** Intermediate Madd base; also constructed directly for deserialization fallbacks (error_explainer.dart:138,671). */
export class MaddRule extends TajweedRule {
  readonly type: string = 'MaddRule';
}

/** ── 3.1 Normal Madd (`المد الطبيعي`) — 1.2 Harakat (0.24s) ── */
export class NormalMaddRule extends MaddRule {
  readonly type = 'NormalMaddRule';
  constructor() {
    super({ name: new LangName({ ar: 'المد الطبيعي', en: 'Normal Madd' }), goldenLen: 1.2 });
  }
}

/** ── 3.2 Monfasel Madd (`المد المنفصل`) — 4 Harakat ── */
export class MonfaselMaddRule extends MaddRule {
  readonly type = 'MonfaselMaddRule';
  constructor() {
    super({ name: new LangName({ ar: 'المد المنفصل', en: 'Monfasel Madd' }), goldenLen: 4 });
  }
}

/** ── 3.3 Mottasel Madd (`المد المتصل`) — 4 Harakat ── */
export class MottaselMaddRule extends MaddRule {
  readonly type = 'MottaselMaddRule';
  constructor() {
    super({ name: new LangName({ ar: 'المد المتصل', en: 'Mottasel Madd' }), goldenLen: 4 });
  }
}

/** ── 3.4 Mottasel Madd at Pause (`المد المتصل وقفا`) — 4 Harakat ── */
export class MottaselMaddPauseRule extends MaddRule {
  readonly type = 'MottaselMaddPauseRule';
  constructor() {
    super({
      name: new LangName({ ar: 'المد المتصل وقفا', en: 'Mottasel Madd at Pause' }),
      goldenLen: 4,
    });
  }
}

/** ── 3.5 Aared Madd (`المد العارض للسكون`) — 4 Harakat ── */
export class AaredMaddRule extends MaddRule {
  readonly type = 'AaredMaddRule';
  constructor() {
    super({ name: new LangName({ ar: 'المد العارض للسكون', en: 'Aared Madd' }), goldenLen: 4 });
  }
}

/** ── 3.6 Lazem Madd (`المد اللازم`) — 6 Harakat ── */
export class LazemMaddRule extends MaddRule {
  readonly type = 'LazemMaddRule';
  constructor() {
    super({ name: new LangName({ ar: 'المد اللازم', en: 'Lazem Madd' }), goldenLen: 6 });
  }
}

/** ── 3.7 Leen Madd (`مد اللين`) — 4 Harakat ── */
export class LeenMaddRule extends MaddRule {
  readonly type = 'LeenMaddRule';
  constructor() {
    super({ name: new LangName({ ar: 'مد اللين', en: 'Leen Madd' }), goldenLen: 4 });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4: GHUNNAH RULE (غنة النون والميم المشددتين) (tajweed_rules.dart:197-220)
// ═══════════════════════════════════════════════════════════════════════════════

export class MushaddadGhunnahRule extends TajweedRule {
  readonly type = 'MushaddadGhunnahRule';

  constructor(
    name: LangName = new LangName({ ar: 'النون أو الميم المشددة', en: 'Mushaddad Noon/Meem' }),
  ) {
    super({ name, goldenLen: 2 });
  }

  /** Dart factory MushaddadGhunnahRule.withNames (tajweed_rules.dart:208-215). */
  static withNames({ nameAr, nameEn }: { nameAr: string; nameEn: string }): MushaddadGhunnahRule {
    return new MushaddadGhunnahRule(new LangName({ ar: nameAr, en: nameEn }));
  }

  /** Override: exactly 2.0 Harakat regardless of goldenLen scaling (tajweed_rules.dart:218-219). */
  override getRequiredDuration(harakahBase: number = TajweedTimingConfig.harakahBaseSeconds): number {
    return 2.0 * harakahBase;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5: SHADDAH RULE (الشدة) (tajweed_rules.dart:226-236)
// ═══════════════════════════════════════════════════════════════════════════════

export class ShaddahRule extends TajweedRule {
  readonly type = 'ShaddahRule';

  constructor() {
    super({ name: new LangName({ ar: 'الشدة', en: 'Shaddah' }), goldenLen: 1 });
  }

  /** Override: 1.5 Harakat hold, not goldenLen * base (tajweed_rules.dart:234-235). */
  override getRequiredDuration(harakahBase: number = TajweedTimingConfig.harakahBaseSeconds): number {
    return 1.5 * harakahBase;
  }
}
