FROM python:3.12-slim

WORKDIR /app/services/data_api
COPY services/data_api/pyproject.toml ./
COPY services/data_api/app ./app
RUN pip install --no-cache-dir .

WORKDIR /app
COPY semantic ./semantic
ENV VEHICLE_SEMANTIC_ROOT=/app/semantic
EXPOSE 8090
CMD ["uvicorn", "app.main:app", "--app-dir", "/app/services/data_api", "--host", "0.0.0.0", "--port", "8090"]
