import hashlib
import logging
import uuid

from django.conf import settings

logger = logging.getLogger(__name__)

COLLECTION_NAME = 'tiktok_comments'
VECTOR_SIZE = 1536  # OpenAI text-embedding-3-small


def get_client():
    from qdrant_client import QdrantClient
    url = getattr(settings, 'QDRANT_URL', 'http://localhost:6333')
    api_key = getattr(settings, 'QDRANT_API_KEY', '') or None
    return QdrantClient(url=url, api_key=api_key, timeout=10)


def _point_id(video_id: int, cid: str) -> str:
    key = f'{video_id}:{cid}'
    return str(uuid.UUID(bytes=hashlib.md5(key.encode()).digest()))


def ensure_collection(client) -> None:
    from qdrant_client.models import Distance, PayloadSchemaType, VectorParams
    existing = {c.name for c in client.get_collections().collections}
    if COLLECTION_NAME not in existing:
        client.create_collection(
            collection_name=COLLECTION_NAME,
            vectors_config=VectorParams(size=VECTOR_SIZE, distance=Distance.COSINE),
        )
        logger.info('Created Qdrant collection: %s', COLLECTION_NAME)

    try:
        client.create_payload_index(
            collection_name=COLLECTION_NAME,
            field_name='video_id',
            field_schema=PayloadSchemaType.INTEGER,
        )
    except Exception:
        pass  # Index already exists — safe to ignore.


def get_video_points(client, video_id: int) -> list[dict]:
    """Return cached cluster points rebuilt from payload (x, y, cluster, text).
    Does NOT fetch the 1536d vector — not needed for visualization.
    """
    from qdrant_client.models import FieldCondition, Filter, MatchValue

    records, _ = client.scroll(
        collection_name=COLLECTION_NAME,
        scroll_filter=Filter(
            must=[FieldCondition(key='video_id', match=MatchValue(value=video_id))]
        ),
        limit=10_000,
        with_payload=True,
        with_vectors=False,
    )

    return [
        {
            'cid': (record.payload or {}).get('cid', ''),
            'text': (record.payload or {}).get('text', ''),
            'normalized_text': (record.payload or {}).get('normalized_text', ''),
            'cluster': (record.payload or {}).get('cluster', -1),
            'x': (record.payload or {}).get('x', 0.0),
            'y': (record.payload or {}).get('y', 0.0),
        }
        for record in records
    ]


def upsert_video_points(
    client,
    video_id: int,
    points: list[dict],
    embeddings: list[list[float]],
) -> None:
    """Upsert comment vectors for a video.

    points     — cluster API result (contains x, y, cluster, cid, text, …)
    embeddings — parallel list of 1536-dim OpenAI vectors (same order as points)
    """
    from qdrant_client.models import FieldCondition, Filter, FilterSelector, MatchValue, PointStruct

    if len(points) != len(embeddings):
        logger.warning(
            'upsert_video_points: length mismatch points=%d embeddings=%d for video_id=%d — skipping',
            len(points), len(embeddings), video_id,
        )
        return

    # Delete stale data for this video before re-inserting.
    client.delete(
        collection_name=COLLECTION_NAME,
        points_selector=FilterSelector(
            filter=Filter(
                must=[FieldCondition(key='video_id', match=MatchValue(value=video_id))]
            )
        ),
    )

    structs = []
    for idx, (point, vector) in enumerate(zip(points, embeddings)):
        x = point.get('x')
        y = point.get('y')
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
            continue

        cid = str(point.get('cid') or '')
        point_id = _point_id(video_id, cid) if cid else _point_id(video_id, str(idx))

        cluster = point.get('cluster')
        structs.append(PointStruct(
            id=point_id,
            vector=vector,
            payload={
                'video_id': video_id,
                'cid': cid,
                'text': str(point.get('text') or ''),
                'normalized_text': str(point.get('normalized_text') or ''),
                'cluster': int(cluster) if isinstance(cluster, (int, float)) else -1,
                # x, y stored in payload so cache hit can rebuild points without re-embedding
                'x': float(x),
                'y': float(y),
            },
        ))

    if structs:
        client.upsert(collection_name=COLLECTION_NAME, points=structs)
        logger.info('Upserted %d comment vectors (1536d) for video_id=%d', len(structs), video_id)
