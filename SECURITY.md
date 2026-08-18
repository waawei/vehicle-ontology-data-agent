# Security policy

## Supported versions

Only the latest `main` revision is supported while the project is pre-1.0.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose credentials,
organization scope, private semantic bindings, or production data. Use GitHub's
private vulnerability reporting feature for this repository.

Include the affected commit, reproduction steps, expected impact, and whether
the issue can cross the Principal or governed-tool boundary. Please do not test
against systems or data you are not authorized to access.

## Deployment boundary

The included identity adapter and data are synthetic demo components. Before a
non-local deployment:

- replace demo auto-login with the host application's authenticated Principal;
- rotate `SESSION_SECRET` and keep provider credentials outside Git;
- keep ClickHouse read-only and reachable only from the data service;
- keep organization topology and physical field bindings server-side;
- terminate TLS at a trusted reverse proxy;
- replace local JSON thread persistence when multiple runtime replicas are used.
