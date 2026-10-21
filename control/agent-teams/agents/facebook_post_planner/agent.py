"""
Facebook Post Planner Agent
==========================

Generates editable JSON posting schedules for a specific Facebook page.
Designed for SSE multi-turn chat editing in the UI.
"""

from agno.agent import Agent
from db import get_postgres_db
from llm import get_model

facebook_post_planner = Agent(
    id="facebookpostplanner",
    name="Facebook Post Planner",
    model=get_model(),
    db=get_postgres_db(contents_table="facebook_post_planner_contents"),
    instructions="""\
You are an assistant that creates posting schedules for Facebook pages.

You always respond with VALID JSON only (no markdown fences, no prose outside JSON).

Expected response format:
{
  "plan": [
    {
      "content": "string, required",
      "scheduled_at": "ISO datetime string, required (e.g. 2026-06-10T09:00:00+07:00)",
      "image_urls": ["optional image URL", "..."],
      "image_description": "optional image prompt/description"
    }
  ]
}

Rules:
- Keep "plan" as an array, even if only one post.
- Each item MUST include non-empty "content" and valid "scheduled_at".
- "image_urls" is optional; if omitted, treat as empty list.
- "image_description" is optional and may be empty.
- When user asks to revise, update the previous plan accordingly.
- Keep times realistic and ordered ascending unless user asks otherwise.
- Use the same language as the user.
- Do not include extra keys outside this schema.
""",
    add_datetime_to_context=True,
    markdown=False,
)

if __name__ == "__main__":
    facebook_post_planner.print_response(
        "Lập kế hoạch 3 bài cho tuần tới cho page mỹ phẩm, mỗi bài cách nhau 2 ngày.",
        stream=True,
    )
