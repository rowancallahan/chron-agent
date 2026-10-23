from workers import DurableObject

import examples


# todo.md and every saved version of it, in this object's own SQLite database.
#   versions: one row per save (v = 1, 2, 3, ...), each a full copy of the text.
#   head:     which version is showing. Undo/redo just move it.
# Saving after an undo drops the newer versions, like a text editor.
class Doc(DurableObject):
    def __init__(self, ctx, env):
        super().__init__(ctx, env)
        self.sql = ctx.storage.sql
        self.sql.exec("CREATE TABLE IF NOT EXISTS versions (v INTEGER PRIMARY KEY, text TEXT)")
        self.sql.exec("CREATE TABLE IF NOT EXISTS head (v INTEGER)")
        # The very first time: start a new (empty) account with the example list from examples.py.
        self.sql.exec("CREATE TABLE IF NOT EXISTS started (done INTEGER)")
        if not self.query("SELECT done FROM started"):
            self.sql.exec("INSERT INTO started VALUES (1)")
            if self.head() == 0:
                self.save(examples.TODO)

    def query(self, q, *args):
        return self.sql.exec(q, *args).toArray()  # a list of dicts, one per row

    def head(self):
        rows = self.query("SELECT v FROM head")
        return rows[0]["v"] if rows else 0

    def set_head(self, v):
        self.sql.exec("DELETE FROM head")
        self.sql.exec("INSERT INTO head VALUES (?)", v)

    def text(self, v):
        rows = self.query("SELECT text FROM versions WHERE v = ?", v)
        return rows[0]["text"] if rows else ""

    # What the page shows: the version on screen, plus the two it compares against in "Changes":
    # the one before it, and the newest one (when you've undone back to an older version).
    def state(self):
        v = self.head()
        count = self.query("SELECT COUNT(*) AS n FROM versions")[0]["n"]
        return {"text": self.text(v), "v": v, "count": count,
                "prev": self.text(v - 1) if v > 1 else None,
                "newest": self.text(count) if v < count else None}

    def save(self, text):
        v = self.head() + 1
        self.sql.exec("DELETE FROM versions WHERE v >= ?", v)
        self.sql.exec("INSERT INTO versions VALUES (?, ?)", v, str(text or ""))
        self.set_head(v)

    def clear(self):  # deletes the text and every version
        self.sql.exec("DELETE FROM versions")
        self.sql.exec("DELETE FROM head")

    def move(self, step):  # -1 = undo, +1 = redo; stays between the first and last version
        count = self.query("SELECT COUNT(*) AS n FROM versions")[0]["n"]
        self.set_head(min(max(self.head() + step, 1), count))
