# Contributor instructions

This public repository has one architecture: Pi Agent Runtime plus governed
Ontology and data tools. Keep the model responsible for reasoning and tool
selection while server code remains responsible for Principal scope, physical
bindings, and deterministic SQL.

## Non-negotiable boundaries

1. Never allow model-generated SQL or browser-selected organization scope.
2. Never return organization IDs through `/auth/me`, observations, groups,
   errors, logs, screenshots, or model context.
3. Never compute a full aggregate from paginated or capped detail rows.
4. Resolve metrics and physical identifiers from approved semantic registries
   and mount allowlists; fail closed on ambiguity.
5. Keep structured observations as the browser's fact source.
6. Keep query completeness separate from dataset attribution quality.
7. Do not add real data, credentials, database URLs, organization topology,
   production bindings, raw files, thread stores, or production screenshots.

## Change discipline

- Keep demo data synthetic and deterministic.
- Update semantic registries, compiler tests, ClickHouse fixtures, Runtime
  contract tests, and Workbench fixtures together when changing a contract.
- Add a Skill capability only after its governed tool is executable.
- Treat the local identity and JSON thread store as demo adapters, not production
  defaults.
- Run `npm run scan` before every public commit.

## Relevant checks

- Data API: `ruff check app tests` and `pytest -q`
- Pi Runtime: `npm run check`, `npm test`, `npm run build`
- Workbench: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`,
  `npm run test:e2e`
- Repository: `npm run scan`
