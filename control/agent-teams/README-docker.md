# Agno Demo - Docker Setup

This directory contains Docker configuration for running the Agno Demo environment.

## Prerequisites

1. Docker and Docker Compose installed
2. OpenAI API key (required for all agents)
3. Exa API key (optional, for Exa MCP integration)

## Quick Start

1. **Set up environment variables:**

   ```bash
   export OPENAI_API_KEY="your-openai-api-key"
   export EXA_API_KEY="your-exa-api-key"  # Optional
   ```

2. **Build and run the demo:**

   ```bash
   docker-compose up --build
   ```

3. **Access the demo:**

   - AgentOS will be available at: http://localhost:7777
   - PostgreSQL will be available at: localhost:5532

## Manual Docker Build

If you prefer to build and run manually:

```bash
# Build the Docker image
docker build -t agno-demo .

# Run PostgreSQL container
docker run -d \
  --name agno-postgres \
  -e POSTGRES_USER=ai \
  -e POSTGRES_PASSWORD=ai \
  -e POSTGRES_DB=ai \
  -p 5532:5432 \
  agnohq/pgvector:18

# Run Agno Demo container
docker run -d \
  --name agno-demo \
  -e DATABASE_URL="postgresql+psycopg://ai:ai@host.docker.internal:5532/ai" \
  -e OPENAI_API_KEY="your-openai-api-key" \
  -e EXA_API_KEY="your-exa-api-key" \
  -p 7777:7777 \
  --link agno-postgres:postgres \
  agno-demo
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection URL | `postgresql+psycopg://ai:ai@postgres:5432/ai` |
| `OPENAI_API_KEY` | OpenAI API key (required) | - |
| `EXA_API_KEY` | Exa API key (optional) | - |
| `ENABLE_INIT` | Whether to run data initialization | `true` |

## Architecture

The Docker setup consists of two services:

1. **PostgreSQL with pgvector** (`agnohq/pgvector:18`)
   - Stores agent knowledge, learnings, and chat history
   - Provides vector search capabilities via pgvector extension
   - Exposed on port 5532 (host) → 5432 (container)

2. **Agno Demo Application**
   - Python 3.12 with all dependencies installed
   - Automatically loads demo data and knowledge on first run
   - Serves AgentOS on port 7777
   - Includes health checks for both services

## Data Initialization

On first run (when `ENABLE_INIT=true`), the container will:

1. Wait for PostgreSQL to be ready
2. Load F1 racing data for the Dash agent
3. Load knowledge bases for Dash and Scout agents
4. Start the AgentOS server

To skip initialization (e.g., on subsequent runs), set `ENABLE_INIT=false`.

## Connecting via AgentOS

Once the demo is running:

1. Open [os.agno.com](https://os.agno.com) in your browser
2. Click "Add AgentOS"
3. Add `http://localhost:7777` as an endpoint
4. Click "Connect"

## Troubleshooting

### Health Check Failures

If the health check fails, check the logs:

```bash
docker-compose logs agno-demo
```

Common issues:
- Missing `OPENAI_API_KEY` environment variable
- PostgreSQL not ready (wait for initialization)
- Network connectivity between containers

### Rebuilding the Image

To rebuild with changes:

```bash
docker-compose build --no-cache
docker-compose up
```

### Cleaning Up

To stop and remove all containers:

```bash
docker-compose down -v
```

## Development

For development with live code updates, the docker-compose.yml mounts the current directory as a volume. Changes to Python files will be reflected without rebuilding the container.

To disable volume mounting for production use, remove or comment out the volumes section in docker-compose.yml.