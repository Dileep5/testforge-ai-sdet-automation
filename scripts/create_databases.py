#!/usr/bin/env python3
"""Create the project's databases if they are missing. It never drops or changes one that exists."""

import os

import psycopg

NAMES = ("testforge", "testforge_test", "testforge_e2e", "testforge_perf")

url = os.environ["POSTGRES_ADMIN_URL"]
with psycopg.connect(url, autocommit=True) as conn:
    for name in NAMES:
        if not conn.execute("SELECT 1 FROM pg_database WHERE datname = %s", (name,)).fetchone():
            conn.execute(f'CREATE DATABASE "{name}"')
            print(f"Created database {name}")
