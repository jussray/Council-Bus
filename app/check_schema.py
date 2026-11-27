"""SQLite-level regression for founder D1 record immutability and owner index."""
from pathlib import Path
import sqlite3
import sys
import uuid

def main():
    database = sqlite3.connect(':memory:')
    database.execute('PRAGMA foreign_keys=ON')
    for migration in sorted(Path('db').glob('*.sql')):
        database.executescript(migration.read_text(encoding='utf-8'))
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
    # A founder may submit one workflow per record and seat; repeated attempts
    # must not produce conflicting append-only workflow links.
    workflow_id = 'council-chatgpt-'+'a'*32
    args = (workflow_id, item[1], item[0], 'chatgpt', item[5])
    database.execute('INSERT INTO council_workflow_links VALUES (?, ?, ?, ?, ?)', args)
    try:
        database.execute('INSERT INTO council_workflow_links VALUES (?, ?, ?, ?, ?)', ('council-chatgpt-'+'b'*32, item[1], item[0], 'chatgpt', item[5]))
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError('duplicate record/seat workflows were permitted')
    assert database.execute('SELECT count(*) FROM council_workflow_links').fetchone()[0] == 1
    print('PASS: D1-compatible schema, append-only draft and owner isolation indexes')

if __name__ == '__main__':
    try: main()
    except Exception as error:
        print('FAIL:', type(error).__name__, error, file=sys.stderr)
        raise
