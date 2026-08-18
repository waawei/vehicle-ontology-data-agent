# Production validation without publishing production data

## Scope of this statement

The private source deployment was exercised against an authorized production
ClickHouse environment. This public repository does not contain or reproduce
production values, credentials, organization identifiers, topology, physical
table names, field bindings, raw files, query logs, or screenshots.

The public demo and its numbers are synthetic. Its purpose is to make the
architecture, controls, and expected behavior independently reproducible.

Production correctness remains deployment-specific, especially organization
topology and metric publication. It must be revalidated when a metric binding,
dataset release, source schema, or topology version changes.

## Validation questions

A production verification should answer these questions with evidence kept in
the authorized environment:

1. Did the request use the real authenticated Principal rather than a browser-
   supplied organization list?
2. Did the formal metric resolve to exactly one approved definition, dataset,
   mount, identity field, organization field, and business-time field?
3. Was the logical month compiled to the source's actual physical encoding?
4. Did ClickHouse execute the full distinct aggregation instead of returning
   detail rows for Python or browser aggregation?
5. Did the result match an independently controlled read-only baseline query
   under the same effective scope and business definition?
6. Did the response, tool trace, model context, browser network traffic, and
   persisted thread avoid real organization IDs and credentials?
7. Did refresh preserve the original question, tool result, and answer?
8. Did a Runtime restart either recover a completed thread or mark an
   interrupted run explicitly failed?

## Recommended verification procedure

### 1. Identity and scope

- Authenticate through the host application's real identity adapter.
- Record a correlation ID and opaque Principal ID in the private evidence set.
- Resolve authorization roots and topology expansion only on the server.
- Compare the effective set with the identity system's authoritative scope.
- Run a negative test proving a semantic request cannot add, replace, filter, or
  group by an organization ID.
- Inspect browser and model traces to confirm the effective IDs never crossed
  the server boundary.

### 2. Semantic and physical binding

- Record the Semantic Index resource version, metric ID, Metric Definition
  version, dataset release, mount ID, and topology version.
- Confirm the metric aggregation is `count_distinct` and the bound identity is
  the approved business key, not a row count or display field.
- Confirm every physical identifier comes from the released mount allowlist.
- Fail closed when any registry has no match, multiple matches, a version
  mismatch, or an unpublished status.

### 3. Business time

- Sample only the minimum authorized metadata needed to establish the physical
  month representation.
- Verify a logical request such as `YYYY-MM` is compiled through dataset time
  metadata rather than compared directly with an ISO timestamp or arbitrary
  string.
- Test at least a normal month, a year boundary, and an invalid month.

### 4. Aggregate pushdown

- Capture the controlled compiler output or an approved query fingerprint in
  the private environment.
- Verify ClickHouse receives one aggregate query per requested period.
- Verify an ungrouped query contains the aggregate function and no detail-row
  pagination or row cap.
- Verify scope is supplied through a typed parameter or external table, not
  concatenated from the request.
- For grouped results, verify the result policy, deterministic order, truncation
  detection, and completeness status.

### 5. Independent reconciliation

- Have an authorized data owner execute a separate, controlled read-only
  baseline using the same metric identity, month, organization scope, null
  handling, and deduplication rule.
- Compare the governed tool value with the baseline value inside the private
  environment.
- Store only pass/fail, timestamps, version identifiers, and approved query
  fingerprints in shareable evidence. Do not publish the business value.
- Treat a mismatch as a release blocker; do not replace a failed live query with
  an old report, screenshot, fixture, or model estimate.

### 6. Observation and user experience

- Validate `metricId`, `label`, `value`, `unit`, `time`, `groups`,
  `completeness`, `dataQuality`, and `provenance` before the observation reaches
  the model.
- Confirm the first screen renders the structured observation even if the model
  answer is absent or malformed.
- Ask a context-only follow-up such as “按供应商分组” and “和 5 月比较” to prove
  the thread carries the prior metric and time context.
- Refresh the browser and inspect the recovered tool result.
- Interrupt one run, restart the Runtime, and confirm it becomes explicitly
  failed rather than appearing complete.

## Organization-attribution quality

Query completeness and organization-attribution quality are different claims:

- `completeness=complete` means Principal scope resolution succeeded,
  ClickHouse completed the aggregate, and the result was not truncated.
- `dataQuality.organizationAttribution` describes how much of a defined dataset
  and time range can be attributed to the governed organization topology.

A production coverage measurement must be built from a full dataset or an
explicit time window and publish all of the following together:

- numerator;
- denominator;
- time range;
- basis, currently `metric_identity`;
- topology version;
- measurement timestamp in the private release record.

A value observed for one query month must not become permanent global coverage
metadata.

## What can be shared publicly

Safe portfolio evidence includes:

- the synthetic screenshots in this repository;
- architecture and sequence diagrams;
- redacted test methodology;
- CI output against synthetic fixtures;
- a statement that an authorized private environment was exercised;
- versioned public code for the contracts and compiler.

Do not publish production result values, raw screenshots with only visual blur,
organization or employee identifiers, physical source bindings, database URLs,
credentials, exported browser storage, thread stores, or query logs. Redaction
must be irreversible; replacing production screenshots with synthetic captures
is preferred.
