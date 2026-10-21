"""
runmb.py — test script for running MobileAgent with per-app tools/skills.

Usage examples
--------------
# Share a video to TikTok (default goal, default GoogleGenAI provider):
    python runmb.py --app tiktok

# Use Groq as the LLM provider (reads GROQ_API_KEY from .env):
    python runmb.py --app tiktok --provider Groq

# Use Groq with a specific model:
    python runmb.py --app tiktok --provider Groq --model llama-3.1-8b-instant

# Share a specific video URL to TikTok:
    python runmb.py --app tiktok \\
        --goal "Download https://samplelib.com/mp4/sample-5s.mp4 and share it to TikTok"

# Post a comment (reasoning mode):
    python runmb.py --app tiktok --reasoning \\
        --goal "Post a comment 'Great video!' on the current TikTok"

# Override the device serial:
    python runmb.py --serial emulator-5554 --app tiktok

Environment variables
---------------------
GOOGLE_API_KEY   — Gemini API key (used when --provider GoogleGenAI)
GROQ_API_KEY     — Groq API key   (used when --provider Groq)
OPENAI_API_KEY   — OpenAI API key (used when --provider OpenAIResponses)
ANTHROPIC_API_KEY — Anthropic API key (used when --provider Anthropic)

All keys can be stored in a .env file — it is loaded automatically.

Supported --provider values
---------------------------
GoogleGenAI, Groq, Anthropic, OpenAIResponses, OpenAILike,
Ollama, DeepSeek, OpenRouter, MiniMax
"""

import argparse
import asyncio
import logging
import sys

from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("runmb")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


async def run_agent(
    goal: str,
    app: str | None = None,
    serial: str | None = None,
    reasoning: bool = False,
    max_steps: int = 20,
    debug: bool = False,
    provider: str | None = None,
    model: str | None = None,
) -> None:
    """Run MobileAgent with optional per-app tools and skill guides.

    When ``app`` is specified (e.g. ``"tiktok"``), the agent automatically
    loads:
    - **Tools** from ``apps/<app>/tools.py`` — Python functions registered in
      the executor's tool registry (callable by the LLM executor).
    - **Skill guides** from ``apps/<app>/skills/*.md`` — markdown files
      describing step-by-step workflows.  These are injected into the
      Manager's system prompt so it can plan using the documented sequences.

    The hybrid pattern works as follows:
    - The Manager reads skill guides to know the correct sequence of tool calls.
    - Each tool returns a plain-text result describing success or failure
      (including a UI snapshot on failure).
    - If a tool fails (e.g. an ad popup appeared), the executor reads the
      failure message and decides how to recover (e.g. calling
      ``tiktok_dismiss_popup`` then retrying the previous tool).
    """
    from mobilerun import MobileAgent, MobileConfig
    from mobilerun.config_manager import (
        AgentConfig,
        AppCardConfig,
        DeviceConfig,
        ExecutorConfig,
        FastAgentConfig,
        LoggingConfig,
        ManagerConfig,
        ToolsConfig,
    )
    from mobilerun.config_manager.config_manager import LLMProfile

    # Default models per provider (used when --model is not given)
    _DEFAULT_MODELS: dict[str, str] = {
        "GoogleGenAI": "gemini-3.1-flash-lite-preview",
        "Groq": "llama-3.3-70b-versatile",
        "Anthropic": "claude-sonnet-4-6",
        "OpenAIResponses": "gpt-5.4",
        "OpenAILike": "",
        "Ollama": "llama3.2:3b",
        "DeepSeek": "deepseek-chat",
        "OpenRouter": "",
        "MiniMax": "MiniMax-M2.7",
    }

    # ── Build LLM profiles ────────────────────────────────────────────────────
    # Default: manager uses OpenAI gpt-4o-mini; executor and other roles use
    # Groq llama-3.1-8b-instant.  Passing --provider overrides all roles with
    # a single provider/model.
    if provider:
        resolved_model = model or _DEFAULT_MODELS.get(provider, "")
        if not resolved_model:
            raise ValueError(
                f"--model is required for provider '{provider}' "
                "(no default model configured)."
            )
        logger.info(f"🤖 LLM provider: {provider} / model: {resolved_model}")

        def _make_profile(temperature: float = 0.2) -> LLMProfile:
            return LLMProfile(provider=provider, model=resolved_model, temperature=temperature)

        llm_profiles: dict[str, LLMProfile] = {
            "manager": _make_profile(0.2),
            "executor": _make_profile(0.1),
            "fast_agent": _make_profile(0.2),
            "app_opener": _make_profile(0.0),
            "structured_output": _make_profile(0.0),
        }
    else:
        logger.info("🤖 Manager: OpenAIResponses / gpt-4o-mini | Executor: Groq / meta-llama/llama-4-scout-17b-16e-instruct")
        _groq_fast = LLMProfile(provider="Groq", model="meta-llama/llama-4-scout-17b-16e-instruct", temperature=0.1)
        llm_profiles = {
            "manager": LLMProfile(provider="OpenAIResponses", model="gpt-4o-mini", temperature=0.2),
            "executor": _groq_fast,
            "fast_agent": LLMProfile(provider="Groq", model="meta-llama/llama-4-scout-17b-16e-instruct", temperature=0.2),
            "app_opener": LLMProfile(provider="Groq", model="meta-llama/llama-4-scout-17b-16e-instruct", temperature=0.0),
            "structured_output": LLMProfile(provider="OpenAIResponses", model="gpt-4o-mini", temperature=0.0),
        }

    # ── Build config ──────────────────────────────────────────────────────────
    agent_cfg = AgentConfig(
        max_steps=max_steps,
        reasoning=reasoning,
        streaming=True,
        fast_agent=FastAgentConfig(vision=False),
        manager=ManagerConfig(vision=False),
        executor=ExecutorConfig(vision=False),
        # App cards always enabled — loaded for both FastAgent and reasoning modes
        app_cards=AppCardConfig(enabled=True, mode="local"),
    )

    device_cfg = DeviceConfig(
        serial=serial,
        platform="android",
        auto_setup=True,
    )

    tools_cfg = ToolsConfig(
        disabled_tools=["click_at", "click_area", "long_press_at"],
    )

    log_cfg = LoggingConfig(debug=debug)

    config = MobileConfig(
        agent=agent_cfg,
        device=device_cfg,
        tools=tools_cfg,
        logging=log_cfg,
        llm_profiles=llm_profiles,
    )

    # ── Create and run agent ───────────────────────────────────────────────────
    logger.info(f"🎯 Goal: {goal}")
    if app:
        logger.info(f"📦 Loading tools and skills for app: '{app}'")
    if reasoning:
        logger.info("🧠 Running in reasoning mode (Manager + Executor)")
    else:
        logger.info("⚡ Running in direct mode (FastAgent)")

    agent = MobileAgent(
        goal=goal,
        config=config,
        app=app,  # auto-loads apps/<app>/tools.py and apps/<app>/skills.py
    )

    try:
        handler = agent.run()

        # Stream events for live feedback
        from mobilerun.agent.droid.events import ManagerPlanEvent
        from mobilerun.agent.executor.events import ExecutorActionEvent
        from mobilerun.agent.fast_agent.events import FastAgentOutputEvent

        async for ev in handler.stream_events():
            if isinstance(ev, ManagerPlanEvent) and ev.plan:
                logger.info(f"📋 Plan updated:\n{ev.plan[:300]}")
            elif isinstance(ev, ExecutorActionEvent):
                logger.info(f"⚡ Executor action: {ev.description}")
            elif isinstance(ev, FastAgentOutputEvent):
                logger.debug(f"🤖 FastAgent: {str(ev)[:200]}")

        result = await handler
        logger.info(
            f"\n{'✅' if result.success else '❌'} "
            f"Result: {result.success} — {result.reason}"
        )
        return result

    except KeyboardInterrupt:
        logger.info("Interrupted by user")
    except Exception as e:
        logger.error(f"Agent error: {e}")
        if debug:
            import traceback

            traceback.print_exc()
        raise


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run MobileAgent with optional per-app tools and skills",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--goal",
        default=(
            "Download the video from https://samplelib.com/mp4/sample-5s.mp4 "
            "and upload it to TikTok"
        ),
        help="Natural language goal for the agent",
    )
    parser.add_argument(
        "--app",
        default="tiktok",
        help=(
            "App name to load tools/skills from (e.g. 'tiktok'). "
            "Corresponds to a directory under apps/"
        ),
    )
    parser.add_argument(
        "--serial",
        default=None,
        help="Android device serial (default: first connected device)",
    )
    parser.add_argument(
        "--reasoning",
        action="store_true",
        help="Use reasoning mode (Manager + Executor) instead of direct FastAgent",
    )
    parser.add_argument(
        "--max-steps",
        type=int,
        default=20,
        help="Maximum number of steps",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable debug logging",
    )
    parser.add_argument(
        "--provider",
        default=None,
        metavar="PROVIDER",
        help=(
            "LLM provider to use, e.g. 'Groq', 'GoogleGenAI', 'Anthropic', "
            "'OpenAIResponses', 'Ollama'. "
            "Defaults to GoogleGenAI when not set."
        ),
    )
    parser.add_argument(
        "--model",
        default=None,
        metavar="MODEL",
        help=(
            "Model name for the selected provider "
            "(e.g. 'llama-3.3-70b-versatile' for Groq). "
            "Falls back to the provider's default when not set."
        ),
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()

    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)
        logging.getLogger("mobilerun").setLevel(logging.DEBUG)

    asyncio.run(
        run_agent(
            goal=args.goal,
            app=args.app,
            serial=args.serial,
            reasoning=True,
            max_steps=args.max_steps,
            debug=args.debug,
            provider=args.provider,
            model=args.model,
        )
    )
