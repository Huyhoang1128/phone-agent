import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Clapperboard, Sparkles, Video, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

type SampleCard = {
  title: string
  format: string
  hook: string
  structure: string[]
}

const SAMPLE_CARDS: SampleCard[] = [
  {
    title: 'Video vấn đề → giải pháp',
    format: '15-30 giây / lồng tiếng + phụ đề',
    hook: 'Nêu ngay nỗi đau của người xem trong 2 giây đầu.',
    structure: [
      'Mở đầu bằng một hook mạnh và một vấn đề thật rõ.',
      'Cho thấy sản phẩm hoặc workflow giải quyết vấn đề đó.',
      'Kết thúc bằng CTA trực tiếp hoặc bước tiếp theo.',
    ],
  },
  {
    title: 'Demo trước / sau',
    format: '20-45 giây / chia đôi màn hình',
    hook: 'Để kết quả nói lên sự khác biệt ngay lập tức.',
    structure: [
      'Bắt đầu bằng trạng thái “trước” hoặc điểm đang gây khó chịu.',
      'Trình bày sự thay đổi từng bước một.',
      'Nhấn mạnh cải thiện có thể đo lường ở cuối video.',
    ],
  },
  {
    title: 'Hướng dẫn mẹo nhanh',
    format: '30-60 giây / quay màn hình',
    hook: 'Mỗi video chỉ nên dạy một điều thật hữu ích.',
    structure: [
      'Giải thích bối cảnh bằng một câu ngắn gọn.',
      'Đi qua 3 thao tác hoặc mẹo thật súc tích.',
      'Kết bằng phần tóm tắt ngắn và CTA.',
    ],
  },
]

const STYLE_GUIDES = [
  {
    title: 'Phong cách dựng',
    items: ['Cắt cảnh nhanh và có chủ đích.', 'Dùng phụ đề lớn, tương phản cao.', 'Mỗi shot chỉ giữ một ý hình ảnh.'],
  },
  {
    title: 'Phong cách viết script',
    items: ['Mở bằng lợi ích, không phải tính năng.', 'Dùng câu ngắn và động từ trực tiếp.', 'Viết theo kiểu sẽ đọc thành lời nói.'],
  },
  {
    title: 'Checklist trước khi đăng',
    items: ['Kiểm tra tỷ lệ khung hình và vùng an toàn.', 'Đảm bảo phụ đề dễ đọc trên mobile.', 'Làm CTA thật rõ ở khung hình cuối.'],
  },
]

export default function VideoSamplePage() {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Clapperboard className="size-4" />
            <span>{t('nav.contentSamples')}</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('titles.contentSamples')}</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Trang tham chiếu nhanh cho các mẫu nội dung video phổ biến. Dùng chúng làm điểm bắt đầu khi viết nội dung mới hoặc lên kế hoạch cho video ngắn.
          </p>
        </div>

        <Button asChild variant="outline">
          <Link to="/content">
            <ArrowLeft className="mr-2 size-4" />
            {t('nav.content')}
          </Link>
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {SAMPLE_CARDS.map((sample) => (
          <article key={sample.title} className="rounded-2xl border border-border bg-card p-5 shadow-sm">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">{sample.title}</h2>
                <p className="mt-1 text-xs text-muted-foreground">{sample.format}</p>
              </div>
              <span className="rounded-full bg-primary/10 p-2 text-primary">
                <Video className="size-4" />
              </span>
            </div>

            <div className="space-y-4">
              <div className="rounded-xl bg-muted/40 p-3">
                <p className="text-xs font-medium text-foreground">Móc câu</p>
                <p className="mt-1 text-sm text-muted-foreground">{sample.hook}</p>
              </div>

              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Cấu trúc gợi ý
                </p>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  {sample.structure.map((step) => (
                    <li key={step} className="flex gap-2">
                      <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
                      <span>{step}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </article>
        ))}
      </div>

      <section className="grid gap-4 lg:grid-cols-3">
        {STYLE_GUIDES.map((guide) => (
          <div key={guide.title} className="rounded-2xl border border-border bg-background p-5">
            <div className="mb-3 flex items-center gap-2">
              <Wand2 className="size-4 text-primary" />
              <h2 className="font-semibold">{guide.title}</h2>
            </div>
            <ul className="space-y-2 text-sm text-muted-foreground">
              {guide.items.map((item) => (
                <li key={item} className="flex gap-2">
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-primary" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <div className="rounded-2xl border border-dashed border-border bg-muted/20 p-5 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">Mẹo</p>
        <p className="mt-1">
          Hãy dùng trang này như một tài liệu tham chiếu nhanh cho người viết nội dung và người dựng video. Nếu cần, có thể mở rộng sau bằng các mẫu tái sử dụng, ví dụ caption, hoặc mẫu video theo từng nền tảng.
        </p>
      </div>
    </div>
  )
}
