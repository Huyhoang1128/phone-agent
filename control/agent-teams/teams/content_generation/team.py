"""
Content Generation Team
=======================

Uses a writer and reviewer to generate and refine content drafts.
"""

from agno.team.team import Team
from db import get_postgres_db
from llm import get_model

from agents.content_reviewer import content_reviewer
from agents.content_writer import content_writer

content_generation_team = Team(
    id="content-generation-team",
    name="Content Generation Team",
    model=get_model(),
    db=get_postgres_db(contents_table="content_generation_team_contents"),
    members=[content_writer, content_reviewer],
    instructions=[
        "You lead a content generation workflow with two specialists:",
        "- Content Writer: creates the first draft from the user's brief.",
        "- Content Reviewer: critiques the draft and suggests improvements.",
        "",
        "Process:",
        "1. Ask the Content Writer to create the first draft.",
        "2. Ask the Content Reviewer to critique and improve that draft.",
        "3. Return the final improved result only.",
        "",
        "Return strict JSON with this shape:",
        '{',
        '  "title": "string",',
        '  "text_content": "string",',
        '  "script": "string",',
        '  "video_url": "",',
        '  "file_url": "",',
        '  "image_urls": []',
        '}',
        "",
        "Rules:",
        "- Respond in the same language as the user's brief.",
        "- Always include all keys exactly as specified.",
        "- Keep values as plain strings except image_urls which must be an array of strings.",
        "- Do not wrap the JSON in markdown fences.",
        "- Do not add any explanation outside the JSON.",
    ],
    show_members_responses=False,
    markdown=False,
    add_datetime_to_context=True,
    enable_agentic_memory=True,
)
