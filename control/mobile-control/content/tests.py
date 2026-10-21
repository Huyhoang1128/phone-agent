from datetime import timedelta
from unittest.mock import Mock, patch

from django.contrib.auth.models import User
from django.test import SimpleTestCase, override_settings
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APITestCase

from .models import Content, CrawlContentSnapshot, CrawlRun, CrawlRunItem, CrawlSource, FeatureSystemPrompt
from .views import ContentViewSet


class CrawlSourceApiTests(APITestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username='owner', password='secret123')
        self.other = User.objects.create_user(username='other', password='secret123')
        self.client.force_authenticate(user=self.owner)

        self.source = CrawlSource.objects.create(
            owner=self.owner,
            url='https://example.com/source',
            source_type='web',
            crawl_frequency_minutes=60,
        )

        self.success_run = CrawlRun.objects.create(
            crawl_source=self.source,
            source_url=self.source.url,
            status='success',
            started_at=timezone.now() - timedelta(hours=2),
            finished_at=timezone.now() - timedelta(hours=2, minutes=-5),
            item_count=2,
            new_item_count=1,
            updated_item_count=1,
            triggered_by='scheduler',
        )
        self.failed_run = CrawlRun.objects.create(
            crawl_source=self.source,
            source_url=self.source.url,
            status='failed',
            started_at=timezone.now() - timedelta(hours=1),
            finished_at=timezone.now() - timedelta(hours=1, minutes=-2),
            item_count=1,
            error_message='network timeout',
            triggered_by='manual',
        )

        self.snapshot_one = CrawlContentSnapshot.objects.create(
            crawl_source=self.source,
            latest_run=self.failed_run,
            source_index_url=self.source.url,
            content_url='https://example.com/source/post-1',
            content_type='article',
            title='Alpha article',
            summary='Alpha summary',
            content_body='Alpha body',
            media_file_urls=['https://cdn.example.com/a.jpg'],
        )
        self.snapshot_two = CrawlContentSnapshot.objects.create(
            crawl_source=self.source,
            latest_run=self.success_run,
            source_index_url=self.source.url,
            content_url='https://example.com/source/post-2',
            content_type='video',
            title='Beta clip',
            summary='Beta summary',
            content_body='Beta body',
            media_file_urls=[],
        )
        CrawlRunItem.objects.create(crawl_run=self.success_run, snapshot=self.snapshot_one, is_new=True)
        CrawlRunItem.objects.create(crawl_run=self.success_run, snapshot=self.snapshot_two, is_updated=True)

    def test_crawl_source_detail_includes_rollup_stats(self):
        response = self.client.get(f'/api/crawl-sources/{self.source.id}/')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['snapshot_count'], 2)
        self.assertEqual(response.data['run_count'], 2)
        self.assertEqual(response.data['successful_run_count'], 1)
        self.assertEqual(response.data['failed_run_count'], 1)
        self.assertEqual(response.data['latest_run_status'], 'failed')
        self.assertEqual(response.data['latest_run_item_count'], 1)
        self.assertIsNotNone(response.data['last_success_at'])
        self.assertIsNotNone(response.data['last_failure_at'])

    def test_snapshots_action_supports_filters_and_pagination(self):
        response = self.client.get(
            f'/api/crawl-sources/{self.source.id}/snapshots/?search=Alpha&has_media=true&page_size=1'
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['count'], 1)
        self.assertEqual(len(response.data['results']), 1)
        self.assertEqual(response.data['results'][0]['title'], 'Alpha article')
        self.assertEqual(response.data['results'][0]['media_count'], 1)

    def test_runs_action_supports_status_filter(self):
        response = self.client.get(f'/api/crawl-sources/{self.source.id}/runs/?status=failed')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['count'], 1)
        self.assertEqual(response.data['results'][0]['status'], 'failed')
        self.assertEqual(response.data['results'][0]['error_message'], 'network timeout')

    def test_snapshot_detail_is_visible_when_user_has_same_source_url(self):
        CrawlSource.objects.create(
            owner=self.other,
            url=self.source.url,
            source_type='web',
            crawl_frequency_minutes=60,
        )

        self.client.force_authenticate(user=self.other)
        response = self.client.get(f'/api/crawl-content-snapshots/{self.snapshot_one.id}/')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['id'], self.snapshot_one.id)
        self.assertEqual(response.data['source_index_url'], self.source.url)


class ContentApiTests(APITestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username='owner-content', password='secret123')
        self.client.force_authenticate(user=self.owner)

    def test_create_content_accepts_optional_media_text_and_file_fields(self):
        response = self.client.post(
            '/api/contents/',
            {
                'title': 'Launch brief',
                'video_url': '',
                'image_urls': ['https://cdn.example.com/img1.jpg', 'https://cdn.example.com/img2.jpg'],
                'text_content': '',
                'file_url': None,
                'script': '',
            },
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['title'], 'Launch brief')
        self.assertEqual(
            response.data['image_urls'],
            ['https://cdn.example.com/img1.jpg', 'https://cdn.example.com/img2.jpg'],
        )
        self.assertEqual(response.data['text_content'], '')
        self.assertIsNone(response.data['file_url'])

        created = Content.objects.get(id=response.data['id'])
        self.assertEqual(
            created.image_urls,
            ['https://cdn.example.com/img1.jpg', 'https://cdn.example.com/img2.jpg'],
        )
        self.assertEqual(created.text_content, '')
        self.assertIsNone(created.file_url)

    def test_feature_system_prompt_returns_default_when_user_override_missing(self):
        response = self.client.get('/api/contents/feature-system-prompt/?feature_id=content_repost_ai')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['feature_id'], 'content_repost_ai')
        self.assertTrue(response.data['used_default'])
        self.assertTrue(response.data['is_default'])
        self.assertTrue(response.data['system_prompt'])

    def test_feature_system_prompt_put_creates_user_override(self):
        response = self.client.put(
            '/api/contents/feature-system-prompt/',
            {
                'feature_id': 'content_repost_ai',
                'system_prompt': 'Custom prompt for this user.',
            },
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['feature_id'], 'content_repost_ai')
        self.assertFalse(response.data['is_default'])

        prompt = FeatureSystemPrompt.objects.get(user=self.owner, feature_id='content_repost_ai')
        self.assertEqual(prompt.system_prompt, 'Custom prompt for this user.')

    @override_settings(OPENAI_API_KEY='test-key')
    @patch('openai.OpenAI')
    def test_ai_rewrite_repost_uses_user_prompt_override(self, mock_openai_cls):
        FeatureSystemPrompt.objects.create(
            user=self.owner,
            feature_id='content_repost_ai',
            system_prompt='User-specific rewrite prompt.',
        )

        mock_client = Mock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = Mock(
            choices=[Mock(message=Mock(content='Rewritten social post'))]
        )

        response = self.client.post(
            '/api/contents/ai-rewrite-repost/',
            {
                'feature_id': 'content_repost_ai',
                'mode': 'rewrite',
                'source_text': 'Old content',
            },
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['content'], 'Rewritten social post')
        self.assertFalse(response.data['used_default_prompt'])

        call_kwargs = mock_client.chat.completions.create.call_args.kwargs
        self.assertEqual(call_kwargs['messages'][0]['content'], 'User-specific rewrite prompt.')

    @override_settings(OPENAI_API_KEY='')
    def test_ai_rewrite_repost_returns_503_when_openai_missing(self):
        response = self.client.post(
            '/api/contents/ai-rewrite-repost/',
            {
                'mode': 'create',
                'source_text': 'Video title',
            },
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)


class ModerationAdviceTests(SimpleTestCase):
    """Lời khuyên sau khi bị OpenAI chặn phải theo ``moderation_stage``.

    ``output`` = OpenAI đã VẼ XONG rồi mới chấm ảnh kết quả là vi phạm, tức ảnh
    người dùng tải lên đã qua cửa kiểm duyệt bình thường. Bảo họ "đổi ảnh khác"
    lúc đó là chỉ sai đường — và vì stage=output nghĩa là ảnh đã được vẽ ra rồi
    mới vứt đi, mỗi vòng thử lại vô ích đều bị OpenAI tính tiền. Log prod ngày
    18/08/2026 có một người bị chặn 6 lần trong 84 giây vì đúng lời khuyên cũ.
    """

    class FakeOpenAIError(Exception):
        """Đúng hình dạng SDK ném ra: ``exc.body`` LÀ dict lỗi trong cùng."""

        def __init__(self, body=None, message='', request_id=''):
            self.body = body
            self.message = message
            self.request_id = request_id
            super().__init__(message)

        def __str__(self):
            return self.message

    def _blocked(self, stage=None):
        message = 'Your request was rejected by the safety system'
        body = {'code': 'moderation_blocked', 'message': message}
        if stage:
            body['moderation_details'] = {'moderation_stage': stage, 'categories': ['sexual']}
        return self.FakeOpenAIError(body=body, message=message, request_id='req_test123')

    def _advice(self, exc, op):
        return ContentViewSet()._image_failure_detail(exc, op, 'prompt', 'Tạo ảnh thất bại', False)

    def test_output_stage_tells_the_user_to_change_the_wording(self):
        advice = self._advice(self._blocked('output'), 'images.edit')
        self.assertIn('ẢNH KẾT QUẢ', advice)
        self.assertIn('đổi ảnh khác vẫn sẽ bị chặn', advice)

    def test_output_stage_on_generate_never_mentions_an_uploaded_photo(self):
        # Luồng generate chỉ có chữ, không có ảnh nào để mà "đổi".
        advice = self._advice(self._blocked('output'), 'images.generate')
        self.assertNotIn('tải lên', advice)
        self.assertIn('sửa phần mô tả', advice)

    def test_input_stage_still_tells_an_edit_user_to_change_the_photo(self):
        advice = self._advice(self._blocked('input'), 'images.edit')
        self.assertIn('từ chối chính tấm ảnh bạn tải lên', advice)

    def test_unknown_stage_keeps_the_previous_behaviour(self):
        self.assertEqual(
            self._advice(self._blocked(None), 'images.edit'),
            self._advice(self._blocked('input'), 'images.edit'),
        )

    def test_log_line_is_unchanged(self):
        self.assertEqual(
            ContentViewSet()._moderation_info(self._blocked('output')),
            'stage=output categories=sexual request_id=req_test123',
        )

    def test_a_non_moderation_error_still_shows_its_own_message(self):
        exc = self.FakeOpenAIError(
            body={'code': 'billing_hard_limit_reached', 'message': 'Billing hard limit has been reached'},
            message='Billing hard limit has been reached',
        )
        self.assertFalse(ContentViewSet()._is_moderation_blocked(exc))
        self.assertIn('Billing hard limit', self._advice(exc, 'images.generate'))


class FilterPreviewSizeTests(SimpleTestCase):
    """``apply_filter(max_edge=...)`` — ảnh mẫu nhỏ cho dải filter.

    Dải filter trong FilterPicker cần 13 ảnh mẫu một lúc. Trước đây mỗi filter
    trả về ảnh FULL (~470 KB) và chỉ khi người dùng bấm vào, nên 13 ô hiện y hệt
    nhau và người dùng báo "áp filter không được". max_edge là thứ làm cho 13 ô
    tải cùng lúc được.
    """

    def _png(self, size=(1024, 1536)):
        import io
        from PIL import Image
        buf = io.BytesIO()
        Image.new('RGB', size, (120, 90, 70)).save(buf, 'PNG')
        return buf.getvalue()

    def _size(self, raw):
        import io
        from PIL import Image
        return Image.open(io.BytesIO(raw)).size

    def test_max_edge_downscales_and_keeps_aspect_ratio(self):
        from .image_utils import apply_filter
        try:
            out = apply_filter(self._png(), 'clarendon', max_edge=260)
        except ImportError:
            self.skipTest('pilgram chưa được cài')
        self.assertEqual(self._size(out), (173, 260))

    def test_no_max_edge_keeps_the_full_size(self):
        from .image_utils import apply_filter
        try:
            out = apply_filter(self._png(), 'clarendon')
        except ImportError:
            self.skipTest('pilgram chưa được cài')
        self.assertEqual(self._size(out), (1024, 1536))

    def test_max_edge_never_enlarges_a_small_image(self):
        from .image_utils import apply_filter
        try:
            out = apply_filter(self._png((200, 200)), 'clarendon', max_edge=260)
        except ImportError:
            self.skipTest('pilgram chưa được cài')
        self.assertEqual(self._size(out), (200, 200))


class StoreImageApiTests(APITestCase):
    """``POST /contents/store-image/`` — cất ảnh vào kho để lúc lưu chỉ gửi URL.

    Không gọi kho thật: kho là service riêng, ở đây chỉ kiểm hợp đồng của endpoint
    (tham số upload, kind hợp lệ, lỗi kho không làm sập request thành 500).
    """

    URL = '/api/contents/store-image/'

    def setUp(self):
        self.user = User.objects.create_user(username='storer', password='secret123')
        self.client.force_authenticate(user=self.user)

    def test_uploads_with_the_same_params_as_saving_and_returns_the_url(self):
        # Trùng khít CharacterViewSet._upload_media_items — ảnh cất trước hay lưu
        # sau đều phải ra đúng một file như nhau, nếu lệch là ảnh cất trước bị
        # nén/co khác với ảnh lưu theo đường cũ.
        with patch('content.seaweedfs_utils.upload_character_image_to_seaweedfs') as up:
            up.return_value = 'https://media.example/characters/scenes/abc.jpg'
            res = self.client.post(self.URL, {'image': 'data:image/png;base64,AAAA', 'kind': 'scenes'}, format='json')
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertEqual(res.data['url'], 'https://media.example/characters/scenes/abc.jpg')
        self.assertEqual(up.call_args.kwargs['subfolder'], 'scenes')
        self.assertTrue(up.call_args.kwargs['sanitize'])
        self.assertEqual(up.call_args.kwargs['sanitize_quality'], 95)
        self.assertEqual(up.call_args.kwargs['sanitize_max_edge'], 4096)

    def test_defaults_to_scenes(self):
        with patch('content.seaweedfs_utils.upload_character_image_to_seaweedfs') as up:
            up.return_value = 'https://media.example/x.jpg'
            self.client.post(self.URL, {'image': 'data:image/png;base64,AAAA'}, format='json')
        self.assertEqual(up.call_args.kwargs['subfolder'], 'scenes')

    def test_rejects_an_unknown_kind(self):
        res = self.client.post(self.URL, {'image': 'data:image/png;base64,AAAA', 'kind': 'avatar'}, format='json')
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

    def test_requires_an_image(self):
        res = self.client.post(self.URL, {'kind': 'scenes'}, format='json')
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

    def test_a_broken_store_is_a_502_not_a_500(self):
        # Frontend coi lỗi ở đây là chuyện bình thường và tự quay về đường gửi
        # base64, nên nó phải là lỗi có mã đàng hoàng chứ không phải exception.
        with patch('content.seaweedfs_utils.upload_character_image_to_seaweedfs') as up:
            up.side_effect = RuntimeError('kho chết')
            res = self.client.post(self.URL, {'image': 'data:image/png;base64,AAAA'}, format='json')
        self.assertEqual(res.status_code, status.HTTP_502_BAD_GATEWAY)
