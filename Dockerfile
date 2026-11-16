FROM node:22-bookworm-slim AS frontend
WORKDIR /build
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim-bookworm
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/rushboard ./rushboard
COPY --from=frontend /build/dist ./frontend
USER 10001:10001
EXPOSE 8000
CMD ["uvicorn", "rushboard.main:app_factory", "--factory", "--host", "0.0.0.0", "--port", "8000"]
