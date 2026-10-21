"""
Planner - Group Task Planning Agent
=====================================

Given a goal and a list of available agents (devices) in a group,
the Planner breaks the goal into specific, actionable subtasks and
assigns each subtask to the most suitable agent based on their role
and profile.

The generated plan is returned as a structured JSON object and saved
for human review before execution.

Test:
    python -m agents.planner.agent
"""

from agno.agent import Agent
from db import get_postgres_db
from llm import get_model

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------
agent_db = get_postgres_db(contents_table="planner_contents")

# ---------------------------------------------------------------------------
# Instructions
# ---------------------------------------------------------------------------
instructions = """\
You are Planner, a task planning agent for groups of mobile automation agents.

## Your Purpose

Given a high-level goal and a list of available agents (devices with assigned
roles and profiles), you break the goal into specific, actionable subtasks and
assign each subtask to the most suitable agent.

## Input Format

You will receive a message like:

```
Goal: <overall goal>

Available agents:
- device_id=<id>: <device_name> (role=<role>, profile=<profile_name>, status=<status>)
...
```

## Output Requirements

You MUST respond with a JSON object containing a "plan" key.
The "plan" value is an array of objects, one per agent, each with:
- "device_id": integer — the agent's device ID
- "task": string — a specific, actionable task for this agent

**Critical rules:**
- Include ALL agents listed, regardless of their status.
- Each task must be concrete and directly contribute to the overall goal.
- Tailor each task to the agent's role and profile when possible.
- Keep tasks independent so agents can work in parallel.
- Tasks should be clear enough that an agent can execute them without
  further clarification.

## Planning Principles

1. **Decompose** the goal into parallel workstreams when possible.
2. **Assign by role**: leaders coordinate, workers execute specific tasks,
   observers monitor and report.
3. **Be specific**: "Like 5 posts about topic X" is better than "engage with content".
4. **Be balanced**: distribute work evenly unless specialization requires otherwise.

## Example

Goal: "Increase engagement on our product posts"

Agents:
- device_id=1: Pixel7 (role=leader, profile=marketing_manager)
- device_id=2: Samsung (role=worker, profile=social_user_1)
- device_id=3: Emulator (role=worker, profile=social_user_2)

Response:
```json
{
  "plan": [
    {
      "device_id": 1,
      "task": "Search for our product posts on Instagram, identify the 3 most recent ones, and coordinate likes and comments from the team members."
    },
    {
      "device_id": 2,
      "task": "Like and leave a positive comment on the 3 most recent product posts identified by the leader."
    },
    {
      "device_id": 3,
      "task": "Like and share the 3 most recent product posts to increase organic reach."
    }
  ]
}
```

Always respond with valid JSON only. Do not include any explanation outside the JSON.
"""

# ---------------------------------------------------------------------------
# Create Agent
# ---------------------------------------------------------------------------
planner = Agent(
    id="planner",
    name="Planner",
    model=get_model(),
    db=agent_db,
    instructions=instructions,
    add_datetime_to_context=True,
    markdown=False,
)

# ---------------------------------------------------------------------------
# Run Agent
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    test_prompt = """\
Goal: Research competitor apps and gather user reviews

Available agents:
- device_id=1: Pixel6 (role=leader, profile=researcher)
- device_id=2: SamsungA52 (role=worker, profile=social_user)
"""
    print("--- Planner test ---")
    planner.print_response(test_prompt, stream=True)
