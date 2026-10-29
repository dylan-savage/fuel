"""USDA FoodData Central adapter, for generic foods ("banana", "chicken breast").

Details to verify at implementation time: search via POST /fdc/v1/foods/search with dataType
Foundation and SR Legacy first; details via GET /fdc/v1/food/{fdcId}; nutrient numbers
1008 kcal, 1003 protein, 1005 carbs, 1004 fat, 1079 fiber, 2000 sugars, 1093 sodium (mg);
`foodPortions[].gramWeight` with a description become named servings. Values are per 100 g.
"""

from __future__ import annotations

from collections.abc import Mapping

import httpx

from fuel.model import ExternalHit, FoodDraft


class Usda:
    def __init__(self, http: httpx.Client, api_key: str) -> None:
        """`api_key` from .env (USDA_API_KEY); DEMO_KEY works at low rate limits."""
        raise NotImplementedError

    def search(self, query: str, limit: int = 10) -> list[ExternalHit]:
        raise NotImplementedError

    def food(self, fdc_id: str) -> FoodDraft:
        raise NotImplementedError


def parse_food(food: Mapping[str, object]) -> FoodDraft:
    """Pure: FDC food detail to FoodDraft with basis "g" and its portions as servings."""
    raise NotImplementedError
