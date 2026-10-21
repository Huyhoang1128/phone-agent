/**
 * Self-contained face-swap wizard — all state, handlers, and UI in one place.
 * Renders as a fixed overlay; parent controls visibility by mounting/unmounting.
 *
 * Props:
 *   onClose  — called when user clicks "Đóng" or the × button
 *   onSaved  — called after a character is successfully saved to the server,
 *              so the parent can refresh its character list
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Bookmark,
  Check,
  Download,
  Loader2,
  Palette,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Shuffle,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/context/ToastContext'
import { charactersApi, contentsApi } from '@/lib/api'
import { prestoreImage, storedRef, waitForPrestore } from '@/lib/imageStore'
import type { Character, ImageProvider, OpenAIImageSize } from '@/lib/types'
import { InpaintCanvas } from './InpaintCanvas'
import { FilterPicker } from './FilterPicker'
import FaceSwapPanel from './FaceSwapPanel'
import { SHOT_FIELD, ANGLE_FIELD, HEAD_FIELD, IMPERFECT, isBackView, NO_TEXT } from '@/lib/quickPrompt'

// ── Constants (mirror BE caps in content/views.py) ────────────────────────────
const MAX_FACE_SWAP_IMAGE_BYTES = 15 * 1024 * 1024
const MAX_FACE_SWAP_DAILY_PROMPTS = 12  // up to 4 scene groups of 3 (2 person + 1 scenery)
// Ảnh CÒN PHẢI GỬI BASE64 đi một ảnh mỗi request. Trước đây là 3, và đó là lý do
// thanh tiến độ nhìn như treo: lưu đúng 3 ảnh = 1 lô = "0/3" đứng im từ đầu đến
// cuối, trong khi mỗi ảnh là ~2,25 MB bò lên mạng. Một ảnh một request thì tiến
// độ nhảy 1/3 → 2/3 → 3/3 đúng thực tế, mà vẫn giữ nguyên cái lợi ban đầu của
// việc chia lô: một POST khổng lồ 10–30MB dễ chạm giới hạn body/timeout của
// reverse-proxy (413/504) và làm mất trắng cả lượt lưu.
const SAVE_CHUNK_SIZE = 1
// Ảnh đã được cất vào kho (xem lib/imageStore.ts) chỉ gửi URL — payload vài trăm
// byte — nên gộp lô lớn cho đỡ số request.
const SAVE_URL_CHUNK_SIZE = 8
// Save chunks run concurrently (bounded) instead of one-at-a-time. Safe against
// lost updates because the backend add-media locks the row (select_for_update);
// most images now save by pre-uploaded URL so each request is a fast DB append.
const SAVE_CONCURRENCY = 4
const PEXELS_KEY = (import.meta as { env?: Record<string, string> }).env?.VITE_PEXELS_API_KEY || ''

const FACE_SWAP_PERSON =
  'An ordinary young Vietnamese woman in her mid-twenties, natural everyday appearance, plain and relatable — a normal person, not a model or a glamour shot.'
// Fixed phone-photo style lock — the single biggest "this is AI" giveaway on these
// character shots is WAXY, poreless, beautified skin (gpt-image-2 smooths and
// prettifies by default, and quality=low strips fine texture on top). The old block
// only said "natural real skin with normal visible texture" and then piled on
// NEGATIVES — "not glossy, not heavily edited, not an obvious over-processed AI
// render". These models have no negative_prompt, so naming "glossy / AI render" tends
// to summon exactly that; the quickPrompt flow already learned this (see NO_TEXT /
// skinBlock: describe what the surface IS, never what it is not). So we now:
//   A. describe the skin in strong POSITIVE physical terms — pores, peach-fuzz,
//      uneven tone, a stray blemish, matte light-absorbing surface (mirrors the
//      SKIN_TEX blocks in quickPrompt.ts);
//   B. add real phone-camera grain — straight-out-of-camera HDR + mild sensor noise
//      in the shadows (mirrors CAM in quickPrompt.ts), so the image is not too clean;
//   C. add slight facial asymmetry to fight the model's "average pretty face" pull
//      (mirrors ASYMMETRY in quickPrompt.ts).
// The "bright, well-lit, lively true-to-life colours" anchor stays — it is what keeps
// quality=low from dragging the result back to the dated washed-out early-2000s look,
// so do NOT remove it when touching this block.
const FACE_SWAP_CAMERA =
  'A simple everyday photo taken casually on a recent modern smartphone (2020s), straight out of the camera app with the phone’s own HDR already applied — plain and unstaged like a real snapshot a normal person would post today, with ordinary phone-camera colour and a little fine sensor grain in the shadows. It stays clear, bright and well-lit, with natural, lively, true-to-life colours. Her skin is real and matte: fine pores show across the nose and cheeks, soft peach-fuzz runs along the jaw, the skin tone is slightly uneven with a tiny mole or blemish here and there, and the surface absorbs the light instead of shining back. Her face is naturally a little asymmetric — one eye a touch more open than the other, the smile slightly uneven. A relaxed, candid, ordinary moment.'
// Khối máy quay + khối "không có gì thẳng hàng" (IMPERFECT, dùng chung với luồng Tạo ảnh
// nhanh). Ảnh AI hay xếp bàn ghế song song, cách đều, chân trời ngang tuyệt đối, người
// đứng ngay ngắn không ai bị cắt — đó là dấu hiệu AI to thứ hai sau da bóng.
//
// CHỦ Ý: khối này KHÔNG gắn vào buildRealRefPrompt. Ở đó bố cục được lấy nguyên từ một
// TẤM ẢNH THẬT người dùng tải lên, nên bảo model "làm cho mọi thứ lệch đi" là bảo nó bóp
// méo lại chính tấm ảnh gốc — thừa và có hại. Chỗ đó bố cục vốn đã thật sẵn.
const FACE_SWAP_CAMERA_REAL = `${FACE_SWAP_CAMERA}\n\n${IMPERFECT}`
// Front-facing lock for the CHARACTER reference image only — the swap source
// needs a clean, centered, front-facing face for Deep-Live-Cam to read.
const FACE_SWAP_FRONT =
  'Front-facing, looking straight at the camera, face fully visible and centered, clear recognizable portrait.'
// Per-scene pose & gaze variety. The model keeps the face from the reference
// image (no separate face-swap step), so we are free to turn the head, look
// away, or catch her mid-action — that is what makes a shot read as a real
// candid photo instead of a posed "staring into the lens" portrait. Every entry
// keeps the face clearly visible so identity stays readable (no back-of-head /
// face hidden). Candid entries carry their own "unposed / unaware of the
// camera" cue inline (so it never contradicts the selfie entries).
//
// Bản trước 9/12 câu đều chỉ nói chung chung "quay đi một bên / nhìn ra chỗ khác" mà KHÔNG
// nêu hướng (trái/phải) hay mức độ quay — chữ khác nhau nhưng hình ra gần như một khuôn: mặt
// nghiêng 3/4, mắt né ống kính. Random chọn câu nào cũng ra một kiểu ảnh, nên khách thấy "vẫn
// cùng một góc mặt" dù đã đổi nhiều prompt khác nhau (đã tái hiện được bằng test thật — ảnh
// sinh ra từ 1 câu tự gõ tay riêng vẫn ra đúng kiểu "nghiêng 3/4, né máy" này). Viết lại: mỗi
// câu nêu RÕ hướng quay (HER LEFT / HER RIGHT) và mức độ khác nhau thật (liếc nhẹ / quay 3/4 /
// quay gần hết sang profile / cúi hẳn xuống / ngước lên) để random pick RA HÌNH khác nhau
// thật, không chỉ khác chữ. Tỉ lệ candid:nhìn-camera cũng hạ từ 75/25 xuống ~60/40.
const FACE_SWAP_HEAD_ANGLES = [
  // ── Candid: not looking at the camera — mỗi câu 1 HƯỚNG + MỨC ĐỘ quay khác hẳn nhau ──
  'She is absorbed in what she is doing, looking straight down at her hands, chin tilted down, caught mid-action, unaware of the camera, face still clearly visible.',
  'Her head is turned to HER LEFT in a clear three-quarter view, gazing at something out of frame on that side, unposed, face still clearly visible.',
  'Her head is turned to HER RIGHT in a clear three-quarter view, gazing at something out of frame on that side, unposed, face still clearly visible.',
  'She is shown in near full profile, head turned almost all the way to one side, gazing far off that way, candid and unaware of the camera, face still clearly visible.',
  'She glances upward and slightly to one side, chin lifted, as if looking at something above her, candid and unaware of the camera, face still clearly visible.',
  'She is glancing back over her shoulder, head and body caught mid-turn, relaxed and natural, not posing, face still clearly visible.',
  // NOTE: gaze/head cues only — no locomotion or stance verbs here. A body-action
  // cue ("mid-stride walking") baked into a head angle overrode "sitting" scenes
  // and made them come out standing/walking. Keep stance to the scene text.
  'She is laughing, head turned toward someone just out of frame beside her, candid moment, face still clearly visible.',
  'Her eyes are softly closed for a moment, head tilted gently to one side, enjoying the surroundings, candid and relaxed, face still clearly visible.',
  'She is looking down at her phone held low, shoulders relaxed, unaware of the camera, candid, face still clearly visible.',
  // ── Natural looking-at-camera ──
  'A casual self-taken selfie, one arm slightly raised holding the phone, a relaxed natural look at the camera, face fully visible.',
  'A quick natural glance at the camera with a relaxed half-smile, as if a friend just called her name, not stiffly posed, face fully visible.',
  'A relaxed direct look at the camera, casual and natural, not a stiff studio pose, face fully visible.',
  'She looks directly at the camera with her head tilted slightly to one side, warm and friendly, face fully visible.',
  'A confident direct gaze at the camera, chin slightly lowered, calm expression, face fully visible.',
  'She glances at the camera from slightly below, as if the phone is held a bit lower than her face, natural angle, face fully visible.',
]
// Random pick reused at every "person" row-creation site (khởi tạo, «Thêm ảnh», đổi kind
// sang 'person') — trước đây CHỈ nhóm sinh theo chủ đề preset (xem group ở
// handleGenerateScenes phía dưới) roll góc mặt; các dòng tự gõ tay/"Thêm ảnh" thủ công thì
// không, nên buildScenePrompt() không có chỉ dẫn góc mặt cho những dòng đó → model mặc định
// giữ nguyên góc mặt gần giống ảnh chân dung tham chiếu ở MỌI ảnh cảnh, ra "toàn cùng một
// góc mặt" (đúng thứ khách hàng đang chê).
function randomHeadAngle(): string {
  return FACE_SWAP_HEAD_ANGLES[Math.floor(Math.random() * FACE_SWAP_HEAD_ANGLES.length)]
}
// Per-scene expression variety — a broad emotional range, not just smiles, so
// the character does not look identical in every shot.
const FACE_SWAP_EXPRESSIONS = [
  'a soft natural smile',
  'a big cheerful smile showing teeth',
  'a happy mid-laugh, laughing naturally',
  'a calm, serious expression with lips closed',
  'a neutral relaxed face, not smiling',
  'a slightly sad, wistful look',
  'a slight, gentle cute pout (nũng nịu)',
  'a sweet, cute and gentle expression',
  'a playful grin',
  'a thoughtful, slightly dreamy look',
  'a shy, gentle half-smile',
  'a warm friendly smile',
  'teary-eyed, eyes glistening as if about to cry (mít ướt)',
  'an excited, delighted look',
  'a confident, self-assured expression',
]
// Per-scene framing / shot-distance variety so scenes are not all tight
// face close-ups. SHOT-DISTANCE ONLY — no stance/action verbs ("standing",
// "walking", "a few steps back"): those used to override the scene's own pose
// and turn "sitting eating" into "standing holding food". Pose belongs to the
// scene text; framing only says how much of the body is in frame. Every option
// keeps the face clearly visible so the face-swap source stays readable.
const FACE_SWAP_FRAMINGS = [
  'Full-body framing: her whole body is in frame from head all the way down to her feet and shoes, the full setting around her visible, face still clearly visible.',
  'Full-length framing capturing her entire figure and complete outfit head to toe including footwear, plenty of the surroundings in frame, face still clearly visible.',
  'Wide framing from some distance, her full figure smaller within a large environment, lots of background visible, face still clearly visible.',
  'Three-quarter framing from roughly the knees up, background around her visible, face clearly visible.',
  'Half-body framing from the waist up, some of the surroundings visible, face clearly visible.',
  'Medium framing from the waist up with the background around her clearly visible, face clearly visible.',
  'Upper-body framing from the chest up, face clearly visible.',
]
// The subset that shows the whole body incl. feet/shoes — forced when the scene
// explicitly asks for a full-length / head-to-toe / shoes shot so a random
// waist-up crop can never cut the request down to "half a person".
const FACE_SWAP_FULL_BODY_FRAMINGS = FACE_SWAP_FRAMINGS.slice(0, 3)
// The scene text already carries its own shot distance (preset variants and the
// LLM scene writer both describe framing). Appending a SECOND random framing on
// top is what created the contradictions — so when the scene already states a
// framing, we trust it instead of overriding. Matches VI + EN cues.
// NOTE: these cue regexes must be tested against the ORIGINAL Vietnamese row text,
// never the English pre-translation — otherwise every VI alternative below is dead
// and a hand-typed scene silently falls through to the random branch.
const SCENE_HAS_OWN_FRAMING =
  /full.?body|full.?length|head.?to.?toe|whole (figure|body)|close.?up|waist.?up|knee.?up|chest.?up|three.?quarter|portrait|selfie|\bshot\b|\bframed\b|eye.?level|side.?angle|to[àa]n th[âa]n|c[ậa]n c[ảa]nh|c[ậa]n m[ặa]t|khung h[ìi]nh|ch[ụu]p (xa|g[ầa]n)|n[ửu]a ng[ưu][ờo]i|b[áa]n th[âa]n|ch[âa]n dung|g[óo]c ch[ụu]p|g[óo]c m[áa]y|g[óo]c (th[ấa]p|cao|r[ộo]ng)|t[ừu] (d[ưu][ớo]i l[êe]n|tr[êe]n xu[ốo]ng)|c[ảa] ng[ưu][ờo]i|to[àa]n c[ảa]nh/i
// The scene demands the whole body be visible (feet/shoes/outfit) — force a
// full-body framing regardless of the random pick. Matches VI + EN cues.
const SCENE_WANTS_FULL_BODY =
  /full.?body|full.?length|head.?to.?toe|whole (figure|body)|shoes?|sneakers?|trainers?|boots?|heels?|socks?|footwear|gi[àa]y|d[ée]p|t[ấa]t cao c[ổo]|từ đầu đến ch[âa]n|to[àa]n th[âa]n|full ng[ưu][ờo]i|c[ảa] ng[ưu][ờo]i|d[áa]ng đứng/i
// The scene already states where she is looking / how her head is turned. Appending
// a random head-angle on top overrides it — and one of the options is a selfie,
// which turns a whole scene into an avatar shot. Matches VI + EN cues.
// The scene already states the mood. Stripping it and injecting a random one
// overrides what the user asked for — so only do that for PRESET rows, where the
// jitter is what keeps two shots of the same scene from looking identical.
const SCENE_HAS_OWN_EXPRESSION =
  /bi[ểe]u c[ảa]m|n[ée]t m[ặa]t|v[ẻe] m[ặa]t|expressions?\b|smil|c[ưu][ờo]i|mood/i
const SCENE_HAS_OWN_GAZE =
  /[áa]nh m[ắa]t|nh[ìi]n (sang|v[ềe]|th[ẳa]ng|xu[ốo]ng|l[êe]n|ra|v[àa]o|quanh)|ng[ưu][ớo]c nh[ìi]n|quay đ[ầa]u|c[úu]i đ[ầa]u|nghi[êe]ng đ[ầa]u|ng[óo]nh|looking|\bgaze|glanc|eyes (closed|on)|over her shoulder/i
// "No people" cues to STRIP from a PERSON row's scene text. A person shot must
// contain the character, but scene text carried over from a scenery row (or the
// scenery placeholder) can say "không có người" and suppress her → a "Người" shot
// comes out as an empty scene. Removing the clause lets the toggle win over the text.
const NO_PEOPLE_CUE =
  /,?\s*[^,.]*(kh[ôo]ng c[óo] ng[ưu][ờo]i|kh[ôo]ng ng[ưu][ờo]i|v[ắa]ng ng[ưu][ờo]i|v[ắa]ng b[óo]ng ng[ưu][ờo]i|kh[ôo]ng m[ộo]t ai|no people|no person|without (?:any )?people|empty scene|no one)[^,.]*/gi
/** Per-row scene state. `topic` is non-null only for preset / AI-written rows —
 *  that is what tells a generated scene apart from one the user typed by hand,
 *  and hand-typed text is taken literally instead of being jittered. */
type SceneMeta = {
  topic: string | null
  regen: number
  kind: 'person' | 'scenery' | 'realref'
  headAngle?: string
  refImage?: string
  /** Realref only: keep image 1's outfit instead of asking for a different one. */
  keepOutfit?: boolean
}

// Person-free style for the scenery-only shot in each scene group (beach → an
// actual beach photo, cafe → a cafe-corner photo). No face is generated, so it
// is saved straight to the gallery. Mirrors the bright modern phone look but
// forbids any person in the frame.
// Bản trước kết thúc bằng "not glossy, not over-sharpened, not over-saturated, not heavily
// edited" — đúng cụm chữ mà ghi chú ở FACE_SWAP_CAMERA phía trên đã kết luận là thủ phạm
// kéo ảnh về cái nhìn bạc phếch đầu 2000. Các model KHÔNG có negative_prompt: nhắc tên
// "over-saturated" chỉ triệu hồi cái ngược lại của nó là ảnh xỉn màu. Thay bằng câu tả
// KHẲNG ĐỊNH cảnh trông thế nào, đồng bộ với PHONE_GRADE của luồng Tạo ảnh nhanh.
const FACE_SWAP_SCENERY_STYLE =
  'A simple everyday photo of the place itself, taken casually on a normal phone in natural light, plain and realistic like a real snapshot someone would post today. It is bright and clearly lit: the shadows are open rather than muddy, the whites are clean, and the colours of the place are lively and true to life. Still candid and ordinary, not a polished studio shot. No people, no person anywhere in the frame, empty scene, no text, no watermark.'

// "Tạo Media" presets — ảnh phụ không có người (cảnh vật, đồ vật, món ăn, thú
// cưng…) cho trang cá nhân trông có thật. Nhãn tiếng Việt + prompt tiếng Anh.
//
// ĐÃ ĐO 20/08, 12 ảnh, 2 chủ đề × 3 cách viết (ảnh trong docs/test-anh-media/):
//   A = bản cũ, 807 ký tự, đầy chữ "photorealistic, ultra detailed, bokeh, cozy
//       moody atmosphere" → ra ảnh bưu thiếp/quảng cáo, nhìn phát biết AI. Đó
//       CHÍNH LÀ từ vựng gắn nhãn cho ảnh stock nên model vẽ đúng ra ảnh stock.
//   B = 304 ký tự, chỉ tả cảnh + GỌI TÊN VÀI THỨ RÁC ĐỜI THƯỜNG → thắng rõ ở cả
//       hai chủ đề (kính bẩn, khăn giấy vò, thùng rác, ống nước, ghế xô lệch).
//   C = 59 ký tự, chỉ mỗi tên chủ đề → ảnh mưa tối om và trống trơn, ảnh cafe thì
//       hiện chữ "CAFÉ" trên biển vì mất câu cấm chữ. Ngắn quá cũng hỏng.
// Các prompt dưới đây viết theo lối B: NGẮN, bỏ hết chữ sáo rỗng, nhưng luôn có
// 1–2 thứ lộn xộn đời thường — model chỉ vẽ cái mình gọi tên, chỉ tả cái đẹp thì
// nó vẽ ra tranh.
const MEDIA_PRESETS: { label: string; prompt: string }[] = [
  { label: 'Đồng cỏ', prompt: 'A field of long grass on an ordinary afternoon, the grass flattened in patches, a dirt path worn through it, a leaning fence post at the edge.' },
  { label: 'Biển vắng', prompt: 'A quiet beach in the afternoon, footprints and dog tracks in the wet sand, dried seaweed and a plastic bottle cap near the waterline.' },
  { label: 'Núi sương mù', prompt: 'Hills in the morning fog seen from a roadside pull-off, wet tarmac in the foreground and a scratched metal barrier along the edge.' },
  { label: 'Rừng thông', prompt: 'Inside a pine forest in the morning, dry needles and broken branches on the ground, a path worn by feet, thin light through the trees.' },
  { label: 'Thác nước', prompt: 'A waterfall in a forest, wet rocks in the foreground, a muddy path worn along the bank and a rusted handrail at the edge.' },
  { label: 'Cánh đồng hoa', prompt: 'A field of flowers at the end of the day, the rows uneven, some flowers already brown, a tractor track cutting through them.' },
  { label: 'Hoàng hôn', prompt: 'The sky just after sunset seen from a balcony, roof tiles and a few electric wires cutting across the bottom of the frame.' },
  { label: 'Trời sao', prompt: 'A night sky full of stars from a dark field, the horizon barely visible, visible noise in the dark parts of the picture.' },
  { label: 'Cửa sổ mưa', prompt: 'Rain on a cafe window at night, the glass smeared, a half-drunk cup and a crumpled napkin left on the table.' },
  { label: 'Mèo cưng', prompt: 'An orange cat asleep on a rumpled blanket on the sofa, some shed fur on it, an ordinary untidy living room behind.' },
  { label: 'Chú cún', prompt: 'A golden retriever sitting on the grass in a park, its fur a bit dirty, a chewed tennis ball and a dropped leash beside it.' },
  { label: 'Chú chim', prompt: 'A small bird on a branch in a garden, seen from a few metres away, leaves partly blocking the view.' },
  { label: 'Cà phê', prompt: 'A cup of coffee on a wooden cafe table, a spoon on a stained saucer, a wet ring on the wood and a crumpled sugar wrapper.' },
  { label: 'Bữa sáng', prompt: 'Breakfast on a kitchen table, a plate half eaten, crumbs on the table, the milk carton left open beside it.' },
  { label: 'Trái cây', prompt: 'Fruit in a bowl on a kitchen counter, one banana already spotted, a stray price sticker and a knife left beside it.' },
  { label: 'Góc đọc sách', prompt: 'A corner of a room with an open book face down on a chair, a blanket half falling off, a mug on the floor beside it.' },
  { label: 'Bàn làm việc', prompt: 'A desk by a window with a laptop, a mug, tangled cables and a few scribbled notes, nothing tidied up.' },
  { label: 'Phố đêm', prompt: 'A city street at night after rain, wet tarmac, a parked motorbike, cables overhead and shop lights reflected in a puddle.' },
  { label: 'Quán cafe', prompt: 'A small corner cafe at dusk, a few outdoor tables, one chair pulled out, a bin and some cables against the wall.' },
  { label: 'Bó hoa', prompt: 'A bunch of flowers still in its plastic wrapper lying on a kitchen table, next to the scissors and a few cut stems.' },
  { label: 'Lá thu', prompt: 'A path covered in fallen leaves, some already brown and trodden flat, a bin and a bench at the side.' },
  { label: 'Tuyết rơi', prompt: 'A small street under falling snow, snow piled unevenly along the kerb, tyre tracks through it, a parked car half covered.' },
]

// Câu đuôi cho MỌI ảnh "Tạo Media", thay cho đuôi cũ
// (", photorealistic, ultra detailed, natural lighting…" + IMPERFECT).
// "ultra detailed" là chữ hại nhất: nó bắt mọi thứ trong khung nét như nhau —
// thứ ống kính thật không làm được — nên nhìn ra CGI ngay. Câu này thay bằng cái
// máy ảnh thật làm: màu máy điện thoại, nhiễu ở vùng tối, đèn cháy sáng, khung
// hơi lệch tâm. GIỮ NGUYÊN VĂN bản đã đo thắng ở biến thể B — sửa chữ ở đây là
// vứt bỏ kết quả đo.
const MEDIA_CAMERA =
  'Shot on an iPhone, handheld, straight out of the camera app: ordinary phone-camera colour, noise in the '
  + 'shadows, bright lamps slightly blown out, framing a little off-centre. No people, no text.'

// Each topic carries several scene VARIANTS (different outfit, pose, camera
// angle and composition) so repeated use of the same topic does not produce
// near-identical images. Variants describe ONLY the setting/outfit/pose — the
// person identity and the camera-style lock are added by buildScenePrompt().
// Kept deliberately everyday and moderation-safe (no body/figure wording).
const FACE_SWAP_SCENES: { key: string; variants: string[] }[] = [
  { key: 'bien', variants: [
    'Đứng gần mép nước bãi biển nhiệt đới, mặc váy hè giản dị, tư thế thư giãn nhìn ra biển, chụp góc rộng có hàng dừa, nước biển xanh và cát trắng, ánh nắng giữa trưa, không khí đi biển đời thường.',
    'Đi dạo trên cát ướt, mặc áo thun và quần short nhẹ, chụp góc nghiêng tự nhiên, sóng nhẹ và đường chân trời biển phía sau, ánh nắng vàng dịu cuối ngày, tâm trạng nghỉ dưỡng thư thái.',
    'Ngồi trên khăn tắm dưới ô che nắng cầm ly nước dừa, mặc áo choàng đơn giản, chụp ngang tầm mắt tự nhiên, bãi cát và biển phía sau, ánh nắng chiều ấm áp.',
  ] },
  { key: 'cafe', variants: [
    'Ngồi ở bàn quán cà phê ấm cúng cầm tách cà phê, mặc trang phục đời thường giản dị, biểu cảm thư giãn, ánh đèn trong nhà ấm dịu, không gian quán và bàn gỗ mờ phía sau, khoảnh khắc buổi sáng tự nhiên.',
    'Đứng ở quầy quán cà phê chờ đồ uống, mặc áo len đơn giản, chụp góc nghiêng tự nhiên, bảng thực đơn và máy pha cà phê phía sau, ánh sáng ấm cúng.',
    'Ngồi bên cửa sổ quán cà phê với laptop và cà phê, mặc áo cardigan giản dị, ngước nhìn lên tự nhiên, ánh sáng ban ngày dịu qua cửa sổ, không khí làm việc ở quán thư thái.',
  ] },
  { key: 'view', variants: [
    'Đứng ở điểm ngắm cảnh trên núi, mặc áo khoác du lịch giản dị, tư thế thư giãn, phong cảnh rộng với thung lũng và núi non phía sau, trời trong, ánh nắng vàng cuối ngày, khoảnh khắc du lịch tự nhiên.',
    'Tựa vào lan can gỗ ở điểm ngắm trên đồi, mặc áo hoodie và quần jeans, chụp từ bên cạnh, các dãy đồi trùng điệp và mây phía sau, ánh sáng buổi sáng dịu.',
    'Ngồi trên tảng đá ở điểm ngắm cảnh với balo bên cạnh, mặc đồ dã ngoại giản dị, chụp tự nhiên từ hơi thấp, núi non và bầu trời rộng phía sau, ánh sáng ban ngày.',
  ] },
  { key: 'concert', variants: [
    'Ở buổi hòa nhạc ngoài trời, mặc áo thun giản dị, biểu cảm vui tươi tự nhiên, ánh đèn sân khấu nhiều màu và đám đông phía sau, không khí ban đêm sôi động, ánh đèn rực rỡ.',
    'Đứng trong đám đông giơ điện thoại lên, mặc áo khoác jean, chụp từ bên cạnh, sân khấu và ánh đèn mờ ảo phía sau, tâm trạng buổi tối náo nhiệt.',
    'Gần quầy đồ ăn ở lễ hội âm nhạc, mặc trang phục giản dị, tư thế thư giãn tự nhiên, đèn dây và mọi người phía sau, không khí đêm ấm áp.',
  ] },
  { key: 'dulich', variants: [
    'Tham quan một địa danh du lịch nổi tiếng, mặc trang phục du lịch giản dị với túi đeo chéo nhỏ, tư thế vui tươi tự nhiên, kiến trúc biểu tượng phía sau, ánh nắng ban ngày.',
    'Xem bản đồ ở góc phố khi đi du lịch, mặc đồ thoải mái và mang balo, chụp góc nghiêng tự nhiên, những tòa nhà cũ và con phố nắng phía sau.',
    'Đứng ở điểm ngắm nhìn xuống một thị trấn du lịch, mặc áo khoác nhẹ, chụp góc rộng thư giãn, mái nhà và cảnh vật phía sau, không khí nghỉ dưỡng nắng trong.',
  ] },
  { key: 'dapxe', variants: [
    'Đạp xe trên con đường rợp bóng cây, mặc trang phục nhẹ nhàng giản dị, khoảnh khắc vui vẻ tự nhiên, công viên xanh và con đường phía sau, ánh nắng chiều dịu.',
    'Dắt xe đạp đi trên con hẻm yên tĩnh, mặc quần jeans và áo thun, chụp từ phía sau qua vai, cây lá xanh và ánh nắng, khung cảnh đời thường thư thái.',
    'Nghỉ chân bên chiếc xe đạp gần ghế đá công viên, mặc đồ thể thao giản dị, chụp ngang tầm mắt tự nhiên, cây xanh và lối đi phía sau, ánh nắng ban ngày ấm áp.',
  ] },
  { key: 'hoian', variants: [
    'Đi dạo qua khu phố cổ giữa những chiếc đèn lồng nhiều màu, mặc váy suông đơn giản, mỉm cười nhẹ nhàng, ánh sáng chiều tối ấm áp, đèn lồng và tường cũ phía sau.',
    'Đứng bên bờ sông trong khu phố cổ lúc chạng vạng, mặc trang phục giản dị, chụp góc nghiêng tự nhiên, thuyền và ánh đèn lồng phản chiếu phía sau, ánh sáng ấm dịu.',
    'Ghé xem một tiệm đèn lồng nhỏ trong phố cổ, mặc đồ đời thường, tư thế thư giãn tự nhiên, đèn lồng treo và mặt tiền gỗ phía sau, ánh sáng chiều tối dịu.',
  ] },
  { key: 'lounge', variants: [
    'Ngồi ở quán bar sân thượng cầm ly nước, mặc trang phục buổi tối giản dị, tư thế thư giãn, ánh sáng dịu nhẹ, đường chân trời thành phố về đêm phía sau, ánh đèn mờ ảo ấm áp.',
    'Đứng gần lan can sân thượng ban đêm, mặc áo blouse đơn giản, chụp góc nghiêng tự nhiên, ánh đèn thành phố lung linh phía sau, tâm trạng buổi tối yên bình.',
    'Thư giãn trên ghế sofa với bạn bè bên cạnh, mặc đồ giản dị, biểu cảm tự nhiên, ánh sáng ấm áp và cảnh thành phố về đêm phía sau.',
  ] },
  { key: 'selfie', variants: [
    'Chụp ảnh selfie qua gương bằng điện thoại, mặc trang phục đời thường giản dị, biểu cảm tự nhiên, ánh sáng trong nhà sáng rõ, phòng ngủ đơn giản và gương phía sau, ảnh selfie mạng xã hội chân thật.',
    'Selfie qua gương ở hành lang, mặc quần jeans và áo thun, tư thế thư giãn, ánh sáng ban ngày dịu, tường và gương đơn giản phía sau, vẻ đời thường tự nhiên.',
    'Chụp selfie nhanh gần cửa sổ, giơ điện thoại hơi cao, mặc áo giản dị, ánh sáng tự nhiên dịu, phông nền phòng đơn giản, khoảnh khắc mạng xã hội bình thường.',
  ] },
  { key: 'mall', variants: [
    'Đi trong trung tâm thương mại sáng sủa cầm vài túi mua sắm, mặc trang phục đời thường giản dị, tư thế thư giãn tự nhiên, các cửa hàng và người mua sắm phía sau, ánh sáng trong nhà đều.',
    'Đứng gần thang cuốn trong trung tâm thương mại nhìn điện thoại, mặc áo khoác và quần jeans đơn giản, chụp góc nghiêng tự nhiên, sảnh sáng và cửa hàng phía sau, không khí đời thường nhộn nhịp.',
    'Ngồi trên ghế trong trung tâm thương mại với ly trà sữa, mặc đồ giản dị, tư thế thư giãn tự nhiên, người mua sắm và cửa hàng mờ phía sau, ánh sáng trong nhà dịu.',
  ] },
  { key: 'palengke', variants: [
    'Đi chợ ẩm Philippines (palengke) nhộn nhịp, mặc áo thun đời thường đơn giản, cầm giỏ nhỏ, tư thế tự nhiên bên sạp rau, rau củ nhiều màu và người bán phía sau, ánh sáng ban ngày tự nhiên.',
    'Chọn trái cây ở sạp chợ, mặc đồ giản dị, chụp từ bên cạnh, những giỏ xoài và chuối xung quanh, không khí chợ địa phương náo nhiệt.',
    'Trả tiền cho người bán ở palengke, mặc trang phục bình thường, khoảnh khắc đời thường tự nhiên, các sạp đông đúc và hàng hóa treo phía sau, ánh nắng buổi sáng.',
  ] },
  { key: 'sarisari', variants: [
    'Đứng ở cửa sổ tiệm tạp hóa nhỏ Philippines (sari-sari), mặc đồ mặc nhà giản dị, mua đồ ăn vặt, chụp ngang tầm mắt tự nhiên, các gói và chai treo phía sau, ánh sáng ban ngày khu phố bình thường.',
    'Tựa vào quầy tiệm sari-sari trò chuyện, mặc áo thun và quần short đơn giản, tư thế thư giãn tự nhiên, kệ hàng nhiều màu phía sau, ánh nắng chiều ấm áp.',
    'Cầm chai nước ngọt trước tiệm sari-sari, mặc đồ đời thường, tư thế tự nhiên, con phố nhỏ và bảng hiệu tiệm phía sau, không khí địa phương giản dị.',
  ] },
  { key: 'jeepney', variants: [
    'Ngồi bên cửa sổ trong chiếc jeepney nhiều màu của Philippines, mặc trang phục giản dị, biểu cảm thư giãn tự nhiên, ghế kim loại và hành khách khác phía sau, ánh sáng đường phố ban ngày qua cửa sổ.',
    'Bước lên jeepney ở trạm dừng, mặc đồ đời thường đơn giản với túi đeo, chụp góc nghiêng tự nhiên, thân xe jeepney sơn màu và con phố nhộn nhịp phía sau, ánh sáng ban ngày.',
    'Bám vào tay vịn trong chiếc jeepney đang chạy, mặc áo thun, tư thế tự nhiên, bảng tuyến đường và ghế phía sau, không khí đi lại đời thường.',
  ] },
  { key: 'streetfood', variants: [
    'Mua đồ ăn đường phố ở sạp ven đường, mặc áo thun giản dị, cầm xiên nướng, tư thế thư giãn tự nhiên, khói bếp nướng và khay đồ ăn phía sau, ánh đèn đường buổi tối ấm áp.',
    'Đứng ở xe bán cá viên trên phố Philippines, mặc đồ đơn giản, biểu cảm tự nhiên, xe đẩy và người qua lại phía sau, ánh sáng cuối chiều.',
    'Ngồi ở bàn nhựa nhỏ ăn đồ ăn đường phố, mặc đồ đời thường, tư thế thư giãn, con phố đêm nhộn nhịp và ánh đèn sạp hàng phía sau, không khí địa phương giản dị.',
  ] },
  { key: 'fiesta', variants: [
    'Ở lễ hội đường phố của thị trấn Philippines, mặc trang phục tươi sáng giản dị, tư thế vui tươi tự nhiên, cờ dây nhiều màu và đám đông phía sau, không khí lễ hội ban ngày.',
    'Xem đoàn diễu hành lễ hội từ bên đường, mặc đồ đời thường đơn giản, chụp từ bên cạnh, cờ giấy và mọi người phía sau, tâm trạng nắng ấm sôi động.',
    'Cầm món ăn lễ hội địa phương, mặc áo giản dị, biểu cảm tự nhiên, con phố trang trí và các sạp hàng phía sau, ánh nắng chiều ấm áp.',
  ] },
  { key: 'basketball', variants: [
    'Đứng ở sân bóng rổ khu phố, mặc áo và quần thể thao giản dị, cầm bóng, tư thế thư giãn tự nhiên, sân sơn màu và nhà cửa phía sau, ánh nắng ban ngày.',
    'Ngồi bên rìa sân với bạn bè, mặc đồ thể thao đơn giản, biểu cảm tự nhiên, rổ bóng và con phố khu dân cư phía sau, ánh nắng chiều ấm áp.',
    'Xem trận bóng rổ địa phương từ bên rìa sân, mặc đồ đời thường, chụp góc nghiêng tự nhiên, cầu thủ và khán giả phía sau, ánh nắng ngoài trời.',
  ] },
  { key: 'park', variants: [
    'Ngồi trên ghế đá ở quảng trường công cộng, mặc trang phục đời thường giản dị, tư thế thư giãn, cây cối và đài phun nước phía sau, ánh nắng chiều dịu, tâm trạng đời thường yên bình.',
    'Đi dạo trên lối đi trong công viên, mặc quần jeans và áo nhẹ, chụp từ phía sau qua vai, cây xanh và người khác phía sau, ánh sáng ban ngày nhẹ nhàng.',
    'Đứng gần đài tưởng niệm ở quảng trường, mặc đồ đơn giản, tư thế tự nhiên, quảng trường rộng và cây cối phía sau, không khí nắng trong.',
  ] },
  { key: 'karaoke', variants: [
    'Hát với micro trong đêm hát karaoke tại nhà, mặc trang phục giản dị, biểu cảm vui tươi tự nhiên, màn hình TV và phòng khách phía sau, ánh sáng trong nhà ấm áp.',
    'Ngồi trên sofa cầm micro karaoke với bạn bè bên cạnh, mặc đồ đời thường đơn giản, tư thế thư giãn tự nhiên, phòng khách ấm cúng phía sau, ánh sáng buổi tối ấm áp.',
    'Cười vui trong buổi hát karaoke, mặc áo giản dị, khoảnh khắc tự nhiên, quyển bài hát và đồ ăn vặt trên bàn phía sau, ánh sáng trong nhà dịu.',
  ] },
  { key: 'zoo', variants: [
    'Đi dạo trên lối đi trong sở thú ngắm các chuồng thú, mặc áo thun và mũ giản dị, tư thế thư giãn tự nhiên, cây xanh và biển chỉ dẫn phía sau, ánh nắng ban ngày, không khí đi chơi cùng gia đình.',
    'Đứng gần lan can sở thú chỉ tay về phía những con thú, mặc đồ giản dị thoải mái, chụp từ bên cạnh, chuồng thú và cây cối phía sau, tâm trạng nắng đời thường.',
    'Cầm bản đồ ở cổng sở thú, mặc đồ đời thường đơn giản với túi nhỏ, chụp ngang tầm mắt tự nhiên, cổng vào và khách tham quan phía sau, ánh sáng buổi sáng dịu.',
  ] },
  { key: 'family', variants: [
    'Ngồi ở bàn nhà hàng trong bữa ăn gia đình, mặc trang phục giản dị gọn gàng, biểu cảm thư giãn tự nhiên, các món ăn trên bàn và người thân xung quanh, ánh sáng trong nhà ấm áp.',
    'Chuyền đĩa thức ăn trong bữa trưa gia đình, mặc áo blouse đơn giản, chụp góc nghiêng tự nhiên, bàn ăn đầy món và họ hàng phía sau, ánh sáng ban ngày ấm cúng.',
    'Cười vui ở quán ăn bình dân cùng gia đình, mặc đồ đời thường, khoảnh khắc tự nhiên, khay đồ ăn và không gian quán địa phương phía sau, ánh sáng ấm áp.',
  ] },
  { key: 'cooking', variants: [
    'Nấu ăn ở quầy bếp tại nhà, mặc áo giản dị với tạp dề, khuấy nồi, tư thế thư giãn tự nhiên, kệ bếp và dụng cụ phía sau, ánh sáng trong nhà ấm áp.',
    'Cắt rau trên thớt tại nhà, mặc đồ đời thường đơn giản, chụp từ bên cạnh, bếp và nguyên liệu phía sau, ánh sáng bếp ban ngày dịu.',
    'Nếm thức ăn từ chiếc thìa khi nấu, mặc trang phục giản dị, biểu cảm tự nhiên, phông nền bếp nhà, ánh sáng ấm cúng.',
  ] },
  { key: 'gym', variants: [
    'Ở khu tập thể dục ngoài trời, mặc đồ thể thao giản dị, giãn cơ nhẹ nhàng, tư thế thư giãn tự nhiên, dụng cụ tập ở công viên và cây xanh phía sau, ánh nắng buổi sáng.',
    'Cầm chai nước sau buổi tập, mặc đồ thể thao đơn giản, chụp ngang tầm mắt, phông nền công viên hoặc phòng gym, ánh sáng ban ngày dịu, khoảnh khắc tập luyện bình thường.',
    'Đi bộ trên đường chạy trong đồ tập giản dị, chụp từ bên cạnh tự nhiên, cây cối và người khác đang tập thể dục phía sau, ánh sáng buổi sáng trong lành.',
  ] },
  { key: 'church', variants: [
    'Đứng bên ngoài nhà thờ Philippines sau lễ, mặc trang phục kín đáo gọn gàng giản dị, tư thế điềm tĩnh tự nhiên, mặt tiền nhà thờ và giáo dân phía sau, ánh nắng ban ngày.',
    'Ngồi trên ghế gỗ trong nhà thờ, mặc đồ kín đáo đơn giản, tư thế yên tĩnh thư giãn, mái vòm bên trong và ánh sáng dịu phía sau, không khí tĩnh lặng.',
    'Đi về phía lối vào nhà thờ cầm túi nhỏ, mặc đồ đời thường gọn gàng, chụp góc nghiêng tự nhiên, nhà thờ đá cũ và quảng trường phía sau, ánh sáng buổi sáng ấm áp.',
  ] },
  { key: 'citytrip', variants: [
    'Đi trên con phố nhộn nhịp ở thành phố Philippines, mặc trang phục đời thường giản dị, tư thế thư giãn tự nhiên, jeepney, cửa hàng và biển hiệu phía sau, ánh sáng đô thị ban ngày.',
    'Đứng gần quảng trường lịch sử ở thành phố Philippines (Vigan, Manila hoặc Cebu), mặc đồ đơn giản, chụp góc rộng, kiến trúc cũ và nhịp sống đường phố phía sau, ánh nắng chiều ấm áp.',
    'Ngắm cảnh ở bờ nước thành phố, mặc trang phục nhẹ giản dị, chụp từ bên cạnh tự nhiên, thuyền, tòa nhà và mọi người phía sau, không khí nắng đời thường.',
  ] },
  { key: 'swimming', variants: [
    'Đứng bên mép hồ bơi ngoài trời, mặc áo bơi và quần short giản dị, tư thế thư giãn tự nhiên, nước xanh trong và ghế nằm phía sau, ánh nắng giữa trưa, không khí đi bơi đời thường.',
    'Ngồi bên bờ hồ bơi thả chân xuống nước, mặc áo choàng bơi đơn giản, chụp góc nghiêng tự nhiên, hồ bơi lấp lánh và chậu dừa cảnh phía sau, ánh nắng chiều ấm áp.',
    'Đi trên sàn hồ bơi cầm khăn tắm, mặc áo bơi giản dị, tư thế thư giãn tự nhiên, ô che nắng và sàn lát gạch phía sau, ánh nắng ban ngày.',
  ] },
  { key: 'library', variants: [
    'Ngắm kệ sách cao trong thư viện yên tĩnh, mặc áo cardigan và quần jeans giản dị, tư thế thư giãn tự nhiên, những hàng sách và đèn đọc ấm áp phía sau, ánh sáng trong nhà dịu.',
    'Ngồi ở bàn thư viện đọc một quyển sách mở, mặc áo len đơn giản, chụp ngang tầm mắt tự nhiên, sách chồng lên nhau và đèn học xung quanh, không khí tĩnh lặng.',
    'Đứng giữa các lối đi thư viện cầm vài quyển sách, mặc đồ đời thường, tư thế tự nhiên, kệ gỗ và ánh sáng dịu phía sau, tâm trạng học tập yên bình.',
  ] },
  { key: 'dogwalk', variants: [
    'Dắt chú chó nhỏ bằng dây trên con phố khu dân cư rợp bóng cây, mặc áo thun và quần short giản dị, tư thế vui vẻ tự nhiên, nhà cửa và cây xanh phía sau, ánh sáng buổi sáng dịu.',
    'Ngồi xổm vuốt ve chú chó vui vẻ trong công viên, mặc đồ đời thường đơn giản, biểu cảm tự nhiên, bãi cỏ và lối đi phía sau, ánh sáng ban ngày nhẹ nhàng.',
    'Đứng trên vỉa hè cầm dây dắt chó, mặc áo hoodie nhẹ, tư thế thư giãn góc nghiêng tự nhiên, con phố yên tĩnh và cây cối phía sau, ánh nắng chiều ấm áp.',
  ] },
  { key: 'cinema', variants: [
    'Ngồi một mình trên ghế rạp chiếu phim cầm hộp bắp rang, mặc trang phục giản dị, tư thế thư giãn tự nhiên, các hàng ghế tối mờ và màn hình sáng phía sau, ánh sáng dịu mờ ảo.',
    'Đứng ở sảnh rạp chiếu phim gần bức tường áp phích, mặc đồ đời thường đơn giản, chụp góc nghiêng tự nhiên, biển hiệu rạp sáng và quầy vé phía sau, ánh sáng trong nhà đều.',
    'Cầm vé xem phim và ly nước ở lối vào rạp, mặc áo khoác giản dị, tư thế thư giãn tự nhiên, các áp phích sáng và thảm phía sau, ánh sáng sảnh ấm áp.',
  ] },
  { key: 'plants', variants: [
    'Tưới cây trong chậu ở ban công nhỏ tại nhà, mặc áo giản dị, tư thế thư giãn tự nhiên, cây xanh và ánh sáng buổi sáng phía sau, không khí ấm cúng trong lành.',
    'Cầm chậu cây nhỏ gần cửa sổ đầy nắng, mặc đồ đời thường đơn giản, chụp ngang tầm mắt tự nhiên, kệ cây xanh phía sau, ánh sáng tự nhiên dịu.',
    'Chăm cây ở góc vườn nhà, mặc trang phục giản dị với găng tay làm vườn, tư thế tự nhiên, chậu cây và dụng cụ xung quanh, ánh nắng chiều ấm áp.',
  ] },
  { key: 'nailsalon', variants: [
    'Ngồi ở tiệm nail làm móng tay, mặc áo blouse giản dị, tư thế thư giãn tự nhiên, các chai sơn và quầy tiệm phía sau, ánh sáng trong nhà ấm dịu.',
    'Khoe bộ móng vừa sơn ở tiệm nail, mặc đồ đời thường đơn giản, chụp ngang tầm mắt tự nhiên, ghế và kệ tiệm phía sau, ánh sáng đều sáng.',
    'Chờ trên ghế sofa tiệm lật xem quyển màu sơn móng, mặc trang phục giản dị, tư thế thư giãn tự nhiên, không gian tiệm ấm cúng phía sau, ánh sáng ấm áp.',
  ] },
  { key: 'baking', variants: [
    'Làm bánh ở quầy bếp tại nhà nhào bột, mặc áo giản dị với tạp dề, tư thế thư giãn tự nhiên, bột mì, tô và lò nướng phía sau, ánh sáng trong nhà ấm áp.',
    'Bắt kem lên bánh cupcake tại nhà, mặc đồ đời thường đơn giản và tạp dề, chụp từ bên cạnh, khay bánh và nguyên liệu phía sau, ánh sáng bếp ban ngày dịu.',
    'Cầm khay bánh quy vừa nướng trong bếp, mặc tạp dề giản dị, biểu cảm vui tươi tự nhiên, ánh lò ấm và quầy bếp phía sau, ánh sáng ấm cúng.',
  ] },
  { key: 'jollibee', variants: [
    'Ăn ở nhà hàng thức ăn nhanh Jollibee cầm phần gà rán, mặc trang phục giản dị, tư thế thư giãn tự nhiên, không gian đỏ vàng rực rỡ và thực khách khác phía sau, ánh sáng trong nhà đều.',
    'Đứng ở quầy Jollibee cầm khay, mặc đồ đời thường đơn giản, chụp góc nghiêng tự nhiên, bảng thực đơn và trang trí thức ăn nhanh vui tươi phía sau, ánh sáng sáng.',
    'Ngồi trong ô ghế Jollibee với burger và nước, mặc áo giản dị, tư thế thư giãn tự nhiên, không gian nhà hàng nhiều màu phía sau, không khí đời thường ấm áp.',
  ] },
  { key: 'spa', variants: [
    'Thư giãn ở phòng chờ spa trong áo choàng mềm với khăn quấn đầu, mặc áo choàng spa giản dị, tư thế điềm tĩnh tự nhiên, cây cảnh, nến và khăn gấp phía sau, ánh sáng ấm dịu.',
    'Ngồi ở khu chờ spa nhấp trà thảo mộc, mặc áo choàng đơn giản, chụp ngang tầm mắt tự nhiên, trang trí spa thanh bình và ánh sáng mờ phía sau, tâm trạng thư giãn.',
    'Đứng gần quầy lễ tân spa với khuynh diệp và nến, mặc áo choàng giản dị, tư thế thư giãn tự nhiên, không gian spa ấm áp dịu nhẹ phía sau, ánh sáng nhẹ nhàng.',
  ] },
  { key: 'picnic', variants: [
    'Ngồi trên tấm thảm dã ngoại trong công viên, mặc váy hè giản dị, tư thế thư giãn tự nhiên, giỏ đồ ăn, trái cây và nước bày ra, cỏ xanh và cây cối phía sau, ánh nắng ban ngày.',
    'Rót nước trái cây trong buổi dã ngoại ngoài trời, mặc đồ đời thường đơn giản, chụp góc nghiêng tự nhiên, tấm thảm caro và đồ ăn vặt xung quanh, ánh nắng chiều dịu, tâm trạng vui vẻ thư thái.',
    'Nằm ngả ra bãi cỏ trong buổi dã ngoại đọc sách, mặc trang phục nhẹ giản dị, tư thế tự nhiên, cây cối và công viên rộng phía sau, ánh nắng vàng cuối ngày ấm áp.',
  ] },
  { key: 'museum', variants: [
    'Ngắm những bức tranh trên tường trong bảo tàng nghệ thuật, mặc trang phục giản dị gọn gàng, tư thế thư giãn tự nhiên, tranh đóng khung và ánh đèn phòng trưng bày phía sau, ánh sáng đều dịu.',
    'Đứng trong sảnh bảo tàng sáng đọc bảng chú thích, mặc đồ đời thường đơn giản, chụp góc nghiêng tự nhiên, tượng và tường trắng phía sau, không khí tĩnh lặng.',
    'Đi qua phòng trưng bày bảo tàng cầm tờ rơi, mặc áo khoác giản dị, tư thế thư giãn tự nhiên, các hiện vật và khách tham quan khác phía sau, ánh sáng trong nhà nhẹ nhàng.',
  ] },
  { key: 'roadtrip', variants: [
    'Ngồi ở ghế phụ trên xe trong chuyến đi đường dài, mặc trang phục giản dị, tư thế thư giãn tự nhiên nhìn ra cửa sổ, bảng táp-lô và con đường phong cảnh phía sau, ánh nắng ban ngày ấm áp.',
    'Đứng bên chiếc xe đỗ ở điểm dừng ven đường, mặc đồ đời thường đơn giản với kính râm gác trên đầu, chụp góc nghiêng tự nhiên, đường cao tốc rộng và đồi núi phía sau, ánh nắng trong.',
    'Tựa vào cửa xe ở điểm dừng ngắm cảnh, mặc áo khoác nhẹ, tư thế thư giãn tự nhiên, núi non và con đường quanh co phía sau, ánh nắng chiều vàng.',
  ] },
]

// Plain-language theme per topic, sent to the LLM scene generator once a row's
// local variants have been exhausted (after ~3 "Tạo lại" presses) so users get
// unlimited fresh scenes without us hand-writing more variants.
const FACE_SWAP_SCENE_THEMES: Record<string, string> = {
  bien: 'một ngày thư giãn ở bãi biển nhiệt đới',
  cafe: 'quán cà phê',
  view: 'điểm ngắm cảnh trên núi',
  concert: 'buổi hòa nhạc ngoài trời',
  dulich: 'tham quan một địa danh du lịch',
  dapxe: 'đạp xe trên phố',
  hoian: 'khu phố cổ với đèn lồng',
  lounge: 'quán bar sân thượng về đêm',
  selfie: 'ảnh selfie qua gương ở nhà',
  mall: 'trung tâm thương mại',
  palengke: 'chợ ẩm Philippines (palengke)',
  sarisari: 'tiệm tạp hóa sari-sari Philippines',
  jeepney: 'đi xe jeepney Philippines',
  streetfood: 'sạp đồ ăn đường phố Philippines',
  fiesta: 'lễ hội thị trấn Philippines',
  basketball: 'sân bóng rổ khu phố',
  park: 'công viên hoặc quảng trường công cộng',
  karaoke: 'đêm hát karaoke tại nhà',
  zoo: 'một ngày ở sở thú',
  family: 'đi ăn nhà hàng cùng gia đình',
  cooking: 'nấu ăn ở bếp nhà',
  gym: 'tập thể dục',
  church: 'đi nhà thờ Philippines',
  citytrip: 'khám phá một thành phố Philippines (Manila, Cebu, Vigan, v.v.)',
  swimming: 'một ngày ở hồ bơi',
  library: 'thư viện yên tĩnh và đọc sách',
  dogwalk: 'dắt chó đi dạo ngoài trời',
  cinema: 'xem phim ở rạp',
  plants: 'chăm cây tại nhà',
  nailsalon: 'làm móng ở tiệm nail',
  baking: 'làm bánh tại nhà',
  jollibee: 'ăn ở nhà hàng thức ăn nhanh Jollibee',
  spa: 'một ngày thư giãn ở spa',
  picnic: 'dã ngoại ngoài trời',
  museum: 'tham quan bảo tàng nghệ thuật',
  roadtrip: 'chuyến đi đường dài bằng xe',
}
// Number of instant local-variant cycles before "Tạo lại" switches to the LLM.
// AI prompts are the DEFAULT everywhere: adding a scene chip AI-writes its person
// rows, and every "Tạo lại" press goes straight to the AI scene generator. The
// curated 3-variant pool is only an instant placeholder + fallback when the AI
// call fails — leaning on it made repeated generations repetitive.
const SCENE_REGEN_LOCAL_LIMIT = 0
// Human-readable row text for the scenery-only shot of a topic (shown in the
// prompt box, editable). Derived from the topic theme so it stays in sync.
function sceneryRowText(key: string): string {
  const theme = FACE_SWAP_SCENE_THEMES[key]
  return theme
    ? `Bối cảnh ${theme} — chỉ khung cảnh, không có người.`
    : 'Nơi diễn ra cảnh này — chỉ địa điểm, không có người.'
}

// OpenAI (và Grok) chỉ nhận 3 tỉ lệ khung (Vuông 1:1 / Dọc 2:3 / Ngang 3:2 — xem
// OPENAI_IMAGE_SIZES bên content/views.py). handleEditImage() sửa MỘT ảnh có sẵn:
// nếu không gửi tỉ lệ, backend mặc định 1024x1024 (vuông) bất kể ảnh gốc dọc hay
// ngang — ảnh gốc bị ép vào khung vuông đó, ra kết quả bẹt/méo. Chọn tỉ lệ GẦN
// NHẤT với ảnh gốc rồi gửi tường minh để tránh việc đó.
const OPENAI_SIZE_RATIOS: [OpenAIImageSize, number][] = [
  ['1024x1024', 1], ['1024x1536', 2 / 3], ['1536x1024', 3 / 2],
]
function closestOpenAISize(ratio: number): OpenAIImageSize {
  return OPENAI_SIZE_RATIOS.reduce((best, cur) =>
    Math.abs(cur[1] - ratio) < Math.abs(best[1] - ratio) ? cur : best
  )[0]
}
async function closestOpenAISizeForFile(file: File): Promise<OpenAIImageSize> {
  try {
    const bitmap = await createImageBitmap(file)
    const size = closestOpenAISize(bitmap.width / bitmap.height)
    bitmap.close()
    return size
  } catch {
    return '1024x1024'
  }
}
/** Bản nhận data-URI / URL thay vì File — dòng "ảnh thật" (realref) giữ ảnh gốc dưới dạng
 *  data-URI trong `meta.refImage`, không phải File, nên không dùng được hàm trên. */
async function closestOpenAISizeForSrc(src: string): Promise<OpenAIImageSize> {
  try {
    const im = new Image()
    await new Promise<void>((ok, err) => {
      im.onload = () => ok()
      im.onerror = () => err(new Error('load failed'))
      im.src = src
    })
    return closestOpenAISize(im.naturalWidth / im.naturalHeight)
  } catch {
    return '1024x1024'
  }
}

// Khung ảnh cho ảnh cảnh do AI sinh (dòng "Người" và "Cảnh"). Trước đây MỌI lời gọi
// genImage() ở phần sinh cảnh đều bỏ trống tham số `size` — nó là tham số THỨ 7, muốn
// truyền phải điền 2 tham số trống ở giữa nên rất dễ quên — khiến backend rơi về mặc định
// '1024x1024' (xem DEFAULT_OPENAI_IMAGE_SIZE trong content/views.py). Kết quả: mọi ảnh cảnh
// của luồng cũ đều là ảnh VUÔNG 1.0 MP, trong khi trần của gpt-image-2 là 1024x1536 (1.6 MP)
// và Facebook thì ưu tiên khung dọc. Đổi sang dọc = +57% điểm ảnh, KHÔNG tốn thêm chi phí
// (OpenAI tính tiền theo `quality`, không theo `size`). Dòng "ảnh thật" (realref) KHÔNG dùng
// hằng số này mà bám theo tỉ lệ ảnh gốc — ép ảnh ngang vào khung dọc sẽ méo bố cục.
const SCENE_IMAGE_SIZE: OpenAIImageSize = '1024x1536'

function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

// Downscale + re-encode an image File to a JPEG data URI whose longest edge is at
// most `maxEdge`, so a big phone photo (up to 15 MB) is shrunk in the browser
// before upload instead of shipping the full base64 over the wire. Falls back to
// the raw file (via fileToDataUri) if the canvas pipeline fails for any reason.
async function fileToDownscaledDataUri(file: File, maxEdge = 1600, quality = 0.85): Promise<string> {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
    if (scale >= 1) { bitmap.close(); return await fileToDataUri(file) }
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) { bitmap.close(); return await fileToDataUri(file) }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    return canvas.toDataURL('image/jpeg', quality)
  } catch {
    return fileToDataUri(file)
  }
}

/** Chia ảnh thành các lô để gửi lên, TÁCH theo việc ảnh đã có URL trong kho chưa.
 *
 *  Ảnh đã cất kho: payload chỉ là cái URL vài trăm byte → gộp lô lớn cho ít
 *  request. Ảnh còn phải gửi base64: mỗi ảnh ~2,25 MB → một ảnh một lô, để thanh
 *  tiến độ nhảy đúng từng ảnh thay vì đứng im ở "0/3" suốt cả lượt lưu.
 *  Lô URL xếp trước lô base64 để phần chắc chắn nhanh xong ngay từ đầu. */
function chunkForSave(kind: 'scenes' | 'media', items: string[]): { kind: 'scenes' | 'media'; items: string[] }[] {
  const byUrl = items.filter((u) => storedRef(u) !== u)
  const byB64 = items.filter((u) => storedRef(u) === u)
  const out: { kind: 'scenes' | 'media'; items: string[] }[] = []
  for (let i = 0; i < byUrl.length; i += SAVE_URL_CHUNK_SIZE) out.push({ kind, items: byUrl.slice(i, i + SAVE_URL_CHUNK_SIZE) })
  for (let i = 0; i < byB64.length; i += SAVE_CHUNK_SIZE) out.push({ kind, items: byB64.slice(i, i + SAVE_CHUNK_SIZE) })
  return out
}

// Run async `worker` over `items` with at most `concurrency` promises in flight.
// Rejects on the first worker error (like the old sequential loop) — already-
// completed items stay done, so a retry resumes from the rest.
async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  let firstError: unknown = null
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    // Stop pulling NEW items once any worker has failed. Runners swallow their
    // error into firstError instead of rejecting, so Promise.all only resolves
    // after every in-flight worker has settled — the caller can then clean up
    // (e.g. clear a progress bar) knowing no late worker will fire state after.
    while (cursor < items.length && firstError === null) {
      const item = items[cursor++]
      try {
        await worker(item)
      } catch (err) {
        if (firstError === null) firstError = err
      }
    }
  })
  await Promise.all(runners)
  if (firstError !== null) throw firstError
}

// ── Component ─────────────────────────────────────────────────────────────────
interface Props {
  onClose: () => void
  onSaved: () => void
  // When set, the wizard runs in "add more images" mode: it reuses this
  // character's source face and appends new media/scenes to it instead of
  // creating a new character.
  targetCharacter?: Character | null
}

export default function FaceSwapWizardLegacy({ onClose, onSaved, targetCharacter }: Props) {
  const { t } = useTranslation()
  const { showToast } = useToast()

  const [faceSwapMode, setFaceSwapMode] = useState<'prompt' | 'edit' | 'media' | 'pinterest' | 'faceswap'>('prompt')
  
  // Pinterest/Pexels integration states
  const [pinterestQuery, setPinterestQuery] = useState('')
  const [pinterestPhotos, setPinterestPhotos] = useState<any[]>([])
  const [pinterestLoading, setPinterestLoading] = useState(false)
  const [pinterestPage, setPinterestPage] = useState(1)
  const [hasMorePinterest, setHasMorePinterest] = useState(true)

  const [faceSwapStep, setFaceSwapStep] = useState<'character' | 'scenes'>(targetCharacter ? 'scenes' : 'character')
  const [faceSwapSource, setFaceSwapSource] = useState<File | null>(null)
  const [faceSwapSourcePreview, setFaceSwapSourcePreview] = useState<string | null>(null)
  const [faceSwapSourceData, setFaceSwapSourceData] = useState<string | null>(null)
  const [faceSwapTargetPrompt, setFaceSwapTargetPrompt] = useState('')
  // Add-more mode: reuse the character's saved identity prompt so new scenes
  // keep the same person (and skip the generic fallback).
  const [faceSwapFacePrompt, setFaceSwapFacePrompt] = useState(targetCharacter?.face_prompt ?? '')
  // Ngôn ngữ máy quay (cỡ cảnh / góc máy / góc khuôn mặt). '' = tự động → giữ nguyên
  // hành vi cũ: bốc ngẫu nhiên mỗi ảnh một góc. Option lấy từ lib/quickPrompt để hai
  // luồng dùng CHUNG một bộ, không phải chép đôi.
  const [camShot, setCamShot] = useState('')
  const [camAngle, setCamAngle] = useState('')
  const [camHead, setCamHead] = useState('')
  // Rehydrate the saved character's country when adding scenes to it, so scene
  // localisation still knows where the person is from (append mode has no nation
  // input; without this the scenes would drift to a wrong/default country).
  const [faceNation, setFaceNation] = useState(targetCharacter?.nation ?? '')
  const [topicLoading, setTopicLoading] = useState(false)
  const [faceSwapCharacterImage, setFaceSwapCharacterImage] = useState<string | null>(null)
  const [faceSwapDailyPrompts, setFaceSwapDailyPrompts] = useState<string[]>([''])
  const [faceSwapSceneImages, setFaceSwapSceneImages] = useState<(string | null)[]>([null])
  // Open the colour-filter picker for a specific image. kind tells onApply where
  // to write the filtered result back (the character ref vs. a scene by index).
  const [filterTarget, setFilterTarget] = useState<
    { kind: 'character' } | { kind: 'scene'; index: number } | null
  >(null)
  // Per scene-row metadata: which preset topic it came from (for "Tạo lại") and
  // how many times it has been regenerated (to decide local variant vs LLM).
  const [faceSwapSceneMeta, setFaceSwapSceneMeta] = useState<SceneMeta[]>([{ topic: null, regen: 0, kind: 'person', headAngle: randomHeadAngle() }])
  const [faceSwapPromptBusy, setFaceSwapPromptBusy] = useState<number | null>(null)
  // Curated seed texts whose AI replacement is still in flight — the matching
  // rows show a spinner. Tracked by TEXT (not index) so row edits/removals
  // while waiting simply cancel the swap.
  const [pendingSeeds, setPendingSeeds] = useState<string[]>([])
  const [faceSwapResults, setFaceSwapResults] = useState<string[]>([])
  const [faceSwapLoading, setFaceSwapLoading] = useState(false)
  const [faceSwapSceneBusy, setFaceSwapSceneBusy] = useState<number | null>(null)
  const [faceSwapError, setFaceSwapError] = useState('')

  // Images the "Ghép mặt" tab can pick as source/target: the character built this
  // session (ref + scenes + results) plus, in add-more mode, the target character's
  // saved media. Deduped; empty for a brand-new character with nothing generated yet.
  const availableMedia = useMemo(() => {
    const urls: string[] = []
    if (faceSwapCharacterImage) urls.push(faceSwapCharacterImage)
    faceSwapSceneImages.forEach((u) => { if (u) urls.push(u) })
    faceSwapResults.forEach((u) => urls.push(u))
    if (targetCharacter) {
      if (targetCharacter.source_image_url) urls.push(targetCharacter.source_image_url)
      targetCharacter.media?.forEach((m) => { if (m.url) urls.push(m.url) })
      targetCharacter.scenes?.forEach((m) => { if (m.url) urls.push(m.url) })
    }
    return Array.from(new Set(urls.filter(Boolean)))
  }, [faceSwapCharacterImage, faceSwapSceneImages, faceSwapResults, targetCharacter])

  const [saveCharOpen, setSaveCharOpen] = useState(false)
  const [saveCharName, setSaveCharName] = useState('')
  const [saveCharLoading, setSaveCharLoading] = useState(false)
  // Chunked-save progress ("Đang lưu 4/12 ảnh…") shown while persist() runs.
  const [saveProgress, setSaveProgress] = useState<{ done: number; total: number } | null>(null)
  const [loadingSource, setLoadingSource] = useState(false)
  const [savedSceneUrls, setSavedSceneUrls] = useState<Set<string>>(new Set())
  const [savingScene, setSavingScene] = useState<string | null>(null)
  // "Tạo Media" tab: generate non-person images (nature, sky, animals, objects…)
  // with GPT and save them straight into the character's media.
  const [mediaPrompt, setMediaPrompt] = useState('')
  const [mediaGenerating, setMediaGenerating] = useState(false)
  const [mediaImages, setMediaImages] = useState<string[]>([])
  const [mediaCount, setMediaCount] = useState(2)
  const [savedMediaUrls, setSavedMediaUrls] = useState<Set<string>>(new Set())
  const [savingMedia, setSavingMedia] = useState<string | null>(null)
  // "Kho ảnh Pinterest" tab: upload a local file straight into the character's
  // media (converted client-side to a data URI, then saved the same way as any
  // other media image — the backend already accepts base64/data-URI payloads).
  const [uploadingLocalMedia, setUploadingLocalMedia] = useState(false)

  const qc = useQueryClient()
  const isAppend = !!targetCharacter
  // Scrollable modal body (holds every tab's content) — the IntersectionObserver
  // root for the Pexels tab's infinite scroll below, since this div (not the
  // window) is what actually scrolls inside the fixed-overlay wizard.
  const modalBodyRef = useRef<HTMLDivElement>(null)
  // Sentinel placed after the last Pexels photo row: once it enters view we fetch
  // the next page automatically, so the tab never needs a manual "Xem thêm" button.
  const pinterestSentinelRef = useRef<HTMLDivElement>(null)
  // Tracks whether the work has already been persisted (explicit save or a
  // previous auto-save) so closing doesn't create a duplicate.
  const savedRef = useRef(false)
  // The character this wizard session writes to: the target (add-more mode), or
  // a draft we create on the first per-scene/auto save (so everything lands on
  // ONE character instead of duplicating).
  const draftIdRef = useRef<number | null>(targetCharacter?.id ?? null)
  // In-flight draft-creation promise, shared by ALL save paths (persist,
  // handleSaveScene, handleSaveMedia). Without it, two saves that both see
  // draftIdRef.current === null before either resolves would each POST a create
  // and spawn TWO character rows. Reset to null on failure so a later save retries.
  const draftCreatePromiseRef = useRef<Promise<number> | null>(null)
  // (Bản đồ data URI → URL trong kho đã chuyển sang lib/imageStore.ts — nó phải
  // sống ở tầng module để hai chỗ cùng dùng một ảnh không cất lên kho hai lần.
  // Xem saveRef() và effect "Cất ảnh vào kho ngay khi nó vừa hiện ra" bên dưới.)

  // Vietnamese text → its English pre-translation (both scene descriptions from
  // scene_to_prompt AND the face-identity prompt from topic_to_prompt). Used at
  // generation time to assemble a fully-English person prompt so the backend skips
  // its per-image translate LLM call. Keyed by the exact VI text, so a user edit
  // misses the cache and generation falls back to translating (no stale English).
  const sceneEnMapRef = useRef<Map<string, string>>(new Map())

  // Wrapper around contentsApi.generateImage.
  //
  // Trước đây chỗ này đọc `res.url` để ghi vào bản đồ "lưu bằng URL". Backend đã
  // BỎ phần pre-upload từ commit b4c71ea nên `res.url` không bao giờ có, và cả cơ
  // chế lưu-bằng-URL nằm không suốt từ đó — mọi lượt lưu đều gửi lại base64. Giờ
  // việc cất kho do effect prestoreImage() phía dưới làm, ngay khi ảnh hiện ra.
  async function genImage(prompt: string, referenceImage?: string | string[], noFallback?: boolean, explainErrors?: boolean, provider?: ImageProvider, resolution?: string, size?: OpenAIImageSize) {
    return contentsApi.generateImage(prompt, referenceImage, noFallback, explainErrors, size, undefined, provider, resolution)
  }

  // Translate a media/scene image to what should be sent to the backend on save:
  // its storage URL when the image was already cất vào kho, else the base64 data
  // URI itself (kho lỗi / ảnh vừa mới hiện ra chưa kịp cất).
  const saveRef = (image: string): string => storedRef(image)

  // Get the session's draft character id, creating it exactly once even when
  // several save paths race. Returns { id, seeded } — `seeded` is true only for
  // the caller that actually created the row (its `makePayload()` images went
  // into the create); concurrent callers get seeded=false and must add-media
  // their own images afterwards. The shared promise is set synchronously (no
  // await between the null-check and the assignment), so only the first caller
  // creates. On failure the ref resets so a later save can retry.
  async function ensureDraft(makePayload: () => Parameters<typeof charactersApi.create>[0]): Promise<{ id: number; seeded: boolean }> {
    if (draftIdRef.current != null) return { id: draftIdRef.current, seeded: false }
    if (!draftCreatePromiseRef.current) {
      draftCreatePromiseRef.current = charactersApi.create(makePayload())
        .then((c) => { draftIdRef.current = c.id; return c.id })
        .catch((err) => { draftCreatePromiseRef.current = null; throw err })
      return { id: await draftCreatePromiseRef.current, seeded: true }
    }
    return { id: await draftCreatePromiseRef.current, seeded: false }
  }

  // Add-more mode: pull the existing character's face server-side (private
  // bucket → data URI, no CORS) and reuse it as the swap source.
  useEffect(() => {
    if (!targetCharacter) return
    let cancelled = false
    setLoadingSource(true)
    charactersApi.getSourceImage(targetCharacter.id)
      .then((res) => { if (!cancelled) setFaceSwapCharacterImage(res.image) })
      .catch(() => { if (!cancelled) showToast(t('content.faceSwap.sourceLoadFailed'), 'error') })
      .finally(() => { if (!cancelled) setLoadingSource(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fetchPinterestPhotos = async (queryStr?: string, pageNum = 1) => {
    if (!PEXELS_KEY) return
    setPinterestLoading(true)
    setFaceSwapError('')
    try {
      const page = pageNum
      const url = queryStr?.trim()
        ? `https://api.pexels.com/v1/search?per_page=30&page=${page}&query=${encodeURIComponent(queryStr.trim())}`
        : `https://api.pexels.com/v1/curated?per_page=30&page=${page}`
      const res = await fetch(url, { headers: { Authorization: PEXELS_KEY } })
      const data = await res.json()
      const newPhotos = data.photos || []
      
      if (page === 1) {
        setPinterestPhotos(newPhotos)
      } else {
        setPinterestPhotos(prev => {
          const existingIds = new Set(prev.map((p: any) => p.id))
          const filteredNew = newPhotos.filter((p: any) => !existingIds.has(p.id))
          return [...prev, ...filteredNew]
        })
      }
      
      setHasMorePinterest(newPhotos.length === 30)
      setPinterestPage(page)
    } catch (err) {
      if (pageNum === 1) setPinterestPhotos([])
      showToast('Không thể tải ảnh từ kho ảnh.', 'error')
    } finally {
      setPinterestLoading(false)
    }
  }

  useEffect(() => {
    if (faceSwapMode === 'pinterest' && pinterestPhotos.length === 0) {
      fetchPinterestPhotos()
    }
  }, [faceSwapMode, pinterestPhotos.length])

  // Infinite scroll for the Pexels tab: observe the sentinel below the last row
  // of photos (root = the modal's own scroll container, not the window) and load
  // the next page as soon as it comes into view — no "Xem thêm" button needed.
  // Re-created whenever page/loading state changes so the callback always closes
  // over the latest values instead of the ones from when the observer was built.
  useEffect(() => {
    if (faceSwapMode !== 'pinterest' || !hasMorePinterest) return
    const sentinel = pinterestSentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !pinterestLoading) {
          fetchPinterestPhotos(pinterestQuery, pinterestPage + 1)
        }
      },
      { root: modalBodyRef.current, rootMargin: '400px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [faceSwapMode, hasMorePinterest, pinterestLoading, pinterestPage, pinterestQuery])

  // Warn before F5/tab-close while a save is running or images are unsaved —
  // navigating away cancels the in-flight request and loses the session's work.
  // No dep array: re-registers each render so the closure always sees fresh state.
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      const hasUnsaved =
        saveCharLoading ||
        [...faceSwapResults, ...mediaImages].some((url) => !savedMediaUrls.has(url)) ||
        faceSwapSceneImages.some((url) => url && !savedSceneUrls.has(url)) ||
        (draftIdRef.current == null && !!faceSwapCharacterImage)
      if (!hasUnsaved) return
      e.preventDefault()
      // Chrome still requires returnValue for the prompt to appear.
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  })

  function revokeIfSet(url: string | null) {
    if (url) URL.revokeObjectURL(url)
  }

  // Download an image as JPEG, re-encoded through a canvas so any provenance
  // metadata the generator embeds (C2PA / EXIF / XMP) is stripped — the wizard
  // previews are raw `data:image/png` from OpenAI (still carry C2PA), unlike the
  // saved S3 copies which are already sanitized server-side. Cross-origin URLs
  // that taint the canvas fall back to a plain (un-re-encoded) download.
  async function downloadImageAsJpeg(src: string, filename: string) {
    try {
      const image = new Image()
      image.crossOrigin = 'anonymous'
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve()
        image.onerror = () => reject(new Error('image load failed'))
        image.src = src
      })
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no canvas context')
      ctx.fillStyle = '#ffffff' // JPEG has no alpha — flatten transparency to white
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(image, 0, 0)
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95))
      if (!blob) throw new Error('jpeg encode failed')
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {
      const a = document.createElement('a')
      a.href = src
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
    }
  }

  // ── Cất ảnh vào kho ngay khi nó vừa hiện ra ───────────────────────────────
  // Mọi ảnh của lượt làm việc này — ảnh nhân vật, ảnh cảnh, ảnh ghép mặt, ảnh
  // "Tạo Media", ảnh vừa áp filter, ảnh vừa xoá chữ, ảnh tải từ máy — được đẩy
  // ngầm lên kho NGAY lúc nó xuất hiện, trong khi người dùng còn đang ngắm và
  // chưa bấm gì. Đến lúc bấm Lưu thì chỉ còn gửi URL: request lưu tụt từ ~6,6 MB
  // (3 ảnh base64) xuống vài trăm byte. Xem lib/imageStore.ts.
  //
  // Bắt theo DANH SÁCH ảnh, không rải ở từng nơi sinh ảnh, là có chủ ý: ảnh chảy
  // vào ba danh sách này bằng cả chục đường (sinh, sinh lại, filter, xoá chữ,
  // inpaint, upload máy, Pexels), bắt ở danh sách thì không sót đường nào.
  // prestoreImage() tự bỏ qua ảnh đã cất / đang cất / không phải data URI nên
  // chạy lại ở mỗi lần render là vô hại.
  useEffect(() => {
    if (faceSwapCharacterImage) prestoreImage(faceSwapCharacterImage, 'source')
  }, [faceSwapCharacterImage])
  useEffect(() => {
    faceSwapSceneImages.forEach((u) => { if (u) prestoreImage(u, 'scenes') })
  }, [faceSwapSceneImages])
  useEffect(() => {
    faceSwapResults.forEach((u) => prestoreImage(u, 'media'))
    mediaImages.forEach((u) => prestoreImage(u, 'media'))
  }, [faceSwapResults, mediaImages])

  // Two separate stores: media = face-swapped results; scenes = the raw
  // AI-generated scenes (+ an AI target from upload mode).
  function collectSwappedMedia(): string[] {
    return [...faceSwapResults]
  }
  function collectScenes(): string[] {
    return faceSwapSceneImages.filter((img): img is string => Boolean(img))
  }

  // Persist whatever was generated to ONE character (draftIdRef): create it the
  // first time, append after that. Everything already saved one-by-one (scenes
  // AND media) is skipped so nothing is duplicated, and unsaved "Tạo Media"
  // images ride along instead of being silently dropped. Images go up in small
  // batches (SAVE_CHUNK_SIZE per request) rather than one giant base64 POST;
  // each finished batch is marked saved, so a retry after a failure resumes
  // from where it stopped instead of re-uploading (or losing) everything.
  async function persist(name: string): Promise<boolean> {
    const media = [...collectSwappedMedia(), ...mediaImages].filter((url) => !savedMediaUrls.has(url))
    const scenes = collectScenes().filter((url) => !savedSceneUrls.has(url))
    let id = draftIdRef.current
    if (id == null && !faceSwapCharacterImage && media.length === 0 && scenes.length === 0) return false
    if (id != null && media.length === 0 && scenes.length === 0 && (isAppend || !name)) return false

    // Chờ những lượt cất kho còn đang bay trước khi dựng payload: chờ xong thì lưu
    // bằng URL (nhanh) thay vì gửi lại base64, và cùng một ảnh không bị đẩy lên
    // kho hai lần. Thường về ngay vì ảnh đã được cất từ lúc nó hiện ra; kho chậm
    // thì hàm này tự bỏ chờ sau vài giây chứ không giam người dùng.
    await waitForPrestore([
      ...scenes, ...media,
      ...(faceSwapCharacterImage ? [faceSwapCharacterImage] : []),
    ])

    const total = media.length + scenes.length
    let done = 0
    if (total) setSaveProgress({ done, total })
    try {
      if (id == null) {
        // Create the row first so the character exists even if a later batch
        // fails. A fully empty create is rejected by the backend, so without a
        // source image the first batch of images rides along.
        let seedMedia: string[] = []
        let seedScenes: string[] = []
        if (!faceSwapCharacterImage) {
          if (scenes.length) seedScenes = scenes.slice(0, SAVE_CHUNK_SIZE)
          else seedMedia = media.slice(0, SAVE_CHUNK_SIZE)
        }
        // ensureDraft() creates the row once even if another save path races us;
        // saveRef() sends each image's pre-uploaded URL so the backend passes it
        // straight through instead of re-decoding base64.
        const { id: draftId, seeded } = await ensureDraft(() => ({ name, source_image: faceSwapCharacterImage ? saveRef(faceSwapCharacterImage) : undefined, face_prompt: faceSwapFacePrompt.trim() || undefined, nation: faceNation.trim() || undefined, media: seedMedia.map(saveRef), scenes: seedScenes.map(saveRef) }))
        id = draftId
        if (seeded) {
          // Our seed images went into the create → consume them so they aren't
          // re-saved as chunks below, and mark them done.
          if (seedScenes.length) { scenes.splice(0, seedScenes.length); setSavedSceneUrls((prev) => new Set([...prev, ...seedScenes])) }
          if (seedMedia.length) { media.splice(0, seedMedia.length); setSavedMediaUrls((prev) => new Set([...prev, ...seedMedia])) }
          savedRef.current = true
          done += seedMedia.length + seedScenes.length
          if (total) setSaveProgress({ done, total })
        } else if (name && !isAppend) {
          // A concurrent saver created the draft WITHOUT our seed/name — keep the
          // seed images in the arrays (saved as chunks below) and apply the name.
          await charactersApi.update(id, { name })
        }
      } else if (name && !isAppend) {
        await charactersApi.update(id, { name })
      }
      // Remaining images go up as bounded-concurrent chunks (SAVE_CONCURRENCY in
      // flight) instead of strictly one after another — the row lock keeps the
      // appends correct and most requests are near-instant URL saves now.
      const cid = id
      const chunks = [...chunkForSave('scenes', scenes), ...chunkForSave('media', media)]
      await runPool(chunks, SAVE_CONCURRENCY, async (chunk) => {
        const payload = chunk.items.map(saveRef)
        await charactersApi.addMedia(cid, chunk.kind === 'scenes' ? { scenes: payload } : { media: payload })
        savedRef.current = true
        if (chunk.kind === 'scenes') setSavedSceneUrls((prev) => new Set([...prev, ...chunk.items]))
        else setSavedMediaUrls((prev) => new Set([...prev, ...chunk.items]))
        done += chunk.items.length
        setSaveProgress({ done, total })
      })
      return true
    } finally {
      setSaveProgress(null)
    }
  }

  // Per-scene "save now": lands the single scene image on the session's
  // character (create a draft on first use), without closing the wizard.
  async function handleSaveScene(url: string) {
    if (savedSceneUrls.has(url) || savingScene) return
    setSavingScene(url)
    try {
      // ensureDraft seeds this image into the create when it's the one creating
      // the row; otherwise (draft already exists / a concurrent save made it) we
      // append via add-media. Prevents two rows when saves race (see ensureDraft).
      const { seeded, id } = await ensureDraft(() => ({ name: '', source_image: faceSwapCharacterImage ? saveRef(faceSwapCharacterImage) : undefined, face_prompt: faceSwapFacePrompt.trim() || undefined, nation: faceNation.trim() || undefined, scenes: [saveRef(url)] }))
      if (!seeded) await charactersApi.addMedia(id, { scenes: [saveRef(url)] })
      savedRef.current = true
      setSavedSceneUrls((prev) => new Set(prev).add(url))
      qc.invalidateQueries({ queryKey: ['characters'] })
      showToast('Đã lưu ảnh vào nhân vật.', 'success')
    } catch (err) {
      const message = err instanceof Error ? err.message : t('content.faceSwap.saveFailed')
      showToast(message, 'error')
    } finally {
      setSavingScene(null)
    }
  }

  // ── "Tạo Media" tab — generate non-person images with GPT ─────────────────
  // Fill the prompt box with a random preset (quick variety for filler images).
  function handleRandomMedia() {
    const pick = MEDIA_PRESETS[Math.floor(Math.random() * MEDIA_PRESETS.length)]
    setMediaPrompt(pick.prompt)
  }

  async function handleGenerateMedia() {
    const prompt = mediaPrompt.trim()
    if (!prompt || mediaGenerating) return
    setMediaGenerating(true)
    setFaceSwapError('')
    try {
      // Text-to-image thuần (không đính ảnh mặt) — đây là cảnh vật/đồ vật, không
      // phải nhân vật. Nối MEDIA_CAMERA để ra ảnh chụp bằng điện thoại chứ không
      // phải ảnh stock, và để chặn người/chữ lọt vào khung (xem MEDIA_PRESETS để
      // biết vì sao bỏ đuôi "photorealistic, ultra detailed" cũ).
      const full = `${prompt}\n\n${MEDIA_CAMERA}`
      // Generate `mediaCount` images in parallel; keep whatever succeeds.
      // Khung DỌC (SCENE_IMAGE_SIZE) — trước đây chỗ này bỏ trống `size` nên backend
      // rơi về mặc định 1024x1024 và mọi ảnh "Tạo Media" đều VUÔNG. Ảnh vuông là tỉ
      // lệ tệ nhất cho Facebook: khung xem ảnh nằm ngang nên ảnh vuông chạm trần
      // chiều cao rồi dừng, để lại hai dải đen. Dọc 1024x1536 còn nhiều hơn 57% điểm
      // ảnh mà KHÔNG tốn thêm tiền (OpenAI tính theo `quality`, không theo `size`).
      const results = await Promise.allSettled(
        Array.from({ length: mediaCount }, () => genImage(
          full, undefined, undefined, true, undefined, undefined, SCENE_IMAGE_SIZE,
        )),
      )
      const images = results
        .filter((r): r is PromiseFulfilledResult<{ image: string }> => r.status === 'fulfilled')
        .map((r) => r.value.image)
      if (images.length === 0) {
        const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
        throw rejected?.reason instanceof Error ? rejected.reason : new Error(t('content.faceSwap.generateFailed'))
      }
      setMediaImages((prev) => [...images, ...prev])
      if (images.length < mediaCount) {
        showToast(`Đã tạo ${images.length}/${mediaCount} ảnh (một số ảnh lỗi).`, 'info')
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : t('content.faceSwap.generateFailed')
      setFaceSwapError(message)
      showToast(message, 'error')
    } finally {
      setMediaGenerating(false)
    }
  }

  // Save a generated media image into the character's `media` (so it counts
  // toward media_count and is postable), creating a draft on first use.
  // `silent` skips the per-image toast/refetch — used by the "save all" callers
  // below so saving N images triggers one refetch instead of N (each refetch is
  // an immediate network call since CharactersPage never unmounts behind the
  // wizard, so doing it per-image turns a bulk save into a request storm).
  // Returns true only when the image was actually saved (false if skipped by the
  // in-flight guard or the save errored) so "save all" can count real successes.
  async function handleSaveMedia(url: string, opts?: { silent?: boolean }): Promise<boolean> {
    if (savedMediaUrls.has(url) || savingMedia) return false
    setSavingMedia(url)
    try {
      // ensureDraft prevents a duplicate character when saves race (see ensureDraft).
      const { seeded, id } = await ensureDraft(() => ({
        name: '',
        source_image: faceSwapCharacterImage ? saveRef(faceSwapCharacterImage) : undefined,
        face_prompt: faceSwapFacePrompt.trim() || undefined,
        nation: faceNation.trim() || undefined,
        media: [saveRef(url)],
      }))
      if (!seeded) await charactersApi.addMedia(id, { media: [saveRef(url)] })
      savedRef.current = true
      setSavedMediaUrls((prev) => new Set(prev).add(url))
      if (!opts?.silent) {
        qc.invalidateQueries({ queryKey: ['characters'] })
        showToast('Đã lưu ảnh vào nhân vật.', 'success')
      }
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : t('content.faceSwap.saveFailed')
      showToast(message, 'error')
      return false
    } finally {
      setSavingMedia(null)
    }
  }

  async function handleSaveAllMedia() {
    let count = 0
    for (const url of mediaImages) {
      if (!savedMediaUrls.has(url) && await handleSaveMedia(url, { silent: true })) count++
    }
    if (count > 0) {
      qc.invalidateQueries({ queryKey: ['characters'] })
      showToast(`Đã lưu ${count} ảnh vào nhân vật.`, 'success')
    }
  }

  // Upload a local image file and save it straight into the character's media —
  // same validation (extension/size) as the face-swap "Upload mode" tab, reusing
  // handleSaveMedia so a draft character is created on first use just like every
  // other media source (generated / Pexels).
  async function handleUploadLocalMedia(file: File | null) {
    if (!file || uploadingLocalMedia) return
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
      showToast('Định dạng ảnh không được hỗ trợ (chỉ jpg, jpeg, png, webp).', 'error')
      return
    }
    if (file.size > MAX_FACE_SWAP_IMAGE_BYTES) {
      showToast('Ảnh quá lớn (tối đa 15MB).', 'error')
      return
    }
    setUploadingLocalMedia(true)
    try {
      // Shrink the photo in the browser first (phone shots can be 4000px/15MB) so
      // the upload payload is small; the BE downscales too but this cuts the wire.
      const dataUri = await fileToDownscaledDataUri(file)
      await handleSaveMedia(dataUri)
    } catch (err) {
      const message = err instanceof Error ? err.message : t('content.faceSwap.saveFailed')
      showToast(message, 'error')
    } finally {
      setUploadingLocalMedia(false)
    }
  }

  // Step-1: use a local photo AS the character instead of AI-generating one. The
  // uploaded image becomes the identity-lock reference for every "Người" scene
  // (buildScenePrompt via images.edit), exactly like an AI-generated character.
  async function handleUploadCharacter(file: File | null) {
    if (!file || faceSwapLoading) return
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
      showToast('Định dạng ảnh không được hỗ trợ (chỉ jpg, jpeg, png, webp).', 'error')
      return
    }
    if (file.size > MAX_FACE_SWAP_IMAGE_BYTES) {
      showToast('Ảnh quá lớn (tối đa 15MB).', 'error')
      return
    }
    setFaceSwapLoading(true)
    setFaceSwapError('')
    try {
      const dataUri = await fileToDownscaledDataUri(file)
      setFaceSwapCharacterImage(dataUri)
    } catch (err) {
      const message = err instanceof Error ? err.message : t('content.faceSwap.genFailed')
      showToast(message, 'error')
    } finally {
      setFaceSwapLoading(false)
    }
  }

  // Edit-mode results are standalone images → save into the character's media,
  // reusing the same per-image saver as the "Tạo Media" tab.
  async function handleSaveAllEdited() {
    let count = 0
    for (const url of faceSwapResults) {
      if (!savedMediaUrls.has(url) && await handleSaveMedia(url, { silent: true })) count++
    }
    if (count > 0) {
      qc.invalidateQueries({ queryKey: ['characters'] })
      showToast(`Đã lưu ${count} ảnh vào nhân vật.`, 'success')
    }
  }

  async function handleClose() {
    // A save is already in flight (explicit save or a previous close click) —
    // closing now would silently drop its outcome, so ask first.
    if (saveCharLoading) {
      if (window.confirm(t('content.faceSwap.closeWhileSaving'))) {
        revokeIfSet(faceSwapSourcePreview)
        onClose()
      }
      return
    }
    // Auto-save unsaved work as a draft (create: un-named; append: append) so
    // nothing is lost if the user closes without an explicit save. persist()
    // skips everything already saved, so re-running it never duplicates.
    try {
      setSaveCharLoading(true)
      const saved = await persist('')
      if (saved) showToast(isAppend ? t('content.faceSwap.imagesAdded') : t('content.faceSwap.characterSaved'), 'success')
      // Refresh the characters list whenever this session persisted anything —
      // also for earlier per-image saves — so the character shows up right
      // away instead of only after a page reload.
      if (saved || savedRef.current) onSaved()
    } catch {
      // Auto-save failed: give the user the choice to stay and retry
      // (finished batches are kept) instead of silently losing the images.
      if (!window.confirm(t('content.faceSwap.closeSaveFailed'))) return
    } finally {
      setSaveCharLoading(false)
    }
    revokeIfSet(faceSwapSourcePreview)
    onClose()
  }

  function handleFaceSwapSourceChange(file: File | null) {
    setFaceSwapError('')
    setFaceSwapSource(file)
    setFaceSwapSourcePreview((prev) => { revokeIfSet(prev); return file ? URL.createObjectURL(file) : null })
    // Data URI needed for the inpaint canvas (display + OCR/remove-text API).
    if (file) fileToDataUri(file).then(setFaceSwapSourceData).catch(() => setFaceSwapSourceData(null))
    else setFaceSwapSourceData(null)
  }

  // Replace a row's text (programmatic: preset / regenerate) and record its
  // topic + regen count, clearing any stale generated image for that row.
  // `promptEn` (when given) is the English pre-translation of `text` from
  // scene_to_prompt — cached in sceneEnMapRef (keyed by the Vietnamese text) so
  // generation can send English and skip the per-image translate. Keyed by text,
  // so a manual edit naturally misses the cache and falls back to translating.
  function applyScene(index: number, text: string, topic: string | null, regen: number, promptEn?: string) {
    setFaceSwapError('')
    if (promptEn) sceneEnMapRef.current.set(text, promptEn)
    setFaceSwapDailyPrompts((prev) => prev.map((p, i) => (i === index ? text : p)))
    setFaceSwapSceneImages((prev) => prev.map((img, i) => (i === index ? null : img)))
    setFaceSwapSceneMeta((prev) => prev.map((m, i) => (i === index ? { ...m, topic, regen } : m)))
  }

  function updateDailyPrompt(index: number, value: string) {
    setFaceSwapError('')
    setFaceSwapDailyPrompts((prev) => prev.map((p, i) => (i === index ? value : p)))
    setFaceSwapSceneImages((prev) => prev.map((img, i) => (i === index ? null : img)))
    // Manual edit detaches the row from its preset topic and resets the counter.
    setFaceSwapSceneMeta((prev) => prev.map((m, i) => (i === index ? { ...m, topic: null, regen: 0 } : m)))
  }

  function addDailyPrompt() {
    if (faceSwapDailyPrompts.length >= MAX_FACE_SWAP_DAILY_PROMPTS) return
    setFaceSwapDailyPrompts((prev) => [...prev, ''])
    setFaceSwapSceneImages((prev) => [...prev, null])
    setFaceSwapSceneMeta((prev) => [...prev, { topic: null, regen: 0, kind: 'person', headAngle: randomHeadAngle() }])
  }

  // Let the user pick whether a self-typed row is a PERSON shot (the character in
  // the scene, generated from the reference face), a SCENERY shot (just the place,
  // no person), or a REAL-REF shot (upload a real photo → keep its pose/scene but
  // give a different face + outfit). Changing the kind clears any already-generated
  // image for the row since it no longer matches. `headAngle` is person-only, so
  // drop it when switching to scenery/realref — and roll a fresh one switching back
  // TO 'person' if the row never had one (e.g. it started as scenery/realref).
  function setDailyKind(index: number, kind: 'person' | 'scenery' | 'realref') {
    setFaceSwapSceneMeta((prev) => prev.map((m, i) => (
      i === index ? { ...m, kind, headAngle: kind === 'person' ? (m.headAngle ?? randomHeadAngle()) : undefined } : m
    )))
    setFaceSwapSceneImages((prev) => prev.map((img, i) => (i === index ? null : img)))
  }

  // Attach / clear the real reference photo for a realref row. The photo is
  // downscaled in-browser and kept only in FE state (meta.refImage) — it is sent
  // as the images.edit reference at generation time but is NEVER persisted to the
  // character's media (it's someone's real photo → avoid storing PII; only the
  // AI-generated, de-identified result gets saved).
  async function setRefImage(index: number, file: File | null) {
    if (!file) return
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
      showToast('Định dạng ảnh không được hỗ trợ (chỉ jpg, jpeg, png, webp).', 'error')
      return
    }
    if (file.size > MAX_FACE_SWAP_IMAGE_BYTES) {
      showToast('Ảnh quá lớn (tối đa 15MB).', 'error')
      return
    }
    try {
      const dataUri = await fileToDownscaledDataUri(file)
      setFaceSwapSceneMeta((prev) => prev.map((m, i) => (i === index ? { ...m, refImage: dataUri } : m)))
      setFaceSwapSceneImages((prev) => prev.map((img, i) => (i === index ? null : img)))
    } catch (err) {
      const message = err instanceof Error ? err.message : t('content.faceSwap.genFailed')
      showToast(message, 'error')
    }
  }

  // Realref only: copy image 1's outfit instead of asking for a different one.
  function setKeepOutfit(index: number, keepOutfit: boolean) {
    setFaceSwapSceneMeta((prev) => prev.map((m, i) => (i === index ? { ...m, keepOutfit } : m)))
    setFaceSwapSceneImages((prev) => prev.map((img, i) => (i === index ? null : img)))
  }

  function removeDailyPrompt(index: number) {
    if (faceSwapDailyPrompts.length <= 1) return
    setFaceSwapDailyPrompts((prev) => prev.filter((_, i) => i !== index))
    setFaceSwapSceneImages((prev) => prev.filter((_, i) => i !== index))
    setFaceSwapSceneMeta((prev) => prev.filter((_, i) => i !== index))
  }

  // Pick a random variant for a topic; if `avoid` is given, prefer a different
  // one so "Tạo lại" actually changes the scene.
  function pickSceneVariant(key: string, avoid?: string): string {
    const topic = FACE_SWAP_SCENES.find((s) => s.key === key)
    if (!topic) return ''
    const pool = avoid ? topic.variants.filter((v) => v !== avoid) : topic.variants
    const list = pool.length ? pool : topic.variants
    return list[Math.floor(Math.random() * list.length)]
  }

  // AI-write a seeded preset row — AI prompts are the DEFAULT: adding a chip
  // seeds its person rows with a curated variant (instant placeholder, row shows
  // a spinner) and immediately calls the LLM for the real, fresh,
  // nation-localised scene (~2-4s). The curated pool (3 fixed variants per
  // topic) is only the fallback when the call fails — leaning on it made
  // repeated generations repetitive. Guarded by the seed TEXT, not the index:
  // if the user already edited, regenerated or removed the row, the seed is
  // gone and the result is dropped.
  async function refreshSeededScene(seedText: string, topicKey: string) {
    const theme = FACE_SWAP_SCENE_THEMES[topicKey]
    if (!theme) return
    setPendingSeeds((prev) => [...prev, seedText])
    try {
      const { prompt, prompt_en } = await contentsApi.sceneToPrompt(theme, faceNation.trim() || undefined, faceSwapFacePrompt.trim() || undefined)
      const fresh = (prompt || '').trim()
      if (!fresh) return
      // Cache the English pre-translation (keyed by the fresh Vietnamese text) so
      // generation sends English and skips its per-image translate call.
      if (prompt_en) sceneEnMapRef.current.set(fresh, prompt_en)
      setFaceSwapDailyPrompts((prev) => {
        const idx = prev.indexOf(seedText)
        return idx === -1 ? prev : prev.map((p, i) => (i === idx ? fresh : p))
      })
    } catch {
      // keep the curated seed — the row still works, just less varied
    } finally {
      setPendingSeeds((prev) => {
        const idx = prev.indexOf(seedText)
        return idx === -1 ? prev : prev.filter((_, i) => i !== idx)
      })
    }
  }

  // One scene chip = 3 prompt rows that generate 3 images for that scene:
  // two person shots (different scene variant + different face angle) and one
  // scenery-only shot (the place itself, no person).
  function addPresetScene(key: string) {
    setFaceSwapError('')
    const v1 = pickSceneVariant(key)
    if (!v1) return
    const v2 = pickSceneVariant(key, v1)
    const a1 = FACE_SWAP_HEAD_ANGLES[Math.floor(Math.random() * FACE_SWAP_HEAD_ANGLES.length)]
    let a2 = FACE_SWAP_HEAD_ANGLES[Math.floor(Math.random() * FACE_SWAP_HEAD_ANGLES.length)]
    if (a2 === a1) a2 = FACE_SWAP_HEAD_ANGLES[(FACE_SWAP_HEAD_ANGLES.indexOf(a1) + 1) % FACE_SWAP_HEAD_ANGLES.length]
    const group: { text: string; meta: SceneMeta }[] = [
      { text: v1, meta: { topic: key, regen: 0, kind: 'person', headAngle: a1 } },
      { text: v2, meta: { topic: key, regen: 0, kind: 'person', headAngle: a2 } },
      { text: sceneryRowText(key), meta: { topic: key, regen: 0, kind: 'scenery' } },
    ]
    // Drop a single leading blank placeholder row, then append within the cap.
    const isPlaceholder = faceSwapDailyPrompts.length === 1 && !faceSwapDailyPrompts[0].trim()
    const baseLen = isPlaceholder ? 0 : faceSwapDailyPrompts.length
    const add = group.slice(0, Math.max(0, MAX_FACE_SWAP_DAILY_PROMPTS - baseLen))
    if (add.length === 0) return
    setFaceSwapDailyPrompts((prev) => [...(isPlaceholder ? [] : prev), ...add.map((r) => r.text)])
    setFaceSwapSceneImages((prev) => [...(isPlaceholder ? [] : prev), ...add.map(() => null)])
    setFaceSwapSceneMeta((prev) => [...(isPlaceholder ? [] : prev), ...add.map((r) => r.meta)])
    // Fire-and-forget: swap the curated person seeds for fresh AI scenes.
    for (const row of add) {
      if (row.meta.kind === 'person') void refreshSeededScene(row.text, key)
    }
  }

  // "Tạo lại": give this row a fresh scene. First few presses cycle the curated
  // local variants (instant); after SCENE_REGEN_LOCAL_LIMIT presses we call the
  // LLM scene generator for unlimited variety. Works on preset rows; for a
  // manually-typed row the current text is used as the LLM theme.
  async function regenerateScenePrompt(index: number) {
    const cur = faceSwapDailyPrompts[index] ?? ''
    const meta = faceSwapSceneMeta[index] ?? { topic: null, regen: 0, kind: 'person' as const }
    const topicKey = meta.topic ?? FACE_SWAP_SCENES.find((s) => s.variants.includes(cur))?.key ?? null
    const nextRegen = meta.regen + 1

    // Scenery rows carry a fixed place description per topic — just re-apply it.
    if (meta.kind === 'scenery') {
      if (topicKey) applyScene(index, sceneryRowText(topicKey), topicKey, nextRegen)
      return
    }

    if (topicKey && nextRegen <= SCENE_REGEN_LOCAL_LIMIT) {
      applyScene(index, pickSceneVariant(topicKey, cur), topicKey, nextRegen)
      return
    }

    const theme = (topicKey && FACE_SWAP_SCENE_THEMES[topicKey]) || cur.trim()
    if (!theme) return
    setFaceSwapError('')
    setFaceSwapPromptBusy(index)
    try {
      const { prompt, prompt_en } = await contentsApi.sceneToPrompt(theme, faceNation.trim() || undefined, faceSwapFacePrompt.trim() || undefined)
      applyScene(index, prompt, topicKey, nextRegen, prompt_en)
    } catch (error) {
      const message = error instanceof Error ? error.message : t('content.faceSwap.genFailed')
      setFaceSwapError(message)
      showToast(message, 'error')
    } finally {
      setFaceSwapPromptBusy(null)
    }
  }

  async function handleTopicToPrompt() {
    const nation = faceNation.trim()
    if (!nation || topicLoading) return  // guard: tránh gọi chồng khi đang tạo
    setFaceSwapError('')
    setTopicLoading(true)
    try {
      const { prompt, prompt_en } = await contentsApi.topicToPrompt(nation)
      // Cache the English identity so a person scene can be assembled fully in
      // English and skip the per-image translate (keyed by the VI text; a manual
      // edit of the face prompt misses the cache → falls back to translating).
      if (prompt_en) sceneEnMapRef.current.set(prompt, prompt_en)
      setFaceSwapFacePrompt(prompt)
    } catch (error) {
      const message = error instanceof Error ? error.message : t('content.faceSwap.genFailed')
      setFaceSwapError(message)
      showToast(message, 'error')
    } finally {
      setTopicLoading(false)
    }
  }

  async function handleGenerateCharacter() {
    const promptVi = faceSwapFacePrompt.trim()
    const ref = faceSwapCharacterImage
    // Need SOMETHING to work from: a text description or a reference photo.
    if (!promptVi && !ref) { setFaceSwapError(t('content.faceSwap.facePromptRequired')); return }
    setFaceSwapError('')
    setFaceSwapLoading(true)
    try {
      // Use the English pre-translation of the face description when available so
      // the character prompt stays all-English and skips the backend translate.
      const custom = promptVi ? (sceneEnMapRef.current.get(promptVi) ?? promptVi) : ''
      let image: string
      if (ref) {
        // A photo is present (uploaded, or a previous character shot): use it as the
        // images.edit reference and recreate the SAME person as a clean front-facing
        // portrait — keep her exact identity, just clean up pose/lighting/framing so
        // it works as the swap source. The typed description (if any) is kept but
        // subordinated to the reference so it can't drift the face to someone else.
        const person = `This is the SAME woman as in the reference image — keep her EXACT same face, facial features, hair and skin tone, do not change her identity. Recreate her as a clean, natural, well-lit front-facing portrait.${custom ? ` ${custom}` : ''}`
        // Khung dọc (SCENE_IMAGE_SIZE) thay cho mặc định vuông: đây là ảnh CHÂN DUNG và còn
        // là ảnh tham chiếu khoá mặt cho mọi ảnh cảnh sau đó, nên càng nhiều điểm ảnh trên
        // khuôn mặt càng tốt — mà không tốn thêm chi phí.
        ;({ image } = await genImage(
          `${person}\n\n${FACE_SWAP_FRONT}\n\n${FACE_SWAP_CAMERA_REAL}`, ref,
          undefined, true, undefined, undefined, SCENE_IMAGE_SIZE,
        ))
      } else {
        // No photo yet → text-to-image from the description. The character reference
        // must be front-facing (clean swap source); the style lock keeps it looking
        // like a real phone photo, not AI-glossy.
        ;({ image } = await genImage(
          `${custom}\n\n${FACE_SWAP_FRONT}\n\n${FACE_SWAP_CAMERA_REAL}`, undefined,
          undefined, true, undefined, undefined, SCENE_IMAGE_SIZE,
        ))
      }
      setFaceSwapCharacterImage(image)
    } catch (error) {
      const message = error instanceof Error ? error.message : t('content.faceSwap.genFailed')
      setFaceSwapError(message)
      showToast(message, 'error')
    } finally {
      setFaceSwapLoading(false)
    }
  }

  function goToScenesStep() {
    if (!faceSwapCharacterImage) { setFaceSwapError(t('content.faceSwap.characterRequired')); return }
    setFaceSwapError('')
    setFaceSwapStep('scenes')
  }

  // Scene images reuse the character description from step 1 so the person in
  // every scene matches the character before face-swap (e.g. character prompt
  // "cô gái 20 tuổi tóc vàng" → each scene is that same girl + the setting).
  // Falls back to the generic person only if step 1 was left blank.
  // `scene` is the text that goes INTO the prompt (English when a pre-translation
  // exists). `cueText` is the row's ORIGINAL Vietnamese — every cue regex below is
  // written in Vietnamese, so testing them against the translation matched nothing
  // and quietly dropped a random framing + head angle on top of what the user had
  // already specified. That is what turned a pickleball scene into a selfie.
  // `isPreset` marks a preset / AI-written row: those get the mood jitter, a
  // hand-typed row is taken at its word.
  function buildScenePrompt(
    scene: string,
    { headAngle: headAngleOverride, cueText, isPreset = false }:
      { headAngle?: string; cueText?: string; isPreset?: boolean } = {},
  ): string {
    const cue = cueText ?? scene
    // Identity lock: a person scene is generated via images.edit WITH the step-1
    // character image as the reference, so the face/hair/skin come from the PIXELS.
    // One anchor sentence pointing at that image is the whole mechanism — the
    // step-1 description is NOT appended on top of it.
    //
    // Đưa cả mô tả nhân vật (bước 1) vào đây vừa thừa vừa hại:
    //  1) Nó dựng ra một "bản sao bằng chữ" của nhân vật để model phải hoà giải với
    //     ảnh gốc — đúng cái đã làm mặt trôi giữa các cảnh (câu neo mới là thứ sửa
    //     được, không phải khối mô tả). Khối tả mặt còn đè bẹp các chỉ thị cỡ cảnh /
    //     góc mặt / biểu cảm ngay bên dưới (xem ghi chú "quay lưng").
    //  2) Prompt AI viết ra dài ~2.200 ký tự → tổng prompt cảnh vượt trần độ dài mà
    //     backend đặt (MAX_PROMPT_LEN), và người dùng nhận lỗi "vượt quá N ký tự"
    //     trong khi ô nhập cảnh của họ chỉ vài trăm chữ.
    // Luồng mới (Tạo ảnh nhanh, buildQuickScenePrompt) cũng chỉ gửi đúng câu neo.
    // Không có ảnh tham chiếu thì mô tả bước 1 là nguồn duy nhất → vẫn dùng.
    // Prefer the English pre-translation of the face identity (cached at
    // topic_to_prompt time) so the assembled person prompt stays all-English and
    // the backend skips its per-image translate; fall back to the VI text.
    const customVi = faceSwapFacePrompt.trim()
    const custom = customVi ? (sceneEnMapRef.current.get(customVi) ?? customVi) : ''
    // Góc quay TOÀN CỤC (camShot/camAngle/camHead — 3 dropdown "Cỡ cảnh/Góc máy/Góc khuôn mặt"
    // phía trên, áp cho MỌI dòng) — giờ CHỈ áp cho dòng PRESET. Dòng đã tự gõ tay thường đã tả
    // sẵn góc máy/cỡ cảnh/hướng nhìn ngay trong câu chữ đó rồi (gần đủ hết những gì 3 ô này
    // làm) — gửi kèm thêm 3 câu global đè lên chỉ làm LOÃNG prompt, có khi đá nhau với đúng
    // cái người dùng vừa gõ. Cùng lý do headAngleOverride/random bên dưới cũng gate theo
    // isPreset. Các cơ chế tự phát hiện từ CHÍNH câu chữ từng dòng (SCENE_WANTS_FULL_BODY/
    // SCENE_HAS_OWN_FRAMING/SCENE_HAS_OWN_GAZE) thì KHÔNG đụng — vẫn áp cho cả 2 loại dòng như
    // cũ vì đó là đọc thẳng nội dung dòng đó, không phải giá trị dropdown toàn cục.
    //
    // Góc "sau lưng": câu khoá mặt ("keep her EXACT same face") sẽ đè bẹp một câu
    // "seen from behind" lẻ loi — model nghe theo số đông và vẫn vẽ ra mặt. Nên khi
    // quay lưng phải bỏ hẳn câu khoá mặt và nói thẳng là KHÔNG thấy mặt.
    const backView = isPreset && isBackView(camHead)
    const person = faceSwapCharacterImage
      ? (backView
          ? 'This is the SAME woman as in the reference image — same hair, hairstyle, build and skin tone. In THIS photo she is turned away from the camera, so her face is NOT visible at all: the picture shows her from behind.'
          : 'This is the SAME woman as in the reference image — keep her EXACT same face, facial features, hair and skin tone, do not change her identity. It is the same person in every photo; only the setting, outfit and pose change.')
      : (custom || FACE_SWAP_PERSON)
    // Head/gaze angle: the per-row override wins (that is how the two person shots
    // of one preset scene are made to differ). Otherwise fill the gap with a random
    // one — but ONLY when the scene has not already said where she is looking.
    // Injecting one regardless used to override "ánh mắt nhìn sang một bên" with,
    // among others, "a casual self-taken selfie" — an avatar instead of a scene.
    // Người dùng chọn góc khuôn mặt ở dropdown → thắng cả override lẫn random (CHỈ khi preset).
    //
    // headAngleOverride/random CHỈ áp cho row PRESET (isPreset). Trước đây áp cho MỌI row —
    // kể cả row người dùng đã tự gõ tay đè lên (updateDailyPrompt() chỉ xoá `topic`, không
    // xoá `meta.headAngle` đã gán ngẫu nhiên từ lúc row được TẠO) — nên `headAngleOverride ||`
    // đứng trước SCENE_HAS_OWN_GAZE luôn thắng, làm góc mặt tự gõ tay ("quay đầu sang trái…")
    // bị đè bởi góc random đông cứng từ lúc tạo row, dù cue có nhắc góc mặt hay không (bug
    // thật: khách gõ tay đổi góc mặt vẫn ra đúng góc cũ). Row tự gõ tay giờ tin tưởng HOÀN
    // TOÀN nội dung người dùng gõ — không tự chèn gì thêm; chỉ row preset chưa bị sửa mới
    // theo override/random cố định của hệ thống.
    const headAngle = (isPreset && camHead && `She is ${camHead}.`)
      || (!isPreset ? '' : headAngleOverride || (SCENE_HAS_OWN_GAZE.test(cue)
        ? ''
        : FACE_SWAP_HEAD_ANGLES[Math.floor(Math.random() * FACE_SWAP_HEAD_ANGLES.length)]))
    const expression = FACE_SWAP_EXPRESSIONS[Math.floor(Math.random() * FACE_SWAP_EXPRESSIONS.length)]
    // Shot distance: only ADD a framing clause when it won't fight the scene.
    //  1) scene asks for full body / shoes  → force a whole-body framing (so the
    //     shoes/outfit are never cropped to the waist);
    //  2) scene already states its own framing → trust it, add nothing (appending
    //     a second, contradictory framing was the bug);
    //  3) scene has no framing of its own → add a random one for variety so short
    //     typed rows don't always crop in on the face.
    // Cỡ cảnh chọn tay thì thắng cả 3 nhánh — nhưng CHỈ khi preset, lý do xem ghi chú
    // "Góc quay TOÀN CỤC" ở trên.
    let framing = ''
    if (isPreset && camShot) {
      framing = `The photo is ${camShot}.`
    } else if (SCENE_WANTS_FULL_BODY.test(cue)) {
      framing = FACE_SWAP_FULL_BODY_FRAMINGS[Math.floor(Math.random() * FACE_SWAP_FULL_BODY_FRAMINGS.length)]
    } else if (!SCENE_HAS_OWN_FRAMING.test(cue)) {
      framing = FACE_SWAP_FRAMINGS[Math.floor(Math.random() * FACE_SWAP_FRAMINGS.length)]
    }
    // Góc máy không có sẵn trong luồng cũ (chỉ có cỡ cảnh + góc mặt) → thêm mới. CHỈ áp cho
    // preset, cùng lý do camShot/camHead ở trên.
    const angleClause = isPreset && camAngle ? `The photo is ${camAngle}.` : ''
    // A PRESET row's mood is baked in by the scene writer and is the same across
    // both variants of a scene, so strip it and let the random pick supply the
    // only facial-expression cue — that is what keeps the two shots from looking
    // identical. A HAND-TYPED row means it: keep the mood the user wrote and skip
    // the random one entirely, or we overwrite the very thing they asked for.
    const keepOwnExpression = !isPreset && SCENE_HAS_OWN_EXPRESSION.test(cue)
    // Also strip any "no people / không có người" cue: this is a PERSON shot, so
    // such a clause (often left over from scenery text) must not suppress her.
    let cleanScene = scene.trim()
    if (!keepOwnExpression) {
      cleanScene = cleanScene.replace(/,\s*[^,.]*(expressions?|biểu cảm|nét mặt|vẻ mặt|gương mặt)[^,.]*/gi, '')
    }
    cleanScene = cleanScene.replace(NO_PEOPLE_CUE, '').trim()
    // Framing, head angle and expression are each omitted when the scene already
    // states its own, so join only the parts that survived instead of stitching in
    // stray blanks.
    const directives = [framing, angleClause, headAngle,
      keepOwnExpression ? '' : `Her facial expression is ${expression}.`]
      .filter(Boolean).join(' ')
    // Explicit presence line so the woman is always in frame even if the scene text
    // reads as a place-only description (the toggle must win over the wording).
    return `${person}\n\nThe young woman is clearly present and visible in the photo.\n\n${cleanScene}\n\n${directives}\n\n${FACE_SWAP_CAMERA_REAL}\n\n${NO_TEXT}`
  }

  // Scenery-only prompt: no character reference, no person — just the place of
  // the scene (beach → a beach photo, cafe → a cafe-corner photo). Ground it in
  // the character's country so a scenery shot localises like the person shots do
  // (without this a scenery row rendered whatever country was baked into the
  // preset text, regardless of who the character is).
  function buildSceneryPrompt(scene: string): string {
    const nation = faceNation.trim()
    const place = nation ? ` ở ${nation}` : ''
    // Frame the whole thing as PLACE-ONLY and explicitly override any person the
    // text might mention, so a "Cảnh" row whose wording describes a person still
    // renders an empty scene (the toggle must win over the wording).
    return `Ảnh chỉ chụp bối cảnh/địa điểm${place}, hoàn toàn KHÔNG có người nào trong khung — kể cả khi mô tả bên dưới có nhắc tới người thì cũng bỏ hẳn người đi. Bối cảnh: ${scene.trim()}\n\n${FACE_SWAP_SCENERY_STYLE}\n\n${IMPERFECT}\n\n${NO_TEXT}`
  }

  // Real-reference prompt: TWO images are sent — image 1 is the uploaded real
  // photo (source of pose/scene/composition), image 2 is the character (source of
  // the face/identity). Keep image 1's pose & scene, put the character's face on
  // it, and give her a DIFFERENT outfit. `note` is the user's optional tweak
  // (e.g. "đổi sang váy trắng"). OpenAI edit keeps pose only APPROXIMATELY.
  // `keepOutfit` decides the outfit clause instead of it being hardcoded. The old
  // prompt always demanded "a DIFFERENT outfit from image 1" and then appended the
  // user's note underneath — so a note asking to copy the outfit fought a sentence
  // the user could not see or remove.
  function buildRealRefPrompt(note: string, keepOutfit = false): string {
    const tweak = note.trim() ? `\n\n${note.trim()}` : ''
    const outfit = keepOutfit
      ? 'Keep the SAME outfit, clothing and accessories as in image 1.'
      : 'Give her a DIFFERENT outfit from image 1.'
    return `You are given TWO reference images. Image 1 is a real photo — keep its EXACT pose, body position, camera angle, framing, background and overall scene. Image 2 is the character — the woman in the result MUST have the SAME face, facial features, hair and skin tone as the woman in image 2 (replace the face and identity from image 1 with hers, keep it clearly recognisable as her). ${outfit} Only the pose and scene come from image 1; the face and identity come from image 2. Keep it a natural, photorealistic everyday photo.${tweak}\n\n${FACE_SWAP_CAMERA}`
  }

  async function handleGenerateScenes() {
    const targets = faceSwapDailyPrompts
      .map((p, i) => ({ prompt: p.trim(), index: i, meta: faceSwapSceneMeta[i] }))
      // A realref row generates from its uploaded photo, so its text note is
      // optional — keep it even when empty. Other rows still need a prompt.
      .filter((x) => x.prompt || x.meta?.kind === 'realref')
    if (targets.length === 0) { setFaceSwapError(t('content.faceSwap.dailyPromptRequired')); return }
    // Realref rows can't generate without their reference photo — block early with
    // a clear message instead of silently leaving those cells empty.
    if (targets.some((x) => x.meta?.kind === 'realref' && !x.meta?.refImage)) {
      setFaceSwapError(t('content.faceSwap.realRefRequired')); return
    }
    // Realref takes the FACE from the character image → it must exist.
    if (!faceSwapCharacterImage && targets.some((x) => x.meta?.kind === 'realref')) {
      setFaceSwapError(t('content.faceSwap.realRefNeedsCharacter')); return
    }
    setFaceSwapError('')
    setFaceSwapLoading(true)

    // Reflect each finished image as soon as it lands (progressive), and count
    // successes for the partial-failure toast below.
    let okCount = 0
    const applyImage = (index: number, image: string) => {
      okCount += 1
      setFaceSwapSceneImages((prev) => { const next = [...prev]; next[index] = image; return next })
    }

    // Every scene generates INDEPENDENTLY, all in parallel — no leader→follower
    // chaining. A person shot anchors on the character face (images.edit); a
    // scenery shot is text-only. Dropping the chain means no shot has to wait for
    // a "leader" of its scene to finish first, which roughly halves wall-time; the
    // trade-off is that person shots of the same scene no longer share one outfit.
    const genSingle = async (x: typeof targets[number]) => {
      // Prefer the pre-translated English scene (cached at add/regenerate time) so
      // the backend skips its per-image translate; fall back to the VI text.
      const sceneText = sceneEnMapRef.current.get(x.prompt) ?? x.prompt
      const { image } = x.meta?.kind === 'scenery'
        ? await genImage(buildSceneryPrompt(x.prompt), undefined, undefined, true, undefined, undefined, SCENE_IMAGE_SIZE)
        : x.meta?.kind === 'realref'
          // Real-photo row: send [real photo, character image] → keep the real
          // photo's pose/scene, put the character's face on it, different outfit.
          // Khung ảnh bám theo ẢNH GỐC, không ép SCENE_IMAGE_SIZE: ảnh thật có thể ngang.
          ? await genImage(
            buildRealRefPrompt(x.prompt, x.meta.keepOutfit), [x.meta.refImage!, faceSwapCharacterImage!],
            undefined, true, undefined, undefined, await closestOpenAISizeForSrc(x.meta.refImage!),
          )
          // x.prompt (Vietnamese) drives the cue regexes; sceneText (English when
          // pre-translated) is what actually goes into the prompt.
          : await genImage(
            buildScenePrompt(sceneText, { headAngle: x.meta?.headAngle, cueText: x.prompt, isPreset: x.meta?.topic != null }),
            faceSwapCharacterImage ?? undefined, undefined, true, undefined, undefined, SCENE_IMAGE_SIZE,
          )
      applyImage(x.index, image)
    }

    try {
      const results = await Promise.allSettled(targets.map((x) => genSingle(x)))
      if (okCount === 0) {
        const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
        throw rejected?.reason instanceof Error ? rejected.reason : new Error(t('content.faceSwap.genFailed'))
      }
      if (okCount < targets.length) showToast(`Đã tạo ${okCount}/${targets.length} ảnh (một số ảnh lỗi).`, 'info')
    } catch (error) {
      const message = error instanceof Error ? error.message : t('content.faceSwap.genFailed')
      setFaceSwapError(message)
      showToast(message, 'error')
    } finally {
      setFaceSwapLoading(false)
    }
  }

  async function handleRegenerateScene(index: number) {
    const meta = faceSwapSceneMeta[index]
    const prompt = faceSwapDailyPrompts[index]?.trim() ?? ''
    // Realref rows generate from their photo (note optional); others need a prompt.
    if (!prompt && meta?.kind !== 'realref') return
    if (meta?.kind === 'realref' && !meta?.refImage) {
      setFaceSwapError(t('content.faceSwap.realRefRequired')); return
    }
    if (meta?.kind === 'realref' && !faceSwapCharacterImage) {
      setFaceSwapError(t('content.faceSwap.realRefNeedsCharacter')); return
    }
    setFaceSwapError('')
    setFaceSwapSceneBusy(index)
    try {
      // Regenerate this one scene independently (person → character face, scenery
      // → text-only, realref → edit the real photo). No outfit-chaining now that
      // scenes are generated in parallel.
      const sceneText = sceneEnMapRef.current.get(prompt) ?? prompt
      const res = meta?.kind === 'scenery'
        ? await genImage(buildSceneryPrompt(prompt), undefined, undefined, true, undefined, undefined, SCENE_IMAGE_SIZE)
        : meta?.kind === 'realref'
          // Khung ảnh bám theo ẢNH GỐC, không ép SCENE_IMAGE_SIZE (xem handleGenerateScenes).
          ? await genImage(
            buildRealRefPrompt(prompt, meta.keepOutfit), [meta.refImage!, faceSwapCharacterImage!],
            undefined, true, undefined, undefined, await closestOpenAISizeForSrc(meta.refImage!),
          )
          : await genImage(
            buildScenePrompt(sceneText, { headAngle: meta?.headAngle, cueText: prompt, isPreset: meta?.topic != null }),
            faceSwapCharacterImage ?? undefined, undefined, true, undefined, undefined, SCENE_IMAGE_SIZE,
          )
      const image = res.image
      setFaceSwapSceneImages((prev) => prev.map((img, i) => (i === index ? image : img)))
    } catch (error) {
      const message = error instanceof Error ? error.message : t('content.faceSwap.genFailed')
      setFaceSwapError(message)
      showToast(message, 'error')
    } finally {
      setFaceSwapSceneBusy(null)
    }
  }

  async function handleSaveCharacter() {
    // Append mode adds to an existing character (no name needed); create mode
    // requires a name typed in the inline form.
    if (saveCharLoading) return // Enter in the name input while a save runs
    const name = saveCharName.trim()
    if (!isAppend && !name) return
    setFaceSwapError('')
    setSaveCharLoading(true)
    try {
      const saved = await persist(name)
      if (!saved) {
        setFaceSwapError(t('content.faceSwap.nothingToSave'))
        return
      }
      savedRef.current = true
      showToast(isAppend ? t('content.faceSwap.imagesAdded') : t('content.faceSwap.characterSaved'), 'success')
      setSaveCharOpen(false)
      setSaveCharName('')
      onSaved()
    } catch (error) {
      const message = error instanceof Error ? error.message : t('content.faceSwap.saveFailed')
      showToast(message, 'error')
    } finally {
      setSaveCharLoading(false)
    }
  }

  // Edit-image mode: send the uploaded original + the user's prompt to OpenAI
  // (images.edit via generateImage's reference param) and show the edited result.
  async function handleEditImage() {
    if (!faceSwapSource) { setFaceSwapError(t('content.faceSwap.editSourceRequired')); return }
    if (faceSwapSource.size > MAX_FACE_SWAP_IMAGE_BYTES) { setFaceSwapError(t('content.faceSwap.fileTooLarge')); return }
    const prompt = faceSwapTargetPrompt.trim()
    if (!prompt) { setFaceSwapError(t('content.faceSwap.editPromptRequired')); return }
    setFaceSwapError('')
    setFaceSwapLoading(true)
    try {
      const sourceDataUri = await fileToDataUri(faceSwapSource)
      // Keep the uploaded image as the character portrait (source_image) so the
      // saved character shows a thumbnail, mirroring the prompt flow.
      setFaceSwapCharacterImage(sourceDataUri)
      // no_fallback: an edit that fails (e.g. moderation) must surface the error,
      // not silently text-generate an unrelated image.
      // Về lại GPT (mặc định — không truyền provider): từng thử đổi qua Grok (lỏng
      // kiểm duyệt hơn với ảnh nhạy cảm) nhưng Grok cho ảnh ra bẹt/méo, kể cả khi đã
      // gửi đúng tỉ lệ ảnh gốc (xem closestOpenAISizeForFile) — revert lại GPT.
      // Vẫn giữ size khớp ảnh gốc: GPT images.edit cũng cần size hợp lệ, và khớp tỉ
      // lệ vẫn tốt hơn ép mặc định vuông dù dùng provider nào.
      const size = await closestOpenAISizeForFile(faceSwapSource)
      const { image } = await genImage(prompt, sourceDataUri, true, true, undefined, undefined, size)
      setFaceSwapResults([image])
      showToast(t('content.faceSwap.success'), 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : t('content.faceSwap.genFailed')
      setFaceSwapError(message)
      showToast(message, 'error')
    } finally {
      setFaceSwapLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-xl border border-border bg-card shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">
              {isAppend ? t('content.faceSwap.addImagesTitle') : t('content.faceSwap.title')}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {isAppend ? t('content.faceSwap.addImagesDesc') : t('content.faceSwap.description')}
            </p>
          </div>
          <button onClick={handleClose} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div ref={modalBodyRef} className="flex flex-col gap-4 overflow-auto p-5">
          {/* Responsible-use / privacy warning */}
          <div className="flex items-start gap-2.5 rounded-lg border border-red-300 bg-gradient-to-r from-red-50 via-rose-50 to-red-50 px-3 py-2.5 dark:border-red-500/40 dark:from-red-950/40 dark:via-rose-950/30 dark:to-red-950/30">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400" />
            <p className="text-xs leading-relaxed text-red-700/90 dark:text-red-200/80">
              <span className="font-semibold text-red-800 dark:text-red-300">⚠️ {t('characters.refWarningTitle')}. </span>
              {t('characters.refWarningBody')}
            </p>
          </div>

          {/* Mode selector — in add-more mode only "scenes" + "media" apply. */}
          <div className={`grid grid-cols-1 gap-2 ${isAppend ? 'sm:grid-cols-3' : 'sm:grid-cols-5'}`}>
            {(['prompt', 'edit', 'media', 'pinterest', 'faceswap'] as const).map((m) => {
              const label = m === 'media'
                ? 'Tạo Media'
                : m === 'pinterest'
                ? 'Kho ảnh Pinterest'
                : m === 'faceswap'
                ? 'Ghép mặt'
                : t(`content.faceSwap.mode_${m}`)
              const desc = m === 'media'
                ? 'Sinh ảnh thiên nhiên, đồ vật, con vật… bằng AI'
                : m === 'pinterest'
                ? 'Tìm kiếm và tải ảnh chất lượng cao từ Pexels'
                : m === 'faceswap'
                ? 'Ghép khuôn mặt (FaceFusion): nguồn + đích'
                : t(`content.faceSwap.mode_${m}_desc`)
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => { setFaceSwapMode(m); setFaceSwapResults([]); setFaceSwapError('') }}
                  className={`flex flex-col items-start gap-0.5 rounded-lg border p-3 text-left transition ${
                    faceSwapMode === m ? 'border-foreground bg-muted/40' : 'border-border hover:bg-muted/20'
                  }`}
                >
                  <span className="text-sm font-medium">{label}</span>
                  <span className="text-[11px] text-muted-foreground">{desc}</span>
                </button>
              )
            })}
          </div>

          {isAppend && loadingSource && (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t('content.faceSwap.loadingSource')}
            </div>
          )}

          {faceSwapMode === 'prompt' ? (
            <>
              {/* Step indicator */}
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {(['character', 'scenes'] as const).map((s, i) => (
                  <div key={s} className="flex items-center gap-2">
                    <span className={`flex size-5 items-center justify-center rounded-full text-[11px] font-semibold ${
                      faceSwapStep === s ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground'
                    }`}>{i + 1}</span>
                    <span className={faceSwapStep === s ? 'font-medium' : 'text-muted-foreground'}>
                      {t(`content.faceSwap.step_${s}`)}
                    </span>
                    {i < 1 && <span className="text-muted-foreground">→</span>}
                  </div>
                ))}
              </div>

              {/* Step 1 — Character */}
              {faceSwapStep === 'character' && (
                <>
                  {/* Quốc gia → AI prompt */}
                  <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/20 p-3">
                    <label className="text-sm font-medium">Quốc gia → tạo prompt bằng AI</label>
                    <div className="flex flex-wrap gap-1.5">
                      {['Việt Nam', 'Philippines', 'Thái Lan', 'Nhật Bản', 'Hàn Quốc'].map((c) => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => setFaceNation(c)}
                          disabled={topicLoading}
                          className={`rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-50 ${
                            faceNation.trim() === c
                              ? 'border-primary bg-primary/10 text-primary'
                              : 'border-border bg-background text-muted-foreground hover:bg-muted'
                          }`}
                        >
                          {c}
                        </button>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={faceNation}
                        onChange={(e) => setFaceNation(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !topicLoading) handleTopicToPrompt() }}
                        disabled={topicLoading}
                        placeholder="vd: Việt Nam, Hàn Quốc, Nhật Bản, Thái Lan..."
                        className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                      />
                      <Button type="button" variant="outline" onClick={handleTopicToPrompt} disabled={topicLoading || !faceNation.trim()} className="gap-1.5">
                        {topicLoading ? <RefreshCw className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                        Tạo prompt
                      </Button>
                    </div>
                    <p className="text-[11px] text-muted-foreground">Nhập quốc gia muốn tạo nhân vật, AI sẽ viết prompt gương mặt theo quốc tịch đó vào ô bên dưới (anh có thể sửa lại). Cảnh cũng sẽ mang không khí của quốc gia này.</p>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium">{t('content.faceSwap.facePromptLabel')}</label>
                    <textarea
                      value={faceSwapFacePrompt}
                      onChange={(e) => { setFaceSwapFacePrompt(e.target.value); setFaceSwapError('') }}
                      rows={8}
                      placeholder={t('content.faceSwap.facePromptPlaceholder')}
                      className="resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  {faceSwapCharacterImage && (
                    <div className="flex flex-col gap-1.5">
                      <p className="text-sm font-medium">{t('content.faceSwap.characterPreview')}</p>
                      <img src={faceSwapCharacterImage} alt="character"
                        className="h-80 w-full rounded-lg border border-border bg-muted/30 object-contain" />
                      <div className="flex items-center gap-1.5">
                        <button type="button" onClick={() => downloadImageAsJpeg(faceSwapCharacterImage, 'nhan-vat.jpg')}
                          className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted">
                          <Download className="size-3.5" />
                          {t('content.faceSwap.download')}
                        </button>
                        <button type="button" onClick={() => setFilterTarget({ kind: 'character' })}
                          className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted">
                          <Palette className="size-3.5" />
                          Filter
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button onClick={handleGenerateCharacter} disabled={faceSwapLoading} className="gap-1.5">
                      {faceSwapLoading ? t('content.faceSwap.generating') : faceSwapCharacterImage ? t('content.faceSwap.regenerate') : t('content.faceSwap.genCharacter')}
                    </Button>
                    <Button type="button" variant="outline" disabled={faceSwapLoading} className="gap-1.5"
                      onClick={() => document.getElementById('face-swap-upload-character')?.click()}>
                      <Upload className="size-3.5" />
                      {t('content.faceSwap.uploadCharacter')}
                    </Button>
                    <input
                      id="face-swap-upload-character"
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      onChange={(e) => { handleUploadCharacter(e.target.files?.[0] ?? null); e.target.value = '' }}
                    />
                    {faceSwapCharacterImage && !faceSwapLoading && (
                      <Button variant="outline" onClick={goToScenesStep} className="gap-1.5">
                        {t('content.faceSwap.useCharacter')}
                      </Button>
                    )}
                  </div>
                </>
              )}

              {/* Step 2 — Scenes */}
              {faceSwapStep === 'scenes' && (
                <>
                  <div className="flex items-center gap-3">
                    {faceSwapCharacterImage && (
                      <img src={faceSwapCharacterImage} alt="character"
                        className="size-14 rounded-lg border border-border object-cover" />
                    )}
                    {isAppend ? (
                      <span className="text-xs text-muted-foreground">{t('content.faceSwap.addingToCharacter')}</span>
                    ) : (
                      <button type="button"
                        onClick={() => { setFaceSwapStep('character'); setFaceSwapError('') }}
                        className="text-xs text-muted-foreground underline hover:text-foreground">
                        {t('content.faceSwap.changeCharacter')}
                      </button>
                    )}
                  </div>

                  {/* Ngôn ngữ máy quay — áp cho dòng PRESET (chưa tự gõ tay) bên dưới. Để «Tự động» thì
                      giữ nguyên hành vi cũ (bốc ngẫu nhiên mỗi ảnh một góc). Dòng đã tự gõ tay thì bỏ
                      qua 3 ô này — coi như câu chữ người dùng gõ đã tự nói đủ góc/cỡ cảnh rồi, gửi
                      kèm thêm chỉ làm loãng prompt (xem ghi chú isPreset trong buildScenePrompt). */}
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium">Góc quay</label>
                    <div className="grid grid-cols-3 gap-2">
                      {([[SHOT_FIELD, camShot, setCamShot], [ANGLE_FIELD, camAngle, setCamAngle],
                         [HEAD_FIELD, camHead, setCamHead]] as const).map(([field, value, set]) => (
                        <label key={field.key} className="flex flex-col gap-1">
                          <span className="text-[11px] text-muted-foreground">{field.label}</span>
                          <select
                            value={value}
                            onChange={(e) => set(e.target.value)}
                            className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
                          >
                            <option value="">Tự động (ngẫu nhiên)</option>
                            {field.opts.map(([vi, en]) => (
                              <option key={en} value={en}>{vi}</option>
                            ))}
                          </select>
                        </label>
                      ))}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      Để «Tự động» thì mỗi ảnh một góc khác nhau (như hiện tại). Chọn cụ thể thì áp dụng cho các dòng
                      cảnh dựng sẵn (preset) — dòng anh đã tự gõ tay thì giữ nguyên theo đúng chữ anh viết, không đè
                      góc quay lên nữa.
                    </p>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium">{t('content.faceSwap.dailyPromptsLabel')}</label>
                    <div className="flex flex-wrap gap-1.5">
                      <span className="self-center text-[11px] text-muted-foreground">{t('content.faceSwap.scenePresetsLabel')}:</span>
                      {FACE_SWAP_SCENES.map((preset) => (
                        <button key={preset.key} type="button"
                          onClick={() => addPresetScene(preset.key)}
                          disabled={faceSwapDailyPrompts.length >= MAX_FACE_SWAP_DAILY_PROMPTS && faceSwapDailyPrompts.every((p) => p.trim())}
                          className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-40">
                          <Plus className="size-3" />
                          {t(`content.faceSwap.scenePreset_${preset.key}`)}
                        </button>
                      ))}
                    </div>
                    <div className="flex flex-col gap-2">
                      {faceSwapDailyPrompts.map((p, i) => {
                        const m = faceSwapSceneMeta[i]
                        const topicLabel = m?.topic ? t(`content.faceSwap.scenePreset_${m.topic}`) : t('content.faceSwap.customSceneLabel')
                        const isScenery = m?.kind === 'scenery'
                        const isRealRef = m?.kind === 'realref'
                        const isPerson = !isScenery && !isRealRef
                        const isCustom = !m?.topic
                        return (
                          <div key={i} className="flex flex-col gap-1">
                            {isCustom ? (
                              // Self-typed row: let the user pick Người (nhân vật trong cảnh),
                              // Cảnh (chỉ bối cảnh, không người), hoặc Ảnh thật (tải ảnh thật →
                              // giữ dáng/cảnh, đổi mặt + quần áo) before typing the prompt.
                              <div className="inline-flex w-fit items-center gap-0.5 rounded-full bg-muted/60 p-0.5 text-[11px] font-medium">
                                <span className="px-1.5 text-muted-foreground">{topicLabel}</span>
                                <button type="button" onClick={() => setDailyKind(i, 'person')}
                                  className={`rounded-full px-2 py-0.5 transition ${isPerson ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted'}`}>
                                  {t('content.faceSwap.sceneKindPerson')}
                                </button>
                                <button type="button" onClick={() => setDailyKind(i, 'scenery')}
                                  className={`rounded-full px-2 py-0.5 transition ${isScenery ? 'bg-amber-100 text-amber-700' : 'text-muted-foreground hover:bg-muted'}`}>
                                  {t('content.faceSwap.sceneKindScenery')}
                                </button>
                                <button type="button" onClick={() => setDailyKind(i, 'realref')}
                                  className={`rounded-full px-2 py-0.5 transition ${isRealRef ? 'bg-sky-100 text-sky-700' : 'text-muted-foreground hover:bg-muted'}`}>
                                  {t('content.faceSwap.sceneKindRealRef')}
                                </button>
                              </div>
                            ) : (
                              <span className={`inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                                isScenery ? 'bg-amber-100 text-amber-700' : 'bg-primary/10 text-primary'
                              }`}>
                                {topicLabel} · {isScenery ? t('content.faceSwap.sceneKindScenery') : t('content.faceSwap.sceneKindPerson')}
                              </span>
                            )}
                            {isRealRef && (
                              // Real reference photo: upload (or replace) the source photo whose
                              // pose/scene is preserved. Not saved anywhere — FE-only, PII-safe.
                              <div className="flex items-center gap-2">
                                {m?.refImage && (
                                  <img src={m.refImage} alt="ref"
                                    className="size-12 rounded-md border border-border object-cover" />
                                )}
                                <button type="button"
                                  onClick={() => document.getElementById(`face-swap-refimg-${i}`)?.click()}
                                  className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted">
                                  <Upload className="size-3.5" />
                                  {m?.refImage ? t('content.faceSwap.realRefReplace') : t('content.faceSwap.realRefUpload')}
                                </button>
                                <input id={`face-swap-refimg-${i}`} type="file"
                                  accept="image/png,image/jpeg,image/webp" className="hidden"
                                  onChange={(e) => { setRefImage(i, e.target.files?.[0] ?? null); e.target.value = '' }} />
                                <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                                  <input type="checkbox" checked={!!m?.keepOutfit}
                                    onChange={(e) => setKeepOutfit(i, e.target.checked)} />
                                  <span>Giữ nguyên trang phục của ảnh thật</span>
                                </label>
                              </div>
                            )}
                            <div className="flex items-start gap-2">
                              <textarea value={p} onChange={(e) => updateDailyPrompt(i, e.target.value)} rows={5}
                                placeholder={t(isRealRef ? 'content.faceSwap.dailyPromptPlaceholderRealRef' : isScenery ? 'content.faceSwap.dailyPromptPlaceholderScenery' : 'content.faceSwap.dailyPromptPlaceholder', { index: i + 1 })}
                                className="flex-1 resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
                              <div className="mt-0.5 flex flex-col gap-1.5">
                                <button type="button" onClick={() => regenerateScenePrompt(i)}
                                  disabled={!p.trim() || faceSwapPromptBusy !== null || pendingSeeds.includes(p) || (isCustom && (isScenery || isRealRef))}
                                  className="rounded-lg border border-border p-2 text-muted-foreground hover:bg-muted disabled:opacity-40"
                                  title={t('content.faceSwap.regenScenePrompt')}
                                  aria-label={t('content.faceSwap.regenScenePrompt')}>
                                  <RefreshCw className={`size-4 ${faceSwapPromptBusy === i || pendingSeeds.includes(p) ? 'animate-spin' : ''}`} />
                                </button>
                                <button type="button" onClick={() => removeDailyPrompt(i)}
                                  disabled={faceSwapDailyPrompts.length <= 1}
                                  className="rounded-lg border border-border p-2 text-muted-foreground hover:bg-muted disabled:opacity-40"
                                  aria-label={t('content.faceSwap.removeDailyPrompt')}>
                                  <Trash2 className="size-4" />
                                </button>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                    <button type="button" onClick={addDailyPrompt}
                      disabled={faceSwapDailyPrompts.length >= MAX_FACE_SWAP_DAILY_PROMPTS}
                      className="mt-1 inline-flex w-fit items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-40">
                      <Plus className="size-3.5" />
                      {t('content.faceSwap.addDailyPrompt')}
                    </button>
                    <p className="text-[11px] text-muted-foreground">{t('content.faceSwap.promptHint')}</p>
                  </div>

                  {faceSwapSceneImages.some((img) => img) && (
                    <div className="flex flex-col gap-2">
                      <p className="text-sm font-medium">{t('content.faceSwap.scenesPreview')}</p>
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                        {faceSwapSceneImages.map((img, i) =>
                          img ? (
                            <div key={i} className="flex flex-col gap-1.5 rounded-lg border border-border p-2">
                              <img src={img} alt={`scene-${i + 1}`}
                                className="aspect-square w-full rounded-md bg-muted/30 object-contain" />
                              <div className="flex gap-1.5">
                                <button type="button" onClick={() => handleRegenerateScene(i)}
                                  disabled={faceSwapSceneBusy !== null}
                                  className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-40">
                                  <RefreshCw className={`size-3.5 ${faceSwapSceneBusy === i ? 'animate-spin' : ''}`} />
                                  {t('content.faceSwap.regenerate')}
                                </button>
                                <button type="button" onClick={() => setFilterTarget({ kind: 'scene', index: i })}
                                  title="Chọn filter màu"
                                  className="inline-flex items-center justify-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted">
                                  <Palette className="size-3.5" />
                                </button>
                                <button type="button" onClick={() => downloadImageAsJpeg(img, `canh-${i + 1}.jpg`)}
                                  className="inline-flex items-center justify-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted">
                                  <Download className="size-3.5" />
                                </button>
                                <button type="button" onClick={() => handleSaveScene(img)}
                                  disabled={savedSceneUrls.has(img) || savingScene !== null}
                                  title="Lưu vào nhân vật"
                                  className="inline-flex items-center justify-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-40">
                                  {savingScene === img
                                    ? <RefreshCw className="size-3.5 animate-spin" />
                                    : savedSceneUrls.has(img)
                                      ? <Check className="size-3.5 text-green-600" />
                                      : <Bookmark className="size-3.5" />}
                                </button>
                              </div>
                            </div>
                          ) : null,
                        )}
                      </div>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    {/* Block generation while AI is still writing scene rows —
                        otherwise the images would use the placeholder seeds. */}
                    <Button onClick={handleGenerateScenes} disabled={faceSwapLoading || pendingSeeds.length > 0} variant="outline" className="gap-1.5">
                      {faceSwapLoading
                        ? t('content.faceSwap.generating')
                        : pendingSeeds.length > 0
                          ? 'AI đang viết cảnh…'
                          : t('content.faceSwap.genScenes')}
                    </Button>
                    {faceSwapSceneImages.some((img) => img) && !faceSwapLoading && (
                      <Button
                        onClick={() => { if (isAppend) handleSaveCharacter(); else setSaveCharOpen((v) => !v) }}
                        disabled={saveCharLoading} className="gap-1.5">
                        {isAppend && saveCharLoading
                          ? <Loader2 className="size-3.5 animate-spin" />
                          : <Bookmark className="size-3.5" />}
                        {isAppend && saveCharLoading && saveProgress
                          ? t('content.faceSwap.savingProgress', saveProgress)
                          : isAppend ? t('content.faceSwap.addImagesSave') : t('content.faceSwap.saveCharacter')}
                      </Button>
                    )}
                  </div>

                  {!isAppend && saveCharOpen && (
                    <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
                      <input type="text" value={saveCharName}
                        onChange={(e) => setSaveCharName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleSaveCharacter() }}
                        placeholder={t('content.faceSwap.characterNamePlaceholder')}
                        className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-ring"
                        autoFocus />
                      <Button size="sm" onClick={handleSaveCharacter}
                        disabled={saveCharLoading || !saveCharName.trim()} className="gap-1.5">
                        {saveCharLoading
                          ? <RefreshCw className="size-3.5 animate-spin" />
                          : <Bookmark className="size-3.5" />}
                        {saveCharLoading && saveProgress
                          ? t('content.faceSwap.savingProgress', saveProgress)
                          : t('content.faceSwap.save')}
                      </Button>
                      <button type="button"
                        onClick={() => { setSaveCharOpen(false); setSaveCharName('') }}
                        className="rounded p-1 hover:bg-muted">
                        <X className="size-3.5" />
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          ) : faceSwapMode === 'media' ? (
            <>
              {/* Tạo Media — generate non-person images with GPT */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">Mô tả ảnh muốn tạo</label>
                <textarea
                  value={mediaPrompt}
                  onChange={(e) => setMediaPrompt(e.target.value)}
                  rows={2}
                  placeholder="Chọn chủ đề bên dưới để điền prompt chi tiết, hoặc tự mô tả… VD: Endless green meadow under blue sky, scattered wildflowers, realistic landscape photography"
                  className="resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={handleRandomMedia}
                    className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary hover:bg-primary/20"
                  >
                    <Shuffle className="size-3" />
                    Ngẫu nhiên
                  </button>
                  {MEDIA_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => setMediaPrompt(p.prompt)}
                      title={p.prompt}
                      className="rounded-full border border-border px-2.5 py-1 text-[11px] hover:bg-muted"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={handleGenerateMedia} disabled={mediaGenerating || !mediaPrompt.trim()} size="sm" className="gap-1.5">
                    {mediaGenerating ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                    Tạo {mediaCount} ảnh
                  </Button>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] text-muted-foreground">Số lượng</span>
                    {[1, 2, 4].map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setMediaCount(n)}
                        className={`size-7 rounded-md border text-xs transition ${
                          mediaCount === n ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-muted'
                        }`}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {mediaImages.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium">Ảnh đã tạo ({mediaImages.length})</label>
                    <button
                      type="button"
                      onClick={handleSaveAllMedia}
                      className="text-xs font-medium text-primary hover:underline"
                    >
                      Lưu tất cả vào nhân vật
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {mediaImages.map((img, i) => {
                      const saved = savedMediaUrls.has(img)
                      return (
                        <div key={i} className="relative aspect-square overflow-hidden rounded-lg border border-border">
                          <img src={img} alt="" className="h-full w-full object-cover" />
                          <button
                            type="button"
                            onClick={() => handleSaveMedia(img)}
                            disabled={saved || savingMedia === img}
                            title="Lưu vào nhân vật"
                            className={`absolute inset-x-1 bottom-1 flex items-center justify-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-semibold transition ${
                              saved ? 'bg-emerald-600 text-white' : 'bg-foreground/80 text-background hover:bg-foreground'
                            }`}
                          >
                            {savingMedia === img ? <Loader2 className="size-3 animate-spin" /> : saved ? 'Đã lưu' : 'Lưu'}
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </>
          ) : faceSwapMode === 'pinterest' ? (
            <>
              {/* Kho ảnh Pinterest (Pexels API) */}
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <input
                      type="text"
                      value={pinterestQuery}
                      onChange={(e) => setPinterestQuery(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && fetchPinterestPhotos(pinterestQuery, 1)}
                      placeholder="Tìm kiếm ảnh đẹp..."
                      className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <Button
                    onClick={() => fetchPinterestPhotos(pinterestQuery, 1)}
                    disabled={pinterestLoading}
                    size="sm"
                    className="gap-1.5"
                  >
                    {pinterestLoading && pinterestPhotos.length === 0 ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
                    Tìm kiếm
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={uploadingLocalMedia}
                    className="gap-1.5"
                    onClick={() => document.getElementById('face-swap-upload-local-media')?.click()}
                  >
                    {uploadingLocalMedia ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
                    Tải ảnh từ máy
                  </Button>
                  <input
                    id="face-swap-upload-local-media"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={(e) => { handleUploadLocalMedia(e.target.files?.[0] ?? null); e.target.value = '' }}
                  />
                </div>

                {!PEXELS_KEY ? (
                  <p className="rounded-md border border-amber-400/30 bg-amber-400/10 p-3 text-xs text-amber-200">
                    Kho ảnh chưa được kích hoạt. Vui lòng thêm <code className="rounded bg-black/30 px-1">VITE_PEXELS_API_KEY</code> vào file <code className="rounded bg-black/30 px-1">.env</code> rồi khởi động lại hệ thống.
                  </p>
                ) : (
                  <>
                    {pinterestPhotos.length > 0 ? (
                      <div className="flex flex-col gap-3">
                        <label className="text-sm font-medium">Ảnh gợi ý / Kết quả tìm kiếm ({pinterestPhotos.length})</label>
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                          {pinterestPhotos.map((p) => (
                            <div key={p.id} className="group relative aspect-[3/4] overflow-hidden rounded-lg border border-border bg-muted/20">
                              <img
                                src={p.src.medium}
                                alt={p.alt || 'Pinterest Photo'}
                                className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                                loading="lazy"
                              />
                              <div className="absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-black/80 via-black/20 to-transparent p-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                                <p className="mb-1.5 truncate text-[10px] text-white/90 font-medium">
                                  {p.photographer || 'Pinterest'}
                                </p>
                                <div className="flex flex-col gap-1">
                                  <button
                                    type="button"
                                    onClick={() => handleSaveMedia(p.src.original)}
                                    disabled={savedMediaUrls.has(p.src.original) || savingMedia === p.src.original}
                                    title="Dùng ảnh này làm media của nhân vật"
                                    className={`flex w-full items-center justify-center gap-1 rounded py-1 text-[10px] font-semibold transition ${
                                      savedMediaUrls.has(p.src.original)
                                        ? 'bg-emerald-600 text-white'
                                        : 'bg-primary text-primary-foreground hover:bg-primary/95'
                                    }`}
                                  >
                                    {savingMedia === p.src.original ? (
                                      <Loader2 className="size-3 animate-spin" />
                                    ) : savedMediaUrls.has(p.src.original) ? (
                                      <Check className="size-3" />
                                    ) : (
                                      <Plus className="size-3" />
                                    )}
                                    {savedMediaUrls.has(p.src.original) ? 'Đã lưu' : 'Dùng làm ảnh media'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => downloadImageAsJpeg(p.src.original, `pinterest-${p.id}.jpg`)}
                                    title="Tải ảnh về máy"
                                    className="flex w-full items-center justify-center gap-1 rounded bg-white/20 py-1 text-[10px] font-semibold text-white transition hover:bg-white/30"
                                  >
                                    <Download className="size-3" />
                                    Tải về máy
                                  </button>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>

                        {hasMorePinterest && (
                          <div ref={pinterestSentinelRef} className="mt-2 flex justify-center py-2">
                            {pinterestLoading && (
                              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <Loader2 className="size-3.5 animate-spin" />
                                Đang tải thêm...
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ) : pinterestLoading ? (
                      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                        <Loader2 className="size-8 animate-spin mb-2" />
                        <p className="text-xs">Đang tải hình ảnh...</p>
                      </div>
                    ) : (
                      <div className="py-12 text-center text-xs text-muted-foreground">
                        Không tìm thấy hình ảnh nào. Hãy thử nhập từ khóa khác.
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          ) : faceSwapMode === 'faceswap' ? (
            <FaceSwapPanel
              availableMedia={availableMedia}
              onSaveMedia={handleSaveMedia}
              savedMediaUrls={savedMediaUrls}
              savingMedia={savingMedia}
              download={downloadImageAsJpeg}
            />
          ) : (
            <>
              {/* Upload mode */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('content.faceSwap.editSourceLabel')}</label>
                <input type="file" accept="image/png,image/jpeg,image/webp"
                  onChange={(e) => handleFaceSwapSourceChange(e.target.files?.[0] ?? null)}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs file:font-medium hover:file:bg-muted/80" />
                {faceSwapSourcePreview && !faceSwapSourceData && (
                  <img src={faceSwapSourcePreview} alt="source"
                    className="mt-1 h-56 w-full rounded-lg border border-border bg-muted/30 object-contain" />
                )}
              </div>

              {faceSwapSourceData && (
                <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/20 p-3">
                  <label className="text-sm font-medium">Xóa chữ / vật (inpaint — dùng được cả ảnh OpenAI từ chối)</label>
                  <InpaintCanvas image={faceSwapSourceData} onResult={(img) => setFaceSwapResults((prev) => [img, ...prev])} />
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('content.faceSwap.editPromptLabel')} (AI sinh lại theo mô tả)</label>
                <textarea value={faceSwapTargetPrompt}
                  onChange={(e) => { setFaceSwapTargetPrompt(e.target.value); setFaceSwapError('') }}
                  rows={5} placeholder={t('content.faceSwap.editPromptPlaceholder')}
                  className="resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
              </div>

              <Button onClick={handleEditImage} disabled={faceSwapLoading} className="w-fit gap-1.5">
                <Sparkles className="size-3.5" />
                {faceSwapLoading ? t('content.faceSwap.generating') : faceSwapResults.length > 0 ? t('content.faceSwap.regenerate') : t('content.faceSwap.editSubmit')}
              </Button>

              {faceSwapResults.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">{t('content.faceSwap.resultTitle', { count: faceSwapResults.length })}</p>
                    <button type="button" onClick={handleSaveAllEdited}
                      className="text-xs font-medium text-primary hover:underline">
                      Lưu tất cả vào nhân vật
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {faceSwapResults.map((img, i) => {
                      const saved = savedMediaUrls.has(img)
                      return (
                        <div key={i} className="flex flex-col gap-1.5 rounded-lg border border-border p-2">
                          <img src={img} alt={`edit-${i + 1}`}
                            className="aspect-square w-full rounded-md bg-muted/30 object-contain" />
                          <div className="flex gap-1.5">
                            <button type="button" onClick={() => handleSaveMedia(img)}
                              disabled={saved || savingMedia === img}
                              title="Lưu vào nhân vật"
                              className="flex-1 inline-flex items-center justify-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-40">
                              {savingMedia === img
                                ? <RefreshCw className="size-3.5 animate-spin" />
                                : saved
                                  ? <Check className="size-3.5 text-green-600" />
                                  : <Bookmark className="size-3.5" />}
                              {saved ? 'Đã lưu' : 'Lưu vào nhân vật'}
                            </button>
                            <button type="button" onClick={() => downloadImageAsJpeg(img, `anh-${i + 1}.jpg`)}
                              className="inline-flex items-center justify-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted">
                              <Download className="size-3.5" />
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </>
          )}

          {faceSwapError && <p className="text-xs text-destructive">{faceSwapError}</p>}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="outline" onClick={handleClose} className="gap-1.5">
            {saveCharLoading && <Loader2 className="size-3.5 animate-spin" />}
            {saveCharLoading && saveProgress
              ? t('content.faceSwap.savingProgress', saveProgress)
              : t('common.close')}
          </Button>
        </div>
      </div>

      {/* Colour-filter picker — overlays the wizard for the character ref or a scene. */}
      {filterTarget && (
        <FilterPicker
          image={filterTarget.kind === 'character'
            ? (faceSwapCharacterImage || '')
            : (faceSwapSceneImages[filterTarget.index] || '')}
          onClose={() => setFilterTarget(null)}
          onApply={(out) => {
            if (filterTarget.kind === 'character') {
              setFaceSwapCharacterImage(out)
            } else {
              const idx = filterTarget.index
              setFaceSwapSceneImages((prev) => prev.map((img, i) => (i === idx ? out : img)))
            }
            setFilterTarget(null)
          }}
        />
      )}
    </div>
  )
}
