// tests/rules.test.ts — port verification for lib/tracking/tajweed/tajweed_rules.dart
import { TajweedDurationStatus } from '../src/types';
import {
  TajweedTimingConfig,
  LangName,
  TajweedRule,
  MaddRule,
  NormalMaddRule,
  MonfaselMaddRule,
  MottaselMaddRule,
  MottaselMaddPauseRule,
  AaredMaddRule,
  LazemMaddRule,
  LeenMaddRule,
  MushaddadGhunnahRule,
  ShaddahRule,
} from '../src/tajweed/rules';

const H = 0.20; // TajweedTimingConfig.harakahBaseSeconds
const EPS = 1e-6;

describe('TajweedTimingConfig constants (tajweed_rules.dart:16-40)', () => {
  test('harakah base', () =>
    expect(TajweedTimingConfig.harakahBaseSeconds).toBe(0.20));
  test('shaddahSeconds = 1.5 * base', () =>
    expect(TajweedTimingConfig.shaddahSeconds).toBeCloseTo(0.30, 10));
  test('normalMaddSeconds = 1.2 * base', () =>
    expect(TajweedTimingConfig.normalMaddSeconds).toBeCloseTo(0.24, 10));
  test('ghunnahSeconds = 2.0 * base', () =>
    expect(TajweedTimingConfig.ghunnahSeconds).toBeCloseTo(0.40, 10));
  test('group4MaddSeconds = 4.0 * base', () =>
    expect(TajweedTimingConfig.group4MaddSeconds).toBeCloseTo(0.80, 10));
  test('lazemMaddSeconds = 6.0 * base', () =>
    expect(TajweedTimingConfig.lazemMaddSeconds).toBeCloseTo(1.20, 10));
});

describe('class names (serialized `type` = Dart runtimeType.toString())', () => {
  test('exact Dart class name strings', () => {
    expect(new NormalMaddRule().type).toBe('NormalMaddRule');
    expect(new MonfaselMaddRule().type).toBe('MonfaselMaddRule');
    expect(new MottaselMaddRule().type).toBe('MottaselMaddRule');
    expect(new MottaselMaddPauseRule().type).toBe('MottaselMaddPauseRule');
    expect(new AaredMaddRule().type).toBe('AaredMaddRule');
    expect(new LazemMaddRule().type).toBe('LazemMaddRule');
    expect(new LeenMaddRule().type).toBe('LeenMaddRule');
    expect(new MushaddadGhunnahRule().type).toBe('MushaddadGhunnahRule');
    expect(new ShaddahRule().type).toBe('ShaddahRule');
    expect(new MaddRule({ name: new LangName({ ar: 'x', en: 'y' }), goldenLen: 3 }).type)
      .toBe('MaddRule');
  });
  test('all rules are TajweedRule instances', () => {
    const rules: TajweedRule[] = [
      new NormalMaddRule(), new MonfaselMaddRule(), new MottaselMaddRule(),
      new MottaselMaddPauseRule(), new AaredMaddRule(), new LazemMaddRule(),
      new LeenMaddRule(), new MushaddadGhunnahRule(), new ShaddahRule(),
    ];
    for (const r of rules) expect(r).toBeInstanceOf(TajweedRule);
  });
});

describe('goldenLen & required durations at hBase = 0.20 (brief Step 1)', () => {
  const cases: Array<[TajweedRule, number, number]> = [
    [new NormalMaddRule(), 1.2, 0.24],
    [new MonfaselMaddRule(), 4, 0.80],
    [new MottaselMaddRule(), 4, 0.80],
    [new MottaselMaddPauseRule(), 4, 0.80],
    [new AaredMaddRule(), 4, 0.80],
    [new LazemMaddRule(), 6, 1.20],
    [new LeenMaddRule(), 4, 0.80],
    [new MushaddadGhunnahRule(), 2, 0.40],
    [new ShaddahRule(), 1, 0.30],
  ];
  test.each(cases.map(([r, g, d]) => [r.type, r, g, d] as const))(
    '%s: goldenLen & requiredDuration',
    (_name, rule, goldenLen, required) => {
      expect(rule.goldenLen).toBe(goldenLen);
      expect(rule.getRequiredDuration(H)).toBeCloseTo(required, 10);
    },
  );
  test('default hBase omitted → TajweedTimingConfig.harakahBaseSeconds', () => {
    expect(new NormalMaddRule().getRequiredDuration()).toBeCloseTo(0.24, 10);
    expect(new ShaddahRule().getRequiredDuration()).toBeCloseTo(0.30, 10);
  });
  test('overrides use non-golden multipliers at custom hBase', () => {
    expect(new ShaddahRule().getRequiredDuration(0.25)).toBeCloseTo(1.5 * 0.25, 10);
    expect(new MushaddadGhunnahRule().getRequiredDuration(0.25)).toBeCloseTo(2.0 * 0.25, 10);
    expect(new NormalMaddRule().getRequiredDuration(0.25)).toBeCloseTo(1.2 * 0.25, 10);
  });
});

describe('bilingual names (tajweed_rules.dart LangName call sites)', () => {
  test('Arabic/English display names', () => {
    expect(new NormalMaddRule().name).toEqual(new LangName({ ar: 'المد الطبيعي', en: 'Normal Madd' }));
    expect(new MonfaselMaddRule().name.ar).toBe('المد المنفصل');
    expect(new MottaselMaddRule().name.en).toBe('Mottasel Madd');
    expect(new MottaselMaddPauseRule().name.ar).toBe('المد المتصل وقفا');
    expect(new MottaselMaddPauseRule().name.en).toBe('Mottasel Madd at Pause');
    expect(new AaredMaddRule().name.ar).toBe('المد العارض للسكون');
    expect(new LazemMaddRule().name.ar).toBe('المد اللازم');
    expect(new LeenMaddRule().name.ar).toBe('مد اللين');
    expect(new MushaddadGhunnahRule().name).toEqual(
      new LangName({ ar: 'النون أو الميم المشددة', en: 'Mushaddad Noon/Meem' }));
    expect(new ShaddahRule().name).toEqual(new LangName({ ar: 'الشدة', en: 'Shaddah' }));
  });
  test('MushaddadGhunnahRule.withNames factory (tajweed_rules.dart:208-215)', () => {
    const r = MushaddadGhunnahRule.withNames({ nameAr: 'وَاو', nameEn: 'Waw' });
    expect(r.name.ar).toBe('وَاو');
    expect(r.name.en).toBe('Waw');
    expect(r.type).toBe('MushaddadGhunnahRule');
    expect(r.goldenLen).toBe(2);
  });
});

describe('checkDurationStatus matrix (tajweed_rules.dart:89-113)', () => {
  test('NormalMadd (goldenLen 1.2): defect / valid / surplus', () => {
    const r = new NormalMaddRule();
    const req = r.getRequiredDuration(H); // 0.24
    expect(r.checkDurationStatus(0.20, H)).toBe(TajweedDurationStatus.defect);
    expect(r.checkDurationStatus(req, H)).toBe(TajweedDurationStatus.valid);
    // cap = req + 2.5*hBase (goldenLen <= 2) → 0.24 + 0.50
    expect(r.checkDurationStatus(req + 2.5 * H, H)).toBe(TajweedDurationStatus.valid);
    expect(r.checkDurationStatus(req + 2.5 * H + EPS, H)).toBe(TajweedDurationStatus.surplus);
  });
  test('goldenLen <= 2 uses 2.5×hBase headroom (Ghunnah)', () => {
    const r = new MushaddadGhunnahRule();
    const req = r.getRequiredDuration(H); // 0.40
    expect(r.checkDurationStatus(req + 2.5 * H + EPS, H)).toBe(TajweedDurationStatus.surplus);
    expect(r.checkDurationStatus(req + 3.0 * H, H)).toBe(TajweedDurationStatus.surplus);
    expect(r.checkDurationStatus(req + 2.5 * H, H)).toBe(TajweedDurationStatus.valid);
  });
  test('goldenLen > 2 uses 4.0×hBase headroom (4-harakat madd)', () => {
    const r = new MonfaselMaddRule();
    const req = r.getRequiredDuration(H); // 0.80
    // between the 2.5× and 4.0× caps → only valid because 4.0× applies
    expect(r.checkDurationStatus(req + 3.0 * H, H)).toBe(TajweedDurationStatus.valid);
    expect(r.checkDurationStatus(req + 4.0 * H, H)).toBe(TajweedDurationStatus.valid);
    expect(r.checkDurationStatus(req + 4.0 * H + EPS, H)).toBe(TajweedDurationStatus.surplus);
    expect(r.checkDurationStatus(req - EPS, H)).toBe(TajweedDurationStatus.defect);
  });
  test('LazemMaddRule (goldenLen 6) bounds at hBase 0.20', () => {
    const r = new LazemMaddRule();
    const req = r.getRequiredDuration(H); // 1.20
    expect(r.checkDurationStatus(req - EPS, H)).toBe(TajweedDurationStatus.defect);
    expect(r.checkDurationStatus(req, H)).toBe(TajweedDurationStatus.valid);
    expect(r.checkDurationStatus(req + 4.0 * H + EPS, H)).toBe(TajweedDurationStatus.surplus);
  });
  test('ShaddahRule override: required = 1.5*hBase, cap goldenLen 1 ≤ 2 → 2.5×', () => {
    const r = new ShaddahRule();
    const req = r.getRequiredDuration(H); // 0.30
    expect(r.checkDurationStatus(0.25, H)).toBe(TajweedDurationStatus.defect);
    expect(r.checkDurationStatus(req, H)).toBe(TajweedDurationStatus.valid);
    expect(r.checkDurationStatus(req + 2.5 * H + EPS, H)).toBe(TajweedDurationStatus.surplus);
  });
  test('MushaddadGhunnahRule override: required = 2.0*hBase', () => {
    const r = new MushaddadGhunnahRule();
    expect(r.getRequiredDuration(H)).toBeCloseTo(0.40, 10);
    expect(r.checkDurationStatus(0.39, H)).toBe(TajweedDurationStatus.defect);
    expect(r.checkDurationStatus(0.40, H)).toBe(TajweedDurationStatus.valid);
  });
  test('goldenLen <= 0 → always valid (tajweed_rules.dart:93)', () => {
    const zero = new MaddRule({ name: new LangName({ ar: 'صفر', en: 'zero' }), goldenLen: 0 });
    expect(zero.checkDurationStatus(0, H)).toBe(TajweedDurationStatus.valid);
    expect(zero.checkDurationStatus(99, H)).toBe(TajweedDurationStatus.valid);
    const neg = new MaddRule({ name: new LangName({ ar: 'سالب', en: 'neg' }), goldenLen: -1 });
    expect(neg.checkDurationStatus(0.01, H)).toBe(TajweedDurationStatus.valid);
  });
  test('status enum ordinals match Dart index (types.ts)', () => {
    expect(TajweedDurationStatus.valid).toBe(0);
    expect(TajweedDurationStatus.defect).toBe(1);
    expect(TajweedDurationStatus.surplus).toBe(2);
  });
});

describe('checkDuration boolean semantics (tajweed_rules.dart:81-86)', () => {
  test('true only when status is valid', () => {
    const r = new NormalMaddRule();
    const req = r.getRequiredDuration(H);
    expect(r.checkDuration(0.20, H)).toBe(false);
    expect(r.checkDuration(req, H)).toBe(true);
    expect(r.checkDuration(req + 2.5 * H + EPS, H)).toBe(false);
  });
});

describe('toRuleMap → ReciterErrorRuleMap (error_explainer.dart:109-117)', () => {
  test('4-field mapping with exact type string', () => {
    expect(new LazemMaddRule().toRuleMap()).toEqual({
      type: 'LazemMaddRule',
      nameAr: 'المد اللازم',
      nameEn: 'Lazem Madd',
      goldenLen: 6,
    });
    expect(new ShaddahRule().toRuleMap()).toEqual({
      type: 'ShaddahRule', nameAr: 'الشدة', nameEn: 'Shaddah', goldenLen: 1,
    });
  });
});
