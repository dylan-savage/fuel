import { useState } from 'preact/hooks';
import { FoodDraft, type Food, type Gtin } from '../../domain/food.js';
import { NUTRIENTS, type NutrientKey, type PartialNutrients } from '../../domain/nutrients.js';
import { BASIS, type FoodUnit } from '../../domain/units.js';
import { useIntents } from '../views.js';
import { BASIS_LABEL, UNIT_LABEL, parseNumber } from './format.js';
import { NumberField, Segmented, Sheet, TextField, useToast } from './ui.js';

interface ServingRow {
  readonly label: string;
  readonly amount: string;
}

/** Where the editor starts: an existing food, or a new one that may carry a scanned barcode. */
export type EditorSeed = { readonly kind: 'new'; readonly barcodes: readonly Gtin[] } | { readonly kind: 'edit'; readonly food: Food };

const precise = (n: number) => String(Math.round(n * 100) / 100);
const UNITS: readonly FoodUnit[] = ['g', 'ml', 'portion'];

/**
 * Create or edit a library food by hand. Labels print values per serving, so the values can
 * be typed per serving and are stored per 100 g or ml, the food's one basis.
 */
export function FoodEditor({ seed, onSaved, onClose }: { readonly seed: EditorSeed; readonly onSaved: (food: Food) => void; readonly onClose: () => void }) {
  const intents = useIntents();
  const toast = useToast();
  const existing = seed.kind === 'edit' ? seed.food : undefined;
  const [name, setName] = useState(existing?.name ?? '');
  const [brand, setBrand] = useState(existing?.brand ?? '');
  const [unit, setUnit] = useState<FoodUnit>(existing?.unit ?? 'g');
  const [servings, setServings] = useState<readonly ServingRow[]>(
    existing?.servings.map((s) => ({ label: s.label, amount: precise(s.amount) })) ?? [{ label: '1 serving', amount: '' }],
  );
  /** -1 means the food's basis (100 g, 100 ml, 1 portion); otherwise a serving row. */
  const [per, setPer] = useState(seed.kind === 'new' ? 0 : -1);
  const [values, setValues] = useState<Readonly<Partial<Record<NutrientKey, string>>>>(() =>
    Object.fromEntries(NUTRIENTS.flatMap((n) => (existing?.nutrients[n.key] === undefined ? [] : [[n.key, precise(existing.nutrients[n.key] ?? 0)]]))),
  );

  const parsedServings = servings.flatMap((row) => {
    const n = parseNumber(row.amount);
    return row.label.trim() !== '' && n !== null && n > 0 ? [{ label: row.label.trim(), amount: n }] : [];
  });
  const perServing = per >= 0 ? servings[per] : undefined;
  const perAmount = perServing === undefined ? BASIS[unit] : parseNumber(perServing.amount);
  const factor = perAmount !== null && perAmount > 0 ? BASIS[unit] / perAmount : null;

  const nutrients: PartialNutrients = {};
  for (const n of NUTRIENTS) {
    const value = parseNumber(values[n.key] ?? '');
    if (value !== null && factor !== null) nutrients[n.key] = value * factor;
  }
  const draft = FoodDraft.safeParse({
    name: name.trim(),
    ...(brand.trim() === '' ? {} : { brand: brand.trim() }),
    unit,
    nutrients,
    servings: parsedServings,
    barcodes: existing?.barcodes ?? (seed.kind === 'new' ? seed.barcodes : []),
    source: existing?.source ?? { kind: 'user' },
  });

  const perOptions = [
    { value: '-1', label: BASIS_LABEL[unit] },
    ...servings.flatMap((row, i) => (row.label.trim() === '' ? [] : [{ value: String(i), label: row.label.trim() }])),
  ];

  const save = async () => {
    if (!draft.success) return;
    const food = existing === undefined ? await intents.createFood(draft.data) : await intents.updateFood(existing.id, draft.data);
    toast({ text: `Saved ${food.name}` });
    onSaved(food);
  };

  return (
    <Sheet title={existing === undefined ? 'New food' : 'Edit food'} onClose={onClose}>
      <div class="group">
        <TextField label="Name" value={name} onInput={setName} placeholder="Required" />
        <TextField label="Brand" value={brand} onInput={setBrand} placeholder="Optional" />
      </div>
      <h4 class="group-title">Measured in</h4>
      <Segmented label="Measured in" options={UNITS.map((u) => ({ value: u, label: UNIT_LABEL[u] }))} value={unit} onChange={setUnit} />

      <h4 class="group-title">Servings</h4>
      <div class="group">
        {servings.map((row, i) => (
          <div class="serving-row" key={i}>
            <input
              aria-label={`Serving ${i + 1} name`}
              autoComplete="off"
              value={row.label}
              placeholder="1 slice"
              onInput={(event) => setServings(servings.map((r, j) => (j === i ? { ...r, label: event.currentTarget.value } : r)))}
            />
            <input
              aria-label={`Serving ${i + 1} size`}
              inputMode="decimal"
              autoComplete="off"
              value={row.amount}
              placeholder="30"
              onInput={(event) => setServings(servings.map((r, j) => (j === i ? { ...r, amount: event.currentTarget.value } : r)))}
            />
            <span class="field-unit">{UNIT_LABEL[unit]}</span>
            <button
              type="button"
              class="text-button"
              aria-label={`Remove serving ${i + 1}`}
              onClick={() => {
                setServings(servings.filter((_, j) => j !== i));
                setPer(per === i ? -1 : per > i ? per - 1 : per);
              }}
            >
              Remove
            </button>
          </div>
        ))}
        <button type="button" class="row-button" onClick={() => setServings([...servings, { label: '', amount: '' }])}>
          Add a serving
        </button>
      </div>

      <h4 class="group-title">Nutrition per</h4>
      <Segmented label="Nutrition per" options={perOptions} value={String(per)} onChange={(v) => setPer(Number(v))} />
      <div class="group">
        {NUTRIENTS.map((n) => (
          <NumberField
            key={n.key}
            label={n.label}
            unit={n.unit}
            value={values[n.key] ?? ''}
            placeholder={n.core ? 'Required' : 'Optional'}
            invalid={n.core && (values[n.key] ?? '') !== '' && parseNumber(values[n.key] ?? '') === null}
            onInput={(value) => setValues({ ...values, [n.key]: value })}
          />
        ))}
      </div>

      <div class="sheet-actions">
        <button type="button" class="primary" disabled={!draft.success} onClick={() => void save()}>
          Save food
        </button>
        {existing !== undefined && (
          <button
            type="button"
            class="destructive"
            onClick={() =>
              void intents.archiveFood(existing.id).then((undo) => {
                toast({ text: `Removed ${existing.name} from your foods`, undo });
                onClose();
              })
            }
          >
            Remove from my foods
          </button>
        )}
      </div>
    </Sheet>
  );
}
