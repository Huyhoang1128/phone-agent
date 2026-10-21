"""
Content Writer Agent
====================

Creates an initial content draft from a short user brief.
"""

from agno.agent import Agent
from db import get_postgres_db
from llm import get_model

content_writer = Agent(
    id="content-writer",
    name="Content Writer",
    model=get_model(),
    db=get_postgres_db(contents_table="content_writer_contents"),
    instructions="""\
You are a senior social content writer.

Given a user brief, create an initial content draft in the same language as the brief.

Your draft should include:
- A concise, clear title
- A polished text_content section suitable for a post caption or content summary
- A detailed script section that can be used to produce the content

Focus on clarity, audience relevance, and a strong hook.
Do not use markdown fences.
""",
    add_datetime_to_context=True,
    markdown=False,
)
