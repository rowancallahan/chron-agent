import json

from js import Object, TextDecoder, fetch
from pyodide.ffi import to_js

# One model call, streamed: the reply arrives a few words at a time instead of all at once.
# Used by agent.call_model. Kept apart so agent.py stays short.
#
# While it reads, it keeps the text so far in rem.partial (the page shows it, growing, while the
# agent works) and checks rem.stopping (the page's Stop button). On Stop it hangs up: OpenRouter
# then cancels the request with the provider, and only the words written so far are billed.
#
# The format is OpenAI-style "server-sent events": lines of `data: {json}`, ending with
# `data: [DONE]`. Each piece carries a little more reply text, or a piece of a tool call
# (its name, then its arguments a few characters at a time).


async def chat(url, headers, body, rem):
    if rem.stopping:  # Stop was pressed: don't even start another (billed) call
        return {"role": "assistant", "content": None}
    res = await fetch(url, _js({"method": "POST", "headers": headers, "body": json.dumps(body | {"stream": True})}))
    if res.status != 200:
        raise RuntimeError(f"Model call failed ({res.status}): {(await res.text())[:300]}")

    text, calls = "", {}  # calls: the tool calls so far, by their position in the reply
    reader, decoder, buffer, finished = res.body.getReader(), TextDecoder.new(), "", False

    def take(line):  # one line of the stream
        nonlocal text
        line = line.rstrip("\r")
        if not line.startswith("data:") or line[5:].strip() == "[DONE]":
            return  # blank lines, and ": OPENROUTER PROCESSING" keep-alive comments
        try:
            data = json.loads(line[5:])
        except ValueError:
            return  # a garbled line: skip it rather than lose the whole reply
        if "error" in data:  # the provider failed partway through
            raise RuntimeError(f"Model call failed: {json.dumps(data['error'])[:300]}")
        delta = (data.get("choices") or [{}])[0].get("delta") or {}
        if delta.get("content"):
            text += delta["content"]
            rem.partial = text
        for piece in delta.get("tool_calls") or []:
            call = calls.setdefault(piece.get("index", 0), {"id": "", "type": "function", "function": {"name": "", "arguments": ""}})
            call["id"] = piece.get("id") or call["id"]
            call["function"]["name"] += (piece.get("function") or {}).get("name") or ""
            call["function"]["arguments"] += (piece.get("function") or {}).get("arguments") or ""

    rem.partial = ""
    try:
        while not rem.stopping:
            chunk = await reader.read()
            if chunk.done:
                take(buffer)  # the last line, if it didn't end with a newline
                finished = True
                break
            buffer += decoder.decode(chunk.value, _js({"stream": True}))
            *lines, buffer = buffer.split("\n")  # the last piece may be a half line: keep it for next time
            for line in lines:
                take(line)
    finally:
        if not finished:  # Stop, or an error: hang up, so the provider stops writing (and billing)
            await reader.cancel()
    if rem.stopping:
        calls = {}  # don't run half-written tool calls

    message = {"role": "assistant", "content": text or None}  # None, not "": some providers refuse empty text
    if calls:
        message["tool_calls"] = [calls[i] for i in sorted(calls)]
    return message  # the same shape as a non-streamed reply's choices[0].message


def _js(d):  # a Python dict as a plain JavaScript object, for fetch() and decode()
    return to_js(d, dict_converter=Object.fromEntries)
