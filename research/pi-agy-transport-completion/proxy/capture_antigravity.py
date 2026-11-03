"""mitmproxy addon used to capture Antigravity response framing safely.

Unlike the original one-off diagnostic addon, this version never records the
Authorization header, request IDs, prompts, system instructions, or successful
model output.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from mitmproxy import ctx, http

OUTPUT = Path(
    os.environ.get(
        "ANTIGRAVITY_CAPTURE_FILE",
        "/tmp/antigravity-transport-capture.jsonl",
    )
)
REQUEST_HEADERS = (
    "user-agent",
    "transfer-encoding",
    "content-type",
    "accept-encoding",
)
RESPONSE_HEADERS = (
    "content-type",
    "content-length",
    "transfer-encoding",
    "connection",
)


def selected_headers(headers: http.Headers, names: tuple[str, ...]) -> dict[str, str]:
    return {name: headers[name] for name in names if name in headers}


def request_metadata(flow: http.HTTPFlow) -> dict[str, object]:
    try:
        body = json.loads(flow.request.get_text(strict=False) or "{}")
    except (TypeError, ValueError):
        return {"body": "not JSON"}

    request = body.get("request") if isinstance(body, dict) else None
    labels = request.get("labels") if isinstance(request, dict) else None
    return {
        "project": body.get("project") if isinstance(body, dict) else None,
        "model": body.get("model") if isinstance(body, dict) else None,
        "modelEnum": labels.get("model_enum") if isinstance(labels, dict) else None,
        "requestType": body.get("requestType") if isinstance(body, dict) else None,
        "prompt": "omitted",
        "requestId": "redacted",
    }


def error_response(flow: http.HTTPFlow) -> object:
    if flow.response is None or flow.response.status_code < 400:
        return "successful body omitted"
    try:
        return json.loads(flow.response.get_text(strict=False) or "{}")
    except (TypeError, ValueError):
        return (flow.response.get_text(strict=False) or "")[:4000]


def response(flow: http.HTTPFlow) -> None:
    if flow.response is None:
        return
    if flow.request.pretty_host != "daily-cloudcode-pa.googleapis.com":
        return
    if "streamGenerateContent" not in flow.request.pretty_url:
        return

    record = {
        "url": flow.request.pretty_url,
        "status": flow.response.status_code,
        "requestHeaders": selected_headers(flow.request.headers, REQUEST_HEADERS),
        "request": request_metadata(flow),
        "responseHeaders": selected_headers(flow.response.headers, RESPONSE_HEADERS),
        "response": error_response(flow),
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT.open("a", encoding="utf-8") as output:
        output.write(json.dumps(record, sort_keys=True) + "\n")
    ctx.log.info(f"saved sanitized Antigravity response to {OUTPUT}")
