#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
ENV_FILE="$PROJECT_DIR/.env"
IMAGE="stellar-dex-trading-scanner"
CONTAINER="stellar-scanner"
VOLUME="stellar-scanner-data"

usage() {
  cat <<'EOF'
Usage: ./scripts/stellar.sh COMMAND [docker logs options]

Commands:
  start      Start the existing container or build and create it
  stop       Stop the scanner gracefully
  restart    Restart the existing container
  recreate   Rebuild and recreate the container using the current .env
  status     Show container state and recent logs
  logs       Show the last 100 log lines; pass -f to follow
  report     Print an analytics report, optionally save it to a JSON file
  build      Build the Docker image
  check      Validate .env using the current project code in Docker
  help       Show this help
EOF
}

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is required but was not found in PATH." >&2
    exit 1
  fi
}

require_env() {
  if [ ! -f "$ENV_FILE" ]; then
    echo "Missing $ENV_FILE. Copy .env.example to .env and configure it first." >&2
    exit 1
  fi
}

container_exists() {
  docker container inspect "$CONTAINER" >/dev/null 2>&1
}

image_exists() {
  docker image inspect "$IMAGE" >/dev/null 2>&1
}

build_image() {
  docker build -t "$IMAGE" "$PROJECT_DIR"
}

run_container() {
  docker run -d \
    --name "$CONTAINER" \
    --restart unless-stopped \
    --env-file "$ENV_FILE" \
    -e STELLAR_DATABASE_PATH=/app/data/stellar-scanner.sqlite \
    -v "$VOLUME:/app/data" \
    "$IMAGE"
}

start_scanner() {
  require_env
  if container_exists; then
    state=$(docker container inspect -f '{{.State.Status}}' "$CONTAINER")
    if [ "$state" = "running" ]; then
      echo "$CONTAINER is already running."
    else
      docker start "$CONTAINER"
    fi
    return
  fi

  if ! image_exists; then
    build_image
  fi
  run_container
}

require_container() {
  if ! container_exists; then
    echo "Container $CONTAINER does not exist. Run '$0 start' first." >&2
    exit 1
  fi
}

run_report() {
  report_script='
    import Database from "better-sqlite3";
    import { buildObservationReport } from "./src/reporting/observation-report.ts";

    const database = new Database(process.env.STELLAR_DATABASE_PATH, {
      readonly: true,
      fileMustExist: true
    });
    try {
      const createReport = database.transaction(() =>
        buildObservationReport({
          database,
          portfolioId: process.env.STELLAR_PAPER_PORTFOLIO_ID ?? "default"
        })
      );
      console.log(JSON.stringify(createReport.deferred(), null, 2));
    } finally {
      database.close();
    }
  '
  if [ "$1" = "running" ]; then
    docker exec \
      -e STELLAR_DATABASE_PATH=/app/data/stellar-scanner.sqlite \
      "$CONTAINER" \
      node --import tsx -e "$report_script"
  else
    docker run --rm \
      --volumes-from "$CONTAINER" \
      --env-file "$ENV_FILE" \
      -e STELLAR_DATABASE_PATH=/app/data/stellar-scanner.sqlite \
      --entrypoint node \
      "$IMAGE" \
      --import tsx -e "$report_script"
  fi
}

require_docker
command_name=${1:-help}
if [ "$#" -gt 0 ]; then
  shift
fi

case "$command_name" in
  start)
    start_scanner
    ;;
  stop)
    require_container
    docker stop --time 30 "$CONTAINER"
    ;;
  restart)
    require_container
    docker restart "$CONTAINER"
    ;;
  recreate)
    require_env
    build_image
    if container_exists; then
      state=$(docker container inspect -f '{{.State.Status}}' "$CONTAINER")
      if [ "$state" = "running" ]; then
        docker stop --time 30 "$CONTAINER" >/dev/null
      fi
      docker rm "$CONTAINER" >/dev/null
    fi
    run_container
    ;;
  status)
    if container_exists; then
      docker container inspect \
        -f 'Container: {{.Name}}{{"\n"}}State: {{.State.Status}}{{"\n"}}Started: {{.State.StartedAt}}{{"\n"}}Restart policy: {{.HostConfig.RestartPolicy.Name}}' \
        "$CONTAINER"
      docker logs --tail 20 "$CONTAINER"
    else
      echo "$CONTAINER is not created."
    fi
    ;;
  logs)
    require_container
    if [ "$#" -eq 0 ]; then
      set -- --tail 100
    fi
    docker logs "$@" "$CONTAINER"
    ;;
  report)
    require_env
    require_container
    if [ "$#" -gt 1 ]; then
      echo "Usage: $0 report [OUTPUT.json]" >&2
      exit 2
    fi
    state=$(docker container inspect -f '{{.State.Status}}' "$CONTAINER")
    if [ "$#" -eq 1 ]; then
      run_report "$state" > "$1"
      echo "Observation report saved to $1" >&2
    else
      run_report "$state"
    fi
    ;;
  build)
    build_image
    ;;
  check)
    require_env
    build_image
    docker run --rm \
      --env-file "$ENV_FILE" \
      --entrypoint node \
      "$IMAGE" \
      --import tsx \
      -e 'import("./src/config/schema.ts").then(({ loadConfig }) => {
        const config = loadConfig();
        console.log(JSON.stringify({
          horizonUrl: config.horizonUrl,
          pairs: config.pairs,
          observationOnly: true
        }, null, 2));
      }).catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });'
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    echo "Unknown command: $command_name" >&2
    usage >&2
    exit 2
    ;;
esac
