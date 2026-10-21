"""Chọn credential AI (OpenAI / fal.ai) theo CÔNG TY của người dùng.

Một máy chủ đang phục vụ nhiều công ty, mỗi công ty tự trả tiền bằng key riêng.
Module này là NƠI DUY NHẤT biết "request này dùng key nào" — mọi chỗ khác gọi vào
đây thay vì đọc thẳng ``settings.OPENAI_API_KEY``. Gom về một chỗ vì cái khác nhau
giữa hai công ty chỉ là một giá trị cấu hình, không phải logic nghiệp vụ: nhân đôi
code sinh ảnh thì mỗi lần sửa lỗi phải sửa hai lần và sẽ có lúc quên một bên.

KEY nằm trong biến môi trường, KHÔNG nằm trong DB — cùng cách project đang làm với
INPAINT_API_URL / UPSCALE_API_URL / FAL_KEY. Một key lọt vào DB là lọt vào mọi bản
dump và mọi endpoint đọc DB, lại phải mã hoá và phải chặn quyền xem. Xem
``settings.AI_TENANT_OPENAI_KEYS`` / ``AI_TENANT_FAL_KEYS`` để biết cú pháp.

Việc GÁN tài khoản vào công ty thì NGƯỢC LẠI, nằm trong DB
(``users.UserProfile.ai_tenant``): nó đổi thường xuyên hơn key và phải sửa được ngay
trong Django admin, không cần deploy lại.

Quy tắc quan trọng — KHÔNG fallback khi công ty thiếu key: tài khoản đã gán công ty
mà công ty đó không có key thì báo lỗi, chứ không âm thầm dùng key mặc định. Rơi về
key mặc định nghĩa là tính tiền sang công ty khác — sai tiền một cách im lặng, kiểu
lỗi tệ nhất vì không ai phát hiện ra cho tới lúc đối chiếu hoá đơn.
"""
import hashlib
import logging

from django.conf import settings

logger = logging.getLogger(__name__)

# Tiền tố cố định để lọc log nhanh:  docker compose logs -f backend | grep AI-KEY
LOG_TAG = 'AI-KEY'


def key_fingerprint(key: str) -> str:
    """10 ký tự băm của key — đủ để ĐỐI CHIẾU hai key có giống nhau không, mà không lộ key.

    Log ra chính key (dù chỉ vài ký tự đầu) là hỏng: key OpenAI có tiền tố chung
    ``sk-proj-`` nên vài ký tự đầu chẳng phân biệt được gì, còn vài ký tự cuối thì lại
    là phần bí mật thật. Băm giải quyết cả hai.
    """
    if not key:
        return '(rỗng)'
    return hashlib.sha256(key.encode()).hexdigest()[:10]

# Tài khoản chưa gán công ty → dùng key mặc định (OPENAI_API_KEY / FAL_KEY), tức là
# hành vi y như trước khi có module này. Nhờ vậy việc thêm module không đổi gì với
# các tài khoản đang chạy.
DEFAULT_TENANT = ''


def tenant_of(user) -> str:
    """Slug công ty của ``user`` — '' nếu chưa gán (hoặc user rỗng/chưa đăng nhập).

    Đọc từ ``UserProfile.ai_tenant``. Không có profile cũng trả '' chứ không nổ:
    profile được tạo lười ở nhiều luồng, và thiếu profile chỉ nghĩa là "chưa gán
    công ty", không phải lỗi.
    """
    if user is None or not getattr(user, 'is_authenticated', False):
        return DEFAULT_TENANT
    profile = getattr(user, 'profile', None)
    if profile is None:
        return DEFAULT_TENANT
    return (getattr(profile, 'ai_tenant', '') or '').strip()


def _key_for(user, mapping_name: str, default_setting: str, service: str, purpose: str) -> str:
    """Tra key theo công ty của ``user``; '' khi thiếu. Ghi log MỖI LẦN tra.

    Trả '' thay vì nổ exception là có chủ đích: mọi nơi gọi đều đã có sẵn nhánh xử
    lý "key rỗng" (báo 503 / bỏ qua bước dịch prompt), nên fail-closed vừa đúng vừa
    không phải sửa luồng lỗi ở 6 chỗ. Dùng ``missing_key_detail()`` để lấy câu lỗi
    nói rõ thiếu key của công ty nào.

    Log một dòng cho mỗi lần tra là CỐ Ý: đây là điểm quyết định "tiền vào hoá đơn
    của ai", nên phải kiểm chứng được từ bên ngoài chứ không chỉ tin vào code.
    """
    who = getattr(user, 'username', None) or '(chưa đăng nhập)'
    tenant = tenant_of(user)

    if not tenant:
        key = (getattr(settings, default_setting, '') or '').strip()
        logger.info(
            '%s | %s | user=%s | cong-ty=(chưa gán) | viec=%s | key=%s | nguon=%s (mặc định)%s',
            LOG_TAG, service, who, purpose or '?', key_fingerprint(key), default_setting,
            '' if key else '  ⚠ SERVER CHƯA CÓ KEY MẶC ĐỊNH',
        )
        return key

    mapping = getattr(settings, mapping_name, None) or {}
    key = (mapping.get(tenant) or '').strip()
    if not key:
        # Mức error: lỗi cấu hình server, người dùng không tự sửa được. KHÔNG rơi về
        # key mặc định — rơi về mặc định là tính tiền sang công ty khác.
        logger.error(
            '%s | %s | user=%s | cong-ty=%s | viec=%s | key=THIẾU | nguon=TỪ CHỐI — '
            'chưa khai công ty %r trong %s (đang có: %s)',
            LOG_TAG, service, who, tenant, purpose or '?', tenant, mapping_name,
            ', '.join(sorted(mapping)) or '(chưa có công ty nào)',
        )
        return ''

    logger.info(
        '%s | %s | user=%s | cong-ty=%s | viec=%s | key=%s | nguon=%s',
        LOG_TAG, service, who, tenant, purpose or '?', key_fingerprint(key), mapping_name,
    )
    return key


def openai_key_for(user, purpose: str = '') -> str:
    """Key OpenAI dùng cho ``user``. '' nghĩa là thiếu → nơi gọi phải từ chối.

    ``purpose`` chỉ để ghi log ('sinh-ảnh', 'dịch-prompt'…) — một lượt sinh ảnh gọi
    OpenAI vài lần, không ghi việc gì thì đọc log không biết dòng nào là dòng nào.
    """
    return _key_for(user, 'AI_TENANT_OPENAI_KEYS', 'OPENAI_API_KEY', 'openai', purpose)


def fal_key_for(user, purpose: str = '') -> str:
    """Key fal.ai (Grok / Seedream) dùng cho ``user``. '' nghĩa là thiếu."""
    return _key_for(user, 'AI_TENANT_FAL_KEYS', 'FAL_KEY', 'fal.ai', purpose)


def missing_key_detail(user, service: str = 'OpenAI') -> str:
    """Câu lỗi tiếng Việt nói rõ THIẾU KEY CỦA AI, để người vận hành biết sửa ở đâu.

    Tài khoản chưa gán công ty thì thiếu key nghĩa là thiếu key mặc định của server
    — câu lỗi khác hẳn, nên tách hai trường hợp.
    """
    tenant = tenant_of(user)
    if tenant:
        return (
            f'Công ty «{tenant}» chưa được cấu hình key {service} trên máy chủ. '
            'Liên hệ bộ phận kỹ thuật để bổ sung key cho công ty này.'
        )
    return f'Dịch vụ sinh ảnh ({service}) chưa được cấu hình trên máy chủ.'
