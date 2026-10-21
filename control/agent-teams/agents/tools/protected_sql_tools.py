"""
ProtectedSQLTools — Hard-protection wrapper around agno SQLTools
=================================================================

This module provides ``ProtectedSQLTools``, a subclass of agno's
``SQLTools`` that blocks SQL queries targeting sensitive system tables.

Why this matters
----------------
The PAL and Dash agents have access to ``run_sql_query``, which lets
them (and the LLM driving them) execute arbitrary SQL against the
application database.  The same database stores credential data in the
``user_tools`` table (GitHub personal access tokens, DNSE API keys,
etc.) and subscription data in ``user_plans``.  Without protection, a
user could prompt an agent with:

    "List all API keys for user id 23"

and the LLM would happily execute ``SELECT * FROM user_tools ...``
and return the credentials.

This class provides a **hard-protection** layer: the check runs in
Python, not in the LLM context, so it cannot be bypassed by rephrasing
the prompt.
"""

from __future__ import annotations

import logging
import re
from typing import ClassVar

from agno.tools.sql import SQLTools

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Forbidden tables
# ---------------------------------------------------------------------------

#: Tables that must never be directly queried by an agent.  These hold
#: credentials, billing information, or internal agent state.
SYSTEM_TABLES: frozenset[str] = frozenset(
    {
        "user_tools",             # API keys, OAuth tokens, secrets
        "user_plans",             # Subscription / billing data
        "agno_sessions",          # Raw agent session blobs
        "agno_approvals",         # Pending human-approval records
        "rate_limit_daily_counts",  # Internal rate-limit counters
    }
)

# Pre-compiled pattern: match any forbidden table name, including
# schema-qualified forms like ``public.user_tools`` or ``ai.user_plans``.
# The alternation covers both bare names and dot-prefixed (schema.) names.
_FORBIDDEN_RE: re.Pattern = re.compile(
    r"(?:^|[\s,(=]|\.)"                          # leading context or schema dot
    r"("
    + "|".join(re.escape(t) for t in SYSTEM_TABLES)
    + r")"
    r"(?=$|[\s,);])",                             # trailing context
    re.IGNORECASE | re.MULTILINE,
)


def _blocked_table(query: str) -> str | None:
    """Return the first forbidden table name found in *query*, or ``None``."""
    m = _FORBIDDEN_RE.search(query)
    return m.group(1).lower() if m else None


# ---------------------------------------------------------------------------
# Protected wrapper
# ---------------------------------------------------------------------------


class ProtectedSQLTools(SQLTools):
    """SQLTools subclass that refuses queries targeting sensitive system tables.

    Drop-in replacement for ``agno.tools.sql.SQLTools``:

    .. code-block:: python

        # Before
        SQLTools(db_url=db_url)

        # After
        ProtectedSQLTools(db_url=db_url)

    Any SQL query that references a table in :data:`SYSTEM_TABLES` is
    rejected with an error message before it reaches the database.  The
    rejection happens in Python code, so it **cannot** be bypassed by
    rephrasing the LLM prompt.
    """

    # Expose the protected table list so tests can inspect it.
    protected_tables: ClassVar[frozenset[str]] = SYSTEM_TABLES

    def run_sql_query(self, query: str) -> str:
        """Execute *query*, blocking access to system tables.

        Parameters
        ----------
        query:
            The SQL statement to execute.

        Returns
        -------
        str
            Query results, or an error string if the query was blocked.
        """
        blocked = _blocked_table(query)
        if blocked:
            logger.warning(
                "ProtectedSQLTools: blocked query referencing system table '%s': %.200s",
                blocked,
                query,
            )
            return (
                f"Access denied: queries against the system table '{blocked}' are not "
                "permitted. These tables contain sensitive credential and system data "
                "that must not be accessed directly. If you need to manage tool "
                "credentials, use the /user/tools API endpoints instead."
            )
        return super().run_sql_query(query)
