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
 */
export const stripEmptyOptionalFields = <T extends Record<string, any>>(
  doc: T,
  requiredFields: ReadonlySet<string>,
): Record<string, any> => {
  const result = { ...doc };
  delete (result as any).__v;
  for (const key of Object.keys(result)) {
    if (requiredFields.has(key)) continue;
    if (isEmptyValue(result[key])) delete result[key];
  }
  return result;
};
