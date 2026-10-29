"""Apple Health ingest contract: what the iOS Shortcut POSTs to /ingest/health.

The Shortcut is a second writer. It owns two kinds of rows and nothing else:
health_day (per day and metric) and weigh_in rows with source="health". The PWA never writes
those rows and the Shortcut never writes anything the PWA owns, so the two never race.

Idempotency rule, chosen so the Shortcut can be dumb and run as often as it likes:
- Metrics are day totals ("Active Energy since midnight"), not increments. For each
  (day, metric) the row with the latest `observed_at` wins; an older observation is ignored.
  Resending is a no-op, out-of-order delivery cannot regress a value, and a missed run heals
  on the next one. Sending today and yesterday on every run catches late watch syncs.
- Weights are raw samples. Per day the earliest sample is kept (the morning weigh-in).

Example body:

    {
      "observed_at": "2026-10-28T21:00:04-04:00",
      "days": [
        {"date": "2026-10-28", "active_kcal": 512.3, "steps": 9120},
        {"date": "2026-10-27", "active_kcal": 688.0, "steps": 11402}
      ],
      "weights": [{"at": "2026-10-28T07:02:11-04:00", "value": 179.4, "unit": "lb"}]
    }

Response: IngestReport as JSON. 422 with pydantic's error list for a malformed body.
"""

from __future__ import annotations

from datetime import date
from typing import Annotated, Literal

from pydantic import AwareDatetime, Field, model_validator

from fuel.model import Frozen, WeighIn
from fuel.units import MassUnit


class HealthDayIn(Frozen):
    date: date
    active_kcal: Annotated[float, Field(ge=0, le=10000)] | None = None
    steps: Annotated[int, Field(ge=0, le=200000)] | None = None


class WeightSampleIn(Frozen):
    at: AwareDatetime
    value: Annotated[float, Field(gt=0)]
    unit: MassUnit


class HealthBatch(Frozen):
    """The whole POST body."""

    observed_at: AwareDatetime
    days: Annotated[tuple[HealthDayIn, ...], Field(max_length=14)] = ()
    weights: Annotated[tuple[WeightSampleIn, ...], Field(max_length=200)] = ()

    @model_validator(mode="after")
    def _one_row_per_date(self) -> HealthBatch:
        """Reject a batch listing a date twice: one observation cannot hold two totals."""
        raise NotImplementedError


class MetricUpsert(Frozen):
    day: date
    metric: Literal["active_kcal", "steps"]
    value: float
    observed_at: AwareDatetime


class IngestPlan(Frozen):
    metrics: tuple[MetricUpsert, ...]
    weigh_ins: tuple[WeighIn, ...]


class IngestReport(Frozen):
    metrics_applied: int
    metrics_stale: int
    weights_applied: int


def plan(batch: HealthBatch, tz: str) -> IngestPlan:
    """Pure: flatten the batch into upserts. Weight samples become kg, keyed by local day in `tz`,
    earliest sample per day. The store applies the latest-observed-wins comparison in SQL."""
    raise NotImplementedError
