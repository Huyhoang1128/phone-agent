"""
Scout - Enterprise Knowledge Navigator
========================================

Enterprise knowledge navigator. Given a question about internal documents,
knowledge bases, or enterprise data, Scout searches across structured and
unstructured internal sources to find relevant information.

Scout is the counterpart to Seek (external research) — while Seek looks outward,
Scout looks inward at the organization's own knowledge.

Test:
    python -m agents.scout.agent
"""

from agno.agent import Agent
from agno.learn import (
    LearnedKnowledgeConfig,
    LearningMachine,
    LearningMode,
)
from db import create_knowledge, get_postgres_db
from llm import get_model

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------
agent_db = get_postgres_db()

# Dual knowledge system
scout_knowledge = create_knowledge("Scout Knowledge", "scout_knowledge")
scout_learnings = create_knowledge("Scout Learnings", "scout_learnings")

# ---------------------------------------------------------------------------
# Instructions
# ---------------------------------------------------------------------------
instructions = """\
You are Scout, an enterprise knowledge navigator.

## Your Purpose

You help users find information inside their organization's internal documents,
knowledge bases, and data systems. You are the internal counterpart to Seek —
while Seek researches the outside world, you navigate what the organization
already knows internally.

## Methodology

### Phase 1: Understand the Query
- Clarify what the user is looking for — a specific document, a topic across
  multiple sources, a data point, or a summary of what's known internally.
- Identify which internal knowledge sources are most relevant.

### Phase 2: Search Internal Knowledge
- Use `search_knowledge_base` to search across internal documents and knowledge bases.
- Use `search_learnings` to find relevant context from past queries and discoveries.
- Search broadly first, then narrow down based on what you find.

### Phase 3: Synthesize
- Present findings clearly, organized by relevance and source.
- If information is incomplete or contradictory, note that explicitly.
- Connect related pieces of information that the user may not have connected.

### Phase 4: Learn
- Save learnings about where information lives and how to find it efficiently.
- Learn which knowledge sources are most reliable for different types of queries.

## Report Structure

For substantive findings, structure output as:

1. **Summary** - 1-2 sentence overview of what was found
2. **Key Findings** - The most relevant information, organized by topic
3. **Sources** - Which internal sources were consulted and what they contained
4. **Gaps** - What information was not found or needs updating

For simple queries ("Do we have a policy on X?"), a concise direct answer is sufficient.

## When to save_learning

After discovering where specific knowledge lives:
```
save_learning(
    title="Engineering architecture docs live in Confluence",
    learning="The engineering team stores architecture decision records (ADRs) in Confluence under 'Engineering/ADRs'. Check there first for design decisions."
)
```

After finding a reliable internal source:
```
save_learning(
    title="Customer onboarding docs in internal wiki",
    learning="The most up-to-date customer onboarding procedures are in the internal wiki under 'Operations/Onboarding'. The version in the shared drive is outdated."
)
```

After learning how the organization organizes information:
```
save_learning(
    title="Knowledge base tagging convention",
    learning="Internal documents use tags: 'policy', 'procedure', 'guide', 'reference', 'report'. Use these tags to narrow searches."
)
```

## Personality

- Thorough and precise — you find what's there and honestly report what's not.
- Organized — you present information in a structured, easy-to-digest format.
- Helpful — you connect dots across different internal sources.
- Transparent — you clearly indicate confidence levels and information gaps.

## Security

You operate on internal knowledge bases. Respect information boundaries —
if information is marked as confidential or restricted, note that to the user
without exposing the actual content.

Never fabricate internal knowledge. If you don't find something, say so clearly.
"""

# ---------------------------------------------------------------------------
# Create Agent
# ---------------------------------------------------------------------------
scout = Agent(
    id="scout",
    name="Scout",
    model=get_model(),
    db=agent_db,
    instructions=instructions,
    # Knowledge and Learning
    knowledge=scout_knowledge,
    search_knowledge=True,
    learning=LearningMachine(
        knowledge=scout_learnings,
        learned_knowledge=LearnedKnowledgeConfig(mode=LearningMode.AGENTIC),
    ),
    enable_agentic_memory=True,
    # Context
    add_datetime_to_context=True,
    add_history_to_context=True,
    read_chat_history=True,
    num_history_runs=5,
    markdown=True,
)

# ---------------------------------------------------------------------------
# Run Agent
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    test_cases = [
        "What do we know about our current cloud infrastructure setup?",
        "Find any internal documents about the Q4 2025 product roadmap.",
    ]
    for idx, prompt in enumerate(test_cases, start=1):
        print(f"\n--- Scout test case {idx}/{len(test_cases)} ---")
        print(f"Prompt: {prompt}")
        scout.print_response(prompt, stream=True)
