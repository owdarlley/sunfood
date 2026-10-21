#!/usr/bin/env bash
# Roda os testes do banco (test/banco/*.sql) num Postgres vazio: cria o banco a
# partir de supabase/schema.sql, põe os dados mínimos e confere que cada teste
# termina com a mensagem TESTE_..._PASSOU. Usado no CI; localmente:
#   PGHOST=... PGUSER=postgres ./test/banco/rodar.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
DB=${PGDATABASE:-sunfood_teste}
psql -q -d postgres -c "drop database if exists $DB" -c "create database $DB" || exit 1
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f test/banco/supabase-stub.sql -f supabase/schema.sql -f test/banco/seed.sql >/dev/null || exit 1
falhas=0
for f in test/banco/*.sql; do
  case "$(basename "$f")" in supabase-stub.sql|seed.sql) continue ;; esac
  msg=$(psql -q -d "$DB" -f "$f" 2>&1 | grep -o 'ERROR: .*' | head -1)
  if [[ "$msg" == *"TESTE_"*"PASSOU"* ]]; then
    echo "ok   $(basename "$f")"
  else
    echo "FALHA $(basename "$f"): $msg"
    falhas=$((falhas + 1))
  fi
done
exit $falhas
