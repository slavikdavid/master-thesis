import asyncpg
import os
from pathlib import Path
import asyncio

from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")
MIGRATIONS_DIR = Path(__file__).parent / "migrations"
APPLIED_TABLE = "schema_migrations"

async def ensure_migrations_table(conn):
    await conn.execute(f"""
    CREATE TABLE IF NOT EXISTS {APPLIED_TABLE} (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    """)

async def get_applied(conn):
    rows = await conn.fetch(f"SELECT version FROM {APPLIED_TABLE}")
    return {r["version"] for r in rows}

async def apply_migration(conn, version_file: Path):
    sql = version_file.read_text()
    async with conn.transaction():
        await conn.execute(sql)
        await conn.execute(f"""
            INSERT INTO {APPLIED_TABLE}(version) VALUES($1)
            """, version_file.name)

async def main():
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL not set")
    conn = await asyncpg.connect(DATABASE_URL)
    try:
        await ensure_migrations_table(conn)
        applied = await get_applied(conn)

        # sort lexicographically - 0001,0002...
        for file in sorted(MIGRATIONS_DIR.glob("*.sql")):
            if file.name in applied:
                continue
            print(f"Applying {file.name}...")
            await apply_migration(conn, file)
        print("Migrations complete.")
    finally:
        await conn.close()

if __name__ == "__main__":
    asyncio.run(main())
