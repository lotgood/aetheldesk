FROM node:20-alpine AS frontend-build

WORKDIR /app

COPY package.json package-lock.json* vite.config.js /app/
COPY frontend /app/frontend
RUN npm ci && npm run build

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN python -m pip install --no-cache-dir -r /app/requirements.txt

COPY backend /app/backend
COPY frontend /app/frontend
COPY --from=frontend-build /app/frontend/dist /app/frontend/dist
RUN useradd --create-home --shell /usr/sbin/nologin appuser && chown -R appuser:appuser /app

WORKDIR /app/backend
USER appuser
EXPOSE 8000

CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
