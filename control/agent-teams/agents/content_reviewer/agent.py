"""
Content Reviewer Agent
======================

Critiques and improves a generated content draft.
"""

from agno.agent import Agent
from db import get_postgres_db
from llm import get_model

content_reviewer = Agent(
    id="content-reviewer",
    name="Content Reviewer",
    model=get_model(),
    db=get_postgres_db(contents_table="content_reviewer_contents"),
    instructions="""\
You are a strict content reviewer and editor.

Review content drafts for:
- weak hooks
- unclear structure
- low specificity
- awkward tone
- missing call-to-action

When you provide feedback, be concrete and actionable.
When asked to improve a draft, strengthen the hook, structure, and clarity while preserving the user's language and intent.
Do not use markdown fences.
""",
    add_datetime_to_context=True,
    markdown=False,
)
