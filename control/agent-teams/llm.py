import os
import logging

def get_model():
    llm_provider = os.getenv("LLM_PROVIDER", "openai")
    llm_model = os.getenv("LLM_MODEL", "gpt-5-nano-2025-08-07") 
    logging.info(f"Using LLM provider: {llm_provider}, model: {llm_model}")

    if llm_provider == "groq":

        from agno.models.groq import Groq
        return Groq(id=llm_model, retries=2, delay_between_retries=1, exponential_backoff=True)
    else:
        from agno.models.openai import OpenAIResponses
        return OpenAIResponses(id=llm_model, retries=2,)

