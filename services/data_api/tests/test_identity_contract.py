from __future__ import annotations

from app.domain.identity import Principal
from app.identity import public_principal


def test_public_principal_never_exposes_organization_ids() -> None:
    principal = Principal(
        user_id="user-1",
        tenant_id="tenant-1",
        email="user@example.test",
        display_name="User",
        session_id="session-1",
        permissions=frozenset({"vehicle.aggregate"}),
        organization_ids=frozenset({"real-organization-id"}),
        data_scope="organization",
    )

    payload = public_principal(principal).model_dump(by_alias=True)

    assert set(payload) == {"id", "email", "displayName", "permissions", "dataScope"}
    assert "real-organization-id" not in str(payload)
