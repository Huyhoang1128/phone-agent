"""
Agno Demo - AgentOS Entrypoint
================================

Serves demo agents, teams, and workflows via AgentOS.
"""

import os
from pathlib import Path

from agents.pal import pal
from agents.facebook_post_planner import facebook_post_planner
from agents.planner import planner
from agents.scenario import (
    scenario_brand_reviewer,
    scenario_cinematic_reviewer,
    scenario_consolidator,
    scenario_continuity_reviewer,
    scenario_kinetic_reviewer,
    scenario_parser,
    scenario_scripter,
    scenario_style_reviewer,
    scenario_chat_refiner,
)
from agents.seek import seek
from agno.os import AgentOS
from db import get_postgres_db
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.utils import get_openapi
from jwt_middleware import GoJWTMiddleware
from models import init_db
from registry import registry
from routes.scenario import router as scenario_router
from routes.script_studio import router as script_studio_router
from routes.tools import router as tools_router
from routes.user import router as user_router
from teams.content_generation import content_generation_team
from teams.research import research_team
from user_tools_middleware import UserToolsMiddleware

config_path = str(Path(__file__).parent.joinpath("config.yaml"))

# Initialise tables on startup (idempotent)
init_db()

# ---------------------------------------------------------------------------
# Custom routes
# ---------------------------------------------------------------------------
base_app = FastAPI()
base_app.include_router(user_router)
base_app.include_router(tools_router)
base_app.include_router(script_studio_router)
base_app.include_router(scenario_router)


# ---------------------------------------------------------------------------
# AgentOS
# ---------------------------------------------------------------------------
agent_os = AgentOS(
    agents=[
        pal, seek, planner, facebook_post_planner,
        # v3.2.1 — AI Scenario agents (8). Expose qua AgentOS cho debug +
        # observability + session/memory inspection (Phase 2: enable_agentic_memory).
        # Orchestration logic vẫn ở teams/scenario/orchestrator.py (custom code,
        # KHÔNG dùng Agno Team — chốt v1 ScriptStudio đã FAIL với Team coordinator).
        scenario_scripter,
        scenario_parser,
        scenario_cinematic_reviewer,
        scenario_kinetic_reviewer,
        scenario_continuity_reviewer,
        scenario_brand_reviewer,
        scenario_style_reviewer,
        scenario_consolidator,
        scenario_chat_refiner,
    ],
    teams=[research_team, content_generation_team],
    workflows=[],
    run_hooks_in_background=True,
    tracing=True,
    scheduler=True,
    registry=registry,
    config=config_path,
    db=get_postgres_db(),
    base_app=base_app,
)

app = agent_os.get_app()

# ---------------------------------------------------------------------------
# SQLAdmin panel
# ---------------------------------------------------------------------------
from admin_panel import setup_admin  # noqa: E402

setup_admin(app)

# ---------------------------------------------------------------------------
# Swagger / OpenAPI – Bearer JWT security scheme
# ---------------------------------------------------------------------------


def _custom_openapi():
    if app.openapi_schema:
        return app.openapi_schema
    schema = get_openapi(
        title=app.title,
        version=app.version,
        description=app.description,
        routes=app.routes,
    )
    schema.setdefault("components", {})
    schema["components"]["securitySchemes"] = {
        "bearerAuth": {
            "type": "http",
            "scheme": "bearer",
            "bearerFormat": "JWT",
            "description": "Enter your JWT access token (e.g. obtained from /auth/login).",
        }
    }
    # Apply the scheme globally so every endpoint shows the lock icon
    schema["security"] = [{"bearerAuth": []}]
    app.openapi_schema = schema
    return app.openapi_schema


app.openapi = _custom_openapi

# ---------------------------------------------------------------------------
# Middleware stack
# ---------------------------------------------------------------------------
# Registration order matters: middlewares are executed LIFO.
# Add UserToolsMiddleware FIRST so it becomes the innermost layer (runs just
# before the actual agent handler, after auth is done).
# Add GoJWTMiddleware SECOND so it runs first on every request.
#
#   Request → GoJWTMiddleware → UserToolsMiddleware → handler
# ---------------------------------------------------------------------------

# Build a name→agent map for the middleware from the known agents
_agent_map = {
    "pal": pal,
    "seek": seek,
    "planner": planner,
    "facebookpostplanner": facebook_post_planner,
    "scenariorefiner": scenario_chat_refiner,
}

app.add_middleware(UserToolsMiddleware, agents=_agent_map)

# Add JWT middleware for authentication with Go system
app.add_middleware(
    GoJWTMiddleware,
    verification_key=os.getenv("DJANGO_SECRET_KEY", "django-insecure-change-me-in-production"),
    algorithm="HS256",
    user_id_claim="user_id",
    session_id_claim="session_id",
    dependencies_claims=["name", "email", "roles"],
    validate=True,
    authorization=False,  # Set to True to enable RBAC
    verify_audience=False,
    excluded_route_paths=[
        "/health",
        "/docs",
        "/redoc",
        "/openapi.json",
        "/auth/*",  # Wildcard for auth endpoints
        "/admin",   # SQLAdmin panel root
        "/admin/*",  # SQLAdmin panel pages
    ],
    token_source="HEADER",  # Extract from Authorization header
)

# Add CORS middleware outermost so it handles browser preflight requests before
# JWT validation. This allows the React UI to call the agent_teams service
# directly for SSE streaming.
_cors_origins_raw = os.getenv(
    "AGENT_TEAMS_CORS_ORIGINS",
    "http://localhost:5173,http://127.0.0.1:5173",
)
_cors_origins = [o.strip() for o in _cors_origins_raw.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

if __name__ == "__main__":
    agent_os.serve(host="0.0.0.0", app="run:app", reload=True)
