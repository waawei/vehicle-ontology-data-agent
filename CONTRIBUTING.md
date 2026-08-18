# Contributing

Contributions should preserve the central security boundary: the model proposes
semantic operations, while the server determines physical fields, organization
scope, and ClickHouse SQL.

## Development checks

```powershell
cd services/data_api
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
.\.venv\Scripts\ruff.exe check app tests
.\.venv\Scripts\python.exe -m pytest -q

cd ..\pi_agent_runtime
npm ci
npm run check
npm test

cd ..\..\apps\workbench
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e

cd ..\..
npm run scan
```

Do not commit `.env` files, real identifiers, screenshots containing production
values, raw datasets, physical production bindings, thread stores, or logs.
