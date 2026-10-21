/**
 * Option-based prompt builder for the "Tạo ảnh nhanh" flow — a TS port of the
 * mika-lab bench (`mika-lab/mika_prompt.py`). Every character/scene trait is a
 * dropdown whose value is a ready-made English phrase, so the prompt is assembled
 * by plain concatenation with no LLM call. Labels are Vietnamese (what the user
 * picks); values are English (what the model reads).
 *
 * Each field: { key, label, opts: [ [vi_label, en_phrase], … ] }; opts[0] is the
 * default. Character traits build a front portrait (text-to-image); scene traits
 * build a prompt that keeps the chosen face (reference-guided edit).
 */
import type { ImageProvider, OpenAIImageSize } from './types'

/** Every field is a dropdown of suggestions PLUS a free-text box: picking «✎ Tự nhập…»
 *  in the select reveals an input whose text is used verbatim in the prompt.
 *  A selection value that matches no option IS the custom one — no extra state needed. */
export type QuickField = { key: string; label: string; opts: [string, string][] }
export type QuickSelection = Record<string, string>

// Skin finish. Shared by BOTH the character portrait and the scene, because a
// reference-guided edit will happily smooth the face back out if the scene prompt
// says nothing about texture. Every option is written in POSITIVE material terms
// (dry / powdery / dull / pores casting shadows) — never "no shine", "not oily":
// the models have no negative_prompt, so those words only summon what they forbid.
// [nhãn tiếng Việt, câu gửi cho model (EN), bản dịch để người dùng đọc (VI)]
const SKIN_TEX: [string, string, string][] = [
  ['Thô rõ (lỗ chân lông, mụn)',
    'Her skin is bare, dry and powdery, and clearly textured: open pores across her nose and cheeks catch the ' +
    'light from the side and cast tiny shadows, the surface is slightly rough and uneven, blotchy in patches, ' +
    'with a few small pimples and dark spots on her chin, faint freckles, redness around the nostrils, fine ' +
    'peach-fuzz along the jawline, under-eye shadows, fine lines and dry chapped lips. The surface is rough, ' +
    'chalky and light-absorbing: the light sinks into her skin instead of bouncing off it, the way bare, ' +
    'powdered skin looks under an ordinary lamp.',
    'Da mộc, khô, hơi bột và lộ rõ kết cấu: lỗ chân lông ở mũi và hai má bắt sáng xiên, đổ những vệt bóng li ti; ' +
    'bề mặt hơi sần và không đều, loang lổ từng mảng, vài nốt mụn nhỏ và đốm thâm ở cằm, tàn nhang mờ, ửng đỏ ' +
    'quanh cánh mũi, lông tơ dọc quai hàm, quầng thâm mắt, nếp nhăn mảnh và môi khô nứt nhẹ. Bề mặt da nhám, ' +
    'lì và HÚT SÁNG — ánh sáng chìm vào da chứ không hắt lên, như da mộc dặm phấn dưới đèn thường.'],
  ['Thường',
    'Her skin is bare and powdery, with ordinary everyday texture: pores visible on the nose and cheeks, ' +
    'slightly uneven tone, a small blemish or two, faint under-eye shadows and dry lips. The surface is dry, ' +
    'matte and light-absorbing — the light sinks into her skin instead of bouncing off it.',
    'Da mộc, hơi bột, kết cấu đời thường: thấy lỗ chân lông ở mũi và má, màu da hơi không đều, một hai nốt mụn ' +
    'nhỏ, quầng mắt mờ và môi khô. Bề mặt khô, lì và hút sáng — ánh sáng chìm vào da chứ không hắt lên.'],
  ['Mịn nhẹ',
    'Her skin is bare, an even everyday tone with only fine pores visible up close, but the surface stays dry, ' +
    'matte and light-absorbing — the light sinks into her skin instead of bouncing off it.',
    'Da mộc, màu đều, chỉ thấy lỗ chân lông mảnh khi nhìn gần, nhưng bề mặt vẫn khô, lì và hút sáng — ánh sáng ' +
    'chìm vào da chứ không hắt lên.'],
]

const SKIN_TEX_FIELD: QuickField = {
  key: 'skin_tex', label: 'Chất da', opts: SKIN_TEX.map(([vi, en]) => [vi, en]),
}

// Máy ảnh — thay cho khối CAM + DEEP_FOCUS viết cứng ở CẢNH. Mỗi lựa chọn tự mô tả
// thân máy/màu ẢNH VÀ độ sâu trường ảnh (DOF). Dùng "the subject" chứ không "her face"
// để câu này dùng lại được cho cả góc quay lưng, nên không cần biến thể riêng.
// [nhãn VI, khối EN (gửi model), khối VI (người dùng đọc)]
const CAMERA: [string, string, string][] = [
  ['iPhone 13 Pro (mặc định)',
    'Shot on an iPhone 13 Pro, handheld, straight out of the camera app with the phone’s own HDR already applied: ordinary phone-camera colour ' +
    'and an off-center but level frame — the phone is held straight so the horizon and vertical lines stay upright. Deep depth of field, ' +
    'the way a small phone lens renders a room: the subject AND the entire background are equally sharp and ' +
    'fully in focus, every object behind her readable — no lens blur, no portrait mode.',
    'Chụp bằng iPhone 13 Pro, cầm tay, xuất thẳng từ máy: màu ảnh điện thoại bình thường, ' +
    'khung lệch tâm nhưng KHÔNG nghiêng — máy cầm ngang nên chân trời và các đường dọc vẫn thẳng đứng. Nét sâu kiểu ống kính điện thoại nhỏ: chủ thể VÀ toàn bộ hậu ' +
    'cảnh đều sắc nét như nhau, mọi vật phía sau đều rõ — không xoá phông, không chế độ chân dung.'],
  ['Sony A7IV',
    'Shot on a Sony A7IV full-frame camera with a 35mm lens at a small aperture: clean, natural full-frame ' +
    'colour and gentle dynamic range, fine realistic detail. Deep depth of field — the subject and the whole ' +
    'background stay sharp and fully in focus, no portrait-mode blur.',
    'Chụp bằng Sony A7IV full-frame, ống 35mm khép khẩu: màu full-frame sạch và tự nhiên, chi tiết thực và mịn. ' +
    'Nét sâu — chủ thể và toàn bộ hậu cảnh đều sắc nét, không xoá phông.'],
  ['Canon R6',
    'Shot on a Canon EOS R6 with a 35mm lens at a small aperture: warm, pleasing Canon skin tones and natural ' +
    'colour. Deep depth of field — the subject and the entire background stay sharp and in focus, no blur.',
    'Chụp bằng Canon EOS R6, ống 35mm khép khẩu: tông da ấm đặc trưng Canon, màu tự nhiên. Nét sâu — chủ thể và ' +
    'toàn bộ hậu cảnh đều sắc nét, không mờ nền.'],
  ['Fujifilm (màu film)',
    'Shot on a Fujifilm X-series camera with a film-simulation colour profile: soft muted film-like colour and ' +
    'gentle grain. Deep depth of field — the subject and the whole background stay sharp and in focus.',
    'Chụp bằng máy Fujifilm dòng X với giả lập màu film: màu dịu như phim và hạt nhẹ. Nét sâu — chủ thể và toàn ' +
    'bộ hậu cảnh đều sắc nét.'],
  ['DSLR / ảnh RAW',
    'Shot on a DSLR and saved as a clean RAW file: neutral colour, wide dynamic range, crisp realistic detail ' +
    'with no phone processing. Deep depth of field — the subject and the entire background stay sharp.',
    'Chụp bằng máy DSLR, lưu file RAW sạch: màu trung tính, dải sáng rộng, chi tiết sắc thực, không qua xử lý ' +
    'của điện thoại. Nét sâu — chủ thể và toàn bộ hậu cảnh đều sắc nét.'],
  // Lựa chọn DUY NHẤT phá "nét sâu" — chủ ý, để làm ảnh kiểu chân dung. Anh đã chốt cho
  // thêm riêng option này; nó DỄ ra "AI đẹp" hơn và làm da mịn lại, nên đứng cuối, không
  // phải mặc định.
  ['📸 Chân dung xoá phông (85mm)',
    'Shot on a full-frame camera with a fast 85mm portrait lens wide open: a shallow depth of field with the ' +
    'subject sharp and the background softly blurred into smooth creamy bokeh behind her. Natural, realistic ' +
    'colour, not over-processed.',
    'Chụp bằng máy full-frame, ống chân dung 85mm mở khẩu lớn: độ sâu trường ảnh mỏng, chủ thể sắc nét còn hậu ' +
    'cảnh xoá phông mịn (bokeh) phía sau. Màu tự nhiên, không xử lý quá tay.'],
]
const CAMERA_FIELD: QuickField = { key: 'camera', label: 'Máy ảnh', opts: CAMERA.map(([vi, en]) => [vi, en]) }
function cameraBlock(sel: QuickSelection): string {
  const v = (sel.camera || CAMERA[0][1]).trim()
  return CAMERA.find(([, en]) => en === v)?.[1] ?? v
}
function cameraBlockVi(sel: QuickSelection): string {
  const v = (sel.camera || CAMERA[0][1]).trim()
  return CAMERA.find(([, en]) => en === v)?.[2] ?? v
}

// Trang điểm — thay câu makeup viết cứng ở NHÂN VẬT. Vẫn đứng về phía "mộc/đời thường"
// vì makeup dày là một dấu hiệu "AI đẹp"; không có lựa chọn glam/beauty-filter.
const MAKEUP_FIELD: QuickField = {
  key: 'makeup', label: 'Trang điểm', opts: [
    ['Mặt mộc (không makeup)', 'her face is completely bare with no makeup at all, just a light dusting of face powder'],
    ['Nhẹ tự nhiên', 'very light natural makeup: a little tinted lip balm and groomed brows, nothing heavy, skin still bare'],
    ['Đời thường', 'everyday casual makeup a normal person wears out: soft lip colour, light natural brows, no foundation cake, no glam'] ],
}

// ── Mức nhan sắc ────────────────────────────────────────────────────────────
// VÌ SAO CÓ Ô NÀY. Ở chế độ đơn giản người dùng chỉ chọn Quốc tịch + Độ tuổi, còn
// Mặt/Mắt/Mũi/Môi/Biểu cảm do app tự random — mà MỌI lựa chọn của các ô đó đều là nét
// ĐẸP ("trái xoan", "mắt to tròn", "mũi cao thanh tú", "môi đầy"). Kết quả: ảnh nào cũng
// ra hot girl, không dùng được cho tài khoản người thường.
//
// Đo thực nghiệm 19/08/2026 (12 ảnh, gpt-image-2, quality=low, xem docs/test-nhan-sac/):
//   • Prompt đầy đủ 3.202 ký tự  → vẫn ra gái xinh
//   • Chỉ 73 ký tự, không nói gì → RA GÁI XINH Y HỆT
//   • Thêm MỘT câu "not pretty"  → ra mặt người thường ngay
// Tức là 3.200 ký tự tả mặt gần như không có tác dụng, còn một câu về nhan sắc thì có.
//
// Bài học: phải BỚT chứ không THÊM. Nhét "không xinh" vào một câu đã tả sẵn "mắt to tròn,
// mũi cao thanh tú" là để hai vế đánh nhau, và bên SỐ ĐÔNG thắng — đúng cùng cơ chế đã ghi
// ở MONOLID_EMPHASIS. Nên khi mức ≠ 'pretty', builder BỎ HẲN face/eyes/nose/lips/expression
// khỏi câu subject rồi mới đặt câu nhan sắc vào.
//
// opts[1] ở đây là ID để tra BEAUTY_PHRASES/BEAUTY_SKIN, KHÔNG phải câu gửi thẳng cho
// model như mọi field khác. 'pretty' giữ nguyên hành vi cũ, nên mọi lời gọi chưa truyền
// `beauty` (rỗng) vẫn chạy y như trước.
const BEAUTY_FIELD: QuickField = {
  key: 'beauty', label: 'Mức nhan sắc', opts: [
    ['Đẹp', 'pretty'], ['Trung bình', 'average'], ['Vừa phải', 'mild'],
    ['Dưới trung bình', 'below'], ['Không xinh đẹp', 'plain'] ],
}
// Tả CẤU TRÚC VẬT LÝ, không tả tính từ — cùng kỹ thuật đã dùng ở MONOLID_EMPHASIS.
// "not pretty" là tính từ nên dễ bị model bỏ qua; "mũi thấp tẹt, mắt nhỏ một mí, mặt bầu
// má đầy" là hình khối nên model buộc phải vẽ ra. Mốc tham chiếu: ảnh sếp gửi 19/08 —
// gái Việt bình thường, da ngăm, mắt nhỏ hơi sụp mí, mũi thấp đầu tròn, mặt không cười.
// MỖI MỨC MỘT DÁNG MẶT KHÁC HẲN, không phải cùng một danh sách rồi tăng tính từ.
// Bản đầu (19/08 sáng) mắc đúng lỗi đó: 'below' và 'plain' dùng CHUNG cả 12 cụm hình
// khối ("mặt bầu rộng", "mắt nhỏ mí lót", "mũi thấp tẹt"…), chỉ khác mấy tính từ
// (thick/heavy, drooping). Model vẽ hình khối chứ không vẽ tính từ, nên hai mức ra ảnh
// giống hệt nhau — sếp phát hiện ngay khi xem. Giờ tách theo trục DỄ NHÌN NHẤT là dáng
// mặt: 'below' = mặt DÀI HẸP + hô + cằm lẹm; 'plain' = mặt BẦU RỘNG + mũi tẹt bè + nặng
// người. Hai cái đó không thể nhầm lẫn.
const BEAUTY_PHRASES: Record<string, string> = {
  average:
    'Her face is completely ordinary and forgettable — the face of a stranger you would walk past without ' +
    'looking twice: a medium oval face with even, unremarkable proportions, medium-sized eyes with a faint low ' +
    'double-eyelid crease, a nose of average height with a slightly rounded tip, and an ordinary mouth. She is ' +
    'neither pretty nor ugly, just average.',
  mild:
    'Her face is ordinary and a little worn, pleasant at most but never striking: noticeably uneven — one eye ' +
    'sits slightly lower and smaller than the other and her mouth pulls a touch to one side — with a dull, ' +
    'tired complexion, sparse thin eyebrows and flat, colourless lips. Nothing on her face is symmetrical.',
  below:
    'Her face is long and narrow rather than round, and plainer than most people’s: a tall, drawn face with ' +
    'hollow cheeks and a small receding chin that slopes back under her lower lip, a clear overbite so her ' +
    'upper front teeth push her lip forward and stay visible even at rest, a long thin nose, and small deep-set ' +
    'eyes under a heavy brow. She is noticeably below average looking.',
  plain:
    'She is plainly unattractive: a broad, heavy, rounded face on a fuller, thickset build, with soft full ' +
    'cheeks that swallow her jawline and a short neck, a distinctly flat wide nose whose fleshy tip spreads ' +
    'across her face with the nostrils showing straight-on, small narrow eyes almost buried under thick ' +
    'drooping single eyelids, and a flat closed mouth. Nothing about her face is delicate.',
}
const BEAUTY_PHRASES_VI: Record<string, string> = {
  average:
    'Gương mặt hoàn toàn bình thường, nhìn xong là quên: mặt trái xoan cỡ vừa, tỉ lệ đều đều không có gì nổi, ' +
    'mắt cỡ vừa mí lót mờ, mũi cao vừa phải đầu hơi tròn, miệng bình thường. Không xinh mà cũng không xấu.',
  mild:
    'Gương mặt bình thường và hơi mệt mỏi, cùng lắm là dễ nhìn: hai bên mặt lệch rõ — một mắt thấp và nhỏ hơn ' +
    'mắt kia, miệng hơi kéo lệch sang một bên — da xỉn thiếu sức sống, lông mày thưa, môi mỏng nhợt. Không nét ' +
    'nào cân đối.',
  below:
    'Gương mặt dài và hẹp chứ không tròn, kém sắc hơn phần đông: mặt cao gầy, má hóp, cằm nhỏ lẹm tụt hẳn vào ' +
    'trong dưới môi dưới, răng cửa hàm trên hô đẩy môi ra trước và lộ cả khi không cười, mũi dài mảnh, mắt nhỏ ' +
    'sâu dưới gờ mày nhô. Rõ ràng là dưới trung bình.',
  plain:
    'Cô không xinh: mặt bầu rộng và nặng trên thân hình đầy đặn, má phính che mất đường hàm, cổ ngắn, mũi tẹt ' +
    'bè rõ đầu mũi to bè lan ra hai bên và lộ thẳng lỗ mũi, mắt nhỏ gần như bị lấp dưới mí lót dày sụp xuống, ' +
    'miệng khép không cười. Không có nét nào thanh tú.',
}
// ── Thực đơn gương mặt ──────────────────────────────────────────────────────
// VÌ SAO CÓ. BEAUTY_PHRASES cho mỗi mức ĐÚNG MỘT câu tả mặt cố định, nên mọi nhân vật
// cùng mức đều xúm quanh một kiểu mặt. Trước khi có ô nhan sắc, 5 ô Mặt/Mắt/Mũi/Môi/Biểu
// cảm random ra 4.375 tổ hợp; gỡ 5 ô đó đi là mất luôn nguồn đa dạng ấy.
//
// Thực đơn này trả lại sự đa dạng mà KHÔNG trả lại vấn đề cũ: mọi lựa chọn trong đây đều
// trung tính hoặc kém sắc, không có ô nào là nét đẹp, nên bốc kiểu gì cũng không ra hot
// girl. 8 ô => 846.720 tổ hợp cho mức kém, 57.600 cho mức thường.
//
// VÌ SAO BỐC NGẪU NHIÊN CHỨ KHÔNG NHỜ GPT CHỌN. Đã đo 19/08 bằng 30 ảnh
// (docs/test-nhan-sac/v6-thuc-don/): GPT chỉ chạm 18/45 lựa chọn, và ở 3 ô nó chọn CÙNG
// MỘT giá trị cho cả 20/20 ảnh (miệng, thân/cổ, trán/tóc). Bốc ngẫu nhiên chỉ với 10 mẫu
// đã chạm 35/45. Đúng cái bệnh hội tụ mà scene_details đã ghi ("temperature alone still
// converges on the same first idea"), và hạ nhiệt độ xuống 0.7 còn làm nó nặng hơn.
// => Mặc định BỐC NGẪU NHIÊN: đa dạng hơn, 0 giây, không tốn tiền, không phụ thuộc mạng.
//    Nút "Mặt bằng GPT" vẫn còn cho ai muốn một tổ hợp "hợp nhau" hơn — xem pickFace().
const FACE_SLOTS = ['mat_ngoai', 'go_ma', 'ham_cam', 'may_mat', 'mui', 'mieng_rang', 'than_co', 'tran_toc'] as const
type FaceSlot = typeof FACE_SLOTS[number]
// Thực đơn có thể KHUYẾT ô: bộ cho mức "Đẹp" chỉ bù 4 chiều mà đường cũ bỏ sót,
// 4 chiều còn lại vẫn do các ô Mặt/Mắt/Mũi/Môi/Biểu cảm lo (xem FACE_MENU_DEP).
type FaceMenu = Partial<Record<FaceSlot, Record<string, [string, string]>>>   // mã -> [câu EN, nhãn VI]

/** Bộ "kém": dùng cho mức Dưới trung bình / Không xinh đẹp. */
const FACE_MENU_KEM: FaceMenu = {
  mat_ngoai: {
    dai_hep: ['a long, narrow face', 'mặt dài hẹp'],
    bau_tron: ['a broad, round face', 'mặt bầu tròn'],
    chu_nhat: ['a rectangular face with straight sides', 'mặt chữ nhật'],
    ham_vuong: ['a wide, square face', 'mặt vuông bè'],
    tran_rong_ham_be: ['a face with a broad forehead widening into a heavy jaw', 'trán rộng, hàm bè'],
    go_ma_be: ['a face at its widest across the cheekbones, narrowing sharply to the chin', 'gò má bè, cằm tóp'],
    qua_le: ['a narrow forehead over a much wider lower face', 'trán hẹp, dưới bè'],
  },
  go_ma: {
    hom: ['hollow, sunken cheeks', 'má hóp'],
    phinh: ['full, puffy cheeks that soften her outline', 'má phính'],
    phang: ['flat cheeks with no definition', 'má phẳng'],
    cao_tho: ['high, blunt cheekbones that sit too wide', 'gò má cao thô'],
    lech: ['cheeks that are visibly uneven, one fuller than the other', 'má lệch'],
  },
  ham_cam: {
    cam_lem: ['a small receding chin that slopes back under her lower lip', 'cằm lẹm'],
    cam_dua: ['a square chin that juts forward', 'cằm vuông đưa ra'],
    cam_ngan: ['a short, blunt, rounded chin', 'cằm ngắn tròn'],
    ham_nang: ['a long, heavy jaw', 'hàm dài nặng'],
    cam_lech: ['a chin set slightly off the centre-line of her face', 'cằm lệch'],
    cam_doi: ['a soft double chin under the jaw', 'cằm đôi'],
  },
  may_mat: {
    nho_mi_lot: ['small narrow eyes with thick single eyelids', 'mắt nhỏ mí lót dày'],
    sau_hom: ['small deep-set eyes under a heavy brow ridge', 'mắt sâu hõm'],
    mi_sup: ['droopy hooded lids that half-cover her eyes', 'mí sụp'],
    xa_nhau: ['small eyes set noticeably far apart', 'mắt nhỏ xa nhau'],
    gan_nhau: ['small eyes set close together', 'mắt nhỏ gần nhau'],
    lech_mat: ['eyes at visibly different heights, one smaller than the other', 'hai mắt lệch'],
    may_thua: ['sparse, thin, uneven eyebrows over small eyes', 'lông mày thưa'],
  },
  mui: {
    tet_be: ['a flat nose bridge with a wide, fleshy tip', 'mũi tẹt bè'],
    thap_tron: ['a low nose bridge ending in a round, bulbous tip', 'mũi thấp đầu tròn'],
    dai_tho: ['a long, thick, heavy nose', 'mũi dài thô'],
    hech: ['a short upturned nose showing the nostrils straight-on', 'mũi hếch lộ lỗ mũi'],
    lech: ['a nose whose bridge leans off the centre-line', 'mũi lệch'],
    canh_be: ['a nose with wide, flared nostrils', 'cánh mũi bè'],
  },
  mieng_rang: {
    khep_mong: ['a thin, closed, unsmiling mouth', 'miệng mỏng khép'],
    rong_mong: ['a wide mouth with thin, colourless lips', 'miệng rộng môi mỏng'],
    ho: ['an overbite, her upper front teeth pushing her lip forward even at rest', 'răng hô'],
    khap_khenh: ['crowded, crooked front teeth', 'răng khấp khểnh'],
    nho_chat: ['a small, tight mouth', 'miệng nhỏ chật'],
    moi_duoi_day: ['a heavy lower lip that hangs below the upper one', 'môi dưới dày'],
  },
  than_co: {
    day_co_ngan: ['a fuller, thickset build with a short neck', 'người đầy, cổ ngắn'],
    chac_trung_binh: ['a sturdy, ordinary build', 'người chắc trung bình'],
    vai_tho: ['broad, heavy shoulders', 'vai thô'],
    lung_gu: ['slightly rounded shoulders and a forward-leaning neck', 'lưng hơi gù'],
  },
  tran_toc: {
    tran_cao: ['a broad, high forehead', 'trán cao rộng'],
    tran_thap: ['a low forehead', 'trán thấp'],
    chan_toc_lech: ['an uneven hairline', 'chân tóc lệch'],
    toc_thua: ['thin hair with a visible scalp at the parting', 'tóc thưa lộ da đầu'],
  },
}

/** Bộ "thường": dùng cho mức Trung bình / Vừa phải. Mọi lựa chọn đều TRUNG TÍNH —
 *  không đẹp, cũng không kém sắc. Mức Trung bình phải ra người bình thường. */
const FACE_MENU_THUONG: FaceMenu = {
  mat_ngoai: {
    trai_xoan_vua: ['a medium oval face with even proportions', 'mặt trái xoan cỡ vừa'],
    hoi_tron: ['a slightly rounded face', 'mặt hơi tròn'],
    hoi_dai: ['a slightly long face', 'mặt hơi dài'],
    vuong_nhe: ['a face with a gently squared jawline', 'hàm hơi vuông'],
    trung_tinh: ['an unremarkable, everyday face shape', 'mặt đời thường'],
  },
  go_ma: {
    vua: ['cheeks of ordinary fullness', 'má vừa'],
    hoi_day: ['slightly full cheeks', 'má hơi đầy'],
    phang_nhe: ['fairly flat cheeks', 'má hơi phẳng'],
    lech_nhe: ['cheeks very slightly uneven', 'má hơi lệch'],
  },
  ham_cam: {
    cam_vua: ['an ordinary rounded chin', 'cằm tròn vừa'],
    cam_nho: ['a small chin', 'cằm nhỏ'],
    ham_mem: ['a soft, undefined jawline', 'hàm mềm'],
    cam_vuong_nhe: ['a faintly squared chin', 'cằm hơi vuông'],
  },
  may_mat: {
    mi_lot_mo: ['medium-sized eyes with a faint low double-eyelid crease', 'mắt vừa, mí lót mờ'],
    mot_mi: ['medium single-eyelid eyes', 'mắt một mí'],
    hoi_nho: ['slightly small, calm eyes', 'mắt hơi nhỏ'],
    lech_nhe: ['eyes very slightly uneven', 'mắt hơi lệch'],
    may_mong: ['thin natural eyebrows over medium eyes', 'lông mày mỏng'],
  },
  mui: {
    vua_tron: ['a nose of average height with a slightly rounded tip', 'mũi vừa, đầu hơi tròn'],
    thap_nhe: ['a slightly low nose bridge', 'sống mũi hơi thấp'],
    thang_vua: ['a straight, ordinary nose', 'mũi thẳng thường'],
    nho_vua: ['a small, plain nose', 'mũi nhỏ'],
  },
  mieng_rang: {
    vua_khep: ['an ordinary closed mouth', 'miệng khép thường'],
    moi_mong: ['ordinary thin lips', 'môi mỏng thường'],
    hoi_rong: ['a slightly wide mouth', 'miệng hơi rộng'],
    rang_deu_nho: ['small, even teeth', 'răng nhỏ đều'],
  },
  than_co: {
    trung_binh: ['an ordinary build', 'người trung bình'],
    hoi_day: ['a slightly full build', 'người hơi đầy'],
    gon: ['an ordinary, unremarkable build', 'người bình thường'],
  },
  tran_toc: {
    tran_vua: ['an ordinary forehead', 'trán vừa'],
    tran_cao_nhe: ['a slightly high forehead', 'trán hơi cao'],
    chan_toc_thuong: ['an ordinary hairline', 'chân tóc thường'],
  },
}

/** Bộ "đẹp": CHỈ BÙ 4 chiều mà đường cũ không hề tả — gò má, hàm+cằm, thân hình+cổ,
 *  trán+chân tóc. Bốn chiều còn lại (dáng mặt, mắt, mũi, miệng) vẫn do các ô
 *  Mặt/Mắt/Mũi/Môi/Biểu cảm quyết định, nên người dùng mở "Tuỳ chỉnh nâng cao" chỉnh tay
 *  vẫn ăn nguyên như trước — đó là lý do bù chứ không thay.
 *
 *  VÌ SAO CẦN. Đo 19/08: mức "Đẹp" có 656.250 tổ hợp, KHÔNG hề bé. Nhưng nó chỉ tả 5 nét,
 *  bỏ trống cằm/gò má/thân hình/trán — và đúng những chiều bỏ trống ấy thì model tự điền
 *  theo khuôn mặc định của nó (cằm V-line, mặt thon, người mảnh). Kết quả: số tổ hợp lớn
 *  mà ảnh vẫn cho cảm giác cùng một lò. Bù 4 ô này đưa mức "Đẹp" lên ~210 triệu tổ hợp và
 *  quan trọng hơn là cho cằm/thân hình thật sự biến thiên.
 *
 *  Mọi lựa chọn ở đây đều là nét ưa nhìn hoặc trung tính — không có ô nào kém sắc, vì đây
 *  là mức người dùng chủ động chọn khi họ MUỐN nhân vật đẹp. */
const FACE_MENU_DEP: FaceMenu = {
  go_ma: {
    cao_thanh: ['high, delicately defined cheekbones', 'gò má cao thanh'],
    day_mem: ['softly full cheeks', 'má đầy mềm'],
    phang_thanh: ['smooth, gently flat cheeks', 'má phẳng thanh'],
    cao_ro: ['clearly defined cheekbones', 'gò má cao rõ'],
    bau_tre: ['rounded, youthful cheeks', 'má bầu trẻ'],
  },
  // CHỈ tả CẰM, không tả jawline: ô "Khuôn mặt" đã có 2 lựa chọn nói về hàm ("V-line
  // thon", "Vuông thanh"), nên tả hàm ở đây nữa là một câu nhắc jawline hai lần.
  ham_cam: {
    cam_thon: ['a slim, tapered chin', 'cằm thon'],
    cam_nhon_nhe: ['a gently pointed chin', 'cằm hơi nhọn'],
    cam_tron_day: ['a rounded, full chin', 'cằm tròn đầy'],
    cam_vuong_mem: ['a softly squared chin', 'cằm vuông mềm'],
    cam_nho_tron: ['a small, neat rounded chin', 'cằm nhỏ tròn'],
  },
  than_co: {
    manh_co_cao: ['a slim build with a long neck', 'người mảnh, cổ cao'],
    can_doi: ['an evenly proportioned build', 'người cân đối'],
    day_can_xung: ['a fuller but well-proportioned build', 'người đầy đặn cân xứng'],
    thanh_vai_xuoi: ['a slender build with sloping shoulders', 'người thanh, vai xuôi'],
  },
  tran_toc: {
    tran_cao_thoang: ['a high, open forehead', 'trán cao thoáng'],
    tran_vua: ['a forehead of ordinary height', 'trán vừa'],
    chan_toc_deu: ['a neat, even hairline', 'chân tóc đều'],
    tran_hoi_tron: ['a softly rounded forehead', 'trán hơi tròn'],
  },
}

/** Bộ thực đơn ứng với mức nhan sắc, hoặc null khi mức đó không dùng thực đơn
 *  ('pretty' vẫn đi đường cũ: tả Mặt/Mắt/Mũi/Môi qua các ô riêng). */
function faceMenuFor(beauty: string): FaceMenu | null {
  const b = (beauty || '').trim()
  if (b === 'below' || b === 'plain') return FACE_MENU_KEM
  if (b === 'average' || b === 'mild') return FACE_MENU_THUONG
  if (b === 'pretty') return FACE_MENU_DEP
  return null
}
/** Khoá lưu trong QuickSelection cho một ô của thực đơn. Tiền tố `f_` để không đụng
 *  các ô thường và để randomCharTraits nhận ra đây không phải QuickField. */
const faceKey = (slot: string) => `f_${slot}`

/** Bốc ngẫu nhiên một tổ hợp gương mặt cho mức nhan sắc đang chọn. Trả về {} nếu mức
 *  đó không dùng thực đơn. */
export function randomFaceCodes(beauty: string): Record<string, string> {
  const menu = faceMenuFor(beauty)
  if (!menu) return {}
  const out: Record<string, string> = {}
  for (const slot of FACE_SLOTS) {
    const opts = menu[slot]
    if (!opts) continue          // thực đơn "Đẹp" chỉ có 4/8 ô — bỏ qua ô không có
    const codes = Object.keys(opts)
    out[faceKey(slot)] = codes[Math.floor(Math.random() * codes.length)]
  }
  return out
}

/** Thực đơn dạng {ô: [mã…]} để gửi cho backend nhờ GPT chọn — nguồn sự thật vẫn nằm ở
 *  file này, backend không giữ bản sao nào. */
export function faceMenuCodes(beauty: string): Record<string, string[]> {
  const menu = faceMenuFor(beauty)
  if (!menu) return {}
  return Object.fromEntries(
    FACE_SLOTS.filter((s) => menu[s]).map((s) => [s, Object.keys(menu[s]!)]),
  )
}

/** Ghép câu tả mặt từ tổ hợp đã chọn. Câu chữ do MÌNH viết, nên dù tổ hợp đến từ GPT
 *  thì GPT cũng không chèn được chữ nào vào prompt — đó là lý do cách này không còn
 *  trượt mức nhan sắc như bản để GPT viết văn tự do (xem docs/test-nhan-sac/). */
function faceParts(sel: QuickSelection, beauty: string, vi: boolean): string[] | null {
  const menu = faceMenuFor(beauty)
  if (!menu) return null
  const slots = FACE_SLOTS.filter((s) => menu[s])
  const parts: string[] = []
  for (const slot of slots) {
    const opt = menu[slot]![(sel[faceKey(slot)] || '').trim()]
    if (opt) parts.push(vi ? opt[1] : opt[0])
  }
  // Thiếu ô nào là tổ hợp khuyết (dữ liệu cũ, hoặc mã lạ) -> trả null để builder rơi về
  // đường cũ thay vì dựng một câu cụt.
  return parts.length === slots.length ? parts : null
}

/** Câu tả mặt THAY THẾ cho mức trung bình trở xuống — đã đủ 8 chiều nên nó gánh toàn bộ
 *  phần mô tả gương mặt. Rỗng ở mức "Đẹp" (mức đó dùng faceExtra bên dưới). */
function faceSentence(sel: QuickSelection, beauty: string, vi = false): string {
  if (beauty === 'pretty') return ''
  const parts = faceParts(sel, beauty, vi)
  if (!parts) return ''
  const than = ['below', 'plain'].includes(beauty)
  if (vi) {
    return `Cô có ${parts.slice(0, -1).join(', ')} và ${parts[parts.length - 1]}. `
      + (than ? 'Gương mặt đời thường, không xinh.' : 'Không xinh mà cũng không xấu, chỉ là bình thường.')
  }
  return `She has ${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}. `
    + (than ? 'Her face is ordinary and not pretty.' : 'She is neither pretty nor unattractive, just average.')
}

/** Câu BÙ THÊM cho mức "Đẹp": 4 chiều mà đường cũ bỏ trống (gò má, hàm+cằm, thân hình,
 *  trán+tóc). Ghép nối tiếp sau câu tả Mặt/Mắt/Mũi/Môi sẵn có, không thay thế nó, nên
 *  chỉnh tay ở "Tuỳ chỉnh nâng cao" vẫn ăn nguyên. */
function faceExtra(sel: QuickSelection, beauty: string, vi = false): string {
  if (beauty !== 'pretty') return ''
  const parts = faceParts(sel, beauty, vi)
  if (!parts) return ''
  return vi
    ? ` Cô có ${parts.slice(0, -1).join(', ')} và ${parts[parts.length - 1]}.`
    : ` She has ${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}.`
}

// Màu da đi theo nhan sắc (yêu cầu sếp 19/08): đẹp thì mới trắng, còn lại ngăm.
// Dừng ở mức "ngăm" chứ không xuống "đen": khối chất da đã thêm sẵn mụn/đốm nâu, và
// da rất tối + mụn là đúng công thức đã cho ra ảnh "kinh" hồi trước.
// 'pretty' KHÔNG có trong bảng này — mức đó giữ nguyên màu da người dùng/random chọn.
const BEAUTY_SKIN: Record<string, string> = {
  average: 'light tan skin',
  mild: 'light tan skin',
  below: 'warm tan skin, uneven and slightly blotchy in tone',
  plain: 'dark tan skin, uneven and blotchy in tone',
}
const BEAUTY_SKIN_VI: Record<string, string> = {
  average: 'ngăm nhẹ',
  mild: 'ngăm nhẹ',
  below: 'ngăm nâu, không đều màu, hơi loang',
  plain: 'ngăm đậm, không đều màu, loang lổ',
}
/** Màu da ứng với mức nhan sắc, hoặc '' nếu mức đó không ép màu da ('pretty'/chưa chọn). */
export function beautySkin(beauty: string): string {
  return BEAUTY_SKIN[(beauty || '').trim()] || ''
}

// Ánh mắt — catchlight nhỏ tự nhiên, không "long lanh anime". Nhét vào câu tả cảnh.
const GAZE_FIELD: QuickField = {
  key: 'gaze', label: 'Ánh mắt', opts: [
    ['Tự nhiên + catchlight nhỏ', 'her eyes calm and natural with a tiny realistic catchlight, normal pupils, not glossy or glowing'],
    ['Nhìn xa', 'her gaze drifting off to the side, natural and unposed, a small natural catchlight in her eyes'],
    ['Lim dim thư giãn', 'her eyes softly relaxed and slightly narrowed, an easy natural look'],
    ['Nhìn thẳng nhẹ', 'looking gently toward the camera, eyes calm and natural with a small realistic catchlight'] ],
}

export const QUICK_CHARACTER_FIELDS: QuickField[] = [
  { key: 'nation', label: 'Nét / Quốc tịch', opts: [
    ['Việt Nam', 'a Vietnamese'], ['Philippines', 'a Filipina'] ] },
  { key: 'age', label: 'Độ tuổi', opts: [
    ['Cuối teen (~18)', 'in her late teens'], ['Đầu 20 (20–22)', 'in her early 20s'],
    ['Giữa 20 (23–25)', 'in her mid-20s'], ['Cuối 20 (26–29)', 'in her late 20s'],
    ['Khoảng 30', 'around 30 years old'] ] },
  { key: 'face', label: 'Khuôn mặt', opts: [
    ['Trái xoan', 'an oval face'], ['V-line thon', 'a slim V-line face'],
    ['Tròn bầu', 'a round soft face'], ['Trái tim', 'a heart-shaped face'],
    ['Vuông thanh', 'a gently defined jawline'] ] },
  // Skin COLOUR only — the finish is the "Chất da" field. Words like "bright" or "glowing"
  // here would fight it, so every value is a plain hue.
  { key: 'skin', label: 'Màu da', opts: [
    ['Trắng sáng', 'fair light skin'], ['Trắng hồng', 'fair skin with a rosy undertone'],
    ['Ngăm nhẹ', 'light tan skin'], ['Nâu khỏe', 'warm tan skin'],
    ['Trắng tự nhiên', 'naturally light skin'] ] },
  { key: 'hair_style', label: 'Kiểu tóc', opts: [
    ['Dài thẳng', 'long straight'], ['Dài xoăn sóng', 'long wavy'],
    ['Ngang vai', 'shoulder-length'], ['Bob ngắn', 'short bobbed'],
    ['Buộc đuôi ngựa', 'tied-back'], ['Uốn xoăn nhẹ', 'softly curled'] ] },
  { key: 'hair_color', label: 'Màu tóc', opts: [
    ['Đen', 'black'], ['Nâu đen', 'dark brown'], ['Nâu hạt dẻ', 'chestnut brown'],
    ['Nâu vàng', 'light brown'], ['Đỏ nâu', 'auburn'] ] },
  { key: 'eyes', label: 'Mắt', opts: [
    ['To tròn nâu', 'big round brown eyes'], ['Hai mí sắc', 'sharp double-eyelid eyes'],
    ['Một mí Á Đông', 'monolid single-eyelid eyes'], ['Bồ câu đen', 'gentle dark eyes'],
    ['Nâu hạt dẻ', 'hazel eyes'] ] },
  { key: 'nose', label: 'Mũi', opts: [
    ['Cao thanh tú', 'a high refined nose'], ['Nhỏ nhắn', 'a small delicate nose'],
    ['Thẳng tự nhiên', 'a straight natural nose'], ['Cao dọc dừa', 'a tall slender nose'],
    ['Thấp tự nhiên', 'a low-bridge nose'], ['Tẹt', 'a flat, low, slightly wide nose'],
    ['Hếch (gí)', 'a small upturned snub nose'] ] },
  { key: 'lips', label: 'Môi', opts: [
    ['Đầy hồng nhạt', 'full light-pink lips'], ['Mỏng nhẹ', 'thin soft lips'],
    ['Trái tim', 'heart-shaped lips'], ['Căng mọng', 'full plump lips'],
    ['Cam đào', 'peachy lips'] ] },
  { key: 'expression', label: 'Biểu cảm', opts: [
    ['Cười nhẹ dịu', 'a gentle soft smile'], ['Tươi tắn', 'a bright cheerful smile'],
    ['Trung tính', 'a calm neutral expression'], ['Tự tin', 'a confident look'],
    ['Bí ẩn nhẹ', 'a subtle mysterious look'] ] },
  BEAUTY_FIELD,
  MAKEUP_FIELD,
  SKIN_TEX_FIELD,
]

export const QUICK_SCENE_FIELDS: QuickField[] = [
  // Where in the world. Without this the model invents a generic pan-Asian / Western
  // backdrop that does not match a Vietnamese or Filipina face — a giveaway on its own.
  // Each value names a REAL district and the concrete street furniture that belongs to
  // it, so the background is built from local detail instead of stock "Asian cafe".
  // Pick the one that matches the character's nationality. The two "bất kỳ" entries are
  // the defaults on purpose: pinning every shot to one district is its own kind of fake,
  // so the model is left free unless a district is chosen (or «Đổi cảnh» rolls one).
  { key: 'region', label: 'Khu vực (theo quốc tịch)', opts: [
    ['🇻🇳 Việt Nam (bất kỳ)', 'somewhere in Vietnam'],
    ['🇵🇭 Philippines (bất kỳ)', 'somewhere in the Philippines'],
    ['🇻🇳 Hà Nội — phố cổ',
     'in the Old Quarter of Hanoi, Vietnam, among narrow tube houses, plastic stools on the pavement, tangled ' +
     'overhead power lines and parked motorbikes'],
    ['🇻🇳 Sài Gòn — trung tâm',
     'in central Ho Chi Minh City, Vietnam, with dense motorbike traffic, low shophouses, roll-down shutters and ' +
     'air-conditioner units on the walls'],
    ['🇻🇳 Đà Nẵng / biển miền Trung',
     'in Da Nang on the central coast of Vietnam, with wide bright streets, palm trees and low seaside buildings'],
    ['🇻🇳 Đà Lạt — cao nguyên',
     'in Da Lat in the Vietnamese highlands, with pine trees, hillside houses, cool misty air and steep streets'],
    ['🇻🇳 Miền Tây — sông nước',
     'in the Mekong Delta of southern Vietnam, with river water, wooden boats, corrugated-iron roofs and ' +
     'lush green vegetation'],
    ['🇻🇳 Hội An — phố cổ vàng',
     'in the old town of Hoi An, Vietnam, among yellow-washed walls, wooden shutters and paper lanterns'],
    ['🇵🇭 Manila — đô thị',
     'in Metro Manila, the Philippines, with jeepneys, concrete low-rise buildings, overhead cables and tropical ' +
     'street clutter'],
    ['🇵🇭 Cebu',
     'in Cebu City, the Philippines, with tropical trees, concrete buildings and bright hazy sunlight'],
    ['🇵🇭 Boracay / biển',
     'on a Philippine tropical beach with white sand, palm trees, bangka outrigger boats and turquoise water'],
    ['🇵🇭 Baguio — vùng núi',
     'in Baguio in the Philippine highlands, with pine trees, steep streets and cool mountain air'] ] },
  // Bối cảnh — biên tập từ 36 preset của luồng cũ thành mảnh-ghép ngắn (bắt đầu bằng
  // in/at/on để ghép vào câu "She is <pose> <location> <region>"). Bỏ mấy cái trùng
  // (cafe/park/beach), bỏ 'selfie' (đó là tư thế), bỏ 'hoi an' (đã nằm ở ô Khu vực).
  // Là combobox nên danh sách dài không sao — gõ vài chữ là lọc ra.
  { key: 'location', label: 'Bối cảnh', opts: [
    // — Đời thường / trong nhà —
    ['Quán cà phê', 'in a cozy cafe'], ['Phòng thử đồ', 'in a fitting room with a large mirror'],
    ['Bên cửa sổ', 'at home beside a bright window'], ['Văn phòng', 'in a modern office'],
    ['Bếp nấu ăn', 'cooking in a home kitchen'], ['Làm bánh', 'baking at a kitchen counter with flour and trays'],
    ['Studio nền trơn', 'in a clean studio with a plain backdrop'],
    // — Ngoài trời —
    ['Công viên', 'in a green park outdoors'], ['Đường phố', 'on a busy city street'],
    ['Bãi biển', 'on a sunny beach'], ['Hồ bơi', 'at an outdoor swimming pool'],
    ['Đạp xe ven sông', 'cycling on a riverside path'], ['Dắt chó đi dạo', 'walking a dog on a leafy street'],
    ['Dã ngoại', 'at a picnic on the grass'], ['Điểm ngắm cảnh', 'at a scenic viewpoint overlooking the city'],
    ['Đi du lịch', 'sightseeing at a famous landmark'], ['Bên xe (road trip)', 'on a road trip, standing beside a car'],
    // — Mua sắm / dịch vụ —
    ['Trung tâm thương mại', 'inside a shopping mall'], ['Chợ đêm / hàng ăn', 'at a bustling street-food stall at night'],
    ['Tiệm nail', 'in a nail salon'], ['Spa', 'at a relaxing spa'], ['Tiệm cây / hoa', 'in a plant and flower shop'],
    // — Giải trí / hoạt động —
    ['Phòng gym', 'at the gym'], ['Sân bóng rổ', 'on an outdoor basketball court'],
    ['Phòng karaoke', 'in a karaoke room with colored lights'], ['Rạp chiếu phim', 'inside a cinema'],
    ['Concert', 'at a live outdoor concert in the crowd'], ['Sở thú', 'at the zoo'],
    ['Thư viện', 'in a quiet library'], ['Bảo tàng', 'in an art museum'],
    ['Quán bar / lounge', 'in a stylish lounge bar'], ['Sum họp gia đình', 'at a family gathering around a dinner table'],
    // — Đặc trưng Philippines (chọn khi nhân vật là Filipina) —
    ['🇵🇭 Chợ ẩm (palengke)', 'at a busy Filipino wet market (palengke)'],
    ['🇵🇭 Tiệm sari-sari', 'at a small Filipino sari-sari corner store'],
    ['🇵🇭 Trên xe jeepney', 'riding inside a colorful Philippine jeepney'],
    ['🇵🇭 Jollibee', 'at a Jollibee fast-food restaurant'],
    ['🇵🇭 Lễ hội fiesta', 'at a lively Filipino town fiesta'] ] },
  { key: 'outfit', label: 'Trang phục', opts: [
    ['Giữ như ảnh gốc', 'the same outfit as in image 1'],
    ['Váy hè', 'a light summer dress'], ['Áo dài', 'a traditional Vietnamese ao dai'],
    ['Công sở', 'a smart office outfit'], ['Streetwear', 'a trendy streetwear outfit'],
    ['Áo len ấm', 'a cozy knit sweater'], ['Đầm dạ hội', 'an elegant evening gown'],
    ['Thể thao', 'a sporty athleisure outfit'] ] },
  { key: 'pose', label: 'Tư thế', opts: [
    ['Đứng tự nhiên', 'standing naturally'], ['Ngồi thư giãn', 'sitting relaxed'],
    ['Chụp gương', 'taking a mirror selfie'], ['Đang bước đi', 'walking mid-step'],
    ['Dựa tường', 'leaning against a wall'], ['Tựa bàn', 'leaning on a table'] ] },
  { key: 'lighting', label: 'Ánh sáng', opts: [
    ['Tự nhiên ban ngày', 'soft natural daylight'],
    ['Điện ảnh', 'cinematic lighting with soft contrast'],
    ['Studio', 'even softbox studio lighting'], ['Hoàng hôn', 'warm golden-hour light'],
    ['Low-key', 'moody low-key lighting'], ['Ngược sáng', 'gentle backlight'] ] },
  { key: 'tone', label: 'Tông màu', opts: [
    ['Ấm', 'a warm color tone'], ['Lạnh', 'a cool color tone'],
    ['Trung tính', 'a neutral color tone'], ['Pastel', 'soft pastel tones'],
    ['Tương phản cao', 'high-contrast tones'] ] },
  // ── Ngôn ngữ máy quay, tách làm 3 trục độc lập (chuẩn điện ảnh) ─────────────
  // Trước đây gộp cả cỡ cảnh lẫn góc máy vào một ô "Góc máy" nên không thể chọn
  // kiểu "toàn thân + nhìn từ trên xuống". Tách ra thì 9 × 11 × 8 = 792 tổ hợp.
  //
  // CỐ Ý KHÔNG có nhóm "Camera Movement" (pan / dolly / zoom / orbit / tracking…):
  // đó là chuyển động THEO THỜI GIAN, chỉ có nghĩa với video. Ảnh tĩnh không có
  // chuyển động, nên mấy từ đó chỉ làm loãng prompt và đẩy các từ khoá thật sự
  // quan trọng (da hút sáng, bố cục lệch) ra rìa. Vài mục có nghĩa với ảnh thì đã
  // nằm ở đây rồi: "Drone Shot" = Bird's Eye View, "Handheld" đã nằm trong CAM.
  // Nhãn mang luôn mức zoom điện thoại (0.5× / 1× / 2×) vì đó là ngôn ngữ khách dùng
  // khi đặt hàng ("vd kiểu 1x, 2x, 0.5"). Một trục duy nhất, không tách zoom thành ô
  // riêng: zoom và cỡ cảnh cùng quy về MỘT thứ — cô chiếm bao nhiêu khung hình — nên
  // hai ô sẽ chọi nhau (0.5× + cận sát mặt) mà chẳng thêm quyền điều khiển nào.
  //
  // Phần EN tả bằng VẬT LÝ + một PHÂN SỐ đo được, chứ không ra lệnh "cô phải nhỏ":
  // bản cũ viết "she is tiny, almost lost in a vast environment" — 13 từ, nằm lọt giữa
  // câu, phải đấu với ~107 từ tả mặt ở mức lỗ chân lông (khối da) + chữ "recognizable"
  // ở lead. Model không thoả được cả hai nên hoà giải ở lưng chừng, và điểm hoà giải
  // MỖI LẦN SAMPLE MỘT KHÁC → cùng một "siêu toàn cảnh" mà ba ảnh ba độ rộng (đã xảy
  // ra thật, khách phàn nàn người lúc nào cũng to). "Chiếm 1/5 chiều cao khung" thì đo
  // được nên model bám tốt hơn hẳn một tính từ; và từ toàn thân trở ra, khối tả mặt bị
  // tháo hẳn ra (xem isWideShot / FAR_SKIN / LEAD_FAR).
  //
  // Nhóm 2× CỐ Ý không nhắc ống kính trong phần EN: BACK_SHOT tra cứu theo đúng chuỗi
  // EN của ba mục cận, đổi chuỗi là hỏng phép quay lưng — mà khách chỉ xin nới phía
  // rộng, nên đầu cận giữ nguyên xi cho gọn vùng ảnh hưởng.
  { key: 'shot', label: 'Cỡ cảnh (zoom)', opts: [
    // WS đứng đầu = mặc định của ô này (quickDefaults lấy opts[0]) — giữ nguyên như cũ.
    ['0.5× Toàn cảnh (WS)',
      'a wide shot taken on the phone’s 0.5× ultra-wide lens: she takes up about one third of the height of ' +
      'the picture, with the whole place spread out clearly around her'],
    ['0.5× Siêu toàn cảnh (EWS)',
      'an extreme wide shot taken on the phone’s 0.5× ultra-wide lens: she is standing far away and takes up ' +
      'only about one fifth of the height of the picture, a small figure inside a big open place'],
    ['1× Toàn thân (FS)',
      'a full shot at 1× showing her from head to toe: she takes up about half the height of the picture, with ' +
      'a clear band of ordinary space above her head and below her feet'],
    ['1× Từ đùi lên (Cowboy)',
      'a cowboy shot at 1×, framed from mid-thigh up: she takes up about two thirds of the height of the picture'],
    ['1× Từ thắt lưng lên (MS)', 'a medium shot from the waist up, with plenty of the place still visible around her'],
    // Selfie dang thẳng tay — kiểu "tripod chỉ còn là cái tên" khách xin. KHÔNG phải
    // selfie thường (không ai nhìn ống kính) cũng không phải ảnh người khác chụp: máy
    // do chính chủ thể cầm, dang hết tay, giơ cao chúc xuống, ống siêu rộng, và CÁNH
    // TAY cầm máy nằm luôn trong khung — nhoè vì quá sát ống kính. Cả bộ khối đi kèm
    // nằm ở isArmSelfie / ARM_SELFIE_* bên dưới.
    // Chuỗi EN cố ý KHÔNG chứa "wide shot"/"full shot" để không lọt vào isWideShot
    // (mặt ở kiểu này rất to, phải giữ khối da chi tiết) — isWideShot còn loại trừ
    // tường minh một lần nữa cho chắc.
    // Chuỗi ở đây CỐ Ý ngắn: mọi chi tiết bố cục đã nằm trong ARM_SELFIE_FRAME* rồi, tả
    // lại lần nữa chỉ tốn ~100 ký tự mà prompt thì đã sát trần MAX_IMAGE_PROMPT_LEN.
    ['0.5× Selfie dang tay — một mình',
      'a hand-held selfie taken at the full stretch of her own arm on the phone’s 0.5× ultra-wide lens'],
    ['0.5× Selfie dang tay — cả nhóm',
      'a hand-held group selfie taken at the full stretch of her own arm on the phone’s 0.5× ultra-wide lens'],
    ['2× Từ ngực lên (MCU)', 'a medium close-up from the chest up'],
    ['2× Cận mặt (CU)', 'a close-up of her head and shoulders'],
    ['2× Cận sát mặt (BCU)', 'a big close-up, her face filling most of the frame'],
    ['2× Cực cận (ECU)', 'an extreme close-up of a single detail — her eyes, her lips or her hands'] ] },
  { key: 'angle', label: 'Góc máy', opts: [
    ['Ngang tầm mắt', 'shot at eye level'],
    ['Từ trên xuống (High)', 'shot from a high angle, the camera looking down at her'],
    ['Từ dưới lên (Low)', 'shot from a low angle, the camera looking up at her'],
    ['Thẳng từ trên (Bird’s eye)', 'a bird’s-eye view, the camera directly overhead looking straight down'],
    ['Sát đất nhìn lên (Worm’s eye)', 'a worm’s-eye view from ground level, the camera on the floor looking up'],
    ['Nghiêng máy (Dutch)', 'a dutch angle, the whole camera tilted so the frame leans to one side'],
    ['Ngang mặt đất', 'shot at ground level, the camera resting on the ground'],
    ['Ngang đầu gối', 'shot at knee level'],
    ['Ngang hông', 'shot at hip level'],
    ['Ngang vai', 'shot at shoulder level'] ] },
  // Góc khuôn mặt. Mặt chính diện, hai mắt cân bằng nhau là một trong những dấu
  // hiệu AI lộ liễu nhất, nên mặc định để 3/4 chứ không để chính diện.
  // Mọi giá trị đều mở đầu bằng PHÂN TỪ, để ghép được ở cả hai dạng câu:
  //   luồng nhanh  → "She is standing …, <giá trị>."
  //   luồng cũ     → "She is <giá trị>."
  // (Trước đây viết "her face turned…" nên luồng cũ ra "She is her face turned…".)
  { key: 'head', label: 'Góc khuôn mặt', opts: [
    ['Góc 3/4 (45°)', 'turned about three-quarters away from the camera'],
    ['Chính diện', 'facing the camera straight on'],
    ['Nghiêng 90° (profile)', 'seen in side profile, her face turned fully to the side'],
    ['Qua vai (OTS)', 'seen over someone else’s shoulder, that shoulder blurred in the foreground'],
    ['Sau lưng 45°', 'seen from behind at a three-quarter angle, her face barely turning back'],
    ['Sau lưng', 'seen from behind, only the back of her head and shoulders visible'],
    ['Chỉ nửa mặt', 'showing only half of her face, the rest turned away or cut off by the edge of the frame'],
    ['Nhìn đi chỗ khác', 'looking away from the camera, caught mid-moment and not posing'] ] },
  { key: 'style', label: 'Phong cách', opts: [
    ['Lifestyle', 'lifestyle photography'], ['Chân dung', 'a portrait photograph'],
    ['Đời thường', 'a candid documentary photo'] ] },
  CAMERA_FIELD,
  GAZE_FIELD,
  // Vật che tiền cảnh — thứ nằm sát ống kính và che mất một phần người. Đây là chi tiết
  // làm ảnh "thật" nhất (ảnh chụp vội luôn có cái gì đó lỡ lọt vào), nhưng trước đây bị
  // viết cứng là "lưng ghế" nên ảnh nào cũng mọc ra ghế. Giờ để người dùng chọn, và nút
  // «Đổi cảnh» sẽ bốc ngẫu nhiên → loạt ảnh không còn trùng vật che nữa.
  { key: 'foreground', label: 'Vật che tiền cảnh', opts: [
    ['Tuỳ cảnh (model tự chọn)',
     'whatever object naturally happens to be nearest the camera in that particular place, drifting into the ' +
     'edge of the frame, blurred and out of focus'],
    // 'none' là sentinel: candidFrame() bỏ HẲN câu tả tiền cảnh, và nút «GPT chi tiết»
    // cũng không ghi đè lên nó (xem inventDetails) — chọn "không che" thì phải là KHÔNG.
    ['Không có — không gì che ống kính', 'none'],
    ['Người đi ngang', 'the shoulder and arm of a stranger walking past the camera'],
    ['Tán lá / cành cây', 'a few leaves and a branch hanging into the frame'],
    ['Lưng ghế', 'the back of a chair'],
    ['Mép bàn', 'the edge of a table with things on it'],
    ['Qua khung cửa', 'the dark edge of a doorway she is being photographed through'],
    ['Sau tấm kính', 'a pane of glass with reflections and smudges on it'],
    ['Lan can / cột', 'a railing or a post standing between the camera and her'],
    ['Xe cộ', 'the corner of a parked motorbike or car'] ] },
  SKIN_TEX_FIELD,
]

/** The three models the flow picks between. GPT stays on the OpenAI path; the
 *  other two route to fal.ai (see content.fal_utils on the backend). */
// Ba trục máy quay, tách ra để LUỒNG CŨ (FaceSwapWizard) dùng lại đúng bộ option này —
// một nguồn sự thật duy nhất, sửa một chỗ là cả hai luồng đổi theo.
export const SHOT_FIELD = QUICK_SCENE_FIELDS.find((f) => f.key === 'shot')!
export const ANGLE_FIELD = QUICK_SCENE_FIELDS.find((f) => f.key === 'angle')!
export const HEAD_FIELD = QUICK_SCENE_FIELDS.find((f) => f.key === 'head')!

export const QUICK_MODELS: { key: ImageProvider; label: string }[] = [
  { key: 'openai', label: 'GPT image 2' },
  { key: 'seedream45', label: 'Seedream v4.5' },
  { key: 'grok', label: 'Grok Imagine' },
]

/** The three frame choices (OpenAI size strings, mapped to each model server-side). */
export const QUICK_SIZES: { value: OpenAIImageSize; label: string }[] = [
  { value: '1024x1536', label: 'Dọc 2:3' },
  { value: '1024x1024', label: 'Vuông 1:1' },
  { value: '1536x1024', label: 'Ngang 3:2' },
]

/** Each model's OWN knob (besides the shared frame), mirroring the mika-lab bench:
 *  GPT exposes a quality tier (sent as `quality`); the fal models expose a
 *  resolution/scale (sent as `resolution`). `choices` are [value, label]. */
export type ModelOptionSpec = {
  param: 'quality' | 'resolution'
  label: string
  choices: [string, string][]
  default: string
}

export const QUICK_MODEL_OPTIONS: Record<ImageProvider, ModelOptionSpec[]> = {
  openai: [
    { param: 'quality', label: 'Chất lượng', default: 'low',
      choices: [['low', 'Thấp (rẻ)'], ['medium', 'Vừa'], ['high', 'Cao']] },
  ],
  seedream45: [
    { param: 'resolution', label: 'Độ phân giải', default: '1K',
      choices: [['1K', '1K'], ['2K', '2K'], ['2.3K', '2.3K']] },
  ],
  grok: [
    { param: 'resolution', label: 'Độ phân giải', default: '1k',
      choices: [['1k', '1k'], ['2k', '2k']] },
  ],
}

/** Default option values per provider, e.g. { openai: { quality: 'low' }, … }. */
export function quickModelDefaults(): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  for (const key of Object.keys(QUICK_MODEL_OPTIONS) as ImageProvider[]) {
    out[key] = Object.fromEntries(QUICK_MODEL_OPTIONS[key].map((s) => [s.param, s.default]))
  }
  return out
}

/** First option of every field — the default English phrase per key. */
export function quickDefaults(fields: QuickField[]): QuickSelection {
  return Object.fromEntries(fields.map((f) => [f.key, f.opts[0][1]]))
}

/** Mặc định cho ô nhân vật. Khác `quickDefaults` đúng một chỗ: Mức nhan sắc mặc định
 *  là "Trung bình" chứ không phải "Đẹp" (giá trị đầu danh sách). Danh sách vẫn xếp
 *  đẹp → xấu cho dễ đọc, nên mặc định phải đặt riêng ở đây thay vì đảo thứ tự ô. */
export function quickCharacterDefaults(): QuickSelection {
  // Bốc sẵn một tổ hợp gương mặt để ô xem trước prompt có nội dung ngay từ lần mở đầu,
  // không phải đợi người dùng bấm "Đổi nét".
  const base = { ...quickDefaults(QUICK_CHARACTER_FIELDS), beauty: 'average' }
  return { ...base, ...randomFaceCodes(base.beauty) }
}

// Realism comes from POSITIVE description, not from forbidding things. Verified against
// the live schemas: gpt-image-2, Seedream v4.5 and Grok expose NO negative_prompt param
// — so an "avoid plastic / airbrushed skin…" list is just extra TEXT in the positive
// prompt, and naming those concepts tends to SUMMON them (image models handle negation
// badly). So the look is pinned down by what the photo IS:
//   CAM         — an iPhone 13 Pro snapshot, straight out of camera.
//   skinBlock() — texture picked from the "Chất da" dropdown + the asymmetry line.
//
// GỠ 19/08/2026 — RAKING_LIGHT và DEEP_FOCUS. Giữ lại lý do ở đây vì nó là kiến thức
// thật, đừng thêm lại mà không đo:
//   RAKING_LIGHT — một ngọn đèn LỆCH HẲN SANG MỘT BÊN, quét ngang mặt. Đây là vật lý của
//                  chất da: ánh sáng phẳng/đều giấu lỗ chân lông (đúng lý do studio và
//                  ảnh beauty dùng nó), còn ánh sáng xiên làm mỗi lỗ chân lông tự đổ một
//                  cái bóng nhỏ. Đèn flash trên máy cũng phá được độ mịn nhưng làm da bóng
//                  nhờn, nên khối này chọn đèn bàn tán sáng và không bao giờ nhắc chữ flash.
//   DEEP_FOCUS   — ống kính điện thoại nhỏ giữ toàn bộ hậu cảnh sắc nét: không xoá phông.
// Đo bằng 9 ảnh (docs/test-nhan-sac/v3-do-do-dai/): bỏ cả hai khối thì ảnh KHÔNG xấu đi,
// lỗ chân lông vẫn hiện rõ nhờ skinBlock, mà prompt ngắn đi 54%. Ảnh CẢNH không mất gì:
// nó đã chuyển sang cameraBlock(sel) tự mang cả thân máy lẫn độ sâu trường ảnh.
// Kept in sync with mika_prompt.py.
const CAM =
  'Shot on an iPhone 13 Pro, handheld, straight out of the camera app with the phone’s own HDR already applied: ordinary phone-camera colour ' +
  'and an off-center but level frame — the phone is held straight so the horizon and vertical lines stay upright.'
const ASYMMETRY = 'Slight facial asymmetry, one eye a little more open than the other.'
// Grok hay cho da BÓNG như nhựa dù prompt đã ghi matte. Khối nhấn cực mạnh này (CHỈ chèn
// cho chân dung Grok) kéo bề mặt về lì, tán sáng đều, lộ lỗ chân lông thật — chống "nhựa".
const GROK_MATTE =
  'Her skin has a completely matte, dry, non-reflective finish: the surface scatters the light softly and evenly ' +
  'across the forehead, nose and cheeks, so those areas stay flat, with no bright shiny or oily highlight. Real ' +
  'pores, fine lines and slight surface roughness stay clearly visible all over the face.'
// Mắt một mí bị model gpt-image-2 "số đông hoá" thành hai mí (mặc định nó vẽ mắt hai mí
// "đẹp"), một cụm lẻ trong danh sách đặc điểm bị lấn át — đúng như ghi chú ở inventDetails:
// model nghe theo SỐ ĐÔNG chứ không nghe một câu lẻ. Khi người dùng chọn một mí, chèn thêm
// câu tả VẬT LÝ này (đặt ngay sau subject cho nặng ký) để tạo "đa số", tả-thật chứ không ra
// lệnh. Chỉ chèn khi giá trị mắt chứa "monolid" (chỉ đúng option một mí mới có).
const MONOLID_EMPHASIS =
  'Her eyes are single-eyelid monolid eyes: each upper eyelid is one smooth, flat, creaseless ' +
  'sweep of skin running straight from the lashes up to the brow bone, with a soft epicanthic ' +
  'fold hooding the inner corner and no separate double-eyelid crease line.'
// Generated lettering is the single most reliable "this is AI" giveaway: shop signs,
// menus and packaging come out as warped pseudo-words. Cheapest fix is to leave nothing
// writable in frame. Phrased as what the surfaces ARE (blank), not as "no text" — the
// models have no negative_prompt and "text" in the prompt tends to produce text.
export const NO_TEXT =
  'Every printed surface in the picture is blank: shop signs, banners, posters, menus, labels and packaging are ' +
  'plain empty panels of flat colour, or are turned away from the camera, or fall outside the frame — so the ' +
  'photo carries no lettering, no words, no numbers, no logos and no watermark anywhere.'
// Dấu hiệu AI thứ hai (sau da bóng): MỌI THỨ ĐỀU THẲNG HÀNG. Ảnh AI hay xếp bàn
// ghế song song, cách đều, chân trời ngang tuyệt đối, người đứng ngay ngắn không
// ai bị cắt. Ảnh thật thì lệch vài độ, cách nhau lộn xộn, người bị mép ảnh cắt cụt.
// ── Nước ảnh: chống "bạc phếch" ────────────────────────────────────────────
// Cả bộ prompt chỉ toàn từ KÌM HÃM — matte, light-absorbing, chalky, mild noise — cộng
// quality='low' (giữ để tiết kiệm), nên không có một chữ nào nói ảnh phải SÁNG và có sức
// sống. Kết quả là ảnh ra u ám, bạc màu. Luồng cũ đã học đúng bài này rồi (xem ghi chú ở
// FACE_SWAP_CAMERA trong FaceSwapWizardLegacy.tsx: bỏ "not over-saturated" vì nó kéo ảnh
// về cái nhìn đầu 2000), nhưng luồng Tạo ảnh nhanh chưa được vá.
// CỐ Ý KHÔNG nhắc màu da ở đây: nói "da hồng hào/rực rỡ" là chọi thẳng khối da lì, hút
// sáng — thứ đang giữ cho mặt trông thật. Khối này chỉ nói về ÁNH SÁNG và MÀU CỦA CẢNH.
/** Ánh sáng CỐ Ý tối (Low-key) — lúc đó khối nước ảnh phải im lặng, không thì "bright,
 *  shadows open" đá thẳng vào "moody low-key" người dùng vừa chọn. */
export function isLowKeyLight(lighting: string): boolean {
  return /low-key/i.test(lighting || '')
}
export const PHONE_GRADE =
  'The picture is bright and clearly lit the way a modern phone renders a scene: the shadows are open rather ' +
  'than muddy, the whites are clean, and the greens and blues of the place are lively and true to life without ' +
  'looking boosted. It reads as a photo taken today, not a faded old snapshot.'
const PHONE_GRADE_VI =
  'Ảnh sáng và rõ đúng kiểu điện thoại đời mới dựng cảnh: vùng tối mở ra chứ không bết đen, vùng trắng sạch, ' +
  'màu xanh lá và xanh dương của cảnh vật tươi và đúng thật chứ không bị đẩy quá tay. Nhìn ra ngay là ảnh chụp ' +
  'thời nay, không phải tấm ảnh cũ bạc màu.'

// CỐ Ý không làm nghiêng chân trời/đường tường ở đây. Bản trước có câu "the horizon and
// the wall lines run a few degrees downhill" để chống-AI, nhưng nó chỉ nghiêng CẢNH —
// còn NGƯỜI bị ảnh chân dung tham chiếu khoá thẳng đứng. Kết quả là "cảnh nghiêng, người
// thẳng", một trạng thái bất khả ngoài đời (máy nghiêng thì mọi thứ nghiêng cùng nhau),
// và nhìn còn giả HƠN là để thẳng. Sự bất đối xứng vẫn giữ được bằng các dấu hiệu KHÁC
// (khoảng cách lệch, vật bị mép cắt, người nền bị che) — không cần tới độ nghiêng.
// Ai muốn ảnh nghiêng thật thì chọn "Nghiêng máy (Dutch)" ở ô Góc máy: chỗ đó nghiêng
// CẢ KHUNG (người + cảnh cùng chiều), đúng vật lý.
export const IMPERFECT =
  'Nothing in the frame lines up. The tables, chairs, poles and objects all sit at slightly different angles to ' +
  'each other and to the edges of the picture; the gaps between things are uneven; some objects are cut in half ' +
  'by the edge of the frame; and the people in the background are cropped by the border or half-hidden behind ' +
  'something else. The camera itself is held level, so the horizon and the vertical wall and door lines stay ' +
  'straight — it is the clutter that is untidy, not the framing. Nothing is symmetrical, parallel or evenly spaced.'

/** The skin paragraph: the picked "Chất da" description + the asymmetry line.
 *  Grok renders skin-texture words LITERALLY — the heavy "Thô rõ" wording (pimples, dark
 *  spots, blotchy, redness) comes out as visible grime/streaks. But the smoothest "Mịn nhẹ"
 *  makes Grok look too-perfect/AI (no pores). So Grok is pinned to the MIDDLE "Thường":
 *  visible pores + slightly uneven tone (real texture) without the spot/redness words that
 *  trigger dirt. GPT/others keep the picked texture (default "Thô rõ" — gpt-image-2 renders
 *  rough skin stably and that is what stops GPT looking AI). */
function skinBlock(sel: QuickSelection, provider?: ImageProvider): string {
  if (provider === 'grok') return `${SKIN_TEX_FIELD.opts[1][1]} ${GROK_MATTE} ${ASYMMETRY}`
  const tex = (sel.skin_tex || SKIN_TEX_FIELD.opts[0][1]).trim()
  return `${tex} ${ASYMMETRY}`
}

/** Grok renders "powder / powdery / chalky / dusting of face powder" LITERALLY — as white
 *  patches smeared on the cheeks (the "trắng bột" bug). GPT reads them correctly as matte
 *  skin, so strip them ONLY for Grok; the matte look still carries from "matte / dry /
 *  light-absorbing / pores visible". */
function stripPowderForGrok(prompt: string): string {
  return prompt
    .replace(/,?\s*(?:just\s+)?a\s+light\s+dusting\s+of\s+face\s+powder/gi, '')
    .replace(/,?\s*(?:just\s+)?a\s+dusting\s+of\s+face\s+powder/gi, '')
    .replace(/\bdry\s+and\s+powdery\b/gi, 'dry')
    .replace(/\band\s+powdery\b/gi, '')
    .replace(/\bpowdered\s+skin\b/gi, 'bare skin')
    .replace(/\bpowdery\b/gi, 'matte')
    .replace(/\bchalky\b/gi, 'matte')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;])/g, '$1')
}
/** Vietnamese preview twin of stripPowderForGrok (keeps the read-along box in sync). */
function stripPowderForGrokVi(preview: string): string {
  return preview
    .replace(/,?\s*chỉ dặm chút phấn/gi, '')
    .replace(/,?\s*dặm chút phấn/gi, '')
    .replace(/,?\s*hơi bột/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;])/g, '$1')
}

// ── Góc quay lưng: PHẢI tháo bỏ mọi khối tả khuôn mặt ───────────────────────
// Chọn "Sau lưng" mà ảnh vẫn ra mặt, là vì phần còn lại của prompt vẫn đang tả mặt
// rất kỹ — "same face, recognizable", "her face AND the background are sharp", cả
// đoạn da nói về lỗ chân lông trên má, đốm thâm ở cằm, quầng mắt, môi khô, "một mắt
// mở to hơn mắt kia". Model nghe theo số đông chứ không nghe một câu lẻ.
// Nên khi quay lưng, ta thay hẳn các khối đó bằng bản tả GÁY / TÓC / VAI.
export function isBackView(head: string): boolean {
  return /seen from behind/i.test(head || '')
}
/** Cỡ cảnh cận mặt + quay lưng = mâu thuẫn. Dịch sang "cận gáy" cho khớp. */
export function hasFaceShotConflict(sel: QuickSelection): boolean {
  return isBackView(sel.head || '') && /close-up/i.test(sel.shot || '')
}
const BACK_SHOT: Record<string, string> = {
  'a close-up of her head and shoulders': 'a close-up of the back of her head and her shoulders',
  'a big close-up, her face filling most of the frame': 'a big close-up of the back of her head, filling most of the frame',
  'an extreme close-up of a single detail — her eyes, her lips or her hands':
    'an extreme close-up of a single detail — her hair, her hands or the nape of her neck',
}
const BACK_SKIN =
  'Only the back of her head, her neck, shoulders and arms are visible. Her hair falls in separate, uneven strands ' +
  'with a few flyaways standing up; the skin of her neck, shoulders and arms is bare, dry and matte, with real ' +
  'texture — fine hairs, a mole or two, slightly uneven tone — and it absorbs the light instead of bouncing it back.'
const BACK_SKIN_VI =
  'Chỉ thấy gáy, cổ, vai và cánh tay của cô. Tóc rẽ thành từng lọn không đều, vài sợi dựng lên lòa xòa; da cổ, ' +
  'vai và tay để mộc, khô và lì, có kết cấu thật — lông tơ, một hai nốt ruồi, màu da hơi không đều — và hút sáng ' +
  'chứ không hắt sáng lên.'
const LEAD_BACK =
  'Keep the same young woman shown in attached image 1 — the same hair, hairstyle, build and skin tone. In THIS ' +
  'photo she is turned away from the camera, so her face is NOT visible at all: the picture shows her from behind. ' +
  'It is an ordinary everyday iPhone 13 Pro snapshot of her, posted straight to Facebook.'
const LEAD_BACK_VI =
  'Giữ nguyên cô gái trong ảnh 1 đính kèm — cùng mái tóc, kiểu tóc, dáng người và màu da. Nhưng trong ảnh NÀY cô ' +
  'quay lưng lại máy ảnh, nên KHÔNG nhìn thấy mặt cô: bức ảnh chụp cô từ phía sau. Đây là một tấm ảnh iPhone 13 ' +
  'Pro đời thường của cô, đăng thẳng lên Facebook.'

// ── Cỡ cảnh từ toàn thân trở ra: cũng PHẢI tháo bỏ khối tả khuôn mặt ────────
// Cùng một căn bệnh với góc quay lưng ngay trên, chỉ khác trục. Khối da "Thô rõ" dài
// ~107 từ, đòi lỗ chân lông trên má đổ bóng, mụn và đốm thâm ở cằm, lông tơ dọc quai
// hàm, môi khô nứt, "một mắt mở to hơn mắt kia". Muốn NHÌN THẤY chừng ấy thì khuôn mặt
// phải chiếm cỡ một phần tư khung hình — mà toàn cảnh thì mặt chỉ vài chục pixel. Hai
// yêu cầu loại trừ nhau về mặt vật lý, và phe tả mặt đông gấp tám lần câu cỡ cảnh, nên
// model kéo máy lại gần cho đủ chỗ vẽ da. Đó là lý do khách kêu "người lúc nào cũng to"
// và ba lần sinh ra ba độ rộng khác nhau.
// Ở khoảng cách đó, thứ THẬT SỰ mang kết cấu là tóc và nếp vải — nên tả đúng chúng.
export function isWideShot(shot: string): boolean {
  // Selfie dang tay cũng dùng ống 0.5× nhưng MẶT LẠI RẤT TO (chủ thể ở ngay đầu tay),
  // nên phải giữ khối da chi tiết. Loại trừ tường minh, đừng phụ thuộc vào việc chuỗi
  // của nó tình cờ không chứa chữ "wide shot".
  return !isArmSelfie(shot) && /wide shot|full shot/i.test(shot || '')
}

// ── Selfie dang thẳng tay: máy do CHÍNH chủ thể cầm ─────────────────────────
// Khác hẳn mọi cỡ cảnh còn lại, nên phải thay cả khối bố cục. candidFrame ép "cô LỆCH
// HẲN sang một bên, chừa nhiều khoảng trống, để NƠI CHỐN — không phải con người —
// chiếm phần lớn khung": đúng cho ảnh người khác chụp, nhưng ngược hẳn với selfie dang
// tay (người cầm máy ở ngay đầu tay nên to và gần). Để nguyên là lại rơi vào đúng cái
// bẫy prompt-tự-mâu-thuẫn đã làm cỡ cảnh xa mỗi lần ra một độ rộng.
export function isArmSelfie(shot: string): boolean {
  return /at the full stretch of her own arm/i.test(shot || '')
}
/** Selfie dang tay + quay lưng = bất khả: không thể tự cầm máy chụp mình mà lại quay
 *  lưng vào ống kính. Chế độ selfie thắng, nhưng phải báo cho người dùng biết. */
export function hasSelfieBackConflict(sel: QuickSelection): boolean {
  return isArmSelfie(sel.shot || '') && isBackView(sel.head || '')
}
const ARM_SELFIE_GROUP_RE = /group selfie/i
// Cánh tay cầm máy là CHỮ KÝ của kiểu ảnh này — thiếu nó thì chỉ là một tấm ảnh góc cao
// bình thường. Tả bằng VẬT LÝ (gần ống kính quá nên mất nét) chứ không ra lệnh "hãy vẽ
// một cánh tay mờ": model dựng hình từ quang học tốt hơn nhiều so với từ mệnh lệnh.
// Viết CÔ ĐỌNG có chủ ý: prompt cảnh vốn đã ~3.9k ký tự ở cấu hình dài nhất, thêm
// khối nào cũng phải trả giá bằng khối khác. Giữ đúng phần quang học, bỏ hết chữ thừa.
// Cánh tay SẮC NÉT, không mờ. Bản đầu viết "nhoè" là lấy nhầm từ video tham chiếu —
// ở đó tay nhoè vì đang VUNG (motion blur), không phải mất nét. Ống siêu rộng điện
// thoại có nét sâu nên vật cách 20cm vẫn nét: ảnh tham chiếu tĩnh của khách thấy rõ
// từng đường gân áo len và đọc được cả mặt đồng hồ. Quan trọng hơn, chữ "blur" ở đây
// đá thẳng vào cameraBlock ("equally sharp and fully in focus — no lens blur") — đúng
// cái bẫy prompt-tự-mâu-thuẫn đã làm cỡ cảnh xa mỗi lần ra một kiểu.
// Thứ làm cánh tay trông lạ là BỊ PHÓNG TO VÀ KÉO GIÃN vì quá gần ống kính, nên tả đó.
const ARM_SELFIE_ARM =
  'Her own arm runs from the bottom corner of the frame up and out towards the camera she holds. Being so much ' +
  'nearer the lens, it is drawn far larger than the rest of her — a broad, stretched forearm crossing the corner ' +
  'of the picture, still sharp and fully in focus, with the watch or bracelet on that wrist clearly visible.'
const ARM_SELFIE_ARM_VI =
  'Cánh tay của chính cô chạy từ góc dưới khung vươn lên phía máy. Vì ở gần ống kính hơn hẳn nên nó được vẽ to ' +
  'hơn phần còn lại của cô rất nhiều — một cẳng tay bè ra, kéo giãn, cắt ngang góc ảnh, vẫn SẮC NÉT hoàn toàn, ' +
  'đồng hồ hay vòng tay đeo ở cổ tay đó nhìn rõ.'
const ARM_SELFIE_FRAME =
  'She is at the near end of her own arm, much closer to the lens than anything else: large in the frame, pushed ' +
  'to one side and cut off by its edge, seen a little from above because the phone is up over her head and ' +
  'tipped down at her. Behind and below her the ultra-wide lens opens the whole place out, small and far below, ' +
  'its edges gently stretched.'
const ARM_SELFIE_FRAME_VI =
  'Cô ở đầu gần của chính cánh tay mình, gần ống kính hơn mọi thứ khác rất nhiều: to trong khung, dạt sang một ' +
  'bên và bị mép ảnh cắt cụt, nhìn hơi chúc từ trên xuống vì máy giơ cao quá đầu và hất xuống phía cô. Phía sau ' +
  'và dưới cô, ống siêu rộng mở toang cả nơi chốn, nhỏ và thấp hẳn xuống, rìa khung hơi kéo giãn.'
const ARM_SELFIE_FRAME_GROUP =
  'She is at the near end of her own arm, much closer to the lens than anyone else: large in the frame, pushed ' +
  'to one side and cut off by its edge, seen a little from above because the phone is up over her head and ' +
  'tipped down. Her friends stand behind her on the same ground, smaller for being further from the lens, ' +
  'looking up at the camera. Behind them the ultra-wide lens opens the whole place out, its edges gently ' +
  'stretched.'
const ARM_SELFIE_FRAME_GROUP_VI =
  'Cô ở đầu gần của chính cánh tay mình, gần ống kính hơn mọi người khác rất nhiều: to trong khung, dạt sang một ' +
  'bên và bị mép ảnh cắt cụt, nhìn hơi chúc từ trên xuống vì máy giơ cao quá đầu và hất xuống. Nhóm bạn đứng phía ' +
  'sau cô trên cùng mặt đất, nhỏ hơn hẳn vì ở xa ống kính hơn, ngước lên phía máy. Phía sau họ, ống siêu rộng ' +
  'mở toang cả nơi chốn, rìa khung hơi kéo giãn.'
// Ô "Góc máy" bị chế độ này ghi đè: máy nằm trong tay chủ thể, giơ quá đầu — không thể
// đồng thời "sát đất nhìn lên" được. Cùng cách BACK_SHOT ghi đè cỡ cảnh khi quay lưng.
const ARM_SELFIE_ANGLE = 'held above her head and angled down at her'
const ARM_SELFIE_ANGLE_VI = 'máy giơ cao quá đầu, hất chúc xuống phía cô'
const FAR_SKIN =
  'She is far enough from the camera that no skin detail is resolved: her face is small in the frame and reads ' +
  'as a plain, soft shape, with no pores, blemishes or fine lines picked out. What carries the texture at this ' +
  'distance is her hair — separate uneven strands with a few flyaways — and the cloth of her outfit, which ' +
  'creases and hangs the way real fabric does. Her skin is a dry, matte, even tone that absorbs the light ' +
  'instead of bouncing it back.'
const FAR_SKIN_VI =
  'Cô ở đủ xa để không phân giải được chi tiết da: khuôn mặt nhỏ trong khung, chỉ đọc thành một mảng mềm, không ' +
  'nổi lỗ chân lông, nốt mụn hay nếp nhăn. Ở khoảng cách này thứ mang kết cấu là mái tóc — từng lọn không đều, ' +
  'vài sợi bay lòa xòa — và vải áo, nhăn và rủ đúng kiểu vải thật. Da chỉ là một mảng màu khô, lì, đều, hút ' +
  'sáng chứ không hắt lên.'
// "recognizable" là một yêu cầu bất khả ở cỡ cảnh xa: muốn nhận ra mặt thì mặt phải đủ
// to, nên chính chữ đó kéo máy lại gần. Danh tính vẫn giữ được bằng những thứ CÒN đọc
// được ở khoảng cách này — tóc, kiểu tóc, dáng người, màu da.
const LEAD_FAR =
  'Keep the same young woman shown in attached image 1 — the same hair, hairstyle, build and skin tone; only ' +
  'the scene, pose and outfit change. In THIS photo she is far from the camera, so her face is small in the ' +
  'frame and is not drawn in fine detail. It is an ordinary everyday iPhone 13 Pro snapshot of her, posted ' +
  'straight to Facebook.'
const LEAD_FAR_VI =
  'Giữ nguyên cô gái trong ảnh 1 đính kèm — cùng mái tóc, kiểu tóc, dáng người và màu da; chỉ đổi bối cảnh, tư ' +
  'thế và trang phục. Trong ảnh NÀY cô ở xa máy, nên khuôn mặt nhỏ trong khung và không vẽ chi tiết. Đây là một ' +
  'tấm ảnh iPhone 13 Pro đời thường của cô, đăng thẳng lên Facebook.'
// Tạo "SỐ ĐÔNG" cho khoảng cách, đúng thủ thuật của MONOLID_EMPHASIS ở trên: một câu cỡ
// cảnh lẻ loi luôn bị lấn át, nên nhắc lại tỉ lệ ngay sau lead — chỗ nặng ký nhất của
// prompt. Vẫn tả-thật chứ không ra lệnh cấm (các model không có negative_prompt).
// Liệt kê phải TRUNG TÍNH với trong nhà / ngoài trời: bản đầu ghi thẳng "cây cối, bầu
// trời" nên một cảnh quán cà phê trong nhà vẫn bị model nhét cây và trời vào.
const FAR_SCALE =
  'The camera stays well back from her. Measured against the height of the picture she is small, and the great ' +
  'majority of the frame is the place itself — the ground she stands on, whatever surrounds her, and the other ' +
  'people going about their day.'
const FAR_SCALE_VI =
  'Máy đứng lùi hẳn ra xa. So với chiều cao khung hình thì cô nhỏ, và phần lớn khung hình là chính nơi chốn — ' +
  'mặt đất cô đang đứng, mọi thứ vây quanh cô, và những người khác đang đi lại.'

// ── Bản tiếng Việt, CHỈ để người dùng đọc ───────────────────────────────────
// Ảnh vẫn luôn được sinh từ prompt tiếng Anh ở trên: các model hiểu tiếng Anh
// tốt hơn hẳn, và cả bộ từ vựng chống-AI (hút sáng, lệch tâm, biển trống…) đã
// được cân từng chữ bằng tiếng Anh. Đây là bản dịch song song để anh đọc/soát,
// không phải bản gửi đi — sửa gì thì sửa ở tab «English (gửi đi)».
const CAM_VI =
  'Ảnh chụp bằng iPhone 13 Pro, cầm tay, xuất thẳng từ máy và chưa chỉnh sửa: màu ảnh điện thoại bình thường, ' +
  'khung hình lệch tâm nhưng KHÔNG nghiêng — máy cầm ngang nên chân trời và các đường dọc vẫn thẳng đứng.'
const ASYMMETRY_VI = 'Mặt hơi bất đối xứng, một mắt mở to hơn mắt kia một chút.'
const GROK_MATTE_VI =
  'Da hoàn toàn lì, khô, không phản chiếu: bề mặt tán sáng đều và dịu ở trán, mũi và má nên các vùng đó phẳng, ' +
  'không có điểm bóng dầu; lỗ chân lông thật, nếp nhăn mảnh và độ nhám bề mặt hiện rõ khắp mặt.'
const NO_TEXT_VI =
  'Mọi bề mặt có in ấn trong ảnh đều để trống: biển hiệu, băng rôn, áp phích, thực đơn, nhãn mác, bao bì đều là ' +
  'mảng màu trơn, hoặc quay lưng lại máy ảnh, hoặc nằm ngoài khung — nên trong ảnh không có chữ, không có số, ' +
  'không logo và không watermark ở bất cứ đâu.'
function candidFrameVi(sel: QuickSelection): string {
  const fg = viOf(QUICK_SCENE_FIELDS, 'foreground', sel.foreground || '')
  const fgClause = sel.foreground && sel.foreground !== 'none'
    ? ` Có vật ở TIỀN CẢNH, sát ống kính, che mất một phần cô: ${sel.foreground_vi || fg}.`
    : ''
  const bg = (sel.clutter_vi || sel.clutter || '').trim()
    ? `Rải khắp hậu cảnh: ${sel.clutter_vi || sel.clutter}.`
    : 'Dù ở đâu thì chỗ đó cũng đông đúc và có hơi người: người khác đang làm việc của họ, cùng những đồ đạc ' +
      'lộn xộn vốn thuộc về đúng nơi ấy, rải khắp hậu cảnh.'
  return (
    'Bố cục cẩu thả như một tấm ảnh chụp vội: cô LỆCH HẲN sang một bên khung chứ không đứng chính giữa, chừa lại ' +
    'nhiều khoảng trống tầm thường xung quanh, nên ĐỊA ĐIỂM — chứ không phải con người — mới chiếm phần lớn bức ' +
    `ảnh. ${bg}${fgClause} Khung hình lệch tâm và cắt cúp vụng về, như bấm máy vội — nhưng máy cầm ngang nên chân trời và các đường dọc vẫn thẳng; chỉ có bố cục là cẩu thả, không phải độ nghiêng.`
  )
}
const IMPERFECT_VI =
  'Không có gì trong khung hình thẳng hàng cả. Bàn, ghế, cột và đồ vật đều lệch nhau vài độ, và lệch cả so với ' +
  'mép ảnh; khoảng cách giữa các vật không đều nhau; vài món bị mép ảnh cắt cụt làm đôi; người phía sau bị viền ' +
  'ảnh cắt ngang hoặc bị vật khác che mất một nửa. Máy cầm ngang nên đường chân trời và các đường tường, đường ' +
  'dọc vẫn thẳng — chỉ có đống đồ đạc là bừa bộn, còn khung thì không nghiêng. Không gì đối xứng, song song hay ' +
  'cách đều nhau.'

/** Nhãn tiếng Việt của giá trị đang chọn; chữ anh tự gõ thì giữ nguyên. */
function viOf(fields: QuickField[], key: string, value: string): string {
  const v = (value || '').trim()
  const f = fields.find((x) => x.key === key)
  return f?.opts.find(([, en]) => en === v)?.[0] ?? v
}
function skinBlockVi(sel: QuickSelection, provider?: ImageProvider): string {
  if (provider === 'grok') return `${SKIN_TEX[1][2]} ${GROK_MATTE_VI} ${ASYMMETRY_VI}`
  const v = (sel.skin_tex || SKIN_TEX[0][1]).trim()
  const tex = SKIN_TEX.find(([, en]) => en === v)?.[2] ?? v
  return `${tex} ${ASYMMETRY_VI}`
}
/** «27» → «27 tuổi»; nhãn có sẵn hoặc chữ tự gõ thì giữ nguyên. */
function agePhraseVi(value: string): string {
  const raw = (value || '').trim()
  if (!raw) return 'ngoài 20'
  if (/^\d{1,2}(\s*[-–]\s*\d{1,2})?$/.test(raw)) return `${raw.replace(/\s*[-–]\s*/, '–')} tuổi`
  return raw
}

export function buildQuickCharacterPromptVi(sel: QuickSelection, provider?: ImageProvider): string {
  const g = (k: string) => viOf(QUICK_CHARACTER_FIELDS, k, sel[k] || '')
  // Cùng quy tắc như bản tiếng Anh: có mức nhan sắc thì gỡ hết phần tả nét mặt.
  const beauty = (sel.beauty || '').trim()
  const looksVi = faceSentence(sel, beauty, true) || BEAUTY_PHRASES_VI[beauty]
  const skinVi = BEAUTY_SKIN_VI[beauty] || g('skin')
  const subject = looksVi
    ? `Ảnh đời thường của một cô gái ${g('nation')}, ${agePhraseVi(sel.age || '')}, do bạn chụp bằng iPhone 13 Pro ` +
      'rồi đăng thẳng lên Facebook. ' +
      `Cô có da ${skinVi}, tóc ${g('hair_style')} màu ${g('hair_color')} với vài sợi bay lòa xòa, đang nhìn thẳng ` +
      `vào máy ảnh. ${looksVi} Cô mặc một chiếc áo thường đơn giản, để mặt mộc, chỉ dặm chút phấn.`
    : `Ảnh đời thường của một cô gái ${g('nation')}, ${agePhraseVi(sel.age || '')}, do bạn chụp bằng iPhone 13 Pro ` +
      'rồi đăng thẳng lên Facebook. ' +
      `Cô có khuôn mặt ${g('face')}, da ${skinVi}, tóc ${g('hair_style')} màu ${g('hair_color')} với vài sợi bay ` +
      `lòa xòa, mắt ${g('eyes')}, mũi ${g('nose')}, môi ${g('lips')}, biểu cảm ${g('expression')}, đang nhìn thẳng ` +
      `vào máy ảnh.${faceExtra(sel, beauty, true)} ` +
      'Cô mặc một chiếc áo thường đơn giản, để mặt mộc, chỉ dặm chút phấn.'
  // PHẢI khớp đúng danh sách khối của buildQuickCharacterPrompt — đây là ô XEM TRƯỚC,
  // hiện nhiều hơn thứ thật sự gửi đi là nói dối người dùng. (Bản đầu khi cắt prompt
  // xuống 2 khối đã quên sửa chỗ này: EN 1.488 ký tự mà preview VI vẫn 2.650.)
  const outVi = [subject, CAM_VI, skinBlockVi(sel, provider)].join('\n\n')
  return provider === 'grok' ? stripPowderForGrokVi(outVi) : outVi
}

export function buildQuickScenePromptVi(sel: QuickSelection, keepFace = true, sceneRef = false, provider?: ImageProvider): string {
  const g = (k: string) => viOf(QUICK_SCENE_FIELDS, k, sel[k] || '')
  if (sceneRef) {
    const lead =
      'Ảnh 1 là một tấm ảnh CÓ THẬT của một nơi chốn. Giữ nguyên xi nơi đó: y nguyên hậu cảnh, đồ vật, ánh sáng, ' +
      'màu sắc, góc máy và bố cục. Lấy cô gái trong ảnh 2 (giữ đúng khuôn mặt, tóc và màu da) rồi đặt cô vào ' +
      'trong khung cảnh đó, tự nhiên như thể cô có mặt ở đấy lúc bấm máy — ánh sáng, bóng đổ, tỉ lệ người và ' +
      'phối cảnh đều phải khớp với tấm ảnh gốc.'
    const outfit = g('outfit') === 'Giữ như ảnh gốc' ? 'trang phục như trong ảnh 2 (ảnh nhân vật)' : g('outfit')
    const scene = `Cô đang ${g('pose')}, mặc ${outfit}. Góc khuôn mặt: ${g('head')}.`
    return [lead, scene, skinBlockVi(sel, provider)].join('\n\n')
  }
  // isArmSelfie/isWideShot/isBackView đọc GIÁ TRỊ EN (sel.*), không đọc nhãn tiếng Việt
  // do g() trả về.
  const selfie = isArmSelfie(sel.shot || '')
  const back = !selfie && isBackView(sel.head || '')
  const far = isWideShot(sel.shot || '')
  const lead = !keepFace
    ? 'Một tấm ảnh iPhone 13 Pro đời thường chụp một cô gái trẻ, đăng thẳng lên Facebook.'
    : back
      ? LEAD_BACK_VI
      : far
        ? LEAD_FAR_VI
        : 'Giữ nguyên cô gái trong ảnh 1 đính kèm — cùng khuôn mặt, mái tóc và màu da, nhất quán và nhận ra được; ' +
          'chỉ đổi bối cảnh, tư thế và trang phục. Đây là một tấm ảnh iPhone 13 Pro đời thường của cô, đăng thẳng ' +
          'lên Facebook.'
  const shot = back && hasFaceShotConflict(sel) ? `${g('shot')} — nhưng là cận GÁY, không phải cận mặt` : g('shot')
  const gaze = back ? '' : g('gaze')
  const scene =
    `Cô đang ${g('pose')} tại ${g('location')} — ${g('region')}, mặc ${g('outfit')}. Góc khuôn mặt: ${g('head')}. ` +
    `${gaze ? `Ánh mắt: ${gaze}. ` : ''}Ánh sáng: ${g('lighting')}. Tông màu: ${g('tone')}. Cỡ cảnh: ${shot}. ` +
    `Góc máy: ${selfie ? ARM_SELFIE_ANGLE_VI : g('angle')}. Phong cách: ${g('style')}. Mọi thứ ở hậu cảnh — nhà ` +
    'cửa, đường phố, đồ vật và những người khác — đều phải thuộc về đúng nơi đó, không lẫn đi đâu.'
  const clutterVi = (sel.clutter_vi || sel.clutter || '').trim()
  const frameVi = selfie
    ? [ARM_SELFIE_GROUP_RE.test(sel.shot || '') ? ARM_SELFIE_FRAME_GROUP_VI : ARM_SELFIE_FRAME_VI,
       ...(clutterVi ? [`Xuyên suốt hậu cảnh: ${clutterVi}.`] : []),
       ARM_SELFIE_ARM_VI].join('\n\n')
    : candidFrameVi(sel)
  return [lead, ...(far ? [FAR_SCALE_VI] : []), scene, frameVi, IMPERFECT_VI, cameraBlockVi(sel),
    back ? BACK_SKIN_VI : far ? FAR_SKIN_VI : skinBlockVi(sel, provider),
    ...(isLowKeyLight(sel.lighting || '') ? [] : [PHONE_GRADE_VI]),
    ...(provider === 'grok' ? [] : [NO_TEXT_VI])].join('\n\n')
}

/** The age slot reads "…woman <phrase>", so a bare number typed into the free-text box
 *  ("27", "25-30") has to become a phrase; anything else is used exactly as typed. */
export function agePhrase(value: string): string {
  const raw = (value || '').trim()
  if (!raw) return 'in her 20s'
  if (/^\d{1,2}(\s*[-–]\s*\d{1,2})?$/.test(raw)) return `aged ${raw.replace(/\s*[-–]\s*/, '–')}`
  return raw
}

/** Khối "ảnh thật" của ẢNH NHÂN VẬT: máy ảnh điện thoại, ánh sáng xiên (làm nổi lỗ chân
 *  lông), nét sâu (không xoá phông), kết cấu da + bất đối xứng, bố cục lệch, bề mặt in ấn để
 *  trống. Tách riêng vì khi người dùng XOÁ SẠCH prompt rồi tự gõ, cả 6 khối này biến mất theo
 *  — thiếu chúng là ảnh ra kiểu beauty render: da nhựa, nền bokeh, mặt cân đối hoàn hảo. FE
 *  nối lại khối này lúc GỬI (xem withRealism ở QuickImagePage), nên đây là nguồn duy nhất:
 *  prompt dựng sẵn và prompt người dùng tự gõ luôn dùng chung một bộ, không thể lệch nhau. */
/** Trần độ dài prompt sinh ảnh — giới hạn CỦA MÌNH, KHÔNG phải của model.
 *
 *  Tài liệu OpenAI: nhóm "GPT image models" (có gpt-image-2) cho tới 32.000 ký tự ở cả
 *  images.generate lẫn images.edit; 4.000 là trần của dall-e-3, model mình không dùng.
 *  Đã đo thật 22/07/2026: prompt 4.500 ký tự chạy tốt trên cả hai endpoint.
 *  Vẫn giữ trần thấp có chủ ý: prompt của mình là nhiều KHỐI xếp chồng, và bệnh kinh niên
 *  ở đây là khối dài lấn át khối ngắn (xem các ghi chú isWideShot / isArmSelfie). Nới rộng
 *  quá là mời thêm block chồng lên nhau.
 *
 *  BẢN SAO của `MAX_PROMPT_LEN` trong mobile-control/content/views.py — hai nơi BẮT BUỘC
 *  phải trùng số. FE giữ một bản để chặn ngay lúc gõ (backend chỉ báo được sau khi đã bấm
 *  sinh); backend vẫn phải tự kiểm vì nó là cửa cuối. Sửa một bên thì sửa cả bên kia. */
export const MAX_IMAGE_PROMPT_LEN = 5000

export function buildCharacterRealismTail(sel: QuickSelection, provider?: ImageProvider): string {
  // CẮT NGẮN 19/08/2026 — đo bằng 9 ảnh, xem docs/test-nhan-sac/v3-do-do-dai/.
  // Khối này từng có 7 phần (CAM, RAKING_LIGHT, DEEP_FOCUS, skin, PHONE_GRADE, IMPERFECT,
  // NO_TEXT) = 3.421 ký tự. Ba biến thể cùng mức nhan sắc "Trung bình":
  //   V1 đầy đủ      3.421 ký tự → ảnh đạt
  //   V2 CAM + skin  1.578 ký tự → ảnh ĐẠT NGANG V1, da vẫn rõ lỗ chân lông
  //   V3 chỉ subject   698 ký tự → mặt vẫn đúng NHƯNG da mịn lại, quay về bệnh "da AI"
  // Nên giữ đúng 2 khối mang tải thật: CAM (chất ảnh chụp điện thoại) và skinBlock (chất
  // da — thứ duy nhất chống được da nhựa). Năm khối còn lại tả ánh sáng/độ sâu/hậu kỳ/bố
  // cục/không-chữ: đo thấy bỏ đi ảnh không xấu đi, mà tiết kiệm 54% độ dài prompt, kéo
  // theo giảm tiền token và bớt ~7 giây dịch mỗi ảnh.
  //
  // CHỈ áp cho ảnh NHÂN VẬT (chân dung cận mặt, nền không quan trọng). Ảnh CẢNH vẫn dùng
  // đủ khối qua buildSceneRealismTail — ở đó bố cục và chuyện không-vẽ-chữ mới có giá trị.
  // (Vì thế tham số `provider` không còn nhánh riêng cho Grok: NO_TEXT — khối duy nhất
  // Grok đọc sai — đã không còn nằm trong danh sách.)
  return [CAM, skinBlock(sel, provider)].join('\n\n')
}

export function buildQuickCharacterPrompt(sel: QuickSelection, provider?: ImageProvider): string {
  const g = (k: string) => (sel[k] || '').trim()
  // Mức nhan sắc ≠ 'pretty' thì BỎ HẲN face/eyes/nose/lips/expression rồi mới đặt câu
  // nhan sắc vào — giữ lại là để hai vế đánh nhau, xem ghi chú ở BEAUTY_FIELD. Tóc vẫn
  // giữ vì đó là nhận dạng nhân vật, không phải nhan sắc; màu da thì đi theo mức.
  // Ưu tiên tổ hợp bốc từ thực đơn (đa dạng); thiếu ô nào thì rơi về câu cố định
  // BEAUTY_PHRASES — giữ để mọi lời gọi cũ chưa có f_* vẫn chạy y như trước.
  const looks = faceSentence(sel, g('beauty')) || BEAUTY_PHRASES[g('beauty')]
  const skin = beautySkin(g('beauty')) || g('skin')
  const subject = looks
    ? `An ordinary everyday snapshot of ${g('nation')} woman ${agePhrase(g('age'))}, taken by a friend on an ` +
      'iPhone 13 Pro and posted straight to Facebook. ' +
      `She has ${skin} and ${g('hair_style')} ${g('hair_color')} hair with loose flyaway strands, and she is ` +
      `looking straight at the camera. ${looks} ` +
      `She wears a simple plain everyday top; ${g('makeup') || 'her face is bare, with just a dusting of face powder'}.`
    : `An ordinary everyday snapshot of ${g('nation')} woman ${agePhrase(g('age'))}, taken by a friend on an ` +
      'iPhone 13 Pro and posted straight to Facebook. ' +
      `She has ${g('face')}, ${skin}, ${g('hair_style')} ${g('hair_color')} hair with loose flyaway strands, ` +
      `${g('eyes')}, ${g('nose')}, ${g('lips')}, and ${g('expression')}, looking straight at the camera.` +
      // Bù 4 chiều đường cũ bỏ trống (cằm, gò má, thân hình, trán) — xem FACE_MENU_DEP.
      `${faceExtra(sel, g('beauty'))} ` +
      `She wears a simple plain everyday top; ${g('makeup') || 'her face is bare, with just a dusting of face powder'}.`
  const parts = [subject]
  // Nhắc lại đặc điểm mắt một mí ngay sau subject khi được chọn (xem MONOLID_EMPHASIS).
  // Bỏ qua khi có mức nhan sắc: lúc đó ô Mắt đã bị gỡ khỏi subject, nhấn lại một nét
  // không còn được tả nữa là tự mâu thuẫn — và câu nhan sắc đã tự tả mí mắt rồi.
  if (!looks && g('eyes').includes('monolid')) parts.push(MONOLID_EMPHASIS)
  parts.push(buildCharacterRealismTail(sel, provider))
  const out = parts.join('\n\n')
  return provider === 'grok' ? stripPowderForGrok(out) : out
}

// The other big AI tell (besides plastic skin) is COMPOSITION: a person centred, filling
// the frame, perfectly upright, nothing overlapping her, in a suspiciously tidy empty
// room. A real snapshot is off-centre, cluttered and partly blocked — but NOT tilted:
// the camera is held level so verticals stay straight (a tilted scene over an upright
// reference-locked person reads as fake — that mismatch is exactly what we removed).
// Scene-only — the character portrait stays centred and clear (it is the face reference).
// LƯU Ý ĐẮT GIÁ: bản trước viết "the back of a chair, the edge of a table, or a person
// walking past" — định cho model 3 ví dụ để nó tự chọn. Nhưng model KHÔNG chọn ngẫu
// nhiên: nó bám vào danh từ cụ thể ĐẦU TIÊN, nên ảnh nào cũng mọc ra một cái ghế.
// Giờ vật che tiền cảnh do người dùng chọn (ô "Vật che tiền cảnh"), và trong khối này
// không còn một danh từ đồ vật nào bị viết cứng.
// Cũng bỏ luôn "ceiling, floor and wall" + "the room": chúng mặc định mọi cảnh là phòng
// kín, nên chọn "bãi biển" thì model vẫn cố nhét bàn ghế và trần nhà vào.
function candidFrame(sel: QuickSelection): string {
  const fg = (sel.foreground || '').trim()
  const fgClause = fg && fg !== 'none'
    ? ` Something in the FOREGROUND, close to the lens and slightly out of place, partly overlaps her: ${fg}.`
    : ''
  const clutter = (sel.clutter || '').trim()
  const bg = clutter
    ? `Through the background: ${clutter}.`
    : 'Wherever she is, the spot is busy and lived-in: other people going about their business, and the ' +
      'everyday clutter that naturally belongs in that particular place, all through the background.'
  return (
    'Carelessly composed, like a real snapshot: she is clearly OFF-CENTER, pushed toward one side of the frame ' +
    'instead of posed in the middle, with plenty of empty, ordinary space left around her, so the PLACE — not ' +
    `the person — fills most of the picture. ${bg}${fgClause} The frame is off-center and awkwardly ` +
    'cropped, as if snapped in a hurry — but the camera is held level, so the horizon and vertical lines stay '
    + 'straight; it is the composition that is careless, not the tilt.'
  )
}

// Scene reuses CAM + DEEP_FOCUS + skinBlock (so a face-kept edit doesn't smooth the skin
// back out or blur its background) but takes the light from the dropdowns, not RAKING_LIGHT.
// `sceneRef` = người dùng đã TẢI LÊN một ảnh bối cảnh có thật. Lúc đó ảnh 1 là cái
// cảnh đó, ảnh 2 là nhân vật, và ta chỉ ghép người vào — nên phải BỎ hết các khối
// tự tả cảnh (địa điểm, ánh sáng, tông màu, cỡ cảnh, bố cục, biển trống): chúng sẽ
// ĐÁNH NHAU với tấm ảnh thật, khiến model vẽ lại nền thay vì giữ nguyên nó.
/** Khối "ảnh thật" của ẢNH CẢNH — bản song song của buildCharacterRealismTail, dùng chung
 *  cho prompt dựng sẵn lẫn prompt người dùng tự gõ.
 *  QUAN TRỌNG: chế độ ghép vào ảnh cảnh CÓ THẬT (`sceneRef`) chỉ giữ khối da. Các khối bố
 *  cục / máy ảnh / biển trống sẽ ĐÁNH NHAU với tấm ảnh thật, khiến model vẽ lại nền thay vì
 *  giữ nguyên (xem ghi chú ngay dưới). Quay lưng thì dùng BACK_SKIN (khối da không tả mặt). */
export function buildSceneRealismTail(sel: QuickSelection, sceneRef = false, provider?: ImageProvider): string {
  if (sceneRef) return skinBlock(sel, provider)
  const selfie = isArmSelfie(sel.shot || '')
  // Selfie dang tay thắng góc quay lưng: tự cầm máy chụp mình thì không thể quay lưng
  // vào ống kính (hasSelfieBackConflict cảnh báo cho người dùng biết). Quay lưng thắng
  // cỡ cảnh xa: BACK_SKIN vốn đã không tả mặt, còn FAR_SKIN lại nhắc "khuôn mặt nhỏ
  // trong khung" — câu đó sẽ chọi lại chính góc quay lưng.
  const back = !selfie && isBackView((sel.head || '').trim())
  const far = isWideShot(sel.shot || '')
  // Chế độ selfie thay nguyên khối candidFrame, mà "clutter" (chi tiết hậu cảnh do GPT
  // bịa riêng cho địa điểm) lại nằm trong đó — mất nó là hậu cảnh trở về chung chung.
  // Giữ lại, nhưng CHỈ khi GPT đã bịa ra thật: câu dự phòng chung chung của candidFrame
  // thì đã có câu "mọi thứ ở hậu cảnh đều thuộc về đúng nơi đó" trong phần cảnh lo rồi,
  // và prompt kiểu này đã dài sát trần MAX_IMAGE_PROMPT_LEN.
  const clutter = (sel.clutter || '').trim()
  const frame = selfie
    ? [ARM_SELFIE_GROUP_RE.test(sel.shot || '') ? ARM_SELFIE_FRAME_GROUP : ARM_SELFIE_FRAME,
       ...(clutter ? [`Through the background: ${clutter}.`] : []),
       ARM_SELFIE_ARM].join('\n\n')
    : candidFrame(sel)
  return [frame, IMPERFECT, cameraBlock(sel),
    back ? BACK_SKIN : far ? FAR_SKIN : skinBlock(sel, provider),
    ...(isLowKeyLight(sel.lighting || '') ? [] : [PHONE_GRADE]),
    ...(provider === 'grok' ? [] : [NO_TEXT])].join('\n\n')
}

/** Câu "neo" mở đầu prompt cảnh — nói cho model biết ảnh tham chiếu (mặt nhân vật đã khoá,
 *  và/hoặc ảnh bối cảnh thật) dùng vào việc gì ("Image 1 là X, Image 2 là Y…"). Tách khỏi
 *  buildQuickScenePrompt (thay vì viết thẳng trong đó) để nơi khác — PromptBox khi người dùng
 *  tự gõ tay ở QuickImagePage.tsx — khoá được đúng câu này vào prompt gửi đi.
 *
 *  Lý do phải khoá: ảnh tham chiếu được đính kèm ĐỘC LẬP với ô prompt, đọc thẳng từ state
 *  (chosenFace/sceneRef, xem genScene()) chứ không phụ thuộc người dùng gõ gì. Thiếu câu neo
 *  này thì model nhận được ảnh tham chiếu mà không biết dùng vào việc gì → hay lẫn/sai mặt
 *  hoặc sai cảnh dù người dùng gõ tay đúng ý — đúng bug khách báo "nhét tay prompt vẫn sinh
 *  sai ý ạ". Trước đây khối "ảnh thật" nối vào prompt tự gõ (buildSceneRealismTail, xem dưới)
 *  chỉ có máy ảnh/da/ánh sáng, không có câu neo này — đây là chỗ bị bỏ sót. */
export function buildSceneRealismLead(sel: QuickSelection, keepFace = true, sceneRef = false): string {
  if (sceneRef) {
    return 'Image 1 is a REAL photograph of a place. Keep that place exactly as it is: the same background, the same ' +
      'objects, the same light, the same colours, the same camera angle and the same composition. Take the young ' +
      'woman from image 2 — her face, hair and skin tone unchanged — and place her naturally inside that scene, ' +
      'as if she had really been standing there when the photo was taken. Her lighting, shadows, scale and ' +
      'perspective must match the original photograph exactly, so she looks photographed, not pasted in.'
  }
  if (!keepFace) return 'An ordinary everyday iPhone 13 Pro snapshot of a young woman, posted straight to Facebook.'
  // Quay lưng → thay lead bằng bản không tả mặt, nếu không 8 câu tả mặt còn lại sẽ lấn át
  // một câu "seen from behind" duy nhất (đã xảy ra thật).
  const g = (k: string) => (sel[k] || '').trim()
  const selfie = isArmSelfie(g('shot'))
  const back = !selfie && isBackView(g('head'))
  const far = isWideShot(g('shot'))
  const lead = back
    ? LEAD_BACK
    : far
      ? LEAD_FAR
      : 'Keep the same young woman shown in attached image 1 — same face, hair and skin tone, consistent and ' +
        'recognizable; only the scene, pose and outfit change. It is an ordinary everyday iPhone 13 Pro snapshot ' +
        'of her, posted straight to Facebook.'
  // FAR_SCALE chèn NGAY SAU lead (chỗ nặng ký nhất) chứ không nhét cuối, để tỉ lệ người
  // không còn là một câu lẻ giữa rừng chữ tả cảnh.
  return [lead, ...(far ? [FAR_SCALE] : [])].join('\n\n')
}

export function buildQuickScenePrompt(sel: QuickSelection, keepFace = true, sceneRef = false, provider?: ImageProvider): string {
  const g = (k: string) => (sel[k] || '').trim()
  const lead = buildSceneRealismLead(sel, keepFace, sceneRef)
  if (sceneRef) {
    // Ở chế độ ghép, ảnh 1 là CẢNH và ảnh 2 mới là nhân vật — nên lựa chọn "Giữ trang
    // phục như ảnh gốc" (vốn viết là "image 1") phải trỏ lại sang ảnh 2, không thì model
    // đi lấy quần áo của… người lạ trong ảnh cảnh.
    const outfit = g('outfit').replace('image 1', 'image 2')
    const scene = `She is ${g('pose')}, wearing ${outfit}, ${g('head')}.`
    return [lead, scene, buildSceneRealismTail(sel, true, provider)].join('\n\n')
  }
  const selfie = isArmSelfie(g('shot'))
  const back = !selfie && isBackView(g('head'))
  const shot = back ? (BACK_SHOT[g('shot')] ?? g('shot')) : g('shot')
  // Máy nằm trong tay chủ thể, giơ quá đầu → ô "Góc máy" mất nghĩa (không thể vừa tự
  // cầm vừa "sát đất nhìn lên"). Ghi đè, cùng cách BACK_SHOT ghi đè cỡ cảnh khi quay lưng.
  const angle = selfie ? ARM_SELFIE_ANGLE : g('angle')
  // The region phrase hangs off the location ("in a cozy cafe in the Old Quarter of
  // Hanoi, Vietnam, among narrow tube houses…"), so the background is furnished with
  // real local detail rather than a generic stock backdrop.
  // Ánh mắt chỉ có nghĩa khi thấy mặt — quay lưng thì bỏ.
  const gaze = back ? '' : g('gaze')
  const scene =
    `She is ${g('pose')} ${g('location')} ${g('region')}, wearing ${g('outfit')}, ${g('head')}` +
    `${gaze ? `, ${gaze}` : ''}. The light is ${g('lighting')}, with ${g('tone')}. Framing: ${shot}, ` +
    `${angle}, ${g('style')}. Everything in the background — the buildings, the street, the objects and ` +
    'the other people — belongs to that place and nowhere else.'
  // cameraBlock(sel) thay cho cặp CAM + DEEP_FOCUS cứng: nó tự mang cả thân máy lẫn độ
  // sâu trường ảnh, và dùng "the subject" nên hợp cả góc quay lưng (khỏi biến thể riêng).
  return [lead, scene, buildSceneRealismTail(sel, false, provider)].join('\n\n')
}

/** A compact one-line description of the character picks, stored as a saved
 *  character's `face_prompt` (the block fields stay empty for a quick-flow save). */
export function buildQuickCharacterDescription(sel: QuickSelection): string {
  const g = (k: string) => (sel[k] || '').trim()
  // Phải khớp với prompt đã sinh ra ảnh: nếu có mức nhan sắc thì các ô nét mặt KHÔNG
  // được gửi cho model, nên ghi chúng vào mô tả nhân vật là ghi sai người.
  const looks = faceSentence(sel, g('beauty')) || BEAUTY_PHRASES[g('beauty')]
  const skin = beautySkin(g('beauty')) || g('skin')
  if (looks) {
    return (
      `${g('nation')} woman ${agePhrase(g('age'))}; ${skin}; ` +
      `${g('hair_style')} ${g('hair_color')} hair. ${looks}`
    )
  }
  return (
    `${g('nation')} woman ${agePhrase(g('age'))}; ${g('face')}; ${skin}; ` +
    `${g('hair_style')} ${g('hair_color')} hair; ${g('eyes')}; ${g('nose')}; ${g('lips')}; ${g('expression')}.`
    + faceExtra(sel, g('beauty'))
  )
}

// ── Flow "khoá đồ + nền" (consistency) ──────────────────────────────────────
// Sinh RIÊNG 1 ảnh bộ đồ (flat-lay) + 1 ảnh bối cảnh (không người) làm 2 ảnh tham chiếu,
// rồi ghép [nền, đồ, mặt] trong MỘT lần images.edit → mọi ảnh cùng bộ đồ, cùng chỗ, chỉ
// khác dáng. POC 2026-08-05 xác nhận gpt-image-2 giữ đồ + nền ở high-fidelity.

/** Ảnh CHỈ có bộ đồ (flat-lay, không người) — làm ảnh tham chiếu trang phục. */
export function buildOutfitPrompt(sel: QuickSelection): string {
  const raw = (sel.outfit || '').trim()
  const garment = (!raw || /image 1/i.test(raw)) ? 'a simple stylish everyday outfit' : raw
  return [
    `A single women's outfit — ${garment} — laid out flat and neatly arranged on a plain light-grey surface, ` +
    'shot straight from above like a clean product-catalogue photo. The complete outfit is fully visible. There ' +
    'is NO person, NO body and NO mannequin in the picture — only the clothing itself.',
    NO_TEXT,
  ].join('\n\n')
}

/** Ảnh bối cảnh TRỐNG (không người) — làm ảnh tham chiếu không gian (dùng như sceneRef). */
export function buildBackgroundPrompt(sel: QuickSelection): string {
  const location = (sel.location || 'in a cozy everyday place').trim()
  const region = (sel.region || '').trim()
  const light = (sel.lighting || 'natural daylight').trim()
  return [
    `An everyday iPhone photo of the kind of place where someone would be ${location}${region ? ` ${region}` : ''}, ` +
    'but the place is completely EMPTY, with NO people anywhere in the frame. The whole setting is clearly ' +
    `visible so a person can be placed into it later. The light is ${light}.`,
    IMPERFECT, PHONE_GRADE, NO_TEXT,
  ].join('\n\n')
}

// Đây là EDIT giữ mặt từ ảnh tham chiếu → KHÔNG dùng skinBlock ("Thô rõ": mụn/đốm/loang/đỏ):
// GPT sẽ VẼ mấy thứ đó thành VỆT BẨN lên khuôn mặt (nhất là cảnh rộng, mặt nhỏ). Chỉ giữ da
// sạch như ảnh gốc, không bôi thêm, cũng không làm nhựa. Dùng chung cho buildOutfitScenePrompt
// và buildRealPhotoScenePrompt — cùng bản chất (edit giữ mặt từ ảnh tham chiếu).
const FACE_REF_SKIN_LOCK =
  'Keep her skin exactly as it looks in the reference face photo: natural and matte with its own real texture. ' +
  'Do NOT smooth it into plastic, and do NOT paint on any new spots, blotches, redness, marks, streaks or extra ' +
  'texture — her face must stay clean and unchanged.'

/** Prompt GHÉP: 3 ảnh ref theo thứ tự [ảnh1 = nền, ảnh2 = đồ, ảnh3 = mặt]. Giữ y nguyên
 *  nền + bộ đồ, chỉ đổi dáng. Thứ tự ref phải KHỚP câu "image 1/2/3" ở đây. */
export function buildOutfitScenePrompt(sel: QuickSelection): string {
  const pose = (sel.pose || 'in a relaxed natural pose').trim()
  const head = (sel.head || '').trim()
  const lead =
    'Three reference images are attached. Image 1 is a real photo of a PLACE — keep it exactly as the background: ' +
    'the same room, the same objects, the same light and the same composition. Image 2 is an OUTFIT — dress the ' +
    'woman in EXACTLY that outfit, the same garments and the same colours. Image 3 is the WOMAN’S FACE — keep her ' +
    'face, hair and skin tone unchanged and recognizable. Put this same woman, wearing that exact outfit, ' +
    'naturally inside that exact place, as if she had really been photographed there. The outfit and the ' +
    'background must stay identical to the reference images — do not restyle the clothes or redraw the room.'
  const scene =
    `She is ${pose}${head ? `, ${head}` : ''}. Her lighting, shadows, scale and perspective match the scene so ` +
    'she looks photographed, not pasted in.'
  return [lead, scene, FACE_REF_SKIN_LOCK].join('\n\n')
}

// ── Flow "Ảnh cảnh có sẵn" là ẢNH THẬT (đã có người tạo dáng sẵn) ───────────────────────────
// Khác buildOutfitScenePrompt ở trên (nền AI trống người, còn phải TỰ chọn dáng qua field
// Tư thế): ở đây ảnh nền ĐÃ có sẵn người + dáng + góc máy + ánh sáng — không còn gì để chọn,
// chỉ cần đổi khuôn mặt (và trang phục, nếu đã sinh riêng 1 ảnh đồ). Mirror buildRealRefPrompt
// bên luồng cũ (FaceSwapWizardLegacy.tsx: "Image 1 is a real photo — keep its EXACT pose,
// body position, camera angle, framing, background... Image 2 is the character — replace the
// face and identity"), viết lại cho đúng thứ tự ref của luồng mới.

/** Câu neo — tách khỏi buildRealPhotoScenePrompt để PromptBox khoá được vào prompt tự gõ tay,
 *  giống hệt buildSceneRealismLead. `hasOutfitRef`: đã sinh ảnh đồ riêng (3 ref: [ảnh thật, đồ,
 *  mặt]) hay chưa (2 ref: [ảnh thật, mặt] — giữ nguyên trang phục có sẵn trong ảnh gốc). */
export function buildRealPhotoSceneLead(hasOutfitRef: boolean): string {
  const outfit = hasOutfitRef
    ? 'Image 2 is an OUTFIT — dress her in EXACTLY that outfit, the same garments and the same colours, replacing ' +
      'whatever she is currently wearing.'
    : 'Keep her wearing exactly the same outfit as the person in image 1 — same garments, same colours.'
  const faceImg = hasOutfitRef ? 'image 3' : 'image 2'
  return (
    'Image 1 is a REAL photograph of a woman. Keep EVERYTHING about this photo exactly as it is — her exact pose, ' +
    'body position, hand and limb placement, the camera angle, the framing, the lighting, the background and the ' +
    `overall composition. Replace ONLY her identity: give her the face, hair and skin tone of the woman in ${faceImg} ` +
    `(keep that face fully recognizable and unchanged). ${outfit} Nothing else about the photo changes — same ` +
    'place, same moment, same everything, just a different woman in it.'
  )
}

/** Khối nối cuối — không phụ thuộc hasOutfitRef nên tách riêng, PromptBox nối vào prompt tự
 *  gõ tay giống hệt buildSceneRealismTail. */
export function buildRealPhotoSceneTail(): string {
  return [FACE_REF_SKIN_LOCK, NO_TEXT].join('\n\n')
}

export function buildRealPhotoScenePrompt(hasOutfitRef: boolean): string {
  return [buildRealPhotoSceneLead(hasOutfitRef), buildRealPhotoSceneTail()].join('\n\n')
}

// ── Ảnh BIẾN THỂ của chế độ "ảnh thật" ───────────────────────────────────────
// Bài toán: người dùng tải 1 ẢNH THẬT + 1 ảnh chân dung, sinh thêm bộ đồ, rồi bấm sinh
// 3 ảnh. Trước đây cả 3 ảnh dùng CHUNG một prompt bám nguyên ảnh gốc (giữ y dáng, góc
// mặt, góc máy) nên ra 3 bản gần như y hệt — trả tiền 3 lần cho đúng 1 tấm ảnh. Giờ ảnh
// ĐẦU vẫn bám nguyên gốc, các ảnh SAU dùng prompt dưới đây: cùng người, cùng bộ đồ,
// cùng nơi chốn, nhưng khác TƯ THẾ / GÓC MẶT / BIỂU CẢM / ÁNH MẮT.
//
// CỐ Ý KHÔNG đổi góc máy và cỡ cảnh (dù hai ô đó có sẵn): đổi chúng thì model buộc phải
// vẽ lại nơi đó từ một chỗ đứng khác, nền hết giống ảnh gốc — mà nền giống mới là lý do
// người dùng tải ảnh thật lên. Muốn đổi cả góc máy thì thêm 'angle'/'shot' vào đây, đổi
// đúng một chỗ này.
//
// Ba kiểu góc mặt bị loại: hai kiểu quay lưng che mất mặt (mất luôn ý nghĩa của việc
// ghép mặt), còn "Qua vai (OTS)" đòi phải có vai người khác trong khung — trái với câu
// "chỉ có ĐÚNG MỘT người trong ảnh" ở lead bên dưới.
const VARIANT_HEAD_SKIP = ['Sau lưng', 'Sau lưng 45°', 'Qua vai (OTS)']
// Cùng lý do, bỏ tư thế "Chụp gương": selfie trước gương nghĩa là máy nằm trong tay cô
// ấy chĩa vào gương — khung ảnh và chỗ đứng của máy đổi hẳn, đúng thứ chế độ này phải
// giữ nguyên. (Bốc thử 4000 lần thấy nó ra thật, nên chặn ở đây chứ không phó cho may rủi.)
const VARIANT_POSE_SKIP = ['Chụp gương']

/** Bốc ngẫu nhiên giá trị (bản tiếng Anh) của một ô, bỏ qua các nhãn trong `skipVi`. */
function randVariantOpt(fields: QuickField[], key: string, skipVi: string[] = []): string {
  const f = fields.find((x) => x.key === key)
  if (!f) return ''
  const opts = f.opts.filter(([vi]) => !skipVi.includes(vi))
  return opts.length ? opts[Math.floor(Math.random() * opts.length)][1] : ''
}

/** Prompt cho một ảnh BIẾN THỂ ở chế độ ảnh thật (xem khối ghi chú phía trên).
 *
 *  TỰ random bên trong nên mỗi lần gọi ra một prompt khác — CHỈ được gọi lúc bấm sinh
 *  (trong event handler, xem genScene), KHÔNG gọi trong lúc render, nếu không sẽ vi phạm
 *  react-hooks/purity và mỗi lần render lại ra một prompt khác. Prompt đã dùng được lưu
 *  vào từng Shot nên "Sửa prompt" / "Tạo lại" từng ảnh vẫn đúng bản đã sinh. */
export function buildRealPhotoVariantPrompt(hasOutfitRef: boolean): string {
  const faceImg = hasOutfitRef ? 'image 3' : 'image 2'
  const outfit = hasOutfitRef
    ? 'Image 2 is an OUTFIT — dress her in EXACTLY that outfit, the same garments and the same colours.'
    : 'Dress her in the same outfit the woman in image 1 is wearing — same garments, same colours.'
  const pose = randVariantOpt(QUICK_SCENE_FIELDS, 'pose', VARIANT_POSE_SKIP) || 'standing naturally'
  const head = randVariantOpt(QUICK_SCENE_FIELDS, 'head', VARIANT_HEAD_SKIP)
  const expression = randVariantOpt(QUICK_CHARACTER_FIELDS, 'expression')
  const gaze = randVariantOpt(QUICK_SCENE_FIELDS, 'gaze')
  const lead =
    'Image 1 is a REAL photograph. Keep the PLACE in it exactly as it is: the same background, the same objects, ' +
    'the same light and the same colours, and the same camera angle and framing — as if this second photo were ' +
    'taken from the same spot moments later. ' +
    `Her face, hair and skin tone come from ${faceImg} and must stay unchanged and recognizable. ${outfit} ` +
    'The woman already in image 1 must NOT appear anywhere in the result: there is exactly ONE woman in the ' +
    `picture, the one from ${faceImg}, standing in that same place. Her lighting, shadows, scale and perspective ` +
    'match the place so she looks photographed there, not pasted in.'
  // Câu cuối là câu QUYẾT ĐỊNH: cả lead ở trên toàn nói "giữ y nguyên", không nói rõ
  // đây là một khoảnh khắc khác thì model cứ bám luôn dáng của người trong ảnh gốc và
  // ảnh biến thể lại ra y hệt ảnh gốc.
  const scene =
    `She is ${pose}${head ? `, ${head}` : ''}${expression ? `, with ${expression}` : ''}` +
    `${gaze ? `, ${gaze}` : ''}. This is a DIFFERENT moment from image 1: her pose, the turn of her head and her ` +
    'expression are her own and must NOT be copied from the woman in image 1.'
  return [lead, scene, buildRealPhotoSceneTail()].join('\n\n')
}
