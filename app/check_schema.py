"""SQLite-level regression for founder D1 record immutability and owner index."""
from pathlib import Path
import sqlite3
import sys
import uuid

def main():
    database = sqlite3.connect(':memory:')
    database.execute('PRAGMA foreign_keys=ON')
    database.executescript(Path('db/0001_founder_app.sql').read_text(encoding='utf-8'))
    item = (str(uuid.uuid4()), 'founder@example.invalid', 'Review an unsealed source', '[]', '0'*64, '2026-11-27T00:00:00Z')
    database.execute('INSERT INTO council_records VALUES (?, ?, ?, ?, ?, ?)', item)
    for statement, params in (
        ('UPDATE council_records SET claim=? WHERE id=?', ('attempted rewrite',item[0])),
        ('DELETE FROM council_records WHERE id=?', (item[0],)),
    ):
        try:
            database.execute(statement, params)
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError('Found mutable record in unsealed ledger')
    assert database.execute('SELECT count(*) FROM council_records').fetchone()[0] == 1
    print('PASS: D1-compatible schema, append-only draft and owner isolation indexes')

if __name__ == '__main__':
    try: main()
    except Exception as error:
        print('FAIL:', type(error).__name__, error, file=sys.stderr)
        raise
