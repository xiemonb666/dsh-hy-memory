"""``python -m hymem_worker`` — spawnable worker entry point.

The Host spawns this process, reads exactly **one** JSON line from stdout when
the listener is ready, then talks to it over loopback HTTP::

    {"port": 51234, "tokenSource": "file:C:\\...\\worker.token", "engine": "mock"}

Everything after that line is logging on stderr. The process serves until
SIGTERM/SIGINT, then shuts the HTTP server down and closes the engine.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import logging
import signal
import sys
import threading
from collections.abc import Sequence

from .engine import EngineError
from .server import (
    DEFAULT_PORT,
    DEFAULT_REQUEST_TIMEOUT,
    ENGINE_CHOICES,
    WorkerConfig,
    create_server,
    resolve_token,
    serve_forever,
)


def build_parser() -> argparse.ArgumentParser:
    """Build the CLI parser."""
    parser = argparse.ArgumentParser(
        prog="python -m hymem_worker",
        description="Loopback HyMemory worker (Bearer token, stdlib HTTP).",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help=f"loopback port to bind (0 picks a free port; default {DEFAULT_PORT})",
    )
    parser.add_argument(
        "--token-file",
        default=None,
        help="file holding the bearer token (falls back to HYMEM_WORKER_TOKEN)",
    )
    parser.add_argument(
        "--engine",
        choices=ENGINE_CHOICES,
        default="auto",
        help="auto = hy-memory when a model endpoint is configured, else mock",
    )
    parser.add_argument(
        "--data-dir",
        default=None,
        help="data directory handed to the SDK as MEMORY_DATA_DIR",
    )
    parser.add_argument(
        "--port-file",
        default=None,
        help="write the chosen port to this file once the listener is bound",
    )
    parser.add_argument(
        "--env-file",
        default=None,
        help=(
            "KEY=VALUE file loaded into the environment before the engine is built; "
            "used for the model/embedding endpoints so secrets never live in argv or git"
        ),
    )
    parser.add_argument(
        "--request-timeout",
        type=float,
        default=DEFAULT_REQUEST_TIMEOUT,
        help=f"per-connection socket timeout in seconds (default {DEFAULT_REQUEST_TIMEOUT})",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="stderr log level",
    )
    return parser


def _configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
    )


def _load_env_file(path: str) -> int:
    """Load ``KEY=VALUE`` pairs into ``os.environ`` without overriding real env.

    Parsing is deliberately small (no shell expansion, no ``export``): the file
    only ever holds the memory-engine endpoints and their keys. Existing
    environment variables win, and the host-owned ``HYMEM_MODEL_POLICY`` can
    never be introduced or overridden by this file. Returns the number of
    variables set.
    """
    import os

    loaded = 0
    try:
        with open(path, encoding="utf-8") as handle:
            for raw_line in handle:
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if not key:
                    continue
                if key.upper() == "HYMEM_MODEL_POLICY":
                    continue
                if key in os.environ:
                    continue
                os.environ[key] = value
                loaded += 1
    except OSError as exc:
        print(f"hymem_worker: cannot read env file {path}: {exc}", file=sys.stderr)
        return 0
    return loaded


def _install_signal_handlers(server: object) -> None:
    """Shut the server down on SIGTERM/SIGINT.

    ``shutdown()`` blocks until ``serve_forever`` returns, so it must run off the
    main thread; the handler only schedules it.
    """

    def _stop(_signum: int, _frame: object) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()  # type: ignore[attr-defined]

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _stop)
        except (ValueError, OSError):  # pragma: no cover - non-main thread
            continue


def main(argv: Sequence[str] | None = None) -> int:
    """Parse arguments, bind, announce readiness, then serve until signalled."""
    args = build_parser().parse_args(argv)

    # The readiness line is a machine-readable protocol on stdout: exactly one
    # JSON object, nothing else. ``hy_memory`` installs an *stdout* handler for
    # INFO logs, so stdout is redirected to stderr before the engine is built and
    # only the saved handle ever receives the announcement.
    readiness_stream = sys.stdout
    sys.stdout = sys.stderr
    _configure_logging(args.log_level)

    try:
        if args.env_file:
            loaded = _load_env_file(args.env_file)
            logging.getLogger("hymem_worker").info(
                "loaded %s variable(s) from %s", loaded, args.env_file
            )
        token_info = resolve_token(args.token_file)
        config = WorkerConfig(
            port=args.port,
            token=token_info.token,
            token_source=token_info.source,
            engine=args.engine,
            data_dir=args.data_dir,
            request_timeout=args.request_timeout,
        )
        server, selection = create_server(config)
    except EngineError as exc:
        print(f"hymem_worker: {exc.code}: {exc.message}", file=sys.stderr)
        return 2

    host, port = server.server_address[:2]
    engine_name = selection.engine.name

    if args.port_file:
        try:
            with open(args.port_file, "w", encoding="utf-8") as handle:
                handle.write(str(port))
        except OSError as exc:
            print(f"hymem_worker: cannot write port file: {exc}", file=sys.stderr)
            server.server_close()
            return 2

    readiness_stream.write(
        json.dumps(
            {
                "port": port,
                "tokenSource": token_info.source,
                "engine": engine_name,
            }
        )
        + "\n"
    )
    readiness_stream.flush()
    logging.getLogger("hymem_worker").info(
        "worker ready on http://%s:%s engine=%s (%s)",
        host,
        port,
        engine_name,
        selection.reason,
    )

    _install_signal_handlers(server)
    with contextlib.suppress(KeyboardInterrupt):  # pragma: no cover - SIGINT path
        serve_forever(server)
    return 0


if __name__ == "__main__":  # pragma: no cover - module entry
    raise SystemExit(main())
