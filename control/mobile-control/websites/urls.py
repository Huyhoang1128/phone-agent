from rest_framework.routers import DefaultRouter

from .views import WebsitePostViewSet, WebsiteViewSet

router = DefaultRouter()
router.register('websites', WebsiteViewSet, basename='website')
router.register('website-posts', WebsitePostViewSet, basename='website-post')

urlpatterns = router.urls
