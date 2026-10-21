/**
 * Cất ảnh vào kho NGAY khi nó vừa hiện ra, để lúc bấm Lưu chỉ còn phải gửi URL.
 *
 * VẤN ĐỀ. `generate-image` chỉ trả về base64 (phần pre-upload đã bị bỏ khỏi luồng
 * sinh ảnh ở commit b4c71ea vì kho ảnh chậm làm treo luồng nóng). Nên tới lúc lưu,
 * frontend phải gửi lại toàn bộ base64 — mỗi ảnh 1024x1536 là 2,25 MB đi LÊN, mà
 * lên là chiều chậm nhất của đường truyền. Đo thực tế: 3 ảnh = 6,6 MB trong một
 * request, chờ 6–27 giây tuỳ băng thông, còn phần việc thật của server chỉ nửa
 * giây. Tức là ảnh đi qua mạng của người dùng HAI lần: một lần xuống lúc sinh,
 * một lần lên lúc lưu — dù server chính là nơi vừa tạo ra đúng những byte đó.
 *
 * CÁCH LÀM. Ảnh vừa hiện ra thì đẩy ngầm lên kho luôn (endpoint `store-image`),
 * trong lúc người dùng còn đang ngắm và chưa bấm gì. Đến lúc lưu, `storedRef()`
 * đưa ra URL và request lưu chỉ còn vài trăm byte — `create`/`add-media` cho URL
 * http(s) đi thẳng qua, không giải mã lại.
 *
 * Kho lỗi thì không sao: bản đồ không có entry, `storedRef()` trả lại chính data
 * URI và mọi thứ chạy y như trước — chậm, nhưng không sai.
 *
 * Bản đồ để ở tầng module (không phải trong component) để nó sống qua các lần
 * mount lại, và hai chỗ dùng cùng một ảnh thì không cất lên kho hai lần.
 */
import { contentsApi } from './api'
import { compressForUpload } from './image'

/** Thư mục trong kho. Chỉ ảnh hưởng đường dẫn file, không ảnh hưởng nội dung. */
export type StoreKind = 'media' | 'scenes' | 'source'

/** Chặn trên số entry giữ lại. Khoá của Map là chính chuỗi data URI (~2 MB mỗi
 *  ảnh) — chuỗi JS bất biến nên Map chỉ giữ con trỏ, không nhân bản, nhưng nếu
 *  không có chặn trên thì nó giữ cho chuỗi KHÔNG được thu hồi sau khi component
 *  đã bỏ state. Một lượt làm việc nhiều nhất khoảng 20 ảnh, 96 là dư. */
const MAX_ENTRIES = 96

/** data URI → URL trong kho. */
const stored = new Map<string, string>()
/** data URI → lượt upload đang bay (để không cất trùng, và để `waitForPrestore`
 *  chờ đúng những ảnh chưa xong). */
const inflight = new Map<string, Promise<void>>()

function remember(image: string, url: string): void {
  stored.set(image, url)
  // Map giữ đúng thứ tự chèn → key đầu tiên là cái cũ nhất.
  while (stored.size > MAX_ENTRIES) {
    const oldest: string | undefined = stored.keys().next().value
    if (oldest === undefined) break
    stored.delete(oldest)
  }
}

/** Đẩy ngầm một ảnh lên kho. Gọi bao nhiêu lần cũng được: ảnh đã cất hoặc đang
 *  bay thì bỏ qua. Không await, không báo lỗi ra giao diện — đây là việc chạy
 *  nền, thất bại chỉ có nghĩa "lúc lưu sẽ gửi base64 như cũ". */
export function prestoreImage(image: string, kind: StoreKind = 'scenes'): void {
  if (!image || !image.startsWith('data:')) return
  if (stored.has(image) || inflight.has(image)) return
  const job = (async () => {
    const payload = await compressForUpload(image)
    const { url } = await contentsApi.storeImage(payload, kind)
    if (url) remember(image, url)
  })()
    .catch(() => { /* kho lỗi/không với tới được → im lặng, xem docstring */ })
    .finally(() => { inflight.delete(image) })
  inflight.set(image, job)
}

/** Ảnh này nên gửi gì lên server: URL trong kho nếu đã cất, còn không thì chính
 *  nó (data URI) như trước. Dùng cho mọi chỗ gửi ảnh lên: lưu nhân vật, thêm
 *  ảnh, áp filter. */
export function storedRef(image: string): string {
  return stored.get(image) ?? image
}

/** Đã có URL trong kho cho ảnh này chưa. */
export function isStored(image: string): boolean {
  return stored.has(image)
}

/** Chờ những lượt cất kho còn đang bay của `images` trước khi lưu — chờ xong thì
 *  lưu bằng URL, khỏi phải gửi base64 (và khỏi tạo ra file rác thứ hai trong kho
 *  cho cùng một ảnh).
 *
 *  Có chặn thời gian: ảnh thường được cất xong từ lâu (sinh ảnh mất 20+ giây, cất
 *  kho mất dưới 1 giây), nên hàm này gần như luôn về ngay. Nếu kho đang chậm thì
 *  KHÔNG bắt người dùng chờ nó — hết `capMs` là lưu tiếp bằng base64. */
export async function waitForPrestore(images: string[], capMs = 4000): Promise<void> {
  const pending = images.map((i) => inflight.get(i)).filter(Boolean) as Promise<void>[]
  if (pending.length === 0) return
  await Promise.race([
    Promise.allSettled(pending),
    new Promise((resolve) => setTimeout(resolve, capMs)),
  ])
}
