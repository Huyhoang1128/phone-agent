"""
Registry for the Agno demo.

Provides shared tools, models, and database connections for AgentOS.
"""

import os

from agno.models.openai import OpenAIResponses
from agno.registry import Registry
from db import get_postgres_db

demo_db = get_postgres_db()

_tools = []
if os.getenv("PARALLEL_API_KEY"):
    from agno.tools.parallel import ParallelTools
    _tools.append(ParallelTools())

registry = Registry(
    tools=_tools,
    models=[
        OpenAIResponses(id="gpt-5-nano-2025-08-07"),
        OpenAIResponses(id="gpt-5-mini"),
    ],
    dbs=[demo_db],
)
