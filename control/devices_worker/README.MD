## devices_worker

Kafka consumer service that listens on the `device-events` topic and keeps
an authoritative set of currently-connected ADB device serials in Redis.

### Event format

Producers (e.g. an `adb devices` poller running on a host machine) publish
JSON messages like:

```json
{"event": "connected",    "serial": "emulator-5554"}
{"event": "disconnected", "serial": "emulator-5554"}
```

### Behavior

* `connected`     → `SADD connected_devices <serial>`
* `disconnected`  → `SREM connected_devices <serial>`

The Django backend exposes `GET /api/devices/connected/` which reads this
Redis set so that the UI can show the currently-plugged devices when adding
a new device.

### Environment variables

| Var                            | Default                  | Description                              |
|--------------------------------|--------------------------|------------------------------------------|
| `KAFKA_BOOTSTRAP_SERVERS`      | `localhost:9094`     | Kafka cluster bootstrap address          |
| `KAFKA_DEVICE_EVENTS_TOPIC`    | `device-events`          | Topic to consume                         |
| `KAFKA_DEVICES_WORKER_GROUP`   | `devices-worker`         | Consumer group id                        |
| `REDIS_URL`                    | `redis://redis:6379/0`   | Redis connection URL                     |
| `REDIS_DEVICES_KEY`            | `connected_devices`      | Set key for tracking connected serials   |

### Run locally

```bash
pip install -r requirements.txt
KAFKA_BOOTSTRAP_SERVERS=localhost:9094 \
KAFKA_DEVICE_EVENTS_TOPIC=device-events \
REDIS_URL=redis://localhost:6380/0 \
faststream run main:app
```
