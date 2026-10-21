from django.urls import path, include
from rest_framework.routers import DefaultRouter

from .views import TaskViewSet, ScheduleViewSet

router = DefaultRouter()
router.register('tasks', TaskViewSet, basename='task')
router.register('schedules', ScheduleViewSet, basename='schedule')

urlpatterns = [
    path('', include(router.urls)),
]
