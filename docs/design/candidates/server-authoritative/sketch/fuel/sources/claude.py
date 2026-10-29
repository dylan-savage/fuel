"""Anthropic adapter for AI quick log. The API key lives in the mini's .env (via tokenstash) and
is read only here. It is never rendered into a page or sent to the phone.

The model id is config (FUEL_ANTHROPIC_MODEL), picked at implementation time from the current
vision-capable models; nothing hardcodes one. Each call forces a single tool whose input schema
is the JSON schema of a pydantic model below, then validates the tool input with that model. A
reading that fails validation becomes ParseFailed, never a half-filled draft.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Literal

from fuel.model import FoodDraft, FoodId, Frozen, Meal, Nutrients


class CatalogHint(Frozen):
    """A food Claude may match against, so "my usual oatmeal" resolves to the real food.
    The service validates every returned food_id against the store before trusting it."""

    food_id: FoodId
    name: str
    default_serving: str


class ReadItem(Frozen):
    label: str
    food_id: FoodId | None
    servings: float | None
    grams: float | None
    estimate: Nutrients


class MealText(Frozen):
    kind: Literal["meal"] = "meal"
    items: tuple[ReadItem, ...]


class LabelText(Frozen):
    kind: Literal["label"] = "label"
    food: FoodDraft


class Unreadable(Frozen):
    kind: Literal["unreadable"] = "unreadable"
    reason: str


class Claude:
    def __init__(self, api_key: str, model: str) -> None:
        raise NotImplementedError

    def read_text(self, text: str, meal: Meal | None, catalog: Sequence[CatalogHint]) -> MealText | Unreadable:
        """Free text ("2 eggs and toast with butter") to items with nutrient estimates."""
        raise NotImplementedError

    def read_photo(
        self, jpeg: bytes, meal: Meal | None, catalog: Sequence[CatalogHint]
    ) -> MealText | LabelText | Unreadable:
        """A nutrition label becomes a FoodDraft (per serving, with the serving's grams when the
        label states them). A plate becomes items. One call decides which it is."""
        raise NotImplementedError
