import HTTPStatus from "../../utils/httpStatus.js";
import logger from "../../core/logger.js";
import { ObjectId } from "../../utils/index.js";
import Conversation from "../models/conversation.model.js";

/**
 * Bước 9 (epic access-control-hardening) — biên truy cập cho MỌI endpoint REST đọc dữ liệu của một
 * hội thoại.
 *
 * Vấn đề gốc: 5 route dưới `/messages` nhận `conversationId` rồi query thẳng `Message`/`Conversation`
 * mà KHÔNG hề kiểm người gọi có nằm trong hội thoại đó không. `protectRoute` có mặt ở cả 5, nên
 * chúng "trông như" đã được bảo vệ — nhưng nó chỉ trả lời "có phải người dùng hợp lệ không", không
 * trả lời "có phải hội thoại CỦA ANH TA không". Bất kỳ tài khoản nào cũng đọc được tin nhắn, ảnh,
 * file, link và tìm kiếm nội dung trong hội thoại riêng tư của người khác nếu biết `conversationId`.
 *
 * Đáng chú ý: đường SOCKET của cùng module message vốn đã lấy danh tính từ JWT rất chuẩn
 * (`socket/controllers/message.controller.ts` — mọi handler đều dùng `socket.user.userId`). Chỉ
 * đường REST song song là bị bỏ quên. Đây là lý do quét ngang toàn bộ bề mặt có giá trị hơn review
 * từng module.
 *
 * @param source nơi chứa `conversationId` — `params` cho route `/conversations/:conversationId/*`,
 *               `body` cho `POST /messages/search`.
 */
export const requireConversationMember = (
  source: "params" | "body" = "params",
  key = "conversationId"
) => {
  return async (req, res, next) => {
    const conversationId = req[source]?.[key];
    const userId = req.user?._id;
    if (!conversationId || !userId) {
      return res.status(HTTPStatus.FORBIDDEN).json({ message: "Forbidden" });
    }

    try {
      // MỘT query, dùng `exists` (chỉ trả `_id`, không kéo cả document) và lọc `participants` NGAY
      // TRONG query thay vì fetch rồi so ở Node — index `{participants: 1}` (conversation.model.ts)
      // phục vụ đúng shape này.
      //
      // Không tồn tại và không-phải-thành-viên cho ra CÙNG kết quả `null`, nên phản hồi giống hệt
      // nhau (403). Đây là lựa chọn có chủ đích: phân biệt 404/403 sẽ biến endpoint thành công cụ
      // dò "conversationId nào có thật".
      const member = await Conversation.exists({
        _id: ObjectId(String(conversationId)),
        participants: ObjectId(String(userId)),
      });
      if (!member) {
        logger.warn(
          { userId: String(userId), conversationId: String(conversationId) },
          "[conversation] truy cập bị từ chối — không phải thành viên"
        );
        return res.status(HTTPStatus.FORBIDDEN).json({ message: "Forbidden" });
      }
      next();
    } catch (err) {
      // Default-deny: lỗi tra cứu KHÔNG được biến thành "cho qua".
      logger.error({ err }, "[conversation] membership check failed");
      return res.status(HTTPStatus.FORBIDDEN).json({ message: "Forbidden" });
    }
  };
};

export default requireConversationMember;
