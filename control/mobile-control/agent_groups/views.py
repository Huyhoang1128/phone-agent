import json
import logging
import os

import httpx
from django.db import models
from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.parsers import MultiPartParser, FormParser, JSONParser
from rest_framework.response import Response
from mbcontrol.mixins import OwnedResourceMixin
from .models import AgentGroup, AgentGroupMember, AgentGroupSharedMemory, AgentGroupSharedFile, AgentGroupSharedState, AgentGroupPlan
from .serializers import (
    AgentGroupSerializer,
    AgentGroupMemberSerializer,
    AgentGroupSharedMemorySerializer,
    AgentGroupSharedFileSerializer,
    AgentGroupSharedStateSerializer,
    AgentGroupPlanSerializer,
)

logger = logging.getLogger(__name__)


class AgentGroupViewSet(OwnedResourceMixin, viewsets.ModelViewSet):
    queryset = AgentGroup.objects.prefetch_related('members__device__profiles').all()
    serializer_class = AgentGroupSerializer
    permission_classes = [permissions.IsAuthenticated]

    def _check_edit_permission(self, request, group):
        if group.owner == request.user:
            return True
        from teams.models import TeamMembership
        team_ids_edit = TeamMembership.objects.filter(user=request.user).values_list('team_id', flat=True)
        return group.team_id in team_ids_edit and group.team_permission == 'edit'

    @action(detail=True, methods=['post'], url_path='members')
    def add_member(self, request, pk=None):
        group = self.get_object()
        if not self._check_edit_permission(request, group):
            return Response({'detail': 'Only the owner or a team editor can modify this group.'}, status=status.HTTP_403_FORBIDDEN)

        serializer = AgentGroupMemberSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        device = serializer.validated_data['device']

        # Verify device is accessible by this user
        from devices.models import Device
        from teams.models import TeamMembership
        user = request.user
        team_ids = TeamMembership.objects.filter(user=user).values_list('team_id', flat=True)
        if not Device.objects.filter(id=device.id).filter(
            models.Q(owner=user) | models.Q(team_id__in=team_ids)
        ).exists():
            return Response({'detail': 'Device not found or not accessible.'}, status=status.HTTP_404_NOT_FOUND)

        try:
            member = AgentGroupMember.objects.create(
                group=group,
                device=device,
                role=serializer.validated_data.get('role', 'worker'),
            )
        except Exception as exc:
            from django.db import IntegrityError
            if isinstance(exc, IntegrityError):
                return Response({'detail': 'Device is already in this group.'}, status=status.HTTP_400_BAD_REQUEST)
            raise

        return Response(AgentGroupMemberSerializer(member).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['delete', 'patch'], url_path=r'members/(?P<member_id>\d+)')
    def manage_member(self, request, pk=None, member_id=None):
        group = self.get_object()
        if not self._check_edit_permission(request, group):
            return Response({'detail': 'Only the owner or a team editor can modify this group.'}, status=status.HTTP_403_FORBIDDEN)

        try:
            member = AgentGroupMember.objects.get(id=member_id, group=group)
        except AgentGroupMember.DoesNotExist:
            return Response({'detail': 'Member not found.'}, status=status.HTTP_404_NOT_FOUND)

        if request.method == 'DELETE':
            member.delete()
            return Response(status=status.HTTP_204_NO_CONTENT)

        # PATCH – update role
        serializer = AgentGroupMemberSerializer(member, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)

    # ── AI Task Planning ──────────────────────────────────────────────────────

    def _build_planner_prompt(self, goal: str, agents: list) -> str:
        agents_desc = '\n'.join([
            f"- device_id={a['device_id']}: {a['device_name']} "
            f"(role={a['role']}, profile={a['profile_name'] or 'N/A'}, status={a['status']})"
            for a in agents
        ])
        return f"Goal: {goal}\n\nAvailable agents:\n{agents_desc}"

    def _call_planner_agent(self, prompt: str, auth_header: str, llm_model: str) -> list:
        """Call the planner agent in agent_teams and return the parsed plan list."""
        agent_teams_url = os.getenv('AGENT_TEAMS_URL', 'http://agent_teams:7777')
        url = f"{agent_teams_url}/v1/agents/planner/runs"
        headers = {'Content-Type': 'application/json'}
        if auth_header:
            headers['Authorization'] = auth_header

        payload = {
            'message': prompt,
            'stream': False,
        }
        if llm_model:
            payload['model'] = llm_model

        try:
            with httpx.Client(timeout=httpx.Timeout(60.0, connect=10.0)) as client:
                resp = client.post(url, json=payload, headers=headers)
                resp.raise_for_status()
                data = resp.json()
        except httpx.TimeoutException as exc:
            raise ValueError(f'Planner agent request timed out: {exc}') from exc
        except httpx.HTTPStatusError as exc:
            body_preview = ''
            try:
                body_preview = exc.response.text[:200]
            except Exception:
                pass
            raise ValueError(
                f'Planner agent returned HTTP {exc.response.status_code}'
                + (f': {body_preview}' if body_preview else '')
            ) from exc

        # AgentOS returns the agent response in the "content" field
        content = ''
        if isinstance(data, dict):
            content = data.get('content') or data.get('message') or ''
            # Handle nested message structures
            if not content and 'messages' in data:
                for msg in reversed(data['messages']):
                    if msg.get('role') == 'assistant':
                        content = msg.get('content', '')
                        break

        # Extract JSON from the content
        if not content:
            raise ValueError('Empty response from planner agent')

        # Strip markdown code fences if present
        text = content.strip()
        if text.startswith('```'):
            lines = text.splitlines()
            # Remove first and last fence lines
            inner = lines[1:-1] if lines[-1].strip() == '```' else lines[1:]
            text = '\n'.join(inner).strip()

        parsed = json.loads(text)
        return parsed.get('plan', [])

    def _call_openai_planner(self, goal: str, agents: list, llm_model: str) -> list:
        """Fallback: call OpenAI directly to generate a plan."""
        api_key = os.getenv('OPENAI_API_KEY')
        if not api_key:
            raise ValueError('OPENAI_API_KEY is not configured on the server.')

        agents_desc = '\n'.join([
            f"- device_id={a['device_id']}: {a['device_name']} "
            f"(role={a['role']}, profile={a['profile_name'] or 'N/A'})"
            for a in agents
        ])
        prompt = (
            f'You are a task planning AI for a group of mobile agents.\n\n'
            f'Overall goal: {goal}\n\n'
            f'Available agents:\n{agents_desc}\n\n'
            f'Create a specific, actionable task for each agent that collectively achieves the overall goal. '
            f"Tailor each task to the agent's role and profile.\n\n"
            f'Respond with a JSON object containing a "plan" key with an array of objects, '
            f'each having "device_id" (integer) and "task" (string) fields. Include all agents.'
        )

        from openai import OpenAI
        client = OpenAI(api_key=api_key)
        response = client.chat.completions.create(
            model=llm_model,
            messages=[
                {
                    'role': 'system',
                    'content': 'You are a task planning assistant. Always respond with valid JSON only.',
                },
                {'role': 'user', 'content': prompt},
            ],
            response_format={'type': 'json_object'},
            temperature=0.7,
        )
        content = response.choices[0].message.content
        parsed = json.loads(content)
        return parsed.get('plan', [])

    @action(detail=True, methods=['post'], url_path='plan')
    def plan(self, request, pk=None):
        """Use the planner agent (or OpenAI fallback) to generate a per-agent task plan."""
        group = self.get_object()
        goal = request.data.get('goal', '').strip()
        llm_model = request.data.get('llm_model', 'gpt-4o-mini')

        if not goal:
            return Response({'detail': 'goal is required.'}, status=status.HTTP_400_BAD_REQUEST)

        members = group.members.select_related('device').prefetch_related('device__profiles').all()
        agents = []
        for m in members:
            device = m.device
            first_profile = device.profiles.first()
            profile_name = first_profile.name if first_profile else ''
            agents.append({
                'device_id': device.id,
                'device_name': device.name,
                'role': m.role,
                'profile_name': profile_name,
                'status': device.status,
            })

        if not agents:
            return Response({'detail': 'No agents in this group.'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            # Try the planner agent in agent_teams first
            auth_header = request.META.get('HTTP_AUTHORIZATION', '')
            prompt = self._build_planner_prompt(goal, agents)
            raw_plan = self._call_planner_agent(prompt, auth_header, llm_model)
        except Exception as agent_exc:
            logger.warning(
                'Planner agent call failed for group %s (%s), falling back to OpenAI.',
                group.id,
                agent_exc,
            )
            try:
                raw_plan = self._call_openai_planner(goal, agents, llm_model)
            except Exception:
                logger.exception('Failed to generate task plan for group %s', group.id)
                return Response(
                    {'detail': 'Failed to generate task plan. Please try again.'},
                    status=status.HTTP_500_INTERNAL_SERVER_ERROR,
                )

        device_map = {a['device_id']: a for a in agents}
        valid_device_ids = set(device_map.keys())
        enriched = []
        for item in raw_plan:
            did = item.get('device_id')
            if did not in valid_device_ids:
                logger.warning(
                    'Plan for group %s contains unknown device_id %s — skipping.',
                    group.id,
                    did,
                )
                continue
            info = device_map[did]
            enriched.append({
                'device_id': did,
                'device_name': info['device_name'],
                'role': info['role'],
                'task': item.get('task', ''),
            })

        # Persist the plan for human approval
        plan_obj = AgentGroupPlan.objects.create(
            group=group,
            goal=goal,
            plan=enriched,
            status='pending',
            created_by=request.user,
        )

        return Response({'plan': enriched, 'plan_id': plan_obj.id})

    # ── Plan Management ────────────────────────────────────────────────────────

    @action(detail=True, methods=['get', 'post'], url_path='plans')
    def list_plans(self, request, pk=None):
        """GET: return all plans for this group. POST: save a pre-generated plan."""
        group = self.get_object()

        if request.method == 'POST':
            goal = request.data.get('goal', '').strip()
            plan = request.data.get('plan', [])
            if not goal:
                return Response({'detail': 'goal is required.'}, status=status.HTTP_400_BAD_REQUEST)
            plan_obj = AgentGroupPlan.objects.create(
                group=group,
                goal=goal,
                plan=plan,
                status='pending',
                created_by=request.user,
            )
            return Response(AgentGroupPlanSerializer(plan_obj).data, status=status.HTTP_201_CREATED)

        plans = AgentGroupPlan.objects.filter(group=group)
        return Response(AgentGroupPlanSerializer(plans, many=True).data)

    @action(detail=True, methods=['post'], url_path=r'plans/(?P<plan_id>\d+)/approve')
    def approve_plan(self, request, pk=None, plan_id=None):
        """Approve a pending plan."""
        group = self.get_object()
        try:
            plan_obj = AgentGroupPlan.objects.get(id=plan_id, group=group)
        except AgentGroupPlan.DoesNotExist:
            return Response({'detail': 'Plan not found.'}, status=status.HTTP_404_NOT_FOUND)

        if plan_obj.status != 'pending':
            return Response(
                {'detail': f"Plan is already {plan_obj.status}."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        plan_obj.status = 'approved'
        plan_obj.save(update_fields=['status', 'updated_at'])
        return Response(AgentGroupPlanSerializer(plan_obj).data)

    @action(detail=True, methods=['post'], url_path=r'plans/(?P<plan_id>\d+)/reject')
    def reject_plan(self, request, pk=None, plan_id=None):
        """Reject a pending plan."""
        group = self.get_object()
        try:
            plan_obj = AgentGroupPlan.objects.get(id=plan_id, group=group)
        except AgentGroupPlan.DoesNotExist:
            return Response({'detail': 'Plan not found.'}, status=status.HTTP_404_NOT_FOUND)

        if plan_obj.status != 'pending':
            return Response(
                {'detail': f"Plan is already {plan_obj.status}."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        plan_obj.status = 'rejected'
        plan_obj.save(update_fields=['status', 'updated_at'])
        return Response(AgentGroupPlanSerializer(plan_obj).data)

    # ── Shared Memory ──────────────────────────────────────────────────────────

    @action(detail=True, methods=['get', 'post'], url_path='shared-memory')
    def shared_memory_list(self, request, pk=None):
        group = self.get_object()
        if request.method == 'GET':
            items = AgentGroupSharedMemory.objects.filter(group=group)
            return Response(AgentGroupSharedMemorySerializer(items, many=True).data)

        if not self._check_edit_permission(request, group):
            return Response({'detail': 'Permission denied.'}, status=status.HTTP_403_FORBIDDEN)
        serializer = AgentGroupSharedMemorySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        key = serializer.validated_data['key']
        obj, _ = AgentGroupSharedMemory.objects.update_or_create(
            group=group, key=key,
            defaults={'value': serializer.validated_data.get('value', '')},
        )
        return Response(AgentGroupSharedMemorySerializer(obj).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['put', 'delete'], url_path=r'shared-memory/(?P<memory_id>\d+)')
    def shared_memory_detail(self, request, pk=None, memory_id=None):
        group = self.get_object()
        if not self._check_edit_permission(request, group):
            return Response({'detail': 'Permission denied.'}, status=status.HTTP_403_FORBIDDEN)
        try:
            obj = AgentGroupSharedMemory.objects.get(id=memory_id, group=group)
        except AgentGroupSharedMemory.DoesNotExist:
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
        if request.method == 'DELETE':
            obj.delete()
            return Response(status=status.HTTP_204_NO_CONTENT)
        serializer = AgentGroupSharedMemorySerializer(obj, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)

    # ── Shared Files ───────────────────────────────────────────────────────────

    @action(detail=True, methods=['get', 'post'], url_path='shared-files',
            parser_classes=[MultiPartParser, FormParser, JSONParser])
    def shared_files_list(self, request, pk=None):
        group = self.get_object()
        if request.method == 'GET':
            items = AgentGroupSharedFile.objects.filter(group=group)
            return Response(AgentGroupSharedFileSerializer(items, many=True, context={'request': request}).data)

        if not self._check_edit_permission(request, group):
            return Response({'detail': 'Permission denied.'}, status=status.HTTP_403_FORBIDDEN)
        serializer = AgentGroupSharedFileSerializer(data=request.data, context={'request': request})
        serializer.is_valid(raise_exception=True)
        obj = serializer.save(group=group)
        return Response(AgentGroupSharedFileSerializer(obj, context={'request': request}).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['delete'], url_path=r'shared-files/(?P<file_id>\d+)')
    def shared_files_detail(self, request, pk=None, file_id=None):
        group = self.get_object()
        if not self._check_edit_permission(request, group):
            return Response({'detail': 'Permission denied.'}, status=status.HTTP_403_FORBIDDEN)
        try:
            obj = AgentGroupSharedFile.objects.get(id=file_id, group=group)
        except AgentGroupSharedFile.DoesNotExist:
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
        obj.file.delete(save=False)
        obj.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    # ── Shared State ───────────────────────────────────────────────────────────

    @action(detail=True, methods=['get', 'post'], url_path='shared-state')
    def shared_state_list(self, request, pk=None):
        group = self.get_object()
        if request.method == 'GET':
            items = AgentGroupSharedState.objects.filter(group=group)
            return Response(AgentGroupSharedStateSerializer(items, many=True).data)

        if not self._check_edit_permission(request, group):
            return Response({'detail': 'Permission denied.'}, status=status.HTTP_403_FORBIDDEN)
        serializer = AgentGroupSharedStateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        key = serializer.validated_data['key']
        obj, _ = AgentGroupSharedState.objects.update_or_create(
            group=group, key=key,
            defaults={'value': serializer.validated_data.get('value', {})},
        )
        return Response(AgentGroupSharedStateSerializer(obj).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['put', 'delete'], url_path=r'shared-state/(?P<state_id>\d+)')
    def shared_state_detail(self, request, pk=None, state_id=None):
        group = self.get_object()
        if not self._check_edit_permission(request, group):
            return Response({'detail': 'Permission denied.'}, status=status.HTTP_403_FORBIDDEN)
        try:
            obj = AgentGroupSharedState.objects.get(id=state_id, group=group)
        except AgentGroupSharedState.DoesNotExist:
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
        if request.method == 'DELETE':
            obj.delete()
            return Response(status=status.HTTP_204_NO_CONTENT)
        serializer = AgentGroupSharedStateSerializer(obj, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)
