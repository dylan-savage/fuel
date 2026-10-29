"""The write vocabulary. Every state change the PWA can ask for is one of these commands.

Why one closed union instead of a REST route per resource:
- Idempotency lives in exactly one place (Fuel.apply keyed on Envelope.id), not per route.
- The service worker's offline outbox replays opaque command bodies to one URL; it never needs
  to know what a command means.
- Fuel.apply matches exhaustively over Command; pyright strict fails the build when a new
  command has no handler.

Writes that need the network first (barcode import, external import, photo snap, AI parse) are
not commands. They are acquisitions on the Fuel service, idempotent by natural key, and never
queued offline. Health ingest is its own contract (health.py).
"""

from __future__ import annotations

from datetime import date
from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, Field, model_validator

from fuel.model import (
    BasisUnit,
    DraftId,
    EntryId,
    ExerciseId,
    FoodId,
    Frozen,
    Gtin,
    Kg,
    MacroPlan,
    Meal,
    NewServing,
    Nutrients,
    Positive,
    Profile,
    Quantity,
    RecipeId,
    RecipeItem,
    SavedMealId,
    SavedMealItem,
    ZoneName,
)

CommandId = Annotated[UUID, "client-generated per tap; the idempotency key"]


class _Cmd(Frozen):
    """Commands with an optional `day`: absent means the local date of Envelope.at.

    The Today page never sends `day`, so a tap on a cached Today page after midnight logs to
    the new day. Pages for an explicit date always send it.
    """


# --- Diary ------------------------------------------------------------------------------------


class LogFood(_Cmd):
    kind: Literal["log_food"]
    food_id: FoodId
    quantity: Quantity
    meal: Meal
    day: date | None = None


class LogSavedMeal(_Cmd):
    kind: Literal["log_saved_meal"]
    saved_meal_id: SavedMealId
    meal: Meal
    day: date | None = None


class QuickAdd(_Cmd):
    """Calories (and optionally macros) with no food. The offline fallback that needs no lookup."""

    kind: Literal["quick_add"]
    label: str
    kcal: Annotated[float, Field(ge=0)]
    protein_g: float | None = None
    carbs_g: float | None = None
    fat_g: float | None = None
    meal: Meal
    day: date | None = None


class EditEntry(_Cmd):
    """Rescale or move an entry. Rescaling reuses the entry's snapshot, never the current food."""

    kind: Literal["edit_entry"]
    entry_id: EntryId
    count: Positive | None = None
    meal: Meal | None = None


class DeleteEntry(_Cmd):
    """Converges: deleting an entry that is already gone is Applied, not Rejected."""

    kind: Literal["delete_entry"]
    entry_id: EntryId


class CopyEntries(_Cmd):
    """Copy snapshots (not foods) from one day or meal to another. Whole day when meals are None."""

    kind: Literal["copy_entries"]
    from_day: date
    from_meal: Meal | None = None
    to_meal: Meal | None = None
    day: date | None = None


class LogText(_Cmd):
    """Free text for AI. Applying it only stores an Unparsed draft, so it queues offline."""

    kind: Literal["log_text"]
    text: Annotated[str, Field(min_length=1, max_length=2000)]
    meal: Meal | None = None
    day: date | None = None


class ConfirmDraft(_Cmd):
    """Turn a ready draft into entries. `keep` lists item indexes the user left ticked; `counts`
    overrides quantities the user edited on the review screen."""

    kind: Literal["confirm_draft"]
    draft_id: DraftId
    keep: tuple[int, ...]
    counts: dict[int, Positive] = {}
    meal: Meal
    day: date | None = None


class DiscardDraft(_Cmd):
    kind: Literal["discard_draft"]
    draft_id: DraftId


# --- Catalog ----------------------------------------------------------------------------------


class CreateFood(_Cmd):
    kind: Literal["create_food"]
    name: str
    brand: str | None = None
    basis: BasisUnit
    per_basis: Nutrients
    servings: tuple[NewServing, ...] = ()
    gtin: Gtin | None = None
    log: LogFood | None = None
    """Create and log in one tap (the "not found after scan" flow)."""


class EditFood(_Cmd):
    """Rejected for recipe foods; those change only through SaveRecipe."""

    kind: Literal["edit_food"]
    food_id: FoodId
    name: str
    brand: str | None = None
    per_basis: Nutrients
    servings: tuple[NewServing, ...]


class ArchiveFood(_Cmd):
    """Foods are never deleted, so queued commands and entry provenance never dangle."""

    kind: Literal["archive_food"]
    food_id: FoodId


class SaveRecipe(_Cmd):
    """Create (recipe_id None) or replace a recipe. Recomputes its food's per_basis in the same transaction."""

    kind: Literal["save_recipe"]
    recipe_id: RecipeId | None = None
    name: str
    portions: Positive
    cooked_weight_g: Positive | None = None
    items: tuple[RecipeItem, ...]


class SaveSavedMeal(_Cmd):
    kind: Literal["save_saved_meal"]
    saved_meal_id: SavedMealId | None = None
    name: str
    items: tuple[SavedMealItem, ...]


# --- Body, goals, burn ------------------------------------------------------------------------


class LogWeight(_Cmd):
    """Manual weigh-in. The wire sends value + unit ("179.4", "lb"); the before-validator
    converts to kg so nothing past this boundary sees pounds."""

    kind: Literal["log_weight"]
    kg: Kg
    day: date | None = None

    @model_validator(mode="before")
    @classmethod
    def _from_display_unit(cls, data: object) -> object:
        raise NotImplementedError


class SetProfile(_Cmd):
    kind: Literal["set_profile"]
    profile: Profile


class SetGoal(_Cmd):
    """Writes the goal effective from `effective_from` (default: today). Past days keep their goal."""

    kind: Literal["set_goal"]
    effective_from: date | None = None
    activity_multiplier: float
    rate_kg_per_week: float
    kcal_override: Positive | None = None
    macros: MacroPlan
    burn_credit: float = 1.0
    goal_weight_kg: Kg | None = None


class LogExercise(_Cmd):
    """Either an activity from the seeded MET table plus minutes, or a typed kcal."""

    kind: Literal["log_exercise"]
    activity: str | None = None
    minutes: Positive | None = None
    kcal: Positive | None = None
    label: str | None = None
    tracked_by_health: bool | None = None
    """None means Profile.health_tracks_workouts."""
    day: date | None = None


class DeleteExercise(_Cmd):
    kind: Literal["delete_exercise"]
    exercise_id: ExerciseId


# --- Habits -----------------------------------------------------------------------------------


class AddWater(_Cmd):
    """Additive. Safe to replay only because the envelope id dedupes it."""

    kind: Literal["add_water"]
    ml: Annotated[float, Field(gt=-2000, lt=5000)]
    """Negative undoes an over-tap."""
    day: date | None = None


class StartFast(_Cmd):
    """Starts at Envelope.at, so a queued start keeps the time Dylan tapped. Rejected while fasting."""

    kind: Literal["start_fast"]
    target_hours: Positive


class EndFast(_Cmd):
    """Ends the open fast at Envelope.at. Applied as a no-op when no fast is open."""

    kind: Literal["end_fast"]


Command = Annotated[
    LogFood
    | LogSavedMeal
    | QuickAdd
    | EditEntry
    | DeleteEntry
    | CopyEntries
    | LogText
    | ConfirmDraft
    | DiscardDraft
    | CreateFood
    | EditFood
    | ArchiveFood
    | SaveRecipe
    | SaveSavedMeal
    | LogWeight
    | SetProfile
    | SetGoal
    | LogExercise
    | DeleteExercise
    | AddWater
    | StartFast
    | EndFast,
    Field(discriminator="kind"),
]


class Envelope(Frozen):
    """A command plus the facts of the tap: who-knows-when and where.

    `id` and `at` are stamped by fuel.js at tap time, so an offline tap replayed hours later
    still has its original identity and time. Without JS the route fills id=uuid4, at=now,
    tz=Profile.tz (no idempotency, but the form still works).
    """

    id: CommandId
    at: AwareDatetime
    tz: ZoneName
    command: Command

    def day(self, explicit: date | None) -> date:
        """`explicit` if given, else the local date of `at` in `tz`."""
        raise NotImplementedError


# --- Outcomes ---------------------------------------------------------------------------------


class Created(Frozen):
    kind: Literal["food", "recipe", "saved_meal", "draft"]
    id: int


class Applied(Frozen):
    status: Literal["applied"] = "applied"
    day: date | None
    """The diary day whose panel should re-render, if any."""
    created: Created | None = None


class Rejected(Frozen):
    status: Literal["rejected"] = "rejected"
    reason: str


Outcome = Annotated[Applied | Rejected, Field(discriminator="status")]


class Receipt(Frozen):
    """What apply returns. A command id has exactly one outcome, fixed at first receipt; a replay
    gets that same outcome back with duplicate=True."""

    outcome: Outcome
    duplicate: bool
