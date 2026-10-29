"""Unit conversion at the edges. Pure.

Canonical inside the system: kg, cm, g, ml, kcal, mg sodium. Forms parse into these; templates
format out of them using Profile.display_units. Nothing between the edges converts.
"""

from __future__ import annotations

from typing import Literal

from fuel.model import Kg

MassUnit = Literal["kg", "lb"]
VolumeUnit = Literal["ml", "floz"]


def to_kg(value: float, unit: MassUnit) -> Kg:
    raise NotImplementedError


def from_kg(kg: Kg, unit: MassUnit) -> float:
    raise NotImplementedError


def to_ml(value: float, unit: VolumeUnit) -> float:
    raise NotImplementedError


def food_amount(value: float, unit: Literal["g", "oz", "ml", "floz", "portion"]) -> float:
    """Parse a typed food amount into grams, ml or portions. oz -> g and fl oz -> ml only."""
    raise NotImplementedError
