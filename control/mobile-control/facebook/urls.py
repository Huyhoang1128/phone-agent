from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import (
    AnalyzeCompetitorView,
    CleanupPublishedMediaView,
    FacebookGroupPendingMemberPostViewSet,
    FacebookGroupPostSeedingActionViewSet,
    FacebookGroupPostViewSet,
    FacebookGroupScheduledPostViewSet,
    FacebookGroupViewSet,
    FacebookPageViewSet,
    FacebookPostViewSet,
    FacebookProfilePostSeedingActionViewSet,
    FacebookProfilePostViewSet,
    FacebookProfileScheduledMediaActionViewSet,
    FacebookProfileScheduledPostViewSet,
    FacebookProfileViewSet,
    FacebookScheduledPostViewSet,
    FbHackKeyViewSet,
    GenerateFacebookCommentView,
    RecordPostInteractionView,
)

router = DefaultRouter()
router.register('facebook/pages', FacebookPageViewSet, basename='facebook-pages')
router.register('facebook/groups', FacebookGroupViewSet, basename='facebook-groups')
router.register('facebook/profiles', FacebookProfileViewSet, basename='facebook-profiles')
router.register('facebook/posts', FacebookPostViewSet, basename='facebook-posts')
router.register('facebook/scheduled-posts', FacebookScheduledPostViewSet, basename='facebook-scheduled-posts')
router.register('facebook/group-posts', FacebookGroupPostViewSet, basename='facebook-group-posts')
router.register('facebook/group-scheduled-posts', FacebookGroupScheduledPostViewSet, basename='facebook-group-scheduled-posts')
router.register(
    'facebook/group-pending-member-posts',
    FacebookGroupPendingMemberPostViewSet,
    basename='facebook-group-pending-member-posts',
)
router.register('facebook/fb-hack-keys', FbHackKeyViewSet, basename='facebook-fb-hack-keys')
router.register('facebook/profile-posts', FacebookProfilePostViewSet, basename='facebook-profile-posts')
router.register('facebook/profile-scheduled-posts', FacebookProfileScheduledPostViewSet, basename='facebook-profile-scheduled-posts')
router.register(
    'facebook/profile-scheduled-media-actions',
    FacebookProfileScheduledMediaActionViewSet,
    basename='facebook-profile-scheduled-media-actions',
)
router.register(
    'facebook/profile-post-seeding-actions',
    FacebookProfilePostSeedingActionViewSet,
    basename='facebook-profile-post-seeding-actions',
)
router.register(
    'facebook/group-post-seeding-actions',
    FacebookGroupPostSeedingActionViewSet,
    basename='facebook-group-post-seeding-actions',
)

urlpatterns = [
    path('facebook/record-interaction/', RecordPostInteractionView.as_view(), name='facebook-record-interaction'),
    path('facebook/generate-comment/', GenerateFacebookCommentView.as_view(), name='facebook-generate-comment'),
    path('facebook/analyze-competitor/', AnalyzeCompetitorView.as_view(), name='facebook-analyze-competitor'),
    path('facebook/cleanup-published-media/', CleanupPublishedMediaView.as_view(), name='facebook-cleanup-published-media'),
    path('', include(router.urls)),
]
