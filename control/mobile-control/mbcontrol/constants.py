from django.db import models


class TeamPermission(models.TextChoices):
    VIEW = 'view', 'View'
    EDIT = 'edit', 'Edit'
