#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "postgres" <<-EOSQL
  DO \$\$
  BEGIN
    IF NOT EXISTS (
      SELECT FROM pg_catalog.pg_roles WHERE rolname = '${POSTGRES_USER}'
    ) THEN
      CREATE ROLE ${POSTGRES_USER} LOGIN PASSWORD '${POSTGRES_PASSWORD}';
    END IF;
  END
  \$\$;

  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${POSTGRES_DB}') THEN
      EXECUTE format('CREATE DATABASE %I OWNER %I', '${POSTGRES_DB}', '${POSTGRES_USER}');
    END IF;
  END
  \$\$;
EOSQL