from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import (
    CharacterScheduledPostViewSet,
    CharacterViewSet,
    ContentViewSet,
    CrawlContentSnapshotViewSet,
    CrawlSourceViewSet,
    media_proxy,
)

router = DefaultRouter()
router.register('contents', ContentViewSet, basename='content')
router.register('characters', CharacterViewSet, basename='character')
router.register('character-scheduled-posts', CharacterScheduledPostViewSet, basename='character-scheduled-post')
router.register('crawl-sources', CrawlSourceViewSet, basename='crawlsource')
router.register('crawl-content-snapshots', CrawlContentSnapshotViewSet, basename='crawlcontentsnapshot')

urlpatterns = [
    # Stream SeaweedFS media through this backend (see content.views.media_proxy).
    # <path:key> keeps the slashes so 'characters/source/xxx.jpg' arrives intact.
    path('media/<path:key>', media_proxy),
    path('', include(router.urls)),
]
