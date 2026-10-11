"""Gunicorn worker for always-on hosting (Docker / Azure).

Keeps idle connections open for 75 s, longer than the 5 s player poll, so
clients never race the server closing a connection they are about to reuse.
Azure's front end keeps idle connections for 230 s, so 75 s is safe behind it.
"""

from uvicorn.workers import UvicornWorker


class Worker(UvicornWorker):
    CONFIG_KWARGS = {**UvicornWorker.CONFIG_KWARGS, "timeout_keep_alive": 75}
