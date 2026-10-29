import { useCallback, useMemo, useState } from 'preact/hooks';
import { defaultQuantity, nutrientsFor, snapshotOf, type FoodCandidate, type FoodSnapshot, type Ingredient, type Quantity } from '../../domain/food.js';
import type { RecipeId } from '../../domain/ids.js';
import { foodKey, matches, offers } from '../../domain/library.js';
import { RecipeDraft, perServing, type Recipe } from '../../domain/reuse.js';
import { libraryView, useIntents, useLive } from '../views.js';
import { ConfirmSheet, type Confirmed } from './ConfirmSheet.js';
import { FoodHeading, NutritionPreview, useQuantityPicker } from './FoodSheet.js';
import { brandOf, kcal, parseNumber, quantityLabel } from './format.js';
import { FoodRow, OnlineSection } from './search.js';
import { Icon, NumberField, Sheet, TextField, useToast } from './ui.js';
import { useUpdatePrompt } from './UpdatePrompt.js';

export type RecipeSeed = { readonly kind: 'new' } | { readonly kind: 'edit'; readonly recipe: Recipe };

/** The sheet open over the builder, if any. `index` is the ingredient being changed, or null for a new one. */
type Step =
  | { readonly kind: 'none' }
  | { readonly kind: 'pick' }
  | { readonly kind: 'amount'; readonly food: FoodSnapshot; readonly quantity: Quantity; readonly index: number | null }
  | { readonly kind: 'confirm'; readonly candidate: FoodCandidate };

const precise = (n: number) => String(Math.round(n * 100) / 100);
const positive = (n: number | null): n is number => n !== null && n > 0;

/** How much of a food goes in. Offering removal means the food is already an ingredient. */
function IngredientSheet({
  food,
  initial,
  onSet,
  onRemove,
  onClose,
}: {
  readonly food: FoodSnapshot;
  readonly initial: Quantity;
  readonly onSet: (quantity: Quantity) => void;
  readonly onRemove?: () => void;
  readonly onClose: () => void;
}) {
  const { quantity, picker } = useQuantityPicker(food, initial);
  return (
    <Sheet title={onRemove === undefined ? 'Add ingredient' : 'Ingredient'} onClose={onClose}>
      <FoodHeading food={food} />
      <NutritionPreview nutrients={quantity === null ? null : nutrientsFor(food, quantity)} />
      {picker}
      <div class="sheet-actions">
        <button type="button" class="primary" disabled={quantity === null} onClick={() => quantity && onSet(quantity)}>
          {onRemove === undefined ? 'Add to recipe' : 'Update ingredient'}
        </button>
        {onRemove && (
          <button type="button" class="destructive" onClick={onRemove}>
            Remove ingredient
          </button>
        )}
      </div>
    </Sheet>
  );
}

/** Library foods and recipes to choose from, then online results for a query. */
function IngredientPicker({
  excluding,
  onFood,
  onCandidate,
  onClose,
}: {
  readonly excluding: RecipeId | undefined;
  readonly onFood: (food: FoodSnapshot) => void;
  readonly onCandidate: (candidate: FoodCandidate) => void;
  readonly onClose: () => void;
}) {
  const library = useLive(libraryView, []);
  const [query, setQuery] = useState('');
  const trimmed = query.trim();
  const choices = useMemo(
    () => offers(library ?? { foods: [], recipes: [] }).filter((food) => !(food.origin.kind === 'recipe' && food.origin.id === excluding)),
    [library, excluding],
  );
  const shown = trimmed === '' ? choices : choices.filter((food) => matches(food, trimmed));
  const known = useMemo(() => new Set((library?.foods ?? []).flatMap((f) => f.barcodes)), [library]);

  return (
    <Sheet title="Add ingredient" onClose={onClose}>
      <div class="search">
        <input
          type="search"
          aria-label="Search ingredients"
          placeholder="Search your foods and online"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          value={query}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
      </div>
      <h2 class="section-title">Your foods</h2>
      {shown.length === 0 ? (
        <p class="empty">{trimmed === '' ? 'Foods you create or import show up here.' : 'No match in your foods.'}</p>
      ) : (
        <ul class="list" aria-label="Your foods">
          {shown.map((food) => (
            <FoodRow key={foodKey(food)} food={food} quantity={defaultQuantity(food)} onOpen={() => onFood(food)} />
          ))}
        </ul>
      )}
      {trimmed !== '' && (
        <OnlineSection
          query={trimmed}
          known={known}
          onOpen={(opened) => (opened.kind === 'food' ? onFood(snapshotOf(opened.food)) : onCandidate(opened.candidate))}
        />
      )}
    </Sheet>
  );
}

/**
 * Build or edit a recipe: a name, ingredients from the library or online with amounts, the
 * servings it makes and, optionally, its cooked weight. One serving's nutrients update as
 * ingredients change.
 */
export function RecipeBuilder({
  seed,
  onSaved,
  onClose,
}: {
  readonly seed: RecipeSeed;
  readonly onSaved: (recipe: Recipe) => void;
  readonly onClose: () => void;
}) {
  const intents = useIntents();
  const toast = useToast();
  const { saved, prompt } = useUpdatePrompt();
  const existing = seed.kind === 'edit' ? seed.recipe : undefined;
  const [name, setName] = useState(existing?.name ?? '');
  const [servings, setServings] = useState(existing === undefined ? '' : precise(existing.yield.servings));
  const [cooked, setCooked] = useState(existing?.yield.cookedGrams === undefined ? '' : precise(existing.yield.cookedGrams));
  const [ingredients, setIngredients] = useState<readonly Ingredient[]>(existing?.ingredients ?? []);
  const [step, setStep] = useState<Step>({ kind: 'none' });
  const closeStep = useCallback(() => setStep({ kind: 'none' }), []);

  const servingCount = parseNumber(servings);
  const cookedGrams = parseNumber(cooked);
  const draft = RecipeDraft.safeParse({
    name: name.trim(),
    ingredients,
    yield: { servings: servingCount, ...(cooked.trim() === '' ? {} : { cookedGrams }) },
  });
  const serving = ingredients.length > 0 && positive(servingCount) ? perServing({ ingredients, yield: { servings: servingCount } }) : null;

  const place = (food: FoodSnapshot, quantity: Quantity, index: number | null) => {
    setIngredients(index === null ? [...ingredients, { food, quantity }] : ingredients.map((item, i) => (i === index ? { ...item, quantity } : item)));
    closeStep();
  };

  const importIngredient = async ({ candidate, quantity }: Confirmed) => {
    const imported = await intents.importFood(candidate);
    if (imported.ok) place(snapshotOf(imported.food), quantity, null);
  };

  const save = async () => {
    if (!draft.success) return;
    const recipe = existing === undefined ? await intents.createRecipe(draft.data) : await intents.updateRecipe(existing.id, draft.data);
    await saved({ kind: 'recipe', id: recipe.id }, recipe.name, () => onSaved(recipe));
  };

  let over = null;
  switch (step.kind) {
    case 'none':
      break;
    case 'pick':
      over = (
        <IngredientPicker
          excluding={existing?.id}
          onFood={(food) => setStep({ kind: 'amount', food, quantity: defaultQuantity(food), index: null })}
          onCandidate={(candidate) => setStep({ kind: 'confirm', candidate })}
          onClose={closeStep}
        />
      );
      break;
    case 'amount': {
      const { food, index } = step;
      const remove = () => {
        setIngredients(ingredients.filter((_, i) => i !== index));
        closeStep();
      };
      over = (
        <IngredientSheet
          food={food}
          initial={step.quantity}
          onSet={(quantity) => place(food, quantity, index)}
          {...(index === null ? {} : { onRemove: remove })}
          onClose={closeStep}
        />
      );
      break;
    }
    case 'confirm':
      over = (
        <ConfirmSheet
          candidate={step.candidate}
          onClose={closeStep}
          action={(confirmed) => (
            <div class="sheet-actions">
              <button type="button" class="primary" disabled={confirmed === null} onClick={() => confirmed && void importIngredient(confirmed)}>
                Add to library and recipe
              </button>
            </div>
          )}
        />
      );
      break;
  }

  return (
    <>
      <Sheet title={existing === undefined ? 'New recipe' : 'Edit recipe'} onClose={onClose}>
        <div class="group">
          <TextField label="Name" value={name} onInput={setName} placeholder="Required" />
          <NumberField
            label="Servings"
            value={servings}
            onInput={setServings}
            placeholder="Required"
            invalid={servings.trim() !== '' && !positive(servingCount)}
          />
          <NumberField
            label="Cooked weight"
            unit="g"
            value={cooked}
            onInput={setCooked}
            placeholder="Optional"
            invalid={cooked.trim() !== '' && !positive(cookedGrams)}
          />
        </div>
        <p class="hint">Weigh the finished dish to log servings by the gram.</p>

        <h4 class="group-title">Per serving</h4>
        <NutritionPreview nutrients={serving} />

        <h4 class="group-title">Ingredients</h4>
        <ul class="list" aria-label="Ingredients">
          {ingredients.map((item, i) => (
            <li key={i}>
              <button type="button" class="entry-row" onClick={() => setStep({ kind: 'amount', food: item.food, quantity: item.quantity, index: i })}>
                <span class="food-name">{item.food.name}</span>
                <span class="food-detail">{[brandOf(item.food), quantityLabel(item.food, item.quantity)].filter(Boolean).join(' · ')}</span>
                <span class="entry-kcal">{kcal(nutrientsFor(item.food, item.quantity).kcal)}</span>
              </button>
            </li>
          ))}
          <li>
            <button type="button" class="row-button" onClick={() => setStep({ kind: 'pick' })}>
              <Icon name="plus" /> Add ingredient
            </button>
          </li>
        </ul>

        <div class="sheet-actions">
          <button type="button" class="primary" disabled={!draft.success} onClick={() => void save()}>
            Save recipe
          </button>
          {existing !== undefined && (
            <button
              type="button"
              class="destructive"
              onClick={() =>
                void intents.archiveRecipe(existing.id).then((undo) => {
                  toast({ text: `Deleted ${existing.name}`, undo });
                  onClose();
                })
              }
            >
              Delete recipe
            </button>
          )}
        </div>
        {prompt}
      </Sheet>
      {over}
    </>
  );
}
