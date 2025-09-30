from mitmproxy import http, ctx
import requests
import json
import threading

FORWARD_URL = "http://localhost:9000/receive"
TIMEOUT = 10

# stored_headers: flow.id -> dict of removed headers (e.g., {"x-request-id": "..."})
stored_headers = {}


# ------------------ Helper: serialize headers preserving duplicates ------------------
def _serialize_headers_preserve(headers_obj):
    """
    Return a representation of headers suitable for JSON:
    - headers_list: list of [name, value] preserving duplicates and order
    - headers_dict: last-win dict for convenience
    """
    list_of_pairs = []
    dict_single = {}
    for k, v in headers_obj.items(multi=True):
        list_of_pairs.append([k, v])
        dict_single[k] = v
    return list_of_pairs, dict_single


# ------------------ Fire-and-forget sender for normal enrichment ------------------
def _send_enriched_async(payload: dict, fid: str):
    try:
        requests.post(
            FORWARD_URL,
            headers={"Content-Type": "application/json"},
            data=json.dumps(payload),
            timeout=TIMEOUT,
        )
        ctx.log.info(f"[mitmproxy] normal response: sent enriched req+resp for flow {fid} to service")
    except Exception as e:
        ctx.log.error(f"[mitmproxy] normal response: failed to send enriched req+resp for flow {fid} to service: {e}")


# ------------------ Connector-service worker ------------------
def _handle_connector_service(flow: http.HTTPFlow, headers: dict):
    """Run in background thread: send connector-service request to your service."""
    try:
        svc_resp = requests.request(
            method=flow.request.method,
            url=FORWARD_URL,
            headers=headers,  # forward all headers intact
            data=flow.request.get_content(),
            timeout=TIMEOUT,
        )
        try:
            svc_headers = dict(svc_resp.headers)
        except Exception:
            svc_headers = {"Content-Type": "application/octet-stream"}

        flow.response = http.Response.make(
            svc_resp.status_code,
            svc_resp.content,
            svc_headers,
        )
        ctx.log.info(
            f"[mitmproxy] connector-service: delivered service response for flow {flow.id} "
            f"(status={svc_resp.status_code})"
        )
    except Exception as e:
        flow.response = http.Response.make(
            502,
            f"Error contacting connector service: {e}".encode("utf-8"),
            {"Content-Type": "text/plain"},
        )
        ctx.log.error(f"[mitmproxy] connector-service: error contacting service for flow {flow.id}: {e}")
    finally:
        flow.resume()  # release flow back to client


# ------------------ Request hook ------------------
def request(flow: http.HTTPFlow) -> None:
    """
    Called when a client request is received.
    """
    headers = dict(flow.request.headers)

    # === Case A: connector-service request ===
    if headers.get("x-source") == "connector-service":
        ctx.log.info(f"[mitmproxy] connector-service request: intercepting flow {flow.id} and sending to FORWARD_URL")
        flow.intercept()  # pause flow until background thread sets response
        threading.Thread(target=_handle_connector_service, args=(flow, headers)).start()
        return

    # === Case B: normal request ===
    removed = {}
    if "x-request-id" in flow.request.headers:
        removed["x-request-id"] = flow.request.headers["x-request-id"]
        del flow.request.headers["x-request-id"]

    if removed:
        stored_headers[flow.id] = removed
        ctx.log.info(f"[mitmproxy] normal request: stored headers for flow {flow.id}: {removed}")
    # mitmproxy will forward this request upstream automatically


# ------------------ Response hook ------------------
def response(flow: http.HTTPFlow) -> None:
    """
    Called when the original server responds (for non-connector-service flows).
    """
    fid = flow.id

    # Only handle normal flows for enrichment if we stored headers earlier
    if fid not in stored_headers:
        return

    removed = stored_headers.pop(fid)

    # Restore x-request-id into the response that will be sent to the client
    if "x-request-id" in removed:
        flow.response.headers["x-request-id"] = removed["x-request-id"]
    flow.response.headers["x-state"] = "response"

    # Prepare copies to send to your service
    req_copy = flow.request.copy()
    resp_copy = flow.response.copy()

    # Restore removed headers into the copies
    for k, v in removed.items():
        req_copy.headers[k] = v
        resp_copy.headers[k] = v

    # Serialize headers (preserve duplicates)
    req_headers_list, req_headers_dict = _serialize_headers_preserve(req_copy.headers)
    resp_headers_list, resp_headers_dict = _serialize_headers_preserve(resp_copy.headers)

    try:
        payload = {
            "flow_id": fid,
            "request": {
                "method": req_copy.method,
                "url": req_copy.url,
                "headers_list": req_headers_list,
                "headers": req_headers_dict,
                "body": req_copy.get_content().decode("utf-8", errors="replace"),
            },
            "response": {
                "status_code": resp_copy.status_code,
                "headers_list": resp_headers_list,
                "headers": resp_headers_dict,
                "body": resp_copy.get_content().decode("utf-8", errors="replace"),
            },
        }
        threading.Thread(target=_send_enriched_async, args=(payload, fid)).start()
        ctx.log.info(f"[mitmproxy] normal response: scheduled enriched send for flow {fid}")
    except Exception as e:
        ctx.log.error(f"[mitmproxy] normal response: failed to build payload for flow {fid}: {e}")