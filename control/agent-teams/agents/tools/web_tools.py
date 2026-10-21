from firecrawl import Firecrawl
from typing import Optional, Dict, Any
import logging
import os
logger = logging.getLogger(__name__)


def web_search(query: str, limit: int = 5) -> str:
    """
    Search the web and return results in markdown format.

    Parameters
    ----------
    query : str
        The search query string. Must be a non-empty string.
    limit : int, optional
        The maximum number of results to return for each category (web, news, images). Must be a positive integer. Default is 5.
    """
    if not query or not isinstance(query, str):
        raise ValueError("query phải là chuỗi không rỗng")
    if not isinstance(limit, int) or limit <= 0:
        raise ValueError("limit phải là số nguyên > 0")
    try:
        firecrawl_url = os.getenv("FIRECRAWL_URL", "http://localhost:3002")
        client = Firecrawl(api_url=firecrawl_url)

        logger.info(f"Searching query='{query}', limit={limit}")
        data = client.search(query=query, limit=limit)

        def _format_items(items, section_name: str) -> list[str]:
            if not items:
                return []
            lines = [f"## {section_name}"]
            for i, item in enumerate(items, 1):
                title = getattr(item, "title", None) or "No title"
                url = getattr(item, "url", None) or ""
                description = getattr(item, "description", None) or ""
                category = getattr(item, "category", None)

                lines.append(f"{i}. [{title}]({url})")
                if description:
                    lines.append(f"   - {description}")
                if category:
                    lines.append(f"   - Category: `{category}`")
            lines.append("")
            return lines

        md_lines = [f"# Search Results", "", f"**Query:** `{query}`", f"**Limit:** {limit}", ""]

        md_lines += _format_items(getattr(data, "web", None), "Web")
        md_lines += _format_items(getattr(data, "news", None), "News")
        md_lines += _format_items(getattr(data, "images", None), "Images")

        if len(md_lines) <= 5:
            md_lines.append("_Không có kết quả phù hợp._")

        return "\n".join(md_lines).strip()
    except Exception as e:
        logger.error(f"Error in web_search with query='{query}': {e}")
        return f"_Error performing web search: {e}_"


def crawl_webpage(url: str) -> str:
    """
    Crawl a webpage and extract its content 

    Parameters
    ----------
    url : str
        The URL of the webpage to crawl. Must be a valid HTTP/HTTPS URL.

    Returns
    -------
    str
        The raw content of the webpage

    web content of url
    """
    # Initialize Firecrawl client with the API endpoint
    firecrawl_url = os.getenv("FIRECRAWL_URL", "http://localhost:3002")
    _firecrawl_client = Firecrawl(api_url=firecrawl_url)
    if not url or not isinstance(url, str):
        raise ValueError("URL must be a non-empty string")

    if not url.startswith(('http://', 'https://')):
        logger.warning(f"URL '{url}' does not start with http:// or https://. Proceeding anyway.")

    try:
        logger.info(f"Crawling URL: {url}")
        result = _firecrawl_client.scrape(url)
        logger.info(f"Successfully crawled {url}")
        raw_content = result.markdown if hasattr(result, 'markdown') else str(result)
        return raw_content
    except Exception as e:
        logger.error(f"Failed to crawl with url {url}: {e}")
        return f"Error crawling URL: {e}. You should skip crawling this url"
