// Controller cấp chữ ký upload (epic presigned-media-upload, task 002 — FR-1/FR-2/NFR-4).
import { AuthFailureError } from "../../core/error.response.ts";
import { OK } from "../../core/success.response.ts";
import { signBatch } from "../services/cloudinarySign.ts";

export const signUpload = async (req, res) => {
  // `protectRoute` gắn `req.user` (document User đã bỏ password). Nó vẫn gọi `next()` khi
  // `User.findById` trả null (`protectRoute.ts:44-45`) -> phải tự chặn ở đây, không giả định
  // `req.user` luôn tồn tại.
  const authUserId = req.user?._id?.toString();
  if (!authUserId) {
    throw new AuthFailureError("Unauthorized");
  }

  const { entityType, count, recipientId, items } = req.body;

  // Danh tính đi vào `public_id` LUÔN là `authUserId` từ token, KHÔNG BAO GIỜ là field client tự
  // khai. `mediaSignSchema` đã strip `authorId`/`senderId` khỏi body, nên kể cả client cố gửi
  // cũng không có gì để đọc nhầm — 2 lớp phòng thủ độc lập, cố ý.
  const context =
    entityType === "message"
      ? { senderId: authUserId, recipientId }
      : { authorId: authUserId };

  const signatures = signBatch({ entityType, count, context, items });

  new OK({
    message: "Signed upload params created",
    metadata: { signatures },
  }).send(res);
};
