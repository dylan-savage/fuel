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
import { goalView, useIntents, useLive } from '../views.js';
import { amount, flOz, kcal, lb as pounds, parseNumber } from './format.js';
import { Icon, NumberField, Segmented, Sheet, TitleBar, useToast } from './ui.js';
import { WeightSheet } from './Weight.js';

const MACRO_LABEL: Readonly<Record<Macro, string>> = { protein: 'Protein', carbs: 'Carbs', fat: 'Fat' };
const RATES_LB = [-2, -1.5, -1, -0.5, 0, 0.5, 1] as const;

function rateLabel(lb: number): string {
  if (lb === 0) return 'Maintain weight';
  return `${lb < 0 ? 'Lose' : 'Gain'} ${amount(Math.abs(lb))} lb per week`;
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
  const [lb, setLb] = useState(profile === undefined ? '' : amount(profile.weightKg / KG_PER_LB));

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
      <h4 class="group-title">Sex</h4>
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
      <p class="hint">Used for your resting burn (Mifflin-St Jeor). This weight counts until your first weigh-in; after that your trend weight takes over.</p>
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

const macroTexts = (m: MacroTarget): Readonly<Record<Macro, string>> => ({ protein: amount(m.protein), carbs: amount(m.carbs), fat: amount(m.fat) });

const POLICY_LABEL: Readonly<Record<BudgetPolicy['kind'], string>> = { 'activity-level': 'Activity level', 'eat-back-workouts': 'Eat back workouts' };

/** One plain sentence on what the budget choice does with logged workouts. */
function policySentence(kind: BudgetPolicy['kind'], percent: number | null): string {
  switch (kind) {
    case 'activity-level':
      return 'Your activity level already counts your exercise, so workouts you log are recorded but never change your target.';
    case 'eat-back-workouts':
      return `Your target starts from a desk-job day (BMR × ${BASELINE_MULTIPLIER}), and each workout you log adds ${percent === null ? 'a share' : `${amount(percent)}%`} of its calories to that day.`;
  }
}

function targetDetail(budget: Budget | null, kind: BudgetPolicy['kind'], rateLb: number): string {
  if (budget === null) return 'Add your details to calculate a target, or set a custom one.';
  const workouts = kind === 'eat-back-workouts' ? ', plus workouts each day' : '';
  if (budget.basis.kind === 'manual') return `Custom target${workouts}`;
  const { bmr, multiplier, tdee, rate } = budget.basis;
  return `BMR ${kcal(bmr)} × ${multiplier} = ${kind === 'activity-level' ? 'TDEE ' : ''}${kcal(tdee)}${rateDetail(rate, rateLb)}${workouts}`;
}

function weightBasis(budget: Budget | null): string | null {
  if (budget?.basis.kind !== 'computed') return null;
  const { weight } = budget.basis;
  return weight.source === 'trend' ? `BMR uses your ${pounds(weight.kg)} lb trend weight.` : `BMR uses your profile weight, ${pounds(weight.kg)} lb, until your first weigh-in.`;
}

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
  const [policyKind, setPolicyKind] = useState<BudgetPolicy['kind']>(goal?.policy.kind ?? 'activity-level');
  const [level, setLevel] = useState<ActivityLevel>(goal?.policy.kind === 'activity-level' ? goal.policy.level : 'moderate');
  const [percentText, setPercentText] = useState(goal?.policy.kind === 'eat-back-workouts' ? amount(goal.policy.fraction * 100) : '100');
  const [goalWeightText, setGoalWeightText] = useState(goal?.goalWeightKg === undefined ? '' : pounds(goal.goalWeightKg));
  const [rateLb, setRateLb] = useState(goal === undefined ? -1 : Math.round((goal.kgPerWeek / KG_PER_LB) * 4) / 4);
  const [custom, setCustom] = useState(goal?.kcalOverride !== undefined);
  const [customText, setCustomText] = useState(goal?.kcalOverride === undefined ? '' : String(goal.kcalOverride));
  const [macroKind, setMacroKind] = useState<MacroTarget['kind']>(goal?.macros.kind ?? 'percent');
  const [macros, setMacros] = useState(goal === undefined ? { protein: '30', carbs: '40', fat: '30' } : macroTexts(goal.macros));
  const [waterText, setWaterText] = useState(String(Math.round(((goal?.waterMl ?? DEFAULT_WATER_ML) / ML_PER_FL_OZ) * 100) / 100));

  const override = parseNumber(customText);
  const waterOz = parseNumber(waterText);
  const waterMl = waterOz === null ? null : waterOz * ML_PER_FL_OZ;
  const waterValid = GoalDraft.shape.waterMl.safeParse(waterMl).success;
  const macroValues = { protein: parseNumber(macros.protein), carbs: parseNumber(macros.carbs), fat: parseNumber(macros.fat) };
  const percent = parseNumber(percentText);
  const percentValid = percent !== null && percent >= 0 && percent <= 100;
  const goalWeightLb = parseNumber(goalWeightText);
  const goalWeightKg = goalWeightLb === null ? null : goalWeightLb * KG_PER_LB;
  const goalWeightValid = goalWeightText.trim() === '' || GoalDraft.shape.goalWeightKg.safeParse(goalWeightKg).success;
  const draft = GoalDraft.safeParse({
    policy: policyKind === 'activity-level' ? { kind: 'activity-level', level } : { kind: 'eat-back-workouts', fraction: percent === null ? null : percent / 100 },
    kgPerWeek: rateLb * KG_PER_LB,
    ...(goalWeightText.trim() === '' ? {} : { goalWeightKg }),
    ...(custom ? { kcalOverride: override } : {}),
    macros: { kind: macroKind, ...macroValues },
    waterMl,
  });
  const budget = draft.success ? budgetFor({ ...draft.data, id: goalId(today), effectiveFrom: today }, { profile, weighIns, workouts: [] }, today) : null;
  const percentTotal = MACROS.reduce((sum, m) => sum + (macroValues[m] ?? 0), 0);

  const switchMacroKind = (kind: MacroTarget['kind']) => {
    if (kind === macroKind) return;
    setMacroKind(kind);
    if (budget === null) return;
    const convert = (m: Macro) => {
      const value = macroValues[m] ?? 0;
      return kind === 'grams'
        ? amount(Math.round((budget.kcal * value) / 100 / KCAL_PER_GRAM[m]))
        : amount(Math.round(((value * KCAL_PER_GRAM[m]) / budget.kcal) * 100));
    };
    setMacros({ protein: convert('protein'), carbs: convert('carbs'), fat: convert('fat') });
  };

  return (
    <>
      <h2 class="section-title">Profile</h2>
      <div class="group">
        <button type="button" class="row-button disclosure" onClick={() => setEditingProfile(true)}>
          {profile === undefined ? 'Add your details' : profileSummary(profile, today)}
          <Icon name="chevronRight" />
        </button>
        <button type="button" class="row-button disclosure" onClick={() => setShowingWeight(true)}>
          {trendKg === undefined ? 'Weight and weigh-ins' : `Weight · ${pounds(trendKg)} lb trend`}
          <Icon name="chevronRight" />
        </button>
      </div>

      <div class="card target">
        <p class="summary-label">Daily target</p>
        <p class="summary-big">
          <strong data-testid="goal-kcal">{budget === null ? '–' : kcal(budget.kcal)}</strong> kcal
        </p>
        <p class="target-detail">{targetDetail(budget, policyKind, rateLb)}</p>
        {weightBasis(budget) !== null && <p class="target-detail">{weightBasis(budget)}</p>}
        {budget !== null && (
          <p class="target-macros">{MACROS.map((m) => `${MACRO_LABEL[m]} ${amount(budget.macros[m])} g`).join(' · ')}</p>
        )}
      </div>

      <h2 class="section-title">Workouts and your target</h2>
      <Segmented
        label="Workouts and your target"
        options={(['activity-level', 'eat-back-workouts'] as const).map((kind) => ({ value: kind, label: POLICY_LABEL[kind] }))}
        value={policyKind}
        onChange={setPolicyKind}
      />
      <p class="hint policy-sentence" data-testid="policy-sentence">
        {policySentence(policyKind, percentValid ? percent : null)}
      </p>
      {policyKind === 'activity-level' ? (
        <div class="group policy-detail" role="radiogroup" aria-label="Activity level">
          {ActivityLevel.options.map((option) => (
            <button type="button" role="radio" aria-checked={option === level} class="choice" key={option} onClick={() => setLevel(option)}>
              <span>{ACTIVITY[option].label}</span>
              <span class="choice-detail">
                {ACTIVITY[option].detail} · ×{ACTIVITY[option].multiplier}
              </span>
              {option === level && (
                <span class="check" aria-hidden="true">
                  ✓
                </span>
              )}
            </button>
          ))}
        </div>
      ) : (
        <>
          <div class="group policy-detail">
            <NumberField label="Workouts counted" unit="%" value={percentText} onInput={setPercentText} invalid={!percentValid} />
          </div>
          {!percentValid && <p class="hint warn">Count from 0% to 100% of each workout.</p>}
        </>
      )}

      <h2 class="section-title">Weekly goal</h2>
      <div class="group">
        <label class="field">
          <span class="field-label">Rate</span>
          <select aria-label="Weekly goal" value={String(rateLb)} onChange={(event) => setRateLb(Number(event.currentTarget.value))}>
            {RATES_LB.map((lb) => (
              <option key={lb} value={String(lb)}>
                {rateLabel(lb)}
              </option>
            ))}
          </select>
        </label>
        <label class="field toggle">
          <span class="field-label">Custom calorie target</span>
          <input type="checkbox" role="switch" checked={custom} onChange={(event) => setCustom(event.currentTarget.checked)} />
        </label>
        {custom && <NumberField label="Target" unit="kcal" value={customText} onInput={setCustomText} placeholder="2000" invalid={override === null || override <= 0} />}
        <NumberField label="Goal weight" unit="lb" value={goalWeightText} onInput={setGoalWeightText} placeholder="Optional" invalid={!goalWeightValid} />
      </div>

      <h2 class="section-title">Macros</h2>
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
            onInput={(value) => setMacros({ ...macros, [m]: value })}
          />
        ))}
      </div>
      {macroKind === 'percent' && <p class={Math.abs(percentTotal - 100) < 0.5 ? 'hint' : 'hint warn'}>Total {amount(percentTotal)}%. A split must add up to 100%.</p>}

      <h2 class="section-title">Water</h2>
      <div class="group">
        <NumberField label="Daily goal" unit="fl oz" value={waterText} onInput={setWaterText} invalid={!waterValid} />
      </div>
      {!waterValid && <p class="hint warn">A daily water goal is more than 0 and at most {flOz(MAX_WATER_ML)} fl oz.</p>}

      <div class="screen-actions">
        <button
          type="button"
          class="primary"
          disabled={!draft.success}
          onClick={() => {
            if (!draft.success) return;
            void intents.saveGoal(draft.data, today).then(() => toast({ text: 'Goal saved from today. Past days keep their targets.' }));
          }}
        >
          Save goal
        </button>
      </div>
      {editingProfile && <ProfileSheet profile={profile} today={today} onClose={() => setEditingProfile(false)} />}
      {showingWeight && <WeightSheet today={today} onClose={() => setShowingWeight(false)} onGoal={() => setShowingWeight(false)} />}
    </>
  );
}

export function GoalScreen({ today }: { readonly today: LocalDate }) {
  const view = useLive((r) => goalView(r, today), [today]);
  return (
    <section class="screen goal">
      <TitleBar title="Goal" />
      {view !== undefined && <GoalForm key={view.goal?.id ?? 'none'} goal={view.goal} profile={view.profile} weighIns={view.weighIns} trendKg={view.trendKg} today={today} />}
    </section>
  );
}
