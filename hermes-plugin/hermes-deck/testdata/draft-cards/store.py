"""Draft storage: one SQLite database per profile under ``plugin-data/draft-cards``.

A *draft* is a thread of *versions*. The agent writes a version every time it
drafts or revises; the user writes one when they edit inside the card. Each
version remembers which *card* shows it (the ``v`` in ``::draft-card{v="…"}``),
so an agent revision opens a new card while a user edit updates the card the
user typed into.

Everything here is plain stdlib and returns plain dicts, so the tool handlers
(agent process) and the backend router (gateway process) share one code path.
"""

from __future__ import annotations

import json
import re
import secrets
import sqlite3
import time
from contextlib import closing
from typing import Any, Callable, Iterable, Optional

PLUGIN_NAME = "draft-cards"

KINDS = ("email", "message")
STATUSES = ("draft", "approved", "sent", "saved", "failed", "discarded")
# Statuses the agent may report back. "approved" is set only by the card's Send
# button (or by the agent when the user approved in plain chat).
AGENT_STATUSES = ("approved", "sent", "saved", "failed", "discarded", "draft")
USER_STATUSES = ("draft", "discarded")

FIELD_LIMITS = {"subject": 300, "body": 20_000, "from": 320, "platform": 40, "note": 280}
MAX_RECIPIENTS = 50
MAX_RECIPIENT_LEN = 320
MAX_VERSIONS = 60

_ID_RE = re.compile(r"^d_[0-9a-f]{8}$")
_SCHEMA = """
CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    status_detail TEXT NOT NULL DEFAULT '',
    status_at REAL NOT NULL DEFAULT 0,
    approved_version INTEGER,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS versions (
    draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    v INTEGER NOT NULL,
    card INTEGER NOT NULL,
    author TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    fields TEXT NOT NULL,
    created_at REAL NOT NULL,
    PRIMARY KEY (draft_id, v)
);
"""


class DraftError(ValueError):
    """A caller-facing problem (bad input, unknown id, wrong state). ``code`` maps to HTTP."""

    def __init__(self, message: str, code: int = 400):
        super().__init__(message)
        self.code = code


def _default_connect() -> sqlite3.Connection:
    from plugins.plugin_storage import plugin_db

    return plugin_db(PLUGIN_NAME, "drafts.db")


class DraftStore:
    """Thin, synchronous repository. Open a store per request; connections are short-lived."""

    def __init__(self, connect: Optional[Callable[[], sqlite3.Connection]] = None, clock: Callable[[], float] = time.time):
        self._connect = connect or _default_connect
        self._clock = clock

    # ------------------------------------------------------------------ helpers
    def _db(self) -> sqlite3.Connection:
        conn = self._connect()
        conn.row_factory = sqlite3.Row
        conn.executescript(_SCHEMA)
        return conn

    @staticmethod
    def valid_id(draft_id: Any) -> bool:
        return isinstance(draft_id, str) and bool(_ID_RE.fullmatch(draft_id))

    def _require(self, conn: sqlite3.Connection, draft_id: Any) -> sqlite3.Row:
        if not self.valid_id(draft_id):
            raise DraftError("draft_id must look like d_1a2b3c4d", 400)
        row = conn.execute("SELECT * FROM drafts WHERE id = ?", (draft_id,)).fetchone()
        if row is None:
            raise DraftError(f"No draft {draft_id}. It may belong to another profile.", 404)
        return row

    @staticmethod
    def _versions(conn: sqlite3.Connection, draft_id: str) -> list[dict]:
        rows = conn.execute(
            "SELECT v, card, author, note, fields, created_at FROM versions WHERE draft_id = ? ORDER BY v", (draft_id,)
        ).fetchall()
        return [
            {
                "v": r["v"],
                "card": r["card"],
                "author": r["author"],
                "note": r["note"],
                "fields": json.loads(r["fields"]),
                "created_at": r["created_at"],
            }
            for r in rows
        ]

    def _record(self, conn: sqlite3.Connection, draft_id: str) -> dict:
        row = self._require(conn, draft_id)
        versions = self._versions(conn, draft_id)
        return {
            "id": row["id"],
            "kind": row["kind"],
            "platform": row["platform"],
            "session_id": row["session_id"],
            "status": row["status"],
            "status_detail": row["status_detail"],
            "status_at": row["status_at"],
            "approved_version": row["approved_version"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "latest_version": versions[-1]["v"] if versions else 0,
            "latest_card": max((v["card"] for v in versions), default=0),
            "versions": versions,
        }

    # ------------------------------------------------------------------ public API
    def get(self, draft_id: str) -> dict:
        with closing(self._db()) as conn:
            return self._record(conn, draft_id)

    def create(self, *, kind: str, fields: dict, platform: str = "", session_id: str = "", note: str = "") -> dict:
        kind = kind if kind in KINDS else "email"
        clean = normalize_fields(fields, kind)
        if not clean["body"].strip():
            raise DraftError("body is required")
        now = self._clock()
        with closing(self._db()) as conn, conn:
            draft_id = self._new_id(conn)
            conn.execute(
                "INSERT INTO drafts (id, kind, platform, session_id, status, created_at, updated_at, status_at)"
                " VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)",
                (draft_id, kind, _clip(platform, "platform"), _clip(session_id, "from"), now, now, now),
            )
            conn.execute(
                "INSERT INTO versions (draft_id, v, card, author, note, fields, created_at) VALUES (?, 1, 1, 'agent', ?, ?, ?)",
                (draft_id, _clip(note, "note"), json.dumps(clean, ensure_ascii=False), now),
            )
            return self._record(conn, draft_id)

    def revise(self, draft_id: str, *, fields: dict, note: str = "", author: str = "agent",
               card: Optional[int] = None, base_version: Optional[int] = None,
               platform: Optional[str] = None) -> dict:
        """Append a version. Omitted fields carry over from the latest version.

        ``author='agent'`` opens a new card (card = previous max card + 1).
        ``author='user'`` keeps the card the user edited in (``card`` is required) and
        must name the ``base_version`` it edited, so a stale card can't overwrite a
        newer agent revision.
        """
        now = self._clock()
        with closing(self._db()) as conn, conn:
            row = self._require(conn, draft_id)
            if row["status"] in ("sent", "saved") and author == "user":
                raise DraftError("This draft was already sent or saved; it can't be edited.", 409)
            versions = self._versions(conn, draft_id)
            if len(versions) >= MAX_VERSIONS:
                raise DraftError(f"A draft keeps at most {MAX_VERSIONS} versions. Start a new draft.", 409)
            latest = versions[-1]
            if author == "user":
                if base_version is None or int(base_version) != latest["v"]:
                    raise DraftError("Hermes revised this draft while you were editing. Your copy is out of date.", 409)
                if card is None or not any(v["card"] == int(card) for v in versions):
                    raise DraftError("Unknown card for this draft.", 400)
                target_card = int(card)
            else:
                author = "agent"
                target_card = max(v["card"] for v in versions) + 1
            merged = {**latest["fields"], **{k: v for k, v in (fields or {}).items() if v is not None}}
            clean = normalize_fields(merged, row["kind"])
            if not clean["body"].strip():
                raise DraftError("body can't be empty")
            if clean == latest["fields"]:
                if author == "user":
                    return self._record(conn, draft_id)  # nothing changed: no new version, no error
                raise DraftError("That revision is identical to the current version.", 409)
            new_v = latest["v"] + 1
            conn.execute(
                "INSERT INTO versions (draft_id, v, card, author, note, fields, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (draft_id, new_v, target_card, author, _clip(note, "note"), json.dumps(clean, ensure_ascii=False), now),
            )
            # Any edit re-opens the draft for approval: an approval was for the old text.
            sets = ["updated_at = ?", "status = 'draft'", "approved_version = NULL", "status_detail = ''", "status_at = ?"]
            params: list[Any] = [now, now]
            if platform is not None:
                sets.append("platform = ?")
                params.append(_clip(platform, "platform"))
            conn.execute(f"UPDATE drafts SET {', '.join(sets)} WHERE id = ?", (*params, draft_id))
            return self._record(conn, draft_id)

    def approve(self, draft_id: str, version: int) -> dict:
        now = self._clock()
        with closing(self._db()) as conn, conn:
            row = self._require(conn, draft_id)
            versions = self._versions(conn, draft_id)
            if int(version) != versions[-1]["v"]:
                raise DraftError("Only the latest version can be approved.", 409)
            if row["status"] not in ("draft", "failed", "approved"):
                raise DraftError(f"This draft is already {row['status']}.", 409)
            conn.execute(
                "UPDATE drafts SET status = 'approved', approved_version = ?, status_detail = '', status_at = ?, updated_at = ? WHERE id = ?",
                (int(version), now, now, draft_id),
            )
            return self._record(conn, draft_id)

    def set_status(self, draft_id: str, status: str, detail: str = "", *, by: str = "agent") -> dict:
        allowed = AGENT_STATUSES if by == "agent" else USER_STATUSES
        if status not in allowed:
            raise DraftError(f"status must be one of: {', '.join(allowed)}")
        now = self._clock()
        with closing(self._db()) as conn, conn:
            row = self._require(conn, draft_id)
            current = row["status"]
            if by == "user" and current in ("sent", "saved"):
                raise DraftError(f"This draft is already {current}.", 409)
            approved = row["approved_version"]
            if status == "approved":
                approved = self._versions(conn, draft_id)[-1]["v"]
            elif status in ("draft", "discarded"):
                approved = None
            conn.execute(
                "UPDATE drafts SET status = ?, status_detail = ?, status_at = ?, updated_at = ?, approved_version = ? WHERE id = ?",
                (status, _clip(detail, "note"), now, now, approved, draft_id),
            )
            return self._record(conn, draft_id)

    def recent(self, limit: int = 20) -> list[dict]:
        with closing(self._db()) as conn:
            ids = [r["id"] for r in conn.execute("SELECT id FROM drafts ORDER BY updated_at DESC LIMIT ?", (max(1, min(limit, 100)),))]
            return [self._record(conn, i) for i in ids]

    def prune(self, keep: int = 500) -> int:
        with closing(self._db()) as conn, conn:
            old = [r["id"] for r in conn.execute("SELECT id FROM drafts ORDER BY updated_at DESC LIMIT -1 OFFSET ?", (keep,))]
            for draft_id in old:
                conn.execute("DELETE FROM versions WHERE draft_id = ?", (draft_id,))
                conn.execute("DELETE FROM drafts WHERE id = ?", (draft_id,))
            return len(old)

    @staticmethod
    def _new_id(conn: sqlite3.Connection) -> str:
        for _ in range(8):
            candidate = f"d_{secrets.token_hex(4)}"
            if conn.execute("SELECT 1 FROM drafts WHERE id = ?", (candidate,)).fetchone() is None:
                return candidate
        raise DraftError("Could not allocate a draft id", 500)


# ---------------------------------------------------------------------- normalisation
def _clip(value: Any, field: str) -> str:
    text = "" if value is None else str(value)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return text[: FIELD_LIMITS.get(field, 320)]


def split_recipients(value: Any) -> list[str]:
    """Accept a list or a comma/semicolon/newline separated string; keep quoted display names intact."""
    if value is None:
        return []
    items: Iterable[Any]
    if isinstance(value, (list, tuple)):
        items = value
    else:
        items = _split_outside_quotes(str(value))
    out: list[str] = []
    seen: set[str] = set()
    for item in items:
        text = " ".join(str(item).split()).strip().strip(",;")
        if not text:
            continue
        text = text[:MAX_RECIPIENT_LEN]
        key = text.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(text)
        if len(out) >= MAX_RECIPIENTS:
            break
    return out


def _split_outside_quotes(text: str) -> list[str]:
    parts, buf, quoted, angle = [], [], False, False
    for ch in text:
        if ch == '"':
            quoted = not quoted
        elif ch == "<":
            angle = True
        elif ch == ">":
            angle = False
        if ch in ",;\n" and not quoted and not angle:
            parts.append("".join(buf))
            buf = []
            continue
        buf.append(ch)
    parts.append("".join(buf))
    return parts


def normalize_fields(fields: dict, kind: str) -> dict:
    fields = fields or {}
    clean = {
        "from": _clip(fields.get("from", ""), "from").strip(),
        "to": split_recipients(fields.get("to")),
        "cc": split_recipients(fields.get("cc")) if kind == "email" else [],
        "bcc": split_recipients(fields.get("bcc")) if kind == "email" else [],
        "subject": " ".join(_clip(fields.get("subject", ""), "subject").split()) if kind == "email" else "",
        "body": _clip(fields.get("body", ""), "body").strip("\n"),
    }
    return clean


def directive(draft_id: str, card: int) -> str:
    return f'::draft-card{{id="{draft_id}" v="{int(card)}"}}'


def plain_text(record: dict, version: Optional[dict] = None) -> str:
    """The draft as readable text for terminals and messaging surfaces."""
    version = version or record["versions"][-1]
    f = version["fields"]
    label = record.get("platform") or ("Email" if record["kind"] == "email" else "Message")
    lines = [f"{label} draft (v{version['v']})"]
    if f.get("subject"):
        lines.append(f"Subject: {f['subject']}")
    if f.get("from"):
        lines.append(f"From: {f['from']}")
    if f.get("to"):
        lines.append(f"To: {', '.join(f['to'])}")
    if f.get("cc"):
        lines.append(f"Cc: {', '.join(f['cc'])}")
    if f.get("bcc"):
        lines.append(f"Bcc: {', '.join(f['bcc'])}")
    lines.append("")
    lines.append(f.get("body", ""))
    return "\n".join(lines)
