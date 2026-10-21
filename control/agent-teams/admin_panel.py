"""
SQLAdmin panel setup
=====================

Provides a web-based administration interface for managing database models.
Authentication is performed using credentials from environment variables:
  - USERNAME_ADMIN
  - PASSWORD_ADMIN
"""

import logging
import os

from sqladmin import Admin, ModelView
from sqladmin.authentication import AuthenticationBackend
from starlette.requests import Request

from models import UserTool, get_engine

logger = logging.getLogger(__name__)


class AdminAuthBackend(AuthenticationBackend):
    """Simple username/password authentication for the admin panel."""

    async def login(self, request: Request) -> bool:
        form = await request.form()
        username = form.get("username", "")
        password = form.get("password", "")
        expected_username = os.getenv("USERNAME_ADMIN", "")
        expected_password = os.getenv("PASSWORD_ADMIN", "")
        if not expected_username or not expected_password:
            logger.warning(
                "Admin login attempted but USERNAME_ADMIN / PASSWORD_ADMIN "
                "environment variables are not configured. Login is disabled."
            )
            return False
        if username == expected_username and password == expected_password:
            request.session.update({"admin_authenticated": True})
            return True
        return False

    async def logout(self, request: Request) -> bool:
        request.session.clear()
        return True

    async def authenticate(self, request: Request) -> bool:
        return bool(request.session.get("admin_authenticated", False))


class UserToolAdmin(ModelView, model=UserTool):
    name = "User Tool"
    name_plural = "User Tools"
    icon = "fa-solid fa-wrench"
    column_list = [
        UserTool.id,
        UserTool.user_id,
        UserTool.tool_name,
        UserTool.enabled,
        UserTool.created_at,
        UserTool.updated_at,
    ]
    column_searchable_list = [UserTool.user_id, UserTool.tool_name]
    column_sortable_list = [
        UserTool.id,
        UserTool.user_id,
        UserTool.tool_name,
        UserTool.enabled,
        UserTool.created_at,
        UserTool.updated_at,
    ]
    # Exclude raw params from all views to prevent accidental exposure of secrets
    column_details_exclude_list = [UserTool.params]
    form_excluded_columns = [UserTool.params]


def setup_admin(app) -> Admin:
    """Mount the SQLAdmin interface onto *app* and return the Admin instance."""
    secret_key = os.getenv("SECRET_KEY")
    if not secret_key:
        logger.warning(
            "SECRET_KEY environment variable is not set. "
            "A random key will be used, which means admin sessions will be "
            "invalidated on every application restart."
        )
        secret_key = os.urandom(32).hex()
    authentication_backend = AdminAuthBackend(secret_key=secret_key)
    admin = Admin(
        app=app,
        engine=get_engine(),
        authentication_backend=authentication_backend,
        title="MyAgent Admin",
    )
    admin.add_view(UserToolAdmin)
    return admin
