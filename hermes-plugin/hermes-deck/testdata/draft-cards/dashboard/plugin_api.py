"""Backend routes for the Draft Cards desktop half, mounted at ``/api/plugins/draft-cards/``.

The desktop card reads a draft, saves the user's inline edits as a new version,
records approval when the user presses Send, and discards or restores a draft.
It never sends anything: sending is the agent's job, with the user's own tools.
"""

# No ``from __future__ import annotations`` here: the pydantic request models must
# resolve their field types however this file is imported.
import importlib.util
import logging
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


def _load_store_module():
    """Load the sibling ``store.py`` by path: this file is imported standalone, not as a package."""
    path = Path(__file__).resolve().parent.parent / "store.py"
    spec = importlib.util.spec_from_file_location("draft_cards_store_api", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"draft-cards: cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_store = _load_store_module()
router = APIRouter()


class EditBody(BaseModel):
    base_version: int
    card: int
    fields: dict[str, Any] = Field(default_factory=dict)


class ApproveBody(BaseModel):
    version: int


class StateBody(BaseModel):
    status: str
    detail: Optional[str] = ""


def _call(fn, *args, **kwargs) -> dict:
    try:
        return fn(*args, **kwargs)
    except _store.DraftError as exc:
        raise HTTPException(status_code=exc.code, detail=str(exc)) from exc


def _notify(draft_id: str) -> None:
    try:
        from hermes_cli.plugin_events import broadcast_plugin_event

        broadcast_plugin_event("draft-cards", "draft.updated", {"id": draft_id})
    except Exception as exc:  # noqa: BLE001 - polling covers a missed event
        logger.debug("draft-cards: event broadcast skipped: %s", exc)


_EDITABLE = ("from", "to", "cc", "bcc", "subject", "body")


@router.get("/health")
def health() -> dict:
    return {"ok": True, "plugin": "draft-cards"}


@router.get("/drafts/{draft_id}")
def get_draft(draft_id: str) -> dict:
    return _call(_store.DraftStore().get, draft_id)


@router.post("/drafts/{draft_id}/edit")
def edit_draft(draft_id: str, body: EditBody) -> dict:
    fields = {k: v for k, v in body.fields.items() if k in _EDITABLE}
    record = _call(
        _store.DraftStore().revise,
        draft_id,
        fields=fields,
        author="user",
        card=body.card,
        base_version=body.base_version,
        note="Edited by you",
    )
    _notify(draft_id)
    return record


@router.post("/drafts/{draft_id}/approve")
def approve_draft(draft_id: str, body: ApproveBody) -> dict:
    record = _call(_store.DraftStore().approve, draft_id, body.version)
    _notify(draft_id)
    return record


@router.post("/drafts/{draft_id}/state")
def set_state(draft_id: str, body: StateBody) -> dict:
    record = _call(_store.DraftStore().set_status, draft_id, body.status, body.detail or "", by="user")
    _notify(draft_id)
    return record
