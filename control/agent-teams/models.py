"""SQLAlchemy models for user tool management."""

import logging
from datetime import datetime, timezone
from os import getenv
from typing import Any, Dict, Optional

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Integer,
    JSON,
    String,
    UniqueConstraint,
    create_engine,
    func,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Session

# Same default as db.py – read from the shared DATABASE_URL environment variable
db_url: str = getenv("DATABASE_URL", "postgresql+psycopg://ai:ai@localhost:5532/ai")

_engine = None


def get_engine():
    global _engine
    if _engine is None:
        _engine = create_engine(db_url)
    return _engine


class Base(DeclarativeBase):
    pass


class UserTool(Base):
    """
    Stores which optional tools are enabled per user, along with their parameters.

    Columns
    -------
    id        : Auto-increment primary key.
    user_id   : Matches the JWT ``user_id`` claim.
    tool_name : Identifier from the tools registry (e.g. ``"github"``).
    enabled   : Whether the tool is currently active for this user.
    params    : JSON object with tool-specific parameters (e.g. ``api_key``).
                Sensitive values (API keys, tokens) are stored here.
    created_at / updated_at : Audit timestamps (UTC).
    """

    __tablename__ = "user_tools"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String(255), nullable=False, index=True)
    tool_name = Column(String(100), nullable=False)
    enabled = Column(Boolean, nullable=False, default=True)
    params = Column(JSON, nullable=False, default=dict)
    created_at = Column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at = Column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    __table_args__ = (
        UniqueConstraint("user_id", "tool_name", name="uq_user_tool"),
    )


def init_db() -> None:
    """Create all tables that do not yet exist (idempotent)."""
    engine = get_engine()
    Base.metadata.create_all(engine)
    _migrate_approvals_table(engine)


def _migrate_approvals_table(engine) -> None:
    """Add missing columns to ai.agno_approvals when the table already exists.

    The agno library added ``run_status`` to its APPROVAL_TABLE_SCHEMA. Databases
    that were initialised with an older version of agno won't have this column and
    will fail the schema-validation check on startup.  This migration is idempotent:
    ``ADD COLUMN IF NOT EXISTS`` is a no-op when the column is already present, and
    ``ALTER TABLE IF EXISTS`` is a no-op when the table has not been created yet.
    """
    logger = logging.getLogger(__name__)
    try:
        with engine.connect() as conn:
            conn.execute(
                text(
                    "ALTER TABLE IF EXISTS ai.agno_approvals"
                    " ADD COLUMN IF NOT EXISTS run_status VARCHAR NULL"
                )
            )
            conn.commit()
        logger.debug("Migration complete: ai.agno_approvals.run_status ensured")
    except Exception as exc:
        logger.warning("Could not migrate ai.agno_approvals: %s", exc)


# ---------------------------------------------------------------------------
# UserTool helpers
# ---------------------------------------------------------------------------


def get_user_tool(user_id: str, tool_name: str) -> Optional[UserTool]:
    """Return the UserTool record for *user_id* / *tool_name*, or ``None``."""
    engine = get_engine()
    with Session(engine) as session:
        return (
            session.query(UserTool)
            .filter_by(user_id=user_id, tool_name=tool_name)
            .first()
        )


def list_user_tools(user_id: str) -> list[UserTool]:
    """Return all UserTool records for *user_id*."""
    engine = get_engine()
    with Session(engine) as session:
        rows = session.query(UserTool).filter_by(user_id=user_id).all()
        # Detach from session so they can be used after the session closes
        session.expunge_all()
        return rows


def upsert_user_tool(
    user_id: str,
    tool_name: str,
    enabled: bool,
    params: Optional[Dict[str, Any]] = None,
) -> UserTool:
    """Create or update a user's tool record and return the saved instance."""
    engine = get_engine()
    with Session(engine) as session:
        row = (
            session.query(UserTool)
            .filter_by(user_id=user_id, tool_name=tool_name)
            .first()
        )
        if row is None:
            row = UserTool(
                user_id=user_id,
                tool_name=tool_name,
                enabled=enabled,
                params=params or {},
            )
            session.add(row)
        else:
            row.enabled = enabled
            if params is not None:
                row.params = params
            row.updated_at = datetime.now(timezone.utc)
        session.commit()
        session.refresh(row)
        session.expunge(row)
        return row


def set_user_tool_enabled(user_id: str, tool_name: str, enabled: bool) -> Optional[UserTool]:
    """Toggle *enabled* on an existing UserTool.  Returns ``None`` if not found."""
    engine = get_engine()
    with Session(engine) as session:
        row = (
            session.query(UserTool)
            .filter_by(user_id=user_id, tool_name=tool_name)
            .first()
        )
        if row is None:
            return None
        row.enabled = enabled
        row.updated_at = datetime.now(timezone.utc)
        session.commit()
        session.refresh(row)
        session.expunge(row)
        return row
