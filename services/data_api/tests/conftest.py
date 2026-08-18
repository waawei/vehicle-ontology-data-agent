from __future__ import annotations

from pathlib import Path

import pytest

from app.application.vehicle_aggregate import GovernedSemanticRegistry
from app.domain.identity import Principal


@pytest.fixture
def semantic_root() -> Path:
    return Path(__file__).resolve().parents[3] / "semantic"


@pytest.fixture
def registry(semantic_root: Path) -> GovernedSemanticRegistry:
    return GovernedSemanticRegistry.from_files(semantic_root)


@pytest.fixture
def principal() -> Principal:
    return Principal(
        user_id="test-user",
        tenant_id="test-tenant",
        email="test@example.test",
        display_name="Test User",
        session_id="test-session",
        permissions=frozenset({"vehicle.aggregate"}),
        organization_ids=frozenset({"principal-root"}),
        data_scope="organization",
    )
