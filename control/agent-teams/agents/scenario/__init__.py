"""AI Scenario v3 agents (8 agent gpt-4o-mini)."""
from .agents import (
    scenario_brand_reviewer,
    scenario_cinematic_reviewer,
    scenario_consolidator,
    scenario_continuity_reviewer,
    scenario_kinetic_reviewer,
    scenario_parser,
    scenario_scripter,
    scenario_style_reviewer,
)
from .refiner import scenario_chat_refiner

REVIEWERS = [
    scenario_cinematic_reviewer,
    scenario_kinetic_reviewer,
    scenario_continuity_reviewer,
    scenario_brand_reviewer,
    scenario_style_reviewer,
]

REVIEWER_BY_FOCUS = {
    "cinematic": scenario_cinematic_reviewer,
    "kinetic": scenario_kinetic_reviewer,
    "continuity": scenario_continuity_reviewer,
    "brand": scenario_brand_reviewer,
    "style": scenario_style_reviewer,
}

__all__ = [
    "scenario_parser",
    "scenario_scripter",
    "scenario_cinematic_reviewer",
    "scenario_kinetic_reviewer",
    "scenario_continuity_reviewer",
    "scenario_brand_reviewer",
    "scenario_style_reviewer",
    "scenario_consolidator",
    "scenario_chat_refiner",
    "REVIEWERS",
    "REVIEWER_BY_FOCUS",
]

