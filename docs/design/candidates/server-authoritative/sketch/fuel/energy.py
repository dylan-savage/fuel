"""Energy balance: BMR, TDEE, the daily target, exercise burn and the day's budget. Pure.

The double-counting rule for burn lives here and nowhere else (active_burn).
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date

from fuel.model import ActiveBurn, Budget, DailyTarget, Exercise, Goal, HealthDay, Kg, Profile, Totals

KCAL_PER_KG = 7700.0
"""Energy in one kg of body mass change. Used by the goal rate and the adaptive TDEE."""


def age_on(profile: Profile, day: date) -> int:
    raise NotImplementedError


def bmr_mifflin(profile: Profile, weight: Kg, day: date) -> float:
    """Mifflin-St Jeor: 10 kg + 6.25 cm - 5 age + 5 (male) or - 161 (female)."""
    raise NotImplementedError


def daily_target(goal: Goal, profile: Profile, weight: Kg, day: date) -> DailyTarget:
    """Intake target for one day, before burn credit.

    derived: bmr * activity_multiplier + rate_kg_per_week * KCAL_PER_KG / 7.
    override: goal.kcal_override, with bmr and baseline still computed for the burn rule.
    Macros follow goal.macros: percent of kcal at 4/4/9, or fixed grams.
    `weight` is the trend weight on `day` (trend.weight_on), not the last raw weigh-in.
    """
    raise NotImplementedError


def met_kcal(met: float, weight: Kg, minutes: float) -> float:
    """Exercise burn as MET x kg x hours. Snapshotted onto the Exercise at log time."""
    raise NotImplementedError


def active_burn(health: HealthDay | None, exercises: Sequence[Exercise]) -> ActiveBurn:
    """The only double-counting rule.

    Health's Active Energy, when present, already contains any workout the watch saw. So:
    - no Health row for the day yet: every manual exercise counts;
    - Health row present: Health kcal + exercises with tracked_by_health=False.
    Exercises with tracked_by_health=True are reported as ignored, never silently dropped.
    """
    raise NotImplementedError


def budget(target: DailyTarget, burn: ActiveBurn, burn_credit: float, eaten: Totals) -> Budget:
    """Budget = target + burn_credit * max(0, burn.total - target.baseline_active_kcal).

    The multiplier already assumes baseline activity, so only burn beyond it earns food.
    remaining = budget - eaten.kcal, and may be negative.
    """
    raise NotImplementedError
