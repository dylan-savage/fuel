"""Open Food Facts adapter. Returns domain FoodDraft / ExternalHit; raw OFF JSON never escapes.

Parse rules (checked against live responses on 2026-10-28 for 5449000000996, 0016000275287,
3017620422003):
- `nutriments.<key>_100g` is per 100 g OR per 100 ml. Coca-Cola reports `_100g` keys while
  `serving_quantity_unit` and `product_quantity_unit` are "ml". Basis = "ml" when either unit
  field says ml, else "g".
- `sodium_100g` is in grams; multiply by 1000 for sodium_mg. Fall back to salt_100g / 2.5.
- `energy-kcal_100g` may be missing; use `energy-kj_100g` / 4.184, then Atwater (nutrition.complete).
- `serving_quantity` (number) + `serving_size` (label) give one named serving when both exist.
  Nutella has neither, so the food gets only its basis serving.
- 12-digit UPC-A codes resolve when padded to 13 digits (0016000275287 returned Cheerios).
"""

from __future__ import annotations

from collections.abc import Mapping

import httpx

from fuel.model import ExternalHit, FoodDraft, Gtin

USER_AGENT = "fuel/0.1 (personal tracker; dylan.savage)"


class OpenFoodFacts:
    """Sync client. Product lookups are cached in-process for 10 minutes so the scan ->
    create-food form round trip does not refetch."""

    def __init__(self, http: httpx.Client) -> None:
        raise NotImplementedError

    def product(self, gtin: Gtin) -> FoodDraft | None:
        """GET /api/v2/product/{gtin}.json. None when status == 0 (not found).

        Raises SourceUnavailable on timeout or 5xx so the service can tell "not in OFF" from
        "OFF is down".
        """
        raise NotImplementedError

    def search(self, query: str, limit: int = 10) -> list[ExternalHit]:
        raise NotImplementedError


def parse_product(gtin: Gtin, product: Mapping[str, object]) -> FoodDraft:
    """Pure: OFF `product` object to FoodDraft per the rules above. Unit-tested on recorded JSON."""
    raise NotImplementedError


class SourceUnavailable(Exception):
    """The external service could not answer. Distinct from a definite "not found"."""
