import json
import re

from workers import fetch

import commands
import notify  # notify
import stream
import tools as extra  # tools/: plugin tools, e.g. the calendar

# The agent: one call to any OpenAI-compatible chat API (OpenRouter by default), in a loop
# while the model asks to use a tool. Its tools are the same commands the page uses
# (commands.py), so it can do exactly what you can do on the page, and nothing more --
# plus any plugin tools (tools/) the person turned on, like reading their calendar.
# No memory of its own: every run starts from the chat log, the to do list and the current time.

MAX_STEPS = 10  # model calls per run, so a confused model can't loop (and spend) forever
# ---- The system prompt has two parts ----
# 1. The instructions. This is the default; you can change it in the page's Settings tab.
DEFAULT_PROMPT = """You are a helpful todo agent for one person. You help with their todo list and reminders.

The todo list is a markdown file called todo.md. Read, search and edit it with your tools.
Keep edits small and keep the person's own wording. Every save is a new version;
undo_todo and redo_todo move between versions, like the person's own undo/redo buttons.

Reminders fire at a set time (a wake-up for yourself must be at least 5 minutes away). Action "notify" alerts the person; action "agent" wakes you up
with the reminder's title, so you can act on it (e.g. write a morning summary into todo.md).
Every reminder shows in the chat. Its send_to list also sends it elsewhere -- e.g. "push" (their
phone), "email", "text" -- whichever they've turned on (see "Alerts turned on" below).
For something important you can escalate: set a wake-up for later, and when it fires, check the
chat for a reply since; if there's none, send_alert on another channel (e.g. push, then email, then
text) and set the next check. Don't do this for ordinary things.

After changing anything, say briefly what you changed. Keep replies short.

Your replies are shown as markdown: use headings, tables and checklists (- [ ] / - [x]) when they help.
For a picture (a day's schedule, a progress bar, a week at a glance) you can write a small inline <svg>:
viewBox and width="100%", at most 520 wide, labels 11px or larger, plain grey and near-black
(#15201B, #55615B, #9AA39F, #E4E9E6) with #A1251B only for "now". Work out positions carefully
from the times. No style, class or id attributes, no images or links to other sites (they're removed)."""

# 2. Facts added on every run, after the instructions.
CONTEXT = """
You are the model {model}.
Times are the person's local time, written "YYYY-MM-DD HH:MM". It is now {now}.
Each message starts with the time it was sent, in [brackets]; don't start your replies with one.
Alerts turned on right now (where send_to can reach): {alerts}
This line is current. Alert errors earlier in the chat may since have been fixed: just try.
Extra tools turned on: {tools}
Your limits (the tools refuse past these): {steps} model calls per run; {alerts_max} send_alert calls per run;
at most {wakeups} "agent" wake-ups at once, each at least {gap} minutes away; todo.md at most {todo_max:,} characters.
You can only reach the person through the alert channels above, never a number or address you choose.

Current todo.md:
```
{todo}
```"""


# model: e.g. "anthropic/claude-haiku-5.5". prompt: the instructions (see above).
# chat: the chat log, oldest first, as rows from the messages table.
# local: turns a time (ms) into local "YYYY-MM-DD HH:MM". Returns the agent's final reply (text).
async def run(env, model, prompt, doc, rem, chat, local, now_ms):
    todo = (await doc.state())["text"]
    facts = CONTEXT.format(model=model, now=local(now_ms), todo=todo, alerts=notify.describe(env, rem.sql),  # notify
                           tools=extra.describe(env, rem.sql),  # tools/
                           steps=MAX_STEPS, alerts_max=commands.MAX_ALERTS, wakeups=commands.MAX_WAKEUPS,
                           gap=commands.WAKE_GAP, todo_max=commands.MAX_TODO)
    messages = [{"role": "system", "content": prompt + "\n" + facts}]
    for m in chat:  # every message starts with the time it was sent, e.g. "[2026-10-21 21:44]"
        if m["role"] == "agent":  # its own earlier replies
            messages.append({"role": "assistant", "content": f"[{local(m['at'])}] {m['text']}"})
        else:  # your messages, reminders that fired, the agent's own past actions, errors
            label = "" if m["role"] == "you" else "(event) "
            messages.append({"role": "user", "content": f"[{local(m['at'])}] {label}{m['text']}"})
    # A message sent while the agent was busy is logged *before* that run's reply, so the chat can end
    # on the agent's own reply. Models won't answer a chat that ends on their own turn: ask them to.
    if messages[-1]["role"] == "assistant":
        messages.append({"role": "user", "content": "(event) There are new messages above your last reply; answer them."})
    tools = commands.COMMANDS + extra.schemas(env, rem.sql)  # plus any plugin tools this person turned on

    for _ in range(MAX_STEPS):
        reply = await call_model(env, model, messages, rem, tools)
        messages.append(reply)
        if rem.stopping:  # the Stop button: keep what it had written, do nothing more
            return (reply.get("content") or "").strip() + "\n\n*(stopped)*"
        calls = reply.get("tool_calls") or []
        if not calls:  # done: its reply (without a "[time]" at the start, if it copied the pattern)
            return re.sub(r"^\[\d{4}-\d\d-\d\d \d\d:\d\d\]\s*", "", reply.get("content") or "") or "(no reply)"
        for call in calls:
            if rem.stopping:  # Stop pressed while tools run: don't start the rest
                return "*(stopped)*"
            name = call["function"].get("name", "")
            try:
                args = json.loads(call["function"].get("arguments") or "{}")
            except json.JSONDecodeError:
                args = None  # cut off or garbled: don't run it with made-up (empty) arguments
            if not isinstance(args, dict):
                result = "Error: the arguments weren't a JSON object; nothing was done. Try again."
            elif extra.owns(env, rem.sql, name):  # a plugin tool (tools/), e.g. read_calendar
                rem.log("event", f"Used {name} | {json.dumps(args)[:200]}")
                result = await extra.run(env, rem.sql, rem.zone(), name, args)
            else:
                result = await commands.run(name, args, doc, rem, "agent")
            messages.append({"role": "tool", "tool_call_id": call.get("id") or "call", "content": result})
    return "(stopped: too many steps)"


# ---- Talking to the model provider (OpenRouter, or any OpenAI-compatible API) ----

def api_key(env):
    key = (getattr(env, "LLM_API_KEY", None) or "").strip().strip('"')  # ignore pasted spaces/quotes
    if not key:
        raise RuntimeError("No LLM_API_KEY set (npx wrangler secret put LLM_API_KEY)")
    return key


async def call_model(env, model, messages, rem, tools):  # streamed, so the page can show the reply as it's written
    return await stream.chat(
        f"{env.LLM_BASE_URL}/chat/completions",
        {"Authorization": f"Bearer {api_key(env)}", "Content-Type": "application/json"},
        {"model": model, "messages": messages, "tools": tools},
        rem,
    )


# Every model the provider offers that can use tools, cheapest first:
# [{"id", "name", "in", "out"}], prices in dollars per million tokens (OpenRouter: GET /models).
async def models(env):
    res = await fetch(f"{env.LLM_BASE_URL}/models")
    if res.status != 200:
        raise RuntimeError(f"Model list failed ({res.status})")
    found = []
    for m in (await res.json()).get("data", []):
        if "tools" not in (m.get("supported_parameters") or []):
            continue
        try:
            price_in, price_out = (float(m["pricing"][k]) * 1_000_000 for k in ("prompt", "completion"))
        except (KeyError, TypeError, ValueError):
            continue
        found.append({"id": m["id"], "name": m.get("name") or m["id"], "in": round(price_in, 3), "out": round(price_out, 3)})
    return sorted(found, key=lambda m: m["in"])


# How much this key has spent, in dollars (OpenRouter only: GET /key). "byok" is spend billed to
# your own provider key (e.g. Anthropic); "openrouter" is OpenRouter credits.
async def usage(env):
    res = await fetch(f"{env.LLM_BASE_URL}/key", headers={"Authorization": f"Bearer {api_key(env)}"})
    if res.status != 200:
        raise RuntimeError(f"Usage check failed ({res.status})")
    d = (await res.json())["data"]
    return {"month_byok": d.get("byok_usage_monthly"), "month_openrouter": d.get("usage_monthly"),
            "total_byok": d.get("byok_usage"), "total_openrouter": d.get("usage"),
            "limit": d.get("limit"), "remaining": d.get("limit_remaining")}
