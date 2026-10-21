# Dockerfile for Agno Demo Environment
FROM python:3.12-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    libpq-dev \
    curl \
    postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY requirements.txt /app/

# Install uv for faster package management (as used in demo_setup.sh)

# Install all dependencies from requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application
COPY . /app/


# Expose the AgentOS port (default is 7777 as per README)
EXPOSE 7777


# Set entrypoint to run the application
ENTRYPOINT ["python", "-m", "run"]
