from __future__ import annotations

import logging
from typing import Any

import httpx

from .brain import Assistant
from .config import Settings

log = logging.getLogger("vocivo.api")


class AssistantUnavailable(RuntimeError):
    """
    The API could not say which receptionist answers this number.

    Deliberately distinct from "this number has no receptionist": the first is
    a fault on our side and the caller must still reach the company, the second
    is an answer and the call does not belong here.
    """

# The edge asks Vocivo's API who is calling whom and which receptionist answers
# for that number, and hands back the conversation when the call ends. The
# shared edge secret is the same one Kamailio already uses for SIP auth.


class VocivoApi:
    def __init__(self, settings: Settings):
        self._settings = settings
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=5.0))

    async def close(self) -> None:
        await self._client.aclose()

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._settings.api_secret}", "content-type": "application/json"}

    async def assistant_for(self, number: str, caller: str) -> Assistant | None:
        """
        The receptionist configured for the number that was dialled.

        Returns None only when the API answers that this number has no
        receptionist — a normal answer, meaning the dialplan should not have
        sent the call here, and the caller is released rather than talked to by
        a default agent that belongs to nobody.

        A transport failure or a 5xx is not that answer, and must never be
        mistaken for it: a cold start or a bad minute at the API would
        otherwise drop every inbound call on the platform. Those raise
        `AssistantUnavailable`, and the caller is handed back to the dialplan,
        which rings the staff instead.
        """
        try:
            response = await self._client.get(
                f"{self._settings.api_url}/api/voice/receptionist",
                headers=self._headers(),
                params={"number": number, "caller": caller},
            )
            if response.status_code == 404:
                return None
            response.raise_for_status()
        except httpx.HTTPStatusError as error:
            status = error.response.status_code
            # 4xx other than 404 is a settled answer about this call — a bad
            # secret or a malformed number — and retrying it would not help.
            if status < 500:
                log.error("receptionist lookup refused with %s", status)
                return None
            log.error("receptionist lookup failed with %s", status)
            raise AssistantUnavailable(f"the API answered {status}") from error
        except httpx.HTTPError as error:
            log.error("could not load receptionist (%s)", type(error).__name__)
            raise AssistantUnavailable("Receptionist configuration unavailable") from error
        try:
            payload: dict[str, Any] = response.json()
            if not isinstance(payload, dict):
                raise ValueError("Invalid receptionist configuration")
            if not payload.get("enabled", True):
                return None
            return Assistant.from_api(payload)
        except (ValueError, TypeError, AttributeError) as error:
            raise AssistantUnavailable("Invalid receptionist configuration") from error

    async def record_conversation(self, payload: dict[str, Any]) -> None:
        """Best effort: a call that happened matters more than its record of it."""
        try:
            response = await self._client.post(
                f"{self._settings.api_url}/api/voice/receptionist",
                headers=self._headers(),
                json=payload,
            )
            response.raise_for_status()
        except httpx.HTTPError as error:
            log.warning("could not file conversation %s (%s)", str(payload.get("callId", ""))[:8], type(error).__name__)
