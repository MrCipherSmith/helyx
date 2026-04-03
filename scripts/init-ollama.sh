#!/bin/bash
# Wait for Ollama to be ready, then pull the embedding model

OLLAMA_URL="${OLLAMA_URL:-http://ollama:11434}"
MODEL="${EMBEDDING_MODEL:-nomic-embed-text}"

echo "[init-ollama] Waiting for Ollama at $OLLAMA_URL..."

until curl -sf "$OLLAMA_URL/api/tags" > /dev/null 2>&1; do
  sleep 2
done

echo "[init-ollama] Ollama is ready. Checking model $MODEL..."

if curl -sf "$OLLAMA_URL/api/tags" | grep -q "$MODEL"; then
  echo "[init-ollama] Model $MODEL already exists."
else
  echo "[init-ollama] Pulling $MODEL..."
  curl -sf "$OLLAMA_URL/api/pull" -d "{\"name\": \"$MODEL\"}"
  echo "[init-ollama] Model $MODEL pulled."
fi
