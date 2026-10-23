# What a brand-new account starts with: one example to do list and one example reminder.
# Edit freely. They're only added once, when an account's data is first created and still empty,
# so changing them here never touches anyone's existing list.

TODO = """# To do

- [ ] Ask the agent to add something to this list
- [ ] Set a reminder for tomorrow morning
- [x] Open the app

Click **Edit** to change this list, or just ask in the chat.
"""

REMINDER = {
    "title": "Say hi to your agent",
    "note": "Try asking it to plan your day, or to remind you of something later.",
    "in_hours": 24,  # fires this long after the account is created
    "repeat": "once",
    "action": "notify",
}
