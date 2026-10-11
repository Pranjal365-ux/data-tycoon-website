# Single always-on container for Azure App Service, Azure Container Apps, or any VM.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATA_TYCOON_SERVE_STATIC=1 \
    PORT=8000 \
    WEB_CONCURRENCY=2

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY api ./api
COPY public ./public

RUN useradd --create-home appuser
USER appuser
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request,os;urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8000\")}/api/health',timeout=4)"

CMD ["sh", "-c", "gunicorn api.index:app -k api._worker.Worker -w ${WEB_CONCURRENCY} -b 0.0.0.0:${PORT} --timeout 30 --graceful-timeout 20 --forwarded-allow-ips='*'"]
