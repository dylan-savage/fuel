"""Nutrient math. Pure functions over model types; the only place nutrients are scaled or summed.

The client never runs any of this. Every number on every page comes from here, on the mini.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Literal

from fuel.model import (
    BasisUnit,
    Entry,
    Food,
    FoodDraft,
    Frozen,
    NewFood,
    Nutrients,
    Quantity,
    ServingSnapshot,
    Totals,
)


def basis_amount(basis: BasisUnit) -> float:
    """How many basis units the per-basis nutrients describe: 100 for g and ml, 1 for portion."""
    raise NotImplementedError


def scale(per_basis: Nutrients, basis: BasisUnit, amount: float) -> Nutrients:
    """Nutrients for `amount` units of a food whose nutrients are given per basis.

    Optional nutrients stay None when unknown; scaling never invents a zero.
    """
    raise NotImplementedError


class Resolved(Frozen):
    """A Quantity turned into the canonical amount plus what the entry should display."""

    amount: float
    serving: ServingSnapshot | None


def resolve(food: Food, quantity: Quantity) -> Resolved:
    """Turn "2 x serving 7" or "170 (g)" into an amount in the food's basis unit.

    Raises KeyError when serving_id is not one of the food's servings; the service turns that
    into a Rejected outcome because the id came from the client.
    """
    raise NotImplementedError


def entry_nutrients(entry: Entry) -> Nutrients:
    """An entry's nutrients: its snapshot scaled by its amount. Never reads the current food."""
    raise NotImplementedError


def total(items: Iterable[Nutrients]) -> Totals:
    """Sum nutrients. Optional nutrients sum the known values and count the unknown ones."""
    raise NotImplementedError


def recipe_basis(
    ingredients: Iterable[tuple[Food, Quantity]],
    portions: float,
    cooked_weight_g: float | None,
) -> tuple[BasisUnit, Nutrients]:
    """Per-basis nutrients for the Food a recipe owns.

    Without a cooked weight the basis is "portion" (total / portions). With one it is "g"
    (total / cooked_weight_g * 100), so the cooked dish can be logged by weight.
    An optional nutrient is known for the recipe only if every ingredient reports it.
    """
    raise NotImplementedError


def kcal_from_macros(protein_g: float, carbs_g: float, fat_g: float) -> float:
    """Atwater 4/4/9. Fills kcal for imports that report macros but no energy."""
    raise NotImplementedError


class Missing(Frozen):
    kind: Literal["missing"] = "missing"
    fields: tuple[str, ...]


def complete(draft: FoodDraft) -> NewFood | Missing:
    """Promote a draft to a food when name and the core four nutrients are known.

    kcal may be derived from macros. Adds the basis serving ("100 g", "100 ml", "1 portion")
    when the draft has no servings. Never guesses a missing macro.
    """
    raise NotImplementedError
