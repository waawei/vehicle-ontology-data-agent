from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

import httpx

from app.application.vehicle_aggregate import CompiledAggregate, VehicleAggregateError


def _multipart(compiled: CompiledAggregate) -> list[tuple[str, Any]]:
    scope_rows = "".join(
        json.dumps({"organizationId": item}, ensure_ascii=False) + "\n"
        for item in compiled.organization_scope
    )
    return [
        ("query", (None, compiled.sql)),
        *((f"param_{name}", (None, value)) for name, value in compiled.parameters.items()),
        ("scopeOrganizations_format", (None, "JSONEachRow")),
        ("scopeOrganizations_structure", (None, "organizationId String")),
        (
            "scopeOrganizations",
            ("scope-organizations.jsonl", scope_rows, "application/x-ndjson"),
        ),
    ]


class LiveGovernedClickHouseAggregateExecutor:
    def __init__(
        self,
        endpoint: str,
        user: str,
        password: str,
        *,
        timeout_seconds: float = 35.0,
        local_address: str | None = None,
    ) -> None:
        self._endpoint = endpoint.rstrip("/") + "/"
        self._auth = (user, password)
        self._timeout = timeout_seconds
        self._local_address = local_address

    async def execute(self, compiled: CompiledAggregate) -> list[dict[str, Any]]:
        client_options: dict[str, Any] = {
            "timeout": self._timeout,
            "auth": self._auth,
        }
        if self._local_address:
            client_options["transport"] = httpx.AsyncHTTPTransport(
                local_address=self._local_address,
                trust_env=False,
            )
        try:
            async with httpx.AsyncClient(**client_options) as client:
                response = await client.post(
                    self._endpoint,
                    files=_multipart(compiled),
                )
                response.raise_for_status()
                payload = response.json()
        except httpx.HTTPStatusError as error:
            raise VehicleAggregateError(
                "CLICKHOUSE_EXECUTION_FAILED",
                "ClickHouse rejected the governed aggregate query",
                502,
                {"upstreamStatus": error.response.status_code},
            ) from error
        except (httpx.HTTPError, ValueError) as error:
            raise VehicleAggregateError(
                "CLICKHOUSE_EXECUTION_FAILED",
                "ClickHouse aggregate connector failed",
                502,
            ) from error
        rows = payload.get("data") if isinstance(payload, Mapping) else None
        if not isinstance(rows, list) or not all(isinstance(row, Mapping) for row in rows):
            raise VehicleAggregateError(
                "RESULT_SCHEMA_MISMATCH",
                "ClickHouse aggregate result is invalid",
                502,
            )
        expected = {"value"} | {alias for _, _, alias in compiled.group_fields}
        if any(set(row) != expected for row in rows):
            raise VehicleAggregateError(
                "RESULT_SCHEMA_MISMATCH",
                "ClickHouse returned unexpected aggregate columns",
                502,
            )
        return [dict(row) for row in rows]
