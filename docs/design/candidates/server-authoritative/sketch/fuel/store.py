"""SQLite persistence. The only module that knows SQL, table names, or column layout.

Rows are external data: every read parses a row into a model type here (pydantic validates),
so nothing above this module sees sqlite3.Row or column names.

Concurrency: one process (uvicorn, one worker), sync handlers on a threadpool, one connection
per thread. WAL lets reads run during a write. Writes use BEGIN IMMEDIATE and busy_timeout, so
the PWA and the Shortcut serialize on SQLite's lock. Invariant kept by the service: no
network I/O ever happens inside a write transaction.
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from datetime import date, datetime
from pathlib import Path

from fuel.commands import Envelope, Outcome
from fuel.health import MetricUpsert
from fuel.model import (
    Draft,
    DraftBody,
    DraftId,
    Entry,
    EntryId,
    Exercise,
    ExerciseId,
    ExternalRef,
    FastState,
    Food,
    FoodId,
    Frozen,
    Goal,
    Gtin,
    HealthDay,
    Meal,
    NewFood,
    Nutrients,
    Profile,
    Recipe,
    RecipeId,
    SavedMeal,
    SavedMealId,
    WeighIn,
)


class FoodHit(Frozen):
    food: Food
    rank: float


class FoodUsage(Frozen):
    """Derived from entries, never stored as counters."""

    food_id: FoodId
    meal: Meal
    uses: int
    last_used: date
    last_serving_id: int | None
    last_count: float


class NewEntry(Frozen):
    """Everything an entry row needs except its id and position."""

    day: date
    meal: Meal
    label: str
    food_id: FoodId | None
    origin: str
    basis: str
    per_basis: Nutrients
    amount: float
    serving_label: str | None
    serving_each: float | None
    serving_count: float | None


class Store:
    """Owns the database file, its migrations and its connections."""

    @classmethod
    def open(cls, path: Path) -> Store:
        """Open (creating if needed), set pragmas, apply pending migrations by user_version.

        Idempotent: opening a current database applies nothing.
        """
        raise NotImplementedError

    @contextmanager
    def read(self) -> Iterator[Reader]:
        raise NotImplementedError

    @contextmanager
    def write(self) -> Iterator[Writer]:
        """BEGIN IMMEDIATE; commit on normal exit, roll back on any exception."""
        raise NotImplementedError

    def backup(self, dest: Path) -> None:
        """VACUUM INTO dest via a temp name then rename, so a crashed backup never looks complete."""
        raise NotImplementedError


class Reader:
    # commands
    def outcome(self, command_id: str) -> Outcome | None:
        raise NotImplementedError

    # catalog
    def food(self, food_id: FoodId) -> Food | None:
        raise NotImplementedError

    def foods(self, ids: Sequence[FoodId]) -> dict[FoodId, Food]:
        raise NotImplementedError

    def food_by_gtin(self, gtin: Gtin) -> FoodId | None:
        raise NotImplementedError

    def food_by_ref(self, ref: ExternalRef) -> FoodId | None:
        raise NotImplementedError

    def search_foods(self, query: str, limit: int) -> list[FoodHit]:
        """FTS5 prefix match on name and brand, archived foods excluded."""
        raise NotImplementedError

    def usage(self, since: date) -> list[FoodUsage]:
        """Per food and meal: use count, last day, last quantity. One GROUP BY over entry."""
        raise NotImplementedError

    def recipe(self, recipe_id: RecipeId) -> Recipe | None:
        raise NotImplementedError

    def recipes_using(self, food_id: FoodId) -> list[Recipe]:
        raise NotImplementedError

    def saved_meal(self, saved_meal_id: SavedMealId) -> SavedMeal | None:
        raise NotImplementedError

    def saved_meals(self) -> list[SavedMeal]:
        raise NotImplementedError

    # diary
    def entries(self, day: date) -> list[Entry]:
        raise NotImplementedError

    def entry(self, entry_id: EntryId) -> Entry | None:
        raise NotImplementedError

    def intake_by_day(self, since: date, until: date) -> list[tuple[date, float]]:
        """Daily kcal for days with at least one entry. Feeds the adaptive TDEE."""
        raise NotImplementedError

    def draft(self, draft_id: DraftId) -> Draft | None:
        raise NotImplementedError

    def open_draft_count(self) -> int:
        raise NotImplementedError

    # goals and body
    def profile(self) -> Profile | None:
        raise NotImplementedError

    def goal_on(self, day: date) -> Goal | None:
        raise NotImplementedError

    def weigh_ins(self, since: date, until: date) -> list[WeighIn]:
        """Both sources, unmerged. trend.merge_sources decides precedence."""
        raise NotImplementedError

    def health_day(self, day: date) -> HealthDay | None:
        raise NotImplementedError

    def exercises(self, day: date) -> list[Exercise]:
        raise NotImplementedError

    def activity_met(self, key: str) -> tuple[str, float] | None:
        raise NotImplementedError

    # habits
    def water_ml(self, day: date) -> float:
        raise NotImplementedError

    def fast_state(self) -> FastState:
        raise NotImplementedError


class Writer(Reader):
    """Reads plus writes inside one transaction. Obtained only from Store.write()."""

    def record(self, env: Envelope, outcome: Outcome, received_at: datetime) -> None:
        """Insert the command_log row. Same transaction as the effects, so both or neither land."""
        raise NotImplementedError

    @contextmanager
    def savepoint(self) -> Iterator[None]:
        """Undo a handler's partial writes on Rejection while keeping the transaction for record()."""
        raise NotImplementedError

    # catalog
    def insert_food(self, food: NewFood) -> FoodId:
        """Food, its servings, its barcodes, default serving. FTS follows via triggers."""
        raise NotImplementedError

    def replace_food(self, food_id: FoodId, food: NewFood) -> None:
        raise NotImplementedError

    def set_per_basis(self, food_id: FoodId, basis: str, per_basis: Nutrients) -> None:
        """Only the recipe path calls this."""
        raise NotImplementedError

    def archive_food(self, food_id: FoodId, at: datetime) -> None:
        raise NotImplementedError

    def save_recipe(self, recipe_id: RecipeId | None, food_id: FoodId, recipe: Recipe) -> RecipeId:
        raise NotImplementedError

    def save_saved_meal(self, saved_meal_id: SavedMealId | None, meal: SavedMeal) -> SavedMealId:
        raise NotImplementedError

    # diary
    def insert_entries(self, entries: Sequence[NewEntry], command_id: str, at: datetime) -> list[EntryId]:
        """Appends at the end of each meal (position = max + 1)."""
        raise NotImplementedError

    def update_entry(self, entry_id: EntryId, amount: float, serving_count: float | None, meal: Meal) -> None:
        raise NotImplementedError

    def delete_entry(self, entry_id: EntryId) -> bool:
        """False when already gone; the service treats that as converged."""
        raise NotImplementedError

    def insert_draft(self, text: str | None, day: date, meal: Meal | None, body: DraftBody | None) -> DraftId:
        raise NotImplementedError

    def set_draft_ready(self, draft_id: DraftId, body: DraftBody) -> bool:
        """UPDATE ... WHERE status='unparsed'. False when another parse got there first."""
        raise NotImplementedError

    def set_draft_failed(self, draft_id: DraftId, reason: str) -> None:
        raise NotImplementedError

    def close_draft(self, draft_id: DraftId, status: str) -> None:
        raise NotImplementedError

    # goals and body
    def set_profile(self, profile: Profile) -> None:
        raise NotImplementedError

    def set_goal(self, goal: Goal) -> None:
        """Upsert by effective_from."""
        raise NotImplementedError

    def upsert_weigh_in(self, weigh_in: WeighIn) -> bool:
        """Manual: replace the (day, 'manual') row. Health: keep the earlier measured_at."""
        raise NotImplementedError

    def upsert_metric(self, upsert: MetricUpsert, received_at: datetime) -> bool:
        """Latest observed_at wins (see the ON CONFLICT ... WHERE in the migration). False if stale."""
        raise NotImplementedError

    def insert_exercise(self, exercise: Exercise, command_id: str, at: datetime) -> ExerciseId:
        raise NotImplementedError

    def delete_exercise(self, exercise_id: ExerciseId) -> bool:
        raise NotImplementedError

    # habits
    def insert_water(self, day: date, ml: float, command_id: str, at: datetime) -> None:
        raise NotImplementedError

    def start_fast(self, at: datetime, target_hours: float) -> None:
        """The one_open_fast index makes a second open fast impossible even if a check is missed."""
        raise NotImplementedError

    def end_fast(self, at: datetime) -> bool:
        raise NotImplementedError
