 1 from mitmproxy import http, ctx
  2 import requests
  3 import json
  4 import threading
  5
  6 FORWARD_URL = "http://localhost:9000/receive"
  7 TIMEOUT = 10
  8
  9 # stored_headers: flow.id -> dict of removed headers (e.g., {"x-request-id": "..."})
 10 stored_headers = {}
 11
 12
 13 # ------------------ Helper: serialize headers preserving duplicates ------------------
 14 def _serialize_headers_preserve(headers_obj):
 15     """
 16     Return a representation of headers suitable for JSON:
 17       - headers_list: list of [name, value] preserving duplicates and order
 18       - headers_dict: last-win dict for convenience
 19     """
 20     list_of_pairs = []
 21     dict_single = {}
 22     for k, v in headers_obj.items(multi=True):
 23         list_of_pairs.append([k, v])
 24         dict_single[k] = v
 25     return list_of_pairs, dict_single
 26
 27
 28 # ------------------ Fire-and-forget sender for normal enrichment ------------------
 29 def _send_enriched_async(payload: dict, fid: str):
 30     try:
 31         requests.post(
 32             FORWARD_URL,
 33             headers={"Content-Type": "application/json"},
 34             data=json.dumps(payload),
 35             timeout=TIMEOUT,
 36         )
 37         ctx.log.info(f"[mitmproxy] normal response: sent enriched req+resp for flow {fid} to service")
 38     except Exception as e:
 39         ctx.log.error(f"[mitmproxy] normal response: failed to send enriched req+resp for flow {fid} to service: {e}")
 40
 41
 42 # ------------------ Connector-service worker ------------------
 43 def _handle_connector_service(flow: http.HTTPFlow, headers: dict):
 44     """Run in background thread: send connector-service request to your service."""
 45     try:
 46         svc_resp = requests.request(
 47             method=flow.request.method,
 48             url=FORWARD_URL,
 49             headers=headers,  # forward all headers intact
 50             data=flow.request.get_content(),
 51             timeout=TIMEOUT,
 52         )
 53         try:
 54             svc_headers = dict(svc_resp.headers)
 55         except Exception:
 56             svc_headers = {"Content-Type": "application/octet-stream"}
 57
 58         flow.response = http.Response.make(
 59             svc_resp.status_code,
 60             svc_resp.content,
 61             svc_headers,
 62         )
 63         ctx.log.info(
 64             f"[mitmproxy] connector-service: delivered service response for flow {flow.id} "
 65             f"(status={svc_resp.status_code})"
 66         )
 67     except Exception as e:
 68         flow.response = http.Response.make(
 69             502,
 70             f"Error contacting connector service: {e}".encode("utf-8"),
 71             {"Content-Type": "text/plain"},
 72         )
 73         ctx.log.error(f"[mitmproxy] connector-service: error contacting service for flow {flow.id}: {e}")
 74     finally:
 75         flow.resume()  # release flow back to client
 76
 77
 78 # ------------------ Request hook ------------------
 79 def request(flow: http.HTTPFlow) -> None:
 80     """
 81     Called when a client request is received.
 82     """
 83     headers = dict(flow.request.headers)
 84
 85     # === Case A: connector-service request ===
 86     if headers.get("x-source") == "connector-service":
 87         ctx.log.info(f"[mitmproxy] connector-service request: intercepting flow {flow.id} and sending to FORWARD_URL")
 88         flow.intercept()  # pause flow until background thread sets response
 89         threading.Thread(target=_handle_connector_service, args=(flow, headers)).start()
 90         return
 91
 92     # === Case B: normal request ===
 93     removed = {}
 94     if "x-request-id" in flow.request.headers:
 95         removed["x-request-id"] = flow.request.headers["x-request-id"]
 96         del flow.request.headers["x-request-id"]
 97
 98     if removed:
 99         stored_headers[flow.id] = removed
100         ctx.log.info(f"[mitmproxy] normal request: stored headers for flow {flow.id}: {removed}")
101     # mitmproxy will forward this request upstream automatically
102
103
104 # ------------------ Response hook ------------------
105 def response(flow: http.HTTPFlow) -> None:
106     """
107     Called when the original server responds (for non-connector-service flows).
108     """
109     fid = flow.id
110
111     # Only handle normal flows for enrichment if we stored headers earlier
112     if fid not in stored_headers:
113         return
114
115     removed = stored_headers.pop(fid)
116
117     # Restore x-request-id into the response that will be sent to the client
118     if "x-request-id" in removed:
119         flow.response.headers["x-request-id"] = removed["x-request-id"]
120     flow.response.headers["x-state"] = "response"
121
122     # Prepare copies to send to your service
123     req_copy = flow.request.copy()
124     resp_copy = flow.response.copy()
125
126     # Restore removed headers into the copies
127     for k, v in removed.items():
128         req_copy.headers[k] = v
129         resp_copy.headers[k] = v
130
131     # Serialize headers (preserve duplicates)
132     req_headers_list, req_headers_dict = _serialize_headers_preserve(req_copy.headers)
133     resp_headers_list, resp_headers_dict = _serialize_headers_preserve(resp_copy.headers)
134
135     try:
136         payload = {
137             "flow_id": fid,
138             "request": {
139                 "method": req_copy.method,
140                 "url": req_copy.url,
141                 "headers_list": req_headers_list,
142                 "headers": req_headers_dict,
143                 "body": req_copy.get_content().decode("utf-8", errors="replace"),
144             },
145             "response": {
146                 "status_code": resp_copy.status_code,
147                 "headers_list": resp_headers_list,
148                 "headers": resp_headers_dict,
149                 "body": resp_copy.get_content().decode("utf-8", errors="replace"),
150             },
151         }
152         threading.Thread(target=_send_enriched_async, args=(payload, fid)).start()
153         ctx.log.info(f"[mitmproxy] normal response: scheduled enriched send for flow {fid}")
154     except Exception as e:
155         ctx.log.error(f"[mitmproxy] normal response: failed to build payload for flow {fid}: {e}")
