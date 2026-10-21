"""Common utilities for DNSE API authentication.

Provides HMAC-based HTTP signature building compatible with the
DNSE Open API signature scheme.
"""

import base64
import hashlib
import hmac
import os
from urllib import parse


def get_date_header_name() -> str:
    """Return the name of the date header (default: 'Date').

    Can be overridden via the ``DATE_HEADER`` environment variable.
    """
    return os.getenv("DATE_HEADER", "Date")


def build_signature(
    secret: str,
    method: str,
    path: str,
    date_value: str,
    algorithm: str,
    nonce: str | None = None,
    header_name: str | None = None,
) -> tuple[str, str]:
    """Build an HTTP request signature for DNSE Open API authentication.

    Constructs an HMAC signature over the request-target and date header,
    optionally including a nonce for replay-attack prevention.

    Parameters
    ----------
    secret:
        The API secret used as the HMAC key.
    method:
        HTTP method (e.g. "GET", "POST").
    path:
        Request path (e.g. "/accounts").
    date_value:
        Value of the date header in RFC 2822 format.
    algorithm:
        HMAC algorithm name – one of "hmac-sha256", "hmac-sha384",
        "hmac-sha512", or "hmac-sha1".
    nonce:
        Optional random nonce included in the signature string.
    header_name:
        Name of the date header; defaults to ``get_date_header_name()``.

    Returns
    -------
    headers : str
        Space-separated list of signed header names used in the
        ``headers`` field of the Signature header value.
    signature : str
        URL-encoded base64-encoded HMAC digest.
    """
    header_name = header_name or get_date_header_name()
    header_key = header_name.lower()
    headers = f"(request-target) {header_key}"
    signature_string = (
        f"(request-target): {method.lower()} {path}\n"
        f"{header_key}: {date_value}"
    )
    if nonce:
        signature_string += f"\nnonce: {nonce}"

    if algorithm == "hmac-sha256":
        digestmod = hashlib.sha256
    elif algorithm == "hmac-sha384":
        digestmod = hashlib.sha384
    elif algorithm == "hmac-sha512":
        digestmod = hashlib.sha512
    else:
        digestmod = hashlib.sha1

    mac = hmac.new(
        secret.encode("utf-8"),
        signature_string.encode("utf-8"),
        digestmod,
    )
    encoded = base64.b64encode(mac.digest()).decode("utf-8")
    escaped = parse.quote(encoded, safe="")

    return headers, escaped
