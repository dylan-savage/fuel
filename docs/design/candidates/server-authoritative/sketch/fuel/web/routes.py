"""HTTP surface. Thin: parse the request into a domain type, call Fuel, render the result.

Pages are full HTML (Jinja2, StrictUndefined) rendered from model read types; <body hx-boost>
makes navigation feel like an app. Fragments exist only where htmx swaps part of a page.
Templates receive model types only, and tests/test_templates.py renders every template with
fixture models so a renamed field fails the build instead of rendering blank.

Every write the PWA makes goes to POST /commands. The service worker queues that one URL
when the mini is unreachable and replays it later (see static/sw.js).

Auth: none in the app. The tailnet is the perimeter; uvicorn binds 127.0.0.1 and only
`tailscale serve` reaches it.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response

from fuel.commands import Envelope, Receipt
from fuel.health import HealthBatch, IngestReport
from fuel.model import FoodId, Meal, RecipeId, DraftId
from fuel.service import Fuel

router = APIRouter()


def fuel_dep(request: Request) -> Fuel:
    """The app-wide Fuel instance built at startup from Config."""
    raise NotImplementedError


FuelDep = Annotated[Fuel, Depends(fuel_dep)]


# --- Boundary helpers -------------------------------------------------------------------------


def unflatten(form: Mapping[str, str]) -> dict[str, object]:
    """Form fields to nested data: "quantity.count" -> {"quantity": {"count": ...}},
    "items.0.food_id" -> {"items": [{"food_id": ...}]}. Pure; the only form convention."""
    raise NotImplementedError


async def parse_envelope(request: Request, fuel: Fuel) -> Envelope:
    """Form or JSON body to Envelope. Fills id/at/tz when a no-JS form omitted them.
    Raises RequestValidationError (422) for anything pydantic rejects."""
    raise NotImplementedError


def respond(request: Request, receipt: Receipt, return_to: str | None) -> Response:
    """One outcome, three renderings, chosen by the request:

    Accept: application/json (service worker replay)
        200 {"status": "applied"|"rejected", "duplicate": bool, "reason": str|null, "day": str|null}
        Rejected uses 409 so the worker can tell "server said no" from "server unreachable".
    HX-Request (htmx, online)
        Applied with a day: 200 re-rendered #day panel. Applied with `created`: HX-Redirect to it.
        Rejected: 409 with a toast fragment.
    Neither (plain form)
        303 to return_to (same-origin path only) or to the created resource.
    """
    raise NotImplementedError


# --- Pages ------------------------------------------------------------------------------------


@router.get("/", response_class=HTMLResponse)
def today(request: Request, fuel: FuelDep) -> HTMLResponse:
    """The diary for today plus quick picks per meal, quick add, water and fast controls.
    The service worker caches the latest copy; it is the offline page."""
    raise NotImplementedError


@router.get("/day/{day}", response_class=HTMLResponse)
def day_page(request: Request, day: date, fuel: FuelDep) -> HTMLResponse:
    """Same panel for an explicit date. Its forms always send `day`."""
    raise NotImplementedError


@router.get("/add", response_class=HTMLResponse)
def add_page(request: Request, meal: Meal, fuel: FuelDep, day: date | None = None) -> HTMLResponse:
    """Search box, quick picks for the meal, camera button, barcode digits field."""
    raise NotImplementedError


@router.get("/search", response_class=HTMLResponse)
def search(request: Request, q: str, meal: Meal, fuel: FuelDep, day: date | None = None) -> HTMLResponse:
    """Fragment: local results. Includes a placeholder that loads /search/external (hx-trigger=load)."""
    raise NotImplementedError


@router.get("/search/external", response_class=HTMLResponse)
def search_external(request: Request, q: str, meal: Meal, fuel: FuelDep, day: date | None = None) -> HTMLResponse:
    """Fragment: USDA and OFF hits, each a form posting to /foods/import."""
    raise NotImplementedError


@router.get("/food/new", response_class=HTMLResponse)
def new_food_page(request: Request, fuel: FuelDep, gtin: str | None = None, draft: DraftId | None = None) -> HTMLResponse:
    """Create-food form, prefilled from OFF (gtin) or an AI label reading (draft). Posts CreateFood.
    Declared before /food/{food_id}: FastAPI matches in order and "new" is not an int."""
    raise NotImplementedError


@router.get("/food/{food_id}", response_class=HTMLResponse)
def food_page(
    request: Request, food_id: FoodId, fuel: FuelDep,
    meal: Meal | None = None, day: date | None = None, entry: int | None = None,
) -> HTMLResponse:
    """Nutrients per serving, serving picker and count, with a server-rendered preview fragment
    (GET /food/{id}/preview?serving_id&count) so even the "what would 1.5 servings be" number
    comes from the mini. Posts LogFood, or EditEntry when `entry` is set."""
    raise NotImplementedError


@router.get("/food/{food_id}/preview", response_class=HTMLResponse)
def food_preview(request: Request, food_id: FoodId, count: float, fuel: FuelDep, serving_id: int | None = None) -> HTMLResponse:
    raise NotImplementedError


@router.get("/recipes", response_class=HTMLResponse)
def recipes_page(request: Request, fuel: FuelDep) -> HTMLResponse:
    raise NotImplementedError


@router.get("/recipes/{recipe_id}", response_class=HTMLResponse)
def recipe_page(request: Request, recipe_id: RecipeId, fuel: FuelDep) -> HTMLResponse:
    """Editor. Ingredient rows are server-rendered fragments added via htmx. Posts SaveRecipe."""
    raise NotImplementedError


@router.get("/meals", response_class=HTMLResponse)
def saved_meals_page(request: Request, fuel: FuelDep) -> HTMLResponse:
    raise NotImplementedError


@router.get("/body", response_class=HTMLResponse)
def body_page(request: Request, fuel: FuelDep, days: int = 90) -> HTMLResponse:
    """Weigh-in form, trend chart as server-rendered inline SVG, weekly rate, goal date,
    adaptive TDEE suggestion with an "use this target" SetGoal button."""
    raise NotImplementedError


@router.get("/goals", response_class=HTMLResponse)
def goals_page(request: Request, fuel: FuelDep) -> HTMLResponse:
    raise NotImplementedError


@router.get("/goals/preview", response_class=HTMLResponse)
def goals_preview(request: Request, fuel: FuelDep) -> HTMLResponse:
    """Fragment: BMR, TDEE, target and macro grams for the unsaved form values (hx-trigger=change)."""
    raise NotImplementedError


@router.get("/drafts/{draft_id}", response_class=HTMLResponse)
def draft_page(request: Request, draft_id: DraftId, fuel: FuelDep) -> HTMLResponse:
    """Review screen. Calls fuel.ensure_parsed, so a queued LogText parses here on first view."""
    raise NotImplementedError


@router.get("/fast", response_class=HTMLResponse)
def fast_page(request: Request, fuel: FuelDep) -> HTMLResponse:
    """Timer (started_at rendered; fuel.js only ticks the display) and history."""
    raise NotImplementedError


# --- Writes -----------------------------------------------------------------------------------


@router.post("/commands")
async def post_command(request: Request, fuel: FuelDep) -> Response:
    """The single write endpoint for the PWA. Request: Envelope as form fields or JSON."""
    env = await parse_envelope(request, fuel)
    receipt = fuel.apply(env)
    return respond(request, receipt, return_to=request.query_params.get("return_to"))


@router.post("/barcode")
def post_barcode(
    request: Request, fuel: FuelDep, gtin: Annotated[str, Form()],
    meal: Annotated[Meal | None, Form()] = None, day: Annotated[date | None, Form()] = None,
) -> RedirectResponse:
    """Typed digits. 303 to /food/{id}, or /food/new?gtin= when unknown or incomplete."""
    raise NotImplementedError


@router.post("/snap")
async def post_snap(
    request: Request, fuel: FuelDep, image: Annotated[UploadFile, File()],
    meal: Annotated[Meal | None, Form()] = None, day: Annotated[date | None, Form()] = None,
) -> Response:
    """Multipart JPEG (fuel.js downscales to 1600 px, about 300 KB; hard cap 4 MB).
    303 to /food/{id}, /food/new?gtin=, or /drafts/{id}. 422 fragment when nothing was readable."""
    raise NotImplementedError


@router.post("/foods/import")
def post_import(
    request: Request, fuel: FuelDep,
    origin: Annotated[Literal["off", "usda"], Form()], external_id: Annotated[str, Form()],
    meal: Annotated[Meal | None, Form()] = None, day: Annotated[date | None, Form()] = None,
) -> RedirectResponse:
    """Import a picked external hit. 303 to /food/{id} or the prefilled create form."""
    raise NotImplementedError


@router.post("/ingest/health")
def ingest_health(batch: HealthBatch, fuel: FuelDep) -> IngestReport:
    """The iOS Shortcut's endpoint. JSON in, JSON out. See fuel/health.py for the contract."""
    return fuel.ingest_health(batch)


# --- Shell ------------------------------------------------------------------------------------


@router.get("/sw.js")
def service_worker(request: Request) -> Response:
    """static/sw.js with SHELL_VERSION and SHELL_ASSETS injected from the hashed static dir at
    startup, so the precache list is derived, never hand-maintained. Cache-Control: no-cache."""
    raise NotImplementedError


@router.get("/manifest.webmanifest")
def manifest() -> JSONResponse:
    raise NotImplementedError


@router.get("/healthz")
def healthz(fuel: FuelDep) -> JSONResponse:
    """{"ok": true, "db": "ok"}. fuel.js pings it to decide whether to show the offline banner."""
    raise NotImplementedError
