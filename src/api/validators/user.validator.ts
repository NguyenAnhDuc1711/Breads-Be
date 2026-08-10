// Schema cho router `user` — nhóm auth/profile (Task 010, 9/18 route).
//
// LƯU Ý: file này còn được Task 011 ghi thêm export cho 9 route còn lại (listing/admin) — xem
// Interface Contract trong `010.md`. Không xoá/định dạng lại export có sẵn khi merge.
//
// Field lấy trực tiếp từ `user.controller.ts` (không đoán/"dọn" tên field) — xem bảng trong
// `010.md` §Description.
import { z } from "zod";
import { objectIdSchema } from "./common.ts";

export const getUserProfileSchema = {
  params: z.object({ userId: objectIdSchema }),
};

export const signupUserSchema = {
  body: z.object({
    name: z.string().min(1),
    email: z.string().email(),
    username: z.string().min(1),
    password: z.string().min(1),
  }),
};

export const loginUserSchema = {
  body: z.object({
    email: z.string().email(),
    password: z.string().min(1),
  }),
};

// Field thật là `userFlId` + `userId` (user.controller.ts:189) — KHÔNG đổi tên.
export const followUserSchema = {
  body: z.object({
    userFlId: objectIdSchema,
    userId: objectIdSchema,
  }),
};

// `updateUser` (user.controller.ts:205-255) đọc `payload = req.body` nguyên khối rồi gán từng
// key lên user doc (switch case đặc biệt cho `avatar`/`links`, `default` cho phép field bất kỳ
// đi qua) — đây là hành vi mass-assignment có sẵn, KHÔNG thuộc scope epic này để sửa. Khai báo
// rõ field thuộc `user.model.ts` hay dùng để update self-profile (đều optional — partial
// update), và dùng `.passthrough()` để không âm thầm strip field khác mà controller vẫn đang
// chấp nhận (rủi ro nêu ở AD-6).
export const updateUserSchema = {
  params: z.object({ id: objectIdSchema }),
  body: z
    .object({
      name: z.string().optional(),
      username: z.string().optional(),
      avatar: z.string().optional(),
      bio: z.string().optional(),
      links: z.array(z.string()).optional(),
    })
    .passthrough(),
};

// `changePassword` (user.controller.ts:257-260): mọi field optional ở tầng schema — logic điều
// kiện thật (forgotPW bypass currentPW, v.v.) vẫn ở controller, validate() chỉ đảm bảo TYPE.
export const changePasswordSchema = {
  params: z.object({ id: objectIdSchema }),
  body: z.object({
    currentPW: z.string().optional(),
    newPW: z.string().optional(),
    forgotPW: z.boolean().optional(),
  }),
};

export const validateEmailByCodeSchema = {
  body: z.object({
    email: z.string().email(),
    code: z.string().min(1),
  }),
};
