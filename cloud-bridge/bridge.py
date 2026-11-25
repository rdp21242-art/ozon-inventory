"""Anycubic Cloud -> Cloudflare Worker production event bridge.

Read-only integration: it never sends commands to a printer.
Polling is deliberately conservative (default 60 seconds).
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys
from datetime import datetime, timezone
from typing import Any

import aiohttp
from anycubic_cloud_api import AnycubicAPI, AnycubicAuthMode

LOG = logging.getLogger("anycubic-bridge")
MODEL_MAP = {
    20024: "kobra3",    # Anycubic Kobra 3
    20027: "kobra3v2",  # Anycubic Kobra 3 V2
}


def required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Не задана переменная окружения {name}")
    return value


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def project_state(project: Any, printer: Any) -> str:
    """Track active printing and confirmed successful completion only."""
    available = bool(getattr(printer, "is_available", False))

    if project is None:
        return "idle" if available else "unknown"

    progress = int(getattr(project, "progress_percentage", 0) or 0)
    progress = max(0, min(100, progress))

    failed = bool(getattr(project, "print_failed", False))
    complete = bool(getattr(project, "print_complete", False))
    paused = bool(getattr(project, "print_is_paused", False))
    in_progress = bool(getattr(project, "print_in_progress", False))
    label = str(getattr(project, "print_status", "") or "").lower()

    # Canceled/failed jobs are not production results and must not be
    # reported as a printer failure. If Cloud says the printer is available,
    # treat it as idle; otherwise keep it unknown.
    if failed or label in {"cancelled", "canceled", "failed", "error", "aborted"}:
        return "idle" if available else "unknown"

    # Count completion only when Cloud confirms success AND progress is 100%.
    if progress >= 100 and (
        complete or label in {"complete", "completed", "finished", "done"}
    ):
        return "completed"

    if paused or label in {"paused", "pause"}:
        return "paused"

    if in_progress:
        return "printing"

    return "idle" if available else "unknown"


async def post_event(session: aiohttp.ClientSession, worker_url: str, bridge_token: str, payload: dict[str, Any]) -> None:
    url = worker_url.rstrip("/") + "/api/printer/event"
    headers = {"X-Bridge-Token": bridge_token}
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            async with session.post(url, json=payload, headers=headers, timeout=aiohttp.ClientTimeout(total=20)) as resp:
                raw = await resp.text()
                if resp.status >= 500 or resp.status == 429:
                    raise RuntimeError(f"Worker временно ответил HTTP {resp.status}: {raw[:300]}")
                if resp.status >= 400:
                    raise RuntimeError(f"Worker отклонил событие HTTP {resp.status}: {raw[:300]}")
                LOG.info("Worker принял событие: %s / %s / %s%%", payload["printer_id"], payload["state"], payload["progress"])
                return
        except Exception as exc:
            last_error = exc
            if attempt < 2:
                await asyncio.sleep(2 ** attempt)
    raise RuntimeError(f"Не удалось передать событие в Worker: {last_error}")


async def collect_and_send(api: Any, session: aiohttp.ClientSession, worker_url: str, bridge_token: str) -> None:
    printers = await api.list_my_printers(ignore_init_errors=True)
    if not printers:
        raise RuntimeError("Anycubic Cloud вернул пустой список принтеров")

    mapped = 0
    for printer in printers:
        machine_type = int(getattr(printer, "machine_type", 0) or 0)
        local_id = MODEL_MAP.get(machine_type)
        name = getattr(printer, "name", None) or getattr(printer, "model", None) or f"printer-{getattr(printer, 'id', '?')}"
        if not local_id:
            LOG.warning("Принтер не сопоставлен: %s (machine_type=%s, cloud_id=%s). Событие не отправлено.", name, machine_type, getattr(printer, "id", "?"))
            continue

        # One latest project lookup per printer. Only a confirmed successful
        # completion at 100% is accepted as a finished production task.
        project = await api.get_latest_project(printer_id=printer.id)
        state = project_state(project, printer)
        progress = int(getattr(project, "progress_percentage", 0) or 0) if project else 0
        progress = max(0, min(100, progress))
        file_name = str(getattr(project, "name", "") or "")[:240] if project else ""
        job_id = str(getattr(project, "id", "") or "") if project else f"{local_id}:idle"

        payload = {
            "printer_id": local_id,
            "state": state,
            "progress": progress,
            "file_name": file_name,
            "job_id": job_id,
            "job_in_progress": state in {"printing", "paused"},
            "occurred_at": utc_now(),
            "source": "anycubic-cloud-poll",
            "cloud_printer_name": str(name)[:120],
            "machine_type": machine_type,
            "cloud_printer_id": str(getattr(printer, "id", "")),
        }
        await post_event(session, worker_url, bridge_token, payload)
        mapped += 1

    if mapped == 0:
        raise RuntimeError("Не найдено ни одного принтера с поддерживаемой моделью 20024/20027. Проверь machine_type в логах.")
    LOG.info("Опрос завершён: отправлено состояний %s из %s принтеров", mapped, len(printers))


async def main() -> None:
    token = required("ANYCUBIC_TOKEN")
    worker_url = required("WORKER_URL")
    bridge_token = required("PRINTER_BRIDGE_TOKEN")
    poll_seconds = max(45, min(300, int(os.getenv("POLL_SECONDS", "60"))))

    timeout = aiohttp.ClientTimeout(total=35, connect=15, sock_read=25)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        # The package uses the Slicer Next token and its own maintained auth
        # implementation. No token is printed to logs.
        api = AnycubicAPI(session=session, cookie_jar=session.cookie_jar)
        api.set_authentication(auth_token=token, auth_mode=AnycubicAuthMode.SLICER)
        LOG.info("Проверяю авторизацию Anycubic Cloud…")
        valid = await api.check_api_tokens()
        if not valid:
            raise RuntimeError("Anycubic Cloud не принял токен. Получи свежий токен Slicer Next и обнови ANYCUBIC_TOKEN в Railway.")
        LOG.info("Авторизация Anycubic Cloud успешна. Интервал опроса: %s сек.", poll_seconds)

        while True:
            started = asyncio.get_running_loop().time()
            try:
                await collect_and_send(api, session, worker_url, bridge_token)
            except Exception as exc:
                # Keep the process alive and retry next cycle. Do not log
                # request headers, token values, or the whole auth object.
                LOG.exception("Ошибка цикла опроса: %s", exc)
            elapsed = asyncio.get_running_loop().time() - started
            await asyncio.sleep(max(5, poll_seconds - elapsed))


if __name__ == "__main__":
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stdout,
    )
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        LOG.info("Остановлено")
    except Exception as exc:
        LOG.error("Мост не запущен: %s", exc)
        raise
