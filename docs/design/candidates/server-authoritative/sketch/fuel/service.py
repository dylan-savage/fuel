"""The Fuel service: the one owner of every state change and every read model.

Routes call this and nothing else (import-linter forbids fuel.web -> fuel.store/sources).
It hides SQL, idempotency, snapshotting, recipe recomputation, the burn rule, the trend, and
every external API behind about fifteen methods.

Three kinds of write, each with its own idempotency key:
- apply(Envelope): the command vocabulary. Keyed on the client command id. Queueable offline.
- ingest_health(HealthBatch): the Shortcut. Keyed on (day, metric) with latest observation winning.
- acquisitions (resolve_barcode, import_external, snap, ensure_parsed): fetch over the network,
  then write in a short transaction. Keyed on natural keys (gtin, origin+external_id, draft
  status). Never queued offline, because they need the network anyway.

Invariant: network calls happen before a write transaction opens, never inside one.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date, datetime
from typing import Literal, assert_never

from fuel.commands import (
    AddWater,
    Applied,
    ArchiveFood,
    ConfirmDraft,
    CopyEntries,
    CreateFood,
    DeleteEntry,
    DeleteExercise,
    DiscardDraft,
    EditEntry,
    EditFood,
    EndFast,
    Envelope,
    LogExercise,
    LogFood,
    LogSavedMeal,
    LogText,
    LogWeight,
    Outcome,
    QuickAdd,
    Receipt,
    SaveRecipe,
    SaveSavedMeal,
    SetGoal,
    SetProfile,
    StartFast,
)
from fuel.health import HealthBatch, IngestReport
from fuel.model import (
    BodyView,
    DayView,
    Draft,
    DraftId,
    ExternalHit,
    ExternalRef,
    Food,
    FoodDraft,
    FoodId,
    Frozen,
    Gtin,
    Meal,
    QuickPicks,
    Recipe,
    RecipeId,
    SavedMeal,
)
from fuel.sources.barcode import decode
from fuel.sources.claude import Claude
from fuel.sources.off import OpenFoodFacts
from fuel.sources.usda import Usda
from fuel.store import FoodHit, Store, Writer


class Rejection(Exception):
    """Raised by a handler when the command is invalid against current state. apply() rolls
    back the handler's writes and records the rejection as the command's permanent outcome."""


class Sources(Frozen, arbitrary_types_allowed=True):
    off: OpenFoodFacts
    usda: Usda | None
    claude: Claude | None
    """None when ANTHROPIC_API_KEY is absent; AI controls are then not rendered at all."""


# --- Acquisition results ----------------------------------------------------------------------


class Known(Frozen):
    kind: Literal["known"] = "known"
    food_id: FoodId


class NeedsDetails(Frozen):
    """OFF had the product but not the core four nutrients. The create form opens prefilled."""

    kind: Literal["needs_details"] = "needs_details"
    draft: FoodDraft
    missing: tuple[str, ...]


class NotFound(Frozen):
    kind: Literal["not_found"] = "not_found"
    gtin: Gtin
    source_down: bool
    """True when OFF timed out, so the page says "try again" rather than "unknown product"."""


BarcodeResolution = Known | NeedsDetails | NotFound


class NoBarcodeNoAi(Frozen):
    kind: Literal["nothing"] = "nothing"


class SnapDraft(Frozen):
    kind: Literal["draft"] = "draft"
    draft_id: DraftId


SnapResult = BarcodeResolution | SnapDraft | NoBarcodeNoAi


class LocalResults(Frozen):
    """Ranked: recent and frequent for this meal first, then own foods and recipes, then saved meals."""

    foods: tuple[FoodHit, ...]
    saved_meals: tuple[SavedMeal, ...]


class Fuel:
    def __init__(self, store: Store, sources: Sources, now: Callable[[], datetime], tz: str) -> None:
        raise NotImplementedError

    # --- Commands -----------------------------------------------------------------------------

    def apply(self, env: Envelope) -> Receipt:
        """Apply a command exactly once.

        with store.write() as tx:                       # BEGIN IMMEDIATE
            if (prior := tx.outcome(env.id)): return Receipt(prior, duplicate=True)
            try:
                with tx.savepoint(): outcome = self._handle(tx, env)
            except Rejection as r: outcome = Rejected(reason=str(r))
            tx.record(env, outcome, received_at=now())
        return Receipt(outcome, duplicate=False)

        Two concurrent deliveries of one id serialize on BEGIN IMMEDIATE; the second sees the
        first's command_log row. A crash before commit leaves nothing, so the retry applies fresh.
        """
        raise NotImplementedError

    def _handle(self, tx: Writer, env: Envelope) -> Outcome:
        """Exhaustive dispatch. pyright strict fails the build if a Command variant is unhandled."""
        cmd = env.command
        match cmd:
            case LogFood():
                # food = tx.food(cmd.food_id) or reject; resolved = nutrition.resolve(food, cmd.quantity)
                # tx.insert_entries([snapshot of food.per_basis, resolved.amount, label=food.name], ...)
                raise NotImplementedError
            case LogSavedMeal():
                # expand items to entries, each snapshotting its current food
                raise NotImplementedError
            case QuickAdd():
                # entry with basis "portion", amount 1, per_basis = typed values, food_id None
                raise NotImplementedError
            case EditEntry():
                # rescale with the entry's own snapshot: amount = serving_each * count
                raise NotImplementedError
            case DeleteEntry():
                # tx.delete_entry(...) is False when gone: still Applied (converged)
                raise NotImplementedError
            case CopyEntries():
                # copy rows (snapshots) from from_day/from_meal to env.day(cmd.day)/to_meal
                raise NotImplementedError
            case LogText():
                # tx.insert_draft(text, day, meal, body=None)  -> Unparsed; no network here
                raise NotImplementedError
            case ConfirmDraft():
                # matched items: snapshot catalog food; unmatched: portion entries from estimate
                raise NotImplementedError
            case DiscardDraft():
                raise NotImplementedError
            case CreateFood():
                # tx.insert_food(...); optional nested LogFood handled in the same transaction
                raise NotImplementedError
            case EditFood():
                # reject origin "recipe"; replace_food; then for r in tx.recipes_using(id): recompute
                raise NotImplementedError
            case ArchiveFood():
                raise NotImplementedError
            case SaveRecipe():
                # nutrition.recipe_basis(...) -> tx.set_per_basis(recipe food) in this transaction
                raise NotImplementedError
            case SaveSavedMeal():
                raise NotImplementedError
            case LogWeight():
                raise NotImplementedError
            case SetProfile():
                raise NotImplementedError
            case SetGoal():
                raise NotImplementedError
            case LogExercise():
                # kcal = typed, or energy.met_kcal(met, trend weight, minutes); snapshot it
                raise NotImplementedError
            case DeleteExercise():
                raise NotImplementedError
            case AddWater():
                raise NotImplementedError
            case StartFast():
                # reject if fast_state() is Fasting; else start_fast(env.at, target)
                raise NotImplementedError
            case EndFast():
                # end_fast(env.at); no open fast -> Applied no-op
                raise NotImplementedError
            case _:
                assert_never(cmd)

    # --- Health ingest ------------------------------------------------------------------------

    def ingest_health(self, batch: HealthBatch) -> IngestReport:
        """health.plan(batch) then one write transaction of upserts. Safe to repeat forever."""
        raise NotImplementedError

    # --- Acquisitions -------------------------------------------------------------------------

    def resolve_barcode(self, gtin: Gtin) -> BarcodeResolution:
        """Local barcode table, then OFF. A complete OFF product is imported (insert_food with
        ref ("off", gtin)); UNIQUE(origin, external_id) and the gtin primary key make a double
        import converge on the existing row."""
        raise NotImplementedError

    def import_external(self, ref: ExternalRef) -> FoodId | NeedsDetails:
        """Fetch full details for a picked search hit and import it. Idempotent on ref."""
        raise NotImplementedError

    def snap(self, jpeg: bytes, day: date, meal: Meal | None) -> SnapResult:
        """One camera button. Decode a barcode first (local, fast). If none and AI is on, ask
        Claude whether it is a label or a plate and store a Ready draft. Not idempotent: a
        retried snap makes a second draft, which is harmless and expires with the others."""
        raise NotImplementedError

    def ensure_parsed(self, draft_id: DraftId) -> Draft:
        """Parse an Unparsed draft (from a queued LogText) on first view, then return it.
        set_draft_ready is conditional on status, so two concurrent views converge."""
        raise NotImplementedError

    # --- Reads --------------------------------------------------------------------------------

    def day(self, day: date) -> DayView:
        """Entries, totals, goal -> target -> burn -> budget, water, fast, drafts, quick picks.
        One read transaction; all math in nutrition / energy / trend."""
        raise NotImplementedError

    def picks(self, meal: Meal, day: date) -> QuickPicks:
        """Recents and frequents for this meal over 60 days, using each food's last quantity."""
        raise NotImplementedError

    def search(self, query: str, meal: Meal) -> LocalResults:
        raise NotImplementedError

    def search_external(self, query: str) -> list[ExternalHit]:
        """USDA and OFF in parallel threads with a 4 s budget; whatever answered is returned."""
        raise NotImplementedError

    def food(self, food_id: FoodId) -> Food:
        raise NotImplementedError

    def recipe(self, recipe_id: RecipeId) -> Recipe:
        raise NotImplementedError

    def body(self, until: date, days: int) -> BodyView:
        raise NotImplementedError

    def draft(self, draft_id: DraftId) -> Draft:
        raise NotImplementedError
