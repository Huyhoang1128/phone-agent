"""Bump ``token_version`` whenever a user's password changes.

Django has no built-in "password changed" signal, so we compare the stored
hash on ``pre_save``. This catches every path: the admin change form,
``manage.py changepassword``, shell ``set_password`` + ``save``, and any future
API. Bumping the epoch invalidates all of that user's outstanding JWTs.
"""
from django.contrib.auth.models import User
from django.db.models import F
from django.db.models.signals import pre_save
from django.dispatch import receiver

from .models import UserProfile


@receiver(pre_save, sender=User, dispatch_uid='users.bump_token_version_on_password_change')
def bump_token_version_on_password_change(sender, instance, **kwargs):
    if not instance.pk:
        return  # brand-new user — no prior password to compare against

    try:
        old_password = sender.objects.values_list('password', flat=True).get(pk=instance.pk)
    except sender.DoesNotExist:
        return

    if old_password == instance.password:
        return  # password unchanged — nothing to revoke

    # Password changed → invalidate every token this user still holds.
    # F() so we never clobber a concurrent bump; get_or_create covers users
    # that somehow lack a profile row.
    updated = UserProfile.objects.filter(user_id=instance.pk).update(
        token_version=F('token_version') + 1
    )
    if not updated:
        UserProfile.objects.get_or_create(user_id=instance.pk)
