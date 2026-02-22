# Architecture

## Component Model

```mermaid
graph LR
  Client[Producers / Clients] --> API[API Fastify]
  API --> PG[(PostgreSQL)]
  API --> Redis[(Redis)]
  PG --> Publisher[Outbox Publisher]
  Publisher --> Rabbit[(RabbitMQ)]
  Rabbit --> Worker[Worker Pool]
  Worker --> PG
  Worker --> Rabbit
  API --> Metrics[/Metrics & Traces/]
  Publisher --> Metrics
  Worker --> Metrics
```

## Queue Topology

```mermaid
graph LR
  EX[events.exchange] --> MAIN[events.main]
  EX --> RETRY[events.retry]
  EX --> DLQ[events.dlq]
  RETRY --dead-letter--> EX
```

## Data Ownership

- PostgreSQL is the source of truth for `events`, idempotency keys, outbox, and processing attempts.
- Redis is an acceleration layer for hot dedupe and tenant rate limiting.
- RabbitMQ is the transport layer, not the persistence layer.

## Ordering Model

- Global ordering is not guaranteed.
- `partitionKey` is carried in message headers and payload to allow per-entity ordering strategies.
