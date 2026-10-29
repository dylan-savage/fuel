"""Domain types for fuel. Pure data: no I/O and no framework beyond pydantic.

Invariants this module encodes:

- Nutrients are stored per basis: per 100 g, per 100 ml, or per 1 portion. Every amount of a
  food is a positive number in that food's basis unit. Grams and millilitres never convert
  into each other (no densities).
- A diary entry carries a snapshot of the per-basis nutrients it was logged with. Editing a food
  later never changes a past day. Entry nutrients are derived (snapshot x amount), never stored.
- Body weight is kilograms inside the system. Pounds exist only at the HTTP edge (units.py).
- Diary days are local calendar dates. Instants are timezone-aware UTC-convertible datetimes.
- Every type is frozen. State changes happen only through commands (commands.py).
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Literal, NewType, get_args

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator


class Frozen(BaseModel):
    """Base for every domain type: immutable, unknown fields rejected."""

    model_config = ConfigDict(frozen=True, extra="forbid")


# --- Identifiers and branded primitives -------------------------------------------------------

FoodId = NewType("FoodId", int)
ServingId = NewType("ServingId", int)
EntryId = NewType("EntryId", int)
RecipeId = NewType("RecipeId", int)
SavedMealId = NewType("SavedMealId", int)
DraftId = NewType("DraftId", int)
ExerciseId = NewType("ExerciseId", int)
FastId = NewType("FastId", int)

Gtin = NewType("Gtin", str)
"""Digits only, check digit verified. UPC-A is left-padded to 13 digits. Built only by
sources.barcode.parse_gtin, so a Gtin in hand is always valid."""

ZoneName = NewType("ZoneName", str)
"""An IANA zone name that zoneinfo accepted at the boundary."""

Kg = NewType("Kg", float)

Positive = Annotated[float, Field(gt=0)]
NonNeg = Annotated[float, Field(ge=0)]

# --- Closed vocabularies ----------------------------------------------------------------------
# The SQL CHECK constraints repeat these lists. tests/test_schema.py fails the build when the
# migration's CHECK lists and these Literals disagree.

Meal = Literal["breakfast", "lunch", "dinner", "snacks"]
MEALS: tuple[Meal, ...] = get_args(Meal)

BasisUnit = Literal["g", "ml", "portion"]
"""Nutrients are per 100 g, per 100 ml, or per 1 portion. See nutrition.basis_amount."""

FoodOrigin = Literal["manual", "off", "usda", "ai_label", "recipe"]
EntryOrigin = Literal["food", "quick", "ai"]
WeighInSource = Literal["manual", "health"]


# --- Nutrients --------------------------------------------------------------------------------


class Nutrients(Frozen):
    """Energy and macros for one basis amount (or for one entry, once scaled).

    The core four are required: a food cannot exist without them. The rest are None when the
    source did not report them, which is different from zero.
    """

    kcal: NonNeg
    protein_g: NonNeg
    carbs_g: NonNeg
    fat_g: NonNeg
    fiber_g: NonNeg | None = None
    sugar_g: NonNeg | None = None
    sodium_mg: NonNeg | None = None


class PartialNutrients(Frozen):
    """What an external source or AI reading reported. Any field may be missing."""

    kcal: NonNeg | None = None
    protein_g: NonNeg | None = None
    carbs_g: NonNeg | None = None
    fat_g: NonNeg | None = None
    fiber_g: NonNeg | None = None
    sugar_g: NonNeg | None = None
    sodium_mg: NonNeg | None = None


class PartialSum(Frozen):
    """A day's sum of a nutrient some entries do not report. `unknown` counts those entries."""

    value: NonNeg
    unknown: int


class Totals(Frozen):
    """Summed nutrients. Optional nutrients say how many entries were silent about them."""

    kcal: NonNeg
    protein_g: NonNeg
    carbs_g: NonNeg
    fat_g: NonNeg
    fiber_g: PartialSum
    sugar_g: PartialSum
    sodium_mg: PartialSum


# --- Catalog ----------------------------------------------------------------------------------


class Serving(Frozen):
    """A named portion of a food, measured in the food's basis unit ("1 slice" = 28 g)."""

    id: ServingId
    label: str
    amount: Positive


class NewServing(Frozen):
    """A serving that has no id yet (from a form, an import, or an AI label reading)."""

    label: str
    amount: Positive


class Food(Frozen):
    """Something loggable. Recipes are foods too (origin "recipe"), so every consumer handles one kind.

    Invariants: `servings` is never empty (a food always has its basis serving, "100 g" or
    "1 portion"); `default_serving_id` names one of them. A recipe's `per_basis` is written only
    by the recipe path in the service, never by EditFood.
    """

    id: FoodId
    name: str
    brand: str | None
    basis: BasisUnit
    per_basis: Nutrients
    servings: tuple[Serving, ...]
    default_serving_id: ServingId
    origin: FoodOrigin
    archived: bool

    @model_validator(mode="after")
    def _default_serving_exists(self) -> Food:
        raise NotImplementedError


class ExternalRef(Frozen):
    """Identity of a product in an external database. Unique in the catalog (origin, external_id)."""

    origin: Literal["off", "usda"]
    external_id: str


class FoodDraft(Frozen):
    """A food as an external source or label photo described it, possibly incomplete.

    nutrition.complete() turns it into a NewFood or names the missing fields, which the
    create-food form then asks for.
    """

    name: str | None
    brand: str | None
    basis: BasisUnit
    per_basis: PartialNutrients
    servings: tuple[NewServing, ...]
    gtin: Gtin | None
    ref: ExternalRef | None


class NewFood(Frozen):
    """A complete food ready to insert."""

    name: str
    brand: str | None
    basis: BasisUnit
    per_basis: Nutrients
    servings: tuple[NewServing, ...]
    gtins: tuple[Gtin, ...]
    origin: FoodOrigin
    ref: ExternalRef | None


class ExternalHit(Frozen):
    """One external search result. Not stored until the user picks it (service.import_external)."""

    ref: ExternalRef
    name: str
    brand: str | None
    kcal_per_100: float | None
    serving_hint: str | None


class Quantity(Frozen):
    """How much of a food. With a serving, `count` multiplies that serving's amount. Without one,
    `count` is already in the food's basis unit (grams, ml, or portions)."""

    serving_id: ServingId | None
    count: Positive


class RecipeItem(Frozen):
    food_id: FoodId
    quantity: Quantity


class Recipe(Frozen):
    """Ingredients yielding `portions`. Owns exactly one Food row (`food_id`) whose per_basis is
    derived from the items. With `cooked_weight_g` the food's basis is g, else portion.
    Ingredients are plain foods, never other recipes, so recomputation has no cycles."""

    id: RecipeId
    food_id: FoodId
    name: str
    portions: Positive
    cooked_weight_g: Positive | None
    items: tuple[RecipeItem, ...]


class SavedMealItem(Frozen):
    food_id: FoodId
    quantity: Quantity


class SavedMeal(Frozen):
    """A bundle logged in one tap. Logging expands it into ordinary entries, one per item."""

    id: SavedMealId
    name: str
    items: tuple[SavedMealItem, ...]


# --- Diary ------------------------------------------------------------------------------------


class ServingSnapshot(Frozen):
    """Display intent kept on an entry: "2 x 1 slice (28 g)"."""

    label: str
    amount_each: Positive
    count: Positive


class Entry(Frozen):
    """One diary line, self-contained. Nutrients = nutrition.entry_nutrients(entry).

    `food_id` is provenance only (recents, "log again"). It is None for quick adds and unmatched
    AI estimates. Invariant: when `serving` is set, amount == serving.amount_each * serving.count.
    """

    id: EntryId
    day: date
    meal: Meal
    label: str
    food_id: FoodId | None
    origin: EntryOrigin
    basis: BasisUnit
    per_basis: Nutrients
    amount: Positive
    serving: ServingSnapshot | None
    logged_at: AwareDatetime


# --- Goals and energy -------------------------------------------------------------------------


class PercentSplit(Frozen):
    """Macro targets as a share of the day's kcal target. Sums to 100."""

    kind: Literal["percent"]
    protein: int
    carbs: int
    fat: int


class GramTargets(Frozen):
    kind: Literal["grams"]
    protein_g: NonNeg
    carbs_g: NonNeg
    fat_g: NonNeg


MacroPlan = Annotated[PercentSplit | GramTargets, Field(discriminator="kind")]


class Profile(Frozen):
    """Singleton. Inputs to BMR plus display and habit settings."""

    sex: Literal["male", "female"]
    birth_date: date
    height_cm: Positive
    display_units: Literal["imperial", "metric"]
    tz: ZoneName
    water_goal_ml: Positive
    health_tracks_workouts: bool
    """Default for new manual exercises: does a watch already count this in Active Energy?"""


class Goal(Frozen):
    """Effective-dated. The goal for a day is the latest one with effective_from <= day, so past
    days keep the goal they were lived under."""

    effective_from: date
    activity_multiplier: Annotated[float, Field(ge=1.2, le=1.9)]
    rate_kg_per_week: Annotated[float, Field(ge=-1.0, le=0.5)]
    kcal_override: Positive | None
    macros: MacroPlan
    burn_credit: Annotated[float, Field(ge=0, le=1)]
    goal_weight_kg: Kg | None


class DailyTarget(Frozen):
    """The intake target before any burn credit. Derived on read, never stored."""

    kcal: float
    protein_g: float
    carbs_g: float
    fat_g: float
    bmr: float
    baseline_active_kcal: float
    """Activity the multiplier already assumes: bmr * (multiplier - 1). Burn below this earns nothing."""
    source: Literal["derived", "override"]


class Exercise(Frozen):
    """A manually logged workout. kcal is snapshotted at log time (MET x kg x hours, or typed)."""

    id: ExerciseId
    day: date
    label: str
    minutes: Positive | None
    kcal: NonNeg
    tracked_by_health: bool


class HealthDay(Frozen):
    """What the Shortcut last observed for a day. Written only by health ingest."""

    day: date
    active_kcal: NonNeg | None
    steps: int | None


class ActiveBurn(Frozen):
    """Burn for a day after the double-counting rule in energy.active_burn."""

    health_kcal: float | None
    manual_counted_kcal: float
    manual_ignored_kcal: float
    """Manual exercise already inside Health's Active Energy, shown but not added."""
    total_kcal: float


class Budget(Frozen):
    target: DailyTarget
    burn: ActiveBurn
    credit_kcal: float
    budget_kcal: float
    eaten: Totals
    remaining_kcal: float


# --- Body -------------------------------------------------------------------------------------


class WeighIn(Frozen):
    """One weigh-in per (day, source). Manual and Health rows never overwrite each other."""

    day: date
    kg: Kg
    source: WeighInSource
    measured_at: AwareDatetime


class TrendPoint(Frozen):
    day: date
    trend_kg: Kg
    weighed_kg: Kg | None
    """None on days filled by interpolation."""


class TdeeEstimate(Frozen):
    window_days: int
    logged_days: int
    avg_intake_kcal: float
    trend_change_kg: float
    tdee_kcal: float
    suggested_target_kcal: float


class BodyView(Frozen):
    points: tuple[TrendPoint, ...]
    weekly_rate_kg: float | None
    projected_goal_date: date | None
    adaptive: TdeeEstimate | None


# --- Habits -----------------------------------------------------------------------------------


class CompletedFast(Frozen):
    id: FastId
    started_at: AwareDatetime
    ended_at: AwareDatetime
    target_hours: Positive


class NotFasting(Frozen):
    state: Literal["idle"] = "idle"
    last: CompletedFast | None


class Fasting(Frozen):
    state: Literal["fasting"] = "fasting"
    id: FastId
    started_at: AwareDatetime
    target_hours: Positive


FastState = Annotated[NotFasting | Fasting, Field(discriminator="state")]


# --- AI drafts --------------------------------------------------------------------------------


class EstimatedItem(Frozen):
    """One thing Claude saw in text or a plate photo.

    When the server matched it to a catalog food, `match` holds that food and quantity and the
    confirmed entry uses catalog nutrients. Otherwise the entry uses `estimate` as a portion.
    """

    label: str
    match: RecipeItem | None
    estimate: Nutrients


class MealReading(Frozen):
    kind: Literal["meal"] = "meal"
    items: tuple[EstimatedItem, ...]


class LabelReading(Frozen):
    kind: Literal["label"] = "label"
    food: FoodDraft


DraftBody = Annotated[MealReading | LabelReading, Field(discriminator="kind")]


class Unparsed(Frozen):
    status: Literal["unparsed"] = "unparsed"


class Ready(Frozen):
    status: Literal["ready"] = "ready"
    body: DraftBody


class ParseFailed(Frozen):
    status: Literal["failed"] = "failed"
    reason: str


class Closed(Frozen):
    status: Literal["confirmed", "discarded"]


DraftState = Annotated[Unparsed | Ready | ParseFailed | Closed, Field(discriminator="status")]


class Draft(Frozen):
    """Server-held AI result awaiting confirmation. Survives the phone closing the tab.

    A LogText command creates it Unparsed (no network inside the command). The first view of the
    draft parses it (service.ensure_parsed). A photo snap creates it Ready directly.
    """

    id: DraftId
    text: str | None
    day: date
    meal: Meal | None
    state: DraftState
    created_at: datetime


# --- Read models the pages render -------------------------------------------------------------


class QuickPick(Frozen):
    """A one-tap log button. `label` is the exact text the outbox shows if the tap is queued."""

    food_id: FoodId
    quantity: Quantity
    label: str
    kcal: float


class QuickPicks(Frozen):
    """Recents, frequents and saved meals for a meal slot. Rendered into the Today page so it
    stays loggable from the service worker's cached copy when the mini is unreachable."""

    meal: Meal
    foods: tuple[QuickPick, ...]
    saved_meals: tuple[SavedMeal, ...]


class DayView(Frozen):
    """Everything the day page shows. Every number here was computed on the mini."""

    day: date
    entries: dict[Meal, tuple[Entry, ...]]
    totals: Totals
    budget: Budget | None
    """None until a goal exists."""
    water_ml: float
    water_goal_ml: float | None
    exercises: tuple[Exercise, ...]
    health: HealthDay | None
    fast: FastState
    pending_drafts: int
    picks: dict[Meal, QuickPicks]
