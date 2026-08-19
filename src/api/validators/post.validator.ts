// Schema cho `post.route.ts` (Task 012 — FR-5/FR-9).
//
// Mỗi const dưới đây là 1 "schema-bag" `{ body?, query?, params? }` — đúng shape `validate()` nhận.
//
// LƯU Ý XUYÊN SUỐT FILE: `z.object()` mặc định LOẠI BỎ key không khai báo, và `validate()` gán lại
// `req.query`/`req.body`/`req.params` bằng kết quả parse. Field nào tầng service dùng mà schema
// quên khai báo sẽ biến mất ÂM THẦM (không phải 400) -> feed trả sai dữ liệu. Vì vậy field list
// bên dưới được trace từ CẢ controller LẪN service, không chỉ controller.
import { z } from "zod";
import { Constants } from "../../Breads-Shared/Constants/index.js";
import { sanitizeText } from "../middlewares/sanitize.js";
import { objectIdSchema, paginationQuerySchema } from "./common.js";

const VISIBILITY_VALUES: number[] = Object.values(Constants.POST_VISIBILITY);

const visibilitySchema = z
  .number()
  .refine((v) => VISIBILITY_VALUES.includes(v), "invalid visibility");

/** ObjectId hợp lệ HOẶC chuỗi rỗng. Frontend gửi `filter[user]=` (rỗng) để nghĩa là "không lọc
 * theo user" — cùng idiom với `filter[value]=`. `getQueryPostValidation` đã xử lý falsy bằng
 * `if (!user)`, nên chuỗi rỗng phải đi lọt chứ không được 400. */
const optionalObjectIdOrEmpty = z.union([objectIdSchema, z.literal("")]);

/* ------------------------------------------------------------------ GET /all */

// Nhánh rủi ro nhất của epic. Field list trace được (đọc trực tiếp source, không chỉ bảng tóm tắt
// trong task):
//
//   `post.controller.ts:440 getPosts`      -> `filter.page` (check `.includes("admin")`); tự set
//                                             `payload.isAdminPage` và `payload.viewerId` SAU
//                                             validate.
//   `services/post.ts:487 getPostsIdByFilter` -> destructure top-level `{filter, userId, page,
//                                             limit, isAdminPage}`, đọc thêm `payload.viewerId`,
//                                             GHI `payload.followeeIds`.
//   `services/post.ts:576` nhánh ADMIN.POSTS_VALIDATION -> truyền NGUYÊN object `filter` vào
//                                             `getQueryPostValidation`, hàm này đọc thêm
//                                             `filter.user`, `filter.postContent`,
//                                             `filter.postType` — 3 field KHÔNG có trong bảng
//                                             tóm tắt của task, tìm ra khi đọc lại source.
//   nhánh default -> `getForYouFeed({userId, viewerId, skip, limit, followeeIds})`: tham số dựng
//                    tại chỗ trong `post.ts`, KHÔNG nhận thêm field nào từ `req.query`. Nên tầng
//                    feed không mở rộng field list.
//
// Hai quyết định có chủ đích:
//
// 1) TOP-LEVEL đóng (strip như mặc định). Bề mặt này nhỏ và đã trace cạn: chỉ `filter`, `userId`,
//    `page`, `limit`. Đóng ở đây là CÓ LỢI về bảo mật: `viewerId` và `isAdminPage` do client gửi
//    lên sẽ bị loại bỏ trước khi tới controller (controller vốn tự ghi đè `viewerId`, còn
//    `isAdminPage` phải suy ra từ `filter.page`, client không được tự khai). `test/posts-all-
//    stress.js` có gửi kèm `isNewPage=true` — đã kiểm tra: không nơi nào trong repo đọc field
//    này, strip đi vô hại.
//
// 2) `filter` MỞ (`.passthrough()`). Ngược lại với top-level, đây là object lồng do UI admin dựng,
//    và bảng tóm tắt của task đã thiếu mất 3 field (`user`/`postContent`/`postType`) — bằng chứng
//    trực tiếp rằng bề mặt này còn tiến hoá. Passthrough giữ nguyên mọi field chưa khai báo thay vì
//    nuốt mất, đúng fallback AD-6, mà vẫn giữ được ràng buộc FR-9 trên field CÓ khai báo
//    (`filter.user`). `postContent`/`postType` CỐ Ý không khai báo: qs trả string khi client gửi 1
//    giá trị và array khi gửi nhiều, ép `z.array()` sẽ biến request 1-giá-trị đang chạy được thành
//    400 — passthrough giữ đúng hành vi hiện tại.
//
// `filter.page`: để `z.string()` permissive, KHÔNG enum-restrict theo `PageConstant`. Lý do: nhánh
// `default` của `switch` là catch-all hợp lệ (for_you), nên page string lạ hiện đang chạy được;
// siết enum sẽ biến request đang 200 thành 400 mỗi lần frontend thêm page mới — đổi hành vi ngoài
// phạm vi FR-9 (vốn chỉ nói về ObjectId).
export const getPostsQuerySchema = {
  query: paginationQuerySchema.extend({
    filter: z
      .object({
        page: z.string(),
        // KHÔNG `.min(1)`: `filter[value]=` (rỗng) là case mặc định "xem mọi loại bài" của trang
        // cá nhân — chính request đã verify ở phiên fix N+1.
        value: z.string().optional(),
        user: optionalObjectIdOrEmpty.optional(),
      })
      .passthrough(),
    userId: optionalObjectIdOrEmpty.optional(),
  }),
};

/* ------------------------------------------------------------ các route còn lại */

export const getPostSchema = {
  params: z.object({ id: objectIdSchema }),
};

// Route DUY NHẤT không bọc `asyncHandler` -> `validate()` bắt buộc phải đồng bộ (AD-4), nếu không
// payload sai sẽ TREO request thay vì trả 400.
export const createPostSchema = {
  body: z.object({
    _id: objectIdSchema,
    authorId: objectIdSchema,
    // FR-3: required, luôn là string -> `.transform()` trực tiếp, không cần guard undefined.
    content: z.string().max(500).transform((val) => sanitizeText(val)),
    media: z.array(z.any()).optional(),
    parentPost: objectIdSchema.optional(),
    survey: z.array(z.any()).optional(),
    quote: z.any().optional(),
    type: z.string(),
    usersTag: z.array(objectIdSchema).optional(),
    links: z.array(z.any()).optional(),
    files: z.array(z.any()).optional(),
    visibility: visibilitySchema.optional(),
  }),
  query: z.object({ action: z.string().optional() }),
};

export const deletePostSchema = {
  params: z.object({ id: objectIdSchema }),
  query: z.object({ userId: objectIdSchema }),
};

// FAIL-1 (epic `unified-payload-sanitize`, task 010): `content` LÀ optional, và
// `post.controller.ts:392` làm `post.content = content;` VÔ ĐIỀU KIỆN. `sanitizeText()` trả `""`
// cho input `undefined` — nếu `.transform(sanitizeText)` áp thẳng lên field optional này, request
// update KHÔNG kèm `content` (vd. chỉ update `survey`) sẽ khiến `content` sau validate thành `""`
// thay vì `undefined`, ghi đè xóa sạch nội dung cũ một cách im lặng. Guard dưới đây bắt buộc: chỉ
// gọi `sanitizeText` khi có giá trị, giữ nguyên `undefined` khi field vắng mặt.
export const updatePostSchema = {
  body: z.object({
    _id: objectIdSchema,
    userId: objectIdSchema,
    content: z
      .string()
      .max(500)
      .optional()
      .transform((val) => (val === undefined ? val : sanitizeText(val))),
    media: z.array(z.any()).optional(),
    survey: z.array(z.any()).optional(),
    visibility: z.number().optional(),
    files: z.array(z.any()).optional(),
  }),
};

// Không có body: `userId` lấy từ `req.user._id` do `protectRoute` gắn.
export const likeUnlikePostSchema = {
  params: z.object({ id: objectIdSchema }),
};

// AD-5: body KHÔNG coerce — `express.json()` đã cho đúng kiểu JS, nên `isAdd: "true"` (string)
// phải fail chứ không được ép thành boolean.
export const tickPostSurveySchema = {
  body: z.object({
    optionId: objectIdSchema,
    userId: objectIdSchema,
    isAdd: z.boolean(),
  }),
};

// Task 011 correction: postId chuyển từ body vào params.id (route PATCH /:id/status).
export const updatePostStatusSchema = {
  params: z.object({
    id: objectIdSchema,
  }),
  body: z.object({
    userId: objectIdSchema,
    status: z.number(),
  }),
};

// Task 011 correction: postId chuyển từ body vào params.id (route PATCH /:id/visibility).
export const updatePostVisibilitySchema = {
  params: z.object({
    id: objectIdSchema,
  }),
  body: z.object({
    userId: objectIdSchema,
    visibility: visibilitySchema,
  }),
};

export const getPostActivitiesSchema = {
  params: z.object({ id: objectIdSchema }),
  query: z.object({
    type: z.enum(["likes", "comments", "reposts"]).optional(),
    page: z.coerce.number().optional(),
    limit: z.coerce.number().optional(),
  }),
};

export const getPostRepliesSchema = {
  params: z.object({ id: objectIdSchema }),
  query: z.object({
    page: z.coerce.number().optional(),
    limit: z.coerce.number().optional(),
  }),
};

