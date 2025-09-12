# app/db.py
import os
import psycopg
from psycopg.rows import dict_row

DATABASE_URL = os.getenv("DATABASE_DSN")

pool: psycopg.AsyncConnection = None

async def connect_db():
    global pool
    pool = await psycopg.AsyncConnection.connect(DATABASE_URL, row_factory=dict_row, autocommit=True,)

async def disconnect_db():
    global pool
    if pool:
        await pool.close()

async def fetch_all(query: str, params=None):
    async with pool.cursor() as cur:
        await cur.execute(query, params or {})
        return await cur.fetchall()

async def fetch_one(query: str, params=None):
    async with pool.cursor() as cur:
        await cur.execute(query, params or {})
        return await cur.fetchone()

async def execute(query: str, params=None):
    async with pool.cursor() as cur:
        await cur.execute(query, params or {})
