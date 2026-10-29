"""Weight trend (Hacker's Diet EMA), rate, goal projection and adaptive TDEE. Pure, derived on read.

Nothing here is stored. Adding or correcting a weigh-in changes every later point, by design.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date

from fuel.model import BodyView, Kg, TdeeEstimate, TrendPoint, WeighIn

SMOOTHING = 0.1


def merge_sources(weigh_ins: Sequence[WeighIn]) -> list[WeighIn]:
    """One weigh-in per day. A manual weigh-in beats the Health one on the same day.

    This is the read-boundary merge for the two writers (PWA and Shortcut), which never share rows.
    """
    raise NotImplementedError


def series(weigh_ins: Sequence[WeighIn], until: date) -> list[TrendPoint]:
    """Daily trend from the first weigh-in through `until`.

    Gaps between weigh-ins are linearly interpolated before smoothing. After the last weigh-in the
    trend carries flat. trend[0] = first weight; trend[d] = trend[d-1] + SMOOTHING * (w[d] - trend[d-1]).
    """
    raise NotImplementedError


def weight_on(points: Sequence[TrendPoint], day: date) -> Kg | None:
    """Trend weight for a day, the weight energy.daily_target uses."""
    raise NotImplementedError


def weekly_rate(points: Sequence[TrendPoint], day: date) -> float | None:
    """trend(day) - trend(day - 7), kg per week. None with under 8 days of trend."""
    raise NotImplementedError


def projected_goal_date(points: Sequence[TrendPoint], goal_kg: Kg, day: date) -> date | None:
    """When the trend reaches goal_kg at the current weekly rate. None if moving away or flat."""
    raise NotImplementedError


def adaptive_tdee(
    intake_by_day: Sequence[tuple[date, float]],
    points: Sequence[TrendPoint],
    until: date,
    rate_kg_per_week: float,
    window_days: int = 28,
) -> TdeeEstimate | None:
    """MacroFactor-style estimate: avg intake - trend change * KCAL_PER_KG / window.

    Only days present in intake_by_day count as logged. None when under 3/4 of the window is
    logged. The suggestion is display only; accepting it is a SetGoal command with kcal_override.
    """
    raise NotImplementedError


def body_view(
    weigh_ins: Sequence[WeighIn],
    intake_by_day: Sequence[tuple[date, float]],
    until: date,
    goal_kg: Kg | None,
    rate_kg_per_week: float,
) -> BodyView:
    raise NotImplementedError
