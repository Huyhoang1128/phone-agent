"""URL patterns cho TikTok marketing/crawl app.

Chatbot TikTok endpoints (conversations, peer-mute, n8n callback) đã move sang
`chatbot/urls.py` trong Phase 2.6 refactor.
"""
from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import (
    GenerateCommentView,
    GenerateSceneVideoView,
    GenerateTextVideoView,
    GenvideoHighlightsView,
    GenvideoTodayVideosView,
    KeywordListViewSet,
    RecordVideoInteractionView,
    ScheduleTiktokVideoView,
    TextVideoTaskStatusView,
    TiktokChannelCrawlView,
    TiktokChannelKeywordExtractionView,
    TiktokChannelVideoProcessView,
    TiktokChannelVideoRepostView,
    TiktokVideoViewSet,
    UpdateChannelVideoContentView,
    UpdateCommentPlanByVideoLinkView,
    UpdateVideoContentView,
)

router = DefaultRouter()
router.register('tiktok/keyword-lists', KeywordListViewSet, basename='tiktok-keyword-lists')
router.register('tiktok', TiktokVideoViewSet, basename='tiktok')

urlpatterns = [
    path('tiktok/record-interaction/', RecordVideoInteractionView.as_view(), name='tiktok-record-interaction'),
    path('tiktok/update-content/', UpdateVideoContentView.as_view(), name='tiktok-update-content'),
    path('tiktok/channel-video/update-content/', UpdateChannelVideoContentView.as_view(), name='tiktok-channel-video-update-content'),
    path('tiktok/update-comment-plan/', UpdateCommentPlanByVideoLinkView.as_view(), name='tiktok-update-comment-plan'),
    path('tiktok/channel-crawl/', TiktokChannelCrawlView.as_view(), name='tiktok-channel-crawl'),
    path('tiktok/channel-extract-keywords/', TiktokChannelKeywordExtractionView.as_view(), name='tiktok-channel-extract-keywords'),
    path('tiktok/channel-videos/<int:pk>/process-video/', TiktokChannelVideoProcessView.as_view(), name='tiktok-channel-video-process'),
    path('tiktok/channel-videos/<int:pk>/repost/', TiktokChannelVideoRepostView.as_view(), name='tiktok-channel-video-repost'),
    path('tiktok/generate-text-video/', GenerateTextVideoView.as_view(), name='tiktok-generate-text-video'),
    path('tiktok/generate-scene-video/', GenerateSceneVideoView.as_view(), name='tiktok-generate-scene-video'),
    path('tiktok/text-video-task/<str:task_id>/', TextVideoTaskStatusView.as_view(), name='tiktok-text-video-task-status'),
    path('tiktok/schedule-tiktok-video/', ScheduleTiktokVideoView.as_view(), name='tiktok-schedule-tiktok-video'),
    path('tiktok/generate-comment/', GenerateCommentView.as_view(), name='tiktok-generate-comment'),
    path('tiktok/highlights/', GenvideoHighlightsView.as_view(), name='tiktok-highlights'),
    path('tiktok/today-videos/', GenvideoTodayVideosView.as_view(), name='tiktok-today-videos'),

    path('', include(router.urls)),
]
