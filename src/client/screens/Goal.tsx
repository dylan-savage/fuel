import { useState } from 'preact/hooks';
import type { WeighIn } from '../../domain/body.js';
import {
  ACTIVITY,
  ActivityLevel,
  BASELINE_MULTIPLIER,
  CM_PER_INCH,
  GoalDraft,
  KG_PER_LB,
  MAX_WATER_ML,
  ProfileDraft,
  ageOn,
  budgetFor,
  goalId,
  type Budget,
  type BudgetPolicy,
  type Goal,
  type MacroTarget,
  type Profile,
  type Sex,
} from '../../domain/goals.js';
import { DEFAULT_WATER_ML, ML_PER_FL_OZ } from '../../domain/habits.js';
import type { LocalDate } from '../../domain/ids.js';
import { KCAL_PER_GRAM, MACROS, type Macro } from '../../domain/nutrients.js';
import { BUILD } from '../build.js';
import { goalView, useIntents, useLive } from '../views.js';
import { MACRO_LABEL, amount, editable, flOz, kcal, lb as pounds, lbField, macrosLine, parseNumber } from './format.js';
import { ExpandRow, Icon, NumberField, Row, Segmented, Sheet, TitleBar, useToast } from './ui.js';
import { WeightSheet } from './Weight.js';

const RATES_LB = [-2, -1.5, -1, -0.5, 0, 0.5, 1] as const;

function rateLabel(lb: number): string {
  if (lb === 0) return 'Maintain weight';
  return `${lb < 0 ? 'Lose' : 'Gain'} ${amount(Math.abs(lb))} lb a week`;
}

function rateValue(lb: number): string {
  if (lb === 0) return 'Maintain';
  return `${lb < 0 ? 'Lose' : 'Gain'} ${amount(Math.abs(lb))} lb`;
}

function rateDetail(rateKcal: number, lb: number): string {
  if (lb === 0) return '';
  return `, ${rateKcal < 0 ? '−' : '+'}${kcal(Math.abs(rateKcal))} to ${lb < 0 ? 'lose' : 'gain'} ${amount(Math.abs(lb))} lb a week`;
}

function heightParts(cm: number): { readonly ft: number; readonly inch: number } {
  const total = Math.round(cm / CM_PER_INCH);
  return { ft: Math.floor(total / 12), inch: total % 12 };
}

function ProfileSheet({ profile, today, onClose }: { readonly profile: Profile | undefined; readonly today: LocalDate; readonly onClose: () => void }) {
  const intents = useIntents();
  const height = profile === undefined ? undefined : heightParts(profile.heightCm);
  const [sex, setSex] = useState<Sex>(profile?.sex ?? 'male');
  const [birthDate, setBirthDate] = useState<string>(profile?.birthDate ?? '');
  const [ft, setFt] = useState(height === undefined ? '' : String(height.ft));
  const [inch, setInch] = useState(height === undefined ? '' : String(height.inch));
  const [lb, setLb] = useState(profile === undefined ? '' : lbField(profile.weightKg));

  const feet = parseNumber(ft);
  const inches = parseNumber(inch) ?? 0;
  const pounds = parseNumber(lb);
  const draft = ProfileDraft.safeParse({
    sex,
    birthDate,
    heightCm: feet === null ? null : (feet * 12 + inches) * CM_PER_INCH,
    weightKg: pounds === null ? null : pounds * KG_PER_LB,
  });
  const futureBirth = draft.success && draft.data.birthDate > today;

  return (
    <Sheet title="Your details" onClose={onClose}>
      <Segmented
        label="Sex"
        options={[
          { value: 'male', label: 'Male' },
          { value: 'female', label: 'Female' },
        ]}
        value={sex}
        onChange={setSex}
      />
      <div class="group">
        <label class="field">
          <span class="field-label">Birth date</span>
          <input type="date" value={birthDate} max={today} onInput={(event) => setBirthDate(event.currentTarget.value)} />
        </label>
        <div class="field">
          <span class="field-label">Height</span>
          <input aria-label="Height feet" inputMode="numeric" value={ft} placeholder="5" onInput={(event) => setFt(event.currentTarget.value)} />
          <span class="field-unit">ft</span>
          <input aria-label="Height inches" inputMode="numeric" value={inch} placeholder="10" onInput={(event) => setInch(event.currentTarget.value)} />
          <span class="field-unit">in</span>
        </div>
        <NumberField label="Weight" unit="lb" value={lb} onInput={setLb} placeholder="180" />
      </div>
      <p class="hint">Weigh-ins replace this weight.</p>
      <div class="sheet-actions">
        <button
          type="button"
          class="primary"
          disabled={!draft.success || futureBirth}
          onClick={() => {
            if (!draft.success) return;
            void intents.saveProfile(draft.data).then(onClose);
          }}
        >
          Save details
        </button>
      </div>
    </Sheet>
  );
}

function profileSummary(profile: Profile, today: LocalDate): string {
  const { ft, inch } = heightParts(profile.heightCm);
  return `${profile.sex === 'male' ? 'Male' : 'Female'} · ${ageOn(profile.birthDate, today)} · ${ft}′${inch}″ · ${amount(profile.weightKg / KG_PER_LB)} lb`;
}

const macroTexts = (m: MacroTarget): Readonly<Record<Macro, string>> => ({ protein: editable(m.protein), carbs: editable(m.carbs), fat: editable(m.fat) });

/** What the workouts toggle does, in the one line it has. */
function policyLine(kind: BudgetPolicy['kind'], percent: number | null): string {
  switch (kind) {
    case 'activity-level':
      return 'Your activity level already counts them';
    case 'eat-back-workouts':
      return `Each adds ${percent === null ? 'a share' : `${amount(percent)}%`} of its calories to that day`;
  }
}

/** One plain sentence on what the budget choice does with logged workouts. */
function policySentence(kind: BudgetPolicy['kind'], percent: number | null): string {
  switch (kind) {
    case 'activity-level':
      return 'Your activity level already counts your exercise, so workouts you log are recorded but never change your target.';
    case 'eat-back-workouts':
      return `Your target starts from a desk-job day (BMR × ${BASELINE_MULTIPLIER}), and each workout you log adds ${percent === null ? 'a share' : `${amount(percent)}%`} of its calories to that day.`;
  }
}

function targetDetail(budget: Budget, kind: BudgetPolicy['kind'], rateLb: number): string {
  const workouts = kind === 'eat-back-workouts' ? ', plus workouts each day' : '';
  if (budget.basis.kind === 'manual') return `Custom target${workouts}`;
  const { bmr, multiplier, tdee, rate } = budget.basis;
  return `BMR ${kcal(bmr)} × ${multiplier} = ${kind === 'activity-level' ? 'TDEE ' : ''}${kcal(tdee)}${rateDetail(rate, rateLb)}${workouts}`;
}

function weightBasis(budget: Budget): string | null {
  if (budget.basis.kind !== 'computed') return null;
  const { weight } = budget.basis;
  return weight.source === 'trend'
    ? `BMR is your resting burn (Mifflin-St Jeor), from your ${pounds(weight.kg)} lb trend weight.`
    : `BMR is your resting burn (Mifflin-St Jeor), from your profile weight, ${pounds(weight.kg)} lb, until your first weigh-in.`;
}

/** The form as typed. Numbers stay text until read, so a half-typed one is kept as it is. */
interface Fields {
  readonly policyKind: BudgetPolicy['kind'];
  readonly level: ActivityLevel;
  readonly percentText: string;
  readonly goalWeightText: string;
  readonly rateLb: number;
  readonly custom: boolean;
  readonly customText: string;
  readonly macroKind: MacroTarget['kind'];
  readonly macros: Readonly<Record<Macro, string>>;
  readonly waterText: string;
}

function fieldsOf(goal: Goal | undefined): Fields {
  return {
    policyKind: goal?.policy.kind ?? 'activity-level',
    level: goal?.policy.kind === 'activity-level' ? goal.policy.level : 'moderate',
    percentText: goal?.policy.kind === 'eat-back-workouts' ? editable(goal.policy.fraction * 100) : '100',
    goalWeightText: goal?.goalWeightKg === undefined ? '' : lbField(goal.goalWeightKg),
    rateLb: goal === undefined ? -1 : Math.round((goal.kgPerWeek / KG_PER_LB) * 4) / 4,
    custom: goal?.kcalOverride !== undefined,
    customText: goal?.kcalOverride === undefined ? '' : String(goal.kcalOverride),
    macroKind: goal?.macros.kind ?? 'percent',
    macros: goal === undefined ? { protein: '30', carbs: '40', fat: '30' } : macroTexts(goal.macros),
    waterText: String(Math.round(((goal?.waterMl ?? DEFAULT_WATER_ML) / ML_PER_FL_OZ) * 100) / 100),
  };
}

/** What the fields say, and which of them cannot be saved as typed. */
function readFields(fields: Fields) {
  const { customText, custom, level, macroKind, policyKind, rateLb } = fields;
  const override = parseNumber(customText);
  const waterOz = parseNumber(fields.waterText);
  const waterMl = waterOz === null ? null : waterOz * ML_PER_FL_OZ;
  const macroValues = { protein: parseNumber(fields.macros.protein), carbs: parseNumber(fields.macros.carbs), fat: parseNumber(fields.macros.fat) };
  const macros = { kind: macroKind, ...macroValues };
  const percent = parseNumber(fields.percentText);
  const goalWeightLb = parseNumber(fields.goalWeightText);
  const goalWeightKg = goalWeightLb === null ? null : goalWeightLb * KG_PER_LB;
  const blankGoalWeight = fields.goalWeightText.trim() === '';
  return {
    override,
    macroValues,
    percent,
    percentValid: percent !== null && percent >= 0 && percent <= 100,
    goalWeightValid: blankGoalWeight || GoalDraft.shape.goalWeightKg.safeParse(goalWeightKg).success,
    customValid: !custom || GoalDraft.shape.kcalOverride.safeParse(override).success,
    macrosValid: GoalDraft.shape.macros.safeParse(macros).success,
    waterValid: GoalDraft.shape.waterMl.safeParse(waterMl).success,
    percentTotal: MACROS.reduce((sum, m) => sum + (macroValues[m] ?? 0), 0),
    draft: GoalDraft.safeParse({
      policy: policyKind === 'activity-level' ? { kind: 'activity-level', level } : { kind: 'eat-back-workouts', fraction: percent === null ? null : percent / 100 },
      kgPerWeek: rateLb * KG_PER_LB,
      ...(blankGoalWeight ? {} : { goalWeightKg }),
      ...(custom ? { kcalOverride: override } : {}),
      macros,
      waterMl,
    }),
  };
}

/** A goal as it would be saved, so "170" and "170.0" read as the same goal. Null when it cannot be saved. */
function savedForm(fields: Fields): string | null {
  const { draft } = readFields(fields);
  return draft.success ? JSON.stringify(draft.data) : null;
}

const FIX = <span class="mark-bad">Fix</span>;

function GoalForm({
  goal,
  profile,
  weighIns,
  trendKg,
  today,
}: {
  readonly goal: Goal | undefined;
  readonly profile: Profile | undefined;
  readonly weighIns: readonly WeighIn[];
  readonly trendKg: number | undefined;
  readonly today: LocalDate;
}) {
  const intents = useIntents();
  const toast = useToast();
  const [editingProfile, setEditingProfile] = useState(false);
  const [showingWeight, setShowingWeight] = useState(false);
  const [fields, setFields] = useState(() => fieldsOf(goal));
  const set = (next: Partial<Fields>) => setFields({ ...fields, ...next });

  const { policyKind, level, percentText, goalWeightText, rateLb, custom, customText, macroKind, macros, waterText } = fields;
  const { override, macroValues, percent, percentValid, goalWeightValid, customValid, macrosValid, waterValid, percentTotal, draft } = readFields(fields);
  const budget = draft.success ? budgetFor({ ...draft.data, id: goalId(today), effectiveFrom: today }, { profile, weighIns, workouts: [] }, today) : null;
  const eatBack = policyKind === 'eat-back-workouts';
  const changed = goal === undefined || savedForm(fields) === null || savedForm(fields) !== savedForm(fieldsOf(goal));

  const switchMacroKind = (kind: MacroTarget['kind']) => {
    if (kind === macroKind) return;
    if (budget === null) {
      set({ macroKind: kind });
      return;
    }
    const convert = (m: Macro) => {
      const value = macroValues[m] ?? 0;
      return kind === 'grams'
        ? amount(Math.round((budget.kcal * value) / 100 / KCAL_PER_GRAM[m]))
        : amount(Math.round(((value * KCAL_PER_GRAM[m]) / budget.kcal) * 100));
    };
    set({ macroKind: kind, macros: { protein: convert('protein'), carbs: convert('carbs'), fat: convert('fat') } });
  };

  return (
    <>
      <div class="card">
        <p class="hero-line">
          <strong data-testid="goal-kcal">{budget === null ? '–' : kcal(budget.kcal)}</strong> kcal a day
        </p>
        <p class="detail">{!draft.success ? 'Fix what is marked in red' : budget === null ? 'Add your details, or set a custom target' : macrosLine(budget.macros)}</p>
      </div>

      <ul class="list" aria-label="Goal settings">
        <li>
          <Row name="Your details" {...(profile === undefined ? { end: '–' } : { detail: profileSummary(profile, today) })} chevron onClick={() => setEditingProfile(true)} />
        </li>
        <li>
          <Row name="Weight" end={trendKg === undefined ? '–' : `${pounds(trendKg)} lb`} chevron onClick={() => setShowingWeight(true)} />
        </li>
        <li>
          {eatBack ? (
            <Row name="Activity" end="Desk job, plus workouts" />
          ) : (
            <ExpandRow name="Activity" end={ACTIVITY[level].label}>
              <div class="group" role="radiogroup" aria-label="Activity level">
                {ActivityLevel.options.map((option) => (
                  <button type="button" role="radio" aria-checked={option === level} class="choice" key={option} onClick={() => set({ level: option })}>
                    <span>{ACTIVITY[option].label}</span>
                    <span class="choice-detail">{ACTIVITY[option].detail}</span>
                    {option === level && <Icon name="check" />}
                  </button>
                ))}
              </div>
            </ExpandRow>
          )}
        </li>
        <li>
          <ExpandRow name="Weekly goal" end={!customValid || !goalWeightValid ? FIX : custom ? 'Custom' : rateValue(rateLb)}>
            <div class="group">
              <label class="field">
                <span class="field-label">Rate</span>
                <select aria-label="Weekly goal" value={String(rateLb)} onChange={(event) => set({ rateLb: Number(event.currentTarget.value) })}>
                  {RATES_LB.map((lb) => (
                    <option key={lb} value={String(lb)}>
                      {rateLabel(lb)}
                    </option>
                  ))}
                </select>
              </label>
              <label class="field toggle">
                <span class="field-label">Custom calorie target</span>
                <input type="checkbox" role="switch" checked={custom} onChange={(event) => set({ custom: event.currentTarget.checked })} />
              </label>
              {custom && <NumberField label="Target" unit="kcal" value={customText} onInput={(value) => set({ customText: value })} placeholder="2000" invalid={override === null || override <= 0} />}
              <NumberField label="Goal weight" unit="lb" value={goalWeightText} onInput={(value) => set({ goalWeightText: value })} placeholder="Optional" invalid={!goalWeightValid} />
            </div>
          </ExpandRow>
        </li>
        <li>
          <ExpandRow name="Macros" end={macrosValid ? `${MACROS.map((m) => macros[m]).join(' / ')}${macroKind === 'percent' ? '%' : ' g'}` : FIX}>
            <Segmented
              label="Macro targets in"
              options={[
                { value: 'percent', label: 'Percent' },
                { value: 'grams', label: 'Grams' },
              ]}
              value={macroKind}
              onChange={switchMacroKind}
            />
            <div class="group">
              {MACROS.map((m) => (
                <NumberField
                  key={m}
                  label={MACRO_LABEL[m]}
                  unit={macroKind === 'percent' ? '%' : 'g'}
                  value={macros[m]}
                  invalid={macroValues[m] === null}
                  onInput={(value) => set({ macros: { ...macros, [m]: value } })}
                />
              ))}
            </div>
            {macroKind === 'percent' && Math.abs(percentTotal - 100) >= 0.5 && <p class="hint warn">Adds up to {amount(percentTotal)}%, not 100%</p>}
          </ExpandRow>
        </li>
        <li>
          <ExpandRow name="Water" end={waterValid ? `${waterText} fl oz` : FIX}>
            <div class="group">
              <NumberField label="Daily goal" unit="fl oz" value={waterText} onInput={(value) => set({ waterText: value })} invalid={!waterValid} />
            </div>
            {!waterValid && <p class="hint warn">More than 0, up to {flOz(MAX_WATER_ML)} fl oz</p>}
          </ExpandRow>
        </li>
      </ul>

      <div class="group">
        <label class="field toggle">
          <span class="field-text">
            Count workouts
            <span class="detail" data-testid="policy-sentence">
              {policyLine(policyKind, percentValid ? percent : null)}
            </span>
          </span>
          <input type="checkbox" role="switch" checked={eatBack} onChange={(event) => set({ policyKind: event.currentTarget.checked ? 'eat-back-workouts' : 'activity-level' })} />
        </label>
        {eatBack && <NumberField label="Workouts counted" unit="%" value={percentText} onInput={(value) => set({ percentText: value })} invalid={!percentValid} />}
      </div>
      {eatBack && !percentValid && <p class="hint warn">From 0% to 100%</p>}

      {budget !== null && (
        <ul class="list">
          <li>
            <ExpandRow name="How this is worked out">
              <p>{targetDetail(budget, policyKind, rateLb)}</p>
              {weightBasis(budget) !== null && <p>{weightBasis(budget)}</p>}
              <p>{policySentence(policyKind, percentValid ? percent : null)}</p>
            </ExpandRow>
          </li>
        </ul>
      )}

      {changed && (
        <div class="screen-actions">
          <button
            type="button"
            class="primary"
            disabled={!draft.success}
            onClick={() => {
              if (!draft.success) return;
              void intents.saveGoal(draft.data, today).then(() => toast({ text: 'Goal saved. Past days keep their targets.' }));
            }}
          >
            Save goal
          </button>
        </div>
      )}
      {editingProfile && <ProfileSheet profile={profile} today={today} onClose={() => setEditingProfile(false)} />}
      {showingWeight && <WeightSheet date={today} today={today} onClose={() => setShowingWeight(false)} onGoal={() => setShowingWeight(false)} />}
    </>
  );
}

export function GoalScreen({ today }: { readonly today: LocalDate }) {
  const view = useLive((r) => goalView(r, today), [today]);
  return (
    <section class="screen goal">
      <TitleBar title="Goal" />
      {view !== undefined && <GoalForm key={view.goal?.id ?? 'none'} goal={view.goal} profile={view.profile} weighIns={view.weighIns} trendKg={view.trendKg} today={today} />}
      <p class="build-id" data-testid="build">
        Build {BUILD}
      </p>
    </section>
  );
}
