/**
 * Lọc field rỗng/mặc định khỏi 1 document đã serialize xong, dùng chung cho mọi collection tham
 * gia pattern "lean-api-response" (bắt đầu từ Post — `.ccpm/prds/lean-api-response.md` — mở rộng
 * sang User và các collection khác). Tách generic khỏi `post.ts` để không lặp lại logic mỗi khi
 * thêm 1 collection mới; `post.ts`/`user.ts` chỉ khai `REQUIRED_*_FIELDS` riêng rồi gọi hàm này.
 */

export const isEmptyValue = (value: any): boolean =>
  (Array.isArray(value) && value.length === 0) ||
  value === "" ||
  (!!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0);

/**
 * - `__v` luôn bị xoá (field nội bộ Mongoose, không consumer nào dùng).
 * - Field trong `requiredFields` giữ nguyên vô điều kiện, kể cả giá trị rỗng-hợp-lệ.
 * - Field khác có giá trị rỗng (`[]`, `""`, `{}`) bị xoá.
 * - Chỉ lọc TẦNG TRÊN CÙNG (không đệ quy vào object lồng) — giữ đúng phạm vi đã audit,
 *   tránh đổi shape object lồng mà consumer chưa được rà (bài học FAIL-1/plan-review, epic Post).
 *
 * Trả về `T` (không phải `Record<string, any>`): field bị xoá luôn là field OPTIONAL trong `T`
 * (giá trị `undefined` vẫn hợp lệ với chính type đó), nên ép kiểu về `T` là đúng và giữ được
 * type-check ở call site (vd. `const post: IPost | null = await getPostDetail(...)`) — trả
 * `Record<string, any>` như bản gốc làm TS coi mọi field required cũng "có thể thiếu", xoá mất
 * type-safety ở nơi gọi (phát hiện khi mở rộng sang User: `user.controller.ts` có annotation
 * `IUser | null` bị lỗi type — hoá ra lỗi này ĐÃ CÓ SẴN từ `post.controller.ts:332` với `IPost`,
 * chỉ là chưa ai để ý vì chưa có annotation tường minh nào khác dùng `getPostDetail` bị soi).
 */
export const stripEmptyOptionalFields = <T extends Record<string, any>>(
  doc: T,
  requiredFields: ReadonlySet<string>,
): T => {
  const result: Record<string, any> = { ...doc };
  delete result.__v;
  for (const key of Object.keys(result)) {
    if (requiredFields.has(key)) continue;
    if (isEmptyValue(result[key])) delete result[key];
  }
  return result as T;
};
