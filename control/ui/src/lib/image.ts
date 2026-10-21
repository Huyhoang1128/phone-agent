/**
 * Tiện ích ảnh phía máy khách: đọc ảnh ra <img>, nén lại trước khi gửi lên
 * server, và dựng ảnh mẫu nhỏ cho dải filter.
 *
 * VÌ SAO PHẢI NÉN TRƯỚC KHI GỬI. Ảnh gpt-image trả về là PNG: một khung
 * 1024x1536 nặng 1,69 MB, bọc base64 thành 2,25 MB. Nhưng file CUỐI CÙNG nằm
 * trong kho lại là JPEG q95 (~470 KB) — tính lossless của PNG bị bỏ đi ngay lúc
 * lưu, nên gửi PNG lên chỉ là chở 4 lần số byte cần thiết qua chiều chậm nhất
 * của đường truyền. Đo trên một ảnh cảnh thật: nén q0.96 ở đây rồi để server nén
 * q95 như cũ lệch so với đường cũ trung bình 0,25% (0,63/255), lệch lớn nhất
 * 10/255, và chỉ 0,54% điểm ảnh lệch quá 3/255 — mắt không phân biệt được, đổi
 * lấy payload nhẹ 4 lần.
 *
 * Lưu ý: các hàm tải ảnh về máy trong QuickImagePage / FaceSwapWizardLegacy có
 * bộ helper canvas riêng và CỐ Ý không gộp vào đây — chúng phục vụ việc khác
 * (cắt tỉ lệ Facebook, gỡ C2PA khi tải xuống) và đang chạy đúng.
 */

/** Kích thước dài nhất được giữ khi gửi lên — khớp MEDIA_MAX_EDGE ở backend
 *  (content/views.py). Ảnh vượt mức này rồi cũng bị server co lại, nên co sẵn
 *  ở đây để khỏi chở phần thừa qua mạng. */
export const UPLOAD_MAX_EDGE = 4096

/** q0.96: xem đoạn đo ở đầu file. Cao hơn mức server dùng (q95) một nhịp để
 *  lần nén thứ hai của server không phải là lần nén thứ hai thật sự tệ hơn. */
export const UPLOAD_JPEG_QUALITY = 0.96

/** Đọc một data URI / URL ảnh thành <img> đã load xong. */
export async function loadImage(src: string): Promise<HTMLImageElement> {
  const im = new Image()
  im.crossOrigin = 'anonymous'
  await new Promise<void>((ok, err) => {
    im.onload = () => ok()
    im.onerror = () => err(new Error('Không đọc được ảnh.'))
    im.src = src
  })
  return im
}

/** Vẽ ảnh ra canvas (co lại nếu vượt maxEdge) rồi trả về data URI JPEG.
 *  Nền trắng vì JPEG không có kênh trong suốt. */
async function drawToJpeg(image: string, maxEdge: number, quality: number): Promise<string> {
  const im = await loadImage(image)
  const long = Math.max(im.naturalWidth, im.naturalHeight)
  const scale = long > maxEdge ? maxEdge / long : 1
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(im.naturalWidth * scale))
  c.height = Math.max(1, Math.round(im.naturalHeight * scale))
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.drawImage(im, 0, 0, c.width, c.height)
  return c.toDataURL('image/jpeg', quality)
}

/** Ảnh sắp gửi lên server → bản nhẹ hơn nhưng cùng kích thước hiển thị.
 *
 *  Trả về NGUYÊN ảnh cũ trong hai trường hợp, để không nén lại thứ đã nén:
 *   - không phải data URI (đã là URL trong kho rồi, chẳng có gì để gửi);
 *   - đã là JPEG/WebP và không vượt UPLOAD_MAX_EDGE (nén lại chỉ mất thêm chất
 *     lượng mà gần như không bớt được byte).
 *  Lỗi canvas (ảnh khác miền làm bẩn canvas) → trả ảnh gốc, coi như không nén. */
export async function compressForUpload(image: string): Promise<string> {
  if (!image.startsWith('data:')) return image
  const isPng = image.startsWith('data:image/png')
  try {
    const im = await loadImage(image)
    const tooBig = Math.max(im.naturalWidth, im.naturalHeight) > UPLOAD_MAX_EDGE
    if (!isPng && !tooBig) return image
    return await drawToJpeg(image, UPLOAD_MAX_EDGE, UPLOAD_JPEG_QUALITY)
  } catch {
    return image
  }
}

/** Ảnh mẫu nhỏ cho dải filter: gửi cái này lên thay cho ảnh full thì 13 filter
 *  cùng lúc chỉ tốn ~200 KB thay vì ~29 MB. Ném lỗi nếu không vẽ được (ảnh khác
 *  miền) — nơi gọi tự xử lý bằng cách gửi URL cho server tự tải. */
export async function thumbnailDataUri(image: string, maxEdge = 260, quality = 0.72): Promise<string> {
  return drawToJpeg(image, maxEdge, quality)
}
