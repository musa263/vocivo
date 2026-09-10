from __future__ import annotations

import asyncio
import logging
import signal

from .api import VocivoApi
from .brain import Brain
from .call import CallHandler
from .config import Settings
from .esl import EslConnection
from .speech import Ears, Voice

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
# HTTP client info logs include query strings containing caller numbers.
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("vocivo.receptionist")


async def serve() -> None:
    settings = Settings.from_env()
    missing = settings.missing()
    if missing:
        # Fail at start-up rather than halfway through a stranger's call.
        raise SystemExit(f"the receptionist cannot start without: {', '.join(missing)}")

    voice = Voice(settings)
    ears = Ears(settings)
    brain = Brain(settings)
    api = VocivoApi(settings)
    handler = CallHandler(settings, voice, ears, brain, api)

    calls: set[asyncio.Task] = set()
    server = None
    janitor: asyncio.Task | None = None
    loop = asyncio.get_running_loop()
    stopping = asyncio.Event()
    registered_signals = []

    async def on_connection(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        calls.add(task)
        connection = EslConnection(reader, writer)
        try:
            if stopping.is_set():
                return
            await handler.handle(connection)
        except Exception:
            log.exception("unhandled error on a call")
        finally:
            await connection.close()
            calls.discard(task)

    try:
        log.info("warming the speech recogniser")
        await ears.warm()
        # Rendered prompts accumulate on the same disk the switch runs on, so
        # they are swept on a timer for as long as the service is up.
        janitor = asyncio.create_task(voice.run_cache_janitor())
        server = await asyncio.start_server(on_connection, settings.listen_host, settings.listen_port)
        where = ", ".join(str(socket.getsockname()) for socket in server.sockets or [])
        log.info("receptionist listening for FreeSWITCH on %s", where)
        for name in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(name, stopping.set)
            registered_signals.append(name)
        await stopping.wait()
    finally:
        stopping.set()
        if janitor is not None:
            janitor.cancel()
            await asyncio.gather(janitor, return_exceptions=True)
        if server is not None:
            server.close()
            await server.wait_closed()
        # Let admitted callbacks register before taking the shutdown snapshot.
        await asyncio.sleep(0)
        await drain_calls(calls)
        for name in registered_signals:
            loop.remove_signal_handler(name)
        # Calls finish filing their transcripts before their HTTP clients close.
        await asyncio.gather(voice.close(), brain.close(), api.close(), return_exceptions=True)


async def drain_calls(calls: set[asyncio.Task], grace_seconds: float = 5.0) -> None:
    if not calls:
        return
    _, pending = await asyncio.wait(tuple(calls), timeout=grace_seconds)
    for task in pending:
        task.cancel()
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)


def run() -> None:
    try:
        asyncio.run(serve())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    run()
